"""이미지 서브 라벨 (/label 의 '이미지'): AI-Hub 서브 묶음(같은 서브의 3~4장)에서 서버 선수 고르기.

데이터는 tools/aihub_convert.py 가 만든 data/images/converted/ 를 읽는다.
  GET  /label                       라벨 페이지 ([비디오] = 실험 페이지 정답 입력, [이미지] = 이 화면)
  GET  /api/img/clips?kind=        묶음 목록. serve = AI-Hub 서브(SRV)만 · all = 전체 · server = 지금 서브인 것(서버 지정용)
  GET  /api/img/clip/{clip}         묶음 상세: 장마다 선수 박스·관절·코트 위치, 장 사이 같은 선수 잇기(track), 추천 서버
  GET  /api/img/thumb/{id}          격자용 작은 이미지 · /api/img/file/{경로}?w= 원본(줄이기)
  POST /api/img/label(s)            라벨 저장 (labels = 여러 묶음 한꺼번에) (serve.jsonl 에 덧붙임, 같은 묶음은 마지막 줄이 정답, 이전 값 이어받음)

라벨 화면 3단계 (모두 묶음 하나를 크게 한 장씩, 3~4장은 자동으로 넘겨 봄)
  1 서브 확인: AI-Hub 가 서브라고 한 묶음 → S 서브 / N 서브 아님 (저장하고 다음)
  2 전체 확인: 모든 묶음 → 서브가 아니라고 돼 있지만 실제 서브인 것을 S 로 바꿈
  3 서버 지정: 지금 서브인 묶음에서 서버 선수를 누름 (추천 서버 표시)

추천 서버 = 영상 서브 판정(find_serves)과 같은 자리 단서·가중치를 사진 1장에 적용:
  앞사람(양쪽에서 네트에 가장 가까운 사람, 애매하면 반대쪽 앞사람과 대각선) → 서브 팀 확률 p_near
  = sigmoid(w_form·대형 차 + w_xc·센터라인 거리 차 + w_pdx·팀원 좌우 거리 차 + w_dnet·네트 거리 차) → 그 팀 앞사람.
"""
from __future__ import annotations

import itertools
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import analysis as A
from . import court as C
from .main import DATA, STATIC

router = APIRouter()
IMG = DATA.parent / "images"
CONV = IMG / "converted"
LOG = CONV / "serve.jsonl"
PSEUDO = CONV / "serve_pseudo.jsonl"   # tools/pseudo_server.py 가 만든 서버 가짜 라벨 (사람 라벨로 학습한 모델)
STATUSES = ("serve", "not_serve", "unsure", "skip")
_cache: dict = {"mtime": None}
_sugg: dict = {}


# ---------------------------------------------------------------- 읽기

def _clips():
    """index.jsonl → 묶음 목록 (같은 동작의 3~4장). 파일이 바뀌면 다시 읽음."""
    p = CONV / "index.jsonl"
    if not p.exists():
        raise HTTPException(404, "변환된 데이터가 없어요. tools/aihub_convert.py 를 먼저 실행하세요")
    m = p.stat().st_mtime
    if _cache["mtime"] != m:
        by = {}
        for line in open(p, encoding="utf-8"):
            r = json.loads(line)
            c = by.setdefault(r["clip"], {"clip": r["clip"], "view": r["view"], "yaw": r["yaw"], "match": r["match"],
                                          "cam": r["cam"], "org": r["org"], "date": r["date"], "action": r["action"],
                                          "code_serve": r["is_serve"], "ok": True, "frames": []})
            c["frames"].append((r["frame"], r["id"], r["ann"], r["img"]))
            c["ok"] = c["ok"] and r["ok"]
            if c["view"] is None:
                c["view"] = r["view"]
        for c in by.values():
            c["frames"].sort()
        _cache.update(mtime=m, list=sorted(by.values(), key=lambda c: c["clip"]), map=by,
                      img={f[1]: (f[3], f[2]) for c in by.values() for f in c["frames"]})
        _sugg.clear()
    return _cache["list"], _cache["map"]


def _labels() -> dict:
    out = {}
    if LOG.exists():
        for line in open(LOG, encoding="utf-8"):
            line = line.strip()
            if line:
                r = json.loads(line)
                out[r["clip"]] = r
    return out


_pseudo: dict = {"mtime": None, "map": {}}


def _pseudos() -> dict:
    if not PSEUDO.exists():
        return {}
    m = PSEUDO.stat().st_mtime
    if _pseudo["mtime"] != m:
        _pseudo.update(mtime=m, map={r["clip"]: r for r in map(json.loads, open(PSEUDO, encoding="utf-8"))})
    return _pseudo["map"]


def _eff(c, lb):
    """지금 상태: 사람이 고친 값, 없으면 AI-Hub 동작 코드(SRV = 서브)."""
    if lb and lb.get("status"):
        return lb["status"], "human"
    return ("serve" if c["code_serve"] else "not_serve"), "aihub"


def _ann(rel):
    return json.load(open(CONV / rel, encoding="utf-8"))


# ---------------------------------------------------------------- 추천 서버

def suggest_frame(players: list) -> dict | None:
    """사진 1장의 선수 4명(court_pos·side) → 서브 팀 확률·앞사람·추천 서버 pid. 영상 판정과 같은 단서·가중치."""
    pl = [p for p in players if p.get("court_pos")]
    kf = [i for i, p in enumerate(pl) if p["side"] == "far"]
    kn = [i for i, p in enumerate(pl) if p["side"] == "near"]
    if not kf or not kn:
        return None
    P = A.Params()
    mp = np.array([p["court_pos"] for p in pl], float)
    fi = min(kf, key=lambda k: C.dist_to_net(mp[k]))
    ni = min(kn, key=lambda k: C.dist_to_net(mp[k]))
    if P.front_amb > 0:
        def gap(ks, f):
            o = [k for k in ks if k != f]
            return (min(C.dist_to_net(mp[k]) for k in o) - C.dist_to_net(mp[f])) if o else 9.0
        gf, gn = gap(kf, fi), gap(kn, ni)
        if gn < P.front_amb <= gf:
            want = C.service_box("far", mp[fi])
            m_ = [k for k in kn if C.service_box("near", mp[k]) == want]
            if len(m_) == 1:
                ni = m_[0]
        elif gf < P.front_amb <= gn:
            want = C.service_box("near", mp[ni])
            m_ = [k for k in kf if C.service_box("far", mp[k]) == want]
            if len(m_) == 1:
                fi = m_[0]
    occ = np.zeros((1, len(pl)))
    form = {"far": A._behind_score(mp, kf, fi, occ), "near": A._behind_score(mp, kn, ni, occ)}
    st = {"far": A._stance(mp, kf, fi), "near": A._stance(mp, kn, ni)}
    d = {k: st["far"][k] - st["near"][k] for k in ("xc", "pdx", "dnet")}
    logit = (P.w_form * (form["near"] - form["far"]) + P.w_xc * d["xc"] + P.w_pdx * d["pdx"] + P.w_dnet * d["dnet"])
    p_near = 1 / (1 + math.exp(-logit))
    srv = pl[ni] if p_near >= 0.5 else pl[fi]
    return {"server": srv["pid"], "p_near": round(p_near, 3), "conf": round(abs(p_near - 0.5) * 2, 3),
            "front": {"far": pl[fi]["pid"], "near": pl[ni]["pid"]},
            "cues": {"form": {k: round(v, 2) for k, v in form.items()},
                     "stance": {s: {k: round(v, 2) for k, v in x.items()} for s, x in st.items()}}}


def _link(frames: list) -> list:
    """장 사이 같은 선수 잇기: 첫 장 선수 번호(f1 f2 n1 n2)를 track 으로, 다음 장은 코트 위치(없으면 박스 중심) 합이 가장 작은 짝."""
    def key(p, a):
        if p.get("court_pos"):
            return np.array(p["court_pos"], float)
        x1, y1, x2, y2 = p["bbox"]
        return np.array([(x1 + x2) / 2, y2], float) / 300.0   # px → 대략 m 단위
    ref = [p for p in frames[0]["players"]]
    for p in ref:
        p["track"] = p["pid"]
    for fr in frames[1:]:
        cur = fr["players"]
        best, bp = None, None
        n = min(len(ref), len(cur))
        for perm in itertools.permutations(range(len(cur)), n):
            s = sum(float(np.linalg.norm(key(cur[j], fr) - key(ref[i], frames[0]))) for i, j in enumerate(perm))
            if best is None or s < best:
                best, bp = s, perm
        for i, j in enumerate(bp or []):
            cur[j]["track"] = ref[i]["track"]
        for p in cur:
            p.setdefault("track", None)
    return [p["track"] for p in ref]


def clip_detail(clip: str) -> dict:
    _, by = _clips()
    c = by.get(clip)
    if not c:
        raise HTTPException(404, "없는 묶음")
    frames = []
    for fno, fid, rel, _img in c["frames"]:
        a = _ann(rel)
        players = [{k: p.get(k) for k in ("pid", "bbox", "kpts", "court_pos", "side", "foot_px")}
                   for p in a["people"] if p["role"] == "player"]
        ump = [p["bbox"] for p in a["people"] if p["role"] == "umpire"]
        lines = None
        if a["court"].get("homography"):
            H = np.array(a["court"]["homography"])
            lines = [C.to_px(H, ln).round(1).tolist() for ln in C.court_lines()]
        frames.append({"id": fid, "frame": fno, "img": a["image"]["file"], "w": a["image"]["w"], "h": a["image"]["h"],
                       "players": players, "umpires": ump, "checks": a["checks"],
                       "court": {**{k: a["court"].get(k) for k in ("points", "view", "yaw", "clipped")}, "lines_px": lines},
                       "net": (a.get("net") or {}).get("line_px")})
    tracks = _link(frames)
    for fr in frames:
        s = suggest_frame(fr["players"])
        if s:
            t = {p["pid"]: p["track"] for p in fr["players"]}
            s["server_track"] = t.get(s["server"])
        fr["suggest"] = s
    first = next((f["suggest"] for f in frames if f["suggest"]), None)   # 묶음 추천 = 첫 장(서브 직전 자세에 가장 가까움)
    sugg = {"track": first["server_track"], "p_near": first["p_near"], "conf": first["conf"]} if first else None
    _sugg[clip] = sugg
    meta = {k: c[k] for k in ("clip", "view", "yaw", "match", "cam", "org", "date", "action", "ok", "code_serve")}
    lb = _labels().get(clip)
    st, src = _eff(c, lb)
    ps = _pseudos().get(clip)
    pseudo = {k: ps[k] for k in ("server_track", "prob", "probs", "model", "n_train")} if ps else None
    return {**meta, "frames": frames, "tracks": tracks, "suggest": sugg, "pseudo": pseudo, "label": lb,
            "status": st, "status_src": src}


# ---------------------------------------------------------------- API

@router.get("/label")
def label_page():
    return FileResponse(STATIC / "label" / "index.html")


KINDS = ("serve", "all", "server")


@router.get("/api/img/clips")
def list_clips(kind: str = "serve", views: str = "end,diag", match: str = "", action: str = "", only_ok: int = 1,
               todo: int = 0):
    """kind: serve = AI-Hub 가 서브라고 한 묶음 · all = 전체 · server = 지금 서브로 정해진 묶음(서버 지정용).
    todo=1: 아직 손 안 댄 것만 (serve/all: 사람이 확인 안 함, server: 서버 미지정)."""
    if kind not in KINDS:
        raise HTTPException(400, f"kind 는 {KINDS} 중 하나")
    lst, _ = _clips()
    labs = _labels()
    vs = {v for v in views.split(",") if v}
    ms = {m for m in match.split(",") if m}
    acts = {a for a in action.split(",") if a}
    out = []
    for c in lst:
        if (vs and c["view"] not in vs) or (ms and c["match"] not in ms) or (only_ok and not c["ok"]):
            continue
        if acts and c["action"] not in acts and c["action"].split("-")[0] not in acts:
            continue
        lb = labs.get(c["clip"]) or {}
        st, src = _eff(c, lb)
        if kind == "serve" and not c["code_serve"]:
            continue
        if kind == "server" and st != "serve":
            continue
        if todo and (lb.get("server_track") if kind == "server" else src == "human"):
            continue
        out.append({"clip": c["clip"], "view": c["view"], "match": c["match"], "cam": c["cam"], "action": c["action"],
                    "code_serve": c["code_serve"], "status": st, "src": src, "server_track": lb.get("server_track"),
                    "ids": [f[1] for f in c["frames"]]})
    agree = {}
    for lb in labs.values():
        if lb.get("status") == "serve" and lb.get("server_track") and lb.get("suggest_track"):
            a = agree.setdefault(lb.get("view") or "?", [0, 0])
            a[0] += lb["suggest_track"] == lb["server_track"]
            a[1] += 1
    flipped = {"서브→아님": 0, "아님→서브": 0}
    for cl, lb in labs.items():
        c = _cache["map"].get(cl)
        if c and lb.get("status") in ("serve", "not_serve"):
            if c["code_serve"] and lb["status"] == "not_serve":
                flipped["서브→아님"] += 1
            elif not c["code_serve"] and lb["status"] == "serve":
                flipped["아님→서브"] += 1
    return {"clips": out, "total": len(out),
            "checked": sum(1 for c in out if (c["server_track"] if kind == "server" else c["src"] == "human")),
            "labels": len(labs), "flipped": flipped, "with_server": sum(1 for lb in labs.values() if lb.get("server_track")),
            "agree": {v: {"same": a[0], "n": a[1]} for v, a in agree.items()}}


@router.get("/api/img/clip/{clip}")
def get_clip(clip: str):
    return clip_detail(clip)


THUMBS = CONV / "thumbs"


@router.get("/api/img/thumb/{fid}")
def get_thumb(fid: str):
    """격자용 작은 이미지: 선수 4명이 들어가게 16:9 로 잘라 가로 480 (처음 한 번 만들어 converted/thumbs 에 보관)."""
    _clips()
    hit = _cache["img"].get(fid)
    if not hit:
        raise HTTPException(404, "없는 이미지")
    rel, ann = hit
    out = THUMBS / (fid + ".jpg")
    if not out.exists():
        img = cv2.imread(str(IMG / rel))
        if img is None:
            raise HTTPException(404, "이미지를 읽지 못함")
        H, W = img.shape[:2]
        bx = [p["bbox"] for p in _ann(ann)["people"] if p["role"] == "player"]
        if bx:
            b = np.array(bx, float)
            x1, y1, x2, y2 = b[:, 0].min(), b[:, 1].min(), b[:, 2].max(), b[:, 3].max()
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            w = max((x2 - x1) * 1.3, (y2 - y1) * 1.3 * 16 / 9, 480)
            w = min(w, W, H * 16 / 9); h = w * 9 / 16
            x0 = int(np.clip(cx - w / 2, 0, W - w)); y0 = int(np.clip(cy - h / 2, 0, H - h))
            img = img[y0:y0 + int(h), x0:x0 + int(w)]
        img = cv2.resize(img, (480, 270), interpolation=cv2.INTER_AREA)
        THUMBS.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return FileResponse(out, headers={"Cache-Control": "max-age=3600"})


@router.get("/api/img/file/{rel:path}")
def get_file(rel: str, w: int = 0):
    p = (IMG / rel).resolve()
    if IMG.resolve() not in p.parents or not p.is_file():
        raise HTTPException(404, "없는 파일")
    if not w:
        return FileResponse(p, headers={"Cache-Control": "max-age=86400"})
    img = cv2.imread(str(p))
    if img is None:
        raise HTTPException(404, "이미지를 읽지 못함")
    if img.shape[1] > w:
        img = cv2.resize(img, (w, round(img.shape[0] * w / img.shape[1])), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return Response(buf.tobytes(), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


class LabelReq(BaseModel):
    clip: str
    status: str
    server_track: str | None = None
    servers: dict[str, str] | None = None    # 장마다 서버 pid (장 사이 잇기가 틀려 장별로 고친 것 포함)
    note: str | None = None
    pseudo: bool | None = None               # 가짜 라벨을 그대로 받아들인 것인지 (바꿨으면 False)


class LabelsReq(BaseModel):
    items: list[LabelReq]


def _write(reqs: list[LabelReq]) -> list[dict]:
    _, by = _clips()
    labs = _labels()
    recs = []
    for req in reqs:
        c = by.get(req.clip)
        if not c:
            raise HTTPException(404, f"없는 묶음 {req.clip}")
        if req.status not in STATUSES:
            raise HTTPException(400, f"status 는 {STATUSES} 중 하나")
        prev = labs.get(req.clip) or {}
        srv = req.server_track if req.server_track is not None else prev.get("server_track")
        servers = req.servers if req.servers is not None else prev.get("servers")
        rec = {"clip": req.clip, "status": req.status,
               "server_track": srv if req.status == "serve" else None,
               "servers": servers if req.status == "serve" else None,
               "code_serve": c["code_serve"], "view": c["view"], "match": c["match"], "cam": c["cam"],
               "action": c["action"], "frames": [f[1] for f in c["frames"]],
               "note": req.note if req.note is not None else prev.get("note"),
               "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        if req.pseudo is not None and req.status == "serve":
            rec["from_pseudo"] = req.pseudo
        if rec["server_track"]:
            sg = _sugg.get(req.clip) or clip_detail(req.clip)["suggest"]
            rec["suggest_track"] = (sg or {}).get("track")
            rec["suggest_p_near"] = (sg or {}).get("p_near")
        recs.append(rec)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        for rec in recs:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return recs


@router.post("/api/img/label")
def save_label(req: LabelReq):
    """한 묶음 저장. 서버를 안 보내면 이전에 고른 서버를 이어받는다 (서브가 아니면 지움)."""
    return _write([req])[0]


@router.post("/api/img/labels")
def save_labels(req: LabelsReq):
    """여러 묶음 한꺼번에 (격자에서 '이 페이지 확인')."""
    return {"saved": len(_write(req.items))}

"""알고리즘 실험 페이지 (/lab) API.

운영 화면과 따로 동작한다. 설정과 결과는 data/videos/<id>/lab/ 에만 저장하고
운영용 match.json · tracks.npz · result.json 은 건드리지 않는다.

  GET  /lab                          실험 페이지
  GET  /api/lab/{vid}                영상 정보 + 실험 설정 + 추적 결과 유무
  POST /api/lab/fit-court            코트 점·라인 → 호모그래피와 오차 (설정 화면에서 실시간)
  PUT  /api/lab/{vid}/config         코트 점·라인 · 선수 4명 · 심판 · 경기 설정 저장
  POST /api/lab/{vid}/detect         설정 프레임 사람 검출 (코트 점으로 코트 위치 계산)
  POST /api/lab/{vid}/track          추적 실행 (작업 ID 반환, /api/jobs/{id}로 진행 확인)
  GET/POST/DELETE /api/lab/{vid}/presets[/{이름}[/load]]  설정 이름 붙여 보관 · 불러오기 (data/configs/)
  GET  /api/lab/{vid}/tracks         추적 결과 (위치·박스·가려짐·심판 박스)
  GET  /api/lab/{vid}/kps            관절 (int16 바이너리: S×N×17×3, 신뢰도는 ×1000)
  POST /api/lab/{vid}/serves         기준값으로 서브 판정만 다시 계산 (추적은 재사용)
"""
from __future__ import annotations

import dataclasses
import re
import time
import traceback
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from . import analysis as A
from . import court as C
from .main import (DATA, GPU_POOL, JOBS, STATIC, Job, _detect, models, read_frame, read_json, source_path, submit, vdir,
                   write_json)

router = APIRouter()


def ldir(vid: str):
    d = vdir(vid) / "lab"
    d.mkdir(exist_ok=True)
    return d


def _foot_court(H, b):
    return C.to_court(H, [[(b[0] + b[2]) / 2, b[3]]])[0].round(3).tolist()


@router.get("/lab")
def lab_page():
    return FileResponse(STATIC / "lab" / "index.html")


@router.get("/api/lab/{vid}")
def lab_info(vid: str):
    d = vdir(vid)
    L = ldir(vid)
    meta = read_json(d / "meta.json", {})
    cfg = read_json(L / "config.json")
    seeded = False
    if cfg is None:  # 처음이면 운영 설정의 코트·선수를 가져와 시작점으로 쓴다 (저장은 안 함)
        op = read_json(d / "match.json")
        if op:
            pts = [{"court": c, "px": p} for c, p in zip(C.COURT.tolist(), op["court_corners_px"])]
            cfg = {"ref_frame": op["ref_frame"], "points": pts,
                   "teams": op["teams"], "officials": op.get("officials", []), "match": op.get("match", {})}
            seeded = True
    jid = meta.get("jobs", {}).get("lab_track")
    job = JOBS[jid].to_dict() if jid in JOBS else read_json(d / "job_lab_track.json")
    stem = Path(meta.get("name") or vid).stem
    tmeta = read_json(L / "tracks_meta.json", {})
    has_tracks = (L / "tracks.npz").exists()
    # 추적 결과가 지금 설정으로 만든 것인지 (설정을 바꾸거나 다른 설정을 불러오면 다시 추적해야 함)
    stale = bool(has_tracks and cfg and tmeta.get("config_saved") != cfg.get("saved"))
    return {"meta": meta, "config": cfg, "seeded": seeded, "has_tracks": has_tracks, "tracks_stale": stale,
            "tracks_config": tmeta.get("config_name"), "job": job, "params": dataclasses.asdict(A.Params()),
            "presets": _presets(vid), "stem": stem,
            # 이 영상에 아직 실험 설정이 없는데 같은 이름의 설정 파일이 있으면 화면에서 쓸지 묻는다
            "same_name": _preset_info(CONFIGS / f"{stem}.json")
            if (cfg is None or seeded) and NAME_RE.match(stem) and (CONFIGS / f"{stem}.json").exists() else None}


NAME_RE = re.compile(r"^[\w가-힣 .\-]{1,40}$")


CONFIGS = DATA.parent / "configs"   # data/configs/<이름>.json : 영상 ID가 아니라 이름으로 찾는 설정 (다시 올려도 재사용)


def _preset_info(p) -> dict:
    c = read_json(p, {})
    return {"name": p.stem, "saved": c.get("saved"), "video": c.get("video_name"), "points": len(c.get("points", [])),
            "lines": len(c.get("lines", [])), "ref_frame": c.get("ref_frame"), "officials": len(c.get("officials", []))}


def _presets(vid: str | None = None) -> list[dict]:
    CONFIGS.mkdir(parents=True, exist_ok=True)
    return [_preset_info(p) for p in sorted(CONFIGS.glob("*.json"), key=lambda p: -p.stat().st_mtime)]


def _preset_path(name: str):
    if not NAME_RE.match(name) or name.strip(".") == "":
        raise HTTPException(400, "이름은 40자 이내 글자·숫자·공백·.-_ 만 쓸 수 있어요")
    return CONFIGS / f"{name}.json"


@router.get("/api/lab/{vid}/presets")
def lab_presets(vid: str):
    return _presets(vid)


@router.post("/api/lab/{vid}/presets/{name}")
def lab_save_preset(vid: str, name: str):
    """지금 저장된 설정(config.json)을 이름 붙여 보관: data/configs/<이름>.json"""
    p = _preset_path(name)
    cfg = read_json(ldir(vid) / "config.json")
    if cfg is None:
        raise HTTPException(400, "먼저 저장해 주세요")
    cfg["name"] = name
    cfg["video_name"] = read_json(vdir(vid) / "meta.json", {}).get("name")
    CONFIGS.mkdir(parents=True, exist_ok=True)
    write_json(p, cfg)
    write_json(ldir(vid) / "config.json", cfg)
    return _presets(vid)


@router.post("/api/lab/{vid}/presets/{name}/load")
def lab_load_preset(vid: str, name: str):
    """보관한 설정을 이 영상의 지금 설정으로 불러온다."""
    p = _preset_path(name)
    if not p.exists():
        raise HTTPException(404, "그 이름의 설정이 없어요")
    cfg = read_json(p)
    write_json(ldir(vid) / "config.json", cfg)
    return cfg


@router.delete("/api/lab/{vid}/presets/{name}")
def lab_delete_preset(vid: str, name: str):
    p = _preset_path(name)
    if p.exists():
        p.unlink()
    return _presets(vid)


class TeamIn(BaseModel):
    name: str = ""
    bboxes: list[list[float]] = Field(default_factory=list)


class CourtPoint(BaseModel):
    court: list[float]    # 코트 좌표 (m)
    px: list[float]       # 영상 픽셀


class CourtLine(BaseModel):
    line: list[list[float]]   # 코트 라인 양 끝 (m)
    px: list[list[float]]     # 그 라인 위에서 찍은 픽셀들 (끝이 잘려도 보이는 곳 아무 데나, 2개 이상)


def fit_court(points: list[CourtPoint], lines: list[CourtLine] = ()) -> dict:
    """코트 교차점 ↔ 픽셀, 코트 라인 ↔ 그 위의 픽셀들로 호모그래피(코트 m → 픽셀)를 구한다.

    1) 선형 풀이(DLT): 점은 2개 식, 라인은 '라인의 두 끝점을 옮긴 점이 영상 라인 위에 있다'로 2개 식
    2) 다듬기: 점은 재투영 거리, 라인은 찍은 픽셀과 옮겨진 라인 사이 거리(px)를 최소제곱
    """
    from scipy.optimize import least_squares
    lines = [l for l in lines if len(l.px) >= 2]
    if 2 * len(points) + 2 * len(lines) < 8:
        raise HTTPException(400, "코트 점·라인이 더 필요해요 (교차점 1개 = 라인 1개 = 식 2개, 합쳐서 8개 이상)")
    k = 1000.0  # 픽셀을 1/1000로 줄여 수치 안정화
    rows = []
    for p in points:
        X, Y = p.court; x, y = p.px[0] / k, p.px[1] / k
        rows += [[X, Y, 1, 0, 0, 0, -x * X, -x * Y, -x], [0, 0, 0, X, Y, 1, -y * X, -y * Y, -y]]
    img_lines = []
    for ln in lines:
        q = np.float64(ln.px) / k
        c0 = q.mean(0); _, _, vt = np.linalg.svd(q - c0)
        n = vt[1]; abc = np.array([n[0], n[1], -n @ c0])   # 영상 라인 ax+by+c=0 (|a,b|=1)
        img_lines.append(abc)
        for X, Y in ln.line:
            a_, b_, c_ = abc
            rows.append([a_ * X, a_ * Y, a_, b_ * X, b_ * Y, b_, c_ * X, c_ * Y, c_])
    A = np.array(rows)
    _, sv, vt = np.linalg.svd(A)
    if sv[-2] < 1e-9 * sv[0]:
        raise HTTPException(400, "점·라인 배치로 코트를 정할 수 없어요. 서로 다른 방향의 라인이나 점을 섞어 주세요")
    h = vt[-1].reshape(3, 3)
    h = np.diag([k, k, 1.0]) @ h
    h = h / h[2, 2]

    pc = np.float64([p.court for p in points]).reshape(-1, 2); pp = np.float64([p.px for p in points]).reshape(-1, 2)

    def apply(H, P):
        P = np.c_[P, np.ones(len(P))] @ H.T
        return P[:, :2] / P[:, 2:3]

    def line_dist(H, ln):
        e = apply(H, np.float64(ln.line)); d = e[1] - e[0]
        nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-12)
        return (np.float64(ln.px) - e[0]) @ nrm

    def resid(v):
        H = np.append(v, 1).reshape(3, 3)
        r = [(apply(H, pc) - pp).ravel()] if len(pc) else []
        r += [line_dist(H, ln) for ln in lines]
        return np.concatenate(r)

    try:
        v = least_squares(resid, h.ravel()[:8], x_scale=np.abs(h.ravel()[:8]) + 1e-6, method="lm").x
        Hc = np.append(v, 1).reshape(3, 3)
    except Exception:  # noqa: BLE001  (다듬기 실패 시 선형 풀이 사용)
        Hc = h
    perr = np.linalg.norm(apply(Hc, pc) - pp, axis=1) if len(pc) else np.zeros(0)
    lerr = [float(np.abs(line_dist(Hc, ln)).mean()) for ln in lines]
    allerr = list(perr) + lerr
    # 좌우 뒤집힘: 코트 x(왼→오), y(먼→가까운)가 화면에서도 같은 손잡이 방향인지 (야코비안 부호)
    ref = np.vstack([pc] + [np.float64(ln.line) for ln in lines]).mean(0)
    o, ex, ey = apply(Hc, np.array([ref, ref + [0.01, 0], ref + [0, 0.01]]))
    mirrored = bool((ex - o)[0] * (ey - o)[1] - (ex - o)[1] * (ey - o)[0] < 0)
    Hi = np.linalg.inv(Hc)
    return {"h_court2px": Hc / Hc[2, 2], "homography": Hi / Hi[2, 2],
            "errors": [round(float(e), 1) for e in perr], "line_errors": [round(e, 1) for e in lerr],
            "mean_err": round(float(np.mean(allerr)), 2), "mirrored": mirrored,
            "spare": 2 * len(points) + 2 * len(lines) - 8}   # 최소(8개)를 넘는 식 수 = 검산 여유


def fit_points(points: list[CourtPoint], lines: list[CourtLine] = ()) -> dict:
    return fit_court(points, lines)


class FitReq(BaseModel):
    points: list[CourtPoint] = Field(default_factory=list)
    lines: list[CourtLine] = Field(default_factory=list)


@router.post("/api/lab/fit-court")
def lab_fit_court(req: FitReq):
    """설정 화면에서 점·라인을 찍을 때마다 호출: 호모그래피와 점·라인별 오차."""
    r = fit_court(req.points, req.lines)
    return {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in r.items()}


class LabConfig(BaseModel):
    ref_frame: int
    points: list[CourtPoint] = Field(default_factory=list)
    lines: list[CourtLine] = Field(default_factory=list)
    teams: dict[str, TeamIn]                      # "A" / "B"
    officials: list[list[float]] = Field(default_factory=list)
    match: dict = Field(default_factory=dict)


@router.put("/api/lab/{vid}/config")
def lab_put_config(vid: str, body: LabConfig):
    d = vdir(vid)
    meta = read_json(d / "meta.json", {})
    fitres = fit_court(body.points, body.lines)
    H = fitres["homography"]
    teams = {}
    for key, num in (("A", "1"), ("B", "2")):
        t = body.teams.get(key, TeamIn())
        pos = [_foot_court(H, b) for b in t.bboxes]
        sides = [C.side_of(p[1]) for p in pos]
        side = max(set(sides), key=sides.count) if sides else ("far" if key == "A" else "near")
        teams[num] = {"name": t.name or f"팀 {key}", "bboxes": t.bboxes, "court_pos": pos, "side": side}
    if teams["1"]["side"] == teams["2"]["side"]:
        raise HTTPException(400, "두 팀이 네트의 같은 쪽에 있어요")
    match = {"mode": "doubles", "first": "A", "scoreA": 0, "scoreB": 0, "target": 25, "game": 1}
    match.update(body.match)
    cfg = {"fps": meta.get("fps"), "frame_size": [meta.get("width"), meta.get("height")],
           "ref_frame": body.ref_frame, "points": [p.model_dump() for p in body.points],
           "lines": [l.model_dump() for l in body.lines],
           "point_errors": fitres["errors"], "line_errors": fitres["line_errors"], "mirrored": fitres["mirrored"],
           "homography": H.tolist(), "h_court2px": fitres["h_court2px"].tolist(), "teams": teams, "match": match,
           "officials": [{"bbox": b, "court_pos": _foot_court(H, b)} for b in body.officials if len(b) >= 4],
           "saved": time.time()}
    old = read_json(ldir(vid) / "config.json", {}) or {}
    if old.get("name"):
        cfg["name"] = old["name"]   # 이름 붙인 설정을 고쳐 저장하면 이름은 유지 (보관본은 '이름 붙여 저장'으로 갱신)
    write_json(ldir(vid) / "config.json", cfg)
    return cfg


class LabDetect(BaseModel):
    frame: int
    points: list[CourtPoint] = Field(default_factory=list)
    lines: list[CourtLine] = Field(default_factory=list)


@router.post("/api/lab/{vid}/detect")
def lab_detect(vid: str, req: LabDetect):
    """설정 프레임에서 사람 검출. 코트 점이 4개 이상이면 코트 위치도 계산한다."""
    img = read_frame(vdir(vid), req.frame)
    try:
        H = fit_court(req.points, req.lines)["homography"]
    except HTTPException:
        H = None
    return {"frame": req.frame, "people": _detect(img, H)}


@router.post("/api/lab/{vid}/track")
def lab_track(vid: str):
    d = vdir(vid)
    L = ldir(vid)
    cfg = read_json(L / "config.json")
    if cfg is None:
        raise HTTPException(400, "먼저 설정을 저장해 주세요")
    meta = read_json(d / "meta.json", {})
    jid = meta.get("jobs", {}).get("lab_track")
    if jid in JOBS and JOBS[jid].state in ("queued", "running"):
        return JOBS[jid].to_dict()
    job = Job("lab_track", vid, ["모델 준비", "검출 · 매칭 · 자세"])

    def fn(job: Job):
        job.stage(0, 0.3, "Detector · Pose 불러오는 중")
        ms = models()
        job.finish_stage(0, "GPU" if "CUDA" in ms[0].sess.get_providers()[0] else "CPU")
        t0 = time.time()

        def prog(p, msg):
            el = time.time() - t0
            eta = el / max(p, 1e-3) * (1 - p)
            job.stage(1, p, f"{msg} · 남은 시간 약 {int(eta // 60)}분 {int(eta % 60)}초")

        # 검출·관절 결과를 lab/detections.npz 에 저장해 두고, 다음 추적부터는 영상을 다시 읽지 않는다
        tr = A.track(str(source_path(d)), cfg, ms, prog, stop=job.stop, cache=L / "detections.npz")
        A.save_tracks(tr, L / "tracks.npz")
        write_json(L / "tracks_meta.json", {"config_saved": cfg.get("saved"), "config_name": cfg.get("name"),
                                            "finished": time.time()})
        job.finish_stage(1, f"{len(tr['frames']):,}개 샘플 · {time.time() - t0:.0f}초")
        try:   # 추적이 끝나면 기본 기준값으로 판정한 결과를 실행 기록으로 남긴다
            save_run(vid, A.Params(), name="추적 직후 (기본 기준값)")
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    return submit(job, fn, GPU_POOL).to_dict()


def _tracks(vid: str) -> dict:
    p = ldir(vid) / "tracks.npz"
    if not p.exists():
        raise HTTPException(404, "아직 추적 결과가 없어요")
    return A.load_tracks(p)


def _nan_list(a: np.ndarray, nd: int):
    a = np.round(a.astype(np.float64), nd)
    return np.where(np.isnan(a), None, a).tolist()


@router.get("/api/lab/{vid}/tracks")
def lab_tracks(vid: str):
    tr = _tracks(vid)
    S = len(tr["frames"])
    return {"frames": tr["frames"].tolist(), "fps": float(tr["fps"]), "step": int(tr["step"]),
            "slots": [str(s) for s in tr["slots"]],
            "pos": _nan_list(tr["pos"], 3), "box": _nan_list(tr["box"], 1),
            "occ": tr.get("occ", np.zeros(tr["pos"].shape[:2])).astype(int).tolist(),
            "conf": np.round(tr["conf"], 3).tolist(),
            "off_box": _nan_list(tr["off_box"], 1) if "off_box" in tr else [[] for _ in range(S)]}


@router.get("/api/lab/{vid}/kps")
def lab_kps(vid: str):
    k = _tracks(vid)["kps"].astype(np.float32)
    k[..., 2] *= 1000
    return Response(np.round(k).clip(-32768, 32767).astype("<i2").tobytes(), media_type="application/octet-stream",
                    headers={"X-Shape": ",".join(map(str, k.shape))})


class ServeReq(BaseModel):
    params: dict = Field(default_factory=dict)


# ---------------------------------------------------------------- 실행 기록
RESULTS = DATA.parent / "results"   # data/results/<영상 이름>/<날짜-시각>.json (영상 작업 폴더를 지워도 남는다)


def _results_dir(vid: str):
    stem = _stem(vid)
    if not NAME_RE.match(stem):
        raise HTTPException(400, "영상 이름으로 결과 폴더를 만들 수 없어요")
    return RESULTS / stem


def save_run(vid: str, params: "A.Params", name: str = "") -> dict:
    """지금 추적 결과 + 기준값으로 서브를 판정·채점해서 실행 기록으로 저장한다."""
    L = ldir(vid)
    tr = _tracks(vid)
    cfg = read_json(L / "config.json") or {}
    dbg: dict = {}
    serves = A.find_serves(tr, cfg.get("match", {}).get("mode", "doubles"), params, debug=dbg)
    scored, summary = [], None
    if cfg.get("teams"):
        setup = dict(cfg.get("match", {}))
        setup["nameA"], setup["nameB"] = cfg["teams"]["1"]["name"], cfg["teams"]["2"]["name"]
        sides = {"A": cfg["teams"]["1"]["side"], "B": cfg["teams"]["2"]["side"]}
        scored, summary = A.score_events(serves, setup, sides)
    truth_data = read_json(L / "truth.json", {})
    truth = truth_times(truth_data)
    stages: dict = {}
    for r in dbg.get("runs", []):
        stages[r["stage"]] = stages.get(r["stage"], 0) + 1
    default = dataclasses.asdict(A.Params())
    p = dataclasses.asdict(params)
    now = time.time()
    rid = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    rec = {
        "id": rid, "at": now, "name": name, "video_name": read_json(vdir(vid) / "meta.json", {}).get("name"),
        "config_name": cfg.get("name"), "config_saved": cfg.get("saved"),
        "tracks_finished": read_json(L / "tracks_meta.json", {}).get("finished"),
        "params": p, "changed": {k: v for k, v in p.items() if default.get(k) != v},
        "serves": [{k: e.get(k) for k in ("t", "server", "score", "game", "conf", "flags", "box", "p_near", "view")} for e in scored]
        or [{"t": e["t"]} for e in serves],
        "summary": summary, "stages": stages,
        "eval": eval_serves(serves, scored, truth_data),
    }
    out = _results_dir(vid)
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / f"{rid}.json", rec)
    return rec


def _run_brief(rec: dict) -> dict:
    ev = rec.get("eval") or {}
    return {"id": rec["id"], "at": rec["at"], "name": rec.get("name", ""), "n": len(rec.get("serves", [])),
            "changed": rec.get("changed", {}), "summary": rec.get("summary"), "stages": rec.get("stages"),
            "eval": {k: ev.get(k) for k in ("truth", "hit", "recall", "precision", "f1", "finalized")} if ev else None}


class RunReq(BaseModel):
    params: dict = Field(default_factory=dict)
    name: str = ""


@router.get("/api/lab/{vid}/runs")
def lab_runs(vid: str):
    d = _results_dir(vid)
    return [_run_brief(read_json(p)) for p in sorted(d.glob("*.json"), reverse=True)] if d.exists() else []


@router.post("/api/lab/{vid}/runs")
def lab_save_run(vid: str, req: RunReq):
    fields = {f.name for f in dataclasses.fields(A.Params)}
    params = A.Params(**{k: float(v) for k, v in req.params.items() if k in fields})
    return _run_brief(save_run(vid, params, req.name[:60]))


@router.get("/api/lab/{vid}/runs/{rid}")
def lab_get_run(vid: str, rid: str):
    if not re.match(r"^\d{8}-\d{6}$", rid):
        raise HTTPException(400, "잘못된 기록 ID")
    rec = read_json(_results_dir(vid) / f"{rid}.json")
    if rec is None:
        raise HTTPException(404, "그 기록이 없어요")
    return rec


@router.post("/api/lab/{vid}/serves")
def lab_serves(vid: str, req: ServeReq):
    tr = _tracks(vid)
    cfg = read_json(ldir(vid) / "config.json") or {}
    fields = {f.name for f in dataclasses.fields(A.Params)}
    params = A.Params(**{k: float(v) for k, v in req.params.items() if k in fields})
    dbg: dict = {}
    t0 = time.time()
    serves = A.find_serves(tr, cfg.get("match", {}).get("mode", "doubles"), params, debug=dbg)
    scored, summary = [], None
    if cfg.get("teams"):
        setup = dict(cfg.get("match", {}))
        setup["nameA"], setup["nameB"] = cfg["teams"]["1"]["name"], cfg["teams"]["2"]["name"]
        sides = {"A": cfg["teams"]["1"]["side"], "B": cfg["teams"]["2"]["side"]}
        scored, summary = A.score_events(serves, setup, sides)
    runs = dbg.get("runs", [])
    for r in runs:
        r.pop("i0", None); r.pop("i1", None)
    v = dbg.get("v")
    lv = dbg.get("live")
    live = None
    if lv:   # 샘플마다 서브 조건 검사값 (지금 왜 서브가 아닌지)
        live = {"fast_k": lv["fast_k"].tolist(), "fast_v": np.round(lv["fast_v"], 2).tolist(),
                "run_s": np.round(lv["run_s"], 2).tolist(), "front": lv["front"].tolist(),
                "dist": _nan_list(lv["dist"], 2), "x": _nan_list(lv["x"], 2), "box": lv["box"],
                "box_range": [round(float(x), 2) for x in lv["box_range"]]}
    truth_data = read_json(ldir(vid) / "truth.json", {})
    truth = truth_times(truth_data)
    return {"params": dataclasses.asdict(params), "ms": round((time.time() - t0) * 1000), "live": live,
            "speed": _nan_list(v, 2) if v is not None else [],
            "still": dbg["still"].astype(int).tolist() if "still" in dbg else [],
            "runs": runs, "serves": scored, "summary": summary,
            "eval": eval_serves(serves, scored, truth_data)}


# ---------------------------------------------------------------- 정답 서브 · 채점 · 자동 맞추기
TOL_BEFORE, TOL_AFTER = 1.5, 2.5   # 판정 시각(정지가 끝난 때) 기준으로 정답(사람이 누른 서브 순간)이 이 범위 안이면 맞음


def evaluate(pred: list[float], truth: list[float], pairs: list | None = None) -> dict:
    """판정 서브와 정답 서브를 시간순으로 1:1 짝짓는다."""
    pred, truth = sorted(pred), sorted(truth)
    used, hit = set(), {}
    for i, pt in enumerate(pred):
        best = None
        for j, tt in enumerate(truth):
            if j in used or not (pt - TOL_BEFORE <= tt <= pt + TOL_AFTER):
                continue
            if best is None or abs(tt - pt) < abs(truth[best] - pt):
                best = j
        if best is not None:
            used.add(best); hit[i] = best
    tp = len(hit)
    if pairs is not None:
        pairs.extend(sorted(hit.items()))
    return {"truth": len(truth), "pred": len(pred), "hit": tp, "missed": [t for j, t in enumerate(truth) if j not in used],
            "false": [t for i, t in enumerate(pred) if i not in hit],
            "recall": round(tp / max(len(truth), 1), 3), "precision": round(tp / max(len(pred), 1), 3),
            "f1": round(2 * tp / max(len(truth) + len(pred), 1), 3)}


LABELS = DATA.parent / "labels"   # data/labels/<영상 이름>.json : 같은 이름 영상을 다시 올려도 정답을 다시 쓴다


class TruthReq(BaseModel):
    marks: list[dict] = Field(default_factory=list)   # [{t, spot: 'far-L'|'far-R'|'near-L'|'near-R', note, src: 'auto', stage, reason, ok}]
    final: dict | None = None                          # 최종 점수 {A, B}
    finalized: bool = False                            # '최종 정답 저장'을 눌렀는지


def truth_times(data: dict | None) -> list[float]:
    """채점에 쓰는 정답 시각: 직접 기록한 것 + 자동 후보 중 사람이 확인한 것."""
    return [m["t"] for m in (data or {}).get("marks", []) if m.get("src") != "auto" or m.get("ok")]


def spot_truth(spot: str | None):
    """정답의 서버 위치(화면 기준: 위/아래 코트 · 화면 왼쪽/오른쪽) → (서버 쪽, 서버 기준 서비스 코트)."""
    if spot not in ("far-L", "far-R", "near-L", "near-R"):
        return None, None
    side, lr = spot.split("-")
    # far 쪽은 카메라를 보고 서므로 화면 왼쪽 = 서버의 오른쪽, near 쪽은 화면 오른쪽 = 서버의 오른쪽
    box = "right" if (side == "far") == (lr == "L") else "left"
    return side, box


def eval_serves(serves: list, scored: list, truth_data: dict | None) -> dict | None:
    """서브 시각 채점 + (정답에 서버 위치가 있으면) 서버 쪽·좌우 채점."""
    marks = sorted([m for m in (truth_data or {}).get("marks", []) if m.get("src") != "auto" or m.get("ok")], key=lambda m: m["t"])
    if not marks:
        return None
    pairs: list = []
    pred = sorted(range(len(serves)), key=lambda i: serves[i]["t"])
    ev = evaluate([serves[i]["t"] for i in pred], [m["t"] for m in marks], pairs)
    ev["finalized"] = bool((truth_data or {}).get("finalized"))
    sv = {"labeled": 0, "side_ok": 0, "side_raw_ok": 0, "box_ok": 0, "box_n": 0, "wrong_side": [], "wrong_box": []}
    for pi, tj in pairs:
        i, m = pred[pi], marks[tj]
        side, box = spot_truth(m.get("spot"))
        if not side:
            continue
        e = serves[i]
        s = scored[i] if i < len(scored) else {}
        sv["labeled"] += 1
        raw = "near" if float(e.get("p_near", 0.5)) >= 0.5 else "far"   # 이벤트 하나만 보고 고른 쪽
        got = s.get("side") or raw                                       # 경기 흐름(빔 서치)까지 본 쪽
        sv["side_raw_ok"] += raw == side
        if got == side:
            sv["side_ok"] += 1
        else:
            sv["wrong_side"].append(m["t"])
        # 좌우는 서버 쪽을 정답으로 놓고 그때 알고리즘이 읽은 값(리시버 기준)을 본다
        bx = (e.get("boxes") or {}).get("far" if side == "near" else "near") or e.get("box")
        if bx:
            sv["box_n"] += 1
            if bx == box:
                sv["box_ok"] += 1
            else:
                sv["wrong_box"].append(m["t"])
    ev["server"] = sv if sv["labeled"] else None
    return ev


def _stem(vid: str) -> str:
    return Path(read_json(vdir(vid) / "meta.json", {}).get("name") or vid).stem


@router.get("/api/lab/{vid}/candidates")
def lab_candidates(vid: str, which: str = "all"):
    """정답 입력용 서브 후보: 실험 페이지 추적 결과의 정지 구간 (which=all 전부 · ok 서브로 판정된 것만).
    후보 시각은 정지가 끝난 때(서브 순간 근처)."""
    if not (ldir(vid) / "tracks.npz").exists():
        raise HTTPException(400, "실험 페이지에서 추적을 먼저 실행해 주세요")
    tr = _tracks(vid)
    mode = (read_json(ldir(vid) / "config.json") or {}).get("match", {}).get("mode", "doubles")
    dbg: dict = {}
    A.find_serves(tr, mode, A.Params(), debug=dbg)
    out = [{"t": round(r["t1"], 2), "stage": r["stage"], "reason": r["reason"]} for r in dbg.get("runs", [])
           if which == "all" or r["stage"] == "OK"]
    return {"candidates": out}


@router.get("/label")
def label_page():
    return FileResponse(STATIC / "label" / "index.html")


@router.get("/api/lab/{vid}/truth")
def lab_get_truth(vid: str):
    """정답 서브. 이 영상에 아직 없으면 같은 이름으로 저장된 정답(data/labels)을 돌려준다 (from_name=True)."""
    cur = read_json(ldir(vid) / "truth.json")
    if cur and (cur.get("marks") or cur.get("final")):
        return cur
    stem = _stem(vid)
    named = read_json(LABELS / f"{stem}.json") if NAME_RE.match(stem) else None
    if named:
        return {**named, "from_name": True}
    return {"marks": [], "final": None}


@router.put("/api/lab/{vid}/truth")
def lab_put_truth(vid: str, req: TruthReq):
    marks = []
    for m in req.marks:
        if "t" not in m:
            continue
        item = {"t": round(float(m["t"]), 2)}
        if m.get("server") in ("A", "B"):
            item["server"] = m["server"]
        if m.get("note"):
            item["note"] = str(m["note"])[:100]
        if m.get("src") == "auto":   # 자동 판정에서 불러온 후보: 사람이 확인(ok)해야 정답으로 쓴다
            item.update(src="auto", ok=bool(m.get("ok")), stage=str(m.get("stage", ""))[:4], reason=str(m.get("reason", ""))[:200])
        marks.append(item)
    marks.sort(key=lambda m: m["t"])
    final = None
    if req.final and all(str(req.final.get(k, "")).strip().isdigit() for k in ("A", "B")):
        final = {"A": int(req.final["A"]), "B": int(req.final["B"])}
    pending = sum(1 for m in marks if m.get("src") == "auto" and not m.get("ok"))
    if req.finalized and pending:
        raise HTTPException(400, f"확인하지 않은 후보가 {pending}개 남았어요")
    data = {"marks": marks, "final": final, "finalized": bool(req.finalized),
            "finalized_at": time.time() if req.finalized else None,
            "video_name": read_json(vdir(vid) / "meta.json", {}).get("name"), "saved": time.time()}
    write_json(ldir(vid) / "truth.json", data)
    stem = _stem(vid)
    if NAME_RE.match(stem):
        LABELS.mkdir(parents=True, exist_ok=True)
        write_json(LABELS / f"{stem}.json", data)
    return data


TUNE_GRID = {   # 자동 맞추기에서 바꿔 보는 값 (서브 판정 기준만, 추적은 그대로)
    "still_speed": [0.4, 0.55, 0.7, 0.9, 1.1],
    "still_min": [0.2, 0.3, 0.4, 0.6, 0.8],
    "merge_gap": [0.2, 0.35, 0.6, 0.9],
    "rally_speed": [1.0, 1.3, 1.6, 2.0],
    "rally_window": [1.5, 2.5, 4.0],
    "rally_min": [0.0, 0.3, 0.5, 0.8],
    "min_serve_gap": [2.0, 3.5, 5.0],
    "box_front": [0.3, 0.7, 1.2, 1.8],
    "box_back": [0.2, 0.4, 1.0, 1.6],
    "smooth": [0.3, 0.45, 0.7],
    "require_diagonal": [0.0, 1.0],
    "serve_lag": [0.8, 1.1, 1.4, 1.7, 2.0],
}


class TuneReq(BaseModel):
    params: dict = Field(default_factory=dict)   # 시작값


@router.post("/api/lab/{vid}/tune")
def lab_tune(vid: str, req: TuneReq):
    """정답 서브에 가장 잘 맞도록 기준값을 하나씩 바꿔 보며 찾는다 (좌표 하강, 3바퀴)."""
    truth = truth_times(read_json(ldir(vid) / "truth.json", {}))
    if len(truth) < 5:
        raise HTTPException(400, "정답 서브를 5개 이상 표시해 주세요")
    tr = _tracks(vid)
    mode = (read_json(ldir(vid) / "config.json") or {}).get("match", {}).get("mode", "doubles")
    fields = {f.name for f in dataclasses.fields(A.Params)}
    cur = dataclasses.asdict(A.Params()) | {k: float(v) for k, v in req.params.items() if k in fields}
    cache = {}

    def score(p):
        key = tuple(sorted(p.items()))
        if key not in cache:
            sv = A.find_serves(tr, mode, A.Params(**p))
            ev = evaluate([e["t"] for e in sv], truth)
            cache[key] = (ev["f1"], ev["hit"], -ev["pred"], ev)
        return cache[key]

    t0 = time.time()
    start = score(cur)[3]
    best = score(cur)
    for _ in range(3):
        changed = False
        for k, vals in TUNE_GRID.items():
            for v in vals:
                cand = dict(cur, **{k: v})
                sc = score(cand)
                if sc[:3] > best[:3]:
                    best, cur, changed = sc, cand, True
        if not changed:
            break
    return {"params": cur, "before": start, "after": best[3], "tried": len(cache), "sec": round(time.time() - t0, 1)}

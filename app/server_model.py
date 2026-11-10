"""서브 팀 판단 모델 (서버 고르기 모델) — 영상 서브마다 선수 4명 중 서버를 고르고, 가까운 쪽 서브 확률 p_near 를 낸다.

모델: tools/pseudo_server.py 로 AI-Hub 이미지(사람이 라벨링·확인한 서버)에서 학습한 선형 소프트맥스(4명 중 1명).
  app/assets/server_chooser.json = {names, mu, sd, w, n_train, at}
  .venv/bin/python tools/pseudo_server.py --save-model   로 다시 만든다.

판단 방법 (경기 설정 match.server_judge):
  "algorithm" = 원래 알고리즘 p_near (기본)
  "model"     = 모델 p_near
  "both"      = 둘이 같은 쪽이면 더 강하게(logit 더하기), 다르면 0.5 쪽으로 (점수 규칙이 앞뒤 서브로 정하게)
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import court as C

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "app" / "assets" / "server_chooser.json"   # 작아서 저장소에 같이 둠
TRACKS = ["f1", "f2", "n1", "n2"]
HALF_W, SSL = 6.1 / 2, 1.98
KP_MIN = 0.3            # 영상 관절 신뢰도 이 아래는 '안 보임'
STEP_FRAMES = (0, 3, 6, 9)   # 이미지 묶음처럼 약 3프레임 간격 4장
JUDGES = ("algorithm", "model", "both")


def pose_feats(k, bbox):
    """관절(17×3, COCO) → 자세 특징. 어깨·엉덩이가 안 보이면 pose_ok=0 만."""
    k = np.asarray(k, float)
    h = max(bbox[3] - bbox[1], 1.0)
    ok = lambda i: k[i, 2] > 0
    out = {}
    sh = [i for i in (5, 6) if ok(i)]
    hp = [i for i in (11, 12) if ok(i)]
    if not sh or not hp:
        return {"pose_ok": 0.0}
    sy = k[sh, 1].mean(); hy = k[hp, 1].mean(); cx = k[sh + hp, 0].mean()
    tor = max(hy - sy, h * 0.15)
    wr = [(k[i, 0], k[i, 1]) for i in (9, 10) if ok(i)]
    el = [(k[i, 0], k[i, 1]) for i in (7, 8) if ok(i)]
    if wr:
        ys = sorted((y - sy) / tor for _, y in wr)          # 어깨=0, 엉덩이=1 (아래가 +)
        out["wr_hi"] = ys[0]; out["wr_lo"] = ys[-1]
        out["wr_spread"] = max(abs(x - cx) for x, _ in wr) / tor
        out["wr_above_sh"] = float(ys[0] < 0)
        out["wr_near_hip"] = float(min(abs(y - 1.0) for y in ys) < 0.35)
        if len(wr) == 2:
            out["wr_gap"] = math.hypot(wr[0][0] - wr[1][0], wr[0][1] - wr[1][1]) / tor
    if el:
        out["el_hi"] = min((y - sy) / tor for _, y in el)
    kn = [i for i in (13, 14) if ok(i)]; ak = [i for i in (15, 16) if ok(i)]
    if kn and ak:
        ky = k[kn, 1].mean(); ay = k[ak, 1].mean()
        out["leg_ratio"] = (ay - hy) / tor                    # 무릎 굽히면 작아짐
        out["knee_ratio"] = (ky - hy) / max(ay - hy, 1.0)
        out["stance_w"] = abs(k[ak, 0].max() - k[ak, 0].min()) / tor if len(ak) == 2 else 0.0
    out["lean"] = (k[sh, 0].mean() - k[hp, 0].mean()) / tor
    out["box_h"] = h
    out["pose_ok"] = 1.0
    return out


def player_feats(pl0: dict, seqs: list, sugg: dict) -> dict:
    """선수별 특징 (이미지 학습과 같은 이름).
    pl0 = 첫 장 {key: {bbox, kpts, court_pos, side}}, seqs = 장마다 같은 꼴 dict 목록(첫 장 포함),
    sugg = {"track_key": 알고리즘 추천 서버 key, "p_near": 서브 팀 확률, "front": {far: key, near: key}}"""
    feats = {}
    pn = sugg.get("p_near")
    for key, p in pl0.items():
        side = p["side"]
        x = {"near": float(side == "near")}
        cp = p.get("court_pos")
        mates = [q for t, q in pl0.items() if t != key and q["side"] == side]
        opp = [q for q in pl0.values() if q["side"] != side]
        if cp:
            dn = C.dist_to_net(np.array(cp, float))
            x["dnet"] = dn; x["d_ssl"] = dn - SSL; x["xc"] = abs(cp[0] - HALF_W)
            x["out_x"] = float(cp[0] < 0 or cp[0] > 2 * HALF_W)
            mcp = [q["court_pos"] for q in mates if q.get("court_pos")]
            if mcp:
                dm = C.dist_to_net(np.array(mcp[0], float))
                x["front"] = float(dn < dm); x["gap_mate"] = dm - dn; x["dx_mate"] = abs(cp[0] - mcp[0][0])
            ocp = [q["court_pos"] for q in opp if q.get("court_pos")]
            if ocp:
                of = min(ocp, key=lambda c: C.dist_to_net(np.array(c, float)))
                x["opp_front_dnet"] = C.dist_to_net(np.array(of, float))
                x["diag"] = float((cp[0] - HALF_W) * (of[0] - HALF_W) < 0)
                x["d_opp_front"] = math.hypot(cp[0] - of[0], cp[1] - of[1])
        x.update({k: v for k, v in pose_feats(p["kpts"], p["bbox"]).items() if k != "box_h"})
        seq = [q[key] for q in seqs if key in q]
        if len(seq) >= 2:
            cps = [q.get("court_pos") for q in seq]
            if all(cps):
                x["move"] = sum(math.dist(a, b) for a, b in zip(cps, cps[1:]))
            hs = [max(q["bbox"][3] - q["bbox"][1], 1) for q in seq]

            def wr_y(q):
                k = np.asarray(q["kpts"], float)
                w = [k[i, 1] for i in (9, 10) if k[i, 2] > 0]
                return min(w) if w else None
            ws = [wr_y(q) for q in seq]
            if all(v is not None for v in ws):
                x["wr_move"] = sum(abs(a - b) for a, b in zip(ws, ws[1:])) / np.mean(hs)
                x["wr_rise"] = (ws[0] - min(ws)) / np.mean(hs)
            his = [v["wr_hi"] for v in (pose_feats(q["kpts"], q["bbox"]) for q in seq) if "wr_hi" in v]
            if his:
                x["wr_hi_min"] = min(his); x["wr_hi_mean"] = float(np.mean(his))
        x["sugg"] = float(sugg.get("track_key") == key)
        if pn is not None:
            x["team_logit"] = (1 if side == "near" else -1) * math.log(max(pn, 1e-3) / max(1 - pn, 1e-3))
        x["sugg_front"] = float((sugg.get("front") or {}).get(side) == key)
        feats[key] = x
    return feats


# ---------------------------------------------------------------- 모델

@lru_cache(maxsize=2)
def _load(mtime: float):
    m = json.load(open(MODEL, encoding="utf-8"))
    return m["names"], np.array(m["mu"]), np.array(m["sd"]), np.array(m["w"]), m


def load():
    if not MODEL.exists():
        return None
    return _load(MODEL.stat().st_mtime)


def proba(feats: dict, order: list):
    """feats {key: {특징}} , order = 4자리 key 순서 → 자리별 서버 확률 (없는 자리는 0)"""
    md = load()
    if md is None:
        return None
    names, mu, sd, w, _ = md
    X = np.zeros((4, len(names) * 2)); M = np.zeros(4, bool)
    for j, key in enumerate(order):
        x = feats.get(key)
        if x is None:
            continue
        M[j] = True
        for k, n in enumerate(names):
            v = x.get(n)
            if v is not None and np.isfinite(v):
                X[j, k] = v; X[j, len(names) + k] = 1
    if not M.any():
        return None
    s = np.clip((X - mu) / sd, -6, 6) @ w
    s = np.where(M, s, -1e9)
    p = np.exp(s - s.max()); p /= p.sum()
    return p


# ---------------------------------------------------------------- 영상

def _frame_players(tr: dict, i: int) -> dict:
    out = {}
    for k, s in enumerate(tr["slots"]):
        s = str(s)
        if np.isnan(tr["pos"][i, k, 0]):
            continue
        kp = np.array(tr["kps"][i, k], float).copy()
        kp[kp[:, 2] < KP_MIN, 2] = 0.0
        out[s] = {"bbox": [float(v) for v in tr["box"][i, k]], "kpts": kp, "court_pos": [float(v) for v in tr["pos"][i, k]],
                  "side": "far" if s.startswith("far") else "near"}
    return out


def event_proba(ev: dict, tr: dict):
    """영상 서브 하나 → {p_near, server(slot), prob} (못 하면 None). 서브 준비 정지 시작 장(frame_still)부터 4장."""
    f0 = ev.get("frame_still", ev.get("frame"))
    if f0 is None or not len(tr["frames"]):
        return None
    fr = tr["frames"]
    idx = [int(np.clip(np.searchsorted(fr, f0 + d), 0, len(fr) - 1)) for d in STEP_FRAMES]
    seqs = [_frame_players(tr, i) for i in idx]
    pn = ev.get("p_near_alg", ev.get("p_near", 0.5))
    front = ev.get("front") or {}
    sugg = {"p_near": pn, "front": front, "track_key": front.get("near" if pn >= 0.5 else "far")}
    feats = player_feats(seqs[0], seqs, sugg)
    order = [str(s) for s in tr["slots"]]   # far0 far1 near0 near1 ↔ f1 f2 n1 n2
    p = proba(feats, order)
    if p is None:
        return None
    near = sum(p[j] for j, s in enumerate(order) if s.startswith("near"))
    j = int(p.argmax())
    return {"p_near": round(float(near), 3), "server": order[j], "prob": round(float(p[j]), 3)}


def combine(pa: float, pm: float) -> float:
    """알고리즘·모델: 같은 쪽이면 logit 을 더해 더 확신, 다르면 0.5 (판단 보류 → 점수 규칙·서브 위치가 정함)"""
    L = lambda p: math.log(max(p, 1e-3) / max(1 - p, 1e-3))
    if (pa >= 0.5) != (pm >= 0.5):
        return 0.5
    z = L(pa) + L(pm)
    return 1 / (1 + math.exp(-z))


def apply(events: list, judge: str, tr_loader) -> list:
    """events 의 p_near/box 를 판단 방법대로 바꾼다. 원래 알고리즘 값은 p_near_alg/box_alg 에 보관,
    모델 값은 p_near_model 에 한 번 계산해 둔다 (tr_loader() 는 추적 결과가 필요할 때만 부름)."""
    tr = None
    for e in events:
        if e.get("kind", "serve") != "serve" or e.get("start_mark"):
            continue
        if "p_near_alg" not in e and "p_near" in e:
            e["p_near_alg"] = e["p_near"]; e["box_alg"] = e.get("box")
        if judge in ("model", "both") and "p_near_model" not in e and "p_near_alg" in e:
            if tr is None:
                tr = tr_loader()
            r = event_proba(e, tr) if tr is not None else None
            e["p_near_model"] = r["p_near"] if r else None
            e["model_server"] = r["server"] if r else None
        pa, pm = e.get("p_near_alg"), e.get("p_near_model")
        if pa is None:
            continue
        p = pa if judge == "algorithm" or pm is None else pm if judge == "model" else combine(pa, pm)
        e["p_near"] = round(p, 3)
        bx = e.get("boxes") or {}
        if bx:   # 표시용 칸 = 리시버 쪽 판정 (analysis.find_serves 와 같은 규칙)
            e["box"] = bx["far"] if p >= 0.5 else bx["near"]
    return events

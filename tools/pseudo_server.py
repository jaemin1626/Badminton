"""이미지 서버 라벨(사람) → 나머지 서브 묶음 서버 가짜 라벨(pseudo label).

1) 특징: 서브 묶음마다 선수 4명(track f1 f2 n1 n2) 각각
     자리 — 쪽(near/far), 네트 거리, 센터라인 거리, 팀원보다 앞/뒤, 상대 앞사람과 대각선인지, 서비스 라인과 거리
     자세 — AI-Hub 관절(정답 좌표)로 손목·팔꿈치 높이(어깨·엉덩이 기준, 박스 키로 나눔), 팔 뻗음, 무릎 굽힘, 상체 기울기
     움직임 — 묶음 안 장 사이 발·손목 이동
     알고리즘 추천 — 이 선수가 추천 서버인지, 이 쪽이 서브 팀일 확률
2) 모델: 묶음 안 4명 중 하나를 고르는 소프트맥스(조건부 로짓), 같은 가중치를 4명에 적용. 작은 은닉층 1개(MLP) 버전도 비교.
   검증 = 촬영 묶음(날짜·기관)별로 하나씩 빼고 학습 → 뺀 묶음 맞히기 (같은 경기 장면끼리 새지 않게)
3) 결과: data/images/converted/serve_pseudo.jsonl  (사람 라벨 serve.jsonl 은 건드리지 않음)
     {clip, server_track, prob, probs{f1..n2}, team(near/far), team_prob, model, view}

  .venv/bin/python tools/pseudo_server.py            # 특징 뽑기(캐시) + 검증 + 가짜 라벨 쓰기
  .venv/bin/python tools/pseudo_server.py --eval     # 검증만
  .venv/bin/python tools/pseudo_server.py --save-model   # 앱 서브 팀 판단용 모델 저장 (app/assets/server_chooser.json)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CONV = ROOT / "data" / "images" / "converted"
CACHE = CONV / "pseudo_feats.json"
OUT = CONV / "serve_pseudo.jsonl"
TRACKS = ["f1", "f2", "n1", "n2"]
HALF_W, NET_Y, SSL = 6.1 / 2, 13.4 / 2, 1.98

# ---------------------------------------------------------------- 특징

def _pose(k, bbox):
    from app.server_model import pose_feats   # 영상 판단(app/server_model.py)과 같은 자세 특징
    return pose_feats(k, bbox)


def clip_feats(clip: str):
    import app.main  # noqa: F401  (순환 import 피하려고 먼저)
    from app import imglabel as IL
    from app import court as C
    d = IL.clip_detail(clip)
    frames = d["frames"]
    sg = d.get("suggest") or {}
    by_t = defaultdict(list)          # track → 장마다 선수
    for f in frames:
        for p in f["players"]:
            if p.get("track"):
                by_t[p["track"]].append((f, p))
    f0 = frames[0]
    pl0 = {p["track"]: p for p in f0["players"] if p.get("track")}
    feats = {}
    for t in TRACKS:
        if t not in pl0:
            continue
        p = pl0[t]
        x = {}
        side = p.get("side") or ("far" if t[0] == "f" else "near")
        x["near"] = float(side == "near")
        cp = p.get("court_pos")
        mates = [q for tt, q in pl0.items() if tt != t and tt[0] == t[0]]
        opp = [q for tt, q in pl0.items() if tt[0] != t[0]]
        if cp:
            dn = C.dist_to_net(np.array(cp, float))
            x["dnet"] = dn; x["d_ssl"] = dn - SSL; x["xc"] = abs(cp[0] - HALF_W)
            x["out_x"] = float(cp[0] < 0 or cp[0] > 2 * HALF_W)
            mcp = [q["court_pos"] for q in mates if q.get("court_pos")]
            if mcp:
                dm = C.dist_to_net(np.array(mcp[0], float))
                x["front"] = float(dn < dm); x["gap_mate"] = dm - dn
                x["dx_mate"] = abs(cp[0] - mcp[0][0])
            ocp = [q["court_pos"] for q in opp if q.get("court_pos")]
            if ocp:
                of = min(ocp, key=lambda c: C.dist_to_net(np.array(c, float)))
                x["opp_front_dnet"] = C.dist_to_net(np.array(of, float))
                # 대각선: 네트 건너 x 가 반대쪽(코트 좌표에서 같은 x 면 같은 줄 → 대각선은 x 가 센터라인 반대편)
                x["diag"] = float((cp[0] - HALF_W) * (of[0] - HALF_W) < 0)
                x["d_opp_front"] = math.hypot(cp[0] - of[0], cp[1] - of[1])
        x.update({k: v for k, v in _pose(p["kpts"], p["bbox"]).items() if k != "box_h"})
        # 장 사이 움직임
        seq = by_t[t]
        if len(seq) >= 2:
            cps = [q.get("court_pos") for _, q in seq]
            if all(cps):
                x["move"] = sum(math.dist(a, b) for a, b in zip(cps, cps[1:]))
            hs = [max(q["bbox"][3] - q["bbox"][1], 1) for _, q in seq]
            def wr_y(q):
                k = np.asarray(q["kpts"], float)
                w = [k[i, 1] for i in (9, 10) if k[i, 2] > 0]
                return min(w) if w else None
            ws = [wr_y(q) for _, q in seq]
            if all(v is not None for v in ws):
                x["wr_move"] = sum(abs(a - b) for a, b in zip(ws, ws[1:])) / np.mean(hs)
                x["wr_rise"] = (ws[0] - min(ws)) / np.mean(hs)
            pos = [_pose(q["kpts"], q["bbox"]) for _, q in seq]
            his = [v.get("wr_hi") for v in pos if "wr_hi" in v]
            if his:
                x["wr_hi_min"] = min(his); x["wr_hi_mean"] = float(np.mean(his))
        # 알고리즘 추천
        x["sugg"] = float(sg.get("track") == t)
        pn = sg.get("p_near")
        if pn is not None:
            x["team_logit"] = (1 if side == "near" else -1) * math.log(max(pn, 1e-3) / max(1 - pn, 1e-3))
        x["sugg_front"] = float((f0.get("suggest") or {}).get("front", {}).get(side) == p["pid"])
        feats[t] = x
    return {"clip": clip, "view": d["view"], "feats": feats, "sugg": sg.get("track"), "n": len(frames)}


def _safe(clip):
    try:
        return clip_feats(clip)
    except Exception as e:  # noqa: BLE001
        return {"clip": clip, "error": str(e)}


def build_cache(workers=12):
    serve = sorted({json.loads(l)["clip"] for l in open(CONV / "index.jsonl", encoding="utf-8")
                    if json.loads(l)["is_serve"]})
    have = {}
    if CACHE.exists():
        have = {r["clip"]: r for r in json.load(open(CACHE, encoding="utf-8"))}
    todo = [c for c in serve if c not in have]
    if todo:
        t0 = time.time()
        with ProcessPoolExecutor(workers) as ex:
            for i, r in enumerate(ex.map(_safe, todo, chunksize=8)):
                have[r["clip"]] = r
                if (i + 1) % 300 == 0:
                    print(f"  특징 {i + 1}/{len(todo)} ({time.time() - t0:.0f}초)", flush=True)
        json.dump(list(have.values()), open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return [have[c] for c in serve]


# ---------------------------------------------------------------- 모델 (4명 중 하나 고르기)

def to_arrays(rows, names=None):
    if names is None:
        names = sorted({k for r in rows for x in r["feats"].values() for k in x})
    X = np.zeros((len(rows), 4, len(names) * 2), np.float32)   # 값 + 있음 표시
    M = np.zeros((len(rows), 4), bool)
    for i, r in enumerate(rows):
        for j, t in enumerate(TRACKS):
            x = r["feats"].get(t)
            if x is None:
                continue
            M[i, j] = True
            for k, n in enumerate(names):
                if n in x and x[n] is not None and np.isfinite(x[n]):
                    X[i, j, k] = x[n]; X[i, j, len(names) + k] = 1
    return X, M, names


class Chooser:
    """점수 s(x) = MLP(x) (공유), 묶음 안 소프트맥스. hidden=0 이면 선형."""

    def __init__(self, hidden=0, l2=1e-2, lr=0.05, epochs=600, seed=0):
        self.h, self.l2, self.lr, self.ep, self.seed = hidden, l2, lr, epochs, seed

    def _norm(self, X):
        return np.clip((X - self.mu) / self.sd, -6, 6)

    def fit(self, X, M, y):
        F = X[M]
        self.mu, self.sd = F.mean(0), F.std(0) + 1e-6
        Z = self._norm(X)
        rng = np.random.default_rng(self.seed)
        d = Z.shape[2]
        if self.h:
            self.W1 = rng.normal(0, 1 / math.sqrt(d), (d, self.h)); self.b1 = np.zeros(self.h)
            self.w2 = rng.normal(0, 1 / math.sqrt(self.h), self.h)
        else:
            self.w = np.zeros(d)
        params = ["W1", "b1", "w2"] if self.h else ["w"]
        m = {p: 0 for p in params}; v = {p: 0 for p in params}
        Y = np.zeros(M.shape); Y[np.arange(len(y)), y] = 1
        for it in range(1, self.ep + 1):
            S, cache = self._score(Z)
            S = np.where(M, S, -1e9)
            P = np.exp(S - S.max(1, keepdims=True)); P /= P.sum(1, keepdims=True)
            G = (P - Y) / len(y)                          # dL/dS
            grads = self._back(Z, G * M, cache)
            for p in params:
                g = grads[p] + self.l2 * getattr(self, p) * (p != "b1")
                m[p] = 0.9 * m[p] + 0.1 * g; v[p] = 0.999 * v[p] + 0.001 * g * g
                setattr(self, p, getattr(self, p) - self.lr * (m[p] / (1 - 0.9 ** it)) / (np.sqrt(v[p] / (1 - 0.999 ** it)) + 1e-8))
        return self

    def _score(self, Z):
        if self.h:
            A = Z @ self.W1 + self.b1; Hh = np.maximum(A, 0)
            return Hh @ self.w2, (A, Hh)
        return Z @ self.w, None

    def _back(self, Z, G, cache):
        if self.h:
            A, Hh = cache
            gw2 = np.einsum("nj,njh->h", G, Hh)
            gA = G[..., None] * self.w2 * (A > 0)
            return {"W1": np.einsum("njd,njh->dh", Z, gA), "b1": gA.sum((0, 1)), "w2": gw2}
        return {"w": np.einsum("nj,njd->d", G, Z)}

    def proba(self, X, M):
        S, _ = self._score(self._norm(X))
        S = np.where(M, S, -1e9)
        P = np.exp(S - S.max(1, keepdims=True))
        return P / P.sum(1, keepdims=True)


def group_of(clip):
    p = clip.split("_")
    return p[1] + p[2]


def evaluate(rows, y, models):
    X, M, names = to_arrays(rows)
    g = np.array([group_of(r["clip"]) for r in rows])
    views = np.array([r["view"] for r in rows])
    res = {}
    for name, mk in models.items():
        P = np.zeros(M.shape)
        for gg in sorted(set(g)):
            te = g == gg
            P[te] = mk().fit(X[~te], M[~te], y[~te]).proba(X[te], M[te])
        res[name] = P
    sugg = np.array([TRACKS.index(r["sugg"]) if r["sugg"] in TRACKS else -1 for r in rows])
    print(f"\n검증 (촬영 묶음 {len(set(g))}개 하나씩 빼고 학습, 사람 라벨 {len(rows)}개)")
    print(f"  {'':14s} {'서버':>7s} {'서브 팀':>7s}  " + "  ".join(f"{v:>9s}" for v in ("뒤", "대각선")))
    team = lambda a: np.array([TRACKS[i][0] if i >= 0 else "?" for i in a])
    def line(name, pred):
        acc = (pred == y).mean(); tacc = (team(pred) == team(y)).mean()
        per = "  ".join(f"{(pred[views == v] == y[views == v]).mean() * 100:8.1f}%" for v in ("end", "diag"))
        print(f"  {name:14s} {acc * 100:6.1f}% {tacc * 100:6.1f}%  {per}")
    line("알고리즘 추천", sugg)
    for name, P in res.items():
        line(name, P.argmax(1))
    return res, names


def calib(P, y):
    """확신(가장 큰 확률) 구간별 정답률 → 가짜 라벨 문턱 고르기."""
    conf = P.max(1); ok = P.argmax(1) == y
    print("\n  확신 ≥   남는 비율   정답률")
    for th in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
        s = conf >= th
        if s.any():
            print(f"  {th:5.2f}   {s.mean() * 100:8.1f}%   {ok[s].mean() * 100:6.1f}%")


def save_model(workers=12):
    """앱(app/server_model.py)이 쓰는 모델 파일 app/assets/server_chooser.json 만들기 (선형)."""
    from app.server_model import MODEL
    rows = [r for r in build_cache(workers) if "error" not in r and r["feats"]]
    labs = {}
    for l in open(CONV / "serve.jsonl", encoding="utf-8"):
        r = json.loads(l); labs[r["clip"]] = r
    ok = lambda lb: lb and lb.get("status") == "serve" and not lb.get("bulk")
    lab_rows = [r for r in rows if ok(labs.get(r["clip"])) and labs[r["clip"]].get("server_track") in r["feats"]]
    y = np.array([TRACKS.index(labs[r["clip"]]["server_track"]) for r in lab_rows])
    X, M, names = to_arrays(lab_rows)
    m = Chooser(0, l2=3e-3, lr=0.05, epochs=500).fit(X, M, y)
    acc = float((m.proba(X, M).argmax(1) == y).mean())
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"names": names, "mu": m.mu.tolist(), "sd": m.sd.tolist(), "w": m.w.tolist(), "n_train": len(lab_rows),
               "train_acc": round(acc, 4), "kind": "linear conditional logit (4명 중 서버)", "at": time.strftime("%Y-%m-%dT%H:%M:%S")},
              open(MODEL, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"모델 저장 {MODEL} · 학습 {len(lab_rows)}개 · 학습 정확도 {acc:.1%}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", action="store_true")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--save-model", action="store_true", help="사람이 라벨링·확인한 것(한꺼번에 받아들인 것 제외)으로 학습해 앱 판단용 모델 저장")
    a = ap.parse_args()
    if a.save_model:
        return save_model(a.workers)
    rows = build_cache(a.workers)
    bad = [r for r in rows if "error" in r]
    rows = [r for r in rows if "error" not in r and r["feats"]]
    print(f"서브 묶음 {len(rows)}개 (특징 실패 {len(bad)})")
    labs = {}
    for l in open(CONV / "serve.jsonl", encoding="utf-8"):
        r = json.loads(l); labs[r["clip"]] = r
    lab_rows = [r for r in rows if labs.get(r["clip"], {}).get("status") == "serve" and labs[r["clip"]].get("server_track") in r["feats"]]
    y = np.array([TRACKS.index(labs[r["clip"]]["server_track"]) for r in lab_rows])
    models = {"선형": lambda: Chooser(0, l2=3e-3, lr=0.05, epochs=500),
              "MLP(16)": lambda: Chooser(16, l2=1e-2, lr=0.02, epochs=800)}
    res, names = evaluate(lab_rows, y, models)
    best = max(res, key=lambda k: (res[k].argmax(1) == y).mean())
    print(f"\n고른 모델: {best}"); calib(res[best], y)
    if a.eval:
        return
    # 사람 라벨 전부로 학습 → 라벨 없는 서브 묶음(+ '서브 아님' 아닌 것)에 가짜 라벨
    X, M, _ = to_arrays(lab_rows, names)
    mdl = models[best]().fit(X, M, y)
    rest = [r for r in rows if r["clip"] not in labs]
    Xr, Mr, _ = to_arrays(rest, names)
    P = mdl.proba(Xr, Mr)
    with open(OUT, "w", encoding="utf-8") as f:
        for r, p in zip(rest, P):
            i = int(p.argmax()); pt = p[2:].sum()
            f.write(json.dumps({"clip": r["clip"], "view": r["view"], "server_track": TRACKS[i], "prob": round(float(p[i]), 3),
                                "probs": {t: round(float(v), 3) for t, v in zip(TRACKS, p)},
                                "team": "near" if pt >= 0.5 else "far", "team_prob": round(float(max(pt, 1 - pt)), 3),
                                "sugg": r["sugg"], "model": best, "n_train": len(lab_rows),
                                "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False) + "\n")
    c = Counter(r["view"] for r in rest)
    conf = P.max(1)
    print(f"\n가짜 라벨 {len(rest)}개 → {OUT}  (시점 {dict(c)})")
    for th in (0.7, 0.8, 0.9):
        print(f"  확신 ≥ {th}: {(conf >= th).sum()}개")


if __name__ == "__main__":
    main()

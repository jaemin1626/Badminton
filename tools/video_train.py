"""영상 정답 라벨(data/labels/<영상>.json)로 서브 팀 판단을 다시 맞추기.

정답이 있는 영상마다 find_serves 로 서브 후보를 찾고, 정답 서브(3초 안, 1:1)와 짝지어
'이 서브는 가까운 쪽(near)이 넣었나'를 라벨로 쓴다 (코트 교대는 정답 점수 11점 규칙/설정 시각).

1) 알고리즘 : find_serves 의 서브 팀 logit = w_form·대형 + w_xc·센터라인 + w_pdx·팀원 좌우 + w_dnet·네트 거리
              + w_pose·자세 + w_onset·손목 먼저. 이 가중치(+치우침 b)를 로지스틱 회귀로 다시 맞춘다.
2) 모델     : 앱 서버 고르기 모델(4명 중 서버, app/assets/server_chooser.json)을
              AI-Hub 이미지 사람 라벨 + 영상 서브(서버 = 정답 팀 쪽 앞사람)로 다시 학습.
검증은 영상 하나씩 빼고 학습 → 뺀 영상에서 점수 계산까지 돌려 '점수 후 서버' 정답 수 (외운 것 말고 실제로 나아졌나).

  .venv/bin/python tools/video_train.py                       # 검증만 (지금 값 vs 다시 맞춘 값)
  .venv/bin/python tools/video_train.py --save                # 검증 + 알고리즘 가중치 저장 → app/assets/serve_weights.json
                                                              (analysis.Params 기본값 대신 씀)
  .venv/bin/python tools/video_train.py --save-model          # 모델도 이미지 + 영상으로 다시 학습해 저장 → app/assets/server_chooser.json
  --tracks 영상=경로.npz  : 그 영상은 이 추적 결과로 (예: 카메라 보정으로 다시 추적한 것)
  --videos a,b,c          : 이 영상들만 (정답과 설정이 안 맞는 영상은 빼기)
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import pickle
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
import app.main as M  # noqa: E402
from app import analysis as A, server_model as SM  # noqa: E402
import video_server_test as V  # noqa: E402

LABELS = ROOT / "data" / "labels"
WEIGHTS = ROOT / "app" / "assets" / "serve_weights.json"
FEATS = ["w_form", "w_xc", "w_pdx", "w_dnet", "w_pose", "w_onset"]


def alg_x(c: dict) -> list[float]:
    """서브 후보 cues → 알고리즘 logit 재료 (가까운 쪽이 서버일수록 +)"""
    q = c.get("cues") or {}
    st = q.get("stance") or {}
    f, n = st.get("far") or {}, st.get("near") or {}
    fm = q.get("formation") or {}
    on = q.get("onset")
    return [fm.get("near", 0) - fm.get("far", 0), f.get("xc", 0) - n.get("xc", 0), f.get("pdx", 0) - n.get("pdx", 0),
            f.get("dnet", 0) - n.get("dnet", 0), q.get("pose_near", 0) - q.get("pose_far", 0),
            1.0 if on == "near" else -1.0 if on == "far" else 0.0]


def videos(over: dict, only=None):
    out = []
    for p in sorted(LABELS.glob("*.json")):
        vid = p.stem
        if only and vid not in only:
            continue
        d = M.DATA / vid
        if not (d / "match.json").exists():
            continue
        trp = Path(over.get(vid) or d / "tracks.npz")
        if not trp.exists():
            continue
        out.append((vid, trp))
    return out


def build(over: dict, cache: Path, only=None):
    key = {v: str(p) + f"@{p.stat().st_mtime}" for v, p in videos(over, only)}
    key["code"] = (ROOT / "app" / "analysis.py").stat().st_mtime
    if cache.exists():
        z = pickle.load(open(cache, "rb"))
        if z["key"] == key:
            return z["data"]
    data = []
    for vid, trp in videos(over, only):
        d = M.DATA / vid
        cfg = json.load(open(d / "match.json")); setup, sides = M._setup_from(cfg)
        marks = V.truth(vid, {"setup": setup, "sides": sides})
        tr = A.load_tracks(trp)
        c = A.find_serves(tr, cfg.get("match", {}).get("mode", "doubles"))
        A.serve_looks(str(M.source_path(d)), tr, cfg, c)
        for i, x in enumerate(c):
            x["id"] = f"e{i:04d}"
        SM.apply(c, "algorithm", lambda: tr)     # p_near_alg 보관
        pairs = V.match_events(marks, c)
        rows = []
        for i, k in pairs:
            e = c[k]; side = marks[i]["side"]
            feats, order = SM.event_feats(e, tr)
            srv = (e.get("front") or {}).get(side)
            rows.append({"k": k, "near": side == "near", "x": alg_x(e), "feats": feats, "order": order,
                         "server": str(srv) if srv is not None else None})
        data.append({"vid": vid, "setup": setup, "sides": sides, "marks": marks, "cands": c, "rows": rows,
                     "tr": str(trp)})
        print(f"  {vid}: 후보 {len(c)} · 정답 {len(marks)} · 짝 {len(rows)}", flush=True)
    pickle.dump({"key": key, "data": data}, open(cache, "wb"))
    return data


# ---------------------------------------------------------------- 1) 알고리즘 가중치

def fit_logit(X, y, l2=0.3, iters=3000, lr=0.05, bias=False):
    """로지스틱 회귀. 치우침(bias)은 기본으로 안 씀: 이 영상들에서 어느 쪽이 서브를 많이 했는지일 뿐 새 영상에 안 통한다"""
    X = np.c_[X, np.ones(len(X))]
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) / len(y) + l2 * np.r_[w[:-1], 0] / len(y)
        if not bias:
            g[-1] = 0
        w -= lr * g * 10
    return w[:-1], w[-1]


def cur_w():
    P = A.Params()
    return np.array([getattr(P, f) for f in FEATS]), 0.0


def alg_p(c, w, b):
    z = float(np.dot(alg_x(c), w) + b)
    return 1 / (1 + math.exp(-max(min(z, 30), -30)))


# ---------------------------------------------------------------- 2) 모델

def img_rows():
    import pseudo_server as PS
    rows = [r for r in PS.build_cache(12) if "error" not in r and r["feats"]]
    labs = {}
    for l in open(PS.CONV / "serve.jsonl", encoding="utf-8"):
        r = json.loads(l); labs[r["clip"]] = r
    ok = lambda lb: lb and lb.get("status") == "serve" and not lb.get("bulk")
    rows = [r for r in rows if ok(labs.get(r["clip"])) and labs[r["clip"]].get("server_track") in r["feats"]]
    y = [PS.TRACKS.index(labs[r["clip"]]["server_track"]) for r in rows]
    return PS, rows, y


def vid_rows(PS, data, skip=None):
    rows, y = [], []
    for v in data:
        if v["vid"] == skip:
            continue
        for r in v["rows"]:
            if r["feats"] is None or r["server"] is None or r["server"] not in r["order"]:
                continue
            rows.append({"feats": {PS.TRACKS[j]: r["feats"][s] for j, s in enumerate(r["order"]) if s in r["feats"]}})
            y.append(r["order"].index(r["server"]))
    return rows, y


def train_model(PS, rows, y, names, vw=1, vrows=(), vy=()):
    """이미지 + 영상(vw 배로 반복) 으로 선형 모델 학습 → server_model 이 읽는 꼴 (names, mu, sd, w, meta)"""
    R = list(rows) + list(vrows) * vw; Y = np.array(list(y) + list(vy) * vw)
    X, Mk, _ = PS.to_arrays(R, names)
    m = PS.Chooser(0, l2=3e-3, lr=0.05, epochs=500).fit(X, Mk, Y)
    return names, m.mu, m.sd, m.w, {"n_img": len(rows), "n_vid": len(vrows), "vw": vw,
                                     "train_acc": float((m.proba(X, Mk).argmax(1) == Y).mean())}


# ---------------------------------------------------------------- 점수 계산까지

def end2end(v, judge, alg=None, model=None):
    """한 영상: (알고리즘 가중치, 모델) 로 서브 팀 판단 → 점수 계산 → 정답 서버 맞은 수"""
    c = copy.deepcopy(v["cands"])
    for e in c:
        if alg is not None and "cues" in e:
            e["p_near_alg"] = round(alg_p(e, *alg), 3)
        e.pop("p_near_model", None); e.pop("model_server", None)
    tr = A.load_tracks(v["tr"])
    old = SM.load
    if model is not None:
        SM.load = lambda: model
    try:
        SM.apply(c, judge, lambda: tr)
    finally:
        SM.load = old
    sc, sm = A.score_events(c, v["setup"], v["sides"])
    cnt = [e for e in sc if not e.get("removed") and not e.get("skipped") and e.get("kind", "serve") == "serve" and not e.get("start_mark")]
    pp = V.match_events(v["marks"], cnt)
    return sum(cnt[k].get("server") == v["marks"][i]["server"] for i, k in pp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true", help="알고리즘 가중치 저장 (app/assets/serve_weights.json)")
    ap.add_argument("--save-model", action="store_true", help="모델도 이미지 + 영상으로 다시 학습해 저장 (검증에서 나아질 때만 권함)")
    ap.add_argument("--tracks", action="append", default=[], help="영상=추적.npz")
    ap.add_argument("--vw", type=int, default=3, help="모델 학습 때 영상 서브를 몇 배로 셀지")
    ap.add_argument("--videos", default="", help="쓸 영상 (쉼표). 비우면 정답 있는 영상 전부")
    a = ap.parse_args()
    over = dict(s.split("=", 1) for s in a.tracks)
    print("서브 후보·정답 짝 만들기")
    only = set(filter(None, a.videos.split(",")))
    data = build(over, ROOT / "data" / "video_train_cache.pkl", only)   # 영상·추적·코드가 그대로면 다시 안 찾음
    vids = [v["vid"] for v in data]

    # ---- 알고리즘
    w0 = cur_w()
    print("\n[알고리즘] 서브마다 팀 (영상 하나 빼고 맞춘 가중치로 뺀 영상)")
    lovo = {}
    for v in data:
        tr_rows = [r for u in data if u["vid"] != v["vid"] for r in u["rows"]]
        X = np.array([r["x"] for r in tr_rows]); y = np.array([r["near"] for r in tr_rows], float)
        lovo[v["vid"]] = fit_logit(X, y)
        acc0 = np.mean([(alg_p(v["cands"][r["k"]], *w0) >= .5) == r["near"] for r in v["rows"]])
        acc1 = np.mean([(alg_p(v["cands"][r["k"]], *lovo[v["vid"]]) >= .5) == r["near"] for r in v["rows"]])
        print(f"  {v['vid']}: 지금 {acc0:.1%} → 다시 맞춤 {acc1:.1%}")
    Xa = np.array([r["x"] for u in data for r in u["rows"]]); ya = np.array([r["near"] for u in data for r in u["rows"]], float)
    w_all = fit_logit(Xa, ya)
    print("  지금 가중치   ", dict(zip(FEATS, np.round(w0[0], 2))))
    print("  전부로 맞춘 값", dict(zip(FEATS, np.round(w_all[0], 2))), "치우침", round(float(w_all[1]), 2))

    # ---- 모델
    PS, irows, iy = img_rows()
    names = json.load(open(SM.MODEL))["names"]
    cur_model = SM.load()
    print(f"\n[모델] 이미지 사람 라벨 {len(irows)}개 + 영상 서브 (영상 {a.vw}배)")
    models = {}
    for v in data:
        vr, vy = vid_rows(PS, data, skip=v["vid"])
        models[v["vid"]] = train_model(PS, irows, iy, names, a.vw, vr, vy)

    # ---- 점수 계산까지 (영상 하나 빼고)
    print("\n[점수 계산 후 서버 정답 수 · 영상 하나 빼고 학습]")
    head = ["알고리즘(지금)", "알고리즘(다시)", "모델(지금)", "모델(+영상)", "둘 다(지금)", "둘 다(다시)"]
    tot = np.zeros(len(head), int); n_all = 0
    print(f"  {'영상':16s} " + " ".join(f"{h:>14s}" for h in head))
    for v in data:
        r = [end2end(v, "algorithm"), end2end(v, "algorithm", alg=lovo[v["vid"]]),
             end2end(v, "model"), end2end(v, "model", alg=None, model=models[v["vid"]]),
             end2end(v, "both"), end2end(v, "both", alg=lovo[v["vid"]], model=models[v["vid"]])]
        n = len(v["marks"]); n_all += n; tot += r
        print(f"  {v['vid']:16s} " + " ".join(f"{x:>11d}/{n:<2d}" for x in r), flush=True)
    print(f"  {'합계':16s} " + " ".join(f"{x:>10d}/{n_all:<3d}" for x in tot))

    if a.save:
        WEIGHTS.write_text(json.dumps({**dict(zip(FEATS, [round(float(x), 4) for x in w_all[0]])), "bias": round(float(w_all[1]), 4),
                                       "videos": vids, "n": int(len(ya)), "at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n저장: {WEIGHTS.name} (알고리즘 서브 팀 가중치)")
    if a.save_model:
        vr, vy = vid_rows(PS, data)
        nm, mu, sd, w, meta = train_model(PS, irows, iy, names, a.vw, vr, vy)
        json.dump({"names": nm, "mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "n_train": meta["n_img"] + meta["n_vid"],
                   "n_img": meta["n_img"], "n_vid": meta["n_vid"], "vid_weight": a.vw, "videos": vids,
                   "train_acc": round(meta["train_acc"], 4), "kind": "linear conditional logit (4명 중 서버) · 이미지 + 영상",
                   "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, open(SM.MODEL, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"저장: {SM.MODEL.name} (모델, 이미지 {meta['n_img']} + 영상 {meta['n_vid']}×{a.vw})")


if __name__ == "__main__":
    main()

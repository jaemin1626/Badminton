"""이미지로 학습한 서버 고르기 모델(tools/pseudo_server.py)을 경기 영상에 넣어 보기 — 정답 라벨(data/labels/<영상>.json)과 비교.

영상 서브(result.json 의 서브)마다 서브 준비 시각 근처 장 4개(이미지 묶음처럼 약 3프레임 간격)에서
선수 4명(far0 far1 near0 near1)의 코트 위치·관절(자세 추정 결과)로 이미지 때와 같은 특징을 만들고 모델로 4명 중 서버를 고른다.
정답 라벨에는 서버 '팀'만 있어서 팀(near/far)으로 비교한다.

비교
  1) 서브마다 팀 맞힘: 알고리즘 p_near  vs  모델(알고리즘 추천 포함)  vs  모델(위치·자세만)
  2) 점수 계산까지: 사용자 수정(override)을 빼고 p_near 를 모델 값으로 바꿔 score_events 다시 → 서브마다 서버 팀이 정답과 같은지

  .venv/bin/python tools/video_server_test.py [영상 ...]   (기본: data/labels 에 정답 있는 영상 전부)
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import app.main  # noqa: E402,F401  (순환 import 피하려고 먼저)
from app import analysis as A  # noqa: E402
from app import court as C  # noqa: E402
import pseudo_server as PS  # noqa: E402

DATA = ROOT / "data"
SLOTS = ["far0", "far1", "near0", "near1"]          # 모델 자리 순서 f1 f2 n1 n2 에 대응
SUGG_KEYS = {"sugg", "team_logit", "sugg_front"}
KP_MIN = 0.3                                        # 이 신뢰도 아래 관절은 '안 보임'
MATCH_WIN = 3.0                                     # 정답 서브 시각과 영상 서브 시각 차이 허용(초)


# ---------------------------------------------------------------- 학습 (사람이 라벨링·확인한 것만, 한꺼번에 받아들인 것 제외)

def train():
    rows = [r for r in PS.build_cache() if "error" not in r and r["feats"]]
    labs = {}
    for l in open(PS.CONV / "serve.jsonl", encoding="utf-8"):
        r = json.loads(l); labs[r["clip"]] = r
    ok = lambda lb: lb and lb.get("status") == "serve" and not lb.get("bulk")
    lab_rows = [r for r in rows if ok(labs.get(r["clip"])) and labs[r["clip"]].get("server_track") in r["feats"]]
    y = np.array([PS.TRACKS.index(labs[r["clip"]]["server_track"]) for r in lab_rows])
    out = {}
    for name, drop in (("모델", set()), ("모델(위치·자세만)", SUGG_KEYS)):
        rr = [{**r, "feats": {t: {k: v for k, v in x.items() if k not in drop} for t, x in r["feats"].items()}} for r in lab_rows]
        X, M, names = PS.to_arrays(rr)
        out[name] = (PS.Chooser(0, l2=3e-3, lr=0.05, epochs=500).fit(X, M, y), names)
    return out, len(lab_rows)


# ---------------------------------------------------------------- 영상 특징

def load_players(vid):
    """players.csv → {frame: {slot: {bbox, kpts(17×3), court_pos}}}"""
    out = defaultdict(dict)
    with open(DATA / "videos" / vid / "players.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            k = [[float(r[f"kp{i}_x"] or 0), float(r[f"kp{i}_y"] or 0), float(r[f"kp{i}_c"] or 0)] for i in range(17)]
            k = [[x, y, (c if c >= KP_MIN else 0.0)] for x, y, c in k]
            cp = [float(r["court_x"]), float(r["court_y"])] if r["court_x"] not in ("", "nan") else None
            out[int(r["frame"])][r["slot"]] = {"bbox": [float(r[c]) for c in ("x1", "y1", "x2", "y2")], "kpts": k,
                                               "court_pos": cp, "side": r["side"], "occ": int(r["occluded"] or 0)}
    return out


def nearest(frames_sorted, f):
    i = int(np.searchsorted(frames_sorted, f))
    c = [frames_sorted[j] for j in (i - 1, i) if 0 <= j < len(frames_sorted)]
    return min(c, key=lambda x: abs(x - f))


def event_feats(ev, P, fr_sorted, anchor):
    """이미지 clip_feats 와 같은 특징 (자리별). anchor = 묶음 첫 장 프레임."""
    fs = [nearest(fr_sorted, anchor + d) for d in (0, 3, 6, 9)]
    seqs = [P[f] for f in fs]
    pl0 = seqs[0]
    pn = ev.get("p_near", 0.5)
    alg_side = "near" if pn >= 0.5 else "far"
    sugg_slot = (ev.get("front") or {}).get(alg_side)
    feats = {}
    for j, s in enumerate(SLOTS):
        p = pl0.get(s)
        if p is None or p["court_pos"] is None:
            continue
        side = "far" if s.startswith("far") else "near"
        x = {"near": float(side == "near")}
        cp = p["court_pos"]
        mates = [q for t, q in pl0.items() if t != s and t[:3] == s[:3] and q["court_pos"]]
        opp = [q for t, q in pl0.items() if t[:3] != s[:3] and q["court_pos"]]
        dn = C.dist_to_net(np.array(cp)); x["dnet"] = dn; x["d_ssl"] = dn - PS.SSL; x["xc"] = abs(cp[0] - PS.HALF_W)
        x["out_x"] = float(cp[0] < 0 or cp[0] > 2 * PS.HALF_W)
        if mates:
            mc = mates[0]["court_pos"]; dm = C.dist_to_net(np.array(mc))
            x["front"] = float(dn < dm); x["gap_mate"] = dm - dn; x["dx_mate"] = abs(cp[0] - mc[0])
        if opp:
            of = min((q["court_pos"] for q in opp), key=lambda c: C.dist_to_net(np.array(c)))
            x["opp_front_dnet"] = C.dist_to_net(np.array(of))
            x["diag"] = float((cp[0] - PS.HALF_W) * (of[0] - PS.HALF_W) < 0)
            x["d_opp_front"] = math.hypot(cp[0] - of[0], cp[1] - of[1])
        x.update({k: v for k, v in PS._pose(p["kpts"], p["bbox"]).items() if k != "box_h"})
        seq = [q[s] for q in seqs if s in q]
        if len(seq) >= 2:
            cps = [q["court_pos"] for q in seq]
            if all(cps):
                x["move"] = sum(math.dist(a, b) for a, b in zip(cps, cps[1:]))
            hs = [max(q["bbox"][3] - q["bbox"][1], 1) for q in seq]
            ws = [min([q["kpts"][i][1] for i in (9, 10) if q["kpts"][i][2] > 0], default=None) for q in seq]
            if all(v is not None for v in ws):
                x["wr_move"] = sum(abs(a - b) for a, b in zip(ws, ws[1:])) / np.mean(hs)
                x["wr_rise"] = (ws[0] - min(ws)) / np.mean(hs)
            his = [v["wr_hi"] for v in (PS._pose(q["kpts"], q["bbox"]) for q in seq) if "wr_hi" in v]
            if his:
                x["wr_hi_min"] = min(his); x["wr_hi_mean"] = float(np.mean(his))
        x["sugg"] = float(s == sugg_slot)
        x["team_logit"] = (1 if side == "near" else -1) * math.log(max(pn, 1e-3) / max(1 - pn, 1e-3))
        x["sugg_front"] = float((ev.get("front") or {}).get(side) == s)
        feats[PS.TRACKS[j]] = x
    return feats


def predict(models, feats):
    out = {}
    for name, (mdl, names) in models.items():
        X, M, _ = PS.to_arrays([{"feats": feats}], names)
        if not M.any():
            out[name] = None; continue
        p = mdl.proba(X, M)[0]
        out[name] = {"p_near": float(p[2:].sum()), "track": PS.TRACKS[int(p.argmax())], "prob": float(p.max())}
    return out


# ---------------------------------------------------------------- 정답

def truth(vid, res):
    lab = json.load(open(DATA / "labels" / f"{vid}.json", encoding="utf-8"))
    marks = sorted(lab["marks"], key=lambda m: m["t"])
    sw = sorted(res["setup"].get("switch_manual") or [])
    if not sw:   # 단판 21점: 한 팀이 11점이 되면 코트 교대 (정답 서버로 센 점수 기준)
        sc = {"A": 0, "B": 0}
        for j, m in enumerate(marks):
            if j:
                sc[m["server"]] += 1
            if max(sc.values()) >= 11:
                sw = [m["t"] - 0.01]; break
    s0 = res["sides"]
    out = []
    for m in marks:
        n = sum(1 for x in sw if x <= m["t"])
        side = s0[m["server"]] if n % 2 == 0 else ("near" if s0[m["server"]] == "far" else "far")
        out.append({**m, "side": side})
    return out


def match_events(marks, events):
    """정답 서브 ↔ 영상 서브 (시각이 가장 가까운 것, MATCH_WIN 안, 1:1)"""
    pairs, used = [], set()
    for i, m in sorted(enumerate(marks), key=lambda im: min((abs(e["t"] - im[1]["t"]) for e in events), default=9e9)):
        c = [(abs(e["t"] - m["t"]), j) for j, e in enumerate(events) if j not in used and abs(e["t"] - m["t"]) <= MATCH_WIN]
        if c:
            j = min(c)[1]; used.add(j); pairs.append((i, j))
    return sorted(pairs)


# ---------------------------------------------------------------- 실행

def run(vids):
    models, n_train = train()
    print(f"학습: 사람이 라벨링·확인한 이미지 묶음 {n_train}개\n")
    names = ["알고리즘"] + list(models)
    tot = defaultdict(lambda: [0, 0])
    for vid in vids:
        d = DATA / "videos" / vid
        res = json.load(open(d / "result.json", encoding="utf-8"))
        cfg = json.load(open(d / "match.json", encoding="utf-8"))
        P = load_players(vid); fr_sorted = sorted(P)
        marks = truth(vid, res)
        raw = [e for e in res["events"] if not e.get("removed")]
        pairs = match_events(marks, raw)
        print(f"== {vid}: 정답 서브 {len(marks)}, 영상 서브 {len(raw)}, 짝 {len(pairs)}")
        # 1) 서브마다 팀
        preds = {}
        for anchor_name in ("t_still", "t"):
            hit = defaultdict(int)
            for i, j in pairs:
                e = raw[j]; want = marks[i]["side"]
                f0 = e["frame_still"] if anchor_name == "t_still" else e["frame"]
                pr = predict(models, event_feats(e, P, fr_sorted, f0))
                if anchor_name == "t_still":
                    preds[j] = pr
                hit["알고리즘"] += ("near" if e.get("p_near", .5) >= .5 else "far") == want
                for k, v in pr.items():
                    hit[k] += v is not None and ("near" if v["p_near"] >= .5 else "far") == want
            print(f"  서브 팀 맞힘 (기준 장 {anchor_name}): " + " · ".join(f"{k} {hit[k]}/{len(pairs)}" for k in names))
            for k in names:
                tot[(anchor_name, k)][0] += hit[k]; tot[(anchor_name, k)][1] += len(pairs)
        # 틀린 것 자세히
        for i, j in pairs:
            e = raw[j]; want = marks[i]["side"]; pr = preds[j]
            a = "near" if e.get("p_near", .5) >= .5 else "far"
            m = "near" if pr["모델"] and pr["모델"]["p_near"] >= .5 else "far"
            if a != want or m != want:
                print(f"    {marks[i]['t']:7.2f}s 정답 {want:4s} | 알고리즘 {a:4s} p_near {e.get('p_near', .5):.2f} | 모델 {m:4s} p_near {pr['모델']['p_near']:.2f}"
                      f" | 위치·자세만 p_near {pr['모델(위치·자세만)']['p_near']:.2f}")
        # 2) 점수 계산까지
        setup, sides = app.main._setup_from(cfg)
        for k in names:
            evs = []
            for j, e in enumerate(res["events"]):
                e2 = {kk: vv for kk, vv in e.items() if kk not in ("override",)}
                if k != "알고리즘" and j in {res["events"].index(raw[jj]) for jj in preds} and not e.get("removed"):
                    jj = raw.index(e); v = preds[jj][k]
                    if v is not None:
                        e2["p_near"] = round(v["p_near"], 3)
                        bx = e.get("boxes") or {}
                        if bx:
                            e2["box"] = bx["near"] if v["p_near"] >= .5 else bx["far"]
                evs.append(e2)
            scored, summ = A.score_events(evs, setup, sides)
            live = [e for e in scored if not e.get("removed")]
            pp = match_events(marks, live)
            ok = sum(1 for i, j in pp if live[j].get("server") == marks[i]["server"])
            fin = summ.get("games")[0] if summ.get("games") else summ.get("score")
            print(f"  점수 계산 후 서버 팀 맞음 [{k}]: {ok}/{len(pp)}  최종 {fin}")
            tot[("점수", k)][0] += ok; tot[("점수", k)][1] += len(pp)
        print()
    print("== 합계")
    for a in ("t_still", "t", "점수"):
        lab = {"t_still": "서브 팀 (서브 준비 장 기준)", "t": "서브 팀 (서브 시각 장 기준)", "점수": "점수 계산 후 서버 팀"}[a]
        print(f"  {lab}: " + " · ".join(f"{k} {tot[(a, k)][0]}/{tot[(a, k)][1]} ({tot[(a, k)][0] / max(tot[(a, k)][1], 1):.1%})" for k in names))


if __name__ == "__main__":
    vs = sys.argv[1:] or sorted(p.stem for p in (DATA / "labels").glob("2*.json"))
    run(vs)

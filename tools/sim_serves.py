"""서브 검출 + 점수 엔진 합성 테스트 (영상 없이 추적 결과를 흉내 낸다).

    .venv/bin/python tools/sim_serves.py

복식 경기를 랠리 단위로 만들어 find_serves → score_events 를 돌리고
'서브를 몇 개 찾았나 / 서버 팀을 얼마나 맞혔나'를 시나리오별로 출력한다.

시나리오 (서브 준비 구간에서 팀원 상태)
  visible : 4명 모두 보임
  hidden  : 서버 팀원이 서버 뒤에 가려짐 (추적기가 '가려짐'으로 위치를 유지, occ=1)
  missing : 서버 팀원을 아예 놓침 (위치 없음)
  both    : 양 팀 팀원을 모두 놓침 (앞의 2명만 보임)
  mixed   : 서브마다 위 상황 중 하나를 무작위로
"""
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import analysis as A  # noqa: E402
from app import court as C  # noqa: E402

FPS = 15


def kp(rng, server: bool, raised: bool, noise: float):
    k = np.zeros((17, 3)); k[:, 2] = 0.8
    k[5] = [90, 100, .8]; k[6] = [110, 100, .8]; k[11] = [93, 160, .8]; k[12] = [107, 160, .8]
    if server:
        k[9] = [98, 140, .8]; k[10] = [104, 142, .8]
    elif raised:
        k[9] = [80, 130, .8]; k[10] = [125, 70, .8]
    else:
        k[9] = [80, 150, .8]; k[10] = [120, 150, .8]
    k[:, :2] += rng.normal(0, noise, (17, 2))
    return k


def run(seed: int, scenario: str, rounds: int = 30, noise: float = 8.0):
    random.seed(seed); rng = np.random.default_rng(seed)
    slots = ["far0", "far1", "near0", "near1"]   # 0 = 앞(서버/리시버), 1 = 팀원
    setup = dict(target=21, scoreA=0, scoreB=0, first="A"); sides = {"A": "far", "B": "near"}
    m = A.Match(setup, sides); m.started = True
    T, P, K, O = [], [], [], []
    clock = [0.0]

    def add(dur, pf, kf, hide=()):
        """hide: [(slot, 'hidden'|'missing')] 이 구간 동안 그 선수의 관측 상태."""
        n = int(dur * FPS)
        for i in range(n):
            a = i / n
            p = np.array(pf(a), np.float32); k = np.array(kf(a), np.float32); o = np.zeros(4, np.uint8)
            for j, how in hide:
                k[j] = 0
                if how == "hidden":
                    o[j] = 1
                else:
                    p[j] = np.nan
            T.append(clock[0]); P.append(p); K.append(k); O.append(o); clock[0] += 1 / FPS

    truth, prev_rest = [], None
    for r in range(rounds):
        if r:
            w = random.choice("AB"); m.point(w)
        if m.over:
            break
        server = m.server if r else "A"
        box = m.expected_box(server); sside = m.side[server]
        # far 선수 기준 오른쪽 = 화면 왼쪽
        fx = lambda side: (1.8 if box == "right" else 4.3) if side == "far" else (4.3 if box == "right" else 1.8)
        front = {"far": np.array([fx("far"), C.NET - 2.4]), "near": np.array([fx("near"), C.NET + 2.4])}
        mate = {}
        for side, sgn in (("far", -1), ("near", 1)):
            if side == sside:   # 서버 팀원: 서버 바로 뒤
                mate[side] = front[side] + [rng.uniform(-0.3, 0.3), sgn * rng.uniform(1.0, 1.6)]
            else:               # 리시버 팀원: 뒤쪽 아무 데나
                mate[side] = np.array([rng.uniform(1.5, 4.6), C.NET + sgn * rng.uniform(3.5, 5.0)])
        base = np.array([front["far"], mate["far"], front["near"], mate["near"]])
        truth.append(server)
        sk = [sside == "far", False, sside == "near", False]
        srv_mate = 1 if sside == "far" else 3
        how = random.choice(["visible", "hidden", "missing", "both"]) if scenario == "mixed" else scenario
        hide = {"visible": [], "hidden": [(srv_mate, "hidden")], "missing": [(srv_mate, "missing")],
                "both": [(1, "missing"), (3, "missing")]}[how]

        if prev_rest is not None:  # 걸어서 서브 위치로
            add(2.5, lambda a: prev_rest + (base - prev_rest) * a, lambda a: [kp(rng, 0, 0, noise)] * 4)
        poses = lambda: [kp(rng, sk[0], not sk[0], noise), kp(rng, 0, 0, noise),
                         kp(rng, sk[2], not sk[2], noise), kp(rng, 0, 0, noise)]
        add(2.0, lambda a: base + rng.normal(0, 0.03, (4, 2)), lambda a: poses(), hide)

        def swing(a):
            ks = poses()
            for j in (0, 2):
                if sk[j]:
                    ks[j][10] = [104 + 60 * a, 142 - 80 * a, .8]
            return ks
        add(0.6, lambda a: base + rng.normal(0, 0.03, (4, 2)), swing, hide)
        ph = rng.uniform(0, 6, (4, 2))
        add(6.0, lambda a: base + np.sin(a * 12 + ph) * 1.2, lambda a: [kp(rng, 0, 1, noise)] * 4)
        rest = np.c_[rng.uniform(0.5, 5.6, 4), np.array([2, 3.5, 10, 11.5]) + rng.uniform(-1, 1, 4)]
        add(1.5, lambda a: rest + rng.normal(0, 0.03, (4, 2)), lambda a: [kp(rng, 0, 0, noise)] * 4)
        prev_rest = rest

    T = np.array(T)
    tr = dict(frames=(T * 30).astype(np.int32), t=T, pos=np.array(P, np.float32),
              box=np.zeros((len(T), 4, 4)), conf=np.ones((len(T), 4)), kps=np.array(K, np.float32),
              occ=np.array(O, np.uint8), slots=np.array(slots), fps=30.0, step=2)
    dbg = {}
    cands = A.find_serves(tr, debug=dbg)
    res, _ = A.score_events(cands, setup, sides)
    json.dumps({"runs": dbg["runs"], "serves": res}, allow_nan=False)   # 화면으로 보낼 수 있어야 함 (NaN 금지)
    pred = [e["server"] for e in res]
    acc = sum(a == b for a, b in zip(pred, truth)) / len(truth)
    return len(cands), len(truth), acc


if __name__ == "__main__":
    for sc in ("visible", "hidden", "missing", "both", "mixed"):
        rs = [run(s, sc) for s in range(5)]
        found = sum(a for a, _, _ in rs); total = sum(b for _, b, _ in rs)
        print(f"{sc:8s} 서브 {found}/{total}  서버 정확도 {np.mean([x for _, _, x in rs]):.0%}  "
              f"(시드별 {[round(x, 2) for _, _, x in rs]})")

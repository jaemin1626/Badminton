"""분석 파이프라인.

1) track()          : Detector + Top-down Pose. 네트 기준 위/아래(far/near)별로 선수 슬롯 추적
2) find_serves()    : 4명 정지 구간 → 서브 대형 확인 → 서버 쪽(far/near) 단서 계산
3) score_events()   : 점수 상태머신 (랠리포인트, 짝/홀 위치 규칙, 게임 종료·코트 교대)

팀은 '네트 어느 쪽에 있는가'로 정한다. 같은 게임 안에서는 팀이 네트를 넘지 않으므로
슬롯은 위치(far/near) 기준으로 추적하고, 위치 → 팀 매핑은 점수 상태머신이 게임별로 정한다.
"""
from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from . import court as C

# ---------------------------------------------------------------- 파라미터
@dataclass
class Params:
    sample_fps: float = 15.0      # 분석 프레임레이트 (원본보다 크면 원본 사용)
    det_conf: float = 0.30
    batch: int = 8
    still_speed: float = 0.55     # m/s, 이보다 느리면 정지
    still_min: float = 0.6        # s, 4명 정지가 이만큼 지속되면 서브 후보
    merge_gap: float = 0.35       # s, 짧은 끊김은 하나의 정지 구간으로
    rally_speed: float = 1.6      # m/s, 서브 사이에 랠리(빠른 움직임)가 있었는지
    min_serve_gap: float = 3.5    # s, 서브 이벤트 최소 간격
    smooth: float = 0.45          # s, 위치 평활 창


def slots_for(mode: str):
    return ["far0", "far1", "near0", "near1"] if mode == "doubles" else ["far0", "near0"]


# ---------------------------------------------------------------- 1) 추적
def _core_penalty(xy) -> float:
    x, y = xy
    inside = -0.6 <= x <= C.W + 0.6 and -1.2 <= y <= C.L + 1.2
    return 0.0 if inside else 2.5


def track(video_path: str, cfg: dict, models, progress=None, params: Params = Params(), stop=None):
    """반환: dict(frames, t, pos[S,N,2], box[S,N,4], conf[S,N], kps[S,N,17,3], slots, fps, step)."""
    det, pose = models
    H = np.array(cfg["homography"], np.float64)
    mode = cfg.get("match", {}).get("mode", "doubles")
    slots = slots_for(mode)
    per_side = len(slots) // 2
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or cfg.get("fps", 30.0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, round(fps / params.sample_fps))

    # 슬롯 기본 위치: 설정 프레임에서 사용자가 고른 선수 위치
    default = {}
    for side in ("far", "near"):
        pts = []
        for tm in cfg.get("teams", {}).values():
            if tm.get("side") == side:
                pts += [tuple(p) for p in tm.get("court_pos", [])]
        pts = sorted(pts, key=lambda p: p[0])
        base_y = C.NET / 2 if side == "far" else C.NET * 1.5
        while len(pts) < per_side:
            pts.append((C.W * (len(pts) + 1) / (per_side + 1), base_y))
        for i in range(per_side):
            default[f"{side}{i}"] = np.array(pts[i], float)

    S_est = total // step + 2
    N = len(slots)
    frames = np.zeros(S_est, np.int32)
    pos = np.full((S_est, N, 2), np.nan, np.float32)
    box = np.full((S_est, N, 4), np.nan, np.float32)
    conf = np.zeros((S_est, N), np.float32)
    kps = np.zeros((S_est, N, 17, 3), np.float32)
    last = {s: (default[s], -10**9) for s in slots}

    def process(batch_imgs, batch_idx, s0):
        dets = det(batch_imgs, conf=params.det_conf)
        crops_img, crops_box, where = [], [], []
        for bi, (img, d) in enumerate(zip(batch_imgs, dets)):
            si = s0 + bi
            frames[si] = batch_idx[bi]
            if len(d):
                feet = np.array([[(b[0] + b[2]) / 2, b[3]] for b in d])
                cxy = C.to_court(H, feet)
            else:
                cxy = np.zeros((0, 2))
            for side in ("far", "near"):
                ss = [s for s in slots if s.startswith(side)]
                cand = [j for j in range(len(d)) if C.in_play(cxy[j]) and C.side_of(cxy[j][1]) == side]
                if not cand:
                    continue
                cost = np.zeros((len(ss), len(cand)))
                for a, s in enumerate(ss):
                    lp, ls = last[s]
                    recent = (si - ls) * step / fps < 2.0
                    ref = lp if recent else default[s]
                    for b, j in enumerate(cand):
                        dd = float(np.linalg.norm(cxy[j] - ref))
                        cost[a, b] = (dd if recent else 0.4 * dd) + _core_penalty(cxy[j]) + (1 - d[j, 4])
                r, c = linear_sum_assignment(cost)
                for a, b in zip(r, c):
                    if cost[a, b] > 5.0:
                        continue
                    j = cand[b]
                    k = slots.index(ss[a])
                    box[si, k] = d[j, :4]
                    conf[si, k] = d[j, 4]
                    pos[si, k] = cxy[j]
                    last[ss[a]] = (cxy[j], si)
                    where.append((si, k)); crops_img.append(img); crops_box.append(d[j, :4])
        # Top-down pose: 프레임별로 묶어서 실행
        by_img = {}
        for (si, k), img, b in zip(where, crops_img, crops_box):
            by_img.setdefault(si, (img, [], []))
            by_img[si][1].append(k); by_img[si][2].append(b)
        for si, (img, ks, bs) in by_img.items():
            kp = pose(img, np.array(bs))
            for k, kk in zip(ks, kp):
                kps[si, k] = kk
                # 발목이 믿을 만하면 발 위치 보정
                fx, fy = C.foot_point(box[si, k], kk)
                pos[si, k] = C.to_court(H, [[fx, fy]])[0]

    s = 0
    fidx = 0
    bimgs, bidx = [], []
    while True:
        if stop is not None and stop.is_set():
            raise InterruptedError("취소됨")
        if fidx % step == 0:
            ok, img = cap.read()
            if not ok:
                break
            bimgs.append(img); bidx.append(fidx)
            if len(bimgs) == params.batch:
                process(bimgs, bidx, s); s += len(bimgs); bimgs, bidx = [], []
                if progress:
                    progress(min(fidx / max(total, 1), 1.0), f"{fidx:,} / {total:,} 프레임")
        else:
            if not cap.grab():
                break
        fidx += 1
    if bimgs:
        process(bimgs, bidx, s); s += len(bimgs)
    cap.release()
    S = s
    return dict(frames=frames[:S], t=frames[:S] / fps, pos=pos[:S], box=box[:S], conf=conf[:S],
                kps=kps[:S], slots=np.array(slots), fps=np.float32(fps), step=np.int32(step))


def save_tracks(tr: dict, path: Path):
    np.savez_compressed(path, **tr)


def load_tracks(path: Path) -> dict:
    z = np.load(path, allow_pickle=False)
    return {k: z[k] for k in z.files}


def write_players_csv(tr: dict, path: Path):
    slots = list(tr["slots"])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        head = ["frame", "t", "slot", "side", "conf", "x1", "y1", "x2", "y2", "court_x", "court_y"]
        for k in range(17):
            head += [f"kp{k}_x", f"kp{k}_y", f"kp{k}_c"]
        w.writerow(head)
        for i in range(len(tr["frames"])):
            for k, s in enumerate(slots):
                if np.isnan(tr["pos"][i, k, 0]):
                    continue
                row = [int(tr["frames"][i]), round(float(tr["t"][i]), 3), s, s[:-1] if s[-1].isdigit() else s,
                       round(float(tr["conf"][i, k]), 3), *[round(float(v), 1) for v in tr["box"][i, k]],
                       round(float(tr["pos"][i, k, 0]), 3), round(float(tr["pos"][i, k, 1]), 3)]
                row += [round(float(v), 2) for v in tr["kps"][i, k].ravel()]
                w.writerow(row)


# ---------------------------------------------------------------- 2) 서브 후보
def _interp_smooth(pos: np.ndarray, t: np.ndarray, win: float, max_gap: float = 0.8):
    """[S,N,2] 결측 보간(짧은 구간만) + 이동평균."""
    out = pos.copy()
    S, N, _ = pos.shape
    dt = float(np.median(np.diff(t))) if len(t) > 1 else 1 / 15
    w = max(1, int(round(win / dt)))
    for k in range(N):
        for d in range(2):
            v = out[:, k, d]
            good = ~np.isnan(v)
            if good.sum() < 2:
                continue
            gi = np.flatnonzero(good)
            filled = np.interp(np.arange(S), gi, v[gi])
            # 너무 긴 결측은 NaN 유지
            nxt = np.searchsorted(gi, np.arange(S))
            prv = np.clip(nxt - 1, 0, len(gi) - 1)
            nxt = np.clip(nxt, 0, len(gi) - 1)
            gap = (t[gi[nxt]] - t[gi[prv]])
            filled[(~good) & (gap > max_gap)] = np.nan
            if w > 1:
                ker = np.ones(w) / w
                nan = np.isnan(filled)
                f0 = np.where(nan, 0, filled)
                num = np.convolve(f0, ker, "same"); den = np.convolve((~nan).astype(float), ker, "same")
                filled = np.where(nan | (den < 0.5), np.nan, num / np.maximum(den, 1e-9))
            out[:, k, d] = filled
    return out, dt


def _speed(p: np.ndarray, dt: float, lag: float = 0.4):
    L = max(1, int(round(lag / dt / 2)))
    v = np.full(p.shape[:2], np.nan, np.float32)
    v[L:-L] = np.linalg.norm(p[2 * L:] - p[:-2 * L], axis=-1) / (2 * L * dt)
    return v


def _runs(mask: np.ndarray):
    runs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append((start, i - 1)); start = None
    if start is not None:
        runs.append((start, len(mask) - 1))
    return runs


def _pose_serve_score(kp: np.ndarray) -> tuple[float, float]:
    """한 선수의 관절(17,3)로 '서브 자세' 점수와 신뢰도. 높을수록 서버 같다.

    서버: 셔틀을 든 손과 라켓 손이 허리 앞에서 모여 있음.
    리시버: 라켓을 어깨 위로 들고 대기하는 경우가 많음.
    """
    sh = kp[[5, 6]]; hp = kp[[11, 12]]; wr = kp[[9, 10]]
    c = float(min(sh[:, 2].mean(), hp[:, 2].mean(), wr[:, 2].mean()))
    if c < 0.2:
        return 0.0, 0.0
    msh, mhp = sh[:, :2].mean(0), hp[:, :2].mean(0)
    torso = float(np.linalg.norm(msh - mhp)) + 1e-6
    gap = float(np.linalg.norm(wr[0, :2] - wr[1, :2])) / torso
    raised = float(np.clip((msh[1] - wr[:, 1].min()) / torso, -1, 1.5))  # 손목이 어깨보다 위면 +
    low = float(np.clip((wr[:, 1].mean() - msh[1]) / torso, -1, 1.5))    # 손목이 어깨보다 아래면 +
    score = 1.2 * (0.9 - min(gap, 1.8)) + 0.8 * low - 1.5 * max(raised, 0)
    return score, c


def _wrist_onset(kps_k: np.ndarray, t: np.ndarray, i0: int, i1: int, thr: float = 2.5):
    """i0~i1 구간에서 손목이 몸통 대비 빠르게 움직이기 시작한 시각 (없으면 inf)."""
    for i in range(max(i0, 1), i1):
        a, b = kps_k[i - 1], kps_k[i]
        if min(a[[5, 6, 9, 10, 11, 12], 2].min(), b[[5, 6, 9, 10, 11, 12], 2].min()) < 0.2:
            continue
        torso = np.linalg.norm(a[[5, 6], :2].mean(0) - a[[11, 12], :2].mean(0)) + 1e-6
        ca, cb = a[[11, 12], :2].mean(0), b[[11, 12], :2].mean(0)
        d = max(np.linalg.norm((b[j, :2] - cb) - (a[j, :2] - ca)) for j in (9, 10)) / torso
        if d / max(t[i] - t[i - 1], 1e-3) > thr:
            return float(t[i])
    return math.inf


def find_serves(tr: dict, mode: str = "doubles", params: Params = Params()):
    """서브 후보 리스트. 각 후보: 시각, 서비스 코트(right/left), near 쪽이 서버일 확률 등."""
    t = tr["t"].astype(np.float64)
    if len(t) < 5:
        return []
    slots = list(tr["slots"])
    p, dt = _interp_smooth(tr["pos"].astype(np.float64), t, params.smooth)
    v = _speed(p, dt)
    all_present = ~np.isnan(v).any(1)
    vmax = np.where(all_present, np.nanmax(np.nan_to_num(v, nan=99), 1), np.inf)
    still = vmax < params.still_speed

    # 짧은 끊김 메우기
    gap = int(round(params.merge_gap / dt))
    runs = _runs(still)
    merged = []
    for a, b in runs:
        if merged and a - merged[-1][1] <= gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    runs = [(a, b) for a, b in merged if t[b] - t[a] >= params.still_min]

    far = [i for i, s in enumerate(slots) if s.startswith("far")]
    near = [i for i, s in enumerate(slots) if s.startswith("near")]
    vfast = np.nan_to_num(v, nan=0.0).max(1)
    fast = vfast > params.rally_speed
    cands = []
    for a, b in runs:
        # 서브 직후 2.5초 안에 랠리(빠른 움직임)가 시작돼야 서브다. 랠리 뒤 잠깐 멈춘 장면을 거른다.
        if not fast[b:min(len(t), b + int(2.5 / dt) + 1)].any():
            continue
        # 자세는 정지 구간 안쪽(끝 0.3초 전까지)에서 읽는다. 서브 동작이 섞이지 않게.
        tail = slice(max(a, b - int(1.0 / dt)), max(a + 1, b - int(0.3 / dt)))
        mp = np.nanmean(p[tail], 0)  # [N,2]
        if np.isnan(mp).any():
            continue
        fi = min(far, key=lambda k: C.dist_to_net(mp[k]))
        ni = min(near, key=lambda k: C.dist_to_net(mp[k]))
        reasons = []
        ok = True
        for k in (fi, ni):
            d = C.dist_to_net(mp[k])
            if not (C.SHORT - 0.7 <= d <= C.NET - C.LONG_DBL + 0.4) or not (-0.4 <= mp[k][0] <= C.W + 0.4):
                ok = False; reasons.append(f"{slots[k]} 서비스 코트 밖")
        bf, bn = C.service_box("far", mp[fi]), C.service_box("near", mp[ni])
        if bf != bn:
            ok = False; reasons.append("대각선 아님")
        if abs(mp[fi][0] - C.CENTER) < 0.25 or abs(mp[ni][0] - C.CENTER) < 0.25:
            ok = False; reasons.append("센터라인 위")
        if not ok:
            continue
        # 서버 쪽 단서 1: 자세
        sf = sn = 0.0; wf = wn = 0.0
        for i in range(tail.start, tail.stop):
            s1, c1 = _pose_serve_score(tr["kps"][i, fi]); sf += s1 * c1; wf += c1
            s2, c2 = _pose_serve_score(tr["kps"][i, ni]); sn += s2 * c2; wn += c2
        sf = sf / wf if wf else 0.0
        sn = sn / wn if wn else 0.0
        # 서버 쪽 단서 2: 정지가 끝날 때 먼저 손목을 움직인 사람
        e1 = min(len(t) - 1, b + int(0.8 / dt))
        of = _wrist_onset(tr["kps"][:, fi], t, b - int(0.2 / dt), e1)
        on = _wrist_onset(tr["kps"][:, ni], t, b - int(0.2 / dt), e1)
        onset = 0.0
        if math.isfinite(of) or math.isfinite(on):
            onset = 0.9 if on < of else -0.9
        logit = (sn - sf) + onset
        p_near = 1 / (1 + math.exp(-logit))
        cands.append(dict(
            i0=int(a), i1=int(b), t_still=float(t[a]), t=float(t[b]),
            frame=int(tr["frames"][b]), frame_still=int(tr["frames"][a]),
            box=bf, p_near=round(p_near, 3),
            front={"far": slots[fi], "near": slots[ni]},
            pos={s: [round(float(x), 2) for x in mp[k]] for k, s in enumerate(slots)},
            cues={"pose_far": round(sf, 2), "pose_near": round(sn, 2),
                  "onset": "near" if onset > 0 else ("far" if onset < 0 else None)},
        ))

    # 랠리 잠금: 앞 후보 뒤에 랠리가 없었으면 같은 서브 준비 → 뒤쪽 유지.
    # 랠리가 있었는데 너무 가까우면 랠리 중 멈춤 → 앞쪽 유지.
    out = []
    for c in cands:
        if out:
            prev = out[-1]
            moved = bool(fast[prev["i1"]:c["i0"]].any())
            if not moved:
                out[-1] = c
                continue
            if c["t_still"] - prev["t"] < params.min_serve_gap:
                continue
        out.append(c)
    for c in out:
        c.pop("i0"); c.pop("i1")
    return out


# ---------------------------------------------------------------- 3) 점수 상태머신
def game_over(a: int, b: int, target: int) -> bool:
    cap = 30 if target == 21 else 21 if target == 15 else target + 9
    hi, lo = max(a, b), min(a, b)
    return hi >= cap or (hi >= target and hi - lo >= 2)


class Match:
    """경기 상태. 팀 'A'/'B', 위치 'far'/'near'."""

    def __init__(self, s: dict, sides: dict):
        self.target = int(s.get("target", 21))
        self.games_to_win = 2
        self.score = {"A": int(s.get("scoreA", 0)), "B": int(s.get("scoreB", 0))}
        self.game = int(s.get("game", 1))
        self.games = []  # 끝난 게임 [{A,B,winner}]
        self.side = dict(sides)  # 팀 → 'far'/'near'
        self.switched_mid = False
        self.started = False
        self.server = s.get("first", "A")
        self.over = False

    def clone(self):
        m = Match.__new__(Match)
        m.__dict__ = {k: (v.copy() if isinstance(v, (dict, list)) else v) for k, v in self.__dict__.items()}
        return m

    def team_at(self, side: str) -> str:
        return "A" if self.side["A"] == side else "B"

    def point(self, winner: str):
        """winner가 랠리를 이김."""
        self.score[winner] += 1
        self.server = winner
        a, b = self.score["A"], self.score["B"]
        # 마지막 게임 11점 코트 교대
        if (self.game == 3 and not self.switched_mid and max(a, b) >= (11 if self.target == 21 else 8)):
            self._swap(); self.switched_mid = True
        if game_over(a, b, self.target):
            self.games.append({"A": a, "B": b, "winner": winner})
            wins = sum(g["winner"] == winner for g in self.games)
            if wins >= self.games_to_win:
                self.over = True
                return
            self.game += 1
            self.score = {"A": 0, "B": 0}
            self.switched_mid = False
            self._swap()

    def _swap(self):
        self.side = {"A": self.side["B"], "B": self.side["A"]}

    def expected_box(self, team: str) -> str:
        return "right" if self.score[team] % 2 == 0 else "left"


PARITY_PENALTY = 2.2   # 서브 위치가 점수 짝/홀과 다를 때 log-확률 감점
BEAM = 64


def _ev_loglik(ev: dict, mm: "Match", team: str) -> float:
    """mm(= team이 서브하는 상태)에서 이벤트 관측값의 log-가능도."""
    side = mm.side[team]
    pn = float(ev.get("p_near", 0.5))
    p_side = pn if side == "near" else 1 - pn
    lp = math.log(min(max(p_side, 0.02), 0.98))
    if ev.get("box") not in (None, mm.expected_box(team)):
        lp -= PARITY_PENALTY
    return lp


def _state_key(m: "Match"):
    return (m.score["A"], m.score["B"], m.game, m.server, m.side["A"], m.started, m.switched_mid,
            tuple((g["A"], g["B"]) for g in m.games))


def score_events(events: list, setup: dict, sides: dict):
    """events(시간순)에 점수를 매긴다.

    서버 팀 판단은 이벤트 하나씩이 아니라 경기 전체에서 가장 그럴듯한 흐름을 고른다(빔 서치).
    뒤쪽 서브 위치(짝/홀)가 앞쪽 판단을 바로잡을 수 있다.
    수동 수정(override, removed, kind='point')은 고정값으로 반영한다.

    event 필드: t, frame, box, p_near, [override: 'A'|'B'], [removed], [kind: 'serve'|'point']
    결과 필드:  server(팀), auto, conf, score{A,B}, game, games, side, flags[]
    """
    evs = sorted((dict(e) for e in events), key=lambda e: e["t"])
    active = [i for i, e in enumerate(evs) if not e.get("removed")]

    # ---- 빔 서치: 각 가설 = (logp, Match, choices)
    beam = [(0.0, Match(setup, sides), [])]
    for i in active:
        ev = evs[i]
        nxt = {}
        for lp, m, ch in beam:
            kind = ev.get("kind", "serve")
            if kind == "point":
                teams = [ev.get("override") or ev.get("winner") or "A"]
            elif not m.started:
                teams = [ev.get("override") or m.server]
            else:
                teams = [ev["override"]] if ev.get("override") else ["A", "B"]
            for team in teams:
                mm = m.clone()
                if kind == "point":
                    mm.point(team); mm.started = True; l2 = lp
                else:
                    if mm.started:
                        mm.point(team)
                    mm.started = True
                    mm.server = team
                    l2 = lp + (_ev_loglik(ev, mm, team) if not ev.get("override") else 0.0)
                k = _state_key(mm)
                if k not in nxt or nxt[k][0] < l2:
                    nxt[k] = (l2, mm, ch + [team])
        beam = sorted(nxt.values(), key=lambda x: -x[0])[:BEAM]

    best_lp, _, best = beam[0]
    # 이벤트별 신뢰도: 빔 확률 질량 중 최선 경로와 같은 선택의 비율
    mx = best_lp
    w = [math.exp(lp - mx) for lp, _, _ in beam]
    tot = sum(w)
    conf = []
    for j in range(len(active)):
        agree = sum(wi for wi, (_, _, ch) in zip(w, beam) if ch[j] == best[j])
        conf.append(agree / tot)

    # ---- 최선 경로 재생 → 점수/플래그 기록
    m = Match(setup, sides)
    choice = dict(zip(active, best))
    cmap = dict(zip(active, conf))
    out = []
    for i, ev in enumerate(evs):
        ev["flags"] = []
        if ev.get("removed"):
            ev.update(server=None, auto=None, conf=None, score=dict(m.score), game=m.game, games=list(m.games),
                      sides=dict(m.side))
            out.append(ev); continue
        if m.over:
            ev["flags"].append("경기 종료 후")
        team = choice[i]
        kind = ev.get("kind", "serve")
        if kind == "point":
            m.point(team); m.started = True
        else:
            if m.started:
                m.point(team)
            m.started = True
            m.server = team
            if ev.get("box") and ev["box"] != m.expected_box(team):
                ev["flags"].append("서브 위치가 점수 짝/홀과 다름")
        c = 1.0 if (ev.get("override") or kind == "point") else round(cmap[i], 3)
        if c < 0.75:
            ev["flags"].append("서버 판단 불확실")
        ev.update(server=team, auto=(None if ev.get("override") else team), conf=c,
                  score=dict(m.score), game=m.game, games=list(m.games), side=m.side[team], sides=dict(m.side))
        out.append(ev)
    summary = {"score": dict(m.score), "game": m.game, "games": m.games, "over": m.over}
    return out, summary

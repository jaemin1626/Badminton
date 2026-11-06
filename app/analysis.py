"""분석 파이프라인.

1) track()          : 검출 → 설정 프레임에서 지정한 선수·심판으로 앞뒤 추적 → 선수만 Pose
2) find_serves()    : 4명 정지 구간 → 서브 대형 확인 → 서버 쪽(far/near) 단서 계산
3) score_events()   : 점수 상태머신 (랠리포인트, 짝/홀 위치 규칙, 게임 종료·코트 교대)

팀은 '네트 어느 쪽에 있는가'로 정한다. 같은 게임 안에서는 팀이 네트를 넘지 않으므로
슬롯은 위치(far/near) 기준으로 추적하고, 위치 → 팀 매핑은 점수 상태머신이 게임별로 정한다.
"""
from __future__ import annotations

import csv
import json
import math
import warnings
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
    det_iou: float = 0.65         # 사람 NMS. 서브 때 앞뒤로 겹쳐 선 팀원이 지워지지 않게 0.5보다 높게
    batch: int = 8
    still_speed: float = 0.55     # m/s, 이보다 느리면 정지
    still_min: float = 0.3        # s, 정지가 이만큼 지속되면 서브 후보 (실제 서브 41개 기준 0.3~0.5초짜리가 많았다)
    merge_gap: float = 0.5        # s, 짧은 끊김은 하나의 정지 구간으로
    rally_speed: float = 1.6      # m/s, 서브 사이에 랠리(빠른 움직임)가 있었는지
    min_serve_gap: float = 3.5    # s, 서브 이벤트 최소 간격
    rally_window: float = 2.5     # s, 정지가 끝나고 이 안에 랠리가 시작돼야 서브
    box_front: float = 0.7        # m, 서비스 코트 앞쪽 여유 (숏 서비스 라인보다 네트 쪽으로)
    box_back: float = 0.4         # m, 서비스 코트 뒤쪽 여유 (복식 롱 서비스 라인보다 뒤로)
    require_diagonal: float = 0.0  # 1이면 서버·리시버가 대각선이어야 서브로 인정 (match.mp4에서 진짜 서브 9개를 버려서 기본은 끔)
    serve_lag: float = 1.4        # s, 서브 시각 = 정지가 끝난 때 − serve_lag (실제 서브는 정지 끝보다 평균 1.4초 앞)
    smooth: float = 0.45          # s, 위치 평활 창
    occ_max: float = 3.0          # s, '가려짐'(다른 사람 뒤에 숨음)으로 볼 최대 시간
    occ_overlap: float = 0.3      # 마지막 박스가 지금 검출 박스에 이만큼(자기 면적 대비) 덮이면 가려짐
    occ_reappear: float = 1.0     # m, 다시 나온 위치가 이보다 멀면 가려진 동안 움직인 것 → 추정 취소
    rally_min: float = 0.5        # s, 두 정지 구간 사이 빠른 움직임이 이보다 짧으면 랠리가 아니라 서브 준비 중 자리 잡기
    rear_drop: float = 0.0        # (실험 중 · 기본 끔) 1이면 팀원과 겹친 뒷사람 위치를 서브 판정에서 버리고 보간 (발 위치가 튀어 가짜 움직임이 생김)
    # 추적 후보: 발이 코트 안(약간의 여유)인 사람만
    court_side: float = 0.5       # m, 사이드라인 밖 허용
    court_end: float = 1.0        # m, 엔드라인 뒤 허용
    edge_px: int = 4              # 박스가 화면 가장자리에서 이만큼 안이면 '잘림' → 발 위치를 모르니 후보 제외
    max_speed: float = 7.0        # m/s, 한 샘플 사이 이동 한계 = max_speed × 지난 시간 + gate_noise
    gate_noise: float = 0.8       # m, 발 위치 오차 여유
    gate_max: float = 4.0         # m, 오래 놓쳐도 한 번에 이보다 멀리 건너뛰지 않음 (2초 넘게 놓치면 다시 찾기)
    off_radius: float = 1.0       # m, 지정한 심판 자리 주변은 항상 선수 후보에서 제외


def slots_for(mode: str):
    return ["far0", "far1", "near0", "near1"] if mode == "doubles" else ["far0", "near0"]


# ---------------------------------------------------------------- 1) 추적
def _iou(a, b) -> float:
    iw = min(a[2], b[2]) - max(a[0], b[0]); ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    i = iw * ih
    return float(i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9))


def _read_samples(cap, total: int, step: int, batch: int, stop=None):
    """샘플 프레임을 batch개씩 (이미지 목록, 프레임 번호 목록)으로 돌려준다."""
    fidx, imgs, idx = 0, [], []
    while True:
        if stop is not None and stop.is_set():
            raise InterruptedError("취소됨")
        if fidx % step == 0:
            ok, img = cap.read()
            if not ok:
                break
            imgs.append(img); idx.append(fidx)
            if len(imgs) == batch:
                yield imgs, idx
                imgs, idx = [], []
        elif not cap.grab():
            break
        fidx += 1
    if imgs:
        yield imgs, idx


def track(video_path: str, cfg: dict, models, progress=None, params: Params = Params(), stop=None, cache=None):
    """선수 추적. 반환: dict(frames, t, pos[S,N,2], box[S,N,4], conf[S,N], kps[S,N,17,3], occ[S,N],
    slots, fps, step, off_box[S,K,4]).

    1) 검출 패스  : 샘플 프레임마다 사람 검출 + 코트 근처 사람만 Pose. cache 경로를 주면 결과를 저장해 두고
                    다음부터는 영상을 다시 읽지 않는다 (매칭 규칙만 바꿔 다시 돌릴 때 수십 초).
    2) 매칭       : 설정 프레임(ref_frame)에서 사용자가 지정한 선수·심판 박스로 시작해
                    앞으로 한 번, 뒤로 한 번 추적한다. 심판 자리 사람은 선수 후보에서 뺀다.
    3) 발 위치    : 매칭된 선수는 발목 관절로 발 위치를 보정

    occ=1 은 '가려짐' 추정값: 직접 보이지 않지만 마지막 박스가 다른 사람 박스에 덮여 있어
    그 자리에 그대로 서 있다고 본 것 (예: 복식 서브 때 서버 뒤에 선 팀원).
    """
    det, pose = models
    H = np.array(cfg["homography"], np.float64)
    mode = cfg.get("match", {}).get("mode", "doubles")
    slots = slots_for(mode)
    per_side = len(slots) // 2
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or cfg.get("fps", 30.0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, round(fps / params.sample_fps))
    prog = progress or (lambda p, m: None)

    # ---- 설정 프레임에서 지정한 선수(슬롯)·심판 박스
    init_box, default = {}, {}
    for side in ("far", "near"):
        pl = []
        for tm in cfg.get("teams", {}).values():
            if tm.get("side") == side:
                pl += list(zip([tuple(p) for p in tm.get("court_pos", [])], tm.get("bboxes", [])))
        pl.sort(key=lambda p: p[0][0])
        base_y = C.NET / 2 if side == "far" else C.NET * 1.5
        for i in range(per_side):
            s = f"{side}{i}"
            if i < len(pl):
                default[s] = np.array(pl[i][0], float); init_box[s] = np.array(pl[i][1], float)
            else:
                default[s] = np.array((C.W * (i + 1) / (per_side + 1), base_y), float)
    officials = [o for o in cfg.get("officials", []) if o.get("bbox")]
    K = len(officials)

    # ---- 1) 검출 패스 (+ 코트 근처 사람 Pose). 같은 영상·같은 검출 설정이면 저장해 둔 결과를 쓴다
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    key = {"total": total, "step": step, "det_conf": params.det_conf, "det_iou": params.det_iou, "size": [fw, fh], "v": 1}
    data = None
    if cache is not None:
        try:
            z = np.load(cache, allow_pickle=False)
            if json.loads(str(z["key"])) == key:
                data = {k: z[k] for k in ("frames", "det", "det_si", "kp", "posed")}
        except Exception:  # noqa: BLE001  (없거나 깨졌으면 새로 만든다)
            data = None
    if data is None:
        frames_l, det_l, si_l, kp_l, posed_l = [], [], [], [], []
        si = 0
        for imgs, idx in _read_samples(cap, total, step, params.batch, stop):
            ds = det(imgs, conf=params.det_conf, iou=params.det_iou)
            # Pose는 코트 근처(넉넉히)에 발이 있는 사람만 (관중석 사람까지 돌리면 느리다). 묶음 전체를 한 번에 추론
            nears = []
            for d in ds:
                cxy = C.to_court(H, np.c_[(d[:, 0] + d[:, 2]) / 2, d[:, 3]]) if len(d) else np.zeros((0, 2))
                nears.append([j for j in range(len(d)) if C.in_play(cxy[j])])
            kps_b = pose.multi([(img, d[nr]) for img, d, nr in zip(imgs, ds, nears)])
            for d, nr, kb in zip(ds, nears, kps_b):
                kp = np.zeros((len(d), 17, 3), np.float32); posed = np.zeros(len(d), bool)
                if nr:
                    kp[nr] = kb; posed[nr] = True
                det_l.append(d[:, :5]); si_l.append(np.full(len(d), si, np.int32)); kp_l.append(kp); posed_l.append(posed)
                si += 1
            frames_l += idx
            prog(0.95 * min(idx[-1] / max(total, 1), 1.0), f"사람 찾기 · 자세 추정 {idx[-1]:,} / {total:,} 프레임")
        data = {"frames": np.array(frames_l, np.int32),
                "det": np.concatenate(det_l) if det_l else np.zeros((0, 5), np.float32),
                "det_si": np.concatenate(si_l) if si_l else np.zeros(0, np.int32),
                "kp": np.concatenate(kp_l).astype(np.float16) if kp_l else np.zeros((0, 17, 3), np.float16),
                "posed": np.concatenate(posed_l) if posed_l else np.zeros(0, bool)}
        if cache is not None:
            np.savez_compressed(cache, key=json.dumps(key), **data)
    else:
        prog(0.9, "저장해 둔 검출 결과를 씀 (영상 다시 읽지 않음)")
    cap.release()
    frames = list(data["frames"])
    starts = np.searchsorted(data["det_si"], np.arange(len(frames) + 1))
    dets = []
    for si in range(len(frames)):
        d = data["det"][starts[si]:starts[si + 1]]
        cxy = C.to_court(H, np.c_[(d[:, 0] + d[:, 2]) / 2, d[:, 3]]) if len(d) else np.zeros((0, 2))
        dets.append((d, cxy))
    S, N = len(frames), len(slots)
    frames = np.array(frames, np.int32)
    pos = np.full((S, N, 2), np.nan, np.float32)
    box = np.full((S, N, 4), np.nan, np.float32)
    conf = np.zeros((S, N), np.float32)
    kps = np.zeros((S, N, 17, 3), np.float32)
    occ = np.zeros((S, N), np.uint8)
    src = np.full((S, N), -1, np.int64)          # 가려짐 추정값이 어느 샘플 위치를 복사했나
    jidx = np.full((S, N), -1, np.int64)         # 매칭된 검출 번호 (샘플 안에서)
    off_box = np.full((S, K, 4), np.nan, np.float32)
    if S == 0:
        return dict(frames=frames, t=frames / fps, pos=pos, box=box, conf=conf, kps=kps, occ=occ,
                    slots=np.array(slots), fps=np.float32(fps), step=np.int32(step), off_box=off_box)

    ref = int(np.clip(round(int(cfg.get("ref_frame", 0)) / step), 0, S - 1))
    occ_n = max(1, int(round(params.occ_max * fps / step)))
    gap_n = max(1, int(round(2.0 * fps / step)))

    # ---- 2) 매칭: ref에서 앞으로, ref-1에서 뒤로
    dt_s = step / fps
    off_fixed = [np.array(o["court_pos"], float) if o.get("court_pos") else
                 C.to_court(H, [[(o["bbox"][0] + o["bbox"][2]) / 2, o["bbox"][3]]])[0] for o in officials]

    def in_court(xy) -> bool:
        x, y = xy
        return -params.court_side <= x <= C.W + params.court_side and -params.court_end <= y <= C.L + params.court_end

    def outside(xy) -> float:   # 코트 라인 밖으로 나간 거리 (m, 안이면 0)
        x, y = xy
        return max(0.0, -x, x - C.W) + max(0.0, -y, y - C.L)

    def cut(b) -> bool:   # 화면 가장자리에서 잘린 박스: 발 위치를 알 수 없다
        e = params.edge_px
        return b[0] <= e or b[2] >= fw - e or b[3] >= fh - e

    def run(order):
        last = {s: (default[s], ref) for s in slots}         # 마지막 위치(추정 포함), 샘플
        seen = {s: (ref, default[s], init_box[s]) if s in init_box else None for s in slots}
        for si in order:
            d, cxy = dets[si]
            used = set()
            # (a) 심판: 지정한 자리 주변(off_radius)에서만 찾는다. 기준 자리는 옮기지 않는다
            #     (마지막 위치를 따라가게 하면 옆을 지나간 선수에게 심판이 옮겨 가 버린다)
            for k, (fp, ob) in enumerate(zip(off_fixed, (np.array(o["bbox"], float) for o in officials))):
                best, bc = None, 1e9
                for j in range(len(d)):
                    if j in used:
                        continue
                    dd = float(np.linalg.norm(cxy[j] - fp)); ov = _iou(ob, d[j])
                    if dd < params.off_radius or ov > 0.4:
                        c = dd - 2 * ov
                        if c < bc:
                            best, bc = j, c
                if best is not None:
                    used.add(best); off_box[si, k] = d[best, :4]
            near_off = lambda j: any(np.linalg.norm(cxy[j] - fp) < params.off_radius for fp in off_fixed)
            # (b) 설정 프레임: 지정한 박스와 가장 많이 겹치는 검출을 그대로 쓴다
            if si == ref:
                for s, ib in init_box.items():
                    ov = [(_iou(ib, d[j]), j) for j in range(len(d)) if j not in used]
                    if ov and max(ov)[0] > 0.3:
                        j = max(ov)[1]; k = slots.index(s); used.add(j)
                        box[si, k] = d[j, :4]; conf[si, k] = d[j, 4]; pos[si, k] = cxy[j]; jidx[si, k] = j
                        last[s] = (cxy[j], si); seen[s] = (si, cxy[j].copy(), d[j, :4].copy())
            # (c) 나머지 슬롯: 쪽마다 헝가리안
            for side in ("far", "near"):
                ss = [s for s in slots if s.startswith(side) and np.isnan(box[si, slots.index(s), 0])]
                # 후보: 발이 코트 안(여유 포함)이고, 화면에서 잘리지 않았고, 심판 자리가 아닌 사람
                cand = [j for j in range(len(d)) if j not in used and not near_off(j) and not cut(d[j])
                        and in_court(cxy[j]) and C.side_of(cxy[j][1]) == side]
                if not ss or not cand:
                    continue
                cost = np.zeros((len(ss), len(cand)))
                for a, s in enumerate(ss):
                    lp, ls = last[s]
                    # 라인 밖에 머물던 칸은 '놓친 상태'로 보고 다시 찾는다 (라인 옆에 가만히 선 사람에게 계속 붙는 것 방지)
                    recent = abs(si - ls) <= gap_n and outside(lp) < 0.1
                    ref_p = lp if recent else default[s]
                    # 지난 시간 동안 사람이 갈 수 있는 거리 안에서만 잇는다 (2초 넘게 놓쳤으면 코트 안 누구든 다시 찾기)
                    gate = min(params.max_speed * dt_s * max(1, abs(si - ls)) + params.gate_noise, params.gate_max)
                    for b, j in enumerate(cand):
                        dd = float(np.linalg.norm(cxy[j] - ref_p))
                        if recent and dd > gate:
                            cost[a, b] = 1e6
                        else:
                            cost[a, b] = (dd if recent else 0.4 * dd) + (1 - d[j, 4]) + 3.0 * outside(cxy[j])
                r, c = linear_sum_assignment(cost)
                for a, b in zip(r, c):
                    if cost[a, b] >= 1e6:
                        continue
                    j = cand[b]; k = slots.index(ss[a]); used.add(j)
                    box[si, k] = d[j, :4]; conf[si, k] = d[j, 4]; pos[si, k] = cxy[j]; jidx[si, k] = j
                    last[ss[a]] = (cxy[j], si); seen[ss[a]] = (si, cxy[j].copy(), d[j, :4].copy())
            # (d) 못 찾은 선수: 마지막 박스가 지금 누군가의 박스에 덮여 있으면 '가려짐'
            for k, sl in enumerate(slots):
                if not np.isnan(box[si, k, 0]) or seen[sl] is None or not len(d):
                    continue
                s_seen, p_seen, b_seen = seen[sl]
                if abs(si - s_seen) > occ_n:
                    continue
                if max(_covered(b_seen, b) for b in d[:, :4]) >= params.occ_overlap:
                    pos[si, k] = p_seen; box[si, k] = b_seen; occ[si, k] = 1; src[si, k] = s_seen
                    last[sl] = (p_seen, si)

    run(range(ref, S))
    run(range(ref - 1, -1, -1))
    prog(0.62, "선수 매칭 완료")

    # ---- 3) 발 위치: 매칭된 선수는 1)에서 구한 관절로 발목 기준 보정
    for si, k in zip(*np.nonzero(jidx >= 0)):
        g = starts[si] + jidx[si, k]
        if occ[si, k] == 0 and data["posed"][g]:
            kk = data["kp"][g].astype(np.float32)
            kps[si, k] = kk
            fx, fy = C.foot_point(box[si, k], kk)
            pos[si, k] = C.to_court(H, [[fx, fy]])[0]
    prog(1.0, "추적 완료")
    # 가려짐 추정 위치도 발목 보정이 끝난 위치로 맞춘다 (경계에서 가짜 속도가 생기지 않게)
    for s_i, k in zip(*np.nonzero(occ)):
        if src[s_i, k] >= 0:
            pos[s_i, k] = pos[src[s_i, k], k]
    _check_reappear(pos, box, occ, params.occ_reappear)
    return dict(frames=frames, t=frames / fps, pos=pos, box=box, conf=conf, kps=kps, occ=occ,
                slots=np.array(slots), fps=np.float32(fps), step=np.int32(step), off_box=off_box)


def rear_overlap(tr: dict, overlap: float) -> np.ndarray:
    """[S,N] 같은 쪽 팀원과 박스가 겹친 샘플 중 카메라에서 더 먼 사람(가려지는 사람).

    카메라는 near 쪽 끝(y > 13.4) 뒤에 있으므로 코트 y가 작은 사람이 더 멀다:
    far 쪽은 네트에서 먼 사람, near 쪽은 네트에 가까운 사람. 이 사람은 다리가 앞사람에 가려져 박스 아래쪽이나 발목을 앞사람 것으로 읽기 쉽다 → 발 위치가 프레임마다
    1~1.5 m씩 튀어 가짜 속도가 생긴다. 서브 판정에서는 이 샘플 위치를 버리고 앞뒤 값으로 보간한다.
    """
    box, pos, occ = tr["box"], tr["pos"], tr["occ"]
    S, N = occ.shape
    side = [str(s).rstrip("0123456789") for s in tr["slots"]]
    out = np.zeros((S, N), bool)
    for k in range(N):
        for j in range(k + 1, N):
            if side[j] != side[k]:
                continue
            for i in np.flatnonzero(~np.isnan(box[:, k, 0]) & ~np.isnan(box[:, j, 0])):
                if max(_covered(box[i, k], box[i, j]), _covered(box[i, j], box[i, k])) < overlap:
                    continue
                if np.isnan(pos[i, k, 0]) or np.isnan(pos[i, j, 0]):
                    continue
                rear = k if pos[i, k, 1] < pos[i, j, 1] else j
                out[i, rear] = True
    return out & (occ == 0)


def _covered(a, b) -> float:
    """박스 a 면적 중 박스 b에 덮인 비율."""
    iw = min(a[2], b[2]) - max(a[0], b[0])
    ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    return float(iw * ih / max((a[2] - a[0]) * (a[3] - a[1]), 1e-6))


def _check_reappear(pos, box, occ, max_move: float):
    """가려짐 구간 뒤에 다시 나온 위치가 멀면, 가려진 동안 움직인 것이므로 추정값을 지운다."""
    S, N = occ.shape
    for k in range(N):
        for a, b in _runs(occ[:, k] == 1):
            # 앞뒤 추적 모두 지원: 양쪽 이웃 중 하나라도 멀리 있으면 그 사이에 움직인 것
            for nb in (a - 1, b + 1):
                if 0 <= nb < S and not np.isnan(pos[nb, k, 0]) and np.linalg.norm(pos[nb, k] - pos[a, k]) > max_move:
                    pos[a:b + 1, k] = np.nan; box[a:b + 1, k] = np.nan; occ[a:b + 1, k] = 0
                    break


def save_tracks(tr: dict, path: Path):
    np.savez_compressed(path, **tr)


def load_tracks(path: Path) -> dict:
    z = np.load(path, allow_pickle=False)
    return {k: z[k] for k in z.files}


def write_players_csv(tr: dict, path: Path):
    slots = list(tr["slots"])
    occ = tr.get("occ", np.zeros(tr["pos"].shape[:2], np.uint8))
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        head = ["frame", "t", "slot", "side", "occluded", "conf", "x1", "y1", "x2", "y2", "court_x", "court_y"]
        for k in range(17):
            head += [f"kp{k}_x", f"kp{k}_y", f"kp{k}_c"]
        w.writerow(head)
        for i in range(len(tr["frames"])):
            for k, s in enumerate(slots):
                if np.isnan(tr["pos"][i, k, 0]):
                    continue
                row = [int(tr["frames"][i]), round(float(tr["t"][i]), 3), s, s[:-1] if s[-1].isdigit() else s,
                       int(occ[i, k]), round(float(tr["conf"][i, k]), 3), *[round(float(v), 1) for v in tr["box"][i, k]],
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


def _behind_score(mp, ks, front, occ_tail) -> float:
    """앞사람 바로 뒤에 팀원이 서 있는 정도 (0~1). 팀원이 앞사람에게 가려졌으면 1."""
    others = [k for k in ks if k != front]
    if not others:
        return 0.0
    k = others[0]
    if occ_tail[:, k].mean() >= 0.5:
        return 1.0
    dx = abs(mp[k][0] - mp[front][0])
    dd = C.dist_to_net(mp[k]) - C.dist_to_net(mp[front])
    return float(np.clip(1.2 - dx, 0, 1) * np.clip(dd / 1.0, 0, 1))


def _live_checks(p, v, known, still, t, far, near, params) -> dict:
    """매 샘플마다 서브 조건(A 정지 · B 대형)을 검사한 값. 실험 페이지에서 '지금 왜 서브가 아닌지' 보여 주는 용도.

    서브 판정(find_serves)은 정지 구간 끝쪽 평균 위치로 B를 보지만, 여기서는 그 순간 위치로 본다.
    """
    S = len(t)
    vv = np.where(known, v, -1.0)
    fast_k = vv.argmax(1)
    fast_v = vv.max(1)
    # 지금까지 정지가 이어진 시간
    run_s = np.zeros(S)
    for i in range(1, S):
        run_s[i] = run_s[i - 1] + (t[i] - t[i - 1]) if still[i] and still[i - 1] else 0.0
    lo, hi = C.SHORT - params.box_front, C.NET - C.LONG_DBL + params.box_back
    front = np.full((S, 2), -1, int)
    dist = np.full((S, 2), np.nan)
    box = [[None, None] for _ in range(S)]
    for i in range(S):
        for j, (side, ks) in enumerate((("far", far), ("near", near))):
            kk = [k for k in ks if not np.isnan(p[i, k, 0])]
            if not kk:
                continue
            k = min(kk, key=lambda k: C.dist_to_net(p[i, k]))
            front[i, j] = k
            dist[i, j] = C.dist_to_net(p[i, k])
            box[i][j] = C.service_box(side, p[i, k])
    in_box = (dist >= lo) & (dist <= hi)
    xs = np.array([[p[i, front[i, j], 0] if front[i, j] >= 0 else np.nan for j in range(2)] for i in range(S)])
    return dict(fast_k=fast_k, fast_v=fast_v, run_s=run_s, front=front, dist=dist, box=box,
                in_box=in_box, x=xs, box_range=(lo, hi))


def find_serves(tr: dict, mode: str = "doubles", params: Params = Params(), debug: dict | None = None):
    """서브 후보 리스트. 각 후보: 시각, 서비스 코트(right/left), near 쪽이 서버일 확률 등.

    debug에 dict를 주면 실험 페이지용 정보를 채운다:
      v[S,N] 선수별 속도, still[S] 정지 여부, runs = 모든 정지 구간과 통과/탈락 이유
    """
    t = tr["t"].astype(np.float64)
    if len(t) < 5:
        return []
    log = [] if debug is not None else None

    def note(a, b, stage, reason, **kw):
        if log is not None:
            log.append(dict(i0=int(a), i1=int(b), t0=float(t[a]), t1=float(t[b]), stage=stage, reason=reason, **kw))
    slots = list(tr["slots"])
    p, dt = _interp_smooth(tr["pos"].astype(np.float64), t, params.smooth)
    if params.rear_drop >= 0.5:   # 속도(정지 판단)만: 팀원과 겹친 뒷사람의 튀는 발 위치를 빼고 보간한 위치로 잰다
        raw = tr["pos"].astype(np.float64).copy(); raw[rear_overlap(tr, params.occ_overlap)] = np.nan
        v = _speed(_interp_smooth(raw, t, params.smooth)[0], dt)
    else:
        v = _speed(p, dt)
    occ = tr.get("occ")
    occ = np.zeros(p.shape[:2], bool) if occ is None else occ.astype(bool)
    far = [i for i, s in enumerate(slots) if s.startswith("far")]
    near = [i for i, s in enumerate(slots) if s.startswith("near")]
    # 정지: 위치를 아는 사람(직접 보임 + 가려짐 추정)은 모두 느려야 하고, 양쪽에 최소 1명씩은 있어야 한다.
    # 위치를 모르는 사람은 판단에서 빼되, 서브마다 '몇 명을 봤는지'로 신뢰도를 낮춘다.
    known = ~np.isnan(v)
    calm = np.where(known, v < params.still_speed, True).all(1)
    still = calm & known[:, far].any(1) & known[:, near].any(1)

    # 짧은 끊김 메우기
    gap = int(round(params.merge_gap / dt))
    runs = _runs(still)
    merged = []
    for a, b in runs:
        if merged and a - merged[-1][1] <= gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    for a, b in merged:
        if 0.3 <= t[b] - t[a] < params.still_min:
            note(a, b, "A", f"정지 {t[b] - t[a]:.1f}초 (기준 {params.still_min}초 미만)")
    runs = [(a, b) for a, b in merged if t[b] - t[a] >= params.still_min]
    if debug is not None:
        debug.update(p=p, v=v, still=still, known=known, live=_live_checks(p, v, known, still, t, far, near, params))

    vfast = np.nan_to_num(v, nan=0.0).max(1)
    fast = vfast > params.rally_speed
    cands = []
    for a, b in runs:
        # 서브 직후 2.5초 안에 랠리(빠른 움직임)가 시작돼야 서브다. 랠리 뒤 잠깐 멈춘 장면을 거른다.
        if not fast[b:min(len(t), b + int(params.rally_window / dt) + 1)].any():
            note(a, b, "C", f"끝나고 {params.rally_window}초 안에 랠리 없음")
            continue
        # 자세는 정지 구간 안쪽(끝 0.3초 전까지)에서 읽는다. 서브 동작이 섞이지 않게.
        tail = slice(max(a, b - int(1.0 / dt)), max(a + 1, b - int(0.3 / dt)))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # 모르는 선수는 NaN
            mp = np.nanmean(p[tail], 0)  # [N,2]
        kn = ~np.isnan(mp[:, 0])
        kf, kn_ = [k for k in far if kn[k]], [k for k in near if kn[k]]
        if not kf or not kn_:
            note(a, b, "B", "한쪽 코트 선수 위치를 모름")
            continue
        # 앞사람(서버/리시버) = 각 쪽에서 네트에 가장 가까운 사람. 슬롯 번호와 무관.
        fi = min(kf, key=lambda k: C.dist_to_net(mp[k]))
        ni = min(kn_, key=lambda k: C.dist_to_net(mp[k]))
        # 몇 명을 봤나: 직접 보임 / 가려짐 추정 / 모름
        vis = [k for k in range(len(slots)) if kn[k] and occ[tail, k].mean() < 0.5]
        hid = [k for k in range(len(slots)) if kn[k] and k not in vis]
        n_all = len(slots)
        if len(vis) == n_all:
            view = 1.0
        elif len(vis) + len(hid) == n_all:
            view = 0.8
        elif len(vis) + len(hid) == n_all - 1:
            view = 0.6
        else:
            view = 0.35
        reasons = []
        ok = True
        for k in (fi, ni):
            d = C.dist_to_net(mp[k])
            if (not (C.SHORT - params.box_front <= d <= C.NET - C.LONG_DBL + params.box_back)
                    or not (-0.4 <= mp[k][0] <= C.W + 0.4)):
                ok = False; reasons.append(f"{slots[k]} 서비스 코트 밖 (네트에서 {d:.2f} m)")
        bf, bn = C.service_box("far", mp[fi]), C.service_box("near", mp[ni])
        if bf != bn and params.require_diagonal >= 0.5:
            ok = False; reasons.append("대각선 아님")
        if not ok:
            note(a, b, "B", " · ".join(reasons), front={"far": slots[fi], "near": slots[ni]},
                 pos={s_: [round(float(x), 2) for x in mp[k]] for k, s_ in enumerate(slots) if kn[k]})
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
        # 서버 쪽 단서 3 (복식): 대형. 서브하는 팀은 팀원이 서버 바로 뒤에 선다(가려지기도 함).
        form = {"far": _behind_score(mp, kf, fi, occ[tail]), "near": _behind_score(mp, kn_, ni, occ[tail])}
        formation = 0.5 * (form["near"] - form["far"])
        logit = (sn - sf) + onset + formation
        p_near = 1 / (1 + math.exp(-logit))
        cands.append(dict(
            # 서브 시각: 정지가 끝난 때보다 serve_lag 앞 (단, 정지 시작보다 앞으로는 가지 않음)
            i0=int(a), i1=int(b), t_still=float(t[a]), t=float(max(t[a], t[b] - params.serve_lag)), t_end=float(t[b]),
            frame=int(round(max(t[a], t[b] - params.serve_lag) * float(tr["fps"]))), frame_still=int(tr["frames"][a]),
            # 좌우(서비스 코트): 양쪽 앞사람 각각의 판정. 점수 계산은 리시버 쪽 값을 쓴다
            # (서버는 혼복 등에서 센터라인 근처·먼 곳 어디서든 서므로 리시버가 더 믿을 만하다).
            boxes={"far": bf, "near": bn},
            box=bf if bf == bn else (bf if p_near >= 0.5 else bn), p_near=round(p_near, 3), view=view,
            seen={"visible": [slots[k] for k in vis], "hidden": [slots[k] for k in hid]},
            front={"far": slots[fi], "near": slots[ni]},
            pos={s: [round(float(x), 2) for x in mp[k]] for k, s in enumerate(slots) if kn[k]},  # 모르는 선수(NaN)는 뺀다
            cues={"pose_far": round(sf, 2), "pose_near": round(sn, 2),
                  "onset": "near" if onset > 0 else ("far" if onset < 0 else None),
                  "formation": {k: round(v_, 2) for k, v_ in form.items()}},
        ))

    # 랠리 잠금: 앞 후보 뒤에 랠리가 없었으면 같은 서브 준비 → 뒤쪽 유지.
    # 랠리가 있었는데 너무 가까우면 랠리 중 멈춤 → 앞쪽 유지.
    out = []
    for c in cands:
        if out:
            prev = out[-1]
            # 사이 랠리: 빠른 움직임이 rally_min초 이상 있어야 랠리로 본다 (자리 잡으며 한두 발 움직인 건 랠리 아님)
            moved = float(fast[prev["i1"]:c["i0"]].sum()) * dt >= params.rally_min
            if not moved:
                note(prev["i0"], prev["i1"], "C", f"사이에 랠리 없이 {c['t_still']:.1f}초에 다시 멈춤 → 뒤쪽 정지로 대체",
                     **{k: prev[k] for k in ("box", "boxes", "p_near", "view", "cues", "front")})
                out[-1] = c
                continue
            if c["t_still"] - prev["t_end"] < params.min_serve_gap:
                note(c["i0"], c["i1"], "C", f"직전 서브와 {c['t_still'] - prev['t_end']:.1f}초 (기준 {params.min_serve_gap}초) → 랠리 중 멈춤",
                     **{k: c[k] for k in ("box", "boxes", "p_near", "view", "cues", "front")})
                continue
        out.append(c)
    for c in out:
        note(c["i0"], c["i1"], "OK", "서브", **{k: c[k] for k in ("box", "boxes", "p_near", "view", "cues", "front", "seen", "pos")})
    for c in out:
        c.pop("i0"); c.pop("i1")
    if debug is not None:
        debug["runs"] = sorted(log, key=lambda r: r["t0"])
    return out


# ---------------------------------------------------------------- 3) 점수 상태머신
# 게임 규칙. deuce=False면 target 점수를 먼저 내면 끝, True면 2점 차(최대 cap).
# switch_at: 마지막 게임(단판이면 그 게임)에서 한쪽이 이 점수에 먼저 닿으면 코트 교대.
RULES = {
    21: dict(deuce=True, cap=30, games_to_win=2, switch_at=11),   # 21점 · 3판 2선승 · 3게임 11점 교대
    15: dict(deuce=True, cap=21, games_to_win=2, switch_at=8),
    25: dict(deuce=False, cap=25, games_to_win=1, switch_at=13),  # 25점 단판 · 듀스 없음 · 13점 교대
}


def rules_for(target: int, s: dict | None = None) -> dict:
    r = dict(RULES.get(int(target), dict(deuce=True, cap=int(target) + 9, games_to_win=2, switch_at=(int(target) + 1) // 2)))
    for k in r:   # 설정에서 바꿀 수 있게 (예: {"deuce": true})
        if s and k in s:
            r[k] = type(r[k])(s[k])
    return r


def game_over(a: int, b: int, target: int, rules: dict | None = None) -> bool:
    r = rules or rules_for(target)
    hi, lo = max(a, b), min(a, b)
    if not r["deuce"]:
        return hi >= target
    return hi >= r["cap"] or (hi >= target and hi - lo >= 2)


class Match:
    """경기 상태. 팀 'A'/'B', 위치 'far'/'near'."""

    def __init__(self, s: dict, sides: dict):
        self.target = int(s.get("target", 21))
        self.rules = rules_for(self.target, s)
        self.games_to_win = self.rules["games_to_win"]
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
        # 마지막 게임(단판이면 그 게임) 중간 코트 교대: 21점 11점, 15점 8점, 25점 13점
        last_game = 2 * self.games_to_win - 1
        if self.game == last_game and not self.switched_mid and max(a, b) >= self.rules["switch_at"]:
            self._swap(); self.switched_mid = True
        if game_over(a, b, self.target, self.rules):
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


def _ev_box(ev: dict, side: str):
    """서버가 side 쪽일 때 관측한 서브 위치 = 리시버(반대쪽 앞사람) 판정. 옛 이벤트는 box 하나."""
    bx = ev.get("boxes")
    if bx:
        return bx.get("far" if side == "near" else "near")
    return ev.get("box")


def _ev_loglik(ev: dict, mm: "Match", team: str) -> float:
    """mm(= team이 서브하는 상태)에서 이벤트 관측값의 log-가능도."""
    side = mm.side[team]
    view = float(ev.get("view", 1.0))  # 서브 때 선수를 몇 명이나 봤나 (1=4명 모두)
    pn = 0.5 + (float(ev.get("p_near", 0.5)) - 0.5) * view
    p_side = pn if side == "near" else 1 - pn
    lp = math.log(min(max(p_side, 0.02), 0.98))
    if _ev_box(ev, side) not in (None, mm.expected_box(team)):
        lp -= PARITY_PENALTY * (1.0 if view >= 0.6 else 0.5)
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
            ob = _ev_box(ev, m.side[team])
            if ob:
                ev["box"] = ob
            if ob and ob != m.expected_box(team):
                ev["flags"].append("서브 위치가 점수 짝/홀과 다름")
        c = 1.0 if (ev.get("override") or kind == "point") else round(cmap[i], 3)
        if c < 0.75:
            ev["flags"].append("서버 판단 불확실")
        if kind != "point" and not ev.get("override") and ev.get("view", 1.0) < 0.6:
            ev["flags"].append("서브 때 선수가 일부 안 보임")
        ev.update(server=team, auto=(None if ev.get("override") else team), conf=c,
                  score=dict(m.score), game=m.game, games=list(m.games), side=m.side[team], sides=dict(m.side))
        out.append(ev)
    # ---- 랠리별 득점 팀: 랠리 포인트라 다음 서브를 넣은 팀이 그 랠리를 이긴 팀
    # won = 득점 팀, won_conf = 그 판단의 신뢰도(다음 서브의 서버 판단 신뢰도), won_at = 판단 근거가 된 다음 서브 시각,
    # score_after = 그 랠리 뒤 점수. 마지막 랠리는 다음 서브가 없어 won=None.
    live = [e for e in out if not e.get("removed")]
    for e, nx in zip(live, live[1:] + [None]):
        if e.get("kind", "serve") == "point":
            e.update(won=e["server"], won_conf=1.0, won_at=e["t"], score_after=dict(e["score"]))
        elif nx is None:
            # 마지막 랠리: 다음 서브가 없어 직접은 모른다. 한 팀만 게임 포인트면 그 팀이 이겨 경기가 끝난 것으로 본다
            ends = []
            for tm in ("A", "B"):
                mm = m.clone(); mm.point(tm)
                if mm.over or mm.game != m.game:
                    ends.append(tm)
            if len(ends) == 1 and not m.over:
                g = m.clone(); g.point(ends[0])
                sc = g.games[-1] if g.games else g.score
                e.update(won=ends[0], won_conf=None, won_guess=True, won_at=None, score_after={"A": sc["A"], "B": sc["B"]})
                m = g
            else:
                e.update(won=None, won_conf=None, won_at=None, score_after=None)
        else:
            e.update(won=nx["server"], won_conf=nx["conf"], won_at=nx["t"], score_after=dict(nx["score"]))
    last = live[-1] if live else None
    summary = {"score": dict(m.score), "game": m.game, "games": m.games, "over": m.over,
               "rallies": len(live), "last_rally": None if not last else ("known" if last.get("kind") == "point" else
                                                                         "guess" if last.get("won_guess") else "unknown")}
    if m.over and m.games:   # 경기가 끝났으면 마지막 게임 점수를 보여 준다
        summary["score"] = {"A": m.games[-1]["A"], "B": m.games[-1]["B"]}
    return out, summary

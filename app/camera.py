"""카메라가 중간에 움직였을 때(누가 쳐서 돌아감 등) 찾아서 구간마다 코트 위치를 자동으로 다시 맞춘다.

1) 움직임 찾기 : 0.5초마다 바로 앞 장면과 비교해 화면 전체가 몇 px 밀렸는지 잰다 (위상 상관).
                 선수만 움직이면 거의 0, 카메라가 돌아가면 벽·바닥이 한꺼번에 밀린다.
                 MOVE_PX 넘게 밀린 칸이 이어지고 합이 MIN_TOTAL_PX 넘으면 '카메라 움직임'.
2) 다시 맞추기 : 움직임 사이의 조용한 구간마다 대표 장면 하나를 골라, 설정 장면(ref_frame)과
                 바닥에 있는 특징점끼리 짝을 짓는다 (SIFT). 바닥은 평평해서 짝들은 화면→화면 변환
                 하나로 설명되고, 맞지 않는 짝(사람·그림자)은 RANSAC 으로 버린다.
                 처음 코트(h_court2px)에 그 변환을 곱하면 그 구간의 코트 위치.
3) 확인       : 다시 맞춘 코트 라인이 실제 흰 라인 위에 얼마나 놓이는지(line_score)를 같이 남긴다.

결과 camera.json = {"moves": [{t0, t1, shift_px}], "segments": [{f0, f1, frame, h_court2px, homography,
                     inliers, line_score, via}], "key": {...}}
분석(analysis.track)은 샘플 프레임마다 그 구간의 homography 로 발 위치를 코트 좌표로 바꾼다.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from . import court as C

STEP_S = 0.5          # 움직임 재는 간격
SMALL_W = 320         # 움직임 잴 때 줄이는 너비
MOVE_PX = 4.0         # 한 칸(0.5초)에 이만큼(원본 px) 넘게 밀리면 움직이는 중
MIN_TOTAL_PX = 12.0   # 한 번의 움직임 합이 이보다 작으면 흔들림으로 보고 무시
SETTLE_S = 1.0        # 움직임이 끝나고 이만큼 뒤 장면으로 다시 맞춘다
MIN_INLIERS = 40      # 짝이 이보다 적으면 못 맞춘 것 (앞 구간에서 이어 맞추기 시도)
V = 1                 # 결과 형식 (바뀌면 다시 계산)


def _line_score(gray: np.ndarray, Hc: np.ndarray) -> float:
    """코트 라인을 화면에 그렸을 때 그 자리가 실제로 밝은 라인인 비율 (0~1)."""
    h, w = gray.shape
    th = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, -12)
    th = cv2.dilate(th, np.ones((5, 5), np.uint8))
    hit = tot = 0
    for (a, b) in _lines():
        pts = np.float32([[a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s] for s in np.linspace(0, 1, 60)])
        px = cv2.perspectiveTransform(pts[None], Hc)[0]
        for x, y in px:
            if 0 <= x < w and 0 <= y < h:
                tot += 1; hit += th[int(y), int(x)] > 0
    return round(hit / tot, 3) if tot else 0.0


def _lines():
    W, L, N, S, LD = C.W, C.L, C.NET, 1.98, 0.76
    ys = [0, LD, N - S, N, N + S, L - LD, L]
    out = [((0, y), (W, y)) for y in ys]
    out += [((x, 0), (x, L)) for x in (0, 0.46, W - 0.46, W)]
    out += [((W / 2, 0), (W / 2, N - S)), ((W / 2, N + S), (W / 2, L))]
    return out


def scan_moves(video: str, progress=None) -> tuple[list[dict], float, int, list]:
    """0.5초마다 화면이 밀린 양. 반환: (움직임 목록, fps, 전체 프레임, [(frame, dx, dy)])"""
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    step = max(1, round(fps * STEP_S))
    scale = fw / SMALL_W
    prev = win = None
    shifts = []
    for f in range(total):
        if not cap.grab():
            break
        if f % step:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(img, (SMALL_W, int(img.shape[0] * SMALL_W / img.shape[1]))), cv2.COLOR_BGR2GRAY).astype(np.float32)
        if win is None:
            win = cv2.createHanningWindow(g.shape[::-1], cv2.CV_32F)
        if prev is not None:
            (dx, dy), _ = cv2.phaseCorrelate(prev, g, win)
            shifts.append((f, dx * scale, dy * scale))
        prev = g
        if progress and f % (step * 40) == 0:
            progress(f / max(total, 1), f"카메라 움직임 찾기 {f:,} / {total:,} 프레임")
    cap.release()
    moves, cur = [], None
    for f, dx, dy in shifts:
        if np.hypot(dx, dy) > MOVE_PX:
            if cur is None:
                cur = {"f0": f - step, "f1": f, "dx": 0.0, "dy": 0.0}
            cur["f1"] = f; cur["dx"] += dx; cur["dy"] += dy
        elif cur is not None:
            moves.append(cur); cur = None
    if cur is not None:
        moves.append(cur)
    moves = [m for m in moves if np.hypot(m["dx"], m["dy"]) >= MIN_TOTAL_PX]
    out = [{"f0": int(m["f0"]), "f1": int(m["f1"]), "t0": round(m["f0"] / fps, 2), "t1": round(m["f1"] / fps, 2),
            "shift_px": [round(m["dx"], 1), round(m["dy"], 1)]} for m in moves]
    return out, fps, total, shifts


def _read(cap, f):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(f))
    ok, img = cap.read()
    return img if ok else None


def _floor_mask(shape, Hc, pad=1.5):
    """코트(+여유) 바닥 부분만. 벽·천장의 특징점은 바닥과 다르게 움직여서 뺀다."""
    poly = np.float32([[-pad, -pad], [C.W + pad, -pad], [C.W + pad, C.L + pad], [-pad, C.L + pad]])
    px = cv2.perspectiveTransform(poly[None], Hc)[0]
    mk = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(mk, [np.int32(np.clip(px, -5000, 5000))], 255)
    return mk


def _match(a, b, Ha, sift):
    """장면 a(코트 Ha) → 장면 b 의 바닥 변환. 반환 (H_a→b, 짝 수)"""
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY); gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    ma = _floor_mask(a.shape, Ha)
    top = max(0, int(np.argmax(ma.any(1))) - 80)   # b 는 위치를 모르니 코트 윗선 근처부터 아래 전부
    mb = np.zeros(b.shape[:2], np.uint8); mb[top:] = 255
    ka, da = sift.detectAndCompute(ga, ma)
    kb, db = sift.detectAndCompute(gb, mb)
    if da is None or db is None or len(ka) < 8 or len(kb) < 8:
        return None, 0
    mt = cv2.BFMatcher().knnMatch(da, db, k=2)
    g = [m[0] for m in mt if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
    if len(g) < 8:
        return None, 0
    pa = np.float32([ka[m.queryIdx].pt for m in g]); pb = np.float32([kb[m.trainIdx].pt for m in g])
    H, inl = cv2.findHomography(pa, pb, cv2.RANSAC, 3.0)
    return H, int(inl.sum()) if inl is not None else 0


def solve(video: str, cfg: dict, progress=None) -> dict:
    """움직임 찾기 + 구간마다 코트 다시 맞추기."""
    moves, fps, total, _ = scan_moves(video, progress)
    Hc0 = np.array(cfg["h_court2px"] if cfg.get("h_court2px") else np.linalg.inv(np.array(cfg["homography"])), np.float64)
    Hc0 /= Hc0[2, 2]
    ref = int(cfg.get("ref_frame", 0))
    # 조용한 구간: 움직임 사이. 움직이는 동안은 다음 구간 것을 쓴다 (경계 = 움직임 가운데)
    bounds = [0] + [(m["f0"] + m["f1"]) // 2 for m in moves] + [total]
    segs = [{"f0": int(bounds[i]), "f1": int(bounds[i + 1])} for i in range(len(bounds) - 1)]
    cap = cv2.VideoCapture(video)
    sift = cv2.SIFT_create(4000)
    ri = next(i for i, s in enumerate(segs) if s["f0"] <= ref < s["f1"] or i == len(segs) - 1)
    ref_img = _read(cap, ref)
    settle = int(round(SETTLE_S * fps))
    segs[ri].update(frame=ref, h_court2px=Hc0, inliers=None, via="설정")
    # 설정 구간에서 바깥쪽으로 하나씩: 후보 (옆 구간 그대로 / 옆 구간에서 이어 맞춤 / 설정 장면과 직접 맞춤)
    # 중 실제 흰 라인 위에 가장 잘 놓이는 것을 고른다 (작은 흔들림이면 '그대로'가 이긴다)
    order = list(range(ri + 1, len(segs))) + list(range(ri - 1, -1, -1))
    for i in order:
        s = segs[i]
        fwd = i > ri
        nb = segs[i - 1] if fwd else segs[i + 1]
        m = moves[i - 1] if fwd else moves[i]
        fr = min(m["f1"] + settle, s["f1"] - 1) if fwd else max(m["f0"] - settle, s["f0"])      # 이 구간 대표 장면
        fn = max(m["f0"] - settle, nb["f0"]) if fwd else min(m["f1"] + settle, nb["f1"] - 1)    # 움직이기 직전(옆 구간) 장면
        s["frame"] = int(fr)
        img, nimg = _read(cap, fr), _read(cap, fn)
        Hn = np.asarray(nb["h_court2px"], np.float64)
        cands = [(Hn, None, "그대로 (흔들림)")]
        if img is not None and nimg is not None:
            H2, n2 = _match(nimg, img, Hn, sift)
            if H2 is not None and n2 >= 12:
                cands.append((H2 @ Hn, n2, "옆 구간에서 이어 맞춤"))
        if img is not None and ref_img is not None:
            H1, n1 = _match(ref_img, img, Hc0, sift)
            if H1 is not None and n1 >= 12:
                cands.append((H1 @ Hc0, n1, "설정 장면과 맞춤"))
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img is not None else None
        best = max(cands, key=lambda c: _line_score(g, c[0] / c[0][2, 2]) if g is not None else 0)
        s.update(h_court2px=best[0], inliers=best[1], via=best[2])
    # 확인 점수 + 직렬화
    for s in segs:
        Hc = np.asarray(s["h_court2px"], np.float64); Hc = Hc / Hc[2, 2]
        img = _read(cap, s["frame"])
        s["line_score"] = _line_score(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), Hc) if img is not None else None
        s["h_court2px"] = Hc.tolist()
        Hp = np.linalg.inv(Hc); s["homography"] = (Hp / Hp[2, 2]).tolist()
        s["t0"] = round(s["f0"] / fps, 2); s["t1"] = round(s["f1"] / fps, 2)
    cap.release()
    return {"moves": moves, "segments": segs, "fps": fps,
            "key": {"v": V, "total": total, "ref_frame": ref, "h": np.round(Hc0, 6).tolist()}}


def load_or_solve(video: str, cfg: dict, path: Path, progress=None) -> dict:
    """camera.json 이 지금 설정·영상과 맞으면 그대로, 아니면 다시 계산해서 저장."""
    Hc0 = np.array(cfg["h_court2px"] if cfg.get("h_court2px") else np.linalg.inv(np.array(cfg["homography"])), np.float64)
    Hc0 /= Hc0[2, 2]
    cap = cv2.VideoCapture(video); total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); cap.release()
    key = {"v": V, "total": total, "ref_frame": int(cfg.get("ref_frame", 0)), "h": np.round(Hc0, 6).tolist()}
    try:
        cam = json.loads(Path(path).read_text(encoding="utf-8"))
        if cam.get("key") == key:
            return cam
    except Exception:  # noqa: BLE001
        pass
    cam = solve(video, cfg, progress)
    Path(path).write_text(json.dumps(cam, ensure_ascii=False, indent=1), encoding="utf-8")
    return cam


def homography_for(cam: dict | None, frames: np.ndarray, H0: np.ndarray) -> list[np.ndarray]:
    """프레임마다 쓸 화면→코트 변환 (구간 표). cam 이 없으면 전부 H0."""
    if not cam or len(cam.get("segments", [])) <= 1:
        return [H0] * len(frames)
    segs = cam["segments"]
    starts = np.array([s["f0"] for s in segs])
    Hs = [np.asarray(s["homography"], np.float64) for s in segs]
    idx = np.clip(np.searchsorted(starts, np.asarray(frames), side="right") - 1, 0, len(segs) - 1)
    return [Hs[i] for i in idx]

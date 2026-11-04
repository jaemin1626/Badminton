"""코트 좌표계 (단위 m, 복식 외곽선 기준).

(0,0) = 화면 위-왼쪽(far), (6.10, 13.40) = 화면 아래-오른쪽(near). 네트 y = 6.70.
꼭짓점 순서: far-left → far-right → near-right → near-left.
"""
from __future__ import annotations

import cv2
import numpy as np

W, L = 6.10, 13.40
NET = L / 2
SHORT = 1.98          # 네트 ~ 숏 서비스 라인
LONG_DBL = 0.76       # 엔드라인 ~ 복식 롱 서비스 라인
SIDE_SGL = 0.46       # 복식 사이드라인 ~ 단식 사이드라인
CENTER = W / 2
COURT = np.float32([[0, 0], [W, 0], [W, L], [0, L]])
CORNER_ORDER = ["far-left", "far-right", "near-right", "near-left"]

# 플레이 영역: 코트 밖 x ±1.5 m, y ±2.0 m (관중·심판 제외용)
PLAY_MX, PLAY_MY = 1.5, 2.0


def homography(corners_px) -> np.ndarray:
    """픽셀 → 코트(m) 변환 행렬."""
    return cv2.getPerspectiveTransform(np.float32(corners_px), COURT)


def to_court(H: np.ndarray, pts) -> np.ndarray:
    pts = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    if not len(pts):
        return np.zeros((0, 2))
    return cv2.perspectiveTransform(pts, H).reshape(-1, 2)


def to_px(H: np.ndarray, pts) -> np.ndarray:
    return to_court(np.linalg.inv(H), pts)


def in_play(xy) -> bool:
    x, y = xy
    return -PLAY_MX <= x <= W + PLAY_MX and -PLAY_MY <= y <= L + PLAY_MY


def side_of(y: float) -> str:
    return "far" if y < NET else "near"


def foot_point(box, kps=None, kp_thr=0.35):
    """발 위치(픽셀). 발목 관절이 믿을 만하면 발목 평균, 아니면 박스 아래 중앙."""
    x1, y1, x2, y2 = box[:4]
    if kps is not None:
        ank = kps[[15, 16]]
        good = ank[ank[:, 2] > kp_thr]
        if len(good):
            fx = float(good[:, 0].mean())
            fy = max(float(good[:, 1].max()), y1 + 0.85 * (y2 - y1))  # 발목보다 약간 아래 = 발바닥
            return fx, min(fy, y2)
    return (x1 + x2) / 2, y2


def service_box(side: str, xy) -> str | None:
    """서비스 코트 판정. 서버/리시버 자기 기준으로 'right' 또는 'left'.

    far 쪽 선수는 카메라를 보고 서 있으므로 오른쪽 = 화면 왼쪽(x < CENTER).
    near 쪽 선수는 카메라를 등지고 서 있으므로 오른쪽 = 화면 오른쪽(x > CENTER).
    """
    x, _ = xy
    if side == "far":
        return "right" if x < CENTER else "left"
    return "right" if x > CENTER else "left"


def dist_to_net(xy) -> float:
    return abs(xy[1] - NET)


def court_lines():
    s, ss, ls = SIDE_SGL, SHORT, LONG_DBL
    return [
        [[0, 0], [W, 0]], [[0, L], [W, L]], [[0, 0], [0, L]], [[W, 0], [W, L]],
        [[s, 0], [s, L]], [[W - s, 0], [W - s, L]],
        [[0, NET - ss], [W, NET - ss]], [[0, NET + ss], [W, NET + ss]],
        [[0, ls], [W, ls]], [[0, L - ls], [W, L - ls]],
        [[CENTER, 0], [CENTER, NET - ss]], [[CENTER, NET + ss], [CENTER, L]],
    ]

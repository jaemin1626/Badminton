"""공개용 영상 마스킹: 머리(head) 클래스를 모자이크. 지정한 선수 번호는 제외.

선수 번호
  복식: 1·2 = 팀 A, 3·4 = 팀 B.  단식: 1 = 팀 A, 2 = 팀 B.
  팀 안 번호는 설정할 때 고른 박스를 코트 왼쪽부터 정렬한 순서 = 추적 슬롯 순서({side}0, {side}1).
  위치(far/near) → 팀 매핑은 게임마다 바뀌므로 result 이벤트의 sides 기록으로 프레임별로 계산한다.

한계
  같은 팀 두 선수가 서로 엇갈리거나 게임이 바뀌면 팀 안 번호(1↔2)가 뒤바뀔 수 있다.
  한 팀을 통째로 제외할 때는 영향이 없다.
"""
from __future__ import annotations

import bisect

import cv2
import numpy as np


def players_of(cfg: dict) -> list[dict]:
    """선수 번호 목록 [{no, team, idx, bbox}] (설정 프레임 기준)."""
    mode = cfg.get("match", {}).get("mode", "doubles")
    per = 2 if mode == "doubles" else 1
    out, no = [], 1
    for team, key in (("A", "1"), ("B", "2")):
        t = cfg["teams"][key]
        pairs = sorted(zip(t.get("court_pos", []), t.get("bboxes", [])), key=lambda p: p[0][0])
        for i in range(per):
            out.append({"no": no, "team": team, "idx": i, "name": t.get("name", f"팀 {team}"),
                        "bbox": pairs[i][1] if i < len(pairs) else None})
            no += 1
    return out


def pixelate(img: np.ndarray, box, block_div: int = 7):
    x1, y1, x2, y2 = [int(round(v)) for v in box]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(img.shape[1], x2), min(img.shape[0], y2)
    w, h = x2 - x1, y2 - y1
    if w < 2 or h < 2:
        return
    block = max(4, int(max(w, h) / block_div))
    roi = img[y1:y2, x1:x2]
    small = cv2.resize(roi, (max(1, w // block), max(1, h // block)), interpolation=cv2.INTER_AREA)
    img[y1:y2, x1:x2] = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


def expand(box, s: float = 0.25):
    x1, y1, x2, y2 = box[:4]
    w, h = x2 - x1, y2 - y1
    return [x1 - w * s, y1 - h * s, x2 + w * s, y2 + h * s * 0.6]


class HeadMasker:
    def __init__(self, det, cfg: dict, result: dict, tracks: dict | None, exclude: list[int],
                 fps: float, conf: float = 0.2, persist_s: float = 0.3):
        self.det = det
        self.head = det.cls_id("head")
        self.conf = conf
        self.persist = max(1, int(round(fps * persist_s)))
        self.mode = cfg.get("match", {}).get("mode", "doubles")
        self.players = {p["no"]: p for p in players_of(cfg)}
        self.exclude = [n for n in exclude if n in self.players]
        # 프레임 → 팀 위치 매핑
        base = {"A": cfg["teams"]["1"]["side"], "B": cfg["teams"]["2"]["side"]}
        self.side_keys, self.side_vals = [0], [base]
        for e in result.get("events", []):
            if e.get("sides") and not e.get("removed"):
                self.side_keys.append(int(e.get("frame_still", e["frame"])))
                self.side_vals.append(e["sides"])
        self.tr = tracks
        if tracks is not None:
            self.tframes = tracks["frames"]
            self.slots = [str(s) for s in tracks["slots"]]
            self.maxgap = int(tracks["step"]) * 3
        self.recent: list[tuple[int, list]] = []  # (마지막으로 본 프레임, 박스)
        self.count = 0

    def _sides(self, f: int) -> dict:
        return self.side_vals[bisect.bisect_right(self.side_keys, f) - 1]

    def _player_box(self, no: int, f: int):
        """프레임 f에서 선수 no의 몸 박스 (추적 결과를 선형 보간)."""
        if self.tr is None:
            return None
        p = self.players[no]
        slot = f"{self._sides(f)[p['team']]}{p['idx']}"
        if slot not in self.slots:
            return None
        k = self.slots.index(slot)
        i = int(np.searchsorted(self.tframes, f))
        cand = []
        for j in (i - 1, i):
            if 0 <= j < len(self.tframes) and abs(int(self.tframes[j]) - f) <= self.maxgap:
                b = self.tr["box"][j, k]
                if not np.isnan(b[0]):
                    cand.append((int(self.tframes[j]), b))
        if not cand:
            return None
        if len(cand) == 2 and cand[1][0] != cand[0][0]:
            a = (f - cand[0][0]) / (cand[1][0] - cand[0][0])
            return cand[0][1] * (1 - a) + cand[1][1] * a
        return cand[0][1]

    def _excluded(self, head, f: int) -> bool:
        cx, cy = (head[0] + head[2]) / 2, (head[1] + head[3]) / 2
        for no in self.exclude:
            b = self._player_box(no, f)
            if b is None:
                continue
            x1, y1, x2, y2 = b
            w, h = x2 - x1, y2 - y1
            if x1 - 0.1 * w <= cx <= x2 + 0.1 * w and y1 - 0.15 * h <= cy <= y1 + 0.45 * h:
                return True
        return False

    def apply(self, frames: list[np.ndarray], fidx: list[int]):
        """프레임 묶음에 마스킹을 그린다 (제자리 수정)."""
        dets = self.det.detect(frames, [self.head], conf=self.conf)
        for img, f, d in zip(frames, fidx, dets):
            now = [b[:4].tolist() for b in d if not self._excluded(b, f)]
            # 이전 프레임에서 가렸던 박스를 잠시 유지 (검출이 끊겨도 얼굴이 보이지 않게)
            keep = [(lf, b) for lf, b in self.recent if f - lf <= self.persist and not self._excluded(b, f)]
            for b in now:
                keep = [(lf, ob) for lf, ob in keep if _iou(ob, b) < 0.3]
            self.recent = keep + [(f, b) for b in now]
            for _, b in self.recent:
                pixelate(img, expand(b))
            self.count += len(now)


def _iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    i = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9)

"""Detector(YOLOv7 ONNX) + Pose(AlphaPose ONNX) 추론. Top-down 구조.

Detector  : Models/Detector/detect.i1120x640.onnx  (tools/export_detector.py로 생성)
Pose      : Models/PoseEstimation/*.onnx  (AlphaPose FastPose, 입력 256x192, 출력 17x64x48 히트맵)
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DET_PATH = Path(os.environ.get("BADMINTON_DET", ROOT / "Models/Detector/detect.i1120x640.onnx"))
POSE_DIR = ROOT / "Models/PoseEstimation"

# COCO 17 관절
KP_NAMES = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow",
            "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"]
SKELETON = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12),
            (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]


def _session(path: Path):
    import onnxruntime as ort
    if not getattr(_session, "_preloaded", False):
        try:  # pip로 설치된 CUDA/cuDNN(.venv/.../nvidia) 라이브러리를 먼저 로드
            ort.preload_dlls()
        except Exception:
            pass
        _session._preloaded = True
    gpu = os.environ.get("BADMINTON_GPU", "0")
    providers = [("CUDAExecutionProvider", {"device_id": int(gpu)}), "CPUExecutionProvider"]
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    return ort.InferenceSession(str(path), so, providers=providers)


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list[int]:
    x1, y1, x2, y2 = boxes.T
    area = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]]); yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]]); yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        ov = inter / (area[i] + area[order[1:]] - inter + 1e-9)
        order = order[1:][ov < iou]
    return keep


class Detector:
    """YOLOv7 ONNX. 사람(class 0)만 반환."""

    def __init__(self, path: Path = DET_PATH):
        if not path.exists():
            raise FileNotFoundError(f"{path} 없음. 먼저 `python tools/export_detector.py` 실행")
        self.sess = _session(path)
        meta = self.sess.get_modelmeta().custom_metadata_map
        self.names = json.loads(meta.get("names", '["person"]'))
        shp = self.sess.get_inputs()[0].shape
        self.h, self.w = int(shp[2]), int(shp[3])
        self.person = self.names.index("person") if "person" in self.names else 0

    def letterbox(self, img):
        h0, w0 = img.shape[:2]
        r = min(self.h / h0, self.w / w0)
        nh, nw = round(h0 * r), round(w0 * r)
        top, left = (self.h - nh) // 2, (self.w - nw) // 2
        canvas = np.full((self.h, self.w, 3), 114, np.uint8)
        canvas[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        return canvas, r, left, top

    def cls_id(self, name: str) -> int:
        return self.names.index(name)

    def detect(self, frames, classes, conf=0.25, iou=0.5):
        """여러 클래스 검출. frames: BGR 리스트 → 각 프레임의 [N,6] (x1,y1,x2,y2,score,cls)."""
        batch, metas = [], []
        for f in frames:
            lb, r, l, t = self.letterbox(f)
            batch.append(lb[:, :, ::-1].transpose(2, 0, 1))
            metas.append((r, l, t, f.shape[1], f.shape[0]))
        x = np.ascontiguousarray(np.stack(batch), dtype=np.float32) / 255.0
        out = self.sess.run(None, {"images": x})[0]
        res = []
        for pred, (r, l, t, W, H) in zip(out, metas):
            rows = []
            for c in classes:
                score = pred[:, 4] * pred[:, 5 + c]
                m = score > conf
                if not m.any():
                    continue
                p, s = pred[m], score[m]
                b = np.empty((len(p), 4), np.float32)
                b[:, 0] = (p[:, 0] - p[:, 2] / 2 - l) / r
                b[:, 1] = (p[:, 1] - p[:, 3] / 2 - t) / r
                b[:, 2] = (p[:, 0] + p[:, 2] / 2 - l) / r
                b[:, 3] = (p[:, 1] + p[:, 3] / 2 - t) / r
                b[:, [0, 2]] = b[:, [0, 2]].clip(0, W); b[:, [1, 3]] = b[:, [1, 3]].clip(0, H)
                k = nms(b, s, iou)
                rows.append(np.concatenate([b[k], s[k, None], np.full((len(k), 1), c, np.float32)], 1))
            res.append(np.concatenate(rows).astype(np.float32) if rows else np.zeros((0, 6), np.float32))
        return res

    def __call__(self, frames, conf=0.25, iou=0.5):
        """frames: BGR 이미지 리스트 → 각 프레임의 [N,5] (x1,y1,x2,y2,score)."""
        single = isinstance(frames, np.ndarray)
        frames = [frames] if single else frames
        batch, metas = [], []
        for f in frames:
            lb, r, l, t = self.letterbox(f)
            batch.append(lb[:, :, ::-1].transpose(2, 0, 1))
            metas.append((r, l, t, f.shape[1], f.shape[0]))
        x = np.ascontiguousarray(np.stack(batch), dtype=np.float32) / 255.0
        out = self.sess.run(None, {"images": x})[0]
        res = []
        for pred, (r, l, t, W, H) in zip(out, metas):
            score = pred[:, 4] * pred[:, 5 + self.person]
            m = score > conf
            p, s = pred[m], score[m]
            if not len(p):
                res.append(np.zeros((0, 5), np.float32)); continue
            b = np.empty((len(p), 4), np.float32)
            b[:, 0] = (p[:, 0] - p[:, 2] / 2 - l) / r
            b[:, 1] = (p[:, 1] - p[:, 3] / 2 - t) / r
            b[:, 2] = (p[:, 0] + p[:, 2] / 2 - l) / r
            b[:, 3] = (p[:, 1] + p[:, 3] / 2 - t) / r
            b[:, [0, 2]] = b[:, [0, 2]].clip(0, W); b[:, [1, 3]] = b[:, [1, 3]].clip(0, H)
            k = nms(b, s, iou)
            res.append(np.concatenate([b[k], s[k, None]], 1).astype(np.float32))
        return res[0] if single else res


class Pose:
    """AlphaPose FastPose ONNX. 박스 → 17 관절 (x, y, conf), 원본 픽셀 좌표."""

    MEAN = np.array([0.406, 0.457, 0.480], np.float32)  # AlphaPose 전처리 (RGB, /255 후 평균만 뺌)

    def __init__(self, path: Path | None = None):
        if path is None:
            cands = sorted(POSE_DIR.glob("*.onnx"))
            if not cands:
                raise FileNotFoundError(f"{POSE_DIR}에 pose onnx 없음")
            path = cands[0]
        self.sess = _session(path)
        shp = self.sess.get_inputs()[0].shape
        self.ih, self.iw = int(shp[2]), int(shp[3])  # 256, 192
        self.name = path.name

    def _affine(self, box, scale_mult=1.25):
        x1, y1, x2, y2 = box[:4]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        w, h = x2 - x1, y2 - y1
        ar = self.iw / self.ih
        if w > ar * h:
            h = w / ar
        else:
            w = h * ar
        w, h = w * scale_mult, h * scale_mult
        src = np.float32([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx - w / 2, cy + h / 2]])
        dst = np.float32([[0, 0], [self.iw, 0], [0, self.ih]])
        return cv2.getAffineTransform(src, dst), (cx, cy, w, h)

    def __call__(self, img, boxes):
        """img: BGR, boxes: [N,4+] → [N,17,3]."""
        return self.multi([(img, boxes)])[0]

    def multi(self, items, batch: int = 32):
        """여러 이미지의 박스를 한 번에 추론. items: [(img, boxes)] → [[N_i,17,3]]."""
        crops, infos, counts = [], [], []
        for img, boxes in items:
            counts.append(len(boxes))
            for b in boxes:
                M, info = self._affine(b)
                c = cv2.warpAffine(img, M, (self.iw, self.ih), flags=cv2.INTER_LINEAR)
                crops.append((c[:, :, ::-1].astype(np.float32) / 255.0 - self.MEAN).transpose(2, 0, 1)); infos.append(info)
        n = len(crops)
        if n == 0:
            return [np.zeros((0, 17, 3), np.float32) for _ in items]
        # 입력 크기는 항상 batch 하나로 고정해서 채운다: CUDA 실행기는 입력 크기가 직전과 달라질 때마다
        # 계산 계획을 다시 세우느라 ~0.4초씩 쓴다 (크기가 같으면 32명에 ~15 ms)
        hms = []
        for i in range(0, n, batch):
            chunk = np.stack(crops[i:i + batch])
            m = len(chunk)
            if m < batch:
                chunk = np.concatenate([chunk, np.zeros((batch - m, *chunk.shape[1:]), np.float32)])
            hms.append(self.sess.run(None, {"input": np.ascontiguousarray(chunk)})[0][:m])
        hm = np.concatenate(hms)
        _, k, hh, hw = hm.shape
        flat = hm.reshape(n, k, -1)
        idx = flat.argmax(-1)
        conf = flat.max(-1)
        py, px = (idx // hw), (idx % hw)
        # 1/4 픽셀 보정 (이웃 값 차이 방향으로 0.25 이동) — 배열 연산
        ii, jj = np.meshgrid(np.arange(n), np.arange(k), indexing="ij")
        xr, xl = np.clip(px + 1, 0, hw - 1), np.clip(px - 1, 0, hw - 1)
        yd, yu = np.clip(py + 1, 0, hh - 1), np.clip(py - 1, 0, hh - 1)
        dx = np.sign(hm[ii, jj, py, xr] - hm[ii, jj, py, xl]) * ((px > 0) & (px < hw - 1))
        dy = np.sign(hm[ii, jj, yd, px] - hm[ii, jj, yu, px]) * ((py > 0) & (py < hh - 1))
        fx = px.astype(np.float32) + 0.25 * dx
        fy = py.astype(np.float32) + 0.25 * dy
        inf = np.array(infos, np.float32)  # cx, cy, w, h
        out = np.zeros((n, k, 3), np.float32)
        out[:, :, 0] = inf[:, None, 0] - inf[:, None, 2] / 2 + (fx + 0.5) * inf[:, None, 2] / hw
        out[:, :, 1] = inf[:, None, 1] - inf[:, None, 3] / 2 + (fy + 0.5) * inf[:, None, 3] / hh
        out[:, :, 2] = conf
        res, o = [], 0
        for c in counts:
            res.append(out[o:o + c]); o += c
        return res


_lock = threading.Lock()
_models: dict = {}


def get_models():
    """프로세스당 한 번만 로드 (스레드 안전)."""
    with _lock:
        if "det" not in _models:
            _models["det"] = Detector()
            _models["pose"] = Pose()
        return _models["det"], _models["pose"]

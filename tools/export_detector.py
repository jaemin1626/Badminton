"""YOLOv7 Detector(.pt) → ONNX 변환 (한 번만 실행).

웹 서버는 onnxruntime만 쓰므로 YOLOv7 저장소 코드가 필요 없다.
변환할 때만 YOLOv7 저장소(models/, utils/)가 필요하다.

    .venv/bin/python tools/export_detector.py \
        --yolov7 ~/yolov7 --weights Models/Detector/detect.pt --imgsz 640 1120

출력: Models/Detector/detect.i1120x640.onnx
      입력  images [N,3,H,W] float32 0~1 RGB
      출력  output [N, A, 5+nc]  (cx, cy, w, h, obj, cls...)  NMS 없음
"""
import argparse
import json
import sys
from pathlib import Path

import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yolov7", default=str(Path.home() / "yolov7"), help="YOLOv7 저장소 경로")
    ap.add_argument("--weights", default=str(ROOT / "Models/Detector/detect.pt"))
    ap.add_argument("--imgsz", nargs=2, type=int, default=[640, 1120], help="H W (32의 배수)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    sys.path.insert(0, str(Path(args.yolov7).expanduser()))
    import models.common as mc  # noqa: E402  (YOLOv7 저장소)
    from utils.activations import Hardswish, SiLU  # noqa: E402

    # YOLOv7 attempt_load()는 경로를 소문자로 바꿔서(Models→models) 직접 로드한다.
    args.weights = str(Path(args.weights).expanduser().resolve())
    ck = torch.load(args.weights, map_location="cpu", weights_only=False)
    model = (ck.get("ema") or ck["model"]).float().fuse().eval()
    for m in model.modules():
        if type(m) in (nn.Hardswish, nn.LeakyReLU, nn.ReLU, nn.ReLU6, nn.SiLU):
            m.inplace = True
        elif type(m) is nn.Upsample:
            m.recompute_scale_factor = None
    names = list(model.names)
    for m in model.modules():
        m._non_persistent_buffers_set = set()
        if isinstance(m, mc.Conv):
            if isinstance(m.act, nn.Hardswish):
                m.act = Hardswish()
            elif isinstance(m.act, nn.SiLU):
                m.act = SiLU()
    model.model[-1].export = False  # grid 디코딩 포함 (cx,cy,w,h 픽셀 좌표 출력)

    h, w = args.imgsz
    img = torch.zeros(1, 3, h, w)
    with torch.no_grad():
        y = model(img)
    print("dry run:", y[0].shape)

    class Head0(nn.Module):  # (decoded, raw) 중 decoded만 내보낸다
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            return self.m(x)[0]

    out = Path(args.out) if args.out else Path(args.weights).with_name(f"detect.i{w}x{h}.onnx")
    torch.onnx.export(
        Head0(model), img, str(out), opset_version=12, dynamo=False,
        input_names=["images"], output_names=["output"],
        dynamic_axes={"images": {0: "batch"}, "output": {0: "batch"}},
    )

    import onnx
    m = onnx.load(str(out))
    try:
        from onnxsim import simplify
        m, ok = simplify(m)
        print("onnxsim:", ok)
    except Exception as e:  # 단순화 실패해도 원본은 사용 가능
        print("onnxsim skipped:", e)
    meta = m.metadata_props.add()
    meta.key, meta.value = "names", json.dumps(names)
    meta = m.metadata_props.add()
    meta.key, meta.value = "imgsz", json.dumps([h, w])
    onnx.save(m, str(out))
    print("saved", out, "names=", names)


if __name__ == "__main__":
    main()

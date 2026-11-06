"""Smash Score — FastAPI 서버.

    .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis as A
from . import court as C
from .render import make_preview, render_overlay

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "videos"
DATA.mkdir(parents=True, exist_ok=True)
STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Smash Score", version="0.1")


@app.middleware("http")
async def no_stale_pages(request: Request, call_next):
    """화면 파일(html·js·css)은 매번 최신인지 확인하게 한다 (고친 뒤 예전 화면이 보이는 문제 방지)."""
    resp = await call_next(request)
    path = request.url.path
    if path in ("/", "/lab") or path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

# ---------------------------------------------------------------- 저장소
ID_RE = re.compile(r"^[a-z0-9]{6,32}$")


def vdir(vid: str) -> Path:
    if not ID_RE.match(vid):
        raise HTTPException(400, "잘못된 영상 ID")
    d = DATA / vid
    if not d.exists():
        raise HTTPException(404, "영상을 찾을 수 없어요")
    return d


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(p: Path, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2))
    tmp.replace(p)


def source_path(d: Path) -> Path:
    meta = read_json(d / "meta.json", {})
    return d / meta.get("file", "source.mp4")


_cap_lock = threading.Lock()
_caps: dict[str, cv2.VideoCapture] = {}


def read_frame(d: Path, idx: int) -> np.ndarray:
    key = str(d)
    with _cap_lock:
        cap = _caps.get(key)
        if cap is None:
            cap = cv2.VideoCapture(str(source_path(d)))
            _caps[key] = cap
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        idx = max(0, min(idx, n - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, img = cap.read()
    if not ok:
        raise HTTPException(404, "프레임을 읽을 수 없어요")
    return img


def jpeg(img: np.ndarray, w: int | None = None, q: int = 88) -> bytes:
    if w and w < img.shape[1]:
        img = cv2.resize(img, (w, round(img.shape[0] * w / img.shape[1])), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


# ---------------------------------------------------------------- 작업(Job)
class Job:
    def __init__(self, kind: str, vid: str, stages: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.kind, self.vid = kind, vid
        self.stages = [{"name": s, "state": "wait", "progress": 0.0, "msg": ""} for s in stages]
        self.state = "queued"
        self.error = None
        self.created = time.time()
        self.stop = threading.Event()

    def stage(self, i: int, progress: float = 0.0, msg: str = ""):
        for j, s in enumerate(self.stages):
            if j < i:
                s["state"], s["progress"] = "done", 1.0
        s = self.stages[i]
        s["state"], s["progress"], s["msg"] = "run", float(progress), msg

    def finish_stage(self, i: int, msg: str = ""):
        self.stages[i].update(state="done", progress=1.0, msg=msg or self.stages[i]["msg"])

    @property
    def progress(self):
        return sum(s["progress"] for s in self.stages) / len(self.stages)

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "video_id": self.vid, "state": self.state, "error": self.error,
                "progress": round(self.progress, 4), "stages": self.stages}


JOBS: dict[str, Job] = {}
GPU_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")   # 분석은 한 번에 하나
CPU_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cpu")   # 렌더/변환


def submit(job: Job, fn, pool=GPU_POOL):
    JOBS[job.id] = job
    d = DATA / job.vid
    meta = read_json(d / "meta.json", {})
    meta.setdefault("jobs", {})[job.kind] = job.id
    write_json(d / "meta.json", meta)

    def run():
        job.state = "running"
        try:
            fn(job)
            job.state = "done"
        except InterruptedError:
            job.state, job.error = "cancelled", "취소했어요"
        except Exception as e:  # noqa: BLE001
            job.state, job.error = "error", f"{type(e).__name__}: {e}"
            traceback.print_exc()
            (d / f"{job.kind}_error.log").write_text(traceback.format_exc())
        finally:
            write_json(d / f"job_{job.kind}.json", job.to_dict())

    pool.submit(run)
    return job


def models():
    from .vision import get_models
    return get_models()


# ---------------------------------------------------------------- 정적 파일 / 상태
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    import onnxruntime as ort
    det = (ROOT / "Models/Detector/detect.i1120x640.onnx").exists()
    pose = any((ROOT / "Models/PoseEstimation").glob("*.onnx"))
    loaded = {}
    try:
        from .vision import _models
        if "det" in _models:
            loaded = {"detector": _models["det"].sess.get_providers()[0], "pose": _models["pose"].sess.get_providers()[0]}
    except Exception:
        pass
    return {"ok": det and pose, "detector": det, "pose": pose, "providers": ort.get_available_providers(), "loaded": loaded}


# ---------------------------------------------------------------- 영상
def probe(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise HTTPException(400, "영상을 열 수 없어요. mp4(H.264)나 mov 파일인지 확인해 주세요")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
    codec = "".join(chr((fourcc >> 8 * i) & 0xFF) for i in range(4)).strip("\x00").lower()
    ok, img = cap.read()
    cap.release()
    if not ok:
        raise HTTPException(400, "첫 프레임을 읽을 수 없어요")
    return {"fps": round(fps, 3), "frames": n, "width": w, "height": h, "duration": round(n / fps, 2), "codec": codec}, img


@app.post("/api/videos")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "video.mp4").suffix.lower()
    if ext not in {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}:
        raise HTTPException(400, "mp4 · mov · mkv · avi · webm 파일만 올릴 수 있어요")
    vid = uuid.uuid4().hex[:12]
    d = DATA / vid
    d.mkdir(parents=True)
    dst = d / f"source{ext}"
    try:
        with open(dst, "wb") as f:
            while chunk := await file.read(8 << 20):
                f.write(chunk)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return _register(vid, d, dst, file.filename or dst.name)


VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}
_reg_lock = threading.Lock()


def _register(vid: str, d: Path, dst: Path, name: str, **extra) -> dict:
    """영상 폴더에 메타·썸네일을 만들고, 필요하면 브라우저용 미리보기 변환을 건다."""
    ext = dst.suffix.lower()
    try:
        info, img = probe(dst)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    cv2.imwrite(str(d / "thumb.jpg"), cv2.resize(img, (320, round(img.shape[0] * 320 / img.shape[1]))))
    meta = {"id": vid, "name": name, "file": dst.name, "created": time.time(), **info, "step": 1, **extra}
    write_json(d / "meta.json", meta)
    # 브라우저가 못 읽는 코덱이면 미리보기용 H.264 사본을 만든다
    if info["codec"] not in {"avc1", "h264", "x264"} or ext not in {".mp4", ".m4v", ".mov"}:
        job = Job("preview", vid, ["브라우저용 영상 변환"])
        def fn(job):
            job.stage(0)
            make_preview(str(dst), str(d / "preview.mp4"), lambda p, m: job.stage(0, p, m), info["frames"])
            job.finish_stage(0)
        submit(job, fn, CPU_POOL)
    return meta


def register_local_files():
    """data/videos 에 직접 넣어 둔 영상 파일을 등록한다 (복사 없이 원본을 가리키는 링크).

    영상 ID는 파일 이름으로 정해지므로 같은 파일은 한 번만 등록된다. 등록을 지워도 원본 파일은 남는다.
    """
    with _reg_lock:
        for f in sorted(DATA.iterdir()):
            if not f.is_file() or f.suffix.lower() not in VIDEO_EXT:
                continue
            vid = "f" + hashlib.sha1(f.name.encode()).hexdigest()[:11]
            d = DATA / vid
            if (d / "meta.json").exists():
                continue
            d.mkdir(exist_ok=True)
            dst = d / f"source{f.suffix.lower()}"
            if not dst.exists():
                dst.symlink_to(Path("..") / f.name)
            try:
                _register(vid, d, dst, f.name, local=str(f))
            except Exception:  # noqa: BLE001  (못 여는 파일은 건너뛴다)
                traceback.print_exc()


@app.get("/api/videos")
def list_videos():
    register_local_files()
    out = []
    for d in sorted(DATA.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir():  # data/videos 에 영상 파일을 직접 넣어 둔 경우 등
            continue
        meta = read_json(d / "meta.json")
        if meta:
            meta["has_result"] = (d / "result.json").exists()
            out.append(meta)
    return out


@app.get("/api/videos/{vid}")
def get_video(vid: str):
    d = vdir(vid)
    meta = read_json(d / "meta.json", {})
    meta["config"] = read_json(d / "match.json")
    meta["has_result"] = (d / "result.json").exists()
    meta["has_overlay"] = (d / "overlay.mp4").exists()
    meta["has_preview"] = (d / "preview.mp4").exists()
    meta["has_public"] = (d / "public.mp4").exists()
    meta["active_jobs"] = {k: JOBS[j].to_dict() for k, j in meta.get("jobs", {}).items() if j in JOBS}
    return meta


@app.delete("/api/videos/{vid}")
def delete_video(vid: str):
    d = vdir(vid)
    with _cap_lock:
        cap = _caps.pop(str(d), None)
        if cap:
            cap.release()
    shutil.rmtree(d)
    return {"ok": True}


@app.patch("/api/videos/{vid}/meta")
def patch_meta(vid: str, body: dict):
    d = vdir(vid)
    meta = read_json(d / "meta.json", {})
    for k in ("step", "name"):
        if k in body:
            meta[k] = body[k]
    write_json(d / "meta.json", meta)
    return meta


@app.get("/api/videos/{vid}/thumb")
def thumb(vid: str):
    return FileResponse(vdir(vid) / "thumb.jpg", media_type="image/jpeg")


@app.get("/api/videos/{vid}/frames/{idx}")
def frame(vid: str, idx: int, w: int | None = None):
    img = read_frame(vdir(vid), idx)
    return Response(jpeg(img, w), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/videos/{vid}/stream")
def stream(vid: str, request: Request, kind: str = "auto"):
    """영상 재생 (Range 지원). kind: auto | source | preview | overlay"""
    d = vdir(vid)
    if kind in ("overlay", "public"):
        p = d / f"{kind}.mp4"
    elif kind == "preview" or (kind == "auto" and (d / "preview.mp4").exists()):
        p = d / "preview.mp4"
    else:
        p = source_path(d)
    if not p.exists():
        raise HTTPException(404, "파일이 아직 없어요")
    size = p.stat().st_size
    rng = request.headers.get("range")
    ctype = "video/mp4" if p.suffix in {".mp4", ".m4v"} else "video/quicktime" if p.suffix == ".mov" else "video/webm" if p.suffix == ".webm" else "application/octet-stream"
    if not rng:
        return FileResponse(p, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    start = int(m.group(1) or 0)
    end = min(int(m.group(2)) if m.group(2) else start + (4 << 20) - 1, size - 1)

    def it():
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    break
                left -= len(b)
                yield b

    return StreamingResponse(it(), status_code=206, media_type=ctype, headers={
        "Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)})


# ---------------------------------------------------------------- 검출
def _detect(img: np.ndarray, H=None):
    det, pose = models()
    b = det(img, conf=0.3)
    kp = pose(img, b) if len(b) else np.zeros((0, 17, 3))
    out = []
    for i, (bb, kk) in enumerate(zip(b, kp)):
        item = {"id": i + 1, "box": [round(float(v), 1) for v in bb[:4]], "conf": round(float(bb[4]), 3),
                "kps": [[round(float(x), 1), round(float(y), 1), round(float(c), 2)] for x, y, c in kk]}
        if H is not None:
            fx, fy = C.foot_point(bb, kk)
            xy = C.to_court(H, [[fx, fy]])[0]
            item["court"] = [round(float(xy[0]), 2), round(float(xy[1]), 2)]
            item["in_play"] = bool(C.in_play(xy))
            item["side"] = C.side_of(xy[1])
        out.append(item)
    return out


class DetectReq(BaseModel):
    frame: int
    corners: list[list[float]] | None = None


@app.post("/api/videos/{vid}/detect")
def detect(vid: str, req: DetectReq):
    d = vdir(vid)
    img = read_frame(d, req.frame)
    H = C.homography(req.corners) if req.corners and len(req.corners) == 4 else None
    return {"frame": req.frame, "people": _detect(img, H)}


@app.get("/api/videos/{vid}/suggest-frames")
def suggest_frames(vid: str, n: int = 6, samples: int = 36):
    """선수 4명이 잘 보이는 프레임 추천 (사람 수가 4에 가깝고 확신도가 높은 프레임)."""
    d = vdir(vid)
    cache = d / "suggest.json"
    if (c := read_json(cache)) is not None:
        return c
    meta = read_json(d / "meta.json", {})
    total = meta.get("frames", 1)
    idxs = np.linspace(total * 0.03, total * 0.97, samples).astype(int)
    det, _ = models()
    cap = cv2.VideoCapture(str(source_path(d)))
    cands = []
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, img = cap.read()
        if not ok:
            continue
        b = det(img, conf=0.4)
        h = img.shape[0]
        big = [x for x in b if (x[3] - x[1]) > h * 0.06]
        cnt = len(big)
        score = -abs(cnt - 4) * 2 + (float(np.mean([x[4] for x in big])) if big else 0)
        cands.append({"frame": int(i), "people": cnt, "score": round(score, 3)})
    cap.release()
    cands.sort(key=lambda c: -c["score"])
    picked = []
    gap = total / (n * 3)
    for c in cands:
        if all(abs(c["frame"] - p["frame"]) > gap for p in picked):
            picked.append(c)
        if len(picked) == n:
            break
    picked.sort(key=lambda c: c["frame"])
    write_json(cache, picked)
    return picked


# ---------------------------------------------------------------- 설정 (match.json 형식 유지)
class TeamIn(BaseModel):
    name: str = ""
    bboxes: list[list[float]] = Field(default_factory=list)


class ConfigIn(BaseModel):
    ref_frame: int
    corners: list[list[float]]
    teams: dict[str, TeamIn]      # "A" / "B"
    officials: list[list[float]] = Field(default_factory=list)   # 심판·선심 박스 (선수 후보에서 제외)
    match: dict = Field(default_factory=dict)


@app.put("/api/videos/{vid}/config")
def put_config(vid: str, body: ConfigIn):
    d = vdir(vid)
    meta = read_json(d / "meta.json", {})
    if len(body.corners) != 4:
        raise HTTPException(400, "코트 꼭짓점 4개가 필요해요")
    H = C.homography(body.corners)
    teams = {}
    for key, num in (("A", "1"), ("B", "2")):
        t = body.teams.get(key, TeamIn())
        pos = [C.to_court(H, [[(b[0] + b[2]) / 2, b[3]]])[0].round(3).tolist() for b in t.bboxes]
        sides = [C.side_of(p[1]) for p in pos]
        side = max(set(sides), key=sides.count) if sides else ("far" if key == "A" else "near")
        teams[num] = {"name": t.name or f"팀 {key}", "bboxes": t.bboxes, "court_pos": pos, "side": side}
    if teams["1"]["side"] == teams["2"]["side"]:
        raise HTTPException(400, "두 팀이 네트의 같은 쪽에 있어요. 선수 선택을 확인해 주세요")
    match = {"mode": "doubles", "first": "A", "scoreA": 0, "scoreB": 0, "target": 21, "ours": "A", "scoreboard": True, "game": 1}
    match.update(body.match)
    cfg = {
        "video": f"data/videos/{vid}/{meta.get('file')}",
        "fps": meta.get("fps"), "frame_size": [meta.get("width"), meta.get("height")],
        "ref_frame": body.ref_frame,
        "court_corners_px": body.corners, "corner_order": C.CORNER_ORDER,
        "homography": H.tolist(),
        "teams": teams, "match": match,
        "officials": [{"bbox": b, "court_pos": C.to_court(H, [[(b[0] + b[2]) / 2, b[3]]])[0].round(3).tolist()}
                      for b in body.officials if len(b) >= 4],
    }
    write_json(d / "match.json", cfg)
    return cfg


@app.get("/api/videos/{vid}/config")
def get_config(vid: str):
    cfg = read_json(vdir(vid) / "match.json")
    if cfg is None:
        raise HTTPException(404, "아직 설정이 없어요")
    return cfg


# ---------------------------------------------------------------- 분석
def _setup_from(cfg: dict) -> tuple[dict, dict]:
    m = dict(cfg.get("match", {}))
    m["nameA"], m["nameB"] = cfg["teams"]["1"]["name"], cfg["teams"]["2"]["name"]
    sides = {"A": cfg["teams"]["1"]["side"], "B": cfg["teams"]["2"]["side"]}
    return m, sides


def _rescore(d: Path, events: list, cfg: dict) -> dict:
    setup, sides = _setup_from(cfg)
    scored, summary = A.score_events(events, setup, sides)
    res = {"events": scored, "summary": summary, "setup": setup, "sides": sides,
           "fps": cfg.get("fps"), "updated": time.time()}
    write_json(d / "result.json", res)
    with open(d / "events.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["time_s", "frame", "game", "server_team", "server_name", "service_box", "score_A", "score_B",
                    "confidence", "manual", "removed", "flags"])
        for e in scored:
            nm = setup["nameA"] if e.get("server") == "A" else setup["nameB"] if e.get("server") == "B" else ""
            w.writerow([round(e["t"], 2), e["frame"], e.get("game"), e.get("server") or "", nm, e.get("box") or "",
                        e["score"]["A"], e["score"]["B"], e.get("conf"), bool(e.get("override") or e.get("kind") == "point"),
                        bool(e.get("removed")), " / ".join(e.get("flags", []))])
    return res


@app.post("/api/videos/{vid}/analyze")
def analyze(vid: str):
    d = vdir(vid)
    cfg = read_json(d / "match.json")
    if cfg is None:
        raise HTTPException(400, "먼저 코트와 선수를 지정해 주세요")
    meta = read_json(d / "meta.json", {})
    running = meta.get("jobs", {}).get("analyze")
    if running in JOBS and JOBS[running].state in {"queued", "running"}:
        return JOBS[running].to_dict()
    job = Job("analyze", vid, ["모델 준비", "선수 추적 · 자세 추정", "서브 장면 찾기", "점수 계산"])

    def fn(job: Job):
        job.stage(0, 0.3, "Detector · Pose 불러오는 중")
        ms = models()
        job.finish_stage(0, "GPU" if "CUDA" in ms[0].sess.get_providers()[0] else "CPU")
        job.stage(1)
        t0 = time.time()

        def prog(p, msg):
            el = time.time() - t0
            eta = el / max(p, 1e-3) * (1 - p)
            job.stage(1, p, f"{msg} · 남은 시간 약 {int(eta // 60)}분 {int(eta % 60)}초")

        tr = A.track(str(source_path(d)), cfg, ms, prog, stop=job.stop)
        A.save_tracks(tr, d / "tracks.npz")
        A.write_players_csv(tr, d / "players.csv")
        job.finish_stage(1, f"{len(tr['frames']):,}개 프레임 분석")
        job.stage(2, 0.5)
        cands = A.find_serves(tr, cfg.get("match", {}).get("mode", "doubles"))
        for i, c in enumerate(cands):
            c["id"] = f"e{i:04d}"
        write_json(d / "serves_raw.json", cands)
        job.finish_stage(2, f"서브 {len(cands)}개 찾음")
        job.stage(3, 0.5)
        _rescore(d, cands, cfg)
        job.finish_stage(3)
        meta2 = read_json(d / "meta.json", {})
        meta2["step"] = 6
        write_json(d / "meta.json", meta2)

    return submit(job, fn).to_dict()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없어요 (서버가 다시 시작됐을 수 있어요)")
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없어요")
    job.stop.set()
    return job.to_dict()


@app.get("/api/videos/{vid}/result")
def result(vid: str):
    res = read_json(vdir(vid) / "result.json")
    if res is None:
        raise HTTPException(404, "아직 분석 결과가 없어요")
    return res


class EventPatch(BaseModel):
    id: str | None = None
    action: str                     # set_server | clear | remove | restore | add_serve | add_point
    team: str | None = None
    t: float | None = None
    frame: int | None = None


@app.patch("/api/videos/{vid}/events")
def patch_events(vid: str, body: list[EventPatch]):
    d = vdir(vid)
    cfg = read_json(d / "match.json")
    res = read_json(d / "result.json")
    if res is None or cfg is None:
        raise HTTPException(404, "아직 분석 결과가 없어요")
    keep = ("id", "t", "frame", "t_still", "frame_still", "box", "p_near", "view", "seen", "front", "pos", "cues",
            "override", "removed", "kind", "winner")
    evs = [{k: e[k] for k in keep if k in e} for e in res["events"]]
    by = {e["id"]: e for e in evs}
    fps = cfg.get("fps") or 30
    for p in body:
        e = by.get(p.id) if p.id else None
        if p.action in {"set_server", "clear", "remove", "restore"} and e is None:
            raise HTTPException(404, f"이벤트 {p.id} 없음")
        if p.action == "set_server":
            if p.team not in {"A", "B"}:
                raise HTTPException(400, "team은 A 또는 B")
            e["override"] = p.team
            if e.get("kind") == "point":
                e["winner"] = p.team
        elif p.action == "clear":
            e.pop("override", None)
        elif p.action == "remove":
            e["removed"] = True
        elif p.action == "restore":
            e.pop("removed", None)
        elif p.action in {"add_serve", "add_point"}:
            t = p.t if p.t is not None else (p.frame or 0) / fps
            fr = p.frame if p.frame is not None else int(round(t * fps))
            new = {"id": f"m{uuid.uuid4().hex[:6]}", "t": t, "frame": fr, "t_still": t, "frame_still": fr,
                   "box": None, "p_near": 0.5, "manual": True}
            if p.team in {"A", "B"}:
                new["override"] = p.team
            if p.action == "add_point":
                new["kind"] = "point"; new["winner"] = p.team or "A"; new["override"] = p.team or "A"
            evs.append(new); by[new["id"]] = new
        else:
            raise HTTPException(400, f"알 수 없는 action: {p.action}")
    # 수동 추가 이벤트는 manual 표시 유지
    for e in evs:
        if e["id"].startswith("m"):
            e["manual"] = True
    return _rescore(d, evs, cfg)


@app.post("/api/videos/{vid}/rescore")
def rescore(vid: str):
    """설정(시작 점수, 첫 서브 등)을 바꾼 뒤 추적은 그대로 두고 점수만 다시 계산."""
    d = vdir(vid)
    cfg = read_json(d / "match.json")
    res = read_json(d / "result.json")
    if res is None or cfg is None:
        raise HTTPException(404, "아직 분석 결과가 없어요")
    return _rescore(d, res["events"], cfg)


@app.get("/api/videos/{vid}/tracks")
def tracks(vid: str, start: int = 0, end: int | None = None):
    """결과 화면용 선수 위치/관절 (프레임 범위)."""
    d = vdir(vid)
    p = d / "tracks.npz"
    if not p.exists():
        raise HTTPException(404, "추적 결과가 없어요")
    tr = A.load_tracks(p)
    fr = tr["frames"]
    i0 = int(np.searchsorted(fr, start)); i1 = int(np.searchsorted(fr, end if end is not None else fr[-1] + 1))
    i1 = min(i1, i0 + 2000)
    out = {"slots": tr["slots"].tolist(), "frames": fr[i0:i1].tolist(),
           "box": np.round(np.nan_to_num(tr["box"][i0:i1], nan=-1), 1).tolist(),
           "kps": np.round(tr["kps"][i0:i1], 1).tolist()}
    return JSONResponse(out)


class RenderReq(BaseModel):
    mask: bool = False              # 공개용: 머리(head) 모자이크
    exclude: list[int] = Field(default_factory=list)   # 마스킹하지 않을 선수 번호
    scoreboard: bool = True


@app.get("/api/videos/{vid}/players")
def players(vid: str):
    """선수 번호 목록 (복식: 1·2 팀 A, 3·4 팀 B)."""
    from .privacy import players_of
    d = vdir(vid)
    cfg = read_json(d / "match.json")
    if cfg is None:
        raise HTTPException(404, "아직 설정이 없어요")
    return [{k: p[k] for k in ("no", "team", "name")} | {"has_thumb": p["bbox"] is not None} for p in players_of(cfg)]


@app.get("/api/videos/{vid}/players/{no}/thumb")
def player_thumb(vid: str, no: int):
    from .privacy import players_of
    d = vdir(vid)
    cfg = read_json(d / "match.json")
    p = next((p for p in players_of(cfg or {"teams": {}}) if p["no"] == no), None) if cfg else None
    if p is None or p["bbox"] is None:
        raise HTTPException(404, "선수를 찾을 수 없어요")
    img = read_frame(d, cfg["ref_frame"])
    x1, y1, x2, y2 = p["bbox"]
    w, h = x2 - x1, y2 - y1
    x1, y1 = max(0, int(x1 - w * .15)), max(0, int(y1 - h * .08))
    x2, y2 = min(img.shape[1], int(x2 + w * .15)), min(img.shape[0], int(y1 + h * .62))  # 상반신 위주
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        raise HTTPException(404, "선수 영역이 비어 있어요")
    s = 160 / max(crop.shape[:2])
    crop = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), max(1, int(crop.shape[0] * s))), interpolation=cv2.INTER_AREA)
    return Response(jpeg(crop, q=90), media_type="image/jpeg", headers={"Cache-Control": "max-age=600"})


@app.post("/api/videos/{vid}/render")
def render(vid: str, req: RenderReq | None = None):
    """점수 합성 영상(overlay.mp4) 또는 공개용 마스킹 영상(public.mp4) 만들기."""
    req = req or RenderReq()
    d = vdir(vid)
    res = read_json(d / "result.json")
    cfg = read_json(d / "match.json")
    if res is None or cfg is None:
        raise HTTPException(404, "아직 분석 결과가 없어요")
    kind = "public" if req.mask else "render"
    name = "public.mp4" if req.mask else "overlay.mp4"
    meta = read_json(d / "meta.json", {})
    running = meta.get("jobs", {}).get(kind)
    if running in JOBS and JOBS[running].state in {"queued", "running"}:
        return JOBS[running].to_dict()
    job = Job(kind, vid, ["공개용 영상 만들기 (얼굴 모자이크)" if req.mask else "스코어보드 영상 만들기"])

    def fn(job: Job):
        job.stage(0, 0.0, "준비 중")
        masker = None
        if req.mask:
            from .privacy import HeadMasker
            det, _ = models()
            tp = d / "tracks.npz"
            tracks = A.load_tracks(tp) if tp.exists() else None
            masker = HeadMasker(det, cfg, res, tracks, req.exclude, meta.get("fps") or 30.0)
        tmp = d / f"{name}.tmp.mp4"
        render_overlay(str(source_path(d)), str(tmp), res["events"], res["setup"],
                       lambda p, m: job.stage(0, p, m), stop=job.stop, masker=masker, scoreboard_on=req.scoreboard)
        tmp.replace(d / name)
        if masker is not None:
            m2 = read_json(d / "meta.json", {})
            m2["public"] = {"exclude": req.exclude, "scoreboard": req.scoreboard, "masked_heads": masker.count,
                            "updated": time.time()}
            write_json(d / "meta.json", m2)
        job.finish_stage(0, f"머리 {masker.count:,}개 가림" if masker else "")

    return submit(job, fn, GPU_POOL if req.mask else CPU_POOL).to_dict()


@app.get("/api/videos/{vid}/download/{name}")
def download(vid: str, name: str):
    d = vdir(vid)
    allowed = {"result.json": "application/json", "events.csv": "text/csv", "players.csv": "text/csv",
               "match.json": "application/json", "overlay.mp4": "video/mp4", "public.mp4": "video/mp4"}
    if name not in allowed or not (d / name).exists():
        raise HTTPException(404, "파일이 없어요")
    meta = read_json(d / "meta.json", {})
    stem = Path(meta.get("name", vid)).stem
    return FileResponse(d / name, media_type=allowed[name], filename=f"{stem}_{name}")


# ---------------------------------------------------------------- 실험 페이지 (/lab)
from .lab import router as lab_router  # noqa: E402  (main의 함수들을 쓰므로 마지막에 불러온다)

app.include_router(lab_router)

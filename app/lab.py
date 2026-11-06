"""알고리즘 실험 페이지 (/lab) API.

운영 화면과 따로 동작한다. 설정과 결과는 data/videos/<id>/lab/ 에만 저장하고
운영용 match.json · tracks.npz · result.json 은 건드리지 않는다.

  GET  /lab                          실험 페이지
  GET  /api/lab/{vid}                영상 정보 + 실험 설정 + 추적 결과 유무
  PUT  /api/lab/{vid}/config         코트 꼭짓점 · 선수 4명 · 심판 · 경기 설정 저장
  POST /api/lab/{vid}/track          추적 실행 (작업 ID 반환, /api/jobs/{id}로 진행 확인)
  GET  /api/lab/{vid}/tracks         추적 결과 (위치·박스·가려짐·심판 박스)
  GET  /api/lab/{vid}/kps            관절 (int16 바이너리: S×N×17×3, 신뢰도는 ×1000)
  POST /api/lab/{vid}/serves         기준값으로 서브 판정만 다시 계산 (추적은 재사용)
"""
from __future__ import annotations

import dataclasses
import time

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from . import analysis as A
from . import court as C
from .main import GPU_POOL, JOBS, STATIC, Job, models, read_json, source_path, submit, vdir, write_json

router = APIRouter()


def ldir(vid: str):
    d = vdir(vid) / "lab"
    d.mkdir(exist_ok=True)
    return d


def _foot_court(H, b):
    return C.to_court(H, [[(b[0] + b[2]) / 2, b[3]]])[0].round(3).tolist()


@router.get("/lab")
def lab_page():
    return FileResponse(STATIC / "lab" / "index.html")


@router.get("/api/lab/{vid}")
def lab_info(vid: str):
    d = vdir(vid)
    L = ldir(vid)
    meta = read_json(d / "meta.json", {})
    cfg = read_json(L / "config.json")
    seeded = False
    if cfg is None:  # 처음이면 운영 설정의 코트·선수를 가져와 시작점으로 쓴다 (저장은 안 함)
        op = read_json(d / "match.json")
        if op:
            cfg = {"ref_frame": op["ref_frame"], "court_corners_px": op["court_corners_px"],
                   "teams": op["teams"], "officials": op.get("officials", []), "match": op.get("match", {})}
            seeded = True
    jid = meta.get("jobs", {}).get("lab_track")
    job = JOBS[jid].to_dict() if jid in JOBS else read_json(d / "job_lab_track.json")
    return {"meta": meta, "config": cfg, "seeded": seeded, "has_tracks": (L / "tracks.npz").exists(),
            "job": job, "params": dataclasses.asdict(A.Params())}


class TeamIn(BaseModel):
    name: str = ""
    bboxes: list[list[float]] = Field(default_factory=list)


class LabConfig(BaseModel):
    ref_frame: int
    corners: list[list[float]]
    teams: dict[str, TeamIn]                      # "A" / "B"
    officials: list[list[float]] = Field(default_factory=list)
    match: dict = Field(default_factory=dict)


@router.put("/api/lab/{vid}/config")
def lab_put_config(vid: str, body: LabConfig):
    d = vdir(vid)
    if len(body.corners) != 4:
        raise HTTPException(400, "코트 꼭짓점 4개가 필요해요")
    meta = read_json(d / "meta.json", {})
    H = C.homography(body.corners)
    teams = {}
    for key, num in (("A", "1"), ("B", "2")):
        t = body.teams.get(key, TeamIn())
        pos = [_foot_court(H, b) for b in t.bboxes]
        sides = [C.side_of(p[1]) for p in pos]
        side = max(set(sides), key=sides.count) if sides else ("far" if key == "A" else "near")
        teams[num] = {"name": t.name or f"팀 {key}", "bboxes": t.bboxes, "court_pos": pos, "side": side}
    if teams["1"]["side"] == teams["2"]["side"]:
        raise HTTPException(400, "두 팀이 네트의 같은 쪽에 있어요")
    match = {"mode": "doubles", "first": "A", "scoreA": 0, "scoreB": 0, "target": 21, "game": 1}
    match.update(body.match)
    cfg = {"fps": meta.get("fps"), "frame_size": [meta.get("width"), meta.get("height")],
           "ref_frame": body.ref_frame, "court_corners_px": body.corners, "corner_order": C.CORNER_ORDER,
           "homography": H.tolist(), "teams": teams, "match": match,
           "officials": [{"bbox": b, "court_pos": _foot_court(H, b)} for b in body.officials if len(b) >= 4],
           "saved": time.time()}
    write_json(ldir(vid) / "config.json", cfg)
    return cfg


@router.post("/api/lab/{vid}/track")
def lab_track(vid: str):
    d = vdir(vid)
    L = ldir(vid)
    cfg = read_json(L / "config.json")
    if cfg is None:
        raise HTTPException(400, "먼저 설정을 저장해 주세요")
    meta = read_json(d / "meta.json", {})
    jid = meta.get("jobs", {}).get("lab_track")
    if jid in JOBS and JOBS[jid].state in ("queued", "running"):
        return JOBS[jid].to_dict()
    job = Job("lab_track", vid, ["모델 준비", "검출 · 매칭 · 자세"])

    def fn(job: Job):
        job.stage(0, 0.3, "Detector · Pose 불러오는 중")
        ms = models()
        job.finish_stage(0, "GPU" if "CUDA" in ms[0].sess.get_providers()[0] else "CPU")
        t0 = time.time()

        def prog(p, msg):
            el = time.time() - t0
            eta = el / max(p, 1e-3) * (1 - p)
            job.stage(1, p, f"{msg} · 남은 시간 약 {int(eta // 60)}분 {int(eta % 60)}초")

        tr = A.track(str(source_path(d)), cfg, ms, prog, stop=job.stop)
        A.save_tracks(tr, L / "tracks.npz")
        job.finish_stage(1, f"{len(tr['frames']):,}개 샘플 · {time.time() - t0:.0f}초")

    return submit(job, fn, GPU_POOL).to_dict()


def _tracks(vid: str) -> dict:
    p = ldir(vid) / "tracks.npz"
    if not p.exists():
        raise HTTPException(404, "아직 추적 결과가 없어요")
    return A.load_tracks(p)


def _nan_list(a: np.ndarray, nd: int):
    a = np.round(a.astype(np.float64), nd)
    return np.where(np.isnan(a), None, a).tolist()


@router.get("/api/lab/{vid}/tracks")
def lab_tracks(vid: str):
    tr = _tracks(vid)
    S = len(tr["frames"])
    return {"frames": tr["frames"].tolist(), "fps": float(tr["fps"]), "step": int(tr["step"]),
            "slots": [str(s) for s in tr["slots"]],
            "pos": _nan_list(tr["pos"], 3), "box": _nan_list(tr["box"], 1),
            "occ": tr.get("occ", np.zeros(tr["pos"].shape[:2])).astype(int).tolist(),
            "conf": np.round(tr["conf"], 3).tolist(),
            "off_box": _nan_list(tr["off_box"], 1) if "off_box" in tr else [[] for _ in range(S)]}


@router.get("/api/lab/{vid}/kps")
def lab_kps(vid: str):
    k = _tracks(vid)["kps"].astype(np.float32)
    k[..., 2] *= 1000
    return Response(np.round(k).clip(-32768, 32767).astype("<i2").tobytes(), media_type="application/octet-stream",
                    headers={"X-Shape": ",".join(map(str, k.shape))})


class ServeReq(BaseModel):
    params: dict = Field(default_factory=dict)


@router.post("/api/lab/{vid}/serves")
def lab_serves(vid: str, req: ServeReq):
    tr = _tracks(vid)
    cfg = read_json(ldir(vid) / "config.json") or {}
    fields = {f.name for f in dataclasses.fields(A.Params)}
    params = A.Params(**{k: float(v) for k, v in req.params.items() if k in fields})
    dbg: dict = {}
    t0 = time.time()
    serves = A.find_serves(tr, cfg.get("match", {}).get("mode", "doubles"), params, debug=dbg)
    scored, summary = [], None
    if cfg.get("teams"):
        setup = dict(cfg.get("match", {}))
        setup["nameA"], setup["nameB"] = cfg["teams"]["1"]["name"], cfg["teams"]["2"]["name"]
        sides = {"A": cfg["teams"]["1"]["side"], "B": cfg["teams"]["2"]["side"]}
        scored, summary = A.score_events(serves, setup, sides)
    runs = dbg.get("runs", [])
    for r in runs:
        r.pop("i0", None); r.pop("i1", None)
    v = dbg.get("v")
    return {"params": dataclasses.asdict(params), "ms": round((time.time() - t0) * 1000),
            "speed": _nan_list(v, 2) if v is not None else [],
            "still": dbg["still"].astype(int).tolist() if "still" in dbg else [],
            "runs": runs, "serves": scored, "summary": summary}

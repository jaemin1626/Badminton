"""AI-Hub 배드민턴 경기 이미지(TS_*) + 라벨(TL_*) → 우리 형식 주석.

    .venv/bin/python tools/aihub_convert.py                 # 변환 (data/images → data/images/converted)
    .venv/bin/python tools/aihub_convert.py --sheet 24      # 변환 뒤 확인용 이미지(시점별 표본) 만들기

입력
  data/images/datasets/TS_<이름>/<id>.jpg     원천 이미지 (수정하지 않음)
  data/images/labels/TL_<이름>/<id>.json      AI-Hub 라벨 (수정하지 않음)
  TS_/TL_ (검증용 VS_/VL_) 앞 글자만 다르고 뒤 이름과 파일명(확장자 뺀)이 같은 것끼리 짝.

출력 (data/images/converted/)
  ann/<이름>/<id>.json   이미지 1장 주석: 원본 정보 · 코트 꼭짓점 4개 · 호모그래피 · 네트 · 사람(박스·COCO 관절·코트 위치)
  index.jsonl            1줄 = 1장: 경기 종류 · 카메라 · 시점 · 동작 코드 · 서브 여부 · 묶음(clip) · 검증 결과
  report.json            짝 안 맞는 파일 · 검증 실패 수 · 관절 좌우 확인 통계
  sheet_*.jpg            (--sheet) 표본에 우리 코트 라인을 다시 그린 확인용 이미지
  serve.jsonl            사람이 단 서브 라벨 (라벨 페이지가 씀; 이 스크립트는 건드리지 않음)

파일명: B_<날짜>_<소속 CP/CU/CJ>_<경기 MD/WD/XD>_<카메라 R1~8>_<영상>_AM_<랠리>_<동작 대-세>_<구간>_<프레임>
  동작 SRV-* = 서브. 같은 이름에서 마지막 프레임 번호만 다른 것들(3~4장) = 한 묶음(clip).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import court as C  # noqa: E402

ROOT = Path(__file__).resolve().parents[1] / "data" / "images"
PAIR = {"TL_": "TS_", "VL_": "VS_"}
NAME_RE = re.compile(r"B_(\d{6})_([A-Z]+)_([A-Z]+)_(R\d+)_(\d+)_([A-Z]+)_(\d+)_([A-Z]+)-([A-Z]+)_(\d+)_(\d+)$")
# AI-Hub 관절 16개 → COCO 17 자리 (머리는 코 자리, 눈·귀는 없음). neck/chst/bely 는 kpts_src 에만.
KP_MAP = {"head": 0, "sdlf": 5, "sdrt": 6, "eblf": 7, "ebrt": 8, "wtlf": 9, "wtrt": 10,
          "hplf": 11, "hprt": 12, "knlf": 13, "knrt": 14, "aklf": 15, "akrt": 16}
KP_SRC = ["head", "neck", "chst", "bely", "sdlf", "sdrt", "eblf", "ebrt", "wtlf", "wtrt",
          "hplf", "hprt", "knlf", "knrt", "aklf", "akrt"]
EDGE = 3          # 이미지 가장자리(px): 코트 다각형이 여기 닿으면 화면 밖으로 잘린 것
RESID_MAX = 6.0   # 다각형 점 ↔ 꼭짓점 4개로 만든 변 평균 거리(px) 허용
NET_ANG_MAX = 20  # 엔드라인 방향 ↔ 네트 방향 차이(도) 허용


# ---------------------------------------------------------------- 코트

def _line(p, q):
    return np.cross([p[0], p[1], 1.0], [q[0], q[1], 1.0])


def _meet(l1, l2):
    v = np.cross(l1, l2)
    return None if abs(v[2]) < 1e-9 else v[:2] / v[2]


def _seg_dist(pts, a, b):
    ab = b - a
    t = np.clip(((pts - a) @ ab) / max(1e-9, ab @ ab), 0, 1)
    return np.linalg.norm(pts - (a + t[:, None] * ab), axis=1)


def _on_border(p, w, h, tol=EDGE + 2):
    return p[0] <= tol or p[0] >= w - 1 - tol or p[1] <= tol or p[1] >= h - 1 - tol


def quad_from_polygon(pts, w, h):
    """복식 외곽선을 따라 찍은 다각형 → 꼭짓점 4개(순환 순서) · 잔차(px). 실패면 (None, 이유).

    코트가 화면 밖으로 잘리면 다각형에 화면 가장자리를 따라가는 변이 생긴다. 그 변을 빼고 남은 네 변을
    연장해 만나는 점을 꼭짓점으로 쓴다 (꼭짓점이 화면 밖이어도 된다)."""
    hull = cv2.convexHull(pts.astype(np.float32)).reshape(-1, 2).astype(float)
    peri = cv2.arcLength(hull.astype(np.float32), True)
    edges = None
    for eps in np.linspace(0.005, 0.12, 40):
        a = cv2.approxPolyDP(hull.astype(np.float32), eps * peri, True).reshape(-1, 2).astype(float)
        if len(a) < 4:
            break
        e = [(a[i], a[(i + 1) % len(a)]) for i in range(len(a))]
        keep = [k for k, (p, q) in enumerate(e) if not (_on_border(p, w, h) and _on_border(q, w, h))]
        if len(keep) == 4:
            edges = [e[k] for k in keep]          # 순환 순서 유지
            break
    if edges is None:
        return None, "꼭짓점 4개로 줄지 않음"
    inner = np.array([p for p in pts if not _on_border(p, w, h)]) if len(pts) else pts
    # 각 변에 가까운 점들로 직선을 다시 맞추고, 이웃 직선의 교점을 꼭짓점으로
    d = np.stack([_seg_dist(inner, p, q) for p, q in edges], 1)
    own = d.argmin(1)
    lines = []
    for i, (p, q) in enumerate(edges):
        sel = inner[(own == i) & (d.min(1) < 15)]
        if len(sel) >= 2:
            vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            lines.append(_line((x0, y0), (x0 + vx, y0 + vy)))
        else:
            lines.append(_line(p, q))
    ref = []
    for i in range(4):
        c = _meet(lines[i - 1], lines[i])
        if c is None or not (-2 * w < c[0] < 3 * w and -2 * h < c[1] < 3 * h):
            return None, "변 연장 교점이 너무 멂"
        ref.append(c)
    ref = np.array(ref)
    resid = float(np.stack([_seg_dist(inner, ref[i], ref[(i + 1) % 4]) for i in range(4)], 1).min(1).mean())
    return ref, resid


def _signed_area(p):
    return 0.5 * sum(p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1] for i in range(4))


def _dir_angle(u, v):
    a = abs(math.degrees(math.atan2(u[1], u[0]) - math.atan2(v[1], v[0]))) % 180
    return min(a, 180 - a)


def name_corners(q, net_pts):
    """순환 꼭짓점 4개 → [far-left, far-right, near-right, near-left] + 네트 방향 차이(도).

    엔드라인(네트와 평행한 변) 쌍: 두 변이 만나는 소실점 쪽 방향이 네트 다각형의 긴 방향과 가장 비슷한 쪽.
    far = 화면 위쪽(중점 y 작은) 엔드라인. 좌우는 우리 설정과 같은 돌림 방향(화면 좌표 넓이 > 0)."""
    ctr = _meet(_line(q[0], q[2]), _line(q[1], q[3]))
    npts = net_pts - net_pts.mean(0)
    net_dir = np.linalg.svd(npts, full_matrices=False)[2][0]
    best = None
    for k in (0, 1):                      # k=0: (q0q1, q2q3) 가 엔드라인, k=1: (q1q2, q3q0)
        a, b, c, d = (q[k], q[(k + 1) % 4], q[(k + 2) % 4], q[(k + 3) % 4])
        v = _meet(_line(a, b), _line(c, d))
        dirv = (b - a) if v is None or ctr is None or np.linalg.norm(v - ctr) > 1e6 else (v - ctr)
        ang = _dir_angle(dirv, net_dir)
        if best is None or ang < best[0]:
            best = (ang, [a, b, c, d])
    ang, (a, b, c, d) = best              # 순환 a→b→c→d, 엔드라인 = ab, cd
    cyc = [a, b, c, d] if (a[1] + b[1]) < (c[1] + d[1]) else [c, d, a, b]   # far 엔드라인을 앞으로
    if _signed_area(cyc) < 0:             # 돌림 방향을 우리 설정(far-left→far-right→near-right→near-left)과 같게
        cyc = [cyc[1], cyc[0], cyc[3], cyc[2]]
    return np.array(cyc), float(ang)


def view_of(H):
    """카메라가 코트를 보는 방향: 화면 가운데 아래 → 위 방향을 코트 바닥으로 옮긴 각도.
    0° = 엔드라인 뒤(우리 match2), 90° = 옆(사이드라인 쪽)."""
    cpx = C.to_px(H, [[C.W / 2, C.NET]])[0]
    a, b = C.to_court(H, [cpx + [0, 120], cpx])
    dx, dy = b - a
    yaw = math.degrees(math.atan2(abs(dx), abs(dy)))
    return yaw, ("end" if yaw < 20 else "diag" if yaw < 55 else "side")


# ---------------------------------------------------------------- 1장 변환

def parse_name(stem):
    m = NAME_RE.match(stem)
    if not m:
        return None
    g = m.groups()
    return {"date": g[0], "org": g[1], "match": g[2], "cam": g[3], "video": int(g[4]), "rally": int(g[6]),
            "action": f"{g[7]}-{g[8]}", "act_main": g[7], "seg": int(g[9]), "frame": int(g[10])}


def convert_one(job):
    folder, stem, img_rel, lab_path, out_path = job
    nm = parse_name(stem)
    j = json.load(open(lab_path, encoding="utf-8"))
    raw = j.get("rawDataInfo", {})
    anns = j.get("learningDataInfo", {}).get("annotations", [])
    w, h = (int(x) for x in str(raw.get("resolution", "1920*1080")).split("*"))
    checks = []
    court = {"src": "aihub"}
    poly = next((np.array(a["polygon"], float).reshape(-1, 2) for a in anns if a["class"] == "court"), None)
    netp = next((np.array(a["polygon"], float).reshape(-1, 2) for a in anns if a["class"] == "net"), None)
    H = None
    if poly is None:
        checks.append("코트 없음")
    else:
        court["polygon_px"] = poly.round(1).tolist()
        clipped = bool(((poly[:, 0] <= EDGE) | (poly[:, 0] >= w - 1 - EDGE) | (poly[:, 1] <= EDGE) | (poly[:, 1] >= h - 1 - EDGE)).any())
        court["clipped"] = clipped               # 정보만 (잘려도 변을 연장해 꼭짓점을 구함)
        q, resid = quad_from_polygon(poly, w, h)
        if q is None:
            checks.append(resid)
        elif netp is None:
            checks.append("네트 없음")
        else:
            corners, net_ang = name_corners(q, netp)
            H = C.homography(corners)
            yaw, view = view_of(H)
            court.update({
                "points": [{"court": list(map(float, c)), "px": [round(float(x), 1) for x in p]}
                           for c, p in zip(C.COURT.tolist(), corners)],
                "corner_names": C.CORNER_ORDER,
                "homography": H.tolist(),
                "resid_px": round(resid, 2), "net_angle": round(net_ang, 1),
                "yaw": round(yaw, 1), "view": view,
            })
            if resid > RESID_MAX:
                checks.append(f"외곽선 잔차 {resid:.1f}px")
            if net_ang > NET_ANG_MAX:
                checks.append(f"네트 방향 차이 {net_ang:.0f}°")
    net = None
    if netp is not None:
        net = {"polygon_px": netp.round(1).tolist()}
        if H is not None:
            net["line_px"] = C.to_px(H, [[0, C.NET], [C.W, C.NET]]).round(1).tolist()  # 바닥의 네트 선
    people = []
    np_, nu = 0, 0
    for a in anns:
        c = a["class"]
        if c not in ("player", "umpire"):
            continue
        x, y, bw, bh = a["bbox"]
        p = {"role": c, "bbox": [x, y, x + bw, y + bh], "src": "gt"}
        if c == "player":
            kp = a.get("keypoint", {})
            coco = np.zeros((17, 3))
            for k, i in KP_MAP.items():
                if k in kp:
                    coco[i] = kp[k]
            p["kpts"] = coco.astype(int).tolist()
            p["kpts_src"] = [kp.get(k, [0, 0, 0]) for k in KP_SRC]
            if H is not None:
                conf = coco.copy(); conf[:, 2] = conf[:, 2] / 2          # v 1(가려짐)·2(보임) → 0.5·1.0
                fx, fy = C.foot_point(p["bbox"], conf)
                cp = C.to_court(H, [[fx, fy]])[0]
                p["foot_px"] = [round(fx, 1), round(fy, 1)]
                p["court_pos"] = [round(float(cp[0]), 3), round(float(cp[1]), 3)]
                p["side"] = C.side_of(cp[1])
            np_ += 1
        else:
            nu += 1
        people.append(p)
    pl = [p for p in people if p["role"] == "player"]
    if np_ != 4:
        checks.append(f"선수 {np_}명")
    if H is not None and pl:
        out = [p for p in pl if not C.in_play(p["court_pos"])]
        if out:
            checks.append(f"코트 밖 선수 {len(out)}")
        sides = Counter(p["side"] for p in pl)
        if np_ == 4 and (sides["far"] != 2 or sides["near"] != 2):
            checks.append(f"네트 양쪽 선수 수 {dict(sides)}")
    # 선수 번호: far 먼저, 같은 쪽은 화면 왼쪽부터 (f1 f2 n1 n2). 코트 계산 실패면 p1..p4
    if H is not None and pl:
        pl.sort(key=lambda p: (p["side"] != "far", p["court_pos"][0]))
        cnt = Counter()
        for p in pl:
            cnt[p["side"]] += 1
            p["pid"] = ("f" if p["side"] == "far" else "n") + str(cnt[p["side"]])
    else:
        for i, p in enumerate(pl):
            p["pid"] = f"p{i + 1}"
    for i, p in enumerate([p for p in people if p["role"] == "umpire"]):
        p["pid"] = f"u{i + 1}"
    people = pl + [p for p in people if p["role"] == "umpire"]
    clip = stem.rsplit("_", 1)[0]
    ann = {
        "id": stem,
        "image": {"file": img_rel, "w": w, "h": h},
        "source": {"dataset": "aihub", "folder": folder, "label_json": os.path.relpath(lab_path, ROOT),
                   **nm, "raw_video": raw.get("rawDataId"), "fps": raw.get("fps"),
                   "tournament": raw.get("tournamentName"), "court_no": raw.get("courtNumber")},
        "seq": {"clip": clip, "frame": nm["frame"]},
        "court": court, "net": net, "people": people,
        "checks": checks,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(ann, f, ensure_ascii=False)
    # 관절 좌우 확인: 엔드/대각 시점에서 near 선수(등이 카메라 쪽)는 왼어깨가 화면 왼쪽, far 선수는 반대여야
    lr = []
    if court.get("view") in ("end", "diag"):
        for p in pl:
            l, r = p["kpts"][5], p["kpts"][6]
            if l[2] and r[2] and abs(l[0] - r[0]) > 4:
                lr.append((p["side"], l[0] < r[0]))
    idx = {"id": stem, "ann": os.path.relpath(out_path, ROOT / "converted"), "img": img_rel, "folder": folder,
           "match": nm["match"], "org": nm["org"], "cam": nm["cam"], "date": nm["date"],
           "action": nm["action"], "is_serve": nm["act_main"] == "SRV", "clip": clip, "frame": nm["frame"],
           "view": court.get("view"), "yaw": court.get("yaw"), "n_players": np_, "n_umpires": nu,
           "ok": not checks, "checks": checks}
    return idx, lr


# ---------------------------------------------------------------- 전체

def pair_jobs(out_dir):
    lb, ds = ROOT / "labels", ROOT / "datasets"
    jobs, report = [], {"폴더 짝 없음": [], "json만 있음": [], "이미지만 있음": [], "이름 규칙 벗어남": []}
    for d in sorted(os.listdir(lb)):
        pre = d[:3]
        if pre not in PAIR or not (lb / d).is_dir():
            continue
        name = d[3:]
        sd = ds / (PAIR[pre] + name)
        if not sd.is_dir():
            report["폴더 짝 없음"].append(d)
            continue
        J = {f[:-5] for f in os.listdir(lb / d) if f.endswith(".json")}
        I = {}
        for f in os.listdir(sd):
            st, ext = os.path.splitext(f)
            if ext.lower() in (".jpg", ".jpeg", ".png"):
                I[st] = f
        report["json만 있음"] += [f"{d}/{s}" for s in sorted(J - set(I))]
        report["이미지만 있음"] += [f"{sd.name}/{I[s]}" for s in sorted(set(I) - J)]
        for st in sorted(J & set(I)):
            if not NAME_RE.match(st):
                report["이름 규칙 벗어남"].append(st)
                continue
            jobs.append((name, st, os.path.relpath(sd / I[st], ROOT), str(lb / d / (st + ".json")),
                         str(out_dir / "ann" / name / (st + ".json"))))
    for d in sorted(os.listdir(ds)):
        if (ds / d).is_dir() and d[:3] in PAIR.values() and not (lb / ({v: k for k, v in PAIR.items()}[d[:3]] + d[3:])).is_dir():
            report["폴더 짝 없음"].append(d)
    return jobs, report


def sheet(out_dir, n):
    """시점(end/diag/side)별 표본에 우리 코트 라인(호모그래피로 되그림)·꼭짓점 이름·선수 번호를 그린 확인용 이미지."""
    rows = [json.loads(l) for l in open(out_dir / "index.jsonl", encoding="utf-8")]
    rng = np.random.default_rng(0)
    for view in ("end", "diag", "side", None):
        cand = [r for r in rows if r["view"] == view and (view is not None or not r["ok"])]
        if view is None:
            cand = [r for r in rows if not r["ok"]]
        if not cand:
            continue
        pick = [cand[i] for i in rng.choice(len(cand), min(n, len(cand)), replace=False)]
        tiles = []
        for r in pick:
            a = json.load(open(out_dir / r["ann"], encoding="utf-8"))
            img = cv2.imread(str(ROOT / a["image"]["file"]))
            if a["court"].get("polygon_px"):
                cv2.polylines(img, [np.int32(a["court"]["polygon_px"])], True, (0, 200, 255), 2)
            if a["court"].get("homography"):
                H = np.array(a["court"]["homography"])
                for ln in C.court_lines():
                    p = C.to_px(H, ln).astype(int)
                    cv2.line(img, tuple(p[0]), tuple(p[1]), (0, 255, 0), 3)
                nl = np.int32(a["net"]["line_px"])
                cv2.line(img, tuple(nl[0]), tuple(nl[1]), (255, 0, 255), 5)
                for nmc, pt in zip(["FL", "FR", "NR", "NL"], a["court"]["points"]):
                    x, y = map(int, pt["px"])
                    cv2.circle(img, (x, y), 12, (0, 0, 255), -1)
                    cv2.putText(img, nmc, (x + 12, y - 12), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 255), 4)
            for p in a["people"]:
                x1, y1, x2, y2 = p["bbox"]
                col = (255, 255, 255) if p["role"] == "umpire" else (255, 80, 0) if p.get("side") == "far" else (0, 80, 255)
                cv2.rectangle(img, (x1, y1), (x2, y2), col, 3)
                cv2.putText(img, p["pid"], (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 1.4, col, 4)
                if p["role"] == "player":
                    k = p["kpts"]
                    for i, c in ((5, (0, 255, 255)), (6, (255, 0, 255))):   # 왼어깨 노랑, 오른어깨 자주
                        if k[i][2]:
                            cv2.circle(img, tuple(k[i][:2]), 9, c, -1)
                    if p.get("foot_px"):
                        cv2.circle(img, tuple(map(int, p["foot_px"])), 8, (0, 0, 0), -1)
            lab = f'{r["view"]} {r["yaw"]} {r["cam"]} {r["action"]} ' + (" / ".join(r["checks"]) if r["checks"] else "ok")
            cv2.rectangle(img, (0, 0), (1920, 70), (0, 0, 0), -1)
            cv2.putText(img, r["id"][9:], (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
            cv2.putText(img, lab.encode("ascii", "replace").decode(), (15, 62), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
            tiles.append(cv2.resize(img, (640, 360)))
        while len(tiles) % 4:
            tiles.append(np.zeros_like(tiles[0]))
        grid = np.vstack([np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)])
        out = out_dir / f"sheet_{view or 'fail'}.jpg"
        cv2.imwrite(str(out), grid, [cv2.IMWRITE_JPEG_QUALITY, 82])
        print("확인용 이미지", out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "converted"))
    ap.add_argument("--sheet", type=int, default=0, help="시점별 표본 수 (0 = 만들지 않음)")
    ap.add_argument("--sheet-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="앞에서 N장만 (시험용)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args()
    out_dir = Path(a.out)
    if not a.sheet_only:
        jobs, report = pair_jobs(out_dir)
        if a.limit:
            jobs = jobs[::max(1, len(jobs) // a.limit)][:a.limit]
        print(f"짝 맞은 이미지 {len(jobs)}장 · " + " · ".join(f"{k} {len(v)}" for k, v in report.items()))
        out_dir.mkdir(parents=True, exist_ok=True)
        rows, lr = [], Counter()
        with ProcessPoolExecutor(a.workers) as ex:
            for i, (idx, l) in enumerate(ex.map(convert_one, jobs, chunksize=64)):
                rows.append(idx)
                for side, left_on_left in l:
                    lr[(side, left_on_left)] += 1
                if (i + 1) % 5000 == 0:
                    print(f"  {i + 1}/{len(jobs)}", flush=True)
        with open(out_dir / "index.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        chk = Counter(re.sub(r"[\d.]+", "N", c) for r in rows for c in r["checks"])
        near_ok = lr[("near", True)] / max(1, lr[("near", True)] + lr[("near", False)])
        far_ok = lr[("far", False)] / max(1, lr[("far", True)] + lr[("far", False)])
        summary = {
            "이미지": len(rows), "검증 통과": sum(r["ok"] for r in rows),
            "시점": Counter(r["view"] for r in rows), "경기": Counter(r["match"] for r in rows),
            "서브 이미지": sum(r["is_serve"] for r in rows),
            "서브 묶음": len({r["clip"] for r in rows if r["is_serve"]}),
            "검증 실패 이유": chk.most_common(),
            "관절 좌우(엔드·대각)": {"near 선수 왼어깨가 화면 왼쪽": round(near_ok, 3),
                                "far 선수 왼어깨가 화면 오른쪽": round(far_ok, 3)},
            "짝 확인": {k: v for k, v in report.items()},
        }
        json.dump(summary, open(out_dir / "report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(json.dumps({k: v for k, v in summary.items() if k != "짝 확인"}, ensure_ascii=False, indent=1))
        print("짝 안 맞음:", {k: v for k, v in report.items() if v})
    if a.sheet:
        sheet(out_dir, a.sheet)


if __name__ == "__main__":
    main()

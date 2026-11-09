"""가짜 라벨(serve_pseudo.jsonl)을 한꺼번에 정답(serve.jsonl)으로 옮기기.

사람 라벨이 이미 있는 묶음은 건너뜀. 옮긴 줄에는 from_pseudo=true, bulk=true, pseudo_prob 를 남겨서
나중에 '한꺼번에 받아들인 것'만 골라 보거나 되돌릴 수 있다 (serve.jsonl 은 덧붙이기라, 되돌리기 = 그 줄들을 지우기).

  .venv/bin/python tools/pseudo_accept.py [--views end,diag,side] [--min-prob 0]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CONV = ROOT / "data" / "images" / "converted"


def rec_for(ps):
    import app.main  # noqa: F401
    from app import imglabel as IL
    d = IL.clip_detail(ps["clip"])
    t = ps["server_track"]
    servers = {f["id"]: p["pid"] for f in d["frames"] for p in f["players"] if p.get("track") == t}
    sg = d.get("suggest") or {}
    return {"clip": d["clip"], "status": "serve", "server_track": t, "servers": servers,
            "code_serve": d["code_serve"], "view": d["view"], "match": d["match"], "cam": d["cam"],
            "action": d["action"], "frames": [f["id"] for f in d["frames"]], "note": None,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "from_pseudo": True, "bulk": True,
            "pseudo_prob": ps["prob"], "pseudo_model": ps.get("model"),
            "suggest_track": sg.get("track"), "suggest_p_near": sg.get("p_near")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--views", default="end,diag,side")
    ap.add_argument("--min-prob", type=float, default=0.0)
    a = ap.parse_args()
    views = set(a.views.split(","))
    labs = {json.loads(l)["clip"] for l in open(CONV / "serve.jsonl", encoding="utf-8") if l.strip()}
    ps = [json.loads(l) for l in open(CONV / "serve_pseudo.jsonl", encoding="utf-8")]
    todo = [p for p in ps if p["clip"] not in labs and p["view"] in views and p["prob"] >= a.min_prob]
    print(f"가짜 라벨 {len(ps)} · 이미 정답 {len(ps) - len([p for p in ps if p['clip'] not in labs])} · 옮길 것 {len(todo)}")
    with ProcessPoolExecutor(16) as ex:
        recs = list(ex.map(rec_for, todo, chunksize=8))
    # 쓰는 사이 사람이 저장한 묶음은 빼고 덧붙임
    labs = {json.loads(l)["clip"] for l in open(CONV / "serve.jsonl", encoding="utf-8") if l.strip()}
    recs = [r for r in recs if r["clip"] not in labs]
    with open(CONV / "serve.jsonl", "a", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    from collections import Counter
    print(f"정답으로 옮김 {len(recs)} · 시점 {dict(Counter(r['view'] for r in recs))} · 장별 서버 빠진 것 {sum(1 for r in recs if len(r['servers']) < len(r['frames']))}")


if __name__ == "__main__":
    main()

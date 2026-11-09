"""정답 라벨(data/labels/<영상>.json) 기준 스코어보드 영상 만들기 → data/videos/<영상>/truth_overlay.mp4

정답 라벨 = 서브마다 {t: 서브 시각, server: 이 서브를 넣은 팀(= 직전 랠리 득점 팀)} + 최종 점수.
  j번 서브 때 점수 = 2~j번 서브의 서버 팀 수 (첫 서브는 0:0).
  점수가 바뀌는 시각 = 서브 준비 정지 시작(알고리즘이 잡은 같은 서브의 t_still, 3초 안에 없으면 서브 1초 전).
  마지막 랠리 득점(최종 점수에서 하나 남는 팀)은 마지막 서브 LAST_RALLY 초 뒤에 올림 (랠리 끝 시각 라벨이 없어서 어림).
이름·대회 표시는 운영 분석 결과(result.json)의 설정을 그대로 쓰고, 첫 서버만 정답 라벨로 바꾼다.

  .venv/bin/python tools/render_truth.py 20261108_match1 20261108_match2 ...
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.render import render_overlay  # noqa: E402

DATA = ROOT / "data"
LAST_RALLY = 10.0


def truth_events(vid: str):
    lab = json.load(open(DATA / "labels" / f"{vid}.json", encoding="utf-8"))
    res = json.load(open(DATA / "videos" / vid / "result.json", encoding="utf-8"))
    meta = json.load(open(DATA / "videos" / vid / "meta.json", encoding="utf-8"))
    fps = float(res.get("fps") or 30.0)
    dur = float(meta.get("duration") or 1e9)
    marks = sorted(lab["marks"], key=lambda m: m["t"])
    srv = [m["server"] for m in marks]
    fin = lab["final"]
    a, b = srv[1:].count("A"), srv[1:].count("B")
    last = "A" if (a + 1, b) == (fin["A"], fin["B"]) else "B" if (a, b + 1) == (fin["A"], fin["B"]) else None
    if last is None:
        raise SystemExit(f"{vid}: 서버 라벨 {a}:{b} 로 최종 점수 {fin} 를 못 맞춤")
    stills = sorted(e.get("t_still", e["t"]) for e in res["events"])
    events, sc = [], {"A": 0, "B": 0}
    for j, m in enumerate(marks):
        if j:
            sc[m["server"]] += 1
        near = [s for s in stills if m["t"] - 3.0 <= s <= m["t"] + 0.3]
        t0 = max(near) if near else m["t"] - 1.0
        events.append({"t": m["t"], "frame": int(round(m["t"] * fps)), "frame_still": int(round(t0 * fps)),
                       "server": m["server"], "score": dict(sc), "game": 1})
    sc[last] += 1
    tl = min(marks[-1]["t"] + LAST_RALLY, dur - 1.0)
    events.append({"t": tl, "frame": int(round(tl * fps)), "frame_still": int(round(tl * fps)),
                   "server": last, "score": dict(sc), "game": 1})
    setup = {**res["setup"], "first": srv[0], "scoreA": 0, "scoreB": 0}
    return events, setup


def main(vids):
    for vid in vids:
        d = DATA / "videos" / vid
        events, setup = truth_events(vid)
        fin = events[-1]["score"]
        print(f"{vid}: 서브 {len(events) - 1}개 · 첫 서버 {setup['first']} · 최종 {fin['A']}:{fin['B']}", flush=True)
        src = d / json.load(open(d / "meta.json", encoding="utf-8")).get("file", "source.mp4")
        tmp, out = d / "truth_overlay.tmp.mp4", d / "truth_overlay.mp4"
        t0 = time.time()
        last = [0.0]

        def prog(p, msg):
            if p - last[0] >= 0.1:
                last[0] = p
                print(f"  {vid} {p * 100:.0f}% ({msg})", flush=True)
        render_overlay(str(src), str(tmp), events, setup, prog)
        tmp.replace(out)
        print(f"  → {out} ({out.stat().st_size / 1e6:.0f}MB, {time.time() - t0:.0f}초)", flush=True)
        json.dump({"events": events, "setup": setup}, open(d / "truth_overlay.json", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:] or [f"20261108_match{i}" for i in range(1, 5)])

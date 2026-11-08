"""점수 오버레이 영상 만들기 (스코어보드를 영상 왼쪽 위에 합성, H.264 + 원본 오디오)."""
from __future__ import annotations

import bisect
import subprocess
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent / "assets"


def _hex(c: str):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


TEAM = {"A": _hex("#2f6ff2"), "B": _hex("#f2553f")}
ACCENT, ACCENT_INK = _hex("#c8f03c"), _hex("#1d2a00")


@lru_cache(maxsize=None)
def _font(name: str, size: int, weight: int | None = None):
    f = ImageFont.truetype(str(ASSETS / name), size)
    if weight is not None:
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
    return f


def scoreboard(state: dict, setup: dict, scale: float, pop: float = 0.0) -> Image.Image:
    """state: {score:{A,B}, server, game}. pop: 0~1 (점수 바뀐 직후 강조)."""
    s = scale
    ours = setup.get("ours", "A"); opp = "B" if ours == "A" else "A"
    names = {"A": setup.get("nameA", "팀 A"), "B": setup.get("nameB", "팀 B")}
    Wd, RH, top = int(380 * s), int(58 * s), int(30 * s)
    Ht = top + RH * 2 + int(8 * s)
    img = Image.new("RGBA", (Wd + 4, Ht + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, Wd, Ht], radius=int(14 * s), fill=(8, 14, 11, 220), outline=(255, 255, 255, 30))
    mode = "복식" if setup.get("mode", "doubles") == "doubles" else "단식"
    head = f"GAME {state.get('game', 1)} · {setup.get('target', 21)}점 · {mode}"
    d.text((int(16 * s), int(21 * s)), head, font=_font("NotoSansKR.ttf", int(13 * s), 700), fill=ACCENT, anchor="ls")
    rows = ((opp, "상대"), (ours, "우리"))
    if setup.get("ours_row") == "top":   # 우리 팀을 윗줄로
        rows = rows[::-1]
    for i, (t, label) in enumerate(rows):
        y = top + i * RH
        if i == 1:
            d.line([int(12 * s), y, Wd - int(12 * s), y], fill=(255, 255, 255, 26), width=max(1, int(s)))
        d.rounded_rectangle([int(12 * s), y + int(10 * s), int(19 * s), y + RH - int(10 * s)], radius=int(3 * s), fill=TEAM[t])
        nf = _font("NotoSansKR.ttf", int(22 * s), 700)
        nm = names[t]
        while d.textlength(nm, font=nf) > 150 * s and len(nm) > 1:
            nm = nm[:-1]
        if nm != names[t]:
            nm = nm[:-1] + "…"
        d.text((int(32 * s), y + RH // 2), nm, font=nf, fill=(255, 255, 255), anchor="lm")
        tx = int(32 * s + d.textlength(nm, font=nf) + 10 * s)
        tf = _font("NotoSansKR.ttf", int(12 * s), 700)
        mine = label == "우리"
        d.rounded_rectangle([tx, y + RH // 2 - int(11 * s), tx + int(40 * s), y + RH // 2 + int(11 * s)], radius=int(6 * s),
                            fill=ACCENT if mine else (255, 255, 255, 36))
        d.text((tx + int(20 * s), y + RH // 2), label, font=tf, fill=ACCENT_INK if mine else (207, 216, 210), anchor="mm")
        if state.get("server") == t:  # 셔틀콕 아이콘
            cx, cy, r = Wd - int(118 * s), y + RH // 2, int(13 * s)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
            d.polygon([(cx - 4 * s, cy + 4 * s), (cx - 6 * s, cy - 6 * s), (cx + 6 * s, cy - 6 * s), (cx + 4 * s, cy + 4 * s)],
                      outline=ACCENT_INK, width=max(1, int(1.8 * s)))
            d.ellipse([cx - 3 * s, cy + 2 * s, cx + 3 * s, cy + 8 * s], fill=ACCENT_INK)
        bx = [Wd - int(86 * s), y + int(6 * s), Wd - int(12 * s), y + RH - int(6 * s)]
        base = tuple(int(c * 0.85) for c in TEAM[t])
        hit = pop if state.get("changed") == t else 0.0
        fill = tuple(int(b + (a - b) * hit) for a, b in zip(ACCENT, base)) if hit else base
        d.rounded_rectangle(bx, radius=int(10 * s), fill=fill)
        sf = _font("BarlowCondensed-ExtraBold.ttf", int(40 * s * (1 + 0.35 * hit)))
        d.text(((bx[0] + bx[2]) // 2, (bx[1] + bx[3]) // 2 + int(1 * s)), str(state["score"][t]), font=sf,
               fill=ACCENT_INK if hit > 0.5 else (255, 255, 255), anchor="mm")
    return img


def timeline_states(events: list, setup: dict):
    """프레임 → 표시 상태. 점수는 서브 준비(정지 시작) 시점에 바뀐다."""
    st = {"A": int(setup.get("scoreA", 0)), "B": int(setup.get("scoreB", 0))}
    keys, states = [0], [{"score": dict(st), "server": setup.get("first", "A"), "game": 1, "changed": None}]
    for ev in events:
        if ev.get("removed") or ev.get("server") is None:
            continue
        prev = states[-1]
        changed = None
        for t in ("A", "B"):
            if ev["score"][t] != prev["score"][t] and ev.get("game", 1) == prev["game"]:
                changed = t
        keys.append(int(ev.get("frame_still", ev["frame"])))
        states.append({"score": dict(ev["score"]), "server": ev["server"], "game": ev.get("game", 1), "changed": changed})
    return keys, states


def title_text(setup: dict) -> str:
    """오른쪽 위 글: '대회명 / 종목 급수' (예: 한국건강관리협회 / 혼복 D조). 없는 건 뺀다."""
    t = str(setup.get("tournament") or "").strip()
    g = " ".join(x for x in (str(setup.get("event") or "").strip(), str(setup.get("division") or "").strip()) if x)
    return " / ".join(x for x in (t, g) if x)


def title_card(setup: dict, scale: float):
    """오른쪽 위 대회 표시: [▌대회명  (종목 급수)]. 대회명은 흰 글씨, 종목·급수는 강조색 알약."""
    tour = str(setup.get("tournament") or "").strip()
    tag = " ".join(x for x in (str(setup.get("event") or "").strip(), str(setup.get("division") or "").strip()) if x)
    if not tour and not tag:
        return None
    s = scale
    ft = _font("NotoSansKR.ttf", int(21 * s), 700)
    fg = _font("NotoSansKR.ttf", int(17 * s), 800)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    H = int(50 * s)
    bar_x, bar_w = int(14 * s), int(5 * s)
    x = bar_x + bar_w + int(12 * s)
    tw = int(probe.textlength(tour, font=ft)) if tour else 0
    gw = int(probe.textlength(tag, font=fg)) + int(26 * s) if tag else 0
    gap = int(12 * s) if tour and tag else 0
    W = x + tw + gap + gw + int(10 * s)
    img = Image.new("RGBA", (W + 2, H + 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, H], radius=int(14 * s), fill=(8, 14, 11, 225), outline=(255, 255, 255, 34))
    d.rounded_rectangle([bar_x, int(13 * s), bar_x + bar_w, H - int(13 * s)], radius=int(3 * s), fill=ACCENT)
    if tour:
        d.text((x, H // 2), tour, font=ft, fill=(255, 255, 255), anchor="lm")
    if tag:
        gx = x + tw + gap
        d.rounded_rectangle([gx, int(10 * s), gx + gw, H - int(10 * s)], radius=int(9 * s), fill=ACCENT)
        d.text((gx + gw // 2, H // 2 + int(1 * s)), tag, font=fg, fill=ACCENT_INK, anchor="mm")
    return img


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def render_overlay(src: str, out: str, events: list, setup: dict, progress=None, stop=None,
                   masker=None, scoreboard_on: bool = True, batch: int = 8):
    """점수 합성 영상. masker가 있으면 프레임 묶음마다 masker.apply(frames, idx)로 마스킹(공개용)."""
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    scale = W / 1600 * 1.0
    margin = int(24 * scale)
    keys, states = timeline_states(events, setup)
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", f"{fps}", "-i", "-",
           "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    cache = {}
    pop_frames = int(fps * 0.6)

    title = title_card(setup, scale) if scoreboard_on else None
    if title is not None:
        ta = np.asarray(title)
        t_rgb, t_a = ta[:, :, 2::-1].astype(np.float32), ta[:, :, 3:4].astype(np.float32) / 255.0
        th, tw = t_rgb.shape[:2]
        tx = max(0, W - margin - tw)

    def draw_title(img):
        roi = img[margin:margin + th, tx:tx + tw]
        h2, w2 = roi.shape[:2]
        roi[:] = (roi.astype(np.float32) * (1 - t_a[:h2, :w2]) + t_rgb[:h2, :w2] * t_a[:h2, :w2]).astype(np.uint8)

    def draw_board(img, f):
        k = bisect.bisect_right(keys, f) - 1
        since = f - keys[k]
        pop = max(0.0, 1 - since / pop_frames) if (states[k]["changed"] and since < pop_frames) else 0.0
        pop = round(pop * 6) / 6  # 캐시를 위해 단계화
        ck = (k, pop)
        if ck not in cache:
            arr = np.asarray(scoreboard(states[k], setup, scale, pop))
            cache[ck] = (arr[:, :, 2::-1].astype(np.float32), arr[:, :, 3:4].astype(np.float32) / 255.0)
            if len(cache) > 64:
                cache.pop(next(iter(cache)))
        rgb, a = cache[ck]
        h, w = rgb.shape[:2]
        roi = img[margin:margin + h, margin:margin + w]
        h2, w2 = roi.shape[:2]
        roi[:] = (roi.astype(np.float32) * (1 - a[:h2, :w2]) + rgb[:h2, :w2] * a[:h2, :w2]).astype(np.uint8)

    try:
        f = 0
        done = False
        while not done:
            if stop is not None and stop.is_set():
                raise InterruptedError("취소됨")
            imgs, idx = [], []
            for _ in range(batch):
                ok, img = cap.read()
                if not ok:
                    done = True
                    break
                imgs.append(img); idx.append(f); f += 1
            if not imgs:
                break
            if masker is not None:
                masker.apply(imgs, idx)  # 스코어보드보다 먼저 (스코어보드는 가리지 않게)
            for img, fi in zip(imgs, idx):
                if scoreboard_on:
                    draw_board(img, fi)
                if title is not None:
                    draw_title(img)
                proc.stdin.write(img.tobytes())
            if progress and (f // batch) % 4 == 0:
                progress(f / max(total, 1), f"{f:,} / {total:,} 프레임")
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg 실패: " + proc.stderr.read().decode(errors="ignore")[-800:])
    finally:
        cap.release()
        if proc.poll() is None:
            proc.kill()


def make_preview(src: str, out: str, progress=None, total_frames: int = 0):
    """브라우저 재생용 H.264 720p 사본."""
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-progress", "pipe:1", "-i", src,
           "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for line in proc.stdout:
        if progress and line.startswith("frame=") and total_frames:
            try:
                progress(int(line.split("=")[1]) / total_frames, "브라우저용 영상 변환 중")
            except ValueError:
                pass
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg 실패: " + proc.stderr.read()[-800:])

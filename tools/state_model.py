"""경기 상태 모델 1차 (실험): 선수 4명의 위치·속도·관절 시계열 → 프레임마다 '여기서 서브' 확률.

지금은 영상 정답 라벨(서브 시각)만 있어서 상태 5개(대기/준비/서브/랠리/랠리 끝) 중 '서브'만 학습한다.
앞뒤 약 ±4초를 보는 TCN 이라, 랠리 도중 잠깐 멈춘 장면(가짜 서브)과 진짜 서브 준비를 앞뒤 흐름으로 구분하길 기대.

검증: 영상 하나를 빼고 학습 → 뺀 영상에서
  (a) 모델만으로 서브 찾기: 확률 봉우리 = 서브 → 정답과 3초 안 짝 (맞음 / 가짜 / 놓침), 지금 규칙과 비교
  (b) 지금 규칙의 서브 후보마다 모델 점수 → 진짜/가짜 가르기 (지금 규칙·간단 분류기와 비교)

  .venv/bin/python tools/state_model.py --tracks 20161110_match5=경로.npz
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
from app import analysis as A  # noqa: E402
import video_train as T  # noqa: E402

W, L, NET = 6.1, 13.4, 6.7
FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]   # COCO 좌우 바꾸기
POS_HALF = 0.4      # s, 정답 서브 시각 ± 이만큼을 '서브' 프레임으로
MATCH_TOL = 3.0     # s, 정답과 짝 허용


# ---------------------------------------------------------------- 입력

def frame_feats(tr: dict):
    """[T, 4, F] 선수별 특징 + [T, 2] 쪽 정보. 선수 순서 = 먼 쪽 앞·뒤, 가까운 쪽 앞·뒤 (네트 거리로 매 프레임 정렬)"""
    t = tr["t"].astype(np.float64)
    p, dt = A._interp_smooth(tr["pos"].astype(np.float64), t, 0.45)
    lag = max(1, int(round(0.2 / dt)))
    vel = np.zeros_like(p); vel[lag:-lag] = (p[2 * lag:] - p[:-2 * lag]) / (2 * lag * dt)
    vel = np.nan_to_num(vel)
    box = tr["box"].astype(np.float64); kps = tr["kps"].astype(np.float64)
    h = np.maximum(box[..., 3] - box[..., 1], 1.0)
    cx = (box[..., 0] + box[..., 2]) / 2; cy = (box[..., 1] + box[..., 3]) / 2
    kx = (kps[..., 0] - cx[..., None]) / h[..., None]; ky = (kps[..., 1] - cy[..., None]) / h[..., None]
    kc = kps[..., 2]; ok = kc >= 0.3
    kx = np.where(ok, kx, 0); ky = np.where(ok, ky, 0)
    seen = ~np.isnan(tr["pos"][..., 0])
    known = ~np.isnan(p[..., 0])
    occ = tr["occ"].astype(bool) if tr.get("occ") is not None else np.zeros(seen.shape, bool)
    # 키(박스 높이)를 그 선수 평소 키로 나눔: 웅크림·점프
    hm = np.array([np.nanmedian(np.where(seen[:, k], h[:, k], np.nan)) if seen[:, k].any() else 1.0 for k in range(h.shape[1])])
    hr = np.where(seen, h / np.maximum(hm, 1), 0)
    pp = np.nan_to_num(p)
    sp = np.linalg.norm(vel, axis=-1)
    F = np.concatenate([
        (pp[..., :1] / W - 0.5), ((pp[..., 1:] - NET) / NET), vel / 3, sp[..., None] / 3,
        known[..., None], seen[..., None], occ[..., None], hr[..., None],
        kx, ky, ok,
    ], -1).astype(np.float32)                                   # [T,4, 2+2+1+4+17*3]
    slots = [str(s) for s in tr["slots"]]
    far = [i for i, s in enumerate(slots) if s.startswith("far")]; near = [i for i, s in enumerate(slots) if s.startswith("near")]
    dn = np.where(known, np.abs(pp[..., 1] - NET), 99.0)
    out = np.zeros((len(t), 4, F.shape[-1]), np.float32)
    for j, side in enumerate((far, near)):
        if len(side) == 1:
            out[:, 2 * j] = F[:, side[0]]; continue
        a, b = side
        front_a = dn[:, a] <= dn[:, b]
        out[:, 2 * j] = np.where(front_a[:, None], F[:, a], F[:, b])
        out[:, 2 * j + 1] = np.where(front_a[:, None], F[:, b], F[:, a])
    return out, t


def flip_x(x: np.ndarray) -> np.ndarray:
    """좌우 뒤집기 (코트 x, 속도 x, 관절 x 와 좌우 관절 바꾸기)"""
    y = x.copy()
    y[..., 0] = -y[..., 0]; y[..., 2] = -y[..., 2]
    k0 = 9
    kx = y[..., k0:k0 + 17][..., FLIP]; ky = y[..., k0 + 17:k0 + 34][..., FLIP]; kc = y[..., k0 + 34:k0 + 51][..., FLIP]
    y[..., k0:k0 + 17] = -kx; y[..., k0 + 17:k0 + 34] = ky; y[..., k0 + 34:k0 + 51] = kc
    return y


def labels(t: np.ndarray, marks: list) -> np.ndarray:
    y = np.zeros(len(t), np.float32)
    for m in marks:
        y[np.abs(t - m["t"]) <= POS_HALF] = 1
    return y


# ---------------------------------------------------------------- 모델

class TCN(nn.Module):
    def __init__(self, fin: int, ch: int = 64, dil=(1, 2, 4, 8, 16, 32), drop: float = 0.2):
        super().__init__()
        self.player = nn.Sequential(nn.Linear(fin, ch), nn.GELU(), nn.Dropout(drop), nn.Linear(ch, ch // 2), nn.GELU())
        self.inp = nn.Conv1d(4 * (ch // 2), ch, 1)
        self.blocks = nn.ModuleList()
        for d in dil:
            self.blocks.append(nn.Sequential(nn.Conv1d(ch, ch, 3, padding=d, dilation=d), nn.BatchNorm1d(ch), nn.GELU(), nn.Dropout(drop),
                                             nn.Conv1d(ch, ch, 1)))
        self.out = nn.Conv1d(ch, 1, 1)

    def forward(self, x):                      # x [B,T,4,F]
        B, Tn, P, Fn = x.shape
        z = self.player(x).reshape(B, Tn, -1).transpose(1, 2)   # [B, 4*ch/2, T]
        z = self.inp(z)
        for b in self.blocks:
            z = z + b(z)
        return self.out(z)[:, 0]               # [B,T] logit


def train(vids: list, dev, steps: int = 1500, crop: int = 600, seed: int = 0, player_drop: float = 0.15, ch: int = 64, drop: float = 0.2):
    torch.manual_seed(seed); rng = np.random.default_rng(seed)
    fin = vids[0]["x"].shape[-1]
    m = TCN(fin, ch=ch, drop=drop).to(dev)
    opt = torch.optim.AdamW(m.parameters(), 2e-3, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 2e-3, total_steps=steps)
    pos = sum(v["y"].sum() for v in vids); tot = sum(len(v["y"]) for v in vids)
    lossf = nn.BCEWithLogitsLoss(pos_weight=torch.tensor((tot - pos) / pos / 3, device=dev))
    m.train()
    for _ in range(steps):
        xb, yb = [], []
        for _ in range(16):
            v = vids[rng.integers(len(vids))]
            s = rng.integers(0, max(1, len(v["y"]) - crop))
            x = v["x"][s:s + crop]; y = v["y"][s:s + crop]
            if rng.random() < 0.5:
                x = flip_x(x)
            if player_drop:
                x = x.copy()
                for k in range(4):     # 선수 일부 구간 안 보임 흉내
                    if rng.random() < player_drop:
                        a = rng.integers(0, len(x)); b = a + rng.integers(15, 90)
                        x[a:b, k] = 0
            xb.append(x); yb.append(y)
        n = min(len(y) for y in yb)
        xb = torch.tensor(np.stack([x[:n] for x in xb]), device=dev); yb = torch.tensor(np.stack([y[:n] for y in yb]), device=dev)
        loss = lossf(m(xb), yb)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    m.eval()
    return m


@torch.no_grad()
def predict(m, x: np.ndarray, dev) -> np.ndarray:
    p1 = torch.sigmoid(m(torch.tensor(x[None], device=dev)))[0].cpu().numpy()
    p2 = torch.sigmoid(m(torch.tensor(flip_x(x)[None], device=dev)))[0].cpu().numpy()
    return (p1 + p2) / 2


# ---------------------------------------------------------------- 평가

def peaks(t, p, thr, gap=3.5):
    """확률 봉우리 → 서브 시각 (gap 안에서는 큰 것 하나)"""
    idx = np.argsort(-p); keep = []
    for i in idx:
        if p[i] < thr:
            break
        if all(abs(t[i] - t[j]) >= gap for j in keep):
            keep.append(i)
    return sorted(t[i] for i in keep), [p[i] for i in sorted(keep, key=lambda i: t[i])]


def match(truth: list, found: list, tol=MATCH_TOL):
    """정답 시각·찾은 시각 1:1 짝 (가까운 것부터) → (맞음, 가짜, 놓침, 시각 오차들)"""
    pairs = sorted((abs(a - b), i, j) for i, a in enumerate(truth) for j, b in enumerate(found) if abs(a - b) <= tol)
    ui, uj, err = set(), set(), []
    for d, i, j in pairs:
        if i in ui or j in uj:
            continue
        ui.add(i); uj.add(j); err.append(found[j] - truth[i])
    return len(ui), len(found) - len(uj), len(truth) - len(ui), err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", action="append", default=[])
    ap.add_argument("--videos", default="20261108_match1,20261108_match2,20261108_match3,20261108_match4,20161110_match5")
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--gpu", default="cuda:0")
    ap.add_argument("--out", default="")
    ap.add_argument("--ch", type=int, default=64)
    ap.add_argument("--drop", type=float, default=0.2)
    ap.add_argument("--half", type=float, default=POS_HALF)
    a = ap.parse_args()
    globals()["POS_HALF"] = a.half
    dev = torch.device(a.gpu if torch.cuda.is_available() else "cpu")
    over = dict(s.split("=", 1) for s in a.tracks)
    data = T.build(over, ROOT / "data" / "video_train_cache.pkl", set(a.videos.split(",")))
    vids = []
    for v in data:
        tr = A.load_tracks(v["tr"])
        x, t = frame_feats(tr)
        vids.append({"vid": v["vid"], "x": x, "t": t, "y": labels(t, v["marks"]), "marks": v["marks"], "cands": v["cands"],
                     "pos": {r["k"] for r in v["rows"]}})
    print(f"입력 {vids[0]['x'].shape[-1]}개 특징 × 선수 4 · 영상 {len(vids)}", flush=True)

    res = {}
    for v in vids:
        rest = [u for u in vids if u["vid"] != v["vid"]]
        ps = []
        for s in range(a.seeds):
            t0 = time.time()
            m = train(rest, dev, a.steps, seed=s, ch=a.ch, drop=a.drop)
            ps.append(predict(m, v["x"], dev))
        p = np.mean(ps, 0)
        res[v["vid"]] = p
        print(f"  {v['vid']} 학습 {time.time() - t0:.0f}초/회", flush=True)
    if a.out:
        np.savez(a.out, **res)

    # (a) 모델만으로 서브 찾기
    print("\n(a) 모델 봉우리 = 서브 (정답과 3초 안 짝) · 지금 규칙 = 서브 후보(예비·시도 빼고)")
    base = [0, 0, 0]; berr = []
    for v in vids:
        tt = [m_["t"] for m_ in v["marks"]]
        c = [e["t"] for e in v["cands"] if not e.get("rescued") and not e.get("no_rally")]
        tp, fp, fn, er = match(tt, c); base[0] += tp; base[1] += fp; base[2] += fn; berr += er
    print(f"  지금 규칙        맞음 {base[0]:3d} · 가짜 {base[1]:3d} · 놓침 {base[2]:3d} · 시각 오차 중앙 {np.median(np.abs(berr)):.2f}초")
    for thr in (0.3, 0.4, 0.5, 0.6, 0.7):
        s_ = [0, 0, 0]; er_all = []
        for v in vids:
            f, _ = peaks(v["t"], res[v["vid"]], thr)
            tp, fp, fn, er = match([m_["t"] for m_ in v["marks"]], f); s_[0] += tp; s_[1] += fp; s_[2] += fn; er_all += er
        print(f"  모델 (기준 {thr:.1f})  맞음 {s_[0]:3d} · 가짜 {s_[1]:3d} · 놓침 {s_[2]:3d} · 시각 오차 중앙 {np.median(np.abs(er_all)):.2f}초")

    # (b) 규칙 후보마다 모델 점수
    print("\n(b) 규칙 서브 후보(218개)마다 모델 점수 = 정지 구간 ±0.5초 안 최대 확률")
    sc, yy = [], []
    for v in vids:
        for i, e in enumerate(v["cands"]):
            msk = (v["t"] >= e["t_still"] - 0.5) & (v["t"] <= e["t_end"] + 0.5)
            sc.append(float(res[v["vid"]][msk].max()) if msk.any() else 0.0); yy.append(i in v["pos"])
    sc = np.array(sc); yy = np.array(yy)
    for thr in (0.2, 0.3, 0.4, 0.5):
        print(f"  기준 {thr:.1f}: 진짜→가짜 {((sc < thr) & yy).sum():2d} · 가짜→진짜 {((sc >= thr) & ~yy).sum():2d} · 합 {((sc >= thr) != yy).sum()}")
    for lo, hi in ((0.1, 0.7), (0.15, 0.6)):
        sure = (sc < lo) | (sc >= hi)
        print(f"  확신 구간(<{lo} 또는 ≥{hi}): {sure.sum()}개 중 틀림 {(sure & ((sc >= hi) != yy)).sum()} · 애매 {(~sure).sum()}")


if __name__ == "__main__":
    main()

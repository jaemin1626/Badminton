/* =========================================================
   Smash Score — 프런트엔드
   단계: 0 업로드 → 1 프레임 → 2 코트 → 3 선수 → 4 경기 설정 → 5 분석 → 6 편집 → 7 저장
   ========================================================= */
const STEPS = ["영상 업로드", "프레임 선택", "코트 지정", "선수 선택", "경기 설정", "분석", "편집", "저장"];
const HINTS = [
  "mp4 · mov 지원",
  "←/→ 1프레임 · Shift+←/→ 1초 이동",
  "도면에서 점·라인을 고르고 영상에서 클릭 · Esc 그만 찍기 · 방향키 미세 조정",
  "팀을 고르고 선수 박스를 클릭 · 다시 클릭하면 해제",
  "왼쪽 위 스코어보드 미리보기 · 결과 영상에도 그대로 들어가요",
  "분석은 서버 GPU에서 진행돼요",
  "Space 재생 · ←/→ 2초 · [ ] 이전/다음 서브 · 검토 중 X/Enter/A/B/N",
  "스코어보드 모양을 고르고 영상을 만들어 받으세요",
];
const W_M = 6.10, L_M = 13.40, NET = L_M / 2;
const NS = "http://www.w3.org/2000/svg";
const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];

const S = {
  step: 0, vid: null, meta: null, frame: 0,
  corners: null, showLines: true,
  cpts: [], clines: [], pick: null, sel: null, drag: null, fit: null, wide: false, inner: false, guide: null,
  people: [], detFrame: -1, detecting: false, assign: {}, activeTeam: "A", showPose: true,
  teams: { A: { name: "팀 A" }, B: { name: "팀 B" } },
  fmt: { mode: "doubles", first: "A", scoreA: 0, scoreB: 0, target: 21, ours: "A", ours_row: "bottom", scoreboard: true, game: 1 },
  suggest: null, config: null, job: null, renderJob: null, result: null, selEvent: null,
  pub: { exclude: [], scoreboard: true }, publicJob: null, players: null,
};

/* ---------------- 유틸 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(1) + "GB" : (b / 1e6).toFixed(0) + "MB";
function el(tag, attrs = {}, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
const pts = a => a.map(p => p.join(",")).join(" ");
let tt; function toast(m, err = false) { const t = $("#toast"); t.textContent = m; t.classList.toggle("err", err); t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), err ? 4200 : 2000); }

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { "Content-Type": "application/json", ...(o.headers || {}) }; delete o.json; }
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { }
    throw new Error(msg);
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

/* ---------------- 호모그래피 (코트 m ↔ 픽셀) ---------------- */
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]];[b[i], b[m]] = [b[m], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const [X, Y] = src[i], [x, y] = dst[i]; A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.push(x); A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.push(y); }
  return [...solve(A, b), 1];
}
const COURT = [[0, 0], [W_M, 0], [W_M, L_M], [0, L_M]];
const map = (H, [X, Y]) => { const d = H[6] * X + H[7] * Y + H[8]; return [(H[0] * X + H[1] * Y + H[2]) / d, (H[3] * X + H[4] * Y + H[5]) / d]; };
function courtLines() {
  const s = 0.46, ss = 1.98, ls = 0.76;
  return [[[0, 0], [W_M, 0]], [[0, L_M], [W_M, L_M]], [[0, 0], [0, L_M]], [[W_M, 0], [W_M, L_M]], [[s, 0], [s, L_M]], [[W_M - s, 0], [W_M - s, L_M]],
  [[0, NET - ss], [W_M, NET - ss]], [[0, NET + ss], [W_M, NET + ss]], [[0, ls], [W_M, ls]], [[0, L_M - ls], [W_M, L_M - ls]],
  [[W_M / 2, 0], [W_M / 2, NET - ss]], [[W_M / 2, NET + ss], [W_M / 2, L_M]]];
}
function convex(q) { // 꼭짓점 4개가 볼록 사각형인지
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-6) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/* ---------------- 코트 지정: 교차점·네트 기둥(점) + 라인(보이는 곳 아무 데나) → 호모그래피 ----------------
   꼭짓점이 화면 밖이어도 된다. 서버가 최소제곱으로 맞추고 점·라인별 오차(px)를 돌려준다. */
const SHORT = 1.98, LONG_DBL = 0.76;
const XS = [[0, "왼쪽 복식"], [0.46, "왼쪽 단식"], [W_M / 2, "센터"], [W_M - 0.46, "오른쪽 단식"], [W_M, "오른쪽 복식"]];
const YS = [[0, "먼 쪽 엔드"], [LONG_DBL, "먼 쪽 롱서비스"], [NET - SHORT, "먼 쪽 숏서비스"], [NET + SHORT, "가까운 쪽 숏서비스"], [L_M - LONG_DBL, "가까운 쪽 롱서비스"], [L_M, "가까운 쪽 엔드"]];
const CATALOG = [];
for (const [y, yn] of YS) for (const [x, xn] of XS) CATALOG.push({ c: [x, y], name: `${yn} × ${xn}` });
CATALOG.push({ c: [0, NET], name: "왼쪽 네트 기둥 바닥" }, { c: [W_M, NET], name: "오른쪽 네트 기둥 바닥" });
for (const q of CATALOG) q.outer = (q.c[0] === 0 || q.c[0] === W_M) && (q.c[1] === 0 || q.c[1] === L_M || q.c[1] === NET);
const LINE_CATALOG = [
  { l: [[0, 0], [0, L_M]], name: "왼쪽 복식 사이드라인" }, { l: [[0.46, 0], [0.46, L_M]], name: "왼쪽 단식 사이드라인" },
  { l: [[W_M - 0.46, 0], [W_M - 0.46, L_M]], name: "오른쪽 단식 사이드라인" }, { l: [[W_M, 0], [W_M, L_M]], name: "오른쪽 복식 사이드라인" },
  { l: [[0, 0], [W_M, 0]], name: "먼 쪽 엔드라인" }, { l: [[0, LONG_DBL], [W_M, LONG_DBL]], name: "먼 쪽 롱서비스 라인" },
  { l: [[0, NET - SHORT], [W_M, NET - SHORT]], name: "먼 쪽 숏서비스 라인" }, { l: [[0, NET + SHORT], [W_M, NET + SHORT]], name: "가까운 쪽 숏서비스 라인" },
  { l: [[0, L_M - LONG_DBL], [W_M, L_M - LONG_DBL]], name: "가까운 쪽 롱서비스 라인" }, { l: [[0, L_M], [W_M, L_M]], name: "가까운 쪽 엔드라인" },
  { l: [[W_M / 2, 0], [W_M / 2, NET - SHORT]], name: "먼 쪽 센터라인" }, { l: [[W_M / 2, NET + SHORT], [W_M / 2, L_M]], name: "가까운 쪽 센터라인" },
];
for (const c of LINE_CATALOG) { const [[x1, y1], [x2, y2]] = c.l; c.outer = (x1 === x2 && (x1 === 0 || x1 === W_M)) || (y1 === y2 && (y1 === 0 || y1 === L_M)); }
const sameC = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const sameL = (a, b) => sameC(a[0], b[0]) && sameC(a[1], b[1]);
const GUIDE = [
  { kind: "p", i: CATALOG.findIndex(q => sameC(q.c, [0, NET])), how: "바닥에 닿은 곳을 한 번 클릭" },
  { kind: "p", i: CATALOG.findIndex(q => sameC(q.c, [W_M, NET])), how: "바닥에 닿은 곳을 한 번 클릭" },
  { kind: "l", i: 0, how: "라인 위 서로 먼 곳 2군데 클릭 (끝이 화면 밖이어도 보이는 곳 아무 데나)" },
  { kind: "l", i: 3, how: "라인 위 서로 먼 곳 2군데 클릭" },
  { kind: "l", i: 4, how: "라인 위 서로 먼 곳 2군데 클릭" },
  { kind: "l", i: 9, how: "라인 위 서로 먼 곳 2군데 클릭 (화면 아래로 잘려 있으면 건너뛰기)" },
];
const guideDone = g => g.kind === "p" ? S.cpts.some(q => sameC(q.court, CATALOG[g.i].c)) : S.clines.some(l => sameL(l.line, LINE_CATALOG[g.i].l) && l.px.length >= 2);
function guideNext(from = 0) {
  for (let k = from; k < GUIDE.length; k++) if (!guideDone(GUIDE[k])) { S.guide = k; S.pick = { kind: GUIDE[k].kind, i: GUIDE[k].i }; S.sel = null; return true; }
  S.guide = null; S.pick = null; return false;
}
function startGuide() {
  if (!guideNext(0)) { toast("안내 순서를 모두 찍었어요. 오차가 큰 건 끌어서 고치세요"); }
  drawOverlay(); renderPanel();
}
function skipGuide() { if (S.guide == null) return; if (!guideNext(S.guide + 1)) toast("안내 순서를 마쳤어요"); drawOverlay(); renderPanel(); }
const cName = c => CATALOG.find(q => sameC(q.c, c))?.name || "점";
const lName = l => LINE_CATALOG.find(c => sameL(c.l, l))?.name || "라인";
const goodLines = () => S.clines.filter(l => l.px.length >= 2);
const eqCount = () => 2 * S.cpts.length + 2 * goodLines().length;
// 카메라 뒤로 넘어가는 점은 null
const mapS = (H, [X, Y]) => { const d = H[6] * X + H[7] * Y + H[8]; if (d <= 1e-9) return null; return [(H[0] * X + H[1] * Y + H[2]) / d, (H[3] * X + H[4] * Y + H[5]) / d]; };
const curH = () => S.fit && !S.fit.error ? S.fit.H : null;
// 바깥 네 면이 각각 '라인 하나' 또는 '그 면 위 점 2개'로 정해졌나. 식 수만 채우면 찍은 곳에만 맞고
// 안 찍은 쪽(예: 먼 쪽 오른 꼭짓점)이 1m 넘게 틀어져도 오차가 작게 나온다 → 서브를 놓친다
const SIDES = [{ k: "left", nm: "왼쪽 사이드라인", ax: 0, v: 0 }, { k: "right", nm: "오른쪽 사이드라인", ax: 0, v: W_M },
  { k: "far", nm: "먼 쪽 엔드라인", ax: 1, v: 0 }, { k: "near", nm: "가까운 쪽 엔드라인", ax: 1, v: L_M }];
const onSide = (c, sd) => Math.abs(c[sd.ax] - sd.v) < 1e-6;
const sideFixed = sd => goodLines().some(l => onSide(l.line[0], sd) && onSide(l.line[1], sd)) || S.cpts.filter(q => onSide(q.court, sd)).length >= 2;
const sidesMissing = () => SIDES.filter(sd => !sideFixed(sd));
function courtOk() {
  const f = S.fit;
  return !!(f && !f.error && eqCount() >= 8 && f.mean_err <= 12 && !sidesMissing().length && S.corners && convex(S.corners));
}
let fitSeq = 0, fitTimer;
function refit(now = false) {
  clearTimeout(fitTimer);
  const run = async () => {
    const seq = ++fitSeq;
    if (eqCount() < 8) { S.fit = null; afterFit(); return; }
    try {
      const r = await api("/api/court/fit", { method: "POST", json: { points: S.cpts, lines: goodLines() } });
      if (seq !== fitSeq) return;
      S.fit = { ...r, H: r.h_court2px.flat() };
      const cs = COURT.map(c => mapS(S.fit.H, c));
      if (cs.every(Boolean)) S.corners = cs.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
    } catch (e) { if (seq !== fitSeq) return; S.fit = { error: e.message }; }
    afterFit();
  };
  if (now) run(); else fitTimer = setTimeout(run, 60);
}
function afterFit() { if (S.step === 2 || S.step === 3) drawOverlay(); if (S.step === 2) renderPanel(); saveLocal(); }
function placeCourt(px) {
  if (S.pick.kind === "p") {
    const c = CATALOG[S.pick.i].c, i = S.cpts.findIndex(q => sameC(q.court, c));
    if (i >= 0) S.cpts[i].px = px; else S.cpts.push({ court: [...c], px });
    S.sel = { kind: "p", i: i >= 0 ? i : S.cpts.length - 1 }; S.pick = null;
  } else {
    const c = LINE_CATALOG[S.pick.i].l;
    let i = S.clines.findIndex(l => sameL(l.line, c));
    if (i < 0) { S.clines.push({ line: c.map(q => [...q]), px: [] }); i = S.clines.length - 1; }
    S.clines[i].px.push(px); S.sel = { kind: "l", i, j: S.clines[i].px.length - 1 };
  }
  if (S.guide != null && guideDone(GUIDE[S.guide]) && !guideNext(S.guide + 1)) toast("안내 순서를 다 찍었어요. 오차가 큰 건 끌어서 고치세요");
  drawOverlay(); renderPanel(); refit();
}
function selRef() { return !S.sel ? null : S.sel.kind === "p" ? S.cpts[S.sel.i]?.px : S.clines[S.sel.i]?.px[S.sel.j]; }
function delSel() {
  if (!S.sel) return;
  if (S.sel.kind === "p") S.cpts.splice(S.sel.i, 1);
  else { const l = S.clines[S.sel.i]; l.px.splice(S.sel.j, 1); if (!l.px.length) S.clines.splice(S.sel.i, 1); }
  S.sel = null; drawOverlay(); renderPanel(); refit(true);
}
// 긴 선을 잘게 나눠 그린다 (화면 밖 꼭짓점 때문에 원근이 크게 걸려도 모양 유지)
function segLine(g, H, [a, b], attrs) {
  let seg = [];
  const flush = () => { if (seg.length > 1) el("polyline", { points: seg.map(q => q.join(",")).join(" "), fill: "none", ...attrs }, g); seg = []; };
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, q = mapS(H, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (!q || Math.abs(q[0]) > 2e4 || Math.abs(q[1]) > 2e4) flush(); else seg.push(q);
  }
  flush();
}
// 오른쪽 패널의 코트 도면: 점·라인을 눌러 고른다 (위 = 네트 너머, 아래 = 카메라 쪽)
function courtDiagram() {
  const m = .9, done = c => S.cpts.some(q => sameC(q.court, c)), ldone = l => goodLines().some(x => sameL(x.line, l));
  let h = `<svg class="diag" id="diag" viewBox="${-m} ${-m - .2} ${W_M + 2 * m} ${L_M + 2 * m + .4}" role="group" aria-label="코트 도면">
    <rect x="0" y="0" width="${W_M}" height="${L_M}" class="d-court"/>
    <text x="${W_M / 2}" y="-.35" class="d-side">네트 너머</text><text x="${W_M / 2}" y="${L_M + .75}" class="d-side">카메라 쪽</text>`;
  LINE_CATALOG.forEach((c, i) => {
    const [[x1, y1], [x2, y2]] = c.l, show = c.outer || S.inner || S.clines.some(l => sameL(l.line, c.l));
    if (!show) { h += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="d-ln dim"/>`; return; }
    const pick = S.pick?.kind === "l" && S.pick.i === i;
    const vert = x1 === x2;
    const marks = vert ? (y2 - y1 > 10 ? [(NET - SHORT) / 2, (NET + SHORT + L_M - LONG_DBL) / 2] : [(y1 + y2) / 2]).map(y => [x1, y]) : [[W_M * .25, y1], [W_M * .75, y1]];
    h += `<g class="d-l ${ldone(c.l) ? "done" : ""} ${pick ? "pick" : ""}" data-l="${i}" tabindex="0" role="button" aria-label="${c.name}"><title>${c.name} · 영상에서 이 라인 위를 2곳 이상 클릭</title>
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="hit"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="vis"/>
      ${marks.map(([mx, my]) => `<path d="M${mx},${my - .34}L${mx + .34},${my}L${mx},${my + .34}L${mx - .34},${my}Z" class="dm"/>`).join("")}</g>`;
  });
  h += `<line x1="-.45" y1="${NET}" x2="${W_M + .45}" y2="${NET}" class="d-net"/>`;
  CATALOG.forEach((q, i) => {
    if (!q.outer && !S.inner && !done(q.c)) return;
    const pick = S.pick?.kind === "p" && S.pick.i === i;
    h += `<g class="d-p ${done(q.c) ? "done" : ""} ${pick ? "pick" : ""}" data-p="${i}" tabindex="0" role="button" aria-label="${q.name}"><title>${q.name}</title><circle cx="${q.c[0]}" cy="${q.c[1]}" r="${q.outer ? .32 : .24}"/></g>`;
  });
  return h + "</svg>";
}
function bindDiagram() {
  const choose = (kind, i) => { S.guide = null; S.pick = S.pick?.kind === kind && S.pick.i === i ? null : { kind, i }; S.sel = null; drawOverlay(); renderPanel(); };
  $$("#diag [data-p]").forEach(g => { g.onclick = () => choose("p", +g.dataset.p); g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose("p", +g.dataset.p); } }; });
  $$("#diag [data-l]").forEach(g => { g.onclick = () => choose("l", +g.dataset.l); g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose("l", +g.dataset.l); } }; });
}
function stagePad() { return S.step === 2 && S.wide ? { x: Math.round(S.meta.width * .25), y: Math.round(S.meta.height * .45) } : { x: 0, y: 0 }; }
function applyView() {
  if (!svg) return;
  const W = S.meta.width, H = S.meta.height, p = stagePad();
  svg.setAttribute("viewBox", `${-p.x} ${-p.y} ${W + 2 * p.x} ${H + 2 * p.y}`);
  $("#stage").style.aspectRatio = `${W + 2 * p.x}/${H + 2 * p.y}`;
}
async function loadLabCourt() {
  try {
    const c = (await api(`/api/lab/${S.vid}`)).config;
    if (!c?.points?.length && !c?.lines?.length) { toast("실험 페이지에 저장된 코트 설정이 없어요", true); return; }
    S.cpts = (c.points || []).map(q => ({ court: [...q.court], px: [...q.px] })); S.clines = (c.lines || []).map(l => ({ line: l.line.map(q => [...q]), px: l.px.map(q => [...q]) }));
    S.pick = null; S.sel = null; toast(`실험 페이지 코트 설정을 불러왔어요 (점 ${S.cpts.length} · 라인 ${S.clines.length})`);
    refit(true);
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 상태 저장 (새로고침해도 이어서) ---------------- */
function saveLocal() {
  if (!S.vid) return;
  const keep = { ts: Date.now() / 1000, frame: S.frame, corners: S.corners, cpts: S.cpts, clines: S.clines, wide: S.wide, inner: S.inner, assign: S.assign, people: S.people, detFrame: S.detFrame, teams: S.teams, fmt: S.fmt, showLines: S.showLines, showPose: S.showPose };
  localStorage.setItem("ss:" + S.vid, JSON.stringify(keep));
}
function loadLocal(vid) { try { return JSON.parse(localStorage.getItem("ss:" + vid) || "null"); } catch { return null; } }
function setHash() { history.replaceState(null, "", S.vid ? `#/v/${S.vid}/${S.step}` : "#/"); }

/* ---------------- 테마 ---------------- */
const root = document.documentElement;
const savedTheme = localStorage.getItem("ss:theme"); if (savedTheme) root.dataset.theme = savedTheme;
function curTheme() { return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
function setThemeLabel() { $("#themeLabel").textContent = curTheme() === "dark" ? "다크" : "라이트"; }
$("#themeBtn").onclick = () => { root.dataset.theme = curTheme() === "dark" ? "light" : "dark"; localStorage.setItem("ss:theme", root.dataset.theme); setThemeLabel(); };
setThemeLabel();

/* ---------------- 헤더 칩 ---------------- */
async function checkHealth() {
  const c = $("#gpuChip");
  try {
    const h = await api("/api/health");
    const gpu = h.providers.includes("CUDAExecutionProvider");
    c.innerHTML = h.ok ? `<span class="dot" style="background:var(--ok)"></span>${gpu ? "GPU 준비됨" : "CPU 모드"}`
      : `<span class="dot" style="background:var(--warn)"></span>모델 파일 없음`;
    c.title = h.ok ? `Detector · Pose 모델 준비됨 (${h.providers[0]})` : "Models 폴더를 확인하세요";
  } catch { c.innerHTML = `<span class="dot" style="background:var(--bad)"></span>서버 연결 안 됨`; }
}
function setVideoChip() {
  const c = $("#videoChip");
  if (!S.meta) { c.classList.add("hidden"); return; }
  const m = S.meta;
  c.classList.remove("hidden");
  c.innerHTML = `<span class="dot" style="background:var(--ok)"></span>${esc(m.name)} · ${m.width}×${m.height} · ${Math.round(m.fps)}fps · ${fmtTime(m.duration)}`;
}

/* ---------------- 단계 ---------------- */
function maxStep() {
  if (!S.vid) return 0;
  if (S.result) return 7;
  if (S.config) return 5;
  return 4;
}
function renderStepper() {
  const s = $("#stepper"); const mx = maxStep();
  s.innerHTML = STEPS.map((n, i) => `<button class="step ${i < S.step ? "done" : ""} ${i === S.step ? "active" : ""} ${i > mx ? "locked" : ""}" data-i="${i}" ${i > mx ? 'aria-disabled="true"' : ""}><b>${i < S.step ? "✓" : i + 1}</b>${n}</button>`).join("");
  $$(".step", s).forEach(d => d.onclick = () => { const i = +d.dataset.i; if (i > mx) { toast(i >= 6 ? "분석이 끝나면 편집·저장할 수 있어요" : "앞 단계를 먼저 마쳐 주세요"); return; } go(i); });
}
function go(step) {
  S.step = step; setHash(); saveLocal();
  if (S.vid) api(`/api/videos/${S.vid}/meta`, { method: "PATCH", json: { step } }).catch(() => { });
  render();
}
function render() {
  renderStepper();
  const v = $("#view");
  stopVideoLoop();
  if (S.step === 0) return renderUpload(v);
  if (S.step <= 4) return renderStage(v);
  if (S.step === 5) return renderAnalyze(v);
  return renderResult(v);
}

/* =========================================================
   0. 업로드 — 코트 모양 드롭존
   ========================================================= */
function courtSVG() {
  const k = 100, L = [];
  for (const [[x1, y1], [x2, y2]] of courtLines()) L.push(`<line class="cl" x1="${x1 * k}" y1="${y1 * k}" x2="${x2 * k}" y2="${y2 * k}"/>`);
  return `<svg viewBox="-8 -8 626 1356" preserveAspectRatio="none" aria-hidden="true">${L.join("")}<line class="net" x1="-8" y1="${NET * k}" x2="618" y2="${NET * k}"/></svg>`;
}
async function renderUpload(v) {
  v.innerHTML = `<main class="wide"><section class="card upload-hero">
    <div>
      <h1 class="display">영상만 올리면<span class="line2">점수는 저절로.</span></h1>
      <p class="lead">복식 경기 영상을 올리고 코트와 선수만 알려 주세요. 서브할 때마다 4명이 멈춰 서는 순간을 찾아 누가 서브했는지로 점수를 셉니다.</p>
      <ol class="how">
        <li><b>1</b><span><strong>코트 꼭짓점 4개</strong>를 영상 위에 맞춰요.</span></li>
        <li><b>2</b><span><strong>두 팀 선수</strong>를 클릭해서 나눠요.</span></li>
        <li><b>3</b><span>서버 GPU가 <strong>선수 위치와 자세</strong>를 추적해요.</span></li>
        <li><b>4</b><span><strong>점수 흐름</strong>을 확인하고, 틀린 서브는 바로 고쳐요.</span></li>
      </ol>
      <div class="recent" id="recent"></div>
    </div>
    <div>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="영상 파일 올리기">
        ${courtSVG()}
        <div class="fill" style="height:0"></div>
        <svg class="shuttle" style="top:80%"><use href="#i-shuttle"/></svg>
        <div class="label"><span class="big">영상 놓기</span><span class="small">또는 클릭해서 고르기 · mp4 · mov</span></div>
      </div>
      <input type="file" id="file" accept="video/*,.mp4,.mov,.mkv,.avi,.webm" hidden>
    </div>
  </section></main>
  <p class="footnote">카메라가 고정된 영상을 가정해요. 파일명은 상관없어요 (서버에는 영문 ID로 저장돼요).</p>`;
  const drop = $("#drop"), file = $("#file");
  drop.onclick = () => !drop.classList.contains("uploading") && file.click();
  drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drop.click(); } };
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) upload(f); });
  file.onchange = () => file.files[0] && upload(file.files[0]);
  renderRecent();
}
async function renderRecent() {
  const box = $("#recent"); if (!box) return;
  let list = [];
  try { list = await api("/api/videos"); } catch { return; }
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h3>이어서 작업하기</h3><div class="recent-list">${list.slice(0, 5).map(m => `
    <div class="recent-item" data-id="${m.id}" role="button" tabindex="0">
      <img src="/api/videos/${m.id}/thumb" alt="" loading="lazy">
      <div style="min-width:0"><div class="t">${esc(m.name)}</div>
      <div class="m">${fmtTime(m.duration)} · ${m.width}×${m.height} · ${m.has_result ? "분석 완료" : STEPS[Math.min(m.step || 1, 5)] + " 단계"}</div></div>
      <button class="del" data-del="${m.id}" title="삭제" aria-label="${esc(m.name)} 삭제">✕</button>
    </div>`).join("")}</div>`;
  $$(".recent-item", box).forEach(it => {
    it.onclick = e => { if (e.target.closest(".del")) return; openVideo(it.dataset.id); };
    it.onkeydown = e => { if (e.key === "Enter") openVideo(it.dataset.id); };
  });
  $$(".del", box).forEach(b => b.onclick = async () => {
    if (!confirm("이 영상과 분석 결과를 삭제할까요?")) return;
    await api(`/api/videos/${b.dataset.del}`, { method: "DELETE" }); localStorage.removeItem("ss:" + b.dataset.del); toast("삭제했어요"); renderRecent();
  });
}
function upload(f) {
  const drop = $("#drop"); drop.classList.add("uploading");
  const fill = $(".fill", drop), sh = $(".shuttle", drop), label = $(".label", drop);
  label.innerHTML = `<span class="big">${esc(f.name)}</span><span class="small">${fmtBytes(f.size)} 올리는 중</span>`;
  const pct = document.createElement("div"); pct.className = "pct"; drop.appendChild(pct);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/videos");
  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    const p = e.loaded / e.total;
    fill.style.height = (p * 100) + "%"; sh.style.top = (80 - p * 78) + "%"; pct.textContent = Math.round(p * 100) + "%";
    if (p >= 1) label.innerHTML = `<span class="big">영상 확인 중</span><span class="small">프레임 정보를 읽고 있어요</span>`;
  };
  xhr.onload = () => {
    let j; try { j = JSON.parse(xhr.responseText); } catch { j = {}; }
    if (xhr.status >= 300) { toast(j.detail || "업로드 실패", true); renderUpload($("#view")); return; }
    toast("업로드했어요");
    openVideo(j.id, 1);
  };
  xhr.onerror = () => { toast("네트워크 오류로 업로드하지 못했어요", true); renderUpload($("#view")); };
  const fd = new FormData(); fd.append("file", f); xhr.send(fd);
}

async function openVideo(id, step) {
  try {
    const meta = await api(`/api/videos/${id}`);
    Object.assign(S, { vid: id, meta, suggest: null, result: null, review: null, people: [], detFrame: -1, assign: {}, job: null, renderJob: null, selEvent: null,
      cpts: [], clines: [], pick: null, sel: null, drag: null, fit: null });
    S.config = meta.config || null;
    const loc = loadLocal(id);
    const W = meta.width, H = meta.height;
    S.corners = [[W * .3, H * .36], [W * .7, H * .36], [W * .9, H * .92], [W * .1, H * .92]];
    S.frame = Math.round(meta.frames * 0.25);
    if (S.config) { // 서버에 저장된 설정 우선
      const c = S.config;
      S.corners = c.court_corners_px; S.frame = c.ref_frame;
      if (c.points?.length || c.lines?.length) { S.cpts = c.points || []; S.clines = c.lines || []; }
      else if (c.court_corners_px) S.cpts = COURT.map((cc, i) => ({ court: [...cc], px: c.court_corners_px[i] }));   // 예전 꼭짓점 설정
      S.teams = { A: { name: c.teams["1"].name }, B: { name: c.teams["2"].name } };
      S.fmt = { ...S.fmt, ...c.match };
    }
    // 브라우저에 남은 작업은 서버 설정보다 나중 것일 때만 코트를 덮는다 (서버에서 고친 설정이 옛 작업에 가려지지 않게)
    const locCourt = loc && (!S.config || (loc.ts || 0) > (S.config.saved || 0));
    if (loc) {
      S.wide = !!loc.wide; S.inner = !!loc.inner;
      S.showLines = loc.showLines ?? true; S.showPose = loc.showPose ?? true;
    }
    if (locCourt) {
      S.assign = loc.assign || {}; S.people = loc.people || [];
      S.detFrame = loc.detFrame ?? -1; S.teams = loc.teams || S.teams; S.fmt = { ...S.fmt, ...(loc.fmt || {}) };
    } else if (S.config) {
      // 서버 설정의 선수·심판 박스를 그대로 깔아 둔다. 선수 단계에서 다시 찾으면 박스 겹침으로 이어 붙는다
      const c = S.config, add = (box, t, extra = {}) => { const id = "s" + (S.people.length + 1); S.people.push({ id, box, conf: 1, ...extra }); S.assign[id] = t; };
      [["A", "1"], ["B", "2"]].forEach(([t, k]) => (c.teams[k].bboxes || []).forEach((b, i) => add(b, t, { court: c.teams[k].court_pos?.[i], side: c.teams[k].side, in_play: true })));
      (c.officials || []).forEach(o => add(o.bbox, "R", { court: o.court_pos, in_play: false }));
    }
    if (locCourt) {
      S.frame = loc.frame ?? S.frame; S.corners = loc.corners || S.corners;
      if (loc.cpts) { S.cpts = loc.cpts; S.clines = loc.clines || []; }
      else if (loc.corners && !S.cpts.length) S.cpts = COURT.map((cc, i) => ({ court: [...cc], px: loc.corners[i] }));   // 예전 꼭짓점 작업 이어받기
    }
    refit(true);
    if (meta.has_result) { try { S.result = await api(`/api/videos/${id}/result`); } catch { } }
    const aj = meta.active_jobs?.analyze; if (aj && ["queued", "running"].includes(aj.state)) S.job = aj;
    const rj = meta.active_jobs?.render; if (rj && ["queued", "running"].includes(rj.state)) S.renderJob = rj;
    const pj = meta.active_jobs?.public; S.publicJob = pj && ["queued", "running"].includes(pj.state) ? pj : null;
    S.players = null; S.pub = { exclude: meta.public?.exclude || [], scoreboard: meta.public?.scoreboard ?? true };
    setVideoChip();
    go(Math.min(step ?? (S.job ? 5 : S.result ? 6 : (meta.step || 1)), S.job ? 5 : maxStep()) || 1);
  } catch (e) { toast(e.message, true); S.vid = null; S.meta = null; setVideoChip(); go(0); }
}

/* =========================================================
   1~4. 영상 위 작업 (프레임 · 코트 · 선수 · 설정)
   ========================================================= */
let svg, imgEl;
function renderStage(v) {
  const m = S.meta, W = m.width, H = m.height;
  v.innerHTML = `<main>
    <section class="card stage-wrap">
      <div class="stage-top"><span class="chip" id="modeChip"></span><span class="chip" id="hintChip">${HINTS[S.step]}</span><span class="spacer"></span><span class="chip hidden" id="detChip"></span></div>
      <div class="stage" id="stage" style="aspect-ratio:${W}/${H}">
        <svg class="scene" id="svg" viewBox="0 0 ${W} ${H}">
          <defs><clipPath id="loupeClip"><circle id="loupeClipC" r="1"/></clipPath></defs>
          <g id="scene"><image id="frameImg" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/></g>
          <g id="overlay"></g>
          <g id="loupe" class="hidden">
            <circle id="loupeBg" fill="#000"/>
            <g clip-path="url(#loupeClip)"><use id="loupeUse" href="#scene"/><use id="loupeUse2" href="#overlayStatic"/></g>
            <circle id="loupeRing" class="loupe-ring"/><path id="loupeCross" stroke="var(--accent)"/>
          </g>
        </svg>
        <div class="spin"><svg class="shuttle-loader"><use href="#i-shuttle"/></svg></div>
      </div>
      <div class="scrub ${S.step >= 4 ? "hidden" : ""}">
        <button class="fbtn" id="prev10" title="1초 뒤로 (Shift+←)">«</button>
        <button class="fbtn" id="prevF" title="이전 프레임 (←)">‹</button>
        <input type="range" id="frameRange" min="0" max="${m.frames - 1}" value="${S.frame}" aria-label="프레임">
        <button class="fbtn" id="nextF" title="다음 프레임 (→)">›</button>
        <button class="fbtn" id="next10" title="1초 앞으로 (Shift+→)">»</button>
        <span class="num" id="frameNum"></span>
      </div>
      <div class="suggest ${S.step !== 1 ? "hidden" : ""}" id="suggest"></div>
    </section>
    <aside><div class="card panel" id="panel"></div></aside>
  </main>`;
  svg = $("#svg"); imgEl = $("#frameImg");
  applyView();
  bindStage();
  loadFrame(S.frame);
  if (S.step === 1) loadSuggest();
  if (S.step === 3 && S.detFrame !== S.frame) runDetect();
  drawOverlay(); renderPanel();
}

function loadFrame(f) {
  S.frame = clamp(Math.round(f), 0, S.meta.frames - 1);
  const r = $("#frameRange"); if (r) r.value = S.frame;
  const s = S.frame / S.meta.fps;
  const n = $("#frameNum"); if (n) n.textContent = `#${S.frame} · ${fmtTime(s)}`;
  const url = `/api/videos/${S.vid}/frames/${S.frame}`;
  const stage = $("#stage"); stage.classList.add("loading");
  const pre = new Image();
  pre.onload = () => { if (imgEl) imgEl.setAttribute("href", url); stage.classList.remove("loading"); };
  pre.onerror = () => stage.classList.remove("loading");
  pre.src = url;
  $$(".thumb").forEach(t => t.classList.toggle("sel", +t.dataset.f === S.frame));
  saveLocal();
}
let detTimer;
function frameChanged() {
  if (S.step === 3) { clearTimeout(detTimer); detTimer = setTimeout(runDetect, 350); }
}

function bindStage() {
  const fr = $("#frameRange");
  if (fr) {
    fr.oninput = () => loadFrame(+fr.value);
    fr.onchange = frameChanged;
    const fps = Math.round(S.meta.fps);
    $("#prevF").onclick = () => { loadFrame(S.frame - 1); frameChanged(); };
    $("#nextF").onclick = () => { loadFrame(S.frame + 1); frameChanged(); };
    $("#prev10").onclick = () => { loadFrame(S.frame - fps); frameChanged(); };
    $("#next10").onclick = () => { loadFrame(S.frame + fps); frameChanged(); };
  }
  const rpx = p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  svg.addEventListener("pointerdown", e => {   // 도면에서 고른 상태면 영상 클릭 = 찍기 (점은 한 번, 라인은 Esc까지 계속)
    if (S.step !== 2 || !S.pick) return;
    placeCourt(rpx(svgPoint(e)));
  });
  svg.addEventListener("pointermove", e => {
    if (S.step !== 2) return;
    const p = svgPoint(e);
    if (S.drag) {
      const px = rpx(p);
      if (S.drag.kind === "p") S.cpts[S.drag.i].px = px; else S.clines[S.drag.i].px[S.drag.j] = px;
      drawOverlay(); showLoupe(px); refit();
    } else if (S.pick) showLoupe([p.x, p.y]);
  });
  svg.addEventListener("pointerleave", () => { if (!S.drag) $("#loupe").classList.add("hidden"); });
  const end = () => { if (!S.drag) return; S.drag = null; $("#loupe").classList.add("hidden"); drawOverlay(); renderPanel(); saveLocal(); };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
}
function svgPoint(evt) { const p = svg.createSVGPoint(); p.x = evt.clientX; p.y = evt.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
const U = () => S.meta.width / 1600; // 화면 단위 배율

function showLoupe([px, py]) {
  const u = U(), Z = 3, R = 80 * u;
  let lx = px, ly = py - 140 * u; if (ly < R + 6) ly = py + 140 * u;
  lx = clamp(lx, R + 4, S.meta.width - R - 4);
  $("#loupe").classList.remove("hidden");
  for (const id of ["loupeBg", "loupeRing"]) { const c = $("#" + id); c.setAttribute("cx", lx); c.setAttribute("cy", ly); c.setAttribute("r", R); }
  $("#loupeRing").setAttribute("stroke-width", 4 * u);
  const c = $("#loupeClipC"); c.setAttribute("cx", lx); c.setAttribute("cy", ly); c.setAttribute("r", R);
  const tr = `translate(${lx} ${ly}) scale(${Z}) translate(${-px} ${-py})`;
  $("#loupeUse").setAttribute("transform", tr); $("#loupeUse2").setAttribute("transform", tr);
  const k = 14 * u; $("#loupeCross").setAttribute("d", `M${lx - k},${ly}H${lx + k}M${lx},${ly - k}V${ly + k}`); $("#loupeCross").setAttribute("stroke-width", 1.5 * u);
}

function drawOverlay() {
  const g = $("#overlay"); if (!g) return; g.innerHTML = "";
  const u = U();
  const stat = el("g", { id: "overlayStatic" }, g);
  if (S.step === 2) { drawCourtStep(g, stat, u); return; }
  if (S.step === 3) {
    const ok = convex(S.corners);
    if (ok) {
      const H = homography(COURT, S.corners);
      for (const [a, b] of courtLines()) { const [p, q] = [map(H, a), map(H, b)]; el("line", { x1: p[0], y1: p[1], x2: q[0], y2: q[1], class: "preview-line", "stroke-width": (S.step === 3 ? 1.4 : 2.2) * u, opacity: S.step === 3 ? .45 : .95 }, stat); }
      const n1 = map(H, [0, NET]), n2 = map(H, [W_M, NET]); el("line", { x1: n1[0], y1: n1[1], x2: n2[0], y2: n2[1], class: "net-line", "stroke-width": 3 * u }, stat);
    }
  }
  if (S.step === 3) drawPeople(g);
  if (S.step === 4 && S.fmt.scoreboard) {
    drawScoreboard(g, { score: { A: S.fmt.scoreA, B: S.fmt.scoreB }, server: S.fmt.first, game: S.fmt.game }, setupNow(), u);
  }
}

// 코트 단계: 맞춘 코트 라인 + 찍은 점(연두 원 · 계산 위치까지 오차 선) + 라인 위 점(하늘색 네모)
function drawCourtStep(g, stat, u) {
  const H = curH(), W = S.meta.width, Hh = S.meta.height;
  if (S.wide) el("rect", { x: 0, y: 0, width: W, height: Hh, class: "frame-edge", "stroke-width": 3 * u }, stat);
  if (H && S.showLines) {
    for (const ln of courtLines()) segLine(stat, H, ln, { class: "preview-line", "stroke-width": 2.2 * u });
    segLine(stat, H, [[0, NET], [W_M, NET]], { class: "net-line", "stroke-width": 3 * u });
  }
  const gl = goodLines();
  S.clines.forEach((ln, li) => {
    const on = (S.pick?.kind === "l" && sameL(LINE_CATALOG[S.pick.i].l, ln.line)) || (S.sel?.kind === "l" && S.sel.i === li);
    if (H) segLine(g, H, ln.line, { class: "cl-fit" + (on ? " on" : ""), "stroke-width": (on ? 5 : 3) * u });
    ln.px.forEach((q, j) => {
      const m = el("g", { class: "lpm" + (S.sel?.kind === "l" && S.sel.i === li && S.sel.j === j ? " sel" : "") }, g);
      el("rect", { x: q[0] - 9 * u, y: q[1] - 9 * u, width: 18 * u, height: 18 * u, rx: 3 * u, "stroke-width": 3 * u }, m);
      m.addEventListener("pointerdown", e => { e.stopPropagation(); S.drag = { kind: "l", i: li, j }; S.sel = { kind: "l", i: li, j }; svg.setPointerCapture(e.pointerId); showLoupe(q); drawOverlay(); renderPanel(); });
    });
    const q = ln.px[ln.px.length - 1];
    if (q) {
      const er = S.fit?.line_errors?.[gl.indexOf(ln)];
      const t = el("text", { x: q[0] + 14 * u, y: q[1] + 26 * u, "font-size": 20 * u, class: "lbl-l" }, g);
      t.textContent = `L${li + 1}${er != null ? ` · ${er.toFixed(1)}px` : ln.px.length < 2 ? " · 1곳 더" : ""}`;
    }
  });
  S.cpts.forEach((p, i) => {
    const m = el("g", { class: "ptm" + (S.sel?.kind === "p" && S.sel.i === i ? " sel" : "") }, g);
    const q = H && mapS(H, p.court);
    if (q) el("line", { x1: p.px[0], y1: p.px[1], x2: q[0], y2: q[1], "stroke-width": 2 * u }, m);
    el("circle", { cx: p.px[0], cy: p.px[1], r: 11 * u, "stroke-width": 3 * u }, m);
    const er = S.fit?.errors?.[i];
    const t = el("text", { x: p.px[0] + 15 * u, y: p.px[1] - 12 * u, "font-size": 20 * u }, m); t.textContent = `${i + 1}${er != null ? ` · ${er.toFixed(1)}px` : ""}`;
    m.addEventListener("pointerdown", e => { e.stopPropagation(); S.drag = { kind: "p", i }; S.sel = { kind: "p", i }; svg.setPointerCapture(e.pointerId); showLoupe(p.px); drawOverlay(); renderPanel(); });
  });
  $("#stage")?.classList.toggle("picking", !!S.pick);
}
function drawPeople(g) {
  const u = U();
  S.people.forEach(p => {
    const [x1, y1, x2, y2] = p.box; const t = S.assign[p.id];
    const b = el("g", { class: "pbox" + (t ? " " + t : "") + (p.in_play === false ? " out" : ""), tabindex: 0, role: "button", "aria-label": `선수 #${p.id}` }, g);
    el("rect", { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 8 * u, class: "frame", "stroke-width": (t ? 4 : 2) * u }, b);
    if (S.showPose && p.kps) {
      const col = t ? `var(--team${t})` : "var(--accent)";
      for (const [a, c] of SKELETON) {
        const A = p.kps[a], C = p.kps[c]; if (A[2] < .3 || C[2] < .3) continue;
        el("line", { x1: A[0], y1: A[1], x2: C[0], y2: C[1], class: "pose-bone", stroke: col, "stroke-width": 2.5 * u }, b);
      }
      p.kps.forEach((k, i) => { if (k[2] >= .3 && i >= 5) el("circle", { cx: k[0], cy: k[1], r: 3 * u, fill: "#fff" }, b); });
    }
    const label = t === "R" ? `심판 · #${p.id}` : t ? `${S.teams[t].name} · #${p.id}` : `#${p.id}${p.in_play === false ? " 코트 밖" : ""}`;
    const fs = 15 * u, tw = (label.length * 8.6 + 18) * u;
    const tg = el("g", { class: "tag", transform: `translate(${x1},${Math.max(0, y1 - 28 * u)})` }, b);
    el("rect", { width: tw, height: 24 * u, rx: 7 * u, fill: t ? `var(--team${t})` : "#000000aa" }, tg);
    const tx = el("text", { x: 9 * u, y: 12 * u, "font-size": fs }, tg); tx.textContent = label;
    b.addEventListener("click", () => togglePlayer(p));
    b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePlayer(p); } });
  });
}

/* ---------------- 스코어보드 (상대팀 위 / 우리팀 아래) ---------------- */
function setupNow() { return { ...S.fmt, nameA: S.teams.A.name, nameB: S.teams.B.name }; }
const titleText = st => [String(st.tournament || "").trim(), [st.event, st.division].map(x => String(x || "").trim()).filter(Boolean).join(" ")].filter(Boolean).join(" / ");
function drawTitle(g, setup, u) {
  const tour = String(setup.tournament || "").trim();
  const tag = [setup.event, setup.division].map(x => String(x || "").trim()).filter(Boolean).join(" ");
  if (!tour && !tag) return;
  const W = S.meta.width, H = 50, tg = el("g", {}, g);
  const bg = el("rect", { x: 0, y: 0, height: H, rx: 14, class: "sb-bg" }, tg);
  el("rect", { x: 14, y: 13, width: 5, height: H - 26, rx: 3, fill: "var(--accent)" }, tg);
  let x = 31;
  if (tour) {
    const t = el("text", { x, y: H / 2, "font-size": 21, "font-weight": 700, fill: "#fff", "dominant-baseline": "central", style: "font-family:'Noto Sans KR',sans-serif" }, tg);
    t.textContent = tour; x += (t.getComputedTextLength?.() || tour.length * 20);
  }
  if (tag) {
    if (tour) x += 12;
    const pill = el("rect", { x, y: 10, height: H - 20, rx: 9, fill: "var(--accent)" }, tg);
    const p = el("text", { x: 0, y: H / 2 + 1, "font-size": 17, "font-weight": 800, fill: "var(--accent-ink)", "text-anchor": "middle", "dominant-baseline": "central", style: "font-family:'Noto Sans KR',sans-serif" }, tg);
    p.textContent = tag;
    const pw = (p.getComputedTextLength?.() || tag.length * 16) + 26;
    pill.setAttribute("width", pw); p.setAttribute("x", x + pw / 2); x += pw;
  }
  const bw = x + 10; bg.setAttribute("width", bw);
  tg.setAttribute("transform", `translate(${W - 24 * u - bw * u},${24 * u}) scale(${u})`);
}
function drawScoreboard(g, state, setup, u, popTeam = null) {
  drawTitle(g, setup, u);
  const ours = setup.ours || "A", opp = ours === "A" ? "B" : "A";
  const rows = [{ t: opp, label: "상대" }, { t: ours, label: "우리" }];
  if (setup.ours_row === "top") rows.reverse();   // 우리 팀을 윗줄로
  const X = 24 * u, Y = 24 * u, Wd = 380, RH = 58;
  const sb = el("g", { transform: `translate(${X},${Y}) scale(${u})` }, g);
  el("rect", { x: 0, y: 0, width: Wd, height: 30 + RH * 2 + 8, rx: 14, class: "sb-bg" }, sb);
  const hd = el("text", { x: 16, y: 21, class: "sb-head" }, sb);
  hd.textContent = `GAME ${state.game || 1} · ${setup.target}점 · ${setup.mode === "singles" ? "단식" : "복식"}`;
  const names = { A: setup.nameA, B: setup.nameB };
  rows.forEach((r, i) => {
    const y = 30 + i * RH; const row = el("g", { transform: `translate(0,${y})` }, sb);
    if (i === 1) el("line", { x1: 12, y1: 0, x2: Wd - 12, y2: 0, stroke: "rgba(255,255,255,.10)" }, row);
    el("rect", { x: 12, y: 10, width: 7, height: RH - 20, rx: 3, fill: `var(--team${r.t})` }, row);
    let nm = names[r.t] || ("팀 " + r.t); if (nm.length > 7) nm = nm.slice(0, 6) + "…";
    const nmEl = el("text", { x: 32, y: RH / 2, class: "sb-name" }, row); nmEl.textContent = nm;
    const tw = Math.min(nm.length * 24 + 42, 200);
    const mine = r.label === "우리";
    el("rect", { x: tw, y: RH / 2 - 11, width: 40, height: 22, rx: 6, fill: mine ? "var(--accent)" : "rgba(255,255,255,.14)" }, row);
    const tg = el("text", { x: tw + 20, y: RH / 2, class: "sb-tag", "text-anchor": "middle", fill: mine ? "var(--accent-ink)" : "#cfd8d2" }, row); tg.textContent = r.label;
    if (state.server === r.t) {
      const sv = el("g", { transform: `translate(${Wd - 118},${RH / 2})` }, row);
      el("circle", { r: 13, fill: "var(--accent)" }, sv);
      el("path", { d: "M-4,4 L-6,-6 L6,-6 L4,4 Z", fill: "none", stroke: "var(--accent-ink)", "stroke-width": 1.8, "stroke-linejoin": "round" }, sv);
      el("circle", { cy: 5, r: 3, fill: "var(--accent-ink)" }, sv);
    }
    const box = el("rect", { x: Wd - 86, y: 6, width: 74, height: RH - 12, rx: 10, fill: `color-mix(in srgb,var(--team${r.t}) 85%,#000)`, class: popTeam === r.t ? "sb-flash" : "" }, row);
    const scg = el("g", { transform: `translate(${Wd - 49},${RH / 2})` }, row);
    const sc = el("text", { x: 0, y: 1, class: "sb-score" + (popTeam === r.t ? " sb-pop" : "") }, scg); sc.textContent = state.score[r.t];
  });
}

/* ---------------- 프레임 추천 ---------------- */
async function loadSuggest() {
  const box = $("#suggest"); if (!box) return;
  if (!S.suggest) {
    box.innerHTML = Array.from({ length: 6 }, () => `<div class="thumb skel"></div>`).join("") ;
    try { S.suggest = await api(`/api/videos/${S.vid}/suggest-frames`); }
    catch (e) { box.innerHTML = `<div class="empty">추천 프레임을 못 불러왔어요: ${esc(e.message)}</div>`; return; }
  }
  if (S.step !== 1 || !$("#suggest")) return;
  if (!S.suggest.length) { box.innerHTML = `<div class="empty">추천할 만한 프레임이 없어요. 슬라이더로 직접 골라 주세요.</div>`; return; }
  box.innerHTML = S.suggest.map(s => `<button class="thumb ${s.frame === S.frame ? "sel" : ""}" data-f="${s.frame}" title="#${s.frame}">
    <img src="/api/videos/${S.vid}/frames/${s.frame}?w=300" alt="" loading="lazy"><span>${fmtTime(s.frame / S.meta.fps)}</span>
    <span class="badge ${s.people === 4 ? "" : "low"}">${s.people}명</span></button>`).join("");
  $$(".thumb", box).forEach(t => t.onclick = () => { loadFrame(+t.dataset.f); toast("추천 프레임으로 이동했어요"); });
}

/* ---------------- 선수 검출 ---------------- */
async function runDetect() {
  if (S.step !== 3) return;
  const chip = $("#detChip"); chip.classList.remove("hidden"); chip.className = "chip"; chip.innerHTML = `<span class="dot" style="background:var(--accent)"></span>선수 찾는 중`;
  $("#stage").classList.add("loading"); S.detecting = true;
  const frame = S.frame;
  try {
    const r = await api(`/api/videos/${S.vid}/detect`, { method: "POST", json: { frame, corners: convex(S.corners) ? S.corners : null } });
    if (frame !== S.frame) return;
    // 이전 선택을 박스 IoU로 이어 붙이기
    const old = S.people, oldAssign = S.assign; S.assign = {};
    for (const p of r.people) {
      let best = null, bi = 0;
      for (const o of old) { const v = iou(o.box, p.box); if (v > bi) { bi = v; best = o; } }
      if (best && bi > .3 && oldAssign[best.id]) S.assign[p.id] = oldAssign[best.id];
    }
    S.people = r.people; S.detFrame = frame;
    const inPlay = r.people.filter(p => p.in_play !== false).length;
    chip.className = "chip " + (inPlay >= (S.fmt.mode === "doubles" ? 4 : 2) ? "ok" : "warn");
    chip.innerHTML = `<span class="dot" style="background:currentColor"></span>코트 안 ${inPlay}명 · 전체 ${r.people.length}명`;
    if (!Object.keys(S.assign).length) autoAssign(true);
  } catch (e) { toast("검출 실패: " + e.message, true); chip.classList.add("hidden"); }
  finally { S.detecting = false; $("#stage")?.classList.remove("loading"); drawOverlay(); renderPanel(); saveLocal(); }
}
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9);
}
function autoAssign(quiet = false) {
  const per = S.fmt.mode === "doubles" ? 2 : 1;
  const inPlay = S.people.filter(p => p.in_play !== false && p.court);
  const centered = p => Math.abs(p.court[0] - W_M / 2) + Math.max(0, -p.court[1]) + Math.max(0, p.court[1] - L_M);
  const far = inPlay.filter(p => p.side === "far").sort((a, b) => centered(a) - centered(b) || b.conf - a.conf).slice(0, per);
  const near = inPlay.filter(p => p.side === "near").sort((a, b) => centered(a) - centered(b) || b.conf - a.conf).slice(0, per);
  if (far.length < per || near.length < per) { if (!quiet) toast("코트 양쪽에서 선수를 다 찾지 못했어요. 직접 골라 주세요"); return; }
  for (const k in S.assign) if (S.assign[k] !== "R") delete S.assign[k];   // 심판 지정은 그대로
  far.forEach(p => S.assign[p.id] = "A"); near.forEach(p => S.assign[p.id] = "B");
  let ref = null;
  if (!Object.values(S.assign).includes("R")) {
    const out = p => p.court && !S.assign[p.id] && p.in_play === false;
    const dx = p => p.court[0] < 0 ? -p.court[0] : p.court[0] - W_M;     // 사이드라인 바깥으로 얼마나
    const cand = S.people.filter(p => out(p) && dx(p) > 0.1 && dx(p) < 3 && Math.abs(p.court[1] - NET) < 4)
      .sort((a, b) => Math.abs(a.court[1] - NET) - Math.abs(b.court[1] - NET));
    if (cand.length) { ref = cand[0]; S.assign[ref.id] = "R"; }
  }
  if (!quiet) toast(`위쪽 선수를 팀 A, 아래쪽 선수를 팀 B로 배정했어요${ref ? ` · 네트 옆 #${ref.id}는 심판으로` : ""}`);
  drawOverlay(); renderPanel(); saveLocal();
}
function togglePlayer(p) {
  const cur = S.assign[p.id];
  if (cur === S.activeTeam) delete S.assign[p.id];
  else {
    const max = S.activeTeam === "R" ? 6 : S.fmt.mode === "doubles" ? 2 : 1;
    if (Object.values(S.assign).filter(t => t === S.activeTeam).length >= max) { toast(`${S.activeTeam === "R" ? "심판" : S.teams[S.activeTeam].name}은 최대 ${max}명이에요`); return; }
    S.assign[p.id] = S.activeTeam;
  }
  drawOverlay(); renderPanel(); saveLocal();
}
function playerChecks() {
  const max = S.fmt.mode === "doubles" ? 2 : 1;
  const by = t => S.people.filter(p => S.assign[p.id] === t);
  const sides = t => [...new Set(by(t).map(p => p.side).filter(Boolean))];
  const cA = by("A").length, cB = by("B").length, sA = sides("A"), sB = sides("B");
  return {
    max, cA, cB,
    okCount: cA === max && cB === max,
    okSame: sA.length <= 1 && sB.length <= 1,
    okSide: sA.length === 1 && sB.length === 1 && sA[0] !== sB[0],
  };
}

/* ---------------- 패널 ---------------- */
function renderPanel() {
  const P = $("#panel"), chip = $("#modeChip"); if (!P) return;
  if (S.step === 1) {
    chip.innerHTML = '<span class="dot" style="background:var(--accent)"></span>프레임 선택';
    P.innerHTML = `<h2>프레임 선택</h2><p class="desc">코트 라인이 잘 보이고 선수 ${S.fmt.mode === "doubles" ? 4 : 2}명이 모두 코트 안에 서 있는 장면을 골라 주세요. 서브 직전 장면이 가장 좋아요.</p>
      <ul class="checks">
        <li class="ok"><i>✓</i>네트 기둥과 코트 라인이 잘 보여요 (귀퉁이는 화면 밖이어도 돼요)</li>
        <li class="ok"><i>✓</i>선수끼리 겹치지 않아요</li>
        <li class="ok"><i>✓</i>아래 추천 프레임은 사람 수로 골랐어요</li>
      </ul>
      <button class="cta" id="next">이 프레임으로 · 코트 지정</button>`;
    $("#next").onclick = () => { S.people = []; S.detFrame = -1; go(2); };
  }
  else if (S.step === 2) {
    const f = S.fit, eq = eqCount(), ok = courtOk(), gl = goodLines();
    chip.innerHTML = `<span class="dot" style="background:${S.pick ? (S.pick.kind === "p" ? "var(--accent)" : "#4fe3ff") : "var(--accent)"}"></span>${S.pick ? "영상에서 찍는 중" : "코트 지정 모드"}`;
    const gd = S.guide != null ? GUIDE[S.guide] : null;
    const msg = gd ? `<span class="gstep">${S.guide + 1} / ${GUIDE.length}</span><b>${gd.kind === "p" ? CATALOG[gd.i].name : LINE_CATALOG[gd.i].name}</b><br>${gd.how}
        <span class="gbtns"><button class="icon-btn sm" id="gSkip">건너뛰기</button><button class="icon-btn sm" id="gStop">그만</button></span>`
      : S.pick?.kind === "p" ? `<b>${CATALOG[S.pick.i].name}</b> · 영상에서 이 자리를 클릭하세요 <kbd>Esc</kbd> 취소`
      : S.pick?.kind === "l" ? `<b>${LINE_CATALOG[S.pick.i].name}</b> · 영상에서 이 라인 위를 클릭하세요. 서로 멀리 2곳 이상 · 다 찍었으면 <kbd>Esc</kbd>`
      : eq < 8 ? "<b>순서대로 찍기</b>를 누르면 네트 기둥 2개 → 바깥 라인 네 면을 차례로 안내해요. 꼭짓점은 화면 밖이어도 괜찮아요"
      : f?.error ? `<span class="bad-t">${esc(f.error)}</span>`
      : f && f.spare < 2 ? "점이나 라인을 하나 더 찍으면 잘못 찍은 걸 오차로 알아챌 수 있어요"
      : "오차가 큰 점·라인은 끌어서 옮기거나 지우세요";
    const errCls = e => e != null && e > 8 ? "bad-t" : "";
    const items = S.cpts.map((q, i) => { const e = f?.errors?.[i]; return `<li class="${S.sel?.kind === "p" && S.sel.i === i ? "hot" : ""}" data-k="p" data-i="${i}"><span class="n">${i + 1}</span><span class="nm">${esc(cName(q.court))}</span><span class="xy ${errCls(e)}">${e != null ? e.toFixed(1) + "px" : "–"}</span><button class="x" data-del="1" aria-label="${i + 1}번 점 지우기">×</button></li>`; }).join("")
      + S.clines.map((l, i) => { const e = f?.line_errors?.[gl.indexOf(l)]; return `<li class="ln ${S.sel?.kind === "l" && S.sel.i === i ? "hot" : ""}" data-k="l" data-i="${i}"><span class="n">L${i + 1}</span><span class="nm">${esc(lName(l.line))} · ${l.px.length}곳</span><span class="xy ${errCls(e)}">${e != null ? e.toFixed(1) + "px" : l.px.length < 2 ? "1곳 더" : "–"}</span><button class="x" data-del="1" aria-label="L${i + 1} 지우기">×</button></li>`; }).join("");
    const big = f && !f.error ? f.mean_err.toFixed(1) : "–";
    P.innerHTML = `<h2>코트 지정</h2><p class="desc">도면에서 점이나 라인을 고른 뒤, 영상에서 그 자리를 클릭하세요. 형광 라인이 실제 코트 라인에 겹치면 맞은 거예요.</p>
      <div class="court-pick">${courtDiagram()}
        <div class="fit-stat"><span class="lbl">평균 오차</span><b class="display ${f && !f.error && f.mean_err > 8 ? "warn" : ""}">${big}<small>px</small></b>
          <span class="lbl">식 ${eq} / 8${f && !f.error ? ` · 여유 ${f.spare}` : ""}</span>
          <span class="legend"><i class="lp"></i>● 점 · 한 번 클릭</span><span class="legend"><i class="ll"></i>◆ 라인 · 2곳 이상</span></div></div>
      ${S.guide == null ? `<button class="cta ghost guide-btn" id="gStart">${S.cpts.length || S.clines.length ? "빠진 것 순서대로 찍기" : "순서대로 찍기 · 기둥 2 + 라인 4"}</button>` : ""}
      <p class="pick-msg">${msg}</p>
      ${items ? `<ul class="corners cp-list">${items}</ul>` : ""}
      <div class="toggle-row">안쪽 점·라인도 고르기<button class="switch ${S.inner ? "on" : ""}" id="innerSw" role="switch" aria-checked="${S.inner}" aria-label="안쪽 점·라인도 고르기"></button></div>
      <div class="toggle-row">화면 밖까지 넓게 보기<button class="switch ${S.wide ? "on" : ""}" id="wideSw" role="switch" aria-checked="${S.wide}" aria-label="화면 밖까지 넓게 보기"></button></div>
      <div class="toggle-row">코트 라인 미리보기<button class="switch ${S.showLines ? "on" : ""}" id="lineSw" role="switch" aria-checked="${S.showLines}" aria-label="코트 라인 미리보기"></button></div>
      <div class="btn-row"><button class="icon-btn sm" id="labCourt" title="같은 영상의 실험 페이지 코트 설정(점·라인)을 가져와요">실험 페이지 코트 불러오기</button><button class="icon-btn sm" id="clearCourt">모두 지우기</button></div>
      <ul class="checks" style="margin-top:12px">
        <li class="${eq >= 8 ? "ok" : "bad"}"><i>${eq >= 8 ? "✓" : "!"}</i>점·라인 충분 (식 8개 이상)</li>
        ${(() => { const m = sidesMissing(); return `<li class="${m.length ? "bad" : "ok"}"><i>${m.length ? "!" : "✓"}</i>${m.length ? `바깥 네 면 중 안 정해짐: <b>${m.map(x => x.nm).join(", ")}</b> · 라인으로 찍어 주세요` : "바깥 네 면 모두 정해짐"}</li>`; })()}
        <li class="${f && !f.error && f.mean_err <= 8 ? "ok" : "bad"}"><i>${f && !f.error && f.mean_err <= 8 ? "✓" : "!"}</i>평균 오차 8px 이하</li>
        <li class="${f && !f.error && !f.mirrored ? "ok" : "bad"}"><i>${f && !f.error && !f.mirrored ? "✓" : "!"}</i>${f?.mirrored ? "좌우가 뒤집힌 것 같아요 (왼쪽·오른쪽은 카메라에서 볼 때)" : "좌우 방향 맞음"}</li>
      </ul>
      <button class="cta" id="next" ${ok ? "" : "disabled"}>다음 · 선수 선택</button>`;
    bindDiagram();
    $("#gStart")?.addEventListener("click", startGuide);
    $("#gSkip")?.addEventListener("click", skipGuide);
    $("#gStop")?.addEventListener("click", () => { S.guide = null; S.pick = null; drawOverlay(); renderPanel(); });
    $$(".cp-list li", P).forEach(li => li.onclick = e => {
      const k = li.dataset.k, i = +li.dataset.i;
      if (e.target.dataset.del) { (k === "p" ? S.cpts : S.clines).splice(i, 1); S.sel = null; drawOverlay(); renderPanel(); refit(true); return; }
      S.guide = null;
      if (k === "l") { S.pick = { kind: "l", i: LINE_CATALOG.findIndex(c => sameL(c.l, S.clines[i].line)) }; S.sel = { kind: "l", i, j: S.clines[i].px.length - 1 }; }
      else { S.sel = { kind: "p", i }; S.pick = null; }
      drawOverlay(); renderPanel();
    });
    $("#innerSw").onclick = () => { S.inner = !S.inner; renderPanel(); saveLocal(); };
    $("#wideSw").onclick = () => { S.wide = !S.wide; applyView(); drawOverlay(); renderPanel(); saveLocal(); };
    $("#lineSw").onclick = () => { S.showLines = !S.showLines; drawOverlay(); renderPanel(); saveLocal(); };
    $("#labCourt").onclick = loadLabCourt;
    $("#clearCourt").onclick = () => { if (!S.cpts.length && !S.clines.length) return; if (!confirm("찍은 점·라인을 모두 지울까요?")) return; S.cpts = []; S.clines = []; S.sel = null; S.pick = null; S.guide = null; S.fit = null; drawOverlay(); renderPanel(); saveLocal(); };
    $("#next").onclick = () => { S.pick = null; S.guide = null; S.detFrame = -1; go(3); };
  }
  else if (S.step === 3) {
    const actName = S.activeTeam === "R" ? "심판" : S.teams[S.activeTeam].name;
    chip.innerHTML = `<span class="dot" style="background:var(--team${S.activeTeam})"></span>${esc(actName)} 선택 중`;
    const c = playerChecks();
    const nR = Object.values(S.assign).filter(t => t === "R").length;
    const mem = t => {
      const ids = Object.keys(S.assign).filter(k => S.assign[k] === t);
      let h = ids.map(i => `<span class="member ${t}">선수 #${i}</span>`).join("");
      for (let i = ids.length; i < c.max; i++) h += `<span class="member empty">빈 자리</span>`; return h;
    };
    P.innerHTML = `<h2>선수 선택</h2><p class="desc">팀을 고른 뒤 영상에서 선수 박스를 클릭하세요. 다시 클릭하면 해제돼요. 점선 박스는 코트 밖 사람(심판·관중)이에요.</p>
      <div class="team-tabs">
        <button class="team-tab A ${S.activeTeam === "A" ? "on" : ""}" data-t="A"><div class="t" style="color:var(--teamA)">Team A</div><div class="c">${c.cA}/${c.max}명</div></button>
        <button class="team-tab B ${S.activeTeam === "B" ? "on" : ""}" data-t="B"><div class="t" style="color:var(--teamB)">Team B</div><div class="c">${c.cB}/${c.max}명</div></button>
        <button class="team-tab R ${S.activeTeam === "R" ? "on" : ""}" data-t="R" title="코트 옆 심판·선심. 지정하면 추적이 선수로 잡지 않아요"><div class="t" style="color:var(--teamR)">심판</div><div class="c">${nR}명</div></button>
      </div>
      <div class="team-card A"><input value="${esc(S.teams.A.name)}" data-n="A" maxlength="12" aria-label="팀 A 이름"><div class="members">${mem("A")}</div></div>
      <div class="team-card B"><input value="${esc(S.teams.B.name)}" data-n="B" maxlength="12" aria-label="팀 B 이름"><div class="members">${mem("B")}</div></div>
      <div class="btn-row"><button class="icon-btn sm" id="autoBtn">위/아래로 자동 배정</button><button class="icon-btn sm" id="swapBtn">팀 바꾸기</button><button class="icon-btn sm" id="redetBtn">다시 찾기</button></div>
      <div class="toggle-row">관절(자세) 표시<button class="switch ${S.showPose ? "on" : ""}" id="poseSw" role="switch" aria-checked="${S.showPose}" aria-label="관절 표시"></button></div>
      <ul class="checks" style="margin-top:12px">
        <li class="${c.okCount ? "ok" : "bad"}"><i>${c.okCount ? "✓" : "!"}</i>팀당 ${c.max}명 선택</li>
        <li class="${c.okSame ? "ok" : "bad"}"><i>${c.okSame ? "✓" : "!"}</i>같은 팀은 네트 같은 쪽</li>
        <li class="${c.okSide ? "ok" : "bad"}"><i>${c.okSide ? "✓" : "!"}</i>두 팀이 네트 반대편</li>
        <li class="${nR ? "ok" : "opt"}"><i>${nR ? "✓" : "–"}</i>${nR ? `심판 ${nR}명 지정 · 선수로 잡지 않아요` : "코트 옆 심판이 있으면 <b>심판</b> 탭을 누르고 그 사람을 클릭 (선택)"}</li>
      </ul>
      <button class="cta" id="next" ${c.okCount && c.okSide ? "" : "disabled"}>다음 · 경기 설정</button>`;
    $$(".team-tab", P).forEach(b => b.onclick = () => { S.activeTeam = b.dataset.t; renderPanel(); });
    $$("input[data-n]", P).forEach(i => i.oninput = () => { S.teams[i.dataset.n].name = i.value.trim() || ("팀 " + i.dataset.n); drawOverlay(); saveLocal(); chip.innerHTML = `<span class="dot" style="background:var(--team${S.activeTeam})"></span>${esc(S.activeTeam === "R" ? "심판" : S.teams[S.activeTeam].name)} 선택 중`; });
    $("#autoBtn").onclick = () => autoAssign(false);
    $("#swapBtn").onclick = () => { for (const k in S.assign) if (S.assign[k] !== "R") S.assign[k] = S.assign[k] === "A" ? "B" : "A"; drawOverlay(); renderPanel(); saveLocal(); };
    $("#redetBtn").onclick = runDetect;
    $("#poseSw").onclick = () => { S.showPose = !S.showPose; drawOverlay(); renderPanel(); saveLocal(); };
    $("#next").onclick = () => go(4);
  }
  else if (S.step === 4) {
    chip.innerHTML = '<span class="dot" style="background:var(--court)"></span>경기 설정';
    const f = S.fmt, T = S.teams;
    const sb = (t, k) => `<div class="box"><span class="nm" style="color:var(--team${t})">${esc(T[t].name)}</span><b>${f[k]}</b>
      <span class="pm"><button data-k="${k}" data-d="1" aria-label="${esc(T[t].name)} 점수 올리기">+</button><button data-k="${k}" data-d="-1" aria-label="${esc(T[t].name)} 점수 내리기">−</button></span></div>`;
    const seg = (g, opts) => `<div class="seg" data-g="${g}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(f[g]) === String(v) ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
    P.innerHTML = `<h2>경기 설정</h2><p class="desc">경기 중간부터 찍은 영상이면 시작 점수와 게임을 맞춰 주세요. 첫 서브 팀은 영상의 첫 서브 기준이에요.</p>
      <div class="field"><label>첫 서브 팀</label>${seg("first", [["A", T.A.name], ["B", T.B.name]])}</div>
      ${titleFields(f)}
      <div class="field"><label>최종 점수 <small class="opt">알면 넣으세요 · 분석이 이 점수에 맞춰요</small></label>
        <div class="fin-row big"><span class="nm" style="color:var(--teamA)">${esc(T.A.name)}</span><input type="number" id="fA" min="0" max="40" value="${f.final?.A ?? ""}" placeholder="-" aria-label="${esc(T.A.name)} 최종 점수">
          <span>:</span><input type="number" id="fB" min="0" max="40" value="${f.final?.B ?? ""}" placeholder="-" aria-label="${esc(T.B.name)} 최종 점수"><span class="nm" style="color:var(--teamB)">${esc(T.B.name)}</span></div></div>
      <details class="field more"${f.scoreA || f.scoreB ? " open" : ""}><summary>경기 중간부터 찍은 영상이면 · 시작 점수</summary>
        <div class="score-in">${sb("A", "scoreA")}<span class="vs">VS</span>${sb("B", "scoreB")}</div></details>
      <div class="field"><label>시작 게임</label>${seg("game", [[1, "1게임"], [2, "2게임"], [3, "3게임"]])}</div>
      <div class="field"><label>우리 팀</label>${seg("ours", [["A", T.A.name], ["B", T.B.name]])}</div>
      <div class="field"><label>스코어보드에서 우리 팀 줄</label>${seg("ours_row", [["top", "윗줄"], ["bottom", "아랫줄"]])}</div>
      <div class="field"><label>게임 규칙</label>${seg("target", [[25, "25점 단판"], [21, "21점 · 듀스 최대 30"], [15, "15점"]])}</div>
      <div class="field"><label>코트 교대 시각</label><input class="sw-in" id="swIn" value="${esc((f.switch_manual || []).map(t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`).join(", "))}" placeholder="비우면 자동 (선수 옷 색으로 찾음)" aria-label="코트 교대 시각, 비우면 자동"><p class="hint-s">자동이 틀렸을 때만 분:초로 적어요. 여러 번이면 쉼표 (예: 3:50, 12:10)</p></div>
      <div class="toggle-row">스코어보드 미리보기<button class="switch ${f.scoreboard ? "on" : ""}" id="boardSw" role="switch" aria-checked="${f.scoreboard}" aria-label="스코어보드 미리보기"></button></div>
      <button class="cta" id="next">분석 시작</button>`;
    $$(".seg", P).forEach(s => $$("button", s).forEach(b => b.onclick = () => {
      const g = s.dataset.g; f[g] = ["game", "target"].includes(g) ? +b.dataset.v : b.dataset.v; renderPanel(); drawOverlay(); saveLocal();
    }));
    $$(".pm button", P).forEach(b => b.onclick = () => {
      f[b.dataset.k] = clamp(f[b.dataset.k] + +b.dataset.d, 0, 29); renderPanel();
      const g = $("#overlay"); g.innerHTML = ""; drawScoreboard(g, { score: { A: f.scoreA, B: f.scoreB }, server: f.first, game: f.game }, setupNow(), U(), b.dataset.k.slice(-1)); saveLocal();
    });
    $("#boardSw").onclick = () => { f.scoreboard = !f.scoreboard; renderPanel(); drawOverlay(); saveLocal(); };
    bindTitleFields(f, (upd, quiet) => { Object.assign(f, upd); saveLocal(); if (!quiet) renderPanel(); drawOverlay(); });
    ["fA", "fB"].forEach(id => $("#" + id).oninput = () => {
      const a = $("#fA").value, b = $("#fB").value;
      f.final = a !== "" && b !== "" ? { A: +a, B: +b } : null; saveLocal();
    });
    $("#swIn").onchange = e => {
      const out = []; for (const part of e.target.value.split(/[,\s]+/).filter(Boolean)) { const q = part.split(":").map(Number); if (q.some(isNaN)) { toast("3:50 처럼 분:초로 적어 주세요", true); return; } out.push(q.reduce((a, b) => a * 60 + b, 0)); }
      f.switch_manual = out; saveLocal();
    };
    $("#next").onclick = startAnalyze;
  }
}

async function startAnalyze() {
  const btn = $("#next"); btn.disabled = true; btn.textContent = "설정 저장 중";
  try {
    const box = id => S.people.find(p => String(p.id) === String(id))?.box;
    const teams = {};
    for (const t of ["A", "B"]) teams[t] = { name: S.teams[t].name, bboxes: Object.keys(S.assign).filter(k => S.assign[k] === t).map(box).filter(Boolean) };
    const officials = Object.keys(S.assign).filter(k => S.assign[k] === "R").map(box).filter(Boolean);
    const { scoreboard, ...match } = S.fmt;
    S.config = await api(`/api/videos/${S.vid}/config`, { method: "PUT", json: { ref_frame: S.detFrame >= 0 ? S.detFrame : S.frame, corners: S.corners, points: S.cpts, lines: goodLines(), teams, officials, match: { ...match, scoreboard } } });
    S.job = await api(`/api/videos/${S.vid}/analyze`, { method: "POST" });
    go(5);
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "분석 시작"; }
}

/* =========================================================
   5. 분석 진행
   ========================================================= */
let pollTimer;
function renderAnalyze(v) {
  const j = S.job;
  v.innerHTML = `<main class="wide"><section class="card analyze" style="max-width:960px;margin:0 auto;width:100%">
    <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">
      <div><h2 class="display" style="margin:0;font-size:34px">${j ? "경기를 읽는 중" : "분석 준비"}</h2>
      <p class="desc" style="margin:4px 0 0;color:var(--muted)">${esc(S.meta.name)} · ${fmtTime(S.meta.duration)}</p></div>
      <div class="spacer"></div><div class="big-pct" id="bigPct">0<small>%</small></div>
    </div>
    <div class="rally" aria-hidden="true"><div class="progress" id="rp" style="width:0"></div><div class="lines"></div><div class="netpost"></div>
      <svg class="bird" id="bird" style="left:4%"><use href="#i-shuttle"/></svg></div>
    <ul class="stage-list" id="stages"></ul>
    <div id="jobErr"></div>
    <div class="btn-row" style="margin:0">
      ${j ? `<button class="icon-btn" id="cancelBtn">분석 취소</button>` : ""}
      <button class="icon-btn" id="backBtn">설정으로 돌아가기</button>
      ${S.result ? `<button class="icon-btn" id="resBtn">이전 결과 편집</button>` : ""}
      ${!j ? `<button class="icon-btn" id="startBtn">분석 시작</button>` : ""}
    </div>
  </section></main>`;
  $("#backBtn").onclick = () => go(4);
  $("#resBtn") && ($("#resBtn").onclick = () => go(6));
  $("#startBtn") && ($("#startBtn").onclick = async () => { try { S.job = await api(`/api/videos/${S.vid}/analyze`, { method: "POST" }); render(); } catch (e) { toast(e.message, true); } });
  $("#cancelBtn") && ($("#cancelBtn").onclick = async () => { if (confirm("분석을 취소할까요?")) await api(`/api/jobs/${S.job.id}/cancel`, { method: "POST" }).catch(() => { }); });
  if (j) { paintJob(j); pollJob(); }
}
function paintJob(j) {
  const p = Math.round(j.progress * 100);
  const big = $("#bigPct"); if (!big) return;
  big.innerHTML = `${p}<small>%</small>`;
  $("#rp").style.width = p + "%"; $("#bird").style.left = clamp(p, 4, 96) + "%";
  $("#stages").innerHTML = j.stages.map((s, i) => `<li class="${s.state}"><i>${s.state === "done" ? "✓" : i + 1}</i>${esc(s.name)}<span class="sub">${esc(s.msg || (s.state === "run" ? Math.round(s.progress * 100) + "%" : ""))}</span></li>`).join("");
  $("#jobErr").innerHTML = j.state === "error" ? `<div class="err-box">분석 중 오류가 났어요.\n${esc(j.error)}</div>` : j.state === "cancelled" ? `<div class="err-box">분석을 취소했어요.</div>` : "";
}
function pollJob() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!S.job || S.step !== 5) return;
    try {
      const j = await api(`/api/jobs/${S.job.id}`); S.job = j; paintJob(j);
      if (j.state === "done") {
        S.result = await api(`/api/videos/${S.vid}/result`); S.job = null;
        toast(`분석 완료 · 서브 ${S.result.events.length}개를 찾았어요`); go(6); return;
      }
      if (["error", "cancelled"].includes(j.state)) { S.job = null; renderStepper(); const c = $("#cancelBtn"); c && c.remove(); return; }
    } catch (e) { toast(e.message, true); S.job = null; return; }
    pollJob();
  }, 900);
}

/* =========================================================
   6. 결과 — 영상 + 실시간 스코어보드 + 점수 흐름 + 이벤트 수정
   ========================================================= */
let video, rafId, lastStateKey = null;
function stopVideoLoop() { cancelAnimationFrame(rafId); rafId = null; clearTimeout(pollTimer); }

function activeEvents() { return (S.result?.events || []).filter(e => !e.removed && e.server); }
function stateAt(t) {
  const st = S.result.setup;
  let s = { score: { A: +st.scoreA || 0, B: +st.scoreB || 0 }, server: st.first || "A", game: +st.game || 1, ev: null, prev: null };
  for (const e of activeEvents()) {
    if (e.t_still > t + 1e-3) break;
    s = { score: e.score, server: e.server, game: e.game, ev: e, prev: s };
  }
  return s;
}
function renderResult(v) {
  const r = S.result; if (!r) { go(5); return; }
  const m = S.meta;
  v.innerHTML = `<main>
    <section class="card stage-wrap">
      <div class="stage-top"><span class="chip"><span class="dot" style="background:var(--ok)"></span>${S.step === 7 ? "저장" : "편집"}</span><span class="chip" id="hintChip">${HINTS[S.step]}</span>
        <span class="spacer"></span><div class="seg" id="srcSeg" style="padding:3px"><button data-k="auto" class="on" title="원본 영상 위에 점수를 실시간으로 표시">실시간 점수</button><button data-k="overlay" ${S.meta.has_overlay ? "title='스코어보드를 합성한 영상'" : "disabled title='점수 영상을 먼저 만들어 주세요'"}>합성 영상</button><button data-k="public" ${S.meta.has_public ? "title='얼굴 모자이크 처리한 공개용 영상'" : "disabled title='공개용 영상을 먼저 만들어 주세요'"}>공개용</button></div></div>
      <div class="player-wrap" style="aspect-ratio:${m.width}/${m.height}">
        <video id="vid" src="/api/videos/${S.vid}/stream?kind=auto" controls playsinline preload="metadata"></video>
        <svg class="ov" id="ov" viewBox="0 0 ${m.width} ${m.height}"></svg>
        <div class="flag" id="flag">확인 필요</div>
      </div>
      <div class="rv-dock" id="rvDock"></div>
      <div class="worm" id="worm"></div>
    </section>
    <aside>
      <div class="card panel" id="rpanel"></div>
    </aside>
  </main>`;
  video = $("#vid");
  $$("#srcSeg button").forEach(b => b.onclick = () => {
    if (b.disabled) return;
    const t = video.currentTime; $$("#srcSeg button").forEach(x => x.classList.toggle("on", x === b));
    video.src = `/api/videos/${S.vid}/stream?kind=${b.dataset.k}`; video.currentTime = t; $("#ov").classList.toggle("hidden", b.dataset.k !== "auto");
  });
  video.addEventListener("error", () => { if (!S.meta.has_preview) toast("브라우저가 이 영상 형식을 재생하지 못해요. 잠시 후 변환된 영상으로 다시 열어 주세요", true); });
  renderWorm(); renderRPanel(); loop();
  if (S.renderJob) pollRender();
}
function loop() {
  const t = video?.currentTime || 0;
  const st = stateAt(t);
  const key = `${st.score.A}-${st.score.B}-${st.server}-${st.game}`;
  if (key !== lastStateKey) {
    const g = $("#ov"); g.innerHTML = "";
    let pop = null;
    if (st.prev && lastStateKey) { for (const k of ["A", "B"]) if (st.score[k] !== st.prev.score[k]) pop = k; }
    drawScoreboard(g, st, S.result.setup, S.meta.width / 1600, pop);
    lastStateKey = key;
    $("#flag").classList.toggle("show", !!(st.ev && st.ev.flags?.length));
    if (st.ev) $("#flag").textContent = st.ev.flags?.[0] || "";
    markCurrent(st.ev?.id);
  }
  if (S.review?.t != null && video && !video.paused && t > S.review.t + 3) seek(S.review.t - 3, true);
  const head = $("#wormHead");
  if (head && S._worm) { const x = S._worm.x(t); head.setAttribute("x1", x); head.setAttribute("x2", x); }
  rafId = requestAnimationFrame(loop);
}
function seek(t, play = false) { if (!video) return; video.currentTime = Math.max(0, t); if (play) video.play().catch(() => { }); }

/* 점수 흐름 차트 */
function renderWorm() {
  const box = $("#worm"); const r = S.result; const evs = activeEvents();
  const dur = S.meta.duration || 1;
  const setup = r.setup;
  box.innerHTML = `<div class="worm-top"><b class="display" style="font-size:18px">점수 흐름</b>
    <span class="leg"><i style="background:var(--teamA)"></i>${esc(setup.nameA)}</span><span class="leg"><i style="background:var(--teamB)"></i>${esc(setup.nameB)}</span>
    <span class="leg"><i style="background:var(--warn);height:8px;width:8px;border-radius:50%"></i>확인 필요</span><span class="spacer"></span>
    <span class="leg">점을 누르면 그 서브 장면으로 이동해요</span></div><svg id="wormSvg" preserveAspectRatio="none"></svg>`;
  const svgW = $("#wormSvg"); const Wd = svgW.clientWidth || 800, Ht = 150, pl = 26, pr = 8, pt = 8, pb = 20;
  svgW.setAttribute("viewBox", `0 0 ${Wd} ${Ht}`); svgW.setAttribute("preserveAspectRatio", "none");
  const top = Math.max(0, ...evs.map(e => Math.max(e.score.A, e.score.B)), +setup.scoreA || 0, +setup.scoreB || 0);
  let maxS = Math.max(5, Math.ceil((top + 1) / 5) * 5);
  const x = t => pl + (Wd - pl - pr) * clamp(t / dur, 0, 1), y = s => Ht - pb - (Ht - pb - pt) * s / maxS;
  S._worm = { x };
  for (let s = 0; s <= maxS; s += 5) { el("line", { x1: pl, x2: Wd - pr, y1: y(s), y2: y(s), class: "grid" }, svgW); const tx = el("text", { x: pl - 6, y: y(s) + 4, class: "axis", "text-anchor": "end" }, svgW); tx.textContent = s; }
  const ticks = Math.min(10, Math.ceil(dur / 60)); for (let i = 0; i <= ticks; i++) { const t = dur * i / ticks; const tx = el("text", { x: x(t), y: Ht - 4, class: "axis", "text-anchor": "middle" }, svgW); tx.textContent = fmtTime(t); }
  // 게임별 선
  const seg = { A: [], B: [] }; let game = +setup.game || 1; let cur = { A: [[0, +setup.scoreA || 0]], B: [[0, +setup.scoreB || 0]] };
  const flush = () => { for (const k of ["A", "B"]) seg[k].push(cur[k]); };
  let prev = { A: +setup.scoreA || 0, B: +setup.scoreB || 0 };
  for (const e of evs) {
    if (e.game !== game) {
      // 이전 게임 마지막 점수 (games 기록)
      const g = e.games?.[e.games.length - 1]; if (g) for (const k of ["A", "B"]) { cur[k].push([e.t_still, prev[k]], [e.t_still, g[k]]); }
      flush(); el("line", { x1: x(e.t_still), x2: x(e.t_still), y1: pt, y2: Ht - pb, class: "gamebar" }, svgW);
      const gt = el("text", { x: x(e.t_still) + 4, y: pt + 10, class: "axis" }, svgW); gt.textContent = `GAME ${e.game}`;
      game = e.game; cur = { A: [[e.t_still, 0]], B: [[e.t_still, 0]] }; prev = { A: 0, B: 0 };
    }
    for (const k of ["A", "B"]) { cur[k].push([e.t_still, prev[k]], [e.t_still, e.score[k]]); }
    prev = e.score;
  }
  for (const k of ["A", "B"]) { cur[k].push([dur, prev[k]]); }
  flush();
  for (const k of ["A", "B"]) for (const s of seg[k]) el("path", { d: "M" + s.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("L"), class: "path" + k }, svgW);
  // 이벤트 점
  for (const e of evs) {
    const g = el("g", { class: "ev" + (e.flags?.length ? " flag" : ""), tabindex: 0, role: "button", "aria-label": `${fmtTime(e.t)} ${e.server} 서브` }, svgW);
    el("circle", { cx: x(e.t_still), cy: y(e.score[e.server]), r: 4.5, fill: `var(--team${e.server})` }, g);
    const ti = el("title", {}, g); ti.textContent = `${fmtTime(e.t)} · ${e.server === "A" ? setup.nameA : setup.nameB} 서브 · ${e.score.A}:${e.score.B}`;
    g.addEventListener("click", () => selectEvent(e.id, true));
  }
  el("line", { id: "wormHead", x1: pl, x2: pl, y1: pt, y2: Ht - pb, class: "head" }, svgW);
  svgW.addEventListener("click", ev => { if (ev.target.closest(".ev")) return; const rc = svgW.getBoundingClientRect(); const t = (ev.clientX - rc.left) / rc.width * Wd; seek((t - pl) / (Wd - pl - pr) * dur); });
}

function renderRPanel() {
  const P = $("#rpanel"); const r = S.result, st = r.setup, sm = r.summary;
  const all = r.events;
  const nm = t => esc(t === "A" ? st.nameA : st.nameB);
  const flagged = all.filter(e => !e.removed && e.flags?.length).length;
  const gw = t => (sm.games || []).filter(g => g.winner === t).length;
  const winner = sm.over ? (gw("A") > gw("B") ? "A" : "B") : null;
  P.innerHTML = `<h2>점수</h2>
    <div class="final">
      <div class="side A ${winner === "A" ? "win" : ""}"><div class="nm">${nm("A")}</div><div class="sc">${sm.score.A}</div><div class="gw">게임 ${gw("A")}승${(sm.games || []).map(g => ` · ${g.A}`).join("")}</div></div>
      <span class="vs">VS</span>
      <div class="side B ${winner === "B" ? "win" : ""}"><div class="nm">${nm("B")}</div><div class="sc">${sm.score.B}</div><div class="gw">게임 ${gw("B")}승${(sm.games || []).map(g => ` · ${g.B}`).join("")}</div></div>
    </div>
    ${S.step === 6 ? `
    ${sm.switch ? `<p class="desc sw-note">${sm.switch.mode === "manual" ? `코트 교대 <b>${sm.switch.times.map(fmtTime).join(", ")}</b> · 설정에서 지정` : sm.switch.mode === "auto" ? `코트 교대 <b>${fmtTime(sm.switch.times[0])}</b> · 선수 옷 색으로 자동 감지. 틀렸으면 경기 설정에서 시각을 적어 다시 분석하세요` : "코트 교대 · 점수 규칙으로 (옷 색으로는 확실하지 않았어요)"}</p>` : ""}
    <p class="desc" style="margin-bottom:10px">서브 ${all.filter(e => !e.removed).length}개${flagged ? ` · <b style="color:var(--warn)">확인 필요 ${flagged}개</b>` : ""}. 서브를 누르면 고칠 수 있어요. 하나를 고치면 뒤쪽 점수가 다시 계산돼요.</p>
    <div class="fin-fit">
      <label>실제 최종 점수 <small>알면 넣으세요. 그 점수에 맞게 서브를 다시 맞춰요</small></label>
      <div class="fin-row"><span class="nm" style="color:var(--teamA)">${nm("A")}</span><input type="number" id="finA" min="0" max="40" value="${st.final?.A ?? ""}" aria-label="${nm("A")} 최종 점수">
        <span>:</span><input type="number" id="finB" min="0" max="40" value="${st.final?.B ?? ""}" aria-label="${nm("B")} 최종 점수"><span class="nm" style="color:var(--teamB)">${nm("B")}</span>
        <button class="icon-btn sm" id="finFit">맞추기</button>${st.final ? `<button class="icon-btn sm" id="finClear">해제</button>` : ""}</div>
      ${st.final && sm.final_failed ? `<p class="desc warn-t">넣은 최종 점수에 맞는 흐름을 못 찾았어요 (서브가 너무 적거나 점수가 다른 경기 것). 최종 점수 없이 계산한 결과예요</p>` : st.final ? `<p class="desc">${all.filter(e => e.skipped).length ? `가짜로 본 서브 ${all.filter(e => e.skipped).map(e => fmtTime(e.t)).join(", ")}를 빼고 맞췄어요. 틀렸으면 그 서브를 '서브 아님'이나 팀으로 직접 고치세요` : "그대로 맞았어요"}</p>` : ""}
    </div>
    ${(() => { const n = suspects().length, c = r.summary.count || {}; return n || (c.extra ?? 0) !== 0 ? `<p class="desc rv-link">${c.extra > 0 ? `<b class="warn-t">${c.extra}개 더 셈</b> · ` : c.extra < 0 ? `<b class="warn-t">${-c.extra}개 덜 셈</b> · ` : ""}의심 서브 ${n}개 → <b>영상 아래 검토 칸</b>에서 고치세요</p>` : ""; })()}
    <div class="tabs seg" id="evFilter"><button data-f="all" class="${(S.evFilter || "all") === "all" ? "on" : ""}">전체</button><button data-f="flag" class="${S.evFilter === "flag" ? "on" : ""}">확인 필요</button></div>
    <ul class="evlist" id="evlist"></ul>
    <div class="btn-row"><button class="icon-btn sm" id="addServe">지금 시점에 서브 추가</button><button class="icon-btn sm" id="addPoint">마지막 랠리 승자 추가</button></div>
    <button class="cta" id="toSave" style="margin-top:14px">편집 끝 · 저장하러 가기</button>` : `
    <p class="desc">편집한 점수로 영상을 만들어요. 고칠 게 남았으면 <a href="#" id="toEdit">← 편집으로</a></p>
    <h3>대회 정보</h3>
    ${titleFields(st)}
    <p class="desc fname">받을 파일 이름 <b id="fnPrev">${esc(saveName(st))}.mp4</b></p>
    <h3>스코어보드</h3>
    <div class="field"><label>우리 팀</label><div class="seg" id="bOurs">${["A", "B"].map(t => `<button data-v="${t}" class="${(st.ours || "A") === t ? "on" : ""}">${nm(t)}</button>`).join("")}</div></div>
    <div class="field"><label>우리 팀 줄</label><div class="seg" id="bRow">${[["top", "윗줄"], ["bottom", "아랫줄"]].map(([v, l]) => `<button data-v="${v}" class="${(st.ours_row || "bottom") === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <p class="desc" style="margin:-4px 0 12px">바꾸면 영상 위 스코어보드에 바로 보여요. 점수 영상·공개용 영상은 다시 만들어야 반영돼요.</p>
    <h3>내보내기</h3>
    <div class="exports">
      <button class="icon-btn" id="renderBtn">${S.meta.has_overlay ? "점수 영상 다시 만들기" : "점수 영상 만들기"}</button>
      <a class="icon-btn ${S.meta.has_overlay ? "" : "hidden"}" id="dlOverlay" href="/api/videos/${S.vid}/download/overlay.mp4">점수 영상 받기</a>
      <a class="icon-btn" href="/api/videos/${S.vid}/download/events.csv">서브 기록 CSV</a>
      <a class="icon-btn" href="/api/videos/${S.vid}/download/result.json">결과 JSON</a>
      <a class="icon-btn" href="/api/videos/${S.vid}/download/players.csv">선수 추적 CSV</a>
      <a class="icon-btn" href="/api/videos/${S.vid}/download/match.json">설정 match.json</a>
    </div>
    <section class="pub">
      <h3>유튜브 공개용</h3>
      <p class="desc pub-desc">관중·심판처럼 화면에 잡힌 사람의 머리를 모자이크로 가려요. <b>공개</b>로 바꾼 선수만 얼굴이 그대로 나가요.</p>
      <div class="pub-players" id="pubPlayers"><div class="pp skel"></div><div class="pp skel"></div><div class="pp skel"></div><div class="pp skel"></div></div>
      <div class="toggle-row">스코어보드 같이 넣기<button class="switch ${S.pub.scoreboard ? "on" : ""}" id="pubBoard" role="switch" aria-checked="${S.pub.scoreboard}" aria-label="공개용 영상에 스코어보드 넣기"></button></div>
      <button class="cta" id="pubBtn">${S.meta.has_public ? "공개용 영상 다시 만들기" : "공개용 영상 만들기"}</button>
      <a class="icon-btn pub-dl ${S.meta.has_public ? "" : "hidden"}" id="dlPublic" href="/api/videos/${S.vid}/download/public.mp4">공개용 영상 받기${S.meta.public ? ` · 머리 ${S.meta.public.masked_heads.toLocaleString()}개 가림` : ""}</a>
    </section>`}`;
  $$("#evFilter button").forEach(b => b.onclick = () => { S.evFilter = b.dataset.f; renderRPanel(); });
  $("#toSave")?.addEventListener("click", () => { S.review = null; go(7); });
  $("#toEdit")?.addEventListener("click", ev => { ev.preventDefault(); go(6); });
  if (S.step === 6) renderReview(); else { const d = $("#rvDock"); if (d) d.innerHTML = ""; }
  const setFinal = async (A, B) => {
    try { S.result = await api(`/api/videos/${S.vid}/final`, { method: "PATCH", json: { A, B } }); lastStateKey = ""; renderWorm(); renderRPanel(); toast(A == null ? "최종 점수를 해제했어요" : `${A}:${B}에 맞춰 다시 계산했어요`); }
    catch (e) { toast(e.message, true); }
  };
  if ($("#finFit")) $("#finFit").onclick = () => { const a = $("#finA").value, b = $("#finB").value; if (a === "" || b === "") { toast("두 팀 점수를 모두 넣어 주세요", true); return; } setFinal(+a, +b); };
  $("#finClear")?.addEventListener("click", () => setFinal(null, null));
  if (S.step === 6) renderEvList();
  if ($("#addServe")) $("#addServe").onclick = async () => {
    const t = video.currentTime; const team = prompt(`${fmtTime(t)}에 서브한 팀은? A(${st.nameA}) 또는 B(${st.nameB})`, "A");
    if (!team) return; const T = team.trim().toUpperCase(); if (!["A", "B"].includes(T)) { toast("A 또는 B로 입력해 주세요", true); return; }
    await patch([{ action: "add_serve", t, team: T }]); toast("서브를 추가했어요");
  };
  if ($("#addPoint")) $("#addPoint").onclick = async () => {
    const team = prompt(`영상 마지막 랠리를 이긴 팀은? A(${st.nameA}) 또는 B(${st.nameB})`, "A");
    if (!team) return; const T = team.trim().toUpperCase(); if (!["A", "B"].includes(T)) { toast("A 또는 B로 입력해 주세요", true); return; }
    await patch([{ action: "add_point", t: Math.max(video.currentTime, (all.at(-1)?.t || 0) + 1), team: T }]); toast("마지막 랠리 점수를 추가했어요");
  };
  const setBoard = async upd => {
    try { S.result.setup = await api(`/api/videos/${S.vid}/board`, { method: "PATCH", json: upd }); Object.assign(S.fmt, upd); saveLocal(); renderRPanel(); lastStateKey = ""; }
    catch (e) { toast(e.message, true); }
  };
  if (S.step === 7) bindTitleFields(st, (upd, quiet) => quiet
    ? api(`/api/videos/${S.vid}/board`, { method: "PATCH", json: upd }).then(r => { Object.assign(S.result.setup, r); Object.assign(S.fmt, upd); saveLocal(); }).catch(e => toast(e.message, true))
    : setBoard(upd));
  $$("#bOurs button").forEach(b => b.onclick = () => setBoard({ ours: b.dataset.v }));
  $$("#bRow button").forEach(b => b.onclick = () => setBoard({ ours_row: b.dataset.v }));
  if (S.step !== 7) return;
  $("#renderBtn").onclick = startRender;
  $("#pubBoard").onclick = () => { S.pub.scoreboard = !S.pub.scoreboard; const b = $("#pubBoard"); b.classList.toggle("on", S.pub.scoreboard); b.setAttribute("aria-checked", S.pub.scoreboard); };
  $("#pubBtn").onclick = startPublic;
  renderPubPlayers();
  if (S.publicJob) pollPublic();
}

/* 공개용(마스킹) 영상 */
async function renderPubPlayers() {
  const box = $("#pubPlayers"); if (!box) return;
  if (!S.players) { try { S.players = await api(`/api/videos/${S.vid}/players`); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  box.innerHTML = S.players.map(p => {
    const open = S.pub.exclude.includes(p.no);
    return `<button class="pp ${p.team} ${open ? "open" : ""}" data-no="${p.no}" aria-pressed="${open}" title="${open ? "얼굴 공개 · 누르면 모자이크" : "모자이크 · 누르면 얼굴 공개"}">
      <span class="ph">${p.has_thumb ? `<img src="/api/videos/${S.vid}/players/${p.no}/thumb" alt="">` : ""}<i class="mosaic" aria-hidden="true"></i></span>
      <span class="pn"><b>선수 ${p.no}</b><small>${esc(p.name)}</small></span>
      <span class="state">${open ? "공개" : "가림"}</span></button>`;
  }).join("") + `<div class="pp-quick"><button class="icon-btn sm" data-q="A">${esc(S.result.setup.nameA)} 공개</button><button class="icon-btn sm" data-q="B">${esc(S.result.setup.nameB)} 공개</button><button class="icon-btn sm" data-q="none">모두 가림</button></div>`;
  $$(".pp[data-no]", box).forEach(b => b.onclick = () => {
    const no = +b.dataset.no; const i = S.pub.exclude.indexOf(no);
    if (i >= 0) S.pub.exclude.splice(i, 1); else S.pub.exclude.push(no);
    renderPubPlayers();
  });
  $$("[data-q]", box).forEach(b => b.onclick = () => {
    const q = b.dataset.q; S.pub.exclude = q === "none" ? [] : S.players.filter(p => p.team === q).map(p => p.no); renderPubPlayers();
  });
}
async function startPublic() {
  try {
    S.publicJob = await api(`/api/videos/${S.vid}/render`, { method: "POST", json: { mask: true, exclude: S.pub.exclude, scoreboard: S.pub.scoreboard } });
    pollPublic();
  } catch (e) { toast(e.message, true); }
}
function pollPublic() {
  const btn = $("#pubBtn"); if (!btn || !S.publicJob) return;
  btn.disabled = true;
  const tick = async () => {
    if (!S.publicJob || S.step !== 7) return;
    try {
      const j = await api(`/api/jobs/${S.publicJob.id}`);
      const b = $("#pubBtn"); if (b) b.textContent = `얼굴 가리는 중 ${Math.round(j.progress * 100)}%`;
      if (j.state === "done") {
        S.publicJob = null; S.meta = { ...S.meta, ...(await api(`/api/videos/${S.vid}`)) };
        toast(`공개용 영상을 만들었어요 · ${j.stages[0].msg}`); renderResult($("#view")); return;
      }
      if (["error", "cancelled"].includes(j.state)) { S.publicJob = null; toast("공개용 영상 만들기 실패: " + j.error, true); if (b) { b.disabled = false; b.textContent = "공개용 영상 만들기"; } return; }
    } catch (e) { S.publicJob = null; toast(e.message, true); return; }
    setTimeout(tick, 1000);
  };
  tick();
}
function renderEvList() {
  const r = S.result, st = r.setup, ul = $("#evlist"); if (!ul) return;
  const nm = t => esc(t === "A" ? st.nameA : st.nameB);
  const list = r.events.filter(e => S.evFilter !== "flag" || (e.flags?.length && !e.removed));
  if (!list.length) { ul.innerHTML = `<li class="empty-state">${S.evFilter === "flag" ? "확인이 필요한 서브가 없어요" : "찾은 서브가 없어요. 영상에서 4명이 멈춰 선 장면이 잘 안 보이면 코트·선수 지정을 다시 확인해 주세요."}</li>`; return; }
  ul.innerHTML = list.map(e => {
    const manual = e.override || e.kind === "point";
    const what = e.kind === "point" ? "랠리 승리" : "서브";
    const note = e.removed ? "삭제됨" : e.skipped ? "최종 점수에 맞추려고 뺌" : [e.box ? (e.box === "right" ? "오른쪽 코트" : "왼쪽 코트") : "", manual ? "수정함" : ""].filter(Boolean).join(" · ");
    return `<li class="ev-item ${e.id === S.selEvent ? "cur" : ""} ${e.flags?.length && !e.removed ? "flagged" : ""} ${e.removed ? "removed" : ""}" data-id="${e.id}">
      <span class="tm">${fmtTime(e.t)}</span>
      <span class="who">${e.server ? `<span class="sw" style="background:var(--team${e.server})"></span><span class="nm">${nm(e.server)} ${what}</span>` : `<span class="nm">—</span>`}<span class="note">${note}</span></span>
      <span class="sc"><span style="color:var(--teamA)">${e.score.A}</span>:<span style="color:var(--teamB)">${e.score.B}</span></span>
      ${e.conf != null && !e.removed ? `<span class="conf" title="신뢰도 ${Math.round(e.conf * 100)}%"><i style="width:${Math.round(e.conf * 100)}%;${e.conf < .75 ? "background:var(--warn)" : ""}"></i></span>` : ""}
      <div class="acts">
        ${e.flags?.length && !e.removed ? `<span class="chip warn" style="width:100%">${esc(e.flags.join(" · "))}</span>` : ""}
        ${e.removed ? `<button class="icon-btn sm" data-a="restore">되살리기</button>` : `
        <button class="icon-btn sm" data-a="A" ${e.server === "A" && manual ? "disabled" : ""}>${nm("A")} ${what}</button>
        <button class="icon-btn sm" data-a="B" ${e.server === "B" && manual ? "disabled" : ""}>${nm("B")} ${what}</button>
        ${e.override && e.kind !== "point" ? `<button class="icon-btn sm" data-a="clear">자동 판단으로</button>` : ""}
        <button class="icon-btn sm" data-a="remove">서브 아님 (삭제)</button>`}
        <button class="icon-btn sm" data-a="watch">장면 다시 보기</button>
      </div></li>`;
  }).join("");
  $$(".ev-item", ul).forEach(li => {
    li.onclick = e => { if (e.target.closest("button")) return; selectEvent(li.dataset.id, true); };
    $$("button[data-a]", li).forEach(b => b.onclick = async () => {
      const id = li.dataset.id, a = b.dataset.a; const ev = S.result.events.find(x => x.id === id);
      if (a === "watch") { seek(ev.t_still - 1.5, true); return; }
      if (a === "A" || a === "B") await patch([{ id, action: "set_server", team: a }]);
      else await patch([{ id, action: a }]);
    });
  });
}
/* ---------------- 대회 정보 (오른쪽 위 글 · 저장 파일 이름) ---------------- */
const EVENTS = ["남복", "여복", "혼복", "남단", "여단"];
function titleFields(st) {
  return `<div class="field"><label>대회명</label><input class="sw-in" id="tTour" value="${esc(st.tournament || "")}" maxlength="40" placeholder="예: 한국건강관리협회"></div>
    <div class="field"><label>종목</label><div class="seg" id="tEvent">${EVENTS.map(x => `<button data-v="${x}" class="${st.event === x ? "on" : ""}">${x}</button>`).join("")}</div></div>
    <div class="field"><label>급수 · 조</label><input class="sw-in" id="tDiv" value="${esc(st.division || "")}" maxlength="20" placeholder="예: D조"></div>
    <p class="desc">영상 오른쪽 위에 <b id="tPrev">${esc(titleText(st) || "대회명 / 종목 급수")}</b> 로 나와요 · 적는 대로 영상 위에 보여요</p>`;
}
let titleT;
// 적는 대로 영상 위에 바로 그리고, 0.7초 뒤 저장 (입력 칸은 다시 그리지 않아 커서가 안 튐)
function bindTitleFields(st, save) {
  const t = $("#tTour"), d = $("#tDiv"); if (!t) return;
  const live = () => {
    const upd = { tournament: t.value.trim(), division: d.value.trim() };
    Object.assign(st, upd);
    const tp = $("#tPrev"); if (tp) tp.textContent = titleText(st) || "대회명 / 종목 급수";
    const fp = $("#fnPrev"); if (fp) fp.textContent = saveName(st) + ".mp4";
    lastStateKey = ""; if (S.step <= 4) drawOverlay();
    clearTimeout(titleT); titleT = setTimeout(() => save(upd, true), 700);
  };
  t.oninput = live; d.oninput = live;
  [t, d].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") i.blur(); }));
  $$("#tEvent button").forEach(b => b.onclick = () => save({ event: st.event === b.dataset.v ? "" : b.dataset.v }));
}
// 받을 파일 이름 미리보기 (서버 save_name 과 같은 규칙)
function saveName(st) {
  const stem = (S.meta?.name || S.vid || "").replace(/\.[^.]+$/, "");
  const m = stem.match(/^(\d{8})[_\-\s]*(.*)$/);
  const d = new Date((S.meta?.created || Date.now() / 1000) * 1000);
  const date = m ? m[1] : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return [date, st.tournament, st.event, m ? m[2] : stem].map(x => String(x || "").trim().replace(/[\\/:*?"<>|\s]+/g, "")).filter(Boolean).join("_");
}

/* ---------------- 검토: 최종 점수와 개수 비교 · 의심 서브 · 하나씩 고치기 ---------------- */
// 의심 순서 (사람이 확인·수정한 건 빠짐)
function suspects() {
  return (S.result?.events || []).filter(e => !e.removed && e.kind !== "point" && (e.suspect || 0) > 0)
    .sort((a, b) => b.suspect - a.suspect);
}
function reviewHtml() {
  const r = S.result, c = r.summary.count || {}, nm = t => esc(t === "A" ? r.setup.nameA : r.setup.nameB);
  const sus = suspects(), extra = c.extra;
  let head;
  if (c.expected == null) head = `찾은 서브 <b>${c.found ?? "-"}</b>개 · 위에 실제 최종 점수를 넣으면 개수가 맞는지 확인하고 의심 서브를 골라 드려요`;
  else if (extra > 0) head = `최종 ${r.setup.final.A}:${r.setup.final.B} → 랠리 <b>${c.expected}</b>개인데 서브 <b>${c.found}</b>개 · <b class="warn-t">${extra}개 더 셈</b>. 아래 의심 순서대로 보고 가짜는 '서브 아님'`;
  else if (extra < 0) head = `최종 ${r.setup.final.A}:${r.setup.final.B} → 랠리 <b>${c.expected}</b>개인데 서브 <b>${c.found}</b>개 · <b class="warn-t">${-extra}개 덜 셈</b>. 아래 빈 구간에서 빠진 서브를 찾아 '지금 시점에 서브 추가'`;
  else head = `최종 ${r.setup.final.A}:${r.setup.final.B} → 랠리 ${c.expected}개 = 서브 ${c.found}개 · 개수 맞음${sus.length ? ". 서브 팀이 의심스러운 것만 확인해 보세요" : ""}`;
  const show = sus.slice(0, Math.max(5, (extra > 0 ? extra : 0) + 3));
  const list = show.map((e, k) => `<li data-id="${e.id}"><span class="rk">${k + 1}</span><span class="tm">${fmtTime(e.t)}</span>
      <span class="wy">${e.skipped ? '<b class="warn-t">뺀 서브</b> · ' : e.server ? `${nm(e.server)} 서브 · ` : ""}${esc((e.why || []).join(" · "))}</span><span class="sv">${e.suspect.toFixed(1)}</span></li>`).join("");
  const gaps = extra != null && extra < 0 && c.gaps?.length ? `<p class="desc">서브가 빠졌을 만한 긴 빈 구간: ${c.gaps.map(([a, b]) => `<a href="#" class="gap" data-t="${a}">${fmtTime(a)}~${fmtTime(b)}</a>`).join(" · ")}</p>` : "";
  if (S.review) return reviewCard();
  return `<div class="review">
    <div class="rv-title">검토 · 수동 수정</div>
    <p class="rv-head">${head}</p>
    ${show.length ? `<ol class="sus">${list}</ol><button class="cta sm" id="rvStart">검토 시작 · 의심 순서대로 ${show.length}개 보기</button>` : ""}
    ${gaps}</div>`;
}
function reviewCard() {
  const rv = S.review, r = S.result, e = r.events.find(x => x.id === rv.ids[rv.i]);
  const nm = t => esc(t === "A" ? r.setup.nameA : r.setup.nameB);
  if (!e) return `<div class="review on"><p class="rv-head">검토할 서브가 없어요</p><button class="icon-btn sm" id="rvEnd">검토 끝내기</button></div>`;
  const st = e.removed ? "서브 아님으로 바꿈" : e.confirmed ? "맞음으로 확인함" : e.override ? `${nm(e.override)} 서브로 고침` : e.skipped ? "지금은 뺀 상태" : `지금 판정: ${nm(e.server)} 서브`;
  return `<div class="review on">
    <div class="rv-title">검토 중 · 장면 앞뒤 3초 반복</div>
    <div class="rv-top"><span class="ix">${rv.i + 1} / ${rv.ids.length}</span><b>${fmtTime(e.t)}</b><span class="st">${st}</span></div>
    <p class="desc">${esc((e.why || []).join(" · ")) || "의심 이유 없음"}</p>
    <div class="rv-btns">
      <button class="icon-btn" data-r="remove">서브 아님 <kbd>X</kbd></button>
      <button class="icon-btn" data-r="confirm">맞음 <kbd>Enter</kbd></button>
      <button class="icon-btn" data-r="A" style="border-color:var(--teamA)">${nm("A")} 서브 <kbd>A</kbd></button>
      <button class="icon-btn" data-r="B" style="border-color:var(--teamB)">${nm("B")} 서브 <kbd>B</kbd></button>
    </div>
    <div class="rv-nav"><button class="icon-btn sm" data-r="prev">이전</button><button class="icon-btn sm" data-r="next">다음 <kbd>N</kbd></button><button class="icon-btn sm" id="rvEnd">검토 끝내기</button></div>
  </div>`;
}
function reviewGo(i) {
  const rv = S.review; if (!rv) return;
  rv.i = Math.max(0, Math.min(rv.ids.length - 1, i));
  const e = S.result.events.find(x => x.id === rv.ids[rv.i]);
  if (e) { rv.t = e.t; seek(e.t - 3, true); selectEvent(e.id, false); }
  renderRPanel();
}
async function reviewAct(a) {
  const rv = S.review; if (!rv) return;
  const id = rv.ids[rv.i];
  if (a === "next") return reviewGo(rv.i + 1);
  if (a === "prev") return reviewGo(rv.i - 1);
  if (a === "A" || a === "B") await patch([{ id, action: "restore" }, { id, action: "set_server", team: a }, { id, action: "confirm" }]);
  else if (a === "confirm") await patch([{ id, action: "confirm" }]);
  else if (a === "remove") await patch([{ id, action: "remove" }]);
  if (rv.i + 1 < rv.ids.length) reviewGo(rv.i + 1);
  else { toast("검토를 마쳤어요. 개수와 점수를 확인하세요"); S.review = null; renderRPanel(); }
}
function renderReview() {
  const d = $("#rvDock"); if (!d || !S.result) return;
  d.innerHTML = reviewHtml(); bindReview();
}
function bindReview() {
  $("#rvStart")?.addEventListener("click", () => { S.review = { ids: suspects().slice(0, Math.max(5, (S.result.summary.count?.extra > 0 ? S.result.summary.count.extra : 0) + 3)).map(e => e.id), i: 0 }; reviewGo(0); });
  $("#rvEnd")?.addEventListener("click", () => { S.review = null; renderRPanel(); });
  $$(".review [data-r]").forEach(b => b.onclick = () => reviewAct(b.dataset.r));
  $$(".sus li").forEach(li => li.onclick = () => { const ids = $$(".sus li").map(x => x.dataset.id); S.review = { ids, i: ids.indexOf(li.dataset.id) }; reviewGo(S.review.i); });
  $$(".review .gap").forEach(a => a.onclick = ev => { ev.preventDefault(); seek(+a.dataset.t, true); });
}

async function patch(body) {
  try {
    S.result = await api(`/api/videos/${S.vid}/events`, { method: "PATCH", json: body });
    lastStateKey = null; renderWorm(); renderRPanel();
  } catch (e) { toast(e.message, true); }
}
function selectEvent(id, doSeek) {
  S.selEvent = id; const e = S.result.events.find(x => x.id === id);
  $$(".ev-item").forEach(li => li.classList.toggle("cur", li.dataset.id === id));
  $(`.ev-item[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  if (doSeek && e) seek(e.t_still - 1.0);
}
function markCurrent(id) {
  if (!id || id === S._curEv) return; S._curEv = id;
  $$(".ev-item").forEach(li => li.style.outline = li.dataset.id === id ? "2px solid color-mix(in srgb,var(--accent) 60%,transparent)" : "");
}

/* 점수 합성 영상 */
async function startRender() {
  try { S.renderJob = await api(`/api/videos/${S.vid}/render`, { method: "POST" }); pollRender(); }
  catch (e) { toast(e.message, true); }
}
function pollRender() {
  const btn = $("#renderBtn"); if (!btn || !S.renderJob) return;
  btn.disabled = true;
  const tick = async () => {
    if (!S.renderJob || S.step !== 7) return;
    try {
      const j = await api(`/api/jobs/${S.renderJob.id}`);
      const b = $("#renderBtn"); if (b) b.textContent = `점수 영상 만드는 중 ${Math.round(j.progress * 100)}%`;
      if (j.state === "done") { S.renderJob = null; S.meta.has_overlay = true; toast("점수 영상을 만들었어요"); renderResult($("#view")); return; }
      if (["error", "cancelled"].includes(j.state)) { S.renderJob = null; toast("점수 영상 만들기 실패: " + j.error, true); if (b) { b.disabled = false; b.textContent = "점수 영상 만들기"; } return; }
    } catch (e) { S.renderJob = null; toast(e.message, true); return; }
    setTimeout(tick, 1000);
  };
  tick();
}

/* ---------------- 키보드 ---------------- */
document.addEventListener("keydown", e => {
  if (e.target.matches("input:not([type=range]), textarea") || e.target.closest(".handle")) return;
  if (S.step === 6 && S.review) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const a = { x: "remove", ㅌ: "remove", Enter: "confirm", a: "A", ㅁ: "A", b: "B", ㅠ: "B", n: "next", ㅜ: "next" }[k];
    if (a) { e.preventDefault(); reviewAct(a); return; }
    if (e.key === "Escape") { S.review = null; renderRPanel(); return; }
  }
  if (S.step === 2) {
    if (e.key === "Escape" && (S.pick || S.sel)) {
      if (S.guide != null && S.pick?.kind === "l") { skipGuide(); return; }   // 안내 중 라인: Esc = 이 라인 끝내고 다음
      S.guide = null; S.pick = null; S.sel = null; $("#loupe")?.classList.add("hidden"); drawOverlay(); renderPanel(); return; }
    const ref = selRef();
    if (ref && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); delSel(); return; }
    const d = e.shiftKey ? 10 : 1, k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
    if (ref && k && e.target.type !== "range") { e.preventDefault(); ref[0] += k[0]; ref[1] += k[1]; showLoupe(ref); drawOverlay(); refit(); return; }
  }
  if (S.step >= 1 && S.step <= 3 && $("#frameRange")) {
    const d = e.shiftKey ? Math.round(S.meta.fps) : 1;
    if (e.key === "ArrowLeft") { e.preventDefault(); loadFrame(S.frame - d); frameChanged(); }
    if (e.key === "ArrowRight") { e.preventDefault(); loadFrame(S.frame + d); frameChanged(); }
  }
  if (S.step >= 6 && video) {
    if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    if (e.key === "ArrowLeft" && e.target !== video) { e.preventDefault(); seek(video.currentTime - 2); }
    if (e.key === "ArrowRight" && e.target !== video) { e.preventDefault(); seek(video.currentTime + 2); }
    if (e.key === "[" || e.key === "]") {
      const evs = activeEvents(), t = video.currentTime;
      const target = e.key === "]" ? evs.find(x => x.t_still - 1.0 > t + .3) : [...evs].reverse().find(x => x.t_still - 1.0 < t - .3);
      if (target) selectEvent(target.id, true);
    }
  }
});
window.addEventListener("resize", () => { if (S.step >= 6 && S.result) renderWorm(); });

/* ---------------- 시작 ---------------- */
checkHealth();
const mh = decodeURIComponent(location.hash).match(/^#\/v\/([A-Za-z0-9가-힣_-]+)(?:\/(\d))?/);
if (mh) openVideo(mh[1], mh[2] != null ? +mh[2] : undefined); else go(0);

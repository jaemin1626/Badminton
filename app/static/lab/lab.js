/* Smash Lab — 추적과 서브 판정을 눈으로 확인하는 실험 페이지 */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = "http://www.w3.org/2000/svg";
const W_M = 6.10, L_M = 13.40, NET = 6.70, SHORT = 1.98, LONG_DBL = 0.76;
const SLOT_COL = { far0: "var(--far0)", far1: "var(--far1)", near0: "var(--near0)", near1: "var(--near1)" };
const SLOT_HEX = { far0: "#5aa9ff", far1: "#a38cff", near0: "#ff7a59", near1: "#ffc24a" };
const STAGE_COL = { OK: "#3ecf8e", B: "#ff5d6c", C: "#ffa63d", A: "#7d8a84" };
const STAGE_NAME = { OK: "서브", A: "A 정지", B: "B 대형", C: "C 랠리" };
const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
const PARAM_DOC = {
  still_speed: ["정지 속도 (m/s)", "모든 선수가 이보다 느리면 정지"],
  still_min: ["정지 최소 시간 (s)", "정지가 이만큼 이어져야 서브 후보"],
  merge_gap: ["끊김 이어붙이기 (s)", "이보다 짧게 끊긴 정지는 하나로"],
  smooth: ["위치 평활 창 (s)", "발 위치 떨림을 줄이는 이동평균"],
  rally_speed: ["랠리 속도 (m/s)", "누군가 이보다 빠르면 랠리"],
  rally_window: ["랠리 시작 제한 (s)", "정지가 끝나고 이 안에 랠리가 시작돼야 서브"],
  min_serve_gap: ["서브 최소 간격 (s)", "이보다 가까우면 랠리 중 멈춤으로 봄"],
  box_front: ["서비스 코트 앞 여유 (m)", "숏 서비스 라인보다 네트 쪽 허용"],
  box_back: ["서비스 코트 뒤 여유 (m)", "롱 서비스 라인보다 뒤쪽 허용"],
  require_diagonal: ["대각선 규칙 (0 끔 · 1 켬)", "켜면 서버·리시버가 대각선이어야 서브"],
  rear_drop: ["겹친 뒷사람 빼기 (0 끔 · 1 켬)", "팀원 뒤에 겹쳐 선 사람의 튀는 발 위치를 정지 판단에서 빼고 보간"],
  rally_min: ["랠리 최소 길이 (초)", "두 정지 사이 빠른 움직임이 이보다 짧으면 자리 잡기로 봄"],
  rescue_gap: ["다시 찾기 빈 구간 (s)", "서브 사이가 이보다 길게 비면 그 안에서 4명 중 1명 흔들림을 허용해 예비 서브를 찾음 (0이면 끔)"],
  still_allow: ["정지 때 흔들려도 되는 사람 수", "기본 0. 다시 찾기 단계에서만 1로 씀"],
  front_amb: ["앞사람 애매 기준 (m)", "한쪽 두 명의 네트 거리 차이가 이보다 작으면 반대쪽 앞사람과 대각선인 사람을 앞사람(서버/리시버)으로 (0이면 끔)"],
  still_occ: ["가려진 선수 빼고 정지 (실험)", "1이면 가려진 선수와 다시 나타난 직후는 정지 판단에서 뺌 (지금은 다른 영상이 나빠져 끔)"],
  still_px: ["화면 기준 정지 (실험)", "1이면 정지 판단에 화면 속 움직임(키 대비)도 써서 먼 쪽 흔들림 무시 (지금은 다른 영상이 나빠져 끔)"],
  short_still: ["잠깐 멈춤 (s)", "가까운 두 정지 중 앞이 이보다 짧고 뒤가 2배 넘게 길면 뒤쪽을 서브로"],
  facing_max: ["마주 봄 한계", "가까운 쪽 두 명이 둘 다 이만큼 넘게 서로를 보면 쉬는 중 (1이면 끔)"],
  w_xc: ["서버 쪽: 센터라인", "앞사람이 센터라인에 붙어 선 쪽이 서브 (서버는 센터라인 가까이)"],
  w_pdx: ["서버 쪽: 팀원 일직선", "팀원이 앞사람 바로 뒤 일직선에 선 쪽이 서브"],
  w_dnet: ["서버 쪽: 네트 거리", "앞사람이 네트에 더 가까이 선 쪽이 서브"],
  w_form: ["서버 쪽: 대형", "서버 바로 뒤에 팀원이 선(가려짐 포함) 쪽 단서의 비중"],
  w_pose: ["서버 쪽: 자세", "서브 자세 단서의 비중 (바로 뒤 영상에서 안 맞아 0)"],
  w_onset: ["서버 쪽: 먼저 움직임", "정지가 끝날 때 손목을 먼저 움직인 쪽 단서의 비중 (거의 운이라 0)"],
  serve_lag: ["서브 시각 당김 (s)", "서브 시각 = 정지가 끝난 때 − 이 값"],
};

const S = {
  vid: null, info: null, meta: null, mode: "setup",
  // 설정
  frame: 0, points: [], clines: [], inner: false, pick: null, sel: null, fit: null, wide: false, lines: true, drag: null, people: [], assign: {}, role: "A", detFrame: -1,
  // 확인
  tr: null, kps: null, kshape: null, sv: null, params: null, defaults: null, cur: 0, filter: "all", selRun: null,
  view: { t0: 0, span: 40 }, jobTimer: null, truth: [],
};

/* ---------------- 공통 ---------------- */
async function api(url, opt = {}) {
  const o = { method: opt.method || "GET", headers: {} };
  if (opt.json !== undefined) { o.body = JSON.stringify(opt.json); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, o);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); }
  return opt.raw ? r : r.json();
}
let toastT;
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 2600);
}
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e); return e;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const [X, Y] = src[i], [x, y] = dst[i]; A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.push(x); A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.push(y); }
  return [...solve(A, b), 1];
}
const COURT = [[0, 0], [W_M, 0], [W_M, L_M], [0, L_M]];
// 카메라 뒤쪽(d<=0)으로 넘어가는 점은 null
const map = (H, [X, Y]) => { const d = H[6] * X + H[7] * Y + H[8]; if (d <= 1e-9) return null; return [(H[0] * X + H[1] * Y + H[2]) / d, (H[3] * X + H[4] * Y + H[5]) / d]; };
// 고를 수 있는 코트 점: 라인 교차점 + 네트 기둥 바닥. 왼쪽/오른쪽은 카메라에서 볼 때
const XS = [[0, "왼쪽 복식"], [0.46, "왼쪽 단식"], [W_M / 2, "센터"], [W_M - 0.46, "오른쪽 단식"], [W_M, "오른쪽 복식"]];
const YS = [[0, "먼 쪽 엔드"], [LONG_DBL, "먼 쪽 롱서비스"], [NET - SHORT, "먼 쪽 숏서비스"], [NET + SHORT, "가까운 쪽 숏서비스"], [L_M - LONG_DBL, "가까운 쪽 롱서비스"], [L_M, "가까운 쪽 엔드"]];
const CATALOG = [];
for (const [y, yn] of YS) for (const [x, xn] of XS) CATALOG.push({ c: [x, y], name: `${yn} × ${xn}` });
CATALOG.push({ c: [0, NET], name: "왼쪽 네트 기둥 바닥" }, { c: [W_M, NET], name: "오른쪽 네트 기둥 바닥" });
// 기본 도면에는 바깥 사각형(꼭짓점 4개)과 네트 기둥만 보인다
for (const p of CATALOG) p.outer = (p.c[0] === 0 || p.c[0] === W_M) && (p.c[1] === 0 || p.c[1] === L_M || p.c[1] === NET);
const sameC = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const cName = c => CATALOG.find(p => sameC(p.c, c))?.name || `(${c[0]}, ${c[1]})`;
function courtLines() {
  const s = 0.46, ss = SHORT, ls = LONG_DBL;
  return [[[0, 0], [W_M, 0]], [[0, L_M], [W_M, L_M]], [[0, 0], [0, L_M]], [[W_M, 0], [W_M, L_M]], [[s, 0], [s, L_M]], [[W_M - s, 0], [W_M - s, L_M]],
  [[0, NET - ss], [W_M, NET - ss]], [[0, NET + ss], [W_M, NET + ss]], [[0, ls], [W_M, ls]], [[0, L_M - ls], [W_M, L_M - ls]],
  [[W_M / 2, 0], [W_M / 2, NET - ss]], [[W_M / 2, NET + ss], [W_M / 2, L_M]]];
}
// 긴 선을 잘게 나눠 그린다 (화면 밖 꼭짓점 때문에 원근이 크게 걸려도 모양 유지)
function drawCourtLines(g, H, cls, sw) {
  for (const [a, b] of courtLines()) {
    let seg = [];
    const flush = () => { if (seg.length > 1) el("polyline", { points: seg.map(p => p.join(",")).join(" "), class: cls, "stroke-width": sw }, g); seg = []; };
    for (let i = 0; i <= 40; i++) {
      const s = i / 40, q = map(H, [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      if (!q || Math.abs(q[0]) > 2e4 || Math.abs(q[1]) > 2e4) flush(); else seg.push(q);
    }
    flush();
  }
  const n1 = map(H, [0, NET]), n2 = map(H, [W_M, NET]);
  if (n1 && n2) el("line", { x1: n1[0], y1: n1[1], x2: n2[0], y2: n2[1], class: "net", "stroke-width": sw * 1.4 }, g);
}
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9);
}

/* ---------------- 시작 ---------------- */
async function boot() {
  const list = await api("/api/videos");
  const sel = $("#vidSel");
  sel.innerHTML = list.map(m => `<option value="${m.id}">${m.name} · ${fmt(m.duration || 0)}</option>`).join("") || `<option value="">영상 없음 · 운영 화면에서 올려 주세요</option>`;
  const [hashMain, hashAt] = decodeURIComponent(location.hash.slice(1)).split("@");
  const fromHash = hashMain.split("/");
  const vid = list.find(m => m.id === fromHash[0])?.id || list[0]?.id;
  sel.onchange = () => openVideo(sel.value);
  $$(".tabs button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $("#upFile").onchange = e => upload(e.target.files[0]);
  bindSetup(); bindView(); bindTruth();
  if (vid) {
    sel.value = vid; await openVideo(vid, fromHash[1]);
    if (hashAt && !isNaN(+hashAt) && S.mode !== "setup") { const v = $("#vid"), go = () => { seek(+hashAt); S.view.t0 = Math.max(0, +hashAt - 8); }; v.readyState >= 1 ? go() : v.addEventListener("loadedmetadata", go, { once: true }); }
  }
}

function upload(f) {
  if (!f) return;
  const xhr = new XMLHttpRequest(), box = $("#jobBox");
  xhr.open("POST", "/api/videos");
  xhr.upload.onprogress = e => { if (e.lengthComputable) box.innerHTML = `올리는 중<span class="bar"><i style="width:${Math.round(e.loaded / e.total * 100)}%"></i></span>${Math.round(e.loaded / 1048576)} / ${Math.round(e.total / 1048576)} MB`; };
  xhr.onload = async () => {
    let j = {}; try { j = JSON.parse(xhr.responseText); } catch { }
    if (xhr.status >= 300) { toast(j.detail || "업로드 실패", true); box.textContent = ""; return; }
    box.textContent = "올렸어요 · 브라우저용 영상은 뒤에서 변환 중";
    const list = await api("/api/videos");
    $("#vidSel").innerHTML = list.map(m => `<option value="${m.id}">${m.name} · ${fmt(m.duration || 0)}</option>`).join("");
    $("#vidSel").value = j.id; openVideo(j.id, "setup");
  };
  xhr.onerror = () => toast("네트워크 오류로 올리지 못했어요", true);
  const fd = new FormData(); fd.append("file", f); xhr.send(fd);
}

async function openVideo(vid, mode) {
  stopVideo();
  S.vid = vid; S.tr = null; S.kps = null; S.sv = null; S.selRun = null; S.baseSig = null; S.truth = []; S.truthLoaded = false; S.tsel = -1;
  S.info = await api(`/api/lab/${vid}`); S.meta = S.info.meta;
  S.defaults = { ...S.info.params };
  const saved = JSON.parse(localStorage.getItem("lab:params") || "null");
  S.params = { ...S.defaults, ...(saved || {}) };
  const c = S.info.config, W = S.meta.width, H = S.meta.height;
  S.points = c?.points ? c.points.map(p => ({ court: [...p.court], px: [...p.px] }))
    : c?.court_corners_px ? c.court_corners_px.map((p, i) => ({ court: [...COURT[i]], px: [...p] })) : [];
  S.clines = (c?.lines || []).map(l => ({ line: l.line.map(p => [...p]), px: l.px.map(p => [...p]) }));
  S.pick = null; S.sel = null; S.fit = null;
  S.wide = wideNeeded();
  S.frame = c?.ref_frame ?? Math.round(S.meta.frames * .1);
  // 저장된 박스를 '지정됨' 상태로 보여 준다 (다시 검출하면 겹치는 박스로 이어 붙음)
  S.people = []; S.assign = {}; S.detFrame = c ? c.ref_frame : -1;
  if (c) {
    let id = 1;
    for (const [num, t] of [["1", "A"], ["2", "B"]]) for (const b of c.teams[num].bboxes) { S.people.push({ id, box: b, saved: true }); S.assign[id++] = t; }
    for (const o of c.officials || []) { S.people.push({ id, box: o.bbox, saved: true }); S.assign[id++] = "R"; }
    $("#nameA").value = c.teams["1"].name; $("#nameB").value = c.teams["2"].name;
    const m = c.match || {};
    $("#mMode").value = m.mode || "doubles"; $("#mTarget").value = +m.target === 21 && +m.games_to_win === 1 ? "21-1" : (m.target || 25); $("#mFirst").value = m.first || "A";
    $("#mGame").value = m.game || 1; $("#mScoreA").value = m.scoreA || 0; $("#mScoreB").value = m.scoreB || 0;
    $("#mSwitch").value = switchStr(m.switch_manual);
    $("#mStart").value = m.start_t != null ? switchStr([m.start_t]) : "";
    $("#mFinal").value = m.final ? `${m.final.A}:${m.final.B}` : "";
  }
  $("#sRange").max = S.meta.frames - 1;
  $$("#wideSeg button").forEach(b => b.classList.toggle("on", +b.dataset.v === +S.wide));
  $("#tabView").disabled = $("#tabTruth").disabled = !S.info.has_tracks;
  $("#tabTruth").title = S.info.has_tracks ? "실제 서브 시각과 서브 팀(정답)을 기록해요" : "추적을 먼저 실행하면 열려요 (서브 후보·타임라인을 같이 써요)";
  watchJob(S.info.job);
  setMode(["view", "truth"].includes(mode) && S.info.has_tracks ? mode : (S.info.has_tracks && !mode ? "view" : "setup"));
  clearTimeout(draftT); S.baseSig = stateSig();   // 서버 설정 상태를 기준으로
  if (applyDraft(c)) { toast("저장하지 않은 작업을 이어서 불러왔어요. 저장 버튼을 눌러야 설정 파일에 들어가요"); if (S.mode === "setup") { buildStage(); loadFrame(S.frame); renderSetupPanel(); refit(true); } }
  else if (S.info.seeded) toast("운영 화면 설정을 시작점으로 불러왔어요. 저장해야 실험용으로 쓰여요");
  renderPresets();
  if (S.info.same_name) askSameName(S.info.same_name);
}
function askSameName(p) {
  const when = p.saved ? new Date(p.saved * 1000).toLocaleString("ko-KR") : "";
  $("#askBody").innerHTML = `<b>data/configs/${p.name}.json</b><br>${when}${p.video ? ` · ${p.video}에서 저장` : ""}<br>
    코트 점 ${p.points}개 · 라인 ${p.lines}개 · 심판 ${p.officials}명 · 기준 프레임 #${p.ref_frame}<br><br>이 설정을 사용하시겠습니까?`;
  const dlg = $("#askDlg");
  $("#askYes").onclick = async () => {
    dlg.close();
    try {
      await api(`/api/lab/${S.vid}/presets/${encodeURIComponent(p.name)}/load`, { method: "POST" });
      localStorage.removeItem(draftKey()); toast(`'${p.name}' 설정을 불러왔어요`);
      await openVideo(S.vid, "setup");
    } catch (e) { toast(e.message, true); }
  };
  $("#askNo").onclick = () => dlg.close();
  dlg.showModal();
}

function setMode(m) {
  if (m !== "setup" && $("#tabView").disabled) return;
  S.mode = m;
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#setup").classList.toggle("hidden", m !== "setup");
  $("#view").classList.toggle("hidden", m === "setup");
  $("#view").classList.toggle("truth", m === "truth");   // 정답 탭: 같은 영상·타임라인 + 오른쪽에 정답 패널
  history.replaceState(null, "", `#${S.vid}/${m}`);
  if (m === "setup") { stopVideo(); buildStage(); loadFrame(S.frame); renderSetupPanel(); refit(true); }
  else enterView();
}

/* =========================================================
   1. 설정
   ========================================================= */
// 화면 밖 여백 단계: 0 끔 · 1 조금 · 2 넓게 · 3 아주 넓게 (영상 너비·높이 대비 한쪽 여백)
const WIDE = [[0, 0], [.25, .45], [.5, 1.0], [1.0, 2.0]];
function pad() { const [fx, fy] = WIDE[+S.wide || 0] || WIDE[0]; return { x: Math.round(S.meta.width * fx), y: Math.round(S.meta.height * fy) }; }
// 찍어 둔 점·라인이 모두 들어가는 가장 작은 단계
function wideNeeded() {
  const W = S.meta.width, H = S.meta.height;
  const pts = [...S.points.map(p => p.px), ...S.clines.flatMap(l => l.px)];
  for (let lv = 0; lv < WIDE.length; lv++) {
    const [fx, fy] = WIDE[lv];
    if (pts.every(([x, y]) => x >= -W * fx && x <= W * (1 + fx) && y >= -H * fy && y <= H * (1 + fy))) return lv;
  }
  return WIDE.length - 1;
}
const U = () => S.meta.width / 1600;
function buildStage() {
  const W = S.meta.width, H = S.meta.height, p = pad(), svg = $("#sSvg");
  svg.setAttribute("viewBox", `${-p.x} ${-p.y} ${W + 2 * p.x} ${H + 2 * p.y}`);
  const img = $("#sImg"); img.setAttribute("width", W); img.setAttribute("height", H); img.setAttribute("x", 0); img.setAttribute("y", 0);
  $$(".offframe,.frame-edge", svg).forEach(e => e.remove());
  if (p.x) {
    const bg = el("rect", { class: "offframe", x: -p.x, y: -p.y, width: W + 2 * p.x, height: H + 2 * p.y });
    svg.insertBefore(bg, svg.firstChild);
    el("rect", { class: "frame-edge", x: 0, y: 0, width: W, height: H, "stroke-width": 3 * U() }, svg);
  }
  drawSetup();
}
function loadFrame(f) {
  S.frame = clamp(Math.round(f), 0, S.meta.frames - 1);
  $("#sRange").value = S.frame; $("#sNum").textContent = `#${S.frame} · ${fmt(S.frame / S.meta.fps)}`;
  const url = `/api/videos/${S.vid}/frames/${S.frame}`, pre = new Image();
  $("#sStage").classList.add("busy");
  pre.onload = () => { $("#sImg").setAttribute("href", url); $("#sStage").classList.remove("busy"); };
  pre.onerror = () => $("#sStage").classList.remove("busy");
  pre.src = url;
  drawSetup();
}
function svgPoint(svg, e) { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }

/* ---- 코트 지정: 교차점(점)과 라인(끝이 잘려도 보이는 곳 아무 데나) ---- */
const LINE_CATALOG = [
  { l: [[0, 0], [0, L_M]], name: "왼쪽 복식 사이드라인" }, { l: [[0.46, 0], [0.46, L_M]], name: "왼쪽 단식 사이드라인" },
  { l: [[W_M - 0.46, 0], [W_M - 0.46, L_M]], name: "오른쪽 단식 사이드라인" }, { l: [[W_M, 0], [W_M, L_M]], name: "오른쪽 복식 사이드라인" },
  { l: [[0, 0], [W_M, 0]], name: "먼 쪽 엔드라인" }, { l: [[0, LONG_DBL], [W_M, LONG_DBL]], name: "먼 쪽 롱서비스 라인" },
  { l: [[0, NET - SHORT], [W_M, NET - SHORT]], name: "먼 쪽 숏서비스 라인" }, { l: [[0, NET + SHORT], [W_M, NET + SHORT]], name: "가까운 쪽 숏서비스 라인" },
  { l: [[0, L_M - LONG_DBL], [W_M, L_M - LONG_DBL]], name: "가까운 쪽 롱서비스 라인" }, { l: [[0, L_M], [W_M, L_M]], name: "가까운 쪽 엔드라인" },
  { l: [[W_M / 2, 0], [W_M / 2, NET - SHORT]], name: "먼 쪽 센터라인" }, { l: [[W_M / 2, NET + SHORT], [W_M / 2, L_M]], name: "가까운 쪽 센터라인" },
];
for (const c of LINE_CATALOG) { const [[x1, y1], [x2, y2]] = c.l; c.outer = (x1 === x2 && (x1 === 0 || x1 === W_M)) || (y1 === y2 && (y1 === 0 || y1 === L_M)); }
const sameL = (a, b) => sameC(a[0], b[0]) && sameC(a[1], b[1]);
const lName = l => LINE_CATALOG.find(c => sameL(c.l, l))?.name || "라인";
const eqCount = () => 2 * S.points.length + 2 * S.clines.filter(l => l.px.length >= 2).length;
const rpx = p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];

function curH() { return S.fit && !S.fit.error ? S.fit.H : null; }
let fitSeq = 0, fitTimer;
function refit(now = false) {
  clearTimeout(fitTimer);
  const go = async () => {
    const seq = ++fitSeq;
    if (eqCount() < 8) { S.fit = null; drawSetup(); renderPoints(); return; }
    try {
      const r = await api("/api/lab/fit-court", { method: "POST", json: { points: S.points, lines: S.clines.filter(l => l.px.length >= 2) } });
      if (seq !== fitSeq) return;
      S.fit = { ...r, H: r.h_court2px.flat() };
    } catch (e) { if (seq !== fitSeq) return; S.fit = { error: e.message }; }
    drawSetup(); renderPoints();
  };
  if (now) go(); else fitTimer = setTimeout(go, 60);
}

function drawSetup() {
  saveDraft();
  const g = $("#sOver"); g.innerHTML = ""; const u = U();
  $("#sStage").classList.toggle("picking", S.pick !== null);
  const H = curH();
  if (H && S.lines) drawCourtLines(g, H, "cl", 2 * u);
  // 사람 박스 (설정 프레임에서 찾은 것만 클릭 가능)
  const here = S.detFrame === S.frame;
  for (const p of S.people) {
    const r = S.assign[p.id];
    if (!here && !r) continue;
    const [x1, y1, x2, y2] = p.box;
    const b = el("g", { class: `pb ${r || ""} ${p.in_play === false ? "out" : ""}` }, g);
    el("rect", { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 6 * u, "stroke-width": (r ? 4 : 2) * u, opacity: here ? 1 : .55 }, b);
    const label = r ? ({ A: $("#nameA").value || "팀 A", B: $("#nameB").value || "팀 B", R: "심판" })[r] : `#${p.id}`;
    const tx = el("text", { x: x1, y: y1 - 8 * u, "font-size": 20 * u }, b); tx.textContent = label;
    if (here) b.addEventListener("click", e => { if (S.pick === null) { e.stopPropagation(); togglePerson(p); } });
  }
  // 라인: 찍은 점(하늘색 네모)과 계산된 라인
  S.clines.forEach((ln, li) => {
    const on = (S.pick?.kind === "l" && sameL(LINE_CATALOG[S.pick.i].l, ln.line)) || (S.sel?.kind === "l" && S.sel.i === li);
    if (H) {
      const lg = el("g", {}, g);
      drawCourtLinesOne(lg, H, ln.line, on ? "#4fe3ff" : "#4fe3ff99", (on ? 4 : 2.5) * u);
    }
    ln.px.forEach((q, j) => {
      const m = el("g", { class: "lpm" + (S.sel?.kind === "l" && S.sel.i === li && S.sel.j === j ? " sel" : "") }, g);
      el("rect", { x: q[0] - 7 * u, y: q[1] - 7 * u, width: 14 * u, height: 14 * u, "stroke-width": 3 * u, style: "cursor:grab" }, m);
      m.addEventListener("pointerdown", e => { e.stopPropagation(); S.drag = { kind: "l", i: li, j }; S.sel = { kind: "l", i: li, j }; $("#sSvg").setPointerCapture(e.pointerId); drawSetup(); renderPoints(); });
    });
    const q = ln.px[ln.px.length - 1];
    if (q) { const t = el("text", { x: q[0] + 12 * u, y: q[1] + 22 * u, "font-size": 18 * u, class: "lbl-l" }, g); const e = S.fit?.line_errors?.[S.clines.filter(l => l.px.length >= 2).indexOf(ln)]; t.textContent = `L${li + 1}${e != null ? ` · ${e.toFixed(1)}px` : ln.px.length < 2 ? " · 점 1개 더" : ""}`; }
  });
  // 교차점: 찍은 위치(분홍)와 계산된 위치를 선으로 이어 오차를 보여 준다
  S.points.forEach((p, i) => {
    const m = el("g", { class: "ptm" + (S.sel?.kind === "p" && S.sel.i === i ? " sel" : "") }, g);
    const q = H && map(H, p.court);
    if (q) el("line", { x1: p.px[0], y1: p.px[1], x2: q[0], y2: q[1], "stroke-width": 2 * u }, m);
    el("circle", { cx: p.px[0], cy: p.px[1], r: 9 * u, "stroke-width": 3 * u, style: "cursor:grab" }, m);
    const t = el("text", { x: p.px[0] + 12 * u, y: p.px[1] - 10 * u, "font-size": 18 * u }, m);
    const e = S.fit?.errors?.[i];
    t.textContent = `${i + 1}${e != null ? ` · ${e.toFixed(1)}px` : ""}`;
    m.addEventListener("pointerdown", e => { e.stopPropagation(); S.drag = { kind: "p", i }; S.sel = { kind: "p", i }; $("#sSvg").setPointerCapture(e.pointerId); drawSetup(); renderPoints(); });
  });
}
function drawCourtLinesOne(g, H, [a, b], col, sw) {
  let seg = [];
  const flush = () => { if (seg.length > 1) el("polyline", { points: seg.map(p => p.join(",")).join(" "), fill: "none", stroke: col, "stroke-width": sw }, g); seg = []; };
  for (let i = 0; i <= 40; i++) {
    const s = i / 40, q = map(H, [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
    if (!q || Math.abs(q[0]) > 2e4 || Math.abs(q[1]) > 2e4) flush(); else seg.push(q);
  }
  flush();
}
function togglePerson(p) {
  const cur = S.assign[p.id];
  if (cur === S.role) { delete S.assign[p.id]; }
  else {
    const max = S.role === "R" ? 6 : ($("#mMode").value === "doubles" ? 2 : 1);
    if (Object.values(S.assign).filter(t => t === S.role).length >= max) { toast(`최대 ${max}명이에요`, true); return; }
    S.assign[p.id] = S.role;
  }
  drawSetup(); renderSetupPanel();
}
function buildDiagram() {
  const svg = $("#diag"), m = .9;
  svg.setAttribute("viewBox", `${-m} ${-m - .5} ${W_M + 2 * m} ${L_M + 2 * m + 1}`);
  svg.innerHTML = "";
  el("rect", { x: 0, y: 0, width: W_M, height: L_M, fill: "#c9a674" }, svg);
  el("line", { x1: -.4, y1: NET, x2: W_M + .4, y2: NET, class: "net" }, svg);
  const t1 = el("text", { x: W_M / 2, y: -.45, class: "side-lbl" }, svg); t1.textContent = "먼 쪽 (네트 너머)";
  const t2 = el("text", { x: W_M / 2, y: L_M + .75, class: "side-lbl" }, svg); t2.textContent = "카메라 쪽";
  // 라인 (클릭하면 라인 찍기)
  LINE_CATALOG.forEach((c, i) => {
    if (!c.outer && !S.inner && !S.clines.some(l => sameL(l.line, c.l))) {  // 안쪽 라인: 선만 흐리게
      el("line", { x1: c.l[0][0], y1: c.l[0][1], x2: c.l[1][0], y2: c.l[1][1], class: "ln dim" }, svg); return;
    }
    const done = S.clines.some(l => sameL(l.line, c.l) && l.px.length >= 2);
    const pick = S.pick?.kind === "l" && S.pick.i === i;
    const g = el("g", { class: "cl-d" + (done ? " done" : "") + (pick ? " pick" : ""), tabindex: 0, role: "button", "aria-label": c.name }, svg);
    el("line", { x1: c.l[0][0], y1: c.l[0][1], x2: c.l[1][0], y2: c.l[1][1], class: "hit" }, g);
    el("line", { x1: c.l[0][0], y1: c.l[0][1], x2: c.l[1][0], y2: c.l[1][1], class: "vis" }, g);
    // ◆ 손잡이: 교차점이 없는 구간(라인 중간)에도 고를 거리가 보이게
    const [[x1, y1], [x2, y2]] = c.l, vert = x1 === x2;
    const marks = vert ? (y2 - y1 > 10 ? [(NET - SHORT) / 2, (NET + SHORT + L_M - LONG_DBL) / 2] : [(y1 + y2) / 2]).map(y => [x1, y])
      : [[W_M * .25, y1], [W_M * .75, y1]];
    for (const [mx, my] of marks) el("path", { d: `M${mx},${my - .3}L${mx + .3},${my}L${mx},${my + .3}L${mx - .3},${my}Z`, class: "dm" }, g);
    const tt = el("title", {}, g); tt.textContent = c.name + " · 라인 위 아무 곳이나 2개 이상 찍기";
    const choose = () => { S.pick = pick ? null : { kind: "l", i }; S.sel = null; drawSetup(); renderPoints(); };
    g.addEventListener("click", choose);
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
  });
  // 교차점
  CATALOG.forEach((p, i) => {
    const done = S.points.some(q => sameC(q.court, p.c));
    if (!p.outer && !S.inner && !done) return;
    const pick = S.pick?.kind === "p" && S.pick.i === i;
    const g = el("g", { class: "cp" + (done ? " done" : "") + (pick ? " pick" : ""), tabindex: 0, role: "button", "aria-label": p.name }, svg);
    el("circle", { cx: p.c[0], cy: p.c[1], r: .2 }, g);
    const tt = el("title", {}, g); tt.textContent = p.name + (done ? " (찍음 · 다시 찍으면 옮겨져요)" : "");
    const choose = () => { S.pick = pick ? null : { kind: "p", i }; S.sel = null; drawSetup(); renderPoints(); };
    g.addEventListener("click", choose);
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
  });
}
function renderPoints() {
  buildDiagram();
  const eq = eqCount(), f = S.fit;
  $("#fitTag").textContent = eq < 8 ? `식 ${eq}/8 · 더 필요` : f?.error ? "계산 실패" : f ? `평균 오차 ${f.mean_err}px · 검산 여유 ${f.spare}` : "계산 중";
  let msg;
  if (S.pick?.kind === "p") msg = `<b style="color:#ff4fd8">${CATALOG[S.pick.i].name}</b> · 영상에서 이 위치를 클릭하세요 (Esc 취소)`;
  else if (S.pick?.kind === "l") {
    const ln = S.clines.find(l => sameL(l.line, LINE_CATALOG[S.pick.i].l));
    msg = `<b style="color:#4fe3ff">${LINE_CATALOG[S.pick.i].name}</b> · 영상에서 이 라인 위를 클릭하세요. 지금 ${ln?.px.length || 0}개 · 2개 이상, 멀리 떨어뜨려서 (다 찍었으면 Esc)`;
  } else if (eq < 8) msg = "네트 기둥 바닥 2개(●)와 바깥 라인 4개(◆)를 찍으면 충분해요. 점·라인 하나가 식 2개, 8개 이상 필요해요";
  else if (f?.error) msg = `<span style="color:var(--rejB)">${f.error}</span>`;
  else if (f && f.spare < 2) msg = `<span style="color:var(--near1)">검산 여유가 ${f.spare}이에요. 점이나 라인을 더 찍어야 잘못 찍은 걸 오차로 알아챌 수 있어요</span>`;
  else msg = "오차가 큰 점·라인은 다시 찍거나 지우세요. 먼 쪽(네트 너머) 점이 하나라도 있으면 먼 쪽 정확도가 크게 좋아져요";
  $("#pickMsg").innerHTML = msg;
  const errs = [...(f?.errors || []), ...(f?.line_errors || [])], worst = Math.max(0, ...errs);
  const bad = e => e != null && e > 8 && e === worst ? "bad" : "";
  const validLines = S.clines.filter(l => l.px.length >= 2);
  $("#ptList").innerHTML =
    S.points.map((p, i) => { const e = f?.errors?.[i]; return `<li class="${S.sel?.kind === "p" && S.sel.i === i ? "sel" : ""}" data-k="p" data-i="${i}">
      <span>${i + 1}</span><span class="nm">${cName(p.court)}</span><span class="e ${bad(e)}">${e != null ? e.toFixed(1) + "px" : "-"}</span>
      <button data-del="1" title="지우기" aria-label="${i + 1}번 점 지우기">×</button></li>`; }).join("")
    + S.clines.map((l, i) => { const e = f?.line_errors?.[validLines.indexOf(l)]; return `<li class="ln ${S.sel?.kind === "l" && S.sel.i === i ? "sel" : ""}" data-k="l" data-i="${i}">
      <span>L${i + 1}</span><span class="nm">${lName(l.line)} · ${l.px.length}점</span><span class="e ${bad(e)}">${e != null ? e.toFixed(1) + "px" : l.px.length < 2 ? "1개 더" : "-"}</span>
      <button data-del="1" title="지우기" aria-label="L${i + 1} 라인 지우기">×</button></li>`; }).join("")
    + (f?.mirrored ? `<li class="warn-line">좌우가 뒤집힌 것 같아요. 왼쪽/오른쪽을 카메라에서 볼 때 기준으로 찍었는지 확인하세요</li>` : "");
  $$("#ptList li[data-k]").forEach(li => li.onclick = e => {
    const k = li.dataset.k, i = +li.dataset.i;
    if (e.target.dataset.del) { (k === "p" ? S.points : S.clines).splice(i, 1); S.sel = null; refit(true); return; }
    if (k === "l") { S.pick = { kind: "l", i: LINE_CATALOG.findIndex(c => sameL(c.l, S.clines[i].line)) }; S.sel = { kind: "l", i, j: S.clines[i].px.length - 1 }; }
    else S.sel = { kind: "p", i };
    drawSetup(); renderPoints();
  });
}
function renderSetupPanel() {
  renderPoints();
  const per = $("#mMode").value === "doubles" ? 2 : 1, cnt = t => Object.values(S.assign).filter(v => v === t).length;
  $("#cntA").textContent = `${cnt("A")}/${per}`; $("#cntB").textContent = `${cnt("B")}/${per}`; $("#cntR").textContent = cnt("R");
  $$(".role").forEach(b => b.classList.toggle("on", b.dataset.r === S.role));
  $("#detFrameTag").textContent = S.detFrame >= 0 ? `기준 프레임 #${S.detFrame}` : "기준 프레임 없음";
}

function bindSetup() {
  const svg = $("#sSvg");
  // 도면에서 고른 상태면 영상 클릭 = 찍기 (교차점은 한 번, 라인은 Esc까지 계속)
  svg.addEventListener("pointerdown", e => {
    if (S.pick === null) return;
    const px = rpx(svgPoint(svg, e));
    if (S.pick.kind === "p") {
      const c = CATALOG[S.pick.i].c, i = S.points.findIndex(q => sameC(q.court, c));
      if (i >= 0) S.points[i].px = px; else S.points.push({ court: [...c], px });
      S.sel = { kind: "p", i: i >= 0 ? i : S.points.length - 1 }; S.pick = null;
    } else {
      const c = LINE_CATALOG[S.pick.i].l;
      let i = S.clines.findIndex(l => sameL(l.line, c));
      if (i < 0) { S.clines.push({ line: c.map(p => [...p]), px: [] }); i = S.clines.length - 1; }
      S.clines[i].px.push(px); S.sel = { kind: "l", i, j: S.clines[i].px.length - 1 };
    }
    drawSetup(); renderPoints(); refit();
  });
  svg.addEventListener("pointermove", e => {
    if (!S.drag) return; const px = rpx(svgPoint(svg, e));
    if (S.drag.kind === "p") S.points[S.drag.i].px = px; else S.clines[S.drag.i].px[S.drag.j] = px;
    drawSetup(); refit();
  });
  document.addEventListener("keydown", e => {
    if (S.mode !== "setup" || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key === "Escape") { S.pick = null; drawSetup(); renderPoints(); return; }
    if (!S.sel) return;
    const ref = S.sel.kind === "p" ? S.points[S.sel.i]?.px : S.clines[S.sel.i]?.px[S.sel.j];
    if (!ref) return;
    const d = e.shiftKey ? 10 : 1, k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
    if (e.key === "Delete" || e.key === "Backspace") {
      if (S.sel.kind === "p") S.points.splice(S.sel.i, 1);
      else { S.clines[S.sel.i].px.splice(S.sel.j, 1); if (!S.clines[S.sel.i].px.length) S.clines.splice(S.sel.i, 1); }
      S.sel = null;
    } else if (k) { ref[0] += k[0]; ref[1] += k[1]; }
    else return;
    e.preventDefault(); drawSetup(); renderPoints(); refit();
  });
  const end = () => { if (S.drag) { S.drag = null; renderPoints(); } };

  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  $("#sRange").oninput = e => loadFrame(+e.target.value);
  $$(".scrub .b").forEach(b => b.onclick = () => loadFrame(S.frame + +b.dataset.d));
  $$("#wideSeg button").forEach(b => b.onclick = () => {
    const v = +b.dataset.v, need = wideNeeded();
    if (v < need) { toast("찍어 둔 점이 화면 밖에 있어 더 줄일 수 없어요", true); return; }
    S.wide = v; $$("#wideSeg button").forEach(x => x.classList.toggle("on", x === b)); buildStage();
  });
  $("#linesChk").onchange = e => { S.lines = e.target.checked; drawSetup(); };
  $("#innerChk").onchange = e => { S.inner = e.target.checked; renderPoints(); };
  $$(".role").forEach(b => b.onclick = () => { S.role = b.dataset.r; renderSetupPanel(); });
  ["nameA", "nameB"].forEach(id => $("#" + id).oninput = drawSetup);
  $("#mMode").onchange = renderSetupPanel;
  $("#detBtn").onclick = detect;
  $("#saveBtn").onclick = () => saveConfig(false);
  $("#runBtn").onclick = () => saveConfig(true);
  $("#presetSave").onclick = () => { const n = $("#presetName").value.trim(); if (!n) { toast("이름을 적어 주세요", true); return; } saveConfig(false, n); };
  ["nameA", "nameB", "mMode", "mTarget", "mFirst", "mGame", "mScoreA", "mScoreB"].forEach(id => $("#" + id).addEventListener("input", saveDraft));
}

async function detect() {
  const b = $("#detBtn"); b.disabled = true; b.textContent = "찾는 중";
  try {
    const r = await api(`/api/lab/${S.vid}/detect`, { method: "POST", json: { frame: S.frame, points: S.points, lines: S.clines.filter(l => l.px.length >= 2) } });
    // 이전에 지정한 박스와 많이 겹치는 새 박스에 역할을 이어 붙인다
    const old = S.people, oldA = S.assign; S.assign = {};
    for (const p of r.people) {
      let best = null, bi = 0; for (const o of old) { const v = iou(o.box, p.box); if (v > bi) { bi = v; best = o; } }
      if (best && bi > .3 && oldA[best.id]) S.assign[p.id] = oldA[best.id];
    }
    S.people = r.people; S.detFrame = S.frame;
    toast(`${r.people.length}명 찾음 · 코트 근처 ${r.people.filter(p => p.in_play).length}명`);
  } catch (e) { toast(e.message, true); }
  b.disabled = false; b.textContent = "이 프레임에서 사람 찾기";
  drawSetup(); renderSetupPanel();
}

async function saveConfig(run, name = null) {
  const per = $("#mMode").value === "doubles" ? 2 : 1;
  const by = t => S.people.filter(p => S.assign[p.id] === t).map(p => p.box);
  if (by("A").length !== per || by("B").length !== per) { toast(`팀마다 ${per}명씩 지정해 주세요`, true); return; }
  if (S.detFrame < 0) { toast("먼저 사람을 찾아 지정해 주세요", true); return; }
  if (!curH()) { toast(eqCount() < 8 ? "코트 점·라인이 더 필요해요" : "코트 계산이 안 됐어요. 점·라인을 확인해 주세요", true); return; }
  const body = {
    ref_frame: S.detFrame, points: S.points, lines: S.clines.filter(l => l.px.length >= 2),
    teams: { A: { name: $("#nameA").value, bboxes: by("A") }, B: { name: $("#nameB").value, bboxes: by("B") } },
    officials: by("R"),
    match: { mode: $("#mMode").value, target: parseInt($("#mTarget").value), first: $("#mFirst").value, game: +$("#mGame").value,
      scoreA: +$("#mScoreA").value, scoreB: +$("#mScoreB").value, ...($("#mTarget").value === "21-1" ? { games_to_win: 1 } : {}),
      switch_manual: parseSwitch($("#mSwitch").value) || [],
      start_t: (parseSwitch($("#mStart").value) || [])[0] ?? null,
      final: (() => { const q = $("#mFinal").value.trim().split(":").map(x => x.trim()); return q.length === 2 && q.every(x => /^\d+$/.test(x)) ? { A: +q[0], B: +q[1] } : null; })() },
  };
  try {
    let cfg = await api(`/api/lab/${S.vid}/config`, { method: "PUT", json: body });
    if (name) { S.info.presets = await api(`/api/lab/${S.vid}/presets/${encodeURIComponent(name)}`, { method: "POST" }); cfg = { ...cfg, name }; }
    S.info.seeded = false; S.info.config = cfg; S.cfg = cfg; S.tr = null; S.sv = null;
    S.baseSig = stateSig(); dropDraft(); renderPresets();
    $("#setupMsg").textContent = `저장했어요${name ? ` · '${name}'` : ""} · data/videos/${S.vid}/lab/config.json · 기준 프레임 #${S.detFrame} · 심판 ${body.officials.length}명`;
    if (run) { const j = await api(`/api/lab/${S.vid}/track`, { method: "POST" }); watchJob(j); toast("추적을 시작했어요"); }
    else toast(name ? `'${name}'(으)로 저장했어요` : "저장했어요");
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 임시 저장 · 설정 보관함 ---------------- */
const draftKey = () => `lab:draft:${S.vid}`;
const dropDraft = () => localStorage.removeItem(draftKey());
let draftT;
function stateSig() {
  const roles = ["A", "B", "R"].map(t => S.people.filter(p => S.assign[p.id] === t).map(p => p.box.map(v => Math.round(v))).sort());
  return JSON.stringify({ p: S.points, l: S.clines, roles, f: S.detFrame, n: [$("#nameA").value, $("#nameB").value],
    m: ["mMode", "mTarget", "mFirst", "mGame", "mScoreA", "mScoreB"].map(id => String($("#" + id).value)) });
}
function saveDraft() {
  clearTimeout(draftT);
  draftT = setTimeout(() => {
    if (!S.vid || S.mode !== "setup" || S.baseSig == null) return;
    if (stateSig() === S.baseSig) { localStorage.removeItem(draftKey()); return; }   // 바뀐 게 없으면 임시 저장도 없다
    localStorage.setItem(draftKey(), JSON.stringify({
      ts: Date.now(), frame: S.frame, points: S.points, clines: S.clines, people: S.people, assign: S.assign, detFrame: S.detFrame,
      names: [$("#nameA").value, $("#nameB").value],
      match: { mode: $("#mMode").value, target: $("#mTarget").value, first: $("#mFirst").value, game: $("#mGame").value, scoreA: $("#mScoreA").value, scoreB: $("#mScoreB").value },
    }));
  }, 400);
}
function applyDraft(c) {
  let d; try { d = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { d = null; }
  if (!d || d.ts <= (c?.saved || 0) * 1000) return false;   // 서버에 저장한 게 더 최신이면 무시
  Object.assign(S, { frame: d.frame, points: d.points || [], clines: d.clines || [], people: d.people || [], assign: d.assign || {}, detFrame: d.detFrame ?? -1 });
  [$("#nameA").value, $("#nameB").value] = d.names || ["", ""];
  for (const [k, id] of [["mode", "mMode"], ["target", "mTarget"], ["first", "mFirst"], ["game", "mGame"], ["scoreA", "mScoreA"], ["scoreB", "mScoreB"]])
    if (d.match?.[k] != null) $("#" + id).value = d.match[k];
  return true;
}
function renderPresets() {
  const cur = S.info?.config?.name;
  $("#curName").textContent = cur ? `지금: ${cur}` : "이름 없음";
  if (!$("#presetName").value || $("#presetName").dataset.vid !== S.vid) { $("#presetName").value = cur || S.info?.stem || ""; $("#presetName").dataset.vid = S.vid; }
  const when = t => t ? new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  $("#presetList").innerHTML = (S.info?.presets || []).map(p => `<li class="${p.name === cur ? "cur" : ""}">
    <span class="nm"><b>${p.name}</b><small>${when(p.saved)}${p.video ? ` · ${p.video}` : ""} · 점 ${p.points} · 라인 ${p.lines} · 심판 ${p.officials} · #${p.ref_frame}</small></span>
    <button class="b" data-load="${p.name}">불러오기</button><button class="b" data-del="${p.name}" title="삭제" aria-label="${p.name} 삭제">×</button></li>`).join("")
    || `<li class="empty">아직 저장한 설정 파일이 없어요</li>`;
  $$("#presetList [data-load]").forEach(b => b.onclick = async () => {
    try {
      await api(`/api/lab/${S.vid}/presets/${encodeURIComponent(b.dataset.load)}/load`, { method: "POST" });
      dropDraft(); toast(`'${b.dataset.load}' 설정을 불러왔어요`);
      await openVideo(S.vid, "setup");
    } catch (e) { toast(e.message, true); }
  });
  $$("#presetList [data-del]").forEach(b => b.onclick = async () => {
    if (!confirm(`'${b.dataset.del}' 설정을 지울까요?`)) return;
    S.info.presets = await api(`/api/lab/${S.vid}/presets/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }); renderPresets();
  });
}

/* ---------------- 작업 진행 ---------------- */
function watchJob(j) {
  clearTimeout(S.jobTimer);
  const box = $("#jobBox");
  if (!j) { box.innerHTML = ""; return; }
  const draw = j => {
    const st = j.stages.find(s => s.state === "run") || j.stages[j.stages.length - 1];
    if (j.state === "running" || j.state === "queued")
      box.innerHTML = `추적 중<span class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></span>${st.msg || ""} <button class="b" id="cancelJob">취소</button>`;
    else if (j.state === "done") box.textContent = `추적 완료 · ${j.stages[1]?.msg || ""}`;
    else box.textContent = `추적 ${j.state === "cancelled" ? "취소됨" : "실패: " + (j.error || "")}`;
    const c = $("#cancelJob"); if (c) c.onclick = () => api(`/api/jobs/${j.id}/cancel`, { method: "POST" });
  };
  draw(j);
  if (!["running", "queued"].includes(j.state)) return;
  const tick = async () => {
    try {
      const k = await api(`/api/jobs/${j.id}`); draw(k);
      if (k.state === "done") {
        $("#tabView").disabled = $("#tabTruth").disabled = false; $("#tabTruth").title = "실제 서브 시각과 서브 팀(정답)을 기록해요"; S.tr = null; S.kps = null; S.sv = null; S.info.has_tracks = true; S.info.tracks_stale = false;
        toast("추적이 끝났어요. 추적 · 서브 확인 탭에서 볼 수 있어요"); if (S.mode === "view") enterView(); return;
      }
      if (!["running", "queued"].includes(k.state)) return;
    } catch { }
    S.jobTimer = setTimeout(tick, 1500);
  };
  S.jobTimer = setTimeout(tick, 1000);
}

/* =========================================================
   2. 추적 · 서브 확인
   ========================================================= */
const vid = () => $("#vid");
async function enterView() {
  const v = vid();
  const src = `/api/videos/${S.vid}/stream?kind=auto`;
  if (v.dataset.src !== src) { v.src = src; v.dataset.src = src; }
  $("#vSvg").setAttribute("viewBox", `0 0 ${S.meta.width} ${S.meta.height}`);
  if (S.info?.tracks_stale) toast("지금 추적 결과는 예전 설정으로 만든 거예요. 설정 탭에서 추적을 다시 실행하세요", true);
  if (!S.tr) {
    $("#nowBox").textContent = "추적 결과 불러오는 중";
    const [tr, kb, cfg] = await Promise.all([api(`/api/lab/${S.vid}/tracks`), api(`/api/lab/${S.vid}/kps`, { raw: true }), api(`/api/lab/${S.vid}`)]);
    S.tr = tr; S.cfg = cfg.config;
    S.kshape = kb.headers.get("X-Shape").split(",").map(Number);
    S.kps = new Int16Array(await kb.arrayBuffer());
    S.H = S.cfg?.h_court2px ? S.cfg.h_court2px.flat() : S.cfg?.court_corners_px ? homography(COURT, S.cfg.court_corners_px) : null;
    S.Hinv = S.cfg?.homography ? S.cfg.homography.flat() : null;
    buildCourtMini(); buildParams();
  }
  if (!S.truthLoaded) { const tr = await api(`/api/lab/${S.vid}/truth`); S.truthMarks = tr.marks || []; S.truthFinal = tr.final || null; S.truthFinalized = !!tr.finalized; S.truth = S.truthMarks.map(m => m.t); S.truthSaved = tr.from_name ? null : (tr.saved ?? 0); S.truthLoaded = true; }
  if (!S.sv) await recalc();
  loadRuns();
  if (S.mode === "truth") enterTruth();
  loop();
}

/* ---- 샘플 인덱스 ---- */
function sampleAt(t) {
  const fr = S.tr.frames, f = t * S.tr.fps; let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m] < f) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(fr[lo - 1] - f) < Math.abs(fr[lo] - f)) lo--;
  return lo;
}
const tOf = i => S.tr.frames[i] / S.tr.fps;
const kp = (i, k, j) => { const [, N, J] = S.kshape, o = ((i * N + k) * J + j) * 3; return [S.kps[o], S.kps[o + 1], S.kps[o + 2] / 1000]; };

/* ---- 영상 위 그림 ---- */
function drawVideoOverlay(i) {
  const g = $("#vSvg"); g.innerHTML = ""; const u = S.meta.width / 1600, tr = S.tr;
  if ($("#oLines").checked && S.H) { const lg = el("g", { opacity: .55 }, g); drawCourtLines(lg, S.H, "cl", 1.5 * u); }
  if ($("#oOff").checked) (tr.off_box[i] || []).forEach((b, k) => {
    if (!b || b[0] == null) return;
    el("rect", { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], fill: "none", stroke: "#c5ccc8", "stroke-width": 3 * u, "stroke-dasharray": `${12 * u} ${6 * u}` }, g);
    const t = el("text", { x: b[0], y: b[1] - 6 * u, fill: "#c5ccc8", "font-size": 20 * u, "font-weight": 700, "paint-order": "stroke", stroke: "#000", "stroke-width": 4 * u }, g); t.textContent = `심판${k + 1}`;
  });
  const spd = S.sv?.speed?.[i] || [];
  const sd = sidesAt(tOf(i)), teamOf = s => sd ? (sd.A === s.replace(/\d/, "") ? "A" : "B") : null;
  tr.slots.forEach((s, k) => {
    const b = tr.box[i][k]; if (!b || b[0] == null) return;
    const occ = tr.occ[i][k] === 1, col = SLOT_HEX[s];
    if ($("#oBox").checked) {
      el("rect", { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], fill: occ ? "none" : col + "1c", stroke: col, "stroke-width": (occ ? 2.5 : 3.5) * u, "stroke-dasharray": occ ? `${10 * u} ${7 * u}` : "none" }, g);
      const v = spd[k];
      const t = el("text", { x: b[0], y: b[1] - 8 * u, fill: col, "font-size": 21 * u, "font-weight": 700, "paint-order": "stroke", stroke: "#000", "stroke-width": 5 * u }, g);
      const tm = teamOf(s);
      t.textContent = `${tm ? `${teamName(tm)} · ` : ""}${s}${occ ? " 가려짐" : ""}${v != null ? ` ${v.toFixed(2)}m/s` : ""}`;
      if (tm && S.mode === "truth") el("rect", { x: b[0] - 4 * u, y: b[1] - 4 * u, width: b[2] - b[0] + 8 * u, height: b[3] - b[1] + 8 * u, fill: "none", stroke: TEAM_COL[tm], "stroke-width": 5 * u, rx: 6 * u }, g);
    }
    if ($("#oPose").checked && !occ) {
      for (const [a, c] of SKELETON) {
        const A = kp(i, k, a), C = kp(i, k, c); if (A[2] < .3 || C[2] < .3) continue;
        el("line", { x1: A[0], y1: A[1], x2: C[0], y2: C[1], stroke: col, "stroke-width": 3 * u, "stroke-linecap": "round" }, g);
      }
      for (const j of [9, 10, 15, 16]) { const P = kp(i, k, j); if (P[2] >= .3) el("circle", { cx: P[0], cy: P[1], r: 5 * u, fill: j < 15 ? "#fff" : col, stroke: "#000", "stroke-width": u }, g); }
    }
  });
}

/* ---- 위에서 본 코트 ---- */
function buildCourtMini() {
  const svg = $("#court"), m = 1.6;
  svg.setAttribute("viewBox", `${-m} ${-m} ${W_M + 2 * m} ${L_M + 2 * m}`);
  svg.innerHTML = "";
  el("rect", { x: -m, y: -m, width: W_M + 2 * m, height: L_M + 2 * m, fill: "#2a2219", rx: .3 }, svg);
  el("rect", { x: 0, y: 0, width: W_M, height: L_M, fill: "#c9a674" }, svg);
  // 서비스 코트 칠하기 (대각선 판정 이해용)
  const bx = (x, y, w, h, f) => el("rect", { x, y, width: w, height: h, fill: f }, svg);
  bx(0, LONG_DBL, W_M / 2, NET - SHORT - LONG_DBL, "#5aa9ff22"); bx(W_M / 2, LONG_DBL, W_M / 2, NET - SHORT - LONG_DBL, "#a38cff22");
  bx(0, NET + SHORT, W_M / 2, NET - SHORT - LONG_DBL, "#ff7a5922"); bx(W_M / 2, NET + SHORT, W_M / 2, NET - SHORT - LONG_DBL, "#ffc24a22");
  for (const [a, b] of courtLines()) el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "#fff", "stroke-width": .05 }, svg);
  el("line", { x1: -.3, y1: NET, x2: W_M + .3, y2: NET, stroke: "#ff4fd8", "stroke-width": .08 }, svg);
  const lab = (x, y, t) => { const e = el("text", { x, y, fill: "#1c1611", "font-size": .38, "text-anchor": "middle", "font-weight": 700 }, svg); e.textContent = t; };
  lab(W_M * .25, 3, "far 오른쪽"); lab(W_M * .75, 3, "far 왼쪽"); lab(W_M * .25, 11, "near 왼쪽"); lab(W_M * .75, 11, "near 오른쪽");
  el("g", { id: "miniDyn" }, svg);
  $("#legend").innerHTML = S.tr.slots.map(s => `<span><i style="background:${SLOT_HEX[s]}"></i>${s}</span>`).join("") +
    `<span><i style="background:#c5ccc8"></i>심판</span><span style="color:var(--muted)">◌ 가려짐</span>`;
}
function drawCourtMini(i) {
  const g = $("#miniDyn"); if (!g) return; g.innerHTML = ""; const tr = S.tr;
  // 지금 어느 팀이 위(far)·아래(near) 코트인지 (코트 교대 반영)
  const sd = sidesAt(tr.frames[i] / tr.fps);
  if (sd) for (const side of ["far", "near"]) {
    const tm = sd.A === side ? "A" : "B";
    const e = el("text", { x: W_M / 2, y: side === "far" ? -.55 : L_M + 1.05, fill: tm === "A" ? "#5aa9ff" : "#ff7a59", "font-size": .62, "text-anchor": "middle", "font-weight": 800 }, g);
    e.textContent = `${tm} · ${teamName(tm)}`;
  }
  const back = Math.round(2 * tr.fps / tr.step);
  tr.slots.forEach((s, k) => {
    const pts = []; for (let j = Math.max(0, i - back); j <= i; j++) { const p = tr.pos[j][k]; if (p && p[0] != null) pts.push(p); }
    if (pts.length > 1) el("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: SLOT_HEX[s], "stroke-width": .06, opacity: .7 }, g);
    const p = tr.pos[i][k]; if (!p || p[0] == null) return;
    const occ = tr.occ[i][k] === 1;
    el("circle", { cx: p[0], cy: p[1], r: .28, fill: occ ? "none" : SLOT_HEX[s], stroke: occ ? SLOT_HEX[s] : "#000", "stroke-width": occ ? .08 : .04, "stroke-dasharray": occ ? ".12 .08" : "none" }, g);
  });
  // 심판은 박스 발 위치를 코트 좌표로
  if (S.Hinv) {
    const Hinv = S.Hinv;
    (tr.off_box[i] || []).forEach(b => { if (!b || b[0] == null) return; const p = map(Hinv, [(b[0] + b[2]) / 2, b[3]]); if (!p) return; el("rect", { x: p[0] - .22, y: p[1] - .22, width: .44, height: .44, fill: "#c5ccc8" }, g); });
  }
}

/* ---- 지금 위치 설명 ---- */
// 샘플 i에서 서브 조건을 하나씩 검사한 결과: [{ok, label, why}], 처음 막힌 단계
function liveChecks(i) {
  const L = S.sv?.live, P = S.params, slots = S.tr.slots;
  if (!L) return null;
  const out = [], name = k => slots[k];
  const fv = L.fast_v[i], fk = L.fast_k[i];
  out.push(fv < 0 ? { st: "A", ok: false, label: "모두 정지", why: "선수 위치를 모름" }
    : { st: "A", ok: fv < P.still_speed, label: "모두 정지", why: fv < P.still_speed ? `가장 빠른 ${name(fk)} ${fv.toFixed(2)} m/s` : `${name(fk)}이 ${fv.toFixed(2)} m/s (기준 ${P.still_speed} 미만)` });
  const rs = L.run_s[i];
  out.push({ st: "A", ok: rs >= P.still_min, label: "정지 지속", why: `${rs.toFixed(1)}초째 (기준 ${P.still_min}초)` });
  const [ff, nf] = L.front[i], [df, dn] = L.dist[i], [lo, hi] = L.box_range;
  out.push({ st: "B", ok: ff >= 0 && nf >= 0, label: "양쪽 앞사람", why: ff >= 0 && nf >= 0 ? `far ${name(ff)} · near ${name(nf)}` : `${ff < 0 ? "far" : "near"} 쪽 선수 위치를 모름` });
  const inb = d => d != null && d >= lo && d <= hi;
  for (const [side, k, d] of [["far", ff, df], ["near", nf, dn]])
    if (k >= 0) out.push({ st: "B", ok: inb(d), label: `${side} 서비스 코트 깊이`, why: `${name(k)} 네트에서 ${d?.toFixed(2)} m (범위 ${lo}~${hi})` });
  const [bf, bn] = L.box[i];
  if (bf && bn) out.push({ st: "B", ok: bf === bn || P.require_diagonal < 0.5, label: P.require_diagonal < 0.5 ? "대각선 (참고 · 규칙 끔)" : "대각선", why: `far ${bf === "right" ? "오른쪽" : "왼쪽"} · near ${bn === "right" ? "오른쪽" : "왼쪽"}` });
  const fail = out.find(c => !c.ok);
  return { list: out, fail };
}
const LIVE_COL = { ok: "#3ecf8e", A: "#7d8a84", B: "#ff5d6c" };

const TEAM_COL = { A: "#5aa9ff", B: "#ff7a59" };
const truthRallies = () => (S.truthMarks || []).map((m, j, ms) => ({ j, t0: m.t, t1: ms[j + 1]?.t ?? S.meta.duration, w: truthWin(m) }));
// 팀 이름 (경기 설정의 1팀 = A, 2팀 = B)
const teamName = k => k === "A" ? ($("#nameA")?.value || "1팀") : k === "B" ? ($("#nameB")?.value || "2팀") : "?";
// 지금 시각의 랠리: 그 랠리 서브 · 득점 판정
function rallyAt(t) {
  const sv = S.sv?.serves || [];
  let k = -1; sv.forEach((e, j) => { if (e.t <= t + .05 && !e.removed) k = j; });
  return k < 0 ? null : { n: sv.slice(0, k + 1).filter(e => !e.removed).length, e: sv[k] };
}
// 서브 순간 상황: 첫 서브는 경기 시작, 그다음부터는 직전 랠리를 이긴 팀이 득점하고 그 팀이 서브 (랠리 포인트)
// "3:50, 12:10" ↔ [230, 730]
const parseSwitch = str => { const out = []; for (const part of String(str || "").split(/[,\s]+/).filter(Boolean)) { const p = part.split(":").map(Number); if (p.some(isNaN)) return null; out.push(p.reduce((a, b) => a * 60 + b, 0)); } return out; };
const switchStr = arr => (arr || []).map(t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`).join(", ");
// 코트 교대를 어떻게 정했나 (결과 summary.switch)
function switchText(sw) {
  if (!sw) return "";
  if (sw.mode === "manual") return `코트 교대 <b>${switchStr(sw.times)}</b> · 설정에서 지정`;
  if (sw.mode === "auto") return `코트 교대 <b>${switchStr(sw.times)}</b> · 옷 색으로 자동 감지 (차이 ${sw.ratio})`;
  return `코트 교대 · 점수 규칙으로${sw.between ? ` (옷 색 차이 ${sw.ratio}로 약해서 자동 감지 안 씀)` : ""}`;
}
// 정답 라벨로 본 교대: 정답 점수가 교대 점수에 닿은 서브와 그 앞 서브 사이
function truthSwitch() {
  const c = S.info?.config, ms = S.truthMarks || []; if (!c || ms.length < 2) return null;
  const tgt = +(c.match?.target || 21), sw = tgt === 25 ? 13 : tgt === 15 ? 8 : 11;
  for (let j = 1; j < ms.length; j++) { const sc = truthScoreAt(j); if (!sc) return null; if (Math.max(sc.A, sc.B) >= sw) return [ms[j - 1].t, ms[j].t]; }
  return null;
}
const scoreTxt = sc => `${teamName("A")} ${sc.A} : ${sc.B} ${teamName("B")}`;
// 정답 라벨로 센 점수 (j번 정답 서브 순간). 앞쪽에 서브 팀이 빈 서브가 있으면 null
function truthScoreAt(j) {
  const ms = S.truthMarks || []; let a = 0, b = 0;
  for (let i = 1; i <= j; i++) { const w = truthWin(ms[i]); if (w === "A") a++; else if (w === "B") b++; else return null; }
  return { A: a, B: b };
}
// 시각 t에 각 팀이 선 쪽: 정답이 있으면 정답 점수로 교대 시점을, 없으면 알고리즘 판정 서브의 sides
function sidesAt(t) {
  const c = S.info?.config; if (!c?.teams) return null;
  const init = { A: c.teams["1"].side, B: c.teams["2"].side }, flip = x => ({ A: x.B, B: x.A });
  const tgt = +(c.match?.target || 21), sw = tgt === 25 ? 13 : tgt === 15 ? 8 : 11;
  const ms = S.truthMarks || [];
  let j = -1; ms.forEach((m, k) => { if (m.t <= t + .05) j = k; });
  if (j >= 0) { const sc = truthScoreAt(j); if (sc) return Math.max(sc.A, sc.B) >= sw ? flip(init) : init; }
  const e = [...(S.sv?.serves || [])].reverse().find(e => e.t <= t + .05 && e.sides);
  return e?.sides || init;
}
function serveText(e, n) {
  const sc = scoreTxt(e.score), unc = e.conf != null && e.conf < .75 ? ` (불확실 ${Math.round(e.conf * 100)}%)` : "";
  if (n === 1) return `경기 시작 · ${teamName(e.server)} 서브 ${sc}`;
  return `${teamName(e.server)} 득점 → ${sc} · ${teamName(e.server)} 서브${unc}`;
}
// 마지막 랠리 (다음 서브가 없어 서브로는 득점 팀을 모름)
function lastText(e) {
  if (e.won_guess) return `마지막 랠리 → ${teamName(e.won)} 득점 ${scoreTxt(e.score_after)} (게임 포인트라 추정)`;
  return "마지막 랠리 득점 팀은 다음 서브가 없어 모름";
}
function drawNow(i, t) {
  const r = (S.sv?.runs || []).find(r => t >= r.t0 - .05 && t <= r.t1 + .05);
  const lastServe = [...(S.sv?.serves || [])].reverse().find(e => e.t <= t + .05);
  const lc = liveChecks(i);
  let h = "";
  if (lc) {
    h += `<div class="lc-head">지금 서브 조건 ${lc.fail ? `<b style="color:${LIVE_COL[lc.fail.st]}">✗ ${lc.fail.label}에서 막힘</b>` : `<b style="color:${LIVE_COL.ok}">✓ A·B 통과</b>`}</div><ul class="lc">`;
    h += lc.list.map(c => `<li class="${c.ok ? "ok" : "no"}"><i>${c.ok ? "✓" : "✗"}</i><span>${c.st} ${c.label}</span><small>${c.why}</small></li>`).join("");
    h += `</ul><div class="lc-c">C 랠리 조건은 정지가 끝난 뒤 ${S.params.rally_window}초 안에 누군가 ${S.params.rally_speed} m/s 넘게 움직여야 해요</div>`;
  }
  if (r) h += `<div class="lc-run">이 정지 구간 판정 · <b style="color:${STAGE_COL[r.stage]}">${STAGE_NAME[r.stage]}</b> ${fmt(r.t0)}–${fmt(r.t1)}<br>${r.reason}</div>`;
  if (lastServe) h += `<div class="lc-score">현재 점수 <b>${scoreTxt(lastServe.score)}</b> · ${lastServe.game}게임 · 서버 ${teamName(lastServe.server)}</div>`;
  const ra = rallyAt(t);
  if (ra) h += `<div class="lc-score">${ra.n}번 랠리 · <b>${serveText(ra.e, ra.n)}</b>${ra.n > 1 ? `<br><small>근거: 이 서브를 ${teamName(ra.e.server)}이 넣음 = 직전 랠리 득점</small>` : ""}${ra.e.won_at ? "" : `<br><small>${lastText(ra.e)}</small>`}</div>`;
  const sm = S.sv?.summary;
  if (sm?.rallies) {
    const pts = sm.score.A + sm.score.B + (sm.games || []).slice(0, sm.over ? -1 : undefined).reduce((k, g) => k + g.A + g.B, 0);
    if (sm.switch) h += `<div class="lc-score">${switchText(sm.switch)}</div>`;
    h += `<div class="lc-score">경기 끝 점수 <b>${teamName("A")} ${sm.score.A} : ${sm.score.B} ${teamName("B")}</b><br><small>서브 ${sm.rallies}개 = 랠리 ${sm.rallies}개 중 ${pts}개 반영${sm.last_rally === "unknown" ? " · 마지막 랠리는 다음 서브가 없어 득점 팀을 모름" : sm.last_rally === "guess" ? " · 마지막 랠리는 게임 포인트라 추정" : ""}</small></div>`;
  }
  $("#nowBox").innerHTML = h || "판정 정보 없음";
}

/* ---- 재생 루프 ---- */
let raf = null;
function loop() {
  cancelAnimationFrame(raf);
  const step = () => {
    if (S.mode === "setup" || !S.tr) return;
    const t = vid().currentTime, i = sampleAt(t);
    if (i !== S.cur || S.dirty) {
      S.cur = i; S.dirty = false;
      drawVideoOverlay(i); drawCourtMini(i); drawNow(i, t);
      $("#vInfo").textContent = `샘플 ${i} · 프레임 ${S.tr.frames[i]}`;
      const ra = rallyAt(t), vr = $("#vRally");
      if (vr) { vr.classList.toggle("hidden", !ra); if (ra) { const j = truthIdxNear(ra.e.t), tw = j >= 0 ? truthWin(S.truthMarks[j]) : null;
        vr.innerHTML = `${ra.n}번 랠리 · <b class="w${ra.n > 1 ? ra.e.server : ""}">${serveText(ra.e, ra.n)}</b>${ra.e.won_at ? "" : ` · <small>${lastText(ra.e)}</small>`}`
          + (tw ? ` · <small>정답: <b class="w${tw}">${teamName(tw)} ${ra.n > 1 ? "득점 · 서브" : "서브"}</b></small>` : ` · <small>A/B로 이 서브를 넣은 팀 정답</small>`);
        const ts = j >= 0 ? truthScoreAt(j) : null;
        if (ts) { const same = ts.A === ra.e.score.A && ts.B === ra.e.score.B; vr.innerHTML += `<div class="vr2">정답 점수 <b>${scoreTxt(ts)}</b> <b class="${same ? "ok" : "ng"}">${same ? "✓ 같음" : `✗ 알고리즘 ${ra.e.score.A}:${ra.e.score.B}`}</b></div>`; } } }
    }
    $("#vNum").textContent = `${fmt(t)} / ${fmt(S.meta.duration)}`;
    drawLabelBoard(t);
    if (S.mode === "truth") { const ms = S.truthMarks || [], c = ms.reduce((k, m, i) => m.t <= t + .05 ? i : k, -1); if (c !== S.tNow) { S.tNow = c; $$("#marks li[data-i]").forEach(li => li.classList.toggle("now", +li.dataset.i === c)); } }
    const sk = $("#seek"); if (!S.seeking) { sk.max = S.meta.duration; sk.value = t; }
    // 재생 중이면 타임라인 창이 따라가게
    const v = S.view; if (!vid().paused && (t > v.t0 + v.span * .85 || t < v.t0)) v.t0 = Math.max(0, t - v.span * .15);
    drawTimeline(t);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stopVideo() { cancelAnimationFrame(raf); const v = vid(); if (v && !v.paused) v.pause(); }
function seek(t, play = false) { const v = vid(); v.currentTime = clamp(t, 0, S.meta.duration - .05); S.dirty = true; if (play) v.play(); }

/* ---- 타임라인 ---- */
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, w, h];
}
const PL = 46; // 왼쪽 축 여백
// 득점 정답 띠: 랠리마다 한 칸 (파랑 = 팀 A 득점 · 주황 = 팀 B 득점 · 어두운 칸 = 아직)
function drawWinStrip(t) {
  const cv = $("#winCv"); if (!cv) return;
  const [c, w, h] = setupCanvas(cv); c.clearRect(0, 0, w, h);
  const dur = S.meta.duration, X = s => PL + (w - PL) * s / dur, rs = truthRallies();
  c.fillStyle = "#9aa7a1"; c.font = "11px 'Noto Sans KR',sans-serif"; c.fillText("서브팀", 6, h / 2 - 2);
  const n = rs.filter(r => r.w).length; c.fillText(`${n}/${rs.length}`, 6, h / 2 + 12);
  const hj = S.hoverT != null ? truthIdxNear(S.hoverT) : -1;
  for (const r of rs) {
    const xa = X(r.t0) + 1, xb = X(r.t1) - 1, bw = Math.max(2, xb - xa);
    const fl = S.flash && S.flash.j === r.j && performance.now() < S.flash.until;
    c.fillStyle = r.w ? TEAM_COL[r.w] : "#2e3834"; c.fillRect(xa, 3, bw, h - 6);
    if (fl || r.j === hj) { c.strokeStyle = fl ? "#ffffff" : "#ffe14d"; c.lineWidth = 3; c.strokeRect(xa + 1.5, 1.5, bw - 3, h - 3); c.lineWidth = 1; }
    const lbl = r.w ? `${r.j + 1} ${r.w}` : `${r.j + 1}`;
    c.font = `bold ${bw > 44 ? 14 : 12}px 'Noto Sans KR',sans-serif`;
    if (c.measureText(lbl).width + 6 < bw) { c.fillStyle = r.w ? "#0b1a2a" : "#9aa7a1"; c.fillText(lbl, xa + 4, h / 2 + 5); }
    else if (bw > 12) { c.fillStyle = r.w ? "#0b1a2a" : "#9aa7a1"; c.fillText(r.w || "", xa + 3, h / 2 + 5); }
  }
  c.fillStyle = "#fff"; c.fillRect(X(t) - 1, 0, 2, h);
}
function drawTimeline(t) {
  if (!S.sv) return;
  const dur = S.meta.duration, tr = S.tr, runs = S.sv.runs;
  // 개요 (영상 전체)
  {
    const [c, w, h] = setupCanvas($("#ovCv")); c.clearRect(0, 0, w, h);
    c.fillStyle = "#262f2b"; c.fillRect(PL, 4, w - PL, h - 8);
    const X = s => PL + (w - PL) * s / dur;
    for (const r of runs) { c.fillStyle = STAGE_COL[r.stage]; c.globalAlpha = r.stage === "OK" ? 1 : .6; c.fillRect(X(r.t0), r.stage === "OK" ? 4 : 10, Math.max(2, X(r.t1) - X(r.t0)), r.stage === "OK" ? h - 8 : h - 20); }
    for (const r of truthRallies()) {   // 아래쪽 띠 = 정답 득점 팀 (파랑 A · 주황 B · 회색 아직)
      c.globalAlpha = r.w ? .9 : .35; c.fillStyle = r.w ? TEAM_COL[r.w] : "#7d8a84";
      c.fillRect(X(r.t0) + 1, h - 7, Math.max(2, X(r.t1) - X(r.t0) - 2), 6);
    }
    c.globalAlpha = 1;
    for (const r of truthRallies()) { c.fillStyle = r.w ? TEAM_COL[r.w] : "#ffffff"; c.fillRect(X(r.t0) - 1, 0, 2, r.w ? 8 : 5); }
    c.globalAlpha = 1;
    c.strokeStyle = "#d9b98a"; c.lineWidth = 1.5; c.strokeRect(X(S.view.t0), 2, X(S.view.t0 + S.view.span) - X(S.view.t0), h - 4);
    c.fillStyle = "#fff"; c.fillRect(X(t) - 1, 0, 2, h);
    c.fillStyle = "#9aa7a1"; c.font = "11px ui-monospace,'Noto Sans KR',monospace"; c.fillText("전체", 6, h / 2 + 4);
  }
  drawWinStrip(t);
  // 상세 (창)
  const [c, w, h] = setupCanvas($("#tlCv")); c.clearRect(0, 0, w, h);
  const t0 = S.view.t0, t1 = t0 + S.view.span, X = s => PL + (w - PL) * (s - t0) / (t1 - t0);
  const laneH = 9, lanes = tr.slots.length + 1, top = 8 + lanes * (laneH + 3) + 6, bot = h - 20;
  const vmax = Math.max(4, S.params.rally_speed * 1.6), Y = v => bot - (bot - top) * Math.min(v, vmax) / vmax;
  const i0 = Math.max(0, sampleAt(t0) - 1), i1 = Math.min(tr.frames.length - 1, sampleAt(t1) + 1);
  // 정지 구간 띠
  c.fillStyle = "#ffffff10";
  for (let i = i0; i <= i1; i++) if (S.sv.still[i]) c.fillRect(X(tOf(i)), top, Math.max(1, X(tOf(Math.min(i + 1, i1))) - X(tOf(i))), bot - top);
  // 판정 구간
  for (const r of runs) {
    if (r.t1 < t0 || r.t0 > t1) continue;
    c.fillStyle = STAGE_COL[r.stage]; c.globalAlpha = r === S.selRun ? .35 : .18;
    c.fillRect(X(r.t0), top, X(r.t1) - X(r.t0), bot - top); c.globalAlpha = 1;
    c.fillRect(X(r.t0), top, X(r.t1) - X(r.t0), 3);
    c.font = "11px 'Noto Sans KR',sans-serif"; c.fillText(STAGE_NAME[r.stage], X(r.t0) + 3, top + 14);
  }
  // 정답 서브 (흰 ▼)
  for (const r of truthRallies()) {   // 랠리 구간 바탕색 = 정답 득점 팀
    if (r.t1 < t0 || r.t0 > t1 || !r.w) continue;
    const xa = Math.max(PL, X(r.t0)), xb = Math.min(w, X(r.t1));
    c.fillStyle = TEAM_COL[r.w]; c.globalAlpha = .1; c.fillRect(xa, top, xb - xa, bot - top);
    c.globalAlpha = .85; c.fillRect(xa, top + 20, xb - xa, 8); c.globalAlpha = 1;
  }
  for (const r of truthRallies()) {
    const tt = r.t0; if (tt < t0 || tt > t1) continue; const x = X(tt), col = r.w ? TEAM_COL[r.w] : "#ffffff";
    const fl = S.flash && S.flash.j === r.j && performance.now() < S.flash.until;
    c.fillStyle = col; c.beginPath(); c.moveTo(x - (fl ? 14 : 10), top - 3); c.lineTo(x + (fl ? 14 : 10), top - 3); c.lineTo(x, top + (fl ? 20 : 15)); c.fill();
    c.strokeStyle = r.w ? col : "#ffffff88"; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bot); c.stroke(); c.setLineDash([]);
    c.font = "bold 16px 'Noto Sans KR',sans-serif"; c.fillStyle = col;
    c.fillText(r.w ? `${r.j + 1}번 · ${teamName(r.w)} ${r.j ? "득점·서브" : "서브(시작)"}` : `${r.j + 1}번`, x + 12, top + 16);
  }
  if (S.hoverT != null && S.hoverT >= t0 && S.hoverT <= t1) {
    const x = X(S.hoverT); c.strokeStyle = "#ffe14d"; c.lineWidth = 3; c.beginPath(); c.moveTo(x, top - 4); c.lineTo(x, bot); c.stroke(); c.lineWidth = 1;
    c.fillStyle = "#ffe14d"; c.font = "bold 12px 'Noto Sans KR',sans-serif";
    const lbl = "A / B = 이 서브를 넣은 팀 (직전 랠리 득점)", lw = c.measureText(lbl).width; c.fillText(lbl, Math.min(x + 6, w - lw - 4), top + 42);
  }
  // 서브 표시
  for (const e of S.sv.serves) {
    if (e.t < t0 || e.t > t1) continue; const x = X(e.t);
    c.strokeStyle = "#3ecf8e"; c.lineWidth = 2; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bot); c.stroke();
    c.fillStyle = "#3ecf8e"; c.font = "bold 12px ui-monospace,'Noto Sans KR',monospace";
    c.fillText(e.score.A + e.score.B === 0 && e === S.sv.serves.find(s => !s.removed) ? `시작 · ${e.server} 서브 0:0` : `${e.server} 득점 ${e.score.A}:${e.score.B}`, x + 4, bot - 6);
  }
  // 기준선
  const hline = (v, col, txt) => { c.strokeStyle = col; c.setLineDash([5, 4]); c.lineWidth = 1; c.beginPath(); c.moveTo(PL, Y(v)); c.lineTo(w, Y(v)); c.stroke(); c.setLineDash([]); c.fillStyle = col; c.font = "10px ui-monospace,'Noto Sans KR',monospace"; c.fillText(txt, 2, Y(v) + 3); };
  hline(S.params.still_speed, "#9aa7a1", `정지 ${S.params.still_speed}`); hline(S.params.rally_speed, "#ffa63d", `랠리 ${S.params.rally_speed}`);
  // 선수별 속도
  tr.slots.forEach((s, k) => {
    c.strokeStyle = SLOT_HEX[s]; c.lineWidth = 1.6; c.beginPath(); let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = S.sv.speed[i]?.[k]; if (v == null) { pen = false; continue; }
      const x = X(tOf(i)), y = Y(v); if (pen) c.lineTo(x, y); else { c.moveTo(x, y); pen = true; }
    }
    c.stroke();
    // 보임/가려짐/없음 칸
    const ly = 8 + (k + 1) * (laneH + 3);
    c.fillStyle = "#9aa7a1"; c.font = "10px ui-monospace,'Noto Sans KR',monospace"; c.fillText(s, 2, ly + 8);
    for (let i = i0; i < i1; i++) {
      const b = tr.box[i][k], have = b && b[0] != null, occ = tr.occ[i][k] === 1;
      c.fillStyle = !have ? "#3a2226" : occ ? SLOT_HEX[s] + "66" : SLOT_HEX[s];
      c.fillRect(X(tOf(i)), ly, Math.max(1, X(tOf(i + 1)) - X(tOf(i)) + .5), laneH);
    }
  });
  // 서브 조건 칸: 매 순간 처음 막힌 단계 (초록 = A·B 통과, 회색 = A 정지, 빨강 = B 대형)
  if (S.sv.live) {
    c.fillStyle = "#9aa7a1"; c.font = "10px ui-monospace,'Noto Sans KR',monospace"; c.fillText("조건", 2, 16);
    for (let i = i0; i < i1; i++) {
      const lc = liveChecks(i); if (!lc) break;
      c.fillStyle = lc.fail ? LIVE_COL[lc.fail.st] : LIVE_COL.ok;
      c.fillRect(X(tOf(i)), 8, Math.max(1, X(tOf(i + 1)) - X(tOf(i)) + .5), laneH);
    }
  }
  // 시간 눈금
  c.fillStyle = "#9aa7a1"; c.font = "10px ui-monospace,'Noto Sans KR',monospace";
  const stepT = [1, 2, 5, 10, 30, 60].find(s => (t1 - t0) / s <= 12) || 120;
  for (let s = Math.ceil(t0 / stepT) * stepT; s <= t1; s += stepT) { const x = X(s); c.fillRect(x, bot, 1, 4); c.fillText(fmt(s), x - 14, h - 4); }
  c.fillText("m/s", 2, top + 10);
  // 현재 위치
  c.fillStyle = "#fff"; c.fillRect(X(t) - 1, 0, 2, h);
}
function bindTimeline() {
  const ov = $("#ovCv"), cv = $("#tlCv"), wc = $("#winCv");
  if (wc) {
    const rAt = e => { const r = wc.getBoundingClientRect(), t = (e.clientX - r.left - PL) / (r.width - PL) * S.meta.duration; return truthRallies().find(x => t >= x.t0 && t < x.t1); };
    wc.addEventListener("pointermove", e => { const r = rAt(e); S.hoverT = r ? r.t0 : null; });
    wc.addEventListener("pointerleave", () => { S.hoverT = null; });
    wc.addEventListener("click", e => { const r = rAt(e); if (r) { S.view.t0 = Math.max(0, r.t0 - 3); seek(Math.max(0, r.t0 - 1.5)); } });
  }
  const ovT = e => { const r = ov.getBoundingClientRect(); return clamp((e.clientX - r.left - PL) / (r.width - PL), 0, 1) * S.meta.duration; };
  ov.addEventListener("pointerdown", e => { const t = ovT(e); S.view.t0 = Math.max(0, t - S.view.span / 2); seek(t); });
  const tAt = e => { const r = cv.getBoundingClientRect(); return S.view.t0 + (e.clientX - r.left - PL) / (r.width - PL) * S.view.span; };
  let drag = null;
  cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, t0: S.view.t0, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", e => {
    if (!drag) {   // 서브 표시(정답 ▼ · 판정 초록 선)에 마우스를 대면 A/B로 득점 팀 정답
      const r = cv.getBoundingClientRect(), px = S.view.span / Math.max(1, r.width - PL), t = tAt(e);
      const cands = [...(S.truth || []), ...(S.sv?.serves || []).map(x => x.t)];
      let best = null, bd = 10 * px;
      for (const c of cands) { const d = Math.abs(c - t); if (d <= bd) { bd = d; best = c; } }
      if (best !== S.hoverT) { S.hoverT = best; cv.style.cursor = best != null ? "pointer" : ""; }
      return;
    } const dx = e.clientX - drag.x; if (Math.abs(dx) > 3) drag.moved = true;
    const r = cv.getBoundingClientRect(); S.view.t0 = clamp(drag.t0 - dx / (r.width - PL) * S.view.span, 0, Math.max(0, S.meta.duration - S.view.span));
  });
  cv.addEventListener("pointerup", e => {
    if (drag && !drag.moved) { const t = tAt(e); const r = S.sv?.runs.find(r => t >= r.t0 && t <= r.t1); if (r) selectRun(r, false); seek(t); }
    drag = null;
  });
  cv.addEventListener("pointerleave", () => { if (!drag) S.hoverT = null; });
  cv.addEventListener("wheel", e => {
    e.preventDefault(); const t = tAt(e), k = e.deltaY > 0 ? 1.25 : .8;
    const span = clamp(S.view.span * k, 4, S.meta.duration);
    S.view.t0 = clamp(t - (t - S.view.t0) * span / S.view.span, 0, Math.max(0, S.meta.duration - span)); S.view.span = span;
  }, { passive: false });
}

/* ---- 정지 구간 목록 ---- */
function renderEvents() {
  renderEval();
  const runs = S.sv.runs, f = S.filter;
  if (f === "MISS" || f === "FALSE") return renderEvalList(f);
  const list = runs.filter(r => f === "all" || (f === "OK" ? r.stage === "OK" : r.stage !== "OK"));
  const nOK = runs.filter(r => r.stage === "OK").length;
  $("#evCount").textContent = `서브 ${nOK} · 탈락 ${runs.length - nOK}`;
  const scoreAt = {}; for (const e of S.sv.serves) scoreAt[e.t.toFixed(3)] = e;
  $("#evList").innerHTML = list.map(r => {
    const idx = runs.indexOf(r), e = r.stage === "OK" ? S.sv.serves.find(e => Math.abs(e.t - r.t1) < .05) : null;
    const cues = r.cues ? `p_near ${r.p_near} · ${r.box || "-"} · view ${r.view} · 자세 far ${r.cues.pose_far} / near ${r.cues.pose_near} · 손목 ${r.cues.onset || "-"} · 대형 ${r.cues.formation ? `${r.cues.formation.far}/${r.cues.formation.near}` : "-"}` : "";
    return `<li class="${r.stage} ${r === S.selRun ? "cur" : ""}" data-i="${idx}">
      <span class="t">${fmt(r.t0)}–${fmt(r.t1)} (${(r.t1 - r.t0).toFixed(1)}s)</span><span class="st" style="color:${STAGE_COL[r.stage]}">${STAGE_NAME[r.stage]}</span>
      <span class="r">${e ? `<b>${serveText(e, S.sv.serves.filter(s => !s.removed && s.t <= e.t + 1e-6).length)}</b>${truthCmp(e)} · 신뢰도 ${e.conf}${e.flags?.length ? " · " + e.flags.join(", ") : ""}` : r.reason}</span>
      ${cues ? `<span class="cues">${cues}</span>` : ""}</li>`;
  }).join("") || `<li>해당하는 구간이 없어요</li>`;
  $$("#evList li[data-i]").forEach(li => {
    li.onclick = () => selectRun(runs[+li.dataset.i], true);
    const r = runs[+li.dataset.i];
    if (r.stage === "OK") { li.onmouseenter = () => { S.hoverT = r.t1; S.dirty = true; }; li.onmouseleave = () => { S.hoverT = null; S.dirty = true; }; li.title = "마우스를 대고 A / B = 이 서브를 넣은 팀 (직전 랠리 득점 팀) 정답"; }
  });
}
// 이 서브로 시작한 랠리: 정답 득점 팀과 알고리즘 득점 팀 비교
function truthCmp(e) {
  const j = truthIdxNear(e.t), tw = j >= 0 ? truthWin(S.truthMarks[j]) : null;
  if (!tw) return "";
  const aw = "server_raw" in e ? e.server_raw : e.server, ok = aw === tw;   // 알고리즘만의 판단과 비교
  return ` · <span style="color:${TEAM_COL[tw]}">정답 ${teamName(tw)} 서브</span> <b style="color:${ok ? "var(--ok,#3ecf8e)" : "#ff5d6c"}">${ok ? "✓" : "✗ 알고리즘은 " + (aw ? teamName(aw) : "모름")}</b>`;
}
function selectRun(r, jump) {
  S.selRun = r;
  if (jump) { S.view.t0 = Math.max(0, r.t0 - 6); S.view.span = Math.max(S.view.span, 16); seek(Math.max(0, r.t0 - 1.5), true); }
  renderEvents();
}

/* ---- 정답 서브 · 채점 ---- */
let truthT;
// 정답 저장. 불러온 뒤 다른 탭이 저장했으면 서버가 409로 막는다 (오래된 탭이 라벨을 지우지 않게)
async function putTruth(finalized = S.truthFinalized) {
  try {
    const r = await api(`/api/lab/${S.vid}/truth`, { method: "PUT", json: { marks: S.truthMarks, final: S.truthFinal, finalized, base: S.truthSaved } });
    S.truthSaved = r.saved;
    const tg = $("#tSaveTag"); if (tg) tg.textContent = `저장됨 ${new Date(r.saved * 1000).toLocaleTimeString("ko-KR")}`;
    return r;
  } catch (e) {
    if (/다른 탭/.test(e.message)) { S.truthStale = true; const tg = $("#tSaveTag"); if (tg) tg.textContent = "저장 안 됨 · 새로고침 필요"; alert(e.message); }
    throw e;
  }
}
function saveTruthSoon(ms = 600) {
  clearTimeout(truthT);
  truthT = setTimeout(async () => {
    if (S.truthStale) { toast("이 탭의 정답은 예전 것이라 저장하지 않아요. 새로고침하세요", true); return; }
    try { await putTruth(); } catch (e) { toast(e.message, true); }
    recalc();
  }, ms);
}
// 정답 서브 j에 가장 가까운 판정 서브 (2.5초 안)
const truthIdxNear = (t, tol = 2.5) => {
  let k = -1, best = tol;
  (S.truthMarks || []).forEach((m, j) => { const d = Math.abs(m.t - t); if (d <= best) { best = d; k = j; } });
  return k;
};
// 정답 라벨 = 이 서브를 넣은 팀 (= 직전 랠리 득점 팀, 첫 서브는 경기 시작 서버)
const truthWin = m => m && !m.win_auto && (m.server === "A" || m.server === "B") ? m.server : null;
// 랠리 득점 팀 정답: 마우스를 댄 서브(타임라인 ▼·초록 선, 목록 줄) 또는 지금 보고 있는 랠리에 A/B
function setTruthWinner(w) {
  const ms = S.truthMarks || [];
  if (!ms.length) { toast("정답 서브가 없어요. S로 먼저 서브를 표시하세요 (3 · 정답 입력 탭)", true); return; }
  let j = S.hoverT != null ? truthIdxNear(S.hoverT) : -1;
  if (j < 0 && S.hoverT == null && S.mode === "truth" && vid().paused && S.tsel >= 0) j = S.tsel;
  if (j < 0 && S.hoverT == null) { const t = vid().currentTime; ms.forEach((m, k) => { if (m.t <= t + .05) j = k; }); }
  if (j < 0) { toast("이 서브 근처(2.5초 안)에 정답 서브가 없어요. S로 먼저 표시하세요", true); return; }
  const m = ms[j];
  if (m.win_auto && m.server === w) { delete m.win_auto; toast(`${j + 1}번 서브 자동 판정을 확인했어요 (${teamName(w)})`); }
  else if (truthWin(m) === w) { delete m.server; delete m.win_auto; toast(`${j + 1}번 서브 정답을 지웠어요`); }
  else { m.server = w; delete m.win_auto; toast(j ? `${j + 1}번 서브 (${fmt(m.t)}) → ${teamName(w)} 득점 · 서브` : `1번 서브 → 경기 시작 ${teamName(w)} 서브`); }
  S.flash = { j, until: performance.now() + 700 };
  S.tsel = j; S.dirty = true; renderEvents(); renderTruth(); lastSb = ""; saveTruthSoon(300);
}
function toggleMark() {
  if (S.mode === "truth") { tAddMark(vid().currentTime); return; }
  const t = vid().currentTime, ms = S.truthMarks || (S.truthMarks = []), i = ms.findIndex(m => Math.abs(m.t - t) < 1.0);
  if (i >= 0) { ms.splice(i, 1); toast(`${fmt(t)} 정답 표시를 지웠어요`); }
  else { ms.push({ t: Math.round(t * 100) / 100 }); ms.sort((a, b) => a.t - b.t); toast(`${fmt(t)} 정답 서브 (${ms.length}개)`); }
  S.truth = ms.map(m => m.t); S.truthFinalized = false;
  $("#truthNum").textContent = `정답 ${S.truth.length}개`;
  saveTruthSoon();
}
// 정답에 서버 위치가 있으면: 서버 쪽(위/아래 코트) · 좌우 맞힌 수
// 정답에 랠리별 득점 팀이 있으면: 서버 팀 · 득점 팀 · 최종 점수
function rallyLine(r) {
  if (!r) return `<small style="display:block;margin-top:4px;color:var(--muted)">서버 팀·득점 팀 채점은 정답 서브마다 서브 팀(A/B)을 기록하면 나와요</small>`;
  const t = ts => ts.length ? ` <span class="bad" title="${ts.map(fmt).join(", ")}">(틀림 ${ts.slice(0, 4).map(fmt).join(", ")}${ts.length > 4 ? " …" : ""})</span>` : "";
  const ts = r.truth_score, ps = r.pred_score;
  return `<small style="display:block;margin-top:4px">서브 팀 <b>${r.server_ok}/${r.server_n}</b>${t(r.wrong_server)}<br>랠리 득점 팀 <b>${r.winner_ok}/${r.winner_n}</b>${t(r.wrong_winner)}<br>`
    + `점수 정답 <b>${ts.A}:${ts.B}</b>${r.labeled < r.server_n + 1 ? ` (득점 기록 ${r.labeled}개)` : ""}${ps ? ` · 계산 <b>${ps.A}:${ps.B}</b>` : ""}</small>`;
}
function serverLine(sv) {
  if (!sv) return `<small style="display:block;margin-top:3px;color:var(--muted)">서버 쪽·좌우 채점은 3 · 정답 입력 탭에서 서버 위치(Q W Z X)를 기록하면 나와요</small>`;
  const t = ts => ts.length ? ` <span class="bad" title="${ts.map(fmt).join(", ")}">(틀림 ${ts.slice(0, 4).map(fmt).join(", ")}${ts.length > 4 ? " …" : ""})</span>` : "";
  return `<small style="display:block;margin-top:4px">서버 쪽 <b>${sv.side_ok}/${sv.labeled}</b> (이벤트만 보면 ${sv.side_raw_ok})${t(sv.wrong_side)}<br>좌우 <b>${sv.box_ok}/${sv.box_n}</b>${t(sv.wrong_box)}</small>`;
}
function renderEval() {
  $("#truthNum").textContent = S.truth.length ? `정답 ${S.truth.length}개` : "";
  const ev = S.sv?.eval, box = $("#evalBox");
  if (!ev) { box.innerHTML = "영상을 보면서 서브 순간에 <b>S</b>를 누르면 정답으로 기록되고, 여기서 채점해요"; return; }
  box.innerHTML = `<div class="sc"><b>${ev.hit}</b>/${ev.truth} 맞음 · <span class="bad">${ev.missed.length} 놓침</span> · <span class="warnc">${ev.false.length} 잘못 잡음</span></div>
    <div class="bar2"><i style="width:${ev.recall * 100}%"></i></div><small>찾은 비율 ${Math.round(ev.recall * 100)}% · 맞힌 비율 ${Math.round(ev.precision * 100)}% · F1 ${ev.f1}</small>
    ${rallyLine(ev.rally)}${serverLine(ev.server)}
    ${(() => { const tsw = truthSwitch(), sw = (S.sv.raw_summary || S.sv.summary)?.switch; if (!tsw || !sw) return "";
      const t = sw.times?.[0], ok = t != null && t >= tsw[0] - 1 && t <= tsw[1] + 1;
      return `<small style="display:block;margin-top:4px">코트 교대 정답 ${fmt(tsw[0])}~${fmt(tsw[1])} 사이 · 알고리즘 ${t != null ? fmt(t) : "점수 규칙"} <b style="color:${ok ? "var(--ok,#3ecf8e)" : "#ff5d6c"}">${ok ? "✓" : "✗"}</b></small>`; })()}
    <small style="display:block;margin-top:3px">${ev.finalized ? "✓ 최종 정답 기준" : "⚠ 정답이 아직 최종 저장 전이에요"} · <a href="#" onclick="setMode('truth');return false" style="color:var(--wood)">3 · 정답 입력</a></small>`;
}
// 놓친 정답: 그 순간(서브 직전) 서브 조건 중 처음 막힌 것
function missReason(tt) {
  const i = sampleAt(Math.max(0, tt - 0.5)), lc = liveChecks(i);
  const r = (S.sv?.runs || []).find(r => tt >= r.t0 - 1 && tt <= r.t1 + 2.5);
  if (r) return `근처 정지 구간 ${fmt(r.t0)}–${fmt(r.t1)} · ${STAGE_NAME[r.stage]}: ${r.reason}`;
  return lc?.fail ? `정지 구간 없음 · 서브 0.5초 전: ${lc.fail.st} ${lc.fail.label} ✗ (${lc.fail.why})` : "정지 구간 없음";
}
function renderEvalList(f) {
  const ev = S.sv?.eval;
  if (!ev) { $("#evList").innerHTML = `<li>먼저 정답 서브를 표시해 주세요 (S 키)</li>`; return; }
  const items = f === "MISS" ? ev.missed : ev.false;
  $("#evCount").textContent = f === "MISS" ? `놓친 정답 ${items.length}` : `잘못 잡음 ${items.length}`;
  $("#evList").innerHTML = items.map(tt => `<li class="${f === "MISS" ? "B" : "C"}" data-t="${tt}"><span class="t">${fmt(tt)}</span>
    <span class="st">${f === "MISS" ? "놓친 서브" : "정답에 없는 서브"}</span><span class="r">${f === "MISS" ? missReason(tt) : "이 시각 근처에 정답 표시가 없어요"}</span></li>`).join("")
    || `<li>없어요</li>`;
  $$("#evList li[data-t]").forEach(li => li.onclick = () => { const tt = +li.dataset.t; S.view.t0 = Math.max(0, tt - 8); S.view.span = Math.max(S.view.span, 16); seek(Math.max(0, tt - 3), true); });
}

/* ---- 실행 기록 ---- */
async function loadRuns() {
  try { S.runs = await api(`/api/lab/${S.vid}/runs`); } catch { S.runs = []; }
  renderRuns();
}
function renderRuns() {
  const runs = S.runs || [];
  $("#runCnt").textContent = runs.length ? `${runs.length}개` : "";
  const when = t => new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#runList").innerHTML = runs.map(r => {
    const ev = r.eval, ch = Object.entries(r.changed || {}).map(([k, v]) => `${(PARAM_DOC[k]?.[0] || k).split(" (")[0]} ${v}`).join(", ");
    return `<li><div class="rh"><b>${when(r.at)}</b>${r.name ? ` · ${r.name}` : ""}</div>
      <div class="rs">서브 ${r.n}개${ev ? ` · <b class="okc">${ev.hit}/${ev.truth} 맞음</b> · F1 ${ev.f1}` : ""}${r.summary ? ` · 점수 ${r.summary.score.A}:${r.summary.score.B}` : ""}</div>
      <div class="rc">${ch ? `바꾼 기준값: ${ch}` : "기본 기준값"}</div>
      <button class="b" data-run="${r.id}">이 기준값 불러오기</button></li>`;
  }).join("") || `<li class="empty">아직 기록이 없어요</li>`;
  $$("#runList [data-run]").forEach(b => b.onclick = async () => {
    const rec = await api(`/api/lab/${S.vid}/runs/${b.dataset.run}`);
    Object.assign(S.params, rec.params); buildParams(); await recalc(); toast("그때 기준값을 불러왔어요");
  });
}

/* ---- 기준값 ---- */
function buildParams() {
  $("#paramList").innerHTML = Object.keys(PARAM_DOC).map(k => `<div class="prm"><label for="p_${k}">${PARAM_DOC[k][0]}</label>
    <input id="p_${k}" data-k="${k}" type="number" step="0.05" value="${S.params[k]}"><small>${PARAM_DOC[k][1]} · 기본 ${S.defaults[k]}</small></div>`).join("");
  let tm;
  $$("#paramList input").forEach(inp => {
    inp.classList.toggle("chg", +inp.value !== S.defaults[inp.dataset.k]);
    inp.oninput = () => { inp.classList.toggle("chg", +inp.value !== S.defaults[inp.dataset.k]); clearTimeout(tm); tm = setTimeout(recalc, 350); };
  });
}
async function recalc() {
  const p = {}; $$("#paramList input").forEach(i => { if (i.value !== "") p[i.dataset.k] = +i.value; });
  Object.assign(S.params, p); localStorage.setItem("lab:params", JSON.stringify(S.params));
  $("#calcTag").textContent = "계산 중";
  try {
    S.sv = await api(`/api/lab/${S.vid}/serves`, { method: "POST", json: { params: S.params, use_truth: $("#useTruth")?.checked ?? true } });
    const rs = S.sv.raw_summary?.score;
    $("#calcTag").textContent = `${S.sv.serves.length}개 서브 · ${S.sv.ms}ms` + (S.sv.fixed ? ` · 정답 득점 ${S.sv.fixed}개로 바로잡음 (알고리즘만이면 ${rs.A}:${rs.B})` : "");
    S.selRun = null; S.dirty = true; renderEvents();
  } catch (e) { toast(e.message, true); $("#calcTag").textContent = "실패"; }
}

function bindView() {
  const v = vid();
  $("#playBtn").onclick = () => v.paused ? v.play() : v.pause();
  v.onplay = () => $("#playBtn").textContent = "❚❚"; v.onpause = () => $("#playBtn").textContent = "▶";
  v.onseeked = () => S.dirty = true;
  $$("[data-j]").forEach(b => b.onclick = () => seek(v.currentTime + +b.dataset.j));
  $$("[data-fr]").forEach(b => b.onclick = () => { v.pause(); const i = clamp(S.cur + +b.dataset.fr, 0, S.tr.frames.length - 1); seek(tOf(i) + .001); });
  $("#rate").onchange = e => v.playbackRate = +e.target.value;
  // 재생 위치 바: 끄는 동안 바로 그 시점을 보여 준다
  const sk = $("#seek");
  sk.addEventListener("input", () => { S.seeking = true; $("#seekNum").textContent = fmt(+sk.value); seek(+sk.value); S.view.t0 = Math.max(0, +sk.value - S.view.span * .3); });
  sk.addEventListener("change", () => { S.seeking = false; $("#seekNum").textContent = ""; });
  // 시간 직접 입력: 4:30, 270, 1:02:05
  $("#goTime").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const parts = e.target.value.trim().split(":").map(Number);
    if (!parts.length || parts.some(isNaN)) { toast("4:30 처럼 분:초로 적어 주세요", true); return; }
    const sec = parts.reduce((a, b) => a * 60 + b, 0);
    seek(sec); S.view.t0 = Math.max(0, sec - S.view.span * .3); e.target.blur();
  });
  ["oBox", "oPose", "oLines", "oOff"].forEach(id => $("#" + id).onchange = () => S.dirty = true);
  $$("#evFilter button").forEach(b => b.onclick = () => { S.filter = b.dataset.f; $$("#evFilter button").forEach(x => x.classList.toggle("on", x === b)); renderEvents(); });
  $("#resetParams").onclick = () => { S.params = { ...S.defaults }; buildParams(); recalc(); };
  $("#markBtn").onclick = toggleMark;
  $("#runSave").onclick = async () => {
    try {
      await api(`/api/lab/${S.vid}/runs`, { method: "POST", json: { params: S.params, name: $("#runName").value.trim() } });
      $("#runName").value = ""; await loadRuns(); toast("지금 결과를 실행 기록으로 저장했어요");
    } catch (e) { toast(e.message, true); }
  };
  $("#tuneBtn").onclick = async () => {
    const b = $("#tuneBtn"); b.disabled = true; b.textContent = "찾는 중";
    try {
      const r = await api(`/api/lab/${S.vid}/tune`, { method: "POST", json: { params: S.params } });
      Object.assign(S.params, r.params); buildParams(); await recalc();
      toast(`F1 ${r.before.f1} → ${r.after.f1} · 맞음 ${r.before.hit} → ${r.after.hit} (${r.tried}가지 조합, ${r.sec}초)`);
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = "정답에 맞춰 기준값 자동 조정";
  };
  $("#rerunTrack").onclick = async () => { try { watchJob(await api(`/api/lab/${S.vid}/track`, { method: "POST" })); toast("추적을 다시 시작했어요"); } catch (e) { toast(e.message, true); } };
  bindTimeline();
  document.addEventListener("keydown", e => {
    if (S.mode === "setup" || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (S.mode === "truth" && truthKey(e)) { e.preventDefault(); return; }
    if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (e.key === "ArrowLeft") seek(v.currentTime - (e.shiftKey ? 1 : 5));
    else if (e.key === "ArrowRight") seek(v.currentTime + (e.shiftKey ? 1 : 5));
    else if (e.key === ",") $("[data-fr='-1']").click();
    else if (e.key === ".") $("[data-fr='1']").click();
    else if (e.key === "s" || e.key === "S" || e.key === "ㄴ") { e.preventDefault(); toggleMark(); }
    else if (["a", "A", "ㅁ"].includes(e.key)) { e.preventDefault(); setTruthWinner("A"); }
    else if (["b", "B", "ㅠ"].includes(e.key)) { e.preventDefault(); setTruthWinner("B"); }
  });
  $("#useTruth")?.addEventListener("change", recalc);
}

boot().catch(e => toast(e.message, true));

/* Smash Label — 영상별 실제 서브 시각 기록. 저장: data/videos/<id>/lab/truth.json (+ data/labels/<영상 이름>.json) */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const S = { vid: null, meta: null, marks: [], final: null, sel: -1, saveT: null, dirty: false, finalized: false,
  team: { A: "1팀", B: "2팀" } };
const STAGE_LBL = { OK: "판정 서브", A: "A 정지", B: "B 대형", C: "C 랠리" };
const pending = m => m.src === "auto" && !m.ok;
// 서버 위치 (화면 기준): 위 코트/아래 코트 × 화면 왼쪽/오른쪽
const SPOTS = [["far-L", "Q", "위 코트 왼쪽"], ["far-R", "W", "위 코트 오른쪽"], ["near-L", "Z", "아래 코트 왼쪽"], ["near-R", "X", "아래 코트 오른쪽"]];
const SPOT_KEY = { q: "far-L", ㅂ: "far-L", w: "far-R", ㅈ: "far-R", z: "near-L", ㅋ: "near-L", x: "near-R", ㅌ: "near-R" };
function setSpot(m, spot) { m.spot = m.spot === spot ? undefined : spot; changed(true); }
// 랠리 득점 팀: A = 1팀, B = 2팀. 서브 시각·개수가 아니라 덧붙이는 정보라 최종 저장 상태는 그대로 둔다
const WIN_KEY = { a: "A", ㅁ: "A", d: "B", ㅇ: "B" };
function setWin(i, w) {
  const m = S.marks[i]; if (!m) return;
  // 자동 판정 값과 같은 팀을 누르면 확인, 확인된 같은 팀을 다시 누르면 지우기
  if (m.win_auto && m.winner === w) m.win_auto = false;
  else { m.winner = m.winner === w ? undefined : w; m.win_auto = false; }
  S.sel = i; changed(true);
  if (m.winner) toast(`${i + 1}번 랠리 → ${S.team[w]} 득점`);
}
// 득점 팀을 줄 서브: 멈춘 상태에서 목록에서 고른 서브, 아니면 지금 보고 있는 랠리(지금 시각 직전 서브)
function rallyTarget() {
  const el = v();
  if (el.paused && S.sel >= 0) return S.sel;
  return S.marks.reduce((k, m, i) => m.t <= el.currentTime + .05 ? i : k, -1);
}
// 랠리마다 누적 점수 (득점 팀을 아직 안 정한 랠리부터는 모름)
function runningScore() {
  const out = []; let a = 0, b = 0, known = true;
  for (const m of S.marks) {
    if (m.winner === "A") a++; else if (m.winner === "B") b++; else known = false;
    out.push(known ? `${a}:${b}` : "");
  }
  return { out, a, b, n: S.marks.filter(m => m.winner).length, auto: S.marks.filter(m => m.winner && m.win_auto).length };
}
const v = () => $("#vid");

// 어느 팀이 누구인지: 실험 페이지 설정 프레임에서 고른 선수 모습 + 처음 선 코트
const SIDE_KO = { near: "처음 아래 코트 (카메라 쪽)", far: "처음 위 코트 (네트 너머)" };
function renderTeams(vid, c) {
  const list = $("#teamList"), note = $("#teamNote");
  if (!c?.teams) {
    list.innerHTML = `<p class="hint small">아직 팀을 안 정했어요. <a href="/lab#${vid}">실험 페이지 설정</a>에서 선수 박스를 눌러 팀 A·팀 B를 정해 주세요.</p>`;
    note.textContent = ""; return;
  }
  list.innerHTML = [["1", "A", "A"], ["2", "B", "D"]].map(([no, k, key]) => `
    <div class="team ${k}"><div class="tn"><span><kbd>${key}</kbd> <b>${S.team[k]}</b></span><small>${SIDE_KO[c.teams[no].side] || ""}${c.match?.first === k ? " · 첫 서브" : ""}</small></div>
      <div class="faces">${(c.teams[no].bboxes || []).map((_, j) => `<canvas data-t="${no}" data-j="${j}" width="56" height="84"></canvas>`).join("")}</div></div>`).join("");
  const tgt = +(c.match?.target || 21);
  const sw = tgt === 25 ? 13 : tgt === 15 ? 8 : 11;
  note.innerHTML = `${tgt}점 ${tgt === 25 ? "단판 · " + sw + "점에서" : "· 마지막 게임 " + sw + "점에서"} 코트를 바꿔요. 바꾼 뒤에도 같은 선수가 같은 팀이에요. 팀이 틀렸으면 <a href="/lab#${vid}">실험 페이지 설정</a>에서 고쳐요.`;
  if (c.ref_frame == null) return;
  const img = new Image();
  img.onload = () => {
    const sx = img.naturalWidth / (c.frame_size?.[0] || img.naturalWidth);
    $$("#teamList canvas").forEach(cv => {
      const [x1, y1, x2, y2] = c.teams[cv.dataset.t].bboxes[+cv.dataset.j].map(q => q * sx);
      const w = x2 - x1, h = y2 - y1, s = Math.min(cv.width / w, cv.height / h);
      const g = cv.getContext("2d"); g.fillStyle = "#0004"; g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, x1, y1, w, h, (cv.width - w * s) / 2, (cv.height - h * s) / 2, w * s, h * s);
    });
  };
  img.src = `/api/videos/${vid}/frames/${c.ref_frame}`;
}

async function api(url, opt = {}) {
  const o = { method: opt.method || "GET", headers: {} };
  if (opt.json !== undefined) { o.body = JSON.stringify(opt.json); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, o);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); }
  return r.json();
}
let toastT;
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 2200);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(2).padStart(5, "0")}`; };
const parseT = str => { const p = String(str).trim().split(":").map(Number); return !p.length || p.some(isNaN) ? null : p.reduce((a, b) => a * 60 + b, 0); };

/* ---------------- 영상 ---------------- */
async function boot() {
  const list = await api("/api/videos");
  const sel = $("#vidSel");
  sel.innerHTML = list.map(m => `<option value="${m.id}">${m.name} · ${fmt(m.duration || 0).slice(0, -3)}</option>`).join("") || `<option>영상 없음</option>`;
  const [want, at] = decodeURIComponent(location.hash.slice(1)).split("@");
  const vid = list.find(m => m.id === want)?.id || list[0]?.id;
  sel.onchange = () => openVideo(sel.value);
  bind();
  if (vid) {
    sel.value = vid; await openVideo(vid);
    if (at && !isNaN(+at)) { const el = v(); const go = () => seek(+at); el.readyState >= 1 ? go() : el.addEventListener("loadedmetadata", go, { once: true }); }
  }
  requestAnimationFrame(loop);
}
async function openVideo(vid) {
  if (S.dirty) await save(true);
  S.vid = vid; S.meta = await api(`/api/videos/${vid}`); S.sel = -1;
  history.replaceState(null, "", `#${vid}`);
  $("#labLink").href = `/lab#${vid}/view`;
  const el = v(); el.src = `/api/videos/${vid}/stream?kind=auto`; el.playbackRate = +$("#rate").value;
  $("#seek").max = S.meta.duration;
  const tr = await api(`/api/lab/${vid}/truth`);
  S.marks = (tr.marks || []).map(m => ({ ...m })); S.final = tr.final || null; S.finalized = !!tr.finalized;
  S.team = { A: "1팀", B: "2팀" };
  try {
    const c = (await api(`/api/lab/${vid}`)).config;
    if (c?.teams) S.team = { A: c.teams["1"]?.name || "1팀", B: c.teams["2"]?.name || "2팀" };
    renderTeams(vid, c);
  } catch { renderTeams(vid, null); }
  $("#winLegend").innerHTML = `<kbd>A</kbd> ${S.team.A} 득점 · <kbd>D</kbd> ${S.team.B} 득점`;
  $("#finA").value = S.final?.A ?? ""; $("#finB").value = S.final?.B ?? "";
  if (tr.from_name) { S.dirty = true; toast(`같은 이름 영상(${tr.video_name || ""})의 기록을 불러왔어요`); }
  $("#saveTag").textContent = tr.saved ? `저장됨 ${new Date(tr.saved * 1000).toLocaleTimeString("ko-KR")}` : "아직 기록 없음";
  render();
}

/* ---------------- 기록 ---------------- */
function addMark(t) {
  t = Math.round(clamp(t, 0, S.meta.duration) * 100) / 100;
  const dup = S.marks.findIndex(m => Math.abs(m.t - t) < 0.3);
  if (dup >= 0) { S.sel = dup; toast(`${fmt(t)} 근처에 이미 기록이 있어요`, true); render(); return; }
  S.marks.push({ t }); S.marks.sort((a, b) => a.t - b.t);
  S.sel = S.marks.findIndex(m => m.t === t);
  toast(`${S.sel + 1}번째 서브 · ${fmt(t)}`); changed();
}
function changed(keepFinal = false) { S.dirty = true; if (!keepFinal) S.finalized = false; render(); clearTimeout(S.saveT); S.saveT = setTimeout(save, 700); $("#saveTag").textContent = "저장 중"; }
async function save(now = false) {
  clearTimeout(S.saveT);
  const a = $("#finA").value, b = $("#finB").value;
  S.final = a !== "" && b !== "" ? { A: +a, B: +b } : null;
  try {
    const r = await api(`/api/lab/${S.vid}/truth`, { method: "PUT", json: { marks: S.marks, final: S.final, finalized: S.finalized } });
    S.dirty = false; $("#saveTag").textContent = `저장됨 ${new Date(r.saved * 1000).toLocaleTimeString("ko-KR")}`;
  } catch (e) { $("#saveTag").textContent = "저장 실패"; toast(e.message, true); }
}

function render() {
  const n = S.marks.length, a = $("#finA").value, b = $("#finB").value, goal = a !== "" && b !== "" ? +a + +b : null;
  $("#cnt").textContent = n;
  const np = S.marks.filter(pending).length;
  $("#pText").textContent = (goal ? `서브 ${n} / ${goal}개` : `서브 ${n}개 기록`) + (np ? ` · 확인 대기 ${np}` : "");
  renderFinal(goal, np);
  const rsT = runningScore();
  $("#tally").innerHTML = rsT.n ? `득점 기록 ${rsT.n}/${n} · <b class="tA">${S.team.A} ${rsT.a}</b> : <b class="tB">${rsT.b} ${S.team.B}</b>`
    + (rsT.auto ? ` <span class="bad">자동 판정 ${rsT.auto}개 확인 전</span>` : "")
    + (S.final && rsT.n === n && (rsT.a !== S.final.A || rsT.b !== S.final.B) ? ` <span class="bad">최종 점수와 다름</span>` : "")
    : "랠리가 끝나면 <kbd>A</kbd>/<kbd>D</kbd>로 득점한 팀을 기록하세요";
  const fill = $("#pFill"); fill.style.width = goal ? `${Math.min(100, n / goal * 100)}%` : "0"; fill.classList.toggle("done", goal != null && n === goal);
  const now = v().currentTime;
  const cur = S.marks.reduce((k, m, i) => m.t <= now + .05 ? i : k, -1);
  const rs = runningScore();
  $("#marks").innerHTML = S.marks.map((m, i) => {
    const gap = i ? m.t - S.marks[i - 1].t : null;
    const chk = m.src === "auto"
      ? `<span class="chk"><span class="stg ${m.stage}" title="${(m.reason || "").replace(/"/g, "&quot;")}">${STAGE_LBL[m.stage] || "후보"}</span>${m.ok ? `<b class="okb" title="확인함">✓</b>` : `<button class="cf" title="서브 맞음 (Enter)">✓ 맞음</button>`}</span>`
      : `<span class="chk"></span>`;
    return `<li class="${i === S.sel ? "sel" : ""} ${i === cur ? "now" : ""} ${pending(m) ? "pend" : ""}" data-i="${i}">
      <span class="no">${i + 1}</span>${chk}
      <span class="tt" data-go="${i}" title="이 시각으로 이동">${fmt(m.t)}${gap != null ? `<small>+${gap.toFixed(1)}s</small>` : ""}</span>
      <span class="nud"><button data-n="-0.1" title="0.1초 앞당기기">−.1</button><button data-n="0.1" title="0.1초 늦추기">+.1</button></span>
      <span class="win ${m.win_auto ? "auto" : ""}" title="${m.win_auto ? "자동 판정 · 맞으면 같은 팀을 눌러 확인" : ""}"><button class="A ${m.winner === "A" ? "on" : ""}" data-w="A" title="${S.team.A} 득점 (A)">1</button><button class="B ${m.winner === "B" ? "on" : ""}" data-w="B" title="${S.team.B} 득점 (D)">2</button><small>${rs.out[i]}</small></span>
      <span class="spot" title="서버가 선 곳 (화면 기준)">${SPOTS.map(([s, k, lb]) => `<button class="${s.split("-")[0]} ${m.spot === s ? "on" : ""}" data-s="${s}" title="${lb} (${k})" aria-label="${lb}"></button>`).join("")}</span>
      <input class="note" value="${(m.note || "").replace(/"/g, "&quot;")}" placeholder="메모" maxlength="100" aria-label="${i + 1}번 메모">
      <button class="del" title="지우기" aria-label="${i + 1}번 지우기">×</button></li>`;
  }).join("") || `<li class="empty">영상을 보다가 서브하는 순간 <kbd>S</kbd>를 누르세요</li>`;
  $$("#marks li[data-i]").forEach(li => {
    const i = +li.dataset.i, m = S.marks[i];
    li.onclick = e => { if (e.target.tagName !== "INPUT") { S.sel = i; render(); } };
    li.querySelector("[data-go]").onclick = e => { e.stopPropagation(); S.sel = i; seek(m.t - 1.5); render(); };
    li.querySelectorAll("[data-n]").forEach(b => b.onclick = e => { e.stopPropagation(); nudge(i, +b.dataset.n); });
    li.querySelectorAll("[data-w]").forEach(b => b.onclick = e => { e.stopPropagation(); setWin(i, b.dataset.w); });
    li.querySelectorAll("[data-s]").forEach(b => b.onclick = e => { e.stopPropagation(); S.sel = i; setSpot(m, b.dataset.s); });
    li.querySelector(".note").oninput = e => { m.note = e.target.value; S.dirty = true; clearTimeout(S.saveT); S.saveT = setTimeout(save, 900); };
    li.querySelector(".del").onclick = e => { e.stopPropagation(); S.marks.splice(i, 1); S.sel = -1; changed(); };
    const cf = li.querySelector(".cf"); if (cf) cf.onclick = e => { e.stopPropagation(); m.ok = true; S.sel = i; changed(); };
  });
  const sel = $("#marks li.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
  drawStrip();
}
function nudge(i, d) {
  const m = S.marks[i]; m.t = Math.round(clamp(m.t + d, 0, S.meta.duration) * 100) / 100;
  S.marks.sort((a, b) => a.t - b.t); S.sel = S.marks.indexOf(m); seek(m.t); changed();
}

/* ---------------- 자동 판정 불러오기 · 검토 · 최종 ---------------- */
async function loadCandidates(which) {
  try {
    const r = await api(`/api/lab/${S.vid}/candidates?which=${which}`);
    let added = 0;
    for (const c of r.candidates) {
      if (S.marks.some(m => Math.abs(m.t - c.t) < 1.0)) continue;   // 이미 있는 기록 근처는 건너뜀
      S.marks.push({ t: c.t, src: "auto", ok: false, stage: c.stage, reason: c.reason }); added++;
    }
    S.marks.sort((a, b) => a.t - b.t); changed();
    toast(`후보 ${r.candidates.length}개 중 ${added}개를 넣었어요. N으로 하나씩 확인하세요`);
  } catch (e) { toast(e.message, true); }
}
// 랠리별 득점 팀 자동 판정 (다음 서브의 서버 팀). 비어 있는 랠리만 채우고, 확인 전에는 채점에 안 쓴다
async function loadWinners() {
  try {
    if (S.dirty) await save(true);
    const r = await api(`/api/lab/${S.vid}/winners`);
    let added = 0, miss = 0;
    for (const w of r.winners) {
      const m = S.marks.find(m => Math.abs(m.t - w.t) < .011);
      if (!m || m.winner) continue;
      if (w.winner) { m.winner = w.winner; m.win_auto = true; added++; } else miss++;
    }
    changed(true);
    toast(`득점 팀 ${added}개를 채웠어요${miss ? ` (판정 못 한 랠리 ${miss}개)` : ""}. 영상을 보며 맞으면 같은 팀 키(A/D)로 확인하세요`);
  } catch (e) { toast(e.message, true); }
}
function nextAutoWin() {
  const t = v().currentTime;
  let i = S.marks.findIndex(m => m.win_auto && m.t > t + 1.0);
  if (i < 0) i = S.marks.findIndex(m => m.win_auto);
  if (i < 0) { toast("확인할 자동 득점 팀이 없어요"); return; }
  S.sel = i; seek(S.marks[i + 1] ? S.marks[i + 1].t - 4 : S.marks[i].t); v().play(); render();
}
function nextPending(fromStart = false) {
  const t = fromStart ? -1 : v().currentTime;
  let i = S.marks.findIndex(m => pending(m) && m.t > t + 1.0);
  if (i < 0) i = S.marks.findIndex(pending);
  if (i < 0) { toast("확인할 후보가 없어요"); return; }
  S.sel = i; seek(S.marks[i].t - 2.5); v().play(); render();
}
function renderFinal(goal, np) {
  const n = S.marks.length, tag = $("#finTag"), msg = $("#finMsg"), btn = $("#finBtn"), link = $("#anaLink");
  link.href = `/lab#${S.vid}/view`;
  tag.textContent = S.finalized ? "최종 저장됨" : (n ? "수정 중" : "아직 저장 안 함");
  tag.style.color = S.finalized ? "var(--ok)" : "";
  link.classList.toggle("hidden", !S.finalized);
  btn.disabled = np > 0;
  msg.textContent = np ? `확인하지 않은 후보가 ${np}개 남았어요 (N으로 이동 → Enter 또는 Delete)`
    : goal != null && n !== goal ? `기록 ${n}개 · 최종 점수로는 ${goal}개예요. 빠졌거나 더 들어간 서브가 있는지 확인하세요`
    : S.finalized ? "채점에는 이 목록이 쓰여요. 고치면 다시 최종 저장이 필요해요" : "최종 저장하면 실험 페이지에서 채점·자동 조정에 쓰여요";
}
async function finalize() {
  const a = $("#finA").value, b = $("#finB").value, goal = a !== "" && b !== "" ? +a + +b : null;
  if (goal != null && S.marks.length !== goal && !confirm(`기록이 ${S.marks.length}개인데 최종 점수로는 ${goal}개예요. 그래도 저장할까요?`)) return;
  S.finalized = true; await save(true); render();
  if (S.finalized) toast("최종 정답을 저장했어요. '결과 분석 보기'로 채점 결과를 볼 수 있어요");
}

/* ---------------- 전체 띠 (기록 위치) ---------------- */
function drawStrip() {
  const cv = $("#strip"), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !S.meta) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const X = t => w * t / S.meta.duration;
  for (let m = 60; m < S.meta.duration; m += 60) { c.fillStyle = "#ffffff22"; c.fillRect(X(m), 0, 1, h); c.fillStyle = "#9aa7a1"; c.font = "10px ui-monospace,monospace"; c.fillText(`${m / 60}분`, X(m) + 3, 11); }
  S.marks.forEach((m, i) => {
    c.fillStyle = i === S.sel ? "#ffffff" : pending(m) ? "#7d8a84" : m.winner === "A" ? "#5aa9ff" : m.winner === "B" ? "#ff7a59" : "#d9b98a";
    c.fillRect(X(m.t) - 1.5, pending(m) ? 14 : 6, 3, pending(m) ? h - 14 : h - 6);
  });
  c.fillStyle = "#3ecf8e"; c.fillRect(X(v().currentTime) - 1, 0, 2, h);
}

/* ---------------- 재생 ---------------- */
function seek(t) { const el = v(); el.currentTime = clamp(t, 0, (S.meta?.duration || 0) - .02); }
let lastCur = -2;
function loop() {
  const el = v();
  if (S.meta) {
    const t = el.currentTime;
    $("#tNow").textContent = fmt(t); $("#vInfo").textContent = `${fmt(t)} · 프레임 ${Math.round(t * S.meta.fps)}`;
    if (document.activeElement !== $("#seek")) $("#seek").value = t;
    const cur = S.marks.reduce((k, m, i) => m.t <= t + .05 ? i : k, -1);
    if (cur !== lastCur) { lastCur = cur; $$("#marks li[data-i]").forEach(li => li.classList.toggle("now", +li.dataset.i === cur)); }
    drawStrip();
  }
  requestAnimationFrame(loop);
}

function bind() {
  const el = v();
  $("#playBtn").onclick = () => el.paused ? el.play() : el.pause();
  el.onplay = () => $("#playBtn").textContent = "❚❚"; el.onpause = () => $("#playBtn").textContent = "▶";
  $$("[data-j]").forEach(b => b.onclick = () => seek(el.currentTime + +b.dataset.j));
  $$("[data-f]").forEach(b => b.onclick = () => { el.pause(); seek(el.currentTime + +b.dataset.f / (S.meta?.fps || 30)); });
  $("#rate").onchange = e => el.playbackRate = +e.target.value;
  $("#seek").oninput = e => seek(+e.target.value);
  $("#strip").onclick = e => { const r = e.target.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * S.meta.duration); };
  $("#addBtn").onclick = () => addMark(el.currentTime);
  $("#loadAll").onclick = () => loadCandidates("all");
  $("#loadOk").onclick = () => loadCandidates("ok");
  $("#nextBtn").onclick = () => nextPending();
  $("#loadWin").onclick = loadWinners;
  $("#nextWin").onclick = nextAutoWin;
  $("#finBtn").onclick = finalize;
  $("#tAdd").onclick = () => { const t = parseT($("#tIn").value); if (t == null) { toast("4:30.5 처럼 분:초로 적어 주세요", true); return; } addMark(t); seek(t - 1.5); $("#tIn").value = ""; };
  $("#tIn").addEventListener("keydown", e => { if (e.key === "Enter") $("#tAdd").click(); });
  ["finA", "finB"].forEach(id => { $("#" + id).oninput = () => changed(); $("#" + id).addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); }); });
  // 영상을 누르면 재생/정지 + 입력 칸에서 커서를 빼서 단축키(S 등)가 바로 먹게
  el.addEventListener("click", () => { document.activeElement?.blur(); el.paused ? el.play() : el.pause(); });
  window.addEventListener("beforeunload", e => { if (S.dirty) { save(true); e.preventDefault(); } });
  window.addEventListener("resize", drawStrip);
  document.addEventListener("keydown", e => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const k = e.key, sel = S.sel >= 0 ? S.marks[S.sel] : null;
    if (k === " ") { e.preventDefault(); el.paused ? el.play() : el.pause(); }
    else if (k === "s" || k === "S" || k === "ㄴ") { e.preventDefault(); addMark(el.currentTime); }
    else if (k === "ArrowLeft") { e.preventDefault(); seek(el.currentTime - (e.shiftKey ? 5 : 1)); }
    else if (k === "ArrowRight") { e.preventDefault(); seek(el.currentTime + (e.shiftKey ? 5 : 1)); }
    else if (k === ",") { el.pause(); seek(el.currentTime - 1 / (S.meta?.fps || 30)); }
    else if (k === ".") { el.pause(); seek(el.currentTime + 1 / (S.meta?.fps || 30)); }
    else if (k === "[" || k === "]") {
      const t = el.currentTime, m = k === "]" ? S.marks.find(m => m.t > t + 1.6) : [...S.marks].reverse().find(m => m.t < t - 0.1 - 1.5);
      if (m) { S.sel = S.marks.indexOf(m); seek(m.t - 1.5); render(); }
    }
    else if (WIN_KEY[k.toLowerCase()]) { e.preventDefault(); const i = rallyTarget(); if (i < 0) toast("먼저 서브를 기록하세요", true); else setWin(i, WIN_KEY[k.toLowerCase()]); }
    else if (sel && SPOT_KEY[k.toLowerCase()]) { e.preventDefault(); setSpot(sel, SPOT_KEY[k.toLowerCase()]); }
    else if (k === "n" || k === "N" || k === "ㅜ") { e.preventDefault(); nextPending(); }
    else if (sel && k === "Enter") { e.preventDefault(); if (sel.src === "auto") { sel.ok = true; changed(); nextPending(); } }
    else if (sel && (k === "Delete" || k === "Backspace")) { e.preventDefault(); const wasPend = pending(sel); S.marks.splice(S.sel, 1); S.sel = -1; changed(); if (wasPend) nextPending(); }
    else if (sel && (k === "-" || k === "=")) { nudge(S.sel, k === "-" ? -0.1 : 0.1); }
  });
}

boot().catch(e => toast(e.message, true));

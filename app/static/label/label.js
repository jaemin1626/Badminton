/* Smash Label — 영상별 실제 서브 시각 기록. 저장: data/videos/<id>/lab/truth.json (+ data/labels/<영상 이름>.json) */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const S = { vid: null, meta: null, marks: [], final: null, sel: -1, saveT: null, dirty: false, finalized: false };
const STAGE_LBL = { OK: "판정 서브", A: "A 정지", B: "B 대형", C: "C 랠리" };
const pending = m => m.src === "auto" && !m.ok;
const v = () => $("#vid");

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
  const want = location.hash.slice(1);
  const vid = list.find(m => m.id === want)?.id || list[0]?.id;
  sel.onchange = () => openVideo(sel.value);
  bind();
  if (vid) { sel.value = vid; await openVideo(vid); }
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
function changed() { S.dirty = true; S.finalized = false; render(); clearTimeout(S.saveT); S.saveT = setTimeout(save, 700); $("#saveTag").textContent = "저장 중"; }
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
  const fill = $("#pFill"); fill.style.width = goal ? `${Math.min(100, n / goal * 100)}%` : "0"; fill.classList.toggle("done", goal != null && n === goal);
  const now = v().currentTime;
  const cur = S.marks.reduce((k, m, i) => m.t <= now + .05 ? i : k, -1);
  $("#marks").innerHTML = S.marks.map((m, i) => {
    const gap = i ? m.t - S.marks[i - 1].t : null;
    const chk = m.src === "auto"
      ? `<span class="chk"><span class="stg ${m.stage}" title="${(m.reason || "").replace(/"/g, "&quot;")}">${STAGE_LBL[m.stage] || "후보"}</span>${m.ok ? `<b class="okb" title="확인함">✓</b>` : `<button class="cf" title="서브 맞음 (Enter)">✓ 맞음</button>`}</span>`
      : `<span class="chk"></span>`;
    return `<li class="${i === S.sel ? "sel" : ""} ${i === cur ? "now" : ""} ${pending(m) ? "pend" : ""}" data-i="${i}">
      <span class="no">${i + 1}</span>${chk}
      <span class="tt" data-go="${i}" title="이 시각으로 이동">${fmt(m.t)}${gap != null ? `<small>+${gap.toFixed(1)}s</small>` : ""}</span>
      <span class="nud"><button data-n="-0.1" title="0.1초 앞당기기">−.1</button><button data-n="0.1" title="0.1초 늦추기">+.1</button></span>
      <span class="sv"><button class="A ${m.server === "A" ? "on" : ""}" data-s="A" title="팀 A 서브">A</button><button class="B ${m.server === "B" ? "on" : ""}" data-s="B" title="팀 B 서브">B</button></span>
      <input class="note" value="${(m.note || "").replace(/"/g, "&quot;")}" placeholder="메모" maxlength="100" aria-label="${i + 1}번 메모">
      <button class="del" title="지우기" aria-label="${i + 1}번 지우기">×</button></li>`;
  }).join("") || `<li class="empty">영상을 보다가 서브하는 순간 <kbd>S</kbd>를 누르세요</li>`;
  $$("#marks li[data-i]").forEach(li => {
    const i = +li.dataset.i, m = S.marks[i];
    li.onclick = e => { if (e.target.tagName !== "INPUT") { S.sel = i; render(); } };
    li.querySelector("[data-go]").onclick = e => { e.stopPropagation(); S.sel = i; seek(m.t - 1.5); render(); };
    li.querySelectorAll("[data-n]").forEach(b => b.onclick = e => { e.stopPropagation(); nudge(i, +b.dataset.n); });
    li.querySelectorAll("[data-s]").forEach(b => b.onclick = e => { e.stopPropagation(); m.server = m.server === b.dataset.s ? undefined : b.dataset.s; S.sel = i; changed(); });
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
    c.fillStyle = i === S.sel ? "#ffffff" : pending(m) ? "#7d8a84" : m.server === "A" ? "#5aa9ff" : m.server === "B" ? "#ff7a59" : "#d9b98a";
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
    else if (sel && (k === "a" || k === "A" || k === "ㅁ")) { sel.server = "A"; changed(); }
    else if (sel && (k === "b" || k === "B" || k === "ㅠ")) { sel.server = "B"; changed(); }
    else if (k === "n" || k === "N" || k === "ㅜ") { e.preventDefault(); nextPending(); }
    else if (sel && k === "Enter") { e.preventDefault(); if (sel.src === "auto") { sel.ok = true; changed(); nextPending(); } }
    else if (sel && (k === "Delete" || k === "Backspace")) { e.preventDefault(); const wasPend = pending(sel); S.marks.splice(S.sel, 1); S.sel = -1; changed(); if (wasPend) nextPending(); }
    else if (sel && (k === "-" || k === "=")) { nudge(S.sel, k === "-" ? -0.1 : 0.1); }
  });
}

boot().catch(e => toast(e.message, true));

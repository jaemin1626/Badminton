/* Smash Lab · 정답 입력 탭 (예전 /label 페이지를 합침)
   정답은 S.truthMarks / S.truthFinal / S.truthFinalized 하나로 쓰고, 저장은 lab.js 의 saveTruthSoon.
   이 파일은 함수 정의만 있다 (lab.js 보다 먼저 읽히지만 실행은 lab.js 가 부른 뒤). */
"use strict";
const T_STAGE_LBL = { OK: "판정 서브", A: "A 정지", B: "B 대형", C: "C 랠리" };
const tPending = m => m.src === "auto" && !m.ok;
// 서버가 선 곳 (화면 기준): 위 코트/아래 코트 × 화면 왼쪽/오른쪽
const T_SPOTS = [["far-L", "Q", "위 코트 왼쪽"], ["far-R", "W", "위 코트 오른쪽"], ["near-L", "Z", "아래 코트 왼쪽"], ["near-R", "X", "아래 코트 오른쪽"]];
const T_SPOT_KEY = { q: "far-L", ㅂ: "far-L", w: "far-R", ㅈ: "far-R", z: "near-L", ㅋ: "near-L", x: "near-R", ㅌ: "near-R" };
const T_SIDE_KO = { near: "처음 아래 코트 (카메라 쪽)", far: "처음 위 코트 (네트 너머)" };
const tMarks = () => S.truthMarks || (S.truthMarks = []);
const tSel = () => (S.tsel != null && S.tsel >= 0 ? tMarks()[S.tsel] : null);

// 정답이 바뀌면: 저장 예약 + 채점·화면 갱신. 서브 시각·개수가 바뀌면 최종 저장 상태를 푼다
function tChanged(keepFinal = false) {
  if (!keepFinal) S.truthFinalized = false;
  S.truth = tMarks().map(m => m.t);
  const tn = $("#truthNum"); if (tn) tn.textContent = `정답 ${S.truth.length}개`;
  $("#tSaveTag") && ($("#tSaveTag").textContent = "저장 중");
  S.dirty = true; lastSb = "";
  renderTruth(); if (S.sv) renderEvents();
  saveTruthSoon(500);
}
function tReadFinal() {
  const a = $("#finA")?.value ?? "", b = $("#finB")?.value ?? "";
  S.truthFinal = a !== "" && b !== "" ? { A: +a, B: +b } : null;
}

// 서브마다 그 순간 점수: 2번 서브부터 넣은 팀이 직전 랠리 득점 (첫 서브는 0:0 경기 시작)
function tRunningScore() {
  const out = []; let a = 0, b = 0, known = true;
  tMarks().forEach((m, i) => {
    if (i) { if (m.server === "A") a++; else if (m.server === "B") b++; else known = false; }
    out.push(known ? `${a}:${b}` : "");
  });
  const ms = tMarks();
  return { out, a, b, n: ms.filter(m => m.server).length, auto: ms.filter(m => m.server && m.win_auto).length };
}

/* ---- 팀 (설정 프레임에서 고른 선수 얼굴) ---- */
function renderTeams() {
  const list = $("#teamList"), note = $("#teamNote"), c = S.info?.config;
  if (!list) return;
  if (!c?.teams) { list.innerHTML = `<p class="hint small">아직 팀을 안 정했어요. <b>1 · 설정</b>에서 선수 박스를 눌러 팀 A·팀 B를 정해 주세요.</p>`; note.textContent = ""; return; }
  list.innerHTML = [["1", "A"], ["2", "B"]].map(([no, k]) => `
    <div class="team ${k}"><div class="tn"><span><kbd>${k}</kbd> <input class="tname" data-k="${k}" value="${esc(c.teams[no].name)}" maxlength="12" aria-label="팀 ${k} 이름"></span><small>${T_SIDE_KO[c.teams[no].side] || ""}${c.match?.first === k ? " · 첫 서브" : ""}</small></div>
      <div class="faces">${(c.teams[no].bboxes || []).map((_, j) => `<canvas data-t="${no}" data-j="${j}" width="56" height="84"></canvas>`).join("")}</div></div>`).join("")
    + `<div class="row"><button class="btn" id="teamSwap" title="팀 A와 팀 B를 맞바꿔요. 이미 넣은 정답 서브 팀·최종 점수·첫 서브도 같이 바뀌어요">팀 A ↔ 팀 B 바꾸기</button></div>`;
  $$("#teamList .tname").forEach(inp => {
    inp.onchange = () => tPatchTeams({ [inp.dataset.k === "A" ? "nameA" : "nameB"]: inp.value });
    inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); };
  });
  $("#teamSwap").onclick = () => { if (confirm("팀 A와 팀 B를 맞바꿀까요? 이미 넣은 정답의 서브 팀도 같이 바뀌어요.")) tPatchTeams({ swap: true }); };
  const tgt = +(c.match?.target || 21), one = tgt === 25 || +c.match?.games_to_win === 1;
  const sw = tgt === 25 ? 13 : tgt === 15 ? 8 : 11;
  note.innerHTML = `${tgt}점 ${one ? "단판" : "3판"} · ${one ? "" : "마지막 게임 "}${sw}점에서 코트를 바꿔요. 바꾼 뒤에도 같은 선수가 같은 팀이에요.`;
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
  img.src = `/api/videos/${S.vid}/frames/${c.ref_frame}`;
}
async function tPatchTeams(body) {
  try {
    clearTimeout(truthT);
    if (S.truthLoaded && !S.truthStale) await putTruth();   // 바꾸기 전에 지금 정답을 먼저 저장
    const r = await api(`/api/lab/${S.vid}/teams`, { method: "PATCH", json: body });
    S.info.config = r.config; S.cfg = r.config;
    $("#nameA").value = r.config.teams["1"].name; $("#nameB").value = r.config.teams["2"].name;
    $("#mFirst").value = r.config.match?.first || "A";
    S.truthMarks = r.truth.marks || []; S.truthFinal = r.truth.final || null; S.truthFinalized = !!r.truth.finalized; S.truthSaved = r.truth.saved ?? S.truthSaved;
    S.truth = S.truthMarks.map(m => m.t);
    toast(body.swap ? "팀 A와 팀 B를 맞바꿨어요" : "팀 이름을 바꿨어요");
    enterTruth(); S.dirty = true; await recalc();
  } catch (e) { toast(e.message, true); }
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---- 서브 기록 ---- */
function tAddMark(t) {
  t = Math.round(clamp(t, 0, S.meta.duration) * 100) / 100;
  const ms = tMarks(), dup = ms.findIndex(m => Math.abs(m.t - t) < 0.3);
  if (dup >= 0) { S.tsel = dup; toast(`${fmt(t)} 근처에 이미 정답 서브가 있어요`, true); renderTruth(); return; }
  ms.push({ t }); ms.sort((a, b) => a.t - b.t);
  S.tsel = ms.findIndex(m => m.t === t);
  toast(`${S.tsel + 1}번째 서브 · ${fmt(t)}`); tChanged();
}
function tNudge(i, d) {
  const ms = tMarks(), m = ms[i]; m.t = Math.round(clamp(m.t + d, 0, S.meta.duration) * 100) / 100;
  ms.sort((a, b) => a.t - b.t); S.tsel = ms.indexOf(m); seek(m.t); tChanged();
}
function tDelete(i) { const ms = tMarks(), wasPend = tPending(ms[i]); ms.splice(i, 1); S.tsel = -1; tChanged(); return wasPend; }
function tSetSpot(m, spot) { m.spot = m.spot === spot ? undefined : spot; tChanged(true); }
// 목록 줄의 1/2 버튼: 자동값과 같은 팀이면 확인, 확인된 같은 팀을 다시 누르면 지우기
function tSetWin(i, w) {
  const m = tMarks()[i]; if (!m) return;
  if (m.win_auto && m.server === w) m.win_auto = false;
  else { m.server = m.server === w ? undefined : w; m.win_auto = false; }
  S.tsel = i; S.flash = { j: i, until: performance.now() + 700 }; tChanged(true);
  if (m.server) toast(i ? `${i + 1}번 서브 → ${teamName(w)} 득점 · 서브` : `1번 서브 → 경기 시작 ${teamName(w)} 서브`);
}

/* ---- 자동 판정 불러오기 · 검토 · 최종 ---- */
async function tLoadCandidates(which) {
  try {
    const r = await api(`/api/lab/${S.vid}/candidates?which=${which}`);
    const ms = tMarks(); let added = 0;
    for (const c of r.candidates) {
      if (ms.some(m => Math.abs(m.t - c.t) < 1.0)) continue;   // 이미 있는 정답 근처는 건너뜀
      ms.push({ t: c.t, src: "auto", ok: false, stage: c.stage, reason: c.reason }); added++;
    }
    ms.sort((a, b) => a.t - b.t); tChanged();
    toast(`후보 ${r.candidates.length}개 중 ${added}개를 넣었어요. N으로 하나씩 확인하세요`);
  } catch (e) { toast(e.message, true); }
}
// 비어 있는 서브에 알고리즘이 본 서버 팀 채움. 확인 전에는 채점에 안 쓴다
async function tLoadWinners() {
  try {
    clearTimeout(truthT);
    await putTruth();
    const r = await api(`/api/lab/${S.vid}/winners`);
    let added = 0, miss = 0;
    for (const w of r.servers) {
      const m = tMarks().find(m => Math.abs(m.t - w.t) < .011);
      if (!m || m.server) continue;
      if (w.server) { m.server = w.server; m.win_auto = true; added++; } else miss++;
    }
    tChanged(true);
    toast(`서브 팀 ${added}개를 채웠어요${miss ? ` (판정 못 한 서브 ${miss}개)` : ""}. 맞으면 같은 팀 키(A/B)로 확인하세요`);
  } catch (e) { toast(e.message, true); }
}
function tNextAutoWin() {
  const t = vid().currentTime, ms = tMarks();
  let i = ms.findIndex(m => m.win_auto && m.t > t + 1.0);
  if (i < 0) i = ms.findIndex(m => m.win_auto);
  if (i < 0) { toast("확인할 자동 서브 팀이 없어요"); return; }
  S.tsel = i; seek(Math.max(0, ms[i].t - 3), true); renderTruth();
}
function tNextPending() {
  const t = vid().currentTime, ms = tMarks();
  let i = ms.findIndex(m => tPending(m) && m.t > t + 1.0);
  if (i < 0) i = ms.findIndex(tPending);
  if (i < 0) { toast("확인할 후보가 없어요"); return; }
  S.tsel = i; seek(Math.max(0, ms[i].t - 2.5), true); renderTruth();
}
async function tFinalize() {
  tReadFinal();
  const n = tMarks().length, f = S.truthFinal, goal = f ? f.A + f.B : null;
  if (goal != null && n !== goal && !confirm(`정답 서브가 ${n}개인데 최종 점수로는 ${goal}개예요. 그래도 저장할까요?`)) return;
  S.truthFinalized = true; clearTimeout(truthT);
  try {
    await putTruth(true);
    toast("최종 정답을 저장했어요. 2 · 추적 · 서브 확인 탭에서 채점 결과를 볼 수 있어요");
  } catch (e) { S.truthFinalized = false; toast(e.message, true); }
  renderTruth(); recalc();
}

/* ---- 패널 그리기 ---- */
function renderTruth() {
  if (!$("#marks") || S.mode !== "truth") return;
  const ms = tMarks(), n = ms.length, f = S.truthFinal, goal = f ? f.A + f.B : null, np = ms.filter(tPending).length;
  $("#cnt").textContent = n;
  $("#pText").textContent = (goal ? `서브 ${n} / ${goal}개` : `서브 ${n}개 기록`) + (np ? ` · 확인 대기 ${np}` : "");
  const fill = $("#pFill"); fill.style.width = goal ? `${Math.min(100, n / goal * 100)}%` : "0"; fill.classList.toggle("done", goal != null && n === goal);
  const rs = tRunningScore();
  const lastOk = f && rs.n === n && ((rs.a === f.A - 1 && rs.b === f.B) || (rs.a === f.A && rs.b === f.B - 1));
  $("#tally").innerHTML = rs.n ? `서브 팀 기록 ${rs.n}/${n} · 마지막 서브 때 <b class="tA">${esc(teamName("A"))} ${rs.a}</b> : <b class="tB">${rs.b} ${esc(teamName("B"))}</b>`
    + (rs.auto ? ` <span class="bad">자동 판정 ${rs.auto}개 확인 전</span>` : "")
    + (f && rs.n === n ? (lastOk ? ` · 마지막 랠리 ${f.A > rs.a ? esc(teamName("A")) : esc(teamName("B"))} 득점 → ${f.A}:${f.B}` : ` <span class="bad">최종 점수와 안 맞음</span>`) : "")
    : "서브마다 <kbd>A</kbd>/<kbd>B</kbd>로 서브를 넣은 팀(= 직전 랠리 득점 팀)을 기록하세요";
  // 최종 저장
  const tag = $("#finTag"), msg = $("#finMsg");
  tag.textContent = S.truthFinalized ? "최종 저장됨" : (n ? "수정 중" : "아직 저장 안 함");
  tag.style.color = S.truthFinalized ? "var(--ok)" : "";
  $("#finBtn").disabled = np > 0;
  msg.textContent = np ? `확인하지 않은 후보가 ${np}개 남았어요 (N으로 이동 → Enter 또는 Delete)`
    : goal != null && n !== goal ? `정답 서브 ${n}개 · 최종 점수로는 ${goal}개예요. 빠졌거나 더 들어간 서브가 있는지 확인하세요`
    : S.truthFinalized ? "채점에는 이 목록이 쓰여요. 고치면 다시 최종 저장이 필요해요" : "최종 저장하면 채점·자동 조정에 확정된 정답으로 쓰여요";
  // 목록
  const now = vid().currentTime, cur = ms.reduce((k, m, i) => m.t <= now + .05 ? i : k, -1);
  $("#marks").innerHTML = ms.map((m, i) => {
    const gap = i ? m.t - ms[i - 1].t : null;
    const chk = m.src === "auto"
      ? `<span class="chk"><span class="stg ${m.stage}" title="${esc(m.reason)}">${T_STAGE_LBL[m.stage] || "후보"}</span>${m.ok ? `<b class="okb" title="확인함">✓</b>` : `<button class="cf" title="서브 맞음 (Enter)">✓ 맞음</button>`}</span>`
      : `<span class="chk"></span>`;
    return `<li class="${i === S.tsel ? "sel" : ""} ${i === cur ? "now" : ""} ${tPending(m) ? "pend" : ""}" data-i="${i}">
      <span class="no">${i + 1}</span>${chk}
      <span class="tt" data-go="${i}" title="이 시각으로 이동">${fmt(m.t)}${gap != null ? `<small>+${gap.toFixed(1)}s</small>` : ""}</span>
      <span class="nud"><button data-n="-0.1" title="0.1초 앞당기기 (-)">−.1</button><button data-n="0.1" title="0.1초 늦추기 (=)">+.1</button></span>
      <span class="win ${m.win_auto ? "auto" : ""}" title="${m.win_auto ? "자동 판정 · 맞으면 같은 팀을 눌러 확인" : "이 서브를 넣은 팀 (직전 랠리 득점 팀)"}"><button class="A ${m.server === "A" ? "on" : ""}" data-w="A" title="${esc(teamName("A"))} 서브 (A)">A</button><button class="B ${m.server === "B" ? "on" : ""}" data-w="B" title="${esc(teamName("B"))} 서브 (B)">B</button><small>${rs.out[i]}</small></span>
      <span class="spot" title="서버가 선 곳 (화면 기준)">${T_SPOTS.map(([s, k, lb]) => `<button class="${s.split("-")[0]} ${m.spot === s ? "on" : ""}" data-s="${s}" title="${lb} (${k})" aria-label="${lb}"></button>`).join("")}</span>
      <input class="note" value="${esc(m.note)}" placeholder="메모" maxlength="100" aria-label="${i + 1}번 메모">
      <button class="del" title="지우기 (Delete)" aria-label="${i + 1}번 지우기">×</button></li>`;
  }).join("") || `<li class="empty">영상을 보다가 서브하는 순간 <kbd>S</kbd>를 누르세요</li>`;
  $$("#marks li[data-i]").forEach(li => {
    const i = +li.dataset.i, m = ms[i];
    li.onclick = e => { if (e.target.tagName !== "INPUT") { S.tsel = i; renderTruth(); } };
    li.onmouseenter = () => { S.hoverT = m.t; S.dirty = true; };
    li.onmouseleave = () => { S.hoverT = null; S.dirty = true; };
    li.querySelector("[data-go]").onclick = e => { e.stopPropagation(); S.tsel = i; S.view.t0 = Math.max(0, m.t - 8); seek(Math.max(0, m.t - 1.5)); renderTruth(); };
    li.querySelectorAll("[data-n]").forEach(b => b.onclick = e => { e.stopPropagation(); tNudge(i, +b.dataset.n); });
    li.querySelectorAll("[data-w]").forEach(b => b.onclick = e => { e.stopPropagation(); tSetWin(i, b.dataset.w); });
    li.querySelectorAll("[data-s]").forEach(b => b.onclick = e => { e.stopPropagation(); S.tsel = i; tSetSpot(m, b.dataset.s); });
    li.querySelector(".note").oninput = e => { m.note = e.target.value; saveTruthSoon(900); };
    li.querySelector(".del").onclick = e => { e.stopPropagation(); tDelete(i); };
    const cf = li.querySelector(".cf"); if (cf) cf.onclick = e => { e.stopPropagation(); m.ok = true; S.tsel = i; tChanged(); };
  });
  const sel = $("#marks li.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}
function enterTruth() {
  $("#finA").value = S.truthFinal?.A ?? ""; $("#finB").value = S.truthFinal?.B ?? "";
  $("#winLegend").innerHTML = `<kbd>A</kbd> ${esc(teamName("A"))} 서브 · <kbd>B</kbd> ${esc(teamName("B"))} 서브 (= 직전 랠리 득점)`;
  renderTeams(); renderTruth(); lastSb = "";
}

/* ---- 영상 위 내 라벨 점수판 ---- */
let lastSb = "";
function drawLabelBoard(t) {
  const box = $("#lsb"); if (!box) return;
  if (S.mode !== "truth") { if (box.innerHTML) { box.innerHTML = ""; lastSb = ""; } return; }
  const ms = tMarks(), cur = ms.reduce((k, m, i) => m.t <= t + .05 ? i : k, -1);
  let a = 0, b = 0, unknown = 0;
  for (let i = 1; i <= cur; i++) { const w = ms[i].server; if (w === "A") a++; else if (w === "B") b++; else unknown++; }
  const m = cur >= 0 ? ms[cur] : null, srv = m?.server || null, last = cur >= 0 && cur === ms.length - 1, f = S.truthFinal;
  const key = [cur, a, b, unknown, srv, m?.win_auto, last && f ? f.A + ":" + f.B : "", teamName("A"), teamName("B")].join("|");
  if (key === lastSb) return; lastSb = key;
  const row = k => `<div class="r ${k}"><i class="bar"></i><span class="nm">${esc(teamName(k))}</span>${srv === k ? '<span class="sv" title="서브">●</span>' : ""}<b class="sc">${k === "A" ? a : b}</b></div>`;
  const sub = cur < 0 ? "첫 서브 전"
    : `${cur + 1} / ${ms.length}번째 서브 · ${srv ? `${esc(teamName(srv))} 서브${m.win_auto ? " (자동·확인 전)" : ""}` : '<span class="q">서브 팀 미입력</span>'}`
      + (unknown ? ` · <span class="q">앞에 미입력 ${unknown}개</span>` : "") + (last && f ? ` · 최종 ${f.A}:${f.B}` : "");
  box.innerHTML = `<div class="hd">내 라벨 점수</div>${row("A")}${row("B")}<div class="ft">${sub}</div>`;
  box.classList.toggle("auto", !!m?.win_auto);
}

function bindTruth() {
  $("#loadAll").onclick = () => tLoadCandidates("all");
  $("#loadOk").onclick = () => tLoadCandidates("ok");
  $("#nextBtn").onclick = tNextPending;
  $("#loadWin").onclick = tLoadWinners;
  $("#nextWin").onclick = tNextAutoWin;
  $("#finBtn").onclick = tFinalize;
  $("#tAdd").onclick = () => {
    const p = $("#tIn").value.trim().split(":").map(Number);
    if (!p.length || p.some(isNaN)) { toast("4:30.5 처럼 분:초로 적어 주세요", true); return; }
    const t = p.reduce((a, b) => a * 60 + b, 0); tAddMark(t); seek(Math.max(0, t - 1.5)); $("#tIn").value = "";
  };
  $("#tIn").addEventListener("keydown", e => { if (e.key === "Enter") $("#tAdd").click(); });
  ["finA", "finB"].forEach(id => {
    $("#" + id).oninput = () => { tReadFinal(); tChanged(); };
    $("#" + id).addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  });
}
// 정답 탭 전용 단축키. 처리했으면 true
function truthKey(e) {
  const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k, sel = tSel(), v = vid();
  if (k === "[" || k === "]") {
    const t = v.currentTime, ms = tMarks(), m = k === "]" ? ms.find(m => m.t > t + 1.6) : [...ms].reverse().find(m => m.t < t - 1.6);
    if (m) { S.tsel = ms.indexOf(m); S.view.t0 = Math.max(0, m.t - 8); seek(Math.max(0, m.t - 1.5)); renderTruth(); }
    return true;
  }
  if (lk === "n" || k === "ㅜ") { tNextPending(); return true; }
  if (!sel) return false;
  if (T_SPOT_KEY[lk]) { tSetSpot(sel, T_SPOT_KEY[lk]); return true; }
  if (k === "Enter") { if (sel.src === "auto") { sel.ok = true; tChanged(); tNextPending(); } return true; }
  if (k === "Delete" || k === "Backspace") { if (tDelete(S.tsel)) tNextPending(); return true; }
  if (k === "-" || k === "=") { tNudge(S.tsel, k === "-" ? -0.1 : 0.1); return true; }
  return false;
}

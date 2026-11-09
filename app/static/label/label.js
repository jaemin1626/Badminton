/* Smash Label — 이미지 서브 라벨 (AI-Hub 변환 데이터). 모든 단계가 묶음 하나를 크게 한 장씩 본다.
   어느 단계든 서브면 서버 선수(1~4·클릭)를 고르고 Enter, 아니면 N. 단계는 보여 줄 묶음만 다름:
   1 서브 확인: AI-Hub 서브(SRV) 묶음 · 2 전체 확인: 모든 묶음 · 3 서버 지정: 서브인데 서버가 안 정해진 것 */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function api(url, opt) {
  const r = await fetch(url, opt && { method: opt.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opt.body) });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); }
  return r.json();
}
let toastT;
function toast(msg, bad) { const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 1600); }
const store = { get(k, d) { try { const v = localStorage.getItem("label:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("label:" + k, JSON.stringify(v)); } catch { } } };

const VIEW_KO = { end: "뒤", diag: "대각선", side: "옆" }, MATCH_KO = { MD: "남자복식", WD: "여자복식", XD: "혼합복식" };
const STATUS_KO = { serve: "서브", not_serve: "서브 아님", unsure: "애매", skip: "건너뜀" };
const ACT_KO = { SRV: "서브", HPN: "헤어핀", PSH: "푸시", DRV: "드라이브", CLR: "클리어", SMS: "스매시", DRP: "드롭", CUT: "컷", UNI: "기타" };
const TRACK_KO = { f1: "먼 쪽 1", f2: "먼 쪽 2", n1: "가까운 쪽 1", n2: "가까운 쪽 2" };
const TCOL = t => `var(--t-${t || "x"}, #c5ccc8)`;
const HINT = {
  serve: "AI-Hub 가 서브라고 한 묶음이에요. 서브하는 선수를 고르고 Enter, 서브가 아니면 N. 점선 = 알고리즘 추천.",
  all: "모든 묶음이에요. 서브 장면이면 서브하는 선수를 고르고 Enter, 아니면 N(또는 Enter). 동작으로 좁혀 보면 빨라요.",
  server: "지금 서브인 묶음이에요. 서브하는 선수를 고르고 Enter. 점선 = 알고리즘 추천.",
};
const KEYS = "<b>1~4</b> 서버 고르기 (f1 f2 n1 n2, 고르면 서브) · <b>R</b> 추천 고르기 · <b>Enter</b> 저장하고 다음<br><b>N</b> 서브 아님 · <b>U</b> 애매 (바로 저장하고 다음)<br><b>A D</b> 또는 <b>← →</b> 이전/다음 묶음 · <b>↑ ↓</b> 장 넘기기 · <b>Space</b> 자동 넘기기 멈춤/재생";
const S = {
  mode: "serve", views: new Set(store.get("views", ["end", "diag"])), matches: new Set(store.get("matches", ["MD", "WD", "XD"])),
  act: store.get("act", ""), todo: store.get("todo", false), play: store.get("play", true),
  clips: [], meta: {}, idx: 0, cur: null, sel: null, fsel: 0, crop: null,
};
const detail = new Map();   // 묶음 상세 캐시 (다음 묶음 미리 받기)

/* ---------------- 목록 ---------------- */
const listQ = todo => new URLSearchParams({ kind: S.mode, views: [...S.views].join(","), match: [...S.matches].join(","),
  action: S.mode === "all" ? S.act : "", todo: todo ? 1 : 0 });
async function load() {
  const r = await api("/api/img/clips?" + listQ(S.todo));
  S.clips = r.clips; S.meta = r;
  if (S.todo) await refreshMeta(); else prog();
}
async function refreshMeta() {
  try { const r = await api("/api/img/clips?" + listQ(false)); S.meta = { ...r, clips: undefined }; prog(); } catch { }
}
function prog() {
  const m = S.meta, f = m.flipped || {};
  let s = S.mode === "server" ? `서버 지정 ${m.checked ?? 0} / ${m.total ?? 0}` : `확인 ${m.checked ?? 0} / ${m.total ?? 0}`;
  s += ` · 바꾼 것 서브→아님 ${f["서브→아님"] || 0} · 아님→서브 ${f["아님→서브"] || 0}`;
  const ag = Object.entries(m.agree || {}).map(([v, a]) => `${VIEW_KO[v] || v} ${Math.round(100 * a.same / a.n)}%(${a.n})`);
  if (S.mode === "server" && ag.length) s += ` · 추천 일치 ${ag.join(" ")}`;
  $("#prog").textContent = s;
}

/* ---------------- 묶음 열기 ---------------- */
const fileUrl = f => `/api/img/file/${f.img.split("/").map(encodeURIComponent).join("/")}`;
async function getDetail(clip) {
  if (!detail.has(clip)) detail.set(clip, api("/api/img/clip/" + encodeURIComponent(clip)).catch(e => { detail.delete(clip); throw e; }));
  return detail.get(clip);
}
function prefetch(i) {
  const c = S.clips[i]; if (!c) return;
  getDetail(c.clip).then(d => d.frames.forEach(f => { new Image().src = fileUrl(f); })).catch(() => { });
}
async function openClip(i) {
  stopPlay();
  if (!S.clips.length) { S.cur = null; render(); saveHash(); return; }
  S.idx = Math.max(0, Math.min(i, S.clips.length - 1));
  const clip = S.clips[S.idx].clip;
  let d;
  try { d = await getDetail(clip); } catch (e) { toast(e.message, true); return; }
  if (S.clips[S.idx]?.clip !== clip) return;   // 그 사이 다른 묶음으로 넘어감
  S.cur = d;
  const lb = d.label || {};
  S.sel = { status: d.status, track: lb.server_track || null, over: {} }; S.dirty = false;
  // 저장된 장별 서버 중 track 과 다른 것 = 장별로 고친 것
  if (lb.servers) for (const f of d.frames) {
    const pid = lb.servers[f.id], p = f.players.find(p => p.pid === pid);
    if (pid && (!p || p.track !== S.sel.track)) S.sel.over[f.id] = pid;
  }
  S.fsel = 0;
  // 확대: 묶음 전체 선수 박스가 들어가는 16:9 영역
  const bx = d.frames.flatMap(f => f.players.map(p => p.bbox)), f0 = d.frames[0];
  if (bx.length && f0) {
    const x1 = Math.min(...bx.map(b => b[0])), y1 = Math.min(...bx.map(b => b[1])), x2 = Math.max(...bx.map(b => b[2])), y2 = Math.max(...bx.map(b => b[3]));
    let w = Math.max((x2 - x1) * 1.25, (y2 - y1) * 1.3 * 16 / 9, 640); w = Math.min(w, f0.w, f0.h * 16 / 9); const h = w * 9 / 16;
    const x0 = Math.max(0, Math.min((x1 + x2) / 2 - w / 2, f0.w - w)), y0 = Math.max(0, Math.min((y1 + y2) / 2 - h / 2 - h * 0.04, f0.h - h));
    S.crop = [x0, y0, w, h].map(v => Math.round(v));
  } else S.crop = null;
  render(); saveHash();
  startPlay();
  prefetch(S.idx + 1); prefetch(S.idx + 2);
}

/* ---------------- 그리기 ---------------- */
function serverPid(f) {
  if (S.sel.over[f.id]) return S.sel.over[f.id];
  return f.players.find(p => p.track && p.track === S.sel.track)?.pid || null;
}
const SKEL = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
function frameSvg(f, k) {
  const W = f.w, H = f.h;
  const vb = $("#zoomChk").checked && S.crop ? S.crop.join(" ") : `0 0 ${W} ${H}`;
  const showKp = $("#boxChk").checked;
  const sug = S.cur.suggest?.track, srv = S.sel.status === "serve" ? serverPid(f) : null;
  let g = `<image href="${fileUrl(f)}" width="${W}" height="${H}"/>`;
  if ($("#linesChk").checked && f.court.lines_px) g += f.court.lines_px.map(l => `<line class="cline" x1="${l[0][0]}" y1="${l[0][1]}" x2="${l[1][0]}" y2="${l[1][1]}"/>`).join("");
  if ($("#linesChk").checked && f.net) g += `<line class="netl" x1="${f.net[0][0]}" y1="${f.net[0][1]}" x2="${f.net[1][0]}" y2="${f.net[1][1]}"/>`;
  for (const p of f.players) {
    const [x1, y1, x2, y2] = p.bbox, col = TCOL(p.track);
    if (showKp && p.kpts) g += SKEL.filter(([a, b]) => p.kpts[a][2] && p.kpts[b][2]).map(([a, b]) => `<line class="skel" stroke="${col}" x1="${p.kpts[a][0]}" y1="${p.kpts[a][1]}" x2="${p.kpts[b][0]}" y2="${p.kpts[b][1]}"/>`).join("");
    if (sug && p.track === sug) g += `<rect class="sug-ring" x="${x1 - 14}" y="${y1 - 14}" width="${x2 - x1 + 28}" height="${y2 - y1 + 28}" rx="10"/>`;
    const isS = srv === p.pid, over = isS && S.sel.over[f.id];
    g += `<rect class="pbox ${isS ? "server" : ""} ${over ? "override" : ""}" data-pid="${p.pid}" stroke="${col}" x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"><title>${TRACK_KO[p.track] || p.pid}</title></rect>`;
    g += `<text class="ptag" fill="${col}" x="${x1}" y="${y1 - 8}">${esc(p.track || p.pid)}${isS ? " ★" : ""}</text>`;
  }
  const warn = f.checks?.length ? `<span class="fwarn">${esc(f.checks.join(" · "))}</span>` : (f.players.some(p => !p.track) ? `<span class="fwarn">선수 잇기 실패</span>` : "");
  return `<div class="fr" data-k="${k}"><svg viewBox="${vb}">${g}</svg><span class="flabel">${k + 1} / ${S.cur.frames.length}장 · 프레임 ${f.frame}</span>${warn}</div>`;
}
function render() {
  const c = S.cur;
  $("#cPos").textContent = S.clips.length ? `${S.idx + 1} / ${S.clips.length}` : "0";
  if (!c) {
    $("#stage").className = "stage";
    $("#stage").innerHTML = `<p class="empty">${S.todo ? "남은 묶음이 없어요 👍" : "조건에 맞는 묶음이 없어요"}</p>`;
    $("#strip").innerHTML = ""; $("#cAct").textContent = ""; $("#cId").textContent = ""; $("#cMeta").textContent = "";
    $("#srvBtns").innerHTML = ""; $("#sugg").textContent = ""; $("#cWarn").classList.add("hidden");
    return;
  }
  const st = S.sel.status, code = c.action.split("-")[0];
  $("#stage").className = "stage " + st;
  $("#stage").innerHTML = c.frames.map(frameSvg).join("") + `<span class="verdict ${st}">${STATUS_KO[st]}${st === "serve" ? (S.sel.track ? " · 서버 " + S.sel.track : " · 서버를 고르세요") : ""}</span>`;
  $("#strip").innerHTML = c.frames.map((f, k) => `<button data-k="${k}" title="${k + 1}장"><img alt="" src="/api/img/thumb/${encodeURIComponent(f.id)}"><span>${k + 1}</span></button>`).join("");
  $$("#strip button").forEach(b => b.onclick = () => { stopPlay(); showFrame(+b.dataset.k); });
  $("#cAct").innerHTML = `${esc(c.action)}<small>${ACT_KO[code] || ""}${c.code_serve ? "" : " · AI-Hub 는 서브 아님"}</small>`;
  $("#cMeta").textContent = `${VIEW_KO[c.view] || "?"} (${c.frames[0]?.court.yaw ?? "?"}°) · 카메라 ${c.cam} · ${MATCH_KO[c.match] || c.match} · ${c.frames.length}장`;
  $("#cId").textContent = c.clip;
  const bad = c.frames.flatMap(f => f.checks || []);
  $("#cWarn").textContent = bad.length ? "주의: " + [...new Set(bad)].join(" · ") : "";
  $("#cWarn").classList.toggle("hidden", !bad.length);

  {
    const lb = c.label;
    $("#sState").textContent = lb?.server_track ? `저장됨 · 서버 ${lb.server_track}` : lb?.status ? `저장됨 · ${STATUS_KO[lb.status]}` : `AI-Hub · ${STATUS_KO[c.status]}`;
    const sg = c.suggest;
    $("#sugg").innerHTML = sg ? `추천 <b style="color:${TCOL(sg.track)}">${esc(sg.track)}</b> (${TRACK_KO[sg.track] || ""}) · 확신 ${Math.round(sg.conf * 100)}%${sg.conf < 0.3 ? " · <span class='warn'>낮음</span>" : ""}` : "추천 없음 (한쪽 선수 위치를 모름)";
    $("#srvBtns").innerHTML = c.tracks.map((t, i) => `<button data-t="${t}" class="${st === "serve" && S.sel.track === t ? "on" : ""}" style="color:${TCOL(t)}"><b>${i + 1}</b>${esc(t)} <span style="color:var(--muted)">${TRACK_KO[t] || ""}</span>${sg?.track === t ? `<span class="sg">추천</span>` : ""}</button>`).join("");
    $("#bNot").className = "btn" + (st === "not_serve" ? " on-not" : "");
    $("#bUnsure").className = "btn" + (st === "unsure" ? " on-uns" : "");
    $$("#srvBtns button").forEach(b => b.onclick = () => pickTrack(b.dataset.t));
    $$("#stage .pbox").forEach(r => r.onclick = e => {
      const f = c.frames[+r.closest(".fr").dataset.k], p = f.players.find(p => p.pid === r.dataset.pid);
      if (e.shiftKey) { S.sel.status = "serve"; if (S.sel.over[f.id] === p.pid) delete S.sel.over[f.id]; else S.sel.over[f.id] = p.pid; S.dirty = true; render(); }
      else if (p.track) pickTrack(p.track);
      else { S.sel.status = "serve"; S.sel.over[f.id] = p.pid; S.dirty = true; render(); }
    });
  }
  showFrame(S.fsel);
}
function showFrame(k) {
  const n = S.cur?.frames.length || 0; if (!n) return;
  S.fsel = ((k % n) + n) % n;
  $$("#stage .fr").forEach(el => el.classList.toggle("on", +el.dataset.k === S.fsel));
  $$("#strip button").forEach(el => el.classList.toggle("on", +el.dataset.k === S.fsel));
  drawMini();
}
function pickTrack(t) { S.sel.status = "serve"; S.sel.track = t; S.dirty = true; render(); }
/* 묶음 이동 (A D ← → · 버튼): 서버를 골라 놓고 Enter 없이 넘어가도 저장하고 넘어감 */
function go(step) {
  if (S.dirty && S.cur && S.sel.status === "serve" && (S.sel.track || Object.keys(S.sel.over).length)) return saveSrv(null, step);
  openClip(S.idx + step);
}
function drawMini() {
  const c = S.cur; if (!c) return;
  const f = c.frames[S.fsel] || c.frames[0], W = 6.1, L = 13.4, s = 0.46, ss = 1.98, ls = 0.76, N = L / 2;
  const ln = [[0, 0, W, 0], [0, L, W, L], [0, 0, 0, L], [W, 0, W, L], [s, 0, s, L], [W - s, 0, W - s, L], [0, N - ss, W, N - ss], [0, N + ss, W, N + ss],
    [0, ls, W, ls], [0, L - ls, W, L - ls], [W / 2, 0, W / 2, N - ss], [W / 2, N + ss, W / 2, L]];
  let g = ln.map(l => `<line x1="${l[0]}" y1="${l[1]}" x2="${l[2]}" y2="${l[3]}" stroke="#fff" stroke-width=".05" opacity=".8"/>`).join("");
  g += `<line x1="-.3" y1="${N}" x2="${W + .3}" y2="${N}" stroke="#ff7ad9" stroke-width=".12"/>`;
  const srv = S.sel.status === "serve" ? serverPid(f) : null;
  for (const p of f.players) {
    if (!p.court_pos) continue;
    const [x, y] = p.court_pos, col = TCOL(p.track);
    if (srv === p.pid) g += `<circle cx="${x}" cy="${y}" r=".62" fill="none" stroke="${col}" stroke-width=".12"/>`;
    if (c.suggest?.track === p.track) g += `<circle cx="${x}" cy="${y}" r=".85" fill="none" stroke="#fff" stroke-width=".06" stroke-dasharray=".2 .2"/>`;
    g += `<circle cx="${x}" cy="${y}" r=".36" fill="${col}"/><text x="${x + .5}" y="${y + .25}" font-size=".75" fill="#fff" font-weight="700">${esc(p.track || p.pid)}</text>`;
  }
  $("#mini").innerHTML = g;
  $("#mapTag").textContent = `${S.fsel + 1}장`;
}

/* 장 자동 넘기기 */
let playT = null;
function startPlay() {
  stopPlay(); $("#bPlay").textContent = S.play ? "❚❚" : "▶";
  if (S.play && S.cur?.frames.length > 1) playT = setInterval(() => showFrame(S.fsel + 1), 700);
}
function stopPlay() { clearInterval(playT); playT = null; }
function togglePlay() { S.play = !S.play; store.set("play", S.play); startPlay(); }

/* ---------------- 저장 ---------------- */
async function afterSave(st, rec, step = 1) {
  const e = S.clips[S.idx];
  if (e) { e.status = st; e.src = "human"; e.server_track = rec.server_track; }
  detail.delete(e?.clip);
  refreshMeta();
  S.dirty = false;
  if (S.todo) { S.clips.splice(S.idx, 1); openClip(step > 0 ? S.idx : S.idx - 1); } else openClip(S.idx + step);
}
async function saveSrv(status, step = 1) {
  const c = S.cur; if (!c) return;
  const st = status || S.sel.status || "serve";
  const body = { clip: c.clip, status: st };
  if (st === "serve") {
    const servers = {};
    for (const f of c.frames) { const p = serverPid(f); if (p) servers[f.id] = p; }
    if (!S.sel.track && !Object.keys(servers).length) { toast("서버를 골라 주세요 (1~4 또는 선수 클릭)", true); return; }
    body.server_track = S.sel.track; body.servers = servers;
  }
  try {
    const rec = await api("/api/img/label", { body });
    toast(st === "serve" ? `서버 ${rec.server_track || "장별"} 저장` : `${STATUS_KO[st]}로 저장`);
    afterSave(st, rec, step);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- 모드 · 필터 · 주소 ---------------- */
function saveHash() { history.replaceState(null, "", "#" + `img/${S.mode}` + (S.cur ? `/${S.cur.clip}` : "")); }
async function setMode(m, at) {
  S.mode = m; document.body.dataset.mode = m;
  const srvMode = m === "server";
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#fActWrap").classList.toggle("hidden", m !== "all");
  $("#fTodoLab").textContent = srvMode ? "서버 아직 안 고른 것만" : "아직 확인 안 한 것만";
  $("#modeHint").textContent = HINT[m];
  $("#keysTxt").innerHTML = KEYS;
  detail.clear();
  await load();
  const i = at ? S.clips.findIndex(c => c.clip === at) : -1;
  await openClip(i >= 0 ? i : 0);
}
function bindFilters() {
  const chips = (sel, set, key) => $$(sel + " button").forEach(b => {
    b.classList.toggle("on", set.has(b.dataset.v));
    b.onclick = () => { set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v); b.classList.toggle("on"); store.set(key, [...set]); setMode(S.mode); };
  });
  chips("#fView", S.views, "views"); chips("#fMatch", S.matches, "matches");
  $("#fAct").value = S.act; $("#fAct").onchange = e => { S.act = e.target.value; store.set("act", S.act); setMode(S.mode); };
  $("#fTodo").checked = S.todo; $("#fTodo").onchange = e => { S.todo = e.target.checked; store.set("todo", S.todo); setMode(S.mode); };
}
function bindKeys() {
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();   // 한글 입력 상태에서도 같은 자판
    if (e.key === "ArrowRight" || k === "d") { e.preventDefault(); go(1); return; }
    if (e.key === "ArrowLeft" || k === "a") { e.preventDefault(); go(-1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); stopPlay(); showFrame(S.fsel + 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); stopPlay(); showFrame(S.fsel - 1); return; }
    if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
    if (!S.cur) return;
    if (/^[1-4]$/.test(e.key) && S.cur.tracks[+e.key - 1]) pickTrack(S.cur.tracks[+e.key - 1]);
    else if (k === "r" && S.cur.suggest?.track) pickTrack(S.cur.suggest.track);
    else if (e.key === "Enter") { e.preventDefault(); saveSrv(); }
    else if (k === "n") saveSrv("not_serve");
    else if (k === "u") saveSrv("unsure");
  });
}
function boot() {
  $("#toVideo").href = "/lab#" + (store.get("vid", "") || "") + "/truth";
  $$(".tabs button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $("#bNot").onclick = () => saveSrv("not_serve"); $("#bUnsure").onclick = () => saveSrv("unsure"); $("#bSave").onclick = () => saveSrv();
  $("#bPrev").onclick = () => go(-1); $("#bNext").onclick = () => go(1);
  $("#bPlay").onclick = togglePlay;
  $("#zoomChk").checked = store.get("zoom", true);
  $("#boxChk").checked = store.get("box", false);
  $("#linesChk").checked = store.get("lines", false);
  $("#zoomChk").onchange = e => { store.set("zoom", e.target.checked); render(); };
  $("#boxChk").onchange = e => { store.set("box", e.target.checked); render(); };
  $("#linesChk").onchange = e => { store.set("lines", e.target.checked); render(); };
  bindFilters(); bindKeys();
  const [, mode, at] = decodeURIComponent(location.hash.slice(1)).split("/");
  setMode(["serve", "all", "server"].includes(mode) ? mode : "serve", at).catch(e => toast(e.message, true));
}
boot();

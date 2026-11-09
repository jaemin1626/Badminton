/* Smash Label — 이미지 서브 라벨 (AI-Hub 변환 데이터).
   1 서브 확인: AI-Hub 서브(SRV) 묶음 격자, 서브 아닌 것을 눌러 뺌
   2 전체 확인: 모든 묶음 격자, 서브인데 아니라고 된 것을 눌러 바꿈
   3 서버 지정: 지금 서브인 묶음을 크게 보고 서버 선수를 누름 */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function api(url, opt) {
  const r = await fetch(url, opt && { method: opt.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opt.body) });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); }
  return r.json();
}
let toastT;
function toast(msg, bad) { const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 2200); }
const store = { get(k, d) { try { const v = localStorage.getItem("label:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("label:" + k, JSON.stringify(v)); } catch { } } };

const VIEW_KO = { end: "뒤", diag: "대각선", side: "옆" }, MATCH_KO = { MD: "남복", WD: "여복", XD: "혼복" };
const STATUS_KO = { serve: "서브", not_serve: "서브 아님", unsure: "애매", skip: "건너뜀" };
const TRACK_KO = { f1: "먼 쪽 1", f2: "먼 쪽 2", n1: "가까운 쪽 1", n2: "가까운 쪽 2" };
const TCOL = t => `var(--t-${t || "x"}, #c5ccc8)`;
const HINT = {
  serve: "AI-Hub 가 서브라고 한 묶음이에요. 서브가 아닌 카드만 눌러 빼고, 이 페이지 확인을 누르세요.",
  all: "모든 묶음이에요. 서브 장면인데 '서브 아님'으로 된 카드를 눌러 서브로 바꾸세요. 동작으로 좁혀 보면 빨라요.",
  server: "서브하는 선수를 고르세요. 점선 테두리 = 알고리즘 추천.",
};
const PER = 24;
const S = {
  mode: "serve", views: new Set(store.get("views", ["end", "diag"])), matches: new Set(store.get("matches", ["MD", "WD", "XD"])),
  act: store.get("act", ""), todo: store.get("todo", false),
  clips: [], meta: {}, page: 0, idx: 0, cur: null, sel: null, fsel: 0,
};

/* ---------------- 목록 ---------------- */
async function load(keep) {
  const q = new URLSearchParams({ kind: S.mode, views: [...S.views].join(","), match: [...S.matches].join(","),
    action: S.mode === "all" ? S.act : "", todo: S.todo ? 1 : 0 });
  const r = await api("/api/img/clips?" + q);
  S.clips = r.clips; S.meta = r;
  if (!keep) { S.page = 0; S.idx = 0; }
  S.page = Math.min(S.page, Math.max(0, Math.ceil(S.clips.length / PER) - 1));
  S.idx = Math.min(S.idx, Math.max(0, S.clips.length - 1));
  prog();
}
function prog() {
  const m = S.meta, f = m.flipped || {};
  let s = S.mode === "server" ? `서버 지정 ${m.checked ?? 0} / ${m.total ?? 0}` : `확인 ${m.checked ?? 0} / ${m.total ?? 0}`;
  s += ` · 바꾼 것 서브→아님 ${f["서브→아님"] || 0} · 아님→서브 ${f["아님→서브"] || 0}`;
  const ag = Object.entries(m.agree || {}).map(([v, a]) => `${VIEW_KO[v] || v} ${Math.round(100 * a.same / a.n)}%(${a.n})`);
  if (S.mode === "server" && ag.length) s += ` · 추천 일치 ${ag.join(" ")}`;
  $("#prog").textContent = s;
}

/* ---------------- 1·2 격자 ---------------- */
function cardHtml(c) {
  const ids = c.ids.slice(0, 4), n = ids.length;
  const chg = c.src === "human" && ((c.status === "serve") !== c.code_serve) && c.status !== "unsure";
  return `<article class="card ${c.status}" tabindex="0" data-clip="${esc(c.clip)}" title="${esc(c.clip)}">
    <div class="thumbs ${n === 1 ? "n1" : ""}">${ids.map(id => `<img loading="lazy" alt="" src="/api/img/thumb/${encodeURIComponent(id)}">`).join("")}</div>
    <div class="cfoot"><span class="act">${esc(c.action)}</span><span>${VIEW_KO[c.view] || "?"} · ${esc(c.cam)} · ${MATCH_KO[c.match] || c.match}</span>
      ${chg ? `<span class="chg">바꿈</span>` : ""}${c.src === "human" ? `<span class="mine" title="확인함"></span>` : ""}
      <span class="badge ${c.status}">${STATUS_KO[c.status]}</span></div></article>`;
}
function renderGrid() {
  const n = S.clips.length, pages = Math.max(1, Math.ceil(n / PER));
  const sl = S.clips.slice(S.page * PER, S.page * PER + PER);
  $("#grid").innerHTML = sl.map(cardHtml).join("") || `<p class="empty">${S.todo ? "남은 묶음이 없어요 👍" : "조건에 맞는 묶음이 없어요"}</p>`;
  $("#pNum").textContent = `${S.page + 1} / ${pages} 페이지 · ${n.toLocaleString()}개`;
  $("#pPrev").disabled = S.page === 0; $("#pNext").disabled = S.page >= pages - 1;
  let clickT;
  $$("#grid .card").forEach(el => {
    el.onclick = () => { clearTimeout(clickT); clickT = setTimeout(() => toggle(el.dataset.clip), 230); };
    el.ondblclick = () => { clearTimeout(clickT); openLB(el.dataset.clip); };
    el.onkeydown = e => { if (e.key === " ") { e.preventDefault(); toggle(el.dataset.clip); } };
  });
  saveHash();
}
const byClip = clip => S.clips.find(c => c.clip === clip);
async function setStatus(clip, status) {
  const c = byClip(clip);
  try {
    await api("/api/img/label", { body: { clip, status } });
    if (c) { c.status = status; c.src = "human"; }
    renderGrid();
    refreshMeta();
  } catch (e) { toast(e.message, true); }
}
const toggle = clip => { const c = byClip(clip); if (c) setStatus(clip, c.status === "serve" ? "not_serve" : "serve"); };
async function refreshMeta() {
  const q = new URLSearchParams({ kind: S.mode, views: [...S.views].join(","), match: [...S.matches].join(","), action: S.mode === "all" ? S.act : "", todo: 0 });
  try { const r = await api("/api/img/clips?" + q); S.meta = { ...r, clips: undefined }; if (S.todo) S.meta.total = r.total; prog(); } catch { }
}
async function confirmPage() {
  const sl = S.clips.slice(S.page * PER, S.page * PER + PER).filter(c => c.src !== "human");
  try {
    if (sl.length) await api("/api/img/labels", { body: { items: sl.map(c => ({ clip: c.clip, status: c.status })) } });
    toast(sl.length ? `${sl.length}개 확인했어요` : "이 페이지는 이미 다 확인했어요");
    if (S.todo) await load(true); else { sl.forEach(c => c.src = "human"); S.page = Math.min(S.page + 1, Math.ceil(S.clips.length / PER) - 1); await refreshMeta(); }
    renderGrid(); window.scrollTo(0, 0);
  } catch (e) { toast(e.message, true); }
}

/* 크게 보기 */
let lbClip = null;
async function openLB(clip) {
  lbClip = clip;
  const d = await api("/api/img/clip/" + encodeURIComponent(clip));
  $("#lbTitle").textContent = `${clip} · ${d.action} · ${VIEW_KO[d.view] || "?"} · 지금 ${STATUS_KO[byClip(clip)?.status || d.status]}`;
  $("#lbGrid").innerHTML = d.frames.map(f => `<img alt="" src="/api/img/file/${f.img.split("/").map(encodeURIComponent).join("/")}?w=960">`).join("");
  $("#lb").classList.remove("hidden");
}
const closeLB = () => { $("#lb").classList.add("hidden"); lbClip = null; };

/* ---------------- 3 서버 지정 ---------------- */
async function openClip(i) {
  if (!S.clips.length) { S.cur = null; renderSrv(); return; }
  S.idx = Math.max(0, Math.min(i, S.clips.length - 1));
  const clip = S.clips[S.idx].clip;
  try { S.cur = await api("/api/img/clip/" + encodeURIComponent(clip)); } catch (e) { toast(e.message, true); return; }
  const lb = S.cur.label || {};
  S.sel = { status: S.cur.status === "serve" ? "serve" : S.cur.status, track: lb.server_track || null, over: {} };
  // 저장된 장별 서버 중 track 과 다른 것 = 장별로 고친 것
  if (lb.servers) for (const f of S.cur.frames) {
    const pid = lb.servers[f.id], p = f.players.find(p => p.pid === pid);
    if (pid && (!p || p.track !== S.sel.track)) S.sel.over[f.id] = pid;
  }
  S.fsel = 0;
  // 확대: 묶음 전체 선수 박스가 들어가는 16:9 영역
  const bx = S.cur.frames.flatMap(f => f.players.map(p => p.bbox));
  const f0 = S.cur.frames[0];
  if (bx.length && f0) {
    const x1 = Math.min(...bx.map(b => b[0])), y1 = Math.min(...bx.map(b => b[1])), x2 = Math.max(...bx.map(b => b[2])), y2 = Math.max(...bx.map(b => b[3]));
    let w = Math.max((x2 - x1) * 1.3, (y2 - y1) * 1.35 * 16 / 9, 640); w = Math.min(w, f0.w, f0.h * 16 / 9); const h = w * 9 / 16;
    const x0 = Math.max(0, Math.min((x1 + x2) / 2 - w / 2, f0.w - w)), y0 = Math.max(0, Math.min((y1 + y2) / 2 - h / 2 - h * 0.04, f0.h - h));
    S.crop = [x0, y0, w, h].map(v => Math.round(v));
  } else S.crop = null;
  renderSrv(); saveHash();
}
function serverPid(f) {
  if (S.sel.over[f.id]) return S.sel.over[f.id];
  return f.players.find(p => p.track && p.track === S.sel.track)?.pid || null;
}
const SKEL = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
function frameSvg(f, k) {
  const W = f.w, H = f.h, src = `/api/img/file/${f.img.split("/").map(encodeURIComponent).join("/")}`;
  const vb = $("#zoomChk").checked && S.crop ? S.crop.join(" ") : `0 0 ${W} ${H}`;
  const sug = S.cur.suggest?.track, srv = S.sel.status === "serve" ? serverPid(f) : null;
  let g = `<image href="${src}" width="${W}" height="${H}"/>`;
  if ($("#linesChk").checked && f.court.lines_px) g += f.court.lines_px.map(l => `<line class="cline" x1="${l[0][0]}" y1="${l[0][1]}" x2="${l[1][0]}" y2="${l[1][1]}"/>`).join("");
  if ($("#linesChk").checked && f.net) g += `<line class="netl" x1="${f.net[0][0]}" y1="${f.net[0][1]}" x2="${f.net[1][0]}" y2="${f.net[1][1]}"/>`;
  for (const u of f.umpires) g += `<rect x="${u[0]}" y="${u[1]}" width="${u[2] - u[0]}" height="${u[3] - u[1]}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2"/>`;
  for (const p of f.players) {
    const [x1, y1, x2, y2] = p.bbox, col = TCOL(p.track);
    if ($("#kpChk").checked && p.kpts) g += SKEL.filter(([a, b]) => p.kpts[a][2] && p.kpts[b][2]).map(([a, b]) => `<line class="skel" stroke="${col}" x1="${p.kpts[a][0]}" y1="${p.kpts[a][1]}" x2="${p.kpts[b][0]}" y2="${p.kpts[b][1]}"/>`).join("");
    if (sug && p.track === sug) g += `<rect class="sug-ring" x="${x1 - 14}" y="${y1 - 14}" width="${x2 - x1 + 28}" height="${y2 - y1 + 28}" rx="10"/>`;
    const isS = srv === p.pid, over = isS && S.sel.over[f.id];
    g += `<rect class="pbox ${isS ? "server" : ""} ${over ? "override" : ""}" data-pid="${p.pid}" stroke="${col}" x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"><title>${TRACK_KO[p.track] || p.pid}</title></rect>`;
    g += `<text class="ptag" fill="${col}" x="${x1}" y="${y1 - 8}">${esc(p.track || p.pid)}${isS ? " ★" : ""}</text>`;
  }
  const warn = f.checks?.length ? `<span class="fwarn">${esc(f.checks.join(" · "))}</span>` : (f.players.some(p => !p.track) ? `<span class="fwarn">선수 잇기 실패</span>` : "");
  return `<div class="fr ${k === S.fsel ? "sel" : ""}" data-k="${k}"><svg viewBox="${vb}">${g}</svg><span class="flabel">${k + 1}장 · 프레임 ${f.frame}</span>${warn}</div>`;
}
function renderSrv() {
  const c = S.cur;
  $("#cPos").textContent = S.clips.length ? `${S.idx + 1} / ${S.clips.length}` : "0";
  if (!c) { $("#frames").innerHTML = `<p class="empty">${S.todo ? "서버를 지정할 묶음이 다 끝났어요 👍" : "조건에 맞는 서브 묶음이 없어요"}</p>`; $("#cId").textContent = ""; $("#cMeta").textContent = ""; $("#srvBtns").innerHTML = ""; $("#sugg").textContent = ""; return; }
  $("#frames").className = "frames" + (c.frames.length === 1 ? " n1" : "");
  $("#frames").innerHTML = c.frames.map(frameSvg).join("");
  $("#cId").textContent = c.clip;
  $("#cMeta").textContent = `${c.action} · ${VIEW_KO[c.view] || "?"} (${c.frames[0]?.court.yaw ?? "?"}°) · ${c.cam} · ${MATCH_KO[c.match] || c.match} · ${c.frames.length}장${c.code_serve ? "" : " · AI-Hub 코드는 서브 아님"}`;
  const lb = c.label;
  $("#sState").textContent = lb?.server_track ? `저장됨 · ${lb.server_track}` : lb?.status && lb.status !== "serve" ? `저장됨 · ${STATUS_KO[lb.status]}` : "미지정";
  const sg = c.suggest;
  $("#sugg").innerHTML = sg ? `추천 <b style="color:${TCOL(sg.track)}">${esc(sg.track)}</b> (${TRACK_KO[sg.track] || ""}) · 확신 ${Math.round(sg.conf * 100)}%${sg.conf < 0.3 ? " · <span class='warn'>낮음</span>" : ""}` : "추천 없음 (한쪽 선수 위치를 모름)";
  $("#srvBtns").innerHTML = c.tracks.map((t, i) => `<button data-t="${t}" class="${S.sel.status === "serve" && S.sel.track === t ? "on" : ""}" style="color:${TCOL(t)}"><b>${i + 1}</b>${esc(t)} <span style="color:var(--muted)">${TRACK_KO[t] || ""}</span>${sg?.track === t ? `<span class="sg">추천</span>` : ""}</button>`).join("");
  $("#bNot").className = "btn" + (S.sel.status === "not_serve" ? " on-not" : "");
  $("#bUnsure").className = "btn" + (S.sel.status === "unsure" ? " on-uns" : "");
  const bad = c.frames.flatMap(f => f.checks || []);
  $("#cWarn").textContent = bad.length ? "주의: " + [...new Set(bad)].join(" · ") : "";
  $("#cWarn").classList.toggle("hidden", !bad.length);
  $$("#srvBtns button").forEach(b => b.onclick = () => pickTrack(b.dataset.t));
  $$("#frames .fr").forEach(el => {
    el.onmouseenter = () => { S.fsel = +el.dataset.k; $$("#frames .fr").forEach(x => x.classList.toggle("sel", x === el)); drawMini(); };
  });
  $$("#frames .pbox").forEach(r => r.onclick = e => {
    const f = c.frames[+r.closest(".fr").dataset.k], p = f.players.find(p => p.pid === r.dataset.pid);
    if (e.shiftKey) { S.sel.status = "serve"; if (S.sel.over[f.id] === p.pid) delete S.sel.over[f.id]; else S.sel.over[f.id] = p.pid; renderSrv(); }
    else if (p.track) pickTrack(p.track);
    else { S.sel.status = "serve"; S.sel.over[f.id] = p.pid; renderSrv(); }
  });
  drawMini();
}
function pickTrack(t) { S.sel.status = "serve"; S.sel.track = t; renderSrv(); }
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
async function saveSrv(status) {
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
    const e = S.clips[S.idx]; if (e) { e.status = st; e.src = "human"; e.server_track = rec.server_track; }
    toast(st === "serve" ? `서버 ${rec.server_track || "장별"} 저장` : `${STATUS_KO[st]}로 저장`);
    await refreshMeta();
    if (S.todo) { S.clips.splice(S.idx, 1); openClip(S.idx); } else openClip(S.idx + 1);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- 모드 · 필터 · 주소 ---------------- */
function saveHash() {
  const h = S.mode === "server" && S.cur ? `img/server/${S.cur.clip}` : `img/${S.mode}/${S.page + 1}`;
  history.replaceState(null, "", "#" + h);
}
async function setMode(m, at) {
  S.mode = m; document.body.dataset.mode = m;
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#gridView").classList.toggle("hidden", m === "server");
  $("#srvView").classList.toggle("hidden", m !== "server");
  $("#fActWrap").classList.toggle("hidden", m !== "all");
  $("#fTodoLab").textContent = m === "server" ? "서버 아직 안 고른 것만" : "아직 확인 안 한 것만";
  $("#modeHint").textContent = HINT[m];
  await load();
  if (m === "server") {
    const i = at ? S.clips.findIndex(c => c.clip === at) : -1;
    await openClip(i >= 0 ? i : 0);
  } else {
    if (at && !isNaN(+at)) S.page = Math.max(0, Math.min(+at - 1, Math.ceil(S.clips.length / PER) - 1));
    renderGrid();
  }
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
    if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("#lb").classList.contains("hidden")) { if (e.key === "Escape") closeLB(); return; }
    if (S.mode !== "server") {
      if (e.key === "Enter") { e.preventDefault(); confirmPage(); }
      else if (e.key === "ArrowRight" && !$("#pNext").disabled) { S.page++; renderGrid(); window.scrollTo(0, 0); }
      else if (e.key === "ArrowLeft" && S.page > 0) { S.page--; renderGrid(); window.scrollTo(0, 0); }
      return;
    }
    if (!S.cur) return;
    const k = e.key.toLowerCase();
    if (/^[1-4]$/.test(e.key) && S.cur.tracks[+e.key - 1]) pickTrack(S.cur.tracks[+e.key - 1]);
    else if (k === "a" && S.cur.suggest?.track) pickTrack(S.cur.suggest.track);
    else if (e.key === "Enter") { e.preventDefault(); saveSrv(); }
    else if (k === "n") saveSrv("not_serve");
    else if (k === "u") saveSrv("unsure");
    else if (e.key === "ArrowRight") openClip(S.idx + 1);
    else if (e.key === "ArrowLeft") openClip(S.idx - 1);
  });
}
function boot() {
  $("#toVideo").href = "/lab#" + (store.get("vid", "") || "") + "/truth";
  $$(".tabs button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $("#pPrev").onclick = () => { S.page--; renderGrid(); window.scrollTo(0, 0); };
  $("#pNext").onclick = () => { S.page++; renderGrid(); window.scrollTo(0, 0); };
  $("#pConfirm").onclick = confirmPage;
  $("#lbClose").onclick = closeLB; $("#lb").onclick = e => { if (e.target.id === "lb") closeLB(); };
  $("#lbServe").onclick = () => { const c = lbClip; closeLB(); setStatus(c, "serve"); };
  $("#lbNot").onclick = () => { const c = lbClip; closeLB(); setStatus(c, "not_serve"); };
  $("#bNot").onclick = () => saveSrv("not_serve"); $("#bUnsure").onclick = () => saveSrv("unsure");
  $("#bSave").onclick = () => saveSrv(); $("#bPrev").onclick = () => openClip(S.idx - 1); $("#bNext").onclick = () => openClip(S.idx + 1);
  $("#zoomChk").checked = store.get("zoom", true);
  $("#linesChk").onchange = $("#kpChk").onchange = () => renderSrv();
  $("#zoomChk").onchange = e => { store.set("zoom", e.target.checked); renderSrv(); };
  bindFilters(); bindKeys();
  const [, mode, at] = decodeURIComponent(location.hash.slice(1)).split("/");
  setMode(["serve", "all", "server"].includes(mode) ? mode : "serve", at).catch(e => toast(e.message, true));
}
boot();

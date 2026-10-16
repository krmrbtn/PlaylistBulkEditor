// PlaylistBulkEditor dashboard. State is per playlist (tabs); data lives in
// chrome.storage.local.playlists = { [playlistId]: { id, title, items, scannedAt, removedLog } }.

const COLS = [
  { key: "position", label: "#", num: true },
  { key: "title", label: "Title" },
  { key: "channel", label: "Channel" },
  { key: "durationSec", label: "Duration", num: true },
  { key: "watchedPct", label: "Watched", num: true },
  { key: "publishedApprox", label: "Uploaded (≈)" },
];

let playlists = {};
let activeId = null;
let pendingActive = null; // playlist just added, to focus once its scan lands
let items = [];
let removed = [];
let sortKey = "position";
let sortDir = 1;
let pending = null; // { kind: "first5" | "selected" | "unav", ids: string[] }
let showDeleted = false;
const uiState = {}; // per-playlist filters / selection / sort

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plTitle = () => playlists[activeId]?.title || "this playlist";
const fileSlug = () => plTitle().replace(/[\\/:*?"<>|]+/g, "_").trim() || "playlist";

function fmtDur(s) {
  if (s == null) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

// ---------- per-playlist UI state ----------

const selChannels = new Set(); // selected channel names ("" = no channel)
const selected = new Set(); // ticked rows (setVideoId)
const FIELD_IDS = ["q", "upFrom", "upTo", "dMin", "dMax", "wMin", "wMax", "statusSel", "chSearch"];

function saveUi(id) {
  if (!id) return;
  const fields = {};
  for (const f of FIELD_IDS) fields[f] = $(f).value;
  uiState[id] = { fields, selChannels: [...selChannels], selected: [...selected], sortKey, sortDir };
}

function restoreUi(id) {
  const s = id ? uiState[id] : null;
  for (const f of FIELD_IDS) $(f).value = s ? s.fields[f] : f === "statusSel" ? "all" : "";
  selChannels.clear();
  selected.clear();
  if (s) {
    s.selChannels.forEach((c) => selChannels.add(c));
    s.selected.forEach((x) => selected.add(x));
  }
  sortKey = s ? s.sortKey : "position";
  sortDir = s ? s.sortDir : 1;
  showDeleted = false;
  applyDeletedView();
}

function syncPlaylistData() {
  const pl = playlists[activeId];
  items = pl?.items || [];
  removed = pl?.removedLog || [];
}

function setActive(id) {
  if (id === activeId) return;
  saveUi(activeId);
  activeId = id;
  cancelConfirm();
  closePanels();
  restoreUi(id);
  chrome.storage.local.set({ activePlaylistId: id });
  syncPlaylistData();
  render();
}

// ---------- filtering ----------

// Filters active -> everything shown is ticked; no filters -> nothing ticked.
function applyAutoSelection() {
  selected.clear();
  if (activeFilterCount() > 0) for (const v of filtered()) if (v.setVideoId) selected.add(v.setVideoId);
}

function updateSelectionUi(rows) {
  const n = rows.filter((r) => selected.has(r.setVideoId)).length;
  const all = $("selAll");
  if (all) {
    all.checked = rows.length > 0 && n === rows.length;
    all.indeterminate = n > 0 && n < rows.length;
  }
  $("rmall").textContent = `Remove selected (${n})`;
}

const numOrNull = (id) => {
  const v = $(id).value.trim();
  return v === "" || isNaN(Number(v)) ? null : Number(v);
};

function readFilters() {
  return {
    q: $("q").value.trim().toLowerCase(),
    upFrom: $("upFrom").value, // YYYY-MM-DD
    upTo: $("upTo").value,
    dMin: numOrNull("dMin"),
    dMax: numOrNull("dMax"),
    wMin: numOrNull("wMin"),
    wMax: numOrNull("wMax"),
    status: $("statusSel").value,
  };
}

function matches(v, f) {
  if (f.q && !v.title.toLowerCase().includes(f.q)) return false;
  if (selChannels.size && !selChannels.has(v.channel || "")) return false;
  if (f.upFrom || f.upTo) {
    if (!v.publishedApprox) return false; // unknown date can't match a date filter
    if (f.upFrom && v.publishedApprox < f.upFrom) return false;
    if (f.upTo && v.publishedApprox > f.upTo) return false;
  }
  if (f.dMin !== null || f.dMax !== null) {
    if (v.durationSec == null) return false;
    const m = v.durationSec / 60;
    if (f.dMin !== null && m < f.dMin) return false;
    if (f.dMax !== null && m > f.dMax) return false;
  }
  if (f.wMin !== null && v.watchedPct < f.wMin) return false;
  if (f.wMax !== null && v.watchedPct > f.wMax) return false;
  if (f.status === "available" && v.unavailable) return false;
  if (f.status === "unavailable" && !v.unavailable) return false;
  return true;
}

function activeFilterCount() {
  const f = readFilters();
  return [
    !!f.q, selChannels.size > 0, !!(f.upFrom || f.upTo),
    f.dMin !== null || f.dMax !== null, f.wMin !== null || f.wMax !== null, f.status !== "all",
  ].filter(Boolean).length;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const PRESETS = {
  upChips: [
    { label: "Last 30 days", set: { upFrom: () => daysAgo(30), upTo: "" } },
    { label: "Last year", set: { upFrom: () => daysAgo(365), upTo: "" } },
    { label: "Older than 1 year", set: { upFrom: "", upTo: () => daysAgo(365) } },
    { label: "Older than 3 years", set: { upFrom: "", upTo: () => daysAgo(1095) } },
  ],
  durChips: [
    { label: "< 5 min", set: { dMin: "", dMax: "5" } },
    { label: "5–20", set: { dMin: "5", dMax: "20" } },
    { label: "20–60", set: { dMin: "20", dMax: "60" } },
    { label: "> 60 min", set: { dMin: "60", dMax: "" } },
  ],
  wChips: [
    { label: "Unwatched", set: { wMin: "0", wMax: "0" } },
    { label: "Started (1–79%)", set: { wMin: "1", wMax: "79" } },
    { label: "Almost done (80–99%)", set: { wMin: "80", wMax: "99" } },
    { label: "Finished (100%)", set: { wMin: "100", wMax: "100" } },
  ],
};

function renderChannels() {
  const term = $("chSearch").value.trim().toLowerCase();
  const counts = new Map();
  for (const v of items) counts.set(v.channel || "", (counts.get(v.channel || "") || 0) + 1);
  const list = [...counts.entries()]
    .filter(([name]) => !term || name.toLowerCase().includes(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("chList").innerHTML = list
    .map(
      ([name, n]) =>
        `<label><input type="checkbox" data-ch="${esc(name)}" ${selChannels.has(name) ? "checked" : ""}> ${esc(name || "(no channel)")}<span class="n">${n}</span></label>`
    )
    .join("");
  $("chSelected").textContent = selChannels.size ? `(${selChannels.size} selected)` : "";
}

function filtered() {
  const f = readFilters();
  return items
    .filter((v) => matches(v, f))
    .sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      return (typeof x === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""))) * sortDir;
    });
}

// ---------- rendering ----------

function renderTabs() {
  const ids = Object.keys(playlists);
  $("tabs").innerHTML = ids
    .map((id) => {
      const pl = playlists[id];
      return `<div class="tab ${id === activeId ? "active" : ""}" data-id="${esc(id)}" style="cursor:pointer">
        <span class="t">${esc(pl.title || id)}</span><span class="n">${pl.items?.length ?? 0}</span>
        <span class="x" data-forget="${esc(id)}" title="Forget this playlist locally (nothing changes on YouTube)">×</span>
      </div>`;
    })
    .join("");
}

function render() {
  renderTabs();
  const hasPl = !!activeId && !!playlists[activeId];
  $("workspace").style.display = hasPl ? "" : "none";
  $("empty").classList.toggle("on", !hasPl);
  $("rescan").disabled = !hasPl;
  const pl = playlists[activeId];
  $("scanned").textContent = hasPl
    ? pl.scannedAt ? `Scanned ${new Date(pl.scannedAt).toLocaleString()}` : ""
    : "";
  if (!hasPl) { $("count").textContent = ""; return; }

  const rows = filtered();
  renderChannels();
  const af = activeFilterCount();
  $("activeFilters").textContent = af ? `${af} filter${af > 1 ? "s" : ""} active` : "";
  $("count").textContent = `${rows.length} shown of ${items.length}`;
  $("head").innerHTML = '<th><input type="checkbox" id="selAll" title="Select all shown"></th>' + COLS.map(
    (c) => `<th class="${c.num ? "num" : ""}" data-k="${c.key}">${c.label}${c.key === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`
  ).join("");
  $("body").innerHTML = rows
    .map(
      (v) => `<tr data-sid="${esc(v.setVideoId)}">
      <td><input type="checkbox" class="rowchk" ${selected.has(v.setVideoId) ? "checked" : ""}></td>
      <td class="num">${v.position + 1}</td>
      <td><a href="https://www.youtube.com/watch?v=${esc(v.videoId)}" target="_blank">${esc(v.title)}</a>${v.unavailable ? ' <span class="badge">unavailable</span>' : ""}</td>
      <td>${esc(v.channel)}</td>
      <td class="num">${fmtDur(v.durationSec)}</td>
      <td class="num">${v.watchedPct}%<span class="pct" style="width:${v.watchedPct * 0.5}px"></span></td>
      <td title="${esc(v.publishedText)}">${esc(v.publishedApprox)}</td>
    </tr>`
    )
    .join("");
  highlight(pending ? pending.ids : null);
  updateSelectionUi(rows);

  $("delCount").textContent = removed.length;
  $("delBody").innerHTML = removed
    .slice()
    .reverse()
    .map(
      (v) => `<tr><td>${esc(v.title)}</td><td>${esc(v.channel)}</td><td class="num">${v.watchedPct}%</td>
      <td>${new Date(v.removedAt).toLocaleString()}</td><td>${esc(v.movedTo || "")}</td></tr>`
    )
    .join("");
  $("unavCount").textContent = `${items.filter((i) => i.unavailable).length} unavailable video(s) in the current list.`;
}

function highlight(ids) {
  const set = ids ? new Set(ids) : null;
  for (const tr of $("body").rows) tr.classList.toggle("danger-row", !!set && set.has(tr.dataset.sid));
}

function applyDeletedView() {
  $("mainView").style.display = showDeleted ? "none" : "";
  $("deletedView").style.display = showDeleted ? "" : "none";
  $("delBtn").firstChild.textContent = showDeleted ? "Back to list (" : "Deleted videos (";
}

// ---------- target selection ----------

function targetIds(kind) {
  let rows;
  if (kind === "first5") rows = filtered().slice(0, 5);
  else if (kind === "selected") rows = filtered().filter((r) => selected.has(r.setVideoId));
  else rows = items.filter((i) => i.unavailable);
  return rows.filter((r) => r.setVideoId).map((r) => r.setVideoId);
}

function bindTarget(btnId, kind) {
  const b = $(btnId);
  b.onmouseenter = () => highlight(targetIds(kind));
  b.onmouseleave = () => highlight(pending ? pending.ids : null);
}

function askConfirm(kind) {
  const ids = targetIds(kind);
  if (!ids.length) {
    $("confirmText").textContent = "Nothing to remove for this selection.";
    $("confirmYes").style.display = "none";
    $("confirmBar").classList.add("on");
    pending = null;
    return;
  }
  pending = { kind, ids };
  let text = `Remove ${ids.length} video(s) from the YouTube playlist “${plTitle()}”? This cannot be undone from here.`;
  if (ids.length === items.length) text = "⚠ This is the ENTIRE list. " + text;
  $("confirmText").textContent = text;
  $("confirmYes").style.display = "";
  $("confirmBar").classList.add("on");
  highlight(ids);
}

function cancelConfirm() {
  pending = null;
  $("confirmBar").classList.remove("on");
  highlight(null);
}

// ---------- messaging ----------

async function sendToYouTubeTab(msg, { needList = false } = {}) {
  let tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const hasList = (t) => /[?&]list=/.test(t.url || "");
  if (needList) tabs = tabs.filter(hasList);
  tabs.sort((a, b) => (b.active - a.active) || (hasList(b) - hasList(a)));
  if (!tabs.length) {
    throw new Error(
      needList
        ? "No YouTube playlist page is open. Open the playlist you want to add, then try again."
        : "Open a youtube.com tab first."
    );
  }
  let lastErr;
  for (const tab of tabs) {
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        return await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e) { lastErr = e; }
    }
  }
  throw new Error(`Could not reach a YouTube tab: ${lastErr?.message || "unknown error"}`);
}

async function addCurrentPlaylist() {
  try {
    const r = await sendToYouTubeTab({ type: "wlm-current" }, { needList: true });
    if (!r?.listId) throw new Error("The YouTube tab isn't on a playlist page. Open the playlist, then try again.");
    pendingActive = r.listId;
    await sendToYouTubeTab({ type: "wlm-scan", playlistId: r.listId });
    $("scanmsg").textContent = "Scanning…";
  } catch (e) {
    pendingActive = null;
    $("scanmsg").textContent = e.message;
  }
}

async function rescan() {
  if (!activeId) return;
  try {
    await sendToYouTubeTab({ type: "wlm-scan", playlistId: activeId });
    $("scanmsg").textContent = "Scanning…";
  } catch (e) {
    $("scanmsg").textContent = e.message;
  }
}

async function runRemoval() {
  if (!pending) return;
  if (pending.run) {
    // custom confirmed action (move / copy / split)
    const run = pending.run;
    cancelConfirm();
    try {
      await run();
      $("rmstatus").textContent = "Starting…";
    } catch (e) {
      $("rmstatus").textContent = e.message;
    }
    $("progress").classList.add("on");
    return;
  }
  const ids = pending.ids;
  cancelConfirm();
  try {
    await sendToYouTubeTab({ type: "wlm-remove", playlistId: activeId, setVideoIds: ids });
    $("rmstatus").textContent = "Starting…";
  } catch (e) {
    $("rmstatus").textContent = e.message;
  }
  $("progress").classList.add("on");
}

async function forgetPlaylist(id) {
  const pl = playlists[id];
  if (!pl) return;
  if (!confirm(`Forget “${pl.title}” in PlaylistBulkEditor?\n\nThis only deletes the locally stored list and deleted-videos log. Nothing changes on YouTube.`)) return;
  delete playlists[id];
  delete uiState[id];
  await chrome.storage.local.set({ playlists });
}

// ---------- export ----------

function download(name, mime, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toCsv(rows, extra = []) {
  const cols = ["position", "videoId", "title", "channel", "channelId", "durationSec", "watchedPct", "publishedText", "publishedApprox", "unavailable", "setVideoId", ...extra];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

// ---------- status ----------

function applyRemoveStatus(s) {
  if (!s) return;
  const fresh = Date.now() - s.at < 30000;
  const running = s.state === "running" && fresh;
  const total = s.total || 0;
  const pct = total ? Math.round(((s.done + s.failed) / total) * 100) : 0;
  const where = s.playlistId && playlists[s.playlistId] ? `${playlists[s.playlistId].title}: ` : "";
  $("barFill").style.width = pct + "%";
  $("rmstatus").textContent = `${where}${s.done}/${total} removed${s.failed ? `, ${s.failed} failed` : ""} — ${s.message || ""}`;
  $("spinner").classList.toggle("on", running);
  $("stop").style.display = running ? "" : "none";
  if (running || (fresh && s.state !== "running")) $("progress").classList.add("on");
  for (const id of ["rm5", "rmall", "unavBtn", "unavRemove", "mvBtn", "cpBtn", "splitBtn", "xferGo", "splitGo"]) {
    $(id).disabled = running;
  }
}

// ---------- wiring ----------

function onFilterChange() {
  cancelConfirm();
  applyAutoSelection();
  render();
}

$("tabs").onclick = (e) => {
  const f = e.target.dataset?.forget;
  if (f) { forgetPlaylist(f); return; }
  const tab = e.target.closest(".tab");
  if (tab) setActive(tab.dataset.id);
};
$("addPl").onclick = addCurrentPlaylist;

$("head").onclick = (e) => {
  const k = e.target.closest("th")?.dataset.k;
  if (!k) return;
  sortDir = sortKey === k ? -sortDir : 1;
  sortKey = k;
  render();
};
$("head").onchange = (e) => {
  if (e.target.id !== "selAll") return;
  cancelConfirm();
  for (const v of filtered()) {
    if (!v.setVideoId) continue;
    e.target.checked ? selected.add(v.setVideoId) : selected.delete(v.setVideoId);
  }
  render();
};
$("body").onchange = (e) => {
  if (!e.target.classList.contains("rowchk")) return;
  const sid = e.target.closest("tr").dataset.sid;
  e.target.checked ? selected.add(sid) : selected.delete(sid);
  cancelConfirm();
  updateSelectionUi(filtered());
};

$("q").oninput = onFilterChange;
for (const id of ["upFrom", "upTo", "dMin", "dMax", "wMin", "wMax"]) {
  $(id).oninput = onFilterChange;
  $(id).onchange = onFilterChange;
}
$("statusSel").onchange = onFilterChange;

$("chSearch").oninput = renderChannels; // only narrows the visible channel list
$("chList").onchange = (e) => {
  const name = e.target.dataset?.ch;
  if (name === undefined) return;
  e.target.checked ? selChannels.add(name) : selChannels.delete(name);
  onFilterChange();
};
$("chClear").onclick = (e) => { e.preventDefault(); selChannels.clear(); onFilterChange(); };

for (const [boxId, presets] of Object.entries(PRESETS)) {
  for (const p of presets) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.label;
    b.onclick = () => {
      for (const [id, val] of Object.entries(p.set)) $(id).value = typeof val === "function" ? val() : val;
      onFilterChange();
    };
    $(boxId).appendChild(b);
  }
}

$("clearFilters").onclick = () => {
  for (const id of FIELD_IDS) $(id).value = id === "statusSel" ? "all" : "";
  selChannels.clear();
  onFilterChange();
};

$("csv").onclick = () => download(`${fileSlug()}.csv`, "text/csv;charset=utf-8", toCsv(filtered()));
$("json").onclick = () => download(`${fileSlug()}.json`, "application/json", JSON.stringify(filtered(), null, 2));
$("exportDel").onclick = () => {
  if (!removed.length) return alert("No deleted videos recorded yet for this playlist.");
  download(
    `${fileSlug()}-deleted.csv`,
    "text/csv;charset=utf-8",
    toCsv(removed.map((r) => ({ ...r, removedAt: new Date(r.removedAt).toISOString() })), ["removedAt", "movedTo"])
  );
};

bindTarget("rm5", "first5");
bindTarget("rmall", "selected");
bindTarget("unavBtn", "unav");
bindTarget("unavRemove", "unav");

$("rm5").onclick = () => { $("unavPanel").classList.remove("on"); askConfirm("first5"); };
$("rmall").onclick = () => { $("unavPanel").classList.remove("on"); askConfirm("selected"); };
$("unavBtn").onclick = () => { cancelConfirm(); $("unavPanel").classList.add("on"); render(); };
$("unavClose").onclick = () => $("unavPanel").classList.remove("on");
$("unavRemove").onclick = () => askConfirm("unav");
$("unavRescan").onclick = rescan;
$("rescan").onclick = rescan;
$("confirmYes").onclick = runRemoval;
$("confirmNo").onclick = cancelConfirm;
$("stop").onclick = () => sendToYouTubeTab({ type: "wlm-stop" }).catch(() => {});

$("delBtn").onclick = () => {
  showDeleted = !showDeleted;
  applyDeletedView();
};

// ---------- add by link / ID ----------

function parseListId(s) {
  s = String(s || "").trim();
  const m = s.match(/[?&]list=([\w-]+)/);
  if (m) return m[1];
  return /^[\w-]{2,}$/.test(s) ? s : "";
}

$("addUrlBtn").onclick = async () => {
  const id = parseListId($("addUrl").value);
  if (!id) { $("scanmsg").textContent = "Paste a playlist link (…?list=PL…) or an ID."; return; }
  try {
    pendingActive = id;
    await sendToYouTubeTab({ type: "wlm-scan", playlistId: id });
    $("scanmsg").textContent = "Scanning…";
    $("addUrl").value = "";
  } catch (e) {
    pendingActive = null;
    $("scanmsg").textContent = e.message;
  }
};

// ---------- organize: move / copy / split ----------

function closePanels() {
  for (const id of ["unavPanel", "xferPanel", "splitPanel"]) $(id).classList.remove("on");
}

// Ticked rows that can actually be added elsewhere (unavailable videos cannot).
function transferRows() {
  const rows = filtered().filter((r) => selected.has(r.setVideoId) && r.setVideoId);
  return { usable: rows.filter((r) => !r.unavailable), skipped: rows.filter((r) => r.unavailable).length };
}

function askCustom(text, run) {
  pending = { kind: "custom", ids: [], run };
  $("confirmText").textContent = text;
  $("confirmYes").style.display = "";
  $("confirmBar").classList.add("on");
  highlight(null);
}

function notice(text) {
  pending = null;
  $("confirmText").textContent = text;
  $("confirmYes").style.display = "none";
  $("confirmBar").classList.add("on");
}

const toItems = (rows) => rows.map((r) => ({ videoId: r.videoId, setVideoId: r.setVideoId }));

let xferMode = "move";

function openXfer(mode) {
  cancelConfirm();
  closePanels();
  const { usable } = transferRows();
  if (!usable.length) return notice("Tick some videos first (or apply a filter, which ticks everything shown).");
  xferMode = mode;
  $("xferTitle").textContent = mode === "move" ? "Move selected videos" : "Copy selected videos";
  const others = Object.values(playlists).filter((p) => p.id !== activeId);
  $("xferTarget").innerHTML =
    `<option value="__new__">➕ New playlist…</option>` +
    others.map((p) => `<option value="${esc(p.id)}">${esc(p.title || p.id)} (${p.items?.length ?? 0})</option>`).join("");
  $("xferPanel").classList.add("on");
  updateXfer();
}

function updateXfer() {
  const isNew = $("xferTarget").value === "__new__";
  $("xferName").style.display = isNew ? "" : "none";
  $("xferPrivacyWrap").style.display = isNew ? "" : "none";
  const { usable, skipped } = transferRows();
  const dest = isNew ? `a new playlist${$("xferName").value ? ` “${$("xferName").value}”` : ""}` : `“${playlists[$("xferTarget").value]?.title}”`;
  $("xferSummary").textContent =
    `${usable.length} video(s) from “${plTitle()}” → ${dest}` +
    (skipped ? ` · ${skipped} unavailable video(s) skipped` : "");
}

$("mvBtn").onclick = () => openXfer("move");
$("cpBtn").onclick = () => openXfer("copy");
$("xferTarget").onchange = updateXfer;
$("xferName").oninput = updateXfer;
$("xferClose").onclick = () => $("xferPanel").classList.remove("on");

$("xferGo").onclick = () => {
  const { usable } = transferRows();
  if (!usable.length) return notice("Nothing selected.");
  const isNew = $("xferTarget").value === "__new__";
  const name = $("xferName").value.trim();
  if (isNew && !name) return notice("Give the new playlist a name first.");
  const target = isNew
    ? { newTitle: name, privacy: $("xferPrivacy").value }
    : { id: $("xferTarget").value, title: playlists[$("xferTarget").value]?.title };
  const verb = xferMode === "move" ? "Move" : "Copy";
  const destName = isNew ? `a NEW ${$("xferPrivacy").value.toLowerCase()} playlist “${name}”` : `“${target.title}”`;
  askCustom(
    `${verb} ${usable.length} video(s) to ${destName}?` +
      (xferMode === "move" ? " They are added there first, then removed from this playlist." : ""),
    async () => {
      $("xferPanel").classList.remove("on");
      await sendToYouTubeTab({
        type: "wlm-transfer",
        sourceId: activeId,
        mode: xferMode,
        jobs: [{ target, items: toItems(usable) }],
      });
    }
  );
};

// --- split wizard ---

let splitGroups = []; // [{ name, items: [rows], include }]

const yearOf = (v) => (v.publishedApprox ? v.publishedApprox.slice(0, 4) : "Unknown year");
const durBucket = (v) => {
  if (v.durationSec == null) return "Unknown length";
  const m = v.durationSec / 60;
  return m < 5 ? "Under 5 min" : m < 20 ? "5-20 min" : m < 60 ? "20-60 min" : "Over 60 min";
};
const watchBucket = (v) =>
  v.watchedPct >= 80 ? "Mostly watched (80%+)" : v.watchedPct >= 1 ? "In progress" : "Unwatched";

function splitSource() {
  const { usable, skipped } = transferRows();
  if (usable.length) return { rows: usable, skipped, label: "ticked" };
  const shown = filtered().filter((r) => r.setVideoId && !r.unavailable);
  return { rows: shown, skipped: 0, label: "shown" };
}

function buildSplitGroups() {
  const { rows } = splitSource();
  const by = $("splitBy").value;
  const n = Math.max(1, Number($("splitN").value) || 1);
  const prefix = $("splitPrefix").value;
  const buckets = new Map();
  const put = (name, r) => {
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(r);
  };

  if (by === "channel") {
    const counts = new Map();
    for (const r of rows) counts.set(r.channel || "", (counts.get(r.channel || "") || 0) + 1);
    for (const r of rows) {
      const c = r.channel || "";
      put(c && counts.get(c) >= n ? c : "Other channels", r);
    }
  } else if (by === "year") rows.forEach((r) => put(yearOf(r), r));
  else if (by === "duration") rows.forEach((r) => put(durBucket(r), r));
  else if (by === "watched") rows.forEach((r) => put(watchBucket(r), r));
  else rows.forEach((r, i) => put(`Part ${Math.floor(i / n) + 1}`, r));

  let entries = [...buckets.entries()];
  if (by !== "chunks") entries.sort((a, b) => b[1].length - a[1].length);
  splitGroups = entries.map(([name, items]) => ({ name: (prefix + name).trim(), items, include: true }));
}

function renderSplit() {
  const { rows, skipped, label } = splitSource();
  $("splitScope").textContent =
    `Scope: ${rows.length} ${label} video(s) from “${plTitle()}”` +
    (skipped ? ` (${skipped} unavailable skipped)` : "") +
    ". Rename or untick groups below. Nothing happens until you confirm.";
  $("splitBody").innerHTML = splitGroups
    .map(
      (g, i) => `<tr>
      <td><input type="checkbox" data-gi="${i}" class="gchk" ${g.include ? "checked" : ""}></td>
      <td><input type="text" data-gn="${i}" value="${esc(g.name)}"></td>
      <td class="num">${g.items.length}</td></tr>`
    )
    .join("");
  const inc = splitGroups.filter((g) => g.include);
  const vids = inc.reduce((s, g) => s + g.items.length, 0);
  $("splitSummary").textContent = `${inc.length} playlist(s), ${vids} video(s)`;
  $("splitAll").checked = splitGroups.length > 0 && splitGroups.every((g) => g.include);
}

function refreshSplit() {
  const by = $("splitBy").value;
  $("splitNLabel").textContent = by === "chunks" ? "Videos per part" : "Min videos per channel";
  $("splitN").parentElement.style.display = by === "channel" || by === "chunks" ? "" : "none";
  buildSplitGroups();
  renderSplit();
}

$("splitBtn").onclick = () => {
  cancelConfirm();
  closePanels();
  if (!splitSource().rows.length) return notice("No videos to split: tick some, or apply a filter.");
  $("splitPrefix").value = `${plTitle()} - `;
  $("splitN").value = $("splitBy").value === "chunks" ? 100 : 5;
  $("splitPanel").classList.add("on");
  refreshSplit();
};
$("splitBy").onchange = () => {
  $("splitN").value = $("splitBy").value === "chunks" ? 100 : 5;
  refreshSplit();
};
$("splitN").oninput = refreshSplit;
$("splitPrefix").oninput = refreshSplit;
$("splitClose").onclick = () => $("splitPanel").classList.remove("on");

$("splitBody").onchange = (e) => {
  const gi = e.target.dataset?.gi;
  if (gi !== undefined) { splitGroups[gi].include = e.target.checked; renderSplit(); }
};
$("splitBody").oninput = (e) => {
  const gn = e.target.dataset?.gn;
  if (gn !== undefined) splitGroups[gn].name = e.target.value; // no re-render: keeps the caret
};
$("splitAll").onchange = (e) => {
  splitGroups.forEach((g) => (g.include = e.target.checked));
  renderSplit();
};

$("splitGo").onclick = () => {
  const inc = splitGroups.filter((g) => g.include && g.name.trim());
  if (!inc.length) return notice("Nothing to create: tick at least one group with a name.");
  const names = inc.map((g) => g.name.trim());
  if (new Set(names).size !== names.length) return notice("Two groups have the same name. Rename one of them.");
  const vids = inc.reduce((s, g) => s + g.items.length, 0);
  const mode = $("splitMode").value;
  const privacy = $("splitPrivacy").value;
  let text =
    `Create ${inc.length} ${privacy.toLowerCase()} playlist(s) and ${mode} ${vids} video(s) into them?` +
    (mode === "move" ? " Videos are added first, then removed from this playlist." : "");
  if (inc.length > 25) text += " That is a lot of playlists; YouTube may rate-limit creating them.";
  askCustom(text, async () => {
    $("splitPanel").classList.remove("on");
    await sendToYouTubeTab({
      type: "wlm-transfer",
      sourceId: activeId,
      mode,
      jobs: inc.map((g) => ({ target: { newTitle: g.name.trim(), privacy }, items: toItems(g.items) })),
    });
  });
};

// ---------- storage ----------

// Older versions stored a single Watch Later list at the top level.
async function migrate() {
  const d = await chrome.storage.local.get(["items", "scannedAt", "removedLog", "playlists"]);
  if (!d.items && !d.removedLog) return;
  const pls = d.playlists || {};
  const wl = pls.WL || { id: "WL", title: "Watch Later", items: [], scannedAt: 0, removedLog: [] };
  if (d.items && !wl.items.length) { wl.items = d.items; wl.scannedAt = d.scannedAt || 0; }
  if (d.removedLog && !(wl.removedLog || []).length) wl.removedLog = d.removedLog;
  pls.WL = wl;
  await chrome.storage.local.set({ playlists: pls });
  await chrome.storage.local.remove(["items", "scannedAt", "removedLog"]);
}

async function load() {
  await migrate();
  const d = await chrome.storage.local.get(["playlists", "activePlaylistId", "removeStatus", "scanStatus"]);
  playlists = d.playlists || {};
  const ids = Object.keys(playlists);

  let target = activeId;
  if (pendingActive && playlists[pendingActive]) { target = pendingActive; pendingActive = null; }
  if (!target || !playlists[target]) {
    target = d.activePlaylistId && playlists[d.activePlaylistId] ? d.activePlaylistId : ids[0] || null;
  }
  if (target !== activeId) {
    saveUi(activeId);
    activeId = target;
    restoreUi(activeId);
    if (activeId) chrome.storage.local.set({ activePlaylistId: activeId });
  }

  syncPlaylistData();
  const alive = new Set(items.map((i) => i.setVideoId));
  for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);

  if (d.scanStatus) {
    const where = d.scanStatus.playlistId && playlists[d.scanStatus.playlistId]
      ? `${playlists[d.scanStatus.playlistId].title}: ` : "";
    $("scanmsg").textContent = where + (d.scanStatus.message || "");
  }
  render();
  applyRemoveStatus(d.removeStatus);
}
chrome.storage.onChanged.addListener(load);
load();

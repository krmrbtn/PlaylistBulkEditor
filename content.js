// PlaylistBulkEditor: scraper and remover for any YouTube playlist (incl. Watch Later "WL").
// Runs in the page's session: fetches the playlist page HTML, then follows
// innertube continuations. All YouTube-format knowledge lives in this file
// (functions under "YouTube adapter").

(() => {
  // Re-injection replaces any previous (possibly orphaned) instance.
  try { window.__wlmDispose && window.__wlmDispose(); } catch {}

  const ORIGIN = location.origin;
  let scanning = false;
  let scanListId = "";
  let removeListId = "";

  // ---------- generic helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function extractJsonAfter(text, marker) {
    const i = text.indexOf(marker);
    if (i === -1) return null;
    let start = text.indexOf("{", i + marker.length);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let p = start; p < text.length; p++) {
      const c = text[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, p + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function walk(node, visit) {
    if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (visit(k, node[k]) === false) continue;
        walk(node[k], visit);
      }
    }
  }

  const textOf = (t) =>
    !t ? "" : t.simpleText ?? (t.runs ? t.runs.map((r) => r.text).join("") : "") ?? "";

  function parseDuration(s) {
    if (!s) return null;
    const parts = String(s).trim().split(":").map(Number);
    if (parts.some(isNaN)) return null;
    return parts.reduce((a, n) => a * 60 + n, 0);
  }

  // The list only exposes relative upload age ("3 years ago"), so the date is approximate.
  // Handles "4mo ago", "2y ago", "3 weeks ago" and Turkish "3 yıl önce".
  const AGO_RE = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|mo|yr|hr|min|sec|y|w|d|h|m|s|saniye|dakika|saat|gün|hafta|ay|yıl)\s+(?:ago|önce)/gi;

  function unitDays(u) {
    u = u.toLowerCase();
    if (u.startsWith("mo") || u === "ay") return 30.44;
    if (u.startsWith("y")) return 365.25;
    if (u.startsWith("w") || u === "hafta") return 7;
    if (u.startsWith("d") && u !== "dakika") return 1;
    if (u === "gün") return 1;
    if (u.startsWith("h") || u === "saat") return 1 / 24;
    if (u.startsWith("min") || u === "m" || u === "dakika") return 1 / 1440;
    return 1 / 86400; // seconds
  }

  // Last match wins: in an accessibility label the age comes after the title.
  function parsePublished(texts) {
    for (const t of texts) {
      if (typeof t !== "string") continue;
      const all = [...t.matchAll(AGO_RE)];
      const m = all[all.length - 1];
      if (m) {
        const ms = Date.now() - Number(m[1]) * unitDays(m[2]) * 86400000;
        return { publishedText: m[0], publishedApprox: new Date(ms).toISOString().slice(0, 10) };
      }
    }
    return { publishedText: "", publishedApprox: "" };
  }

  // Look in the structured fields first (never in the title), then the
  // accessibility label, which reads "<title> by <channel> N views N years ago <duration>".
  function findPublished(r) {
    const strings = [];
    walk(r, (k, v) => {
      if (k === "title" || k === "thumbnail" || k === "thumbnailOverlays" || k === "menu") return false;
      if (typeof v === "string") strings.push(v);
    });
    const direct = parsePublished(strings);
    if (direct.publishedText) return direct;
    const label = r.title?.accessibility?.accessibilityData?.label;
    return parsePublished([label]);
  }

  async function sapisidHash() {
    const m = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const data = new TextEncoder().encode(`${ts} ${m[1]} ${ORIGIN}`);
    const buf = await crypto.subtle.digest("SHA-1", data);
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  // ---------- YouTube adapter ----------

  function pickVideoFromPlaylistVideoRenderer(r, out) {
    let pct = 0;
    for (const o of r.thumbnailOverlays || []) {
      const rp = o.thumbnailOverlayResumePlaybackRenderer;
      if (rp && typeof rp.percentDurationWatched === "number") pct = rp.percentDurationWatched;
    }
    const channel = r.shortBylineText?.runs?.[0];
    out.push({
      videoId: r.videoId,
      setVideoId: r.setVideoId || null,
      title: textOf(r.title),
      channel: channel?.text || "",
      channelId: channel?.navigationEndpoint?.browseEndpoint?.browseId || "",
      durationSec: r.lengthSeconds ? Number(r.lengthSeconds) : parseDuration(textOf(r.lengthText)),
      watchedPct: pct,
      isPlayable: r.isPlayable !== false,
      unavailable:
        r.isPlayable === false || /^\[(private|deleted) video\]$/i.test(textOf(r.title).trim()),
      ...findPublished(r),
    });
  }

  function pickVideoFromLockup(l, out) {
    if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return;
    const videoId = l.contentId;
    if (!videoId) return;
    let pct = 0, duration = null, setVideoId = null;
    walk(l.contentImage, (k, v) => {
      if (k === "thumbnailOverlayProgressBarViewModel" && typeof v.startPercent === "number") pct = v.startPercent;
      if (k === "thumbnailBadgeViewModel" && v.text) duration = duration ?? parseDuration(v.text);
    });
    walk(l, (k, v) => {
      if (k === "playlistVideoId" && typeof v === "string") setVideoId = setVideoId || v;
      if (k === "setVideoId" && typeof v === "string") setVideoId = setVideoId || v;
    });
    const meta = l.metadata?.lockupMetadataViewModel;
    const title = meta?.title?.content || "";
    let channel = "", channelId = "";
    walk(meta, (k, v) => {
      if (k === "browseEndpoint" && v.browseId && !channelId) channelId = v.browseId;
    });
    const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows;
    channel = rows?.[0]?.metadataParts?.[0]?.text?.content || "";
    out.push({
      videoId, setVideoId, title, channel, channelId, durationSec: duration, watchedPct: pct, isPlayable: true,
      unavailable: /^\[(private|deleted) video\]$/i.test(title.trim()),
      ...parsePublished(
        (rows || []).flatMap((row) => (row.metadataParts || []).map((p) => p.text?.content))
      ),
    });
  }

  function extractPage(data) {
    const videos = [];
    const kinds = {}; // diagnostics: video-ish renderer types seen on this page
    let token = null;
    walk(data, (k, v) => {
      if (/(video|lockup|reel)/i.test(k) && /(Renderer|ViewModel)$/.test(k)) kinds[k] = (kinds[k] || 0) + 1;
      if (k === "playlistVideoRenderer") { pickVideoFromPlaylistVideoRenderer(v, videos); return false; }
      if (k === "lockupViewModel") { pickVideoFromLockup(v, videos); return false; }
      if (k === "continuationItemRenderer") {
        // Token may be nested (e.g. under commandExecutorCommand.commands[]).
        walk(v, (kk, vv) => {
          if (kk === "continuationCommand" && vv && typeof vv.token === "string") token = vv.token;
        });
        return false;
      }
    });
    // A page can hold several continuation items (e.g. one for the video list and
    // one for sections below it). The list's own token is the one sitting in the
    // same array as the videos, so prefer that over "the last one found".
    let listToken = null;
    walk(data, (k, v) => {
      if (!Array.isArray(v) || (k !== "contents" && k !== "continuationItems")) return;
      if (!v.some((x) => x && (x.playlistVideoRenderer || x.lockupViewModel))) return;
      for (const x of v) {
        const c = x?.continuationItemRenderer;
        if (!c) continue;
        walk(c, (kk, vv) => {
          if (kk === "continuationCommand" && vv && typeof vv.token === "string") listToken = vv.token;
        });
      }
    });
    if (listToken) token = listToken;

    if (!token) {
      // Fallbacks for other layouts: a bare continuationCommand, or the old
      // nextContinuationData form. Only used when the usual item was not found.
      walk(data, (k, v) => {
        if (token) return false;
        if (k === "continuationCommand" && typeof v?.token === "string") token = v.token;
        else if (k === "nextContinuationData" && typeof v?.continuation === "string") token = v.continuation;
      });
    }
    return { videos, token, kinds };
  }

  function listIdFromLocation() {
    try { return new URL(location.href).searchParams.get("list") || ""; } catch { return ""; }
  }

  function playlistTitle(data, fallback) {
    let title = "";
    walk(data, (k, v) => {
      if (title) return false;
      if (k === "playlistMetadataRenderer" && typeof v?.title === "string") title = v.title;
      if (k === "playlistHeaderRenderer" && v?.title) title = textOf(v.title);
    });
    return title || fallback;
  }

  async function loadFirstPage(listId) {
    const res = await fetch(`${ORIGIN}/playlist?list=${encodeURIComponent(listId)}&hl=en`, { credentials: "include" });
    if (!res.ok) throw new Error(`Playlist page HTTP ${res.status}`);
    const html = await res.text();
    const data = extractJsonAfter(html, "ytInitialData =") || extractJsonAfter(html, "ytInitialData=");
    if (!data) throw new Error("Could not find ytInitialData (are you signed in?)");
    const context = extractJsonAfter(html, '"INNERTUBE_CONTEXT":');
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    if (!context || !key) throw new Error("Could not find innertube config");
    return { data, context, key };
  }

  async function loadContinuation(cfg, token) {
    const headers = { "Content-Type": "application/json", "X-Goog-AuthUser": "0", "X-Origin": ORIGIN };
    const auth = await sapisidHash();
    if (auth) headers.Authorization = auth;
    const res = await fetch(`${ORIGIN}/youtubei/v1/browse?key=${cfg.key}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: cfg.context, continuation: token }),
    });
    if (!res.ok) throw new Error(`Continuation HTTP ${res.status}`);
    return res.json();
  }

  // Re-request the playlist with "Show unavailable videos" switched on, using the
  // menu item's own endpoint from the first page. Returns the new initial data.
  async function loadWithUnavailable(cfg) {
    let endpoint = null;
    walk(cfg.data, (k, v) => {
      if (k === "menuNavigationItemRenderer" && /show unavailable videos/i.test(textOf(v.text))) {
        endpoint = v.navigationEndpoint;
      }
    });
    if (!endpoint) return null; // nothing hidden, or label not found

    const be = endpoint.browseEndpoint;
    if (be?.browseId) {
      const headers = { "Content-Type": "application/json", "X-Goog-AuthUser": "0", "X-Origin": ORIGIN };
      const auth = await sapisidHash();
      if (auth) headers.Authorization = auth;
      const body = { context: cfg.context, browseId: be.browseId };
      if (be.params) body.params = be.params;
      const res = await fetch(`${ORIGIN}/youtubei/v1/browse?key=${cfg.key}&prettyPrint=false`, {
        method: "POST", credentials: "include", headers, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Show-unavailable request HTTP ${res.status}`);
      return res.json();
    }
    const url = endpoint.commandMetadata?.webCommandMetadata?.url || endpoint.urlEndpoint?.url;
    if (url) {
      const res = await fetch(new URL(url, ORIGIN).href, { credentials: "include" });
      const html = await res.text();
      return extractJsonAfter(html, "ytInitialData =") || extractJsonAfter(html, "ytInitialData=");
    }
    return null;
  }

  // ---------- scan orchestration ----------

  async function setStatus(status) {
    await chrome.storage.local.set({ scanStatus: { ...status, playlistId: scanListId, at: Date.now() } });
  }

  // "609 videos" in the playlist header (string, or a runs array like ["609", " videos"]).
  function headerCount(data) {
    let n = null;
    const test = (s) => {
      const m = String(s).match(/^\s*([\d.,]+)\s+videos?\s*$/i);
      if (m && n === null) n = Number(m[1].replace(/[.,]/g, ""));
    };
    walk(data, (k, v) => {
      if (n !== null) return false;
      if (typeof v === "string") test(v);
      else if (k === "runs" && Array.isArray(v)) test(v.map((r) => r?.text || "").join(""));
    });
    return n;
  }

  // Follow continuations from startData until the list ends.
  async function pageThrough(cfg, startData, label) {
    const seen = new Map();
    const pageLog = [];
    const kindsAll = {};
    const details = [];
    let warning = "";
    let page = extractPage(startData);
    let pageNo = 1;

    const add = (vids) => {
      for (const v of vids) {
        const key = v.setVideoId || v.videoId; // keep duplicates of the same video
        if (!seen.has(key)) seen.set(key, { ...v, position: seen.size });
      }
    };
    const note = (p) => {
      pageLog.push(p.videos.length);
      for (const n of Object.keys(p.kinds)) kindsAll[n] = (kindsAll[n] || 0) + p.kinds[n];
    };

    note(page);
    add(page.videos);
    await setStatus({ state: "running", count: seen.size, message: `${label}: page 1 — ${seen.size} videos` });

    while (page.token) {
      await sleep(350 + Math.random() * 250);
      let data;
      try {
        data = await loadContinuation(cfg, page.token);
      } catch (e) {
        warning = ` Stopped early at page ${pageNo}: ${e.message}.`;
        break;
      }
      page = extractPage(data);
      pageNo++;
      note(page);
      // Diagnostics: what did this continuation response actually contain?
      const itemTypes = {};
      walk(data, (k, v) => {
        if (k === "continuationItems" && Array.isArray(v)) {
          for (const it of v) {
            const t = Object.keys(it || {})[0] || "?";
            itemTypes[t] = (itemTypes[t] || 0) + 1;
          }
        }
      });
      details.push({
        page: pageNo,
        topKeys: Object.keys(data || {}),
        items: itemTypes,
        err: data?.error?.message || data?.error?.status || undefined,
      });
      const before = seen.size;
      add(page.videos);
      if (seen.size === before) break; // nothing new: end of list (or a bogus fallback token)
      await setStatus({ state: "running", count: seen.size, message: `${label}: page ${pageNo} — ${seen.size} videos` });
    }
    return { seen, pageLog, kindsAll, details, warning, pageNo, tokenLeft: !!page.token };
  }

  async function scan(listId) {
    if (scanning) return;
    scanning = true;
    scanListId = listId;
    try {
      if (/^RD/.test(listId)) throw new Error("YouTube Mix playlists are endless and not supported.");
      await setStatus({ state: "running", count: 0, message: "Loading playlist…" });
      const cfg = await loadFirstPage(listId);
      const expected = headerCount(cfg.data);

      let hiddenNote = "";
      let withHidden = null;
      try {
        withHidden = await loadWithUnavailable(cfg);
        if (!withHidden) hiddenNote = " (no 'Show unavailable videos' option found)";
      } catch (e) {
        hiddenNote = ` (could not load unavailable videos: ${e.message})`;
      }

      // Prefer the view with unavailable entries shown; if it comes up short of the
      // header count, also try the plain view and keep whichever has more.
      let mode = withHidden ? "with unavailable" : "plain";
      let best = await pageThrough(cfg, withHidden || cfg.data, mode);
      if (withHidden && expected && best.seen.size < expected) {
        const alt = await pageThrough(cfg, cfg.data, "plain");
        if (alt.seen.size > best.seen.size) { best = alt; mode = "plain"; }
      }

      if (best.seen.size === 0) throw new Error("0 videos parsed — YouTube format may have changed (or list is empty).");

      const items = [...best.seen.values()];
      let warning = best.warning;
      let countNote = "";
      if (expected && items.length < expected) {
        const gap = expected - items.length;
        if (gap <= 5 && gap / expected < 0.02) {
          // Tiny gap: usually private/removed entries YouTube still counts in the header.
          countNote = ` (${gap} fewer than the header count — likely hidden entries.)`;
        } else {
          warning += ` Fewer than the header count (${items.length} of ${expected}) — list may be incomplete.`;
        }
      }

      const { playlists = {} } = await chrome.storage.local.get("playlists");
      const prev = playlists[listId] || {};
      playlists[listId] = {
        id: listId,
        title: playlistTitle(cfg.data, prev.title || listId),
        items,
        scannedAt: Date.now(),
        removedLog: prev.removedLog || [],
      };
      await chrome.storage.local.set({ playlists });
      await setStatus({
        state: warning ? "error" : "done",
        count: items.length,
        message:
          `${items.length} videos${expected ? ` (YouTube header: ${expected})` : ""}, ` +
          `${items.filter((i) => i.unavailable).length} unavailable, ${best.pageNo} pages, mode: ${mode}.` +
          `${hiddenNote}${countNote}${warning}` +
          (!warning ? "" : ` [per page:${best.pageLog.join(",")}; token left: ${best.tokenLeft ? "yes" : "no"}; seen: ${JSON.stringify(best.kindsAll)}; continuations: ${JSON.stringify(best.details)}]`),
      });
    } catch (e) {
      await setStatus({ state: "error", count: 0, message: String(e.message || e) });
    } finally {
      scanning = false;
    }
  }

  // ---------- removal queue ----------

  let removing = false;
  let stopRequested = false;

  async function setRemoveStatus(s) {
    await chrome.storage.local.set({ removeStatus: { ...s, playlistId: removeListId, at: Date.now() } });
  }

  async function removeFromPlaylist(cfg, listId, setVideoId) {
    const headers = { "Content-Type": "application/json", "X-Goog-AuthUser": "0", "X-Origin": ORIGIN };
    const auth = await sapisidHash();
    if (!auth) throw new Error("Not signed in (no SAPISID cookie)");
    headers.Authorization = auth;
    const res = await fetch(`${ORIGIN}/youtubei/v1/browse/edit_playlist?key=${cfg.key}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        context: cfg.context,
        playlistId: listId,
        actions: [{ action: "ACTION_REMOVE_VIDEO", setVideoId }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "STATUS_SUCCEEDED") throw new Error(`Unexpected status: ${json.status}`);
  }

  async function removeBatch(listId, setVideoIds) {
    if (removing || !listId) return;
    removing = true;
    removeListId = listId;
    stopRequested = false;
    const total = setVideoIds.length;
    let done = 0, failed = 0, consecutiveFails = 0;
    const removedIds = new Set();
    try {
      await setRemoveStatus({ state: "running", done, total, failed, message: "Starting…" });
      const cfg = await loadFirstPage(listId);
      for (const id of setVideoIds) {
        if (stopRequested) break;
        try {
          await removeFromPlaylist(cfg, listId, id);
          removedIds.add(id);
          done++;
          consecutiveFails = 0;
        } catch (e) {
          failed++;
          consecutiveFails++;
          if (consecutiveFails >= 3) throw new Error(`Aborted after 3 failures in a row: ${e.message}`);
        }
        await setRemoveStatus({ state: "running", done, total, failed, message: `Removed ${done}/${total}` });
        await sleep(700 + Math.random() * 600);
      }
      await setRemoveStatus({
        state: "done", done, total, failed,
        message: `${stopRequested ? "Stopped. " : ""}Removed ${done}/${total}${failed ? `, ${failed} failed` : ""}.`,
      });
    } catch (e) {
      await setRemoveStatus({ state: "error", done, total, failed, message: String(e.message || e) });
    } finally {
      // Drop removed entries from the local list so it matches YouTube.
      // Removed entries are also appended to the playlist's persistent log (removedLog).
      if (removedIds.size) {
        const { playlists = {} } = await chrome.storage.local.get("playlists");
        const pl = playlists[listId];
        if (pl) {
          const now = Date.now();
          const gone = pl.items.filter((i) => removedIds.has(i.setVideoId)).map((i) => ({ ...i, removedAt: now }));
          pl.items = pl.items.filter((i) => !removedIds.has(i.setVideoId));
          pl.removedLog = (pl.removedLog || []).concat(gone);
          await chrome.storage.local.set({ playlists });
        }
      }
      removing = false;
    }
  }

  // ---------- transfer: move / copy videos, create playlists ----------

  async function innertubePost(cfg, path, body) {
    const auth = await sapisidHash();
    if (!auth) throw new Error("Not signed in (no SAPISID cookie)");
    const res = await fetch(`${ORIGIN}/youtubei/v1/${path}?key=${cfg.key}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-AuthUser": "0",
        "X-Origin": ORIGIN,
        Authorization: auth,
      },
      body: JSON.stringify({ context: cfg.context, ...body }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function createPlaylist(cfg, title, privacy, videoIds) {
    const json = await innertubePost(cfg, "playlist/create", {
      title: String(title).slice(0, 150),
      privacyStatus: privacy || "PRIVATE",
      videoIds,
    });
    if (!json.playlistId) throw new Error(`Playlist not created (${json.status || "no playlistId in response"})`);
    return json.playlistId;
  }

  async function addVideos(cfg, listId, videoIds) {
    const json = await innertubePost(cfg, "browse/edit_playlist", {
      playlistId: listId,
      actions: videoIds.map((id) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: id })),
    });
    if (json.status !== "STATUS_SUCCEEDED") throw new Error(`Unexpected status: ${json.status}`);
  }

  // msg: { sourceId, mode: "move"|"copy", jobs: [{ target: {id,title} | {newTitle,privacy}, items: [{videoId,setVideoId}] }] }
  // Order per batch: add to target first; only what was added is removed from the source.
  async function transfer(msg) {
    if (removing) return;
    removing = true;
    stopRequested = false;
    const { sourceId, mode } = msg;
    const jobs = msg.jobs || [];
    const verb = mode === "move" ? "moved" : "copied";
    const total = jobs.reduce((n, j) => n + j.items.length, 0);
    let done = 0, failed = 0, keptInSource = 0;
    const touched = new Set();
    const movedBySource = new Map(); // setVideoId -> destination title
    removeListId = sourceId;
    const status = (state, message) => setRemoveStatus({ state, done, total, failed, message });

    try {
      await status("running", "Starting…");
      const cfg = await loadFirstPage(sourceId);

      for (const job of jobs) {
        if (stopRequested) break;
        let listId = job.target.id || null;
        const destTitle = job.target.newTitle || job.target.title || listId;
        let processed = 0;

        for (let i = 0; i < job.items.length; i += 10) {
          if (stopRequested) break;
          const chunk = job.items.slice(i, i + 10);
          let ok = [];
          try {
            if (!listId) {
              listId = await createPlaylist(cfg, job.target.newTitle, job.target.privacy, chunk.map((c) => c.videoId));
              ok = chunk;
            } else {
              try {
                await addVideos(cfg, listId, chunk.map((c) => c.videoId));
                ok = chunk;
              } catch {
                // Batch refused: retry one by one to find the offenders.
                for (const it of chunk) {
                  try { await addVideos(cfg, listId, [it.videoId]); ok.push(it); } catch {}
                  await sleep(400);
                }
              }
            }
          } catch (e) {
            failed += job.items.length - processed;
            processed = job.items.length;
            await status("running", `Could not create “${destTitle}”: ${e.message}`);
            break;
          }
          if (listId) touched.add(listId);

          if (mode === "move") {
            for (const it of ok) {
              try {
                await removeFromPlaylist(cfg, sourceId, it.setVideoId);
                movedBySource.set(it.setVideoId, destTitle);
              } catch {
                keptInSource++; // it is in the target AND still in the source: safe
              }
              await sleep(400);
            }
          }
          done += ok.length;
          failed += chunk.length - ok.length;
          processed += chunk.length;
          await status("running", `${done}/${total} ${verb} → ${destTitle}`);
          await sleep(600 + Math.random() * 500);
        }
      }

      // Keep local data and the removed-videos log in step with YouTube.
      if (movedBySource.size) {
        const { playlists = {} } = await chrome.storage.local.get("playlists");
        const pl = playlists[sourceId];
        if (pl) {
          const now = Date.now();
          const gone = pl.items
            .filter((i) => movedBySource.has(i.setVideoId))
            .map((i) => ({ ...i, removedAt: now, movedTo: movedBySource.get(i.setVideoId) }));
          pl.items = pl.items.filter((i) => !movedBySource.has(i.setVideoId));
          pl.removedLog = (pl.removedLog || []).concat(gone);
          await chrome.storage.local.set({ playlists });
        }
      }

      // Load the touched target playlists so they show up as tabs.
      let n = 0;
      for (const id of touched) {
        n++;
        await status("running", `Refreshing playlist ${n}/${touched.size}…`);
        await scan(id);
      }

      await status(
        failed || keptInSource ? "error" : "done",
        `${stopRequested ? "Stopped. " : ""}${done}/${total} ${verb}` +
          `${failed ? `, ${failed} failed` : ""}` +
          `${keptInSource ? `, ${keptInSource} added but could not be removed from the source` : ""}.`
      );
    } catch (e) {
      await status("error", String(e.message || e));
    } finally {
      removing = false;
    }
  }

  const onMessage = (msg, _s, reply) => {
    if (msg?.type === "wlm-ping") reply({ ok: true });
    if (msg?.type === "wlm-current") reply({ listId: listIdFromLocation() });
    if (msg?.type === "wlm-scan") {
      scan(msg.playlistId || listIdFromLocation() || "WL");
      reply({ started: true });
    }
    if (msg?.type === "wlm-remove") {
      removeBatch(msg.playlistId, msg.setVideoIds || []);
      reply({ started: true });
    }
    if (msg?.type === "wlm-transfer") { transfer(msg); reply({ started: true }); }
    if (msg?.type === "wlm-stop") { stopRequested = true; reply({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__wlmDispose = () => chrome.runtime.onMessage.removeListener(onMessage);
})();

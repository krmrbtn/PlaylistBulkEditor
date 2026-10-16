const $ = (id) => document.getElementById(id);

function render(s, playlists) {
  const ids = Object.keys(playlists || {});
  const where = s?.playlistId && playlists?.[s.playlistId] ? `${playlists[s.playlistId].title}: ` : "";
  $("status").textContent = s ? where + (s.message || s.state) : "";
  const videos = ids.reduce((n, id) => n + (playlists[id].items?.length || 0), 0);
  $("meta").textContent = ids.length
    ? `${ids.length} playlist(s) stored, ${videos} videos in total.`
    : "No playlist scanned yet.";
}

async function refresh() {
  const { scanStatus, playlists } = await chrome.storage.local.get(["scanStatus", "playlists"]);
  render(scanStatus, playlists);
}

async function sendToYouTubeTab(msg) {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  if (!tabs.length) throw new Error("Open a youtube.com tab first.");
  const hasList = (t) => /[?&]list=/.test(t.url || "");
  tabs.sort((a, b) => (b.active - a.active) || (hasList(b) - hasList(a)));
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

$("scan").onclick = async () => {
  try {
    await sendToYouTubeTab({ type: "wlm-scan" });
    $("status").textContent = "Scanning…";
  } catch (e) {
    $("status").textContent = e.message.includes("Receiving end")
      ? "Reload the YouTube tab, then try again."
      : e.message;
  }
};

$("dash").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });

chrome.storage.onChanged.addListener(refresh);
refresh();

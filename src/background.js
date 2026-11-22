import "./security.js";
const security = globalThis.xPosterSecurity;
const REMOTE_IMAGE_TIMEOUT_MS = 15000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const REMOTE_IMAGE_RETRY_DELAYS_MS = [0, 500];
const REMOTE_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_REMOTE_IMAGE_CACHE_BYTES = 96 * 1024 * 1024;

const remoteImageCache = new Map();
let remoteImageCacheBytes = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "xposter:draft" && sender.url?.startsWith(chrome.runtime.getURL(""))) { draftOperation(message).then(sendResponse).catch(() => sendResponse({ ok: false, error: "草稿操作失败" })); return true; }
  if (message?.type === "xposter:clear-cache" && sender.url?.startsWith(chrome.runtime.getURL(""))) { if (activeDownloads || downloadQueue.length) { sendResponse({ ok: false, error: "图片下载正在进行，请稍后清空" }); return false; } remoteImageCache.clear(); remoteImageCacheBytes = 0; sendResponse({ ok: true }); return false; }
  if (message?.type === "xposter:fetch-image") {
    fetchImage(message.url, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "xposter:probe-image") {
    probeImage(message.url, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "xposter:remote-image-permission-status") {
    remoteImagePermissionStatus(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "xposter:open-side-panel") {
    openSidePanel(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "xposter:open-articles") {
    openArticles()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "xposter:diagnose-active-tab") {
    diagnoseActiveTab()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

async function openSidePanel(sender) {
  let tabId = sender.tab?.id || null;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id || null;
  }
  if (tabId) {
    await chrome.sidePanel.open({ tabId });
    return { ok: true, tabId };
  }
  try {
    await chrome.sidePanel.open({});
  } catch (error) {
    return { ok: false, error: "No active tab for side panel" };
  }
  return { ok: true };
}

async function diagnoseActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };
  const url = tab.url || "";
  const isX = /^https:\/\/(?:x|twitter)\.com\//.test(url);
  let content = null;
  if (isX) {
    try {
      content = await chrome.tabs.sendMessage(tab.id, { type: "xposter:diagnostics" });
    } catch (error) {
      content = { ok: false, error: error?.message || String(error) };
    }
  }
  return {
    ok: true,
    tab: { id: tab.id, title: tab.title || "", url, isX },
    content
  };
}

async function openArticles() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: "https://x.com/compose/articles" });
    return { ok: true, tabId: tab.id };
  }
  const created = await chrome.tabs.create({ url: "https://x.com/compose/articles" });
  return { ok: true, tabId: created.id || null };
}

async function fetchImage(url, sender = {}) {
  if (!url || typeof url !== "string") return { ok: false, error: "Invalid image URL" };
  if (url.startsWith("data:")) return validatedData(url);
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Unsupported image scheme" };
  const permission = await ensureRemoteImagePermission(url, sender);
  if (!permission.ok) return permission;
  return readRemoteImagePayload(url);
}

async function probeImage(url, sender = {}) {
  if (!url || typeof url !== "string") return { ok: false, error: "Invalid image URL" };
  if (url.startsWith("data:")) {
    const parsed = await validatedData(url);
    return parsed.ok
      ? { ok: true, mime: parsed.mime, bytes: parsed.bytes || 0, fileName: "image.png" }
      : parsed;
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Unsupported image scheme" };
  const permission = await ensureRemoteImagePermission(url, sender);
  if (!permission.ok) return permission;

  const payload = await readRemoteImagePayload(url);
  if (!payload.ok) return payload;
  return {
    ok: true,
    mime: payload.mime,
    fileName: payload.fileName,
    bytes: payload.bytes,
    repairedSignedUrl: payload.repairedSignedUrl,
    cacheHit: payload.cacheHit
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remoteImageCacheKey(url) {
  return String(url || "");
}

function forgetCachedRemoteImage(key) {
  const existing = remoteImageCache.get(key);
  if (!existing) return;
  remoteImageCacheBytes = Math.max(0, remoteImageCacheBytes - (existing.bytes || 0));
  remoteImageCache.delete(key);
}

function cachedRemoteImage(url) {
  const key = remoteImageCacheKey(url);
  const cached = remoteImageCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    forgetCachedRemoteImage(key);
    return null;
  }
  remoteImageCache.delete(key);
  remoteImageCache.set(key, cached);
  return { ok: true, ...cached.payload, cacheHit: true };
}

function rememberRemoteImage(url, payload) {
  if (!payload?.ok || !payload.base64) return;
  const key = remoteImageCacheKey(url);
  forgetCachedRemoteImage(key);
  const bytes = payload.bytes || Math.ceil(payload.base64.length * 0.75);
  if (bytes > MAX_REMOTE_IMAGE_CACHE_BYTES) return;
  remoteImageCache.set(key, {
    expiresAt: Date.now() + REMOTE_IMAGE_CACHE_TTL_MS,
    bytes,
    payload: {
      base64: payload.base64,
      mime: payload.mime,
      fileName: payload.fileName,
      bytes,
      repairedSignedUrl: payload.repairedSignedUrl
    }
  });
  remoteImageCacheBytes += bytes;
  while (remoteImageCacheBytes > MAX_REMOTE_IMAGE_CACHE_BYTES && remoteImageCache.size) {
    forgetCachedRemoteImage(remoteImageCache.keys().next().value);
  }
}

function isRetryableRemoteImageResult(result) {
  const status = Number(result?.status || 0);
  return (
    [429, 500, 502, 503, 504].includes(status) ||
    ["NETWORK_ERROR", "TIMEOUT"].includes(result?.code)
  );
}

function remoteImageErrorCode(reason, status) {
  if (status) return "HTTP_ERROR";
  if (/timed out|timeout/i.test(reason)) return "TIMEOUT";
  if (/failed to fetch|fetch failed|network|SSL|load failed/i.test(reason)) return "NETWORK_ERROR";
  return "INVALID_IMAGE";
}

let activeDownloads = 0;
const downloadQueue = [];
async function readRemoteImagePayload(url) {
  if (activeDownloads >= 3) { if (downloadQueue.length >= 30) return { ok: false, error: "图片队列已满" }; await new Promise(resolve => downloadQueue.push(resolve)); }
  else activeDownloads++;
  try { return await readRemoteImagePayloadInner(url); } finally { const next = downloadQueue.shift(); if (next) next(); else activeDownloads--; }
}
async function readRemoteImagePayloadInner(url) {
  const cached = cachedRemoteImage(url);
  if (cached) return cached;

  let latest = null;
  for (const waitMs of REMOTE_IMAGE_RETRY_DELAYS_MS) {
    if (waitMs) await sleep(waitMs);
    latest = await fetchRemoteImagePayload(url);
    if (latest?.ok) {
      rememberRemoteImage(url, latest);
      return latest;
    }
    if (!isRetryableRemoteImageResult(latest)) break;
  }
  return latest || { ok: false, error: "Image download failed" };
}

async function fetchRemoteImagePayload(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
  try {
    const fetched = await fetchRemoteImageResponse(url, controller.signal);
    if (!fetched.ok) return fetched.error;
    const { response, finalUrl, repairedSignedUrl } = fetched;
    const bytes = await security.stream(response);
    const buffer = bytes.buffer;
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image is too large (${buffer.byteLength} bytes)` };
    }
    const mime = (response.headers.get("content-type") || "").split(";")[0].trim() || guessMime(finalUrl || url);
    await security.validate(bytes, mime);
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      mime,
      fileName: guessFileName(finalUrl || url),
      bytes: buffer.byteLength,
      repairedSignedUrl
    };
  } catch (error) {
    return remoteImageFetchError(
      url,
      error?.name === "AbortError" ? "Image fetch timed out" : error?.message || String(error)
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRemoteImageResponse(url, signal) {
  const candidates = remoteImageUrlCandidates(url);
  let lastReason = "Image download failed";
  let lastStatus = null;
  let retriedSignedUrl = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const request = new Request(candidate.url, {
        signal,
        redirect: "error",
        credentials: "omit"
      });
      const response = await fetch(request);
      if (response.ok) {
        return {
          ok: true,
          response,
          finalUrl: candidate.url,
          repairedSignedUrl: candidate.repairedSignedUrl
        };
      }
      lastReason = `HTTP ${response.status}`;
      lastStatus = response.status;
      if (!shouldTryNextRemoteImageUrl(response.status, index, candidates.length)) break;
      retriedSignedUrl = retriedSignedUrl || Boolean(candidates[index + 1]?.repairedSignedUrl);
    } catch (error) {
      lastReason = error?.name === "AbortError" ? "Image fetch timed out" : error?.message || String(error);
      lastStatus = null;
      if (index >= candidates.length - 1) break;
      retriedSignedUrl = retriedSignedUrl || Boolean(candidates[index + 1]?.repairedSignedUrl);
    }
  }
  return {
    ok: false,
    error: remoteImageFetchError(url, lastReason, lastStatus, { retriedSignedUrl })
  };
}

function shouldTryNextRemoteImageUrl(status, index, candidateCount) {
  return index < candidateCount - 1 && [400, 401, 403, 404].includes(status);
}

function remoteImageUrlCandidates(url) {
  const candidates = [{ url, repairedSignedUrl: false }];
  const repaired = removeUnsignedResponseOverrideParams(url);
  if (repaired && repaired !== url) {
    candidates.push({ url: repaired, repairedSignedUrl: true });
  }
  return candidates;
}

function removeUnsignedResponseOverrideParams(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.searchParams.has("q-signature")) return null;
  const signedParams = new Set(
    (parsed.searchParams.get("q-url-param-list") || "")
      .split(";")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) return null;
  const hashIndex = url.indexOf("#", queryIndex);
  const base = url.slice(0, queryIndex + 1);
  const query = url.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex);
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
  const parts = query.split("&").filter(Boolean);
  const filtered = parts.filter((part) => {
    const rawName = part.split("=")[0] || "";
    let name = rawName.toLowerCase();
    try {
      name = decodeURIComponent(rawName).toLowerCase();
    } catch {}
    return !(name.startsWith("response-") && !signedParams.has(name));
  });
  if (filtered.length === parts.length) return null;
  return `${base}${filtered.join("&")}${hash}`;
}

function remoteImageFetchError(url, reason, status = null, details = {}) {
  let origin = "the image website";
  try {
    origin = new URL(url).origin;
  } catch {}
  const normalized = security.uiError(reason || "图片下载失败");
  const code = remoteImageErrorCode(String(reason || ""), status);
  const unavailable =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    ["NETWORK_ERROR", "TIMEOUT"].includes(code);
  const hint = unavailable
    ? `xPoster has permission, but Chrome could not download this image from ${origin}. Possible causes include network/TLS errors, blocked redirects, or source-site restrictions.${details.retriedSignedUrl ? " Retried without unsigned response-* parameters." : ""} Open the URL in a tab; if it loads, retry Check downloads or save it as a local image.`
    : `xPoster has permission, but ${origin} did not return a usable image file.`;
  return {
    ok: false,
    code,
    status,
    origin,
    error: `${normalized}. ${hint}`
  };
}

async function ensureRemoteImagePermission(url, sender = {}) {
  let origin = "";
  try {
    origin = security.publicUrl(url).origin;
  } catch {
    return { ok: false, error: "Invalid image URL" };
  }
  if (await remoteOriginAllowed(origin)) return { ok: true };
  const all = await chrome.permissions.getAll?.().catch(() => null);
  const tabId = sender.tab?.id || null;
  return {
    ok: false,
    permissionRequired: true,
    origin,
    tabId,
    grantedOrigins: all?.origins || [],
    error: `Chrome has not granted image-site access for ${origin}. Click Allow image website in the xPoster side panel, choose Allow in Chrome's prompt, then click Check downloads and Import again. This is a Chrome permission step, not an X upload failure; until it is allowed, Markdown image links cannot become uploaded images in X.`
  };
}

async function remoteImagePermissionStatus(message = {}) {
  const inputs = Array.isArray(message.origins) && message.origins.length
    ? message.origins
    : [message.origin || message.url].filter(Boolean);
  if (inputs.length > 30) return { ok: false, error: "站点数量超限" };
  const origins = Array.from(new Set(inputs.map(remoteImageOrigin).filter(Boolean)));
  const all = await chrome.permissions.getAll?.().catch(() => null);
  const statuses = await Promise.all(
    origins.map(async (origin) => ({
      origin,
      allowed: await remoteOriginAllowed(origin)
    }))
  );
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    origins,
    granted: statuses.filter((item) => item.allowed).map((item) => item.origin),
    missing: statuses.filter((item) => !item.allowed).map((item) => item.origin),
    grantedOrigins: all?.origins || []
  };
}

function remoteImageOrigin(input) {
  try {
    const parsed = new URL(String(input || ""));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {}
  try {
    const parsed = new URL(`${String(input || "").replace(/\/+$/, "")}/`);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {}
  return "";
}

function permissionOriginPattern(origin) {
  return `${String(origin || "").replace(/\/+$/, "")}/*`;
}

function permissionPatternMatchesOrigin(pattern, origin) { return security.matches(pattern, origin); }

async function remoteOriginAllowed(origin) {
  const pattern = permissionOriginPattern(origin);
  if (await chrome.permissions.contains({ origins: [pattern] }).catch(() => false)) return true;
  const all = await chrome.permissions.getAll?.().catch(() => null);
  return (all?.origins || []).some((grantedPattern) => permissionPatternMatchesOrigin(grantedPattern, origin));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let output = "";
  const chunkSize = 32768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }
  return btoa(output);
}

function guessMime(url) {
  const ext = String(url).split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      avif: "image/avif"
    }[ext] || "image/png"
  );
}

function guessFileName(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop();
    return name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `image-${Date.now()}.png`;
  } catch {
    return `image-${Date.now()}.png`;
  }
}

async function validatedData(uri) { try { const p = security.data(uri); await security.validate(p.bytes, p.mime); return { ok: true, mime: p.mime, base64: arrayBufferToBase64(p.bytes.buffer), bytes: p.bytes.length, fileName: "image" }; } catch { return { ok: false, error: "图片 data URI 验证失败" }; } }

// 草稿只有后台这个写入者。队列与代次同时覆盖保存、禁用、过期和清空。
let draftQueue = Promise.resolve();
function draftOperation(message = {}) {
  const operation = async () => {
    const key = "xposter_sidepanel_draft", prefsKey = "xposter_draft_preferences", epochKey = "xposter_draft_epoch";
    const stored = await chrome.storage.local.get([key, prefsKey, epochKey]);
    let epoch = Number(stored[epochKey] || 0);
    let prefs = stored[prefsKey] || { enabled: true, days: 7 };
    let record = stored[key];
    if (typeof record === "string") { record = { text: record, expires: Date.now() + prefs.days * 86400000 }; await chrome.storage.local.set({ [key]: record }); }
    const action = message.action || "expire";
    if (action === "configure") {
      prefs = { enabled: message.enabled === true, days: [1, 7, 30].includes(message.days) ? message.days : 7 }; epoch++;
      await chrome.storage.local.set({ [prefsKey]: prefs, [epochKey]: epoch });
      if (!prefs.enabled) { await chrome.storage.local.remove(key); record = null; }
    } else if (action === "clear") {
      epoch++; await chrome.storage.local.set({ [epochKey]: epoch }); await chrome.storage.local.remove([key, "xposter_live_result_checks"]); record = null;
    } else if (action === "write") {
      if (message.epoch !== epoch || !prefs.enabled) return { ok: false, stale: true, epoch, prefs };
      if (typeof message.text !== "string" || message.text.length > 1024 * 1024) return { ok: false, error: "草稿超出限制" };
      record = { text: message.text, expires: Date.now() + prefs.days * 86400000 };
      await chrome.storage.local.set({ [key]: record });
    }
    if (record && record.expires <= Date.now()) { await chrome.storage.local.remove(key); record = null; }
    return { ok: true, epoch, prefs, record };
  };
  const result = draftQueue.then(operation); draftQueue = result.catch(() => {}); return result;
}
function expireDraft() { return draftOperation({ action: "expire" }); }
chrome.alarms.create("xposter-expire-draft", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "xposter-expire-draft") expireDraft().catch(() => {}); });
expireDraft().catch(() => {});

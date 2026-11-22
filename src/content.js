(() => {
  const shared = window.xPosterShared;
  const security = globalThis.xPosterSecurity;
  let localFiles = {};
  let expectedTarget = null;
  function contentVersion() { return findEditor()?.textContent || ""; }
  function assertTarget(target, version) { if (location.href !== target || version !== undefined && contentVersion() !== version) throw new Error("目标文章或正文已变化，已取消导入"); }
  // 只删除旧应用记录，不宣称撤销站点已取得的目录权限。
  const cleanup = indexedDB.open("xposter_local_assets", 1);
  cleanup.onupgradeneeded = () => cleanup.result.createObjectStore("handles");
  cleanup.onsuccess = () => { const db = cleanup.result; const tx = db.transaction("handles", "readwrite"); tx.objectStore("handles").delete("vault_root"); tx.oncomplete = () => db.close(); };
  const CHANNEL_TO_MAIN = "xposter";
  const CHANNEL_FROM_MAIN = "xposter-main";
  const STATUS_ID = "__xposter_status__";
  const IMPORT_BUTTON_ID = "__xposter_import_button__";
  const DROP_HINT_ID = "__xposter_drop_hint__";
  const ORIGINAL_IMPORTER_MARKERS = [
    { label: "original import button", selector: "#__xmp_import_btn__, [id*='__xmp_import_btn__']" },
    { label: "original vault prompt", selector: "#__xmp_vault_prompt__" },
    { label: "original drop hint", selector: "#__xmp_drop_hint__" },
    { label: "original drop hint style", selector: "#__xmp_drop_hint_anim__" },
    { label: "original import style", selector: "#__xmp_import_btn_style__" },
    { label: "original status banner", selector: "#__x_md_paste_banner__" },
    { label: "original page offset style", selector: "#__x_md_paste_offset_style__" }
  ];
  const CONTENT_SCRIPT_VERSION =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "dev";

  const DEFAULT_LIMITS = {
    maxImagesPerImport: 30,
    maxTablesPerImport: Number.POSITIVE_INFINITY,
    maxTweetsPerImport: Number.POSITIVE_INFINITY,
    appendSignature: false
  };

  const state = {
    busy: false,
    lastSummary: null,
    mainReady: false
  };

  function isArticleRoute() {
    return /^https:\/\/(?:x|twitter)\.com\/compose\/articles(?:$|[/?#])/.test(location.href);
  }

  function isEditorRoute() {
    return /^https:\/\/(?:x|twitter)\.com\/compose\/articles\/edit\//.test(location.href);
  }

  function articleIdFromUrl() {
    return location.pathname.match(/\/compose\/articles\/edit\/(\d+)/)?.[1] || null;
  }

  function collectTargetContext() {
    const editor = findEditor();
    const editorText = normalizeText(editor?.innerText || editor?.textContent || "");
    return {
      url: location.href,
      pageTitle: document.title || "",
      route: isEditorRoute() ? "editor" : isArticleRoute() ? "articles" : "other",
      isArticleRoute: isArticleRoute(),
      isEditorRoute: isEditorRoute(),
      articleId: articleIdFromUrl(),
      hasEditor: Boolean(editor),
      editorTextLength: editorText.length,
      editorSample: "",
      originalImporterResidue: detectOriginalImporterResidue()
    };
  }

  function detectOriginalImporterResidue() {
    const markers = [];
    for (const marker of ORIGINAL_IMPORTER_MARKERS) {
      if (document.querySelector(marker.selector)) markers.push(marker.label);
    }
    if (document.body?.classList?.contains("__xmp_banner_visible")) {
      markers.push("original banner class");
    }
    const uniqueMarkers = Array.from(new Set(markers));
    return {
      detected: uniqueMarkers.length > 0,
      markers: uniqueMarkers,
      detail: uniqueMarkers.length
        ? `Old X Article Markdown Paste residue detected: ${uniqueMarkers.join(", ")}`
        : ""
    };
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function truncateText(text, maxLength) {
    const cleaned = normalizeText(text);
    return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(0, maxLength - 3))}...` : cleaned;
  }

  function showStatus(text, level = "work", timeout = 0) {
    text = security.uiError(text);
    let bar = document.getElementById(STATUS_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = STATUS_ID;
      document.body.appendChild(bar);
      injectStatusStyle();
    }
    bar.dataset.level = level;
    bar.textContent = text;
    document.body.classList.add("__xposter_status_visible");
    broadcast({ type: "status", text, level });
    if (timeout) window.setTimeout(hideStatus, timeout);
  }

  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
    document.body.classList.remove("__xposter_status_visible");
    broadcast({ type: "status", text: "", level: "idle" });
  }

  function injectStatusStyle() {
    if (document.getElementById("__xposter_status_style__")) return;
    const style = document.createElement("style");
    style.id = "__xposter_status_style__";
    style.textContent = `
      body.__xposter_status_visible #react-root,
      body.__xposter_status_visible > div:first-of-type {
        padding-top: 42px !important;
      }
      #${STATUS_ID} {
        position: fixed;
        z-index: 2147483647;
        top: 0;
        left: 0;
        right: 0;
        height: 42px;
        display: grid;
        place-items: center;
        color: #fbfaf7;
        font: 600 13px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
        letter-spacing: 0;
        box-shadow: 0 2px 14px rgba(32, 31, 27, 0.18);
        pointer-events: none;
      }
      #${STATUS_ID}[data-level="work"] { background: #2f6f68; }
      #${STATUS_ID}[data-level="warn"] { background: #a7552b; }
      #${STATUS_ID}[data-level="done"] { background: #3f6f42; }
      #${STATUS_ID}[data-level="error"] { background: #9d2f2f; }
    `;
    document.head.appendChild(style);
  }

  function broadcast(payload) {
    chrome.runtime
      .sendMessage({ type: "xposter:event", event: payload.type || "message", payload })
      .catch(() => {});
  }

  function waitForMainReady(timeoutMs = 5000) {
    if (state.mainReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const listener = (event) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN) return;
        if (event.data.kind === "ready") {
          state.mainReady = true;
          window.removeEventListener("message", listener);
          resolve(true);
        }
      };
      window.addEventListener("message", listener);
      const tick = () => {
        window.postMessage({ source: CHANNEL_TO_MAIN, kind: "ready?" }, location.origin);
        if (state.mainReady) return;
        if (Date.now() > deadline) {
          window.removeEventListener("message", listener);
          resolve(false);
          return;
        }
        window.setTimeout(tick, 250);
      };
      tick();
    });
  }

  function captureMainContext() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("无法锁定正文版本")); }, 3000);
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN || event.data.kind !== "context" || event.data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", listener);
        if (!event.data.token) reject(new Error("无法锁定 Draft.js 版本")); else resolve(event.data.token);
      };
      window.addEventListener("message", listener);
      window.postMessage({ source: CHANNEL_TO_MAIN, kind: "capture-context", requestId }, location.origin);
    });
  }

  function runMain(payload, filePayloads = new Map()) {
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    return new Promise((resolve, reject) => {
      let timeout = null;
      const refreshTimeout = () => {
        clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          window.removeEventListener("message", listener);
          reject(new Error("X editor bridge did not respond"));
        }, 60000);
      };
      const listener = (event) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN) return;
        const message = event.data;
        if (message.sessionId !== sessionId || Date.now() > expiresAt || location.href !== payload.targetUrl) return;
        if (message.kind === "file-request") {
          const key = message.token || message.marker;
          if (typeof message.requestId !== "string" || message.requestId.length > 100) return;
          const file = filePayloads.get(key);
          filePayloads.delete(key);
          window.postMessage(
            {
              source: CHANNEL_TO_MAIN,
              kind: "file-response",
              sessionId,
              requestId: message.requestId,
              ok: Boolean(file),
              file: file || null,
              error: file ? null : "Prepared image data was not found"
            },
            location.origin
          );
          return;
        }
        if (message.kind === "progress") {
          showStatus("X 正在处理本次导入…", "work");
          refreshTimeout();
          return;
        }
        if (message.kind === "done") {
          clearTimeout(timeout);
          window.removeEventListener("message", listener);
          resolve(message.summary || {});
          return;
        }
        if (message.kind === "error") {
          clearTimeout(timeout);
          window.removeEventListener("message", listener);
          reject(new Error(message.error || "X editor bridge failed"));
        }
      };
      window.addEventListener("message", listener);
      refreshTimeout();
      window.postMessage({ source: CHANNEL_TO_MAIN, kind: "run", sessionId, payload }, location.origin);
    });
  }

  async function importMarkdown(markdown, origin = "manual") {
    if (state.busy) return { ok: false, error: "Import already running" };
    state.busy = true;
    const startedAt = performance.now();
    showStatus("Preparing Markdown...", "work");
    try {
      if (!isArticleRoute()) throw new Error("Open X Articles first");
      if (expectedTarget && expectedTarget !== location.href) throw new Error("目标标签页已变化");
      if (origin !== "paste" && !findEditor()) {
        await ensureEditorReadyForFileImport();
      }
      if (typeof markdown !== "string" || markdown.length > 1024 * 1024) throw new Error("Markdown 超出 1 MiB 限制");
      const targetUrl = location.href;
      const version = contentVersion();
      const contextToken = await captureMainContext();
      if (!window.confirm("导入将整体替换当前文章正文。替换前会保留正文快照，可在侧边栏恢复（刷新或关闭 X 页面后失效）。是否继续？")) throw new Error("已取消替换");
      assertTarget(targetUrl, version);
      const parsed = shared.parseMarkdown(markdown);
      if (parsed.segments.length > 1000 || parsed.segments.filter(s => s.type !== "text").length > 30) throw new Error("文章资源数量超出限制");
      const { segments, dropped } = shared.applyLimits(parsed.segments, DEFAULT_LIMITS);
      const limitedParsed = { ...parsed, segments };
      const counts = shared.segmentCounts(segments);
      broadcast({ type: "parsed", parsed: { title: parsed.title, cover: parsed.cover, counts } });

      if (!(await waitForMainReady())) throw new Error("X editor bridge is not ready");

      const localImages = segments.filter((segment) => segment.type === "image" && shared.isLocalImageSource(segment.source));
      if (localImages.length) {
        await ensureVaultForLocalImages(localImages.length);
      }
      const remoteImages = segments.filter((segment) => segment.type === "image" && isRemoteHttpImageSource(segment.source));
      if (remoteImages.length) {
        const permission = await verifyRemoteImagePermissions(remoteImages);
        if (!permission.ok) {
          const prefix = origin === "sidepanel"
            ? ""
            : `${remoteImages.length} web image(s) need xPoster side-panel image permission before direct paste or file import. Direct paste cannot open Chrome's permission prompt, but it can continue after the image website has already been allowed from the side panel. `;
          throw new Error(`${prefix}${permission.error}`);
        }
      }

      const imageMap = await prepareImages(segments);
      const tableMap = await prepareTables(segments, [...imageMap.values()].reduce((sum, file) => sum + (file.bytes || 0), 0));
      const mediaFailures = collectMediaFailures(imageMap, "image").concat(collectMediaFailures(tableMap, "table"));
      if (mediaFailures.length) {
        const error = new Error(formatMediaFailureMessage(mediaFailures));
        error.mediaFailures = mediaFailures;
        throw error;
      }
      let totalBytes = 0;
      for (const file of [...imageMap.values(), ...tableMap.values()]) { totalBytes += file.bytes || Math.ceil((file.base64 || "").length * 0.75); }
      if (totalBytes > security.MAX_TOTAL) throw new Error("文章图片总量超过 64 MiB");
      assertTarget(targetUrl, version);
      const pastePlan = shared.buildPastePlan(segments, imageMap, tableMap);
      const filePayloads = streamImageFilesForMain(pastePlan);
      pastePlan.title = limitedParsed.title || null;
      pastePlan.cover = limitedParsed.cover || null;
      for (const item of pastePlan.plan) { if (item.op.source) { if (item.op.source === pastePlan.cover) pastePlan.cover = item.marker; item.op.source = item.marker; } }
      if (!pastePlan.plan.some(item => item.marker === pastePlan.cover)) pastePlan.cover = null;
      pastePlan.origin = origin;
      pastePlan.targetUrl = targetUrl;
      pastePlan.expectedText = version;
      pastePlan.contextToken = contextToken;

      if (!security.planSchema(pastePlan)) throw new Error("导入计划格式或尺寸不符合限制");
      showStatus("Writing into X editor...", "work");
      const mainSummary = await runMain(pastePlan, filePayloads);
      if (mainSummary?.imgFail) {
        const error = new Error(`${mainSummary.imgFail} image upload(s) failed in X. Review the placeholders in the article, then retry after running Check.`);
        error.mainSummary = mainSummary;
        throw error;
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      const summary = {
        ok: true,
        title: limitedParsed.title,
        cover: limitedParsed.cover,
        counts,
        dropped,
        images: summarizeMap(imageMap),
        tables: summarizeMap(tableMap),
        main: mainSummary,
        elapsedMs
      };
      state.lastSummary = summary;
      broadcast({ type: "complete", summary });
      showStatus(`Imported in ${(elapsedMs / 1000).toFixed(1)}s`, "done", 5000);
      return { ok: true, summary };
    } catch (error) {
      const message = error?.message || String(error);
      showStatus(message, "error", 8000);
      broadcast({ type: "error", error: message, mediaFailures: error?.mediaFailures || null, mainSummary: error?.mainSummary || null });
      return { ok: false, error: message };
    } finally {
      state.busy = false;
    }
  }

  async function ensureVaultForLocalImages() { if (!Object.keys(localFiles).length) throw new Error("请从扩展侧边栏选择目录并导入本地图片；旧 X 目录记录已清除，请在浏览器站点设置中撤销旧目录授权。删除记录不会撤销权限。"); }
  async function promptVaultSelection() { return { ok: false, error: "请在扩展侧边栏选择目录" }; }
  async function prepareImages(segments) {
    const images = segments.filter((segment) => segment.type === "image");
    const map = new Map();
    if (!images.length) return map;
    showStatus(`Preparing ${images.length} image(s)...`, "work");
    const concurrency = 3;
    let next = 0;
    let completed = 0;
    let bytes = 0;
    const worker = async () => {
      while (next < images.length) {
        const index = next;
        next += 1;
        const segment = images[index];
        showStatus(`Preparing image ${index + 1}/${images.length}...`, "work");
        const file = await loadImageWithRetry(segment.source, `image-${index + 1}`);
        bytes += file?.bytes || 0;
        if (bytes > security.MAX_TOTAL) throw new Error("文章图片总量超出限制");
        map.set(segment, file);
        completed += 1;
        showStatus(`Prepared ${completed}/${images.length} image(s)...`, "work");
        await sleep(120);
      }
    };
    const workers = [];
    for (let index = 0; index < Math.min(concurrency, images.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return new Map(images.map((segment) => [segment, map.get(segment)]));
  }

  function streamImageFilesForMain(pastePlan) {
    const filePayloads = new Map();
    for (const item of pastePlan.plan || []) {
      if (item?.op?.type !== "image" || !item.op.file?.base64) continue;
      const token = item.marker;
      filePayloads.set(token, { base64: item.op.file.base64, mime: item.op.file.mime, fileName: `image-${filePayloads.size + 1}.${item.op.file.mime.split("/")[1]}`, bytes: item.op.file.bytes });
      item.op.file = {
        token,
        mime: item.op.file.mime,
        fileName: `image-${filePayloads.size}.${item.op.file.mime.split("/")[1]}`,
        bytes: item.op.file.bytes || null
      };
    }
    return filePayloads;
  }

  async function loadImageWithRetry(source, fallbackName, attempts = 1) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await loadImage(source, fallbackName);
      if (last?.ok) return last;
      if (attempt < attempts && isRetryableImageError(last?.error)) {
        showStatus(`Retrying image ${fallbackName.replace("image-", "")}...`, "warn");
        await sleep(800 * attempt * attempt);
        continue;
      }
      break;
    }
    return last || { ok: false, error: "Image fetch failed", source };
  }

  function remoteImageOriginsFromSegments(segments) {
    return Array.from(
      new Set(
        segments
          .map((segment) => imageOrigin(segment.source))
          .filter(Boolean)
      )
    );
  }

  async function verifyRemoteImagePermissions(remoteImages) {
    const origins = remoteImageOriginsFromSegments(remoteImages);
    if (!origins.length) return { ok: true, origins: [] };
    try {
      const status = await chrome.runtime.sendMessage({
        type: "xposter:remote-image-permission-status",
        origins
      });
      if (status?.ok && !status.missing?.length) return { ok: true, origins, status };
      return {
        ok: false,
        origins,
        status,
        error: remoteImagePermissionMessage((status?.missing || origins).join(", "))
      };
    } catch (error) {
      return {
        ok: false,
        origins,
        error: `Could not confirm remote image permission: ${error?.message || String(error)}`
      };
    }
  }

  function isRetryableImageError(error) {
    return /fetch failed|timed out|timeout|network|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(String(error || ""));
  }

  function remoteImagePermissionMessage(origin) {
    return `Chrome has not granted image-site access for ${origin || "this image website"}. Open the xPoster side panel, click Allow image website, choose Allow in Chrome's prompt, then click Check downloads and Import again. This is a browser permission step, not an X upload failure; until it is allowed, Markdown image links cannot become uploaded images in X.`;
  }

  async function loadImage(source, fallbackName) {
    if (shared.isLocalImageSource(source)) { const file = localFiles[source]; if (!file) return { ok: false, error: "未准备本地图片" }; await security.validate(security.data(`data:${file.mime};base64,${file.base64}`).bytes, file.mime); return file; }
    try {
      const result = await chrome.runtime.sendMessage({ type: "xposter:fetch-image", url: source });
      if (!result?.ok) {
        return {
          ok: false,
          error: result?.permissionRequired
            ? remoteImagePermissionMessage(result.origin || imageOrigin(source))
            : result?.error || "Image fetch failed",
          source,
          permissionRequired: Boolean(result?.permissionRequired),
          origin: result?.origin || imageOrigin(source)
        };
      }
      return {
        ok: true,
        base64: result.base64,
        mime: result.mime,
        fileName: normalizeImageFileName(result.fileName || shared.guessFileName(source, fallbackName), fallbackName, result.mime),
        bytes: result.bytes,
        source
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), source };
    }
  }

  function isRemoteHttpImageSource(source) {
    return /^https?:\/\//i.test(String(source || "").trim());
  }

  async function prepareTables(segments, totalBytes = 0) {
    const tables = segments.filter((segment) => segment.type === "table");
    const map = new Map();
    if (!tables.length) return map;
    showStatus(`Rendering ${tables.length} table(s)...`, "work");
    for (const [index, segment] of tables.entries()) {
        try {
          const file = await shared.renderTableImage(segment, `table-${index + 1}.png`);
          totalBytes += file.bytes || 0;
          if (totalBytes > security.MAX_TOTAL) throw new Error("文章图片总量超出限制");
          map.set(segment, file);
        } catch (error) {
          map.set(segment, { ok: false, error: error?.message || String(error) });
        }
    }
    return map;
  }

  function summarizeMap(map) {
    let ok = 0;
    let fail = 0;
    for (const value of map.values()) {
      if (value?.ok) ok += 1;
      else fail += 1;
    }
    return { ok, fail };
  }

  function collectMediaFailures(map, kind) {
    const failures = [];
    let index = 0;
    for (const [segment, value] of map.entries()) {
      index += 1;
      if (value?.ok) continue;
      failures.push({
        kind,
        index,
        source: segment?.source || null,
        origin: imageOrigin(segment?.source),
        fileName: shared.guessFileName(segment?.source || "", `${kind}-${index}`),
        error: value?.error || `${kind} preparation failed`,
        permissionRequired: Boolean(value?.permissionRequired)
      });
    }
    return failures;
  }

  function formatMediaFailureMessage(failures) {
    const first = failures[0];
    const target = [first?.kind ? `${first.kind} ${first.index}` : null, first?.origin, first?.fileName]
      .filter(Boolean)
      .join(" / ");
    const permissionFailure = failures.find((failure) => failure.permissionRequired);
    if (permissionFailure) {
      return remoteImagePermissionMessage(permissionFailure.origin || first?.origin);
    }
    const remoteHint = failures.some((failure) => /^https?:\/\//i.test(String(failure?.source || "")))
      ? " Remote Markdown images are already recognized, but xPoster stops before writing to X until every image file can be downloaded. If the failed URL is a signed COS link, open it in a normal tab; if it does not load there, regenerate a public image link and retry."
      : "";
    return `${failures.length} media item(s) could not be prepared before import. First failure${target ? ` (${target})` : ""}: ${first?.error || "unknown error"}.${remoteHint}`;
  }

  function imageOrigin(source) {
    try {
      const url = new URL(String(source || ""));
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }

  function normalizeImageFileName(fileName, fallbackName, mime = "image/png") {
    const extFromMime = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/avif": "avif"
    }[String(mime || "").toLowerCase()];
    const raw = String(fileName || "").split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() || "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    const ext = (decoded.match(/\.([a-z0-9]{2,5})$/i)?.[1] || extFromMime || "png").toLowerCase();
    const base = decoded
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return `${base || fallbackName}.${ext}`;
  }

  async function onPaste() { /* 普通粘贴保留 X 原生选区行为；整体导入使用显式按钮。 */ }

  async function readMarkdownFile(file) {
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)) {
      throw new Error("Choose a Markdown file");
    }
    if (file.size > 1024 * 1024) throw new Error("Markdown 超出限制");
    return file.text();
  }

  async function importFile(file, origin = "file") {
    const targetUrl = location.href; const version = contentVersion();
    const text = await readMarkdownFile(file);
    assertTarget(targetUrl, version);
    return importMarkdown(text, origin);
  }

  async function ensureEditorReadyForFileImport() {
    if (isEditorRoute() && findEditor()) return;
    if (isEditorRoute()) await navigateToArticleList();
    if (!isArticleRoute()) {
      history.pushState(null, "", "/compose/articles");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitForUrl(/\/compose\/articles(?:$|[/?#])/, 4000);
    }
    await clickCreateButton();
    const ready = await waitForEditor(20000);
    if (!ready) throw new Error("X Article editor did not appear");
  }

  async function navigateToArticleList() {
    const link = Array.from(document.querySelectorAll("a[href='/compose/articles'], a[href$='/compose/articles']")).find(
      (element) => element.offsetParent
    );
    if (link) {
      link.click();
      if (await waitForUrl(/\/compose\/articles(?:$|[/?#])/, 5000)) return;
    }
    history.pushState(null, "", "/compose/articles");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitForUrl(/\/compose\/articles(?:$|[/?#])/, 4000);
  }

  async function clickCreateButton() {
    const labels = ["create", "compose", "撰写", "新建", "创建", "新規", "作成"];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const button = findCreateButton(labels);
      if (button) {
        button.click();
        return true;
      }
      await sleep(250);
    }
    throw new Error("Could not find the X Article create button");
  }

  function findCreateButton(labels) {
    const emptyStateButton = document.querySelector("a[data-testid='empty_state_button_text']");
    if (emptyStateButton) return emptyStateButton;
    const root = document.getElementById("root-header")?.closest("div")?.parentElement || document;
    for (const path of root.querySelectorAll("button svg path")) {
      if ((path.getAttribute("d") || "").startsWith("M14.543")) {
        const button = path.closest("button");
        if (button && button.id !== IMPORT_BUTTON_ID) return button;
      }
    }
    for (const button of document.querySelectorAll("button, a[role='button']")) {
      if (button.id === IMPORT_BUTTON_ID) continue;
      const aria = (button.getAttribute("aria-label") || "").toLowerCase().trim();
      if (labels.includes(aria)) return button;
    }
    return null;
  }

  function findEditor() {
    const editor = document.querySelector(".public-DraftEditor-content");
    return editor && editor.getBoundingClientRect().width > 200 ? editor : null;
  }

  function waitForEditor(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (findEditor()) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 250);
      };
      tick();
    });
  }

  function waitForUrl(pattern, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (pattern.test(location.href) && !isEditorRoute()) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 200);
      };
      tick();
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function installImportButton() {
    injectImportButtonStyles();
    const mount = () => {
      if (!isArticleRoute() || isEditorRoute()) {
        document.getElementById(`${IMPORT_BUTTON_ID}_wrap`)?.remove();
        return;
      }
      if (document.getElementById(IMPORT_BUTTON_ID)) return;
      const anchor = findCreateButton(["create", "compose", "撰写", "新建", "创建", "新規", "作成"]);
      if (!anchor?.parentElement?.parentElement) return;
      const button = document.createElement("button");
      button.id = IMPORT_BUTTON_ID;
      button.type = "button";
      button.title = "Import Markdown with xPoster";
      button.setAttribute("aria-label", "Import Markdown with xPoster");
      button.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 3.5A2.5 2.5 0 0 1 7.5 1H14l5 5v12.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18.5v-15Zm8 1V2.8H7.5a.7.7 0 0 0-.7.7v15a.7.7 0 0 0 .7.7h9a.7.7 0 0 0 .7-.7V7h-3.2A1.9 1.9 0 0 1 13 5.1V4.5ZM9 11h2v3.4l-1.2-1.2-1.4 1.4 2.6 2.6 2.6-2.6-1.4-1.4-1.2 1.2V11h2V9H9v2Z"/>
        </svg>
      `;
      button.addEventListener("click", () => chooseMarkdownFile("button"));
      const wrap = document.createElement("div");
      wrap.id = `${IMPORT_BUTTON_ID}_wrap`;
      wrap.appendChild(button);
      anchor.parentElement.parentElement.insertBefore(wrap, anchor.parentElement);
    };

    mount();
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    const originalPush = history.pushState;
    history.pushState = function (...args) {
      const result = originalPush.apply(this, args);
      window.setTimeout(mount, 100);
      return result;
    };
    const originalReplace = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplace.apply(this, args);
      window.setTimeout(mount, 100);
      return result;
    };
    window.addEventListener("popstate", () => window.setTimeout(mount, 100));
  }

  function injectImportButtonStyles() {
    if (document.getElementById("__xposter_import_style__")) return;
    const style = document.createElement("style");
    style.id = "__xposter_import_style__";
    style.textContent = `
      #${IMPORT_BUTTON_ID}_wrap { display: inline-flex; align-items: center; margin-right: 4px; }
      #${IMPORT_BUTTON_ID} {
        width: 38px;
        height: 38px;
        border: 0;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: transparent;
        color: currentColor;
        cursor: pointer;
      }
      #${IMPORT_BUTTON_ID}:hover { background: rgba(127, 127, 127, 0.14); }
      #${IMPORT_BUTTON_ID} svg { width: 21px; height: 21px; fill: currentColor; }
    `;
    document.head.appendChild(style);
  }

  function chooseMarkdownFile(origin) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (file) await importFile(file, origin);
    });
    document.body.appendChild(input);
    input.click();
  }

  function installDragDrop() {
    document.addEventListener("dragenter", (event) => {
      if (isXposterDropCandidate(event.dataTransfer) && isArticleRoute()) showDropHint();
    }, true);
    document.addEventListener("dragleave", (event) => {
      if (hasFiles(event.dataTransfer)) hideDropHint();
    }, true);
    document.addEventListener("drop", async (event) => {
      if (!hasFiles(event.dataTransfer) || !isArticleRoute()) return;
      const files = Array.from(event.dataTransfer.files || []);
      const markdown = files.find(isMarkdownFile);
      const directoryItem = markdown ? null : findDirectoryTransferItem(event.dataTransfer);
      if (!markdown && !directoryItem) {
        hideDropHint();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      hideDropHint();
      if (markdown) {
        await importFile(markdown, "drop");
        return;
      }
      showStatus("请在扩展侧边栏选择本地图片目录", "warn", 5000);
    }, true);
  }

  function hasFiles(dataTransfer) {
    return Boolean(dataTransfer && Array.from(dataTransfer.types || []).includes("Files"));
  }

  function isMarkdownFile(file) {
    return Boolean(file?.name && /\.(md|markdown|mdown|mkd|txt)$/i.test(file.name));
  }

  function isXposterDropCandidate(dataTransfer) {
    if (!hasFiles(dataTransfer)) return false;
    const files = Array.from(dataTransfer.files || []);
    if (files.some(isMarkdownFile)) return true;
    const items = Array.from(dataTransfer.items || []);
    return items.some(isDirectoryTransferItem);
  }

  function isLikelyImageTransferItem(item) {
    return /^image\//i.test(item?.type || "");
  }

  function findDirectoryTransferItem(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    return items.find(isDirectoryTransferItem) || null;
  }

  function isDirectoryTransferItem(item) {
    if (item?.kind !== "file" || isLikelyImageTransferItem(item)) return false;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    return Boolean(entry?.isDirectory);
  }

  async function getDirectoryHandle(item) {
    if (typeof item?.getAsFileSystemHandle !== "function") return null;
    try {
      const handle = await item.getAsFileSystemHandle();
      return handle?.kind === "directory" ? handle : null;
    } catch {
      return null;
    }
  }

  function showDropHint() {
    if (document.getElementById(DROP_HINT_ID)) return;
    const hint = document.createElement("div");
    hint.id = DROP_HINT_ID;
    hint.textContent = "Drop Markdown to import, or a folder to set local image folder";
    hint.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483646",
      "max-width:260px",
      "padding:12px 14px",
      "background:#fbfaf7",
      "color:#201f1b",
      "border:1px solid #d8d2c6",
      "box-shadow:0 16px 40px rgba(32,31,27,.18)",
      "font:600 13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
    ].join(";");
    document.body.appendChild(hint);
  }

  function hideDropHint() {
    document.getElementById(DROP_HINT_ID)?.remove();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "xposter:import-markdown") {
      if (state.busy) { sendResponse({ ok: false, error: "导入正在进行" }); return false; }
      localFiles = message.localFiles || {}; expectedTarget = message.targetUrl;
      importMarkdown(message.markdown || "", "sidepanel").then(sendResponse).finally(() => { localFiles = {}; expectedTarget = null; });
      return true;
    }
    if (message?.type === "xposter:analyze-markdown") {
      try {
        const parsed = shared.parseMarkdown(message.markdown || "");
        sendResponse({ ok: true, parsed: { title: parsed.title, cover: parsed.cover, counts: shared.segmentCounts(parsed.segments) } });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return false;
    }
    if (message?.type === "xposter:page-status") {
      getVaultStatus().then((vault) =>
        sendResponse({
          ok: true,
          contentScriptVersion: CONTENT_SCRIPT_VERSION,
          url: location.href,
          isArticleRoute: isArticleRoute(),
          isEditorRoute: isEditorRoute(),
          hasEditor: Boolean(findEditor()),
          busy: state.busy,
          lastSummary: state.lastSummary,
          targetContext: collectTargetContext(),
          originalImporterResidue: detectOriginalImporterResidue(),
          vault
        })
      );
      return true;
    }
    if (message?.type === "xposter:diagnostics") {
      collectDiagnostics().then(sendResponse);
      return true;
    }
    if (message?.type === "xposter:choose-file") {
      chooseMarkdownFile("sidepanel");
      sendResponse({
        ok: true
      });
      return false;
    }
    if (message?.type === "xposter:clear-records") {
      if (state.busy) { sendResponse({ ok: false, error: "导入正在进行" }); return false; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { window.removeEventListener("message", listener); sendResponse({ ok: false, error: "清理超时" }); }, 2500);
      const listener = event => { if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN || event.data.kind !== "clear-result" || event.data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", listener); if (event.data.ok) state.lastSummary = null; sendResponse({ ok: event.data.ok === true }); };
      window.addEventListener("message", listener); window.postMessage({ source: CHANNEL_TO_MAIN, kind: "clear-records", requestId }, location.origin); return true;
    }
    if (message?.type === "xposter:restore") {
      if (!confirm("恢复导入前的正文快照？当前正文将被替换。")) { sendResponse({ ok: false, error: "已取消恢复" }); return false; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { window.removeEventListener("message", listener); sendResponse({ ok: false, error: "恢复超时" }); }, 2500);
      const listener = event => { if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN || event.data.kind !== "restore-result" || event.data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", listener); sendResponse({ ok: event.data.ok === true, error: event.data.ok ? null : "当前文章没有可用快照，或导入正在进行；刷新会清除快照" }); };
      window.addEventListener("message", listener);
      window.postMessage({ source: CHANNEL_TO_MAIN, kind: "restore", requestId, targetUrl: location.href }, location.origin);
      return true;
    }
    if (message?.type === "xposter:choose-vault") {
      sendResponse({ ok: false, error: "请在扩展侧边栏选择目录；X 源目录授权入口已迁移" });
      return false;
    }
    if (message?.type === "xposter:clear-vault") {
      clearVault().then(sendResponse);
      return true;
    }
    return false;
  });

  async function getVaultStatus() { return { configured: false, extensionOnly: true }; }
  async function clearVault() { return { ok: true }; }
  async function collectDiagnostics() {
    const vault = await getVaultStatus();
    const main = await diagnoseMainWorld();
    return {
      ok: true,
      contentScript: true,
      contentScriptVersion: CONTENT_SCRIPT_VERSION,
      url: location.href,
      isArticleRoute: isArticleRoute(),
      isEditorRoute: isEditorRoute(),
      hasEditorElement: Boolean(findEditor()),
      importButtonMounted: Boolean(document.getElementById(IMPORT_BUTTON_ID)),
      originalImporterResidue: detectOriginalImporterResidue(),
      busy: state.busy,
      mainReady: state.mainReady,
      targetContext: collectTargetContext(),
      vault,
      main
    };
  }

  function diagnoseMainWorld() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", listener);
        resolve(value);
      };
      const listener = (event) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_FROM_MAIN) return;
        if (event.data.kind !== "diagnostics") return;
        state.mainReady = true;
        finish(event.data.payload || { ok: true });
      };
      window.addEventListener("message", listener);
      window.postMessage({ source: CHANNEL_TO_MAIN, kind: "diagnostics" }, location.origin);
      window.setTimeout(() => finish({ ok: false, error: "MAIN world bridge timeout" }), 2500);
    });
  }

  document.addEventListener("paste", onPaste, { capture: true });
  installImportButton();
  installDragDrop();
  waitForMainReady(2000).catch(() => {});
  console.log("[xPoster] content script ready");
})();

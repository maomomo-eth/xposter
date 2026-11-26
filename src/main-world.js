(() => {
  const security = globalThis.xPosterSecurity;
  let activeSession = null;
  let inputRevision = 0;
  const snapshots = new Map();
  const contextTokens = new Map();
  // 只将实际目标正文变化视为冲突；光标、其他输入框和同 URL 的历史状态更新不算正文编辑。
  function blockRecord(content, block) {
    const entities = [];
    const chars = block.getCharacterList();
    chars.forEach(character => { const key = character.getEntity?.(); if (key != null && !entities.some(item => item[0] === key)) { const entity = content.getEntity(key); entities.push([key, entity.getType(), activeSession?.ownedMedia?.has(key) ? "本次上传媒体状态" : entity.getData()]); } });
    return JSON.stringify({ type: block.getType(), text: block.getText(), depth: block.getDepth?.() || 0, data: block.getData?.()?.toJS?.() || {}, chars: chars.toJS?.() || [], entities });
  }
  function contentRecords(content) { const records = new Map(); content.getBlockMap().forEach((block, key) => records.set(key, blockRecord(content, block))); return records; }
  function sameRecords(left, right) { return left.size === right.size && [...left].every(([key, value], i) => [...right.keys()][i] === key && right.get(key) === value); }
  function acceptContent(node, content) {
    activeSession.node = node; activeSession.content = content; activeSession.records = contentRecords(content);
  }
  function allowedUpload(content, pending) {
    const current = contentRecords(content); let media = 0, blanks = 0;
    for (const [key, record] of pending.records) {
      if (key !== pending.markerKey && current.get(key) !== record) return false;
    }
    const stable = [...pending.records.keys()].filter(key => key !== pending.markerKey);
    const present = [...current.keys()].filter(key => pending.records.has(key) && key !== pending.markerKey);
    if (JSON.stringify(stable) !== JSON.stringify(present)) return false;
    let valid = true;
    content.getBlockMap().forEach((block, key) => {
      if (pending.records.has(key) && key !== pending.markerKey) return;
      if (key === pending.markerKey && current.get(key) === pending.records.get(key)) return;
      if (block.getType() === "atomic") {
        let hasMedia = false;
        block.getCharacterList().forEach(character => { const entityKey = character.getEntity?.(); if (entityKey != null && content.getEntity(entityKey).getType() === "MEDIA") hasMedia = true; });
        if (!hasMedia || ++media > 1) valid = false;
      } else if (!block.getText().trim() && block.getType() === "unstyled" && ++blanks <= 2) { /* X 上传可新增空段落。 */ }
      else valid = false;
    });
    if (!current.has(pending.markerKey) && !media) return false;
    return valid;
  }
  for (const method of ["pushState", "replaceState"]) { const original = history[method]; history[method] = function (...args) { const before = location.href; const result = original.apply(this, args); if (location.href !== before) inputRevision++; return result; }; }
  window.addEventListener("popstate", () => { if (activeSession && location.href !== activeSession.url) inputRevision++; });
  function assertContext() {
    if (!activeSession) return;
    if (location.href !== activeSession.url || inputRevision !== activeSession.revision || Date.now() > activeSession.expires) throw new Error("文章或导航上下文已变化，导入取消");
    if (!activeSession.node) return;
    const node = findDraftStateNode();
    if (node !== activeSession.node || findEditorElement() !== activeSession.element) throw new Error("目标编辑器已变化，导入取消");
    const content = node.props.editorState.getCurrentContent();
    // 即使没有 trusted 输入事件，程序替换正文也必须核对内容；选择状态变化可保留。
    const records = contentRecords(content);
    const seeded = activeSession.seed && content.getPlainText?.() === "x" && records.size === 1 && content.getBlockMap().find(block => block.getType() === "unstyled" && block.getText() === "x");
    const ownWrite = activeSession.write && sameRecords(records, activeSession.write.records);
    if (!sameRecords(records, activeSession.records) && !ownWrite && !seeded && !(activeSession.upload && allowedUpload(content, activeSession.upload))) throw new Error("正文版本已变化，导入取消");
    activeSession.content = content; activeSession.records = records;
  }
  async function changeDraft(node, state) {
    assertContext();
    if (activeSession.write) throw new Error("上一笔正文写入尚未确认");
    const pending = { records: contentRecords(state.getCurrentContent()) };
    activeSession.write = pending;
    try {
      // onChange 只提交更新请求；React 回写 props 后才承认本次正文和选区已生效。
      node.props.onChange(state);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        assertContext();
        const actual = node.props.editorState;
        const selection = actual.getSelection();
        const expectedSelection = state.getSelection();
        const selectionReady = selection === expectedSelection || selection.equals?.(expectedSelection);
        if (sameRecords(activeSession.records, pending.records) && selectionReady) return;
        await sleep(25);
      }
      throw new Error("X 编辑器未确认正文或选区写入，导入已停止");
    } finally {
      if (activeSession.write === pending) activeSession.write = null;
    }
  }
  const LOG = "[xPoster MAIN]";
  const CHANNEL_TO_MAIN = "xposter";
  const CHANNEL_FROM_MAIN = "xposter-main";
  const EDITOR_SELECTOR =
    "[data-contents='true'] [contenteditable='true'], [contenteditable='true'][role='textbox'], [contenteditable='true'].public-DraftEditor-content, [contenteditable='true']";

  const sleep = async (ms) => { await new Promise(resolve => setTimeout(resolve, ms)); assertContext(); };

  function post(kind, payload = {}) {
    window.postMessage({ source: CHANNEL_FROM_MAIN, kind, sessionId: activeSession?.id, ...payload }, location.origin);
  }

  function progress(text, level = "work") {
    post("progress", { text, level });
  }

  function requestPreparedFile(operation, timeoutMs = 30000) {
    const token = operation?.op?.file?.token || operation?.marker || "";
    if (operation?.op?.file?.base64) return Promise.resolve(operation.op.file);
    if (!token) return Promise.reject(new Error("Prepared image token is missing"));
    const requestId = `file_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", listener);
        reject(new Error("Prepared image data did not arrive"));
      }, timeoutMs);
      const listener = (event) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_TO_MAIN) return;
        const message = event.data;
        if (message.kind !== "file-response" || message.requestId !== requestId || message.sessionId !== activeSession?.id) return;
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        if (message.ok && typeof message.file?.base64 === "string" && message.file.base64.length <= Math.ceil(security.MAX_BYTES * 4 / 3) && /^image\/(png|jpeg|gif|webp)$/.test(message.file.mime)) { try { assertContext(); resolve(message.file); } catch (error) { reject(error); } }
        else reject(new Error(message.error || "Prepared image data was not available"));
      };
      window.addEventListener("message", listener);
      post("file-request", { requestId, token, marker: operation.marker });
    });
  }

  function imageSourcesMatch(left, right) {
    const leftRaw = String(left || "").trim();
    const rightRaw = String(right || "").trim();
    if (!leftRaw || !rightRaw) return false;
    if (leftRaw === rightRaw) return true;
    try {
      const leftUrl = new URL(leftRaw, location.href);
      const rightUrl = new URL(rightRaw, location.href);
      leftUrl.hash = "";
      rightUrl.hash = "";
      return decodeURIComponent(leftUrl.href) === decodeURIComponent(rightUrl.href);
    } catch {
      return leftRaw.split("#")[0] === rightRaw.split("#")[0];
    }
  }

  function findEditorElement() {
    for (const element of document.querySelectorAll(EDITOR_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 80) return element;
    }
    return null;
  }

  function findDraftStateNode() {
    const editor = findEditorElement();
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;
    let fiber = editor[fiberKey];
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      const stateNode = fiber.stateNode;
      if (stateNode?.props?.editorState && typeof stateNode.props.onChange === "function") {
        return stateNode;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function findOnFilesAdded() {
    const editor = findEditorElement();
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;
    let fiber = editor[fiberKey];
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (typeof props?.onFilesAdded === "function") return props.onFilesAdded;
      fiber = fiber.return;
    }
    return null;
  }

  function pasteHtml(html, plain) {
    const editor = findEditorElement();
    if (!editor) return false;
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", plain || html.replace(/<[^>]*>/g, ""));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    if (event.clipboardData !== data) {
      Object.defineProperty(event, "clipboardData", { value: data });
    }
    return editor.dispatchEvent(event);
  }

  function isDraftCharacterMetadata(character, requireStyle = true) {
    return Boolean(character?.set && (!requireStyle || character.getStyle));
  }

  function firstCharacterMetadata(block, requireStyle = true) {
    const characterList = block?.getCharacterList?.();
    if (!characterList) return null;
    if (typeof characterList.find === "function") {
      const found = characterList.find((character) => isDraftCharacterMetadata(character, requireStyle));
      if (found) return found;
    }
    const size =
      typeof characterList.size === "number"
        ? characterList.size
        : typeof characterList.count === "function"
          ? characterList.count()
          : 0;
    for (let index = 0; index < size; index += 1) {
      const character = characterList.get?.(index);
      if (isDraftCharacterMetadata(character, requireStyle)) return character;
    }
    const first = characterList.first?.() || characterList.get?.(0);
    return isDraftCharacterMetadata(first, requireStyle) ? first : null;
  }

  function findDraftCharacterSample(draftNode) {
    const blockMap = draftNode?.props?.editorState?.getCurrentContent?.()?.getBlockMap?.();
    if (!blockMap?.find) return null;
    const block = blockMap.find((candidate) => Boolean(firstCharacterMetadata(candidate))) || null;
    return block ? { block, character: firstCharacterMetadata(block) } : null;
  }

  function findDraftSampleBlock(draftNode) {
    return findDraftCharacterSample(draftNode)?.block || null;
  }

  async function ensureDraftCharacterSample(draftNode) {
    if (findDraftSampleBlock(draftNode)) return draftNode;
    const editor = findEditorElement();
    if (!editor) return draftNode;

    editor.focus();
    const before = draftNode.props.editorState.getCurrentContent();
    if ((before.getPlainText?.() || "").trim()) throw new Error("现有正文缺少可用字符样本，已停止替换");
    activeSession.seed = true;
    document.execCommand("insertText", false, "x");

    const deadline = Date.now() + 1600;
    while (Date.now() < deadline) {
      await sleep(80);
      const latestNode = findDraftStateNode() || draftNode;
      if (findDraftSampleBlock(latestNode)) { activeSession.seed = false; return latestNode; }
    }
    activeSession.seed = false;
    return findDraftStateNode() || draftNode;
  }

  async function writeDraftBlocks(draftNode, blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return { ok: false, error: "No structured blocks" };

    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const sample = findDraftCharacterSample(draftNode);
    const sampleBlock = sample?.block || null;
    const sampleCharacter = sample?.character || null;
    if (!sampleBlock || !sampleCharacter) return { ok: false, error: "No Draft.js character sample for structured write" };

    const BlockMap = blockMap.constructor;
    const CharacterList = sampleBlock.getCharacterList().constructor;
    if (!sampleCharacter?.set || !sampleCharacter.getStyle) return { ok: false, error: "No Draft.js character metadata sample for structured write" };

    let nextContent = contentState;
    let nextBlockMap = BlockMap();
    const createdKeys = [];

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index] || {};
      const text = String(block.text || "");
      const key = `${Math.random().toString(36).slice(2, 7)}${index.toString(36)}`;
      let characterList = CharacterList();
      const entityRanges = new Map();

      for (const link of block.links || []) {
        if (!security.safeLink(link.url)) continue;
        const offset = Number(link.offset) || 0;
        const length = Math.max(0, Number(link.length) || 0);
        if (!length || !link.url) continue;
        nextContent = nextContent.createEntity("LINK", "MUTABLE", { url: String(link.url) });
        entityRanges.set(`${offset}:${offset + length}`, nextContent.getLastCreatedEntityKey());
      }

      for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
        const styleNames = (block.inlineStyleRanges || [])
          .filter((range) => charIndex >= range.offset && charIndex < range.offset + range.length)
          .map((range) => draftInlineStyleName(range.style))
          .filter(Boolean);
        let entity = null;
        for (const [range, entityKey] of entityRanges.entries()) {
          const [start, end] = range.split(":").map(Number);
          if (charIndex >= start && charIndex < end) {
            entity = entityKey;
            break;
          }
        }
        let style = sampleCharacter.getStyle().clear();
        for (const styleName of styleNames) style = style.add(styleName);
        characterList = characterList.push(sampleCharacter.set("style", style).set("entity", entity));
      }

      const nextBlock = sampleBlock.merge({
        key,
        type: block.type || "unstyled",
        text,
        characterList,
        depth: block.type === "unordered-list-item" || block.type === "ordered-list-item" ? 0 : 0,
        data: sampleBlock.getData?.()?.clear?.() || sampleBlock.getData?.()
      });
      nextBlockMap = nextBlockMap.set(key, nextBlock);
      createdKeys.push(key);
    }

    if (!createdKeys.length) return { ok: false, error: "No Draft.js blocks created" };
    const lastKey = createdKeys[createdKeys.length - 1];
    const selection = SelectionState.createEmpty(lastKey);
    const nextState = nextContent
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextState, "insert-fragment");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    await changeDraft(draftNode, nextEditorState);
    return { ok: true, blocks: createdKeys.length };
  }

  function draftInlineStyleName(style) {
    return (
      {
        Bold: "BOLD",
        Italic: "ITALIC",
        Strikethrough: "STRIKETHROUGH",
        Code: "CODE"
      }[style] || style
    );
  }

  function findMarkerLocation(contentState, marker, options = {}) {
    const needle = String(marker || "");
    if (!needle) return null;
    let exact = null;
    let partial = null;
    contentState.getBlockMap().forEach((block, key) => {
      if (block.getType() === "atomic") return;
      const text = block.getText() || "";
      const offset = text.indexOf(needle);
      if (offset < 0) return;
      const candidate = {
        blockKey: key,
        offset,
        length: needle.length,
        exact: text.trim() === needle
      };
      if (candidate.exact && !exact) exact = candidate;
      else if (!partial) partial = candidate;
    });
    if (exact) return exact;
    return options.exactOnly ? null : partial;
  }

  function findMarkerBlock(contentState, marker, options = {}) {
    const location = findMarkerLocation(contentState, marker, options);
    return location ? location.blockKey : null;
  }

  function markerTokenPattern(markerPrefix) {
    const prefix = String(markerPrefix || "__XPOSTER_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${prefix}[A-Z]+_\\d+__`, "g");
  }

  function allMarkerTokenPattern() {
    return /__XPOSTER_[A-Za-z0-9]+_[A-Z]+_\d+__/g;
  }

  function normalizeMediaIdValue(value) {
    if (value == null) return null;
    const str = String(value).trim();
    return /^\d{5,40}$/.test(str) ? str : null;
  }

  function mediaIdFromEntityData(data = {}, depth = 0) {
    if (data == null || depth > 5) return null;
    const primitive = normalizeMediaIdValue(data);
    if (primitive) return primitive;
    if (typeof data !== "object") return null;

    if (Array.isArray(data)) {
      for (const item of data) {
        const mediaId = mediaIdFromEntityData(item, depth + 1);
        if (mediaId) return mediaId;
      }
      return null;
    }

    const directKeys = [
      "mediaId",
      "mediaID",
      "media_id",
      "media_id_string",
      "mediaIdString",
      "mediaKey",
      "media_key",
      "id_str",
      "id",
      "rest_id"
    ];
    for (const key of directKeys) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const mediaId = normalizeMediaIdValue(data[key]);
      if (mediaId) return mediaId;
    }

    const containerKeys = [
      "mediaItems",
      "media_items",
      "mediaItem",
      "media_item",
      "media",
      "upload",
      "uploadResult",
      "result"
    ];
    for (const key of containerKeys) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const mediaId = mediaIdFromEntityData(data[key], depth + 1);
      if (mediaId) return mediaId;
    }

    for (const value of Object.values(data)) {
      const mediaId = mediaIdFromEntityData(value, depth + 1);
      if (mediaId) return mediaId;
    }
    return null;
  }

  function mediaEntityDataSignature(data) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(data, (key, value) => {
        if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
        if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}...` : value;
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[circular]";
          seen.add(value);
        }
        return value;
      }).slice(0, 1200);
    } catch {
      if (!data || typeof data !== "object") return String(data || "");
      try {
        return Object.keys(data).sort().join("|");
      } catch {
        return "";
      }
    }
  }

  function refreshUploadMediaId(draftNode, upload) {
    if (!upload) return null;
    if (upload.mediaId) return upload.mediaId;
    const contentState = draftNode?.props?.editorState?.getCurrentContent?.();
    if (!contentState) return null;
    const blockMap = contentState.getBlockMap();
    let info = null;
    if (upload.blockKey && blockMap.has(upload.blockKey)) {
      const block = blockMap.get(upload.blockKey);
      if (block?.getType() === "atomic") {
        block.findEntityRanges(
          (c) => Boolean(c.getEntity()),
          (start) => {
            if (info?.mediaId) return;
            const entityKey = block.getCharacterList().get(start)?.getEntity?.();
            if (!entityKey) return;
            try {
              const entity = contentState.getEntity(entityKey);
              if (entity.getType() !== "MEDIA") return;
              const data = entity.getData();
              info = { entityKey, blockKey: upload.blockKey, mediaId: mediaIdFromEntityData(data) };
            } catch {}
          }
        );
      }
    }
    if (!info && upload.entityKey) {
      try {
        const entity = contentState.getEntity(upload.entityKey);
        if (entity.getType() === "MEDIA") {
          const data = entity.getData();
          info = { entityKey: upload.entityKey, blockKey: upload.blockKey || null, mediaId: mediaIdFromEntityData(data) };
        }
      } catch {}
    }
    if (!info) return null;
    if (info.entityKey) upload.entityKey = info.entityKey;
    if (info.blockKey) upload.blockKey = info.blockKey;
    if (info.mediaId) upload.mediaId = info.mediaId;
    return upload.mediaId || null;
  }

  async function waitForUploadMediaId(draftNode, upload, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let latestNode = draftNode;
    while (Date.now() < deadline) {
      latestNode = findDraftStateNode() || latestNode;
      if (refreshUploadMediaId(latestNode, upload)) return { draftNode: latestNode, mediaId: upload.mediaId };
      await sleep(300);
    }
    latestNode = findDraftStateNode() || latestNode;
    refreshUploadMediaId(latestNode, upload);
    return { draftNode: latestNode, mediaId: upload?.mediaId || null };
  }

  async function placeSelectionAtEnd(draftNode) {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const nextState = EditorState.moveSelectionToEnd(editorState);
    await changeDraft(draftNode, nextState);
    return true;
  }

  async function uploadCoverImageForMetadata(draftNode, imageOperation, existingAtomicBlocks, context = {}) {
    if (!findOnFilesAdded()) return { ok: false, error: "X upload handler was not reachable" };

    const before = existingMediaEntities(draftNode.props.editorState.getCurrentContent());
    let preparedFile;
    try {
      preparedFile = await requestPreparedFile(imageOperation);
    } catch (error) {
      return { ok: false, error: error?.message || "Prepared image data was not available" };
    }

    const file = base64ToFile(preparedFile.base64, preparedFile.fileName, preparedFile.mime);

    draftNode = findDraftStateNode() || draftNode;
    await placeSelectionAtEnd(draftNode);
    await sleep(80);
    const onFilesAdded = findOnFilesAdded();
    if (!onFilesAdded) return { ok: false, error: "X upload handler was not reachable" };

    assertContext();
    activeSession.upload = { markerKey: null, records: new Map(activeSession.records) };
    try {
      onFilesAdded([file]);
    } catch (error) {
      activeSession.upload = null;
      return { ok: false, error: error?.message || "X upload handler failed" };
    }

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(350);
      draftNode = findDraftStateNode() || draftNode;
      const contentState = draftNode.props.editorState.getCurrentContent();
      let found = null;
      contentState.getBlockMap().forEach((block, blockKey) => {
        if (found || block.getType() !== "atomic") return;
        if (existingAtomicBlocks.has(blockKey)) return;
        block.findEntityRanges(
          (character) => Boolean(character.getEntity()),
          (start) => {
            const entityKey = block.getCharacterList().get(start)?.getEntity?.();
            if (!entityKey || before.has(entityKey)) return;
            try {
              const entity = contentState.getEntity(entityKey);
              if (entity.getType() !== "MEDIA") return;
              const data = entity.getData();
              const mediaId = mediaIdFromEntityData(data);
              found = { entityKey, blockKey, mediaId };
            } catch {}
          }
        );
      });
      if (found) {
        assertContext();
        activeSession.ownedMedia.add(found.entityKey);
        acceptContent(draftNode, contentState);
        activeSession.upload = null;
        existingAtomicBlocks.add(found.blockKey);
        return { ok: true, ...found, settled: true };
      }
    }

    activeSession.upload = null;
    return { ok: false, error: "Timed out waiting for X media upload" };
  }

  async function cleanupTemporaryCoverBlock(draftNode, blockKey, summary, delayMs = 0) {
    if (!blockKey) return draftNode;
    if (delayMs) await sleep(delayMs);
    let nextDraftNode = findDraftStateNode() || draftNode;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const deleteResult = await deleteBlockByKey(nextDraftNode, blockKey);
      summary.cover.bodyBlockDeleted = deleteResult;
      if (deleteResult.ok) return nextDraftNode;
      if (attempt < 2) {
        await sleep(200);
        nextDraftNode = findDraftStateNode() || nextDraftNode;
      }
    }
    return nextDraftNode;
  }

  async function settleUploadedImageAtMarker(draftNode, upload, protectedAtomicBlocks) {
    if (!upload || upload.coverOnly) {
      return { draftNode, moved: 0, missing: 0, markerCleaned: 0 };
    }
    const relocateResult = await relocateImages(draftNode, [upload], protectedAtomicBlocks);
    if (relocateResult.moved || relocateResult.missing) {
      await sleep(100);
      draftNode = findDraftStateNode() || draftNode;
    }
    const markerCleaned = relocateResult.missing ? 0 : Number(await replaceMarkerText(draftNode, upload.marker, ""));
    if (markerCleaned) {
      await sleep(80);
      draftNode = findDraftStateNode() || draftNode;
    }
    return {
      draftNode,
      moved: relocateResult.moved,
      missing: relocateResult.missing,
      markerCleaned
    };
  }

  function countBlocksStartingWith(draftNode, prefix) {
    if (!draftNode || !prefix) return 0;
    let count = 0;
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block) => {
        if ((block.getText() || "").trim().startsWith(prefix)) count += 1;
      });
    return count;
  }

  async function waitForDraftMarkers(markerPrefix, expectedCount, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latestNode = findDraftStateNode();
      if (latestNode && countBlocksStartingWith(latestNode, markerPrefix) >= expectedCount) {
        return latestNode;
      }
      await sleep(100);
    }
    return findDraftStateNode();
  }

  function replaceMarkerWithAtomic(contentState, marker, entityType, data, mutability, sampleBlock) {
    const blockKey = findMarkerBlock(contentState, marker);
    if (!blockKey) return { ok: false, error: `Marker not found: ${marker}`, contentState };

    const markerBlock = contentState.getBlockMap().get(blockKey);
    const blockTemplate = markerBlock || sampleBlock;
    const characterList = markerBlock.getCharacterList();
    const markerCharacter = firstCharacterMetadata(markerBlock, false);
    const fallbackCharacter = firstCharacterMetadata(sampleBlock, false);
    const sampleCharacter = markerCharacter?.set ? markerCharacter : fallbackCharacter;
    if (!sampleCharacter?.set) return { ok: false, error: `No Draft.js character sample for marker: ${marker}`, contentState };
    const CharacterList = characterList.constructor;

    const withEntity = contentState.createEntity(entityType, mutability || "IMMUTABLE", data || {});
    const entityKey = withEntity.getLastCreatedEntityKey();
    const character = sampleCharacter.set("entity", entityKey);
    const atomicBlock = blockTemplate.merge({
      key: blockKey,
      type: "atomic",
      text: " ",
      characterList: CharacterList([character]),
      depth: 0
    });
    const blockMap = withEntity.getBlockMap().set(blockKey, atomicBlock);
    return { ok: true, entityKey, contentState: withEntity.set("blockMap", blockMap) };
  }

  async function insertAtomicBatch(draftNode, operations) {
    if (!operations.length) return { okCount: 0, failCount: 0, errors: [] };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    let contentState = editorState.getCurrentContent();
    const sampleBlock = findDraftSampleBlock(draftNode);
    let okCount = 0;
    const errors = [];

    for (const item of operations) {
      const result = replaceMarkerWithAtomic(
        contentState,
        item.marker,
        item.op.entityType,
        item.op.data || {},
        item.op.mutability || "IMMUTABLE",
        sampleBlock
      );
      if (result.ok) {
        contentState = result.contentState;
        okCount += 1;
      } else {
        errors.push(result.error);
      }
    }

    if (okCount > 0) {
      const lastKey = contentState.getBlockMap().last().getKey();
      const selection = SelectionState.createEmpty(lastKey);
      const nextContent = contentState.set("selectionBefore", selection).set("selectionAfter", selection);
      let nextEditorState = EditorState.push(editorState, nextContent, "insert-fragment");
      nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
      await changeDraft(draftNode, nextEditorState);
    }

    return { okCount, failCount: errors.length, errors };
  }

  function base64ToFile(base64, fileName, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], fileName, { type: mime });
  }

  function existingMediaEntities(contentState) {
    const entities = new Set();
    contentState.getBlockMap().forEach((block) => {
      if (block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            if (contentState.getEntity(entityKey).getType() === "MEDIA") entities.add(entityKey);
          } catch {}
        }
      );
    });
    return entities;
  }

  async function placeSelectionAtMarker(draftNode, marker) {
    const editorState = draftNode.props.editorState;
    const SelectionState = editorState.getSelection().constructor;
    const EditorState = editorState.constructor;
    const contentState = editorState.getCurrentContent();
    const location = findMarkerLocation(contentState, marker);
    if (!location) return null;
    const selection = SelectionState.createEmpty(location.blockKey).merge({
      anchorOffset: location.offset,
      focusOffset: location.offset
    });
    await changeDraft(draftNode, EditorState.forceSelection(editorState, selection));
    return location;
  }

  async function uploadImageAtMarker(draftNode, imageOperation, existingAtomicBlocks) {
    if (imageOperation.op?.coverOnly) {
      return uploadCoverImageForMetadata(draftNode, imageOperation, existingAtomicBlocks);
    }
    if (!findOnFilesAdded()) return { ok: false, error: "X upload handler was not reachable" };

    const markerLocation = await placeSelectionAtMarker(draftNode, imageOperation.marker);
    if (!markerLocation) {
      return { ok: false, error: "Image placeholder was not found in the X editor" };
    }
    await sleep(80);

    const before = existingMediaEntities(draftNode.props.editorState.getCurrentContent());
    let preparedFile;
    try {
      preparedFile = await requestPreparedFile(imageOperation);
    } catch (error) {
      return { ok: false, error: error?.message || "Prepared image data was not available" };
    }
    const file = base64ToFile(preparedFile.base64, preparedFile.fileName, preparedFile.mime);

    assertContext();
    const onFilesAdded = findOnFilesAdded();
    if (!onFilesAdded) return { ok: false, error: "X upload handler was not reachable" };
    activeSession.upload = { markerKey: markerLocation.blockKey, records: new Map(activeSession.records) };
    try {
      onFilesAdded([file]);
    } catch (error) {
      activeSession.upload = null;
      return { ok: false, error: error?.message || "X upload handler failed" };
    }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(350);
      draftNode = findDraftStateNode() || draftNode;
      const contentState = draftNode.props.editorState.getCurrentContent();
      let found = null;
      contentState.getBlockMap().forEach((block, blockKey) => {
        if (found || block.getType() !== "atomic") return;
        if (existingAtomicBlocks.has(blockKey)) return;
        block.findEntityRanges(
          (character) => Boolean(character.getEntity()),
          (start) => {
            const entityKey = block.getCharacterList().get(start)?.getEntity?.();
            if (!entityKey || before.has(entityKey)) return;
            try {
              const entity = contentState.getEntity(entityKey);
              if (entity.getType() !== "MEDIA") return;
              const data = entity.getData();
              const mediaId = mediaIdFromEntityData(data);
              found = { entityKey, blockKey, mediaId };
            } catch {}
          }
        );
      });
      if (found) {
        assertContext();
        activeSession.ownedMedia.add(found.entityKey);
        acceptContent(draftNode, contentState);
        activeSession.upload = null;
        existingAtomicBlocks.add(found.blockKey);
        return {
          ok: true,
          ...found,
          markerBlock: markerLocation.blockKey,
          markerOffset: markerLocation.offset,
          markerLength: markerLocation.length,
          markerExact: markerLocation.exact
        };
      }
    }

    activeSession.upload = null;
    return { ok: false, error: "Timed out waiting for X media upload" };
  }

  async function replaceMarkerText(draftNode, marker, text, link = "") {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const location = findMarkerLocation(contentState, marker);
    if (!location) return false;
    const blockKey = location.blockKey;
    const block = blockMap.get(blockKey);
    const originalText = block.getText() || "";
    const nextText = location.exact
      ? text
      : `${originalText.slice(0, location.offset)}${text}${originalText.slice(location.offset + location.length)}`;
    if (!nextText.trim()) {
      await deleteBlockByKey(draftNode, blockKey);
      return true;
    }
    const characterFactory = block.getCharacterList().get(0)?.constructor;
    const character = characterFactory ? characterFactory.create({}) : null;
    let linkedContent = contentState;
    let linked = character;
    if (link && location.exact && characterFactory && typeof contentState.createEntity === "function") {
      linkedContent = contentState.createEntity("LINK", "MUTABLE", { url: String(link) });
      linked = characterFactory.create({ entity: linkedContent.getLastCreatedEntityKey() });
    }
    const characterList = block.getCharacterList().clear().concat(Array.from({ length: nextText.length }, () => linked));
    const nextBlock = block.merge({ text: nextText, characterList });
    const selection = SelectionState.createEmpty(blockKey);
    const nextContent = linkedContent
      .set("blockMap", blockMap.set(blockKey, nextBlock))
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    await changeDraft(draftNode, EditorState.push(editorState, nextContent, "change-block-data"));
    return true;
  }

  async function relocateImages(draftNode, uploads, protectedAtomicBlocks) {
    if (!uploads.length) return { moved: 0, missing: 0 };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const entityToBlock = new Map();
    const mediaBlocks = [];

    for (const upload of uploads) {
      if (upload.markerBlock && blockMap.has(upload.markerBlock)) continue;
      const location = findMarkerLocation(contentState, upload.marker);
      if (location) {
        upload.markerBlock = location.blockKey;
        upload.markerOffset = location.offset;
        upload.markerLength = location.length;
        upload.markerExact = location.exact;
      }
    }

    blockMap.forEach((block, blockKey) => {
      if (block.getType() === "atomic") {
        let firstEntity = null;
        block.findEntityRanges(
          (character) => Boolean(character.getEntity()),
          (start) => {
            const entityKey = block.getCharacterList().get(start)?.getEntity?.();
            if (entityKey) {
              firstEntity ||= entityKey;
              entityToBlock.set(entityKey, blockKey);
            }
          }
        );
        if (!protectedAtomicBlocks.has(blockKey) && firstEntity) {
          try {
            if (contentState.getEntity(firstEntity).getType() === "MEDIA") {
              mediaBlocks.push({ blockKey, entityKey: firstEntity });
            }
          } catch {}
        }
      }
    });

    const moves = new Map();
    let missing = 0;
    let fallbackIndex = 0;

    for (const upload of uploads) {
      if (!upload.markerBlock || !blockMap.has(upload.markerBlock)) {
        missing += 1;
        continue;
      }
      let imageBlock = upload.blockKey && blockMap.has(upload.blockKey) ? upload.blockKey : null;
      if (!imageBlock && upload.entityKey) imageBlock = entityToBlock.get(upload.entityKey) || null;
      if (!imageBlock) {
        while (fallbackIndex < mediaBlocks.length && moves.has(mediaBlocks[fallbackIndex].blockKey)) {
          fallbackIndex += 1;
        }
        imageBlock = mediaBlocks[fallbackIndex]?.blockKey || null;
        fallbackIndex += 1;
      }
      if (!imageBlock) {
        missing += 1;
        continue;
      }
      if (imageBlock !== upload.markerBlock) {
        moves.set(upload.markerBlock, {
          imageBlock,
          markerExact: upload.markerExact !== false
        });
      }
    }

    if (!moves.size) return { moved: 0, missing };
    const destinationBlocks = new Set(Array.from(moves.values()).map((move) => move.imageBlock));
    const orderedKeys = [];
    blockMap.forEach((block, key) => {
      if (moves.has(key)) {
        const move = moves.get(key);
        if (move.markerExact) orderedKeys.push(move.imageBlock);
        else {
          orderedKeys.push(move.imageBlock);
          orderedKeys.push(key);
        }
      } else if (!destinationBlocks.has(key)) orderedKeys.push(key);
    });

    const BlockMap = blockMap.constructor;
    let nextBlockMap = BlockMap();
    for (const key of orderedKeys) nextBlockMap = nextBlockMap.set(key, blockMap.get(key));
    const selection = SelectionState.createEmpty(orderedKeys[orderedKeys.length - 1]);
    const nextContent = contentState
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    await changeDraft(draftNode, nextEditorState);
    return { moved: moves.size, missing };
  }

  async function cleanupMarkers(draftNode, markerPrefix) {
    const resolvedPrefix = String(markerPrefix || "__XPOSTER_");
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    let blockMap = contentState.getBlockMap();
    const toDelete = [];
    const replacements = [];
    const markerPattern = markerTokenPattern(resolvedPrefix);
    blockMap.forEach((block, key) => {
      if (block.getType() === "atomic") return;
      const text = block.getText() || "";
      if (!text.includes(resolvedPrefix) && !text.includes("__XPOSTER_")) return;
      const cleaned = text
        .replace(markerPattern, "")
        .replace(allMarkerTokenPattern(), "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!cleaned) {
        toDelete.push(key);
      } else if (cleaned !== text) {
        replacements.push({ key, text: cleaned });
      }
    });
    if (!toDelete.length && !replacements.length) return 0;
    for (const replacement of replacements) {
      const block = blockMap.get(replacement.key);
      if (!block) continue;
      const characterFactory = block.getCharacterList().get(0)?.constructor;
      const character = characterFactory ? characterFactory.create({}) : null;
      const characterList = block.getCharacterList().clear().concat(
        Array.from({ length: replacement.text.length }, () => character)
      );
      blockMap = blockMap.set(replacement.key, block.merge({ text: replacement.text, characterList }));
    }
    for (const key of toDelete) blockMap = blockMap.delete(key);
    const lastKey = blockMap.last()?.getKey?.();
    const selection = lastKey ? SelectionState.createEmpty(lastKey) : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", blockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    await changeDraft(draftNode, nextEditorState);
    return toDelete.length + replacements.length;
  }


  async function kickRender(draftNode) {
    try {
      const EditorState = draftNode.props.editorState.constructor;
      await changeDraft(draftNode, EditorState.moveSelectionToEnd(draftNode.props.editorState));
    } catch (error) {
      console.warn(LOG, "render kick failed", error);
    }
  }

  const GRAPHQL_FEATURES = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };

  const X_BEARER_TOKEN =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  function articleIdFromUrl() {
    return location.href.match(/\/articles\/edit\/(\d+)/)?.[1] || null;
  }

  function csrfToken() {
    return document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || "";
  }

  async function xGraphql(queryId, operationName, body) {
    assertContext();
    const response = await fetch(`https://x.com/i/api/graphql/${queryId}/${operationName}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${X_BEARER_TOKEN}`,
        "x-csrf-token": csrfToken(),
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session"
      },
      body: JSON.stringify(body)
    });
    let text = "";
    try {
      text = await response.text();
    } catch {}
    assertContext();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: response.ok && security.graphql(json, body.variables.articleEntityId, operationName, operationName === "ArticleEntityUpdateTitle" ? body.variables.title : body.variables.coverMedia.media_id), status: response.status };
  }

  function updateTitleGraphql(articleId, title) {
    return xGraphql("x75E2ABzm8_mGTg1bz8hcA", "ArticleEntityUpdateTitle", {
      variables: { articleEntityId: articleId, title: String(title) },
      features: GRAPHQL_FEATURES,
      queryId: "x75E2ABzm8_mGTg1bz8hcA"
    });
  }

  function updateCoverGraphql(articleId, mediaId, category = "DraftTweetImage") {
    return xGraphql("Es8InPh7mEkK9PxclxFAVQ", "ArticleEntityUpdateCoverMedia", {
      variables: {
        articleEntityId: articleId,
        coverMedia: { media_id: String(mediaId), media_category: category }
      },
      features: GRAPHQL_FEATURES,
      queryId: "Es8InPh7mEkK9PxclxFAVQ"
    });
  }

  async function deleteBlockByKey(draftNode, blockKey) {
    if (!blockKey) return { ok: false, error: "Missing block key" };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    if (!blockMap.has(blockKey)) return { ok: false, error: "Block not found" };
    const nextBlockMap = blockMap.delete(blockKey);
    const lastKey = nextBlockMap.last()?.getKey?.();
    const selection = lastKey ? SelectionState.createEmpty(lastKey) : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    await changeDraft(draftNode, nextEditorState);
    return { ok: true };
  }

  async function setTitleViaUi(title) {
    if (!title) return { ok: true, skipped: true };
    const editor = findEditorElement();
    const candidates = Array.from(document.querySelectorAll("input[type='text'], textarea, [contenteditable='true']")).filter(
      (element) => element !== editor && isVisible(element)
    );
    const titleWords = ["title", "标题", "add title", "输入标题"];
    let best = null;
    let score = -1;
    for (const element of candidates) {
      const haystack = [
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.getAttribute("data-testid")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const rect = element.getBoundingClientRect();
      let current = 0;
      if (titleWords.some((word) => haystack.includes(word))) current += 10;
      if (rect.top < 420) current += 3;
      if (rect.width > 240) current += 2;
      if (current > score) {
        score = current;
        best = element;
      }
    }
    if (!best || score <= 0) return { ok: false, error: "Title field not found" };
    if (best instanceof HTMLInputElement || best instanceof HTMLTextAreaElement) {
      const proto = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(best, String(title));
      best.dispatchEvent(new Event("input", { bubbles: true }));
      best.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      best.focus();
      await sleep(80);
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, String(title));
      best.dispatchEvent(new Event("input", { bubbles: true }));
      best.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function uploadMatchesCover(upload, coverSource) {
    return Boolean(upload?.mediaId && coverSource && imageSourcesMatch(upload.source, coverSource));
  }

  function imageOperationKind(operation) {
    if (operation?.op?.coverOnly) return "cover";
    if (String(operation?.marker || "").includes("_TABLE_")) return "table";
    return "image";
  }

  async function applyCoverMetadata(coverSource, articleId, upload, summary) {
    if (!uploadMatchesCover(upload, coverSource) || summary.cover.graphql || summary.cover.skippedReason) return false;
    summary.cover.matchedUpload = true;
    summary.cover.articleId = articleId || summary.cover.articleId || null;
    summary.cover.mediaIdSuffix = upload.mediaId ? upload.mediaId.slice(-8) : null;
    if (!articleId) {
      summary.cover.skippedReason = "No article id in URL";
      console.warn(LOG, "cover update skipped: no article id");
      return false;
    }
    progress("Setting cover...");
    const result = await updateCoverGraphql(articleId, upload.mediaId).catch((error) => ({
      ok: false,
      error: error?.message || String(error)
    }));
    summary.cover.graphql = result;
    return Boolean(result.ok);
  }

  async function runFlow(payload) {
    let draftNode = findDraftStateNode();
    if (!draftNode) throw new Error("X Draft.js editor was not reachable");
    const articleId = articleIdFromUrl();
    assertContext();
    if (payload.targetUrl !== location.href || payload.expectedText !== (findEditorElement()?.textContent || "")) throw new Error("目标正文版本不一致");
    const context = contextTokens.get(payload.contextToken); contextTokens.delete(payload.contextToken);
    if (!context || context.url !== location.href || context.node !== draftNode || context.element !== findEditorElement() || !sameRecords(context.records, contentRecords(draftNode.props.editorState.getCurrentContent())) || context.revision !== inputRevision || context.expires < Date.now()) throw new Error("正文版本或导航上下文已变化");
    activeSession.element = findEditorElement();
    acceptContent(draftNode, draftNode.props.editorState.getCurrentContent());
    snapshots.set(location.href, { state: draftNode.props.editorState, node: draftNode, element: findEditorElement(), savedAt: Date.now() });
    while (snapshots.size > 3) snapshots.delete(snapshots.keys().next().value);

    let markersWritten = false;
    const summary = {
      atomicOk: 0,
      atomicFail: 0,
      imgOk: 0,
      imgFail: 0,
      imageErrors: [],
      markersCleaned: 0,
      relocatedImages: 0,
      title: {
        requested: Boolean(payload.title),
        value: payload.title || null,
        articleId: articleId || null,
        ui: null,
        graphql: null
      },
      cover: {
        requested: Boolean(payload.cover),
        source: payload.cover || null,
        matchedUpload: false,
        mediaIdSuffix: null,
        graphql: null,
        bodyBlockDeleted: null,
        skippedReason: null
      }
    };

    try {
      progress("Pasting structured Markdown...");
      draftNode = await ensureDraftCharacterSample(draftNode);
      const writeResult = await writeDraftBlocks(draftNode, payload.blocks);
      if (!writeResult.ok) {
        console.warn(LOG, "structured block write failed; falling back to paste", writeResult.error);
        throw new Error("结构化写入失败，已保留恢复快照：" + writeResult.error);
      }
      markersWritten = true;
      draftNode = await waitForDraftMarkers(payload.markerPrefix, (payload.plan || []).length);
      if (!draftNode) throw new Error("X Draft.js editor was not reachable after writing Markdown");
      await sleep(150);

      const atomicOps = (payload.plan || []).filter((item) => item.op.type === "atomic");
      const imageOps = (payload.plan || []).filter((item) => item.op.type === "image");

      if (atomicOps.length) {
        progress(`Inserting ${atomicOps.length} special block(s)...`);
        draftNode = findDraftStateNode() || draftNode;
        const result = await insertAtomicBatch(draftNode, atomicOps);
        summary.atomicOk = result.okCount;
        summary.atomicFail = result.failCount;
        if (result.errors?.length) console.warn(LOG, "atomic failures", result.errors);
        await sleep(350);
      }

      draftNode = findDraftStateNode() || draftNode;
      const protectedAtomicBlocks = new Set();
      draftNode.props.editorState
        .getCurrentContent()
        .getBlockMap()
        .forEach((block, key) => {
          if (block.getType() === "atomic") protectedAtomicBlocks.add(key);
        });

      const uploads = [];
      let coverUpload = null;
      for (let index = 0; index < imageOps.length; index += 1) {
        draftNode = findDraftStateNode() || draftNode;
        const op = imageOps[index];
        progress(`Uploading image ${index + 1}/${imageOps.length}...`);
        let result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks);
        if (!result.ok && /timed out/i.test(result.error || "")) {
          progress(`Retrying image ${index + 1}...`, "warn");
          await sleep(1400);
          draftNode = findDraftStateNode() || draftNode;
          result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks);
        }
        if (result.ok) {
          summary.imgOk += 1;
          uploads.push({
            marker: op.marker,
            blockKey: result.blockKey,
            entityKey: result.entityKey,
            markerBlock: result.markerBlock,
            markerOffset: result.markerOffset,
            markerLength: result.markerLength,
            markerExact: result.markerExact,
            mediaId: result.mediaId,
            source: op.op.source,
            coverOnly: Boolean(op.op.coverOnly),
            settled: Boolean(op.op.coverOnly)
          });
          const upload = uploads[uploads.length - 1];
          if (!upload.coverOnly) {
            const settleResult = await settleUploadedImageAtMarker(draftNode, upload, protectedAtomicBlocks);
            draftNode = settleResult.draftNode;
            summary.relocatedImages += settleResult.moved;
            summary.markersCleaned += settleResult.markerCleaned;
            upload.settled = !settleResult.missing;
          }
          if (payload.cover && imageSourcesMatch(upload.source, payload.cover) && !upload.mediaId && !summary.cover.graphql && !summary.cover.skippedReason) {
            const refreshed = await waitForUploadMediaId(draftNode, upload);
            draftNode = refreshed.draftNode;
          }
          if (upload.coverOnly && !coverUpload) coverUpload = upload;
          if (!upload.coverOnly && uploadMatchesCover(upload, payload.cover) && !summary.cover.graphql && !summary.cover.skippedReason) {
            coverUpload = upload;
            await applyCoverMetadata(payload.cover, articleId, upload, summary);
          }
        } else {
          summary.imgFail += 1;
          summary.imageErrors.push({
            kind: imageOperationKind(op),
            index: index + 1,
            marker: op.marker,
            source: op.op.source || null,
            fileName: op.op.file?.fileName || null,
            error: result.error || "Image upload failed"
          });
          if (op.op.coverOnly && result.blockKey) {
            draftNode = await cleanupTemporaryCoverBlock(draftNode, result.blockKey, summary);
          }
          await replaceMarkerText(draftNode, op.marker, op.op.fallbackText || (op.op.coverOnly ? "" : "[image upload failed]"), op.op.fallbackLink || "");
          console.warn(LOG, "image failed", result.error);
        }
        draftNode = findDraftStateNode() || draftNode;
      }

      const unsettledUploads = uploads.filter((upload) => !upload.coverOnly && !upload.settled);
      if (unsettledUploads.length) {
        progress("Reordering uploaded media...");
        await sleep(900);
        const result = await relocateImages(draftNode, unsettledUploads, protectedAtomicBlocks);
        summary.relocatedImages += result.moved;
        await sleep(400);
      }

      if (payload.title) {
        progress("Setting title...");
        const result = await setTitleViaUi(payload.title);
        summary.title.ui = result;
        if (!result.ok) console.warn(LOG, "title failed", result.error);
        if (articleId) {
          const graphResult = await updateTitleGraphql(articleId, payload.title).catch((error) => ({
            ok: false,
            error: error?.message || String(error)
          }));
          summary.title.graphql = graphResult;
          if (!graphResult.ok) console.warn(LOG, "title GraphQL failed", graphResult);
        } else {
          summary.title.graphql = { ok: false, skipped: true, reason: "No article id in URL" };
        }
      }

      if (payload.cover) {
        if (coverUpload?.coverOnly && coverUpload.blockKey) {
          draftNode = await cleanupTemporaryCoverBlock(draftNode, coverUpload.blockKey, summary, 600);
          if (summary.cover.bodyBlockDeleted?.ok === false) {
            summary.cover.skippedReason = "Temporary cover block could not be removed";
          } else {
            await applyCoverMetadata(payload.cover, articleId, coverUpload, summary);
          }
        }
        if (!summary.cover.graphql && !summary.cover.skippedReason && !articleId) {
          summary.cover.skippedReason = "No article id in URL";
          console.warn(LOG, "cover update skipped: no article id");
        } else if (!summary.cover.graphql && !summary.cover.skippedReason) {
          summary.cover.skippedReason = "Cover source has no uploaded media match";
          console.warn(LOG, "cover source has no uploaded media match", payload.cover);
        }
      }

      progress("Cleaning up import markers...");
      draftNode = findDraftStateNode() || draftNode;
      summary.markersCleaned += await cleanupMarkers(draftNode, payload.markerPrefix);
      await kickRender(draftNode);
      await sleep(250);
      post("done", { summary });
    } catch (error) {
      if (markersWritten) {
        try {
          progress("Cleaning up import markers...", "warn");
          draftNode = findDraftStateNode() || draftNode;
          summary.markersCleaned += await cleanupMarkers(draftNode, payload.markerPrefix);
          await kickRender(draftNode);
        } catch (cleanupError) {
          console.warn(LOG, "marker cleanup after interrupted import failed", cleanupError);
        }
      }
      error.summary = summary;
      throw error;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== CHANNEL_TO_MAIN) return;
    if (event.data.kind === "capture-context") {
      if (activeSession || typeof event.data.requestId !== "string" || event.data.requestId.length > 100) return;
      const node = findDraftStateNode(); const token = crypto.randomUUID();
      while (contextTokens.size >= 8) contextTokens.delete(contextTokens.keys().next().value);
      if (node) contextTokens.set(token, { records: contentRecords(node.props.editorState.getCurrentContent()), node, element: findEditorElement(), url: location.href, revision: inputRevision, expires: Date.now() + 5 * 60 * 1000 });
      post("context", { requestId: event.data.requestId, token: node ? token : null }); return;
    }
    if (event.data.kind === "ready?") {
      post("ready");
      return;
    }
    if (event.data.kind === "clear-records") { const ok = !activeSession; if (ok) { snapshots.clear(); contextTokens.clear(); } post("clear-result", { requestId: event.data.requestId, ok }); return; }
    if (event.data.kind === "restore") {
      const saved = snapshots.get(location.href); const node = findDraftStateNode();
      const ok = Boolean(!activeSession && event.data.targetUrl === location.href && saved && node === saved.node && findEditorElement() === saved.element);
      if (ok) { const current = node.props.editorState; node.props.onChange(saved.state); snapshots.set(location.href, { ...saved, state: current, savedAt: Date.now() }); }
      post("restore-result", { requestId: event.data.requestId, ok }); return;
    }
    if (event.data.kind === "run") {
      const p = event.data.payload;
      if (activeSession || typeof event.data.sessionId !== "string" || event.data.sessionId.length > 100 || !p || typeof p.html !== "string" || p.html.length > 4 * 1024 * 1024 || !Array.isArray(p.blocks) || p.blocks.length > 1000 || !Array.isArray(p.plan) || p.plan.length > 30 || p.targetUrl !== location.href || !security.planSchema(p)) return;
      activeSession = { id: event.data.sessionId, url: location.href, revision: inputRevision, expires: Date.now() + 5 * 60 * 1000, ownedMedia: new Set() };
      runFlow(p).catch((error) => {
        console.error(LOG, error);
        post("error", { error: error?.message || String(error), stack: null });
      }).finally(() => { activeSession = null; });
      return;
    }
    if (event.data.kind === "diagnostics") {
      const editorElement = findEditorElement();
      const draftNode = findDraftStateNode();
      const onFilesAdded = findOnFilesAdded();
      post("diagnostics", {
        payload: {
          ok: true,
          mainWorld: true,
          hasEditorElement: Boolean(editorElement),
          hasDraftStateNode: Boolean(draftNode),
          hasOnFilesAdded: Boolean(onFilesAdded),
          articleId: articleIdFromUrl(),
          editorBounds: editorElement
            ? {
                width: Math.round(editorElement.getBoundingClientRect().width),
                height: Math.round(editorElement.getBoundingClientRect().height)
              }
            : null
        }
      });
    }
  });

  console.log(LOG, "ready");
  post("ready");
})();

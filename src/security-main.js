/* 共用输入边界；页面世界不是保密环境。 */
(() => {
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_TOTAL = 64 * 1024 * 1024;
  const MAX_PIXELS = 16 * 1024 * 1024;
  function safeLink(value) {
    const text = String(value || "");
    if (/[\x00-\x20\x7f]/.test(text)) return null;
    try { const u = new URL(text); return ["https:", "http:", "mailto:"].includes(u.protocol) ? text : null; } catch { return null; }
  }
  function publicUrl(value) {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    // 拒绝 IP 字面量和特殊用途域名，重定向单独拒绝。DNS 重绑定仍属浏览器网络边界。
    if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443" ||
        !host.includes(".") || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(host)) throw new Error("只允许 HTTPS 公网图片域名");
    return u;
  }
  function matches(pattern, origin) {
    if (pattern === "<all_urls>") return true;
    const m = String(pattern).match(/^(\*|https?|file):\/\/(\*|\*\.[^/]+|[^/]+)\/.*$/);
    if (!m) return false;
    try { const u = new URL(origin); return (m[1] === "*" ? /https?:/.test(u.protocol) : u.protocol === m[1] + ":") &&
      (m[2] === "*" || m[2].startsWith("*.") && (u.hostname === m[2].slice(2) || u.hostname.endsWith(m[2].slice(1))) || u.host === m[2]); } catch { return false; }
  }
  function data(uri) {
    if (typeof uri !== "string" || uri.length > Math.ceil(MAX_BYTES * 4 / 3) + 128) throw new Error("图片 data URI 超出限制");
    const m = uri.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!m || m[2].length % 4) throw new Error("不支持的图片 data URI");
    const raw = atob(m[2]);
    if (raw.length > MAX_BYTES) throw new Error("图片超出限制");
    return { mime: m[1].toLowerCase(), bytes: Uint8Array.from(raw, c => c.charCodeAt(0)) };
  }
  function signature(bytes, mime) {
    const b = bytes;
    const ascii = (start, end) => String.fromCharCode(...b.slice(start, end));
    return mime === "image/png" && ascii(0, 8) === "\x89PNG\r\n\x1a\n" ||
      mime === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255 ||
      mime === "image/gif" && /GIF8[79]a/.test(ascii(0, 6)) ||
      mime === "image/webp" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
  async function validate(bytes, mime) {
    if (!bytes.length || bytes.length > MAX_BYTES || !signature(bytes, mime)) throw new Error("图片类型、文件头或大小不符合限制（仅 PNG/JPEG/GIF/WebP）");
    const [width, height] = dimensions(bytes, mime);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error("图片像素超出限制或图片头无效");
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    try { if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) throw new Error("图片像素超出限制"); } finally { bitmap.close(); }
    return bytes;
  }
  function dimensions(b, mime) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (mime === "image/png" && b.length >= 24) return [v.getUint32(16), v.getUint32(20)];
    if (mime === "image/gif" && b.length >= 10) return [v.getUint16(6, true), v.getUint16(8, true)];
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i++] !== 255) break;
        while (b[i] === 255) i++;
        const marker = b[i++];
        if ([0xd8, 0x01].includes(marker)) continue;
        if (marker === 0xda || marker === 0xd9) break;
        const size = v.getUint16(i);
        if (size < 2 || i + size > b.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [v.getUint16(i + 5), v.getUint16(i + 3)];
        i += size;
      }
    }
    if (mime === "image/webp" && b.length >= 30) {
      const tag = String.fromCharCode(...b.slice(12, 16));
      const u24 = i => b[i] | b[i + 1] << 8 | b[i + 2] << 16;
      if (tag === "VP8X") return [u24(24) + 1, u24(27) + 1];
      if (tag === "VP8 " && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
      if (tag === "VP8L" && b[20] === 0x2f) return [1 + (v.getUint32(21, true) & 0x3fff), 1 + ((v.getUint32(21, true) >>> 14) & 0x3fff)];
    }
    return [0, 0];
  }
  async function stream(response) {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("图片超出限制");
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > MAX_BYTES) throw new Error("图片超出限制"); chunks.push(value); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    const out = new Uint8Array(size); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.length; } return out;
  }
  function exportValue(key, value) {
    // 导出只保留数值、布尔和结构；字符串可能含任意正文、路径和签名凭据。
    if (typeof value === "string") return "[已脱敏]";
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const safe = {};
      for (const [name, item] of Object.entries(value)) safe[/^[a-zA-Z0-9_]{1,60}$/.test(name) ? name : `字段${Object.keys(safe).length}`] = item;
      return safe;
    }
    return value;
  }
  function uiError(value) { return String(value || "操作失败").replace(/https?:\/\/[^\s<>"']+/gi, "[图片网站]").replace(/(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s]+/g, "[路径]").slice(0, 500); }
  function graphql(json, articleId, operation, expected) {
    if (!json || Object.prototype.hasOwnProperty.call(json, "errors") && (!Array.isArray(json.errors) || json.errors.length) || !json.data) return false;
    const root = operation === "ArticleEntityUpdateTitle" ? json.data.article_entity_update_title :
      operation === "ArticleEntityUpdateCoverMedia" ? json.data.article_entity_update_cover_media : null;
    const entity = root?.article_results?.result;
    if (!entity || entity.__typename !== "ArticleEntity" || String(entity.rest_id || "") !== String(articleId)) return false;
    if (operation === "ArticleEntityUpdateTitle") return typeof expected === "string" && entity.title === expected;
    return expected != null && String(entity.cover_media?.media_id || "") === String(expected);
  }
  function planSchema(p) {
    const text = (v, size) => typeof v === "string" && v.length <= size;
    if (!p || !text(p.html, 4 * 1024 * 1024) || !text(p.plain, 2 * 1024 * 1024) ||
        !text(p.targetUrl, 8192) || !text(p.expectedText, 2 * 1024 * 1024) || !text(p.contextToken, 100) ||
        !text(p.markerPrefix, 128) || !Array.isArray(p.blocks) || !p.blocks.length || p.blocks.length > 1000 ||
        !Array.isArray(p.plan) || p.plan.length > 30 || p.title != null && !text(p.title, 10000) || p.cover != null && !text(p.cover, 128)) return false;
    let total = 0;
    for (const b of p.blocks) {
      if (!b || !text(b.text, 1024 * 1024) || !text(b.type, 40)) return false;
      total += b.text.length;
      for (const field of ["links", "inlineStyleRanges"]) if (b[field] != null && (!Array.isArray(b[field]) || b[field].length > 1000)) return false;
      for (const link of b.links || []) if (!text(link.url, 8192) || !safeLink(link.url) || !Number.isInteger(link.offset) || !Number.isInteger(link.length) || link.offset < 0 || link.length < 0 || link.offset + link.length > b.text.length) return false;
      for (const range of b.inlineStyleRanges || []) if (!["Bold", "Italic", "Strikethrough", "Code"].includes(range.style) || !Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.offset < 0 || range.length < 0 || range.offset + range.length > b.text.length) return false;
    }
    if (total > 1024 * 1024) return false;
    const markers = new Set();
    for (const item of p.plan) {
      if (!item || !text(item.marker, 128) || markers.has(item.marker) || !item.op) return false;
      markers.add(item.marker);
      const op = item.op;
      if (op.type === "image") {
        if (!op.file || !text(op.file.token, 128) || op.file.base64 || !/^image\/(png|jpeg|gif|webp)$/.test(op.file.mime) || !text(op.file.fileName, 100) || !text(op.fallbackText || "", 1024 * 1024)) return false;
      } else if (op.type === "atomic") {
        if (!["MARKDOWN", "TWEET", "DIVIDER"].includes(op.entityType) || !op.data || typeof op.data !== "object") return false;
        if (op.entityType === "MARKDOWN" && !text(op.data.markdown, 1024 * 1024)) return false;
        if (op.entityType === "TWEET" && (!text(op.data.tweetId, 30) || !/^\d+$/.test(op.data.tweetId) || !safeLink(op.data.url))) return false;
      } else return false;
    }
    return true;
  }
  const api = { MAX_BYTES, MAX_TOTAL, MAX_PIXELS, safeLink, publicUrl, matches, data, signature, dimensions, validate, stream, exportValue, uiError, graphql, planSchema };
  globalThis.xPosterSecurity = Object.freeze(api);
  if (typeof module !== "undefined") module.exports = api;
})();

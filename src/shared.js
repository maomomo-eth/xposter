(() => {
  const security = globalThis.xPosterSecurity || (typeof require === "function" ? require("./security.js") : null);
  function trustedVault() { if (globalThis.location?.protocol !== "chrome-extension:") throw new Error("本地图片仅可在扩展侧边栏读取，请重新选择目录"); }
  const STYLE_TAGS = {
    Bold: "strong",
    Italic: "em",
    Strikethrough: "s",
    Code: "code"
  };

  const BLOCK_TAGS = {
    "header-one": "h1",
    "header-two": "h2",
    "header-three": "h3",
    "header-four": "h4",
    "header-five": "h5",
    "header-six": "h6",
    blockquote: "blockquote",
    unstyled: "p"
  };

  const LOCAL_DB = "xposter_local_assets";
  const LOCAL_STORE = "handles";
  const VAULT_KEY = "vault_root";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;
    if (findMarkdownImageSpans(text).some((span) => isLikelyMarkdownImageSource(span.source))) return true;
    return [
      /^#{1,6}\s+\S/m,
      /^>\s+\S/m,
      /^[-*+]\s+\S/m,
      /^\d+\.\s+\S/m,
      /^\s*```/m,
      /^\s*(?:---|\*\*\*|___)\s*$/m,
      /\[[^\]]+\]\(https?:\/\/\S+\)/i,
      /^\s*\|.+\|\s*$\n^\s*\|[\s:|\-]+\|\s*$/m,
      /`[^`\n]+`/
    ].some((pattern) => pattern.test(text));
  }

  function parseFrontmatter(markdown) {
    const normalized = String(markdown ?? "").replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n*/);
    if (!match) return { body: normalized.trim(), meta: {} };
    const meta = {};
    for (const line of match[1].split("\n")) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      const value = line
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
    return { body: normalized.slice(match[0].length).trim(), meta };
  }

  function parseMarkdown(markdown, options = {}) {
    const { body, meta } = parseFrontmatter(markdown);
    const titleFromMeta = meta.title || meta.Title || meta["标题"] || null;
    let cover = meta.cover || meta.Cover || meta["封面"] || null;
    if (cover) {
      const image = findMarkdownImageSpans(cover)[0];
      cover = image?.start === 0 && image.end === cover.length
        ? image.source
        : cover.replace(/^!\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim();
    }

    const spans = findSpecialBlocks(body, options);
    const segments = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) {
        segments.push(...parseTextBlocks(body.slice(cursor, span.start), options));
      }
      segments.push(span.segment);
      cursor = span.end;
    }
    if (cursor < body.length) segments.push(...parseTextBlocks(body.slice(cursor), options));

    let title = titleFromMeta;
    if (!title) {
      const titleIndex = segments.findIndex(
        (segment) => segment.type === "text" && segment.kind === "header-one"
      );
      if (titleIndex >= 0) {
        title = segments[titleIndex].text || null;
        segments.splice(titleIndex, 1);
      }
    }

    if (!cover) {
      cover = segments.find((segment) => segment.type === "image" && segment.source)?.source || null;
    }

    return {
      title,
      cover,
      segments,
      meta,
      titleFromMeta: Boolean(titleFromMeta)
    };
  }

  function markdownLineRecords(markdown) {
    const lines = [];
    let start = 0;
    while (start < markdown.length) {
      let end = markdown.indexOf("\n", start);
      if (end < 0) end = markdown.length;
      lines.push({
        start,
        end: end < markdown.length ? end + 1 : end,
        text: markdown.slice(start, end)
      });
      start = end + 1;
    }
    return lines;
  }

  function isIndentedCodeLine(line) {
    return /^ {4}\S|^\t\S/.test(line?.text || "");
  }

  function unindentCodeLine(line) {
    return (line?.text || "").replace(/^ {4}|^\t/, "");
  }

  function isBlankLineInsideIndentedCode(lines, index) {
    if (!/^\s*$/.test(lines[index]?.text || "")) return false;
    for (let i = index + 1; i < lines.length; i += 1) {
      if (isIndentedCodeLine(lines[i])) return true;
      if (!/^\s*$/.test(lines[i].text)) return false;
    }
    return false;
  }

  function opensIndentedCode(lines, index) {
    if (!isIndentedCodeLine(lines[index])) return false;
    const prev = lines[index - 1];
    return !prev || /^\s*$/.test(prev.text);
  }

  function findFencedCodeSpans(markdown) {
    const spans = [];
    const opener = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)$/gm;
    let match;
    while ((match = opener.exec(markdown)) !== null) {
      const marker = match[1][0];
      const markerLength = match[1].length;
      const contentStart = markdown[opener.lastIndex] === "\n" ? opener.lastIndex + 1 : opener.lastIndex;
      const closer = new RegExp(`^(?: {0,3})${marker}{${markerLength},}[ \\t]*$`, "gm");
      closer.lastIndex = contentStart;
      const close = closer.exec(markdown);
      if (!close) continue;
      spans.push({
        start: match.index,
        end: close.index + close[0].length,
        segment: {
          type: "code",
          language: (match[2] || "").trim(),
          code: markdown.slice(contentStart, close.index).replace(/\n$/, "")
        }
      });
      opener.lastIndex = close.index + close[0].length;
    }
    return spans;
  }

  function findIndentedCodeSpans(markdown) {
    const lines = markdownLineRecords(markdown);
    const spans = [];
    let index = 0;
    while (index < lines.length) {
      if (!opensIndentedCode(lines, index)) {
        index += 1;
        continue;
      }
      const start = lines[index].start;
      const codeLines = [];
      let end = lines[index].end;
      while (index < lines.length) {
        const line = lines[index];
        if (isIndentedCodeLine(line)) {
          codeLines.push(unindentCodeLine(line));
          end = line.end;
          index += 1;
          continue;
        }
        if (isBlankLineInsideIndentedCode(lines, index)) {
          codeLines.push("");
          end = line.end;
          index += 1;
          continue;
        }
        break;
      }
      spans.push({
        start,
        end,
        segment: {
          type: "code",
          language: "",
          code: codeLines.join("\n").replace(/\n$/, "")
        }
      });
    }
    return spans;
  }

  function addNonOverlappingSpan(spans, span) {
    if (!span || spans.some((existing) => span.start < existing.end && span.end > existing.start)) return;
    spans.push(span);
  }

  function findSpecialBlocks(markdown) {
    const spans = [];
    let match;

    for (const span of findFencedCodeSpans(markdown)) addNonOverlappingSpan(spans, span);
    for (const span of findIndentedCodeSpans(markdown)) addNonOverlappingSpan(spans, span);

    const table = /^(?:[ \t]*\|.+\|[ \t]*\n)(?:[ \t]*\|[\s:|\-]+\|[ \t]*\n)((?:[ \t]*\|.+\|[ \t]*\n?)*)/gm;
    while ((match = table.exec(markdown)) !== null) {
      const parsed = parseTable(match[0]);
      if (!parsed) continue;
      addNonOverlappingSpan(spans, {
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "table", ...parsed }
      });
    }

    const divider = /^(?: {0,3})(?:-{3,}|\*{3,}|_{3,})(?:[ \t]*)$/gm;
    while ((match = divider.exec(markdown)) !== null) {
      addNonOverlappingSpan(spans, {
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "divider" }
      });
    }

    const statusUrl = /^(?: {0,3})https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(?:i\/web|[A-Za-z0-9_]+)\/status\/(\d+)\/?(?:[?#][^\s]*)?\s*$/gm;
    while ((match = statusUrl.exec(markdown)) !== null) {
      addNonOverlappingSpan(spans, {
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "tweet", tweetId: match[1] }
      });
    }

    for (const image of findMarkdownImageSpans(markdown)) {
      const source = image.source;
      const tweet = source.match(
        /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/web|[A-Za-z0-9_]+)\/status\/(\d+)/
      );
      addNonOverlappingSpan(spans, {
        start: image.start,
        end: image.end,
        segment: tweet
          ? { type: "tweet", tweetId: tweet[1] }
          : { type: "image", source, alt: image.alt.trim() }
      });
    }

    const linkedTweet = /^[ \t]*\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
    while ((match = linkedTweet.exec(markdown)) !== null) {
      const tweet = match[2]
        .trim()
        .match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/web|[A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!tweet) continue;
      addNonOverlappingSpan(spans, {
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "tweet", tweetId: tweet[1] }
      });
    }

    const obsidianImage = /^[ \t]*!\[\[([^\]]+)\]\][ \t]*$/gm;
    while ((match = obsidianImage.exec(markdown)) !== null) {
      const [source, ...alias] = match[1].split("|");
      const alt = alias.join("|").trim();
      addNonOverlappingSpan(spans, {
        start: match.index,
        end: match.index + match[0].length,
        segment: {
          type: "image",
          source: source.trim(),
          alt: /^\d+(?:x\d+)?$/i.test(alt) ? "" : alt
        }
      });
    }

    return spans.sort((left, right) => left.start - right.start);
  }


  function findMarkdownImageSpans(markdown) {
    const spans = [];
    let cursor = 0;
    while (cursor < markdown.length) {
      const start = markdown.indexOf("![", cursor);
      if (start < 0) break;
      const altEnd = findMarkdownClosingBracket(markdown, start + 2);
      if (altEnd < 0 || markdown[altEnd + 1] !== "(") {
        cursor = start + 2;
        continue;
      }
      const sourceStart = altEnd + 2;
      const sourceEnd = findMarkdownClosingParen(markdown, sourceStart);
      if (sourceEnd < 0) {
        cursor = altEnd + 1;
        continue;
      }
      spans.push({
        start,
        end: sourceEnd + 1,
        alt: markdown.slice(start + 2, altEnd),
        source: parseMarkdownImageSource(markdown.slice(sourceStart, sourceEnd))
      });
      cursor = sourceEnd + 1;
    }
    return spans;
  }

  function findMarkdownClosingBracket(markdown, start) {
    for (let index = start; index < markdown.length; index += 1) {
      if (markdown[index] === "]" && !isEscaped(markdown, index)) return index;
    }
    return -1;
  }

  function findMarkdownClosingParen(markdown, start) {
    let depth = 0;
    let quote = null;
    let angle = markdown[start] === "<";
    for (let index = start; index < markdown.length; index += 1) {
      const char = markdown[index];
      if (isEscaped(markdown, index)) continue;
      if (angle) {
        if (char === ">") angle = false;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      // 只有目标之后的引号才开启标题，URL 内的单引号保持原样。
      if (depth === 0 && /\s/.test(markdown[index - 1] || "") && (char === '"' || char === "'")) {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char !== ")") continue;
      if (depth === 0) return index;
      depth -= 1;
    }
    return -1;
  }

  function parseMarkdownImageSource(value) {
    const text = value.trim();
    // 标题属于 Markdown 语法，不能拼进请求地址；保留签名查询参数原样。
    const titled = text.match(/^([\s\S]*?)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/);
    const source = (titled ? titled[1] : text).trim();
    return source.replace(/^<([\s\S]*)>$/, "$1").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  }

  function isEscaped(text, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) count += 1;
    return count % 2 === 1;
  }

  function isLikelyMarkdownImageSource(source) {
    const value = String(source || "").trim();
    return /^(?:https?:|data:|\.{0,2}\/)/i.test(value) || /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#]|$)/i.test(value);
  }

  function overlaps(spans, index) {
    return spans.some((span) => index >= span.start && index < span.end);
  }

  function parseTable(block) {
    const splitRow = (line) => {
      let cells = line.replace(/\\\|/g, "\0").split("|");
      if (cells[0]?.trim() === "") cells = cells.slice(1);
      if (cells[cells.length - 1]?.trim() === "") cells = cells.slice(0, -1);
      return cells.map((cell) => cell.replace(/\0/g, "|").trim());
    };

    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return null;

    const headers = splitRow(lines[0]);
    const alignmentRow = splitRow(lines[1]);
    if (!alignmentRow.every((cell) => /^:?-+:?$/.test(cell))) return null;

    const alignments = alignmentRow.map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      return right ? "right" : "left";
    });

    const rows = lines.slice(2).map((line) => {
      const cells = splitRow(line);
      while (cells.length < headers.length) cells.push("");
      return cells.slice(0, headers.length);
    });

    return { headers, alignments, rows };
  }

  function parseTextBlocks(text) {
    const lines = text.split("\n");
    const segments = [];
    let paragraph = [];

    const flush = () => {
      const value = paragraph.join("\n").trim();
      if (value) segments.push(parseInline("unstyled", value));
      paragraph = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      let match;
      if (!trimmed) {
        flush();
        continue;
      }
      if ((match = trimmed.match(/^(#{1,6})\s+(.+)$/))) {
        flush();
        const kind = [
          "",
          "header-one",
          "header-two",
          "header-three",
          "header-four",
          "header-five",
          "header-six"
        ][match[1].length];
        segments.push(parseInline(kind, match[2].trim()));
        continue;
      }
      if ((match = trimmed.match(/^>\s+(.+)$/))) {
        flush();
        segments.push(parseInline("blockquote", match[1].trim()));
        continue;
      }
      if ((match = trimmed.match(/^[-*+]\s+(.+)$/))) {
        flush();
        segments.push(parseInline("unordered-list-item", match[1].trim()));
        continue;
      }
      if ((match = trimmed.match(/^\d+\.\s+(.+)$/))) {
        flush();
        segments.push(parseInline("ordered-list-item", match[1].trim()));
        continue;
      }
      paragraph.push(trimmed);
    }

    flush();
    return segments;
  }

  function markdownDelimiterPairs(markdown, open, close) {
    const pairs = new Map();
    const stack = [];
    let backslashRun = 0;
    for (let index = 0; index < markdown.length; index += 1) {
      const char = markdown[index];
      if (char === "\\") {
        backslashRun += 1;
        continue;
      }
      const escaped = backslashRun % 2 === 1;
      backslashRun = 0;
      if (escaped) continue;
      if (char === open) stack.push(index);
      else if (char === close && stack.length) pairs.set(stack.pop(), index);
    }
    return pairs;
  }

  function unescapeMarkdownPunctuation(value) {
    return String(value || "").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  }

  function parseInline(kind, source, options = {}) {
    const result = { type: "text", kind, text: "", inlineStyleRanges: [], links: [] };
    const bracketPairs = markdownDelimiterPairs(source, "[", "]");
    const parenPairs = markdownDelimiterPairs(source, "(", ")");
    let cursor = 0;
    let plain = "";

    const appendPlain = () => {
      if (!plain) return;
      result.text += plain;
      plain = "";
    };
    const appendStyled = (text, styles) => {
      const value = String(text ?? "");
      const offset = result.text.length;
      result.text += value;
      for (const style of styles) {
        result.inlineStyleRanges.push({ offset, length: value.length, style });
      }
    };
    const appendNested = (text, styles) => {
      const inner = parseInline(kind, String(text ?? ""), options);
      const offset = result.text.length;
      result.text += inner.text;
      for (const range of inner.inlineStyleRanges) {
        result.inlineStyleRanges.push({
          offset: offset + range.offset,
          length: range.length,
          style: range.style
        });
      }
      for (const link of inner.links) {
        result.links.push({
          offset: offset + link.offset,
          length: link.length,
          url: link.url
        });
      }
      for (const style of styles) {
        result.inlineStyleRanges.push({ offset, length: inner.text.length, style });
      }
    };

    while (cursor < source.length) {
      const char = source[cursor];

      if (char === "[") {
        const labelEnd = bracketPairs.get(cursor) ?? -1;
        const destinationStart = labelEnd + 2;
        const destinationEnd = labelEnd >= 0 && source[labelEnd + 1] === "("
          ? parenPairs.get(labelEnd + 1) ?? -1
          : -1;
        if (destinationEnd >= 0) {
          appendPlain();
          const label = unescapeMarkdownPunctuation(source.slice(cursor + 1, labelEnd));
          const rawDest = unescapeMarkdownPunctuation(source.slice(destinationStart, destinationEnd));
          const destination = security?.safeLink ? security.safeLink(rawDest) : rawDest.trim();
          const offset = result.text.length;
          result.text += label;
          if (destination) result.links.push({ offset, length: label.length, url: destination });
          cursor = destinationEnd + 1;
          continue;
        }
      }

      const inlineRules = [
        { marker: "***", styles: ["Bold", "Italic"] },
        { marker: "**", styles: ["Bold"] },
        { marker: "~~", styles: ["Strikethrough"] }
      ];
      let matched = false;
      for (const rule of inlineRules) {
        if (!source.startsWith(rule.marker, cursor)) continue;
        let end = source.indexOf(rule.marker, cursor + rule.marker.length);
        if (end <= cursor) continue;
        while (source[end + rule.marker.length] === rule.marker[0]) end += 1;
        appendPlain();
        appendNested(source.slice(cursor + rule.marker.length, end), rule.styles);
        cursor = end + rule.marker.length;
        matched = true;
        break;
      }
      if (matched) continue;

      const wordChar = (value) => /[\p{L}\p{N}]/u.test(value || "");
      if ((char === "*" || (char === "_" && !wordChar(source[cursor - 1]))) && source[cursor + 1] !== char) {
        let end = source.indexOf(char, cursor + 1);
        while (end > cursor && (source[end + 1] === char || source[end - 1] === char)) {
          let run = end;
          while (source[run] === char) run += 1;
          end = source.indexOf(char, run);
        }
        if (char === "_") while (end > cursor && wordChar(source[end + 1])) end = source.indexOf("_", end + 1);
        if (end > cursor + 1) {
          appendPlain();
          appendNested(source.slice(cursor + 1, end), ["Italic"]);
          cursor = end + 1;
          continue;
        }
      }

      if (char === "`") {
        const end = source.indexOf("`", cursor + 1);
        if (end > cursor) {
          appendPlain();
          appendStyled(source.slice(cursor + 1, end), ["Code"]);
          cursor = end + 1;
          continue;
        }
      }

      plain += char;
      cursor += 1;
    }

    appendPlain();
    return result;
  }

  function segmentCounts(segments) {
    return segments.reduce(
      (counts, segment) => {
        counts[segment.type] = (counts[segment.type] || 0) + 1;
        return counts;
      },
      { text: 0, image: 0, table: 0, tweet: 0, code: 0, divider: 0 }
    );
  }

  function applyLimits(segments, limits) {
    if (!limits) return { segments, dropped: null };

    const output = [];
    const counters = { image: 0, table: 0, tweet: 0 };
    const dropped = { images: 0, tables: 0, tweets: 0 };

    for (const segment of segments) {
      if (segment.type === "image") {
        counters.image += 1;
        if (counters.image > limits.maxImagesPerImport) {
          dropped.images += 1;
          output.push(textSegment(`![${segment.alt || ""}](${segment.source})`));
          continue;
        }
      }
      if (segment.type === "table") {
        counters.table += 1;
        if (counters.table > limits.maxTablesPerImport) {
          dropped.tables += 1;
          output.push(textSegment(tableToMarkdown(segment)));
          continue;
        }
      }
      if (segment.type === "tweet") {
        counters.tweet += 1;
        if (counters.tweet > limits.maxTweetsPerImport) {
          dropped.tweets += 1;
          output.push(textSegment(`https://twitter.com/i/web/status/${segment.tweetId}`));
          continue;
        }
      }
      output.push(segment);
    }

    if (limits.appendSignature) {
      output.push(textSegment("Published with xPoster"));
    }

    const hasDropped = dropped.images || dropped.tables || dropped.tweets;
    return { segments: output, dropped: hasDropped ? dropped : null };
  }

  function textSegment(text) {
    return {
      type: "text",
      kind: "unstyled",
      text,
      inlineStyleRanges: [],
      links: []
    };
  }

  function tableToMarkdown(table) {
    const lines = [];
    lines.push(`| ${table.headers.join(" | ")} |`);
    lines.push(
      `| ${table.alignments
        .map((alignment) => (alignment === "center" ? ":---:" : alignment === "right" ? "---:" : ":---"))
        .join(" | ")} |`
    );
    for (const row of table.rows) lines.push(`| ${row.join(" | ")} |`);
    return lines.join("\n");
  }

  function imageSourcesMatch(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    try {
      const u1 = new URL(left, "https://x.com");
      const u2 = new URL(right, "https://x.com");
      return u1.href === u2.href || (u1.origin === u2.origin && u1.pathname === u2.pathname);
    } catch {
      return false;
    }
  }

  function imageFallback(segment = {}) {
    const givenAlt = String(segment.alt || "").replace(/[\]\r\n]+/g, " ").trim();
    const alt = givenAlt || String(guessFileName(segment.source, "image") || "image").replace(/[\]\r\n]+/g, " ").trim() || "image";
    const source = String(segment.source || "").trim();
    if (!source || source.startsWith("data:") || !/^https?:\/\//i.test(source)) return { text: `[image unavailable: ${alt}]`, link: "" };
    return { text: givenAlt || source, link: source };
  }

  function imageFallbackMarkdown(segment = {}) {
    const { text, link } = imageFallback(segment);
    return link ? `[${text}](${link})` : text;
  }

  function buildPastePlan(segments, imageResults = new Map(), tableResults = new Map(), options = {}) {
    const prefix = `__XPOSTER_${Math.random().toString(36).slice(2, 7)}_`;
    let index = 0;
    const html = [];
    const blocks = [];
    const plan = [];
    let listTag = null;
    let listItems = [];

    const marker = (type) => `${prefix}${type}_${index++}__`;
    const addBlock = (type, text, segment = null) => {
      blocks.push({
        type: type || "unstyled",
        text: String(text ?? "").replace(/\n+/g, " "),
        inlineStyleRanges: (segment?.inlineStyleRanges || []).map((range) => ({ ...range })),
        links: (segment?.links || []).filter(link => security ? security.safeLink(link.url) : link.url).map((link) => ({ ...link }))
      });
    };
    const flushList = () => {
      if (!listTag) return;
      html.push(`<${listTag}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${listTag}>`);
      listTag = null;
      listItems = [];
    };

    const addImageOperation = (segment, result, meta = {}) => {
      const id = marker(meta.markerType || "IMAGE");
      html.push(`<p>${id}</p>`);
      addBlock("unstyled", id);
      plan.push({
        marker: id,
        op: {
          type: "image",
          source: segment.source,
          coverOnly: Boolean(meta.coverOnly),
          file: {
            token: result.token || id,
            base64: result.base64,
            mime: result.mime,
            fileName: result.fileName || guessFileName(segment.source, "image"),
            alt: segment.alt || ""
          },
          fallbackText: meta.coverOnly ? "" : imageFallbackMarkdown(segment)
        }
      });
    };

    for (const segment of segments) {
      if (segment.type === "text") {
        const rendered = renderInlineHtml(segment) || "<br>";
        addBlock(segment.kind, segment.text || "", segment);
        if (segment.kind === "unordered-list-item" || segment.kind === "ordered-list-item") {
          const nextTag = segment.kind === "unordered-list-item" ? "ul" : "ol";
          if (listTag && listTag !== nextTag) flushList();
          listTag = nextTag;
          listItems.push(rendered);
          continue;
        }
        flushList();
        const tag = BLOCK_TAGS[segment.kind] || "p";
        html.push(`<${tag}>${rendered}</${tag}>`);
        continue;
      }

      flushList();

      if (segment.type === "divider") {
        const id = marker("DIVIDER");
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: { type: "atomic", entityType: "DIVIDER", data: {}, mutability: "IMMUTABLE" }
        });
        continue;
      }

      if (segment.type === "code") {
        const id = marker("CODE");
        const markdown = `\`\`\`${segment.language || ""}\n${segment.code || ""}\n\`\`\``;
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: { type: "atomic", entityType: "MARKDOWN", data: { markdown }, mutability: "MUTABLE" }
        });
        continue;
      }

      if (segment.type === "tweet") {
        const id = marker("TWEET");
        const url = `https://twitter.com/i/web/status/${segment.tweetId}`;
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: {
            type: "atomic",
            entityType: "TWEET",
            data: { url, tweetId: segment.tweetId },
            mutability: "IMMUTABLE"
          }
        });
        continue;
      }

      if (segment.type === "image") {
        const result = imageResults.get(segment);
        if (result?.ok) {
          addImageOperation(segment, result);
        } else {
          const fallback = imageFallback(segment);
          if (fallback.link) {
            html.push(`<p><a href="${escapeHtml(fallback.link)}">${escapeHtml(fallback.text)}</a></p>`);
            addBlock("unstyled", fallback.text, { links: [{ offset: 0, length: fallback.text.length, url: fallback.link }] });
          } else {
            html.push(`<p>${escapeHtml(fallback.text)}</p>`);
            addBlock("unstyled", fallback.text);
          }
        }
        continue;
      }

      if (segment.type === "table") {
        const result = tableResults.get(segment);
        if (result?.ok) {
          const id = marker("TABLE");
          html.push(`<p>${id}</p>`);
          addBlock("unstyled", id);
          plan.push({
            marker: id,
            op: {
              type: "image",
              file: {
                base64: result.base64,
                mime: result.mime,
                fileName: result.fileName,
                alt: "table"
              },
              fallbackText: tableToMarkdown(segment)
            }
          });
        } else {
          const fallback = tableToMarkdown(segment);
          html.push(`<pre><code>${escapeHtml(fallback)}</code></pre>`);
          addBlock("code-block", fallback);
        }
      }
    }

    const coverSource = String(options.coverSource || "").trim();
    const coverResult = options.coverResult || null;
    const coverAlreadyInBody = coverSource && segments.some(
      (segment) => segment.type === "image" && imageSourcesMatch(segment.source, coverSource)
    );
    if (coverSource && coverResult?.ok && !coverAlreadyInBody) {
      addImageOperation(
        { type: "image", source: coverSource, alt: "cover" },
        coverResult,
        { markerType: "COVER", coverOnly: true }
      );
    }

    flushList();
    return { html: html.join(""), plain: blocksToPlainText(blocks), blocks, plan, markerPrefix: prefix };
  }

  function renderInlineHtml(segment) {
    const text = segment.text || "";
    const openAt = new Array(text.length + 1).fill(null).map(() => []);
    const closeAt = new Array(text.length + 1).fill(null).map(() => []);

    for (const range of segment.inlineStyleRanges || []) {
      const tag = STYLE_TAGS[range.style];
      if (!tag) continue;
      openAt[range.offset]?.push(`<${tag}>`);
      closeAt[range.offset + range.length]?.unshift(`</${tag}>`);
    }

    for (const link of segment.links || []) {
      if (!security.safeLink(link.url)) continue;
      const href = escapeHtml(link.url);
      openAt[link.offset]?.push(`<a href="${href}">`);
      closeAt[link.offset + link.length]?.unshift("</a>");
    }

    let output = "";
    for (let i = 0; i < text.length; i += 1) {
      output += closeAt[i].join("");
      output += openAt[i].join("");
      output += escapeHtml(text[i]);
    }
    output += closeAt[text.length].join("");
    return output;
  }

  function blocksToPlainText(blocks) {
    return blocks
      .map((block) => String(block?.text || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function isLocalImageSource(source) {
    return Boolean(
      source &&
        typeof source === "string" &&
        !/^https?:\/\//i.test(source) &&
        !source.startsWith("data:")
    );
  }

  function isAbsoluteLocalImageSource(source) {
    return /^(?:file:\/\/\/?|[a-zA-Z]:[\\/]|\/)/.test(String(source || ""));
  }

  function guessFileName(source, fallback = "image") {
    if (typeof source !== "string") return `${fallback}.png`;
    if (source.startsWith("data:")) return `${fallback}.png`;
    try {
      const url = new URL(source, "https://xposter.local");
      const name = url.pathname.split("/").filter(Boolean).pop();
      return name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${fallback}.png`;
    } catch {
      const name = source.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop();
      return name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${fallback}.png`;
    }
  }

  function extensionMime(fileName, fallback = "image/png") {
    const ext = String(fileName || "").split(".").pop()?.toLowerCase();
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
      }[ext] || fallback
    );
  }

  function parseDataUri(uri) {
    try { const parsed = security.data(uri); return { ok: true, mime: parsed.mime, base64: arrayBufferToBase64(parsed.bytes.buffer), bytes: parsed.bytes.length }; } catch { return { ok: false, error: "图片 data URI 不合法或超限" }; }
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

  async function openLocalDb() {
    trustedVault();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveVaultHandle(handle) {
    trustedVault();
    const db = await openLocalDb();
    const store = db.transaction(LOCAL_STORE, "readwrite").objectStore(LOCAL_STORE);
    await requestToPromise(store.put({ handle, name: handle.name, savedAt: Date.now() }, VAULT_KEY));
  }

  async function getVaultRecord() {
    trustedVault();
    const db = await openLocalDb();
    const store = db.transaction(LOCAL_STORE, "readonly").objectStore(LOCAL_STORE);
    return (await requestToPromise(store.get(VAULT_KEY))) || null;
  }

  async function clearVaultHandle() {
    const db = await openLocalDb();
    const store = db.transaction(LOCAL_STORE, "readwrite").objectStore(LOCAL_STORE);
    await requestToPromise(store.delete(VAULT_KEY));
  }

  async function ensureReadPermission(handle) {
    const options = { mode: "read" };
    if (typeof handle?.queryPermission === "function" && (await handle.queryPermission(options)) === "granted") {
      return "granted";
    }
    if (typeof handle?.requestPermission === "function") return handle.requestPermission(options);
    return "denied";
  }

  async function queryReadPermission(handle) {
    if (typeof handle?.queryPermission !== "function") return "denied";
    return handle.queryPermission({ mode: "read" });
  }

  async function resolveLocalImage(source) {
    trustedVault();
    if (!isLocalImageSource(source)) return { ok: false, error: "Not a local image source" };
    const record = await getVaultRecord();
    if (!record?.handle) return { ok: false, error: "No local image folder selected" };
    if ((await queryReadPermission(record.handle)) !== "granted") {
      return { ok: false, error: "Local image folder permission expired" };
    }

    if (isAbsoluteLocalImageSource(source)) {
      return { ok: false, error: "Absolute paths outside the selected folder are not supported", source };
    }

    let cleanPath = String(source)
      .replace(/\\/g, "/")
      .split(/[?#]/)[0]
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "");

    if (/^[a-zA-Z]:\//.test(cleanPath)) {
      return { ok: false, error: "Absolute paths outside the selected folder are not supported" };
    }

    const parts = cleanPath.split("/").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

    if (parts.some(part => part === ".." || /[\\/\x00-\x1f]/.test(part))) return { ok: false, error: "图片路径不合法" };
    let depth = 0;
    for (const part of parts) {
      if (part === "..") depth -= 1;
      else if (part && part !== ".") depth += 1;
      if (depth < 0) return { ok: false, error: "Path escapes the selected folder" };
    }

    try {
      let directory = record.handle;
      for (const part of parts.slice(0, -1)) {
        if (!part || part === ".") continue;
        if (part === "..") throw new Error("Cannot traverse above selected folder");
        directory = await directory.getDirectoryHandle(part, { create: false });
      }
      const file = await (await directory.getFileHandle(parts[parts.length - 1], { create: false })).getFile();
      if (file.size > security.MAX_BYTES || !/\.(png|jpe?g|gif|webp)$/i.test(file.name)) throw new Error("本地图片类型或大小不支持");
      const buffer = await file.arrayBuffer();
      await security.validate(new Uint8Array(buffer), file.type || extensionMime(file.name));
      return {
        ok: true,
        base64: arrayBufferToBase64(buffer),
        mime: file.type || extensionMime(file.name),
        fileName: file.name,
        bytes: buffer.byteLength,
        source
      };
    } catch (error) {
      return { ok: false, error: error?.message || "Local file not found", source };
    }
  }

  async function renderTableImage(table, fileName = `table-${Date.now()}.png`) {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const paddingX = 24;
    const paddingY = 16;
    const rowHeight = 42;
    const minColumnWidth = 120;
    const maxColumnWidth = 260;
    const font = "14px ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

    const measurer = document.createElement("canvas").getContext("2d");
    measurer.font = font;
    const columnCount = table.headers.length;
    if (columnCount > 20 || table.rows.length > 200) throw new Error("表格行列超出限制");
    const widths = Array.from({ length: columnCount }, (_, index) => {
      const values = [table.headers[index], ...table.rows.map((row) => row[index] || "")];
      const measured = Math.max(...values.map((value) => measurer.measureText(String(value)).width + paddingX * 2));
      return Math.max(minColumnWidth, Math.min(maxColumnWidth, Math.ceil(measured)));
    });

    const width = widths.reduce((sum, value) => sum + value, 0);
    const height = rowHeight * (table.rows.length + 1);
    if (width * height * scale * scale > security.MAX_PIXELS) throw new Error("表格像素超出限制");
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fbfaf7";
    ctx.fillRect(0, 0, width, height);
    ctx.font = font;
    ctx.textBaseline = "middle";

    let x = 0;
    const drawCell = (text, column, row, isHeader) => {
      const cellWidth = widths[column];
      const y = row * rowHeight;
      ctx.fillStyle = isHeader ? "#eeece6" : row % 2 ? "#fbfaf7" : "#f6f3ec";
      ctx.fillRect(x, y, cellWidth, rowHeight);
      ctx.strokeStyle = "#d8d2c6";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cellWidth, rowHeight);
      ctx.fillStyle = "#201f1b";
      ctx.font = isHeader
        ? "600 14px ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        : font;
      const alignment = table.alignments[column] || "left";
      let textX = x + paddingX;
      ctx.textAlign = "left";
      if (alignment === "center") {
        textX = x + cellWidth / 2;
        ctx.textAlign = "center";
      } else if (alignment === "right") {
        textX = x + cellWidth - paddingX;
        ctx.textAlign = "right";
      }
      ctx.fillText(String(text), textX, y + rowHeight / 2, cellWidth - paddingX * 2);
      x += cellWidth;
    };

    x = 0;
    table.headers.forEach((header, column) => drawCell(header, column, 0, true));
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      x = 0;
      table.rows[rowIndex].forEach((cell, column) => drawCell(cell, column, rowIndex + 1, false));
    }

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not render table"))), "image/png");
    });
    const buffer = await blob.arrayBuffer();
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      mime: "image/png",
      fileName,
      bytes: buffer.byteLength
    };
  }

  const api = {
    looksLikeMarkdown,
    parseMarkdown,
    segmentCounts,
    applyLimits,
    buildPastePlan,
    escapeHtml,
    isLocalImageSource,
    isAbsoluteLocalImageSource,
    guessFileName,
    extensionMime,
    parseDataUri,
    arrayBufferToBase64,
    renderTableImage,
    saveVaultHandle,
    getVaultRecord,
    clearVaultHandle,
    ensureReadPermission,
    queryReadPermission,
    resolveLocalImage,
    imageSourcesMatch,
    imageFallback,
    imageFallbackMarkdown,
    findMarkdownImageSpans,
    findSpecialBlocks,
    tableToMarkdown
  };

  if (typeof window !== "undefined") {
    window.xPosterShared = api;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

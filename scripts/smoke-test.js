const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");

assert.equal(manifest.manifest_version, 3, "manifest must be MV3");
assert.equal(manifest.name, "xPoster", "manifest name must stay xPoster");
assert.equal(pkg.version, manifest.version, "package and manifest versions must match");

const requiredFiles = [
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "diagnostics.html",
  "diagnostics.css",
  "diagnostics.js",
  "src/background.js",
  "src/content.js",
  "src/main-world.js",
  "src/shared.js",
  "fixtures/live-x-smoke.md",
  "README.zh-CN.md",
  "docs/usage.md",
  "docs/usage.zh-CN.md",
  "docs/privacy.md",
  "docs/privacy.zh-CN.md",
  "docs/images/buy-me-a-coffee-qr.png",
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "assets/icon-128.png"
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
}

for (const contentScript of manifest.content_scripts || []) {
  for (const file of contentScript.js || []) {
    assert.ok(fs.existsSync(path.join(root, file)), `content script ${file} is missing`);
  }
}

for (const resourceGroup of manifest.web_accessible_resources || []) {
  for (const file of resourceGroup.resources || []) {
    assert.ok(fs.existsSync(path.join(root, file)), `web resource ${file} is missing`);
  }
}

const shared = require(path.join(root, "src/shared.js"));
const fixture = fs.readFileSync(path.join(root, "fixtures/live-x-smoke.md"), "utf8");
const parsed = shared.parseMarkdown(fixture);
const counts = shared.segmentCounts(parsed.segments);
const plan = shared.buildPastePlan(parsed.segments);

assert.equal(parsed.title, "xPoster live smoke test", "frontmatter title should parse");
assert.ok(parsed.cover, "cover should parse");
assert.ok(counts.image >= 1, "fixture should include an image");
assert.ok(counts.table >= 1, "fixture should include a table");
assert.ok(counts.tweet >= 1, "fixture should include a tweet");
assert.ok(counts.code >= 1, "fixture should include a code block");
assert.ok(counts.divider >= 1, "fixture should include a divider");
assert.ok(plan.html.includes("__XPOSTER_"), "paste plan should include replacement markers");

// 下载地址必须排除可选标题，同时保留查询串、转义和括号路径。
const imageDestinations = [
  ['https://images.real.site/photo.webp "中文图片标题"', 'https://images.real.site/photo.webp'],
  ["https://images.real.site/photo.webp '单引号标题'", 'https://images.real.site/photo.webp'],
  ['https://images.real.site/photo.webp (括号标题)', 'https://images.real.site/photo.webp'],
  ['https://images.real.site/photo.webp "标题含 ) 和 ( 括号"', 'https://images.real.site/photo.webp'],
  ['https://images.real.site/photo.webp "标题含 \\"引号\\""', 'https://images.real.site/photo.webp'],
  ['<https://images.real.site/a%20b.webp> "标题"', 'https://images.real.site/a%20b.webp'],
  ['<https://images.real.site/a)b.webp> "标题"', 'https://images.real.site/a)b.webp'],
  ['https://images.real.site/a(b).webp "标题"', 'https://images.real.site/a(b).webp'],
  ['https://images.real.site/a\\(b\\).webp "标题"', 'https://images.real.site/a(b).webp'],
  ["https://images.real.site/it's.webp", "https://images.real.site/it's.webp"],
  ['https://images.real.site/a.webp?q-signature=Ab%2BC&x=1%202 "标题"', 'https://images.real.site/a.webp?q-signature=Ab%2BC&x=1%202'],
  ['./本地图片.webp "本地标题"', './本地图片.webp'],
  ['https://images.real.site/plain.webp', 'https://images.real.site/plain.webp']
];
for (const [destination, expected] of imageDestinations) {
  const imageDraft = shared.parseMarkdown(`前文\n\n![图片说明](${destination})\n\n后文`);
  const image = imageDraft.segments.find(segment => segment.type === 'image');
  assert.equal(image?.source, expected, `图片目标解析失败：${destination}`);
  assert.equal(imageDraft.cover, expected, '首图封面应使用同一纯图片地址');
  assert.equal(image.alt, '图片说明');
  assert.ok(imageDraft.segments.some(segment => segment.text === '后文'), '标题中的括号不能截断后续正文');
}
const coverDraft = shared.parseMarkdown(`---\ntitle: 封面测试\ncover: '![封面](https://images.real.site/a(b).webp "封面标题")'\n---\n\n正文`);
assert.equal(coverDraft.cover, 'https://images.real.site/a(b).webp');
assert.equal(shared.parseMarkdown('![推文](https://x.com/user/status/123 "推文标题")').segments[0].type, 'tweet');

const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readme = readText("README.md");
const readmeZh = readText("README.zh-CN.md");
const usageZh = readText("docs/usage.zh-CN.md");
const allPublicText = [
  "README.md",
  "README.zh-CN.md",
  "docs/usage.md",
  "docs/usage.zh-CN.md",
  "docs/privacy.md",
  "docs/privacy.zh-CN.md",
  "manifest.json",
  "sidepanel.js"
]
  .map(readText)
  .join("\n");

assert.ok(
  readme.includes("https://chromewebstore.google.com/detail/xposter/iimkimodgdjnnmdopeolboakhjmhfbbj"),
  "English README should recommend the Chrome Web Store listing"
);
assert.ok(readmeZh.includes("Chrome Web Store"), "Chinese README should mention Chrome Web Store");
assert.ok(usageZh.includes("添加至 Chrome"), "Chinese usage guide should explain store installation");
assert.ok(readmeZh.includes("https://x.com/xiaoxiaodong01"), "Chinese README should include author contact");
assert.ok(
  readme.includes("docs/images/buy-me-a-coffee-qr.png"),
  "English README should include the support QR code"
);
assert.ok(
  readmeZh.includes("docs/images/buy-me-a-coffee-qr.png"),
  "Chinese README should include the support QR code"
);
assert.ok(
  !/https:\/\/[^\s"']*cos\.ap-guangzhou\.myqcloud\.com/.test(allPublicText),
  "private image host must not be exposed"
);

console.log("xPoster smoke test passed");

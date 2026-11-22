// 使用本机统一 Playwright 工具执行，不向项目安装依赖。
const { createRequire } = require("node:module");
const requireTool = createRequire("/home/codex/dev/tools/playwright-global/package.json");
const { chromium } = requireTool("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");

(async () => {
  const results = [];
  for (const target of ["chrome", "edge"]) {
    const extension = path.join(root, "dist", `xposter-${JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version}-${target}`);
    const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(root, "dist", `test-profile-${JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version}-${target}-`)), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox"]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).host;
      const errors = [], requests = [];
      const page = await context.newPage();
      page.on("pageerror", e => errors.push(e.message));
      context.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
      await page.goto(`chrome-extension://${id}/sidepanel.html`);
      // 草稿从后台队列异步恢复，等待初始化完成后再模拟输入。
      await page.locator("#autoSaveDraft").waitFor();
      await page.locator("#markdown").fill("# 本地审查测试\n\n**粗体**与普通段落。\n\n<script>alert(1)</script>");
      await page.waitForTimeout(800);
      assert.equal(await page.locator("#previewTitle").innerText(), "本地审查测试");
      assert.equal(await page.locator("#previewBody script").count(), 0);
      const saved = await worker.evaluate(async () => await chrome.storage.local.get(null));
      assert.ok(Object.values(saved).some(v => v && typeof v.text === "string" && v.text.includes("本地审查测试")));
      await page.reload();
      await page.locator("#autoSaveDraft").waitFor();
      assert.ok((await page.locator("#markdown").inputValue()).includes("本地审查测试"));
      await page.screenshot({ path: path.join(root, "dist", `${target}-${JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version}-sidepanel.png`) });
      await page.goto(`chrome-extension://${id}/diagnostics.html`);
      await page.waitForTimeout(500);
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
      results.push({ target, engine: "Playwright Chromium", extensionId: id, sidepanel: "pass", draftPersistence: "pass", previewEscaping: "pass", diagnostics: "pass", errors, httpRequestsDuringLocalPreview: requests });
    } finally { await context.close(); }
  }
  fs.writeFileSync(path.join(root, "dist", `browser-check-${JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version}.json`), JSON.stringify(results, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

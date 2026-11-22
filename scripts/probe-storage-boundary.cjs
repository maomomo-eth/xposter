// 用离线模拟页面验证隔离世界与页面的 IndexedDB 边界，不访问真实 X 或用户文件。
const { createRequire } = require("node:module");
const { chromium } = createRequire("/home/codex/dev/tools/playwright-global/package.json")("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    await context.route("https://x.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>离线存储边界测试</title>" }));
    const page = await context.newPage();
    await page.goto("https://x.com/compose/articles");
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "xposter-audit-isolated" });
    await session.send("Runtime.evaluate", { contextId: executionContextId, expression: fs.readFileSync(path.join(root, "src/shared.js"), "utf8") });
    const result = await session.send("Runtime.evaluate", {
      contextId: executionContextId, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const handle = await navigator.storage.getDirectory();
        const file = await handle.getFileHandle("audit-sentinel.txt", { create: true });
        const writer = await file.createWritable();
        await writer.write("OFFLINE_TEST_ONLY"); await writer.close();
        await window.xPosterShared.saveVaultHandle(handle);
        return true;
      })()`
    });
    assert.equal(result.result.value, true, JSON.stringify(result));
    const exposed = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("xposter_local_assets", 1);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      const record = await new Promise((resolve, reject) => {
        const req = db.transaction("handles").objectStore("handles").get("vault_root");
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      const file = await (await record.handle.getFileHandle("audit-sentinel.txt")).getFile();
      return { pageOrigin: location.origin, handleVisibleToPage: !!record.handle, content: await file.text() };
    });
    assert.equal(exposed.content, "OFFLINE_TEST_ONLY");
    const report = { ...exposed, limitation: "使用 OPFS 测试句柄验证同源数据库与句柄可见性；未操作用户本地目录或验证真实目录授权生命周期。" };
    fs.writeFileSync(path.join(root, "dist", "storage-boundary-check.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

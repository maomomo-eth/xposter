// 使用真实扩展桥接和延迟提交的 Draft 模型，覆盖 React 尚未回写 props 的窗口。
const { createRequire } = require('node:module');
const { chromium } = createRequire('/home/codex/dev/tools/playwright-global/package.json')('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
(async () => {
  const results = [];
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, 'dist', `draft-async-${version}-`));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'] });
  const watchdog = setTimeout(() => { console.error('异步编辑器回归超时'); process.exit(1); }, 120000);
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><div class="public-DraftEditor-content" contenteditable="true" style="width:800px;min-height:300px">原正文</div>' }));
    const x = await context.newPage();
    await x.goto('https://x.com/compose/articles/edit/123');
    await x.addScriptTag({ path: path.join(root, 'scripts/draft-fixture.js') });
    async function install(options = {}) { await x.evaluate(options => testDraft.install('原正文', options), options); }
    async function importText(markdown) {
      x.once('dialog', dialog => dialog.accept());
      return page.evaluate(async markdown => {
        const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' });
        return chrome.tabs.sendMessage(tab.id, { type: 'xposter:import-markdown', markdown, targetUrl: tab.url, localFiles: {} });
      }, markdown);
    }
    const image = `![](data:image/png;base64,${fs.readFileSync(path.join(root, 'assets/icon-16.png')).toString('base64')})`;
    const markdown = `图片与表格异步导入\n\n${image}\n\n中间段落\n\n${image}\n\n| 项目 | 金额 |\n| --- | --- |\n| 按金 | 50 |\n\n结尾保留`;
    await install({ commitDelay: 220 });
    const imported = await importText(markdown);
    if (process.argv.includes('--expect-repro')) {
      assert.equal(imported.ok, false);
      assert.match(imported.error, /正文版本已变化/);
      assert.equal(await x.evaluate(() => fixtureUploads.length), 0);
      await x.waitForTimeout(250);
      assert.match(await x.locator('.public-DraftEditor-content').innerText(), /__XPOSTER_.*_(?:IMAGE|TABLE)_/);
      console.log('已复现：延迟提交正文时误报版本变化，尚未调用上传，正文遗留图片与表格占位符');
      return;
    }
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal(imported.summary.main.imgOk, 3);
    const uploaded = await x.evaluate(() => ({ uploads: fixtureUploads, text: testDraft.node().props.editorState.getCurrentContent().getPlainText() }));
    assert.equal(uploaded.uploads.length, 3);
    assert.ok(uploaded.uploads.every(item => /^__XPOSTER_.*_(?:IMAGE|TABLE)_\d+__$/.test(item.text)), JSON.stringify(uploaded.uploads));
    assert.ok(uploaded.text.includes('结尾保留'));
    assert.ok(!uploaded.text.includes('__XPOSTER_'));
    results.push('延迟 220ms 提交正文与选区：2 张图片及 1 个表格完成模拟上传，位置正确且无占位符');

    await install({ commitDelay: 220, appendMedia: true, captureUploadSelection: true });
    const appended = await importText(markdown);
    assert.equal(appended.ok, true, JSON.stringify(appended));
    assert.equal(appended.summary.main.imgOk, 3);
    assert.equal(appended.summary.main.relocatedImages, 3);
    const blockTypes = await x.evaluate(() => testDraft.node().props.editorState.getCurrentContent().getBlockMap().entries.map(([, block]) => ({ type: block.getType(), text: block.getText() })));
    assert.deepEqual(blockTypes.map(block => block.type), ['unstyled', 'atomic', 'unstyled', 'atomic', 'atomic', 'unstyled']);
    assert.ok(blockTypes.every(block => !block.text.includes('__XPOSTER_')));
    results.push('回调闭包捕获选区且异步追加媒体时，重新获取上传回调，3 个媒体块回到原位置且无占位符');

    await install({ commitDelay: 220 });
    const special = await importText('特殊块\n\n---\n\n```js\nconst n = 1;\n```\n\n末段');
    assert.equal(special.ok, true, JSON.stringify(special));
    assert.equal(special.summary.main.atomicOk, 2);
    assert.ok(!(await x.locator('.public-DraftEditor-content').innerText()).includes('__XPOSTER_'));
    results.push('分隔线和代码块也等待异步状态确认');

    await install({ commitDelay: 220 });
    assert.equal((await importText('异步纯文本导入')).ok, true);
    assert.equal(await x.locator('.public-DraftEditor-content').innerText(), '异步纯文本导入');
    results.push('纯文本也等待 React 确认正文');

    await install({ dropChanges: true });
    const ignored = await importText(markdown);
    assert.equal(ignored.ok, false);
    assert.match(ignored.error, /未确认/);
    assert.equal(await x.locator('.public-DraftEditor-content').innerText(), '原正文');
    assert.equal(await x.evaluate(() => fixtureUploads.length), 0);
    results.push('编辑器不接收写入时明确报确认超时，保留原文且不上传');

    await install({ commitDelay: 500 });
    await x.evaluate(() => { testDraft.node().props.onChange = ((original) => state => { setTimeout(() => testDraft.external('等待提交时用户修改'), 70); original(state); })(testDraft.node().props.onChange); });
    const conflict = await importText(markdown);
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /版本/);
    await x.waitForTimeout(550);
    assert.equal(await x.locator('.public-DraftEditor-content').innerText(), '等待提交时用户修改');
    assert.equal(await x.evaluate(() => fixtureUploads.length), 0);
    results.push('等待确认期间的真实外部正文修改仍中止导入并保留修改');

    const report = { version, engine: 'Playwright Chromium', results, limits: '使用延迟提交的本地 Draft 模型；未验证真实 X 生产上传' };
    fs.writeFileSync(path.join(root, 'dist', `draft-async-${version}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally { clearTimeout(watchdog); await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

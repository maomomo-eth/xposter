// 针对多个真实扩展页面的草稿同步回归；不访问 X，不模拟 storage 事件。
const { createRequire } = require('node:module');
const { chromium } = createRequire('/home/codex/dev/tools/playwright-global/package.json')('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
(async () => {
 const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(root, 'dist', `multipanel-${version}-`)), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox']
 });
 const errors = [], results = [];
 try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
  const a = await context.newPage(), b = await context.newPage();
  for (const page of [a, b]) { page.on('pageerror', error => errors.push(error.message)); await page.goto(url); await page.locator('#autoSaveDraft').waitFor(); }
  const record = () => worker.evaluate(async () => (await chrome.storage.local.get('xposter_sidepanel_draft')).xposter_sidepanel_draft);
  await a.locator('#autoSaveDraft').uncheck();
  await b.waitForFunction(() => !document.querySelector('#autoSaveDraft').checked);
  await b.locator('#markdown').fill('关闭期间只保留在 B 页的正文');
  await b.waitForTimeout(900); assert.equal(await record(), undefined);
  results.push('A 关闭后 B 控件同步，B 新输入不落盘');
  await a.locator('#autoSaveDraft').check();
  await b.waitForFunction(() => document.querySelector('#autoSaveDraft').checked);
  await b.waitForTimeout(900); assert.equal(await record(), undefined);
  results.push('A 重新启用后 B 同步，B 原正文不会被同步动作自动重放');
  await b.locator('#markdown').fill('B 同步后新增正文一');
  await b.waitForTimeout(900); assert.equal((await record()).text, 'B 同步后新增正文一');
  await b.locator('#markdown').fill('B 同步后新增正文二');
  await b.waitForTimeout(900); assert.equal((await record()).text, 'B 同步后新增正文二');
  results.push('B 同步最新代次后连续两次明确新输入正常保存');
  await b.locator('#markdown').fill('清空时尚在 B 防抖中的旧内容');
  await a.locator('#clearDraft').click();
  await a.waitForFunction(() => document.querySelector('#activityLog').textContent.includes('草稿及本次诊断记录已清除'));
  await b.waitForTimeout(1000); assert.equal(await record(), undefined);
  assert.equal(await b.locator('#markdown').inputValue(), '清空时尚在 B 防抖中的旧内容');
  assert.match(await b.locator('#activityLog').innerText(), /旧的待保存内容已丢弃/);
  results.push('A 清空使 B 旧防抖失效，旧正文不复活，B 保留本页文本并明确提示需新输入或备份');
  await b.locator('#markdown').fill('清空后 B 明确新增内容');
  await b.waitForTimeout(900); assert.equal((await record()).text, '清空后 B 明确新增内容');
  await a.locator('#autoSaveDraft').uncheck();
  await b.waitForFunction(() => !document.querySelector('#autoSaveDraft').checked);
  await b.locator('#markdown').fill('禁用后 B 不应保存的新输入');
  await b.waitForTimeout(900); assert.equal(await record(), undefined);
  await a.locator('#draftDays').selectOption('1');
  await b.waitForFunction(() => document.querySelector('#draftDays').value === '1');
  results.push('清空后新输入可保存；再次禁用后 B 输入不保存，保存期限也同步');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'dist', `多侧栏回归-${version}.json`), JSON.stringify({ version, engine: 'Playwright Chromium', results, errors }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(results, null, 2));
 } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

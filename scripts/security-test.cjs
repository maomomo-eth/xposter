// 运行实际边界函数，避免仅检查源码字符串。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const security = require('../src/security.js');
const shared = require('../src/shared.js');
const png = new Uint8Array(fs.readFileSync(path.join(__dirname, '../assets/icon-16.png')));
let checks = 0;
function check(fn) { fn(); checks++; }
(async () => {
  for (const link of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', '\thttps://safe.site/a', 'file:///a']) {
    check(() => assert.equal(security.safeLink(link), null));
    const plan = shared.buildPastePlan(shared.parseMarkdown(`[链接](${link})`).segments);
    check(() => assert.ok(!plan.html.includes('href=')));
    check(() => assert.ok(plan.blocks.every(b => b.links.length === 0)));
  }
  check(() => assert.equal(security.safeLink('https://safe.site/a'), 'https://safe.site/a'));
  for (const url of ['http://safe.site/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://2130706433/a', 'https://a.local/a', 'https://user:pass@safe.site/a', 'https://safe.site:8080/a']) check(() => assert.throws(() => security.publicUrl(url)));
  check(() => assert.equal(security.publicUrl('https://images.real.site/a').hostname, 'images.real.site'));
  check(() => assert.ok(security.matches('https://*/*', 'https://images.real.site')));
  check(() => assert.ok(security.matches('*://*.real.site/*', 'https://images.real.site')));
  check(() => assert.ok(!security.matches('https://*.real.site/*', 'https://real.site.evil.site')));
  check(() => assert.ok(!security.matches('http://*/*', 'https://real.site')));
  for (const value of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', 'data:text/plain;base64,c2VjcmV0', 'data:image/png;base64,' + 'A'.repeat(Math.ceil(security.MAX_BYTES * 4 / 3) + 128)]) check(() => assert.throws(() => security.data(value)));
  check(() => assert.ok(security.signature(png, 'image/png')));
  check(() => assert.ok(!security.signature(new TextEncoder().encode('secret'), 'image/png')));
  check(() => assert.deepEqual(security.dimensions(png, 'image/png'), [16, 16]));
  let decoded = 0;
  global.createImageBitmap = async () => { decoded++; return { width: 16, height: 16, close() {} }; };
  await security.validate(png, 'image/png'); checks++;
  await assert.rejects(security.validate(new TextEncoder().encode('private'), 'image/png')); checks++;
  check(() => assert.equal(decoded, 1));
  const bomb = png.slice(); new DataView(bomb.buffer).setUint32(16, 10000000);
  await assert.rejects(security.validate(bomb, 'image/png')); checks++;
  check(() => assert.equal(decoded, 1));
  let cancelled = false;
  const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(security.MAX_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(security.stream(new Response(oversized))); checks++;
  check(() => assert.ok(cancelled));
  check(() => assert.equal(security.graphql({ errors: [{ message: 'failure' }], data: { result: { rest_id: '1' } } }, '1'), false));
  check(() => assert.equal(security.graphql({ data: {} }, '1'), false));
  check(() => assert.equal(security.graphql({ data: { result: { rest_id: '2' } } }, '1'), false));
  check(() => assert.equal(security.graphql({ data: { user: { id: '1' } } }, '1', 'ArticleEntityUpdateTitle', '标题'), false));
  const titleResult = { data: { article_entity_update_title: { article_results: { result: { __typename: 'ArticleEntity', rest_id: '1', title: '标题' } } } } };
  check(() => assert.equal(security.graphql(titleResult, '1', 'ArticleEntityUpdateTitle', '标题'), true));
  check(() => assert.equal(security.graphql(titleResult, '1', 'ArticleEntityUpdateTitle', '其他'), false));
  check(() => assert.equal(security.graphql({ ...titleResult, errors: { message: '失败' } }, '1', 'ArticleEntityUpdateTitle', '标题'), false));
  check(() => assert.equal(security.graphql({ ...titleResult, errors: null }, '1', 'ArticleEntityUpdateTitle', '标题'), false));
  const coverEntity = { __typename: 'ArticleEntity', rest_id: '1', cover_media: { media_id: '7' } };
  const coverResult = { errors: [], data: { article_entity_update_cover_media: { article_results: { result: coverEntity } } } };
  check(() => assert.equal(security.graphql(coverResult, '1', 'ArticleEntityUpdateCoverMedia', '7'), true));
  check(() => assert.equal(security.graphql(coverResult, '2', 'ArticleEntityUpdateCoverMedia', '7'), false));
  check(() => assert.equal(security.graphql(coverResult, '1', 'ArticleEntityUpdateCoverMedia', '8'), false));
  check(() => assert.equal(security.graphql({ data: { article_entity_update_cover_media: { article_results: { result: { ...coverEntity, __typename: 'User' } } } } }, '1', 'ArticleEntityUpdateCoverMedia', '7'), false));
  const exported = JSON.stringify({ text: '未发表正文', path: '../私密/图.png', error: 'https://img.site/a?signature=SECRET', nested: ['正文'] }, security.exportValue);
  check(() => assert.ok(!/正文|私密|SECRET|signature/.test(exported)));
  check(() => assert.ok(!security.uiError('failed https://img.site/a?signature=SECRET').includes('SECRET')));
  // X 源不能打开句柄库，连读取请求都应在接触 IndexedDB 前拒绝。
  const page = { btoa, location: { protocol: 'https:' }, xPosterSecurity: security, module: { exports: {} }, indexedDB: { open() { throw new Error('不应访问数据库'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/shared.js'), 'utf8'), page);
  await assert.rejects(page.module.exports.saveVaultHandle({ name: 'private' }), /扩展侧边栏/); checks++;
  await assert.rejects(page.module.exports.getVaultRecord(), /扩展侧边栏/); checks++;
  await assert.rejects(page.module.exports.resolveLocalImage('./photo.png'), /扩展侧边栏/); checks++;
  // 扩展源真实解析相对路径，非图片与超大文件在 arrayBuffer 前阻断。
  let reads = 0;
  let fakeFile = { name: 'secret.txt', type: 'text/plain', size: 10, arrayBuffer: async () => { reads++; return png.buffer; } };
  const handle = { queryPermission: async () => 'granted', getDirectoryHandle: async () => handle, getFileHandle: async () => ({ getFile: async () => fakeFile }) };
  const db = { transaction: () => ({ objectStore: () => ({ get() { const r = {}; queueMicrotask(() => { r.result = { handle }; r.onsuccess(); }); return r; } }) }) };
  const extension = { ...page, location: { protocol: 'chrome-extension:' }, module: { exports: {} }, indexedDB: { open() { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess(); }); return r; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/shared.js'), 'utf8'), extension);
  const local = extension.module.exports;
  check(() => assert.equal(reads, 0));
  assert.equal((await local.resolveLocalImage('./secret.txt')).ok, false); checks++;
  fakeFile = { ...fakeFile, name: 'large.png', type: 'image/png', size: security.MAX_BYTES + 1 };
  assert.equal((await local.resolveLocalImage('./large.png')).ok, false); checks++;
  check(() => assert.equal(reads, 0));
  assert.equal((await local.resolveLocalImage('../escape.png')).ok, false); checks++;
  assert.equal((await local.resolveLocalImage('./%2e%2e/escape.png')).ok, false); checks++;
  fakeFile = { ...fakeFile, name: 'valid.png', size: png.length };
  assert.equal((await local.resolveLocalImage('./images/valid.png')).ok, true); checks++;
  check(() => assert.equal(reads, 1));
  const validPlan = { html: '<p>a</p>', plain: 'a', targetUrl: 'https://x.com/compose/articles/edit/1', expectedText: '', contextToken: 'test', markerPrefix: '__TEST__', blocks: [{ type: 'unstyled', text: 'a', links: [], inlineStyleRanges: [] }], plan: [] };
  check(() => assert.equal(security.planSchema(validPlan), true));
  check(() => assert.equal(security.planSchema({ ...validPlan, blocks: [{ type: 'unstyled', text: 'a', links: [{ url: 'javascript:x', offset: 0, length: 1 }] }] }), false));
  check(() => assert.equal(security.planSchema({ ...validPlan, plan: [{ marker: 'm', op: { type: 'image', file: { base64: 'secret' } } }] }), false));
  check(() => assert.equal(security.planSchema({ ...validPlan, plan: Array(31).fill({}) }), false));
  const keys = JSON.stringify({ 'https://secret.site/?token=SECRET': '正文', nested: { '私密路径': 1 } }, security.exportValue);
  check(() => assert.ok(!/SECRET|私密|secret/.test(keys)));
  // 运行后台实际下载流程，验证权限失败及本机地址不会触发 fetch，重定向禁止跟随。
  let fetches = 0, granted = false, options = null;
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, getURL: () => 'chrome-extension://test/' },
    permissions: { contains: async () => granted, getAll: async () => ({ origins: [] }) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { get: async () => ({}), remove: async () => {} } }
  };
  const worker = vm.createContext({ chrome, xPosterSecurity: security, setTimeout, clearTimeout, URL, AbortController, Uint8Array, btoa, atob,
    Request,
    fetch: async (url, init) => { fetches++; options = url; return new Response(png, { headers: { 'content-type': 'image/png' } }); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8').replace('import "./security.js";', ''), worker);
  assert.equal((await vm.runInContext('fetchImage("https://images.real.site/a")', worker)).ok, false); checks++;
  check(() => assert.equal(fetches, 0));
  granted = true;
  assert.equal((await vm.runInContext('fetchImage("https://127.0.0.1/a")', worker)).ok, false); checks++;
  check(() => assert.equal(fetches, 0));
  assert.equal((await vm.runInContext('fetchImage("https://images.real.site/a")', worker)).ok, true); checks++;
  check(() => assert.equal(options.redirect, 'error'));
  check(() => assert.equal(options.credentials, 'omit'));
  check(() => assert.equal(options.targetAddressSpace, undefined));
  // Chrome 的真实错误顺序是 Failed to fetch；首次失败后应恢复并缓存图片。
  let attempts = 0;
  worker.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('Failed to fetch');
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  assert.equal((await vm.runInContext('probeImage("https://images.real.site/transient.png")', worker)).ok, true); checks++;
  check(() => assert.equal(attempts, 2));
  assert.equal((await vm.runInContext('fetchImage("https://images.real.site/transient.png")', worker)).cacheHit, true); checks++;
  check(() => assert.equal(attempts, 2));
  for (const message of ['Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource.', 'Load failed', 'Image fetch timed out']) {
    attempts = 0;
    worker.fetch = async () => { attempts++; throw new TypeError(message); };
    const failure = await vm.runInContext('probeImage("https://images.real.site/unreachable.png?token=SECRET")', worker);
    check(() => assert.equal(attempts, 2));
    check(() => assert.equal(failure.ok, false));
    check(() => assert.equal(failure.code, /timed out/.test(message) ? 'TIMEOUT' : 'NETWORK_ERROR'));
    check(() => assert.ok(failure.error.includes('Chrome could not download')));
    check(() => assert.ok(!/SECRET|did not return a usable image/.test(failure.error)));
  }
  for (const status of [403, 429, 503]) {
    attempts = 0;
    worker.fetch = async () => { attempts++; return new Response(null, { status }); };
    const failure = await vm.runInContext('probeImage("https://images.real.site/http.png")', worker);
    check(() => assert.equal(failure.code, 'HTTP_ERROR'));
    check(() => assert.equal(failure.status, status));
    check(() => assert.equal(attempts, status === 403 ? 1 : 2));
  }
  attempts = 0;
  worker.fetch = async () => { attempts++; return new Response('not an image', { headers: { 'content-type': 'image/png' } }); };
  const invalid = await vm.runInContext('probeImage("https://images.real.site/invalid.png")', worker);
  check(() => assert.equal(invalid.code, 'INVALID_IMAGE'));
  check(() => assert.equal(attempts, 1));
  // 签名链接的修复仍先于整个下载流程的网络重试。
  const urls = [];
  worker.fetch = async request => {
    urls.push(request.url);
    return urls.length === 1 ? new Response(null, { status: 403 }) : new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  const repaired = await vm.runInContext('probeImage("https://images.real.site/signed.png?q-signature=SECRET&response-content-type=image/png")', worker);
  check(() => assert.equal(repaired.ok, true));
  check(() => assert.equal(repaired.repairedSignedUrl, true));
  check(() => assert.equal(urls.length, 2));
  check(() => assert.ok(!urls[1].includes('response-content-type')));
  assert.equal((await vm.runInContext('fetchImage("data:image/png;base64,c2VjcmV0")', worker)).ok, false); checks++;
  await vm.runInContext('draftQueue', worker);
  const records = { xposter_sidepanel_draft: '升级前旧草稿' };
  chrome.storage.local.get = async () => structuredClone(records);
  chrome.storage.local.set = async values => Object.assign(records, structuredClone(values));
  chrome.storage.local.remove = async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key]; };
  const migrated = await vm.runInContext('draftOperation({ action: "read" })', worker);
  check(() => assert.equal(migrated.record.text, '升级前旧草稿'));
  check(() => assert.ok(migrated.record.expires > Date.now()));
  records.xposter_sidepanel_draft = { text: '过期', expires: 1 };
  let releaseRemove, enteredRemove;
  const removeGate = new Promise(resolve => { releaseRemove = resolve; });
  const removing = new Promise(resolve => { enteredRemove = resolve; });
  const originalRemove = chrome.storage.local.remove;
  chrome.storage.local.remove = async keys => { enteredRemove(); await removeGate; await originalRemove(keys); };
  const expiry = vm.runInContext('expireDraft()', worker);
  await removing;
  const saving = vm.runInContext('draftOperation({ action: "write", epoch: 0, text: "新草稿" })', worker);
  await new Promise(resolve => setImmediate(resolve));
  check(() => assert.equal(records.xposter_sidepanel_draft.text, '过期'));
  releaseRemove(); await expiry; await saving;
  check(() => assert.equal(records.xposter_sidepanel_draft.text, '新草稿'));
  chrome.storage.local.remove = originalRemove;
  await vm.runInContext('draftOperation({ action: "clear" })', worker);
  const stale = await vm.runInContext('draftOperation({ action: "write", epoch: 0, text: "迟到保存" })', worker);
  check(() => assert.equal(stale.stale, true));
  check(() => assert.equal(records.xposter_sidepanel_draft, undefined));
  await vm.runInContext('draftOperation({ action: "configure", enabled: false, days: 7 })', worker);
  const disabled = await vm.runInContext('draftOperation({ action: "write", epoch: 2, text: "禁用后保存" })', worker);
  check(() => assert.equal(disabled.stale, true));
  console.log(`安全回归通过：${checks} 项行为断言（图片真实解码由浏览器回归验证）`);
})().catch(error => { console.error(error); process.exitCode = 1; });

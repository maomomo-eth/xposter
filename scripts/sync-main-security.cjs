// MAIN 使用独立资源名，避免 Chromium 跨世界复用同一路径的脚本注册。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/security.js'), 'utf8');
const target = path.join(root, 'src/security-main.js');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== source) throw new Error('请运行 node scripts/sync-main-security.cjs 同步 MAIN 安全模块');
} else fs.writeFileSync(target, source, 'utf8');

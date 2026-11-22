// 仅打包扩展运行文件，避免把 Git 元数据、评审记录和开发脚本带入安装包。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(directory, prefix) {
  const local = [], central = [];
  let offset = 0, count = 0;
  function visit(dir, relative) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { visit(absolute, name); continue; }
      const filename = Buffer.from(name, "utf8");
      const raw = fs.readFileSync(absolute), compressed = zlib.deflateRawSync(raw);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12); header.writeUInt32LE(crc32(raw), 14);
      header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22);
      header.writeUInt16LE(filename.length, 26);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4);
      header.copy(record, 6, 4, 30); record.writeUInt32LE(offset, 42);
      local.push(header, filename, compressed); central.push(record, filename);
      offset += header.length + filename.length + compressed.length; count++;
    }
  }
  visit(directory, prefix);
  const directoryData = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryData, end]);
}

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = ["manifest.json", "LICENSE", "sidepanel.html", "sidepanel.css", "sidepanel.js",
  "diagnostics.html", "diagnostics.css", "diagnostics.js", "src", "assets", "fixtures"];
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const hashes = [];
for (const browser of ["chrome", "edge"]) {
  const name = `xposter-${manifest.version}-${browser}`;
  const target = path.join(dist, name);
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.cpSync(path.join(root, file), path.join(target, file), { recursive: true });
  const archive = `${name}.zip`;
  fs.writeFileSync(path.join(dist, archive), createZip(target, name));
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, archive))).digest("hex");
  hashes.push(`${sha}  ${archive}`);
  console.log(`已打包 ${archive}`);
}
fs.writeFileSync(path.join(dist, `SHA256SUMS-${manifest.version}.txt`), `${hashes.join("\n")}\n`, "utf8");

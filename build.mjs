import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const ROOT_DIR = process.cwd();

console.log('[BUILD] Bundling src/index.ts into script.js...');

// 1. Bundle TypeScript to script.js
esbuild.buildSync({
  entryPoints: [path.join(ROOT_DIR, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  outfile: path.join(ROOT_DIR, 'script.js'),
  external: [
    'server',
    'fs',
    'path',
    'events',
    'stream',
    'os',
    'process',
    'buffer',
    'util',
    'url',
    'crypto',
    'node:*',
  ],
  banner: {
    js: `// Komari Plugin Runtime Bridge
var module = typeof module !== 'undefined' ? module : { exports: {} };
var exports = typeof exports !== 'undefined' ? exports : module.exports;
`,
  },
  footer: {
    js: `
// Expose global load and unload for Goja runtime
var load = (typeof module !== 'undefined' && module.exports && module.exports.load)
  ? module.exports.load
  : (typeof index_exports !== 'undefined' ? index_exports.load : undefined);
var unload = (typeof module !== 'undefined' && module.exports && module.exports.unload)
  ? module.exports.unload
  : (typeof index_exports !== 'undefined' ? index_exports.unload : undefined);

if (typeof globalThis !== 'undefined') {
  globalThis.load = load;
  globalThis.unload = unload;
}
`,
  },
  sourcemap: false,
});

console.log('[BUILD] script.js created successfully.');

// 2. Pure Node.js ZIP archive generator (zero external dependencies)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function calcCrc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return ~crc >>> 0;
}

function writeZip(files, outPath) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf-8');
    const dataBuf = file.data;
    const crc = calcCrc32(dataBuf);
    const compressedBuf = zlib.deflateRawSync(dataBuf);
    const compSize = compressedBuf.length;
    const uncompSize = dataBuf.length;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(8, 8); // compression method: deflate
    localHeader.writeUInt16LE(0, 10); // file time
    localHeader.writeUInt16LE(0, 12); // file date
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(compSize, 18); // compressed size
    localHeader.writeUInt32LE(uncompSize, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedBuf);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(8, 10); // compression method: deflate
    centralHeader.writeUInt16LE(0, 12); // file time
    centralHeader.writeUInt16LE(0, 14); // file date
    centralHeader.writeUInt32LE(crc, 16); // crc-32
    centralHeader.writeUInt32LE(compSize, 20); // compressed size
    centralHeader.writeUInt32LE(uncompSize, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28); // file name length
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedBuf.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // total entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  const allBuffers = [...localHeaders, ...centralHeaders, eocd];
  fs.writeFileSync(outPath, Buffer.concat(allBuffers));
}

console.log('[BUILD] Packaging into ipqa-alert-report.zip...');

const filesToZip = [
  {
    name: 'komari-plugin.json',
    data: fs.readFileSync(path.join(ROOT_DIR, 'komari-plugin.json')),
  },
  {
    name: 'script.js',
    data: fs.readFileSync(path.join(ROOT_DIR, 'script.js')),
  },
  {
    name: 'assets/icon.svg',
    data: fs.readFileSync(path.join(ROOT_DIR, 'assets', 'icon.svg')),
  },
  {
    name: 'pages/admin.html',
    data: fs.readFileSync(path.join(ROOT_DIR, 'pages', 'admin.html')),
  },
];

const zipPath = path.join(ROOT_DIR, 'ipqa-alert-report.zip');
writeZip(filesToZip, zipPath);

console.log(`[BUILD] Package created successfully: ${zipPath} (${fs.statSync(zipPath).size} bytes)`);

// 3. Push installation package to Windows Desktop if available
const desktopDir = path.join(
  process.env.USERPROFILE || 'C:\\Users\\y2hlb',
  'Desktop'
);
if (fs.existsSync(desktopDir)) {
  const desktopZipPath = path.join(desktopDir, 'ipqa-alert-report.zip');
  try {
    fs.copyFileSync(zipPath, desktopZipPath);
    console.log(`[BUILD] Pushed installation package to Desktop: ${desktopZipPath} (${fs.statSync(desktopZipPath).size} bytes)`);
  } catch (err) {
    console.error(`[BUILD] Failed to copy package to Desktop:`, err);
  }
} else {
  console.warn(`[BUILD] Desktop directory not found at ${desktopDir}`);
}

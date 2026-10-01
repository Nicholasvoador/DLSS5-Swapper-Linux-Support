'use strict';
// Linux fork: the DLSS 5 payload (nvngx_dlssnr.dll, ReShade, RenoDX, Feeder,
// dgVoodoo hooks ...) is never bundled with the Linux build. It is fetched once
// from the upstream DLSS5-Swapper release this fork is pinned to, checked
// against a SHA-256 taken from that release, and unpacked into userData.
//
// The upstream portable build is an NSIS stub with one LZMA 7z archive
// appended (app-64.7z, stored, not compressed, by NSIS). Rather than teaching
// 7-Zip NSIS, find the 7z signature in the stub, copy the archive out byte for
// byte, and extract only resources/payload from it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const UPSTREAM = Object.freeze({
  version: '2.2.9',
  name: 'DLSS5-Swapper-2.2.9-portable.exe',
  url: 'https://github.com/rakanki911/DLSS5-Swapper/releases/download/v2.2.9/DLSS5-Swapper-2.2.9-portable.exe',
  size: 258133136,
  sha256: '6b064ecba6e487a87302c1d75c3fd2d8189e78fdf3c91e705eee3d4539ae23c8'
});

// Files that must be there for the payload to count. Anything less is a
// half-finished unpack and is redone.
const REQUIRED = [
  'streamline/nvngx_dlssnr.dll',
  'streamline/nvngx_dlss.dll',
  'renodx-dlss5.addon64',
  'reshade-vulkan/ReShade64.dll',
  'reshade-vulkan/ReShade32.dll',
  'feeder/dlss5-feed.addon64',
  'feeder/host64/renodx-dlss5.addon64'
];
const MARKER = '.dlss5-linux-payload.json';
const SEVENZ_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

const payloadDir = (userData) => path.join(userData, 'payload');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// Present, complete and from the pinned release.
function ready(userData, upstream = UPSTREAM) {
  const dir = payloadDir(userData);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    if (marker.sha256 !== upstream.sha256) return false;
  } catch { return false; }
  return REQUIRED.every((rel) => fs.existsSync(path.join(dir, rel)));
}

// The 7z archive inside an NSIS stub: signature, then the start header says
// how far the archive runs (32-byte header + next-header offset + size).
function locateArchive(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const window = Buffer.alloc(Math.min(size, 16 * 1024 * 1024));
    fs.readSync(fd, window, 0, window.length, 0);
    let at = window.indexOf(SEVENZ_SIGNATURE);
    while (at >= 0) {
      if (at + 32 <= window.length) {
        const nextOffset = Number(window.readBigUInt64LE(at + 12));
        const nextSize = Number(window.readBigUInt64LE(at + 20));
        const end = at + 32 + nextOffset + nextSize;
        if (nextSize > 0 && end <= size) return { offset: at, length: end - at };
      }
      at = window.indexOf(SEVENZ_SIGNATURE, at + 1);
    }
    throw new Error('the upstream package does not contain the expected 7z archive');
  } finally { fs.closeSync(fd); }
}

function sliceTo(file, { offset, length }, dest) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(file, { start: offset, end: offset + length - 1 })
      .on('error', reject)
      .pipe(fs.createWriteStream(dest))
      .on('error', reject)
      .on('finish', resolve);
  });
}

// 7-Zip: the copy that ships with the app (7zip-bin), made executable outside
// the read-only AppImage, then whatever the system has.
function sevenZipCandidates(userData) {
  const list = [];
  try {
    const bundled = require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(bundled)) {
      const local = path.join(userData, 'bin', '7za');
      try {
        if (!fs.existsSync(local) || fs.statSync(local).size !== fs.statSync(bundled).size) {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.copyFileSync(bundled, local);
        }
        fs.chmodSync(local, 0o755);
        list.push(local);
      } catch { /* fall through to the system's */ }
    }
  } catch { /* 7zip-bin not packaged */ }
  for (const dir of String(process.env.PATH || '').split(':').filter(Boolean)) {
    for (const name of ['7zz', '7z', '7za']) {
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); list.push(file); } catch { /* not here */ }
    }
  }
  return [...new Set(list)];
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 32 * 1024 * 1024, ...options },
    (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout))));
}

async function extract(archive, into, userData, runner = run) {
  let lastError = null;
  for (const tool of sevenZipCandidates(userData)) {
    try {
      await runner(tool, ['x', '-y', `-o${into}`, archive, 'resources/payload/*']);
      return tool;
    } catch (error) { lastError = error; }
  }
  throw new Error(`could not unpack the payload with 7-Zip${lastError ? `: ${lastError.message}` : ' (none found)'}`);
}

async function download(url, dest, expected, onProgress = () => {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'DLSS5-Swapper-Linux' },
    signal: AbortSignal.timeout(60 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || expected.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let received = 0, lastPercent = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      const percent = total ? Math.floor((received / total) * 100) : 0;
      if (percent !== lastPercent && percent % 5 === 0) { lastPercent = percent; onProgress(percent, received, total); }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const digest = hash.digest('hex');
  if (digest !== expected.sha256) {
    fs.rmSync(dest, { force: true });
    throw new Error(`SHA-256 mismatch for ${expected.name}: got ${digest}`);
  }
}

let inflight = null;
// Idempotent and single-flight: the boot fetch and an Install press share it.
function ensurePayload(userData, options = {}) {
  if (ready(userData, options.upstream || UPSTREAM)) return Promise.resolve(payloadDir(userData));
  if (!inflight) {
    inflight = fetchPayload(userData, options).finally(() => { inflight = null; });
  }
  return inflight;
}

async function fetchPayload(userData, { upstream = UPSTREAM, log = () => {}, fetchImpl, runner, localPackage } = {}) {
  const work = path.join(userData, 'payload-download');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    // A copy of the upstream package already on disk (a developer's, or one
    // the person downloaded) is used when it is the pinned file.
    const pkg = path.join(work, upstream.name);
    if (localPackage && fs.existsSync(localPackage) && await sha256File(localPackage) === upstream.sha256) {
      fs.copyFileSync(localPackage, pkg);
    } else {
      log('payloadDownloading', { version: upstream.version, mb: Math.round(upstream.size / 1048576) });
      await download(upstream.url, pkg, upstream, (percent) => log('payloadProgress', { percent }), fetchImpl);
    }
    log('payloadVerified', { version: upstream.version, sha256: upstream.sha256.slice(0, 16) });
    const archive = path.join(work, 'app-64.7z');
    await sliceTo(pkg, locateArchive(pkg), archive);
    fs.rmSync(pkg, { force: true });
    const unpack = path.join(work, 'unpacked');
    await extract(archive, unpack, userData, runner);
    const fresh = path.join(unpack, 'resources', 'payload');
    const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(fresh, rel)));
    if (missing.length) throw new Error(`the upstream payload is incomplete: ${missing.join(', ')}`);
    fs.writeFileSync(path.join(fresh, MARKER), JSON.stringify({
      source: upstream.url, version: upstream.version, sha256: upstream.sha256, unpacked: new Date().toISOString()
    }, null, 2));
    // Swap in whole: a payload is either the old one or the new one.
    const dest = payloadDir(userData);
    const old = `${dest}.old-${Date.now()}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(fresh, dest);
    fs.rmSync(old, { recursive: true, force: true });
    log('payloadReady', { version: upstream.version });
    return dest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { UPSTREAM, REQUIRED, MARKER, payloadDir, ready, ensurePayload, fetchPayload, locateArchive, sevenZipCandidates, sha256File };

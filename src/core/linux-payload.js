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

// The RenoDX consumers this fork pins ahead of the upstream package. Upstream
// 2.2.9 carries RenoDX 6.5.3; the fork moves on without waiting for a new
// upstream release by laying its own pinned builds over the payload. Each is
// fetched from the project's own release (src/core/renodx-release.js), and the
// zip and the file inside it are both checked against their digests. A payload
// whose consumers are not these exact files is not ready.
const renodxRelease = require('./renodx-release');
const componentPins = (release = renodxRelease) => [
  { ...release.CONSUMER, targets: ['renodx-dlss5.addon64', 'feeder/host64/renodx-dlss5.addon64'] },
  { ...release.MULTIPASS, targets: ['feeder/host64/renodx-dlss.addon64'] }
];
const COMPONENTS = Object.freeze(componentPins());

const payloadDir = (userData) => path.join(userData, 'payload');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}
// The consumers are a few MB; reading them synchronously keeps ready() cheap
// enough to ask on every launch and every install.
function digestOf(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}
const componentsCurrent = (dir, components = COMPONENTS) =>
  components.every((c) => c.targets.every((rel) => digestOf(path.join(dir, rel)) === c.sha256));

// The upstream package was unpacked here, completely, from the pinned release.
function upstreamReady(userData, upstream = UPSTREAM) {
  const dir = payloadDir(userData);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    if (marker.sha256 !== upstream.sha256) return false;
  } catch { return false; }
  return REQUIRED.every((rel) => fs.existsSync(path.join(dir, rel)));
}

// Present, complete, from the pinned release, and carrying the pinned add-ons.
function ready(userData, upstream = UPSTREAM, components = COMPONENTS) {
  return upstreamReady(userData, upstream) && componentsCurrent(payloadDir(userData), components);
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

async function extract(archive, into, userData, runner = run, args = ['x', '-y', `-o${into}`, archive, 'resources/payload/*']) {
  let lastError = null;
  for (const tool of sevenZipCandidates(userData)) {
    try {
      await runner(tool, args);
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
// Resolves once any payload job in flight has finished, however it ended, so an
// add-on update never races a payload being laid out.
const pending = () => (inflight ? inflight.then(() => {}, () => {}) : Promise.resolve());
// Idempotent and single-flight: the boot fetch and an Install press share it.
// When only the pinned add-ons moved, only they are fetched - a few MB - and
// the upstream package already on disk is kept.
function ensurePayload(userData, options = {}) {
  const upstream = options.upstream || UPSTREAM;
  const components = options.components || COMPONENTS;
  if (ready(userData, upstream, components)) return Promise.resolve(payloadDir(userData));
  if (!inflight) {
    const job = upstreamReady(userData, upstream)
      ? applyComponents(payloadDir(userData), userData, options).then((dir) => { recordComponents(dir, components); return dir; })
      : fetchPayload(userData, options);
    inflight = job.finally(() => { inflight = null; });
  }
  return inflight;
}

// Lay each pinned add-on over the payload in `dir`: download its release zip,
// check the zip's digest, take the one file out, check that file's digest, and
// only then replace each target - each one whole, or not at all.
async function applyComponents(dir, userData, { components = COMPONENTS, fetchImpl, runner, log = () => {} } = {}) {
  const stale = components.filter((c) => !c.targets.every((rel) => digestOf(path.join(dir, rel)) === c.sha256));
  if (!stale.length) return dir;
  const work = path.join(userData, 'component-download');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    for (const c of stale) {
      const [name, url, archiveSha256] = c.archive;
      log('componentDownloading', { name: c.file, version: c.version });
      const zip = path.join(work, name);
      // A zip the in-app updater already downloaded and checked is used as is,
      // when it is still the file the pin names; anything else is fetched.
      if (c.localArchive && digestOf(c.localArchive) === archiveSha256) fs.copyFileSync(c.localArchive, zip);
      else await download(url, zip, { name, sha256: archiveSha256 }, () => {}, fetchImpl);
      const out = path.join(work, `${name}.unpacked`);
      await extract(zip, out, userData, runner, ['e', '-y', `-o${out}`, zip, c.file, '-r']);
      const file = path.join(out, c.file);
      const digest = digestOf(file);
      if (digest !== c.sha256) throw new Error(`${c.file} in ${name} is not the pinned build (got ${digest || 'nothing'})`);
      for (const rel of c.targets) {
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, `${dest}.new`);
        fs.renameSync(`${dest}.new`, dest);
      }
      log('componentReady', { name: c.file, version: c.version });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return dir;
}

// The marker says which add-ons were laid over the upstream package, so a
// support report shows it without anyone hashing files.
function recordComponents(dir, components = COMPONENTS) {
  const file = path.join(dir, MARKER);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    marker.components = Object.fromEntries(components.map((c) => [c.file, { version: c.version, sha256: c.sha256 }]));
    fs.writeFileSync(file, JSON.stringify(marker, null, 2));
  } catch { /* no marker: nothing to annotate */ }
}

async function fetchPayload(userData, { upstream = UPSTREAM, components = COMPONENTS, log = () => {}, fetchImpl, runner, localPackage } = {}) {
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
    // The fork's pinned add-ons go in before the swap, so the payload that
    // appears is already the one this build was tested with.
    await applyComponents(fresh, userData, { components, fetchImpl, runner, log });
    recordComponents(fresh, components);
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

module.exports = {
  UPSTREAM, REQUIRED, MARKER, COMPONENTS, componentPins, payloadDir, ready, upstreamReady, componentsCurrent,
  ensurePayload, fetchPayload, applyComponents, recordComponents, locateArchive, sevenZipCandidates, sha256File,
  download, extract, digestOf, pending
};

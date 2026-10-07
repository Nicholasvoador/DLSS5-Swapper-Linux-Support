'use strict';
// Linux fork: updating the app and its RenoDX add-ons from inside the app.
//
// Two separate jobs that share the same rules:
//  - Nothing happens on its own. Each function here runs because the person
//    pressed a button, and it reports every step through `log`.
//  - Nothing is used until its SHA-256 matches a digest published with it.
//    GitHub records a digest for every release asset when it is uploaded.
//    The app's own packages are also checked against the release's
//    SHA256SUMS.txt.
//
// The app comes from this fork's releases. It is installed the way it was
// installed before: an AppImage replaces itself, while rpm and deb packages
// go through the system's package manager under pkexec, so the desktop asks
// for the password.
//
// The RenoDX add-ons come from the project's own release feed. A newer build
// than the one this release pins is checked (digest, then a 64-bit Windows DLL),
// laid into the payload the same all-or-nothing way as the pinned one, and
// remembered in addon-pins.json. Revert removes the entry and the pinned build
// goes back. A later app release whose own pin is as new or newer wins, so a
// stale entry can never hold an add-on back.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const versionCheck = require('./version-check');
const linuxPayload = require('./linux-payload');
const renodxRelease = require('./renodx-release');
const addonRefresh = require('./addon-refresh');

const API = 'https://api.github.com/repos';
const TIMEOUT = 10000;
const SHA = /^[0-9a-f]{64}$/;
const PINS_FILE = 'addon-pins.json';

// ---------------------------------------------------------------- versions

// "2.2.9-linux.3" is upstream 2.2.9 plus this fork's third release on top of
// it. The general comparator treats "-linux.N" as a label and ignores it, which
// is right for add-ons and wrong here: linux.3 must beat linux.2.
function parseAppVersion(value) {
  const match = /^v?(\d+(?:\.\d+)*)(?:-linux\.(\d+))?$/i.exec(String(value || '').trim());
  return match ? { base: match[1], n: match[2] ? Number(match[2]) : 0 } : null;
}
function compareApp(left, right) {
  const a = parseAppVersion(left), b = parseAppVersion(right);
  if (!a || !b) return 0;
  const base = versionCheck.compare(a.base, b.base);
  if (base) return base;
  return a.n === b.n ? 0 : (a.n > b.n ? 1 : -1);
}

// ---------------------------------------------------------------- GitHub

async function github(route, fetchImpl, timeout = TIMEOUT) {
  const response = await fetchImpl(`${API}/${route}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'DLSS5-Swapper-Linux/updates' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    // GitHub answers 60 unsigned API requests an hour per connection, and then
    // 403 until the hour is up. Say that, and when it ends - "403" alone reads
    // like something broke.
    const remaining = response.headers && response.headers.get ? response.headers.get('x-ratelimit-remaining') : null;
    if ((response.status === 403 || response.status === 429) && remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset > 0 ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
      throw Object.assign(new Error(`GitHub's limit of update checks from this connection is used up for the hour${when ? `; it resets at ${when}` : ''}. Nothing is wrong with the app; check again then.`), {
        status: response.status, code: 'rateLimited', resetAt: reset > 0 ? reset : null
      });
    }
    throw Object.assign(new Error(`GitHub answered ${response.status}`), { status: response.status });
  }
  return response.json();
}
const digestHex = (asset) => {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || ''));
  return match ? match[1].toLowerCase() : null;
};
const releaseDownload = (repo) => `https://github.com/${repo}/releases/download/`;

// ---------------------------------------------------------------- add-ons

const ADDONS = Object.freeze({
  renodx: Object.freeze({
    key: 'renodx', pin: 'CONSUMER', label: 'RenoDX DLSS 5 add-on',
    repo: 'RankFTW/rhi-repo', prefix: 'renodx-dlss5-', asset: /^renodx-dlss5_[\w.+-]+\.zip$/i,
    display: (version) => version
  }),
  multipass: Object.freeze({
    key: 'multipass', pin: 'MULTIPASS', label: 'RenoDX multipass (SF)',
    repo: 'RankFTW/rhi-repo', prefix: 'renodx-dlss-SF-', asset: /^renodx-dlss_SF_[\w.+-]+\.zip$/i,
    display: (version) => `SF ${version}`
  })
});

const pinsFile = (userData) => path.join(userData, PINS_FILE);
function readOverrides(userData) {
  try {
    const saved = JSON.parse(fs.readFileSync(pinsFile(userData), 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}
function writeOverrides(userData, overrides) {
  const file = pinsFile(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.new`, JSON.stringify(overrides, null, 2));
  fs.renameSync(`${file}.new`, file);
}
// A saved entry is used only when it is complete, names the same file, points at
// the add-on's own release downloads, and carries both digests.
function validPin(pin, builtIn, addon) {
  return Boolean(pin) && typeof pin.version === 'string' && pin.file === builtIn.file &&
    SHA.test(String(pin.sha256)) && Array.isArray(pin.archive) && pin.archive.length === 3 &&
    typeof pin.archive[0] === 'string' && !/[\\/]/.test(pin.archive[0]) &&
    String(pin.archive[1]).startsWith(releaseDownload(addon.repo)) && SHA.test(String(pin.archive[2]));
}

// The pins the payload should carry: each built-in one, or the person's newer
// accepted build of it.
function effectiveRelease(userData, release = renodxRelease) {
  const overrides = readOverrides(userData);
  const out = { ...release, origin: {} };
  for (const addon of Object.values(ADDONS)) {
    const builtIn = release[addon.pin];
    const saved = overrides[addon.key];
    if (validPin(saved, builtIn, addon) && versionCheck.compare(saved.version, builtIn.version) > 0) {
      out[addon.pin] = Object.freeze({ version: saved.version, file: builtIn.file, archive: Object.freeze([...saved.archive]), sha256: saved.sha256 });
      out.origin[addon.key] = 'updated';
    } else {
      out.origin[addon.key] = 'builtin';
    }
  }
  return out;
}
const components = (userData, release = renodxRelease) => linuxPayload.componentPins(effectiveRelease(userData, release));

// rhi-repo mirrors many projects - NVIDIA's DLLs, Streamline, DLSS Enabler -
// and RenoDX is a few of its releases among them. A run of those can push the
// newest RenoDX past any fixed-size first page, and the panel would then say
// nothing is newer. So: a full page of 100, and more pages only while some
// add-on has not appeared at all. Normally that is one request.
const PAGE = 100;
const MAX_PAGES = 4;
async function releasePages(repo, prefixes, fetchImpl, timeout) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await github(`${repo}/releases?per_page=${PAGE}&page=${page}`, fetchImpl, timeout);
    if (!Array.isArray(batch)) break;
    rows.push(...batch);
    const missing = prefixes.some((prefix) => !rows.some((row) => String(row.tag_name || '').startsWith(prefix)));
    if (!missing || batch.length < PAGE) break;
  }
  return rows;
}

// The newest build of each add-on, plus its download. Both add-ons come from one
// repository, so this is one request. The channel matches the version check:
// RenoDX publishes its consumers as rc builds, and that is the channel everyone
// installs from. Anything GitHub flags as a prerelease is left out.
async function latestAddons({ fetchImpl = global.fetch, timeout = TIMEOUT } = {}) {
  const requests = new Map();
  const out = {};
  for (const addon of Object.values(ADDONS)) {
    if (!requests.has(addon.repo)) {
      const prefixes = Object.values(ADDONS).filter((other) => other.repo === addon.repo).map((other) => other.prefix);
      requests.set(addon.repo, releasePages(addon.repo, prefixes, fetchImpl, timeout));
    }
  }
  for (const addon of Object.values(ADDONS)) {
    let rows;
    try { rows = await requests.get(addon.repo); } catch (error) { out[addon.key] = { error: error.message }; continue; }
    let best = null;
    for (const row of Array.isArray(rows) ? rows : []) {
      const tag = String(row.tag_name || '');
      if (row.draft || row.prerelease === true || !tag.startsWith(addon.prefix)) continue;
      const version = versionCheck.tagVersion(tag, addon.prefix);
      if (!version) continue;
      if (!best || versionCheck.compare(version, best.version) > 0) best = { row, version };
    }
    if (!best) { out[addon.key] = { error: 'no release found' }; continue; }
    const asset = (best.row.assets || []).find((item) => addon.asset.test(String(item.name || '')) &&
      String(item.browser_download_url || '').startsWith(releaseDownload(addon.repo)));
    out[addon.key] = {
      version: addon.display(best.version),
      tag: best.row.tag_name,
      published: best.row.published_at || null,
      notes: best.row.html_url || `https://github.com/${addon.repo}/releases`,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0, sha256: digestHex(asset) } : null
    };
  }
  return out;
}

// A ReShade add-on is a 64-bit Windows DLL. Anything else in the zip under that
// name is refused before it goes near a game.
function checkAddonBinary(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 4096 || size > 64 * 1024 * 1024) throw new Error(`unexpected size ${size}`);
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.readUInt16LE(0) !== 0x5a4d) throw new Error('not a Windows program (no MZ header)');
    const pe = head.readUInt32LE(0x3c);
    if (pe + 26 > head.length || head.readUInt32LE(pe) !== 0x00004550) throw new Error('no PE header');
    if (head.readUInt16LE(pe + 4) !== 0x8664) throw new Error('not built for 64-bit x86');
    if (!(head.readUInt16LE(pe + 22) & 0x2000)) throw new Error('not a DLL');
    if (head.readUInt16LE(pe + 24) !== 0x20b) throw new Error('not a PE32+ image');
    return { size };
  } finally { fs.closeSync(fd); }
}

async function updateAddon(key, { userData, release = renodxRelease, offer = null, fetchImpl = global.fetch, runner, log = () => {} } = {}) {
  const addon = ADDONS[key];
  if (!addon) throw new Error(`unknown add-on ${key}`);
  const effective = effectiveRelease(userData, release);
  const current = effective[addon.pin];
  const latest = offer || (await latestAddons({ fetchImpl }))[key];
  if (!latest || latest.error) throw new Error(`could not read ${addon.label} releases: ${(latest && latest.error) || 'no answer'}`);
  if (versionCheck.compare(latest.version, current.version) <= 0) return { ok: true, upToDate: true, version: current.version };
  if (!latest.asset) throw new Error(`${latest.tag} has no ${addon.label} download`);
  if (!latest.asset.sha256) throw new Error(`GitHub published no SHA-256 for ${latest.asset.name}, so it cannot be checked; not installing it`);

  const work = path.join(userData, 'addon-update');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    log('addonDownloading', { label: addon.label, version: latest.version });
    const zip = path.join(work, latest.asset.name);
    await linuxPayload.download(latest.asset.url, zip, { name: latest.asset.name, sha256: latest.asset.sha256, size: latest.asset.size }, () => {}, fetchImpl);
    log('addonVerified', { name: latest.asset.name, sha256: latest.asset.sha256.slice(0, 16) });
    const out = path.join(work, 'unpacked');
    await linuxPayload.extract(zip, out, userData, runner, ['e', '-y', `-o${out}`, zip, current.file, '-r']);
    const file = path.join(out, current.file);
    if (!fs.existsSync(file)) throw new Error(`${latest.asset.name} does not contain ${current.file}`);
    checkAddonBinary(file);
    const pin = {
      version: latest.version, file: current.file,
      archive: [latest.asset.name, latest.asset.url, latest.asset.sha256],
      sha256: linuxPayload.digestOf(file), tag: latest.tag, acceptedAt: new Date().toISOString()
    };
    // Into the payload first, remembered second. If the second step fails, the
    // payload no longer matches its pins and the next install re-lays the
    // pinned build. Neither order can leave a mismatch that sticks.
    let applied = false;
    if (linuxPayload.upstreamReady(userData)) {
      await linuxPayload.pending();
      const next = linuxPayload.componentPins({ ...effective, [addon.pin]: pin })
        .map((c) => (c.file === current.file ? { ...c, localArchive: zip } : c));
      const dir = linuxPayload.payloadDir(userData);
      // The zip was checked a moment ago and is reused, so the payload step's
      // own "fetching the pinned build" lines would only mislead here.
      await linuxPayload.applyComponents(dir, userData, { components: next, fetchImpl, runner, log: () => {} });
      linuxPayload.recordComponents(dir, next);
      applied = true;
    }
    writeOverrides(userData, { ...readOverrides(userData), [key]: pin });
    // Games set up from now on get this build; a later one may replace it there.
    addonRefresh.rememberBuild(userData, current.file, pin.sha256, latest.version);
    log('addonReady', { label: addon.label, version: latest.version });
    return { ok: true, version: latest.version, previous: current.version, sha256: pin.sha256, applied };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function revertAddon(key, { userData, release = renodxRelease, fetchImpl = global.fetch, runner, log = () => {} } = {}) {
  const addon = ADDONS[key];
  if (!addon) throw new Error(`unknown add-on ${key}`);
  const overrides = readOverrides(userData);
  const builtIn = release[addon.pin];
  if (!overrides[key]) return { ok: true, unchanged: true, version: builtIn.version };
  delete overrides[key];
  writeOverrides(userData, overrides);
  let applied = false;
  if (linuxPayload.upstreamReady(userData)) {
    await linuxPayload.pending();
    const list = components(userData, release);
    const dir = linuxPayload.payloadDir(userData);
    await linuxPayload.applyComponents(dir, userData, { components: list, fetchImpl, runner, log });
    linuxPayload.recordComponents(dir, list);
    applied = true;
  }
  log('addonReverted', { label: addon.label, version: builtIn.version });
  return { ok: true, version: builtIn.version, applied };
}

// ---------------------------------------------------------------- the app

const APP_ASSETS = Object.freeze({
  appimage: /[-_.]x86_64\.AppImage$/,
  rpm: /[-_.]x86_64\.rpm$/,
  deb: /[-_.]amd64\.deb$/
});

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000, ...options },
    (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr || '') })) : resolve(String(stdout || '')))));
}

// How this copy was installed decides how it is replaced. Only this app's own
// package counts: a copy some distribution packaged under another name is
// that distribution's to update.
const PACKAGE = 'dlss5-swapper';
async function installKind({ env = process.env, execPath = process.execPath, runner = run } = {}) {
  if (env.APPIMAGE) return { kind: 'appimage', target: env.APPIMAGE };
  let owner = null;
  try {
    const name = (await runner('rpm', ['-qf', '--qf', '%{NAME}', execPath])).trim();
    if (name && !/not owned|\s/.test(name)) owner = { kind: 'rpm', package: name };
  } catch { /* not an rpm system, or not an rpm install */ }
  if (!owner) {
    try {
      const name = (await runner('dpkg-query', ['-S', execPath])).split(':')[0].trim();
      if (name) owner = { kind: 'deb', package: name };
    } catch { /* not a deb install */ }
  }
  if (!owner) return { kind: 'unmanaged' };
  return owner.package === PACKAGE ? owner : { kind: 'unmanaged', package: owner.package };
}

// The newest full release of the fork, compared the fork's way.
async function latestApp({ repo, current, fetchImpl = global.fetch, timeout = TIMEOUT }) {
  const rows = await github(`${repo}/releases?per_page=15`, fetchImpl, timeout);
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.draft || row.prerelease || !parseAppVersion(row.tag_name)) continue;
    if (!best || compareApp(row.tag_name, best.tag_name) > 0) best = row;
  }
  if (!best) return { current, latest: null, newer: false };
  const version = String(best.tag_name).replace(/^v/, '');
  return {
    current, latest: version, tag: best.tag_name, name: best.name || best.tag_name,
    notes: best.html_url || `https://github.com/${repo}/releases`,
    newer: compareApp(version, current) > 0,
    assets: (best.assets || [])
      .filter((asset) => String(asset.browser_download_url || '').startsWith(releaseDownload(repo)))
      .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size || 0, sha256: digestHex(asset) }))
  };
}

const sumsFor = (text) => Object.fromEntries(String(text || '').split(/\r?\n/)
  .map((line) => /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)).filter(Boolean).map((m) => [m[2], m[1].toLowerCase()]));

// The package for this kind of install, and the digest it must have. GitHub's
// digest and SHA256SUMS.txt must agree when both exist. At least one must.
async function appDownload(release, kind, { fetchImpl = global.fetch, timeout = TIMEOUT } = {}) {
  const pattern = APP_ASSETS[kind];
  if (!pattern) throw new Error(`a ${kind} install cannot update itself`);
  const asset = (release.assets || []).find((item) => pattern.test(item.name));
  if (!asset) throw new Error(`${release.tag} has no ${kind} package`);
  let listed = null;
  const sums = (release.assets || []).find((item) => item.name === 'SHA256SUMS.txt');
  if (sums) {
    const response = await fetchImpl(sums.url, { headers: { 'user-agent': 'DLSS5-Swapper-Linux/updates' }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`could not read SHA256SUMS.txt (${response.status})`);
    listed = sumsFor(await response.text())[asset.name] || null;
  }
  if (asset.sha256 && listed && asset.sha256 !== listed) throw new Error(`${asset.name}: SHA256SUMS.txt and GitHub disagree; not installing it`);
  const sha256 = asset.sha256 || listed;
  if (!sha256) throw new Error(`${asset.name} has no published SHA-256; not installing it`);
  return { ...asset, sha256, checkedBy: [asset.sha256 && 'GitHub', listed && 'SHA256SUMS.txt'].filter(Boolean) };
}

async function downloadApp(asset, { userData, fetchImpl = global.fetch, log = () => {} } = {}) {
  const work = path.join(userData, 'app-update');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, asset.name);
  log('appDownloading', { name: asset.name, mb: Math.round((asset.size || 0) / 1048576) });
  await linuxPayload.download(asset.url, file, asset, (percent) => log('appProgress', { percent }), fetchImpl);
  log('appVerified', { name: asset.name, sha256: asset.sha256.slice(0, 16), by: asset.checkedBy.join(' + ') });
  return file;
}

// pkexec answers 126 when the person dismisses the password prompt and 127
// when authentication fails. Neither is a fault in the package.
function packageManager(kind, file, exists = fs.existsSync) {
  if (kind === 'rpm') return exists('/usr/bin/dnf') ? ['/usr/bin/dnf', 'install', '-y', file] : ['/usr/bin/rpm', '-U', file];
  if (kind === 'deb') return ['/usr/bin/apt-get', 'install', '-y', file];
  throw new Error(`no package manager for ${kind}`);
}

async function installApp(kind, file, { target = null, runner = run, exists = fs.existsSync, log = () => {} } = {}) {
  if (kind === 'appimage') {
    if (!target) throw new Error('the running AppImage was not found');
    const next = `${target}.update-${process.pid}`;
    try {
      fs.copyFileSync(file, next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, target);
    } catch (error) {
      fs.rmSync(next, { force: true });
      if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
        throw Object.assign(new Error(`${path.dirname(target)} is not writable, so the AppImage cannot replace itself`), { code: 'appimageNotWritable' });
      }
      throw error;
    }
    log('appInstalled', { kind });
    return { ok: true, kind, relaunch: target };
  }
  const command = packageManager(kind, file, exists);
  log('appInstalling', { kind, command: command.join(' ') });
  try {
    await runner('/usr/bin/pkexec', command);
  } catch (error) {
    if (error.code === 126 || error.code === 127) throw Object.assign(new Error('The password prompt was closed or the password was not accepted'), { code: 'authCancelled' });
    throw new Error(`${path.basename(command[0])} failed: ${(error.stderr || error.message || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  log('appInstalled', { kind });
  return { ok: true, kind, relaunch: null };
}

// After an update the new version is started by a small detached shell that
// waits for this process to be gone first. Electron's own app.relaunch()
// leaves a helper running from inside the AppImage's mount, which disappears
// as this process exits; and starting before this process has quit would hit
// the single-instance lock and close at once.
//
// The shell also closes every descriptor it inherited before it starts the new
// version. Otherwise the old process's sockets - its single-instance socket
// among them - and the AppImage runtime's keep-alive pipe leak into the new
// process, and the pipe keeps the old mount alive for as long as the new
// version runs. bash, because POSIX sh cannot close a descriptor above 9.
function relaunchSpec({ execPath, args = [], pid, shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh' }) {
  const script = [
    'for fd in /proc/$$/fd/*; do fd=${fd##*/}; case "$fd" in 0|1|2) ;; *) eval "exec $fd>&-" 2>/dev/null ;; esac; done',
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
    'shift',
    'exec "$@"'
  ].join('\n');
  return { file: shell, args: ['-c', script, 'dlss5-relaunch', String(pid), execPath, ...args] };
}

module.exports = {
  ADDONS, APP_ASSETS, PINS_FILE,
  parseAppVersion, compareApp, digestHex, sumsFor,
  readOverrides, writeOverrides, validPin, effectiveRelease, components, latestAddons, checkAddonBinary, updateAddon, revertAddon,
  installKind, latestApp, appDownload, downloadApp, packageManager, installApp, relaunchSpec
};

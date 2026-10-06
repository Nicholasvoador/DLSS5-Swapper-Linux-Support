'use strict';
// Linux fork: updating the app and the RenoDX add-ons from inside the app
// (src/core/updates.js, and its IPC in main.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('module');
const updates = require('../src/core/updates');
const linuxPayload = require('../src/core/linux-payload');
const versionCheck = require('../src/core/version-check');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swapper-updates-${name}-`));
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const RHI = 'https://github.com/RankFTW/rhi-repo/releases/download/';

// A minimal PE image: MZ, PE signature, machine, characteristics, optional magic.
function pe({ machine = 0x8664, dll = true, magic = 0x20b, size = 8192 } = {}) {
  const b = Buffer.alloc(size);
  b.writeUInt16LE(0x5a4d, 0);
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32LE(0x00004550, 0x80);
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(dll ? 0x2022 : 0x0022, 0x80 + 22);
  b.writeUInt16LE(magic, 0x80 + 24);
  b.write(crypto.randomBytes(8).toString('hex'), 0x200);
  return b;
}

// ---------------------------------------------------------------- versions

test('a fork release beats the one before it, and an upstream release beats them all', () => {
  const order = ['2.2.8', '2.2.9', '2.2.9-linux.1', '2.2.9-linux.2', 'v2.2.9-linux.3', '2.2.9-linux.10', '2.2.10', '2.2.10-linux.1', '2.3.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(updates.compareApp(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.equal(updates.compareApp('2.2.9-linux.2', 'nonsense'), 0, 'an unreadable tag is never newer');
  // The general comparator still ignores the fork label - which is why the app
  // needs its own.
  assert.equal(versionCheck.compare('2.2.9-linux.2', '2.2.9-linux.3'), 0);
});

// ---------------------------------------------------------------- add-on feed

function feed() {
  return [
    { tag_name: 'renodx-dlss-SF-26.1003.2350', prerelease: false, html_url: 'https://github.com/RankFTW/rhi-repo/releases/tag/renodx-dlss-SF-26.1003.2350',
      assets: [{ name: 'renodx-dlss_SF_26.1003.2350.zip', size: 10, browser_download_url: `${RHI}renodx-dlss-SF-26.1003.2350/renodx-dlss_SF_26.1003.2350.zip`, digest: `sha256:${'1'.repeat(64)}` }] },
    { tag_name: 'renodx-dlss-SF-26.1009.0001', draft: true, assets: [] },
    { tag_name: 'renodx-dlss-SF-26.1010.0001', prerelease: true, assets: [] },
    { tag_name: 'renodx-dlss5-8.5.0-rc5', assets: [{ name: 'renodx-dlss5_8.5.0-rc5.zip', browser_download_url: `${RHI}renodx-dlss5-8.5.0-rc5/renodx-dlss5_8.5.0-rc5.zip`, digest: `sha256:${'2'.repeat(64)}` }] },
    { tag_name: 'renodx-dlss5-8.5.0-rc12', assets: [{ name: 'renodx-dlss5_8.5.0-rc12.zip', browser_download_url: 'https://evil.example/renodx-dlss5_8.5.0-rc12.zip', digest: `sha256:${'3'.repeat(64)}` }] },
    { tag_name: 'renodx-dlss5-8.5.0-rc10', assets: [{ name: 'renodx-dlss5_8.5.0-rc10.zip', browser_download_url: `${RHI}renodx-dlss5-8.5.0-rc10/renodx-dlss5_8.5.0-rc10.zip` }] },
    { tag_name: 'other-product-9.9.9', assets: [] }
  ];
}

test('the add-on feed is read once, by tag prefix, never a draft or a flagged prerelease', async () => {
  const asked = [];
  const latest = await updates.latestAddons({ fetchImpl: async (url) => { asked.push(url); return json(feed()); } });
  assert.deepEqual(asked, ['https://api.github.com/repos/RankFTW/rhi-repo/releases?per_page=30'], 'one repository, one request');
  assert.equal(latest.multipass.version, 'SF 26.1003.2350');
  assert.equal(latest.multipass.asset.sha256, '1'.repeat(64));
  // rc12 is newest, but its download is not on the project's own releases.
  assert.equal(latest.renodx.version, '8.5.0-rc12');
  assert.equal(latest.renodx.asset, null, 'a download from anywhere else is not offered');
});

test('a release GitHub published no digest for is never installed', async (t) => {
  const userData = tmp(t, 'nodigest');
  const offer = { version: '8.5.0-rc11', tag: 'renodx-dlss5-8.5.0-rc11', asset: { name: 'renodx-dlss5_8.5.0-rc11.zip', url: `${RHI}x/renodx-dlss5_8.5.0-rc11.zip`, size: 1, sha256: null } };
  await assert.rejects(updates.updateAddon('renodx', { userData, offer, fetchImpl: async () => { throw new Error('nothing should be fetched'); } }), /no SHA-256/);
  assert.deepEqual(updates.readOverrides(userData), {});
});

// ---------------------------------------------------------------- pins

const builtIn = (over = {}) => ({
  CONSUMER: Object.freeze({ version: '8.5.0-rc10', file: 'renodx-dlss5.addon64', archive: ['a.zip', `${RHI}a/a.zip`, 'a'.repeat(64)], sha256: 'b'.repeat(64), ...(over.CONSUMER || {}) }),
  MULTIPASS: Object.freeze({ version: 'SF 26.0928.0205', file: 'renodx-dlss.addon64', archive: ['m.zip', `${RHI}m/m.zip`, 'c'.repeat(64)], sha256: 'd'.repeat(64), ...(over.MULTIPASS || {}) })
});
const saved = (version, over = {}) => ({ version, file: 'renodx-dlss.addon64', archive: ['n.zip', `${RHI}n/n.zip`, 'e'.repeat(64)], sha256: 'f'.repeat(64), ...over });

test('an accepted add-on is used only while it is newer than the one the app ships, and only if it is whole', (t) => {
  const userData = tmp(t, 'pins');
  const release = builtIn();
  assert.deepEqual(updates.effectiveRelease(userData, release).origin, { renodx: 'builtin', multipass: 'builtin' });

  updates.writeOverrides(userData, { multipass: saved('SF 26.1003.2350') });
  let eff = updates.effectiveRelease(userData, release);
  assert.equal(eff.MULTIPASS.version, 'SF 26.1003.2350');
  assert.equal(eff.origin.multipass, 'updated');
  assert.equal(eff.CONSUMER, release.CONSUMER);
  const pins = linuxPayload.componentPins(eff);
  assert.deepEqual(pins.find((c) => c.file === 'renodx-dlss.addon64').targets, ['feeder/host64/renodx-dlss.addon64']);

  // A later app release that ships the same or a newer build wins.
  eff = updates.effectiveRelease(userData, builtIn({ MULTIPASS: { version: 'SF 26.1003.2350' } }));
  assert.equal(eff.origin.multipass, 'builtin');

  for (const [why, entry] of [
    ['another file', saved('SF 27.0101.0000', { file: 'renodx-dlss5.addon64' })],
    ['a download from elsewhere', saved('SF 27.0101.0000', { archive: ['n.zip', 'https://evil.example/n.zip', 'e'.repeat(64)] })],
    ['a path in the name', saved('SF 27.0101.0000', { archive: ['../n.zip', `${RHI}n/n.zip`, 'e'.repeat(64)] })],
    ['no file digest', saved('SF 27.0101.0000', { sha256: 'nope' })],
    ['no zip digest', saved('SF 27.0101.0000', { archive: ['n.zip', `${RHI}n/n.zip`, ''] })]
  ]) {
    updates.writeOverrides(userData, { multipass: entry });
    assert.equal(updates.effectiveRelease(userData, release).origin.multipass, 'builtin', why);
  }
  fs.writeFileSync(path.join(userData, updates.PINS_FILE), '{ not json');
  assert.equal(updates.effectiveRelease(userData, release).origin.multipass, 'builtin', 'a damaged file is ignored');
});

test('only a 64-bit Windows DLL passes as an add-on', (t) => {
  const dir = tmp(t, 'pe');
  const write = (name, buffer) => { const file = path.join(dir, name); fs.writeFileSync(file, buffer); return file; };
  assert.ok(updates.checkAddonBinary(write('ok.addon64', pe())));
  assert.throws(() => updates.checkAddonBinary(write('x86.addon64', pe({ machine: 0x14c }))), /64-bit/);
  assert.throws(() => updates.checkAddonBinary(write('exe.addon64', pe({ dll: false }))), /not a DLL/);
  assert.throws(() => updates.checkAddonBinary(write('pe32.addon64', pe({ magic: 0x10b }))), /PE32\+/);
  assert.throws(() => updates.checkAddonBinary(write('text.addon64', Buffer.alloc(8192, 'x'))), /MZ/);
  assert.throws(() => updates.checkAddonBinary(write('tiny.addon64', Buffer.from('MZ'))), /size/);
});

// ---------------------------------------------------------------- update and revert, end to end

function payloadOnDisk(userData, release) {
  const dir = linuxPayload.payloadDir(userData);
  for (const rel of linuxPayload.REQUIRED) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `upstream ${rel}`);
  }
  fs.mkdirSync(path.join(dir, 'feeder', 'host64'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'feeder/host64/renodx-dlss.addon64'), 'shipped multipass');
  fs.writeFileSync(path.join(dir, linuxPayload.MARKER), JSON.stringify({ version: 'test', sha256: linuxPayload.UPSTREAM.sha256 }));
  return dir;
}
function zipOf(t, userData, name, content) {
  const tools = linuxPayload.sevenZipCandidates(userData);
  if (!tools.length) return null;
  const stage = tmp(t, 'zip');
  fs.writeFileSync(path.join(stage, name), content);
  execFileSync(tools[0], ['a', '-tzip', '-y', path.join(stage, 'out.zip'), name], { cwd: stage, stdio: 'ignore' });
  return fs.readFileSync(path.join(stage, 'out.zip'));
}

test('updating an add-on lays the checked build into the payload, and Revert puts the shipped one back', async (t) => {
  const userData = tmp(t, 'e2e');
  const dir = payloadOnDisk(userData);
  const shippedDll = pe(), newDll = pe();
  const shippedZip = zipOf(t, userData, 'renodx-dlss.addon64', shippedDll);
  if (!shippedZip) return t.skip('no 7-Zip available on this machine');
  const newZip = zipOf(t, userData, 'renodx-dlss.addon64', newDll);
  const release = builtIn({ MULTIPASS: { archive: ['m.zip', `${RHI}m/m.zip`, sha(shippedZip)], sha256: sha(shippedDll) } });
  // The consumer is current in this payload, so only the multipass moves.
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'consumer');
  fs.writeFileSync(path.join(dir, 'feeder/host64/renodx-dlss5.addon64'), 'consumer');
  const consumer = { ...release.CONSUMER, sha256: sha(Buffer.from('consumer')) };
  const shipped = { ...release, CONSUMER: consumer };

  const asked = [];
  const offer = { version: 'SF 26.1003.2350', tag: 'renodx-dlss-SF-26.1003.2350',
    asset: { name: 'renodx-dlss_SF_26.1003.2350.zip', url: `${RHI}renodx-dlss-SF-26.1003.2350/renodx-dlss_SF_26.1003.2350.zip`, size: newZip.length, sha256: sha(newZip) } };
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === offer.asset.url) return new Response(newZip, { status: 200 });
    if (url === `${RHI}m/m.zip`) return new Response(shippedZip, { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  const said = [];
  const result = await updates.updateAddon('multipass', { userData, release: shipped, offer, fetchImpl, log: (code) => said.push(code) });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.previous, 'SF 26.0928.0205');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'feeder/host64/renodx-dlss.addon64'))), sha(newDll));
  assert.deepEqual(asked, [offer.asset.url], 'the zip is downloaded once and reused for the payload');
  assert.deepEqual(said, ['addonDownloading', 'addonVerified', 'addonReady']);
  const pins = updates.readOverrides(userData);
  assert.equal(pins.multipass.sha256, sha(newDll));
  assert.equal(pins.multipass.archive[2], sha(newZip));
  assert.equal(updates.effectiveRelease(userData, shipped).origin.multipass, 'updated');
  assert.ok(linuxPayload.ready(userData, undefined, updates.components(userData, shipped)), 'the payload matches the pins it now has');
  const marker = JSON.parse(fs.readFileSync(path.join(dir, linuxPayload.MARKER), 'utf8'));
  assert.equal(marker.components['renodx-dlss.addon64'].version, 'SF 26.1003.2350');
  assert.ok(!fs.existsSync(path.join(userData, 'addon-update')), 'scratch space is cleaned up');

  // Asking again is a no-op: it is already the newest.
  assert.equal((await updates.updateAddon('multipass', { userData, release: shipped, offer, fetchImpl })).upToDate, true);
  assert.equal(asked.length, 1);

  const reverted = await updates.revertAddon('multipass', { userData, release: shipped, fetchImpl, log: (code) => said.push(code) });
  assert.equal(reverted.version, 'SF 26.0928.0205');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'feeder/host64/renodx-dlss.addon64'))), sha(shippedDll));
  assert.deepEqual(updates.readOverrides(userData), {});
  assert.deepEqual(said.slice(3), ['componentDownloading', 'componentReady', 'addonReverted'], 'the shipped build is fetched again, by its pin');
  assert.ok(linuxPayload.ready(userData, undefined, updates.components(userData, shipped)));
});

test('a download that is not what GitHub published, or not an add-on, changes nothing', async (t) => {
  const userData = tmp(t, 'refuse');
  const dir = payloadOnDisk(userData);
  const textZip = zipOf(t, userData, 'renodx-dlss.addon64', Buffer.alloc(8192, 'x'));
  if (!textZip) return t.skip('no 7-Zip available on this machine');
  const release = builtIn();
  const asset = { name: 'renodx-dlss_SF_26.1003.2350.zip', url: `${RHI}t/renodx-dlss_SF_26.1003.2350.zip`, size: textZip.length };
  const fetchImpl = async () => new Response(textZip, { status: 200 });

  await assert.rejects(updates.updateAddon('multipass', { userData, release, fetchImpl,
    offer: { version: 'SF 26.1003.2350', tag: 't', asset: { ...asset, sha256: 'f'.repeat(64) } } }), /SHA-256 mismatch/);
  await assert.rejects(updates.updateAddon('multipass', { userData, release, fetchImpl,
    offer: { version: 'SF 26.1003.2350', tag: 't', asset: { ...asset, sha256: sha(textZip) } } }), /MZ/);
  assert.equal(fs.readFileSync(path.join(dir, 'feeder/host64/renodx-dlss.addon64'), 'utf8'), 'shipped multipass');
  assert.deepEqual(updates.readOverrides(userData), {});
  assert.ok(!fs.existsSync(path.join(userData, 'addon-update')));
});

// ---------------------------------------------------------------- the app

const FORK = 'Nicholasvoador/DLSS5-Swapper-Linux-Support';
const DL = `https://github.com/${FORK}/releases/download/`;
function forkRelease(tag, digests = {}) {
  const names = [`DLSS5-Swapper-Linux-${tag.slice(1)}-x86_64.AppImage`, `DLSS5-Swapper-Linux-${tag.slice(1)}-x86_64.rpm`, `DLSS5-Swapper-Linux-${tag.slice(1)}-amd64.deb`, 'SHA256SUMS.txt'];
  return { tag_name: tag, html_url: `https://github.com/${FORK}/releases/tag/${tag}`,
    assets: names.map((name, i) => ({ name, size: 100 + i, browser_download_url: `${DL}${tag}/${name}`, digest: digests[name] === undefined ? `sha256:${String(i + 1).repeat(64)}` : digests[name] })) };
}

test('the newest fork release is found by the fork\'s own ordering', async () => {
  const rows = [forkRelease('v2.2.9-linux.2'), forkRelease('v2.2.9-linux.10'), { ...forkRelease('v2.2.9-linux.11'), prerelease: true }, { ...forkRelease('v2.2.9-linux.12'), draft: true }, forkRelease('v2.2.9-linux.3')];
  const answer = await updates.latestApp({ repo: FORK, current: '2.2.9-linux.2', fetchImpl: async () => json(rows) });
  assert.equal(answer.latest, '2.2.9-linux.10');
  assert.equal(answer.newer, true);
  assert.equal(answer.assets.length, 4);
  const same = await updates.latestApp({ repo: FORK, current: '2.2.9-linux.10', fetchImpl: async () => json(rows) });
  assert.equal(same.newer, false);
});

test('the package must match both GitHub and SHA256SUMS.txt, and one of them must exist', async () => {
  const release = await updates.latestApp({ repo: FORK, current: '2.2.9-linux.1', fetchImpl: async () => json([forkRelease('v2.2.9-linux.2')]) });
  const sums = (text) => async () => new Response(text, { status: 200 });
  const good = `${'2'.repeat(64)}  DLSS5-Swapper-Linux-2.2.9-linux.2-x86_64.rpm\n${'1'.repeat(64)}  DLSS5-Swapper-Linux-2.2.9-linux.2-x86_64.AppImage\n`;
  const rpm = await updates.appDownload(release, 'rpm', { fetchImpl: sums(good) });
  assert.equal(rpm.name, 'DLSS5-Swapper-Linux-2.2.9-linux.2-x86_64.rpm');
  assert.deepEqual(rpm.checkedBy, ['GitHub', 'SHA256SUMS.txt']);
  assert.equal((await updates.appDownload(release, 'appimage', { fetchImpl: sums(good) })).sha256, '1'.repeat(64));
  await assert.rejects(updates.appDownload(release, 'rpm', { fetchImpl: sums(good.replace('2'.repeat(64), '9'.repeat(64))) }), /disagree/);
  await assert.rejects(updates.appDownload(release, 'unmanaged', { fetchImpl: sums(good) }), /cannot update itself/);

  const bare = await updates.latestApp({ repo: FORK, current: '2.2.9-linux.1',
    fetchImpl: async () => json([{ ...forkRelease('v2.2.9-linux.2', { 'DLSS5-Swapper-Linux-2.2.9-linux.2-amd64.deb': null }), assets: forkRelease('v2.2.9-linux.2', { 'DLSS5-Swapper-Linux-2.2.9-linux.2-amd64.deb': null }).assets.filter((a) => a.name !== 'SHA256SUMS.txt') }]) });
  await assert.rejects(updates.appDownload(bare, 'deb', { fetchImpl: sums('') }), /no published SHA-256/);
});

test('how the app was installed decides how it is replaced', async () => {
  const runner = (answers) => async (file) => { if (answers[file] instanceof Error) throw answers[file]; return answers[file] || ''; };
  assert.deepEqual(await updates.installKind({ env: { APPIMAGE: '/home/u/Apps/DLSS5.AppImage' } }), { kind: 'appimage', target: '/home/u/Apps/DLSS5.AppImage' });
  assert.deepEqual(await updates.installKind({ env: {}, execPath: '/opt/x', runner: runner({ rpm: 'dlss5-swapper' }) }), { kind: 'rpm', package: 'dlss5-swapper' });
  assert.deepEqual(await updates.installKind({ env: {}, execPath: '/opt/x', runner: runner({ rpm: new Error('no'), 'dpkg-query': 'dlss5-swapper: /opt/x\n' }) }), { kind: 'deb', package: 'dlss5-swapper' });
  assert.deepEqual(await updates.installKind({ env: {}, execPath: '/usr/bin/x', runner: runner({ rpm: 'some-distro-build' }) }), { kind: 'unmanaged', package: 'some-distro-build' });
  assert.deepEqual(await updates.installKind({ env: {}, execPath: '/src/x', runner: runner({ rpm: 'file /src/x is not owned by any package', 'dpkg-query': new Error('no') }) }), { kind: 'unmanaged' });
});

test('an AppImage replaces itself whole, or says why it cannot', async (t) => {
  const dir = tmp(t, 'appimage');
  const target = path.join(dir, 'DLSS5.AppImage');
  const update = path.join(dir, 'new.AppImage');
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(update, 'new build');
  const result = await updates.installApp('appimage', update, { target });
  assert.deepEqual(result, { ok: true, kind: 'appimage', relaunch: target });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new build');
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['DLSS5.AppImage', 'new.AppImage'], 'no temporary file left behind');

  if (process.getuid && process.getuid() === 0) return; // root writes anywhere
  fs.chmodSync(dir, 0o555);
  await assert.rejects(updates.installApp('appimage', update, { target }), (error) => error.code === 'appimageNotWritable');
  fs.chmodSync(dir, 0o755);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new build');
});

test('rpm and deb packages go through the system package manager under pkexec', async () => {
  const calls = [];
  const runner = async (file, args) => { calls.push([file, ...args]); return ''; };
  await updates.installApp('rpm', '/u/app.rpm', { runner, exists: (file) => file === '/usr/bin/dnf' });
  await updates.installApp('rpm', '/u/app.rpm', { runner, exists: () => false });
  await updates.installApp('deb', '/u/app.deb', { runner });
  assert.deepEqual(calls, [
    ['/usr/bin/pkexec', '/usr/bin/dnf', 'install', '-y', '/u/app.rpm'],
    ['/usr/bin/pkexec', '/usr/bin/rpm', '-U', '/u/app.rpm'],
    ['/usr/bin/pkexec', '/usr/bin/apt-get', 'install', '-y', '/u/app.deb']
  ]);
  const dismissed = async () => { throw Object.assign(new Error('Not authorized'), { code: 126 }); };
  await assert.rejects(updates.installApp('rpm', '/u/app.rpm', { runner: dismissed, exists: () => true }), (error) => error.code === 'authCancelled');
  const broken = async () => { throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'Error: conflicting requests' }); };
  await assert.rejects(updates.installApp('rpm', '/u/app.rpm', { runner: broken, exists: () => true }), /conflicting requests/);
});

// ---------------------------------------------------------------- main.js

test('the new version starts only after the old one has exited', async (t) => {
  const { spawn } = require('node:child_process');
  const dir = tmp(t, 'relaunch');
  const marker = path.join(dir, 'started');
  const old = spawn('/bin/sleep', ['1.2'], { stdio: 'ignore' });
  const startedAt = Date.now();
  let exitedAt = 0;
  old.on('exit', () => { exitedAt = Date.now(); });
  const spec = updates.relaunchSpec({ execPath: '/bin/sh', args: ['-c', `date +%s%N > "${marker}"`], pid: old.pid });
  assert.match(spec.file, /^\/bin\/(ba)?sh$/);
  const waiter = spawn(spec.file, spec.args, { stdio: 'ignore' });
  await new Promise((resolve) => waiter.on('exit', resolve));
  assert.ok(exitedAt > 0, 'the old process exited first');
  assert.ok(fs.existsSync(marker), 'then the new one ran');
  const ranAt = Number(fs.readFileSync(marker, 'utf8')) / 1e6;
  assert.ok(ranAt >= exitedAt - 50, 'not before the old process was gone');
  assert.ok(Date.now() - startedAt < 5000);
  // Arguments with spaces and quotes reach the new process untouched.
  const echo = path.join(dir, 'args');
  const spec2 = updates.relaunchSpec({ execPath: '/bin/sh', args: ['-c', `printf '%s|' "$@" > "${echo}"`, 'x', 'with space', `it's`], pid: 999999999 });
  await new Promise((resolve) => spawn(spec2.file, spec2.args, { stdio: 'ignore' }).on('exit', resolve));
  assert.equal(fs.readFileSync(echo, 'utf8'), `with space|it's|`);
  // Nothing of the old process reaches the new one but stdin, stdout, stderr:
  // here a pipe on descriptor 3 and another on 12 stand in for the AppImage
  // keep-alive pipe and the old instance's sockets.
  const fds = path.join(dir, 'fds');
  const spec3 = updates.relaunchSpec({ execPath: '/bin/sh', args: ['-c', `ls /proc/$$/fd > "${fds}"`], pid: 999999999 });
  const stdio = ['ignore', 'ignore', 'ignore', 'pipe', ...Array(8).fill('ignore'), 'pipe'];
  await new Promise((resolve) => spawn(spec3.file, spec3.args, { stdio }).on('exit', resolve));
  assert.deepEqual(fs.readFileSync(fds, 'utf8').split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b), [0, 1, 2]);
});

function loadMain(t, { version, fetchImpl, prepare = () => {} }) {
  const root = tmp(t, 'main');
  prepare(root);
  const main = path.resolve(__dirname, '../main.js');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const opened = [];
  const stubs = {
    electron: {
      app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => root, getVersion: () => version },
      BrowserWindow: { fromWebContents: () => null },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      shell: { openExternal: async (url) => { opened.push(url); } },
      clipboard: { writeText() {} }
    },
    './src/core/scan.js': { scanGame: async () => ({ chosen: null, exeCandidates: [] }), scanSource: () => ({ ok: false }) },
    './src/core/host-platform': { platform: 'linux' }
  };
  const context = vm.createContext({
    require: (name) => stubs[name] || realRequire(name),
    __dirname: path.dirname(main), process, Buffer, console, setTimeout, clearTimeout, AbortSignal, URL, fetch: fetchImpl
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  return { handlers, opened };
}

test('the sidebar announces the next fork release, which it used to read as the same version', async (t) => {
  for (const [tag, newer] of [['v2.2.9-linux.3', true], ['v2.2.9-linux.2', false], ['v2.2.9-linux.1', false], ['v2.2.10', true]]) {
    const { handlers } = loadMain(t, { version: '2.2.9-linux.2', fetchImpl: async () => json([{ tag_name: tag }]) });
    const answer = await handlers.get('update-check')();
    assert.equal(answer.newer, newer, tag);
  }
});

test('a cached add-on check is measured against what this build ships, not what the last one did', async (t) => {
  const shippedMultipass = require('../src/core/renodx-release').MULTIPASS.version;
  const { handlers } = loadMain(t, {
    version: '2.2.9-linux.3',
    fetchImpl: async () => { throw new Error('a fresh cache is not asked again'); },
    // Written by the previous version an hour ago: it shipped an older multipass
    // and was itself built on an older upstream.
    prepare: (root) => fs.writeFileSync(path.join(root, 'component-check.json'), JSON.stringify({
      checkedAt: new Date(Date.now() - 3600e3).toISOString(),
      answered: true,
      base: { repo: 'rakanki911/DLSS5-Swapper', current: '2.2.8', latest: 'v2.2.9', newer: true, url: 'x' },
      components: [
        { key: 'multipass', label: 'RenoDX multipass (SF)', current: 'SF 26.0928.0205', latest: '26.1003.2350', newer: true },
        { key: 'feeder', label: 'DLSS5-Feeder', current: '1.16.0', latest: 'v1.17.0', newer: true }
      ]
    }))
  });
  const answer = await handlers.get('component-check')();
  const multipass = answer.components.find((row) => row.key === 'multipass');
  assert.equal(multipass.current, shippedMultipass);
  assert.equal(multipass.newer, false, 'this build already ships it');
  assert.equal(answer.components.find((row) => row.key === 'feeder').newer, false);
  assert.equal(answer.base.current, '2.2.9');
  assert.equal(answer.base.newer, false);
});

test('the Updates panel opens release pages on GitHub for the projects it knows, and nothing else', async (t) => {
  const { handlers, opened } = loadMain(t, { version: '2.2.9-linux.2', fetchImpl: async () => json([]) });
  const open = handlers.get('updates-open');
  for (const url of [`https://github.com/${FORK}/releases`, 'https://github.com/RankFTW/rhi-repo/releases/tag/renodx-dlss-SF-26.1003.2350',
    'https://github.com/rakanki911/DLSS5-Swapper/releases', 'https://github.com/jlrouzies-fr/DLSS5-Feeder/releases']) {
    assert.equal(await open(null, url), true, url);
  }
  for (const url of ['https://evil.example/releases', 'http://github.com/RankFTW/rhi-repo/releases', 'https://github.com/someone/else/releases',
    'https://github.com/RankFTW/rhi-repo/settings', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    assert.equal(await open(null, url), false, url);
  }
  assert.equal(opened.length, 4);
});

test('the add-on and app update handlers refuse what they do not know', async (t) => {
  const { handlers } = loadMain(t, { version: '2.2.9-linux.2', fetchImpl: async () => json([]) });
  for (const key of ['feeder', '__proto__', 'constructor', '', null]) {
    const answer = await handlers.get('updates-addon')({ sender: { send() {} } }, key);
    assert.equal(answer.ok, false, String(key));
    assert.equal((await handlers.get('updates-addon-revert')({ sender: { send() {} } }, key)).ok, false, String(key));
  }
  // No newer fork release: nothing is downloaded or installed.
  const answer = await handlers.get('updates-app')({ sender: { send() {} } });
  assert.equal(answer.ok, true);
  assert.equal(answer.upToDate, true);
});

test('when the panel learns the newest release, the sidebar line says the same', async (t) => {
  let fail = true;
  const { handlers } = loadMain(t, {
    version: '2.2.9-linux.2',
    fetchImpl: async (url) => {
      if (fail) return new Response('rate limited', { status: 403 });
      if (/DLSS5-Swapper-Linux-Support\/releases/.test(url)) return json([forkRelease('v2.2.9-linux.3')]);
      return json([]);
    }
  });
  assert.equal((await handlers.get('update-check')()).latest, null, 'the launch check was refused');
  fail = false;
  const status = await handlers.get('updates-status')();
  assert.equal(status.app.latest, '2.2.9-linux.3');
  const sidebar = await handlers.get('update-check')();
  assert.equal(sidebar.latest, '2.2.9-linux.3');
  assert.equal(sidebar.newer, true);
});

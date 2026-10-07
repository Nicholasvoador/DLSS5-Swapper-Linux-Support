'use strict';
// Linux fork: RenoDX in games already set up, brought up to the build the app
// has now - and everything that must be left alone while doing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const refresh = require('../src/core/addon-refresh');
const renodx = require('../src/core/renodx-release');
const { restoreFiles } = require('../src/core/apply');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dlss5-refresh-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every RenoDX build a release ships is one a later release recognises', () => {
  assert.equal(refresh.SHIPPED[refresh.CONSUMER][renodx.CONSUMER.sha256], renodx.CONSUMER.version);
  assert.equal(refresh.SHIPPED[refresh.MULTIPASS][renodx.MULTIPASS.sha256], renodx.MULTIPASS.version);
  for (const sha256 of Object.keys(renodx.FAULTING)) assert.ok(refresh.SHIPPED[refresh.CONSUMER][sha256], 'the faulting 4.x builds are replaced first of all');
  for (const name of [refresh.CONSUMER, refresh.MULTIPASS]) {
    for (const key of Object.keys(refresh.SHIPPED[name])) assert.match(key, /^[0-9a-f]{64}$/);
  }
});

// A game folder as an install leaves it: the original in the backup, the app's
// copy in place, and a manifest that says which is which.
function game(t, { files, added = [], replaced = [], originals = {} }) {
  const dir = tmp(t, 'game');
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ game');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  // The same layout an install writes: originals/<install id>/<rel>.
  const backup = path.join(dir, '_DLSS5_Backup');
  const prefix = 'originals/' + crypto.randomUUID();
  fs.mkdirSync(path.join(backup, prefix), { recursive: true });
  for (const [rel, content] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(backup, prefix, rel)), { recursive: true });
    fs.writeFileSync(path.join(backup, prefix, rel), content);
  }
  const manifest = { version: 1, date: new Date().toISOString(), game: { dir, exe: 'Game.exe' }, route: 'native', added, replaced, addedDirs: [], backupPrefix: prefix };
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

function setup(t) {
  const app = tmp(t, 'app');
  const consumerNew = Buffer.from('RenoDX consumer, the build the app has now');
  const multipassNew = Buffer.from('RenoDX multipass, the build the app has now');
  fs.writeFileSync(path.join(app, 'consumer.addon64'), consumerNew);
  fs.writeFileSync(path.join(app, 'multipass.addon64'), multipassNew);
  const targets = {
    [refresh.CONSUMER]: { sha256: sha(consumerNew), version: '9.0.0', source: path.join(app, 'consumer.addon64') },
    [refresh.MULTIPASS]: { sha256: sha(multipassNew), version: 'SF 27.0101.0000', source: path.join(app, 'multipass.addon64') }
  };
  const oldConsumer = Buffer.from('RenoDX consumer 8.5.0-rc10 as shipped');
  const oldMultipass = Buffer.from('RenoDX multipass SF 26.1003.2350 as shipped');
  const known = {
    [refresh.CONSUMER]: { [sha(oldConsumer)]: '8.5.0-rc10' },
    [refresh.MULTIPASS]: { [sha(oldMultipass)]: 'SF 26.1003.2350' }
  };
  return { app, targets, known, oldConsumer, oldMultipass, consumerNew, multipassNew };
}

test('each RenoDX copy in a game is read as current, older, chosen or somebody else\'s', (t) => {
  const { targets, known, oldConsumer, oldMultipass, consumerNew } = setup(t);
  const older = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer, 'bin/renodx-dlss.addon64': oldMultipass }, added: ['renodx-dlss5.addon64', 'bin/renodx-dlss.addon64'] });
  const read = refresh.inspectGame(older.dir, targets, known);
  assert.equal(read.exe, 'Game.exe');
  assert.deepEqual(read.files.map((f) => [f.rel, f.state, f.version, f.latest]), [
    ['renodx-dlss5.addon64', 'older', '8.5.0-rc10', '9.0.0'],
    ['bin/renodx-dlss.addon64', 'older', 'SF 26.1003.2350', 'SF 27.0101.0000']
  ]);

  const current = game(t, { files: { 'renodx-dlss5.addon64': consumerNew }, added: ['renodx-dlss5.addon64'] });
  assert.equal(refresh.inspectGame(current.dir, targets, known).files[0].state, 'current');

  const custom = game(t, { files: { 'renodx-dlss5.addon64': 'a build somebody compiled' }, replaced: [{ rel: 'renodx-dlss5.addon64', kind: 'addon' }] });
  assert.equal(refresh.inspectGame(custom.dir, targets, known).files[0].state, 'custom');

  const chosen = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['renodx-dlss5.addon64'] });
  assert.equal(refresh.inspectGame(chosen.dir, targets, known, new Set([sha(oldConsumer)])).files[0].state, 'chosen', 'picked on the Add-ons page');
});

test('a game holding a newer build than the app (after a revert) is never taken backwards', async (t) => {
  const { targets, known } = setup(t);
  const newer = Buffer.from('RenoDX consumer 9.1.0, accepted earlier and since reverted in the app');
  known[refresh.CONSUMER][sha(newer)] = '9.1.0';
  const g = game(t, { files: { 'renodx-dlss5.addon64': newer }, added: ['renodx-dlss5.addon64'] });
  const read = refresh.inspectGame(g.dir, targets, known);
  assert.equal(read.files[0].state, 'newer');
  assert.deepEqual((await refresh.refreshGame(read, targets)).updated, []);
  assert.equal(sha(fs.readFileSync(path.join(g.dir, 'renodx-dlss5.addon64'))), sha(newer));
});

test('a manifest that points outside the game, or a switch half done, is not followed', (t) => {
  const { targets, known, oldConsumer } = setup(t);
  const escape = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['../renodx-dlss5.addon64', '/etc/renodx-dlss5.addon64'] });
  assert.equal(refresh.inspectGame(escape.dir, targets, known), null);
  const pending = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['renodx-dlss5.addon64'] });
  fs.writeFileSync(path.join(pending.dir, '_DLSS5_Backup', 'pending-switch.json'), '{}');
  assert.equal(refresh.inspectGame(pending.dir, targets, known), null);
  assert.equal(refresh.inspectGame(tmp(t, 'nothing'), targets, known), null, 'no install, nothing to say');
});

test('older builds are replaced, everything else is left exactly as it was, and Restore still restores', async (t) => {
  const { targets, known, oldConsumer, oldMultipass, consumerNew, multipassNew } = setup(t);
  const original = Buffer.from('the game\'s own RenoDX, from before any install');
  const g = game(t, {
    files: { 'renodx-dlss5.addon64': oldConsumer, 'renodx-dlss.addon64': oldMultipass, 'mods/renodx-dlss5.addon64': 'somebody else\'s' },
    replaced: [{ rel: 'renodx-dlss5.addon64', kind: 'addon', oldVersion: null }],
    added: ['renodx-dlss.addon64', 'mods/renodx-dlss5.addon64'],
    originals: { 'renodx-dlss5.addon64': original }
  });
  const read = refresh.inspectGame(g.dir, targets, known);
  const closedChecks = [];
  const done = await refresh.refreshGame(read, targets, { assertClosed: async (dir, exe) => closedChecks.push([dir, exe]) });
  assert.deepEqual(closedChecks, [[g.dir, path.join(g.dir, 'Game.exe')]]);
  assert.deepEqual(done.updated.map((u) => [u.rel, u.from, u.to]).sort(), [
    ['renodx-dlss.addon64', 'SF 26.1003.2350', 'SF 27.0101.0000'],
    ['renodx-dlss5.addon64', '8.5.0-rc10', '9.0.0']
  ]);
  assert.equal(sha(fs.readFileSync(path.join(g.dir, 'renodx-dlss5.addon64'))), sha(consumerNew));
  assert.equal(sha(fs.readFileSync(path.join(g.dir, 'renodx-dlss.addon64'))), sha(multipassNew));
  assert.equal(fs.readFileSync(path.join(g.dir, 'mods/renodx-dlss5.addon64'), 'utf8'), 'somebody else\'s');
  assert.deepEqual(fs.readdirSync(g.dir).filter((name) => name.includes('dlss5-update')), [], 'no temporary file left');
  assert.equal(refresh.inspectGame(g.dir, targets, known).files.filter((f) => f.state === 'older').length, 0);

  // Restore after the update: the original comes back, the added file goes.
  await restoreFiles(g.dir, g.manifest, () => {});
  assert.equal(fs.readFileSync(path.join(g.dir, 'renodx-dlss5.addon64'), 'utf8'), original.toString());
  assert.equal(fs.existsSync(path.join(g.dir, 'renodx-dlss.addon64')), false);
});

test('a running game, a file changed meanwhile, or a damaged source changes nothing', async (t) => {
  const { targets, known, oldConsumer } = setup(t);
  const running = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['renodx-dlss5.addon64'] });
  const read = refresh.inspectGame(running.dir, targets, known);
  await assert.rejects(refresh.refreshGame(read, targets, { assertClosed: async () => { throw Object.assign(new Error('Close the game first'), { code: 'errGameRunning' }); } }), /Close the game/);
  assert.equal(sha(fs.readFileSync(path.join(running.dir, 'renodx-dlss5.addon64'))), sha(oldConsumer));

  const changed = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['renodx-dlss5.addon64'] });
  const before = refresh.inspectGame(changed.dir, targets, known);
  fs.writeFileSync(path.join(changed.dir, 'renodx-dlss5.addon64'), 'replaced by hand after the panel looked');
  assert.deepEqual((await refresh.refreshGame(before, targets)).updated, []);
  assert.equal(fs.readFileSync(path.join(changed.dir, 'renodx-dlss5.addon64'), 'utf8'), 'replaced by hand after the panel looked');

  const damaged = game(t, { files: { 'renodx-dlss5.addon64': oldConsumer }, added: ['renodx-dlss5.addon64'] });
  const read2 = refresh.inspectGame(damaged.dir, targets, known);
  fs.writeFileSync(targets[refresh.CONSUMER].source, 'not the build the pin names');
  await assert.rejects(refresh.refreshGame(read2, targets), /nothing was changed/);
  assert.equal(sha(fs.readFileSync(path.join(damaged.dir, 'renodx-dlss5.addon64'))), sha(oldConsumer));
  assert.deepEqual(fs.readdirSync(damaged.dir).filter((name) => name.includes('dlss5-update')), []);
});

test('a build accepted from the Updates panel is recognised in games later', (t) => {
  const userData = tmp(t, 'ledger');
  const sha256 = 'a'.repeat(64);
  assert.equal(refresh.knownBuilds(userData)[refresh.CONSUMER][sha256], undefined);
  refresh.rememberBuild(userData, refresh.CONSUMER, sha256, '8.6.0-rc1');
  refresh.rememberBuild(userData, 'something-else.addon64', 'b'.repeat(64), 'x');
  refresh.rememberBuild(userData, refresh.MULTIPASS, 'not-a-sha', 'x');
  const known = refresh.knownBuilds(userData);
  assert.equal(known[refresh.CONSUMER][sha256], '8.6.0-rc1');
  assert.equal(known[refresh.CONSUMER][renodx.CONSUMER.sha256], renodx.CONSUMER.version, 'the shipped list is always there');
  assert.equal(Object.keys(known).length, 2);
});

// ---------------------------------------------------------------- finding new builds

test('the newest RenoDX is found even when other projects\' releases fill the first page', async () => {
  const updates = require('../src/core/updates');
  const filler = (n, from) => Array.from({ length: n }, (_, i) => ({ tag_name: `dlssg-310.${from + i}`, assets: [] }));
  const release = (tag, file) => ({
    tag_name: tag, prerelease: false, draft: false,
    assets: [{ name: file, browser_download_url: `https://github.com/RankFTW/rhi-repo/releases/download/${tag}/${file}`, digest: 'sha256:' + 'c'.repeat(64), size: 1 }]
  });
  const pages = {
    1: [...filler(99, 0), release('renodx-dlss-SF-27.0101.0000', 'renodx-dlss_SF_27.0101.0000.zip')],
    2: [...filler(60, 100), release('renodx-dlss5-9.0.0-rc1', 'renodx-dlss5_9.0.0-rc1.zip'), release('renodx-dlss5-8.5.0-rc10', 'renodx-dlss5_8.5.0-rc10.zip')]
  };
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const latest = await updates.latestAddons({ fetchImpl });
  assert.equal(latest.renodx.version, '9.0.0-rc1');
  assert.equal(latest.multipass.version, 'SF 27.0101.0000');
  assert.deepEqual(asked.map((url) => new URL(url).searchParams.get('page')), ['1', '2'], 'a second page only because RenoDX DLSS 5 was not on the first');
});

test('the sidebar\'s check reads a full page of releases too', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/core/version-check.js'), 'utf8');
  assert.match(source, /releases\?per_page=100/);
  assert.doesNotMatch(source, /per_page=30/);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /componentAnswer && age >= 0 && age <= ttl/, 'an answer held in memory expires');
});

test('GitHub\'s hourly limit is said as such, with when it resets', async () => {
  const updates = require('../src/core/updates');
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
  });
  const latest = await updates.latestAddons({ fetchImpl });
  assert.match(latest.renodx.error, /limit of update checks .* used up for the hour; it resets at /);
  assert.match(latest.renodx.error, /Nothing is wrong with the app/);
  // Any other refusal is still reported as the number it is.
  const forbidden = async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '41' } });
  assert.equal((await updates.latestAddons({ fetchImpl: forbidden })).renodx.error, 'GitHub answered 403');
});

'use strict';
// Linux fork: the community tabs while the community server is slow, failing or
// out of reach - and what they say about it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const { CommunityClient, TIMEOUT_MS, SERVER_TROUBLE } = require('../src/community-client');
const { LastGood, withLastGood, viewKey, STALE_CODES } = require('../src/community-last-good');

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dlss5-community-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const client = (t, fetchImpl) => new CommunityClient({ file: path.join(tmp(t, 'client'), 'community.json'), baseUrl: 'https://example.test', fetchImpl });

// ---------------------------------------------------------------- what the client says

test('the client waits past Cloudflare\'s own 30 seconds before giving up', () => {
  assert.ok(TIMEOUT_MS > 30_000, 'a 502 from Cloudflare arrives at about 30 s and must be heard');
  assert.ok(TIMEOUT_MS <= 60_000, 'but not long enough to look frozen');
  for (const status of [502, 503, 504, 520, 522, 524]) assert.ok(SERVER_TROUBLE.has(status), String(status));
});

test('a server that does not answer in time is called slow, not the person\'s connection', async (t) => {
  const timedOut = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(client(t, timedOut).gpus(), (error) => {
    assert.equal(error.code, 'community_slow');
    assert.match(error.message, /taking too long/);
    assert.match(error.message, /nothing on this PC needs fixing/);
    assert.doesNotMatch(error.message, /connection/i);
    return true;
  });
});

test('a 502 from Cloudflare is the server having trouble, with its error number', async (t) => {
  const badGateway = async () => new Response('<html><title>502 Bad Gateway</title></html>', { status: 502, headers: { 'content-type': 'text/html' } });
  await assert.rejects(client(t, badGateway).cardsPage({}), (error) => {
    assert.equal(error.code, 'community_down');
    assert.equal(error.status, 502);
    assert.match(error.message, /having trouble right now \(error 502\)/);
    return true;
  });
});

test('the service\'s own refusal is still reported as the service wrote it', async (t) => {
  const refused = async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'Slow down.' }), { status: 503, headers: { 'content-type': 'application/json' } });
  await assert.rejects(client(t, refused).gpus(), (error) => error.code === 'rate_limited' && error.message === 'Slow down.');
});

test('no route to the server at all is still a connection problem', async (t) => {
  const offline = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), { code: 'ENOTFOUND' }) }); };
  await assert.rejects(client(t, offline).gpus(), (error) => error.code === 'community_offline' && /Check your connection/.test(error.message));
});

// ---------------------------------------------------------------- last good answers

test('a kept answer stands in only when the server is the problem, and says when it is from', async (t) => {
  const dir = tmp(t, 'lastgood');
  let now = 1_000_000;
  const store = new LastGood({ file: path.join(dir, 'kept.json'), now: () => now });
  const ok = await withLastGood(store, 'cards:[]', async () => ({ cards: [{ key: 'steam:1' }], total: 1 }));
  assert.deepEqual(ok, { cards: [{ key: 'steam:1' }], total: 1 });

  now += 60_000;
  for (const code of STALE_CODES) {
    const answer = await withLastGood(store, 'cards:[]', async () => { throw Object.assign(new Error(`server: ${code}`), { code }); });
    assert.deepEqual(answer.cards, [{ key: 'steam:1' }], code);
    assert.equal(answer.stale.at, 1_000_000);
    assert.equal(answer.stale.reason, code);
    assert.equal(answer.stale.message, `server: ${code}`);
  }
  // A refusal from the service, or nothing kept for this view: the error stands.
  await assert.rejects(withLastGood(store, 'cards:[]', async () => { throw Object.assign(new Error('no'), { code: 'not_allowed' }); }), /no/);
  await assert.rejects(withLastGood(store, 'cards:[other]', async () => { throw Object.assign(new Error('slow'), { code: 'community_slow' }); }), /slow/);

  // Kept across restarts; a week later it is too old to show.
  const again = new LastGood({ file: path.join(dir, 'kept.json'), now: () => now });
  assert.ok(again.recall('cards:[]'));
  now += 8 * 24 * 3600e3;
  assert.equal(again.recall('cards:[]'), null);
});

test('only whole answers are kept, a bounded number, and a damaged file is ignored', async (t) => {
  const dir = tmp(t, 'bounded');
  const store = new LastGood({ file: path.join(dir, 'kept.json'), limit: 3 });
  await withLastGood(store, 'chat:latest', async () => ({ notModified: true }), { keep: (answer) => Boolean(answer.feed) });
  assert.equal(store.recall('chat:latest'), null, 'a 304 has nothing to keep');
  for (const key of ['a', 'b', 'c', 'd']) store.remember(key, { key });
  assert.equal(store.recall('a'), null, 'the oldest goes first');
  assert.ok(store.recall('d'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  assert.equal(new LastGood({ file: path.join(dir, 'broken.json') }).recall('a'), null);
});

test('the same view asked twice is one entry, whatever the order or the cache-busting flag', () => {
  assert.equal(viewKey('cards', { route: 'renodx', api: 'dx12', fresh: 1 }), viewKey('cards', { api: 'dx12', route: 'renodx' }));
  assert.notEqual(viewKey('cards', { route: 'renodx' }), viewKey('cards', { route: 'feeder' }));
  assert.equal(viewKey('cards', { gpu: '', sort: null }), viewKey('cards', {}));
  // The first request of a session (before the server lists its filters) and
  // every later one ask for the same default view in different words.
  const first = { q: '', route: 'all', api: 'all', status: 'all' };
  const later = { q: '', route: 'all', api: 'all', status: 'all', gpu: 'all', sort: 'recent', fresh: true };
  assert.equal(viewKey('cards', first), viewKey('cards', later));
  assert.equal(viewKey('cards', later), 'cards:[]');
  assert.notEqual(viewKey('cards', { ...later, sort: 'reports' }), viewKey('cards', first));
  assert.notEqual(viewKey('cards', { ...later, gpu: 'rtx 5070' }), viewKey('cards', first));
});

// ---------------------------------------------------------------- through main.js

function loadMain(t, fetchImpl) {
  const root = tmp(t, 'main');
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify({ communityUsed: true }));
  const main = path.resolve(__dirname, '../main.js');
  const realRequire = createRequire(main);
  const handlers = new Map();
  const stubs = {
    electron: {
      app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => root, getVersion: () => '2.2.9-linux.4' },
      BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      shell: { openExternal: async () => {} },
      clipboard: { writeText() {} }
    },
    './src/core/scan.js': { scanGame: async () => ({ chosen: null, exeCandidates: [] }), scanSource: () => ({ ok: false }) },
    './src/core/host-platform': { platform: 'linux' }
  };
  const context = vm.createContext({
    require: (name) => stubs[name] || realRequire(name),
    __dirname: path.dirname(main), process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal, URL, fetch: fetchImpl
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  return { handlers, root };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Community and Chat show what they last loaded while the server is down, and say so', async (t) => {
  let down = false;
  const { handlers } = loadMain(t, async (url) => {
    if (down) return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (/\/v1\/cards/.test(url)) return json({ cards: [{ key: 'steam:870780', title: 'Control' }], total: 1, features: [] });
    if (/\/v1\/chat\/feed/.test(url)) return json({ messages: [{ id: 5, body: 'hi' }], version: 3 });
    return json({});
  });
  assert.equal(handlers.get('community-cards-kept')(null, { route: 'renodx' }), null, 'nothing saved before the first answer');
  const cards = await handlers.get('community-cards')(null, { route: 'renodx' });
  assert.equal(cards.ok, true);
  assert.equal(cards.stale, undefined);
  // What the page paints at once next time: the same view, read from this PC.
  const saved = handlers.get('community-cards-kept')(null, { route: 'renodx', fresh: true });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.cards.map((c) => c.title), ['Control']);
  assert.equal(typeof saved.savedAt, 'number');
  assert.equal(handlers.get('community-cards-kept')(null, { route: 'feeder' }), null, 'another view has its own answer');
  const feed = await handlers.get('community-chat-feed')(null, { limit: 50 });
  assert.equal(feed.feed.messages.length, 1);

  down = true;
  const kept = await handlers.get('community-cards')(null, { route: 'renodx', fresh: true });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.cards.map((c) => c.title), ['Control']);
  assert.equal(kept.stale.reason, 'community_down');
  assert.match(kept.stale.message, /error 502/);
  const keptFeed = await handlers.get('community-chat-feed')(null, { limit: 50 });
  assert.equal(keptFeed.ok, true);
  assert.equal(keptFeed.feed.messages[0].body, 'hi');
  assert.ok(keptFeed.stale);

  // A view never loaded, and older chat pages, have nothing kept: the error is said as it is.
  const never = await handlers.get('community-cards')(null, { route: 'feeder' });
  assert.equal(never.ok, false);
  assert.equal(never.error, 'community_down');
  const older = await handlers.get('community-chat-feed')(null, { before: 5, limit: 50 });
  assert.equal(older.ok, false);
});

// ---------------------------------------------------------------- the renderer

test('a chat that could not load is not shown as an empty room', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../src/renderer/chat.js'), 'utf8');
  assert.match(chat, /state\.failed && !state\.messages\.length/);
  assert.match(chat, /failedTitle: 'Chat could not load'/);
  assert.match(chat, /if \(state\.loading && !state\.messages\.length\) paintLoading\(\);\s*else \{/, 'a repaint while loading does not show an empty room');
  assert.match(chat, /if \(state\.loading && !state\.messages\.length\) paintLoading\(\);\s*else if \(state\.failed && !state\.messages\.length\) paintMessages\(\);\s*else \$\('chatEmpty'\)\.innerHTML/, 'opening the tab keeps the loading or failed state');
  assert.equal((chat.match(/\$\('chatEmpty'\)\.innerHTML = /g) || []).length, 1, 'one guarded place writes the empty room');
  assert.match(chat, /state\.failed = error\.message;/);
  assert.match(chat, /state\.stale = answer\.stale \|\| null;/);
  assert.match(chat, /if \(answer\.notModified\) \{ if \(state\.failed \|\| state\.stale\) \{ state\.failed = null; state\.stale = null;/, 'a 304 clears the saved-messages line');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /id="chatStatus"/);
  const community = fs.readFileSync(path.join(__dirname, '../src/renderer/community.js'), 'utf8');
  assert.match(community, /if \(response\.stale\)/);
  assert.match(community, /slowLoading/);
});

// The chat's words come in English and Arabic; a key in one and not the other
// renders "undefined" in the other.
test('chat carries the same words in both languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat.js'), 'utf8');
  const start = source.indexOf('const L = {');
  assert.notEqual(start, -1);
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const L = vm.runInNewContext(`(${source.slice(source.indexOf('{', start), end)})`);
  assert.deepEqual(Object.keys(L.ar).sort(), Object.keys(L.en).sort());
  for (const key of ['failedTitle', 'stale', 'unreachable', 'loadingTitle', 'slowTitle', 'slowBody']) assert.ok(L.en[key] && L.ar[key], key);
});

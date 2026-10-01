'use strict';
// Linux fork: the pieces that make the app work on Linux - Proton resolution,
// game-is-running checks, native-game detection, the dlssnr route's launch
// options, and the first-run payload download. Every test runs on fixtures;
// nothing touches the real Steam install or the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const proton = require('../src/core/proton');
const guards = require('../src/core/install-guards');
const dlssnr = require('../src/core/dlssnr');
const linuxPayload = require('../src/core/linux-payload');
const routes = require('../src/shared/install-routes');
const { safePath } = require('../src/core/file-journal');
const { steam, linuxSteamRoots } = require('../src/library');
const { linuxNativeExecutable, scanGame } = require('../src/core/scan');

const tmp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dlss5-linux-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

// ---------- Steam / Proton ----------

test('a game on a second library finds its prefix in that library, not under Steam', (t) => {
  const home = tmp(t, 'lib');
  const root = path.join(home, '.local', 'share', 'Steam');
  const library = path.join(home, 'mnt', 'SteamLibrary');
  write(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n"0" { "path" "${root}" }\n"1" { "path" "${library}" }\n}`);
  write(path.join(library, 'steamapps', 'appmanifest_292030.acf'), '"AppState" { "appid" "292030" "name" "The Witcher 3" "installdir" "The Witcher 3" }');
  fs.mkdirSync(path.join(library, 'steamapps', 'common', 'The Witcher 3'), { recursive: true });
  fs.mkdirSync(path.join(library, 'steamapps', 'compatdata', '292030', 'pfx'), { recursive: true });
  const games = steam({ platform: 'linux', home, env: {} });
  assert.equal(games.length, 1);
  assert.equal(games[0].protonPrefix, path.join(library, 'steamapps', 'compatdata', '292030', 'pfx'));
});

test('~/.steam/steam pointing at the same Steam does not list every game twice', (t) => {
  const home = tmp(t, 'roots');
  const root = path.join(home, '.local', 'share', 'Steam');
  fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true });
  fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
  fs.symlinkSync(root, path.join(home, '.steam', 'steam'));
  assert.deepEqual(linuxSteamRoots(home, {}), [root]);
});

test('the Proton that last ran the prefix wins, custom compatibility tools included', (t) => {
  const home = tmp(t, 'proton');
  const root = path.join(home, 'Steam');
  const tools = path.join(root, 'compatibilitytools.d');
  const ge = write(path.join(tools, 'Proton-GE Latest', 'proton'));
  write(path.join(tools, 'Proton-GE Latest', 'compatibilitytool.vdf'), '"compatibilitytools" { "compat_tools" { "GE-Proton11-7" { "install_path" "." } } }');
  write(path.join(tools, 'Proton-CachyOS', 'proton'));
  write(path.join(root, 'steamapps', 'common', 'Proton 9.0', 'proton'));
  const prefix = path.join(root, 'steamapps', 'compatdata', '1', 'pfx');
  fs.mkdirSync(prefix, { recursive: true });
  write(path.join(path.dirname(prefix), 'config_info'), `GE-Proton11-7\n${path.join(tools, 'Proton-GE Latest')}/files/share/fonts/\n`);
  const found = proton.protonCandidates(root, prefix, { home, env: {} });
  assert.equal(found[0], ge);
  assert.ok(found.includes(path.join(root, 'steamapps', 'common', 'Proton 9.0', 'proton')), 'Valve Proton is still a fallback');
});

test('without config_info the per-game CompatToolMapping, then the global default, decides', (t) => {
  const home = tmp(t, 'mapping');
  const root = path.join(home, 'Steam');
  const tools = path.join(root, 'compatibilitytools.d');
  write(path.join(tools, 'Proton-GE Latest', 'proton'));
  const cachy = write(path.join(tools, 'Proton-CachyOS', 'proton'));
  write(path.join(root, 'config', 'config.vdf'), `"InstallConfigStore" { "Software" { "Valve" { "Steam" { "CompatToolMapping" {
    "0" { "name" "Proton-GE Latest" "config" "" "priority" "75" }
    "42" { "name" "Proton-CachyOS" "config" "" "priority" "250" } } } } } }`);
  const prefix = path.join(root, 'steamapps', 'compatdata', '42', 'pfx');
  fs.mkdirSync(prefix, { recursive: true });
  assert.equal(proton.protonCandidates(root, prefix, { appid: '42', home, env: {} })[0], cachy);
  assert.equal(proton.mappedTool(root, '7'), 'Proton-GE Latest', 'an unmapped game uses the global default');
});

test('the prefix\'s own Windows directory stands in for SystemRoot', () => {
  assert.equal(proton.prefixWindowsDir({ prefix: '/x/pfx' }), path.join('/x/pfx', 'drive_c', 'windows'));
  assert.equal(proton.prefixWindowsDir(null), null);
});

// ---------- running-game check ----------

function fakeProc(t, processes) {
  const root = tmp(t, 'proc');
  processes.forEach(({ pid, argv, exe, comm }) => {
    write(path.join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
    write(path.join(root, String(pid), 'comm'), comm || path.basename(argv[0]));
    if (exe) fs.symlinkSync(exe, path.join(root, String(pid), 'exe'));
  });
  return root;
}

test('a Proton game is found by the Windows path in its command line', async (t) => {
  const game = '/mnt/games/steamapps/common/The Witcher 3';
  const proc = fakeProc(t, [
    { pid: 101, argv: ['Z:\\mnt\\games\\steamapps\\common\\The Witcher 3\\bin\\x64_dx12\\witcher3.exe'], comm: 'witcher3.exe' },
    { pid: 102, argv: ['/usr/bin/kate', `${game}/bin/x64_dx12/ReShade.ini`], comm: 'kate' }
  ]);
  const found = guards.linuxProcessesIn(game, path.join(game, 'bin/x64_dx12/witcher3.exe'), proc);
  assert.deepEqual(found, ['witcher3.exe (101)'], 'an editor with a config file open is not the game');
  await assert.rejects(guards.assertGameClosed(game, null, undefined, undefined, 'linux', proc), { code: 'errGameRunning' });
});

test('Steam\'s proton wrapper and a native game\'s own image count; other games do not', async (t) => {
  const game = '/home/me/Games/Native Game';
  const proc = fakeProc(t, [
    { pid: 201, argv: ['python3', '/steam/Proton/proton', 'waitforexitandrun', '/home/me/Games/Other/other.exe'] },
    { pid: 202, argv: ['./NativeGame'], exe: '/home/me/Games/Native Game/NativeGame', comm: 'NativeGame' }
  ]);
  assert.deepEqual(guards.linuxProcessesIn(game, null, proc), ['NativeGame (202)']);
  const empty = fakeProc(t, [{ pid: 301, argv: ['bash'] }]);
  await guards.assertGameClosed(game, null, undefined, undefined, 'linux', empty);
});

test('a tool that only names the game in its arguments is not the game', async (t) => {
  // Found live: the install was refused because a script had the game's path
  // on its command line. Only a program being run counts.
  const game = '/mnt/games/steamapps/common/The Witcher 3';
  const exe = `${game}/bin/x64_dx12/witcher3.exe`;
  const proc = fakeProc(t, [
    { pid: 401, argv: ['timeout', '300', 'node', 'cdp-job.js', 'install', game, exe], comm: 'timeout' },
    { pid: 402, argv: ['/usr/bin/sha256sum', exe], comm: 'sha256sum' },
    { pid: 403, argv: ['python3', '/steam/compatibilitytools.d/GE/proton', 'waitforexitandrun', exe], comm: 'python3' }
  ]);
  assert.deepEqual(guards.linuxProcessesIn(game, exe, proc), ['python3 (403)'], 'only Proton running it counts');
});

test('nvidia-smi is called by its Linux name on Linux', async () => {
  const called = [];
  const rows = await guards.gpuInfo(async (file) => { called.push(file); return 'NVIDIA GeForce RTX 5070, 615.71.09\n'; }, 'linux');
  assert.deepEqual(called, ['nvidia-smi']);
  assert.deepEqual(rows, [{ name: 'NVIDIA GeForce RTX 5070', driver: '615.71.09' }]);
});

// ---------- manifests written on Windows ----------

test('a backslash path from a Windows manifest cannot escape the game on Linux', (t) => {
  const game = tmp(t, 'journal');
  assert.throws(() => safePath(game, '..\\..\\etc\\evil.ini'), { code: 'errUnsafeTarget' });
  assert.equal(safePath(game, 'bin\\x64\\ReShade.ini'), path.join(game, 'bin', 'x64', 'ReShade.ini'));
});

// ---------- native Linux games ----------

function elf(file, { bitness = 64, strings = '' } = {}) {
  const head = Buffer.alloc(64);
  head.writeUInt32BE(0x7f454c46, 0);
  head[4] = bitness === 64 ? 2 : 1;
  head[5] = 1;
  head.writeUInt16LE(3, 16); // ET_DYN
  return write(file, Buffer.concat([head, Buffer.alloc(16 * 1024), Buffer.from(strings)]));
}

test('a native Vulkan game is offered the DLSS5VKLayer route and nothing else', async (t) => {
  const game = tmp(t, 'native');
  elf(path.join(game, 'Game.x86_64'), { strings: 'libvulkan.so.1\0vkCreateInstance' });
  write(path.join(game, 'launch.sh'), '#!/bin/sh\n');
  const probe = linuxNativeExecutable(path.join(game, 'Game.x86_64'));
  assert.equal(probe.vulkan, true);
  const scan = await scanGame(game, { platform: 'linux' });
  assert.equal(scan.chosen.rel, 'Game.x86_64');
  assert.equal(scan.chosen.api, 'vulkan');
  assert.equal(scan.chosen.linuxNative, true);
  assert.deepEqual(routes.routesFor(scan.chosen), ['dlssnr']);
  assert.equal(routes.recommendedRoute(scan), 'dlssnr');
});

test('a native OpenGL-only game is reported, and offered no route', async (t) => {
  const game = tmp(t, 'native-gl');
  elf(path.join(game, 'gl_game'), { strings: 'libGL.so.1\0glXGetProcAddress' });
  const scan = await scanGame(game, { platform: 'linux' });
  assert.equal(scan.chosen.apiLabel, 'OpenGL');
  assert.deepEqual(routes.routesFor(scan.chosen), []);
});

test('a Windows game that also ships a Linux helper is still the Windows game', async (t) => {
  const game = tmp(t, 'mixed');
  // A Linux crash handler beside a real Windows executable.
  elf(path.join(game, 'crashpad_handler'), { strings: 'libvulkan.so.1' });
  const pe = Buffer.alloc(1024);
  pe.write('MZ', 0);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  pe.writeUInt16LE(0x8664, 0x84);              // x64
  pe.writeUInt16LE(0xf0, 0x94);                // optional header size
  pe.writeUInt16LE(0x20b, 0x98);               // PE32+
  write(path.join(game, 'Game.exe'), Buffer.concat([pe, Buffer.from('d3d12.dll\0D3D12CreateDevice\0dxgi.dll\0')]));
  const scan = await scanGame(game, { platform: 'linux' });
  assert.ok(scan.exeCandidates.length > 0);
  assert.ok(scan.exeCandidates.every((exe) => !exe.linuxNative), 'the ELF is never offered beside a Windows game');
  assert.equal(linuxNativeExecutable(write(path.join(game, 'notelf'), 'just text')), null);
});

test('a Proton Vulkan game gets DLSS5VKLayer beside Feeder on a Linux host only', () => {
  const target = { bitness: 64, api: 'vulkan', apiLabel: 'Vulkan', hasNativeDlss: false };
  assert.ok(!routes.routesFor(target).includes('dlssnr'), 'not on Windows');
  assert.ok(routes.routesFor({ ...target, linuxHost: true }).includes('dlssnr'));
  assert.ok(!routes.routesFor({ ...target, api: 'dxgi', apiLabel: 'DirectX 12', linuxHost: true }).includes('dlssnr'));
});

// ---------- dlssnr: launch options ----------

const WRAP = '/home/me/.local/bin/dlss5-swapper-run';

test('the launcher goes immediately before %command%, and comes off cleanly', () => {
  const cases = [
    ['', `${WRAP} %command%`],
    ['gamemoderun %command%', `gamemoderun ${WRAP} %command%`],
    ['PROTON_LOG=1 %command% -dx12', `PROTON_LOG=1 ${WRAP} %command% -dx12`],
    ['-skipintro', `${WRAP} %command% -skipintro`]
  ];
  for (const [before, after] of cases) {
    assert.equal(dlssnr.withLaunchOption(before, WRAP), after);
    assert.equal(dlssnr.withLaunchOption(after, WRAP), after, 'adding twice changes nothing');
    const removed = dlssnr.withoutLaunchOption(after);
    assert.equal(removed, before === '-skipintro' ? '%command% -skipintro' : before);
  }
  assert.equal(dlssnr.withLaunchOption('', '/home/me/my games/dlss5-swapper-run'), '"/home/me/my games/dlss5-swapper-run" %command%');
  assert.equal(dlssnr.withoutLaunchOption('"/home/me/my games/dlss5-swapper-run" %command%'), '');
});

const LOCALCONFIG = `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"apps"
\t\t\t\t{
\t\t\t\t\t"870780"
\t\t\t\t\t{
\t\t\t\t\t\t"LaunchOptions"\t\t"WINEDLLOVERRIDES=\\"dxgi=n,b\\" %command%"
\t\t\t\t\t}
\t\t\t\t\t"292030"
\t\t\t\t\t{
\t\t\t\t\t\t"Playtime"\t\t"379"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('localconfig.vdf: launch options are read, added to an existing app, and added for a new one', () => {
  assert.equal(dlssnr.readLaunchOptions(LOCALCONFIG, '870780'), 'WINEDLLOVERRIDES="dxgi=n,b" %command%');
  assert.equal(dlssnr.readLaunchOptions(LOCALCONFIG, '292030'), null);
  const one = dlssnr.setLaunchOptions(LOCALCONFIG, '292030', `${WRAP} %command%`);
  assert.equal(dlssnr.readLaunchOptions(one, '292030'), `${WRAP} %command%`);
  assert.equal(dlssnr.readLaunchOptions(one, '870780'), 'WINEDLLOVERRIDES="dxgi=n,b" %command%', 'other games untouched');
  const two = dlssnr.setLaunchOptions(one, '870780', dlssnr.withLaunchOption(dlssnr.readLaunchOptions(one, '870780'), WRAP));
  assert.equal(dlssnr.readLaunchOptions(two, '870780'), `WINEDLLOVERRIDES="dxgi=n,b" ${WRAP} %command%`);
  const three = dlssnr.setLaunchOptions(two, '1', 'x %command%');
  assert.equal(dlssnr.readLaunchOptions(three, '1'), 'x %command%');
  // Still one balanced document.
  let depth = 0, quoted = false;
  for (let i = 0; i < three.length; i++) {
    if (three[i] === '"' && three[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && three[i] === '{') depth++;
    if (!quoted && three[i] === '}') depth--;
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
});

test('launch options are never edited while Steam runs, and are backed up when they are', (t) => {
  const steamRoot = tmp(t, 'steamroot');
  const file = write(path.join(steamRoot, 'userdata', '1234', 'config', 'localconfig.vdf'), LOCALCONFIG);
  const running = fakeProc(t, [{ pid: 5, argv: ['/home/me/.local/share/Steam/ubuntu12_32/steam'], comm: 'steam' }]);
  assert.deepEqual(dlssnr.addLaunchOption(steamRoot, '292030', { wrapper: WRAP, procRoot: running }), { applied: false, reason: 'steamRunning' });
  assert.equal(fs.readFileSync(file, 'utf8'), LOCALCONFIG);
  const idle = fakeProc(t, [{ pid: 6, argv: ['bash'] }]);
  const result = dlssnr.addLaunchOption(steamRoot, '292030', { wrapper: WRAP, procRoot: idle });
  assert.equal(result.applied, true);
  assert.equal(dlssnr.readLaunchOptions(fs.readFileSync(file, 'utf8'), '292030'), `${WRAP} %command%`);
  assert.equal(fs.readFileSync(`${file}.dlss5-swapper.bak`, 'utf8'), LOCALCONFIG);
  dlssnr.removeLaunchOption(steamRoot, '292030', { procRoot: idle });
  assert.equal(dlssnr.readLaunchOptions(fs.readFileSync(file, 'utf8'), '292030'), '');
});

test('the launcher script starts the helper only if needed and keeps the game\'s exit code', () => {
  assert.match(dlssnr.WRAPPER, /^#!\/bin\/sh/);
  assert.match(dlssnr.WRAPPER, /export VKLayer_DLSS5=1/);
  assert.match(dlssnr.WRAPPER, /exit \$code/);
  assert.match(dlssnr.WRAPPER, /if \[ "\$started" = 1 \]/, 'never stops a helper it did not start');
});

test('the pinned DLSS5VKLayer release is the one this build was tested with', () => {
  assert.equal(dlssnr.RELEASE.version, '0.3.1-2');
  assert.match(dlssnr.RELEASE.url, /^https:\/\/github\.com\/bmitch87\/DLSS5VKLayer\/releases\/download\/0\.3\.1-2\//);
  assert.match(dlssnr.RELEASE.sha256, /^[0-9a-f]{64}$/);
});

// ---------- payload download ----------

test('the payload is located inside an NSIS stub, unpacked, and swapped in only when complete', async (t) => {
  const userData = tmp(t, 'payload');
  // A fake upstream package: some stub bytes, then a real 7z archive.
  const stage = tmp(t, 'stage');
  for (const rel of linuxPayload.REQUIRED) write(path.join(stage, 'resources', 'payload', rel), `fixture ${rel}`);
  const tools = linuxPayload.sevenZipCandidates(userData);
  if (!tools.length) return t.skip('no 7-Zip available on this machine');
  const archive = path.join(stage, 'app-64.7z');
  require('node:child_process').execFileSync(tools[0], ['a', '-y', archive, 'resources'], { cwd: stage, stdio: 'ignore' });
  const pkg = path.join(stage, 'pkg.exe');
  fs.writeFileSync(pkg, Buffer.concat([Buffer.from('MZ fake NSIS stub '.repeat(64)), fs.readFileSync(archive), Buffer.from('trailing')]));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex');
  const upstream = { version: 'test', name: 'pkg.exe', url: 'https://invalid.example/pkg.exe', size: fs.statSync(pkg).size, sha256 };

  const located = linuxPayload.locateArchive(pkg);
  assert.equal(located.length, fs.statSync(archive).size, 'the archive is cut out byte for byte');

  const said = [];
  const dir = await linuxPayload.ensurePayload(userData, { upstream, localPackage: pkg, log: (code) => said.push(code) });
  assert.equal(dir, linuxPayload.payloadDir(userData));
  assert.ok(linuxPayload.ready(userData, upstream));
  assert.deepEqual(said, ['payloadVerified', 'payloadReady']);
  assert.ok(!fs.existsSync(path.join(userData, 'payload-download')), 'scratch space is cleaned up');
  // A different pinned release is not "ready", even with the files there.
  assert.equal(linuxPayload.ready(userData, { ...upstream, sha256: '0'.repeat(64) }), false);
});

test('a download that does not match the pinned SHA-256 is thrown away', async (t) => {
  const userData = tmp(t, 'badsha');
  const body = Buffer.from('not the release');
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  const upstream = { version: 'x', name: 'x.exe', url: 'https://invalid.example/x.exe', size: body.length, sha256: 'f'.repeat(64) };
  await assert.rejects(linuxPayload.fetchPayload(userData, { upstream, fetchImpl }), /SHA-256 mismatch/);
  assert.ok(!fs.existsSync(linuxPayload.payloadDir(userData)));
});

test('the pinned upstream payload is DLSS5-Swapper 2.2.9', () => {
  assert.equal(linuxPayload.UPSTREAM.version, '2.2.9');
  assert.match(linuxPayload.UPSTREAM.url, /^https:\/\/github\.com\/rakanki911\/DLSS5-Swapper\/releases\/download\/v2\.2\.9\//);
  assert.equal(linuxPayload.UPSTREAM.sha256, '6b064ecba6e487a87302c1d75c3fd2d8189e78fdf3c91e705eee3d4539ae23c8');
});

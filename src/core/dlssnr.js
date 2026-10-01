'use strict';
// Linux fork: the Vulkan route, through DLSS5VKLayer ("dlssnr",
// https://github.com/bmitch87/DLSS5VKLayer, AGPL-3.0).
//
// ReShade's Vulkan layer is a Windows thing - it registers in HKCU and loads a
// Windows DLL - so a native Linux Vulkan game, or a Proton game rendering with
// Vulkan, cannot be reached that way. dlssnr is the Linux answer: an implicit
// Vulkan layer that hands each presented frame over shared memory to a small
// Windows NGX helper running under Proton/Wine, which runs nvngx_dlssnr.dll
// and hands the frame back. It is used here as an external program, never
// linked or vendored: this module downloads its pinned release, installs it
// per user with its own install.sh, gives it the neural model from the
// payload, and drives its own CLI (dlssnr-helper).
//
// The layer is inert unless the game is started with VKLayer_DLSS5=1, so
// installing it changes nothing about any game until that is set - which is
// what the per-game launch option does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RELEASE = Object.freeze({
  version: '0.3.1-2',
  name: 'dlssnr-0.3.1-2-linux-x86_64.tar.gz',
  url: 'https://github.com/bmitch87/DLSS5VKLayer/releases/download/0.3.1-2/dlssnr-0.3.1-2-linux-x86_64.tar.gz',
  sha256: '43fd001720a3e15704c1bb8ea03c768b406e058c8eb2859ab0ebc8b3cd48f955',
  source: 'https://github.com/bmitch87/DLSS5VKLayer'
});
const LAUNCH_ENV = 'VKLayer_DLSS5=1';

function paths(home = os.homedir(), env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return {
    helper: path.join(home, '.local', 'bin', 'dlssnr-helper'),
    gui: path.join(home, '.local', 'bin', 'dlssnr-gui'),
    lib: path.join(home, '.local', 'lib', 'dlssnr'),
    manifest64: path.join(dataHome, 'vulkan', 'implicit_layer.d', 'VK_LAYER_NV_dlssnr.x86_64.json'),
    manifest32: path.join(dataHome, 'vulkan', 'implicit_layer.d', 'VK_LAYER_NV_dlssnr.i686.json'),
    binaries: path.join(dataHome, 'dlssnr', 'binaries'),
    config: path.join(configHome, 'dlssnr', 'config.ini'),
    log: path.join(stateHome, 'dlssnr', 'helper.log'),
    envFile: path.join(configHome, 'environment.d', 'dlssnr.conf')
  };
}

// What is there now. Any install counts - this app's, the RPM, the user's own.
function status(home, env, which = whichSync) {
  const p = paths(home, env);
  const helper = [p.helper, which('dlssnr-helper')].find((file) => file && fs.existsSync(file)) || null;
  const manifests = [p.manifest64, '/usr/share/vulkan/implicit_layer.d/VK_LAYER_NV_dlssnr.x86_64.json',
    '/etc/vulkan/implicit_layer.d/VK_LAYER_NV_dlssnr.x86_64.json'].filter((file) => fs.existsSync(file));
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(p.lib, '.dlss5-swapper.json'), 'utf8')).version; } catch { /* not ours, or not installed */ }
  return {
    installed: Boolean(helper && manifests.length),
    helper, manifest: manifests[0] || null, ours: Boolean(version), version,
    model: fs.existsSync(path.join(p.binaries, 'nvngx_dlssnr.dll'))
  };
}

function whichSync(name) {
  for (const dir of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options },
    (error, stdout, stderr) => (error
      ? reject(Object.assign(new Error(`${path.basename(file)} ${args[0] || ''}: ${(stderr || stdout || error.message).trim()}`), { stdout, stderr }))
      : resolve(String(stdout || '').trim()))));
}

async function download(release, dest, fetchImpl = fetch) {
  const response = await fetchImpl(release.url, { headers: { 'User-Agent': 'DLSS5-Swapper-Linux' }, signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error(`DLSS5VKLayer download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== release.sha256) throw new Error(`SHA-256 mismatch for ${release.name}: got ${digest}`);
  fs.writeFileSync(dest, bytes);
}

// Install (or update) dlssnr for this user, with its own installer. It writes
// ~/.config/environment.d/dlssnr.conf to pin VK_INSTANCE_LAYERS. That pin
// forces the layer into every Vulkan program's instance (gated by its own env
// switch, but loaded nonetheless) and only matters next to Smooth Motion, so
// it is removed unless the person already had one.
async function install({ userData, log = () => {}, release = RELEASE, fetchImpl, runner = run, home = os.homedir(), env = process.env, localTarball } = {}) {
  const p = paths(home, env);
  const work = fs.mkdtempSync(path.join(userData || os.tmpdir(), 'dlssnr-'));
  const hadEnvFile = fs.existsSync(p.envFile);
  try {
    const tarball = path.join(work, release.name);
    if (localTarball && fs.existsSync(localTarball) &&
        crypto.createHash('sha256').update(fs.readFileSync(localTarball)).digest('hex') === release.sha256) {
      fs.copyFileSync(localTarball, tarball);
    } else {
      log('dlssnrDownloading', { version: release.version });
      await download(release, tarball, fetchImpl);
    }
    await runner('tar', ['-xzf', tarball, '-C', work]);
    const root = fs.readdirSync(work).map((name) => path.join(work, name))
      .find((dir) => fs.existsSync(path.join(dir, 'install.sh')));
    if (!root) throw new Error('the DLSS5VKLayer package has no install.sh');
    await runner('bash', [path.join(root, 'install.sh'), '--user'], { env: { ...env, HOME: home } });
    if (!hadEnvFile) {
      fs.rmSync(p.envFile, { force: true });
      try { fs.rmdirSync(path.dirname(p.envFile)); } catch { /* not empty, or never made */ }
    }
    fs.writeFileSync(path.join(p.lib, '.dlss5-swapper.json'), JSON.stringify({ version: release.version, source: release.url, sha256: release.sha256 }, null, 2));
    log('dlssnrInstalled', { version: release.version });
    return status(home, env);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Hand the neural model (and the Streamline licence texts) to dlssnr.
async function importModel(streamlineDir, { runner = run, home = os.homedir(), env = process.env, log = () => {} } = {}) {
  const helper = status(home, env).helper;
  if (!helper) throw Object.assign(new Error('DLSS5VKLayer is not installed'), { code: 'errDlssnrMissing' });
  if (!fs.existsSync(path.join(streamlineDir, 'nvngx_dlssnr.dll'))) throw Object.assign(new Error('errNoNeuralRuntime'), { code: 'errNoNeuralRuntime' });
  await runner(helper, ['import-binaries', streamlineDir], { env: { ...env, HOME: home } });
  log('dlssnrModelImported', {});
}

async function helperCommand(command, { runner = run, home = os.homedir(), env = process.env } = {}) {
  const helper = status(home, env).helper;
  if (!helper) throw Object.assign(new Error('DLSS5VKLayer is not installed'), { code: 'errDlssnrMissing' });
  return runner(helper, [command], { env: { ...env, HOME: home }, timeout: 240000 });
}

const start = (options) => helperCommand('start', options);
const stop = (options) => helperCommand('stop', options);
async function running(options) {
  try { return /^helper running/m.test(await helperCommand('status', options)); } catch { return false; }
}

// ---------- the launch wrapper ----------
//
// The layer only talks to a running helper, and the helper is a Proton
// process that is not worth keeping alive between games. A tiny wrapper does
// both halves: starts the helper if it is not up, turns the layer on for this
// one game, and stops the helper afterwards if it was the one that started it.
// It goes in front of %command% exactly like gamemoderun or mangohud.
const WRAPPER_NAME = 'dlss5-swapper-run';
const wrapperPath = (home = os.homedir()) => path.join(home, '.local', 'bin', WRAPPER_NAME);
const WRAPPER = `#!/bin/sh
# DLSS 5 Swapper (Linux): run a game with DLSS5VKLayer (dlssnr) enabled.
# Usage, as a Steam launch option:  ${WRAPPER_NAME} %command%
# or directly:                       ${WRAPPER_NAME} /path/to/game
helper="$HOME/.local/bin/dlssnr-helper"
if [ ! -x "$helper" ]; then helper="$(command -v dlssnr-helper 2>/dev/null || true)"; fi
started=0
if [ -n "$helper" ] && [ -x "$helper" ]; then
  if ! "$helper" status 2>/dev/null | grep -q '^helper running'; then
    "$helper" start >/dev/null 2>&1 && started=1
  fi
fi
export VKLayer_DLSS5=1
"$@"
code=$?
if [ "$started" = 1 ] && [ "\${DLSS5_SWAPPER_KEEP_HELPER:-0}" != 1 ]; then
  "$helper" stop >/dev/null 2>&1
fi
exit $code
`;

function ensureWrapper(home = os.homedir()) {
  const file = wrapperPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* first time */ }
  if (current !== WRAPPER) fs.writeFileSync(file, WRAPPER);
  fs.chmodSync(file, 0o755);
  return file;
}

// ---------- Steam launch options ----------
//
// Steam keeps per-game launch options in userdata/<id>/config/localconfig.vdf
// and rewrites that file from memory on exit, so an edit made while Steam runs
// is lost. The edit is therefore made only while Steam is closed, and
// otherwise the exact text is handed to the person to paste.

function localConfigs(steamRoot) {
  const userdata = path.join(steamRoot, 'userdata');
  let ids = [];
  try { ids = fs.readdirSync(userdata).filter((id) => /^\d+$/.test(id) && id !== '0'); } catch { return []; }
  return ids.map((id) => path.join(userdata, id, 'config', 'localconfig.vdf')).filter((file) => fs.existsSync(file));
}

// Find "apps" { "<appid>" { ... } } inside Software/Valve/Steam and return the
// span of that app's block. VDF is balanced braces with quoted strings.
function appBlock(text, appid) {
  const appsAt = text.search(/"apps"\s*\{/i);
  if (appsAt < 0) return null;
  const open = text.indexOf('{', appsAt);
  const end = matchBrace(text, open);
  const inside = text.slice(open, end);
  const re = new RegExp(`\\n(\\s*)"${appid}"\\s*\\{`);
  const match = re.exec(inside);
  if (!match) return { apps: { open, end }, app: null };
  const appOpen = open + match.index + match[0].length - 1;
  return { apps: { open, end }, app: { open: appOpen, end: matchBrace(text, appOpen), indent: match[1] } };
}

function matchBrace(text, open) {
  let depth = 0, quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced localconfig.vdf');
}

function readLaunchOptions(text, appid) {
  const found = appBlock(text, appid);
  if (!found || !found.app) return null;
  const block = text.slice(found.app.open, found.app.end);
  const match = block.match(/"LaunchOptions"\s*"((?:[^"\\]|\\.)*)"/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
}

const vdfEscape = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const shellWord = (file) => (/^[\w@%+=:,./-]+$/.test(file) ? file : `"${file}"`);
const launchOption = (wrapper) => `${shellWord(wrapper)} %command%`;
const hasWrapper = (text) => new RegExp(`(^|[\\s"/])${WRAPPER_NAME}"?(?=\\s|$)`).test(String(text || ''));

// The wrapper goes immediately before %command%, so it wraps the game itself
// and leaves anything in front of it - variables, gamemoderun, bash -c - as it
// was.
function withLaunchOption(current, wrapper = wrapperPath()) {
  const text = String(current || '').trim();
  if (hasWrapper(text)) return text;
  if (!text) return launchOption(wrapper);
  if (text.includes('%command%')) return text.replace('%command%', launchOption(wrapper));
  // Plain arguments with no %command% are arguments to the game.
  return `${launchOption(wrapper)} ${text}`;
}

function withoutLaunchOption(current) {
  const text = String(current || '');
  const stripped = text
    .replace(new RegExp(`(?:"[^"]*${WRAPPER_NAME}"|\\S*${WRAPPER_NAME})\\s+(?=%command%)`, 'g'), '')
    .replace(/\s+/g, ' ').trim();
  return stripped === '%command%' ? '' : stripped;
}

function setLaunchOptions(text, appid, value) {
  const found = appBlock(text, appid);
  if (!found) throw new Error('localconfig.vdf has no apps section');
  const line = (indent) => `${indent}"LaunchOptions"\t\t"${vdfEscape(value)}"`;
  if (!found.app) {
    const indent = (text.slice(0, found.apps.end).match(/\n(\s*)\S[^\n]*$/) || [, '\t\t\t\t\t'])[1];
    const block = `\n${indent}"${appid}"\n${indent}{\n${line(indent + '\t')}\n${indent}}\n${indent.slice(1)}`;
    return text.slice(0, found.apps.end).replace(/\s*$/, '') + block + text.slice(found.apps.end);
  }
  const { open, end, indent } = found.app;
  const block = text.slice(open, end);
  const replaced = /"LaunchOptions"\s*"(?:[^"\\]|\\.)*"/.test(block)
    ? block.replace(/"LaunchOptions"\s*"(?:[^"\\]|\\.)*"/, `"LaunchOptions"\t\t"${vdfEscape(value)}"`)
    : `${block.replace(/\s*$/, '')}\n${line(indent + '\t')}\n${indent}`;
  return text.slice(0, open) + replaced + text.slice(end);
}

function steamRunning(procRoot = '/proc') {
  let pids = [];
  try { pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)); } catch { return false; }
  return pids.some((pid) => {
    try { return /^steam$/.test(fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim()); } catch { return false; }
  });
}

// Apply (or remove) the launch option for every Steam user on this machine.
// Returns what each file had before, so a restore can put it back exactly.
function editLaunchOptions(steamRoot, appid, transform, { procRoot = '/proc' } = {}) {
  if (steamRunning(procRoot)) return { applied: false, reason: 'steamRunning' };
  const files = localConfigs(steamRoot);
  if (!files.length) return { applied: false, reason: 'noSteamUser' };
  const changes = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const before = readLaunchOptions(text, appid);
    const after = transform(before);
    if ((before || '') === after) { changes.push({ file, before, after, changed: false }); continue; }
    fs.copyFileSync(file, `${file}.dlss5-swapper.bak`);
    const tmp = `${file}.dlss5-swapper.tmp`;
    fs.writeFileSync(tmp, setLaunchOptions(text, appid, after));
    fs.renameSync(tmp, file);
    changes.push({ file, before, after, changed: true });
  }
  return { applied: true, changes };
}

const addLaunchOption = (steamRoot, appid, options = {}) =>
  editLaunchOptions(steamRoot, appid, (current) => withLaunchOption(current, options.wrapper || wrapperPath(options.home)), options);
const removeLaunchOption = (steamRoot, appid, options) => editLaunchOptions(steamRoot, appid, withoutLaunchOption, options);

module.exports = {
  RELEASE, LAUNCH_ENV, WRAPPER_NAME, WRAPPER, wrapperPath, ensureWrapper, launchOption, hasWrapper,
  paths, status, install, importModel, start, stop, running,
  readLaunchOptions, setLaunchOptions, withLaunchOption, withoutLaunchOption,
  addLaunchOption, removeLaunchOption, localConfigs, steamRunning
};

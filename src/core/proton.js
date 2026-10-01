'use strict';
// Runs Windows-only helper programs (currently ReShade Setup) in the exact
// Steam Play prefix used by a game.  Copying DLLs itself is ordinary Linux IO;
// only the setup executable needs Proton.
//
// Linux fork: the Proton that owns a prefix is found the way Steam itself
// records it, in this order:
//   1. config_info - Steam writes the running tool's own files path into it
//      every time the prefix is used, so it names the tool that last ran it,
//      custom compatibility tools (GE, CachyOS, EM ...) included.
//   2. CompatToolMapping in Steam's config.vdf - the per-game choice, then
//      the global default ("0").
//   3. Any Valve Proton under steamapps/common of any library, with the one
//      whose name matches config_info first (the original behaviour).
//   4. Any other installed compatibility tool.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Every directory Steam reads compatibility tools from.
function compatToolDirs(steamRoot, env = process.env, home = os.homedir()) {
  const dataDirs = String(env.XDG_DATA_DIRS || '').split(':').filter(Boolean);
  return [...new Set([
    steamRoot && path.join(steamRoot, 'compatibilitytools.d'),
    path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Steam', 'compatibilitytools.d'),
    path.join(home, '.steam', 'root', 'compatibilitytools.d'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'compatibilitytools.d'),
    ...dataDirs.map((dir) => path.join(dir, 'steam', 'compatibilitytools.d')),
    '/usr/local/share/steam/compatibilitytools.d',
    '/usr/share/steam/compatibilitytools.d'
  ].filter(Boolean))];
}

// config_info: line 1 is the tool's version, the following lines are paths
// inside the tool that ran the prefix, e.g.
//   /home/u/.local/share/Steam/compatibilitytools.d/Proton-GE Latest/files/share/fonts/
function toolFromConfigInfo(prefix) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(path.dirname(prefix), 'config_info'), 'utf8').split(/\r?\n/); } catch { return null; }
  for (const line of lines.slice(1)) {
    const match = line.match(/^(\/.+?)\/(?:files|dist)\//);
    if (!match) continue;
    const proton = path.join(match[1], 'proton');
    if (isFile(proton)) return proton;
  }
  return null;
}

// compatibilitytool.vdf names the internal tool id Steam stores in
// CompatToolMapping. Map every installed custom tool id -> its proton script.
function customTools(dirs) {
  const tools = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      const toolDir = path.join(dir, name);
      const proton = path.join(toolDir, 'proton');
      if (!isFile(proton)) continue;
      let ids = [name];
      try {
        const vdf = fs.readFileSync(path.join(toolDir, 'compatibilitytool.vdf'), 'utf8');
        const block = vdf.match(/"compat_tools"\s*\{\s*"([^"]+)"/);
        if (block) ids = [block[1], name];
      } catch { /* a tool without its vdf is still usable by folder name */ }
      for (const id of ids) if (!tools.has(id)) tools.set(id, proton);
    }
  }
  return tools;
}

// The compat tool Steam is configured to use for an app (or the global "0").
function mappedTool(steamRoot, appid) {
  let text = '';
  try { text = fs.readFileSync(path.join(steamRoot, 'config', 'config.vdf'), 'utf8'); } catch { return null; }
  const start = text.indexOf('"CompatToolMapping"');
  if (start < 0) return null;
  const section = text.slice(start);
  const lookup = (id) => {
    const match = section.match(new RegExp(`"${id}"\\s*\\{\\s*"name"\\s*"([^"]*)"`));
    return match && match[1] ? match[1] : null;
  };
  return (appid && lookup(String(appid))) || lookup('0');
}

function steamLibraries(steamRoot) {
  const libraries = new Set([steamRoot]);
  try {
    const vdf = fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1]);
  } catch { /* only the root library */ }
  return [...libraries];
}

function protonCandidates(steamRoot, prefix, options = {}) {
  const found = [];
  const add = (file) => { if (file && isFile(file) && !found.includes(file)) found.push(file); };

  add(toolFromConfigInfo(prefix));
  const custom = customTools(compatToolDirs(steamRoot, options.env, options.home));
  const mapped = mappedTool(steamRoot, options.appid);
  if (mapped && custom.has(mapped)) add(custom.get(mapped));

  let configured = '';
  try { configured = fs.readFileSync(path.join(path.dirname(prefix), 'config_info'), 'utf8').split(/\r?\n/)[0].trim(); } catch {}
  const valve = [];
  for (const library of steamLibraries(steamRoot)) {
    const common = path.join(library, 'steamapps', 'common');
    let names = [];
    try { names = fs.readdirSync(common); } catch { continue; }
    for (const name of names) {
      if (!/^Proton(?:\s|\d|[-_])/i.test(name)) continue;
      valve.push({ name, file: path.join(common, name, 'proton') });
    }
  }
  const matches = (name) => Number(Boolean(configured) && name.includes(configured));
  valve.sort((a, b) => matches(b.name) - matches(a.name)).forEach((item) => add(item.file));
  // Anything else installed is still better than refusing outright.
  for (const file of custom.values()) add(file);
  return found;
}

function contextForSteamGame(game, platform = process.platform) {
  if (platform !== 'linux' || !game || !game.steamRoot || !game.protonPrefix) return null;
  if (!fs.existsSync(game.protonPrefix)) return null;
  const proton = protonCandidates(game.steamRoot, game.protonPrefix, { appid: game.id })[0];
  return proton ? { proton, prefix: game.protonPrefix, steamRoot: game.steamRoot, appid: game.id } : null;
}

// The prefix's Windows directory, for checks that look at System32.
function prefixWindowsDir(context) {
  return context && context.prefix ? path.join(context.prefix, 'drive_c', 'windows') : null;
}

function createSetupRunner(context) {
  return (setupExe, args, log) => new Promise((resolve) => {
    log('runningSetup', { setup: path.basename(setupExe), args: args.slice(1).join(' ') });
    const child = spawn(context.proton, ['run', setupExe, ...args], {
      cwd: path.dirname(args[0]),
      env: {
        ...process.env,
        WINEPREFIX: context.prefix,
        STEAM_COMPAT_DATA_PATH: path.dirname(context.prefix),
        STEAM_COMPAT_CLIENT_INSTALL_PATH: context.steamRoot,
        STEAM_COMPAT_APP_ID: context.appid
      }
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code, output: output.trim() }));
    setTimeout(() => { try { child.kill(); } catch {} }, 120000);
  });
}

module.exports = {
  protonCandidates, contextForSteamGame, createSetupRunner, prefixWindowsDir,
  compatToolDirs, toolFromConfigInfo, customTools, mappedTool
};

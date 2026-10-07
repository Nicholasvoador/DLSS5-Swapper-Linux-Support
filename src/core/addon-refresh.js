'use strict';
// Linux fork: RenoDX in games that are already set up, kept current.
//
// An install copies RenoDX into the game and records it in the game's backup
// manifest. A newer RenoDX in the app - from an app update or the Updates
// panel - used to reach a game only when its route was installed again. This
// finds the copies the app put into each game and replaces the ones that are
// an older build the app itself shipped.
//
// What is never touched:
//  - a build somebody put there by hand: any file whose fingerprint is not a
//    build this app shipped or accepted;
//  - a build chosen on the Add-ons page, even an old one - that was a choice;
//  - a build newer than the app's own (after a revert): never a downgrade;
//  - a game that is running.
// Restore is unaffected: it puts the original from the backup back, or deletes
// a file the app added, whatever build is there in between.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const renodxRelease = require('./renodx-release');
const versionCheck = require('./version-check');

const CONSUMER = 'renodx-dlss5.addon64';
const MULTIPASS = 'renodx-dlss.addon64';
const LEDGER = 'renodx-builds.json';

// Every RenoDX build this app has shipped, by the SHA-256 of the add-on file.
// The pins in renodx-release.js must always be in here - a test makes sure -
// so a game set up by any release can be brought forward by a later one.
const SHIPPED = Object.freeze({
  [CONSUMER]: Object.freeze({
    ...renodxRelease.FAULTING,
    '342341f669f1d64e0c70c8593a07a2fab5075e073dfae97c331c9a6776260a0a': '6.5.3',
    dcd93881e976ad033d83c2bb01f4bc3e4ddc59c15fe0dd4ca165bc5fc7d1ac68: '8.5.0-rc10'
  }),
  [MULTIPASS]: Object.freeze({
    '25600017cf95ad797eabb4e93de694b0dc1fce472999381c114bf44a7692ef60': 'SF 26.0927.2125',
    '083c002027996af25db4d1d67ca98bb6772c5cc6f28b6ea3dbc506867a97f187': 'SF 26.0928.0205',
    '1310119c87e4ab5ad0af41511411bd4608ff3c3030a29196ae0e4bba32c84585': 'SF 26.1003.2350'
  })
});
const SHA = /^[0-9a-f]{64}$/;

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// The shipped builds plus every build accepted from the Updates panel on this
// PC, which the app copied into games just the same.
function knownBuilds(userData) {
  const out = { [CONSUMER]: { ...SHIPPED[CONSUMER] }, [MULTIPASS]: { ...SHIPPED[MULTIPASS] } };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, LEDGER), 'utf8'));
    for (const name of [CONSUMER, MULTIPASS]) {
      for (const [sha, version] of Object.entries((saved && saved[name]) || {})) {
        if (SHA.test(sha) && typeof version === 'string') out[name][sha] = version;
      }
    }
  } catch { /* nothing accepted here yet */ }
  return out;
}
function rememberBuild(userData, name, sha256, version) {
  if (![CONSUMER, MULTIPASS].includes(name) || !SHA.test(String(sha256))) return;
  const file = path.join(userData, LEDGER);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first one */ }
  saved[name] = { ...(saved[name] || {}), [sha256]: String(version) };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(`${file}.new`, JSON.stringify(saved, null, 2));
    fs.renameSync(`${file}.new`, file);
  } catch { /* the shipped list still covers every release's own builds */ }
}

// What the app installed into one game, and how each RenoDX file there stands
// against the build the app has now. `targets` maps a file name to the
// current build { sha256, version, source }; `chosen` holds the fingerprints
// of builds switched on in the Add-ons page.
function inspectGame(gameDir, targets, known, chosen = new Set()) {
  const root = path.join(gameDir, '_DLSS5_Backup');
  // An install or switch that did not finish is not a state to build on.
  if (fs.existsSync(path.join(root, 'pending-switch.json'))) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch { return null; }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.added) || !Array.isArray(manifest.replaced)) return null;
  const inside = path.resolve(gameDir) + path.sep;
  const seen = new Set();
  const files = [];
  for (const rel of [...manifest.added, ...manifest.replaced.map((row) => row && row.rel)]) {
    if (typeof rel !== 'string') continue;
    const name = path.basename(rel).toLowerCase();
    const target = targets[name];
    if (!target) continue;
    const full = path.resolve(gameDir, rel);
    if (!full.startsWith(inside) || seen.has(full)) continue;
    seen.add(full);
    if (!fs.existsSync(full)) continue;
    const sha256 = sha256File(full);
    const version = (known[name] || {})[sha256] || null;
    let state;
    if (sha256 === target.sha256) state = 'current';
    else if (chosen.has(sha256)) state = 'chosen';
    else if (!version) state = 'custom';
    // Never backwards. After a revert in the Updates panel a game can hold a
    // newer build than the app's; it keeps it until the route is installed again.
    else state = versionCheck.compare(version, target.version) > 0 ? 'newer' : 'older';
    files.push({ rel, name, sha256, version, state, latest: target.version });
  }
  if (!files.length) return null;
  return {
    dir: path.resolve(gameDir),
    exe: manifest.game && typeof manifest.game.exe === 'string' ? manifest.game.exe : null,
    route: manifest.route || null,
    files
  };
}

// Replace every older build in one game. The game must be closed; each file is
// written beside the old one, checked, and only then put in its place.
async function refreshGame(game, targets, { assertClosed = async () => {} } = {}) {
  const pending = game.files.filter((file) => file.state === 'older');
  if (!pending.length) return { dir: game.dir, updated: [] };
  await assertClosed(game.dir, game.exe ? path.join(game.dir, game.exe) : null);
  const updated = [];
  for (const file of pending) {
    const target = targets[file.name];
    const full = path.resolve(game.dir, file.rel);
    // What is there now decides, not what was there when the panel looked.
    if (sha256File(full) !== file.sha256) continue;
    const next = `${full}.dlss5-update-${process.pid}`;
    try {
      fs.copyFileSync(target.source, next);
      if (sha256File(next) !== target.sha256) throw new Error(`${path.basename(target.source)} in the app is not the build it should be; nothing was changed`);
      fs.renameSync(next, full);
    } finally {
      fs.rmSync(next, { force: true });
    }
    updated.push({ rel: file.rel, from: file.version, to: target.version });
  }
  return { dir: game.dir, updated };
}

module.exports = { CONSUMER, MULTIPASS, LEDGER, SHIPPED, sha256File, knownBuilds, rememberBuild, inspectGame, refreshGame };

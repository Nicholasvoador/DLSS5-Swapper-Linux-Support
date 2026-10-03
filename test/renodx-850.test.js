'use strict';
// RenoDX 8.5.0-rc10: the pin, the bridge that drives its redrawn page, and the
// Linux payload that actually delivers it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const renodx = require('../src/core/renodx-release');
const linuxPayload = require('../src/core/linux-payload');

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dlss5-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- the pin ----------

function pins() {
  const probe = read('overlay', 'renodx-ui-probe.hpp');
  const bytes = (name) => Buffer.from(probe.match(new RegExp(`inline const unsigned char ${name}\\[\\] = \\{([^}]+)\\}`))[1]
    .split(',').map((b) => parseInt(b.trim(), 16)));
  const rows = [...probe.matchAll(/\{"([^"]+)",\s*(\d+),\s*(sha_\w+),\s*(0x[0-9a-f]+),\s*(0x[0-9a-f]+),\s*(init_\w+),[^,]+,\s*(0x[0-9a-f]+),\s*(call_\w+),[^,]+,\s*(0x[0-9a-f]+)\}/g)];
  return rows.map((m) => ({
    name: m[1], size: Number(m[2]), sha256: bytes(m[3]).toString('hex'), slot: Number(m[4]),
    initAt: Number(m[5]), init: bytes(m[6]), callAt: Number(m[7]), call: bytes(m[8]), overlay: Number(m[9])
  }));
}

test('the shipped RenoDX consumer is a build the F8 bridge can drive', () => {
  const rc10 = pins().find((p) => p.name === '8.5.0-rc10');
  assert.ok(rc10, '8.5.0-rc10 is in known_builds');
  assert.equal(rc10.sha256, renodx.CONSUMER.sha256);
  assert.equal(rc10.size, 3141632);
  // The builds before it keep their controls.
  assert.deepEqual(pins().map((p) => p.name), ['8.5.0-rc10', '6.5.3', '4.7']);
});

test('every pin is consistent with the instructions it fingerprints', () => {
  // A pin is four numbers that move with every build. They are not trusted as
  // numbers: each is what the fingerprinted code itself says.
  for (const p of pins()) {
    // mov ecx, 19250 ; call rax ; mov [rip+disp32], rax  ->  the table slot
    assert.deepEqual([...p.init.subarray(0, 10)], [0xb9, 0x32, 0x4b, 0x00, 0x00, 0xff, 0xd0, 0x48, 0x89, 0x05], `${p.name}: GetImGuiFunctionTable(19250) store`);
    assert.equal(p.initAt + 14 + p.init.readInt32LE(10), p.slot, `${p.name}: slot is where that store writes`);
    // lea rdx, [rip+disp32] ... call rax  ->  the callback register_overlay is given
    assert.deepEqual([...p.call.subarray(0, 3)], [0x48, 0x8d, 0x15], `${p.name}: lea rdx`);
    assert.deepEqual([...p.call.subarray(-2)], [0xff, 0xd0], `${p.name}: call rax`);
    assert.equal(p.callAt + 7 + p.call.readInt32LE(3), p.overlay, `${p.name}: overlay is the callback registered`);
  }
});

// ---------- the bridge ----------

test('the hidden pass is on screen, invisible and input-less, so 8.x draws into it', () => {
  const bridge = read('overlay', 'renodx-ui-bridge.hpp');
  // At -30000 ImGui hides the child window 8.x draws its whole page in, and
  // the bridge saw 0 of 15 controls.
  assert.doesNotMatch(bridge, /SetNextWindowPos\(ImVec2\(-30000/);
  assert.match(bridge, /ImGui::PushStyleVar\(ImGuiStyleVar_Alpha, \.001f\)/);
  assert.doesNotMatch(bridge, /PushStyleVar\(ImGuiStyleVar_Alpha, 0(\.0)?f?\)/, 'alpha 0 makes ImGui skip the window');
  assert.match(bridge, /ImGuiWindowFlags_NoInputs/);
  assert.equal((bridge.match(/ImGui::End\(\); ImGui::PopStyleVar\(\);/g) || []).length, 2, 'both exits pop the alpha');
});

test('8.x controls are found by their INI key, and each 6.x label keeps its slot', () => {
  const bridge = read('overlay', 'renodx-ui-bridge.hpp');
  for (const [label, key] of [
    ['Structure Intensity', 'NRLocalStructure'], ['Enable DLSS Neural Rendering', 'NeuralUplift'],
    ['Automatic / Character Mask', 'NRAutoMask'], ['Character/Skin Structure', 'NRSkinStructure'],
    ['Overall Intensity', 'NRIntensity'], ['Local Tone Intensity', 'NRLocalTone'],
    ['Diffuse White (nits)', 'NRDiffuseWhiteNits'], ['Motion Scale X Multiplier', 'NRMVecScaleX'],
    ['Motion Scale Y Multiplier', 'NRMVecScaleY'], ['NR UI Correction', 'NRUICorrection'],
    ['NR Preset', 'NRPreset'], ['NR Style', 'NRStyle'], ['Depth Convention', 'NRDepthMode']
  ]) assert.ok(bridge.includes(`{"${label}", `) && bridge.includes(`"${key}"}`), `${label} -> ${key}`);
  // 8.x has no Global Tone, so it cannot be what makes the panel available.
  assert.match(bridge, /active = fields\[0\]\.seen && fields\[2\]\.seen;/);
  // The ID stack is mirrored, and an 8.x drop-down is opened on paper only.
  assert.match(bridge, /table\.PushID = push_id;.*table\.PopID = pop_id;/);
  assert.match(bridge, /table\.BeginCombo = begin_combo; table\.EndCombo = end_combo;/);
  assert.match(bridge, /if \(s\.fake_combos\) \{ --s\.fake_combos; s\.combo_field = nullptr; return; \}/);
});

test('the bridge reads RenoDX settings but changes them only through its own UI', () => {
  const bridge = read('overlay', 'renodx-ui-bridge.hpp');
  assert.match(bridge, /reshade::get_config_value\(nullptr, config_section, key, value\)/);
  assert.doesNotMatch(bridge, /set_config_value/, 'never writes a setting itself');
});

// ---------- the Linux payload ----------

test('the Linux payload lays exactly the pinned RenoDX builds over upstream', () => {
  const byFile = Object.fromEntries(linuxPayload.COMPONENTS.map((c) => [c.file, c]));
  assert.equal(byFile['renodx-dlss5.addon64'].sha256, renodx.CONSUMER.sha256);
  assert.deepEqual(byFile['renodx-dlss5.addon64'].targets, ['renodx-dlss5.addon64', 'feeder/host64/renodx-dlss5.addon64']);
  assert.equal(byFile['renodx-dlss.addon64'].sha256, renodx.MULTIPASS.sha256);
  assert.deepEqual(byFile['renodx-dlss.addon64'].targets, ['feeder/host64/renodx-dlss.addon64']);
  for (const c of linuxPayload.COMPONENTS) {
    assert.match(c.archive[1], /^https:\/\/github\.com\/RankFTW\/rhi-repo\/releases\/download\//);
    assert.match(c.archive[2], /^[0-9a-f]{64}$/);
  }
});

// A payload unpacked from the upstream package, carrying upstream's RenoDX.
function upstreamPayload(t, userData) {
  const upstream = { version: 'test', name: 'pkg.exe', url: 'https://invalid.example/pkg.exe', size: 1, sha256: 'a'.repeat(64) };
  const dir = linuxPayload.payloadDir(userData);
  for (const rel of linuxPayload.REQUIRED) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `upstream ${rel}`);
  }
  fs.writeFileSync(path.join(dir, linuxPayload.MARKER), JSON.stringify({ version: 'test', sha256: upstream.sha256 }));
  return { upstream, dir };
}
function componentZip(t, userData, content) {
  const tools = linuxPayload.sevenZipCandidates(userData);
  if (!tools.length) return null;
  const stage = tmp(t, 'zip');
  fs.writeFileSync(path.join(stage, 'renodx-dlss5.addon64'), content);
  const zip = path.join(stage, 'c.zip');
  execFileSync(tools[0], ['a', '-tzip', '-y', zip, 'renodx-dlss5.addon64'], { cwd: stage, stdio: 'ignore' });
  return fs.readFileSync(zip);
}

test('an upstream payload with an older RenoDX fetches only the pinned add-on', async (t) => {
  const userData = tmp(t, 'component');
  const { upstream, dir } = upstreamPayload(t, userData);
  const addon = Buffer.from('the pinned consumer');
  const zip = componentZip(t, userData, addon);
  if (!zip) return t.skip('no 7-Zip available on this machine');
  const pin = { version: 't1', file: 'renodx-dlss5.addon64', archive: ['c.zip', 'https://invalid.example/c.zip', sha(zip)],
    sha256: sha(addon), targets: ['renodx-dlss5.addon64', 'feeder/host64/renodx-dlss5.addon64'] };
  assert.equal(linuxPayload.ready(userData, upstream, [pin]), false, 'upstream RenoDX is not the pinned one');
  assert.equal(linuxPayload.upstreamReady(userData, upstream), true);

  const asked = [], said = [];
  const fetchImpl = async (url) => { asked.push(url); return new Response(zip, { status: 200, headers: { 'content-length': String(zip.length) } }); };
  const out = await linuxPayload.ensurePayload(userData, { upstream, components: [pin], fetchImpl, log: (code) => said.push(code) });
  assert.equal(out, dir);
  assert.deepEqual(asked, ['https://invalid.example/c.zip'], 'the 250 MB upstream package is not fetched again');
  for (const rel of pin.targets) assert.equal(sha(fs.readFileSync(path.join(dir, rel))), pin.sha256, rel);
  assert.deepEqual(said, ['componentDownloading', 'componentReady']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, linuxPayload.MARKER), 'utf8')).components['renodx-dlss5.addon64'].sha256, pin.sha256);
  assert.ok(linuxPayload.ready(userData, upstream, [pin]));
  assert.ok(!fs.existsSync(path.join(userData, 'component-download')), 'scratch space is cleaned up');
  // Already current: nothing is asked for.
  await linuxPayload.ensurePayload(userData, { upstream, components: [pin], fetchImpl });
  assert.equal(asked.length, 1);
});

test('a release zip that does not hold the pinned file replaces nothing', async (t) => {
  const userData = tmp(t, 'component-bad');
  const { upstream, dir } = upstreamPayload(t, userData);
  const zip = componentZip(t, userData, Buffer.from('some other build'));
  if (!zip) return t.skip('no 7-Zip available on this machine');
  const pin = { version: 't2', file: 'renodx-dlss5.addon64', archive: ['c.zip', 'https://invalid.example/c.zip', sha(zip)],
    sha256: sha(Buffer.from('the pinned consumer')), targets: ['renodx-dlss5.addon64'] };
  const fetchImpl = async () => new Response(zip, { status: 200 });
  await assert.rejects(linuxPayload.ensurePayload(userData, { upstream, components: [pin], fetchImpl }), /not the pinned build/);
  assert.equal(fs.readFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'utf8'), 'upstream renodx-dlss5.addon64');
  // A zip whose own digest is wrong never gets unpacked at all.
  const wrongZip = { ...pin, archive: ['c.zip', 'https://invalid.example/c.zip', 'f'.repeat(64)] };
  await assert.rejects(linuxPayload.ensurePayload(userData, { upstream, components: [wrongZip], fetchImpl }), /SHA-256 mismatch/);
  assert.equal(fs.readFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'utf8'), 'upstream renodx-dlss5.addon64');
});

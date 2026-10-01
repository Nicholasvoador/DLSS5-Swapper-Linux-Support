'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const vc = require('../src/core/version-check');

// The network is a stub: what is under test is what the app CONCLUDES from an
// answer, not whether GitHub is up. Every case here is one that was observed
// against the real feeds while this was written.
function responder(feeds) {
  return async (url) => {
    const key = Object.keys(feeds).find((part) => url.includes(part));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const value = feeds[key];
    const body = Array.isArray(value)
      ? value.map((row) => (typeof row === 'string' ? { tag_name: row } : row))
      : value;
    return { ok: true, status: 200, json: async () => body };
  };
}

test('a release outranks its own prereleases, and rc10 outranks rc8', () => {
  assert.equal(vc.compare('8.5.0-rc10', '8.5.0-rc8'), 1);
  assert.equal(vc.compare('8.5.0-rc8', '8.5.0-rc10'), -1);
  assert.equal(vc.compare('8.5.0', '8.5.0-rc10'), 1);
  assert.equal(vc.compare('8.5.0', '8.5.0'), 0);
  assert.equal(vc.compare('6.5.3', '8.5.0-rc10'), -1);
  // The two schemes RenoDX writes for its SF builds.
  assert.equal(vc.compare('26.0928.0205', 'SF 26.0927.2125'), 1);
  assert.equal(vc.compare('SF 26.0927.2125', '26.0927.2125'), 0);
});

test('a build label is not an older version', () => {
  // Seen live: our pin says 0.8.92-presr and the tag says v0.8.92. That is one
  // release under two names, and reading it as an update is a phantom.
  assert.equal(vc.compare('0.8.92-presr', 'v0.8.92'), 0);
  assert.equal(vc.compare('0.2.0-patch1', 'v0.2.0-dlssnr'), 0);
  // A label still orders below a real prerelease of a higher base.
  assert.equal(vc.compare('0.2.0-patch1', '0.3.0-rc1'), -1);
});

test('two names for one release is not an update', async () => {
  const result = await vc.check({
    current: { optinr: '0.8.92-presr' },
    fetchImpl: responder({
      'jlrouzies-fr/OptiScaler-DLSSNR-PreSR-Multipass': { tag_name: 'v0.8.92' }
    })
  });
  assert.equal(result.components[0].latest, 'v0.8.92');
  assert.equal(result.components[0].newer, false);
});

test('the newest offer wins even when the feed is not ordered by version', async () => {
  const result = await vc.check({
    current: { renodx: '6.5.3', multipass: 'SF 26.0927.2125' },
    fetchImpl: responder({
      'RankFTW/rhi-repo': [
        'renodx-dlss-SF-26.0928.0205', // a newer release, but the other product
        'renodx-dlss5-8.5.0-rc5',      // listed before rc10 on the real feed
        'renodx-dlss5-8.5.0-rc10',
        'renodx-dlss5-7.0.0-rc8',
        'renodx-dlss5-6.5.3'
      ]
    })
  });
  const renodx = result.components.find((row) => row.key === 'renodx');
  const multipass = result.components.find((row) => row.key === 'multipass');
  assert.equal(renodx.latest, '8.5.0-rc10', 'not the first match, the highest');
  assert.equal(renodx.newer, true);
  assert.equal(multipass.latest, '26.0928.0205');
  assert.equal(multipass.newer, true);
});

test('a prerelease is never the recommended update', async () => {
  const result = await vc.check({
    current: { feeder: '1.17.0' },
    fetchImpl: responder({ 'jlrouzies-fr/DLSS5-Feeder': [{ tag_name: 'v1.18.0-beta.1' }, { tag_name: 'v1.17.0' }] })
  });
  const feeder = result.components[0];
  assert.equal(feeder.latest, 'v1.17.0', 'the stable channel is what is recommended');
  assert.equal(feeder.newer, false, '1.17.0 is what we ship');
  assert.equal(feeder.prereleaseAhead, 'v1.18.0-beta.1', 'and the beta is still reported as a fact');
});

test('an unchanged component is not an update', async () => {
  const result = await vc.check({
    current: { dlssnr: '0.3.1-2' },
    fetchImpl: responder({ 'bmitch87/DLSS5VKLayer': { tag_name: '0.3.1-2' } })
  });
  assert.equal(result.components[0].newer, false);
  assert.equal(result.components[0].latest, '0.3.1-2');
});

test('every feed failing is distinguishable from being up to date', async () => {
  const result = await vc.check({
    current: { renodx: '6.5.3', dlssnr: '0.3.1-2' },
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(result.answered, false, 'nothing answered');
  assert.equal(result.components.length, 2, 'and every component is still reported');
  assert.ok(result.components.every((row) => row.latest === null && row.newer === false));
});

test('a component this app does not pin is simply skipped', async () => {
  const result = await vc.check({
    current: { renodx: '6.5.3' },
    fetchImpl: responder({ 'RankFTW/rhi-repo': ['renodx-dlss5-8.5.0-rc10'] })
  });
  assert.deepEqual(result.components.map((row) => row.key), ['renodx']);
});

test('the fork says when upstream has moved past its base', async () => {
  const result = await vc.check({
    current: { dlssnr: '0.3.1-2' },
    upstream: { current: '2.2.9', repo: 'rakanki911/DLSS5-Swapper' },
    fetchImpl: responder({
      'rakanki911/DLSS5-Swapper': { tag_name: 'v2.3.0' },
      'bmitch87/DLSS5VKLayer': { tag_name: '0.3.1-2' }
    })
  });
  assert.equal(result.base.latest, 'v2.3.0');
  assert.equal(result.base.newer, true, 'upstream moved, so there is something to pull in');
});

test('being level with upstream is not an update', async () => {
  // The normal state for this fork: our Linux work sits on top of the release
  // we forked at, and upstream has not published since.
  const result = await vc.check({
    current: { renodx: '6.5.3' },
    upstream: { current: '2.2.9', repo: 'rakanki911/DLSS5-Swapper' },
    fetchImpl: responder({
      'rakanki911/DLSS5-Swapper': { tag_name: 'v2.2.9' },
      'RankFTW/rhi-repo': ['renodx-dlss5-8.5.0-rc10']
    })
  });
  assert.equal(result.base.latest, 'v2.2.9');
  assert.equal(result.base.newer, false);
});

'use strict';

// Is what this fork ships still what upstream publishes? That is the whole
// job. Nothing here installs, downloads or changes a game: it produces a
// verdict per component, and the person decides.
//
// The fork matters to the answer. Upstream is rakanki911/DLSS5-Swapper; this
// repository is a Linux fork of it, so trailing upstream silently is the
// failure this check exists to prevent - while a fork that is AHEAD of
// upstream (our Linux work) must not be reported as behind.
//
// Reads only, one lookup per feed per launch, no identifiers sent, and every
// failure is silence rather than a scare.

const API = 'https://api.github.com/repos';
const DEFAULT_TIMEOUT = 8000;

// A tag scheme that carries a prefix, and the part of it that is a version.
// rhi-repo publishes several products from one release feed, so the newest
// release in the feed is not the newest of the component we care about: the
// tag prefix is what separates them.
const PREFIXED = {
  'renodx-dlss5-': true,      // renodx-dlss5-8.5.0-rc10
  'renodx-dlss-SF-': true     // renodx-dlss-SF-26.0928.0205
};

// Where each component comes from upstream, and how this app refers to the
// version it ships. `current` is injected by the caller so this module never
// has to guess at a pin it does not own.
const FEEDS = Object.freeze({
  renodx: { label: 'RenoDX DLSS 5 add-on', repo: 'RankFTW/rhi-repo', prefix: 'renodx-dlss5-' },
  multipass: { label: 'RenoDX multipass (SF)', repo: 'RankFTW/rhi-repo', prefix: 'renodx-dlss-SF-' },
  feeder: { label: 'DLSS5-Feeder', repo: 'jlrouzies-fr/DLSS5-Feeder', latest: true, stableOnly: true },
  dlssnr: { label: 'dlssnr Vulkan layer', repo: 'bmitch87/DLSS5VKLayer', latest: true },
  optiscaler: { label: 'OptiScaler DLSS-NR', repo: 'Dagherbou/OptiScaler_DLSSNR', latest: true },
  optinr: { label: 'OptiScaler NR multipass', repo: 'jlrouzies-fr/OptiScaler-DLSSNR-PreSR-Multipass', latest: true }
});

// "SF 26.0927.2125" and "26.0928.0205" are the same scheme written two ways.
function normalize(value) {
  return String(value == null ? '' : value).trim().replace(/^v/, '').replace(/^SF\s+/i, '');
}

// Only these suffixes order a build against its base. A project's own LABEL
// suffix - "-presr", "-dlssnr", "-patch1" - names which build of the same
// version it is, not an earlier one: reading "0.8.92-presr" as older than
// "0.8.92" invents an update that does not exist.
const PRE = /^(rc|beta|alpha|pre|preview)[.\d]*$/i;

// A release beats its own prereleases; prereleases order among themselves by
// their trailing number, so rc10 is newer than rc8 rather than older than it.
function compare(left, right) {
  const a = normalize(left).split('-');
  const b = normalize(right).split('-');
  const ac = a[0].split('.').map((n) => Number(n) || 0);
  const bc = b[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const x = ac[i] || 0;
    const y = bc[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  const ap = a.slice(1).join('-');
  const bp = b.slice(1).join('-');
  if (ap === bp) return 0;
  const aPre = PRE.test(ap);
  const bPre = PRE.test(bp);
  if (aPre && bPre) {
    const an = Number((ap.match(/(\d+)\s*$/) || [])[1]);
    const bn = Number((bp.match(/(\d+)\s*$/) || [])[1]);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an > bn ? 1 : -1;
    return ap === bp ? 0 : (ap > bp ? 1 : -1);
  }
  if (aPre) return -1;
  if (bPre) return 1;
  // Same version, two labels. The same build under a different name.
  return 0;
}

function tagVersion(tag, prefix) {
  const text = String(tag || '');
  if (prefix && PREFIXED[prefix] && text.startsWith(prefix)) return text.slice(prefix.length);
  return text;
}

async function json(url, fetchImpl, timeout) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'DLSS5-Swapper/version-check' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return response.json();
}

// Every version one feed offers, newest-feeling first is not guaranteed, so
// the caller reduces: a release feed is not ordered by the component's own
// version - rc10 and rc5 sit beside each other, and "first match" quietly
// picks the older one.
async function candidates(feed, { fetchImpl, timeout }) {
  if (feed.latest && !feed.stableOnly) {
    const body = await json(`${API}/${feed.repo}/releases/latest`, fetchImpl, timeout);
    const version = tagVersion(body.tag_name, null);
    return version ? [version] : [];
  }
  const body = await json(`${API}/${feed.repo}/releases?per_page=30`, fetchImpl, timeout);
  const rows = Array.isArray(body) ? body : [];
  return rows
    .map((row) => String(row.tag_name || ''))
    .filter((tag) => !feed.prefix || tag.startsWith(feed.prefix))
    .map((tag) => tagVersion(tag, feed.prefix))
    .filter(Boolean);
}

function highest(list, predicate = () => true) {
  return list.filter(predicate).reduce((best, version) => (!best || compare(version, best) > 0 ? version : best), null);
}

// A project's own prerelease naming is the signal. Two different policies meet
// here: the RenoDX consumers are published as rc builds and that IS the channel
// everyone installs from, so an rc is the answer there. The Feeder ships a
// stable release, and "1.18.0-beta.1 is newer than 1.17.0" is arithmetically
// true and not something to push at someone - it is reported, not recommended.
function prerelease(version) {
  return /(?:^|[.-])(?:beta|rc|alpha|pre|preview)[.\d]*$/i.test(String(version || ''));
}


// current: { renodx, multipass, feeder, dlssnr, optiscaler, optinr }
// upstream: { current, repo } - this fork's base version against the repo it
// forked from. The two are allowed to differ: our Linux commits make the fork
// ahead, and "ahead of upstream" is not a problem to report as one. What
// matters is whether upstream has moved past the version we forked at.
async function check({ current = {}, upstream = null, fetchImpl = global.fetch, timeout = DEFAULT_TIMEOUT } = {}) {
  const components = [];
  for (const [key, feed] of Object.entries(FEEDS)) {
    const pinned = current[key];
    if (!pinned) continue;
    let offered = [];
    try { offered = await candidates(feed, { fetchImpl, timeout }); } catch { offered = []; }
    const pool = feed.stableOnly ? offered.filter((version) => !prerelease(version)) : offered;
    const latest = highest(pool);
    // A newer build on a channel we deliberately do not follow. Shown as a
    // fact, never as the recommended action.
    const ahead = highest(offered.filter((version) => prerelease(version) && !pool.includes(version)));
    components.push({
      key,
      label: feed.label,
      current: String(pinned),
      latest: latest || null,
      newer: Boolean(latest) && compare(latest, pinned) > 0,
      prereleaseAhead: ahead && compare(ahead, pinned) > 0 ? ahead : null,
      url: `https://github.com/${feed.repo}/releases`
    });
  }
  let base = null;
  if (upstream && upstream.current) {
    let latest = null;
    try {
      const feed = { repo: upstream.repo || 'rakanki911/DLSS5-Swapper', latest: true };
      const offered = await candidates(feed, { fetchImpl, timeout });
      latest = highest(offered);
    } catch { latest = null; }
    base = {
      repo: upstream.repo || 'rakanki911/DLSS5-Swapper',
      current: String(upstream.current),
      latest: latest || null,
      // Equal or older than upstream is the settled case; only a newer upstream
      // release means there is something to pull in.
      newer: Boolean(latest) && compare(latest, upstream.current) > 0,
      url: `https://github.com/${upstream.repo || 'rakanki911/DLSS5-Swapper'}/releases`
    };
  }
  return {
    checkedAt: new Date().toISOString(),
    components,
    base,
    // Nothing answered: distinguishable from "everything is current".
    answered: components.some((row) => row.latest) || Boolean(base && base.latest)
  };
}

module.exports = { check, compare, normalize, prerelease, FEEDS, PREFIXED, tagVersion };

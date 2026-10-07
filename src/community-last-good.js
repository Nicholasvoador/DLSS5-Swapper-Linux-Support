'use strict';
// Linux fork: the community service's last good answers, kept on this PC.
//
// When the community server is slow, failing or unreachable, the Community and
// Chat tabs show the last results they did get - marked as such, with when
// they are from - instead of an empty page. Only answers that came back whole
// are kept, a bounded number of them, and none older than a week: a stale page
// is a convenience, and an old one would be misleading.
//
// Only reads use this. Anything that changes something on the server - a
// report, a reply, a chat message - still fails visibly when the server does.

const fs = require('fs');
const path = require('path');

// The failures this stands in for: the server being slow, broken or out of
// reach. A refusal from the service itself (bad input, not allowed) is an
// answer and is passed through.
const STALE_CODES = new Set(['community_slow', 'community_down', 'community_offline']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

class LastGood {
  constructor({ file, limit = 12, maxAgeMs = WEEK_MS, now = () => Date.now() }) {
    this.file = file;
    this.limit = limit;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.entries = null;
  }

  load() {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [key, entry] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
        if (entry && typeof entry.at === 'number' && entry.answer && typeof entry.answer === 'object') this.entries.set(key, entry);
      }
    } catch { /* nothing kept yet, or a damaged file: start empty */ }
    return this.entries;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.load())), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch { /* the copy in memory still serves this session */ }
  }

  remember(key, answer) {
    const entries = this.load();
    entries.delete(key);
    entries.set(key, { at: this.now(), answer });
    // Newest last: drop the oldest beyond the limit.
    while (entries.size > this.limit) entries.delete(entries.keys().next().value);
    this.save();
  }

  recall(key) {
    const entry = this.load().get(key);
    if (!entry) return null;
    if (this.now() - entry.at > this.maxAgeMs) return null;
    return entry;
  }
}

// Run a read; keep its answer when it worked, and fall back to the kept one when
// the server is the problem. The fallback says so: `stale` carries when the
// answer is from and why the fresh one could not be had.
async function withLastGood(store, key, work, { keep = () => true } = {}) {
  try {
    const answer = await work();
    if (answer && keep(answer)) store.remember(key, answer);
    return answer;
  } catch (error) {
    const saved = error && STALE_CODES.has(error.code) ? store.recall(key) : null;
    if (!saved) throw error;
    return { ...saved.answer, stale: { at: saved.at, reason: error.code, message: error.message } };
  }
}

// Filters in a stable order, without the cache-busting flag, so the same view
// asked for twice is one entry. A value that means "no filter", and the
// server's own default order, name the same view as leaving them out: the page
// sends gpu and sort only once the server has said it knows them, so the first
// request of a session and every later one would otherwise be filed apart, and
// the saved answer never found.
const NO_FILTER = new Set(['', 'all']);
const DEFAULTS = Object.freeze({ sort: 'recent' });
function viewKey(prefix, filters) {
  const input = filters && typeof filters === 'object' ? filters : {};
  const parts = Object.keys(input)
    .filter((key) => {
      const value = input[key];
      return key !== 'fresh' && value !== undefined && value !== null && !NO_FILTER.has(value) && DEFAULTS[key] !== value;
    })
    .sort().map((key) => [key, input[key]]);
  return `${prefix}:${JSON.stringify(parts)}`;
}

module.exports = { LastGood, withLastGood, viewKey, STALE_CODES };

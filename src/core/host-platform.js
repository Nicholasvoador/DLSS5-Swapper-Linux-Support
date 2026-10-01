'use strict';
// Which OS the main process is serving. One module so the tests that run
// main.js inside a vm sandbox can say "this is Windows" (or Linux) without
// touching the real process object.
module.exports = { platform: typeof process !== 'undefined' ? process.platform : 'unknown' };

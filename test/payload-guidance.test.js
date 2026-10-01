'use strict';
// #220: the message told people to run a build command. They had installed the
// app and had no npm; the real causes were antivirus quarantine and, for the
// portable build, a half-finished self-extraction into %TEMP%.
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingPayload } = require('../src/core/payload-guidance');

test('from source it still says the thing a developer needs', () => {
  const { code, message } = missingPayload({ packaged: false, appRoot: 'C:\\src\\app', resourcesPath: 'ignored', platform: 'win32' });
  assert.equal(code, 'errPayloadMissing');
  assert.match(message, /npm run payload/);
  assert.ok(message.includes('C:\\src\\app\\payload'), message);
});

test('an installed copy is told about antivirus, never about npm', () => {
  const { message } = missingPayload({ packaged: true, resourcesPath: 'C:\Program Files\DLSS 5 Swapper\resources', appRoot: 'x', platform: 'win32' });
  assert.doesNotMatch(message, /npm/, 'nobody who installed this has npm');
  assert.match(message, /antivirus/i);
  assert.match(message, /quarantine/i);
  assert.match(message, /No game files were changed/, 'and is told nothing was broken');
});

test('a portable copy is told to delete the folder it re-extracts into', () => {
  const { message } = missingPayload({
    packaged: true, portable: true, appRoot: 'x', platform: 'win32',
    resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\DLSS5-Swapper\\resources',
    temp: 'C:\\Users\\me\\AppData\\Local\\Temp'
  });
  assert.ok(message.includes('C:\\Users\\me\\AppData\\Local\\Temp\\DLSS5-Swapper'), message);
  assert.match(message, /delete/i);
  assert.match(message, /installer instead/, 'and offered the way out that does not re-extract');
  assert.doesNotMatch(message, /npm/);
});

test('without a temp path it still names the folder in a form a person can paste', () => {
  const { message } = missingPayload({ packaged: true, portable: true, appRoot: 'x', resourcesPath: 'y', platform: 'win32' });
  assert.ok(message.includes('%TEMP%\\DLSS5-Swapper'), message);
});

// Linux fork: nothing is bundled - the payload is fetched from the pinned
// upstream release on first run, so the advice is about that, never about
// antivirus, %TEMP% or npm.
test('on Linux it names the download, not antivirus or npm', () => {
  const { code, message } = missingPayload({ packaged: true, appRoot: 'x', resourcesPath: '/opt/app/resources',
    platform: 'linux', payloadDir: '/home/me/.config/DLSS 5 Swapper/payload' });
  assert.equal(code, 'errPayloadMissing');
  assert.ok(message.includes('/home/me/.config/DLSS 5 Swapper/payload'), message);
  assert.match(message, /SHA-256/);
  assert.match(message, /No game files were changed/);
  assert.doesNotMatch(message, /antivirus|%TEMP%|npm/i);
});

'use strict';

// The two RenoDX neural consumers this app installs, pinned by release URL and
// by digest exactly like the Feeder. Until now they had to be sitting beside
// the source tree with the right digest, because nobody published them as
// downloads; the RHI repository - the same one the Feeder's own installer
// pulls from - publishes both, so a build machine no longer needs a copy on
// its desktop. The local file is still accepted as a fallback.
//
// The generic build is what every route installs. The DLSS Tool build REPLACES
// it on the multipass route rather than joining it: two neural consumers in one
// game leave the tickbox saying yes while the picture says no.
//
// 8.5.0-rc10 redraws its page (one child window, "##value" widgets under their
// INI keys); the F8 bridge drives it by key - see overlay/renodx-ui-bridge.hpp.
// The rc channel is the one the project publishes on, and DLSS5-Feeder 1.17.0's
// own installer takes the newest build from the same feed.
const CONSUMER = Object.freeze({
  version: '8.5.0-rc10',
  file: 'renodx-dlss5.addon64',
  archive: Object.freeze(['renodx-dlss5_8.5.0-rc10.zip', 'https://github.com/RankFTW/rhi-repo/releases/download/renodx-dlss5-8.5.0-rc10/renodx-dlss5_8.5.0-rc10.zip', 'a745040cb2e93e3a1500a6c5a322972acc4c5c667108fcea31c748285d6364a9']),
  sha256: 'dcd93881e976ad033d83c2bb01f4bc3e4ddc59c15fe0dd4ca165bc5fc7d1ac68'
});
// ShortFuse's DLSS Tool build, carrying DirectNeuralRenderingPassCount (#251).
const MULTIPASS = Object.freeze({
  version: 'SF 26.0928.0205',
  file: 'renodx-dlss.addon64',
  archive: Object.freeze(['renodx-dlss_SF_26.0928.0205.zip', 'https://github.com/RankFTW/rhi-repo/releases/download/renodx-dlss-SF-26.0928.0205/renodx-dlss_SF_26.0928.0205.zip', '6091f47a2248854eb1779b2c3b97939f1fbe53adbae7d1642ada236fcc0b6f52']),
  sha256: '083c002027996af25db4d1d67ca98bb6772c5cc6f28b6ea3dbc506867a97f187'
});
// Every neural evaluate faults inside NVIDIA's own NGX runtime on driver
// 616.64 and newer with the 4.x consumers - measured upstream across three
// machines and reported as DLSS5-Feeder #54. The 6.x line passes the same
// self-test 300/300 on 617.14, so the warning belongs to the build rather than
// to the driver: it is raised only when the consumer being installed is one of
// these. Keyed by digest, because that is the only thing a build cannot lie
// about.
const FAULTING = Object.freeze({
  'd5adf82eb44b065f4c590ac91fe824bab07afea0eb9f994bde936710c8593952': '4.70',
  '9150097cdee2953cdc9894d2e5606ea5100e6c8f95fc7bb1b407328b4391a07a': '4.55',
  '87aef9ddd937c7241e6bf8d8efea0045d63559135e254c60dab316db3d3a4aee': '4.x'
});
module.exports = { CONSUMER, MULTIPASS, FAULTING, faults: (sha256) => Boolean(FAULTING[String(sha256).toLowerCase()]) };

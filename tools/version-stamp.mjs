// Stamp the current package.json version into index.html + sw.js so
// GitHub Pages users actually see updates when we cut a release.
//
// Two things change per release:
//   index.html — the css/js <link>/<script> hrefs gain a ?v=<version>
//                query string, so the browser cache + the service-worker
//                cache (which key by full URL) treat the new asset as a
//                first-time fetch and skip whatever they had cached.
//   sw.js      — CACHE name is bumped to "chained-timers-v<version>" so
//                the service worker's `activate` step deletes every
//                older cache from previous releases.
//
// Idempotent: running it again on an already-stamped tree is a no-op.
// Run via:
//   npm run version:stamp
//
// Add this to your release flow before committing the version bump,
// e.g. inside publishing/* or a future scripts.release npm hook.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
if (!VERSION) { console.error('no version in package.json'); process.exit(1); }

let changed = 0;

// --- index.html: ?v= on css/js hrefs ---------------------------------------
const HTML_PATH = path.join(ROOT, 'index.html');
const html      = fs.readFileSync(HTML_PATH, 'utf8');

// Match href/src that points at our local css/js, optionally already
// carrying a ?v=… that we'll strip-and-replace. External URLs (no
// leading "./") and other extensions (icons, manifest) are left alone.
function stampUrl(line, attr) {
  return line.replace(
    new RegExp(`(${attr}=")(\\.\\/(?:css|js)\\/[^"?]+)(?:\\?v=[^"]*)?(")`, 'g'),
    (_, head, url, tail) => `${head}${url}?v=${VERSION}${tail}`
  );
}
let nextHtml = html;
nextHtml = stampUrl(nextHtml, 'href');
nextHtml = stampUrl(nextHtml, 'src');
if (nextHtml !== html) {
  fs.writeFileSync(HTML_PATH, nextHtml);
  console.log(`✓ index.html stamped with ?v=${VERSION}`);
  changed++;
} else {
  console.log(`= index.html already up to date`);
}

// --- sw.js: bump cache name -------------------------------------------------
const SW_PATH = path.join(ROOT, 'sw.js');
const sw      = fs.readFileSync(SW_PATH, 'utf8');
const nextSw  = sw.replace(
  /const\s+CACHE\s*=\s*['"]chained-timers-v[^'"]+['"];?/,
  `const CACHE = 'chained-timers-v${VERSION}';`
);
if (nextSw === sw) {
  console.error('! could not find CACHE = "chained-timers-v…" in sw.js — check the regex');
  process.exit(1);
}
if (nextSw !== sw) {
  fs.writeFileSync(SW_PATH, nextSw);
  console.log(`✓ sw.js cache bumped to chained-timers-v${VERSION}`);
  changed++;
} else {
  console.log(`= sw.js already up to date`);
}

if (changed === 0) {
  console.log(`(nothing to do — already at v${VERSION})`);
}

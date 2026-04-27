// Copy the runtime files into ./dist so Capacitor can package them
// without dragging in node_modules, screenshots, tools, etc.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DIST = path.join(ROOT, 'dist');

const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const DIRS  = ['css', 'js', 'icons'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const f of FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
}
for (const d of DIRS) {
  fs.cpSync(path.join(ROOT, d), path.join(DIST, d), { recursive: true });
}

const size = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const ep = path.join(p, e.name);
    total += e.isDirectory() ? size(ep) : fs.statSync(ep).size;
  }
  return total;
};
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`✓ www built → ${DIST} (${kb(size(DIST))})`);

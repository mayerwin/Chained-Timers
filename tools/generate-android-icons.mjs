// Replace the default Capacitor launcher icons with our chain icon.
// Generates square + adaptive launcher icons for every Android density.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const SRC_SVG = path.join(ROOT, 'icons', 'icon.svg');
const FG_SVG  = path.join(ROOT, 'icons', 'icon-maskable.svg');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

try { await fs.access(RES); } catch {
  console.log('No android/ project — run `npx cap add android` first. Skipping.');
  process.exit(0);
}

// Square (legacy) launcher densities
const SQUARE = [
  { dir: 'mipmap-mdpi',     size: 48 },
  { dir: 'mipmap-hdpi',     size: 72 },
  { dir: 'mipmap-xhdpi',    size: 96 },
  { dir: 'mipmap-xxhdpi',   size: 144 },
  { dir: 'mipmap-xxxhdpi',  size: 192 },
];

// Adaptive (Android 8+) foreground — 432×432 with safe ~66% center zone
const FOREGROUND = [
  { dir: 'mipmap-mdpi',    size: 108 },
  { dir: 'mipmap-hdpi',    size: 162 },
  { dir: 'mipmap-xhdpi',   size: 216 },
  { dir: 'mipmap-xxhdpi',  size: 324 },
  { dir: 'mipmap-xxxhdpi', size: 432 },
];

const main = await fs.readFile(SRC_SVG);
const fg   = await fs.readFile(FG_SVG);

for (const { dir, size } of SQUARE) {
  const out = path.join(RES, dir);
  await fs.mkdir(out, { recursive: true });
  await sharp(main, { density: 384 }).resize(size, size).png().toFile(path.join(out, 'ic_launcher.png'));
  await sharp(main, { density: 384 }).resize(size, size).png().toFile(path.join(out, 'ic_launcher_round.png'));
}

for (const { dir, size } of FOREGROUND) {
  const out = path.join(RES, dir);
  await fs.mkdir(out, { recursive: true });
  await sharp(fg, { density: 384 }).resize(size, size).png().toFile(path.join(out, 'ic_launcher_foreground.png'));
}

// Adaptive icon background = solid warm-black
const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0E0D0B</color>
</resources>
`;
await fs.mkdir(path.join(RES, 'values'), { recursive: true });
await fs.writeFile(path.join(RES, 'values', 'ic_launcher_background.xml'), bgXml);

// Adaptive icon XML
const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
await fs.mkdir(path.join(RES, 'mipmap-anydpi-v26'), { recursive: true });
await fs.writeFile(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveXml);
await fs.writeFile(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptiveXml);

// Status-bar small icon for LocalNotifications (single-color silhouette is best,
// but for simplicity we use the square at xxhdpi; Android tints non-alpha pixels white)
for (const { dir, size } of [
  { dir: 'drawable-mdpi',    size: 24 },
  { dir: 'drawable-hdpi',    size: 36 },
  { dir: 'drawable-xhdpi',   size: 48 },
  { dir: 'drawable-xxhdpi',  size: 72 },
  { dir: 'drawable-xxxhdpi', size: 96 },
]) {
  const out = path.join(RES, dir);
  await fs.mkdir(out, { recursive: true });
  await sharp(fg, { density: 384 }).resize(size, size).png().toFile(path.join(out, 'ic_stat_icon.png'));
}

console.log('✓ Android launcher + status icons generated');

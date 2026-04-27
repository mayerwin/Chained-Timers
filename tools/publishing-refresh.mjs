// Copy the freshly-generated icons into publishing/{android,ios}/.
// Screenshots are written directly into those folders by store-screenshots.mjs,
// so this script just needs to handle the static brand assets.
import fs from 'node:fs/promises';
import path from 'node:path';

const COPIES = [
  ['icons/icon-512.png',                  'publishing/android/icon-512.png'],
  ['icons/feature-graphic-1024x500.png',  'publishing/android/feature-graphic-1024x500.png'],
  ['icons/icon-1024.png',                 'publishing/ios/icon-1024.png'],
];

for (const [src, dst] of COPIES) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  console.log(`✓ ${src} → ${dst}`);
}
console.log('\nReminder: run `npm run screenshots:store` (with dev server up) to refresh screenshots too.');

// Generate PNG variants of the SVG icons via Sharp.
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';

const ICON_DIR = path.resolve('icons');
const sourceMain = path.join(ICON_DIR, 'icon.svg');
const sourceMask = path.join(ICON_DIR, 'icon-maskable.svg');

const outputs = [
  { src: sourceMain, name: 'icon-192.png',          size: 192  },
  { src: sourceMain, name: 'icon-512.png',          size: 512  },
  { src: sourceMain, name: 'icon-1024.png',         size: 1024 }, // App Store master icon
  { src: sourceMain, name: 'apple-touch-icon.png',  size: 180  },
  { src: sourceMain, name: 'favicon-32.png',        size: 32   },
  { src: sourceMain, name: 'favicon-180.png',       size: 180  },
  { src: sourceMask, name: 'icon-maskable-192.png', size: 192  },
  { src: sourceMask, name: 'icon-maskable-512.png', size: 512  },
];

for (const { src, name, size } of outputs) {
  const svg = await fs.readFile(src);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 14, g: 13, b: 11, alpha: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(ICON_DIR, name));
  console.log(`✓ ${name} (${size}×${size})`);
}

// also create a tiny social-card 1200×630 OpenGraph image
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="22%" cy="55%" r="80%">
      <stop offset="0" stop-color="#F5B042" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#0E0D0B" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FBC061"/><stop offset="1" stop-color="#E29A2A"/>
    </linearGradient>
    <mask id="behind"><rect width="1200" height="630" fill="white"/>
      <g transform="translate(280 405) rotate(-12)"><circle r="116" fill="black"/></g>
    </mask>
  </defs>
  <rect width="1200" height="630" fill="#0E0D0B"/>
  <rect width="1200" height="630" fill="url(#g)"/>
  <!-- icon left -->
  <g transform="translate(280 235) rotate(-12)" mask="url(#behind)">
    <circle r="92" fill="none" stroke="url(#rg)" stroke-width="30"/>
  </g>
  <g transform="translate(280 235) rotate(-12)">
    <g stroke="#F5B042" stroke-width="9" stroke-linecap="round">
      <line x1="0" y1="-64" x2="0" y2="-46"/>
      <line x1="64" y1="0" x2="46" y2="0"/>
      <line x1="0" y1="64" x2="0" y2="46"/>
      <line x1="-64" y1="0" x2="-46" y2="0"/>
    </g>
    <circle r="9" fill="#F5B042"/>
  </g>
  <g transform="translate(280 405) rotate(-12)">
    <circle r="92" fill="none" stroke="url(#rg)" stroke-width="30"/>
  </g>
  <!-- text -->
  <g font-family="Anton, sans-serif" fill="#F2EDE2" letter-spacing="1">
    <text x="500" y="290" font-size="120" letter-spacing="2">CHAINED</text>
    <text x="500" y="410" font-size="120" fill="#F5B042" letter-spacing="2">TIMERS</text>
  </g>
  <g font-family="Georgia, serif" font-style="italic" fill="#A29C8F">
    <text x="500" y="465" font-size="28">The interval forge — sequence intervals into named chains.</text>
  </g>
  <g font-family="ui-monospace, SF Mono, monospace" fill="#5A5448" font-size="18">
    <text x="500" y="525" letter-spacing="3">PWA · OFFLINE · INSTALLABLE</text>
  </g>
</svg>`;

await sharp(Buffer.from(og), { density: 192 })
  .resize(1200, 630)
  .png()
  .toFile(path.join(ICON_DIR, 'social-card.png'));
console.log('✓ social-card.png (1200×630)');

// Play Store feature graphic — 1024×500, displayed at the top of the listing.
// Tighter aspect than the social card, so the icon sits left and the wordmark fills the right.
const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 500">
  <defs>
    <radialGradient id="g" cx="22%" cy="50%" r="80%">
      <stop offset="0" stop-color="#F5B042" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#0E0D0B" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FBC061"/><stop offset="1" stop-color="#E29A2A"/>
    </linearGradient>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F5B042"/><stop offset="1" stop-color="#9C6E22"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="500" fill="#0E0D0B"/>
  <rect width="1024" height="500" fill="url(#g)"/>
  <!-- icon: chain spine + 3 nodes, scaled-down version of icon.svg -->
  <g transform="translate(220 250)">
    <line x1="0" y1="-100" x2="0" y2="100" stroke="url(#lg)" stroke-width="5" stroke-linecap="round" opacity="0.55"/>
    <circle cx="0" cy="-110" r="11" fill="#F5B042"/>
    <circle r="80" fill="none" stroke="url(#rg)" stroke-width="24"/>
    <g stroke="#F5B042" stroke-width="8" stroke-linecap="round">
      <line x1="0" y1="-58" x2="0" y2="-44"/>
      <line x1="58" y1="0" x2="44" y2="0"/>
      <line x1="0" y1="58" x2="0" y2="44"/>
      <line x1="-58" y1="0" x2="-44" y2="0"/>
    </g>
    <circle r="64" fill="none" stroke="#F5B042" stroke-width="5" stroke-linecap="round" stroke-dasharray="282 402" stroke-dashoffset="120" transform="rotate(-90)" opacity="0.85"/>
    <circle r="8" fill="#F5B042"/>
    <circle cx="0" cy="110" r="11" fill="#F5B042"/>
  </g>
  <!-- wordmark + tagline -->
  <g font-family="Anton, sans-serif" fill="#F2EDE2">
    <text x="430" y="225" font-size="96" letter-spacing="2">CHAINED</text>
    <text x="430" y="320" font-size="96" fill="#F5B042" letter-spacing="2">TIMERS</text>
  </g>
  <g font-family="Georgia, serif" font-style="italic" fill="#A29C8F">
    <text x="430" y="372" font-size="22">The interval forge — sequence intervals into named chains.</text>
  </g>
  <g font-family="ui-monospace, SF Mono, monospace" fill="#5A5448" font-size="14">
    <text x="430" y="412" letter-spacing="3">SPORT · BREATH · COOKING · STUDY</text>
  </g>
</svg>`;

await sharp(Buffer.from(fg), { density: 192 })
  .resize(1024, 500)
  .png({ compressionLevel: 9 })
  .toFile(path.join(ICON_DIR, 'feature-graphic-1024x500.png'));
console.log('✓ feature-graphic-1024x500.png (1024×500)');

console.log('All icons generated.');

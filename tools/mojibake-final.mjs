// Final exhaustive mojibake check by exact codepoint sequence.
// Searches every text-source file for the EXACT three-char (or two-char)
// patterns that CP1252 doubly-encoded UTF-8 produces.

import fs from 'node:fs';

// Each entry is the exact codepoint sequence we'd see in the corrupted
// file, alongside the original it should have been.
const PATTERNS = [
  [String.fromCodePoint(0x00E2, 0x20AC, 0x201D), '—'],   // em-dash
  [String.fromCodePoint(0x00E2, 0x20AC, 0x201C), '"'],   // smart quote
  [String.fromCodePoint(0x00E2, 0x20AC, 0x0153), '"'],
  [String.fromCodePoint(0x00E2, 0x20AC, 0x00A6), '…'],
  [String.fromCodePoint(0x00E2, 0x20AC, 0x0098), '–'],
  [String.fromCodePoint(0x00E2, 0x20AC, 0x009C), '‚'],
  [String.fromCodePoint(0x00E2, 0x201E, 0x2013), '№'],
  [String.fromCodePoint(0x00E2, 0x2020, 0x2019), '→'],
  [String.fromCodePoint(0x00E2, 0x2020, 0x201D), '↔'],
  [String.fromCodePoint(0x00E2, 0x2020, 0x0090), '←'],
  [String.fromCodePoint(0x00E2, 0x0153, 0x201C), '✓'],
  [String.fromCodePoint(0x00E2, 0x0161, 0x00A0), '⚠'],
  [String.fromCodePoint(0x00E2, 0x02C6, 0x2019), '−'],
  [String.fromCodePoint(0x00E2, 0x20AC, 0x00A2), '•'],
  [String.fromCodePoint(0x00C2, 0x00B7), '·'],
  [String.fromCodePoint(0x00C2, 0x00A0), ' '],
  [String.fromCodePoint(0x00C3, 0x2014), '×'],
  [String.fromCodePoint(0x00C3, 0x00B7), '÷'],
  [String.fromCodePoint(0x00C3, 0x00A9), 'é'],
  [String.fromCodePoint(0x00C3, 0x00A8), 'è'],
  [String.fromCodePoint(0x00C3, 0x00A0), 'à'],
  [String.fromCodePoint(0xFFFD), 'REPLACEMENT'],
];

const FILES = [
  'js/app.js', 'js/native.js', 'index.html', 'css/styles.css',
  'android/app/src/main/java/com/mayerwin/chainedtimers/ChainTimerService.java',
  'android/app/src/main/java/com/mayerwin/chainedtimers/ChainTimerPlugin.java',
  'android/app/src/main/java/com/mayerwin/chainedtimers/MainActivity.java',
  'android/app/src/main/assets/public/js/app.js',
  'android/app/src/main/assets/public/js/native.js',
  'android/app/src/main/assets/public/index.html',
];

let total = 0;
for (const f of FILES) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { console.log('(skipped, missing)', f); continue; }
  const hits = [];
  for (const [pat, original] of PATTERNS) {
    let count = 0, idx = 0;
    while ((idx = s.indexOf(pat, idx)) !== -1) { count++; idx += pat.length; }
    if (count) hits.push(`${count}x "${pat}" (should be "${original}")`);
  }
  if (hits.length) {
    console.log('--- ' + f + ' ---');
    for (const h of hits) console.log('  ' + h);
    total += hits.length;
  }
}

if (total === 0) console.log('All files clean.');
console.log('TOTAL CORRUPTED SEQUENCES:', total);
process.exit(total ? 1 : 0);

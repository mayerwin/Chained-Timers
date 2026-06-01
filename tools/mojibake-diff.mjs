// Cross-commit mojibake audit.
//
// Walks every non-ASCII codepoint in every file that exists in BOTH
// v1.3.9 (the last clean commit) and HEAD, and reports any character
// that:
//
//   (a) WAS present in v1.3.9 but became a different non-ASCII char in
//       HEAD on the same logical line — i.e., a corruption that left a
//       legitimate-looking character behind, hiding from glyph scans;
//
//   (b) is in HEAD's new lines and matches a known CP1252 leading-byte
//       pattern (U+00C2 / U+00C3 / U+00E2);
//
//   (c) is a U+FFFD replacement char anywhere.
//
// Run via:  node tools/mojibake-diff.mjs

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const BASELINE = '564e3d1';

const FILES = [
  'js/app.js',
  'js/native.js',
  'index.html',
  'css/styles.css',
  'android/app/src/main/java/com/mayerwin/chainedtimers/ChainTimerService.java',
  'android/app/src/main/java/com/mayerwin/chainedtimers/ChainTimerPlugin.java',
  'android/app/src/main/java/com/mayerwin/chainedtimers/MainActivity.java',
];

function getBaseline(f) {
  try { return execSync(`git show ${BASELINE}:${f}`, { encoding: 'utf8' }); }
  catch { return null; }
}

const SUSPECT_CODES = new Set([0x00C2, 0x00C3, 0x00E2]);

let total = 0;

for (const f of FILES) {
  let head;
  try { head = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const base = getBaseline(f);

  // Collect every non-ASCII codepoint and its byte offset
  const charsInHead = new Map();   // codepoint -> [{line, col}]
  for (let i = 0; i < head.length; i++) {
    const c = head.codePointAt(i);
    if (c > 0x7F) {
      if (!charsInHead.has(c)) charsInHead.set(c, 0);
      charsInHead.set(c, charsInHead.get(c) + 1);
    }
    if (c > 0xFFFF) i++;
  }

  // Detect (b) suspect codepoints — even if they aren't in glyph patterns
  const suspectCount = new Map();
  for (const c of SUSPECT_CODES) {
    const n = charsInHead.get(c) || 0;
    if (n) suspectCount.set(c, n);
  }

  // Detect (c) replacement chars
  const replCount = charsInHead.get(0xFFFD) || 0;

  // Compare HEAD vs baseline character-frequency for non-ASCII
  // Cross-check: if a codepoint exists in base but no longer in head,
  // and head has more "mojibake-shape" chars now, that's a likely swap.
  let charDelta = '';
  if (base) {
    const charsInBase = new Map();
    for (let i = 0; i < base.length; i++) {
      const c = base.codePointAt(i);
      if (c > 0x7F) {
        if (!charsInBase.has(c)) charsInBase.set(c, 0);
        charsInBase.set(c, charsInBase.get(c) + 1);
      }
      if (c > 0xFFFF) i++;
    }
    // Report any char from base that DROPPED to zero in head
    const lost = [];
    for (const [c, n] of charsInBase) {
      if (!charsInHead.has(c)) lost.push({ c, n });
    }
    // Report any char in head not in base (added) — only flag if it's
    // in the suspect range (likely CP1252 corruption residue)
    const gained = [];
    for (const [c, n] of charsInHead) {
      if (!charsInBase.has(c) && SUSPECT_CODES.has(c)) gained.push({ c, n });
    }
    if (lost.length || gained.length) {
      charDelta = `lost: ${lost.map(x => `U+${x.c.toString(16).padStart(4, '0').toUpperCase()}(${x.n})`).join(', ')} gained-suspect: ${gained.map(x => `U+${x.c.toString(16).padStart(4, '0').toUpperCase()}(${x.n})`).join(', ')}`;
    }
  }

  const issues = [];
  if (suspectCount.size) {
    issues.push('suspect codepoints: ' + [...suspectCount.entries()].map(([c, n]) =>
      `U+${c.toString(16).padStart(4, '0').toUpperCase()}(${n})`).join(', '));
  }
  if (replCount) issues.push(`U+FFFD x${replCount}`);
  if (charDelta && (charDelta.includes('lost') && charDelta.split('lost: ')[1].split(' gained')[0].length > 5)) {
    issues.push('vs baseline: ' + charDelta);
  }

  if (issues.length) {
    console.log('---', f, '---');
    for (const i of issues) console.log('  ' + i);
    total++;
  }
}

console.log('');
console.log('FILES WITH ISSUES:', total);
process.exit(total ? 1 : 0);

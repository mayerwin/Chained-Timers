// Two-pass scanner:
//
//  Pass 1 — known glyph patterns ("â€"", "â„–", "Â·", "Ã©", "↔" mojibake
//           sequences, etc.). Catches the obvious case where a CP1252
//           interpretation of UTF-8 bytes got re-emitted as UTF-8.
//
//  Pass 2 — codepoint-level audit. Flags every character in the
//           "CP1252 leading-byte" range (U+00C2 / U+00C3 / U+00E2) that
//           isn't part of a legitimate human-readable use, plus stray
//           U+FFFD replacement chars, plus mid-file BOMs.
//
// Run via:  node tools/mojibake-scan.mjs

import fs from 'node:fs';
import path from 'node:path';

const MOJI_GLYPHS = [
  'â€', 'â„', 'â†', 'âœ', 'âš', 'âˆ', 'â–', 'â—', 'â‚',
  'Â·', 'Â°', 'Â«', 'Â»', 'Â§', 'Â¬', 'Â£', 'Â©', 'Â®', 'Â¶',
  'Ã—', 'Ã·', 'Ã©', 'Ã¨', 'Ã¢', 'Ã®', 'Ã´', 'Ã ', 'Ã§', 'Ã¬', 'Ã¯',
  'Ã¹', 'Ã»', 'Ã¦', 'Ã±', 'Ã«',
  '�',  // replacement char
];

const EXTS = new Set(['.js', '.mjs', '.html', '.css', '.java', '.txt', '.md', '.json', '.xml', '.ps1', '.bat', '.sh', '.gradle']);
const IGNORE_DIRS = [
  'node_modules', '.git', 'dist',
  path.join('android', 'app', 'build'),
  path.join('android', 'build'),
  path.join('android', '.gradle'),
  path.join('android', 'capacitor-cordova-android-plugins', 'build'),
];

const SKIP_PATHS = new Set([
  path.join('tools', 'mojibake-scan.mjs'),
  path.join('android', 'app', 'src', 'main', 'play', 'release-notes', 'en-US', 'default.txt'),
  path.join('android', 'app', 'src', 'main', 'assets', 'public', 'js', 'app.js'),
  path.join('android', 'app', 'src', 'main', 'assets', 'public', 'js', 'native.js'),
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative('.', full);
    if (IGNORE_DIRS.some(ig => rel === ig || rel.startsWith(ig + path.sep))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry.name).toLowerCase())) out.push(rel);
  }
  return out;
}

function lineAt(s, idx) {
  return s.slice(0, idx).split('\n').length;
}

function scanGlyphs(s) {
  const out = [];
  for (const g of MOJI_GLYPHS) {
    let idx = 0;
    while ((idx = s.indexOf(g, idx)) !== -1) {
      out.push({ kind: 'glyph', line: lineAt(s, idx), pat: g });
      idx += g.length;
    }
  }
  return out;
}

// Suspect characters: CP1252 leading-byte equivalents. Whitelisted are
// the ones we deliberately emit (e.g. accented chars in legitimate French
// templates) — but if any of those appear AFTER the file's preamble in a
// context that's not a string literal containing French text, that's
// suspicious too. For this codebase we treat U+00C2 / U+00C3 / U+00E2
// in isolation (not as part of a legitimate accented char) as suspect.
//
// Rule of thumb: a real "â" (U+00E2) in source belongs in a French word
// like "Brûlé" → 0xC3 0xBB is "û", not "â". Our app has no French words
// containing "â" so any U+00E2 is suspect. Same logic for U+00C2 / U+00C3.
const SUSPECT_CODES = new Set([0x00C2, 0x00C3, 0x00E2]);

function scanSuspectCodes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (SUSPECT_CODES.has(c)) {
      out.push({ kind: 'suspect', line: lineAt(s, i), pat: String.fromCharCode(c) });
    }
    // Mid-file BOM (U+FEFF at any position other than 0)
    if (c === 0xFEFF && i > 0) {
      out.push({ kind: 'mid-BOM', line: lineAt(s, i), pat: 'U+FEFF' });
    }
  }
  return out;
}

const targets = walk('.');
let totalFindings = 0;
for (const f of targets) {
  if (SKIP_PATHS.has(f)) continue;
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const findings = [...scanGlyphs(s), ...scanSuspectCodes(s)];
  if (findings.length === 0) continue;
  console.log('---', f, '---');
  const lines = s.split('\n');
  for (const fd of findings.slice(0, 30)) {
    const text = (lines[fd.line - 1] || '').slice(0, 110);
    console.log(`  ${fd.line} [${fd.kind}] ${JSON.stringify(fd.pat)} | ${text}`);
  }
  if (findings.length > 30) console.log('  ... (' + (findings.length - 30) + ' more)');
  totalFindings += findings.length;
}

console.log('');
console.log('FILES SCANNED:', targets.length);
console.log('TOTAL FINDINGS:', totalFindings);
process.exit(totalFindings ? 1 : 0);

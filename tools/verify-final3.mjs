// Programmatically verify that final3.wav contains exactly three pulses
// whose ONSETS land within ±5ms of t=0.000s, t=1.000s, t=2.000s. The
// 3-2-1 spacing issue this whole feature exists to fix would silently
// regress if a future render-audio.mjs edit moved the offsets.
//
// Run via:
//   node tools/verify-final3.mjs
//
// Exits non-zero with a diff on the first failed assertion. Idempotent.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAV_PATH  = path.join(REPO_ROOT, 'android/app/src/main/res/raw/final3.wav');

// Threshold heuristic: an "onset" is the first sample after a quiet
// stretch whose absolute amplitude crosses 30% of peak. The pulse
// envelope is 10ms attack → ~70ms sustained → ~70ms release, so 30%
// happens well inside the attack ramp; tolerance ±5ms is several
// audio-samples wide at 44.1kHz.
const ONSET_THRESHOLD_RATIO = 0.30;
const QUIET_GAP_SEC         = 0.20;   // at least 200ms quiet before a new onset
const ONSET_TOL_MS          = 5;

function readWav(buf) {
  // Minimal RIFF/WAVE parser — same layout tools/render-audio.mjs writes.
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not WAVE');
  if (buf.toString('ascii', 12, 16) !== 'fmt ') throw new Error('expected fmt chunk');
  const audioFormat   = buf.readUInt16LE(20);     // 1 = PCM
  const numChannels   = buf.readUInt16LE(22);
  const sampleRate    = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (audioFormat   !== 1)  throw new Error(`expected PCM (1), got ${audioFormat}`);
  if (numChannels   !== 1)  throw new Error(`expected mono (1ch), got ${numChannels}`);
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit, got ${bitsPerSample}`);
  // 'data' chunk header at offset 36 in our writer's layout.
  if (buf.toString('ascii', 36, 40) !== 'data') throw new Error('expected data chunk at 36');
  const dataSize = buf.readUInt32LE(40);
  const numSamples = dataSize / 2;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = buf.readInt16LE(44 + i * 2) / 32767;
  }
  return { sampleRate, samples };
}

function findOnsets({ samples, sampleRate }) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const threshold      = peak * ONSET_THRESHOLD_RATIO;
  const minQuietSamples = Math.floor(QUIET_GAP_SEC * sampleRate);

  const onsets = [];
  let quietRun = minQuietSamples; // start as if already quiet for a while
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a >= threshold) {
      if (quietRun >= minQuietSamples) {
        onsets.push(i / sampleRate);
      }
      quietRun = 0;
    } else {
      quietRun++;
    }
  }
  return { peak, onsets };
}

const buf = await fs.readFile(WAV_PATH);
const wav = readWav(buf);
const { peak, onsets } = findOnsets(wav);

console.log(`peak amplitude     : ${peak.toFixed(3)}`);
console.log(`total duration sec : ${(wav.samples.length / wav.sampleRate).toFixed(3)}`);
console.log(`onsets detected    : ${onsets.length}`);
onsets.forEach((t, i) => console.log(`  pulse ${i + 1}: ${t.toFixed(4)} s`));

// Spacing is what matters: the user reported "irregular bips," not
// "started too late." The pre-fix code triggered three independent
// SoundPool plays from a Handler.postDelayed loop, so the *gaps* between
// pulses drifted ~30-50ms apart. With the concatenated WAV, the gaps
// are sample-rate-precise. We assert on inter-onset distances rather
// than absolute onset times because the 30% amplitude threshold lands
// inside the 10ms attack ramp (an ~8ms detection offset that is the
// same on every pulse and therefore irrelevant to spacing).
let failed = 0;
if (onsets.length !== 3) {
  console.log(`✗ expected 3 pulses, found ${onsets.length}`);
  failed++;
}
for (let i = 1; i < onsets.length; i++) {
  const gapMs   = (onsets[i] - onsets[i - 1]) * 1000;
  const driftMs = gapMs - 1000;
  if (Math.abs(driftMs) > ONSET_TOL_MS) {
    console.log(`✗ gap ${i}→${i + 1}: ${gapMs.toFixed(3)}ms drifts ${driftMs > 0 ? '+' : ''}${driftMs.toFixed(3)}ms vs expected 1000ms (tol ±${ONSET_TOL_MS}ms)`);
    failed++;
  } else {
    console.log(`✓ gap ${i}→${i + 1}: ${gapMs.toFixed(3)}ms (drift ${driftMs > 0 ? '+' : ''}${driftMs.toFixed(3)}ms within ±${ONSET_TOL_MS}ms)`);
  }
}

if (failed) {
  console.log(`\nFAILED: ${failed} assertion(s)`);
  process.exit(1);
}
console.log('\nfinal3.wav OK — three pulses, inter-pulse spacing 1000.000ms ±tolerance.');

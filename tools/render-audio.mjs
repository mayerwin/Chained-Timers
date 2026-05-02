// Render the in-app Audio.chime / Audio.finale tones to WAV files that the
// Android notification channels can play. Keeping the source of truth in
// js/app.js and re-rendering here means a chain transition or chain end
// makes the same sound whether the cue comes from Web Audio (foreground)
// or from the notification channel (background).
//
// Output:
//   android/app/src/main/res/raw/chime.wav   — segment-boundary chime
//   android/app/src/main/res/raw/finale.wav  — chain-complete finale
//
// Run via:
//   node tools/render-audio.mjs
//
// build-www.mjs / cap sync don't depend on it; run it once after editing
// Audio.chime / Audio.finale in js/app.js, then commit the WAVs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE      = 44100;
const BITS_PER_SAMPLE  = 16;
const NUM_CHANNELS     = 1;
const REPO_ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR          = path.join(REPO_ROOT, 'android/app/src/main/res/raw');

// Render a single Audio.beep() into the buffer at startSec.
//
// Mirrors js/app.js Audio.beep:
//   const t = ctx.currentTime;
//   osc.type = type;
//   osc.frequency.setValueAtTime(freq, t);
//   if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + duration);
//   g.gain.setValueAtTime(0.0001, t);
//   g.gain.exponentialRampToValueAtTime(volume, t + 0.01);
//   g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
function renderBeep(samples, startSec, { freq, duration, volume, glide = null, type = 'sine' }) {
  const startSample      = Math.floor(startSec * SAMPLE_RATE);
  const attackEndSample  = startSample + Math.floor(0.01 * SAMPLE_RATE);
  const releaseEndSample = startSample + Math.floor(duration * SAMPLE_RATE);
  const tailEndSample    = startSample + Math.floor((duration + 0.05) * SAMPLE_RATE);
  const limit            = Math.min(tailEndSample, samples.length);

  // Phase accumulator integrates the (glided) instantaneous frequency so
  // the sine wave stays continuous across the glide rather than warping.
  let phase = 0;
  const dt  = 1 / SAMPLE_RATE;

  for (let i = startSample; i < limit; i++) {
    const tInBeep = (i - startSample) * dt;

    // Envelope — exponential, mirroring Web Audio's exponentialRampToValueAtTime.
    let gain;
    if (i < attackEndSample) {
      const u = (i - startSample) / Math.max(1, attackEndSample - startSample);
      gain = 0.0001 * Math.pow(volume / 0.0001, u);
    } else if (i < releaseEndSample) {
      const u = (i - attackEndSample) / Math.max(1, releaseEndSample - attackEndSample);
      gain = volume * Math.pow(0.0001 / volume, u);
    } else {
      gain = 0.0001;
    }

    // Instantaneous frequency — glide is exponential too in Web Audio.
    let f = freq;
    if (glide !== null) {
      const u = Math.min(1, tInBeep / duration);
      f = freq * Math.pow(glide / freq, u);
    }
    phase += 2 * Math.PI * f * dt;

    let s;
    if      (type === 'sine')   s = Math.sin(phase);
    else if (type === 'square') s = Math.sin(phase) >= 0 ? 1 : -1;
    else                        s = Math.sin(phase);

    samples[i] += s * gain;
  }
}

// Audio.chime — A5 sine then C#6 sine, 120ms apart.
function renderChime() {
  const totalSec = 0.55;
  const samples  = new Float32Array(Math.ceil(totalSec * SAMPLE_RATE));
  renderBeep(samples, 0.00,  { freq: 880,  duration: 0.18, volume: 0.22, type: 'sine' });
  renderBeep(samples, 0.12,  { freq: 1320, duration: 0.28, volume: 0.22, type: 'sine' });
  return samples;
}

// Audio.finale — C5, E5, G5, C6 ascending arpeggio, 120ms apart.
function renderFinale() {
  const totalSec = 0.95;
  const samples  = new Float32Array(Math.ceil(totalSec * SAMPLE_RATE));
  renderBeep(samples, 0.00, { freq: 523,  duration: 0.16, volume: 0.22, type: 'sine' });
  renderBeep(samples, 0.12, { freq: 659,  duration: 0.16, volume: 0.22, type: 'sine' });
  renderBeep(samples, 0.24, { freq: 784,  duration: 0.16, volume: 0.22, type: 'sine' });
  renderBeep(samples, 0.36, { freq: 1047, duration: 0.42, volume: 0.24, type: 'sine' });
  return samples;
}

// Audio.tick — 660 Hz square pulse, 80ms. Played by the JS engine on
// each of the last 3 seconds of every segment. The Android service
// plays this same waveform via SoundPool while the WebView is asleep
// (notification-channel sounds would re-post the notification every
// second and look terrible).
function renderTick() {
  const totalSec = 0.18;
  const samples  = new Float32Array(Math.ceil(totalSec * SAMPLE_RATE));
  renderBeep(samples, 0.00, { freq: 660, duration: 0.08, volume: 0.18, type: 'square' });
  return samples;
}

// Peak-normalize so the WAV is loud enough to compete with the system
// notification sound at typical Notification-stream volume. The in-app
// gain values (0.22–0.24) are too quiet on their own — we'd lose them
// under the system sound. The character of the wave (timbre, envelope,
// pitch) is preserved; only overall amplitude scales.
function normalize(samples, peak = 0.92) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > max) max = a;
  }
  if (max < 1e-6) return;
  const scale = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
}

function wavHeader(numSamples) {
  const byteRate   = SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE / 8;
  const blockAlign = NUM_CHANNELS * BITS_PER_SAMPLE / 8;
  const dataSize   = numSamples * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);                   // fmt chunk size
  buf.writeUInt16LE(1, 20);                    // PCM
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function writeWav(samples, filePath) {
  const numSamples = samples.length;
  const data = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  await fs.writeFile(filePath, Buffer.concat([wavHeader(numSamples), data]));
  const sizeKb = (44 + data.length) / 1024;
  console.log(`✓ ${path.relative(REPO_ROOT, filePath)} (${sizeKb.toFixed(1)} KB)`);
}

await fs.mkdir(RAW_DIR, { recursive: true });

const chime = renderChime();
normalize(chime);
await writeWav(chime, path.join(RAW_DIR, 'chime.wav'));

const finale = renderFinale();
normalize(finale);
await writeWav(finale, path.join(RAW_DIR, 'finale.wav'));

const tick = renderTick();
normalize(tick);
await writeWav(tick, path.join(RAW_DIR, 'tick.wav'));

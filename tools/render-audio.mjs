// Render the in-app Audio.chime / Audio.finale / Audio.finalThree tones to
// WAV files that the Android notification channels can play. Keeping the
// source of truth in js/app.js and re-rendering here means a chain
// transition, chain end, or 3-2-1 countdown makes the same sound whether
// the cue comes from Web Audio (foreground) or from the notification
// channel (background).
//
// Output:
//   android/app/src/main/res/raw/chime.wav   — segment-boundary chime
//   android/app/src/main/res/raw/finale.wav  — chain-complete finale
//   android/app/src/main/res/raw/final3.wav  — concatenated 3-2-1 ticks
//                                              (three 660Hz pulses at
//                                              exact 1-second offsets)
//
// Why final3.wav and not three tick.wav plays:
//   v1.3.2 played tick.wav three times via SoundPool at 1s intervals
//   triggered from the FGS service's per-tick handler. Wall-clock jitter
//   (Handler.postDelayed drift, SoundPool's audio thread queueing,
//   Android's per-call latency) produced AUDIBLY IRREGULAR spacing — not
//   a metronome 1.000s apart but something like 0.97s / 1.03s / 0.98s.
//   Concatenating the three pulses into ONE pre-rendered WAV moves the
//   timing guarantee out of the JS/Java tick loop and into the OS audio
//   thread, which plays back at the WAV's sample-rate precision. Same
//   reasoning applies to Web Audio: one start() with three scheduled
//   oscillators beats three separate calls 1s apart, because the Web
//   Audio scheduler also runs on the audio thread.
//
// Run via:
//   node tools/render-audio.mjs
//
// build-www.mjs / cap sync don't depend on it; run it once after editing
// Audio.chime / Audio.finale / Audio.finalThree in js/app.js, then
// commit the WAVs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE      = 44100;
const BITS_PER_SAMPLE  = 16;
const NUM_CHANNELS     = 1;
const REPO_ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Android: Gradle picks WAVs up from res/raw automatically. The service
// references them as R.raw.chime / R.raw.finale / R.raw.final3.
const ANDROID_RAW_DIR  = path.join(REPO_ROOT, 'android/app/src/main/res/raw');
// iOS: the @capacitor/local-notifications plugin looks for `sound:` files
// in the app bundle. We mirror the same WAVs into ios/App/App/ so a
// `cap:sync ios` + Xcode "Add Files to App" step makes the per-segment
// chime / finale sound match what Android plays. (`final3` isn't used on
// iOS — there's no equivalent of the FGS for in-background playback;
// the WebView's Audio.finalThree covers the foreground case and that's
// all iOS gets.)
const IOS_APP_DIR      = path.join(REPO_ROOT, 'ios/App/App');

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

// Audio.finalThree — three 660 Hz square pulses at exact 1-second offsets,
// 0.0 / 1.0 / 2.0. Pre-rendered so the FGS service can fire it as a single
// SoundPool play when remaining time first drops into the last-3s window,
// instead of triggering tick.wav three times from the per-second tick
// handler (which produced audibly irregular spacing — Handler/audio-thread
// jitter compounded across three calls). Total length ~3.18s so the final
// pulse's release tail isn't clipped.
function renderFinalThree() {
  const totalSec = 3.18;
  const samples  = new Float32Array(Math.ceil(totalSec * SAMPLE_RATE));
  renderBeep(samples, 0.00, { freq: 660, duration: 0.08, volume: 0.18, type: 'square' });
  renderBeep(samples, 1.00, { freq: 660, duration: 0.08, volume: 0.18, type: 'square' });
  renderBeep(samples, 2.00, { freq: 660, duration: 0.08, volume: 0.18, type: 'square' });
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

await fs.mkdir(ANDROID_RAW_DIR, { recursive: true });

// Mirror WAVs into ios/App/App/ when the iOS Capacitor project exists.
// On iOS the WAVs still need to be added to the Xcode project's "Copy
// Bundle Resources" build phase manually after `cap:add:ios` — Xcode
// doesn't auto-discover loose files in the app folder. PUBLISHING.md
// documents the one-time Xcode step.
async function pathExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}
const includeIos = await pathExists(IOS_APP_DIR);

async function writeAll(samples, name) {
  await writeWav(samples, path.join(ANDROID_RAW_DIR, name));
  if (includeIos) await writeWav(samples, path.join(IOS_APP_DIR, name));
}

const chime = renderChime();
normalize(chime);
await writeAll(chime, 'chime.wav');

const finale = renderFinale();
normalize(finale);
await writeAll(finale, 'finale.wav');

// Concatenated 3-2-1 ticks: peak-normalized at the same level as the
// per-pulse beep so loudness matches what the legacy tick.wav playback
// produced. Three 660Hz pulses pre-mixed at exact 1-second offsets in
// one ~3.18s WAV — replaces the v1.3.2-era tick.wav that the FGS used
// to fire three times per segment (which produced audibly irregular
// spacing under Handler / SoundPool jitter).
const final3 = renderFinalThree();
normalize(final3);
await writeAll(final3, 'final3.wav');

if (!includeIos) {
  console.log(`(ios/ not present — skipped iOS bundle copies; run again after \`npx cap add ios\`)`);
}

// Tiny WebAudio synth. The context is created lazily on the first call, which
// is whichever comes first of the music starting (the frame loop, once the
// board is up) and a sound playing (a click handler). Only the second is a
// gesture, so autoplay policy is satisfied by STICKY activation — the page has
// been interacted with by then, since the board is only reachable through the
// menu. ac() also resumes a suspended context, and pump() calls it every 200ms
// while the music flows, which is what brings the audio back after a stall.
// Every call is try/caught so a missing or blocked AudioContext (headless test
// runs) degrades to silence rather than an exception.
let AC: AudioContext | null = null;

// Mute is a preference, not run state: New game does not clear it and a reload
// restores it, which is why it is its own key rather than part of the saved run.
// Read through the same try/catch localStorage discipline game.ts uses.
import { cell, put } from "./store";
const S_MUTE = 5;
export let muted = false;
muted = cell[S_MUTE] === 1;

export function setMuted(v: boolean): void {
  muted = v;
  put(S_MUTE, v ? 1 : 0);
}

export function ac(): AudioContext {
  // No webkitAudioContext fallback: unprefixed AudioContext landed in Safari
  // 14.1, the same release that shipped flexbox gap — and the HUD, the
  // cauldron and the overlay buttons are all flex rows with a gap, so a
  // browser old enough to need the prefix cannot lay this game out anyway.
  if (!AC) AC = new AudioContext();
  if (AC.state === "suspended") AC.resume();
  return AC;
}

function tone(
  f: number, at: number, dur: number,
  type: OscillatorType = "square", vol = 0.12, slide = 0,
): void {
  if (muted) return;
  try {
    const c = ac(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch {}
}

/* ---------------------------------------- the fireworks, DIRECTOR'S CUT ONLY */
// One burst per shell, fired from fireworks() in game.ts at the exact frame the
// sparks are pushed, so what you hear is what is on the screen:
//   - the PAN is the shell's own x across the width, so a burst on the left is
//     heard on the left;
//   - the CRACKLE is pitched by the shell's own hue, the same number that drew
//     the sparks — warm shells report low and dull, cold ones bright;
//   - the TAIL runs about as long as a spark lives (1.1-1.9s), so the last
//     pop lands as the last ember goes out.
// There is deliberately NO launch whistle: nothing rises on screen. The shells
// simply appear, and a sound for a thing that is not drawn is a lie.
//
// A FUNCTION, NOT A MEMBER OF SFX. A property on that object literal is
// reachable — the object escapes — so closure could not drop it and every byte
// of this would ship inside the 13312-byte build. As a bare declaration whose
// only call sits behind __DIRECTOR__, ADVANCED deletes the lot.
//
// The two buffers are built once and reused: a dense one for the report, and a
// SPARSE one for the crackle. That sparseness is the whole trick — a crackle is
// not noise, it is a few hundred separate little reports, and a dense buffer
// with a decay on it sounds like escaping steam instead.
let REPORT: AudioBuffer | null = null, CRACKLE: AudioBuffer | null = null;
function fwBuffers(c: AudioContext): void {
  if (REPORT) return;
  const sr = c.sampleRate;
  REPORT = c.createBuffer(1, (sr * 0.8) | 0, sr);
  const r = REPORT.getChannelData(0);
  for (let i = 0; i < r.length; i++) r[i] = Math.random() * 2 - 1;
  CRACKLE = c.createBuffer(1, (sr * 1.6) | 0, sr);
  const k = CRACKLE.getChannelData(0);
  for (let i = 0; i < k.length; i++) k[i] = Math.random() < 0.004 ? Math.random() * 2 - 1 : 0;
}

export function burst(pan: number, hue: number): void {
  if (muted) return;
  // style.css hides #fw outright under prefers-reduced-motion, because a trail
  // system held still is a blank canvas. Thirteen explosions over a blank veil
  // is worse than silence, so the sound follows the picture out.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const c = ac();
    fwBuffers(c);
    const t = c.currentTime;
    // Shells overlap three or four deep at this cadence and the fanfare is
    // already playing, so the whole burst goes through one modest master gain
    // rather than being balanced voice by voice.
    const m = c.createGain(), p = c.createStereoPanner();
    m.gain.value = 0.15;
    p.pan.value = pan;
    m.connect(p).connect(c.destination);

    // the thump: a sine dropping out of hearing, which is the part you feel
    const o = c.createOscillator(), og = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    og.gain.setValueAtTime(0.55, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(og).connect(m);
    o.start(t);
    o.stop(t + 0.5);

    // the report: noise band-passed at the shell's own colour
    const n = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain();
    n.buffer = REPORT;
    nf.type = "bandpass";
    nf.frequency.value = 400 + hue * 4;   // 400 Hz at red, 1840 at the far end
    nf.Q.value = 0.7;
    ng.gain.setValueAtTime(0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(nf).connect(ng).connect(m);
    n.start(t);

    // the tail: the sparse buffer, high-passed so it sits above the report
    const k = c.createBufferSource(), kf = c.createBiquadFilter(), kg = c.createGain();
    k.buffer = CRACKLE;
    kf.type = "highpass";
    kf.frequency.value = 1200 + hue * 6;
    kg.gain.setValueAtTime(0, t);
    kg.gain.linearRampToValueAtTime(0.5, t + 0.06);
    kg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
    k.connect(kf).connect(kg).connect(m);
    k.start(t);
  } catch {}
}

export const SFX = {
  select() { tone(660, 0, 0.07, "square", 0.07); },
  cancel() { tone(430, 0, 0.06, "square", 0.05); },
  fail()   { tone(190, 0, 0.22, "sawtooth", 0.09, -120); },
  dupe()   { tone(520, 0, 0.09, "sine", 0.08); },
  hint()   { tone(587, 0, 0.08, "triangle", 0.08); tone(880, 0.07, 0.13, "triangle", 0.08); },
  discover() { [523, 659, 784, 1047].map((f, i) => tone(f, i * 0.07, 0.16, "triangle", 0.11)); },
  fanfare()  { [523, 659, 784, 1047, 1319].map((f, i) => tone(f, i * 0.1, 0.32, "triangle", 0.12)); tone(262, 0, 0.9, "sine", 0.07); },
  grand()    { [392, 523, 659, 784, 1047, 1319, 1568].map((f, i) => tone(f, i * 0.09, 0.36, "triangle", 0.12)); tone(196, 0, 1.1, "sine", 0.07); },
};

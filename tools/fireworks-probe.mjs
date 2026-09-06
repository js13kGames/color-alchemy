// Does the fireworks burst actually match the fireworks?
//
// check.mjs proves burst() does not THROW — the suite drives a quest and a full
// clear, so it fires a dozen times — and that is all it proves. The claim
// src/sfx.ts makes is stronger and entirely unchecked by it: that what you hear
// is placed and pitched by what you see.
//
//   pan  = the shell's own x across the width
//   band = 400 + hue * 4 Hz, crackle = 1200 + hue * 6, off the SAME hue the
//          sparks are drawn in
//
// NO TEST HOOK, and none is needed. The cut is minified and terser inlines
// burst() into its one caller, so this finds fireworks() by the only API in the
// game that calls getContext("2d") and runs the real thing. The mappings are
// then checked WITHOUT knowing what the shell picked, which is what makes the
// assertions honest:
//
//   - x is drawn in 0.16..0.84 of the width, so pan must land in -0.68..0.68
//     and never at an extreme. A pan of exactly -1 or 1 would mean the pan had
//     stopped following x.
//   - hue recovered from the bandpass must predict the highpass exactly. Two
//     filters agreeing on a number neither of them stores is the whole claim:
//     one hue drew the sparks and pitched the sound.
//
// It also checks the buffers, because that is the difference between a firework
// and a kettle: the crackle must be SPARSE — a few hundred separate reports —
// where the report is dense. Filling both densely would still play, still pass
// check.mjs, and sound like escaping steam.
//
// DIRECTOR'S CUT ONLY, and this says so rather than passing vacuously: there is
// no burst in a shipping build, by design.
// usage: node tools/fireworks-probe.mjs   (npm run fireworks-check)
import { readFileSync } from "fs";
import { launch, check } from "../cdp.mjs";

// The cut ships mangled, so the name is whatever terser chose this build. The
// canvas is the ONE in the game (src/dom.d.ts says so), which makes its context
// call a unique fingerprint for the function that owns it.
const page = readFileSync("dist/director.html", "utf8");
const at = page.indexOf('getContext("2d")');
const decl = at < 0 ? -1 : page.lastIndexOf("function ", at);
const NAME = decl < 0 ? null : (page.slice(decl + 9).match(/^[A-Za-z_$][\w$]*/) || [])[0];
if (!NAME) {
  console.error("no fireworks() in dist/director.html — run `npm run build-director` first");
  process.exit(1);
}

const t = await launch({ url: "dist/director.html" });
await t.send("Page.enable");
await t.send("Page.addScriptToEvaluateOnNewDocument", {
  // Scoped inside an arrow for the reason music-probe.mjs documents: a bare
  // top-level const here collides with the bundle's own short names.
  // Each burst opens with a panner, so a panner starts a new record; the slot
  // is captured SYNCHRONOUSLY and the microtask writes into that one, or a
  // burst landing mid-flush would file its filters under its successor.
  source: `(() => {
    window.__fw = [];
    const P = (window.AudioContext || window.webkitAudioContext).prototype;
    const mkPan = P.createStereoPanner, mkSrc = P.createBufferSource,
          mkFil = P.createBiquadFilter;
    let shot = { filters: [], buffers: [] };
    P.createStereoPanner = function (...a) {
      const n = mkPan.apply(this, a);
      shot = { filters: [], buffers: [] };
      window.__fw.push(shot);
      const s = shot;
      queueMicrotask(() => { s.pan = +n.pan.value.toFixed(4); });
      return n;
    };
    P.createBiquadFilter = function (...a) {
      const n = mkFil.apply(this, a), s = shot;
      queueMicrotask(() => s.filters.push([n.type, Math.round(n.frequency.value)]));
      return n;
    };
    P.createBufferSource = function (...a) {
      const n = mkSrc.apply(this, a), s = shot;
      queueMicrotask(() => {
        const b = n.buffer;
        if (!b) return;
        const d = b.getChannelData(0);
        let nz = 0;
        for (let i = 0; i < d.length; i++) if (d[i]) nz++;
        s.buffers.push({ secs: +(b.length / b.sampleRate).toFixed(2),
                         density: +(nz / d.length).toFixed(4) });
      });
      return n;
    };
  })()`,
});
await t.send("Page.reload");
await t.sleep(1200);

// The real effect, for the span a quest gets. The overlay is not open, so this
// paints nothing a player would see — the canvas sizing is still the proof the
// visual half ran, and it is the same call finishQuest makes.
await t.evalJs(`${NAME}(1.6)`);
await t.sleep(2200);

const shots = (await t.evalJs("JSON.stringify(window.__fw)").then(JSON.parse))
  .filter((s) => s.pan !== undefined);
check(`fireworks() found as ${NAME}() and fired several shells`, shots.length >= 4);
check("the canvas was sized, so the picture ran too",
  (await t.evalJs("document.getElementById('fw').width")) > 0);

const pans = shots.map((s) => s.pan);
check("every burst is panned inside the band x is drawn in (-0.68..0.68)",
  pans.every((p) => p >= -0.681 && p <= 0.681));
check("the shells are spread across the width, not stacked in the middle",
  Math.max(...pans) - Math.min(...pans) > 0.2);

const band = (s) => (s.filters.find(([k]) => k === "bandpass") || [])[1];
const high = (s) => (s.filters.find(([k]) => k === "highpass") || [])[1];
check("every burst carries both filters", shots.every((s) => band(s) && high(s)));
// hue = (band - 400) / 4, and the highpass must be 1200 + hue * 6 exactly.
check("the report and the crackle are pitched by ONE hue, the shell's own",
  shots.every((s) => high(s) === 1200 + ((band(s) - 400) / 4) * 6));
check("that hue is a real hue (0..360), so it came off the colour string",
  shots.every((s) => (band(s) - 400) / 4 >= 0 && (band(s) - 400) / 4 < 360));
check("the shells are not all the same colour",
  new Set(shots.map(band)).size > 1);

const bufs = shots.flatMap((s) => s.buffers);
check("the report buffer is 0.8s of dense noise",
  bufs.some((b) => b.secs === 0.8 && b.density > 0.99));
check("the crackle buffer is 1.6s of SPARSE reports, not more noise",
  bufs.some((b) => b.secs === 1.6 && b.density > 0.001 && b.density < 0.01));
check("the crackle outlasts a spark (1.1-1.9s)", bufs.some((b) => b.secs >= 1.6));

check("no uncaught exceptions", t.exceptions.length === 0);
if (t.exceptions.length) console.error(t.exceptions.join("\n"));
t.close();

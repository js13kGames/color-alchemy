// Searches for an ELEMENTS table order that packs smaller, and writes
// element-order.json. The sibling of tools/find-fn-order.mjs, deliberately the
// same shape: search on the packed size, then A/B the candidate against the
// incumbent on the REAL zip, and only write when it strictly wins.
//
//   npm run element-order-optimize [-- seconds] [--seed N] [--proposals N]
//     seconds      wall-clock budget, default 900.
//     --seed       PRNG seed (default 1); the proposal SEQUENCE follows from it.
//     --proposals  run exactly N proposals instead of a time budget, which is
//                  how a time-budgeted run is replayed on another machine.
//
// BUILD FIRST: this searches dist/pre-roadroller.js and refuses if any src/
// file is newer — a stale chunk fits an order to code that is not shipping.
//
// WHAT MAKES THIS DIFFERENT FROM fn-order: moving an element also moves its
// CODE, because enc() derives the two-character recipe code from the table
// index. So a single swap rewrites two entries and every recipe in the table
// that references either of them. That is much more leverage per proposal than
// a function permutation has — and it is also why the incumbent is hard to
// beat: src/elements.ts is hand-ordered so an element sits beside the ids it is
// built from, which is already an argument about locality.
import { readFileSync, writeFileSync, copyFileSync, statSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { Packer } from "roadroller";
import { elementTable, renderElements, fingerprint, PINNED } from "./element-order.mjs";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = Number(argv[++i]);
  else positional.push(argv[i]);
}
for (const k of Object.keys(flags)) {
  if (!["seed", "proposals"].includes(k)) throw new Error(`unknown flag --${k}`);
  if (Number.isNaN(flags[k])) throw new Error(`--${k} needs a number`);
}
const SECONDS = Number(positional[0] ?? 900);
const SEED = flags.seed ?? 1;
const PROPOSALS = flags.proposals ?? null;
const CHUNK = "dist/pre-roadroller.js";
const OUT = "element-order.json";
const CANDIDATE_OUT = ".element-order-candidate.json";

// ---- staleness guard ------------------------------------------------------
const chunkMtime = statSync(CHUNK).mtimeMs;
const newer = [];
const walkSrc = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSrc(p);
    else if (statSync(p).mtimeMs > chunkMtime) newer.push(p);
  }
};
walkSrc("src");
if (newer.length) {
  console.error(`${CHUNK} is older than ${newer.length} src file(s), e.g. ${newer[0]}`);
  console.error("Run `npm run build` first — searching a stale chunk fits an order to code that is not shipping.");
  process.exit(1);
}

const src = readFileSync(CHUNK, "utf8");
const table = elementTable(src);
if (!table) {
  console.error("chunk holds no encoded ELEMENTS table this search can speak for");
  process.exit(1);
}
const ids = table.entries.map((e) => e.id);
const N = ids.length;
const want = fingerprint(table);

const { _fittedTo, ...pinned } = JSON.parse(readFileSync("rr-config.json", "utf8"));
const packedSize = (order) => {
  const data = renderElements(src, table, order);
  const d = new Packer([{ data, type: "js", action: "eval" }], pinned).makeDecoder();
  return d.firstLine.length + d.secondLine.length;
};

// The zip A/B runs the SHIPPING pipeline: the packed chunk goes to
// dist/bundle.js and postbuild.mjs does the inline, the minify and the
// deterministic zip exactly as a real build would, so these numbers cannot
// drift from the build's — they ARE the build's.
const BUNDLE = "dist/bundle.js";
const SAVED = ".element-order-bundle-backup.js";
const zipOf = (order) => {
  const data = renderElements(src, table, order);
  const d = new Packer([{ data, type: "js", action: "eval" }], pinned).makeDecoder();
  writeFileSync(BUNDLE, d.firstLine + d.secondLine);
  execFileSync("node", ["postbuild.mjs"], { stdio: "pipe" });
  return statSync("dist/build.zip").size;
};

// ---- hill climb -----------------------------------------------------------
let s = SEED;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
// Only the tail moves: the first PINNED entries are the colour block the quest
// reads by index (i < COLORS in game.ts).
const pick = () => PINNED + ((rnd() * (N - PINNED)) | 0);

const incumbent = ids.slice();
let best = incumbent.slice();
let bestScore = packedSize(best);
const start = bestScore;
const budget = PROPOSALS === null ? `${SECONDS}s` : `${PROPOSALS} proposals`;
console.log(
  `searching ${N - PINNED} of ${N} elements (${PINNED} pinned), ${budget}, seed ${SEED}; ` +
  `incumbent packs to ${start}`
);
const deadline = Date.now() + SECONDS * 1000;
const done = (it) => (PROPOSALS === null ? Date.now() >= deadline : it >= PROPOSALS);

let it = 0;
for (; !done(it); it++) {
  const cand = best.slice();
  if (rnd() < 0.5) {
    const i = pick(), j = pick();
    [cand[i], cand[j]] = [cand[j], cand[i]];
  } else {
    const [x] = cand.splice(pick(), 1);
    cand.splice(pick(), 0, x);
  }
  const score = packedSize(cand);
  if (score < bestScore) {
    bestScore = score;
    best = cand;
    console.log(`  it ${it}: packed ${score} (${score - start})`);
    writeFileSync(CANDIDATE_OUT, JSON.stringify({
      note: "crash/interrupt checkpoint — NOT validated against the real zip",
      packed: score, proposals: it, seed: SEED, order: best,
    }, null, 2) + "\n");
  }
}
console.log(`\n${it} proposals evaluated (seed ${SEED})`);

if (bestScore >= start) {
  console.log(`no improvement over the incumbent order (${start}); ${OUT} left alone`);
  process.exit(0);
}

// The search only ever permutes, but the whole point of this pass is that it
// rewrites recipe codes as it goes, so prove the winner is still the same game
// before it is allowed anywhere near the zip.
const check = elementTable(renderElements(src, table, best));
if (!check || fingerprint(check) !== want) {
  console.error("the winning order does not round-trip to the same recipes — refusing to write it");
  process.exit(1);
}

// ---- A/B on the real zip, and only then write -----------------------------
copyFileSync(BUNDLE, SAVED);
let zipIncumbent, zipBest;
try {
  zipIncumbent = zipOf(incumbent);
  zipBest = zipOf(best);
} finally {
  copyFileSync(SAVED, BUNDLE);
  execFileSync("node", ["postbuild.mjs"], { stdio: "pipe" });
  rmSync(SAVED, { force: true });
}
console.log(`\npacked ${start} -> ${bestScore}; zip ${zipIncumbent} -> ${zipBest}`);
if (zipBest >= zipIncumbent) {
  console.log(`the searched order packs smaller but zips no better — ${OUT} left alone`);
  console.log("(intermediate sizes are not evidence: only the zip ships)");
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify({
  _fittedTo: { chunk: CHUNK, chars: src.length, elements: N, pinned: PINNED, zip: zipBest, when: new Date().toISOString().slice(0, 10) },
  order: best,
}, null, 2) + "\n");
rmSync(CANDIDATE_OUT, { force: true });
console.log(`wrote ${OUT} (${zipBest - zipIncumbent} zip). Run \`npm run build\` to apply it.`);

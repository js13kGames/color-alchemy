// Core game: state, the element grid, combining, discovery cards, the quest
// and completion overlays, and persistence.
//
// Scoring: every combination ATTEMPT counts as a move — successes, failures
// and rediscoveries alike — and so does a HINT, which buys a productive pair
// for the same price — though repeating a hint you have not acted on yet is
// free (a perfect quest is 32 moves; a perfect full clear is 98).
//
// PERSISTENCE IS ONE localStorage ENTRY, `colorAlchemy`, holding one array;
// src/store.ts owns it and the S_* constants below name the slots:
//   0 tree      the recipe-tree fingerprint. A mismatch drops every best and
//               keeps everything else — a best is only meaningful against
//               the tree that set it.
//   1 run       the current run, so closing the tab loses nothing. Restart
//               (double-press to confirm) wipes it, never the bests.
//   2 bestQuest fewest moves to hold both Rainbow and Unicorn. Shown in the
//               HUD once it exists.
//   3 bestFull  fewest total moves to find ALL elements. The HIDDEN highscore
//               — only ever compared and shown on the completion screen,
//               which only a full clear reaches (closeOverlay wipes the card
//               so it cannot linger in the DOM either).
//   4 codex     all-time knowledge, outliving every run.
//   5 mute      a preference, which is why Reset everything leaves it alone.
//   6 bestPeace fewest moves to hold both World and Peace. Appended rather
//               than slotted next to bestQuest because the index IS the key:
//               renumbering would read every existing save's codex as its
//               mute. sfx.ts owning 5 is why a game slot sits after it.
//   7 bestColor fewest moves to hold all 17 colours, appended for the same
//               reason: every new best takes the next index and none ever
//               moves.
//   8 bestCowa  fewest moves to hold Ninja, Turtle and Pizza. The one quest
//               that wants THREE elements rather than two.
//   9 bestMatter  fewest moves to reach Matter. The one quest that wants a
//                 SINGLE element, and so the first one any run completes.
// Five separate keys became this and it measured -41 B: the win is not the
// repeated `colorAlchemy.` prefix (roadroller charges almost nothing for an
// exact repeat) but the code the shape removes — a three-method wrapper, two
// JSON.parse/stringify pairs, and the fingerprint concatenated onto two key
// names. Shortening all five keys to one character each was measured first as
// an upper bound and only reached -25, so the structure is where the bytes are.
import { ELEMENTS, STARTERS, BY_ID, RECIPE, N, type ElementDef } from "./elements";
// Director's-cut only: three markup helpers over a table of 101 strings, all
// four of them behind the __DIRECTOR__ literal at every call site below, which
// is what lets closure delete the lot from a shipping build.
import { cardQuote, wellQuote, codexQuote } from "./quotes";
import { SFX, muted, burst } from "./sfx";
import { toggleMute } from "./music";

/* ------------------------------------------------------------- persistence */
// Bests are only meaningful against one recipe tree: a quest record set on an
// older, shorter tree would sit unbeatable forever after a balance change.
// Scope the best-score keys by a fingerprint of the tree, so any change to
// recipes or element count quietly starts a fresh board. The run itself stays
// unversioned — an in-flight run survives balance patches.
let vh = 5381;
for (const ch of JSON.stringify(Object.entries(RECIPE).sort()) + ELEMENTS.length) {
  vh = ((vh * 33) ^ ch.charCodeAt(0)) >>> 0;
}
const TREE = vh.toString(36);
// ONE localStorage entry, sections by index: [tree, run, bestQuest, bestFull,
// codex, mute, bestPeace, bestColor, bestCowa, bestMatter, emojiFont]. The
// last one, like mute, is a SETTING rather than progress: neither is in the
// list Reset everything clears, nor in the list a tree-hash mismatch drops.
// Slot 10 is declared in src/css.ts, which is the module that appends the
// @font-face and the one that reads it back at boot. The tree hash rides in
// slot 0 instead
// of being suffixed onto key names — a mismatch drops the bests and keeps
// everything else, which is what the suffixed keys did by orphaning them.
import { cell, put } from "./store";
import { S_FONT, loadEmojiFont } from "./css";
const S_RUN = 1, S_QUEST = 2, S_FULL = 3, S_CODEX = 4, S_PEACE = 6, S_COLOR = 7, S_COWA = 8, S_MATTER = 9;
if (cell[0] !== TREE) { cell[0] = TREE; cell[S_QUEST] = cell[S_FULL] = cell[S_PEACE] = cell[S_COLOR] = cell[S_COWA] = cell[S_MATTER] = 0; }

/* ------------------------------------------------------------------- state */
// A PLAIN OBJECT RATHER THAN A Set, the same trade `tried` makes below, and
// worth 24 B across the three dictionaries this file kept in Sets. `has` and
// `add` are both shorter as a subscript, and `.size` — the one thing an object
// does worse — is not needed at all: every `found[id] = 1` is paired with an
// addTile(id), which pushes to `order`, so order.length IS the count and the
// reset clears both together.
// The `__proto__` hazard is real here in a way it is not for `tried`, whose
// keys all contain a "+": these keys are bare element ids, so an id named
// `constructor` or `toString` would read back truthy before discovery. The
// encode-recipes plugin fails the build on one rather than leaving it to be
// found by playing.
let found: Record<string, 1> = {};  // discovered element ids (this run)
const order: string[] = [];         // discovery order (drives the grid)
// EVERY PAIR PUT IN THE CAULDRON THIS RUN, successes included. RUN state, so
// it rides the run save and New game wipes it with the board. It was failures
// only until now, under the name `dead`, and it lived with the all-time codex
// instead. Two things fall out of the move:
//   - THE SUCCESSES CAN JOIN IT, which is the point. A pair already performed
//     greys out on the next pick of either half, instead of silently repeating
//     itself and answering "already discovered" after the fact.
//   - NO FILTER IS NEEDED AT EITHER END. `dead` claimed "nothing here, ever" —
//     a statement about the TREE, which a balance patch could falsify, hence
//     the mirrored load filters this replaces. "Tried" is a statement about
//     the player within one run, and inside a run `found` only ever grows, so
//     a tried pair that made something means you still hold that something.
//     "Tried" and "nothing left to give" are therefore the same statement, and
//     no second clause is needed to keep the board honest.
// The price is that failures are no longer remembered across runs: New game
// now genuinely starts the search over.
//
// A PLAIN OBJECT RATHER THAN A Set, because this one is persisted and a Set is
// not JSON: as a Set it needs `[...tried]` on every save and a `.map` loop on
// every load, where the object IS the saved shape and both ends become an
// assignment. `__proto__` is the usual hazard with an object-as-dictionary and
// cannot arise here — every key is rkey() output, so every key contains a "+".
let tried: Record<string, 1> = {};
// The codex is all-time knowledge, persisted separately from the run: every
// element ever discovered (in first-discovery order) and every recipe ever
// performed. New game wipes the board, never the codex — it is what the
// Encyclopedia shows, and what decides whether a discovery is a first EVER,
// which is what earns the merge animation. Not tree-scoped: knowledge
// survives balance patches, with stale entries filtered on load.
const codexF: string[] = [];
const codexK: Record<string, 1> = {};
let moves = 0;                      // every combination attempt, incl. failures
let questDone = false;              // Rainbow + Unicorn found this run
let peaceDone = false;              // World + Peace found this run
let colorDone = false;              // every colour found this run
let cowaDone = false;               // Ninja + Turtle + Pizza found this run
let matterDone = false;             // Matter found this run
let fullDone = false;               // all elements found this run
// "Unlock all" hands you the whole board, so the run must never score again.
// Persisted with the run: a reload cannot launder a cheated run into a best.
let cheated = false;
let sel = -1;                       // index (into order) of the picked element, -1 when none
let held = false;                   // ...and whether that pick is LOCKED (gold) or loose (cyan)
let slotA: string | null = null;    // A when nothing is locked (a drag, or CA.attempt)
let slotB: string | null = null;    // the second element, until the attempt resolves
let slotR: string | null = null;    // the result, likewise
let clearTimer = 0;
let cursor = 0;                     // keyboard/gamepad focus index
let padMode = false;                // show the focus ring only once kb/pad is used

const tiles: HTMLElement[] = [];    // DOM nodes parallel to `order`

const rkey = (a: string, b: string): string => [a, b].sort().join("+");

// Restarting a CSS animation is remove-class, FLUSH, add-class — and the flush
// is a layout read. A bare `void el.offsetWidth` does not survive the build:
// closure ADVANCED sees a pure property read whose value is discarded and
// deletes the statement, which silently broke every repeat animation in the
// game (a second dead end in a row did not shake, a repeated dupe did not
// pulse, back-to-back discoveries did not re-fade). Feeding the value into a
// branch is what makes it undroppable: closure cannot prove which way it goes,
// so it has to do the read.
function reflow(el: HTMLElement): void {
  if (el.offsetWidth < 0) el.hidden = true;
}

function save(): void {
  put(S_RUN, { f: order, t: tried, m: moves, q: questDone, c: fullDone, x: cheated,
    p: peaceDone, o: colorDone, n: cowaDone, d: matterDone });
}
function saveCodex(): void {
  put(S_CODEX, { f: codexF, k: Object.keys(codexK) });
}

/* -------------------------------------------------------------------- HUD */
function hud(): void {
  mv.innerHTML = String(moves);
  ct.innerHTML = order.length + " / " + ELEMENTS.length;
  const q = cell[S_QUEST];
  bq.innerHTML = q ? "Best quest: " + q : "";
  // STATUS ONLY, no objective: what to aim for is the Quests screen's job now,
  // and naming one quest here made the other two look like they did not count.
  // The element stays whatever it says — css.ts anchors the help line on it
  // with gl.after(), so #gl is furniture as well as text.
  // Only the one state left to report: a COMPLETED run never gets back to the
  // board to read a line off it, so the trophy that used to sit here had no
  // moment to be seen in once the completion screen became the end of the run.
  gl.innerHTML = cheated ? "Unlocked &mdash; this run does not score" : "";
}

let toastTimer = 0;
// The label names the ACTION, not the state: Mute while there is something to
// mute, Unmute once there is not. It still wears one LOOK — no dim class, no
// second border — so it sits with Hint and Menu; only the word changes.
// Called at boot too, since the preference outlives the run.
function paintMute(): void {
  // The WHOLE button, not just its text node. Targeting firstChild kept the
  // shortcut hint alive without rewriting it, at the price of the last
  // .textContent and the only .firstChild in the bundle — two singletons for
  // one saved string. The string is not novel either: the same <i>M / Ⓜ</i>
  // is already in the body markup this rewrites, so the packer has seen it.
  sn.innerHTML = (muted ? "Unmute" : "Mute") + "<i>M / Ⓧ</i>";
}

// The one mute path: the key, the pad button and the HUD button all land here,
// so the word can never disagree with the state.
export function muteToggle(): void {
  toast(toggleMute() ? "Sound off" : "Sound on");
  paintMute();
}

export function toast(msg: string): void {
  to.innerHTML = msg;
  to.classList.add("w");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => to.classList.remove("w"), 1900);
}

/* -------------------------------------------------------------------- grid */
// THE GLOW IS ONE HEX DIGIT, not two, and that is the whole of a bug that hid
// in plain sight: --g feeds `box-shadow: 0 0 10px 1px var(--g)` in .s, and this
// used to append "55" for a 33% alpha — which is right for #rrggbb and NOT A
// COLOUR for #rgb. Every `c` in the table is three digits, so every one of them
// produced a five-digit "#56755", the shorthand went invalid at computed-value
// time, and box-shadow fell back to `none`. NOT ONE SWATCH WITH A COLOUR HAD A
// GLOW; the only tiles that did were the emoji-only ones falling back to the
// six-digit default here, which is exactly the wrong half to work and is why it
// went unnoticed. #rgb + one digit is #rgba, and "5" is the same 0x55 alpha the
// old suffix meant — so the default drops to three digits to match.
function iconHtml(el: ElementDef): string {
  // an SVG icon rides on .s too, so every size rule the swatches have applies
  if (el.s) {
    return '<svg class=s viewBox="0 0 32 32" style="--g:' + (el.c || "#85f") + '5">' +
           el.s + "</svg>";
  }
  if (el.c || el.bg) {
    // bg (a full CSS background stack) overrides the flat color; the plain
    // color always supplies the glow, a gradient being no kind of color
    return '<div class=s style="background:' + (el.bg || el.c) +
           ";--g:" + (el.c || "#85f") + '5"></div>';
  }
  return el.e || "";
}
function addTile(id: string): void {
  const el = BY_ID[id];
  const d = document.createElement("div");
  d.className = "t";
  // THE TILE'S ELEMENT ID, on a QUOTED expando rather than in a data attribute.
  // `d.dataset.id = id` is 7 B more, all of it in two long property names that
  // nothing but this pair of sites reads. Quoted, and that is the load-bearing
  // part: closure ADVANCED runs on the shipping build and NOT on the cut, so an
  // unquoted `.z` would be mangled in one and left alone in the other, and
  // check.mjs drives both — it finds tiles by `e.z`, which a quoted access
  // keeps spelled `z` everywhere. The cost is that the id is no longer visible
  // in a DOM inspector; `[...document.querySelectorAll('.t')].find(e => e.z ===
  // "cloud")` is the console equivalent.
  (d as any)["z"] = id;
  d.innerHTML = '<div class=o>' + iconHtml(el) + '</div><div class=n>' + el.n;
  const i = order.length;
  d.onclick = () => {
    if (Date.now() < clickGuard) return;    // that click ended a drag
    padMode = false;
    renderFocus();
    selectAt(i);
  };
  // a reaction class clears itself; the arrival pop ends here too, and marks
  // the tile settled so no later class change replays it
  d["onanimationend"] = () => {
    d.classList.remove("h");
    d.classList.add("z");
  };
  d["onpointerdown"] = e => startPress(e, i);
  d["onpointermove"] = onPressMove;
  d["onpointerup"] = onPressUp;
  d["onpointercancel"] = cancelPress;
  order.push(id);
  tiles.push(d);
  gd.appendChild(d);
}
// The one-shot tile reaction, and now the only one: the element a known
// combination just remade pulses, so the toast is not the only thing pointing
// at it. Dropping the class and forcing a reflow re-arms the CSS animation, so
// repeating the same combo reacts every time instead of only the first.
// A pair that makes NOTHING shakes the CAULDRON rather than the two tiles
// (#cd.x), so "x" has not reached a tile for some time — it was still being
// passed and still being cleared here, and both are gone with the parameter.
function flash(...ids: string[]): void {
  for (const id of ids) {
    const t = tiles[order.indexOf(id)];
    if (!t) continue;
    t.classList.remove("h");
    reflow(t);
    t.classList.add("h");
  }
}
function renderFocus(): void {
  const h = standingHint();
  // What the PICK has already been tried against this run — whether that made
  // nothing or made something now on the board; either way there is nothing
  // left to find there. Only ever while something is picked: with nothing in
  // hand there is no pair to be spent, and a board that stayed half-greyed
  // would just look broken.
  const p = sel >= 0 ? order[sel] : "";
  // EVERY ID STILL WORTH MIXING: one named by a recipe of an element THIS RUN
  // has not found. Anything else is SPENT — every combination it has left
  // either makes nothing or remakes something already on the board. That
  // includes the 40 terminal elements, which no recipe names at all and which
  // are therefore spent from the moment they are discovered.
  //
  // Against `found`, the RUN, and deliberately not against the codex: a New
  // game is a fresh search, so every label comes back with the empty board.
  // The partner does not have to be in hand either — an id stays live while
  // any recipe of a missing element names it, even one whose other half is
  // still undiscovered. That only ever errs late, never early.
  //
  // Derived here rather than kept in state: one pass over the tree, against a
  // render that only runs on an interaction, and derived state cannot drift
  // out of step with `found`. It is monotonic anyway — the missing set only
  // shrinks — so nothing ever un-spends and no label flickers.
  const live: Record<string, 1> = {};
  for (const el of ELEMENTS) if (!found[el.id])
    (el.r || []).map(q => (live[q[0]] = live[q[1]] = 1));
  tiles.map((t, i) => {
    // one element wears one of the two: gold for a locked pick, cyan for a
    // loose one. Nothing else on the board is marked — a mix leaves the pair
    // in the altar, not on the tiles.
    t.classList.toggle("e", i === sel && held);
    t.classList.toggle("E", i === sel && !held);
    t.classList.toggle("u", padMode && i === cursor);
    // both halves of an unspent hint glow, and stop glowing the moment
    // standingHint() goes null — which is why nothing has to clear it
    t.classList.toggle("g", !!h && h.includes(order[i]));
    // the name turns green the moment an element has nothing left to give
    const done = !live[order[i]];
    t.classList.toggle("S", done);
    // ...and the tile greys for any of three reasons, all of them the same
    // sentence: there is nothing left down this pair. EITHER HALF being spent
    // is enough — a spent element makes nothing new with anything, so it greys
    // against every pick, and a spent PICK greys the whole board in one go —
    // and so is having already tried the pair. Never on the pick itself: an
    // element is never tried against itself, so it stays lit over whatever
    // board it just proved.
    t.classList.toggle("x", !!p && i !== sel &&
      (done || !live[p] || !!tried[rkey(p, order[i])]));
  });
}
function gridCols(): number {
  return Math.max(1, getComputedStyle(gd).gridTemplateColumns.split(" ").length);
}
export function moveCursor(dx: number, dy: number): void {
  const n = tiles.length, c = gridCols();
  if (dx) cursor = Math.min(n - 1, Math.max(0, cursor + dx));
  if (dy) {
    const x = cursor % c, y = (cursor / c) | 0;
    const ny = Math.min(((n - 1) / c) | 0, Math.max(0, y + dy));
    cursor = Math.min(n - 1, ny * c + x);
  }
  padMode = true;
  renderFocus();
  if (tiles[cursor]) tiles[cursor].scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------ drag & drop */
// Drag one tile onto another to combine. Mouse/pen lift after a small
// movement threshold; touch lifts on a 220ms long-press so page scrolling
// stays possible: before the lift nothing is preventDefaulted, so the
// browser is free to claim the gesture as a pan (which fires pointercancel
// and quietly cancels the pending drag). Once lifted, boot()'s non-passive
// touchmove listener preventDefaults, so a pan can no longer start.
// The pointer is captured on the source tile, so its listeners see the whole
// gesture and the drop target is found with elementFromPoint (the ghost is
// pointer-events: none and cannot occlude it).
let pressIdx = -1;          // tile index under an active press, -1 when idle
let pressX = 0, pressY = 0; // press origin, for the lift threshold
let lastX = 0, lastY = 0;
let dragging = false;       // true once the tile is lifted
let ghost: HTMLElement | null = null;
let dropEl: HTMLElement | null = null;
let pressTimer = 0;
// Clicks before this timestamp ended a drag, not a select. Date.now() rather
// than performance.now(), which is 7 characters longer at each of the two sites
// that touch it: the two are a MATCHED PAIR — one sets `now + 350`, the other
// compares against it, and the value is never held against an rAF timestamp or
// anything else — so the clock they share only has to agree with itself. What
// that gives up is monotonicity, and the price of a wall-clock jump inside a
// 350 ms window is one click that selects when it should not, or does not when
// it should. The 0 initial value reads the same to both: no guard is up.
let clickGuard = 0;
// The pick a lift suspended. A drag has to clear sel/held to keep the board
// readable while the ghost is out, but a drag that comes back to where it
// started is not a drag at all — the player changed their mind — so the pick
// is put back and the drop is handled as the tap it turned out to be.
let dragSel = -1, dragHeld = false;

function startPress(e: PointerEvent, i: number): void {
  if (phase() || pressIdx >= 0) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  pressIdx = i;
  pressX = lastX = e.clientX;
  pressY = lastY = e.clientY;
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  if (e.pointerType !== "mouse") pressTimer = setTimeout(lift, 220);
}
function lift(): void {
  if (pressIdx < 0 || dragging || phase()) return;
  dragging = true;
  dragSel = sel;            // remembered, in case the drop lands back on the source
  dragHeld = held;
  sel = -1;                 // a pending click-selection mid-drag would confuse; clear silently
  held = false;
  renderFocus();
  const src = tiles[pressIdx];
  src.classList.add("d");
  // The lift clears the pick so the drop can decide what it becomes, but the
  // board must not look like the pick evaporated: put the ring straight back on
  // the tile it belongs to. .d fades the source because it is in the air; the
  // ring is what still says whether it was LOCKED (gold, with its padlock) or
  // merely picked (cyan). Added before the clone on purpose, so when the tile in
  // the air is the picked one the ghost carries the ring too — .t.G comes later
  // in the sheet and keeps its own opacity and transform, so only the border,
  // background and badge come across. cancelPress() renders it away again.
  if (dragSel >= 0) tiles[dragSel].classList.add(dragHeld ? "e" : "E");
  // The tile in the air ALWAYS wears a ring, even when it was picked up cold:
  // cyan, the same mark the board puts on a second element, so a drag off an
  // untouched tile still shows what is being carried instead of a grey gap.
  // Skipped when it is the picked one, which already has its own ring above —
  // gold if it is locked, and gold must win.
  if (dragSel !== pressIdx) src.classList.add("E");
  ghost = src.cloneNode(true) as HTMLElement;
  ghost.classList.add("G");
  document.body.appendChild(ghost);
  moveGhost();
  SFX.select();
}
function tileAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el ? (el.closest(".t") as HTMLElement | null) : null;
}
function moveGhost(): void {
  if (!ghost) return;
  ghost.style.left = lastX + "px";
  ghost.style.top = lastY + "px";
  const t = tileAt(lastX, lastY);
  const next = t && t !== tiles[pressIdx] && t !== ghost ? t : null;
  if (dropEl !== next) {
    if (dropEl) dropEl.classList.remove("p");
    dropEl = next;
    if (dropEl) dropEl.classList.add("p");
  }
}
function onPressMove(e: PointerEvent): void {
  if (pressIdx < 0) return;
  lastX = e.clientX;
  lastY = e.clientY;
  if (!dragging) {
    const dx = lastX - pressX, dy = lastY - pressY;
    if (dx * dx + dy * dy > 36) {
      if (e.pointerType === "mouse") lift();
      else cancelPress();   // touch moved before the long-press: that's a scroll
    }
    return;
  }
  moveGhost();
}
function onPressUp(e: PointerEvent): void {
  if (pressIdx < 0) return;
  if (!dragging) { cancelPress(); return; } // sub-threshold press: the click event selects
  lastX = e.clientX;
  lastY = e.clientY;
  const t = tileAt(lastX, lastY);
  const idx = pressIdx;     // cancelPress() clears it, and the self-drop needs it
  const srcId = order[idx];
  const dstId = t ? (t as any)["z"] as string : undefined;
  clickGuard = Date.now() + 350;
  cancelPress();
  if (dstId && dstId !== srcId) {
    // A LOCK SURVIVES EVERY MIX — that is the whole thing a lock buys, and it
    // has to hold whether the mix was tapped or dragged. Put it back before the
    // attempt, because attempt() paints the altar and paintCauldron() gives the
    // A slot to the locked element.
    // Only when the locked element is actually IN this mix, though. Dragging two
    // other tiles together while something else is locked is a different pair,
    // and showing the locked one in the A slot would be a lie about what was
    // just combined.
    const lockId = dragHeld && dragSel >= 0 ? order[dragSel] : null;
    if (lockId === srcId || lockId === dstId) {
      sel = dragSel;
      held = true;
      // the locked one goes in first whichever end of the drag it was, or the
      // altar would show it in A and the other in B when it was the target
      attempt(lockId, lockId === srcId ? dstId : srcId);
    } else attempt(srcId, dstId);
  }
  else if (dstId) {         // back on the source: exactly the tap it turned out to be
    padMode = false;        // it was a pointer, so the focus ring stays down
    sel = dragSel;
    held = dragHeld;
    selectAt(idx);          // pick it, lock it, let it go, or mix it — selectAt owns that
  } else {
    // Dropped on nothing: the gesture is off, so NOTHING changed — put the pick
    // back exactly as the lift found it. A lock especially: it is the one state
    // the player set deliberately and expects to survive until they drop it
    // deliberately, and letting a drag that landed on empty space destroy it was
    // the opposite of that. This also covers a lock held on some OTHER tile while
    // a third is dragged nowhere.
    sel = dragSel;
    held = dragHeld;
    renderFocus();          // cancelPress() just rendered it away
    SFX.cancel();           // the gesture was cancelled, not the pick
  }
}
function cancelPress(): void {
  clearTimeout(pressTimer);
  if (pressIdx >= 0 && tiles[pressIdx]) tiles[pressIdx].classList.remove("d");
  if (dropEl) { dropEl.classList.remove("p"); dropEl = null; }
  if (ghost) { ghost.remove(); ghost = null; }
  pressIdx = -1;
  dragging = false;
  renderFocus();   // drops the ring lift() put back by hand
}

/* --------------------------------------------------------------- gameplay */
// THE PHASE IS A NUMBER, and the two values it can be compared against for
// free are the reason for the exact numbering: PLAY is 0 so "are we playing"
// is `!p`, and OVER is the highest so "is a card up" is `p > 1`. Named here and
// inlined by closure, so the call sites stay readable and the chunk ships the
// digits — 21 occurrences of "play"/"menu"/"overlay" were 141 characters of
// string literal for what is three states.
export const PLAY = 0, TITLE = 1, OVER = 2;
export type Phase = typeof PLAY | typeof TITLE | typeof OVER;
export function phase(): Phase {
  return ov.classList.contains("w") ? OVER : ti.classList.contains("w") ? TITLE : PLAY;
}
/* ---------------------------------------------------------------- cauldron */
// The altar is the whole discovery UI now: a result lands in #cr instead of
// behind a veil, so nothing has to be dismissed before the next attempt.
function fill(box: HTMLElement, id: string | null): void {
  const el = id ? BY_ID[id] : null;
  box.innerHTML = el
    ? (el.c || el.bg || el.s ? iconHtml(el) : '<span class=i>' + el.e + "</span>") +
      "<span>" + el.n
    : "";
}
function paintCauldron(): void {
  // a locked element wins; otherwise show whatever the last attempt used, so a
  // drag fills the altar too instead of leaving A empty beside a full B
  fill(ca, sel >= 0 ? order[sel] : slotA);
  fill(cb, slotB);
  fill(cr, slotR);
  ca.classList.toggle("y", held);   // the gold ring and its X mean LOCKED
  renderFocus();   // the board mirrors both slots, so they change together
}
// B and the result are transient: they clear a beat after the attempt so the
// locked element is left facing an empty second slot, ready for the next try.
function clearSlots(): void {
  clearTimeout(clearTimer);
  slotA = slotB = slotR = null;
  cq.innerHTML = "";
}
function sweep(ms: number): void {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => { clearSlots(); paintCauldron(); }, ms);
}
// Letting go empties the WHOLE altar, not just the lock: leaving a stale cyan
// secondary behind would mean the next tap on it promoted rather than mixed.
/* ------------------------------------------- first-ever discovery (full screen) */
let discTimer = 0;
// THE CELEBRATION QUEUES BEHIND THE DISCOVERY, and it queues by being ASKED
// TWICE rather than by being remembered. The element that finishes a quest is
// usually the one being discovered, so both want the screen in the same turn;
// the completion used to win and cut the reveal off before a frame of it was
// painted. Now checkMilestones() simply declines while the layer is up, and
// closeDisc asks it again on the way out — whether that is the 3.25s timer or a
// tap skipping it. An element that was already known opens no discovery, so the
// first ask succeeds and the card is immediate.
//
// Nothing is stored between the two asks: the quest flags are still unset when
// the first one declines, so the second re-derives the same answer from `found`.
// That is what makes reset() safe — it wipes the board BEFORE closing the layer,
// and the ask that follows sees a fresh game with nothing to celebrate.
export function closeDisc(): void {
  clearTimeout(discTimer);
  ds.classList.remove("y");
  ds.innerHTML = "";
  checkMilestones();
}
// Only ever for an element never discovered in ANY previous run — the codex is
// what decides that. Rediscoveries and repeats stay in the cauldron.
function openDisc(id: string, aId: string, bId: string): void {
  let k = "";
  for (let i = 0; i < 14; i++) {
    k += '<span class=k style="transform:rotate(' + (i * 25.7 + 8) +
      "deg);--c:hsl(" + ((i * 360 / 14) | 0) + ' 95% 62%);animation-delay:' +
      (1.05 + i * 0.012) + 's"></span>';
  }
  const el = BY_ID[id];
  ds.innerHTML = k + '<span class=f></span>' +
    '<span class=m><span class="g a">' + iconHtml(BY_ID[aId]) + "</span></span>" +
    '<span class=m><span class="g b">' + iconHtml(BY_ID[bId]) + "</span></span>" +
    '<span class=m><span class="g r">' + iconHtml(el) + "</span></span>" +
    // The tag and the skip line borrow .T and .O off the menu screens rather
    // than bringing rules of their own: both are already the muted 11px the
    // card wants, and .T's letter-spacing is what makes a caps label read as a
    // label. The tip is the only place the game says the card can be cut
    // short, so it names all three inputs padSelect() now answers.
    '<span class=c><div class=T>NEW ELEMENT</div><b>' + el.n + "</b>" +
    (__DIRECTOR__ ? cardQuote(id) : "") +
    '<div class=O>tap / Enter / Ⓐ to skip</div>';
  reflow(ds);            // re-arm the fade when one discovery follows another
  ds.classList.add("y");
  discTimer = setTimeout(closeDisc, 3250);
}

export function unlock(): void {
  if (sel < 0 && !slotB) return;
  sel = -1;
  held = false;
  clearSlots();
  SFX.cancel();
  renderFocus();
  paintCauldron();
}
// One element, three states, on the tile you keep tapping: picked (cyan),
// then LOCKED (gold), then nothing. A different element mixes with whatever is
// picked — and the difference the lock buys is what happens next: a loose pick
// is spent by the mix, so the board comes back empty and the next pair starts
// from scratch, while a locked one survives every mix, which is what makes
// trying Fire against ten things ten taps instead of twenty.
export function selectAt(i: number): void {
  if (phase() || i < 0 || i >= order.length) return;
  cursor = i;
  if (sel === i) {
    if (held) { sel = -1; held = false; SFX.cancel(); }   // third tap: let go
    else { held = true; SFX.select(); }                   // second tap: lock it
  } else if (sel < 0) { sel = i; SFX.select(); }          // first tap: pick it
  else {
    const a = order[sel];
    if (!held) sel = -1;   // a loose pick is spent by the mix it just made
    renderFocus();
    attempt(a, order[i]);
    return;
  }
  renderFocus();
  paintCauldron();
}
// keyboard/gamepad select: mark pad mode so the focus ring shows
export function padSelect(): void {
  // Enter, Space and Ⓐ all arrive here, so one guard is every keyboard and pad
  // route to skipping a discovery card — the pointer route is ds's own
  // handler. The className read IS the open test: #ds carries "y" and nothing
  // else. Skipping beats selecting behind a veil, and the card is over the
  // board anyway, so nothing is lost by spending the press on it.
  if (ds.className) { closeDisc(); return; }
  padMode = true;
  selectAt(cursor);
}
export function clearSel(): boolean {
  if (sel >= 0) { unlock(); return true; }
  return false;
}
export function attempt(aId: string, bId: string): void {
  closeDisc();   // a new attempt cuts any discovery still playing
  moves++;
  const k = rkey(aId, bId);
  const res = RECIPE[k];
  // Remembered from here on, so the next pick of either half says so on the
  // board. Unguarded and unsaved: it is run state, and the save() at the tail
  // of this function carries it either way.
  tried[k] = 1;
  if (res && !codexK[k]) { codexK[k] = 1; saveCodex(); }
  slotA = aId;
  slotB = bId;
  slotR = res || null;
  if (res && !found[res]) {
    found[res] = 1;
    addTile(res);
    if (!codexF.includes(res)) { codexF.push(res); saveCodex(); openDisc(res, aId, bId); }
    const el = BY_ID[res];
    cq.innerHTML = "<b>" + el.n + "</b>" + (__DIRECTOR__ ? wellQuote(res) : "");
    SFX.discover();
    sweep(2200);
  } else if (res) {
    cq.innerHTML = "<b>" + N(res) + "</b> <i>&mdash; already discovered";
    flash(res); // point at the element you already own
    SFX.dupe();
    sweep(1500);
  } else {
    cq.innerHTML = "<i>nothing happens";
    SFX.fail();
    sweep(1100);
  }
  paintCauldron();
  // a discovery can be the one that spends an ingredient — or both halves of
  // the pair — so the labels are re-derived here rather than at the next tap
  renderFocus();
  checkMilestones();
  // re-arm both one-shots: the same pair tried twice has to react twice
  cd.classList.remove("x");
  cr.classList.remove("P");
  reflow(cd);
  (res ? cr : cd).classList.add(res ? "P" : "x");
  hud();
  save();
}

/* -------------------------------------------------------------------- hint */
// Names two elements you already hold that make something you do not — and
// charges a move for it, exactly like an attempt. That price is the whole
// design: a hint is progress bought with score, so a hinted run can never
// quietly out-rank an unhinted one, and spamming the button is self-limiting.
// It reveals the PAIR and never the result, so the discovery card still lands.
//
// One hint at a time: until you have actually made it, pressing hint again
// just shows the same pair, free. You paid for that answer, so re-reading it
// is not a second purchase — only moving on to a NEW answer is. Which also
// means the price cannot be dodged by re-rolling for an easier pair.
//
// A hint expires the moment its result exists, however that happened: the
// standing pair is checked against the found set rather than remembered as done, so
// discovering it the long way, or through an alternate recipe, retires the
// hint just as well. Not persisted — a reload simply forgets it, which only
// ever costs the player, never the other way round.
// [a, b, what it makes]. The result rides along because hint() is holding the
// element it picked the pair off — re-deriving it through RECIPE[rkey(a, b)] on
// every render was the same answer at a price.
let lastHint: [string, string, string] | null = null;
// The hint still standing, or null once its result exists. DERIVED on every
// read rather than cleared on discovery, so a pair reached the long way — or
// through an alternate recipe — retires the glow exactly as it retires the
// hint, with no second piece of state that could disagree with this one.
function standingHint() {
  return lastHint && !found[lastHint[2]] ? lastHint : null;
}
function showHint([a, b]: [string, string, string], tail: string): void {
  toast("Hint: try " + N(a) + " + " + N(b) + tail);
  renderFocus();    // the pair lights and STAYS lit; see .t.g in style.css
  SFX.hint();
}
// EVERYTHING THE QUEST STILL NEEDS: walk back from the two goals through every
// recipe that makes them, and keep what is not owned yet. 34 of the 101 are off
// that path entirely — the animals, the drinks, the ornaments — so an unbiased
// hint spends about a third of its answers sending you shopping for a Penguin
// while the Rainbow stands unforged. Measured from a fresh board: 64 of 101 are
// on the path, and it narrows as the run goes (18 left by the time 70 are held).
//
// The `want.has` guard is not just for speed: Magic and the Crystal Ball make
// each other, so the walk would not terminate without it. A found element is not
// walked THROUGH either — owning it makes its own prerequisites irrelevant,
// which is what keeps the set to things still worth having.
//
// Deliberately generous: an element on ANY route to a goal counts, not only the
// cheapest one. A hint that named only the shortest path would be telling the
// player which route to take, and the hint's whole contract is that it reveals
// the pair and never the plan.
function questWants(): Record<string, 1> {
  const want: Record<string, 1> = {};
  const walk = (id: string): void => {
    if (found[id] || want[id]) return;
    want[id] = 1;
    (BY_ID[id].r || []).map(p => { walk(p[0]); walk(p[1]); });
  };
  walk("rainbow");
  walk("unicorn");
  return want;
}
export function hint(): void {
  if (phase()) return;
  const std = standingHint();
  if (std) {
    showHint(std, " — already paid for");
    return;
  }
  let picks: [string, string, string][] = [];
  for (const el of ELEMENTS) {
    if (found[el.id]) continue;
    for (const p of el.r || []) if (found[p[0]] && found[p[1]]) picks.push([p[0], p[1], el.id]);
  }
  // While the quest stands, answer it. Narrowing rather than replacing: if
  // nothing within reach is on the quest path the full list stands, so a hint is
  // never refused for being off-plan — and once the quest is done every
  // reachable pair is fair game again, which is what the endgame asks for.
  if (!questDone) {
    const want = questWants();
    const on = picks.filter(p => want[p[2]]);
    if (on.length) picks = on;
  }
  // Nothing within reach is free — no move, no score. Defensive: running out of
  // productive pairs means the board is complete, which opens the completion
  // overlay and leaves play phase, so today this cannot be reached.
  if (!picks.length) {
    lastHint = null;
    toast("Nothing new within reach — no hint to give");
    SFX.cancel();
    return;
  }
  lastHint = picks[(Math.random() * picks.length) | 0];
  moves++;
  showHint(lastHint, " — costs a move");
  hud();
  save();
}

/* ------------------------------------------------------- goals & overlays */
type OverlayButton = [string, () => void];
let obFns: (() => void)[] = [];
let obCur = 0;
function openOverlay(html: string, buttons: OverlayButton[]): void {
  // NOTHING IS CANCELLED HERE ANY MORE. Both callers come through celebrate(),
  // which is what decides whether this runs now or when the discovery ends, so
  // by the time it does the discovery layer is already down.
  oc.innerHTML = html + '<div id=ob>';
  obFns = [];
  obCur = 0;
  buttons.map(([label, fn]) => {
    const b = document.createElement("button");
    b.innerHTML = label;
    b.onclick = fn;
    ob.appendChild(b);
    obFns.push(fn);
  });
  obPaint();
  ov.classList.add("w");
}
function obPaint(): void {
  [...ob.children].map((b, i) => b.classList.toggle("F", i === obCur));
}
export function obMove(d: number): void {
  obCur = (obCur + d + obFns.length) % obFns.length;
  obPaint();
}
export function obGo(): void {
  if (obFns[obCur]) obFns[obCur]();
}
function closeOverlay(): void {
  ov.classList.remove("w");
  oc.innerHTML = ""; // the hidden best must not linger in the DOM
  fw.width = 0;      // resizing the bitmap IS the clear, and it is one word
}

/* ------------------------------------------------------ completion fireworks */
// COMETS, chosen in experiments/fireworks-gl.html. Shells go up across `span`
// seconds, spread over the width, and each spark is a 2px square.
//
// THE TRAIL IS THE FADE, and nothing else: the canvas is covered each frame
// with a translucent near-black instead of being cleared, so every previous
// position of every spark is still there, one step dimmer. The cut strokes a
// path through each spark's last six positions on top of that; a 13312-byte
// build cannot afford the history, and the fade alone still reads as a comet
// because the spark moves 1-3px a frame and the smear closes the gap.
//
// #0004 rather than a colour of its own: the fade only has to hold the veil
// down, `#000` is a string this bundle is already full of, and the exact tint
// of a 27%-alpha wash over #001c is not something an eye can find.
//
// The only canvas in the game, and it earns that by being the only moment worth
// it: this runs once or twice in a whole run. It never blocks — every button on
// the card works on frame one — and it stops itself when the last comet dies.
// prefers-reduced-motion gets no still, because a trail system held still is a
// blank canvas; style.css hides it outright and the card stands on its own —
// but ONLY IN THE CUT. That whole media block is behind the director markers
// now: honouring the setting costs 40 B packed, and a 13312-byte build buys its
// content by giving things up. The shipping build plays this to everyone.
function fireworks(span: number): void {
  const g = fw.getContext("2d") as CanvasRenderingContext2D;
  const w = fw.width = innerWidth, h = fw.height = innerHeight;
  const P: { x: number; y: number; vx: number; vy: number; c: string; t: number }[] = [];
  let last = 0, at = 0, next = 0;
  const step = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    at += dt;
    if (at > next && at < span) {
      const x = (0.16 + Math.random() * 0.68) * w, y = (0.2 + Math.random() * 0.24) * h,
        c = "hsl(" + ((Math.random() * 360) | 0) + " 95% 62%)";
      // DIRECTOR'S CUT: heard where it is seen. The pan is this shell's own x
      // across the width and the crackle is pitched by its own hue, read back
      // out of the colour string rather than computed twice — a shipping build
      // deletes this line, and with it every byte of burst() in src/sfx.ts, so
      // the string stays the one place the hue lives.
      if (__DIRECTOR__) burst(x / w * 2 - 1, parseFloat(c.slice(4)));
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * 6.283, s = 60 + Math.random() * 100;
        P.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, c, t: 1.1 + Math.random() * 0.8 });
      }
      next = at + 0.12 + Math.random() * 0.12;
    }
    // THE TRAIL FADE, and it erases alpha rather than painting black over it.
    // This was `globalAlpha = 1; fillStyle = "#0004"; fillRect(...)` — a 27%
    // near-black wash over the whole canvas each frame, which is what turns the
    // 2x2 sparks into comets. It also accumulated: ~15 frames in, the canvas
    // was solid black, sitting on top of .v's #001c veil and hiding the very
    // board the veil is 80% opaque in order to show. destination-out reduces
    // what is already there instead of adding to it, so the comets survive and
    // the veil stays translucent.
    // In this mode the fill's COLOUR is ignored and only its alpha counts, so
    // the fillStyle line is gone and globalAlpha carries the .27 by itself —
    // whatever colour the last spark left behind is fine to erase with. The op
    // has to go back to source-over before the sparks are drawn, and the second
    // mention of that long property name costs almost nothing packed.
    g.globalAlpha = .27;
    g.globalCompositeOperation = "destination-out";
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    for (let i = P.length; i--;) {
      const p = P[i];
      if ((p.t -= dt) < 0) { P.splice(i, 1); continue; }
      p.vy += (88 - p.vy) * dt;
      p.vx -= p.vx * dt;
      g.globalAlpha = p.t / 2;
      g.fillStyle = p.c;
      g.fillRect(p.x += p.vx * dt, p.y += p.vy * dt, 2, 2);
    }
    if (P.length || at < span) requestAnimationFrame(step);
    else fw.width = 0;
  };
  requestAnimationFrame(step);
}

// Compare-and-store; returns the HTML line describing the result.
function bestLine(slot: number, val: number): string {
  const prev = +(cell[slot] || 0);
  if (!prev || val < prev) {
    put(slot, val);
    return '<div class="L N">★ NEW BEST ★</div>' +
           (prev ? '<div class="L S">previous best: ' + prev + "</div>" : "");
  }
  return '<div class="L S">best: ' + prev + "</div>";
}
// THE COLOURS ARE THE FIRST 17 ENTRIES OF THE TABLE, in its own order: the
// spectrum block the game opens with, the three starters out through Brown,
// ending exactly where `matter` begins. A slice rather than a list of ids —
// the block is already contiguous, and seventeen strings is a lot to carry for
// what is otherwise one comparison. check.mjs pins BOTH ENDS of it, so a colour
// inserted in the wrong place fails the suite instead of quietly resizing the
// quest. Teal is the deep one at eleven steps; everything else is within four.
const COLORS = 17;
function checkMilestones(): void {
  if (cheated) return;   // nothing an unlocked board reaches is earned
  if (ds.className) return;  // the reveal is playing; closeDisc asks again
  // AT MOST ONE named quest can land per move: a move discovers a single
  // element, and no element belongs to two of these sets — the colour block is
  // the table's first 17, Matter is the 18th, and none of the other three
  // names either. So these are plain sequential ifs rather than a collected
  // list, and the ceremony they share lives in finishQuest below rather than
  // being written out five times.
  //
  // MATTER IS FIRST because it is first in play: the one gateway the whole
  // tree hangs off, one recipe deep, and the only quest that wants a SINGLE
  // element. Every route runs through it, so its card is what teaches a new
  // player that quests exist at all. Its icon is Matter's OWN — the element
  // carries an SVG rather than an emoji, and .A .B .s already sizes one at 56px.
  if (!matterDone && found["matter"]) {
    matterDone = true;
    return finishQuest(S_MATTER, iconHtml(BY_ID["matter"]), "Do what matters");
  }
  if (!questDone && found["rainbow"] && found["unicorn"]) {
    questDone = true;
    return finishQuest(S_QUEST, "\u{1F308}\u{1F984}", "Unicorns and Rainbows");
  }
  if (!peaceDone && found["world"] && found["peace"]) {
    peaceDone = true;
    return finishQuest(S_PEACE, "\u{1F30D}\u{1F54A}", "World Peace");
  }
  if (!cowaDone && found["ninja"] && found["turtle"] && found["pizza"]) {
    cowaDone = true;
    return finishQuest(S_COWA, "\u{1F977}\u{1F422}\u{1F355}", "COWABUNGA!");
  }
  if (!colorDone && !ELEMENTS.filter((e, i) => i < COLORS && !found[e.id]).length) {
    colorDone = true;
    return finishQuest(S_COLOR, "\u{1F3A8}", "Full Color Alchemist");
  }
  if (!fullDone && order.length === ELEMENTS.length) finishFull("");
}
// Compare-and-store, then either hand the line straight to the completion
// screen — the element that finished the quest was also the last on the board
// — or raise the quest's own card.
function finishQuest(slot: number, icons: string, name: string): void {
  const q = bestLine(slot, moves);
  save();
  hud();
  if (order.length === ELEMENTS.length) return finishFull(q);
  SFX.fanfare();
  openOverlay(
    '<div class=B>' + icons + "</div>" +
    '<div class=T>QUEST COMPLETE</div>' +
    "<h2>" + name + "</h2>" +
    '<div class=L>forged in <b>' + moves + "</b> moves</div>" + q,
    // ONE WAY OUT, and it is back to the board: an intermediate quest is a
    // moment in a run, not the end of one, so the card has nothing to offer
    // but its own dismissal. Leaving for the menu is still one Escape away
    // once the card is down — it just is not a choice the celebration makes.
    [["Continue", () => { closeOverlay(); hud(); }]],
  );
  fireworks(1.6);
}
function finishFull(questHtml: string): void {
  fullDone = true;
  // The HIDDEN highscore: compared and shown only here, on a full clear.
  const f = bestLine(S_FULL, moves);
  save();
  hud();
  SFX.grand();
  openOverlay(
    '<div class=B>\u{1F3C6}</div>' +
    '<div class=T>GOTTA CATCH \'EM ALL!</div>' +
    "<h2>All " + ELEMENTS.length + " elements</h2>" +
    (questHtml ? '<div class=L>quest also completed — in <b>' + moves + "</b> moves</div>" : "") +
    '<div class=L>complete run: <b>' + moves + "</b> moves</div>" + f,
    // AND HERE THE RUN IS OVER, so the one way out is the other one: the board
    // behind this card holds every element there is, and nothing left to do on
    // it. inRun() drops Continue from the menu for the same reason, so this is
    // the last the finished run is seen — New game is what follows it.
    [["Main menu", () => { closeOverlay(); openMenu(); }]],
  );
  fireworks(3.2);
}

/* ------------------------------------------------------- title screen menu */
// Boot lands here; Escape / Start / the HUD "Menu" button reopen it. The
// title floats over the bare background (body.M hides the game UI), and
// Quests / Encyclopedia write their subscreen into #mu, over the column.
// The panel head is the BUTTON'S OWN LABEL, uppercased at write time, rather
// than a second string saying the same word in caps: "Quests" against
// "QUESTS" was a near-miss repeat, and a near miss is what roadroller
// actually pays for. Worth 13 B, and 6 more were on the table for dropping the
// caps altogether — declined, the letter-spaced head is the look.
let mCur = 0;
let panel = false;         // the subscreen is up, and #ti.j says so
let armIdx = -1;           // menu button awaiting its confirming second press
let armLabel = "";         // ...and the label to put back when it disarms
let armTimer = 0;
// "Continue" is only offered when there is something to continue: a fresh
// boot, and a Reset everything, both leave nothing behind it — and neither
// does a COMPLETED run, which is the same answer for the opposite reason. A
// board holding every element there is has been finished, not paused: the
// completion screen sends you here, and New game is the only way back onto a
// board from here.
const inRun = (): boolean => !fullDone && (moves > 0 || order.length > STARTERS.length);

function menuButtons(): HTMLElement[] {
  return [...mu.querySelectorAll("button")] as HTMLElement[];
}
function mPaint(): void {
  menuButtons().map((b, i) => b.classList.toggle("F", i === mCur));
}
function disarm(): void {
  const b = armIdx >= 0 ? menuButtons()[armIdx] : null;
  if (b) { b.innerHTML = armLabel; b.classList.remove("R"); }
  armIdx = -1;
  clearTimeout(armTimer);
}
// First press relabels the button with the warning and arms it; a second
// press within 2.5s goes through. Anything destructive routes through here.
function armed(i: number, warn: string): boolean {
  if (armIdx === i) { disarm(); return true; }
  disarm();
  armIdx = i;
  const b = menuButtons()[i];
  armLabel = b.innerHTML as string;
  b.innerHTML = warn;
  b.classList.add("R");
  armTimer = setTimeout(disarm, 2500);
  return false;
}
function newGame(i: number): void {
  if ((moves > 0 || order.length > STARTERS.length) && !armed(i, "Sure? (wipes the run)")) return;
  disarm();
  reset();
  closeMenu();
}
// Hands you every element. Costs no moves and earns nothing: the run is
// flagged from here on, so no best can come out of it.
function unlockAll(i: number): void {
  if (!armed(i, "Sure? (ends scoring)")) return;
  ELEMENTS.map(e => { if (!found[e.id]) { found[e.id] = 1; addTile(e.id); } });
  cheated = true;
  renderFocus();
  hud();
  save();
  closeMenu();
}
// The factory reset New game deliberately is not: run, both bests, and the
// all-time codex.
function wipeAll(i: number): void {
  if (!armed(i, "Sure? (scores and codex too)")) return;
  [S_RUN, S_QUEST, S_FULL, S_CODEX].map(i => put(i, 0));
  codexF.length = 0;
  for (const k in codexK) delete codexK[k];
  reset();
  paintMenu();
  // deliberately NOT closeMenu(): New game means "start playing", this means
  // "put everything back" — you stay where you were, on the title screen
  toast("Everything reset");
}
function continueGame(): void {
  closeMenu();
  hud();
}
// The button's half of the emoji font. Fetching it AND remembering that you
// asked are both src/css.ts's business — the write is in loadEmojiFont because
// folding it in there measured 2 B cheaper than a put() of its own here, and
// the redundant re-write on every later boot costs nothing. What is left is the
// repaint, which is what removes the button: the entry's own predicate answers
// false from here on.
function loadFont(): void {
  loadEmojiFont();
  paintMenu();
}
// the index is handed to the handler so the confirm flow never hardcodes a
// position — reorder this list freely.
// The third slot is an OPTIONAL PREDICATE: an entry with one is painted only
// when it answers true. Continue used to be a hardcoded `if (!i)` in paintMenu,
// which quietly meant "whatever is first"; a second conditional entry that has
// to sit ABOVE it is what made that a bug waiting to happen rather than a
// shortcut.
const MENU: [string, (i: number) => void, (() => unknown)?][] = [
  ["Continue", continueGame, inRun],
  ["New game", newGame],
  ["Quests", () => openPanel("Quests", questsHtml())],
  ["Encyclopedia", () => openPanel("Encyclopedia", encycloHtml())],
];
// THE SHIPPING BUILD ONLY, and at the TOP: it is the one entry that is an
// offer rather than a move, and it is gone for good after one press. The cut
// carries its own font in the zip and a dev build has none, so in both
// __GOLF__ is a literal false and closure deletes the entry, loadFont, and
// with them src/css.ts's loader.
if (__GOLF__) MENU.unshift(["Load emoji font", loadFont, () => !cell[S_FONT]]);
// DEVELOPMENT TOOLS, and not in the shipped build. Pushed inside an if rather
// than spread into the list above so that with __DEV__ a literal false closure
// deletes the branch, then finds unlockAll and wipeAll unreferenced and deletes
// those too — `npm run build-dev` is the build that keeps them.
if (__DEV__) MENU.push(["Unlock all", unlockAll], ["Reset everything", wipeAll]);
// Rebuilt rather than toggled, because which buttons exist depends on state:
// Reset everything calls this too, so Continue leaves with the run it pointed at.
function paintMenu(): void {
  mu.innerHTML = "";
  let n = 0;
  MENU.map(([label, fn, show]) => {
    if (show && !show()) return;
    const j = n++;
    const b = document.createElement("button");
    b.innerHTML = label;
    b.onclick = () => fn(j);
    b["onpointerenter"] = () => { mCur = j; mPaint(); };
    mu.appendChild(b);
  });
  mCur = 0;
  armIdx = -1;
  mPaint();
}
export function openMenu(): void {
  if (phase()) return;
  cancelPress();
  clearSel();
  closePanel();          // paints the column
  ti.classList.add("w");
  document.body.classList.add("M");
}
function closeMenu(): void {
  disarm();
  closePanel();
  ti.classList.remove("w");
  document.body.classList.remove("M");
}
function openPanel(head: string, listHtml: string): void {
  mu.innerHTML = '<div id=mh>' + head.toUpperCase() + '</div><div id=ml>' + listHtml +
    '</div><button id=mb>Back';
  mb.onclick = menuBack;   // the button is rebuilt with the panel, so is this
  panel = true;
  mu.classList.add("j");
}
// Putting the column back IS closing the panel, so this paints rather than
// unhides: the two share the one container.
function closePanel(): void {
  panel = false;
  mu.classList.remove("j");
  paintMenu();
}
export function menuMove(d: number): void {
  if (panel) { ml.scrollTop += d * 60; return; }
  disarm();
  mCur = (mCur + d + menuButtons().length) % menuButtons().length;
  mPaint();
  SFX.select();
}
export function menuGo(): void {
  if (panel) { closePanel(); return; }
  const b = menuButtons()[mCur];
  if (b) b.click(); // through click, so the New game arming flow is identical
}
// Escape out of the menu is Continue by another name, so it answers to the same
// question: with no run behind the menu — a fresh boot, or one just finished —
// there is nowhere to back out TO, and the menu stays where it is.
export function menuBack(): void {
  if (panel) { closePanel(); return; }
  if (armIdx >= 0) { disarm(); return; }
  if (inRun()) continueGame();
}
// One row per quest, each its own name and its own best, and every unset one
// reads "—". The full clear used to read "???" instead, from when its best was
// the hidden one and the row could not admit the board was finishable at all —
// but the row names the goal and the count now, so the "???" was concealing
// only a number you cannot have without finishing. One blank for all four, and
// the parameter that carried the difference goes with it.
function questsHtml(): string {
  const row = (name: string, best: unknown): string =>
    '<div class=H><span>' + name + "</span><b>" +
    (best ? best + " moves" : "—") + "</b></div>";
  return (
    row("Do what matters — Matter", cell[S_MATTER]) +
    row("Unicorns and Rainbows — \u{1F308}\u{1F984}", cell[S_QUEST]) +
    row("World Peace — \u{1F30D}\u{1F54A}", cell[S_PEACE]) +
    row("COWABUNGA! — \u{1F977}\u{1F422}\u{1F355}", cell[S_COWA]) +
    row("Full Color Alchemist — all " + COLORS + " colors", cell[S_COLOR]) +
    row("Gotta catch 'em all! — all " + ELEMENTS.length + " elements", cell[S_FULL])
  );
}
function encycloHtml(): string {
  // The all-time codex, in first-discovery order — the player's journal, and
  // it survives New game. Only recipes actually performed are listed;
  // alternates stay unspoiled.
  const rows = codexF.map(id => {
    const el = BY_ID[id];
    const known = (el.r || []).filter(p => codexK[rkey(p[0], p[1])]);
    const rec = known.length
      ? known.map(p => N(p[0]) + " + " + N(p[1])).join(" &nbsp;&middot;&nbsp; ")
      : el.r ? "?" : "";
    return (
      '<div class=J><span class=I>' + iconHtml(el) + "</span><span>" +
      "<b>" + el.n + '</b><i class=X>' + rec + "</i>" +
      (__DIRECTOR__ ? codexQuote(id) : "") + "</span></div>"
    );
  }).join("");
  return rows +
    '<div class=O>' + codexF.length + " / " + ELEMENTS.length + " elements &middot; " +
    Object.keys(codexK).length + " / " + Object.keys(RECIPE).length + " combinations</div>";
}

/* ---------------------------------------------------------------- restart */
export function reset(): void {
  cancelPress();
  closeOverlay();
  clearSlots();
  found = {}; // the codex deliberately survives — New game wipes the board, not the knowledge
  order.length = 0;
  // AFTER the wipe, never before: closeDisc asks checkMilestones on its way out,
  // and asking it over the run that is being thrown away would raise that run's
  // quest card over the fresh board. Escape during a reveal reaches the menu, so
  // New game mid-discovery is a real sequence, not a hypothetical one.
  closeDisc();
  tiles.length = 0;
  gd.innerHTML = "";
  tried = {};
  moves = 0;
  questDone = fullDone = peaceDone = colorDone = cowaDone = matterDone = cheated = false;
  sel = -1;
  held = false;
  cursor = 0;
  lastHint = null;  // its ingredients just left the board
  STARTERS.map(id => { found[id] = 1; addTile(id); });
  renderFocus();
  paintCauldron();
  hud();
  save();
}

/* -------------------------------------------------------------------- boot */
export function boot(): void {
  mn.onclick = openMenu;
  sn.onclick = muteToggle;
  paintMute();
  ht.onclick = hint;
  ca.onclick = unlock;                  // clicking the locked slot empties it
  ds["onpointerdown"] = closeDisc;      // a tap anywhere skips it
  // non-passive so an active drag can stop a pan from starting; until the
  // long-press lifts the tile, touch scrolling behaves normally
  addEventListener("touchmove", e => { if (dragging) e.preventDefault(); }, { passive: false });

  // restore the codex (all-time knowledge) first
  try {
    const cx = cell[S_CODEX];
    if (cx) {
      (cx.f && cx.f.map ? (cx.f as string[]) : []).filter(id => BY_ID[id])
        .map(id => { if (!codexF.includes(id)) codexF.push(id); });
      (cx.k && cx.k.map ? (cx.k as string[]) : []).filter(k => RECIPE[k])
        .map(k => (codexK[k] = 1));
    }
  } catch {}
  STARTERS.map(id => { if (!codexF.includes(id)) codexF.push(id); });

  // then the saved run
  let run: { f?: unknown; t?: unknown; k?: unknown; m?: number; q?: boolean; c?: boolean; x?: boolean; p?: boolean; o?: boolean; n?: boolean; d?: boolean } | null = null;
  run = cell[S_RUN] || null;
  if (run && run.f && (run.f as string[]).map) {
    const ids = (run.f as string[]).filter(id => BY_ID[id]);
    STARTERS.map(id => { if (!ids.includes(id)) ids.splice(0, 0, id); });
    ids.map(id => { found[id] = 1; addTile(id); });
    // migrate pre-codex saves: a run's discoveries and combos are knowledge
    ids.map(id => { if (!codexF.includes(id)) codexF.push(id); });
    if (run.k && (run.k as string[]).map) (run.k as string[]).filter(k => RECIPE[k]).map(k => (codexK[k] = 1));
    tried = (run.t as Record<string, 1>) || {};
    moves = Math.max(0, (run.m as number) | 0);
    questDone = !!run.q;
    fullDone = !!run.c;
    cheated = !!run.x;
    peaceDone = !!run.p;
    colorDone = !!run.o;
    cowaDone = !!run.n;
    matterDone = !!run.d;
  } else {
    STARTERS.map(id => { found[id] = 1; addTile(id); });
  }
  hud();
  save();
  saveCodex();
  openMenu(); // every session starts on the title screen
}


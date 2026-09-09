// Fills the page stylesheet from JS, so the CSS ships inside the
// roadroller-packed payload instead of the HTML's deflate stream — galaxy-raid
// OPTIMIZATIONS.md #18 (the move itself) and #71 (this spelling of it).
//
// The target is the EMPTY <style id=st> in src/index.html. Filling an element
// that is ALREADY in the document applies the sheet synchronously, before first
// paint, so there is no unstyled frame; creating the <style> here instead
// measured worse for galaxy-raid (#18) and would reintroduce that risk.
//
// Imported FIRST from index.ts, before boot() builds any of the grid.
//
// __MARKUP__ is the bare CSS text — no <style> wrapper — injected by
// rollup.config.mjs from src/style.css, minified with the same cssnano pass
// postbuild.mjs applies to anything left in the template.
import { QUOTE_CSS } from "./quotes";
import { cell, put } from "./store";

declare const __MARKUP__: string;

st.innerHTML = __MARKUP__;

// THE EMOJI FONT IS OPT-IN, and this is the half of it that is not the button
// in src/game.ts's title menu.
//
// __EMOJI__ is the `@font-face{font-family:e;src:url(...)}` rule, built in
// rollup.config.mjs and empty in every build but the shipping one — the cut
// compiles and carries its own face, and a dev build has none. The family is
// NAMED unconditionally, by style.css's `font: 14px/1.45 e, monospace`, so
// a build that never defines it falls straight through to the platform's own
// emoji, which is what this game shipped with for most of its life.
//
// The rule used to be appended to the stylesheet at build time, which made that
// URL the one reference OUT of an otherwise self-contained page — and a page
// that reaches for it unasked is a page that reaches for it under judging
// conditions that forbid the network. So nothing fetches it until "Load emoji
// font" is pressed; that writes slot 10, and every run after it comes through
// the line below instead, before anything is drawn.
//
// The slot is deliberately NOT one of game.ts's bests: like the mute flag in
// sfx.ts it is a setting, so neither Reset everything nor a tree-hash mismatch
// clears it.
//
// It goes into the sheet that is already here rather than a <style> of its own
// — the same move the cut makes with QUOTE_CSS below, and about 45 characters
// cheaper than document.head.insertAdjacentHTML. Appending re-parses the whole
// sheet, which is a non-event both times it can happen: here, ahead of the
// first paint, and on a title screen holding still under the press that asked
// for it. Measured 18 B cheaper here than the same two lines in game.ts, which
// is the only reason a save slot is declared in the stylesheet module.
export const S_FONT = 10;
export function loadEmojiFont(): void {
  st.innerHTML += __EMOJI__;
  put(S_FONT, 1);
}
// `__EMOJI__ &&` is a literal "" outside a shipping build, so closure folds the
// condition away and takes loadEmojiFont's other caller with it.
if (__EMOJI__ && cell[S_FONT]) loadEmojiFont();

// The page's body, lifted out of src/index.html by the inject-body plugin and
// written here instead of being served as markup — the same trade the
// stylesheet above makes, and worth 48 B measured. The stylesheet goes in
// FIRST so the rules are in place before these elements exist, and everything
// below this line, gl.after() included, depends on them being here.
document.body.innerHTML = __BODY__;

// The director's cut appends the rules for its quote containers — in the same
// synchronous run, so they are in place before the first paint as well.
// __DIRECTOR__ is a literal, so a shipping build has `if (false)` here and
// closure deletes the line, then QUOTE_CSS, then the rest of src/quotes.ts.
if (__DIRECTOR__) st.innerHTML += QUOTE_CSS;

// THE HELP LINE IS DIRECTOR'S CUT ONLY. It is the largest block of prose left
// anywhere in the build — ~180 characters of instructions that appear nowhere
// else — and, since the quotes left, very nearly the last prose in the packed
// payload at all. That makes it exactly the wrong thing to keep in a 13312-byte
// entry and the right thing to keep in a cut with no budget: novel text is the
// only content roadroller cannot predict cheaply, so this is where the bytes
// actually are. A shipping build teaches the same three things by being played
// — tap, tap again, arrows — and the controls are conventional.
// Closure folds `if (false)` and deletes the three strings with it.
//
// It rode here rather than in the template for a different reason, worth
// keeping: markup left in src/index.html is deflated by the zip at ~0.44 bytes
// per character while this is modelled by roadroller at roughly a third of that
// (galaxy-raid #18), which was -17 B. The wordmark's seven spans were tried the
// same way and cost +5, because repeated markup deflates better than the code
// to generate it.
//
// gl.after() drops a TEXT NODE exactly where the template had one — inside
// <f>, straight after #gl — so `f` styles it as before and no wrapper element
// (and no font-style reset for it) is needed. `f`'s own color and font-size
// exist for this text alone and sit behind the same gate in style.css.
if (__DIRECTOR__) gl.after(
  "tap one to pick, another to mix · tap the pick again to lock it — " +
  "a locked one stays, a third tap drops it · arrows or d-pad + " +
  "Enter/Ⓐ · Esc/Ⓑ drops · H/Ⓨ hints, costs a move");

export {};

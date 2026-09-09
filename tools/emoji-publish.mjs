// Puts the director's emoji subset where the SHIPPING build can be pointed at
// it, as ./emoji.ttf in the repo root.
//
// WHY THIS EXISTS. The two builds get their emoji from opposite directions. The
// director's cut generates the subset at build time and bundles it, so it is
// always in step with src/elements.ts — add an element with a new emoji and the
// next build has the glyph. The shipping build cannot afford 250 KB of font in
// a 13 KB budget, so it names a hosted one instead, at a URL fixed in
// rollup.config.mjs:
//
//   @font-face{font-family:e;src:url(//joseprio.github.io/color-alchemy/emoji.ttf)}
//
// Nothing in the build writes that file. So every time the element table gains
// an emoji, the shipped game silently falls back to the player's own set for it
// — not broken, just not the artwork the rest of the board is drawn in — until
// somebody regenerates the subset and republishes it. This is that step, made
// one command instead of a hunt through a hash-named cache.
//
// PUBLISHED FROM THIS REPO, which is the point of using this project's Pages
// path rather than the shorter user-site one. The short URL was measured at
// about 8 B and given back: it put the served file in a second repository, and
// a two-repo publish step is one more place for the staleness this header
// warns about to creep in. rollup.config.mjs records that trade.
//
// THE NAME IS NOT A CHOICE. The @font-face above asks for `emoji.ttf` exactly;
// the file has to be served under that name for any of this to work. The build
// writes it as emoji-<hash>.ttf, where the hash is over the emoji set, so the
// source name changes whenever the table does and is found rather than assumed.
//
// A TTF, NOT A WOFF2, and the difference is a download rather than a byte of
// budget: the shipping build only ever NAMES this URL, so the 13312 never sees
// the font at all, but a player who presses Load emoji font now pulls 549 KB
// instead of 255 KB — 352 KB of it on the wire, measured against Pages, which
// serves this as font/ttf with Content-Encoding: gzip. Leave the old emoji.woff2 served alongside it for as long as any
// published build still asks for that name.
import { copyFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const FROM = "dist/fonts";
const TO = "emoji.ttf";

const found = readdirSync(FROM).filter((f) => /^emoji-[0-9a-f]+\.ttf$/.test(f));
if (found.length !== 1) {
  throw new Error(
    found.length
      ? `expected one emoji-*.ttf in ${FROM}, found ${found.length}: ${found.join(", ")}`
      : `no emoji-*.ttf in ${FROM} — run \`npm run build-director\` first`
  );
}

const src = join(FROM, found[0]);
copyFileSync(src, TO);
console.log(`emoji-publish: ${src} -> ${TO}, ${(statSync(TO).size / 1024).toFixed(0)} KB`);
console.log("emoji-publish: publish it at joseprio.github.io/color-alchemy/emoji.ttf");

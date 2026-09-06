// Reorder the ELEMENTS table, and the recipe data inside it, for the packer.
//
// THREE THINGS MOVE HERE and none of them is visible to the game:
//
//   1. PAIR ORIENTATION. `RECIPE[[...p].sort().join("+")]` in src/elements.ts
//      sorts a pair at runtime, so ["red","green"] and ["green","red"] are the
//      same fact and every one of the 529 pairs carries a free bit. Sorting a
//      pair by table index — which IS code order, because enc() is monotone in
//      the index — is worth 34 B measured.
//   2. RECIPE LIST ORDER. The 138 elements with alternates carry them in an
//      array nothing reads positionally; sorting those by code is a further
//      18 B.
//   3. THE TABLE PERMUTATION ITSELF, which is the searched artifact in
//      element-order.json, fitted by `npm run element-order-optimize`.
//
// 1 and 2 are RULES and they WIN, which is the opposite of the fn-order
// finding (tools/fn-order.mjs: every rule-based function ordering lost, so only
// a search was left). The difference is that these two rules are not chasing
// "similar things near each other" — they make the FIRST CHARACTER of a code
// nearly constant, because 300 elements over RECIPE_BASE 92 means the high
// character only ever takes four values. A near-constant byte is one roadroller
// predicts for almost nothing.
//
// THE PERMUTATION IS NOT A RULE, and the incumbent is strong: src/elements.ts
// is hand-ordered so an element sits next to the ids it is built from, and a
// random permutation of the 283 non-colour entries costs 208 B. Rules measured
// against it: reversed +60, alphabetical +75. So this ships the same way
// fn-order does — a stored order, applied only when it matches, a no-op when
// it does not.
//
// UNLIKE fn-order THIS IS NOT LENGTH-PRESERVING. Moving an element changes its
// code, and 35 + 57 is a backslash, so a code that lands on index 57, 149 or
// 241 costs an extra character everywhere it is referenced. The invariant that
// replaces "same length" is semantic and checked below: the same 300 ids, and
// the same recipes, decoded back to ids.
import { existsSync, readFileSync } from "fs";
import * as espree from "espree";

const PARSE_OPTS = { ecmaVersion: 2021, range: true, sourceType: "script" };

// MUST STAY IDENTICAL to rollup.config.mjs's copy. These are the two halves of
// one encoding: the plugin writes the codes, this rewrites them, and the
// runtime decoder in the same plugin reads them back through ELEMENTS[n].
const RECIPE_BASE = 92;
const enc = (n) =>
  String.fromCharCode(35 + ((n / RECIPE_BASE) | 0)) + String.fromCharCode(35 + (n % RECIPE_BASE));
const dec = (s) => RECIPE_BASE * (s.charCodeAt(0) - 35) + s.charCodeAt(1) - 35;

// COLORS in src/game.ts. `ELEMENTS.slice(0, COLORS)` is the colour quest's
// slice and the ONE place the runtime reads this table by position, so nothing
// may move into or out of that block. check.mjs pins both of its ends.
export const PINNED = 17;

const propOf = (obj, name) =>
  obj.properties.find((p) => !p.computed && (p.key.name ?? p.key.value) === name);

// The elements array, its entries, and their recipes — or null when the chunk
// does not hold exactly one table this pass can speak for. Every bail is
// silent-safe: the caller ships the chunk as it stands.
export function elementTable(code) {
  const ast = espree.parse(code, PARSE_OPTS);
  const found = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (
      n.type === "ArrayExpression" &&
      n.elements.length > 50 &&
      n.elements.every(
        (e) => e && e.type === "ObjectExpression" && propOf(e, "id")?.value.type === "Literal"
      )
    ) {
      found.push(n);
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && v.type) walk(v);
    }
  })(ast);
  // Two tables would mean guessing which one the decoder indexes into.
  if (found.length !== 1) return null;
  const node = found[0];

  const entries = node.elements.map((el) => {
    const r = propOf(el, "r");
    return {
      id: propOf(el, "id").value.value,
      range: el.range,
      r: r && {
        range: r.value.range,
        pairs: r.value.elements.map((p) => p.elements.map((l) => l.value)),
      },
    };
  });
  // The recipes are two-character codes only in a golfed build; anywhere else
  // they are still words and this pass has nothing to say about them.
  const codes = entries.flatMap((e) => (e.r ? e.r.pairs.flat() : []));
  if (!codes.length) return null;
  const ok = codes.every(
    (c) => typeof c === "string" && c.length === 2 && dec(c) >= 0 && dec(c) < entries.length
  );
  if (!ok) return null;
  return { range: node.range, entries };
}

// What the game will see, independent of how any of it is spelled: the ids, and
// every recipe decoded back to a sorted pair of ids. Two chunks with the same
// fingerprint run the same game.
export function fingerprint(table) {
  const ids = table.entries.map((e) => e.id);
  return JSON.stringify(
    table.entries.map((e) => [
      e.id,
      (e.r ? e.r.pairs.map((p) => p.map((c) => ids[dec(c)]).sort().join("+")) : []).sort(),
    ]).sort()
  );
}

// Rewrite the table with its entries in `order` (a permutation of the ids), and
// the two recipe rules applied against the resulting indices. No reparse: the
// search calls this thousands of times.
export function renderElements(code, table, order) {
  const pos = new Map(order.map((id, k) => [id, k]));
  const byId = new Map(table.entries.map((e) => [e.id, e]));
  const ids = table.entries.map((e) => e.id);

  const parts = order.map((id) => {
    const e = byId.get(id);
    let text = code.slice(e.range[0], e.range[1]);
    if (e.r) {
      const pairs = e.r.pairs
        .map((p) => p.map((c) => ids[dec(c)]).sort((a, b) => pos.get(a) - pos.get(b)))
        .sort((a, b) => pos.get(a[0]) - pos.get(b[0]) || pos.get(a[1]) - pos.get(b[1]));
      const rendered =
        "[" +
        pairs.map((p) => "[" + p.map((x) => JSON.stringify(enc(pos.get(x)))).join(",") + "]").join(",") +
        "]";
      text =
        text.slice(0, e.r.range[0] - e.range[0]) + rendered + text.slice(e.r.range[1] - e.range[0]);
    }
    return text;
  });
  return code.slice(0, table.range[0]) + "[" + parts.join(",") + "]" + code.slice(table.range[1]);
}

// The build's entry point. Applies the rules always and the stored permutation
// when it matches this table; verifies the result against the fingerprint
// before handing it back, because a table this pass got wrong would still parse
// and still run — it would just be a different game.
export function reorderElements(code, log = () => {}) {
  const table = elementTable(code);
  if (!table) return code;
  const here = table.entries.map((e) => e.id);
  let order = here;

  if (existsSync("element-order.json")) {
    const stored = JSON.parse(readFileSync("element-order.json", "utf8")).order;
    const set = new Set(here);
    const same =
      Array.isArray(stored) &&
      stored.length === here.length &&
      new Set(stored).size === stored.length &&
      stored.every((id) => set.has(id));
    if (!same) {
      // console.warn, not the optional log: quietly shipping the unordered
      // table is a regression nothing else in the build reports.
      console.warn(
        `element-order: element-order.json does not match this table ` +
        `(${Array.isArray(stored) ? stored.length : "?"} stored, ${here.length} found) — NOT reordering.\n` +
        `               re-fit with: npm run element-order-optimize`
      );
    } else if (stored.slice(0, PINNED).join() !== here.slice(0, PINNED).join()) {
      throw new Error(
        `element-order: the stored order moves the first ${PINNED} entries, which are ` +
        `ELEMENTS.slice(0, COLORS) — the colour quest would change shape`
      );
    } else {
      order = stored;
    }
  }

  const out = renderElements(code, table, order);
  const after = elementTable(out);
  if (!after || fingerprint(after) !== fingerprint(table)) {
    throw new Error("element-order: the rewritten table is not the same game — refusing to ship it");
  }
  const pairs = table.entries.reduce((n, e) => n + (e.r ? e.r.pairs.length : 0), 0);
  log(
    `element-order: ${here.length} entries${order === here ? " in chunk order" : " in the fitted order"}` +
    `, ${pairs} recipe pairs oriented`
  );
  return out;
}

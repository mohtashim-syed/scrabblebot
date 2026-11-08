// Run with `npm test`.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Brain, DEFAULT_PARAMS } from "./brain.ts";
import { BAG, Lexicon, bestPartition, multiplied, rackFrom, rackString } from "./lexicon.ts";
import { Player } from "./player.ts";
import { TUNED_PARAMS } from "./tuned.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lex = new Lexicon(fs.readFileSync(path.join(root, "wordlist.txt"), "utf8").split("\n"));
const brain = new Brain(lex, { ...DEFAULT_PARAMS, ...TUNED_PARAMS });

test("reward matches the module's length multiplier (integer division)", () => {
  assert.equal(multiplied(7, 3), 7);
  assert.equal(multiplied(7, 4), 10); // 7*3/2 = 10.5 -> 10
  assert.equal(multiplied(7, 5), 14);
  assert.equal(multiplied(7, 6), 17); // 17.5 -> 17
  assert.equal(multiplied(7, 7), 21);
  assert.equal(multiplied(7, 9), 21);
});

test("lexicon finds words that fit a rack, and only those", () => {
  const found = lex.fitting(rackFrom("RETAINS"), 7).map((i) => lex.word[i]);
  assert.ok(found.length === 1, `one 7-letter alphagram, got ${found}`);
  assert.ok(lex.isWordKey("NASTIER"));
  assert.ok(!lex.isWordKey("QXZ"));
  for (const i of lex.fitting(rackFrom("QUIZXYEA"), 2)) {
    const r = rackFrom("QUIZXYEA");
    for (const ch of lex.word[i]) assert.ok(r[ch.charCodeAt(0) - 65]-- > 0);
  }
});

test("partition uses disjoint letters and beats any single word", () => {
  const rack = rackFrom("RETAINSQUIZ");
  const { score, words } = bestPartition(lex, rack, 500);
  const r = Int8Array.from(rack);
  for (const w of words) lex.take(r, w);
  for (let c = 0; c < 26; c++) assert.ok(r[c] >= 0, "overused " + rackString(rack));
  assert.ok(score >= 21 + 21, `expected bingo + QUIZ-ish, got ${score} ${words.map((i) => lex.word[i])}`);
});

test("final auction: never bids, and dumps the whole rack's best partition", () => {
  const p = new Player(brain, "ME");
  p.startingRack([..."RETAINSAB"].map((c) => c.charCodeAt(0) - 65));
  assert.equal(p.decideBid(4, 0), 0);
  const words = p.decideWords(0);
  assert.ok(words.length >= 1);
  for (const w of words) assert.ok(lex.isWordKey(w));
});

test("bids stay within balance and value a bingo-completing letter highly", () => {
  const p = new Player(brain, "ME");
  p.startingRack([..."RETAIN"].map((c) => c.charCodeAt(0) - 65));
  p.balance = 60;
  const s = p.decideBid("S".charCodeAt(0) - 65, 30);
  const q = p.decideBid("Q".charCodeAt(0) - 65, 30); // QINTAR: 37 points on the spot
  assert.ok(s <= 60 && q <= 60);
  assert.ok(q >= s, `Q (${q}) makes QINTAR, should be worth at least S (${s})`);
  assert.ok(s >= 10, `completing RETAINS should be worth a real bid, got ${s}`);
  p.balance = 0;
  assert.equal(p.decideBid("S".charCodeAt(0) - 65, 30), 0);
});

test("decisions are fast enough for a 1-second auction", () => {
  const p = new Player(brain, "ME");
  p.startingRack([..."AEINRSTLO"].map((c) => c.charCodeAt(0) - 65));
  p.unseen = Float64Array.from(BAG);
  const t = performance.now();
  for (let c = 0; c < 26; c++) p.decideBid(c, 40);
  p.decideWords(40);
  assert.ok((performance.now() - t) / 27 < 60, "decision took too long");
});

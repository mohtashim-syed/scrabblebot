// Offline match simulator mirroring spacetimedb/src/game.ts rules, plus a
// replay benchmark against real recorded auctions.
//
//   node sim/sim.ts field  <games> [paramsJSON]   — me vs a mixed field of bots
//   node sim/sim.ts replay <games> <dataDir> [paramsJSON] — me vs recorded live prices

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Brain, DEFAULT_PARAMS, type Params } from "../src/engine/brain.ts";
import { BAG, FACE, Lexicon, type Rack } from "../src/engine/lexicon.ts";
import { Player } from "../src/engine/player.ts";
import { blendPrices } from "../src/engine/market.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKET_TABLE = JSON.parse(fs.readFileSync(path.join(here, "..", "src", "engine", "market-table.json"), "utf8"));
export const LEX = new Lexicon(
  fs.readFileSync(path.join(here, "..", "wordlist.txt"), "utf8").split("\n"),
);

// Seeded RNG so experiments are reproducible.
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// ---------- Opponent bots ----------

interface Bot {
  name: string;
  start(tiles: number[]): void;
  bid(letter: number, bagTotal: number): number;
  result(letter: number, winner: string | null, paid: number): void;
  wordBy(by: string, word: string): void;
  words(bagTotal: number): string[];
  balance(): number;
}

class BrainBot implements Bot {
  pl: Player;
  constructor(
    readonly name: string,
    params: Params,
  ) {
    this.pl = new Player(new Brain(LEX, params), name);
  }
  start(t: number[]) {
    this.pl.startingRack(t);
  }
  bid(l: number, b: number) {
    this.pl.revealed(l);
    return this.pl.decideBid(l, b);
  }
  result(l: number, w: string | null, p: number) {
    this.pl.auctionWon(l, w, p);
  }
  wordBy(by: string, word: string) {
    this.pl.wordPlayed(by, word);
  }
  words(b: number) {
    return this.pl.decideWords(b);
  }
  balance() {
    return this.pl.balance;
  }
}

/** Common base for simple bots that just track their rack/balance. */
abstract class SimpleBot implements Bot {
  rack: Rack = new Int8Array(26);
  bal = 100;
  constructor(readonly name: string) {}
  start(t: number[]) {
    for (const c of t) this.rack[c]++;
  }
  abstract bid(l: number, b: number): number;
  result(l: number, w: string | null, p: number) {
    if (w === this.name) {
      this.rack[l]++;
      this.bal -= p;
    }
  }
  wordBy() {}
  abstract words(b: number): string[];
  balance() {
    return this.bal;
  }
  protected playIdx(i: number): string {
    LEX.take(this.rack, i);
    this.bal += LEX.reward[i];
    return LEX.word[i];
  }
  protected longest(minLen: number): number {
    const f = LEX.fitting(this.rack, minLen);
    let best = -1;
    for (const i of f) if (best < 0 || LEX.len[i] > LEX.len[best] || (LEX.len[i] === LEX.len[best] && LEX.reward[i] > LEX.reward[best])) best = i;
    return best;
  }
}

/** The repo's bot-starter strategy. */
class StarterBot extends SimpleBot {
  bid(l: number) {
    const want = this.rack[l] === 0 ? FACE[l] + 2 : Math.max(1, FACE[l]);
    return Math.min(want, Math.max(0, this.bal));
  }
  words() {
    const i = this.longest(2);
    return i < 0 ? [] : [this.playIdx(i)];
  }
}

/** The module's built-in simulated bots. */
class ModuleSim extends SimpleBot {
  constructor(
    name: string,
    readonly kind: "cheap" | "value" | "aggr",
    readonly r: () => number,
  ) {
    super(name);
  }
  bid(l: number) {
    const v = FACE[l];
    const vowel = [0, 4, 8, 14, 20].includes(l);
    const base = this.kind === "cheap" ? v - 1 : this.kind === "value" ? v : v + (vowel ? 4 : 2);
    const jitter = Math.floor(this.r() * 5) - 2;
    return Math.max(Math.min(Math.max(base + jitter, 1), this.bal), 0);
  }
  result(l: number, w: string | null, p: number) {
    super.result(l, w, p);
  }
  words() {
    const i = this.longest(3);
    return i < 0 ? [] : [this.playIdx(i)];
  }
}

/** A typical decent field bot: holds for 7+ letter words, bids a fixed premium table, dumps at the end. */
class BingoHunter extends SimpleBot {
  constructor(
    name: string,
    readonly scale: number,
    readonly r: () => number,
  ) {
    super(name);
  }
  bid(l: number, bagTotal: number) {
    if (bagTotal <= 0) return 0;
    // value letters at ~market, plus a premium for letters that fit a near-complete 7
    let v = [9, 12, 13, 10, 9, 14, 9, 15, 8, 24, 18, 8, 12, 8, 8, 12, 22, 8, 9, 7, 8, 13, 14, 25, 16, 28][l];
    v *= this.scale * (0.85 + 0.3 * this.r());
    if (this.rack[l] >= 2) v *= 0.5;
    if (bagTotal < 6) v *= 1.5;
    return Math.max(0, Math.min(this.bal, Math.round(v)));
  }
  words(bagTotal: number) {
    if (bagTotal <= 0) {
      const out: string[] = [];
      for (;;) {
        const i = this.longest(2);
        if (i < 0) break;
        out.push(this.playIdx(i));
      }
      return out;
    }
    const i = this.longest(7);
    return i < 0 ? [] : [this.playIdx(i)];
  }
}

// ---------- Match engine ----------

function playMatch(bots: Bot[], r: () => number): Map<string, number> {
  const bag = Int8Array.from(BAG);
  let bagTotal = 98;
  const draw = (): number => {
    let k = Math.floor(r() * bagTotal);
    for (let c = 0; c < 26; c++) {
      if (k < bag[c]) {
        bag[c]--;
        bagTotal--;
        return c;
      }
      k -= bag[c];
    }
    throw new Error("empty");
  };
  const score = new Map<string, number>();
  for (const b of bots) {
    score.set(b.name, 0);
    const t = [draw(), draw(), draw(), draw(), draw()];
    b.start(t);
  }
  const announce = (by: Bot, words: string[]) => {
    for (const w of words) {
      if (!LEX.isWordKey(w)) throw new Error(`${by.name} played non-word ${w}`);
      score.set(by.name, score.get(by.name)! + rewardOfWord(w));
      for (const o of bots) if (o !== by) o.wordBy(by.name, w);
    }
  };
  for (const b of bots) announce(b, b.words(bagTotal));
  while (bagTotal > 0) {
    const letter = draw();
    const bids = bots.map((b) => ({ b, amt: Math.min(b.balance(), Math.max(0, Math.floor(b.bid(letter, bagTotal)))) }));
    const live = bids.filter((x) => x.amt > 0);
    for (let i = live.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [live[i], live[j]] = [live[j], live[i]];
    }
    live.sort((a, b) => b.amt - a.amt);
    let winner: string | null = null;
    let paid = 0;
    if (live.length) {
      winner = live[0].b.name;
      paid = live.length > 1 ? live[1].amt : Math.min(1, live[0].amt);
    }
    for (const b of bots) b.result(letter, winner, paid);
    // next auction opens with bagTotal tiles still in the bag
    for (const b of bots) announce(b, b.words(bagTotal));
  }
  return score;
}

function rewardOfWord(w: string): number {
  let base = 0;
  for (const ch of w) base += FACE[ch.charCodeAt(0) - 65];
  const L = w.length;
  if (L <= 3) return base;
  if (L === 4) return Math.floor((base * 3) / 2);
  if (L === 5) return base * 2;
  if (L === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// ---------- Experiments ----------

export function runField(games: number, mine: Params, seed = 1, fieldKind = "mixed") {
  const r = rng(seed);
  let tot = 0;
  let wins = 0;
  let rankSum = 0;
  const others: Record<string, number> = {};
  for (let g = 0; g < games; g++) {
    const bots: Bot[] = [new BrainBot("ME", mine)];
    if (fieldKind === "mixed") {
      bots.push(new BingoHunter("Hunter1", 1.0, r), new BingoHunter("Hunter2", 1.15, r));
      bots.push(new BrainBot("Base1", DEFAULT_PARAMS), new BrainBot("Base2", { ...DEFAULT_PARAMS, bidMult: 1.2 }));
      bots.push(new StarterBot("Starter"));
    } else if (fieldKind === "sims") {
      bots.push(new ModuleSim("Cheap", "cheap", r), new ModuleSim("Value", "value", r), new ModuleSim("Aggr", "aggr", r));
      bots.push(new ModuleSim("Aggr2", "aggr", r), new ModuleSim("Value2", "value", r));
    } else if (fieldKind === "hunters") {
      for (let i = 0; i < 5; i++) bots.push(new BingoHunter("H" + i, 0.9 + 0.1 * i, r));
    } else if (fieldKind === "self") {
      for (let i = 0; i < 5; i++) bots.push(new BrainBot("B" + i, DEFAULT_PARAMS));
    }
    const s = playMatch(bots, r);
    const me = s.get("ME")!;
    tot += me;
    const sorted = [...s.values()].sort((a, b) => b - a);
    rankSum += sorted.indexOf(me) + 1;
    if (me >= sorted[0]) wins++;
    for (const [k, v] of s) if (k !== "ME") others[k] = (others[k] ?? 0) + v;
  }
  for (const k in others) others[k] = Math.round(others[k] / games);
  return { avg: tot / games, win: wins / games, rank: rankSum / games, others };
}

interface Hist {
  letters: number[];
  facing: number[]; // highest bid among the other five seats
  paid: number[]; // price actually paid (public during the match)
  start: number[]; // the 30 tiles dealt at the start (not auctioned)
  seatScore: number; // what the real bot in our seat scored
  seatName: string;
  bestOther: number; // best score among the other five seats
  others: number[]; // the other five seats' scores
}

export function loadHistory(dir: string, lastN: number): Hist[] {
  const J = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n + ".json"), "utf8"));
  const bots = new Map<number, boolean>(J("bots").map((b: any) => [b.id, b.is_simulated]));
  const top = new Map<number, number>(J("topbids").map((t: any) => [t.auction_id, t.top_bid]));
  const byM = new Map<number, any[]>();
  for (const a of J("auctions")) {
    if (!byM.has(a.match_id)) byM.set(a.match_id, []);
    byM.get(a.match_id)!.push(a);
  }
  const parts = new Map<number, any[]>();
  for (const p of J("participants")) {
    if (!parts.has(p.match_id)) parts.set(p.match_id, []);
    parts.get(p.match_id)!.push(p);
  }
  const names = new Map<number, string>(J("bots").map((b: any) => [b.id, b.name]));
  const ids = [...byM.keys()].filter((m) => parts.has(m) && byM.get(m)!.length === 68).sort((a, b) => a - b);
  return ids.slice(-lastN).map((m) => {
    const lst = byM.get(m)!.sort((a, b) => a.auction_id - b.auction_id);
    const left = Int8Array.from(BAG);
    for (const a of lst) left[a.letter.charCodeAt(0) - 65]--;
    const start: number[] = [];
    for (let c = 0; c < 26; c++) for (let k = 0; k < left[c]; k++) start.push(c);
    const ps = parts.get(m)!;
    // Take over one real bot's seat (deterministic per match).
    const real = ps.filter((p: any) => !bots.get(p.bot_id));
    const seat = (real.length ? real : ps)[m % (real.length || ps.length)];
    const facing = lst.map((a) => {
      if (a.winner_bot_id == null) return 0;
      if (a.winner_bot_id === seat.bot_id) return a.paid <= 1 ? 0 : a.paid; // runner-up's bid
      return top.get(a.auction_id) ?? a.paid;
    });
    return {
      letters: lst.map((a) => a.letter.charCodeAt(0) - 65),
      facing,
      paid: lst.map((a) => (a.winner_bot_id == null ? 0 : a.paid)),
      start,
      seatScore: seat.score,
      seatName: names.get(seat.bot_id) ?? "?",
      bestOther: Math.max(...ps.filter((p: any) => p !== seat).map((p: any) => p.score)),
      others: ps.filter((p: any) => p !== seat).map((p: any) => p.score),
    };
  });
}

/** Me in a real bot's seat, facing the other five seats' recorded bids (their scores held fixed). */
export function runReplay(hist: Hist[], mine: Params, seed = 1, price?: Float64Array) {
  const r = rng(seed);
  let tot = 0;
  let seatTot = 0;
  let wins = 0;
  let seatWins = 0;
  let beatSeat = 0;
  let letters = 0;
  let spent = 0;
  let leftover = 0;
  let leftTiles = 0;
  let place = 0;
  let seatPlace = 0;
  for (const h of hist) {
    const brain = new Brain(LEX, mine);
    if (price) brain.price = price;
    brain.setMarketTable(MARKET_TABLE);
    const p = new Player(brain, "ME");
    const pool = [...h.start];
    const mine5: number[] = [];
    for (let k = 0; k < 5; k++) mine5.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    p.startingRack(mine5);
    let score = 0;
    const play = (bag: number) => {
      for (const w of p.decideWords(bag)) score += rewardOfWord(w);
    };
    play(68);
    for (let i = 0; i < 68; i++) {
      const bag = 67 - i;
      const c = h.letters[i];
      p.revealed(c);
      const b = Math.min(p.balance, p.decideBid(c, bag));
      const t = h.facing[i];
      const win = b > 0 && (b > t || (b === t && r() < 0.5));
      if (win) {
        const price = t > 0 ? t : 1;
        p.auctionWon(c, "ME", price);
        letters++;
        spent += price;
      } else p.auctionWon(c, "OTHER", t);
      p.observe(c, bag, h.paid[i]);
      play(bag);
    }
    tot += score;
    seatTot += h.seatScore;
    leftover += p.balance;
    for (let c = 0; c < 26; c++) leftTiles += p.rack[c];
    if (score > h.bestOther) wins++;
    place += 1 + h.others.filter((o) => o > score).length;
    seatPlace += 1 + h.others.filter((o) => o > h.seatScore).length;
    if (h.seatScore > h.bestOther) seatWins++;
    if (score > h.seatScore) beatSeat++;
  }
  const n = hist.length;
  const f = (x: number) => Math.round((x / n) * 100) / 100;
  return {
    avg: f(tot), seatAvg: f(seatTot), win: f(wins), seatWin: f(seatWins), beatSeat: f(beatSeat),
    place: f(place), seatPlace: f(seatPlace),
    letters: f(letters), spent: f(spent), leftoverCoins: f(leftover), leftoverTiles: f(leftTiles),
  };
}

/** Mean paid prices from a data dir's recorded auctions (what the live bot would measure). */
export function pricesFromDir(dir: string): Float64Array {
  const auc = JSON.parse(fs.readFileSync(path.join(dir, "auctions.json"), "utf8"));
  return blendPrices(auc.filter((a: any) => a.winner_bot_id != null).map((a: any) => [a.letter.charCodeAt(0) - 65, a.paid]));
}

// ---------- CLI ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const games = Number(process.argv[3] ?? 50);
  const t0 = performance.now();
  if (mode === "replay") {
    const hist = loadHistory(process.argv[4], games);
    const params = { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[5] ?? "{}") };
    console.log(runReplay(hist, params));
  } else {
    const params = { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[4] ?? "{}") };
    console.log(runField(games, params, 7, mode));
  }
  console.log(`${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

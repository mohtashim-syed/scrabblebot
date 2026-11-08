// The decision core: values racks, bids on letters, decides which words to
// play and when. Pure logic, no networking, so the simulator and the live
// bot run exactly the same code.

import { BAG, FACE, Lexicon, bestPartition, rackSize, type Rack } from "./lexicon.ts";
import { Market, type MarketTable } from "./market.ts";

// Mean price paid per letter in strong (all-real-bot) matches, measured from
// ~1,200 live matches. Used as the expected cost of letters we still need.
export const MARKET_PRICE = [
  8.4, 12.1, 13.1, 10.4, 8.6, 14.1, 9.4, 15.6, 7.9, 22.2, 17.8, 7.8, 12.5, 7.7, 7.9, 12.3, 20.6,
  8.0, 8.8, 7.4, 7.9, 12.8, 13.8, 23.0, 15.7, 26.8,
];

export interface Params {
  minTarget: number; // shortest target word length considered
  maxTarget: number; // longest target word length considered
  maxNeed: number; // most missing letters a target may have
  winProb: number; // chance we win any given needed letter when it shows up
  priceMult: number; // scale on MARKET_PRICE for needed letters
  leave: number; // value of an unplanned letter, as a fraction of its face value
  lambda0: number; // value of a coin in points when budget and opportunities balance
  spendRate: number; // coins we can usefully spend per remaining auction
  lambdaPow: number; // curvature of coin value as money piles up
  lambdaMin: number; // floor on coin value
  midPlayLen: number; // shortest word worth playing before the endgame
  secondTarget: number; // weight on a second, disjoint target word
  endgameF: number; // with this few usable auctions left, value racks exactly
  liquidity: number; // bonus (× coin value) for converting tiles to cash now
  bidMult: number; // final scale on the truthful bid
  softTau: number; // >0: value the spread of good targets (log-sum-exp), not just the best
  budgetCurve: number; // 1: price each coin of a bid at the balance left after spending it
  qPow: number; // <1 favours long-shot, high-value targets (more variance, higher ceiling)
  useMarket: number; // 1: per-letter, per-phase win chance and price from the market table
  resMult: number; // reservation price for needed letters, × the median competing bid
  matchAdapt: number; // 0..1: how far to trust this match's observed prices over the table
  budgetFeas: number; // >0: discount targets whose missing letters cost more than we can pay (exponent)
  incomeAllow: number; // coins of future income counted as spendable when checking affordability
  leaveHV: number; // leave value of an unplanned high-value letter (face >= 4), × its usual value
}

export const DEFAULT_PARAMS: Params = {
  minTarget: 5,
  maxTarget: 8,
  maxNeed: 4,
  winProb: 0.55,
  priceMult: 1.0,
  leave: 0.5,
  lambda0: 0.5,
  spendRate: 4,
  lambdaPow: 1.0,
  lambdaMin: 0.03,
  midPlayLen: 7,
  secondTarget: 0.5,
  endgameF: 2,
  liquidity: 0.1,
  bidMult: 1.0,
  softTau: 0,
  budgetCurve: 0,
  qPow: 1,
  useMarket: 0,
  resMult: 1.3,
  matchAdapt: 0.5,
  budgetFeas: 0,
  incomeAllow: 0,
  leaveHV: 1,
};

export interface View {
  rack: Rack; // our tiles
  balance: number;
  unseen: Float64Array; // letters not yet seen anywhere (bag + hidden opponent tiles)
  usableFuture: number; // future auctions (after the current one) whose letters can still be played
  priceScale?: number; // this match's prices relative to the market table (1 = typical)
}

function poissonTail(m: number, n: number): number {
  // P(X >= n), X ~ Poisson(m)
  if (n <= 0) return 1;
  let term = Math.exp(-m);
  let cdf = term;
  for (let i = 1; i < n; i++) {
    term *= m / i;
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

interface Scored {
  gain: number;
  idx: number;
}

export class Brain {
  /** Expected price per letter; the live bot recalibrates this from recent auctions. */
  price: Float64Array = Float64Array.from(MARKET_PRICE);
  market: Market | null = null;
  /** Leave value per held letter: `leave` × face, discounted for awkward high-value letters. */
  private lv = new Float64Array(26);

  /** Use the per-letter, per-phase market table (when `useMarket` is on). */
  setMarketTable(table: MarketTable) {
    this.market = new Market(table, this.p.resMult);
  }

  private marketNow(v: View) {
    return this.market && this.p.useMarket ? this.market.future(v.usableFuture + 1) : null;
  }

  constructor(
    readonly lex: Lexicon,
    readonly p: Params = DEFAULT_PARAMS,
  ) {
    for (let c = 0; c < 26; c++) this.lv[c] = p.leave * FACE[c] * (FACE[c] >= 4 ? p.leaveHV : 1);
  }

  /**
   * Shadow price of a coin, in points. Unspent coins are worth nothing at the
   * end, so like budget pacing in ad auctions we lower the coin's value
   * (bidding more boldly) when we hold more money than the remaining
   * auctions can absorb, and raise it when money is scarce.
   */
  lambda(v: View): number {
    if (v.usableFuture <= 0) return this.p.lambdaMin;
    const cap = v.usableFuture * this.p.spendRate;
    const ratio = cap / Math.max(1, v.balance);
    const lam = this.p.lambda0 * Math.pow(ratio, this.p.lambdaPow);
    return Math.min(1, Math.max(this.p.lambdaMin, lam));
  }

  /** acq[l*5+n] = P(acquire >= n more copies of letter l before the end) */
  private acquisition(v: View): Float64Array {
    const acq = new Float64Array(26 * 5);
    let tot = 0;
    for (let i = 0; i < 26; i++) tot += v.unseen[i];
    const mk = this.marketNow(v);
    for (let l = 0; l < 26; l++) {
      const w = mk ? mk.win[l] : this.p.winProb;
      const m = tot > 0 ? (v.usableFuture * v.unseen[l] * w) / tot : 0;
      for (let n = 0; n < 5; n++) acq[l * 5 + n] = n === 0 ? 1 : n > v.unseen[l] ? 0 : poissonTail(m, n);
    }
    return acq;
  }

  /**
   * Scan target words; return best gains. gain(A) = q·(reward − λ·cost − leave(used)),
   * the improvement over just holding the letters.
   */
  private scan(rack: Rack, v: View, lam: number, acq: Float64Array, top: number): Scored[] {
    const { lex, p } = this;
    const [a, b] = lex.lenRange(p.minTarget, p.maxTarget);
    const maxNeed = Math.min(p.maxNeed, v.usableFuture);
    const best: Scored[] = [];
    let floor = 0;
    const L = lex.letters;
    const M = lex.mask;
    const mk = this.marketNow(v);
    let price = this.price;
    if (mk) {
      const sc = Math.pow(v.priceScale ?? 1, p.matchAdapt);
      price = mk.cost.map((x) => x * sc);
    }
    const lv = this.lv;
    const feas = p.budgetFeas;
    const budget = Math.max(0, v.balance) + p.incomeAllow;
    const sc0 = p.priceMult;
    let rackMask = 0;
    for (let c = 0; c < 26; c++) if (rack[c] > 0) rackMask |= 1 << c;
    const absent = ~rackMask;
    for (let i = a; i < b; i++) {
      // each distinct letter we lack costs at least one needed tile
      let m = M[i] & absent;
      if (m !== 0) {
        m = m - ((m >>> 1) & 0x55555555);
        m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
        if ((((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24 > maxNeed) continue;
      }
      const s = lex.off[i];
      const e = lex.off[i + 1];
      let need = 0;
      let q = 1;
      let cost = 0;
      let usedLeave = 0;
      let j = s;
      let ok = true;
      while (j < e) {
        const c = L[j];
        let run = 1;
        while (j + run < e && L[j + run] === c) run++;
        j += run;
        const have = rack[c];
        if (run > have) {
          const d = run - have;
          need += d;
          if (need > maxNeed) {
            ok = false;
            break;
          }
          q *= acq[c * 5 + d];
          cost += d * price[c];
          usedLeave += have * lv[c];
        } else usedLeave += run * lv[c];
      }
      if (!ok || q <= 0) continue;
      if (p.qPow !== 1) q = Math.pow(q, p.qPow);
      if (feas > 0 && cost > 0) {
        // can we actually pay for the missing letters?
        const afford = budget / (cost * sc0);
        if (afford < 1) q *= Math.pow(afford, feas);
      }
      const gain = q * (lex.reward[i] - lam * p.priceMult * cost - usedLeave);
      if (gain <= floor) continue;
      best.push({ gain, idx: i });
      if (best.length > top * 4) {
        best.sort((x, y) => y.gain - x.gain);
        best.length = top;
        floor = best[top - 1].gain;
      }
    }
    best.sort((x, y) => y.gain - x.gain);
    if (best.length > top) best.length = top;
    return best;
  }

  private leaveValue(rack: Rack): number {
    let s = 0;
    for (let i = 0; i < 26; i++) s += rack[i] * this.lv[i];
    return s;
  }

  /** How many of each held letter target `idx` would use. */
  private heldUse(idx: number, rack: Rack): Int8Array {
    const use = new Int8Array(26);
    for (let j = this.lex.off[idx]; j < this.lex.off[idx + 1]; j++) {
      const c = this.lex.letters[j];
      if (use[c] < rack[c]) use[c]++;
    }
    return use;
  }

  /** Expected eventual points from `rack` (coins converted at λ). */
  value(rack: Rack, v: View, lam = this.lambda(v)): number {
    const base = this.leaveValue(rack);
    if (v.usableFuture <= this.p.endgameF) {
      // Endgame: what we can surely dump, plus a cheap look at near-misses.
      const exact = bestPartition(this.lex, rack, 60).score;
      if (v.usableFuture === 0) return exact;
      const acq = this.acquisition(v);
      const g = this.scan(rack, v, lam, acq, 1);
      return Math.max(exact, base + (g[0]?.gain ?? 0));
    }
    const acq = this.acquisition(v);
    const tau = this.p.softTau;
    const pool = this.scan(rack, v, lam, acq, this.p.secondTarget > 0 ? 40 : 8);
    if (pool.length === 0) return base;
    const firsts = pool.slice(0, tau > 0 ? 8 : 3);
    const gains = firsts.map((f) => f.gain);
    if (this.p.secondTarget > 0 && rackSize(rack) >= 4) {
      // Second target: the best pool entry whose held tiles don't clash with
      // the first's. (A target that fits beside the first keeps the same
      // gain, so the best compatible one in the top 40 is the best overall.)
      const held = pool.map((t) => this.heldUse(t.idx, rack));
      for (let k = 0; k < Math.min(3, firsts.length); k++) {
        for (let j = 0; j < pool.length; j++) {
          if (j === k || pool[j].gain <= 0) continue;
          let ok = true;
          for (let c = 0; c < 26 && ok; c++) ok = held[k][c] + held[j][c] <= rack[c];
          if (!ok) continue;
          gains[k] += this.p.secondTarget * pool[j].gain;
          break;
        }
      }
    }
    let best = Math.max(...gains);
    if (tau > 0) {
      let z = 0;
      for (const g of gains) z += Math.exp((g - best) / tau);
      best += tau * Math.log(z);
    }
    return base + best;
  }

  /** Coins to bid for `letter` (0..balance). */
  bid(letter: number, v: View): number {
    if (v.balance <= 0) return 0;
    const lam = this.lambda(v);
    const before = this.value(v.rack, v, lam);
    v.rack[letter]++;
    let afterView = v;
    if (this.p.budgetFeas > 0) {
      // judge the bigger rack with the money we'd have left after paying for it
      const mk = this.marketNow(v);
      const est = mk ? mk.cost[letter] : this.price[letter];
      afterView = { ...v, balance: Math.max(0, v.balance - est) };
    }
    const after = this.value(v.rack, afterView, lam);
    v.rack[letter]--;
    const dv = this.p.bidMult * (after - before);
    if (dv <= 0) return 0;
    if (!this.p.budgetCurve) return Math.max(0, Math.min(v.balance, Math.floor(dv / lam)));
    // Pay coin by coin, each priced at the coin value of the balance left
    // after spending it: draining the budget gets steeply expensive, so one
    // letter can't starve us for the rest of the match.
    let spent = 0;
    let cost = 0;
    while (spent < v.balance) {
      const next = this.lambda({ ...v, balance: v.balance - spent - 0.5 });
      if (cost + next > dv) break;
      cost += next;
      spent++;
    }
    return spent;
  }

  /** Words to play right now (alphagram indices), possibly none. */
  plays(v: View): number[] {
    const { lex } = this;
    if (v.usableFuture < 0) {
      // Final auction is open: nothing more can arrive, dump everything.
      return bestPartition(lex, v.rack, 250).words;
    }
    const minLen = v.usableFuture <= this.p.endgameF + 4 ? 4 : this.p.midPlayLen;
    const out: number[] = [];
    const rack = Int8Array.from(v.rack);
    for (let round = 0; round < 3; round++) {
      const cands = lex.fitting(rack, minLen);
      if (cands.length === 0) break;
      const view = { ...v, rack };
      const hold = this.value(rack, view);
      cands.sort((a, b) => lex.reward[b] - lex.reward[a]);
      let bestIdx = -1;
      let bestVal = hold;
      for (const a of cands.slice(0, 8)) {
        // after playing, the coins are ours: re-value the rest at the new balance
        const after = { ...view, balance: v.balance + lex.reward[a] };
        lex.take(rack, a);
        const rest = this.value(rack, after);
        lex.give(rack, a);
        const val = lex.reward[a] * (1 + this.p.liquidity * this.lambda(view)) + rest;
        if (val > bestVal + 1e-9) {
          bestVal = val;
          bestIdx = a;
        }
      }
      if (bestIdx < 0) break;
      out.push(bestIdx);
      lex.take(rack, bestIdx);
      v = { ...v, balance: v.balance + lex.reward[bestIdx] };
    }
    return out;
  }
}

/** Unseen-letter bookkeeping from public information. */
export function freshUnseen(): Float64Array {
  return Float64Array.from(BAG);
}

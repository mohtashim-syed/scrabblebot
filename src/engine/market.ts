// Keeps the Brain's letter prices current. Prices drift as the field's bots
// change, so we re-measure mean paid prices from the last few hundred public
// auction results over SpacetimeDB's HTTP SQL endpoint.

import { MARKET_PRICE } from "./brain.ts";

export async function fetchRecentPrices(
  host: string,
  db: string,
  token: string | undefined,
  fromMatchId: bigint,
): Promise<Float64Array | null> {
  const res = await fetch(`${host}/v1/database/${db}/sql`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: `SELECT letter, paid FROM auction_result WHERE match_id >= ${fromMatchId}`,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { rows: [string, number][] }[];
  const rows = body[0]?.rows ?? [];
  return blendPrices(rows.map(([l, paid]) => [l.charCodeAt(0) - 65, Number(paid)]));
}

/** Mean paid per letter, shrunk toward the built-in table when samples are few. */
export function blendPrices(samples: [number, number][]): Float64Array {
  const sum = new Float64Array(26);
  const n = new Float64Array(26);
  for (const [c, paid] of samples) {
    if (c < 0 || c > 25 || paid <= 0) continue;
    sum[c] += paid;
    n[c]++;
  }
  const PRIOR = 20; // pseudo-samples of the built-in table
  const out = new Float64Array(26);
  for (let c = 0; c < 26; c++) out[c] = (sum[c] + PRIOR * MARKET_PRICE[c]) / (n[c] + PRIOR);
  return out;
}

// ---------- Opponent-aware market model ----------

export const MAX_BID = 80;

/** Match phase from tiles left in the bag: 0 = first third, 2 = last third. */
export function phaseOf(bag: number): number {
  return bag > 45 ? 0 : bag > 22 ? 1 : 2;
}

export interface MarketTable {
  hist: number[][]; // [letter*3+phase][bid] = how often the highest competing bid was `bid`
  paid?: number[]; // [letter*3+phase] mean price actually paid
}

/**
 * What it takes to win each letter. For a reservation price of `resMult` ×
 * the median competing bid, gives the chance of winning and the expected
 * price paid when we do, averaged over the phases of the auctions still to
 * come.
 */
export class Market {
  private win = new Float64Array(78);
  private cost = new Float64Array(78);
  private paid = new Float64Array(78);
  private cache = new Map<number, { win: Float64Array; cost: Float64Array }>();

  constructor(
    readonly table: MarketTable,
    readonly resMult: number,
  ) {
    for (let k = 0; k < 78; k++) {
      const h = table.hist[k];
      let n = 0;
      for (const x of h) n += x;
      let acc = 0;
      let med = 0;
      for (let b = 0; b < h.length; b++) {
        acc += h[b];
        if (acc >= n / 2) {
          med = b;
          break;
        }
      }
      const r = med * resMult;
      let w = 0;
      let s = 0;
      let mean = 0;
      for (let b = 0; b < h.length; b++) {
        mean += b * h[b];
        if (b < r) {
          w += h[b];
          s += Math.max(1, b) * h[b];
        }
      }
      this.win[k] = n ? w / n : 0;
      this.cost[k] = w ? s / w : r;
      this.paid[k] = table.paid?.[k] ?? (n ? (0.75 * mean) / n : 8);
    }
  }

  /** Per-letter win chance and price over the remaining auctions. */
  future(bag: number) {
    const hit = this.cache.get(bag);
    if (hit) return hit;
    const n = [0, 0, 0];
    for (let b = bag - 1; b >= 1; b--) n[phaseOf(b)]++;
    const tot = n[0] + n[1] + n[2] || 1;
    const win = new Float64Array(26);
    const cost = new Float64Array(26);
    for (let c = 0; c < 26; c++) {
      const k = phaseOf(Math.max(1, bag - 1));
      let w = 0;
      let co = 0;
      for (let p = 0; p < 3; p++) {
        const f = tot > 0 && n[0] + n[1] + n[2] > 0 ? n[p] / tot : p === k ? 1 : 0;
        w += f * this.win[c * 3 + p];
        co += f * this.cost[c * 3 + p];
      }
      win[c] = w;
      cost[c] = co;
    }
    const res = { win, cost };
    this.cache.set(bag, res);
    return res;
  }

  /** How pricey this table is versus the model, from prices paid so far (1 = typical). */
  scale(observed: [number, number, number][], pseudo = 80): number {
    let paid = 0;
    let expect = 0;
    for (const [c, bag, p] of observed) {
      paid += p;
      expect += this.paid[c * 3 + phaseOf(bag)];
    }
    return (paid + pseudo) / (expect + pseudo);
  }
}

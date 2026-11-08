// Build src/engine/market-table.json: for each letter and match phase, a
// histogram of the highest bid among the other seats, from recorded matches.
//   tsx sim/build-market.ts <dataDir> <skipNewest> <useMatches>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BID, phaseOf } from "../src/engine/market.ts";

const [dir, skipArg, useArg] = process.argv.slice(2);
const J = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n + ".json"), "utf8"));
const top = new Map<number, number>(J("topbids").map((t: any) => [t.auction_id, t.top_bid]));
const byM = new Map<number, any[]>();
for (const a of J("auctions")) {
  if (!byM.has(a.match_id)) byM.set(a.match_id, []);
  byM.get(a.match_id)!.push(a);
}
const ids = [...byM.keys()].filter((m) => byM.get(m)!.length === 68).sort((a, b) => a - b);
const skip = Number(skipArg ?? 0);
const use = ids.slice(0, ids.length - skip).slice(-Number(useArg ?? 600));
const hist: number[][] = Array.from({ length: 26 * 3 }, () => new Array(MAX_BID + 1).fill(0));
const paidSum = new Array(78).fill(0);
const paidN = new Array(78).fill(0);
for (const m of use) {
  const lst = byM.get(m)!.sort((a, b) => a.auction_id - b.auction_id);
  lst.forEach((a, i) => {
    const c = a.letter.charCodeAt(0) - 65;
    const t = a.winner_bot_id == null ? 0 : (top.get(a.auction_id) ?? a.paid);
    const k = c * 3 + phaseOf(67 - i);
    hist[k][Math.min(MAX_BID, t)]++;
    if (a.winner_bot_id != null) {
      paidSum[k] += a.paid;
      paidN[k]++;
    }
  });
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "market-table.json");
fs.writeFileSync(out, JSON.stringify({ matches: use.length, from: use[0], to: use[use.length - 1], hist, paid: paidSum.map((s, k) => (paidN[k] ? s / paidN[k] : 8)) }));
console.log(`wrote ${out} from ${use.length} matches (${use[0]}..${use[use.length - 1]})`);

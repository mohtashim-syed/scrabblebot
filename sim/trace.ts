// Trace one replay game move by move: tsx sim/trace.ts <dataDir> <matchIndexFromEnd> [params]
import * as fs from "node:fs";
import { LEX, loadHistory, rng } from "./sim.ts";
import { Brain, DEFAULT_PARAMS } from "../src/engine/brain.ts";
import { Player } from "../src/engine/player.ts";
import { rackString } from "../src/engine/lexicon.ts";
const hist = loadHistory(process.argv[2], 400);
const h = hist[hist.length - 1 - Number(process.argv[3] ?? 0)];
const params = { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[4] ?? "{}") };
const brain = new Brain(LEX, params);
brain.setMarketTable(JSON.parse(fs.readFileSync("src/engine/market-table.json", "utf8")));
const p = new Player(brain, "ME");
const r = rng(5);
const pool = [...h.start];
const s5: number[] = [];
for (let k = 0; k < 5; k++) s5.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
p.startingRack(s5);
let score = 0;
const L = (c: number) => String.fromCharCode(65 + c);
console.log(`seat ${h.seatName} scored ${h.seatScore}; best other ${h.bestOther}; start ${rackString(p.rack)}`);
for (let i = 0; i < 68; i++) {
  const bag = 67 - i, c = h.letters[i];
  p.revealed(c);
  const b = p.decideBid(c, bag), t = h.facing[i];
  const win = b > 0 && b > t;
  if (win) p.auctionWon(c, "ME", t > 0 ? t : 1); else p.auctionWon(c, "X", t);
  const ws = p.decideWords(bag);
  for (const w of ws) score += LEX.reward[LEX.fitting(new Int8Array([...w].reduce((a, ch) => (a[ch.charCodeAt(0) - 65]++, a), new Array(26).fill(0))), w.length).find((x) => LEX.len[x] === w.length)!];
  console.log(`${String(i).padStart(2)} ${L(c)} bid ${String(b).padStart(3)} vs ${String(t).padStart(3)} ${win ? "WIN " : "    "} bal ${String(p.balance).padStart(4)} rack ${rackString(p.rack).padEnd(12)} ${ws.join(",")}`);
}
console.log("score", score, "left", p.balance);

// Broad random search: sample many configs across the whole space (not just
// near the current best), then refine the top few with the hill-climber.
//   DATA=.. SKIP=.. tsx sim/global.ts <samples> <gamesPerEval> <baseJSON>
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const samples = Number(process.argv[2] ?? 40);
const games = Number(process.argv[3] ?? 200);
const base = JSON.parse(process.argv[4] ?? "{}");
const WORKERS = 10;
const SPACE: Record<string, [number, number, boolean]> = {
  lambda0: [0.08, 0.7, false],
  spendRate: [0.6, 6, false],
  lambdaPow: [0.4, 2, false],
  priceMult: [0.4, 1.4, false],
  leave: [0, 1.2, false],
  secondTarget: [0, 1, false],
  bidMult: [0.7, 1.6, false],
  maxNeed: [3, 5, true],
  minTarget: [5, 7, true],
  maxTarget: [7, 9, true],
  softTau: [0, 6, false],
  qPow: [0.4, 1.2, false],
  resMult: [1.0, 3.0, false],
  liquidity: [0, 0.6, false],
  lambdaMin: [0.01, 0.15, false],
};
const rnd = () => {
  const q: any = { ...base };
  for (const [k, [lo, hi, int]] of Object.entries(SPACE)) {
    const v = lo + Math.random() * (hi - lo);
    q[k] = int ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  return q;
};
function evalJob(params: any): Promise<any> {
  return new Promise((res) => {
    const job = JSON.stringify({ params, replay: games, dataDir: process.env.DATA, skip: Number(process.env.SKIP ?? 0), seed: 11 });
    const ch = spawn("npx", ["tsx", "sim/worker.ts", job], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.on("close", () => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      res(line ? JSON.parse(line) : null);
    });
  });
}
const score = (r: any) => 0.5 * r.replay.avg + 60 * r.replay.win - 25 * r.replay.place;
const all: any[] = [];
const queue = [base, ...Array.from({ length: samples }, rnd)];
let i = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    while (i < queue.length) {
      const p = queue[i++];
      const r = await evalJob(p);
      if (!r) continue;
      all.push({ s: score(r), r: r.replay, p });
      all.sort((a, b) => b.s - a.s);
      fs.writeFileSync("sim/global-results.json", JSON.stringify(all.slice(0, 15), null, 1));
      console.log(`${all.length}/${queue.length} s=${score(r).toFixed(1)} avg=${r.replay.avg} place=${r.replay.place} win=${r.replay.win} | best ${all[0].s.toFixed(1)}`);
    }
  }),
);

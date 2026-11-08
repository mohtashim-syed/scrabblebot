// Parallel random-search / hill-climb over Brain params on the replay benchmark.
//   tsx sim/search.ts <rounds> <gamesPerEval> [startParamsJSON]
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { DEFAULT_PARAMS, type Params } from "../src/engine/brain.ts";

const rounds = Number(process.argv[2] ?? 5);
const games = Number(process.argv[3] ?? 150);
let best: Partial<Params> = JSON.parse(process.argv[4] ?? "{}");
const WORKERS = 10;

const SPACE: Record<string, [number, number, boolean]> = {
  lambda0: [0.08, 0.8, false],
  spendRate: [1, 10, false],
  lambdaPow: [0.3, 2, false],
  winProb: [0.2, 0.95, false],
  priceMult: [0.3, 1.6, false],
  leave: [0, 1.2, false],
  secondTarget: [0, 1, false],
  bidMult: [0.6, 1.8, false],
  maxNeed: [2, 5, true],
  minTarget: [4, 7, true],
  endgameF: [0, 5, true],
  liquidity: [0, 1, false],
  midPlayLen: [5, 8, true],
  maxTarget: [7, 9, true],
  softTau: [0, 8, false],
  budgetCurve: [0, 1, true],
  qPow: [0.4, 1.3, false],
  resMult: [1.0, 2.5, false],
  matchAdapt: [0, 1, false],
};

function mutate(p: Partial<Params>, scale: number): Partial<Params> {
  const q: any = { ...DEFAULT_PARAMS, ...p };
  const keys = process.env.KEYS ? process.env.KEYS.split(",") : Object.keys(SPACE);
  const k = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < k; i++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    const [lo, hi, int] = SPACE[key];
    let v = q[key] + (Math.random() * 2 - 1) * scale * (hi - lo);
    v = Math.min(hi, Math.max(lo, v));
    q[key] = int ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  return q;
}

function evalJob(params: Partial<Params>, id: number): Promise<any> {
  return new Promise((res) => {
    const job = JSON.stringify({ id, params, replay: games, dataDir: process.env.DATA ?? "data", skip: Number(process.env.SKIP ?? 0), seed: 11 });
    const ch = spawn("npx", ["tsx", "sim/worker.ts", job], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.on("close", () => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      res(line ? JSON.parse(line) : null);
    });
  });
}

// Ratings come from finishing place, so optimise place and wins, not just average score.
const score = (r: any) => 0.5 * r.replay.avg + 60 * r.replay.win - 25 * r.replay.place;
let bestScore = -1;
if (process.argv[5]) bestScore = Number(process.argv[5]);
{
  const r = await evalJob(best, 0);
  bestScore = score(r);
  console.log("start", bestScore.toFixed(2), JSON.stringify(r.replay));
}
for (let round = 0; round < rounds; round++) {
  const scale = 0.35 * Math.pow(0.8, round);
  const cands = Array.from({ length: WORKERS }, () => mutate(best, scale));
  const results = await Promise.all(cands.map((c, i) => evalJob(c, i)));
  for (const r of results) {
    if (!r) continue;
    const s = score(r);
    if (s > bestScore) {
      bestScore = s;
      best = r.params;
      console.log(`round ${round} NEW BEST ${s.toFixed(2)}`, JSON.stringify(r.replay), JSON.stringify(best));
    }
  }
  console.log(`round ${round} done; best ${bestScore.toFixed(2)}`);
  fs.writeFileSync("sim/best.json", JSON.stringify(best, null, 2));
}

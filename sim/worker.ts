// Evaluate one parameter set: `tsx sim/worker.ts '<json>'` → prints a JSON result line.
import { DEFAULT_PARAMS } from "../src/engine/brain.ts";
import { loadHistory, pricesFromDir, runField, runReplay } from "./sim.ts";

const job = JSON.parse(process.argv[2]);
const params = { ...DEFAULT_PARAMS, ...job.params };
const out: Record<string, unknown> = { id: job.id, params: job.params };
if (job.replay) {
  const hist = loadHistory(job.dataDir, job.replay + (job.skip ?? 0)).slice(0, job.replay);
  out.replay = runReplay(hist, params, job.seed ?? 1, job.livePrices ? pricesFromDir(job.dataDir) : undefined);
}
if (job.field) out.field = runField(job.field, params, job.seed ?? 7, job.fieldKind ?? "mixed");
console.log(JSON.stringify(out));

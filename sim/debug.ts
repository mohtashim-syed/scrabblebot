import { LEX } from "./sim.ts";
import { Brain, DEFAULT_PARAMS } from "../src/engine/brain.ts";
import { BAG, rackFrom } from "../src/engine/lexicon.ts";
const params = { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[3] ?? "{}") };
const b = new Brain(LEX, params) as any;
const rack = rackFrom(process.argv[2] ?? "RETAIN");
const v = { rack, balance: 60, unseen: Float64Array.from(BAG), usableFuture: 29 };
const lam = b.lambda(v);
const acq = b.acquisition(v);
for (const extra of ["", "S", "Q", "V", "J", "U"]) {
  const r = rackFrom((process.argv[2] ?? "RETAIN") + extra);
  const top = b.scan(r, { ...v, rack: r }, lam, acq, 5);
  console.log(extra || "-", "V=", b.value(r, { ...v, rack: r }, lam).toFixed(1), top.map((t: any) => `${LEX.word[t.idx]}:${t.gain.toFixed(1)}`).join(" "));
}
console.log("lambda", lam.toFixed(3));

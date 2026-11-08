// Parameters found by sim/search.ts on the replay benchmark (live auctions).
// v3: market model on; tuned on matches 45.9k-46.3k, validated on the newest 150.
import type { Params } from "./brain.ts";

export const TUNED_PARAMS: Partial<Params> = {"minTarget":5,"maxTarget":8,"maxNeed":4,"winProb":0.445,"priceMult":0.916,"leave":0.514,"lambda0":0.3,"spendRate":1.793,"lambdaPow":0.907,"lambdaMin":0.03,"midPlayLen":7,"secondTarget":0.831,"endgameF":1,"liquidity":0.19,"bidMult":1.054,"softTau":2.447,"budgetCurve":0,"qPow":1,"useMarket":1,"resMult":1.737,"matchAdapt":0};

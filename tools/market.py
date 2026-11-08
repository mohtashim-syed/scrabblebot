# Build market tables: per-letter distribution of the winning (= highest competing) bid, by game phase.
import json, sys
from collections import defaultdict
D=sys.argv[1]; N=int(sys.argv[2]); OUT=sys.argv[3]
L=lambda n: json.load(open(f"{D}/{n}.json"))
auc=L("auctions"); top={t["auction_id"]:t["top_bid"] for t in L("topbids")}
mids=sorted({a["match_id"] for a in auc})[-N:]; S=set(mids)
bm=defaultdict(list)
for a in auc:
    if a["match_id"] in S: bm[a["match_id"]].append(a)
H=defaultdict(lambda: [0]*61)   # key: letter|phase  (phase 0..2 by thirds)
P=defaultdict(list)
for m,l in bm.items():
    l.sort(key=lambda a:a["auction_id"]); n=len(l)
    for i,a in enumerate(l):
        t=top.get(a["auction_id"],0) if a["winner_bot_id"] is not None else 0
        ph=min(2,i*3//n)
        H[f"{a['letter']}{ph}"][min(60,t)]+=1
        if a["winner_bot_id"] is not None: P[a["letter"]].append(a["paid"])
json.dump({"hist":H,"paidMean":{k:sum(v)/len(v) for k,v in P.items()}},open(OUT,"w"))
print("ok",len(bm))

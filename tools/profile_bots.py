import json, sys, statistics as st
from collections import defaultdict, Counter
D=sys.argv[1]; N=int(sys.argv[2]); L=lambda n: json.load(open(f"{D}/{n}.json"))
bots={b["id"]:b["name"] for b in L("bots")}
parts=L("participants"); auc=L("auctions"); words=L("words")
top={t["auction_id"]:t["top_bid"] for t in L("topbids")}
mids=sorted({p["match_id"] for p in parts})[-N:]; S=set(mids)
pm=defaultdict(list)
for p in parts:
    if p["match_id"] in S: pm[p["match_id"]].append(p)
am=defaultdict(list)
for a in auc:
    if a["match_id"] in S: am[a["match_id"]].append(a)
wm=defaultdict(list)
for w in words:
    if w["match_id"] in S: wm[w["match_id"]].append(w)
stats=defaultdict(lambda: defaultdict(list))
for m in mids:
    ps=pm[m]; best=max(p["score"] for p in ps)
    lst=sorted(am[m],key=lambda a:a["auction_id"])
    for p in ps:
        b=p["bot_id"]; s=stats[b]
        s["score"].append(p["score"]); s["win"].append(p["score"]==best); s["bal"].append(p["balance"])
        mine=[a for a in lst if a["winner_bot_id"]==b]
        s["letters"].append(len(mine)); s["paid"].append(sum(a["paid"] for a in mine))
        ws=[w for w in wm[m] if w["bot_id"]==b]
        s["nw"].append(len(ws)); s["wlen"]+= [len(w["word"]) for w in ws]
        # letters won in last 10 auctions
        s["late"].append(sum(1 for a in lst[-10:] if a["winner_bot_id"]==b))
print(f"{'bot':20} games win  score  letters paid  late10 words wlen finalBal")
for b in sorted(stats,key=lambda b:-st.mean(stats[b]["score"])):
    s=stats[b]; g=len(s["score"])
    if g<20: continue
    print(f"{bots[b][:20]:20} {g:4} {st.mean(s['win']):4.0%} {st.mean(s['score']):6.1f} {st.mean(s['letters']):6.1f} {st.mean(s['paid']):5.0f} {st.mean(s['late']):6.1f} {st.mean(s['nw']):4.1f} {st.mean(s['wlen']):4.2f} {st.mean(s['bal']):6.1f}")

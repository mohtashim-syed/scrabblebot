"""Pull public match history from the live ScrabbleBot database into JSON files."""
import json, os, sys, urllib.request

OUT = sys.argv[1]
MIN_MATCH = int(sys.argv[2])
TOK = open(sys.argv[3]).read().strip()
URL = "https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql"


def sql(q):
    req = urllib.request.Request(URL, data=q.encode(), headers={"Authorization": f"Bearer {TOK}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        res = json.load(r)[0]
    cols = [e["name"]["some"] for e in res["schema"]["elements"]]
    return [dict(zip(cols, row)) for row in res["rows"]]


def opt(v):
    # SATS option encodes as [0, value] for some / [1, []] for none
    if isinstance(v, list) and len(v) == 2 and isinstance(v[0], int):
        return v[1] if v[0] == 0 else None
    return v


os.makedirs(OUT, exist_ok=True)
queries = {
    "bots": "SELECT id, name, is_simulated FROM bot",
    "config": "SELECT * FROM matchmaker_config",
    "participants": f"SELECT match_id, bot_id, balance, score FROM match_participant WHERE match_id >= {MIN_MATCH}",
    "auctions": f"SELECT auction_id, match_id, letter, winner_bot_id, paid FROM auction_result WHERE match_id >= {MIN_MATCH}",
    "topbids": f"SELECT auction_id, match_id, top_bid FROM auction_top_bid_archive WHERE match_id >= {MIN_MATCH}",
    "words": f"SELECT id, match_id, bot_id, word, total_reward FROM word_play WHERE match_id >= {MIN_MATCH}",
    "matches": f"SELECT id, status, bag_total, starting_rack_size, auction_duration_ms FROM match_state WHERE id >= {MIN_MATCH}",
}
for name, q in queries.items():
    try:
        rows = sql(q)
    except Exception as e:  # noqa: BLE001
        print(name, "FAILED", e)
        continue
    rows = [{k: opt(v) for k, v in r.items()} for r in rows]
    json.dump(rows, open(os.path.join(OUT, name + ".json"), "w"))
    print(name, len(rows))

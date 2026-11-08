# Apex — a ScrabbleBot auction bot

A competitive bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), the
SpacetimeDB letter-auction game. It is a drop-in replacement for the repo's
`bot-starter`: same token flow, same reducers, built on the same generated
bindings.

## Run it

```bash
npm install
BOT_NAME=apex BOT_TOKEN=<token from /team> npm start
```

Get the token from the site: link your spacetimedb.com identity at `/account`,
create a team at `/team/new`, then **Generate token** on `/team`. After the first
run the token is saved to `.token-<BOT_NAME>` and `BOT_TOKEN` can be dropped.

| Env | Meaning |
|---|---|
| `BOT_NAME` | local name, picks the saved token file |
| `BOT_TOKEN` / `BOT_NONCE` | first-run credential (website token, or CLI nonce) |
| `TOURNAMENT_ID` | register for a tournament on connect |
| `LIVE_PRICES=1` | re-measure letter prices from recent matches (off by default; see below) |
| `SHADOW=1` | no token needed: follows a live match and logs what it *would* bid |

Other scripts: `npm test` (engine tests), `npm run typecheck`,
`npm run sim -- replay 200 data` / `npm run sim -- field 100` (simulators, below).

## What the game really rewards

Facts from the module source (`spacetimedb/src/game.ts`) and ~2,300 live matches
pulled from the public tables:

- **Score = coins spent + coins left − 100.** Every word reward is credited to
  both balance and score, and spending never lowers score. So coins left at the
  end are worth nothing, and so are tiles left in the rack. Live bots finish with
  15–45 coins unused on average.
- **The last auction's letter can never be played**: the match ends in the same
  transaction that awards it. Bid 0 on it, and play out your whole rack while it
  is open.
- **Anagrams are interchangeable**: reward = face sum × length multiplier, so the
  dictionary collapses to ~156k letter multisets ("alphagrams").
- **Letters are bought at a loss.** In strong 6-bot fields a vowel goes for
  ~10 coins but adds only 3 points to a 7-letter word (3×). High-face letters
  (Z, X, J, Q, K, W, V) cost less relative to what they add. Prices also drift up
  (+25% over the last few hundred matches), so a fixed price table goes stale.

## How it plays

**Valuation** (`src/engine/brain.ts`). For a rack, scan every target alphagram of
length 5–8 that needs at most a few more letters. For each, estimate the chance of
collecting the missing letters from the unseen pool in the usable auctions left
(Poisson tails), and the expected cost at current market prices. Rack value =
held letters' leave value + best target gain, plus a discounted second disjoint
target. A 26-bit letter-mask prefilter keeps a full scan to a few milliseconds.

**Bidding.** Auctions are Vickrey (second-price), so bidding your true value is
the dominant strategy. Value = V(rack + letter) − V(rack), in points, converted
to coins by dividing by λ, the shadow price of a coin. λ comes from
**budget pacing** (as in ad auctions): with more coins than the remaining auctions
can absorb, coins are cheap and bids rise. Near the end λ → 0 and the bot spends
everything on any letter that still improves its final rack.

**Word play.** It plays a word when reward + value(rest) beats holding. In
practice it plays bingos (7+ letters, 3×) at once to recycle the coins, and
shorter words only late. While the final auction is open it plays the exact
**best partition** of the rack: a branch-and-bound search for the highest-scoring
set of disjoint words.

**Information.** The unseen pool is rebuilt from public events: the bag, minus our
tiles and plays, minus every revealed auction letter, minus opponents' played
letters they never bought (which must have come from their hidden starting
racks). With `LIVE_PRICES=1`, market prices are re-measured from the last ~250
matches over the public HTTP SQL endpoint each time a match starts. It's off by
default: on held-out matches the tuned coin value already absorbs the price level,
and raw recalibration made the bot more timid (85 vs. 89 points).

**Networking** (`src/index.ts`). Subscribes only to its own rows and the current
match. The starter's `subscribeToAllTables` downloads ~2.5M rows. Words are sent
before the bid in the same tick, so a new bingo's coins can be spent on the
auction that is open right now. It reconnects on disconnect and re-queues
periodically if a lobby is cancelled.

## How it was tuned

`sim/` holds a faithful re-implementation of the module rules and two
benchmarks:

- **Replay** (`npm run sim -- replay N data`): put the bot in a real bot's seat
  in a recorded live match, facing the other five seats' real top bids, and
  compare against the score the real bot made in that seat. Opponent scores are
  held fixed, which is conservative: letters we take would have lowered them.
- **Field**: full 6-bot simulations against the module's sim bots, the starter
  bot, bingo hunters, and copies of itself.

`sim/search.ts` runs a parallel hill-climb over the parameters on the replay
benchmark. The result lives in `src/engine/tuned.ts`.

`tools/` has the data scripts: `fetch.py <outDir> <fromMatchId> <tokenFile>`
pulls public match history (get an anonymous token with
`curl -X POST https://maincloud.spacetimedb.com/v1/identity`),
`profile_bots.py <dir> <N>` profiles every bot over the last N matches, and
`market.py` builds per-letter price distributions.

## Results (offline)

| Benchmark | Apex | Comparison |
|---|---|---|
| Replay, 300 live matches (seat takeover) | **88.3 avg**, wins 22% | real bot in that seat: 70.2 avg, 18%; Apex outscores it in 65% |
| Held-out newest 95 matches (+25% prices) | **87.2 avg**, wins 14% | seat: 73.1 avg, 14%; Apex outscores it in 68% |
| Field: 2 bingo hunters, 2 untuned Apex, starter | **119 avg**, wins 58%, avg rank 1.55 | best opponent 97 |
| Field: 5 bingo hunters | **100 avg**, wins 58% | best opponent 78 |
| Field: 5 untuned copies of itself | **207 avg**, wins 90% | ~57 each |
| Field: module sim bots | **312 avg**, wins 100% | ≤21 |

Replay wins are understated: opponents keep their recorded scores even when Apex
takes the letters they used. Lessons the benchmark taught (and overruled intuition
on): hold for 7-letter words rather than cashing 5–6s mid-game; truthful bidding
with one coin value beats a concave budget curve; a static price table beats raw
live recalibration.

## Credits

Built for [clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot)
(MIT). `src/module_bindings/` is generated from that module, and `wordlist.txt`
is the public-domain ENABLE list it embeds.

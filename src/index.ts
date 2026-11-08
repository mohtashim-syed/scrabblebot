// Apex — a ScrabbleBot auction player.
//
// First run, with a token from the website's team page:
//   BOT_NAME=<name> BOT_TOKEN=<token> npm start
// Or redeem a CLI nonce:
//   BOT_NAME=<name> BOT_NONCE=<code> npm start
// Later runs: BOT_NAME=<name> npm start   (token saved to .token-<name>)
// Tournament: add TOURNAMENT_ID=<id>.
// Shadow mode (no token; follows a live match and logs what it would bid):
//   SHADOW=1 npm start
//
// Unlike the starter, this subscribes only to its own rows and the match it
// is playing (the public tables hold millions of rows), derives the unseen
// letter pool from public events, plays words before bidding so new coins
// are spendable at once, and dumps its whole rack in the final auction.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext } from "./module_bindings/index.ts";
import { Brain, DEFAULT_PARAMS, type Params } from "./engine/brain.ts";
import { BAG, Lexicon } from "./engine/lexicon.ts";
import { Player } from "./engine/player.ts";
import { fetchRecentPrices } from "./engine/market.ts";
import { TUNED_PARAMS } from "./engine/tuned.ts";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "apex";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const SHADOW = !!process.env.SHADOW;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

const lex = new Lexicon(fs.readFileSync(path.join(ROOT, "wordlist.txt"), "utf8").split("\n"));
const params: Params = { ...DEFAULT_PARAMS, ...TUNED_PARAMS };
const brain = new Brain(lex, params);
// What it takes to win each letter, per match phase, from recent live matches
// (rebuild with `npm run sim:market`).
brain.setMarketTable(JSON.parse(fs.readFileSync(path.join(ROOT, "src", "engine", "market-table.json"), "utf8")));

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}] [${BOT_NAME}]`, ...a);
const letterIdx = (s: string) => s.charCodeAt(0) - 65;

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------- per-connection state ----------

let conn: DbConnection;
let myIdentity: Identity | null = null;
let myToken: string | undefined;
let myBotId: bigint | null = null;
let matchId: bigint | null = null;
let matchSub: { unsubscribe: () => void } | null = null;
let bidOn = new Set<bigint>(); // auctions we've bid on
// Words we've sent but the server hasn't confirmed yet (their letters are still in my_rack).
let pending: { word: string; reward: number }[] = [];
let actScheduled = false;
let ready = false; // initial rows loaded; inserts after this are live events
let lobbyTimer: NodeJS.Timeout | null = null;

function schedule() {
  if (actScheduled) return;
  actScheduled = true;
  setImmediate(() => {
    actScheduled = false;
    try {
      act();
    } catch (e) {
      log("act error", e);
    }
  });
}

const fail = (what: string) => (err: unknown) => log(`${what} failed: ${err instanceof Error ? err.message : err}`);

/** Rebuild what we know about the match from the client cache. */
function snapshot(m: bigint) {
  const p = new Player(brain, "ME");
  // rack (authoritative) minus letters of words in flight
  for (const h of conn.db.myRack.iter()) if (h.matchId === m) p.rack[letterIdx(h.letter)] += h.count;
  let balance = 0;
  for (const mp of conn.db.matchParticipant.iter())
    if (mp.matchId === m && mp.botId === myBotId) balance = Number(mp.balance);
  // unseen = bag − my tiles − my played letters − every revealed auction letter not won by me
  //          − opponents' letters that must have come from their hidden starting racks
  const unseen = Float64Array.from(BAG);
  for (let c = 0; c < 26; c++) unseen[c] -= p.rack[c];
  for (const pw of pending) {
    for (const ch of pw.word) p.rack[letterIdx(ch)]--;
    balance += pw.reward;
  }
  p.balance = balance;
  const winner = new Map<bigint, bigint | undefined>();
  const results = [...conn.db.auctionResult.iter()].filter((r) => r.matchId === m);
  results.sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  results.forEach((r, i) => {
    winner.set(r.auctionId, r.winnerBotId ?? undefined);
    p.observe(letterIdx(r.letter), 67 - i, Number(r.paid));
  });
  const oppWon = new Map<bigint, Int8Array>();
  for (const a of conn.db.auction.iter()) {
    if (a.matchId !== m) continue;
    const w = winner.get(a.id);
    if (w === myBotId) continue; // already counted via rack / plays
    unseen[letterIdx(a.letter)]--;
    if (w !== undefined) {
      let arr = oppWon.get(w);
      if (!arr) oppWon.set(w, (arr = new Int8Array(26)));
      arr[letterIdx(a.letter)]++;
    }
  }
  for (const wp of conn.db.wordPlay.iter()) {
    if (wp.matchId !== m) continue;
    if (wp.botId === myBotId) {
      for (const ch of wp.word) unseen[letterIdx(ch)]--;
      continue;
    }
    let arr = oppWon.get(wp.botId);
    if (!arr) oppWon.set(wp.botId, (arr = new Int8Array(26)));
    for (const ch of wp.word) {
      const c = letterIdx(ch);
      if (arr[c] > 0) arr[c]--;
      else unseen[c]--;
    }
  }
  for (let c = 0; c < 26; c++) p.unseen[c] = Math.max(0, unseen[c]);
  return p;
}

function act() {
  if (matchId === null || myBotId === null) return;
  const m = matchId;
  const ms = conn.db.matchState.id.find(m);
  if (!ms || ms.status.tag !== "Running") return;
  const bag = ms.bagTotal;
  const p = snapshot(m);

  // 1. Words first, so their reward is spendable on this auction.
  const t0 = performance.now();
  const words = p.decideWords(bag);
  for (const w of words) {
    const reward = lexReward(w);
    pending.push({ word: w, reward });
    log(`match ${m}: play ${w} (+${reward})${bag === 0 ? " [final dump]" : ""}`);
    conn.reducers
      .submitWord({ matchId: m, word: w })
      .catch((e: unknown) => {
        pending = pending.filter((x) => x.word !== w);
        fail(`word ${w}`)(e);
        schedule();
      });
  }

  // 2. Bid on the open auction.
  const aid = ms.currentAuctionId;
  if (aid === undefined || aid === null || bidOn.has(aid)) return;
  const auc = conn.db.auction.id.find(aid);
  if (!auc || auc.status.tag !== "Open") return;
  bidOn.add(aid);
  const c = letterIdx(auc.letter);
  const amount = p.decideBid(c, bag);
  const ms_ = (performance.now() - t0).toFixed(0);
  if (amount <= 0) return;
  log(`match ${m}: bid ${amount} on ${auc.letter} (bal ${p.balance}, bag ${bag}, ${ms_}ms)`);
  conn.reducers.submitBid({ auctionId: aid, amount: BigInt(amount) }).catch(fail(`bid on ${auc.letter}`));
}

function lexReward(w: string): number {
  // every anagram scores the same; find the alphagram's reward
  const r = new Int8Array(26);
  for (const ch of w) r[letterIdx(ch)]++;
  for (const i of lex.fitting(r, w.length)) if (lex.len[i] === w.length) return lex.reward[i];
  return 0;
}

// ---------- match lifecycle ----------

function enterMatch(m: bigint) {
  if (matchId === m) return;
  matchSub?.unsubscribe();
  matchId = m;
  bidOn = new Set();
  pending = [];
  log(`entered match ${m}`);
  // Optionally recalibrate letter prices from the last ~250 matches. Off by
  // default: the tuned coin value already absorbs the overall price level, and
  // on held-out matches raw recalibration made the bot too timid.
  if (process.env.LIVE_PRICES) fetchRecentPrices(HOST, DB_NAME, myToken, m > 250n ? m - 250n : 0n)
    .then((prices) => {
      if (!prices) return;
      brain.price = prices;
      log(`prices: ${[...prices].map((x, i) => String.fromCharCode(65 + i) + x.toFixed(0)).join(" ")}`);
    })
    .catch(fail("price refresh"));
  matchSub = conn
    .subscriptionBuilder()
    .onApplied(() => schedule())
    .onError((_c: ErrorContext, e?: unknown) => log("match subscription error", e))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${m}`,
      `SELECT * FROM match_participant WHERE match_id = ${m}`,
      `SELECT * FROM auction WHERE match_id = ${m}`,
      `SELECT * FROM auction_result WHERE match_id = ${m}`,
      `SELECT * FROM word_play WHERE match_id = ${m}`,
    ]);
}

function matchEnded(m: bigint) {
  const ps = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === m);
  ps.sort((a, b) => Number(b.score - a.score));
  const me = ps.findIndex((p) => p.botId === myBotId);
  const names = ps.map((p) => `${conn.db.bot.id.find(p.botId)?.name ?? p.botId}:${p.score}`).join(" ");
  log(`match ${m} ended — place ${me + 1}/${ps.length} | ${names}`);
  if (matchId === m) matchId = null;
  joinLobby();
}

function joinLobby() {
  if (myBotId === null || matchId !== null || SHADOW) return;
  conn.reducers.joinLobby({}).catch(fail("join lobby"));
}

function bootstrap() {
  log(`acting as bot '${conn.db.bot.id.find(myBotId!)?.name ?? "?"}' (id ${myBotId})`);
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      ready = true;
      // Resume a running match if we restarted mid-game; otherwise queue up.
      const mine = [...conn.db.matchParticipant.iter()].filter((p) => p.botId === myBotId);
      const latest = mine.reduce<bigint | null>((a, p) => (a === null || p.matchId > a ? p.matchId : a), null);
      if (latest !== null) {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            const ms = conn.db.matchState.id.find(latest);
            if (ms?.status.tag === "Running") enterMatch(latest);
            else joinLobby();
          })
          .subscribe([`SELECT * FROM match_state WHERE id = ${latest}`]);
      } else joinLobby();
      if (TOURNAMENT_ID) {
        conn.reducers
          .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
          .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
          .catch(fail("tournament registration"));
      }
    })
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`, `SELECT * FROM my_rack`]);

  // If a lobby gets cancelled we'd sit idle; re-queue periodically (idempotent server-side).
  lobbyTimer = setInterval(joinLobby, 20_000);
}

// ---------- shadow mode: follow the newest live match, bidding on paper ----------

function shadow() {
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      const live = [...conn.db.matchState.iter()].filter((m) => m.status.tag === "Running");
      const m = live.reduce<bigint | null>((a, x) => (a === null || x.id > a ? x.id : a), null);
      if (m === null) return log("no live match right now");
      log(`shadowing match ${m}`);
      matchId = m;
      conn
        .subscriptionBuilder()
        .subscribe([
          `SELECT * FROM auction WHERE match_id = ${m}`,
          `SELECT * FROM auction_result WHERE match_id = ${m}`,
          `SELECT * FROM word_play WHERE match_id = ${m}`,
        ]);
    })
    .subscribe([`SELECT * FROM match_state WHERE id > ${process.env.SHADOW_FROM ?? "0"}`]);
  conn.db.auction.onInsert((_c, a) => {
    if (a.matchId !== matchId || a.status.tag !== "Open") return;
    const ms = conn.db.matchState.id.find(a.matchId);
    const p = snapshot(a.matchId);
    p.balance = 100;
    const t0 = performance.now();
    const bid = p.decideBid(letterIdx(a.letter), ms?.bagTotal ?? 0);
    log(`[shadow] ${a.letter}: would bid ${bid} (${(performance.now() - t0).toFixed(1)}ms, unseen ${p.unseen.reduce((s, x) => s + x, 0)})`);
  });
  conn.db.auctionResult.onInsert((_c, r) => {
    if (r.matchId === matchId) log(`[shadow]   ${r.letter} -> bot ${r.winnerBotId ?? "none"} paid ${r.paid}`);
  });
}

// ---------- connection ----------

function onConnect(c: DbConnection, identity: Identity, token: string) {
  conn = c;
  myIdentity = identity;
  myToken = token;
  log(`connected as ${identity.toHexString().slice(0, 16)}…`);
  if (SHADOW) return shadow();
  fs.writeFileSync(TOKEN_PATH, token);

  conn.db.auction.onInsert((_c, a) => a.matchId === matchId && schedule());
  conn.db.myRack.onInsert(() => schedule());
  conn.db.myRack.onUpdate(() => schedule());
  conn.db.myRack.onDelete(() => schedule());
  conn.db.matchParticipant.onUpdate(() => schedule());
  conn.db.matchParticipant.onInsert((_c, p) => {
    // Initial subscription rows are our past matches; only live inserts mean a new match.
    if (!ready || p.botId !== myBotId) return;
    const ms = conn.db.matchState.id.find(p.matchId);
    if (!ms || ms.status.tag === "Running") enterMatch(p.matchId);
  });
  conn.db.wordPlay.onInsert((_c, w) => {
    if (w.botId === myBotId && w.matchId === matchId) {
      const i = pending.findIndex((x) => x.word === w.word);
      if (i >= 0) pending.splice(i, 1);
    }
    schedule();
  });
  conn.db.matchState.onUpdate((_c, old, neu) => {
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended" && neu.id === matchId) matchEnded(neu.id);
    else schedule();
  });

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      const cred = conn.db.botCredential.identity.find(identity);
      myBotId = cred?.botId ?? null;
      if (myBotId !== null) return bootstrap();
      if (!BOT_NONCE) {
        log("this token isn't a credential for any bot — set BOT_TOKEN (from /team) or BOT_NONCE");
        process.exit(1);
      }
      log("claiming credential with nonce…");
      conn.reducers.claimCredential({ code: BOT_NONCE }).catch(fail("claim credential"));
      conn.db.botCredential.onInsert((_c, row) => {
        if (myBotId === null && row.identity.isEqual(identity)) {
          myBotId = row.botId;
          bootstrap();
        }
      });
    })
    .onError((_c: ErrorContext, e?: unknown) => log("subscription error", e))
    .subscribe(["SELECT * FROM bot_credential", "SELECT * FROM bot"]);
}

function connect(delayMs = 0) {
  setTimeout(() => {
    log(`connecting to ${DB_NAME} at ${HOST}${SHADOW ? " (shadow)" : ""}`);
    if (lobbyTimer) clearInterval(lobbyTimer);
    matchId = null;
    matchSub = null;
    myBotId = null;
    ready = false;
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(SHADOW ? undefined : (BOT_TOKEN ?? loadToken()))
      .onConnect(onConnect)
      .onConnectError((_c: ErrorContext, err: Error) => {
        log("connect error:", err.message);
        connect(5000);
      })
      .onDisconnect(() => {
        log("disconnected; reconnecting");
        connect(2000);
      })
      .build();
  }, delayMs);
}

void myIdentity;
connect();

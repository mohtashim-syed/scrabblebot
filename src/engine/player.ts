// Match-level bookkeeping around the Brain: tracks the rack, balance, and
// which letters are still unseen, from exactly the public information a live
// bot gets (its own rack, every auction's letter and winner, every word play).

import { Brain } from "./brain.ts";
import { BAG, type Lexicon, type Rack } from "./lexicon.ts";

export class Player {
  rack: Rack = new Int8Array(26);
  balance = 100;
  unseen = Float64Array.from(BAG);
  // letters each opponent won at auction and hasn't been seen to play yet
  private oppWon = new Map<string, Int8Array>();
  // prices paid in this match so far: [letter, bag at that auction, paid]
  observed: [number, number, number][] = [];

  constructor(
    readonly brain: Brain,
    readonly me: string,
  ) {}

  get lex(): Lexicon {
    return this.brain.lex;
  }

  /** Our starting tiles were dealt (or we gained a tile). */
  addTile(c: number) {
    this.rack[c]++;
  }

  startingRack(letters: number[]) {
    for (const c of letters) {
      this.rack[c]++;
      this.unseen[c] = Math.max(0, this.unseen[c] - 1);
    }
  }

  /** A new auction revealed `c`. */
  revealed(c: number) {
    this.unseen[c] = Math.max(0, this.unseen[c] - 1);
  }

  /** Record a price paid by anyone at an auction held with `bag` tiles left. */
  observe(c: number, bag: number, paid: number) {
    if (paid > 0) this.observed.push([c, bag, paid]);
  }

  private scale(): number {
    const m = this.brain.market;
    return m ? m.scale(this.observed) : 1;
  }

  auctionWon(c: number, winner: string | null, paid: number) {
    if (winner === null) return;
    if (winner === this.me) {
      this.rack[c]++;
      this.balance -= paid;
      return;
    }
    let w = this.oppWon.get(winner);
    if (!w) this.oppWon.set(winner, (w = new Int8Array(26)));
    w[c]++;
  }

  /** Someone played a word; letters beyond their auction wins came from their hidden start. */
  wordPlayed(by: string, word: string) {
    if (by === this.me) return;
    let w = this.oppWon.get(by);
    if (!w) this.oppWon.set(by, (w = new Int8Array(26)));
    for (const ch of word) {
      const c = ch.charCodeAt(0) - 65;
      if (w[c] > 0) w[c]--;
      else this.unseen[c] = Math.max(0, this.unseen[c] - 1);
    }
  }

  /** bagTotal = tiles left in the bag while the current auction is open. */
  decideBid(letter: number, bagTotal: number): number {
    if (bagTotal <= 0) return 0; // final auction: its letter can never be played
    return this.brain.bid(letter, {
      rack: this.rack,
      balance: this.balance,
      unseen: this.unseen,
      usableFuture: bagTotal - 1,
      priceScale: this.scale(),
    });
  }

  /** Words to play now; applies them to our own rack/balance. */
  decideWords(bagTotal: number): string[] {
    const idx = this.brain.plays({
      rack: this.rack,
      balance: this.balance,
      unseen: this.unseen,
      usableFuture: bagTotal >= 1 ? bagTotal : -1,
      priceScale: this.scale(),
    });
    const out: string[] = [];
    for (const i of idx) {
      this.lex.take(this.rack, i);
      this.balance += this.lex.reward[i];
      out.push(this.lex.word[i]);
    }
    return out;
  }
}

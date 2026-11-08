// Dictionary as "alphagrams": in this game a word's reward depends only on
// its letters (sum of face values × length multiplier), never on their order,
// so every anagram of a word is interchangeable. We keep one entry per
// distinct letter multiset plus a trie over sorted letters for fast
// "which words fit in this rack?" enumeration.

export const FACE = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]; // A..Z

export const BAG = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
]; // A..Z, 98 tiles, no blanks

export function multiplied(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export type Rack = Int8Array; // length 26, counts

export function rackFrom(letters: string): Rack {
  const r = new Int8Array(26);
  for (const ch of letters) r[ch.charCodeAt(0) - 65]++;
  return r;
}

export function rackSize(r: Rack): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += r[i];
  return n;
}

export function rackString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) for (let k = 0; k < r[i]; k++) s += String.fromCharCode(65 + i);
  return s;
}

export class Lexicon {
  n = 0;
  letters: Uint8Array; // concatenated sorted letter indices per alphagram
  off: Uint32Array; // alphagram i occupies letters[off[i] .. off[i+1])
  len: Uint8Array;
  reward: Uint16Array;
  word: string[];
  mask: Uint32Array; // bit c set if letter c appears
  // alphagrams are sorted by length; byLenStart[L] = first index of length L
  byLenStart: Int32Array;

  // trie over sorted letters
  private childStart: Int32Array; // first child node
  private sibling: Int32Array; // next sibling node
  private nodeLetter: Uint8Array;
  private terminal: Int32Array; // alphagram index or -1

  constructor(words: Iterable<string>) {
    const seen = new Map<string, string>();
    for (const raw of words) {
      const w = raw.trim().toUpperCase();
      if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
      const key = [...w].sort().join("");
      if (!seen.has(key)) seen.set(key, w);
    }
    const keys = [...seen.keys()].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    this.n = keys.length;
    let total = 0;
    for (const k of keys) total += k.length;
    this.letters = new Uint8Array(total);
    this.off = new Uint32Array(this.n + 1);
    this.len = new Uint8Array(this.n);
    this.reward = new Uint16Array(this.n);
    this.word = new Array(this.n);
    this.mask = new Uint32Array(this.n);
    const maxLen = keys.length ? keys[keys.length - 1].length : 0;
    this.byLenStart = new Int32Array(maxLen + 2).fill(this.n);
    let p = 0;
    for (let i = 0; i < this.n; i++) {
      const k = keys[i];
      this.off[i] = p;
      let base = 0;
      for (let j = 0; j < k.length; j++) {
        const c = k.charCodeAt(j) - 65;
        this.letters[p++] = c;
        this.mask[i] |= 1 << c;
        base += FACE[c];
      }
      this.len[i] = k.length;
      this.reward[i] = multiplied(base, k.length);
      this.word[i] = seen.get(k)!;
      if (this.byLenStart[k.length] > i) this.byLenStart[k.length] = i;
    }
    this.off[this.n] = p;
    for (let L = maxLen; L >= 0; L--) {
      if (this.byLenStart[L] === this.n) this.byLenStart[L] = this.byLenStart[L + 1];
    }

    // Build trie (nodes allocated on demand; children kept in a linked list).
    const cs: number[] = [-1];
    const sib: number[] = [-1];
    const nl: number[] = [0];
    const term: number[] = [-1];
    for (let i = 0; i < this.n; i++) {
      let node = 0;
      for (let j = this.off[i]; j < this.off[i + 1]; j++) {
        const c = this.letters[j];
        let ch = cs[node];
        while (ch !== -1 && nl[ch] !== c) ch = sib[ch];
        if (ch === -1) {
          ch = nl.length;
          nl.push(c);
          cs.push(-1);
          term.push(-1);
          sib.push(cs[node]);
          cs[node] = ch;
        }
        node = ch;
      }
      term[node] = i;
    }
    this.childStart = Int32Array.from(cs);
    this.sibling = Int32Array.from(sib);
    this.nodeLetter = Uint8Array.from(nl);
    this.terminal = Int32Array.from(term);
  }

  lenRange(minLen: number, maxLen: number): [number, number] {
    const top = this.byLenStart.length - 1;
    const a = this.byLenStart[Math.min(Math.max(minLen, 0), top)];
    const b = this.byLenStart[Math.min(Math.max(maxLen + 1, 0), top)];
    return [a, b];
  }

  /** All alphagrams that fit inside `rack` (rack is restored afterwards). */
  fitting(rack: Rack, minLen = 2, out: number[] = []): number[] {
    this.walk(0, -1, rack, 0, minLen, out);
    return out;
  }

  /** Alphagrams that fit inside `rack` and whose smallest letter is `first`. */
  fittingStartingWith(rack: Rack, first: number, out: number[]): number[] {
    let ch = this.childStart[0];
    while (ch !== -1 && this.nodeLetter[ch] !== first) ch = this.sibling[ch];
    if (ch === -1 || rack[first] <= 0) return out;
    rack[first]--;
    if (this.terminal[ch] >= 0) out.push(this.terminal[ch]);
    this.walk(ch, first, rack, 1, 2, out);
    rack[first]++;
    return out;
  }

  private walk(node: number, last: number, rack: Rack, depth: number, minLen: number, out: number[]) {
    for (let ch = this.childStart[node]; ch !== -1; ch = this.sibling[ch]) {
      const c = this.nodeLetter[ch];
      if (c < last || rack[c] <= 0) continue;
      rack[c]--;
      if (this.terminal[ch] >= 0 && depth + 1 >= minLen) out.push(this.terminal[ch]);
      this.walk(ch, c, rack, depth + 1, minLen, out);
      rack[c]++;
    }
  }

  isWordKey(letters: string): boolean {
    let node = 0;
    for (const c of [...letters].sort()) {
      const x = c.charCodeAt(0) - 65;
      let ch = this.childStart[node];
      while (ch !== -1 && this.nodeLetter[ch] !== x) ch = this.sibling[ch];
      if (ch === -1) return false;
      node = ch;
    }
    return this.terminal[node] >= 0;
  }

  /** Remove alphagram i's letters from rack (caller guarantees it fits). */
  take(rack: Rack, i: number) {
    for (let j = this.off[i]; j < this.off[i + 1]; j++) rack[this.letters[j]]--;
  }
  give(rack: Rack, i: number) {
    for (let j = this.off[i]; j < this.off[i + 1]; j++) rack[this.letters[j]]++;
  }
}

/**
 * Best set of disjoint words from `rack` (max total reward). Exact
 * branch-and-bound with memo; `budgetMs` caps runtime, falling back to the
 * best found so far.
 */
const partitionCache = new Map<string, { score: number; words: number[] }>();

export function bestPartition(
  lex: Lexicon,
  rack: Rack,
  budgetMs = 150,
): { score: number; words: number[] } {
  const rootKey = rack.join(",");
  const cached = partitionCache.get(rootKey);
  if (cached) return cached;
  const res = solvePartition(lex, rack, budgetMs);
  if (partitionCache.size > 50000) partitionCache.clear();
  partitionCache.set(rootKey, res);
  return res;
}

function solvePartition(
  lex: Lexicon,
  rack: Rack,
  budgetMs: number,
): { score: number; words: number[] } {
  const memo = new Map<string, { score: number; words: number[] }>();
  const deadline = performance.now() + budgetMs;
  let expired = false;
  const r = Int8Array.from(rack);

  const solve = (): { score: number; words: number[] } => {
    let first = -1;
    for (let i = 0; i < 26; i++)
      if (r[i] > 0) {
        first = i;
        break;
      }
    if (first < 0) return { score: 0, words: [] };
    const key = r.join(",");
    const hit = memo.get(key);
    if (hit) return hit;
    // Option 1: one copy of `first` stays unused.
    r[first]--;
    let best = solve();
    r[first]++;
    if (!expired) {
      const cands = lex.fittingStartingWith(r, first, []);
      // Try high rewards first so the budget fallback is decent.
      cands.sort((a, b) => lex.reward[b] - lex.reward[a]);
      for (const a of cands) {
        if (performance.now() > deadline) {
          expired = true;
          break;
        }
        lex.take(r, a);
        const sub = solve();
        lex.give(r, a);
        const s = lex.reward[a] + sub.score;
        if (s > best.score) best = { score: s, words: [a, ...sub.words] };
      }
    }
    memo.set(key, best);
    return best;
  };
  return solve();
}

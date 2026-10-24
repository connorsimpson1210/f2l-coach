import { CASES, type F2LCase } from './cases';
import { applyAlg, invertAlg, parseAlg, relabelForY, simplify, solved, type Move, type State } from './model';
import { SLOTS, solvedSlots, type SlotId } from './slots';

export interface PairScramble {
  moves: Move[];
  state: State;
  /** Slot → the case that was undone into it (before later set-ups moved pieces around). */
  cases: { slot: SlotId; caseId: number }[];
  /** U quarter-turns applied after the last case was undone (drill: the case's AUF). */
  finalAuf: number;
}

export interface ScrambleOptions {
  pairs: number;
  /** Restrict to these case numbers (drill mode). Defaults to all 41. */
  caseIds?: readonly number[];
  /** Restrict to these slots. Defaults to all four. */
  slots?: readonly SlotId[];
  rng?: () => number;
}

const pick = <T>(xs: readonly T[], rng: () => number) => xs[Math.floor(rng() * xs.length)];

function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const uTurn = (n: number): Move[] => (n % 4 ? [{ face: 'U', amount: (n % 4) as 1 | 2 | 3 }] : []);

/** Basic front-right inserts; relabelled onto other slots with y turns. */
const TRIGGERS = ["R U R'", "R U' R'", "R U2 R'", "F' U F", "F' U' F", "F' U2 F"].map(parseAlg);

/**
 * Short practice scramble: one or two basic triggers per chosen slot, mixed with U turns.
 * Every trigger touches only its slot and the U layer, so the cross and other slots stay solved.
 * Several candidates are built and the shortest valid one wins.
 */
export function triggerScramble({ pairs, rng = Math.random }: Pick<ScrambleOptions, 'pairs' | 'rng'>): PairScramble {
  const n = Math.max(1, Math.min(pairs, 4));
  let best: PairScramble | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const chosen = shuffle(SLOTS, rng).slice(0, n);
    const order = [...chosen, ...chosen.filter(() => rng() < 0.35)];
    let moves: Move[] = [];
    for (const slot of shuffle(order, rng)) {
      moves.push(...uTurn(Math.floor(rng() * 4)), ...relabelForY(pick(TRIGGERS, rng), slot.yTurns));
    }
    moves.push(...uTurn(Math.floor(rng() * 4)));
    moves = simplify(moves);
    while (moves[0]?.face === 'U') moves.shift(); // a leading U only moves last-layer pieces
    const state = applyAlg(solved(), moves);
    if (4 - solvedSlots(state).length !== n) continue;
    if (!best || moves.length < best.moves.length) best = { moves, state, cases: [], finalAuf: 0 };
    if (attempt >= 8 && best) break;
  }
  return best ?? pairScramble({ pairs: n, rng });
}

/**
 * Short cross-solved scramble with exactly `pairs` unsolved slots, built by undoing
 * F2L cases (each with a random AUF) on a solved cube. The cross is always intact.
 */
export function pairScramble({ pairs, caseIds, slots, rng = Math.random }: ScrambleOptions): PairScramble {
  const pool: readonly F2LCase[] = caseIds?.length ? CASES.filter((c) => caseIds.includes(c.id)) : CASES;
  const slotPool = SLOTS.filter((s) => !slots?.length || slots.includes(s.id));
  const n = Math.max(1, Math.min(pairs, slotPool.length));

  for (let attempt = 0; attempt < 50; attempt++) {
    const chosen = shuffle(slotPool, rng).slice(0, n);
    const cases: PairScramble['cases'] = [];
    let moves: Move[] = [];
    for (const slot of chosen) {
      const c = pick(pool, rng);
      cases.push({ slot: slot.id, caseId: c.id });
      const solve = relabelForY(parseAlg(c.alg), slot.yTurns);
      moves.push(...uTurn(Math.floor(rng() * 4)), ...invertAlg(solve));
    }
    const finalAuf = Math.floor(rng() * 4);
    moves.push(...uTurn(finalAuf));
    moves = simplify(moves);
    const state = applyAlg(solved(), moves);
    if (4 - solvedSlots(state).length === n) return { moves, state, cases, finalAuf };
  }
  throw new Error('Could not build a scramble');
}

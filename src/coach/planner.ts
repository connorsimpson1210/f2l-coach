// Benchmark planner: solves F2L the way a person does, one pair at a time, always taking the
// pair that's cheapest from where you're looking right now (including the rotation to get there).

import { applyAlg, relabelForY, type Face, type Move, type State } from '../cube/model';
import { SLOTS, solvedSlots, type SlotId } from '../cube/slots';
import { intuitiveSolutions, moveCost, seenMoves, solveSlot } from '../cube/solver';
import { rotationPenalty, type Weights } from './levels';

export interface PairOption {
  slot: SlotId;
  /** View the pair is solved from, in y quarter-turns from the standard view (green front). */
  view: number;
  /** y quarter-turns from the view you were in to `view` (1 = y, 3 = y'). */
  rotation: number;
  /** Moves as you see them from `view`. */
  seen: Move[];
  /** The same moves in the fixed logical frame. */
  moves: Move[];
  cost: number;
  /** Built only from basic inserts (R U R', F' U F…). */
  intuitive: boolean;
}

const mod4 = (n: number) => ((n % 4) + 4) % 4;
const slotById = (id: SlotId) => SLOTS.find((s) => s.id === id)!;

/** Where a slot sits when the cube is viewed after y^view: 0 front-right, 1 back-right, 2 back-left, 3 front-left. */
export const seenSlotPosition = (id: SlotId, view: number) => mod4(slotById(id).yTurns - view);

/** The view that brings a slot to front-right. */
export const frontRightView = (id: SlotId) => slotById(id).yTurns;

function allowedViews(id: SlotId, w: Weights): number[] {
  const fr = frontRightView(id);
  if (w.views === 'front-right') return [fr];
  if (w.views === 'front') return [fr, mod4(fr + 1)];
  return [0, 1, 2, 3];
}

const usesFB = (seen: readonly Move[]) => seen.some((m) => m.face === 'F' || m.face === 'B');

/** The cheapest way to solve each target pair from the current view, at this level. */
export function pairOptions(
  state: State, view: number, targets: readonly SlotId[], keep: readonly SlotId[], w: Weights,
): PairOption[] {
  const out: PairOption[] = [];
  for (const target of targets) {
    const views = allowedViews(target, w);
    const intuitive = intuitiveSolutions(state, target, keep, 4, w.littleF);
    const searched = solveSlot(state, { target, keep, extra: 2, maxSolutions: 200, timeMs: 250 }).solutions;
    if (!w.littleF) {
      // Make sure there's always an R/U/L-only answer from each allowed view.
      for (const v of views) {
        const faces = relabelForY([{ face: 'U', amount: 1 }, { face: 'R', amount: 1 }, { face: 'L', amount: 1 }], v).map((m) => m.face) as Face[];
        searched.push(...solveSlot(state, { target, keep, faces, extra: 1, maxDepth: 15, timeMs: 150 }).solutions);
      }
    }
    const pools: [Move[][], boolean][] = w.intuitive && intuitive.length
      ? [[intuitive, true]]
      : [[intuitive, true], [searched, false]];

    let best: PairOption | null = null;
    for (const [pool, isIntuitive] of pools) {
      for (const moves of pool) {
        for (const v of views) {
          const seen = seenMoves(moves, v);
          if (!w.littleF && usesFB(seen)) continue;
          const rotation = mod4(v - view);
          const cost = moveCost(seen, w.cost) + rotationPenalty(rotation, w);
          if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && moves.length < best.moves.length)) {
            best = { slot: target, view: v, rotation, seen, moves, cost, intuitive: isIntuitive };
          }
        }
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** Greedy whole-F2L benchmark: repeatedly take the cheapest pair from where you are. */
export function planSolve(state: State, view: number, w: Weights): PairOption[] {
  const steps: PairOption[] = [];
  let s = state;
  let v = view;
  for (let guard = 0; guard < 4; guard++) {
    const done = solvedSlots(s);
    const targets = SLOTS.map((sl) => sl.id).filter((id) => !done.includes(id));
    if (!targets.length) break;
    const best = pairOptions(s, v, targets, done, w)[0];
    if (!best) break;
    steps.push(best);
    s = applyAlg(s, best.moves);
    v = best.view;
  }
  return steps;
}

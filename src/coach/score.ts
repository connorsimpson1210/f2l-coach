// Scores a solve out of 10 against a good solve at your level, not against the one perfect answer.
// Each pair is scored on efficiency, pair choice and (optionally) flow; the curve falls off gently,
// so a sensible solve that's a little longer than the benchmark still scores well.

import { applyAlg, type Move, type State } from '../cube/model';
import { SLOTS, solvedSlots, type SlotId } from '../cube/slots';
import { moveCost } from '../cube/solver';
import { rotationPenalty, rotationQuarters, type Weights } from './levels';
import type { PairOption } from './planner';

/** One turn you made: logical moves, how it looked on screen (null for wide/slice turns), when, and from which view. */
export interface SolveStep {
  moves: Move[];
  seen: Move | null;
  at: number;
  view: number;
}

export interface Segment {
  /** Slots that became solved at the end of this segment (two when you multislotted). */
  slots: SlotId[];
  startState: State;
  startView: number;
  /** Slots already solved when the segment began (must stay solved in the benchmark). */
  keep: SlotId[];
  /** Unsolved targets when the segment began (the pairs you could have chosen). */
  open: SlotId[];
  steps: SolveStep[];
  /** Time looking for the pair before its first move, plus long hesitations during it. */
  pauseMs: number;
}

const HESITATION_MS = 1000;

/** Split a solve into one segment per pair, in the order you solved them. */
export function segmentSolve(start: State, steps: readonly SolveStep[], targets: readonly SlotId[]): Segment[] {
  const out: Segment[] = [];
  const credited = new Set<SlotId>(solvedSlots(start));
  let s = start;
  let from = 0;
  let segStart = start;
  for (let i = 0; i < steps.length; i++) {
    s = applyAlg(s, steps[i].moves);
    const solvedNow = solvedSlots(s);
    const newly = targets.filter((id) => solvedNow.includes(id) && !credited.has(id));
    if (!newly.length) continue;
    const segSteps = steps.slice(from, i + 1);
    const before = from > 0 ? steps[from - 1] : null;
    let pause = before ? segSteps[0].at - before.at : 0;
    for (let j = 1; j < segSteps.length; j++) pause += Math.max(0, segSteps[j].at - segSteps[j - 1].at - HESITATION_MS);
    const keep = [...credited];
    out.push({
      slots: newly,
      startState: segStart,
      startView: before ? before.view : segSteps[0].view,
      keep,
      open: targets.filter((id) => !keep.includes(id)),
      steps: segSteps,
      pauseMs: pause,
    });
    newly.forEach((id) => credited.add(id));
    from = i + 1;
    segStart = s;
  }
  return out;
}

/** Your cost for a segment, in the same units as the benchmark. */
export function userCost(seg: Pick<Segment, 'steps' | 'startView'>, w: Weights) {
  const seen = mergeDoubles(seg.steps.flatMap((st) => (st.seen ? [st.seen] : [])));
  const unparsed = seg.steps.filter((st) => !st.seen).length;
  let rotationCost = 0;
  let rotations = 0;
  let view = seg.startView;
  for (const st of seg.steps) {
    rotationCost += rotationPenalty(st.view - view, w);
    rotations += rotationQuarters(st.view - view);
    view = st.view;
  }
  return { cost: moveCost(seen, w.scoreCost) + unparsed * 1.3 + rotationCost, moves: seen.length + unparsed, rotations };
}

/** Keyboards and smart cubes send R2 as two quarter turns; count them as one. Cancelling turns stay as waste. */
function mergeDoubles(moves: readonly Move[]): Move[] {
  const out: Move[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && last.face === m.face && last.amount === m.amount && m.amount !== 2) out[out.length - 1] = { face: m.face, amount: 2 };
    else out.push(m);
  }
  return out;
}

/** A benchmark option's cost in scoring units (same scale as userCost). */
const parCost = (o: PairOption, w: Weights) => moveCost(o.seen, w.scoreCost) + rotationPenalty(o.rotation, w);

/** 10 at or under par, then a gentle fall-off; `slack` is how forgiving it is. */
export function efficiencyScore(user: number, par: number, slack: number) {
  if (par <= 0) return 10;
  const r = user / par;
  return r <= 1 ? 10 : 10 * Math.exp(-(r - 1) / slack);
}

export function flowScore(pauseMs: number, targetMs: number) {
  return pauseMs <= targetMs ? 10 : 10 * Math.exp(-(pauseMs - targetMs) / (2 * targetMs));
}

export interface PairScore {
  slots: SlotId[];
  score: number;
  efficiency: number;
  choice: number | null;
  flow: number | null;
  moves: number;
  par: number;
  rotations: number;
  pauseMs: number;
  /** Sheet case each pair was in when you started it (null when its pieces were somewhere odd). */
  caseIds: (number | null)[];
  /** The benchmark for the pair you solved, and the easiest pair you could have taken. */
  benchmark: PairOption | null;
  easiest: PairOption | null;
  startState: State;
  startView: number;
}

export interface Tip {
  pair: number;
  text: string;
  route: PairOption;
}

export interface SolveScore {
  score: number;
  pairs: PairScore[];
  tip: Tip | null;
}

const WEIGHT = { efficiency: 0.65, choice: 0.15, flow: 0.2 };
const round1 = (x: number) => Math.round(x * 10) / 10;
const slotName = (id: SlotId) => SLOTS.find((s) => s.id === id)!.name;
const parMoves = (o: PairOption) => o.seen.length + rotationQuarters(o.rotation);

export function scoreSolve(
  segments: readonly Segment[],
  options: readonly PairOption[][],
  caseIds: readonly (number | null)[][],
  w: Weights,
): SolveScore {
  const pairs = segments.map((seg, i): PairScore => {
    const opts = options[i] ?? [];
    const mine = seg.slots.map((id) => opts.find((o) => o.slot === id)).filter((o): o is PairOption => !!o);
    const easiest = opts[0] ?? null;
    const user = userCost(seg, w);
    const par = mine.reduce((a, o) => a + parCost(o, w), 0);
    const efficiency = mine.length ? efficiencyScore(user.cost, par, w.slack) : 10;

    let choice: number | null = null;
    if (opts.length > 1 && seg.slots.length === 1 && mine.length && easiest) {
      const q = parCost(mine[0], w) / parCost(easiest, w);
      choice = q <= 1.1 ? 10 : 10 * Math.exp(-(q - 1.1) / (w.slack * 1.5));
    }
    const flow = w.flow && (i > 0 || seg.pauseMs > 0) ? flowScore(seg.pauseMs, w.flowTargetMs) : null;

    const parts: [number, number][] = [[efficiency, WEIGHT.efficiency]];
    if (choice !== null) parts.push([choice, WEIGHT.choice]);
    if (flow !== null) parts.push([flow, WEIGHT.flow]);
    const total = parts.reduce((a, [v, k]) => a + v * k, 0) / parts.reduce((a, [, k]) => a + k, 0);

    return {
      slots: seg.slots,
      score: round1(total),
      efficiency, choice, flow,
      moves: user.moves,
      par: mine.reduce((a, o) => a + parMoves(o), 0),
      rotations: user.rotations,
      pauseMs: seg.pauseMs,
      caseIds: caseIds[i] ?? seg.slots.map(() => null),
      benchmark: mine[0] ?? null,
      easiest,
      startState: seg.startState,
      startView: seg.startView,
    };
  });

  const n = pairs.reduce((a, p) => a + p.slots.length, 0);
  const score = n ? round1(pairs.reduce((a, p) => a + p.score * p.slots.length, 0) / n) : 0;
  return { score, pairs, tip: tipFor(pairs) };
}

/** The single change that would have gained the most points. */
function tipFor(pairs: readonly PairScore[]): Tip | null {
  let best: Tip | null = null;
  let bestLost = 0.15;
  for (const [i, p] of pairs.entries()) {
    if (p.score >= 9.5) continue;
    const name = slotName(p.slots[0]);
    const candidates: [number, Tip | null][] = [
      [WEIGHT.efficiency * (10 - p.efficiency), p.benchmark && {
        pair: i, route: p.benchmark,
        text: p.moves > p.par
          ? `${name} took ${p.moves} moves where about ${p.par} would do.`
          : `${name} has a smoother route with ${p.par === p.moves ? 'the same number of' : 'fewer'} moves.`,
      }],
      [WEIGHT.choice * (10 - (p.choice ?? 10)), p.easiest && p.easiest.slot !== p.slots[0] ? {
        pair: i, route: p.easiest,
        text: `${slotName(p.easiest.slot)} was the easier pair to take before ${name}.`,
      } : null],
      [WEIGHT.flow * (10 - (p.flow ?? 10)), p.benchmark && {
        pair: i, route: p.benchmark,
        text: `You paused ${(p.pauseMs / 1000).toFixed(1)}s finding ${name}. Try spotting the next pair while you finish this one.`,
      }],
    ];
    for (const [lost, tip] of candidates) {
      if (tip && lost > bestLost) [best, bestLost] = [tip, lost];
    }
  }
  return best;
}

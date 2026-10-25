// Difficulty levels. A level sets what the benchmark solve looks like and how strict the score is;
// the criteria toggles override parts of it.

import { COST, type CostTable } from '../cube/solver';

export type LevelId = 'beginner' | 'intermediate' | 'advanced' | 'pro';

export interface Criteria {
  /** Cube rotations cost points and the benchmark avoids them. */
  rotations: boolean;
  /** F and B turns are allowed in the benchmark (pros use little F tricks). */
  littleF: boolean;
  /** Back pairs may be solved from the front without rotating. */
  backSlots: boolean;
  /** Pauses between pairs count against the score. */
  flow: boolean;
}

export interface Level {
  id: LevelId;
  name: string;
  blurb: string;
  criteria: Criteria;
  /** Cost of one y rotation, in comfortable moves. */
  rotation: number;
  /** How forgiving the efficiency score is: a bigger number lets longer solves still score well. */
  slack: number;
  /** A pause before a pair longer than this starts to cost flow points. */
  flowTargetMs: number;
  /** Benchmark prefers pair-up-and-insert solutions over clever ones. */
  intuitive: boolean;
  cost: Partial<CostTable>;
}

export const LEVELS: readonly Level[] = [
  {
    id: 'beginner', name: 'Beginner',
    blurb: 'Rotate the pair to the front, pair it up, insert. Generous par.',
    criteria: { rotations: false, littleF: true, backSlots: false, flow: false },
    rotation: 0.9, slack: 1.6, flowTargetMs: 3000, intuitive: true, cost: {},
  },
  {
    id: 'intermediate', name: 'Intermediate',
    blurb: 'Pick the easiest pair, use comfortable routes, rotate a little less.',
    criteria: { rotations: true, littleF: true, backSlots: false, flow: true },
    rotation: 1.6, slack: 1.2, flowTargetMs: 2000, intuitive: false, cost: {},
  },
  {
    id: 'advanced', name: 'Advanced',
    blurb: 'About one rotation per pair at most; back slots and F tricks are fair game.',
    criteria: { rotations: true, littleF: true, backSlots: true, flow: true },
    rotation: 2.4, slack: 0.9, flowTargetMs: 1200, intuitive: false, cost: { F: 1.8, F2: 2.4 },
  },
  {
    id: 'pro', name: 'Pro',
    blurb: 'Sees everything: 2–3 rotations for the whole F2L, little F’s, tight par.',
    criteria: { rotations: true, littleF: true, backSlots: true, flow: true },
    rotation: 3.4, slack: 0.7, flowTargetMs: 700, intuitive: false, cost: { F: 1.5, F2: 2.2, L: 1.05 },
  },
];

export const levelById = (id: LevelId) => LEVELS.find((l) => l.id === id) ?? LEVELS[0];

export interface Profile {
  level: LevelId;
  criteria: Criteria;
}

/** Everything the planner and the scorer need, resolved from a level and its toggles. */
export interface Weights {
  /** Comfort costs the benchmark is chosen with (prefers R and U strongly). */
  cost: CostTable;
  /** Gentler costs used for scoring, so a fine basic insert like F' U F isn't punished for not being R U R'. */
  scoreCost: CostTable;
  /** Cost of a y (y2 costs 1.75×). Tiny when rotations don't count, so it only breaks ties. */
  rotation: number;
  slack: number;
  flowTargetMs: number;
  flow: boolean;
  littleF: boolean;
  /** Which views a target slot may be solved from: only front-right, the front two, or any. */
  views: 'front-right' | 'front' | 'any';
  intuitive: boolean;
}

export function weightsFor(p: Profile): Weights {
  const level = levelById(p.level);
  const cost: CostTable = { ...COST, ...level.cost };
  const scoreCost = Object.fromEntries(
    Object.entries(cost).map(([k, v]) => [k, k === 'handSwitch' ? v / 2 : 1 + (v - 1) * 0.4]),
  ) as CostTable;
  return {
    cost,
    scoreCost,
    rotation: p.criteria.rotations ? level.rotation : 0.15,
    slack: level.slack,
    flowTargetMs: level.flowTargetMs,
    flow: p.criteria.flow,
    littleF: p.criteria.littleF,
    views: p.criteria.backSlots ? 'any' : level.id === 'beginner' ? 'front-right' : 'front',
    intuitive: level.intuitive,
  };
}

/** Cost of turning the view by k y quarter-turns (k = 0..3). */
export const rotationQuarters = (k: number) => [0, 1, 2, 1][((k % 4) + 4) % 4];
export const rotationPenalty = (k: number, w: Weights) => {
  const q = rotationQuarters(k);
  return q === 2 ? w.rotation * 1.75 : q * w.rotation;
};

export const sameCriteria = (a: Criteria, b: Criteria) =>
  a.rotations === b.rotations && a.littleF === b.littleF && a.backSlots === b.backSlots && a.flow === b.flow;

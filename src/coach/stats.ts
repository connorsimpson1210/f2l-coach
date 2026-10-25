// Progress over time: rolling averages per level and drill suggestions.
// A case is only suggested when it keeps scoring below your own norm, not after one bad solve.

import type { LevelId } from './levels';

export interface SolveRecord {
  at: number;
  level: LevelId;
  score: number;
}

export interface CaseRecord {
  caseId: number;
  /** Efficiency for that pair, out of 10. */
  score: number;
  at: number;
  source: 'practice' | 'drill';
}

export interface History {
  solves: SolveRecord[];
  cases: CaseRecord[];
}

export const MAX_SOLVES = 300;
export const MAX_CASES = 800;

export function addSolve(h: History, solve: SolveRecord, cases: CaseRecord[]): History {
  return {
    solves: [...h.solves, solve].slice(-MAX_SOLVES),
    cases: [...h.cases, ...cases].slice(-MAX_CASES),
  };
}

export function addCases(h: History, cases: CaseRecord[]): History {
  return { ...h, cases: [...h.cases, ...cases].slice(-MAX_CASES) };
}

export function rolling(h: History, level: LevelId, n = 12) {
  const mine = h.solves.filter((s) => s.level === level);
  const last = mine.slice(-n);
  const avg = last.length ? last.reduce((a, s) => a + s.score, 0) / last.length : null;
  const prev = mine.slice(-2 * n, -n);
  const prevAvg = prev.length >= n / 2 ? prev.reduce((a, s) => a + s.score, 0) / prev.length : null;
  const best = mine.length ? Math.max(...mine.map((s) => s.score)) : null;
  return { avg, best, count: mine.length, window: last.length, trend: avg !== null && prevAvg !== null ? avg - prevAvg : null };
}

export interface DrillSuggestion {
  caseId: number;
  seen: number;
  /** Shrunk average: pulled towards your overall norm so a few results can't swing it. */
  estimate: number;
  norm: number;
}

/** How many recent results per case count, and how strongly the estimate is pulled towards your norm. */
const RECENT = 8;
const PRIOR = 3;
const MIN_SEEN = 3;
const MARGIN = 0.8;

export function suggestDrills(h: History, max = 6): DrillSuggestion[] {
  const recent = h.cases.slice(-200);
  if (recent.length < 8) return [];
  const norm = recent.reduce((a, c) => a + c.score, 0) / recent.length;
  const byCase = new Map<number, CaseRecord[]>();
  for (const c of h.cases) byCase.set(c.caseId, [...(byCase.get(c.caseId) ?? []), c]);

  const out: DrillSuggestion[] = [];
  for (const [caseId, all] of byCase) {
    const last = all.slice(-RECENT);
    if (last.length < MIN_SEEN) continue;
    // Recent results weigh more, so drilling a case and getting it right clears it.
    let sum = 0;
    let weight = 0;
    last.forEach((c, i) => {
      const k = 0.6 + (0.4 * (i + 1)) / last.length;
      sum += c.score * k;
      weight += k;
    });
    const estimate = (sum + norm * PRIOR) / (weight + PRIOR);
    if (estimate < norm - MARGIN && estimate < 8) out.push({ caseId, seen: last.length, estimate, norm });
  }
  return out.sort((a, b) => a.estimate - b.estimate).slice(0, max);
}

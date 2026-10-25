import { describe, expect, it } from 'vitest';
import { CASES } from '../cube/cases';
import { applyAlg, invertAlg, parseAlg, relabelForY, solved, type Move } from '../cube/model';
import { recogniseCase } from '../cube/recognise';
import { triggerScramble } from '../cube/scramble';
import { SLOTS, isCrossSolved, solvedSlots } from '../cube/slots';
import { LEVELS, weightsFor, type LevelId } from './levels';
import { pairOptions, planSolve, seenSlotPosition } from './planner';
import { efficiencyScore, scoreSolve, segmentSolve, type SolveStep } from './score';
import { addSolve, suggestDrills, type CaseRecord, type History } from './stats';

const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const weights = (level: LevelId, over = {}) =>
  weightsFor({ level, criteria: { ...LEVELS.find((l) => l.id === level)!.criteria, ...over } });

describe('case recognition', () => {
  it.each(SLOTS.map((s) => [s.id, s.yTurns] as const))('recognises all 41 cases in %s, at any AUF', (id, y) => {
    for (const c of CASES) {
      for (const auf of [0, 1, 3]) {
        const u: Move[] = auf ? [{ face: 'U', amount: auf as 1 | 3 }] : [];
        const s = applyAlg(solved(), [...invertAlg(relabelForY(parseAlg(c.alg), y)), ...u]);
        expect(recogniseCase(s, id), `case ${c.id}`).toBe(c.id);
      }
    }
  });
});

describe('benchmark planner', () => {
  it('solves every pair of 4-pair scrambles at every level', () => {
    const rng = seeded(7);
    for (const level of ['beginner', 'intermediate', 'advanced', 'pro'] as const) {
      for (let i = 0; i < 3; i++) {
        const sc = triggerScramble({ pairs: 4, rng });
        const plan = planSolve(sc.state, 0, weights(level));
        const end = applyAlg(sc.state, plan.flatMap((p) => p.moves));
        expect(isCrossSolved(end)).toBe(true);
        expect(solvedSlots(end)).toHaveLength(4);
      }
    }
  });

  it('respects the toggles: no F/B, and back slots only from the front', () => {
    const rng = seeded(11);
    const w = weights('intermediate', { littleF: false, backSlots: false });
    for (let i = 0; i < 4; i++) {
      const sc = triggerScramble({ pairs: 3, rng });
      for (const step of planSolve(sc.state, 0, w)) {
        expect(step.seen.some((m) => m.face === 'F' || m.face === 'B')).toBe(false);
        expect([0, 3]).toContain(seenSlotPosition(step.slot, step.view));
      }
    }
  });

  it('pro rotates less than beginner over the same scrambles', () => {
    const rng = seeded(3);
    let beginner = 0;
    let pro = 0;
    for (let i = 0; i < 5; i++) {
      const sc = triggerScramble({ pairs: 4, rng });
      beginner += planSolve(sc.state, 0, weights('beginner')).filter((p) => p.rotation).length;
      pro += planSolve(sc.state, 0, weights('pro')).filter((p) => p.rotation).length;
    }
    expect(pro).toBeLessThan(beginner);
  });
});

describe('scoring', () => {
  const steps = (alg: string, view = 0, gap = 300, t0 = 0): SolveStep[] =>
    parseAlg(alg).map((m, i) => ({ moves: [m], seen: m, at: t0 + i * gap, view }));

  it('matching the benchmark scores 10, a longer solve scores gently less', () => {
    expect(efficiencyScore(10, 10, 1.2)).toBe(10);
    expect(efficiencyScore(12, 10, 1.2)).toBeGreaterThan(8);
    expect(efficiencyScore(20, 10, 1.2)).toBeGreaterThan(4);
    expect(efficiencyScore(20, 10, 1.6)).toBeGreaterThan(efficiencyScore(20, 10, 0.7));
  });

  it('segments a solve per pair and scores the benchmark itself near 10', () => {
    const sc = triggerScramble({ pairs: 2, rng: seeded(5) });
    const w = weights('intermediate');
    const plan = planSolve(sc.state, 0, w);
    // Replay the benchmark as if you'd played it (from the matching view each pair).
    let t = 0;
    const played: SolveStep[] = plan.flatMap((p) => p.moves.map((m, i) => ({ moves: [m], seen: p.seen[i], at: (t += 300), view: p.view })));
    const segs = segmentSolve(sc.state, played, ['FR', 'FL', 'BR', 'BL'].filter((id) => !solvedSlots(sc.state).includes(id as never)) as never);
    expect(segs).toHaveLength(plan.length);
    const options = segs.map((s) => pairOptions(s.startState, s.startView, s.open, s.keep, w));
    const result = scoreSolve(segs, options, segs.map((s) => s.slots.map(() => null)), w);
    expect(result.score).toBeGreaterThanOrEqual(9.5);
  });

  it('a padded solve loses points but is not crushed', () => {
    const s = applyAlg(solved(), parseAlg("R U' R'"));
    const w = weights('beginner');
    const sloppy = steps("U U' R U R'"); // two wasted moves
    const segs = segmentSolve(s, sloppy, ['FR']);
    const options = segs.map((x) => pairOptions(x.startState, x.startView, x.open, x.keep, w));
    const r = scoreSolve(segs, options, [[null]], w);
    expect(r.score).toBeLessThan(10);
    expect(r.score).toBeGreaterThan(6);
    expect(r.tip?.text).toMatch(/moves/);
  });
});

describe('drill suggestions', () => {
  const rec = (caseId: number, score: number, i: number): CaseRecord => ({ caseId, score, at: i, source: 'practice' });
  const base = (): History => ({ solves: [], cases: Array.from({ length: 40 }, (_, i) => rec(1 + (i % 20), 8, i)) });

  it('ignores one bad result', () => {
    const h = addSolve(base(), { at: 0, level: 'beginner', score: 5 }, [rec(30, 2, 100)]);
    expect(suggestDrills(h)).toEqual([]);
  });

  it('flags a case that keeps going badly, and clears it once it improves', () => {
    let h = base();
    for (let i = 0; i < 4; i++) h = addSolve(h, { at: i, level: 'beginner', score: 6 }, [rec(30, 4, 100 + i)]);
    expect(suggestDrills(h).map((d) => d.caseId)).toEqual([30]);
    for (let i = 0; i < 6; i++) h = addSolve(h, { at: i, level: 'beginner', score: 8 }, [rec(30, 9, 200 + i)]);
    expect(suggestDrills(h)).toEqual([]);
  });
});

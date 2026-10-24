import { describe, expect, it } from 'vitest';
import { CASES } from './cases';
import { applyAlg, formatAlg, invertAlg, parseAlg, solved } from './model';
import { isCrossSolved, solvedSlots } from './slots';
import { findRoutes, intuitiveSolutions, parseRoute, routeText, solveSlot } from './solver';

const KEEP = ['FL', 'BR', 'BL'] as const;

describe('pair solver', () => {
  it("finds exactly R U R' for the inverse of R U R'", () => {
    const s = applyAlg(solved(), parseAlg("R U' R'"));
    const r = solveSlot(s, { target: 'FR', keep: KEEP });
    expect(r.optimal).toBe(3);
    expect(r.solutions.map(formatAlg)).toContain("R U R'");
  });

  it.each(CASES.map((c) => [c.id, c.alg] as const))('case %i: every solution is valid and no longer than the sheet', (_, alg) => {
    const s = applyAlg(solved(), invertAlg(parseAlg(alg)));
    const r = solveSlot(s, { target: 'FR', keep: KEEP, extra: 1 });
    expect(r.timedOut).toBe(false);
    expect(r.optimal).toBeLessThanOrEqual(parseAlg(alg).length);
    for (const sol of r.solutions) {
      const end = applyAlg(s, sol);
      expect(isCrossSolved(end)).toBe(true);
      expect(solvedSlots(end)).toEqual(['FR', 'FL', 'BR', 'BL']);
    }
  });

  it('intuitive search solves every case with basic inserts', () => {
    for (const c of CASES) {
      const s = applyAlg(solved(), invertAlg(parseAlg(c.alg)));
      const sols = intuitiveSolutions(s, 'FR', KEEP);
      expect(sols.length, `case ${c.id}`).toBeGreaterThan(0);
      expect(solvedSlots(applyAlg(s, sols[0]))).toHaveLength(4);
    }
  });

  it('routes round-trip through text, including rotations', () => {
    const s = applyAlg(solved(), invertAlg(parseAlg(CASES[3].alg))); // case 4
    const routes = findRoutes(s, 'FR', KEEP);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const r of routes) {
      const back = parseRoute(routeText(r));
      expect(formatAlg(back.moves)).toBe(formatAlg(r.moves));
      expect(solvedSlots(applyAlg(s, r.moves))).toHaveLength(4);
    }
    console.log(routes.map((r) => `${r.label}: ${routeText(r)} (${r.cost.toFixed(1)})`).join('\n'));
  });
});

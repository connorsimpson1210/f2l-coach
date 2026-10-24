import { describe, expect, it } from 'vitest';
import { CASES } from './cases';
import {
  FACES, STICKERS, applyAlg, applyMove, colorAt, formatAlg, invertAlg, isSolved, parseAlg, relabelForY, simplify, solved,
} from './model';
import { SLOTS, isCrossSolved, isSlotSolved, solvedSlots } from './slots';
import { pairScramble, triggerScramble } from './scramble';

describe('cube model', () => {
  it('has 54 unique stickers, 9 per face', () => {
    expect(STICKERS).toHaveLength(54);
    for (const f of FACES) expect(STICKERS.filter((s) => s.face === f)).toHaveLength(9);
  });

  it('each face turn has order 4 and is a permutation', () => {
    for (const face of FACES) {
      let s = solved();
      for (let i = 0; i < 4; i++) {
        s = applyMove(s, { face, amount: 1 });
        expect(new Set(s).size).toBe(54);
        if (i < 3) expect(isSolved(s)).toBe(false);
      }
      expect(isSolved(s)).toBe(true);
    }
  });

  it('turns move the expected stickers (U sends front stickers to the left)', () => {
    const s = applyMove(solved(), { face: 'U', amount: 1 });
    // After U, the top row of L shows green (F colour).
    expect(colorAt(s, 36)).toBe('F');
    // After R, the front-right column of U shows green.
    const r = applyMove(solved(), { face: 'R', amount: 1 });
    expect(colorAt(r, 8)).toBe('F');
    expect(colorAt(r, 2)).toBe('F');
  });

  it("sexy move has order 6", () => {
    const sexy = parseAlg("R U R' U'");
    let s = solved();
    for (let i = 0; i < 6; i++) s = applyAlg(s, sexy);
    expect(isSolved(s)).toBe(true);
  });

  it('parses and formats notation', () => {
    expect(formatAlg(parseAlg("R U2 R' F2' D’"))).toBe("R U2 R' F2 D'");
    expect(() => parseAlg('Rw')).toThrow();
  });

  it('simplifies consecutive turns', () => {
    expect(formatAlg(simplify(parseAlg("U U R R' U2 U")))).toBe('U');
    expect(formatAlg(simplify(parseAlg("R R' U U")))).toBe('U2');
    expect(formatAlg(simplify(parseAlg('U U2 U')))).toBe('');
  });

  it('relabels y-rotated algs onto the right slot', () => {
    const alg = parseAlg("R U R'");
    for (const slot of SLOTS) {
      const moves = relabelForY(alg, slot.yTurns);
      const s = applyAlg(solved(), invertAlg(moves));
      expect(isCrossSolved(s)).toBe(true);
      expect(solvedSlots(s)).toEqual(SLOTS.filter((x) => x.id !== slot.id).map((x) => x.id));
    }
  });
});

describe('F2L cases', () => {
  it.each(CASES.map((c) => [c.id, c.alg] as const))('case %i only touches the FR slot and the U layer', (_, alg) => {
    const s = applyAlg(solved(), invertAlg(parseAlg(alg)));
    expect(isCrossSolved(s)).toBe(true);
    expect(isSlotSolved(s, 'FR')).toBe(false);
    expect(solvedSlots(s)).toEqual(['FL', 'BR', 'BL']);
    expect(isSolved(applyAlg(s, parseAlg(alg)))).toBe(true);
  });
});

describe('pair scrambles', () => {
  it('produces exactly N unsolved slots with the cross intact', () => {
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i < 100; i++) {
        const sc = pairScramble({ pairs: n });
        expect(isCrossSolved(sc.state)).toBe(true);
        expect(4 - solvedSlots(sc.state).length).toBe(n);
        expect(applyAlg(solved(), sc.moves)).toEqual(sc.state);
      }
    }
  });

  it('trigger scrambles are short and leave exactly N pairs unsolved', () => {
    for (let n = 1; n <= 4; n++) {
      let total = 0;
      for (let i = 0; i < 200; i++) {
        const sc = triggerScramble({ pairs: n });
        expect(isCrossSolved(sc.state)).toBe(true);
        expect(4 - solvedSlots(sc.state).length).toBe(n);
        expect(applyAlg(solved(), sc.moves)).toEqual(sc.state);
        total += sc.moves.length;
      }
      expect(total / 200).toBeLessThanOrEqual(5 * n);
    }
  });

  it('respects case and slot filters', () => {
    const sc = pairScramble({ pairs: 1, caseIds: [9], slots: ['FR'] });
    expect(sc.cases).toEqual([{ slot: 'FR', caseId: 9 }]);
    expect(solvedSlots(sc.state)).toEqual(['FL', 'BR', 'BL']);
  });
});

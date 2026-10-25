// Recognise which of the 41 sheet cases a pair is in, for any slot, ignoring the AUF.

import { CASES } from './cases';
import { applyAlg, invertAlg, parseAlg, relabelForY, solved, stickerAt, type Move, type State, type Vec3 } from './model';
import { SLOTS, type SlotId } from './slots';

const D: Vec3 = [0, -1, 0];
const refs = (id: SlotId) => {
  const s = SLOTS.find((x) => x.id === id)!;
  return { corner: stickerAt(s.corner, D), edge: stickerAt(s.edge, [0, 0, s.edge[2]]) };
};

/** A pair's position and orientation: where its corner's and edge's reference stickers are. */
function signature(state: State, id: SlotId) {
  const r = refs(id);
  return `${state.indexOf(r.corner)},${state.indexOf(r.edge)}`;
}

let table: Map<string, number> | null = null;

function build() {
  table = new Map();
  for (const slot of SLOTS) {
    for (const c of CASES) {
      const undo = invertAlg(relabelForY(parseAlg(c.alg), slot.yTurns));
      for (let auf = 0; auf < 4; auf++) {
        const u: Move[] = auf ? [{ face: 'U', amount: auf as 1 | 2 | 3 }] : [];
        const st = applyAlg(solved(), [...undo, ...u]);
        const key = `${slot.id}|${signature(st, slot.id)}`;
        if (!table.has(key)) table.set(key, c.id);
      }
    }
  }
  return table;
}

/** The case number of a slot's pair, or null when its pieces aren't in a sheet case (e.g. in another slot). */
export function recogniseCase(state: State, id: SlotId): number | null {
  return (table ?? build()).get(`${id}|${signature(state, id)}`) ?? null;
}

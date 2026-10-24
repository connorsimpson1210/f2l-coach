import { STICKERS, type State, type Vec3 } from './model';

export type SlotId = 'FR' | 'FL' | 'BR' | 'BL';

export interface Slot {
  id: SlotId;
  name: string;
  /** CSS colours of the two side stickers, front/back colour first. */
  colors: [string, string];
  corner: Vec3;
  edge: Vec3;
  /** y quarter-turns that bring this slot to front-right. */
  yTurns: number;
  key: string;
}

export const SLOTS: readonly Slot[] = [
  { id: 'FR', name: 'Green–orange', colors: ['green', 'orange'], corner: [1, -1, 1], edge: [1, 0, 1], yTurns: 0, key: '1' },
  { id: 'FL', name: 'Green–red', colors: ['green', 'red'], corner: [-1, -1, 1], edge: [-1, 0, 1], yTurns: 3, key: '2' },
  { id: 'BR', name: 'Blue–orange', colors: ['blue', 'orange'], corner: [1, -1, -1], edge: [1, 0, -1], yTurns: 1, key: '3' },
  { id: 'BL', name: 'Blue–red', colors: ['blue', 'red'], corner: [-1, -1, -1], edge: [-1, 0, -1], yTurns: 2, key: '4' },
];

const CROSS_EDGES: Vec3[] = [
  [0, -1, 1],
  [1, -1, 0],
  [0, -1, -1],
  [-1, -1, 0],
];

const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Sticker locations belonging to the piece at a cubie position. */
export function pieceStickers(pos: Vec3): number[] {
  return STICKERS.flatMap((s, i) => (same(s.pos, pos) ? [i] : []));
}

const homeAt = (s: State, locs: number[]) => locs.every((l) => s[l] === l);

const CROSS_LOCS = CROSS_EDGES.flatMap(pieceStickers);
const SLOT_LOCS = new Map(SLOTS.map((sl) => [sl.id, [...pieceStickers(sl.corner), ...pieceStickers(sl.edge)]]));

export function isCrossSolved(s: State): boolean {
  return homeAt(s, CROSS_LOCS);
}

export function isSlotSolved(s: State, id: SlotId): boolean {
  return homeAt(s, SLOT_LOCS.get(id)!);
}

export function solvedSlots(s: State): SlotId[] {
  return SLOTS.filter((sl) => isSlotSolved(s, sl.id)).map((sl) => sl.id);
}

/** True when the home sticker belongs to a last-layer piece (greyed on the case sheets). */
export function isLastLayerSticker(home: number): boolean {
  return STICKERS[home].pos[1] === 1;
}

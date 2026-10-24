// F2L pair solver: IDA* over the cross edges and the slot pieces, plus an "intuitive" search
// built only from basic inserts. Solutions are ranked by a human cost model.

import {
  FACE_NORMAL, STICKERS, faceByNormal, formatMove, moveTable, parseAlg, relabelForY, rotate, simplify, stickerAt,
  type Face, type Move, type State, type Vec3,
} from './model';
import { SLOTS, type SlotId } from './slots';

// ---- Human cost (all weights in one place so they can be tuned) ----

export const COST = {
  U: 1, U2: 1.2,
  R: 1, R2: 1.3,
  L: 1.15, L2: 1.5,
  F: 2.0, F2: 2.6,
  B: 2.6, B2: 3.2,
  D: 2, D2: 2.6,
  y: 1.6, y2: 2.8,
  handSwitch: 0.3,
};

export function moveCost(moves: readonly Move[]): number {
  let total = 0;
  let hand: 'R' | 'L' | null = null;
  for (const m of moves) {
    total += m.amount === 2 ? COST[`${m.face}2` as keyof typeof COST] : COST[m.face];
    if (m.face === 'R' || m.face === 'L') {
      if (hand && hand !== m.face) total += COST.handSwitch;
      hand = m.face;
    }
  }
  return total;
}

const rotationCost = (k: number) => (k === 0 ? 0 : k === 2 ? COST.y2 : COST.y);
export const rotationToken = (k: number) => ['', 'y', 'y2', "y'"][k];

/** Logical moves as seen after a y^k rotation of the view. */
export function seenMoves(moves: readonly Move[], k: number): Move[] {
  return moves.map((m) => ({ face: faceByNormal(rotate(FACE_NORMAL[m.face], FACE_NORMAL.U, -k)), amount: m.amount }));
}

export interface Route {
  key: string;
  label: string;
  /** y quarter-turns done before the moves (1 = y, 3 = y'). */
  rotation: number;
  /** Moves as you see them after the rotation. */
  seen: Move[];
  /** The same moves in the fixed logical frame (what the cube model applies). */
  moves: Move[];
  cost: number;
}

/** Pick the cheapest way to view a solution: as is, or after y, y2 or y'. */
export function bestView(moves: readonly Move[]): { rotation: number; seen: Move[]; cost: number } {
  let best = { rotation: 0, seen: moves.slice(), cost: Infinity };
  for (let k = 0; k < 4; k++) {
    const seen = seenMoves(moves, k);
    const cost = moveCost(seen) + rotationCost(k);
    if (cost < best.cost - 1e-9) best = { rotation: k, seen, cost };
  }
  return best;
}

export function routeText(r: Pick<Route, 'rotation' | 'seen'>): string {
  return [rotationToken(r.rotation), ...r.seen.map(formatMove)].filter(Boolean).join(' ');
}

/** Parse "y' R U R'" relative to the standard view into a route. */
export function parseRoute(text: string): Pick<Route, 'rotation' | 'seen' | 'moves'> {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let rotation = 0;
  if (tokens[0]?.startsWith('y')) rotation = { y: 1, y2: 2, "y'": 3 }[tokens.shift()!] ?? 0;
  const seen = parseAlg(tokens.join(' '));
  return { rotation, seen, moves: relabelForY(seen, rotation) };
}

// ---- Piece tracking ----

const CORNER_LOCS = STICKERS.flatMap((s, i) => (s.pos.every((c) => c !== 0) ? [i] : []));
const EDGE_LOCS = STICKERS.flatMap((s, i) => (s.pos.filter((c) => c !== 0).length === 2 ? [i] : []));
const CORNER_IDX = new Int8Array(54).fill(-1);
const EDGE_IDX = new Int8Array(54).fill(-1);
CORNER_LOCS.forEach((loc, i) => (CORNER_IDX[loc] = i));
EDGE_LOCS.forEach((loc, i) => (EDGE_IDX[loc] = i));

const D: Vec3 = [0, -1, 0];
const CROSS_REFS = ([[0, -1, 1], [1, -1, 0], [0, -1, -1], [-1, -1, 0]] as Vec3[]).map((p) => stickerAt(p, D));
const SLOT_REFS = Object.fromEntries(
  SLOTS.map((s) => [s.id, { corner: stickerAt(s.corner, D), edge: stickerAt(s.edge, [0, 0, s.edge[2]]) }]),
) as Record<SlotId, { corner: number; edge: number }>;

const SEARCH_FACES: Face[] = ['U', 'R', 'F', 'L', 'B'];
interface SearchMove { move: Move; table: Uint8Array; face: Face }
const ALL_MOVES: SearchMove[] = SEARCH_FACES.flatMap((face) =>
  ([1, 2, 3] as const).map((amount) => ({ move: { face, amount }, table: moveTable({ face, amount }), face })),
);

// ---- Pruning tables (built lazily, once) ----

let slotTables: Record<SlotId, Uint8Array> | null = null;
let crossTable: Uint8Array | null = null;
/** Per slot: (corner, edge, the two cross edges next to the slot) — a much stronger bound. */
let pairCrossTables: Record<SlotId, Uint8Array> | null = null;

const enc4 = (a: number, b: number, c: number, d: number) => ((a * 24 + b) * 24 + c) * 24 + d;
const SLOT_CROSS = Object.fromEntries(
  SLOTS.map((s) => [s.id, [stickerAt([s.corner[0], -1, 0], D), stickerAt([0, -1, s.corner[2]], D)]]),
) as Record<SlotId, [number, number]>;

function bfs(size: number, start: number, next: (idx: number, m: SearchMove) => number): Uint8Array {
  const dist = new Uint8Array(size).fill(255);
  const queue = new Int32Array(size);
  dist[start] = 0;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const idx = queue[head++];
    for (const m of ALL_MOVES) {
      const n = next(idx, m);
      if (dist[n] === 255) {
        dist[n] = dist[idx] + 1;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

function tables() {
  if (!slotTables) {
    slotTables = Object.fromEntries(
      SLOTS.map((s) => {
        const { corner, edge } = SLOT_REFS[s.id];
        const start = CORNER_IDX[corner] * 24 + EDGE_IDX[edge];
        return [s.id, bfs(576, start, (idx, m) => {
          const c = m.table[CORNER_LOCS[Math.floor(idx / 24)]];
          const e = m.table[EDGE_LOCS[idx % 24]];
          return CORNER_IDX[c] * 24 + EDGE_IDX[e];
        })];
      }),
    ) as Record<SlotId, Uint8Array>;
  }
  if (!crossTable) {
    const enc = (a: number, b: number, c: number, d: number) => ((a * 24 + b) * 24 + c) * 24 + d;
    const start = enc(...(CROSS_REFS.map((r) => EDGE_IDX[r]) as [number, number, number, number]));
    crossTable = bfs(331776, start, (idx, m) => {
      const e3 = idx % 24, e2 = Math.floor(idx / 24) % 24, e1 = Math.floor(idx / 576) % 24, e0 = Math.floor(idx / 13824);
      const f = (e: number) => EDGE_IDX[m.table[EDGE_LOCS[e]]];
      return enc(f(e0), f(e1), f(e2), f(e3));
    });
  }
  if (!pairCrossTables) {
    pairCrossTables = Object.fromEntries(
      SLOTS.map((s) => {
        const { corner, edge } = SLOT_REFS[s.id];
        const [x1, x2] = SLOT_CROSS[s.id];
        const start = enc4(CORNER_IDX[corner], EDGE_IDX[edge], EDGE_IDX[x1], EDGE_IDX[x2]);
        return [s.id, bfs(331776, start, (idx, m) => {
          const d = idx % 24, c = Math.floor(idx / 24) % 24, b = Math.floor(idx / 576) % 24, a = Math.floor(idx / 13824);
          const e = (i: number) => EDGE_IDX[m.table[EDGE_LOCS[i]]];
          return enc4(CORNER_IDX[m.table[CORNER_LOCS[a]]], e(b), e(c), e(d));
        })];
      }),
    ) as Record<SlotId, Uint8Array>;
  }
  return { slotTables, crossTable, pairCrossTables };
}

/** Tracked sticker locations: 4 cross edges, then (corner, edge) per slot in play. */
function tracker(state: State, slotsInPlay: readonly SlotId[]) {
  const { crossTable: ct, pairCrossTables: pt } = tables();
  const refs = [...CROSS_REFS, ...slotsInPlay.flatMap((id) => [SLOT_REFS[id].corner, SLOT_REFS[id].edge])];
  const start = Uint8Array.from(refs.map((r) => state.indexOf(r)));
  // Cross edge positions in the tracked array for each slot's two neighbouring cross edges.
  const crossPos = slotsInPlay.map((id) => SLOT_CROSS[id].map((r) => CROSS_REFS.indexOf(r)));
  const tabs = slotsInPlay.map((id) => pt[id]);
  const h = (p: Uint8Array) => {
    let v = ct[enc4(EDGE_IDX[p[0]], EDGE_IDX[p[1]], EDGE_IDX[p[2]], EDGE_IDX[p[3]])];
    for (let i = 0; i < tabs.length; i++) {
      const [a, b] = crossPos[i];
      const d = tabs[i][enc4(CORNER_IDX[p[4 + 2 * i]], EDGE_IDX[p[5 + 2 * i]], EDGE_IDX[p[a]], EDGE_IDX[p[b]])];
      if (d > v) v = d;
    }
    return v;
  };
  return { start, h, n: refs.length };
}

export function warmUp() {
  tables();
}

// ---- IDA* ----

export interface SolveOptions {
  target: SlotId;
  /** Slots that must stay solved (the cross always must). */
  keep: readonly SlotId[];
  faces?: readonly Face[];
  /** Also collect solutions up to optimal + extra moves. */
  extra?: number;
  maxDepth?: number;
  maxSolutions?: number;
  timeMs?: number;
}

export interface SolveResult {
  solutions: Move[][];
  optimal: number;
  timedOut: boolean;
}

export function solveSlot(state: State, opts: SolveOptions): SolveResult {
  const slotsInPlay = [opts.target, ...opts.keep.filter((k) => k !== opts.target)];
  const { start, h, n } = tracker(state, slotsInPlay);
  const moves = ALL_MOVES.filter((m) => !opts.faces || opts.faces.includes(m.face));

  const extra = opts.extra ?? 0;
  const maxDepth = opts.maxDepth ?? 14;
  const maxSolutions = opts.maxSolutions ?? 300;
  const deadline = performance.now() + (opts.timeMs ?? 400);
  const solutions: Move[][] = [];
  const path: Move[] = [];
  const buf = Array.from({ length: maxDepth + 1 }, () => new Uint8Array(n));
  let timedOut = false;
  let nodes = 0;
  let optimal = -1;

  const OPPOSITE: Partial<Record<Face, Face>> = { L: 'R', B: 'F' };
  const dfs = (p: Uint8Array, depth: number, limit: number, last: Face | null): void => {
    const hv = h(p);
    if (hv === 0) {
      if (depth === limit) solutions.push(path.slice());
      return; // never extend through a solved position
    }
    if (depth + hv > limit || solutions.length >= maxSolutions) return;
    if ((++nodes & 1023) === 0 && performance.now() > deadline) timedOut = true;
    if (timedOut) return;
    const next = buf[depth + 1];
    for (const m of moves) {
      if (m.face === last || OPPOSITE[m.face] === last) continue; // canonical order: R before L, F before B
      for (let i = 0; i < n; i++) next[i] = m.table[p[i]];
      path.push(m.move);
      dfs(next, depth + 1, limit, m.face);
      path.pop();
    }
  };

  const h0 = h(start);
  for (let limit = h0; limit <= maxDepth && !timedOut; limit++) {
    buf[0].set(start);
    dfs(buf[0], 0, limit, null);
    if (solutions.length && optimal < 0) optimal = limit;
    if (optimal >= 0 && limit >= optimal + extra) break;
    if (solutions.length >= maxSolutions) break;
  }
  return { solutions, optimal, timedOut };
}

// ---- Intuitive search: set-up U turns + basic inserts only ----

const TRIGGERS = ["R U R'", "R U' R'", "R U2 R'", "F' U F", "F' U' F", "F' U2 F"].map(parseAlg);

export function intuitiveSolutions(state: State, target: SlotId, keep: readonly SlotId[], maxTriggers = 4): Move[][] {
  const slot = SLOTS.find((s) => s.id === target)!;
  const slotsInPlay = [target, ...keep.filter((k) => k !== target)];
  const { start, h } = tracker(state, slotsInPlay);
  const macros: Move[][] = [];
  for (const t of TRIGGERS) {
    for (let u = 0; u < 4; u++) {
      const setup: Move[] = u ? [{ face: 'U', amount: u as 1 | 2 | 3 }] : [];
      macros.push([...setup, ...relabelForY(t, slot.yTurns)]);
    }
  }
  const macroTables = macros.map((ms) => {
    const t = Uint8Array.from({ length: 54 }, (_, i) => i);
    for (const m of ms) {
      const mt = moveTable(m);
      for (let i = 0; i < 54; i++) t[i] = mt[t[i]];
    }
    return t;
  });
  const found: Move[][] = [];
  const path: number[] = [];
  const dfs = (p: Uint8Array, depth: number) => {
    if (h(p) === 0) {
      found.push(simplify(path.flatMap((i) => macros[i])));
      return;
    }
    if (depth === maxTriggers || h(p) > (maxTriggers - depth) * 5) return;
    for (let i = 0; i < macros.length; i++) {
      const next = p.map((loc) => macroTables[i][loc]);
      path.push(i);
      dfs(next, depth + 1);
      path.pop();
    }
  };
  // Shallowest first: stop at the first number of triggers that solves it.
  for (let d = 1; d <= maxTriggers; d++) {
    dfs(start, maxTriggers - d);
    if (found.length) break;
  }
  return found;
}

// ---- Routes for the coach ----

export function findRoutes(state: State, target: SlotId, keep: readonly SlotId[]): Route[] {
  const routes: Route[] = [];
  const make = (key: string, label: string, moves: Move[]): Route => ({ key, label, moves, ...bestView(moves) });
  const cheapest = (sols: Move[][]) =>
    sols.map((m) => ({ m, c: bestView(m).cost })).sort((a, b) => a.c - b.c || a.m.length - b.m.length)[0]?.m;

  const main = solveSlot(state, { target, keep, extra: 2, timeMs: 700 });
  if (main.solutions.length) {
    const comfort = cheapest(main.solutions)!;
    routes.push(make('comfort', 'Most comfortable', comfort));
    const shortest = cheapest(main.solutions.filter((s) => s.length === main.optimal))!;
    routes.push(make('fewest', 'Fewest moves', shortest));
  }

  const intuitive = cheapest(intuitiveSolutions(state, target, keep));
  if (intuitive) routes.push(make('intuitive', 'Intuitive: pair up, then insert', intuitive));

  const twoGen = [['U', 'R'], ['U', 'F'], ['U', 'L'], ['U', 'B']].flatMap(
    (faces) => solveSlot(state, { target, keep, faces: faces as Face[], extra: 1, maxDepth: 15, timeMs: 250 }).solutions,
  );
  const ru = cheapest(twoGen);
  if (ru) routes.push(make('two-gen', 'Two-gen (R U only)', ru));

  return routes;
}

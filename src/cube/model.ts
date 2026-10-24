// 54-sticker cube model in a fixed logical frame:
// white = D, yellow = U, green = F, blue = B, orange = R, red = L.
// Axes: +x = R, +y = U, +z = F. Sticker order follows Kociemba facelets (U R F D L B, 9 each).

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
export type Face = (typeof FACES)[number];
export type Vec3 = readonly [number, number, number];

export const FACE_NORMAL: Record<Face, Vec3> = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

export interface Sticker {
  face: Face;
  pos: Vec3;
  normal: Vec3;
}

function stickerPos(face: Face, r: number, c: number): Vec3 {
  switch (face) {
    case 'U': return [-1 + c, 1, -1 + r];
    case 'R': return [1, 1 - r, 1 - c];
    case 'F': return [-1 + c, 1 - r, 1];
    case 'D': return [-1 + c, -1, 1 - r];
    case 'L': return [-1, 1 - r, -1 + c];
    case 'B': return [1 - c, 1 - r, -1];
  }
}

export const STICKERS: readonly Sticker[] = FACES.flatMap((face) =>
  Array.from({ length: 9 }, (_, i) => ({
    face,
    pos: stickerPos(face, Math.floor(i / 3), i % 3),
    normal: FACE_NORMAL[face],
  })),
);

const key = (pos: Vec3, normal: Vec3) => `${pos.join(',')}|${normal.join(',')}`;
const STICKER_INDEX = new Map(STICKERS.map((s, i) => [key(s.pos, s.normal), i]));

export function stickerAt(pos: Vec3, normal: Vec3): number {
  const i = STICKER_INDEX.get(key(pos, normal));
  if (i === undefined) throw new Error(`no sticker at ${key(pos, normal)}`);
  return i;
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Rotate v about a unit axis by quarters × 90° (right-hand rule), exactly. */
export function rotate(v: Vec3, axis: Vec3, quarters: number): Vec3 {
  const k = ((quarters % 4) + 4) % 4;
  const cos = [1, 0, -1, 0][k];
  const sin = [0, 1, 0, -1][k];
  const c = cross(axis, v);
  const d = dot(axis, v) * (1 - cos);
  return [
    v[0] * cos + c[0] * sin + axis[0] * d,
    v[1] * cos + c[1] * sin + axis[1] * d,
    v[2] * cos + c[2] * sin + axis[2] * d,
  ];
}

export function faceByNormal(n: Vec3): Face {
  const f = FACES.find((face) => dot(FACE_NORMAL[face], n) === 1);
  if (!f) throw new Error(`not a face normal: ${n}`);
  return f;
}

// ---- Moves ----

/** amount: 1 = clockwise (seen from outside that face), 2 = half turn, 3 = anticlockwise. */
export interface Move {
  face: Face;
  amount: 1 | 2 | 3;
}

export type State = Uint8Array;

/** PERM[face][amount][loc] = where the sticker at loc ends up. */
const PERM: Record<Face, Uint8Array[]> = Object.fromEntries(
  FACES.map((face) => {
    const n = FACE_NORMAL[face];
    const tables = [1, 2, 3].map((amount) => {
      const t = new Uint8Array(54);
      STICKERS.forEach((s, i) => {
        if (dot(s.pos, n) !== 1) {
          t[i] = i;
          return;
        }
        // Clockwise seen from outside = -90° about the outward normal.
        t[i] = stickerAt(rotate(s.pos, n, -amount), rotate(s.normal, n, -amount));
      });
      return t;
    });
    return [face, [new Uint8Array(0), ...tables]];
  }),
) as Record<Face, Uint8Array[]>;

/** Where each sticker location goes under a face turn. */
export function moveTable(m: Move): Uint8Array {
  return PERM[m.face][m.amount];
}

export function solved(): State {
  return Uint8Array.from({ length: 54 }, (_, i) => i);
}

export function isSolved(s: State): boolean {
  return s.every((v, i) => v === i);
}

export function applyMove(s: State, m: Move): State {
  const t = PERM[m.face][m.amount];
  const next = new Uint8Array(54);
  for (let i = 0; i < 54; i++) next[t[i]] = s[i];
  return next;
}

export function applyAlg(s: State, moves: readonly Move[]): State {
  return moves.reduce(applyMove, s);
}

/** Colour (face letter of the home sticker) at each location. */
export function colorAt(s: State, loc: number): Face {
  return STICKERS[s[loc]].face;
}

// ---- Notation ----

const SUFFIX = { 1: '', 2: '2', 3: "'" } as const;

export function formatMove(m: Move): string {
  return m.face + SUFFIX[m.amount];
}

export function formatAlg(moves: readonly Move[]): string {
  return moves.map(formatMove).join(' ');
}

/** Parses face turns only (U R F D L B with ', 2, 2'). */
export function parseAlg(text: string): Move[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.map((tok) => {
    const m = /^([URFDLB])(2'?|'|’)?$/.exec(tok);
    if (!m) throw new Error(`Can't read move "${tok}"`);
    const amount = !m[2] ? 1 : m[2].startsWith('2') ? 2 : 3;
    return { face: m[1] as Face, amount };
  });
}

export function invertMove(m: Move): Move {
  return { face: m.face, amount: (4 - m.amount) as 1 | 2 | 3 };
}

export function invertAlg(moves: readonly Move[]): Move[] {
  return moves.slice().reverse().map(invertMove);
}

/** Merge consecutive turns of the same face and drop cancellations. */
export function simplify(moves: readonly Move[]): Move[] {
  const out: Move[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && last.face === m.face) {
      const amount = (last.amount + m.amount) % 4;
      out.pop();
      if (amount) out.push({ face: m.face, amount: amount as 1 | 2 | 3 });
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/**
 * Relabel an algorithm written for a view rotated by y^k into logical faces.
 * After y (k = 1) the logical R face is seen at the front.
 */
export function relabelForY(moves: readonly Move[], k: number): Move[] {
  return moves.map((m) => ({
    face: faceByNormal(rotate(FACE_NORMAL[m.face], FACE_NORMAL.U, k)),
    amount: m.amount,
  }));
}

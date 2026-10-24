import { FACE_NORMAL, type Face, type Vec3 } from '../cube/model';
import type { Turn } from '../render/cubeView';

/** csTimer-style virtual cube keys (key → move as seen on screen). */
export const DEFAULT_KEYMAP: Record<string, string> = {
  i: 'R', k: "R'",
  j: 'U', f: "U'",
  d: 'L', e: "L'",
  h: 'F', g: "F'",
  s: 'D', l: "D'",
  w: 'B', o: "B'",
  ';': 'y', a: "y'",
  t: 'x', y: 'x', b: "x'", n: "x'",
  p: 'z', q: "z'",
  u: 'r', m: "r'",
};

/** Screen direction of each face letter in the current view. */
const SEEN_DIR: Record<string, Vec3> = {
  R: [1, 0, 0], L: [-1, 0, 0],
  U: [0, 1, 0], D: [0, -1, 0],
  F: [0, 0, 1], B: [0, 0, -1],
};
const ROTATION_FACE: Record<string, string> = { x: 'R', y: 'U', z: 'F' };

/**
 * Turn a move written relative to the current view (R, U', y, r2…) into logical face turns.
 * `seen(dir)` returns the logical face currently in that screen direction.
 */
export function viewMove(token: string, seen: (dir: Vec3) => Face): Turn | null {
  const m = /^([URFDLBxyzurfdlb])(2|')?$/.exec(token);
  if (!m) return null;
  const amount = (m[2] === '2' ? 2 : m[2] === "'" ? 3 : 1) as 1 | 2 | 3;
  const quarters = amount === 3 ? 1 : -amount; // clockwise = negative about the face normal
  const letter = m[1];

  if (letter in ROTATION_FACE) {
    return { moves: [], view: { axis: FACE_NORMAL[seen(SEEN_DIR[ROTATION_FACE[letter]])], quarters } };
  }
  if (letter === letter.toUpperCase()) {
    return { moves: [{ face: seen(SEEN_DIR[letter]), amount }] };
  }
  // Wide move: turn the opposite face the same way, then rotate the view (r = L + x).
  const outer = letter.toUpperCase();
  const dir = SEEN_DIR[outer];
  const opposite: Vec3 = [-dir[0], -dir[1], -dir[2]];
  return {
    moves: [{ face: seen(opposite), amount }],
    view: { axis: FACE_NORMAL[seen(dir)], quarters },
  };
}

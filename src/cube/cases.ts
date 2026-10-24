// The 41 F2L cases from f2l-cases.html (front-right slot, white cross on D, green front).
// Key: cornerPos:whiteFacing/edgePos:greenFacing, or slot:<white>/top:<Gup|Gside> for corner-in-slot.

export type CaseGroup = 'up' | 'right' | 'front' | 'edge-slot' | 'corner-slot' | 'both-slot';

export interface F2LCase {
  id: number;
  group: CaseGroup;
  key: string;
  alg: string;
}

export const CASES: readonly F2LCase[] = [
  { id: 1, group: 'up', key: 'UFR:U/UF:F', alg: "F' U2 F U F' U' F" },
  { id: 2, group: 'up', key: 'UFR:U/UR:U', alg: "R U2 R' U' R U R'" },
  { id: 3, group: 'up', key: 'UFR:U/UF:U', alg: "U2 R2 U2 R' U' R U' R2" },
  { id: 4, group: 'up', key: 'UFR:U/UR:R', alg: "U2 F2 U2 F U F' U F2" },
  { id: 5, group: 'up', key: 'UFR:U/UB:U', alg: "U R U2 R' U R U' R'" },
  { id: 6, group: 'up', key: 'UFR:U/UB:B', alg: "U2 F' U' F U' F' U F" },
  { id: 7, group: 'up', key: 'UFR:U/UL:U', alg: "U2 R U R' U R U' R'" },
  { id: 8, group: 'up', key: 'UFR:U/UL:L', alg: "U' F' U2 F U' F' U F" },
  { id: 9, group: 'right', key: 'UFR:R/UB:U', alg: "R U R'" },
  { id: 10, group: 'right', key: 'UFR:R/UF:F', alg: "U' F' U F" },
  { id: 11, group: 'right', key: 'UFR:R/UF:U', alg: "R' U2 R2 U R2 U R" },
  { id: 12, group: 'right', key: 'UFR:R/UR:R', alg: "R U' R' U2 F' U' F" },
  { id: 13, group: 'right', key: 'UFR:R/UR:U', alg: "U' R U' R' U R U R'" },
  { id: 14, group: 'right', key: 'UFR:R/UB:B', alg: "U F' U2 F U2 F' U F" },
  { id: 15, group: 'right', key: 'UFR:R/UL:U', alg: "U' R U R' U R U R'" },
  { id: 16, group: 'right', key: 'UFR:R/UL:L', alg: "U F' U' F U2 F' U F" },
  { id: 17, group: 'front', key: 'UFR:F/UL:L', alg: "F' U' F" },
  { id: 18, group: 'front', key: 'UFR:F/UR:U', alg: "U R U' R'" },
  { id: 19, group: 'front', key: 'UFR:F/UF:U', alg: "F' U F U2 R U R'" },
  { id: 20, group: 'front', key: 'UFR:F/UR:R', alg: "F U2 F2 U' F2 U' F'" },
  { id: 21, group: 'front', key: 'UFR:F/UF:F', alg: "U F' U F U' F' U' F" },
  { id: 22, group: 'front', key: 'UFR:F/UB:U', alg: "U' R U R' U2 R U' R'" },
  { id: 23, group: 'front', key: 'UFR:F/UB:B', alg: "U F' U' F U' F' U' F" },
  { id: 24, group: 'front', key: 'UFR:F/UL:U', alg: "U' R U2 R' U2 R U' R'" },
  { id: 25, group: 'edge-slot', key: 'UFR:U/FR:R', alg: "F' U F R U2 R'" },
  { id: 26, group: 'edge-slot', key: 'UFR:U/FR:F', alg: "R2 U R2 U R2 U2 R2" },
  { id: 27, group: 'edge-slot', key: 'UFR:F/FR:F', alg: "U' R U' R' U2 R U' R'" },
  { id: 28, group: 'edge-slot', key: 'UFR:F/FR:R', alg: "U' R U R' U F' U' F" },
  { id: 29, group: 'edge-slot', key: 'UFR:R/FR:F', alg: "U R U R' U2 R U R'" },
  { id: 30, group: 'edge-slot', key: 'UFR:R/FR:R', alg: "U2 F' U F U R U R'" },
  { id: 31, group: 'corner-slot', key: 'slot:R/top:Gside', alg: "F' U F U' F' U F" },
  { id: 32, group: 'corner-slot', key: 'slot:F/top:Gside', alg: "F' U' F U F' U' F" },
  { id: 33, group: 'corner-slot', key: 'slot:R/top:Gup', alg: "R U R' U' R U R'" },
  { id: 34, group: 'corner-slot', key: 'slot:F/top:Gup', alg: "R U' R' U R U' R'" },
  { id: 35, group: 'corner-slot', key: 'slot:D/top:Gside', alg: "U R U' R' U' F' U F" },
  { id: 36, group: 'corner-slot', key: 'slot:D/top:Gup', alg: "U' F' U F U R U' R'" },
  { id: 37, group: 'both-slot', key: 'DFR:D/FR:R', alg: "R2 U2 F R2 F' U2 R' U R'" },
  { id: 38, group: 'both-slot', key: 'DFR:R/FR:R', alg: "R U' R' U2 R U R' F' U' F" },
  { id: 39, group: 'both-slot', key: 'DFR:F/FR:R', alg: "F' U F U2 F' U' F R U R'" },
  { id: 40, group: 'both-slot', key: 'DFR:R/FR:F', alg: "R U R' U2 R U' R' U R U R'" },
  { id: 41, group: 'both-slot', key: 'DFR:F/FR:F', alg: "R U R' U' R U2 R' U' R U R'" },
];

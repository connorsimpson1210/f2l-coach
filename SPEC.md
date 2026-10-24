# F2L Coach — build spec

A local web app that teaches **advanced F2L** (CFOP first two layers) the way a coach would: it hands me a scramble with the white cross already solved, quizzes my inspection, watches me solve each pair (on a GoCube, or with mouse/keyboard on a 3D cube), then shows the best pair choice and solution for *that exact scramble* and explains **why**, in plain language.

Goal: get me from ~30s to **sub-20**. Train good habits (pair choice, piece tracking, lookahead, few rotations, using empty slots), not just show computer-optimal move strings.

Reference files in this folder (open them in a browser):
- `f2l-cases.html` — my sheet of all 41 F2L cases (front-right slot). The app should refer to cases by **these numbers** (table at the bottom of this spec).
- `ll-cases.html` — my 2-look last-layer sheet (not needed for this app, context only).

---

## Tech

- **Vite + TypeScript**, no backend. `npm run dev` serves on localhost; open in **Chrome** (Web Bluetooth needs Chrome/Edge, and localhost counts as a secure context).
- **three.js** for the 3D cube (custom renderer, because I need drag-to-turn; cubing.js's twisty-player doesn't do interactive turning well).
- **cubing.js** (`cubing/bluetooth` → `connectSmartPuzzle()`) for the GoCube. Fallback: talk to the GoCube directly (protocol notes below).
- **cubejs** (MIT, Kociemba two-phase) to turn a random cross-solved state into a short (~20 move) scramble. Run `Cube.initSolver()` in a Web Worker at startup (takes a few seconds).
- The F2L pair solver is custom (spec below); run it in a Web Worker.
- **Vitest** for unit tests of the cube model, solver, case recognition and explanations.
- Progress/stats in `localStorage`.
- Init git, commit per milestone.

## Conventions

- Logical frame is fixed: **white = D (bottom), yellow = U, green = F, blue = B, orange = R, red = L.**
- Whole-cube rotations (x, y, z) and wide/slice moves never change the logical state's frame. Treat rotations as a change of *view*, and convert wide/slice moves to face turns + a view rotation (e.g. `r` = `L` + view `x`; `M` = `R L'` + view `x'`; `d` = `D` + view `y`). The cross is always on logical D.
- Keyboard and mouse turns are relative to **what I currently see**: snap the current view orientation to the nearest of the 24 orientations and map "R key" to whichever logical face is currently on my right.

---

## Features (MVP)

### 1. 3D cube
- Drag the **background** to orbit freely (trackball style). `Esc` = animate back to the standard view (white bottom, green front, slight top-right angle).
- Drag a **sticker** to turn that layer in the drag direction (raycast the sticker, use its face normal plus the drag vector to pick the axis and layer).
- Smooth turn animation (~120ms, configurable), with a move queue so fast input never drops or desyncs.
- Toggle: grey out the last-layer stickers (like my case sheets) so only F2L pieces are coloured.
- Undo (`Backspace`).

### 2. Keyboard turns (csTimer-style virtual cube keys; verify against csTimer and make them remappable in settings)
| Key | Move | Key | Move |
|---|---|---|---|
| I / K | R / R' | J / F | U / U' |
| D / E | L / L' | H / G | F / F' |
| S / L | D / D' | W / O | B / B' |
| ; / A | y / y' | T, Y / B, N | x / x' |
| P / Q | z / z' | U / M | r / r' |

Action shortcuts (must not clash with turn keys): `Space` new scramble, `Enter` check pair / continue, `→` / `←` step the best-solution replay, `Backspace` undo, `Esc` reset view, `1`–`4` choose slot in the quiz, `?` shortcut help overlay.

### 3. GoCube (Bluetooth)
- "Connect GoCube" button → `connectSmartPuzzle()`; show connected/disconnected and battery if available. Every move from the cube is applied to the on-screen cube through the same move queue.
- **Calibration step** on first connect: "hold white on the bottom, green facing you, turn the white face clockwise" → confirm the reported face maps to logical D (fix the colour→face mapping if not).
- "Sync: my cube is solved" button resets both to solved.
- Toggle "View follows my cube" using the orientation stream (experimental; include a "set this as home" button).
- Scramble tracking: highlight the next scramble move as I turn. If I make a wrong turn, show the inverse to undo it. When the state equals the target, start the pair phase.
- Protocol notes (from cubing.js source, for the fallback or debugging): service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`, notify characteristic `6e400003-b5a3-f393-e0a9-e50e24dcca9e`, device name prefixes `GoCube` / `Rubik`. Short notifications (<16 bytes) are turns: bytes from index 3, step 2, while `i < length - 4`; each byte 0–11 = `B B' F F' U U' D D' R R' L L'` **in a white-on-top, green-front frame**, so convert to my frame (their U = my D, their R = my L, and so on, keeping the clockwise/anticlockwise suffix). Long notifications are orientation: ASCII `x#y#z#w` between byte 3 and length−3, each value ÷ 16384.

### 4. Scrambles with the cross solved
- Build a **uniformly random** state with the 4 white cross edges solved: the other 8 edges get a random permutation and orientation (orientation sum even), all 8 corners random (twist sum divisible by 3), and corner-permutation parity = edge-permutation parity. In cubejs order the cross edges are DR, DF, DL, DB = indices 4–7.
- Solve that state with cubejs and invert the solution to get a ~20-move scramble I can do by hand. Show the scramble in large text. "Apply instantly" button for the virtual cube.
- "Use my own scramble" text box (validate the cross is solved after applying it; if not, say so).
- Weighted mode (later): bias towards cases I'm weak at.

### 5. Inspection quiz (per pair, before any answer is shown)
1. "Which pair would you solve first?" Four slot buttons labelled by colour (FR green-orange, FL green-red, BR blue-orange, BL blue-red, plus keys 1–4). Already-solved slots are disabled.
2. "Click the corner, then the edge, for that pair." Clicking any sticker of the right piece counts as correct.
3. Reveal: a table of all unsolved pairs with best "human cost" and move count, and which slot is cheapest, then a ✓/✗ on my choice. If a cheaper pair existed, say why (e.g. "blue-orange was already joined: 3 moves vs 9").

### 6. My attempt and comparison
- I solve the chosen pair, or any pair, on the GoCube or virtual cube. Detect "a new slot became solved with cross and earlier slots intact". Record my move sequence and time (and pauses, when using the GoCube).
- If I break the cross or a solved slot, warn straight away and offer undo.
- Show me vs best: moves, rotations, my time; mark where my solution diverged.
- **Replay** the best solution step by step (`→`/`←`), from the position before the pair, with an explanation per chunk (see 8). Then "continue from my result" (default) or "continue from the best result".
- After all 4 pairs: a summary (total moves vs best possible, pair order chosen vs best order, time per pair, biggest loss).

### 7. Settings
- **Style toggle:** *Normal* (default: R/U-based, `y` rotations allowed, L moves for left slots fine, F/B moves discouraged) vs *Rotationless* (rotations heavily penalised, `F` moves allowed).
- Animation speed, key remapping, LL greying, explanation detail (short/full), reset stats.

### 8. Explanations ("why")
For each pair, explain the best solution in human terms:
- **Case recognition first:** if both pieces are free (in the U layer or their own slot), conjugate to front-right, AUF the corner to UFR and name the case: "This is case #23 on your sheet." If a piece is stuck in another slot, say so ("the edge is stuck in the blue-red slot; first take it out").
- **Chunking:** after every move of the solution, classify the pair relationship: `separated`, `joined-correctly` (corner and edge adjacent in the U layer, matching side colours forming a 1×2 block), `joined-wrong` (adjacent but mismatched), `corner-in-slot`, `edge-in-slot`, `solved`. Split the solution wherever the relationship changes, and label each chunk:
  - rotation → "y': turn the cube so this slot is at front-right"
  - U-only chunk → "set-up: move the edge away from / next to the corner" (say which)
  - separated → joined → "these moves join the corner and edge into a pair"
  - joined-wrong → separated → "split the pair; it was joined the wrong way round"
  - piece leaves a slot → "take the corner out of the slot so it can pair up"
  - → solved → "insert the pair" (+ "this is the basic `R U R'` insert" when it is)
- **Technique tags:** *empty-slot trick* (turns a face of a different unsolved slot), *keyhole*, *no rotation*, *pair was already joined*, *edge flipped* (edge colour orientation forces a longer case), *set up next pair* (the solution also improves another pair's cost).
- Template text first (deterministic, testable). Optional later: an "Ask why" button that sends the position and solution to an LLM.

### 9. Stats (localStorage)
Per case number (1–41) and for "stuck" situations: times seen, my average moves vs best, % of best-pair picks, % of correct piece clicks, average time per pair. A small stats page listing my worst cases.

---

## Pair solver (the core)

**Representation:** 54-sticker model. State `s[loc] = homeStickerIndex`. Precompute permutation tables for the 18 face turns. Track each piece by the location of one reference sticker: corner = its white sticker (24 corner-sticker locations), edge = a fixed sticker (24 edge-sticker locations), so position + orientation is one number 0–23.

**Pruning tables** (BFS over the allowed move set, `Uint8Array`):
- per slot: pair table over (cornerLoc, edgeLoc) = 576 entries;
- cross table over the 4 cross edges = 24⁴ = 331,776 entries.

**Search:** IDA\* for one target slot. The state is the target pair + 4 cross edges + the already-solved pairs. Heuristic = max(target pair distance, cross distance, each solved pair's distance). Moves: U, R, L, F, B (×3 each, no D). Canonical ordering: never the same face twice in a row, opposite faces in a fixed order. Collect **all** solutions up to optimal+2 moves (cap ~300, time budget ~150ms per slot), then rank them by human cost.

**Rotations:** for each fixed-frame solution, also score its 4 relabelled forms (prefix `y`, `y'`, `y2` or nothing). After `y`, the logical R face is seen at F, so relabel R→F, F→L, L→B, B→R. Keep the cheapest. Rotations carry over to the next pair, because the view stays rotated.

**Human cost** (Normal style; all weights in one config object so I can tune them):
`U`=1, `U2`=1.2, `R`=1, `R2`=1.3, `L`=1.15, `L2`=1.5, `F`=1.7, `F2`=2.3, `B`=2.6, `B2`=3.2, `y`/`y'`=1.6, `y2`=2.8, +0.3 for each switch between a right-hand group (R) and left-hand group (L). Rotationless style: rotations 6, `F` 1.2, `F2` 1.6.

**Pair choice:** recommend the slot with the lowest best cost. Phase 2: also evaluate pair orders two deep (cost of this pair + best next pair from the resulting state) and mention when that changes the recommendation.

**Performance target:** solving all 4 slots after each pair under ~0.5s in the worker. Cases needing more than ~12 moves are rare; if a search times out, return the best found so far and flag it.

**Validation (unit tests):**
- the 41 algorithms in the table below each solve their case, leave the cross intact, and are recognised as the right case number;
- `R U R'` undone from a solved cube gives a position whose best solution is exactly `R U R'` (3 moves);
- the solver never returns a solution that breaks the cross or a solved slot;
- scrambles: 1000 random cross-solved states → the generated scramble reproduces exactly that state;
- explanation chunker on hand-checked examples.

---

## Milestones

1. **Cube + input:** Vite app, 3D cube, orbit, drag-turn, keyboard turns, undo, view-relative mapping. Tests for the model.
2. **Scrambles + solver:** cross-solved scrambles via cubejs worker, pair solver worker, case recognition, tests passing.
3. **Coaching flow:** quiz → attempt detection → comparison → replay with chunked explanations → summary.
4. **GoCube:** connect, calibrate, move streaming, scramble tracking, pause timing, optional view-follow.
5. **Stats + settings + polish:** style toggle, remapping, stats page, shortcut overlay, responsive layout (desktop first).

Ask me before changing any of the conventions above. Show me a working build after each milestone.

---

## The 41 cases (numbering from `f2l-cases.html`)

Front-right slot, white cross on D, green front, orange right. **Key** format: `cornerPos:whiteFacing/edgePos:greenFacing`. For the corner-in-slot group the key is `slot:<white facing>/top:<Gup|Gside>`, because the edge's AUF doesn't matter there. Algorithms were checked in a simulator.

| # | Group | Key | Corner | Edge | Algorithm |
|---|---|---|---|---|---|
| 1 | up | `UFR:U/UF:F` | UFR, white→U | UF, green→F | `F' U2 F U F' U' F` |
| 2 | up | `UFR:U/UR:U` | UFR, white→U | UR, green→U | `R U2 R' U' R U R'` |
| 3 | up | `UFR:U/UF:U` | UFR, white→U | UF, green→U | `U2 R2 U2 R' U' R U' R2` |
| 4 | up | `UFR:U/UR:R` | UFR, white→U | UR, green→R | `U2 F2 U2 F U F' U F2` |
| 5 | up | `UFR:U/UB:U` | UFR, white→U | UB, green→U | `U R U2 R' U R U' R'` |
| 6 | up | `UFR:U/UB:B` | UFR, white→U | UB, green→B | `U2 F' U' F U' F' U F` |
| 7 | up | `UFR:U/UL:U` | UFR, white→U | UL, green→U | `U2 R U R' U R U' R'` |
| 8 | up | `UFR:U/UL:L` | UFR, white→U | UL, green→L | `U' F' U2 F U' F' U F` |
| 9 | right | `UFR:R/UB:U` | UFR, white→R | UB, green→U | `R U R'` |
| 10 | right | `UFR:R/UF:F` | UFR, white→R | UF, green→F | `U' F' U F` |
| 11 | right | `UFR:R/UF:U` | UFR, white→R | UF, green→U | `R' U2 R2 U R2 U R` |
| 12 | right | `UFR:R/UR:R` | UFR, white→R | UR, green→R | `R U' R' U2 F' U' F` |
| 13 | right | `UFR:R/UR:U` | UFR, white→R | UR, green→U | `U' R U' R' U R U R'` |
| 14 | right | `UFR:R/UB:B` | UFR, white→R | UB, green→B | `U F' U2 F U2 F' U F` |
| 15 | right | `UFR:R/UL:U` | UFR, white→R | UL, green→U | `U' R U R' U R U R'` |
| 16 | right | `UFR:R/UL:L` | UFR, white→R | UL, green→L | `U F' U' F U2 F' U F` |
| 17 | front | `UFR:F/UL:L` | UFR, white→F | UL, green→L | `F' U' F` |
| 18 | front | `UFR:F/UR:U` | UFR, white→F | UR, green→U | `U R U' R'` |
| 19 | front | `UFR:F/UF:U` | UFR, white→F | UF, green→U | `F' U F U2 R U R'` |
| 20 | front | `UFR:F/UR:R` | UFR, white→F | UR, green→R | `F U2 F2 U' F2 U' F'` |
| 21 | front | `UFR:F/UF:F` | UFR, white→F | UF, green→F | `U F' U F U' F' U' F` |
| 22 | front | `UFR:F/UB:U` | UFR, white→F | UB, green→U | `U' R U R' U2 R U' R'` |
| 23 | front | `UFR:F/UB:B` | UFR, white→F | UB, green→B | `U F' U' F U' F' U' F` |
| 24 | front | `UFR:F/UL:U` | UFR, white→F | UL, green→U | `U' R U2 R' U2 R U' R'` |
| 25 | edge-slot | `UFR:U/FR:R` | UFR, white→U | FR, green→R | `F' U F R U2 R'` |
| 26 | edge-slot | `UFR:U/FR:F` | UFR, white→U | FR, green→F | `R2 U R2 U R2 U2 R2` |
| 27 | edge-slot | `UFR:F/FR:F` | UFR, white→F | FR, green→F | `U' R U' R' U2 R U' R'` |
| 28 | edge-slot | `UFR:F/FR:R` | UFR, white→F | FR, green→R | `U' R U R' U F' U' F` |
| 29 | edge-slot | `UFR:R/FR:F` | UFR, white→R | FR, green→F | `U R U R' U2 R U R'` |
| 30 | edge-slot | `UFR:R/FR:R` | UFR, white→R | FR, green→R | `U2 F' U F U R U R'` |
| 31 | corner-slot | `slot:R/top:Gside` | DFR, white→R | UF, green→F | `F' U F U' F' U F` |
| 32 | corner-slot | `slot:F/top:Gside` | DFR, white→F | UF, green→F | `F' U' F U F' U' F` |
| 33 | corner-slot | `slot:R/top:Gup` | DFR, white→R | UR, green→U | `R U R' U' R U R'` |
| 34 | corner-slot | `slot:F/top:Gup` | DFR, white→F | UR, green→U | `R U' R' U R U' R'` |
| 35 | corner-slot | `slot:D/top:Gside` | DFR, white→D | UF, green→F | `U R U' R' U' F' U F` |
| 36 | corner-slot | `slot:D/top:Gup` | DFR, white→D | UR, green→U | `U' F' U F U R U' R'` |
| 37 | both-slot | `DFR:D/FR:R` | DFR, white→D | FR, green→R | `R2 U2 F R2 F' U2 R' U R'` |
| 38 | both-slot | `DFR:R/FR:R` | DFR, white→R | FR, green→R | `R U' R' U2 R U R' F' U' F` |
| 39 | both-slot | `DFR:F/FR:R` | DFR, white→F | FR, green→R | `F' U F U2 F' U' F R U R'` |
| 40 | both-slot | `DFR:R/FR:F` | DFR, white→R | FR, green→F | `R U R' U2 R U' R' U R U R'` |
| 41 | both-slot | `DFR:F/FR:F` | DFR, white→F | FR, green→F | `R U R' U' R U2 R' U' R U R'` |

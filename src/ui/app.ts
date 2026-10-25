import './styles.css';
import { LEVELS, levelById, sameCriteria, weightsFor, type Criteria, type LevelId } from '../coach/levels';
import type { PairOption } from '../coach/planner';
import { scoreSolve, segmentSolve, type SolveScore, type SolveStep } from '../coach/score';
import { addCases, addSolve, rolling, suggestDrills, type CaseRecord, type History } from '../coach/stats';
import { CASES, type CaseGroup } from '../cube/cases';
import {
  FACE_NORMAL, applyAlg, dot, formatAlg, formatMove, invertAlg, parseAlg, relabelForY, simplify, solved,
  type Face, type Move, type State,
} from '../cube/model';
import { recogniseCase } from '../cube/recognise';
import { pairScramble, triggerScramble, type PairScramble } from '../cube/scramble';
import { SLOTS, isCrossSolved, solvedSlots, type SlotId } from '../cube/slots';
import { moveCost, parseRoute, routeText, rotationToken, type Route } from '../cube/solver';
import { requestOptions, requestPlan, requestRoutes } from '../cube/solverClient';
import { DEFAULT_KEYMAP, viewMove } from '../input/keyboard';
import { CubeView, type Turn, type ViewMode } from '../render/cubeView';
import { icon } from './icons';

type Mode = 'practice' | 'drill';
type Theme = 'system' | 'light' | 'dark';
type Phase = 'ready' | 'solving' | 'done';

interface Settings { turnMs: number; greyLL: boolean; theme: Theme; viewMode: ViewMode }
interface Prefs {
  mode: Mode; pairs: number; drillCases: number[]; myAlgs: Record<number, string>;
  level: LevelId; criteria: Criteria;
}
interface PlaybackPart { rotation: number; seen: Move[]; moves: Move[] }
/** Something to watch: one or more parts (a pair each), played from a position and view. */
interface PlaybackSource { key: string; label: string; from: State; view: number; parts: PlaybackPart[] }
interface Playback {
  src: PlaybackSource; steps: Turn[]; tokens: string[]; breaks: Set<number>;
  index: number; playing: boolean; timer: number;
}

const uTurn = (n: number): Move[] => (((n % 4) + 4) % 4 ? [{ face: 'U', amount: (((n % 4) + 4) % 4) as 1 | 2 | 3 }] : []);
/** at: ms since the first move; view: y quarter-turns the cube was seen from when the turn was made. */
interface HistoryEntry { turn: Turn; label: string; at: number; view: number }

const yView = (k: number) => ({ axis: [0, 1, 0] as const, quarters: k === 3 ? 1 : -k });
const seenOf = (label: string): Move | null => (/^[URFDLB](2|')?$/.test(label) ? parseAlg(label)[0] : null);
const slotName = (id: SlotId) => SLOTS.find((s) => s.id === id)!.name;
const tone = (score: number) => (score >= 8.5 ? 'good' : score >= 6.5 ? 'ok' : 'low');
interface Split { slot: SlotId; ms: number; moves: number }

const GROUP_NAMES: Record<CaseGroup, string> = {
  up: 'White facing up',
  right: 'White facing right',
  front: 'White facing front',
  'edge-slot': 'Edge in slot',
  'corner-slot': 'Corner in slot',
  'both-slot': 'Both in slot',
};
const SLOT_CSS: Record<string, string> = { green: '#00a651', orange: '#ff6a13', red: '#dc2626', blue: '#1d5bd6' };

const store = {
  load<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  },
  save(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: settings just won't persist */ }
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function formatTime(ms: number) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(2);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

export class App {
  private settings: Settings = store.load('f2l.settings', {
    turnMs: 140, greyLL: true, theme: 'system' as Theme, viewMode: 'orbit' as ViewMode,
  });
  private prefs: Prefs = store.load('f2l.prefs', {
    mode: 'practice' as Mode, pairs: 1, drillCases: CASES.map((c) => c.id), myAlgs: {} as Record<number, string>,
    level: 'beginner' as LevelId, criteria: { ...LEVELS[0].criteria },
  });
  private progress: History = store.load('f2l.history', { solves: [], cases: [] } as History);
  /** Benchmark solve of the current practice scramble. */
  private plan: PairOption[] | null = null;
  private result: SolveScore | null = null;
  private scoring = false;
  /** Each scramble is recorded once, even if you retry it after watching. */
  private recorded = false;
  /** Where the cube was when you left the results to watch something. */
  private resultState: State | null = null;
  private routes: Route[] | null = null;
  private routesToken = 0;
  private playback: Playback | null = null;

  private view!: CubeView;
  private state: State = solved();
  private history: HistoryEntry[] = [];
  private scramble: PairScramble | null = null;
  private targets: SlotId[] = [];
  private splits: Split[] = [];
  private phase: Phase = 'ready';
  private startedAt = 0;
  private endedAt = 0;
  private moves = 0;
  private rotations = 0;
  private revealed = false;
  private warning: string | null = null;
  private toastTimer = 0;

  private el!: {
    stage: HTMLElement; coach: HTMLElement; scramble: HTMLElement; banner: HTMLElement;
    scrambleBar: HTMLElement; player: HTMLElement; viewSeg: HTMLElement;
    modeSeg: HTMLElement; pairs: HTMLElement; drillBtn: HTMLButtonElement;
    help: HTMLElement; settings: HTMLElement; picker: HTMLElement; level: HTMLElement; levelBtn: HTMLElement;
  };

  constructor(private root: HTMLElement) {
    this.applyTheme();
    this.renderShell();
    this.view = new CubeView(this.el.stage);
    this.view.turnMs = this.settings.turnMs;
    this.view.greyLastLayer = this.settings.greyLL;
    this.view.setMode(this.settings.viewMode);
    this.renderViewSeg();
    this.syncLLGrey();
    this.view.onTurn = (turn) => this.turn(turn);
    this.bindKeys();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.syncLLGrey());
    this.newScramble();
    this.tickTimer();
  }

  // ---- Session ----

  private newScramble() {
    this.stopPlayback();
    const drill = this.prefs.mode === 'drill';
    this.scramble = drill
      ? pairScramble({ pairs: 1, caseIds: this.prefs.drillCases, slots: ['FR'] })
      : triggerScramble({ pairs: this.prefs.pairs });
    this.state = this.scramble.state.slice();
    this.view.setState(this.state);
    this.view.resetView();
    this.targets = SLOTS.map((s) => s.id).filter((id) => !solvedSlots(this.state).includes(id));
    this.history = [];
    this.splits = [];
    this.phase = 'ready';
    this.moves = this.rotations = 0;
    this.startedAt = this.endedAt = 0;
    this.revealed = false;
    this.warning = null;
    this.routes = null;
    this.plan = null;
    this.result = null;
    this.scoring = false;
    this.recorded = false;
    this.resultState = null;
    const token = ++this.routesToken;
    if (drill) {
      const keep = SLOTS.map((sl) => sl.id).filter((id) => id !== 'FR');
      requestRoutes(this.state, 'FR', keep).then((routes) => {
        if (token !== this.routesToken) return;
        this.routes = routes;
        this.renderCoach();
      });
    } else {
      this.requestPlan();
    }
    this.renderScramble();
    this.renderCoach();
    this.renderBanner();
  }

  private turn(turn: Turn, label = this.labelFor(turn)) {
    if (!CubeView.keepsWhiteDown(turn)) {
      this.toast('White stays on the bottom: x, z, r and M/S turns are off');
      return;
    }
    if (this.playback) this.stopPlayback(true);
    if (this.phase === 'ready' && turn.moves.length) {
      this.phase = 'solving';
      this.startedAt = performance.now();
    }
    const view = this.currentView();
    this.apply(turn);
    this.history.push({ turn, label, at: this.startedAt ? performance.now() - this.startedAt : 0, view });
    if (turn.moves.length) this.moves++;
    else this.rotations++;
    this.afterChange();
  }

  private undo() {
    if (this.playback) return;
    const last = this.history.pop();
    if (!last) return;
    const t = last.turn;
    this.apply({ moves: invertAlg(t.moves), view: t.view && { axis: t.view.axis, quarters: -t.view.quarters } });
    if (t.moves.length) this.moves--;
    else this.rotations--;
    this.afterChange();
  }

  private apply(turn: Turn) {
    this.state = applyAlg(this.state, turn.moves);
    this.view.enqueue(turn);
  }

  private afterChange() {
    const solvedNow = solvedSlots(this.state);
    const elapsed = performance.now() - this.startedAt;

    if (this.phase === 'solving') {
      for (const id of this.targets) {
        if (solvedNow.includes(id) && !this.splits.some((s) => s.slot === id)) {
          this.splits.push({ slot: id, ms: elapsed, moves: this.moves });
        }
      }
    }
    // A pair counts only while it stays solved.
    this.splits = this.splits.filter((s) => solvedNow.includes(s.slot));

    const crossOk = isCrossSolved(this.state);
    const broken = SLOTS.filter((s) => !this.targets.includes(s.id) && !solvedNow.includes(s.id));
    this.warning = !crossOk
      ? 'The cross is broken'
      : broken.length
        ? `${broken[0].name} slot was broken`
        : null;

    if (this.phase === 'solving' && crossOk && solvedNow.length === 4) {
      this.phase = 'done';
      this.endedAt = performance.now();
      this.revealed = true;
      this.scoreAttempt();
    }
    this.renderCoach();
    this.renderBanner();
  }

  // ---- Level, benchmark and score ----

  private weights() {
    return weightsFor({ level: this.prefs.level, criteria: this.prefs.criteria });
  }

  /** y quarter-turns the cube is seen from (0 = green front, 1 = orange front…). */
  private currentView() {
    return ({ F: 0, R: 1, B: 2, L: 3 } as Partial<Record<Face, number>>)[this.view.seenFace([0, 0, 1])] ?? 0;
  }

  private requestPlan() {
    if (!this.scramble || this.prefs.mode !== 'practice') return;
    const token = this.routesToken;
    this.plan = null;
    requestPlan(this.scramble.state, 0, this.weights()).then((plan) => {
      if (token !== this.routesToken) return;
      this.plan = plan;
      this.renderCoach();
    });
  }

  /** Score the finished attempt against the benchmark at your level, then record it once. */
  private scoreAttempt() {
    if (!this.scramble) return;
    const w = this.weights();
    const token = this.routesToken;
    const steps: SolveStep[] = this.history
      .filter((h) => h.turn.moves.length)
      .map((h) => ({ moves: h.turn.moves, seen: seenOf(h.label), at: h.at, view: h.view }));
    const segments = segmentSolve(this.scramble.state, steps, this.targets);
    if (!segments.length) return;
    const caseIds = segments.map((sg) => sg.slots.map((id) => recogniseCase(sg.startState, id)));
    this.scoring = true;
    this.result = null;
    const jobs = segments.map((sg) => ({ state: sg.startState, view: sg.startView, targets: sg.open, keep: sg.keep }));
    requestOptions(jobs, w).then((options) => {
      if (token !== this.routesToken) return;
      this.scoring = false;
      this.result = scoreSolve(segments, options, caseIds, w);
      if (!this.recorded) this.record(this.result);
      this.renderCoach();
    });
  }

  private record(r: SolveScore) {
    this.recorded = true;
    const source = this.prefs.mode;
    const cases: CaseRecord[] = r.pairs.flatMap((p) =>
      p.slots.length === 1 && p.caseIds[0] ? [{ caseId: p.caseIds[0], score: Math.round(p.efficiency * 10) / 10, at: Date.now(), source }] : [],
    );
    this.progress = source === 'practice'
      ? addSolve(this.progress, { at: Date.now(), level: this.prefs.level, score: r.score }, cases)
      : addCases(this.progress, cases);
    store.save('f2l.history', this.progress);
  }

  /** The level or a criterion changed: new benchmark, and rescore a finished solve. */
  private onProfileChange() {
    this.savePrefs();
    this.renderTopbar();
    this.requestPlan();
    if (this.phase === 'done') this.scoreAttempt();
    this.renderCoach();
  }

  /** Name a turn the way it looks on screen (R, U', y…). */
  private labelFor(turn: Turn): string {
    const suffix = (q: number) => (q === -1 ? '' : q === 1 ? "'" : '2');
    const seenLetter = (f: Face) =>
      (['R', 'L', 'U', 'D', 'F', 'B'] as const).find((l) => this.seenFaceFor(l) === f) ?? f;
    if (!turn.moves.length && turn.view) {
      const rot = (['x', 'y', 'z'] as const).find((r) => {
        const n = FACE_NORMAL[this.seenFaceFor(({ x: 'R', y: 'U', z: 'F' } as const)[r])];
        return Math.abs(dot(n, turn.view!.axis)) === 1;
      });
      return `${rot ?? 'rot'}${suffix(turn.view.quarters)}`;
    }
    if (turn.moves.length === 1 && !turn.view) {
      const m = turn.moves[0];
      return seenLetter(m.face) + formatMove(m).slice(1);
    }
    if (turn.view && turn.moves.length === 2) {
      // Slice: M follows L, E follows D, S follows F (each +90° about R, U, B).
      const a = turn.view.axis;
      const along = (l: 'R' | 'U' | 'F') => dot(FACE_NORMAL[this.seenFaceFor(l)], a);
      const [name, sign] = along('R') ? ['M', along('R')] : along('U') ? ['E', along('U')] : ['S', -along('F')];
      return name + (sign * turn.view.quarters === 1 ? '' : "'");
    }
    return turn.moves.map(formatMove).join(' ');
  }

  private seenFaceFor(letter: 'R' | 'L' | 'U' | 'D' | 'F' | 'B'): Face {
    const dir = { R: [1, 0, 0], L: [-1, 0, 0], U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1] }[letter] as [number, number, number];
    return this.view.seenFace(dir);
  }

  // ---- Keyboard ----

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      const open = this.openDialog();
      if (e.key === 'Escape' && open) {
        this.close(open);
        return;
      }
      if (open) return;

      if (this.playback) {
        const handled = this.playbackKey(e.key);
        if (handled) {
          e.preventDefault();
          return;
        }
      }
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
          e.preventDefault();
          this.view.stepView(e.key === 'ArrowRight' ? 1 : -1);
          return;
        case ' ':
          e.preventDefault();
          this.newScramble();
          return;
        case 'Enter':
          e.preventDefault();
          if (this.phase === 'done') this.newScramble();
          else if (this.prefs.mode === 'drill') this.reveal();
          return;
        case 'Backspace':
          e.preventDefault();
          this.undo();
          return;
        case 'Escape':
          this.view.resetView();
          return;
        case '?':
          this.show(this.el.help);
          return;
      }
      const token = DEFAULT_KEYMAP[e.key.toLowerCase()];
      if (!token || e.repeat) return;
      const turn = viewMove(token, (dir) => this.view.seenFace(dir));
      if (turn) this.turn(turn, token);
    });
  }

  private reveal() {
    this.revealed = true;
    this.renderCoach();
  }

  // ---- Rendering ----

  private renderShell() {
    this.root.innerHTML = `
      <div class="app">
        <header class="topbar">
          <div class="brand">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor"/><rect x="7" y="7" width="8" height="8" rx="2" fill="#00a651"/><rect x="17" y="7" width="8" height="8" rx="2" fill="#ff6a13"/><rect x="7" y="17" width="8" height="8" rx="2" fill="#f4f4f5"/><rect x="17" y="17" width="8" height="8" rx="2" fill="#f4f4f5"/></svg>
            <span>F2L Coach</span>
          </div>
          <div class="seg" role="group" aria-label="Mode" data-ref="modeSeg">
            <button data-mode="practice">Practice</button>
            <button data-mode="drill">Case drill</button>
          </div>
          <div class="pairs" data-ref="pairs">
            <label for="pairs-range">Pairs</label>
            <div class="range">
              <div class="track"><div class="fill"></div></div>
              <div class="ticks"><i></i><i></i><i></i><i></i></div>
              <input id="pairs-range" type="range" min="1" max="4" step="1" />
            </div>
            <output for="pairs-range"></output>
          </div>
          <button class="btn" data-ref="drillBtn" data-action="pick"></button>
          <button class="btn" data-ref="levelBtn" data-action="level" title="Level and scoring criteria"></button>
          <div class="spacer"></div>
          <button class="btn ghost" disabled title="GoCube support is next (milestone 2)">${icon('bluetooth')} Connect GoCube</button>
          <button class="icon-btn" data-action="help" title="Shortcuts (?)" aria-label="Shortcuts">${icon('keyboard')}</button>
          <button class="icon-btn" data-action="settings" title="Settings" aria-label="Settings">${icon('settings')}</button>
        </header>
        <main class="stage" data-ref="stage">
          <div class="stage-hint">
            <span>${icon('move', 14)} Drag background to spin</span>
            <span>${icon('pointer', 14)} Drag a sticker to turn</span>
            <span><kbd>Esc</kbd> reset view</span>
          </div>
          <div class="banner" data-ref="banner" hidden></div>
          <div class="view-toggle">
            <div class="seg" role="group" aria-label="View" data-ref="viewSeg">
              <button data-view="orbit" title="Drag to spin; white stays on the bottom">${icon('rotate', 14)} Orbit</button>
              <button data-view="snap" title="8 fixed angles: ← → or scroll">${icon('grid', 14)} Snap</button>
            </div>
            <span class="view-hint subtle"><kbd>←</kbd><kbd>→</kbd> or scroll</span>
          </div>
          <div class="player" data-ref="player" hidden></div>
          <div class="scramble-bar" data-ref="scrambleBar">
            <div>
              <div class="scramble-label">Scramble</div>
              <div class="scramble-text" data-ref="scramble"></div>
            </div>
            <button class="btn primary" data-action="new">New <kbd>Space</kbd></button>
          </div>
        </main>
        <aside class="coach" data-ref="coach" aria-live="polite"></aside>
      </div>
      <div class="scrim" data-ref="help" hidden>${this.helpHtml()}</div>
      <div class="scrim drawer" data-ref="settings" hidden></div>
      <div class="scrim" data-ref="picker" hidden></div>
      <div class="scrim" data-ref="level" hidden></div>
    `;
    const ref = (name: string) => this.root.querySelector<HTMLElement>(`[data-ref="${name}"]`)!;
    this.el = {
      stage: ref('stage'), coach: ref('coach'), scramble: ref('scramble'), banner: ref('banner'),
      scrambleBar: ref('scrambleBar'), player: ref('player'), viewSeg: ref('viewSeg'),
      modeSeg: ref('modeSeg'), pairs: ref('pairs'), drillBtn: ref('drillBtn') as HTMLButtonElement,
      help: ref('help'), settings: ref('settings'), picker: ref('picker'), level: ref('level'), levelBtn: ref('levelBtn'),
    };

    this.root.addEventListener('click', (e) => this.onClick(e));
    for (const scrim of [this.el.help, this.el.settings, this.el.picker, this.el.level]) {
      scrim.addEventListener('mousedown', (e) => {
        if (e.target === scrim) this.close(scrim);
      });
    }
    const range = this.el.pairs.querySelector('input')!;
    range.addEventListener('input', () => {
      this.prefs.pairs = Number(range.value);
      this.savePrefs();
      this.renderTopbar();
      this.newScramble();
      range.blur();
    });
    this.renderTopbar();
  }

  private onClick(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-mode], [data-case], [data-group], [data-view], [data-route], [data-level]');
    if (!t) return;
    if (t.dataset.view) {
      this.setSetting('viewMode', t.dataset.view as ViewMode);
      this.view.setMode(this.settings.viewMode);
      this.renderViewSeg();
      t.blur();
      return;
    }
    if (t.dataset.route) {
      const route = this.drillRoutes().find((r) => r.key === t.dataset.route);
      if (route && t.dataset.action === 'star') this.toggleMine(route);
      else if (route && this.scramble) {
        this.startPlayback({
          key: route.key, label: route.label, from: this.scramble.state, view: 0,
          parts: [{ rotation: route.rotation, seen: route.seen, moves: route.moves }],
        });
      }
      t.blur();
      return;
    }
    if (t.dataset.level) {
      const level = levelById(t.dataset.level as LevelId);
      this.prefs.level = level.id;
      this.prefs.criteria = { ...level.criteria };
      this.renderLevel();
      this.onProfileChange();
      return;
    }
    if (t.dataset.mode) {
      this.prefs.mode = t.dataset.mode as Mode;
      this.savePrefs();
      this.renderTopbar();
      this.newScramble();
      return;
    }
    if (t.dataset.case) {
      const id = Number(t.dataset.case);
      const set = new Set(this.prefs.drillCases);
      set.has(id) ? set.delete(id) : set.add(id);
      this.prefs.drillCases = [...set].sort((a, b) => a - b);
      this.renderPicker();
      return;
    }
    if (t.dataset.group) {
      const ids = CASES.filter((c) => c.group === t.dataset.group).map((c) => c.id);
      const all = ids.every((id) => this.prefs.drillCases.includes(id));
      const set = new Set(this.prefs.drillCases);
      ids.forEach((id) => (all ? set.delete(id) : set.add(id)));
      this.prefs.drillCases = [...set].sort((a, b) => a - b);
      this.renderPicker();
      return;
    }
    switch (t.dataset.action) {
      case 'new': this.newScramble(); break;
      case 'undo': this.undo(); break;
      case 'reveal': this.reveal(); break;
      case 'reset-view': this.view.resetView(); break;
      case 'help': this.show(this.el.help); break;
      case 'settings': this.renderSettings(); this.show(this.el.settings); break;
      case 'pick': this.renderPicker(); this.show(this.el.picker); break;
      case 'close': this.close(t.closest('.scrim') as HTMLElement); break;
      case 'all-cases': this.prefs.drillCases = CASES.map((c) => c.id); this.renderPicker(); break;
      case 'no-cases': this.prefs.drillCases = []; this.renderPicker(); break;
      case 'picker-done': this.close(this.el.picker); break;
      case 'theme': this.setSetting('theme', t.dataset.value as Theme); break;
      case 'pb-play': this.togglePlay(); break;
      case 'pb-prev': this.stepPlayback(-1); break;
      case 'pb-next': this.stepPlayback(1); break;
      case 'pb-exit': this.stopPlayback(true); break;
      case 'pb-retry': this.stopPlayback(); this.resetAttempt(); break;
      case 'level': this.renderLevel(); this.show(this.el.level); break;
      case 'level-reset':
        this.prefs.criteria = { ...levelById(this.prefs.level).criteria };
        this.renderLevel();
        this.onProfileChange();
        break;
      case 'watch-plan': this.watchPlan(); break;
      case 'watch-tip': this.watchTip(); break;
      case 'drill-suggested': this.drillSuggested(); break;
    }
    (t as HTMLElement).blur();
  }

  private renderTopbar() {
    const drill = this.prefs.mode === 'drill';
    this.el.modeSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === this.prefs.mode)),
    );
    this.el.pairs.hidden = drill;
    this.el.drillBtn.hidden = !drill;
    const n = this.prefs.drillCases.length;
    this.el.drillBtn.innerHTML = `${icon('grid', 15)} ${n === CASES.length ? 'All 41 cases' : `${n} case${n === 1 ? '' : 's'}`}`;
    const level = levelById(this.prefs.level);
    const custom = !sameCriteria(this.prefs.criteria, level.criteria);
    this.el.levelBtn.innerHTML = `${icon('gauge', 15)} ${level.name}${custom ? '<span class="subtle">· custom</span>' : ''}`;
    const range = this.el.pairs.querySelector('input')!;
    range.value = String(this.prefs.pairs);
    this.el.pairs.querySelector('output')!.textContent = String(this.prefs.pairs);
    const pct = ((this.prefs.pairs - 1) / 3) * 100;
    this.el.pairs.querySelector<HTMLElement>('.fill')!.style.width = `${pct}%`;
    this.el.pairs.querySelectorAll('.ticks i').forEach((el, i) => el.classList.toggle('on', i < this.prefs.pairs));
  }

  private renderScramble() {
    this.el.scramble.textContent = formatAlg(this.scramble?.moves ?? []) || '—';
  }

  private renderBanner() {
    const b = this.el.banner;
    b.hidden = !this.warning;
    if (this.warning) {
      b.innerHTML = `${icon('alert', 16)} ${esc(this.warning)} <button class="btn" data-action="undo" style="height:28px">Undo <kbd>⌫</kbd></button>`;
    }
  }

  private renderCoach() {
    const drill = this.prefs.mode === 'drill';
    const solvedNow = solvedSlots(this.state);
    const left = this.targets.filter((id) => !solvedNow.includes(id)).length;
    const status =
      this.phase === 'done'
        ? `<span class="status-pill done"><span class="dot"></span>Solved</span>`
        : this.phase === 'solving'
          ? `<span class="status-pill live"><span class="dot"></span>Solving</span>`
          : `<span class="status-pill"><span class="dot"></span>Ready</span>`;
    const headline =
      this.phase === 'done'
        ? drill ? 'Pair inserted' : 'All pairs solved'
        : `Solve ${left} pair${left === 1 ? '' : 's'}`;
    const sub =
      this.phase === 'ready'
        ? 'Inspect first, then make your first turn. The timer starts on your first move.'
        : this.phase === 'done'
          ? `Press <kbd>Enter</kbd> for the next ${drill ? 'case' : 'scramble'}.`
          : 'Keep the cross and solved pairs intact.';

    const slotsHtml = SLOTS.filter((s) => this.targets.includes(s.id) || drill === false)
      .map((s) => {
        const done = solvedNow.includes(s.id);
        const split = this.splits.find((x) => x.slot === s.id);
        const target = this.targets.includes(s.id);
        const state = !target
          ? `${icon('check', 14)} Already solved`
          : done
            ? `${icon('check', 14)} ${split ? `${formatTime(split.ms)}s · ${split.moves} mv` : 'Solved'}`
            : 'To solve';
        return `<div class="slot ${done ? 'solved' : ''}">
          <span class="swatch"><i style="background:${SLOT_CSS[s.colors[0]]}"></i><i style="background:${SLOT_CSS[s.colors[1]]}"></i></span>
          <span class="name">${s.name}</span>
          <span class="state">${state}</span>
        </div>`;
      })
      .join('');

    let caseHtml = '';
    if (drill && this.scramble) {
      const c = this.drillCase();
      if (c) caseHtml = this.caseHtml(c);
    }
    const scoreHtml = this.scoreHtml();
    const showSlots = drill || !scoreHtml;

    const elapsed = this.phase === 'ready' ? 0 : (this.endedAt || performance.now()) - this.startedAt;
    this.el.coach.innerHTML = `
      <div class="section">
        ${status}
        <h1 class="headline" style="margin-top:12px">${headline}</h1>
        <p class="muted" style="margin:0">${sub}</p>
      </div>
      <div class="section">
        <div class="stats">
          <div class="stat"><div class="label">Time</div><div class="value" data-ref="timer">${formatTime(elapsed)}</div></div>
          <div class="stat"><div class="label">Moves</div><div class="value">${this.moves}${this.rotations ? `<span class="subtle" style="font-size:13px"> +${this.rotations} rot</span>` : ''}</div></div>
        </div>
      </div>
      ${drill ? scoreHtml : ''}
      ${caseHtml}
      ${drill ? '' : scoreHtml}
      ${showSlots ? `<div class="section">
        <p class="eyebrow">${drill ? 'Slot' : 'Pairs'}</p>
        <div class="slots">${slotsHtml}</div>
      </div>` : ''}
      ${this.suggestionsHtml()}
      <div class="section">
        <p class="eyebrow">Your moves</p>
        <div class="history">${
          this.history.length
            ? this.history.map((h) => `<span class="${h.turn.moves.length ? '' : 'rot'}">${esc(h.label)}</span>`).join('')
            : '<span class="empty">No moves yet</span>'
        }</div>
      </div>
      <div class="grow"></div>
      <div class="section">
        <div class="actions" style="grid-template-columns:1fr 1fr">
          <button class="btn" data-action="undo" ${this.history.length ? '' : 'disabled'}>${icon('undo', 15)} Undo <kbd>⌫</kbd></button>
          <button class="btn" data-action="reset-view">${icon('rotate', 15)} View <kbd>Esc</kbd></button>
        </div>
      </div>
    `;
  }

  private scoreHtml() {
    if (this.phase !== 'done') return '';
    if (!this.result) {
      return this.scoring
        ? `<div class="section"><p class="eyebrow">Score</p><div class="empty loading">${icon('loader', 14)} Scoring your solve…</div></div>`
        : '';
    }
    const r = this.result;
    const level = levelById(this.prefs.level);
    const drill = this.prefs.mode === 'drill';
    const roll = rolling(this.progress, level.id);
    const trend = roll.trend !== null && Math.abs(roll.trend) >= 0.1
      ? ` <span class="trend ${roll.trend > 0 ? 'up' : 'down'}">${roll.trend > 0 ? '▲' : '▼'} ${Math.abs(roll.trend).toFixed(1)}</span>`
      : '';
    const side = drill
      ? `<div class="score-side"><div class="muted">${r.pairs[0]?.moves ?? 0} moves · par ${r.pairs[0]?.par ?? 0}</div></div>`
      : `<div class="score-side">
          <div><span class="muted">Avg of ${roll.window}</span> <b class="mono">${roll.avg?.toFixed(1) ?? '–'}</b>${trend}</div>
          <div><span class="muted">Best</span> <b class="mono">${roll.best?.toFixed(1) ?? '–'}</b></div>
        </div>`;
    const head = `<div class="score-head">
        <div class="score-big ${tone(r.score)}">${r.score.toFixed(1)}<span>/10</span></div>
        ${side}
      </div>`;
    if (drill) return `<div class="section"><p class="eyebrow">Score · ${level.name}</p>${head}</div>`;

    const rows = r.pairs
      .map((p) => {
        const slot = SLOTS.find((x) => x.id === p.slots[0])!;
        const bits = [`${p.moves} moves · par ${p.par}`];
        if (p.rotations && this.prefs.criteria.rotations) bits.push(`${p.rotations} rot`);
        if (p.flow !== null && p.flow < 8.5) bits.push(`${(p.pauseMs / 1000).toFixed(1)}s pause`);
        if (p.choice !== null && p.choice < 8.5) bits.push('harder pair first');
        const caseTag = p.caseIds[0] ? `<span class="case-tag">#${p.caseIds[0]}</span>` : '';
        return `<div class="pair-score">
          <span class="swatch"><i style="background:${SLOT_CSS[slot.colors[0]]}"></i><i style="background:${SLOT_CSS[slot.colors[1]]}"></i></span>
          <div class="ps-main">
            <div class="ps-name">${p.slots.map(slotName).join(' + ')}${caseTag}</div>
            <div class="ps-detail">${bits.join(' · ')}</div>
          </div>
          <span class="ps-score ${tone(p.score)}">${p.score.toFixed(1)}</span>
        </div>`;
      })
      .join('');
    const tip = r.tip
      ? `<div class="tip">${icon('lightbulb', 16)}<div><p>${esc(r.tip.text)}</p>
          <button class="btn sm" data-action="watch-tip">${icon('play', 13)} Watch a better way</button></div></div>`
      : `<div class="tip good">${icon('check', 16)}<div><p>Nothing big to fix. A clean ${level.name.toLowerCase()} solve.</p></div></div>`;
    return `<div class="section">
      <p class="eyebrow">Score · ${level.name}</p>
      ${head}
      <div class="pair-scores">${rows}</div>
      ${tip}
      <button class="btn block" data-action="watch-plan" style="margin-top:10px" ${this.plan ? '' : 'disabled'}>
        ${this.plan ? icon('play', 14) : icon('loader', 14)} Watch the ${level.name.toLowerCase()} benchmark
      </button>
    </div>`;
  }

  /** Cases that keep costing you across recent solves (never from a single bad one). */
  private suggestionsHtml() {
    if (this.prefs.mode !== 'practice' || this.phase === 'solving') return '';
    const s = suggestDrills(this.progress);
    if (!s.length) return '';
    const chips = s
      .map((d) => `<span class="chip static" title="About ${d.estimate.toFixed(1)}/10 over ${d.seen} recent pairs (your usual ${d.norm.toFixed(1)})">${d.caseId}</span>`)
      .join('');
    return `<div class="section">
      <p class="eyebrow">Worth drilling</p>
      <p class="muted note">These cases have cost you moves over several solves, not just once.</p>
      <div class="chips">${chips}</div>
      <button class="btn block" data-action="drill-suggested" style="margin-top:12px">${icon('target', 15)} Drill ${s.length === 1 ? 'this case' : `these ${s.length} cases`}</button>
    </div>`;
  }

  private watchPlan() {
    if (!this.plan || !this.scramble) return;
    const level = levelById(this.prefs.level);
    this.startPlayback({ key: 'plan', label: `${level.name} benchmark`, from: this.scramble.state, view: 0, parts: this.plan });
  }

  private watchTip() {
    const tip = this.result?.tip;
    if (!tip) return;
    const pair = this.result!.pairs[tip.pair];
    this.startPlayback({
      key: 'tip', label: `Better ${slotName(tip.route.slot).toLowerCase()}`,
      from: pair.startState, view: pair.startView, parts: [tip.route],
    });
  }

  private drillSuggested() {
    const ids = suggestDrills(this.progress).map((d) => d.caseId);
    if (!ids.length) return;
    this.prefs.drillCases = ids.sort((a, b) => a - b);
    this.prefs.mode = 'drill';
    this.savePrefs();
    this.renderTopbar();
    this.newScramble();
    this.toast(`Drilling case${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`);
  }

  // ---- Drill routes ----

  private drillCase() {
    return CASES.find((x) => x.id === this.scramble?.cases[0]?.caseId);
  }

  /** Mine (if starred), the sheet algorithm, then the solver's routes, without duplicates. */
  private drillRoutes(): Route[] {
    const c = this.drillCase();
    if (!c || !this.scramble) return [];
    const auf = this.scramble.finalAuf;
    const out: Route[] = [];
    const fromSeen = (key: string, label: string, rotation: number, seen: Move[]): Route => {
      const s2 = simplify([...uTurn(-auf), ...seen]);
      return { key, label, rotation, seen: s2, moves: relabelForY(s2, rotation), cost: moveCost(s2) + (rotation ? (rotation === 2 ? 2.8 : 1.6) : 0) };
    };
    const mine = this.prefs.myAlgs[c.id];
    if (mine) {
      try {
        const r = parseRoute(mine);
        out.push(fromSeen('mine', 'My algorithm', r.rotation, r.seen));
      } catch { /* ignore a bad saved alg */ }
    }
    out.push(fromSeen('sheet', 'Your sheet', 0, parseAlg(c.alg)));
    for (const r of this.routes ?? []) out.push({ ...r });
    const seen = new Set<string>();
    return out.filter((r) => {
      const text = routeText(r);
      if (seen.has(text)) {
        const first = out.find((x) => routeText(x) === text)!;
        const short = r.label.split(':')[0];
        if (!first.label.includes(short) && first.key !== 'mine') first.label += ` · ${short}`;
        return false;
      }
      seen.add(text);
      return true;
    });
  }

  /** Text of a route with the AUF undone, so it applies to every scramble of this case. */
  private canonical(r: Route) {
    const auf = this.scramble?.finalAuf ?? 0;
    return routeText({ rotation: r.rotation, seen: simplify([...uTurn(auf), ...r.seen]) });
  }

  private toggleMine(r: Route) {
    const c = this.drillCase();
    if (!c) return;
    const text = this.canonical(r);
    if (r.key === 'mine' || this.prefs.myAlgs[c.id] === text) {
      delete this.prefs.myAlgs[c.id];
      this.toast('Removed from your algorithms');
    } else {
      this.prefs.myAlgs[c.id] = text;
      this.toast(`Saved as your algorithm for case #${c.id}`);
    }
    this.savePrefs();
    this.renderCoach();
  }

  private caseHtml(c: (typeof CASES)[number]) {
    const hidden = !this.revealed;
    const routes = this.drillRoutes();
    const mineText = this.prefs.myAlgs[c.id];
    const rows = routes
      .map((r) => {
        const starred = r.key === 'mine' || (mineText !== undefined && this.canonical(r) === mineText && !routes.some((x) => x.key === 'mine'));
        const count = r.seen.length;
        const active = this.playback?.src.key === r.key;
        return `<div class="route ${active ? 'active' : ''}">
          <div class="route-head">
            <span class="route-label">${esc(r.label)}</span>
            <span class="route-meta">${count} move${count === 1 ? '' : 's'}${r.rotation ? ' + y' : ''}</span>
          </div>
          <div class="alg">${esc(routeText(r))}</div>
          <div class="route-actions">
            <button class="btn sm" data-route="${r.key}">${icon('play', 13)} Watch</button>
            <button class="icon-btn sm ${starred ? 'starred' : ''}" data-route="${r.key}" data-action="star" title="${starred ? 'Remove as my algorithm' : 'Make this my algorithm'}" aria-label="Make this my algorithm">${icon(starred ? 'star-filled' : 'star', 16)}</button>
          </div>
        </div>`;
      })
      .join('');
    const loading = this.routes === null ? `<div class="empty" style="padding:4px 2px">${icon('loader', 14)} Finding alternative routes…</div>` : '';
    return `<div class="section">
      <p class="eyebrow">Case</p>
      <div class="case-card">
        <div class="head">
          <span class="num ${hidden ? 'hidden-alg' : ''}">#${c.id}</span>
          <span class="group">${hidden ? 'Hidden until you solve' : GROUP_NAMES[c.group]}</span>
        </div>
        ${
          hidden
            ? `<div class="body"><button class="btn" data-action="reveal">${icon('eye', 15)} Show routes <kbd>Enter</kbd></button></div>`
            : `<div class="routes">${rows}${loading}</div>`
        }
      </div>
    </div>`;
  }

  // ---- Playback: watch a route on the cube from the standard angle ----

  private startPlayback(src: PlaybackSource) {
    if (!this.scramble) return;
    // Watching from the practice results keeps your solve; coming back restores it.
    const results = this.resultState ?? (this.prefs.mode === 'practice' && this.phase === 'done' ? this.state.slice() : null);
    this.stopPlayback();
    this.resultState = results;
    if (!results) {
      this.history = [];
      this.moves = this.rotations = 0;
    }
    this.warning = null;
    this.renderBanner();
    this.state = src.from.slice();
    this.view.setState(this.state);
    this.view.resetView();
    if (src.view) this.view.enqueue({ moves: [], view: yView(src.view) });
    const steps: Turn[] = [];
    const tokens: string[] = [];
    const breaks = new Set<number>();
    for (const part of src.parts) {
      if (tokens.length) breaks.add(tokens.length);
      if (part.rotation) {
        steps.push({ moves: [], view: yView(part.rotation) });
        tokens.push(rotationToken(part.rotation));
      }
      part.moves.forEach((m, i) => {
        steps.push({ moves: [m] });
        tokens.push(formatMove(part.seen[i]));
      });
    }
    this.view.turnMs = Math.max(this.settings.turnMs, 300);
    this.playback = { src, steps, tokens, breaks, index: 0, playing: true, timer: 0 };
    this.schedulePlayback(650);
    this.renderPlayer();
    this.renderCoach();
  }

  private schedulePlayback(delay = this.view.turnMs + 450) {
    const pb = this.playback;
    if (!pb) return;
    clearTimeout(pb.timer);
    if (!pb.playing) return;
    pb.timer = window.setTimeout(() => {
      if (pb.index >= pb.steps.length) {
        pb.playing = false;
        this.renderPlayer();
        return;
      }
      this.stepPlayback(1, false);
      this.schedulePlayback();
    }, delay);
  }

  private stepPlayback(dir: 1 | -1, pause = true) {
    const pb = this.playback;
    if (!pb) return;
    if (pause && pb.playing) {
      pb.playing = false;
      clearTimeout(pb.timer);
    }
    if (dir === 1 && pb.index < pb.steps.length) {
      const step = pb.steps[pb.index++];
      this.state = applyAlg(this.state, step.moves);
      this.view.enqueue(step);
    } else if (dir === -1 && pb.index > 0) {
      const step = pb.steps[--pb.index];
      this.state = applyAlg(this.state, invertAlg(step.moves));
      this.view.enqueue({ moves: invertAlg(step.moves), view: step.view && { axis: step.view.axis, quarters: -step.view.quarters } });
    }
    this.renderPlayer();
    this.renderCoach();
  }

  private togglePlay() {
    const pb = this.playback;
    if (!pb) return;
    if (!pb.playing && pb.index >= pb.steps.length) {
      this.startPlayback(pb.src);
      return;
    }
    pb.playing = !pb.playing;
    if (pb.playing) this.schedulePlayback(150);
    else clearTimeout(pb.timer);
    this.renderPlayer();
  }

  /** Leave playback; with `reset`, go back to your results, or put the case back so you can try it yourself. */
  private stopPlayback(reset = false) {
    const pb = this.playback;
    if (!pb) return;
    clearTimeout(pb.timer);
    this.playback = null;
    this.view.turnMs = this.settings.turnMs;
    if (reset && this.resultState) {
      this.state = this.resultState;
      this.resultState = null;
      this.view.setState(this.state);
      this.view.resetView();
    } else if (reset) {
      this.resetAttempt();
      return;
    }
    this.renderPlayer();
    this.renderCoach();
  }

  /** Put the scramble back and start the attempt over (it's only recorded the first time). */
  private resetAttempt() {
    if (!this.scramble) return;
    this.resultState = null;
    this.state = this.scramble.state.slice();
    this.view.setState(this.state);
    this.view.resetView();
    this.history = [];
    this.splits = [];
    this.phase = 'ready';
    this.moves = this.rotations = 0;
    this.startedAt = this.endedAt = 0;
    this.warning = null;
    this.result = null;
    this.scoring = false;
    this.renderBanner();
    this.renderPlayer();
    this.renderCoach();
  }

  private playbackKey(key: string): boolean {
    switch (key) {
      case ' ': this.togglePlay(); return true;
      case ',': this.stepPlayback(-1); return true;
      case '.': this.stepPlayback(1); return true;
      case 'Enter':
      case 'Escape': this.stopPlayback(true); return true;
      case 'Backspace': return true;
    }
    return false;
  }

  private renderPlayer() {
    const pb = this.playback;
    this.el.player.hidden = !pb;
    this.el.scrambleBar.hidden = !!pb;
    if (!pb) return;
    const tokens = pb.tokens
      .map((t, i) => `<span class="${i < pb.index ? 'done' : i === pb.index ? 'next' : ''}${pb.breaks.has(i) ? ' part' : ''}">${esc(t)}</span>`)
      .join('');
    const finished = pb.index >= pb.steps.length;
    this.el.player.innerHTML = `
      <div class="player-head">
        <span class="player-label">${icon('play', 13)} ${esc(pb.src.label)}</span>
        <span class="subtle mono">${pb.index} / ${pb.steps.length}</span>
      </div>
      <div class="player-alg">${tokens}</div>
      <div class="player-controls">
        <button class="icon-btn" data-action="pb-prev" title="Step back (,)" aria-label="Step back">${icon('chevron-left')}</button>
        <button class="btn primary" data-action="pb-play" style="min-width:104px">${icon(pb.playing ? 'pause' : finished ? 'rotate' : 'play', 14)} ${pb.playing ? 'Pause' : finished ? 'Replay' : 'Play'} <kbd>Space</kbd></button>
        <button class="icon-btn" data-action="pb-next" title="Step forward (.)" aria-label="Step forward">${icon('chevron-right')}</button>
        <div style="flex:1"></div>
        ${this.resultState ? '<button class="btn ghost" data-action="pb-retry">Retry scramble</button>' : ''}
        <button class="btn" data-action="pb-exit">${this.resultState ? 'Back to results' : 'Try it yourself'} <kbd>Enter</kbd></button>
      </div>`;
  }

  private renderViewSeg() {
    this.el.viewSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.view === this.settings.viewMode)),
    );
  }

  private tickTimer() {
    const loop = () => {
      if (this.phase === 'solving') {
        const t = this.el.coach.querySelector('[data-ref="timer"]');
        if (t) t.textContent = formatTime(performance.now() - this.startedAt);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private helpHtml() {
    const turnKeys: [string, string, string][] = [
      ['R', 'i', 'k'], ['U', 'j', 'f'], ['L', 'd', 'e'], ['F', 'h', 'g'], ['D', 's', 'l'], ['B', 'w', 'o'],
      ['y', ';', 'a'], ['x', 't', 'b'], ['z', 'p', 'q'], ['r', 'u', 'm'],
    ];
    const keyRows = turnKeys
      .map(([m, a, b]) => `<div><span class="move">${m} / ${m}'</span><span class="pair"><kbd>${a.toUpperCase()}</kbd><kbd>${b.toUpperCase()}</kbd></span></div>`)
      .join('');
    const actions: [string, string][] = [
      ['Space', 'New scramble'], ['Enter', 'Show routes / next'], ['⌫', 'Undo'], ['Esc', 'Reset view'],
      ['← →', 'Step view angle'], ['?', 'This help'],
    ];
    const playback: [string, string][] = [['Space', 'Play / pause'], [', .', 'Step back / forward'], ['Enter', 'Try it yourself / back to results']];
    return `<div class="dialog" role="dialog" aria-label="Shortcuts">
      <header><h2>Keyboard shortcuts</h2><button class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button></header>
      <div class="content">
        <div class="help-section"><h3>Turns (relative to what you see)</h3><div class="keys">${keyRows}</div></div>
        <div class="help-section"><h3>Actions</h3><div class="keys">${actions.map(([k, l]) => `<div><span>${l}</span><kbd>${k}</kbd></div>`).join('')}</div></div>
        <div class="help-section"><h3>Watching a route</h3><div class="keys">${playback.map(([k, l]) => `<div><span>${l}</span><kbd>${k}</kbd></div>`).join('')}</div></div>
        <div class="help-section"><h3>Mouse</h3><p class="muted" style="margin:0">Drag a sticker to turn its layer. Drag the background to spin the cube; white always stays on the bottom. In Snap view, scroll steps between 8 angles.</p></div>
      </div>
    </div>`;
  }

  private renderSettings() {
    const s = this.settings;
    const theme = (v: Theme, label: string) => `<button data-action="theme" data-value="${v}" aria-pressed="${s.theme === v}">${label}</button>`;
    this.el.settings.innerHTML = `<div class="dialog" role="dialog" aria-label="Settings">
      <header><h2>Settings</h2><button class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button></header>
      <div class="content">
        <div class="field">
          <div><div class="label">Turn speed</div><div class="hint" data-ref="speed-hint">${s.turnMs} ms per turn</div></div>
          <input type="range" min="40" max="320" step="20" value="${s.turnMs}" data-setting="turnMs" aria-label="Turn speed" />
        </div>
        <div class="field">
          <div><div class="label">Grey out last layer</div><div class="hint">Only F2L pieces keep their colour, like your case sheets</div></div>
          <label class="switch"><input type="checkbox" data-setting="greyLL" ${s.greyLL ? 'checked' : ''} aria-label="Grey out last layer" /><span></span></label>
        </div>
        <div class="field">
          <div><div class="label">Theme</div></div>
          <div class="seg">${theme('system', 'System')}${theme('light', 'Light')}${theme('dark', 'Dark')}</div>
        </div>
      </div>
    </div>`;
    this.el.settings.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((input) => {
      input.addEventListener('input', () => {
        if (input.type === 'checkbox') this.setSetting('greyLL', input.checked);
        else {
          this.setSetting('turnMs', Number(input.value));
          this.el.settings.querySelector('[data-ref="speed-hint"]')!.textContent = `${input.value} ms per turn`;
        }
      });
    });
  }

  private renderLevel() {
    const p = this.prefs;
    const level = levelById(p.level);
    const cards = LEVELS.map((l) => `<button class="level-card" data-level="${l.id}" aria-pressed="${p.level === l.id}">
        <span class="level-name">${l.name}</span><span class="level-blurb">${l.blurb}</span>
      </button>`).join('');
    const criteria: [keyof Criteria, string, string][] = [
      ['rotations', 'Count cube rotations', 'Rotations cost points, and the benchmark avoids them'],
      ['littleF', 'Little F and B moves', 'Let the benchmark use F and B turns, not just R, U and L'],
      ['backSlots', 'Back slots without rotating', 'Solve back pairs from the front, the way faster solvers do'],
      ['flow', 'Score flow', 'Pauses while you look for the next pair cost points. Turn off when you’re not going for time'],
    ];
    const fields = criteria.map(([k, label, hint]) => `<div class="field">
        <div><div class="label">${label}</div><div class="hint">${hint}</div></div>
        <label class="switch"><input type="checkbox" data-criterion="${k}" ${p.criteria[k] ? 'checked' : ''} aria-label="${label}" /><span></span></label>
      </div>`).join('');
    const custom = !sameCriteria(p.criteria, level.criteria);
    this.el.level.innerHTML = `<div class="dialog" role="dialog" aria-label="Level">
      <header><h2>Level</h2><button class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button></header>
      <div class="content">
        <p class="muted" style="margin:0 0 14px">Your level sets what the benchmark solve looks like and how strict the score is. You're scored against a good solve at your level, not the one perfect answer.</p>
        <div class="levels">${cards}</div>
        <div class="criteria-head"><p class="eyebrow" style="margin:0">Criteria</p>${custom ? `<button class="btn ghost sm" data-action="level-reset">Reset to ${level.name} defaults</button>` : ''}</div>
        ${fields}
      </div>
    </div>`;
    this.el.level.querySelectorAll<HTMLInputElement>('[data-criterion]').forEach((input) => {
      input.addEventListener('change', () => {
        this.prefs.criteria = { ...this.prefs.criteria, [input.dataset.criterion as keyof Criteria]: input.checked };
        this.onProfileChange();
        this.renderLevel();
      });
    });
  }

  private renderPicker() {
    const sel = new Set(this.prefs.drillCases);
    const groups = (Object.keys(GROUP_NAMES) as CaseGroup[])
      .map((g) => {
        const cs = CASES.filter((c) => c.group === g);
        const all = cs.every((c) => sel.has(c.id));
        return `<div class="case-group">
          <div class="gh"><span>${GROUP_NAMES[g]}</span><button data-group="${g}">${all ? 'Clear' : 'Select all'}</button></div>
          <div class="chips">${cs.map((c) => `<button class="chip" data-case="${c.id}" aria-pressed="${sel.has(c.id)}" title="${esc(c.alg)}">${c.id}</button>`).join('')}</div>
        </div>`;
      })
      .join('');
    this.el.picker.innerHTML = `<div class="dialog" role="dialog" aria-label="Choose cases">
      <header><h2>Choose cases to drill</h2><button class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button></header>
      <div class="content"><p class="muted" style="margin:0 0 16px">Numbers match your F2L case sheet. Every drill uses the front-right slot.</p><div class="case-groups">${groups}</div></div>
      <footer>
        <div style="display:flex;gap:6px"><button class="btn ghost" data-action="all-cases">Select all</button><button class="btn ghost" data-action="no-cases">Clear</button></div>
        <div style="display:flex;gap:10px;align-items:center"><span class="muted">${sel.size} selected</span><button class="btn primary" data-action="picker-done" ${sel.size ? '' : 'disabled'}>Done</button></div>
      </footer>
    </div>`;
  }

  // ---- Dialogs, settings, theme ----

  private show(scrim: HTMLElement) {
    scrim.hidden = false;
    scrim.querySelector<HTMLElement>('[data-action="close"]')?.focus();
  }

  private close(scrim: HTMLElement) {
    scrim.hidden = true;
    if (scrim === this.el.picker) {
      if (!this.prefs.drillCases.length) this.prefs.drillCases = CASES.map((c) => c.id);
      this.savePrefs();
      this.renderTopbar();
      this.newScramble();
    }
  }

  private openDialog(): HTMLElement | null {
    return [this.el.help, this.el.settings, this.el.picker, this.el.level].find((s) => !s.hidden) ?? null;
  }

  private setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings[key] = value;
    store.save('f2l.settings', this.settings);
    this.view.turnMs = this.settings.turnMs;
    this.view.greyLastLayer = this.settings.greyLL;
    if (key === 'theme') {
      this.applyTheme();
      this.renderSettings();
    }
    this.syncLLGrey();
  }

  private applyTheme() {
    const t = this.settings.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  private syncLLGrey() {
    this.view.llGrey = getComputedStyle(document.documentElement).getPropertyValue('--ll-grey').trim() || '#d4d4d8';
    this.view.refresh();
  }

  private savePrefs() {
    store.save('f2l.prefs', this.prefs);
  }

  toast(text: string) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.remove(), 2200);
  }
}

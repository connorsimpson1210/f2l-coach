import './styles.css';
import { CASES, type CaseGroup } from '../cube/cases';
import {
  FACE_NORMAL, applyAlg, dot, formatAlg, formatMove, invertAlg, parseAlg, relabelForY, simplify, solved,
  type Face, type Move, type State,
} from '../cube/model';
import { pairScramble, triggerScramble, type PairScramble } from '../cube/scramble';
import { SLOTS, isCrossSolved, solvedSlots, type SlotId } from '../cube/slots';
import { moveCost, parseRoute, routeText, rotationToken, type Route } from '../cube/solver';
import { requestRoutes } from '../cube/solverClient';
import { DEFAULT_KEYMAP, viewMove } from '../input/keyboard';
import { CubeView, type Turn, type ViewMode } from '../render/cubeView';
import { icon } from './icons';

type Mode = 'practice' | 'drill';
type Theme = 'system' | 'light' | 'dark';
type Phase = 'ready' | 'solving' | 'done';

interface Settings { turnMs: number; greyLL: boolean; theme: Theme; viewMode: ViewMode }
interface Prefs { mode: Mode; pairs: number; drillCases: number[]; myAlgs: Record<number, string> }
interface Playback { route: Route; steps: Turn[]; tokens: string[]; index: number; playing: boolean; timer: number }

const uTurn = (n: number): Move[] => (((n % 4) + 4) % 4 ? [{ face: 'U', amount: (((n % 4) + 4) % 4) as 1 | 2 | 3 }] : []);
interface HistoryEntry { turn: Turn; label: string }
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
  });
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
    help: HTMLElement; settings: HTMLElement; picker: HTMLElement;
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
    const token = ++this.routesToken;
    if (drill) {
      const keep = SLOTS.map((sl) => sl.id).filter((id) => id !== 'FR');
      requestRoutes(this.state, 'FR', keep).then((routes) => {
        if (token !== this.routesToken) return;
        this.routes = routes;
        this.renderCoach();
      });
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
    this.apply(turn);
    this.history.push({ turn, label });
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
    }
    this.renderCoach();
    this.renderBanner();
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
    `;
    const ref = (name: string) => this.root.querySelector<HTMLElement>(`[data-ref="${name}"]`)!;
    this.el = {
      stage: ref('stage'), coach: ref('coach'), scramble: ref('scramble'), banner: ref('banner'),
      scrambleBar: ref('scrambleBar'), player: ref('player'), viewSeg: ref('viewSeg'),
      modeSeg: ref('modeSeg'), pairs: ref('pairs'), drillBtn: ref('drillBtn') as HTMLButtonElement,
      help: ref('help'), settings: ref('settings'), picker: ref('picker'),
    };

    this.root.addEventListener('click', (e) => this.onClick(e));
    for (const scrim of [this.el.help, this.el.settings, this.el.picker]) {
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
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-mode], [data-case], [data-group], [data-view], [data-route]');
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
      else if (route) this.startPlayback(route);
      t.blur();
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
      ${caseHtml}
      <div class="section">
        <p class="eyebrow">${drill ? 'Slot' : 'Pairs'}</p>
        <div class="slots">${slotsHtml}</div>
      </div>
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
        const active = this.playback?.route.key === r.key;
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

  private startPlayback(route: Route) {
    if (!this.scramble) return;
    this.stopPlayback();
    this.state = this.scramble.state.slice();
    this.view.setState(this.state);
    this.view.resetView();
    this.history = [];
    this.moves = this.rotations = 0;
    this.warning = null;
    this.renderBanner();
    const steps: Turn[] = [];
    const tokens: string[] = [];
    if (route.rotation) {
      steps.push({ moves: [], view: { axis: [0, 1, 0], quarters: route.rotation === 3 ? 1 : -route.rotation } });
      tokens.push(rotationToken(route.rotation));
    }
    route.moves.forEach((m, i) => {
      steps.push({ moves: [m] });
      tokens.push(formatMove(route.seen[i]));
    });
    this.view.turnMs = Math.max(this.settings.turnMs, 300);
    this.playback = { route, steps, tokens, index: 0, playing: true, timer: 0 };
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
      this.startPlayback(pb.route);
      return;
    }
    pb.playing = !pb.playing;
    if (pb.playing) this.schedulePlayback(150);
    else clearTimeout(pb.timer);
    this.renderPlayer();
  }

  /** Leave playback; with `reset`, put the case back so you can try it yourself. */
  private stopPlayback(reset = false) {
    const pb = this.playback;
    if (!pb) return;
    clearTimeout(pb.timer);
    this.playback = null;
    this.view.turnMs = this.settings.turnMs;
    if (reset && this.scramble) {
      this.state = this.scramble.state.slice();
      this.view.setState(this.state);
      this.view.resetView();
      this.history = [];
      this.splits = [];
      this.phase = 'ready';
      this.moves = this.rotations = 0;
      this.startedAt = this.endedAt = 0;
      this.warning = null;
      this.renderBanner();
    }
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
      .map((t, i) => `<span class="${i < pb.index ? 'done' : i === pb.index ? 'next' : ''}">${esc(t)}</span>`)
      .join('');
    const finished = pb.index >= pb.steps.length;
    this.el.player.innerHTML = `
      <div class="player-head">
        <span class="player-label">${icon('play', 13)} ${esc(pb.route.label)}</span>
        <span class="subtle mono">${pb.index} / ${pb.steps.length}</span>
      </div>
      <div class="player-alg">${tokens}</div>
      <div class="player-controls">
        <button class="icon-btn" data-action="pb-prev" title="Step back (,)" aria-label="Step back">${icon('chevron-left')}</button>
        <button class="btn primary" data-action="pb-play" style="min-width:104px">${icon(pb.playing ? 'pause' : finished ? 'rotate' : 'play', 14)} ${pb.playing ? 'Pause' : finished ? 'Replay' : 'Play'} <kbd>Space</kbd></button>
        <button class="icon-btn" data-action="pb-next" title="Step forward (.)" aria-label="Step forward">${icon('chevron-right')}</button>
        <div style="flex:1"></div>
        <button class="btn" data-action="pb-exit">Try it yourself <kbd>Enter</kbd></button>
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
    const playback: [string, string][] = [['Space', 'Play / pause'], [', .', 'Step back / forward'], ['Enter', 'Try it yourself']];
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
    return [this.el.help, this.el.settings, this.el.picker].find((s) => !s.hidden) ?? null;
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

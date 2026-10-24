import './styles.css';
import { CASES, type CaseGroup } from '../cube/cases';
import {
  FACE_NORMAL, applyAlg, dot, formatAlg, formatMove, invertAlg, simplify, solved, type Face, type Move, type State,
} from '../cube/model';
import { pairScramble, triggerScramble, type PairScramble } from '../cube/scramble';
import { SLOTS, isCrossSolved, solvedSlots, type SlotId } from '../cube/slots';
import { DEFAULT_KEYMAP, viewMove } from '../input/keyboard';
import { CubeView, type Turn } from '../render/cubeView';
import { icon } from './icons';

type Mode = 'practice' | 'drill';
type Theme = 'system' | 'light' | 'dark';
type Phase = 'ready' | 'solving' | 'done';

interface Settings { turnMs: number; greyLL: boolean; theme: Theme }
interface Prefs { mode: Mode; pairs: number; drillCases: number[] }
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
  private settings: Settings = store.load('f2l.settings', { turnMs: 140, greyLL: true, theme: 'system' as Theme });
  private prefs: Prefs = store.load('f2l.prefs', { mode: 'practice' as Mode, pairs: 1, drillCases: CASES.map((c) => c.id) });

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
    modeSeg: HTMLElement; pairs: HTMLElement; drillBtn: HTMLButtonElement;
    help: HTMLElement; settings: HTMLElement; picker: HTMLElement;
  };

  constructor(private root: HTMLElement) {
    this.applyTheme();
    this.renderShell();
    this.view = new CubeView(this.el.stage);
    this.view.turnMs = this.settings.turnMs;
    this.view.greyLastLayer = this.settings.greyLL;
    this.syncLLGrey();
    this.view.onTurn = (turn) => this.turn(turn);
    this.bindKeys();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.syncLLGrey());
    this.newScramble();
    this.tickTimer();
  }

  // ---- Session ----

  private newScramble() {
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
    this.renderScramble();
    this.renderCoach();
    this.renderBanner();
  }

  private turn(turn: Turn, label = this.labelFor(turn)) {
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

  /** Sheet solution for a drill: undo the final AUF, then the case algorithm. */
  private drillSolution(): Move[] {
    const moves = simplify(invertAlg(this.scramble?.moves ?? []));
    while (moves.length && moves[moves.length - 1].face === 'U') moves.pop();
    return moves;
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

      switch (e.key) {
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
            <span>${icon('move', 14)} Drag background to orbit</span>
            <span>${icon('pointer', 14)} Drag a sticker to turn</span>
            <span><kbd>Esc</kbd> reset view</span>
          </div>
          <div class="banner" data-ref="banner" hidden></div>
          <div class="scramble-bar">
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
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-mode], [data-case], [data-group]');
    if (!t) return;
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
      const c = CASES.find((x) => x.id === this.scramble!.cases[0]?.caseId);
      const sol = this.drillSolution();
      if (c) {
        caseHtml = `<div class="section">
          <p class="eyebrow">Case</p>
          <div class="case-card">
            <div class="head">
              <span class="num ${this.revealed ? '' : 'hidden-alg'}">#${c.id}</span>
              <span class="group">${this.revealed ? GROUP_NAMES[c.group] : 'Hidden until you solve'}</span>
            </div>
            <div class="body">
              <div><div class="row-label">Sheet algorithm</div><div class="alg ${this.revealed ? '' : 'hidden-alg'}">${esc(c.alg)}</div></div>
              <div><div class="row-label">From this position (${sol.length} moves)</div><div class="alg ${this.revealed ? '' : 'hidden-alg'}">${esc(formatAlg(sol))}</div></div>
              ${this.revealed ? '' : `<button class="btn" data-action="reveal">${icon('eye', 15)} Show answer <kbd>Enter</kbd></button>`}
            </div>
          </div>
        </div>`;
      }
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
      ['Space', 'New scramble'], ['Enter', 'Show answer / next'], ['⌫', 'Undo'], ['Esc', 'Reset view'], ['?', 'This help'],
    ];
    return `<div class="dialog" role="dialog" aria-label="Shortcuts">
      <header><h2>Keyboard shortcuts</h2><button class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button></header>
      <div class="content">
        <div class="help-section"><h3>Turns (relative to what you see)</h3><div class="keys">${keyRows}</div></div>
        <div class="help-section"><h3>Actions</h3><div class="keys">${actions.map(([k, l]) => `<div><span>${l}</span><kbd>${k}</kbd></div>`).join('')}</div></div>
        <div class="help-section"><h3>Mouse</h3><p class="muted" style="margin:0">Drag a sticker to turn its layer. Drag the background to orbit.</p></div>
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

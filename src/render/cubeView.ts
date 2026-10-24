import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  FACES, FACE_NORMAL, STICKERS, applyAlg, colorAt, cross, dot, faceByNormal, solved,
  type Face, type Move, type State, type Vec3,
} from '../cube/model';
import { isLastLayerSticker } from '../cube/slots';

/** One queued action: logical face turns plus an optional change of view (whole-cube rotation). */
export interface Turn {
  moves: Move[];
  view?: { axis: Vec3; quarters: number };
}

export const STICKER_COLORS: Record<Face, string> = {
  U: '#ffd500',
  R: '#ff6a13',
  F: '#00a651',
  D: '#f4f4f5',
  L: '#dc2626',
  B: '#1d5bd6',
};

export type ViewMode = 'orbit' | 'snap';

const DEG = Math.PI / 180;
const HOME_YAW = -35 * DEG;
const HOME_PITCH = 26 * DEG;
const SNAP_PITCH = 27 * DEG;
/** Two angles per side: each side seen slightly from its left or its right (yaw 0 = green front). */
export const SNAP_YAWS = [60, 30, -30, -60, -120, -150, -210, -240].map((d) => d * DEG);
const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
const quartersFor = (amount: 1 | 2 | 3) => (amount === 3 ? 1 : -amount);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

interface Running {
  turn: Turn | null;
  start: number;
  duration: number;
  pivots: { group: THREE.Group; axis: THREE.Vector3; angle: number }[];
}

export class CubeView {
  readonly canvas: HTMLCanvasElement;
  /** Called when the user drags a sticker to turn a layer. */
  onTurn: (turn: Turn) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private root = new THREE.Group();
  private cubies: { pos: Vec3; obj: THREE.Group }[] = [];
  private stickers: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshStandardMaterial>[] = [];
  private queue: Turn[] = [];
  private running: Running | null = null;
  private display: State = solved();
  /** Turntable view: white always stays on the bottom. viewYaw includes queued y rotations. */
  private yaw = HOME_YAW;
  private viewYaw = HOME_YAW;
  private pitch = HOME_PITCH;
  private pitchTarget = HOME_PITCH;
  private mode: ViewMode = 'orbit';
  private lastFrame = 0;
  private highlight = new Set<number>();
  private raf = 0;

  turnMs = 140;
  greyLastLayer = false;
  llGrey = '#d4d4d8';

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.camera.position.set(0, 0, 11);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa6, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 6, 8);
    this.scene.add(key);
    this.scene.add(this.root);
    this.applyView();
    this.build();
    this.bindPointer();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = (now: number) => {
      this.tick(now);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }

  // ---- Public API ----

  /** Turns whose view change is a y rotation; anything else would tip white off the bottom. */
  static keepsWhiteDown(turn: Turn) {
    return !turn.view || Math.abs(turn.view.axis[1]) === 1;
  }

  enqueue(turn: Turn) {
    if (turn.view) this.viewYaw += turn.view.quarters * turn.view.axis[1] * (Math.PI / 2);
    this.queue.push(turn);
  }

  /** Jump straight to a state, dropping any queued animation. */
  setState(s: State) {
    this.finishRunning();
    this.queue = [];
    this.display = s.slice();
    this.recolor();
  }

  /** Animate back to the standard view: white bottom, green front, seen from the top-right. */
  resetView() {
    this.viewYaw = this.nearest(this.mode === 'snap' ? -30 * DEG : HOME_YAW);
    this.pitchTarget = this.mode === 'snap' ? SNAP_PITCH : HOME_PITCH;
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    if (mode === 'snap') {
      this.pitchTarget = SNAP_PITCH;
      this.snapNearest();
    }
  }

  /** Step through the snap angles: +1 moves the view to the right, -1 to the left. */
  stepView(dir: 1 | -1) {
    const candidates = SNAP_YAWS.flatMap((y) => [-2, -1, 0, 1, 2].map((m) => y + m * 2 * Math.PI));
    const ahead = candidates.filter((y) => (dir === 1 ? y < this.viewYaw - 0.05 : y > this.viewYaw + 0.05));
    this.viewYaw = dir === 1 ? Math.max(...ahead) : Math.min(...ahead);
    this.pitchTarget = SNAP_PITCH;
  }

  get viewMode() {
    return this.mode;
  }

  /** The logical face currently seen in a direction (+x = screen right, +y = up, +z = towards you). */
  seenFace(dir: Vec3): Face {
    if (dir[1]) return dir[1] > 0 ? 'U' : 'D';
    const c = Math.cos(this.viewYaw);
    const sn = Math.sin(this.viewYaw);
    let best: Face = 'F';
    let bestDot = -Infinity;
    for (const f of FACES) {
      const [x, , z] = FACE_NORMAL[f];
      const w = (x * c + z * sn) * dir[0] + (-x * sn + z * c) * dir[2];
      if (w > bestDot) [best, bestDot] = [f, w];
    }
    return best;
  }

  private nearest(yaw: number) {
    const k = Math.round((this.viewYaw - yaw) / (2 * Math.PI));
    return yaw + k * 2 * Math.PI;
  }

  private snapNearest() {
    const candidates = SNAP_YAWS.map((y) => this.nearest(y));
    this.viewYaw = candidates.reduce((a, b) => (Math.abs(b - this.viewYaw) < Math.abs(a - this.viewYaw) ? b : a));
  }

  private applyView() {
    this.root.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'XYZ'));
  }

  setHighlight(locs: Iterable<number>) {
    this.highlight = new Set(locs);
    this.recolor();
  }

  refresh() {
    this.recolor();
  }

  get busy() {
    return this.running !== null || this.queue.length > 0;
  }

  // ---- Scene ----

  private build() {
    const body = new RoundedBoxGeometry(0.97, 0.97, 0.97, 3, 0.09);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.55, metalness: 0.05 });
    const sticker = roundedSquare(0.84, 0.13);
    const byPos = new Map<string, THREE.Group>();

    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          if (!x && !y && !z) continue;
          const obj = new THREE.Group();
          obj.position.set(x, y, z);
          obj.add(new THREE.Mesh(body, bodyMat));
          this.root.add(obj);
          this.cubies.push({ pos: [x, y, z], obj });
          byPos.set(`${x},${y},${z}`, obj);
        }

    STICKERS.forEach((s, loc) => {
      const mesh = new THREE.Mesh(sticker, new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0 }));
      const n = v3(s.normal);
      mesh.position.copy(n.clone().multiplyScalar(0.488));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      mesh.userData.loc = loc;
      byPos.get(s.pos.join(','))!.add(mesh);
      this.stickers[loc] = mesh;
    });
    this.recolor();
  }

  private recolor() {
    this.stickers.forEach((mesh, loc) => {
      const home = this.display[loc];
      const grey = this.greyLastLayer && isLastLayerSticker(home);
      mesh.material.color.set(grey ? this.llGrey : STICKER_COLORS[colorAt(this.display, loc)]);
      mesh.material.emissive.set(this.highlight.has(loc) ? 0x3b82f6 : 0x000000);
      mesh.material.emissiveIntensity = this.highlight.has(loc) ? 0.55 : 0;
    });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole cube in frame on narrow screens too.
    const fit = 7.4 / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.position.set(0, -0.35, Math.max(fit, fit / Math.min(1, this.camera.aspect)));
    this.camera.updateProjectionMatrix();
  }

  // ---- Animation ----

  private tick(now: number) {
    const dt = Math.min(64, now - (this.lastFrame || now));
    this.lastFrame = now;
    const k = 1 - Math.exp(-dt / Math.max(30, this.turnMs / 2.2));
    this.yaw += (this.viewYaw - this.yaw) * k;
    this.pitch += (this.pitchTarget - this.pitch) * k;
    this.applyView();

    if (!this.running && this.queue.length) this.startNext(now);
    const r = this.running;
    if (!r) return;
    const t = Math.min(1, (now - r.start) / r.duration);
    const e = ease(t);
    for (const p of r.pivots) p.group.quaternion.setFromAxisAngle(p.axis, p.angle * e);
    if (t >= 1) this.finishRunning();
  }

  private startNext(now: number) {
    const item = this.queue.shift()!;
    const backlog = this.queue.length;
    const duration = backlog ? Math.max(35, this.turnMs / (1 + backlog)) : this.turnMs;
    const pivots = item.moves.map((m) => {
      const normal = FACE_NORMAL[m.face];
      const group = new THREE.Group();
      this.root.add(group);
      for (const c of this.cubies) if (dot(c.pos, normal) === 1) group.add(c.obj);
      return { group, axis: v3(normal), angle: (quartersFor(m.amount) * Math.PI) / 2 };
    });
    this.running = { turn: item, start: now, duration, pivots };
  }

  private finishRunning() {
    const r = this.running;
    if (!r) return;
    this.running = null;
    for (const p of r.pivots) {
      p.group.quaternion.identity();
      for (const child of [...p.group.children]) this.root.add(child);
      this.root.remove(p.group);
    }
    if (r.turn) {
      this.display = applyAlg(this.display, r.turn.moves);
      this.recolor();
    }
  }

  // ---- Pointer: drag a sticker to turn, drag the background to orbit ----

  private bindPointer() {
    const ray = new THREE.Raycaster();
    let mode: 'none' | 'orbit' | 'sticker' = 'none';
    let last = { x: 0, y: 0 };
    let downAt = { x: 0, y: 0 };
    let hitLoc = -1;

    const ndc = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      last = downAt = { x: e.clientX, y: e.clientY };
      ray.setFromCamera(ndc(e), this.camera);
      const hit = this.running || this.queue.length ? undefined : ray.intersectObjects(this.stickers, false)[0];
      if (hit) {
        mode = 'sticker';
        hitLoc = hit.object.userData.loc;
      } else {
        mode = 'orbit';
        this.canvas.classList.add('grabbing');
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (mode === 'orbit') {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        this.viewYaw += dx * 0.009;
        this.yaw += dx * 0.009;
        if (this.mode === 'orbit') {
          this.pitchTarget = Math.min(70 * DEG, Math.max(5 * DEG, this.pitchTarget + dy * 0.006));
          this.pitch = this.pitchTarget;
        }
      } else if (mode === 'sticker') {
        const dx = e.clientX - downAt.x;
        const dy = e.clientY - downAt.y;
        if (Math.hypot(dx, dy) < 14) return;
        mode = 'none';
        const turn = this.dragTurn(hitLoc, dx, dy);
        if (turn) this.onTurn(turn);
      }
    });

    const end = () => {
      if (mode === 'orbit' && this.mode === 'snap') this.snapNearest();
      mode = 'none';
      this.canvas.classList.remove('grabbing');
    };
    let wheel = 0;
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.mode === 'orbit') {
          this.viewYaw -= e.deltaY * 0.004;
          return;
        }
        wheel += e.deltaY;
        if (Math.abs(wheel) >= 60) {
          this.stepView(wheel > 0 ? 1 : -1);
          wheel = 0;
        }
      },
      { passive: false },
    );
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  private dragTurn(loc: number, dx: number, dy: number): Turn | null {
    const { pos, normal } = STICKERS[loc];
    const drag = new THREE.Vector3(dx, -dy, 0).applyQuaternion(this.root.quaternion.clone().invert());
    // Snap the drag to the face axis it is closest to.
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    let d: Vec3 | null = null;
    let best = 0;
    for (const a of axes) {
      if (dot(a, normal) !== 0) continue;
      const p = drag.dot(v3(a));
      if (Math.abs(p) > best) [best, d] = [Math.abs(p), p > 0 ? a : neg(a)];
    }
    if (!d) return null;
    // A +90° turn about `axis` moves this sticker along the drag.
    const axis = cross(normal, d);
    const layer = dot(pos, axis);
    if (layer === 1) return { moves: [{ face: faceByNormal(axis), amount: 3 }] };
    if (layer === -1) return { moves: [{ face: faceByNormal(neg(axis)), amount: 1 }] };
    return {
      moves: [
        { face: faceByNormal(axis), amount: 1 },
        { face: faceByNormal(neg(axis)), amount: 3 },
      ],
      view: { axis, quarters: 1 },
    };
  }
}

function roundedSquare(size: number, r: number) {
  const h = size / 2;
  const s = new THREE.Shape();
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);
  s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r);
  s.quadraticCurveTo(-h, -h, -h + r, -h);
  return new THREE.ShapeGeometry(s, 6);
}

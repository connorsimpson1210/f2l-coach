import type { Weights } from '../coach/levels';
import type { PairOption } from '../coach/planner';
import type { State } from './model';
import type { SlotId } from './slots';
import type { Route } from './solver';
import type { OptionsJob, WorkerRequest } from './solver.worker';

type Body<K> = K extends WorkerRequest['kind'] ? Omit<Extract<WorkerRequest, { kind: K }>, 'id'> : never;

const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (result: unknown) => void>();
let nextId = 1;

worker.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
  pending.get(e.data.id)?.(e.data.result);
  pending.delete(e.data.id);
};
worker.postMessage('warm');

function call<T>(body: Body<WorkerRequest['kind']>): Promise<T> {
  const id = nextId++;
  worker.postMessage({ id, ...body });
  return new Promise((resolve) => pending.set(id, resolve as (r: unknown) => void));
}

/** Solve one slot in the background, keeping the cross and the listed slots intact. */
export function requestRoutes(state: State, target: SlotId, keep: SlotId[]): Promise<Route[]> {
  return call({ kind: 'routes', state: Array.from(state), target, keep });
}

/** Best option per open pair at each position (one list per job). */
export function requestOptions(jobs: { state: State; view: number; targets: SlotId[]; keep: SlotId[] }[], weights: Weights) {
  const plain: OptionsJob[] = jobs.map((j) => ({ ...j, state: Array.from(j.state) }));
  return call<PairOption[][]>({ kind: 'options', jobs: plain, weights });
}

/** The benchmark solve for the whole position, pair by pair. */
export function requestPlan(state: State, view: number, weights: Weights) {
  return call<PairOption[]>({ kind: 'plan', state: Array.from(state), view, weights });
}

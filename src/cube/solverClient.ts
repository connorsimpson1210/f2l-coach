import type { State } from './model';
import type { SlotId } from './slots';
import type { Route } from './solver';
import type { RoutesRequest } from './solver.worker';

const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (routes: Route[]) => void>();
let nextId = 1;

worker.onmessage = (e: MessageEvent<{ id: number; routes: Route[] }>) => {
  pending.get(e.data.id)?.(e.data.routes);
  pending.delete(e.data.id);
};
worker.postMessage('warm');

/** Solve one slot in the background, keeping the cross and the listed slots intact. */
export function requestRoutes(state: State, target: SlotId, keep: SlotId[]): Promise<Route[]> {
  const id = nextId++;
  const msg: RoutesRequest = { id, state: Array.from(state), target, keep };
  worker.postMessage(msg);
  return new Promise((resolve) => pending.set(id, resolve));
}

import { findRoutes, warmUp } from './solver';
import type { SlotId } from './slots';

export interface RoutesRequest { id: number; state: number[]; target: SlotId; keep: SlotId[] }

self.onmessage = (e: MessageEvent<RoutesRequest | 'warm'>) => {
  if (e.data === 'warm') {
    warmUp();
    return;
  }
  const { id, state, target, keep } = e.data;
  const routes = findRoutes(Uint8Array.from(state), target, keep);
  self.postMessage({ id, routes });
};

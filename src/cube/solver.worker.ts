import { pairOptions, planSolve } from '../coach/planner';
import type { Weights } from '../coach/levels';
import { findRoutes, warmUp } from './solver';
import type { SlotId } from './slots';

export interface OptionsJob { state: number[]; view: number; targets: SlotId[]; keep: SlotId[] }

export type WorkerRequest =
  | { id: number; kind: 'routes'; state: number[]; target: SlotId; keep: SlotId[] }
  | { id: number; kind: 'options'; jobs: OptionsJob[]; weights: Weights }
  | { id: number; kind: 'plan'; state: number[]; view: number; weights: Weights };

self.onmessage = (e: MessageEvent<WorkerRequest | 'warm'>) => {
  if (e.data === 'warm') {
    warmUp();
    return;
  }
  const req = e.data;
  let result: unknown;
  if (req.kind === 'routes') result = findRoutes(Uint8Array.from(req.state), req.target, req.keep);
  else if (req.kind === 'options') {
    result = req.jobs.map((j) => pairOptions(Uint8Array.from(j.state), j.view, j.targets, j.keep, req.weights));
  } else result = planSolve(Uint8Array.from(req.state), req.view, req.weights);
  self.postMessage({ id: req.id, result });
};

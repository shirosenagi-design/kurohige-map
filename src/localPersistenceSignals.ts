import type { PersistedProductState } from './productState.ts';
import type { PersistedWorldSnapshotV1 } from './worldState.ts';

export type LocalPersistenceSignal =
  | { kind: 'product'; persistedAt: string; snapshot: PersistedProductState }
  | { kind: 'world'; persistedAt: string; snapshot: PersistedWorldSnapshotV1 };

type Listener = (signal: LocalPersistenceSignal) => void;
const listeners = new Set<Listener>();

export function subscribeToLocalPersistence(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyProductStatePersisted(snapshot: PersistedProductState): void {
  const signal: LocalPersistenceSignal = {
    kind: 'product',
    persistedAt: new Date().toISOString(),
    snapshot: structuredClone(snapshot),
  };
  for (const listener of listeners) listener(signal);
}

export function notifyWorldPersisted(snapshot: PersistedWorldSnapshotV1): void {
  const signal: LocalPersistenceSignal = {
    kind: 'world',
    persistedAt: new Date().toISOString(),
    snapshot: structuredClone(snapshot),
  };
  for (const listener of listeners) listener(signal);
}

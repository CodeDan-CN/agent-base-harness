import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeProjection } from '@client-contracts';
import { query, requireClient, userMessage } from './client';
import { applyEventBatch, hydrateProjection } from './projection';
import type { SessionSnapshotPayload } from './types';

export function useSessionProjection(sessionId: string | null) {
  const [state, setState] = useState<{
    sessionId: string | null;
    projection: RuntimeProjection | null;
    status: 'loading' | 'ready' | 'error';
    error: string | null;
  }>({ sessionId, projection: null, status: 'loading', error: null });
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;
    const connect = async () => {
      const current = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      setState({ sessionId, projection: null, status: 'loading', error: null });
      try {
        const snapshot = await query<SessionSnapshotPayload>('session.snapshot', { sessionId });
        if (!active || generation !== current) return;
        cursor.current = snapshot.throughSeq;
        setState({
          sessionId,
          projection: hydrateProjection(snapshot),
          status: 'ready',
          error: null,
        });
        unsubscribe = requireClient().subscribeSession(sessionId, cursor.current, (event) => {
          if (!active || generation !== current) return;
          if (event.type === 'events' && event.toSeq <= cursor.current) return;
          if (event.type === 'resync-required' || event.fromSeq !== cursor.current + 1) {
            void connect();
            return;
          }
          cursor.current = event.toSeq;
          setState((previous) => ({
            ...previous,
            projection: previous.projection
              ? applyEventBatch(previous.projection, event.events)
              : null,
          }));
        });
      } catch (cause) {
        if (active && generation === current)
          setState({ sessionId, projection: null, status: 'error', error: userMessage(cause) });
      }
    };
    void connect();
    const stopLifecycle = requireClient().subscribeLifecycle((event) => {
      if (event.type === 'runtime' && event.status === 'ready') void connect();
    });
    return () => {
      active = false;
      generation++;
      unsubscribe?.();
      stopLifecycle();
    };
  }, [sessionId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    ...(state.sessionId === sessionId && sessionId
      ? state
      : { projection: null, status: 'loading' as const, error: null }),
    retry,
  };
}

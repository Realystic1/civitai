import { useEffect, useMemo, useRef, useState } from 'react';
import SharedWorker from '@okikio/sharedworker';
import type { WorkerOutgoingMessage } from './types';
import { Deferred, EventEmitter } from './utils';

export type SignalStatus = 'connected' | 'closed' | 'error' | 'reconnected' | 'reconnecting';
export type SignalWorker = ReturnType<typeof useSignalsWorker>;
type SignalState = {
  status: SignalStatus;
  message?: string;
};

const logs: Record<string, boolean> = {};

export function useSignalsWorker(
  args: { accessToken?: string },
  options?: {
    onConnected?: () => void;
    onReconnected?: () => void;
    onReconnecting?: () => void;
    /** A closed connection will not recover on its own. */
    onClosed?: (message?: string) => void;
    onError?: (message?: string) => void;
    onStatusChange?: (args: SignalState) => void;
  }
) {
  const { accessToken } = args;
  const { onConnected, onClosed, onError, onReconnected, onReconnecting, onStatusChange } =
    options ?? {};

  const [state, setState] = useState<SignalState>();
  const [ready, setReady] = useState(false);
  const [worker, setWorker] = useState<SharedWorker | null>(null);

  const emitterRef = useRef(new EventEmitter());
  const deferredRef = useRef(new Deferred());

  // handle init worker
  useEffect(() => {
    if (worker) return;
    setReady(false);
    setWorker(
      new SharedWorker(new URL('./worker.v1.2.ts', import.meta.url), {
        name: 'civitai-signals:1.2.3',
        type: 'module',
      })
    );
  }, [worker]);

  // handle register worker events
  useEffect(() => {
    if (!worker) return;

    worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
      if (data.type === 'worker:ready') setReady(true);
      else if (data.type === 'connection:ready')
        setState((prev) => {
          if (prev?.status === 'closed' || prev?.status === 'error')
            return { status: 'reconnected' };
          else return { status: 'connected' };
        });
      else if (data.type === 'connection:closed')
        setState({ status: 'closed', message: data.message });
      else if (data.type === 'connection:error')
        setState({ status: 'error', message: data.message });
      else if (data.type === 'connection:reconnected') setState({ status: 'reconnected' });
      else if (data.type === 'connection:reconnecting') setState({ status: 'reconnecting' });
      else if (data.type === 'event:received') emitterRef.current.emit(data.target, data.payload);
      else if (data.type === 'pong') deferredRef.current.resolve();
    };
  }, [worker]);

  useEffect(() => {
    if (!state) return;
    console.debug(`SignalService :: ${state.status}`);
    onStatusChange?.(state);
    switch (state.status) {
      case 'connected':
        return onConnected?.();
      case 'reconnected':
        return onReconnected?.();
      case 'reconnecting':
        return onReconnecting?.();
      case 'closed':
        return onClosed?.(state.message);
      case 'error':
        return onError?.(state.message);
    }
  }, [state]);

  // ping
  useEffect(() => {
    function handleVisibilityChange() {
      deferredRef.current = new Deferred();
      worker?.port.postMessage({ type: 'ping' });
      const timeout = setTimeout(() => deferredRef.current.reject(), 1000);
      deferredRef.current.promise
        .then(() => {
          clearTimeout(timeout);
          setReady(true);
        })
        .catch(() => {
          setReady(false);
          setState({ status: 'closed', message: 'connection to shared worker lost' });
        });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [worker]);

  // handle tab close
  useEffect(() => {
    function unload() {
      worker?.port.postMessage({ type: 'beforeunload' });
      emitterRef.current.stop();
    }

    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('beforeunload', unload);
    };
  }, []);

  // init
  useEffect(() => {
    if (worker && ready && accessToken)
      worker.port.postMessage({ type: 'connection:init', token: accessToken });
  }, [worker, accessToken, ready]);

  // poll to reconnect
  const timerRef = useRef<NodeJS.Timer | null>(null);
  const disconnected = !state?.status || state.status === 'closed' || state.status === 'error';
  useEffect(() => {
    if (!disconnected && timerRef.current) clearInterval(timerRef.current);
    else if (disconnected && accessToken && worker && ready) {
      timerRef.current = setInterval(() => {
        console.log('attempting to reconnect to signal services');
        worker.port.postMessage({ type: 'connection:init', token: accessToken });
      }, 30 * 1000);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [disconnected, accessToken, worker, ready]);

  const hasRunRef = useRef(false);
  return useMemo(() => {
    function send(target: string, args: Record<string, unknown>) {
      worker?.port.postMessage({ type: 'send', target, args });
    }

    function on(target: string, cb: (data: unknown) => void) {
      worker?.port.postMessage({ type: 'event:register', target });
      emitterRef.current.on(target, cb);
    }

    function off(target: string, cb: (data: unknown) => void) {
      emitterRef.current.off(target, cb);
    }

    if (!hasRunRef.current) {
      hasRunRef.current = true;
      if (typeof window !== 'undefined') {
        window.logSignal = (target, selector) => {
          function logFn(args: unknown) {
            if (selector) {
              const result = [args].find(selector);
              if (result) console.log(result);
            } else console.log(args);
          }

          if (!logs[target]) {
            logs[target] = true;
            on(target, logFn);
            console.log(`begin logging: ${target}`);
          }
        };

        window.ping = () => {
          window.logSignal('pong');
          worker?.port.postMessage({ type: 'ping' });
        };
      }
    }

    return {
      on,
      off,
      send,
    };
  }, [worker]);
}

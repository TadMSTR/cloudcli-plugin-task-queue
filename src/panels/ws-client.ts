/**
 * WebSocket client with auto-reconnect for live task queue updates.
 * Connects through CloudCLI's plugin WebSocket proxy at /plugin-ws/task-queue.
 */

export type WsEvent = {
  type: string;
  [key: string]: unknown;
};

export type WsListener = (event: WsEvent) => void;

export interface WsClient {
  readonly connected: boolean;
  onEvent(listener: WsListener): () => void;
  close(): void;
}

export function createWsClient(): WsClient {
  const listeners = new Set<WsListener>();
  let ws: WebSocket | null = null;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function getWsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/plugin-ws/task-queue`;
  }

  function emit(event: WsEvent): void {
    for (const l of listeners) {
      try { l(event); } catch { /* skip */ }
    }
  }

  function connect(): void {
    if (closed) return;
    try {
      ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        connected = true;
        emit({ type: '_connected' });
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as WsEvent;
          emit(data);
        } catch { /* skip unparseable */ }
      };

      ws.onclose = () => {
        connected = false;
        emit({ type: '_disconnected' });
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  }

  connect();

  return {
    get connected() { return connected; },

    onEvent(listener: WsListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}

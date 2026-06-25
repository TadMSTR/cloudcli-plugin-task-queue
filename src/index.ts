import type { PluginAPI, PluginContext, Task, ThemeColors } from './types.js';
import { themeColors, injectGlobalStyles, MONO } from './panels/styles.js';
import { renderTaskList } from './panels/task-list.js';
import { renderTaskDetail } from './panels/task-detail.js';
import { createWsClient, WsClient } from './panels/ws-client.js';

// ── State ──────────────────────────────────────────────────────────────

interface AppState {
  tasks: Task[];
  selectedTaskId: string | null;
  selectedTask: Task | null;
  contextPreviews: Map<string, string>;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;
  filters: { agent: string; status: string; taskType: string };
}

// ── Mount ──────────────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  injectGlobalStyles();

  const state: AppState = {
    tasks: [],
    selectedTaskId: null,
    selectedTask: null,
    contextPreviews: new Map(),
    loading: true,
    error: null,
    wsConnected: false,
    filters: { agent: '', status: '', taskType: '' },
  };

  let wsClient: WsClient | null = null;
  let unsubCtx: (() => void) | null = null;

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '24px',
    fontFamily: MONO,
  });
  container.appendChild(root);

  // Debounce WS-triggered refreshes
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedRefresh(delayMs = 2000): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      loadTasks();
    }, delayMs);
  }

  // ── Data loading ──────────────────────────────────────────────────

  async function loadTasks(): Promise<void> {
    try {
      const res = await api.rpc('GET', 'tasks') as { tasks: Task[] };
      state.tasks = res.tasks ?? [];
      state.error = null;
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
  }

  async function loadTaskDetail(taskId: string): Promise<void> {
    try {
      const res = await api.rpc('GET', `tasks/${taskId}`) as { task: Task; previews: Record<string, string | null> };
      state.selectedTask = res.task;
      state.contextPreviews = new Map();
      if (res.previews) {
        for (const [k, v] of Object.entries(res.previews)) {
          if (v) state.contextPreviews.set(k, v);
        }
      }
    } catch (err) {
      state.error = (err as Error).message;
    }
    render(api.context);
  }

  async function handleApprove(taskId: string): Promise<void> {
    try {
      await api.rpc('POST', `tasks/${taskId}/approve`);
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleStart(taskId: string, mode: 'review' | 'auto'): Promise<void> {
    try {
      await api.rpc('POST', `tasks/${taskId}/start`, { mode });
      state.error = null;
      // Brief feedback
      showToast(`Session launched (${mode} mode)`);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleCancel(taskId: string): Promise<void> {
    if (!confirm('Cancel this task? It becomes a terminal record — recoverable as a record, never deleted.')) return;
    try {
      await api.rpc('POST', `tasks/${taskId}/cancel`, { note: 'Cancelled via CloudCLI' });
      state.error = null;
      showToast('Task cancelled');
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleQuarantine(taskId: string): Promise<void> {
    if (!confirm('Quarantine (isolate) this task? It drops from the list but can be restored.')) return;
    try {
      await api.rpc('POST', `tasks/${taskId}/quarantine`, { note: 'Quarantined via CloudCLI' });
      state.error = null;
      showToast('Task quarantined');
      // The task is now hidden; return to the list if we were viewing it.
      if (state.selectedTaskId === taskId) {
        state.selectedTaskId = null;
        state.selectedTask = null;
      }
      await loadTasks();
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleSetStatus(taskId: string, status: string): Promise<void> {
    try {
      await api.rpc('POST', `tasks/${taskId}/status`, {
        status,
        note: 'Status changed via CloudCLI',
        allow_override: true,
      });
      state.error = null;
      showToast(`Status set to ${status}`);
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  function showToast(message: string): void {
    const toast = document.createElement('div');
    const c = themeColors(api.context.theme === 'dark');
    Object.assign(toast.style, {
      position: 'fixed', bottom: '20px', right: '20px',
      background: c.surface, color: c.ok, border: `1px solid ${c.ok}`,
      padding: '8px 16px', borderRadius: '4px', fontSize: '12px',
      fontFamily: MONO, zIndex: '9999',
    });
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Render ────────────────────────────────────────────────────────

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = '';

    // Header
    renderHeader(root, c);

    if (state.loading) {
      const loading = document.createElement('div');
      loading.style.cssText = `color:${c.muted};text-align:center;padding:32px;font-size:13px;`;
      loading.textContent = 'Loading...';
      root.appendChild(loading);
      return;
    }

    if (state.error) {
      const err = document.createElement('div');
      err.style.cssText = `color:${c.error};padding:8px 12px;margin-bottom:12px;font-size:12px;background:${c.surface};border:1px solid ${c.error};border-radius:4px;`;
      err.textContent = state.error;
      root.appendChild(err);
    }

    // Detail view or list view
    if (state.selectedTaskId && state.selectedTask) {
      renderTaskDetail(root, {
        task: state.selectedTask,
        contextPreviews: state.contextPreviews,
        colors: c,
        onBack: () => {
          state.selectedTaskId = null;
          state.selectedTask = null;
          state.contextPreviews = new Map();
          render(ctx);
        },
        onApprove: handleApprove,
        onStart: handleStart,
        onCancel: handleCancel,
        onQuarantine: handleQuarantine,
        onSetStatus: handleSetStatus,
      });
    } else {
      const listContainer = document.createElement('div');
      root.appendChild(listContainer);

      renderTaskList(listContainer, {
        tasks: state.tasks,
        colors: c,
        filters: state.filters,
        onFilterChange: (f) => {
          state.filters = f;
          render(ctx);
        },
        onSelect: (taskId) => {
          state.selectedTaskId = taskId;
          loadTaskDetail(taskId);
        },
        onApprove: handleApprove,
        onStart: handleStart,
        onCancel: handleCancel,
        onQuarantine: handleQuarantine,
        onSetStatus: handleSetStatus,
      });
    }
  }

  function renderHeader(parent: HTMLElement, c: ThemeColors): void {
    const header = document.createElement('div');
    header.style.cssText = `display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid ${c.border};`;

    const wsColor = state.wsConnected ? c.ok : c.muted;
    const wsDot = state.wsConnected
      ? `<span class="tq-live" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${wsColor}"></span>`
      : `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${wsColor}"></span>`;

    header.innerHTML = `
      <span style="font-size:14px;font-weight:600;color:${c.accent}">Task Queue</span>
      <span style="color:${c.muted};font-size:11px">${state.tasks.length} tasks</span>
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
        ${wsDot}
        <span style="color:${c.muted};font-size:11px">${state.wsConnected ? 'live' : 'disconnected'}</span>
      </span>
    `;

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '\u21BB';
    Object.assign(refreshBtn.style, {
      background: 'transparent', color: c.muted, border: `1px solid ${c.border}`,
      borderRadius: '3px', padding: '2px 8px', fontSize: '14px', cursor: 'pointer',
    });
    refreshBtn.addEventListener('click', () => {
      state.loading = true;
      render(api.context);
      loadTasks();
    });
    header.appendChild(refreshBtn);

    parent.appendChild(header);
  }

  // ── WebSocket ─────────────────────────────────────────────────────

  wsClient = createWsClient();
  wsClient.onEvent((event) => {
    if (event.type === '_connected') {
      state.wsConnected = true;
      render(api.context);
    } else if (event.type === '_disconnected') {
      state.wsConnected = false;
      render(api.context);
    } else if (event.type === 'tasks') {
      debouncedRefresh();
    }
  });

  // ── Context changes ───────────────────────────────────────────────

  unsubCtx = api.onContextChange((ctx) => render(ctx));

  // ── Initial load ──────────────────────────────────────────────────

  loadTasks();

  // Store cleanup ref
  (container as unknown as { _tqCleanup: () => void })._tqCleanup = () => {
    if (wsClient) wsClient.close();
    if (unsubCtx) unsubCtx();
    if (refreshTimer) clearTimeout(refreshTimer);
  };
}

export function unmount(container: HTMLElement): void {
  const cleanup = (container as unknown as { _tqCleanup?: () => void })._tqCleanup;
  if (cleanup) cleanup();
  container.innerHTML = '';
}

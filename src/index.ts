import type { PluginAPI, PluginContext, Task, ThemeColors, HeadlessRun, HeadlessRunDetail, DeadLetter } from './types.js';
import { themeColors, injectGlobalStyles, MONO } from './panels/styles.js';
import { renderTaskList } from './panels/task-list.js';
import { renderTaskDetail } from './panels/task-detail.js';
import { renderHeadlessRuns } from './panels/headless-runs.js';
import { renderDeadLetters } from './panels/dead-letters.js';
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
  headlessRuns: HeadlessRun[];
  selectedRunId: string | null;
  selectedRun: HeadlessRunDetail | null;
  runAgentFilter: string;
  deadLetters: DeadLetter[];
  /** Collapsed by default — the healthy count is zero. */
  deadLettersExpanded: boolean;
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
    headlessRuns: [],
    selectedRunId: null,
    selectedRun: null,
    runAgentFilter: '',
    deadLetters: [],
    deadLettersExpanded: false,
  };

  let wsClient: WsClient | null = null;
  let unsubCtx: (() => void) | null = null;

  // Header badge nodes, re-seated by renderHeader on every render. Mutated in place by
  // updateConnectionBadge so a connection change costs two property writes, not a repaint.
  let wsDotEl: HTMLElement | null = null;
  let wsLabelEl: HTMLElement | null = null;

  function updateConnectionBadge(): void {
    if (!wsDotEl || !wsLabelEl) return;
    const c = themeColors(api.context.theme === 'dark');
    wsDotEl.style.background = state.wsConnected ? c.ok : c.muted;
    wsDotEl.className = state.wsConnected ? 'tq-live' : '';
    wsLabelEl.textContent = state.wsConnected ? 'live' : 'disconnected';
  }

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
    await loadHeadlessRuns();
    await loadDeadLetters();
    state.loading = false;
    render(api.context);
  }

  // Runs refresh on the same cadence as the task list rather than on their own timer.
  // There is nothing to stream: `claude -p` writes its final message on exit, so a run
  // only ever changes once, and this surface is opened deliberately.
  async function loadHeadlessRuns(): Promise<void> {
    // Loaded UNFILTERED. The agent filter is applied for display in the panel, so it
    // costs no round trip and — more importantly — runForTask() can still find a task's
    // run while the section is filtered to a different agent. The route's ?agent=
    // parameter still exists for direct API use.
    try {
      const res = await api.rpc('GET', 'headless-runs') as { runs: HeadlessRun[] };
      state.headlessRuns = res.runs ?? [];
    } catch {
      // A failure here must not blank the task list — the runs section is secondary.
      state.headlessRuns = [];
    }
  }

  // Loaded on every refresh, not only when the section is expanded: the collapsed heading
  // shows the count, and a count that only appears after the operator opens the section is
  // a count nobody sees. That is the failure mode this whole surface exists to end.
  async function loadDeadLetters(): Promise<void> {
    try {
      const res = await api.rpc('GET', 'dead-letters') as { deadLetters: DeadLetter[] };
      state.deadLetters = res.deadLetters ?? [];
    } catch {
      // A failure here must not blank the task list — this section is secondary.
      state.deadLetters = [];
    }
  }

  async function loadRunDetail(id: string): Promise<void> {
    try {
      state.selectedRun = await api.rpc('GET', `headless-runs/${id}`) as HeadlessRunDetail;
      state.error = null;
    } catch (err) {
      state.selectedRunId = null;
      state.selectedRun = null;
      state.error = (err as Error).message;
    }
    render(api.context);
  }

  function openRun(id: string): void {
    state.selectedRunId = id;
    state.selectedRun = null;
    state.selectedTaskId = null;
    state.selectedTask = null;
    render(api.context);
    loadRunDetail(id);
  }

  async function handleCopyCommand(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Command copied');
    } catch {
      // Clipboard access can be refused (insecure context, permissions). Say so rather
      // than reporting a copy that did not happen.
      showToast('Copy failed — select the text manually');
    }
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
      const res = await api.rpc('POST', `tasks/${taskId}/start`, { mode }) as { note?: string };
      state.error = null;
      // Brief feedback. `note` carries a caveat the backend could not honour silently —
      // e.g. review is prompt-enforced only for a run-as agent, whose launcher accepts
      // no permission mode. Showing "launched (review mode)" alone would imply a tool
      // gate that is not there.
      showToast(res?.note ? `Session launched — ${res.note}` : `Session launched (${mode} mode)`);
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

  async function handlePark(taskId: string): Promise<void> {
    if (!confirm("Park this task? It stays in the list, marked parked, and won't be picked up until you unpark it.")) return;
    try {
      await api.rpc('POST', `tasks/${taskId}/park`, { note: 'Parked via CloudCLI' });
      state.error = null;
      showToast('Task parked');
      // The task stays visible — no need to leave the detail view.
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleUnpark(taskId: string): Promise<void> {
    try {
      await api.rpc('POST', `tasks/${taskId}/unpark`, { note: 'Unparked via CloudCLI' });
      state.error = null;
      showToast('Task unparked');
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleAmend(taskId: string): Promise<void> {
    const amendment = prompt(
      'Append an amendment. The original description is never rewritten — this is added ' +
      'below it.\n\nIf a task needs more than one or two amendments, cancel and re-queue instead.',
    );
    if (!amendment || !amendment.trim()) return;
    try {
      await api.rpc('POST', `tasks/${taskId}/amend`, { amendment, reason: 'Amended via CloudCLI' });
      state.error = null;
      showToast('Amendment appended');
      await loadTasks();
      if (state.selectedTaskId === taskId) await loadTaskDetail(taskId);
    } catch (err) {
      state.error = (err as Error).message;
      render(api.context);
    }
  }

  async function handleRequeue(taskId: string, summary: string): Promise<void> {
    // Confirmed, because it puts work back in front of an agent. The caveat is in the
    // prompt rather than only in the docs: requeueing does not fix why the task was
    // dropped, and all seventeen of the records this shipped against would dead-letter
    // again for the same reason (vikunja#63/#169).
    if (!confirm(
      `Requeue "${summary}"?\n\nIt returns to the queue at submitted with its retry count `
      + 'reset. This does NOT fix why it was dropped — if the cause is still live it will '
      + 'be dead-lettered again.',
    )) return;
    try {
      await api.rpc('POST', `tasks/${taskId}/requeue`, { note: 'Requeued via CloudCLI' });
      state.error = null;
      showToast('Task requeued');
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
        onPark: handlePark,
        onUnpark: handleUnpark,
        onAmend: handleAmend,
        onSetStatus: handleSetStatus,
        onOpenRun: runForTask(state.selectedTask.id)
          ? () => openRun(runForTask(state.selectedTask!.id)!.id)
          : undefined,
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
        onPark: handlePark,
        onUnpark: handleUnpark,
        onAmend: handleAmend,
        onSetStatus: handleSetStatus,
      });

      renderHeadlessRuns(root, {
        runs: state.headlessRuns,
        selectedRun: state.selectedRun,
        selectedRunId: state.selectedRunId,
        agentFilter: state.runAgentFilter,
        colors: c,
        onAgentFilterChange: (agent) => {
          state.runAgentFilter = agent;
          render(ctx);
        },
        onSelect: openRun,
        onBack: () => {
          state.selectedRunId = null;
          state.selectedRun = null;
          render(ctx);
        },
        onCopy: handleCopyCommand,
      });

      renderDeadLetters(root, {
        deadLetters: state.deadLetters,
        expanded: state.deadLettersExpanded,
        colors: c,
        onToggle: () => {
          state.deadLettersExpanded = !state.deadLettersExpanded;
          render(ctx);
        },
        onRequeue: handleRequeue,
      });
    }
  }

  /**
   * The launch log for a task, if one was recorded. Matched on the full task id the
   * backend resolved from the log's 8-char prefix, so a prefix collision (which the
   * backend reports as unresolved) never links to the wrong task.
   */
  function runForTask(taskId: string): HeadlessRun | undefined {
    return state.headlessRuns.find(r => r.task_id === taskId);
  }

  function renderHeader(parent: HTMLElement, c: ThemeColors): void {
    const header = document.createElement('div');
    header.style.cssText = `display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid ${c.border};`;

    header.innerHTML = `
      <span style="font-size:14px;font-weight:600;color:${c.accent}">Task Queue</span>
      <span style="color:${c.muted};font-size:11px">${state.tasks.length} tasks</span>
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
        <span id="tq-ws-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%"></span>
        <span id="tq-ws-label" style="color:${c.muted};font-size:11px"></span>
      </span>
    `;

    // Cache the badge nodes for updateConnectionBadge(). render() rebuilds the header,
    // so these are re-seated on every render and must not be captured elsewhere.
    wsDotEl = header.querySelector<HTMLElement>('#tq-ws-dot');
    wsLabelEl = header.querySelector<HTMLElement>('#tq-ws-label');
    updateConnectionBadge();

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
    if (event.type === '_connected' || event.type === '_disconnected') {
      const next = event.type === '_connected';
      // Connection state never reaches render(). render() does root.innerHTML = '',
      // so calling it from here tore down and rebuilt the whole panel on every failed
      // reconnect — every 5s, forever, losing scroll position and any open dropdown.
      if (state.wsConnected === next) return;
      state.wsConnected = next;
      updateConnectionBadge();
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

// ── CloudCLI Plugin API (from host) ────────────────────────────────────

export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

// ── Theme ──────────────────────────────────────────────────────────────

export interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  error: string;
}

// ── Task types ─────────────────────────────────────────────────────────

export interface TaskHistoryEntry {
  timestamp: string;
  status: string;
  actor: string;
  note: string;
}

export interface Task {
  id: string;
  created: string;
  source_agent: string;
  target_agent: string;
  task_type: string;
  risk_level: string;
  requires_approval: boolean;
  status: string;
  summary: string;
  ttl_days: number;
  payload: {
    description: string;
    context_refs?: string[];
    priority?: string;
  };
  result: {
    output: string | null;
    completed_by: string | null;
    completed_at: string | null;
  };
  history: TaskHistoryEntry[];
}

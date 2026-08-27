import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { load as yamlLoad } from 'js-yaml';
import { callControlApi, type ControlAction } from './control-api.ts';
import { evaluateUpgrade, allowedOrigins } from './ws-guard.ts';
import { resolveAllowedPath } from './path-guard.ts';
import type { HeadlessRun, HeadlessRunDetail } from './types.ts';
import {
  parseLaunchLogName,
  parseRunId,
  runIdToFilename,
  runId,
  firstLine,
  extractFencedBlocks,
  runTimes,
} from './launch-log.ts';
import {
  loadLaunchPolicy,
  policyPath,
  buildLaunchArgv,
  launchLogName,
  lookupAgent,
  LaunchPolicyError,
  type LaunchPolicy,
  type StartMode,
} from './launch-policy.ts';

// ── Constants ──────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? os.homedir();
const TASK_QUEUE_DIR = path.join(HOME, '.claude', 'task-queue');
const START_TIME = Date.now();

// Read from package.json rather than hardcoding. A hardcoded copy silently drifted
// from package.json/manifest.json and shipped a stale version on /health and on the
// WebSocket `connected` event for two releases.
const VERSION: string = (() => {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

// MCP control API — the single validated, shared-secret-gated mutation path. All
// queue mutations (approve/cancel/status/park/unpark/amend) proxy here so they
// inherit the MCP core's transition validation + fcntl locking. Reads stay direct.
const TASK_QUEUE_API = (process.env.TASK_QUEUE_API ?? 'http://127.0.0.1:8485').replace(/\/$/, '');
const TASK_QUEUE_API_SECRET = process.env.TASK_QUEUE_API_SECRET ?? '';

// Agent launch policy — ONE roster, shared with task-dispatcher.py. See
// launch-policy.ts. The hardcoded AGENT_PROJECTS map that used to live here was a
// second copy of the dispatcher's table; it never gained a steward entry, which is
// exactly why Start could not launch steward (vikunja#523). Do not reintroduce it.
//
// Loaded once at startup rather than lazily, so a broken policy is reported when the
// plugin boots instead of on the operator's first Start. It is captured rather than
// thrown, because a throw here would take down the whole plugin — including the
// read-only task list, which needs no policy at all. Every launch then fails with the
// captured error by name; none of them silently falls back to spawning `claude`,
// which for a run-as agent would mean impersonating it.
const LAUNCH_POLICY: { policy: LaunchPolicy | null; error: string | null } = (() => {
  const p = policyPath(process.env, HOME);
  try {
    return { policy: loadLaunchPolicy(p, HOME), error: null };
  } catch (err) {
    const message = err instanceof LaunchPolicyError
      ? err.message
      : `launch policy ${p}: ${(err as Error).message}`;
    process.stderr.write(`[task-queue] launch policy unusable — Start is disabled: ${message}\n`);
    return { policy: null, error: message };
  }
})();

// ── Task operations (direct YAML file reader) ─────────────────────────

interface Task {
  id?: string;
  task_type?: string;
  target_agent?: string;
  status?: string;
  summary?: string;
  created?: unknown;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

// Files are named TIMESTAMP-<id_prefix>.yml; scan by id field value.
function findTaskFilePath(taskId: string): string | null {
  if (!VALID_ID.test(taskId)) return null;
  try {
    if (!fs.existsSync(TASK_QUEUE_DIR)) return null;
    const files = fs.readdirSync(TASK_QUEUE_DIR).filter(f => f.endsWith('.yml') && !f.endsWith('.tmp'));
    for (const file of files) {
      try {
        const f = path.join(TASK_QUEUE_DIR, file);
        const content = fs.readFileSync(f, 'utf-8');
        const task = yamlLoad(content) as Task;
        if (task?.id === taskId) return f;
      } catch { /* skip */ }
    }
    return null;
  } catch {
    return null;
  }
}

function listTasks(filters: { target_agent?: string; status?: string; task_type?: string } = {}): Task[] {
  try {
    if (!fs.existsSync(TASK_QUEUE_DIR)) return [];
    const files = fs.readdirSync(TASK_QUEUE_DIR).filter(f => f.endsWith('.yml') && !f.endsWith('.tmp'));
    const tasks: Task[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(TASK_QUEUE_DIR, file), 'utf-8');
        const task = yamlLoad(content) as Task;
        if (!task?.id) continue;
        if (filters.target_agent && task.target_agent !== filters.target_agent) continue;
        if (filters.status && task.status !== filters.status) continue;
        if (filters.task_type && task.task_type !== filters.task_type) continue;
        tasks.push(task);
      } catch { /* skip corrupt file */ }
    }
    return tasks;
  } catch {
    return [];
  }
}

function getTask(taskId: string): Task | null {
  const f = findTaskFilePath(taskId);
  if (!f) return null;
  try {
    return yamlLoad(fs.readFileSync(f, 'utf-8')) as Task;
  } catch {
    return null;
  }
}

// ── Context ref preview ───────────────────────────────────────────────

const PREVIEW_ALLOWED_PREFIXES = [
  path.join(HOME, '.claude', 'comms'),
  path.join(HOME, '.claude', 'task-queue'),
];

function previewFile(filePath: string, lines = 20): string | null {
  // The realpath-then-prefix check lives in path-guard.ts — one copy, shared with the
  // headless-run log reader. See that module for why realpath comes first.
  const resolved = resolveAllowedPath(filePath, PREVIEW_ALLOWED_PREFIXES);
  if (!resolved) return null;
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const result = content.split('\n').slice(0, lines).join('\n');
    return result;
  } catch {
    return null;
  }
}

// ── Session launcher ──────────────────────────────────────────────────

const LAUNCH_LOG_DIR = path.join(HOME, '.claude', 'comms', 'artifacts', 'task-launches');

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve an executable on PATH (no external deps). Returns absolute path or null.
function resolveBin(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not executable here — keep looking */ }
  }
  return null;
}

function launchSession(taskId: string, targetAgent: string, mode: StartMode): { ok: boolean; error?: string; note?: string } {
  if (!VALID_ID.test(taskId)) return { ok: false, error: `Invalid task id: ${taskId}` };

  if (!LAUNCH_POLICY.policy) {
    return { ok: false, error: `Launch policy unusable: ${LAUNCH_POLICY.error}` };
  }

  const entry = lookupAgent(LAUNCH_POLICY.policy, targetAgent);
  if (!entry) return { ok: false, error: `Unknown agent: ${targetAgent}` };

  if (!fs.existsSync(entry.projectDir)) {
    return { ok: false, error: `Project dir missing: ${entry.projectDir}` };
  }

  // A run-as agent must go through its launcher; an absent or non-executable launcher
  // is refused by name here rather than surfacing as an opaque sudo failure in the log.
  // It must never degrade to spawning `claude` — for a run-as agent that would be
  // impersonation, which is the whole of vikunja#523.
  if (entry.launcher && !isExecutable(entry.launcher)) {
    return {
      ok: false,
      error: `Launcher missing or not executable for run-as agent '${targetAgent}': `
        + `${entry.launcher} — deploy it with forge-scripts-deploy.sh`,
    };
  }

  // Resolve the binary up front so a missing CLI is a clean 400, not a silent exit.
  // Only a directly-launched agent needs it; a run-as agent's launcher resolves its own.
  let claudeBin = '';
  if (!entry.runAsUser) {
    const resolved = resolveBin('claude');
    if (!resolved) return { ok: false, error: 'claude CLI not found on PATH' };
    claudeBin = resolved;
  }

  const prompt = mode === 'review'
    ? `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Present a summary of the work entailed. Do NOT begin execution — wait for operator approval.`
    : `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Claim it (update status to in-progress), then execute the task.`;

  const { argv, note } = buildLaunchArgv(entry, mode, prompt, claudeBin);

  // Per-launch log replaces stdio:'ignore' so a failed launch is diagnosable.
  // cwd:projectDir is how Claude Code resolves project config — `--project` is not a valid flag.
  let logFd: number;
  let logPath: string;
  try {
    fs.mkdirSync(LAUNCH_LOG_DIR, { recursive: true });
    logPath = path.join(LAUNCH_LOG_DIR, launchLogName(targetAgent, taskId));
    logFd = fs.openSync(logPath, 'a');
  } catch (err) {
    return { ok: false, error: `Cannot open launch log: ${(err as Error).message}` };
  }

  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: entry.projectDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });

    child.on('error', (err) => {
      try { fs.appendFileSync(logPath, `[launch error] ${err.message}\n`); } catch { /* best-effort */ }
    });

    child.unref();
    return note ? { ok: true, note } : { ok: true };
  } catch (err) {
    return { ok: false, error: `spawn failed: ${(err as Error).message}` };
  } finally {
    // The child inherited its own dup of the fd; close our copy.
    try { fs.closeSync(logFd); } catch { /* already gone */ }
  }
}

// ── Headless run reader (read-only) ───────────────────────────────────

// This section READS launch logs and never writes them. Both routes resolve through
// the shared path guard; neither ever treats a route id as a path.

const HEADLESS_HEAD_BYTES = 2048;
const HEADLESS_MAX_BYTES = 512 * 1024;

/**
 * Map an 8-char task-id prefix to the live queue task, for the derived status.
 *
 * A log proves a session ran; it does not prove its task closed. When the two
 * disagree that is real signal, not noise — steward-f42d3aeb is a completed run whose
 * task sat at `approved` for four days. Render the disagreement; never infer a status
 * from the log's prose.
 *
 * A prefix collision resolves to `unknown` rather than to an arbitrary one of the two.
 */
function queueIndexByPrefix(): Map<string, { status: string; taskId: string }> {
  const idx = new Map<string, { status: string; taskId: string }>();
  const collided = new Set<string>();
  for (const t of listTasks()) {
    const id = typeof t.id === 'string' ? t.id : '';
    if (!id) continue;
    const key = id.slice(0, 8);
    if (collided.has(key)) continue;
    if (idx.has(key)) { idx.delete(key); collided.add(key); continue; }
    idx.set(key, { status: typeof t.status === 'string' ? t.status : 'unknown', taskId: id });
  }
  return idx;
}

/** Read at most `bytes` from the head of a file. Never reads a whole log to get one line. */
function readHead(filePath: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

function listHeadlessRuns(agentFilter?: string): HeadlessRun[] {
  let names: string[];
  try {
    names = fs.readdirSync(LAUNCH_LOG_DIR);
  } catch {
    return [];   // directory absent is an empty list, not an error
  }

  const queue = queueIndexByPrefix();
  const runs: HeadlessRun[] = [];

  for (const name of names) {
    // Skip anything that is not <agent>-<task8>.log rather than guessing at an agent.
    // Two pre-2026-08 orphans are named with a bare task UUID and no agent.
    const parsed = parseLaunchLogName(name);
    if (!parsed) continue;
    if (agentFilter && parsed.agent !== agentFilter) continue;

    // The guard runs on the LIST route too, not only on the detail route: this loop
    // head-reads every file, so a symlink planted in the log dir would otherwise put
    // the first line of its target into a row.
    const resolved = resolveAllowedPath(path.join(LAUNCH_LOG_DIR, name), PREVIEW_ALLOWED_PREFIXES);
    if (!resolved) continue;

    let st: fs.Stats;
    try { st = fs.statSync(resolved); } catch { continue; }
    if (!st.isFile()) continue;

    const match = queue.get(parsed.taskId8);
    runs.push({
      id: runId(parsed.agent, parsed.taskId8),
      agent: parsed.agent,
      task_id8: parsed.taskId8,
      task_id: match?.taskId ?? null,
      status: match?.status ?? 'unknown',
      size: st.size,
      first_line: firstLine(readHead(resolved, HEADLESS_HEAD_BYTES)),
      ...runTimes(st),
    });
  }

  runs.sort((a, b) => b.ended.localeCompare(a.ended));
  return runs;
}

function readHeadlessRun(id: string): HeadlessRunDetail | null {
  // `id` is validated as <agent>-<task8> and the filename is then REBUILT via
  // launchLogName, so the caller's string never reaches the filesystem as a path even
  // before the realpath guard runs. Two independent barriers, deliberately.
  const parsed = parseRunId(id);
  if (!parsed) return null;

  const resolved = resolveAllowedPath(
    path.join(LAUNCH_LOG_DIR, runIdToFilename(parsed)),
    PREVIEW_ALLOWED_PREFIXES,
  );
  if (!resolved) return null;

  let text: string;
  let truncated: boolean;
  let fd: number | null = null;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return null;
    fd = fs.openSync(resolved, 'r');
    // Read one byte past the cap so a file exactly at the cap is not called truncated.
    const buf = Buffer.alloc(HEADLESS_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, HEADLESS_MAX_BYTES + 1, 0);
    truncated = n > HEADLESS_MAX_BYTES;
    text = buf.subarray(0, Math.min(n, HEADLESS_MAX_BYTES)).toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }

  const match = queueIndexByPrefix().get(parsed.taskId8);
  return {
    id: runId(parsed.agent, parsed.taskId8),
    agent: parsed.agent,
    task_id8: parsed.taskId8,
    task_id: match?.taskId ?? null,
    status: match?.status ?? 'unknown',
    text,
    commands: extractFencedBlocks(text),
    truncated,
  };
}

// ── File watcher ──────────────────────────────────────────────────────

let watchDebounce: ReturnType<typeof setTimeout> | null = null;

function startWatcher(broadcast: (msg: object) => void): void {
  // Ensure directory exists
  if (!fs.existsSync(TASK_QUEUE_DIR)) {
    fs.mkdirSync(TASK_QUEUE_DIR, { recursive: true });
  }

  fs.watch(TASK_QUEUE_DIR, { persistent: false }, (_eventType, filename) => {
    if (!filename?.endsWith('.yml')) return;
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      // Count current tasks
      try {
        const files = fs.readdirSync(TASK_QUEUE_DIR).filter(f => f.endsWith('.yml') && !f.endsWith('.tmp'));
        broadcast({ type: 'tasks', count: files.length, changed: filename });
      } catch { /* skip */ }
    }, 1000);
  });
}

// ── HTTP + WebSocket server ───────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { /* skip */ }
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', version: VERSION }));
  ws.on('close', () => clients.delete(ws));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  try {
    // Health
    if (pathname === '/health' && req.method === 'GET') {
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        version: VERSION,
      }));
      return;
    }

    // List tasks
    if (pathname === '/tasks' && req.method === 'GET') {
      const filters: Record<string, string> = {};
      const agent = url.searchParams.get('agent');
      const status = url.searchParams.get('status');
      const taskType = url.searchParams.get('type');
      if (agent) filters.target_agent = agent;
      if (status) filters.status = status;
      if (taskType) filters.task_type = taskType;

      const tasks = listTasks(filters);
      res.end(JSON.stringify({ tasks }));
      return;
    }

    // Get task detail
    const taskMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = getTask(taskMatch[1]);
      if (!task) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
      // Get context ref previews
      const previews: Record<string, string | null> = {};
      if (task?.payload?.context_refs && Array.isArray(task.payload.context_refs)) {
        for (const ref of task.payload.context_refs as string[]) {
          previews[ref] = previewFile(ref);
        }
      }
      res.end(JSON.stringify({ task, previews }));
      return;
    }

    // List headless runs. Read-only.
    if (pathname === '/headless-runs' && req.method === 'GET') {
      const agent = url.searchParams.get('agent');
      res.end(JSON.stringify({ runs: listHeadlessRuns(agent ?? undefined) }));
      return;
    }

    // One headless run's full output. Read-only. The id is matched by the same strict
    // character class as /tasks/:id and is never treated as a path — see readHeadlessRun.
    const runMatch = pathname.match(/^\/headless-runs\/([a-zA-Z0-9_-]+)$/);
    if (runMatch && req.method === 'GET') {
      const run = readHeadlessRun(runMatch[1]);
      if (!run) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
      res.end(JSON.stringify(run));
      return;
    }

    // Start task
    const startMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const body = await readBody(req);
      const { mode } = JSON.parse(body) as { mode: StartMode };
      const taskData = getTask(startMatch[1]);
      if (!taskData) { res.statusCode = 404; res.end(JSON.stringify({ error: 'task not found' })); return; }
      const result = launchSession(startMatch[1], taskData.target_agent ?? '', mode ?? 'review');
      res.statusCode = result.ok ? 200 : 400;
      res.end(JSON.stringify(result));
      return;
    }

    // Queue mutations — all proxied to the MCP control API (the single validated,
    // shared-secret-gated write path). No direct YAML mutation happens in the plugin.
    const mutationMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/(approve|cancel|status|park|unpark|amend)$/);
    if (mutationMatch && req.method === 'POST') {
      const mTaskId = mutationMatch[1];
      const action = mutationMatch[2] as ControlAction;

      let body: Record<string, unknown> = {};
      // status/cancel/park/unpark may carry a note or target status; amend carries the
      // amendment text. approve carries nothing.
      if (action !== 'approve') {
        const raw = await readBody(req);
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        if (action === 'status') {
          body = {
            status: parsed.status,
            note: parsed.note ?? '',
            allow_override: parsed.allow_override ?? false,
          };
        } else if (action === 'amend') {
          body = { amendment: parsed.amendment ?? '', reason: parsed.reason ?? '' };
        } else {
          if (parsed.note) body.note = parsed.note;
          // unpark may name an explicit status to return to.
          if (action === 'unpark' && parsed.status) body.status = parsed.status;
        }
      }

      const { status: apiStatus, data } = await callControlApi(mTaskId, action, body, {
        apiBase: TASK_QUEUE_API,
        secret: TASK_QUEUE_API_SECRET,
      });
      res.statusCode = apiStatus;
      res.end(JSON.stringify(data));
      return;
    }

    // 404
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));

  } catch (err) {
    process.stderr.write(`[task-queue] ${(err as Error).message}\n`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
});

const MAX_BODY_BYTES = 65536; // 64KB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// WebSocket upgrade — see ws-guard.ts for the rule and why it is shaped this way.
server.on('upgrade', (req, socket, head) => {
  const decision = evaluateUpgrade(
    req.socket.remoteAddress,
    req.headers.origin,
    allowedOrigins(),
  );

  if (!decision.allow) {
    // Log the reason. v0.4.0 refused every connect for three weeks and the only signal
    // was a 403 on the far side of the proxy, naming neither leg nor the cause.
    process.stderr.write(`[task-queue] ws upgrade refused — ${decision.reason}\n`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Start ─────────────────────────────────────────────────────────────

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number };
  console.log(JSON.stringify({ ready: true, port: addr.port }));
  startWatcher(broadcast);
});

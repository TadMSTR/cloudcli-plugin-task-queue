import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

// ── Constants ──────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? os.homedir();
const TASK_QUEUE_DIR = path.join(HOME, '.claude', 'task-queue');
const START_TIME = Date.now();
const VERSION = '0.1.0';

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

// Agent-to-project mapping (matches forge task-dispatcher)
const AGENT_PROJECTS: Record<string, string> = {
  sysadmin: path.join(HOME, '.claude', 'projects', 'sysadmin'),
  developer: path.join(HOME, '.claude', 'projects', 'developer'),
  research: path.join(HOME, '.claude', 'projects', 'research'),
  writer: path.join(HOME, '.claude', 'projects', 'writer'),
  security: path.join(HOME, '.claude', 'projects', 'security'),
};

// ── Task operations (direct YAML file reader) ─────────────────────────

interface Task {
  task_id?: string;
  task_type?: string;
  target_agent?: string;
  status?: string;
  summary?: string;
  created?: unknown;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

function readTaskFile(taskId: string): Task | null {
  if (!VALID_ID.test(taskId)) return null;
  const f = path.join(TASK_QUEUE_DIR, `${taskId}.yml`);
  try {
    const content = fs.readFileSync(f, 'utf-8');
    return yamlLoad(content) as Task;
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
        if (!task?.task_id) continue;
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
  return readTaskFile(taskId);
}

function approveTask(taskId: string): Task | null {
  if (!VALID_ID.test(taskId)) return null;
  const f = path.join(TASK_QUEUE_DIR, `${taskId}.yml`);
  try {
    const content = fs.readFileSync(f, 'utf-8');
    const task = yamlLoad(content) as Task;
    task.status = 'approved';
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, yamlDump(task), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return task;
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
  const resolved = path.resolve(filePath);
  if (!PREVIEW_ALLOWED_PREFIXES.some(p => resolved.startsWith(p + '/'))) return null;
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const result = content.split('\n').slice(0, lines).join('\n');
    return result;
  } catch {
    return null;
  }
}

// ── Session launcher ──────────────────────────────────────────────────

function launchSession(taskId: string, targetAgent: string, mode: 'review' | 'auto'): { ok: boolean; error?: string } {
  const projectDir = AGENT_PROJECTS[targetAgent];
  if (!projectDir) return { ok: false, error: `Unknown agent: ${targetAgent}` };

  if (!fs.existsSync(projectDir)) return { ok: false, error: `Project dir missing: ${projectDir}` };

  const prompt = mode === 'review'
    ? `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Present a summary of the work entailed. Do NOT begin execution — wait for operator approval.`
    : `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Claim it (update status to in-progress), then execute the task.`;

  const permissionMode = mode === 'review' ? 'plan' : 'default';

  const child = spawn('claude', [
    '--project', projectDir,
    '-p', prompt,
    '--permission-mode', permissionMode,
  ], {
    cwd: projectDir,
    stdio: 'ignore',
    detached: true,
  });

  child.unref();

  return { ok: true };
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

    // Start task
    const startMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const body = await readBody(req);
      const { mode } = JSON.parse(body) as { mode: 'review' | 'auto' };
      const taskData = getTask(startMatch[1]);
      if (!taskData) { res.statusCode = 404; res.end(JSON.stringify({ error: 'task not found' })); return; }
      const result = launchSession(startMatch[1], taskData.target_agent ?? '', mode ?? 'review');
      res.statusCode = result.ok ? 200 : 400;
      res.end(JSON.stringify(result));
      return;
    }

    // Approve task
    const approveMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const result = approveTask(approveMatch[1]);
      if (!result) { res.statusCode = 404; res.end(JSON.stringify({ error: 'task not found' })); return; }
      res.end(JSON.stringify({ ok: true, result }));
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

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  const allowed = [
    process.env.CLOUDCLI_ORIGIN ?? '',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ].filter(Boolean);

  if (origin && !allowed.includes(origin)) {
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

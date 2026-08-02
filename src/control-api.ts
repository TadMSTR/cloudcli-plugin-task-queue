// MCP control API proxy (mutations).
//
// The single validated, shared-secret-gated write path for queue mutations
// (approve/cancel/status/park/unpark/amend). All of them proxy here so they
// inherit the MCP core's transition validation + fcntl locking; the plugin
// never mutates task YAML directly. Reads stay direct (see server.ts).
//
// Extracted from server.ts so the auth/transport guards are unit-testable
// without booting the plugin's HTTP server.

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

export type ControlAction = 'approve' | 'cancel' | 'status' | 'park' | 'unpark' | 'amend';

export interface ControlApiResult {
  status: number;
  data: unknown;
}

export interface ControlApiOptions {
  /** Base URL of the control API, no trailing slash (e.g. http://127.0.0.1:8485). */
  apiBase: string;
  /** Shared secret; an empty string means the plugin never received it. */
  secret: string;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Proxy a queue mutation to the MCP control API. The shared secret is sent as
 * an `X-Task-Queue-Secret` header. Returns a `{ status, data }` result — it
 * never throws; transport failures are mapped to a 502.
 */
export async function callControlApi(
  taskId: string,
  action: ControlAction,
  body: Record<string, unknown>,
  opts: ControlApiOptions,
): Promise<ControlApiResult> {
  if (!VALID_ID.test(taskId)) {
    return { status: 400, data: { ok: false, error: 'invalid task id' } };
  }
  if (!opts.secret) {
    // Previously silent: the request never left the plugin, and nothing recorded
    // that it tried. Log to stderr (captured into ~/.pm2/logs/cloudcli-error.log)
    // so a misconfigured passthrough is diagnosable instead of a mystery 500.
    console.error(
      `[task-queue] control API call for ${action} on task ${taskId} aborted: ` +
      'TASK_QUEUE_API_SECRET is empty in the plugin process. The host must grant it ' +
      'via the manifest `permissions` (env:TASK_QUEUE_API_SECRET) and have it set in its own env.',
    );
    return { status: 500, data: { ok: false, error: 'TASK_QUEUE_API_SECRET not configured' } };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.apiBase}/tasks/${encodeURIComponent(taskId)}/${action}`;
  try {
    const resp = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Task-Queue-Secret': opts.secret,
      },
      body: JSON.stringify({ actor: 'operator', ...body }),
    });
    let data: unknown = {};
    try { data = await resp.json(); } catch { data = {}; }
    return { status: resp.status, data };
  } catch (err) {
    console.error(
      `[task-queue] control API ${action} on task ${taskId} unreachable at ${url}: ${(err as Error).message}`,
    );
    // SECURITY[accepted]: err.message (a Node fetch connection error, e.g. ECONNREFUSED —
    // not a stack trace or internal path) is surfaced to the CloudCLI UI. Client is Ted's
    // authenticated, loopback-bound operator UI; matches the accepted OE-02 precedent from
    // cloudcli-plugin-plane. Genericize if this endpoint is ever exposed beyond loopback.
    return { status: 502, data: { ok: false, error: `control API unreachable: ${(err as Error).message}` } };
  }
}

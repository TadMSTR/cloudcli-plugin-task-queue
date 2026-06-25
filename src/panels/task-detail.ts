import type { ThemeColors, Task } from '../types.js';
import { escHtml, ago, statusColor, priorityColor, MONO } from './styles.js';

interface TaskDetailOptions {
  task: Task;
  contextPreviews: Map<string, string>;
  colors: ThemeColors;
  onBack: () => void;
  onApprove: (taskId: string) => void;
  onStart: (taskId: string, mode: 'review' | 'auto') => void;
  onCancel: (taskId: string) => void;
  onQuarantine: (taskId: string) => void;
  onSetStatus: (taskId: string, status: string) => void;
}

const DETAIL_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const DETAIL_NON_TERMINAL_STATUSES = ['submitted', 'pending-approval', 'approved', 'in-progress'];

export function renderTaskDetail(container: HTMLElement, opts: TaskDetailOptions): void {
  const { task, contextPreviews, colors: c, onBack, onApprove, onStart, onCancel, onQuarantine, onSetStatus } = opts;

  const sc = statusColor(task.status, c);
  const priority = task.payload.priority ?? 'normal';
  const pc = priorityColor(priority, c);

  const wrapper = document.createElement('div');
  wrapper.className = 'tq-up';

  // Back button
  const backBtn = document.createElement('button');
  backBtn.textContent = '\u2190 Back';
  Object.assign(backBtn.style, {
    background: 'transparent', color: c.muted, border: 'none',
    cursor: 'pointer', fontSize: '12px', fontFamily: MONO,
    padding: '4px 0', marginBottom: '12px',
  });
  backBtn.addEventListener('click', onBack);
  wrapper.appendChild(backBtn);

  // Header
  const header = document.createElement('div');
  header.style.cssText = `margin-bottom:16px;`;
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="color:${c.muted};font-size:12px">${escHtml(task.id)}</span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sc}"></span>
      <span style="color:${sc};font-size:13px;font-weight:600">${escHtml(task.status)}</span>
    </div>
    <div style="font-size:15px;font-weight:600;margin-bottom:8px">${escHtml(task.summary)}</div>
  `;
  wrapper.appendChild(header);

  // Metadata grid
  const meta = document.createElement('div');
  meta.style.cssText = `display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:12px;margin-bottom:16px;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;`;
  meta.innerHTML = `
    <span style="color:${c.muted}">Source</span><span>${escHtml(task.source_agent)}</span>
    <span style="color:${c.muted}">Target</span><span>${escHtml(task.target_agent)}</span>
    <span style="color:${c.muted}">Type</span><span>${escHtml(task.task_type)}</span>
    <span style="color:${c.muted}">Priority</span><span style="color:${pc}">${escHtml(priority)}</span>
    <span style="color:${c.muted}">Risk</span><span>${escHtml(task.risk_level)}</span>
    <span style="color:${c.muted}">Approval</span><span>${task.requires_approval ? 'required' : 'auto'}</span>
    <span style="color:${c.muted}">Created</span><span>${ago(task.created)} <span style="color:${c.muted}">(${new Date(task.created).toLocaleString()})</span></span>
    <span style="color:${c.muted}">TTL</span><span>${task.ttl_days}d</span>
  `;
  wrapper.appendChild(meta);

  // Action buttons
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';

  if (task.status === 'approved') {
    actions.appendChild(makeActionButton('Start (Review)', c.accent, c, () => onStart(task.id, 'review')));
    actions.appendChild(makeActionButton('Start (Auto)', c.warn, c, () => onStart(task.id, 'auto')));
  }
  if (task.status === 'pending-approval' || task.status === 'submitted') {
    actions.appendChild(makeActionButton('Approve', c.ok, c, () => onApprove(task.id)));
  }
  // Lifecycle controls: cancel any non-terminal task; quarantine (isolate) any task.
  if (!DETAIL_TERMINAL_STATUSES.includes(task.status)) {
    actions.appendChild(makeActionButton('Cancel', c.error, c, () => onCancel(task.id)));
  }
  actions.appendChild(makeActionButton('Quarantine', c.muted, c, () => onQuarantine(task.id)));
  if (actions.childElementCount > 0) wrapper.appendChild(actions);

  // Status-change control — advance a task an agent missed (audited operator override).
  if (!DETAIL_TERMINAL_STATUSES.includes(task.status)) {
    const statusRow = document.createElement('div');
    statusRow.style.cssText = `display:flex;align-items:center;gap:8px;margin-bottom:16px;`;

    const label = document.createElement('span');
    label.style.cssText = `color:${c.muted};font-size:12px`;
    label.textContent = 'Set status';

    const select = document.createElement('select');
    select.style.cssText = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:12px;`;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'advance to…';
    select.appendChild(placeholder);
    for (const s of DETAIL_NON_TERMINAL_STATUSES) {
      if (s === task.status) continue;
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      if (select.value) onSetStatus(task.id, select.value);
    });

    statusRow.appendChild(label);
    statusRow.appendChild(select);
    wrapper.appendChild(statusRow);
  }

  // Description
  if (task.payload.description) {
    const desc = document.createElement('div');
    desc.style.cssText = `margin-bottom:16px;`;
    desc.innerHTML = `
      <div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Description</div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;font-family:${MONO}">${escHtml(task.payload.description)}</pre>
    `;
    wrapper.appendChild(desc);
  }

  // Context ref previews
  if (task.payload.context_refs && task.payload.context_refs.length > 0) {
    const refs = document.createElement('div');
    refs.style.cssText = 'margin-bottom:16px;';
    refs.innerHTML = `<div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Context References</div>`;

    for (const ref of task.payload.context_refs) {
      const preview = contextPreviews.get(ref);
      const refBlock = document.createElement('div');
      refBlock.style.cssText = `margin-bottom:8px;`;
      refBlock.innerHTML = `
        <div style="color:${c.muted};font-size:11px;margin-bottom:4px">${escHtml(ref)}</div>
        ${preview
          ? `<pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.4;padding:8px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;max-height:200px;overflow-y:auto;font-family:${MONO}">${escHtml(preview)}</pre>`
          : `<div style="color:${c.muted};font-size:11px;font-style:italic;padding:8px">Preview unavailable</div>`
        }
      `;
      refs.appendChild(refBlock);
    }
    wrapper.appendChild(refs);
  }

  // History timeline
  if (task.history.length > 0) {
    const hist = document.createElement('div');
    hist.innerHTML = `<div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">History</div>`;

    for (const entry of task.history) {
      const ec = statusColor(entry.status, c);
      const line = document.createElement('div');
      line.style.cssText = `display:flex;gap:10px;align-items:flex-start;padding:4px 0;font-size:12px;border-left:2px solid ${c.border};padding-left:12px;margin-left:4px;`;
      line.innerHTML = `
        <span style="color:${c.muted};min-width:55px;font-size:11px">${ago(entry.timestamp)}</span>
        <span style="color:${ec};min-width:90px">${escHtml(entry.status)}</span>
        <span style="color:${c.muted};min-width:70px">${escHtml(entry.actor)}</span>
        <span style="flex:1;color:${c.text}">${escHtml(entry.note || '')}</span>
      `;
      hist.appendChild(line);
    }
    wrapper.appendChild(hist);
  }

  // Result (if completed)
  if (task.result.output) {
    const result = document.createElement('div');
    result.style.cssText = 'margin-top:16px;';
    result.innerHTML = `
      <div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Result</div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;font-family:${MONO}">${escHtml(task.result.output)}</pre>
      ${task.result.completed_by ? `<div style="color:${c.muted};font-size:11px;margin-top:4px">Completed by ${escHtml(task.result.completed_by)} ${task.result.completed_at ? ago(task.result.completed_at) : ''}</div>` : ''}
    `;
    wrapper.appendChild(result);
  }

  container.appendChild(wrapper);
}

function makeActionButton(label: string, color: string, c: ThemeColors, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, {
    background: 'transparent', color, border: `1px solid ${color}`, borderRadius: '4px',
    padding: '6px 16px', fontSize: '12px', cursor: 'pointer', fontFamily: MONO,
    transition: 'background 0.15s',
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = c.dim; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', onClick);
  return btn;
}

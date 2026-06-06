import type { ThemeColors, Task } from '../types.js';
import { escHtml, ago, statusColor, priorityColor, priorityIcon, MONO } from './styles.js';

interface TaskListOptions {
  tasks: Task[];
  colors: ThemeColors;
  onSelect: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onStart: (taskId: string, mode: 'review' | 'auto') => void;
  filters: { agent: string; status: string; taskType: string };
  onFilterChange: (filters: { agent: string; status: string; taskType: string }) => void;
}

const STATUS_ORDER: Record<string, number> = {
  'in-progress': 0,
  'approved': 1,
  'pending-approval': 2,
  'submitted': 3,
  'completed': 4,
  'failed': 5,
};

const PRIORITY_ORDER: Record<string, number> = {
  'urgent': 0,
  'high': 1,
  'normal': 2,
};

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.payload.priority ?? 'normal'] ?? 2;
    const pb = PRIORITY_ORDER[b.payload.priority ?? 'normal'] ?? 2;
    if (pa !== pb) return pa - pb;
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.created).getTime() - new Date(a.created).getTime();
  });
}

function groupByAgent(tasks: Task[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const agent = t.target_agent;
    if (!groups.has(agent)) groups.set(agent, []);
    groups.get(agent)!.push(t);
  }
  return groups;
}

export function renderTaskList(container: HTMLElement, opts: TaskListOptions): void {
  const { tasks, colors: c, filters, onFilterChange, onSelect, onApprove, onStart } = opts;

  // Collect unique values for filters
  const agents = [...new Set(tasks.map(t => t.target_agent))].sort();
  const statuses = [...new Set(tasks.map(t => t.status))].sort();
  const types = [...new Set(tasks.map(t => t.task_type))].sort();

  // Apply filters
  let filtered = tasks;
  if (filters.agent) filtered = filtered.filter(t => t.target_agent === filters.agent);
  if (filters.status) filtered = filtered.filter(t => t.status === filters.status);
  if (filters.taskType) filtered = filtered.filter(t => t.task_type === filters.taskType);

  const sorted = sortTasks(filtered);
  const grouped = groupByAgent(sorted);

  // Filter bar
  const filterBar = document.createElement('div');
  Object.assign(filterBar.style, {
    display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center',
  });

  const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:12px;`;

  filterBar.innerHTML = `
    <label style="color:${c.muted};font-size:12px">Agent
      <select id="tq-filter-agent" style="${selectStyle}">
        <option value="">all</option>
        ${agents.map(a => `<option value="${escHtml(a)}" ${filters.agent === a ? 'selected' : ''}>${escHtml(a)}</option>`).join('')}
      </select>
    </label>
    <label style="color:${c.muted};font-size:12px">Status
      <select id="tq-filter-status" style="${selectStyle}">
        <option value="">all</option>
        ${statuses.map(s => `<option value="${escHtml(s)}" ${filters.status === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('')}
      </select>
    </label>
    <label style="color:${c.muted};font-size:12px">Type
      <select id="tq-filter-type" style="${selectStyle}">
        <option value="">all</option>
        ${types.map(t => `<option value="${escHtml(t)}" ${filters.taskType === t ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}
      </select>
    </label>
    <span style="color:${c.muted};font-size:11px;margin-left:auto">${filtered.length} of ${tasks.length} tasks</span>
  `;
  container.appendChild(filterBar);

  // Bind filter events
  for (const [id, key] of [['tq-filter-agent', 'agent'], ['tq-filter-status', 'status'], ['tq-filter-type', 'taskType']] as const) {
    const el = filterBar.querySelector(`#${id}`) as HTMLSelectElement;
    el?.addEventListener('change', () => {
      onFilterChange({ ...filters, [key]: el.value });
    });
  }

  // Task table grouped by agent
  if (grouped.size === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `color:${c.muted};text-align:center;padding:32px;font-size:13px;`;
    empty.textContent = 'No tasks match filters.';
    container.appendChild(empty);
    return;
  }

  for (const [agent, agentTasks] of grouped) {
    const group = document.createElement('div');
    group.className = 'tq-up';
    group.style.marginBottom = '20px';

    const header = document.createElement('div');
    header.style.cssText = `color:${c.accent};font-size:13px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;`;
    header.textContent = `${agent} (${agentTasks.length})`;
    group.appendChild(header);

    for (const task of agentTasks) {
      const row = document.createElement('div');
      const sc = statusColor(task.status, c);
      const priority = task.payload.priority ?? 'normal';
      const pIcon = priorityIcon(priority);
      const pColor = priorityColor(priority, c);

      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '8px 12px', marginBottom: '2px',
        background: c.surface, border: `1px solid ${c.border}`, borderRadius: '4px',
        cursor: 'pointer', fontSize: '12px', transition: 'border-color 0.15s',
      });

      row.addEventListener('mouseenter', () => { row.style.borderColor = c.accent; });
      row.addEventListener('mouseleave', () => { row.style.borderColor = c.border; });
      row.addEventListener('click', () => onSelect(task.id));

      const shortId = task.id.slice(0, 8);

      row.innerHTML = `
        <span style="color:${c.muted};min-width:64px;font-size:11px" title="${escHtml(task.id)}">${escHtml(shortId)}</span>
        ${pIcon ? `<span style="color:${pColor};font-size:11px;font-weight:700;min-width:24px">${pIcon}</span>` : '<span style="min-width:24px"></span>'}
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sc};flex-shrink:0" title="${escHtml(task.status)}"></span>
        <span style="color:${sc};min-width:90px;font-size:11px">${escHtml(task.status)}</span>
        <span style="color:${c.muted};min-width:60px;font-size:11px">${escHtml(task.task_type)}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(task.summary)}">${escHtml(task.summary)}</span>
        <span style="color:${c.muted};font-size:11px;min-width:55px;text-align:right">${ago(task.created)}</span>
      `;

      // Action buttons (inline, prevent click propagation)
      const actions = document.createElement('span');
      actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      if (task.status === 'approved') {
        const reviewBtn = makeButton('Review', c.accent, c, () => onStart(task.id, 'review'));
        const autoBtn = makeButton('Auto', c.warn, c, () => onStart(task.id, 'auto'));
        actions.appendChild(reviewBtn);
        actions.appendChild(autoBtn);
      }

      if (task.status === 'pending-approval' || task.status === 'submitted') {
        const approveBtn = makeButton('Approve', c.ok, c, () => onApprove(task.id));
        actions.appendChild(approveBtn);
      }

      row.appendChild(actions);
      group.appendChild(row);
    }

    container.appendChild(group);
  }
}

function makeButton(label: string, color: string, c: ThemeColors, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, {
    background: 'transparent', color, border: `1px solid ${color}`, borderRadius: '3px',
    padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontFamily: MONO,
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = c.dim; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

import type { ThemeColors } from '../types.js';

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

export { MONO };

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function themeColors(dark: boolean): ThemeColors {
  return dark
    ? {
        bg: '#08080f',
        surface: '#0e0e1a',
        border: '#1a1a2c',
        text: '#e2e0f0',
        muted: '#52507a',
        accent: '#fbbf24',
        dim: 'rgba(251,191,36,0.1)',
        ok: '#22c55e',
        warn: '#f59e0b',
        error: '#ef4444',
      }
    : {
        bg: '#fafaf9',
        surface: '#ffffff',
        border: '#e8e6f0',
        text: '#0f0e1a',
        muted: '#9490b0',
        accent: '#d97706',
        dim: 'rgba(217,119,6,0.08)',
        ok: '#16a34a',
        warn: '#d97706',
        error: '#dc2626',
      };
}

export function injectGlobalStyles(): void {
  if (document.getElementById('tq-styles')) return;

  const s = document.createElement('style');
  s.id = 'tq-styles';
  s.textContent = `
    @keyframes tq-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes tq-pulse  { 0%,100% { opacity:.4 } 50% { opacity:.8 } }
    .tq-up   { animation: tq-fadeup 0.4s ease both }
    .tq-live { animation: tq-pulse 2s ease infinite }
  `;
  document.head.appendChild(s);
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function statusColor(status: string, c: ThemeColors): string {
  switch (status) {
    case 'approved': return c.ok;
    case 'in-progress': return c.accent;
    case 'submitted': return c.muted;
    case 'pending-approval': return c.warn;
    case 'completed': return c.ok;
    case 'failed': return c.error;
    case 'cancelled': return c.muted;
    default: return c.muted;
  }
}

export function priorityColor(priority: string, c: ThemeColors): string {
  switch (priority) {
    case 'urgent': return c.error;
    case 'high': return c.warn;
    default: return c.muted;
  }
}

export function priorityIcon(priority: string): string {
  switch (priority) {
    case 'urgent': return '!!!';
    case 'high': return '!!';
    default: return '';
  }
}

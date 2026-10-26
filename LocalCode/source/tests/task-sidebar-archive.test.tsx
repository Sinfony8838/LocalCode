import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import TaskSidebar from '../src/renderer/TaskNavigation';
import { setLocale } from '../src/renderer/i18n';
import { DEFAULT_SIDEBAR, type Project, type SessionView } from '../src/shared/contracts';

afterEach(() => setLocale('zh-CN'));

const project: Project = { id: 'p1', name: '示例项目', path: 'D:/示例项目', createdAt: '2026-01-01T00:00:00Z' };
const session = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id, projectId: null, title: `任务 ${id}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  providerId: 'local', status: 'idle', messages: [], tools: [], ...patch,
});
const noop = () => {};
const props = (sessions: SessionView[], preferences = DEFAULT_SIDEBAR) => ({
  projects: [project], sessions, activeProjectId: '', activeSessionId: '', preferences,
  onProject: noop, onSession: noop, onAddProject: noop, onRename: noop, onMove: noop, onPin: noop,
  onArchive: noop, onDelete: noop, onPreferences: noop,
});

describe('session archive and delete navigation', () => {
  it('keeps archived sessions out of recent and project groups until the archived section opens', () => {
    const active = session('a1');
    const archived = session('a2', { archivedAt: '2026-01-03T00:00:00Z', projectId: 'p1' });
    const html = renderToStaticMarkup(<TaskSidebar {...props([active, archived])} />);
    expect(html).toContain('data-session-id="a1"');
    expect(html).not.toContain('data-session-id="a2"');
    expect(html).toContain('已归档');
    const open = renderToStaticMarkup(<TaskSidebar {...props([active, archived], { ...DEFAULT_SIDEBAR, archivedCollapsed: false })} />);
    expect(open).toContain('data-session-id="a2"');
  });

  it('renders the archived section and its tasks in English', () => {
    setLocale('en');
    const archived = session('a2', { archivedAt: '2026-01-03T00:00:00Z' });
    const html = renderToStaticMarkup(<TaskSidebar {...props([archived], { ...DEFAULT_SIDEBAR, archivedCollapsed: false })} />);
    expect(html).toContain('Archived');
    expect(html).toContain('aria-label="Archived tasks"');
    expect(html).toContain('任务 a2');
  });

  it('hides the archived section entirely when nothing is archived', () => {
    const html = renderToStaticMarkup(<TaskSidebar {...props([session('a1')])} />);
    expect(html).not.toContain('已归档');
  });
});

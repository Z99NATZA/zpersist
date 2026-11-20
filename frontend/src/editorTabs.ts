import { useCallback, useRef, useState } from 'react';
import type { Session } from './api';

const INITIAL_SQL = 'SELECT DB_NAME() AS [database_name];\nSELECT SYSDATETIME() AS [server_time];';

export interface EditorTab {
  id: number;
  sql: string;
  database: string;
}

interface EditorTabs {
  tabs: EditorTab[];
  activeId: number;
  nextId: number;
}

export function editorStorageKey({ server, username }: Session) {
  return `zpersist.editorTabs:${JSON.stringify([server, username])}`;
}

function isEditorTab(tab: unknown): tab is EditorTab {
  return typeof tab === 'object' && tab !== null &&
    'id' in tab && typeof tab.id === 'number' && Number.isSafeInteger(tab.id) && tab.id > 0 && tab.id < Number.MAX_SAFE_INTEGER &&
    'sql' in tab && typeof tab.sql === 'string' &&
    'database' in tab && typeof tab.database === 'string';
}

function readTabs(key: string): EditorTabs {
  try {
    const raw = sessionStorage.getItem(key);
    const saved: Partial<EditorTabs> | null = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved?.tabs)) {
      const seen = new Set<number>();
      const tabs = saved.tabs.filter((tab) => {
        if (!isEditorTab(tab) || seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      });
      if (tabs.length) {
        const activeId = typeof saved.activeId === 'number' && seen.has(saved.activeId) ? saved.activeId : tabs[0].id;
        const maxId = tabs.reduce((max, tab) => Math.max(max, tab.id), 0);
        const nextId = typeof saved.nextId === 'number' && Number.isSafeInteger(saved.nextId) && saved.nextId < Number.MAX_SAFE_INTEGER
          ? Math.max(saved.nextId, maxId + 1) : maxId + 1;
        return { tabs, activeId, nextId };
      }
    }
  } catch {
    // A blocked storage area or an unreadable draft still leaves an editor available.
  }
  return { tabs: [{ id: 1, sql: INITIAL_SQL, database: '' }], activeId: 1, nextId: 2 };
}

export function useEditorTabs(storageKey: string) {
  const [state, setState] = useState(() => readTabs(storageKey));
  const current = useRef(state);

  const update = useCallback((change: (previous: EditorTabs) => EditorTabs) => {
    const next = change(current.current);
    if (next === current.current) return;
    current.current = next;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Drafts remain available while the workspace is open.
    }
    setState(next);
  }, [storageKey]);

  return { state, update };
}

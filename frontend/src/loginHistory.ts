import { useEffect, useState } from 'react';

const STORAGE_KEY = 'zpersist.loginHistory';
const HISTORY_LIMIT = 20;

interface SavedServer {
  ip: string;
  port: number;
}

interface LoginHistory {
  servers: SavedServer[];
  usernames: string[];
}

const emptyHistory: LoginHistory = { servers: [], usernames: [] };

export function serverKey(server: SavedServer) {
  return `${server.ip}|${server.port}`;
}

function isSavedServer(value: unknown): value is SavedServer {
  return typeof value === 'object' && value !== null &&
    'ip' in value && typeof value.ip === 'string' && value.ip.length > 0 &&
    'port' in value && typeof value.port === 'number' &&
    Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535;
}

function readHistory(): LoginHistory | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyHistory;
    const saved: { servers?: unknown; usernames?: unknown } | null = JSON.parse(raw);
    return {
      servers: Array.isArray(saved?.servers)
        ? saved.servers.filter(isSavedServer).slice(0, HISTORY_LIMIT).map(({ ip, port }) => ({ ip, port }))
        : [],
      usernames: Array.isArray(saved?.usernames)
        ? saved.usernames.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, HISTORY_LIMIT)
        : [],
    };
  } catch {
    return null;
  }
}

export function useLoginHistory() {
  const [history, setHistory] = useState(() => readHistory() ?? emptyHistory);

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === STORAGE_KEY || event.key === null) {
        const saved = readHistory();
        if (saved) setHistory(saved);
      }
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function update(change: (current: LoginHistory) => LoginHistory) {
    const next = change(readHistory() ?? history);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Keep suggestions available on this page when storage is unavailable.
    }
    setHistory(next);
  }

  function remember(server: SavedServer, username: string) {
    update((current) => ({
      servers: [server, ...current.servers.filter((item) => serverKey(item) !== serverKey(server))].slice(0, HISTORY_LIMIT),
      usernames: [username, ...current.usernames.filter((item) => item !== username)].slice(0, HISTORY_LIMIT),
    }));
  }

  function removeServer(key: string) {
    update((current) => ({
      ...current,
      servers: current.servers.filter((item) => serverKey(item) !== key),
    }));
  }

  function removeUsername(username: string) {
    update((current) => ({
      ...current,
      usernames: current.usernames.filter((item) => item !== username),
    }));
  }

  return { ...history, remember, removeServer, removeUsername };
}

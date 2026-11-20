export interface Session {
  server: string;
  username: string;
}

export interface ResultTable {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
}

export interface QueryResponse {
  results: ResultTable[];
  elapsed_ms: number;
}

export type MessageValues = Record<string, string | number>;

export interface Problem {
  code: string;
  params?: MessageValues;
  detail?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly problem: Problem) {
    super(problem.code);
  }
}

export async function api<T>(path: string, options?: { method: 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api' + path, {
      method: options?.method,
      signal: options?.signal,
      headers: options?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new ApiError(0, { code: 'network_error' });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (typeof payload?.code === 'string') {
      throw new ApiError(response.status, {
        code: payload.code,
        params: payload.params ?? undefined,
        detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      });
    }
    const code = [400, 413, 415, 422].includes(response.status) ? 'invalid_request' : 'request_failed';
    throw new ApiError(response.status, { code, params: { status: response.status } });
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function problemFromError(error: unknown): Problem {
  return error instanceof ApiError ? error.problem : { code: 'internal' };
}

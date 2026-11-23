/** Client for the manual-staffing backend (see server/). Disabled when no URL is configured. */
export interface Override {
  position: string;
  /** Epoch ms. */
  expires: number;
}

/** A sector handed to a position by hand ("HI-22" → "63"), overriding the SOP split. */
export interface AssignOverride {
  sector: string;
  position: string;
  /** Epoch ms. */
  expires: number;
}

const BASE = (import.meta.env.VITE_OVERRIDES_URL as string | undefined)?.replace(/\/$/, '');
export const manualEnabled = !!BASE;

const TOKEN_KEY = 'asx.token';
export const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } },
  set: (v: string) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export interface Reply { positions: Override[]; assign: AssignOverride[]; admin: boolean }

async function call(init: RequestInit & { token?: string }): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${BASE}/overrides`, { ...init, headers, cache: 'no-store' });
  if (res.status === 401) throw new Error('Wrong token');
  if (!res.ok) throw new Error(`Backend returned HTTP ${res.status}`);
  const r = (await res.json()) as Partial<Reply>;
  return { positions: r.positions ?? [], assign: r.assign ?? [], admin: !!r.admin };
}

export const fetchOverrides = (t = token.get()) => call({ token: t });
export const saveOverrides = (t: string, positions: Override[], assign: AssignOverride[]) =>
  call({ method: 'PUT', token: t, body: JSON.stringify({ positions, assign }) });

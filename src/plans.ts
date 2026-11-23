/**
 * Planned splits (admin only to write, public to read): for a time window, which positions are expected
 * and who covers which sector. On the live map a plan only applies to positions that are really online.
 * Disabled when no backend URL is configured.
 */
export interface Plan {
  id: string;
  /** Event name, e.g. "Memphis FNO". */
  name: string;
  /** Epoch ms, [start, end). */
  start: number;
  end: number;
  /** Positions expected online. */
  positions: string[];
  /** [sector key, position] pairs: "HI-30" → "31". */
  assign: [string, string][];
  /** Public remarks per expected position. */
  notes?: Record<string, string>;
  /** Admin-only remark about the whole event (never sent to other visitors). */
  remark?: string;
}

/** Sector assignments the admin makes for right now; they beat a running event, sector by sector. */
export interface LiveEdit {
  assign: [string, string][];
  /** Epoch ms. */
  expires: number;
}

export const MAX_PLAN_HOURS = 72;
export const LIVE_HOURS = [1, 2, 4, 8, 12, 24];

const BASE = (import.meta.env.VITE_OVERRIDES_URL as string | undefined)?.replace(/\/$/, '');
export const plansEnabled = !!BASE;

const TOKEN_KEY = 'asx.token';
export const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } },
  set: (v: string) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export interface Reply { plans: Plan[]; live: LiveEdit | null; admin: boolean; /** Admin only: where the server keeps events. */ storage?: string }

async function call(init: RequestInit & { token?: string }): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${BASE}/plans`, { ...init, headers, cache: 'no-store' });
  if (res.status === 401) throw new Error('Wrong token');
  if (res.status === 400) throw new Error('The server rejected this plan');
  if (!res.ok) throw new Error(`Backend returned HTTP ${res.status}`);
  const r = (await res.json()) as Partial<Reply>;
  return { plans: r.plans ?? [], live: r.live && r.live.expires > Date.now() ? r.live : null, admin: !!r.admin, storage: r.storage };
}

/** Finished events (admin only), newest first; `forget` removes one. */
export async function fetchHistory(t: string, forget?: string): Promise<Plan[]> {
  const res = await fetch(`${BASE}/plans/history${forget ? `?id=${encodeURIComponent(forget)}` : ''}`, {
    method: forget ? 'DELETE' : 'GET',
    headers: { Authorization: `Bearer ${t}` },
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('Wrong token');
  if (!res.ok) throw new Error(`Backend returned HTTP ${res.status}`);
  return ((await res.json()) as { plans?: Plan[] }).plans ?? [];
}

export const fetchPlans = (t = token.get()) => call({ token: t });
export const savePlans = (t: string, plans: Plan[], live: LiveEdit | null) =>
  call({ method: 'PUT', token: t, body: JSON.stringify({ plans, live }) });

/** Positions with sectors picked by hand in an event: they cover exactly those (the rest are Auto / SOP). */
export const exclusiveOf = (assign: Iterable<[string, string]>) => new Set([...assign].map(([, pos]) => pos));

/** The plan in force at `now` (the most recently started one if several overlap). */
export function activePlan(plans: Plan[], now = Date.now()): Plan | null {
  return plans.filter((p) => p.start <= now && now < p.end).sort((a, b) => b.start - a.start)[0] ?? null;
}

// ─── time zones ──────────────────────────────────────────────────────────────
export type Tz = 'utc' | 'local';

/** Value for <input type="datetime-local"> in the chosen zone. */
export function toInput(ms: number, tz: Tz) {
  const shift = tz === 'utc' ? 0 : new Date(ms).getTimezoneOffset() * 60_000;
  return new Date(ms - shift).toISOString().slice(0, 16);
}

export function fromInput(v: string, tz: Tz): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return Number.NaN;
  return tz === 'utc' ? Date.parse(`${v.slice(0, 16)}:00Z`) : new Date(v.slice(0, 16)).getTime();
}

export function fmtTime(ms: number, tz: Tz, withDate = true) {
  const opts: Intl.DateTimeFormatOptions = {
    ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(tz === 'utc' ? { timeZone: 'UTC' } : {}),
  };
  return new Date(ms).toLocaleString('en-GB', opts) + (tz === 'utc' ? 'Z' : '');
}

/** "Sat 23 Nov 18:00–22:00Z" (end date only shown when it differs). */
export function fmtRange(start: number, end: number, tz: Tz) {
  const sameDay = toInput(start, tz).slice(0, 10) === toInput(end, tz).slice(0, 10);
  return `${fmtTime(start, tz)} – ${fmtTime(end, tz, !sameDay)}`;
}

export const localZoneName = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'local'; }
};

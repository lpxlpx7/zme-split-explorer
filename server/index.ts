/**
 * Self-hosted server: serves the built site (dist/) and the planned-splits API.
 *
 *   GET  /api/plans   public  → { plans, live, admin }   (admin = the Bearer token is valid)
 *   PUT  /api/plans   Bearer  → replace both             (only ADMIN_TOKEN may write)
 *   GET  /api/plans/history          Bearer → { plans }   finished events, newest first
 *   DELETE /api/plans/history?id=…   Bearer → { plans }   forget one finished event
 *
 * A plan (event) says, for a time window, which positions are expected and who covers which sector;
 * Everyone sees events including their per-position notes; only the event `remark` is admin-only. `live` holds sector assignments the admin
 * makes for right now (they win over the event). Who is online always comes from VATSIM.
 * Env: ADMIN_TOKEN (required, >= 16 chars) · PORT=8787 · HOST=127.0.0.1 · DATA_FILE=data/plans.json
 *      STATIC_DIR=dist · ALLOWED_ORIGIN (only if the site is served from a different origin)
 *      MYSQL_URL, or MYSQL_HOST/PORT/USER/PASSWORD/DATABASE: keep events in MySQL instead of DATA_FILE (see store.ts)
 * Finished plans are dropped automatically.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileStorage, mysqlConfigured, mysqlStorage, type Live, type Plan } from './store';

// Paths are relative to the project root (not the cwd), so any process manager can start this.
const ROOT = resolve(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* no .env — use the real environment */ }

const TOKEN = process.env.ADMIN_TOKEN ?? '';
if (TOKEN.length < 16) {
  console.error('Set ADMIN_TOKEN to a random string of at least 16 characters.');
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_FILE = resolve(ROOT, process.env.DATA_FILE ?? 'data/plans.json');
const STATIC_DIR = resolve(ROOT, process.env.STATIC_DIR ?? 'dist');
const ORIGIN = process.env.ALLOWED_ORIGIN;
const MAX_PLAN_MS = 72 * 3_600_000;
const MAX_AHEAD_MS = 90 * 86_400_000;
const MAX_PLANS = 50;
const MAX_LIVE_MS = 48 * 3_600_000;

const storage = mysqlConfigured(process.env) ? await mysqlStorage(process.env, DATA_FILE) : fileStorage(DATA_FILE);
const { load, save } = storage;
const HISTORY_LIMIT = 200;

const sha = (s: string) => createHash('sha256').update(s).digest();
const tokenHash = sha(TOKEN);
const isAdmin = (req: IncomingMessage) => {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return !!given && timingSafeEqual(sha(given), tokenHash);
};

const POS = /^\d{2}$/;
const SECTOR = /^(LO|HI|UH)-\d{2}$/;

function sanitizeAssign(input: unknown, allowed?: string[]): [string, string][] | null {
  if (!Array.isArray(input) || input.length > 80) return null;
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const a of input) {
    if (!Array.isArray(a) || typeof a[0] !== 'string' || typeof a[1] !== 'string' || !SECTOR.test(a[0]) || !POS.test(a[1])) return null;
    if (seen.has(a[0]) || (allowed && !allowed.includes(a[1]))) continue;
    seen.add(a[0]);
    out.push([a[0], a[1]]);
  }
  return out;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
/** Like clean, but keeps line breaks (multi-line remarks). */
const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function sanitizeLive(input: unknown): Live | null | undefined {
  if (input === null || input === undefined) return null;
  const l = input as { assign?: unknown; expires?: unknown };
  const now = Date.now();
  const expires = Number(l.expires);
  const assign = sanitizeAssign(l.assign);
  if (!assign || !Number.isFinite(expires)) return undefined; // malformed
  if (expires <= now || !assign.length) return null;
  return { assign, expires: Math.min(expires, now + MAX_LIVE_MS) };
}

/** Validate the whole list; null if anything is malformed. Finished plans are dropped. */
function sanitize(input: unknown): Plan[] | null {
  if (!Array.isArray(input) || input.length > MAX_PLANS) return null;
  const now = Date.now();
  const ids = new Set<string>();
  const out: Plan[] = [];
  for (const p of input) {
    const id = typeof p?.id === 'string' ? p.id : '';
    const start = Number(p?.start);
    const end = Number(p?.end);
    if (!/^[a-z0-9]{1,24}$/.test(id) || ids.has(id)) return null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_PLAN_MS || start > now + MAX_AHEAD_MS) return null;
    if (!Array.isArray(p.positions) || p.positions.length > 40 || !p.positions.every((x: unknown) => typeof x === 'string' && POS.test(x))) return null;
    const positions = [...new Set<string>(p.positions)];
    const assign = sanitizeAssign(p.assign, positions);
    const name = clean(p.name, 60);
    if (!assign || !name) return null;
    const notes: Record<string, string> = {};
    if (p.notes && typeof p.notes === 'object')
      for (const [k, v] of Object.entries(p.notes as Record<string, unknown>)) {
        const note = clean(v, 120);
        if (positions.includes(k) && note) notes[k] = note;
      }
    ids.add(id);
    const remark = cleanText(p.remark, 1000);
    if (end > now) out.push({ id, name, start, end, positions, assign, notes, ...(remark ? { remark } : {}) });
  }
  return out;
}

function readBody(req: IncomingMessage, limit = 131_072): Promise<unknown> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { fail(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(ORIGIN ? { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS' } : {}),
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/geo+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(url: URL, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, '');
  let file = join(STATIC_DIR, rel);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    // Pretty URLs: /admin → admin.html
    try {
      if (extname(file)) throw new Error('has extension');
      await stat(`${file}.html`);
      file = `${file}.html`;
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/plans') {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (req.method === 'GET') {
        const admin = isAdmin(req);
        const { plans, live } = await load();
        // Notes are for the admin only.
        // The event remark is for the admin only; everything else (including position notes) is public.
        return send(res, 200, { plans: admin ? plans : plans.map(({ remark: _, ...p }) => p), live, admin, ...(admin ? { storage: storage.kind } : {}) });
      }
      if (req.method === 'PUT') {
        if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
        const body = (await readBody(req)) as { plans?: unknown; live?: unknown } | null;
        const plans = sanitize(body?.plans);
        const live = sanitizeLive(body?.live);
        if (!plans || live === undefined) return send(res, 400, { error: 'invalid body' });
        await save({ plans, live });
        return send(res, 200, { plans, live, admin: true });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (url.pathname === '/api/plans/history') {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^[a-z0-9]{1,24}$/.test(id)) return send(res, 400, { error: 'invalid id' });
        await storage.forget(id);
      } else if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { plans: await storage.history(HISTORY_LIMIT) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    await serveStatic(url, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, HOST, () => console.log(`ZME Split Explorer on http://${HOST}:${PORT}  (static: ${STATIC_DIR}, data: ${storage.kind})`));

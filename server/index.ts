/**
 * Self-hosted server: serves the built site (dist/) and the manual-staffing API.
 *
 *   GET  /api/overrides   public  → { positions, assign, admin }   (admin = the Bearer token is valid)
 *   PUT  /api/overrides   Bearer  → replace both lists              (only ADMIN_TOKEN may write)
 *
 * positions: manually staffed positions · assign: sectors handed to a position by hand.
 *
 * Env: ADMIN_TOKEN (required, >= 16 chars) · PORT=8787 · HOST=127.0.0.1 · DATA_FILE=data/overrides.json
 *      STATIC_DIR=dist · ALLOWED_ORIGIN (only if the site is served from a different origin)
 * Entries always expire (max 48 h), so a forgotten one clears itself.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

interface Override { position: string; expires: number }
interface Assign { sector: string; position: string; expires: number }
interface Store { positions: Override[]; assign: Assign[] }

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
const DATA_FILE = resolve(ROOT, process.env.DATA_FILE ?? 'data/overrides.json');
const STATIC_DIR = resolve(ROOT, process.env.STATIC_DIR ?? 'dist');
const ORIGIN = process.env.ALLOWED_ORIGIN;
const MAX_TTL_MS = 48 * 3_600_000;
const MAX_ENTRIES = 40;
const MAX_ASSIGN = 80;

const sha = (s: string) => createHash('sha256').update(s).digest();
const tokenHash = sha(TOKEN);
const isAdmin = (req: IncomingMessage) => {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return !!given && timingSafeEqual(sha(given), tokenHash);
};

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8')) as Store | Override[];
    // Older files hold just the positions array.
    const s: Store = Array.isArray(raw) ? { positions: raw, assign: [] } : { positions: raw.positions ?? [], assign: raw.assign ?? [] };
    const now = Date.now();
    return { positions: s.positions.filter((o) => o.expires > now), assign: s.assign.filter((a) => a.expires > now) };
  } catch {
    return { positions: [], assign: [] };
  }
}

async function save(store: Store) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, DATA_FILE); // atomic: a crash never leaves a half-written file
}

function sanitize(input: unknown): Override[] | null {
  if (!Array.isArray(input) || input.length > MAX_ENTRIES) return null;
  const now = Date.now();
  const seen = new Set<string>();
  const out: Override[] = [];
  for (const o of input) {
    const position = typeof o?.position === 'string' ? o.position : '';
    const expires = Number(o?.expires);
    if (!/^\d{2}$/.test(position) || !Number.isFinite(expires)) return null;
    if (seen.has(position) || expires <= now) continue;
    seen.add(position);
    out.push({ position, expires: Math.min(expires, now + MAX_TTL_MS) });
  }
  return out;
}

function sanitizeAssign(input: unknown): Assign[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ASSIGN) return null;
  const now = Date.now();
  const seen = new Set<string>();
  const out: Assign[] = [];
  for (const a of input) {
    const sector = typeof a?.sector === 'string' ? a.sector : '';
    const position = typeof a?.position === 'string' ? a.position : '';
    const expires = Number(a?.expires);
    if (!/^(LO|HI|UH)-\d{2}$/.test(sector) || !/^\d{2}$/.test(position) || !Number.isFinite(expires)) return null;
    if (seen.has(sector) || expires <= now) continue;
    seen.add(sector);
    out.push({ sector, position, expires: Math.min(expires, now + MAX_TTL_MS) });
  }
  return out;
}

function readBody(req: IncomingMessage, limit = 16_384): Promise<unknown> {
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
    ...(ORIGIN ? { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' } : {}),
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
    return send(res, 404, { error: 'not found' });
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
    if (url.pathname === '/api/overrides') {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (req.method === 'GET') return send(res, 200, { ...(await load()), admin: isAdmin(req) });
      if (req.method === 'PUT') {
        if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
        const body = (await readBody(req)) as { positions?: unknown; assign?: unknown } | null;
        const positions = sanitize(body?.positions);
        const assign = sanitizeAssign(body?.assign);
        if (!positions || !assign) return send(res, 400, { error: 'invalid body' });
        await save({ positions, assign });
        return send(res, 200, { positions, assign, admin: true });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    await serveStatic(url, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, HOST, () => console.log(`ZME Split Explorer on http://${HOST}:${PORT}  (static: ${STATIC_DIR}, data: ${DATA_FILE})`));

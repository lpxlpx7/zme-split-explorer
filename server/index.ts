/**
 * Self-hosted server: serves the built site (dist/) and the planned-splits API.
 *
 *   GET  /api/plans   public  → { plans, admin }   (admin = the Bearer token is valid)
 *   PUT  /api/plans   Bearer  → replace the list   (only ADMIN_TOKEN may write)
 *
 * A plan says, for a time window, which positions are expected and who covers which sector.
 * Env: ADMIN_TOKEN (required, >= 16 chars) · PORT=8787 · HOST=127.0.0.1 · DATA_FILE=data/plans.json
 *      STATIC_DIR=dist · ALLOWED_ORIGIN (only if the site is served from a different origin)
 * Finished plans are dropped automatically.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

interface Plan { id: string; start: number; end: number; positions: string[]; assign: [string, string][] }

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

const sha = (s: string) => createHash('sha256').update(s).digest();
const tokenHash = sha(TOKEN);
const isAdmin = (req: IncomingMessage) => {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return !!given && timingSafeEqual(sha(given), tokenHash);
};

async function load(): Promise<Plan[]> {
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8')) as { plans?: Plan[] };
    return (raw.plans ?? []).filter((p) => p.end > Date.now());
  } catch {
    return [];
  }
}

async function save(plans: Plan[]) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ plans }));
  await rename(tmp, DATA_FILE); // atomic: a crash never leaves a half-written file
}

const POS = /^\d{2}$/;
const SECTOR = /^(LO|HI|UH)-\d{2}$/;

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
    if (!Array.isArray(p.assign) || p.assign.length > 80) return null;
    const assign: [string, string][] = [];
    const seen = new Set<string>();
    for (const a of p.assign) {
      if (!Array.isArray(a) || typeof a[0] !== 'string' || typeof a[1] !== 'string' || !SECTOR.test(a[0]) || !POS.test(a[1])) return null;
      if (seen.has(a[0]) || !positions.includes(a[1])) continue;
      seen.add(a[0]);
      assign.push([a[0], a[1]]);
    }
    ids.add(id);
    if (end > now) out.push({ id, start, end, positions, assign });
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
    if (url.pathname === '/api/plans') {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (req.method === 'GET') return send(res, 200, { plans: await load(), admin: isAdmin(req) });
      if (req.method === 'PUT') {
        if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
        const plans = sanitize(((await readBody(req)) as { plans?: unknown } | null)?.plans);
        if (!plans) return send(res, 400, { error: 'invalid body' });
        await save(plans);
        return send(res, 200, { plans, admin: true });
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

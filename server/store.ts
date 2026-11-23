/**
 * Where events (plans) and live edits are kept.
 *
 * - MySQL / MariaDB when MYSQL_URL (mysql://user:pass@host:3306/db) or MYSQL_HOST + MYSQL_USER +
 *   MYSQL_PASSWORD + MYSQL_DATABASE (+ MYSQL_PORT) are set. The tables are created on start, and an
 *   existing data/plans.json is imported once while the tables are empty. Finished events stay in the
 *   table as history; only events the admin deletes are removed.
 * - Otherwise a JSON file (DATA_FILE, default data/plans.json), as before.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface Plan { id: string; name: string; start: number; end: number; positions: string[]; assign: [string, string][]; notes: Record<string, string> }
export interface Live { assign: [string, string][]; expires: number }
export interface Store { plans: Plan[]; live: Live | null }

export interface Storage {
  readonly kind: string;
  /** Running and upcoming events, and live edits that have not expired. */
  load(): Promise<Store>;
  /** Replace the running/upcoming events and the live edits. */
  save(store: Store): Promise<void>;
}

/** Drop what is over; tolerate files written by older versions. */
function current(raw: Partial<Store>): Store {
  const now = Date.now();
  return {
    plans: (raw.plans ?? []).filter((p) => p.end > now).map((p) => ({ ...p, name: p.name ?? 'Event', notes: p.notes ?? {} })),
    live: raw.live && raw.live.expires > now ? raw.live : null,
  };
}

async function readJson(file: string): Promise<Partial<Store> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Partial<Store>;
  } catch {
    return null;
  }
}

export function fileStorage(file: string): Storage {
  return {
    kind: `file ${file}`,
    load: async () => current((await readJson(file)) ?? {}),
    async save(store) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(store));
      await rename(tmp, file); // atomic: a crash never leaves a half-written file
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS zme_plans (
     id         VARCHAR(24)  NOT NULL PRIMARY KEY,
     name       VARCHAR(60)  NOT NULL,
     start_ms   BIGINT       NOT NULL,
     end_ms     BIGINT       NOT NULL,
     positions  TEXT         NOT NULL,
     assign     TEXT         NOT NULL,
     notes      TEXT         NOT NULL,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_end (end_ms)
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS zme_live (
     id         TINYINT      NOT NULL PRIMARY KEY,
     assign     TEXT         NOT NULL,
     expires_ms BIGINT       NOT NULL
   ) DEFAULT CHARSET=utf8mb4`,
];

interface PlanRow extends RowDataPacket { id: string; name: string; start_ms: number | string; end_ms: number | string; positions: string; assign: string; notes: string }
interface LiveRow extends RowDataPacket { assign: string; expires_ms: number | string }

export async function mysqlStorage(env: NodeJS.ProcessEnv, legacyFile: string): Promise<Storage> {
  const mysql = await import('mysql2/promise');
  const pool: Pool = env.MYSQL_URL
    ? mysql.createPool({ uri: env.MYSQL_URL, connectionLimit: 5, supportBigNumbers: true })
    : mysql.createPool({
        host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT ?? 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
        database: env.MYSQL_DATABASE, connectionLimit: 5, supportBigNumbers: true,
      });
  for (const sql of SCHEMA) await pool.query(sql);

  const storage: Storage = {
    kind: `mysql ${env.MYSQL_URL ? new URL(env.MYSQL_URL).host : `${env.MYSQL_HOST}:${env.MYSQL_PORT ?? 3306}`}/${env.MYSQL_URL ? new URL(env.MYSQL_URL).pathname.slice(1) : env.MYSQL_DATABASE}`,
    async load() {
      const now = Date.now();
      const [rows] = await pool.query<PlanRow[]>('SELECT * FROM zme_plans WHERE end_ms > ? ORDER BY start_ms', [now]);
      const [live] = await pool.query<LiveRow[]>('SELECT assign, expires_ms FROM zme_live WHERE id = 1 AND expires_ms > ?', [now]);
      return {
        plans: rows.map((r) => ({
          id: r.id, name: r.name, start: Number(r.start_ms), end: Number(r.end_ms),
          positions: JSON.parse(r.positions), assign: JSON.parse(r.assign), notes: JSON.parse(r.notes),
        })),
        live: live[0] ? { assign: JSON.parse(live[0].assign), expires: Number(live[0].expires_ms) } : null,
      };
    },
    async save({ plans, live }) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Events the admin removed (still running or upcoming, not in the new list). Finished ones are kept.
        const ids = plans.map((p) => p.id);
        await conn.query(
          `DELETE FROM zme_plans WHERE end_ms > ?${ids.length ? ' AND id NOT IN (?)' : ''}`,
          ids.length ? [Date.now(), ids] : [Date.now()],
        );
        for (const p of plans)
          await conn.query(
            `INSERT INTO zme_plans (id, name, start_ms, end_ms, positions, assign, notes) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), start_ms = VALUES(start_ms), end_ms = VALUES(end_ms),
               positions = VALUES(positions), assign = VALUES(assign), notes = VALUES(notes)`,
            [p.id, p.name, p.start, p.end, JSON.stringify(p.positions), JSON.stringify(p.assign), JSON.stringify(p.notes)],
          );
        if (live)
          await conn.query(
            'INSERT INTO zme_live (id, assign, expires_ms) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE assign = VALUES(assign), expires_ms = VALUES(expires_ms)',
            [JSON.stringify(live.assign), live.expires],
          );
        else await conn.query('DELETE FROM zme_live WHERE id = 1');
        await conn.commit();
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
  };

  // One-time import of the JSON file used before MySQL was set up.
  const [[{ n }]] = await pool.query<(RowDataPacket & { n: number })[]>('SELECT (SELECT COUNT(*) FROM zme_plans) + (SELECT COUNT(*) FROM zme_live) AS n');
  const legacy = Number(n) === 0 ? await readJson(legacyFile) : null;
  if (legacy) {
    const store = current(legacy);
    if (store.plans.length || store.live) {
      await storage.save(store);
      console.log(`Imported ${store.plans.length} event(s) from ${legacyFile} into MySQL.`);
    }
  }
  return storage;
}

export const mysqlConfigured = (env: NodeJS.ProcessEnv) => !!(env.MYSQL_URL || env.MYSQL_HOST);

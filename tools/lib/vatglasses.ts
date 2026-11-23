/**
 * VATGlasses data (https://github.com/vatglasses-project/vatglasses-data):
 * FIR/ARTCC outlines for every facility, plus full sector + ownership data where a
 * facility has published it (ZHU and ZJX among ZME's neighbours).
 */
import fs from 'node:fs';
import path from 'node:path';
import { polygon, unionAll, type Geom, type Pos } from './geom.ts';

const RAW = 'https://raw.githubusercontent.com/vatglasses-project/vatglasses-data/main/data';

type DmsPoint = [string, string];
interface VgSector {
  min?: number | null;
  max?: number | null;
  points: DmsPoint[];
}
interface VgAirspace {
  id: string;
  group: string;
  owner?: string[];
  sectors: VgSector[];
}
interface VgPosition {
  callsign: string;
  frequency: string;
  type: string;
  pre: string[];
}

export interface VgFile {
  airspace: VgAirspace[] | Record<string, VgAirspace>;
  positions?: Record<string, VgPosition>;
}

/** Downloads (or reuses a cached copy of) one VATGlasses data file. */
export async function fetchVg<T>(rel: string, cacheDir: string, refresh: boolean): Promise<T> {
  const file = path.join(cacheDir, rel.replaceAll('/', '__'));
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  const res = await fetch(`${RAW}/${rel}`);
  if (!res.ok) throw new Error(`VATGlasses ${rel}: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, text);
  return JSON.parse(text) as T;
}

/** "352259" / "-0794815" (DDMMSS / DDDMMSS, optional decimals) → decimal degrees. */
export function dms(s: string, degDigits: 2 | 3): number {
  const neg = s.startsWith('-');
  const t = s.replace(/^[-+]/, '');
  const [int, frac = ''] = t.split('.');
  const d = Number(int.slice(0, degDigits));
  const m = Number(int.slice(degDigits, degDigits + 2));
  const sec = Number(`${int.slice(degDigits + 2)}${frac ? `.${frac}` : ''}`);
  const v = d + m / 60 + sec / 3600;
  return neg ? -v : v;
}

export const ring = (pts: DmsPoint[]): Pos[] => {
  const r = pts.map(([lat, lon]) => [dms(lon, 3), dms(lat, 2)] as Pos);
  const [a, b] = [r[0], r[r.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
  return r;
};

const sectorPolygon = (s: VgSector): Geom | null => {
  const r = ring(s.points);
  if (r.length < 4) return null;
  return polygon(r).buffer(0);
};

const NON_ENROUTE = new Set(['APP', 'DEP', 'TWR', 'GND', 'DEL', 'RAP', 'FSS', 'ATIS']);

export interface VgCenterSector {
  key: string;
  name: string;
  min: number;
  max: number;
  g: Geom;
}

export interface VgFacility {
  /** ICAO-style ARTCC id, e.g. ZHU. */
  id: string;
  name: string;
  outline: Geom;
  prefixes: string[];
  /** Only for facilities with detailed VATGlasses data. */
  sectors?: VgCenterSector[];
  positions?: Record<string, { frequency: string; prefixes: string[] }>;
  ownership?: Record<string, string[]>;
}

/** FIR outlines from data/nodata.json (facilities without detailed data), keyed by owner id (KZKC → ZKC). */
export function firOutlines(nodata: VgFile): Map<string, { name: string; outline: Geom; prefixes: string[] }> {
  const out = new Map<string, { name: string; outline: Geom; prefixes: string[] }>();
  const list = Array.isArray(nodata.airspace) ? nodata.airspace : Object.values(nodata.airspace);
  for (const a of list) {
    const owner = a.owner?.[0];
    if (!owner || !/^KZ[A-Z]{2}$/.test(owner)) continue;
    const id = owner.slice(1);
    const polys = a.sectors.map(sectorPolygon).filter((g): g is Geom => !!g);
    const prev = out.get(id);
    out.set(id, {
      name: a.id,
      outline: unionAll(prev ? [prev.outline, ...polys] : polys),
      prefixes: nodata.positions?.[owner]?.pre ?? [],
    });
  }
  return out;
}

/** A facility with its own VATGlasses folder (airspace.json, positions.json, ownership/default.json). */
export function detailedFacility(
  id: string,
  name: string,
  airspace: VgFile,
  positions: { positions: Record<string, VgPosition> },
  ownership: { airspace: Record<string, string[]> } | null,
): VgFacility {
  const entries = Array.isArray(airspace.airspace)
    ? airspace.airspace.map((a, i) => [String(i), a] as const)
    : Object.entries(airspace.airspace);
  const sectors: VgCenterSector[] = [];
  for (const [key, a] of entries) {
    if (NON_ENROUTE.has(a.group)) continue;
    for (const s of a.sectors) {
      const g = sectorPolygon(s);
      if (g && g.getArea() > 0) sectors.push({ key, name: a.id, min: s.min ?? 0, max: s.max ?? 999, g });
    }
  }
  const ctr = Object.entries(positions.positions).filter(([, p]) => p.type === 'CTR');
  return {
    id,
    name,
    outline: unionAll(sectors.map((s) => s.g)).buffer(0),
    prefixes: [...new Set(ctr.flatMap(([, p]) => p.pre))],
    sectors,
    positions: Object.fromEntries(ctr.map(([k, p]) => [k, { frequency: p.frequency, prefixes: p.pre }])),
    ownership: ownership?.airspace,
  };
}

/**
 * Builds public/data/* from a local CRC install (ZME video maps) and VATGlasses.
 *
 *   npm run data                       # uses %LOCALAPPDATA%\CRC, cached VATGlasses data
 *   npm run data -- --refresh          # re-download VATGlasses
 *   npm run data -- --crc D:\CRC       # or set CRC_DIR
 *
 * `npm run dev` runs this automatically when the video maps are newer than the output
 * (see vite.config.ts), so you normally never need to call it by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interiorXY, lineParts, polygons, rounded, simplify, type Geom } from './lib/geom.ts';
import { buildNeighbors } from './lib/neighbors.ts';
import { detailedFacility, fetchVg, firOutlines, type VgFacility, type VgFile } from './lib/vatglasses.ts';
import { VideoMaps, defaultCrcDir } from './lib/videomaps.ts';
import { ALL_MAPS, MAPS, buildZme } from './lib/zme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'vatglasses');
const META = 'meta.json';
/** Bump when the output format changes so `npm run dev` rebuilds. */
const FORMAT = 2;

/** ZME's neighbours: [id, VATGlasses folder (detailed data) or null (outline only from nodata.json)]. */
const NEIGHBORS: [string, string | null][] = [
  ['ZKC', null],
  ['ZID', null],
  ['ZTL', null],
  ['ZJX', 'zjx'],
  ['ZHU', 'zhu'],
  ['ZFW', null],
];
const NAMES: Record<string, string> = { ZHU: 'Houston', ZJX: 'Jacksonville', ZAB: 'Albuquerque', ZAU: 'Chicago', ZLC: 'Salt Lake', ZMA: 'Miami', ZNY: 'New York', ZOA: 'Oakland', ZSE: 'Seattle' };
/** Other CONUS ARTCCs that have their own VATGlasses data (outline only). */
const OTHER_DETAILED = ['zab', 'zau', 'zlc', 'zma', 'zny', 'zoa'];

interface Options {
  crcDir?: string;
  refresh?: boolean;
  log?: (msg: string) => void;
}

interface Meta {
  format: number;
  sources: number;
  builtAt: string;
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
const feat = (g: Geom, properties: GeoJSON.GeoJsonProperties, nd = 5): GeoJSON.Feature => ({ type: 'Feature', properties, geometry: rounded(g, nd) });
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data));

/**
 * True when CRC is installed here and the output is missing, from an older format, or older
 * than the video maps. Machines without CRC (e.g. CI) always keep the committed data.
 */
export function isStale(crcDir = defaultCrcDir()): boolean {
  let sources: number;
  try {
    sources = new VideoMaps(crcDir).mtime(ALL_MAPS);
  } catch {
    return false;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, META), 'utf8')) as Meta;
    return meta.format !== FORMAT || sources > meta.sources;
  } catch {
    return true;
  }
}

export async function buildData({ crcDir = defaultCrcDir(), refresh = false, log = console.log }: Options = {}) {
  const t0 = Date.now();
  const vm = new VideoMaps(crcDir);
  const zme = buildZme(vm);
  log(`ZME: ${zme.sectors.size} sectors, ${zme.pieces.length} pieces`);

  // ── VATGlasses ────────────────────────────────────────────────────────────
  const vg = <T>(rel: string) => fetchVg<T>(rel, CACHE_DIR, refresh);
  const nodata = await vg<VgFile>('nodata.json');
  const firs = firOutlines(nodata);
  const detailed = async (folder: string): Promise<VgFacility> => {
    const id = folder.toUpperCase();
    const ownership = await vg<{ airspace: Record<string, string[]> }>(`${folder}/ownership/default.json`).catch(() => null);
    return detailedFacility(id, NAMES[id] ?? id, await vg(`${folder}/airspace.json`), await vg(`${folder}/positions.json`), ownership);
  };
  const neighbors: VgFacility[] = [];
  for (const [id, folder] of NEIGHBORS) {
    if (folder) neighbors.push(await detailed(folder));
    else {
      const f = firs.get(id);
      if (!f) throw new Error(`VATGlasses has no outline for ${id}`);
      neighbors.push({ id, name: f.name, outline: f.outline, prefixes: f.prefixes });
    }
  }
  const others = await Promise.all(OTHER_DETAILED.map(detailed));
  const zse = await vg<VgFile>('zse.json').then((d) => detailedFacility('ZSE', NAMES.ZSE, d, { positions: {} }, null)).catch(() => null);

  // ── Neighbour sectors ─────────────────────────────────────────────────────
  const nb = buildNeighbors(
    vm,
    [
      { stratum: 'LO', zme: zme.zmeLo, sectorMap: MAPS.LO_NEIGHBORS },
      { stratum: 'HI', zme: zme.zmeHi, sectorMap: MAPS.HI },
      { stratum: 'UH', zme: zme.zmeHi, sectorMap: MAPS.UH },
    ],
    neighbors,
  );
  log(`Neighbours: ${nb.length} sectors in ${neighbors.map((n) => n.id).join(' ')}`);

  // ── Write ─────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sectors = [...zme.sectors.values()].sort((a, b) => `${a.stratum}-${a.sector}`.localeCompare(`${b.stratum}-${b.sector}`));
  write('sectors.geojson', fc(sectors.map((s) => feat(s.g, { stratum: s.stratum, sector: s.sector }))));
  write('pieces.geojson', fc(zme.pieces.map((p) => feat(p.g, { pid: p.pid, stratum: p.stratum, sector: p.sector, region: p.region, hi: p.hi }))));
  write('labels.geojson', fc(sectors.map((s) => {
    const big = polygons(s.g).sort((a, b) => b.getArea() - a.getArea())[0];
    return { type: 'Feature', properties: { stratum: s.stratum, sector: s.sector }, geometry: { type: 'Point', coordinates: interiorXY(big).map((v) => Math.round(v * 1e5) / 1e5) } };
  })));
  write('regions.geojson', fc([...zme.regions].map(([region, g]) => feat(g, { region }))));
  write('boundary.geojson', fc([
    feat(polygons(zme.zmeLo)[0].getExteriorRing(), { name: 'ZME', stratum: 'LO' }),
    feat(polygons(zme.zmeHi)[0].getExteriorRing(), { name: 'ZME', stratum: 'HI' }),
  ]));
  write('neighbor-sectors.geojson', fc(nb.map((p) => feat(p.g, { nid: p.nid, artcc: p.artcc, stratum: p.stratum, sector: p.sector, name: p.name }))));

  // Other ARTCCs: VATGlasses outlines (ZME itself comes from the video maps).
  const outlines = new Map<string, { name: string; g: Geom }>();
  for (const [id, f] of firs) if (id !== 'ZME') outlines.set(id, { name: f.name, g: f.outline });
  for (const f of [...neighbors, ...others, ...(zse ? [zse] : [])]) outlines.set(f.id, { name: f.name, g: f.outline });
  const artccs: GeoJSON.Feature[] = [];
  for (const [id, { name, g }] of outlines) {
    const main = polygons(g).sort((a, b) => b.getArea() - a.getArea());
    for (const p of main) {
      if (p.getArea() < 0.5) continue;
      for (const l of lineParts(simplify(p, 0.01).getBoundary())) artccs.push(feat(l, { kind: 'line', id }, 4));
    }
    if (main[0]) artccs.push({ type: 'Feature', properties: { kind: 'label', id, name }, geometry: { type: 'Point', coordinates: interiorXY(main[0]).map((v) => Math.round(v * 1e4) / 1e4) } });
  }
  write('artccs.geojson', fc(artccs));

  // Runtime config for live neighbour ownership.
  write('neighbors.json', {
    facilities: neighbors.map((f) => ({
      id: f.id,
      name: f.name,
      prefixes: f.prefixes,
      positions: f.positions ? Object.fromEntries(Object.entries(f.positions).map(([k, p]) => [k, p.frequency])) : null,
      ownership: f.ownership ?? null,
      sectorNames: f.sectors ? Object.fromEntries(f.sectors.map((s) => [s.key, s.name])) : null,
    })),
  });

  const meta: Meta = { format: FORMAT, sources: vm.mtime(ALL_MAPS), builtAt: new Date().toISOString() };
  write(META, meta);
  // The old CNTR-line context layer is superseded by artccs.geojson.
  fs.rmSync(path.join(OUT_DIR, 'neighbors.geojson'), { force: true });
  log(`Wrote ${OUT_DIR} in ${Date.now() - t0} ms`);
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const crc = args.includes('--crc') ? args[args.indexOf('--crc') + 1] : undefined;
  buildData({ crcDir: crc, refresh: args.includes('--refresh') }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

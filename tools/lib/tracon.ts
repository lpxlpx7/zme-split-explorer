/**
 * TRACON airspace (BNA, M03) from the STARS video maps.
 *
 * The flow maps draw every sector line, mostly dashed, so the dashes are joined back into lines,
 * polygonized and clipped to the TRACON boundary. Each face then gets its stack of owners
 * (position, floor, ceiling) from the anchor points in tracon-defs.ts, read off the SOP appendices.
 */
import { closeChains, joinDashes } from './dashes.ts';
import { interiorXY, line, point, nodeLines, polygon, polygonize, polygons, read, toGeoJSON, unionAll, type Geom, type Pos } from './geom.ts';
import type { VideoMaps } from './videomaps.ts';

/** Altitudes in hundreds of feet; 0 is the surface. */
export interface Layer {
  pos: string;
  lo: number;
  hi: number;
  /** Who takes this layer when `pos` is closed, before the position's usual fallback (e.g. ARN → ARW on the runway 9 side). */
  via?: string[];
}

export interface Area {
  /** Points (lon/lat) inside each face this area covers. */
  at: Pos[];
  layers: Layer[];
}

export interface TraconConfig {
  id: string;
  name: string;
  maps: string[];
  /** Extra lines (lon/lat) for boundaries the video map does not draw. */
  cuts?: Pos[][];
  areas: Area[];
}

export interface TraconDef {
  id: string;
  name: string;
  /** Video map holding the TRACON boundary, or 'hull' for the outline of the flow map itself. */
  boundary: string;
  configs: TraconConfig[];
}

export interface Face {
  g: Geom;
  layers: Layer[];
}

const NM2 = (g: Geom, lat: number) => g.getArea() * 3600 * Math.cos((lat * Math.PI) / 180);

function linework(vm: VideoMaps, maps: string[], cuts: Pos[][] = [], ring?: Pos[]): Geom {
  let chains = joinDashes(vm.coords(maps), { maxGap: 2.6, maxAngle: 25, minLength: 2 });
  if (ring) {
    // The map's own (often broken) copy of the boundary is replaced by the clean ring.
    const r = line(ring);
    const near = (p: Pos) => r.distance(point(p[0], p[1])) * 60 < 0.4;
    // Drop the segments that run along the ring (both ends on it); keep the rest as runs.
    const runs: Pos[][] = [];
    for (const c of chains) {
      const nearFlags = c.map(near);
      let run: Pos[] = [];
      for (let i = 1; i < c.length; i++) {
        if (nearFlags[i - 1] && nearFlags[i]) {
          if (run.length > 1) runs.push(run);
          run = [];
          continue;
        }
        if (!run.length) run.push(c[i - 1]);
        run.push(c[i]);
      }
      if (run.length > 1) runs.push(run);
    }
    chains = [...runs, ring];
  }
  // Hand-drawn cuts are snapped onto the lines they end near, like the dashes.
  chains = closeChains(chains, 1.2, 6);
  if (cuts.length) chains = closeChains([...chains, ...cuts], 0, 3, 4, false);
  // Snap every vertex to the noder's grid first, or near-identical points leave hairline gaps.
  const snap = (c: Pos[]) => c.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5] as Pos);
  return nodeLines(chains.map((c) => line(snap(c))));
}

/** Faces of the linework; holes left by small symbols drawn inside a sector are filled. */
function faces(lines: Geom, lat: number): Geom[] {
  return polygonize(lines).map((f) => {
    const j = toGeoJSON(f) as GeoJSON.Polygon;
    const keep = j.coordinates.slice(1).filter((h) => NM2(polygon(h as Pos[]), lat) >= 2);
    return read({ type: 'Polygon', coordinates: [j.coordinates[0], ...keep] });
  });
}

const ringOf = (g: Geom): Pos[] => (toGeoJSON(g) as GeoJSON.Polygon).coordinates[0] as Pos[];

export function traconBoundary(vm: VideoMaps, def: TraconDef): Geom {
  const maps = def.boundary === 'hull' ? def.configs[0].maps : [def.boundary];
  const lat = vm.coords(maps)[0][0][1];
  const fs = faces(linework(vm, maps), lat);
  if (def.boundary === 'hull') {
    const u = unionAll(fs.filter((f) => NM2(f, lat) > 2));
    const main = polygons(u).sort((a, b) => b.getArea() - a.getArea())[0];
    return polygon(ringOf(main));
  }
  return fs.sort((a, b) => b.getArea() - a.getArea())[0];
}

/** Raw faces of one configuration, clipped to the boundary; slivers merged into a neighbour. */
export function configFaces(vm: VideoMaps, boundary: Geom, cfg: TraconConfig): Geom[] {
  const lat = interiorXY(boundary)[1];
  let fs = faces(linework(vm, cfg.maps, cfg.cuts, ringOf(boundary)), lat)
    .flatMap((f) => polygons(f.intersection(boundary)))
    .filter((f) => NM2(f, lat) > 0.05);
  // Slivers (thin or tiny) are merged into the neighbour they share the longest edge with.
  const thin = (f: Geom) => {
    const a = NM2(f, lat);
    const perim = f.getLength() * 60 * Math.cos((lat * Math.PI) / 180);
    return a < 2 || (2 * a) / perim < 0.6;
  };
  // Decided once, on the raw faces, so merged faces never cascade.
  const slivers = fs.filter(thin).sort((x, y) => x.getArea() - y.getArea());
  fs = fs.filter((f) => !thin(f));
  for (const f of slivers) {
    let best = -1;
    let bestLen = 0;
    fs.forEach((g, j) => {
      const shared = f.buffer(1e-5).intersection(g.getBoundary()).getLength();
      if (shared > bestLen) {
        bestLen = shared;
        best = j;
      }
    });
    if (best >= 0 && bestLen * 60 >= 0.3) fs[best] = polygons(fs[best].union(f)).sort((x, y) => y.getArea() - x.getArea())[0];
  }
  return fs.sort((a, b) => b.getArea() - a.getArea());
}

/** Gives every face its stack of layers; faces no area points at are reported. */
export function assign(fs: Geom[], cfg: TraconConfig, warn: (m: string) => void): Face[] {
  const out: Face[] = fs.map((g) => ({ g, layers: [] }));
  for (const a of cfg.areas)
    for (const p of a.at) {
      const pt = point(p[0], p[1]);
      const f = out.find((x) => x.g.intersects(pt));
      if (!f) {
        warn(`${cfg.id}: point ${p.join(',')} is outside every face`);
        continue;
      }
      for (const l of a.layers) if (!f.layers.some((m) => m.pos === l.pos && m.lo === l.lo && m.hi === l.hi)) f.layers.push({ ...l });
    }
  for (const [i, f] of out.entries()) {
    f.layers.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    if (!f.layers.length) warn(`${cfg.id}: face ${i} at ${interiorXY(f.g).map((v) => v.toFixed(4)).join(',')} has no owner`);
  }
  // Adjacent faces with the same stack become one piece.
  const key = (f: Face) => f.layers.map((l) => `${[l.pos, ...(l.via ?? [])].join('>')}${l.lo}-${l.hi}`).join(' ');
  const groups = new Map<string, Face[]>();
  for (const f of out) if (f.layers.length) (groups.get(key(f)) ?? groups.set(key(f), []).get(key(f))!).push(f);
  const merged: Face[] = [];
  for (const fsSame of groups.values()) {
    const u = unionAll(fsSame.map((f) => f.g.buffer(1e-6)));
    for (const p of polygons(u)) merged.push({ g: p, layers: fsSame[0].layers });
  }
  return merged;
}

/** Parses "SRW SFC-40 DRW 50-150" (hundreds of feet; SFC = 0). "N>W SFC-40": N, handed to W when N is closed. */
export function stack(s: string): Layer[] {
  const out: Layer[] = [];
  const re = /([A-Z]+(?:>[A-Z]+)*)\s+(SFC|\d+)-(\d+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const [pos, ...via] = m[1].split('>');
    out.push({ pos, lo: m[2] === 'SFC' ? 0 : Number(m[2]), hi: Number(m[3]), ...(via.length ? { via } : {}) });
  }
  if (!out.length) throw new Error(`Bad stack "${s}"`);
  return out;
}

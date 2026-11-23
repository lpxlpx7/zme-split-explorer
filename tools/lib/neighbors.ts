/**
 * Adjacent-facility sectors near ZME.
 *
 * The ZME video maps draw the sector lines of the neighbouring ARTCCs as short "stubs" that
 * start on the ZME boundary and run 1–1.5° outward. We turn them into areas:
 *   1. take a band of BAND° around ZME (per stratum: LO uses the larger LO boundary),
 *   2. extend every stub's free end straight out until it leaves the band,
 *   3. cut the band with the stubs and the ARTCC-to-ARTCC borders from the VATGlasses outlines,
 *   4. give every face to the facility (VATGlasses outline) that covers most of it, and — where
 *      VATGlasses publishes sectors (ZHU, ZJX) — the sector that covers most of it at the
 *      stratum's typical altitude, so ownership can follow that facility's priority chains.
 */
import {
  interiorXY,
  line,
  lineParts,
  mergeLines,
  point,
  polygonize,
  polygons,
  unionAll,
  coords,
  type Geom,
  type Pos,
} from './geom.ts';
import type { VgFacility } from './vatglasses.ts';
import type { VideoMaps } from './videomaps.ts';
import type { Stratum } from './zme.ts';

const BAND = 1.5;
const EXTEND = 4;
const OVERSHOOT = 0.03;
const ZME_CLEARANCE = 0.15;
const BORDER_OVERSHOOT = 0.5;
const ON_BOUNDARY = 2e-3;
const MIN_FACE = 0.12;
/** Altitude (hundreds of feet) used to pick a VATGlasses sector for each ZME stratum. */
const PROBE_ALT: Record<Stratum, number> = { LO: 180, HI: 290, UH: 390 };

export interface NeighborPiece {
  nid: string;
  artcc: string;
  stratum: Stratum;
  /** VATGlasses sector key (= position id in that facility), when known. */
  sector: string | null;
  name: string | null;
  g: Geom;
}

const key = ([x, y]: Pos) => `${x.toFixed(6)},${y.toFixed(6)}`;

/** Stub lines outside `zme`, with their free ends extended outward. */
export function extendedStubs(vm: VideoMaps, mapName: string, zme: Geom): Geom[] {
  const outside = lineParts(unionAll(vm.lines([mapName])).difference(zme));
  const chains = mergeLines(outside).map(coords);
  const boundary = zme.getBoundary();
  const degree = new Map<string, number>();
  for (const c of chains) for (const e of [c[0], c[c.length - 1]]) degree.set(key(e), (degree.get(key(e)) ?? 0) + 1);
  const onBoundary = (p: Pos) => point(...p).distance(boundary) < ON_BOUNDARY;
  const free = (p: Pos) => degree.get(key(p)) === 1 && !onBoundary(p);

  // Connected components, so tree-shaped stubs (which fork away from ZME) stay whole,
  // while components with closed loops (neighbouring TRACON outlines on the LO map) are trimmed.
  const parent = chains.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byEnd = new Map<string, number[]>();
  chains.forEach((c, i) => [c[0], c[c.length - 1]].forEach((e) => byEnd.set(key(e), [...(byEnd.get(key(e)) ?? []), i])));
  for (const ids of byEnd.values()) for (const i of ids.slice(1)) parent[find(i)] = find(ids[0]);
  const comps = new Map<number, number[]>();
  chains.forEach((_, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), i]));

  const out: Geom[] = [];
  for (const ids of comps.values()) {
    const cs = ids.map((i) => chains[i]);
    const ends = cs.flatMap((c) => [c[0], c[c.length - 1]]);
    if (!ends.some(onBoundary)) continue;
    // Closed loops are neighbouring TRACON/approach outlines (LO map), not centre sectors.
    if (polygonize(unionAll(cs.map(line))).length > 0) continue;
    for (const c of cs) {
      const [a, b] = [c[0], c[c.length - 1]];
      const pts = [...c];
      // Free ends run on out of the band along the stub's overall heading (its chord, which is
      // steadier than the last segment); ZME-side ends overshoot slightly so they surely cross the boundary.
      pts.push(free(b) ? extend(a, b, EXTEND) : extend(c[c.length - 2], b, OVERSHOOT));
      pts.unshift(free(a) ? extend(b, a, EXTEND) : extend(c[1], a, OVERSHOOT));
      out.push(line(pts));
    }
  }
  return out;
}

function extend(from: Pos, to: Pos, by: number): Pos {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const len = Math.hypot(dx, dy) || 1;
  return [to[0] + (dx / len) * by, to[1] + (dy / len) * by];
}

/**
 * Facility borders from the VATGlasses outlines. Outlines of adjacent facilities rarely coincide
 * exactly, and their edges facing ZME differ from the video-map ZME boundary, so: drop each outline
 * within ZME_CLEARANCE of ZME, then run the cut-off ends straight on into ZME. Slivers left between
 * two nearly-identical borders are folded away by mergeSmall().
 */
function facilityBorders(facilities: VgFacility[], zme: Geom, band: Geom): Geom[] {
  const keep = band.buffer(0.1).difference(zme.buffer(ZME_CLEARANCE, 8));
  const nearZme = zme.buffer(ZME_CLEARANCE * 1.5, 8);
  const out: Geom[] = [];
  for (const f of facilities)
    for (const l of mergeLines(lineParts(f.outline.getBoundary().intersection(keep)))) {
      if (l.getLength() < 0.05) continue;
      const c = coords(l);
      const [a, b] = [c[0], c[c.length - 1]];
      const pts = [...c];
      if (nearZme.contains(point(...b))) pts.push(extend(c[c.length - 2], b, BORDER_OVERSHOOT));
      if (nearZme.contains(point(...a))) pts.unshift(extend(c[1], a, BORDER_OVERSHOOT));
      out.push(line(pts));
    }
  return out;
}

export function buildNeighbors(
  vm: VideoMaps,
  strata: { stratum: Stratum; zme: Geom; sectorMap: string }[],
  facilities: VgFacility[],
): NeighborPiece[] {
  const pieces: NeighborPiece[] = [];
  for (const { stratum, zme, sectorMap } of strata) {
    const band = zme.buffer(BAND, 16).difference(zme);
    const cuts = [...extendedStubs(vm, sectorMap, zme), ...facilityBorders(facilities, zme, band)];
    const faces = polygonize(unionAll([band.getBoundary(), ...cuts])).filter((f) =>
      band.contains(point(...interiorXY(f))),
    );
    for (const f of mergeSmall(faces)) {
      // Facility: whichever VATGlasses outline covers most of the face.
      const fac = maxBy(facilities, (n) => overlap(f, n.outline));
      if (!fac || overlap(f, fac.outline) < f.getArea() * 0.3) continue;
      let sector: string | null = null;
      let name: string | null = null;
      if (fac.sectors) {
        const alt = PROBE_ALT[stratum];
        const live = fac.sectors.filter((s) => s.min <= alt && alt <= s.max);
        const best = maxBy(live, (s) => overlap(f, s.g));
        if (best && overlap(f, best.g) > f.getArea() * 0.2) {
          sector = best.key;
          name = best.name;
        }
      }
      pieces.push({ nid: '', artcc: fac.id, stratum, sector, name, g: f });
    }
  }
  // Join faces that ended up in the same labelled sector.
  const merged = new Map<string, NeighborPiece>();
  const out: NeighborPiece[] = [];
  for (const p of pieces) {
    if (!p.sector) {
      out.push(p);
      continue;
    }
    const k = `${p.artcc}|${p.stratum}|${p.sector}`;
    const prev = merged.get(k);
    if (prev) prev.g = unionAll([prev.g, p.g]).buffer(0);
    else {
      merged.set(k, p);
      out.push(p);
    }
  }
  const counter = new Map<string, number>();
  for (const p of out) {
    const k = `${p.artcc}-${p.stratum}`;
    const n = (counter.get(k) ?? 0) + 1;
    counter.set(k, n);
    p.nid = `${k}-${p.sector ?? `x${n}`}`;
  }
  return out;
}

const overlap = (a: Geom, b: Geom) => (a.intersects(b) ? a.intersection(b).getArea() : 0);

function maxBy<T>(xs: T[], f: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bv = -Infinity;
  for (const x of xs) {
    const v = f(x);
    if (v > bv) [best, bv] = [x, v];
  }
  return best;
}

/** Folds slivers (crossing extensions, boundary mismatches) into the neighbour they share most border with. */
function mergeSmall(faces: Geom[]): Geom[] {
  const list = faces.slice().sort((a, b) => a.getArea() - b.getArea());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.getArea() >= MIN_FACE) continue;
      const edge = f.getBoundary();
      let best = -1;
      let bestLen = 0;
      list.forEach((o, j) => {
        if (j === i || !o.intersects(f)) return;
        const len = edge.intersection(o.buffer(1e-6)).getLength();
        if (len > bestLen) [best, bestLen] = [j, len];
      });
      if (best < 0) continue;
      const joined = polygons(unionAll([list[best], f]).buffer(0));
      list[best] = joined.length === 1 ? joined[0] : unionAll(joined);
      list.splice(i, 1);
      changed = true;
      break;
    }
  }
  return list;
}

/**
 * Thin, typed facade over JSTS (the JavaScript port of JTS, the same topology engine
 * family as GEOS/shapely). Only the handful of operations the data build needs.
 */
import 'jsts/org/locationtech/jts/monkey.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import GeometryNoder from 'jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js';
import LineMerger from'jsts/org/locationtech/jts/operation/linemerge/LineMerger.js';
import Polygonizer from'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import TopologyPreservingSimplifier from 'jsts/org/locationtech/jts/simplify/TopologyPreservingSimplifier.js';

export type Pos = [number, number];

/** Opaque JSTS geometry (its bundled typings are mostly `any`). */
export interface Geom {
  getGeometryType(): string;
  getArea(): number;
  getLength(): number;
  isEmpty(): boolean;
  getNumGeometries(): number;
  getGeometryN(i: number): Geom;
  getCentroid(): Geom;
  getInteriorPoint(): Geom;
  getX(): number;
  getY(): number;
  getEnvelopeInternal(): { getMinX(): number; getMinY(): number; getMaxX(): number; getMaxY(): number };
  getExteriorRing(): Geom;
  getBoundary(): Geom;
  contains(g: Geom): boolean;
  intersects(g: Geom): boolean;
  covers(g: Geom): boolean;
  distance(g: Geom): number;
  intersection(g: Geom): Geom;
  difference(g: Geom): Geom;
  union(g?: Geom): Geom;
  buffer(d: number, quadrantSegments?: number): Geom;
}

/** Snap to ~10 cm so the classic overlay stays robust on hand-drawn video-map lines. */
interface Factory {
  createGeometryCollection(gs?: Geom[]): Geom;
  createMultiLineString(lines: Geom[]): Geom;
  createLineString(coordinates: unknown): Geom;
}
const factory = new GeometryFactory(new PrecisionModel(1e6)) as unknown as Factory;
const reader = new GeoJSONReader(factory as never);
const writer = new GeoJSONWriter();

export const read = (g: GeoJSON.Geometry): Geom => reader.read(snapGeometry(g)) as Geom;

function snapGeometry(g: GeoJSON.Geometry): GeoJSON.Geometry {
  const s = (c: unknown): unknown =>
    typeof (c as number[])[0] === 'number'
      ? [Math.round((c as number[])[0] * 1e6) / 1e6, Math.round((c as number[])[1] * 1e6) / 1e6]
      : (c as unknown[]).map(s);
  return 'coordinates' in g ? ({ ...g, coordinates: s(g.coordinates) } as GeoJSON.Geometry) : g;
}

export const point = (x: number, y: number): Geom => read({ type: 'Point', coordinates: [x, y] });
export const line = (coords: Pos[]): Geom => read({ type: 'LineString', coordinates: coords });
export const polygon = (ring: Pos[]): Geom => read({ type: 'Polygon', coordinates: [ring] });
export const box = (x0: number, y0: number, x1: number, y1: number): Geom =>
  polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
export const empty = (): Geom => factory.createGeometryCollection();

export const collection = (gs: Geom[]): Geom => factory.createGeometryCollection(gs);

/** Union of many geometries; for lines this also nodes them at every crossing. */
export function unionAll(gs: Geom[]): Geom {
  if (!gs.length) return empty();
  try {
    return UnaryUnionOp.union(collection(gs) as never) as unknown as Geom;
  } catch (e) {
    // The classic overlay can fail on nearly-collinear hand-drawn lines; snap-round instead.
    if (gs.every((g) => lineParts(g).length === g.getNumGeometries())) return nodeLines(gs);
    throw e;
  }
}

/** Robust noding of linework by snap-rounding (to ~1 m), with duplicate edges removed. */
export function nodeLines(gs: Geom[]): Geom {
  const input = new (ArrayList as unknown as new () => { add(g: Geom): void })();
  for (const g of gs) input.add(g);
  const noded = (new GeometryNoder(new PrecisionModel(1e5)).node(input as never).toArray() as Geom[]).slice();
  const seen = new Set<string>();
  const unique = noded.filter((l) => {
    const c = coords(l).map(([x, y]) => `${x},${y}`);
    const k = c[0] < c[c.length - 1] ? c.join(';') : c.reverse().join(';');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return factory.createMultiLineString(unique);
}

export function parts(g: Geom): Geom[] {
  const out: Geom[] = [];
  for (let i = 0; i < g.getNumGeometries(); i++) out.push(g.getGeometryN(i));
  return out;
}

export function polygons(g: Geom): Geom[] {
  const t = g.getGeometryType();
  if (t === 'Polygon') return [g];
  if (t === 'MultiPolygon' || t === 'GeometryCollection') return parts(g).flatMap(polygons);
  return [];
}

export function lineParts(g: Geom): Geom[] {
  const t = g.getGeometryType();
  if (t === 'LineString' || t === 'LinearRing') return [g];
  if (t === 'MultiLineString' || t === 'GeometryCollection') return parts(g).flatMap(lineParts);
  return [];
}

/** Every closed face formed by a set of (already noded) lines. */
export function polygonize(lines: Geom): Geom[] {
  const p = new Polygonizer();
  p.add(lines);
  const list = p.getPolygons();
  return (list.toArray() as Geom[]).slice();
}

/** Joins line segments that meet end-to-end at degree-2 nodes into maximal chains. */
export function mergeLines(lines: Geom[]): Geom[] {
  const m = new LineMerger();
  for (const l of lines) m.add(l);
  return (m.getMergedLineStrings().toArray() as Geom[]).slice();
}

/** Simplifies while keeping the topology valid (no self-intersections). */
export const simplify = (g: Geom, tolerance: number): Geom => TopologyPreservingSimplifier.simplify(g, tolerance) as Geom;

export const toGeoJSON = (g: Geom): GeoJSON.Geometry =>
  // GeoJSON has no LinearRing (polygon rings/boundaries): write those as LineStrings.
  writer.write((g.getGeometryType() === 'LinearRing' ? factory.createLineString((g as unknown as { getCoordinates(): unknown }).getCoordinates()) : g) as never) as GeoJSON.Geometry;

export function coords(g: Geom): Pos[] {
  const j = toGeoJSON(g);
  if (j.type !== 'LineString') throw new Error(`coords() expects a LineString, got ${j.type}`);
  return j.coordinates as Pos[];
}

/** Round coordinates to keep the published files small. */
export function rounded(g: Geom, nd = 5): GeoJSON.Geometry {
  const f = 10 ** nd;
  const r = (c: unknown): unknown =>
    typeof (c as number[])[0] === 'number'
      ? [Math.round((c as number[])[0] * f) / f, Math.round((c as number[])[1] * f) / f]
      : (c as unknown[]).map(r);
  const j = toGeoJSON(g) as GeoJSON.Geometry & { coordinates: unknown };
  return { ...j, coordinates: r(j.coordinates) } as GeoJSON.Geometry;
}

export const centroidXY = (g: Geom): Pos => {
  const c = g.getCentroid();
  return [c.getX(), c.getY()];
};
export const interiorXY = (g: Geom): Pos => {
  const c = g.getInteriorPoint();
  return [c.getX(), c.getY()];
};

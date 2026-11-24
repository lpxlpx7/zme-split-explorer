/**
 * STARS video maps draw dashed, dash-dot and dotted lines as hundreds of tiny separate segments.
 * To polygonize them, the dashes are first joined back into continuous polylines: each segment end
 * is linked to the nearest segment end that lies straight ahead of it (within a gap and an angle
 * limit), and the linked segments are walked into chains.
 */
import type { Pos } from './geom.ts';

interface End {
  piece: number;
  /** 0 = first vertex, 1 = last vertex. */
  side: 0 | 1;
  p: Pos;
  /** Unit vector pointing out of the piece at this end, or null for a dot. */
  dir: Pos | null;
}

const sub = (a: Pos, b: Pos): Pos => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pos) => Math.hypot(a[0], a[1]);
const unit = (a: Pos): Pos => {
  const l = len(a);
  return [a[0] / l, a[1] / l];
};
const dot = (a: Pos, b: Pos) => a[0] * b[0] + a[1] * b[1];

export interface JoinOptions {
  /** Largest gap to bridge, in NM. */
  maxGap: number;
  /** Largest bend between a segment and the gap to the next one, in degrees. */
  maxAngle: number;
  /** Drop chains shorter than this (symbols, ticks), in NM. */
  minLength: number;
}

/** Joins dashed linework (lon/lat polylines) into continuous polylines (lon/lat). */
export function joinDashes(lines: Pos[][], { maxGap, maxAngle, minLength }: JoinOptions): Pos[][] {
  if (!lines.length) return [];
  const lat0 = lines.flat().reduce((s, p) => s + p[1], 0) / lines.flat().length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const toXY = (p: Pos): Pos => [p[0] * k * 60, p[1] * 60];
  const toLL = (p: Pos): Pos => [p[0] / k / 60, p[1] / 60];

  const pieces = lines.map((l) => l.map(toXY)).filter((l) => l.length > 1);
  const pieceLen = pieces.map((l) => l.slice(1).reduce((s, p, i) => s + len(sub(p, l[i])), 0));
  const ends: End[] = [];
  pieces.forEach((l, i) => {
    const isDot = pieceLen[i] < 0.08;
    const n = l.length;
    ends.push({ piece: i, side: 0, p: l[0], dir: isDot ? null : outward(l[0], l.slice(1)) });
    ends.push({ piece: i, side: 1, p: l[n - 1], dir: isDot ? null : outward(l[n - 1], l.slice(0, -1).reverse()) });
  });

  // Spatial hash for neighbour lookup.
  const cell = maxGap;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  ends.forEach((e, i) => {
    const kk = key(e.p[0], e.p[1]);
    (grid.get(kk) ?? grid.set(kk, []).get(kk)!).push(i);
  });

  const cosMax = Math.cos((maxAngle * Math.PI) / 180);
  const cands: [number, number, number][] = [];
  ends.forEach((a, i) => {
    const cx = Math.floor(a.p[0] / cell);
    const cy = Math.floor(a.p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const b = ends[j];
          if (b.piece === a.piece) continue;
          const v = sub(b.p, a.p);
          const g = len(v);
          if (g > maxGap) continue;
          let cost = g;
          if (g > 0.02) {
            const u = unit(v);
            // a's outward direction should point at b, and b's outward direction back at a.
            if (a.dir) {
              const c = dot(a.dir, u);
              if (c < cosMax) continue;
              cost += (1 - c) * 20;
            }
            if (b.dir) {
              const c = -dot(b.dir, u);
              if (c < cosMax) continue;
              cost += (1 - c) * 20;
            }
            if (!a.dir && !b.dir) cost += 0.3; // dot to dot: prefer real dashes
          }
          cands.push([cost, i, j]);
        }
  });
  cands.sort((x, y) => x[0] - y[0]);

  const link = new Map<number, number>(); // end index -> linked end index
  for (const [, i, j] of cands) {
    if (link.has(i) || link.has(j)) continue;
    link.set(i, j);
    link.set(j, i);
  }

  // Walk chains. End index of piece p side s = 2p + s.
  const used = new Set<number>();
  const chains: Pos[][] = [];
  const walk = (startPiece: number, startSide: 0 | 1): Pos[] => {
    // Enter the piece at startSide, leave at the other side.
    const out: Pos[] = [];
    let p = startPiece;
    let side = startSide;
    for (;;) {
      used.add(p);
      const pts = side === 0 ? pieces[p] : [...pieces[p]].reverse();
      out.push(...pts);
      const exitEnd = 2 * p + (1 - side);
      const next = link.get(exitEnd);
      if (next === undefined) break;
      const np = ends[next].piece;
      if (used.has(np)) {
        // Closed ring: close it on the first point.
        if (np === startPiece) out.push(out[0]);
        break;
      }
      p = np;
      side = ends[next].side;
    }
    return out;
  };
  // Start from open ends first so open chains are walked whole.
  for (let p = 0; p < pieces.length; p++) {
    if (used.has(p)) continue;
    if (!link.has(2 * p)) chains.push(walk(p, 0));
    else if (!link.has(2 * p + 1)) chains.push(walk(p, 1));
  }
  for (let p = 0; p < pieces.length; p++) if (!used.has(p)) chains.push(walk(p, 0)); // rings

  return chains
    .filter((c) => c.slice(1).reduce((s, q, i) => s + len(sub(q, c[i])), 0) >= minLength)
    .map((c) => c.map(toLL));
}

/** Direction leaving `p`, measured against the first vertex at least 0.05 NM away. */
function outward(p: Pos, rest: Pos[]): Pos | null {
  for (const q of rest) {
    const v = sub(p, q);
    if (len(v) > 0.05) return unit(v);
  }
  const q = rest[rest.length - 1];
  return len(sub(p, q)) > 0 ? unit(sub(p, q)) : null;
}

/**
 * Tidies joined chains (lon/lat) so they polygonize: open ends that sit close together (corners
 * the angle limit would not join) are connected, then every remaining open end is extended
 * straight ahead to the first line it meets, if that is within `reach` NM. Chains shorter than
 * `minLength` NM (ticks, symbols) are left alone.
 */
export function closeChains(chains: Pos[][], cornerGap: number, reach: number, minLength = 4, corners = true): Pos[][] {
  if (!chains.length) return chains;
  const lat0 = chains[0][0][1];
  const k = Math.cos((lat0 * Math.PI) / 180);
  const toXY = (p: Pos): Pos => [p[0] * k * 60, p[1] * 60];
  const toLL = (p: Pos): Pos => [p[0] / k / 60, p[1] / 60];
  let cs = chains.map((c) => c.map(toXY));
  const isRing = (c: Pos[]) => len(sub(c[0], c[c.length - 1])) < 1e-9;
  const lengths = cs.map((c) => c.slice(1).reduce((s, q, i) => s + len(sub(q, c[i])), 0));
  const short = lengths.map((l) => l < minLength);

  // 1. Corners: link the closest pairs of open ends.
  type E = { c: number; side: 0 | 1 };
  const open: E[] = [];
  cs.forEach((c, i) => {
    if (corners && !isRing(c) && !short[i]) open.push({ c: i, side: 0 }, { c: i, side: 1 });
  });
  const at = (e: E) => (e.side === 0 ? cs[e.c][0] : cs[e.c][cs[e.c].length - 1]);
  const pairs: [number, E, E][] = [];
  for (let i = 0; i < open.length; i++)
    for (let j = i + 1; j < open.length; j++) {
      if (open[i].c === open[j].c) continue;
      const d = len(sub(at(open[i]), at(open[j])));
      if (d <= cornerGap) pairs.push([d, open[i], open[j]]);
    }
  pairs.sort((a, b) => a[0] - b[0]);
  const taken = new Set<string>();
  const extra: Pos[][] = [];
  for (const [, a, b] of pairs) {
    const ka = `${a.c}:${a.side}`;
    const kb = `${b.c}:${b.side}`;
    if (taken.has(ka) || taken.has(kb)) continue;
    taken.add(ka);
    taken.add(kb);
    extra.push([at(a), at(b)]);
  }
  cs = [...cs, ...extra];

  // 2. Extend the rest to the first line ahead.
  const segs: [Pos, Pos][] = cs.flatMap((c) => c.slice(1).map((p, i): [Pos, Pos] => [c[i], p]));
  const out = cs.map((c) => [...c]);
  cs.forEach((c, ci) => {
    // Short pieces (arcs near the airport) are extended too, but only a little.
    if (ci >= cs.length - extra.length || isRing(c) || lengths[ci] < 1) return;
    const maxReach = short[ci] ? Math.min(reach, 2) : reach;
    for (const side of [0, 1] as const) {
      if (taken.has(`${ci}:${side}`)) continue;
      const pts = side === 0 ? c : [...c].reverse();
      const p = pts[0];
      let q = pts[1];
      for (const r of pts.slice(1)) {
        q = r;
        if (len(sub(p, r)) > 0.05) break;
      }
      if (len(sub(p, q)) === 0) continue;
      const d = unit(sub(p, q));
      let best = maxReach;
      for (const [a, b] of segs) {
        const t = raySeg(p, d, a, b);
        if (t !== null && t > 1e-6 && t < best) best = t;
      }
      if (best < maxReach) {
        const hit: Pos = [p[0] + d[0] * best, p[1] + d[1] * best];
        if (side === 0) out[ci].unshift(hit);
        else out[ci].push(hit);
      }
    }
  });
  return out.map((c) => c.map(toLL));
}

/** Distance along the ray p + t·d to segment ab, or null. */
function raySeg(p: Pos, d: Pos, a: Pos, b: Pos): number | null {
  const e = sub(b, a);
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return null;
  const w = sub(a, p);
  const t = (w[0] * e[1] - w[1] * e[0]) / den;
  const s = (w[0] * d[1] - w[1] * d[0]) / den;
  return s >= 0 && s <= 1 ? t : null;
}

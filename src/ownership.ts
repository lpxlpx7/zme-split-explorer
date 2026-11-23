import {
  COMBINED_POSITIONS,
  COMBINED_PRIMARY,
  COMBINED_SPLITS,
  SECTOR_BY_KEY,
  STRATUM_SPLITS,
  sectorKey,
  type Region,
  type Stratum,
} from './sectors';
import type { Polygonal } from './geo';

export interface Piece {
  pid: string;
  stratum: Stratum;
  sector: string;
  region: Region;
  /** For LO/UH pieces: the HI piece directly above/below. */
  hi: string | null;
  geometry: Polygonal;
  /** Duplicated geometry of a stacked sector (60 under 40): not drawn. */
  hidden?: boolean;
}

export type Mode = 'offline' | 'combined' | 'stratified';

export interface Ownership {
  mode: Mode;
  /** pid → owning position id, or null when uncovered. */
  owners: Map<string, string | null>;
  /** sector key → set of owning positions (several when a sector is split by fallback). */
  sectorOwners: Map<string, Set<string>>;
  /** position id → sector keys it works. */
  positionSectors: Map<string, string[]>;
}

/**
 * Work out who owns every piece of airspace.
 *
 * - `assign` (sector key → position) overrides the rules below for that sector while the position is
 *   online; LO/UH under a reassigned HI sector follow it like any other HI owner.
 * - Exactly one position online → it works all of ZME.
 * - Only combined positions (22/63/46/44) online → combined 2/3/4-way area split for all altitudes.
 * - Otherwise each stratum resolves independently: the sector's own position, then its 4/3/2-way
 *   split owner, then the stratum primary (LO 05, HI 22, UH 33). HI then falls back to the combined
 *   split; LO/UH fall back to the HI owner overhead. HI left uncovered takes the UH/LO owner there.
 */
export function computeOwnership(pieces: Piece[], online: Set<string>, assign: Map<string, string> = new Map()): Ownership {
  const owners = new Map<string, string | null>();
  /** A hand-made assignment wins over the SOP, but only while its position is online. */
  const forced = (p: Piece) => {
    const a = assign.get(sectorKey(p.stratum, p.sector));
    return a && online.has(a) ? a : null;
  };
  const first = (...ids: (string | undefined)[]) => ids.find((id) => id && online.has(id)) ?? null;
  const combined = (r: Region) =>
    first(...COMBINED_SPLITS.map((split) => split[r]), COMBINED_PRIMARY);

  let mode: Mode = 'offline';
  if (online.size > 0)
    mode = online.size === 1 || [...online].every((id) => COMBINED_POSITIONS.has(id)) ? 'combined' : 'stratified';

  const stratumChain = (p: Piece) => {
    const sector = SECTOR_BY_KEY.get(sectorKey(p.stratum, p.sector));
    const split = STRATUM_SPLITS[p.stratum];
    const area = sector?.area;
    return first(p.sector, ...(area ? split.ways.map((w) => w[area]) : []), split.primary);
  };

  if (online.size === 1) {
    // A single position online works all of ZME, whichever one it is.
    const only = [...online][0];
    for (const p of pieces) owners.set(p.pid, only);
  } else {
    // HI first: LO/UH depend on it.
    const ordered = [...pieces].sort((a, b) => Number(b.stratum === 'HI') - Number(a.stratum === 'HI'));
    for (const p of ordered) {
      let owner: string | null = forced(p);
      if (owner) { /* assigned by hand */ }
      else if (mode === 'combined') owner = combined(p.region);
      else if (p.stratum === 'HI') owner = stratumChain(p) ?? combined(p.region);
      else {
        const above = p.hi ? owners.get(p.hi) : undefined;
        owner = stratumChain(p) ?? above ?? combined(p.region);
      }
      owners.set(p.pid, mode === 'offline' ? null : owner);
    }

    if (mode !== 'offline') {
      // HI still uncovered (e.g. only LO/UH positions online): take it from the UH, then LO, controller at that spot…
      const below = new Map<string, Piece[]>();
      for (const p of pieces) if (p.hi) below.set(p.hi, [...(below.get(p.hi) ?? []), p]);
      for (const p of pieces) {
        if (p.stratum !== 'HI' || owners.get(p.pid)) continue;
        const stack = (below.get(p.pid) ?? []).sort((a, b) => Number(b.stratum === 'UH') - Number(a.stratum === 'UH'));
        const owner = stack.map((q) => stratumChain(q)).find(Boolean) ?? null;
        owners.set(p.pid, owner);
      }
      // …then give uncovered LO/UH to that HI owner.
      for (const p of pieces) if (p.stratum !== 'HI' && !owners.get(p.pid) && p.hi) owners.set(p.pid, owners.get(p.hi) ?? null);
      // LO beyond the HI boundary has nothing overhead: keep it with the rest of its sector.
      for (const p of pieces) {
        if (owners.get(p.pid)) continue;
        const sibling = pieces.find((q) => q.stratum === p.stratum && q.sector === p.sector && owners.get(q.pid));
        if (sibling) owners.set(p.pid, owners.get(sibling.pid)!);
      }
    }
  }

  const sectorOwners = new Map<string, Set<string>>();
  const positionSectors = new Map<string, string[]>();
  for (const p of pieces) {
    const key = sectorKey(p.stratum, p.sector);
    const owner = owners.get(p.pid);
    if (!sectorOwners.has(key)) sectorOwners.set(key, new Set());
    if (!owner) continue;
    sectorOwners.get(key)!.add(owner);
    const list = positionSectors.get(owner) ?? [];
    if (!list.includes(key)) list.push(key);
    positionSectors.set(owner, list);
  }
  return { mode, owners, sectorOwners, positionSectors };
}

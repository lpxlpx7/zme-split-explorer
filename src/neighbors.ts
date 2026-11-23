/**
 * Live ownership of the adjacent facilities' sectors (data built by tools/build-data.ts).
 *
 * - ZHU / ZJX publish sectors and priority chains on VATGlasses: a controller is matched to a
 *   position by frequency (then by the number in the callsign), and each sector goes to the first
 *   online position in its chain, exactly as VATGlasses does.
 * - Other neighbours (ZKC, ZID, ZTL, ZFW) only have an outline: their centre controllers share the
 *   whole strip. With one controller that is exact; with several we can't tell who has what, so the
 *   sector is drawn for the first one and marked as approximate.
 */
import type { Polygonal } from './geo';
import type { Stratum } from './sectors';
import { RATINGS, type VatsimData } from './vatsim';

export interface NeighborFacility {
  id: string;
  name: string;
  prefixes: string[];
  /** position id → frequency (detailed facilities only). */
  positions: Record<string, string> | null;
  /** sector key → position priority chain. */
  ownership: Record<string, string[]> | null;
  sectorNames: Record<string, string> | null;
}

export interface NeighborPiece {
  nid: string;
  artcc: string;
  stratum: Stratum;
  sector: string | null;
  name: string | null;
  geometry: Polygonal;
}

export interface NeighborController {
  /** Unique key, also used for colours: "ZKC:KC_04_CTR". */
  key: string;
  facility: string;
  callsign: string;
  frequency: string;
  name: string;
  rating: string;
  logon: Date;
  /** Matched VATGlasses position (detailed facilities). */
  position: string | null;
}

export interface NeighborOwner {
  owner: string | null;
  /** True when the owner is a best guess (several controllers, no published split). */
  approx: boolean;
}

export function neighborControllers(data: VatsimData | null, facilities: NeighborFacility[]): NeighborController[] {
  if (!data) return [];
  const out: NeighborController[] = [];
  for (const c of data.controllers) {
    if (c.facility !== 6 || c.frequency === '199.998') continue;
    const cs = c.callsign.toUpperCase();
    if (!cs.endsWith('_CTR')) continue;
    const fac = facilities.find((f) => f.prefixes.some((p) => cs.startsWith(`${p.toUpperCase()}_`)));
    if (!fac) continue;
    const freq = Number.parseFloat(c.frequency).toFixed(3);
    out.push({
      key: `${fac.id}:${cs}`,
      facility: fac.id,
      callsign: c.callsign,
      frequency: freq,
      name: c.name,
      rating: RATINGS[c.rating] ?? '',
      logon: new Date(c.logon_time),
      position: matchPosition(fac, cs, freq),
    });
  }
  return out.sort((a, b) => a.callsign.localeCompare(b.callsign));
}

function matchPosition(f: NeighborFacility, callsign: string, freq: string): string | null {
  if (!f.positions) return null;
  const byFreq = Object.entries(f.positions).find(([, fr]) => fr === freq)?.[0];
  if (byFreq) return byFreq;
  const num = callsign.split('_').find((p) => /^\d{1,3}$/.test(p));
  return num && f.positions[num] ? num : null;
}

export function computeNeighborOwners(
  pieces: NeighborPiece[],
  facilities: NeighborFacility[],
  ctrls: NeighborController[],
): Map<string, NeighborOwner> {
  const out = new Map<string, NeighborOwner>();
  const byFac = new Map<string, NeighborController[]>();
  for (const c of ctrls) byFac.set(c.facility, [...(byFac.get(c.facility) ?? []), c]);
  for (const p of pieces) {
    const online = byFac.get(p.artcc) ?? [];
    if (!online.length) {
      out.set(p.nid, { owner: null, approx: false });
      continue;
    }
    const fac = facilities.find((f) => f.id === p.artcc);
    if (fac?.positions && p.sector) {
      const chain = fac.ownership?.[p.sector] ?? [p.sector];
      const hit = chain.map((id) => online.find((c) => c.position === id)).find(Boolean);
      if (hit) {
        out.set(p.nid, { owner: hit.key, approx: false });
        continue;
      }
    }
    out.set(p.nid, { owner: online[0].key, approx: online.length > 1 || !!(fac?.positions && p.sector) });
  }
  return out;
}

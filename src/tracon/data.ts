/**
 * BNA and M03 radar positions and how they combine.
 *
 * Names, callsigns and frequencies: BNA ATCT/TRACON SOP §5-1-2, M03 TRACON SOP §2-2-1 (frequencies as
 * tuned in CRC). `fallback` is who takes a closed position's airspace, in order; it follows the CRC
 * consolidation tree (parent TCPs) and, for the finals, the SOP: BNA finals go back to their arrival
 * side; M03 AR-M combines into AR-F (the primary final), and AR-F into AR-W.
 */

/** Altitudes in hundreds of feet; 0 is the surface. */
export interface Layer {
  pos: string;
  lo: number;
  hi: number;
  /** Who takes this layer when `pos` is closed, before the position's usual fallback. */
  via?: string[];
}

export interface Position {
  /** Code used in the airspace data (BNA: DRW…, M03: E, W…). */
  code: string;
  /** Short name as the SOP writes it. */
  abbr: string;
  name: string;
  callsign: string;
  /** STARS sector letter (the middle of the callsign). */
  letter: string;
  freq: string;
  fallback: string[];
}

export interface Preset {
  label: string;
  positions: string[];
}

export interface FacilityInfo {
  id: string;
  short: string;
  name: string;
  /** Callsign prefixes on VATSIM. */
  prefixes: string[];
  /** Top of the TRACON, hundreds of feet. */
  ceiling: number;
  /** Primary (combined) position first: it ends every fallback chain. */
  positions: Position[];
  /** Final positions: while any one of them is open it covers every final's airspace. */
  finals: string[];
  presets: Preset[];
  source: string;
}

const pos = (code: string, abbr: string, name: string, letter: string, callsign: string, freq: string, fallback: string[]): Position => ({ code, abbr, name, letter, callsign, freq, fallback });

export const FACILITIES: FacilityInfo[] = [
  {
    id: 'BNA',
    short: 'Nashville',
    name: 'Nashville TRACON',
    prefixes: ['BNA'],
    ceiling: 150,
    positions: [
      pos('DRW', 'DRW', 'Departure Radar West', 'X', 'BNA_X_DEP', '119.350', []),
      pos('DRE', 'DRE', 'Departure Radar East', 'Y', 'BNA_Y_DEP', '118.400', ['DRW']),
      pos('ARE', 'ARE', 'Arrival Radar East', 'E', 'BNA_E_APP', '127.175', ['DRW']),
      pos('ARW', 'ARW', 'Arrival Radar West', 'W', 'BNA_W_APP', '120.600', ['DRW']),
      pos('FRE', 'FRE', 'Final Radar East', 'F', 'BNA_F_APP', '124.750', ['ARE', 'DRW']),
      pos('FRW', 'FRW', 'Final Radar West', 'B', 'BNA_B_APP', '133.000', ['ARW', 'DRW']),
      pos('SRE', 'SRE', 'Satellite Radar East', 'S', 'BNA_S_APP', '128.750', ['DRE', 'DRW']),
      pos('SRW', 'SRW', 'Satellite Radar West', 'G', 'BNA_G_APP', '120.600', ['DRW']),
    ],
    finals: ['FRE', 'FRW'],
    // The CRC configuration plans.
    presets: [
      { label: 'DRW', positions: ['DRW'] },
      { label: 'DRW, DRE', positions: ['DRW', 'DRE'] },
      { label: 'DRW, DRE, SRE', positions: ['DRW', 'DRE', 'SRE'] },
      { label: 'DRW, DRE, ARW, ARE', positions: ['DRW', 'DRE', 'ARW', 'ARE'] },
      { label: 'All split', positions: ['DRW', 'DRE', 'ARE', 'ARW', 'FRE', 'FRW', 'SRE', 'SRW'] },
    ],
    source: 'Nashville ATCT/TRACON SOP, Appendices 1–4',
  },
  {
    id: 'M03',
    short: 'Memphis',
    name: 'Memphis TRACON',
    prefixes: ['MEM', 'M03'],
    ceiling: 160,
    positions: [
      pos('E', 'ARE', 'Arrival Radar East', 'E', 'MEM_E_APP', '125.800', []),
      pos('W', 'ARW', 'Arrival Radar West', 'W', 'MEM_W_APP', '119.100', ['E']),
      pos('F', 'ARF', 'Final Radar West', 'F', 'MEM_F_APP', '126.700', ['W', 'E']),
      pos('M', 'ARM', 'Final Radar East', 'M', 'MEM_M_APP', '120.925', ['F', 'E']),
      pos('N', 'ARN', 'Final Radar 9/27', 'N', 'MEM_N_APP', '126.050', ['E']),
      pos('V', 'DRV', 'Departure Radar East', 'V', 'MEM_V_DEP', '124.150', ['E']),
      pos('A', 'DRA', 'Departure Radar West', 'A', 'MEM_A_DEP', '124.650', ['W', 'E']),
    ],
    // AR-F is the primary final (SOP 2-2-4), then AR-M, then AR-N (9/27).
    finals: ['F', 'M', 'N'],
    presets: [
      { label: 'ARE', positions: ['E'] },
      { label: 'ARE, ARW', positions: ['E', 'W'] },
      { label: 'Four corners', positions: ['E', 'W', 'V', 'A'] },
      { label: 'Four corners + ARF', positions: ['E', 'W', 'V', 'A', 'F'] },
      { label: 'All split', positions: ['E', 'W', 'F', 'M', 'N', 'V', 'A'] },
    ],
    source: 'Memphis TRACON SOP V3.0.2, Appendix 7-1',
  },
];

/**
 * The layer in force at `alt`. Where two layers meet at the same altitude the upper one takes it
 * (and among equal floors the narrower one, e.g. AR-N's SFC–030 inside AR-E's SFC–040). The 500 ft
 * between one layer's top and the next one's floor belongs to the layer below (SOP: VFR altitudes
 * 500 ft above a stratum stay with the underlying position).
 */
export function layerAt(layers: Layer[], alt: number): Layer | null {
  if (!layers.length) return null;
  const inside = layers.filter((l) => l.lo <= alt && alt <= l.hi);
  if (inside.length) return inside.sort((a, b) => b.lo - a.lo || a.hi - b.hi)[0];
  const top = Math.max(...layers.map((l) => l.hi));
  const bottom = Math.min(...layers.map((l) => l.lo));
  if (alt > top || alt < bottom) return null;
  return layers.filter((l) => l.hi < alt).sort((a, b) => b.hi - a.hi)[0] ?? null;
}

/**
 * Who works a layer, given the open positions: the position itself; for a final, any other open
 * final (one final covers all final airspace); then its fallbacks; then anyone.
 */
export function ownerOf(f: FacilityInfo, layer: Layer, open: Set<string>): string | null {
  const own = f.positions.find((p) => p.code === layer.pos);
  const peers = f.finals.includes(layer.pos) ? f.finals.filter((c) => c !== layer.pos) : [];
  const chain = [layer.pos, ...peers, ...(layer.via ?? []), ...(own?.fallback ?? []), ...f.positions.map((p) => p.code)];
  return chain.find((c) => open.has(c)) ?? null;
}

/**
 * Typed altitude → hundreds of feet. "3000" / "3,000 ft" are feet; "030", "30", "A030", "FL030" are
 * hundreds (as written on the SOP maps and in a data block); "SFC" / "0" is the surface.
 * Four or more digits mean feet. Returns null if it can't be read.
 */
export function parseAlt(input: string): number | null {
  const s = input.trim().toUpperCase().replace(/,/g, '').replace(/\s*(FT|FEET|')$/, '');
  if (s === 'SFC' || s === 'SURFACE' || s === 'GND') return 0;
  const m = /^(?:A|FL)?\s*(\d{1,5})$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[1].length >= 4 ? Math.round(n / 100) : n;
}

export const fmtAlt =(alt: number) => (alt === 0 ? 'Surface' : `${(alt * 100).toLocaleString('en-US')} ft`);
export const fmtFl = (alt: number) => (alt === 0 ? 'SFC' : String(alt).padStart(3, '0'));

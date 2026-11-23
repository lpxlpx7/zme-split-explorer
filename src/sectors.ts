/**
 * ZME sector definitions and split rules.
 * Source: ZME Enroute Standard Operating Procedures V1.3 (12/25/25),
 * sections 3-2-1 … 3-2-5 and the LO / HI / UH sector maps.
 */

export type Stratum = 'LO' | 'HI' | 'UH';
export type Area = 1 | 2 | 3 | 4 | 5 | 6;
/** Pieces of ZME cut by the combined 2/3/4-way split lines (see tools/build_sectors.py). */
export type Region = 'NW' | 'NE' | 'CW' | 'SW' | 'SE';

export const STRATA: Stratum[] = ['LO', 'HI', 'UH'];

export const STRATUM_INFO: Record<Stratum, { label: string; altitude: string }> = {
  LO: { label: 'Low', altitude: 'SFC – FL230' },
  HI: { label: 'High', altitude: 'FL240 – FL340' },
  UH: { label: 'Ultra High', altitude: 'FL350 – UNL' },
};

export interface Sector {
  stratum: Stratum;
  /** Two-digit sector number; also the position id (MEM_<id>_CTR). */
  id: string;
  name: string;
  area: Area;
  /** Frequencies that identify the position on VATSIM. */
  freqs: string[];
  altitude?: string;
  /** Sector shares its lateral boundary with another one (Sector 60 under 40). */
  stackedUnder?: string;
}

export const SECTORS: Sector[] = [
  // ── LOW (3-2-2) ────────────────────────────────────────────────────────────
  { stratum: 'LO', id: '05', name: 'Paducah', area: 1, freqs: ['133.650'] },
  { stratum: 'LO', id: '07', name: 'McKeller', area: 1, freqs: ['134.650'] },
  { stratum: 'LO', id: '03', name: 'Harrison', area: 2, freqs: ['126.850'] },
  { stratum: 'LO', id: '04', name: 'Jonesboro', area: 2, freqs: ['120.075'] },
  { stratum: 'LO', id: '01', name: 'Hot Springs', area: 3, freqs: ['128.475'] },
  { stratum: 'LO', id: '02', name: 'Fayetteville', area: 3, freqs: ['126.100'] },
  { stratum: 'LO', id: '15', name: 'Helena', area: 4, freqs: ['135.300'] },
  { stratum: 'LO', id: '65', name: 'Kewanee', area: 4, freqs: ['125.975'] },
  { stratum: 'LO', id: '66', name: 'Jackson', area: 4, freqs: ['132.500'] },
  { stratum: 'LO', id: '67', name: 'Greenville', area: 4, freqs: ['135.875'] },
  { stratum: 'LO', id: '41', name: 'Bowling Green', area: 5, freqs: ['133.850'] },
  { stratum: 'LO', id: '40', name: 'Sparta', area: 5, freqs: ['132.900'], altitude: '090 – 230' },
  { stratum: 'LO', id: '60', name: 'Shelbyville', area: 5, freqs: ['128.150'], altitude: 'SFC – 080', stackedUnder: '40' },
  { stratum: 'LO', id: '12', name: 'Columbus', area: 6, freqs: ['128.500'] },
  { stratum: 'LO', id: '13', name: 'Hamilton', area: 6, freqs: ['120.800'] },
  { stratum: 'LO', id: '14', name: 'Holly Springs', area: 6, freqs: ['124.350'] },
  { stratum: 'LO', id: '42', name: 'Graham', area: 6, freqs: ['125.850'] },
  // ── HIGH (3-2-4) ───────────────────────────────────────────────────────────
  { stratum: 'HI', id: '25', name: 'Tings', area: 1, freqs: ['135.500'] },
  { stratum: 'HI', id: '26', name: 'Jacks Creek', area: 1, freqs: ['126.450'] },
  { stratum: 'HI', id: '22', name: 'Razorback', area: 2, freqs: ['132.550'] },
  { stratum: 'HI', id: '27', name: 'Calico', area: 2, freqs: ['132.375'] },
  { stratum: 'HI', id: '21', name: 'Conway', area: 3, freqs: ['132.425'] },
  { stratum: 'HI', id: '28', name: 'Memphis', area: 3, freqs: ['118.625'] },
  // 3-2-1 lists Pine Bluff at 134.925 in the combined 4-way table; 3-2-4 at 124.925.
  { stratum: 'HI', id: '44', name: 'Pine Bluff', area: 3, freqs: ['124.925', '134.925'] },
  { stratum: 'HI', id: '45', name: 'Vicksburg', area: 4, freqs: ['133.075'] },
  { stratum: 'HI', id: '46', name: 'Meridian', area: 4, freqs: ['128.275'] },
  { stratum: 'HI', id: '62', name: 'Smyrna', area: 5, freqs: ['118.875'] },
  { stratum: 'HI', id: '63', name: 'Campbell', area: 5, freqs: ['124.275'] },
  { stratum: 'HI', id: '30', name: 'Columbus', area: 6, freqs: ['134.775'] },
  { stratum: 'HI', id: '31', name: 'Muscle Shoals', area: 6, freqs: ['127.375'] },
  // ── ULTRA HIGH (3-2-4) ─────────────────────────────────────────────────────
  { stratum: 'UH', id: '33', name: 'Elvis', area: 1, freqs: ['127.975'] },
  { stratum: 'UH', id: '34', name: 'Sikeston', area: 1, freqs: ['133.125'] },
  { stratum: 'UH', id: '19', name: 'Drake', area: 2, freqs: ['133.025'] },
  { stratum: 'UH', id: '35', name: 'Walnut Ridge', area: 2, freqs: ['135.225'] },
  { stratum: 'UH', id: '20', name: 'Little Rock', area: 3, freqs: ['125.475'] },
  // UH map: "44 Pine Bluff *" – the Pine Bluff position also works the UH above it.
  { stratum: 'UH', id: '44', name: 'Pine Bluff', area: 3, freqs: [] },
  { stratum: 'UH', id: '43', name: 'Greenwood', area: 4, freqs: ['127.425'] },
  { stratum: 'UH', id: '61', name: 'Clarksville', area: 5, freqs: ['124.125'] },
  { stratum: 'UH', id: '32', name: 'Tupelo', area: 6, freqs: ['135.650'] },
];

export const sectorKey = (stratum: Stratum, id: string) => `${stratum}-${id}`;
export const SECTOR_BY_KEY = new Map(SECTORS.map((s) => [sectorKey(s.stratum, s.id), s]));

/** A staffable position (one per sector number). */
export interface Position {
  id: string;
  name: string;
  stratum: Stratum;
  freq: string;
  callsign: string;
}

export const POSITIONS = new Map<string, Position>();
for (const s of SECTORS) {
  if (POSITIONS.has(s.id)) continue;
  POSITIONS.set(s.id, {
    id: s.id,
    name: s.name,
    stratum: s.stratum,
    freq: s.freqs[0] ?? '',
    callsign: `MEM_${s.id}_CTR`,
  });
}

export const FREQ_TO_POSITION = new Map<string, string>();
for (const s of SECTORS) for (const f of s.freqs) FREQ_TO_POSITION.set(f, s.id);

type AreaMap = Record<Area, string>;
const areas = (m: Partial<Record<string, string>>): AreaMap => {
  const out = {} as AreaMap;
  for (const [k, v] of Object.entries(m)) for (const a of k.split(',')) out[Number(a) as Area] = v!;
  return out;
};

/**
 * Preferred stratum splits (3-2-3, 3-2-5), most de-combined first.
 * An unstaffed sector falls back through 4-way → 3-way → 2-way owners.
 */
export const STRATUM_SPLITS: Record<Stratum, { primary?: string; ways: AreaMap[] }> = {
  LO: {
    // Paducah (05) is the default combined LO position.
    primary: '05',
    ways: [
      areas({ '1,5': '05', '4': '15', '6': '13', '2,3': '01' }),
      areas({ '1,5,6': '05', '4': '15', '2,3': '01' }),
      areas({ '1,5,6': '05', '2,3,4': '15' }),
    ],
  },
  HI: {
    primary: '22',
    ways: [
      areas({ '2,3': '22', '1,5': '63', '4': '45', '6': '31' }),
      areas({ '2,3': '22', '1,5': '63', '4,6': '45' }),
      areas({ '2,3,4': '22', '1,5,6': '63' }),
    ],
  },
  UH: {
    primary: '33',
    ways: [
      areas({ '1': '33', '2,3': '20', '5': '61', '4,6': '32' }),
      areas({ '1,5': '33', '2,3': '20', '4,6': '32' }),
      areas({ '1,5,6': '33', '2,3,4': '20' }),
    ],
  },
};

/** Combined (all-altitude) area splits, 3-2-1: 4-way, 3-way, 2-way. */
export const COMBINED_SPLITS: Record<Region, string>[] = [
  { NW: '22', CW: '44', SW: '44', SE: '46', NE: '63' },
  { NW: '22', CW: '22', SW: '46', SE: '46', NE: '63' },
  { NW: '22', CW: '22', SW: '22', SE: '63', NE: '63' },
];
export const COMBINED_PRIMARY = '22';
export const COMBINED_POSITIONS = new Set(['22', '63', '46', '44']);

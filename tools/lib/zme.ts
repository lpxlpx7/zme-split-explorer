/**
 * ZME sector polygons from the ZME video maps.
 *
 * Video maps contain only boundary lines, so we polygonize them and assign sector ids by
 * polygon index (verified visually against the ZME Center SOP maps, V1.3 12/25/25).
 */
import {
  interiorXY,
  point,
  polygonize,
  polygons,
  unionAll,
  centroidXY,
  type Geom,
} from './geom.ts';
import type { VideoMaps } from './videomaps.ts';

export type Stratum = 'LO' | 'HI' | 'UH';
export type Region = 'NW' | 'NE' | 'CW' | 'SW' | 'SE';

export const MAPS = {
  CNTR_HI: 'ZME_ZMEHI_F1B1_CNTR',
  CNTR_LO: 'ZME_ZMELO_F1B1_CNTR',
  LO: 'ZME_FLOW_F2B2_LOW SECTORS',
  HI: 'ZME_ZMEHI_F8B8_HI',
  UH: 'ZME_ZMEHI_F9B9_UH',
  /** Same lines as LO SECTORS but includes the stubs of the adjacent facilities' low sectors. */
  LO_NEIGHBORS: 'ZME_ZMELO_F2B2_LO',
  SPLITS: ['ARTCC 4-Way Split', 'ARTCC 3-Way Split', 'ARTCC 2-Way Split'],
} as const;

export const ALL_MAPS = [MAPS.CNTR_HI, MAPS.CNTR_LO, MAPS.LO, MAPS.HI, MAPS.UH, MAPS.LO_NEIGHBORS, ...MAPS.SPLITS];

export interface Piece {
  pid: string;
  stratum: Stratum;
  sector: string;
  region: Region;
  /** For LO/UH pieces: the HI piece directly above/below. */
  hi: string | null;
  g: Geom;
}

export interface ZmeAirspace {
  zmeLo: Geom;
  zmeHi: Geom;
  regions: Map<Region, Geom>;
  sectors: Map<string, { stratum: Stratum; sector: string; g: Geom }>;
  pieces: Piece[];
}

/** Faces of the line set, largest-first filtering as in the original build, sorted north→south, west→east. */
function faces(vm: VideoMaps, names: string[]): Geom[] {
  const ps = polygonize(unionAll(vm.lines(names))).filter((p) => p.getArea() > 0.05);
  const key = (p: Geom) => centroidXY(p);
  return ps.sort((a, b) => {
    const [ax, ay] = key(a);
    const [bx, by] = key(b);
    return by - ay || ax - bx;
  });
}

const STRATA: Record<Stratum, { maps: string[]; ids: Record<number, string> }> = {
  LO: {
    maps: [MAPS.LO, MAPS.CNTR_LO],
    ids: {
      0: '05', 1: '41', 2: '04', 3: '07', 4: '03', 5: '42', 6: '02', 7: '40',
      8: '14', 9: '01', 10: '15', 11: '13', 12: '12', 13: '13', 14: '67', 15: '66', 16: '65',
    },
  },
  HI: {
    maps: [MAPS.HI, MAPS.CNTR_HI],
    ids: {
      0: '25', 1: '63', 2: '27', 3: '62', 4: '28', 5: '26', 6: '22', 7: '28', 8: '28',
      9: '28', 10: '21', 11: '28', 12: '31', 13: '44', 14: '30', 15: '45', 16: '46',
    },
  },
  UH: {
    maps: [MAPS.UH, MAPS.CNTR_HI],
    ids: { 0: '35', 1: '61', 2: '33', 3: '19', 4: '34', 5: '20', 6: '32', 7: '44', 8: '43' },
  },
};

const MIN_PIECE = 2e-5;

export function buildZme(vm: VideoMaps): ZmeAirspace {
  // The low stratum is laterally larger than HI/UH (N. Alabama, the south and a NW strip),
  // so LO uses the ZMELO center boundary and HI/UH the ZMEHI one.
  const cmbHi = faces(vm, [...MAPS.SPLITS, MAPS.CNTR_HI]);
  const zmeHi = unionAll([2, 3, 5, 7, 9].map((i) => cmbHi[i]));

  const cmbLo = faces(vm, [...MAPS.SPLITS, MAPS.CNTR_LO]);
  const memphis = point(-90.0, 35.1);
  const loOutline = polygonize(unionAll(vm.lines([MAPS.CNTR_LO])))
    .filter((p) => p.contains(memphis))
    .sort((a, b) => b.getArea() - a.getArea())[0];
  const inLo = cmbLo.filter((p) => loOutline.contains(point(...interiorXY(p))));
  const REGION_IDX: Region[] = ['NE', 'NW', 'CW', 'SE', 'SW'];
  const regions = new Map<Region, Geom>(REGION_IDX.map((r, i) => [r, inLo[i]]));
  const zmeLo = unionAll([...regions.values()]);

  if (zmeHi.difference(zmeLo).getArea() > 1e-3) throw new Error('HI boundary must lie within LO');
  if (Math.abs(zmeLo.getArea() - 38.007) > 0.05) throw new Error(`Unexpected ZME LO area ${zmeLo.getArea()}`);

  const sectors: ZmeAirspace['sectors'] = new Map();
  for (const [stratum, def] of Object.entries(STRATA) as [Stratum, (typeof STRATA)[Stratum]][]) {
    const zme = stratum === 'LO' ? zmeLo : zmeHi;
    const ps = faces(vm, def.maps).filter((p) => zme.contains(point(...interiorXY(p))));
    if (ps.length !== Object.keys(def.ids).length)
      throw new Error(`${stratum}: expected ${Object.keys(def.ids).length} faces, got ${ps.length} — did the video map change?`);
    const groups = new Map<string, Geom[]>();
    ps.forEach((p, i) => groups.set(def.ids[i], [...(groups.get(def.ids[i]) ?? []), p]));
    for (const [sector, g] of groups) sectors.set(`${stratum}-${sector}`, { stratum, sector, g: unionAll(g).buffer(0) });
  }

  // Pieces: HI ∩ region; LO/UH ∩ region ∩ HI piece (LO beyond the HI boundary: hi = null).
  const pieces: Piece[] = [];
  const hiPieces: Piece[] = [];
  for (const s of sectors.values()) {
    if (s.stratum !== 'HI') continue;
    for (const [region, rg] of regions)
      for (const p of polygons(s.g.intersection(rg)))
        if (p.getArea() > MIN_PIECE) {
          const piece: Piece = { pid: `HI-${s.sector}-${pieces.length}`, stratum: 'HI', sector: s.sector, region, hi: null, g: p };
          pieces.push(piece);
          hiPieces.push(piece);
        }
  }
  const hiUnion = unionAll(hiPieces.map((p) => p.g));
  for (const s of sectors.values()) {
    if (s.stratum === 'HI') continue;
    for (const hp of hiPieces)
      for (const p of polygons(s.g.intersection(hp.g)))
        if (p.getArea() > MIN_PIECE)
          pieces.push({ pid: `${s.stratum}-${s.sector}-${pieces.length}`, stratum: s.stratum, sector: s.sector, region: hp.region, hi: hp.pid, g: p });
    const rest = s.g.difference(hiUnion);
    for (const [region, rg] of regions)
      for (const p of polygons(rest.intersection(rg)))
        if (p.getArea() > MIN_PIECE)
          pieces.push({ pid: `${s.stratum}-${s.sector}-${pieces.length}`, stratum: s.stratum, sector: s.sector, region, hi: null, g: p });
  }

  return { zmeLo, zmeHi, regions, sectors, pieces };
}

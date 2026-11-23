import { FREQ_TO_POSITION, POSITIONS } from './sectors';

const FEED = 'https://data.vatsim.net/v3/vatsim-data.json';
export const POLL_MS = 15_000;

export interface VatsimController {
  cid: number;
  name: string;
  callsign: string;
  frequency: string;
  facility: number;
  rating: number;
  logon_time: string;
  text_atis: string[] | null;
}

export interface VatsimPilot {
  cid: number;
  callsign: string;
  latitude: number;
  longitude: number;
  altitude: number;
  groundspeed: number;
  heading: number;
  flight_plan: { aircraft_short?: string; departure?: string; arrival?: string } | null;
}

export interface VatsimData {
  general: { update_timestamp: string };
  controllers: VatsimController[];
  pilots: VatsimPilot[];
}

export async function fetchVatsim(signal?: AbortSignal): Promise<VatsimData> {
  const res = await fetch(FEED, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`VATSIM data feed returned HTTP ${res.status}`);
  return res.json() as Promise<VatsimData>;
}

export const RATINGS = ['', 'OBS', 'S1', 'S2', 'S3', 'C1', 'C2', 'C3', 'I1', 'I2', 'I3', 'SUP', 'ADM'];

/** Online ZME center controller resolved to a sector position. */
export interface OnlineController {
  position: string;
  callsign: string;
  frequency: string;
  name: string;
  cid: number;
  rating: string;
  logon: Date;
  /** Not a real login: a local preview or a plan being edited. */
  preview?: boolean;
}

const CALLSIGN = /^MEM_(?:([A-Z0-9]{1,3})_)?(?:([A-Z0-9]{1,3})_)?CTR$/;

/**
 * Map a controller to a ZME position:
 * 1. a two- or three-digit sector number in the callsign: MEM_22_CTR → 22, MEM_221_CTR → 22 (first two digits);
 * 2. otherwise the frequency (relief callsigns like MEM_1_CTR);
 * 3. otherwise a one-digit number (MEM_5_CTR → 05), and bare MEM_CTR → the primary combined position (22).
 */
export function resolvePosition(c: Pick<VatsimController, 'callsign' | 'frequency'>): string | null {
  const callsign = c.callsign.toUpperCase();
  const m = CALLSIGN.exec(callsign);
  if (!m) return null;
  const parts = [m[2], m[1]].filter((x): x is string => !!x && /^\d+$/.test(x));
  for (const part of parts) {
    if (part.length < 2 || part.length > 3) continue;
    const id = part.slice(0, 2);
    if (POSITIONS.has(id)) return id;
  }
  const byFreq = FREQ_TO_POSITION.get(Number.parseFloat(c.frequency).toFixed(3));
  if (byFreq) return byFreq;
  for (const part of parts) {
    const id = part.padStart(2, '0');
    if (part.length === 1 && POSITIONS.has(id)) return id;
  }
  return m[1] || m[2] ? null : '22';
}

export function zmeControllers(data: VatsimData): OnlineController[] {
  const out: OnlineController[] = [];
  for (const c of data.controllers) {
    if (c.facility !== 6 || c.frequency === '199.998') continue;
    const position = resolvePosition(c);
    if (!position) continue;
    out.push({
      position,
      callsign: c.callsign,
      frequency: Number.parseFloat(c.frequency).toFixed(3),
      name: c.name,
      cid: c.cid,
      rating: RATINGS[c.rating] ?? '',
      logon: new Date(c.logon_time),
    });
  }
  return out.sort((a, b) => a.position.localeCompare(b.position));
}

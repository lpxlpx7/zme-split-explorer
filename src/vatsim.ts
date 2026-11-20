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
  preview?: boolean;
}

const CALLSIGN = /^MEM_(?:([A-Z0-9]{1,3})_)?(?:([A-Z0-9]{1,3})_)?CTR$/;

/**
 * Map a controller to a ZME position: frequency first (relief callsigns like
 * MEM_1_CTR still match), then the sector number in the callsign, then bare
 * MEM_CTR → the primary combined position (Razorback 22).
 */
export function resolvePosition(c: Pick<VatsimController, 'callsign' | 'frequency'>): string | null {
  const callsign = c.callsign.toUpperCase();
  const m = CALLSIGN.exec(callsign);
  if (!m) return null;
  const freq = Number.parseFloat(c.frequency).toFixed(3);
  const byFreq = FREQ_TO_POSITION.get(freq);
  if (byFreq) return byFreq;
  for (const part of [m[2], m[1]]) {
    if (part && /^\d{1,2}$/.test(part)) {
      const id = part.padStart(2, '0');
      if (POSITIONS.has(id)) return id;
    }
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

export function neighborOnline(data: VatsimData, prefixes: string[]): VatsimController[] {
  return data.controllers.filter(
    (c) => c.facility === 6 && c.frequency !== '199.998' &&
      prefixes.some((p) => c.callsign.toUpperCase().startsWith(`${p}_`) && c.callsign.toUpperCase().endsWith('_CTR')),
  );
}

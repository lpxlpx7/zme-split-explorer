/**
 * Runway configuration from the FAA digital ATIS (https://atis.info/api/{ICAO}).
 *
 * The API returns the ATIS as free text, e.g. "VISUAL APCHS RWY 2L IN USE. DEPG RWY 2R." for BNA or
 * "VISUAL APCH IN USE RY 36C. SIMUL DEPS IN USE RY 36L 36C 36R." for MEM, so the runways are read out
 * of the sentences about approaches/arrivals and departures (anything after the NOTAM part is ignored).
 */

export interface Atis {
  airport: string;
  /** Information letter. */
  code: string;
  time: string;
  arr: string[];
  dep: string[];
  /** Configuration id in tracon.json (BNA: N, S, 13, 31; M03: N, S), or null if the runways don't say. */
  config: string | null;
  text: string;
}

interface AtisEntry {
  airport: string;
  type: 'combined' | 'arr' | 'dep';
  code: string;
  datis: string;
  time: string;
}

/** ATIS airport per facility. */
export const ATIS_AIRPORT: Record<string, string> = { BNA: 'KBNA', M03: 'KMEM' };

const RWY = /\b(?:RWYS?|RYS?|RUNWAYS?)\s+((?:\d{1,2}[LCR]?(?:\s*(?:,|AND|&|\/)?\s*)?)+)/g;

function runways(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(RWY))
    for (const r of m[1].matchAll(/\d{1,2}[LCR]?/g)) out.push(r[0].replace(/^0/, ''));
  return out;
}

/** Arrival and departure runways in an ATIS text (before the NOTAMs). */
export function parseRunways(text: string): { arr: string[]; dep: string[] } {
  const body = text.toUpperCase().split(/NOTICE TO AIRMEN|NOTAMS?\b/)[0];
  const arr = new Set<string>();
  const dep = new Set<string>();
  for (const s of body.split(/\.\s+/)) {
    const rs = runways(s);
    if (!rs.length) continue;
    // Closed or unserviceable runways are not in use.
    if (/\bCLSD\b|\bCLOSED\b|\bOTS\b/.test(s)) continue;
    const isDep = /\bDEP|\bDEPG|\bDEPARTING|\bDEPARTURES?\b/.test(s);
    const isArr = /\bAPCH|\bAPP(?:ROACH)?|\bARR|\bLDG|\bLAND|\bILS\b|\bRNAV\b|\bVIS(?:UAL)?\b|\bEXPECT/.test(s);
    if (isArr) rs.forEach((r) => arr.add(r));
    if (isDep) rs.forEach((r) => dep.add(r));
  }
  return { arr: [...arr], dep: [...dep] };
}

const num = (r: string) => Number.parseInt(r, 10);

/** Which TRACON configuration the runways in use mean. */
export function configFor(facility: string, arr: string[], dep: string[]): string | null {
  const pick = (rs: string[]): string | null => {
    const n = rs.map(num);
    if (facility === 'BNA') {
      if (n.includes(13)) return '13';
      if (n.includes(31)) return '31';
      if (n.some((x) => x >= 1 && x <= 4)) return 'N';
      if (n.some((x) => x >= 19 && x <= 22)) return 'S';
    }
    if (facility === 'M03') {
      if (n.some((x) => x >= 35 || x === 1)) return 'N';
      if (n.some((x) => x >= 17 && x <= 19)) return 'S';
    }
    return null;
  };
  // Arrivals decide; departures only if the arrival runways don't (e.g. MEM landing 27 only).
  return pick(arr) ?? pick(dep);
}

export async function fetchAtis(facility: string, signal?: AbortSignal): Promise<Atis> {
  const icao = ATIS_AIRPORT[facility];
  const res = await fetch(`https://atis.info/api/${icao}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`atis.info returned HTTP ${res.status}`);
  const entries = (await res.json()) as AtisEntry[];
  if (!Array.isArray(entries) || !entries.length) throw new Error(`No ATIS for ${icao}`);
  // Split ATIS: arrival runways from the arrival ATIS, departures from the departure one.
  const arrE = entries.find((e) => e.type === 'arr') ?? entries.find((e) => e.type === 'combined') ?? entries[0];
  const depE = entries.find((e) => e.type === 'dep') ?? arrE;
  const a = parseRunways(arrE.datis);
  const d = depE === arrE ? a : parseRunways(depE.datis);
  const arr = a.arr;
  const dep = depE === arrE ? a.dep : d.dep;
  return {
    airport: icao,
    code: arrE.code,
    time: arrE.time,
    arr,
    dep,
    config: configFor(facility, arr, dep),
    text: entries.map((e) => e.datis).join('\n\n'),
  };
}

/**
 * Reads ERAM/STARS video maps straight from a local CRC install.
 * CRC stores them as VideoMaps/<ARTCC>/<ulid>.geojson; ARTCCs/<ARTCC>.json maps names to ids.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { read, type Geom } from './geom.ts';

interface VideoMapEntry {
  id: string;
  name: string;
  sourceFileName?: string;
}

export function defaultCrcDir(): string {
  if (process.env.CRC_DIR) return process.env.CRC_DIR;
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'CRC');
}

const readJSON = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;

export class VideoMaps {
  private readonly byName = new Map<string, string>();
  readonly dir: string;

  constructor(readonly crcDir: string, readonly artcc = 'ZME') {
    const config = path.join(crcDir, 'ARTCCs', `${artcc}.json`);
    this.dir = path.join(crcDir, 'VideoMaps', artcc);
    if (!fs.existsSync(config) || !fs.existsSync(this.dir))
      throw new Error(`No CRC data for ${artcc} under ${crcDir} (set CRC_DIR or pass --crc <dir>)`);
    for (const m of readJSON<{ videoMaps: VideoMapEntry[] }>(config).videoMaps) {
      // Look up by CRC map name ("ZME_ZMEHI_F8B8_HI") or by source file ("ARTCC 2-Way Split").
      this.byName.set(m.name.trim(), m.id);
      if (m.sourceFileName) this.byName.set(m.sourceFileName.replace(/\.geojson$/i, '').trim(), m.id);
    }
  }

  file(name: string): string {
    const id = this.byName.get(name);
    if (!id) throw new Error(`Video map "${name}" not found in ${this.artcc}.json`);
    return path.join(this.dir, `${id}.geojson`);
  }

  /** Newest modification time across the given maps (used to decide whether to rebuild). */
  mtime(names: string[]): number {
    return Math.max(...names.map((n) => fs.statSync(this.file(n)).mtimeMs));
  }

  /** All LineStrings in the given maps, as JSTS geometries. */
  lines(names: string[]): Geom[] {
    const out: Geom[] = [];
    for (const n of names) {
      const fc = readJSON<GeoJSON.FeatureCollection>(this.file(n));
      for (const f of fc.features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'LineString' && g.coordinates.length > 1) out.push(read(g));
        else if (g.type === 'MultiLineString')
          for (const c of g.coordinates) if (c.length > 1) out.push(read({ type: 'LineString', coordinates: c }));
      }
    }
    return out;
  }
}

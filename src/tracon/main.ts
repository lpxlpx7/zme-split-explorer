/**
 * TRACON split preview (BNA, M03): switch radar positions on, pick the runway configuration and an
 * altitude, and the map shows who would work each piece of airspace there.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';
import './tracon.css';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { ColorBook } from '../colors';
import { icons } from '../ui/icons';
import { BottomSheet } from '../ui/sheet';
import { fetchVatsim } from '../vatsim';
import { fetchAtis, type Atis } from './atis';
import { FACILITIES, fmtAlt, fmtFl, layerAt, ownerOf, parseAlt, type FacilityInfo, type Layer } from './data';

maplibregl.setWorkerUrl(workerUrl);

// ─── data ────────────────────────────────────────────────────────────────────
interface PieceProps {
  pid: string;
  layers: Layer[];
  label: [number, number];
}
interface ConfigData {
  id: string;
  name: string;
  pieces: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, PieceProps>;
}
interface TraconData {
  id: string;
  name: string;
  boundary: GeoJSON.Geometry;
  configs: ConfigData[];
}

const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const FONT = ['Montserrat SemiBold', 'Open Sans Bold', 'Noto Sans Regular'];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mobile = () => window.matchMedia('(max-width: 760px)').matches;

// ─── state ───────────────────────────────────────────────────────────────────
interface Saved {
  fac: string;
  alt: number;
  config: Record<string, string>;
  /** Per facility: take the configuration from the live ATIS. */
  follow: Record<string, boolean>;
  open: Record<string, string[]>;
}
function loadSaved(): Saved {
  const def: Saved = { fac: 'BNA', alt: 70, config: {}, follow: { BNA: true, M03: true }, open: { BNA: ['DRW', 'DRE'], M03: ['E', 'V'] } };
  try {
    const v = JSON.parse(store.get('tracon.preview') ?? '') as Partial<Saved>;
    return {
      fac: FACILITIES.some((f) => f.id === v.fac) ? v.fac! : def.fac,
      alt: typeof v.alt === 'number' ? v.alt : def.alt,
      config: v.config && typeof v.config === 'object' ? v.config : {},
      follow: v.follow && typeof v.follow === 'object' ? { ...def.follow, ...v.follow } : def.follow,
      open: v.open && typeof v.open === 'object' ? { ...def.open, ...v.open } : def.open,
    };
  } catch {
    return def;
  }
}
const saved = loadSaved();
const hashFac = location.hash.slice(1).toUpperCase();
if (hashFac === 'MEM' || hashFac === 'M03') saved.fac = 'M03';
if (hashFac === 'BNA') saved.fac = 'BNA';

const state = {
  fac: saved.fac,
  alt: saved.alt,
  config: saved.config,
  follow: saved.follow,
  atis: new Map<string, Atis | { error: string }>(),
  open: new Map(FACILITIES.map((f) => [f.id, new Set((saved.open[f.id] ?? []).filter((c) => f.positions.some((p) => p.code === c)))])),
  loading: false,
  note: null as string | null,
};

let data: TraconData[] = [];
let map: MLMap;

const colors = new ColorBook();

const fac = (): FacilityInfo => FACILITIES.find((f) => f.id === state.fac)!;
const facData = (): TraconData => data.find((t) => t.id === state.fac)!;
const atisOf = (id = state.fac): Atis | null => {
  const a = state.atis.get(id);
  return a && !('error' in a) ? a : null;
};
/** The configuration shown: the live ATIS one while following it (and it is known), else the picked one. */
const cfgData = (): ConfigData => {
  const t = facData();
  const fromAtis = state.follow[t.id] ? atisOf(t.id)?.config : null;
  return t.configs.find((c) => c.id === (fromAtis ?? state.config[t.id])) ?? t.configs[0];
};
const openSet = () => state.open.get(state.fac)!;
const posOf = (code: string) => fac().positions.find((p) => p.code === code)!;

function save() {
  store.set('tracon.preview', JSON.stringify({
    fac: state.fac,
    alt: state.alt,
    config: state.config,
    follow: state.follow,
    open: Object.fromEntries([...state.open].map(([k, v]) => [k, [...v]])),
  }));
}

// ─── ownership ───────────────────────────────────────────────────────────────
interface Resolved {
  layer: Layer | null;
  owner: string | null;
}
function resolve(props: PieceProps, alt = state.alt): Resolved {
  const layer = layerAt(props.layers, alt);
  return { layer, owner: layer ? ownerOf(fac(), layer, openSet()) : null };
}

/**
 * The final position (if one is open) that works part of this piece at some other altitude than the
 * one shown. Finals sit low (ARF SFC–060 …), so at the usual altitudes the arrival position above
 * them owns the piece; the map still marks where the finals are.
 */
function finalIn(props: PieceProps, current: string | null): { code: string; lo: number; hi: number } | null {
  const f = fac();
  for (const l of props.layers) {
    const owner = ownerOf(f, l, openSet());
    if (owner && owner !== current && f.finals.includes(owner) && f.finals.includes(l.pos)) return { code: owner, lo: l.lo, hi: l.hi };
  }
  return null;
}

/** Pieces with the owner at the current altitude (and its colour) baked in. */
function coloredPieces(): GeoJSON.FeatureCollection {
  const fc = cfgData().pieces;
  const resolved = fc.features.map((f) => resolve(f.properties));
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f, i) => ({
      ...f,
      properties: {
        pid: f.properties.pid,
        owner: resolved[i].owner ? posOf(resolved[i].owner!).abbr : null,
        color: colors.get(resolved[i].owner),
        delegated: !!resolved[i].layer,
        finalColor: colors.get(finalIn(f.properties, resolved[i].owner)?.code),
      },
    })),
  };
}

function labelPoints(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cfgData().pieces.features.flatMap((f) => {
      const r = resolve(f.properties);
      const fin = finalIn(f.properties, r.owner);
      if ((!r.owner || !r.layer) && !fin) return [];
      const main = r.owner && r.layer ? { text: posOf(r.owner).abbr, band: `${fmtFl(r.layer.lo)}–${fmtFl(r.layer.hi)}` } : { text: '', band: '' };
      return [{
        type: 'Feature' as const,
        properties: { ...main, final: fin ? `${posOf(fin.code).abbr} ${fmtFl(fin.lo)}–${fmtFl(fin.hi)}` : '', finalColor: colors.get(fin?.code) },
        geometry: { type: 'Point' as const, coordinates: f.properties.label },
      }];
    }),
  };
}

// ─── map ─────────────────────────────────────────────────────────────────────
function bounds(): maplibregl.LngLatBounds {
  const b = new maplibregl.LngLatBounds();
  const add = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') b.extend(c as [number, number]);
    else (c as unknown[]).forEach(add);
  };
  add((facData().boundary as GeoJSON.LineString).coordinates);
  return b;
}

function padding(): maplibregl.PaddingOptions {
  const hidden = document.documentElement.dataset.panel === 'hidden';
  if (!mobile()) return { top: 80, bottom: 40, left: hidden ? 60 : 420, right: 60 };
  if (hidden) return { top: 76, bottom: 24, left: 16, right: 16 };
  const visible = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-visible')) || 220;
  return { top: 76, bottom: Math.min(visible, window.innerHeight * 0.55) + 12, left: 16, right: 16 };
}

function installLayers() {
  const dark = darkQuery.matches;
  const t = dark
    ? { line: 'rgba(235,235,245,0.42)', boundary: '#E5E5EA', empty: 'rgba(142,142,147,0.14)', halo: '#1C1C1E', text: '#F2F2F7', muted: 'rgba(235,235,245,0.6)' }
    : { line: 'rgba(60,60,67,0.45)', boundary: '#1D1D1F', empty: 'rgba(142,142,147,0.14)', halo: '#FFFFFF', text: '#1D1D1F', muted: 'rgba(60,60,67,0.65)' };
  map.addSource('pieces', { type: 'geojson', data: EMPTY, promoteId: 'pid' });
  map.addSource('labels', { type: 'geojson', data: EMPTY });
  map.addSource('boundary', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'pieces-fill', type: 'fill', source: 'pieces',
    paint: {
      'fill-color': ['coalesce', ['get', 'color'], t.empty],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.62, ['get', 'delegated'], 0.38, 0.12],
    },
  });
  map.addLayer({ id: 'pieces-line', type: 'line', source: 'pieces', paint: { 'line-color': t.line, 'line-width': 1 } });
  // Where an open final works lower down: a dashed outline in the final's colour.
  map.addLayer({
    id: 'final-line', type: 'line', source: 'pieces', filter: ['!=', ['get', 'finalColor'], null],
    paint: { 'line-color': ['get', 'finalColor'], 'line-width': 3, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', paint: { 'line-color': t.boundary, 'line-width': 2, 'line-opacity': 0.8 } });
  map.addLayer({
    id: 'piece-labels', type: 'symbol', source: 'labels', minzoom: 7,
    layout: {
      'text-field': [
        'format',
        ['get', 'text'], { 'font-scale': 1 },
        '\n', {},
        ['get', 'band'], { 'font-scale': 0.78 },
        // The open final working this piece lower down, in its colour.
        '\n', {},
        ['get', 'final'], { 'font-scale': 0.78, 'text-color': ['coalesce', ['get', 'finalColor'], t.text] },
      ],
      'text-font': FONT,
      'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 10, 14],
      'text-line-height': 1.05,
      'text-padding': 1,
    },
    paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.5 },
  });
  refreshMap();
}

function refreshMap() {
  if (!map?.getSource('pieces')) return;
  (map.getSource('pieces') as GeoJSONSource).setData(coloredPieces());
  (map.getSource('labels') as GeoJSONSource).setData(labelPoints());
  (map.getSource('boundary') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: facData().boundary });
}

// ─── panel ───────────────────────────────────────────────────────────────────
function renderSegments() {
  const fIdx = FACILITIES.findIndex((f) => f.id === state.fac);
  const fs = $('#facility');
  fs.style.setProperty('--i', String(fIdx));
  fs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.f === state.fac)));

  const cfgs = facData().configs;
  const cur = cfgData();
  const cs = $('#config');
  cs.style.setProperty('--n', String(cfgs.length));
  cs.style.setProperty('--i', String(cfgs.indexOf(cur)));
  cs.innerHTML = `<span class="thumb"></span>${cfgs.map((c) => `<button role="tab" data-cfg="${c.id}" aria-selected="${c === cur}" title="${esc(c.name)}">${esc(c.name.replace(' flow', '').replace('Runway', 'Rwy'))}</button>`).join('')}`;
}

function renderAlt() {
  const f = fac();
  const slider = $<HTMLInputElement>('#alt');
  slider.max = String(f.ceiling);
  if (state.alt > f.ceiling) state.alt = f.ceiling;
  slider.value = String(state.alt);
  slider.style.setProperty('--pct', `${(state.alt / f.ceiling) * 100}%`);
  const box = $<HTMLInputElement>('#alt-val');
  if (document.activeElement !== box) box.value = fmtAlt(state.alt);
  $('#topbar-alt').textContent = `${fmtAlt(state.alt)} · ${cfgData().name}`;
  const ticks = [0, 40, 80, 120, f.ceiling];
  $('#alt-scale').innerHTML = ticks.map((a) => `<span style="left:${(a / f.ceiling) * 100}%">${a ? fmtFl(a) : 'SFC'}</span>`).join('');
}

function renderBody() {
  const f = fac();
  const open = openSet();
  const fc = cfgData().pieces;
  // Who works what at this altitude.
  const count = new Map<string, number>();
  let undelegated = 0;
  for (const p of fc.features) {
    const r = resolve(p.properties);
    if (!r.owner) undelegated++;
    else count.set(r.owner, (count.get(r.owner) ?? 0) + 1);
  }
  const owners = f.positions.filter((p) => count.has(p.code));
  // Open finals with nothing at this altitude: say where they are (their pieces are outlined dashed).
  const finalsBelow = f.finals.filter((c) => open.has(c) && !count.has(c)).map((c) => {
    let top = 0;
    let pieces = 0;
    for (const p of fc.features) {
      const ls = p.properties.layers.filter((l) => f.finals.includes(l.pos) && ownerOf(f, l, open) === c);
      if (ls.length) pieces++;
      for (const l of ls) top = Math.max(top, l.hi);
    }
    return { p: posOf(c), top, pieces };
  }).filter((x) => x.pieces);
  const finalRows = finalsBelow.map(({ p, top, pieces }) => `<div class="row"><span class="swatch dashed" style="--c:${colors.get(p.code)}"></span><div class="row-main"><div><b>${p.abbr}</b> · ${esc(p.name)}</div><small>${p.freq} · up to ${esc(fmtAlt(top))} · dashed on the map</small></div><button class="btn small-btn" data-alt="${Math.max(0, top - 10)}">Show</button><span class="tag">${pieces} piece${pieces > 1 ? 's' : ''}</span></div>`).join('');
  const status = open.size
    ? `<div class="status"><div class="status-icon">${icons.radar}</div><div><div class="status-title">${open.size} position${open.size > 1 ? 's' : ''} open</div><div class="status-sub">${esc(cfgData().name)} · ${fmtAlt(state.alt)}</div></div></div>`
    : `<div class="status"><div class="status-icon offline">${icons.radar}</div><div><div class="status-title">${esc(f.name)} closed</div><div class="status-sub">Switch a position on below. Closed, the airspace goes to ZME.</div></div></div>`;

  const legend = owners.length || finalRows
    ? `<section class="group"><h3>At ${esc(fmtAlt(state.alt))}</h3><div class="inset">${finalRows}${owners.map((p) => {
        const covers = f.positions.filter((q) => q.code !== p.code && !open.has(q.code) && fc.features.some((pc) => {
          const r = resolve(pc.properties);
          return r.owner === p.code && r.layer?.pos === q.code;
        }));
        return `<div class="row"><span class="swatch" style="--c:${colors.get(p.code)}"></span><div class="row-main"><div><b>${p.abbr}</b> · ${esc(p.name)}</div><small>${p.callsign} · ${p.freq}${covers.length ? ` · also ${covers.map((q) => q.abbr).join(', ')}` : ''}</small></div><span class="tag">${count.get(p.code)} piece${count.get(p.code)! > 1 ? 's' : ''}</span></div>`;
      }).join('')}${undelegated ? `<div class="row"><span class="swatch empty"></span><div class="row-main"><div class="muted">Not delegated here</div><small>Below the floor or above the top of these pieces</small></div><span class="tag">${undelegated}</span></div>` : ''}</div></section>`
    : '';

  const a = state.atis.get(f.id);
  const follow = state.follow[f.id];
  const atisInfo = !a
    ? 'Loading the ATIS…'
    : 'error' in a
      ? `ATIS unavailable: ${esc(a.error)}`
      : `${esc(a.airport)} information ${esc(a.code)} · ${esc(a.time)}Z · ARR ${a.arr.join(' ') || '—'} · DEP ${a.dep.join(' ') || '—'}${a.config ? ` → ${esc(facData().configs.find((c) => c.id === a.config)?.name ?? '')}` : ' · runways don’t match a configuration'}`;
  const atisCard = `<section class="group"><h3>Runway configuration</h3><div class="inset">
      <label class="row switch-row"><div class="row-main"><div>Follow the live ATIS</div><small>${atisInfo}</small></div><input type="checkbox" class="switch" data-follow ${follow ? 'checked' : ''}></label>
    </div></section>`;
  const presets = `<div class="presets">${f.presets.map((p, i) => `<button class="btn" data-preset="${i}">${esc(p.label)}</button>`).join('')}<button class="btn tinted" data-online ${state.loading ? 'disabled' : ''}>${state.loading ? 'Loading…' : 'Who’s online now'}</button></div>${state.note ? `<p class="muted small note">${esc(state.note)}</p>` : ''}`;

  const positions = `<section class="group"><h3>Positions<span class="count">${open.size} on</span></h3><div class="inset">${f.positions.map((p) => {
    // Same order as ownerOf: a final goes to the other finals first.
    const peers = f.finals.includes(p.code) ? f.finals.filter((c) => c !== p.code) : [];
    const fb = [...peers, ...p.fallback.filter((c) => !peers.includes(c))].map((c) => posOf(c).abbr);
    return `<label class="row switch-row"><span class="row-num" style="${open.has(p.code) ? `background:color-mix(in srgb, ${colors.get(p.code) ?? 'var(--grey)'} 30%, transparent)` : ''}">${p.letter}</span><div class="row-main"><div>${p.abbr} · ${esc(p.name)}</div><small>${p.callsign} · ${p.freq}${fb.length ? ` · closed → ${fb.join(', then ')}` : ' · primary'}</small></div><input type="checkbox" class="switch" data-pos="${p.code}" ${open.has(p.code) ? 'checked' : ''}></label>`;
  }).join('')}</div></section>`;

  $('#body').innerHTML = `${status}${atisCard}${presets}${legend}${positions}<div style="height:calc(12px + var(--safe-bottom))"></div>`;
  $('#fineprint').innerHTML = `For VATSIM use only. Pieces are drawn from the ${esc(f.short)} STARS video maps in CRC; who owns each piece and at which altitudes follows the ${esc(f.source)}. The SOP figures and the video maps do not always agree near the airport, so treat small pieces there as approximate. A closed position’s airspace goes to the next position in its chain (CRC consolidation and SOP).`;
}

/** Colours follow the facility's position order, so a position keeps its colour as others open. */
function syncColors() {
  colors.update(fac().positions.map((p) => p.code).filter((c) => openSet().has(c)));
}

function render() {
  syncColors();
  renderSegments();
  renderAlt();
  renderBody();
  refreshMap();
  save();
}

// ─── tooltip / piece card ────────────────────────────────────────────────────
function pieceHtml(props: PieceProps): string {
  const f = fac();
  const cur = layerAt(props.layers, state.alt);
  const rows = [...props.layers].sort((a, b) => b.lo - a.lo || a.hi - b.hi).map((l) => {
    const owner = ownerOf(f, l, openSet());
    const own = posOf(l.pos);
    const by = owner && owner !== l.pos ? `<span class="muted">→ ${posOf(owner).abbr}</span>` : '';
    return `<div class="stack-row${l === cur ? ' current' : ''}"><span class="swatch${owner ? '' : ' empty'}" style="--c:${colors.get(owner) ?? 'transparent'}"></span><span class="stack-alt">${fmtFl(l.lo)}–${fmtFl(l.hi)}</span><b>${own.abbr}</b>${by}</div>`;
  }).join('');
  const r = resolve(props);
  const head = r.owner ? `${posOf(r.owner).abbr} · ${posOf(r.owner).freq}` : r.layer ? 'Nobody open' : 'Not delegated at this altitude';
  return `<div class="tip-title">${esc(head)}</div><small class="muted">${esc(fmtAlt(state.alt))} · ${esc(cfgData().name)}</small><div class="stack">${rows}</div>`;
}

function bindMap() {
  const tip = $('#tooltip');
  const card = $('#piece-card');
  let hovered: string | null = null;
  const setHover = (id: string | null) => {
    if (hovered === id) return;
    if (hovered) map.setFeatureState({ source: 'pieces', id: hovered }, { hover: false });
    hovered = id;
    if (id) map.setFeatureState({ source: 'pieces', id }, { hover: true });
  };
  const propsOf = (pid: string) => cfgData().pieces.features.find((f) => f.properties.pid === pid)?.properties;
  map.on('mousemove', 'pieces-fill', (e) => {
    const pid = e.features?.[0]?.properties?.pid as string | undefined;
    const props = pid ? propsOf(pid) : undefined;
    if (!pid || !props) return;
    setHover(pid);
    map.getCanvas().style.cursor = 'pointer';
    tip.innerHTML = pieceHtml(props);
    tip.hidden = false;
    const { offsetWidth: w, offsetHeight: h } = tip;
    const x = e.point.x;
    const y = e.point.y;
    tip.style.transform = `translate(${x + 16 + w > window.innerWidth - 8 ? x - w - 16 : x + 16}px, ${y + 16 + h > window.innerHeight - 8 ? y - h - 16 : y + 16}px)`;
  });
  map.on('mouseleave', 'pieces-fill', () => {
    setHover(null);
    tip.hidden = true;
    map.getCanvas().style.cursor = '';
  });
  // Phones have no hover: a tap opens the same breakdown as a card.
  map.on('click', (e) => {
    if (!mobile()) return;
    const f = map.queryRenderedFeatures(e.point, { layers: ['pieces-fill'] })[0];
    const props = f ? propsOf(f.properties?.pid as string) : undefined;
    if (!props) {
      card.hidden = true;
      setHover(null);
      return;
    }
    setHover(props.pid);
    card.innerHTML = `<button class="close" data-action="close-card" aria-label="Close">${icons.close}</button>${pieceHtml(props)}`;
    card.hidden = false;
  });
}

// ─── VATSIM ──────────────────────────────────────────────────────────────────
async function loadOnline() {
  const f = fac();
  state.loading = true;
  state.note = null;
  renderBody();
  try {
    const d = await fetchVatsim();
    const found = new Set<string>();
    const re = new RegExp(`^(?:${f.prefixes.join('|')})_(?:([A-Z0-9]{1,3})_)?(?:APP|DEP)$`);
    for (const c of d.controllers) {
      const m = re.exec(c.callsign.toUpperCase());
      if (!m || c.facility < 5) continue;
      const byLetter = m[1] ? f.positions.find((p) => p.letter === m[1]) : undefined;
      const byFreq = f.positions.find((p) => p.freq === c.frequency);
      const p = byLetter ?? byFreq ?? (m[1] ? undefined : f.positions[0]);
      if (p) found.add(p.code);
    }
    state.open.set(f.id, found);
    state.note = found.size ? `Loaded from VATSIM at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : `Nobody is working ${f.name} on VATSIM right now.`;
  } catch (e) {
    state.note = `Could not reach VATSIM: ${e instanceof Error ? e.message : String(e)}`;
  }
  state.loading = false;
  render();
}

// ─── chrome ──────────────────────────────────────────────────────────────────
function setPanelHidden(hidden: boolean) {
  document.documentElement.dataset.panel = hidden ? 'hidden' : 'shown';
  store.set('tracon.panel', hidden ? 'hidden' : 'shown');
  $('#panel-show-btn').hidden = !hidden;
  map?.easeTo({ padding: padding(), duration: 450 });
}

function recenter(animate = true) {
  map.fitBounds(bounds(), { padding: padding(), duration: animate ? 600 : 0 });
}

function bindUI() {
  $('#facility').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-f]');
    if (!b || b.dataset.f === state.fac) return;
    state.fac = b.dataset.f!;
    state.note = null;
    history.replaceState(null, '', `#${state.fac === 'M03' ? 'MEM' : 'BNA'}`);
    render();
    recenter();
  });
  $('#config').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cfg]');
    if (!b) return;
    state.config[state.fac] = b.dataset.cfg!;
    state.follow[state.fac] = false; // picked by hand
    render();
  });
  const slider = $<HTMLInputElement>('#alt');
  slider.addEventListener('input', () => {
    state.alt = Number(slider.value);
    renderAlt();
    renderBody();
    refreshMap();
  });
  slider.addEventListener('change', save);
  // Typed altitude: 3000, 030, 30, A030 (see parseAlt).
  const box = $<HTMLInputElement>('#alt-val');
  const apply = () => {
    const v = parseAlt(box.value);
    box.classList.toggle('invalid', v === null);
    if (v === null) return false;
    state.alt = Math.max(0, Math.min(fac().ceiling, v));
    render();
    return true;
  };
  box.addEventListener('focus', () => {
    box.value = fmtFl(state.alt);
    box.select();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && apply()) box.blur();
    if (e.key === 'Escape') {
      box.classList.remove('invalid');
      box.blur();
    }
  });
  box.addEventListener('input', () => box.classList.remove('invalid'));
  box.addEventListener('blur', () => {
    if (!box.classList.contains('invalid')) apply();
    box.classList.remove('invalid');
    box.value = fmtAlt(state.alt);
  });
  $('#body').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if ('follow' in input.dataset) {
      state.follow[state.fac] = input.checked;
      if (!input.checked) state.config[state.fac] = cfgData().id; // stay where the ATIS was
      render();
      return;
    }
    if (!input.dataset.pos) return;
    const open = openSet();
    if (input.checked) open.add(input.dataset.pos);
    else open.delete(input.dataset.pos);
    state.note = null;
    render();
  });
  $('#body').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const preset = t.closest<HTMLElement>('[data-preset]');
    if (preset) {
      state.open.set(state.fac, new Set(fac().presets[Number(preset.dataset.preset)].positions));
      state.note = null;
      render();
    }
    if (t.closest('[data-online]')) void loadOnline();
    const jump = t.closest<HTMLElement>('[data-alt]');
    if (jump) {
      state.alt = Number(jump.dataset.alt);
      render();
    }
  });
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (a === 'recenter') recenter();
    if (a === 'hide-panel' || a === 'show-panel') setPanelHidden(a === 'hide-panel');
    if (a === 'close-card') $('#piece-card').hidden = true;
  });
  // Arrow keys nudge the altitude when the map has focus.
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const step = e.key === 'ArrowUp' ? 5 : e.key === 'ArrowDown' ? -5 : 0;
    if (!step) return;
    state.alt = Math.max(0, Math.min(fac().ceiling, state.alt + step));
    render();
    e.preventDefault();
  });
}

function setupChrome() {
  $('#copy-year').textContent = String(new Date().getFullYear());
  $('#recenter-btn').innerHTML = icons.location;
  $('#panel-hide-btn').innerHTML = icons.sidebar;
  $('#panel-show-btn').innerHTML = icons.sidebar;
  $('#zme-link').innerHTML = icons.globe;
  const hidden = store.get('tracon.panel') === 'hidden';
  document.documentElement.dataset.panel = hidden ? 'hidden' : 'shown';
  $('#panel-show-btn').hidden = !hidden;
  const panel = $('#panel');
  const safeBottom = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden';
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  })();
  new BottomSheet(panel, {
    // Collapsed (title + altitude), half, full.
    detents: () => [$('#panel-handle').offsetHeight + safeBottom + 4, Math.round(window.innerHeight * 0.5), panel.offsetHeight],
    initial: 1,
    handles: [$('#panel-handle')],
    scroller: $('#panel-scroll'),
    onChange: (i) => (document.documentElement.dataset.sheet = ['small', 'medium', 'large'][i]),
  });
}

async function init() {
  setupChrome();
  const res = await fetch(`${import.meta.env.BASE_URL}data/tracon.json`);
  if (!res.ok) throw new Error('Failed to load tracon.json');
  data = ((await res.json()) as { facilities: TraconData[] }).facilities;
  render();
  map = new maplibregl.Map({
    container: $('#map'),
    style: darkQuery.matches ? STYLES.dark : STYLES.light,
    bounds: bounds(),
    fitBoundsOptions: { padding: padding() },
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('style.load', installLayers);
  map.on('error', (e) => console.error('[map]', e.error?.message ?? e.error));
  darkQuery.addEventListener('change', (e) => map.setStyle(e.matches ? STYLES.dark : STYLES.light));
  bindUI();
  bindMap();
  void pollAtis();
}

/** Both airports' ATIS, every 5 minutes. */
async function pollAtis() {
  await Promise.all(FACILITIES.map(async (f) => {
    try {
      state.atis.set(f.id, await fetchAtis(f.id));
    } catch (e) {
      if (!atisOf(f.id)) state.atis.set(f.id, { error: e instanceof Error ? e.message : String(e) });
    }
  }));
  render();
  setTimeout(pollAtis, 5 * 60_000);
}

init().catch((e: unknown) => {
  const d = document.createElement('div');
  d.className = 'fatal material';
  d.textContent = e instanceof Error ? e.message : String(e);
  document.body.appendChild(d);
});

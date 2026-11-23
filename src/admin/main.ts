/**
 * ZME Admin: a separate, Apple-style management app (admin.html, served at /admin).
 * Sidebar sections like System Settings on the Mac; on phones the sidebar is the root list and
 * each section is pushed on top of it, like Settings on iPhone.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './admin.css';
import { ColorBook } from '../colors';
import { bbox, type Polygonal } from '../geo';
import { createMap, type MapView } from '../map';
import { computeOwnership, type Ownership, type Piece } from '../ownership';
import {
  LIVE_HOURS, MAX_PLAN_HOURS, activePlan, exclusiveOf, fetchHistory, fetchPlans, fmtRange, fmtTime, fromInput,
  localZoneName, plansEnabled, savePlans, toInput, token, type LiveEdit, type Plan, type Tz,
} from '../plans';
import { POSITIONS, SECTORS, SECTOR_BY_KEY, STRATA, STRATUM_INFO, sectorKey, type Stratum } from '../sectors';
import { icons } from '../ui/icons';
import { PRESETS, esc } from '../ui/render';
import { POLL_MS, fetchVatsim, zmeControllers, type OnlineController } from '../vatsim';

// ─── state ───────────────────────────────────────────────────────────────────
type Page = 'overview' | 'live' | 'events' | 'history' | 'settings' | 'editor';

interface Draft {
  id: string; name: string; start: number; end: number;
  positions: Set<string>;
  /** Positions whose sectors are picked by hand (the others are Auto / SOP). */
  explicit: Set<string>;
  assign: Map<string, string>;
  notes: Map<string, string>;
  /** Admin-only remark about the whole event. */
  remark: string;
  isNew: boolean;
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  page: (store.get('asx.admin.page') as Page | null) ?? 'overview',
  plans: [] as Plan[],
  live: null as LiveEdit | null,
  storage: '',
  history: null as Plan[] | null,
  online: [] as OnlineController[],
  feedError: null as string | null,
  lastFeed: 0,
  tz: (store.get('asx.tz') === 'local' ? 'local' : 'utc') as Tz,
  liveHours: 4,
  stratum: ((store.get('asx.stratum') as Stratum) || 'HI') as Stratum,
  draft: null as Draft | null,
  /** Snapshot of the draft when it was opened, to warn about unsaved changes. */
  draftSaved: '',
  busy: false,
  error: null as string | null,
  /** Live page: sector keys ticked for a bulk assignment. */
  selected: new Set<string>(),
  filters: {} as Record<string, string>,
};
if (!STRATA.includes(state.stratum)) state.stratum = 'HI';
if (state.page === 'editor') state.page = 'events';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const colors = new ColorBook();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mobile = () => window.matchMedia('(max-width: 760px)').matches;

let pieces: Piece[] = [];
const sectorLabel = new Map<string, [number, number]>();
const sectorArea = new Map<string, number>();
let view: MapView | null = null;
let mapData: Parameters<typeof createMap>[1] | null = null;
let zmeBounds: [[number, number], [number, number]] = [[-95, 30], [-84, 38]];

// ─── data ────────────────────────────────────────────────────────────────────
async function load<T>(name: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}`);
  return res.json() as Promise<T>;
}

function area(g: Polygonal): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let a = 0;
  for (const poly of polys) {
    const r = poly[0];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  }
  return Math.abs(a / 2);
}

async function loadAirspace() {
  const [piecesFC, sectorsFC, labelsFC, boundaryFC, neighborsFC, artccsFC] = await Promise.all([
    load<GeoJSON.FeatureCollection>('pieces.geojson'),
    load<GeoJSON.FeatureCollection>('sectors.geojson'),
    load<GeoJSON.FeatureCollection>('labels.geojson'),
    load<GeoJSON.FeatureCollection>('boundary.geojson'),
    load<GeoJSON.FeatureCollection>('neighbor-sectors.geojson'),
    load<GeoJSON.FeatureCollection>('artccs.geojson'),
  ]);
  // Sector 60 (SFC–080) sits under 40 laterally: clone 40's pieces, hidden on the map.
  for (const f of [...piecesFC.features]) {
    const p = f.properties as Omit<Piece, 'geometry'>;
    for (const s of SECTORS.filter((x) => x.stackedUnder))
      if (p.stratum === s.stratum && p.sector === s.stackedUnder)
        piecesFC.features.push({ ...f, properties: { ...p, pid: `${p.pid}-${s.id}`, sector: s.id, hidden: true } });
  }
  pieces = piecesFC.features.map((f) => ({ ...(f.properties as Omit<Piece, 'geometry'>), geometry: f.geometry as Polygonal }));
  for (const f of labelsFC.features) {
    const pr = f.properties as { stratum: Stratum; sector: string };
    sectorLabel.set(sectorKey(pr.stratum, pr.sector), (f.geometry as GeoJSON.Point).coordinates as [number, number]);
  }
  for (const f of sectorsFC.features) {
    const pr = f.properties as { stratum: Stratum; sector: string };
    sectorArea.set(sectorKey(pr.stratum, pr.sector), area(f.geometry as Polygonal));
  }
  const lo = boundaryFC.features.find((f) => f.properties?.stratum === 'LO') ?? boundaryFC.features[0];
  const [x0, y0, x1, y1] = bbox([{ type: 'Polygon', coordinates: [(lo.geometry as GeoJSON.LineString).coordinates as [number, number][]] }]);
  zmeBounds = [[x0, y0], [x1, y1]];
  // Neighbours stay blank here: the admin map is about ZME only.
  mapData = { pieces: piecesFC, sectors: sectorsFC, labels: labelsFC, boundary: boundaryFC, neighbors: neighborsFC, artccs: artccsFC };
}

async function refreshPlans() {
  const r = await fetchPlans(token.get());
  if (!r.admin) throw new Error('Wrong token');
  if (!state.busy) {
    state.plans = r.plans;
    state.live = r.live;
  }
  state.storage = r.storage ?? '';
}

async function pollFeed() {
  try {
    state.online = zmeControllers(await fetchVatsim());
    state.feedError = null;
    state.lastFeed = Date.now();
  } catch (e) {
    state.feedError = e instanceof Error ? e.message : String(e);
  }
  try { await refreshPlans(); } catch { /* keep what we had */ }
  softRender();
  setTimeout(pollFeed, document.hidden ? POLL_MS * 4 : POLL_MS);
}

// ─── ownership ───────────────────────────────────────────────────────────────
const onlineIds = () => [...new Set(state.online.map((c) => c.position))].sort();
const liveEdits = (): [string, string][] => (state.live && state.live.expires > Date.now() ? state.live.assign : []);
const draftAssign = (d: Draft) => new Map([...d.assign].filter(([, pos]) => d.positions.has(pos) && d.explicit.has(pos)));

/** What the public map shows right now: VATSIM, then the running event, then live edits on top. */
function liveOwnership(): Ownership {
  const online = new Set(onlineIds());
  const plan = activePlan(state.plans);
  const assign = new Map<string, string>();
  for (const [k, v] of [...(plan?.assign ?? []), ...liveEdits()]) if (online.has(v)) assign.set(k, v);
  const exclusive = new Set([...exclusiveOf(plan?.assign ?? [])].filter((id) => online.has(id)));
  return computeOwnership(pieces, online, assign, exclusive);
}

/** Owners as they would be if exactly the event's positions logged on. */
const draftOwnership = (d: Draft) => computeOwnership(pieces, d.positions, draftAssign(d), d.explicit);

function currentOwnership(): { own: Ownership; ids: string[] } | null {
  if (!pieces.length) return null;
  if (state.page === 'editor' && state.draft) return { own: draftOwnership(state.draft), ids: [...state.draft.positions].sort() };
  if (state.page === 'overview' || state.page === 'live') return { own: liveOwnership(), ids: onlineIds() };
  return null;
}

// ─── map pane ────────────────────────────────────────────────────────────────
const showsMap = () => state.page === 'overview' || state.page === 'live' || state.page === 'editor';

function ownerLabels(own: Ownership): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const st of STRATA) {
    const owners = new Set(pieces.filter((p) => p.stratum === st).map((p) => own.owners.get(p.pid)).filter((x): x is string => !!x));
    for (const id of owners) {
      const keys = (own.positionSectors.get(id) ?? []).filter((k) => k.startsWith(`${st}-`) && !SECTOR_BY_KEY.get(k)?.stackedUnder);
      const whole = keys.filter((k) => own.sectorOwners.get(k)?.size === 1);
      const ownKey = sectorKey(st, id);
      const key = whole.includes(ownKey) ? ownKey : [...whole].sort((a, b) => (sectorArea.get(b) ?? 0) - (sectorArea.get(a) ?? 0))[0];
      const point = key ? sectorLabel.get(key) : undefined;
      if (!point) continue;
      const pos = POSITIONS.get(id);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: { stratum: st, id, name: pos?.name ?? '', freq: pos?.freq ?? '', rank: key === ownKey ? 0 : 1, offset: [0, 0] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function updateMap() {
  const pane = $('#map-pane');
  pane.hidden = !showsMap();
  if (pane.hidden) return;
  if (!view && mapData) {
    view = createMap($('#map'), mapData, darkQuery.matches, zmeBounds, 16);
    view.map.on('style.load', () => {
      view!.setStratum(state.stratum);
      view!.setNeighborsVisible(false);
      updateMap();
    });
    new ResizeObserver(() => view?.map.resize()).observe($('#map'));
  }
  const cur = currentOwnership();
  if (!cur) return;
  colors.update(cur.ids);
  if (view) {
    view.setStratum(state.stratum);
    const pc = new Map<string, string | null>();
    for (const [pid, owner] of cur.own.owners) pc.set(pid, colors.get(owner));
    view.setPieceColors(pc);
    view.setOwnerLabels(ownerLabels(cur.own));
  }
  const title = state.page === 'editor' ? 'Event preview' : 'Live now';
  $('#map-head').innerHTML = `<div class="map-title"><b>${title}</b><span class="secondary">${STRATUM_INFO[state.stratum].altitude}</span></div>${segmented('stratum', STRATA.map((s) => [s, STRATUM_INFO[s].label]), state.stratum)}
    <div class="map-actions"><button type="button" class="capsule" data-export="one" title="Save this stratum as a PNG image">${icons.download}<span>Save Image</span></button><button type="button" class="capsule" data-export="all" title="Low, High and Ultra High side by side">${icons.download}<span>All Strata</span></button></div>`;
  const uncovered = SECTORS.filter((s) => s.stratum === state.stratum && !cur.own.sectorOwners.get(sectorKey(s.stratum, s.id))?.size);
  const legend = cur.ids
    .map((id) => {
      const n = (cur.own.positionSectors.get(id) ?? []).filter((k) => k.startsWith(`${state.stratum}-`)).length;
      return `<span class="legend-item"><i style="background:${colors.get(id)}"></i><b>${id}</b> ${esc(POSITIONS.get(id)?.name ?? '')}<span class="secondary"> ${n}</span></span>`;
    })
    .join('');
  $('#map-legend').innerHTML = `${legend || '<span class="secondary">Nobody online · all uncovered</span>'}${uncovered.length && cur.ids.length ? `<span class="legend-warn">${icons.warn} Uncovered: ${uncovered.map((s) => s.id).join(', ')}</span>` : ''}`;
}

// ─── save the preview as an image ────────────────────────────────────────────
/** Copy the map canvas right after a fresh frame (no preserveDrawingBuffer needed). */
function captureMap(): Promise<HTMLCanvasElement> {
  const m = view!.map;
  return new Promise((resolve) => {
    let done = false;
    const grab = () => {
      if (done) return;
      done = true;
      const src = m.getCanvas();
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')!.drawImage(src, 0, 0);
      resolve(c);
    };
    // Wait until tiles and data are drawn, then grab inside the next render.
    m.once('idle', () => { m.once('render', grab); m.triggerRepaint(); });
    m.triggerRepaint();
    setTimeout(() => { m.once('render', grab); m.triggerRepaint(); }, 6000);
  });
}

function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > maxW && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** PNG of the map pane: title, one or all strata, and who works what (with the public notes). */
async function exportImage(all: boolean) {
  const cur = currentOwnership();
  if (!view || !cur) return;
  const btns = document.querySelectorAll<HTMLButtonElement>('[data-export]');
  btns.forEach((b) => (b.disabled = true));
  const keep = state.stratum;
  const strata = all ? STRATA : [state.stratum];
  const shots: HTMLCanvasElement[] = [];
  try {
    for (const st of strata) {
      view.setStratum(st);
      shots.push(await captureMap());
    }
  } finally {
    view.setStratum(keep);
    btns.forEach((b) => (b.disabled = false));
  }

  const dark = darkQuery.matches;
  const C = dark
    ? { bg: '#000000', card: '#1c1c1e', text: '#ffffff', sub: 'rgba(235,235,245,0.6)', line: 'rgba(84,84,88,0.6)', warn: '#ff9f0a' }
    : { bg: '#f2f2f7', card: '#ffffff', text: '#000000', sub: 'rgba(60,60,67,0.6)', line: 'rgba(60,60,67,0.18)', warn: '#ff9500' };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", system-ui, sans-serif';
  const dpr = shots[0].width / (view.map.getCanvas().clientWidth || shots[0].width / 2);
  const u = (n: number) => Math.round(n * dpr);
  const pad = u(28);
  const gap = u(14);
  const mw = shots[0].width;
  const mh = shots[0].height;
  const width = Math.max(u(640), pad * 2 + mw * shots.length + gap * (shots.length - 1));

  // Who works what, with the (public) position notes.
  const editing = state.page === 'editor' && state.draft;
  const plan = editing ? null : activePlan(state.plans);
  const notes = editing ? state.draft!.notes : new Map(Object.entries(plan?.notes ?? {}));
  const rows = cur.ids.map((id) => {
    const ks = cur.own.positionSectors.get(id) ?? [];
    const sectors = STRATA.map((st) => {
      const xs = ks.filter((k) => k.startsWith(`${st}-`)).map((k) => k.slice(3));
      return xs.length ? `${st} ${xs.join(' ')}` : '';
    }).filter(Boolean).join('   ·   ');
    return { id, name: POSITIONS.get(id)?.name ?? '', freq: POSITIONS.get(id)?.freq ?? '', sectors: sectors || 'Nothing', note: notes.get(id)?.trim() ?? '' };
  });
  const uncovered = SECTORS.filter((s) => strata.includes(s.stratum) && !cur.own.sectorOwners.get(sectorKey(s.stratum, s.id))?.size).map((s) => `${s.stratum} ${s.id}`);

  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `${u(13)}px ${FONT}`;
  const textX = u(170);
  const textW = width - pad * 2 - textX - u(16);
  const layout = rows.map((r) => ({ sectors: wrapText(measure, r.sectors, textW), note: r.note ? wrapText(measure, `“${r.note}”`, textW) : [] }));
  const lineH = u(19);
  const rowH = (i: number) => Math.max(u(40), (layout[i].sectors.length + layout[i].note.length) * lineH + u(6)) + u(16);
  const legendH = u(8) + (rows.length ? rows.reduce((h, _r, i) => h + rowH(i), 0) : u(40)) + (uncovered.length ? u(34) : 0) + u(4);
  const headH = u(74);
  const labelH = u(26);
  const footH = u(36);
  const height = pad + headH + labelH + mh + gap + legendH + footH + pad;

  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const g = cv.getContext('2d')!;
  g.fillStyle = C.bg;
  g.fillRect(0, 0, width, height);

  // Header
  const d = state.draft;
  const title = editing && d ? d.name.trim() || 'Untitled event' : plan ? `Live now · ${plan.name}` : 'Live now';
  const sub = editing && d
    ? Number.isFinite(d.start) && Number.isFinite(d.end) ? `${fmtRange(d.start, d.end, 'utc')}   ·   ${fmtRange(d.start, d.end, 'local')}` : ''
    : `As of ${fmtTime(Date.now(), 'utc')}   ·   ${cur.ids.length} position${cur.ids.length === 1 ? '' : 's'} online`;
  g.fillStyle = C.text;
  g.font = `700 ${u(26)}px ${FONT}`;
  g.fillText(title, pad, pad + u(30));
  g.fillStyle = C.sub;
  g.font = `${u(14)}px ${FONT}`;
  g.fillText(sub, pad, pad + u(56));

  // Maps
  let y = pad + headH;
  shots.forEach((shot, i) => {
    const x = pad + i * (mw + gap);
    const st = strata[i];
    g.fillStyle = C.text;
    g.font = `600 ${u(14)}px ${FONT}`;
    g.fillText(STRATUM_INFO[st].label, x, y + u(16));
    const lw = g.measureText(STRATUM_INFO[st].label).width;
    g.fillStyle = C.sub;
    g.font = `${u(13)}px ${FONT}`;
    g.fillText(STRATUM_INFO[st].altitude, x + lw + u(8), y + u(16));
    g.save();
    g.beginPath();
    g.roundRect(x, y + labelH, mw, mh, u(14));
    g.clip();
    g.drawImage(shot, x, y + labelH);
    g.restore();
  });
  y += labelH + mh + gap;

  // Legend card
  g.fillStyle = C.card;
  g.beginPath();
  g.roundRect(pad, y, width - pad * 2, legendH, u(14));
  g.fill();
  let ly = y + u(8);
  rows.forEach((r, i) => {
    if (i) {
      g.fillStyle = C.line;
      g.fillRect(pad + u(16), ly, width - pad * 2 - u(16), Math.max(1, u(0.5)));
    }
    const top = ly + u(10);
    g.fillStyle = colors.get(r.id) ?? '#8e8e93';
    g.beginPath();
    g.roundRect(pad + u(16), top, u(34), u(26), u(7));
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `700 ${u(13)}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(r.id, pad + u(33), top + u(18));
    g.textAlign = 'left';
    g.fillStyle = C.text;
    g.font = `600 ${u(14)}px ${FONT}`;
    g.fillText(r.name, pad + u(62), top + u(13));
    g.fillStyle = C.sub;
    g.font = `${u(12)}px ${FONT}`;
    g.fillText(r.freq, pad + u(62), top + u(30));
    g.font = `${u(13)}px ${FONT}`;
    const lines = [...layout[i].sectors.map((t) => [t, C.text]), ...layout[i].note.map((t) => [t, C.sub])];
    lines.forEach(([t, color], j) => {
      g.fillStyle = color;
      g.fillText(t, pad + textX, top + u(14) + j * lineH);
    });
    ly += rowH(i);
  });
  if (!rows.length) {
    g.fillStyle = C.sub;
    g.font = `${u(13)}px ${FONT}`;
    g.fillText('Nobody online · all uncovered', pad + u(16), ly + u(24));
    ly += u(40);
  }
  if (uncovered.length) {
    g.fillStyle = C.warn;
    g.font = `600 ${u(13)}px ${FONT}`;
    g.fillText(`Uncovered: ${uncovered.join(', ')}`, pad + u(16), ly + u(22));
  }
  y += legendH;

  g.fillStyle = C.sub;
  g.font = `${u(11.5)}px ${FONT}`;
  g.fillText(`ZME Split Explorer  ·  For VATSIM use only  ·  Generated ${fmtTime(Date.now(), 'utc')}`, pad, y + u(26));

  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new Error('the browser could not encode the PNG');
  const a = document.createElement('a');
  const safe = title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'ZME split';
  a.download = `${safe} - ${all ? 'all strata' : STRATUM_INFO[keep].label}.png`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  hud('Image saved');
}

// ─── small Apple controls ────────────────────────────────────────────────────
function segmented(name: string, items: [string, string][], value: string) {
  const i = Math.max(0, items.findIndex(([v]) => v === value));
  return `<div class="seg" role="tablist" style="--n:${items.length};--i:${i}"><span class="seg-thumb"></span>${items
    .map(([v, l]) => `<button type="button" role="tab" data-seg="${name}" data-value="${v}" aria-selected="${v === value}">${esc(l)}</button>`)
    .join('')}</div>`;
}

const searchField = (scope: string, placeholder = 'Search') =>
  `<label class="search">${icons.search}<input type="search" data-filter="${scope}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" value="${esc(state.filters[scope] ?? '')}"></label>`;

const ft = (stratum: string, id: string, name: string, extra = '') => `data-ft="${esc(`${stratum} ${id} ${name} ${extra}`.toLowerCase())}"`;

/** Says who will see what is typed into a field. */
const vis = (isPublic: boolean) =>
  isPublic ? '<span class="vis public" title="Everyone can see this">Public</span>' : `<span class="vis private" title="Only admins can see this">${icons.lock}Private</span>`;

const badge = (id: string, color: string | null) => `<span class="badge" style="${color ? `--c:${color}` : ''}">${id}</span>`;

function hud(text: string) {
  const h = $('#hud');
  h.innerHTML = `${icons.check}<span>${esc(text)}</span>`;
  h.hidden = false;
  h.classList.remove('out');
  clearTimeout((hud as unknown as { t?: number }).t);
  (hud as unknown as { t?: number }).t = window.setTimeout(() => { h.classList.add('out'); setTimeout(() => (h.hidden = true), 250); }, 1300);
}

/** Apple-style alert. Resolves to true for the action button. */
function confirmAlert(title: string, message: string, action: string, destructive = true): Promise<boolean> {
  const el = $('#alert');
  el.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true"><div class="alert-text"><h3>${esc(title)}</h3><p>${esc(message)}</p></div>
    <div class="alert-buttons"><button type="button" data-alert="0">Cancel</button><button type="button" data-alert="1" class="${destructive ? 'destructive' : 'default'}">${esc(action)}</button></div></div>`;
  el.hidden = false;
  return new Promise((resolve) => {
    const done = (v: boolean) => { el.hidden = true; el.onclick = null; document.removeEventListener('keydown', key); resolve(v); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    document.addEventListener('keydown', key);
    el.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-alert]');
      if (b) done(b.dataset.alert === '1');
      else if (e.target === el) done(false);
    };
    el.querySelector<HTMLButtonElement>('[data-alert="1"]')?.focus();
  });
}

// ─── sidebar + toolbar ───────────────────────────────────────────────────────
const NAV: [Page, string, string, string][] = [
  ['overview', 'Overview', icons.gauge, '#8e8e93'],
  ['live', 'Live Edits', icons.bolt, '#ff9500'],
  ['events', 'Events', icons.calendar, '#ff3b30'],
  ['history', 'History', icons.clock, '#5856d6'],
  ['settings', 'Settings', icons.gear, '#8e8e93'],
];

function renderSidebar() {
  const upcoming = state.plans.length;
  const edits = liveEdits().length;
  const plan = activePlan(state.plans);
  const sel = state.page === 'editor' ? 'events' : state.page;
  $('#sidebar').innerHTML = `
    <div class="side-head">
      <img src="./zme_logo.png" alt="" width="44" height="44">
      <div><div class="side-title">ZME Admin</div><div class="secondary small">${plan ? `Now: ${esc(plan.name)}` : `${onlineIds().length} position${onlineIds().length === 1 ? '' : 's'} online`}</div></div>
    </div>
    <div class="side-list">${NAV.map(([p, label, icon, color]) => {
      const count = p === 'events' ? upcoming : p === 'live' ? edits : 0;
      return `<button type="button" class="side-item" data-page="${p}" aria-current="${sel === p}">
        <span class="side-icon" style="background:${color}">${icon}</span><span class="side-label">${label}</span>
        ${count ? `<span class="side-count">${count}</span>` : ''}<span class="side-chevron">${icons.chevron}</span></button>`;
    }).join('')}</div>
    <div class="side-foot">
      <a class="side-link" href="./" target="_blank" rel="noopener">${icons.external}<span>Open live map</span></a>
    </div>`;
}

function renderToolbar() {
  const titles: Record<Page, string> = { overview: 'Overview', live: 'Live Edits', events: 'Events', history: 'History', settings: 'Settings', editor: state.draft?.isNew ? 'New Event' : 'Edit Event' };
  const back = state.page === 'editor' ? ['events', 'Events'] : ['root', 'Admin'];
  const actions =
    state.page === 'events' ? `<button type="button" class="tool-btn" data-new title="New event" aria-label="New event">${icons.plus}</button>`
    : state.page === 'editor' ? `<button type="button" class="tool-text" data-cancel>Cancel</button><button type="button" class="tool-text strong" data-save ${state.busy ? 'disabled' : ''}>${state.busy ? 'Saving…' : 'Save'}</button>`
    : state.page === 'history' ? `<button type="button" class="tool-btn" data-reload-history title="Refresh" aria-label="Refresh">${icons.refresh}</button>`
    : '';
  $('#toolbar').innerHTML = `
    <button type="button" class="back" data-back="${back[0]}">${icons.back}<span>${back[1]}</span></button>
    <h1 class="title">${titles[state.page]}</h1>
    <div class="tool-actions">${actions}</div>`;
}

// ─── pages ───────────────────────────────────────────────────────────────────
const errorBanner = () => (state.error ? `<div class="banner error">${icons.warn}<span>${esc(state.error)}</span></div>` : '');

function renderOverview() {
  const plan = activePlan(state.plans);
  const next = [...state.plans].filter((p) => p.start > Date.now()).sort((a, b) => a.start - b.start)[0];
  const ids = onlineIds();
  const edits = liveEdits();
  const ctrl = (c: OnlineController) => `<div class="cell">${badge(c.position, colors.get(c.position))}
      <div class="cell-main"><div>${esc(c.callsign)}</div><div class="secondary small">${esc(c.name)} · ${esc(POSITIONS.get(c.position)?.name ?? '')}</div></div>
      <span class="cell-value mono">${esc(c.frequency)}</span></div>`;
  return `${errorBanner()}
    <div class="widgets">
      <div class="widget"><div class="widget-label">Online</div><div class="widget-big">${ids.length}</div><div class="secondary small">${state.feedError ? esc(state.feedError) : state.lastFeed ? `VATSIM · updated ${fmtTime(state.lastFeed, state.tz, false)}` : 'Connecting to VATSIM…'}</div></div>
      <div class="widget"><div class="widget-label">Event now</div><div class="widget-mid">${plan ? esc(plan.name) : '—'}</div><div class="secondary small">${plan ? `until ${esc(fmtTime(plan.end, state.tz, false))}` : 'No event running'}</div></div>
      <button type="button" class="widget tappable" data-page="live"><div class="widget-label">Live edits</div><div class="widget-big">${edits.length}</div><div class="secondary small">${edits.length ? `until ${esc(fmtTime(state.live!.expires, state.tz, false))}` : 'None'}</div></button>
      <button type="button" class="widget tappable" ${next ? `data-open="${next.id}"` : 'data-page="events"'}><div class="widget-label">Next event</div><div class="widget-mid">${next ? esc(next.name) : '—'}</div><div class="secondary small">${next ? esc(fmtTime(next.start, state.tz)) : 'Nothing planned'}</div></button>
    </div>
    <h2 class="section-title">Memphis Center on VATSIM</h2>
    <div class="group">${state.online.length ? state.online.map(ctrl).join('') : '<div class="cell empty">No ZME positions are online.</div>'}</div>
    <p class="footnote">Who is online always comes from VATSIM. Events and live edits only decide who covers which sector.</p>`;
}

function renderLive() {
  const ids = onlineIds();
  const own = pieces.length ? liveOwnership() : null;
  const edits = new Map(liveEdits());
  const sel = [...state.selected].filter((k) => k.startsWith(`${state.stratum}-`));
  const enabled = ids.length > 0 && !state.busy;
  const options = (cur: string | undefined, placeholder?: string) =>
    `${placeholder ? `<option value="-" selected disabled>${esc(placeholder)}</option>` : ''}<option value="" ${!placeholder && !cur ? 'selected' : ''}>Auto (SOP)</option>${[...new Set([...ids, ...(cur ? [cur] : [])])]
      .sort()
      .map((id) => `<option value="${id}" ${!placeholder && id === cur ? 'selected' : ''}>${id} ${esc(POSITIONS.get(id)?.name ?? '')}${ids.includes(id) ? '' : ' (offline)'}</option>`)
      .join('')}`;
  const rows = SECTORS.filter((s) => s.stratum === state.stratum)
    .map((s) => {
      const key = sectorKey(s.stratum, s.id);
      const owners = [...(own?.sectorOwners.get(key) ?? [])];
      const picked = sel.includes(key);
      return `<div class="cell sector-cell${picked ? ' picked' : ''}" ${ft(s.stratum, s.id, s.name, s.freqs.join(' '))}>
        <label class="check"><input type="checkbox" data-sel="${key}" data-range="sel" ${picked ? 'checked' : ''} ${enabled ? '' : 'disabled'} aria-label="Select ${s.id}"><span></span></label>
        ${badge(s.id, colors.get(owners[0]))}
        <div class="cell-main"><div>${esc(s.name)}${edits.has(key) ? '<span class="pill orange">Live edit</span>' : ''}</div>
          <div class="secondary small">${owners.length ? owners.map((id) => `${id} ${esc(POSITIONS.get(id)?.name ?? '')}`).join(', ') : 'Uncovered'}</div></div>
        <span class="popup"><select data-live-assign="${key}" ${enabled ? '' : 'disabled'} aria-label="Who works ${s.id}">${options(edits.get(key))}</select></span></div>`;
    })
    .join('');
  return `${errorBanner()}
    <p class="lead">Hand sectors to positions that are online right now. Saved immediately and shown to everyone; live edits win over a running event.</p>
    <div class="group">
      <div class="cell"><div class="cell-main">Keep live edits for</div><span class="popup"><select id="live-hours">${LIVE_HOURS.map((h) => `<option value="${h}" ${h === state.liveHours ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select></span></div>
      <div class="cell"><div class="cell-main">Current live edits</div><span class="cell-value">${edits.size ? `${edits.size} · until ${esc(fmtTime(state.live!.expires, state.tz, false))}` : 'None'}</span></div>
      ${edits.size ? `<button type="button" class="cell action destructive" data-live-clear ${state.busy ? 'disabled' : ''}>Clear All Live Edits</button>` : ''}
    </div>
    ${ids.length ? '' : '<div class="banner">Nobody from Memphis Center is online on VATSIM, so there is no one to hand sectors to.</div>'}
    <div class="list-head">${segmented('stratum', STRATA.map((s) => [s, STRATUM_INFO[s].label]), state.stratum)}</div>
    <div data-filter-scope="live">
      <div class="list-tools">${searchField('live', 'Search sectors — 22 63, Memphis, 132.55')}
        <button type="button" class="link-btn" data-bulk-on="sel" ${enabled ? '' : 'disabled'}>Select Shown</button></div>
      <div class="group">${rows}<div class="cell empty filter-empty" hidden>No matching sectors.</div></div>
      <p class="footnote">Tick sectors to hand several over at once. Shift-click selects a range, like files in Finder.</p>
    </div>
    ${sel.length ? `<div class="selection-bar"><span><b>${sel.length}</b> selected</span>
      <span class="popup filled"><select data-bulk-assign ${enabled ? '' : 'disabled'}>${options(undefined, 'Assign to…')}</select></span>
      <button type="button" class="link-btn" data-sel-clear>Done</button></div>` : ''}`;
}

function eventRow(p: Plan, opts: { history?: boolean } = {}) {
  const now = Date.now();
  const active = p.start <= now && now < p.end;
  const d = new Date(p.start);
  const day = state.tz === 'utc' ? d.getUTCDate() : d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short', ...(state.tz === 'utc' ? { timeZone: 'UTC' } : {}) });
  const chips = p.positions.map((id) => `<span class="mini-chip">${id}</span>`).join('');
  const tail = opts.history
    ? `<span class="row-actions"><button type="button" class="icon-action" data-dup="${p.id}" title="Duplicate as a new event" aria-label="Duplicate">${icons.copy}</button><button type="button" class="icon-action destructive" data-forget="${p.id}" title="Delete from history" aria-label="Delete">${icons.trash}</button></span>`
    : `<span class="chev">${icons.chevron}</span>`;
  return `<${opts.history ? 'div' : 'button type="button"'} class="cell event-cell${opts.history ? '' : ' tappable'}" ${opts.history ? '' : `data-open="${p.id}"`} ${ft('', '', p.name, p.positions.join(' '))}>
      <span class="date-tile${active ? ' now' : ''}"><span>${esc(month)}</span><b>${day}</b></span>
      <div class="cell-main"><div class="event-name">${esc(p.name)}${active ? '<span class="pill green">Now</span>' : ''}</div>
        <div class="secondary small">${esc(fmtRange(p.start, p.end, state.tz))}</div>
        <div class="mini-chips">${chips}<span class="secondary small">${p.assign.length ? `${p.assign.length} sectors picked` : 'All Auto (SOP)'}</span></div>
        ${p.remark ? `<div class="remark-line">${icons.lock}<span>${esc(p.remark)}</span></div>` : ''}</div>
      ${tail}</${opts.history ? 'div' : 'button'}>`;
}

function renderEvents() {
  const plans = [...state.plans].sort((a, b) => a.start - b.start);
  return `${errorBanner()}
    <p class="lead">Say ahead of time which positions are expected and who covers which sector. An event only applies to its positions that are really logged on.</p>
    <div data-filter-scope="events">
      ${plans.length > 4 ? `<div class="list-tools">${searchField('events', 'Search events')}</div>` : ''}
      <div class="group">${plans.map((p) => eventRow(p)).join('') || `<div class="cell empty">No upcoming events.</div>`}<div class="cell empty filter-empty" hidden>No matching events.</div></div>
    </div>
    <button type="button" class="big-btn" data-new>${icons.plus}<span>New Event</span></button>`;
}

function renderHistory() {
  if (!state.history) return `${errorBanner()}<div class="spinner-wrap"><div class="spinner"></div></div>`;
  return `${errorBanner()}
    <p class="lead">Finished events. Duplicate one to run it again: it gets the same weekday and time, next time round.</p>
    <div data-filter-scope="history">
      <div class="list-tools">${searchField('history', 'Search history')}</div>
      <div class="group">${state.history.map((p) => eventRow(p, { history: true })).join('') || '<div class="cell empty">No finished events yet.</div>'}<div class="cell empty filter-empty" hidden>No matching events.</div></div>
    </div>`;
}

function renderSettings() {
  return `${errorBanner()}
    <h2 class="section-title">Time</h2>
    <div class="group">
      <div class="cell"><div class="cell-main">Show times in</div>${segmented('tz', [['utc', 'UTC'], ['local', `Local · ${localZoneName()}`]], state.tz)}</div>
    </div>
    <p class="footnote">Events are always stored as absolute times; this only changes how they are shown and entered.</p>
    <h2 class="section-title">Server</h2>
    <div class="group">
      <div class="cell"><div class="cell-main">Storage</div><span class="cell-value mono">${esc(state.storage || '—')}</span></div>
      <div class="cell"><div class="cell-main">Upcoming events</div><span class="cell-value">${state.plans.length}</span></div>
    </div>
    <h2 class="section-title">Account</h2>
    <div class="group">
      <a class="cell action" href="./" target="_blank" rel="noopener">Open the live map</a>
      <button type="button" class="cell action destructive" data-signout>Sign Out</button>
    </div>
    <p class="footnote">Signing out forgets the token on this device only.</p>`;
}

function renderEditor() {
  const d = state.draft!;
  const own = pieces.length ? draftOwnership(d) : null;
  const ids = [...d.positions].sort();
  const dur = Number.isFinite(d.end - d.start) && d.end > d.start ? (d.end - d.start) / 3_600_000 : null;
  const time = (id: string, label: string, ms: number) => `<label class="cell">
      <div class="cell-main">${label}<div class="secondary small" id="${id}-other">${Number.isFinite(ms) ? esc(fmtTime(ms, state.tz === 'utc' ? 'local' : 'utc')) : ''}</div></div>
      <input type="datetime-local" class="field-inline" id="${id}" value="${Number.isFinite(ms) ? toInput(ms, state.tz) : ''}"></label>`;
  const posChips = STRATA.map((st) => `<div class="chip-group" data-fgroup><div class="chip-group-title">${STRATUM_INFO[st].label}</div><div class="chips">${[...POSITIONS.values()]
    .filter((p) => p.stratum === st)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `<label class="chip" ${ft(p.stratum, p.id, p.name, `${p.callsign} ${p.freq}`)}><input type="checkbox" data-pos="${p.id}" data-range="pos" ${d.positions.has(p.id) ? 'checked' : ''}><b>${p.id}</b> ${esc(p.name)}</label>`)
    .join('')}</div></div>`).join('');
  const coverage = ids.map((id) => {
    const pos = POSITIONS.get(id);
    const pick = d.explicit.has(id);
    const works = own?.positionSectors.get(id) ?? [];
    const result = STRATA.map((st) => {
      const ks = works.filter((k) => k.startsWith(`${st}-`));
      return ks.length ? `<div class="works-row"><span class="strat">${st}</span>${ks.map((k) => `<span class="mini-chip">${SECTOR_BY_KEY.get(k)?.id}</span>`).join('')}</div>` : '';
    }).join('');
    const picker = STRATA.map((st) => `<div class="chip-group" data-fgroup><div class="chip-group-title">${st}</div><div class="chips">${SECTORS.filter((x) => x.stratum === st)
      .map((x) => {
        const key = sectorKey(st, x.id);
        const holder = d.assign.get(key);
        return `<label class="chip small" ${ft(st, x.id, x.name, x.freqs.join(' '))}><input type="checkbox" data-sec="${key}" data-of="${id}" data-range="sec-${id}" ${holder === id ? 'checked' : ''}><b>${x.id}</b> ${esc(x.name)}${holder && holder !== id ? `<span class="taken">→${holder}</span>` : ''}</label>`;
      })
      .join('')}</div></div>`).join('');
    return `<div class="group cover" style="--c:${colors.get(id)}">
      <div class="cell cover-head">${badge(id, colors.get(id))}<div class="cell-main"><div><b>${esc(pos?.name ?? '')}</b></div><div class="secondary small">${esc(pos?.callsign ?? '')} · ${esc(pos?.freq ?? '')}</div></div>
        ${segmented(`mode-${id}`, [['auto', 'Auto (SOP)'], ['pick', 'Pick Sectors']], pick ? 'pick' : 'auto')}</div>
      <div class="cell"><input class="field" data-note="${id}" maxlength="120" placeholder="Note for this position — e.g. controller name, coordination" value="${esc(d.notes.get(id) ?? '')}">${vis(true)}</div>
      ${pick ? `<div class="cell column" data-filter-scope="sec-${id}">
        <div class="list-tools">${searchField(`sec-${id}`, 'Search sectors — 2, HI, Memphis')}
          <button type="button" class="link-btn" data-bulk-on="sec-${id}">Pick Shown</button><button type="button" class="link-btn" data-bulk-off="sec-${id}">Unpick Shown</button></div>
        ${picker}<div class="secondary small filter-empty" hidden>No matching sectors.</div></div>` : ''}
      <div class="cell column"><div class="secondary small">${pick ? 'Covers exactly' : 'SOP gives it'}${works.length ? '' : ': nothing'}</div>${result}</div>
    </div>`;
  }).join('');
  const uncovered = own ? SECTORS.filter((x) => !own.sectorOwners.get(sectorKey(x.stratum, x.id))?.size).map((x) => `${x.stratum} ${x.id}`) : [];
  return `${errorBanner()}
    <h2 class="section-title">Event</h2>
    <div class="group">
      <label class="cell"><div class="cell-main">Name ${vis(true)}</div><input class="field-inline" id="ev-name" maxlength="60" placeholder="Memphis FNO" value="${esc(d.name)}"></label>
      ${time('ev-start', 'Starts', d.start)}
      ${time('ev-end', 'Ends', d.end)}
      <div class="cell"><div class="cell-main">Time zone</div>${segmented('tz', [['utc', 'UTC'], ['local', 'Local']], state.tz)}</div>
      <div class="cell"><div class="cell-main">Duration</div><span class="cell-value" id="ev-dur">${dur ? `${+dur.toFixed(2)} h` : '—'}</span></div>
    </div>
    <p class="footnote">Everyone can see the event: its name, times, positions, who covers what and the position notes.</p>
    <h2 class="section-title">Remark ${vis(false)}</h2>
    <div class="group"><div class="cell"><textarea class="field area" id="ev-remark" maxlength="1000" rows="3" placeholder="Private remark — only admins see this, never shown on the public map">${esc(d.remark)}</textarea></div></div>
    <h2 class="section-title">Expected Positions <span class="secondary">${d.positions.size || ''}</span></h2>
    <div class="group">
      <div class="cell column">
        <div class="presets">${PRESETS.filter(([, v]) => v).map(([l, v]) => `<button type="button" class="capsule" data-preset="${v}">${esc(l)}</button>`).join('')}<button type="button" class="capsule" data-preset="">Clear</button></div>
      </div>
      <div class="cell column" data-filter-scope="pos">
        <div class="list-tools">${searchField('pos', 'Search positions — 22 63 46, LO, Razorback')}
          <button type="button" class="link-btn" data-bulk-on="pos">Pick Shown</button><button type="button" class="link-btn" data-bulk-off="pos">Unpick Shown</button></div>
        ${posChips}<div class="secondary small filter-empty" hidden>No matching positions.</div>
      </div>
    </div>
    <p class="footnote">Shift-click picks a range. Search accepts several numbers at once: “22 63 46”.</p>
    ${ids.length ? `<h2 class="section-title">Who Covers What</h2>
      <p class="footnote top">Auto follows the SOP among the Auto positions; Pick Sectors makes a position cover exactly those.</p>
      ${coverage}
      ${uncovered.length ? `<div class="banner warn">${icons.warn}<span>Uncovered: ${esc(uncovered.join(', '))}</span></div>` : '<div class="banner ok">' + icons.check + '<span>Every sector is covered.</span></div>'}` : ''}
    ${d.isNew ? '' : `<div class="group"><button type="button" class="cell action" data-dup="${d.id}">Duplicate Event</button><button type="button" class="cell action destructive" data-delete>Delete Event</button></div>`}
    <div class="bottom-space"></div>`;
}

// ─── render ──────────────────────────────────────────────────────────────────
function render() {
  document.title = state.page === 'editor' ? `${state.draft?.name || 'Event'} · ZME Admin` : 'ZME Admin';
  colors.update(state.page === 'editor' && state.draft ? [...state.draft.positions].sort() : onlineIds());
  renderSidebar();
  renderToolbar();
  const c = $('#content');
  c.innerHTML = { overview: renderOverview, live: renderLive, events: renderEvents, history: renderHistory, settings: renderSettings, editor: renderEditor }[state.page]();
  $('#app').dataset.view = state.page;
  applyFilters();
  updateMap();
}

/** Background refresh: never while the user is typing or picking in the content. */
function softRender() {
  const a = document.activeElement as HTMLElement | null;
  const typing = a && $('#content').contains(a) && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['checkbox'].includes((a as HTMLInputElement).type)));
  if (state.page === 'editor' || typing) {
    renderSidebar();
    if (state.page !== 'editor') updateMap();
    return;
  }
  const sc = $('#content');
  const top = sc.scrollTop;
  render();
  sc.scrollTop = top;
}

/** Re-render keeping the scroll position. */
function rerender() {
  const sc = $('#content');
  const top = sc.scrollTop;
  render();
  sc.scrollTop = top;
}

// ─── search + multi-select ───────────────────────────────────────────────────
function matches(text: string, q: string): boolean {
  const terms = q.toLowerCase().split(/[\s,，;]+/).filter(Boolean);
  if (!terms.length) return true;
  const [stratum, id] = text.split(' ');
  return terms.some((t) => (/^\d+$/.test(t) && id ? id.startsWith(t) : /^(lo|hi|uh)$/.test(t) && stratum ? stratum === t : text.includes(t)));
}

function applyFilters() {
  document.querySelectorAll<HTMLElement>('#content [data-filter-scope]').forEach((scope) => {
    const q = state.filters[scope.dataset.filterScope!] ?? '';
    const own = (sel: string) => [...scope.querySelectorAll<HTMLElement>(sel)].filter((el) => el.closest('[data-filter-scope]') === scope);
    let shown = 0;
    for (const el of own('[data-ft]')) {
      el.hidden = !matches(el.dataset.ft!, q);
      if (!el.hidden) shown++;
    }
    for (const g of own('[data-fgroup]')) g.hidden = !g.querySelector('[data-ft]:not([hidden])');
    for (const el of own('.filter-empty')) el.hidden = shown > 0 || !q;
  });
}

const rangeKey = (cb: HTMLInputElement) => cb.dataset.sel ?? cb.dataset.pos ?? cb.dataset.sec ?? '';
const visibleBoxes = (group: string) =>
  [...document.querySelectorAll<HTMLInputElement>(`#content input[data-range="${group}"]`)].filter((cb) => !cb.closest('[hidden]') && !cb.disabled);
const rangeAnchor: Record<string, string> = {};

function applyBulk(group: string, boxes: HTMLInputElement[], on: boolean) {
  const keys = boxes.map(rangeKey).filter(Boolean);
  const d = state.draft;
  if (!keys.length) return;
  if (group === 'sel') for (const k of keys) on ? state.selected.add(k) : state.selected.delete(k);
  else if (group === 'pos' && d) {
    for (const k of keys) on ? d.positions.add(k) : d.positions.delete(k);
    pruneDraft(d);
  } else if (group.startsWith('sec-') && d) {
    const pos = group.slice(4);
    for (const k of keys) {
      if (on) d.assign.set(k, pos);
      else if (d.assign.get(k) === pos) d.assign.delete(k);
    }
  } else return;
  rerender();
}

// ─── actions ─────────────────────────────────────────────────────────────────
async function commit(plans: Plan[], live: LiveEdit | null): Promise<boolean> {
  state.busy = true;
  state.error = null;
  rerender();
  let ok = false;
  try {
    const r = await savePlans(token.get(), plans, live && live.expires > Date.now() ? live : null);
    state.plans = r.plans;
    state.live = r.live;
    ok = true;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  state.busy = false;
  rerender();
  return ok;
}

function setLive(keys: string[], pos: string | null) {
  const rest = liveEdits().filter(([k]) => !keys.includes(k));
  const assign: [string, string][] = pos ? [...rest, ...keys.map((k): [string, string] => [k, pos])] : rest;
  void commit(state.plans, assign.length ? { assign, expires: Date.now() + state.liveHours * 3_600_000 } : null).then((ok) => ok && hud(keys.length > 1 ? `${keys.length} sectors updated` : 'Updated'));
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const snapshot = (d: Draft | null) => (d ? JSON.stringify([d.name, d.start, d.end, [...d.positions].sort(), [...d.explicit].sort(), [...draftAssign(d)].sort(), [...d.notes].filter(([, v]) => v.trim()).sort(), d.remark.trim()]) : '');
const dirty = () => state.page === 'editor' && snapshot(state.draft) !== state.draftSaved;

function openDraft(plan?: Plan, copy = false) {
  const hour = 3_600_000;
  let start = plan?.start ?? Math.ceil(Date.now() / hour) * hour;
  const len = plan ? plan.end - plan.start : 3 * hour;
  // A copy runs again at the same weekday and time, next time round.
  if (copy) while (start + len <= Date.now()) start += 7 * 24 * hour;
  state.draft = {
    id: copy || !plan ? newId() : plan.id,
    name: copy ? `${plan!.name}` : (plan?.name ?? ''),
    start, end: start + len,
    positions: new Set(plan?.positions ?? []),
    explicit: exclusiveOf(plan?.assign ?? []),
    assign: new Map(plan?.assign ?? []),
    notes: new Map(Object.entries(plan?.notes ?? {})),
    remark: plan?.remark ?? '',
    isNew: copy || !plan,
  };
  state.draftSaved = copy ? '' : snapshot(state.draft);
  state.error = null;
  navigate('editor', true);
}

function pruneDraft(d: Draft) {
  for (const [k, v] of d.assign) if (!d.positions.has(v)) d.assign.delete(k);
  for (const id of d.explicit) if (!d.positions.has(id)) d.explicit.delete(id);
}

async function saveDraft() {
  const d = state.draft;
  if (!d) return;
  d.name = d.name.trim();
  const err =
    !d.name ? 'Give the event a name.'
    : !Number.isFinite(d.start) || !Number.isFinite(d.end) ? 'Enter a start and an end time.'
    : d.end <= d.start ? 'The end must be after the start.'
    : d.end <= Date.now() ? 'This window is already over.'
    : d.end - d.start > MAX_PLAN_HOURS * 3_600_000 ? `An event can last at most ${MAX_PLAN_HOURS} hours.`
    : !d.positions.size ? 'Pick at least one expected position.'
    : null;
  if (err) {
    state.error = err;
    rerender();
    $('#content').scrollTop = 0;
    return;
  }
  const plan: Plan = {
    id: d.id, name: d.name, start: d.start, end: d.end,
    positions: [...d.positions].sort(),
    assign: [...draftAssign(d)],
    notes: Object.fromEntries([...d.notes].filter(([id, v]) => d.positions.has(id) && v.trim()).map(([id, v]) => [id, v.trim()])),
    ...(d.remark.trim() ? { remark: d.remark.trim() } : {}),
  };
  if (await commit([...state.plans.filter((p) => p.id !== d.id), plan], state.live)) {
    hud('Event saved');
    state.draft = null;
    state.draftSaved = '';
    navigate('events', true);
  }
}

async function loadHistory() {
  state.history = null;
  rerender();
  try {
    state.history = await fetchHistory(token.get());
  } catch (e) {
    state.history = [];
    state.error = e instanceof Error ? e.message : String(e);
  }
  rerender();
}

async function navigate(page: Page | 'root', force = false) {
  if (!force && dirty() && page !== 'editor' && !(await confirmAlert('Discard changes?', 'This event has unsaved changes.', 'Discard'))) return;
  if (page === 'root') {
    $('#app').dataset.nav = 'root';
    return;
  }
  if (state.page === 'editor' && page !== 'editor') state.draft = null;
  state.page = page;
  state.error = null;
  if (page !== 'editor') store.set('asx.admin.page', page);
  $('#app').dataset.nav = 'detail';
  render();
  $('#content').scrollTop = 0;
  if (page === 'history') void loadHistory();
}

// ─── events ──────────────────────────────────────────────────────────────────
function bind() {
  const app = $('#app');

  app.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const el = (attr: string) => t.closest<HTMLElement>(`[${attr}]`);

    // Shift-click: a range, like selecting files.
    const cb = (t.matches('input[data-range]') ? t : t.closest('label')?.querySelector('input[data-range]')) as HTMLInputElement | null;
    if (cb && !cb.disabled) {
      const group = cb.dataset.range!;
      const anchor = rangeAnchor[group];
      rangeAnchor[group] = rangeKey(cb);
      if (e.shiftKey && anchor && anchor !== rangeKey(cb)) {
        const boxes = visibleBoxes(group);
        const a = boxes.findIndex((b) => rangeKey(b) === anchor);
        const b = boxes.indexOf(cb);
        if (a >= 0 && b >= 0) {
          e.preventDefault();
          applyBulk(group, boxes.slice(Math.min(a, b), Math.max(a, b) + 1), !cb.checked);
        }
      }
      return;
    }

    const page = el('data-page')?.dataset.page as Page | undefined;
    if (page) return navigate(page);
    const back = el('data-back')?.dataset.back as Page | 'root' | undefined;
    if (back) return navigate(back);

    const seg = el('data-seg');
    if (seg) {
      const name = seg.dataset.seg!;
      const v = seg.dataset.value!;
      if (name === 'stratum') {
        state.stratum = v as Stratum;
        store.set('asx.stratum', v);
        return rerender();
      }
      if (name === 'tz') {
        state.tz = v as Tz;
        store.set('asx.tz', v);
        return rerender();
      }
      if (name.startsWith('mode-') && state.draft) {
        const id = name.slice(5);
        if (v === 'pick') state.draft.explicit.add(id);
        else {
          state.draft.explicit.delete(id);
          for (const [k, p] of state.draft.assign) if (p === id) state.draft.assign.delete(k);
        }
        return rerender();
      }
    }

    const on = el('data-bulk-on')?.dataset.bulkOn;
    const off = el('data-bulk-off')?.dataset.bulkOff;
    if (on || off) return applyBulk((on ?? off)!, visibleBoxes((on ?? off)!), !!on);
    if (el('data-sel-clear')) { state.selected.clear(); return rerender(); }

    const exp = el('data-export')?.dataset.export;
    if (exp) return void exportImage(exp === 'all').catch((err) => { state.error = `Could not save the image: ${err instanceof Error ? err.message : err}`; rerender(); });
    if (el('data-new')) return openDraft();
    const open = el('data-open')?.dataset.open;
    if (open) {
      const p = state.plans.find((x) => x.id === open);
      if (p) return openDraft(p);
    }
    const dup = el('data-dup')?.dataset.dup;
    if (dup) {
      const p = state.plans.find((x) => x.id === dup) ?? state.history?.find((x) => x.id === dup);
      if (p && (!dirty() || (await confirmAlert('Discard changes?', 'This event has unsaved changes.', 'Discard')))) openDraft(p, true);
      return;
    }
    const forget = el('data-forget')?.dataset.forget;
    if (forget) {
      const p = state.history?.find((x) => x.id === forget);
      if (!(await confirmAlert(`Delete “${p?.name ?? 'event'}”?`, 'It is removed from the history for good.', 'Delete'))) return;
      try {
        state.history = await fetchHistory(token.get(), forget);
        hud('Deleted');
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
      }
      return rerender();
    }
    if (el('data-reload-history')) return void loadHistory();

    if (el('data-preset') && state.draft) {
      const v = el('data-preset')!.dataset.preset!;
      state.draft.positions = new Set(v ? v.split(',') : []);
      pruneDraft(state.draft);
      return rerender();
    }
    if (el('data-cancel')) return navigate('events');
    if (el('data-save')) return void saveDraft();
    if (el('data-delete') && state.draft) {
      const d = state.draft;
      if (!(await confirmAlert(`Delete “${d.name || 'event'}”?`, 'Everyone stops seeing it right away.', 'Delete'))) return;
      if (await commit(state.plans.filter((p) => p.id !== d.id), state.live)) {
        hud('Event deleted');
        state.draft = null;
        navigate('events', true);
      }
      return;
    }
    if (el('data-live-clear')) {
      if (!(await confirmAlert('Clear all live edits?', 'Sectors go back to the running event or the SOP.', 'Clear'))) return;
      if (await commit(state.plans, null)) hud('Live edits cleared');
      return;
    }
    if (el('data-signout')) {
      if (!(await confirmAlert('Sign out?', 'You will need the token to sign in again on this device.', 'Sign Out'))) return;
      token.set('');
      location.reload();
    }
  });

  app.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.filter) {
      state.filters[t.dataset.filter] = t.value;
      return applyFilters();
    }
    const d = state.draft;
    if (!d) return;
    if (t.id === 'ev-name') d.name = t.value;
    if (t.id === 'ev-remark') d.remark = t.value;
    if (t.dataset.note) d.notes.set(t.dataset.note, t.value);
  });

  app.addEventListener('keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Escape' && t.dataset.filter && t.value) {
      state.filters[t.dataset.filter] = t.value = '';
      applyFilters();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.page === 'editor') {
      e.preventDefault();
      void saveDraft();
    }
  });

  app.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const d = state.draft;
    if (t.dataset.sel) {
      t.checked ? state.selected.add(t.dataset.sel) : state.selected.delete(t.dataset.sel);
      return rerender();
    }
    if (t.dataset.liveAssign) return setLive([t.dataset.liveAssign], t.value || null);
    if (t.hasAttribute('data-bulk-assign') && t.value !== '-') {
      const keys = [...state.selected].filter((k) => k.startsWith(`${state.stratum}-`));
      state.selected.clear();
      return setLive(keys, t.value || null);
    }
    if (t.id === 'live-hours') {
      state.liveHours = Number(t.value);
      const live = liveEdits();
      if (live.length) void commit(state.plans, { assign: live, expires: Date.now() + state.liveHours * 3_600_000 }).then((ok) => ok && hud('Expiry updated'));
      return;
    }
    if (!d) return;
    if (t.dataset.pos) {
      t.checked ? d.positions.add(t.dataset.pos) : d.positions.delete(t.dataset.pos);
      pruneDraft(d);
      return rerender();
    }
    if (t.dataset.sec && t.dataset.of) {
      // A sector has one owner: picking it here takes it from whoever had it.
      if (t.checked) d.assign.set(t.dataset.sec, t.dataset.of);
      else if (d.assign.get(t.dataset.sec) === t.dataset.of) d.assign.delete(t.dataset.sec);
      return rerender();
    }
    if (t.id === 'ev-start' || t.id === 'ev-end') {
      const ms = fromInput(t.value, state.tz);
      if (t.id === 'ev-start') {
        // Moving the start keeps the duration.
        const len = d.end - d.start;
        d.start = ms;
        if (Number.isFinite(ms) && Number.isFinite(len) && len > 0) d.end = ms + len;
        if (Number.isFinite(d.end)) $<HTMLInputElement>('#ev-end').value = toInput(d.end, state.tz);
      } else d.end = ms;
      // Update the hints in place: re-rendering would close the date picker.
      for (const [id, v] of [['ev-start', d.start], ['ev-end', d.end]] as const)
        $(`#${id}-other`).textContent = Number.isFinite(v) ? fmtTime(v, state.tz === 'utc' ? 'local' : 'utc') : '';
      const h = (d.end - d.start) / 3_600_000;
      $('#ev-dur').textContent = Number.isFinite(h) && h > 0 ? `${+h.toFixed(2)} h` : '—';
    }
  });

  window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
  darkQuery.addEventListener('change', (e) => view?.setTheme(e.matches));
}

// ─── sign in ─────────────────────────────────────────────────────────────────
function showLogin(error?: string) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-go').innerHTML = icons.arrowRight;
  const err = $('#login-error');
  err.hidden = !error;
  err.textContent = error ?? '';
  $<HTMLInputElement>('#login-token').focus();
}

async function start() {
  $('#app').hidden = false;
  $('#login').hidden = true;
  $('#app').dataset.nav = mobile() ? 'root' : 'detail';
  bind();
  render();
  try { await loadAirspace(); } catch (e) { state.error = e instanceof Error ? e.message : String(e); }
  rerender();
  void pollFeed();
  if (state.page === 'history') void loadHistory();
}

async function init() {
  if (!plansEnabled) {
    showLogin('This site was built without a backend (VITE_OVERRIDES_URL), so there is nothing to manage.');
    return;
  }
  $<HTMLFormElement>('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('#login-token').value.trim();
    if (!v) return;
    const card = $('.login-card');
    card.classList.add('busy');
    try {
      const r = await fetchPlans(v);
      if (!r.admin) throw new Error('Wrong token');
      token.set(v);
      state.plans = r.plans;
      state.live = r.live;
      state.storage = r.storage ?? '';
      void start();
    } catch (err) {
      card.classList.remove('busy');
      card.classList.add('shake');
      setTimeout(() => card.classList.remove('shake'), 500);
      showLogin(err instanceof Error ? err.message : String(err));
    }
  });
  if (!token.get()) return showLogin();
  try {
    await refreshPlans();
    void start();
  } catch (e) {
    showLogin(e instanceof Error && e.message !== 'Wrong token' ? e.message : undefined);
  }
}

void init();

import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { ColorBook } from './colors';
import { bbox, contains, type Polygonal } from './geo';
import { createMap, padding, type MapView } from './map';
import {
  computeNeighborOwners,
  neighborControllers,
  type NeighborController,
  type NeighborFacility,
  type NeighborOwner,
  type NeighborPiece,
} from './neighbors';
import { computeOwnership, type Ownership, type Piece } from './ownership';
import { POSITIONS, SECTORS, SECTOR_BY_KEY, STRATA, STRATUM_INFO, sectorKey, type Stratum } from './sectors';
import { LIVE_HOURS, MAX_PLAN_HOURS, activePlan, exclusiveOf, fetchPlans, fmtTime, fromInput, plansEnabled, savePlans, toInput, token, type LiveEdit, type Plan, type Tz } from './plans';
import { icons } from './ui/icons';
import {
  esc,
  neighborTooltip,
  ownerCallsign,
  renderAircraftCard,
  renderControllers,
  renderNeighbors,
  renderAssignMenu,
  renderLiveEditor,
  renderLogin,
  renderPlanEditor,
  renderPlanList,
  renderPreview,
  renderSectors,
  renderStatus,
  zmeTooltip,
  type AircraftHit,
  type AssignOpts,
  type Draft,
  type ViewModel,
} from './ui/render';
import { BottomSheet } from './ui/sheet';
import { POLL_MS, fetchVatsim, zmeControllers, type OnlineController, type VatsimData, type VatsimPilot } from './vatsim';

type Tab = 'controllers' | 'sectors' | 'neighbors';
const TABS: Tab[] = ['controllers', 'sectors', 'neighbors'];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** Preview setups live only in this browser. */
function loadPreview(): { positions: string[]; assign: [string, string][]; exclusive: string[] } {
  try {
    const v = JSON.parse(store.get('asx.preview') ?? '') as { positions?: unknown; assign?: unknown; exclusive?: unknown };
    return {
      exclusive: Array.isArray(v.exclusive) ? v.exclusive.filter((id): id is string => typeof id === 'string' && POSITIONS.has(id)) : [],
      positions: Array.isArray(v.positions) ? v.positions.filter((id): id is string => typeof id === 'string' && POSITIONS.has(id)) : [],
      assign: Array.isArray(v.assign) ? v.assign.filter((e): e is [string, string] => Array.isArray(e) && SECTOR_BY_KEY.has(e[0]) && POSITIONS.has(e[1])) : [],
    };
  } catch {
    return { positions: [], assign: [], exclusive: [] };
  }
}
const savedPreview = loadPreview();

const state = {
  stratum: (store.get('asx.stratum') as Stratum) || 'HI',
  tab: 'controllers' as Tab,
  data: null as VatsimData | null,
  live: [] as OnlineController[],
  preview: false,
  previewSet: new Set<string>(savedPreview.positions),
  previewAssign: new Map<string, string>(savedPreview.assign),
  /** Preview loaded from an event: positions that cover exactly their picked sectors. */
  previewExclusive: new Set<string>(savedPreview.exclusive),
  ownership: null as Ownership | null,
  neighborCtrls: [] as NeighborController[],
  neighborOwners: new Map<string, NeighborOwner>(),
  neighborsVisible: store.get('asx.neighbors') !== '0',
  error: null as string | null,
  lastFetch: 0,
  selectedPilot: null as string | null,
  plans: [] as Plan[],
  /** Admin's sector assignments for right now (beat the running event). */
  liveEdit: null as LiveEdit | null,
  liveHours: 4,
  /** Admin sheet: event list, or the live editor. */
  adminView: 'list' as 'list' | 'live',
  admin: false,
  /** Plan being created/edited in the admin sheet (shown on the map while the sheet is open). */
  draft: null as Draft | null,
  tz: (store.get('asx.tz') === 'local' ? 'local' : 'utc') as Tz,
  busy: false,
  adminError: null as string | null,
  sheet: 'preview' as 'preview' | 'plans',
};
if (!STRATA.includes(state.stratum)) state.stratum = 'HI';

const colors = new ColorBook();
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let pieces: Piece[] = [];
let neighborPieces: (NeighborPiece & { box: [number, number, number, number] })[] = [];
let facilities: NeighborFacility[] = [];
let view: MapView;
let zmeBoundary: Polygonal;
let zmeBounds: [[number, number], [number, number]];
let panelSheet: BottomSheet;
let previewSheet: BottomSheet;
/** Per sector key: label point and area (to place the owner labels). */
const sectorLabel = new Map<string, [number, number]>();
const sectorArea = new Map<string, number>();
/** Sector the assignment menu is open for. */
let menuKey: string | null = null;
/** Search text per filter scope (kept across re-renders). */
const filters: Record<string, string> = {};
/** Sector keys ticked for a bulk assignment, and the last checkbox clicked per range group (Shift-click). */
const selectedKeys = new Set<string>();
const rangeAnchor: Record<string, string> = {};

// ─── bootstrap ───────────────────────────────────────────────────────────────
async function load<T>(name: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}`);
  return res.json() as Promise<T>;
}

async function init() {
  const [piecesFC, sectorsFC, labelsFC, boundaryFC, neighborsFC, artccsFC, neighborCfg] = await Promise.all([
    load<GeoJSON.FeatureCollection>('pieces.geojson'),
    load<GeoJSON.FeatureCollection>('sectors.geojson'),
    load<GeoJSON.FeatureCollection>('labels.geojson'),
    load<GeoJSON.FeatureCollection>('boundary.geojson'),
    load<GeoJSON.FeatureCollection>('neighbor-sectors.geojson'),
    load<GeoJSON.FeatureCollection>('artccs.geojson'),
    load<{ facilities: NeighborFacility[] }>('neighbors.json'),
  ]);

  // Sector 60 (SFC–080) sits under 40 laterally: clone 40's pieces, hidden on the map.
  const stacked = SECTORS.filter((s) => s.stackedUnder);
  for (const f of [...piecesFC.features]) {
    const p = f.properties as Omit<Piece, 'geometry'>;
    for (const s of stacked)
      if (p.stratum === s.stratum && p.sector === s.stackedUnder)
        piecesFC.features.push({ ...f, properties: { ...p, pid: `${p.pid}-${s.id}`, sector: s.id, hidden: true } });
  }
  pieces = piecesFC.features.map((f) => ({ ...(f.properties as Omit<Piece, 'geometry'>), geometry: f.geometry as Polygonal }));
  facilities = neighborCfg.facilities;
  for (const f of labelsFC.features) {
    const pr = f.properties as { stratum: Stratum; sector: string };
    sectorLabel.set(sectorKey(pr.stratum, pr.sector), (f.geometry as GeoJSON.Point).coordinates as [number, number]);
  }
  for (const f of sectorsFC.features) {
    const pr = f.properties as { stratum: Stratum; sector: string };
    sectorArea.set(sectorKey(pr.stratum, pr.sector), area(f.geometry as Polygonal));
  }
  neighborPieces = neighborsFC.features.map((f) => {
    const geometry = f.geometry as Polygonal;
    return { ...(f.properties as Omit<NeighborPiece, 'geometry'>), geometry, box: bbox([geometry]) };
  });

  // The LO boundary is the outermost extent of ZME.
  const loBoundary = boundaryFC.features.find((f) => f.properties?.stratum === 'LO') ?? boundaryFC.features[0];
  zmeBoundary = { type: 'Polygon', coordinates: [(loBoundary.geometry as GeoJSON.LineString).coordinates as [number, number][]] };
  const [x0, y0, x1, y1] = bbox([zmeBoundary]);
  zmeBounds = [[x0, y0], [x1, y1]];

  setupChrome();
  view = createMap($('#map'), { pieces: piecesFC, sectors: sectorsFC, labels: labelsFC, boundary: boundaryFC, neighbors: neighborsFC, artccs: artccsFC }, darkQuery.matches, zmeBounds);
  view.map.on('style.load', () => {
    view.setStratum(state.stratum);
    view.setNeighborsVisible(state.neighborsVisible);
    recompute();
  });
  darkQuery.addEventListener('change', (e) => view.setTheme(e.matches));

  recompute(); // the sheets need an ownership to render
  bindUI();
  bindHover();
  renderSegments();
  poll();
  setInterval(renderClock, 1000);
}

/** Icons, and the two bottom sheets on phones. */
function setupChrome() {
  $('#copy-year').textContent = String(new Date().getFullYear());
  $('#preview-btn').innerHTML = icons.sliders;
  $('#plans-btn').innerHTML = icons.calendar;
  $('#recenter-btn').innerHTML = icons.location;
  $('#neighbors-btn').innerHTML = icons.layers;
  $('.search-icon').innerHTML = icons.search;
  $('#preview-sheet .close').innerHTML = icons.close;
  renderNeighborsButton();

  const safeBottom = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden';
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  })();
  const panel = $('#panel');
  panelSheet = new BottomSheet(panel, {
    // Collapsed (search bar), half, full — like Apple Maps.
    detents: () => [$('#panel-handle').offsetHeight + safeBottom + 4, Math.round(window.innerHeight * 0.5), panel.offsetHeight],
    initial: 1,
    handles: [$('#panel-handle')],
    scroller: $('#panel-scroll'),
    onChange: (i) => (document.documentElement.dataset.sheet = ['small', 'medium', 'large'][i]),
  });
  const sheet = $('#preview-sheet');
  // Focusing a field can scroll the (overflow: hidden) sheet itself and hide its header: keep it pinned.
  sheet.addEventListener('scroll', () => { if (sheet.scrollTop) sheet.scrollTop = 0; });
  previewSheet = new BottomSheet(sheet, {
    detents: () => [0, sheet.offsetHeight],
    initial: 0,
    handles: [$('#preview-handle')],
    scroller: $('#preview-scroll'),
    onChange: (i) => {
      document.documentElement.dataset.preview = i ? 'open' : 'closed';
      sheet.classList.toggle('open', i > 0);
    },
  });
}

// ─── live data ───────────────────────────────────────────────────────────────
async function poll() {
  try {
    state.data = await fetchVatsim();
    state.live = zmeControllers(state.data);
    state.error = null;
    state.lastFetch = Date.now();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  await refreshPlans();
  recompute();
  setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

/** Plans are public to read; the token only proves who may edit. Failures keep the last list. */
async function refreshPlans() {
  if (!plansEnabled || state.busy) return;
  try {
    const r = await fetchPlans();
    state.plans = r.plans;
    state.liveEdit = r.live;
    state.admin = r.admin;
  } catch { /* backend unreachable — keep what we had */ }
  $('#plans-btn').hidden = !state.admin;
}

const sheetOpen = () => document.documentElement.dataset.preview === 'open';
/** Preview positions are not people: no callsign, just the position. */
const fake = (ids: Iterable<string>): OnlineController[] =>
  [...ids].sort().map((id) => {
    const p = POSITIONS.get(id)!;
    return { position: id, callsign: p.name, frequency: p.freq, name: 'Preview', cid: 0, rating: '', logon: new Date(), preview: true };
  });

/**
 * Who is online. Outside the local Preview this is always exactly the VATSIM feed: nothing the admin
 * does (plans, drafts) can add a position.
 */
function controllers(): OnlineController[] {
  if (state.preview) return fake(state.previewSet);
  return state.live;
}

const liveEdits = (): [string, string][] => (state.liveEdit && state.liveEdit.expires > Date.now() ? state.liveEdit.assign : []);

/**
 * Sector → position assignments in force. Live: the running event, then the admin's live edits on top,
 * each only where its position is online (so an offline live edit falls back to the event, then the SOP).
 */
function assignMap(online: Set<string>): Map<string, string> {
  if (state.preview) return state.previewAssign;
  const m = new Map<string, string>();
  for (const [k, v] of [...(activePlan(state.plans)?.assign ?? []), ...liveEdits()]) if (online.has(v)) m.set(k, v);
  return m;
}

/** Positions that cover exactly their picked sectors (event positions with sectors picked; online only). */
function exclusiveSet(online: Set<string>): Set<string> {
  const ids = state.preview ? state.previewExclusive : exclusiveOf(activePlan(state.plans)?.assign ?? []);
  return new Set([...ids].filter((id) => online.has(id)));
}

/** Live mode: the running event and live edits, and how many of their assignments have their position online. */
function planStatus(): ViewModel['plan'] {
  if (state.preview) return null;
  const plan = activePlan(state.plans);
  const online = new Set(state.live.map((c) => c.position));
  const live = liveEdits();
  if (!plan && !live.length) return null;
  return {
    plan,
    applied: plan ? plan.assign.filter(([, pos]) => online.has(pos)).length : 0,
    liveApplied: live.filter(([, pos]) => online.has(pos)).length,
    liveUntil: live.length ? state.liveEdit!.expires : null,
  };
}

function savePreview() {
  store.set('asx.preview', JSON.stringify({ positions: [...state.previewSet], assign: [...state.previewAssign], exclusive: [...state.previewExclusive] }));
}

function viewModel(): ViewModel {
  return {
    stratum: state.stratum,
    ownership: state.ownership!,
    pieces,
    controllers: controllers(),
    colors,
    hasData: !!state.data,
    neighborsVisible: state.neighborsVisible,
    facilities,
    neighborPieces,
    neighborCtrls: state.neighborCtrls,
    neighborOwners: state.neighborOwners,
    plan: planStatus(),
  };
}

function recompute() {
  const ctrls = controllers();
  const online = new Set(ctrls.map((c) => c.position));
  state.ownership = computeOwnership(pieces, online, assignMap(online), exclusiveSet(online));
  state.neighborCtrls = neighborControllers(state.preview ? null : state.data, facilities); // preview: no real people
  state.neighborOwners = computeNeighborOwners(neighborPieces, facilities, state.neighborCtrls);

  // ZME first so its positions get the first (coolest) colours.
  colors.update([...[...online].sort(), ...state.neighborCtrls.map((c) => c.key)]);
  const pieceColors = new Map<string, string | null>();
  for (const [pid, owner] of state.ownership.owners) pieceColors.set(pid, colors.get(owner));
  const nColors = new Map<string, string | null>();
  for (const [nid, o] of state.neighborOwners) nColors.set(nid, colors.get(o.owner));
  if (view) {
    view.setPieceColors(pieceColors);
    view.setNeighborColors(nColors);
    view.setAircraft(aircraftFeatures());
    view.setOwnerLabels(ownerLabels(ctrls));
  }

  const vm = viewModel();
  $('#status').innerHTML = renderStatus(vm);
  $('#preview-banner').hidden = !state.preview;
  // Preview is not live traffic: no aircraft, no search.
  $('#search').hidden = state.preview;
  if (state.preview) state.selectedPilot = null;
  renderBody(vm);
  renderAircraft();
  renderClock();
  renderEditHint();
  // Keep the open sheet's owner hints current, but never under the user's fingers.
  if (document.documentElement.dataset.preview === 'open' && !$('#preview-sheet').contains(document.activeElement)) rerenderSheet();
}

// ─── owner labels ────────────────────────────────────────────────────────────
function area(g: Polygonal): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let a = 0;
  for (const poly of polys) {
    const r = poly[0];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  }
  return Math.abs(a / 2);
}

/**
 * One label per owner and stratum ("22 / Razorback / 132.550"), placed in the owner's own sector
 * when it works it, otherwise in the biggest sector it works whole, otherwise the biggest piece it has.
 */
function ownerLabels(ctrls: OnlineController[]): GeoJSON.FeatureCollection {
  const own = state.ownership!;
  const features: GeoJSON.Feature[] = [];
  for (const st of STRATA) {
    const owners = new Set(pieces.filter((p) => p.stratum === st).map((p) => own.owners.get(p.pid)).filter((x): x is string => !!x));
    for (const id of owners) {
      const keys = (own.positionSectors.get(id) ?? []).filter((k) => k.startsWith(`${st}-`));
      const whole = keys.filter((k) => own.sectorOwners.get(k)?.size === 1);
      const byArea = (ks: string[]) => [...ks].sort((a, b) => (sectorArea.get(b) ?? 0) - (sectorArea.get(a) ?? 0))[0];
      const ownKey = sectorKey(st, id);
      const key = whole.includes(ownKey) ? ownKey : byArea(whole);
      let point: [number, number] | undefined;
      let offset: [number, number] = [0, 0];
      if (key) {
        const stacked = SECTOR_BY_KEY.get(key)?.stackedUnder;
        point = sectorLabel.get(key) ?? (stacked ? sectorLabel.get(sectorKey(st, stacked)) : undefined);
        if (stacked) offset = [0, 3.4];
      }
      if (!point) {
        // Only part of a sector: centre of the biggest visible piece it owns.
        const mine = pieces.filter((p) => p.stratum === st && !p.hidden && own.owners.get(p.pid) === id).sort((a, b) => area(b.geometry) - area(a.geometry))[0];
        if (!mine) continue;
        const [x0, y0, x1, y1] = bbox([mine.geometry]);
        const c: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
        point = contains(mine.geometry, ...c) ? c : sectorLabel.get(sectorKey(st, mine.sector)) ?? c;
      }
      const pos = POSITIONS.get(id);
      const freq = ctrls.find((c) => c.position === id)?.frequency ?? pos?.freq ?? '';
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point },
        properties: { stratum: st, id, name: pos?.name ?? '', freq, rank: key === ownKey ? 0 : 1, offset },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ─── sector assignment editing ───────────────────────────────────────────────
interface Editor { online: string[]; assign: Map<string, string>; set(keys: string[], pos: string | null): void }

/** The assignment editor that is open right now, if any (preview sheet, or a plan draft). */
function editor(): Editor | null {
  if (!sheetOpen()) return null;
  if (state.sheet === 'preview' && state.preview)
    return { online: [...state.previewSet].sort(), assign: state.previewAssign, set: setPreviewAssign };
  if (state.sheet === 'plans' && state.admin && state.adminView === 'live' && !state.draft)
    return { online: liveOnline(), assign: new Map(liveEdits()), set: setLiveAssign };
  return null;
}

function assignOpts(online: string[], assign: Map<string, string>, attr: AssignOpts['attr']): AssignOpts {
  return { stratum: state.stratum, online, assign, ownership: state.ownership!, colors, attr, busy: state.busy, selected: selectedKeys };
}

function setPreviewAssign(keys: string[], pos: string | null) {
  for (const key of keys) {
    if (pos) state.previewAssign.set(key, pos);
    else state.previewAssign.delete(key);
  }
  savePreview();
  recompute();
  rerenderSheet();
}

const liveOnline = () => [...new Set(state.live.map((c) => c.position))].sort();

/** Live edits are saved at once; changing one restarts the expiry clock. */
function setLiveAssign(keys: string[], pos: string | null) {
  const rest = liveEdits().filter(([k]) => !keys.includes(k));
  const assign: [string, string][] = pos ? [...rest, ...keys.map((k): [string, string] => [k, pos])] : rest;
  void commitPlans(state.plans, assign.length ? { assign, expires: Date.now() + state.liveHours * 3_600_000 } : null).then(() => { recompute(); rerenderSheet(); });
}

/** Drop preview assignments whose position was switched off. */
function prunePreviewAssign() {
  for (const [k, v] of state.previewAssign) if (!state.previewSet.has(v)) state.previewAssign.delete(k);
  for (const id of state.previewExclusive) if (!state.previewSet.has(id)) state.previewExclusive.delete(id);
}

function renderEditHint() {
  $('#edit-hint').hidden = !editor();
}

function openMenu(key: string, x: number, y: number) {
  const ed = editor();
  if (!ed) return;
  menuKey = key;
  const menu = $('#assign-menu');
  menu.innerHTML = renderAssignMenu(key, ed.online, ed.assign, colors);
  menu.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = menu;
  const left = Math.max(8, x + 12 + w > window.innerWidth - 8 ? x - w - 12 : x + 12);
  const top = Math.max(8, y + h > window.innerHeight - 8 ? window.innerHeight - h - 8 : y);
  menu.style.transform = `translate(${left}px, ${top}px)`;
  $('#tooltip').hidden = true;
}

function closeMenu() {
  menuKey = null;
  $('#assign-menu').hidden = true;
}

/** Re-render the open sheet without losing its scroll position (or back to the top on a new view). */
function rerenderSheet(toTop = false) {
  const sc = $('#preview-scroll');
  const top = sc.scrollTop;
  renderPreviewSheet();
  sc.scrollTop = toTop ? 0 : top;
}

// ─── airspace lookup ─────────────────────────────────────────────────────────
function stratumForAltitude(alt: number): Stratum {
  if (alt >= 34_500) return 'UH';
  if (alt >= 23_500) return 'HI';
  return 'LO';
}

function lookup(lon: number, lat: number, alt: number): AircraftHit | null {
  const stratum = stratumForAltitude(alt);
  const candidates = pieces.filter((p) => p.stratum === stratum && contains(p.geometry, lon, lat));
  if (candidates.length) {
    // Stacked sectors: Sector 60 owns SFC–080 under Sector 40.
    const isStacked = (p: Piece) => !!SECTOR_BY_KEY.get(sectorKey(p.stratum, p.sector))?.stackedUnder;
    const piece = candidates.find((p) => isStacked(p) === alt < 8_500) ?? candidates.find((p) => !isStacked(p)) ?? candidates[0];
    const owner = state.ownership?.owners.get(piece.pid) ?? null;
    const sector = SECTOR_BY_KEY.get(sectorKey(piece.stratum, piece.sector))!;
    const ctrl = controllers().find((c) => c.position === owner);
    return {
      kind: 'zme',
      sector: `${sector.id} ${sector.name}`,
      owner,
      ownerColor: colors.get(owner),
      callsign: owner ? ownerCallsign(viewModel(), owner) : null,
      frequency: owner ? (ctrl?.frequency ?? POSITIONS.get(owner)?.freq ?? null) : null,
      sub: owner ? (POSITIONS.get(owner)?.name ?? '') : '',
    };
  }
  const n = neighborPieces.find((p) => p.stratum === stratum && inBox(p.box, lon, lat) && contains(p.geometry, lon, lat));
  if (!n) return null;
  const o = state.neighborOwners.get(n.nid);
  const ctrl = state.neighborCtrls.find((c) => c.key === o?.owner);
  const fac = facilities.find((f) => f.id === n.artcc);
  return {
    kind: 'neighbor',
    sector: n.name ?? n.artcc,
    owner: ctrl ? n.artcc : null,
    ownerColor: colors.get(o?.owner),
    callsign: ctrl?.callsign ?? null,
    frequency: ctrl?.frequency ?? null,
    sub: `${fac?.name ?? n.artcc} Center`,
    approx: o?.approx,
  };
}

const inBox = (b: [number, number, number, number], x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

let areaBox: [number, number, number, number] | null = null;
function pilotsNearby(): VatsimPilot[] {
  if (!state.data) return [];
  areaBox ??= bbox([zmeBoundary, ...neighborPieces.map((p) => p.geometry)]);
  return state.data.pilots.filter((p) => inBox(areaBox!, p.longitude, p.latitude));
}

function aircraftFeatures(): GeoJSON.FeatureCollection {
  if (state.preview) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: pilotsNearby().flatMap((p) => {
      const hit = lookup(p.longitude, p.latitude, p.altitude);
      if (!hit && p.callsign !== state.selectedPilot) return [];
      return [{
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.longitude, p.latitude] },
        properties: { callsign: p.callsign, heading: p.heading, color: hit?.ownerColor ?? null, selected: p.callsign === state.selectedPilot },
      }];
    }),
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────
function renderBody(vm = viewModel()) {
  const body = $('#body');
  body.innerHTML = state.tab === 'controllers' ? renderControllers(vm) : state.tab === 'sectors' ? renderSectors(vm) : renderNeighbors(vm);
}

function renderClock() {
  const pill = $('#live');
  if (state.preview) { pill.className = 'live preview'; pill.textContent = 'Preview'; return; }
  if (state.error) { pill.className = 'live error'; pill.textContent = 'Feed error'; pill.title = state.error; return; }
  if (!state.lastFetch) { pill.className = 'live'; pill.textContent = 'Connecting…'; return; }
  const s = Math.round((Date.now() - state.lastFetch) / 1000);
  pill.className = 'live ok';
  pill.textContent = `Live · Memphis Center`;
  pill.title = `Updated ${s}s ago${state.data ? ` · VATSIM feed ${state.data.general.update_timestamp}` : ''}`;
}

function renderSegments() {
  document.querySelectorAll<HTMLButtonElement>('#strata button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.s === state.stratum)));
  $('#strata').style.setProperty('--i', String(STRATA.indexOf(state.stratum)));
  $('#strata-alt').textContent = STRATUM_INFO[state.stratum].altitude;
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === state.tab)));
  $('#tabs').style.setProperty('--i', String(TABS.indexOf(state.tab)));
}

function renderNeighborsButton() {
  const b = $('#neighbors-btn');
  b.setAttribute('aria-pressed', String(state.neighborsVisible));
  b.title = state.neighborsVisible ? 'Hide adjacent ARTCC sectors' : 'Show adjacent ARTCC sectors';
}

function renderAircraft() {
  const card = $('#aircraft-card');
  const p = state.data?.pilots.find((x) => x.callsign === state.selectedPilot);
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  card.innerHTML = renderAircraftCard(p, lookup(p.longitude, p.latitude, p.altitude));
}

// ─── interaction ─────────────────────────────────────────────────────────────
function setStratum(s: Stratum) {
  if (s === state.stratum) return;
  state.stratum = s;
  store.set('asx.stratum', s);
  view.setStratum(s);
  renderSegments();
  renderBody();
  closeMenu();
  rerenderSheet();
}

function setNeighborsVisible(v: boolean) {
  state.neighborsVisible = v;
  store.set('asx.neighbors', v ? '1' : '0');
  view.setNeighborsVisible(v);
  renderNeighborsButton();
  renderBody();
}

function bindUI() {
  $('#strata').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-s]');
    if (b) setStratum(b.dataset.s as Stratum);
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-t]');
    if (!b) return;
    state.tab = b.dataset.t as Tab;
    renderSegments();
    renderBody();
  });
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (a === 'open-preview') openSheet('preview');
    if (a === 'open-plans') openSheet('plans');
    if (a === 'close-preview') togglePreview(false);
    if (a === 'close-aircraft') { state.selectedPilot = null; recompute(); }
    if (a === 'recenter') view.map.fitBounds(zmeBounds, { padding: padding() });
    if (a === 'toggle-neighbors') setNeighborsVisible(!state.neighborsVisible);
    if (a === 'exit-preview') { state.preview = false; togglePreview(false); state.sheet = 'preview'; renderPreviewSheet(); recompute(); }
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-menu-assign]');
    if (pick && menuKey) {
      const key = menuKey;
      closeMenu();
      editor()?.set([key], pick.dataset.menuAssign || null);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuKey && !(e.target as HTMLElement).closest('#assign-menu')) closeMenu();
  });
  $('#body').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.toggle === 'neighbors') setNeighborsVisible(t.checked);
  });

  const input = $<HTMLInputElement>('#search input');
  input.addEventListener('focus', () => panelSheet.isMobile && panelSheet.setDetent(2));
  $<HTMLFormElement>('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim().toUpperCase();
    const p = state.data?.pilots.find((x) => x.callsign.toUpperCase() === q);
    input.classList.toggle('notfound', !p && !!q);
    if (!p) return;
    input.blur();
    selectPilot(p);
  });
  input.addEventListener('input', () => input.classList.remove('notfound'));

  view.map.on('click', 'aircraft', (e) => {
    const cs = e.features?.[0]?.properties?.callsign as string | undefined;
    const p = state.data?.pilots.find((x) => x.callsign === cs);
    if (p) selectPilot(p, false);
  });
  view.map.on('click', 'pieces-fill', (e) => {
    if (!editor()) return;
    if (view.map.queryRenderedFeatures(e.point, { layers: ['aircraft'] }).length) return;
    const p = e.features?.[0]?.properties as Piece | undefined;
    if (p) openMenu(sectorKey(p.stratum, p.sector), e.originalEvent.clientX, e.originalEvent.clientY);
  });
  view.map.on('mouseenter', 'pieces-fill', () => { if (editor()) view.map.getCanvas().style.cursor = 'pointer'; });
  view.map.on('mouseleave', 'pieces-fill', () => (view.map.getCanvas().style.cursor = ''));
  view.map.on('mouseenter', 'aircraft', () => (view.map.getCanvas().style.cursor = 'pointer'));
  view.map.on('mouseleave', 'aircraft', () => (view.map.getCanvas().style.cursor = ''));

  renderPreviewSheet();
  bindPlans();
  bindMultiSelect();
  const sheet = $('#preview-sheet');
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.assign) return setPreviewAssign([t.dataset.assign], t.value || null);
    if (!t.dataset.pos && t.id !== 'preview-toggle') return; // manual sheet controls are handled in bindManual
    if (t.dataset.pos) {
      if (t.checked) state.previewSet.add(t.dataset.pos);
      else state.previewSet.delete(t.dataset.pos);
      prunePreviewAssign();
      savePreview();
      // Picking a position implies preview mode; otherwise nothing would visibly change.
      state.preview = true;
    } else {
      state.preview = t.checked;
    }
    recompute();
    rerenderSheet();
  });
  sheet.addEventListener('click', (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-preset]')?.dataset.preset;
    if ((e.target as HTMLElement).closest('[data-assign-reset]')) {
      state.previewAssign.clear();
      state.previewExclusive.clear();
      savePreview();
      recompute();
      rerenderSheet();
      return;
    }
    if (preset === undefined) return;
    state.previewSet = new Set(preset ? preset.split(',') : []);
    state.previewExclusive.clear();
    prunePreviewAssign();
    savePreview();
    state.preview = true;
    renderPreviewSheet();
    recompute();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuKey) return closeMenu();
      const f = e.target as HTMLInputElement;
      if (f.dataset?.filter && f.value) return; // Esc in a search box clears it (handled by the box)
      togglePreview(false);
      if (state.selectedPilot) { state.selectedPilot = null; recompute(); }
    }
  });
}

// ─── search + multi-select in the sheet ──────────────────────────────────────
/**
 * Comma/space separated terms, any of which may match: a number matches sector/position numbers starting
 * with it ("2" → 20–28, "22" → 22), LO/HI/UH a stratum, anything else a part of the name, callsign or frequency.
 */
function matches(text: string, q: string): boolean {
  const terms = q.toLowerCase().split(/[\s,，;]+/).filter(Boolean);
  if (!terms.length) return true;
  const [stratum, id] = text.split(' ');
  return terms.some((t) => (/^\d+$/.test(t) ? id.startsWith(t) : /^(lo|hi|uh)$/.test(t) ? stratum === t : text.includes(t)));
}

/** Show only what matches each scope's search box (in place, so focus and scroll stay). */
function applyFilters() {
  document.querySelectorAll<HTMLElement>('#preview-scroll [data-filter-scope]').forEach((scope) => {
    const name = scope.dataset.filterScope!;
    const q = filters[name] ?? '';
    const own = <T extends Element>(sel: string) => [...scope.querySelectorAll<T & HTMLElement>(sel)].filter((el) => el.closest('[data-filter-scope]') === scope);
    let shown = 0;
    for (const el of own('[data-ft]')) {
      el.hidden = !matches(el.dataset.ft!, q);
      if (!el.hidden) shown++;
    }
    for (const g of own('[data-fgroup]')) g.hidden = !g.querySelector('[data-ft]:not([hidden])');
    for (const el of own('.filter-empty')) el.hidden = shown > 0;
    const input = own<HTMLInputElement>('input[data-filter]')[0] as HTMLInputElement | undefined;
    if (input && input.value !== q) input.value = q;
  });
}

const rangeKey = (cb: HTMLInputElement) => cb.dataset.sel ?? cb.dataset.pos ?? cb.dataset.coverSector ?? cb.dataset.planPos ?? '';
const visibleBoxes = (group: string) =>
  [...document.querySelectorAll<HTMLInputElement>(`#preview-scroll input[data-range="${group}"]`)].filter((cb) => !cb.closest('[hidden]') && !cb.disabled);

/** Tick (on) or untick several checkboxes of one group at once. */
function applyBulk(group: string, boxes: HTMLInputElement[], on: boolean) {
  const keys = boxes.map(rangeKey).filter(Boolean);
  if (!keys.length) return;
  const d = state.draft;
  if (group === 'sel') {
    for (const k of keys) on ? selectedKeys.add(k) : selectedKeys.delete(k);
  } else if (group === 'pos') {
    for (const k of keys) on ? state.previewSet.add(k) : state.previewSet.delete(k);
    prunePreviewAssign();
    savePreview();
    state.preview = true;
    recompute();
  } else if (group === 'plan-pos' && d) {
    for (const k of keys) on ? d.positions.add(k) : d.positions.delete(k);
    pruneDraft(d);
  } else if (group.startsWith('cover-') && d) {
    const pos = group.slice('cover-'.length);
    // A sector has one owner: picking it here takes it from whoever had it.
    for (const k of keys) {
      if (on) d.assign.set(k, pos);
      else if (d.assign.get(k) === pos) d.assign.delete(k);
    }
  } else return;
  rerenderSheet();
}

function bindMultiSelect() {
  const sheet = $('#preview-sheet');
  sheet.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.dataset.filter) return;
    filters[t.dataset.filter] = t.value;
    applyFilters();
  });
  sheet.addEventListener('keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Escape' && t.dataset.filter && t.value) {
      e.stopPropagation(); // do not close the sheet
      filters[t.dataset.filter] = t.value = '';
      applyFilters();
    }
  });
  // Shift-click ticks/unticks everything between the last clicked box and this one, like selecting files.
  sheet.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cb = (target.matches('input[data-range]') ? target : target.closest('label')?.querySelector('input[data-range]')) as HTMLInputElement | null;
    if (cb && !cb.disabled) {
      const group = cb.dataset.range!;
      const anchor = rangeAnchor[group];
      rangeAnchor[group] = rangeKey(cb);
      if (e.shiftKey && anchor && anchor !== rangeKey(cb)) {
        const boxes = visibleBoxes(group);
        const a = boxes.findIndex((b) => rangeKey(b) === anchor);
        const b = boxes.indexOf(cb);
        if (a >= 0 && b >= 0) {
          e.preventDefault(); // we set the boxes ourselves
          applyBulk(group, boxes.slice(Math.min(a, b), Math.max(a, b) + 1), !cb.checked);
        }
      }
      return;
    }
    const on = target.closest<HTMLElement>('[data-bulk-on]')?.dataset.bulkOn;
    const off = target.closest<HTMLElement>('[data-bulk-off]')?.dataset.bulkOff;
    if (on || off) applyBulk((on ?? off)!, visibleBoxes((on ?? off)!), !!on);
    if (target.closest('[data-sel-clear]')) { selectedKeys.clear(); rerenderSheet(); }
  }, true);
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.sel) {
      if (t.checked) selectedKeys.add(t.dataset.sel);
      else selectedKeys.delete(t.dataset.sel);
      rerenderSheet();
    }
    if (t.hasAttribute('data-bulk-assign') && t.value !== '-') {
      const keys = [...selectedKeys].filter((k) => k.startsWith(`${state.stratum}-`));
      selectedKeys.clear();
      editor()?.set(keys, t.value || null);
    }
  });
}

function selectPilot(p: VatsimPilot, fly = true) {
  state.selectedPilot = p.callsign;
  const st = stratumForAltitude(p.altitude);
  if (lookup(p.longitude, p.latitude, p.altitude)) setStratum(st);
  // On phones, get the sheet out of the way so the aircraft is visible.
  if (panelSheet.isMobile && panelSheet.detentIndex > 0) panelSheet.setDetent(0);
  if (fly) view.map.flyTo({ center: [p.longitude, p.latitude], zoom: Math.max(view.map.getZoom(), 7), padding: padding() });
  recompute();
}

function renderPreviewSheet() {
  if (state.sheet === 'plans') renderPlansSheet();
  else renderPreviewOnly();
  applyFilters();
}

function renderPreviewOnly() {
  $('#sheet-title').textContent = 'Preview';
  $('#sheet-sub').textContent = 'Switch positions on to see who would own each sector.';
  $('#preview-scroll').innerHTML = renderPreview(state.preview, state.previewSet, assignOpts([...state.previewSet].sort(), state.previewAssign, 'assign'));
}

function renderPlansSheet() {
  const live = state.adminView === 'live' && !state.draft;
  $('#sheet-title').textContent = state.draft ? (state.draft.isNew ? 'New event' : 'Edit event') : live ? 'Live edits' : 'Events';
  $('#sheet-sub').textContent = state.draft ? 'The map stays live; the list below shows this event.' : live ? 'Visible to everyone right away' : 'Visible to everyone · only you can edit';
  const sc = $('#preview-scroll');
  if (!state.admin) sc.innerHTML = renderLogin(state.busy, state.adminError);
  else if (state.draft)
    sc.innerHTML = renderPlanEditor({
      draft: state.draft, tz: state.tz, busy: state.busy, error: state.adminError,
      // Owners as they would be if exactly the planned positions logged on; the map itself stays live.
      ownership: computeOwnership(pieces, state.draft.positions, draftAssign(state.draft), state.draft.explicit),
    });
  else if (live)
    sc.innerHTML = renderLiveEditor({
      hours: state.liveHours, hoursOptions: LIVE_HOURS, expires: liveEdits().length ? state.liveEdit!.expires : null,
      tz: state.tz, busy: state.busy, error: state.adminError,
      assign: assignOpts(liveOnline(), new Map(liveEdits()), 'live-assign'),
    });
  else
    sc.innerHTML = renderPlanList({
      plans: state.plans, tz: state.tz, busy: state.busy, error: state.adminError, now: Date.now(),
      live: { online: liveOnline(), event: activePlan(state.plans), edits: liveEdits().length, expires: state.liveEdit?.expires ?? null },
    });
}

function openSheet(mode: 'preview' | 'plans') {
  state.sheet = mode;
  // Plans are edited on their own draft, not on top of a local preview.
  if (mode === 'plans' && state.preview) state.preview = false;
  state.adminError = null;
  renderPreviewSheet();
  togglePreview(true);
}

async function commitPlans(next: Plan[], live: LiveEdit | null = state.liveEdit): Promise<boolean> {
  state.busy = true;
  state.adminError = null;
  rerenderSheet();
  let ok = false;
  try {
    const r = await savePlans(token.get(), next, live && live.expires > Date.now() ? live : null);
    state.plans = r.plans;
    state.liveEdit = r.live;
    ok = true;
  } catch (e) {
    state.adminError = e instanceof Error ? e.message : String(e);
  }
  state.busy = false;
  return ok;
}

async function signIn(value: string) {
  state.busy = true;
  state.adminError = null;
  renderPreviewSheet();
  try {
    const r = await fetchPlans(value);
    if (!r.admin) throw new Error('Wrong token');
    token.set(value);
    state.admin = true;
    state.plans = r.plans;
    state.liveEdit = r.live;
    $('#plans-btn').hidden = false;
  } catch (e) {
    state.adminError = e instanceof Error ? e.message : String(e);
  }
  state.busy = false;
  renderPreviewSheet();
  recompute();
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function startDraft(plan?: Plan) {
  const hour = 3_600_000;
  const start = plan?.start ?? Math.ceil(Date.now() / hour) * hour;
  state.draft = {
    id: plan?.id ?? newId(),
    name: plan?.name ?? '',
    start,
    end: plan?.end ?? start + 3 * hour,
    positions: new Set(plan?.positions ?? []),
    assign: new Map(plan?.assign ?? []),
    explicit: exclusiveOf(plan?.assign ?? []),
    notes: new Map(Object.entries(plan?.notes ?? {})),
    isNew: !plan,
  };
  state.adminError = null;
  recompute();
  rerenderSheet(true);
}

function endDraft() {
  state.draft = null;
  state.adminError = null;
  recompute();
  rerenderSheet(true);
}

/** Only picked sectors of positions in "Pick sectors" mode count. */
const draftAssign = (d: Draft) => new Map([...d.assign].filter(([, pos]) => d.positions.has(pos) && d.explicit.has(pos)));

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
    state.adminError = err;
    rerenderSheet();
    return;
  }
  const plan: Plan = {
    id: d.id, name: d.name, start: d.start, end: d.end,
    positions: [...d.positions].sort(),
    assign: [...draftAssign(d)],
    notes: Object.fromEntries([...d.notes].filter(([id, v]) => d.positions.has(id) && v.trim()).map(([id, v]) => [id, v.trim()])),
  };
  if (await commitPlans([...state.plans.filter((p) => p.id !== d.id), plan])) endDraft();
  else rerenderSheet();
}

function bindPlans() {
  const sheet = $('#preview-sheet');
  sheet.addEventListener('submit', (e) => {
    if ((e.target as HTMLElement).id !== 'plan-login') return;
    e.preventDefault();
    const v = $<HTMLInputElement>('#plan-token').value.trim();
    if (v) void signIn(v);
  });
  // Typing in name/notes updates the draft without re-rendering (keeps focus).
  sheet.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const d = state.draft;
    if (!d || state.sheet !== 'plans') return;
    if (t.id === 'plan-name') d.name = t.value;
    if (t.dataset.planNote) d.notes.set(t.dataset.planNote, t.value);
  });
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (state.sheet !== 'plans') return;
    if (t.id === 'live-hours') {
      state.liveHours = Number(t.value);
      // Re-time the current live edits from now.
      const live = liveEdits();
      if (live.length) void commitPlans(state.plans, { assign: live, expires: Date.now() + state.liveHours * 3_600_000 }).then(() => rerenderSheet());
      return;
    }
    if (t.dataset.liveAssign) return setLiveAssign([t.dataset.liveAssign], t.value || null);
    const d = state.draft;
    if (!d) return;
    if (t.id === 'plan-start' || t.id === 'plan-end') {
      const ms = fromInput(t.value, state.tz);
      if (t.id === 'plan-start') {
        // Moving the start keeps the duration.
        const len = d.end - d.start;
        d.start = ms;
        if (Number.isFinite(ms) && Number.isFinite(len) && len > 0) d.end = ms + len;
        const end = $<HTMLInputElement>('#plan-end');
        if (Number.isFinite(d.end)) end.value = toInputFor(d.end);
      } else d.end = ms;
      // Update the "other zone" hints in place: re-rendering would steal focus from the picker.
      for (const [id, v] of [['plan-start', d.start], ['plan-end', d.end]] as const)
        $(`#${id}-other`).textContent = Number.isFinite(v) ? fmtTime(v, state.tz === 'utc' ? 'local' : 'utc') : '';
      return;
    }
    if (t.dataset.coverSector && t.dataset.coverPos) {
      // A sector has one owner: ticking it here takes it from whoever had it.
      if (t.checked) d.assign.set(t.dataset.coverSector, t.dataset.coverPos);
      else if (d.assign.get(t.dataset.coverSector) === t.dataset.coverPos) d.assign.delete(t.dataset.coverSector);
      return rerenderSheet();
    }
    if (t.dataset.planPos) {
      if (t.checked) d.positions.add(t.dataset.planPos);
      else d.positions.delete(t.dataset.planPos);
      pruneDraft(d);
      rerenderSheet();
    }
  });
  sheet.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const el = <K extends string>(attr: K) => t.closest<HTMLElement>(`[data-${attr}]`);
    const tz = el('tz')?.dataset.tz as Tz | undefined;
    if (tz && state.sheet === 'plans' && tz !== state.tz) {
      state.tz = tz;
      store.set('asx.tz', tz);
      rerenderSheet();
    }
    if (el('plan-new')) startDraft();
    const mode = el('cover-mode');
    if (mode && state.draft) {
      const id = mode.dataset.coverMode!;
      if (mode.dataset.mode === 'pick') state.draft.explicit.add(id);
      else {
        state.draft.explicit.delete(id);
        for (const [k, v] of state.draft.assign) if (v === id) state.draft.assign.delete(k);
      }
      rerenderSheet();
    }
    if (el('live-open')) { state.adminView = 'live'; state.adminError = null; rerenderSheet(true); renderEditHint(); }
    if (el('live-done')) { state.adminView = 'list'; state.adminError = null; rerenderSheet(true); renderEditHint(); }
    if (el('live-clear') || el('live-assign-reset')) void commitPlans(state.plans, null).then(() => { recompute(); rerenderSheet(); });
    const pv = el('plan-preview')?.dataset.planPreview;
    const pvPlan = pv && state.plans.find((p) => p.id === pv);
    if (pvPlan) {
      // Load the event into the local Preview.
      state.previewSet = new Set(pvPlan.positions);
      state.previewAssign = new Map(pvPlan.assign);
      state.previewExclusive = exclusiveOf(pvPlan.assign);
      savePreview();
      state.preview = true;
      state.adminError = null;
      state.sheet = 'preview';
      recompute();
      rerenderSheet(true);
      renderEditHint();
      return;
    }
    const edit = el('plan-edit')?.dataset.planEdit;
    if (edit) startDraft(state.plans.find((p) => p.id === edit));
    const del = el('plan-delete')?.dataset.planDelete;
    if (del && confirm('Delete this event?')) void commitPlans(state.plans.filter((p) => p.id !== del)).then(() => { recompute(); rerenderSheet(); });
    if (el('plan-cancel')) endDraft();
    if (el('plan-save')) void saveDraft();
    const preset = el('plan-preset')?.dataset.planPreset;
    if (preset && state.draft) {
      state.draft.positions = new Set(preset.split(','));
      pruneDraft(state.draft);
      rerenderSheet();
    }
    if (el('plan-signout')) {
      token.set('');
      state.admin = false;
      state.draft = null;
      state.adminView = 'list';
      $('#plans-btn').hidden = true;
      recompute();
      rerenderSheet();
    }
  });
  // Hidden entry point: open the site with #admin to get the sign-in form.
  if (plansEnabled && location.hash === '#admin') {
    history.replaceState(null, '', location.pathname + location.search);
    openSheet('plans');
  }
  // Shareable entry point for the local preview editor.
  const openPreviewFromHash = () => {
    if (location.hash !== '#preview') return;
    state.preview = true;
    recompute();
    openSheet('preview');
  };
  window.addEventListener('hashchange', openPreviewFromHash);
  openPreviewFromHash();
}

/** Forget picks/notes of positions that are no longer expected. */
function pruneDraft(d: Draft) {
  for (const [k, v] of d.assign) if (!d.positions.has(v)) d.assign.delete(k);
  for (const id of d.explicit) if (!d.positions.has(id)) d.explicit.delete(id);
}

const toInputFor = (ms: number) => toInput(ms, state.tz);

function togglePreview(open: boolean) {
  if (previewSheet.isMobile) previewSheet.setDetent(open ? 1 : 0);
  else $('#preview-sheet').classList.toggle('open', open);
  document.documentElement.dataset.preview = open ? 'open' : 'closed';
  if (!open) {
    closeMenu();
    if (location.hash === '#preview') history.replaceState(null, '', location.pathname + location.search);
  }
  renderEditHint();
}

function bindHover() {
  const tip = $('#tooltip');
  const hovered: Record<string, string | null> = { pieces: null, neighbors: null };
  const setHover = (source: 'pieces' | 'neighbors', id: string | null) => {
    if (hovered[source] === id) return;
    if (hovered[source]) view.map.setFeatureState({ source, id: hovered[source]! }, { hover: false });
    hovered[source] = id;
    if (id) view.map.setFeatureState({ source, id }, { hover: true });
  };
  const place = (x: number, y: number) => {
    tip.hidden = false; // measure only once it is laid out
    const { offsetWidth: w, offsetHeight: h } = tip;
    const left = x + 16 + w > window.innerWidth - 8 ? x - w - 16 : x + 16;
    const top = y + 16 + h > window.innerHeight - 8 ? y - h - 16 : y + 16;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  };
  view.map.on('mousemove', (e) => {
    if (menuKey) return;
    const f = view.map.queryRenderedFeatures(e.point, { layers: ['pieces-fill', 'neighbors-fill'].filter((l) => view.map.getLayer(l)) })[0];
    if (!f) {
      tip.hidden = true;
      setHover('pieces', null);
      setHover('neighbors', null);
      return;
    }
    const vm = viewModel();
    if (f.layer.id === 'pieces-fill') {
      const p = f.properties as Piece;
      setHover('neighbors', null);
      setHover('pieces', p.pid);
      tip.innerHTML = zmeTooltip(vm, p);
    } else {
      const nid = f.properties?.nid as string;
      const p = neighborPieces.find((x) => x.nid === nid);
      if (!p) return;
      setHover('pieces', null);
      setHover('neighbors', nid);
      tip.innerHTML = neighborTooltip(vm, p);
    }
    place(e.point.x, e.point.y);
  });
  view.map.getCanvas().addEventListener('mouseleave', () => {
    tip.hidden = true;
    setHover('pieces', null);
    setHover('neighbors', null);
  });
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="fatal material">Failed to start: ${esc(e instanceof Error ? e.message : e)}</div>`);
});

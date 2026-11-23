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
import { fetchOverrides, manualEnabled, saveOverrides, token, type AssignOverride, type Override } from './manual';
import { icons } from './ui/icons';
import {
  esc,
  neighborTooltip,
  ownerCallsign,
  renderAircraftCard,
  renderControllers,
  renderNeighbors,
  renderAssignMenu,
  renderManual,
  renderPreview,
  renderSectors,
  renderStatus,
  zmeTooltip,
  type AircraftHit,
  type AssignOpts,
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
function loadPreview(): { positions: string[]; assign: [string, string][] } {
  try {
    const v = JSON.parse(store.get('asx.preview') ?? '') as { positions?: unknown; assign?: unknown };
    return {
      positions: Array.isArray(v.positions) ? v.positions.filter((id): id is string => typeof id === 'string' && POSITIONS.has(id)) : [],
      assign: Array.isArray(v.assign) ? v.assign.filter((e): e is [string, string] => Array.isArray(e) && SECTOR_BY_KEY.has(e[0]) && POSITIONS.has(e[1])) : [],
    };
  } catch {
    return { positions: [], assign: [] };
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
  ownership: null as Ownership | null,
  neighborCtrls: [] as NeighborController[],
  neighborOwners: new Map<string, NeighborOwner>(),
  neighborsVisible: store.get('asx.neighbors') !== '0',
  error: null as string | null,
  lastFetch: 0,
  selectedPilot: null as string | null,
  manual: [] as Override[],
  manualAssign: [] as AssignOverride[],
  admin: false,
  manualHours: 4,
  manualBusy: false,
  manualError: null as string | null,
  sheet: 'preview' as 'preview' | 'manual',
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
  $('#preview-btn').innerHTML = icons.sliders;
  $('#manual-btn').innerHTML = icons.lock;
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
  await refreshManual();
  recompute();
  setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

/** Manual positions are public to read; the token only proves who may edit. Failures keep the last list. */
async function refreshManual() {
  if (!manualEnabled || state.manualBusy) return;
  try {
    const r = await fetchOverrides();
    state.manual = r.positions;
    state.manualAssign = r.assign;
    state.admin = r.admin;
  } catch { /* backend unreachable — keep what we had */ }
  $('#manual-btn').hidden = !state.admin;
}

function manualControllers(): OnlineController[] {
  const live = new Set(state.live.map((c) => c.position));
  return state.manual
    .filter((o) => o.expires > Date.now() && !live.has(o.position) && POSITIONS.has(o.position))
    .map((o) => {
      const p = POSITIONS.get(o.position)!;
      return { position: o.position, callsign: p.callsign, frequency: p.freq, name: 'Manual', cid: 0, rating: '', logon: new Date(), manual: true, until: new Date(o.expires) };
    });
}

function controllers(): OnlineController[] {
  if (!state.preview) return [...state.live, ...manualControllers()].sort((a, b) => a.position.localeCompare(b.position));
  return [...state.previewSet].sort().map((id) => {
    const p = POSITIONS.get(id)!;
    return { position: id, callsign: p.callsign, frequency: p.freq, name: 'Preview', cid: 0, rating: '', logon: new Date(), preview: true };
  });
}

/** Sector → position assignments in force for the current mode. */
function assignMap(): Map<string, string> {
  if (state.preview) return state.previewAssign;
  const now = Date.now();
  return new Map(state.manualAssign.filter((a) => a.expires > now).map((a) => [a.sector, a.position]));
}

function savePreview() {
  store.set('asx.preview', JSON.stringify({ positions: [...state.previewSet], assign: [...state.previewAssign] }));
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
  };
}

function recompute() {
  const ctrls = controllers();
  const online = new Set(ctrls.map((c) => c.position));
  state.ownership = computeOwnership(pieces, online, assignMap());
  state.neighborCtrls = neighborControllers(state.data, facilities);
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
interface Editor { online: string[]; assign: Map<string, string>; set(key: string, pos: string | null): void }

/** The assignment editor that is open right now, if any (preview sheet, or manual sheet when signed in). */
function editor(): Editor | null {
  if (document.documentElement.dataset.preview !== 'open') return null;
  if (state.sheet === 'preview' && state.preview)
    return { online: [...state.previewSet].sort(), assign: state.previewAssign, set: setPreviewAssign };
  if (state.sheet === 'manual' && state.admin && !state.preview)
    return { online: manualOnline(), assign: assignMap(), set: setManualAssign };
  return null;
}

function manualOnline() {
  return [...new Set([...state.live, ...manualControllers()].map((c) => c.position))].sort();
}

function assignOpts(online: string[], assign: Map<string, string>, attr: AssignOpts['attr']): AssignOpts {
  return { stratum: state.stratum, online, assign, ownership: state.ownership!, colors, attr, busy: state.manualBusy };
}

function setPreviewAssign(key: string, pos: string | null) {
  if (pos) state.previewAssign.set(key, pos);
  else state.previewAssign.delete(key);
  savePreview();
  recompute();
  rerenderSheet();
}

function setManualAssign(key: string, pos: string | null) {
  const rest = state.manualAssign.filter((a) => a.sector !== key && a.expires > Date.now());
  void commitManual(state.manual, pos ? [...rest, { sector: key, position: pos, expires: Date.now() + state.manualHours * 3_600_000 }] : rest);
}

/** Drop preview assignments whose position was switched off. */
function prunePreviewAssign() {
  for (const [k, v] of state.previewAssign) if (!state.previewSet.has(v)) state.previewAssign.delete(k);
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

/** Re-render the open sheet without losing its scroll position. */
function rerenderSheet() {
  const sc = $('#preview-scroll');
  const top = sc.scrollTop;
  renderPreviewSheet();
  sc.scrollTop = top;
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
    if (a === 'open-manual') openSheet('manual');
    if (a === 'close-preview') togglePreview(false);
    if (a === 'close-aircraft') { state.selectedPilot = null; recompute(); }
    if (a === 'recenter') view.map.fitBounds(zmeBounds, { padding: padding() });
    if (a === 'toggle-neighbors') setNeighborsVisible(!state.neighborsVisible);
    if (a === 'exit-preview') { state.preview = false; togglePreview(false); state.sheet = 'preview'; renderPreviewSheet(); recompute(); }
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-menu-assign]');
    if (pick && menuKey) {
      const key = menuKey;
      closeMenu();
      editor()?.set(key, pick.dataset.menuAssign || null);
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
  bindManual();
  const sheet = $('#preview-sheet');
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.assign) return setPreviewAssign(t.dataset.assign, t.value || null);
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
      savePreview();
      recompute();
      rerenderSheet();
      return;
    }
    if (preset === undefined) return;
    state.previewSet = new Set(preset ? preset.split(',') : []);
    prunePreviewAssign();
    savePreview();
    state.preview = true;
    renderPreviewSheet();
    recompute();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuKey) return closeMenu();
      togglePreview(false);
      if (state.selectedPilot) { state.selectedPilot = null; recompute(); }
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
  if (state.sheet === 'manual') return renderManualSheet();
  $('#sheet-title').textContent = 'Preview';
  $('#sheet-sub').textContent = 'Switch positions on to see who would own each sector.';
  $('#preview-scroll').innerHTML = renderPreview(state.preview, state.previewSet, assignOpts([...state.previewSet].sort(), state.previewAssign, 'assign'));
}

function renderManualSheet() {
  $('#sheet-title').textContent = 'Manual positions';
  $('#sheet-sub').textContent = 'Visible to everyone · only you can edit';
  $('#preview-scroll').innerHTML = renderManual({
    signedIn: state.admin, manual: state.manual, assign: state.manualAssign,
    assignOpts: assignOpts(manualOnline(), assignMap(), 'manual-assign'),
    hours: state.manualHours, busy: state.manualBusy, error: state.manualError,
  });
}

function openSheet(mode: 'preview' | 'manual') {
  state.sheet = mode;
  // The manual sheet edits the live picture, so leave preview mode for it.
  if (mode === 'manual' && state.preview) { state.preview = false; recompute(); }
  state.manualError = null;
  renderPreviewSheet();
  togglePreview(true);
}

async function commitManual(next: Override[], assign: AssignOverride[]) {
  state.manualBusy = true;
  state.manualError = null;
  rerenderSheet();
  try {
    const r = await saveOverrides(token.get(), next, assign);
    state.manual = r.positions;
    state.manualAssign = r.assign;
  } catch (e) {
    state.manualError = e instanceof Error ? e.message : String(e);
  }
  state.manualBusy = false;
  recompute();
  rerenderSheet();
}

async function signIn(value: string) {
  state.manualBusy = true;
  state.manualError = null;
  renderManualSheet();
  try {
    const r = await fetchOverrides(value);
    if (!r.admin) throw new Error('Wrong token');
    token.set(value);
    state.admin = true;
    state.manual = r.positions;
    state.manualAssign = r.assign;
    $('#manual-btn').hidden = false;
  } catch (e) {
    state.manualError = e instanceof Error ? e.message : String(e);
  }
  state.manualBusy = false;
  renderManualSheet();
  recompute();
}

function bindManual() {
  const sheet = $('#preview-sheet');
  sheet.addEventListener('submit', (e) => {
    if ((e.target as HTMLElement).id !== 'manual-login') return;
    e.preventDefault();
    const v = $<HTMLInputElement>('#manual-token').value.trim();
    if (v) void signIn(v);
  });
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'manual-hours') state.manualHours = Number(t.value);
    if (t.dataset.manualAssign) return setManualAssign(t.dataset.manualAssign, t.value || null);
    const pos = t.dataset.manualPos;
    if (!pos) return;
    const rest = state.manual.filter((o) => o.position !== pos);
    void commitManual(t.checked ? [...rest, { position: pos, expires: Date.now() + state.manualHours * 3_600_000 }] : rest, state.manualAssign);
  });
  sheet.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-manual-clear]')) void commitManual([], []);
    if (t.closest('[data-manual-assign-reset]')) void commitManual(state.manual, []);
    if (t.closest('[data-manual-signout]')) {
      token.set('');
      state.admin = false;
      $('#manual-btn').hidden = true;
      renderManualSheet();
    }
  });
  // Hidden entry point: open the site with #admin to get the sign-in form.
  if (manualEnabled && location.hash === '#admin') {
    history.replaceState(null, '', location.pathname + location.search);
    openSheet('manual');
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

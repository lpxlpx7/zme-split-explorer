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
import { fetchOverrides, manualEnabled, saveOverrides, token, type Override } from './manual';
import { icons } from './ui/icons';
import {
  esc,
  neighborTooltip,
  ownerCallsign,
  renderAircraftCard,
  renderControllers,
  renderNeighbors,
  renderManual,
  renderPreview,
  renderSectors,
  renderStatus,
  zmeTooltip,
  type AircraftHit,
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

const state = {
  stratum: (store.get('asx.stratum') as Stratum) || 'HI',
  tab: 'controllers' as Tab,
  data: null as VatsimData | null,
  live: [] as OnlineController[],
  preview: false,
  previewSet: new Set<string>(),
  ownership: null as Ownership | null,
  neighborCtrls: [] as NeighborController[],
  neighborOwners: new Map<string, NeighborOwner>(),
  neighborsVisible: store.get('asx.neighbors') !== '0',
  error: null as string | null,
  lastFetch: 0,
  selectedPilot: null as string | null,
  manual: [] as Override[],
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

  bindUI();
  bindHover();
  renderSegments();
  recompute();
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
  state.ownership = computeOwnership(pieces, online);
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
  }

  const vm = viewModel();
  $('#status').innerHTML = renderStatus(vm);
  $('#preview-banner').hidden = !state.preview;
  renderBody(vm);
  renderAircraft();
  renderClock();
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
  view.map.on('mouseenter', 'aircraft', () => (view.map.getCanvas().style.cursor = 'pointer'));
  view.map.on('mouseleave', 'aircraft', () => (view.map.getCanvas().style.cursor = ''));

  renderPreviewSheet();
  bindManual();
  const sheet = $('#preview-sheet');
  sheet.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.manualPos || t.id === 'manual-hours') return;
    if (t.dataset.pos) {
      if (t.checked) state.previewSet.add(t.dataset.pos);
      else state.previewSet.delete(t.dataset.pos);
      // Picking a position implies preview mode; otherwise nothing would visibly change.
      state.preview = true;
      $<HTMLInputElement>('#preview-toggle').checked = true;
    } else if (t.id === 'preview-toggle') {
      state.preview = t.checked;
    }
    recompute();
  });
  sheet.addEventListener('click', (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-preset]')?.dataset.preset;
    if (preset === undefined) return;
    state.previewSet = new Set(preset ? preset.split(',') : []);
    state.preview = true;
    renderPreviewSheet();
    recompute();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
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
  $('#preview-scroll').innerHTML = renderPreview(state.preview, state.previewSet);
}

function renderManualSheet() {
  $('#sheet-title').textContent = 'Manual positions';
  $('#sheet-sub').textContent = 'Visible to everyone · only you can edit';
  $('#preview-scroll').innerHTML = renderManual({ signedIn: state.admin, manual: state.manual, hours: state.manualHours, busy: state.manualBusy, error: state.manualError });
}

function openSheet(mode: 'preview' | 'manual') {
  state.sheet = mode;
  state.manualError = null;
  renderPreviewSheet();
  togglePreview(true);
}

async function commitManual(next: Override[]) {
  state.manualBusy = true;
  state.manualError = null;
  renderManualSheet();
  try {
    const r = await saveOverrides(token.get(), next);
    state.manual = r.positions;
  } catch (e) {
    state.manualError = e instanceof Error ? e.message : String(e);
  }
  state.manualBusy = false;
  renderManualSheet();
  recompute();
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
    const pos = t.dataset.manualPos;
    if (!pos) return;
    const rest = state.manual.filter((o) => o.position !== pos);
    void commitManual(t.checked ? [...rest, { position: pos, expires: Date.now() + state.manualHours * 3_600_000 }] : rest);
  });
  sheet.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-manual-clear]')) void commitManual([]);
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
}

function togglePreview(open: boolean) {
  if (previewSheet.isMobile) previewSheet.setDetent(open ? 1 : 0);
  else $('#preview-sheet').classList.toggle('open', open);
  document.documentElement.dataset.preview = open ? 'open' : 'closed';
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

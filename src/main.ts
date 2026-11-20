import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { bbox, contains, type Polygonal } from './geo';
import { createMap, padding, type MapView } from './map';
import { computeOwnership, type Ownership, type Piece } from './ownership';
import {
  NEIGHBORS,
  POSITIONS,
  SECTORS,
  SECTOR_BY_KEY,
  STRATA,
  STRATUM_INFO,
  sectorKey,
  type Stratum,
} from './sectors';
import {
  POLL_MS,
  fetchVatsim,
  neighborOnline,
  zmeControllers,
  type OnlineController,
  type VatsimData,
  type VatsimPilot,
} from './vatsim';

// Apple system colours (light-mode values read well on both basemaps).
const PALETTE = ['#007AFF', '#FF9500', '#34C759', '#AF52DE', '#FF2D55', '#30B0C7', '#5856D6', '#FFCC00', '#FF3B30', '#00C7BE', '#A2845E', '#32ADE6'];

type Tab = 'controllers' | 'sectors' | 'neighbors';

const state = {
  stratum: (localStorage.getItem('asx.stratum') as Stratum) || 'HI',
  tab: 'controllers' as Tab,
  data: null as VatsimData | null,
  live: [] as OnlineController[],
  preview: false,
  previewSet: new Set<string>(),
  ownership: null as Ownership | null,
  colors: new Map<string, string>(),
  error: null as string | null,
  lastFetch: 0,
  selectedPilot: null as string | null,
};
if (!STRATA.includes(state.stratum)) state.stratum = 'HI';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let pieces: Piece[] = [];
let view: MapView;
let zmeBoundary: Polygonal;

// ─── bootstrap ───────────────────────────────────────────────────────────────
async function loadJSON<T>(name: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}.geojson`);
  if (!res.ok) throw new Error(`Failed to load ${name}`);
  return res.json() as Promise<T>;
}

async function init() {
  const [piecesFC, sectorsFC, boundaryFC, neighborsFC] = await Promise.all([
    loadJSON<GeoJSON.FeatureCollection>('pieces'),
    loadJSON<GeoJSON.FeatureCollection>('sectors'),
    loadJSON<GeoJSON.FeatureCollection>('boundary'),
    loadJSON<GeoJSON.FeatureCollection>('neighbors'),
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

  // The LO boundary is the outermost extent of ZME.
  const loBoundary = boundaryFC.features.find((f) => f.properties?.stratum === 'LO') ?? boundaryFC.features[0];
  const ring = (loBoundary.geometry as GeoJSON.LineString).coordinates as [number, number][];
  zmeBoundary = { type: 'Polygon', coordinates: [ring] };
  const [x0, y0, x1, y1] = bbox([zmeBoundary]);

  view = createMap($('#map'), { pieces: piecesFC, sectors: sectorsFC, boundary: boundaryFC, neighbors: neighborsFC }, darkQuery.matches, [[x0, y0], [x1, y1]]);
  view.setStratum(state.stratum);
  view.map.on('style.load', () => { view.setStratum(state.stratum); recompute(); });
  darkQuery.addEventListener('change', (e) => view.setTheme(e.matches));

  bindUI([[x0, y0], [x1, y1]]);
  bindHover();
  renderSegment();
  recompute();
  poll();
  setInterval(renderClock, 1000);
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
  recompute();
  setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

function controllers(): OnlineController[] {
  if (!state.preview) return state.live;
  return [...state.previewSet].sort().map((id) => {
    const p = POSITIONS.get(id)!;
    return { position: id, callsign: p.callsign, frequency: p.freq, name: 'Preview', cid: 0, rating: '', logon: new Date(), preview: true };
  });
}

function recompute() {
  const ctrls = controllers();
  const online = new Set(ctrls.map((c) => c.position));
  state.ownership = computeOwnership(pieces, online);

  assignColors([...online].sort());
  const pieceColors = new Map<string, string | null>();
  for (const [pid, owner] of state.ownership.owners) pieceColors.set(pid, owner ? state.colors.get(owner)! : null);
  view.setPieceColors(pieceColors);
  view.setAircraft(aircraftFeatures());

  renderStatus();
  renderBody();
  renderAircraftCard();
  renderClock();
}

/**
 * Stable colours: a position keeps its colour for as long as it stays online.
 * Positions that go offline release their colour; new ones take the first free one.
 */
function assignColors(ids: string[]) {
  const keep = new Set(ids);
  for (const id of [...state.colors.keys()]) if (!keep.has(id)) state.colors.delete(id);
  for (const id of ids) {
    if (state.colors.has(id)) continue;
    const used = new Set(state.colors.values());
    const free = PALETTE.find((c) => !used.has(c)) ?? PALETTE[state.colors.size % PALETTE.length];
    state.colors.set(id, free);
  }
}

// ─── airspace lookup ─────────────────────────────────────────────────────────
function stratumForAltitude(alt: number): Stratum {
  if (alt >= 34_500) return 'UH';
  if (alt >= 23_500) return 'HI';
  return 'LO';
}

function lookup(lon: number, lat: number, alt: number) {
  const stratum = stratumForAltitude(alt);
  const candidates = pieces.filter((p) => p.stratum === stratum && contains(p.geometry, lon, lat));
  if (!candidates.length) return null;
  // Stacked sectors: Sector 60 owns SFC–080 under Sector 40.
  const isStacked = (p: Piece) => !!SECTOR_BY_KEY.get(sectorKey(p.stratum, p.sector))?.stackedUnder;
  const piece =
    candidates.find((p) => isStacked(p) === alt < 8_500) ?? candidates.find((p) => !isStacked(p)) ?? candidates[0];
  const owner = state.ownership?.owners.get(piece.pid) ?? null;
  return { piece, stratum, owner, sector: SECTOR_BY_KEY.get(sectorKey(piece.stratum, piece.sector))! };
}

function pilotsInZme(): VatsimPilot[] {
  if (!state.data) return [];
  const [x0, y0, x1, y1] = bbox([zmeBoundary]);
  return state.data.pilots.filter(
    (p) => p.longitude >= x0 && p.longitude <= x1 && p.latitude >= y0 && p.latitude <= y1 && contains(zmeBoundary, p.longitude, p.latitude),
  );
}

function aircraftFeatures(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pilotsInZme().map((p) => {
      const hit = lookup(p.longitude, p.latitude, p.altitude);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
        properties: {
          callsign: p.callsign,
          heading: p.heading,
          color: hit?.owner ? state.colors.get(hit.owner) ?? null : null,
          selected: p.callsign === state.selectedPilot,
        },
      };
    }),
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────
function ownerCallsign(id: string) {
  return controllers().find((c) => c.position === id)?.callsign ?? POSITIONS.get(id)?.callsign ?? `MEM_${id}_CTR`;
}

function swatch(id: string | null | undefined) {
  const color = id ? state.colors.get(id) : null;
  return `<span class="swatch${color ? '' : ' empty'}" style="${color ? `--c:${color}` : ''}"></span>`;
}

function sectorChip(key: string) {
  const s = SECTOR_BY_KEY.get(key);
  return s ? `<span class="chip"><b>${s.id}</b>${esc(s.name)}</span>` : '';
}

function describeSplit(o: Ownership) {
  if (o.mode === 'offline') return { title: 'Memphis Center is offline', sub: 'No enroute positions online' };
  const count = (s?: Stratum) =>
    new Set(pieces.filter((p) => !s || p.stratum === s).map((p) => o.owners.get(p.pid)).filter(Boolean)).size;
  if (o.mode === 'combined') {
    const n = count();
    return { title: n === 1 ? 'All combined' : `Combined ${n}-way split`, sub: 'All altitudes · SOP 3-2-1' };
  }
  return {
    title: 'Stratified split',
    sub: STRATA.map((s) => `${s} ${count(s)}-way`).join(' · '),
  };
}

function renderStatus() {
  const o = state.ownership!;
  const { title, sub } = describeSplit(o);
  $('#status').innerHTML = `
    <div class="status-icon ${o.mode}">${o.mode === 'offline' ? iconMoon : iconRadar}</div>
    <div class="status-text"><div class="status-title">${esc(title)}</div><div class="status-sub">${esc(sub)}</div></div>`;
  $('#preview-banner').hidden = !state.preview;
}

function renderBody() {
  const body = $('#body');
  if (state.tab === 'controllers') body.innerHTML = renderControllers();
  else if (state.tab === 'sectors') body.innerHTML = renderSectors();
  else body.innerHTML = renderNeighbors();
}

function renderControllers() {
  const o = state.ownership!;
  const ctrls = controllers();
  if (!ctrls.length)
    return `<div class="empty-state">${iconMoon}<p>Turn on positions in Preview to see how ZME would be split.</p><button class="btn tinted" data-action="open-preview">Open Preview</button></div>`;
  return `<div class="list">${ctrls
    .map((c) => {
      const pos = POSITIONS.get(c.position);
      const keys = o.positionSectors.get(c.position) ?? [];
      const byStratum = STRATA.map((s) => {
        const ks = keys.filter((k) => k.startsWith(`${s}-`));
        return ks.length ? `<div class="strat-row"><span class="strat-tag">${s}</span><div class="chips">${ks.map(sectorChip).join('')}</div></div>` : '';
      }).join('');
      const mins = Math.max(0, Math.round((Date.now() - c.logon.getTime()) / 60000));
      const dur = c.preview ? 'Preview' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      return `<article class="ctrl" style="--c:${state.colors.get(c.position)}">
        <div class="ctrl-head">
          <span class="ctrl-badge">${c.position}</span>
          <div class="ctrl-id"><div class="ctrl-callsign">${esc(c.callsign)}</div><div class="ctrl-name">${esc(pos?.name ?? '')} · ${esc(c.preview ? 'Preview' : c.name)}${c.rating ? ` · ${esc(c.rating)}` : ''}</div></div>
          <div class="ctrl-freq"><div>${esc(c.frequency)}</div><small>${esc(dur)}</small></div>
        </div>
        ${byStratum || '<div class="muted small pad">No airspace</div>'}
      </article>`;
    })
    .join('')}</div>`;
}

function renderSectors() {
  const o = state.ownership!;
  const groups = [1, 2, 3, 4, 5, 6].map((area) => {
    const rows = SECTORS.filter((s) => s.stratum === state.stratum && s.area === area)
      .map((s) => {
        const owners = [...(o.sectorOwners.get(sectorKey(s.stratum, s.id)) ?? [])];
        const ownerHtml = owners.length
          ? owners.map((id) => `<span class="owner">${swatch(id)}${esc(ownerCallsign(id))}</span>`).join('')
          : `<span class="owner muted">${swatch(null)}Uncovered</span>`;
        return `<div class="row"><span class="row-num">${s.id}</span><div class="row-main"><div>${esc(s.name)}</div><small>${esc(s.altitude ?? STRATUM_INFO[s.stratum].altitude)}${s.freqs[0] ? ` · ${s.freqs[0]}` : ''}</small></div><div class="row-owner">${ownerHtml}</div></div>`;
      })
      .join('');
    return rows ? `<section class="group"><h3>Area ${area}</h3><div class="inset">${rows}</div></section>` : '';
  });
  return groups.join('');
}

function renderNeighbors() {
  if (!state.data) return `<div class="empty-state"><p>Waiting for VATSIM data…</p></div>`;
  return `<section class="group"><h3>Adjacent centers</h3><div class="inset">${NEIGHBORS.map((n) => {
    const on = neighborOnline(state.data!, n.prefixes);
    return `<div class="row"><span class="dot ${on.length ? 'on' : ''}"></span><div class="row-main"><div>${n.id} · ${esc(n.name)}</div><small>${on.length ? on.map((c) => `${esc(c.callsign)} ${esc(c.frequency)}`).join(' · ') : 'Offline'}</small></div></div>`;
  }).join('')}</div></section>`;
}

function renderClock() {
  const pill = $('#live');
  if (state.preview) { pill.className = 'live preview'; pill.textContent = 'Preview'; return; }
  if (state.error) { pill.className = 'live error'; pill.textContent = 'Feed error'; pill.title = state.error; return; }
  if (!state.lastFetch) { pill.className = 'live'; pill.textContent = 'Connecting…'; return; }
  const s = Math.round((Date.now() - state.lastFetch) / 1000);
  pill.className = 'live ok';
  pill.textContent = 'Live';
  pill.title = `Updated ${s}s ago${state.data ? ` · VATSIM feed ${state.data.general.update_timestamp}` : ''}`;
}

function renderSegment() {
  document.querySelectorAll<HTMLButtonElement>('#strata button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === state.stratum)));
  const idx = STRATA.indexOf(state.stratum);
  $('#strata').style.setProperty('--i', String(idx));
  $('#strata-alt').textContent = STRATUM_INFO[state.stratum].altitude;
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === state.tab)));
  $('#tabs').style.setProperty('--i', String(['controllers', 'sectors', 'neighbors'].indexOf(state.tab)));
}

function renderAircraftCard() {
  const card = $('#aircraft-card');
  const p = state.data?.pilots.find((x) => x.callsign === state.selectedPilot);
  if (!p) { card.hidden = true; return; }
  const hit = lookup(p.longitude, p.latitude, p.altitude);
  const fp = p.flight_plan;
  const contact = !hit
    ? `<div class="contact muted">Outside ZME airspace</div>`
    : hit.owner
      ? `<div class="contact" style="--c:${state.colors.get(hit.owner)}"><span class="ctrl-badge">${hit.owner}</span><div><div class="ctrl-callsign">${esc(ownerCallsign(hit.owner))}</div><div class="ctrl-name">${esc(POSITIONS.get(hit.owner)?.name)}</div></div><div class="ctrl-freq">${esc(controllers().find((c) => c.position === hit.owner)?.frequency ?? POSITIONS.get(hit.owner)?.freq)}</div></div>`
      : `<div class="contact muted">Uncovered · monitor UNICOM 122.800</div>`;
  card.hidden = false;
  card.innerHTML = `
    <button class="close" data-action="close-aircraft" aria-label="Close">✕</button>
    <div class="ac-callsign">${esc(p.callsign)}</div>
    <div class="ac-route">${esc(fp?.departure ?? '----')} → ${esc(fp?.arrival ?? '----')} · ${esc(fp?.aircraft_short ?? '')}</div>
    <div class="ac-stats"><div><small>Altitude</small>${p.altitude.toLocaleString()} ft</div><div><small>Ground speed</small>${p.groundspeed} kt</div><div><small>Sector</small>${hit ? `${hit.sector.id} ${esc(hit.sector.name)}` : '—'}</div></div>
    <div class="ac-label">Contact</div>${contact}`;
}

// ─── interaction ─────────────────────────────────────────────────────────────
function bindUI(bounds: [[number, number], [number, number]]) {
  $('#strata').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-s]');
    if (!b) return;
    state.stratum = b.dataset.s as Stratum;
    localStorage.setItem('asx.stratum', state.stratum);
    view.setStratum(state.stratum);
    renderSegment();
    renderBody();
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-t]');
    if (!b) return;
    state.tab = b.dataset.t as Tab;
    renderSegment();
    renderBody();
  });
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (a === 'open-preview') togglePreviewSheet(true);
    if (a === 'close-preview') togglePreviewSheet(false);
    if (a === 'close-aircraft') { state.selectedPilot = null; recompute(); }
    if (a === 'recenter') view.map.fitBounds(bounds, { padding: padding() });
    if (a === 'exit-preview') { state.preview = false; togglePreviewSheet(false); renderPreviewSheet(); recompute(); }
  });

  $<HTMLFormElement>('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('#search input');
    const q = input.value.trim().toUpperCase();
    const p = state.data?.pilots.find((x) => x.callsign.toUpperCase() === q);
    input.classList.toggle('notfound', !p && !!q);
    if (!p) return;
    selectPilot(p);
  });

  view.map.on('click', 'aircraft', (e) => {
    const cs = e.features?.[0]?.properties?.callsign as string | undefined;
    const p = state.data?.pilots.find((x) => x.callsign === cs);
    if (p) selectPilot(p, false);
  });
  view.map.on('mouseenter', 'aircraft', () => (view.map.getCanvas().style.cursor = 'pointer'));
  view.map.on('mouseleave', 'aircraft', () => (view.map.getCanvas().style.cursor = ''));

  renderPreviewSheet();
  $('#preview-sheet').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.pos) {
      t.checked ? state.previewSet.add(t.dataset.pos) : state.previewSet.delete(t.dataset.pos);
      // Picking a position implies preview mode; otherwise nothing would visibly change.
      state.preview = true;
      $<HTMLInputElement>('#preview-toggle').checked = true;
    } else if (t.id === 'preview-toggle') {
      state.preview = t.checked;
    }
    recompute();
  });
  $('#preview-sheet').addEventListener('click', (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-preset]')?.dataset.preset;
    if (preset === undefined) return;
    state.previewSet = new Set(preset ? preset.split(',') : []);
    state.preview = true;
    renderPreviewSheet();
    recompute();
  });
}

function selectPilot(p: VatsimPilot, fly = true) {
  state.selectedPilot = p.callsign;
  const st = stratumForAltitude(p.altitude);
  if (st !== state.stratum && contains(zmeBoundary, p.longitude, p.latitude)) {
    state.stratum = st;
    view.setStratum(st);
    renderSegment();
    renderBody();
  }
  if (fly) view.map.flyTo({ center: [p.longitude, p.latitude], zoom: Math.max(view.map.getZoom(), 7), padding: padding() });
  recompute();
}

const PRESETS: [string, string][] = [
  ['All combined', '22'],
  ['Combined 2-way', '22,63'],
  ['Combined 3-way', '22,63,46'],
  ['Combined 4-way', '22,63,46,44'],
  ['HI/LO 2-way', '22,63,05,15'],
  ['HI/UH/LO', '22,63,33,20,05,15'],
  ['Clear', ''],
];

function renderPreviewSheet() {
  const sheet = $('#preview-sheet');
  sheet.innerHTML = `
    <div class="sheet-head"><div><h2>Preview</h2><p class="muted small">Switch positions on to see who would own each sector. The map ignores live data until you turn Preview mode off.</p></div>
      <button class="close" data-action="close-preview" aria-label="Close">✕</button></div>
    <label class="switch-row"><span>Preview mode</span><input type="checkbox" class="switch" id="preview-toggle" ${state.preview ? 'checked' : ''}></label>
    <div class="presets">${PRESETS.map(([l, v]) => `<button class="btn" data-preset="${v}">${l}</button>`).join('')}</div>
    ${STRATA.map((s) => `<section class="group"><h3>${STRATUM_INFO[s].label} · ${STRATUM_INFO[s].altitude}</h3><div class="inset">${[...POSITIONS.values()]
      .filter((p) => p.stratum === s)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => `<label class="row switch-row"><span class="row-num">${p.id}</span><div class="row-main"><div>${esc(p.name)}</div><small>${p.callsign} · ${p.freq}</small></div><input type="checkbox" class="switch" data-pos="${p.id}" ${state.previewSet.has(p.id) ? 'checked' : ''}></label>`)
      .join('')}</div></section>`).join('')}`;
}

function togglePreviewSheet(open: boolean) {
  $('#preview-sheet').classList.toggle('open', open);
}

function bindHover() {
  const tip = $('#tooltip');
  let hovered: string | null = null;
  const setHover = (pid: string | null) => {
    if (hovered) view.map.setFeatureState({ source: 'pieces', id: hovered }, { hover: false });
    hovered = pid;
    if (pid) view.map.setFeatureState({ source: 'pieces', id: pid }, { hover: true });
  };
  view.map.on('mousemove', 'pieces-fill', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as Piece;
    setHover(p.pid);
    const s = SECTOR_BY_KEY.get(sectorKey(p.stratum, p.sector))!;
    const owner = state.ownership?.owners.get(p.pid);
    const stacked = SECTORS.find((x) => x.stackedUnder === s.id && x.stratum === s.stratum);
    const stackedOwner = stacked ? state.ownership?.sectorOwners.get(sectorKey(stacked.stratum, stacked.id)) : null;
    tip.innerHTML = `
      <div class="tip-head"><span class="row-num">${s.id}</span><div><div class="tip-title">${esc(s.name)}</div><small>${STRATUM_INFO[s.stratum].label} · ${esc(s.altitude ?? STRATUM_INFO[s.stratum].altitude)} · Area ${s.area}</small></div></div>
      <div class="tip-owner">${swatch(owner)}${owner ? `${esc(ownerCallsign(owner))}` : '<span class="muted">Uncovered</span>'}</div>
      ${stacked ? `<div class="tip-owner small"><span class="muted">${stacked.id} ${esc(stacked.name)} (${esc(stacked.altitude)})</span>&nbsp;${[...(stackedOwner ?? [])].map((id) => `${swatch(id)}${esc(ownerCallsign(id))}`).join(' ') || '<span class="muted">Uncovered</span>'}</div>` : ''}`;
    tip.style.transform = `translate(${e.point.x + 16}px, ${e.point.y + 16}px)`;
    tip.hidden = false;
  });
  view.map.on('mouseleave', 'pieces-fill', () => { tip.hidden = true; setHover(null); });
}

// ─── icons (SF Symbols–style) ────────────────────────────────────────────────
const iconRadar = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`;
const iconMoon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11z"/></svg>`;

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="fatal glass">Failed to start: ${esc(e instanceof Error ? e.message : e)}</div>`);
});

/** HTML for the panel, tooltips and cards. Pure functions of the current view model. */
import type { ColorBook } from '../colors';
import type { NeighborController, NeighborFacility, NeighborOwner, NeighborPiece } from '../neighbors';
import type { Ownership, Piece } from '../ownership';
import { POSITIONS, SECTORS, SECTOR_BY_KEY, STRATA, STRATUM_INFO, sectorKey, type Sector, type Stratum } from '../sectors';
import { exclusiveOf, fmtRange, fmtTime, localZoneName, toInput, type Plan, type Tz } from '../plans';
import type { OnlineController, VatsimPilot } from '../vatsim';
import { icons } from './icons';
import { PALETTE } from '../colors';

export interface ViewModel {
  stratum: Stratum;
  ownership: Ownership;
  pieces: Piece[];
  controllers: OnlineController[];
  colors: ColorBook;
  hasData: boolean;
  neighborsVisible: boolean;
  facilities: NeighborFacility[];
  neighborPieces: NeighborPiece[];
  neighborCtrls: NeighborController[];
  neighborOwners: Map<string, NeighborOwner>;
  /** Live mode: the event in force and live edits, with how many of their assignments apply (position online). */
  plan: { plan: Plan | null; applied: number; liveApplied: number; liveUntil: number | null } | null;
  /** Running and upcoming events (public; the admin-only remark is never sent to visitors). */
  events: Plan[];
  tz: Tz;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function swatch(color: string | null) {
  return `<span class="swatch${color ? '' : ' empty'}" style="${color ? `--c:${color}` : ''}"></span>`;
}

export function ownerCallsign(vm: ViewModel, id: string) {
  const c = vm.controllers.find((x) => x.position === id);
  // Preview positions have no callsign: name the position instead.
  if (c?.preview) return `${id} ${POSITIONS.get(id)?.name ?? ''}`.trim();
  return c?.callsign ?? POSITIONS.get(id)?.callsign ?? `MEM_${id}_CTR`;
}

const duration = (logon: Date) => {
  const mins = Math.max(0, Math.round((Date.now() - logon.getTime()) / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};


// ─── Status ──────────────────────────────────────────────────────────────────
export function renderStatus(vm: ViewModel) {
  const o = vm.ownership;
  const count = (s?: Stratum) =>
    new Set(vm.pieces.filter((p) => !s || p.stratum === s).map((p) => o.owners.get(p.pid)).filter(Boolean)).size;
  let title: string;
  let sub: string;
  if (o.mode === 'offline') {
    title = 'Memphis Center is offline';
    const n = vm.neighborCtrls.length;
    sub = n ? `${n} adjacent controller${n > 1 ? 's' : ''} online` : 'No enroute positions online';
  } else if (o.mode === 'combined') {
    const n = count();
    title = n === 1 ? 'All combined' : `Combined ${n}-way split`;
    sub = 'All altitudes · SOP 3-2-1';
  } else {
    title = 'Stratified split';
    sub = STRATA.map((s) => `${s} ${count(s)}-way`).join(' · ');
  }
  const st = vm.plan;
  const plan = [
    st?.plan && st.applied ? `<div class="status-plan">${icons.calendar}${esc(st.plan.name)} · until ${esc(fmtTime(st.plan.end, 'utc', false))}</div>` : '',
    st?.liveApplied && st.liveUntil ? `<div class="status-plan live-edit">${icons.sliders}Adjusted live · until ${esc(fmtTime(st.liveUntil, 'utc', false))}</div>` : '',
  ].join('');
  return `<div class="status-icon ${o.mode}">${o.mode === 'offline' ? icons.moon : icons.radar}</div>
    <div class="status-text"><div class="status-title">${esc(title)}</div><div class="status-sub">${esc(sub)}</div>${plan}</div>`;
}

// ─── Controllers tab ─────────────────────────────────────────────────────────
function sectorChip(key: string) {
  const s = SECTOR_BY_KEY.get(key);
  return s ? `<span class="chip"><b>${s.id}</b>${esc(s.name)}</span>` : '';
}

export function renderControllers(vm: ViewModel) {
  if (!vm.controllers.length)
    return `<div class="empty-state">${icons.moon}<p>No Memphis Center positions are online.<br>Use Preview to see how ZME would be split.</p><button class="btn tinted" data-action="open-preview">Open Preview</button></div>`;
  return `<div class="list">${vm.controllers
    .map((c) => {
      const pos = POSITIONS.get(c.position);
      const keys = vm.ownership.positionSectors.get(c.position) ?? [];
      const byStratum = STRATA.map((s) => {
        const ks = keys.filter((k) => k.startsWith(`${s}-`));
        return ks.length ? `<div class="strat-row"><span class="strat-tag">${s}</span><div class="chips">${ks.map(sectorChip).join('')}</div></div>` : '';
      }).join('');
      return `<article class="ctrl" style="--c:${vm.colors.get(c.position)}">
        <div class="ctrl-head">
          <span class="ctrl-badge">${c.position}</span>
          <div class="ctrl-id"><div class="ctrl-callsign">${esc(c.callsign)}</div><div class="ctrl-name">${c.preview ? 'Preview' : `${esc(pos?.name ?? '')} · ${esc(c.name)}`}${c.rating ? ` · ${esc(c.rating)}` : ''}</div></div>
          <div class="ctrl-freq"><div>${esc(c.frequency)}</div><small>${c.preview ? esc(c.name) : duration(c.logon)}</small></div>
        </div>
        ${byStratum || '<div class="muted small" style="padding-top:6px">No airspace</div>'}
      </article>`;
    })
    .join('')}</div>`;
}

// ─── Events tab (public) ─────────────────────────────────────────────────────
export function renderEvents(vm: ViewModel) {
  const now = Date.now();
  const tzSwitchPublic = `<div class="segmented small tz" style="--i:${vm.tz === 'utc' ? 0 : 1};margin:0 0 10px" role="tablist" aria-label="Time zone">
      <span class="thumb"></span>
      <button role="tab" data-tz="utc" aria-selected="${vm.tz === 'utc'}">UTC</button>
      <button role="tab" data-tz="local" aria-selected="${vm.tz === 'local'}">Local · ${esc(localZoneName())}</button></div>`;
  if (!vm.events.length) return `${tzSwitchPublic}<div class="empty-state">${icons.calendar}<p>No events planned.</p></div>`;
  const cards = [...vm.events]
    .sort((a, b) => a.start - b.start)
    .map((p) => {
      const active = p.start <= now && now < p.end;
      const picked = exclusiveOf(p.assign);
      const rows = p.positions
        .map((id) => {
          const pos = POSITIONS.get(id);
          const ks = p.assign.filter(([, v]) => v === id).map(([k]) => k);
          const cover = picked.has(id)
            ? STRATA.map((st) => {
                const xs = ks.filter((k) => k.startsWith(`${st}-`));
                return xs.length ? `<div class="strat-row"><span class="strat-tag">${st}</span><div class="chips">${xs.map(sectorChip).join('')}</div></div>` : '';
              }).join('')
            : '<small class="muted">Auto (SOP)</small>';
          const note = p.notes?.[id];
          return `<div class="ev-pos"><span class="ctrl-badge" style="--c:${vm.colors.get(id) ?? 'var(--grey)'}">${id}</span>
            <div class="ev-pos-main"><div><b>${esc(pos?.name ?? '')}</b> <small class="muted">${esc(pos?.callsign ?? '')} · ${esc(pos?.freq ?? '')}</small></div>
              ${note ? `<div class="ev-note">${esc(note)}</div>` : ''}${cover}</div></div>`;
        })
        .join('');
      return `<article class="plan${active ? ' active' : ''}">
        <div class="plan-name">${esc(p.name)}${active ? '<span class="tag on">Now</span>' : ''}</div>
        <div class="plan-time"><div>${esc(fmtRange(p.start, p.end, vm.tz))}</div><small class="muted">${esc(fmtRange(p.start, p.end, vm.tz === 'utc' ? 'local' : 'utc'))}</small></div>
        ${p.remark ? `<div class="ev-remark">${icons.lock}<span>${esc(p.remark)}</span></div>` : ''}
        <div class="ev-positions">${rows}</div>
        <div class="plan-foot"><small class="muted">${p.positions.length} position${p.positions.length === 1 ? '' : 's'} expected</small><button class="btn" data-event-preview="${p.id}">Preview</button></div>
      </article>`;
    })
    .join('');
  return `${tzSwitchPublic}<p class="muted small" style="margin:0 4px 10px">Planned splits. An event only applies to its positions that are really logged on to VATSIM.</p><div class="list">${cards}</div>`;
}

// ─── Sectors tab ─────────────────────────────────────────────────────────────
export function renderSectors(vm: ViewModel) {
  return [1, 2, 3, 4, 5, 6]
    .map((area) => {
      const rows = SECTORS.filter((s) => s.stratum === vm.stratum && s.area === area)
        .map((s) => {
          const owners = [...(vm.ownership.sectorOwners.get(sectorKey(s.stratum, s.id)) ?? [])];
          const ownerHtml = owners.length
            ? owners.map((id) => `<span class="owner">${swatch(vm.colors.get(id))}${esc(ownerCallsign(vm, id))}</span>`).join('')
            : `<span class="owner muted">${swatch(null)}Uncovered</span>`;
          return `<div class="row"><span class="row-num">${s.id}</span><div class="row-main"><div>${esc(s.name)}</div><small>${esc(s.altitude ?? STRATUM_INFO[s.stratum].altitude)}${s.freqs[0] ? ` · ${s.freqs[0]}` : ''}</small></div><div class="row-owner">${ownerHtml}</div></div>`;
        })
        .join('');
      return rows ? `<section class="group"><h3>Area ${area}</h3><div class="inset">${rows}</div></section>` : '';
    })
    .join('');
}

// ─── Neighbors tab ───────────────────────────────────────────────────────────
export function renderNeighbors(vm: ViewModel) {
  const toggle = `<section class="group"><div class="inset"><label class="row switch-row"><div class="row-main"><div>Show adjacent sectors</div><small>Sector lines from the ZME video maps</small></div><input type="checkbox" class="switch" data-toggle="neighbors" ${vm.neighborsVisible ? 'checked' : ''}></label></div></section>`;
  if (!vm.hasData) return `${toggle}<div class="empty-state"><p>Waiting for VATSIM data…</p></div>`;
  const groups = vm.facilities.map((f) => {
    const online = vm.neighborCtrls.filter((c) => c.facility === f.id);
    const covered = (key: string) => vm.neighborPieces.filter((p) => p.stratum === vm.stratum && vm.neighborOwners.get(p.nid)?.owner === key).length;
    const rows = online.length
      ? online
          .map((c) => {
            const pos = c.position && f.sectorNames?.[c.position];
            const n = covered(c.key);
            return `<div class="row"><span class="swatch" style="--c:${vm.colors.get(c.key)}"></span><div class="row-main"><div class="ctrl-callsign">${esc(c.callsign)}</div><small>${esc(c.name)}${c.rating ? ` · ${esc(c.rating)}` : ''}${pos ? ` · ${esc(pos)}` : ''}</small></div><div class="ctrl-freq"><div>${esc(c.frequency)}</div><small>${n ? `${n} near ZME` : duration(c.logon)}</small></div></div>`;
          })
          .join('')
      : `<div class="row"><span class="dot"></span><div class="row-main muted">Offline</div></div>`;
    return `<section class="group"><h3>${f.id} · ${esc(f.name)}${online.length ? `<span class="count">${online.length} online</span>` : ''}</h3><div class="inset">${rows}</div></section>`;
  });
  // Online facilities first.
  const order = vm.facilities.map((f, i) => [vm.neighborCtrls.some((c) => c.facility === f.id) ? 0 : 1, i]);
  const sorted = order.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => groups[i]);
  return toggle + sorted.join('');
}

// ─── Tooltips ────────────────────────────────────────────────────────────────
export function zmeTooltip(vm: ViewModel, p: Piece) {
  const s = SECTOR_BY_KEY.get(sectorKey(p.stratum, p.sector))!;
  const owner = vm.ownership.owners.get(p.pid);
  const stacked = SECTORS.find((x) => x.stackedUnder === s.id && x.stratum === s.stratum);
  const stackedOwners = stacked ? [...(vm.ownership.sectorOwners.get(sectorKey(stacked.stratum, stacked.id)) ?? [])] : [];
  return `
    <div class="tip-head"><span class="row-num">${s.id}</span><div><div class="tip-title">${esc(s.name)}</div><small>${STRATUM_INFO[s.stratum].label} · ${esc(s.altitude ?? STRATUM_INFO[s.stratum].altitude)} · Area ${s.area}</small></div></div>
    <div class="tip-owner">${swatch(vm.colors.get(owner))}${owner ? esc(ownerCallsign(vm, owner)) : '<span class="muted">Uncovered</span>'}</div>
    ${stacked ? stackedLine(vm, stacked, stackedOwners) : ''}`;
}

const stackedLine = (vm: ViewModel, s: Sector, owners: string[]) =>
  `<div class="tip-owner small"><span class="muted">${s.id} ${esc(s.name)} (${esc(s.altitude)})</span>&nbsp;${owners.map((id) => `${swatch(vm.colors.get(id))}${esc(ownerCallsign(vm, id))}`).join(' ') || '<span class="muted">Uncovered</span>'}</div>`;

export function neighborTooltip(vm: ViewModel, p: NeighborPiece) {
  const f = vm.facilities.find((x) => x.id === p.artcc);
  const o = vm.neighborOwners.get(p.nid);
  const ctrl = vm.neighborCtrls.find((c) => c.key === o?.owner);
  const others = vm.neighborCtrls.filter((c) => c.facility === p.artcc && c.key !== o?.owner);
  return `
    <div class="tip-head"><span class="row-num">${p.artcc}</span><div><div class="tip-title">${esc(p.name ?? f?.name ?? p.artcc)}</div><small>${esc(f?.name ?? '')} Center · ${STRATUM_INFO[p.stratum].label}</small></div></div>
    <div class="tip-owner">${swatch(vm.colors.get(o?.owner))}${ctrl ? `${esc(ctrl.callsign)} ${esc(ctrl.frequency)}${o?.approx ? '<span class="tag">approx.</span>' : ''}` : '<span class="muted">Offline</span>'}</div>
    ${o?.approx && others.length ? `<div class="tip-owner small muted">Also online: ${others.map((c) => esc(c.callsign)).join(', ')}</div>` : ''}`;
}

// ─── Aircraft card ───────────────────────────────────────────────────────────
export interface AircraftHit {
  kind: 'zme' | 'neighbor';
  sector: string;
  owner: string | null;
  ownerColor: string | null;
  callsign: string | null;
  frequency: string | null;
  sub: string;
  approx?: boolean;
}

export function renderAircraftCard(p: VatsimPilot, hit: AircraftHit | null) {
  const fp = p.flight_plan;
  const contact = !hit
    ? `<div class="contact muted">Outside ZME and its neighbours' sectors</div>`
    : hit.owner
      ? `<div class="contact" style="--c:${hit.ownerColor}"><span class="ctrl-badge">${esc(hit.owner)}</span><div><div class="ctrl-callsign">${esc(hit.callsign)}</div><div class="ctrl-name">${esc(hit.sub)}${hit.approx ? ' · approx.' : ''}</div></div><div class="ctrl-freq">${esc(hit.frequency)}</div></div>`
      : `<div class="contact muted">Uncovered · monitor UNICOM 122.800</div>`;
  return `
    <button class="close" data-action="close-aircraft" aria-label="Close">${icons.close}</button>
    <div class="ac-callsign">${esc(p.callsign)}</div>
    <div class="ac-route">${esc(fp?.departure || '----')} → ${esc(fp?.arrival || '----')}${fp?.aircraft_short ? ` · ${esc(fp.aircraft_short)}` : ''}</div>
    <div class="ac-stats"><div><small>Altitude</small>${p.altitude.toLocaleString()} ft</div><div><small>Ground speed</small>${p.groundspeed} kt</div><div><small>Sector</small>${hit ? esc(hit.sector) : '—'}</div></div>
    <div class="ac-label">Contact</div>${contact}`;
}

// ─── Preview sheet ───────────────────────────────────────────────────────────
export const PRESETS: [string, string][] = [
  ['All combined', '22'],
  ['Combined 2-way', '22,63'],
  ['Combined 3-way', '22,63,46'],
  ['Combined 4-way', '22,63,46,44'],
  ['HI/LO 2-way', '22,63,05,15'],
  ['HI/UH/LO', '22,63,33,20,05,15'],
  ['Clear', ''],
];

// ─── Sector assignments (preview + plan editor) ───────────────────────────────────
export interface AssignOpts {
  stratum: Stratum;
  /** Positions that can be picked (online in this mode). */
  online: string[];
  assign: Map<string, string>;
  /** Current owner of each sector key (after assignments). */
  ownership: Ownership;
  colors: ColorBook;
  /** Attribute that marks the <select>s: data-assign (preview) or data-plan-assign. */
  attr: 'assign' | 'plan-assign' | 'live-assign';
  busy?: boolean;
  /** Sector keys ticked for a bulk assignment. */
  selected?: Set<string>;
}

// ─── Search + multi-select helpers ────────────────────────────────────────────
/**
 * Search box for the items with data-ft inside the nearest [data-filter-scope]. Filtering is done in place
 * by main.ts (applyFilters), so typing never re-renders and keeps focus.
 */
export const filterBox = (scope: string, placeholder = 'Search by number or name, e.g. 22 63, LO, Memphis') =>
  `<div class="filter-box">${icons.search}<input type="search" class="filter-input" data-filter="${scope}" placeholder="${esc(placeholder)}" aria-label="Search" autocomplete="off" spellcheck="false"></div>`;
/** Text an item is searched by. */
const ft = (stratum: string, id: string, name: string, extra = '') => `data-ft="${esc(`${stratum} ${id} ${name} ${extra}`.toLowerCase())}"`;
/** "Tick all shown / untick all shown" for a group of range-selectable checkboxes. */
const bulkBtns = (group: string, on: string, off: string, busy?: boolean) =>
  `<button type="button" class="btn" data-bulk-on="${group}" ${busy ? 'disabled' : ''}>${on}</button><button type="button" class="btn" data-bulk-off="${group}" ${busy ? 'disabled' : ''}>${off}</button>`;
const RANGE_HINT = '<small class="muted range-hint">Shift-click ticks a range, like selecting files.</small>';

export function renderAssign(o: AssignOpts) {
  const options = (key: string) => {
    const cur = o.assign.get(key);
    const ids = [...o.online];
    if (cur && !ids.includes(cur)) ids.push(cur);
    return `<option value="">Auto (SOP)</option>${ids
      .sort()
      .map((id) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${id} ${esc(POSITIONS.get(id)?.name ?? '')}${o.online.includes(id) ? '' : ' (offline)'}</option>`)
      .join('')}`;
  };
  const enabled = o.online.length && !o.busy;
  const sel = [...(o.selected ?? [])].filter((k) => k.startsWith(`${o.stratum}-`));
  const rows = SECTORS.filter((s) => s.stratum === o.stratum)
    .map((s) => {
      const key = sectorKey(s.stratum, s.id);
      const owners = [...(o.ownership.sectorOwners.get(key) ?? [])];
      const manual = o.assign.has(key);
      return `<div class="row${sel.includes(key) ? ' picked' : ''}" ${ft(s.stratum, s.id, s.name, s.freqs.join(' '))}>
        <label class="row-sel" title="Select (Shift-click for a range)"><input type="checkbox" data-sel="${key}" data-range="sel" ${sel.includes(key) ? 'checked' : ''} ${enabled ? '' : 'disabled'} aria-label="Select ${s.id} ${esc(s.name)}"></label>
        <span class="row-num" style="${owners[0] ? `background:color-mix(in srgb, ${o.colors.get(owners[0])} 30%, transparent)` : ''}">${s.id}</span>
        <div class="row-main"><div>${esc(s.name)}${manual ? '<span class="tag">manual</span>' : ''}</div><small>${owners.length ? owners.map((id) => esc(ownerShort(id))).join(', ') : 'Uncovered'}</small></div>
        <select class="assign-select" data-${o.attr}="${key}" aria-label="Who works ${s.id} ${esc(s.name)}" ${enabled ? '' : 'disabled'}>${options(key)}</select></div>`;
    })
    .join('');
  const bulkOptions = `<option value="-" selected disabled>Assign ${sel.length} to…</option><option value="">Auto (SOP)</option>${[...o.online]
    .sort()
    .map((id) => `<option value="${id}">${id} ${esc(POSITIONS.get(id)?.name ?? '')}</option>`)
    .join('')}`;
  const bulk = sel.length
    ? `<div class="bulk-bar"><span><b>${sel.length}</b> selected</span><select class="assign-select" data-bulk-assign aria-label="Assign the selected sectors" ${enabled ? '' : 'disabled'}>${bulkOptions}</select><button type="button" class="btn" data-sel-clear>Clear</button></div>`
    : '';
  const n = [...o.assign.keys()].length;
  return `<section class="group" data-filter-scope="assign"><h3>Sector assignments · ${STRATUM_INFO[o.stratum].label}${n ? `<span class="count">${n} manual</span>` : ''}</h3>
    <p class="muted small" style="margin:0 4px 8px">${{
      'plan-assign': 'Hand a sector to any expected position. It only applies while that position is really online. Switch the stratum at the top of the map.',
      'live-assign': 'Applies right now, on top of any running event. Only positions online on VATSIM can be picked. Switch the stratum at the top of the map; on a computer you can also click a sector on the map.',
      assign: 'Hand a sector to any position you switched on. Switch the stratum at the top of the map; on a computer you can also click a sector on the map.',
    }[o.attr]} Tick several sectors to hand them over at once.</p>
    ${filterBox('assign')}
    <div class="presets filter-actions">${bulkBtns('sel', 'Select shown', 'Deselect shown', !enabled)}${RANGE_HINT}</div>
    ${bulk}
    <div class="inset">${rows}<div class="empty-state filter-empty" hidden><p>No matching sectors.</p></div></div>
    ${n ? `<div class="presets"><button class="btn" data-${o.attr}-reset ${o.busy ? 'disabled' : ''}>Reset all to SOP</button></div>` : ''}</section>`;
}

const ownerShort = (id: string) => `${id} ${POSITIONS.get(id)?.name ?? ''}`.trim();

/** Floating menu shown when a sector is clicked on the map while editing. */
export function renderAssignMenu(key: string, online: string[], assign: Map<string, string>, colors: ColorBook) {
  const s = SECTOR_BY_KEY.get(key)!;
  const cur = assign.get(key) ?? '';
  const item = (id: string, label: string, color: string | null) =>
    `<button class="menu-item${id === cur ? ' on' : ''}" data-menu-assign="${id}">${swatch(color)}<span>${label}</span></button>`;
  return `<div class="menu-head"><span class="row-num">${s.id}</span><div><div class="tip-title">${esc(s.name)}</div><small class="muted">${STRATUM_INFO[s.stratum].label} · who works it?</small></div></div>
    ${item('', 'Auto (SOP)', null)}
    ${online.map((id) => item(id, `<b>${id}</b> ${esc(POSITIONS.get(id)?.name ?? '')}`, colors.get(id))).join('')}`;
}

export function renderPreview(preview: boolean, selected: Set<string>, assign: AssignOpts) {
  return `
    <label class="switch-row card-row"><span>Preview mode</span><input type="checkbox" class="switch" id="preview-toggle" ${preview ? 'checked' : ''}></label>
    <p class="muted small" style="margin:8px 4px 0">Only on this device: nothing here is shared, and it is kept for your next visit. Link: <a href="#preview">#preview</a></p>
    <div class="presets">${PRESETS.map(([l, v]) => `<button class="btn" data-preset="${v}">${l}</button>`).join('')}</div>
    ${selected.size ? renderAssign(assign) : ''}
    <div data-filter-scope="positions">
    <section class="group"><h3>Positions${selected.size ? `<span class="count">${selected.size} on</span>` : ''}</h3>
      ${filterBox('positions')}
      <div class="presets filter-actions">${bulkBtns('pos', 'Switch on shown', 'Switch off shown')}${RANGE_HINT}</div></section>
    ${STRATA.map((s) => `<section class="group" data-fgroup><h3>${STRATUM_INFO[s].label} · ${STRATUM_INFO[s].altitude}</h3><div class="inset">${[...POSITIONS.values()]
      .filter((p) => p.stratum === s)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => `<label class="row switch-row" ${ft(p.stratum, p.id, p.name, `${p.callsign} ${p.freq}`)}><span class="row-num">${p.id}</span><div class="row-main"><div>${esc(p.name)}</div><small>${p.callsign} · ${p.freq}</small></div><input type="checkbox" class="switch" data-pos="${p.id}" data-range="pos" ${selected.has(p.id) ? 'checked' : ''}></label>`)
      .join('')}</div></section>`).join('')}
    <div class="empty-state filter-empty" hidden><p>No matching positions.</p></div></div>
    <div style="height:calc(24px + var(--safe-bottom))"></div>`;
}

// ─── Planned splits (admin only) ─────────────────────────────────────────────
export function renderLogin(busy: boolean, error: string | null) {
  return `<form id="plan-login" class="manual-login" autocomplete="off">
      <input type="password" id="plan-token" placeholder="Access token" aria-label="Access token" autocomplete="off" spellcheck="false" />
      <button class="btn tinted" type="submit" ${busy ? 'disabled' : ''}>Sign in</button>
      ${error ? `<p class="form-error">${esc(error)}</p>` : ''}</form>`;
}

const tzSwitch = (tz: Tz) => `<div class="segmented small tz" style="--i:${tz === 'utc' ? 0 : 1}" role="tablist" aria-label="Time zone">
    <span class="thumb"></span>
    <button role="tab" data-tz="utc" aria-selected="${tz === 'utc'}">UTC</button>
    <button role="tab" data-tz="local" aria-selected="${tz === 'local'}">Local · ${esc(localZoneName())}</button>
  </div>`;

const other = (tz: Tz): Tz => (tz === 'utc' ? 'local' : 'utc');

export interface LiveInfo {
  /** Positions online on VATSIM. */
  online: string[];
  event: Plan | null;
  edits: number;
  expires: number | null;
}

export function renderPlanList(opts: { plans: Plan[]; tz: Tz; busy: boolean; error: string | null; now: number; live: LiveInfo }) {
  const err = opts.error ? `<p class="form-error">${esc(opts.error)}</p>` : '';
  const l = opts.live;
  const liveCard = `<article class="plan live-card">
      <div class="plan-time"><div>Live now</div><small class="muted">Online on VATSIM: ${l.online.length ? l.online.map((id) => `<b>${id}</b>`).join(' ') : 'nobody'}</small></div>
      <small class="muted">${l.event ? `Event running: <b>${esc(l.event.name)}</b>` : 'No event running'} · ${l.edits ? `${l.edits} live edit${l.edits > 1 ? 's' : ''}, until ${esc(fmtTime(l.expires!, opts.tz, false))}` : 'no live edits'}</small>
      <div class="plan-foot"><small class="muted">Live edits win over the event.</small><button class="btn tinted" data-live-open ${opts.busy ? 'disabled' : ''}>Edit live</button></div>
    </article>`;
  const cards = [...opts.plans]
    .sort((a, b) => a.start - b.start)
    .map((p) => {
      const active = p.start <= opts.now && opts.now < p.end;
      const chips = p.positions.map((id) => {
        const n = p.assign.filter(([, v]) => v === id).length;
        return `<span class="chip"><b>${id}</b>${esc(POSITIONS.get(id)?.name ?? '')}<span class="muted">· ${n ? `${n} sector${n > 1 ? 's' : ''}` : 'Auto'}</span></span>`;
      }).join('');
      const notes = Object.entries(p.notes ?? {}).filter(([, v]) => v);
      return `<article class="plan${active ? ' active' : ''}">
        <div class="plan-name">${esc(p.name)}${active ? '<span class="tag on">Now</span>' : ''}</div>
        <div class="plan-time"><div>${esc(fmtRange(p.start, p.end, opts.tz))}</div>
          <small class="muted">${esc(fmtRange(p.start, p.end, other(opts.tz)))}</small></div>
        <div class="chips">${chips || '<span class="muted small">No positions</span>'}</div>
        ${p.remark ? `<div class="ev-remark">${icons.lock}<span>${esc(p.remark)}</span></div>` : ''}
        ${notes.length ? `<ul class="plan-notes">${notes.map(([id, v]) => `<li><b>${id}</b> ${esc(v)}</li>`).join('')}</ul>` : ''}
        <div class="plan-foot"><small class="muted">${p.assign.length ? 'Sectors picked by hand' : 'All Auto (SOP)'}</small>
          <span class="plan-btns"><button class="btn" data-plan-preview="${p.id}">Preview</button><button class="btn" data-plan-edit="${p.id}" ${opts.busy ? 'disabled' : ''}>Edit</button><button class="btn danger" data-plan-delete="${p.id}" ${opts.busy ? 'disabled' : ''}>Delete</button></span></div>
      </article>`;
    })
    .join('');
  return `${err}
    ${tzSwitch(opts.tz)}
    <div class="list">${liveCard}</div>
    <section class="group"><h3>Events<span class="count">${opts.plans.length}</span></h3>
      <p class="muted small" style="margin:0 4px 8px">Say ahead of time which positions are expected and who covers which sector. VATSIM decides who is online: an event only applies to its positions that are really logged on.</p>
      <div class="presets" style="margin-top:0"><button class="btn tinted" data-plan-new ${opts.busy ? 'disabled' : ''}>New event</button><a class="btn" href="./admin.html" target="_blank" rel="noopener">Open admin panel</a><button class="btn" data-plan-signout>Sign out</button></div>
      <div class="list">${cards || '<div class="empty-state"><p>No events planned.</p></div>'}</div></section>
    <div style="height:calc(24px + var(--safe-bottom))"></div>`;
}

export function renderLiveEditor(opts: { hours: number; hoursOptions: number[]; expires: number | null; tz: Tz; busy: boolean; error: string | null; assign: AssignOpts }) {
  const err = opts.error ? `<p class="form-error">${esc(opts.error)}</p>` : '';
  const none = !opts.assign.online.length;
  return `${err}
    <p class="muted small" style="margin:4px 4px 0">Who covers which sector right now. Saved immediately and shown to everyone; wins over a running event. Who is online always comes from VATSIM.</p>
    <label class="switch-row card-row" style="margin-top:12px"><span>Keep live edits for</span>
      <select id="live-hours">${opts.hoursOptions.map((h) => `<option value="${h}" ${h === opts.hours ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select></label>
    ${opts.expires ? `<p class="muted small" style="margin:6px 4px 0">Current live edits end at ${esc(fmtTime(opts.expires, opts.tz))} (${esc(fmtTime(opts.expires, other(opts.tz)))}).</p>` : ''}
    <div class="presets"><button class="btn" data-live-done>‹ Back to events</button><button class="btn danger" data-live-clear ${opts.assign.assign.size && !opts.busy ? '' : 'disabled'}>Clear live edits</button></div>
    ${none ? '<div class="empty-state"><p>No Memphis Center positions are online on VATSIM.</p></div>' : renderAssign(opts.assign)}
    <div style="height:calc(24px + var(--safe-bottom))"></div>`;
}

export interface Draft {
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

/** One card per expected position: note, Auto vs picked sectors, and what it ends up working. */
function coverCard(d: Draft, id: string, i: number, own: Ownership) {
  const pos = POSITIONS.get(id);
  const pick = d.explicit.has(id);
  const sectorPicker = STRATA.map((st) => {
    const chips = SECTORS.filter((x) => x.stratum === st)
      .map((x) => {
        const key = sectorKey(st, x.id);
        const holder = d.assign.get(key);
        const other = holder && holder !== id ? `<small>→ ${holder}</small>` : '';
        return `<label class="pos-chip sec" ${ft(st, x.id, x.name, x.freqs.join(' '))}><input type="checkbox" data-cover-pos="${id}" data-cover-sector="${key}" data-range="cover-${id}" ${holder === id ? 'checked' : ''}><b>${x.id}</b> ${esc(x.name)}${other}</label>`;
      })
      .join('');
    return `<div class="strat-row" data-fgroup><span class="strat-tag">${st}</span><div class="chips">${chips}</div></div>`;
  }).join('');
  const picker = `<div class="cover-pick" data-filter-scope="cover-${id}">
      ${filterBox(`cover-${id}`)}
      <div class="presets filter-actions">${bulkBtns(`cover-${id}`, 'Pick shown', 'Unpick shown')}${RANGE_HINT}</div>
      ${sectorPicker}<p class="muted small filter-empty" hidden>No matching sectors.</p></div>`;
  const works = own.positionSectors.get(id) ?? [];
  const result = STRATA.map((st) => {
    const ks = works.filter((k) => k.startsWith(`${st}-`));
    return ks.length ? `<div class="strat-row"><span class="strat-tag">${st}</span><div class="chips">${ks.map(sectorChip).join('')}</div></div>` : '';
  }).join('');
  return `<article class="ctrl cover-card" style="--c:${PALETTE[i % PALETTE.length]}">
      <div class="ctrl-head"><span class="ctrl-badge">${id}</span>
        <div class="ctrl-id"><div class="cover-name">${esc(pos?.name ?? '')}</div><div class="ctrl-name">${esc(pos?.callsign ?? '')} · ${esc(pos?.freq ?? '')}</div></div></div>
      <input class="note-input" data-plan-note="${id}" maxlength="120" placeholder="Note (optional, public: everyone sees it)" value="${esc(d.notes.get(id) ?? '')}">
      <div class="segmented small cover-mode" style="--n:2; --i:${pick ? 1 : 0}">
        <span class="thumb"></span>
        <button type="button" data-cover-mode="${id}" data-mode="auto" aria-selected="${!pick}">Auto (SOP)</button>
        <button type="button" data-cover-mode="${id}" data-mode="pick" aria-selected="${pick}">Pick sectors</button>
      </div>
      ${pick ? picker : ''}
      <div class="cover-result"><small class="muted">${pick ? 'Covers exactly' : 'SOP gives it'}${works.length ? '' : ': nothing'}</small>${result}</div>
    </article>`;
}

export function renderPlanEditor(opts: { draft: Draft; tz: Tz; busy: boolean; error: string | null; ownership: Ownership }) {
  const d = opts.draft;
  const err = opts.error ? `<p class="form-error">${esc(opts.error)}</p>` : '';
  const field = (id: string, label: string, ms: number) => `<label class="time-row card-row"><span>${label}</span>
      <input type="datetime-local" id="${id}" value="${Number.isFinite(ms) ? toInput(ms, opts.tz) : ''}">
      <small class="muted" id="${id}-other">${Number.isFinite(ms) ? esc(fmtTime(ms, other(opts.tz))) : ''}</small></label>`;
  const posGroups = `<div data-filter-scope="plan-pos">${filterBox('plan-pos')}
    <div class="presets filter-actions">${bulkBtns('plan-pos', 'Pick shown', 'Unpick shown')}${RANGE_HINT}</div>
    ${STRATA.map((s) => `<section class="group" data-fgroup><h3>${STRATUM_INFO[s].label}</h3><div class="pos-grid">${[...POSITIONS.values()]
    .filter((p) => p.stratum === s)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `<label class="pos-chip" ${ft(p.stratum, p.id, p.name, `${p.callsign} ${p.freq}`)}><input type="checkbox" data-plan-pos="${p.id}" data-range="plan-pos" ${d.positions.has(p.id) ? 'checked' : ''}><b>${p.id}</b> ${esc(p.name)}</label>`)
    .join('')}</div></section>`).join('')}
    <p class="muted small filter-empty" hidden>No matching positions.</p></div>`;
  const cards = [...d.positions].sort().map((id, i) => coverCard(d, id, i, opts.ownership)).join('');
  const uncovered = SECTORS.filter((x) => !opts.ownership.sectorOwners.get(sectorKey(x.stratum, x.id))?.size).map((x) => `${x.stratum} ${x.id}`);
  return `${err}
    <label class="name-row card-row"><span>Name <span class="vis public">Public</span></span><input id="plan-name" maxlength="60" placeholder="e.g. Memphis FNO" value="${esc(d.name)}"></label>
    <label class="remark-row card-row"><span>Remark <span class="vis private">${icons.lock}Private</span></span><textarea id="plan-remark" maxlength="1000" rows="2" placeholder="Only admins see this. It is never shown on the public map.">${esc(d.remark)}</textarea></label>
    ${tzSwitch(opts.tz)}
    <div class="time-fields">${field('plan-start', 'Start', d.start)}${field('plan-end', 'End', d.end)}</div>
    <section class="group"><h3>Expected positions</h3>
      <div class="presets" style="margin-top:0">${PRESETS.filter(([, v]) => v).map(([l, v]) => `<button class="btn" data-plan-preset="${v}">${l}</button>`).join('')}</div></section>
    ${posGroups}
    ${cards ? `<section class="group"><h3>Who covers what</h3>
      <p class="muted small" style="margin:0 4px 8px">For each position choose Auto (the SOP split among the Auto positions) or pick its sectors: it then covers exactly those. Only applies while the position is really online.</p>
      <div class="list">${cards}</div>
      ${uncovered.length && d.positions.size ? `<p class="form-error">Uncovered: ${esc(uncovered.join(', '))}</p>` : ''}</section>` : ''}
    <div class="presets sticky-actions"><button class="btn tinted" data-plan-save ${opts.busy ? 'disabled' : ''}>Save event</button><button class="btn" data-plan-cancel>Cancel</button></div>
    <div style="height:calc(24px + var(--safe-bottom))"></div>`;
}

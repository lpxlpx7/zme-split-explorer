/** HTML for the panel, tooltips and cards. Pure functions of the current view model. */
import type { ColorBook } from '../colors';
import type { NeighborController, NeighborFacility, NeighborOwner, NeighborPiece } from '../neighbors';
import type { Ownership, Piece } from '../ownership';
import { POSITIONS, SECTORS, SECTOR_BY_KEY, STRATA, STRATUM_INFO, sectorKey, type Sector, type Stratum } from '../sectors';
import type { OnlineController, VatsimPilot } from '../vatsim';
import { icons } from './icons';

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
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function swatch(color: string | null) {
  return `<span class="swatch${color ? '' : ' empty'}" style="${color ? `--c:${color}` : ''}"></span>`;
}

export function ownerCallsign(vm: ViewModel, id: string) {
  return vm.controllers.find((c) => c.position === id)?.callsign ?? POSITIONS.get(id)?.callsign ?? `MEM_${id}_CTR`;
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
  return `<div class="status-icon ${o.mode}">${o.mode === 'offline' ? icons.moon : icons.radar}</div>
    <div class="status-text"><div class="status-title">${esc(title)}</div><div class="status-sub">${esc(sub)}</div></div>`;
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
          <div class="ctrl-id"><div class="ctrl-callsign">${esc(c.callsign)}</div><div class="ctrl-name">${esc(pos?.name ?? '')} · ${esc(c.preview ? 'Preview' : c.name)}${c.rating ? ` · ${esc(c.rating)}` : ''}</div></div>
          <div class="ctrl-freq"><div>${esc(c.frequency)}</div><small>${c.preview ? 'Preview' : duration(c.logon)}</small></div>
        </div>
        ${byStratum || '<div class="muted small" style="padding-top:6px">No airspace</div>'}
      </article>`;
    })
    .join('')}</div>`;
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

export function renderPreview(preview: boolean, selected: Set<string>) {
  return `
    <label class="switch-row card-row"><span>Preview mode</span><input type="checkbox" class="switch" id="preview-toggle" ${preview ? 'checked' : ''}></label>
    <div class="presets">${PRESETS.map(([l, v]) => `<button class="btn" data-preset="${v}">${l}</button>`).join('')}</div>
    ${STRATA.map((s) => `<section class="group"><h3>${STRATUM_INFO[s].label} · ${STRATUM_INFO[s].altitude}</h3><div class="inset">${[...POSITIONS.values()]
      .filter((p) => p.stratum === s)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => `<label class="row switch-row"><span class="row-num">${p.id}</span><div class="row-main"><div>${esc(p.name)}</div><small>${p.callsign} · ${p.freq}</small></div><input type="checkbox" class="switch" data-pos="${p.id}" ${selected.has(p.id) ? 'checked' : ''}></label>`)
      .join('')}</div></section>`).join('')}
    <div style="height:calc(24px + var(--safe-bottom))"></div>`;
}

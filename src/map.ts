import * as maplibregl from 'maplibre-gl';
import type { FilterSpecification, GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Stratum } from './sectors';

// MapLibre locates its worker relative to import.meta.url, which breaks once Vite
// pre-bundles / bundles the library. Point it at the emitted asset explicitly.
maplibregl.setWorkerUrl(workerUrl);

const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const FONT = ['Montserrat SemiBold', 'Open Sans Bold', 'Noto Sans Regular'];

export interface MapData {
  pieces: GeoJSON.FeatureCollection;
  sectors: GeoJSON.FeatureCollection;
  labels: GeoJSON.FeatureCollection;
  boundary: GeoJSON.FeatureCollection;
  neighbors: GeoJSON.FeatureCollection;
  artccs: GeoJSON.FeatureCollection;
}

export interface MapView {
  map: MLMap;
  setStratum(s: Stratum): void;
  setPieceColors(colors: Map<string, string | null>): void;
  setNeighborColors(colors: Map<string, string | null>): void;
  setNeighborsVisible(v: boolean): void;
  setAircraft(fc: GeoJSON.FeatureCollection): void;
  /** Points with stratum/id/name/freq: who works each block of airspace, always on screen. */
  setOwnerLabels(fc: GeoJSON.FeatureCollection): void;
  setTheme(dark: boolean): void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** SDF airplane glyph so the icon can be tinted per owner. */
function planeImage(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.scale(size / 24, size / 24);
  g.translate(-12, -12);
  g.fillStyle = '#fff';
  g.fill(new Path2D('M12 1.5c.9 0 1.5 1.1 1.5 2.4v5.3l8 4.6v2.1l-8-2.4v4.7l2.4 1.8v1.7L12 20.6l-3.9 1.1V20l2.4-1.8v-4.7l-8 2.4v-2.1l8-4.6V3.9c0-1.3.6-2.4 1.5-2.4z'));
  return g.getImageData(0, 0, size, size);
}

const withColors = (fc: GeoJSON.FeatureCollection, key: string, colors: Map<string, string | null>): GeoJSON.FeatureCollection => ({
  ...fc,
  features: fc.features.map((f) => ({ ...f, properties: { ...f.properties, color: colors.get(f.properties?.[key] as string) ?? null } })),
});

export function createMap(
  container: HTMLElement, data: MapData, dark: boolean, bounds: maplibregl.LngLatBoundsLike,
  pad: maplibregl.PaddingOptions | number = padding(),
): MapView {
  const map = new maplibregl.Map({
    container,
    style: dark ? STYLES.dark : STYLES.light,
    bounds,
    fitBoundsOptions: { padding: pad },
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('error', (e) => console.error('[map]', e.error?.message ?? e.error));

  let stratum: Stratum = 'HI';
  let isDark = dark;
  let pieces = data.pieces;
  let neighbors = data.neighbors;
  let neighborsVisible = true;
  let aircraft = EMPTY;
  let ownerLabels = EMPTY;

  const install = () => {
    // Cool, low-contrast neutrals; colour is reserved for ownership.
    const t = isDark
      ? { line: 'rgba(235,235,245,0.38)', boundary: '#E5E5EA', nLine: 'rgba(235,235,245,0.34)', artcc: 'rgba(152,170,196,0.55)', empty: 'rgba(142,142,147,0.10)', halo: '#1C1C1E', text: '#E5E5EA', muted: 'rgba(235,235,245,0.55)', plane: '#AEAEB2' }
      : { line: 'rgba(60,60,67,0.40)', boundary: '#1D1D1F', nLine: 'rgba(60,60,67,0.34)', artcc: 'rgba(72,92,124,0.55)', empty: 'rgba(142,142,147,0.10)', halo: '#FFFFFF', text: '#1D1D1F', muted: 'rgba(60,60,67,0.6)', plane: '#636366' };

    if (!map.hasImage('plane')) map.addImage('plane', planeImage(), { sdf: true, pixelRatio: 2 });
    map.addSource('artccs', { type: 'geojson', data: data.artccs });
    map.addSource('neighbors', { type: 'geojson', data: neighbors, promoteId: 'nid' });
    map.addSource('pieces', { type: 'geojson', data: pieces, promoteId: 'pid' });
    map.addSource('sectors', { type: 'geojson', data: data.sectors });
    map.addSource('labels', { type: 'geojson', data: data.labels });
    map.addSource('boundary', { type: 'geojson', data: data.boundary });
    map.addSource('aircraft', { type: 'geojson', data: aircraft });
    map.addSource('owner-labels', { type: 'geojson', data: ownerLabels });

    const fStratum = stratumFilter(stratum);
    const vis = neighborsVisible ? 'visible' : 'none';
    map.addLayer({ id: 'artcc-line', type: 'line', source: 'artccs', filter: ['==', ['get', 'kind'], 'line'], paint: { 'line-color': t.artcc, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 1.6] } });
    map.addLayer({
      id: 'neighbors-fill', type: 'fill', source: 'neighbors', filter: fStratum, layout: { visibility: vis },
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], t.empty],
        // Neighbours stay quieter than ZME itself.
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.4, 0.22],
      },
    });
    map.addLayer({ id: 'neighbors-line', type: 'line', source: 'neighbors', filter: fStratum, layout: { visibility: vis }, paint: { 'line-color': t.nLine, 'line-width': 1, 'line-dasharray': [3, 2] } });
    map.addLayer({
      id: 'pieces-fill', type: 'fill', source: 'pieces',
      filter: ['all', fStratum, ['!=', ['get', 'hidden'], true]] as FilterSpecification,
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], t.empty],
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.6, 0.4],
        'fill-outline-color': ['coalesce', ['get', 'color'], t.empty],
      },
    });
    map.addLayer({ id: 'sectors-line', type: 'line', source: 'sectors', filter: fStratum, paint: { 'line-color': t.line, 'line-width': 1 } });
    map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', filter: boundaryFilter(stratum), paint: { 'line-color': t.boundary, 'line-width': 2, 'line-opacity': 0.8 } });
    map.addLayer({
      id: 'sector-labels', type: 'symbol', source: 'labels', filter: fStratum, minzoom: 5.2,
      layout: { 'text-field': ['get', 'sector'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 5.2, 11, 8, 14], 'text-allow-overlap': false },
      paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.4, 'text-opacity': 0.85 },
    });
    // Above the sector numbers, so where they collide the owner label wins.
    map.addLayer({
      id: 'owner-labels', type: 'symbol', source: 'owner-labels', filter: fStratum,
      layout: {
        'text-field': [
          'format',
          ['get', 'id'], { 'font-scale': 1.15 },
          '\n', {},
          ['get', 'name'], { 'font-scale': 0.92 },
          '\n', {},
          ['get', 'freq'], { 'font-scale': 0.92 },
        ],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 15],
        'text-line-height': 1.1,
        'text-allow-overlap': true,
        'text-ignore-placement': false,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': t.text, 'text-halo-color': t.halo, 'text-halo-width': 1.6 },
    });
    map.addLayer({
      id: 'artcc-labels', type: 'symbol', source: 'artccs', filter: ['==', ['get', 'kind'], 'label'],
      layout: { 'text-field': ['get', 'id'], 'text-font': FONT, 'text-size': 13, 'text-letter-spacing': 0.12 },
      paint: { 'text-color': t.muted, 'text-halo-color': t.halo, 'text-halo-width': 1.2 },
    });
    map.addLayer({
      id: 'aircraft', type: 'symbol', source: 'aircraft',
      layout: {
        'icon-image': 'plane', 'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.45, 9, 0.8],
        'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': ['coalesce', ['get', 'color'], t.plane],
        'icon-halo-color': t.halo, 'icon-halo-width': 1.2,
        'icon-opacity': ['case', ['get', 'selected'], 1, 0.9],
      },
    });
  };

  map.on('style.load', install);

  return {
    map,
    setStratum(s) {
      stratum = s;
      if (!map.getLayer('pieces-fill')) return;
      const f = stratumFilter(s);
      map.setFilter('pieces-fill', ['all', f, ['!=', ['get', 'hidden'], true]] as FilterSpecification);
      for (const id of ['sectors-line', 'sector-labels', 'owner-labels', 'neighbors-fill', 'neighbors-line']) map.setFilter(id, f);
      map.setFilter('boundary-line', boundaryFilter(s));
    },
    setPieceColors(colors) {
      pieces = withColors(data.pieces, 'pid', colors);
      (map.getSource('pieces') as GeoJSONSource | undefined)?.setData(pieces);
    },
    setNeighborColors(colors) {
      neighbors = withColors(data.neighbors, 'nid', colors);
      (map.getSource('neighbors') as GeoJSONSource | undefined)?.setData(neighbors);
    },
    setNeighborsVisible(v) {
      neighborsVisible = v;
      for (const id of ['neighbors-fill', 'neighbors-line']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    },
    setAircraft(fc) {
      aircraft = fc;
      (map.getSource('aircraft') as GeoJSONSource | undefined)?.setData(fc);
    },
    setOwnerLabels(fc) {
      ownerLabels = fc;
      (map.getSource('owner-labels') as GeoJSONSource | undefined)?.setData(fc);
    },
    setTheme(d) {
      if (d === isDark) return;
      isDark = d;
      map.setStyle(d ? STYLES.dark : STYLES.light);
    },
  };
}

const stratumFilter = (s: Stratum) => ['==', ['get', 'stratum'], s] as FilterSpecification;

/** LO has its own (larger) lateral boundary; HI and UH share one. */
function boundaryFilter(s: Stratum): FilterSpecification {
  return ['==', ['get', 'stratum'], s === 'LO' ? 'LO' : 'HI'];
}

/** Map padding that keeps ZME clear of the floating chrome. */
export function padding() {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  const hidden = document.documentElement.dataset.panel === 'hidden';
  if (!mobile) return { top: 90, bottom: 40, left: hidden ? 60 : 420, right: 60 };
  if (hidden) return { top: 76, bottom: 24, left: 16, right: 16 };
  const sheet = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-visible')) || 170;
  return { top: 76, bottom: Math.min(sheet, window.innerHeight * 0.5) + 12, left: 16, right: 16 };
}

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre locates its worker relative to import.meta.url, which breaks once Vite
// pre-bundles / bundles the library. Point it at the emitted asset explicitly.
maplibregl.setWorkerUrl(workerUrl);
import type { Piece } from './ownership';
import type { Stratum } from './sectors';

const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};

export interface MapData {
  pieces: GeoJSON.FeatureCollection;
  sectors: GeoJSON.FeatureCollection;
  boundary: GeoJSON.FeatureCollection;
  neighbors: GeoJSON.FeatureCollection;
}

export interface MapView {
  map: MLMap;
  setStratum(s: Stratum): void;
  setPieceColors(colors: Map<string, string | null>): void;
  setAircraft(fc: GeoJSON.FeatureCollection): void;
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

export function createMap(container: HTMLElement, data: MapData, dark: boolean, bounds: maplibregl.LngLatBoundsLike): MapView {
  const map = new maplibregl.Map({
    container,
    style: dark ? STYLES.dark : STYLES.light,
    bounds,
    fitBoundsOptions: { padding: padding() },
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('error', (e) => console.error('[map]', e.error?.message ?? e.error));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  let stratum: Stratum = 'HI';
  let isDark = dark;
  let pieces = data.pieces;
  let aircraft = EMPTY;

  const install = () => {
    const t = isDark
      ? { line: 'rgba(255,255,255,0.55)', boundary: '#f5f5f7', neighbor: 'rgba(255,255,255,0.22)', empty: 'rgba(142,142,147,0.10)', halo: '#1c1c1e' }
      : { line: 'rgba(29,29,31,0.45)', boundary: '#1d1d1f', neighbor: 'rgba(29,29,31,0.22)', empty: 'rgba(142,142,147,0.12)', halo: '#ffffff' };

    if (!map.hasImage('plane')) map.addImage('plane', planeImage(), { sdf: true, pixelRatio: 2 });
    map.addSource('pieces', { type: 'geojson', data: pieces, promoteId: 'pid' });
    map.addSource('sectors', { type: 'geojson', data: data.sectors });
    map.addSource('boundary', { type: 'geojson', data: data.boundary });
    map.addSource('neighbors', { type: 'geojson', data: data.neighbors });
    map.addSource('aircraft', { type: 'geojson', data: aircraft });

    const fStratum = ['==', ['get', 'stratum'], stratum] as maplibregl.FilterSpecification;
    map.addLayer({ id: 'neighbors', type: 'line', source: 'neighbors', paint: { 'line-color': t.neighbor, 'line-width': 1, 'line-dasharray': [3, 3] } });
    map.addLayer({
      id: 'pieces-fill', type: 'fill', source: 'pieces',
      filter: ['all', fStratum, ['!=', ['get', 'hidden'], true]] as maplibregl.FilterSpecification,
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], t.empty],
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.62, 0.42],
        'fill-outline-color': ['coalesce', ['get', 'color'], t.empty],
      },
    });
    map.addLayer({ id: 'sectors-line', type: 'line', source: 'sectors', filter: fStratum, paint: { 'line-color': t.line, 'line-width': 1 } });
    map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', filter: boundaryFilter(stratum), paint: { 'line-color': t.boundary, 'line-width': 2.2, 'line-opacity': 0.85 } });
    map.addLayer({
      id: 'aircraft', type: 'symbol', source: 'aircraft',
      layout: {
        'icon-image': 'plane', 'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.45, 9, 0.8],
        'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': ['coalesce', ['get', 'color'], isDark ? '#aeaeb2' : '#636366'],
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
      const f = ['==', ['get', 'stratum'], s] as maplibregl.FilterSpecification;
      map.setFilter('pieces-fill', ['all', f, ['!=', ['get', 'hidden'], true]] as maplibregl.FilterSpecification);
      map.setFilter('sectors-line', f);
      map.setFilter('boundary-line', boundaryFilter(s));
    },
    setPieceColors(colors) {
      pieces = {
        ...data.pieces,
        features: data.pieces.features.map((f) => ({
          ...f,
          properties: { ...f.properties, color: colors.get((f.properties as Piece).pid) ?? null },
        })),
      };
      (map.getSource('pieces') as GeoJSONSource | undefined)?.setData(pieces);
    },
    setAircraft(fc) {
      aircraft = fc;
      (map.getSource('aircraft') as GeoJSONSource | undefined)?.setData(fc);
    },
    setTheme(d) {
      if (d === isDark) return;
      isDark = d;
      map.setStyle(d ? STYLES.dark : STYLES.light);
    },
  };
}

/** LO has its own (larger) lateral boundary; HI and UH share one. */
function boundaryFilter(s: Stratum): maplibregl.FilterSpecification {
  return ['==', ['get', 'stratum'], s === 'LO' ? 'LO' : 'HI'];
}

export function padding() {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  return mobile ? { top: 80, bottom: 260, left: 24, right: 24 } : { top: 90, bottom: 40, left: 420, right: 60 };
}

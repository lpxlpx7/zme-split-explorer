# ZME Split Explorer

Live airspace-split display for the virtual Memphis ARTCC (VATSIM), modelled on the ZTL ASX.

Live site: https://lpxlpx7.github.io/zme-split-explorer/

Pushes to `main` are built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (relative paths, host anywhere)
```

## How it works

- **Live data**: polls `https://data.vatsim.net/v3/vatsim-data.json` every 15 s. `MEM_*_CTR`
  controllers are matched to a sector by frequency first, then by the number in the callsign.
  A bare `MEM_CTR` counts as Razorback (22).
- **Split logic** (`src/ownership.ts`, rules from ZME Enroute SOP V1.3 §3-2):
  - If only combined positions (22/63/46/44) are online, the combined 2/3/4-way area split applies at all altitudes.
  - Otherwise each stratum is resolved separately. A sector goes to its own position if that is online,
    otherwise to the 4-way, 3-way, then 2-way split owner for its area. HI then falls back to the combined
    split. LO and UH fall back to whoever owns the HI airspace above or below them.
- **Geometry**: `public/data/*.geojson` is generated from the ZME video maps (`../ZME`) by
  `tools/build_sectors.py`, which polygonizes the LO/HI/UH sector lines and the combined split lines.
  Re-run it if the video maps change (`pip install shapely`):
  `python tools/build_sectors.py ../ZME public/data`
- **Preview**: toggle positions or pick a preset to see a split without live data.

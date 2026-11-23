# ZME Split Explorer

A live map of how the virtual Memphis ARTCC (VATSIM) is split, modelled on the ZTL ASX. It also shows the
adjacent ARTCCs' sectors and who is working them.

```bash
npm install
npm run dev      # http://localhost:5173, also prints a Network URL to open on your phone
npm run build    # typecheck + static site in dist/ (relative paths, host anywhere)
npm run data     # regenerate public/data by hand (add -- --refresh to re-download VATGlasses)
```

Everything is TypeScript: the app in `src/`, the data build in `tools/` (run with `tsx`) and the server in
`server/`.

## How it works

The site polls `https://data.vatsim.net/v3/vatsim-data.json` every 15 s. `MEM_*_CTR` controllers are matched
by the number in the callsign first (two digits, or the first two of three: `MEM_221_CTR` → 22), then by
frequency, which catches relief callsigns like `MEM_1_CTR`. A bare `MEM_CTR` counts as Razorback (22).

The ZME split follows the ZME Enroute SOP V1.3 §3-2 (`src/ownership.ts`). If only combined positions
(22/63/46/44) are online, the combined 2/3/4-way area split applies at all altitudes. Otherwise each stratum
is resolved on its own: a sector goes to its own position if that is online, then to the 4-way, 3-way and
2-way split owner for its area. HI then falls back to the combined split, and LO and UH fall back to whoever
owns the HI airspace above or below them.

ZKC, ZID, ZTL, ZJX, ZHU and ZFW sectors along the ZME boundary are shown per stratum and coloured by whoever
is online there (`src/neighbors.ts`). ZHU and ZJX publish their sectors and priority chains on VATGlasses, so
their ownership follows those chains exactly (controllers matched by frequency, then callsign number). The
others only have an outline on VATGlasses, so their centre controllers share the strip; when several are
online the map shows the first one and marks it *approx.*

Each owner's position number, name and frequency is always drawn on the map, in its own sector if it works
that sector, otherwise in the biggest sector it has.

Anyone can use Preview: switch positions on or pick a preset, then hand any sector to any of those positions,
either in the list or by clicking a sector on the map (on a computer). The setup stays in this browser's
local storage and is never sent anywhere; `#preview` links straight to it. Preview shows no aircraft, no
callsigns (positions are named instead) and no live adjacent-ARTCC controllers.

The button next to Preview hides the left panel so the map fills the screen; a map button brings it back.

## Self-hosting and planned splits

`server/index.ts` serves the built site and the API (`/api/plans`) from your own server. Events are kept in
`data/plans.json`, or in MySQL (see below).

```bash
npm ci
VITE_OVERRIDES_URL=/api npm run build         # bake the API path into the site
npm run build:server                          # bundle the server to server/server.mjs
ADMIN_TOKEN='<long random string>' PORT=8787 node server/server.mjs
```

`npm run serve` runs `server/index.ts` directly with `tsx` instead. Settings can also go in a `.env` file
next to `package.json`.

Put nginx or Caddy with HTTPS in front and proxy every path to 127.0.0.1:8787. The token travels in a
header, so never serve the site over plain HTTP. Other settings: `HOST`, `PORT`, `DATA_FILE`, `STATIC_DIR`,
and `ALLOWED_ORIGIN` (only needed if the site is served from a different origin than the API). Without
`VITE_OVERRIDES_URL` the site has no events and no admin.

### Admin panel

Open `/admin` (or `/admin.html`) and sign in with the token. It has five sections:

- Overview: who is online, the running event, live edits and the next event, next to a map of the split right now.
- Live Edits: hand sectors to positions that are online right now. Tick several sectors (Shift-click selects
  a range) to hand them over at once. Live edits are shown to everyone immediately, win over a running event
  sector by sector, and expire after the time you choose (1 to 24 h).
- Events: a name, a time window (entered in UTC or local time, up to 72 h long and up to 90 days ahead) and
  the expected positions. Each position either follows the SOP among the Auto positions or covers exactly the
  sectors you pick. The editor shows the result on a map and lists uncovered sectors.
- History: finished events. Duplicating one schedules it again at the same weekday and time.
- Settings: time zone, where events are stored, sign out.

The map can be saved as a PNG, either the current stratum or all three side by side, with each position's
sectors and note underneath.

Events are public. Visitors see them in the Events tab on the map, including the per-position notes, and
can load one into their Preview. Each event also has a remark that only admins see. The editor marks every
field Public or Private.

Who is online always comes from VATSIM. Every assignment, from an event or a live edit, only applies while
its position is online; otherwise that sector falls back to the event, then to the SOP. When events overlap,
the one that started later wins. Editing an event does not change the live map until you save it.

The live map also has a smaller editor: open the site with `#admin`, sign in, and use the calendar button.

### Storing events in MySQL

To keep events in MySQL or MariaDB instead of `data/plans.json`, create an empty database and add one of
these to `.env`:

```bash
MYSQL_URL=mysql://zmesplit:password@127.0.0.1:3306/zmesplit
# or
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=zmesplit
MYSQL_PASSWORD=password
MYSQL_DATABASE=zmesplit
```

Use the separate variables if the password contains characters such as `@`, `:` or `/`.

On start the server creates the tables `zme_plans` and `zme_live` and adds any missing columns. If the
tables are empty and `data/plans.json` exists, that file is imported once. Finished events stay in
`zme_plans` as history, in both storage modes. The startup log shows which storage is in use
(`data: mysql …` or `data: file …`).

## Airspace data

`tools/build-data.ts` generates `public/data/*` from two sources:

| Source | Used for |
| --- | --- |
| Your local CRC install (`%LOCALAPPDATA%\CRC`, video maps under `VideoMaps/ZME`) | ZME sectors and combined-split regions; the adjacent facilities' sector lines (the "stubs" along the ZME boundary in `ZME_ZMEHI_F8B8_HI`, `…F9B9_UH`, `ZME_ZMELO_F2B2_LO`) |
| [VATGlasses data](https://github.com/vatglasses-project/vatglasses-data) | Every other ARTCC's boundary; ZHU/ZJX sector names, frequencies and ownership |

The ZME video maps contain only lines, so the build polygonizes them (JSTS, the JS port of JTS) and assigns
sector ids by polygon index, checked against the SOP maps. Neighbour stubs are extended outward and cut a
1.5° band around ZME into sectors, which are then matched to a facility (and, for ZHU/ZJX, to a VATGlasses
sector).

You don't normally run this yourself. `npm run dev` and `npm run build` regenerate the data whenever the CRC
video maps are newer than `public/data/meta.json` (a Vite plugin in `vite.config.ts`). Machines without CRC,
such as GitHub Actions, use the committed data. Set `CRC_DIR` if CRC lives somewhere else.

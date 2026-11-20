#!/usr/bin/env python3
"""Build ZME sector polygons for the ASX web app from the ZME video maps.

Video maps contain only boundary lines, so we polygonize them and assign
sector IDs by polygon index (verified visually against the ZME Center SOP
maps, V1.3 12/25/25). Requires shapely:  pip install shapely

    python tools/build_sectors.py ../ZME public/data
"""
import json, sys
from pathlib import Path
from shapely.geometry import shape, mapping, Point, LineString
from shapely.ops import unary_union, polygonize

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "../ZME")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "public/data")
CNTR = "ZME_ZMEHI_F1B1_CNTR"

def lines(names):
    out = []
    for n in names:
        d = json.load(open(SRC / f"{n}.geojson", encoding="utf-8-sig"))
        for f in d["features"]:
            g = f.get("geometry")
            if g and g["type"] == "LineString":
                out.append(shape(g))
            elif g and g["type"] == "MultiLineString":
                out.extend(shape(g).geoms)
    return out

def polys(names):
    ps = [p for p in polygonize(unary_union(lines(names))) if p.area > 0.05]
    ps.sort(key=lambda p: (-p.centroid.y, p.centroid.x))
    return ps

def r(geom, nd=5):
    """Round coordinates to keep files small."""
    m = mapping(geom)
    def rc(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [rc(x) for x in c]
    return {"type": m["type"], "coordinates": rc(m["coordinates"])}

def polygonal(g):
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [x for x in g.geoms if x.geom_type == "Polygon"]
    return []

# --- ZME boundaries and combined-split regions -------------------------------
# The low stratum is laterally larger than HI/UH (N. Alabama, the south and a NW strip),
# so LO uses the ZMELO center boundary and HI/UH the ZMEHI one.
CNTR_LO = "ZME_ZMELO_F1B1_CNTR"
SPLITS = ["ARTCC 4-Way Split", "ARTCC 3-Way Split", "ARTCC 2-Way Split"]
cmb_hi = polys(SPLITS + [CNTR])
zme_hi = unary_union([cmb_hi[i] for i in (2, 3, 5, 7, 9)])
# Combined regions drawn on the (larger) LO boundary; HI/UH ⊂ LO.
cmb_lo = polys(SPLITS + [CNTR_LO])
MEMPHIS = Point(-90.0, 35.1)
lo_outline = max((p for p in polygonize(unary_union(lines([CNTR_LO]))) if p.contains(MEMPHIS)), key=lambda p: p.area)
cmb_lo_in = [p for p in cmb_lo if lo_outline.contains(p.representative_point())]
REGION_IDX = {0: "NE", 1: "NW", 2: "CW", 3: "SE", 4: "SW"}
regions = {rid: cmb_lo_in[i] for i, rid in REGION_IDX.items()}
zme_lo = unary_union(list(regions.values()))
assert zme_hi.difference(zme_lo).area < 1e-3, "HI boundary must lie within LO"
assert abs(zme_lo.area - 38.007) < 0.05, zme_lo.area

def inside(ps, zme):
    return [p for p in ps if zme.contains(p.representative_point())]

# polygon index -> sector id (index order: north->south, then west->east)
STRATA = {
    "LO": (["ZME_FLOW_F2B2_LOW SECTORS", CNTR_LO], zme_lo, {
        0: "05", 1: "41", 2: "04", 3: "07", 4: "03", 5: "42", 6: "02", 7: "40",
        8: "14", 9: "01", 10: "15", 11: "13", 12: "12", 13: "13", 14: "67",
        15: "66", 16: "65"}),
    "HI": (["ZME_ZMEHI_F8B8_HI", CNTR], zme_hi, {
        0: "25", 1: "63", 2: "27", 3: "62", 4: "28", 5: "26", 6: "22", 7: "28",
        8: "28", 9: "28", 10: "21", 11: "28", 12: "31", 13: "44", 14: "30",
        15: "45", 16: "46"}),
    "UH": (["ZME_ZMEHI_F9B9_UH", CNTR], zme_hi, {
        0: "35", 1: "61", 2: "33", 3: "19", 4: "34", 5: "20", 6: "32", 7: "44",
        8: "43"}),
}

sectors = {}
for stratum, (files, zme, idmap) in STRATA.items():
    ps = inside(polys(files), zme)
    assert len(ps) == len(idmap), (stratum, len(ps))
    groups = {}
    for i, p in enumerate(ps):
        groups.setdefault(idmap[i], []).append(p)
    for sid, g in groups.items():
        sectors[(stratum, sid)] = unary_union(g).buffer(0)

# --- pieces: HI ∩ region; LO/UH ∩ region ∩ HI piece (LO beyond HI: hi = None) --
MIN = 2e-5
pieces, hi_pieces = [], []
for (st, sid), g in sectors.items():
    if st != "HI":
        continue
    for rid, rg in regions.items():
        for p in polygonal(g.intersection(rg)):
            if p.area > MIN:
                pid = f"HI-{sid}-{len(pieces)}"
                pieces.append({"pid": pid, "stratum": "HI", "sector": sid, "region": rid, "hi": None, "g": p})
                hi_pieces.append(pieces[-1])
hi_union = unary_union([hp["g"] for hp in hi_pieces])
for (st, sid), g in sectors.items():
    if st == "HI":
        continue
    for hp in hi_pieces:
        for p in polygonal(g.intersection(hp["g"])):
            if p.area > MIN:
                pieces.append({"pid": f"{st}-{sid}-{len(pieces)}", "stratum": st, "sector": sid,
                               "region": hp["region"], "hi": hp["pid"], "g": p})
    rest = g.difference(hi_union)
    for rid, rg in regions.items():
        for p in polygonal(rest.intersection(rg)):
            if p.area > MIN:
                pieces.append({"pid": f"{st}-{sid}-{len(pieces)}", "stratum": st, "sector": sid,
                               "region": rid, "hi": None, "g": p})

def fc(features):
    return {"type": "FeatureCollection", "features": features}

def feat(geom, props):
    return {"type": "Feature", "properties": props, "geometry": r(geom)}

OUT.mkdir(parents=True, exist_ok=True)
json.dump(fc([feat(v, {"stratum": st, "sector": sid}) for (st, sid), v in sorted(sectors.items())]),
          open(OUT / "sectors.geojson", "w"), separators=(",", ":"))
json.dump(fc([feat(p["g"], {k: p[k] for k in ("pid", "stratum", "sector", "region", "hi")}) for p in pieces]),
          open(OUT / "pieces.geojson", "w"), separators=(",", ":"))
labels = []
for (st, sid), v in sorted(sectors.items()):
    big = max(polygonal(v), key=lambda x: x.area)
    labels.append({"type": "Feature", "properties": {"stratum": st, "sector": sid},
                   "geometry": r(big.representative_point())})
json.dump(fc(labels), open(OUT / "labels.geojson", "w"), separators=(",", ":"))
json.dump(fc([feat(rg, {"region": rid}) for rid, rg in regions.items()]),
          open(OUT / "regions.geojson", "w"), separators=(",", ":"))
json.dump(fc([feat(LineString(zme_lo.exterior.coords), {"name": "ZME", "stratum": "LO"}),
             feat(LineString(zme_hi.exterior.coords), {"name": "ZME", "stratum": "HI"})]),
          open(OUT / "boundary.geojson", "w"), separators=(",", ":"))
# neighbouring ARTCC boundary lines (for context), clipped to a box around ZME
from shapely.geometry import box
clip = box(-100, 28, -80, 41)
nb = [l.intersection(clip) for l in lines([CNTR, CNTR_LO])]
nb = [g for g in nb if not g.is_empty and g.length > 0]
json.dump(fc([feat(unary_union(nb), {})]), open(OUT / "neighbors.geojson", "w"), separators=(",", ":"))
print(f"{len(sectors)} sectors, {len(pieces)} pieces -> {OUT}")

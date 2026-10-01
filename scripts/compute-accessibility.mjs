#!/usr/bin/env node
// Accessibility numbers for the Engagement view: how many residents live
// within reach of a city's Fitness Courts and of its Trail Line.
//
//   node scripts/compute-accessibility.mjs --census-env=/path/to/portal/.env.local \
//        [--pilot=las-vegas] [--boundary=data/boundaries/las-vegas.geojson] [--base=https://…]
//        [--areas-only]   redraw the map shapes, keep the saved population numbers
//
// Method (same as the PD portal's computeBlockPointReach, the number NFC uses
// on real projects):
//   1. Build the service area:
//        Fitness Courts: each court buffered by 805 m (a 10-minute walk at
//                        ~80 m/min), unioned.
//        Trail Line:     the trail lines buffered by the same 805 m walk on
//                        either side, unioned. (Chosen 2026-09-30 so both use
//                        one yardstick; NFC's older court radius is 2,414 m,
//                        pass --court-radius=2414 to compare.)
//        City total:     union of both, so nobody is counted twice.
//      Each is clipped to the city boundary when one is given.
//   2. Take every 2020 Census block whose internal point falls inside the area
//      and sum its 2020 Decennial population (P1_001N).
// Output: api/_data/accessibility.json (numbers) and api/_data/accessibility-areas.json
// (the simplified shapes for the Engagement view's accessibility map), both read
// by /api/engagement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const BASE = (args.base || 'https://fitness-court-engagement-map.vercel.app').replace(/\/+$/, '');
const PILOT = args.pilot || 'las-vegas';
const COURT_RADIUS_M = Number(args['court-radius'] || 805);
const TRAIL_BUFFER_M = Number(args['trail-buffer'] || 805);

function readKey(file) {
  if (process.env.CENSUS_API_KEY) return process.env.CENSUS_API_KEY;
  if (!file || !fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('CENSUS_API_KEY='));
  return line ? line.slice('CENSUS_API_KEY='.length).trim().replace(/^"|"$/g, '') : null;
}
const AREAS_ONLY = Boolean(args['areas-only']);
const censusKey = readKey(args['census-env']);
if (!censusKey && !AREAS_ONLY) throw new Error('Need CENSUS_API_KEY (pass --census-env=<portal .env.local>)');

const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${r.status} on ${url.replace(/key=[^&]+/, 'key=…')}`);
  return r.json();
};

function unionAll(features) {
  if (!features.length) return null;
  let u = features[0];
  for (let i = 1; i < features.length; i++) u = turf.union(turf.featureCollection([u, features[i]])) || u;
  return u;
}
const clip = (area, boundary) => (boundary ? turf.intersect(turf.featureCollection([area, boundary])) || area : area);

// ── Inputs from the live site ────────────────────────────────────────────
const pilot = await get(`${BASE}/api/trail?pilot=${PILOT}&t=${Date.now()}`);
const courts = (pilot.courts || []).filter((c) => c.lat != null);
const lines = (pilot.loops?.features || []).filter((f) => f.geometry?.type === 'LineString');
let boundary = null;
if (args.boundary) {
  const b = JSON.parse(fs.readFileSync(String(args.boundary), 'utf8'));
  boundary = unionAll((b.features || [b]).filter((f) => /Polygon/.test(f.geometry?.type)));
}

// ── Walk areas ────────────────────────────────────────────────────────────
// Default: real 10 minute walking isochrones along the street network
// (Mapbox Isochrone API, walking profile; the PD portal uses the same API).
// The Trail Line's area is the union of isochrones from points every 150 m
// along the line. --method=buffer falls back to straight-line circles.
const METHOD = args.method === 'buffer' ? 'buffer' : 'isochrone';
const WALK_MIN = Number(args.minutes || 10);
function readVar(file, name) {
  if (process.env[name]) return process.env[name];
  if (!file || !fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, '') : null;
}
const mapboxToken = METHOD === 'isochrone' ? readVar(args['census-env'], 'NEXT_PUBLIC_MAPBOX_TOKEN') || readVar(args['census-env'], 'MAPBOX_TOKEN') : null;
if (METHOD === 'isochrone' && !mapboxToken) throw new Error('Need NEXT_PUBLIC_MAPBOX_TOKEN in the --census-env file (or pass --method=buffer)');
const cacheFile = path.join(ROOT, 'data', 'isochrone-cache.json');
const isoCache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
async function isochrone(lon, lat) {
  const key = `walk${WALK_MIN}:${lon.toFixed(5)},${lat.toFixed(5)}`;
  if (isoCache[key]) return isoCache[key];
  const url = `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon.toFixed(5)},${lat.toFixed(5)}?contours_minutes=${WALK_MIN}&polygons=true&denoise=1&access_token=${mapboxToken}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (r.status === 429 && attempt < 5) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`Mapbox isochrone ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const f = (await r.json()).features?.[0];
    if (!f) throw new Error('Mapbox isochrone returned no polygon');
    isoCache[key] = { type: 'Feature', properties: {}, geometry: f.geometry };
    return isoCache[key];
  }
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const samplesAlong = (f, stepM = 150) => {
  const len = turf.length(f, { units: 'meters' });
  const pts = [];
  for (let d = 0; d <= len; d += stepM) pts.push(turf.along(f, d, { units: 'meters' }).geometry.coordinates);
  pts.push(f.geometry.coordinates.at(-1));
  return pts;
};
// Trail Line groups for the Performance report: red line (Bonanza), yellow
// line (Lone Mountain), and the green park loops (plus connectors).
const groupOf = (f) => (/bonanza/i.test(f.properties?.name || '') ? 'red' : /lone mountain/i.test(f.properties?.name || '') ? 'yellow' : 'loops');
const GROUP_LABEL = { red: 'Red line · Bonanza Trail', yellow: 'Yellow line · Lone Mountain Trail', loops: 'Park loops' };
const groupShapes = { red: [], yellow: [], loops: [] };
let courtShapes, trailShapes;
if (METHOD === 'isochrone') {
  courtShapes = await mapLimit(courts, 4, (c) => isochrone(c.lon, c.lat));
  const tagged = lines.flatMap((f) => samplesAlong(f).map((pt) => ({ pt, g: groupOf(f) })));
  const trailPts = tagged.map((x) => x.pt);
  trailShapes = await mapLimit(trailPts, 4, ([lon, lat]) => isochrone(lon, lat));
  trailShapes.forEach((sh, i) => groupShapes[tagged[i].g].push(sh));
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(isoCache));
  console.log(`isochrones: ${courtShapes.length} courts, ${trailPts.length} trail points (${WALK_MIN} min walk)`);
} else {
  courtShapes = courts.map((c) => turf.buffer(turf.point([c.lon, c.lat]), COURT_RADIUS_M, { units: 'meters' }));
  trailShapes = lines.map((f) => turf.buffer(f, TRAIL_BUFFER_M, { units: 'meters' }));
  trailShapes.forEach((sh, i) => groupShapes[groupOf(lines[i])].push(sh));
}
const groupAreas = Object.fromEntries(Object.entries(groupShapes).map(([g, list]) => [g, list.length ? clip(unionAll(list), boundary) : null]));
const groupMiles = Object.fromEntries(Object.keys(groupShapes).map((g) => [g, Math.round(lines.filter((f) => groupOf(f) === g).reduce((t, f) => t + turf.length(f, { units: 'miles' }), 0) * 10) / 10]));
const courtArea = clip(unionAll(courtShapes), boundary);
const trailArea = lines.length ? clip(unionAll(trailShapes), boundary) : null;
const combinedArea = unionAll([courtArea, trailArea].filter(Boolean));
const trailMiles = lines.reduce((t, f) => t + turf.length(f, { units: 'miles' }), 0);

// ── Map shapes: simplified (~30 m) and rounded so the page loads them fast ──
const slim = (f) => {
  if (!f) return null;
  const g = turf.truncate(turf.simplify(f, { tolerance: 0.0003, highQuality: true }), { precision: 5 });
  return { type: 'Feature', properties: {}, geometry: g.geometry };
};
const areasOut = path.join(ROOT, 'api', '_data', 'accessibility-areas.json');
const areas = fs.existsSync(areasOut) ? JSON.parse(fs.readFileSync(areasOut, 'utf8')) : {};
areas[`${pilot.pilot.name}, ${pilot.pilot.state}`] = {
  boundary: slim(boundary), courts: slim(courtArea), trail: slim(trailArea),
  courtRadiusMeters: COURT_RADIUS_M, trailBufferMeters: TRAIL_BUFFER_M, method: METHOD, walkMinutes: WALK_MIN,
};
fs.writeFileSync(areasOut, JSON.stringify(areas) + '\n');
console.log(`areas → ${path.relative(ROOT, areasOut)} (${Math.round(fs.statSync(areasOut).size / 1024)} KB)`);
if (AREAS_ONLY) process.exit(0);

// ── Census 2020 blocks (internal points) + population ───────────────────
const [minX, minY, maxX, maxY] = turf.bbox(combinedArea);
const blocks = [];
for (let offset = 0; ; offset += 2000) {
  const q = new URLSearchParams({
    where: '1=1', geometry: `${minX},${minY},${maxX},${maxY}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'GEOID,STATE,COUNTY,INTPTLAT,INTPTLON', returnGeometry: 'false',
    resultOffset: String(offset), resultRecordCount: '2000', f: 'json',
  });
  const page = await get(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query?${q}`);
  if (page.error) throw new Error(`TIGERweb: ${page.error.message}`);
  blocks.push(...(page.features || []).map((f) => f.attributes));
  if (!page.exceededTransferLimit && (page.features || []).length < 2000) break;
}
const pop = new Map();
for (const key of new Set(blocks.map((b) => `${b.STATE}|${b.COUNTY}`))) {
  const [st, co] = key.split('|');
  const rows = await get(`https://api.census.gov/data/2020/dec/pl?get=P1_001N&for=block:*&in=state:${st}%20county:${co}&key=${censusKey}`);
  const h = rows[0];
  for (const r of rows.slice(1)) pop.set(`${r[h.indexOf('state')]}${r[h.indexOf('county')]}${r[h.indexOf('tract')]}${r[h.indexOf('block')]}`, Number(r[h.indexOf('P1_001N')]) || 0);
}

function reach(area) {
  if (!area) return { population: 0, blocks: 0 };
  let population = 0, n = 0;
  for (const b of blocks) {
    const pt = turf.point([Number(b.INTPTLON), Number(b.INTPTLAT)]);
    if (turf.booleanPointInPolygon(pt, area)) { population += pop.get(b.GEOID) || 0; n++; }
  }
  return { population, blocks: n };
}

const result = {
  pilot: PILOT,
  city: `${pilot.pilot.name}, ${pilot.pilot.state}`,
  computedAt: new Date().toISOString(),
  courts: { ...reach(courtArea), sites: courts.length, radiusMeters: COURT_RADIUS_M, method: METHOD === 'isochrone' ? `Residents in 2020 Census blocks inside a ${WALK_MIN} minute walk (street network) of a Fitness Court` : `Residents in 2020 Census blocks within ${COURT_RADIUS_M.toLocaleString()} m of a Fitness Court`, walkMinutes: WALK_MIN, areaMethod: METHOD },
  trail: { ...reach(trailArea), trailMiles: Math.round(trailMiles * 10) / 10, bufferMeters: TRAIL_BUFFER_M, method: METHOD === 'isochrone' ? `Residents in 2020 Census blocks inside a ${WALK_MIN} minute walk (street network) of the Trail Line` : `Residents in 2020 Census blocks within ${TRAIL_BUFFER_M.toLocaleString()} m of the Trail Line`, walkMinutes: WALK_MIN, areaMethod: METHOD },
  combined: { ...reach(combinedArea), method: 'Union of both areas, so nobody is counted twice' },
  trailGroups: Object.fromEntries(Object.entries(groupAreas).map(([g, a]) => [g, { label: GROUP_LABEL[g], ...reach(a), miles: groupMiles[g] }])),
  clippedToCityLimits: Boolean(boundary),
};

const out = args.out ? String(args.out) : path.join(ROOT, 'api', '_data', 'accessibility.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
const all = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
all[PILOT] = result;
fs.writeFileSync(out, JSON.stringify(all, null, 1) + '\n');
console.log(JSON.stringify({ courts: result.courts.population, trail: result.trail.population, combined: result.combined.population, trailMiles: result.trail.trailMiles, blocksChecked: blocks.length }));

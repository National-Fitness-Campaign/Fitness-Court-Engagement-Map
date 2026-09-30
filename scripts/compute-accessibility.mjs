#!/usr/bin/env node
// Accessibility numbers for the Engagement view: how many residents live
// within reach of a city's Fitness Courts and of its Trail Line.
//
//   node scripts/compute-accessibility.mjs --census-env=/path/to/portal/.env.local \
//        [--pilot=las-vegas] [--boundary=/path/city-limits.geojson] [--base=https://…]
//
// Method (same as the PD portal's computeBlockPointReach, the number NFC uses
// on real projects):
//   1. Build the service area:
//        Fitness Courts: each court buffered by 2,414 m (NFC's 10-minute
//                        accessibility radius), unioned.
//        Trail Line:     the trail lines buffered by 402 m (a 5-minute walk,
//                        ~80 m/min) on either side, unioned.
//        City total:     union of both, so nobody is counted twice.
//      Each is clipped to the city boundary when one is given.
//   2. Take every 2020 Census block whose internal point falls inside the area
//      and sum its 2020 Decennial population (P1_001N).
// Output: api/_data/accessibility.json, read by /api/engagement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const BASE = (args.base || 'https://fitness-court-engagement-map.vercel.app').replace(/\/+$/, '');
const PILOT = args.pilot || 'las-vegas';
const COURT_RADIUS_M = Number(args['court-radius'] || 2414);
const TRAIL_BUFFER_M = Number(args['trail-buffer'] || 402);

function readKey(file) {
  if (process.env.CENSUS_API_KEY) return process.env.CENSUS_API_KEY;
  if (!file || !fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('CENSUS_API_KEY='));
  return line ? line.slice('CENSUS_API_KEY='.length).trim().replace(/^"|"$/g, '') : null;
}
const censusKey = readKey(args['census-env']);
if (!censusKey) throw new Error('Need CENSUS_API_KEY (pass --census-env=<portal .env.local>)');

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

const courtArea = clip(unionAll(courts.map((c) => turf.buffer(turf.point([c.lon, c.lat]), COURT_RADIUS_M, { units: 'meters' }))), boundary);
const trailArea = lines.length ? clip(unionAll(lines.map((f) => turf.buffer(f, TRAIL_BUFFER_M, { units: 'meters' }))), boundary) : null;
const combinedArea = unionAll([courtArea, trailArea].filter(Boolean));
const trailMiles = lines.reduce((t, f) => t + turf.length(f, { units: 'miles' }), 0);

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
  courts: { ...reach(courtArea), sites: courts.length, radiusMeters: COURT_RADIUS_M, method: 'Residents in 2020 Census blocks within 2,414 m (NFC 10-minute accessibility) of a Fitness Court' },
  trail: { ...reach(trailArea), trailMiles: Math.round(trailMiles * 10) / 10, bufferMeters: TRAIL_BUFFER_M, method: 'Residents in 2020 Census blocks within a 5-minute walk (402 m) of the Trail Line' },
  combined: { ...reach(combinedArea), method: 'Union of both areas, so nobody is counted twice' },
  clippedToCityLimits: Boolean(boundary),
};

const out = args.out ? String(args.out) : path.join(ROOT, 'api', '_data', 'accessibility.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
const all = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
all[PILOT] = result;
fs.writeFileSync(out, JSON.stringify(all, null, 1) + '\n');
console.log(JSON.stringify({ courts: result.courts.population, trail: result.trail.population, combined: result.combined.population, trailMiles: result.trail.trailMiles, blocksChecked: blocks.length }));

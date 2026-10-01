#!/usr/bin/env node
// Accessibility for EVERY city with Fitness Courts (pilot cities with a Trail
// Line keep using compute-accessibility.mjs, which also does the trail).
//
//   node scripts/compute-accessibility-all.mjs --census-env=/path/to/portal/.env.local \
//        [--base=http://localhost:3100] [--only="San Francisco, CA"] [--redo]
//
// Same method as the Las Vegas numbers:
//   - a real 10 minute walking isochrone (Mapbox, walking) around each Fitness Court
//   - clipped to the city's Census boundary (place, town/township or county; see
//     api/_boundary-lookup.js). Universities and school districts have no Census
//     boundary, so their walk areas are not clipped.
//   - 2020 Census blocks whose internal point falls inside, summed (P1_001N)
// Writes into api/_data/accessibility.json and accessibility-areas.json under
// the city key the page uses ("San Francisco, CA"). Saves after every city, so
// it can be stopped and re-run; finished cities are skipped unless --redo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { findBoundary } from '../api/_boundary-lookup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const BASE = String(args.base || 'http://localhost:3100').replace(/\/+$/, '');
const WALK_MIN = 10;

function readVar(file, name) {
  if (process.env[name]) return process.env[name];
  if (!file || !fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, '') : null;
}
const censusKey = readVar(args['census-env'], 'CENSUS_API_KEY');
const mapboxToken = readVar(args['census-env'], 'NEXT_PUBLIC_MAPBOX_TOKEN') || readVar(args['census-env'], 'MAPBOX_TOKEN');
if (!censusKey || !mapboxToken) throw new Error('Need CENSUS_API_KEY and NEXT_PUBLIC_MAPBOX_TOKEN (pass --census-env=<portal .env.local>)');

const get = async (url, tries = 3) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`${r.status} on ${url.replace(/(key|access_token)=[^&]+/g, '$1=…').slice(0, 160)}`);
      return await r.json();
    } catch (e) { if (i + 1 >= tries) throw e; await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); }
  }
};
function unionAll(features) {
  const list = features.filter(Boolean);
  if (!list.length) return null;
  let u = list[0];
  for (let i = 1; i < list.length; i++) u = turf.union(turf.featureCollection([u, list[i]])) || u;
  return u;
}
const clip = (area, boundary) => (area && boundary ? turf.intersect(turf.featureCollection([area, boundary])) : area);
const slim = (f) => (f ? { type: 'Feature', properties: {}, geometry: turf.truncate(turf.simplify(f, { tolerance: 0.0003, highQuality: true }), { precision: 5 }).geometry } : null);

// ── Caches (shared with compute-accessibility.mjs) ─────────────────────────
const isoFile = path.join(ROOT, 'data', 'isochrone-cache.json');
const isoCache = fs.existsSync(isoFile) ? JSON.parse(fs.readFileSync(isoFile, 'utf8')) : {};
const popDir = path.join(ROOT, 'data', 'census-pop-cache');
fs.mkdirSync(popDir, { recursive: true });
async function isochrone(lon, lat) {
  const key = `walk${WALK_MIN}:${lon.toFixed(5)},${lat.toFixed(5)}`;
  if (isoCache[key]) return isoCache[key];
  const url = `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon.toFixed(5)},${lat.toFixed(5)}?contours_minutes=${WALK_MIN}&polygons=true&denoise=1&access_token=${mapboxToken}`;
  const f = (await get(url)).features?.[0];
  if (!f) throw new Error('Mapbox isochrone returned no polygon');
  isoCache[key] = { type: 'Feature', properties: {}, geometry: f.geometry };
  return isoCache[key];
}
async function countyPop(st, co) {
  const file = path.join(popDir, `${st}${co}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = await get(`https://api.census.gov/data/2020/dec/pl?get=P1_001N&for=block:*&in=state:${st}%20county:${co}&key=${censusKey}`);
  const h = rows[0], out = {};
  for (const r of rows.slice(1)) out[`${r[h.indexOf('state')]}${r[h.indexOf('county')]}${r[h.indexOf('tract')]}${r[h.indexOf('block')]}`] = Number(r[h.indexOf('P1_001N')]) || 0;
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}
async function blocksIn(area) {
  const [minX, minY, maxX, maxY] = turf.bbox(area);
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
  return blocks;
}

// ── Cities ─────────────────────────────────────────────────────────────────
const outFile = path.join(ROOT, 'api', '_data', 'accessibility.json');
const areasFile = path.join(ROOT, 'api', '_data', 'accessibility-areas.json');
const accAll = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const areasAll = fs.existsSync(areasFile) ? JSON.parse(fs.readFileSync(areasFile, 'utf8')) : {};
const done = new Set(Object.values(accAll).map((a) => a.city));

const courtsResp = await get(`${BASE}/api/courts?t=${Date.now()}`);
const codes = (Array.isArray(courtsResp) ? courtsResp : courtsResp.courts || [])
  .filter((c) => c.kind !== 'trail' && c.lat != null && c.locationStatus !== 'mobile' && c.state);
const byCity = new Map();
for (const c of codes) { const k = `${c.city}, ${c.state}`; if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(c); }
let cities = [...byCity.keys()].sort();
if (args.only) cities = cities.filter((k) => k === args.only);
if (!args.redo) cities = cities.filter((k) => !done.has(k));
console.log(`${cities.length} cities to do (${byCity.size} with Fitness Courts, ${done.size} already done)`);

let n = 0;
for (const key of cities) {
  n++;
  const list = byCity.get(key);
  const [city, st] = [key.slice(0, key.lastIndexOf(',')), key.slice(key.lastIndexOf(',') + 2)];
  try {
    const shapes = [];
    for (const c of list) shapes.push(await isochrone(c.lon, c.lat));
    fs.writeFileSync(isoFile, JSON.stringify(isoCache));

    let boundary = null, boundaryName = null;
    const fc = await findBoundary(city, st, { near: [list[0].lon, list[0].lat] }).catch(() => null);
    if (fc) {
      const b = unionAll(fc.features.map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry })));
      // Only trust a boundary that actually holds at least one of the Fitness Courts.
      if (b && list.some((c) => turf.booleanPointInPolygon(turf.point([c.lon, c.lat]), b))) { boundary = b; boundaryName = fc.features[0].properties?.NAME || null; }
    }
    const per = shapes.map((sh) => clip(sh, boundary) || sh);
    const area = unionAll(per);
    const blocks = await blocksIn(area);
    const pop = {};
    for (const k of new Set(blocks.map((b) => `${b.STATE}|${b.COUNTY}`))) Object.assign(pop, await countyPop(...k.split('|')));
    const reach = (a) => {
      if (!a) return { population: 0, blocks: 0 };
      let population = 0, nb = 0;
      for (const b of blocks) if (turf.booleanPointInPolygon(turf.point([Number(b.INTPTLON), Number(b.INTPTLAT)]), a)) { population += pop[b.GEOID] || 0; nb++; }
      return { population, blocks: nb };
    };
    const total = reach(area);
    const method = `Residents in 2020 Census blocks inside a ${WALK_MIN} minute walk (street network) of a Fitness Court`;
    accAll[key] = {
      city: key, computedAt: new Date().toISOString(),
      courts: { ...total, byCode: Object.fromEntries(list.map((c, i) => [c.id, reach(per[i]).population])), sites: list.length, method, walkMinutes: WALK_MIN, areaMethod: 'isochrone' },
      trail: null,
      combined: { ...total, method: 'Fitness Courts only (no Trail Line here)' },
      clippedToCityLimits: Boolean(boundary), boundaryName,
    };
    areasAll[key] = { boundary: slim(boundary), courts: slim(area), trail: null, method: 'isochrone', walkMinutes: WALK_MIN };
    fs.writeFileSync(outFile, JSON.stringify(accAll, null, 1) + '\n');
    fs.writeFileSync(areasFile, JSON.stringify(areasAll) + '\n');
    console.log(`[${n}/${cities.length}] ${key}: ${total.population.toLocaleString()} residents · ${list.length} Fitness Court${list.length === 1 ? '' : 's'} · ${boundary ? 'clipped to ' + boundaryName : 'no Census boundary'}`);
  } catch (e) {
    console.log(`[${n}/${cities.length}] ${key}: FAILED ${e.message}`);
  }
}
console.log(`done · accessibility for ${Object.keys(accAll).length} cities`);

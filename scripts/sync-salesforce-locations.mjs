#!/usr/bin/env node
// Sync exact Fitness Court coordinates from Salesforce into qr_site_links.
//
//   node scripts/sync-salesforce-locations.mjs --sf-env=/path/to/portal/.env.local [--dry-run]
//
// Why: Uniqode only has hand-entered coordinates for a handful of codes, and
// geocoding the code's name puts pins in the wrong park (or the wrong
// continent). Salesforce Site__c records carry the court's real position.
//
// How: every active QR- code is matched to a Site__c by name (state, city,
// park tokens, typo-tolerant). Exact matches are applied automatically;
// anything weaker is written as 'likely'/'none' and listed in
// docs/location-review.md for a human. data/site-overrides.json beats the
// matcher: { "<qr_id>": "<Site__c Id>" } pins a link, "none" clears it.
//
// Salesforce is read-only here (a single SOQL query). Its credentials are only
// read from --sf-env / the environment at run time — they are never stored in
// this project or its Vercel env.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

function loadEnvFile(file, filter = () => true) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || !filter(m[1]) || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
if (args['sf-env']) loadEnvFile(String(args['sf-env']), (k) => k.startsWith('SALESFORCE_'));

const { fetchAllQRCodes, env } = await import('../api/_lib.js');

// ── Salesforce (read-only) ────────────────────────────────────────────────
async function salesforceSites() {
  const base = env('SALESFORCE_INSTANCE_URL').replace(/\/+$/, '');
  const tok = await (await fetch(`${base}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env('SALESFORCE_CLIENT_ID'),
      client_secret: env('SALESFORCE_CLIENT_SECRET'),
    }),
  })).json();
  if (!tok.access_token) throw new Error(`Salesforce auth failed: ${tok.error || 'no token'}`);
  const get = async (p) => {
    const r = await fetch(`${base}/services/data/v62.0${p}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) throw new Error(`Salesforce ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const soql = `SELECT Id, Name, State__c, Site_Address__StateCode__s, Confirmed_Address__StateCode__s,
    Fitness_Court_Geo_Location__Latitude__s, Fitness_Court_Geo_Location__Longitude__s, Geo_Lat__c, Geo_Lon__c
    FROM Site__c`;
  let page = await get(`/query?q=${encodeURIComponent(soql.replace(/\s+/g, ' '))}`);
  const rows = [...page.records];
  while (page.nextRecordsUrl) {
    page = await get(page.nextRecordsUrl.split('/v62.0')[1]);
    rows.push(...page.records);
  }
  return rows.map((s) => {
    const m = s.Name.match(/^(.*?),\s*([A-Z]{2})\b\s*(?:\((.*)\))?\s*$/) || s.Name.match(/^(.*?)\s*\((.*)\)\s*$/);
    const hasState = m && m.length === 4;
    return {
      id: s.Id,
      name: s.Name,
      state: (hasState && m[2]) || s.State__c || s.Site_Address__StateCode__s || s.Confirmed_Address__StateCode__s || null,
      cityTokens: toks(m ? m[1] : s.Name),
      parkTokens: toks(m ? (hasState ? m[3] : m[2]) || '' : ''),
      ...cleanCoords(
        s.Fitness_Court_Geo_Location__Latitude__s ?? s.Geo_Lat__c,
        s.Fitness_Court_Geo_Location__Longitude__s ?? s.Geo_Lon__c,
      ),
    };
  });
}

// Every NFC court is in the US: lat 17..72, lon negative. A positive longitude
// in that band is a dropped minus sign; 0/0 or lat==lon is junk.
function cleanCoords(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || lat === lon) {
    return { lat: null, lon: null, coordNote: 'invalid coordinates in Salesforce' };
  }
  if (lat >= 17 && lat <= 72 && lon > 0 && lon <= 180) {
    return { lat, lon: -lon, coordNote: 'longitude sign fixed (Salesforce has it positive)' };
  }
  if (lat < 17 || lat > 72 || lon > -60 || lon < -180) {
    return { lat: null, lon: null, coordNote: 'coordinates outside the US in Salesforce' };
  }
  return { lat, lon, coordNote: null };
}

// ── Name matching ─────────────────────────────────────────────────────────
const ABBR = { st: 'street', ave: 'avenue', pk: 'park', mt: 'mount', ft: 'fort', ctr: 'center', rec: 'recreation', n: 'north', s: 'south', e: 'east', w: 'west' };
const STOP = new Set(['city', 'of', 'the', 'town', 'township', 'village', 'county', 'park', 'parks', 'and', 'at', 'borough',
  'district', 'school', 'schools', 'public', 'fitness', 'court', 'community', 'center', 'recreation', 'area', 'complex',
  'sports', 'regional', 'nfc', 'inc', 'oldstyle', 'old', 'style', 'new']);
// QR state prefixes that aren't the state the court is in.
const STATE_ALIAS = { SF: 'CA' };

function toks(s) {
  return (s || '')
    .replace(/['’.]/g, '').replace(/&/g, ' and ')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .map((t) => ABBR[t] || t).join(' ').split(' ')
    .filter((t) => t && !STOP.has(t));
}

// Optimal-string-alignment distance: catches "Urisnus"/"Ursinus", "Mohonassen"/"Mohonasen".
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && osa(a, b) <= (Math.min(a.length, b.length) >= 7 ? 2 : 1));
function coverage(needles, hay) {
  const n = [...new Set(needles)];
  const hit = n.filter((t) => hay.some((h) => same(t, h))).length;
  return { hit, cov: n.length ? hit / n.length : 0 };
}

function parseCode(name) {
  const parts = name.split('-');
  const rawState = parts[1] || '';
  const dfw = parts[2] === 'DFW';
  const city = toks(dfw ? parts[3] : parts[2]);
  const loc = toks((dfw ? parts.slice(4) : parts.slice(3)).join(' '));
  return { state: STATE_ALIAS[rawState] || rawState, city, loc, popup: /POPUP|^PH$/i.test(rawState) || /popup|sandwich/i.test(name) };
}

function matchCode(code, sites) {
  const c = parseCode(code.name);
  if (c.popup) return { match: 'none', reason: 'pop-up / mobile — no fixed location' };
  const want = c.loc.length ? c.loc : c.city;
  const scored = [];
  for (const s of sites) {
    if (s.state && s.state !== c.state) continue;
    const parkHay = s.parkTokens.length ? s.parkTokens : s.cityTokens;
    const park = coverage(want, parkHay);
    const whole = coverage([...c.city, ...c.loc], [...s.cityTokens, ...s.parkTokens]);
    const city = coverage(c.city, [...s.cityTokens, ...s.parkTokens]);
    // Park name carries the match; city and whole-name overlap break ties.
    const score = park.cov * 0.7 + whole.cov * 0.2 + (city.hit ? 0.1 : 0) - (s.state ? 0 : 0.05);
    scored.push({ s, score, park, city });
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.park.hit === 0) return { match: 'none', reason: 'no Salesforce site with a matching name', best };
  const clear = !next || best.score - next.score >= 0.1;
  const exact = best.park.cov >= 0.99 && (best.city.hit >= 1 || best.park.hit >= 2) && clear;
  return { match: exact ? 'exact' : best.park.cov >= 0.5 ? 'likely' : 'none', score: best.score, best, next };
}

// ── Main ──────────────────────────────────────────────────────────────────
const miles = (a, b, c, d) => {
  if ([a, b, c, d].some((v) => v == null)) return null;
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * 3959 * Math.asin(Math.sqrt(h));
};

const overridesPath = path.join(ROOT, 'data', 'site-overrides.json');
const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : {};
delete overrides._comment;

const [codes, sites] = await Promise.all([fetchAllQRCodes(), salesforceSites()]);
const siteById = new Map(sites.map((s) => [s.id, s]));
const courts = codes.filter((c) => c.name.startsWith('QR') && c.state === 'A');

const rows = [];
const review = [];
for (const code of courts) {
  const ov = overrides[String(code.id)];
  let m;
  if (ov === 'none') m = { match: 'none', reason: 'override: no Salesforce site' };
  else if (ov && siteById.has(ov)) m = { match: 'override', best: { s: siteById.get(ov) } };
  else m = matchCode(code, sites);

  const site = m.match === 'none' ? null : m.best?.s;
  // Only exact/override links move a pin; 'likely' waits for review.
  const applied = m.match === 'exact' || m.match === 'override';
  const u = code.metadata || {};
  const drift = applied ? miles(Number(u.lat) || null, Number(u.lon) || null, site.lat, site.lon) : null;

  rows.push({
    qr_id: String(code.id),
    qr_name: code.name,
    sf_site_id: site?.id ?? null,
    sf_site_name: site?.name ?? null,
    match: m.match,
    score: m.score != null ? Number(m.score.toFixed(3)) : null,
    lat: applied ? site.lat : null,
    lon: applied ? site.lon : null,
    coord_note: site?.coordNote ?? m.reason ?? null,
    synced_at: new Date().toISOString(),
  });

  if (m.match === 'likely' || (m.match === 'none' && !m.reason?.startsWith('pop-up') && !m.reason?.startsWith('override'))) {
    review.push({ kind: m.match, code, site: m.best?.s, runnerUp: m.next?.s });
  } else if (applied && site.coordNote) {
    review.push({ kind: 'coords', code, site });
  } else if (drift != null && drift > 0.2) {
    review.push({ kind: 'drift', code, site, drift });
  }
}

const count = (k) => rows.filter((r) => r.match === k).length;
console.log(`codes ${rows.length} · exact ${count('exact')} · override ${count('override')} · likely ${count('likely')} · none ${count('none')}`);
console.log(`pins from Salesforce: ${rows.filter((r) => r.lat != null).length} · needs review: ${review.length}`);

// Review list for a human.
const fmt = (s) => (s ? `${s.name} \`${s.id}\`` : '—');
const section = (title, note, items, line) => items.length
  ? `## ${title} (${items.length})\n\n${note}\n\n${items.map(line).join('\n')}\n\n` : '';
const md = `# Location review — ${new Date().toISOString().slice(0, 10)}

Generated by \`scripts/sync-salesforce-locations.mjs\`. To settle a row, add it to
\`data/site-overrides.json\` — \`"<qr id>": "<Salesforce Site Id>"\` to link it, or
\`"<qr id>": "none"\` if it has no Salesforce site — then re-run the sync.

${section('Likely matches — confirm or correct', 'Not applied to the map until confirmed.', review.filter((r) => r.kind === 'likely'),
    (r) => `- **${r.code.name}** (\`${r.code.id}\`) → ${fmt(r.site)}${r.runnerUp ? ` · runner-up: ${fmt(r.runnerUp)}` : ''}`)}${section('No match', 'No Salesforce site found by name. Link one by Id, or mark "none".', review.filter((r) => r.kind === 'none'),
    (r) => `- **${r.code.name}** (\`${r.code.id}\`)${r.site ? ` · closest: ${fmt(r.site)}` : ''}`)}${section('Salesforce coordinate problems', 'Linked, but the Salesforce coordinates needed fixing or are unusable. Fix these in Salesforce.', review.filter((r) => r.kind === 'coords'),
    (r) => `- **${r.code.name}** → ${fmt(r.site)} — ${r.site.coordNote}`)}${section('Uniqode pin disagrees with Salesforce by > 0.2 mi', 'The map now uses Salesforce. Worth a glance if Salesforce might be the wrong one.', review.filter((r) => r.kind === 'drift').sort((a, b) => b.drift - a.drift),
    (r) => `- **${r.code.name}** → ${fmt(r.site)} — ${r.drift.toFixed(1)} mi apart`)}`;
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'location-review.md'), md);
console.log('wrote docs/location-review.md');

if (args['dry-run']) { console.log('dry run — nothing written to Supabase'); process.exit(0); }

const key = env('SUPABASE_SERVICE_KEY');
const resp = await fetch(`${env('SUPABASE_URL')}/rest/v1/qr_site_links?on_conflict=qr_id`, {
  method: 'POST',
  headers: {
    apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows),
});
if (!resp.ok) throw new Error(`Supabase upsert ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
console.log(`upserted ${rows.length} rows into qr_site_links`);

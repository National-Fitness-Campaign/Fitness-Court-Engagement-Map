#!/usr/bin/env node
// Fitness Court configuration (Fitness Court / Studio / Studio +) for every
// QR court, from Salesforce Site__c.Fitness_Court_Configuration__c, joined
// through qr_site_links. Read-only on both sides; writes
// api/_data/court-config.json, read by /api/courts (the List tab column).
//
//   node scripts/sync-configurations.mjs --sf-env=/path/to/portal/.env.local

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
function loadEnvFile(file, filter = () => true) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || !filter(m[1]) || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(args['sf-env'] && String(args['sf-env']), (k) => k.startsWith('SALESFORCE_'));
const { supabaseSelect, env } = await import('../api/_lib.js');

const links = await supabaseSelect('qr_site_links?select=qr_id,sf_site_id&sf_site_id=not.is.null&order=qr_id.asc');
const base = env('SALESFORCE_INSTANCE_URL').replace(/\/+$/, '');
const tok = await (await fetch(`${base}/services/oauth2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('SALESFORCE_CLIENT_ID'), client_secret: env('SALESFORCE_CLIENT_SECRET') }),
})).json();
if (!tok.access_token) throw new Error(`Salesforce auth failed: ${tok.error || 'no token'}`);

const ids = [...new Set(links.map((l) => l.sf_site_id))];
const config = new Map();
for (let i = 0; i < ids.length; i += 150) {
  const list = ids.slice(i, i + 150).map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(',');
  const soql = `SELECT Id, Fitness_Court_Configuration__c FROM Site__c WHERE Id IN (${list})`;
  const r = await fetch(`${base}/services/data/v62.0/query?q=${encodeURIComponent(soql)}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!r.ok) throw new Error(`Salesforce ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for (const s of (await r.json()).records) config.set(s.Id, s.Fitness_Court_Configuration__c);
}
const out = {};
for (const l of links) if (config.get(l.sf_site_id)) out[l.qr_id] = config.get(l.sf_site_id);
const file = path.join(ROOT, 'api', '_data', 'court-config.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
const counts = Object.values(out).reduce((m, v) => ((m[v] = (m[v] || 0) + 1), m), {});
console.log(`${Object.keys(out).length} of ${links.length} linked courts →`, counts);

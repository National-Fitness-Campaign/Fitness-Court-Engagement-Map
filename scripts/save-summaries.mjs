#!/usr/bin/env node
// Step 2 of the daily AI summary: save the written summaries.
//
//   node scripts/save-summaries.mjs /path/summaries.json
//
// Input: { items: [
//   { key: "city:Las Vegas, NV", texts: { city, courts, trail }, facts },
//   { key: "pilot:las-vegas",    texts: { text },               facts } ] }
// Validates shape and length, then upserts into ai_summaries (service key
// from .env.local). The site shows these for 36 hours, then falls back to
// its computed overview.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^(SUPABASE_URL|SUPABASE_SERVICE_KEY)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const file = process.argv[2];
if (!file) { console.error('usage: save-summaries.mjs <summaries.json>'); process.exit(1); }
const { items } = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(items) || !items.length) throw new Error('no items');

const str = (v, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const rows = items.map((it) => {
  if (!/^(city:.+, [A-Z]{2}|pilot:[a-z-]+)$/.test(it.key || '')) throw new Error(`bad key: ${it.key}`);
  const t = it.texts || {};
  const texts = it.key.startsWith('pilot:')
    ? { text: str(t.text) }
    : { city: str(t.city), courts: str(t.courts), trail: str(t.trail) };
  if (!(texts.text || texts.city)) throw new Error(`empty summary for ${it.key}`);
  return { key: it.key, texts, facts: it.facts ?? null, written_by: 'scheduled-claude', written_at: new Date().toISOString() };
});

const key = process.env.SUPABASE_SERVICE_KEY;
const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/ai_summaries?on_conflict=key`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});
if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
console.log(`saved ${rows.length} summaries`);

// GET /api/trail-summary?pilot=las-vegas — the "what's happening" bubble.
//
// The numbers come from digest() (computed, exact); the model only turns them
// into two or three plain sentences. If the model is unavailable or slow the
// bubble falls back to a written-out version of the same facts, so it never
// breaks. Model output is cached per digest, so refreshes don't re-bill it.

import { generateText } from 'ai';
import { buildPilot, digest, PILOTS } from './_trail.js';
import { sendError, setCache } from './_lib.js';

const MODEL = 'anthropic/claude-haiku-4.5';
const MODEL_TIMEOUT_MS = 8000;
const AI_CACHE_TTL_MS = 30 * 60_000;
const aiCache = new Map(); // JSON(digest) -> { at, text }

const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Where the pilot is relative to install, in words the summary can use.
function phase(d) {
  if (!d.launchDate) return 'no-date';
  if (d.installStart && d.today < d.installStart) return 'before-install';
  if (d.today < d.launchDate) return 'installing';
  return 'live';
}

function fallback(d) {
  const total = d.publicScans + d.testScans;
  const p = phase(d);
  const when = p === 'no-date' ? ' Launch date isn’t set, so every scan is counted as a pre-launch check.'
    : p === 'before-install' ? ` Signs install ${d.installWindow || fmtDay(d.installStart)}; public counting starts ${fmtDay(d.launchDate)}, so these are test scans.`
    : p === 'installing' ? ` Signs are going in now; public counting starts ${fmtDay(d.launchDate)}.`
    : '';
  if (total === 0) return `No scans yet across the ${d.codes} ${d.city} Trail Line codes.${when}`;
  const top = d.top[0] ? ` ${d.top[0].station} leads with ${d.top[0].scans}.` : '';
  const trend = d.thisWeek === d.lastWeek ? 'flat on last week' : d.thisWeek > d.lastWeek ? `up from ${d.lastWeek} last week` : `down from ${d.lastWeek} last week`;
  return `${total} scan${total === 1 ? '' : 's'} so far at ${d.stationsWithScans} of ${d.stations} stations — ${d.thisWeek} this week, ${trend}.${top}${when}`;
}

async function aiText(d) {
  const key = JSON.stringify(d);
  const hit = aiCache.get(key);
  if (hit && Date.now() - hit.at < AI_CACHE_TTL_MS) return hit.text;
  const out = await generateText({
    model: MODEL,
    maxOutputTokens: 220,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    system:
      'You write the one-glance status line for an internal dashboard tracking QR-code scans on a new outdoor trail signage pilot. '
      + 'Use ONLY the numbers given. 2-3 short sentences, plain English, no headings, no bullet points, no emoji. '
      + 'Say whether it is trending up or down week over week, name the strongest and any silent stations, and compare Map vs CTA codes when both have scans. '
      + 'If there is too little data to call a trend, say so plainly. '
      + 'Dates are YYYY-MM-DD in Pacific time. If today is before installStart, the signs are not installed yet and every scan is a test scan. '
      + 'If today is between installStart and launchDate, signs are being installed and scans are installer checks. Public counting starts on launchDate.',
    prompt: key,
  });
  const text = out.text.trim();
  aiCache.set(key, { at: Date.now(), text });
  if (aiCache.size > 50) aiCache.delete(aiCache.keys().next().value);
  return text;
}

export default async function handler(req, res) {
  try {
    const slug = (req.query && req.query.pilot) || 'las-vegas';
    if (!Object.hasOwn(PILOTS, slug)) { res.status(404).json({ error: `Unknown pilot: ${slug}` }); return; }
    const d = digest(await buildPilot(slug));

    let text = null, source = 'computed';
    try {
      text = await aiText(d);
      source = 'ai';
    } catch (err) {
      console.warn('trail-summary: model unavailable, using computed summary:', err.message);
    }

    // Same freshness as /api/trail so the bubble never lags the KPI tiles.
    setCache(res);
    res.status(200).json({ text: text || fallback(d), source, digest: d, generatedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
}

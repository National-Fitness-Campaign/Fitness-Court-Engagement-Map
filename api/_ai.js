// One way to ask the model for dashboard copy.
//
// Callers compute every number themselves; the model only words them. Each
// call has a hard deadline and no retries, results are cached per input for
// 30 minutes (so refreshes don't re-bill), and any failure throws — callers
// fall back to their own computed text. Until the Vercel team has a card on
// file for AI Gateway, every call fails fast and the computed text shows.

import { generateText } from 'ai';
import { supabaseSelect } from './_lib.js';

// Summaries written by the daily scheduled Claude task (scripts/save-summaries.mjs).
// Used first, so AI text shows even without AI Gateway; stale after 36 h.
const STORED_MAX_AGE_MS = 36 * 3600_000;
export async function storedSummary(key) {
  const rows = await supabaseSelect(`ai_summaries?select=texts,written_at&key=eq.${encodeURIComponent(key)}&limit=1`).catch(() => []);
  const row = rows[0];
  if (!row || Date.now() - Date.parse(row.written_at) > STORED_MAX_AGE_MS) return null;
  return { ...row.texts, writtenAt: row.written_at };
}

const MODEL = 'anthropic/claude-haiku-4.5';
const TIMEOUT_MS = 8000;
const TTL_MS = 30 * 60_000;
const cache = new Map(); // key -> { at, text }

export async function writeWithAI({ system, facts, maxOutputTokens = 220 }) {
  const prompt = JSON.stringify(facts);
  const key = system.length + ':' + prompt;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const out = await generateText({
    model: MODEL,
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    system,
    prompt,
  });
  const text = out.text.trim();
  if (!text) throw new Error('empty model response');
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return text;
}

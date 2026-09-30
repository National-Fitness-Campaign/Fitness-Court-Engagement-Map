// One way to ask the model for dashboard copy.
//
// Callers compute every number themselves; the model only words them. Each
// call has a hard deadline and no retries, results are cached per input for
// 30 minutes (so refreshes don't re-bill), and any failure throws — callers
// fall back to their own computed text. Until the Vercel team has a card on
// file for AI Gateway, every call fails fast and the computed text shows.

import { generateText } from 'ai';

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

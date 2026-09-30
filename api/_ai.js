// One way to ask the model for dashboard copy.
//
// Callers compute every number themselves; the model only words them. Each
// call has a hard deadline and no retries, results are cached per input for
// 30 minutes (so refreshes don't re-bill), and any failure throws — callers
// fall back to their own computed text.
//
// Provider: with ANTHROPIC_API_KEY set (the same NFC key the Design Lab and
// PD portal use), Claude is called directly via the Anthropic SDK. Without
// it, AI Gateway is tried (needs a card on the Vercel team).

import Anthropic from '@anthropic-ai/sdk';
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

const GATEWAY_MODEL = 'anthropic/claude-haiku-4.5';
const CLAUDE_MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 15000;

export const directAI = () => Boolean(process.env.ANTHROPIC_API_KEY);
let client = null;

async function viaAnthropic({ system, prompt, maxOutputTokens }) {
  client ||= new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });
  const resp = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    // Headroom for adaptive thinking (always on for this model) plus the
    // short reply; low effort keeps short dashboard copy quick and cheap.
    max_tokens: Math.max(4000, maxOutputTokens * 8),
    output_config: { effort: 'low' },
    // If a request is declined, retry it server-side on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (resp.stop_reason === 'refusal') throw new Error(`model declined (${resp.stop_details?.category ?? 'no category'})`);
  if (resp.stop_reason === 'max_tokens') throw new Error('model reply hit max_tokens');
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function viaGateway({ system, prompt, maxOutputTokens }) {
  const out = await generateText({
    model: GATEWAY_MODEL,
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    system,
    prompt,
  });
  return out.text.trim();
}
const TTL_MS = 30 * 60_000;
const cache = new Map(); // key -> { at, text }

export async function writeWithAI({ system, facts, maxOutputTokens = 220 }) {
  const prompt = JSON.stringify(facts);
  const key = system.length + ':' + prompt;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const text = directAI()
    ? await viaAnthropic({ system, prompt, maxOutputTokens })
    : await viaGateway({ system, prompt, maxOutputTokens });
  if (!text) throw new Error('empty model response');
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return text;
}

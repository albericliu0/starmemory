// Summaries for Claude Code conversations, through the Claude Agent SDK.
//
// The SDK starts a Claude subprocess, and that subprocess fires SessionStart
// hooks, and our SessionStart hook runs sync, which summarises, which starts
// a Claude subprocess... episodic-memory saw hundreds of processes in seconds
// (their #87). Every child we start carries STARMEMORY_SUMMARIZER_GUARD and
// `starmemory sync` exits at once when it sees it (cli/starmemory.mjs).
// Anything new that spawns a Claude or Codex process must build its env with
// summarizerEnv(). Design doc archive-and-summaries §05, §06.
import fs from 'node:fs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { SUMMARY_PROMPT, extractSummary } from './summaries.js';
export const SUMMARIZER_GUARD = 'STARMEMORY_SUMMARIZER_GUARD';
export function summarizerEnv(base = process.env) {
    return { ...base, [SUMMARIZER_GUARD]: '1' };
}
export function isReentrantSummarizerContext(env = process.env) {
    return env[SUMMARIZER_GUARD] === '1';
}
const SYSTEM_PROMPT = 'Write concise, factual summaries. Output only the summary: no preamble, no "Here is".';
class SdkResultError extends Error {
}
async function runQuery(query, prompt, options) {
    for await (const message of query({ prompt, options })) {
        const m = message;
        if (m.type !== 'result')
            continue;
        if (m.is_error)
            throw new SdkResultError(m.subtype ?? 'unknown SDK error');
        return typeof m.result === 'string' ? m.result : '';
    }
    return '';
}
/** The SDK reports some API errors as the result text rather than is_error. */
function isThinkingBudgetError(text) {
    return text.includes('API Error') && text.includes('thinking.budget_tokens');
}
/** Resume the original session first (its context is already there), fall back
 * to the transcript text when it cannot be resumed, and try the fallback model
 * once when the primary hits a thinking-budget error. */
export async function summarizeWithClaude(input, deps = {}) {
    const query = deps.query ?? sdkQuery;
    const env = deps.env ?? process.env;
    const primary = env.STARMEMORY_SUMMARY_MODEL ?? 'haiku';
    const fallback = env.STARMEMORY_SUMMARY_MODEL_FALLBACK ?? 'sonnet';
    // persistSession: false keeps this call from writing a session file of its
    // own, which the next sync would otherwise pick up and index.
    const base = { persistSession: false, env: summarizerEnv(env), max_tokens: 1024 };
    const attempt = async (model) => {
        let text = '';
        let resumeError;
        if (input.sessionId) {
            try {
                const reply = await runQuery(query, SUMMARY_PROMPT, {
                    ...base,
                    model,
                    resume: input.sessionId,
                    ...(input.cwd && fs.existsSync(input.cwd) ? { cwd: input.cwd } : {}),
                });
                if (isThinkingBudgetError(reply))
                    return reply;
                // A resumed session answers in character more often than not; only a
                // tagged reply counts. Anything else falls through to the text path.
                text = extractSummary(reply) ?? '';
            }
            catch (error) {
                resumeError = error;
            }
        }
        if (text === '') {
            let reply;
            try {
                reply = await runQuery(query, `${SUMMARY_PROMPT}\n\n${input.transcript}`, { ...base, model, systemPrompt: SYSTEM_PROMPT });
            }
            catch (error) {
                if (resumeError instanceof Error && error instanceof Error) {
                    throw new Error(`${error.message} (resume failed first: ${resumeError.message})`);
                }
                throw error;
            }
            if (isThinkingBudgetError(reply))
                return reply;
            text = extractSummary(reply) ?? reply.trim();
        }
        return text;
    };
    let text = await attempt(primary);
    if (isThinkingBudgetError(text))
        text = await attempt(fallback);
    if (isThinkingBudgetError(text))
        throw new Error(text.split('\n')[0]);
    return text.trim();
}

import { describe, it, expect } from 'vitest';
import { summarizeWithClaude, summarizerEnv, isReentrantSummarizerContext, SUMMARIZER_GUARD, type QueryFn } from '../src/summarizer-claude.js';

type Call = { prompt: string; options: Record<string, unknown> };
function fakeQuery(script: (call: Call, n: number) => AsyncGenerator<unknown>) {
  const calls: Call[] = [];
  const query = ((args: Call) => { calls.push(args); return script(args, calls.length); }) as unknown as QueryFn;
  return { query, calls };
}
async function* result(text: string) { yield { type: 'result', result: text, is_error: false }; }
const tagged = (text: string) => result(`<summary>${text}</summary>`);
async function* failure(subtype: string) { yield { type: 'result', is_error: true, subtype }; }

describe('the guard', () => {
  it('marks every child environment and is recognised back', () => {
    const env = summarizerEnv({ PATH: '/bin' });
    expect(env[SUMMARIZER_GUARD]).toBe('1');
    expect(env.PATH).toBe('/bin');
    expect(isReentrantSummarizerContext(env)).toBe(true);
    expect(isReentrantSummarizerContext({})).toBe(false);
  });
});

describe('summarizeWithClaude', () => {
  it('resumes the original session and does not write a session file of its own', async () => {
    const { query, calls } = fakeQuery(() => tagged(' Fixed the flaky test. '));
    const text = await summarizeWithClaude({ sessionId: 's1', cwd: process.cwd(), transcript: 'User: hi' }, { query, env: {} });
    expect(text).toBe('Fixed the flaky test.');
    expect(calls.length).toBe(1);
    expect(calls[0].options.resume).toBe('s1');
    expect(calls[0].options.persistSession).toBe(false);
    expect(calls[0].options.cwd).toBe(process.cwd());
    expect((calls[0].options.env as Record<string, string>)[SUMMARIZER_GUARD]).toBe('1');
    expect(calls[0].prompt).not.toContain('User: hi');
  });
  it('falls back to the transcript text when the session cannot be resumed', async () => {
    const { query, calls } = fakeQuery((_, n) => (n === 1 ? failure('error_during_execution') : result('From text.')));
    const text = await summarizeWithClaude({ sessionId: 'gone', transcript: 'User: hi\nAssistant: hello' }, { query, env: {} });
    expect(text).toBe('From text.');
    expect(calls.length).toBe(2);
    expect(calls[1].options.resume).toBeUndefined();
    expect(calls[1].prompt).toContain('User: hi');
  });
  it('treats an untagged reply from the resumed session as chatter and falls back to the text', async () => {
    const { query, calls } = fakeQuery((_, n) => (n === 1 ? result("I'm ready to help. What would you like to work on next?") : tagged('From text.')));
    const text = await summarizeWithClaude({ sessionId: 's1', transcript: 'User: hi' }, { query, env: {} });
    expect(text).toBe('From text.');
    expect(calls.length).toBe(2);
    expect(calls[1].options.resume).toBeUndefined();
  });
  it('accepts an untagged reply on the text path, where there is no conversation to drift into', async () => {
    const { query } = fakeQuery(() => result('Plain summary.'));
    expect(await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} })).toBe('Plain summary.');
  });
  it('goes straight to the text when there is no session id', async () => {
    const { query, calls } = fakeQuery(() => result('Text only.'));
    await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} });
    expect(calls.length).toBe(1);
    expect(calls[0].options.resume).toBeUndefined();
  });
  it('retries with the fallback model on a thinking budget error', async () => {
    const { query, calls } = fakeQuery((_, n) => (n === 1 ? result('API Error: thinking.budget_tokens too low') : result('ok')));
    const text = await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} });
    expect(text).toBe('ok');
    expect(calls[0].options.model).toBe('haiku');
    expect(calls[1].options.model).toBe('sonnet');
  });
  it('throws when every path fails, so the caller writes an error sentinel', async () => {
    const { query } = fakeQuery(() => failure('not_logged_in'));
    await expect(summarizeWithClaude({ sessionId: 's', transcript: 'x' }, { query, env: {} })).rejects.toThrow(/not_logged_in/);
  });
});

// Telling a human turn apart from an injected one -- Claude Code writes task
// notifications, slash-command echoes and local command output into user-role
// entries, and the parser used to record all of it as "what the user said".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseConversation,
  isInjectedUserTurn,
  payloadOfInjectedTurn,
} from '../src/parser.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-parser-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(entries: Record<string, unknown>[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

const userTurn = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: '2026-03-01T10:00:00.000Z',
  sessionId: 's1',
  ...extra,
});

const assistantTurn = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: text },
  timestamp: '2026-03-01T10:00:05.000Z',
});

const NOTIFICATION = `<task-notification>
<task-id>a8c6012950e24d63f</task-id>
<tool-use-id>toolu_01LkKbGVDKgciW974uWuEK9b</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-x/tasks/a8c6012950e24d63f.output</output-file>
<status>completed</status>
<summary>Agent "/code-review be/src/storage" finished</summary>
<result>compaction_manager.cpp:347 holds _candidates_mutex then takes _tasks_mutex</result>
<usage>input 12000 output 3400</usage>
</task-notification>`;

describe('isInjectedUserTurn', () => {
  it('accepts a typed prompt as a human message', () => {
    expect(isInjectedUserTurn({ promptSource: 'typed' }, 'why did it stall')).toBe(false);
  });

  it('accepts a queued prompt as a human message', () => {
    expect(isInjectedUserTurn({ promptSource: 'queued' }, 'why did it stall')).toBe(false);
  });

  it('rejects a system-sourced prompt even when the text looks ordinary', () => {
    expect(isInjectedUserTurn({ promptSource: 'system' }, 'plain looking text')).toBe(true);
  });

  it('rejects a meta entry', () => {
    expect(isInjectedUserTurn({ isMeta: true }, 'plain looking text')).toBe(true);
  });

  it('falls back to text markers when the transcript carries no promptSource', () => {
    expect(isInjectedUserTurn({}, NOTIFICATION)).toBe(true);
    expect(isInjectedUserTurn({}, '<command-name>/model</command-name>')).toBe(true);
    expect(isInjectedUserTurn({}, 'a real question about compaction')).toBe(false);
  });
});

describe('payloadOfInjectedTurn', () => {
  it('keeps the agent report, which is often the most valuable text in the record', () => {
    const payload = payloadOfInjectedTurn(NOTIFICATION);

    expect(payload).toContain('compaction_manager.cpp:347');
    expect(payload).toContain('/code-review be/src/storage');
  });

  it('drops the identifiers, the temp path and the token counts', () => {
    const payload = payloadOfInjectedTurn(NOTIFICATION);

    expect(payload).not.toContain('a8c6012950e24d63f');
    expect(payload).not.toContain('toolu_01LkKbGVDKgciW974uWuEK9b');
    expect(payload).not.toContain('/private/tmp');
    expect(payload).not.toContain('input 12000');
  });

  it('drops the explanatory note, which is the same text on every notification', () => {
    const text =
      '<task-notification><summary>Agent finished</summary>' +
      '<note>A task-notification fires each time this agent stops with no live background children.</note>' +
      '<result>lock ordering inversion confirmed</result></task-notification>';

    const payload = payloadOfInjectedTurn(text);

    expect(payload).toContain('lock ordering inversion confirmed');
    expect(payload).not.toContain('A task-notification fires');
  });

  it('reduces a slash command echo to the command and its arguments', () => {
    const text = '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>';

    expect(payloadOfInjectedTurn(text)).toBe('/model opus');
  });

  it('keeps the text a local command printed', () => {
    const text = '<local-command-stdout>Set model to Fable 5.1</local-command-stdout>';

    expect(payloadOfInjectedTurn(text)).toBe('Set model to Fable 5.1');
  });

  it('empties a system reminder, which is an instruction to the model and not content', () => {
    expect(payloadOfInjectedTurn('<system-reminder>be careful out there</system-reminder>')).toBe('');
  });
});

describe('parseConversation', () => {
  it('records a typed question unchanged', async () => {
    const file = transcript([
      userTurn('why did the compaction stall', { promptSource: 'typed' }),
      assistantTurn('the thread pool was saturated'),
    ]);

    const [exchange] = await parseConversation(file, 'proj', file);

    expect(exchange.userMessage).toBe('why did the compaction stall');
    expect(exchange.userIsInjected).toBe(false);
  });

  it('normalises an injected turn instead of storing the raw blob', async () => {
    const file = transcript([
      userTurn(NOTIFICATION, { promptSource: 'system' }),
      assistantTurn('BE code review done, 14 findings confirmed'),
    ]);

    const [exchange] = await parseConversation(file, 'proj', file);

    expect(exchange.userIsInjected).toBe(true);
    expect(exchange.userMessage).toContain('compaction_manager.cpp:347');
    expect(exchange.userMessage).not.toContain('a8c6012950e24d63f');
    expect(exchange.userMessage.length).toBeLessThan(NOTIFICATION.length);
  });

  it('keeps the assistant reply to an injected turn, which is real content', async () => {
    const file = transcript([
      userTurn('<system-reminder>noise</system-reminder>', { isMeta: true }),
      assistantTurn('the lock ordering bug is real and here is why'),
    ]);

    const [exchange] = await parseConversation(file, 'proj', file);

    expect(exchange.userMessage).toBe('');
    expect(exchange.assistantMessage).toBe('the lock ordering bug is real and here is why');
  });
});

// Summaries for Codex conversations, through `codex app-server` (JSON-RPC over
// stdio). We fork the original thread ephemerally so the model has its own
// context; when the thread is gone we start a fresh one and send the text.
// Mirrors episodic-memory's client. Not yet verified against a real Codex on
// this machine: test/fixtures/fake-codex-app-server.mjs speaks the same subset.
// Design doc archive-and-summaries §05.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { SUMMARY_PROMPT, extractSummary } from './summaries.js';
import { summarizerEnv } from './summarizer-claude.js';

export const MIN_CODEX_VERSION = '0.130.0';
const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

export function parseCodexVersion(output: string): string | undefined {
  return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}

export function versionAtLeast(version: string, minimum = MIN_CODEX_VERSION): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export interface CodexSummaryInput {
  /** The Codex session id, which app-server calls the thread id. */
  threadId?: string;
  transcript: string;
}

export interface CodexDeps {
  /** May carry leading arguments ("node fake.mjs"), so tests can stand in a script. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function command(bin: string): { cmd: string; args: string[] } {
  const [cmd, ...args] = bin.split(' ');
  return { cmd, args };
}

function readOutput(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => reject(new Error(`codex not found: ${e.message}`)));
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.trim()}`))
    );
  });
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void };
type Notification = {
  delta?: string;
  item?: { type?: string; text?: string };
  turn?: { id?: string; status?: string; error?: { message?: string } };
};

export async function summarizeWithCodex(input: CodexSummaryInput, deps: CodexDeps = {}): Promise<string> {
  const env = summarizerEnv(deps.env ?? process.env);
  const bin = deps.bin ?? env.STARMEMORY_CODEX_BIN ?? 'codex';
  const configured = Number(env.STARMEMORY_CODEX_SUMMARY_TIMEOUT_MS);
  const timeoutMs = deps.timeoutMs ?? (configured > 0 ? configured : 120_000);
  const { cmd, args } = command(bin);

  const versionOut = await readOutput(cmd, [...args, '--version'], env);
  const version = parseCodexVersion(versionOut);
  if (!version || !versionAtLeast(version)) {
    throw new Error(
      `Codex summarization requires codex-cli >= ${MIN_CODEX_VERSION}; found ${version ?? (versionOut.trim() || '(no version)')}. Run codex update and retry.`
    );
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, [...args, 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let answer = '';
    let turnId: string | undefined;
    let stderr = '';
    let done = false;
    const rl = readline.createInterface({ input: child.stdout });

    const finish = (error?: Error, text = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(text.trim());
    };
    const timer = setTimeout(
      () => finish(new Error(`Codex summarizer timed out after ${timeoutMs}ms ${stderr.trim()}`.trim())),
      timeoutMs
    );
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        pending.set(id, { method, resolve: res, reject: rej });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    const notify = (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`);

    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish(new Error(`codex not found: ${e.message}`)));
    child.on('exit', (code) =>
      finish(
        new Error(
          code === 0
            ? 'Codex app-server exited before the summary turn completed'
            : `codex app-server exited ${code}: ${stderr.trim()}`
        )
      )
    );

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; method?: string; result?: unknown; error?: unknown; params?: Notification };
      try {
        msg = JSON.parse(line);
      } catch {
        finish(new Error(`Codex app-server emitted invalid JSON: ${line}`));
        return;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const req = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) req.reject(new Error(`${req.method} failed: ${JSON.stringify(msg.error)}`));
        else req.resolve(msg.result);
        return;
      }
      const p = msg.params;
      if (msg.method === 'item/agentMessage/delta') {
        answer += p?.delta ?? '';
      } else if (msg.method === 'item/completed' && p?.item?.type === 'agentMessage') {
        answer = p.item.text ?? answer;
      } else if (msg.method === 'turn/completed' && (!turnId || p?.turn?.id === turnId)) {
        if (p?.turn?.status === 'completed') finish(undefined, extractSummary(answer) ?? answer);
        else finish(new Error(`Codex summarizer turn did not complete: ${p?.turn?.error?.message ?? p?.turn?.status}`));
      }
    });

    (async () => {
      try {
        await send('initialize', {
          clientInfo: { name: 'starmemory', title: 'StarMemory', version: PLUGIN_VERSION },
          capabilities: { experimentalApi: true },
        });
        notify('initialized');
        const threadOpts = { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' };
        let threadId: string | undefined;
        let prompt = SUMMARY_PROMPT;
        if (input.threadId) {
          try {
            const fork = (await send('thread/fork', { threadId: input.threadId, ...threadOpts })) as { thread?: { id?: string } };
            threadId = fork.thread?.id;
          } catch {
            threadId = undefined; // the original thread is gone; fall back to the text
          }
        }
        if (!threadId) {
          const fresh = (await send('thread/start', threadOpts)) as { thread?: { id?: string } };
          threadId = fresh.thread?.id;
          prompt = `${SUMMARY_PROMPT}\n\n${input.transcript}`;
        }
        if (!threadId) throw new Error('codex app-server returned no thread id');
        const turn = (await send('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, textElements: [] }],
        })) as { turn?: { id?: string } };
        turnId = turn.turn?.id;
        if (!turnId) throw new Error('turn/start returned no turn id');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

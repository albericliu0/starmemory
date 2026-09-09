// Speaks the subset of the codex app-server JSON-RPC that summarizer-codex.ts
// uses, so the client can be tested on a machine without Codex.
// FAKE_CODEX_MODE: 'ok' (default) | 'fork-fails' | 'turn-fails' | 'hang'.
import readline from 'node:readline';
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
if (process.argv[2] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.131.0'}`);
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  console.error('unexpected args');
  process.exit(2);
}
if (process.env.STARMEMORY_SUMMARIZER_GUARD !== '1') {
  console.error('guard missing');
  process.exit(3);
}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return out({ id: msg.id, result: { ok: true } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/fork') {
    if (mode === 'fork-fails') return out({ id: msg.id, error: { code: -32000, message: 'thread not found' } });
    return out({ id: msg.id, result: { thread: { id: 'forked-' + msg.params.threadId } } });
  }
  if (msg.method === 'thread/start') return out({ id: msg.id, result: { thread: { id: 'fresh-thread' } } });
  if (msg.method === 'turn/start') {
    const prompt = msg.params.input[0].text;
    out({ id: msg.id, result: { turn: { id: 'turn-1' } } });
    if (mode === 'hang') return;
    if (mode === 'turn-fails') {
      return out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: { message: 'model unavailable' } } } });
    }
    out({ method: 'item/agentMessage/delta', params: { delta: 'The user ' } });
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: prompt.includes('User:') ? '<summary>From transcript text.</summary>' : 'Sure. <summary>The user fixed a race.</summary>' } } });
    out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
});

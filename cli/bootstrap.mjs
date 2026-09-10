// Shared start-up path for both plugin entry points.
//
// A marketplace install is a git clone: it brings dist/ and the prebuilt addons
// (both committed) but not node_modules, which is 410 MB and platform-specific.
// So the first launch installs dependencies, the same approach episodic-memory
// takes. Everything here is dependency-free by necessity -- it runs before those
// dependencies exist.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  addonChecksumsUrl,
  addonDownloadUrl,
  addonRelativePath,
  expectedDigest,
  findMissingAddons,
  findMissingDeps,
  isSupportedPlatform,
  platformTag,
  unsupportedPlatformMessage,
} from './install-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Claude Code sets CLAUDE_PLUGIN_ROOT for an installed plugin. Falling back to
 * the parent of cli/ keeps `node cli/...` working from a plain checkout. */
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(here, '..');

function log(message) {
  process.stderr.write(`${message}\n`);
}

/** npm next to the node we are running under. Claude Code starts MCP servers
 * with a PATH that has neither node nor npm; run-node.sh found node for us, so
 * npm is almost certainly beside it. Fall back to PATH for the rare split. */
function findNpm() {
  // On Windows npm is npm.cmd, and cmd scripts need a shell to run; on POSIX
  // it is a shebang script beside node.
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const beside = path.join(path.dirname(process.execPath), name);
  return fs.existsSync(beside) ? beside : name;
}

function runNpmInstall(root) {
  return new Promise((resolve, reject) => {
    log('starmemory: installing dependencies (first run only, this takes a minute)...');
    // npm is a script with a `#!/usr/bin/env node` shebang, so node's directory
    // has to be on the child's PATH as well, not just known to us.
    const nodeDir = path.dirname(process.execPath);
    const fallbackPath = process.platform === 'win32' ? '' : '/usr/bin:/bin';
    const child = spawn(findNpm(), ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // path.delimiter: ':' on POSIX, ';' on Windows.
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || fallbackPath}` },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    // npm's progress goes to stderr so it cannot corrupt the MCP stdio channel.
    child.stdout.on('data', (d) => process.stderr.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        log('starmemory: dependencies installed.');
        resolve();
      } else {
        reject(new Error(`npm install exited with ${code}. Run it by hand in ${root}`));
      }
    });
  });
}

async function fetchOk(fetchImpl, url, what) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`could not download ${what}: HTTP ${response.status} from ${url}`);
  return response;
}

/** Fetch this platform's prebuilt addon from the release matching
 * package.json's version, and refuse it unless its SHA-256 matches the
 * release's SHA256SUMS. This is native code that the MCP server and the hook
 * load into their own process, so a truncated or tampered download must not
 * land. Written beside the target and renamed in: the file is not mapped by
 * anyone yet, so the rename is safe on Windows too. Throws with the URL in
 * the message on any failure, leaving no partial file behind. Design doc
 * windows-support §04. */
export async function downloadAddon(root, { version, tag = platformTag(), fetchImpl = fetch, log: report = log } = {}) {
  const url = addonDownloadUrl(version, tag);
  const target = path.join(root, addonRelativePath(tag));
  const fileName = path.basename(target);
  report(`starmemory: fetching the ${tag} native addon from ${url} (first run only)...`);

  const sums = await (await fetchOk(fetchImpl, addonChecksumsUrl(version), 'the release checksums')).text();
  const expected = expectedDigest(sums, fileName);
  if (!expected) throw new Error(`the release's SHA256SUMS has no entry for ${fileName}; not installing an unverifiable binary`);

  const bytes = Buffer.from(await (await fetchOk(fetchImpl, url, 'the native addon')).arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`the downloaded ${fileName} does not match the release checksum (got ${actual.slice(0, 12)}..., expected ${expected.slice(0, 12)}...); not installing it`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.${process.pid}.part`;
  try {
    fs.writeFileSync(part, bytes);
    fs.renameSync(part, target);
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
  report(`starmemory: native addon saved to ${target} (sha256 verified)`);
  return target;
}

function packageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** Make the plugin runnable, or explain why it cannot be.
 *
 * Returns true when it is safe to start. `quiet` is for the SessionStart hook:
 * a background sync that cannot run should say so once and get out of the way,
 * not fail loudly in the middle of someone's session. */
export async function ensureReady({ root = PLUGIN_ROOT, quiet = false } = {}) {
  if (!isSupportedPlatform()) {
    if (!quiet) log(unsupportedPlatformMessage());
    return false;
  }

  if (findMissingAddons(root).length > 0) {
    // Only darwin-arm64 is committed; every other platform's binary is a
    // release asset, fetched once and kept.
    try {
      await downloadAddon(root, { version: packageVersion(root), log: quiet ? () => {} : log });
    } catch (error) {
      if (!quiet) {
        log(`starmemory: ${error.message}`);
        log('starmemory: no network, or no release for this platform yet. To build it yourself: `npm run build` (needs a Rust toolchain).');
      }
      return false;
    }
    if (findMissingAddons(root).length > 0) {
      if (!quiet) log(`starmemory: native addon still missing after download: ${findMissingAddons(root).join(', ')}`);
      return false;
    }
  }

  if (findMissingDeps(root).length > 0) {
    try {
      await runNpmInstall(root);
    } catch (error) {
      if (!quiet) log(`starmemory: ${error.message}`);
      return false;
    }
    // Re-check rather than trusting the exit code: a partial install still
    // leaves us unable to start, and failing here beats failing after handoff.
    const stillMissing = findMissingDeps(root);
    if (stillMissing.length > 0) {
      if (!quiet) log(`starmemory: still missing after install: ${stillMissing.join(', ')}`);
      return false;
    }
  }

  return true;
}

/** Hand off to a script under dist/, forwarding signals so Claude Code can stop
 * it cleanly. Kept as a spawn rather than an import so the child gets a fresh
 * module resolution pass, now that node_modules definitely exists. */
export function handOff(relativeScript, args = [], { watchStdin = true } = {}) {
  const target = path.join(PLUGIN_ROOT, relativeScript);
  const child = spawn(process.execPath, [target, ...args], { stdio: 'inherit', shell: false });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  // Claude Code closes stdin when it goes away; without this the MCP server
  // lingers. A detached sync has no stdin at all (it is /dev/null, which ends
  // immediately), so it must opt out or it kills its own work on the spot.
  if (watchStdin) {
    process.stdin.on('end', () => {
      child.kill();
      process.exit(0);
    });
  }

  child.on('error', (error) => {
    log(`starmemory: failed to start ${relativeScript}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

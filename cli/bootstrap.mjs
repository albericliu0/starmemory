// Shared start-up path for both plugin entry points.
//
// A marketplace install is a git clone: it brings dist/ and the prebuilt addons
// (both committed) but not node_modules, which is 410 MB and platform-specific.
// So the first launch installs dependencies, the same approach episodic-memory
// takes. Everything here is dependency-free by necessity -- it runs before those
// dependencies exist.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findMissingAddons,
  findMissingDeps,
  isSupportedPlatform,
  unsupportedPlatformMessage,
} from './install-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Claude Code sets CLAUDE_PLUGIN_ROOT for an installed plugin. Falling back to
 * the parent of cli/ keeps `node cli/...` working from a plain checkout. */
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(here, '..');

function log(message) {
  process.stderr.write(`${message}\n`);
}

function runNpmInstall(root) {
  return new Promise((resolve, reject) => {
    log('starmemory: installing dependencies (first run only, this takes a minute)...');
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
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

  const missingAddons = findMissingAddons(root);
  if (missingAddons.length > 0) {
    if (!quiet) {
      log(`starmemory: prebuilt addons missing: ${missingAddons.join(', ')}`);
      log('starmemory: run `npm run build` in the plugin directory.');
    }
    return false;
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
export function handOff(relativeScript, args = []) {
  const target = path.join(PLUGIN_ROOT, relativeScript);
  const child = spawn(process.execPath, [target, ...args], { stdio: 'inherit', shell: false });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  // Claude Code closes stdin when it goes away; without this the server lingers.
  process.stdin.on('end', () => {
    child.kill();
    process.exit(0);
  });

  child.on('error', (error) => {
    log(`starmemory: failed to start ${relativeScript}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

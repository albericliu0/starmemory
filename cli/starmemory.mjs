#!/usr/bin/env node
// CLI entry point, and the one the SessionStart hook calls.
//
// A background sync that cannot run stays quiet: it is a best-effort refresh, so
// failing loudly in the middle of someone's session would be worse than skipping.
import { ensureReady, handOff } from './bootstrap.mjs';

const args = process.argv.slice(2);
const background = args.includes('--background');

if (!(await ensureReady({ quiet: background }))) {
  process.exit(background ? 0 : 1);
}

handOff('dist/cli.js', args);

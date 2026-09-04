// Pre-flight checks for the plugin entry points.
//
// These run BEFORE `npm install` has necessarily happened, so this file must
// stay dependency-free: node builtins only, no imports from dist/ or
// node_modules. Keeping the logic pure also makes it testable without spawning
// anything.
import fs from 'node:fs';
import path from 'node:path';

/** Packages `dist/` imports at runtime. Kept in step with package.json's
 * `dependencies` -- test/install-check.test.ts pins the list. */
export const RUNTIME_DEPENDENCIES = Object.freeze([
  '@huggingface/transformers',
  '@modelcontextprotocol/sdk',
  'lmdb',
  'zod',
]);

/** The compiled addon, relative to the plugin root. Tantivy BM25 and usearch
 * HNSW live in one Rust crate, so there is exactly one file. It ships prebuilt
 * for darwin-arm64 rather than being compiled on the user's machine. */
export const NATIVE_ADDONS = Object.freeze(['native/starmemory_native.node']);

/** The one platform this release carries binaries for. */
export const SUPPORTED_PLATFORM = Object.freeze({ os: 'darwin', cpu: 'arm64' });

/** Dependencies that are not usably installed under `root`.
 *
 * Probing each package's own package.json rather than just the node_modules
 * directory matters: a half-extracted package leaves the folder behind, passes
 * a bare existence check, and then fails with ERR_MODULE_NOT_FOUND after the
 * wrapper has already handed off to the server. */
export function findMissingDeps(root) {
  return RUNTIME_DEPENDENCIES.filter((name) => {
    const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    return !fs.existsSync(manifest);
  });
}

/** Prebuilt addons missing from `root`, as plugin-relative paths. */
export function findMissingAddons(root) {
  return NATIVE_ADDONS.filter((relative) => !fs.existsSync(path.join(root, relative)));
}

export function isSupportedPlatform(platform = process.platform, arch = process.arch) {
  return platform === SUPPORTED_PLATFORM.os && arch === SUPPORTED_PLATFORM.cpu;
}

export function unsupportedPlatformMessage(platform = process.platform, arch = process.arch) {
  return [
    `starmemory ships prebuilt binaries for ${SUPPORTED_PLATFORM.os}-${SUPPORTED_PLATFORM.cpu} only, but this machine is ${platform}-${arch}.`,
    'Nothing is broken -- this release just has no binaries for your platform yet.',
    'To use it here, build the two native addons from source and then run `npm run build`:',
    '  https://github.com/  (see BUILDING.md in the plugin directory)',
  ].join('\n');
}

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
  'zod',
]);

/** Platforms a release carries a prebuilt addon for, as `<platform>-<arch>`
 * tags. Tantivy BM25 and usearch HNSW live in one Rust crate, so there is one
 * file per platform: `native/starmemory_native.<tag>.node`. darwin-arm64 is
 * committed; the others are attached to the GitHub release and fetched on
 * first run (bootstrap.mjs). Design doc windows-support §03, §04. */
export const SUPPORTED_PLATFORMS = Object.freeze(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64']);

export function platformTag(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The addon for `tag`, relative to the plugin root. */
export function addonRelativePath(tag = platformTag()) {
  return `native/starmemory_native.${tag}.node`;
}

/** Kept for callers that still think in lists; one entry per current platform. */
export const NATIVE_ADDONS = Object.freeze([addonRelativePath()]);

/** Where a release keeps the addon for `tag`. The base is overridable so tests
 * (and a mirror) can point somewhere else. */
export const DEFAULT_ADDON_BASE_URL = 'https://github.com/albericliu0/starmemory/releases/download';

/** A base URL we are willing to download native code from: https, or plain
 * http only to the local machine (tests). Throws otherwise, so a hostile
 * environment variable cannot point the download at an http mirror. */
export function checkedAddonBaseUrl(base = process.env.STARMEMORY_ADDON_BASE_URL ?? DEFAULT_ADDON_BASE_URL) {
  const url = new URL(base);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`refusing to download the native addon over ${url.protocol.replace(':', '')} from ${url.host}; STARMEMORY_ADDON_BASE_URL must be https`);
  }
  return base.replace(/\/+$/, '');
}

export function addonDownloadUrl(version, tag = platformTag(), base) {
  return `${checkedAddonBaseUrl(base)}/v${version}/starmemory_native.${tag}.node`;
}

/** The checksum file the release carries beside the binaries: one
 * `<sha256>  <file name>` line per asset, as `sha256sum` writes them. */
export function addonChecksumsUrl(version, base) {
  return `${checkedAddonBaseUrl(base)}/v${version}/SHA256SUMS`;
}

/** The hex digest for `fileName` in a SHA256SUMS text, or undefined. */
export function expectedDigest(sumsText, fileName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return undefined;
}

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

/** Prebuilt addons missing from `root` for `tag`, as plugin-relative paths. */
export function findMissingAddons(root, tag = platformTag()) {
  const relative = addonRelativePath(tag);
  return fs.existsSync(path.join(root, relative)) ? [] : [relative];
}

export function isSupportedPlatform(platform = process.platform, arch = process.arch) {
  return SUPPORTED_PLATFORMS.includes(platformTag(platform, arch));
}

export function unsupportedPlatformMessage(platform = process.platform, arch = process.arch) {
  return [
    `starmemory ships prebuilt binaries for ${SUPPORTED_PLATFORMS.join(', ')}, but this machine is ${platformTag(platform, arch)}.`,
    'Nothing is broken -- this release just has no binaries for your platform yet.',
    'To use it here, build the native addon from source (Rust toolchain needed) and then run `npm run build`:',
    '  https://github.com/albericliu0/starmemory',
  ].join('\n');
}

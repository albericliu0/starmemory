// The embedding model cache. transformers.js keeps downloaded models under its
// own node_modules/.cache by default, which is inside the plugin install: every
// plugin update lands in a fresh directory and re-downloads the 160 MB model,
// so the first search after an update waits about 90 seconds. The cache
// belongs under ~/.config/starmemory with everything else, shared by every
// installed version and the dev checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { env as transformersEnv } from '@huggingface/transformers';
import {
  defaultModelCacheDir,
  legacyModelCacheDir,
  seedModelCache,
  seedStagingPath,
  MODEL_ID,
} from '../src/embeddings.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-model-cache-'));
}

describe('model cache location', () => {
  it('lives under ~/.config/starmemory by default', () => {
    expect(defaultModelCacheDir({})).toBe(path.join(os.homedir(), '.config', 'starmemory', 'models'));
  });

  it('follows STARMEMORY_MODEL_CACHE_PATH like the other paths', () => {
    expect(defaultModelCacheDir({ STARMEMORY_MODEL_CACHE_PATH: '/elsewhere/models' })).toBe('/elsewhere/models');
  });

  it('is where transformers.js is told to look once the embeddings module is loaded', () => {
    expect(transformersEnv.cacheDir).toBe(defaultModelCacheDir());
  });

  it('knows the old per-install location so an existing download is not thrown away', () => {
    expect(legacyModelCacheDir()).toMatch(/node_modules[\\/]@huggingface[\\/]transformers[\\/]\.cache$/);
    expect(fs.existsSync(path.dirname(legacyModelCacheDir()))).toBe(true);
  });
});

describe('seedModelCache', () => {
  it('copies the model from the old per-install cache when the shared one lacks it', () => {
    const legacy = tmp();
    const shared = tmp();
    const modelDir = path.join(legacy, MODEL_ID, 'onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model_quantized.onnx'), 'weights');
    fs.writeFileSync(path.join(legacy, MODEL_ID, 'config.json'), '{}');

    expect(seedModelCache(shared, legacy, MODEL_ID)).toBe(true);

    expect(fs.readFileSync(path.join(shared, MODEL_ID, 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('weights');
    expect(fs.existsSync(path.join(shared, MODEL_ID, 'config.json'))).toBe(true);
  });

  it('leaves a shared cache that already has the model alone', () => {
    const legacy = tmp();
    const shared = tmp();
    fs.mkdirSync(path.join(legacy, MODEL_ID), { recursive: true });
    fs.writeFileSync(path.join(legacy, MODEL_ID, 'config.json'), 'old');
    fs.mkdirSync(path.join(shared, MODEL_ID), { recursive: true });
    fs.writeFileSync(path.join(shared, MODEL_ID, 'config.json'), 'current');

    expect(seedModelCache(shared, legacy, MODEL_ID)).toBe(false);

    expect(fs.readFileSync(path.join(shared, MODEL_ID, 'config.json'), 'utf8')).toBe('current');
  });

  it('does nothing when there is no old cache to copy from', () => {
    const shared = tmp();

    expect(seedModelCache(shared, path.join(tmp(), 'missing'), MODEL_ID)).toBe(false);

    expect(fs.existsSync(path.join(shared, MODEL_ID))).toBe(false);
  });
});

describe('seedModelCache under a concurrent start', () => {
  // The SessionStart hook's sync and the MCP server start at the same moment
  // and both seed. A reader must never see a half-copied model under the real
  // name, so the copy goes to a staging directory and is renamed into place.
  it('leaves neither a partial model nor a staging directory when the copy fails midway', () => {
    const legacy = tmp();
    const shared = tmp();
    const modelDir = path.join(legacy, MODEL_ID);
    fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), 'weights');
    fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
    // A directory squatting where config.json must land makes the copy fail
    // after onnx/ is already across. (Not chmod: Windows has no unreadable
    // files, so that injection only fires on POSIX.)
    fs.mkdirSync(path.join(seedStagingPath(shared, MODEL_ID), 'config.json'), { recursive: true });

    expect(() => seedModelCache(shared, legacy, MODEL_ID)).toThrow();

    expect(fs.existsSync(path.join(shared, MODEL_ID))).toBe(false);
    // No `<model>.seed-<pid>` left behind next to where the model would go.
    expect(fs.readdirSync(path.dirname(path.join(shared, MODEL_ID)))).toEqual([]);
  });
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm run package` stages a full copy of the repo under build-pkg/, tests
    // included. Without this the suite runs twice and reports doubled counts.
    exclude: ['**/node_modules/**', '**/dist/**', 'build-pkg/**'],
  },
});

// Root-level vitest entry: without this, `npx vitest run` from the repo root
// collects all 19 test files but applies NEITHER workspace's config — the
// client's preact JSX preset and happy-dom environment are only discovered
// through src/client/vite.config.js, so every client test fails on import
// (react/jsx-dev-runtime) or environment (localStorage is not defined).
// `npm test` (workspaces) was never affected; this makes the root invocation
// match it.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['src/server', 'src/client'],
  },
});

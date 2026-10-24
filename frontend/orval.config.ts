import { defineConfig } from 'orval'

// Generates the typed API client from the committed contract bundle (ADR-0002, TOOLCHAIN §1, M3).
// Output goes to src/api/generated/, which is never edited by hand: regenerate with `npm run generate`.
// Every call goes through the one fetch wrapper in src/api/client.ts (M4 rules).
export default defineConfig({
  shri: {
    input: {
      target: '../contracts/openapi/dist/shri-health.bundled.yaml',
    },
    output: {
      mode: 'tags-split',
      target: 'src/api/generated/endpoints',
      schemas: 'src/api/generated/model',
      client: 'fetch',
      // Header parameters (Idempotency-Key, If-Match) become typed arguments.
      headers: true,
      clean: true,
      override: {
        mutator: {
          path: 'src/api/client.ts',
          name: 'apiFetch',
        },
      },
    },
  },
})

// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the demo shell. Two web servers are started for the run:
 *   1. the deterministic mock-hub (ws on :8787) — replays a scripted SNAPSHOT + drives
 *      the REAL reducer, so the client's full path is exercised with zero LLM nondeterminism;
 *   2. the Vite dev server (:5173) serving the demo client, which connects to ws://…:8787.
 * JSON + HTML reports land in e2e-results/; `scripts/e2e-report.mjs` turns the JSON into
 * the repo-root TEST_RESULTS.md.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-results/results.json' }],
    ['html', { outputFolder: 'e2e-results/html', open: 'never' }],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } }],
  webServer: [
    {
      command: 'node e2e/mock-hub.mjs',
      url: 'http://localhost:8787',
      reuseExistingServer: false,
      env: { PORT: '8787' },
      stdout: 'pipe',
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Conformance config — drives the REAL agent stack (NOT the mock hub). It assumes the full
 * demo is already running: start it first with `pnpm demo` (hub :8787 + agents + vite :5173,
 * with ANTHROPIC + GOOGLE keys in .env). Non-deterministic + slow + spends API calls, so:
 * workers=1, retries=0, long timeouts — a canary you run deliberately, not a CI gate.
 */
export default defineConfig({
  testDir: './conformance',
  testMatch: '**/conformance.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'conformance/results/_playwright.json' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } }],
  // No webServer: the real stack (hub + agents + vite) is started out-of-band by `pnpm demo`.
});

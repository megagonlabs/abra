// @ts-check
/**
 * Turn Playwright's JSON report (apps/demo/e2e-results/results.json) into the repo-root
 * TEST_RESULTS.md — a human-readable pass/fail summary. Runs after `test:e2e`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'apps/demo/e2e-results/results.json');
const outPath = join(root, 'TEST_RESULTS.md');

/** @param {any} node @param {(spec:any,file:string)=>void} visit */
function walk(node, visit, file = '') {
  const f = node.file || file;
  for (const spec of node.specs ?? []) visit(spec, f);
  for (const child of node.suites ?? []) walk(child, visit, f);
}

let report;
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch {
  writeFileSync(
    outPath,
    `# E2E Test Results\n\n> No report found at \`apps/demo/e2e-results/results.json\`.\n> Run \`pnpm test:e2e\` first.\n`,
  );
  console.log('no results.json — wrote placeholder TEST_RESULTS.md');
  process.exit(0);
}

/** @type {{file:string,title:string,ok:boolean,status:string,ms:number}[]} */
const rows = [];
for (const suite of report.suites ?? []) {
  walk(suite, (spec, file) => {
    const results = (spec.tests ?? []).flatMap((/** @type {any} */ t) => t.results ?? []);
    const ms = results.reduce(
      (/** @type {number} */ a, /** @type {any} */ r) => a + (r.duration ?? 0),
      0,
    );
    const status = results.every((/** @type {any} */ r) => r.status === 'passed')
      ? 'passed'
      : (results.find((/** @type {any} */ r) => r.status && r.status !== 'passed')?.status ??
        'unknown');
    rows.push({
      file: file.replace(/^.*\/e2e\//, 'e2e/'),
      title: spec.title,
      ok: !!spec.ok,
      status,
      ms,
    });
  });
}

const stats = report.stats ?? {};
const passed = rows.filter((r) => r.ok).length;
const failed = rows.length - passed;
const badge = failed === 0 ? `✅ ALL ${passed} PASSED` : `❌ ${failed} FAILED / ${passed} passed`;
const when = stats.startTime ? new Date(stats.startTime).toISOString() : 'n/a';
const totalMs = Math.round(stats.duration ?? rows.reduce((a, r) => a + r.ms, 0));

// group rows by file
/** @type {Record<string, typeof rows>} */
const byFile = {};
for (const r of rows) {
  byFile[r.file] ??= [];
  byFile[r.file].push(r);
}

const lines = [];
lines.push('# E2E Test Results');
lines.push('');
lines.push(`**${badge}**  ·  ${rows.length} tests  ·  ${totalMs} ms  ·  run: \`${when}\``);
lines.push('');
lines.push('> Deterministic demo e2e (Playwright + Chromium). A mock hub replays a scripted');
lines.push("> SNAPSHOT and drives the **real reducer**, so the client's full path");
lines.push('> (WS → store → views/chat/shell) is tested with zero LLM nondeterminism.');
lines.push('> Generated from `apps/demo/e2e-results/results.json` by `scripts/e2e-report.mjs`.');
lines.push('');
for (const [file, list] of Object.entries(byFile)) {
  lines.push(`### \`${file}\``);
  lines.push('');
  lines.push('| | test | status | time |');
  lines.push('|---|---|---|---|');
  for (const r of list) {
    lines.push(`| ${r.ok ? '✅' : '❌'} | ${r.title} | ${r.status} | ${Math.round(r.ms)} ms |`);
  }
  lines.push('');
}
lines.push('---');
lines.push('');
lines.push('## What this covers — substrate behavior for a given view spec');
lines.push(
  'The mock hub scripts the **wire frames** an agent *could* emit (not its reasoning) and',
);
lines.push(
  'drives the **real reducer**; a deterministic **stub owner** resolves consequences. So each',
);
lines.push("test asserts the CONTRACT's response, never an LLM's judgment.");
lines.push(
  '- **Consequence round-trip** — a `+Node` controller fires → pending → owner resolves → node added.',
);
lines.push(
  '- **Consequence matrix** — the same round-trip across `add_row` / `add_column` / `delete`.',
);
lines.push(
  '- **Cross-view coordination** — hover a node → its co-referent row lights (`ref` fan-out).',
);
lines.push(
  '- **Chat-driven update mid-interaction** — a pushed UPDATE reconciles into the live view.',
);
lines.push(
  '- **Validation** — the reducer REJECTS a mis-authored spec at CREATE (catalogue-driven per-wire validator; e.g. `layout:"circle"`).',
);
lines.push(
  '- **Broken-spec robustness** — a malformed value that slips through still renders without crashing.',
);
lines.push('');
lines.push('## Run it');
lines.push('```bash');
lines.push('pnpm test:e2e            # runs the suite + regenerates this file');
lines.push('pnpm test:e2e:ui         # interactive Playwright UI');
lines.push('open apps/demo/e2e-results/html/index.html   # full HTML report (traces on failure)');
lines.push('```');
lines.push('');
lines.push(
  'Harness: `apps/demo/e2e/mock-hub.mjs` (scripted hub) · `apps/demo/e2e/fixtures.mjs` (SNAPSHOT) · `apps/demo/playwright.config.js`.',
);
lines.push('');

writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(`wrote ${outPath} — ${badge}`);

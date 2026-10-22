// @ts-check
/**
 * Aggregate the per-run conformance results (apps/demo/conformance/results/run-*.json) into the
 * repo-root CONFORMANCE.md — per-property pass rate across the N runs, plus per-run detail.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps/demo/conformance/results');
const out = join(root, 'CONFORMANCE.md');

let files = /** @type {string[]} */ ([]);
try {
  files = readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort();
} catch {
  /* no results dir */
}
if (!files.length) {
  writeFileSync(
    out,
    '# Conformance Results\n\n> No runs found. Start the demo (`pnpm demo`), then `pnpm test:conformance`.\n',
  );
  console.log('no conformance runs — wrote placeholder');
  process.exit(0);
}

const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

// aggregate by property id
/** @type {Record<string,{pass:number,fail:number,skip:number,notes:string[]}>} */
const agg = {};
for (const r of runs) {
  for (const fnd of r.findings) {
    agg[fnd.prop] ??= { pass: 0, fail: 0, skip: 0, notes: [] };
    const a = agg[fnd.prop];
    a[/** @type {'pass' | 'fail' | 'skip'} */ (fnd.status)] += 1;
    if (fnd.status === 'fail') a.notes.push(`run${r.run} [${fnd.canvas}] ${fnd.note}`);
  }
}

const lines = [];
lines.push('# Conformance Results');
lines.push('');
lines.push(`**${runs.length} runs** · query: _${runs[0].query}_`);
lines.push('');
lines.push('> Property-based e2e against the REAL agent stack — for whatever the agents authored,');
lines.push(
  '> do the catalogue-declared invariants hold? Non-deterministic canary. Properties: `apps/demo/conformance/properties.mjs`.',
);
lines.push('');
lines.push('## Property pass rate (across runs)');
lines.push('');
lines.push('| property | pass | fail | skip |');
lines.push('|---|---|---|---|');
for (const [prop, a] of Object.entries(agg).sort()) {
  const badge = a.fail ? '❌' : a.pass ? '✅' : '—';
  lines.push(`| ${badge} \`${prop}\` | ${a.pass} | ${a.fail} | ${a.skip} |`);
}
lines.push('');
// failures detail
const fails = Object.entries(agg).filter(([, a]) => a.fail);
if (fails.length) {
  lines.push('## Failures');
  lines.push('');
  for (const [prop, a] of fails) {
    lines.push(`- **${prop}**`);
    for (const n of a.notes.slice(0, 10)) lines.push(`  - ${n}`);
  }
  lines.push('');
}
// per-run
lines.push('## Per run');
lines.push('');
for (const r of runs) {
  const nfail = r.findings.filter((/** @type {any} */ f) => f.status === 'fail').length;
  const cvs = r.canvases.map((/** @type {any} */ c) => `${c.view}`).join(', ') || '(none)';
  lines.push(
    `- **run ${r.run}** — canvases: ${cvs} · ${nfail ? `❌ ${nfail} fail` : '✅ clean'}${r.pageErrors.length ? ` · ${r.pageErrors.length} page errors` : ''}`,
  );
}
lines.push('');
lines.push(
  'Run: `pnpm demo` (stack up), then `pnpm test:conformance`. Tune with `CONF_RUNS=3 CONF_QUERY="…"`.',
);
lines.push('');

writeFileSync(out, `${lines.join('\n')}\n`);
const totalFail = Object.values(agg).reduce((n, a) => n + a.fail, 0);
console.log(
  `wrote ${out} — ${totalFail ? `❌ ${totalFail} property failures` : '✅ all properties held'}`,
);

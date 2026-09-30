#!/usr/bin/env node
// Run the same scan n8n runs, locally. Useful for testing settings and slugs.
//
//   npm run scan                  new matches since the last local run (state in .state/)
//   npm run scan -- --fresh       ignore saved state (shows everything currently open)
//   npm run scan -- --dry-run     don't save state
//   npm run scan -- --dropped     also list target roles that were filtered out, and why
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HJF, parseCsv, uniqueCompanies, fetchAll, toCsv, loadSettings } from './common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const settings = loadSettings(root);
const { companies } = uniqueCompanies(parseCsv(readFileSync(join(root, 'config/companies.csv'), 'utf8')));
const statePath = join(root, '.state/state.json');
const state = !args.has('--fresh') && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

const boards = await fetchAll(companies);

const now = new Date().toISOString();
const result = HJF.processBoards(boards, settings, state, now);
const s = result.stats;

console.log(`\n${s.newMatches} new match(es) · ${s.companies} companies · ${s.jobsScanned} postings scanned · ${s.dropped} target roles filtered out · ${s.boardErrors} board errors\n`);
for (const r of result.rows) {
  console.log(`fit ${String(r.match_score).padStart(3)} · posting ${String(r.posting_score).padStart(3)} · ${r.ghost_risk.padEnd(6)} ${r.title} — ${r.company} (${r.location})`);
  if (r.matched_skills || r.missing_skills) console.log(`      has: ${r.matched_skills || '—'}${r.missing_skills ? '  |  gaps: ' + r.missing_skills : ''}`);
  console.log(`      ${r.signals}${r.red_flags ? '  ⚠ ' + r.red_flags : ''}`);
  console.log(`      ${r.url}`);
}
if (args.has('--dropped') && result.dropped.length) {
  console.log('\nFiltered out:');
  for (const d of result.dropped) console.log(`  ✗ ${d.title} — ${d.company}: ${d.reason}`);
}
if (result.errors.length) {
  console.log('\nBoard errors (fix the slug or set active=FALSE):');
  for (const e of result.errors) console.log(`  ! ${e.company} (${e.ats}/${e.slug}): ${e.error}`);
}

mkdirSync(join(root, 'output'), { recursive: true });
const day = now.slice(0, 10);
if (result.rows.length) writeFileSync(join(root, `output/new-jobs-${day}.csv`), toCsv(result.rows));
writeFileSync(join(root, `output/digest-${day}.html`), HJF.buildDigest(result, settings, now).html);
console.log(`\nWrote output/digest-${day}.html${result.rows.length ? ` and output/new-jobs-${day}.csv` : ''}`);

if (!args.has('--dry-run')) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

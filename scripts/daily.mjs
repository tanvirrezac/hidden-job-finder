#!/usr/bin/env node
// Daily run for GitHub Actions: scan every company board, keep postings from
// the last ~24 hours that pass the ghost-job checks, and append them to the
// Google Sheet — never adding a row that's already there.
//
// Env:
//   GOOGLE_SERVICE_ACCOUNT_JSON  service-account key (the whole JSON file contents)
//   SHEET_ID                     the ID in the sheet URL: /spreadsheets/d/<SHEET_ID>/edit
//   DRY_RUN=1                    optional: scan and print, don't write to the sheet or state
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HJF, parseCsv, tableToObjects, uniqueCompanies, fetchAll, loadSettings } from './common.mjs';
import { connectSheets } from './sheets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const JOBS_HEADER = readFileSync(join(root, 'config/jobs-sheet-header.csv'), 'utf8').trim().split(',');
const COMPANIES_HEADER = ['company', 'ats', 'slug', 'employees', 'country', 'active', 'notes'];
const RUNS_HEADER = ['run_at', 'companies', 'postings_scanned', 'new_rows_added', 'skipped_already_in_sheet', 'filtered_out', 'board_errors'];

const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');

/**
 * Given the Jobs tab contents and new candidate rows, return only rows that
 * are not already in the sheet (by job_key or URL) and not duplicated within
 * the batch, plus the header to use (existing columns kept, missing ones added).
 */
export function uniqueNewRows(existingValues, candidates) {
  let header = (existingValues[0] || []).map((h) => String(h).trim());
  const hasHeader = header.some(Boolean);
  if (!hasHeader) header = [...JOBS_HEADER];
  const missing = JOBS_HEADER.filter((h) => !header.includes(h));
  const newHeader = [...header, ...missing];

  const keyIdx = header.indexOf('job_key');
  const urlIdx = header.indexOf('url');
  const seenKeys = new Set();
  const seenUrls = new Set();
  for (const row of existingValues.slice(hasHeader ? 1 : 0)) {
    if (keyIdx >= 0 && row[keyIdx]) seenKeys.add(String(row[keyIdx]).trim());
    if (urlIdx >= 0 && row[urlIdx]) seenUrls.add(normUrl(row[urlIdx]));
  }

  const fresh = [];
  let skipped = 0;
  for (const r of candidates) {
    const k = String(r.job_key).trim();
    const u = normUrl(r.url);
    if (seenKeys.has(k) || (u && seenUrls.has(u))) { skipped++; continue; }
    seenKeys.add(k);
    if (u) seenUrls.add(u);
    fresh.push(r);
  }
  return {
    header: newHeader,
    headerChanged: !hasHeader || missing.length > 0,
    values: fresh.map((r) => newHeader.map((h) => (r[h] == null ? '' : r[h]))),
    added: fresh,
    skipped,
  };
}

/** One full run. `sheets` may be null for a dry run. */
export async function runDaily({ sheets, settings, state, now, fetchBoards = fetchAll, log = console.log }) {
  // 1. Companies: from the sheet's Companies tab; seed that tab from the repo list if it's missing/empty.
  let companyRows = [];
  if (sheets) {
    const tabs = await sheets.tabTitles();
    for (const t of ['Companies', 'Jobs', 'Runs']) if (!tabs.includes(t)) { await sheets.addTab(t); log(`Created tab "${t}"`); }
    companyRows = tableToObjects(await sheets.getValues('Companies!A:Z'));
    if (!companyRows.length) {
      const seed = parseCsv(readFileSync(join(root, 'config/companies.csv'), 'utf8'));
      await sheets.setValues('Companies!A1', [COMPANIES_HEADER, ...seed.map((c) => COMPANIES_HEADER.map((h) => c[h] ?? ''))]);
      log(`Seeded Companies tab with ${seed.length} companies from config/companies.csv`);
      companyRows = seed;
    }
  } else {
    companyRows = parseCsv(readFileSync(join(root, 'config/companies.csv'), 'utf8'));
  }
  const { companies, skipped: skippedCompanies } = uniqueCompanies(companyRows);
  for (const s of skippedCompanies) log(`  skipped company row — ${s}`);

  // 2. Scan and score.
  const boards = await fetchBoards(companies);
  const result = HJF.processBoards(boards, settings, state, now);

  // 3. Append only rows that aren't already in the sheet.
  let added = result.rows;
  let skippedExisting = 0;
  if (sheets) {
    const existing = await sheets.getValues('Jobs!A:ZZ');
    const u = uniqueNewRows(existing, result.rows);
    if (u.headerChanged) await sheets.setValues('Jobs!A1', [u.header]);
    await sheets.appendValues('Jobs!A1', u.values);
    added = u.added;
    skippedExisting = u.skipped;

    const runsHead = await sheets.getValues('Runs!1:1');
    if (!runsHead.length) await sheets.setValues('Runs!A1', [RUNS_HEADER]);
    await sheets.appendValues('Runs!A1', [[
      now, result.stats.companies, result.stats.jobsScanned, added.length, skippedExisting, result.stats.dropped,
      result.errors.map((e) => `${e.company} (${e.ats}/${e.slug}): ${e.error}`).join(' | '),
    ]]);
  }
  return { result, added, skippedExisting };
}

async function main() {
  const dry = process.env.DRY_RUN === '1';
  const settings = loadSettings(root);
  const statePath = join(root, 'state/state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const now = new Date().toISOString();

  let sheets = null;
  if (!dry) {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.SHEET_ID) {
      console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON or SHEET_ID. Add them as GitHub repository secrets (see README), or run with DRY_RUN=1.');
      process.exit(1);
    }
    sheets = await connectSheets({ serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON, spreadsheetId: process.env.SHEET_ID });
  }

  const { result, added, skippedExisting } = await runDaily({ sheets, settings, state, now });
  const s = result.stats;
  const lines = [
    `## Hidden Job Finder — ${now.slice(0, 16).replace('T', ' ')} UTC`,
    `${added.length} new row(s) added · ${skippedExisting} already in sheet · ${s.companies} companies · ${s.jobsScanned} postings scanned · ${s.dropped} filtered out · ${s.boardErrors} board errors`,
    '',
    ...added.map((r) => `- **fit ${r.match_score}** · posting ${r.posting_score} · [${r.title}](${r.url}) — ${r.company}, ${r.location} · ${r.age_hours === '' ? '?' : r.age_hours + 'h'} old · ghost risk ${r.ghost_risk}`),
    ...(result.errors.length ? ['', '**Board errors** (fix the slug in the Companies tab, or set active to FALSE):', ...result.errors.map((e) => `- ${e.company} (${e.ats}/${e.slug}): ${e.error}`)] : []),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');

  if (!dry) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state) + '\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

#!/usr/bin/env node
// Find which public ATS board a company uses.
//
//   npm run probe -- "Neo Financial" helcim "Blackline Safety"
//   npm run probe -- --file candidates.txt        (one company name per line)
//
// Prints matches with the board's company name, open-role count and sample
// titles/locations so you can confirm it's the right employer, then a CSV
// block you can paste into your Companies sheet.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const HJF = require('../src/lib.js');

const PROBE_ORDER = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'breezy', 'recruitee', 'bamboohr'];

function slugVariants(name) {
  const base = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and');
  const words = base.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const noSuffix = words.filter((w) => !['inc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'llc', 'the'].includes(w));
  const set = new Set([
    noSuffix.join(''), noSuffix.join('-'), words.join(''),
    noSuffix.join('') + 'inc', noSuffix.join('') + 'hq',
  ]);
  return [...set].filter((s) => s && s.length > 2);
}

async function fetchBody(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'hidden-job-finder/1.0 (personal job search)' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  if (res.status !== 200) return null;
  return res.text();
}

async function probeOne(name) {
  const tries = [];
  for (const slug of slugVariants(name)) for (const ats of PROBE_ORDER) tries.push({ company: name, ats, slug });
  const results = await Promise.all(tries.map(async (company) => {
    try {
      const body = await fetchBody(HJF.requestFor(company).url);
      if (!body) return null;
      const parsed = HJF.parseBoard(company, body);
      if (company.ats === 'smartrecruiters' && parsed.jobs.length === 0) return null; // SR answers 200 for any slug
      const sample = parsed.jobs.slice(0, 3).map((j) => `${j.title} [${j.location || '?'}]`);
      const boardName = parsed.jobs.map((j) => j.companyName).find(Boolean) || '';
      return { ats: company.ats, slug: company.slug, openRoles: parsed.boardSize, boardName, sample };
    } catch { return null; }
  }));
  // Same board reachable under two slug spellings: keep the first.
  const seen = new Set();
  const hits = results.filter(Boolean).filter((h) => {
    const k = `${h.ats}:${h.openRoles}:${h.sample.join('|')}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => b.openRoles - a.openRoles);
  // Empty boards are often dormant accounts or unrelated slugs; only show them if nothing else was found.
  const live = hits.filter((h) => h.openRoles > 0);
  return live.length ? live : hits;
}

const args = process.argv.slice(2);
let names = args;
if (args[0] === '--file') names = readFileSync(args[1], 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
if (!names.length) { console.error('Usage: npm run probe -- "Company A" "Company B"  |  npm run probe -- --file names.txt'); process.exit(1); }

const csv = [];
const all = [];
for (let i = 0; i < names.length; i += 6) {
  const batch = names.slice(i, i + 6);
  all.push(...await Promise.all(batch.map(async (name) => ({ name, hits: await probeOne(name) }))));
}
for (const { name, hits } of all) {
  if (!hits.length) { console.log(`✗ ${name}: no public board found on supported ATSs`); continue; }
  for (const h of hits) {
    const note = h.openRoles === 0 ? ' — empty board: may be dormant or a different company' : '';
    console.log(`✓ ${name} → ${h.ats}/${h.slug}  (${h.openRoles} open${h.boardName ? `, board name "${h.boardName}"` : ''})${note}`);
    for (const s of h.sample) console.log(`    · ${s}`);
  }
  const h = hits[0];
  if (h.openRoles === 0) continue;
  csv.push(`${name.includes(',') ? `"${name}"` : name},${h.ats},${h.slug},,CA,TRUE,`);
}
if (csv.length) {
  console.log('\nPaste into your Companies sheet (verify each match first):');
  console.log('company,ats,slug,employees,country,active,notes');
  console.log(csv.join('\n'));
}

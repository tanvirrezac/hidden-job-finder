// Helpers shared by scan.mjs and daily.mjs.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const HJF = require('../src/lib.js');

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return tableToObjects(rows);
}

// [[header...], [row...], ...] → [{header: value}], skipping blank rows.
export function tableToObjects(rows) {
  const nonEmpty = rows.filter((r) => r && r.some((v) => String(v ?? '').trim()));
  if (!nonEmpty.length) return [];
  const [header, ...body] = nonEmpty;
  const keys = header.map((h) => String(h).trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, String(r[i] ?? '').trim()])));
}

export const isActive = (c) => !/^(false|no|0|n)$/i.test(String(c.active || 'TRUE'));

/** Active companies with a supported ATS, one entry per ats+slug (first wins). */
export function uniqueCompanies(list) {
  const seen = new Set();
  const out = [];
  const skipped = [];
  for (const c of list) {
    if (!c.company && !c.slug) continue;
    if (!isActive(c)) continue;
    if (!HJF.requestFor(c)) { skipped.push(`${c.company || '?'}: unsupported ats "${c.ats}" or missing slug`); continue; }
    const key = HJF.companyKey(c);
    if (seen.has(key)) { skipped.push(`${c.company}: duplicate of ${key}`); continue; }
    seen.add(key);
    out.push(c);
  }
  return { companies: out, skipped };
}

export async function fetchBoard(company) {
  const req = HJF.requestFor(company);
  if (!req) return { company, error: `unsupported ats "${company.ats}" or missing slug` };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(req.url, {
        headers: { Accept: 'application/json', 'User-Agent': 'hidden-job-finder/1.0 (personal job search)' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 200) return { company, body: await res.text() };
      if (res.status < 500 || attempt === 2) return { company, error: `HTTP ${res.status}` };
    } catch (e) {
      if (attempt === 2) return { company, error: e.message };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function fetchAll(companies, batchSize = 6) {
  const boards = [];
  for (let i = 0; i < companies.length; i += batchSize) {
    boards.push(...await Promise.all(companies.slice(i, i + batchSize).map(fetchBoard)));
  }
  return boards;
}

export const toCsv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c] ?? '')).join(','))].join('\n') + '\n';
};

/** config/settings.json with config/profile.json attached as settings.profile. */
export function loadSettings(root) {
  const settings = JSON.parse(readFileSync(join(root, 'config/settings.json'), 'utf8'));
  const profilePath = join(root, 'config/profile.json');
  if (existsSync(profilePath)) settings.profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  return settings;
}

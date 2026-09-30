import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { uniqueNewRows, runDaily, JOBS_HEADER } from '../scripts/daily.mjs';
import { connectSheets, makeJwt } from '../scripts/sheets.mjs';

const settings = JSON.parse(readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));

const row = (key, url, extra = {}) => ({ job_key: key, url, title: 'Data Analyst', company: 'Acme', posting_score: 80, ...extra });

test('uniqueNewRows: skips rows already in the sheet by job_key or URL, and duplicates within the batch', () => {
  const existing = [JOBS_HEADER, JOBS_HEADER.map((h) => (h === 'job_key' ? 'gh:acme:1' : h === 'url' ? 'https://x/2' : ''))];
  const u = uniqueNewRows(existing, [
    row('gh:acme:1', 'https://x/1'),   // same job_key as sheet
    row('gh:acme:2', 'https://X/2/'),  // same URL as sheet (case / trailing slash)
    row('gh:acme:3', 'https://x/3'),   // new
    row('gh:acme:3', 'https://x/3'),   // duplicate within this batch
  ]);
  assert.equal(u.added.length, 1);
  assert.equal(u.added[0].job_key, 'gh:acme:3');
  assert.equal(u.skipped, 3);
  assert.equal(u.headerChanged, false);
});

test('uniqueNewRows: keeps your own extra columns and column order', () => {
  const header = ['my_rating', ...JOBS_HEADER.filter((h) => h !== 'notes')];
  const u = uniqueNewRows([header], [row('k1', 'https://x/9')]);
  assert.deepEqual(u.header.slice(0, header.length), header);
  assert.ok(u.header.includes('notes'), 'missing column appended');
  assert.equal(u.headerChanged, true);
  assert.equal(u.values[0][u.header.indexOf('job_key')], 'k1');
  assert.equal(u.values[0][0], '', 'your column left blank');
});

test('uniqueNewRows: empty sheet gets the default header', () => {
  const u = uniqueNewRows([], [row('k1', 'u1')]);
  assert.deepEqual(u.header, JOBS_HEADER);
  assert.equal(u.headerChanged, true);
});

// In-memory stand-in for the Sheets API surface runDaily uses.
function fakeSheets(initial = {}) {
  const tabs = { ...initial };
  const tabOf = (r) => r.split('!')[0];
  return {
    tabs,
    async tabTitles() { return Object.keys(tabs); },
    async addTab(t) { tabs[t] = []; },
    async getValues(r) { const t = tabs[tabOf(r)] || []; return r.endsWith('1:1') ? t.slice(0, 1) : t.map((x) => [...x]); },
    async setValues(r, values) { const t = tabs[tabOf(r)]; values.forEach((v, i) => { t[i] = v; }); },
    async appendValues(r, values) { tabs[tabOf(r)].push(...values); },
  };
}

const board = (ids) => JSON.stringify({ meta: { total: 5 }, jobs: ids.map((id) => ({
  id, title: 'Business Analyst', location: { name: 'Calgary, AB' }, absolute_url: `https://acme.example/jobs/${id}`,
  first_published: new Date(Date.now() - 3 * 3600000).toISOString(), content: 'Salary $80,000 - $95,000. ' + 'Real role. '.repeat(120),
})) });

test('runDaily: creates tabs, seeds companies, appends rows, and never duplicates — even if state is lost', async () => {
  const sheets = fakeSheets({ Companies: [['company', 'ats', 'slug', 'active'], ['Acme', 'greenhouse', 'acme', 'TRUE'], ['Acme again', 'greenhouse', 'acme', 'TRUE']] });
  const fetchBoards = async (companies) => companies.map((company) => ({ company, body: board([1, 2]) }));
  const quiet = () => {};

  const state = {};
  const r1 = await runDaily({ sheets, settings, state, now: new Date().toISOString(), fetchBoards, log: quiet });
  assert.equal(r1.added.length, 2);
  assert.ok(sheets.tabs.Jobs && sheets.tabs.Runs, 'tabs created');
  assert.equal(sheets.tabs.Jobs.length, 3, 'header + 2 rows');
  assert.equal(r1.result.stats.companies, 1, 'duplicate company row scanned once');

  // Next day, same postings plus one new one, with the state file lost.
  const r2 = await runDaily({ sheets, settings, state: {}, now: new Date().toISOString(), fetchBoards: async (cs) => cs.map((company) => ({ company, body: board([1, 2, 3]) })), log: quiet });
  assert.equal(r2.added.length, 1, 'only job 3 is new');
  assert.equal(r2.skippedExisting, 2, 'jobs 1 and 2 were already in the sheet');
  assert.equal(sheets.tabs.Jobs.length, 4);
  const keys = sheets.tabs.Jobs.slice(1).map((r) => r[JOBS_HEADER.indexOf('job_key')]);
  assert.equal(new Set(keys).size, keys.length, 'all job_keys unique');
  assert.equal(sheets.tabs.Runs.length, 3, 'runs header + 2 runs');
});

test('runDaily: seeds an empty Companies tab from config/companies.csv', async () => {
  const sheets = fakeSheets({});
  await runDaily({ sheets, settings, state: {}, now: new Date().toISOString(), fetchBoards: async (cs) => cs.map((company) => ({ company, error: 'offline' })), log: () => {} });
  assert.ok(sheets.tabs.Companies.length > 30);
  assert.deepEqual(sheets.tabs.Companies[0], ['company', 'ats', 'slug', 'employees', 'country', 'active', 'notes']);
});

test('sheets client: signs a valid JWT and calls the right endpoints', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

  const jwt = makeJwt(sa, 1790000000);
  const [h, c, sig] = jwt.split('.');
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, sa.client_email);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 't' });
    if (url.includes('fields=sheets.properties.title')) return json({ sheets: [{ properties: { title: 'Jobs' } }] });
    if (url.includes('/values/')) return json({ values: [['a']] });
    return json({});
  };
  const sheets = await connectSheets({ serviceAccountJson: JSON.stringify(sa), spreadsheetId: 'SHEET123', fetchImpl });
  assert.deepEqual(await sheets.tabTitles(), ['Jobs']);
  await sheets.appendValues('Jobs!A1', [['x']]);
  assert.ok(calls.some((c) => c.startsWith('POST https://sheets.googleapis.com/v4/spreadsheets/SHEET123/values/Jobs!A1:append?valueInputOption=RAW')), calls.join('\n'));
});

test('sheets client: a 403 explains how to share the sheet', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const fetchImpl = async (url) => url.includes('oauth2')
    ? { ok: true, json: async () => ({ access_token: 't' }) }
    : { ok: false, status: 403, text: async () => 'PERMISSION_DENIED' };
  const sheets = await connectSheets({ serviceAccountJson: sa, spreadsheetId: 'S', fetchImpl });
  await assert.rejects(sheets.tabTitles(), /Share the sheet with bot@proj\.iam\.gserviceaccount\.com/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const HJF = require('../src/lib.js');
const defaults = { ...JSON.parse(readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8')), profile: JSON.parse(readFileSync(new URL('../config/profile.json', import.meta.url), 'utf8')) };
// Scoring tests use a wide age window; the 24-hour default is tested separately below.
const settings = { ...defaults, maxAgeDays: 45, requireKnownDate: false };

const NOW = '2026-09-29T13:00:00.000Z';
const daysAgo = (d) => new Date(new Date(NOW).getTime() - d * 86400000).toISOString();
const longText = (extra = '') => `${extra} ` + 'We are hiring an analyst to own reporting and planning. '.repeat(20);

const greenhouse = (jobs, total) => JSON.stringify({ jobs, meta: { total: total ?? jobs.length } });
const ghJob = (id, title, location, ageDays, content = longText(), pay = null) => ({
  id, title, location: { name: location }, absolute_url: `https://example.com/${id}`,
  first_published: daysAgo(ageDays), updated_at: daysAgo(0), content, company_name: 'Acme',
  pay_input_ranges: pay ? [{ min_cents: pay[0] * 100, max_cents: pay[1] * 100, currency_type: 'CAD' }] : [],
});
const acme = { company: 'Acme', ats: 'greenhouse', slug: 'acme', country: 'CA' };

test('fresh Calgary analyst role at a small company scores high', () => {
  const body = greenhouse([ghJob(1, 'Business Analyst', 'Calgary, AB', 2, longText(), [80000, 95000])], 6);
  const r = HJF.processBoards([{ company: acme, body }], settings, {}, NOW);
  assert.equal(r.rows.length, 1);
  assert.ok(r.rows[0].posting_score >= 90, `score ${r.rows[0].posting_score}`);
  assert.equal(r.rows[0].ghost_risk, 'Low');
  assert.equal(r.rows[0].location_tier, 'calgary');
  assert.match(r.rows[0].salary, /\$80,000/);
});

test('non-target titles and non-Canadian locations are ignored entirely', () => {
  const body = greenhouse([
    ghJob(1, 'Senior Software Engineer', 'Calgary, AB', 1),
    ghJob(2, 'Business Analyst', 'Austin, TX', 1),
    ghJob(3, 'Analytics Engineer', 'Toronto, ON', 1),
    ghJob(4, 'Director, FP&A', 'Toronto, ON', 1),
  ]);
  const r = HJF.processBoards([{ company: acme, body }], settings, {}, NOW);
  assert.equal(r.rows.length, 0);
  assert.equal(r.dropped.length, 0);
});

test('ghost signals: evergreen titles, stale posts and "not an existing vacancy" are dropped', () => {
  const body = greenhouse([
    ghJob(1, 'Financial Analyst - Future Opportunities', 'Calgary, AB', 1),
    ghJob(2, 'Data Analyst', 'Calgary, AB', 60),
    ghJob(3, 'Product Analyst', 'Calgary, AB', 2, longText('This posting is not for an existing vacancy.')),
  ]);
  const r = HJF.processBoards([{ company: acme, body }], settings, {}, NOW);
  assert.equal(r.rows.length, 0);
  const reasons = r.dropped.map((d) => d.reason).join(' | ');
  assert.match(reasons, /evergreen/);
  assert.match(reasons, /stale/);
  assert.match(reasons, /not an existing vacancy/);
});

test('agency and French-bilingual postings are penalised and flagged', () => {
  const body = greenhouse([ghJob(1, 'Business Analyst', 'Toronto, ON', 5, longText('We are recruiting on behalf of our client. Bilingual (English/French) required.'))], 6);
  const r = HJF.processBoards([{ company: acme, body }], { ...settings, minScore: 0 }, {}, NOW);
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0].red_flags, /agency/);
  assert.match(r.rows[0].red_flags, /language/);
  assert.equal(r.rows[0].ghost_risk, 'High');
});

test('big boards score lower than small ones', () => {
  const small = HJF.processBoards([{ company: acme, body: greenhouse([ghJob(1, 'Data Analyst', 'Toronto, ON', 5)], 8) }], { ...settings, minScore: 0 }, {}, NOW);
  const big = HJF.processBoards([{ company: { ...acme, slug: 'big' }, body: greenhouse([ghJob(1, 'Data Analyst', 'Toronto, ON', 5)], 200) }], { ...settings, minScore: 0 }, {}, NOW);
  assert.ok(small.rows[0].posting_score > big.rows[0].posting_score);
});

test('state: second run only reports new postings; later reposts are flagged', () => {
  const state = {};
  const day1 = greenhouse([ghJob(1, 'Data Analyst', 'Calgary, AB', 1)], 5);
  assert.equal(HJF.processBoards([{ company: acme, body: day1 }], settings, state, NOW).rows.length, 1);

  const later = new Date(new Date(NOW).getTime() + 86400000).toISOString();
  assert.equal(HJF.processBoards([{ company: acme, body: day1 }], settings, state, later).rows.length, 0, 'same job is not re-reported');

  const muchLater = new Date(new Date(NOW).getTime() + 20 * 86400000).toISOString();
  const repost = greenhouse([ghJob(2, 'Data Analyst', 'Calgary, AB', 0)], 5);
  const r = HJF.processBoards([{ company: acme, body: repost }], { ...settings, minScore: 0 }, state, muchLater);
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0].red_flags, /posted 1x before/);
});

test('two same-title openings on the same run are not treated as reposts', () => {
  const body = greenhouse([ghJob(1, 'Data Analyst', 'Calgary, AB', 1), ghJob(2, 'Data Analyst', 'Edmonton, AB', 1)], 5);
  const r = HJF.processBoards([{ company: acme, body }], settings, {}, NOW);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => !x.red_flags));
});

test('bad responses become board errors, not crashes', () => {
  const r = HJF.processBoards([
    { company: acme, body: '<html>not found</html>' },
    { company: { ...acme, slug: 'x' }, error: 'HTTP 404' },
    { company: { ...acme, ats: 'workday' }, body: '{}' },
  ], settings, {}, NOW);
  assert.equal(r.errors.length, 3);
});

test('each ATS parser handles its response shape', () => {
  const lever = HJF.parseBoard({ ats: 'lever', slug: 'x' }, JSON.stringify([{ id: 'a', text: 'Data Analyst', categories: { location: 'Calgary' }, createdAt: Date.parse(daysAgo(3)), hostedUrl: 'u', descriptionPlain: 'd', salaryRange: { min: 70000, max: 90000, currency: 'CAD', interval: 'per-year-salary' } }]));
  assert.equal(lever.jobs[0].title, 'Data Analyst');
  assert.match(lever.jobs[0].salary, /\$70,000/);

  const ashby = HJF.parseBoard({ ats: 'ashby', slug: 'x' }, JSON.stringify({ jobs: [{ id: 'b', title: 'FP&A Analyst', location: 'Toronto', isListed: true, publishedAt: daysAgo(1), jobUrl: 'u', descriptionPlain: 'd', compensation: { scrapeableCompensationSalarySummary: '$80K - $95K' } }, { id: 'c', title: 'Hidden', isListed: false }] }));
  assert.equal(ashby.jobs.length, 1);

  const bamboo = HJF.parseBoard({ ats: 'bamboohr', slug: 'acme' }, JSON.stringify({ meta: { totalCount: 1 }, result: [{ id: '7', jobOpeningName: 'Business Analyst', location: { city: 'Calgary', state: 'Alberta' } }] }));
  assert.equal(bamboo.jobs[0].url, 'https://acme.bamboohr.com/careers/7');
  assert.equal(bamboo.jobs[0].postedAt, null);

  const sr = HJF.parseBoard({ ats: 'smartrecruiters', slug: 'Acme' }, JSON.stringify({ totalFound: 1, content: [{ id: '9', name: 'Data Analyst', releasedDate: daysAgo(2), location: { city: 'Calgary', region: 'AB', country: 'ca' } }] }));
  assert.equal(sr.jobs[0].url, 'https://jobs.smartrecruiters.com/Acme/9');
});

test('location classification', () => {
  const c = { country: 'CA' };
  const cls = (location, remote = null, locationExtra = '') => (HJF.classifyLocation({ location, remote, locationExtra }, c, settings) || {}).tier;
  assert.equal(cls('Calgary, Alberta'), 'calgary');
  assert.equal(cls('Edmonton'), 'alberta');
  assert.equal(cls('Toronto, ON'), 'canada');
  assert.equal(cls('Remote - Canada'), 'remote-canada');
  assert.equal(cls('Remote'), 'remote-canada');
  assert.equal(cls('KOHO (CAN)'), 'canada');
  assert.equal(cls('New York, NY'), undefined);
  assert.equal(cls('Remote - US'), undefined);
  assert.equal(HJF.classifyLocation({ location: 'Remote' }, { country: 'US' }, settings), null);
});

test('default settings keep only postings from the last ~2 days (daily-run window)', () => {
  const body = greenhouse([
    ghJob(1, 'Business Analyst', 'Calgary, AB', 0),
    ghJob(2, 'Data Analyst', 'Calgary, AB', 1),
    ghJob(3, 'Financial Analyst', 'Calgary, AB', 3),
  ], 5);
  const r = HJF.processBoards([{ company: acme, body }], defaults, {}, NOW);
  assert.deepEqual(r.rows.map((x) => x.title).sort(), ['Business Analyst', 'Data Analyst']);
  assert.equal(typeof r.rows[0].age_hours, 'number');
});

test('undated boards: existing postings are a baseline on first scan; new ones appear next run', () => {
  const bamboo = { company: 'Bam', ats: 'bamboohr', slug: 'bam', country: 'CA' };
  const list = (ids) => JSON.stringify({ meta: { totalCount: ids.length }, result: ids.map((id) => ({ id: String(id), jobOpeningName: 'Business Analyst', location: { city: 'Calgary', state: 'Alberta' } })) });
  const state = {};
  const first = HJF.processBoards([{ company: bamboo, body: list([1]) }], defaults, state, NOW);
  assert.equal(first.rows.length, 0);
  assert.match(first.dropped[0].reason, /baseline/);
  const next = new Date(new Date(NOW).getTime() + 86400000).toISOString();
  const second = HJF.processBoards([{ company: bamboo, body: list([1, 2]) }], defaults, state, next);
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].job_key, 'bamboohr:bam:2');
});

test('match score: strong fit, gaps, knockouts and title-only', () => {
  const p = defaults.profile;
  const job = (title, description) => ({ title, description });
  const good = HJF.matchProfile(job('Business Analyst', 'Telecom company. 5+ years of experience. SQL, Power BI, Jira, requirements gathering, UAT, stakeholder management, Agile.'), p);
  assert.ok(good.score >= 85, `good ${good.score}`);
  assert.ok(good.matched.includes('SQL') && good.matched.includes('Power BI'));

  const gappy = HJF.matchProfile(job('Business Analyst', '12+ years of experience. Snowflake, Databricks, Workday, SharePoint required. Some SQL.'), p);
  assert.ok(gappy.score < good.score - 25, `gappy ${gappy.score}`);
  assert.ok(gappy.missing.includes('Snowflake') && gappy.missing.some((m) => /12\+ yrs/.test(m)));

  const cpa = HJF.matchProfile(job('Financial Analyst', 'CPA designation is required. SQL, Excel, forecasting, budgeting, variance analysis.'), p);
  assert.ok(cpa.score <= 40);
  assert.equal(cpa.missing[0], 'CPA required');
  const cpaAsset = HJF.matchProfile(job('Financial Analyst', 'CPA designation is an asset. SQL, Excel, forecasting, budgeting, variance analysis.'), p);
  assert.ok(cpaAsset.score > 40 && !cpaAsset.missing.includes('CPA required'));

  const titleOnly = HJF.matchProfile({ title: 'Product Manager', description: null }, p);
  assert.match(titleOnly.matched[0], /title only/);
});

test('required years parsing', () => {
  assert.deepEqual(HJF.requiredYears('Minimum 5+ years of relevant experience; 3 years SQL experience'), { min: 5, max: null });
  assert.deepEqual(HJF.requiredYears('1-3 years of experience in analytics'), { min: 1, max: 3 });
  assert.deepEqual(HJF.requiredYears('We have been around for 20 years.'), { min: null, max: null });
});

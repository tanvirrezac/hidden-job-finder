// Runs the Code nodes from the generated workflow JSON with a mock of n8n's
// runtime ($input, $('Node'), $getWorkflowStaticData), to catch errors that
// would otherwise only show up after importing into n8n.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('../workflows/hidden-job-finder.json', import.meta.url), 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function runCode(name, inputItems, outputs, staticData) {
  const $input = { all: () => inputItems, first: () => inputItems[0] };
  const $ = (n) => ({
    all: () => outputs[n],
    first: () => outputs[n][0],
    itemMatching: (i) => outputs[n][i],
  });
  const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', node(name).parameters.jsCode);
  return fn($input, $, () => staticData);
}

test('every node is wired and every Code node parses', () => {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, c] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const t of c.main[0]) assert.ok(names.has(t.node), t.node);
  }
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$input', '$', '$getWorkflowStaticData', n.parameters.jsCode), n.name);
  }
});

test('Settings → Build Requests → Score & Filter → outputs', async () => {
  const outputs = {};
  outputs.Settings = await runCode('Settings', [{ json: {} }], outputs, {});
  assert.ok(outputs.Settings[0].json.titleInclude.length > 5);

  // What the Google Sheets node returns for the Companies tab.
  const sheetRows = [
    { json: { row_number: 2, company: 'Acme', ats: 'Greenhouse', slug: 'acme', employees: '', country: 'CA', active: 'TRUE', notes: '' } },
    { json: { row_number: 3, company: 'Paused Co', ats: 'lever', slug: 'paused', active: 'FALSE' } },
    { json: { row_number: 4, company: 'Broken', ats: 'lever', slug: 'broken', active: 'TRUE' } },
  ];
  outputs['Build Requests'] = await runCode('Build Requests', sheetRows, outputs, {});
  assert.equal(outputs['Build Requests'].length, 2, 'inactive row skipped');
  assert.match(outputs['Build Requests'][0].json.url, /boards-api\.greenhouse\.io\/v1\/boards\/acme/);

  // What the HTTP Request node returns (text body, or an error with continueRegularOutput).
  const now = new Date().toISOString();
  const http = [
    { json: { body: JSON.stringify({ meta: { total: 4 }, jobs: [{ id: 11, title: 'Financial Analyst', location: { name: 'Calgary, AB' }, absolute_url: 'https://x/11', first_published: now, content: 'Salary $85,000 - $95,000. ' + 'Real role. '.repeat(120) }] }) } },
    { json: { error: { message: '404 - {"ok":false,"error":"Document not found"}' } } },
  ];
  const staticData = {};
  outputs['Score & Filter'] = await runCode('Score & Filter', http, outputs, staticData);
  const res = outputs['Score & Filter'][0].json;
  assert.equal(res.rows.length, 1);
  assert.equal(res.errors.length, 1);
  assert.match(res.subject, /1 new match/);
  assert.ok(staticData.hjf && Object.keys(staticData.hjf.jobs).length === 1, 'state saved to static data');

  const rows = await runCode('One Row per Job', outputs['Score & Filter'], outputs, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].json.company, 'Acme');

  const mail = await runCode('Only If News', outputs['Score & Filter'], outputs, {});
  assert.equal(mail.length, 1);

  // Second run: nothing new, no errors → no email, no sheet rows.
  const again = await runCode('Score & Filter', [http[0]], { ...outputs, 'Build Requests': [outputs['Build Requests'][0]] }, staticData);
  assert.equal(again[0].json.rows.length, 0);
  assert.equal((await runCode('Only If News', again, outputs, {})).length, 0);
});

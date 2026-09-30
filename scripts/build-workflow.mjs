#!/usr/bin/env node
// Assembles workflows/hidden-job-finder.json from src/ and config/settings.json.
//   npm run build            write the workflow
//   npm run build -- --check fail if the committed workflow is out of date (used in CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const lib = read('src/lib.js').replace(/\nif \(typeof module[^\n]*\n?$/, '\n');
const settings = { ...JSON.parse(read('config/settings.json')), profile: JSON.parse(read('config/profile.json')) };
const code = (file) => read(`src/n8n/${file}`).replace('/*LIB*/', () => lib).replace('/*SETTINGS*/', () => JSON.stringify(settings, null, 2)); // functions: lib contains $& patterns

const SHEET_ID = "={{ $('Settings').first().json.googleSheetId }}";

const nodes = [
  {
    id: 'a1f0c001-0000-4000-8000-000000000001',
    name: 'Weekday 7am',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * 1-5' }] } },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000002',
    name: 'Run manually',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 200],
    parameters: {},
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000003',
    name: 'Settings',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [240, 100],
    parameters: { jsCode: code('settings.js') },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000004',
    name: 'Read Companies',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position: [480, 100],
    parameters: {
      operation: 'read',
      documentId: { __rl: true, value: SHEET_ID, mode: 'id' },
      sheetName: { __rl: true, value: 'Companies', mode: 'name' },
      options: {},
    },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000005',
    name: 'Build Requests',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [720, 100],
    parameters: { jsCode: code('build-requests.js') },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000006',
    name: 'Fetch Job Boards',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [960, 100],
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 3000,
    parameters: {
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Accept', value: 'application/json' },
          { name: 'User-Agent', value: 'hidden-job-finder/1.0 (personal job search)' },
        ],
      },
      options: {
        batching: { batch: { batchSize: 4, batchInterval: 1500 } },
        response: { response: { responseFormat: 'text', outputPropertyName: 'body' } },
        timeout: 30000,
      },
    },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000007',
    name: 'Score & Filter',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1200, 100],
    parameters: { jsCode: code('score.js') },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000008',
    name: 'One Row per Job',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1440, 0],
    parameters: { jsCode: code('rows.js') },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000009',
    name: 'Append to Jobs Sheet',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position: [1680, 0],
    parameters: {
      operation: 'append',
      documentId: { __rl: true, value: SHEET_ID, mode: 'id' },
      sheetName: { __rl: true, value: 'Jobs', mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000010',
    name: 'Only If News',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1440, 220],
    parameters: { jsCode: code('only-if-news.js') },
  },
  {
    id: 'a1f0c001-0000-4000-8000-000000000011',
    name: 'Email Digest',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1680, 220],
    parameters: {
      sendTo: "={{ $('Settings').first().json.digestEmail }}",
      subject: '={{ $json.subject }}',
      emailType: 'html',
      message: '={{ $json.html }}',
      options: { appendAttribution: false },
    },
  },
];

const link = (...targets) => ({ main: [targets.map((node) => ({ node, type: 'main', index: 0 }))] });

const workflow = {
  id: 'hiddenJobFinder1', // needed for CLI import; re-importing updates the same workflow
  name: 'Hidden Job Finder',
  nodes,
  connections: {
    'Weekday 7am': link('Settings'),
    'Run manually': link('Settings'),
    Settings: link('Read Companies'),
    'Read Companies': link('Build Requests'),
    'Build Requests': link('Fetch Job Boards'),
    'Fetch Job Boards': link('Score & Filter'),
    'Score & Filter': link('One Row per Job', 'Only If News'),
    'One Row per Job': link('Append to Jobs Sheet'),
    'Only If News': link('Email Digest'),
  },
  settings: { executionOrder: 'v1', timezone: 'America/Edmonton' },
  pinData: {},
};

const out = JSON.stringify(workflow, null, 2) + '\n';
const target = join(root, 'workflows/hidden-job-finder.json');
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
  if (current !== out) { console.error('workflows/hidden-job-finder.json is out of date — run `npm run build` and commit.'); process.exit(1); }
  console.log('Workflow is up to date.');
} else {
  writeFileSync(target, out);
  console.log(`Wrote workflows/hidden-job-finder.json (${nodes.length} nodes)`);
}

/*LIB*/

// Pairs each HTTP response with the company that produced it, scores new
// postings against saved state, and returns one item with rows + digest.
const settings = $('Settings').first().json;
const requests = $('Build Requests').all();

const boards = $input.all().map((item, i) => {
  let company;
  try { company = $('Build Requests').itemMatching(i).json; } catch (e) { company = (requests[i] || {}).json; }
  const j = item.json || {};
  if (j.error) return { company, error: j.error.message || j.error.description || JSON.stringify(j.error) };
  return { company, body: j.body };
});

// Workflow static data persists between PRODUCTION runs (schedule trigger on an
// active workflow). Manual test runs don't save it, so every manual run
// behaves like a first run.
const staticData = $getWorkflowStaticData('global');
const state = staticData.hjf || {};
const now = new Date().toISOString();
const result = HJF.processBoards(boards, settings, state, now);
staticData.hjf = state;
staticData.lastRun = now;

const digest = HJF.buildDigest(result, settings, now);
return [{ json: { rows: result.rows, stats: result.stats, errors: result.errors, dropped: result.dropped, subject: digest.subject, html: digest.html } }];

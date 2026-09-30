# Hidden Job Finder

Every morning, a GitHub Action checks the career boards of the companies you choose and adds the **fresh (last ~24 hours), real-looking postings at smaller employers** to a Google Sheet — one row per job, never duplicated. These are the roles that don't get 1,000 applicants on LinkedIn.

It reads each company's job board directly from its applicant tracking system (Greenhouse, Lever, Ashby, SmartRecruiters, BambooHR, Breezy HR, Recruitee) through the public JSON feeds those careers pages already use. **No LinkedIn or Indeed.** A small company may still cross-post a role there; the edge here is seeing it within a day, at a company that gets fewer applicants to begin with.

```
GitHub Actions (daily) ─► read Companies tab ─► fetch each job board ─► score + ghost checks
                                   ─► append NEW rows to Jobs tab ─► log the run in Runs tab ─► commit state
```

**Why rows are always unique:** before appending, the script reads the Jobs tab and skips any posting whose `job_key` or URL is already there. It also keeps a "seen" file (`state/state.json`, committed after each run). Either check alone prevents duplicates, so even if the state file is lost, the sheet stays clean. Duplicate rows in the Companies tab (same ATS + slug) are scanned once.

## How it decides what's worth your time

Every posting whose **title** matches your target roles and whose **location** is in Canada gets a **posting score** from 0–100:

| Signal | Effect | Why |
|---|---|---|
| Posted within the last ~24 hours | +30 | Early applicants get read |
| Older than 2 days (`maxAgeDays`) | **dropped** | Not fresh; the daily run only wants what's new since yesterday |
| No post date and first time this board is scanned | **dropped** | Can't be proven fresh (BambooHR); new postings on that board are caught from the next run |
| ≤10 open roles on the board (or ≤50 employees) | +20 (scales down to −10 for large employers) | Small companies get fewer applicants |
| Calgary / Alberta / rest of Canada on-site or hybrid / remote-Canada | +15 / +12 / +8 / +3 | Remote roles draw national applicant pools |
| Salary shown | +10 | Real budget attached |
| States it's an **existing vacancy** | +5 | Ontario has required this disclosure since Jan 1, 2026 |
| Says it is **not** an existing vacancy | **dropped** | Pipeline posting |
| "Talent pool", "future opportunities", "dream job" in title | **dropped** | Evergreen resume collection |
| Pipeline wording in description | −20 | |
| Recruiting-agency wording ("on behalf of our client") | −15 | Not the employer |
| French/bilingual requirement | −25 | Configurable |
| Thin description (<800 chars) | −10 | Low-effort posts ghost more |
| Same title reposted by that company in the last 120 days | −15, **dropped** after 3 | Serial reposting |

Only postings with a posting score of **≥45** reach the sheet (`minScore`). Each one also gets a **ghost risk** label (Low / Medium / High) and a plain-English list of the signals behind its score.

**Honest limits:** no scanner can promise a posting is real or that you won't be ghosted. These are the signals that correlate with real, active hiring; the score ranks your time, it doesn't guarantee a reply. SmartRecruiters, BambooHR and Breezy list endpoints don't include descriptions, so the description checks (vacancy, agency, pipeline, language) can't run for those boards. BambooHR also has no post dates, so its jobs are dated from the first time the scanner sees them — which is why each BambooHR board needs one baseline run before it produces results.

## Match score: how well each job fits you

Every row also gets a **match_score** (0–100) against your profile in `config/profile.json`, plus the skills that matched and your gaps. It's separate from **posting_score** (is this a fresh, legit, low-competition posting?). Rows are sorted by match score.

| Part | Points | How |
|---|---|---|
| Title track | 30 | Your strong tracks (BA, FP&A, data/BI, product) 30; strategy/ops 20; other 12; −10 for staff/principal-level titles |
| Skills | 45 | Tools and practices the posting names that you have (tools count double) vs. tools it names that you lack. Sparse evidence scores lower |
| Domain | 10 | Posting mentions an industry you've worked in (telecom, SaaS, fintech/payments, retail, contact centre, energy…) |
| Experience | 15 | Required years vs. your 8. Asking 11+ lowers it; roles scoped at ≤3 years are flagged as overqualified |
| Hard requirements | cap at 40 | CPA, CFA or CBAP stated as *required* (not "an asset"). Security clearance and required people-management years are flagged as gaps |

`config/profile.json` is built from `master_resume.json` plus tools you confirmed in resume sessions that aren't written into the master resume yet (SAP, MS Access, MS Project, MongoDB, VBA, Salesforce, Dynamics 365, Monday.com, Power Automate, Copilot Studio, R). Keep it in step with your master resume: add tools under `tools` or `practices` only if you can back them up in an interview, and move anything you'd rather not claim to `lacks`. Commit the change; the next run uses it.

This is keyword matching, similar to an ATS scan, not a human read. Treat 70+ as "worth opening", and the gaps column as a head start on your honest-disclosure notes. Postings from SmartRecruiters, BambooHR and Breezy have no description in their feeds, so their match score is based on the title only (the row says so).

## Setup (about 30 minutes, one time)

### 1. Put this in a private GitHub repo

```bash
cd hidden-job-finder
git init && git add . && git commit -m "Hidden Job Finder"
gh repo create hidden-job-finder --private --source=. --push
```

(Or create an empty private repo on github.com, then `git remote add origin …` and `git push -u origin main`.)

### 2. Create the Google Sheet

Create a blank Google Sheet. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

You don't need to set up tabs: the first run creates **Companies** (seeded with the 39 employers in `config/companies.csv`), **Jobs** and **Runs**. From then on, edit the company list in the sheet.

### 3. Give the script access with a Google service account

A service account is a robot Google account that the GitHub Action signs in as.

1. Go to console.cloud.google.com → create a project (any name).
2. **APIs & Services → Library** → search "Google Sheets API" → **Enable**.
3. **IAM & Admin → Service Accounts → Create service account** (any name; skip the optional role steps).
4. Open it → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Treat it like a password.
5. Copy the service account's email (ends in `.iam.gserviceaccount.com`). In your Google Sheet, click **Share**, paste that email, give it **Editor**.

### 4. Add two GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the entire contents of the downloaded `.json` key file |
| `SHEET_ID` | the sheet ID from step 2 |

Then delete the key file from your Downloads folder.

### 5. Run it

Repo → **Actions → Daily job scan → Run workflow**. After a minute or two, check the sheet: Companies is filled in, and Runs has a line for the run. The run's summary page on GitHub also lists what was added.

From then on it runs by itself every day at 13:00 UTC (7:00 am Calgary in summer, 6:00 am in winter). GitHub can start scheduled runs up to about an hour late. To change the time, edit the `cron` line in `.github/workflows/daily.yml`.

Private repos get 2,000 free Actions minutes a month; each run takes one to two.

### What to expect

Fresh-postings-only is a narrow filter. On Sep 29, 2026, the 39 seed companies had 879 open postings between them and exactly **one** matched a target role within the last day. The list has to grow into the hundreds for this to produce a few leads a day — see below.

The Jobs tab's main columns are `match_score`, `posting_score`, `ghost_risk`, `age_hours`, `matched_skills`, `missing_skills` and the link. `status` and `notes` are empty for you. You can add your own columns anywhere; new rows fill the known columns and leave yours blank.

**If a run fails:** open the failed run on the Actions tab. A 403 means the sheet isn't shared with the service account email; a 404 means `SHEET_ID` is wrong. A board that stops working (company changed ATS) doesn't fail the run; it's listed in the Runs tab's `board_errors` column.

## Growing your company list

This list is the whole game: the scanner can only find what's on the boards you give it. Add companies continuously.

**Find the ATS and slug for a company** (needs Node 18+):

```bash
npm run probe -- "Helcim" "Neo Financial" "Arcurve"
npm run probe -- --file my-candidates.txt      # one company name per line
```

It tries each supported ATS, prints the board's name, open-role count and sample titles so you can confirm it's the right employer (slug collisions happen: `peloton` on Greenhouse is the fitness company, not the Calgary software firm), then prints CSV rows to paste into the Companies tab of your sheet.

**Discover companies you don't know yet** with Google searches like:

```
site:boards.greenhouse.io Calgary
site:jobs.lever.co Alberta
site:jobs.ashbyhq.com Canada "analyst"
site:bamboohr.com/careers Calgary
site:breezy.hr Alberta
```

The slug is in the URL: `jobs.lever.co/`**`altaml`**, `jobs.ashbyhq.com/`**`neofinancial`**, **`showpass`**`.bamboohr.com`.

Useful columns in the Companies tab:
- `employees` — if you know headcount (LinkedIn company page), fill it in; it's a better size signal than open-role count.
- `country` — `CA` means a bare "Remote" location is treated as remote-Canada.
- `active` — set `FALSE` to pause a company without deleting it.

The seed list in `config/companies.csv` (39 Canadian employers, verified live on Sep 29, 2026) is a starting point, weighted toward tech. Calgary's mid-size energy, utilities and financial firms mostly run Workday, Taleo or SuccessFactors, which this doesn't cover — see *Not supported*.

## Tuning

All settings live in `config/settings.json` (commit a change and the next daily run uses it). If you use the n8n version, run `npm run build` afterwards and re-import.

| Setting | Default | What it does |
|---|---|---|
| `titleInclude` / `titleExclude` | BA, FP&A, BI, product, strategy… / intern, director, engineer… | Whole-word title matching |
| `minScore` | 45 | Raise for fewer, stronger matches |
| `maxAgeDays` | 2 | Older postings are dropped. 2 days (not 1) so a run that GitHub starts late doesn't miss a job posted just after yesterday's run; already-logged jobs are never re-added |
| `requireKnownDate` | true | Drop undated postings on a board's first scan |
| `allowUS` | false | Set `true` to include US-located roles |
| `languagePenalty` | 25 | Set 0 to ignore bilingual requirements, 100 to drop them |
| `dropIfOpenRolesOver` | 250 | Boards bigger than this are skipped (unless you set `employees`) |
| `dropAfterReposts` | 3 | Serial-repost cutoff |

## Try it locally

```bash
npm run daily:dry                   # the daily run against config/companies.csv, printed, nothing written
npm run scan -- --fresh --dropped   # everything open now, plus what got filtered and why
npm test
```

`npm run scan` writes to `output/` and keeps its own local state in `.state/`, separate from the daily run's `state/`.

## Not supported

- **Workday, Taleo, SuccessFactors, iCIMS** — mostly large employers (off-target for this strategy) with no stable public feed. Use their own job alerts.
- **Workable, Rippling, Pinpoint** — no reliable public JSON feed at the time of writing. Watch those careers pages with a free page-change monitor (Visualping, or self-hosted changedetection.io) instead.
- **LinkedIn, Indeed, Glassdoor** — deliberately excluded; their terms prohibit scraping, and they're where the competition already is.

These public board feeds are what companies' own careers pages load. The workflow calls each board once per run, four at a time with a pause between batches.

## Alternative: run it in n8n instead

`workflows/hidden-job-finder.json` is the same scanner as an n8n workflow (Google Sheets + Gmail digest). Import it in n8n, connect Google Sheets and Gmail credentials, and set `googleSheetId` and `digestEmail` in its **Settings** node. `docker-compose.yml` starts a local n8n. Use one runner or the other, not both: the n8n version keeps its own "seen" memory and doesn't check the sheet for existing rows. The GitHub version is the recommended one.

## Repo layout

```
src/lib.js                  all parsing, scoring and ghost-detection logic
scripts/daily.mjs           the daily run (GitHub Actions) — scan, dedupe against the sheet, append
scripts/sheets.mjs          tiny Google Sheets client (service account, no dependencies)
.github/workflows/daily.yml the schedule
state/state.json            "seen" memory, committed by the Action (created on first run)
src/n8n/*.js                thin Code-node wrappers
config/settings.json        filters and thresholds
config/profile.json         your skills, gaps and tracks for the match score
config/companies.csv        seed company list for the Companies tab
workflows/…json             optional n8n version (generated; run npm run build)
scripts/probe.mjs           find a company's ATS + slug
scripts/scan.mjs            run the same scan locally
test/                       unit tests, sheet-uniqueness tests, n8n simulation
```

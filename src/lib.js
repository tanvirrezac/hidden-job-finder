/*
 * Hidden Job Finder — core logic.
 *
 * Plain JavaScript with no imports, because this exact file is inlined into
 * n8n Code nodes by scripts/build-workflow.mjs. It is also loaded by the local
 * CLI scripts and tests through the CommonJS export at the bottom.
 */
const HJF = (() => {
  const DAY_MS = 86400000;

  // ---------------------------------------------------------------- helpers
  const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;/g, '&');
  }

  // Greenhouse double-encodes HTML, so decode, strip tags, then decode again.
  function htmlToText(html) {
    if (!html) return '';
    const once = decodeEntities(html);
    return clean(decodeEntities(once.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ')));
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Whole-word, case-insensitive phrase matcher ("vp" won't match "mvp").
  function phraseRegex(phrases) {
    const parts = (phrases || []).filter(Boolean).map((p) => escapeRe(String(p).toLowerCase().trim()));
    if (!parts.length) return null;
    return new RegExp('(?:^|[^a-z0-9])(?:' + parts.join('|') + ')(?=$|[^a-z0-9])', 'i');
  }

  const firstMatch = (re, text) => {
    if (!re || !text) return null;
    const m = String(text).match(re);
    return m ? clean(m[0]).replace(/^[^a-z0-9]+/i, '') : null;
  };

  const normTitle = (t) =>
    clean(t).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9&+ ]/g, ' ').replace(/\s+/g, ' ').trim();

  const companyKey = (c) => `${String(c.ats).toLowerCase().trim()}:${String(c.slug).toLowerCase().trim()}`;

  function toIso(v) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const daysBetween = (aIso, bIso) => Math.floor((new Date(bIso) - new Date(aIso)) / DAY_MS);

  function money(n, cur) {
    if (n == null || isNaN(n)) return '';
    const v = Math.round(Number(n)).toLocaleString('en-US');
    if (!cur || cur === 'CAD') return '$' + v;
    if (cur === 'USD') return '$' + v + ' USD';
    return cur + ' ' + v;
  }

  // ------------------------------------------------------- ATS definitions
  // Each ATS: how to build its public URL, and how to turn its response into
  // { jobs: NormalizedJob[], boardSize: number }.
  const ATS = {
    greenhouse: {
      label: 'Greenhouse',
      url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true&pay_transparency=true`,
      parse(data) {
        const jobs = (data.jobs || []).map((j) => {
          const pay = (j.pay_input_ranges || [])[0];
          return {
            id: String(j.id),
            title: j.title,
            companyName: j.company_name || '',
            location: clean(j.location && j.location.name),
            locationExtra: (j.offices || []).map((o) => o.location || o.name).join('; '),
            remote: null,
            url: j.absolute_url,
            postedAt: toIso(j.first_published || j.updated_at),
            description: htmlToText(j.content),
            salary: pay ? `${money(pay.min_cents / 100, pay.currency_type)} – ${money(pay.max_cents / 100, pay.currency_type)}` : '',
            department: ((j.departments || [])[0] || {}).name || '',
          };
        });
        return { jobs, boardSize: (data.meta && data.meta.total) || jobs.length };
      },
    },

    lever: {
      label: 'Lever',
      url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
      parse(data) {
        const list = Array.isArray(data) ? data : [];
        const jobs = list.map((j) => {
          const cat = j.categories || {};
          const sr = j.salaryRange;
          const lists = (j.lists || []).map((l) => `${l.text || ''} ${htmlToText(l.content)}`).join(' ');
          return {
            id: String(j.id),
            title: j.text,
            companyName: '',
            location: clean(cat.location),
            locationExtra: [(cat.allLocations || []).join('; '), j.country || ''].join(' '),
            remote: j.workplaceType === 'remote' ? true : j.workplaceType ? false : null,
            url: j.hostedUrl,
            postedAt: toIso(j.createdAt),
            description: clean([j.openingPlain, j.descriptionPlain, lists, j.additionalPlain].join(' ')),
            salary: sr && sr.min ? `${money(sr.min, sr.currency)} – ${money(sr.max, sr.currency)}${sr.interval ? ' ' + String(sr.interval).replace('per-', '/') : ''}` : '',
            department: cat.team || '',
          };
        });
        return { jobs, boardSize: jobs.length };
      },
    },

    ashby: {
      label: 'Ashby',
      url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
      parse(data) {
        const jobs = (data.jobs || [])
          .filter((j) => j.isListed !== false)
          .map((j) => {
            const addr = (j.address && j.address.postalAddress) || {};
            const comp = j.compensation || {};
            return {
              id: String(j.id),
              title: j.title,
              companyName: '',
              location: clean(j.location),
              locationExtra: [
                (j.secondaryLocations || []).map((s) => s.location).join('; '),
                addr.addressLocality, addr.addressRegion, addr.addressCountry,
              ].filter(Boolean).join(' '),
              remote: j.isRemote === true || j.workplaceType === 'Remote' ? true : j.workplaceType ? false : null,
              url: j.jobUrl,
              postedAt: toIso(j.publishedAt),
              description: clean(j.descriptionPlain),
              salary: clean(comp.scrapeableCompensationSalarySummary || comp.compensationTierSummary || ''),
              department: j.department || '',
            };
          });
        return { jobs, boardSize: jobs.length };
      },
    },

    smartrecruiters: {
      label: 'SmartRecruiters',
      url: (slug) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
      parse(data, slug) {
        const jobs = (data.content || []).map((j) => {
          const loc = j.location || {};
          return {
            id: String(j.id),
            title: j.name,
            companyName: (j.company && j.company.name) || '',
            location: clean(loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ')),
            locationExtra: [loc.country === 'ca' ? 'Canada' : loc.country, loc.region].filter(Boolean).join(' '),
            remote: loc.remote === true ? true : loc.hybrid ? false : null,
            url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${j.id}`,
            postedAt: toIso(j.releasedDate),
            description: null, // list endpoint has no description; description checks are skipped
            salary: '',
            department: (j.department && j.department.label) || '',
          };
        });
        return { jobs, boardSize: data.totalFound || jobs.length };
      },
    },

    breezy: {
      label: 'Breezy HR',
      url: (slug) => `https://${encodeURIComponent(slug)}.breezy.hr/json`,
      parse(data) {
        const list = Array.isArray(data) ? data : [];
        const jobs = list.map((j) => {
          const loc = j.location || {};
          return {
            id: String(j.id),
            title: j.name,
            companyName: (j.company && j.company.name) || '',
            location: clean(loc.name),
            locationExtra: (j.locations || []).map((l) => [l.name, l.country && l.country.name].join(' ')).join('; ') +
              ' ' + ((loc.country && loc.country.name) || ''),
            remote: loc.is_remote === true ? true : loc.is_remote === false ? false : null,
            url: j.url,
            postedAt: toIso(j.published_date),
            description: null,
            salary: clean(j.salary),
            department: j.department || '',
          };
        });
        return { jobs, boardSize: jobs.length };
      },
    },

    recruitee: {
      label: 'Recruitee',
      url: (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
      parse(data) {
        const jobs = (data.offers || [])
          .filter((j) => !j.status || j.status === 'published')
          .map((j) => {
            const s = j.salary || {};
            return {
              id: String(j.id),
              title: j.title,
              companyName: j.company_name || '',
              location: clean(j.location || [j.city, j.country].filter(Boolean).join(', ')),
              locationExtra: [j.country, j.state_name, j.country_code].filter(Boolean).join(' '),
              remote: j.remote === true ? true : j.remote === false ? false : null,
              url: j.careers_url,
              postedAt: toIso(j.published_at || j.created_at),
              description: htmlToText(`${j.description || ''} ${j.requirements || ''}`),
              salary: s.min ? `${money(s.min, s.currency)} – ${money(s.max, s.currency)}${s.period ? ' /' + s.period : ''}` : '',
              department: j.department || '',
            };
          });
        return { jobs, boardSize: jobs.length };
      },
    },

    bamboohr: {
      label: 'BambooHR',
      url: (slug) => `https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`,
      parse(data, slug) {
        const jobs = (data.result || []).map((j) => {
          const loc = j.location || {};
          const ats = j.atsLocation || {};
          return {
            id: String(j.id),
            title: j.jobOpeningName,
            companyName: '',
            location: clean([loc.city, loc.state || ats.province || ats.state].filter(Boolean).join(', ')),
            locationExtra: clean([ats.city, ats.province, ats.state, ats.country].filter(Boolean).join(' ')),
            remote: j.isRemote === true ? true : null,
            url: `https://${slug}.bamboohr.com/careers/${j.id}`,
            postedAt: null, // BambooHR's list has no dates; the scanner's first-seen date is used instead
            description: null,
            salary: '',
            department: j.departmentLabel || '',
          };
        });
        return { jobs, boardSize: (data.meta && data.meta.totalCount) || jobs.length };
      },
    },
  };

  function requestFor(company) {
    const ats = ATS[String(company.ats || '').toLowerCase().trim()];
    if (!ats || !String(company.slug || '').trim()) return null;
    return { url: ats.url(String(company.slug).trim()) };
  }

  function parseBoard(company, body) {
    const ats = ATS[String(company.ats).toLowerCase().trim()];
    if (!ats) throw new Error(`Unsupported ATS "${company.ats}"`);
    let data = body;
    if (typeof body === 'string') {
      const t = body.trim();
      if (!t.startsWith('{') && !t.startsWith('[')) throw new Error('Response was not JSON (wrong slug, or the board moved)');
      data = JSON.parse(t);
    }
    return ats.parse(data, String(company.slug).trim());
  }

  // -------------------------------------------------------------- location
  const RE = {
    remote: /\bremote\b|work from home|\bwfh\b|télétravail/i,
    calgary: /\bcalgary\b|\bairdrie\b|\bcochrane\b|\bokotoks\b|\bchestermere\b/i,
    alberta: /\balberta\b|\bedmonton\b|\bred deer\b|\blethbridge\b|\bmedicine hat\b|\bgrande prairie\b|\bfort mcmurray\b|\bst\.? albert\b|\bsherwood park\b|,\s*AB\b|\bAB,/i,
    canada: /\bcanada\b|\bcanadian\b|\bontario\b|british columbia|\bqu[ée]bec\b|\bmanitoba\b|\bsaskatchewan\b|nova scotia|new brunswick|newfoundland|prince edward island|\btoronto\b|\bvancouver\b|\bmontr[ée]al\b|\bottawa\b|\bwinnipeg\b|\bregina\b|\bsaskatoon\b|\bhalifax\b|\bmississauga\b|\bkitchener\b|\bwaterloo,?\s*on|\bburnaby\b|\bkelowna\b|\boakville\b|\bmarkham\b|\bbrampton\b|\bgatineau\b|\bvictoria,?\s*bc|\bsurrey,?\s*bc|\blondon,?\s*on\b|\bhamilton,?\s*on\b/i,
    caProvinceAbbr: /(?:^|[\s,(])(ON|BC|QC|MB|SK|NS|NB|NL|PE|PEI|YT|NT|NU)(?:$|[\s,)])/,
    caCountryCode: /(?:^|\s)CA(?:$|\s)/,
    caShort: /(?:^|[\s,(])CAN(?:$|[\s,)])/,
    us: /\bunited states\b|\busa\b|\bu\.s\.|(?:^|[\s,(-])US(?:$|[\s,)-])/i,
  };

  function classifyLocation(job, company, settings) {
    const text = `${job.location || ''} ${job.locationExtra || ''}`;
    const remote = job.remote === true || RE.remote.test(job.location || '');
    const isCalgary = RE.calgary.test(text);
    const isAlberta = isCalgary || RE.alberta.test(text);
    const isCanada = isAlberta || RE.canada.test(text) || RE.caProvinceAbbr.test(text) || RE.caCountryCode.test(job.locationExtra || '') || RE.caShort.test(text);
    if (isCalgary && !remote) return { tier: 'calgary', label: 'Calgary area' };
    if (isAlberta && !remote) return { tier: 'alberta', label: 'Alberta' };
    if (isCanada && !remote) return { tier: 'canada', label: 'Canada (on-site/hybrid)' };
    if (isCanada && remote) return { tier: 'remote-canada', label: 'Remote (Canada)' };
    const companyIsCanadian = String(company.country || 'CA').trim().toUpperCase() === 'CA';
    const leftover = (job.location || '').replace(/remote|anywhere|hybrid|[-–,()/|]/gi, '').trim();
    if (remote && companyIsCanadian && !leftover && !RE.us.test(text)) return { tier: 'remote-canada', label: 'Remote (country not stated; Canadian employer)' };
    if (settings.allowUS && RE.us.test(text)) return { tier: 'us', label: remote ? 'Remote (US)' : 'United States' };
    return null;
  }

  // --------------------------------------------------------------- scoring
  function sizeScore(company, boardSize) {
    const emp = Number(company.employees);
    if (emp > 0) {
      if (emp <= 50) return [20, `~${emp} employees`];
      if (emp <= 200) return [14, `~${emp} employees`];
      if (emp <= 500) return [6, `~${emp} employees`];
      if (emp <= 1000) return [0, `~${emp} employees`];
      return [-10, `large employer (~${emp} employees)`];
    }
    if (boardSize <= 10) return [20, `${boardSize} open roles (small team)`];
    if (boardSize <= 25) return [14, `${boardSize} open roles`];
    if (boardSize <= 60) return [6, `${boardSize} open roles`];
    if (boardSize <= 150) return [0, `${boardSize} open roles`];
    return [-10, `${boardSize} open roles (large employer)`];
  }

  function freshnessScore(ageDays) {
    if (ageDays == null) return [0, 'post date unknown'];
    if (ageDays <= 3) return [30, `posted ${ageDays}d ago`];
    if (ageDays <= 7) return [25, `posted ${ageDays}d ago`];
    if (ageDays <= 14) return [15, `posted ${ageDays}d ago`];
    if (ageDays <= 30) return [5, `posted ${ageDays}d ago`];
    return [-10, `posted ${ageDays}d ago`];
  }

  const TIER_POINTS = { calgary: 15, alberta: 12, canada: 8, 'remote-canada': 3, us: 2 };

  const SALARY_IN_TEXT = /\$\s?\d{2,3}(?:,\d{3})+|\$\s?\d{2,3}(?:\.\d+)?\s?[kK]\b|\$\s?\d{2,3}(?:\.\d{2})?\s?(?:\/|per)\s?(?:hr|hour)/;
  const VACANCY_NO = /(?:not|isn['’]?t)\s+(?:for\s+)?an?\s+existing\s+vacanc|future\s+vacanc|not\s+(?:currently\s+)?an?\s+(?:open|existing)\s+(?:position|vacancy)/i;
  const VACANCY_YES = /existing\s+vacanc|current\s+vacanc|this\s+is\s+an?\s+existing\s+(?:position|role)/i;

  /**
   * Evaluate one job. Returns null when it isn't a target role/location,
   * { drop: reason } when it's a target but looks like a ghost/stale posting,
   * or the scored result.
   */
  function evaluate(job, company, ctx) {
    const { settings, nowIso, boardSize, firstSeenIso, priorSameTitle, companyScannedBefore, compiled } = ctx;
    const title = clean(job.title);
    if (!compiled.titleInclude || !compiled.titleInclude.test(title)) return null;
    if (compiled.titleExclude && compiled.titleExclude.test(title)) return null;

    const loc = classifyLocation(job, company, settings);
    if (!loc) return null;

    const reasons = [];
    const flags = [];
    let score = 20;

    const ghostTitle = firstMatch(compiled.ghostTitle, title);
    if (ghostTitle) return { drop: `evergreen/pipeline title ("${ghostTitle}")` };

    // Freshness. Fall back to the scanner's own first-seen date when the ATS has none.
    let postedIso = job.postedAt;
    let ageDays = postedIso ? Math.max(0, daysBetween(postedIso, nowIso)) : null;
    if (ageDays == null && companyScannedBefore && firstSeenIso) {
      ageDays = Math.max(0, daysBetween(firstSeenIso, nowIso));
      postedIso = firstSeenIso;
      reasons.push('new since last scan');
    }
    if (ageDays == null && settings.requireKnownDate) return { drop: 'post date unknown on first scan (baseline, not proven fresh)' };
    if (ageDays != null && ageDays > settings.maxAgeDays) return { drop: `stale (${ageDays} days old)` };
    const [fPts, fWhy] = freshnessScore(ageDays);
    score += fPts; reasons.push(fWhy);

    if (boardSize > settings.dropIfOpenRolesOver && !(Number(company.employees) > 0)) {
      return { drop: `large employer (${boardSize} open roles)` };
    }
    const [sPts, sWhy] = sizeScore(company, boardSize);
    score += sPts; reasons.push(sWhy);

    score += TIER_POINTS[loc.tier] || 0;
    reasons.push(loc.label);

    const desc = job.description; // null = this ATS doesn't provide one
    const hasDesc = typeof desc === 'string' && desc.length > 0;

    let salary = job.salary || '';
    if (!salary && hasDesc && SALARY_IN_TEXT.test(desc)) salary = 'listed in posting';
    if (salary) { score += 10; reasons.push('salary shown'); }

    if (hasDesc) {
      if (VACANCY_NO.test(desc)) return { drop: 'posting says it is not an existing vacancy' };
      if (VACANCY_YES.test(desc)) { score += 5; reasons.push('confirms existing vacancy'); }

      const ghostDesc = firstMatch(compiled.ghostDescription, desc);
      if (ghostDesc) { score -= 20; flags.push(`pipeline language ("${ghostDesc}")`); }

      const agency = firstMatch(compiled.agency, desc);
      if (agency) { score -= 15; flags.push(`recruiting agency ("${agency}")`); }

      const lang = firstMatch(compiled.language, desc);
      if (lang) { score -= settings.languagePenalty; flags.push(`language requirement ("${lang}")`); }

      if (desc.length < settings.thinDescriptionChars) { score -= 10; flags.push('thin description'); }
    }

    if (priorSameTitle >= settings.dropAfterReposts) return { drop: `same title posted ${priorSameTitle}x before (serial repost)` };
    if (priorSameTitle > 0) { score -= 15; flags.push(`same title posted ${priorSameTitle}x before`); }

    score = Math.max(0, Math.min(100, score));

    let ghostRisk = 'Low';
    if (flags.some((f) => /pipeline|agency/.test(f)) || (ageDays != null && ageDays > 30)) ghostRisk = 'High';
    else if (priorSameTitle > 0 || (!salary && ageDays == null) || (ageDays != null && ageDays > 14 && !salary)) ghostRisk = 'Medium';

    return { score, ghostRisk, ageDays, postedIso, salary, location: loc, reasons, flags };
  }

  function compile(settings) {
    return {
      titleInclude: phraseRegex(settings.titleInclude),
      titleExclude: phraseRegex(settings.titleExclude),
      ghostTitle: phraseRegex(settings.ghostTitlePhrases),
      ghostDescription: phraseRegex(settings.ghostDescriptionPhrases),
      agency: phraseRegex(settings.agencyPhrases),
      language: phraseRegex(settings.languagePhrases),
    };
  }


  // ------------------------------------------------------------ profile fit
  /**
   * How well a posting fits the candidate profile (config/profile.json), 0–100.
   *   title track  30   strong track 30, medium 20, other target title 12
   *   skills       45   share of tools/skills the posting names that you have
   *   domain       10   posting mentions an industry you've worked in
   *   experience   15   required years vs yours
   * Hard requirements you don't meet (e.g. "CPA required") cap the score at 40.
   * Without a description (some ATSs) only the title can be judged.
   */
  function compileProfile(profile) {
    if (!profile || profile._compiled) return profile;
    const terms = (obj) => Object.entries(obj || {}).map(([label, phrases]) => ({ label, re: phraseRegex(phrases) }));
    Object.defineProperty(profile, '_compiled', {
      enumerable: false,
      value: {
        strong: phraseRegex((profile.titleTracks || {}).strong),
        medium: phraseRegex((profile.titleTracks || {}).medium),
        stretch: phraseRegex((profile.titleTracks || {}).stretch),
        tools: terms(profile.tools || profile.has),
        practices: terms(profile.practices),
        lacks: terms(profile.lacks),
        domains: phraseRegex(profile.domains),
        knockouts: (profile.knockouts || []).map((k) => ({ ...k, re: new RegExp(k.pattern, 'i') })),
      },
    });
    return profile;
  }

  function requiredYears(text) {
    const patterns = [
      /(?<![-–]\s*|to\s+|\d)(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/gi,                // "5+ years"
      /(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(?:years?|yrs?)\b/gi,               // "3-5 years"
      /(?:minimum|at least|min\.?)\s+(?:of\s+)?(\d{1,2})\s*(?:years?|yrs?)\b/gi, // "minimum 5 years"
      /(?<![-–]\s*|to\s+|\d)(\d{1,2})\s*(?:years?|yrs?)(?:['’]s?)?\s+(?:of\s+)?(?:[a-z/&,\-]+\s+){0,6}?experience/gi, // "5 years of X experience"
    ];
    let min = null, max = null;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text))) {
        const lo = Number(m[1]);
        const hi = m[2] ? Number(m[2]) : null;
        if (lo < 1 || lo > 20) continue;
        if (min == null || lo > min) min = lo;
        if (hi != null && hi >= lo && (max == null || hi > max)) max = hi;
      }
    }
    return { min, max };
  }

  function matchProfile(job, profile) {
    const p = compileProfile(profile);
    if (!p) return null;
    const c = p._compiled;
    const title = clean(job.title);
    const desc = typeof job.description === 'string' ? job.description : '';
    const text = `${title} ${desc}`;
    const matched = [];
    const missing = [];

    let titlePts = c.strong && c.strong.test(title) ? 30 : c.medium && c.medium.test(title) ? 20 : 12;
    const stretch = firstMatch(c.stretch, title);
    if (stretch) { titlePts -= 10; missing.push(`seniority stretch ("${stretch.toLowerCase()}" level)`); }

    if (!desc) {
      return { score: Math.min(100, titlePts + 20 + 4 + 12), matched: ['title only — this job board gives no description'], missing };
    }

    // Tools count fully, practices half; the +1.5 keeps a posting with only a
    // couple of generic matches from scoring as a perfect fit.
    let hit = 0, miss = 0;
    for (const t of c.tools) if (t.re && t.re.test(text)) { matched.push(t.label); hit += 1; }
    for (const t of c.practices) if (t.re && t.re.test(text)) { matched.push(t.label); hit += 0.5; }
    for (const t of c.lacks) if (t.re && t.re.test(text)) { missing.push(t.label); miss += 1; }
    const skillPts = hit + miss === 0 ? 20 : Math.round(45 * hit / (hit + miss + 1.5));

    const domain = firstMatch(c.domains, desc);
    const domainPts = domain ? 10 : 4;
    if (domain) matched.push(`domain: ${domain.toLowerCase()}`);

    const yrs = requiredYears(desc);
    const mine = Number(p.yearsOfExperience) || 0;
    let yearsPts = 12;
    if (yrs.min != null) {
      if (yrs.min > mine + 2) { yearsPts = 5; missing.push(`asks ${yrs.min}+ yrs`); }
      else if (yrs.min > mine) yearsPts = 10;
      else if (yrs.max != null && yrs.max <= 3) { yearsPts = 10; missing.push(`scoped ${yrs.max > yrs.min ? yrs.min + '-' + yrs.max : 'up to ' + yrs.max} yrs (overqualified)`); }
      else yearsPts = 15;
    }

    let score = titlePts + skillPts + domainPts + yearsPts;
    for (const k of c.knockouts) {
      if (k.re.test(desc)) {
        missing.unshift(k.label);
        if (k.cap) score = Math.min(score, 40);
      }
    }
    return { score: Math.max(0, Math.min(100, score)), matched, missing };
  }

  // ---------------------------------------------------------------- state
  function ensureState(state) {
    const s = state || {};
    s.version = s.version || 1;
    s.jobs = s.jobs || {};
    s.titles = s.titles || {};
    s.companies = s.companies || {};
    return s;
  }

  function pruneState(state, nowIso, settings) {
    for (const [k, v] of Object.entries(state.jobs)) {
      if (daysBetween(v.l, nowIso) > settings.forgetJobsNotSeenForDays) delete state.jobs[k];
    }
    for (const [k, list] of Object.entries(state.titles)) {
      const kept = list.filter((e) => daysBetween(e.s, nowIso) <= settings.repostWindowDays);
      if (kept.length) state.titles[k] = kept; else delete state.titles[k];
    }
  }

  // -------------------------------------------------------------- pipeline
  /**
   * boards: [{ company, body?, error? }]
   * Returns { rows, dropped, errors, stats }. Mutates `state`; the caller persists it.
   */
  function processBoards(boards, settings, rawState, nowIso) {
    const state = ensureState(rawState);
    const compiled = compile(settings);
    const rows = [];
    const dropped = [];
    const errors = [];
    let scannedJobs = 0;

    for (const { company, body, error } of boards) {
      const ck = companyKey(company);
      const name = clean(company.company) || company.slug;
      if (error) { errors.push({ company: name, ats: company.ats, slug: company.slug, error: String(error).slice(0, 200) }); continue; }

      let parsed;
      try { parsed = parseBoard(company, body); }
      catch (e) { errors.push({ company: name, ats: company.ats, slug: company.slug, error: String(e.message).slice(0, 200) }); continue; }

      const companyScannedBefore = Boolean(state.companies[ck]);
      if (!companyScannedBefore) state.companies[ck] = nowIso;
      scannedJobs += parsed.jobs.length;

      for (const job of parsed.jobs) {
        const jobKey = `${ck}:${job.id}`;
        const known = state.jobs[jobKey];
        if (known) { known.l = nowIso; continue; } // already evaluated on an earlier run

        // Only postings first seen on an EARLIER run count as reposts; two openings
        // with the same title posted together (e.g. two cities) are not reposts.
        const tKey = `${ck}|${normTitle(job.title)}`;
        const priorSameTitle = (state.titles[tKey] || []).filter((e) => e.k !== jobKey && e.s < nowIso).length;

        const result = evaluate(job, company, {
          settings, nowIso, compiled,
          boardSize: parsed.boardSize,
          firstSeenIso: nowIso,
          priorSameTitle,
          companyScannedBefore,
        });
        if (result === null) continue; // not a target role/location; not tracked

        state.jobs[jobKey] = { f: nowIso, l: nowIso };
        (state.titles[tKey] = state.titles[tKey] || []).push({ k: jobKey, s: nowIso });

        if (result.drop) { dropped.push({ company: name, title: job.title, reason: result.drop, url: job.url }); continue; }
        if (result.score < settings.minScore) { dropped.push({ company: name, title: job.title, reason: `score ${result.score} < ${settings.minScore}`, url: job.url }); continue; }

        const fit = matchProfile(job, settings.profile);
        rows.push({
          found_on: nowIso.slice(0, 10),
          match_score: fit ? fit.score : '',
          posting_score: result.score,
          ghost_risk: result.ghostRisk,
          company: name || job.companyName,
          title: clean(job.title),
          location: clean(job.location) || result.location.label,
          location_tier: result.location.tier,
          posted_on: result.postedIso ? result.postedIso.slice(0, 10) : '',
          age_days: result.ageDays == null ? '' : result.ageDays,
          age_hours: result.postedIso ? Math.max(0, Math.round((new Date(nowIso) - new Date(result.postedIso)) / 3600000)) : '',
          salary: result.salary,
          open_roles_at_company: parsed.boardSize,
          signals: result.reasons.join('; '),
          red_flags: result.flags.join('; '),
          matched_skills: fit ? fit.matched.join(', ') : '',
          missing_skills: fit ? fit.missing.join(', ') : '',
          url: job.url,
          ats: ATS[String(company.ats).toLowerCase().trim()].label,
          job_key: jobKey,
          status: '',
          notes: '',
        });
      }
    }

    pruneState(state, nowIso, settings);
    rows.sort((a, b) => (Number(b.match_score) || 0) - (Number(a.match_score) || 0) || b.posting_score - a.posting_score);
    return {
      rows, dropped, errors,
      stats: { companies: boards.length, boardErrors: errors.length, jobsScanned: scannedJobs, newMatches: rows.length, dropped: dropped.length },
    };
  }

  // ---------------------------------------------------------------- digest
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function buildDigest(result, settings, nowIso) {
    const rows = result.rows.slice(0, settings.maxDigestRows);
    const date = nowIso.slice(0, 10);
    const riskColor = { Low: '#1a7f37', Medium: '#9a6700', High: '#cf222e' };
    const td = 'padding:8px;border-bottom:1px solid #eee;vertical-align:top';
    const tr = rows.map((r) => `
      <tr>
        <td style="${td};text-align:center;font-weight:bold">${r.match_score === '' ? '—' : r.match_score}</td>
        <td style="${td};text-align:center">${r.posting_score}</td>
        <td style="${td}"><a href="${esc(r.url)}" style="color:#0969da;text-decoration:none;font-weight:600">${esc(r.title)}</a><br><span style="color:#555">${esc(r.company)} · ${esc(r.location)}</span></td>
        <td style="${td};white-space:nowrap">${r.age_hours === '' ? '?' : r.age_hours < 48 ? r.age_hours + 'h' : r.age_days + 'd'}</td>
        <td style="${td}">${esc(r.salary || '—')}</td>
        <td style="${td};color:${riskColor[r.ghost_risk]};font-weight:600">${r.ghost_risk}</td>
        <td style="${td};color:#555;font-size:12px">${esc(r.signals)}${r.missing_skills ? '<br><span style="color:#9a6700">Gaps: ' + esc(r.missing_skills) + '</span>' : ''}${r.red_flags ? '<br><span style="color:#cf222e">' + esc(r.red_flags) + '</span>' : ''}</td>
      </tr>`).join('');
    const errs = result.errors.length
      ? `<p style="color:#9a6700;margin-top:24px"><b>${result.errors.length} board(s) failed</b> — check these slugs in your Companies sheet:<br>${result.errors.map((e) => `${esc(e.company)} (${esc(e.ats)}/${esc(e.slug)}): ${esc(e.error)}`).join('<br>')}</p>`
      : '';
    const s = result.stats;
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2328;max-width:920px">
        <h2 style="margin:0 0 4px">Hidden Job Finder — ${date}</h2>
        <p style="margin:0 0 16px;color:#555">${s.newMatches} new match(es) from ${s.companies} companies · ${s.jobsScanned} postings scanned · ${s.dropped} target roles filtered out (stale, ghost signals or low score)</p>
        ${rows.length ? `<table style="border-collapse:collapse;width:100%">
          <tr style="background:#f6f8fa;text-align:left"><th style="padding:8px">Fit</th><th style="padding:8px">Posting</th><th style="padding:8px">Role</th><th style="padding:8px">Age</th><th style="padding:8px">Salary</th><th style="padding:8px">Ghost risk</th><th style="padding:8px">Why</th></tr>
          ${tr}
        </table>` : '<p>No new matches today.</p>'}
        ${result.rows.length > rows.length ? `<p style="color:#555">+${result.rows.length - rows.length} more in the Jobs sheet.</p>` : ''}
        ${errs}
      </div>`;
    return { subject: `Hidden Job Finder: ${s.newMatches} new match${s.newMatches === 1 ? '' : 'es'} (${date})`, html };
  }

  return {
    ATS, requestFor, parseBoard, classifyLocation, evaluate, compile, processBoards, buildDigest, matchProfile, requiredYears,
    ensureState, normTitle, htmlToText, phraseRegex, companyKey,
  };
})();

if (typeof module === 'object' && module && module.exports) module.exports = HJF;

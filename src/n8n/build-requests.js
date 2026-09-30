/*LIB*/

// One output item per active company row from the Companies sheet.
const out = [];
for (const item of $input.all()) {
  const row = {};
  for (const [k, v] of Object.entries(item.json)) row[String(k).trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
  if (/^(false|no|0|n)$/i.test(String(row.active ?? 'TRUE'))) continue;
  const req = HJF.requestFor(row);
  if (!req) continue;
  out.push({ json: { company: row.company, ats: String(row.ats).toLowerCase(), slug: row.slug, employees: row.employees || '', country: row.country || 'CA', url: req.url } });
}
return out;

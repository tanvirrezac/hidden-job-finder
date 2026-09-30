// Email only when there are new matches or a board broke (so you can fix its slug).
const d = $input.first().json;
return (d.rows.length || d.errors.length) ? [{ json: { subject: d.subject, html: d.html } }] : [];

// One item per new job, for the Jobs sheet. No items = nothing appended.
return ($input.first().json.rows || []).map((r) => ({ json: r }));

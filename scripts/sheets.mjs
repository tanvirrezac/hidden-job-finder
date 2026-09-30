// Minimal Google Sheets client using a service account. No npm dependencies:
// the OAuth JWT is signed with Node's built-in crypto.
import { createSign } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function makeJwt(serviceAccount, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(serviceAccount.private_key))}`;
}

export async function connectSheets({ serviceAccountJson, spreadsheetId, fetchImpl = fetch }) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeJwt(sa) }),
  });
  if (!tokenRes.ok) throw new Error(`Google auth failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const { access_token: token } = await tokenRes.json();

  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  async function api(path, init = {}) {
    const res = await fetchImpl(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) throw new Error(`Google Sheets denied access (403). Share the sheet with ${sa.client_email} as Editor. ${text}`);
      if (res.status === 404) throw new Error(`Spreadsheet not found (404). Check the SHEET_ID secret. ${text}`);
      throw new Error(`Google Sheets ${res.status}: ${text}`);
    }
    return res.json();
  }
  const range = (r) => encodeURIComponent(r);

  return {
    serviceAccountEmail: sa.client_email,

    async tabTitles() {
      const meta = await api('?fields=sheets.properties.title');
      return (meta.sheets || []).map((s) => s.properties.title);
    },

    async addTab(title) {
      await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) });
    },

    async getValues(r) {
      const data = await api(`/values/${range(r)}?majorDimension=ROWS`);
      return data.values || [];
    },

    async setValues(r, values) {
      await api(`/values/${range(r)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values }) });
    },

    async appendValues(r, values) {
      if (!values.length) return;
      await api(`/values/${range(r)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values }) });
    },
  };
}

/* ============================================================================
   EdgeDesk — the few GitHub REST calls the integrity gate makes.

   Token: GH_TOKEN, then GITHUB_TOKEN, then the credential actions/checkout
   leaves in git's config (so a job that never exported a token, like the
   bots that publish through tools/ci/push_generated.sh, still has one).
   GITHUB_API_URL points the calls at a test server.
   ============================================================================ */
'use strict';
const { execFileSync } = require('child_process');

function tokenFromGitConfig(cwd) {
  try {
    const h = execFileSync('git', ['config', '--get-regexp', '^http\\..*\\.extraheader$'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /AUTHORIZATION:\s*basic\s+(\S+)/i.exec(h);
    if (!m) return null;
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    return i >= 0 ? dec.slice(i + 1) : null;
  } catch (e) { return null; }
}

function token(cwd) {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || tokenFromGitConfig(cwd) || null;
}

function repo() {
  return process.env.GITHUB_REPOSITORY || null;
}

async function api(method, route, body, opts) {
  opts = opts || {};
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const t = opts.token || token(opts.cwd);
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'edgedesk-integrity-gate' };
  if (t) headers.authorization = 'Bearer ' + t;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      if (res.status >= 500 && attempt < 2) { lastErr = new Error(method + ' ' + route + ' → ' + res.status); await sleep(1000 * (attempt + 1)); continue; }
      return { status: res.status, ok: res.ok, json, text, headers: res.headers };
    } catch (e) { lastErr = e; await sleep(1000 * (attempt + 1)); }
  }
  throw lastErr;
}

/* GET every page of a list endpoint. `pick` extracts the array from a page
   (the Actions and Checks endpoints wrap it: { workflow_runs: [...] }). */
async function paginate(route, pick, opts) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const sep = route.includes('?') ? '&' : '?';
    const r = await api('GET', route + sep + 'per_page=100&page=' + page, undefined, opts);
    if (!r.ok) throw new Error('GET ' + route + ' → ' + r.status + ' ' + (r.text || '').slice(0, 200));
    const items = pick ? pick(r.json) : r.json;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { api, paginate, token, repo, sleep, tokenFromGitConfig };

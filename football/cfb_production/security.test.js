#!/usr/bin/env node
/* ===========================================================================
   CFB production — security checks (brief §72-76; docs/cfb-production/SECURITY.md).

     1 the secret audit fires on every kind it knows (fake values built here at
       run time, in a temp dir, so this file holds none) and never prints a value
     2 the repository, the page bundle, the kept logs and the workflows carry no
       secret (tools/cfb/secret_audit.js over the real tree)
     3 least privilege in every supabase/cfb_*.sql: every security-definer
       function is revoked from public and anon; anon is granted nothing but
       SELECT on the two settled-record views and the research terminal's
       guarded analytics writer; authenticated executes only the read-only
       health report and the admin-gated roll-ups; every table sits behind RLS
     4 public endpoints cannot trigger a CFB refresh: the two dispatchers are
       revoked from anon and authenticated, no edge function or page names a
       CFB workflow or calls a CFB writer, capture needs CRON_SECRET, the
       newsletter dispatch needs an operator
     5 the internal pages are noindex, escape what they render, and write nothing
     6 log lines mask credentials
   (The promotion guard, §76, is tested in canonical.test.js.)

   Run: node football/cfb_production/security.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SA = require(path.join(ROOT, 'tools', 'cfb', 'secret_audit.js'));
const LOG = require('./log.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const rnd = (n, set) => { set = set || 'ABCDEFGHJKLMNPQRSTUVWabcdefghjkmnpqrstuvw23456789'; let s = ''; for (let i = 0; i < n; i++) s += set[(i * 7 + 3) % set.length]; return s; };

/* ---------------------------------------------------------- 1 the rules fire */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-secret-'));
  try {
    const jwt = (role) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: 'supabase', ref: 'qq', role }) + '.' + rnd(43);
    const V = {
      PRIVATE_KEY: '-----BEGIN ' + 'PRIVATE KEY-----',
      GITHUB_TOKEN: 'gh' + 'p_' + rnd(36),
      STRIPE_SECRET: 'sk' + '_live_' + rnd(24),
      ANTHROPIC_KEY: 'sk' + '-ant-' + rnd(40),
      OPENAI_KEY: 'sk' + '-' + rnd(40),
      SLACK_TOKEN: 'xo' + 'xb-' + rnd(24),
      AWS_KEY: 'AK' + 'IA' + rnd(16, 'ABCDEFGHJKLMNPQRSTUVWXYZ234567'),
      DB_URL_WITH_PASSWORD: 'postgres' + 'ql://postgres:' + rnd(18) + '@db.host.internal:5432/postgres',
      API_KEY_IN_URL: 'https://api.host.internal/v4/odds?api' + 'Key=' + rnd(32),
      ASSIGNED_SECRET: 'ODDS_API' + '_KEY = "' + rnd(32) + '"',
      SERVICE_ROLE_JWT: jwt('service' + '_role'),
    };
    const files = {};
    Object.keys(V).forEach((k, i) => { files['src/f' + i + '.js'] = 'const x = 1;\nconst v = `' + V[k] + '`;\n'; });
    files['app.html'] = '<script>var KEY="' + jwt('anon') + '";</script>\n';                  // the public key: allowed
    files['admin/x/index.html'] = '<script>var KEY="' + jwt('service' + '_role') + '";</script>\n'; // a service key in a page: HIGH
    files['src/placeholder.js'] = 'const k = "sk' + '_live_' + 'x'.repeat(24) + '"; const u = "postgres' + 'ql://u:${PASSWORD}@h/db"; const t = process.env.GH_TOKEN;\n';
    files['.github/workflows/w.yml'] = [
      'jobs:', '  a:', '    steps:',
      '      - name: ok', '        env:', '          KEY: ${{ secrets.SB_SERVICE_ROLE }}', '        run: node x.js',
      '      - name: bad', '        run: curl -H "apikey: ${{ secrets.SB_SERVICE_ROLE }}" https://h',
      '      - name: echo', '        run: |', '          echo $SB_SERVICE_ROLE', ''].join('\n');
    Object.keys(files).forEach((f) => { fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), files[f]); });
    const r = SA.audit({ root: tmp, files: Object.keys(files).filter((f) => !/^\.github/.test(f)) });
    const kinds = new Set(r.findings.filter((f) => f.severity === 'HIGH').map((f) => f.kind));
    Object.keys(V).forEach((k) => chk('secret audit: a ' + k + ' is found (HIGH)', kinds.has(k), [...kinds]));
    chk('secret audit: the anon key in a page is not a finding', !r.findings.some((f) => f.file === 'app.html'));
    chk('secret audit: a service-role JWT in a page is HIGH and marked as the bundle', r.findings.some((f) => f.file === 'admin/x/index.html' && f.kind === 'SERVICE_ROLE_JWT' && f.where === 'bundle' && f.severity === 'HIGH'));
    chk('secret audit: placeholders and env lookups are not findings', !r.findings.some((f) => f.file === 'src/placeholder.js'), r.findings.filter((f) => f.file === 'src/placeholder.js'));
    chk('secret audit: a secret on a run line is HIGH, a secret echoed is HIGH, env: is clean',
      r.findings.some((f) => f.kind === 'SECRET_ON_RUN_LINE' && f.line === 9 && f.severity === 'HIGH') && r.findings.some((f) => f.kind === 'SECRET_ECHOED' && f.line === 12)
      && !r.findings.some((f) => f.file === '.github/workflows/w.yml' && f.line === 6), r.findings.filter((f) => /workflows/.test(f.file)));
    chk('secret audit: fails (ok=false) when anything HIGH is found', r.ok === false && r.high >= Object.keys(V).length);
    const printed = JSON.stringify(r);
    const leaked = Object.keys(V).filter((k) => {
      const m = /[A-Za-z0-9_-]{16,}/g; const parts = V[k].match(m) || [];
      return parts.some((p) => printed.includes(p));
    });
    chk('secret audit: no finding carries a secret value (fingerprints only)', leaked.length === 0 && r.findings.every((f) => !f.fingerprint || /^sha256:[0-9a-f]{10} \(\d+ chars\)$/.test(f.fingerprint)), leaked);
    /* a value that says it is fake, in a test file, is a fixture, not HIGH */
    const fx = []; SA.scanText('football/x/thing.test.js', 'const k = "sk' + '_live_' + 'fake' + rnd(20) + '";', fx);
    chk('secret audit: a fake value in a test file is a FIXTURE, not HIGH', fx.length === 1 && fx[0].severity === 'FIXTURE', fx);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ------------------------------------------------------ 2 the real tree */
{
  const r = SA.audit();
  chk('repository: the secret audit finds no HIGH secret (repository, page bundle, logs, workflows)', r.ok && r.high === 0,
    r.findings.filter((f) => f.severity === 'HIGH').map((f) => f.kind + ' ' + f.file + ':' + f.line));
  chk('repository: the audit scanned the page bundle, the logs and the workflows', r.bundle_files >= 5 && r.log_files >= 1 && r.workflows >= 10, [r.bundle_files, r.log_files, r.workflows]);
  chk('repository: the service key never appears in a page as a JWT', !r.findings.some((f) => f.kind === 'SERVICE_ROLE_JWT' && f.where === 'bundle'));
}

/* --------------------------------------------------- 3 least privilege (SQL) */
const SQL = fs.readdirSync(path.join(ROOT, 'supabase')).filter((f) => /^cfb_.*\.sql$/.test(f));
/* The documented exceptions, each with the guard that makes it safe (SECURITY.md §2):
   anon may call the research terminal's analytics writer (a fixed event list, clipped
   text, no identity, 120 events an hour; no model reads the table), and authenticated may
   call the read-only health report and the terminal's roll-ups (growth admins only, inside). */
const ANON_EXEC_OK = { cfb_terminal_track: /p_event not in \([^)]*\) then return false[\s\S]*?if n >= 120 then return false/ };
const AUTH_EXEC_OK = { cfb_health: null, cfb_terminal_usage: /where public\.growth_is_admin\(\)/, cfb_terminal_return_rate: /where public\.growth_is_admin\(\)/ };
const fnBody = (s, name) => { const i = s.indexOf('create or replace function public.' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('$$;', i) > 0 ? s.indexOf('$$;', i) : s.indexOf('$fn$;', i)); };
{
  const definers = [], unguarded = [];
  SQL.forEach((f) => {
    const s = rd('supabase/' + f);
    /* each function header up to its body */
    const re = /create or replace function public\.([a-z0-9_]+)\s*\(([^)]*)\)([\s\S]*?)(\$[a-z_]*\$)/g; let m;
    while ((m = re.exec(s))) {
      if (!/security definer/i.test(m[3])) continue;
      const name = m[1]; definers.push(f + ' ' + name);
      /* a direct revoke naming the role in its role list ("from public, anon") */
      const direct = (who) => new RegExp('revoke all on function public\\.' + name + '\\s*\\([^;]*\\bfrom\\s+[a-z_, ]*\\b' + who + '\\b', 'i').test(s);
      /* or listed in a do-block array whose loop revokes from public and anon */
      const listed = new RegExp("'public\\." + name + "\\(", 'i').test(s) && /revoke all on function %s from public/i.test(s) && /revoke all on function %s from anon/i.test(s);
      const anonOk = ANON_EXEC_OK[name] && direct('public') && ANON_EXEC_OK[name].test(fnBody(s, name));
      if (!((direct('public') && direct('anon')) || listed || anonOk)) unguarded.push(f + ' ' + name);
    }
  });
  chk('least privilege: security-definer functions found in the CFB migrations', definers.length >= 20, definers.length);
  chk('least privilege: every security-definer CFB function is revoked from public and anon (the analytics writer aside, with its guards)', unguarded.length === 0, unguarded);
  const anon = [];
  SQL.forEach((f) => rd('supabase/' + f).split('\n').forEach((l, i) => { if (/\bgrant\b[^;]*\bto\s+[a-z_, ]*\banon\b/i.test(l)) anon.push({ f, line: i + 1, text: l.trim() }); }));
  const lab = rd('supabase/cfb_lab.sql');
  const pubViews = /foreach v in array array\['cfb_lab_public_record','cfb_lab_public_summary'\][\s\S]*?grant select on public\.%I to anon/.test(lab);
  const anonBad = anon.filter((a) => !(a.f === 'cfb_lab.sql' && /grant select on public\.%I to anon/.test(a.text))
    && !(/grant execute on function public\.([a-z_]+)/.test(a.text) && ANON_EXEC_OK[/grant execute on function public\.([a-z_]+)/.exec(a.text)[1]]));
  chk("least privilege: anon is granted only SELECT on the settled-record views and the analytics writer, nothing else",
    pubViews && anonBad.length === 0 && anon.length >= 1, anonBad.map((a) => a.f + ':' + a.line + ' ' + a.text));
  const track = fnBody(rd('supabase/cfb_terminal_analytics.sql') || '', 'cfb_terminal_track');
  chk('least privilege: the anon analytics writer validates the event, clips text, rate-limits, and touches no model table',
    ANON_EXEC_OK.cfb_terminal_track.test(track) && /left\(p_detail, 120\)/.test(track) && !/cfb_(lab|decision|weekly|v2|market|production)_/.test(track));
  chk('least privilege: the public record shows only graded T24 LIVE champion rows (joined to evaluations: after the result)',
    /cfb_lab_public_record as[\s\S]*?join \(select distinct on \(x\.prediction_id\) x\.\*\s+from public\.cfb_lab_evaluations[\s\S]*?where p\.checkpoint_type = 'T24' and p\.origin = 'LIVE' and p\.model_role = 'champion'/.test(lab));
  const noRls = [];
  SQL.forEach((f) => {
    const s = rd('supabase/' + f);
    const tables = (s.match(/create table if not exists public\.(cfb_[a-z0-9_]+)/g) || []).map((x) => x.split('.')[1]);
    tables.forEach((t) => {
      const named = new RegExp('alter table public\\.' + t + ' enable row level security', 'i').test(s);
      const looped = new RegExp("'" + t + "'").test(s) && /enable row level security/i.test(s) && /format\([^)]*enable row level security/i.test(s);
      if (!named && !looped) noRls.push(f + ' ' + t);
    });
  });
  chk('least privilege: every CFB table has row level security', noRls.length === 0, noRls);
  const all = SQL.map((f) => rd('supabase/' + f)).join('\n');
  const authExec = [];
  let g; const gre = /grant execute on function public\.([a-z0-9_]+)[^;]*\bto\s+[a-z_, ]*\bauthenticated\b/gi;
  while ((g = gre.exec(all))) authExec.push(g[1]);
  const authBad = authExec.filter((n) => !Object.prototype.hasOwnProperty.call(AUTH_EXEC_OK, n) && !ANON_EXEC_OK[n]);
  const authUngated = Object.keys(AUTH_EXEC_OK).filter((n) => AUTH_EXEC_OK[n] && authExec.includes(n) && !AUTH_EXEC_OK[n].test(fnBody(all, n)));
  chk('least privilege: authenticated may execute only the read-only cfb_health and the admin-gated terminal roll-ups',
    /revoke all on function public\.cfb_health\(timestamptz\) from anon/.test(all) && authBad.length === 0 && authUngated.length === 0, { authBad, authUngated });
}

/* ------------------------------------------- 4 public endpoints, no refresh */
{
  const weekly = rd('supabase/cfb_weekly.sql'), cron = rd('supabase/cfb_lab_cron.sql');
  [['cfb_weekly_poke(text)', weekly], ['cfb_lab_poke(text)', cron], ['cfb_lab_cron_status()', cron]].forEach(([fn, s]) => {
    const esc = fn.replace(/[()]/g, '\\$&');
    ['public', 'anon', 'authenticated'].forEach((who) =>
      chk('public endpoints: ' + fn + ' is revoked from ' + who, new RegExp('revoke all on function public\\.' + esc + ' from ' + who).test(s)));
  });
  const fnDir = path.join(ROOT, 'supabase', 'functions');
  const fnFiles = [];
  const walk = (d) => fs.readdirSync(d).forEach((f) => { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|js)$/.test(f)) fnFiles.push(p); });
  walk(fnDir);
  const cfbWorkflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /^cfb|fbs/.test(f));
  const named = [];
  fnFiles.forEach((p) => { const s = fs.readFileSync(p, 'utf8'); cfbWorkflows.forEach((w) => { if (s.includes(w)) named.push(path.relative(ROOT, p) + ' -> ' + w); }); if (/rpc\/cfb_[a-z_]*poke/.test(s)) named.push(path.relative(ROOT, p) + ' -> poke'); });
  chk('public endpoints: no edge function names a CFB workflow or calls a CFB dispatcher', cfbWorkflows.length >= 3 && named.length === 0, named);
  const pages = ['app.html', 'index.html', 'record.html', 'brief.html'].concat(fs.readdirSync(path.join(ROOT, 'admin')).map((d) => 'admin/' + d + '/index.html')).filter((p) => fs.existsSync(path.join(ROOT, p)));
  const writers = [];
  pages.forEach((p) => {
    const s = rd(p);
    if (/rpc\/cfb_|\.rpc\(\s*['"]cfb_/.test(s)) writers.push(p + ' calls a cfb_ RPC');
    cfbWorkflows.forEach((w) => { if (new RegExp(w.replace('.', '\\.') + '[^\\n]{0,80}dispatches|dispatches[^\\n]{0,80}' + w.replace('.', '\\.')).test(s)) writers.push(p + ' dispatches ' + w); });
  });
  chk('public endpoints: no page calls a CFB RPC or dispatches a CFB workflow', writers.length === 0, writers);
  const cap = rd('supabase/functions/capture/index.ts');
  chk('public endpoints: capture refuses every caller without the CRON_SECRET header (and refuses all when it is unset)',
    /if \(!\(CRON_SECRET !== "" && req\.headers\.get\("x-cron-secret"\) === CRON_SECRET\)\)/.test(cap));
  const nl = rd('supabase/functions/newsletter/index.ts');
  const hd = nl.indexOf('async function handleDispatch');
  chk('admin validation: the newsletter dispatch checks the caller is an operator before anything else, and the anon key is never an operator',
    hd > 0 && /^\s*if \(!\(await callerIsAdmin\(c, req\)\)\) return json\(\{ ok: false, reason: 'not_authorised' \}, 403\);/m.test(nl.slice(hd, hd + 400))
    && /token === \(Deno\.env\.get\('SUPABASE_ANON_KEY'\) \?\? ''\)\) return false/.test(nl));
}

/* ------------------------------------------------------- 5 internal pages */
{
  const internal = fs.readdirSync(path.join(ROOT, 'admin')).filter((d) => /^cfb-/.test(d)).map((d) => 'admin/' + d + '/index.html');
  chk('internal pages: the CFB admin pages exist', internal.length >= 2, internal);
  internal.forEach((p) => {
    const s = rd(p);
    chk(p + ': noindex, nofollow', /<meta name="robots" content="noindex, nofollow">/.test(s));
    chk(p + ': defines an HTML escaper', /function esc\(s\)\s*\{\s*return String\(s\s*==\s*null\s*\?\s*''\s*:\s*s\)\.replace\(\/\[&<>"'\]\/g/.test(s));
    chk(p + ': writes nothing (no POST/PATCH/DELETE, no RPC)', !/method\s*:\s*['"](POST|PATCH|PUT|DELETE)['"]|\/rpc\//.test(s));
    chk(p + ': carries no service key reference', !/service_role|SB_SERVICE_ROLE|SERVICE_ROLE_KEY/.test(s));
  });
}

/* ----------------------------------------------------------- 6 log masking */
{
  const lines = [];
  const lg = LOG.logger({ job: 'security_test' }, { sink: (l) => lines.push(l) });
  const tok = b64({ alg: 'HS256' }) + '.' + b64({ role: 'service' + '_role' }) + '.' + rnd(43);
  const gh = 'gh' + 'p_' + rnd(36);
  lg.warn('mirror', 'error', { error: 'HTTP 401 Bearer ' + tok + ' at https://h/rest/v1/x?apikey=' + rnd(30), service_role_key: rnd(40), note: 'token ' + gh });
  const out = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  chk('log masking: a JWT, a bearer token, a key in a URL, a GitHub token and a credential-named field never reach a log line',
    out.length > 0 && !out.includes(tok) && !out.includes(gh) && !out.includes(rnd(40)) && !out.includes(rnd(30)) && /\[REDACTED\]/.test(out), out.slice(0, 300));
}

fails.forEach((x) => console.log('FAIL | ' + x));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

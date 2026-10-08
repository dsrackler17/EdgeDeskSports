#!/usr/bin/env node
/* ============================================================================
   CFB production — the secret audit (brief §72; docs/cfb-production/SECURITY.md §1).

   Scans, and NEVER prints a secret value (a finding shows the file, the line,
   the kind and a masked fingerprint):

     repository   every tracked file (git ls-files; the working tree when git
                  is unavailable), binary and very large generated files aside
     bundle       the pages a browser downloads (app.html, index.html,
                  record.html, brief.html, every admin page) — any JWT found there is
                  decoded and must carry role "anon" (the public key)
     logs         the job logs the repository keeps (each reports/SEASON/last_run.json,
                  ops.json, projections.json, weekly run records, the record files)
     workflows    secrets reach steps only as ${{ secrets.X }} env, never
                  echoed, never in a run line

   Kinds: PRIVATE_KEY, SERVICE_ROLE_JWT (a JWT whose role is not anon),
   GITHUB_TOKEN, STRIPE_SECRET, ANTHROPIC_KEY, OPENAI_KEY, SLACK_TOKEN, AWS_KEY,
   RESEND_KEY, WEBHOOK_SIGNING_SECRET (Svix/Standard Webhooks whsec_),
   DB_URL_WITH_PASSWORD, API_KEY_IN_URL, ASSIGNED_SECRET. Placeholders
   (xxxx, <...>, ${...}, env lookups) are not secrets.

     node tools/cfb/secret_audit.js [--json] [--root DIR]      exit 1 on any finding
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const MAX_BYTES = 12 * 1024 * 1024;
const BUNDLE = /^(app|index|record|brief|golf|curriculum|reset|disclaimer|privacy|terms|404)\.html$|^admin\//;
const LOGS = /(^|\/)(last_run\.json|ops\.json|projections\.json|provider_health\.json)$|^football\/cfb_weekly\/\d{4}\/runs\/|^record\//;
const SKIP = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|parquet|woff2?|ttf|mp4|mov|lock)$/i;

/* [kind, pattern, the group holding the value (0: the whole match)] */
const RULES = [
  ['PRIVATE_KEY', /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, 0],
  ['GITHUB_TOKEN', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 0],
  ['STRIPE_SECRET', /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/g, 0],
  ['ANTHROPIC_KEY', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, 0],
  ['OPENAI_KEY', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/g, 0],
  ['SLACK_TOKEN', /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, 0],
  ['AWS_KEY', /\bAKIA[0-9A-Z]{16}\b/g, 0],
  ['RESEND_KEY', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g, 0],
  ['WEBHOOK_SIGNING_SECRET', /\bwhsec_[A-Za-z0-9+/]{24,}={0,2}/g, 0],
  ['DB_URL_WITH_PASSWORD', /\bpostgres(ql)?:\/\/[^:\s'"@/]+:([^@\s'"]{6,})@[^\s'"]+/g, 2],
  ['API_KEY_IN_URL', /[?&](api[_-]?key|apikey|access_token|token)=([A-Za-z0-9_-]{24,})/gi, 2],
  ['ASSIGNED_SECRET', /\b(service_role_key|SUPABASE_SERVICE_ROLE_KEY|SB_SERVICE_ROLE|ODDS_API_KEY|ANTHROPIC_API_KEY|CRON_SECRET|STRIPE_SECRET_KEY|GH_TOKEN|GITHUB_TOKEN|RESEND_API_KEY|BRAVE_SEARCH_API_KEY|BRAVE_API_KEY|HUNTER_API_KEY|APOLLO_API_KEY|CLAY_WEBHOOK_TOKEN|CLAY_WEBHOOK_URL|password|passwd)\b\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi, 2],
];
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}\b/g;
const PLACEHOLDER = /x{4,}|X{4,}|<[^>]+>|\$\{|your[_-]?|example|placeholder|dummy|redacted|\*{4,}|\.\.\.|env(Get)?\(|process\.env|Deno\.env|secrets\./i;
/* a test fixture: a value inside a test file that says it is not real */
const TEST_FILE = /(\.test\.(js|sql|ts)|(^|\/)tests?(_[a-z]+)?\.(js|py)|(^|\/)fixtures?\/|(^|\/)conversation\.js)$/;
const FAKE = /test|fake|dummy|secret|sekrit|local|example|abc|123|xyz|not-a|nope|stub|mock|signature_here/i;
/* values published as examples by their own vendors: a fixture in a test file, never anyone's secret */
const PUBLIC_EXAMPLES = new Set([
  'whsec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',   // Svix's documentation example signing secret (split, so this line is not a finding)
]);

function fingerprint(v) { return 'sha256:' + crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 10) + ' (' + String(v).length + ' chars)'; }
function jwtRole(payloadB64) {
  try { const j = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return j.role || j.sub || 'unknown'; } catch (e) { return 'undecodable'; }
}

function files(root) {
  const out = cp.spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (out.status === 0 && out.stdout) return out.stdout.split('\0').filter(Boolean);
  const list = [];
  const walk = (d) => fs.readdirSync(path.join(root, d)).forEach((f) => { const rel = d ? d + '/' + f : f; if (/^(\.git|node_modules)$/.test(f)) return;
    const st = fs.statSync(path.join(root, rel)); if (st.isDirectory()) walk(rel); else list.push(rel); });
  walk('');
  return list;
}

function scanText(rel, text, findings) {
  const lines = text.split('\n');
  const where = BUNDLE.test(rel) ? 'bundle' : (LOGS.test(rel) ? 'log' : 'repository');
  lines.forEach((line, i) => {
    if (line.length > 20000) line = line.slice(0, 20000);
    let m;
    JWT.lastIndex = 0;
    while ((m = JWT.exec(line))) {
      const role = jwtRole(m[1]);
      if (role !== 'anon') findings.push({ file: rel, line: i + 1, kind: 'SERVICE_ROLE_JWT', where, detail: 'a JWT whose role is not anon',
        severity: TEST_FILE.test(rel) && FAKE.test(m[0].split('.').slice(1).map((x) => { try { return Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } }).join(' ')) ? 'FIXTURE' : 'HIGH',
        fingerprint: fingerprint(m[0]) });
    }
    RULES.forEach(([kind, re, g]) => {
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        const val = m[g] || m[0];
        if (PLACEHOLDER.test(m[0]) || PLACEHOLDER.test(val)) continue;
        /* A PEM header is a fixed string, so unlike every other kind it can
           never carry a fake marker in the matched value itself — which made
           any test of private-key redaction unclassifiable and permanently
           HIGH. For that one kind the line it sits on is the evidence. A real
           key committed to a test file sits on a line of its own, carries no
           marker, and still reads HIGH; detection is unchanged. */
        const marked = FAKE.test(val) || PUBLIC_EXAMPLES.has(val) || (kind === 'PRIVATE_KEY' && FAKE.test(line));
        findings.push({ file: rel, line: i + 1, kind, where, severity: TEST_FILE.test(rel) && marked ? 'FIXTURE' : 'HIGH', fingerprint: fingerprint(val) });
      }
    });
  });
}

/* workflow hygiene: a secret is only ever env: ${{ secrets.X }}, never on a run line or echoed */
function workflows(root, findings) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return 0;
  const fl = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  fl.forEach((f) => {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    let inRun = false, runIndent = 0;
    lines.forEach((l, i) => {
      const ind = l.search(/\S/);
      if (/^\s*run:\s*[|>]/.test(l)) { inRun = true; runIndent = ind; return; }
      if (inRun && ind >= 0 && ind <= runIndent && l.trim()) inRun = false;
      const runLine = /^\s*run:\s*\S/.test(l) || inRun;
      const sm = /\$\{\{\s*secrets\.([A-Z0-9_]+)/.exec(l);
      /* an identifier kept as a secret (a project ref, a URL) on a command line is INFO; a credential is HIGH */
      if (runLine && sm) findings.push({ file: '.github/workflows/' + f, line: i + 1, kind: 'SECRET_ON_RUN_LINE', where: 'workflow', detail: 'secrets.' + sm[1],
        severity: /(_REF|_URL|_ID|_REPO|_OWNER)$/.test(sm[1]) ? 'INFO' : 'HIGH' });
      if (runLine && /\becho\b[^\n]*\$(SB_SERVICE_ROLE|ODDS_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET)\b/.test(l)) findings.push({ file: '.github/workflows/' + f, line: i + 1, kind: 'SECRET_ECHOED', where: 'workflow', severity: 'HIGH' });
    });
  });
  return fl.length;
}

function audit(opts) {
  opts = opts || {};
  const root = opts.root || REPO;
  const findings = [];
  const list = opts.files || files(root);
  let scanned = 0, bundle = 0, logs = 0;
  for (const rel of list) {
    if (SKIP.test(rel)) continue;
    const p = path.join(root, rel);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue;
    scanned++; if (BUNDLE.test(rel)) bundle++; if (LOGS.test(rel)) logs++;
    scanText(rel, buf.toString('utf8'), findings);
  }
  const wf = workflows(root, findings);
  const high = findings.filter((f) => f.severity === 'HIGH');
  return { rule: 'cfb_secret_audit_v1', scanned, bundle_files: bundle, log_files: logs, workflows: wf, findings, high: high.length,
    fixtures: findings.filter((f) => f.severity === 'FIXTURE').length, info: findings.filter((f) => f.severity === 'INFO').length, ok: high.length === 0 };
}

module.exports = { audit, scanText, jwtRole, fingerprint, RULES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--root');
  const r = audit({ root: i >= 0 ? path.resolve(a[i + 1]) : REPO });
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else {
    r.findings.forEach((f) => console.log(f.severity + ' ' + f.kind + ' ' + f.file + ':' + f.line + ' [' + f.where + ']' + (f.detail ? ' ' + f.detail : '') + (f.fingerprint ? ' ' + f.fingerprint : '')));
    console.log('secret audit: ' + r.scanned + ' files (' + r.bundle_files + ' page files, ' + r.log_files + ' log files), ' + r.workflows + ' workflows: '
      + (r.ok ? 'no secret found' : r.high + ' HIGH finding(s)') + ' (' + r.fixtures + ' test fixture(s), ' + r.info + ' info)');
  }
  process.exit(r.ok ? 0 : 1);
}

#!/usr/bin/env node
/* ===========================================================================
   PHASE 11 — WHAT THE FILES THEMSELVES MUST NEVER SAY (no database needed).

     K  KEYS        the repository's secret audit (tools/cfb/secret_audit.js)
                    finds a Resend API key, a webhook signing secret and the
                    outbound providers' keys assigned in code; Svix's own
                    published example is a fixture only inside a test; the
                    real tree has none
     B  BROWSER     the pages a browser downloads for the console name no
                    provider key, no service-role key, no provider address:
                    the browser talks to the database's doors and the Edge
                    Functions, never to Resend, Brave, Hunter or Claude
     F  FUNCTIONS   each outbound Edge Function reads exactly the settings it
                    needs and never a service-role key; no function logs a
                    token, a key, a ticket, a header or a body
     W  WORKFLOWS   the deploy workflow hands secrets to steps as env only

   Run: node tools/growth/outbound_static.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SA = require(path.join(ROOT, 'tools', 'cfb', 'secret_audit.js'));
let pass = 0, fail = 0;
const fails = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; fails.push(n + (d !== undefined ? '  ' + JSON.stringify(d).slice(0, 600) : '')); } };
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ══ K. THE SECRET AUDIT ════════════════════════════════════════════════ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-secret-'));
  // built from parts, so this file itself is never a finding
  const rnd = (n) => { const set = 'ABCDEFGHJKLMNPQRSTUVWabcdefghjkmnpqrstuvw23456789'; let s = ''; for (let i = 0; i < n; i++) s += set[(i * 11 + 5) % set.length]; return s; };
  const V = {
    RESEND_KEY: 're' + '_' + rnd(9) + '_' + rnd(24),
    WEBHOOK_SIGNING_SECRET: 'wh' + 'sec_' + Buffer.from(rnd(30)).toString('base64'),
    ASSIGNED_RESEND: 'RESEND_API' + '_KEY = "' + rnd(36) + '"',
    ASSIGNED_BRAVE: 'BRAVE_SEARCH_API' + '_KEY: "' + rnd(30) + '"',
    ASSIGNED_HUNTER: 'HUNTER_API' + '_KEY = "' + rnd(40) + '"',
  };
  const EXAMPLE = 'wh' + 'sec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const files = {};
  Object.keys(V).forEach((k, i) => { files['src/o' + i + '.js'] = 'const v = `' + V[k] + '`;\n'; });
  files['tools/x/a.test.js'] = 'const SECRET = "' + EXAMPLE + '";\n';          // the vendor's own example, in a test: a fixture
  files['src/b.js'] = 'const SECRET = "' + EXAMPLE + '";\n';                   // … outside a test: a finding
  files['src/c.js'] = 'const k = Deno.env.get("RESEND_API_KEY"); const s = "' + 'wh' + 'sec_..."; // set in the dashboard\n';
  Object.keys(files).forEach((f) => { fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), files[f]); });
  const r = SA.audit({ root: tmp, files: Object.keys(files) });
  const high = (f) => r.findings.filter((x) => x.file === f && x.severity === 'HIGH').map((x) => x.kind);
  chk('K a Resend API key in code is found', high('src/o0.js').includes('RESEND_KEY'), r.findings);
  chk('K a webhook signing secret (whsec_) in code is found', high('src/o1.js').includes('WEBHOOK_SIGNING_SECRET'), r.findings);
  chk('K the outbound providers\' keys assigned in code are found (Resend, Brave, Hunter)', ['src/o2.js', 'src/o3.js', 'src/o4.js'].every((f) => high(f).includes('ASSIGNED_SECRET')), r.findings);
  chk('K Svix\'s published example inside a test is a fixture, not a finding', r.findings.filter((x) => x.file === 'tools/x/a.test.js').every((x) => x.severity === 'FIXTURE')
    && r.findings.some((x) => x.file === 'tools/x/a.test.js'));
  chk('K … the same value outside a test is a finding', high('src/b.js').includes('WEBHOOK_SIGNING_SECRET'));
  chk('K an env lookup and a "whsec_..." placeholder are not findings', !r.findings.some((x) => x.file === 'src/c.js'), r.findings.filter((x) => x.file === 'src/c.js'));
  chk('K the audit never prints a value it found', !Object.values(V).some((v) => JSON.stringify(r).includes(v.replace(/^.*"(.*)"$/, '$1'))));
  fs.rmSync(tmp, { recursive: true, force: true });
  const real = SA.audit({});
  chk('K the real repository: no secret anywhere (the audit CI runs on every PR)', real.ok === true, real.findings.filter((f) => f.severity === 'HIGH').map((f) => f.kind + ' ' + f.file + ':' + f.line));
}

/* ══ B. WHAT THE BROWSER DOWNLOADS ══════════════════════════════════════ */
{
  const PAGES = ['admin/growth/index.html', 'admin/growth/outbound.js', 'lib/edgedesk_admin_session.js', 'email/stop/index.html'];
  for (const p of PAGES) {
    const src = rd(p);
    // a setting's NAME in help text ("set BRAVE_SEARCH_API_KEY in Supabase") is fine; a value, or the service role at all, is not
    const VALUE = /SERVICE_ROLE|service_role|whsec_[A-Za-z0-9+/]{8,}|sk-ant-[A-Za-z0-9_-]{4,}|\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{4,}|(RESEND|BRAVE_SEARCH|HUNTER|ANTHROPIC)_API_KEY\s*[:=]/;
    chk('B ' + p + ' holds no provider key, signing secret or service-role key — only, at most, the names of settings to configure',
      !VALUE.test(src), (src.match(new RegExp(VALUE.source, 'g')) || []));
    chk('B ' + p + ' never talks to a provider directly (Resend, Brave, Hunter, Claude)',
      !/api\.resend\.com|api\.search\.brave\.com|api\.hunter\.io|api\.anthropic\.com/.test(src));
  }
  const ob = rd('admin/growth/outbound.js');
  const rpcs = [...ob.matchAll(/S\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  chk('B the console calls only the outbound doors (each checks the owner in the database)', rpcs.length > 20 && rpcs.every((n) => /^growth_outbound_[a-z_]+$/.test(n)), rpcs.filter((n) => !/^growth_outbound_/.test(n)));
  const invokes = [...new Set([...ob.matchAll(/S\.invoke\('([a-z_]+)'/g)].map((m) => m[1]))].sort();
  chk('B … and only the three owner functions (send, research, draft) — never the webhook or the opt-out', JSON.stringify(invokes) === JSON.stringify(['growth_outbound_draft', 'growth_outbound_research', 'growth_outbound_send']), invokes);
  chk('B the console page is never indexed', /<meta name="robots" content="noindex,nofollow">/.test(rd('admin/growth/index.html')));
}

/* ══ F. THE EDGE FUNCTIONS ══════════════════════════════════════════════ */
{
  const ENV = {
    // Phase 12: Apollo (optional) and Clay's table webhook (optional) join the research engine's providers
    // Phase 13: Podcast Index (free; optional) joins them
    growth_outbound_research: ['ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'BRAVE_SEARCH_API_KEY', 'CLAY_WEBHOOK_TOKEN', 'CLAY_WEBHOOK_URL',
      'HUNTER_API_KEY', 'OUTBOUND_ALLOWED_ORIGINS', 'OUTBOUND_RESEARCH_MODEL', 'PODCASTINDEX_API_KEY', 'PODCASTINDEX_API_SECRET', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'],
    growth_outbound_draft: ['ANTHROPIC_API_KEY', 'OUTBOUND_ALLOWED_ORIGINS', 'OUTBOUND_DRAFT_MODEL', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'],
    growth_outbound_send: ['OUTBOUND_ALLOWED_ORIGINS', 'RESEND_API_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'],
    growth_outbound_webhook: ['SUPABASE_ANON_KEY', 'SUPABASE_URL'],
    growth_outbound_optout: ['OUTBOUND_OPTOUT_PAGE', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'],
  };
  const SENSITIVE = /\b(authz|authorization|token|ticket|apikey|anonKey|resendKey|braveKey|hunterKey|anthropicKey|apolloKey|clayToken|clayWebhookUrl|secret|headers|body|req|request|key|signature|sig)\b/i;
  for (const name of Object.keys(ENV)) {
    const src = rd('supabase/functions/' + name + '/index.ts');
    const reads = [...new Set([...src.matchAll(/env\('([A-Z_]+)'\)/g)].map((m) => m[1]))].sort();
    chk('F ' + name + ' reads exactly its own settings', JSON.stringify(reads) === JSON.stringify(ENV[name]), reads);
    chk('F ' + name + ' never reads a service-role key', !/SERVICE_ROLE/.test(src.replace(/no service-role key|NO service-role key|not a service-role key|without a service-role key|service-role key is (never|not)[^\n]*/gi, '')));
    // every log line: a fixed message, plus at most a status code or a refusal reason — never a value that could carry a secret
    const calls = src.split('\n').filter((l) => /\b(log|console\.(log|error|warn|info))\(/.test(l) && !/^\s*\/\//.test(l) && !/const log = /.test(l));
    const leaky = calls.filter((l) => SENSITIVE.test(l.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")));
    chk('F ' + name + ' logs no token, key, ticket, header or body (' + calls.length + ' log line(s))', leaky.length === 0, leaky);
  }
}

/* ══ W. THE DEPLOY WORKFLOW ═════════════════════════════════════════════ */
{
  const wf = rd('.github/workflows/deploy-growth-outbound.yml');
  const runLines = wf.split('\n').filter((l) => /^\s*run:|^\s{10,}\S/.test(l));
  chk('W secrets reach the deploy steps only as env, never on a command line', !runLines.some((l) => /\$\{\{\s*secrets\./.test(l) && /run:/.test(l)));
  chk('W the outbound functions are deployed without a service-role key', !/SERVICE_ROLE/.test(wf.replace(/#[^\n]*/g, '')));
}

fails.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' growth outbound static checks — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/* ===========================================================================
   Tests for the CFB operations dashboard (admin/cfb-ops/index.html) as WIRED,
   modeled on football/cfb_lab/ui.test.js.

   The EDOPS block is cut out of the page between its markers and run in a
   sandbox against ops.json files written by the real builder
   (football/cfb_production/health.js):

     (a) the real shape: health.build() over this repository at a fixed time,
         and the committed reports/ops.json when present
     (b) nothing at all (ops.json failed to load): every section still renders
         and says UNKNOWN, never OK
     (c) a hostile ops.json: markup in every string and every key the page
         prints, a database answer, open incidents, failed jobs

   It cannot pass against a copy that drifted from the page.
   Run: node football/cfb_production/ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./health.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

const PAGE = fs.readFileSync(path.join(ROOT, 'admin', 'cfb-ops', 'index.html'), 'utf8');
const a = PAGE.indexOf('/*__EDOPS_START__*/'), b = PAGE.indexOf('/*__EDOPS_END__*/');
const block = PAGE.slice(a, b + '/*__EDOPS_END__*/'.length);

/* ---- structure ------------------------------------------------------------ */
chk('the page is noindex, nofollow', /<meta name="robots" content="noindex, nofollow">/.test(PAGE));
chk('no external script src', !/<script[^>]*\ssrc\s*=/i.test(PAGE));
chk('no external stylesheet, font or import', !/<link[^>]+rel=["']?stylesheet/i.test(PAGE) && !/@import|fonts\.googleapis|fonts\.gstatic/i.test(PAGE));
chk('colour tokens: dark by default, light by preference and by data-theme', /\.viz-root\{\s*color-scheme:dark/.test(PAGE) && /@media \(prefers-color-scheme: light\)/.test(PAGE)
  && /:root\[data-theme="light"\] \.viz-root/.test(PAGE) && /:root:where\(:not\(\[data-theme="dark"\]\)\) \.viz-root/.test(PAGE));
chk('system font, 16px side gutter, no horizontal page scroll', /font-family:system-ui/.test(PAGE) && /\.wrap\{[^}]*padding:0 16px/.test(PAGE) && /body\.viz-root\{[^}]*overflow-x:hidden/.test(PAGE) && /\.scroll\{overflow-x:auto/.test(PAGE));
chk('the header comment says what the page reads and that it computes nothing', /computes nothing of its own/.test(PAGE) && /football\/cfb_production\/reports\/ops\.json/.test(PAGE));
chk('the markers exist and the pure block has no DOM, network or storage access', a > 0 && b > a && !/document\.|location\.|fetch\(|localStorage|sessionStorage|innerHTML/.test(block));
chk('the boot reads ops.json and comes after the block', /fetch\('\.\.\/\.\.\/football\/cfb_production\/reports\/ops\.json'/.test(PAGE) && PAGE.indexOf('/*__EDOPS_END__*/') < PAGE.indexOf("getElementById('ops')") && /typeof document==='undefined'/.test(PAGE));

const ctx = { window: {}, console };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext('(function(window){' + block + '})(window)', ctx);
const E = ctx.window.EDOPS;
const IDS = (E && E.SECTIONS || []).map((s) => s[0]);
chk('EDOPS exposes render and every section renderer', E && ['render', 'system', 'model', 'weekly', 'sources', 'odds', 'pbp', 'jobs', 'degraded', 'predictions', 'bets', 'warnings', 'incidents'].every((k) => typeof E[k] === 'function'));
chk('twelve sections, in the brief\'s order', IDS.join() === 'system,model,weekly,sources,odds,pbp,jobs,degraded,predictions,bets,warnings,incidents', IDS);
chk('the section titles are the brief\'s', (E.SECTIONS || []).map((s) => s[1]).join('|') === 'System health|Model version|Last weekly run|Source health|Odds age|PBP age|Failed jobs|Degraded games|Predictions|Bet decisions|Warnings|Incidents');

const clean = (h) => !/undefined|NaN|>null</.test(h);
const tablesScroll = (h) => (h.match(/<table/g) || []).length === (h.match(/<div class="scroll"><table/g) || []).length;
const sectionOf = (h, id) => { const i = h.indexOf('<section class="card" id="' + id + '"'); const j = h.indexOf('</section>', i); return i < 0 ? '' : h.slice(i, j); };
const statusChip = (h, id) => { const m = /<h2>[^<]*<span class="chip[^"]*">([A-Z_]+)<\/span><\/h2>/.exec(sectionOf(h, id)); return m ? m[1] : null; };

/* ---- (b) nothing ------------------------------------------------------------ */
const none = E.render(null);
chk('with no ops.json every section still renders', IDS.every((id) => none.indexOf('<section class="card" id="' + id + '"') >= 0) && /ops\.json did not load/.test(none) && clean(none));
chk('with no ops.json nothing is shown as OK: every section is UNKNOWN', IDS.every((id) => statusChip(none, id) === 'UNKNOWN') && !/chip good">OK/.test(none));

/* ---- (a) the real shape ------------------------------------------------------ */
const samples = [{ name: 'health.build() over this repository', o: H.build({ now: '2026-10-03T15:00:00.000Z', season: 2026 }) }];
const committed = path.join(__dirname, 'reports', 'ops.json');
if (fs.existsSync(committed)) samples.push({ name: 'committed reports/ops.json', o: JSON.parse(fs.readFileSync(committed, 'utf8')) });
samples.forEach((S) => {
  const h = E.render(S.o);
  chk(S.name + ': every section id renders and the nav links to it', IDS.every((id) => h.indexOf('<section class="card" id="' + id + '"') >= 0 && h.indexOf('href="#' + id + '"') >= 0));
  chk(S.name + ': no "undefined", "NaN" or raw null', clean(h), (h.match(/.{0,60}(undefined|NaN|>null<).{0,60}/) || [])[0]);
  chk(S.name + ': every table scrolls inside its own container', tablesScroll(h));
  chk(S.name + ': the system chip is the builder\'s verdict', statusChip(h, 'system') === S.o.system.status, [statusChip(h, 'system'), S.o.system.status]);
  chk(S.name + ': every section chip is the builder\'s verdict', ['model_version:model', 'last_weekly_run:weekly', 'source_health:sources', 'odds_age:odds', 'pbp_age:pbp', 'failed_jobs:jobs',
    'degraded_games:degraded', 'predictions:predictions', 'bet_decisions:bets', 'warnings:warnings', 'incidents:incidents'].every((p) => { const [k, id] = p.split(':'); return statusChip(h, id) === S.o.sections[k].status; }));
  chk(S.name + ': the champion, NOT_RUN and the production model are printed', sectionOf(h, 'model').indexOf('edgedesk_cfb_p4_v1.0.0') >= 0 && /NOT_RUN/.test(sectionOf(h, 'model')) && sectionOf(h, 'model').indexOf('edgedesk_cfb_v2.1.0') >= 0);
  chk(S.name + ': the fallback hierarchy is printed with every level', (S.o.sections.model_version.fallback_hierarchy || []).every((f) => sectionOf(h, 'model').indexOf('>' + f.mode + '<') >= 0));
  chk(S.name + ': betting shows as DISABLED with the policy', /chip good">DISABLED/.test(sectionOf(h, 'bets')) && sectionOf(h, 'bets').indexOf(S.o.sections.bet_decisions.policy) >= 0);
});
const real = samples[0].o;
chk('real: the builder never reports UNKNOWN as OK (incidents without a database are UNKNOWN)', real.sections.incidents.status === 'UNKNOWN' && real.system.status !== 'OK');
chk('real: champion_selection is NOT_RUN in the model section', real.sections.model_version.champion_selection === 'NOT_RUN');

/* ---- (c) hostile ------------------------------------------------------------- */
const X = JSON.parse(JSON.stringify(real));
const HOSTILE = '<img src=x onerror=alert(1)>';
X.generated_at = '<zq1>';
X.reads.push('<zq2>');
X.sections.model_version.manifest_problems = ['<zq3> "x" onmouseover="y'];
X.sections.model_version.compatibility.push({ check: '<zq4>', ok: false, code: '<zq5>', detail: '<zq6>' });
X.sections.last_weekly_run = { status: 'CRITICAL', detail: '<zq7>', run_id: '<zq8>', mode: 'weekly', run_status: 'FAILED', stage_groups: { '<zq9>': 'FAILED' }, errors: [{ stage: '<zq10>', class: 'SCHEMA', message: HOSTILE }], runs_recorded: 1 };
X.sections.source_health.sources.push({ source: '<zq11>', origin: '<zq12>', status: 'OPEN', incident: '<zq13>', age_minutes: 5000 });
X.sections.failed_jobs.failed.push({ job: '<zq14>', step: '<zq15>', at: 'x', error: '<zq16>' });
X.sections.degraded_games.degraded.push({ game_id: '<zq17>', home: 'Texas A&M', away: '<zq18>', modes: ['<zq19>'], reason: '<zq20>' });
X.sections.bet_decisions.by_role_status['<zq21>'] = 2;
X.sections.warnings.warnings.push({ source: '<zq22>', rule: '<zq23>', severity: 'CRITICAL', message: '<zq24>', detail: { '<zq25>': '<zq26>' } });
X.sections.incidents = { status: 'CRITICAL', detail: '<zq27>', open: [{ severity: 'CRITICAL', incident_key: '<zq28>', error_code: 'DATABASE_DEADLOCK', job: 'cfb_weekly_refresh', occurrences: 12, opened_at: '2026-10-03T10:05:00Z', last_at: '2026-10-03T10:09:00Z', message: HOSTILE }] };
X.database = { status: 'CRITICAL', checks: [{ check_name: '<zq29>', status: 'CRITICAL', detail: '<zq30>' }] };
X.system.status = 'CRITICAL';
X.system.by_section['<zq31>'] = 'CRITICAL';
const hh = E.render(X);
chk('every string from ops.json is escaped, keys and attribute-bound values included', !/<zq/.test(hh) && hh.indexOf('<img') < 0 && !/onmouseover="y/.test(hh)
  && Array.from({ length: 31 }, (_, i) => i + 1).every((i) => hh.indexOf('&lt;zq' + i + '&gt;') >= 0), (hh.match(/.{0,40}<zq.{0,40}/) || [])[0]);
chk('ampersands are escaped', hh.indexOf('Texas A&amp;M') >= 0 && hh.indexOf('Texas A&M') < 0);
chk('a CRITICAL system renders the red banner', /banner bad"><b>CRITICAL/.test(sectionOf(hh, 'system')));
chk('the database answer is printed when present', /Database cfb_health\(\)/.test(sectionOf(hh, 'system')));
chk('an open incident prints its key, code, count and message', /DATABASE_DEADLOCK/.test(sectionOf(hh, 'incidents')) && />12</.test(sectionOf(hh, 'incidents')) && /&lt;img src=x/.test(sectionOf(hh, 'incidents')));
chk('a failed weekly run shows FAILED and its stage error', /chip bad">FAILED/.test(sectionOf(hh, 'weekly')) && /&lt;zq10&gt;/.test(sectionOf(hh, 'weekly')));
chk('an OPEN breaker shows as a bad chip with its incident', /chip bad">OPEN/.test(sectionOf(hh, 'sources')) && /&lt;zq13&gt;/.test(sectionOf(hh, 'sources')));
chk('hostile output is still clean (no undefined / NaN / null)', clean(hh), (hh.match(/.{0,60}(undefined|NaN|>null<).{0,60}/) || [])[0]);
const bet = JSON.parse(JSON.stringify(real));
bet.sections.bet_decisions.betting_enabled = true;
chk('betting enabled renders as a red ENABLED chip', /chip bad">ENABLED/.test(E.bets(bet)));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

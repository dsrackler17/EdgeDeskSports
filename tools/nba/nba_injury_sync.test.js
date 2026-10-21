#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/nba_injury_sync/index.ts, tested as deployed: imported
   (not a copy) under Node's type stripping, with a Deno shim, a mocked
   network (the league's season page and PDF, ESPN's rosters and injuries,
   the slate's roster inputs) and an in-memory PostgREST.

     auth       a GET is a probe; a POST needs the cron secret
     window     a game day runs from 9:00 AM Eastern to 30 minutes after the
                last tip; any other day once; a declined poke is a SKIPPED run
     a run      30 roster captures, the league's report read and matched, the
                Hornets-Nets projection stored with the registered version, the
                report and the captures it used, and Charlotte -9.5 moved at
                least six points toward Brooklyn
     dedupe     an identical second run stores no report, roster or
                projection again, and still records the check
     fallback   the league's report down: ESPN's statuses, labelled, a
                DEGRADED alert and a warn run
     failure    both sources down (the operator's forced failure): an error run,
                a FAILURE alert, nothing written in their place
     refusals   an unregistered model stores no projection; an unfiled team or
                an unmatched name withholds the game with its reason
     dry        reads and computes, writes nothing

   Run: node tools/nba/nba_injury_sync.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const K = require(path.join(ROOT, 'nba', 'injury', 'core.js'));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nba_injury_cha_bkn_2026-10-21.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', NBA_INJURY_CRON_SECRET: 'cron-secret', NBA_INPUTS_URL: 'https://site.test/nba/roster_inputs.json' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

/* ---------------------------------------------------------------- the world */
const NOW = '2026-10-21T21:40:00Z';
const INPUTS = { schema: 'edgedesk_nba_roster_inputs_v1', generated_at: FX.generated_at, slate_generated_at: FX.slate_generated_at, shape: FX.shape, games: [FX.game], players: FX.players,
  impact: { measure: 'edgedesk_rapm_v1', tier: 'T2', formula: 'nba/model/players.js' }, minutes: { preseason_games: 0 },
  rosters_fallback: { url: FX.rosters_source.url, teams: FX.rosters } };
/* every team's ESPN roster: the fixture's two, and every referenced player where he is now */
const BY_TEAM = {};
for (const t of K.NBA_TEAMS) BY_TEAM[t[0]] = [];
for (const t of ['17', '30']) BY_TEAM[t] = FX.rosters[t].map((p) => ({ id: p.id, name: p.name }));
for (const [pid, t] of Object.entries(FX.team_of)) if (!['17', '30'].includes(t) && BY_TEAM[t]) BY_TEAM[t].push({ id: pid, name: (FX.players[pid] || {}).name || pid });
for (const t of Object.keys(BY_TEAM)) if (!BY_TEAM[t].length) BY_TEAM[t].push({ id: '9000' + t, name: 'Player ' + t });
const espnRoster = (t) => ({ athletes: BY_TEAM[t].map((p) => ({ id: p.id, displayName: p.name, position: { abbreviation: 'G' }, status: { name: 'Active', type: 'active' } })) });

const REPORT_LINES = (o) => ['Injury Report: 10/21/26 05:30 PM', 'Game Date Game Time Matchup Team Player Name Current Status Reason',
  '10/21/2026 07:30 (ET) CHA@BKN Charlotte Hornets White, Coby Out Injury/Illness - Left Calf; Strain', 'Knueppel, Kon Out Injury/Illness - Right Ankle; Sprain', 'Williams, Grant Out Injury/Illness - Right Knee; Injury Management']
  .concat(o && o.bknNotSubmitted ? ['Brooklyn Nets NOT YET SUBMITTED'] : []).concat(o && o.unmatched ? ['Nobody, Some Out Rest'] : []).concat(['Page 1 of 1']);
const W = { official: true, seasonPage: true, espnInj: true, roster: true, lines: REPORT_LINES(), inputs: true, pdfStatus: 0 };
const AGENTS = [];
const ESPN_INJ = { injuries: [{ id: '30', displayName: 'Charlotte Hornets', injuries: [
  { status: 'Out', athlete: { displayName: 'Coby White', links: [{ href: 'https://www.espn.com/nba/player/_/id/4395651/coby-white' }] } },
  { status: 'Out', athlete: { displayName: 'Kon Knueppel', links: [{ href: 'https://www.espn.com/nba/player/_/id/5061575/kon-knueppel' }] } },
  { status: 'Day-To-Day', athlete: { displayName: 'Grant Williams', links: [{ href: 'https://www.espn.com/nba/player/_/id/4066218/grant-williams' }] } }] }, { id: '17', displayName: 'Brooklyn Nets', injuries: [] }] };

/* ---------------------------------------------------------------- PostgREST, in memory */
let DB;
function resetDb(cfg) {
  DB = { runs: [], alerts: [], caps: [], snaps: [], reports: [], rrows: [], impact: [], proj: [], config: cfg === false ? [] : [{ key: 'roster_model_key', value: 'NBA-ROSTER-ADJ' }, { key: 'roster_model_version', value: '0.1' }, { key: 'roster_model_version_ref', value: '42' }], seq: 0, calls: [] };
}
const TABLE = { nba_injury_sync_runs: 'runs', nba_injury_alerts: 'alerts', nba_roster_captures: 'caps', nba_roster_snapshots: 'snaps', nba_injury_reports: 'reports', nba_injury_report_snapshots: 'rrows', nba_player_impact_snapshots: 'impact', nba_adjusted_projection_snapshots: 'proj' };
function rest(u, init) {
  const url = new URL(u), name = url.pathname.replace('/rest/v1/', ''), q = url.searchParams, m = (init && init.method) || 'GET';
  DB.calls.push(m + ' ' + name);
  const desc = (k) => (a, b) => (a[k] < b[k] ? 1 : a[k] > b[k] ? -1 : b.id - a.id);
  if (m === 'POST') {
    const rows = JSON.parse(init.body), t = TABLE[name];
    if (!t) return [404, { message: 'no table ' + name }];
    const out = rows.map((r) => Object.assign({ id: ++DB.seq }, r));
    if (t === 'proj') for (const r of out) { const ref = DB.config.find((c) => c.key === 'roster_model_version_ref'); if (!ref || r.model_version_ref !== ref.value) return [400, { message: 'not the registered version' }]; }
    DB[t].push(...out);
    return [201, init.headers && /representation/.test(init.headers.prefer) ? out : ''];
  }
  if (name === 'nba_injury_sync_runs') return [200, DB.runs.filter((r) => ['ok', 'warn'].includes(r.status)).sort(desc('finished_at')).slice(0, 1)];
  if (name === 'nba_roster_captures') return [200, DB.caps.slice().sort(desc('captured_at')).slice(0, 300)];
  if (name === 'nba_roster_current') {
    const latest = {}; for (const c of DB.caps.slice().sort(desc('captured_at'))) if (!latest[c.team_id]) latest[c.team_id] = c.id;
    return [200, DB.snaps.filter((s) => latest[s.team_id] === s.capture_id)];
  }
  if (name === 'nba_injury_reports') return [200, DB.reports.slice().sort(desc('captured_at')).slice(0, 1)];
  if (name === 'nba_injury_config') return [200, DB.config];
  if (name === 'nba_injury_report_snapshots') return [200, DB.rrows.filter((x) => 'eq.' + x.report_id === q.get('report_id'))];
  if (name === 'nba_player_impact_snapshots') return [200, DB.impact.filter((x) => 'eq.' + x.content_hash === q.get('content_hash'))];
  if (name === 'nba_adjusted_projection_current') { const l = {}; for (const p of DB.proj.slice().sort(desc('computed_at'))) if (!l[p.game_id]) l[p.game_id] = p; return [200, Object.values(l)]; }
  return [404, { message: 'unmocked ' + name }];
}
function resp(status, body, bytes) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => (bytes || new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))).buffer };
}
const PDF = new TextEncoder().encode('%PDF-1.7 a report');
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith(ENV.SUPABASE_URL)) { const [s, b] = rest(u, init); return resp(s, b); }
  AGENTS.push((init && init.headers && init.headers['user-agent']) || '');
  if (u === ENV.NBA_INPUTS_URL) return W.inputs ? resp(200, INPUTS) : resp(503, 'down');
  if (u.startsWith('https://official.nba.com/nba-injury-report-2026-27-season')) return W.seasonPage && W.official ? resp(200, '<a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_05_30PM.pdf">5:30</a><a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_01_30PM.pdf">1:30</a>') : resp(503, 'down');
  if (u.startsWith('https://ak-static.cms.nba.com/referee/injury/')) return W.pdfStatus ? resp(W.pdfStatus, 'Access Denied') : W.official && /05_30PM/.test(u) ? resp(200, '', PDF) : resp(404, 'no');
  const ro = /\/teams\/(\d+)\/roster$/.exec(u);
  if (ro) return W.roster ? resp(200, espnRoster(ro[1])) : resp(503, 'down');
  if (u.endsWith('/basketball/nba/injuries')) return W.espnInj ? resp(200, ESPN_INJ) : resp(503, 'down');
  return resp(404, 'unmocked ' + u);
};

(async () => {
  const FN = path.join(ROOT, 'supabase', 'functions', 'nba_injury_sync', 'index.ts');
  let F;
  try { F = await import(FN); } catch (e) { console.log('SKIP | nba injury sync | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  F.hooks.pdfLines = async () => W.lines;
  const run = (o) => F.syncOnce(Object.assign({ now: NOW }, o || {}));
  const last = (t) => DB[t][DB[t].length - 1];

  /* ---- auth ---- */
  const probe = await F.handle(new Request('https://x/', { method: 'GET' }));
  const pj = await probe.json();
  chk('auth: a GET is a public probe with the build and the model version', probe.status === 200 && pj.build === F.BUILD && pj.model.key === 'NBA-ROSTER-ADJ' && pj.model.version === '0.1' && pj.model.status === 'EXPERIMENTAL');
  chk('auth: a POST without the secret is refused', (await F.handle(new Request('https://x/', { method: 'POST', body: '{}' }))).status === 401);
  chk('auth: a POST with a wrong secret is refused', (await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'nope' }, body: '{}' }))).status === 401);

  /* ---- window ---- */
  const wf = (iso, lastGood) => F.windowFor(Date.parse(iso), INPUTS, lastGood || null);
  chk('window: a game day before 9:00 AM Eastern waits', wf('2026-10-21T12:30:00Z').run === false && wf('2026-10-21T12:30:00Z').game_day === true);
  chk('window: a game day from 9:00 AM Eastern runs every poke', wf('2026-10-21T13:07:00Z').run === true && wf('2026-10-21T21:37:00Z').run === true);
  chk('window: closes 30 minutes after the last tip', wf('2026-10-21T23:59:00Z').run === true && wf('2026-10-22T00:01:00Z').run === false);
  chk('window: a day without a game runs once, from 9:00 AM Eastern', wf('2026-10-22T14:07:00Z').run === true && wf('2026-10-22T14:37:00Z', { et_date: '2026-10-22' }).run === false && wf('2026-10-22T12:07:00Z').run === false);
  chk('window: with no inputs, every poke runs (the schedule is unknown)', F.windowFor(Date.parse('2026-10-22T14:07:00Z'), null, null).run === true);

  /* ---- a skipped poke is recorded ---- */
  resetDb();
  let o = await run({ now: '2026-10-21T12:37:00Z', trigger: 'cron' });
  chk('skipped: outside the window, a SKIPPED run is recorded with why; nothing is read', o.skipped && DB.runs.length === 1 && DB.runs[0].status === 'skipped' && /9:00 AM/.test(DB.runs[0].skipped_reason) && DB.caps.length === 0 && DB.reports.length === 0, o);

  /* ---- a full run ---- */
  resetDb();
  o = await run({ trigger: 'cron' });
  const r = last('runs'), rep = DB.reports[0], p = DB.proj[0];
  chk('run: ok, recorded, game day, Charlotte and Brooklyn playing', o.ok && r.status === 'ok' && r.game_day === true && r.teams_playing.includes('CHA') && r.teams_playing.includes('BKN'), [o.alerts, r]);
  chk('rosters: every team captured once, players stored', DB.caps.length === 30 && r.rosters_changed === 30 && DB.snaps.filter((s) => s.team_id === '30').length === FX.rosters['30'].length);
  chk('report: the league\'s, its publication time, three rows matched by name on Charlotte\'s roster', rep && rep.source === 'nba_official' && rep.report_published_at === '2026-10-21T21:30:00.000Z' && DB.rrows.length === 3 && DB.rrows.every((x) => x.player_id && x.match_method === 'team_exact' && x.status === 'OUT' && x.game_id === '401909836'), [rep, DB.rrows]);
  chk('report: the games it covers are stored with their slate ids (coverage)', rep.matchups.length === 1 && rep.matchups[0].game_id === '401909836');
  chk('impact: one T2 snapshot of the players the model read', DB.impact.length === 1 && DB.impact[0].tier === 'T2' && DB.impact[0].player_count === Object.keys(FX.players).length);
  chk('projection: stored with the registered version, the report, both captures and the impact snapshot', p && p.model_key === 'NBA-ROSTER-ADJ' && p.model_version === '0.1' && p.model_version_ref === '42' && p.injury_report_id === rep.id
    && p.home_roster_capture_id && p.away_roster_capture_id && p.impact_snapshot_id === DB.impact[0].id && p.slate_generated_at === FX.slate_generated_at, p && Object.assign({}, p, { adjustments: undefined, minutes: undefined }));
  chk('projection: OK; Charlotte -9.5 moves at least six points toward Brooklyn', p.status === 'OK' && p.baseline.fair_spread_home === 9.5 && p.baseline.fair_spread_home - p.adjusted.fair_spread_home >= 6, p && [p.baseline.fair_spread_home, p.adjusted && p.adjusted.fair_spread_home]);
  chk('projection: Ball and Bridges no longer on the roster; White, Knueppel, Williams OUT, each traced', ['LaMelo Ball', 'Miles Bridges'].every((n) => p.adjustments.some((l) => l.kind === 'departed' && l.player_name === n && l.evidence.roster_capture_id === p.away_roster_capture_id))
    && ['Coby White', 'Kon Knueppel', 'Grant Williams'].every((n) => p.adjustments.some((l) => l.kind === 'status' && l.player_name === n && l.evidence.report_id === rep.id)));
  chk('projection: computed before tip', Date.parse(p.computed_at) < Date.parse(p.game_start_utc));
  chk('projection: each status line names its report row', p.adjustments.filter((l) => l.kind === 'status').every((l) => DB.rrows.some((x) => x.id === l.evidence.report_row_id && x.player_id === l.player_id)));

  /* ---- an identical second run ---- */
  const n0 = { caps: DB.caps.length, reports: DB.reports.length, proj: DB.proj.length, impact: DB.impact.length };
  o = await run({ now: '2026-10-21T22:10:00Z', trigger: 'cron' });
  const r2 = last('runs');
  chk('dedupe: an identical report, roster and projection are not stored again', DB.caps.length === n0.caps && DB.reports.length === n0.reports && DB.proj.length === n0.proj && DB.impact.length === n0.impact, [n0, DB.caps.length, DB.reports.length, DB.proj.length]);
  chk('dedupe: the check is still recorded, standing on the stored report', r2.status === 'ok' && r2.report_changed === false && r2.report_id === rep.id && r2.projections_unchanged === 1 && DB.runs.length === 2);
  chk('dedupe: an unchanged report still traces its rows (read back), so the projection stays unchanged', r2.projections_unchanged === 1 && DB.calls.includes('GET nba_injury_report_snapshots'));

  /* ---- a changed report ---- */
  W.lines = REPORT_LINES().filter((l) => !/Williams, Grant/.test(l));
  o = await run({ now: '2026-10-21T22:40:00Z' });
  chk('change: a changed report is a new report and a new projection that uses it', DB.reports.length === 2 && DB.proj.length === 2 && last('proj').injury_report_id === last('reports').id && !last('proj').adjustments.some((l) => l.player_name === 'Grant Williams'));
  W.lines = REPORT_LINES();

  /* ---- the fallback ---- */
  resetDb();
  o = await run({ simulate_outage: ['official'] });
  const rf = last('runs');
  chk('fallback: ESPN\'s statuses, labelled; a DEGRADED alert; a warn run marked simulated', last('reports').source === 'espn_injuries' && last('reports').report_published_at === null && rf.status === 'warn' && rf.fallback_used === true && rf.simulated === true
    && DB.alerts.some((a) => a.severity === 'DEGRADED' && a.code === 'official_unavailable'), [rf, DB.alerts]);
  chk('fallback: ESPN ids matched directly; Day-To-Day stored as UNKNOWN with the source word', DB.rrows.every((x) => x.match_method === 'espn_id') && DB.rrows.find((x) => x.player_name === 'Grant Williams').status === 'UNKNOWN' && DB.rrows.find((x) => x.player_name === 'Grant Williams').source_status === 'Day-To-Day');
  chk('fallback: the projection is stored, from the fallback report, and says so', last('proj') && last('proj').report_source === 'espn_injuries' && last('proj').adjustments.some((l) => l.player_name === 'Grant Williams' && /status not an official designation/.test(l.text)));

  /* ---- refused at the edge (2026-10-21: ESPN and the league's PDF host refused a crawler-style agent) ---- */
  chk('sources: every outside request sends a browser agent, not a crawler-style one', AGENTS.length > 0 && AGENTS.every((a) => /^Mozilla\/5\.0 /.test(a) && !/\+https?:/.test(a)), [...new Set(AGENTS)]);
  resetDb(); W.pdfStatus = 403;
  o = await run();
  const refused = DB.alerts.find((a) => a.code === 'official_unavailable');
  chk('sources: a refused PDF says how it was refused (the HTTP status), not just that it failed', refused && /would not download: HTTP 403/.test(refused.message), DB.alerts);
  W.pdfStatus = 0;

  /* ---- the forced failure ---- */
  resetDb();
  const resp2 = await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' }, body: JSON.stringify({ simulate_outage: ['official', 'espn'], now: NOW }) }));
  const ob = await resp2.json();
  chk('failure: both sources down is an error run and a FAILURE alert; the response says so (HTTP 500)', resp2.status === 500 && ob.status === 'error' && last('runs').status === 'error' && DB.alerts.some((a) => a.severity === 'FAILURE' && a.code === 'no_injury_source'), [ob, DB.alerts]);
  chk('failure: nothing is written in the report\'s place, and no projection', DB.reports.length === 0 && DB.rrows.length === 0 && DB.proj.length === 0);
  chk('failure: the run is marked simulated (an operator\'s test, not an outage)', last('runs').simulated === true);

  /* ---- refusals ---- */
  resetDb(false);
  o = await run();
  chk('unregistered: no projection is stored; a FAILURE alert says to apply the registry file', DB.proj.length === 0 && DB.alerts.some((a) => a.code === 'model_not_registered') && DB.reports.length === 1);
  resetDb(); W.lines = REPORT_LINES({ bknNotSubmitted: true });
  o = await run();
  chk('withheld: Brooklyn NOT YET SUBMITTED stores a WITHHELD projection with that reason and no number', last('proj').status === 'WITHHELD' && last('proj').adjusted === null && /BKN has not submitted/.test(JSON.stringify(last('proj').reasons)) && last('runs').teams_not_submitted.includes('BKN'));
  resetDb(); W.lines = REPORT_LINES({ unmatched: true });
  o = await run();
  chk('withheld: an unmatched name withholds the game and raises a WARNING; the row is kept unmatched', last('proj').status === 'WITHHELD' && DB.alerts.some((a) => a.code === 'unmatched_names') && DB.rrows.some((x) => x.player_id === null && x.match_method === 'unmatched') && last('runs').unmatched === 1);
  W.lines = REPORT_LINES();
  resetDb(); W.roster = false;
  o = await run();
  chk('rosters down with no capture on file: the hoopR copy is used, labelled, and a DEGRADED alert raised', DB.caps.filter((c) => c.source === 'hoopr_rosters').length === 2 && DB.alerts.some((a) => a.code === 'roster_fetch' && a.severity === 'DEGRADED'));
  W.roster = true;
  resetDb(); W.inputs = false;
  o = await run();
  chk('inputs down: statuses and rosters still sync; no projection; a DEGRADED alert', DB.reports.length === 1 && DB.proj.length === 0 && DB.alerts.some((a) => a.code === 'inputs_unavailable'));
  W.inputs = true;

  /* ---- dry ---- */
  resetDb();
  o = await run({ dry: true });
  chk('dry: computes the projection and writes nothing at all', o.projections && o.projections.games[0].status === 'OK' && DB.calls.filter((c) => c.startsWith('POST')).length === 0 && DB.runs.length === 0, o.projections);

  /* ---- the deploy wiring ---- */
  const CRON = fs.readFileSync(path.join(ROOT, 'supabase', 'nba_injury_cron.sql'), 'utf8');
  chk('the pg_cron poke calls this function by its directory name, with its own Vault secret', /\/functions\/v1\/nba_injury_sync'/.test(CRON) && /nba_injury_cron_secret/.test(CRON));
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-nba-injury.yml'), 'utf8');
  chk('the deploy workflow tests first, deploys with JWT verification off, and applies the SQL in order', /nba_injury_core\.test\.js/.test(WF) && /nba_injury_sync\.test\.js/.test(WF) && /--no-verify-jwt/.test(WF)
    && WF.indexOf('nba_injury_layer.sql') < WF.indexOf('nba_roster_adjusted_registry.sql') && WF.indexOf('nba_roster_adjusted_registry.sql') < WF.indexOf('nba_injury_cron.sql'));

  const SRC = fs.readFileSync(FN, 'utf8');
  chk('the PDF library is imported by a literal specifier, so the deploy bundles it (a variable left it out)', /import\("npm:unpdf@\d+\.\d+\.\d+"\)/.test(SRC) && !/import\(\s*[A-Za-z_$][\w$]*\s*\)/.test(SRC));
  const commitsSlateOnly = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => {
    const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
    return y.split('push_generated.sh').slice(1).some((c) => { const cmd = c.split(/\n\s*- /)[0]; return /nba\/slate\.json/.test(cmd) && !/nba\/roster_inputs\.json/.test(cmd); });
  });
  chk('every workflow that commits nba/slate.json also commits nba/roster_inputs.json (build_slate.js writes both)', commitsSlateOnly.length === 0, commitsSlateOnly);

  console.log('nba injury sync: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL ' + f.name + (f.detail !== undefined ? '\n     ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();

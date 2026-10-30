#!/usr/bin/env node
/* ===========================================================================
   THE FOOTBALL EVIDENCE PIPELINE — regression tests.

   A publisher told us our Ole Miss–Vanderbilt piece presented EdgeDesk's
   near-even number against a market that made Ole Miss a 9.5-point favourite
   with no football reason for the disagreement. These tests hold the repaired
   pipeline to that criticism, on the frozen week the repair was judged on
   (tools/content/fixtures/evidence_2026_w6.json; tools/content/evidence_fixture.js
   rebuilds it), then on whatever the committed research says today.

     P  packets       claims carry source, time, verification and scope; the
                      research items the brief asks for are covered or MISSING
     X  explanation   statuses, the input audit, both sides' game scripts
     S  publisher     the eight ways the test article must not fail
     B  before/after  the old writer's output fails the new gate; the new passes
     G  gate          adversarial edits an AI or an editor might make
     V  generalises   Georgia–Alabama, Texas–Oklahoma, Missouri–Texas A&M,
                      UCLA–Oregon and an NFL game, in both analysis formats
     F  formats       publisher and first-party pieces are different articles
     C  cost          one packet per matchup, reused; no repeated research;
                      at most two AI calls, each budgeted first
     L  live          every generated article passes: on the research pinned
                      in fixtures/research_2026_w9.json.gz (a pull request),
                      or on today's committed artifacts with --live (the
                      daily sweep, .github/workflows/content-engine-live.yml)
     W  first-party   the game page gets the evidence; suspect pages are held

   Run: node tools/content/evidence.test.js
        node tools/content/evidence.test.js --live [--now 2026-10-29T20:14:42Z]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const FE = require(path.join(ROOT, 'lib', 'football_evidence.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'evidence_2026_w6.json'));

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

const NOW = Date.parse(FIX.frozen_at);
const SR = CE.PUBLISHER_TEMPLATES['stadium-rant'];
/* TODAY'S RESEARCH, PINNED ON A PULL REQUEST. Two checks read "today": S 3c
   (every claim the evidence builder makes) and section L (every article the
   engine would offer). Read live, they moved with the hourly data and the
   clock, and section L went red on main with no code change (1c3b5c07a,
   c933dc468, Week 9 on 2026-10-29). By default both read the research main
   held at ca6f867a0, at 20:14 UTC on October 29, where its own code BLOCKED
   two Week 9 articles until 05ad9abef and 64143ada2 repaired the writer and
   the evidence builder (fixtures/research_2026_w9.json.gz, built by
   fixtures/freeze_live.js: it keeps the inputs, so this code builds the
   packets and drafts). --live reads today's committed artifacts at the real
   clock, or at --now: the daily sweep (.github/workflows/content-engine-live.yml). */
const ART = require(path.join(__dirname, 'artifacts.js'));
const LIVE = process.argv.indexOf('--live') >= 0;
const NOW_ARG = (() => { const i = process.argv.indexOf('--now'); return i > 0 ? process.argv[i + 1] : null; })();
if (NOW_ARG !== null && (!LIVE || !isFinite(Date.parse(NOW_ARG)))) { console.error('--now takes an ISO 8601 moment, with --live'); process.exit(2); }
const PIN = LIVE ? null : ART.frozenFiles(ART.PINNED);
const LNOW = LIVE ? (NOW_ARG ? Date.parse(NOW_ARG) : Date.now()) : Date.parse(PIN.at);
const TODAY = LIVE ? ART.load({ now: LNOW }) : ART.fromFiles(PIN);
const WHOSE = LIVE ? 'today’s' : 'the pinned';
console.log((LIVE ? 'today’s committed research' : 'the research pinned in ' + path.basename(ART.PINNED) + ' (' + PIN.commit.slice(0, 9) + ')') + ', at ' + new Date(LNOW).toISOString());
const TL = FIX.teamLists;
const byId = (id) => FIX.cfb.games.concat(FIX.nfl.games).find((p) => String(p.game_id) === String(id));
const OM = byId('401856718'), GA = byId('401856712'), TX = byId('401856717'), MZ = byId('401856716'), UC = byId('401858484'), NF = FIX.nfl.games[0];
const sources = (league) => FIX.sources.filter((s) => league === 'cfb' ? /cfb_terminal|rankings|evidence/.test(s.id) : /nfl|evidence/.test(s.id))
  .map((s) => ({ kind: 'edgedesk_research', label: s.what, path: s.path, url: CE.SITE + '/' + s.path, as_of: s.as_of }));
/* an opportunity around frozen games, as discover() would make it */
function oppFor(games, kind) {
  const league = games[0].league, L = FIX[league];
  const o = { league, season: L.context.season, week: L.context.week, kind, title: 'x', teams: [].concat(...games.map((p) => [p.home, p.away])),
    research: { league, season: L.context.season, week: L.context.week, as_of: L.as_of, kind, context: L.context, games, upsets: [], races: [], limitations: [] },
    sources: sources(league), formats: kind === 'matchup_analysis' ? ['matchup_analysis', 'edgedesk_analysis'] : [league + '_weekly_preview', 'publisher_custom'] };
  o.seo = CE.seoBrief(o, SR);
  return o;
}
function write(p, format) {
  const o = oppFor([p], 'matchup_analysis');
  const pub = format === 'edgedesk_analysis' ? null : SR;
  const a = CE.draft(o, { publisher: pub, format, now: NOW });
  return { o, a, rep: CE.validate(a, o, { publisher: pub, now: NOW, teamLists: TL }) };
}
const body = (a) => a.sections.map((s) => s.body).join('\n\n');
const failed = (rep, id) => rep.checks.some((c) => c.id === id && c.status === 'fail');
const passed = (rep, id) => rep.checks.some((c) => c.id === id && c.status === 'pass') && !failed(rep, id);
/* replace a section's body, or add a sentence to it */
function edit(a, key, fn) { return Object.assign({}, a, { sections: a.sections.map((s) => s.key === key ? Object.assign({}, s, { body: fn(s.body) }) : s) }); }
function revalidate(o, a, pub) { return CE.validate(a, o, { publisher: pub === undefined ? SR : pub, now: NOW, teamLists: TL }); }

/* ── P packets ────────────────────────────────────────────────────────── */
section('P packets');
const EV = OM.evidence;
chk('P one packet per matchup, schema and hash', EV.schema === FE.SCHEMA && EV.game_id === '401856718' && /^[a-z0-9]+$/.test(EV.hash) && /^[a-z0-9]+$/.test(EV.inputs_hash));
chk('P every claim has a source, a time and a verification status', EV.claims.every((c) => c.src && EV.sources[c.src] && (EV.sources[c.src].observed_at || EV.sources[c.src].published_at) && c.verification));
chk('P model output is never football evidence', EV.claims.filter((c) => c.verification === 'MODEL_OUTPUT' || c.verification === 'MARKET_DATA').every((c) => !c.football));
chk('P outside reporting is REPORTED until an editor confirms it, and says so', EV.claims.filter((c) => c.verification === 'REPORTED').every((c) => c.needs_confirmation && /not yet confirmed/.test(c.caveat || '')));
const cov = (item) => (EV.coverage.find((c) => c.item === item) || {}).status;
['qb_efficiency', 'qb_completion', 'qb_ypa', 'qb_td_int', 'qb_sacks', 'qb_trend', 'qb_availability', 'off_points', 'off_efficiency', 'off_rush_pass', 'off_explosive', 'off_third', 'off_red_zone', 'off_line',
  'def_points', 'def_rush_pass', 'def_pressure', 'def_explosive', 'def_third', 'def_red_zone', 'position_groups', 'home_field', 'recent_results', 'head_to_head', 'injuries', 'rest_travel', 'weather', 'conference']
  .forEach((it) => chk('P Ole Miss–Vanderbilt covers ' + it, cov(it) === 'AVAILABLE', cov(it)));
chk('P what EdgeDesk does not have stays MISSING, with the reason (penalty rate)', cov('penalties') === 'MISSING' && /no current-season penalty data/.test(EV.coverage.find((c) => c.item === 'penalties').why));
chk('P no penalty figure appears anywhere in the packet', !EV.claims.some((c) => /penalt/i.test(c.text)));
chk('P schedule strength is a labelled proxy, not a number EdgeDesk does not publish', cov('schedule_strength') === 'PROXY');
chk('P turnover rates are not evidence (the feed misses fumbles)', cov('turnovers') === 'MISSING' && !EV.claims.some((c) => /turns the ball over on/.test(c.text)));
const qb = (name) => EV.claims.find((c) => /^qb_season:/.test(c.key) && c.subject === name);
chk('P Chambliss: completion rate, yards per attempt, touchdowns, interceptions, sacks', (() => { const c = qb('Trinidad Chambliss'); return c && c.values.attempts > 100 && /\(\d+\.\d%\)/.test(c.text) && /yards per attempt/.test(c.text) && /touchdown/.test(c.text) && /interception/.test(c.text) && /sacked on/.test(c.text); })());
chk('P both Vanderbilt passers are measured (the job is shared)', !!qb('Jared Curtis') && !!qb('Blaze Berlowitz'));
chk('P recent form: a last-two-games trend for a passer with four games', EV.claims.some((c) => /^qb_trend:/.test(c.key) && /last two games/.test(c.text)));
chk('P the official availability report: Curtis probable, Lacy questionable', EV.claims.some((c) => c.verification === 'OFFICIAL_REPORT' && c.subject === 'Jared Curtis' && c.status === 'PROBABLE')
  && EV.claims.some((c) => c.verification === 'OFFICIAL_REPORT' && c.subject === 'Kewan Lacy' && c.status === 'QUESTIONABLE'));
chk('P Vanderbilt’s 38–14 loss at Georgia is a certified result', EV.claims.some((c) => c.topic === 'results' && /lost 38–14 at Georgia/.test(c.text) && c.verification === 'VERIFIED_DATA'));
chk('P … and the halftime score is reported, attributed and dated', EV.claims.some((c) => /21–14 at halftime/.test(c.text) && /Associated Press/.test(c.text) && c.verification === 'REPORTED'));
chk('P head-to-head is historical and dated (2023, Ole Miss 33–7)', EV.claims.some((c) => c.key === 'h2h' && c.scope === 'historical' && /2023/.test(c.text) && /33–7/.test(c.text)));
chk('P the sack figures EdgeDesk’s own sources dispute are not used as evidence', EV.claims.filter((c) => c.topic === 'data').every((c) => c.verification === 'CONFLICTING' && !c.football));
chk('P a stale line is labelled stale with its capture time', EV.market.status === 'stale' && EV.market.captured_at && /captured/.test(EV.claims.find((c) => c.key === 'market').text));
chk('P nothing time-relative: the packet is the same when its inputs are', !/\bhours? (ago|old)\b/.test(JSON.stringify(EV)));

/* ── X explanation ────────────────────────────────────────────────────── */
section('X explanation');
const X = EV.explanation;
chk('X EdgeDesk projects Ole Miss by 0.2; the comparable market is Ole Miss -9.5; 9.3 points toward Vanderbilt', EV.model.text === 'Ole Miss by 0.2' && EV.market.text === 'Ole Miss -9.5' && X.gap.points === 9.3 && X.gap.toward === 'Vanderbilt');
chk('X the model’s inputs, with their points and direction', X.model_terms.some((t) => t.key === 'hfa' && t.favors === 'Vanderbilt' && t.toward_gap) && X.model_terms.some((t) => t.key === 'rating' && t.favors === 'Ole Miss'));
chk('X UNEXPLAINED: EdgeDesk accounts for about 2.0 of 9.3 points', X.status === 'UNEXPLAINED' && X.mechanical && X.mechanical.explained_points === 2 && /cannot account/.test(X.assessment));
chk('X the measured football leans toward Ole Miss, and the assessment says so', X.football_balance.score < 0 && /leans toward Ole Miss/.test(X.assessment));
chk('X the input audit names the stale quarterback input (Berlowitz modelled, Curtis probable)', X.input_flags.some((f) => f.key === 'QB_INPUT_CONFLICT' && f.severity === 'high' && /Berlowitz/.test(f.text) && /Curtis/.test(f.text) && /probable/.test(f.text)));
chk('X … and EdgeDesk’s own DATA FAULT label, and the home-field constant', X.input_flags.some((f) => f.key === 'DATA_FAULT') && X.input_flags.some((f) => f.key === 'HFA_CONSTANT' && /61%/.test(f.text)));
chk('X inputs suspect; never actionable', X.input_suspect === true && X.actionable === false && /not as an edge/.test(X.assessment));
chk('X a thesis in model terms that disclaims football causation', /mechanics, not football reasons/.test(X.thesis));
chk('X supporting and contradicting evidence are both football', X.supporting.length >= 2 && X.contradicting.length >= 3 && X.contradicting.some((id) => (EV.claims.find((c) => c.id === id) || {}).football));
chk('X the model’s own doubts are contrary evidence (its record when this far off)', X.contradicting.some((id) => (EV.claims.find((c) => c.id === id) || {}).key === 'track_record'));
chk('X the critical matchup is a football question', X.critical_matchup && /^Can Vanderbilt’s Pass Rush Get to Chambliss\?$/.test(X.critical_matchup.question));
chk('X a game script for each number', X.game_script.model_case.length >= 3 && X.game_script.market_case.length >= 2 && X.game_script.model_case.some((t) => /Curtis/.test(t)));
chk('X the unresolved uncertainty is listed', X.uncertainty.some((t) => /Lacy/.test(t)) && X.uncertainty.some((t) => /penalty rate/.test(t)));

/* ── S the publisher's criticism ─────────────────────────────────────── */
section('S the publisher’s criticism');
const OMP = write(OM, 'matchup_analysis'), OMB = body(OMP.a);
chk('S the Ole Miss–Vanderbilt analysis passes every hard check', OMP.rep.ok, OMP.rep.failed);
chk('S … and is HELD for review, not ready (six outside reports to confirm; suspect inputs)', OMP.rep.readiness === 'HOLD_FOR_REVIEW' && OMP.rep.holds.length >= 6);
chk('S 1 it gives the projection WITH football evidence', passed(OMP.rep, 'football_evidence') && OMP.rep.evidence_record.filter((r) => /VERIFIED_DATA|OFFICIAL_REPORT|RATING|REPORTED/.test(r.verification)).length >= 15);
chk('S 2 it discusses recent quarterback performance for both teams', passed(OMP.rep, 'qb_discussed') && /Chambliss has completed 103 of 146/.test(OMB) && /Curtis has completed/.test(OMB) && /Berlowitz has completed/.test(OMB) && /last two games/.test(OMB));
chk('S 3 it addresses the material injuries: Curtis’s knee and status, Lacy’s shoulder and status', passed(OMP.rep, 'injuries_addressed') && /bruised knee/.test(OMB) && /lists quarterback Jared Curtis as probable/.test(OMB) && /Lacy as questionable/.test(OMB) && /shoulder/.test(OMB));
/* 2026-10-29 (Kansas State at Colorado, week 9): a weekly-preview capsule whose quarterback line
   led with an input conflict printed no other official listing, so a second quarterback listed
   OUT went unmentioned and the gate (rightly) blocked the preview. "Jordan Example" is invented. */
chk('S 3b a weekly-preview capsule names every quarterback on the availability report, not only the one in a conflict', (() => {
  const g = JSON.parse(JSON.stringify(OM));
  const base = g.evidence.claims.find((c) => c.key === 'report:home:Jared Curtis');
  g.evidence.claims.push(Object.assign({}, base, { id: 'c_test_second_qb_out', key: 'report:home:Jordan Example', subject: 'Jordan Example', status: 'OUT',
    values: Object.assign({}, base.values, { status: 'OUT' }), label: 'Jordan Example (official availability)',
    text: base.text.replace('Jared Curtis as probable', 'Jordan Example as out'), short: 'Jordan Example is listed as out on the SEC availability report',
    cite: { nums: [], words: ['Example', 'report|lists|listed|out'], all: true } }));
  const o = oppFor([g], 'upset_watch');
  const a = CE.draft(o, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
  const r = CE.validate(a, o, { publisher: SR, now: NOW, teamLists: TL });
  const body = a.sections.map((s) => s.body).join('\n');
  return /Jordan Example is listed as out/.test(body) && /Jared Curtis/.test(body) && (r.failed || []).indexOf('injuries_addressed') < 0;
})());
/* 2026-10-29: two fixes for the same capsule (#904, #907) merged side by side, and every quarterback
   listing was printed up to three times, which no_repetition then blocked. Each is said once. */
chk('S 3e a weekly-preview capsule says each quarterback listing once', (() => {
  const g = JSON.parse(JSON.stringify(OM));
  const base = g.evidence.claims.find((c) => c.key === 'report:home:Jared Curtis');
  g.evidence.claims.push(Object.assign({}, base, { id: 'c_test_second_qb_out', key: 'report:home:Jordan Example', subject: 'Jordan Example', status: 'OUT',
    values: Object.assign({}, base.values, { status: 'OUT' }), label: 'Jordan Example (official availability)',
    text: base.text.replace('Jared Curtis as probable', 'Jordan Example as out'), short: 'Jordan Example is listed as out on the SEC availability report',
    cite: { nums: [], words: ['Example', 'report|lists|listed|out'], all: true } }));
  const a = CE.draft(oppFor([g], 'upset_watch'), { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
  const qb = (a.sections.map((s) => s.body).join('\n').match(/\*\*Quarterbacks:\*\*[^\n]*/) || [''])[0];
  const said = qb.replace(/\*\*Quarterbacks:\*\*\s*/, '').split(/(?<=\.)\s+/).filter(Boolean);
  const twice = said.filter((x, i) => said.indexOf(x) !== i);
  return said.length > 0 && twice.length === 0 || (console.log('   repeated: ' + JSON.stringify(twice)), false);
})());
/* 2026-10-29 (Utah at Cincinnati, week 9): a claim's citation numbers were rounded apart from its
   printed text (0.5185 printed 51.8% but was cited as 51.9), so an article quoting the claim word for
   word failed numbers_in_evidence. Every citation number must be one the claim itself prints. */
/* scanned on packets this code builds from "today" (pinned on a pull request, above); the frozen
   week-6 fixture keeps the citations its own build wrote (it is a record, not regenerated), and
   S 3d proves the rounding on a constructed number */
chk('S 3c every claim the current build makes cites only numbers its own text prints (' + WHOSE + ' research)', (() => {
  const bad = [];
  const scan = (packets) => packets.forEach((pk) => (pk.claims || []).forEach((c) => {
    const printed = (String(c.text) + ' ' + String(c.short || '')).match(/\d+(?:\.\d+)?/g) || [];
    ((c.cite && c.cite.nums) || []).forEach((n) => { if (!printed.some((t) => +t === +n)) bad.push(pk.game_id + ' ' + c.key + ' cites ' + n); });
  }));
  const live = LIVE ? require(path.join(__dirname, 'evidence.js')).build({ now: LNOW }) : TODAY.evidence;
  scan([].concat(Object.values((live.cfb || {}).packets || {}), Object.values((live.nfl || {}).packets || {})));
  return bad.length === 0 || (console.log('   ' + bad.slice(0, 5).join('\n   ')), false);
})());
/* the same defect, deterministically: a percentage on a rounding boundary is cited as printed */
chk('S 3d a percentage on a rounding boundary (0.5185) is cited exactly as the claim prints it', (() => {
  const t = FE.writer.metricText, n = FE.writer.metricNum;
  return !!(t && n) && t('early_down_success', 0.5185) === '51.9%' && n('early_down_success', 0.5185) === '51.9' && n('def_early_down_allowed', 0.4405) === t('def_early_down_allowed', 0.4405).replace('%', '');
})());
chk('S 4 it states the evidence against EdgeDesk’s number', passed(OMP.rep, 'contrary_evidence') && /The case for Ole Miss, and against EdgeDesk’s number/.test(OMB));
chk('S 5 it never invents why the model likes a team', passed(OMP.rep, 'causal_supported') && /mechanics, not football reasons/.test(OMB));
chk('S 6 it does not treat the unexplained gap as an edge', passed(OMP.rep, 'unexplained_disclosed') && passed(OMP.rep, 'no_edge_language') && /not an edge/.test(OMB));
chk('S 7 the market is the last captured line, labelled as such, never current', passed(OMP.rep, 'stale_prices_labelled') && /last captured line/.test(OMB) && !/current line/.test(OMB));
chk('S 8 it identifies meaningful matchups instead of generic commentary', passed(OMP.rep, 'no_repetition') && /pass-rush matchup/.test(OMB) && /When Ole Miss has the ball/.test(OMB) && /When Vanderbilt has the ball/.test(OMB));
chk('S it explains why the game could be competitive AND why Ole Miss could dominate', /The football that does point toward Vanderbilt/.test(OMB) && /The case for Ole Miss/.test(OMB) && /For EdgeDesk’s number .* to look right/.test(OMB) && /For the last captured line, Ole Miss -9.5, to look right/.test(OMB));
chk('S the brief’s research facts are addressed: Georgia loss, head-to-head, Ole Miss’s line', /lost 38–14 at Georgia/.test(OMB) && /last meeting, in 2023/.test(OMB) && /both starting tackles/.test(OMB) && /allowed a sack on/.test(OMB));
chk('S the penalty rate it could not verify is said to be missing, not invented', /penalty rate/.test(OMB) && !/penalties per game|penalty yards/.test(OMB));
chk('S every central claim has an evidence record: source, time, verification', OMP.rep.evidence_record.length >= 20 && OMP.rep.evidence_record.every((r) => r.source && r.verification && (r.observed_at || r.source.published_at)));
chk('S outside reporting is linked to its outlet', /\[The Atlanta Journal-Constitution\]\(https:\/\/www\.ajc\.com\//.test(OMB) && /\[WKRN\]\(https:\/\/www\.wkrn\.com\//.test(OMB));
chk('S the headline is a football question', /^Ole Miss vs\. Vanderbilt: Can Vanderbilt’s Pass Rush Get to Chambliss\?$/.test(OMP.a.title));
chk('S the journalist-first structure, in order', JSON.stringify(OMP.a.sections.map((s) => s.key)) === JSON.stringify(['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'conclusion']));

/* ── B before / after ─────────────────────────────────────────────────── */
section('B before and after');
/* the old writer: the same research with no evidence packet (the capsule the
   publisher received), judged by today's gate against the evidence */
const noEv = (p) => { const c = Object.assign({}, p); delete c.evidence; return c; };
const slateGames = [GA, MZ, TX, UC, OM];
const oldOpp = oppFor(slateGames.map(noEv), 'weekly_preview');
const oldArt = CE.draft(oldOpp, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
const newOpp = oppFor(slateGames.map((p) => Object.assign({}, p, { evidence: FE.trim(p.evidence) })), 'weekly_preview');
const oldRep = revalidate(newOpp, oldArt);
const oldOM = oldArt.sections.find((s) => s.key === 'games').body.split('\n### ').find((b) => /Ole Miss at Vanderbilt/.test(b));
chk('B without the evidence packet the Ole Miss capsule is what the publisher saw: the numbers, no football', /near coin flip/.test(oldOM) && /9\.5/.test(oldOM) && !/yards per attempt|availability report|completed \d+ of/.test(oldOM));
chk('B the old article FAILS the new gate', oldRep.ok === false && oldRep.readiness === 'BLOCKED');
chk('B … no football evidence for Ole Miss–Vanderbilt', oldRep.checks.some((c) => c.id === 'football_evidence' && c.status === 'fail' && c.game === '401856718'));
chk('B … no evidence against EdgeDesk where it shows the line', oldRep.checks.some((c) => c.id === 'contrary_evidence' && c.status === 'fail'));
chk('B … the unexplained 9.3-point gap is not called unexplained', oldRep.checks.some((c) => c.id === 'unexplained_disclosed' && c.status === 'fail' && c.game === '401856718'));
chk('B … the quarterback-input conflict goes unmentioned', oldRep.checks.some((c) => c.id === 'injuries_addressed' && c.status === 'fail' && c.game === '401856718'));
const newArt = CE.draft(newOpp, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
const newRep = revalidate(newOpp, newArt);
chk('B the new slate passes every hard check', newRep.ok, newRep.failed);
const newOM = newArt.sections.find((s) => s.key === 'games').body.split('\n### ').find((b) => /Ole Miss at Vanderbilt/.test(b));
chk('B the new Ole Miss capsule argues both sides with football and discloses the gap', /\*\*Why it could be closer than the line says:\*\*/.test(newOM) && /\*\*Why Ole Miss could win comfortably:\*\*/.test(newOM)
  && /\*\*Quarterbacks:\*\*/.test(newOM) && /\*\*What EdgeDesk can’t explain:\*\*/.test(newOM) && /unexplained/.test(newOM) && !/Model confidence/.test(newOM));

/* ── G gate: adversarial edits ────────────────────────────────────────── */
section('G gate');
const o1 = OMP.o, a1 = OMP.a;
const add = (key, s) => edit(a1, key, (b) => b + '\n\n' + s);
chk('G a football stat presented as the model’s reason fails',
  failed(revalidate(o1, add('thesis', 'EdgeDesk’s model likes Vanderbilt because Vanderbilt’s defense sacks the quarterback on 8.0% of opponent dropbacks.')), 'causal_supported'));
chk('G an evidence-free cause for the gap fails', failed(revalidate(o1, add('thesis', 'The gap exists because the market has overlooked how good Vanderbilt really is.')), 'causal_supported'));
chk('G a football cause for an UNEXPLAINED gap fails', failed(revalidate(o1, add('thesis', 'The difference comes from Ole Miss’ offense succeeding on 53.9% of its first- and second-down plays.')), 'causal_supported'));
['Vanderbilt is the value side here.', 'The market is wrong about this game.', 'This line looks mispriced.', 'Sharp money should be on Vanderbilt.', 'EdgeDesk has a betting edge on Vanderbilt.']
  .forEach((s) => chk('G edge language fails: “' + s + '”', failed(revalidate(o1, add('conclusion', s)), 'no_edge_language')));
chk('G “Jared Curtis will start” fails: he is probable', failed(revalidate(o1, add('evidence', 'Jared Curtis will start for Vanderbilt.')), 'injury_status_correct'));
chk('G “Jared Curtis is out” fails', failed(revalidate(o1, add('evidence', 'Jared Curtis is out for Vanderbilt.')), 'injury_status_correct'));
chk('G “Kewan Lacy is out” fails: he is questionable', failed(revalidate(o1, add('evidence', 'Kewan Lacy is out against Vanderbilt.')), 'injury_status_correct'));
chk('G a past absence is not a status claim', passed(revalidate(o1, add('evidence', 'Jared Curtis missed the Georgia game.')), 'injury_status_correct'));
chk('G history without its date fails', failed(revalidate(o1, add('evidence', 'Ole Miss won the last meeting 33–7.')), 'historical_dated'));
/* the last score is recognised as a score, not as its two numbers anywhere in a sentence (a date and a stat line) */
chk('G a date and a stat line that happen to hold the last score’s numbers are not history', passed(revalidate(o1, add('evidence', 'Against Georgia on Oct. 7, Jared Curtis went 33 of 40.')), 'historical_dated'));
chk('G … but the score written as a score, undated, still fails (either order)', failed(revalidate(o1, add('evidence', 'Vanderbilt lost 7-33 to Ole Miss.')), 'historical_dated'));
chk('G the wrong gap fails (the published 8.5 is not today’s 9.3)', failed(revalidate(o1, add('thesis', 'That is an 8.5-point gap between EdgeDesk and the market.')), 'gap_arithmetic'));
chk('G an invented statistic fails', failed(revalidate(o1, add('evidence', 'Vanderbilt commits 7.4 penalties per game.')), 'numbers_in_evidence'));
/* 70.5 is Chambliss's completion rate: real, in the packet, but only valid where that claim is cited */
chk('G a real number moved onto the wrong claim fails', failed(revalidate(o1, add('evidence', 'Vanderbilt has won 70.5% of its home games.')), 'numbers_in_evidence'));
chk('G a link to a source not in the research fails', failed(revalidate(o1, add('evidence', 'See [a blog](https://example.com/vandy-hype) for more.')), 'sources_known'));
chk('G outside reporting without its outlet fails', failed(revalidate(o1, edit(a1, 'evidence', (b) => b.replace(/, according to \[WKRN\]\([^)]+\)/, ''))), 'reported_attributed'));
/* every phrase the gate accepts as saying “EdgeDesk cannot explain this” is removed; “not an edge” stays */
const stripAll = (re) => Object.assign({}, a1, { sections: a1.sections.map((s) => Object.assign({}, s, { body: s.body.replace(new RegExp(re.source, 'gi'), 'notable') })) });
chk('G dropping the unexplained disclosure fails', failed(revalidate(o1, stripAll(FE.DISCLOSE_RE.unexplained)), 'unexplained_disclosed'));
chk('G … and so does dropping “not an edge” while keeping “unexplained”', failed(revalidate(o1, stripAll(FE.DISCLOSE_RE.not_edge)), 'unexplained_disclosed'));
chk('G dropping the counterargument fails', failed(revalidate(o1, edit(edit(edit(a1, 'counterargument', () => 'Nothing to add here about the other side of this game at all.'), 'game_script', () => 'Both teams will try to play well and win the game on Saturday.'), 'conclusion', () => 'None of this is a pick.')), 'contrary_evidence'));
chk('G dropping the quarterbacks fails', failed(revalidate(o1, edit(a1, 'evidence', (b) => b.split('\n\n').filter((x) => !/^\*\*The quarterbacks|^Jared Curtis has/.test(x)).join('\n\n'))), 'qb_discussed'));
chk('G the same sentence three times fails', failed(revalidate(o1, add('conclusion', 'Vanderbilt will need its best game of the season against a very good team. Vanderbilt will need its best game of the season against a very good team. Vanderbilt will need its best game of the season against a very good team.')), 'no_repetition'));
chk('G a stale line called current fails', failed(revalidate(o1, add('conclusion', 'The current line is Ole Miss -9.5 at the books.')), 'stale_prices_labelled'));
chk('G a code identifier fails for a publisher (the NFL model’s “net_pass”)', failed(revalidate(o1, add('conclusion', 'The biggest piece is net_pass, worth a lot.')), 'no_software_jargon'));
chk('G software jargon fails for a publisher', failed(revalidate(o1, add('conclusion', 'The V2.1 ensemble and the champion model disagree.')), 'no_software_jargon'));
/* the format decides the audience: a matchup_analysis is written for a publisher whoever validates it */
chk('G … even when no publisher is named, a publisher format keeps the rule', failed(revalidate(o1, add('conclusion', 'The V2.1 ensemble disagrees.'), null), 'no_software_jargon'));
chk('G … but not for EdgeDesk’s own page', (() => { const w = write(OM, 'edgedesk_analysis'); const a = edit(w.a, 'conclusion', (b) => b + '\n\nThe V2.1 ensemble disagrees.'); return !failed(CE.validate(a, w.o, { publisher: null, now: NOW, teamLists: TL }), 'no_software_jargon'); })());
/* a conference report names one quarterback ("lists quarterback Jared Curtis
   as questionable"): a sourced report, like the NFL's player list, so the
   sentence the packet itself prints is not charged as unsupported */
{
  const SENT = 'Vanderbilt’s initial SEC availability report (published Oct. 7) lists quarterback Jared Curtis as questionable.';
  const withReport = (keep) => {
    const p = JSON.parse(JSON.stringify(OM));
    p.evidence.claims = p.evidence.claims.filter((c) => keep || !(c.verification === 'OFFICIAL_REPORT' && c.team === 'Vanderbilt'));
    p.evidence.claims.filter((c) => c.verification === 'OFFICIAL_REPORT' && c.subject === 'Jared Curtis').forEach((c) => { c.values.status = 'QUESTIONABLE'; c.status = 'QUESTIONABLE'; });
    const w = write(p, 'matchup_analysis');
    return CE.validate(edit(w.a, 'conclusion', (b) => b + '\n\n' + SENT), w.o, { publisher: SR, now: NOW, teamLists: TL });
  };
  chk('G a conference report’s quarterback listing supports the uncertainty it states', passed(withReport(true), 'qb_claims_sourced'), withReport(true).checks.filter((c) => c.id === 'qb_claims_sourced'));
  chk('G … and the same sentence with no Vanderbilt report on file still fails', failed(withReport(false), 'qb_claims_sourced'));
}
/* the draft's OWN quarterback-input sentence (plainFlags). The conflict names
   two players, the model's starter and the reported one; the draft names only
   the reported one, and states his status only when the index validate()
   reads lets it, so the engine never blocks a sentence it wrote itself */
{
  const qbSentence = (b) => (b.match(/[^.]*quarterback input[^.]*\./) || [''])[0];
  const variant = (fn) => { const p = JSON.parse(JSON.stringify(OM)); fn(p); return write(p, 'matchup_analysis'); };
  const s0 = qbSentence(body(write(OM, 'matchup_analysis').a));
  chk('Q the input-conflict sentence is drafted and never names the model’s own starter', /quarterback input/.test(s0) && !/Berlowitz/.test(s0), s0);
  const q = variant((p) => p.evidence.claims.filter((c) => c.subject === 'Jared Curtis' && (c.verification === 'OFFICIAL_REPORT' || (c.topic === 'input' && c.verification === 'CONFLICTING')))
    .forEach((c) => { c.values.status = 'QUESTIONABLE'; c.status = 'QUESTIONABLE'; }));
  const s1 = qbSentence(body(q.a));
  chk('Q a reported starter listed questionable on a sourced report is named with his status, and the draft passes its own check',
    /Jared Curtis is listed as questionable/.test(s1) && !/Berlowitz/.test(s1) && passed(q.rep, 'qb_claims_sourced'), [s1, q.rep.checks.filter((c) => c.id === 'qb_claims_sourced')]);
  /* the report lists the model's OWN starter: he is named as the starter it expects, never as "a different starter" */
  const own = variant((p) => p.evidence.claims.forEach((c) => {
    if (c.topic === 'input' && c.verification === 'CONFLICTING') { c.values.model_starter = 'Jared Curtis'; c.values.status = 'QUESTIONABLE'; }
    if (c.verification === 'OFFICIAL_REPORT' && c.subject === 'Jared Curtis') { c.values.status = 'QUESTIONABLE'; c.status = 'QUESTIONABLE'; }
  }));
  const so = qbSentence(body(own.a));
  chk('Q when the report lists the model’s own starter, he is named as the starter it expects', /Jared Curtis, the starter it expects, is listed as questionable/.test(so) && !/different starter/.test(so) && passed(own.rep, 'qb_claims_sourced'), so);
  const u = variant((p) => { p.evidence.claims = p.evidence.claims.filter((c) => !(c.verification === 'OFFICIAL_REPORT' && c.subject === 'Jared Curtis')); });
  const s2 = qbSentence(body(u.a));
  chk('Q with no sourced report behind him, the sentence asserts nobody’s availability and the draft still passes',
    /should be checked against the latest availability report/.test(s2) && !/Curtis|Berlowitz|questionable|probable/.test(s2) && passed(u.rep, 'qb_claims_sourced'), [s2, u.rep.checks.filter((c) => c.id === 'qb_claims_sourced')]);
}
/* the packet's own "other models" claim, printed verbatim, reconciles even
   when the opportunity carries no games-to-watch packet to read them from */
{
  const OTHER = 'EdgeDesk’s two other, independently built models have Ole Miss by 1.3 and Vanderbilt by 0.4.';
  const withOthers = (p) => { p.evidence.claims = p.evidence.claims.filter((c) => c.key !== 'other_models').concat([{ id: 'x-other', topic: 'model', key: 'other_models', label: 'EdgeDesk’s other models', text: OTHER,
    short: 'EdgeDesk’s other models: Ole Miss by 1.3 and Vanderbilt by 0.4', cite: { nums: ['1.3'], words: ['other', 'models'] },
    values: { median_home_line: -0.5, models: [] }, source: { id: 'cfb_terminal', label: 'EdgeDesk model consensus' }, observed_at: FIX.frozen_at, verification: 'MODEL_OUTPUT' }]); return p; };
  const w = write(withOthers(JSON.parse(JSON.stringify(OM))), 'matchup_analysis');
  const say = (t) => CE.validate(edit(w.a, 'conclusion', (b) => b + '\n\n' + t), w.o, { publisher: SR, now: NOW, teamLists: TL });
  chk('N the other models’ margins, as the evidence packet states them, reconcile', !((w.o.research.matchups || []).length) && passed(say(OTHER), 'numbers_reconcile'), say(OTHER).checks.filter((c) => c.id === 'numbers_reconcile'));
  chk('N … and a margin no EdgeDesk model has still fails', failed(say('EdgeDesk’s two other, independently built models have Ole Miss by 7.7 and Vanderbilt by 0.4.'), 'numbers_reconcile'));
}
/* the 14-check editorial gate (CE.gate) the database requires before approval sees the evidence too */
chk('G the editorial gate BLOCKS when the evidence fails (under unsupported factual claims)', (() => {
  const bad = add('thesis', 'EdgeDesk’s model likes Vanderbilt because Vanderbilt’s defense sacks the quarterback on 8.0% of opponent dropbacks.');
  const g = CE.gate(Object.assign({}, bad, { format: 'matchup_analysis' }), o1, { now: NOW, publisher: SR, teamLists: TL });
  return g.verdict === 'BLOCKED' && g.items.find((i) => i.key === 'claims').status === 'BLOCKED' && g.items.find((i) => i.key === 'claims').findings.some((f) => /unsupported causal/i.test(f.reason));
})());
chk('G … and turns each evidence hold into a warning the owner clears in review', (() => {
  const g = CE.gate(Object.assign({}, a1, { format: 'matchup_analysis' }), o1, { now: NOW, publisher: SR, teamLists: TL });
  const rel = g.items.find((i) => i.key === 'reliability');
  return rel.findings.filter((f) => /^Held for review: /.test(f.reason) && f.status === 'WARNING').length === OMP.rep.holds.length && !g.items.find((i) => i.key === 'claims').findings.some((f) => f.status === 'BLOCKED');
})());
chk('G without the evidence module the gate fails closed', (() => {
  const saved = globalThis.EDFootballEvidence; const M = require.cache[require.resolve(path.join(ROOT, 'lib', 'football_evidence.js'))];
  /* a fresh core with no module reachable */
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'content_engine.js'), 'utf8').replace("require('./football_evidence.js')", "require('./__absent__.js')");
  delete globalThis.EDFootballEvidence;
  const sandbox = { module: { exports: {} }, require: require, globalThis: {}, window: undefined };
  new Function('module', 'require', 'globalThis', src)(sandbox.module, (p) => { if (/__absent__/.test(p)) throw new Error('absent'); return require(p); }, {});
  globalThis.EDFootballEvidence = saved; void M;
  const CE2 = sandbox.module.exports;
  const r = CE2.validate(a1, o1, { publisher: SR, now: NOW, teamLists: TL });
  return r.ok === false && r.failed.includes('evidence_gate');
})());

/* ── V generalises ────────────────────────────────────────────────────── */
section('N a player is not a team');
/* 2026-10-26: the Week 9 upset watch was BLOCKED, on main and in the live check
   below, for "53.6 (in a sentence about Marshall)". The sentence was Kansas'
   quarterback line, "Isaiah Marshall: 53.6% completions, 7.9 yards per
   attempt", and Marshall at Old Dominion was another game in the article.
   numbers_per_game and conference_claims read "Marshall" in the player's name
   as the team. A named player now ties a sentence to the player's own game and
   team; numbers and conferences that are wrong for that game still fail. */
{
  const pg = (id, away, home, conf, extra) => Object.assign({ game_id: id, away, home, away_conference: conf, home_conference: conf, kickoff: '2026-10-31T19:00:00Z', publishable: true, fair_home_line: -3, win_prob_home: 0.6 }, extra || {});
  const KU = pg('n1', 'Kansas', 'TCU', 'Big 12', { qb: { away: { player: 'Isaiah Marshall' }, home: { player: 'Jaden Craig' } },
    evidence: { claims: [{ id: 'cn1', topic: 'qb', team: 'Kansas', side: 'away', subject: 'Isaiah Marshall', text: 'Isaiah Marshall has completed 53.6% of his passes, 7.9 yards per attempt.',
      short: 'Isaiah Marshall: 53.6% completions, 7.9 yards per attempt', cite: { nums: ['7.9'], words: ['Marshall'] }, values: { completions: 105, attempts: 196 } }] } });
  const MU = pg('n2', 'Marshall', 'Old Dominion', 'Sun Belt', { qb: { away: { player: 'Braylon Braxton' } } });
  const NO = { key: 'cfb:2026:w9:player-not-team', kind: 'upset_watch', league: 'cfb', season: 2026, week: 9, formats: ['cfb_weekly_preview'],
    research: { as_of: '2026-10-27T11:00:00Z', games: [KU, MU], upsets: [], matchups: [], context: {} } };
  const gate = (body, id) => {
    const r = CE.validate({ format: 'cfb_weekly_preview', title: 'Week 9', sections: [{ key: 'game_1', heading: 'Kansas at TCU', body }] }, NO,
      { now: Date.parse('2026-10-27T12:00:00Z'), teamLists: { cfb: ['Kansas', 'TCU', 'Marshall', 'Old Dominion'], nfl: [] } });
    return r.checks.find((c) => c.id === id) || { status: 'absent' };
  };
  const a = gate('**Quarterbacks:** Isaiah Marshall: 53.6% completions, 7.9 yards per attempt.', 'numbers_per_game');
  chk('N a quarterback line with his own game’s numbers passes, though his surname is another team in the article', a.status === 'pass', a);
  const b = gate('**Quarterbacks:** Isaiah Marshall: 61.2% completions.', 'numbers_per_game');
  chk('N a number his game’s research does not hold still fails, named against the player', b.status === 'fail' && /61\.2 \(in a sentence about Isaiah Marshall\)/.test(b.detail), b);
  const c = gate('Marshall’s offense completes 53.6% of its passes.', 'numbers_per_game');
  chk('N the team Marshall with a Kansas number still fails', c.status === 'fail' && /53\.6 \(in a sentence about Marshall\)/.test(c.detail), c);
  const d = gate('Isaiah Marshall is the most efficient passer in the SEC.', 'conference_claims');
  chk('N a conference claim is judged on the player’s own team: Kansas is not in the SEC', d.status === 'fail' && /SEC with Kansas/.test(d.detail), d);
  const e = gate('Isaiah Marshall is among the most efficient passers in the Big 12.', 'conference_claims');
  chk('N ...and Kansas is in the Big 12', e.status === 'pass', e);
}

section('R a claim and its citation round the same way');
/* 2026-10-29: the Utah–Cincinnati matchup piece was BLOCKED, on main and in
   the live check below, for "not in the evidence: 51.8, 44, 42.6". Utah's
   early-down success is 0.5185 and Cincinnati's allowed rate 0.4405. The
   claim's text rounded with toFixed (51.8%, 44.0%: 0.5185 × 100 is stored as
   51.849999…) and its citation with EdgeDesk's rounding (51.9, 44.1), so the
   sentence never cited the claim it was. Both now round half away from zero. */
{
  const unit = (off, def) => ({ performance: { offense_detail: { used: off }, defense_detail: { used: def } } });
  const pk = FE.buildCfb({ game: { game: { id: 'r1', home: 'Cincinnati', away: 'Utah' } }, keys: { home: 'cin', away: 'uta' },
    metrics: { away: unit([{ id: 'early_down_success', raw: 0.5185, league: 0.4264, n_obs: 314 }], []), home: unit([], [{ id: 'def_early_down_allowed', raw: 0.4405, league: 0.4264, n_obs: 300 }]) } }, { now: NOW });
  const c = pk.claims.find((x) => x.key === 'pair:early_downs:away');
  chk('R a percentage is printed as EdgeDesk rounds it: 0.5185 is 51.9%, 0.4405 is 44.1%', !!c && /51\.9%/.test(c.text) && /44\.1%/.test(c.text) && /51\.9%/.test(c.short) && /44\.1%/.test(c.short), c && c.text);
  chk('R … so the claim’s own sentence cites it', !!c && FE.citedClaims(pk, c.text).some((x) => x.id === c.id), c && c.cite);
}

section('K every quarterback on the report');
/* 2026-10-29: the Week 9 upset watch was BLOCKED, on main and in the live
   check below, for "Kansas State at Colorado: not mentioned — Avery Johnson
   is listed as out". Kansas State's report listed Jacob Knuth, the starter
   EdgeDesk's model expects, as doubtful (an input conflict) and Avery Johnson
   as out. A weekly-preview capsule stated a side's conflict and then no other
   report line for that side (without a conflict, only the first). It now
   states what the gate requires of a game: every conflict and every
   quarterback on a report. Here Vanderbilt's report, beside the Curtis
   conflict, lists a stand-in third quarterback out. */
{
  const ev = JSON.parse(JSON.stringify(FE.trim(OM.evidence)));
  const curtis = ev.claims.find((c) => c.key === 'report:home:Jared Curtis');
  ev.claims.push(Object.assign({}, curtis, { id: 'c_k_third_qb', key: 'report:home:Sam Thirdstring', subject: 'Sam Thirdstring', label: 'Sam Thirdstring (official availability)',
    text: 'Vanderbilt’s initial SEC availability report (published Oct. 7) lists quarterback Sam Thirdstring as out.', short: 'Sam Thirdstring is listed as out on the SEC availability report',
    cite: { nums: [], words: ['Thirdstring', 'report|lists|listed|out'], all: true }, values: { status: 'OUT', position: 'QB' }, status: 'OUT' }));
  const o = oppFor(slateGames.map((p) => Object.assign({}, p, { evidence: p === OM ? ev : FE.trim(p.evidence) })), 'weekly_preview');
  const a = CE.draft(o, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
  const r = revalidate(o, a);
  const vu = a.sections.find((s) => s.key === 'games').body.split('\n### ').find((b) => /Ole Miss at Vanderbilt/.test(b)) || '';
  const ia = r.checks.find((c) => c.id === 'injuries_addressed' && c.game === '401856718') || {};
  chk('K the capsule states the conflict and the other quarterback the report lists out', /The model expects Blaze Berlowitz, but Jared Curtis is listed as probable/.test(vu) && /Sam Thirdstring is listed as out/.test(vu), vu.split('\n\n').filter((l) => /Quarterbacks/.test(l)));
  chk('K … so the game passes injuries_addressed', ia.status === 'pass', ia);
  chk('K … and the slate still passes every hard check', r.ok, r.failed);
}

section('V generalises');
[[GA, 'Georgia at Alabama'], [TX, 'Texas at Oklahoma'], [MZ, 'Texas A&M at Missouri'], [UC, 'UCLA at Oregon'], [NF, 'Bengals at Dolphins (NFL)']].forEach(([p, name]) => {
  ['matchup_analysis', 'edgedesk_analysis'].forEach((fmt) => {
    const w = write(p, fmt), b = body(w.a);
    chk('V ' + name + ' · ' + fmt + ': every hard check passes', w.rep.ok, w.rep.failed);
    chk('V ' + name + ' · ' + fmt + ': five-plus football claims, both quarterbacks, contrary evidence', passed(w.rep, 'football_evidence') && passed(w.rep, 'qb_discussed') && passed(w.rep, 'contrary_evidence'));
    chk('V ' + name + ' · ' + fmt + ': no code identifiers in the copy', !/\b[a-z]+(?:_[a-z0-9]+)+\b/.test(b.replace(/\]\([^)]*\)/g, ']')), (b.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/) || [])[0]);
    chk('V ' + name + ' · ' + fmt + ': the status is stated in plain words', /unexplained|not an edge|explains the difference|not a bet|research question/i.test(b));
  });
});
chk('V Georgia–Alabama is EXPLAINED (mostly how EdgeDesk carries last season)', GA.evidence.explanation.status === 'EXPLAINED');
chk('V Missouri–Texas A&M is EXPLAINED', MZ.evidence.explanation.status === 'EXPLAINED');
chk('V Texas–Oklahoma is only partly explained, and says so', TX.evidence.explanation.status === 'PARTIALLY_EXPLAINED' && /Part of|some of|Only part/.test(body(write(TX, 'matchup_analysis').a)));
chk('V UCLA–Oregon: Moore is listed out and the model prices the absence generically — flagged, with Raiola’s relief game on file',
  UC.evidence.explanation.input_flags.some((f) => f.key === 'QB_REPLACEMENT_GENERIC') && UC.evidence.claims.some((c) => /19 of 25 passes for 289 yards/.test(c.text)) && UC.evidence.explanation.input_suspect);
chk('V the NFL piece uses official injuries and nflverse passing, and calls its line a reference or a capture', NF.evidence.claims.some((c) => c.topic === 'qb' && /passers have completed/.test(c.text)) && NF.evidence.claims.some((c) => c.key === 'market'));
chk('V NFL penalties are measured where the data exists', NF.evidence.claims.some((c) => /^penalties:/.test(c.key)) && (NF.evidence.coverage.find((c) => c.item === 'penalties') || {}).status === 'AVAILABLE');

/* ── F formats ────────────────────────────────────────────────────────── */
section('F formats');
const FP = write(OM, 'edgedesk_analysis'), FPB = body(FP.a);
chk('F the first-party piece passes and carries the model detail', FP.rep.ok && FP.a.sections.some((s) => s.key === 'model_detail') && /How EdgeDesk’s number is built/.test(FPB));
chk('F … with a link to the full game research and the methodology', /edgedesksports\.com\/methodology\//.test(FPB));
chk('F the two pieces are different articles (shingle overlap under 45%)', CE.similarity(OMB, FPB) < 0.45, CE.similarity(OMB, FPB));
chk('F EdgeDesk’s own format is never queued for a publisher (it lives in the first-party pipeline)', (() => {
  const live = CE.discover(CE.research.fromArtifacts(require(path.join(__dirname, 'artifacts.js')).load({ now: NOW }), { now: NOW }), { now: NOW, publisher: SR });
  return live.length > 0 && live.every((o) => o.formats.indexOf('edgedesk_analysis') < 0);
})());
chk('F different headlines and section headings', FP.a.title !== OMP.a.title || FP.a.sections.find((s) => s.key === 'thesis').heading !== OMP.a.sections.find((s) => s.key === 'thesis').heading);
chk('F the publisher piece has no software jargon', passed(OMP.rep, 'no_software_jargon'));

/* ── C cost ───────────────────────────────────────────────────────────── */
section('C cost');
const EVB = require(path.join(__dirname, 'evidence.js'));
chk('C a packet is built once per matchup and reused within a run', (() => { EVB.build({ now: NOW, gameIds: ['401856718'], previous: null }); const b1 = EVB.stats().builds; EVB.build({ now: NOW, gameIds: ['401856718'], previous: null }); return EVB.stats().builds === b1; })());
chk('C an unchanged packet keeps its build time across runs (no churn)', (() => { const s1 = EVB.build({ now: NOW, gameIds: ['401856718'], previous: null }); const p1 = s1.cfb.packets['401856718']; if (!p1) return true; const s2 = EVB.build({ now: NOW + 3600000, gameIds: ['401856718'], previous: s1 }); const p2 = s2.cfb.packets['401856718']; return p2.built_at === p1.built_at || p2.inputs_hash !== p1.inputs_hash; })());
chk('C the same inputs give the same packet minutes later (no clock in the packet, no churn in the committed file)', (() => {
  const strip = (s) => JSON.stringify(Object.values(s.cfb.packets).map((p) => Object.assign({}, p, { built_at: null })));
  return strip(EVB.build({ now: NOW, gameIds: ['401856718'], previous: null })) === strip(EVB.build({ now: NOW + 5 * 60000, gameIds: ['401856718'], previous: null }));
})());
chk('C the slate and the single-game piece read the same packet', (() => { const t = newOpp.research.games.find((p) => p.game_id === '401856718').evidence; return t.hash === OM.evidence.hash && t.trimmed; })());
chk('C no outside source is queried: the builder reads committed files only', !/fetch\(|https?\.get|XMLHttpRequest/.test(fs.readFileSync(path.join(ROOT, 'lib', 'football_evidence.js'), 'utf8')) && !/fetch\(/.test(fs.readFileSync(path.join(__dirname, 'evidence.js'), 'utf8')));
chk('C facts already on file and current are reused, not researched again', FE.researchPlan(EV).missing.every((m) => m.item !== 'qb_availability' && m.item !== 'injuries'));
chk('C at most two AI calls per draft', CE.ai.MAX_ATTEMPTS === 2);
chk('C the AI request carries the football packet, trimmed for a slate', (() => { const r = CE.ai.buildRequest(newOpp, { publisher: SR, format: 'cfb_weekly_preview', current: newArt }); const j = JSON.parse(r.messages[0].content.split('RESEARCH PACKET (the only facts you may use):\n')[1].split('\n\nCURRENT DRAFT:')[0]); return j.games.every((g) => g.football && g.football.claims.length && !g.evidence) && /FOOTBALL EVIDENCE/.test(r.system); })());
chk('C a retry that failed in one game’s capsule rewrites only that section', (() => { const bad = edit(newArt, 'games', (b) => b.replace(/\*\*Why it could be closer than the line says:\*\*[^\n]*/, '').replace(/\*\*Why Ole Miss could win comfortably:\*\*[^\n]*/, '').replace(/\*\*Quarterbacks:\*\*[^\n]*(?=\n\n\*\*What EdgeDesk can’t explain)/, '**Quarterbacks:** none.')); const r = revalidate(newOpp, bad); const hit = CE.ai.affectedSections(r, bad, newOpp); return !r.ok && Array.isArray(hit) && hit.length === 1 && hit[0] === 'games'; })());

/* ── W first-party pages ──────────────────────────────────────────────── */
section('W first-party');
const recFile = path.join(ROOT, 'articles', 'data', 'records', 'cfb-401856718.json');
if (fs.existsSync(recFile)) {
  const M = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
  const EVA = require(path.join(ROOT, 'tools', 'articles', 'evidence_attach.js'));
  const PUB = require(path.join(ROOT, 'tools', 'editorial', 'publisher.js'));
  const Q = require(path.join(ROOT, 'tools', 'editorial', 'quality.js'));
  const R = require(path.join(ROOT, 'tools', 'articles', 'article_render.js'));
  const set = { cfb: { packets: { '401856718': OM.evidence } } };
  let rec = M.hydrate(JSON.parse(fs.readFileSync(recFile, 'utf8')));
  rec = EVA.attach(Object.assign({}, rec, { snapshot_id: rec.snapshot_id || 'snap_test' }), FIX.frozen_at, { set });
  const sec = rec.article.sections.find((s) => s.kind === 'football_evidence');
  chk('W the game page gets “The football behind the number”', sec && sec.title === 'The football behind the number' && sec.quarterbacks.length >= 3 && sec.contradicting.items.length >= 2);
  chk('W … and carries no build time, only the packet hash (no churn)', rec.football_evidence.packet_hash === OM.evidence.hash && !('built_at' in rec.football_evidence));
  const q = Q.inspect(rec, { now: FIX.frozen_at });
  chk('W its figures pass the first-party integrity check', !(q.integrity_failed || []).length, q.integrity_failed);
  const pre = PUB.preflight(rec, { now: FIX.frozen_at, quality: q, requireEvidence: true, others: [] });
  chk('W automatic publishing is HELD: suspect inputs and unconfirmed reporting', !pre.ok && pre.blocking.some((b) => b.id === 'evidence_inputs_suspect') && pre.blocking.some((b) => b.id === 'evidence_unconfirmed'));
  const pub = PUB.publish(rec, { now: FIX.frozen_at, quality: q, requireEvidence: true, others: [] });
  chk('W … the record goes to manual review with the reasons on it', pub.action === 'held' && pub.record.status === 'manual_review' && /evidence_inputs_suspect/.test(pub.record.publish_state.hold_reason));
  const noEvRec = Object.assign({}, rec, { football_evidence: null });
  chk('W a page with no evidence packet is not auto-published', PUB.preflight(noEvRec, { now: FIX.frozen_at, quality: q, requireEvidence: true, others: [] }).blocking.some((b) => b.id === 'football_evidence'));
  const html = R.articlePage(rec, { now: FIX.frozen_at });
  chk('W the rendered page shows the evidence, its status and its sources', /class="a-sec a-fev"/.test(html) && /Research status: UNEXPLAINED/.test(html) && /The quarterbacks/.test(html) && /Sources/.test(html));
} else chk('W (no first-party record for the game in this checkout)', true);

/* ── L live ───────────────────────────────────────────────────────────── */
section('L live');
/* "today": the research pinned on a pull request, or today's with --live (above) */
const art = TODAY;
/* the hourly matchup packets move with the week, and Five Games to Watch is
   tested from its frozen fixture in games_to_watch.test.js (as in content.test.js) */
art.packets = null;
chk('L ' + WHOSE + ' evidence set builds from committed files', art.evidence && art.evidence.counts && art.evidence.counts.cfb + art.evidence.counts.nfl > 0, art.evidence && art.evidence.counts);
const snap = CE.research.fromArtifacts(art, { now: LNOW });
chk('L a packet built from different numbers than the research is refused, so the gate fails closed', (() => {
  const g0 = snap.cfb.games.find((p) => p.evidence && p.evidence.model && typeof p.evidence.model.home_line === 'number');
  if (!g0) return true;
  const set = JSON.parse(JSON.stringify(art.evidence)); set.cfb.packets[String(g0.game_id)].model.home_line += 3;
  const g = CE.research.fromArtifacts(Object.assign({}, art, { evidence: set }), { now: LNOW }).cfb.games.find((p) => p.game_id === g0.game_id);
  return g.evidence === null && /different numbers/.test(g.evidence_stale);
})());
const opps = CE.discover(snap, { now: LNOW, publisher: SR });
const live = [];
opps.forEach((o) => o.formats.filter((f) => f !== 'publisher_custom').forEach((f) => {
  const pub = f === 'edgedesk_analysis' ? null : SR;
  const a = CE.draft(o, { publisher: pub, format: f, now: LNOW });
  const r = CE.validate(a, o, { publisher: pub, now: LNOW, teamLists: ART.teamLists(art) });
  live.push({ key: o.key + '/' + f, ok: r.ok, failed: r.failed, readiness: r.readiness });
}));
const liveBad = live.filter((x) => !x.ok);
console.log('  ' + live.length + ' articles drafted, ' + liveBad.length + ' blocked');
chk('L every article generated from ' + WHOSE + ' research passes the gate', live.length > 0 && liveBad.length === 0, liveBad.slice(0, 5));
/* the pin is not vacuous: it still drafts the two articles main's own code
   BLOCKED there, so a regression of either repair is red here */
if (!LIVE) chk('L the pinned research drafts the two Week 9 articles the gate blocked on 2026-10-29 (the upset-watch preview; Utah–Cincinnati)',
  ['cfb:2026:w9:upset_watch/cfb_weekly_preview', 'cfb:2026:w9:market_discrepancy:401856848/matchup_analysis'].every((k) => live.some((x) => x.key === k)), live.map((x) => x.key));
chk('L every packet’s explanation has a legal status and is never actionable', [].concat(Object.values((art.evidence.cfb || {}).packets || {}), Object.values((art.evidence.nfl || {}).packets || {}))
  .every((p) => ['EXPLAINED', 'PARTIALLY_EXPLAINED', 'UNEXPLAINED', 'NO_MATERIAL_DISAGREEMENT', 'NO_COMPARABLE_MARKET', 'NO_PROJECTION'].includes(p.explanation.status) && p.explanation.actionable === false));
/* the ledger the evidence was built from: the pinned copy, or today's file
   (content-engine.yml's next step, tools/content/add_fact.js --check, holds
   today's file at the real clock) */
chk('L the facts ledger validates', (() => { const j = LIVE ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'evidence', 'facts.json'), 'utf8')) : PIN.files['football/evidence/facts.json']; return j.facts.every((f) => FE.validateFact(f, LNOW).ok); })());

console.log('');
failures.forEach((f) => console.log('  × ' + f));
console.log((fail ? 'FAIL' : 'PASS') + ' | football evidence pipeline | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

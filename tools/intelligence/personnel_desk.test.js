#!/usr/bin/env node
/* ===========================================================================
   NON-QB PERSONNEL AVAILABILITY ON THE AI DESK.

   1. The kernel (football/personnel/desk.js): the six questions the desk must
      answer naturally, the player and slot a question names, answers that
      explain the drivers with the published numbers and always say that no
      point-spread adjustment is applied, and the critic check that fails an
      injury turned into points.
   2. The handler (supabase/functions/edgedesk_ai/index.ts), with the network
      stubbed by the intelligence fixture router: a desk client gets the
      deterministic personnel answer; a quarterback question, a betting
      question and a question about no game fall through; the research
      packet carries the personnel block; prose that prices an injury is
      rejected.

   Run: node tools/intelligence/personnel_desk.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CORE = require(path.join(ROOT, 'football', 'personnel', 'impact.js'));
const D = require(path.join(ROOT, 'football', 'personnel', 'desk.js'));
const FX = require('./fixtures.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}

/* ------------------------------------------------------------- fixture */
const OFFICIAL = { name: 'Sun Belt availability report', type: 'OFFICIAL', tier: 1, freshness: 'CURRENT' };
function q(v) { return { value: v, basis: 'MEASURED_PRODUCTION', confidence: 0.85, scale: 'EPIR' }; }
function u(v) { return { value: v, basis: 'SNAP_SHARE' }; }
function side(name, absences, o) {
  o = o || {};
  return { team_id: o.id || name.toLowerCase().replace(/\W+/g, ''), team_name: name,
    coverage: { grade: 'OFFICIAL', graded: true, official: true, comprehensive: true },
    absences: absences, depth: o.depth || {}, opponent: { team_name: o.opp, metrics: o.metrics || {} } };
}
const txstDepth = { OL: { basis: 'DEPTH_CHART', players: [
  { player_id: 't1', player_name: 'Marcus Tackleton', quality: q(81), usage: u(0.97) },
  { player_id: 't2', player_name: 'Guard Two', quality: q(64), usage: u(0.96) },
  { player_id: 't3', player_name: 'Guard Three', quality: q(62), usage: u(0.95) },
  { player_id: 't4', player_name: 'Center Four', quality: q(63), usage: u(0.95) },
  { player_id: 't5', player_name: 'Tackle Five', quality: q(61), usage: u(0.94) },
  { player_id: 't6', player_name: 'Freddie Freshman', quality: q(47), usage: u(0.05) }] } };
const GAME = CORE.assessGame({ game_id: '401858900', sport: 'cfb', kickoff: new Date(Date.now() + 6 * 86400000).toISOString(),
  home: side('Texas State', [
    { player_id: 't1', player_name: 'Marcus Tackleton', position: 'OL', slot: 'LT', slot_depth: 1, status: 'OUT', source: OFFICIAL },
    { player_id: 'w1', player_name: 'Ray Receiver', position: 'WR', status: 'QUESTIONABLE', source: OFFICIAL, quality: q(60), usage: u(0.45),
      replacement: { player_id: 'w9', player_name: 'Slot Sub', quality: q(55), usage: u(0.2), basis: 'DEPTH_CHART' } },
    { player_id: 'q1', player_name: 'Brad Jackson', position: 'QB', status: 'QUESTIONABLE', source: OFFICIAL }],
    { depth: txstDepth, opp: 'North Texas', metrics: { def_sack_rate: { z: 1.6, label: 'pass rush (sack rate generated)' } } }),
  away: side('North Texas', [
    { player_id: 'n1', player_name: 'Corey Cornerback', position: 'CB', status: 'OUT', source: OFFICIAL, quality: q(58), usage: u(0.8),
      replacement: { player_id: 'n2', player_name: 'Backup Corner', quality: q(54), usage: u(0.3), basis: 'DEPTH_CHART' } },
    { player_id: 'n3', player_name: 'Larry Linebacker', position: 'LB', status: 'OUT', source: OFFICIAL, quality: { value: 52, basis: 'NO_MEASURED_PRODUCTION', scale: 'EPIR' } }],
    { opp: 'Texas State' })
});
const ARTIFACT = { schema: 'edgedesk_personnel_impact_v1', version: 1, config_version: CORE.version, generated_at: new Date().toISOString(),
  projection: { adjustment_points: 0, status: 'NOT_ENABLED', statement: 'Measurement only — coefficient not trained' },
  games: { '401858900': GAME } };

/* ==================================================== 1. the kernel */
const Q = {
  matter: 'How much does this injury matter?',
  which: 'Which team is more affected by injuries?',
  lt: 'How important is the missing left tackle?',
  defense: 'Does this defense have meaningful personnel losses?',
  replace: 'Who replaces this player?',
  unit: 'Are the injuries concentrated in one unit?'
};
ok('the six desk questions classify', D.classify(Q.matter) === 'IMPACT' && D.classify(Q.which) === 'COMPARE'
  && D.classify(Q.lt) === 'IMPACT' && D.classify(Q.defense) === 'UNIT' && D.classify(Q.replace) === 'REPLACEMENT'
  && D.classify(Q.unit) === 'UNIT', Object.keys(Q).map((k) => D.classify(Q[k])));
ok('a quarterback question is left to the QB layer', D.classify('How much does it matter if their quarterback is out?') === null);
ok('a betting question is left to the desk', D.classify('Is Texas State -3 worth betting with the injuries?') === null);
ok('a non-personnel question is not claimed', D.classify('What is the weather in San Marcos?') === null);
ok('"what are the injuries" / "who is out" is a summary; an impact question is not',
  D.classify('What are the injuries for Texas State?') === 'SUMMARY' && D.classify('Who is out for North Texas?') === 'SUMMARY'
  && D.classify('What is the impact of the injuries?') === 'IMPACT');
const sum = D.answer('What are the injuries for Texas State?', GAME);
ok('the summary lists the named side’s absences with their class, largest first, and no quarterback',
  /^Texas State: \d+\/100/.test(sum.text) && sum.text.indexOf('LT1 Marcus Tackleton (out, ') > 0
  && sum.text.indexOf('Marcus Tackleton') < sum.text.indexOf('Ray Receiver') && !/Brad Jackson/.test(sum.text)
  && /0\.0 points/.test(sum.text), sum.text);

const lt = D.answer(Q.lt, GAME);
ok('"the missing left tackle" finds the LT', lt.focus && lt.focus.player_name === 'Marcus Tackleton', lt);
ok('the LT answer explains the drivers: the drop to the replacement and the pass rush',
  /grades as (High|Severe|Moderate) impact \(\d+\/100\)/.test(lt.text) && /drop from his 81 rating to Freddie Freshman’s 47/.test(lt.text)
  && /North Texas’ pass rush/.test(lt.text), lt.text);
ok('the LT answer states its score and confidence', new RegExp('scores it ' + lt.focus.impact_if_absent + '/100 with ' + lt.focus.confidence + '% confidence').test(lt.text), lt.text);
ok('every answer says no point-spread adjustment is applied', Object.keys(Q).every((k) => {
  const a = D.answer(Q[k], GAME); return a && /not applying a point-spread adjustment/.test(a.text) && /0\.0 points/.test(a.text);
}));
ok('"this injury" with no name is the largest expected impact', D.answer(Q.matter, GAME).focus.player_name === 'Marcus Tackleton');
const which = D.answer(Q.which, GAME);
ok('"which team is more affected" names the side with materially greater exposure',
  /Texas State has materially greater personnel-loss exposure/.test(which.text) && /not points/.test(which.text), which.text);
const rep = D.answer('Who replaces Marcus Tackleton?', GAME);
ok('"who replaces" names the replacement with his rating and the identification basis',
  /likely replacement for LT1 Marcus Tackleton \(Texas State\) is Freddie Freshman, rated 47 against his 81/.test(rep.text), rep.text);
const unit = D.answer(Q.unit, GAME);
ok('"concentrated in one unit" reads the units', /Offensive line|Receivers|Secondary/.test(unit.text), unit.text);
const def = D.answer('Does the North Texas defense have meaningful personnel losses?', GAME);
ok('"does this defense have meaningful losses" reads only the named side’s defensive units',
  /^North Texas: /.test(def.text) && /Secondary/.test(def.text) && !/Offensive line/.test(def.text) && !/^Texas State/.test(def.text), def.text);
const unrated = D.answer('How important is the missing linebacker for North Texas?', GAME);
ok('an unrated absence says what is missing and quotes no score', /cannot rate/.test(unrated.text) && /no measured player quality/.test(unrated.text)
  && !/\/100/.test(unrated.text.replace(/0\.0 points/, '')), unrated.text);
ok('the quarterback is never the answer', !Object.keys(Q).some((k) => /Brad Jackson/.test(D.answer(Q[k], GAME).text)));
ok('every answer carries projection_adjustment 0', Object.keys(Q).every((k) => D.answer(Q[k], GAME).projection_adjustment === 0));
ok('resolveGame: a carried game id wins', D.resolveGame(ARTIFACT, { question: Q.matter, game_id: '401858900' }) === GAME);
ok('resolveGame: a named team finds its game', D.resolveGame(ARTIFACT, { question: 'Which team is more affected by injuries, Texas State or North Texas?' }) === GAME);
ok('resolveGame: no game named and none carried is no answer', D.resolveGame(ARTIFACT, { question: Q.matter }) === null);
const blk = D.block(GAME, { question: Q.lt });
ok('the packet block is measurement-only, zero-adjustment, and carries the deterministic answer',
  blk.measurement_only === true && blk.projection_adjustment === 0 && blk.answer === lt.text && blk.home.absences.length >= 1
  && blk.rules.some((r) => /never convert it into spread points/.test(r)));
const C = (s) => D.criticExtras({ answer: s }).map((f) => f.code);
ok('critic: an injury turned into points fails', C('Without the left tackle Texas State is worth 2.5 points less.').indexOf('INJURY_POINTS_CLAIM') >= 0);
ok('critic: "adjusted the line for the injury" fails', C('EdgeDesk adjusted the spread for the injury to Tackleton.').indexOf('INJURY_ADJUSTMENT_CLAIM') >= 0);
ok('critic: the priced quarterback is not caught', C('The quarterback injury is worth 3.9 points in the trained layer.').length === 0);
ok('critic: the correct sentence passes', C(lt.text).length === 0 && C('The LT absence is 76/100; the projection effect is 0.0 points.').length === 0);

/* ==================================================== 2. the handler */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let route = () => [];
let modelText = 'ok';
globalThis.fetch = async function (url, init) {
  const s = String(url);
  if (s.indexOf('api.anthropic.com') >= 0) {
    const t = typeof modelText === 'function' ? modelText(JSON.parse(init.body)) : modelText;
    return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }), text: async () => t };
  }
  if (init && init.method === 'POST' && s.indexOf('sb.test') >= 0) return { ok: true, status: 201, text: async () => '', json: async () => [] };
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(s, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const NOW = Date.now();
  const fx = FX.build(NOW);
  async function ask(question, opts) {
    opts = opts || {};
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    route = FX.router(fx, Object.assign({ signals: [fx.signal()] }, { personnel: opts.personnel === undefined ? ARTIFACT : opts.personnel }));
    modelText = opts.answer === undefined ? 'ok' : opts.answer;
    const body = { mode: 'chat', question, packet: null, history: [], research_context: opts.carried || null };
    if (opts.desk !== false) body.desk = true;
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', {
      method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, j: await r.json() };
  }
  const carried = { sport: 'americanfootball_ncaaf', game_id: '401858900', home: 'Texas State', away: 'North Texas', turns: 1 };

  const h1 = await ask(Q.lt, { carried });
  ok('host: a desk client gets the personnel answer for the carried game', h1.status === 200 && h1.j.desk && h1.j.desk.intent === 'PERSONNEL'
    && h1.j.answer === lt.text && h1.j.personnel && h1.j.personnel.projection_adjustment === 0, h1.j.answer || h1.j.error);
  ok('host: it renders as a desk answer and carries the game forward', h1.j.desk.schema === 'edgedesk_desk_answer_v1'
    && h1.j.research.research_context.game_id === '401858900');
  const h2 = await ask('Which team is more affected by injuries, Texas State or North Texas?');
  ok('host: a named matchup resolves with no carried context', h2.j.desk && h2.j.desk.intent === 'PERSONNEL' && /materially greater/.test(h2.j.answer), h2.j.answer);
  const h3 = await ask(Q.replace, { carried: Object.assign({}, carried) });
  ok('host: "who replaces this player?" follows the carried game', /likely replacement/.test(h3.j.answer || ''), h3.j.answer);
  const h4 = await ask('How much does it matter if their quarterback is out?', { carried });
  ok('host: a quarterback question falls through', !(h4.j.desk && h4.j.desk.intent === 'PERSONNEL'));
  const h5 = await ask(Q.matter);
  ok('host: no game named and none carried falls through', !(h5.j.desk && h5.j.desk.intent === 'PERSONNEL'));
  const h6 = await ask(Q.lt, { carried, personnel: null });
  ok('host: no artifact, no personnel answer', !(h6.j.desk && h6.j.desk.intent === 'PERSONNEL'));
  const h7 = await ask(Q.lt, { carried, desk: false });
  ok('host: without desk:true the personnel turn does not run', !(h7.j.desk && h7.j.desk.intent === 'PERSONNEL'));

  /* the full pipeline: the packet carries the block; prose pricing an injury fails */
  const priced = await ask('Tell me about the Texas State and North Texas game injuries in depth', { desk: false, carried,
    answer: 'Without Marcus Tackleton, Texas State is worth 3 points less, so EdgeDesk moved the line.' });
  const S = priced.j.structured || priced.j.research_response || null;
  const findings = (S && S.critic && S.critic.findings) || (priced.j.critic && priced.j.critic.findings) || [];
  const packet = priced.j.research_packet || (priced.j.research && priced.j.research.research_packet);
  ok('pipeline: the research packet carries the personnel block', !!(packet && packet.personnel && packet.personnel.projection_adjustment === 0
    && packet.personnel.home && packet.personnel.home.team === 'Texas State'), packet ? Object.keys(packet) : Object.keys(priced.j));
  ok('pipeline: prose that turns an injury into points is rejected', findings.some((f) => f.code === 'INJURY_POINTS_CLAIM')
    && priced.j.answer !== 'Without Marcus Tackleton, Texas State is worth 3 points less, so EdgeDesk moved the line.', { findings, answer: priced.j.answer });

  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

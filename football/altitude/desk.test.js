#!/usr/bin/env node
/* ============================================================================
   ALTITUDE & TRAVEL IN ASK EDGEDESK — the real edge-function host
   (supabase/functions/edgedesk_ai/index.ts, Node strips the TypeScript) and
   the CFB explanation fact boundary (_cfb_explain.js), on the Notre Dame at
   BYU slate row the module builds.

   What must hold:
     1  the FBS slate normaliser carries the section verbatim, and refuses an
        object that is not the section;
     2  the desk's research packet gets travel and altitude as SOURCED facts
        (miles, zones, elevations, the climb, the verdict, 0.0 pts applied) —
        and never the shadow number, which is unvalidated and therefore not
        something the desk may be asked to sell;
     3  an explanation may name altitude only when the facts carry the
        section, may cite only the section's numbers, and may not promise.

   Run: node football/altitude/desk.test.js
   ========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key',
  EDGEDESK_SITE_BASE: 'https://site.test', CRON_SECRET: 'cron-test', EDGEDESK_RESEARCH_LOG: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
global.window = global.window || global;

const A = require('./engine.js');
const PARAMS = require('./params.js');
const REG = require('./venues.json');
const FIX = require('./fixtures/byu_notredame.json');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const X = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }

const rows = FIX.games.filter((r) => r.season === 2026 || r.season === 2025);
const g = FIX.games.find((r) => String(r.game_id) === '401856809');
const ctx = A.context(g, { registry: REG, normKey: FBS.normKey, index: A.teamIndex(rows, FBS.normKey) });
const adj = A.adjustment(ctx, PARAMS, { flag_enabled: false });
const section = Object.assign(A.publish(ctx, adj, PARAMS), { engine_contribution: { points: 0, available: false, reason: adj.reason } });
const slateRow = { game_id: '401856809', season: 2026, week: 7, kickoff: '2026-10-17T23:30:00.000Z', home_team: 'BYU', away_team: 'Notre Dame',
  home_team_id: 'byu', away_team_id: 'notredame', neutral_site: false, venue: 'LaVell Edwards Stadium', model_status: 'PREDICTED',
  model_home_margin: -3.2, model_home_line: 3.2, model_fair_total: 49.9, model_home_win_prob: 0.42, altitude_travel: section };

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));

  /* 1 */
  const norm = m.normalizeFbsArtifactGame(slateRow, { season: 2026 });
  ok('the slate normaliser carries the section verbatim', norm.altitude_travel === section);
  ok('it refuses an object that is not the section', m.normalizeFbsArtifactGame(Object.assign({}, slateRow, { altitude_travel: { schema: 'x', shadow_points: 9 } }), {}).altitude_travel === null);

  /* 2 */
  const sit = m.altitudeSituation(norm);
  ok('travel is a sourced fact', sit.travel && sit.travel.missing === false && /football\/altitude/.test(sit.travel.source));
  ok('travel: about 1,325 miles, two zones west, 0 points', sit.travel && Math.abs(sit.travel.value.miles - 1325) <= 2 && sit.travel.value.tz_change_h === -2
    && /1,325 miles, 2 time zones west/.test(sit.travel.value.text) && /travel moves 0 points/.test(sit.travel.value.text), sit.travel && sit.travel.value);
  const alt = sit.altitude && sit.altitude.value;
  ok('altitude: the venue, its 4,633 ft, Notre Dame’s 731 ft and the 3,902 ft climb', alt && alt.game_elevation_ft === 4633 && alt.normal_elevation_ft === 731 && alt.elevation_gain_ft === 3902 && alt.team === 'Notre Dame', alt);
  ok('altitude: the record’s verdict and 0.0 points applied', alt && alt.support_state === PARAMS.validation.support_state && alt.points_applied === 0 && /research only, 0\.0 pts applied/.test(alt.text), alt);
  const blob = JSON.stringify(sit);
  ok('the shadow number never reaches the desk', !/shadow/i.test(blob) && blob.indexOf(String(section.adjustment.shadow_points)) < 0, blob.slice(0, 300));
  ok('a row without the section adds nothing', Object.keys(m.altitudeSituation({ game_id: '1' })).length === 0);
  const missingSec = Object.assign({}, section, { venue: null, missing: ['venue 999 has no sourced elevation'] });
  const sitMissing = m.altitudeSituation({ altitude_travel: missingSec });
  ok('an unavailable elevation is a stated absence, never a number', sitMissing.altitude && sitMissing.altitude.missing === true && /no sourced elevation/.test(sitMissing.altitude.reason), sitMissing);

  /* the research packet the desk answers from */
  const R = globalThis.EDRESEARCH;
  ok('the research kernel is loaded', !!(R && R.buildResearchPacket));
  if (R && R.buildResearchPacket) {
    let pkt = null, err = null;
    try {
      pkt = R.buildResearchPacket({ sport: 'americanfootball_ncaaf', now: Date.parse('2026-10-17T16:00:00Z'),
        context: { sport: 'americanfootball_ncaaf', game_id: '401856809', home: 'BYU', away: 'Notre Dame', kickoff: slateRow.kickoff, venue: slateRow.venue, neutral_site: false },
        model: { home_line: 3.2, home_margin: -3.2, total: 49.9, home_win_prob: 0.42, status: 'PREDICTED', version: 'edgedesk_cfb_p4_v1.0.0' },
        situation: Object.assign({ home_rest_days: 8, away_rest_days: 7 }, sit) });
    } catch (e) { err = e; }
    ok('a packet builds with the altitude situation', !!pkt && !err, err && String(err.message || err).slice(0, 300));
    if (pkt) {
      ok('the packet’s travel is the measured trip, not "not computed"', pkt.situation.travel && !pkt.situation.travel.missing && /1,325 miles/.test(pkt.situation.travel.value.text), pkt.situation.travel);
      ok('the packet’s altitude carries the climb', pkt.situation.altitude && pkt.situation.altitude.value && pkt.situation.altitude.value.elevation_gain_ft === 3902);
    }
  }

  /* 3 */
  const pure = { home: 'BYU', away: 'Notre Dame', projected_margin: -3.2, home_win_prob: 0.42, fair_spread_display: 'Notre Dame -3.2', model_version: 'edgedesk_cfb_p4_v1.0.0' };
  const fWith = X.cfbFacts({ pure, altitude_travel: section });
  const fWithout = X.cfbFacts({ pure });
  ok('the facts allow altitude only when the section is carried', fWith.allowed_metrics.altitude === true && !fWithout.allowed_metrics.altitude);
  const good = 'Notre Dame plays at 4633 ft, 3902 ft above its normal 731 ft home elevation. The altitude adjustment is research only and moves 0 points.';
  const aGood = X.auditExplanation(good, fWith);
  ok('a grounded altitude sentence passes the boundary', !aGood.issues.some((i) => i.code === 'UNSUPPORTED_METRIC' || i.code === 'NUMBER_NOT_IN_FACTS'), aGood.issues);
  ok('the same sentence without the section is refused as unsupported', X.auditExplanation(good, fWithout).issues.some((i) => i.code === 'UNSUPPORTED_METRIC'));
  ok('an invented altitude effect is refused (a number the facts do not carry)', X.auditExplanation('The altitude costs Notre Dame 7 points.', fWith).issues.some((i) => i.code === 'NUMBER_NOT_IN_FACTS'));
  ok('a promise about altitude is refused', X.auditExplanation('The altitude makes BYU a lock.', fWith).issues.some((i) => i.code === 'PROMISE_LANGUAGE'));
  ok('the shadow estimate is not a citable fact', X.auditExplanation('The altitude shadow is ' + section.adjustment.shadow_points + ' points.', fWith).issues.some((i) => i.code === 'NUMBER_NOT_IN_FACTS'));

  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

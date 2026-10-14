#!/usr/bin/env node
/* ===========================================================================
   supabase/portfolio_model_context.sql — WHAT EDGEDESK'S MODEL SAID ABOUT A
   READER'S BET, BEFORE IT WAS PLACED — against a real PostgreSQL, with the
   model record seeded through its own upsert (supabase/model_pnl.sql,
   model_pnl_states.sql, model_pnl_analytics.sql).

   Proves:
     - a football single is matched to the ONE game both its teams name, in
       its league, at its kickoff; EdgeDesk's probability is shown only from a
       record made BEFORE the bet, for the bettor's side (the complement when
       the bet is on the other side) and only at the line the model priced;
     - a record made after the bet is reported as such and never shown;
     - a reconstructed record is labelled RECONSTRUCTED;
     - "Texas" never matches "Texas Tech Red Raiders"; a parlay, a basketball
       bet and an unreadable event are each told why they were not matched;
     - the implied probability, the difference, the journal close's CLV and
       the realized return are the arithmetic they claim to be;
     - nothing about the position changes, and another reader gets nothing.

   Run: node tools/portfolio/model_context_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const PNL = require(path.join(PG.ROOT, 'lib', 'edgedesk_pnl.js'));

const T = PG.kit('portfolio model context SQL');
const chk = T.chk;
const L = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'portfolio_model_context.sql');
const SRC = fs.readFileSync(FILE, 'utf8');
chk('static: idempotent, additive, no psql meta-command, ends in a report', /create or replace function/.test(SRC) && !/\bdrop (table|column|view)\b/i.test(SRC)
  && !/^\s*\\/m.test(SRC) && /CHECK THIS/.test(SRC) && /order by 1;\s*$/.test(SRC) && /notify pgrst, 'reload schema'/.test(SRC));
chk('static: it reads only EdgeDesk\'s public record and runs as the caller', /from public\.model_pnl_public/.test(SRC) && !/from public\.model_pnl\b(?!_)/.test(SRC)
  && /security invoker/.test(SRC) && !/security definer/.test(SRC));
chk('static: under the SQL editor paste limit (18 KB)', Buffer.byteLength(SRC) <= 18000, Buffer.byteLength(SRC));

const db = PG.start('pmc');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
const one = (s) => String(s).split('\n')[0];
const J = (o) => L(JSON.stringify(o)) + '::jsonb';
/* a model-record row, as tools/record/pnl_core.js writes them */
function rec(o) {
  return PNL.settle(Object.assign({ source: 'model_record', source_ref: { file: 'x', id: 'g' }, sport: 'football', league: 'NFL', season: 2026, week: 3,
    model_version: 'edgedesk_football_v1.1.0', market_group: 'game', prop_market: null, prop_label: null, prop_category: null, player_id: null, player_name: null,
    entry_odds: null, entry_book: null, price_assumed: false, model_edge_pct: null, rec_class: 'MODEL', stake_units: 0, odds_captured_at: null, evaluation_mode: 'LIVE',
    result: 'pending', result_value: null, closing_line: null, clv_points: null, beat_close: null, settled_at: null, corrections: [], corrected: false }, o));
}
const ctx = (uid, id) => JSON.parse(one(db.as(uid, `select public.portfolio_model_context(${L(id)});`)));

try {
  for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'model_pnl.sql', 'model_pnl_states.sql', 'model_pnl_analytics.sql']) db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f));
  let out = db.applyFileAtomic(FILE);
  chk('the file applies, every report row ok', !/CHECK THIS/.test(out), out);
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(FILE)));
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com');`);
  const g1 = { event_id: '2026_03_MIA_KC', event_label: 'MIA @ KC', home: 'Kansas City Chiefs', away: 'Miami Dolphins', game_date: '2026-09-21T17:00:00.000Z' };
  db.service(`select public.model_pnl_upsert(${J([
    rec(Object.assign({ recommendation_id: 'mr:nfl:mia_kc:moneyline', market_type: 'moneyline', side: 'home', team: 'Kansas City Chiefs', selection: 'KC ML', model_prob: 0.7, model_line: null,
      entry_line: null, recommended_at: '2026-09-18T12:00:00.000Z' }, g1)),
    rec(Object.assign({ recommendation_id: 'mr:nfl:mia_kc:spread', market_type: 'spread', side: 'away', team: 'Miami Dolphins', selection: 'MIA +3.5', model_prob: 0.55, model_line: 2.1,
      entry_line: 3.5, recommended_at: '2026-09-18T12:00:00.000Z' }, g1)),
    rec(Object.assign({ recommendation_id: 'mr:nfl:mia_kc:total', market_type: 'total', side: 'under', team: null, selection: 'Under 47.5', model_prob: 0.58, model_line: 45.2,
      entry_line: 47.5, recommended_at: '2026-09-18T12:00:00.000Z', evaluation_mode: 'LIVE_RECONSTRUCTED' }, g1)),
    rec({ recommendation_id: 'mr:cfb:401:moneyline', league: 'CFB', event_id: '401', event_label: 'Ohio State @ Texas', home: 'Texas', away: 'Ohio State', game_date: '2026-09-12T23:30:00.000Z',
      market_type: 'moneyline', side: 'home', team: 'Texas', selection: 'Texas ML', model_prob: 0.52, recommended_at: '2026-09-12T20:00:00.000Z' }),
    rec({ recommendation_id: 'mr:cfb:402:moneyline', league: 'CFB', event_id: '402', event_label: 'Baylor @ Texas', home: 'Texas', away: 'Baylor', game_date: '2026-10-03T23:30:00.000Z',
      market_type: 'moneyline', side: 'home', team: 'Texas', selection: 'Texas ML', model_prob: 0.8, recommended_at: '2026-10-01T20:00:00.000Z' })])});`);
  chk('the model record is seeded through its own upsert', +db.sql(`select count(*) from public.model_pnl_public;`) === 5);

  const pos = (o) => one(db.service(`insert into public.portfolio_positions (user_id, platform, platform_label, platform_type, position_type, sport, league, event_name, event_start_at,
      market_name, selection, side, line, legs, odds_american, stake, status, reported_payout, placed_at, settled_at, source, external_position_id)
    values (${L(A)}, 'draftkings', 'DraftKings', 'SPORTSBOOK', ${L(o.type)}, ${L(o.sport || 'NFL')}, ${L(o.league || 'NFL')}, ${L(o.event || 'Miami Dolphins at Kansas City Chiefs')},
      ${L(o.start === undefined ? '2026-09-21T17:00:00Z' : o.start)}, ${L(o.market || 'Line')}, ${L(o.sel)}, ${L(o.side || null)}, ${o.line == null ? 'null' : o.line},
      ${o.legs ? J(o.legs) : 'null'}, ${o.odds}, ${o.stake || 100}, ${L(o.status || 'OPEN')}, ${o.payout == null ? 'null' : o.payout}, ${L(o.placed || '2026-09-19T15:00:00Z')},
      ${o.status && o.status !== 'OPEN' ? L('2026-09-21T20:30:00Z') : 'null'}, 'SYNC', ${L('sharpsports:SLIP_' + Math.random().toString(36).slice(2, 10))}) returning id;`));
  const p1 = pos({ type: 'MONEYLINE', sel: 'Kansas City Chiefs', side: 'Kansas City Chiefs', odds: -200, status: 'WON', payout: 150 });
  const p2 = pos({ type: 'MONEYLINE', sel: 'Miami Dolphins', side: 'Miami Dolphins', odds: 170 });
  const p3 = pos({ type: 'SPREAD', sel: 'Miami Dolphins +3.5', side: 'Miami Dolphins', line: 3.5, odds: -110 });
  const p4 = pos({ type: 'SPREAD', sel: 'Miami Dolphins +4.5', side: 'Miami Dolphins', line: 4.5, odds: -120 });
  const p5 = pos({ type: 'TOTAL', sel: 'Over 47.5', side: 'Over', line: 47.5, odds: -105 });
  const p6 = pos({ type: 'MONEYLINE', sport: 'CFB', league: 'NCAAF', event: 'Ohio State Buckeyes at Texas Longhorns', start: '2026-09-12T23:30:00Z', sel: 'Texas Longhorns', side: 'Texas Longhorns',
    odds: -115, placed: '2026-09-12T18:00:00Z' });
  const p7 = pos({ type: 'MONEYLINE', sport: 'CFB', league: 'NCAAF', event: 'Baylor Bears at Texas Tech Red Raiders', start: '2026-10-03T23:30:00Z', sel: 'Texas Tech Red Raiders', side: 'Texas Tech Red Raiders',
    odds: -150, placed: '2026-10-02T18:00:00Z' });
  const p8 = pos({ type: 'PARLAY', sel: 'Chiefs + Over', odds: 264, legs: [{ selection: 'Chiefs' }, { selection: 'Over 47.5' }] });
  const p9 = pos({ type: 'MONEYLINE', sport: 'NBA', league: 'NBA', event: 'Lakers at Celtics', sel: 'Lakers', side: 'Lakers', odds: 120 });
  const p10 = pos({ type: 'MONEYLINE', sport: 'CFB', league: 'NCAAF', event: 'Baylor Bears at Texas Longhorns', start: '2026-10-03T23:30:00Z', sel: 'Texas Longhorns', side: 'Texas Longhorns',
    odds: -400, placed: '2026-10-02T18:00:00Z' });
  const before = db.sql(`select string_agg(id || ':' || updated_at, ',' order by id) from public.portfolio_positions;`);

  let c = ctx(A, p1);
  chk('matched: the one game, EdgeDesk\'s 70% for the Chiefs recorded 27 h before the bet, against the 66.67% the −200 price implies (+3.33 points)',
    c.matched === true && c.model.record_id === 'mr:nfl:mia_kc:moneyline' && +c.edgedesk_probability === 0.7 && c.probability_basis === 'THE_MODELS_SIDE'
      && +c.market_implied_probability === 0.666667 && +c.model_market_difference === 0.033333 && c.model.evidence === 'LIVE' && c.model.recorded_before_bet_by_seconds === 97200, c);
  chk('…with the outcome and the realized return of the bet itself, kept apart from the model', c.outcome === 'WIN' && +c.profit_loss === 50 && +c.realized_return === 0.5, c);
  c = ctx(A, p2);
  chk('the other side of a two-way market: the complement (30%), said to be the complement', c.matched && +c.edgedesk_probability === 0.3 && c.probability_basis === 'COMPLEMENT_OF_THE_MODELS_SIDE'
    && +c.market_implied_probability === 0.37037, c);
  c = ctx(A, p3);
  chk('a spread at the line the model priced (+3.5): its probability, and the fair line', c.matched && +c.edgedesk_probability === 0.55 && +c.model.fair_line === 2.1 && +c.model.priced_line === 3.5, c);
  c = ctx(A, p4);
  chk('a spread at ANOTHER line (+4.5): the fair line only — no probability is moved to a number the model did not price', c.matched && c.edgedesk_probability === null
    && c.model_market_difference === null && +c.model.fair_line === 2.1, c);
  c = ctx(A, p5);
  chk('a total from a reconstructed record: labelled RECONSTRUCTED; Over against the model\'s Under is the complement', c.matched && c.model.evidence === 'RECONSTRUCTED'
    && +c.edgedesk_probability === 0.42 && c.probability_basis === 'COMPLEMENT_OF_THE_MODELS_SIDE', c);
  c = ctx(A, p6);
  chk('a bet placed BEFORE the model\'s record of its game: MODEL_AFTER_PLACEMENT, and no model figure at all', c.matched === false && c.reason === 'MODEL_AFTER_PLACEMENT'
    && c.model === undefined && c.edgedesk_probability === undefined, c);
  c = ctx(A, p7);
  chk('"Texas Tech Red Raiders" is never taken for the model\'s "Texas"', c.matched === false && c.reason === 'NO_MODEL_RECORD_FOR_THIS_GAME', c);
  c = ctx(A, p10);
  chk('…while "Texas Longhorns" is (school name and one-word mascot), 80% recorded the day before', c.matched === true && +c.edgedesk_probability === 0.8, c);
  chk('a parlay is not matched (not a single game line)', ctx(A, p8).reason === 'NOT_A_SINGLE_GAME_LINE');
  chk('a basketball bet is not matched (the model record is football)', ctx(A, p9).reason === 'NOT_IN_THE_MODEL_RECORD');
  /* CLV from the reader's own recorded close */
  db.as(A, `update public.portfolio_journal_entries set closing_odds_american = -125, closing_odds_decimal = 1.8 where position_id = ${L(p3)};`);
  c = ctx(A, p3);
  chk('CLV from the reader\'s recorded close: −110 taken (1.909091), 1.80 at the close is +6.06%', c.clv && c.clv.source === 'JOURNAL_CLOSE' && +c.clv.pct === 0.060606, c.clv);
  chk('nothing about any position changed', db.sql(`select string_agg(id || ':' || updated_at, ',' order by id) from public.portfolio_positions;`) === before
    && +db.sql(`select count(*) from public.portfolio_positions where edge_source is not null or model_probability is not null;`) === 0);
  chk('another reader gets nothing — not even that the position exists', /no such position/.test(db.mustFail(() => db.as(B, `select public.portfolio_model_context(${L(p1)});`)) || ''));
  chk('anon cannot call it', /permission denied/.test(db.mustFail(() => db.anon(`select public.portfolio_model_context(${L(p1)});`)) || ''));
} catch (e) {
  chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());

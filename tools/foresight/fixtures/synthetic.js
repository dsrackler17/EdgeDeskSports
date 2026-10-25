'use strict';
/* ===========================================================================
   A SMALL SYNTHETIC WORLD FOR MARKET FORESIGHT, with answers worked by hand
   in tools/foresight/engine.test.js. TEST FIXTURE ONLY: every id carries the
   SYN_ prefix, every model is syn_*, and the worker refuses to read this
   directory (tools/foresight/sources.js). Nothing here is ever published.

   Times are offsets from each game's kickoff K, in hours (negative = before).
   =========================================================================== */
const H = 3600000;
const K1 = Date.parse('2026-11-01T18:00:00.000Z');
const K2 = Date.parse('2026-11-02T00:00:00.000Z');
const K3 = Date.parse('2026-11-03T01:00:00.000Z');
const at = (K, h) => new Date(K + h * H).toISOString();

function dk(game, K, market, h, f) {
  const r = { schema: 'edgedesk_record_quote_v1', sport: 'NFL', game_id: game, source: 'espn', book: 'draftkings', provider_book: 'DraftKings',
    observed_at: at(K, h), kickoff_ts: new Date(K).toISOString(), is_pregame: true, is_provider_open: false, is_provider_close: false,
    home_team: 'Syn Home', away_team: 'Syn Away', market_type: market, home_line: null, total_points: null,
    price_home: null, price_away: null, price_over: null, price_under: null };
  Object.assign(r, f);
  r.quote_id = 'syn_' + game + '_' + market + '_' + h;
  return r;
}
const sp = (game, K, h, line) => dk(game, K, 'spread', h, { home_line: line, price_home: -110, price_away: -110 });
const tot = (game, K, h, pts) => dk(game, K, 'total', h, { total_points: pts, price_over: -110, price_under: -110 });
const ml = (game, K, h, home, away) => dk(game, K, 'moneyline', h, { price_home: home, price_away: away });

function fc(model, game, K, h, values, extra) {
  return Object.assign({ source: 'edgedesk', model_key: model, model_label: model, model_version: 'v1', forecast_id: model + '@' + game + '@' + h,
    sport: 'nfl', event_id: game, published_at: at(K, h), predicted_at: at(K, h), evidence: 'ledger_captured',
    settles: 'includes overtime (a tie grades by house rule)', values: values }, extra || {});
}
function col(model, game, K, h, values, extra) {
  return Object.assign({ source: 'collective', model_key: model, model_label: model, model_version: 'unversioned', forecast_id: 'p_' + model + '_' + h,
    sport: 'nfl', event_id: game, published_at: at(K, h), evidence: 'server_received', origin: 'live', resolution: 'resolved', values: values }, extra || {});
}
const ev = (id, K, state) => ({ sport: 'nfl', event_id: id, kickoff: new Date(K).toISOString(), home: 'Syn Home', away: 'Syn Away', state: state || 'FINAL' });

/* G1: the spread walks from -3 to -4.5 */
const G1 = {
  event: ev('SYN_G1', K1),
  dk: [sp('SYN_G1', K1, -30, -3.0), sp('SYN_G1', K1, -24, -3.0), sp('SYN_G1', K1, -20, -3.5), sp('SYN_G1', K1, -14, -3.5),
    sp('SYN_G1', K1, -8, -4.0), sp('SYN_G1', K1, -2.5, -4.0), sp('SYN_G1', K1, -1, -4.5), sp('SYN_G1', K1, -0.5, -4.5),
    /* the same reading ingested twice is one observation */
    sp('SYN_G1', K1, -0.5, -4.5)],
  forecasts: [
    fc('syn_a', 'SYN_G1', K1, -22, { spread: -5.0 }),          /* UNRESOLVED: no observation between publication and the move */
    fc('syn_b', 'SYN_G1', K1, -26, { spread: -6.0 }),          /* PRECEDED */
    fc('syn_b', 'SYN_G1', K1, -12, { spread: -4.0 }),          /* a revision: shown, never substituted */
    fc('syn_c', 'SYN_G1', K1, -22, { spread: -4.0 }),          /* overshoot */
    fc('syn_d', 'SYN_G1', K1, -22, { spread: -1.0 }),          /* moved away */
    fc('syn_e', 'SYN_G1', K1, -22, { spread: -3.2 }),          /* no material disagreement */
    fc('syn_f', 'SYN_G1', K1, -40, { spread: -6.0 }),          /* before the first observation: no fresh baseline */
    fc('syn_g', 'SYN_G1', K1, -22, { spread: -6.0 }, { evidence: 'reconstructed_from_git', forecast_id: 'syn_g@old' }),
    fc('syn_g', 'SYN_G1', K1, -21, { spread: -6.5 }),          /* first ELIGIBLE: the reconstructed one before it is skipped by rule */
    fc('syn_h', 'SYN_G1', K1, 0.5, { spread: -6.0 }),          /* after kickoff */
    /* duplicate ingestion of the same record */
    fc('syn_a', 'SYN_G1', K1, -22, { spread: -5.0 }),
    /* Collective, for the as-of consensus */
    col('m1', 'SYN_G1', K1, -50, { spread: -4.0 }), col('m1', 'SYN_G1', K1, -10, { spread: -5.0 }),
    col('m2', 'SYN_G1', K1, -30, { spread: -6.0 }),
    col('m3', 'SYN_G1', K1, -5, { spread: -3.0 }),
    col('m4', 'SYN_G1', K1, -40, { spread: -2.0 }, { withdrawn_at: at(K1, -20) }),
    col('m5', 'SYN_G1', K1, -45, { spread: -9.0 }, { origin: 'backfill' }),
    col('m6', 'SYN_G1', K1, -0.25, { spread: -9.0 })           /* inside the 30-minute lock */
  ],
  kalshi: null
};

/* G2: the total flickers up, moves up, then reverses */
const G2 = {
  event: ev('SYN_G2', K2),
  dk: [tot('SYN_G2', K2, -10, 44.5), tot('SYN_G2', K2, -8, 45.5), tot('SYN_G2', K2, -7, 44.5), tot('SYN_G2', K2, -5, 45.5),
    tot('SYN_G2', K2, -4, 45.5), tot('SYN_G2', K2, -2, 44.5), tot('SYN_G2', K2, -0.6667, 44.5)],
  forecasts: [fc('syn_t', 'SYN_G2', K2, -9, { total: 47.0 })],
  kalshi: null
};

/* G3: a 20-hour outage, then a missing opposing price at the moneyline */
const G3 = {
  event: ev('SYN_G3', K3),
  dk: [sp('SYN_G3', K3, -40, -7.0), sp('SYN_G3', K3, -20, -7.5), sp('SYN_G3', K3, -1, -7.5),
    ml('SYN_G3', K3, -21, -300, null), ml('SYN_G3', K3, -1, -300, 250)],
  forecasts: [
    fc('syn_o1', 'SYN_G3', K3, -30, { spread: -9.0 }),   /* the last observation is 10 h old: stale, not carried */
    fc('syn_o2', 'SYN_G3', K3, -19, { spread: -9.0 }),
    fc('syn_o3', 'SYN_G3', K3, -39, { spread: -9.0 }),   /* its move interval spans the outage */
    fc('syn_ml', 'SYN_G3', K3, -20.5, { moneyline: 0.8 })  /* the baseline has no away price: unpriced */
  ],
  kalshi: null
};

/* G4: postponed */
const G4 = { event: ev('SYN_G4', K1, 'VOID'), dk: [sp('SYN_G4', K1, -5, -1)], forecasts: [fc('syn_a', 'SYN_G4', K1, -4, { spread: -2 })], kalshi: null };

/* G5: the last observation is five hours before kickoff: no valid close */
const G5 = { event: ev('SYN_G5', K1), dk: [sp('SYN_G5', K1, -9, 2.5), sp('SYN_G5', K1, -5, 3.0)], forecasts: [fc('syn_a', 'SYN_G5', K1, -8, { spread: 4.0 })], kalshi: null };

module.exports = { K1, K2, K3, H, at, dk, sp, tot, ml, fc, col, ev, G1, G2, G3, G4, G5, GAMES: [G1, G2, G3, G4, G5] };

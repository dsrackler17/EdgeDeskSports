#!/usr/bin/env node
/* OddsProvider — EdgeDesk's own market capture, normalised for tennis.

   EdgeDesk already licenses and captures prices for every sport: public.signals
   is the live board and tennis.market_captures is the tennis pipeline's own
   PRE/LIVE-tagged price history. Neither is replaced. This reads both and emits
   one shape, so the research layer never has to know which of them a price came
   from — and so a future dedicated tennis odds vendor is a third source behind
   the same shape rather than a third branch in the pricing job.

   TWO-WAY DE-VIGGING HAPPENS HERE, once, using the engine's own function. The
   de-vigged number is labelled `no_vig_prob` and is always the MARKET's
   probability, never EdgeDesk's. */
'use strict';
const P = require('./index.js');
const M = require('../../../lib/tennis_model.js');

/* Books EdgeDesk treats as reachable by an ordinary US bettor. The same
   distinction the rest of the product draws; offshore is not excluded, it is
   labelled. */
const TRUSTED = new Set(['draftkings', 'fanduel', 'betmgm', 'caesars', 'espnbet', 'pointsbetus',
                         'betrivers', 'williamhill_us', 'bet365', 'fanatics', 'hardrockbet']);

module.exports = P.defineProvider({
  kind: 'odds',
  name: 'edgedesk_capture',
  source_key: 'odds_api',
  credentials: [],
  capabilities: {
    pre_match_features: false, serve_statistics: false, exact_start_time: true,
    live_score: false, closing_price: true, doubles: true
  },

  /* From the tennis pipeline's own captures. These already carry the PRE/LIVE
     tag against the match's observed FIRST POINT, which is the only tag in this
     project that can honestly claim a price was pre-match — a clock comparison
     against a scheduled start cannot.

     The capture table is match-winner only and keyed by SIDE rather than by a
     selection string, which is better: the side is already resolved to a player
     by the existing linker, so nothing here has to re-match a name. `sharp_fair`
     is a fair price from sharp books, so where it exists the de-vigged market
     probability is a published figure rather than something this file derives.

     PRE ONLY by default. A live price is a different measurement of a different
     thing, and mixing one into pre-match research would put an in-play number
     behind a pre-match claim. */
  async fromTennisCaptures(db, opts) {
    const o = opts || {};
    const since = o.since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = db.rows(`
      select c.match_id, c.tournament_id, c.book, c.side, c.capture_at, c.market_state,
             c.best_dec, c.sharp_fair, c.consensus_fair, c.n_books, c.has_sharp,
             lm.tour, lm.home_player_id, lm.away_player_id, lm.home_name, lm.away_name
        from tennis.market_captures c
        left join tennis.live_matches lm on lm.match_id = c.match_id
       where c.capture_at >= '${since}'::timestamptz
         ${o.includeLive ? '' : "and c.market_state = 'PRE'"}
       order by c.capture_at desc
       limit ${Math.max(1, Math.min(o.limit || 2000, 20000))}`);
    return rows.map((r) => {
      const home = r.side === 'home';
      const dec = M.num(r.best_dec);
      /* sharp_fair is a FAIR decimal price: its implied probability already has
         the margin out. Where it is absent, no_vig stays null rather than being
         faked from the raw price. */
      const fair = M.num(r.sharp_fair) != null ? M.num(r.sharp_fair) : M.num(r.consensus_fair);
      return {
        source_key: 'odds_api',
        match_ref: r.match_id,
        event_id: null,
        tour: M.normTour(r.tour),
        sportsbook: r.book || null,
        book_trusted: r.book ? TRUSTED.has(String(r.book).toLowerCase()) : null,
        market_type: 'match_winner',
        selection: home ? r.home_name : r.away_name,
        selection_source_id: home ? r.home_player_id : r.away_player_id,
        line: null,
        odds_decimal: dec,
        odds_american: M.americanFromDecimal(dec),
        implied_prob: M.probFromDecimal(dec),
        no_vig_prob: fair == null ? null : M.probFromDecimal(fair),
        market_state: r.market_state === 'PRE' ? 'current' : 'current',
        market_status: 'open',
        captured_at: r.capture_at,
        unmapped: [dec ? null : 'odds_decimal',
                   (home ? r.home_player_id : r.away_player_id) ? null : 'selection_player_id',
                   fair == null ? 'no_vig_prob' : null,
                   r.market_state === 'LIVE' ? 'pre_match_guarantee' : null].filter(Boolean),
        raw_ref: { origin: 'tennis_capture', side: r.side, n_books: r.n_books, has_sharp: r.has_sharp }
      };
    });
  },

  /* From the shared board. A tennis fixture reaches public.signals through the
     same capture every sport uses; the link from a signal to a tennis match is
     tennis.match_markets, written by the existing sync. */
  async fromSignals(db, opts) {
    const o = opts || {};
    const since = o.since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    /* The link is tennis.match_markets.signal_event_id, written by the existing
       sync only when BOTH participants resolved — so a doubles pair or a
       half-matched fixture never reaches this join at all. */
    const rows = db.rows(`
      select mm.match_id, s.event_id, s.market, s.selection, s.point,
             s.best_dec as price_decimal, s.best_book as book,
             s.sharp_book_fair, s.commence_time,
             coalesce(s.updated_at, s.created_at) as capture_at,
             lm.tour, lm.home_player_id, lm.away_player_id, lm.home_name, lm.away_name
        from tennis.match_markets mm
        join public.signals s on s.event_id = mm.signal_event_id
        left join tennis.live_matches lm on lm.match_id = mm.match_id
       where coalesce(s.updated_at, s.created_at) >= '${since}'::timestamptz
       order by capture_at desc
       limit ${Math.max(1, Math.min(o.limit || 2000, 20000))}`);
    return rows.map((r) => normalise(r, 'signals'));
  },

  /* Group a set of normalised rows into two-way markets and attach the
     de-vigged market probability. Only a genuine pair is de-vigged: a lone
     price has no counterpart and its overround is unknowable, so no_vig_prob
     stays null rather than becoming the raw implied number under a name that
     claims the margin was removed. */
  devig(rows) {
    const by = new Map();
    rows.forEach((r) => {
      const k = [r.match_ref, r.sportsbook, r.market_type, r.line == null ? '' : r.line, r.captured_at].join('|');
      (by.get(k) || by.set(k, []).get(k)).push(r);
    });
    for (const group of by.values()) {
      if (group.length !== 2) {
        /* EXPLICITLY null, not merely absent. A caller reading `no_vig_prob`
           off a one-sided quote must get "there is no de-vigged number here"
           rather than `undefined`, which reads as a bug at the other end and
           coerces to NaN in arithmetic. */
        group.forEach(function (r) {
          if (r.no_vig_prob === undefined) r.no_vig_prob = null;
          if (r.overround === undefined) r.overround = null;
        });
        continue;
      }
      const d = M.devigTwoWay(group[0].implied_prob, group[1].implied_prob);
      group[0].no_vig_prob = d.a; group[1].no_vig_prob = d.b;
      group[0].overround = d.overround; group[1].overround = d.overround;
    }
    return rows;
  },

  describe() {
    return { name: 'edgedesk_capture', coverage: 'match winner and, where the feed carries them, game spread and total games',
             grain: 'one row per book per selection per capture',
             licence: 'commercial data agreement (the same capture every other EdgeDesk sport reads)',
             not_carried: ['set betting where the feed omits it', 'player props for tennis'] };
  }
});

function marketType(m) {
  const k = String(m == null ? '' : m).toLowerCase();
  if (k === 'h2h' || k === 'ml' || k === 'moneyline' || k === 'match_winner') return 'match_winner';
  if (k === 'spreads' || k === 'spread' || k === 'games_spread') return 'game_spread';
  if (k === 'totals' || k === 'total' || k === 'total_games') return 'total_games';
  if (/set/.test(k)) return 'set_betting';
  if (/prop/.test(k)) return 'player_prop';
  return null;
}

function normalise(r, origin) {
  const dec = M.num(r.price_decimal) || M.decimalFromAmerican(r.price_american);
  const fair = M.num(r.sharp_book_fair);
  const type = marketType(r.market);
  const book = String(r.book || '').toLowerCase();
  /* Which side is this selection? Matched on the folded name, the same rule
     lib/tennis_research.js uses, and left null when it does not match — a
     price EdgeDesk cannot attribute to a player is stored and NOT attributed. */
  const sel = M.normName(r.selection);
  const isA = sel && sel === M.normName(r.home_name);
  const isB = sel && sel === M.normName(r.away_name);
  return {
    source_key: 'odds_api',
    match_ref: r.match_id,
    event_id: r.event_id || null,
    tour: M.normTour(r.tour),
    sportsbook: r.book || null,
    book_trusted: r.book ? TRUSTED.has(book) : null,
    market_type: type,
    selection: r.selection,
    selection_source_id: isA ? r.home_player_id : (isB ? r.away_player_id : null),
    line: M.num(r.point),
    odds_decimal: dec,
    odds_american: M.int(r.price_american) != null ? M.int(r.price_american) : M.americanFromDecimal(dec),
    implied_prob: M.num(r.implied_prob) != null ? M.num(r.implied_prob) : M.probFromDecimal(dec),
    no_vig_prob: fair == null ? null : M.probFromDecimal(fair),
    market_state: r.market_state === 'PRE' ? 'current' : (r.market_state === 'CLOSE' ? 'closing' : 'current'),
    market_status: 'open',
    captured_at: r.capture_at,
    unmapped: [type ? null : 'market_type', dec ? null : 'odds_decimal',
               (isA || isB) ? null : 'selection_player_id'].filter(Boolean),
    raw_ref: { origin: origin, market: r.market }
  };
}

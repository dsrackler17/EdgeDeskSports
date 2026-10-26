// @ts-nocheck — the plain JavaScript core (lib/edgedesk_sharp_lag.js) inlined in a .ts file, as kalshi_sync inlines its identity.
// ============================================================
//  FILE:    supabase/functions/sharp_lag/index.ts
//  TYPE:    Edge Function — Sharp lag research (EXPERIMENTAL): the FREE job
//  DEPLOY:  supabase functions deploy sharp_lag --no-verify-jwt
//           .github/workflows/deploy-sharp-lag.yml does it, tests first
//  CRON:    supabase/sharp_lag_cron.sql — every 10 minutes
//  SQL:     supabase/sharp_lag.sql (docs/sharp-lag/README.md)
// ============================================================
// IT NEVER CALLS THE ODDS GATEWAY OR THE PROVIDER, and spends nothing. It
// reads what is already stored (the gateway's snapshots in
// public.odds_api_snapshots; from step B Kalshi's 5-minute snapshots, the NBA
// injury reports, the NHL starting goalies and the published NBA roster
// inputs) and writes only the append-only sharp_* tables. Its cron command
// matches no pattern in public.odds_api_spend_patterns(), so it may run every
// 10 minutes. The one paid caller is supabase/functions/sharp_check.
//
// EACH RUN, in order; a failing step is recorded and never stops the next:
//   1 ingest   the Pinnacle and DraftKings prices of every gateway snapshot
//              it has not read, one append-only row each
//              (and, for a role-shift pull, the chosen teammates' prop prices)
//   2 triggers NBA starter status changes, NHL goalie changes, Kalshi moves
//              of 3c or more, recorded in the mode the dispatch switch is in
//              (shadow: nothing will be bought for them)
//              and NBA role shifts: a top-8 rotation player to OUT or
//              DOUBTFUL switches his game to the build's injury-conditioned
//              scenario (nba/role_shift.json)
//   3 flags    every upcoming event with a Pinnacle observation under 90
//              minutes old, against DraftKings (same side, same point) and
//              the linked Kalshi markets (YES ask plus fee), 2.5 pp or more
//   4 grades   every sharp-lag flag whose game started 10+ minutes ago, once,
//              and only once the model is in the research registry
//              (role shifts: the flags of each trigger's own prop pull, at
//              2.5 pp; graded at the same book and line, with the player's
//              actual stat from ESPN's final box score)
//
// AUTH. pg_cron sends the Vault secret sharp_lag_cron_secret as
// x-cron-secret; it must equal SHARP_LAG_CRON_SECRET. A GET is a health probe.
// POST body (all optional): { dry, now (dry only), steps: ["ingest", ...] }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHARP_LAG_CRON_SECRET
//      NBA_INPUTS_URL (default https://edgedesksports.com/nba/roster_inputs.json)
//      NBA_ROLE_SHIFT_URL (default https://edgedesksports.com/nba/role_shift.json)
//      NBA_SUMMARY_URL (default ESPN's game summary; the box score for grades)
// ============================================================

export const BUILD = "sharp_lag@2026-10-27.1";

// ── BEGIN SHARP LAG CORE ── copied from lib/edgedesk_sharp_lag.js by tools/sharp_lag/inline_core.js; do not edit here
/* ===========================================================================
   EdgeDesk SHARP LAG — the research core. EXPERIMENTAL.

   The hypothesis (research/sharp_lag/registration_sharp_lag.json): when a
   slow market (a Kalshi game-winner YES price, a DraftKings line) sits at
   least 2.5 percentage points below Pinnacle's de-vigged fair for the same
   outcome, after the slow market's own fees, the slow market is LAGGING, and
   the gap shows up as positive closing-line value against Pinnacle's close.
   Every flag is graded against the close, in the open, losses included. This
   module never says what anyone should do with a price: it measures a gap.

   ONE IMPLEMENTATION, THREE HOSTS
     supabase/functions/sharp_lag    the free job: ingest, triggers, flags, grades
     supabase/functions/sharp_check  the hourly paid dispatcher (through odds_gateway)
     app.html, performance/          the Experimental sections (window.EDSharpLag)
   The two functions carry a verbatim copy between BEGIN/END SHARP LAG CORE
   markers (tools/sharp_lag/inline_core.js; a test fails on drift), because
   the dashboard deploy bundles one folder.

   THE NUMBERS (frozen here and in public.sharp_lag_rule(); a test holds the
   two equal, so changing one is a reviewed code change in both)
     gap_pp 2.5                Pinnacle fair minus the target's all-in cost
     converge_pp 1.0           the lag is over once the gap is under this
     reference_max_age_min 90  an older Pinnacle observation is a past price
     book_target_max_age_min 90, kalshi_max_age_min 15, kalshi_max_spread 0.06
     kalshi_move 0.03          a trigger: the Kalshi mid moved 3¢ or more
                               between consecutive 5-minute snapshots
     close_max_lead_min 90     the close: the last observation at or before
                               the start, at most 90 minutes before it
     validation_min_graded 200 and the game-clustered bootstrap's 95% lower
                               bound on the mean CLV above zero, BOTH, before a
                               person may promote the model (never automatic)

   DE-VIG: SHIN, the same function capture prices signals.sharp_fair with
   (supabase/functions/capture/index.ts devig(), copied below with its
   bracket-checking bisection), so a Pinnacle fair here and on the board is
   one number. An underround pair is normalised proportionally, as capture
   does, and says so in devig_method.

   COSTS. DraftKings: 1 / decimal price (the vig is paid, so it stays in).
   Kalshi: the YES ask plus the taker fee. Until an operator records Kalshi's
   CURRENT published schedule as verified (public.market_execution_costs),
   the fee is the HIGHEST PLAUSIBLE one — coefficient 0.07 rounded up to the
   cent on a single-contract order, the most rounding the schedule allows —
   and every such flag is marked fee_unverified.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDSharpLag = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var L = { VERSION: 'edgedesk_sharp_lag/1' };

  L.RULES = {
    gap_pp: 2.5,
    role_shift_gap_pp: 2.5,
    converge_pp: 1.0,
    reference_max_age_min: 90,
    book_target_max_age_min: 90,
    kalshi_max_age_min: 15,
    kalshi_max_spread: 0.06,
    kalshi_move: 0.03,
    kalshi_pair_max_min: 10,
    close_max_lead_min: 90,
    check_window_hours: 24,
    validation_min_graded: 200,
    ci_level: 0.95,
    bootstrap_resamples: 2000,
    bootstrap_seed: 20261026,
    past_price_min: 90
  };
  L.MODELS = {
    sharp_lag: { key: 'SHARP-LAG', version: '0.1', label: 'Sharp lag' },
    role_shift: { key: 'NBA-ROLE-SHIFT', version: '0.1', label: 'NBA role shift' }
  };
  L.TRIGGERS = {
    scheduled: 'Scheduled check',
    nba_injury: 'NBA starter status change',
    nhl_goalie: 'NHL goalie change',
    kalshi_move: 'Kalshi move of 3¢ or more',
    role_shift: 'NBA role shift'
  };
  L.KALSHI_FEE = { coefficient: 0.07, unverified_contracts: 1, verified_contracts: 100,
    basis: 'Kalshi taker fee = round_up_to_cent(coefficient × contracts × price × (1 − price)) per order' };
  /* the books, in the order a role-shift flag takes its posted line from */
  L.PROP_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'espnbet', 'betrivers', 'fanatics', 'hardrockbet', 'betonlineag', 'pinnacle'];

  /* ------------------------------------------------------------ numbers */
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(iso) { var t = typeof iso === 'number' ? iso : Date.parse(iso); return isFinite(t) ? t : null; }
  function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
  function r2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
  L.num = num;

  L.amToDec = function (a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
  L.decToAm = function (d) { d = num(d); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };
  L.probToAm = function (p) { p = num(p); if (p == null || p <= 0 || p >= 1) return null; return L.decToAm(1 / p); };

  /* Bisection that checks its bracket (capture/index.ts bisect, verbatim in behaviour) */
  function bisect(f, lo, hi, it) {
    it = it || 80;
    var fl = f(lo); var fh = f(hi);
    if (!isFinite(fl) || !isFinite(fh)) return null;
    if (Math.abs(fl) < 1e-12) return lo;
    if (Math.abs(fh) < 1e-12) return hi;
    if ((fl < 0) === (fh < 0)) return null;
    for (var i = 0; i < it; i++) {
      var m = (lo + hi) / 2, fm = f(m);
      if (Math.abs(fm) < 1e-12) return m;
      if ((fl < 0) === (fm < 0)) { lo = m; fl = fm; } else hi = m;
    }
    return (lo + hi) / 2;
  }
  /* Shin de-vig (capture/index.ts devig(decs, 'shin'), the same arithmetic).
     Returns { probs, method }: method 'shin', or 'multiplicative' when the
     pair is underround or the root is not bracketed (as capture falls back). */
  L.devigShin = function (decs) {
    var q = decs.map(function (d) { return 1 / d; });
    var S = q.reduce(function (a, b) { return a + b; }, 0);
    var normalised = function () { return q.map(function (x) { return x / S; }); };
    if (!isFinite(S) || S <= 0) return { probs: decs.map(function () { return 0; }), method: 'invalid' };
    if (!(S > 1)) return { probs: normalised(), method: 'multiplicative' };
    var fair = function (z) { return q.map(function (qi) { return (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / S) - z) / (2 * (1 - z)); }); };
    var z = bisect(function (zz) { return fair(zz).reduce(function (a, b) { return a + b; }, 0) - 1; }, 1e-9, 0.5);
    if (z == null) return { probs: normalised(), method: 'multiplicative' };
    var out = fair(z);
    var s2 = out.reduce(function (a, b) { return a + b; }, 0);
    if (!isFinite(s2) || s2 <= 0) return { probs: normalised(), method: 'multiplicative' };
    return { probs: out.map(function (x) { return x / s2; }), method: 'shin' };
  };

  /* ------------------------------------------------------------ The Odds API bodies */
  /* every outcome of the named books in a gateway snapshot body (/odds: an
     array of events; /events/{id}/odds: one event), decimal prices. A book
     listed twice for one market keeps its latest update. */
  L.quotesFromOdds = function (body, o) {
    o = o || {};
    var books = o.books ? o.books.map(function (b) { return String(b).toLowerCase(); }) : null;
    var markets = o.markets || null;
    var american = String(o.format || 'decimal').toLowerCase() === 'american';
    var want = o.participants ? o.participants : null;
    var events = Array.isArray(body) ? body : (body && typeof body === 'object' && body.id ? [body] : []);
    var keep = {};
    events.forEach(function (ev) {
      if (!ev || !ev.id) return;
      (ev.bookmakers || []).forEach(function (bk) {
        var book = String(bk && bk.key || '').toLowerCase();
        if (!book || (books && books.indexOf(book) < 0)) return;
        (bk.markets || []).forEach(function (m) {
          var mk = String(m && m.key || '');
          if (!mk || (markets && markets.indexOf(mk) < 0)) return;
          var upd = m.last_update || bk.last_update || null;
          (m.outcomes || []).forEach(function (oc) {
            var dec = american ? L.amToDec(oc.price) : num(oc.price);
            if (dec == null || !(dec > 1)) return;
            var participant = oc.description ? String(oc.description) : null;
            if (want && participant && !want(participant)) return;
            var row = { event_id: String(ev.id), sport_key: ev.sport_key || o.sport_key || null, home_team: ev.home_team || null, away_team: ev.away_team || null,
              commence_time: ev.commence_time || null, book: book, book_last_update: upd, market: mk, side: String(oc.name || ''),
              participant: participant, point: num(oc.point), price_dec: r4(dec) };
            var k = [row.event_id, book, mk, row.side, participant || '', row.point == null ? '' : row.point].join('|');
            var prev = keep[k];
            if (!prev || String(upd || '') > String(prev.book_last_update || '')) keep[k] = row;
          });
        });
      });
    });
    return Object.keys(keep).map(function (k) { return keep[k]; });
  };

  /* one side of one market, independent of the book: what a target must match */
  L.sideKey = function (r) { return [r.market, r.side, r.participant || '', r.point == null ? '' : num(r.point)].join('|'); };
  /* the complete market a side belongs to (both sides devig together) */
  function pairKey(r) {
    if (r.market === 'h2h') return 'h2h';
    if (r.market === 'spreads') return 'spreads|' + Math.abs(num(r.point));
    return r.market + '|' + (r.participant || '') + '|' + (r.point == null ? '' : num(r.point));
  }
  function completePair(rows) {
    if (rows.length !== 2) return false;
    var a = rows[0], b = rows[1];
    if (a.side === b.side) return false;
    if (a.market === 'spreads') return num(a.point) != null && num(a.point) === -num(b.point);
    if (a.market === 'totals' || a.participant) return /^over$/i.test(a.side) !== /^over$/i.test(b.side) && num(a.point) === num(b.point);
    return true;
  }
  /* every two-way market in one book's rows of ONE observation, de-vigged:
     sideKey -> { side row, fair, opp_dec, method } */
  L.fairs = function (rows) {
    var groups = {}, out = {};
    (rows || []).forEach(function (r) { var k = pairKey(r); (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (!completePair(g)) return;
      var d = L.devigShin([num(g[0].price_dec), num(g[1].price_dec)]);
      if (d.method === 'invalid') return;
      for (var i = 0; i < 2; i++) {
        out[L.sideKey(g[i])] = { row: g[i], fair: r4(d.probs[i]), dec: num(g[i].price_dec), opp_dec: num(g[1 - i].price_dec), method: d.method };
      }
    });
    return out;
  };

  /* The resolution of an observation: the seconds since the previous one of
     the same source and event. The first has none, so it gets the cadence the
     source is held to: the gateway's bands for a board (60 minutes inside
     24 h of the start, 120 to 72 h, 360 beyond; supabase/odds_api_gateway.sql
     odds_api_cadence) and 5 minutes for Kalshi's snapshots. */
  L.nominalResolution = function (source, hoursToStart) {
    if (source === 'kalshi') return 300;
    var h = num(hoursToStart);
    return h == null || h <= 24 ? 3600 : h <= 72 ? 7200 : 21600;
  };

  /* ------------------------------------------------------------ Kalshi quotes */
  L.kalshiTwoSided = function (s) {
    var b = num(s && s.yes_bid), a = num(s && s.yes_ask);
    return b != null && a != null && b > 0 && a < 1 && a >= b;
  };
  L.kalshiSpread = function (s) { return L.kalshiTwoSided(s) ? r4(num(s.yes_ask) - num(s.yes_bid)) : null; };
  L.kalshiMid = function (s) {
    var sp = L.kalshiSpread(s);
    return sp != null && sp <= L.RULES.kalshi_max_spread + 1e-9 ? r4((num(s.yes_bid) + num(s.yes_ask)) / 2) : null;
  };

  /* ------------------------------------------------------------ triggers (pure) */
  /* consecutive two-sided, in-spread snapshots of one ticker whose mids differ by 3¢+ */
  L.kalshiMoves = function (snaps) {
    var R = L.RULES, s = (snaps || []).slice().sort(function (a, b) { return ms(a.captured_at) - ms(b.captured_at) || (a.id - b.id); }), out = [];
    for (var i = 1; i < s.length; i++) {
      var a = s[i - 1], b = s[i], ma = L.kalshiMid(a), mb = L.kalshiMid(b);
      if (ma == null || mb == null) continue;
      if ((ms(b.captured_at) - ms(a.captured_at)) / 60000 > R.kalshi_pair_max_min) continue;
      var mv = r4(mb - ma);
      if (Math.abs(mv) >= R.kalshi_move - 1e-9) out.push({ ticker: b.ticker, from_snapshot_id: a.id, to_snapshot_id: b.id, from_mid: ma, to_mid: mb, move: mv, at: b.captured_at });
    }
    return out;
  };
  /* one game's statuses on two consecutive injury reports: every change for
     a listed starter. A player missing from a report is NOT_LISTED. */
  L.statusChanges = function (prev, cur, players) {
    var out = [];
    (players || []).forEach(function (p) {
      var a = (prev && prev[p.id]) || 'NOT_LISTED', b = (cur && cur[p.id]) || 'NOT_LISTED';
      if (a !== b) out.push({ player_id: p.id, player_name: p.name, team_id: p.team_id || null, from: a, to: b });
    });
    return out;
  };
  /* one game and club's consensus starter rows: every change of goalie or status */
  L.goalieChanges = function (rows) {
    var s = (rows || []).slice().sort(function (a, b) { return ms(a.fetched_at) - ms(b.fetched_at) || (a.id - b.id); }), out = [];
    for (var i = 1; i < s.length; i++) {
      var a = s[i - 1], b = s[i];
      var ga = a.goalie_id || a.goalie_name || null, gb = b.goalie_id || b.goalie_name || null;
      if (ga !== gb || a.status !== b.status) out.push({ row_id: b.id, game_id: b.game_id, team: b.team, side: b.side,
        from: { goalie: a.goalie_name || null, status: a.status }, to: { goalie: b.goalie_name || null, status: b.status }, at: b.fetched_at });
    }
    return out;
  };
  /* the top `n` of a club's reference rotation by minutes (starters: 5; the rotation: 8) */
  L.topByMinutes = function (ref, n) {
    return (ref || []).slice().sort(function (a, b) { return (num(b.minutes) || 0) - (num(a.minutes) || 0); }).slice(0, n);
  };

  /* ------------------------------------------------------------ identity (NBA, NHL) */
  L.normName = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); };
  /* names: { club key: [full name, aliases...] }; returns name -> club key */
  L.nameIndex = function (names) {
    var m = {};
    Object.keys(names || {}).forEach(function (k) { (names[k] || []).forEach(function (n) { var x = L.normName(n); if (x && !(x in m)) m[x] = k; }); });
    return m;
  };
  /* the provider event for a scheduled game: both clubs and a start within 6 h; exactly one, or none */
  L.matchEvent = function (game, events, index) {
    var hits = (events || []).filter(function (e) {
      return index[L.normName(e.home_team)] === game.home && index[L.normName(e.away_team)] === game.away
        && Math.abs(ms(e.commence_time) - ms(game.start)) <= 6 * 3600e3;
    });
    return hits.length === 1 ? hits[0] : null;
  };

  /* ------------------------------------------------------------ costs (Kalshi fee, a book price) */
  function ceilCent(x) { return Math.ceil(x * 100 - 1e-9) / 100; }
  /* verified: an operator-verified public.market_execution_costs row
     ({ taker_coefficient, verified_at, verified_by, source_url }) or null */
  L.kalshiFee = function (price, verified) {
    var p = num(price); if (p == null || p <= 0 || p >= 1) return null;
    var c = verified ? num(verified.taker_coefficient) : null;
    if (c != null && c >= 0 && verified.verified_at) {
      var n = L.KALSHI_FEE.verified_contracts;
      return { per_contract: r4(ceilCent(c * n * p * (1 - p)) / n), basis: 'verified', unverified: false, coefficient: c, contracts: n,
        source: verified.source_url || null, verified_at: verified.verified_at, verified_by: verified.verified_by || null };
    }
    return { per_contract: ceilCent(L.KALSHI_FEE.coefficient * p * (1 - p)), basis: 'highest_plausible', unverified: true,
      coefficient: L.KALSHI_FEE.coefficient, contracts: L.KALSHI_FEE.unverified_contracts, source: null, verified_at: null, verified_by: null };
  };
  /* the all-in cost of one YES contract, as a probability */
  L.kalshiCost = function (s, verified) {
    if (!L.kalshiTwoSided(s) || L.kalshiSpread(s) > L.RULES.kalshi_max_spread + 1e-9) return null;
    var f = L.kalshiFee(s.yes_ask, verified); if (!f) return null;
    return { cost: r4(num(s.yes_ask) + f.per_contract), price: num(s.yes_ask), fee: f };
  };
  L.bookCost = function (dec) { dec = num(dec); return dec != null && dec > 1 ? r4(1 / dec) : null; };

  /* ------------------------------------------------------------ flags */
  function ageMin(at, now) { var a = ms(at), n = ms(now); return a == null || n == null ? null : (n - a) / 60000; }
  L.ageMin = ageMin;
  /* the episode a flag opens: one per event, venue and side. A new flag on the
     same key waits until the last one's gap has converged (L.convergence). */
  L.baseKey = function (event_id, venue, sk) { return [event_id, venue, sk].join('#'); };

  /* ctx: {
       now, event: { event_id, sport_key, home_team, away_team, commence_time },
       pinnacle: { observed_at, request_id, category, resolution_s, rows },
       draftkings: { observed_at, request_id, resolution_s, rows } | null,
       kalshi: [ { ticker, yes_team, snapshot: { id, captured_at, yes_bid, yes_ask }, resolution_s } ],
       fee: verified market_execution_costs row | null,
       trigger: { type, id } | null,
       open: function (base_key) -> true when an earlier flag on it has not converged
     }
     returns { flags, considered, skipped: { reason: n } } */
  L.evaluate = function (ctx) {
    var R = L.RULES, out = { flags: [], considered: 0, skipped: {} };
    var skip = function (why) { out.skipped[why] = (out.skipped[why] || 0) + 1; };
    var ev = ctx.event || {}, now = ctx.now;
    if (ms(ev.commence_time) == null || ms(ev.commence_time) <= ms(now)) { skip('not_pregame'); return out; }
    var P = ctx.pinnacle;
    if (!P || !P.rows || !P.rows.length) { skip('no_reference'); return out; }
    var pAge = ageMin(P.observed_at, now);
    if (pAge == null || pAge > R.reference_max_age_min) { skip('reference_past_price'); return out; }
    var F = L.fairs(P.rows);
    var trig = ctx.trigger || { type: 'scheduled', id: null };
    var base = function (sk, f) {
      return { model_key: L.MODELS.sharp_lag.key, model_version: L.MODELS.sharp_lag.version, flagged_at: new Date(ms(now)).toISOString(),
        trigger_type: trig.type, trigger_id: trig.id == null ? null : trig.id,
        sport_key: ev.sport_key, event_id: ev.event_id, home_team: ev.home_team, away_team: ev.away_team, commence_time: ev.commence_time,
        market: f.row.market, side: f.row.side, participant: f.row.participant || null, point: f.row.point == null ? null : num(f.row.point),
        reference_kind: 'pinnacle_shin', reference_prob: f.fair, devig_method: f.method,
        pinnacle_price_dec: f.dec, pinnacle_opp_dec: f.opp_dec, reference_observed_at: P.observed_at,
        reference_request_id: P.request_id == null ? null : P.request_id, reference_category: P.category || null,
        seconds_since_reference: Math.max(0, Math.round((ms(now) - ms(P.observed_at)) / 1000)),
        reference_resolution_s: P.resolution_s == null ? null : P.resolution_s, threshold_pp: R.gap_pp };
    };
    var finish = function (flag, targetRes) {
      var rs = [flag.reference_resolution_s, targetRes].filter(function (x) { return x != null; });
      flag.target_resolution_s = targetRes == null ? null : targetRes;
      flag.snapshot_resolution_s = rs.length ? Math.max.apply(null, rs) : null;
      flag.episode_key = L.baseKey(ev.event_id, flag.target_venue, L.sideKey(flag)) + '@' + flag.target_ref_at;
      return flag;
    };
    /* DraftKings, on the same side at the same point */
    var D = ctx.draftkings;
    if (D && D.rows && D.rows.length) {
      var dAge = ageMin(D.observed_at, now);
      if (dAge == null || dAge > R.book_target_max_age_min) skip('target_past_price');
      else D.rows.forEach(function (t) {
        var sk = L.sideKey(t), f = F[sk];
        if (!f) { skip('no_reference_for_side'); return; }
        out.considered++;
        var cost = L.bookCost(t.price_dec); if (cost == null) { skip('no_cost'); return; }
        var gap = r2((f.fair - cost) * 100);
        if (gap < R.gap_pp) { skip('under_threshold'); return; }
        if (ctx.open && ctx.open(L.baseKey(ev.event_id, 'draftkings', sk))) { skip('episode_open'); return; }
        var fl = base(sk, f);
        fl.target_venue = 'draftkings'; fl.target_ref = 'draftkings'; fl.target_price = num(t.price_dec); fl.target_price_american = L.decToAm(t.price_dec);
        fl.target_cost_prob = cost; fl.fee_per_contract = null; fl.fee_basis = 'none'; fl.fee_unverified = false;
        fl.target_observed_at = D.observed_at; fl.target_ref_at = D.observed_at; fl.target_request_id = D.request_id == null ? null : D.request_id;
        fl.gap_pp = gap;
        out.flags.push(finish(fl, D.resolution_s == null ? null : D.resolution_s));
      });
    }
    /* Kalshi game winners: YES on a team is the h2h side for that team */
    (ctx.kalshi || []).forEach(function (k) {
      var s = k.snapshot; if (!s) return;
      var sk = L.sideKey({ market: 'h2h', side: k.yes_team, participant: null, point: null }), f = F[sk];
      if (!f) { skip('no_reference_for_side'); return; }
      out.considered++;
      var kAge = ageMin(s.captured_at, now);
      if (kAge == null || kAge > R.kalshi_max_age_min) { skip('target_past_price'); return; }
      var c = L.kalshiCost(s, ctx.fee);
      if (!c) { skip('kalshi_not_two_sided_or_wide'); return; }
      var gap = r2((f.fair - c.cost) * 100);
      if (gap < R.gap_pp) { skip('under_threshold'); return; }
      if (ctx.open && ctx.open(L.baseKey(ev.event_id, 'kalshi', sk))) { skip('episode_open'); return; }
      var fl = base(sk, f);
      fl.target_venue = 'kalshi'; fl.target_ref = k.ticker; fl.target_price = c.price; fl.target_price_american = null;
      fl.target_cost_prob = c.cost; fl.fee_per_contract = c.fee.per_contract; fl.fee_basis = c.fee.basis; fl.fee_unverified = c.fee.unverified;
      fl.target_observed_at = s.captured_at; fl.target_ref_at = s.captured_at; fl.target_snapshot_id = s.id == null ? null : s.id;
      fl.gap_pp = gap;
      out.flags.push(finish(fl, k.resolution_s == null ? 300 : k.resolution_s));
    });
    return out;
  };

  /* ------------------------------------------------------------ convergence and grading */
  /* the target's cost at one observation, on the flag's own fee basis */
  function costAt(flag, obs, fee) {
    if (flag.target_venue === 'kalshi') {
      var c = L.kalshiCost(obs, flag.fee_unverified ? null : fee);
      return c ? { cost: c.cost, price: c.price, at: obs.captured_at } : null;
    }
    var r = (obs.rows || []).filter(function (x) { return L.sideKey(x) === L.sideKey(flag) && x.book === flag.target_ref; })[0];
    return r ? { cost: L.bookCost(r.price_dec), price: num(r.price_dec), at: obs.observed_at } : null;
  }
  function fairAt(flag, refObs, atMs) {
    var best = null;
    (refObs || []).forEach(function (o) { var t = ms(o.observed_at); if (t != null && t <= atMs && (!best || t > ms(best.observed_at))) { var f = L.fairs(o.rows)[L.sideKey(flag)]; if (f) best = { observed_at: o.observed_at, f: f }; } });
    return best;
  }
  /* h: { reference: [{ observed_at, rows }], target: [obs], fee, until }
     The first target observation after the flag whose gap to the Pinnacle fair
     current at that moment is under converge_pp; censored at `until`. */
  L.convergence = function (flag, h) {
    var R = L.RULES, t0 = ms(flag.flagged_at), until = ms(h.until);
    var obs = (h.target || []).map(function (o) { return { o: o, t: ms(o.captured_at || o.observed_at) }; })
      .filter(function (x) { return x.t != null && x.t > t0 && (until == null || x.t <= until); })
      .sort(function (a, b) { return a.t - b.t; });
    for (var i = 0; i < obs.length; i++) {
      var c = costAt(flag, obs[i].o, h.fee), fa = c ? fairAt(flag, h.reference, obs[i].t) : null;
      if (!c || !fa) continue;
      if ((fa.f.fair - c.cost) * 100 < R.converge_pp) return { converged: true, converged_at: new Date(obs[i].t).toISOString(), lag_s: Math.round((obs[i].t - t0) / 1000) };
    }
    return { converged: false, converged_at: null, lag_s: null };
  };

  /* the grade of one sharp-lag flag, written once (public.sharp_flag_grades):
     h: { reference: [{ observed_at, request_id, rows }], target: [obs], fee, now } */
  L.grade = function (flag, h) {
    var R = L.RULES, start = ms(flag.commence_time), g = {
      flag_id: flag.flag_id == null ? null : flag.flag_id, model_key: flag.model_key, close_status: 'no_close', no_close_reason: null,
      closing_reference_prob: null, closing_pinnacle_price_dec: null, closing_pinnacle_opp_dec: null, closing_reference_at: null, close_lead_min: null,
      closing_target_price: null, closing_target_cost: null, closing_target_at: null, clv_pp: null, hit: null,
      converged: false, converged_at: null, lag_to_converge_s: null, lag_censored: true,
      lag_resolution_s: flag.snapshot_resolution_s == null ? null : flag.snapshot_resolution_s, actual_stat: null, actual_outcome: null };
    var close = null;
    (h.reference || []).forEach(function (o) {
      var t = ms(o.observed_at); if (t == null || t > start) return;
      var f = L.fairs(o.rows)[L.sideKey(flag)];
      if (f && (!close || t > ms(close.observed_at))) close = { observed_at: o.observed_at, f: f };
    });
    if (!close) g.no_close_reason = 'no Pinnacle observation of this side at this point before the start';
    else {
      var lead = (start - ms(close.observed_at)) / 60000;
      g.close_lead_min = r2(lead);
      if (lead > R.close_max_lead_min) g.no_close_reason = 'the last Pinnacle observation was ' + Math.round(lead) + ' minutes before the start (over ' + R.close_max_lead_min + ')';
      else {
        g.close_status = 'graded';
        g.closing_reference_prob = close.f.fair; g.closing_pinnacle_price_dec = close.f.dec; g.closing_pinnacle_opp_dec = close.f.opp_dec;
        g.closing_reference_at = close.observed_at;
        g.clv_pp = r2((close.f.fair - num(flag.target_cost_prob)) * 100);
        g.hit = g.clv_pp > 0;
      }
    }
    var tc = null;
    (h.target || []).forEach(function (o) {
      var t = ms(o.captured_at || o.observed_at); if (t == null || t > start) return;
      var c = costAt(flag, o, h.fee); if (c && (!tc || t > ms(tc.at))) tc = c;
    });
    if (tc) { g.closing_target_price = tc.price; g.closing_target_cost = tc.cost; g.closing_target_at = tc.at; }
    var cv = L.convergence(flag, { reference: h.reference, target: h.target, fee: h.fee, until: flag.commence_time });
    g.converged = cv.converged; g.converged_at = cv.converged_at; g.lag_to_converge_s = cv.lag_s; g.lag_censored = !cv.converged;
    return g;
  };

  /* ------------------------------------------------------------ the record */
  /* a seeded generator, so the published interval is reproducible */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function quantile(sorted, q) { if (!sorted.length) return null; var i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  /* The mean CLV over flags, with a percentile bootstrap that resamples whole
     GAMES (clusters): flags in one game share its news and its close, so they
     are not independent. Returns the two-sided 95% interval; its lower end is
     the registered "95% lower bound". */
  L.clusterBootstrap = function (rows, o) {
    o = o || {};
    var B = o.B || L.RULES.bootstrap_resamples, seed = o.seed == null ? L.RULES.bootstrap_seed : o.seed, level = o.level || L.RULES.ci_level;
    var by = {}, keys = [];
    (rows || []).forEach(function (r) { var v = num(r.value); if (v == null) return; var k = String(r.cluster); if (!by[k]) { by[k] = []; keys.push(k); } by[k].push(v); });
    keys.sort();
    var n = keys.reduce(function (a, k) { return a + by[k].length; }, 0);
    if (!n) return { n: 0, clusters: 0, mean: null, lo: null, hi: null, B: B, seed: seed, level: level };
    var sum = keys.reduce(function (a, k) { return a + by[k].reduce(function (x, y) { return x + y; }, 0); }, 0);
    var sums = keys.map(function (k) { return by[k].reduce(function (x, y) { return x + y; }, 0); }), cnts = keys.map(function (k) { return by[k].length; });
    var rnd = mulberry32(seed), means = [];
    for (var b = 0; b < B; b++) {
      var s = 0, c = 0;
      for (var j = 0; j < keys.length; j++) { var i = Math.floor(rnd() * keys.length); s += sums[i]; c += cnts[i]; }
      means.push(s / c);
    }
    means.sort(function (x, y) { return x - y; });
    var a = (1 - level) / 2;
    return { n: n, clusters: keys.length, mean: r4(sum / n), lo: r4(quantile(means, a)), hi: r4(quantile(means, 1 - a)), B: B, seed: seed, level: level };
  };
  /* the registered validation: BOTH 200+ graded flags AND a 95% lower bound
     above zero make the model ELIGIBLE; a person promotes it, never this code */
  L.validation = function (graded, modelKey) {
    var R = L.RULES, g = (graded || []).filter(function (r) { return r.close_status === 'graded' && num(r.clv_pp) != null && (!modelKey || r.model_key === modelKey); });
    var ci = L.clusterBootstrap(g.map(function (r) { return { cluster: r.event_id, value: r.clv_pp }; }));
    return { model_key: modelKey || null, graded: g.length, threshold: R.validation_min_graded, status: 'EXPERIMENTAL',
      progress: g.length + ' of ' + R.validation_min_graded + ' graded flags', ci: ci,
      eligible: g.length >= R.validation_min_graded && ci.lo != null && ci.lo > 0 };
  };
  /* flags joined with their grades -> the record, overall and split */
  L.record = function (rows, o) {
    o = o || {};
    function agg(list) {
      var graded = list.filter(function (r) { return r.close_status === 'graded' && num(r.clv_pp) != null; });
      var noClose = list.filter(function (r) { return r.close_status === 'no_close'; });
      var pending = list.filter(function (r) { return !r.close_status; });
      var conv = list.filter(function (r) { return r.converged === true && num(r.lag_to_converge_s) != null; });
      var res = list.map(function (r) { return num(r.snapshot_resolution_s); }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
      var sumClv = graded.reduce(function (a, r) { return a + num(r.clv_pp); }, 0);
      var closed = graded.length + noClose.length;
      return { flags: list.length, graded: graded.length, no_close: noClose.length, pending: pending.length,
        no_close_rate: closed ? r4(noClose.length / closed) : null,
        avg_clv_pp: graded.length ? r2(sumClv / graded.length) : null,
        hit_rate: graded.length ? r4(graded.filter(function (r) { return num(r.clv_pp) > 0; }).length / graded.length) : null,
        converged: conv.length, censored: list.filter(function (r) { return r.close_status && r.converged === false; }).length,
        avg_lag_s: conv.length ? Math.round(conv.reduce(function (a, r) { return a + num(r.lag_to_converge_s); }, 0) / conv.length) : null,
        median_resolution_s: res.length ? quantile(res, 0.5) : null, max_resolution_s: res.length ? res[res.length - 1] : null };
    }
    function split(field) {
      var by = {}; (rows || []).forEach(function (r) { var k = r[field] == null ? '—' : String(r[field]); (by[k] = by[k] || []).push(r); });
      return Object.keys(by).sort().map(function (k) { return Object.assign({ key: k }, agg(by[k])); });
    }
    return { overall: agg(rows || []), by_sport: split('sport_key'), by_market: split('market'), by_trigger: split('trigger_type'),
      by_venue: split('target_venue'), validation: L.validation(rows, o.model_key) };
  };

  /* ------------------------------------------------------------ display */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  L.esc = esc;
  L.agoText = function (at, now) {
    var m = ageMin(at, now == null ? Date.now() : now); if (m == null) return '—';
    m = Math.max(0, Math.round(m));
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  };
  /* the existing rule (lib/edgedesk_games.js market_limit_min): a price older
     than 90 minutes is a PAST price, never a current one */
  L.isPast = function (at, now) { var m = ageMin(at, now == null ? Date.now() : now); return m == null || m > L.RULES.past_price_min; };
  L.priceAge = function (at, now) { return (L.isPast(at, now) ? 'past price, ' : 'seen ') + L.agoText(at, now); };
  function pct(p) { p = num(p); return p == null ? '—' : (Math.round(p * 1000) / 10).toFixed(1) + '%'; }
  function am(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' : '') + Math.round(a); }
  function signed(v, d) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d); }
  L.fmt = { pct: pct, am: am, signed: signed };
  var VENUE = { kalshi: 'Kalshi', draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET', betrivers: 'BetRivers', fanatics: 'Fanatics', hardrockbet: 'Hard Rock', betonlineag: 'BetOnline', pinnacle: 'Pinnacle' };
  L.venueLabel = function (v) { return VENUE[v] || v || '—'; };
  var MARKET = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: '3-pointers made', player_points_rebounds_assists: 'Pts + reb + ast' };
  L.marketLabel = function (m) { return MARKET[m] || m; };
  var SPORT = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'College football', basketball_nba: 'NBA', icehockey_nhl: 'NHL' };
  L.sportLabel = function (k) { return SPORT[k] || k; };
  L.sideLabel = function (f) {
    var p = num(f.point), who = f.participant ? f.participant + ' ' : '';
    if (f.market === 'spreads') return f.side + ' ' + (p > 0 ? '+' : '') + p;
    if (f.market === 'totals' || f.participant) return who + f.side + ' ' + p;
    return f.side;
  };
  L.targetText = function (f) {
    if (f.target_venue === 'kalshi') return 'Kalshi YES ' + Math.round(num(f.target_price) * 100) + '¢ + fee ' + Math.round(num(f.fee_per_contract) * 100) + '¢';
    return L.venueLabel(f.target_venue) + ' ' + am(f.target_price_american != null ? f.target_price_american : L.decToAm(f.target_price));
  };
  L.progressText = function (v) { return v ? v.graded + ' of ' + v.threshold + ' graded flags' : ''; };
  L.EXPERIMENTAL_NOTE = 'Experimental research. A flag records a measured gap between two markets at one moment; it is graded against the closing line whatever happens. It is not advice and not a recommendation.';
  L.FEE_NOTE = 'Kalshi fee not yet verified against Kalshi’s current published schedule: the cost uses the highest plausible fee (0.07 coefficient, rounded up on one contract).';

  function badge(t, cls) { return '<span class="sl-badge' + (cls ? ' ' + cls : '') + '">' + esc(t) + '</span>'; }
  function progressLine(v) {
    if (!v) return '';
    var ci = v.ci && v.ci.lo != null ? ' · mean CLV ' + signed(v.ci.mean, 2) + ' pp (95% interval ' + signed(v.ci.lo, 2) + ' to ' + signed(v.ci.hi, 2) + ', clustered by game)' : '';
    var lab = v.model_key === L.MODELS.role_shift.key ? L.MODELS.role_shift.label : v.model_key === L.MODELS.sharp_lag.key ? L.MODELS.sharp_lag.label : null;
    return '<p class="sl-progress"><b>Validation' + (lab ? ' · ' + esc(lab) : '') + ':</b> ' + esc(v.progress) + ci + '. Registered threshold: ' + v.threshold
      + ' graded flags and a 95% lower bound on mean CLV above zero, both. Status: ' + esc(v.status) + '.</p>';
  }
  L.progressLine = progressLine;
  function flagRow(f, now) {
    var tgtAt = f.target_observed_at, refAt = f.reference_observed_at;
    return '<tr>'
      + '<td data-l="Market">' + esc(L.marketLabel(f.market)) + '<br><small>' + esc(L.sideLabel(f)) + '</small></td>'
      + '<td data-l="Target price">' + esc(L.targetText(f)) + (f.fee_unverified ? ' ' + badge('fee unverified', 'warn') : '') + '<br><small class="' + (L.isPast(tgtAt, now) ? 'sl-past' : '') + '">' + esc(L.priceAge(tgtAt, now)) + '</small></td>'
      + '<td data-l="Reference">' + (f.reference_kind === 'pinnacle_shin' ? 'Pinnacle fair ' : 'EdgeDesk fair ') + esc(pct(f.reference_prob)) + '<br><small class="' + (L.isPast(refAt, now) ? 'sl-past' : '') + '">' + esc(L.priceAge(refAt, now)) + '</small></td>'
      + '<td data-l="Gap">' + esc(signed(f.gap_pp, 1)) + ' pp<br><small>cost ' + esc(pct(f.target_cost_prob)) + '</small></td>'
      + '<td data-l="Trigger">' + esc(L.TRIGGERS[f.trigger_type] || f.trigger_type) + '<br><small>flagged ' + esc(L.agoText(f.flagged_at, now)) + '</small></td>'
      + '<td data-l="Graded">' + (f.close_status === 'graded' ? esc(signed(f.clv_pp, 2)) + ' pp CLV' : f.close_status === 'no_close' ? 'no close' : 'not graded yet') + '</td>'
      + '</tr>';
  }
  var HEAD = '<thead><tr><th scope="col">Market</th><th scope="col">Target price</th><th scope="col">Reference</th><th scope="col">Gap</th><th scope="col">Trigger</th><th scope="col">Graded</th></tr></thead>';
  /* the game page's section. o: { now, flags, validation, access: 'subscriber' | 'public' | 'none',
     started, roleShift, cls, id, h (heading tag, default h2) } */
  L.gameSection = function (o) {
    o = o || {};
    var now = o.now == null ? Date.now() : o.now, flags = o.flags || [], hx = o.h || 'h2';
    var h = '<section class="sl-sec' + (o.cls ? ' ' + esc(o.cls) : '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + ' aria-label="Sharp lag, experimental">'
      + '<' + hx + ' class="sl-h">Sharp lag · Experimental ' + badge('Experimental', 'exp') + '</' + hx + '>'
      + '<p class="sl-note">' + esc(L.EXPERIMENTAL_NOTE) + '</p>';
    if (o.access !== 'subscriber' && !o.started) {
      h += '<p class="sl-note">Live flag details are for subscribers until the game starts; every flag is published here once it does.</p>';
    } else if (!flags.length) {
      h += '<p class="sl-note">No flag for this game. A flag needs a Pinnacle observation under ' + L.RULES.reference_max_age_min
        + ' minutes old and a target at least ' + L.RULES.gap_pp + ' percentage points below its fair after fees.</p>';
    } else {
      h += '<div class="sl-tblwrap"><table class="sl-tbl sl-flags">' + HEAD + '<tbody>' + flags.map(function (f) { return flagRow(f, now); }).join('') + '</tbody></table></div>';
      if (flags.some(function (f) { return f.fee_unverified; })) h += '<p class="sl-note">' + esc(L.FEE_NOTE) + '</p>';
      h += '<p class="sl-note">Lag is measured only to the snapshot cadence: '
        + esc(flags.map(function (f) { return f.snapshot_resolution_s; }).filter(function (x) { return x != null; }).map(function (x) { return Math.round(x / 60) + ' min'; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(', ') || 'unknown')
        + ' between observations.</p>';
    }
    if (o.roleShift) h += o.roleShift;
    return h + progressLine(o.validation) + '</section>';
  };
  /* a section still loading, or one whose read failed: never an empty box */
  L.pendingSection = function (o) {
    o = o || {};
    var hx = o.h || 'h2';
    return '<section class="sl-sec' + (o.cls ? ' ' + esc(o.cls) : '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + ' aria-label="Sharp lag, experimental">'
      + '<' + hx + ' class="sl-h">Sharp lag · Experimental ' + badge('Experimental', 'exp') + '</' + hx + '>'
      + '<p class="sl-note">' + esc(o.text || 'Checking the research record…') + '</p></section>';
  };
  /* a time in the reader's own zone, named ("11:20 AM CST"); UTC where the runtime has no zone data */
  function clock(iso) {
    var d = new Date(ms(iso));
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
    catch (_) { return d.toISOString().slice(11, 16) + ' UTC'; }
  }
  /* the Signals feed: today's flags, newest first */
  L.feed = function (o) {
    o = o || {};
    var now = o.now == null ? Date.now() : o.now, flags = (o.flags || []).slice().sort(function (a, b) { return ms(b.flagged_at) - ms(a.flagged_at); });
    var h = '<section class="sl-sec" aria-label="Sharp lag flags, experimental"><h2 class="sl-h">Sharp lag · today’s flags ' + badge('Experimental', 'exp') + '</h2>'
      + '<p class="sl-note">' + esc(L.EXPERIMENTAL_NOTE) + '</p>';
    if (!flags.length) h += '<p class="sl-note">' + esc(o.empty || 'No flag today yet.') + '</p>';
    else h += '<ul class="sl-feed">' + flags.map(function (f) {
      return '<li>' + badge('Experimental', 'exp') + ' <time datetime="' + esc(f.flagged_at) + '">' + esc(clock(f.flagged_at)) + '</time> · '
        + esc((f.away_team || '') + ' @ ' + (f.home_team || '')) + ' · ' + esc(L.marketLabel(f.market) + ' ' + L.sideLabel(f)) + ' · '
        + esc(L.targetText(f)) + ' vs ' + (f.reference_kind === 'pinnacle_shin' ? 'Pinnacle fair ' : 'EdgeDesk fair ') + esc(pct(f.reference_prob))
        + ' · gap ' + esc(signed(f.gap_pp, 1)) + ' pp · ' + esc(L.TRIGGERS[f.trigger_type] || f.trigger_type)
        + (f.fee_unverified ? ' ' + badge('fee unverified', 'warn') : '') + '</li>';
    }).join('') + '</ul>';
    return h + (o.validation || []).map(progressLine).join('') + '</section>';
  };
  function recTable(title, rows) {
    return '<h3 class="sl-h3">' + esc(title) + '</h3><div class="sl-tblwrap"><table class="sl-tbl sl-rec"><thead><tr><th scope="col"></th><th scope="col">Flags</th><th scope="col">Graded</th><th scope="col">No close</th><th scope="col">Avg CLV</th><th scope="col">Hit rate</th><th scope="col">Avg lag to converge</th><th scope="col">Snapshot resolution</th></tr></thead><tbody>'
      + rows.map(function (r) {
        return '<tr><th scope="row">' + esc(r.label || r.key) + '</th><td data-l="Flags">' + r.flags + '</td><td data-l="Graded">' + r.graded + '</td><td data-l="No close">' + r.no_close + (r.no_close_rate != null ? ' (' + esc(pct(r.no_close_rate)) + ')' : '') + '</td>'
          + '<td data-l="Avg CLV">' + (r.avg_clv_pp == null ? '—' : esc(signed(r.avg_clv_pp, 2)) + ' pp') + '</td><td data-l="Hit rate">' + esc(pct(r.hit_rate)) + '</td>'
          + '<td data-l="Avg lag to converge">' + (r.avg_lag_s == null ? '—' : esc(Math.round(r.avg_lag_s / 60) + ' min')) + (r.censored ? ' <small>(' + r.censored + ' never converged)</small>' : '') + '</td>'
          + '<td data-l="Snapshot resolution">' + (r.median_resolution_s == null ? '—' : '±' + esc(Math.round(r.median_resolution_s / 60) + ' min')) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  /* the Performance record for one model. o: { title, record, note } */
  L.recordSection = function (o) {
    var rec = o.record, ov = Object.assign({ key: 'All flags', label: 'All flags' }, rec.overall);
    var lab = function (rows, f) { return rows.map(function (r) { return Object.assign({}, r, { label: f(r.key) }); }); };
    return '<section class="sl-sec" aria-label="' + esc(o.title) + '"><h2 class="sl-h">' + esc(o.title) + ' ' + badge('Experimental', 'exp') + '</h2>'
      + '<p class="sl-note">' + esc(L.EXPERIMENTAL_NOTE) + ' Every flag counts, losses included; the record is computed straight from the append-only flag and grade tables, with no edit step.</p>'
      + progressLine(rec.validation)
      + '<p class="sl-note">Data quality: ' + rec.overall.no_close + ' flag' + (rec.overall.no_close === 1 ? '' : 's') + ' had no usable close'
      + (rec.overall.no_close_rate != null ? ' (' + esc(pct(rec.overall.no_close_rate)) + ' of closed flags)' : '') + (rec.overall.no_close === 1 ? ' and is' : ' and are') + ' excluded from CLV, counted here. '
      + rec.overall.pending + ' flag' + (rec.overall.pending === 1 ? ' is' : 's are') + ' waiting for the game to start.</p>'
      + recTable('Overall', [ov])
      + recTable('By sport', lab(rec.by_sport, L.sportLabel))
      + recTable('By market', lab(rec.by_market, L.marketLabel))
      + recTable('By trigger', lab(rec.by_trigger, function (k) { return L.TRIGGERS[k] || k; }))
      + (o.note ? '<p class="sl-note">' + esc(o.note) + '</p>' : '') + '</section>';
  };

  /* ------------------------------------------------------------ the hosts' helpers */
  /* the same club across two feeds: the same name, one a whole-word prefix of
     the other ("Ohio State" / "Ohio State Buckeyes"), or the same last word
     of two multi-word names ("LA Clippers" / "Los Angeles Clippers"). Loose on
     its own, so it is only ever used with the OTHER club matched too and a
     start within 6 hours (flagsForGame); a host with a resolver passes it */
  L.sameTeam = function (a, b) {
    var x = L.normName(a), y = L.normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var s = x.length < y.length ? x : y, l = s === x ? y : x;
    if (l.indexOf(s + ' ') === 0) return true;
    var xs = x.split(' '), ys = y.split(' ');
    return xs.length > 1 && ys.length > 1 && xs[xs.length - 1] === ys[ys.length - 1];
  };
  /* a game's flags among a sport's: both clubs (or both swapped, a neutral
     listing) and a start within 6 hours. g: { sport_key, home, away, start }, o.sameTeam */
  L.flagsForGame = function (flags, g, o) {
    var same = (o && o.sameTeam) || L.sameTeam, t = ms(g.start);
    return (flags || []).filter(function (f) {
      if (g.sport_key && f.sport_key !== g.sport_key) return false;
      if (t != null && Math.abs(ms(f.commence_time) - t) > 6 * 3600e3) return false;
      return (same(f.home_team, g.home) && same(f.away_team, g.away)) || (same(f.home_team, g.away) && same(f.away_team, g.home));
    });
  };
  /* the validation line from the public counts (public.sharp_lag_progress)
     and whichever graded rows the reader may see: the counts are the
     record's own; the interval needs the CLVs */
  L.validationFrom = function (progress, rows, modelKey) {
    modelKey = modelKey || L.MODELS.sharp_lag.key;
    var m = ((progress && progress.models) || []).filter(function (x) { return x.model_key === modelKey; })[0] || null;
    var v = L.validation((rows || []).filter(function (r) { return r.model_key === modelKey; }), modelKey);
    if (m && num(m.graded) != null && num(m.graded) > v.graded) {
      v.graded = num(m.graded); v.progress = v.graded + ' of ' + v.threshold + ' graded flags'; v.ci = null; v.eligible = false;
    }
    v.registered = m ? !!m.registered : null;
    return v;
  };
  L.STYLE = '.sl-sec{margin:18px 0;padding:14px 16px;border:1px solid rgba(127,127,127,.35);border-radius:10px}'
    + '.sl-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 6px}.sl-h3{margin:12px 0 4px;font-size:15px}'
    + '.sl-note,.sl-progress{font-size:13px;opacity:.85;margin:6px 0}.sl-badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid currentColor;opacity:.9}'
    + '.sl-badge.exp{color:#8a5cf6}.sl-badge.warn{color:#b45309}.sl-tblwrap{overflow-x:auto;max-width:100%}'
    + '.sl-tbl{border-collapse:collapse;width:100%;font-size:13px}.sl-tbl th,.sl-tbl td{text-align:left;padding:6px 8px;border-top:1px solid rgba(127,127,127,.25);vertical-align:top}'
    + '@media (max-width:560px){.sl-flags thead,.sl-rec thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.sl-flags tr,.sl-rec tr{display:block;padding:6px 0;border-top:1px solid rgba(127,127,127,.25)}'
    + '.sl-rec th[scope=row]{display:block;border:0;padding:4px 0}'
    + '.sl-flags td,.sl-rec td{display:inline-block;vertical-align:top;border:0;padding:4px 14px 4px 0;min-width:40%}.sl-flags td::before,.sl-rec td::before{content:attr(data-l);display:block;font-size:11px;opacity:.7}}'
    + '.sl-tbl small{opacity:.75}.sl-past{color:#b45309}.sl-feed{list-style:none;margin:6px 0;padding:0;font-size:13px}.sl-feed li{padding:6px 0;border-top:1px solid rgba(127,127,127,.25)}';
  L.injectStyle = function (doc) {
    try { if (!doc || doc.getElementById('edgedesk-sharp-lag-css')) return; var st = doc.createElement('style'); st.id = 'edgedesk-sharp-lag-css'; st.textContent = L.STYLE; doc.head.appendChild(st); } catch (_) { /* unstyled is still readable */ }
  };

  /* ------------------------------------------------------------ role shifts (NBA-ROLE-SHIFT) */
  L.ROLE_SHIFT = {
    statuses: ['OUT', 'DOUBTFUL'], rotation: 8,
    max_age_h: 24,   /* the build's scenarios, older than this, switch nothing on (it runs every 3 hours) */
    /* the pull's markets (nba_role_props) and the build's keys for them (nba/props/role_shift.js MARKETS) */
    markets: { player_rebounds: 'reb', player_assists: 'ast', player_threes: 'fg3m', player_points_rebounds_assists: 'pra' },
    labels: { reb: 'Rebounds', ast: 'Assists', fg3m: '3-pointers made', pra: 'Pts + reb + ast' }
  };
  /* a rotation player moving TO OUT or DOUBTFUL from anything else (not listed reads as available) */
  L.roleShiftChanges = function (prev, cur, rotation) {
    var bad = L.ROLE_SHIFT.statuses;
    return L.statusChanges(prev, cur, rotation).filter(function (c) { return bad.indexOf(c.to) >= 0 && bad.indexOf(c.from) < 0; });
  };
  /* the build's scenario for one absent player of one game (nba/role_shift.json), or null */
  L.roleShiftScenario = function (file, gameId, playerId) {
    var g = ((file && file.games) || []).filter(function (x) { return String(x.game_id) === String(gameId); })[0];
    return g ? (g.scenarios || []).filter(function (s) { return s.absent && String(s.absent.id) === String(playerId); })[0] || null : null;
  };
  /* the trigger's detail: the regime switch, the absent player, the priced teammates (the pull and the
     flags read these) and the whole table (the page reads it) */
  L.roleShiftDetail = function (file, scenario, change, report) {
    var rows = scenario.teammates || [];
    return {
      regime_switch: { from: file.model.default_regime, to: file.model.regime, model: file.model.key, version: file.model.version,
        scenario_built_at: file.generated_at, props_generated_at: file.props_generated_at || null },
      absent: { id: String(change.player_id), name: change.player_name || scenario.absent.name, team_id: scenario.absent.team_id, team: scenario.absent.team,
        reference_minutes: scenario.absent.reference_minutes, from: change.from, to: change.to },
      report_id: report ? report.id : null, previous_report_id: report ? report.previous_id : null, report_captured_at: report ? report.captured_at : null,
      teammates: rows.filter(function (t) { return t.priced; }),
      table: rows.map(function (t) { var o = Object.assign({}, t); delete o.markets; return o; }),
      short_of_three: !!scenario.short_of_three
    };
  };
  /* a book's two-way lines for one player and market: point -> { over, under } */
  function twoWay(rows) {
    var by = {};
    rows.forEach(function (r) { var k = String(num(r.point)), s = /^over$/i.test(r.side) ? 'over' : /^under$/i.test(r.side) ? 'under' : null; if (s) (by[k] = by[k] || {})[s] = r; });
    return Object.keys(by).filter(function (k) { return by[k].over && by[k].under; }).map(function (k) { return { point: num(k), over: by[k].over, under: by[k].under }; });
  }
  /* the role-shift flags of the trigger's own prop pull. ctx: { now, event, trigger: { id, detail }, rows (that pull's
     price rows), observed_at, request_id, resolution_s (the report to the pull), open(episode_key) }.
     At the first book in PROP_BOOKS order posting a two-way half-point line for the teammate and the market
     (its most even pair): the regime's P(side) at that line minus 1 / decimal, vig included. */
  L.evaluateRoleShift = function (ctx) {
    var R = L.RULES, out = { flags: [], considered: 0, skipped: {} };
    var skip = function (why) { out.skipped[why] = (out.skipped[why] || 0) + 1; };
    var ev = ctx.event || {}, d = (ctx.trigger && ctx.trigger.detail) || {}, abs = d.absent || {}, sw = d.regime_switch || {};
    if (ms(ev.commence_time) == null || ms(ev.commence_time) <= ms(ctx.now)) { skip('not_pregame'); return out; }
    /* the existing rule: a price older than 90 minutes is a past price, never flagged */
    var age = ageMin(ctx.observed_at, ctx.now);
    if (age == null || age > R.book_target_max_age_min) { skip('past_price'); return out; }
    var built = ms(sw.scenario_built_at) != null && ms(sw.scenario_built_at) <= ms(ctx.now) ? sw.scenario_built_at : ctx.now;
    (d.teammates || []).forEach(function (t) {
      var name = L.normName(t.name);
      Object.keys(L.ROLE_SHIFT.markets).forEach(function (mk) {
        var m = (t.markets || {})[L.ROLE_SHIFT.markets[mk]]; if (!m) return;
        var mine = (ctx.rows || []).filter(function (r) { return r.market === mk && L.normName(r.participant) === name; });
        if (!mine.length) { skip('not_posted'); return; }
        var pick = null;
        for (var i = 0; i < L.PROP_BOOKS.length && !pick; i++) {
          var bk = L.PROP_BOOKS[i], lines = twoWay(mine.filter(function (r) { return r.book === bk; }));
          if (!lines.length) continue;
          lines.sort(function (a, b) { return Math.abs(num(a.over.price_dec) - num(a.under.price_dec)) - Math.abs(num(b.over.price_dec) - num(b.under.price_dec)) || a.point - b.point; });
          pick = Object.assign({ book: bk }, lines[0]);
        }
        if (!pick) { skip('no_two_way_line'); return; }
        if (Math.abs(pick.point - Math.floor(pick.point) - 0.5) > 1e-9) { skip('whole_number_line'); return; }
        var pOver = num((m.over || {})[pick.point.toFixed(1)]);
        if (pOver == null) { skip('line_outside_the_ladder'); return; }
        [['Over', pick.over, pick.under, pOver], ['Under', pick.under, pick.over, 1 - pOver]].forEach(function (s) {
          out.considered++;
          var side = s[0], row = s[1], p = s[3];
          /* the absent player's own unders void if he sits: never flagged */
          if (side === 'Under' && (String(t.id) === String(abs.id) || name === L.normName(abs.name))) { skip('absent_players_under'); return; }
          if (!(p > 0 && p < 1)) { skip('no_probability'); return; }
          var dec = num(row.price_dec), cost = 1 / dec, gap = (p - cost) * 100;
          if (gap < R.role_shift_gap_pp) { skip('under_threshold'); return; }
          var key = ['role_shift', ev.event_id, name, mk, side].join('|');
          if (ctx.open && ctx.open(key)) { skip('episode_open'); return; }
          out.flags.push({
            flagged_at: ctx.now, model_key: L.MODELS.role_shift.key, model_version: L.MODELS.role_shift.version, trigger_type: 'role_shift', trigger_id: ctx.trigger.id,
            sport_key: ev.sport_key, event_id: ev.event_id, home_team: ev.home_team, away_team: ev.away_team, commence_time: ev.commence_time,
            market: mk, side: side, participant: row.participant, point: pick.point, target_venue: pick.book, target_ref: pick.book,
            target_price: r4(dec), target_price_american: L.decToAm(dec), target_cost_prob: r4(cost), fee_per_contract: null, fee_basis: 'none', fee_unverified: false,
            target_observed_at: ctx.observed_at, target_snapshot_id: null, target_request_id: ctx.request_id == null ? null : ctx.request_id,
            reference_kind: 'role_shift_model', reference_prob: r4(p), devig_method: null, pinnacle_price_dec: null, pinnacle_opp_dec: null,
            reference_observed_at: built, reference_request_id: null, reference_category: 'nba_role_shift_build',
            gap_pp: r2(gap), threshold_pp: R.role_shift_gap_pp, seconds_since_reference: Math.max(0, Math.round((ms(ctx.now) - ms(built)) / 1000)),
            reference_resolution_s: null, target_resolution_s: ctx.resolution_s == null ? null : ctx.resolution_s, snapshot_resolution_s: ctx.resolution_s == null ? null : ctx.resolution_s,
            episode_key: key,
            absent_player_id: String(abs.id), absent_player_name: abs.name || null, minutes_delta: num(t.minutes_delta), sample_games: num(t.games_without),
            sample_stints: t.stints ? num(t.stints.sample) : null, fair_line: num(m.fair_line), posted_line: pick.point, fair_price_american: L.decToAm(1 / p),
            detail: { participant_id: String(t.id), regime: sw.to || null, absent_status: abs.to || null, default_mean: num(m.default_mean), regime_mean: num(m.mean),
              opposite_price_dec: num(s[2].price_dec), report_id: d.report_id == null ? null : d.report_id }
          });
        });
      });
    });
    return out;
  };
  /* an ESPN game summary (site.api.espn.com .../nba/summary?event=) -> { final, players: id -> { played, min, pts, reb, ast, fg3m } } */
  L.espnBox = function (json) {
    var comp = json && json.header && (json.header.competitions || [])[0], st = comp && comp.status && comp.status.type;
    var out = { final: !!(st && st.completed), players: {} };
    ((json && json.boxscore && json.boxscore.players) || []).forEach(function (t) {
      var s = (t.statistics || [])[0]; if (!s || !Array.isArray(s.athletes)) return;
      var keys = (s.keys || []).map(function (k) { return String(k).toLowerCase(); }), labels = (s.labels || s.names || []).map(function (k) { return String(k).toUpperCase(); });
      var col = function (key, label) { var i = keys.indexOf(key); return i >= 0 ? i : labels.indexOf(label); };
      var iMin = col('minutes', 'MIN'), iPts = col('points', 'PTS'), iReb = col('rebounds', 'REB'), iAst = col('assists', 'AST'), i3 = col('threepointfieldgoalsmade-threepointfieldgoalsattempted', '3PT');
      s.athletes.forEach(function (a) {
        var id = a.athlete && a.athlete.id != null ? String(a.athlete.id) : null; if (!id) return;
        var v = a.stats || [], cell = function (i) { return i >= 0 ? v[i] : null; };
        var mins = a.didNotPlay ? 0 : (num(String(cell(iMin) == null ? '' : cell(iMin)).split(':')[0]) || 0);
        out.players[id] = { name: a.athlete.displayName || a.athlete.fullName || id, played: !a.didNotPlay && mins > 0, min: mins,
          pts: num(cell(iPts)), reb: num(cell(iReb)), ast: num(cell(iAst)), fg3m: num(String(cell(i3) == null ? '' : cell(i3)).split('-')[0]) };
      });
    });
    return out;
  };
  /* the box's number for a prop market (P+R+A summed) */
  L.boxValue = function (p, market) {
    var k = L.ROLE_SHIFT.markets[market]; if (!p || !k) return null;
    if (k === 'pra') return p.pts == null || p.reb == null || p.ast == null ? null : p.pts + p.reb + p.ast;
    return num(p[k]);
  };
  /* the grade of one role-shift flag, written once. h: { observations: [{ observed_at, request_id, rows }] (the event's prop
     rows), box (L.espnBox, or null when the game has no final box yet), now }.
     Close: the flag's book, player, market and line, the last two-way pair at or before the start and no more
     than 90 minutes before it; CLV = its Shin P(side) - the flag's cost. Converged: that close within 1.0 pp of
     the regime's probability. The actual stat is stored (void if he did not play). */
  L.gradeRoleShift = function (flag, h) {
    var R = L.RULES, start = ms(flag.commence_time), det = flag.flag_detail || flag.detail || {};
    var g = { flag_id: flag.flag_id == null ? null : flag.flag_id, model_key: flag.model_key, close_status: 'no_close', no_close_reason: null,
      closing_reference_prob: null, closing_pinnacle_price_dec: null, closing_pinnacle_opp_dec: null, closing_reference_at: null, close_lead_min: null,
      closing_target_price: null, closing_target_cost: null, closing_target_at: null, clv_pp: null, hit: null,
      converged: false, converged_at: null, lag_to_converge_s: null, lag_censored: true, lag_resolution_s: flag.snapshot_resolution_s == null ? null : flag.snapshot_resolution_s,
      actual_stat: null, actual_outcome: null, detail: {} };
    var key = L.sideKey(flag), close = null;
    (h.observations || []).forEach(function (o) {
      var t = ms(o.observed_at); if (t == null || t > start) return;
      var f = L.fairs((o.rows || []).filter(function (r) { return r.book === flag.target_venue; }))[key];
      if (f && (!close || t > ms(close.observed_at))) close = { observed_at: o.observed_at, f: f };
    });
    if (!close) g.no_close_reason = 'no two-way ' + flag.target_venue + ' price at this player, market and line before the start';
    else {
      var lead = (start - ms(close.observed_at)) / 60000;
      g.close_lead_min = r2(lead);
      if (lead > R.close_max_lead_min) g.no_close_reason = 'the last ' + flag.target_venue + ' price at this line was ' + Math.round(lead) + ' minutes before the start (over ' + R.close_max_lead_min + ')';
      else {
        g.close_status = 'graded';
        g.closing_reference_prob = close.f.fair; g.closing_reference_at = close.observed_at;
        g.closing_target_price = close.f.dec; g.closing_target_cost = r4(1 / num(close.f.dec)); g.closing_target_at = close.observed_at;
        g.clv_pp = r2((close.f.fair - num(flag.target_cost_prob)) * 100);
        g.hit = g.clv_pp > 0;
        g.detail.closing_opp_dec = close.f.opp_dec; g.detail.devig = close.f.method || 'shin';
        if (Math.abs(close.f.fair - num(flag.reference_prob)) * 100 <= R.converge_pp) {
          g.converged = true; g.converged_at = close.observed_at; g.lag_censored = false;
          g.lag_to_converge_s = Math.max(0, Math.round((ms(close.observed_at) - ms(flag.flagged_at)) / 1000));
          g.lag_resolution_s = g.lag_to_converge_s;
        }
      }
    }
    var box = h.box, pid = det.participant_id != null ? String(det.participant_id) : null;
    var p = box && box.players ? (pid && box.players[pid]) || null : null;
    if (box && box.players && !p) { var n = L.normName(flag.participant); Object.keys(box.players).forEach(function (k) { if (!p && L.normName(box.players[k].name) === n) p = box.players[k]; }); }
    if (!box || !box.final) g.detail.actual_missing = 'no final box score was read for this game';
    else if (!p || !p.played) { g.actual_outcome = 'void'; g.detail.actual_note = 'he did not play: the prop is void'; }
    else {
      var v = L.boxValue(p, flag.market), line = num(flag.point);
      if (v == null) g.detail.actual_missing = 'the box score has no ' + flag.market + ' column';
      else { g.actual_stat = v; g.actual_outcome = v > line ? 'over' : v < line ? 'under' : 'push'; }
    }
    return g;
  };
  /* the record carries the actual results beside CLV (role shifts store the player's stat) */
  var baseRecord = L.record;
  L.record = function (rows, o) {
    var rec = baseRecord(rows, o), oc = { over: 0, under: 0, push: 0, void: 0 };
    (rows || []).forEach(function (r) { if (r.actual_outcome && oc[r.actual_outcome] != null) oc[r.actual_outcome]++; });
    rec.outcomes = oc;
    return rec;
  };
  var baseRecordSection = L.recordSection;
  L.recordSection = function (o) {
    var h = baseRecordSection(o), oc = o.record && o.record.outcomes;
    if (!oc || !(oc.over + oc.under + oc.push + oc.void)) return h;
    var line = '<p class="sl-note">Actual results, stored beside CLV: ' + oc.over + ' over, ' + oc.under + ' under, ' + oc.push + ' push, ' + oc['void'] + ' void (the player did not play). CLV, not these, is the registered criterion.</p>';
    return h.replace(/<\/section>$/, line + '</section>');
  };
  /* the page's "Who absorbs the minutes": one scenario (the build's or a trigger's table), its status, its source */
  L.roleShiftTable = function (o) {
    var sc = o.scenario || {}, abs = sc.absent || o.absent || {}, rows = sc.teammates || o.table || [];
    var mk = ['reb', 'ast', 'fg3m', 'pra'];
    var h = '<h3 class="sl-h3">' + esc(abs.name || 'A rotation player') + (abs.team ? ' (' + esc(abs.team) + ')' : '') + ' is ' + esc(String(o.status || 'out').toLowerCase()) + '</h3>';
    var body = rows.map(function (t) {
      if (t.skipped) return '<tr><th scope="row">' + esc(t.name) + '</th><td data-l="Minutes" colspan="4">' + esc(t.skipped) + '</td></tr>';
      var st = t.stints || {};
      var vol = t.markets ? mk.map(function (k) { var m = t.markets[k]; return m ? esc(L.ROLE_SHIFT.labels[k]) + ' ' + esc(fmtN(m.default_mean)) + ' → ' + esc(fmtN(m.mean)) + ' <small>(fair line ' + esc(m.fair_line) + ')</small>' : ''; }).filter(Boolean).join('<br>') : '<small>not priced</small>';
      return '<tr><th scope="row">' + esc(t.name) + (t.priced ? ' ' + badge('priced', 'exp') : '') + '</th>'
        + '<td data-l="Minutes">' + esc(fmtN(t.minutes_default)) + ' → ' + esc(fmtN(t.minutes_regime)) + ' <small>(' + esc(signed(t.minutes_delta, 1)) + ')</small></td>'
        + '<td data-l="Usage per game">' + esc(signed(t.usage_delta, 1)) + '</td>'
        + '<td data-l="Games without / with">' + esc(t.games_without) + ' / ' + esc(t.games_with) + '</td>'
        + '<td data-l="Stints cross-check">' + (st.available ? esc(signed(st.minutes_delta, 1)) + ' min <small>(' + esc(st.sample) + ' stints' + (t.stints_agree === false ? ', disagrees' : '') + ')</small>' : '<small>no stints</small>') + '</td>'
        + '<td data-l="Volume (default → regime mean)">' + vol + '</td></tr>';
    }).join('');
    return h + '<div class="sl-tblwrap"><table class="sl-tbl sl-flags"><thead><tr><th scope="col">Teammate</th><th scope="col">Minutes</th><th scope="col">Usage per game</th><th scope="col">Games without / with</th><th scope="col">Stints cross-check</th><th scope="col">Volume (default → regime mean)</th></tr></thead><tbody>'
      + body + '</tbody></table></div>';
  };
  function fmtN(v) { v = num(v); return v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
  /* the section: the scenarios switched on by the game's current report. o: { file (nba/role_shift.json), gameId, statuses
     (the injury card's rows), live (the report is current), cls, id, h } */
  L.roleShiftSection = function (o) {
    o = o || {};
    var hx = o.h || 'h2', file = o.file || {}, g = ((file.games) || []).filter(function (x) { return String(x.game_id) === String(o.gameId); })[0];
    var head = '<section class="sl-sec' + (o.cls ? ' ' + esc(o.cls) : '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + ' aria-label="Who absorbs the minutes, experimental">'
      + '<' + hx + ' class="sl-h">Who absorbs the minutes ' + badge('Experimental', 'exp') + '</' + hx + '>';
    var note = '<p class="sl-note">Experimental research (NBA-ROLE-SHIFT v' + esc(L.MODELS.role_shift.version) + '). When a top-' + L.ROLE_SHIFT.rotation
      + ' rotation player is out or doubtful, EdgeDesk’s props model in its injury-conditioned regime: each teammate’s minutes and volume from his games without that player (this season and last, shrunk toward his games with him), with play-by-play stints as a cross-check. The default projections are unchanged. Fair lines, not prices, and not advice.</p>';
    if (!g) return head + note + '<p class="sl-note">No role-shift scenarios were built for this game.</p></section>';
    if (!o.live) return head + note + '<p class="sl-note">No current injury report for this game: no regime switch. Scenarios for ' + g.scenarios.filter(function (s) { return !s.skipped; }).length + ' rotation players are ready.</p></section>';
    var st = o.statuses || [], bad = L.ROLE_SHIFT.statuses;
    var on = g.scenarios.map(function (s) {
      var r = st.filter(function (x) { return (x.player_id != null && String(x.player_id) === String(s.absent.id)) || L.normName(x.player_name) === L.normName(s.absent.name); })[0];
      return r && bad.indexOf(r.status) >= 0 ? { s: s, status: r.status } : null;
    }).filter(Boolean);
    if (!on.length) return head + note + '<p class="sl-note">No top-' + L.ROLE_SHIFT.rotation + ' rotation player is out or doubtful on the current report: the default projections stand.</p></section>';
    return head + note + on.map(function (x) {
      return x.s.skipped ? '<h3 class="sl-h3">' + esc(x.s.absent.name) + ' is ' + esc(x.status.toLowerCase()) + '</h3><p class="sl-note">No regime switch: ' + esc(x.s.skipped) + '.</p>'
        : L.roleShiftTable({ scenario: x.s, status: x.status });
    }).join('') + '<p class="sl-note">Scenarios built ' + esc(L.agoText(file.generated_at)) + ' from the props model of ' + esc(L.agoText(file.props_generated_at)) + '.</p></section>';
  };
  return L;
}));
// ── END SHARP LAG CORE ──

// ── BEGIN SHARP LAG IDENTITY ── generated from nba/data/teams.json and hockey/data/teams.json by tools/sharp_lag/inline_core.js; do not edit here
(globalThis as any).SHARP_LAG_IDENTITY = {"nba":{"1":["Atlanta Hawks"],"2":["Boston Celtics"],"3":["New Orleans Pelicans"],"4":["Chicago Bulls"],"5":["Cleveland Cavaliers"],"6":["Dallas Mavericks"],"7":["Denver Nuggets"],"8":["Detroit Pistons"],"9":["Golden State Warriors"],"10":["Houston Rockets"],"11":["Indiana Pacers"],"12":["LA Clippers","Los Angeles Clippers"],"13":["Los Angeles Lakers","LA Lakers"],"14":["Miami Heat"],"15":["Milwaukee Bucks"],"16":["Minnesota Timberwolves"],"17":["Brooklyn Nets"],"18":["New York Knicks"],"19":["Orlando Magic"],"20":["Philadelphia 76ers"],"21":["Phoenix Suns"],"22":["Portland Trail Blazers"],"23":["Sacramento Kings"],"24":["San Antonio Spurs"],"25":["Oklahoma City Thunder"],"26":["Utah Jazz"],"27":["Washington Wizards"],"28":["Toronto Raptors"],"29":["Memphis Grizzlies"],"30":["Charlotte Hornets"]},"nhl":{"ANA":["Anaheim Ducks","Anaheim"],"BOS":["Boston Bruins","Boston"],"BUF":["Buffalo Sabres","Buffalo"],"CAR":["Carolina Hurricanes","Carolina"],"CBJ":["Columbus Blue Jackets","Columbus"],"CGY":["Calgary Flames","Calgary"],"CHI":["Chicago Blackhawks","Chicago"],"COL":["Colorado Avalanche","Colorado"],"DAL":["Dallas Stars","Dallas"],"DET":["Detroit Red Wings","Detroit"],"EDM":["Edmonton Oilers","Edmonton"],"FLA":["Florida Panthers","Florida"],"LAK":["Los Angeles Kings","Los Angeles","LA Kings"],"MIN":["Minnesota Wild","Minnesota"],"MTL":["Montréal Canadiens","Montreal Canadiens","Montréal","Montreal"],"NJD":["New Jersey Devils","New Jersey"],"NSH":["Nashville Predators","Nashville"],"NYI":["New York Islanders","NY Islanders"],"NYR":["New York Rangers","NY Rangers"],"OTT":["Ottawa Senators","Ottawa"],"PHI":["Philadelphia Flyers","Philadelphia"],"PIT":["Pittsburgh Penguins","Pittsburgh"],"SEA":["Seattle Kraken","Seattle"],"SJS":["San Jose Sharks","San Jose"],"STL":["St. Louis Blues","St Louis Blues","St. Louis","St Louis"],"TBL":["Tampa Bay Lightning","Tampa Bay"],"TOR":["Toronto Maple Leafs","Toronto"],"UTA":["Utah Mammoth","Utah Hockey Club","Utah HC","Utah"],"VAN":["Vancouver Canucks","Vancouver"],"VGK":["Vegas Golden Knights","Vegas"],"WPG":["Winnipeg Jets","Winnipeg"],"WSH":["Washington Capitals","Washington"]}};
// ── END SHARP LAG IDENTITY ──

type Any = any;
const SL: Any = (globalThis as Any).EDSharpLag;
const env = (k: string): string => ((globalThis as Any).Deno?.env.get(k) ?? "");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const iso = (t: number) => new Date(t).toISOString();
const enc = encodeURIComponent;
function deadline(t: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(t); } catch { return undefined; } }
const INPUTS_URL = "https://edgedesksports.com/nba/roster_inputs.json";
const ROLE_SHIFT_URL = "https://edgedesksports.com/nba/role_shift.json";
const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=";
const SPORT = { nba: "basketball_nba", nhl: "icehockey_nhl" };

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
async function db(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init?.headers as Any) ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) { const e: Any = new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300)); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function dbAll(path: string, pages = 20): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < pages; p++) {
    const rows = (await db(path + "&limit=1000&offset=" + p * 1000)) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
/* append-only writes: a row already there is left alone, never rewritten */
const insertOnce = (table: string, rows: Any[], key: string) => rows.length
  ? db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=ignore-duplicates" } })
  : null;
const insert = (table: string, rows: Any[]) => rows.length ? db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal" } }) : null;
const inList = (xs: Any[]) => "(" + xs.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(",") + ")";
async function chunks(rows: Any[], n: number, fn: (c: Any[]) => Promise<Any>) { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); }

async function setting(key: string): Promise<string | null> {
  const r = await db("sharp_lag_config?select=value&key=eq." + enc(key));
  return r && r[0] ? String(r[0].value) : null;
}

/* ---------------------------------------------------------------- identity (NBA, NHL) */
const IDX: Any = { nba: null, nhl: null };
function idx(lg: string) { if (!IDX[lg]) IDX[lg] = SL.nameIndex(((globalThis as Any).SHARP_LAG_IDENTITY || {})[lg] || {}); return IDX[lg]; }
/* the provider event for a league game: both clubs by name, a start within 6 h */
async function eventFor(lg: string, home: string, away: string, startIso: string, ctx: Any) {
  const key = lg + "|" + home + "|" + away + "|" + startIso;
  if (key in ctx.eventCache) return ctx.eventCache[key];
  const t = Date.parse(startIso);
  const evs = await dbAll("odds_api_events?select=event_id,sport_key,commence_time,home_team,away_team&sport_key=eq." + SPORT[lg]
    + "&commence_time=gte." + enc(iso(t - 6 * 3600e3)) + "&commence_time=lte." + enc(iso(t + 6 * 3600e3)) + "&order=commence_time.asc");
  const names: Any = (globalThis as Any).SHARP_LAG_IDENTITY[lg] || {};
  const hit = SL.matchEvent({ home: String(home), away: String(away), start: startIso }, evs.map((e: Any) => ({ ...e, id: e.event_id })), idx(lg));
  return (ctx.eventCache[key] = hit ? { event_id: hit.event_id, home_team: hit.home_team, away_team: hit.away_team, commence_time: hit.commence_time, names: [names[home], names[away]] } : null);
}

/* ================================================================ 1 INGEST */
const MAIN = ["h2h", "spreads", "totals"];
const PROPS = ["player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"];
async function ingest(ctx: Any) {
  const since = iso(ctx.nowMs - 6 * 3600e3);
  const snaps = await dbAll("odds_api_snapshots?select=fingerprint,category,sport_key,event_id,odds_format,last_request_id,last_success_at,body"
    + "&category=in.(featured,close,sharp_check,nba_role_props)&last_success_at=gte." + enc(since) + "&order=last_success_at.asc");
  const ids = snaps.map((s: Any) => s.last_request_id).filter((x: Any) => x != null);
  const done = new Set<string>();
  await chunks(ids, 100, async (c) => {
    (await dbAll("sharp_price_snapshots?select=source_request_id&source_request_id=in." + inList(c))).forEach((r: Any) => done.add(String(r.source_request_id)));
  });
  let read = 0, rowsOut = 0;
  for (const s of snaps) {
    if (!s.body || s.last_request_id == null || done.has(String(s.last_request_id))) continue;
    const props = s.category === "nba_role_props";
    let want: Any = null;
    if (props) {
      /* only the teammates a role shift on this event named: its own pull and its close check alike */
      const reqs = await dbAll("sharp_check_requests?select=trigger_id&category=eq.nba_role_props&event_id=eq." + enc(s.event_id) + "&trigger_id=not.is.null");
      const ids = [...new Set(reqs.map((r: Any) => r.trigger_id))];
      const trigs = ids.length ? await dbAll("sharp_triggers?select=detail&trigger_type=eq.role_shift&id=in." + inList(ids)) : [];
      const names = new Set<string>();
      trigs.forEach((t: Any) => (((t.detail || {}).teammates) || []).forEach((p: Any) => names.add(SL.normName(p.name))));
      want = (n: string) => names.has(SL.normName(n));
    }
    const rows = SL.quotesFromOdds(s.body, { books: props ? SL.PROP_BOOKS : ["pinnacle", "draftkings"], markets: props ? PROPS : MAIN,
      format: s.odds_format, sport_key: s.sport_key, participants: want })
      .filter((r: Any) => !props || r.participant);
    const out = rows.map((r: Any) => ({ captured_at: s.last_success_at, source: "odds_api", source_request_id: s.last_request_id, source_category: s.category,
      odds_format: s.odds_format || null, sport_key: r.sport_key || s.sport_key, event_id: r.event_id, home_team: r.home_team, away_team: r.away_team,
      commence_time: r.commence_time, book: r.book, book_last_update: r.book_last_update, market: r.market, side: r.side,
      participant: r.participant, point: r.point, price_dec: r.price_dec }));
    if (!ctx.dry) await chunks(out, 500, (c) => insertOnce("sharp_price_snapshots", c, "source_request_id,event_id,book,market,side,participant_key,point_key"));
    read++; rowsOut += out.length;
  }
  ctx.out.ingest = { snapshots_seen: snaps.length, snapshots_read: read, price_rows: rowsOut };
}

/* ================================================================ 2 TRIGGERS */
async function triggers(ctx: Any) {
  const mode = (await setting("dispatch")) === "live" ? "live" : "shadow";
  const fresh = ctx.nowMs - 30 * 60000;     // a change older than this was a previous run's
  const horizon = iso(ctx.nowMs + SL.RULES.check_window_hours * 3600e3);
  const rows: Any[] = [];
  const stats: Any = { mode };

  /* Kalshi: consecutive two-sided snapshots of a linked market, mid moved 3c+ */
  try {
    const links = await dbAll("kalshi_game_links?select=market_ticker,yes_team,odds_event_id,odds_sport_key,game_id,home_team,away_team,kickoff_at"
      + "&kickoff_at=gt." + enc(iso(ctx.nowMs)) + "&kickoff_at=lte." + enc(horizon));
    const byTicker: Any = {}; links.forEach((l: Any) => { byTicker[l.market_ticker] = l; });
    const tickers = Object.keys(byTicker);
    const snaps: Any[] = [];
    await chunks(tickers, 50, async (c) => { snaps.push(...await dbAll("kalshi_price_snapshots?select=id,ticker,captured_at,yes_bid,yes_ask&ticker=in." + inList(c)
      + "&captured_at=gte." + enc(iso(ctx.nowMs - 45 * 60000)) + "&order=captured_at.asc")); });
    const per: Any = {}; snaps.forEach((s) => { (per[s.ticker] = per[s.ticker] || []).push(s); });
    let n = 0;
    Object.keys(per).forEach((t) => SL.kalshiMoves(per[t]).forEach((m: Any) => {
      if (Date.parse(m.at) < fresh) return;
      const l = byTicker[t];
      n++;
      rows.push({ trigger_type: "kalshi_move", sport_key: l.odds_sport_key, league_game_id: l.game_id, event_id: l.odds_event_id,
        home_team: l.home_team, away_team: l.away_team, commence_time: l.kickoff_at, mode, dedupe_key: "kalshi_move|" + m.to_snapshot_id,
        detail: { ticker: t, yes_team: l.yes_team, from_mid: m.from_mid, to_mid: m.to_mid, move: m.move, at: m.at, from_snapshot_id: m.from_snapshot_id, to_snapshot_id: m.to_snapshot_id } });
    }));
    stats.kalshi_moves = n;
  } catch (e) { ctx.warn("kalshi_triggers", msg(e)); }

  /* NBA: a starter (top five of the reference rotation) on two consecutive reports */
  try {
    const inputs = await fetchJson(env("NBA_INPUTS_URL") || INPUTS_URL);
    const games = ((inputs && inputs.games) || []).filter((g: Any) => Date.parse(g.start_utc) > ctx.nowMs && Date.parse(g.start_utc) <= Date.parse(horizon));
    const reports = await dbAll("nba_injury_reports?select=id,captured_at,matchups&captured_at=gte." + enc(iso(ctx.nowMs - 36 * 3600e3)) + "&order=captured_at.asc");
    let n = 0;
    let rs = 0; const rsSkip: Any = {};
    if (games.length && reports.length > 1) {
      const recent = reports.slice(-6);
      const snap = await dbAll("nba_injury_report_snapshots?select=report_id,game_id,player_id,status&report_id=in." + inList(recent.map((r: Any) => r.id)));
      const st: Any = {}; snap.forEach((s: Any) => { if (!s.player_id) return; const k = s.report_id + "|" + s.game_id; (st[k] = st[k] || {})[s.player_id] = s.status; });
      const covers = (r: Any, gid: string) => (r.matchups || []).some((m: Any) => String(m.game_id) === String(gid));
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1], cur = recent[i];
        if (Date.parse(cur.captured_at) < fresh) continue;
        for (const g of games) {
          if (!covers(prev, g.game_id) || !covers(cur, g.game_id)) continue;
          const starters = ["home", "away"].flatMap((side) => SL.topByMinutes(((g.reference || {})[side]) || [], 5).map((p: Any) => ({ id: p.id, name: p.name, team_id: g[side].id })));
          const ch = SL.statusChanges(st[prev.id + "|" + g.game_id] || {}, st[cur.id + "|" + g.game_id] || {}, starters);
          for (const c of ch) {
            const ev = await eventFor("nba", String(g.home.id), String(g.away.id), g.start_utc, ctx);
            n++;
            rows.push({ trigger_type: "nba_injury", sport_key: SPORT.nba, league_game_id: String(g.game_id), event_id: ev ? ev.event_id : null,
              home_team: ev ? ev.home_team : g.home.name, away_team: ev ? ev.away_team : g.away.name, commence_time: ev ? ev.commence_time : g.start_utc, mode,
              dedupe_key: "nba_injury|" + cur.id + "|" + g.game_id + "|" + c.player_id,
              detail: { report_id: cur.id, previous_report_id: prev.id, player_id: c.player_id, player_name: c.player_name, team_id: c.team_id, from: c.from, to: c.to } });
          }
          /* a role shift: a top-8 rotation player to OUT or DOUBTFUL switches the game to his scenario */
          const rotation = ["home", "away"].flatMap((side) => SL.topByMinutes(((g.reference || {})[side]) || [], SL.ROLE_SHIFT.rotation).map((p: Any) => ({ id: p.id, name: p.name, team_id: g[side].id })));
          for (const c of SL.roleShiftChanges(st[prev.id + "|" + g.game_id] || {}, st[cur.id + "|" + g.game_id] || {}, rotation)) {
            const file = await roleShiftFile(ctx);
            const sc = file ? SL.roleShiftScenario(file, g.game_id, c.player_id) : null;
            if (!sc) { rsSkip.no_scenario = (rsSkip.no_scenario || 0) + 1; continue; }
            if (sc.skipped) { rsSkip.default_already_without_him = (rsSkip.default_already_without_him || 0) + 1; continue; }
            if (!(sc.teammates || []).some((t: Any) => t.priced)) { rsSkip.no_teammate_absorbs = (rsSkip.no_teammate_absorbs || 0) + 1; continue; }
            const ev = await eventFor("nba", String(g.home.id), String(g.away.id), g.start_utc, ctx);
            rs++;
            rows.push({ trigger_type: "role_shift", sport_key: SPORT.nba, league_game_id: String(g.game_id), event_id: ev ? ev.event_id : null,
              home_team: ev ? ev.home_team : g.home.name, away_team: ev ? ev.away_team : g.away.name, commence_time: ev ? ev.commence_time : g.start_utc, mode,
              dedupe_key: "role_shift|" + g.game_id + "|" + c.player_id,
              detail: SL.roleShiftDetail(file, sc, c, { id: cur.id, previous_id: prev.id, captured_at: cur.captured_at }) });
          }
        }
      }
    }
    stats.nba_status_changes = n;
    stats.role_shifts = rs; stats.role_shift_skipped = rsSkip;
  } catch (e) { ctx.warn("nba_triggers", msg(e)); }

  /* NHL: the consensus starter of one club changed goalie or status */
  try {
    const st = await dbAll("nhl_goalie_starters?select=id,game_id,game_start_utc,team,side,goalie_id,goalie_name,status,fetched_at&source=eq.consensus"
      + "&game_start_utc=gt." + enc(iso(ctx.nowMs)) + "&game_start_utc=lte." + enc(horizon) + "&order=fetched_at.asc");
    const per: Any = {}, teams: Any = {};
    st.forEach((r: Any) => { (per[r.game_id + "|" + r.team] = per[r.game_id + "|" + r.team] || []).push(r); (teams[r.game_id] = teams[r.game_id] || {})[r.side] = r.team; });
    let n = 0;
    for (const k of Object.keys(per)) {
      for (const c of SL.goalieChanges(per[k])) {
        if (Date.parse(c.at) < fresh) continue;
        const g = teams[c.game_id] || {}, start = per[k][0].game_start_utc;
        const ev = g.home && g.away ? await eventFor("nhl", g.home, g.away, start, ctx) : null;
        n++;
        rows.push({ trigger_type: "nhl_goalie", sport_key: SPORT.nhl, league_game_id: String(c.game_id), event_id: ev ? ev.event_id : null,
          home_team: ev ? ev.home_team : g.home || null, away_team: ev ? ev.away_team : g.away || null, commence_time: ev ? ev.commence_time : start, mode,
          dedupe_key: "nhl_goalie|" + c.row_id, detail: { team: c.team, side: c.side, from: c.from, to: c.to, row_id: c.row_id } });
      }
    }
    stats.nhl_goalie_changes = n;
  } catch (e) { ctx.warn("nhl_triggers", msg(e)); }

  if (!ctx.dry) await chunks(rows, 200, (c) => insertOnce("sharp_triggers", c, "dedupe_key"));
  ctx.out.triggers = Object.assign(stats, { recorded: rows.length });
}
async function fetchJson(url: string): Promise<Any> {
  const r = await fetch(url, { signal: deadline(15000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(url + " answered " + r.status);
  return await r.json();
}
/* the build's role-shift scenarios, read once a run; too old (the build runs every 3 hours) and they are not used */
async function roleShiftFile(ctx: Any) {
  if (ctx.roleShift !== undefined) return ctx.roleShift;
  ctx.roleShift = null;
  try {
    const f = await fetchJson(env("NBA_ROLE_SHIFT_URL") || ROLE_SHIFT_URL);
    if (!f || f.schema !== "edgedesk_nba_role_shift_v1") ctx.warn("role_shift_file", "nba/role_shift.json is not edgedesk_nba_role_shift_v1: no role shift is switched on");
    else if (!(ctx.nowMs - Date.parse(f.generated_at) <= SL.ROLE_SHIFT.max_age_h * 3600e3)) ctx.warn("role_shift_stale", "nba/role_shift.json was built " + f.generated_at + " (over " + SL.ROLE_SHIFT.max_age_h + " h): no role shift is switched on from it");
    else ctx.roleShift = f;
  } catch (e) { ctx.warn("role_shift_file", msg(e)); }
  return ctx.roleShift;
}

/* ================================================================ 3 FLAGS */
/* the observations of one event, one per gateway request: { observed_at, request_id, category, rows } */
function observations(rows: Any[], book: string) {
  const by: Any = {};
  rows.filter((r) => r.book === book).forEach((r) => {
    const k = String(r.source_request_id);
    (by[k] = by[k] || { observed_at: r.captured_at, request_id: r.source_request_id, category: r.source_category, rows: [] }).rows.push(r);
  });
  return Object.values(by).sort((a: Any, b: Any) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
}
function withResolution(list: Any[], startIso: string) {
  return list.map((o: Any, i: number) => Object.assign({}, o, { resolution_s: i ? Math.round((Date.parse(o.observed_at) - Date.parse(list[i - 1].observed_at)) / 1000)
    : SL.nominalResolution("board", (Date.parse(startIso) - Date.parse(o.observed_at)) / 3600e3) }));
}
async function feeRow(ctx: Any) {
  if (ctx.fee !== undefined) return ctx.fee;
  ctx.fee = null;
  try {
    const rows = await db("market_execution_costs?select=*&venue=eq.kalshi");
    const now = ctx.nowMs;
    ctx.fee = (rows || []).find((r: Any) => r.verified_at && r.taker_coefficient != null
      && (!r.effective_from || Date.parse(r.effective_from) <= now) && (!r.effective_to || Date.parse(r.effective_to) > now)
      && (!r.category || /sport/i.test(String(r.category)))) || null;
  } catch { ctx.fee = null; }   // the table is absent: every Kalshi flag is fee_unverified
  return ctx.fee;
}
async function eventHistory(eventId: string, sinceMs: number, ctx: Any) {
  return await dbAll("sharp_price_snapshots?select=captured_at,source_request_id,source_category,sport_key,event_id,home_team,away_team,commence_time,book,market,side,participant,point,price_dec"
    + "&event_id=eq." + enc(eventId) + "&book=in.(pinnacle,draftkings)&captured_at=gte." + enc(iso(sinceMs)) + "&order=captured_at.asc", 10);
}
async function kalshiFor(eventId: string, sinceMs: number) {
  const links = await dbAll("kalshi_game_links?select=market_ticker,yes_team&odds_event_id=eq." + enc(eventId));
  if (!links.length) return { links, snaps: {} };
  const snaps = await dbAll("kalshi_price_snapshots?select=id,ticker,captured_at,yes_bid,yes_ask&ticker=in." + inList(links.map((l: Any) => l.market_ticker))
    + "&captured_at=gte." + enc(iso(sinceMs)) + "&order=captured_at.asc");
  const by: Any = {}; snaps.forEach((s: Any) => { (by[s.ticker] = by[s.ticker] || []).push(s); });
  return { links, snaps: by };
}
async function triggerFor(requestId: Any, category: string, ctx: Any) {
  if (category !== "sharp_check" || requestId == null) return { type: "scheduled", id: null };
  const k = String(requestId);
  if (k in ctx.trigCache) return ctx.trigCache[k];
  const req = await db("sharp_check_requests?select=trigger_id&gateway_request_id=eq." + requestId + "&trigger_id=not.is.null&order=id.asc&limit=1");
  let t: Any = { type: "scheduled", id: null };
  if (req && req[0]) {
    const tr = await db("sharp_triggers?select=id,trigger_type&id=eq." + req[0].trigger_id);
    if (tr && tr[0]) t = { type: tr[0].trigger_type, id: tr[0].id };
  }
  return (ctx.trigCache[k] = t);
}
async function flags(ctx: Any) {
  if ((await setting("flags")) === "off") { ctx.out.flags = { skipped: "flags are switched off (sharp_lag_config.flags)" }; return; }
  const R = SL.RULES;
  const fresh = await dbAll("sharp_price_snapshots?select=event_id&book=eq.pinnacle&source_category=in.(featured,close,sharp_check)"
    + "&captured_at=gte." + enc(iso(ctx.nowMs - R.reference_max_age_min * 60000)) + "&commence_time=gt." + enc(iso(ctx.nowMs)));
  const events = [...new Set(fresh.map((r: Any) => r.event_id))];
  const fee = await feeRow(ctx);
  const tally: Any = { events: events.length, considered: 0, written: 0, skipped: {} };
  for (const eventId of events) {
    try {
      const hist = await eventHistory(eventId as string, ctx.nowMs - 26 * 3600e3, ctx);
      if (!hist.length) continue;
      const start = hist[0].commence_time;
      const pin = withResolution(observations(hist, "pinnacle"), start), dk = withResolution(observations(hist, "draftkings"), start);
      if (!pin.length) continue;
      const P: Any = pin[pin.length - 1], D: Any = dk.length ? dk[dk.length - 1] : null;
      const any = hist[0];
      const event = { event_id: eventId, sport_key: any.sport_key, home_team: any.home_team, away_team: any.away_team, commence_time: any.commence_time };
      /* the episodes still open on this event: a flag whose gap has not converged since */
      const prior = await dbAll("sharp_flags?select=flag_id,flagged_at,event_id,market,side,participant,point,target_venue,target_ref,fee_unverified,commence_time,episode_key"
        + "&event_id=eq." + enc(eventId as string) + "&model_key=eq.SHARP-LAG&order=flagged_at.asc");
      const earliest = prior.length ? Date.parse(prior[0].flagged_at) : ctx.nowMs - 30 * 60000;
      const K = await kalshiFor(eventId as string, Math.min(earliest, ctx.nowMs - 30 * 60000));
      const lastBy: Any = {};
      prior.forEach((f: Any) => { lastBy[SL.baseKey(f.event_id, f.target_venue, SL.sideKey(f))] = f; });
      const open = (bk: string) => {
        const f = lastBy[bk]; if (!f) return false;
        const target = f.target_venue === "kalshi" ? (K.snaps[f.target_ref] || []).map((s: Any) => s) : dk;
        return !SL.convergence(f, { reference: pin, target, fee, until: iso(ctx.nowMs) }).converged;
      };
      const kal = K.links.map((l: Any) => {
        const s = K.snaps[l.market_ticker] || [];
        const last = s[s.length - 1], prev = s[s.length - 2];
        return { ticker: l.market_ticker, yes_team: l.yes_team, snapshot: last || null,
          resolution_s: last && prev ? Math.round((Date.parse(last.captured_at) - Date.parse(prev.captured_at)) / 1000) : SL.nominalResolution("kalshi") };
      });
      const trig = await triggerFor(P.request_id, P.category, ctx);
      const r = SL.evaluate({ now: iso(ctx.nowMs), event, pinnacle: P, draftkings: D, kalshi: kal, fee, trigger: trig, open });
      tally.considered += r.considered;
      Object.keys(r.skipped).forEach((k) => { tally.skipped[k] = (tally.skipped[k] || 0) + r.skipped[k]; });
      const rows = r.flags.map((f: Any) => { const o = Object.assign({}, f); delete o.target_ref_at; return o; });
      if (!ctx.dry && rows.length) await insertOnce("sharp_flags", rows, "episode_key");
      tally.written += rows.length;
    } catch (e) { ctx.warn("flags:" + eventId, msg(e)); }
  }
  ctx.out.flags = tally;
  try { ctx.out.flags.role_shift = await roleShiftFlags(ctx); } catch (e) { ctx.warn("role_shift_flags", msg(e)); }
}

/* every role-shift pull of the last 6 hours, against its own trigger's scenario: one flag per player, market and side */
async function roleShiftFlags(ctx: Any) {
  const tally: Any = { pulls: 0, considered: 0, written: 0, skipped: {} };
  const skip = (k: string) => { tally.skipped[k] = (tally.skipped[k] || 0) + 1; };
  const reqs = await dbAll("sharp_check_requests?select=id,trigger_id,gateway_request_id,event_id,requested_at&purpose=eq.role_shift&trigger_id=not.is.null"
    + "&gateway_request_id=not.is.null&requested_at=gte." + enc(iso(ctx.nowMs - 6 * 3600e3)) + "&order=requested_at.asc");
  for (const q of reqs) {
    try {
      const rows = await dbAll("sharp_price_snapshots?select=captured_at,source_request_id,sport_key,event_id,home_team,away_team,commence_time,book,market,side,participant,point,price_dec"
        + "&source_request_id=eq." + q.gateway_request_id + "&event_id=eq." + enc(q.event_id), 10);
      if (!rows.length) { skip("pull_not_ingested"); continue; }
      const tr = await db("sharp_triggers?select=id,detected_at,detail&trigger_type=eq.role_shift&id=eq." + q.trigger_id);
      if (!tr || !tr[0]) { skip("no_trigger"); continue; }
      tally.pulls++;
      const any = rows[0], detail = tr[0].detail || {};
      const event = { event_id: q.event_id, sport_key: any.sport_key, home_team: any.home_team, away_team: any.away_team, commence_time: any.commence_time };
      const seen = new Set((await dbAll("sharp_flags?select=episode_key&model_key=eq.NBA-ROLE-SHIFT&event_id=eq." + enc(q.event_id))).map((f: Any) => f.episode_key));
      /* the lag can be measured only to this: the report, then the one pull that priced it */
      const reportAt = Date.parse(detail.report_captured_at || tr[0].detected_at);
      const r = SL.evaluateRoleShift({ now: iso(ctx.nowMs), event, trigger: { id: tr[0].id, detail }, rows, observed_at: any.captured_at, request_id: q.gateway_request_id,
        resolution_s: isFinite(reportAt) ? Math.max(0, Math.round((Date.parse(any.captured_at) - reportAt) / 1000)) : null, open: (k: string) => seen.has(k) });
      tally.considered += r.considered;
      Object.keys(r.skipped).forEach((k) => { tally.skipped[k] = (tally.skipped[k] || 0) + r.skipped[k]; });
      if (!ctx.dry && r.flags.length) await insertOnce("sharp_flags", r.flags, "episode_key");
      tally.written += r.flags.length;
    } catch (e) { ctx.warn("role_shift_flags:" + q.id, msg(e)); }
  }
  return tally;
}

/* ================================================================ 4 GRADES */
async function grades(ctx: Any) {
  const ref = await setting("registry_ref:SHARP-LAG");
  if (!ref) { ctx.warn("not_registered", "SHARP-LAG is not in the research registry (apply supabase/sharp_lag_registry.sql): no flag is graded before it is"); ctx.out.grades = { graded: 0, registered: false }; return; }
  const due = await dbAll("sharp_lag_rows?select=*&model_key=eq.SHARP-LAG&close_status=is.null&commence_time=lte." + enc(iso(ctx.nowMs - 10 * 60000)) + "&order=commence_time.asc", 2);
  const fee = await feeRow(ctx);
  let n = 0, noClose = 0;
  for (const f of due) {
    try {
      const start = Date.parse(f.commence_time);
      const hist = await dbAll("sharp_price_snapshots?select=captured_at,source_request_id,source_category,book,market,side,participant,point,price_dec"
        + "&event_id=eq." + enc(f.event_id) + "&book=in.(pinnacle,draftkings)&captured_at=gte." + enc(iso(start - 30 * 3600e3)) + "&captured_at=lte." + enc(f.commence_time) + "&order=captured_at.asc", 10);
      const pin = observations(hist, "pinnacle");
      let target: Any[] = observations(hist, "draftkings");
      if (f.target_venue === "kalshi") {
        target = await dbAll("kalshi_price_snapshots?select=id,ticker,captured_at,yes_bid,yes_ask&ticker=eq." + enc(f.target_ref)
          + "&captured_at=gte." + enc(f.flagged_at) + "&captured_at=lte." + enc(f.commence_time) + "&order=captured_at.asc", 10);
      }
      const g = SL.grade(f, { reference: pin, target, fee, now: iso(ctx.nowMs) });
      const row = Object.assign({}, g, { flag_id: f.flag_id, model_key: "SHARP-LAG", registry_ref: ref, detail: { grader: BUILD } });
      if (!ctx.dry) await insertOnce("sharp_flag_grades", [row], "flag_id");
      n++; if (g.close_status === "no_close") noClose++;
    } catch (e) { ctx.warn("grade:" + f.flag_id, msg(e)); }
  }
  ctx.out.grades = { graded: n, no_close: noClose, registered: true };
}

/* role shifts: once the game has a final box score (or a day after the start without one), at the flag's own book and line */
async function roleShiftGrades(ctx: Any) {
  const ref = await setting("registry_ref:NBA-ROLE-SHIFT");
  if (!ref) { ctx.warn("role_shift_not_registered", "NBA-ROLE-SHIFT is not in the research registry (apply supabase/sharp_lag_registry.sql): no flag is graded before it is"); ctx.out.role_shift_grades = { graded: 0, registered: false }; return; }
  const due = await dbAll("sharp_lag_rows?select=*&model_key=eq.NBA-ROLE-SHIFT&close_status=is.null&commence_time=lte." + enc(iso(ctx.nowMs - 10 * 60000)) + "&order=commence_time.asc", 2);
  const boxes: Any = {};
  let n = 0, noClose = 0, waiting = 0;
  for (const f of due) {
    try {
      const start = Date.parse(f.commence_time);
      const fl = await db("sharp_flags?select=trigger_id&flag_id=eq." + f.flag_id);
      const tr = fl && fl[0] && fl[0].trigger_id != null ? await db("sharp_triggers?select=league_game_id&id=eq." + fl[0].trigger_id) : null;
      const gid = tr && tr[0] ? tr[0].league_game_id : null;
      if (gid && !(gid in boxes)) {
        try { boxes[gid] = SL.espnBox(await fetchJson((env("NBA_SUMMARY_URL") || SUMMARY_URL) + enc(gid))); } catch (e) { boxes[gid] = null; ctx.warn("box:" + gid, msg(e)); }
      }
      const box = gid ? boxes[gid] : null;
      if (!(box && box.final) && ctx.nowMs - start < 24 * 3600e3) { waiting++; continue; }
      const hist = await dbAll("sharp_price_snapshots?select=captured_at,source_request_id,source_category,book,market,side,participant,point,price_dec"
        + "&event_id=eq." + enc(f.event_id) + "&book=eq." + enc(f.target_venue) + "&market=eq." + enc(f.market)
        + "&captured_at=gte." + enc(iso(start - 30 * 3600e3)) + "&captured_at=lte." + enc(f.commence_time) + "&order=captured_at.asc", 10);
      const g = SL.gradeRoleShift(f, { observations: observations(hist, f.target_venue), box, now: iso(ctx.nowMs) });
      const row = Object.assign({}, g, { flag_id: f.flag_id, model_key: "NBA-ROLE-SHIFT", registry_ref: ref, detail: Object.assign({ grader: BUILD, league_game_id: gid }, g.detail) });
      if (!ctx.dry) await insertOnce("sharp_flag_grades", [row], "flag_id");
      n++; if (g.close_status === "no_close") noClose++;
    } catch (e) { ctx.warn("role_shift_grade:" + f.flag_id, msg(e)); }
  }
  ctx.out.role_shift_grades = { graded: n, no_close: noClose, waiting_for_box: waiting, registered: true };
}
async function allGrades(ctx: Any) { await grades(ctx); await roleShiftGrades(ctx); }

/* ================================================================ the run */
const STEPS: Any = { ingest, triggers, flags, grades: allGrades };
export async function runOnce(opts: Any = {}) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const dry = !!opts.dry;
  const steps: string[] = Array.isArray(opts.steps) && opts.steps.length ? opts.steps : Object.keys(STEPS);
  const warnings: Any[] = [];
  const ctx: Any = { nowMs, dry, out: {}, eventCache: {}, trigCache: {}, fee: undefined,
    warn: (code: string, message: string) => warnings.push({ code, message }) };
  const run: Any = { run_id: crypto.randomUUID(), fn: "sharp_lag", status: "ok", started_at: iso(nowMs) };
  const out: Any = { ok: true, build: BUILD, run_id: run.run_id, dry };
  try {
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this function");
    if (!SL) throw new Error("the inlined Sharp-lag core did not load");
    for (const s of steps) {
      if (!STEPS[s]) { ctx.warn("unknown_step", s); continue; }
      try { await STEPS[s](ctx); } catch (e) { ctx.warn(s, msg(e)); }
    }
    run.status = warnings.length ? "warn" : "ok";
  } catch (e) {
    run.status = "error"; run.message = msg(e);
  } finally {
    run.finished_at = iso(Math.max(Date.now(), nowMs));
    run.message = run.message || (warnings.map((w) => w.code + ": " + w.message).join("; ").slice(0, 600) || null);
    run.details = Object.assign({}, ctx.out, { warnings });
    Object.assign(out, ctx.out, { status: run.status, warnings, ok: run.status !== "error" });
    if (!dry) { try { await insert("sharp_lag_runs", [run]); } catch (e) { out.ok = false; out.record_error = msg(e); } }
    console.log("SHARP_LAG", JSON.stringify({ run_id: run.run_id, status: run.status, ingest: ctx.out.ingest || null, triggers: ctx.out.triggers || null,
      flags: ctx.out.flags ? { written: ctx.out.flags.written, events: ctx.out.flags.events } : null, grades: ctx.out.grades || null, warnings: warnings.map((w) => w.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: SL ? SL.VERSION : null });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("SHARP_LAG_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "SHARP_LAG_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const dry = !!body.dry;
  const out = await runOnce({ dry, now: dry ? body.now : undefined, steps: body.steps });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as Any).Deno !== "undefined" && (globalThis as Any).Deno.serve) (globalThis as Any).Deno.serve(handle);

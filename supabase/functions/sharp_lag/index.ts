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
//   2 triggers NBA starter status changes, NHL goalie changes, Kalshi moves
//              of 3c or more, recorded in the mode the dispatch switch is in
//              (shadow: nothing will be bought for them)
//   3 flags    every upcoming event with a Pinnacle observation under 90
//              minutes old, against DraftKings (same side, same point) and
//              the linked Kalshi markets (YES ask plus fee), 2.5 pp or more
//
// AUTH. pg_cron sends the Vault secret sharp_lag_cron_secret as
// x-cron-secret; it must equal SHARP_LAG_CRON_SECRET. A GET is a health probe.
// POST body (all optional): { dry, now (dry only), steps: ["ingest", ...] }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHARP_LAG_CRON_SECRET
//      NBA_INPUTS_URL (default https://edgedesksports.com/nba/roster_inputs.json)
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
async function ingest(ctx: Any) {
  const since = iso(ctx.nowMs - 6 * 3600e3);
  const snaps = await dbAll("odds_api_snapshots?select=fingerprint,category,sport_key,event_id,odds_format,last_request_id,last_success_at,body"
    + "&category=in.(featured,close,sharp_check)&last_success_at=gte." + enc(since) + "&order=last_success_at.asc");
  const ids = snaps.map((s: Any) => s.last_request_id).filter((x: Any) => x != null);
  const done = new Set<string>();
  await chunks(ids, 100, async (c) => {
    (await dbAll("sharp_price_snapshots?select=source_request_id&source_request_id=in." + inList(c))).forEach((r: Any) => done.add(String(r.source_request_id)));
  });
  let read = 0, rowsOut = 0;
  for (const s of snaps) {
    if (!s.body || s.last_request_id == null || done.has(String(s.last_request_id))) continue;
    const rows = SL.quotesFromOdds(s.body, { books: ["pinnacle", "draftkings"], markets: MAIN, format: s.odds_format, sport_key: s.sport_key });
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
        }
      }
    }
    stats.nba_status_changes = n;
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
}

/* ================================================================ the run */
const STEPS: Any = { ingest, triggers, flags };
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

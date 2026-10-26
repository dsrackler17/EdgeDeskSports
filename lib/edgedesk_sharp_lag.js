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

  return L;
}));

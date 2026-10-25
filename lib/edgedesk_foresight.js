/* ===========================================================================
   EDGEDESK MARKET FORESIGHT — which forecasts and which observed venues
   preceded subsequent market movement, and how sure the records let us be.
   research/foresight/methodology/mf-v1.json (frozen first),
   docs/market-foresight/METHODOLOGY.md

   Pure and deterministic. It takes records EdgeDesk already stores (the
   forecast ledgers, the Collective's projections, the DraftKings quote
   ledger, Kalshi snapshots) and returns measurements. It reads no clock (the
   caller passes `now`), no network and no file, so the same records and the
   same methodology give the same results, keys and hashes, byte for byte.

   WHAT IT WILL SAY, AND WHAT IT NEVER SAYS
     - "Forecast preceded observed movement" only when an observation AFTER
       publication still showed the unmoved market;
     - "First observed among tracked venues" only when two change intervals
       do not overlap; overlapping intervals are UNRESOLVED;
     - "Market moved toward this forecast" is a statement about prices, not
       about whether the forecast was right, and never about profit;
     - never that a model caused a move, nor who led the whole market.

   THE RULES THIS FILE KEEPS
     - a change happened in (last observation of the old value, first
       observation of the new value]; that interval is never narrowed;
     - a missing observation is unknown: nothing is carried across a gap;
     - two numbers are compared only inside one measure (line points or a
       probability of one exactly matched contract), never across;
     - a probability is compared with another only when overtime and tie
       treatment are compatible and the venue's profile is verified;
     - the unit is the FIRST eligible published forecast per model version,
       event, market and venue; revisions are shown, never substituted;
     - eligibility is decided on the forecast side; a unit whose market
       evidence is missing is excluded with its reason, never swapped.

   Browser: window.EDForesight. Node: require('./edgedesk_foresight.js').
   ES5, no dependencies beyond lib/edgedesk_calc.js (rounding, no-vig,
   canonical JSON and the fingerprint).
   =========================================================================== */
(function (root, factory) {
  var calc = (typeof module === 'object' && module.exports) ? require('./edgedesk_calc.js') : root.EDCalc;
  var api = factory(calc);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDForesight = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (C) {
  'use strict';
  if (!C) throw new Error('edgedesk_foresight needs lib/edgedesk_calc.js loaded first');

  var E = { VERSION: 'edgedesk_foresight/1', SCHEMA: 'edgedesk_foresight_v1' };
  var MIN = 60000, EPS = 1e-9;
  E.MARKETS = ['spread', 'total', 'moneyline'];
  E.VENUES = { spread: ['draftkings'], total: ['draftkings'], moneyline: ['draftkings', 'kalshi'] };
  E.MEASURE = { spread: 'line_points', total: 'line_points', moneyline: 'probability' };

  /* ================================================================ helpers */
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function iso(t) { var x = ms(t); return x === null ? null : new Date(x).toISOString(); }
  function rnd(x, dp) { return isNum(x) ? C.round(x, dp) : null; }
  function sgn(x) { return x > EPS ? 1 : (x < -EPS ? -1 : 0); }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function lower(x) { return str(x).toLowerCase(); }
  function dpOf(market) { return market === 'moneyline' ? 4 : 2; }
  function mins(a, b) { return rnd((a - b) / MIN, 1); }
  function sum(xs) { var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i]; return s; }
  function mean(xs) { return xs.length ? sum(xs) / xs.length : null; }
  E.num = num; E.ms = ms; E.iso = iso;

  /* ================================================================ the methodology, as numbers */
  E.rules = function (M) {
    if (!M || M.schema !== 'edgedesk_market_foresight_methodology_v1' || !M.version) throw new Error('not a Market Foresight methodology');
    var dk = M.timing.expected_max_gap_minutes.draftkings, ks = M.timing.expected_max_gap_minutes.kalshi;
    var wr = M.sources.venues.draftkings.write_rule;
    return {
      version: M.version,
      sports: M.scope.sports.slice(),
      threshold: M.movement.threshold,
      minDis: M.movement.min_disagreement,
      horizons: M.movement.horizons_minutes.slice(),
      buckets: M.movement.forecast_horizon_buckets_hours.slice(),
      dk: { heartbeat: wr.heartbeat_hours * 60, zoneHeartbeat: wr.close_zone_heartbeat_minutes, zoneHours: wr.close_zone_hours,
        allowFar: dk.far - wr.heartbeat_hours * 60, allowZone: dk.close_zone - wr.close_zone_heartbeat_minutes, far: dk.far, zone: dk.close_zone },
      kalshiGap: ks.all,
      closeMax: { draftkings: M.freshness.close.draftkings_max_minutes_before_kickoff, kalshi: M.freshness.close.kalshi_max_minutes_before_kickoff },
      overround: M.prices.sportsbook_devig.overround_bounds.slice(),
      kalshiMaxSpread: M.prices.kalshi.max_spread,
      eligibleEvidence: { edgedesk: M.sources.forecasts.edgedesk.eligible_evidence.slice(), collective: M.sources.forecasts.collective.eligible_evidence.slice() },
      lockMinutes: M.sources.forecasts.collective.lock_minutes,
      ranges: M.selection.value_ranges,
      settlement: M.contracts.settlement,
      leadLag: { threshold: M.lead_lag.threshold, follow: M.lead_lag.follow_window_minutes, buckets: M.lead_lag.buckets_hours_before_start.slice(),
        minPairs: M.lead_lag.label.min_resolved_pairs },
      consensus: { offsets: M.consensus.evaluation_offsets_minutes_before_kickoff.slice(), min: M.consensus.min_contributors },
      stats: { level: M.statistics.interval_level, B: M.statistics.bootstrap_resamples, minInterval: M.statistics.min_n_for_interval,
        minSummary: M.statistics.min_n_for_summary },
      inc: { lookback: M.incremental_information.recent_movement_lookback_minutes, trainShare: M.incremental_information.train_share,
        minTrain: M.incremental_information.min_train_units, minHoldout: M.incremental_information.min_holdout_units }
    };
  };

  /* ================================================================ prices */
  /* multiplicative two-way no-vig, refused (with the reason) rather than
     guessed when a side is missing or the overround is implausible */
  E.devig = function (aAm, bAm, bounds) {
    if (num(aAm) === null || num(bAm) === null) return { flag: 'one_sided_price' };
    var nv = C.noVigTwoWay(num(aAm), num(bAm));
    if (!nv) return { flag: 'invalid_price' };
    if (nv.overround < bounds[0] - EPS || nv.overround > bounds[1] + EPS) return { flag: 'implausible_overround', overround: nv.overround };
    return { a: nv.a, b: nv.b, overround: nv.overround };
  };

  /* one DraftKings quote-ledger row -> one observation of its market. The
     comparable value is the line (spread, total) or the de-vigged P(home)
     (moneyline). A spread or total also carries the de-vigged probability
     of its OWN threshold contract, labelled with that threshold. */
  E.dkObservation = function (row, R) {
    var mk = row.market_type;
    var o = { venue: 'draftkings', sport: lower(row.sport), event_id: str(row.game_id), market: mk, at: ms(row.observed_at),
      value: null, quote_type: null, flag: null, source_id: row.quote_id || null, raw: null, contract: null };
    if (mk === 'spread') {
      o.quote_type = 'line';
      o.raw = { home_line: num(row.home_line), price_home: num(row.price_home), price_away: num(row.price_away) };
      o.value = o.raw.home_line;
      if (o.value === null) o.flag = 'line_missing';
      var d = E.devig(row.price_home, row.price_away, R.overround);
      o.contract = d.flag ? { kind: 'home_cover', threshold: o.value, flag: d.flag }
        : { kind: 'home_cover', threshold: o.value, p: rnd(d.a, 4), overround: rnd(d.overround, 4) };
    } else if (mk === 'total') {
      o.quote_type = 'line';
      o.raw = { total_points: num(row.total_points), price_over: num(row.price_over), price_under: num(row.price_under) };
      o.value = o.raw.total_points;
      if (o.value === null) o.flag = 'line_missing';
      var t = E.devig(row.price_over, row.price_under, R.overround);
      o.contract = t.flag ? { kind: 'over', threshold: o.value, flag: t.flag }
        : { kind: 'over', threshold: o.value, p: rnd(t.a, 4), overround: rnd(t.overround, 4) };
    } else if (mk === 'moneyline') {
      o.quote_type = 'devig_fair';
      o.raw = { price_home: num(row.price_home), price_away: num(row.price_away) };
      var m = E.devig(row.price_home, row.price_away, R.overround);
      if (m.flag) o.flag = m.flag; else { o.value = rnd(m.a, 6); o.raw.overround = rnd(m.overround, 4); }
    } else return null;
    return o;
  };

  /* one Kalshi snapshot of the HOME team's game-winner market -> P(home).
     The mid is the research reference (never executable); bid, ask, last,
     sizes and volume are kept separately. A last trade is fresh only when
     volume rose since the previous snapshot; otherwise it is labelled stale
     (or unknown) and is never used as a quote. */
  E.kalshiObservation = function (snap, prev, R) {
    var bid = num(snap.yes_bid), ask = num(snap.yes_ask);
    var o = { venue: 'kalshi', market: 'moneyline', at: ms(snap.captured_at), value: null, quote_type: 'kalshi_mid', flag: null,
      source_id: snap.id === undefined || snap.id === null ? null : String(snap.id), contract: null,
      raw: { yes_bid: bid, yes_ask: ask, no_bid: num(snap.no_bid), no_ask: num(snap.no_ask), last_price: num(snap.last_price),
        yes_bid_size: num(snap.yes_bid_size), yes_ask_size: num(snap.yes_ask_size), volume: num(snap.volume),
        open_interest: num(snap.open_interest), spread: null, last_trade: null, depth: null } };
    if (bid === null || ask === null || !(bid > 0) || !(ask < 1)) o.flag = 'one_sided';
    else if (ask < bid) o.flag = 'crossed';
    else {
      o.raw.spread = rnd(ask - bid, 4);
      if (ask - bid > R.kalshiMaxSpread + EPS) o.flag = 'wide_spread';
      else o.value = rnd((bid + ask) / 2, 6);
    }
    if (o.raw.last_price !== null) {
      var v = o.raw.volume, pv = prev ? num(prev.volume) : null;
      o.raw.last_trade = v === null || pv === null ? 'unknown' : (v > pv ? 'fresh' : 'stale');
    }
    o.raw.depth = o.raw.yes_bid_size === null || o.raw.yes_ask_size === null ? 'missing' : 'top_of_book';
    return o;
  };

  /* ================================================================ timing and coverage */
  /* How long after an observation at t1 the next one must arrive before the
     silence is a coverage gap. DraftKings: the ledger's own write rule (a
     heartbeat 6 h after the last write, every 50 min inside 3 h of kickoff)
     plus the late-run allowance; Kalshi: the silent-scheduler bound. */
  E.maxGapAfter = function (venue, t1, K, R) {
    if (venue === 'kalshi') return R.kalshiGap;
    var due = t1 + R.dk.heartbeat * MIN, allow = R.dk.allowFar;
    if (K !== null && K !== undefined) {
      var zoneStart = K - R.dk.zoneHours * 3600000;
      var zoneDue = Math.max(zoneStart, t1 + R.dk.zoneHeartbeat * MIN);
      if (zoneDue < due) { due = zoneDue; allow = R.dk.allowZone; }
    }
    return Math.round((due - t1) / MIN) + allow;
  };

  function obsKey(o) {
    if (o.venue === 'kalshi') return C.canonicalJson([o.raw.yes_bid, o.raw.yes_ask, o.flag]);
    return C.canonicalJson([o.value, o.flag, o.raw]);
  }

  /* A venue contract's observations as an interval series: the points
     (pregame only), the coverage gaps (including a silent stretch before
     kickoff), and run-length segments of identical quotes. A segment never
     spans a gap: what happened inside a gap is unknown. */
  E.buildSeries = function (obs, venue, market, K, R) {
    var pts = (obs || []).filter(function (o) { return o && o.at !== null && (K === null || o.at < K); })
      .sort(function (a, b) { return a.at - b.at || cmp(str(a.source_id), str(b.source_id)); });
    var dedup = [];
    pts.forEach(function (p) { var l = dedup[dedup.length - 1]; if (!l || l.at !== p.at) dedup.push(p); });
    pts = dedup;
    var gaps = [], segs = [], i;
    for (i = 1; i < pts.length; i++) {
      var bound = E.maxGapAfter(venue, pts[i - 1].at, K, R);
      if (pts[i].at - pts[i - 1].at > bound * MIN) gaps.push({ from: pts[i - 1].at, to: pts[i].at, minutes: mins(pts[i].at, pts[i - 1].at), expected_max_minutes: bound, trailing: false });
    }
    if (pts.length && K !== null) {
      var last = pts[pts.length - 1], tb = E.maxGapAfter(venue, last.at, K, R);
      if (K - last.at > tb * MIN) gaps.push({ from: last.at, to: K, minutes: mins(K, last.at), expected_max_minutes: tb, trailing: true });
    }
    var gapAfter = {};
    gaps.forEach(function (g) { if (!g.trailing) gapAfter[g.from] = true; });
    pts.forEach(function (p, j) {
      var s = segs[segs.length - 1];
      if (s && !gapAfter[pts[j - 1].at] && s.key === obsKey(p)) { s.last_at = p.at; s.n++; s.raw_last = p.raw; s.last_id = p.source_id; return; }
      segs.push({ key: obsKey(p), value: p.value, flag: p.flag, quote_type: p.quote_type, first_at: p.at, last_at: p.at, n: 1,
        raw: p.raw, raw_last: p.raw, contract: p.contract, first_id: p.source_id, last_id: p.source_id });
    });
    var S = { venue: venue, market: market, kickoff: K, points: pts, gaps: gaps, segments: segs,
      first_at: pts.length ? pts[0].at : null, last_at: pts.length ? pts[pts.length - 1].at : null };
    S.gapIn = function (a, b) { return gaps.some(function (g) { return g.from < b && g.to > a; }); };
    return S;
  };

  /* A spread or total cover probability belongs to ONE threshold: each
     threshold is its own series, never spliced into another. */
  E.thresholdSeries = function (segments) {
    var out = {};
    (segments || []).forEach(function (s) {
      if (!s.contract || s.contract.threshold === null || s.contract.threshold === undefined) return;
      var k = String(s.contract.threshold);
      (out[k] = out[k] || []).push({ first_at: s.first_at, last_at: s.last_at, p: s.contract.p === undefined ? null : s.contract.p, flag: s.contract.flag || null, kind: s.contract.kind });
    });
    return out;
  };

  /* the latest observation at or before t, if it is still current under the
     venue's gap rule and carries a comparable value; never a later quote */
  E.observationAt = function (S, t, R) {
    var p = null;
    for (var i = 0; i < S.points.length; i++) { if (S.points[i].at <= t) p = S.points[i]; else break; }
    if (!p) return { ok: false, reason: S.points.length ? 'no_observation_before' : 'no_market_contract' };
    var age = (t - p.at) / MIN, bound = E.maxGapAfter(S.venue, p.at, S.kickoff, R);
    if (age > bound + EPS) return { ok: false, reason: 'stale', obs: p, age_minutes: rnd(age, 1), max_age_minutes: bound };
    if (p.value === null) return { ok: false, reason: 'unpriced', obs: p, flag: p.flag, age_minutes: rnd(age, 1) };
    return { ok: true, obs: p, value: p.value, at: p.at, age_minutes: rnd(age, 1), max_age_minutes: bound };
  };

  /* the venue's last pregame observation, inside the close window; a close
     too early or unpriced is no close, never replaced by an earlier one */
  E.closeOf = function (S, R) {
    var K = S.kickoff, p = S.points.length ? S.points[S.points.length - 1] : null;
    if (!p) return { ok: false, reason: 'no_observation' };
    var before = (K - p.at) / MIN, lim = R.closeMax[S.venue];
    if (before > lim + EPS) return { ok: false, reason: 'too_early', obs: p, minutes_before_kickoff: rnd(before, 1), max_minutes: lim };
    if (p.value === null) return { ok: false, reason: 'unpriced', obs: p, flag: p.flag, minutes_before_kickoff: rnd(before, 1) };
    return { ok: true, obs: p, value: p.value, at: p.at, minutes_before_kickoff: rnd(before, 1), max_minutes: lim };
  };

  /* ================================================================ settlement */
  E.forecastProfile = function (f, R) {
    var P = R.settlement.profiles, sp = f.sport;
    if (f.source === 'edgedesk') return f.settles ? (P.edgedesk_p_home[sp] || null) : null;
    if (f.source === 'collective' || f.source === 'collective_consensus') return P.collective_home_win_prob[sp] || null;
    return null;
  };
  /* Kalshi's profile comes only from an operator's verification of that
     exact rules text (sha256); otherwise it is unverified */
  E.venueProfile = function (venue, sport, R, verification) {
    var P = R.settlement.profiles;
    if (venue === 'draftkings') return P.draftkings_moneyline[sport] || null;
    if (venue === 'kalshi') {
      if (verification && verification.verified) return { overtime: verification.overtime, tie: verification.tie, verified: true, verification_id: verification.id || null };
      return P.kalshi_game_winner[sport] || { overtime: 'unverified', tie: 'unverified', verified: false };
    }
    return null;
  };
  E.settlementIssue = function (fp, vp, R) {
    if (!fp) return 'settlement_undocumented';
    if (!vp || !vp.verified) return 'settlement_unverified';
    if (fp.overtime !== vp.overtime) return 'settlement_mismatch';
    var ok = R.settlement.tie_compatible[fp.tie] || [];
    return ok.indexOf(vp.tie) >= 0 ? null : 'settlement_mismatch';
  };

  /* ================================================================ forecasts */
  E.forecastIssue = function (f, market, ev, R) {
    var allowed = R.eligibleEvidence[f.source === 'collective_consensus' ? 'collective' : f.source] || [];
    if (f.source !== 'collective_consensus' && allowed.indexOf(f.evidence) < 0) return 'publication_time_reconstructed';
    if (f.source === 'collective') {
      if (f.origin !== 'live') return 'not_live_origin';
      if (f.resolution !== 'resolved') return 'quarantined';
    }
    var cutoff = ev.kickoff - (f.source === 'collective' ? R.lockMinutes * MIN : 0);
    if (!(f.published_at < cutoff)) return 'published_at_or_after_cutoff';
    var v = num(f.values && f.values[market]);
    if (v === null) return 'value_missing';
    var rg = R.ranges[market];
    if (market === 'moneyline' ? !(v > rg[0] && v < rg[1]) : (v < rg[0] || v > rg[1])) return 'value_out_of_range';
    if (market === 'moneyline' && !E.forecastProfile(f, R)) return 'settlement_undocumented';
    return null;
  };

  function byPublication(a, b) { return a.published_at - b.published_at || cmp(str(a.forecast_id), str(b.forecast_id)); }

  E.bucketOf = function (minutesToKickoff, buckets) {
    var h = minutesToKickoff / 60, prev = 0;
    for (var i = 0; i < buckets.length; i++) {
      if (h < buckets[i]) return prev === 0 ? '<' + buckets[i] + 'h' : prev + '-' + buckets[i] + 'h';
      prev = buckets[i];
    }
    return '>' + buckets[buckets.length - 1] + 'h';
  };

  /* ================================================================ one forecast against one venue */
  /* The first observation after publication whose displacement toward the
     forecast reaches the threshold and holds at the next observation (or is
     the closing observation). Its interval is (previous observation, it]. */
  E.firstQualifyingMove = function (S, Tpub, M0obs, M0, s, th, close) {
    var pts = S.points.filter(function (p) { return p.value !== null; });
    var prev = M0obs;
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      if (p.at <= Tpub) continue;
      if (s * (p.value - M0) >= th - EPS) {
        var nx = pts[k + 1] || null;
        var confirmed = nx ? s * (nx.value - M0) >= th - EPS : !!(close && close.ok && close.obs === p);
        if (confirmed) {
          return { status: 'QUALIFIED', lo: prev.at, hi: p.at, value: p.value, spans_gap: S.gapIn(prev.at, p.at),
            precedence: prev.at >= Tpub ? 'PRECEDED' : 'UNRESOLVED',
            minutes_from_publication: [mins(prev.at, Tpub), mins(p.at, Tpub)] };
        }
        if (!nx) return { status: 'UNCONFIRMED', at: p.at };
      }
      prev = p;
    }
    return { status: 'NONE' };
  };

  E.measure = function (F, Tpub, market, S, R) {
    var th = R.threshold[market], md = R.minDis[market], dp = dpOf(market);
    var base = E.observationAt(S, Tpub, R);
    var close = E.closeOf(S, R);
    var out = { baseline: snapshotOf(base), close: snapshotOf(close) };
    if (!base.ok) { out.status = 'excluded'; out.reason = base.reason === 'unpriced' ? 'baseline_unpriced' : (base.reason === 'no_market_contract' ? 'no_market_contract' : 'no_fresh_baseline'); return out; }
    if (!close.ok) { out.status = 'excluded'; out.reason = 'no_valid_close'; return out; }
    var M0 = base.value, Cv = close.value, d0 = F - M0;
    var s = Math.abs(d0) < md - EPS ? 0 : sgn(d0);
    out.status = 'measured';
    out.F = F; out.M0 = M0; out.C = Cv;
    out.disagreement = rnd(d0, dp);
    out.convergence = rnd(Math.abs(M0 - F) - Math.abs(Cv - F), dp);
    out.closer = Math.abs(Cv - F) < Math.abs(M0 - F) - EPS ? 'closer' : (Math.abs(Math.abs(Cv - F) - Math.abs(M0 - F)) <= EPS ? 'equal' : 'further');
    out.material = s !== 0;
    if (!s) { out.cls = 'NO_MATERIAL_DISAGREEMENT'; out.directional = null; out.horizons = []; out.move = { status: 'NOT_APPLICABLE' }; out.overshoot = false; out.reversal = false; return out; }
    out.directional = rnd(s * (Cv - M0), dp);
    out.horizons = R.horizons.map(function (h) {
      var t = Tpub + h * MIN;
      if (t >= S.kickoff) return { minutes: h, status: 'censored_after_kickoff' };
      var a = E.observationAt(S, t, R);
      if (!a.ok) return { minutes: h, status: a.reason === 'unpriced' ? 'unpriced' : 'stale' };
      return { minutes: h, status: 'measured', value: a.value, at: iso(a.at), movement: rnd(s * (a.value - M0), dp) };
    });
    var q = E.firstQualifyingMove(S, Tpub, base.obs, M0, s, th, close);
    out.move = q.status === 'QUALIFIED'
      ? { status: q.status, lo: iso(q.lo), hi: iso(q.hi), value: q.value, spans_gap: q.spans_gap, precedence: q.precedence, minutes_from_publication: q.minutes_from_publication }
      : (q.status === 'UNCONFIRMED' ? { status: q.status, at: iso(q.at) } : { status: q.status });
    var dC = s * (Cv - M0);
    if (q.status === 'QUALIFIED') out.cls = dC >= th - EPS ? 'TOWARD_HELD' : 'TOWARD_REVERSED';
    else out.cls = dC <= -th + EPS ? 'MOVED_AWAY' : 'NO_QUALIFYING_MOVE';
    out.overshoot = s * (Cv - F) > EPS;
    out.reversal = out.cls === 'TOWARD_REVERSED';
    return out;
  };
  function snapshotOf(x) {
    if (!x) return null;
    var o = { ok: !!x.ok, reason: x.reason || null };
    if (x.obs) { o.at = iso(x.obs.at); o.value = x.obs.value; o.source_id = x.obs.source_id; o.flag = x.obs.flag || null; o.raw = x.obs.raw; }
    ['age_minutes', 'max_age_minutes', 'minutes_before_kickoff', 'max_minutes'].forEach(function (k) { if (x[k] !== undefined) o[k] = x[k]; });
    return o;
  }

  /* ================================================================ plain-language findings */
  E.finding = function (u) {
    var m = u.metrics || {};
    if (u.status !== 'measured') return { code: 'EXCLUDED', template: 'Not measured: {reason}.', params: { reason: (u.exclusion_reason || '').replace(/_/g, ' ') } };
    if (m.cls === 'NO_MATERIAL_DISAGREEMENT') return { code: m.cls, template: 'The forecast agreed with the market at publication (within the minimum disagreement), so no movement toward it is measured.', params: {} };
    var mv = m.move || {};
    if (mv.status === 'QUALIFIED' && mv.precedence === 'PRECEDED') {
      return { code: 'PRECEDED', template: 'This forecast was published before the first observed sustained move toward it. Available observations place that move between {A} and {B}.' +
        (mv.spans_gap ? ' That interval spans a collection gap, so the move could have happened anywhere inside it.' : '') +
        (m.cls === 'TOWARD_REVERSED' ? ' The market later reversed before the close.' : '') + (m.overshoot ? ' The close moved past the forecast.' : ''),
        params: { A: mv.lo, B: mv.hi } };
    }
    if (mv.status === 'QUALIFIED') {
      return { code: 'UNRESOLVED', template: 'The market moved toward this forecast, but timing is unresolved at available sampling resolution: the move happened between {A} and {B}, and publication falls inside that interval.' +
        (m.cls === 'TOWARD_REVERSED' ? ' The market later reversed before the close.' : ''), params: { A: mv.lo, B: mv.hi } };
    }
    if (m.cls === 'MOVED_AWAY') return { code: 'MOVED_AWAY', template: 'No sustained move toward this forecast was observed; the market closed further from it than at publication.', params: {} };
    return { code: 'NO_QUALIFYING_MOVE', template: 'No sustained move toward this forecast was observed before kickoff.', params: {} };
  };
  E.renderFinding = function (f, fmt) {
    return String(f.template).replace(/\{([A-Za-z]+)\}/g, function (_, k) { var v = f.params[k]; return fmt && /^\d{4}-\d\d-\d\dT/.test(str(v)) ? fmt(v) : str(v); });
  };

  /* ================================================================ units for one game */
  E.unitKey = function (version, f, market, venue) {
    return 'mfu-' + C.fingerprint([version, f.source, f.model_key, f.model_version, f.sport, f.event_id, market, venue]);
  };
  function forecastBrief(f) {
    return { source: f.source, model_key: f.model_key, model_label: f.model_label || f.model_key, model_version: f.model_version,
      creator: f.creator || null, forecast_id: f.forecast_id, published_at: iso(f.published_at), predicted_at: iso(f.predicted_at),
      evidence: f.evidence, values: f.values, family: f.family || null, publishable: f.publishable !== false };
  }

  /* every (source, model, version) x market x venue for one game: the first
     eligible forecast is the unit; the rest are revisions */
  E.unitsForGame = function (ev, forecasts, series, profiles, R) {
    var units = [], groups = {};
    forecasts.forEach(function (f) { var k = [f.source, f.model_key, f.model_version].join('|'); (groups[k] = groups[k] || []).push(f); });
    Object.keys(groups).sort().forEach(function (k) {
      var list = groups[k].slice().sort(byPublication);
      E.MARKETS.forEach(function (market) {
        var issues = list.map(function (f) { return E.forecastIssue(f, market, ev, R); });
        var pick = -1;
        for (var i = 0; i < issues.length; i++) if (!issues[i]) { pick = i; break; }
        var f = pick >= 0 ? list[pick] : list[0];
        if (pick < 0 && issues[0] === 'value_missing' && issues.every(function (x) { return x === 'value_missing'; })) return; /* this model never priced the market */
        E.VENUES[market].forEach(function (venue) {
          var u = { unit_key: E.unitKey(R.version, f, market, venue), methodology: R.version, sport: ev.sport, event_id: ev.event_id,
            kickoff: iso(ev.kickoff), home: ev.home, away: ev.away, source: f.source, model_key: f.model_key, model_label: f.model_label || f.model_key,
            model_version: f.model_version, creator: f.creator || null, market: market, measure: E.MEASURE[market], venue: venue,
            forecast: forecastBrief(f), forecast_value: num(f.values && f.values[market]), published_at: iso(f.published_at),
            evidence: f.evidence, horizon_bucket: E.bucketOf((ev.kickoff - f.published_at) / MIN, R.buckets),
            revisions: list.filter(function (x, j) { return j !== (pick >= 0 ? pick : 0) && x.published_at > f.published_at; }).map(function (x) {
              return { forecast_id: x.forecast_id, published_at: iso(x.published_at), value: num(x.values && x.values[market]), evidence: x.evidence, issue: E.forecastIssue(x, market, ev, R) };
            }),
            earlier_ineligible: pick > 0 ? list.slice(0, pick).map(function (x, j) { return { forecast_id: x.forecast_id, published_at: iso(x.published_at), issue: issues[j] }; }) : [],
            membership: f.membership || null, publishable: f.publishable !== false,
            status: 'excluded', exclusion_reason: null, metrics: null, settlement: null };
          if (ev.state === 'VOID') u.exclusion_reason = 'event_void';
          else if (pick < 0) u.exclusion_reason = issues[0];
          if (!u.exclusion_reason && market === 'moneyline') {
            var fp = E.forecastProfile(f, R), vp = profiles[venue];
            u.settlement = { forecast: fp, venue: vp };
            u.exclusion_reason = E.settlementIssue(fp, vp, R);
          }
          var S = series[venue + ':' + market];
          if (!u.exclusion_reason) {
            if (!S || !S.points.length) u.exclusion_reason = 'no_market_contract';
            else {
              var m = E.measure(num(f.values[market]), f.published_at, market, S, R);
              u.metrics = m;
              if (m.status === 'measured') u.status = 'measured'; else u.exclusion_reason = m.reason;
            }
          }
          u.finding = E.finding(u);
          units.push(u);
        });
      });
    });
    return units;
  };

  /* ================================================================ venue lead-lag */
  /* Debounced moves of one venue's comparable series: from an anchor, the
     first observation at least `th` away, confirmed by the next observation
     (or being the last pregame one); the anchor then moves to it. */
  E.venueMoves = function (S, th) {
    var pts = S.points.filter(function (p) { return p.value !== null; });
    var moves = [];
    if (!pts.length) return moves;
    var anchor = pts[0].value;
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], d = p.value - anchor;
      if (Math.abs(d) < th - EPS) continue;
      var dir = sgn(d), nx = pts[i + 1];
      if (nx ? dir * (nx.value - anchor) >= th - EPS : true) {
        moves.push({ venue: S.venue, seq: moves.length, dir: dir, lo: pts[i - 1].at, hi: p.at, from: anchor, to: p.value, spans_gap: S.gapIn(pts[i - 1].at, p.at) });
        anchor = p.value;
      }
    }
    return moves;
  };

  function covers(S, a, b) {
    if (!S || !S.points.length || S.first_at > a) return false;
    return !S.gaps.some(function (g) { return g.from < b && g.to > a; }) && (S.last_at >= b || !S.gaps.some(function (g) { return g.trailing; }));
  }

  /* Chronological pairing, each move used at most once, fixed tie-breaks: no
     retrospective choice of the pairing that tells the better story. */
  E.pairMoves = function (SA, SB, th, followMin, K) {
    var A = E.venueMoves(SA, th), B = E.venueMoves(SB, th), W = followMin * MIN;
    var all = A.concat(B).sort(function (x, y) { return x.lo - y.lo || x.hi - y.hi || cmp(x.venue, y.venue) || x.seq - y.seq; });
    var used = {}, pairs = [];
    function id(m) { return m.venue + ':' + m.seq; }
    all.forEach(function (m) {
      if (used[id(m)]) return;
      var pool = (m.venue === SA.venue ? B : A).filter(function (o) { return !used[id(o)] && o.dir === m.dir && o.lo <= m.hi + W && o.hi >= m.lo - W; })
        .sort(function (x, y) { return x.lo - y.lo || x.hi - y.hi || x.seq - y.seq; });
      if (!pool.length) return;
      var o = pool[0];
      used[id(m)] = used[id(o)] = true;
      var order, leader = null, follower = null;
      if (m.lo === o.lo && m.hi === o.hi) order = 'TIE';
      else if (m.hi <= o.lo) { order = 'LEADER'; leader = m; follower = o; }
      else if (o.hi <= m.lo) { order = 'LEADER'; leader = o; follower = m; }
      else order = 'UNRESOLVED';
      var ref = Math.min(m.hi, o.hi);
      pairs.push({ dir: m.dir, order: order, leader: leader ? leader.venue : null,
        a: moveBrief(m.venue === SA.venue ? m : o), b: moveBrief(m.venue === SA.venue ? o : m),
        lead_minutes: leader ? [mins(follower.lo, leader.hi), mins(follower.hi, leader.lo)] : null,
        reference_at: iso(ref) });
    });
    var unmatched = all.filter(function (m) { return !used[id(m)]; }).map(function (m) {
      var other = m.venue === SA.venue ? SB : SA;
      var a = m.lo - W, b = Math.min(m.hi + W, K);
      return Object.assign(moveBrief(m), { status: covers(other, a, b) ? 'UNMATCHED' : 'INSUFFICIENT_COVERAGE' });
    });
    return { moves: { a: A.map(moveBrief), b: B.map(moveBrief) }, pairs: pairs, unmatched: unmatched };
  };
  function moveBrief(m) { return { venue: m.venue, seq: m.seq, dir: m.dir, lo: iso(m.lo), hi: iso(m.hi), from: m.from, to: m.to, spans_gap: m.spans_gap }; }

  E.leadLagForGame = function (ev, series, profiles, R) {
    var SA = series['draftkings:moneyline'], SB = series['kalshi:moneyline'];
    if (!SA || !SB || !SA.points.length || !SB.points.length) return { status: 'NOT_BOTH_VENUES', reason: !SB || !SB.points.length ? 'no Kalshi home-team series for this game' : 'no DraftKings moneyline series for this game' };
    var pa = profiles.draftkings, pb = profiles.kalshi;
    if (!pb || !pb.verified) return { status: 'BLOCKED', reason: 'settlement_unverified', detail: 'Kalshi settlement rules for this market are not verified; cross-venue timing is not measured' };
    if (!pa || pa.overtime !== pb.overtime || (R.settlement.tie_compatible[pa.tie] || []).indexOf(pb.tie) < 0) return { status: 'BLOCKED', reason: 'settlement_mismatch' };
    var res = E.pairMoves(SA, SB, R.leadLag.threshold, R.leadLag.follow, ev.kickoff);
    res.pairs.forEach(function (p) {
      var ref = Math.min(ms(p.a.hi), ms(p.b.hi));
      p.bucket = E.bucketOf((ev.kickoff - ref) / MIN, R.leadLag.buckets);
    });
    res.unmatched.forEach(function (m) { m.bucket = E.bucketOf((ev.kickoff - ms(m.hi)) / MIN, R.leadLag.buckets); });
    res.status = 'MEASURED';
    res.venues = [SA.venue, SB.venue];
    return res;
  };

  /* ================================================================ Collective consensus, strictly as of */
  E.quantile = function (sorted, q) {
    if (!sorted.length) return null;
    var h = (sorted.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  };
  E.consensusAt = function (ev, forecasts, market, tau, R) {
    var best = {};
    forecasts.forEach(function (f) {
      if (f.source !== 'collective' || f.published_at > tau) return;
      if (f.withdrawn_at !== null && f.withdrawn_at !== undefined && f.withdrawn_at <= tau) return;
      if (E.forecastIssue(f, market, ev, R)) return;
      var cur = best[f.model_key];
      if (!cur || byPublication(cur, f) < 0) best[f.model_key] = f;
    });
    var keys = Object.keys(best).sort();
    var members = keys.map(function (k) { var f = best[k]; return { model_key: k, forecast_id: f.forecast_id, published_at: iso(f.published_at), value: num(f.values[market]), family: f.family || null }; });
    var vals = members.map(function (m) { return m.value; }), sorted = vals.slice().sort(function (a, b) { return a - b; });
    var out = { market: market, tau: iso(tau), offset_minutes: Math.round((ev.kickoff - tau) / MIN), n: members.length, members: members,
      membership_hash: 'mfm-' + C.fingerprint(members.map(function (m) { return [m.model_key, m.forecast_id]; })) };
    var fam = {};
    members.forEach(function (m) { if (m.family) fam[m.family] = (fam[m.family] || 0) + 1; });
    out.shared_families = Object.keys(fam).filter(function (k) { return fam[k] > 1; }).sort().map(function (k) { return { family: k, n: fam[k] }; });
    if (members.length < R.consensus.min) { out.status = 'INSUFFICIENT_CONTRIBUTORS'; return out; }
    var mu = mean(vals), dp = dpOf(market) + 2;
    var sd = vals.length > 1 ? Math.sqrt(sum(vals.map(function (v) { return (v - mu) * (v - mu); })) / (vals.length - 1)) : 0;
    out.status = 'OK';
    out.mean = rnd(mu, dp); out.median = rnd(E.quantile(sorted, 0.5), dp); out.sd = rnd(sd, dp);
    out.iqr = rnd(E.quantile(sorted, 0.75) - E.quantile(sorted, 0.25), dp); out.min = sorted[0]; out.max = sorted[sorted.length - 1];
    return out;
  };
  /* the consensus as pseudo-forecasts at each evaluation time, measured by
     the same rules as any model (mean is the baseline; median beside it) */
  E.consensusForecasts = function (ev, forecasts, R, now) {
    var rows = [], out = [];
    R.consensus.offsets.forEach(function (off) {
      var tau = ev.kickoff - off * MIN;
      if (tau > now) return;
      var vals = {}, mem = {}, snaps = {};
      E.MARKETS.forEach(function (mk) {
        var c = E.consensusAt(ev, forecasts, mk, tau, R);
        snaps[mk] = c;
        if (c.status === 'OK') { vals[mk] = c; mem[mk] = { n: c.n, membership_hash: c.membership_hash, members: c.members, sd: c.sd, iqr: c.iqr, shared_families: c.shared_families }; }
      });
      rows.push({ offset_minutes: off, tau: iso(tau), markets: snaps });
      ['equal_weight_mean', 'median'].forEach(function (ver) {
        var v = {};
        Object.keys(vals).forEach(function (mk) { v[mk] = ver === 'median' ? vals[mk].median : vals[mk].mean; });
        if (!Object.keys(v).length) return;
        out.push({ source: 'collective_consensus', model_key: 'collective-consensus-' + off + 'm', model_label: 'Collective consensus, ' + labelOffset(off) + ' before kickoff',
          model_version: ver, forecast_id: 'consensus:' + ev.event_id + ':' + off + ':' + ver, sport: ev.sport, event_id: ev.event_id,
          published_at: tau, predicted_at: tau, evidence: 'computed_as_of', values: v, membership: mem, publishable: true });
      });
    });
    return { snapshots: rows, forecasts: out };
  };
  function labelOffset(m) { return m % 60 === 0 ? (m / 60) + ' h' : m + ' min'; }

  /* ================================================================ one game, end to end */
  /* input: { event: {sport, event_id, kickoff, home, away, state, void_reason},
     forecasts: [...normalized], dk: [ledger rows], kalshi: {market: {ticker,
     rules_sha256, verification}, snapshots: [...]} | null } */
  /* every venue series of one game (DraftKings by market, Kalshi's home market) */
  E.seriesForGame = function (input, R) {
    var K = ms(input.event.kickoff), series = {};
    var dkObs = { spread: [], total: [], moneyline: [] };
    (input.dk || []).forEach(function (row) { var o = E.dkObservation(row, R); if (o && dkObs[o.market]) dkObs[o.market].push(o); });
    E.MARKETS.forEach(function (mk) { if (dkObs[mk].length) series['draftkings:' + mk] = E.buildSeries(dkObs[mk], 'draftkings', mk, K, R); });
    var kmk = input.kalshi && input.kalshi.market ? input.kalshi.market : null;
    if (kmk && input.kalshi.snapshots && input.kalshi.snapshots.length) {
      var snaps = input.kalshi.snapshots.slice().sort(function (a, b) { return ms(a.captured_at) - ms(b.captured_at) || cmp(str(a.id), str(b.id)); });
      var kobs = snaps.map(function (s, i) { return E.kalshiObservation(s, i ? snaps[i - 1] : null, R); });
      series['kalshi:moneyline'] = E.buildSeries(kobs, 'kalshi', 'moneyline', K, R);
    }
    return series;
  };

  E.evaluateGame = function (input, R, now) {
    var ev = Object.assign({}, input.event, { kickoff: ms(input.event.kickoff) });
    var series = E.seriesForGame(input, R);
    var kmk = input.kalshi && input.kalshi.market ? input.kalshi.market : null;
    var profiles = { draftkings: E.venueProfile('draftkings', ev.sport, R), kalshi: E.venueProfile('kalshi', ev.sport, R, kmk ? kmk.verification : null) };
    var seen = {}, forecasts = [];
    (input.forecasts || []).forEach(function (f) {
      var k = f.source + '|' + f.forecast_id;
      if (seen[k]) return;   /* the same record read twice is one forecast */
      seen[k] = true;
      forecasts.push(Object.assign({}, f, { published_at: ms(f.published_at), predicted_at: ms(f.predicted_at), withdrawn_at: ms(f.withdrawn_at) }));
    });
    var cons = E.consensusForecasts(ev, forecasts, R, now);
    var units = E.unitsForGame(ev, forecasts.concat(cons.forecasts), series, profiles, R);
    var lead = E.leadLagForGame(ev, series, profiles, R);
    var seriesOut = {};
    Object.keys(series).sort().forEach(function (k) {
      var S = series[k], close = E.closeOf(S, R);
      seriesOut[k] = { venue: S.venue, market: S.market, measure: E.MEASURE[S.market], n_observations: S.points.length,
        first_at: iso(S.first_at), last_at: iso(S.last_at),
        segments: S.segments.map(function (s) {
          return { value: s.value, flag: s.flag, quote_type: s.quote_type, first_at: iso(s.first_at), last_at: iso(s.last_at), n: s.n,
            raw: s.raw, raw_last: s.raw_last, contract: s.contract, first_id: s.first_id, last_id: s.last_id };
        }),
        gaps: S.gaps.map(function (g) { return { from: iso(g.from), to: iso(g.to), minutes: g.minutes, expected_max_minutes: g.expected_max_minutes, trailing: g.trailing }; }),
        close: snapshotOf(close), cadence: cadenceOf(S) };
    });
    var fsum = forecasts.slice().sort(byPublication).map(function (f) {
      var b = forecastBrief(f);
      b.issues = {};
      E.MARKETS.forEach(function (mk) { var x = E.forecastIssue(f, mk, ev, R); if (x !== 'value_missing') b.issues[mk] = x; });
      return b;
    });
    var game = {
      schema: E.SCHEMA, methodology: R.version, sport: ev.sport, event_id: ev.event_id, kickoff: iso(ev.kickoff), home: ev.home, away: ev.away,
      state: ev.state || null, void_reason: ev.void_reason || null, series: seriesOut, forecasts: fsum, consensus: cons.snapshots,
      lead_lag: lead, profiles: profiles, kalshi_market: kmk ? { ticker: kmk.ticker, yes_side: 'home', rules_sha256: kmk.rules_sha256 || null } : null,
      unit_keys: units.map(function (u) { return u.unit_key; })
    };
    game.input_hash = 'mfi-' + C.fingerprint([R.version, input.event, input.forecasts || [], input.dk || [], input.kalshi || null]);
    units.forEach(function (u) { u.input_hash = 'mfh-' + C.fingerprint([u.unit_key, u.status, u.exclusion_reason, u.forecast, u.metrics, u.revisions, u.settlement, u.membership]); });
    return { game: game, units: units, series: series };
  };
  function cadenceOf(S) {
    var g = [];
    for (var i = 1; i < S.points.length; i++) g.push((S.points[i].at - S.points[i - 1].at) / MIN);
    g.sort(function (a, b) { return a - b; });
    return { n_intervals: g.length, median_minutes: rnd(E.quantile(g, 0.5), 1), p90_minutes: rnd(E.quantile(g, 0.9), 1), max_minutes: g.length ? rnd(g[g.length - 1], 1) : null, n_gaps: S.gaps.length };
  }

  /* ================================================================ statistics */
  E.prng = function (seed) {
    var h = parseInt(C.fingerprint(seed).slice(0, 8), 16) >>> 0;
    return function () {
      h = (h + 0x6D2B79F5) >>> 0;
      var t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  var Z95 = 1.959963984540054;
  E.wilson = function (k, n) {
    if (!n) return null;
    var p = k / n, z = Z95, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return { p: rnd(p, 4), lo: rnd((c - r) / d, 4), hi: rnd((c + r) / d, 4) };
  };
  function median(xs) { var s = xs.slice().sort(function (a, b) { return a - b; }); return E.quantile(s, 0.5); }
  E.median = median; E.mean = mean;
  /* percentile bootstrap over resampled groups (events); seeded, so the same
     data and group give the same interval */
  E.bootstrap = function (groups, stat, seed, B, level) {
    if (!groups.length) return null;
    var r = E.prng(seed), out = [];
    for (var b = 0; b < B; b++) {
      var xs = [];
      for (var i = 0; i < groups.length; i++) { var g = groups[Math.floor(r() * groups.length)]; for (var j = 0; j < g.length; j++) xs.push(g[j]); }
      var v = stat(xs);
      if (isNum(v)) out.push(v);
    }
    out.sort(function (a, b) { return a - b; });
    var a = (1 - level) / 2;
    return { lo: E.quantile(out, a), hi: E.quantile(out, 1 - a), resamples: out.length };
  };

  function statBlock(vals, events, seed, R, dp) {
    var n = vals.length;
    var o = { n: n, mean: rnd(mean(vals), dp), median: rnd(median(vals), dp) };
    if (n >= R.stats.minInterval) {
      var groups = {}, keys = [];
      vals.forEach(function (v, i) { var k = events[i]; if (!groups[k]) { groups[k] = []; keys.push(k); } groups[k].push(v); });
      var gs = keys.map(function (k) { return groups[k]; });
      var cm = E.bootstrap(gs, mean, seed + '|mean', R.stats.B, R.stats.level), cd = E.bootstrap(gs, median, seed + '|median', R.stats.B, R.stats.level);
      o.mean_ci = cm ? [rnd(cm.lo, dp), rnd(cm.hi, dp)] : null;
      o.median_ci = cd ? [rnd(cd.lo, dp), rnd(cd.hi, dp)] : null;
    } else { o.mean_ci = null; o.median_ci = null; o.interval_note = 'no interval below n = ' + R.stats.minInterval; }
    return o;
  }

  /* one summary per (source, model, version, sport, market, venue, horizon
     bucket), plus the bucket 'all'; every count and denominator is kept */
  E.summarize = function (units, R) {
    var groups = {};
    units.forEach(function (u) {
      [u.horizon_bucket, 'all'].forEach(function (b) {
        var k = [u.source, u.model_key, u.model_version, u.sport, u.market, u.venue, b].join('|');
        (groups[k] = groups[k] || { key: k, source: u.source, model_key: u.model_key, model_label: u.model_label, model_version: u.model_version,
          sport: u.sport, market: u.market, measure: u.measure, venue: u.venue, horizon_bucket: b, units: [] }).units.push(u);
      });
    });
    return Object.keys(groups).sort().map(function (k) { return summaryOf(groups[k], R); });
  };
  function summaryOf(g, R) {
    var us = g.units, dp = dpOf(g.market), th = R.threshold[g.market];
    var measured = us.filter(function (u) { return u.status === 'measured'; });
    var material = measured.filter(function (u) { return u.metrics.material; });
    var ex = {};
    us.forEach(function (u) { if (u.status !== 'measured') ex[u.exclusion_reason] = (ex[u.exclusion_reason] || 0) + 1; });
    var cls = {};
    measured.forEach(function (u) { cls[u.metrics.cls] = (cls[u.metrics.cls] || 0) + 1; });
    var ev = function (list) { return list.map(function (u) { return u.event_id; }); };
    var seed = R.version + '|' + g.key;
    var closer = material.filter(function (u) { return u.metrics.closer === 'closer'; }).length;
    var equal = material.filter(function (u) { return u.metrics.closer === 'equal'; }).length;
    var qual = material.filter(function (u) { return u.metrics.move.status === 'QUALIFIED'; });
    var preceded = qual.filter(function (u) { return u.metrics.move.precedence === 'PRECEDED'; });
    var s = {
      key: g.key, methodology: R.version, source: g.source, model_key: g.model_key, model_label: g.model_label, model_version: g.model_version,
      sport: g.sport, market: g.market, measure: g.measure, venue: g.venue, horizon_bucket: g.horizon_bucket,
      units: us.length, measured: measured.length, excluded: us.length - measured.length, exclusions: ex,
      material: material.length, no_material_disagreement: measured.length - material.length,
      threshold: th,
      closer: { k: closer, equal: equal, n: material.length, wilson: E.wilson(closer, material.length) },
      convergence: statBlock(material.map(function (u) { return u.metrics.convergence; }), ev(material), seed + '|conv', R, dp),
      convergence_all_measured: statBlock(measured.map(function (u) { return u.metrics.convergence; }), ev(measured), seed + '|convall', R, dp),
      directional: statBlock(material.map(function (u) { return u.metrics.directional; }), ev(material), seed + '|dir', R, dp),
      horizons: R.horizons.map(function (h) {
        var hs = material.map(function (u) { return { u: u, h: (u.metrics.horizons || []).filter(function (x) { return x.minutes === h; })[0] }; });
        var ok = hs.filter(function (x) { return x.h && x.h.status === 'measured'; });
        var b = statBlock(ok.map(function (x) { return x.h.movement; }), ok.map(function (x) { return x.u.event_id; }), seed + '|h' + h, R, dp);
        b.minutes = h;
        b.censored = hs.filter(function (x) { return x.h && x.h.status === 'censored_after_kickoff'; }).length;
        b.unavailable = hs.length - ok.length - b.censored;
        return b;
      }),
      qualifying: { k: qual.length, n: material.length, wilson: E.wilson(qual.length, material.length),
        unconfirmed: material.filter(function (u) { return u.metrics.move.status === 'UNCONFIRMED'; }).length },
      precedence: { preceded: preceded.length, unresolved: qual.length - preceded.length, of_qualified: qual.length },
      time_to_move: {
        preceded: ttm(preceded), all_qualified: ttm(qual),
        note: 'minutes from publication to the move interval; lower and upper bounds are reported separately, never a midpoint'
      },
      classes: cls,
      rates: {
        no_move: rate((cls.NO_QUALIFYING_MOVE || 0), material.length),
        reversal: rate((cls.TOWARD_REVERSED || 0), qual.length),
        moved_away: rate((cls.MOVED_AWAY || 0), material.length),
        overshoot: rate(material.filter(function (u) { return u.metrics.overshoot; }).length, material.length)
      },
      coverage: {
        attempted: us.filter(function (u) { return u.metrics; }).length,
        fresh_baseline: us.filter(function (u) { return u.metrics && u.metrics.baseline && u.metrics.baseline.ok; }).length,
        valid_close: us.filter(function (u) { return u.metrics && u.metrics.close && u.metrics.close.ok; }).length
      }
    };
    s.evidence = material.length < R.stats.minSummary ? 'INSUFFICIENT_EVIDENCE' : (material.length < R.stats.minInterval ? 'THIN' : 'OK');
    return s;
  }
  function rate(k, n) { return { k: k, n: n, p: n ? rnd(k / n, 4) : null }; }
  function ttm(list) {
    var lo = list.map(function (u) { return u.metrics.move.minutes_from_publication[0]; });
    var hi = list.map(function (u) { return u.metrics.move.minutes_from_publication[1]; });
    return { n: list.length, median_lower: rnd(median(lo), 1), median_upper: rnd(median(hi), 1) };
  }

  /* venue lead-lag, per sport and time-before-start bucket (and 'all'); a
     leadership label needs enough resolved pairs AND a Wilson lower bound
     above one half */
  E.leadLagSummary = function (games, R) {
    var groups = {};
    function g(sport, b) { var k = sport + '|' + b; return groups[k] = groups[k] || { sport: sport, bucket: b, games: 0, blocked: 0, blocked_reasons: {}, pairs: 0, leaders: {}, ties: 0, unresolved: 0, unmatched: {}, insufficient_coverage: {}, moves: {}, lead_lo: {}, lead_hi: {} }; }
    games.forEach(function (gm) {
      var L = gm.lead_lag, sp = gm.sport;
      if (!L) return;
      if (L.status !== 'MEASURED') { var x = g(sp, 'all'); x.blocked++; x.blocked_reasons[L.reason || L.status] = (x.blocked_reasons[L.reason || L.status] || 0) + 1; return; }
      g(sp, 'all').games++;
      ['a', 'b'].forEach(function (side) { (L.moves[side] || []).forEach(function (m) { var t = g(sp, 'all'); t.moves[m.venue] = (t.moves[m.venue] || 0) + 1; }); });
      L.pairs.forEach(function (p) {
        [p.bucket, 'all'].forEach(function (b) {
          var t = g(sp, b);
          t.pairs++;
          if (p.order === 'TIE') t.ties++;
          else if (p.order === 'UNRESOLVED') t.unresolved++;
          else {
            t.leaders[p.leader] = (t.leaders[p.leader] || 0) + 1;
            (t.lead_lo[p.leader] = t.lead_lo[p.leader] || []).push(p.lead_minutes[0]);
            (t.lead_hi[p.leader] = t.lead_hi[p.leader] || []).push(p.lead_minutes[1]);
          }
        });
      });
      L.unmatched.forEach(function (m) {
        [m.bucket, 'all'].forEach(function (b) {
          var t = g(sp, b), bag = m.status === 'UNMATCHED' ? t.unmatched : t.insufficient_coverage;
          bag[m.venue] = (bag[m.venue] || 0) + 1;
        });
      });
    });
    return Object.keys(groups).sort().map(function (k) {
      var t = groups[k], resolved = 0;
      Object.keys(t.leaders).forEach(function (v) { resolved += t.leaders[v]; });
      t.resolved = resolved;
      t.label = null;
      t.shares = {};
      Object.keys(t.leaders).sort().forEach(function (v) {
        var w = E.wilson(t.leaders[v], resolved);
        t.shares[v] = w;
        if (resolved >= R.leadLag.minPairs && w && w.lo > 0.5) t.label = { venue: v, text: 'First observed among tracked venues more often', share: w, resolved: resolved };
      });
      t.lead_minutes = {};
      Object.keys(t.lead_lo).forEach(function (v) { t.lead_minutes[v] = { median_lower: rnd(median(t.lead_lo[v]), 1), median_upper: rnd(median(t.lead_hi[v]), 1), n: t.lead_lo[v].length }; });
      delete t.lead_lo; delete t.lead_hi;
      t.label_rule = 'needs ' + R.leadLag.minPairs + ' resolved pairs and a Wilson 95% lower bound above 0.5';
      if (!t.label) t.label_status = resolved < R.leadLag.minPairs ? 'INSUFFICIENT_RESOLVED_PAIRS' : 'NO_VENUE_CLEARS_THE_BOUND';
      return t;
    });
  };

  /* ================================================================ the incremental-information check (T3) */
  function ols(X, y) {
    var p = X[0].length, A = [], b = [], i, j, k;
    for (i = 0; i < p; i++) { A.push([]); b.push(0); for (j = 0; j < p; j++) A[i].push(0); }
    for (k = 0; k < X.length; k++) for (i = 0; i < p; i++) { b[i] += X[k][i] * y[k]; for (j = 0; j < p; j++) A[i][j] += X[k][i] * X[k][j]; }
    for (i = 0; i < p; i++) {
      var piv = i;
      for (j = i + 1; j < p; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      if (Math.abs(A[piv][i]) < 1e-12) return null;
      var tA = A[i]; A[i] = A[piv]; A[piv] = tA; var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      for (j = i + 1; j < p; j++) { var f = A[j][i] / A[i][i]; for (k = i; k < p; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
    }
    var beta = new Array(p);
    for (i = p - 1; i >= 0; i--) { var s = b[i]; for (j = i + 1; j < p; j++) s -= A[i][j] * beta[j]; beta[i] = s / A[i][i]; }
    return beta;
  }
  E.ols = ols;
  function predict(beta, x) { var s = 0; for (var i = 0; i < beta.length; i++) s += beta[i] * x[i]; return s; }

  /* rows: [{event_id, kickoff, y: C - M0, r: recent movement, d: F - M0}] */
  E.incrementalInformation = function (rows, R, key) {
    var evs = {}, list = [];
    rows.forEach(function (r) { if (!evs[r.event_id]) { evs[r.event_id] = { id: r.event_id, kickoff: ms(r.kickoff) }; list.push(evs[r.event_id]); } });
    list.sort(function (a, b) { return a.kickoff - b.kickoff || cmp(a.id, b.id); });
    var nTrainEv = Math.floor(list.length * R.inc.trainShare), trainSet = {};
    list.slice(0, nTrainEv).forEach(function (e) { trainSet[e.id] = true; });
    var train = rows.filter(function (r) { return trainSet[r.event_id]; }), hold = rows.filter(function (r) { return !trainSet[r.event_id]; });
    var out = { key: key || null, tier: 'T3', n_events: list.length, n_train: train.length, n_holdout: hold.length,
      train_through: nTrainEv ? iso(list[nTrainEv - 1].kickoff) : null, holdout_from: list[nTrainEv] ? iso(list[nTrainEv].kickoff) : null };
    if (train.length < R.inc.minTrain || hold.length < R.inc.minHoldout) { out.status = 'INSUFFICIENT_EVIDENCE'; out.text = 'insufficient evidence'; return out; }
    var bBase = ols(train.map(function (r) { return [1, r.r]; }), train.map(function (r) { return r.y; }));
    var bFull = ols(train.map(function (r) { return [1, r.r, r.d]; }), train.map(function (r) { return r.y; }));
    if (!bBase || !bFull) { out.status = 'INSUFFICIENT_EVIDENCE'; out.text = 'insufficient evidence (the training design is singular)'; return out; }
    function diffOf(rs) {
      if (!rs.length) return null;
      var eb = 0, ef = 0;
      rs.forEach(function (r) { var a = r.y - predict(bBase, [1, r.r]), b = r.y - predict(bFull, [1, r.r, r.d]); eb += a * a; ef += b * b; });
      return (eb - ef) / rs.length;
    }
    var byEv = {}, keys = [];
    hold.forEach(function (r) { if (!byEv[r.event_id]) { byEv[r.event_id] = []; keys.push(r.event_id); } byEv[r.event_id].push(r); });
    var ci = E.bootstrap(keys.map(function (k) { return byEv[k]; }), diffOf, R.version + '|inc|' + (key || ''), R.stats.B, R.stats.level);
    out.status = 'COMPUTED';
    out.coef_baseline = bBase.map(function (x) { return rnd(x, 6); });
    out.coef_full = bFull.map(function (x) { return rnd(x, 6); });
    out.mse_difference = rnd(diffOf(hold), 6);
    out.ci = ci ? [rnd(ci.lo, 6), rnd(ci.hi, 6)] : null;
    out.text = ci && ci.lo > 0 ? 'On the chronological holdout, disagreement added information beyond the market state and its recent movement (T3, research).'
      : 'No evidence on the chronological holdout that disagreement added information beyond the market state and its recent movement (T3, research).';
    return out;
  };
  /* the check's rows from measured units: recent movement needs a fresh
     observation at publication minus the lookback */
  E.incrementalRows = function (units, seriesByGame, R) {
    var groups = {}, dropped = {};
    units.forEach(function (u) {
      if (u.status !== 'measured' || u.source === 'collective_consensus') return;
      var k = [u.sport, u.market, u.venue].join('|');
      var S = seriesByGame[u.event_id] && seriesByGame[u.event_id][u.venue + ':' + u.market];
      var past = S ? E.observationAt(S, ms(u.published_at) - R.inc.lookback * MIN, R) : { ok: false };
      if (!past.ok) { dropped[k] = (dropped[k] || 0) + 1; return; }
      (groups[k] = groups[k] || []).push({ event_id: u.event_id, kickoff: u.kickoff, y: u.metrics.C - u.metrics.M0, r: u.metrics.M0 - past.value, d: u.metrics.F - u.metrics.M0 });
    });
    return { groups: groups, dropped: dropped };
  };

  /* ================================================================ coverage */
  var INTENDED = {
    draftkings: 'polled hourly; a row is written on a change and on a heartbeat (6 h, every 50 min inside 3 h of kickoff)',
    kalshi: 'snapshot every 5 minutes'
  };
  E.coverage = function (gamesSeries, now) {
    var by = {};
    gamesSeries.forEach(function (gs) {
      Object.keys(gs.series).forEach(function (k) {
        var S = gs.series[k], key = gs.sport + '|' + S.venue + '|' + S.market;
        var c = by[key] = by[key] || { sport: gs.sport, venue: S.venue, market: S.market, games: 0, observations: 0, first_at: null, last_at: null, intervals: [], gaps: 0, gap_minutes: 0, valid_close: 0, closes: 0 };
        c.games++; c.observations += S.points.length;
        if (S.first_at !== null && (c.first_at === null || S.first_at < c.first_at)) c.first_at = S.first_at;
        if (S.last_at !== null && (c.last_at === null || S.last_at > c.last_at)) c.last_at = S.last_at;
        for (var i = 1; i < S.points.length; i++) c.intervals.push((S.points[i].at - S.points[i - 1].at) / MIN);
        c.gaps += S.gaps.length;
        S.gaps.forEach(function (g) { c.gap_minutes += g.minutes; });
        if (S.kickoff !== null && S.kickoff <= now) { c.closes++; if (gs.closes[k]) c.valid_close++; }
      });
    });
    return Object.keys(by).sort().map(function (k) {
      var c = by[k], iv = c.intervals.sort(function (a, b) { return a - b; });
      return { sport: c.sport, venue: c.venue, market: c.market, games: c.games, observations: c.observations, intended: INTENDED[c.venue] || null,
        first_at: iso(c.first_at), last_at: iso(c.last_at), latest_age_minutes: c.last_at === null ? null : mins(now, c.last_at),
        observed_cadence: { median_minutes: rnd(E.quantile(iv, 0.5), 1), p90_minutes: rnd(E.quantile(iv, 0.9), 1), n_intervals: iv.length },
        gaps: c.gaps, gap_hours: rnd(c.gap_minutes / 60, 1), valid_close: { k: c.valid_close, n: c.closes, p: c.closes ? rnd(c.valid_close / c.closes, 4) : null } };
    });
  };

  /* ================================================================ the whole run */
  /* inputs: { games: [game input], sources: {...status}, log: [...] } */
  E.evaluate = function (inputs, M, now) {
    var R = E.rules(M), nowMs = ms(now);
    var games = [], units = [], seriesByGame = {}, cov = [], pending = 0;
    (inputs.games || []).slice().sort(function (a, b) { return cmp(a.event.sport + '|' + a.event.event_id, b.event.sport + '|' + b.event.event_id); }).forEach(function (gi) {
      var K = ms(gi.event.kickoff);
      if (K === null) return;
      if (K > nowMs) { pending++; cov.push({ sport: gi.event.sport, series: E.seriesForGame(gi, R), closes: {} }); return; }
      var r = E.evaluateGame(gi, R, nowMs);
      games.push(r.game);
      units = units.concat(r.units);
      seriesByGame[gi.event.event_id] = r.series;
      var closes = {};
      Object.keys(r.series).forEach(function (k) { closes[k] = E.closeOf(r.series[k], R).ok; });
      cov.push({ sport: gi.event.sport, series: r.series, closes: closes });
    });
    var inc = E.incrementalRows(units, seriesByGame, R);
    var incremental = Object.keys(inc.groups).sort().map(function (k) { var x = E.incrementalInformation(inc.groups[k], R, k); x.left_out_no_recent_movement = inc.dropped[k] || 0; return x; });
    Object.keys(inc.dropped).forEach(function (k) { if (!inc.groups[k]) incremental.push({ key: k, tier: 'T3', status: 'INSUFFICIENT_EVIDENCE', text: 'insufficient evidence', n_train: 0, n_holdout: 0, left_out_no_recent_movement: inc.dropped[k] }); });
    return {
      schema: E.SCHEMA, engine: E.VERSION, methodology: R.version, generated_at: iso(nowMs),
      games: games, units: units, summaries: E.summarize(units, R), lead_lag: E.leadLagSummary(games, R),
      incremental: incremental, coverage: E.coverage(cov, nowMs),
      counts: { games: games.length, pending_games: pending, units: units.length, measured: units.filter(function (u) { return u.status === 'measured'; }).length }
    };
  };

  return E;
});

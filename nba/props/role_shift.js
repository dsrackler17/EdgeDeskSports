'use strict';
/* ===========================================================================
   EdgeDesk NBA role shifts — research model NBA-ROLE-SHIFT v0.1, EXPERIMENTAL
   (research/sharp_lag/registration_role_shift.json; docs/sharp-lag/README.md §F).

   WHO ABSORBS THE MINUTES when a top-8 rotation player (nba/roster_inputs.json
   reference minutes) is OUT or DOUBTFUL. For every upcoming game and every
   such player this build writes one SCENARIO: his teammates' minutes, usage
   and volume props in an INJURY-CONDITIONED regime, beside the default
   (projected) regime. The scenario is ready before any report: the free
   sharp_lag function switches a game to it when nba_injury_sync records the
   player moving to OUT or DOUBTFUL (supabase/functions/sharp_lag).

   THE DEFAULT MODEL AND ITS OUTPUT ARE UNCHANGED. nba/props_slate.json keeps
   its numbers; it only points here (regimes.injury_conditioned).

   1. SPLITS (primary, game level). Per teammate, his games WITHOUT the absent
      player and WITH him, this season and last, while both were on this
      team: minutes, usage (FGA + 0.44 FTA + TOV), FGA, 3PA, REB, AST, PTS per
      game and per minute. Shrunk toward WITH by k = 10 games:
        shrunk = (n_without × without + k × with) / (n_without + k)
   2. REGIME. The existing props model (nba/props/model.js) fitted for the
      default, its prediction for the teammate moved by the splits: expected
      minutes + (shrunk − with) minutes, each per-minute rate × shrunk / with,
      on the model's own minutes nodes, variance function and correlations;
      3-pointers made = the regime's 3PA × his 3P% shrunk toward the league's
      with 100 attempts (books post made, so attempts are modelled).
   3. CROSS-CHECK (stints, reported beside, never overriding): in games both
      played, the teammate's share of the court time with the absent player
      ON and OFF the floor, the minutes that implies, and his FGA, 3PA and
      assists per 36 either way (play-by-play shots). Rebounds are not in the
      stints.
   4. PRICED TEAMMATES. The 3-4 with the largest minutes or usage change get
      the volume markets the role-shift pull buys (rebounds, assists,
      3-pointers made, points + rebounds + assists): the regime's P(over) at
      every half-point line within 5 of the mean, and its fair line. Beside
      it, the default's mean, with 3PM made the same way (the default
      prediction's 3PA x the same 3P%), so the change is the absence's alone.

   Writes nba/role_shift.json (schema edgedesk_nba_role_shift_v1), called by
   nba/props/build_props.js. Research, not picks: nothing here is a price.
   =========================================================================== */
const PM = require('./model');
const DIST = require('../model/distribution');

const RULES = Object.freeze({
  model_key: 'NBA-ROLE-SHIFT', version: '0.1', status: 'EXPERIMENTAL',
  regime: 'injury_conditioned', default_regime: 'projected',
  statuses: ['OUT', 'DOUBTFUL'],
  top_n: 8,                 /* the rotation: reference minutes, nba/roster_inputs.json */
  k_games: 10,              /* shrinkage toward WITH */
  p3_prior_attempts: 100,   /* 3P% shrinkage toward the league */
  max_teammates: 4, min_teammates: 3,
  min_minutes: 8,           /* the props slate's own floor (build_props.js) */
  lines_each_side: 5,
  seasons: 2,               /* this season and last */
});
/* the volume markets the role-shift pull buys (supabase/odds_api_gateway.sql nba_role_props) */
const MARKETS = { reb: 'player_rebounds', ast: 'player_assists', fg3m: 'player_threes', pra: 'player_points_rebounds_assists' };
const SPLIT_KEYS = ['min', 'pts', 'reb', 'ast', 'fga', 'fta', 'tov', 'fg3a', 'fg3m', 'usage'];
const RATE_KEYS = { pts: 'pts', reb: 'reb', ast: 'ast', fga: 'fga', fg3a: 'fg3a', tov: 'tov' };

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/* one player-game row (nba/ingest/season.js, edgedesk_nba_player_games_v2) as the split's numbers */
function vals(r) {
  const fga = r.fga || 0, fta = r.fta || 0, tov = r.tov || 0;
  return { min: r.min || 0, pts: r.pts || 0, reb: (r.or || 0) + (r.dr || 0), ast: r.ast || 0, fga, fta, tov, fg3a: r.f3a || 0, fg3m: r.f3m || 0, usage: fga + 0.44 * fta + tov };
}
const zero = () => Object.fromEntries(SPLIT_KEYS.map((k) => [k, 0]).concat([['g', 0]]));
function add(a, v) { a.g++; for (const k of SPLIT_KEYS) a[k] += v[k]; }

/**
 * A team's games in order, each with its listed players: { order: [game_id], rows: Map(game_id → Map(pid → row)) }.
 * rows: player-game rows of this season and last; games: [{ game_id, start_ms }]
 */
function teamIndex(rows, games, tm) {
  const at = new Map(games.map((g) => [String(g.game_id), g.start_ms]));
  const by = new Map();
  for (const r of rows) {
    if (String(r.tm) !== String(tm)) continue;
    const g = String(r.g);
    if (!by.has(g)) by.set(g, new Map());
    by.get(g).set(String(r.p), r);
  }
  const order = [...by.keys()].filter((g) => at.has(g)).sort((a, b) => at.get(a) - at.get(b));
  return { order, rows: by };
}
/* the games the absent player was on this team for: from his first row for it to his last, and on to
   today when he is in its rotation now (an injured player is often not in the box at all) */
function onTeam(T, absent, onNow) {
  const idx = T.order.map((g, i) => (T.rows.get(g).has(String(absent)) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return new Set();
  const hi = onNow ? T.order.length - 1 : idx[idx.length - 1];
  return new Set(T.order.slice(idx[0], hi + 1));
}
const played = (r) => !!(r && r.pl && (r.min || 0) > 0);
/**
 * The game-level split of one teammate on one absent player: his games WITH and WITHOUT him while both
 * were on the team. → { with, without } sums (g = games), plus the games themselves.
 */
function splits(T, absent, mate, onNow) {
  const team = onTeam(T, absent, onNow);
  const w = zero(), wo = zero(), withGames = [];
  for (const g of T.order) {
    if (!team.has(g)) continue;
    const rows = T.rows.get(g), m = rows.get(String(mate));
    if (!played(m)) continue;
    if (played(rows.get(String(absent)))) { add(w, vals(m)); withGames.push(g); } else add(wo, vals(m));
  }
  return { with: w, without: wo, with_games: withGames };
}
/* (n_without × without + k × with) / (n_without + k); WITH alone when there is no game without him */
function shrink(withV, woV, nWo, k) { return withV == null ? null : woV == null || !(nWo > 0) ? withV : (nWo * woV + k * withV) / (nWo + k); }
const perGame = (a, k) => (a.g > 0 ? a[k] / a.g : null);
const perMin = (a, k) => (a.min > 0 ? a[k] / a.min : null);

/* his 3P% shrunk toward the league's with 100 attempts */
function threePct(own, league, prior) { return (own.fg3m + prior * league) / (own.fg3a + prior); }

/* the model's stat entry on a set of minutes nodes (nba/props/model.js predict: mixture moments) */
function entry(lam, a, b, nodes) {
  const means = nodes.map((x) => lam * x), mu = avg(means);
  const v = avg(means.map((x) => a * x + b * x * x)) + avg(means.map((x) => (x - mu) * (x - mu)));
  return { mu, var: v, r: PM.nbFromMoments(mu, v).r, lam, a, b, mean_minutes: avg(nodes) };
}
/**
 * The injury-conditioned prediction: the default prediction (PM.predict) moved by the shrunk splits.
 * The same structure as PM.predict's, so PM.statDist / PM.comboDist price it unchanged.
 */
function regimePredict(model, pred0, sp, p3) {
  const k = RULES.k_games, W = sp.with, WO = sp.without, n = WO.g;
  const minWith = perGame(W, 'min'), minShr = shrink(minWith, perGame(WO, 'min'), n, k);
  const dMin = minWith == null ? 0 : minShr - minWith;
  const mu = clamp(pred0.min.mu + dMin, 1, 44);
  const bands = model.minutes.sd_bands; let b = 0;
  for (let i = 0; i < bands.length - 1; i++) if (mu >= bands[i] && mu < bands[i + 1]) b = i;
  const q = model.minutes.q ? model.minutes.q[b] : pred0.min.nodes.map((x) => x - pred0.min.mu);
  const nodes = q.map((e) => clamp(mu + e, 0.5, 53));
  const ratio = {};
  for (const key of Object.keys(RATE_KEYS)) {
    const rw = perMin(W, key), rwo = perMin(WO, key);
    ratio[key] = rw > 0 ? shrink(rw, rwo, n, k) / rw : 1;
  }
  const stat = {};
  for (const key of Object.keys(pred0.stat)) {
    const s = pred0.stat[key];
    stat[key] = entry(s.lam * (ratio[key] || 1), s.a, s.b, nodes);
  }
  /* 3-pointers made = the regime's attempts × his shrunk 3P% */
  if (stat.fg3a && stat.fg3m) stat.fg3m = entry(stat.fg3a.lam * p3, pred0.stat.fg3m.a, pred0.stat.fg3m.b, nodes);
  return { min: { mu, sd: model.minutes.sd[b], nodes }, stat, minutes_delta: dMin, ratio };
}

/* the market's distribution under a prediction */
function dist(model, pred, m) { return m === 'pra' ? PM.comboDist(model, pred, ['pts', 'reb', 'ast']) : PM.statDist(pred, m); }
function meanOf(d) { let s = 0; for (let i = 0; i < d.pmf.length; i++) s += (d.lo + i) * d.pmf[i]; return s; }
/* P(over) at every half-point line within lines_each_side of the mean; the fair line is the one nearest 50% */
function ladder(d) {
  const mu = meanOf(d), c = Math.floor(mu), over = {};
  let fair = null, best = 2;
  for (let L = Math.max(0, c - RULES.lines_each_side) + 0.5; L <= c + RULES.lines_each_side + 0.5; L++) {
    const p = DIST.pGreater(d, L); over[L.toFixed(1)] = r4(p);
    if (Math.abs(p - 0.5) < best) { best = Math.abs(p - 0.5); fair = L; }
  }
  const pf = over[fair.toFixed(1)];
  return { mean: r2(mu), fair_line: fair, fair_over: DIST.probToAmerican(pf), fair_under: DIST.probToAmerican(1 - pf), over };
}

/* ---------------------------------------------------------------- the stint cross-check */
/**
 * Per game: the team side's five-man stints and its players' shots in time order.
 * stintsWork: { games: [{ g, s: [[t0, t1, h5, a5, …, ok]] }] }; shotsWork: { rows: [[g, per, t, tm, sh, mk, v, ast, …]] }
 */
function stintIndex(stintsWork, shotsWork, games) {
  const G = new Map();
  const meta = new Map(games.map((g) => [String(g.game_id), g]));
  for (const x of (stintsWork && stintsWork.games) || []) { const m = meta.get(String(x.g)); if (m) G.set(String(x.g), { home: String(m.home_id), away: String(m.away_id), s: x.s, shots: [] }); }
  for (const r of (shotsWork && shotsWork.rows) || []) { const x = G.get(String(r[0])); if (x) x.shots.push(r); }
  for (const x of G.values()) x.shots.sort((a, b) => a[2] - b[2]);
  return G;
}
function stintCheck(G, tm, absent, mate, games) {
  const A = String(absent), M = String(mate), z = () => ({ secs: 0, msecs: 0, stints: 0, fga: 0, fg3a: 0, ast: 0 });
  const on = z(), off = z();
  for (const g of games) {
    const x = G.get(String(g)); if (!x) continue;
    const col = x.home === String(tm) ? 2 : x.away === String(tm) ? 3 : -1; if (col < 0) continue;
    let j = 0;
    for (const s of x.s) {
      if (!s[14]) continue;
      const five = String(s[col]).split(' '), t0 = s[0], t1 = s[1], dur = Math.max(0, t1 - t0);
      const grp = five.indexOf(A) >= 0 ? on : off;
      grp.secs += dur;
      const has = five.indexOf(M) >= 0;
      if (has) { grp.msecs += dur; grp.stints++; }
      while (j < x.shots.length && x.shots[j][2] < t0) j++;
      for (let i = j; i < x.shots.length && x.shots[i][2] < t1; i++) {
        const sh = x.shots[i]; if (String(sh[3]) !== String(tm) || !has) continue;
        if (String(sh[4]) === M) { grp.fga++; if (sh[6] === 3) grp.fg3a++; }
        if (sh[5] && String(sh[7]) === M) grp.ast++;
      }
    }
  }
  if (!(on.secs > 0 && off.secs > 0)) return { sample: off.stints, games: games.length, available: false };
  const shareOn = on.msecs / on.secs, shareOff = off.msecs / off.secs, shareAll = (on.msecs + off.msecs) / (on.secs + off.secs);
  const per36 = (a, k) => (a.msecs > 0 ? r2(a[k] * 36 * 60 / a.msecs) : null);
  return { available: true, games: games.length, sample: off.stints, seconds_off: Math.round(off.msecs), share_with: r4(shareOn), share_without: r4(shareOff),
    minutes_delta: r2(48 * (shareOff - shareAll)),
    per36: { fga: [per36(on, 'fga'), per36(off, 'fga')], fg3a: [per36(on, 'fg3a'), per36(off, 'fg3a')], ast: [per36(on, 'ast'), per36(off, 'ast')] } };
}

/* ---------------------------------------------------------------- one scenario */
const topByMinutes = (ref, n) => (ref || []).slice().sort((a, b) => (b.minutes || 0) - (a.minutes || 0)).slice(0, n);
/**
 * scenario(o): o = { model, game (roster_inputs game), side, absent ({ id, name, minutes }), mates ([{ id, name, f, pred }]),
 *   T (teamIndex), G (stintIndex), p3: Map(pid → shrunk 3P%), onNow }
 */
function scenario(o) {
  const tm = String(o.game[o.side].id), A = String(o.absent.id);
  const base = { absent: { id: A, name: o.absent.name, team_id: tm, team: o.game[o.side].abbr || null, reference_minutes: r2(o.absent.minutes) }, regime: RULES.regime };
  const me = o.mates.find((m) => String(m.id) === A);
  if (!me) return Object.assign(base, { skipped: 'not in the projected rotation: the default already prices his team without him' });
  if (!me.f.in_last) return Object.assign(base, { skipped: 'did not play his team\'s last game: the default already prices his team without him' });
  const rows = [];
  for (const m of o.mates) {
    if (String(m.id) === A) continue;
    const sp = splits(o.T, A, m.id, o.onNow);
    const row = { id: String(m.id), name: m.name, minutes_default: r2(m.pred.min.mu), games_with: sp.with.g, games_without: sp.without.g };
    if (!sp.with.g) { rows.push(Object.assign(row, { skipped: 'no game with him in the window: nothing to compare' })); continue; }
    const rp = regimePredict(o.model, m.pred, sp, o.p3.get(String(m.id)));
    const uW = perGame(sp.with, 'usage'), uR = shrink(uW, perGame(sp.without, 'usage'), sp.without.g, RULES.k_games);
    const st = stintCheck(o.G, tm, A, m.id, sp.with_games);
    Object.assign(row, { minutes_regime: r2(rp.min.mu), minutes_delta: r2(rp.minutes_delta), usage_with: r2(uW), usage_regime: r2(uR), usage_delta: r2(uR - uW),
      stints: st, stints_agree: st.available ? (Math.abs(st.minutes_delta) < 1 && Math.abs(rp.minutes_delta) < 1) || Math.sign(st.minutes_delta) === Math.sign(rp.minutes_delta) : null });
    /* the default beside it, with 3PM made the same way (attempts x shrunk 3P%), so a change is the absence's alone */
    row._pred = rp; row._base = regimePredict(o.model, m.pred, { with: sp.with, without: zero(), with_games: [] }, o.p3.get(String(m.id))); row._m = m;
    rows.push(row);
  }
  /* the 3-4 with the largest minutes or usage change */
  const score = (r) => Math.max(r.minutes_delta || 0, r.usage_delta || 0);
  const ranked = rows.filter((r) => !r.skipped && score(r) > 0).sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
  const priced = ranked.slice(0, RULES.max_teammates);
  for (const r of priced) {
    r.priced = true;
    r.markets = {};
    for (const m of Object.keys(MARKETS)) {
      const dDef = dist(o.model, r._base, m), dReg = dist(o.model, r._pred, m);
      r.markets[m] = Object.assign({ market: MARKETS[m], default_mean: r2(meanOf(dDef)) }, ladder(dReg));
    }
  }
  for (const r of rows) { delete r._pred; delete r._base; delete r._m; }
  rows.sort((a, b) => (b.minutes_delta || -99) - (a.minutes_delta || -99));
  return Object.assign(base, { priced: priced.map((r) => r.id), short_of_three: priced.length < RULES.min_teammates, teammates: rows });
}

/**
 * build(o) → the role-shift file.
 * o = { model (PM.fit), upcoming (state.js run().upcoming), inputs (nba/roster_inputs.json), players (id → { name }),
 *       rows (player-game rows, this season and last), games ([{ game_id, start_ms, home_id, away_id }]),
 *       stints ([stints work per season]), shots ([shots work per season]), season, props_generated_at, now }
 */
function build(o) {
  const now = o.now || new Date().toISOString();
  const lg = o.rows.reduce((a, r) => { a.m += r.f3m || 0; a.a += r.f3a || 0; return a; }, { m: 0, a: 0 });
  const league3 = lg.a > 0 ? lg.m / lg.a : 0.36;
  const own = new Map();
  for (const r of o.rows) { if (!r.pl) continue; const k = String(r.p); const x = own.get(k) || { fg3m: 0, fg3a: 0 }; x.fg3m += r.f3m || 0; x.fg3a += r.f3a || 0; own.set(k, x); }
  const p3 = new Map([...own].map(([k, x]) => [k, threePct(x, league3, RULES.p3_prior_attempts)]));
  const p3Of = { get: (k) => (p3.has(k) ? p3.get(k) : league3) };
  const G = new Map();
  (o.stints || []).forEach((sw, i) => { for (const [k, v] of stintIndex(sw, (o.shots || [])[i], o.games)) G.set(k, v); });
  const byGame = new Map();
  for (const u of o.upcoming || []) {
    if (!(u.f && u.f.min_ew >= RULES.min_minutes)) continue;
    const k = String(u.g) + '|' + String(u.tm);
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push({ id: String(u.p), name: ((o.players || {})[u.p] || {}).name || String(u.p), f: u.f, pred: u.pred || PM.predict(o.model, u.f) });
  }
  const idx = new Map();
  const games = ((o.inputs && o.inputs.games) || []).map((g) => {
    const scenarios = [];
    for (const side of ['home', 'away']) {
      const tm = String(g[side].id);
      if (!idx.has(tm)) idx.set(tm, teamIndex(o.rows, o.games, tm));
      const mates = byGame.get(String(g.game_id) + '|' + tm) || [];
      const rotation = (g.reference && g.reference[side]) || [];
      for (const a of topByMinutes(rotation, RULES.top_n)) {
        scenarios.push(scenario({ model: o.model, game: g, side, absent: a, mates, T: idx.get(tm), G, p3: p3Of, onNow: true }));
      }
    }
    return { game_id: String(g.game_id), start_utc: g.start_utc, home: g.home, away: g.away, scenarios };
  });
  return { schema: 'edgedesk_nba_role_shift_v1', generated_at: now, season: o.season, props_generated_at: o.props_generated_at || null,
    inputs_generated_at: (o.inputs && o.inputs.generated_at) || null,
    model: { key: RULES.model_key, version: RULES.version, status: RULES.status, regime: RULES.regime, default_regime: RULES.default_regime },
    rules: RULES, markets: MARKETS, league_three_pct: r4(league3),
    note: 'EXPERIMENTAL research. Each scenario is what EdgeDesk\'s props model says when one rotation player is out: his teammates\' minutes, usage and volume props, from their games without him (this season and last, shrunk toward their games with him by ' + RULES.k_games + ' games). The default props (nba/props_slate.json) are unchanged. Fair lines, not prices, and not advice.',
    games };
}

module.exports = { RULES, MARKETS, vals, teamIndex, onTeam, splits, shrink, threePct, regimePredict, ladder, stintIndex, stintCheck, scenario, build, topByMinutes };

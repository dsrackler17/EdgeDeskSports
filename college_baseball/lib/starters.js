'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the projected starter's quality, from the
   schools' own box scores (the collegiate collector, joined to our contests
   by ingest/school_box.js), for 2013 on: the input the run model's starter
   term reads (lib/team_quality.js sp_k; research/PROTOCOL.md, amendment
   2026-10-22). Nothing here is fitted on a scored season and nothing reads
   the game it prices.

   WHO PITCHES. A college staff's weekend rotation is stable, so the starter
   is projected from the team's own recent starts: lib/pitchers.js
   projectStarter (rest days, the same weekday slot last week, the same
   weekday, recent start share, relief work in the last two days, and an
   UNSEEN alternative). The game's actual starter is never an input: the
   pitching state folds in only appearances dated before the game.

   HOW GOOD. Each candidate's run value per batter faced from his shrunk
   strikeout, walk + hit-by-pitch and hit rates (lib/pitchers.js talent:
   empirical Bayes per component, prior seasons decayed), through college
   pitching linear weights. Home runs allowed are not in an older SIDEARM
   box, so the weights here have no home-run term and hits carry it.

   THE TERM. For the staff of team T today
       delta = sum over candidates  p_i * s_i * (rv_i - rv_staff)
       q     = log(1 + delta / rv_staff)
   where p_i is the projection's probability, s_i the candidate's expected
   share of the game's outs (his shrunk outs per start / 27), and rv_staff
   the run value the team has pitched with this season (batters faced
   weighted). An unseen starter adds nothing. The model multiplies the runs
   the OPPOSING lineup is expected to score by exp(sp_k * q): a better arm
   than usual lowers them, a worse one raises them. q is null (the game is
   priced exactly as before) unless the team's last 28 days are boxed: at
   least LOCAL.min_boxed of its contests and LOCAL.share of them.

   FITTED ON THE BURN-IN ONLY. The linear weights and the projection logit
   are fitted on FIT_SEASON (2013, the burn-in), never on a season the loop
   scores.

   PEOPLE. A box names a pitcher as its scorer writes him ("Luke Matta",
   "Matta, Luke", "L. MATTA", "K. Montgomer" cut at the field width). Within
   a team, one person is one last name (a cut name joins the full one it
   starts, six letters or more) and first initial (a name without one joins
   the team's only pitcher of that last name). A pitcher who changes teams
   starts again: nothing joins people across schools.

   COVERAGE. A Division I team-season is covered when the boxes held join at
   least COVERED of its contests in our record; the learning loop keeps the
   starter term inactive until 80% of D-I team-seasons in SELECTION +
   VALIDATION are covered (college_baseball/loop.js).
   =========================================================================== */
const S = require('../../engine/stats');
const K = require('../ingest/common');
const C = require('../config');
const PI = require('./pitchers');

const FIT_SEASON = 2013;
const COVERED = 0.8;
const LOCAL = { days: 28, min_boxed: 3, share: 0.8 };
const Q_MAX = 0.5;
const OUTS = 27;

/* ------------------------------------------------------------ people */
/** give every row a person_id: team + one canonical (last name, first initial) */
function identities(rows) {
  const SB = require('../ingest/school_box');
  const byTeam = new Map();
  for (const r of rows) {
    const np = SB.nameParts(r.name);
    r._k = np && np.last ? np.last + '|' + np.initial : null;
    if (!r._k) continue;
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, new Map());
    const m = byTeam.get(r.team_id); m.set(r._k, (m.get(r._k) || 0) + 1);
  }
  const canon = new Map();
  for (const [team, keys] of byTeam) {
    const list = [...keys.keys()].map((k) => { const [last, initial] = k.split('|'); return { k, last, initial }; });
    for (const x of list) {
      let to = x;
      /* a name cut at the scorer's field width: the one longer name it starts, same initial */
      if (x.last.length >= 6) {
        const longer = list.filter((y) => y.last.length > x.last.length && y.last.startsWith(x.last) && (y.initial === x.initial || !x.initial || !y.initial));
        const lasts = [...new Set(longer.map((y) => y.last))];
        if (lasts.length === 1) to = longer.find((y) => y.initial === x.initial) || (longer.length === 1 ? longer[0] : to);
      }
      /* no initial: the team's only pitcher of that last name */
      if (!to.initial) {
        const same = list.filter((y) => y.last === to.last && y.initial);
        const inits = [...new Set(same.map((y) => y.initial))];
        if (inits.length === 1) to = same[0];
      }
      canon.set(team + '|' + x.k, to.last + '|' + to.initial);
    }
  }
  for (const r of rows) { r.person_id = r._k ? 'sb:' + r.team_id + ':' + canon.get(r.team_id + '|' + r._k) : null; delete r._k; }
  return rows;
}

/* ------------------------------------------------------------ linear weights (no home-run term) */
/** runs allowed per staff-game = b_bf BF + b_k K + b_bb (BB + HBP) + b_h H, least squares without intercept */
function fitWeights(staffGames) {
  const X = []; const y = [];
  for (const t of staffGames) { if (!t.bf) continue; X.push([t.bf, t.so, t.bb + t.hb, t.h]); y.push(t.runs); }
  if (X.length < 200) return null;
  const p = 4; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  const beta = Array.from(S.solve(A, b));
  return { per_bf: beta[0], so: beta[1], bb_hbp: beta[2], hr: 0, h_non_hr: beta[3], n: X.length, source: 'school box scores ' + FIT_SEASON + ' (no home-run term)' };
}

/* ------------------------------------------------------------ inputs */
const memo = new Map();
function seasonsTo(until) { const out = []; for (let s = FIT_SEASON; s <= until; s++) out.push(s); return out; }

/**
 * the boxes held, joined: pitcher rows with person ids, which contests are boxed, and each team-season's
 * contests and boxed contests. o: { until, gamesOf(season), boxDir, rostersDir }
 */
function inputs(o) {
  o = o || {};
  const until = o.until || C.SEASONS.last;
  const key = 'in|' + until + '|' + (o.boxDir || '');
  if (!o.gamesOf && memo.has(key)) return memo.get(key);
  const SB = require('../ingest/school_box');
  const gamesOf = o.gamesOf || ((s) => require('./warehouse').games(s));
  const rows = []; const boxed = new Set(); const ts = new Map(); const games = [];
  for (const s of seasonsTo(until)) {
    const final = gamesOf(s).filter((g) => g.status === 'FINAL');
    const j = SB.joined(s, { games: final, boxDir: o.boxDir, rostersDir: o.rostersDir });
    for (const { c } of j.list) boxed.add(c.game_id);
    for (const r of SB.pitcherRows(s, { joined: j })) rows.push(r);
    for (const g of final) {
      games.push(g);
      for (const t of [g.home_id, g.away_id]) { const k = s + ':' + t; if (!ts.has(k)) ts.set(k, [0, 0]); const v = ts.get(k); v[0]++; if (boxed.has(g.game_id)) v[1]++; }
    }
  }
  identities(rows);
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  const out = {
    until, rows, boxed, games,
    /* [contests, boxed] for one team-season */
    teamSeason: (season, team) => ts.get(season + ':' + team) || [0, 0],
    /* the share of the given [season, team_id] pairs the boxes cover (at least COVERED of their contests boxed) */
    coverage: (pairs) => { if (!pairs.length) return 0; let k = 0; for (const [s, t] of pairs) { const v = ts.get(s + ':' + t); if (v && v[0] && v[1] >= COVERED * v[0]) k++; } return k / pairs.length; },
  };
  if (!o.gamesOf) memo.set(key, out);
  return out;
}

/** a staff's runs allowed per game, from the boxed contests of one season (to fit the weights) */
function staffGames(inp, season) {
  const contest = new Map(inp.games.filter((g) => g.season === season).map((g) => [g.game_id, g]));
  const by = new Map();
  for (const r of inp.rows) {
    if (r.season !== season) continue;
    const c = contest.get(r.game_id); if (!c) continue;
    const k = r.game_id + '|' + r.team_id;
    if (!by.has(k)) by.set(k, { bf: 0, so: 0, bb: 0, hb: 0, h: 0, runs: String(r.team_id) === String(c.home_id) ? +c.away_runs : +c.home_runs });
    const t = by.get(k); t.bf += r.bf; t.so += r.so; t.bb += r.bb; t.hb += r.hb; t.h += r.h;
  }
  return [...by.values()];
}

/* the run value a team has pitched with this season, batters faced weighted (early in a season, last season's staff too) */
function staffRv(st, team, season) {
  const t = st.team.get(team); if (!t) return null;
  let w = 0; let s = 0;
  for (let i = t.apps.length - 1; i >= 0; i--) {
    const a = t.apps[i]; if (a.season !== season) break;
    const tal = st.talent(a.person, season); if (tal.rv_per_bf == null) continue;
    w += a.bf; s += a.bf * tal.rv_per_bf;
  }
  if (w < 60) for (let i = t.apps.length - 1; i >= 0 && w < 300; i--) { const a = t.apps[i]; if (a.season === season) continue; const tal = st.talent(a.person, season); if (tal.rv_per_bf == null) continue; w += a.bf; s += a.bf * tal.rv_per_bf; }
  return w ? s / w : null;
}

/* ------------------------------------------------------------ the term */
/**
 * q for every contest in the record through `until` (and on demand for a later one):
 * { of(g) -> { h, a } (each q or null), detail(g), coverage(pairs), fitted }
 */
function load(o) {
  o = o || {};
  const until = o.until || C.SEASONS.last;
  const key = 'q|' + until + '|' + (o.boxDir || '');
  if (!o.gamesOf && memo.has(key)) return memo.get(key);
  const inp = o.inputs || inputs(o);
  const lw = fitWeights(staffGames(inp, FIT_SEASON));
  let proj = null;
  if (lw) {
    const fitRows = inp.rows.filter((r) => r.season === FIT_SEASON);
    const s0 = new PI.PitchingState().loadRows(fitRows); s0.lw = lw;
    /* labels only where the team-season is covered: elsewhere its rotation is half seen and "unseen" would be learnt for it */
    const labels = fitRows.filter((r) => { const v = inp.teamSeason(r.season, r.team_id); return v[0] && v[1] >= COVERED * v[0]; });
    const f = PI.fitProjection(s0, FIT_SEASON, inp.games.filter((g) => g.season === FIT_SEASON), labels);
    if (f && f.n >= 500) proj = { cand: f.cand, unseen: f.unseen, n: f.n };
  }
  const st = new PI.PitchingState().loadRows(inp.rows); st.lw = lw; st.proj = proj;
  const hist = new Map();   /* team -> [{ date, boxed }] contests before today */
  const q = new Map(); const det = new Map();

  function side(team, season, date) {
    if (!lw) return null;
    const h = hist.get(team) || []; const from = K.addDays(date, -LOCAL.days);
    let n = 0, b = 0; for (let i = h.length - 1; i >= 0 && h[i].date >= from; i--) { n++; if (h[i].boxed) b++; }
    if (b < LOCAL.min_boxed || b < LOCAL.share * n) return null;
    const staff = staffRv(st, team, season); if (!(staff > 0)) return null;
    const pr = st.projectStarter(team, season, date);
    let delta = 0;
    for (const c of pr.candidates) { const t = st.talent(c.person, season); if (t.rv_per_bf == null) continue; delta += c.p * (Math.min(OUTS, t.exp_outs_start) / OUTS) * (t.rv_per_bf - staff); }
    const v = Math.max(-Q_MAX, Math.min(Q_MAX, Math.log(Math.max(0.05, 1 + delta / staff))));
    return { q: v, top: pr.candidates[0] ? pr.candidates[0].person : null, top_p: pr.top_p, p_unseen: pr.p_unseen, status: pr.status, rv_staff: staff };
  }
  function day(gs) {
    const d = gs[0].date; st.advance(d);
    for (const g of gs) {
      const hh = side(g.home_id, g.season, d); const aa = side(g.away_id, g.season, d);
      q.set(g.game_id, { h: hh ? hh.q : null, a: aa ? aa.q : null }); det.set(g.game_id, { h: hh, a: aa });
    }
  }
  function remember(gs) {
    for (const g of gs) for (const t of [g.home_id, g.away_id]) { if (!hist.has(t)) hist.set(t, []); hist.get(t).push({ date: g.date, boxed: inp.boxed.has(g.game_id) }); }
  }
  let i = 0; const G = inp.games;
  while (i < G.length) { let j = i; while (j < G.length && G[j].date === G[i].date) j++; const gs = G.slice(i, j); day(gs); remember(gs); i = j; }

  const out = {
    until, fitted: { linear_weights: lw, projection: proj, fit_season: FIT_SEASON }, n_rows: inp.rows.length, n_boxed: inp.boxed.size,
    /* a later game (the live board): computed as of its date from everything before it */
    of: (g) => {
      if (q.has(g.game_id)) return q.get(g.game_id);
      if (!st.date || g.date < st.date) return { h: null, a: null };
      st.advance(g.date);
      const hh = side(g.home_id, g.season, g.date); const aa = side(g.away_id, g.season, g.date);
      return { h: hh ? hh.q : null, a: aa ? aa.q : null };
    },
    detail: (g) => det.get(g.game_id) || null,
    coverage: inp.coverage,
  };
  if (!o.gamesOf) memo.set(key, out);
  return out;
}

module.exports = { load, inputs, identities, fitWeights, staffGames, FIT_SEASON, COVERED, LOCAL, Q_MAX };

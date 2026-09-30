/* ============================================================================
   PLAYER PROPS — the projection engine (docs/player-props/DESIGN.md §4).

   A projection is VOLUME × SHARE × EFFICIENCY, each adjusted for the matchup,
   the game script, the weather and who is available — and it ends in a
   DISTRIBUTION, not a number (lib/edgedesk_props.js prices the distribution).

     team volume     plays per game (recency-weighted, shrunk to the league),
                     opponent pace, pass rate = neutral pass rate − 0.6 pp per
                     point of expected margin, wind
     share           carry / target / red-zone share, recency-weighted, shrunk
                     toward the player's prior-season share on this team or a
                     depth-chart prior; teammates OUT redistribute their share
                     (a PROJECTED adjustment, printed with its size)
     efficiency      yards per carry, catch rate, yards per reception,
                     completion %, yards per completion, TD and INT rates —
                     shrunk toward the position mean by sample size
     matchup         what the opponent ALLOWED (per carry, per target by
                     position, per dropback, TDs), shrunk by the opponent's
                     sample, clamped to ±15 %
     environment     team implied points from the consensus spread and total
                     (EdgeDesk's own fair line when no market is on file)
     distribution    per market family (lib/edgedesk_props.js), widened for a
                     thin sample, then by the backtest's per-market multiplier

   Every step is recorded (`steps`) so the drawer can show the build. Nothing
   reads a sportsbook price here: the market enters only in EDProps.evaluate,
   as a declared blend.
   ========================================================================== */
'use strict';
const path = require('path');
const EDP = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_props.js'));

const MODEL_VERSION = 'edgedesk_props_model_v1';
const P = {
  hl_team: 4, hl_share: 3, prior_season_weight: 0.35, max_rows: 14,
  k_team_games: 3, k_opp_games: 5,
  k_carries_ypc: 60, k_opp_carries: 150, k_targets_catch: 30, k_rec_ypr: 25, k_opp_targets: 120,
  k_att_cmp: 120, k_cmp_ypc: 80, k_att_int: 300, k_att_td: 300, k_db_sack: 120, k_share_games: 1.5,
  script_pass_rate_per_pt: 0.006, matchup_clamp: [0.85, 1.15], wind: [[20, -0.04, 0.90], [15, -0.02, 0.95]],
  /* count dispersion (negative-binomial size) before calibration */
  size: { car: 22, tgt: 24, rec: 30, att: 70, cmp: 80, tkl: 18, fgm: 1e7 },
  param_cv: 0.30,                    /* mean uncertainty ≈ param_cv / sqrt(games + 1) */
  outs_share_kept: 0.85,             /* of an absent player's share, what reaches teammates */
  depth_prior: {
    RB: { car: [0.55, 0.26, 0.10, 0.04], tgt: [0.10, 0.05, 0.02, 0.01] },
    WR: { car: [0.01, 0.01, 0, 0, 0], tgt: [0.23, 0.18, 0.13, 0.06, 0.03] },
    TE: { car: [0, 0, 0], tgt: [0.15, 0.06, 0.02] },
    QB: { car: [0.08, 0.01, 0], tgt: [0, 0, 0] }
  },
  pos_catch: { WR: 0.64, TE: 0.72, RB: 0.78, QB: 0.5 },
  league_int_rate: 0.023, league_td_rate: 0.045, league_sack_rate: 0.065, league_scramble_rate: 0.035
};

/* ----------------------------------------------------------- helpers */
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = (x) => isNum(x) ? Math.round(x * 1000) / 1000 : null;
const r1 = (x) => isNum(x) ? Math.round(x * 10) / 10 : null;
function weights(rows, cur, hl, psw) {
  const n = rows.length, prior = isNum(psw) ? psw : P.prior_season_weight;
  return rows.map((row, i) => Math.pow(0.5, (n - 1 - i) / hl) * (row.s < cur ? prior : 1));
}

/* REGIME CHANGE (college; audit 2026-09-30 #1, #7d). A programme with a new
   head coach and a turned-over roster (football/coaching/regime.json) carries
   usage and volume priors from a system that left. The props model applies
   the SAME fitted curve the game model does (football/cfb_p4/regime_curve.js,
   fitted walk-forward on team ratings): at g games played, last season's
   weight is scaled by w_regime(g) / w_standard(g), where w_standard is the
   game model's learned prior-weight curve (params blend.prior_weight_by_week).
   It is borrowed, not fitted on props — college props have no backtest of
   their own — so the prop also carries the REGIME_CHANGE cap (no BET before
   the team has played the curve's min_games_for_research). */
let REGIME_LIB;
function regimeLib() {
  if (REGIME_LIB === undefined) {
    let curve = null, standard = null;
    try { curve = require(path.join(__dirname, '..', 'cfb_p4', 'regime_curve.js')); } catch (e) { curve = null; }
    try { const Pp = require(path.join(__dirname, '..', 'cfb_p4', 'params.js')); standard = Pp && Pp.blend ? Pp.blend.prior_weight_by_week || null : null; } catch (e) { standard = null; }
    REGIME_LIB = { curve: curve && curve.curve ? curve : null, standard };
  }
  return REGIME_LIB;
}
function regimeState(rec, gamesPlayed) {
  if (!rec || rec.regime_change !== true) return null;
  const L = regimeLib(), g = Math.max(0, isNum(gamesPlayed) ? gamesPlayed : 0);
  const std = L.standard ? L.standard[String(clamp(Math.round(g), 0, 15))] : null;
  const cv = L.curve ? L.curve.curve : null;
  const w = cv && isNum(std) ? Math.min(std, cv.w0 * Math.exp(-cv.lambda * g)) : null;
  return { regime_change: true, team: rec.team || rec.key || null, reason: rec.reason || null, games_played: g,
    min_games_for_research: isNum(rec.min_games_for_research) ? rec.min_games_for_research : (L.curve && isNum(L.curve.min_games_for_research) ? L.curve.min_games_for_research : null),
    standard_weight: isNum(std) ? r3(std) : null, regime_weight: isNum(w) ? r3(w) : null,
    prior_scale: isNum(w) && isNum(std) && std > 0 ? w / std : 1, curve_version: L.curve ? L.curve.version || null : null };
}
function wsum(rows, w, f) { let s = 0; for (let i = 0; i < rows.length; i++) { const v = f(rows[i]); if (isNum(v)) s += w[i] * v; } return s; }
function shrinkRate(num, den, k, prior) { return (num + k * prior) / (den + k); }
function factorOf(allowed, league) { return isNum(allowed) && isNum(league) && league > 0 ? clamp(allowed / league, P.matchup_clamp[0], P.matchup_clamp[1]) : 1; }

/* =================================================================== CONTEXT
   Everything about the league, the teams and the defences as of a cutoff
   (strictly before it): the backtest builds one per week, the live board one
   per build. */
function prepare(ds, cutoff, opts) {
  opts = opts || {};
  const cur = ds.season;
  const before = (row) => row.date && row.date < cutoff;
  const teamRows = {};
  Object.keys(ds.teams).forEach((t) => { teamRows[t] = ds.teams[t].filter(before).slice(-P.max_rows); });
  const allRows = [].concat(...Object.values(teamRows));
  /* the league, weighted current season 1, prior season psw */
  const lw = allRows.map((r) => r.s < cur ? P.prior_season_weight : 1);
  const L = (f) => wsum(allRows, lw, f);
  const games = L(() => 1) || 1;
  const league = {
    plays: L((r) => r.plays) / games, db: L((r) => r.db) / games, dr: L((r) => r.dr) / games, att: L((r) => r.att) / games,
    pts: L((r) => r.pts) / games, ypc: L((r) => r.ryd) / Math.max(1, L((r) => r.dr)), cmp_rate: L((r) => r.cmp) / Math.max(1, L((r) => r.att)),
    ypcmp: L((r) => r.pyd) / Math.max(1, L((r) => r.cmp)), ypdb: L((r) => r.pyd_net) / Math.max(1, L((r) => r.db)),
    sack_rate: L((r) => r.sk) / Math.max(1, L((r) => r.db)), hit_rate: L((r) => r.qbh) / Math.max(1, L((r) => r.db)),
    int_rate: L((r) => r.int) / Math.max(1, L((r) => r.att)), rush_epa: L((r) => r.rush_epa) / Math.max(1, L((r) => r.dr)),
    pass_epa: L((r) => r.pass_epa) / Math.max(1, L((r) => r.db)), expl_rush: L((r) => r.expl_rush) / Math.max(1, L((r) => r.dr)),
    expl_pass: L((r) => r.expl_pass) / Math.max(1, L((r) => r.db)), rtd: L((r) => r.rtd) / games, ptd: L((r) => r.ptd) / games,
    neutral_db: L((r) => r.db_neutral) / Math.max(1, L((r) => r.n_neutral)), succ_rush: L((r) => r.rush_succ) / Math.max(1, L((r) => r.dr)),
    succ_pass: L((r) => r.pass_succ) / Math.max(1, L((r) => r.db))
  };
  league.td_per_pt = (league.rtd + league.ptd) / Math.max(1, league.pts);
  league.rush_td_frac = league.rtd / Math.max(0.01, league.rtd + league.ptd);
  league.pos = {};
  ['RB', 'WR', 'TE'].forEach((p) => {
    const tgt = L((r) => r.pos && r.pos[p] ? r.pos[p].tgt : 0), rec = L((r) => r.pos && r.pos[p] ? r.pos[p].rec : 0), yd = L((r) => r.pos && r.pos[p] ? r.pos[p].yd : 0);
    league.pos[p] = { ypt: yd / Math.max(1, tgt), ypr: yd / Math.max(1, rec), catch: rec / Math.max(1, tgt) };
  });
  league.implied = league.pts;

  /* each team's offence */
  const team = {};
  Object.keys(teamRows).forEach((t) => {
    const rows = teamRows[t]; if (!rows.length) return;
    /* a regime-change programme's prior-season volume is scaled by the regime curve */
    const rg = regimeState((ds.regime || {})[t], rows.filter((r) => r.s === cur).length);
    const w = weights(rows, cur, P.hl_team, rg ? P.prior_season_weight * rg.prior_scale : null), n = w.reduce((a, b) => a + b, 0);
    const sh = (f, lg) => (wsum(rows, w, f) + P.k_team_games * lg) / (n + P.k_team_games);
    const neutralN = wsum(rows, w, (r) => r.n_neutral), neutralDb = wsum(rows, w, (r) => r.db_neutral);
    const proe = wsum(rows, w, (r) => r.proe_n) / Math.max(1, neutralN);
    const rushTd = wsum(rows, w, (r) => r.rtd), passTd = wsum(rows, w, (r) => r.ptd);
    team[t] = {
      games: rows.length, cur_games: rows.filter((r) => r.s === cur).length,
      plays: sh((r) => r.plays, league.plays), pts: sh((r) => r.pts, league.pts),
      neutral_db: (neutralDb + 20 * league.neutral_db) / (neutralN + 20), proe: r3(proe),
      db_rate: (wsum(rows, w, (r) => r.db) + P.k_team_games * league.db) / (wsum(rows, w, (r) => r.plays) + P.k_team_games * league.plays),
      sack_rate: shrinkRate(wsum(rows, w, (r) => r.sk), wsum(rows, w, (r) => r.db), P.k_db_sack, league.sack_rate),
      rush_td_frac: (rushTd + 6 * league.rush_td_frac) / (rushTd + passTd + 6),
      rz_dr: wsum(rows, w, (r) => r.rz_dr) / n, gl_dr: wsum(rows, w, (r) => r.gl_dr) / n, rz_att: wsum(rows, w, (r) => r.rz_att) / n,
      last_gid: rows[rows.length - 1].gid, regime: rg
    };
  });
  /* each defence: what its opponents did against it */
  const def = {};
  const oppRows = {};
  allRows.forEach((r) => { if (r.op) (oppRows[r.op] = oppRows[r.op] || []).push(r); });
  Object.keys(oppRows).forEach((d) => {
    const rows = oppRows[d].sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(-P.max_rows);
    const w = weights(rows, cur, P.hl_team), n = w.reduce((a, b) => a + b, 0);
    const S = (f) => wsum(rows, w, f);
    const drN = S((r) => r.dr), dbN = S((r) => r.db), attN = S((r) => r.att), cmpN = S((r) => r.cmp);
    const pos = {};
    ['RB', 'WR', 'TE'].forEach((p) => {
      const tg = S((r) => r.pos && r.pos[p] ? r.pos[p].tgt : 0), yd = S((r) => r.pos && r.pos[p] ? r.pos[p].yd : 0), rc = S((r) => r.pos && r.pos[p] ? r.pos[p].rec : 0);
      pos[p] = { ypt: shrinkRate(yd, tg, 40, league.pos[p].ypt), catch: shrinkRate(rc, tg, 40, league.pos[p].catch), ypr: shrinkRate(yd, rc, 30, league.pos[p].ypr), tgt_pg: tg / Math.max(0.01, n) };
    });
    def[d] = {
      games: rows.length, cur_games: rows.filter((r) => r.s === cur).length,
      plays: (S((r) => r.plays) + P.k_opp_games * league.plays) / (n + P.k_opp_games),
      ypc: shrinkRate(S((r) => r.ryd), drN, P.k_opp_carries, league.ypc),
      ypdb: shrinkRate(S((r) => r.pyd_net), dbN, 150, league.ypdb),
      cmp_rate: shrinkRate(S((r) => r.cmp), attN, 150, league.cmp_rate),
      ypcmp: shrinkRate(S((r) => r.pyd), cmpN, 100, league.ypcmp),
      sack_rate: shrinkRate(S((r) => r.sk), dbN, 150, league.sack_rate),
      hit_rate: shrinkRate(S((r) => r.qbh), dbN, 150, league.hit_rate),
      int_rate: shrinkRate(S((r) => r.int), attN, 300, league.int_rate),
      rush_epa: shrinkRate(S((r) => r.rush_epa), drN, 150, league.rush_epa),
      pass_epa: shrinkRate(S((r) => r.pass_epa), dbN, 150, league.pass_epa),
      expl_rush: shrinkRate(S((r) => r.expl_rush), drN, 150, league.expl_rush),
      expl_pass: shrinkRate(S((r) => r.expl_pass), dbN, 150, league.expl_pass),
      succ_rush: shrinkRate(S((r) => r.rush_succ), drN, 150, league.succ_rush),
      succ_pass: shrinkRate(S((r) => r.pass_succ), dbN, 150, league.succ_pass),
      rtd_pg: (S((r) => r.rtd) + P.k_opp_games * league.rtd) / (n + P.k_opp_games),
      ptd_pg: (S((r) => r.ptd) + P.k_opp_games * league.ptd) / (n + P.k_opp_games),
      pts_pg: (S((r) => r.pts) + P.k_opp_games * league.pts) / (n + P.k_opp_games),
      pos: pos
    };
  });
  /* ranks: 1 = allows the least (the stingiest defence) */
  const ranks = {};
  const rankBy = (key, get, higherIsBetterForDefense) => {
    const ts = Object.keys(def).filter((t) => team[t]);
    const vals = ts.map((t) => [t, get(def[t])]).filter((x) => isNum(x[1]));
    vals.sort((a, b) => higherIsBetterForDefense ? b[1] - a[1] : a[1] - b[1]);
    vals.forEach((x, i) => { (ranks[x[0]] = ranks[x[0]] || {})[key] = { rank: i + 1, of: vals.length, value: x[1] }; });
  };
  rankBy('ypc', (d) => d.ypc); rankBy('rush_epa', (d) => d.rush_epa); rankBy('expl_rush', (d) => d.expl_rush); rankBy('succ_rush', (d) => d.succ_rush);
  rankBy('ypdb', (d) => d.ypdb); rankBy('pass_epa', (d) => d.pass_epa); rankBy('expl_pass', (d) => d.expl_pass); rankBy('cmp_rate', (d) => d.cmp_rate);
  rankBy('pressure', (d) => d.hit_rate, true); rankBy('sack_rate', (d) => d.sack_rate, true); rankBy('int_rate', (d) => d.int_rate, true);
  rankBy('rtd_pg', (d) => d.rtd_pg); rankBy('ptd_pg', (d) => d.ptd_pg); rankBy('pts_pg', (d) => d.pts_pg); rankBy('plays', (d) => d.plays);
  ['RB', 'WR', 'TE'].forEach((p) => rankBy('ypt_' + p, (d) => d.pos[p].ypt));
  /* per-event shapes: the league's own per-play yard tables, registered by
     name so a longest-play distribution references one table */
  const fits = ds.event_fits || {};
  const shapes = {};
  const reg = (name, fit) => { if (fit && fit.shape && EDP.registerShape(name, Object.assign({ source: 'league per-play yards, ' + fit.n + ' plays' }, fit.shape))) shapes[name] = Object.assign({ source: 'league per-play yards, ' + fit.n + ' plays' }, fit.shape); };
  const SL = ds.shape_league || ds.league;
  Object.keys(fits.rush || {}).forEach((pg) => reg(SL + '.rush.' + pg, fits.rush[pg]));
  Object.keys(fits.rec || {}).forEach((pg) => reg(SL + '.rec.' + pg, fits.rec[pg]));
  reg(SL + '.cmp', fits.cmp);
  const calib = opts.calibration && opts.calibration.markets ? opts.calibration.markets : {};
  return { ds, cutoff, cur, league, team, def, ranks, fits, shapes, shape_league: SL, caps: Object.assign({ targets: true, snaps: true, pbp: true, injuries: true, depth: true }, ds.caps || {}), calib, teamRows, opts };
}

/* ================================================================ PLAYER */
function teamRowOf(ctx, tm, gid) {
  const rows = ctx.ds.teams[tm] || [];
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].gid === gid) return rows[i];
  return null;
}
/* the player's logs before the cutoff, each with its team's row */
function history(ctx, p) {
  const memo = ctx._hist || (ctx._hist = new Map());
  if (memo.has(p.id)) return memo.get(p.id);
  const h = historyRaw(ctx, p); memo.set(p.id, h); return h;
}
function teamPlayers(ctx, tm) {
  const memo = ctx._tp || (ctx._tp = {});
  if (!memo[tm]) memo[tm] = Object.values(ctx.ds.players).filter((q) => q.team === tm || (q.logs.length && q.logs[q.logs.length - 1].tm === tm));
  return memo[tm];
}
function historyRaw(ctx, p) {
  return (p.logs || []).filter((l) => l.date && l.date < ctx.cutoff && (l.st === 'REG' || l.st === 'POST' || !l.st)).map((l) => ({ l, T: teamRowOf(ctx, l.tm, l.gid) })).filter((x) => x.T);
}
function playedIn(l) { return (l.snp != null ? l.snp > 0 : true) && (l.car + l.tgt + l.att + (l.tkl || 0) + (l.ast || 0) + (l.fga || 0) + (l.xpm || 0) > 0 || (l.snp || 0) > 0); }

/* weighted share and its trend, conditional on the player playing */
function shareStats(rows, cur, num, den) {
  const use = rows.filter((x) => playedIn(x.l) && den(x) > 0);
  if (!use.length) return { share: null, n: 0, l3: null, season: null, games: 0 };
  const w = weights(use.map((x) => x.l), cur, P.hl_share);
  const s = wsum(use, w, (x) => num(x)), d = wsum(use, w, (x) => den(x));
  const curRows = use.filter((x) => x.l.s === cur), l3 = use.slice(-3);
  const ratio = (rs) => { const a = rs.reduce((t, x) => t + num(x), 0), b = rs.reduce((t, x) => t + den(x), 0); return b > 0 ? a / b : null; };
  return { share: d > 0 ? s / d : null, n: w.reduce((a, b) => a + b, 0), l3: ratio(l3), season: curRows.length ? ratio(curRows) : null, games: curRows.length, all_games: use.length };
}
function depthRank(ctx, tm, pos, id) {
  const d = (ctx.ds.depth || {})[tm]; if (!d || !d[pos]) return null;
  const i = d[pos].findIndex((x) => x.id === id); return i < 0 ? null : i + 1;
}

/* who is out for this game: the official report's OUT / DOUBTFUL for the
   game's week (live), or the teammates who did not play (backtest) */
function absencesFor(ctx, tm, game) {
  const out = {};
  if (ctx.opts.absent && ctx.opts.absent[tm]) { ctx.opts.absent[tm].forEach((id) => { out[id] = 'OUT'; }); return out; }
  const inj = ctx.ds.injuries || {};
  Object.keys(inj.by_player || {}).forEach((id) => {
    const x = inj.by_player[id];
    if (x.team !== tm || !game || x.week !== game.week) return;
    const st = String(x.status || '').toUpperCase();
    if (st === 'OUT' || st === 'DOUBTFUL') out[id] = st;
  });
  return out;
}
/* THE REPORT ON FILE IS A TEAM'S OWN (audit 2026-09-30 #7). Teams publish
   on their own game's schedule: on the Wednesday of week 4 the Thursday
   teams (PIT, CLE) had their week-4 report on file and the other thirty were
   still on week 3. "On file" used to mean "any team has a report for this
   week", so every Sunday team read as reported; and a teammate the week-3
   report had OUT was absent from this week's list — so he read as BACK. */
function teamReportWeek(inj, tm) {
  if (!inj || !tm) return null;
  if (inj.team_week && inj.team_week[tm] != null) return inj.team_week[tm];
  let w = null;
  Object.keys(inj.by_player || {}).forEach((id) => { const y = inj.by_player[id]; if (y.team === tm && y.week != null && (w == null || y.week > w)) w = y.week; });
  return w;
}
function statusFor(ctx, id, game, tm) {
  if (ctx.opts.absent) return { status: null, practice: null, on_file: true };
  const inj = ctx.ds.injuries || {}, x = (inj.by_player || {})[id];
  const team = tm || (x && x.team) || ((ctx.ds.players || {})[id] || {}).team || null;
  const reportWeek = !!(inj.published && game && teamReportWeek(inj, team) === game.week);
  if (!x || !game || x.week !== game.week) {
    const o = { status: null, practice: null, injury: null, on_file: reportWeek };
    /* the player himself was listed on an EARLIER report and his team has not
       filed this week's: his status is pending, not clean */
    if (x && game && !reportWeek && x.team === team && x.week != null && x.week < game.week) {
      const st = String(x.status || '').toUpperCase();
      if (st === 'OUT' || st === 'DOUBTFUL' || st === 'QUESTIONABLE') o.pending = { status: st, week: x.week, injury: x.injury || null };
    }
    return o;
  }
  return { status: x.status ? String(x.status).toUpperCase() : null, practice: x.practice || null, injury: x.injury || null, on_file: true };
}
/* teammates the LAST report on file listed OUT or DOUBTFUL, on a team whose
   report for this game's week is not yet published: neither out nor back.
   They are never read as returned (no dilution) nor as out (no share moved);
   the prop carries the open question instead (teammate_uncertain). */
const SHARE_POS = { QB: 1, RB: 1, WR: 1, TE: 1 };
function pendingFor(ctx, tm, game) {
  const out = {};
  if (ctx.opts.absent || !game) return out;
  const inj = ctx.ds.injuries || {};
  if (!inj.published) return out;
  const wk = teamReportWeek(inj, tm);
  if (wk == null || wk >= game.week) return out;
  Object.keys(inj.by_player || {}).forEach((id) => {
    const x = inj.by_player[id];
    if (x.team !== tm || x.week !== wk) return;
    const st = String(x.status || '').toUpperCase();
    if (st !== 'OUT' && st !== 'DOUBTFUL') return;
    const q = ctx.ds.players[id], pos = (q && q.pg) || String(x.position || '').toUpperCase();
    if (!SHARE_POS[pos]) return;
    out[id] = { status: st, week: wk, name: (q && q.name) || x.name || id, pos };
  });
  return out;
}
/* THE OPPONENT'S DEFENSIVE AVAILABILITY (audit 2026-09-30 #7c). Not a model
   input: the projection's defensive factors are the defence's season-to-date
   rates, whoever played. What the latest report on file lists as OUT or
   DOUBTFUL on defence travels with the prop as a warning
   (OPP_DEFENSE_UNMODELED, lib/edgedesk_props.js). A league with no
   availability feed (college) returns null: nothing is known to flag. */
const DEF_POS = /^(DE|DT|NT|DL|EDGE|LB|ILB|OLB|MLB|CB|DB|S|FS|SS|SAF)$/;
function defenceAvailability(ctx, tm, game) {
  if (!ctx || ctx.opts.absent || ctx.caps.injuries === false || !game) return null;
  const inj = ctx.ds.injuries || {};
  if (!inj.published) return null;
  const wk = teamReportWeek(inj, tm);
  if (wk == null) return { out: [], report_week: null, report_on_file: false };
  const out = [];
  Object.keys(inj.by_player || {}).forEach((id) => {
    const x = inj.by_player[id];
    if (x.team !== tm || x.week !== wk) return;
    const st = String(x.status || '').toUpperCase();
    if (st !== 'OUT' && st !== 'DOUBTFUL') return;
    const q = ctx.ds.players[id], pos = String(x.position || (q && q.pg) || '').toUpperCase();
    if (!DEF_POS.test(pos)) return;
    out.push({ name: x.name || (q && q.name) || id, pos, status: st });
  });
  out.sort((a, b) => (a.status === b.status ? 0 : a.status === 'OUT' ? -1 : 1) || a.name.localeCompare(b.name));
  return { out, report_week: wk, report_on_file: wk === game.week };
}

/* ------------------------------------------------------------ environment */
function environment(ctx, game, tm) {
  const home = game.home === tm, opp = home ? game.away : game.home;
  let homeMargin = null, total = null, source = null;
  if (isNum(game.spread_line) && isNum(game.total_line)) { homeMargin = game.spread_line; total = game.total_line; source = 'consensus market (nflverse schedule)'; }
  else if (game.edgedesk && isNum(game.edgedesk.home_margin) && isNum(game.edgedesk.total)) { homeMargin = game.edgedesk.home_margin; total = game.edgedesk.total; source = 'EdgeDesk fair margin and total (no market on file)'; }
  else {
    const a = ctx.team[tm], b = ctx.team[opp], da = ctx.def[tm], db = ctx.def[opp];
    const pa = a && db ? (a.pts + db.pts_pg) / 2 : ctx.league.pts, pb = b && da ? (b.pts + da.pts_pg) / 2 : ctx.league.pts;
    homeMargin = home ? pa - pb : pb - pa; total = pa + pb; source = 'team scoring rates (no market or EdgeDesk line on file)';
  }
  const margin = home ? homeMargin : -homeMargin;              /* this team's expected margin */
  const implied = total / 2 + margin / 2;
  let wind = null, precip = null, dome = false, temp = null;
  const roof = String(game.roof || '').toLowerCase();
  if (roof === 'dome' || roof === 'closed') dome = true;
  if (game.forecast) { wind = game.forecast.wind_mph; precip = game.forecast.precip_in; temp = game.forecast.temp_f; if (game.forecast.dome) dome = true; }
  else if (!dome) { wind = isNum(game.wind) ? game.wind : null; temp = isNum(game.temp) ? game.temp : null; }
  if (dome) { wind = null; precip = null; }
  let passAdj = 0, ypaAdj = 1;
  if (isNum(wind)) for (const [w, pa, ya] of P.wind) if (wind >= w) { passAdj = pa; ypaAdj = ya; break; }
  if (isNum(precip) && precip >= 0.1) ypaAdj *= 0.97;
  const script = margin >= 6.5 ? 'strong positive (favoured by ' + r1(margin) + ')' : margin >= 2.5 ? 'slight positive' : margin <= -6.5 ? 'strong negative (underdog by ' + r1(-margin) + ')' : margin <= -2.5 ? 'slight negative' : 'neutral';
  return { home, opp, home_margin: r1(homeMargin), total: r1(total), margin: r1(margin), implied: r1(implied), opp_implied: r1(total - implied), source,
    wind, precip, temp, dome, roof: game.roof || null, surface: game.surface || null, pass_rate_adj: passAdj, ypa_adj: ypaAdj, script };
}

/* ================================================================ PROJECT
   One player, one game → the distribution of every market in `markets`. */
function projectPlayer(ctx, pid, game, markets, opts) {
  opts = opts || {};
  const p = ctx.ds.players[pid];
  if (!p) return { ok: false, reason: 'player not in the dataset' };
  const tm = opts.team || p.team;
  const env = environment(ctx, game, tm);
  const T = ctx.team[tm], D = ctx.def[env.opp], lg = ctx.league;
  if (!T) return { ok: false, reason: 'no team history before ' + ctx.cutoff };
  const hist = history(ctx, p);
  const onTeam = hist.filter((x) => x.l.tm === tm);
  const cur = ctx.cur, pg = p.pg;
  const steps = [];
  const step = (label, value, note) => steps.push({ label, value: isNum(value) ? r3(value) : value, note: note || null });
  const curGames = onTeam.filter((x) => x.l.s === cur && playedIn(x.l)).length;
  const priorGames = hist.filter((x) => x.l.s < cur && playedIn(x.l)).length;
  const status = statusFor(ctx, pid, game, tm);
  const outs = absencesFor(ctx, tm, game);
  delete outs[pid];
  const pending = pendingFor(ctx, tm, game);
  delete pending[pid];

  /* ---- team volume */
  const oppPace = D ? Math.sqrt(D.plays / lg.plays) : 1;
  const plays = T.plays * oppPace;
  const baseRate = clamp(T.neutral_db + 0.5 * (T.db_rate - T.neutral_db), 0.40, 0.75);
  const dbRate = clamp(baseRate - P.script_pass_rate_per_pt * env.margin + env.pass_rate_adj, 0.38, 0.78);
  const dropbacks = plays * dbRate, designed = plays - dropbacks;
  const sackRate = D ? (T.sack_rate + D.sack_rate) / 2 : T.sack_rate;
  step('Team plays per game', plays, 'recency-weighted, shrunk to league ' + r1(lg.plays) + '; opponent pace ×' + r3(oppPace)
    + (T.regime ? '; REGIME CHANGE: last season weighted ×' + r3(T.regime.prior_scale) + ' (regime curve at ' + T.regime.games_played + ' games)' : ''));
  step('Dropback rate', dbRate, 'neutral ' + r3(T.neutral_db) + ', script ' + (env.margin >= 0 ? '−' : '+') + r3(Math.abs(P.script_pass_rate_per_pt * env.margin)) + (env.pass_rate_adj ? ', wind ' + env.pass_rate_adj : ''));
  const teamTds = env.implied * lg.td_per_pt;
  const teamRushTd = teamTds * T.rush_td_frac, teamPassTd = teamTds - teamRushTd;
  step('Team implied points', env.implied, env.source);
  step('Team expected TDs', teamTds, 'implied points × league TDs per point ' + r3(lg.td_per_pt));

  /* ---- shares */
  const denCar = (x) => x.T.dr, denTgt = (x) => (x.T.tgt_den != null ? x.T.tgt_den : x.T.att);
  const numCar = (x) => Math.max(0, x.l.car - (x.l.scr || 0)), numTgt = (x) => x.l.tgt;
  /* the observed share is THIS season's (on this team); last season enters
     once, through the prior, scaled by how the snap share has moved */
  const onTeamCur = onTeam.filter((x) => x.l.s === cur);
  const car = shareStats(onTeamCur, cur, numCar, denCar), tgt = shareStats(onTeamCur, cur, numTgt, denTgt);
  const snapAvg = (rs) => { const v = rs.filter((x) => isNum(x.l.snp_pct) && playedIn(x.l)); return v.length ? v.reduce((a, x) => a + x.l.snp_pct, 0) / v.length : null; };
  const snapCur = snapAvg(onTeamCur), snapPrior = snapAvg(hist.filter((x) => x.l.s < cur && x.l.tm === tm));
  const snapRatio = isNum(snapCur) && isNum(snapPrior) && snapPrior > 0.1 && onTeamCur.length >= 2 ? clamp(snapCur / snapPrior, 0.4, 1.2) : 1;
  const rank = depthRank(ctx, tm, pg === 'RB' || pg === 'WR' || pg === 'TE' || pg === 'QB' ? pg : null, pid);
  const dp = P.depth_prior[pg] || null;
  const prior = (kind) => {
    const pr = hist.filter((x) => x.l.s < cur && x.l.tm === tm);
    if (pr.length >= 4) { const st = shareStats(pr, cur, kind === 'car' ? numCar : numTgt, kind === 'car' ? denCar : denTgt); if (isNum(st.share)) return { v: st.share * snapRatio, src: 'last season on ' + tm + (snapRatio !== 1 ? ' × snap-share change ' + r3(snapRatio) : ''), last_season: true }; }
    if (dp && rank) { const arr = dp[kind]; return { v: arr[Math.min(rank, arr.length) - 1] || 0, src: 'depth chart ' + pg + rank }; }
    return { v: dp ? dp[kind][Math.min(3, dp[kind].length) - 1] || 0 : 0, src: 'position prior' };
  };
  /* the prior's weight, k / (n + k); last season's usage on a regime-change
     programme is scaled by the regime curve (regimeState above) */
  const RG = T.regime || null;
  const shrinkShare = (st, kind) => {
    const pr = prior(kind), n = st.n || 0;
    if (!isNum(st.share)) return { v: pr.v, prior: pr };
    let pw = P.k_share_games / (n + P.k_share_games);
    if (RG && pr.last_season && RG.prior_scale < 1) { pw *= RG.prior_scale; pr.src += ', regime change ×' + r3(RG.prior_scale); }
    return { v: st.share * (1 - pw) + pr.v * pw, prior: pr };
  };
  let carShare = shrinkShare(car, 'car'), tgtShare = shrinkShare(tgt, 'tgt');
  /* ---- teammates OUT: their share moves to who is left (projected, not observed) */
  const teammatesOut = [];
  const redistribute = (kind, sh, samePos) => {
    let add = 0;
    Object.keys(outs).forEach((oid) => {
      const o = ctx.ds.players[oid]; if (!o || o.team !== tm) return;
      const oh = history(ctx, o).filter((x) => x.l.tm === tm);
      const os = shareStats(oh, cur, kind === 'car' ? numCar : numTgt, kind === 'car' ? denCar : denTgt);
      if (!isNum(os.l3) || os.l3 < 0.05) return;
      /* already missing from the recent games? then the shares have absorbed it */
      const lastTeam = (ctx.teamRows[tm] || []).slice(-3).map((r) => r.gid);
      const oPlayed = oh.filter((x) => lastTeam.indexOf(x.l.gid) >= 0 && playedIn(x.l)).length;
      const activeFrac = lastTeam.length ? oPlayed / lastTeam.length : 1;
      if (activeFrac <= 0) return;
      const same = o.pg === pg;
      const pool = (samePos ? (same ? 0.7 : 0.3) : 1);
      const mates = teamPlayers(ctx, tm).filter((q) => q.team === tm && q.id !== oid && !outs[q.id] && (kind === 'car' ? ['RB', 'QB'] : ['WR', 'TE', 'RB']).indexOf(q.pg) >= 0 && (!samePos || (q.pg === o.pg) === same));
      const mateShares = mates.map((q) => { const s = shareStats(history(ctx, q).filter((x) => x.l.tm === tm), cur, kind === 'car' ? numCar : numTgt, kind === 'car' ? denCar : denTgt); return { id: q.id, s: Math.max(isNum(s.l3) ? s.l3 : 0, 0.02 * (depthRank(ctx, tm, q.pg, q.id) && depthRank(ctx, tm, q.pg, q.id) <= 3 ? 1 : 0)) }; });
      const tot = mateShares.reduce((a, b) => a + b.s, 0);
      const mine = mateShares.find((m) => m.id === pid);
      if (!mine || tot <= 0) return;
      const d = os.l3 * P.outs_share_kept * activeFrac * pool * (mine.s / tot);
      if (d > 0.002) { add += d; teammatesOut.push({ id: oid, name: o.name, pos: o.pg, status: outs[oid], delta: r3(d), label: kind === 'car' ? 'carry share' : 'target share' }); }
    });
    return { v: sh.v + add, prior: sh.prior, add };
  };
  carShare = redistribute('car', carShare, false);
  tgtShare = redistribute('tgt', tgtShare, true);
  /* ---- a teammate back from absence dilutes a recent share */
  let returned = null;
  teamPlayers(ctx, tm).forEach((q) => {
    /* a teammate whose status is PENDING (last week's report had him out,
       this week's is not on file) is not back: the dilution waits for the
       report (audit 2026-09-30 #7 — Pierce, IND, week 4) */
    if (returned || q.team !== tm || q.id === pid || q.pg !== pg || outs[q.id] || pending[q.id]) return;
    const qh = history(ctx, q).filter((x) => x.l.tm === tm && x.l.s === cur);
    const lastTeam = (ctx.teamRows[tm] || []).filter((r) => r.s === cur).slice(-2).map((r) => r.gid);
    if (lastTeam.length < 2 || qh.length < 1) return;
    const missed = lastTeam.filter((g) => !qh.some((x) => x.l.gid === g && playedIn(x.l))).length;
    const earlier = qh.filter((x) => lastTeam.indexOf(x.l.gid) < 0);
    const es = shareStats(earlier, cur, pg === 'RB' ? numCar : numTgt, pg === 'RB' ? denCar : denTgt);
    if (missed >= 1 && isNum(es.share) && es.share >= 0.15 && ctx.opts.absent == null) returned = { id: q.id, name: q.name, pos: q.pg, share_before: r3(es.share) };
  });
  if (returned) {
    const k = pg === 'RB' ? 'car' : 'tgt', cut = 0.85;
    if (k === 'car') carShare.v *= cut; else tgtShare.v *= cut;
    returned.adjustment = 'share ×' + cut;
  }
  step('Carry share', carShare.v, 'observed ' + (isNum(car.share) ? r3(car.share) : '—') + ' (L3 ' + (isNum(car.l3) ? r3(car.l3) : '—') + '), prior ' + r3(carShare.prior.v) + ' (' + carShare.prior.src + ')' + (carShare.add ? ', teammates out +' + r3(carShare.add) : ''));
  step('Target share', tgtShare.v, 'observed ' + (isNum(tgt.share) ? r3(tgt.share) : '—') + ' (L3 ' + (isNum(tgt.l3) ? r3(tgt.l3) : '—') + '), prior ' + r3(tgtShare.prior.v) + ' (' + tgtShare.prior.src + ')' + (tgtShare.add ? ', teammates out +' + r3(tgtShare.add) : ''));

  /* ---- availability of the player himself */
  let availMult = 1;
  if (status.status === 'QUESTIONABLE') availMult = 0.93;
  else if (status.status === 'DOUBTFUL') availMult = 0.75;

  /* ---- QB: who throws? */
  let qbChange = null;
  if (pg === 'QB' || ['WR', 'TE', 'RB'].indexOf(pg) >= 0) {
    const starter = game.starters ? game.starters[tm] : null;
    const recentQb = (() => {
      const memo = ctx._qb || (ctx._qb = {});
      if (memo[tm] !== undefined) return memo[tm];
      const counts = {};
      teamPlayers(ctx, tm).forEach((q) => { if (q.pg !== 'QB') return; history(ctx, q).filter((x) => x.l.tm === tm && x.l.s === cur).slice(-2).forEach((x) => { counts[q.id] = (counts[q.id] || 0) + x.l.att; }); });
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      memo[tm] = top || null;
      return memo[tm];
    })();
    if (starter && starter.id && recentQb && starter.id !== recentQb) {
      const from = ctx.ds.players[recentQb], to = ctx.ds.players[starter.id];
      qbChange = { from: from ? from.name : recentQb, to: to ? to.name : (starter.name || starter.id), from_id: recentQb, to_id: starter.id, confirmed: !!starter.confirmed };
    }
    if (pg === 'QB' && starter && starter.id && starter.id !== pid && !opts.force) return { ok: false, reason: 'not the projected starter (' + (starter.name || starter.id) + ')' };
  }

  /* ---- efficiency */
  const hp = hist.filter((x) => playedIn(x.l));
  const wh = weights(hp.map((x) => x.l), cur, 6);
  const W = (f) => wsum(hp, wh, f);
  const fitR = ctx.fits.rush && (ctx.fits.rush[pg] || ctx.fits.rush.RB), fitC = ctx.fits.rec && (ctx.fits.rec[pg] || ctx.fits.rec.WR), fitP = ctx.fits.cmp;
  const posYpc = fitR ? fitR.mean : 4.3, posYpr = fitC ? fitC.mean : 11;
  const ypcRaw = shrinkRate(W((x) => x.l.ryd - (pg === 'QB' ? 0 : 0)), W((x) => x.l.car), P.k_carries_ypc, posYpc);
  const ypcOpp = D ? factorOf(D.ypc, lg.ypc) : 1;
  const ypc = ypcRaw * ypcOpp;
  const catchRate = ctx.caps.targets === false ? 1 : shrinkRate(W((x) => x.l.rec), W((x) => x.l.tgt), P.k_targets_catch, P.pos_catch[pg] || 0.64);
  const posKey = ['RB', 'WR', 'TE'].indexOf(pg) >= 0 ? pg : 'WR';
  const catchOpp = ctx.caps.targets !== false && D && D.pos[posKey] && lg.pos[posKey] ? clamp(D.pos[posKey].catch / lg.pos[posKey].catch, 0.93, 1.07) : 1;
  const yprRaw = shrinkRate(W((x) => x.l.yd), W((x) => x.l.rec), P.k_rec_ypr, posYpr);
  const yprOpp = D && D.pos[posKey] && lg.pos[posKey] ? factorOf(D.pos[posKey].ypr, lg.pos[posKey].ypr) : 1;
  const ypr = yprRaw * yprOpp * env.ypa_adj;
  /* the share's base: pass attempts (NFL targets) or projected completions
     (college, where the box carries receptions only) */
  const passAtt = dropbacks * (1 - sackRate - (ctx.caps.pbp === false ? 0 : P.league_scramble_rate));
  const teamCmp = shrinkRate(wsum(ctx.teamRows[tm] || [], weights(ctx.teamRows[tm] || [], cur, P.hl_team), (r) => r.cmp), wsum(ctx.teamRows[tm] || [], weights(ctx.teamRows[tm] || [], cur, P.hl_team), (r) => r.att), 60, lg.cmp_rate);
  const shareBase = ctx.caps.targets === false ? passAtt * teamCmp : passAtt;
  const tgtVol = tgtShare.v * shareBase * availMult;
  const carVol = carShare.v * designed * availMult;
  const recVol = tgtVol * catchRate * catchOpp;
  step('Projected carries', carVol, 'share × designed runs ' + r1(designed) + (availMult < 1 ? ' × availability ' + availMult : ''));
  step('Yards per carry', ypc, 'player ' + r3(ypcRaw) + ' (shrunk to ' + r3(posYpc) + ') × opponent ' + r3(ypcOpp));
  step(ctx.caps.targets === false ? 'Projected receptions (reception share)' : 'Projected targets', tgtVol, ctx.caps.targets === false ? 'reception share × projected completions ' + r1(shareBase) + ' (no targets in the college box)' : 'share × pass attempts ' + r1(passAtt));
  step('Catch rate', catchRate * catchOpp, 'player ' + r3(catchRate) + ' × opponent ' + r3(catchOpp));
  step('Yards per reception', ypr, 'player ' + r3(yprRaw) + ' × opponent ' + r3(yprOpp) + (env.ypa_adj !== 1 ? ' × weather ' + env.ypa_adj : ''));

  /* red zone → TD shares */
  const rzCar = shareStats(onTeam, cur, (x) => (x.l.rz || 0) + (x.l.gl || 0), (x) => (x.T.rz_dr || 0) + (x.T.gl_dr || 0));
  const rzTgt = shareStats(onTeam, cur, (x) => x.l.rzt || 0, (x) => x.T.rz_att || 0);
  const rushTdShare = isNum(rzCar.share) ? (rzCar.share * Math.min(rzCar.n, 6) + carShare.v * 3) / (Math.min(rzCar.n, 6) + 3) : carShare.v;
  const recTdShare = isNum(rzTgt.share) ? (rzTgt.share * Math.min(rzTgt.n, 6) + tgtShare.v * 3) / (Math.min(rzTgt.n, 6) + 3) : tgtShare.v;
  const lamRushTd = teamRushTd * rushTdShare * availMult * (D ? clamp(D.rtd_pg / lg.rtd, 0.8, 1.25) : 1);
  const lamRecTd = teamPassTd * recTdShare * availMult * (D ? clamp(D.ptd_pg / lg.ptd, 0.8, 1.25) : 1);
  const stTd = hp.length ? W((x) => x.l.st_td || 0) / Math.max(1, wh.reduce((a, b) => a + b, 0)) : 0;
  step('Expected rushing TDs', lamRushTd, 'team rush TDs ' + r3(teamRushTd) + ' × red-zone carry share ' + r3(rushTdShare));
  step('Expected receiving TDs', lamRecTd, 'team pass TDs ' + r3(teamPassTd) + ' × red-zone target share ' + r3(recTdShare));

  /* uncertainty from a thin sample */
  const nEff = Math.max(car.n || 0, tgt.n || 0, curGames);
  const cvParam = P.param_cv / Math.sqrt(nEff + 1);
  const inflateSize = (mean, size) => { const v = mean + (size < 1e6 ? mean * mean / size : 0) + Math.pow(mean * cvParam, 2); return v > mean + 1e-9 ? Math.max(0.3, mean * mean / (v - mean)) : 1e7; };
  const cal = (m) => (ctx.calib[m] || {});
  const fin = (m, d) => { const c = cal(m); let o = d; if (isNum(c.mean_mult) && c.mean_mult !== 1) o = EDP.scaleDist(o, clamp(c.mean_mult, 0.85, 1.15)); if (isNum(c.f) && c.f !== 1) o = EDP.widenDist(o, clamp(c.f, 0.5, 2.5)); return o; };
  const perEvent = (fit, mean) => { if (!fit) return null; const s = fit.shift || 0, per = Math.max(0.5, mean) + s; const a = fit.a; return { a, theta: per / a, shift: s }; };
  /* longest play: the league's per-play table rescaled to this player's average */
  const maxEmp = (nDist, kind, pgKey, mean) => {
    const name = ctx.shape_league + '.' + kind + (pgKey ? '.' + pgKey : ''), sh = ctx.shapes[name];
    if (!sh) return null;
    const s = kind === 'rush' ? 4 : kind === 'rec' ? 1 : 2;
    return { family: 'maxemp', n: nDist, shape: name, scale: Math.max(0.2, (Math.max(0.5, mean) + s) / (sh.mean + s)), shift: s };
  };

  const out = {};
  const ok = (m, d, mean, extra) => { if (!EDP.validDist(d)) return; const f = roundDist(fin(m, d)); if (!EDP.validDist(f)) return; out[m] = Object.assign({ market: m, dist: f, mean_raw: r3(mean) }, extra || {}); };
  const want = (m) => markets.indexOf(m) >= 0;
  const carDist = { family: 'negbin', mean: Math.max(0.05, carVol), size: inflateSize(Math.max(0.05, carVol), P.size.car) };
  const recDist = { family: 'negbin', mean: Math.max(0.05, recVol), size: inflateSize(Math.max(0.05, recVol), P.size.rec) };
  const perCar = perEvent(fitR, ypc), perRec = perEvent(fitC, ypr);
  const rushY = perCar ? { family: 'gcomp', n: carDist, a: perCar.a, theta: perCar.theta, shift: perCar.shift } : null;
  const recY = perRec ? { family: 'gcomp', n: recDist, a: perRec.a, theta: perRec.theta, shift: perRec.shift } : null;
  if (want('rush_att')) ok('rush_att', carDist, carVol);
  if (want('rush_yds') && rushY) ok('rush_yds', rushY, carVol * ypc);
  if (want('rush_long')) { const d = maxEmp(carDist, 'rush', ctx.shapes[ctx.shape_league + '.rush.' + pg] ? pg : 'RB', ypc); if (d) ok('rush_long', d, null); else if (perCar) ok('rush_long', { family: 'maxcomp', n: carDist, a: perCar.a, theta: perCar.theta, shift: perCar.shift }, null); }
  if (want('receptions')) ok('receptions', recDist, recVol);
  if (want('targets')) ok('targets', { family: 'negbin', mean: Math.max(0.05, tgtVol), size: inflateSize(Math.max(0.05, tgtVol), P.size.tgt) }, tgtVol);
  if (want('rec_yds') && recY) ok('rec_yds', recY, recVol * ypr);
  if (want('rec_long')) { const d = maxEmp(recDist, 'rec', ctx.shapes[ctx.shape_league + '.rec.' + posKey] ? posKey : 'WR', ypr); if (d) ok('rec_long', d, null); else if (perRec) ok('rec_long', { family: 'maxcomp', n: recDist, a: perRec.a, theta: perRec.theta, shift: perRec.shift }, null); }
  if (want('rush_rec_yds') && rushY && recY) ok('rush_rec_yds', { family: 'conv', parts: [rushY, recY] }, carVol * ypc + recVol * ypr);
  if (want('rush_tds')) ok('rush_tds', tdDist(lamRushTd, cvParam), lamRushTd);
  if (want('rec_tds')) ok('rec_tds', tdDist(lamRecTd, cvParam), lamRecTd);
  const lamTd = lamRushTd + (pg === 'QB' ? 0 : lamRecTd) + stTd;
  if (want('anytime_td')) ok('anytime_td', tdDist(lamTd, cvParam), lamTd);
  if (want('tds_over')) ok('tds_over', tdDist(lamTd, cvParam), lamTd);
  if (want('first_td')) {
    const gameTds = (env.implied + env.opp_implied) * lg.td_per_pt;
    const pFirst = gameTds > 0 ? (lamTd / gameTds) * (1 - Math.exp(-gameTds)) : 0;
    ok('first_td', { family: 'bernoulli', p: clamp(pFirst, 0, 0.9) }, pFirst);
  }

  /* ---- quarterback */
  let qb = null;
  if (pg === 'QB') {
    const att = dropbacks * (1 - sackRate) * (1 - P.league_scramble_rate) * availMult;
    const cmpRate = shrinkRate(W((x) => x.l.cmp), W((x) => x.l.att), P.k_att_cmp, lg.cmp_rate) * (D ? clamp(D.cmp_rate / lg.cmp_rate, 0.92, 1.08) : 1) * (env.ypa_adj < 1 ? 0.98 : 1);
    const ypcmp = shrinkRate(W((x) => x.l.pyd), W((x) => x.l.cmp), P.k_cmp_ypc, lg.ypcmp) * (D ? factorOf(D.ypcmp, lg.ypcmp) : 1) * env.ypa_adj;
    const intRate = shrinkRate(W((x) => x.l.int), W((x) => x.l.att), P.k_att_int, lg.int_rate) * (D ? clamp(D.int_rate / lg.int_rate, 0.8, 1.25) : 1);
    const cmpN = att * cmpRate;
    const lamPtd = teamPassTd * availMult;
    const scrRate = shrinkRate(W((x) => x.l.scr || 0), W((x) => x.l.db || 0), 100, P.league_scramble_rate);
    const gw = wh.reduce((a, b) => a + b, 0);
    const dr = (W((x) => x.l.dr || 0) + 3 * 1.5) / (gw + 3);
    /* college: the box counts every QB carry (sacks included) — its own rate */
    const qbCar = (ctx.caps.pbp === false ? (W((x) => x.l.car) + 3 * 6) / (gw + 3) : dr + scrRate * dropbacks) * availMult;
    const qbYpc = shrinkRate(W((x) => x.l.ryd), W((x) => x.l.car), 40, fitR ? fitR.mean : 4.5) * (D ? factorOf(D.ypc, lg.ypc) : 1);
    step('Pass attempts', att, 'dropbacks ' + r1(dropbacks) + ' less sacks (' + r3(sackRate) + ') and scrambles');
    step('Completion rate', cmpRate, 'shrunk to league ' + r3(lg.cmp_rate) + ', opponent-adjusted');
    step('Yards per completion', ypcmp, 'shrunk to league ' + r3(lg.ypcmp) + ', opponent-adjusted' + (env.ypa_adj !== 1 ? ', weather ×' + env.ypa_adj : ''));
    step('Expected passing TDs', lamPtd, 'team pass TDs from implied points');
    step('QB carries', qbCar, 'designed ' + r3(dr) + ' + scrambles ' + r3(scrRate) + ' per dropback');
    const attD = { family: 'negbin', mean: att, size: inflateSize(att, P.size.att) };
    const cmpD = { family: 'negbin', mean: cmpN, size: inflateSize(cmpN, P.size.cmp) };
    const perCmp = perEvent(fitP, ypcmp);
    const pyd = cmpN * ypcmp;
    /* passing yards: the compound variance, carried by a Normal */
    let pydSd = null;
    if (perCmp) { const vx = perCmp.a * perCmp.theta * perCmp.theta, vN = cmpN + cmpN * cmpN / cmpD.size; pydSd = Math.sqrt(cmpN * vx + vN * ypcmp * ypcmp + Math.pow(pyd * cvParam, 2)); }
    if (want('pass_att')) ok('pass_att', attD, att);
    if (want('pass_cmp')) ok('pass_cmp', cmpD, cmpN);
    if (want('pass_yds') && pydSd) ok('pass_yds', { family: 'normal', mu: pyd, sigma: pydSd }, pyd);
    if (want('pass_tds')) ok('pass_tds', tdDist(lamPtd, cvParam), lamPtd);
    if (want('pass_ints')) ok('pass_ints', tdDist(att * intRate, cvParam), att * intRate);
    if (want('pass_long')) { const d = maxEmp(cmpD, 'cmp', null, ypcmp); if (d) ok('pass_long', d, null); else if (perCmp) ok('pass_long', { family: 'maxcomp', n: cmpD, a: perCmp.a, theta: perCmp.theta, shift: 0 }, null); }
    const qCarD = { family: 'negbin', mean: Math.max(0.05, qbCar), size: inflateSize(Math.max(0.05, qbCar), 6) };
    const qRush = fitR ? perEvent(ctx.fits.rush.QB || fitR, qbYpc) : null;
    if (want('rush_yds') && qRush) ok('rush_yds', { family: 'gcomp', n: qCarD, a: qRush.a, theta: qRush.theta, shift: qRush.shift }, qbCar * qbYpc);
    if (want('rush_att')) ok('rush_att', qCarD, qbCar);
    if (want('pass_rush_yds') && pydSd && qRush) {
      const rd = { family: 'gcomp', n: qCarD, a: qRush.a, theta: qRush.theta, shift: qRush.shift };
      ok('pass_rush_yds', { family: 'normal', mu: pyd + qbCar * qbYpc, sigma: Math.sqrt(pydSd * pydSd + EDP.variance(rd)) }, pyd + qbCar * qbYpc);
    }
    qb = { att: r3(att), cmp_rate: r3(cmpRate), ypcmp: r3(ypcmp), int_rate: r3(intRate), sack_rate: r3(sackRate), scramble_rate: r3(scrRate), carries: r3(qbCar) };
  }

  /* ---- kicker */
  if (pg === 'K') {
    const fgAtt = (W((x) => x.l.fga) + 3 * 1.8) / (wh.reduce((a, b) => a + b, 0) + 3) * (env.implied / Math.max(1, lg.pts));
    const fgPct = shrinkRate(W((x) => x.l.fgm), W((x) => x.l.fga), 20, 0.84) * (isNum(env.wind) && env.wind >= 15 ? 0.94 : 1);
    const lamFg = fgAtt * fgPct, xp = teamTds * 0.94;
    if (want('fg_made')) ok('fg_made', { family: 'poisson', lambda: lamFg }, lamFg);
    if (want('kicking_pts')) ok('kicking_pts', { family: 'normal', mu: 3 * lamFg + xp, sigma: Math.sqrt(9 * lamFg + xp + Math.pow((3 * lamFg + xp) * cvParam, 2)) }, 3 * lamFg + xp);
    step('Field-goal attempts', fgAtt, 'kicker rate scaled by implied points');
  }
  /* ---- defenders */
  if (['LB', 'DB', 'DL'].indexOf(pg) >= 0) {
    const g = wh.reduce((a, b) => a + b, 0) || 1;
    const oppPlays = ctx.team[env.opp] ? ctx.team[env.opp].plays / lg.plays : 1;
    const solo = (W((x) => x.l.tkl) + 2 * 2) / (g + 2) * oppPlays * availMult, ast = (W((x) => x.l.ast) + 2 * 1.5) / (g + 2) * oppPlays * availMult;
    const sk = (W((x) => x.l.dsk) + 3 * 0.15) / (g + 3), di = (W((x) => x.l.dint) + 4 * 0.05) / (g + 4);
    if (want('tackles_ast')) ok('tackles_ast', { family: 'negbin', mean: solo + ast, size: inflateSize(solo + ast, P.size.tkl) }, solo + ast);
    if (want('solo_tackles')) ok('solo_tackles', { family: 'negbin', mean: solo, size: inflateSize(solo, P.size.tkl) }, solo);
    if (want('sacks')) ok('sacks', tdDist(sk, cvParam), sk);
    if (want('def_ints')) ok('def_ints', tdDist(di, cvParam), di);
  }

  /* ---- facts shared by every market of this player */
  const snapsSt = (() => { const rows = onTeam.filter((x) => x.l.snp_pct != null); if (!rows.length) return null; const cr = rows.filter((x) => x.l.s === cur); const avg = (rs) => rs.length ? rs.reduce((a, x) => a + x.l.snp_pct, 0) / rs.length : null; return { season: avg(cr), l3: avg(rows.slice(-3)), last: rows[rows.length - 1].l.snp_pct }; })();
  const stab = (st) => isNum(st.l3) && isNum(st.season) && st.season > 0.03 ? clamp(1 - Math.abs(st.l3 - st.season) / Math.max(st.season, 0.08), 0, 1) : null;
  const stabilities = [stab(car), stab(tgt), snapsSt && isNum(snapsSt.l3) && isNum(snapsSt.season) ? clamp(1 - Math.abs(snapsSt.l3 - snapsSt.season) / Math.max(snapsSt.season, 0.2), 0, 1) : null].filter(isNum);
  const roleStability = stabilities.length ? r3(stabilities.reduce((a, b) => a + b, 0) / stabilities.length * (returned ? 0.8 : 1) * (teammatesOut.length ? 0.9 : 1)) : null;
  const completeness = r3([!!D, isNum(env.total), status.on_file, !!snapsSt, hp.length >= 3, !!(ctx.ds.depth || {})[tm]].filter(Boolean).length / 6);
  return {
    ok: true, player_id: pid, team: tm, opp: env.opp, pg, model_version: MODEL_VERSION, cutoff: ctx.cutoff,
    env, status, sample_games: curGames, prior_games: priorGames, role_stability: roleStability, completeness,
    qb_change: qbChange, qb_unconfirmed: qbChange ? !qbChange.confirmed : false,
    teammate_uncertain: Object.keys(outs).some((k) => outs[k] === 'DOUBTFUL') || Object.keys(pending).length > 0,
    teammates_out: teammatesOut, teammate_returned: returned, depth_rank: rank,
    teammates_pending: Object.keys(pending).map((k) => pending[k]).sort((a, b) => a.name.localeCompare(b.name)),
    regime: RG ? { regime_change: true, team: RG.team, reason: RG.reason, games_played: RG.games_played, min_games_for_research: RG.min_games_for_research,
      standard_weight: RG.standard_weight, regime_weight: RG.regime_weight, prior_scale: r3(RG.prior_scale), curve_version: RG.curve_version } : null,
    shares: { car: { now: r3(car.l3), season: r3(car.season), projected: r3(carShare.v) }, tgt: { now: r3(tgt.l3), season: r3(tgt.season), projected: r3(tgtShare.v) }, snaps: snapsSt ? { now: r3(snapsSt.l3), season: r3(snapsSt.season), last: r3(snapsSt.last) } : null },
    efficiency: { ypc: r3(ypc), catch_rate: r3(catchRate * catchOpp), ypr: r3(ypr), opp_factor_ypc: r3(ypcOpp), opp_factor_ypr: r3(yprOpp) },
    volume: { plays: r1(plays), db_rate: r3(dbRate), dropbacks: r1(dropbacks), designed_runs: r1(designed), carries: r3(carVol), targets: r3(tgtVol), receptions: r3(recVol) },
    tds: { team: r3(teamTds), rush: r3(lamRushTd), rec: r3(lamRecTd), st: r3(stTd) }, qb,
    steps, markets: out
  };
}
/* distribution parameters to five significant figures: the board carries
   thousands of them, and the fifth figure moves no probability by 0.01 pp */
function roundDist(d) {
  if (Array.isArray(d)) return d.map(roundDist);
  if (d && typeof d === 'object') { const o = {}; Object.keys(d).forEach((k) => { o[k] = roundDist(d[k]); }); return o; }
  if (typeof d === 'number' && isFinite(d) && d !== 0) { if (d >= 1e6) return d; const p = Math.pow(10, 4 - Math.floor(Math.log10(Math.abs(d)))); return Math.round(d * p) / p; }
  return d;
}
function tdDist(lam, cv) {
  lam = Math.max(0, lam);
  if (!(lam > 0)) return { family: 'poisson', lambda: 0.0001 };
  const extra = Math.pow(lam * cv * 1.6, 2);          /* TD rates are noisy: parameter uncertainty → NegBin */
  return extra > 1e-6 ? { family: 'negbin', mean: lam, size: Math.max(0.3, lam * lam / extra) } : { family: 'poisson', lambda: lam };
}

/* the settlement statistic of a market, from one log row — ONE home:
   lib/edgedesk_props.js statOf (the page reads the same function) */
function statOf(market, l) { return EDP.statOf(market, l); }
function statOfLocal(market, l) {
  if (!l) return null;
  const n = (v) => isNum(v) ? v : 0;
  switch (market) {
    case 'pass_yds': return n(l.pyd); case 'pass_att': return n(l.att); case 'pass_cmp': return n(l.cmp); case 'pass_tds': return n(l.ptd); case 'pass_ints': return n(l.int);
    case 'pass_long': return l.plng != null ? l.plng : (n(l.cmp) === 0 ? 0 : null);
    case 'rush_yds': return n(l.ryd); case 'rush_att': return n(l.car); case 'rush_tds': return n(l.rtd);
    case 'rush_long': return l.rlng != null ? l.rlng : (n(l.car) === 0 ? 0 : null);
    case 'rec_yds': return n(l.yd); case 'receptions': return n(l.rec); case 'targets': return l.tgt != null ? l.tgt : null; case 'rec_tds': return n(l.td);
    case 'rec_long': return l.lng != null ? l.lng : (n(l.rec) === 0 ? 0 : null);
    case 'rush_rec_yds': return n(l.ryd) + n(l.yd); case 'pass_rush_yds': return n(l.pyd) + n(l.ryd);
    case 'anytime_td': case 'tds_over': return n(l.rtd) + n(l.td) + n(l.st_td);
    case 'fg_made': return n(l.fgm); case 'kicking_pts': return 3 * n(l.fgm) + n(l.xpm);
    case 'tackles_ast': return n(l.tkl) + n(l.ast); case 'solo_tackles': return n(l.tkl); case 'sacks': return n(l.dsk); case 'def_ints': return n(l.dint);
    case 'fantasy_pts': return isNum(l.fp) ? l.fp : null;
    case 'first_td': return l.first_td != null ? l.first_td : null;
  }
  return null;
}

/* which markets a player's role supports when no book has posted anything */
function defaultMarkets(pg, proj) {
  if (pg === 'QB') return ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_ints', 'pass_long', 'rush_yds', 'rush_att', 'pass_rush_yds', 'anytime_td'];
  if (pg === 'RB') return ['rush_yds', 'rush_att', 'rush_long', 'receptions', 'rec_yds', 'rush_rec_yds', 'anytime_td', 'rush_tds'];
  if (pg === 'WR' || pg === 'TE') return ['rec_yds', 'receptions', 'targets', 'rec_long', 'anytime_td', 'rec_tds'];
  if (pg === 'K') return ['fg_made', 'kicking_pts'];
  return [];
}

module.exports = { MODEL_VERSION, PARAMS: P, prepare, projectPlayer, environment, history, shareStats, statOf, defaultMarkets, playedIn, tdDist, absencesFor, statusFor,
  pendingFor, teamReportWeek, defenceAvailability, regimeState };

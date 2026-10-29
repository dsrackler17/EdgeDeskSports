/* ============================================================================
   FSIE — the committed artifacts the browser and the existing models read.

   cards.json is the ONE file the game cards fetch: per upcoming game, both
   teams' OBSERVED situational tendencies (raw season-to-date rates from
   accepted games, with sample, window and tier — facts, never graded) and the
   EXPERIMENTAL research section (projections with intervals, eligible player
   opportunities, market disagreement, the validation summary and the known
   limitations). It is small by construction: no play-level data, no history.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const FT = require(path.join(__dirname, 'features.js'));
const A = require(path.join(__dirname, 'aggregate.js'));

const DIR = path.join(__dirname, '..');
const ROOT = path.join(DIR, '..', '..');
const SCHEMA = 'edgedesk_fsie_cards_v1';

function names(sport, d) {
  const out = {};
  if (sport === 'nfl') {
    let TN = {}; try { TN = require(path.join(ROOT, 'football', 'props', 'sources', 'nfl.js')).TEAM_NAMES; } catch (_) { /* codes only */ }
    (d.schedule || []).forEach((g) => { [g.home, g.away].forEach((t) => { out[t] = { id: t, name: TN[t] || t, key: String(t).toLowerCase() }; }); });
  } else {
    const xw = U.readJson(path.join(ROOT, 'football', 'fbs_epa', 'teams.json'));
    (d.schedule || []).forEach((g) => {
      [[g.home, g.home_name, g.home_conference, g.home_division], [g.away, g.away_name, g.away_conference, g.away_division]].forEach(([t, n, c, dv]) => {
        if (!t || out[t]) return; const x = xw && xw.teams && xw.teams[t];
        out[t] = { id: t, name: n || t, key: x ? x.key : null, conference: c || null, division: dv || null };
      });
    });
  }
  return out;
}

/* raw season-to-date observed tendencies: unweighted sums over accepted games */
function observedFor(d) {
  const off = {}, def = {}, games = {}, win = {};
  d.team_games.forEach((r) => {
    if (r.season_type !== 'REG') return;
    const v = FT.vec(r); if (!v) return;
    const o = off[r.team] || (off[r.team] = {}); for (const k in v) o[k] = (o[k] || 0) + v[k];
    const x = def[r.opp] || (def[r.opp] = {}); for (const k in v) x[k] = (x[k] || 0) + v[k];
    games[r.team] = (games[r.team] || 0) + 1;
    const w = win[r.team] || (win[r.team] = { first: null, last: null });
    if (!w.first || r.kickoff_at < w.first) w.first = r.kickoff_at; if (!w.last || r.kickoff_at > w.last) w.last = r.kickoff_at;
  });
  const rate = (a, x, n) => (a && a[n] > 0 ? { v: U.round(a[x] / a[n], 3), n: a[n] } : null);
  const per = (a, x, n) => (a && a[n] > 0 ? { v: U.round(a[x] / a[n], 2), n: U.round(a[n], 0) } : null);
  const inv = (r) => (r ? { v: U.round(1 - r.v, 3), n: r.n } : null);
  const out = {};
  Object.keys(off).forEach((t) => {
    const o = off[t], f = def[t];
    const all = (a) => { if (!a) return null; let n = 0, db = 0; A.SCRIPTS.forEach((s) => { n += a['x_' + s + '_n'] || 0; db += a['x_' + s + '_db'] || 0; }); return n ? { v: U.round(db / n, 3), n } : null; };
    out[t] = {
      offense: {
        pass_rate: all(o), early_down_pass_rate: rate(o, 's_early_down_db', 's_early_down_n'), neutral_pass_rate: rate(o, 's_neutral_db', 's_neutral_n'),
        third_down_pass_rate: rate(o, 's_third_down_db', 's_third_down_n'), passing_down_pass_rate: rate(o, 's_passing_down_db', 's_passing_down_n'),
        red_zone_pass_rate: rate(o, 's_red_zone_db', 's_red_zone_n'), short_yardage_run_rate: inv(rate(o, 's_short_yardage_db', 's_short_yardage_n')),
        goal_line_run_rate: inv(rate(o, 's_goal_line_db', 's_goal_line_n')), trailing_pass_rate: rate(o, 's_trailing_db', 's_trailing_n'),
        leading_run_rate: inv(rate(o, 's_leading_db', 's_leading_n')), first_half_pass_rate: rate(o, 's_first_half_db', 's_first_half_n'), second_half_pass_rate: rate(o, 's_second_half_db', 's_second_half_n'),
        plays_per_game: per(o, 'plays', 'games'), drives_per_game: per(o, 'drives', 'games'), plays_per_drive: per(o, 'plays', 'drives'),
        neutral_seconds_per_play: per(o, 'pace_n_sec', 'pace_n_pairs'),
        shotgun_rate: rate(o, 'f_shotgun', 'f_charted'), no_huddle_rate: rate(o, 'f_nohuddle', 'f_charted'),
        motion_rate: rate(o, 'ftn_motion', 'ftn_n'), play_action_rate: rate(o, 'ftn_pa', 'ftn_n'), rpo_rate: rate(o, 'ftn_rpo', 'ftn_n'), screen_rate: rate(o, 'ftn_screen', 'ftn_n')
      },
      defense: {
        pass_rate_faced: all(f), neutral_pass_rate_faced: rate(f, 's_neutral_db', 's_neutral_n'), early_down_pass_rate_faced: rate(f, 's_early_down_db', 's_early_down_n'),
        rush_rate_faced: inv(all(f)), plays_per_game_allowed: per(f, 'plays', 'games'), plays_per_drive_allowed: per(f, 'plays', 'drives'),
        box_count_avg: per(f, 'ftn_box_sum', 'ftn_box_n'), eight_plus_box_rate_vs_run: rate(f, 'ftn_box8', 'ftn_rush_n'), blitzers_avg: per(f, 'ftn_blitz_sum', 'ftn_blitz_n')
      },
      sample: { games: games[t] || 0, plays: o.plays || 0, window: win[t] }
    };
  });
  return out;
}

function tendencies(sport, r) {
  const teams = {};
  Object.keys(r.walk.final).forEach((t) => {
    const f = r.walk.final[t];
    const slim = (m) => { const o = {}; Object.keys(m || {}).forEach((k) => { const x = m[k]; if (x && typeof x === 'object' && 'v' in x) o[k] = { v: x.v, raw: x.raw, n: x.n, se: x.se == null ? null : x.se, prior: x.prior }; else if (k === 'script_share' || k === 'sample') o[k] = x; }); return o; };
    teams[t] = { offense: slim(f.off), defense: slim(f.def), opponent_adjustment: f.opp_adj, meta: f.meta };
  });
  return { schema: 'edgedesk_fsie_tendencies_v1', sport, season: r.season, built_at: r.built_at, features_version: FT.CFG.version,
    method: 'shrunk, recency-weighted, point-in-time (core/features.js); raw = the unshrunk weighted rate; prior = the league reference',
    league: r.walk.league, shrinkage_k: r.walk.K, teams };
}

function observations(sport, r) {
  const d = r.derived;
  return { schema: 'edgedesk_fsie_observations_v1', sport, season: d.season, built_at: r.built_at, sources: d.sources, source_ref: d.source_ref,
    situations_version: d.situations_version, quality_version: d.quality_version, charting: d.charting,
    games: d.games,
    team_games: d.team_games.map((x) => ({ game_id: x.game_id, week: x.week, season_type: x.season_type, kickoff_at: x.kickoff_at, team: x.team, opp: x.opp, is_home: x.is_home,
      counts: x.counts, quality: x.quality, market: x.market, src: x.src })) };
}

function coverageArtifact(cov, now) {
  return { schema: 'edgedesk_fsie_coverage_v1', built_at: now, sports: cov };
}

function rowsByGame(sport, r) { return r.rows || {}; }

function shadowArtifact(sport, r) {
  const games = {}; const lg = r.walk.league || {};
  const proj = {}; r.projections.filter((p) => !p.skipped).forEach((p) => { proj[p.game_id + '|' + p.team] = p; });
  const byGame = {}; Object.keys(r.rows || {}).forEach((gid) => { const x = r.rows[gid]; byGame[gid] = { home: proj[gid + '|' + x.home.team], away: proj[gid + '|' + x.away.team] }; });
  Object.keys(byGame).forEach((gid) => {
    const g = byGame[gid]; if (!g.home || !g.away) return;
    const pick = (p) => ({ team: p.team, plays: [p.p10.plays, p.p50.plays, p.p90.plays], pass_att: [p.p10.pass_att, p.p50.pass_att, p.p90.pass_att], rush_att: [p.p10.rush_att, p.p50.rush_att, p.p90.rush_att], drives: [p.p10.drives, p.p50.drives, p.p90.drives], mean_plays: p.mean.plays, mean_drives: p.mean.drives, pass_rate: p.point.pass_rate });
    const gp = g.home.mean.plays + g.away.mean.plays;
    games[gid] = { as_of: g.home.as_of, home: pick(g.home), away: pick(g.away), game_plays: U.round(gp, 2),
      game_plays_dev: U.isNum(lg.plays_pg) ? U.round(gp - 2 * lg.plays_pg, 2) : null, league_plays_pg: U.round(lg.plays_pg, 2),
      game_drives: U.round(g.home.mean.drives + g.away.mean.drives, 2), script: { home: g.home.script, away: g.away.script }, data_quality: [g.home.data_quality, g.away.data_quality] };
  });
  return { schema: 'edgedesk_fsie_shadow_input_v1', sport, built_at: r.built_at, model_version: (r.projections.find((p) => !p.skipped) || {}).model_version || null, games };
}

const LIMITS = {
  nfl: [
    'Experimental research model: not validated for decisions; it moves no EdgeDesk number (SHADOW).',
    'Personnel and coverage (nflverse participation) publish only after the season; 2026 has FTN charting (box, motion, play action) but no personnel.',
    'A player returning from a multi-week absence is not projected until he plays again.',
    'Prop comparisons are projection disagreements, not betting edges; no EV is computed.'
  ],
  cfb: [
    'Experimental research model: not validated for decisions; it moves no EdgeDesk number (SHADOW).',
    'No college personnel, coverage or box-count feed exists; formation tokens (shotgun / no-huddle) appear only from 2025 and were never in training.',
    'College availability is unverified: no injury report feed; player intervals are widened accordingly.',
    'Scrambles are not separable from designed runs in the college feed.',
    'Where no market spread or total is on file the EdgeDesk model\'s own number is used, and the card says so.'
  ]
};

function validationSummary(sport) {
  const h = U.readJson(path.join(DIR, 'research', 'holdout_' + sport + '.json'));
  if (!h) return { state: 'not_evaluated' };
  const pv = h.primary_variant; const t = h.team;
  const row = (k) => ({ model_mae: t.metrics[k][pv].mae, season_avg_mae: t.metrics[k].season_avg.mae, market_only_mae: t.metrics[k].market_only.mae, coverage_p10_p90: t.coverage[k] ? t.coverage[k].p10_p90 : null });
  return { state: 'holdout_evaluated', holdout_season: h.holdout_season, n_team_games: h.n_team_games, plays: row('plays'), pass_att: row('pass_att'), rush_att: row('rush_att'),
    team_criteria_passed: h.criteria.team_passed, player_criteria_passed: h.criteria.player_passed, evaluated_at: h.evaluated_at };
}

function cards(built, opts) {
  const games = {};
  Object.keys(built).forEach((sport) => {
    const r = built[sport]; const d = r.derived;
    const nm = names(sport, d); const obs = observedFor(d);
    const covT = {}; ((r.coverage && r.coverage.teams) || []).forEach((t) => { covT[t.team] = t; });
    const proj = {}; r.projections.filter((p) => !p.skipped).forEach((p) => { proj[p.game_id + '|' + p.team] = p; });
    const skipped = {}; r.projections.filter((p) => p.skipped).forEach((p) => { skipped[p.game_id] = p.reason; });
    const players = {}; r.player_projections.forEach((p) => { (players[p.game_id + '|' + p.team] = players[p.game_id + '|' + p.team] || []).push(p); });
    const cmp = {}; r.comparisons.forEach((c) => { (cmp[c.game_id] = cmp[c.game_id] || []).push(c); });
    const val = validationSummary(sport);
    (r.upcoming || []).forEach((g) => {
      const side = (t) => {
        const c = covT[t] || {};
        const p = proj[g.game_id + '|' + t];
        const ps = (players[g.game_id + '|' + t] || []);
        return {
          team: nm[t] || { id: t, name: t },
          observed: obs[t] ? Object.assign({ tier: c.tier || null, missing_fields: c.missing_fields || [], last_game_at: c.last_game_at || null }, obs[t]) : { tier: c.tier || 'D', missing_fields: (c.missing_fields || []).concat(['no accepted game this season']), offense: null, defense: null, sample: { games: 0 } },
          projection: p ? { point: p.point, p10: p.p10, p50: p.p50, p90: p.p90, script: p.script, plays_by_script: p.plays_by_script, data_quality: p.data_quality, missing_reasons: p.missing_reasons, inputs: p.inputs } : null,
          players: ps.filter((x) => !x.skipped).map((x) => ({ id: x.player_id, name: x.player_name, role: x.role, availability: x.availability ? x.availability.status : null, markets: x.markets })),
          players_note: (ps.find((x) => x.skipped) || {}).reason || null
        };
      };
      games[String(g.game_id)] = {
        sport, game_id: String(g.game_id), week: g.week, kickoff_at: g.kickoff_at,
        home: side(g.home), away: side(g.away),
        research: { model_version: (proj[g.game_id + '|' + g.home] || {}).model_version || null, as_of: (proj[g.game_id + '|' + g.home] || {}).as_of || null,
          experimental: true, status: r.params_present ? (skipped[g.game_id] ? 'skipped' : 'projected') : 'no_parameters', note: skipped[g.game_id] || r.projection_note || null,
          market: (cmp[g.game_id] || []).map((c) => ({ player: c.player_name, market: c.market, model_median: c.model_median, p10: c.model_p10, p90: c.model_p90, line: c.market_line, difference: c.difference, market_at: c.market_at, model_as_of: c.model_as_of, label: c.label })),
          market_state: r.board_state || null, validation: val, limitations: LIMITS[sport] },
        updated_at: r.built_at,
        source: { observed: (r.coverage && r.coverage.freshness) || null }
      };
    });
  });
  return { schema: SCHEMA, built_at: opts && opts.now, games, notes: { observed: 'season-to-date rates from accepted games only; facts, not predictions', research: 'experimental; SHADOW; moves no EdgeDesk number' } };
}

module.exports = { cards, tendencies, observations, coverageArtifact, shadowArtifact, rowsByGame, observedFor, names, validationSummary, SCHEMA };

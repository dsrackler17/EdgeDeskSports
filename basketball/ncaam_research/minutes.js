'use strict';
/* ===========================================================================
   Minutes and participation, separately from what a player does per minute.

   From ESPN player boxes (athlete ids; a DNP row or a missing row is "did not
   appear", which is participation, not a confirmed injury or eligibility
   status), per player and team, using only games before the one in question:

     appearance rate     games appeared / team games since his first appearance
     expected minutes    exponentially weighted mean of minutes in games he
                         played (half-life in games, chosen on 2025)
     baseline minutes    average minutes per TEAM game, absences included:
                         what the team rating already contains
     cap                 the most minutes he has played in a game
     starts, fouls/40, foul-outs (5 personal fouls)

   Forecasts are scored on 2026 after the half-life and the per-40 shrinkage
   are chosen on 2025:
     minutes given he plays: EWMA vs season mean vs last 5 vs last game
     points, rebounds, assists per minute (given actual minutes, so the rate
     forecast is isolated): raw season rate vs rate shrunk toward last
     season's rate (returning players) or the position mean (new players).
   =========================================================================== */
const U = require('./lib/util');

const RATE_STATS = ['pts', 'reb', 'ast'];
const statOf = (r, k) => (k === 'reb' ? (r.orb || 0) + (r.drb || 0) : r[k] || 0);

/** chronological per-team-season state; call observe(game rows of one team-game) in start order */
class MinutesBook {
  constructor(halfLife) { this.h = halfLife || 5; this.p = new Map(); this.teamGames = new Map(); }
  key(team, athlete) { return team + ':' + athlete; }
  state(team, athlete) { return this.p.get(this.key(team, athlete)); }
  /** rows: every ESPN row of one team in one game */
  observe(team, rows) {
    const tg = (this.teamGames.get(team) || 0) + 1; this.teamGames.set(team, tg);
    const alpha = 1 - Math.pow(0.5, 1 / this.h);
    for (const r of rows) {
      const k = this.key(team, r.athlete);
      let s = this.p.get(k);
      const played = !r.dnp && r.min > 0;
      if (!s) { if (!played) continue; s = { team, athlete: r.athlete, name: r.name, pos: r.pos, first_team_game: tg, games: 0, minutes: 0, ewma: null, max: 0, starts: 0, pf: 0, fouled_out: 0, last5: [], last: null, totals: { pts: 0, reb: 0, ast: 0 } }; this.p.set(k, s); }
      s.name = r.name || s.name; s.pos = r.pos || s.pos;
      if (!played) continue;
      s.games++; s.minutes += r.min; s.max = Math.max(s.max, r.min); if (r.starter) s.starts++; s.pf += r.pf || 0; if ((r.pf || 0) >= 5) s.fouled_out++;
      s.ewma = s.ewma == null ? r.min : s.ewma + alpha * (r.min - s.ewma);
      s.last5.push(r.min); if (s.last5.length > 5) s.last5.shift(); s.last = r.min;
      for (const k2 of RATE_STATS) s.totals[k2] += statOf(r, k2);
    }
  }
  /** a player's summary as of now */
  summary(team, athlete) {
    const s = this.state(team, athlete); if (!s) return null;
    const tg = this.teamGames.get(team) || 0; const span = Math.max(1, tg - s.first_team_game + 1);
    return {
      athlete, name: s.name, pos: s.pos, games: s.games, team_games: span, appearance_rate: s.games / span,
      expected_minutes: s.ewma, season_mpg: s.games ? s.minutes / s.games : null, baseline_minutes: s.minutes / span,
      cap: s.max, start_rate: s.games ? s.starts / s.games : 0, fouls_per_40: s.minutes ? (40 * s.pf) / s.minutes : null, foul_outs: s.fouled_out,
      last5_mpg: s.last5.length ? U.mean(s.last5) : null, last_game: s.last, per40: Object.fromEntries(RATE_STATS.map((k) => [k, s.minutes ? (40 * s.totals[k]) / s.minutes : null])), minutes_total: s.minutes,
    };
  }
  rotation(team) { const out = []; for (const s of this.p.values()) if (s.team === team) out.push(this.summary(team, s.athlete)); return out.sort((a, b) => b.baseline_minutes - a.baseline_minutes); }
}

/** walk a season of ESPN rows in order; fn(teamGameRows, book) is called BEFORE the game is absorbed */
function walkSeason(PG, season, halfLife, fn) {
  const book = new MinutesBook(halfLife);
  const rows = PG.rows.filter((r) => r.season === season);
  const byTG = U.groupBy(rows, (r) => r.game_id + ':' + r.team);
  const keys = [...byTG.keys()].sort((a, b) => byTG.get(a)[0].start_ms - byTG.get(b)[0].start_ms || (a < b ? -1 : 1));
  for (const k of keys) {
    const rs = byTG.get(k); const team = rs[0].team;
    if (fn) fn(rs, book, team);
    book.observe(team, rs);
  }
  return book;
}

/* ---------------------------------------------------------------- per-40 shrinkage */
function previousRates(PG, season) {
  const acc = new Map();
  for (const r of PG.rows) {
    if (r.season !== season - 1 || r.dnp || !(r.min > 0)) continue;
    let a = acc.get(r.athlete); if (!a) { a = { min: 0, pts: 0, reb: 0, ast: 0, pos: r.pos }; acc.set(r.athlete, a); }
    a.min += r.min; for (const k of RATE_STATS) a[k] += statOf(r, k);
  }
  const out = new Map(); for (const [a, x] of acc) out.set(a, { min: x.min, per40: Object.fromEntries(RATE_STATS.map((k) => [k, (40 * x[k]) / x.min])) });
  return out;
}

function positionMeans(PG, season) {
  const acc = {}; for (const r of PG.rows) { if (r.season !== season - 1 || r.dnp || !(r.min > 0)) continue; const p = r.pos || '?'; const a = acc[p] || (acc[p] = { min: 0, pts: 0, reb: 0, ast: 0 }); a.min += r.min; for (const k of RATE_STATS) a[k] += statOf(r, k); }
  const out = {}; for (const [p, a] of Object.entries(acc)) out[p] = Object.fromEntries(RATE_STATS.map((k) => [k, (40 * a[k]) / a.min])); return out;
}

/** shrunk per-40 for one stat: (season minutes * raw + k * prior) / (season minutes + k) */
function shrunkRate(sum, prev, posMean, stat, k, kPrev) {
  if (!sum || !sum.minutes_total) return prev ? prev.per40[stat] : posMean ? posMean[stat] : null;
  const raw = sum.per40[stat];
  if (prev && prev.min >= 100) return (sum.minutes_total * raw + kPrev * prev.per40[stat]) / (sum.minutes_total + kPrev);
  const pm = posMean ? posMean[stat] : raw;
  return (sum.minutes_total * raw + k * pm) / (sum.minutes_total + k);
}

/** score minutes and per-40 forecasts on one season; returns metrics per candidate */
function evaluate(PG, season, cfg) {
  const prev = previousRates(PG, season); const pos = positionMeans(PG, season);
  const acc = {}; const add = (name, e) => { const a = acc[name] || (acc[name] = { n: 0, ae: 0, se: 0 }); a.n++; a.ae += Math.abs(e); a.se += e * e; };
  walkSeason(PG, season, cfg.half_life, (rows, book, team) => {
    for (const r of rows) {
      if (r.dnp || !(r.min > 0)) continue;
      const s = book.summary(team, r.athlete); if (!s || s.games < 3) continue;
      add('minutes:ewma', r.min - s.expected_minutes); add('minutes:season_mean', r.min - s.season_mpg); add('minutes:last5', r.min - s.last5_mpg); add('minutes:last_game', r.min - s.last_game);
      const p = prev.get(r.athlete); const pm = pos[r.pos || '?'];
      for (const k of RATE_STATS) {
        const y = statOf(r, k);
        add(`${k}:raw_season_rate`, y - (s.per40[k] * r.min) / 40);
        add(`${k}:shrunk_rate`, y - (shrunkRate(s, p, pm, k, cfg.k_pos, cfg.k_prev) * r.min) / 40);
      }
    }
  });
  const out = {}; for (const [k, a] of Object.entries(acc)) out[k] = { n: a.n, mae: U.r(a.ae / a.n, 4), rmse: U.r(Math.sqrt(a.se / a.n), 4) };
  return out;
}

/** choose the EWMA half-life and shrinkage weights on `season` (selection) by MAE */
function tune(PG, season) {
  const log = []; let best = null;
  for (const h of [2, 3, 5, 8, 12]) { const m = evaluate(PG, season, { half_life: h, k_pos: 200, k_prev: 200 }); log.push({ half_life: h, mae: m['minutes:ewma'].mae }); if (!best || m['minutes:ewma'].mae < best.mae) best = { half_life: h, mae: m['minutes:ewma'].mae }; }
  let bestK = null;
  for (const kp of [50, 150, 400]) for (const kv of [100, 300, 800]) {
    const m = evaluate(PG, season, { half_life: best.half_life, k_pos: kp, k_prev: kv });
    const mae = m['pts:shrunk_rate'].mae + m['reb:shrunk_rate'].mae + m['ast:shrunk_rate'].mae;
    log.push({ k_pos: kp, k_prev: kv, mae_sum: U.r(mae, 4) });
    if (!bestK || mae < bestK.mae) bestK = { k_pos: kp, k_prev: kv, mae };
  }
  return { half_life: best.half_life, k_pos: bestK.k_pos, k_prev: bestK.k_prev, log };
}

module.exports = { MinutesBook, walkSeason, evaluate, tune, previousRates, positionMeans, shrunkRate, RATE_STATS, statOf };

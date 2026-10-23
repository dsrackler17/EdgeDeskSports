'use strict';
/* ===========================================================================
   The committed NCAAM dataset, typed, and the immutable training snapshot.

   load(seasons) reads data/games_<season>.csv.gz after checking each file's
   sha256 against data/manifest.json (a mismatch throws: a hand-edited or
   half-written file never trains a model) and returns typed games.

   engineGames(games) turns them into the records the research engine
   (basketball/ncaam_research/team_model.js runSeason) consumes, unchanged:
   possessions = mean of the two sides' FGA - ORB + TOV + 0.475 FTA (0.475 is
   the published college free-throw-trip constant, an external constant — not
   fitted on any outcome here, so no later season leaks into an earlier one),
   offensive efficiency = 100 * points / possessions, tempo per 40 minutes with
   overtime removed. Only box_ok games enter the possession model; score_ok
   games without a usable box score are counted (coverage.json) and excluded.

   snapshot(games, through) is the canonical, hashed list of every row a fit
   at time `through` may read: games whose assumed availability (start + 4 h)
   is before `through`. Its sha256 identifies the training input of an
   artifact; the same rows always give the same hash.
   =========================================================================== */
const fs = require('fs');
const crypto = require('crypto');
const C = require('./config');
const { readCsv } = require('../../engine/csv');
const { COLS } = require('./ingest');

const NUM = new Set(['season', 'season_type', 'neutral', 'conf_game', 'tournament_id', 'home_d1', 'away_d1', 'home_seed', 'away_seed', 'hs', 'as', 'periods', 'n_ot', 'score_ok', 'box_ok']);
const POSS_FTA = 0.475;
const DAY = 864e5;

function manifest() { return JSON.parse(fs.readFileSync(C.PATHS.manifest, 'utf8')); }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function loadSeason(season, man) {
  const f = C.PATHS.season(season);
  if (!fs.existsSync(f)) return [];
  const buf = fs.readFileSync(f);
  const m = (man || manifest()).seasons[season];
  if (!m) throw new Error('season ' + season + ' is not in data/manifest.json');
  if (sha256(buf) !== m.sha256) throw new Error('HASH MISMATCH for data/games_' + season + '.csv.gz: the file does not match data/manifest.json. Re-run the ingest; never edit the data by hand.');
  return readCsv(f).rows.map((r) => {
    const g = {};
    for (const k of COLS) { const v = r[k]; g[k] = NUM.has(k) || /^[ha]_/.test(k) ? (v === '' || v == null ? null : Number(v)) : (v === '' ? null : v); }
    g.start_ms = Date.parse(g.start_utc);
    g.quarantine = g.quarantine ? g.quarantine.split('|') : [];
    return g;
  });
}

function load(seasons) {
  const man = manifest(); const out = [];
  for (const s of seasons || C.seasons()) out.push(...loadSeason(s, man));
  out.sort((a, b) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : 1));
  return out;
}

const teamPoss = (g, s) => g[s + '_fga'] - g[s + '_orb'] + g[s + '_tov'] + POSS_FTA * g[s + '_fta'];

/** research-engine game records (team_model.js buildGames shape). With
    o.scheduledFrom, SCHEDULED games starting at or after that moment are added
    WITHOUT results: the engine reads them only to give every scheduled team
    its preseason prior, and stops before predicting or absorbing them. */
function engineGames(games, o) {
  const out = []; const last = new Map(); const from = o && o.scheduledFrom != null ? o.scheduledFrom : null;
  for (const g of games) {
    if (from != null && g.status === 'SCHEDULED' && g.start_ms >= from && g.home_id && g.away_id && g.home_id !== g.away_id) {
      out.push({ game_id: Number(g.game_id), season: g.season, start_ms: g.start_ms, day: g.start_ms / DAY, home: g.home_id, away: g.away_id, neutral: g.neutral === 1,
        regime: g.home_d1 && g.away_d1 ? 'D1_D1' : g.home_d1 || g.away_d1 ? 'D1_OTHER' : 'OTHER_OTHER', home_d1: g.home_d1 === 1, away_d1: g.away_d1 === 1,
        event: g.event, conference_game: g.conf_game === 1, scheduled: true });
      continue;
    }
    if (g.status !== 'FINAL' || !g.score_ok) continue;
    const restH = last.has(g.home_id) ? (g.start_ms - last.get(g.home_id)) / DAY : null;
    const restA = last.has(g.away_id) ? (g.start_ms - last.get(g.away_id)) / DAY : null;
    last.set(g.home_id, g.start_ms); last.set(g.away_id, g.start_ms);
    if (!g.box_ok) continue;
    const ph = teamPoss(g, 'h'); const pa = teamPoss(g, 'a'); const poss = (ph + pa) / 2;
    const minutes = C.RULES.regulation_minutes + C.RULES.overtime_minutes * (g.n_ot || 0);
    out.push({
      game_id: Number(g.game_id), season: g.season, start_ms: g.start_ms, day: g.start_ms / DAY, home: g.home_id, away: g.away_id, neutral: g.neutral === 1,
      regime: g.home_d1 && g.away_d1 ? 'D1_D1' : g.home_d1 || g.away_d1 ? 'D1_OTHER' : 'OTHER_OTHER', home_d1: g.home_d1 === 1, away_d1: g.away_d1 === 1,
      event: g.event, conference_game: g.conf_game === 1, minutes, n_ot: g.n_ot || 0, poss, tempo: (poss * C.RULES.regulation_minutes) / minutes,
      hs: g.hs, as: g.as, yH: (100 * g.hs) / poss, yA: (100 * g.as) / poss, rest_h: restH, rest_a: restA,
      ncaa_round: g.ncaa_round, home_seed: g.home_seed, away_seed: g.away_seed,
    });
  }
  return out;
}

/** the rows a fit at time `throughMs` may read, canonical and hashed */
function snapshot(games, throughMs) {
  const rows = games.filter((g) => g.status === 'FINAL' && Date.parse(g.assumed_available_at) < throughMs)
    .map((g) => [g.game_id, g.season, g.start_utc, g.home_id, g.away_id, g.neutral, g.hs, g.as, g.n_ot, g.score_ok, g.box_ok].concat(['h', 'a'].flatMap((s) => ['fga', 'orb', 'tov', 'fta'].map((k) => g[s + '_' + k]))));
  const text = JSON.stringify(rows);
  return { through: new Date(throughMs).toISOString(), rows: rows.length, sha256: sha256(text), seasons: [...new Set(rows.map((r) => r[1]))] };
}

/** coverage and exclusions, by season: nothing dropped without a count */
function coverage(games) {
  const by = {};
  for (const g of games) {
    const s = by[g.season] = by[g.season] || { rows: 0, final: 0, score_ok: 0, box_ok: 0, d1_d1_box_ok: 0, not_played: 0, scheduled: 0, quarantined: {}, excluded_from_possession_model: 0 };
    s.rows++;
    if (g.status === 'FINAL') s.final++; else if (g.status === 'SCHEDULED') s.scheduled++; else s.not_played++;
    if (g.score_ok) s.score_ok++; if (g.box_ok) s.box_ok++; if (g.box_ok && g.home_d1 && g.away_d1) s.d1_d1_box_ok++;
    if (g.score_ok && !g.box_ok) s.excluded_from_possession_model++;
    for (const r of g.quarantine) { const k = r.replace(/_OF_\d+$/, '').replace(/:.*$/, ''); s.quarantined[k] = (s.quarantined[k] || 0) + 1; }
  }
  for (const s of Object.values(by)) s.box_coverage = s.final ? +(s.box_ok / s.final).toFixed(4) : null;
  return by;
}

module.exports = { load, loadSeason, engineGames, snapshot, coverage, manifest, POSS_FTA, sha256 };

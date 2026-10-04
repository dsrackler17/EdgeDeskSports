#!/usr/bin/env node
/* ============================================================================
   TRAINING READINESS for a future non-QB injury coefficient. It FITS NOTHING.

   It joins each game's LAST frozen pregame personnel entry
   (record/football/personnel/) to the model record's final
   (record/football/<sport>_<season>.json) and states the residual the future
   model would regress:

       residual = actual_home_margin - frozen_pregame_projected_margin

   against the frozen injury state (the home-minus-away expected impact, and
   per-absence position, replacement gap, matchup leverage, concentration and
   probability). Then it counts how many games are usable and compares that
   with config.TRAINING. The coefficient stays untrained whatever the count:
   promotion needs the three-part out-of-sample bar, run by a validator that
   does not exist yet, and until then football/personnel/impact.js returns 0.

     node football/personnel/training.js          # readiness report
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CFG = require('./config.js');
const FREEZE = require('./freeze.js');

const ROOT = path.resolve(__dirname, '..', '..');
function ms(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }

/* ledgers: [personnel ledger]; records: { <sport>: model record ledger } */
function trainingRows(ledgers, records) {
  const out = [];
  (ledgers || []).forEach(function (L) {
    const rec = records && records[L.sport];
    Object.keys(L.entries || {}).sort().forEach(function (gid) {
      const list = (L.entries[gid] || []).filter(function (e) { return ms(e.frozen_at) < ms(e.kickoff); });
      if (!list.length) return;
      const e = list[list.length - 1];
      const st = L.states[e.state];
      const g = rec && rec.games ? rec.games[gid] : null;
      const fin = g && g.final && isNum(g.final.home_score) && isNum(g.final.away_score) ? g.final : null;
      const actual = fin ? fin.home_score - fin.away_score : null;
      const proj = e.projection ? e.projection.projected_home_margin : null;
      const h = st.teams.home, a = st.teams.away;
      out.push({
        game_id: gid, sport: L.sport, season: L.season, week: L.week,
        frozen_at: e.frozen_at, kickoff: e.kickoff,
        projected_home_margin: proj, actual_home_margin: actual,
        residual: isNum(actual) && isNum(proj) ? actual - proj : null,
        home_status: h.status, away_status: a.status,
        home_impact: h.impact, away_impact: a.impact,
        impact_differential: isNum(h.impact) && isNum(a.impact) ? h.impact - a.impact : null,
        home_confidence: h.confidence, away_confidence: a.confidence,
        absences: st.rows.length,
        rated_absences: st.rows.filter(function (r) { return r.rated; }).length
      });
    });
  });
  return out;
}

function readiness(rows, sport) {
  const T = CFG.TRAINING;
  const mine = rows.filter(function (r) { return r.sport === sport; });
  const usable = mine.filter(function (r) { return isNum(r.residual) && isNum(r.impact_differential); });
  const seasons = {};
  usable.forEach(function (r) { seasons[r.season] = (seasons[r.season] || 0) + 1; });
  const need = T.minimum_games[sport];
  const needSeasons = T.minimum_seasons.train + T.minimum_seasons.holdout;
  return {
    sport: sport,
    frozen_games: mine.length,
    settled_games: mine.filter(function (r) { return isNum(r.residual); }).length,
    usable_games: usable.length,
    required_games: need,
    seasons_with_usable_games: Object.keys(seasons).length,
    required_seasons: needSeasons,
    coefficient_trained: false,
    projection_adjustment: 0,
    statement: usable.length >= need && Object.keys(seasons).length >= needSeasons
      ? 'enough frozen history exists to ATTEMPT a fit; the coefficient is still untrained until it clears '
        + 'the out-of-sample bar (' + T.promotion_bar.join('; ') + ')'
      : 'building history: ' + usable.length + ' of ' + need + ' usable games across '
        + Object.keys(seasons).length + ' of ' + needSeasons + ' seasons. No coefficient is fitted.'
  };
}

function main() {
  const ledgers = FREEZE.ledgerFiles().map(function (f) { return readJson(f, null); }).filter(Boolean);
  const seasons = {};
  ledgers.forEach(function (L) { seasons[L.sport + '_' + L.season] = true; });
  const records = {};
  Object.keys(seasons).forEach(function (k) {
    const sport = k.split('_')[0];
    const rec = readJson(path.join(ROOT, 'record', 'football', k + '.json'), null);
    if (rec) {
      if (!records[sport]) records[sport] = { games: {} };
      Object.assign(records[sport].games, rec.games || {});
    }
  });
  const rows = trainingRows(ledgers, records);
  ['cfb', 'nfl'].forEach(function (s) { console.log(JSON.stringify(readiness(rows, s))); });
}

if (require.main === module) main();

module.exports = { trainingRows, readiness };

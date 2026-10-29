/* ============================================================================
   SP+ projected lines for a week's games (node). football/sp_plus/README.md

   appliedHomeField()   the home field EdgeDesk's CFB engine applies, read from
                        the engine itself: football/cfb_p4/home_field.js when
                        the engine has it promoted for its params.js, else
                        params.venue.league_hfa. One value, one place.
   buildGames(slate, ratings, week, hf)
                        one entry per slate game of the captured week: the
                        derived line (lib/cfb_sp_plus.js projectHomeMargin), or
                        UNAVAILABLE with the reason (a team SP+ does not rate).
                        Only the derived margin and line are kept: no rating
                        leaves this function.
   ========================================================================== */
'use strict';
const path = require('path');
const SP = require('../../lib/cfb_sp_plus.js');

function appliedHomeField(engine) {
  const E = engine || require('../cfb_p4/engine.js');
  const HF = E.homeField();
  if (HF && typeof HF.hfa === 'number') {
    return { hfa: HF.hfa, source: 'football/cfb_p4/home_field.js', version: HF.version || null, model_version: HF.model_version || null };
  }
  const P = E._internal && E._internal.params ? E._internal.params() : null;
  const v = P && P.venue && P.venue.league_hfa;
  if (typeof v !== 'number') throw new Error('the CFB engine applies no home field this build can read');
  return { hfa: v, source: 'football/cfb_p4/params.js venue.league_hfa', version: null, model_version: P.model_version || null };
}

function weekKey(season, seasonType, week) { return season + ':' + (seasonType === 'postseason' ? 1 : 0) + ':' + String(week).padStart(2, '0'); }

/* ratings: team_id -> { sp_overall } for the captured week; week: { season, week_key } */
function buildGames(slate, ratings, week, hf) {
  const games = {};
  ((slate && slate.games) || []).forEach((g) => {
    const season = Number.isInteger(g.season) ? g.season : week.season;
    if (weekKey(season, g.season_type, g.week) !== week.week_key) return;
    const e = { home: g.home_team, away: g.away_team, home_id: g.home_team_id, away_id: g.away_team_id, week: g.week, week_key: week.week_key,
      kickoff: g.kickoff || null, neutral: !!g.neutral_site };
    const h = ratings[g.home_team_id], a = ratings[g.away_team_id];
    if (!h || !a) {
      const missing = [[h, g.home_team, g.home_division], [a, g.away_team, g.away_division]].filter((x) => !x[0])
        .map((x) => x[1] + (x[2] && x[2] !== 'fbs' ? ' (' + String(x[2]).toUpperCase() + ': SP+ rates FBS teams)' : ''));
      Object.assign(e, { state: 'UNAVAILABLE', reason: 'no SP+ rating for ' + missing.join(' or '), home_margin: null, home_line: null });
    } else {
      const m = SP.projectHomeMargin(h.sp_overall, a.sp_overall, e.neutral, hf.hfa);
      Object.assign(e, m === null ? { state: 'UNAVAILABLE', reason: 'the projection could not be computed', home_margin: null, home_line: null }
        : { state: 'AVAILABLE', reason: null, home_margin: m, home_line: SP.homeLine(m) });
    }
    games[String(g.game_id)] = e;
  });
  return games;
}

function projectionMeta(hf) {
  return { rule: SP.RULE, form: SP.FORM, hfa: hf.hfa, hfa_source: hf.source, hfa_version: hf.version, lib: 'lib/cfb_sp_plus.js',
    precision: 'stored at 0.01, shown at 0.1', disagree_points: SP.DISAGREE_PTS };
}

module.exports = { appliedHomeField, buildGames, projectionMeta, weekKey, LIB: path.join(__dirname, '..', '..', 'lib', 'cfb_sp_plus.js') };

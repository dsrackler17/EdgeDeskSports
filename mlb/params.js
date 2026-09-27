/* ===========================================================================
   EdgeDesk BASEBALL RUN MODEL — the published constants.

   WHAT THIS FILE IS. Every number the baseball engine (mlb/engine.js) uses
   that is not read from a table lives here, with the reason it holds that
   value written beside it. Nothing in the engine is a magic number: if a
   constant is a design choice it says so, if it was measured it says what it
   was measured from, and if it is a convention borrowed from public baseball
   research it names the convention.

   WHAT THIS MODEL IS NOT. It is NOT walk-forward trained, it has NO graded
   closing-line record, and no coefficient here was fitted by an optimiser
   against a line archive. EdgeDesk holds no MLB or college baseball line
   archive to fit against, so nothing was fitted, and a model that has not
   beaten a close is not evidence of an edge. The engine reports
   `unproven: true` on every projection it returns and the surface labels it
   EXPERIMENTAL wherever it is drawn. The honest description is: a
   transparent, deterministic run-expectancy calculation whose every step is
   inspectable, built so a reader can see WHY a number differs from the
   market rather than being handed a number to trust.

   The structure is deliberately the same shape as football/params.js: one
   published object, versioned, with provenance travelling on it.
   =========================================================================== */
(function (root) {
  'use strict';

  var P = {
    model_version: 'edgedesk_baseball_v1.0.0',
    built_at: '2026-09-18',
    /* The engine refuses to project for a season beyond this window +1, the
       same guard football/engine.js applies. Baseball's constants are league
       scoring-environment constants, and those drift. */
    calibrated_through_season: 2025,

    /* ── MLB ──────────────────────────────────────────────────────────── */
    mlb: {
      feature_version: 'ed_mlb_run_v1',

      /* League scoring environment. Used ONLY when the live league baseline
         cannot be computed from the team_season rows actually on hand — it is
         a floor, never a preference. 2023-2025 MLB sat between 4.39 and 4.62
         runs per team per game; 4.45 is the middle of that band. */
      league_runs_per_game: 4.45,

      /* Home advantage, expressed in the ratio the engine multiplies by.
         MLB home clubs have won ~53.5% of games over the last decade and
         score roughly 2% more runs than the same clubs score on the road;
         the split below reproduces that without being fitted to it. */
      home_offense_mult: 1.020,
      away_offense_mult: 0.988,
      /* A tie after nine goes to extras, where the home club bats last with
         the runner on second. Public tabulations of the automatic-runner era
         put the home side a shade over even; 0.52 is that shade. */
      extra_innings_home_win: 0.52,
      /* THE LAST-BAT CORRECTION, and it exists because of a real asymmetry a
         symmetric run distribution cannot express. A home club leading after
         the top of the ninth does not bat again, so its observed runs per
         game UNDERSTATE its scoring rate; and batting last converts tie and
         one-run situations at a rate no runs-only comparison reproduces. MLB
         home clubs have won about 53.2% of games over the last decade, while
         the observed home/away run split alone implies roughly 51.6%. This is
         that gap, added to the home win probability after the distribution
         and never to either club's runs — it must not move a total. */
      home_last_bat_win_bonus: 0.016,

      /* Regression. A club's rate is trusted in proportion to how much of it
         has been played: rate_used = league + (rate - league) * G/(G+k).
         k is a prior strength in games, chosen so that a club is roughly
         half-trusted at the point its season rate first stabilises in public
         reliability work (~30 team games for run scoring). */
      offense_regress_games: 30,
      defense_regress_games: 30,
      /* A starter's own line is regressed toward the league by IP/(IP+k).
         50 IP is the same order the pitching archive's performance_index
         uses (IP/(IP+40)) and errs toward the league rather than toward a
         small sample. */
      starter_regress_ip: 50,
      bullpen_regress_ip: 60,

      /* How much of a game the starter is responsible for. MLB starters
         averaged 5.2 innings per start in 2024 and 5.1 in 2025; the engine
         uses the share of nine innings that represents, and lets a caller
         override it per pitcher when a real expectation is known. */
      starter_innings_default: 5.2,
      starter_innings_min: 3.0,
      starter_innings_max: 7.5,

      /* FIP and xERA are earned-run scales. A run projection needs RUNS
         ALLOWED, which includes unearned. The MLB ratio of RA9 to ERA has sat
         between 1.07 and 1.09 for a decade. */
      era_to_ra9: 1.08,
      /* When several pitching estimators are present the engine blends them
         rather than picking one. Weights are a design choice: the two
         estimators that describe process (xERA, FIP) carry more than the one
         that describes outcome (ERA), because a starter's run prevention in
         ONE future game is better described by process. They are NOT fitted. */
      starter_blend: { xera: 0.40, fip: 0.35, era: 0.25 },

      /* Bullpen. A taxed arm is a flagged arm, and the flags EdgeDesk carries
         are severity-graded. The penalty is applied to the relief share of
         the game only, and it is capped: a bullpen cannot be made worse than
         this no matter how many arms are flagged. */
      bullpen_taxed_penalty: 0.018,      /* per flagged arm, on the relief run rate */
      bullpen_taxed_cap: 0.09,
      bullpen_closer_out_penalty: 0.020,

      /* Park. mlb_game_cards publishes run_factor and hr_factor as indices
         where 100 is neutral. A park factor describes a whole game, so each
         side's expectation carries the square root of it. */
      park_weight: 1.0,
      park_factor_min: 0.85,
      park_factor_max: 1.18,

      /* Weather, and every one of these is small on purpose. Weather moves a
         total; it barely moves a side, because it reaches both clubs. The
         temperature slope is the one public-research consensus figure here:
         roughly 1% more scoring per 10°F above a 70°F reference. */
      weather: {
        temp_reference_f: 70,
        temp_run_pct_per_degree: 0.0010,
        temp_clamp_pct: 0.045,
        /* Wind along the field axis, in the mph component blowing out.
           Park-specific studies of extreme venues report much larger swings
           than this; averaged across thirty parks the effect is smaller, and
           the engine deliberately carries the smaller number. The clamp is
           what separates a real 15 mph tailwind from a bad sensor reading. */
        wind_out_pct_per_mph: 0.0045,
        wind_clamp_pct: 0.055,
        /* Rain does not change the run environment; it changes whether the
           game is played. It is surfaced as a warning, never as runs. */
        precip_warn_pct: 50
      },

      /* The run distribution. Team runs in a game are Poisson-like in shape
         and clearly overdispersed: across 2016-2025 MLB team-games the
         variance-to-mean ratio of runs scored sits near 2.0. The engine uses
         a negative binomial with that dispersion, which is what turns a run
         expectation into a win probability, an over/under probability and a
         run-line probability without a simulation. */
      run_dispersion: 2.00,
      run_support_max: 24,

      /* Guard bounds. Past these the engine says DATA FAULT rather than
         EDGE — exactly the football convention. A five-run disagreement with
         a market total is not an opportunity, it is a broken input. */
      guard: { total_runs: 2.5, win_prob_pts: 18 },
      /* Where research attention starts. Not a bet threshold; there is no
         validated bet threshold for this model and there will not be one
         until a graded closing-line record exists. */
      review: { total_runs: 0.75, win_prob_pts: 4.0 },

      data_provenance: 'Schedule, probable starters, park indices and forecast: mlb_game_cards. '
        + 'Per-game pitching and offensive features: pitcher_features and offense_features, joined through games.game_id. '
        + 'Season-to-date club and pitcher rates: team_season and pitcher_season. Bullpen flags: mlb_bullpen_taxed '
        + 'and mlb_bullpen_team. Market: the odds capture (public.signals) as captured. No value in this engine is '
        + 'fitted to a betting line, because EdgeDesk holds no MLB line archive to fit one to.'
    },

    /* ── COLLEGE BASEBALL ─────────────────────────────────────────────── */
    cbb: {
      feature_version: 'ed_cbb_run_v1',

      /* Division I scoring has climbed with the bat standards; recent full
         seasons have run between 6.3 and 6.9 runs per team per game. As with
         MLB this is the fallback, and the live league mean folded out of
         cbb.team_seasons is preferred whenever it can be computed. */
      league_runs_per_game: 6.60,

      /* College home advantage is much larger than MLB's — home clubs have
         won around 58-60% of non-neutral Division I games. */
      home_offense_mult: 1.075,
      away_offense_mult: 0.945,
      extra_innings_home_win: 0.53,
      /* The same structural correction as MLB's, smaller in relative terms
         because the college home run-split is already large. */
      home_last_bat_win_bonus: 0.015,

      /* Fewer games in a college season, so the prior is proportionally
         stronger and the number of games is a bigger part of the story. */
      offense_regress_games: 14,
      defense_regress_games: 14,

      /* THE SCHEDULE ADJUSTMENT, and the one piece of real inference here.
         Games inside a conference cancel: every run one member scores against
         another is a run a member allows. So a conference's AGGREGATE run
         differential is earned entirely in its non-conference games, and
         dividing it by the non-conference games played gives runs per
         non-conference game — a schedule-strength measure computed from the
         same folded table the records come from, with no second source and no
         poll in it. It is damped by the weight below because a club is not
         its conference, and clamped because a tiny non-conference sample
         produces a large ratio. */
      conference_adjust_weight: 0.55,
      conference_adjust_clamp_runs: 2.2,
      conference_min_nonconf_games: 20,

      /* College run scoring is more dispersed than MLB's: bigger innings,
         shorter effective pitching staffs, wider talent spread. */
      run_dispersion: 2.35,
      run_support_max: 32,

      guard: { total_runs: 4.0, win_prob_pts: 22 },
      review: { total_runs: 1.25, win_prob_pts: 5.0 },

      data_provenance: 'Game log: cbb.games, the union of the day scoreboard and every club’s own schedule. '
        + 'Records, run rates and conference splits: cbb.team_seasons, folded from that log inside the promote so '
        + 'there is no second source to disagree with. No probable starter exists in this data and none is '
        + 'invented; the engine widens its own uncertainty instead.'
    },

    /* ── THE RECORD, STATED PLAINLY ───────────────────────────────────── */
    validation: {
      walk_forward: false,
      graded_closing_line_record: null,
      beats_closing_line: null,
      note: 'No backtest exists for this model because EdgeDesk carries no MLB or college baseball line '
        + 'archive to backtest against. What HAS been checked is in mlb/tests.js: the engine is deterministic, '
        + 'league-average inputs return the league average, the run distribution reproduces its stated mean and '
        + 'variance, probabilities sum to one, the market conversions round-trip, and every guard bound fires. '
        + 'Those are self-consistency checks. They are not evidence that this number beats a closing line, and '
        + 'nothing in EdgeDesk counts a baseball projection as validated.'
    }
  };

  root.EDBaseballParams = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);

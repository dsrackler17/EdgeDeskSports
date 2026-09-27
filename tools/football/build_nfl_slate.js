#!/usr/bin/env node
/* ============================================================================
   THE NFL SLATE ARTIFACT — football/nfl/slate.json

   WHY. The NFL projection has only ever existed in the browser: app.html
   fetches nflverse's games.csv and stats_team_week, absorbs the season into
   the trained rating state and projects each upcoming game with
   EDFootball.predictGame(). The edge function had none of that — its NFL
   slate came from `public.games` with no model line — so a server-side NFL
   packet carried the model as missing. This job runs THE SAME MODULE, out of
   the same app.html, in Node, and publishes what the board shows.

   HOW. tools/football/_module.js boots the real football IIFE with a stub DOM
   (the harness every football test uses). fetch is answered from the network
   with a local cache; the Supabase read that joins captured quotes is answered
   empty, so every number here is the MODEL'S with NO market attached — the
   function joins the market itself. The module's own fbLoadNfl() does the
   absorb pass and builds the upcoming board; fbPredict() projects each game
   through fbNflGameReq(), exactly as the browser does.

   Every row carries the model's home line in BOTH conventions, the fair total,
   the home win probability, the outcome range as p10/p50/p90 home margins,
   the contributions that carried the number, the data-quality warnings, the
   schedule row's own rest/roof/surface/division context, the starter the
   schedule feed names, and the nflverse reference lines labelled as
   REFERENCE — never as a price.

   Usage
     node tools/football/build_nfl_slate.js                   # writes the artifact
     node tools/football/build_nfl_slate.js --offline         # cached feeds only
     node tools/football/build_nfl_slate.js --check           # build, compare, write nothing
     node tools/football/build_nfl_slate.js --lookahead 10    # days (default: the module's own)
   Exit 0 = written or current; 1 = the artifact differs (--check); 2 = the
   feeds could not be read at all (reported, never a pass).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./_module.js');

const ROOT = M.ROOT;
const OUT_DIR = path.join(ROOT, 'football', 'nfl');
const OUT = path.join(OUT_DIR, 'slate.json');
const CACHE = path.join(OUT_DIR, '.cache');
const SCHEMA = 'edgedesk_nfl_slate_v1';
let NV = null; try { NV = require(path.join(__dirname, 'nfl_venues.js')); } catch (_) { NV = null; }
let WX = null, RECOVERY = null; try { WX = require(path.join(ROOT, 'football', 'matchup', 'weather.js')); RECOVERY = require(path.join(ROOT, 'football', 'data', 'recovery.js')); } catch (_) { WX = null; }
let COACHING = null; try { COACHING = require(path.join(ROOT, 'football', 'nfl', 'coaching_staff.js')); } catch (_) { COACHING = null; }
const COACHING_SEED_FILE = path.join(ROOT, 'football', 'nfl', 'coaching_staff_seed.json');
const COACHING_VALIDATION_FILE = path.join(ROOT, 'football', 'validation', 'nfl_coaching_staff.json');
const FORECAST_STORE = path.join(ROOT, 'football', 'venues', 'forecasts.json');

/* Slice 4: THE NFL FORECAST. The same keyless provider and the same module the
   college build uses, joined on the verified NFL stadium table. Only observed
   forecasts are written into the shared store, keyed by the nflverse game id
   the edge function reads; college entries are preserved. */
function nflForecastWanted(games) {
  if (!NV) return [];
  return games.filter((g) => g.kickoff).map((g) => ({ game_id: g.game_id, kickoff: g.kickoff, venue: NV.venueFor({ stadium: g.venue, club: g.home_code }) }));
}
async function fetchNflForecasts(games, opts) {
  const wanted = nflForecastWanted(games);
  const report = { requested: wanted.length, no_venue: wanted.filter((w) => !w.venue).length, answered: 0, dome: 0, failed: 0, written: false, error: null };
  if (!wanted.length || !WX || !RECOVERY || (opts && opts.offline)) { report.error = !WX ? 'weather module unavailable' : (opts && opts.offline ? 'offline' : null); return { report, byGame: {} }; }
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(FORECAST_STORE, 'utf8')); } catch (_) { prev = {}; }
  try {
    const sess = RECOVERY.session({ host_min_gap_ms: 80, budget_ms: 60000 });
    const wx = await WX.fetchForGames(sess, wanted, { concurrency: 4, previous: (prev && prev.by_game) || {} });
    report.answered = wx.report.answered; report.dome = wx.report.dome; report.failed = wx.report.failed;
    if (wx.report.answered > 0 || wx.report.dome > 0) {
      const merged = Object.assign({}, (prev && prev.by_game) || {}, WX.forCommit(wx.byGame, wanted));
      fs.writeFileSync(FORECAST_STORE, JSON.stringify(Object.assign({}, prev, { schema: prev.schema || 'edgedesk_forecast_store_v1', generated_at: new Date().toISOString(), source: (prev.source ? prev.source + '; ' : '') .replace(/; NFL games joined on football\/venues\/nfl_stadiums\.json.*$/, '') + 'NFL games joined on football/venues/nfl_stadiums.json (hand-entered, verified)', by_game: merged }), null, 1) + '\n');
      report.written = true;
    }
    return { report, byGame: wx.byGame };
  } catch (e) { report.error = String(e && e.message || e); return { report, byGame: {} }; }
}

function r2(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function r4(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Eastern-time kickoff from games.csv's gameday + gametime, as ISO UTC. */
function etToIso(gameday, gametime) {
  if (!gameday) return null;
  const hm = /^(\d{1,2}):(\d{2})/.exec(String(gametime || '12:00')) || ['', '12', '00'];
  const guess = Date.parse(gameday + 'T' + hm[1].padStart(2, '0') + ':' + hm[2] + ':00Z');
  if (!Number.isFinite(guess)) return null;
  /* the ET offset on that date, from Intl, so DST is right without a table */
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(guess));
  const tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT-5';
  const m = /GMT([+-]\d+)/.exec(tz);
  const offsetH = m ? Number(m[1]) : -5;
  return new Date(guess - offsetH * 3600000).toISOString();
}

async function fetchText(url, offline) {
  const key = url.replace(/[^a-z0-9.]+/gi, '_').slice(-120);
  const cached = path.join(CACHE, key);
  if (offline && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  if (offline) throw new Error('offline and not cached: ' + url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const t = await r.text();
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cached, t); } catch (_) { /* cache is a convenience */ }
  return t;
}

async function build(opts) {
  opts = opts || {};
  const B = M.boot({ probe: ['fbLoadNfl', 'fbNflGameReq', 'fbNflRefMarket', 'fbPredict', 'FB_CODE_NAMES', 'fbNflRanks', 'FB_LOOKAHEAD_D'] });
  if (B.error) throw new Error('the football module would not run: ' + (B.error.message || B.error));
  const win = B.win;
  M.loadNflEngine(win, ROOT);
  const T = win.__FBTEST;
  const fetched = [];
  /* the network, cached; the captured-quote read answered empty on purpose */
  const getText = opts.fetchText || ((u) => {
    const s = String(u || '');
    if (s.startsWith('/')) {
      const local = path.join(ROOT, s.replace(/^\/+/, ''));
      if (fs.existsSync(local) && fs.statSync(local).isFile()) {
        return Promise.resolve(fs.readFileSync(local, 'utf8'));
      }
    }
    return fetchText(s, !!opts.offline);
  });
  win.fetch = async (url) => {
    const u = String(url);
    const text = await getText(u);
    fetched.push({ url: u, bytes: text.length });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  win.sbGet = () => Promise.resolve([]);
  win.renderFootball = () => {};
  await T.fbLoadNfl(null);
  const S = win.FB.nfl;
  const season = S.curSeason;
  const meta = win.EDFootball.meta();
  const names = T.FB_CODE_NAMES || {};
  const now = opts.now || Date.now();
  const lookaheadDays = opts.lookahead || T.FB_LOOKAHEAD_D || 12;

  /* NFL Coaching / Staff research layer. Every residual uses S.weekPreds,
     which fbLoadNfl froze BEFORE that completed game was absorbed. There is
     no hindsight reconstruction here, and the component cannot move a line. */
  let coaching = {
    schema: 'edgedesk_nfl_coaching_staff_v1',
    status: 'UNAVAILABLE',
    affects_projection: false,
    observed_games: 0,
    teams: {},
    reason: COACHING ? 'no completed leak-free pregame residuals were available' : 'coaching_staff.js unavailable'
  };
  let coachingSeed = null;
  if (COACHING) {
    try {
      coachingSeed = opts.coachingSeed || JSON.parse(fs.readFileSync(COACHING_SEED_FILE, 'utf8'));
    } catch (_) { coachingSeed = opts.coachingSeed || null; }
    const cs = COACHING.newState(coachingSeed && coachingSeed.teams ? coachingSeed.teams : null);
    (S.games || []).filter((u) => u.done && u.g).forEach((u) => {
      const g = u.g, p = S.weekPreds && S.weekPreds[g.game_id];
      if (!p || p.status !== 'PREDICTED' || !p.model || num(p.model.fair_spread) == null
        || num(g.home_score) == null || num(g.away_score) == null) return;
      COACHING.observeGame(cs, {
        home: g.home_team,
        away: g.away_team,
        home_coach: g.home_coach || null,
        away_coach: g.away_coach || null,
        pregame_home_margin: num(p.model.fair_spread),
        actual_home_margin: num(g.home_score) - num(g.away_score),
        at: g.gameday || null
      });
    });
    coaching = COACHING.finalize(cs, {
      seeds: coachingSeed && coachingSeed.teams ? coachingSeed.teams : null
    });
    coaching.seed = coachingSeed ? {
      schema: coachingSeed.schema || null,
      trained_through_season: coachingSeed.trained_through_season || null,
      reliability_k: coachingSeed.reliability_k || null
    } : null;
  }

  let coachingValidation = null;
  try {
    coachingValidation = opts.coachingValidation || JSON.parse(fs.readFileSync(COACHING_VALIDATION_FILE, 'utf8'));
  } catch (_) { coachingValidation = opts.coachingValidation || null; }
  const tunedStaffCap = coachingValidation && num(coachingValidation.tuned_cap) != null
    ? num(coachingValidation.tuned_cap) : 0;
  const validatedStaffCap = coachingValidation && coachingValidation.affects_projection === true
    && num(coachingValidation.selected_cap) != null ? num(coachingValidation.selected_cap) : 0;
  function staffCandidate(row, cap) {
    const p = row && num(row.coaching_staff_residual_points);
    if (p == null || !(cap > 0)) return null;
    return Math.max(-cap, Math.min(cap, p));
  }

  /* the module already trimmed S.up to its window; widen from S.games when a
     longer lookahead was asked for */
  const pool = (S.games || []).filter((u) => !u.done && u.t >= now - 6 * 3600000 && u.t <= now + lookaheadDays * 86400000);
  const games = pool.map((u) => {
    const g = u.g;
    let p = null, err = null;
    const req = T.fbNflGameReq(g);
    try { p = T.fbPredict('nfl', req, {}, num(g.season)); } catch (e) { err = String(e && e.message || e); }
    const ref = T.fbNflRefMarket(g);
    const priced = !!(p && p.status === 'PREDICTED');
    const m = priced ? p.model : null;
    /* THE ENGINE RE-RUN, ONE INPUT CHANGED — the same scenarios the board's
       Scenario tester offers, published with the projection so the research
       desk can quote a CONDITIONAL estimate instead of guessing one. Nothing
       here is the projection: each row names the input it changed. */
    const rerun = (mod) => { const r = Object.assign({}, req); mod(r); try { const q2 = T.fbPredict('nfl', r, {}, num(g.season)); return q2 && q2.status === 'PREDICTED' ? q2 : null; } catch (_) { return null; } };
    const scen = {};
    if (priced) {
      const add = (key, mod, basis) => { const q2 = rerun(mod); if (q2) scen[key] = { home_line: r2(-q2.model.fair_spread), delta_home_line: r2(-(q2.model.fair_spread - m.fair_spread)), total: r2(q2.model.fair_total), home_win_prob: r4(q2.model.home_win_prob), basis, source: 'football/nfl/slate.json (engine re-run, one input changed)' }; };
      if (req.home_qb_id) add('home_qb_out', (r) => { r.home_qb_id = null; }, 'engine re-run with home_qb_id = null: the replacement carries the club\u2019s carried quarterback level, exactly what the engine does live when the feed names no starter');
      if (req.away_qb_id) add('away_qb_out', (r) => { r.away_qb_id = null; }, 'engine re-run with away_qb_id = null: the replacement carries the club\u2019s carried quarterback level');
      add('home_short_week', (r) => { r.home_rest = 4; }, 'engine re-run with home_rest = 4');
      add('away_short_week', (r) => { r.away_rest = 4; }, 'engine re-run with away_rest = 4');
      add('dome', (r) => { r.roof = 'dome'; }, 'engine re-run with roof = dome (weather inputs ignored)');
      add('cold_windy', (r) => { r.roof = 'outdoors'; r.temp = 25; r.wind = 20; }, 'engine re-run at 25\u00b0F and 20 mph wind (total inputs; the spread does not read weather)');
    }
    /* THE COVER CURVE — P(home covers) at every half-point home line within
       seven points of the fair line, from the engine's own spread-conditioned
       margin pmf (key-number aware) through the same fbPredict path the card
       uses. The validation tier still governs what it may be called. */
    const curve = [];
    if (priced) {
      const fair = m.fair_spread; /* projected HOME MARGIN */
      for (let k = -14; k <= 14; k++) {
        const hm = Math.round((fair + k * 0.5) * 2) / 2;       /* a market home margin near the fair one */
        const q2 = (() => { try { return T.fbPredict('nfl', req, { spread_line: hm }, num(g.season)); } catch (_) { return null; } })();
        const c = q2 && q2.status === 'PREDICTED' ? q2.cover : null;
        if (c && num(c.win) != null) curve.push({ home_line: r2(-hm), win: r4(c.win), push: r4(c.push), lose: r4(c.lose), basis: c.basis || null });
      }
    }
    const q = priced && p.outcome_range && p.outcome_range.q ? p.outcome_range.q : null;
    const contributions = priced && p.contributions ? {
      spread: (p.contributions.spread || []).map((c) => ({ key: c.key, value: r4(c.value), points: r2(c.points) })),
      total: (p.contributions.total || []).map((c) => ({ key: c.key, value: r4(c.value), points: r2(c.points) })),
    } : null;
    return {
      game_id: String(g.game_id), season: num(g.season), week: num(g.week), game_type: g.game_type || 'REG',
      kickoff: etToIso(g.gameday, g.gametime), gameday: g.gameday || null, gametime_et: g.gametime || null,
      home_code: g.home_team, away_code: g.away_team,
      home_team: names[g.home_team] || g.home_team, away_team: names[g.away_team] || g.away_team,
      home_team_id: String(g.home_team || '').toLowerCase(), away_team_id: String(g.away_team || '').toLowerCase(),
      venue: g.stadium || null, roof: g.roof || null, surface: g.surface || null, div_game: num(g.div_game) === 1,
      home_rest: num(g.home_rest), away_rest: num(g.away_rest),
      home_coach: g.home_coach || null, away_coach: g.away_coach || null,
      coaching_staff: (() => {
        const homeStaff = coaching.teams[g.home_team] || null;
        const awayStaff = coaching.teams[g.away_team] || null;
        const hc = staffCandidate(homeStaff, tunedStaffCap);
        const ac = staffCandidate(awayStaff, tunedStaffCap);
        const candidateMatchup = hc == null || ac == null ? null : hc - ac;
        return {
          validation_status: coachingValidation ? coachingValidation.status : 'UNVALIDATED',
          affects_projection: false,
          tuned_candidate_cap: tunedStaffCap || 0,
          validated_cap: validatedStaffCap || 0,
          candidate_home_points: r2(hc),
          candidate_away_points: r2(ac),
          candidate_matchup_points: r2(candidateMatchup),
          adjustment_points: 0,
          home: homeStaff,
          away: awayStaff,
          basis: 'research-only Coaching / Staff residual points. The candidate matchup shift is shown for audit; the applied NFL projection adjustment is exactly 0.'
        };
      })(),
      home_starter: g.home_qb_name ? { player_name: g.home_qb_name, player_id: g.home_qb_id || null, source: 'nflverse games.csv', status: 'SCHEDULE_FEED' } : null,
      away_starter: g.away_qb_name ? { player_name: g.away_qb_name, player_id: g.away_qb_id || null, source: 'nflverse games.csv', status: 'SCHEDULE_FEED' } : null,
      model_status: priced ? 'PREDICTED' : (p ? p.status : 'ERROR'),
      model_reason: priced ? null : (p ? (p.reason || (p.missing || []).join(', ')) : err),
      /* BOTH conventions, named. fair_spread is the projected HOME MARGIN. */
      model_home_margin: m ? r2(m.fair_spread) : null,
      model_home_line: m ? r2(-m.fair_spread) : null,
      model_fair_total: m ? r2(m.fair_total) : null,
      model_home_win_prob: m ? r4(m.home_win_prob) : null,
      model_fair_home_ml: m ? m.fair_home_ml : null, model_fair_away_ml: m ? m.fair_away_ml : null,
      outcome_range: q ? { p10: r2(q['0.1']), p50: r2(q['0.5']), p90: r2(q['0.9']), sigma: r2(p.outcome_range.sigma), basis: p.outcome_range.basis, unit: 'home margin, points' } : null,
      contributions, features: priced ? p.features : null,
      scenarios: Object.keys(scen).length ? scen : null,
      cover_curve: curve.length ? curve : null,
      data_quality: p ? p.data_quality : null, qb_known: priced && p.features ? p.features.qb_known : null,
      model_version: p ? p.model_version : meta.model_version, feature_version: p ? p.feature_version : null, fingerprint: p ? p.fingerprint : null,
      /* nflverse's consensus, labelled. spread_line is positive when the HOME
         side is favoured; the betting home line is its negation. */
      reference_market: (ref.spread_line != null || ref.total_line != null) ? {
        source: 'nflverse games.csv consensus (reference, not a price, no book, no capture time)',
        home_line: ref.spread_line == null ? null : r2(-ref.spread_line), home_margin: r2(ref.spread_line), total: r2(ref.total_line),
        home_ml: ref.home_ml, away_ml: ref.away_ml, convention: 'home_line: negative = home favoured (betting)',
      } : null,
      market_status: 'NOT JOINED IN THIS BUILD',
      market_note: 'Captured book prices are joined by the reader (signals under the caller’s token). Nothing here is a price.',
    };
  });

  /* per-club completed results this season, from the schedule feed the
     absorb pass read: the games each club has ACTUALLY played, with the
     score, so the desk can read form against who it came against */
  const results = {};
  (S.games || []).filter((u) => u.done && u.g && u.g.home_score != null && u.g.away_score != null).sort((a, b) => a.t - b.t).forEach((u) => {
    const g = u.g;
    [['home', g.home_team, g.away_team, num(g.home_score), num(g.away_score)], ['away', g.away_team, g.home_team, num(g.away_score), num(g.home_score)]].forEach(([venue, code, opp, pf, pa]) => {
      (results[code] = results[code] || []).push({ game_id: String(g.game_id), week: num(g.week), date: g.gameday || null, opponent: names[opp] || opp, opponent_code: opp, venue, points_for: pf, points_against: pa, margin: pf != null && pa != null ? pf - pa : null, result: pf > pa ? 'W' : pf < pa ? 'L' : 'T' });
    });
  });
  /* per-club ratings out of the state the absorb pass produced */
  const teams = {};
  const ranks = (() => { try { return T.fbNflRanks(); } catch (_) { return null; } })();
  const st = S.state || {};
  for (const code of Object.keys(st.team || {})) {
    const t = st.team[code] || {};
    const row = { code, team: names[code] || code, ratings: {}, ranks: {} };
    for (const k of Object.keys(t)) if (typeof t[k] === 'number') row.ratings[k] = r4(t[k]);
    if (ranks && ranks.by) for (const k of Object.keys(ranks.by)) if (ranks.by[k].rank && ranks.by[k].rank[code] != null) row.ranks[k] = { rank: ranks.by[k].rank[code], of: ranks.by[k].of };
    if (st.qb && st.qb[code]) row.qb = st.qb[code];
    row.coaching_staff = coaching.teams[code] || null;
    row.results = results[code] || [];
    teams[code] = row;
  }

  const forecast = await fetchNflForecasts(games, { offline: !!opts.offline });
  games.forEach((g) => { const w = forecast.byGame[String(g.game_id)]; const v = nflForecastWanted([g])[0]; g.venue_geography = v && v.venue ? { name: v.venue.name, lat: v.venue.lat, lon: v.venue.lon, tz_name: v.venue.tz_name, roof: v.venue.roof, verification: v.venue.verification, source: v.venue.source } : null; if (w) g.forecast = w; });

  return {
    schema: SCHEMA, version: 1, season, generated_at: new Date().toISOString(),
    source: 'nflverse/nfldata games.csv + nflverse-data stats_team_week, through the football module in app.html',
    forecasts: forecast.report,
    coaching_staff: {
      schema: coaching.schema,
      status: coaching.status,
      affects_projection: false,
      adjustment_points: 0,
      observed_games: coaching.observed_games || 0,
      cross_section: coaching.cross_section || null,
      historical_seed: coaching.seed || null,
      validation: coachingValidation ? {
        artifact: 'football/validation/nfl_coaching_staff.json',
        status: coachingValidation.status || null,
        affects_projection: !!coachingValidation.affects_projection,
        tuned_cap: num(coachingValidation.tuned_cap),
        selected_cap: num(coachingValidation.selected_cap),
        selected_reliability_k: num(coachingValidation.selected_reliability_k),
        effect_size: coachingValidation.verdict ? num(coachingValidation.verdict.effect_size) : null,
        p_value: coachingValidation.verdict ? num(coachingValidation.verdict.p_value) : null,
        reason: coachingValidation.reason || null
      } : null,
      config: coaching.config || null,
      basis: 'Measured and ranked from leak-free pregame residuals. Missing historical staff inputs remain unavailable. The NFL holdout currently keeps the applied projection adjustment at exactly 0.'
    },
    engine: { model_version: meta.model_version, feature_version: meta.nfl && meta.nfl.feature_version, trained_through: meta.nfl && meta.nfl.trained_through, built_at: meta.built_at,
      /* THE MARGIN DISTRIBUTION, so the desk can read a nearby line under the
         model's own residuals: sigma, the pooled residual pmf and the mass on
         the key numbers. Fitted on the training seasons, applied unchanged. */
      distributions: (() => { const P = win.EDFootballParams && win.EDFootballParams.nfl; if (!P) return null; return { sigma_margin: P.sigma_margin, margin_resid_pmf: P.margin_resid_pmf || null, abs_margin_key_mass: P.abs_margin_key_mass || null, pmf_spread_range: P.pmf_spread_range || null,
        basis: 'the engine\u2019s own residual of projected home margin against the realised margin, and its spread-conditioned margin pmf; fitted on the training seasons and applied unchanged', limitations: 'describes the spread of outcomes around THIS model\u2019s projection; it is not a market-implied distribution and the validation tier decides whether it may be read as a betting probability' }; })(),
      /* THE MODEL'S OWN RECORD, carried with the numbers it governs. Against
         the closing consensus the NFL spread model does not beat the close at
         any disagreement band, so the desk may quote it as an estimate and may
         not turn it into a probability or an expected value. */
      validation: meta.validation && meta.validation.nfl ? {
        tier: 'RESEARCH', may_produce_probability: false, may_produce_model_ev: false, beats_market: false, max_decision: 'WATCH',
        oos_test_window: meta.validation.nfl.oos_test_window || null,
        spread_mae_model: meta.validation.nfl.spread_mae_model, spread_mae_closing_market: meta.validation.nfl.spread_mae_closing_market,
        ats_vs_close: meta.validation.nfl.ats_vs_close || null, ou_vs_close: meta.validation.nfl.ou_vs_close || null,
        record: (() => { const a = meta.validation.nfl.ats_vs_close || {}; const bands = Object.keys(a).sort((x, y) => Number(x) - Number(y)).map((k) => `${a[k].win_pct}% at ${k}+ points (n=${a[k].n}, p=${a[k].binom_p_one_sided})`); return `NFL ${meta.validation.nfl.oos_test_window || 'walk-forward'} vs the closing consensus: spread MAE ${meta.validation.nfl.spread_mae_model} against the market's ${meta.validation.nfl.spread_mae_closing_market}; ATS ${bands.join(', ')}. No band clears p<0.05; the model does not beat the close.`; })(),
      } : null },
    absorbed_games: S.absorbed || 0, notes: S.notes || [], lookahead_days: lookaheadDays,
    window: { from: new Date(now - 6 * 3600000).toISOString(), to: new Date(now + lookaheadDays * 86400000).toISOString() },
    feeds: fetched.map((f) => ({ url: f.url, bytes: f.bytes })),
    counts: { games: games.length, predicted: games.filter((g) => g.model_status === 'PREDICTED').length, with_reference: games.filter((g) => g.reference_market).length, teams: Object.keys(teams).length },
    ranks_of: ranks ? ranks.of || null : null,
    games, teams,
    /* Slice 4: THE RANKED BOARD. Every game priced by the pricing kernel from
       its reference market at -110 (assumed, and said so), against the
       validation record in football/validation/pricing_nfl.json, so the
       desk and the site read the same fair lines, bet-to numbers and
       statuses. A captured price at read time re-prices the game live. */
    pricing: pricingBlock(games),
    market_note: 'Every game reads NOT JOINED IN THIS BUILD: the artifact is a schedule and a projection, and captured prices are joined at read time.',
  };
}

function pricingBlock(games) {
  let EDPRICE = null, validation = null;
  try { EDPRICE = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_pricing.js')); } catch (_) { EDPRICE = null; }
  try { validation = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'), 'utf8')); } catch (_) { validation = null; }
  if (!EDPRICE) return { error: 'the pricing kernel could not be loaded', rows: [] };
  const sport = 'americanfootball_nfl';
  if (validation) EDPRICE.loadValidation(sport, validation);
  const ranked = EDPRICE.rankSlate({ sport, top: 8, games: games.map((g) => ({ game_id: g.game_id, home: g.home_team, away: g.away_team, kickoff: g.kickoff, model_home_line: g.model_home_line, market_home_line: g.reference_market ? g.reference_market.home_line : null, completeness: g.data_quality && num(g.data_quality.completeness) != null ? num(g.data_quality.completeness) : (g.qb_known === false ? 0.6 : 0.8), market_source: g.reference_market ? g.reference_market.source : null })) });
  return Object.assign(ranked, { validation: validation ? { artifact: 'football/validation/pricing_nfl.json', generated_at: validation.generated_at, spread_tier: validation.markets.spread.tier, required_edge_points: validation.markets.spread.required_edge_points, tier_basis: validation.markets.spread.tier_basis } : { artifact: null, error: 'no pricing validation on file; every side is CONDITIONAL' },
    price_basis: 'reference market at an assumed -110; a captured book price re-prices the side at read time', rows: ranked.rows });
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const offline = args.includes('--offline');
  const li = args.indexOf('--lookahead');
  let art;
  try { art = await build({ offline, lookahead: li >= 0 ? Number(args[li + 1]) : null }); }
  catch (e) { console.error('the NFL slate could not be built: ' + (e && e.message || e)); process.exit(2); }
  const text = JSON.stringify(art, null, 1) + '\n';
  console.log(`nfl slate: season ${art.season}, ${art.counts.games} games in ${art.lookahead_days} days (${art.counts.predicted} predicted, ${art.counts.with_reference} with a reference line), ${art.counts.teams} clubs, ${art.absorbed_games} games absorbed — ${Math.round(text.length / 1024)} KB`);
  (art.notes || []).forEach((n) => console.log('  note: ' + n));
  if (check) {
    if (!fs.existsSync(OUT)) { console.log('CHECK: artifact not present'); process.exit(1); }
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const strip = (a) => JSON.stringify(Object.assign({}, a, { generated_at: null, window: null, feeds: null }));
    const same = strip(cur) === strip(art);
    console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log('wrote ' + path.relative(ROOT, OUT));
}
module.exports = { build, nflForecastWanted, fetchNflForecasts, SCHEMA, OUT, etToIso };
if (require.main === module) main();

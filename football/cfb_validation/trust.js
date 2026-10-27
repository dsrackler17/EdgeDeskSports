#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — CAN WE TRUST THIS NUMBER? Every upcoming college game, set
   beside what this season has already shown. docs/cfb-validation/TRUST.md

   Research only. It changes no number, no grade and no label. It reads what
   EdgeDesk already published and puts three measured things beside each game:

     1. THE GAP. EdgeDesk's margin against the latest pregame sportsbook line,
        the engine terms the margin is built from (team strength, home field,
        the stylistic matchup), and what this season's results alone say about
        the two teams beside the blend that still weights the long-run track.
     2. THE TEAMS. Each team's graded games this season: how far EdgeDesk's
        published number sat from the closing line on them, and where the games
        actually finished against both.
     3. THE RECORD AT THAT GAP. On this season's graded FBS-vs-FBS games with
        about the same gap between EdgeDesk and the close, how often the close
        finished nearer the final, and how often EdgeDesk did.

   And two season tests the per-game reads stand on: EdgeDesk against the close
   (does a disagreement carry information about the result?), and whether a
   team's earlier misses predict its next one (do the ratings absorb past
   weeks, or lag them?).

   Inputs, committed files only (nothing is fetched, nothing is written unless
   --out names a directory):
     record/football/cfb_<season>.json                the graded record: each pick as
                                                       published, the close, the verified final
     football/fbs/slate.json                          the upcoming games and their engine terms
     performance/ledger/quotes/cfb-<season>.jsonl     pregame quotes, each with its capture time
     lib/edgedesk_factor_evidence.js (+ its files)    each term's held-out record, in words

   AS OF A MOMENT. --now (default: the clock) bounds everything: a graded game
   counts only when it kicked off FINAL_AFTER_HOURS before it, a quote only
   when it was captured before both the game's start and the moment, and only
   games not yet started are audited.

     node football/cfb_validation/trust.js                 the report, as markdown
     node football/cfb_validation/trust.js --json          the full object
     node football/cfb_validation/trust.js --out DIR       write DIR/trust.json and DIR/TRUST.md
     node football/cfb_validation/trust.js --now ISO       as of that moment
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const SCHEMA = 'edgedesk_cfb_trust_v1';
/* a final counts once the game is this far in the past (football/cfb_p4/live_calibration_config.json uses the same) */
const FINAL_AFTER_HOURS = 4;
/* |EdgeDesk − line| buckets, points; the first is "agrees" */
const GAP_BUCKETS = [[0, 1.5], [1.5, 3], [3, 5], [5, 7], [7, Infinity]];
const AGREE_BELOW = 1.5;
/* a term "carries" the gap when it points the same way and is at least this share of it */
const CARRY_SHARE = 0.5;
/* the long-run track carries the gap when this season's results alone sit at least this much nearer the line */
const PRIOR_CARRY_PTS = 1;
const MIN_PRIOR_GAMES = 2;
const TERM_LABEL = { rating: 'team strength', hfa: 'home field', matchup: 'stylistic matchup', qb: 'quarterback', schedule: 'schedule', conference: 'conference strength',
  travel: 'travel', injury: 'injuries', rivalry: 'rivalry' };

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
const r = (x, d) => { if (num(x) == null) return null; const f = Math.pow(10, d == null ? 2 : d); const v = Math.round(x * f) / f; return v === 0 ? 0 : v; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const ms = (t) => { const v = Date.parse(t); return isFinite(v) ? v : null; };
const pct = (k, n) => (n ? Math.round(1000 * k / n) / 10 : null);
/* half up on the magnitude, as the graphic's chips round (2.153 → 2.2; a stored 0.35 is not printed 0.3) */
const f1 = (x) => (Math.round(Math.abs(x) * 10 + 1e-9) / 10).toFixed(1);
const signed = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '')) + f1(x);

/* ordinary least squares of y on x: slope, its standard error and 95% interval */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 3) return { n, slope: null, se: null, ci95: null };
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!(sxx > 0)) return { n, slope: null, se: null, ci95: null };
  const b = sxy / sxx;
  let ss = 0;
  for (let i = 0; i < n; i++) { const e = ys[i] - my - b * (xs[i] - mx); ss += e * e; }
  const se = Math.sqrt(ss / (n - 2) / sxx);
  return { n, slope: r(b, 3), se: r(se, 3), ci95: [r(b - 1.96 * se, 3), r(b + 1.96 * se, 3)] };
}

/* ------------------------------------------------------------- the season */
/** Every graded game with a published pick, a close and a final, kicked off FINAL_AFTER_HOURS before `nowMs`.
    Margins are HOME margins (+ = home ahead): a book's home line is negated once, here. */
function seasonRows(record, nowMs) {
  const out = [];
  Object.keys((record && record.games) || {}).forEach((id) => {
    const g = record.games[id], p = g.pick || {}, c = g.close || {}, f = g.final || {};
    const k = ms(g.kickoff);
    if (k == null || nowMs == null || k > nowMs - FINAL_AFTER_HOURS * 3600e3) return;
    if (num(p.home_line) == null || num(c.home_line) == null || num(f.home_score) == null || num(f.away_score) == null) return;
    out.push({ id: String(g.game_id || id), week: g.week, kickoff: g.kickoff, home: g.home, away: g.away, neutral: !!g.neutral_site,
      fbs: g.home_division === 'fbs' && g.away_division === 'fbs', version: p.model_version || g.model_version || null,
      model: -p.home_line, close: -c.home_line, actual: f.home_score - f.away_score });
  });
  return out.sort((a, b) => ms(a.kickoff) - ms(b.kickoff) || (a.id < b.id ? -1 : 1));
}

/** EdgeDesk against the close on a set of games: errors, who finished nearer, the side record, and
    whether the disagreement carries information (slope of (actual − close) on (EdgeDesk − close)). */
function vsMarket(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  let me = 0, ce = 0, mNear = 0, cNear = 0, tie = 0, w = 0, l = 0, push = 0;
  rows.forEach((x) => {
    const a = Math.abs(x.model - x.actual), b = Math.abs(x.close - x.actual);
    me += a; ce += b;
    if (a < b) mNear++; else if (b < a) cNear++; else tie++;
    /* EdgeDesk's side against the close: home when its margin is above the close's */
    if (x.model === x.close) return;
    const s = x.model > x.close ? 1 : -1, d = (x.actual - x.close) * s;
    if (d > 0) w++; else if (d < 0) l++; else push++;
  });
  const fit = ols(rows.map((x) => x.model - x.close), rows.map((x) => x.actual - x.close));
  return { n, model_mae: r(me / n), close_mae: r(ce / n), close_nearer: cNear, model_nearer: mNear, ties: tie,
    close_nearer_pct: pct(cNear, n), model_nearer_pct: pct(mNear, n),
    side_vs_close: { won: w, lost: l, push: push, pct: pct(w, w + l) },
    disagreement_slope: fit,
    disagreement_informative: !!(fit.ci95 && fit.ci95[0] > 0) };
}

function bucketOf(gap) {
  const a = Math.abs(gap);
  for (let i = 0; i < GAP_BUCKETS.length; i++) if (a >= GAP_BUCKETS[i][0] && a < GAP_BUCKETS[i][1]) return i;
  return GAP_BUCKETS.length - 1;
}
function bucketLabel(i) { const b = GAP_BUCKETS[i]; return b[1] === Infinity ? b[0] + '+ pts' : b[0] + '–' + b[1] + ' pts'; }

/** The season's record by size of gap between EdgeDesk and the close. */
function byGap(rows) {
  return GAP_BUCKETS.map((b, i) => {
    const s = vsMarket(rows.filter((x) => bucketOf(x.model - x.close) === i));
    delete s.disagreement_slope; delete s.disagreement_informative;
    return Object.assign({ bucket: i, label: bucketLabel(i), lo: b[0], hi: b[1] === Infinity ? null : b[1] }, s);
  });
}

/** DO THE RATINGS ABSORB PAST WEEKS? Walk forward week by week: each FBS-vs-FBS game is set against
    the two teams' mean miss (actual − EdgeDesk, from each team's side) over their games in EARLIER
    weeks only (a week is absorbed after all its games are read). A slope near 0 says a team's earlier
    misses do not predict its next one: the number already carries what those games showed. */
function pastWeeks(rows) {
  const hist = {}, xs = [], ys = [], xl = [], yl = [];
  const weeks = Array.from(new Set(rows.map((x) => x.week))).filter((w) => w != null).sort((a, b) => a - b);
  weeks.forEach((wk) => {
    const games = rows.filter((x) => x.week === wk);
    games.forEach((x) => {
      if (!x.fbs) return;
      const h = hist[x.home] || [], a = hist[x.away] || [];
      if (h.length < MIN_PRIOR_GAMES || a.length < MIN_PRIOR_GAMES) return;
      xs.push(mean(h.map((e) => e.miss)) - mean(a.map((e) => e.miss)));
      ys.push(x.actual - x.model);
      xl.push(mean(h.map((e) => e.lean)) - mean(a.map((e) => e.lean)));
      yl.push(x.actual - x.close);
    });
    games.forEach((x) => {
      [[x.home, 1], [x.away, -1]].forEach((t) => {
        (hist[t[0]] = hist[t[0]] || []).push({ miss: (x.actual - x.model) * t[1], lean: (x.model - x.close) * t[1] });
      });
    });
  });
  const miss = ols(xs, ys), lean = ols(xl, yl);
  return {
    min_prior_games: MIN_PRIOR_GAMES,
    earlier_misses: Object.assign(miss, { what: 'the next game’s miss (actual − EdgeDesk) on the two teams’ mean miss in earlier weeks',
      carries_over: !!(miss.ci95 && miss.ci95[0] > 0) }),
    earlier_leans: Object.assign(lean, { what: 'the next game’s result against the close on how far EdgeDesk leaned from the close on the two teams in earlier weeks',
      predicts: !!(lean.ci95 && lean.ci95[0] > 0) })
  };
}

/** Each team's graded games, from its own side: what EdgeDesk published, the close and the final. */
function teamSeasons(rows) {
  const T = {};
  rows.forEach((x) => {
    [['home', 1], ['away', -1]].forEach((t) => {
      const team = x[t[0]], s = t[1];
      (T[team] = T[team] || []).push({ id: x.id, week: x.week, opponent: t[0] === 'home' ? x.away : x.home, site: x.neutral ? 'neutral' : t[0],
        fbs_opponent: x.fbs, model: r(x.model * s), close: r(x.close * s), actual: x.actual * s });
    });
  });
  /* the summary reads FBS opponents only: an FCS opponent is one floor rating, a different population */
  const out = {};
  Object.keys(T).sort().forEach((team) => {
    const all = T[team], g = all.filter((e) => e.fbs_opponent), n = g.length;
    out[team] = { team, n, fcs_games: all.length - n,
      lean_vs_close: r(mean(g.map((e) => e.model - e.close))),
      result_vs_close: r(mean(g.map((e) => e.actual - e.close))),
      model_minus_actual: r(mean(g.map((e) => e.model - e.actual))),
      close_minus_actual: r(mean(g.map((e) => e.close - e.actual))),
      model_mae: r(mean(g.map((e) => Math.abs(e.model - e.actual)))),
      close_mae: r(mean(g.map((e) => Math.abs(e.close - e.actual)))),
      games: all };
  });
  return out;
}

/* ------------------------------------------------------------- the quotes */
/** The latest pregame quote with a spread for each game: captured before the start AND by `nowMs`. */
function latestQuotes(quotes, nowMs) {
  const out = {};
  (quotes || []).forEach((q) => {
    const sp = q && q.spread, c = ms(q && q.captured_at), st = ms(q && q.start_utc);
    if (!sp || num(sp.home_point) == null || c == null || st == null || c >= st || (nowMs != null && c > nowMs)) return;
    const k = q.event_key, cur = out[k];
    if (!cur || c > ms(cur.captured_at) || (c === ms(cur.captured_at) && String(q.hash || '') > String(cur.hash || ''))) out[k] = q;
  });
  const res = {};
  Object.keys(out).forEach((k) => {
    const q = out[k];
    res[k] = { book: q.book || null, source: q.source || null, captured_at: q.captured_at, home_point: q.spread.home_point,
      market_margin: -q.spread.home_point, total: q.total && num(q.total.point) != null ? q.total.point : null };
  });
  return res;
}

/* --------------------------------------------------------------- one game */
/** One upcoming slate game, set beside the season. ctx: { teams, byGap, factors } */
function gameAudit(g, quote, ctx) {
  ctx = ctx || {};
  const P = (g.disagreement_inputs && g.disagreement_inputs.projection) || {};
  const comp = P.components || {}, rd = P.rating_detail || null;
  /* the engine's unrounded margin: its terms sum to it, and the graphic's gap is taken from it */
  const home = g.home_team, away = g.away_team, model = num(g.v1 && g.v1.model_home_margin_exact) != null ? g.v1.model_home_margin_exact : num(g.model_home_margin);
  const terms = Object.keys(comp).filter((k) => num(comp[k]) != null && Math.abs(comp[k]) >= 0.005)
    .map((k) => ({ term: k, label: TERM_LABEL[k] || k, points: r(comp[k], 3), favors: comp[k] > 0 ? home : away }))
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || (a.term < b.term ? -1 : 1));
  const termSum = terms.reduce((s, t) => s + t.points, 0);
  const out = { game_id: String(g.game_id), week: g.week, kickoff: g.kickoff, home, away, neutral_site: !!g.neutral_site, model_version: g.model_version || null,
    model_margin: r(model, 3), terms, terms_reconcile: model != null && Math.abs(termSum - model) <= 0.05 };

  /* the two rating tracks: the long-run one (preseason belief, moved by every game since) and this season's games alone */
  if (rd && num(rd.home_carried) != null && num(rd.away_carried) != null && num(rd.home_fresh) != null && num(rd.away_fresh) != null && num(comp.rating) != null) {
    const carried = rd.home_carried - rd.away_carried, fresh = rd.home_fresh - rd.away_fresh, w = num(rd.prior_weight);
    out.rating = { blended: r(comp.rating, 3), long_run: r(carried, 3), this_season: r(fresh, 3), long_run_weight: w,
      games_played: { home: rd.home_gp == null ? null : rd.home_gp, away: rd.away_gp == null ? null : rd.away_gp },
      blend_reconciles: w != null && Math.abs(w * carried + (1 - w) * fresh - comp.rating) <= 0.05,
      this_season_margin: model == null ? null : r(model - comp.rating + fresh, 3) };
  } else out.rating = null;

  out.teams = { home: (ctx.teams || {})[home] || null, away: (ctx.teams || {})[away] || null };
  ['home', 'away'].forEach((s) => { if (out.teams[s]) { out.teams[s] = Object.assign({}, out.teams[s]); delete out.teams[s].games; } });

  if (!quote || model == null) {
    out.market = null;
    out.verdict = 'NO_LINE';
    out.flags = [];
    out.read = reads(out, ctx);
    return out;
  }
  const mk = quote.market_margin, gap = model - mk;
  out.market = { book: quote.book, captured_at: quote.captured_at, home_point: quote.home_point, market_margin: mk, total: quote.total };
  out.gap = r(gap, 3);
  out.gap_toward = gap > 0 ? home : (gap < 0 ? away : null);
  const b = bucketOf(gap);
  out.season_at_gap = ctx.byGap ? ctx.byGap[b] : null;
  out.verdict = Math.abs(gap) < AGREE_BELOW ? 'AGREES' : 'DISAGREES';
  const flags = [];
  if (out.verdict === 'DISAGREES') {
    /* which terms point the way of the gap, and does one carry most of it */
    out.terms_toward_gap = terms.filter((t) => Math.sign(t.points) === Math.sign(gap)).map((t) => t.term);
    const mt = num(comp.matchup);
    if (mt != null && Math.sign(mt) === Math.sign(gap) && Math.abs(mt) >= CARRY_SHARE * Math.abs(gap)) flags.push('MATCHUP_TERM_CARRIES_GAP');
    if (out.rating && out.rating.this_season_margin != null) {
      const g2 = out.rating.this_season_margin - mk;
      out.rating.this_season_gap = r(g2, 3);
      if (Math.abs(g2) <= Math.abs(gap) - PRIOR_CARRY_PTS) flags.push('LONG_RUN_TRACK_CARRIES_GAP');
    }
  }
  out.flags = flags;
  out.read = reads(out, ctx);
  return out;
}

/* the plain sentences a reader gets; every number is one of the audit's own */
function reads(a, ctx) {
  const L = [];
  /* "Missouri State by 6.7": a home margin said from the side it favours */
  const by = (m, h, w) => (Math.abs(m) < 0.05 ? 'even' : (m > 0 ? h : w) + ' by ' + f1(m));
  if (a.model_margin != null) {
    let s = 'EdgeDesk: ' + by(a.model_margin, a.home, a.away) + '.';
    if (a.market) s += ' ' + (a.market.book || 'Sportsbook') + ' (captured ' + a.market.captured_at + '): ' + by(a.market.market_margin, a.home, a.away) + '.';
    L.push(s);
  }
  if (a.market) {
    L.push(a.verdict === 'AGREES' ? 'EdgeDesk and the line agree within ' + AGREE_BELOW + ' pts.'
      : 'EdgeDesk is ' + f1(a.gap) + ' pts more bullish on ' + a.gap_toward + ' than the line.');
  } else L.push('No pregame sportsbook line was captured for this game, so there is nothing to compare.');
  if (a.terms.length) L.push('Its number: ' + a.terms.map((t) => t.label + ' ' + t.favors + ' +' + f1(t.points)).join(', ') + (a.terms_reconcile ? ' (these add up to its margin).' : '.'));
  if (a.flags.indexOf('MATCHUP_TERM_CARRIES_GAP') >= 0) {
    const mt = a.terms.find((t) => t.term === 'matchup'), MX = ctx.factors && ctx.factors.matchup;
    L.push('The stylistic matchup term carries ' + f1(mt.points) + ' of the ' + f1(a.gap) + '-pt gap.'
      + (MX ? ' Its record on games it was never fitted on: ' + String(MX.status_text || '').toLowerCase() + ', ' + String(MX.result || '').match(/^[^(;]*(\([^)]*\))?/)[0].trim() + '.' : ''));
  }
  const R = a.rating;
  if (R) {
    const w = R.long_run_weight || 0;
    L.push('Team strength on a neutral field: ' + by(R.blended, a.home, a.away) + '. That blends the long-run track (' + by(R.long_run, a.home, a.away) + ') at ' + Math.round(100 * w)
      + '% with this season’s games alone (' + by(R.this_season, a.home, a.away) + ') at ' + Math.round(100 * (1 - w)) + '%.'
      + (a.flags.indexOf('LONG_RUN_TRACK_CARRIES_GAP') >= 0 ? ' On this season’s games alone the gap to the line would be ' + f1(R.this_season_gap) + ' pts, not ' + f1(a.gap) + '.' : ''));
  }
  ['away', 'home'].forEach((s) => {
    const t = a.teams[s];
    if (!t || !t.n) return;
    L.push(t.team + ', ' + t.n + ' graded game' + (t.n === 1 ? '' : 's') + ' against FBS teams' + (t.fcs_games ? ' (' + t.fcs_games + ' against FCS left out)' : '') + ': EdgeDesk rated them '
      + f1(t.lean_vs_close) + ' pts a game ' + (t.lean_vs_close >= 0 ? 'higher' : 'lower') + ' than the closing line did, and they finished ' + f1(t.result_vs_close) + ' pts a game '
      + (t.result_vs_close >= 0 ? 'better' : 'worse') + ' than the close. EdgeDesk missed their margins by ' + f1(t.model_mae) + ' a game, the close by ' + f1(t.close_mae) + '.');
  });
  const S = a.season_at_gap;
  if (a.market && S && S.n) {
    L.push('This season, on FBS games where EdgeDesk and the close were ' + S.label + ' apart (' + S.n + '), the close finished nearer the final in ' + S.close_nearer + ' (' + S.close_nearer_pct + '%), EdgeDesk in '
      + S.model_nearer + ' (' + S.model_nearer_pct + '%).');
  }
  return L;
}

/* ----------------------------------------------------------------- build */
/** The whole audit as of `nowMs`. in: { record, slate, quotes, factors } */
function build(inp, nowMs) {
  const rows = seasonRows(inp.record, nowMs), fbs = rows.filter((x) => x.fbs), fcs = rows.filter((x) => !x.fbs);
  const gaps = byGap(fbs), teams = teamSeasons(rows), Q = latestQuotes(inp.quotes, nowMs);
  const versions = {};
  rows.forEach((x) => { (versions[x.version || 'unknown'] = versions[x.version || 'unknown'] || []).push(x); });
  const upcoming = ((inp.slate && inp.slate.games) || []).filter((g) => g.model_status === 'PREDICTED' && num(g.model_home_margin) != null && ms(g.kickoff) != null && ms(g.kickoff) > nowMs)
    .sort((a, b) => ms(a.kickoff) - ms(b.kickoff) || (String(a.game_id) < String(b.game_id) ? -1 : 1));
  const ctx = { teams, byGap: gaps, factors: inp.factors || null };
  const games = upcoming.map((g) => gameAudit(g, Q['CFB|' + g.game_id] || null, ctx));
  const lined = games.filter((g) => g.market);
  return {
    schema: SCHEMA, as_of: new Date(nowMs).toISOString(),
    what: 'Research only: every upcoming college game beside what this season has shown. It changes no number, grade or label.',
    inputs: { record_updated_at: (inp.record && inp.record.updated_at) || null, slate_generated_at: (inp.slate && inp.slate.generated_at) || null, quotes: (inp.quotes || []).length },
    season: {
      graded: rows.length, fbs_vs_fbs: vsMarket(fbs), fbs_vs_fcs: vsMarket(fcs),
      by_version: Object.keys(versions).sort().map((v) => { const s = vsMarket(versions[v]); return { version: v, n: s.n, model_mae: s.model_mae, close_mae: s.close_mae }; }),
      by_gap: gaps, past_weeks: pastWeeks(rows)
    },
    slate: { games: games.length, with_line: lined.length,
      mean_gap_home: lined.length ? r(mean(lined.map((g) => g.gap))) : null,
      mean_abs_gap: lined.length ? r(mean(lined.map((g) => Math.abs(g.gap)))) : null,
      agrees: lined.filter((g) => g.verdict === 'AGREES').length, disagrees: lined.filter((g) => g.verdict === 'DISAGREES').length },
    games,
    teams
  };
}

/* -------------------------------------------------------------- markdown */
function markdown(A) {
  const S = A.season, F = S.fbs_vs_fbs, PW = S.past_weeks;
  const f2 = (x) => (x < 0 ? '−' : (x > 0 ? '+' : '')) + Math.abs(x).toFixed(2);
  const ci = (f) => (f && f.ci95 ? f2(f.slope) + ' (95% CI ' + f2(f.ci95[0]) + ' to ' + f2(f.ci95[1]) + ', n ' + f.n + ')' : 'not measurable yet');
  const L = ['# Can we trust this number? College football, as of ' + A.as_of, '',
    'Generated by `football/cfb_validation/trust.js`. Research only: it changes no number, grade or label. How to read it: `docs/cfb-validation/TRUST.md`.', '',
    '## The season so far (graded FBS-vs-FBS games)', '',
    '| | games | EdgeDesk off by | close off by | close nearer | EdgeDesk nearer | EdgeDesk’s side vs the close |',
    '|---|---|---|---|---|---|---|',
    '| all | ' + F.n + ' | ' + F.model_mae + ' | ' + F.close_mae + ' | ' + F.close_nearer + ' (' + F.close_nearer_pct + '%) | ' + F.model_nearer + ' (' + F.model_nearer_pct + '%) | ' + F.side_vs_close.won + '-' + F.side_vs_close.lost + (F.side_vs_close.push ? '-' + F.side_vs_close.push : '') + ' |']
    .concat(S.by_gap.filter((b) => b.n).map((b) => '| gap ' + b.label + ' | ' + b.n + ' | ' + b.model_mae + ' | ' + b.close_mae + ' | ' + b.close_nearer + ' (' + b.close_nearer_pct + '%) | ' + b.model_nearer + ' (' + b.model_nearer_pct + '%) | ' + b.side_vs_close.won + '-' + b.side_vs_close.lost + (b.side_vs_close.push ? '-' + b.side_vs_close.push : '') + ' |'))
    .concat(['',
      '- **Does a disagreement with the close carry information?** Slope of (final − close) on (EdgeDesk − close): ' + ci(F.disagreement_slope) + '. '
        + (F.disagreement_informative ? 'Yes: the interval is above 0.' : 'Not measurably: the interval includes 0, so a gap is not evidence the line is wrong.'),
      '- **Do the ratings absorb past weeks?** Slope of a game’s miss on the two teams’ earlier misses: ' + ci(PW.earlier_misses) + '. '
        + (PW.earlier_misses.carries_over ? 'Earlier misses carry over: the ratings lag what teams have shown.' : 'Earlier misses do not measurably carry over: the number already holds what those games showed.'),
      '- **Does EdgeDesk’s past lean on a team predict its next result against the close?** ' + ci(PW.earlier_leans) + '.',
      '- FBS vs FCS (a different population: every FCS team is one floor rating): ' + S.fbs_vs_fcs.n + ' games, EdgeDesk off by ' + S.fbs_vs_fcs.model_mae + ', the close by ' + S.fbs_vs_fcs.close_mae + '.',
      '- By model version: ' + S.by_version.map((v) => '`' + v.version + '` ' + v.n + ' games, ' + v.model_mae + ' vs the close’s ' + v.close_mae).join('; ') + '.',
      '', '## This slate', '',
      A.slate.games + ' upcoming games, ' + A.slate.with_line + ' with a captured pregame line: ' + A.slate.agrees + ' agree within ' + AGREE_BELOW + ' pts, ' + A.slate.disagrees + ' do not'
        + (A.slate.mean_gap_home != null ? '. Mean gap ' + signed(A.slate.mean_gap_home, 2) + ' pts toward the home side (|gap| ' + A.slate.mean_abs_gap + ').' : '.'), '',
      '| game | EdgeDesk | line | gap toward | terms | this season only | flags |', '|---|---|---|---|---|---|---|'])
    .concat(A.games.filter((g) => g.market).map((g) => '| ' + g.away + ' @ ' + g.home + ' | ' + signed(g.model_margin) + ' | ' + signed(g.market.market_margin) + ' | ' + (g.gap_toward ? g.gap_toward + ' ' + f1(g.gap) : 'even')
      + ' | ' + g.terms.map((t) => t.term + ' ' + signed(t.points)).join(', ') + ' | ' + (g.rating ? signed(g.rating.this_season_margin) : '—') + ' | ' + (g.flags.join(', ') || '—') + ' |'))
    .concat(['', 'Margins are home margins (+ = home ahead). "this season only" is EdgeDesk’s margin with team strength taken from this season’s games alone.', '', '## Each game', '']);
  A.games.forEach((g) => {
    L.push('### ' + g.away + ' @ ' + g.home + ' (' + g.kickoff + ')', '');
    g.read.forEach((s) => L.push('- ' + s));
    L.push('');
  });
  return L.join('\n');
}

/* --------------------------------------------------------------- loading */
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function readJsonl(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x));
}
function load(season) {
  const slate = readJson('football/fbs/slate.json');
  const yr = season || slate.season;
  let factors = null;
  try { factors = require(path.join(ROOT, 'lib', 'edgedesk_factor_evidence.js')).load(ROOT).factors; } catch (_) { factors = null; }
  return { record: readJson('record/football/cfb_' + yr + '.json'), slate, quotes: readJsonl('performance/ledger/quotes/cfb-' + yr + '.jsonl'), factors };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const now = arg('--now') ? ms(arg('--now')) : Date.now();
  if (now == null) { console.error('--now is not a date: ' + arg('--now')); process.exit(2); }
  const A = build(load(), now);
  const out = arg('--out');
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'trust.json'), JSON.stringify(A, null, 1) + '\n');
    fs.writeFileSync(path.join(out, 'TRUST.md'), markdown(A) + '\n');
    console.log('wrote ' + path.join(out, 'trust.json') + ' and TRUST.md: ' + A.games.length + ' games, ' + A.season.graded + ' graded');
    return;
  }
  process.stdout.write(argv.indexOf('--json') >= 0 ? JSON.stringify(A, null, 1) + '\n' : markdown(A) + '\n');
}

module.exports = { SCHEMA, FINAL_AFTER_HOURS, GAP_BUCKETS, AGREE_BELOW, CARRY_SHARE, PRIOR_CARRY_PTS, ols, seasonRows, vsMarket, bucketOf, byGap, pastWeeks, teamSeasons, latestQuotes, gameAudit, build, markdown, load };
if (require.main === module) main(process.argv.slice(2));

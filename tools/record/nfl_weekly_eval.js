#!/usr/bin/env node
/* ===========================================================================
   THE NFL WEEKLY MODEL EVALUATION — the settled week, scored three ways.

   Every Tuesday, after the week settles (football/research/nfl_v2/weekly_loop.js
   and .github/workflows/nfl-weekly-loop.yml run it), each game of the week is
   scored against the final and the closing line:

     PUBLISHED  the number the site actually published before kickoff, from the
                model record (record/football/nfl_<season>.json, the last
                pregame number: grade.clv_pick). Never recomputed.
     REPLAYED   the number the model SERVED NOW (football/nfl_params_v2.js when
                active) gives the same game from the same pregame state: the
                board's own leak-free pregame prediction (S.weekPreds, frozen
                before that game was absorbed), through the corrected pipeline.
                This is what "re-absorb the completed week with the corrected
                pipeline" means; it is never presented as a published number.
     CLOSE      nflverse's closing consensus (games.csv): spread_line as the
                margin, de-vigged moneylines as the win probability.

   Per game: margin error, Brier, log loss, CLV (published: the record's own
   quote-to-close points; replayed: opener-to-close points from
   football/pricing/openers_nfl.json), the 3+ point disagreements with the close
   flagged with the card's drivers, and the week's biggest misses attributed to
   the card components. Season to date: the same metrics, calibration in ten
   bins, and the residual rows the weekly loop reads for repeat patterns.

   Usage
     node tools/record/nfl_weekly_eval.js [--season 2026] [--week 7] [--offline] [--write]
          [--out record/football/weekly]
   Without --week, the latest week whose every game is final. Exit 0 = written,
   unchanged or nothing settled; 1 = the board would not load.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'record', 'football', 'weekly');
const SCHEMA = 'edgedesk_nfl_weekly_eval_v1';
const FLAG_PTS = 3;
const MISSES = 5;

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const amToProb = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

/* de-vigged closing home win probability from the two moneylines */
function devig(homeMl, awayMl) {
  const h = num(homeMl), a = num(awayMl);
  if (h == null || a == null || h === 0 || a === 0) return null;
  const ph = amToProb(h), pa = amToProb(a);
  return ph / (ph + pa);
}
function brier(p, y) { return p == null || y == null ? null : (p - y) * (p - y); }
function logloss(p, y) { if (p == null || y == null) return null; const q = clip(p); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
/* points the market moved toward the side the number leaned, from `from` to the close
   (home-margin convention: the number leans home when it is above `from`) */
function clvPts(model, from, close) {
  if (model == null || from == null || close == null || model === from) return null;
  return (model > from ? 1 : -1) * (close - from);
}

/* the card rows as {key: points}, and the base strength's prior/current split */
function cardParts(card) {
  const out = { rows: {}, prior: null, current: null };
  if (!card || !Array.isArray(card.rows)) return out;
  card.rows.forEach((r) => {
    out.rows[r.key] = num(r.points);
    if (r.key === 'base_strength') { out.prior = num(r.prior); out.current = num(r.current); }
  });
  return out;
}

/* one game, scored */
function scoreGame(g, pred, rec, opener) {
  const hs = num(g.home_score), as = num(g.away_score);
  const margin = hs != null && as != null ? hs - as : null;
  const y = margin == null ? null : margin > 0 ? 1 : margin < 0 ? 0 : null;
  const closeMargin = num(g.spread_line);
  const closeP = devig(g.home_moneyline, g.away_moneyline);
  const pick = rec && rec.pick ? rec.pick : null;
  const pubMargin = pick && num(pick.home_line) != null ? -num(pick.home_line) : null;
  const pubP = pick ? num(pick.home_win_prob) : null;
  const m = pred && pred.status === 'PREDICTED' && pred.model ? pred.model : null;
  const repMargin = m ? num(m.fair_spread) : null;
  const repP = m ? num(m.home_win_prob) : null;
  const openMargin = opener && opener.open && num(opener.open.home_line) != null ? -num(opener.open.home_line) : null;
  const parts = cardParts(pred && pred.card);
  const gap = (x) => (x == null || closeMargin == null ? null : x - closeMargin);
  const closer = (x) => {
    if (x == null || closeMargin == null || margin == null) return null;
    const a = Math.abs(x - margin), b = Math.abs(closeMargin - margin);
    return a < b ? 'model' : a > b ? 'market' : 'tie';
  };
  const atsSide = (x) => (x == null || closeMargin == null || x === closeMargin ? null : x > closeMargin ? 'home' : 'away');
  const atsResult = (x) => {
    const side = atsSide(x);
    if (!side || margin == null) return null;
    const res = margin - closeMargin;
    if (res === 0) return 'push';
    return (res > 0) === (side === 'home') ? 'win' : 'loss';
  };
  const clvPub = rec && rec.grade && rec.grade.clv_pick && rec.grade.clv_pick.spread ? num(rec.grade.clv_pick.spread.pts) : null;
  return {
    game_id: String(g.game_id), week: num(g.week), season: num(g.season), kickoff: g.gameday || null,
    home: g.home_team, away: g.away_team, neutral: String(g.location || '') === 'Neutral',
    final: margin == null ? null : { home_score: hs, away_score: as, home_margin: margin },
    close: closeMargin == null ? null : { home_margin: closeMargin, home_win_prob: r4(closeP), source: 'nflverse games.csv consensus close' },
    open: openMargin == null ? null : { home_margin: openMargin, source: 'football/pricing/openers_nfl.json' },
    published: pubMargin == null ? null : {
      home_margin: r2(pubMargin), home_win_prob: r4(pubP), model_version: pick.model_version || (rec && rec.model_version) || null, at: pick.at || null,
      error: margin == null ? null : r2(Math.abs(pubMargin - margin)), brier: r4(brier(pubP, y)), logloss: r4(logloss(pubP, y)),
      clv_pts: clvPub, gap_to_close: r2(gap(pubMargin)), closer: closer(pubMargin), ats: atsResult(pubMargin),
    },
    replayed: repMargin == null ? null : {
      home_margin: r2(repMargin), home_win_prob: r4(repP), model_version: pred.model_version || null,
      error: margin == null ? null : r2(Math.abs(repMargin - margin)), brier: r4(brier(repP, y)), logloss: r4(logloss(repP, y)),
      clv_pts_open_to_close: r2(clvPts(repMargin, openMargin, closeMargin)), gap_to_close: r2(gap(repMargin)), closer: closer(repMargin), ats: atsResult(repMargin),
      card: parts.rows, base_prior: r4(parts.prior), base_current: r4(parts.current),
    },
    close_scores: closeMargin == null || margin == null ? null : { error: r2(Math.abs(closeMargin - margin)), brier: r4(brier(closeP, y)), logloss: r4(logloss(closeP, y)) },
    y,
  };
}

function mean(a) { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function summarize(games, side) {
  const pick = (g) => (side === 'close' ? g.close_scores : g[side]);
  const rows = games.filter((g) => pick(g) && g.final);
  if (!rows.length) return { n: 0 };
  const out = {
    n: rows.length,
    mae: r4(mean(rows.map((g) => pick(g).error))),
    brier: r4(mean(rows.map((g) => pick(g).brier))),
    logloss: r4(mean(rows.map((g) => pick(g).logloss))),
    prob_n: rows.filter((g) => pick(g).brier != null).length,
  };
  if (side !== 'close') {
    const clvKey = side === 'published' ? 'clv_pts' : 'clv_pts_open_to_close';
    const c = rows.map((g) => pick(g)[clvKey]).filter((x) => x != null);
    out.clv = { basis: side === 'published' ? 'the recorded quote at publication to the close (the model record)' : 'the opener to the close (replayed number; it did not exist at the open)',
      n: c.length, mean_pts: r4(mean(c)), positive: c.filter((x) => x > 0).length, negative: c.filter((x) => x < 0).length };
    const a = rows.map((g) => pick(g).ats).filter((x) => x === 'win' || x === 'loss');
    out.ats_vs_close = { n: a.length, wins: a.filter((x) => x === 'win').length };
    out.closer_than_close = rows.filter((g) => pick(g).closer === 'model').length;
  }
  return out;
}
function calibration(games, side) {
  const bins = []; for (let i = 0; i < 10; i++) bins.push({ lo: i / 10, hi: (i + 1) / 10, n: 0, p: 0, y: 0 });
  games.forEach((g) => {
    if (g.y == null) return;
    const p = side === 'close' ? g.close && g.close.home_win_prob : g[side] && g[side].home_win_prob;
    if (p == null) return;
    const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += g.y;
  });
  let ece = 0; const n = bins.reduce((s, b) => s + b.n, 0);
  bins.forEach((b) => { if (b.n) ece += (b.n / n) * Math.abs(b.p / b.n - b.y / b.n); });
  return { n, ece: n ? r4(ece) : null, bins: bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: b.n ? r4(b.p / b.n) : null, observed: b.n ? r4(b.y / b.n) : null })) };
}

/* a miss, attributed: the card rows that pushed the number AWAY from what happened,
   largest first, with the base strength's prior/current split */
function attribute(g) {
  const rep = g.replayed;
  if (!rep || !g.final) return null;
  const resid = g.final.home_margin - rep.home_margin;
  const rows = Object.keys(rep.card || {}).map((k) => ({ key: k, points: rep.card[k] })).filter((r) => r.points != null && r.points !== 0);
  const against = rows.filter((r) => Math.sign(r.points) === -Math.sign(resid)).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return {
    game_id: g.game_id, week: g.week, matchup: `${g.away} @ ${g.home}`, model_home_margin: rep.home_margin, final_home_margin: g.final.home_margin,
    close_home_margin: g.close ? g.close.home_margin : null, residual: r2(resid),
    market_saw_it: g.close ? Math.sign(g.close.home_margin - rep.home_margin) === Math.sign(resid) && g.close.home_margin !== rep.home_margin : null,
    pushed_wrong_way: against.map((r) => ({ key: r.key, points: r2(r.points) })),
    base_strength_split: { prior: rep.base_prior, current: rep.base_current },
    note: 'Attribution is a reading of the card, not a causal claim: it lists the components whose points pointed away from the final margin, largest first.',
  };
}

/* the compact season-to-date rows the weekly loop reads for repeat patterns */
function patternRows(games) {
  return games.filter((g) => g.replayed && g.final).map((g) => ({
    game_id: g.game_id, week: g.week, neutral: g.neutral,
    residual: r4(g.final.home_margin - g.replayed.home_margin), model: g.replayed.home_margin,
    close: g.close ? g.close.home_margin : null, card: g.replayed.card, base_prior: g.replayed.base_prior, base_current: g.replayed.base_current,
  }));
}

/* the latest week whose every scheduled game is final */
function settledWeek(schedule, season) {
  const by = {};
  schedule.filter((g) => num(g.season) === season).forEach((g) => {
    const w = num(g.week); if (w == null) return;
    (by[w] = by[w] || []).push(g);
  });
  const done = Object.keys(by).map(Number).filter((w) => by[w].every((g) => num(g.home_score) != null && num(g.away_score) != null)).sort((a, b) => a - b);
  return done.length ? done[done.length - 1] : null;
}

/* the whole evaluation from its inputs (pure: the tests call this) */
function evaluate(inp) {
  const season = inp.season, week = inp.week;
  const recGames = (inp.record && inp.record.games) || {};
  const opGames = (inp.openers && inp.openers.games) || {};
  const sched = inp.schedule.filter((g) => num(g.season) === season && num(g.week) != null && num(g.week) <= week
    && num(g.home_score) != null && num(g.away_score) != null);
  const scored = sched.map((g) => scoreGame(g, inp.weekPreds[g.game_id], recGames[g.game_id], opGames[g.game_id]))
    .sort((a, b) => (a.week - b.week) || String(a.kickoff).localeCompare(String(b.kickoff)) || a.game_id.localeCompare(b.game_id));
  const thisWeek = scored.filter((g) => g.week === week);
  const flags = thisWeek.filter((g) => (g.replayed && Math.abs(g.replayed.gap_to_close || 0) >= FLAG_PTS) || (g.published && Math.abs(g.published.gap_to_close || 0) >= FLAG_PTS))
    .map((g) => ({
      game_id: g.game_id, matchup: `${g.away} @ ${g.home}`,
      published_gap: g.published ? g.published.gap_to_close : null, replayed_gap: g.replayed ? g.replayed.gap_to_close : null,
      final_home_margin: g.final.home_margin, close_home_margin: g.close ? g.close.home_margin : null,
      published_closer: g.published ? g.published.closer : null, replayed_closer: g.replayed ? g.replayed.closer : null,
      replayed_ats: g.replayed ? g.replayed.ats : null,
      drivers: g.replayed ? Object.keys(g.replayed.card || {}).map((k) => ({ key: k, points: r2(g.replayed.card[k]) })).filter((r) => r.points)
        .sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 4) : [],
      text: [g.published && Math.abs(g.published.gap_to_close || 0) >= FLAG_PTS ? `published number ${Math.abs(g.published.gap_to_close).toFixed(1)} pts off the close` : null,
        g.replayed && Math.abs(g.replayed.gap_to_close || 0) >= FLAG_PTS ? `replayed number ${Math.abs(g.replayed.gap_to_close).toFixed(1)} pts off the close` : null].filter(Boolean).join('; '),
    }));
  const misses = thisWeek.filter((g) => g.replayed).sort((a, b) => b.replayed.error - a.replayed.error).slice(0, MISSES).map(attribute);
  /* published and replayed cover different games (a game the site never
     published has no published number), so they are also compared on the
     games all three have: the only like-for-like reading */
  const both = (gs) => gs.filter((g) => g.published && g.replayed && g.close_scores);
  const block = (gs) => ({ published: summarize(gs, 'published'), replayed: summarize(gs, 'replayed'), close: summarize(gs, 'close'),
    paired: { n: both(gs).length, published: summarize(both(gs), 'published'), replayed: summarize(both(gs), 'replayed'), close: summarize(both(gs), 'close') } });
  return {
    schema: SCHEMA, version: 1, season, week, generated_at: inp.now || new Date().toISOString(),
    served_model: inp.servedVersion || null,
    published_versions: [...new Set(thisWeek.map((g) => g.published && g.published.model_version).filter(Boolean))],
    conventions: {
      home_margin: 'home points minus away points; positive = home favoured / home won',
      clv_pts: 'points the market moved toward the side the number leaned; positive = the market came to the model',
      flag: `|model home margin - closing home margin| >= ${FLAG_PTS}`,
      replayed: 'the number the model served at evaluation time gives the game from its pregame state (corrected pipeline); never a published number',
    },
    week_summary: block(thisWeek),
    season_to_date: Object.assign(block(scored), {
      weeks: [...new Set(scored.map((g) => g.week))],
      calibration: { published: calibration(scored, 'published'), replayed: calibration(scored, 'replayed'), close: calibration(scored, 'close') },
      rows: patternRows(scored),
    }),
    flags, misses, games: thisWeek,
  };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function weekFile(dir, season, week) { return path.join(dir, `nfl_${season}_w${String(week).padStart(2, '0')}.json`); }
function writeIndex(dir, doc) {
  const f = path.join(dir, 'index.json');
  const idx = readJson(f) || { schema: 'edgedesk_nfl_weekly_eval_index_v1', weeks: [] };
  const entry = { season: doc.season, week: doc.week, file: path.basename(weekFile(dir, doc.season, doc.week)), generated_at: doc.generated_at,
    served_model: doc.served_model, published: doc.week_summary.published, replayed: doc.week_summary.replayed, close: doc.week_summary.close, flags: doc.flags.length };
  idx.weeks = idx.weeks.filter((w) => !(w.season === doc.season && w.week === doc.week)).concat([entry]).sort((a, b) => (a.season - b.season) || (a.week - b.week));
  idx.latest = { season: doc.season, week: doc.week, file: entry.file };
  idx.updated_at = doc.generated_at;
  fs.writeFileSync(f, JSON.stringify(idx, null, 1) + '\n');
}
/* the same evaluation again (only the timestamp differs) is not a change */
function sameBut(a, b) { if (!a || !b) return false; const x = Object.assign({}, a, { generated_at: null }), y = Object.assign({}, b, { generated_at: null }); return JSON.stringify(x) === JSON.stringify(y); }

async function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const out = path.resolve(v('--out', OUT));
  const SL = require(path.join(ROOT, 'tools', 'football', 'build_nfl_slate.js'));
  let board;
  try { board = await SL.loadBoard({ offline: a.includes('--offline') }); } catch (e) { console.error('the NFL board would not load: ' + e.message); process.exit(1); }
  const S = board.S;
  const season = +v('--season', String(S.curSeason));
  const schedule = (S.games || []).map((u) => u.g).filter(Boolean);
  const week = a.includes('--week') ? +v('--week') : settledWeek(schedule, season);
  if (week == null) { console.log(`no settled ${season} week to evaluate`); return null; }
  const PV = board.win.EDNflParamsV2;
  const doc = evaluate({
    season, week, schedule, weekPreds: S.weekPreds || {},
    record: readJson(path.join(ROOT, 'record', 'football', `nfl_${season}.json`)),
    openers: readJson(path.join(ROOT, 'football', 'pricing', 'openers_nfl.json')),
    servedVersion: PV && PV.active ? PV.model_version : (board.win.EDFootball.meta() || {}).model_version,
  });
  const f = weekFile(out, season, week);
  const ws = doc.week_summary;
  console.log(`NFL ${season} week ${week}: ${ws.replayed.n} games; MAE published ${ws.published.mae} / replayed ${ws.replayed.mae} / close ${ws.close.mae}; `
    + `log loss ${ws.published.logloss} / ${ws.replayed.logloss} / ${ws.close.logloss}; ${doc.flags.length} flagged at ${FLAG_PTS}+ pts`);
  if (a.includes('--write')) {
    fs.mkdirSync(out, { recursive: true });
    if (sameBut(readJson(f), doc)) console.log('unchanged ' + path.relative(ROOT, f));
    else { fs.writeFileSync(f, JSON.stringify(doc, null, 1) + '\n'); writeIndex(out, doc); console.log('wrote ' + path.relative(ROOT, f)); }
  }
  return { doc, file: f };
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { evaluate, scoreGame, summarize, calibration, attribute, settledWeek, devig, clvPts, weekFile, writeIndex, main, SCHEMA, FLAG_PTS, OUT };

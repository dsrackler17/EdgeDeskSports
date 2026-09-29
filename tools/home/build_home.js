#!/usr/bin/env node
/* ============================================================================
   THE LANDING PAGE'S STATIC HALF — football/home/board.json

   The landing page makes two small, parallel reads for its live board:

     1. supabase/home_board.sql public_home_board()  the games, their fair and
        market numbers, the public status, the counts and the freshness —
        straight from the shared research state, cached for a minute
     2. THIS FILE'S OUTPUT                            the player props and the
        college game EV, which are published as committed artifacts and are
        far too large to send to a phone as they are

   football/props/<league>/summary.json is 45 KB (NFL) and ~200 KB (college);
   football/cfb_terminal/board.json is ~650 KB. This build folds the parts the
   landing page prints into one file of a few kilobytes:

     props.counts      per league: events, props, priced, evaluated,
                       research-grade, and the capture status
     props.items       every candidate printed below, once, by id
     props.top         the research-grade candidates across both leagues,
                       best research score first (at most 12 ids)
     props.by_game     per upcoming game: counts, capture state and its best
                       research-grade candidates (at most 3 ids)
     ratings           the top of EdgeDesk's FBS power ratings and the rated
                       team and player counts (football/rankings/current.json
                       is 6 MB and football/players/current.json 0.7 MB — the
                       landing page used to download both to print five
                       numbers)
     game_ev           per college game with a priced quote: the EXACT quote
                       the EV is for (selection, line, price, book, capture
                       time), calibrated and raw EV kept apart, the decision
                       and its reason

   NOTHING IS COMPUTED HERE. Every number is copied from an artifact the
   pipelines already wrote (football/props/build_summary.js,
   football/cfb_terminal/build.js). The page re-judges every price's AGE at
   view time — a candidate built fresh can be stale by the time it is read,
   and the page says so rather than presenting it as current.

   Run by .github/workflows/player-props.yml on every run (after the boards),
   committed with them.

     node tools/home/build_home.js [--write] [--out <file>] [--now <iso>]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'football', 'home', 'board.json');
const LIMITS = { top: 12, per_game: 3, why: 2, concerns: 2, horizon_days: 8 };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function num(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 1e4) / 1e4 : null; }
function str(v, n) { return v == null ? null : String(v).slice(0, n || 200); }
function strip(o) {
  if (Array.isArray(o)) return o.map(strip);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  Object.keys(o).forEach((k) => {
    const v = strip(o[k]);
    if (v === null || v === undefined) return;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

/* one prop opportunity (schema edgedesk_opportunity/1), reduced to what the
   landing page prints — the same fields supabase/home_board.sql
   ed_public_prop() returns, so the page has one renderer for both */
function slimProp(o, ev) {
  if (!o || !o.player || !o.market) return null;
  const e = o.event || {}, p = o.player || {}, pr = o.price || {}, m = o.model || {}, pj = m.projection || {}, mv = o.market_view || {};
  const x = o.explanation || {};
  const teamName = p.team && e.home === p.team ? (e.home_name || null) : (p.team && e.away === p.team ? (e.away_name || null) : null);
  return strip({
    id: str(o.id, 40),
    prop_id: str(o.prop_id, 120),
    league: str(o.league || e.league, 8),
    game_key: str(e.event_key || (o.league && e.game_id ? o.league + '|' + e.game_id : null), 80),
    matchup: { home: str(e.home_name || (ev && ev.home_name) || e.home, 60), away: str(e.away_name || (ev && ev.away_name) || e.away, 60), kickoff: str(e.kickoff || (ev && ev.kickoff), 40) },
    player: { name: str(p.name, 60), team: str(teamName || p.team, 60), position: str(p.position, 8) },
    market: { key: str(o.market.key, 40), label: str(o.market.label, 60) },
    selection: o.selection ? { side: str(o.selection.side, 12), line: num(o.selection.line), text: str(o.selection.text, 80) } : null,
    price: { american: num(pr.american), book: str(pr.book_name || pr.book, 40), captured_at: str(pr.captured_at, 40), alt: pr.alt === true ? true : null, books_at_line: num(pr.books_at_line) },
    projection: { mean: num(pj.mean), median: num(pj.median), p25: num(pj.p25), p75: num(pj.p75) },
    probability: num(m.probability),
    fair_american: num(m.fair_american),
    break_even: num(o.break_even),
    ev: num(o.ev),
    ev_raw: num(o.ev_raw),
    edge_pp: num(o.edge_pp),
    confidence: num(o.confidence),
    decision: str(o.decision, 16),
    stage: str(o.stage, 24),
    probability_label: str(o.probability_label, 80),
    consensus_line: num(mv.consensus_line),
    n_books: num(mv.n_books),
    research_score: o.research ? num(o.research.score) : null,
    research_grade: o.research ? o.research.grade === true : null,
    why: (x.why || []).slice(0, LIMITS.why).map((s) => str(s, 220)),
    concerns: (x.concerns || []).slice(0, LIMITS.concerns).map((s) => str(s, 220)),
    evaluated_at: str(o.evaluated_at, 40)
  });
}

function graded(o) { return !!(o && o.research && o.research.grade); }
function byScore(a, b) { return ((b.research && b.research.score) || 0) - ((a.research && a.research.score) || 0); }

function propsPart(summaries, now) {
  const counts = {}, top = [], byGame = {}, items = {};
  const keep = (o, ev) => { const x = slimProp(o, ev); if (!x || !x.id) return null; items[x.id] = x; return x.id; };
  const horizon = now + LIMITS.horizon_days * 864e5;
  Object.keys(summaries).forEach((lg) => {
    const s = summaries[lg];
    if (!s) return;
    const c = s.counts || {};
    counts[lg] = strip({
      events: num(c.events), props: num(c.props), priced: num(c.priced), evaluated: num(c.evaluated), research_grade: num(c.research_grade),
      generated_at: str(s.generated_at, 40),
      capture: s.capture ? { status: str(s.capture.status, 24), reason: str(s.capture.reason, 40), last_success_at: str(s.capture.last_success_at, 40) } : null
    });
    const evs = s.events && typeof s.events === 'object' ? (Array.isArray(s.events) ? s.events : Object.keys(s.events).map((k) => s.events[k])) : [];
    evs.forEach((ev) => {
      const k = Date.parse(ev.kickoff);
      if (!isFinite(k) || k <= now || k > horizon) return;          /* pregame, inside the week */
      const key = ev.event_key || (lg + '|' + ev.game_id);
      const tops = (ev.top_opportunities || []).filter(graded).sort(byScore);
      tops.forEach((o) => top.push({ o, ev }));
      byGame[key] = strip({
        total: num(ev.total_props), priced: num(ev.priced_props), evaluated: num(ev.evaluated_props),
        research_grade: num(ev.research_grade_count), capture: ev.capture ? str(ev.capture.state, 24) : null,
        top: tops.slice(0, LIMITS.per_game).map((o) => keep(o, ev)).filter(Boolean)
      });
    });
  });
  top.sort((a, b) => byScore(a.o, b.o));
  const total = {};
  ['events', 'props', 'priced', 'evaluated', 'research_grade'].forEach((k) => {
    const vals = Object.keys(counts).map((lg) => counts[lg][k]).filter((v) => typeof v === 'number');
    total[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  });
  counts.total = strip(total);
  const topIds = top.slice(0, LIMITS.top).map((x) => keep(x.o, x.ev)).filter(Boolean);
  return { counts, items, top: topIds, by_game: byGame };
}

/* the college game EV: the exact quote it is for, calibrated and raw apart */
function gameEvPart(board, now) {
  const out = {};
  if (!board || !Array.isArray(board.rows)) return out;
  board.rows.forEach((r) => {
    const k = Date.parse(r.kickoff);
    if (!isFinite(k) || k <= now) return;
    const b = r.bettor || {}, q = b.quote || {}, qe = r.quote_ev || {}, e = r.ev || {};
    if (!qe.ev_available && b.calibrated_ev_pct == null) return;
    const line = num(q.line != null ? q.line : (b.line != null ? b.line : qe.best_spread));
    const price = num(q.odds != null ? q.odds : (b.odds != null ? b.odds : qe.best_price));
    if (line == null || price == null) return;
    out['cfb|' + r.game_id] = strip({
      selection: str(q.selection || (b.side != null ? b.side + ' ' + (line > 0 ? '+' : '') + line : null) || e.selected, 80),
      side_team: str(b.side || qe.best_team, 60),
      line, price,
      book: str(q.sportsbook || b.book || qe.best_book, 40),
      captured_at: str(q.captured_at || qe.best_quote_timestamp, 40),
      freshness_at_build: str(q.freshness, 16),
      calibrated_ev: b.calibrated_ev_pct != null ? num(b.calibrated_ev_pct / 100) : (qe.calibrated_expected_value_pct != null ? num(qe.calibrated_expected_value_pct / 100) : null),
      raw_ev: b.raw_ev_pct != null ? num(b.raw_ev_pct / 100) : (qe.expected_value_pct != null ? num(qe.expected_value_pct / 100) : null),
      cover_calibrated: num(e.cover_calibrated),
      break_even: num(e.break_even != null ? e.break_even : qe.break_even_probability),
      fair_odds: num(qe.model_fair_odds),
      probability_source: str(b.probability_source, 32),
      decision: str(b.decision || r.decision_status, 16),
      decision_reason: str(b.reason || r.decision_reason, 220),
      research_label: str(r.research_label, 40),
      fair: str(r.fair, 60), market: str(r.market, 60), gap: num(r.gap),
      uncertainty: (r.uncertainty_why || []).slice(0, 3).map((s) => str(s, 120)),
      evaluated_at: str(b.evaluated_at || board.generated_at, 40)
    });
  });
  return out;
}

function ratingsPart(rk, pl) {
  const out = {};
  if (rk && rk.teams) {
    const teams = Object.keys(rk.teams).map((k) => rk.teams[k]).filter((t) => t && t.rank != null && typeof t.etsr === 'number')
      .sort((a, b) => a.rank - b.rank).slice(0, 5);
    out.top = teams.map((t) => ({ rank: t.rank, team: str(t.team, 60), rating: num(t.etsr) }));
    out.team_count = num(rk.team_count);
    out.generated_at = str(rk.generated_at, 40);
  }
  if (pl) { out.player_count = num(pl.player_count); if (out.team_count == null) out.team_count = num(pl.team_count); }
  return strip(out);
}

function build(opts) {
  opts = opts || {};
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const read = opts.read || ((rel) => readJson(path.join(ROOT, rel)));
  const summaries = { nfl: read('football/props/nfl/summary.json'), cfb: read('football/props/cfb/summary.json') };
  const board = read('football/cfb_terminal/board.json');
  const ratings = ratingsPart(read('football/rankings/current.json'), read('football/players/current.json'));
  return {
    schema: 'edgedesk_home_static/1',
    generated_at: new Date(now).toISOString(),
    note: 'Copied from football/props/<league>/summary.json and football/cfb_terminal/board.json; nothing here is computed. The page re-judges every price age at view time.',
    sources: strip({
      props: { nfl: summaries.nfl ? summaries.nfl.generated_at : null, cfb: summaries.cfb ? summaries.cfb.generated_at : null },
      cfb_terminal: board ? board.generated_at : null
    }),
    props: propsPart(summaries, now),
    game_ev: gameEvPart(board, now),
    ratings
  };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  const out = build({ now: arg('now') || undefined });
  const body = JSON.stringify(out) + '\n';
  if (a.indexOf('--write') >= 0) {
    const file = arg('out') || OUT;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prev = null; try { prev = fs.readFileSync(file, 'utf8'); } catch (e) { prev = null; }
    /* generated_at alone changing is not news: keep the file (and the commit) quiet */
    const same = prev && JSON.stringify(Object.assign(JSON.parse(prev), { generated_at: null })) === JSON.stringify(Object.assign(JSON.parse(body), { generated_at: null }));
    if (!same) fs.writeFileSync(file, body);
    console.log('home board: ' + (same ? 'unchanged' : 'written') + ' · ' + Buffer.byteLength(body) + ' bytes · '
      + out.props.top.length + ' research-grade props (' + Object.keys(out.props.items).length + ' printed) · ' + Object.keys(out.props.by_game).length + ' games with props · '
      + Object.keys(out.game_ev).length + ' college game EV quotes');
  } else {
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  }
}

if (require.main === module) main();
module.exports = { build, slimProp, propsPart, gameEvPart, ratingsPart, LIMITS };

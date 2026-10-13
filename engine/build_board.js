#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk ENGINE — build the cross-sport opportunity board.

     node engine/build_board.js [--now ISO]      write engine/board.json
     node engine/build_board.js --check          the committed board passes its rules

   Gathers candidates from every sport brain's committed output and evaluates
   them with lib/edgedesk_xboard.js against engine/registry.json:
     NHL       hockey/slate.json (fair prices) + hockey/market/quotes.json
               (captured book prices, only when authorised)
     NFL, CFB  football/linemaker/fair_lines.json — probabilities at the
               consensus line; the consensus is a REFERENCE, never a price
     NBA, WNBA, men's and women's college basketball
               basketball/slate.json — fair prices (no book prices captured)
     soccer    soccer/slate.json — 1X2, total 2.5, both-to-score and a
               quarter Asian line (split settlement), per league
     any       engine/market/manual_quotes.json — a price I typed in from a
               sportsbook screen, labelled USER_SUPPLIED with its time
   Spends nothing: no network, no odds credit.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const XB = require('../lib/edgedesk_xboard');
const Q = require('../hockey/market/quotes');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'board.json');
function read(p) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (_) { return null; } }
function arg(n) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; }

/* ---------- NHL ---------- */
function nhlCandidates(slate, quotes) {
  if (!slate) return [];
  const out = [];
  const qByGame = new Map(); for (const e of (quotes && quotes.events) || []) qByGame.set(e.game_id, e);
  const fresh = quotes && (quotes.status === 'LIVE' || quotes.status === 'CACHED');
  for (const g of slate.games) {
    const label = g.away + ' @ ' + g.home;
    const base = { sport_id: 'nhl', sport_label: 'NHL', event_key: g.event_key, event: { home: g.home, away: g.away, start_utc: g.start_utc, label },
      data: { state: slate.readiness.data.state, lineup_certainty: g.goalies.certainty === 'CONFIRMED' ? 'CONFIRMED' : g.goalies.certainty },
      evidence: [
        'λ ' + g.lambda.home + ' (' + g.home + ') vs ' + g.lambda.away + ' (' + g.away + ') regulation goals',
        g.home + ' 5v5 xG for ' + g.evidence.home.ev_xg_for_vs_league + '× league, ' + g.away + ' 5v5 xG for ' + g.evidence.away.ev_xg_for_vs_league + '×',
        'goalies: ' + g.goalies.certainty.replace(/_/g, ' ').toLowerCase() + ' (' + (g.goalies.home[0] ? g.goalies.home[0].name + ' ' + Math.round(g.goalies.home[0].p_start * 100) + '%' : '—') + ' / ' + (g.goalies.away[0] ? g.goalies.away[0].name + ' ' + Math.round(g.goalies.away[0].p_start * 100) + '%' : '—') + ')',
        'model ' + slate.model.id + '; record: moneyline ' + (slate.record.moneyline ? slate.record.moneyline.status : '—') + ' vs outcomes, not tested vs the close',
      ],
      invalidators: g.invalidators };
    const mlSd = (g.uncertainty.moneyline_sd_pp || 1) / 100;
    const calib = g.uncertainty.calibration_bin;
    const e = fresh ? qByGame.get(g.game_id) : null;
    /* best price per side across books; sharp reference = pinnacle when present, else the consensus no-vig */
    const pick = (getter) => {
      let best = null; const pairs = [];
      for (const b of (e && e.books) || []) { const v = getter(b); if (!v) continue; pairs.push(Object.assign({ book: b.book, last_update: b.last_update }, v)); }
      return pairs;
    };
    const refFrom = (pairs, a, b) => {
      const sharp = pairs.find((p) => /pinnacle/i.test(p.book));
      if (sharp) { const nv = Q.noVig(sharp[a], sharp[b]); return nv ? { p_a: nv.a, p_b: nv.b, method: 'sharp', book: sharp.book, books: 1, captured_at: sharp.last_update } : null; }
      const nvs = pairs.map((p) => Q.noVig(p[a], p[b])).filter(Boolean);
      if (!nvs.length) return null;
      const m = nvs.map((x) => x.a).sort((x, y) => x - y)[Math.floor(nvs.length / 2)];
      return { p_a: m, p_b: 1 - m, method: 'consensus', books: nvs.length, captured_at: pairs.map((p) => p.last_update).sort().slice(-1)[0] };
    };
    const bestQuote = (pairs, key) => pairs.filter((p) => isFinite(p[key])).sort((x, y) => XB.amToDec(y[key]) - XB.amToDec(x[key]))[0] || null;
    /* moneyline */
    const ml = pick((b) => b.h2h);
    const mlRef = refFrom(ml, 'home', 'away');
    for (const side of ['home', 'away']) {
      const bq = bestQuote(ml, side);
      out.push(Object.assign({}, base, { market: { kind: 'moneyline', side: side === 'home' ? g.home : g.away, line: null, settles: g.prices.moneyline.settles },
        quote: bq ? { book: bq.book, american: bq[side], captured_at: bq.last_update, source: 'odds_gateway', verified: true } : null,
        model: { p_win: g.prices.moneyline[side], p_push: 0, method: 'MODEL', model_id: slate.model.id, sd: mlSd, calibration: side === 'home' ? calib : null },
        market_ref: mlRef ? { p_novig: side === 'home' ? mlRef.p_a : mlRef.p_b, method: mlRef.method, book: mlRef.book || null, books: mlRef.books, captured_at: mlRef.captured_at } : null }));
    }
    /* puck line ±1.5 */
    const pl = pick((b) => (b.spreads || []).find((s) => Math.abs(Math.abs(s.home_line) - 1.5) < 1e-9));
    const plRef = refFrom(pl, 'home', 'away');
    const homeFav = g.prices.moneyline.home >= 0.5;
    const plSides = homeFav ? [['home', g.home, -1.5, g.prices.puck_line.home_minus_1_5], ['away', g.away, 1.5, g.prices.puck_line.away_plus_1_5]] : [['home', g.home, 1.5, g.prices.puck_line.home_plus_1_5], ['away', g.away, -1.5, g.prices.puck_line.away_minus_1_5]];
    for (const [side, team, line, p] of plSides) {
      const match = pl.filter((x) => (side === 'home' ? x.home_line : -x.home_line) === line);
      const bq = bestQuote(match, side);
      out.push(Object.assign({}, base, { market: { kind: 'spread', side: team, line, settles: g.prices.puck_line.settles },
        quote: bq ? { book: bq.book, american: bq[side], captured_at: bq.last_update, source: 'odds_gateway', verified: true } : null,
        model: { p_win: p, p_push: 0, method: 'MODEL', model_id: slate.model.id, sd: mlSd * 1.1 },
        market_ref: plRef && match.length ? { p_novig: side === 'home' ? plRef.p_a : plRef.p_b, method: plRef.method, book: plRef.book || null, books: plRef.books, captured_at: plRef.captured_at } : null }));
    }
    /* total at the book's line when captured, else at the fair line */
    const tots = pick((b) => (b.totals || [])[0] || null);
    const line = tots.length ? tots.map((t) => t.line).sort((x, y) => x - y)[Math.floor(tots.length / 2)] : g.prices.total.fair_line;
    const tl = g.prices.total.lines[String(line)];
    if (tl) {
      const match = tots.filter((t) => t.line === line);
      const tRef = refFrom(match, 'over', 'under');
      for (const side of ['over', 'under']) {
        const bq = bestQuote(match, side);
        out.push(Object.assign({}, base, { market: { kind: 'total', side, line, settles: g.prices.total.settles },
          quote: bq ? { book: bq.book, american: bq[side], captured_at: bq.last_update, source: 'odds_gateway', verified: true } : null,
          model: { p_win: tl[side], p_push: tl.push || 0, method: 'MODEL', model_id: slate.model.id, sd: Math.max(0.02, (g.uncertainty.total_sd_goals || 0.1) * 0.18) },
          market_ref: tRef ? { p_novig: side === 'over' ? tRef.p_a : tRef.p_b, method: tRef.method, book: tRef.book || null, books: tRef.books, captured_at: tRef.captured_at } : null }));
      }
    }
  }
  return out;
}

/* ---------- NFL / CFB (reference lines only: research, never priced) ---------- */
function footballCandidates(sheets, now) {
  if (!sheets || !Array.isArray(sheets.games)) return [];
  const out = [];
  for (const g of sheets.games) {
    const rv = g.reference_versus; if (!rv || !g.ok) continue;
    if (!(Date.parse(g.kickoff) > now)) continue;
    const sport = g.sport === 'americanfootball_nfl' ? 'nfl' : 'cfb', lbl = sport === 'nfl' ? 'NFL' : 'College football';
    const base = { sport_id: sport, sport_label: lbl, event_key: (sport === 'nfl' ? 'NFL|' : 'CFB|') + g.game_id, event: { home: g.home, away: g.away, start_utc: g.kickoff, label: g.away + ' @ ' + g.home },
      data: { state: g.data_quality && g.data_quality.status === 'OK' ? 'FRESH' : 'STALE', lineup_certainty: 'UNKNOWN' },
      evidence: ['fair spread ' + (g.markets.spread ? g.markets.spread.fair_home_line : '—') + ' vs consensus ' + (rv.spread ? rv.spread.home_line : '—') + ' (' + rv.source + ')', 'spread ' + (g.markets.spread ? g.markets.spread.status + ' vs outcomes, ' + g.markets.spread.tier + ' vs close' : '—')],
      invalidators: ['A quarterback change.', 'The consensus line is a reference, not an executable price: a real quote may differ.'] };
    /* the consensus line is, by construction, priced near even: its reference
       probability is half of what does not push (a REFERENCE, not a price) */
    const refAt = (push) => ({ p_novig: (1 - (push || 0)) / 2, method: 'consensus_reference', book: null, books: null, captured_at: rv.observed_at || null });
    if (rv.spread) for (const side of ['home', 'away']) {
      const line = side === 'home' ? rv.spread.home_line : -rv.spread.home_line;
      out.push(Object.assign({}, base, { market: { kind: 'spread', side: side === 'home' ? g.home : g.away, line, settles: 'includes overtime; a landed number pushes' }, quote: null,
        model: { p_win: side === 'home' ? rv.spread.home_cover : rv.spread.away_cover, p_push: rv.spread.push || 0, method: 'MODEL', model_id: g.model_version || g.version, sd: 0.03 }, market_ref: refAt(rv.spread.push) }));
    }
    if (rv.total) for (const side of ['over', 'under']) out.push(Object.assign({}, base, { market: { kind: 'total', side, line: rv.total.line, settles: 'includes overtime' }, quote: null, model: { p_win: rv.total[side], p_push: rv.total.push || 0, method: 'MODEL', model_id: g.model_version || g.version, sd: 0.03 }, market_ref: refAt(rv.total.push) }));
    if (rv.moneyline && rv.moneyline.no_vig && g.markets.moneyline) for (const side of ['home', 'away']) out.push(Object.assign({}, base, { market: { kind: 'moneyline', side: side === 'home' ? g.home : g.away, line: null, settles: 'includes overtime' }, quote: null,
      model: { p_win: side === 'home' ? g.markets.moneyline.home_win : g.markets.moneyline.away_win, p_push: 0, method: 'MODEL', model_id: g.model_version || g.version, sd: 0.03 },
      market_ref: { p_novig: side === 'home' ? rv.moneyline.no_vig.a : rv.moneyline.no_vig.b, method: 'consensus_reference', book: null, books: null, captured_at: rv.observed_at || null } }));
  }
  return out;
}

/* ---------- basketball and soccer (fair prices, research until a price exists) ---------- */
function basketballCandidates(slate, now) {
  if (!slate || !slate.leagues) return [];
  const out = [];
  for (const [league, L] of Object.entries(slate.leagues)) for (const g of L.games || []) {
    if (!(Date.parse(g.start_utc) > now)) continue;
    const base = { sport_id: L.registry, sport_label: L.label, event_key: g.event_key, event: { home: g.home, away: g.away, start_utc: g.start_utc, label: g.away + ' @ ' + g.home },
      data: { state: g.data_quality.early_season ? 'FRESH' : 'FRESH', lineup_certainty: 'UNKNOWN' },
      evidence: ['projected margin ' + g.prices.spread.projected_margin + ' (home), total ' + g.prices.total.projected, 'model ' + L.model + ' (' + league + '); moneyline ' + L.validation.moneyline + ', spread ' + L.validation.spread + ', total ' + L.validation.total + ' vs outcomes; never tested vs the close'],
      invalidators: g.invalidators };
    for (const side of ['home', 'away']) out.push(Object.assign({}, base, { market: { kind: 'moneyline', side: side === 'home' ? g.home : g.away, line: null, settles: g.prices.moneyline.settles }, quote: null,
      model: { p_win: g.prices.moneyline[side], p_push: 0, method: 'MODEL', model_id: 'basketball/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
    const fl = g.prices.spread.fair_home_line; const sl = g.prices.spread.lines[fl];
    if (sl) for (const side of ['home', 'away']) out.push(Object.assign({}, base, { market: { kind: 'spread', side: side === 'home' ? g.home : g.away, line: side === 'home' ? fl : -fl, settles: g.prices.spread.settles }, quote: null,
      model: { p_win: side === 'home' ? sl.home_cover : sl.away_cover, p_push: sl.push, method: 'MODEL', model_id: 'basketball/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
    const tl = g.prices.total.lines[g.prices.total.fair_line];
    if (tl) for (const side of ['over', 'under']) out.push(Object.assign({}, base, { market: { kind: 'total', side, line: g.prices.total.fair_line, settles: g.prices.total.settles }, quote: null,
      model: { p_win: tl[side], p_push: tl.push, method: 'MODEL', model_id: 'basketball/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
  }
  return out;
}
function soccerCandidates(slate) {
  if (!slate || !slate.leagues) return [];
  const out = [];
  for (const [league, L] of Object.entries(slate.leagues)) for (const g of L.games || []) {
    const base = { sport_id: 'soccer', sport_label: 'Soccer · ' + L.label, event_key: g.event_key, event: { home: g.home, away: g.away, start_utc: g.date + 'T23:59:00Z', date: g.date, label: g.away + ' @ ' + g.home },
      data: { state: g.data_quality.state, lineup_certainty: 'UNKNOWN' },
      evidence: ['λ ' + g.lambda.home + ' / ' + g.lambda.away + ' goals', 'model ' + L.model + ' (' + league + '); 1X2 ' + L.validation.three_way + ', Asian handicap ' + L.validation.asian_handicap + ' vs outcomes; never tested vs the close'].concat(L.data.note ? [L.data.note] : []),
      invalidators: g.invalidators };
    const t = g.prices.three_way;
    for (const [side, p] of [['home', t.home], ['draw', t.draw], ['away', t.away]]) out.push(Object.assign({}, base, { market: { kind: 'three_way', registry_key: league + '.moneyline', side: side === 'home' ? g.home : side === 'away' ? g.away : 'draw', line: null, settles: t.settles }, quote: null,
      model: { p_win: p, p_push: 0, method: 'MODEL', model_id: 'soccer/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
    const tot = g.prices.total;
    for (const side of ['over', 'under']) out.push(Object.assign({}, base, { market: { kind: 'total', registry_key: league + '.total', side, line: 2.5, settles: '90 minutes plus stoppage time' }, quote: null,
      model: { p_win: side === 'over' ? tot.over_2_5 : 1 - tot.over_2_5, p_push: 0, method: 'MODEL', model_id: 'soccer/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
    const ah = g.prices.asian_handicap_home['-0.25'];
    if (ah) out.push(Object.assign({}, base, { market: { kind: 'asian_handicap', registry_key: league + '.spread', side: g.home, line: -0.25, settles: 'quarter line: two half stakes on 0 and -0.5' }, quote: null,
      model: { settlement: { type: 'split', full_win: ah.full_win, half_win: ah.half_win, push: ah.push, half_loss: ah.half_loss, full_loss: ah.full_loss }, method: 'MODEL', model_id: 'soccer/' + league + ':' + L.model, sd: 0.025 }, market_ref: null }));
  }
  return out;
}

/* ---------- my own quotes ---------- */
function applyManual(cands, manual) {
  if (!manual || !Array.isArray(manual.quotes)) return { applied: 0 };
  let applied = 0;
  for (const q of manual.quotes) {
    const c = cands.find((x) => x.event_key === q.event_key && x.market.kind === q.market.kind && String(x.market.side) === String(q.market.side) && (q.market.line == null || Number(x.market.line) === Number(q.market.line)));
    if (!c) continue;
    if (c.quote && XB.amToDec(c.quote.american) >= XB.amToDec(q.american)) continue; /* a captured price that is as good stays */
    c.quote = { book: q.book, american: Number(q.american), captured_at: q.captured_at, source: 'user_supplied', verified: false, note: q.note || null };
    applied++;
  }
  return { applied };
}

function coverage(registry, cands, slate, quotes) {
  return (registry ? registry.sports : []).map((s) => {
    const mine = cands.filter((c) => c.sport_id === s.id);
    const priced = mine.filter((c) => c.quote).length;
    let note;
    if (s.id === 'nhl') note = slate ? slate.games.length + ' upcoming games priced by the model; book prices: ' + (quotes ? quotes.status : 'NOT_CAPTURED') : 'no slate built';
    else if (s.id === 'nfl' || s.id === 'cfb') note = mine.length ? mine.length + ' sides at the consensus line (a reference, not a price); captured book prices live in the desk (Supabase), not in this static board' : 'no sheet with a reference line in the window';
    else if (['nba', 'wnba', 'ncaab_m', 'ncaab_w', 'soccer'].indexOf(s.id) >= 0) note = mine.length ? mine.length + ' fair prices in the window; no book price is captured for this sport' : 'no game in the window (fair prices appear when the schedule reaches it)';
    else if (s.id === 'mlb') note = 'the record is walk-forward through 2025; no 2026 schedule or game logs are in the sources, so nothing is priced now';
    else note = s.readiness.state === 'UNAVAILABLE' ? 'no data or model wired' : s.readiness.state === 'RETIRED' ? 'retired product' : 'no independent model: nothing to evaluate here';
    const L = s.readiness.ladder || {};
    const fresh = mine.filter((c) => (c.gates || []).some((g) => g.gate === 'PRICE' && g.ok)).length;
    const actionable = mine.filter((c) => c.status === 'QUALIFIED').length;
    const ladder = Object.assign({}, L, {
      market_verified: { done: fresh > 0, detail: fresh ? fresh + ' fresh verified price' + (fresh === 1 ? '' : 's') + ' now' : priced ? priced + ' price' + (priced === 1 ? '' : 's') + ', none fresh' : 'no executable price on file now' },
      actionable: { done: actionable > 0, detail: actionable ? actionable + ' qualified' : 'none' },
    });
    return { id: s.id, label: s.label, state: s.readiness.state, value_claims: s.readiness.value_claims_any, candidates: mine.length, priced, note, ladder };
  });
}

function build(now) {
  const registry = read('engine/registry.json');
  const slate = read('hockey/slate.json');
  const quotes = read('hockey/market/quotes.json');
  const sheets = read('football/linemaker/fair_lines.json');
  const manual = read('engine/market/manual_quotes.json');
  const bb = read('basketball/slate.json');
  const sc = read('soccer/slate.json');
  const cands = nhlCandidates(slate, quotes).concat(footballCandidates(sheets, now), basketballCandidates(bb, now), soccerCandidates(sc));
  const man = applyManual(cands, manual);
  const board = XB.evaluate({ candidates: cands, registry, now });
  board.schema = 'edgedesk_engine_board_v1';
  board.coverage = coverage(registry, cands, slate, quotes);
  board.inputs = { registry_generated_at: registry && registry.generated_at, nhl_slate_generated_at: slate && slate.generated_at, basketball_slate_generated_at: bb && bb.generated_at, soccer_slate_generated_at: sc && sc.generated_at, nhl_quotes: quotes ? { status: quotes.status, generated_at: quotes.generated_at, reason: quotes.reason || null } : { status: 'NOT_CAPTURED' }, football_sheets_generated_at: sheets && sheets.generated_at, manual_quotes_applied: man.applied };
  /* keep the file small: every actionable row, and per sport the 24 research rows
     with the largest conservative disagreement with a market reference (the
     soonest games where no reference exists); counts above cover every candidate */
  const keep = board.candidates.filter((c) => c.status !== 'RESEARCH');
  const research = board.candidates.filter((c) => c.status === 'RESEARCH');
  const bySport = new Map();
  for (const c of research) { if (!bySport.has(c.sport_id)) bySport.set(c.sport_id, []); bySport.get(c.sport_id).push(c); }
  let kept = [];
  for (const list of bySport.values()) {
    list.sort((a, b) => ((b.disagreement == null ? -1 : b.disagreement) - (a.disagreement == null ? -1 : a.disagreement)) || (Date.parse(a.event.start_utc) - Date.parse(b.event.start_utc)));
    kept = kept.concat(list.slice(0, 24));
  }
  board.candidates_trimmed = { research_total: research.length, research_kept: kept.length, rule: 'all non-research rows; per sport, 24 research rows by conservative disagreement with the market reference, then by start time' };
  board.candidates = keep.concat(kept).map((c) => ({ id: c.id, status: c.status, sport_id: c.sport_id, sport_label: c.sport_label, event_key: c.event_key, event: c.event, market: c.market, label: c.label, quote: c.quote, quote_age_min: c.quote_age_min, fair_american: c.fair_american, break_even: c.break_even, prob: c.prob, ev_raw: c.ev_raw, ev_posterior: c.ev_posterior, ev_conservative: c.ev_conservative, min_acceptable_american: c.min_acceptable_american, disagreement: c.disagreement, gates: c.gates, sensitivity: c.sensitivity || null, settlement: c.settlement || null, evidence: c.evidence, invalidators: c.invalidators, data: c.data, model_id: c.model && c.model.model_id }));
  return board;
}

function check() {
  const b = read('engine/board.json'); const fails = [];
  if (!b || b.schema !== 'edgedesk_engine_board_v1') fails.push('schema');
  else {
    if (b.verdict === 'BEST_SUPPORTED' && (!b.best || b.best.status !== 'QUALIFIED')) fails.push('a best opportunity that is not QUALIFIED');
    for (const c of b.candidates) {
      if (c.status === 'QUALIFIED') {
        const vg = (c.gates || []).find((g) => g.gate === 'VALUE');
        if (!vg || !vg.ok) fails.push(c.id + ' qualified without passing the value gate');
        if (!c.quote) fails.push(c.id + ' qualified without a price');
      }
    }
    if (b.verdict === 'PASS' && (!b.why || !b.why.length)) fails.push('a PASS without a reason');
  }
  if (fails.length) { console.error('[board --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[board --check] ok: ' + b.verdict + ', ' + b.n_candidates + ' candidates, ' + b.n_priced + ' priced');
}

if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else {
    const now = arg('now') ? Date.parse(arg('now')) : Date.now();
    const b = build(now);
    fs.writeFileSync(OUT, JSON.stringify(b, null, 1) + '\n');
    console.log('[board] ' + b.verdict + ' — ' + b.n_candidates + ' candidates, ' + b.n_priced + ' priced; ' + b.why.join(' ') + (b.best ? ' Best: ' + b.best.label : ''));
  }
}
module.exports = { build, nhlCandidates, footballCandidates, applyManual };

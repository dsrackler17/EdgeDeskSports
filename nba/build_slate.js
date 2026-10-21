#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — the slate: every upcoming game's fair prices from one
   predictive distribution, the models beside each other, the availability
   behind the number, what moves it, how sure it is, and why to pass.

     node nba/build_slate.js [--hours 72] [--now 2026-10-21T16:00:00Z] [--offline]
     node nba/build_slate.js --check

   Reads the committed games (nba/data), the live parameters
   (nba/params/live.json, ml_live.json — fitted only on completed seasons) and
   the work tables, runs the point-in-time pass to now, and prices every game
   in the horizon (if none, the next two game days). Writes nba/slate.json
   (schema edgedesk_nba_slate_v1) and appends changed pregame sheets to the
   append-only ledger nba/ledger/<season>.jsonl.

   WHAT A PRICE HERE IS. EdgeDesk's own fair line from the model the
   walk-forward chose for the PROJECTED track — availability judged from each
   team's previous game, because nothing else is knowable when the sheet is
   published. It is not a betting opinion: NBA prices are not captured by
   default and the model has never been tested against a closing market, so
   `value_claims` is DISABLED on every market.

   STARTED GAMES KEEP THEIR RESEARCH. The slate keeps a game for three hours
   after tip, then drops it, and it prices a started game again. After the
   new slate is written, every game the previous slate priced before its tip
   that has now started moves, exactly as it was priced, to nba/recent.json
   (schema edgedesk_nba_recent_v1) with the time it was frozen, and stays
   there for C.RECENT_HOURS. Nothing in it is re-priced after the start; the
   NBA panel and Today's Games open a started game from it.

   SCENARIOS. For each team's highest-impact players: the same model with that
   player removed from (or returned to) the available set — minutes
   redistributed to teammates, impact from his own RAPM — never a fixed number
   of points. At a season's start, a ROSTER-ADJUSTED scenario prices each team
   with its current roster (ESPN's preseason roster via hoopR) instead of last
   season's closing rotation; it is shown beside, never instead of, the
   validated price, because its timing cannot be reproduced historically.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const io = require('./lib/io');
const D = require('./lib/data');
const PASS = require('./model/pass');
const WF = require('./model/walkforward');
const ML = require('./model/ml');
const DIST = require('./model/distribution');
const DF = require('./model/dist_fit');
const L = require('./model/learn');
const Q = require('./market/quotes');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

const FEATURE_LABEL = {
  elo_diff: 'Elo rating gap', gl_logit: 'Glicko rating gap', eff_m: 'adjusted efficiency margin', kal_m: 'Bayesian (Kalman) strength gap', kal_sd: 'rating uncertainty',
  eff_t: 'efficiency total', kal_t: 'Kalman total', pace: 'expected pace', pp_h: 'home offence vs away defence', pp_a: 'away offence vs home defence',
  efg_h: 'home shooting (eFG%) matchup', efg_a: 'away shooting (eFG%) matchup', tov_h: 'home turnover matchup', tov_a: 'away turnover matchup',
  orb_h: 'home offensive rebounding matchup', orb_a: 'away offensive rebounding matchup', ftr_h: 'home free-throw rate matchup', ftr_a: 'away free-throw rate matchup',
  tpar_h: 'home three-point volume', tpar_a: 'away three-point volume', luck_oh: 'home shooting luck (offence)', luck_dh: 'home opponents\' shooting luck', luck_oa: 'away shooting luck (offence)', luck_da: 'away opponents\' shooting luck',
  rest_h: 'home rest', rest_a: 'away rest', b2b_h: 'home back-to-back', b2b_a: 'away back-to-back', g7_h: 'home games in 7 days', g7_a: 'away games in 7 days',
  trav_h: 'home travel', trav_a: 'away travel', tz_h: 'home time-zone shift', tz_a: 'away time-zone shift', alt_vis: 'altitude (visitor)', road_a: 'away road trip length', homestand_h: 'home stand length',
  neutral: 'neutral site', playoff: 'postseason', gp_h: 'home games played', gp_a: 'away games played', plr_m_proj: 'player-impact margin (projected availability)', adj_proj: 'availability adjustment (projected)', proj_stale: 'rotation carried from last season',
};

/* ------------------------------------------------------------ the lab's own NBA ratings, for the comparison row */
function labRaw(f, h, a, neutral) {
  const lab = readJson(path.join(C.ROOT, 'basketball', 'params', 'nba_live.json'), null);
  if (!lab || !lab.ratings || !lab.ratings.teams) return null;
  const T = lab.ratings.teams; const H = T[h] || { o: 0, d: 0 }, A = T[a] || { o: 0, d: 0 };
  const hh = neutral ? 0 : lab.ratings.h / 2; const mu = lab.ratings.mu;
  const ph = mu + hh + H.o - A.d, pa = mu - hh + A.o - H.d;
  return { m: ph - pa, t: ph + pa };
}

/* ------------------------------------------------------------ current rosters (scenario only) */
async function currentRosters(season, offline) {
  const src = await io.fetchSource(C.SOURCES.rosters(season), { offline, ttlMs: 12 * 3600e3 });
  if (!src.ok) return { ok: false, by: new Map(), source: { url: C.SOURCES.rosters(season), error: src.not_found ? 'NOT_PUBLISHED' : String(src.error) } };
  const { rows } = await io.parquetAll(src.file, ['team_id', 'athlete_id', 'display_name', 'position_abbreviation', 'status_name']);
  const by = new Map(); for (const r of rows) { const t = String(r.team_id); if (!by.has(t)) by.set(t, []); by.get(t).push(String(r.athlete_id)); }
  return { ok: true, by, source: { url: src.url, sha256: src.sha256, fetched_at: src.fetched_at } };
}

/* ------------------------------------------------------------ the market beside the model (never inside it) */
function marketBlock(ev, pc, quotes, now) {
  const base = { value_claims: 'DISABLED', value_reason: 'model probabilities are not validated against a closing market; EV here is arithmetic, not an edge' };
  if (!ev || !pc) return Object.assign(base, { status: quotes.status === 'DISABLED' ? 'NOT_CAPTURED' : (quotes.status || 'NOT_CAPTURED'), reason: quotes.reason || 'no quote for this game', quotes: [] });
  const mg = DIST.marginals(pc);
  const rows = [];
  const ev_ = (p, push, am) => DIST.evAt(p, push, am);
  for (const b of ev.books) {
    const age = b.last_update ? Math.round((now - Date.parse(b.last_update)) / 60000) : null;
    const fresh = ev.commence_time && now >= Date.parse(ev.commence_time) ? 'STARTED' : age != null && age <= 60 ? 'FRESH' : 'STALE';
    const nvm = (x, y, first) => { const m = Q.noVigMethods(x, y); if (!m) return null; const f = (v) => r4(first ? v : 1 - v); return { multiplicative: f(m.multiplicative), additive: f(m.additive), power: f(m.power), shin: f(m.shin), method_spread: r4(m.spread) }; };
    if (b.h2h) {
      const nv = Q.noVig(b.h2h.home, b.h2h.away);
      for (const [sideK, am, p] of [['home', b.h2h.home, mg.p_home], ['away', b.h2h.away, 1 - mg.p_home]]) rows.push({ book: b.book, market: 'moneyline', side: sideK, line: null, american: am, quote_time: b.last_update, age_min: age, freshness: fresh,
        break_even: r4(DIST.americanToProb(am)), model_p: r4(p), model_push: 0, market_novig_p: nv ? r4(sideK === 'home' ? nv.a : nv.b) : null, market_novig_methods: nvm(b.h2h.home, b.h2h.away, sideK === 'home'), ev_vs_model: ev_(p, 0, am) });
    }
    for (const sp of b.spreads) {
      const h = DIST.spread(mg.margin, sp.home_line); const nv = Q.noVig(sp.home, sp.away);
      rows.push({ book: b.book, market: 'spread', side: 'home', line: sp.home_line, american: sp.home, quote_time: b.last_update, age_min: age, freshness: fresh, break_even: r4(DIST.americanToProb(sp.home)), model_p: h.win, model_push: h.push, market_novig_p: nv ? r4(nv.a) : null, market_novig_methods: nvm(sp.home, sp.away, true), ev_vs_model: ev_(h.win, h.push, sp.home) });
      rows.push({ book: b.book, market: 'spread', side: 'away', line: -sp.home_line, american: sp.away, quote_time: b.last_update, age_min: age, freshness: fresh, break_even: r4(DIST.americanToProb(sp.away)), model_p: h.lose, model_push: h.push, market_novig_p: nv ? r4(nv.b) : null, market_novig_methods: nvm(sp.home, sp.away, false), ev_vs_model: ev_(h.lose, h.push, sp.away) });
    }
    for (const t of b.totals) {
      const tt = DIST.total(mg.total, t.line); const nv = Q.noVig(t.over, t.under);
      rows.push({ book: b.book, market: 'total', side: 'over', line: t.line, american: t.over, quote_time: b.last_update, age_min: age, freshness: fresh, break_even: r4(DIST.americanToProb(t.over)), model_p: tt.over.win, model_push: tt.over.push, market_novig_p: nv ? r4(nv.a) : null, market_novig_methods: nvm(t.over, t.under, true), ev_vs_model: ev_(tt.over.win, tt.over.push, t.over) });
      rows.push({ book: b.book, market: 'total', side: 'under', line: t.line, american: t.under, quote_time: b.last_update, age_min: age, freshness: fresh, break_even: r4(DIST.americanToProb(t.under)), model_p: tt.under.win, model_push: tt.under.push, market_novig_p: nv ? r4(nv.b) : null, market_novig_methods: nvm(t.over, t.under, false), ev_vs_model: ev_(tt.under.win, tt.under.push, t.under) });
    }
  }
  return Object.assign(base, { status: quotes.status, captured_at: quotes.gateway ? quotes.gateway.fetched_at : null, model_version: pc ? 'edgedesk_nba_v1' : null, quotes: rows,
    forecast_basis: { model: 'MARKET_INDEPENDENT (no price enters the model)', market_novig: 'MARKET_DERIVED (shown beside the model, never blended into it)' },
    note: 'Model probability at each book\'s own line (pushes priced), the book\'s break-even, and the no-vig market probability kept separate (multiplicative is the reference; additive, power and Shin beside it, with their spread as the method sensitivity). A positive EV versus an unvalidated model is not an edge. STARTED quotes are never compared.' });
}

/* THE PASS GATES. A game could be called only when every gate passes; today
   the first one fails for every game, so every decision is PASS and the gates
   say exactly why. Nothing ranks a failed game, and no game is forced. */
function gatesFor(o) {
  const g = [];
  g.push({ gate: 'probabilities validated against a closing market', pass: false, why: 'no licensed archive of timestamped NBA closing prices: market_status NOT_TESTED' });
  g.push({ gate: 'outcome record', pass: !!o.outcomeValidated, why: o.outcomeValidated ? 'the chosen model passed the sealed test window' : 'the chosen model has not passed the sealed test window' });
  const freshQ = (o.market.quotes || []).filter((q) => q.freshness === 'FRESH');
  g.push({ gate: 'fresh executable prices', pass: freshQ.length > 0, why: freshQ.length ? freshQ.length + ' quotes under 60 minutes old' : (o.market.status === 'NOT_CAPTURED' || o.market.status === 'DISABLED' ? 'NBA prices are not captured (not authorised)' : 'no quote under 60 minutes old') });
  g.push({ gate: 'confirmed availability', pass: false, why: 'no injury report or confirmed lineup feed: the price uses the projected rotation' });
  g.push({ gate: 'settlement rules per book', pass: false, why: 'provider defaults assumed (incl. overtime); no per-book rule source' });
  g.push({ gate: 'identity mapping', pass: (o.market.quotes || []).length > 0, why: (o.market.quotes || []).length ? 'quotes matched by both team ids and a start within 6 h' : 'no quotes to map' });
  g.push({ gate: 'sample threshold', pass: !!o.sampleOk, why: o.sampleOk ? 'test window n ≥ 500' : 'no unsealed test window with n ≥ 500' });
  return { gates: g, decision: g.every((x) => x.pass) ? 'ELIGIBLE' : 'PASS', failed: g.filter((x) => !x.pass).map((x) => x.gate) };
}

function sheetHash(o) { return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16); }

async function build(o) {
  o = o || {};
  const now = o.now ? Date.parse(o.now) : Date.now();
  const hours = Number(o.hours || 72);
  const live = readJson(WF.LIVE, null); const mlLive = readJson(WF.ML_LIVE, null);
  if (!live || !mlLive) throw new Error('nba/params/live.json or ml_live.json is missing: run node nba/model/live.js');
  const record = readJson(WF.RECORD, null);
  const recP = record && record.markets && record.markets.P;
  const testN = record && record.windows && record.windows.test && record.windows.test.status !== 'SEALED' && record.choice && record.choice.P ? (record.windows.test[record.choice.P.chosen] || {}).n || 0 : 0;
  const recStatus = { validated: !!(recP && recP.moneyline && recP.moneyline.status === 'OUTCOME_VALIDATED' && !/sealed/.test(recP.window || '')), sampleOk: testN >= 500 };
  const season = C.currentSeason(now);
  const tuning = live.tuning;
  D.requireWork(D.seasonList(C.FIRST_SEASON, season), 'nba slate');
  const pass = await PASS.run(tuning.pass, { includeScheduled: true, now });
  const st = pass.states; const pm = st.pm;
  const teams = D.teamsMap(); const abbr = readJson(path.join(C.NBA, 'data', 'team_abbr.json'), {}); const players = D.playersMap();
  const sched = pass.rows.filter((r) => !r.y && r.start > now - 3 * 3600e3);
  let upcoming = sched.filter((r) => r.start <= now + hours * 3600e3);
  let horizonNote = 'games starting within ' + hours + ' hours';
  if (!upcoming.length && sched.length) {
    const days = [...new Set(sched.map((r) => r.date))].sort().slice(0, 2);
    upcoming = sched.filter((r) => days.includes(r.date)); horizonNote = 'no game within ' + hours + ' hours: the next ' + days.length + ' game day(s), ' + days.join(' and ');
  }
  upcoming.sort((a, b) => a.start - b.start);
  const rosters = await currentRosters(season, o.offline);
  const chosen = live.chosen.P; const cands = WF.candsFor('P').filter((c) => live.calibration[c.id]);
  const valid = record && record.windows && record.windows.selection ? record.windows.selection : {};
  const unsealed = record && record.windows && record.windows.test && record.windows.test.status !== 'SEALED';

  const attachMl = (f) => { const p = ML.applyLive(mlLive.models.P, f); f.mlP_ridge_m = p.ridge_m; f.mlP_ridge_t = p.ridge_t; f.mlP_logit_p = p.logit_p; f.mlP_gbdt_p = p.gbdt_p; f.mlP_gbdt_m = p.gbdt_m; f.mlP_gbdt_t = p.gbdt_t; };
  const paramsOf = (c, row) => WF.paramsFor(c, live.calibration[c.id], live.shape, live.ot, row);
  const summary = (p) => { const mg = DIST.marginals(p); return { p_home: r4(mg.p_home), fair_spread_home: -DIST.fairHalf(mg.margin), fair_total: DIST.fairHalf(mg.total), exp_margin: r2(DIST.mean(mg.margin)), exp_total: r2(DIST.mean(mg.total)) }; };
  const chosenCand = cands.find((c) => c.id === chosen) || cands.find((c) => c.id === 'F_kalman');
  const reprice = (row, mod) => { const r2_ = { ...row, f: Object.assign({}, row.f, mod) }; attachMl(r2_.f); const p = paramsOf(chosenCand, r2_); return p ? summary(p) : null; };

  const quotes = readJson(path.join(C.PATHS.market, 'quotes.json'), { status: 'DISABLED', events: [] });
  const quotesBy = new Map((quotes.events || []).map((e) => [String(e.game_id), e]));
  const ledgerFile = path.join(C.PATHS.ledger, season + '.jsonl');
  const prevLedger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const lastById = new Map(); for (const r of prevLedger) lastById.set(r.game_id, r);
  const newLedger = [];

  const games = [];
  for (const row of upcoming) {
    const f = row.f; attachMl(f);
    const lr = labRaw(f, row.home, row.away, row.neutral); if (lr) { f.lab_m = lr.m; f.lab_t = lr.t; }
    const models = [];
    for (const c of cands) { const p = paramsOf(c, row); if (!p) continue; models.push(Object.assign({ id: c.id, family: c.family, label: c.label, chosen: c.id === chosen,
      selection_ml_log_loss: valid[c.id] ? valid[c.id].moneyline.log_loss : null, selection_margin_crps: valid[c.id] ? valid[c.id].margin.crps : null }, summary(p))); }
    const pc = paramsOf(chosenCand, row);
    const price = pc ? DIST.price(pc) : null;
    const ps = models.map((m) => m.p_home).filter((v) => v != null);
    const meanP = ps.reduce((a, v) => a + v, 0) / Math.max(1, ps.length);
    const sdP = Math.sqrt(ps.reduce((a, v) => a + (v - meanP) * (v - meanP), 0) / Math.max(1, ps.length));

    /* availability: last game's rotation (projected), last-ten regulars, values */
    const side = (t, hs) => {
      const proj = pm.lastGamePlayers(t) || []; const regs = pm.regulars(t);
      const S = pm.strength(proj);
      const stale = !!f.proj_stale;
      const inRoster = rosters.ok && rosters.by.has(t) ? new Set(rosters.by.get(t)) : null;
      const list = S.minutes.map((x) => ({ id: x.pid, name: (players[x.pid] || {}).name || x.pid, pos: (players[x.pid] || {}).pos || null, minutes: r2(x.min), off: r2(x.o), def: r2(x.d), known: x.known,
        impact_pts: r2((x.min / 48) * (x.o + x.d) * (f.pace || 98) / 100), start_rate: r2(pm.startRate(x.pid)), on_current_roster: inRoster ? inRoster.has(x.pid) : null })).sort((a, b) => b.minutes - a.minutes);
      const absent = regs.filter((p) => !proj.includes(p)).map((pid) => { const v = pm.value(pid); return { id: pid, name: (players[pid] || {}).name || pid, usual_minutes: r2(pm.expMinutes(pid)), off: r2(v.o), def: r2(v.d) }; }).filter((x) => x.usual_minutes >= 8).sort((a, b) => b.usual_minutes - a.usual_minutes);
      const arrivals = inRoster ? [...inRoster].filter((pid) => !proj.includes(pid) && pm.expMinutes(pid) >= 12 && pm.pl.has(pid)).map((pid) => { const v = pm.value(pid); return { id: pid, name: (players[pid] || {}).name || pid, usual_minutes: r2(pm.expMinutes(pid)), off: r2(v.o), def: r2(v.d) }; }) : [];
      const departures = inRoster ? list.filter((x) => x.on_current_roster === false).map((x) => ({ id: x.id, name: x.name, minutes: x.minutes })) : [];
      return { projected: list.slice(0, 13), likely_starters: list.slice().sort((a, b) => (b.start_rate || 0) - (a.start_rate || 0)).slice(0, 5).map((x) => x.name), absent_regulars: absent, net_per100: r2(S.net), rotation_source: stale ? 'last season\'s closing game (no game this season yet)' : 'the team\'s previous game', arrivals, departures, proj, regs };
    };
    const H = side(row.home, 1), A = side(row.away, -1);
    /* scenarios: each team's three highest-impact projected players sitting; absent regulars returning */
    const he = pm.homeEdge() * (row.neutral ? 0 : 1);
    const fullH = pm.strength(H.regs), fullA = pm.strength(A.regs);
    const featFor = (setH, setA) => { const sh = pm.strength(setH), sa = pm.strength(setA); return { plr_m_proj: f.pace * (2 * he + sh.net - sa.net) / 100, adj_proj: f.pace * ((sh.net - fullH.net) - (sa.net - fullA.net)) / 100 }; };
    const base = summary(pc);
    const scenarios = [];
    for (const [team, S, isHome] of [[row.home, H, true], [row.away, A, false]]) {
      const top = S.projected.slice().sort((a, b) => (b.impact_pts || 0) - (a.impact_pts || 0)).slice(0, 3);
      for (const pl of top) {
        const setH = isHome ? H.proj.filter((p) => p !== pl.id) : H.proj, setA = isHome ? A.proj : A.proj.filter((p) => p !== pl.id);
        const sc = reprice(row, featFor(setH, setA)); if (!sc) continue;
        scenarios.push({ kind: 'sits', team: abbr[team] || team, player: pl.name, player_id: pl.id, p_home: sc.p_home, fair_spread_home: sc.fair_spread_home, fair_total: sc.fair_total, delta_p_home: r4(sc.p_home - base.p_home), delta_margin: r2(sc.exp_margin - base.exp_margin) });
      }
      for (const pl of S.absent_regulars.slice(0, 2)) {
        const setH = isHome ? H.proj.concat([pl.id]) : H.proj, setA = isHome ? A.proj : A.proj.concat([pl.id]);
        const sc = reprice(row, featFor(setH, setA)); if (!sc) continue;
        scenarios.push({ kind: 'returns', team: abbr[team] || team, player: pl.name, player_id: pl.id, p_home: sc.p_home, fair_spread_home: sc.fair_spread_home, fair_total: sc.fair_total, delta_p_home: r4(sc.p_home - base.p_home), delta_margin: r2(sc.exp_margin - base.exp_margin) });
      }
    }
    let rosterScenario = null;
    if (rosters.ok && f.proj_stale) {
      const cur = (t, S) => { const r = new Set(rosters.by.get(t) || []); const keep = S.proj.filter((p) => r.has(p)); const add = [...r].filter((p) => !S.proj.includes(p) && pm.pl.has(p)).sort((a, b) => pm.expMinutes(b) - pm.expMinutes(a)); return keep.concat(add).slice(0, 13); };
      const sc = reprice(row, featFor(cur(row.home, H), cur(row.away, A)));
      if (sc) rosterScenario = Object.assign({ label: 'Roster-adjusted (current ESPN roster; not validated)', note: 'Prices each team with its 2026-27 roster as published by ESPN (via hoopR) — players who left are removed, arrivals with NBA minutes added at their usual minutes. Shown beside the validated price, never instead of it.' }, sc, { delta_p_home: r4(sc.p_home - base.p_home) });
    }
    /* explanation: the ridge margin model's largest contributions, then the
       three rows that reconcile them to the PUBLISHED margin (audit_report.md
       §8.3 N2): the rest of the linear model's inputs, its value at an average
       matchup, and everything the chosen blend and its calibration add. The
       rows used to stop at the ridge's top eight, which missed the published
       margin by 2.5 points on average and pointed the other way in 9 of 22
       games. */
    const allC = ML.contributions(mlLive.models.P, f);
    const topC = allC.filter((x) => Math.abs(x.contribution) >= 0.15).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 8);
    const contrib = topC.map((x) => ({ feature: x.feature, label: FEATURE_LABEL[x.feature] || x.feature, value: r4(x.value), points_toward_home: r2(x.contribution) }));
    const sumAll = allC.reduce((a, x) => a + x.contribution, 0), sumTop = topC.reduce((a, x) => a + x.contribution, 0);
    const published = price && price.expected ? price.expected.margin : null;
    if (published != null && Number.isFinite(f.mlP_ridge_m)) {
      contrib.push({ feature: '_other_inputs', kind: 'reconciliation', label: 'the linear model\'s other inputs', value: null, points_toward_home: r2(sumAll - sumTop) });
      contrib.push({ feature: '_linear_baseline', kind: 'reconciliation', label: 'the linear model at an average matchup', value: null, points_toward_home: r2(f.mlP_ridge_m - sumAll) });
      contrib.push({ feature: '_blend_and_calibration', kind: 'reconciliation', label: 'the other models in the blend and the calibration', value: null, points_toward_home: r2(published - f.mlP_ridge_m) });
    }
    const lgEff = st.A.eff.L; const lgPace = st.A.pace.L;
    const matchup = {
      pace: r2(f.pace), league_pace: r2(lgPace),
      home_offence_vs_away_defence: r2(f.pp_h), away_offence_vs_home_defence: r2(f.pp_a), league_efficiency: r2(lgEff),
      four_factors: { home: { efg: r4(f.efg_h), tov: r4(f.tov_h), orb: r4(f.orb_h), ftr: r4(f.ftr_h), three_rate: r4(f.tpar_h) }, away: { efg: r4(f.efg_a), tov: r4(f.tov_a), orb: r4(f.orb_a), ftr: r4(f.ftr_a), three_rate: r4(f.tpar_a) },
        league: { efg: r4(st.A.efg.L), tov: r4(st.A.tov.L), orb: r4(st.A.orb.L), ftr: r4(st.A.ftr.L), three_rate: r4(st.A.tpar.L) } },
      shooting_luck: { home_offence: r4(f.luck_oh), home_defence_allowed: r4(f.luck_dh), away_offence: r4(f.luck_oa), away_defence_allowed: r4(f.luck_da), note: 'eFG% above what each team\'s shot locations predict, opponent-adjusted; tends to regress' },
      schedule: { home: { rest_days: f.rest_h, back_to_back: !!f.b2b_h, games_in_7: f.g7_h, travel_km: Math.round(Math.expm1(f.trav_h)) }, away: { rest_days: f.rest_a, back_to_back: !!f.b2b_a, games_in_7: f.g7_a, travel_km: Math.round(Math.expm1(f.trav_a)), road_trip_game: f.road_a, altitude: !!f.alt_vis } },
    };
    const early = Math.min(f.gp_h, f.gp_a) < 10;
    const uncertainty = { margin_sd: r2(pc ? pc.sd_m : null), margin_interval_80: price ? price.margin_interval_80 : null, total_interval_80: price ? price.total_interval_80 : null,
      rating_sd_points: r2(f.kal_sd), model_disagreement_sd: r4(sdP), early_season: early, rotation_stale: !!f.proj_stale,
      notes: [early ? 'Early season: each team has fewer than 10 games this season; ratings lean on last season, regressed.' : null, f.proj_stale ? 'Rotation from last season\'s closing game: offseason moves are not in the validated price (see the roster-adjusted scenario).' : null].filter(Boolean) };
    const reasons = ['No licensed closing-price archive: the model has never been tested against the market, so no price here is an edge (value claims DISABLED).'];
    if (early) reasons.push('Fewer than 10 games for at least one team this season: ratings carry last season, and the record is thinnest here.');
    if (f.proj_stale) reasons.push('Availability is last season\'s closing rotation; no injury report or confirmed lineup is in the price.');
    if (sdP >= 0.04) reasons.push('Models disagree (win-probability sd ' + (100 * sdP).toFixed(1) + ' pts): the answer depends on which signal you trust.');
    if (scenarios.some((s) => Math.abs(s.delta_p_home || 0) >= 0.05)) reasons.push('One player\'s status moves the win probability by 5+ points: wait for the inactive list.');
    const mkt = marketBlock(quotesBy.get(String(row.id)), pc, quotes, now);
    const gameOut = {
      game_id: row.id, start_utc: new Date(row.start).toISOString().replace(/\.000Z$/, 'Z'), date: row.date, type: row.type, neutral: !!row.neutral,
      home: { id: row.home, name: teams[row.home] || row.home, abbr: abbr[row.home] || null }, away: { id: row.away, name: teams[row.away] || row.away, abbr: abbr[row.away] || null },
      model: chosen, price, models, disagreement: { sd_p_home: r4(sdP), range_p_home: ps.length ? [r4(Math.min(...ps)), r4(Math.max(...ps))] : null },
      matchup, availability: { home: strip(H), away: strip(A) }, scenarios, roster_scenario: rosterScenario, explanation: contrib, explanation_sums_to: published != null ? r2(published) : null, uncertainty, reasons_to_pass: reasons,
      market: mkt,
      decision: gatesFor({ market: mkt, outcomeValidated: recStatus.validated, sampleOk: recStatus.sampleOk }),
      inputs_known_at: row.inputs_known_at ? new Date(row.inputs_known_at).toISOString() : null, predicted_at: new Date(now).toISOString(),
      context: { pace: r4(f.pace), kal_m: r4(f.kal_m), kal_t: r4(f.kal_t), b2b_h: f.b2b_h || 0, b2b_a: f.b2b_a || 0 },
    };
    games.push(gameOut);
    /* ledger: append when the sheet changed, only before tip */
    if (price && now < row.start) {
      const sheet = { p_home: price.moneyline.home, fair_spread_home: price.spread.fair_line_home, fair_total: price.total.fair_line, exp_margin: price.expected.margin, exp_total: price.expected.total };
      const h = sheetHash({ g: row.id, sheet });
      const prev = lastById.get(row.id);
      if (!prev || prev.id !== h) newLedger.push(Object.assign({ schema: C.SCHEMA.ledger, game_id: row.id, start_utc: gameOut.start_utc, home: gameOut.home.abbr, away: gameOut.away.abbr, model: 'edgedesk_nba_v1:' + chosen, recorded_at: new Date(now).toISOString() }, sheet,
        { sd_m: r2(pc.sd_m), p_ot: price.p_overtime, cover_at_fair: price.spread.main.fair, over_at_fair: price.total.main.over.fair, rotation_stale: !!f.proj_stale, id: h }));
    }
  }
  function strip(S) { const o = Object.assign({}, S); delete o.proj; delete o.regs; return o; }
  if (newLedger.length && !o.dryRun) { fs.mkdirSync(C.PATHS.ledger, { recursive: true }); fs.appendFileSync(ledgerFile, newLedger.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  const sel = (id) => (valid[id] ? { ml_log_loss: valid[id].moneyline.log_loss, brier: valid[id].moneyline.brier, calibration_slope: valid[id].moneyline.calibration_slope, margin_crps: valid[id].margin.crps, total_crps: valid[id].total.crps, n: valid[id].n } : null);
  const out = {
    schema: C.SCHEMA.slate, generated_at: new Date(now).toISOString(), season, horizon: horizonNote,
    model: { chosen, label: (WF.CANDIDATES.find((c) => c.id === chosen) || {}).label, track: 'P (projected availability)', record: { status: unsealed ? 'test window unsealed' : 'SELECTION ONLY (test window sealed)', selection: sel(chosen), elo_selection: sel('A_elo'), lab_selection: sel('lab_points') },
      record_file: 'nba/validation/nba_walkforward.json', live_params_generated_at: live.generated_at, calibration_seasons: live.calibration_seasons, spec_hash: live.record_spec_hash },
    value_claims: 'DISABLED', value_reason: 'No licensed archive of timestamped NBA closing prices exists here, so the model has never been compared with the market. Fair lines are research; an edge requires a market test.',
    license: C.LICENSE, settlement: 'Moneyline, spread, total and team totals include overtime; first half and first quarter are regulation periods only (a tied half pushes a two-way moneyline); whole-number lines can push and the fair price excludes the push.',
    rosters: rosters.source, ledger_appended: newLedger.length, games,
  };
  if (!o.dryRun) fs.writeFileSync(C.PATHS.slate, JSON.stringify(out) + '\n');
  return out;
}

/* ---------- started games: the research frozen before tip ---------- */
/**
 * The next nba/recent.json: every game the previous slate priced before its
 * tip that has started by `now`, as it was priced (frozen_at = when it was
 * priced, always before the start), plus the previous file's games still
 * inside C.RECENT_HOURS. A game back on the new slate with a later start (a
 * postponement) is dropped; for a game held twice the later pregame freeze
 * wins.
 */
function carryRecent(prevSlate, prevRecent, nextSlate, now, hours) {
  const win = (hours || C.RECENT_HOURS) * 3600e3;
  const ahead = new Set(((nextSlate && nextSlate.games) || []).filter((g) => !(Date.parse(g.start_utc) <= now)).map((g) => String(g.game_id)));
  const keep = new Map();
  const add = (g, frozenAt) => {
    const t = Date.parse(g && g.start_utc), f = Date.parse(frozenAt);
    if (!isFinite(t) || !isFinite(f) || t > now || now - t > win || !(f < t) || ahead.has(String(g.game_id))) return;
    const prev = keep.get(String(g.game_id));
    if (prev && Date.parse(prev.frozen_at) >= f) return;
    keep.set(String(g.game_id), Object.assign({}, g, { frozen_at: new Date(f).toISOString() }));
  };
  if (prevRecent && prevRecent.schema === C.SCHEMA.recent) (prevRecent.games || []).forEach((g) => add(g, g.frozen_at));
  if (prevSlate && prevSlate.schema === C.SCHEMA.slate) (prevSlate.games || []).forEach((g) => add(g, g.predicted_at || prevSlate.generated_at));
  const games = Array.from(keep.values()).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc) || String(a.game_id).localeCompare(String(b.game_id)));
  return {
    schema: C.SCHEMA.recent, sport: 'NBA', generated_at: new Date(now).toISOString(), window_hours: hours || C.RECENT_HOURS,
    note: 'Games that have started, each exactly as the slate priced it before tip (frozen_at). Nothing here is re-priced after the start. Research, not picks.',
    value_claims: 'DISABLED', value_reason: (nextSlate && nextSlate.value_reason) || (prevSlate && prevSlate.value_reason) || null,
    games,
  };
}
/** Write nba/recent.json only when its games changed (a build with nothing new adds no commit noise). */
function writeRecent(rec) {
  const old = readJson(C.PATHS.recent, null);
  const same = old && old.schema === rec.schema && JSON.stringify(old.games) === JSON.stringify(rec.games);
  if (!same) fs.writeFileSync(C.PATHS.recent, JSON.stringify(rec) + '\n');
  return !same;
}

function check() {
  const s = readJson(C.PATHS.slate, null); const fails = [];
  if (!s || s.schema !== C.SCHEMA.slate) fails.push('schema');
  else {
    if (s.value_claims !== 'DISABLED') fails.push('value claims must stay disabled');
    for (const g of s.games) {
      if (!g.price) { fails.push(g.game_id + ' has no price'); continue; }
      const m = g.price.moneyline; if (Math.abs(m.home + m.away - 1) > 1e-4) fails.push(g.game_id + ' moneyline does not sum to 1');
      const sp = g.price.spread.main; if (Math.abs(sp.win + sp.push + sp.lose - 1) > 1e-4) fails.push(g.game_id + ' spread outcomes do not sum to 1');
      if (g.market.value_claims !== 'DISABLED') fails.push(g.game_id + ' claims value');
      if (!g.decision || !Array.isArray(g.decision.gates) || (g.decision.decision !== 'PASS' && g.decision.gates.some((x) => !x.pass))) fails.push(g.game_id + ' decision does not follow its gates');
      if (g.decision && g.decision.decision !== 'PASS' && g.market.value_claims === 'DISABLED') fails.push(g.game_id + ' is not PASS while value claims are disabled');
      /* one distribution: the favourite on the moneyline is the favourite on the spread */
      if ((m.home - 0.5) * (-g.price.spread.fair_line_home) < -0.02) fails.push(g.game_id + ' moneyline and spread disagree on the favourite');
    }
  }
  /* started games: research frozen strictly before the start, never re-priced */
  const rec = readJson(C.PATHS.recent, null);
  if (rec) {
    if (rec.schema !== C.SCHEMA.recent || !Array.isArray(rec.games)) fails.push('recent.json is not ' + C.SCHEMA.recent);
    else rec.games.forEach((g) => { if (!(Date.parse(g.frozen_at) < Date.parse(g.start_utc))) fails.push('recent ' + g.game_id + ' frozen at or after its start'); if (!g.price) fails.push('recent ' + g.game_id + ' has no price'); });
  }
  if (fails.length) { console.error('[nba slate --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nba slate --check] ok: ' + s.games.length + ' games, ' + s.horizon);
}

module.exports = { build, check, carryRecent };
if (require.main === module) {
  if (flag('check')) check();
  else {
    /* read before build() writes the new slate: the previous slate is where started games are frozen from */
    const prevSlate = readJson(C.PATHS.slate, null), prevRecent = readJson(C.PATHS.recent, null);
    build({ hours: arg('hours', 72), now: arg('now', null), offline: flag('offline'), dryRun: flag('dry-run') }).then((s) => {
      let held = '';
      if (!flag('dry-run')) { const rec = carryRecent(prevSlate, prevRecent, s, Date.parse(s.generated_at)); writeRecent(rec); held = '; started games with frozen research ' + rec.games.length; }
      console.log('[nba slate] ' + s.games.length + ' games (' + s.horizon + '), ledger +' + s.ledger_appended + held);
    }).catch((e) => { console.error(e); process.exit(1); });
  }
}

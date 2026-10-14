'use strict';
/* ===========================================================================
   EdgeDesk college baseball — batch inference for every Division I game
   (Phases 12-13), and the files the research terminal reads.

     node college_baseball/build_slate.js                 the current season if it has
                                                          games, else a RETROSPECTIVE replay of the last one
     node college_baseball/build_slate.js --season 2026   replay a season
     node college_baseball/build_slate.js --check         validate the committed board

   SEPARATE STAGES, NO REDUNDANT TRAINING. Hyperparameters are tuned weekly
   (walkforward.js --tune); this script never tunes. It replays the team
   model day by day (the same deterministic fit the walk-forward scored),
   folds each date's results in only after pricing that date, and prices
   every game of the date from the state before it. Pitching state is
   incremental too. One season of ~8,800 games takes a few minutes.

   EVERY GAME IS LISTED. A game that cannot be priced (unidentified program,
   quarantined, canceled) appears with RESEARCH_BLOCKED and its reasons; a
   game whose inference throws is counted in index.json `failures` with the
   error — nothing is skipped silently.

   REPLAY IS NOT LIVE. A replayed season is labelled RETROSPECTIVE on every
   file: prices are what the model would have said before each game, from
   final (possibly revised) data. The result shown beside a replayed game is
   postgame information and is labelled so.

   Outputs (committed, read by lib/edgedesk_cbase_ui.js):
     board/index.json              mode, season, dates, counts, failures, latency, freshness
     board/<season>/<date>.json    every game of the date: research + prices + readiness
     board/<season>/ratings.json   conference-adjusted ratings, conferences, strength of schedule
     board/<season>/pitchers.json  starter and bullpen research
     board/research.json           validation, calibration, distribution, simulator, audit, registry
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const M = require('./lib/models');
const TQ = require('./lib/team_quality');
const D = require('./lib/distribution');
const SIM = require('./lib/simulator');
const PR = require('./lib/pricing');
const RD = require('./lib/readiness');
const PI = require('./lib/pitchers');
const RULES = require('./lib/rules');
const V = require('../engine/validation');
const K = require('./ingest/common');
const WF = require('./walkforward');
const PW = require('./pitcher_walkforward');
const REG = require('./lib/registry');
const { readCsv } = require('../engine/csv');

const BOARD = path.join(C.PATHS.BASE, 'board');
const r = (v, k) => (v == null || !isFinite(v) ? null : Math.round(v * Math.pow(10, k == null ? 3 : k)) / Math.pow(10, k == null ? 3 : k));
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.includes('--' + n); }
function readJson(f) { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }

function oosByGame() {
  const f = path.join(C.PATHS.validation, 'oos_team_predictions.csv.gz'); const m = new Map();
  if (!fs.existsSync(f)) return m;
  for (const x of readCsv(f).rows) m.set(x.game_id, x);
  return m;
}

function personNames(seasons) {
  const m = new Map(); for (const s of seasons) for (const p of W.pitchers(s)) if (p.person_id && p.name) m.set(p.person_id, p.name);
  return m;
}

function pmfArray(pmf, max) { const a = []; let tail = 0; for (let i = 0; i < pmf.length; i++) { if (i < max) a.push(r(pmf[i], 4)); else tail += pmf[i]; } a.push(r(tail, 4)); return a; }

/* ---------------------------------------------------------------- the board table's view of a game */
function summary(g) {
  const p = g.prices; const tot = p ? p.totals.find((t) => t.line === p.main_total_line) : null;
  const st = (side) => { const s2 = g.starters && g.starters[side]; if (!s2) return null; const c = s2.candidates[0]; return { name: c ? c.name : null, p: c ? c.p : null, status: s2.status }; };
  const team = (t) => ({ id: t.id, name: t.name, conf: t.conf, div: t.div, rank: t.rating ? t.rating.rank : null, record: t.rating ? t.rating.record : null });
  return { game_id: g.game_id, date: g.date, start_time_local: g.start_time_local, dh: g.dh, neutral: g.neutral, site: g.site, status: g.status, conf_game: g.conf_game,
    home: team(g.home), away: team(g.away), readiness: g.readiness ? { label: g.readiness.label, states: g.readiness.states } : null,
    ml: p ? { p_home: p.moneyline.p_home, fair_home: p.moneyline.fair_home, fair_away: p.moneyline.fair_away } : null,
    total: tot ? { line: tot.line, over: tot.over } : null, sd: g.model ? g.model.sd_delta : null, se: p && p.first_five ? p.simulator.se_f5_home : null,
    starters: g.starters ? { home: st('home'), away: st('away') } : null, result_postgame: g.result_postgame || null };
}

/* ---------------------------------------------------------------- explanations from numbers only */
function explain(x) {
  const s = [];
  const fav = x.p_home >= 0.5 ? x.home : x.away; const p = Math.max(x.p_home, 1 - x.p_home);
  s.push(`EdgeDesk's fair price makes ${fav} a ${Math.round(p * 100)}% favourite, from expected runs of ${x.lh.toFixed(1)} (${x.home}) and ${x.la.toFixed(1)} (${x.away}).`);
  if (x.rank_home && x.rank_away) s.push(`Opponent-adjusted ratings rank them ${x.rank_home} and ${x.rank_away} of ${x.d1n} Division I programs as of this date.`);
  if (x.sd > 0.25) s.push(`The rating gap is uncertain (posterior sd ${x.sd.toFixed(2)} on the log-run scale), which pulls the price toward a coin flip.`);
  if (x.conf_note) s.push(x.conf_note);
  if (x.starter_note) s.push(x.starter_note);
  if (x.pen_note) s.push(x.pen_note);
  if (x.park != null && Math.abs(x.park) >= 0.05) s.push(`The venue's shrunk park factor is ${x.park > 0 ? '+' : ''}${Math.round(x.park * 100)}% runs.`);
  if (x.neutral) s.push('Neutral site: no home-field advantage is credited.');
  if (x.dh) s.push(`Doubleheader game ${x.dh}: priced as a ${Math.round(x.p7 * 100)}% chance of a seven-inning game (measured share).`);
  return s;
}

/* ---------------------------------------------------------------- the season */
function build(season, o) {
  o = o || {};
  const t0 = Date.now();
  const cfgs = WF.cfgsFromTuning(); const tuning = WF.tuning();
  const constants = WF.constants(); const spec = tuning.dist || { family: 'nb', r: 4 }; const frailty = tuning.sim_frailty || {};
  const table = D.pHomeTable(spec, constants);
  const rules = readJson(path.join(C.PATHS.validation, 'rules_evidence.json'));
  const rrP = (g) => { const rr = rules ? rules.run_rule : {}; const k = g.ncaa_tourney_inferred ? 'ncaa_tourney' : (g.conf_game ? 'conf' : 'nonconf'); const e = rr[k] || rr.all; return e ? e.stopped / Math.max(1, e.eligible) : 0; };
  const p7c = WF.p7Context();
  const wf = readJson(C.PATHS.walkforward); const chosen = wf ? wf.selection.chosen : 'hier';
  const modelStatus = wf && wf.status ? wf.status.moneyline.status : 'NOT_ASSESSED_ON_HOLDOUT';
  const gates = readJson(C.PATHS.gates); const gateFails = gates ? gates.gates.filter((g) => g.status === 'FAIL').map((g) => g.id) : ['GATES_NOT_RUN'];
  const audit = readJson(C.PATHS.audit);
  const oos = oosByGame();
  /* THE PRICING MODEL (walkforward.json `pricing`) and every layer it needs for this season, each fitted on the
     three seasons before it exactly as in the walk-forward: run-space calibration, the rest layer, the logit
     maps of the ensemble's members, and the ensemble's SELECTION-fitted weights */
  const CAL = require('./lib/calibration'); const ENS = require('./lib/ensemble');
  /* the first five are priced by the simulator; whether they are more than research is decided by its calibration (sim_eval.js) */
  const simEval = readJson(C.PATHS.simEval); const f5Cal = simEval && simEval.first_five ? simEval.first_five.home_win : null;
  const construction = simEval && simEval.decision && simEval.decision.full_game_construction ? simEval.decision.full_game_construction : 'calibrated_expectations';
  const f5Status = simEval && simEval.decision && /PROVISIONAL/.test(simEval.decision.first_five_engine) ? { status: 'PROVISIONAL', reason: 'calibrated on VALIDATION; never tested against a market' }
    : { status: 'RESEARCH_ONLY', reason: f5Cal ? `the simulator's first-five probabilities are too extreme on VALIDATION (calibration slope ${f5Cal.slope}; tolerance 0.75-1.33)` : 'the simulator has not been evaluated on the first five innings' };
  const pricingModel = wf && wf.pricing ? wf.pricing.model : 'hier_cal';
  const prior = [...oos.values()].filter((x) => Number(x.season) >= season - 3 && Number(x.season) < season && x.hier_lh !== '');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const runCal = CAL.fit(prior.map((x) => ({ lh: num(x.hier_lh), la: num(x.hier_la), sd: num(x.hier_sd), y: num(x.y), neutral: num(x.neutral), p7: num(x.hier_p7) || 0 })), table, constants.seven_inning_factor);
  const restLayer = CAL.restFit(prior.map((x) => ({ lh: num(x.hier_lh), la: num(x.hier_la), home_runs: num(x.home_runs), away_runs: num(x.away_runs), home_yday: num(x.home_yday), away_yday: num(x.away_yday), dh2: num(x.dh2) })));
  const restCal = CAL.fit(prior.filter((x) => x.hier_rest_lh !== '' && x.hier_rest_lh != null).map((x) => ({ lh: num(x.hier_rest_lh), la: num(x.hier_rest_la), sd: num(x.hier_sd), y: num(x.y), neutral: num(x.neutral), p7: num(x.hier_p7) || 0 })), table, constants.seven_inning_factor);
  const logitMaps = {}; for (const n of ['elo', 'massey', 'pythag']) logitMaps[n] = WF.fitCalibration(prior.filter((x) => x['p_' + n] !== '').map((x) => ({ p: num(x['p_' + n]), y: num(x.y), neutral: num(x.neutral) })));
  const ensModel = wf && wf.pricing ? wf.pricing.ensemble : null;
  const meta = M.meta();
  const hierCfg = (cfgs.hier && cfgs.hier.tq) || {};
  const tq = new TQ.TeamQuality(Object.assign({}, hierCfg, { hier: true, parks: true }), meta);
  /* pitching */
  const pitchSeasons = []; for (let s = C.SEASONS.box[0]; s <= season; s++) pitchSeasons.push(s);
  const usePitching = season >= C.SEASONS.box[0];
  let ps = null; let pm = null; const names = personNames(pitchSeasons);
  if (usePitching) { pm = PW.fitModels(); ps = new PI.PitchingState().load(pitchSeasons); ps.lw = pm.lw; ps.avail = pm.avail.beta; ps.proj = { cand: pm.proj.cand, unseen: pm.proj.unseen }; }
  const starterOf = new Map(); for (const s of pitchSeasons) for (const p of W.pitchers(s)) if (p.starter && p.person_id) starterOf.set(p.game_id + '|' + p.team_id, p.person_id);
  /* the team model and the ensemble's member models through the seasons before (no tuning: the tuned
     configurations are read, the fits are the same deterministic passes the walk-forward scored) */
  const members = pricingModel === 'ens' ? { elo: M.make('elo', cfgs.elo, { meta }), massey: M.make('massey', cfgs.massey, { meta }), pythag: M.make('pythag', cfgs.pythag, { meta }) } : {};
  const hist = W.results(C.SEASONS.first, season - 1);
  let cur = null; let i = 0;
  while (i < hist.length) {
    const date = hist[i].date; let j = i; while (j < hist.length && hist[j].date === date) j++; const day = hist.slice(i, j);
    if (day[0].season !== cur) { tq.startSeason(day[0].season); for (const m of Object.values(members)) m.startSeason(day[0].season); cur = day[0].season; }
    const dayNum = Date.parse(date + 'T00:00:00Z') / 864e5 + 1;
    tq.addGames(day); tq.fit(dayNum); for (const m of Object.values(members)) { m.addGames(day); m.fit(dayNum); }
    i = j;
  }
  tq.startSeason(season); for (const m of Object.values(members)) m.startSeason(season);
  /* the season, date by date */
  const all = W.games(season).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dates = [...new Set(all.map((g) => g.date))].sort();
  const d1 = W.teamSeasons().filter((t) => t.season === season && t.division === 1);
  const rec = new Map(); const recOf = (id) => { if (!rec.has(id)) rec.set(id, { w: 0, l: 0, rs: 0, ra: 0, last: null, opp: [] }); return rec.get(id); };
  const failures = []; const latency = []; const outDir = path.join(BOARD, String(season));
  let coherenceFailures = 0; const counts = { games: 0, priced: 0, blocked: 0, provisional: 0, not_priced: 0 };
  const dateIndex = [];
  for (const date of dates) {
    const games = all.filter((g) => g.date === date);
    if (ps) ps.advance(date);
    /* D-I ranks as of the date */
    const ratings = d1.map((t) => Object.assign({ name: t.name }, tq.rating(t.team_id))).sort((a, b) => b.net - a.net);
    const rank = new Map(ratings.map((x, k) => [x.team_id, k + 1]));
    const out = [];
    for (const g of games) {
      const tg = Date.now(); counts.games++;
      const item = { game_id: g.game_id, date: g.date, start_time_local: g.start_time_local, dh: g.dh, neutral: g.neutral, site: g.site || null, status: g.status, quality: g.quality,
        home: { id: g.home_id, name: g.home_name, conf: g.home_conf, div: g.home_div }, away: { id: g.away_id, name: g.away_name, conf: g.away_conf, div: g.away_div }, conf_game: g.conf_game };
      try {
        let ctx = { model_status: modelStatus, release_gate_failures: gateFails, market_reason: 'no authorised college-baseball sportsbook feed: the EdgeDesk odds gateway does not carry baseball_ncaa' };
        if (g.home_id && g.away_id && g.quality !== 'CONFLICT' && g.status !== 'CANCELED' && g.status !== 'POSTPONED') {
          const pr = tq.predict(g);
          const rh = tq.rating(g.home_id); const ra = tq.rating(g.away_id);
          const recH = recOf(g.home_id); const recA = recOf(g.away_id);
          item.home.rating = { net: r(rh.net), off: r(rh.off), def: r(rh.def), sd: r(rh.sd_net), conf_net: r(rh.conf_net), rank: rank.get(g.home_id) || null, record: `${recH.w}-${recH.l}`, rs: recH.rs, ra: recH.ra };
          item.away.rating = { net: r(ra.net), off: r(ra.off), def: r(ra.def), sd: r(ra.sd_net), conf_net: r(ra.conf_net), rank: rank.get(g.away_id) || null, record: `${recA.w}-${recA.l}`, rs: recA.rs, ra: recA.ra };
          const p7 = p7c.fn(g);
          const flags = { home_yday: recOf(g.home_id).last === K.addDays(date, -1) ? 1 : 0, away_yday: recOf(g.away_id).last === K.addDays(date, -1) ? 1 : 0, dh2: g.dh === 2 ? 1 : 0 };
          let lh; let la; let pEns = null; let ensShift = null;
          let lhLevel = pr.lh; let laLevel = pr.la;
          if (pricingModel === 'hier_rest_cal') { const [rh0, ra0] = CAL.restApply(pr.lh, pr.la, flags, restLayer); lhLevel = rh0; laLevel = ra0; [lh, la] = CAL.apply(rh0, ra0, restCal, g.neutral); }
          else [lh, la] = CAL.apply(pr.lh, pr.la, runCal, g.neutral);
          const lhBase = lh; const laBase = la;     // later factors (ensemble shift, pitchers) are carried to the level-unbiased expectations as ratios
          if (pricingModel === 'ens') {
            /* the ensemble's probability, then the runs shifted along their ratio until they agree with it */
            const pp = { hier_cal: CAL.pOf({ lh: pr.lh, la: pr.la, sd: pr.sd_delta, neutral: g.neutral, p7 }, runCal, table, constants.seven_inning_factor) };
            for (const [n, m] of Object.entries(members)) pp[n + '_cal'] = WF.applyCalibration(logitMaps[n], m.predict(g).p, g.neutral);
            pEns = ENS.predict(ensModel, pp);
            if (pEns != null) { const sh = ENS.coherentRuns(lh, la, pr.sd_delta, pEns, table); lh = sh[0]; la = sh[1]; ensShift = sh[2]; }
          }
          const pTeam = TQ.integrate(lh, la, pr.sd_delta, table);
          /* pitching */
          let H = null; let A = null; let starters = null; let scenarioTable = null; let homeStaff = {}; let awayStaff = {};
          if (ps && (g.season >= C.SEASONS.box[0])) {
            H = PW.staffToday(ps, g.home_id, season, g, starterOf.get(g.game_id + '|' + g.home_id));
            A = PW.staffToday(ps, g.away_id, season, g, starterOf.get(g.game_id + '|' + g.away_id));
            const side = (S2, id) => ({ status: S2.proj.status, top_p: r(S2.proj.top_p), p_unseen: r(S2.proj.p_unseen),
              candidates: S2.scenarios.filter((x) => x.person).map((x) => { const t = ps.talent(x.person, season); return { name: names.get(x.person) || x.person, p: r(x.p), k_rate: r(t.rate.so), bb_rate: r(t.rate.bb), hr_rate: r(t.rate.hr, 4), rv_per_bf: r(t.rv_per_bf, 4), exp_outs: r(t.exp_outs_start, 1), reliability: r(t.reliability, 2), starts: t.starts }; }),
              actual_postgame: g.status === 'FINAL' ? (names.get(starterOf.get(g.game_id + '|' + id)) || null) : null });
            starters = { home: side(H, g.home_id), away: side(A, g.away_id) };
            const pen = (S2) => ({ rv_available: r(S2.pen.rv_available, 4), rv_normal: r(S2.pen.rv_normal, 4), depletion: r(S2.pen.depletion), bf_last3: S2.pen.bf_last3 || 0, pitches_last3_est: Math.round((S2.pen.bf_last3 || 0) * PI.PITCHES_PER_BF), pitches_last3_sd: Math.round(Math.sqrt(S2.pen.bf_last3 || 0) * PI.PITCHES_SD_PER_PA + (S2.pen.bf_last3 || 0) * 0.35),
              relievers: (S2.pen.relievers || []).slice(0, 4).map((x) => ({ name: names.get(x.person) || x.person, usage: r(x.usage_share), p_available: r(x.p_available), rv_per_bf: r(x.rv_per_bf, 4), bf_last3: x.bf3, pitches_last3_est: x.pitches3_est, pitches_last3_sd: x.pitches3_sd })) });
            item.bullpen = { home: pen(H), away: pen(A) };
            /* scenario table: P(home) for the top starters on each side (closed form, the scenario's staff factor) */
            const beta = pm.beta;
            const hs = H.scenarios.slice(0, 3); const as = A.scenarios.slice(0, 3);
            scenarioTable = [];
            for (const h of hs) for (const a of as) {
              const la2 = la * PW.staffFactor(h, H, beta.starter, true, true, 9); const lh2 = lh * PW.staffFactor(a, A, beta.starter, true, true, 9);
              scenarioTable.push({ home_starter: h.person ? names.get(h.person) || h.person : 'another starter', away_starter: a.person ? names.get(a.person) || a.person : 'another starter', p: r(h.p * a.p), p_home: r(TQ.integrate(lh2, la2, pr.sd_delta, table)) });
            }
            if (pm.accepted) {
              /* the pitcher-aware price: scenario-weighted run expectations */
              let wlh = 0; let wla = 0; let w = 0;
              for (const h of H.scenarios) for (const a of A.scenarios) { const ww = h.p * a.p; wla += ww * la * PW.staffFactor(h, H, beta.starter, true, true, 9); wlh += ww * lh * PW.staffFactor(a, A, beta.starter, true, true, 9); w += ww; }
              lh = wlh / w; la = wla / w;
            }
            const st = (S2) => { const top = S2.scenarios[0]; return { starter_outs: top && top.outs != null ? top.outs : 12.5, starter_outs_sd: 5.7 }; };
            homeStaff = st(H); awayStaff = st(A);
          }
          /* every full-game market from the closed form's mixture (rating uncertainty x scheduled length): its
             P(home) is the validated probability; the simulator, fed the run model's own (level-unbiased)
             expectations, prices only the first five innings (lib/simulator.js, validation/simulator.json) */
          const cfCal = D.closedForm(lh, la, pr.sd_delta, p7, spec, constants);
          /* the construction the pricing study chose (sim_eval.js, CBX-PRICE-CONSTRUCTION): the run model's own
             expectations (level-unbiased; the rest layer and the pitcher factors applied as in the price),
             re-weighted so P(home) is the validated probability */
          const cf = construction === 'reweighted_raw' ? D.closedForm(lhLevel * (lh / lhBase), laLevel * (la / laBase), pr.sd_delta, p7, spec, constants, { p_home_target: cfCal.p_home }) : cfCal;
          const sim = SIM.simulate({ lh: pr.lh, la: pr.la, sd: pr.sd_delta, p7, run_rule_p: rrP(g), frailty, home_staff: homeStaff, away_staff: awayStaff }, constants, { n: o.sims || 4000, seed: 1 + counts.games });
          const dist = PR.fromClosedForm(cf); const prices = PR.price(dist, { f5: sim.f5_joint });
          /* the board keeps the useful part of each ladder (the full ladders are one call away in lib/pricing.js) */
          prices.run_lines = prices.run_lines.filter((l) => [-1.5, 1.5, -2.5, 2.5, -1, 1].includes(l.home_line));
          prices.totals = prices.totals.filter((t) => Math.abs(t.line - prices.main_total_line) <= 3);
          for (const sd of ['home', 'away']) { const tt = prices.team_totals[sd]; const mid = tt[Math.floor(tt.length / 2)].line; prices.team_totals[sd] = tt.filter((t) => Math.abs(t.line - mid) <= 1); }
          const coh = PR.coherence(prices); if (!coh.ok) coherenceFailures++;
          const o2 = oos.get(g.game_id);
          const disagreement = o2 ? Object.fromEntries(['hier', 'hier_cal', 'poisson_flat', 'massey', 'bt', 'elo', 'pythag', 'home_rate'].map((k) => [k, o2['p_' + k] === '' || o2['p_' + k] == null ? null : r(Number(o2['p_' + k]))])) : null;
          const pChosen = o2 && o2['p_' + chosen] !== '' && o2['p_' + chosen] != null ? Number(o2['p_' + chosen]) : null;
          item.model = { version: C.MODEL_VERSION, team_model: 'hier', chosen, pricing: pricingModel, p_ensemble: pEns == null ? null : r(pEns), ensemble_shift: ensShift == null ? null : r(ensShift, 4), rest_flags: flags, pitcher_adjusted: !!(pm && pm.accepted), lh_raw: r(pr.lh, 2), la_raw: r(pr.la, 2), lh: r(lh, 2), la: r(la, 2), sd_delta: r(pr.sd_delta), p_home_team: r(pTeam), p_home_chosen_oos: pChosen == null ? null : r(pChosen), park: r(pr.park), home_adv: r(pr.home_adv), p7: r(p7), disagreement };
          item.starters = starters; item.scenarios = scenarioTable;
          const f5h = prices.first_five ? prices.first_five.three_way.home : null;
          if (prices.first_five) Object.assign(prices.first_five, f5Status);
          item.prices = Object.assign(prices, { engine: { full_game: 'closed form (negative binomial mixture over rating uncertainty and scheduled length)', first_five: 'inning simulator' },
            simulator: { n: sim.n, se_f5_home: f5h == null ? null : r(Math.sqrt(f5h * (1 - f5h) / sim.n), 4), p_home_simulated: r(sim.p_home, 4), walkoff_share: r(sim.walkoff_share), run_rule_share: r(sim.run_rule_share), seven_share: r(sim.seven_share), starter_outs_home: r(sim.starter_outs_home, 1), starter_outs_away: r(sim.starter_outs_away, 1) } });
          item.distribution = { total: pmfArray(dist.total, 26), margin_min: -12, margin: (() => { const a = []; for (let m = -12; m <= 12; m++) a.push(r(dist.margin[m + dist.marginOffset], 4)); return a; })(), innings: sim.innings.map((v) => r(v, 4)).slice(5, 16) };
          item.environment = { park_factor: r(pr.park), home_advantage: r(pr.home_adv), neutral: g.neutral, rest_home: recH.last ? K.daysBetween(recH.last, date) : null, rest_away: recA.last ? K.daysBetween(recA.last, date) : null, weather: 'UNAVAILABLE: no authorised archive of forecasts as of prediction time', altitude: 'not modelled separately; inside the park factor' };
          item.market = { status: 'MARKET_UNAVAILABLE', reason: ctx.market_reason, ev: null };
          const confNote = g.conf_game ? null : (g.home_conf && g.away_conf ? `Non-conference game: ${g.home_conf} (${r(rh.conf_net, 2)}) vs ${g.away_conf} (${r(ra.conf_net, 2)}) conference strength.` : null);
          const sNote = starters ? `Projected starters: ${starters.home.candidates[0] ? starters.home.candidates[0].name + ' (' + Math.round(starters.home.candidates[0].p * 100) + '%)' : 'unknown'} for ${g.home_name}, ${starters.away.candidates[0] ? starters.away.candidates[0].name + ' (' + Math.round(starters.away.candidates[0].p * 100) + '%)' : 'unknown'} for ${g.away_name}; ${pm && pm.accepted ? 'the price is weighted across these scenarios' : 'the pitcher adjustment did not pass validation, so it is shown as research and not in the price'}.` : null;
          const penNote = item.bullpen && ((item.bullpen.home.depletion || 0) > 0.25 || (item.bullpen.away.depletion || 0) > 0.25) ? `Bullpen depletion: ${g.home_name} ${Math.round((item.bullpen.home.depletion || 0) * 100)}%, ${g.away_name} ${Math.round((item.bullpen.away.depletion || 0) * 100)}% of usual relief availability used up recently.` : null;
          item.explanation = explain({ p_home: prices.moneyline.p_home, home: g.home_name, away: g.away_name, lh, la, rank_home: rank.get(g.home_id), rank_away: rank.get(g.away_id), d1n: d1.length, sd: pr.sd_delta, conf_note: confNote, starter_note: sNote, pen_note: penNote, park: pr.park, neutral: g.neutral, dh: g.dh, p7 });
          ctx = Object.assign(ctx, { team: { info_min: Math.min(pr.info_home, pr.info_away), sd_delta: pr.sd_delta, has_prior: true }, model_ok: true, price: prices, coherence: coh, mc_se: item.prices.simulator.se_f5_home,
            starters: starters ? { home: starters.home.status, away: starters.away.status } : { home: 'NO_PITCHING_DATA', away: 'NO_PITCHING_DATA' } });
        }
        item.readiness = RD.assess(g, ctx);
        if (g.status === 'FINAL') item.result_postgame = { home_runs: g.home_runs, away_runs: g.away_runs, innings: g.innings_played, label: 'POSTGAME: not known when the price was made' };
        const st = item.readiness.states;
        if (st.RESEARCH_BLOCKED) counts.blocked++; else if (!st.PRICE_GENERATED) counts.not_priced++; else { counts.priced++; if (st.PROVISIONAL) counts.provisional++; }
      } catch (e) {
        failures.push({ game_id: g.game_id, date, error: String(e && e.message || e) });
        item.readiness = { states: { RESEARCH_BLOCKED: true }, reasons: { RESEARCH_BLOCKED: ['inference failed: ' + String(e && e.message || e)] }, label: 'INFERENCE FAILED' };
      }
      latency.push(Date.now() - tg);
      out.push(item);
    }
    /* fold the date's results in, after pricing it */
    const usable = games.filter((g) => W.usable(g));
    for (const g of usable) {
      const h = recOf(g.home_id); const a = recOf(g.away_id);
      h.rs += g.home_runs; h.ra += g.away_runs; a.rs += g.away_runs; a.ra += g.home_runs;
      if (g.home_runs > g.away_runs) { h.w++; a.l++; } else { a.w++; h.l++; }
      h.last = date; a.last = date; h.opp.push(g.away_id); a.opp.push(g.home_id);
    }
    const dn = Date.parse(date + 'T00:00:00Z') / 864e5 + 1;
    tq.addGames(usable); tq.fit(dn); for (const m of Object.values(members)) { m.addGames(usable); m.fit(dn); }
    /* two files per date: a compact summary for the board table, and the full research for every game,
       gzipped (the terminal decompresses it in the browser). Minified: the files are data, not prose. */
    const head = { season, date, mode: o.mode, point_in_time: o.mode === 'LIVE' ? 'PREGAME' : 'RETROSPECTIVE', model_version: C.MODEL_VERSION };
    K.writeIfChanged(path.join(outDir, date + '.json'), JSON.stringify(Object.assign({ schema: 'edgedesk_cbase_board_day_v2' }, head, { games: out.map(summary) })) + '\n');
    K.writeIfChanged(path.join(outDir, 'detail', date + '.json.gz'), JSON.stringify(Object.assign({ schema: 'edgedesk_cbase_board_detail_v1' }, head, { games: out })) + '\n');
    dateIndex.push({ date, games: out.length, priced: out.filter((x) => x.readiness && x.readiness.states.PRICE_GENERATED).length });
  }
  /* season ratings, conferences, strength of schedule (as of the last date) */
  const final = d1.map((t) => { const rt = tq.rating(t.team_id); const rc = recOf(t.team_id); const sos = rc.opp.length ? rc.opp.reduce((a, id) => a + tq.rating(id).net, 0) / rc.opp.length : null; return { team_id: t.team_id, name: t.name, conf: t.conference, net: r(rt.net), off: r(rt.off), def: r(rt.def), sd: r(rt.sd_net), sd_conf: r(rt.sd_conf), conf_net: r(rt.conf_net), record: `${rc.w}-${rc.l}`, rs: rc.rs, ra: rc.ra, games: rc.w + rc.l, sos: r(sos) }; }).sort((a, b) => b.net - a.net).map((x, k) => Object.assign({ rank: k + 1 }, x));
  const confs = new Map(); for (const t of final) { if (!confs.has(t.conf)) confs.set(t.conf, []); confs.get(t.conf).push(t); }
  const confTable = [...confs.entries()].map(([c, ts]) => ({ conf: c, teams: ts.length, conf_net: ts[0].conf_net, sd: ts[0].sd_conf, mean_team_net: r(ts.reduce((a, x) => a + x.net, 0) / ts.length), best: ts[0].name })).sort((a, b) => b.conf_net - a.conf_net);
  K.writeJson(path.join(outDir, 'ratings.json'), { schema: 'edgedesk_cbase_ratings_v1', season, as_of: dates[dates.length - 1], model: 'hier (team ⊂ conference ⊂ division, parks)', scale: 'log runs: net = offence + defence (defence lowers runs allowed); +0.10 is about 10% more runs scored than allowed vs an average opponent', teams: final, conferences: confTable });
  if (ps) {
    const starters = []; const seen = new Set();
    for (const p of W.pitchers(season)) { if (!p.starter || !p.person_id || seen.has(p.person_id)) continue; seen.add(p.person_id); const t = ps.talent(p.person_id, season); if (t.bf_weighted < 100) continue; starters.push({ name: names.get(p.person_id), team_id: p.team_id, starts: t.starts, k_rate: r(t.rate.so), bb_rate: r(t.rate.bb), hr_rate: r(t.rate.hr, 4), rv_per_bf: r(t.rv_per_bf, 4), exp_outs: r(t.exp_outs_start, 1), reliability: r(t.reliability, 2) }); }
    starters.sort((a, b) => a.rv_per_bf - b.rv_per_bf);
    K.writeJson(path.join(outDir, 'pitchers.json'), { schema: 'edgedesk_cbase_pitchers_v1', season, method: 'shrunk components per batter faced (K 63, BB 53, HBP 113, HR 334, H 195 BF of prior), college pitching linear weights fitted on 2024', pitching_linear_weights: pm.lw, starters: starters.slice(0, 150), elasticity: pm.beta, pitcher_adjustment_in_price: pm.accepted });
  }
  const lat = latency.slice().sort((a, b) => a - b);
  return { season, dates: dateIndex, counts, failures, coherence_failures: coherenceFailures, construction, latency_ms: { p50: lat[Math.floor(lat.length / 2)] || 0, p95: lat[Math.floor(lat.length * 0.95)] || 0, total_s: Math.round((Date.now() - t0) / 1000) }, audit_summary: audit ? audit.summary : null };
}

/* ---------------------------------------------------------------- research.json for the advanced view */
function research() {
  const wf = readJson(C.PATHS.walkforward); const pw = readJson(C.PATHS.pitcherEval); const dist = readJson(C.PATHS.distEval); const sim = readJson(C.PATHS.simEval);
  const ml = readJson(path.join(C.PATHS.validation, 'ml_ensemble.json')); const fr = readJson(path.join(C.PATHS.validation, 'feature_research.json'));
  const abl = readJson(path.join(C.PATHS.validation, 'ablations.json')); const cov = readJson(C.PATHS.coverage); const audit = readJson(C.PATHS.audit); const gates = readJson(C.PATHS.gates);
  const reg = REG.latest().map((x) => ({ id: x.id, title: x.title, decision: x.decision, revision: x.revision, created_at: x.created_at, holdout: !!x.holdout_evaluated, metrics: x.metrics }));
  return { schema: 'edgedesk_cbase_research_v1', model_version: C.MODEL_VERSION,
    walkforward: wf && { chosen: wf.selection.chosen, best_baseline: wf.selection.best_baseline, selection: wf.selection.log_loss, windows: Object.fromEntries(Object.entries(wf.windows_report).map(([k, v]) => [k, v.withheld ? v : { n: v.n, seasons: v.seasons, models: Object.fromEntries(Object.entries(v.models).map(([m, x]) => [m, { log_loss: x.log_loss, brier: x.brier, citl: x.calibration_in_the_large, slope: x.calibration_slope }])), bins: v.models[wf.selection.chosen].bins, slices: v.chosen_slices }])), comparisons: wf.comparisons, status: wf.status || null, leakage: wf.leakage },
    pitcher: pw && { selection: pw.selection, windows: Object.fromEntries(Object.entries(pw.windows_report).map(([k, v]) => [k, { n: v.n, models: v.models, comparisons: v.comparisons, by_day: v.by_day }])), starter_projection: pw.starter_projection, fitted: pw.fitted_on_fit_season, availability_calibration: pw.availability_calibration },
    distribution: dist && { chosen: dist.chosen, spec: dist.chosen_spec, dispersion: dist.dispersion, scores: dist.scores, findings: dist.findings }, simulator: sim, ml: ml && { decisions: ml.decisions, validation: ml.windows.VALIDATION, ensemble: ml.ensemble, gbm_importance: ml.gbm.split_importance }, features: fr && fr.hypotheses, linear_weights: fr && fr.linear_weights_2024, ablations: abl,
    coverage: cov && { totals: cov.totals, seasons: cov.seasons.map((s) => ({ season: s.season, scheduled: s.scheduled, final: s.final_results, quarantined: s.quarantined, box: s.with_basic_box, pbp: s.with_play_by_play, starters: s.with_starting_pitchers, eligible: s.eligible_for_rating })) },
    audit: audit && { summary: audit.summary, checks: audit.checks.map((c) => ({ id: c.id, status: c.status, critical: c.critical, threshold: c.threshold })) }, gates: gates && { summary: gates.summary, gates: gates.gates.map((g) => ({ id: g.id, name: g.name, status: g.status, why: g.why })) },
    registry: reg };
}

function check() {
  const idx = readJson(path.join(BOARD, 'index.json')); const errs = [];
  if (!idx) errs.push('no board index');
  else {
    if (idx.value_claims !== 'DISABLED') errs.push('value claims must be DISABLED');
    for (const d of idx.dates.slice(-5)) {
      const day = readJson(path.join(BOARD, String(idx.season), d.date + '.json'));
      const df = path.join(BOARD, String(idx.season), 'detail', d.date + '.json.gz');
      const det = fs.existsSync(df) ? JSON.parse(require('zlib').gunzipSync(fs.readFileSync(df)).toString('utf8')) : null;
      if (!day || !det) { errs.push('missing ' + d.date); continue; }
      if (day.games.length !== det.games.length) errs.push(d.date + ': summary and detail list different games');
      for (const g of det.games) {
        if (!g.readiness || !g.readiness.states) errs.push(g.game_id + ' has no readiness');
        if (g.market && g.market.ev != null) errs.push(g.game_id + ' claims an EV without a market');
        if (g.prices) { const p = g.prices.moneyline.p_home; if (!(p > 0 && p < 1)) errs.push(g.game_id + ' p_home out of (0,1)'); if (!PR.coherence(g.prices).ok) errs.push(g.game_id + ' incoherent prices'); }
      }
    }
  }
  if (errs.length) { console.error('board check FAILED:\n  ' + errs.slice(0, 20).join('\n  ')); process.exit(1); }
  console.log('board check ok: ' + idx.season + ', ' + idx.dates.length + ' dates');
}

function main() {
  if (flag('check')) return check();
  /* the advanced view's research.json alone: re-run after audit.js and release_gates.js */
  if (flag('research')) { K.writeJson(path.join(BOARD, 'research.json'), research()); console.log('research.json rebuilt'); return; }
  const now = new Date();
  const cur = C.currentSeason(now);
  const curGames = W.games(cur).filter((g) => g.status !== 'FINAL' && g.date >= now.toISOString().slice(0, 10));
  let season = Number(arg('season', 0)); let mode;
  if (!season) { if (curGames.length) { season = cur; mode = 'LIVE'; } else { season = Math.min(cur, C.SEASONS.last); if (!W.games(season).length) season--; mode = 'REPLAY'; } } else mode = season === cur && curGames.length ? 'LIVE' : 'REPLAY';
  const res = build(season, { mode, sims: Number(arg('sims', 4000)) });
  const idx = { schema: 'edgedesk_cbase_board_index_v1', generated_at: now.toISOString(), mode, season, point_in_time: mode === 'LIVE' ? 'PREGAME' : 'RETROSPECTIVE',
    mode_note: mode === 'LIVE' ? 'Upcoming games priced before first pitch.' : `No upcoming Division I games are published by the source (the ${cur} schedule is not out). This is a RETROSPECTIVE replay of ${season}: each price is what the model would have said before the game, from final data; results are shown as postgame information.`,
    model_version: C.MODEL_VERSION, value_claims: 'DISABLED', value_reason: 'no authorised college-baseball market feed; release gates not passed',
    counts: res.counts, failures: res.failures, coherence_failures: res.coherence_failures, sims: Number(arg('sims', 4000)), pricing_engine: { full_game: 'closed form', first_five: 'simulator', construction: res.construction }, latency_ms: res.latency_ms, dates: res.dates,
    freshness: { warehouse_built: (W.report(season) || {}).built_at || null, source: C.SOURCE.name } };
  K.writeJson(path.join(BOARD, 'index.json'), idx);
  K.writeJson(path.join(BOARD, 'research.json'), research());
  console.log(`board ${mode} ${season}: ${res.counts.games} games, ${res.counts.priced} priced (${res.counts.provisional} provisional), ${res.counts.blocked} blocked, ${res.failures.length} failures, ${res.coherence_failures} incoherent, ${res.latency_ms.total_s}s`);
}

if (require.main === module) main();
module.exports = { build, research };

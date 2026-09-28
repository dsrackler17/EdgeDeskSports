#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — LIVE VALIDATION BUILD.

   Reads what already exists and writes what the Model Lab, the app and the
   weekly report read. Trains nothing, re-prices nothing, re-labels nothing.

     reads   football/cfb_lab/ledger/<season>/…          the append-only Lab ledger
             football/cfb_validation/champion.json        the frozen champion
             football/cfb_validation/versions.jsonl       the version log
             football/cfb_validation/next100_plan.json    the frozen prospective plan
             football/cfb_validation/divergence_backtest.json
             football/rating/current.json                 CURRENT FBS POWER RATING
             football/cfb_p4/engine.js + params.js        PRODUCTION PRICING STATE
                                                          (replayed exactly as the board does)
             football/cfb_terminal/{board,games}.json     the canonical research statuses
             football/cfb_terminal/history/<season>/snapshots.jsonl
             football/validation/disagreement/forensics_cfb.json

     writes  football/cfb_validation/live.json           the dashboard: north star, the
                                                          separated views, triggers, next 100
             football/cfb_validation/divergence.json     the 138-team rating-state monitor
             football/cfb_validation/maturity.json       the model maturity page
             football/cfb_validation/signals.json        verified / investigate / flip scorecards
             football/cfb_validation/postmortems.json    loss, win and miss postmortems
             football/cfb_validation/slate_audit.json    the current slate's status audit
             football/cfb_validation/changes.json        what changed, per game and system-wide
             football/cfb_validation/weekly/<season>-wNN.{json,md}   written ONCE per week
     appends football/cfb_validation/backlog.jsonl        research candidates (never implemented)
             football/cfb_validation/versions.jsonl       auto-detected PATCH rows
             football/cfb_validation/system_history.jsonl the system state, once per change

     node football/cfb_validation/build.js                build and write
     node football/cfb_validation/build.js --check        build, print, write nothing
     node football/cfb_validation/build.js --offline      use the cached schedule feed only
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const Canon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
const G = require(path.join(ROOT, 'football', 'cfb_lab', 'ledger.js'));
const REPORT = require(path.join(ROOT, 'football', 'cfb_lab', 'report.js'));
const DISLAB = require(path.join(ROOT, 'football', 'cfb_lab', 'disagreement.js'));
const V = require(path.join(HERE, 'core.js'));
const F = require(path.join(HERE, 'freeze.js'));
const P = global.EDCfbP4Params;

const args = process.argv.slice(2);
const flag = (k) => args.indexOf('--' + k) >= 0;
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const readJson = (rel, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) { return d === undefined ? null : d; } };
const num = V.util.num, r = V.util.r, mean = V.util.mean, ms = V.util.ms;

/* ------------------------------------------ the production pricing state */
async function pricingState(season, offline) {
  const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
  const rowsBySeason = {};
  for (let y = P.trained_through_season + 1; y <= season; y++) {
    const t = await BC.loadSeason(y, offline);
    if (t) rowsBySeason[y] = BC.normRows(BC.parseCsv(t));
  }
  const eff = readJson('football/rankings/engine_efficiency.json', null);
  const sb = BC.buildState(rowsBySeason, season, eff && +eff.season === +season ? eff : null);
  return { st: sb.st, absorbed: sb.absorbed, source: 'football/cfb_p4 engine replay (football/fbs/build_coverage.js buildState): trained seeds through ' + P.trained_through_season + ', ' + sb.absorbed + ' completed games absorbed' };
}

function monitor(state, etsr, season) {
  const teams = (etsr.teams || []).map((t) => {
    const k = E.normKey(t.team);
    const b = state ? E.strength.blendedRating(state.st, k, true, null) : null;
    const gp = b && num(b.games_played) != null ? b.games_played : null;
    return { key: t.canonical_key || t.key, team: t.team, conference: t.conference || null, current: num(t.rating), etsr: t,
      state: b && num(b.value) != null ? b.value : null,
      state_detail: b ? { value: b.value, carried: b.carried, this_season: b.this_season, prior_weight: b.prior_weight, games_played: gp, seeded: Object.prototype.hasOwnProperty.call(P.rating.seed_ratings, k) } : {} };
  });
  const m = V.divergenceMonitor(teams, Canon, { expected_fbs: teams.length, state_source: state ? state.source : null, current_source: 'football/rating/current.json (' + (etsr.generated_at || '') + ', week ' + etsr.week + ')' });
  m.season = season;
  m.unseeded = teams.filter((t) => t.state_detail && t.state_detail.seeded === false).map((t) => ({ team: t.team, note: 'no trained seed: its pricing state comes only from ' + (t.state_detail.games_played || 0) + ' absorbed game(s) this season' }));
  return m;
}

/* ------------------------------------------------------- maturity page */
function maturity(D, freeze, Vw, backtest, now) {
  const champ = freeze.champion.model_version;
  const liveBy = {};
  (D.preds || []).forEach((p) => { if (p.origin === 'LIVE') liveBy[p.model_version] = (liveBy[p.model_version] || 0) + 1; });
  const cur = Vw.find((v) => v.id === 'SINCE_UPGRADE');
  const settledCur = D.evals.filter((e) => e.model_version === champ && e.origin === 'LIVE' && e.checkpoint_type === 'T24' && e.result_status === 'FINAL' && !e.void && V.epochOf(e, freeze, []) === 'CURRENT');
  const ref = (readJson('football/cfb_lab/config.json', {}).reference || {})[champ];
  const refMae = ref && num(ref.mae);
  const ci = (() => {
    if (settledCur.length < 30 || refMae == null) return null;
    const xs = settledCur.map((e) => e.abs_margin_error - (refMae + 0.25));
    let s = 7 >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = []; for (let b = 0; b < 2000; b++) { let a = 0; for (let i = 0; i < xs.length; i++) a += xs[(rnd() * xs.length) | 0]; out.push(a / xs.length); }
    out.sort((a, b) => a - b); return [r(out[50], 3), r(out[1949], 3)];
  })();
  const rows = Canon.MODULES.map((m) => {
    const live = m.id === 'cfb_v1' ? (liveBy[champ] || 0) : (m.id === 'cfb_v2' ? (liveBy['edgedesk_cfb_v2.1.0'] || 0) : null);
    let badges = [];
    if (m.id === 'cfb_v1') badges = Canon.validationBadges({ tracked_live_n: live, settled_live_n: cur.football_model.n, mae_diff_ci: ci, ece: cur.football_model.calibration_error,
      cov80: cur.football_model.interval_coverage.p80, makes_price_claims: true, clv_n: cur.betting_decisions.qualified_wagers.clv_n || 0, clv_ci: null });
    else if (m.id === 'cfb_v2') badges = Canon.validationBadges({ tracked_live_n: live, settled_live_n: 0 });
    const wf = badges.find((b) => b.key === 'WALK_FORWARD_VALIDATED'), tr = badges.find((b) => b.key === 'WALK_FORWARD_TRACKED');
    const clv = badges.find((b) => b.key === 'CLV_PENDING' || b.key === 'CLV_VALIDATED');
    return { id: m.id, model: m.name, sport: m.sport, version: m.version, status: m.maturity, status_label: Canon.MATURITY[m.maturity].label,
      status_means: Canon.MATURITY[m.maturity].means, training_cutoff: m.training_cutoff, live_n: live,
      walk_forward_status: wf ? (wf.earned ? 'WALK-FORWARD VALIDATED' : (tr && tr.earned ? 'WALK-FORWARD TRACKED · ' + wf.progress : 'NOT TRACKED')) : (m.pricing_impact ? 'HISTORICAL BACKTEST ONLY' : 'NOT APPLICABLE'),
      clv_status: clv ? clv.label + (clv.progress ? ' · ' + clv.progress : '') : 'NOT APPLICABLE',
      pricing_impact: m.pricing_impact ? 'YES' : 'NO', pricing_impact_text: m.pricing_impact ? 'MOVES THE LINE' : 'RESEARCH CONTEXT ONLY', reason: m.reason, badges };
  });
  return { schema: 'edgedesk_cfb_maturity_v1', generated_at: now, maturity_definitions: Canon.MATURITY, badge_rules: Canon.BADGE_RULES,
    reference_mae: refMae, champion: champ, modules: rows,
    divergence_research: backtest ? { status: backtest.verdict.status, action: backtest.verdict.action } : null };
}

/* ---------------------------------------------------------- slate audit */
const REQUIRED = [
  { id: 'correct_game', label: 'correct game', checks: ['GAME.teams_resolved', 'GAME.kickoff', 'GAME.identity_join'] },
  { id: 'home_away', label: 'correct home/away', checks: ['GAME.home_away', 'GAME.orientation', 'GAME.venue'] },
  { id: 'fresh_multibook', label: 'fresh multi-book consensus', checks: ['MARKET.quote_present', 'MARKET.quote_fresh', 'MARKET.book_count', 'MARKET.dispersion', 'MARKET.consensus_valid'] },
  { id: 'current_team_states', label: 'current team states', checks: ['TEAM_STATE.current_sample', 'TEAM_STATE.state_stability', 'TEAM_STATE.season', 'TEAM_STATE.freshness', 'TEAM_STATE.fbs_scale'] },
  { id: 'resolved_qb', label: 'resolved QB', checks: ['QB.home_starter', 'QB.away_starter', 'QB.home_availability', 'QB.away_availability', 'QB.starter'] },
  { id: 'no_abnormal_availability', label: 'no abnormal availability', checks: ['ROSTER.home_availability', 'ROSTER.away_availability', 'ROSTER.availability', 'ROSTER.home_double_count', 'ROSTER.away_double_count'] },
  { id: 'component_bounds', label: 'component adjustments within historical bounds', prefix: 'COMPONENT.' },
  { id: 'submodel_support', label: 'submodel support', checks: ['MODEL.submodels', 'MODEL.submodel_support', 'MODEL.ensemble_direction', 'MODEL.ensemble_favorite', 'MODEL.ensemble_disagreement'] },
  { id: 'calibration_preserves_gap', label: 'football-only calibration preserves the major gap', checks: ['MODEL.calibration'] }
];
function auditRequirement(req, checks) {
  const mine = checks.filter((c) => req.prefix ? (c.group + '.' + c.id).indexOf(req.prefix) === 0 : req.checks.indexOf(c.group + '.' + c.id) >= 0);
  if (!mine.length) return { requirement: req.label, result: 'NOT RUN', detail: 'no check of this kind ran for this game' };
  const st = mine.map((c) => c.status);
  const res = st.indexOf('FAIL') >= 0 ? 'FAIL' : (st.indexOf('INCOMPLETE') >= 0 ? 'INCOMPLETE' : 'PASS');
  return { requirement: req.label, result: res, detail: mine.filter((c) => res === 'PASS' || c.status === res).map((c) => c.status + ': ' + c.detail).join(' · ') };
}
function slateAudit(board, games, named, now) {
  const rows = (board && board.rows) || [];
  const pick = rows.filter((x) => x.gap_class === 'MAJOR' || ['VERIFIED_MAJOR', 'INVESTIGATE', 'MARKET_FAULT'].indexOf(x.research_status) >= 0
    || named.some((n) => x.away === n[0] && x.home === n[1]));
  const out = pick.map((x) => {
    const o = games && games.games ? games.games[x.game_id] : null;
    const I = o && o.disagreement && o.disagreement.integrity;
    const checks = I && I.checks ? I.checks : [];
    const reqs = x.gap_class === 'MAJOR' ? REQUIRED.map((q) => auditRequirement(q, checks)) : null;
    const allPass = reqs ? reqs.every((q) => q.result === 'PASS') : null;
    return { game_id: x.game_id, game: x.away + ' @ ' + x.home, kickoff: x.kickoff, named: named.some((n) => x.away === n[0] && x.home === n[1]),
      edgedesk: x.fair, market: x.market, books: x.books, gap: x.gap, gap_class: x.gap_class, favorite_flip: !!x.favorite_flip,
      research_status: x.research_status, research_label: x.research_label, decision_status: x.decision_status,
      gate_status: I ? I.status : (x.gap_class === 'MAJOR' ? 'NOT RUN' : 'NOT REQUIRED (under 7 pts)'), root_cause: I ? I.root_cause : null,
      requirements: reqs,
      consistent: x.gap_class === 'MAJOR' ? ((x.research_status === 'VERIFIED_MAJOR') === !!allPass) : true,
      verdict: x.gap_class !== 'MAJOR' ? 'Under 7 pts: no integrity gate required; research status ' + x.research_label + '.'
        : (x.research_status === 'VERIFIED_MAJOR' ? (allPass ? 'VERIFIED holds: every required check passed.' : 'DOWNGRADE REQUIRED: a required check did not pass.')
          : (allPass ? 'Every required check passed but the status is ' + x.research_label + ' — investigate the status logic.' : x.research_label + ' is correct: ' + reqs.filter((q) => q.result !== 'PASS').map((q) => q.requirement + ' ' + q.result.toLowerCase()).join('; ') + '.')) };
  });
  return { schema: 'edgedesk_cfb_slate_audit_v1', generated_at: now, board_generated_at: board ? board.generated_at : null,
    source: 'football/cfb_terminal/{board,games}.json — the canonical research objects every page reads',
    requirements: REQUIRED.map((q) => q.label), games: out,
    inconsistent: out.filter((x) => !x.consistent).map((x) => x.game),
    app_path_finding: 'The app board used to count the books behind its gate consensus from the cfb.lines provider rows, which carry no capture time, while judging freshness on a different (dated) quote: "fresh multi-book consensus" was not actually verified on that path. The app now counts only dated, fresh quotes for the gate and shows the canonical research status from football/cfb_terminal/board.json (docs/cfb-validation/DELIVERABLE.md §32).' };
}

/* ------------------------------------------------------------ main */
async function main() {
  const now = arg('now', null) || new Date().toISOString();
  const check = flag('check');
  const offline = flag('offline');
  const S = F.load();
  if (!S.champion) { console.error('no football/cfb_validation/champion.json — run freeze.js --init once'); process.exit(2); }
  const freeze = S.champion;
  const season = +(arg('season', null) || readJson('football/cfb_lab/config.json', {}).season || 2026);

  /* 1 — the version log: detect pricing / research / decision drift */
  const patches = F.drift(S.versions, now);
  const versions = S.versions.concat(patches);

  /* 2 — the Lab */
  const D = REPORT.load(new G.Store(season));
  const gov = require(path.join(ROOT, 'football', 'cfb_terminal', 'build.js')).loadGovernance();
  const policy = gov.policy || {};
  const Vw = V.views(D, freeze, versions, policy, season);

  /* 3 — ratings */
  const etsr = readJson('football/rating/current.json', { teams: [] });
  let state = null, stateErr = null;
  try { state = await pricingState(season, offline); } catch (e) { stateErr = String(e && e.message || e); }
  const div = monitor(state, etsr, season);
  if (stateErr) div.state_error = 'the schedule feed could not be read (' + stateErr + '): the pricing state is unavailable and nothing is invented';
  const backtest = readJson('football/cfb_validation/divergence_backtest.json', null);
  div.backtest = backtest ? { status: backtest.verdict.status, reading: backtest.verdict.reading, action: backtest.verdict.action, game_bands: backtest.bands } : null;

  /* 4 — signals, postmortems, triggers, backlog */
  const forensics = readJson('football/validation/disagreement/forensics_cfb.json', null);
  const hist = forensics && forensics.gate_backtest ? (() => { const h = forensics.gate_backtest.holdout_football_only; return {
    source: 'football/validation/disagreement/forensics_cfb.json gate_backtest.holdout_football_only (2022–2025, gate parameters fitted on 2015–2021)',
    verified: { n: h.verified.n, close_moved_toward_pct: h.verified.close_moved_toward_pct, clv: h.verified.clv_points_mean, false_extreme_pct: h.verified.false_extreme_rate_pct, model_mae: h.verified.model_mae },
    unverified: { n: h.unverified.n, close_moved_toward_pct: h.unverified.close_moved_toward_pct, clv: h.unverified.clv_points_mean, false_extreme_pct: h.unverified.false_extreme_rate_pct, model_mae: h.unverified.model_mae } }; })() : null;
  const sig = V.signals(D, hist);
  const flipHist = forensics && forensics.favorite_flips ? forensics.favorite_flips : null;
  sig.favorite_flips.historical_reference = flipHist;
  const pm = V.postmortems(D, freeze, versions);
  const ref = ((readJson('football/cfb_lab/config.json', {}).reference || {})[freeze.champion.model_version] || {}).mae || null;
  const trig = V.triggers(D, freeze, versions, { signals: sig, backtest, reference_mae: ref });
  const backlogFile = path.join(HERE, 'backlog.jsonl');
  const backlogOld = F.readJsonl(backlogFile);
  const backlogNew = V.backlogEvents(backlogOld, trig, now, backtest);
  const backlog = backlogOld.concat(backlogNew);

  /* 5 — weekly scorecards (written ONCE per complete week) */
  const labSec = DISLAB.section(D);
  const board = readJson('football/cfb_terminal/board.json', null), games = readJson('football/cfb_terminal/games.json', null);
  const weeks = [...new Set(D.evals.filter((e) => e.model_version === freeze.champion.model_version && e.result_status === 'FINAL').map((e) => +e.week))].sort((a, b) => a - b);
  const weekDir = path.join(HERE, 'weekly');
  const writtenWeeks = [];
  const scorecards = weeks.map((w) => {
    const bw = labSec.by_week[w] || null;
    const gates = bw ? { verified: bw.verified, investigate: bw.investigate + bw.market_fault, data_faults: bw.data_fault, not_run: bw.not_run, raw_7plus: bw.raw_7plus, favorite_flips: bw.favorite_flips,
      downgraded: sig.investigate.games.filter((g) => +g.week === w).length ? null : 0 }
      : { verified: null, investigate: null, data_faults: null, note: 'no LIVE gate verdicts were recorded for this week (the gate was wired to the Lab on 2026-09-27)' };
    const sc = V.weekScorecard(D, w, freeze, versions, policy, season, gates);
    sc.report = V.executiveReport(sc, trig, sig, season);
    return sc;
  });
  /* complete: the Lab's own rule for a LIVE week; for a LEGACY-only week, every
     champion game has a final (or a week has passed since its last kickoff) */
  const finals = new Set((D.results || []).filter((x) => x.status === 'FINAL').map((x) => String(x.game_id)));
  const complete = (w) => {
    const ps = D.preds.filter((p) => +p.week === +w && p.model_version === freeze.champion.model_version);
    if (!ps.length) return false;
    if (ps.some((p) => p.origin === 'LIVE')) return REPORT.weekComplete(D, w, now);
    const last = Math.max.apply(null, ps.map((p) => ms(p.kickoff_ts)));
    if (ms(now) < last + 12 * 3600e3) return false;
    return ps.every((p) => finals.has(String(p.game_id))) || ms(now) > last + 7 * 86400e3;
  };
  scorecards.forEach((sc) => {
    const f = path.join(weekDir, season + '-w' + G.pad(sc.week) + '.json');
    if (fs.existsSync(f) || !complete(sc.week)) return;
    writtenWeeks.push({ file: f, sc });
  });
  const latestSc = scorecards[scorecards.length - 1] || null;

  /* 6 — what changed: per game (history) and system-wide (week over week) */
  const histFile = path.join(ROOT, 'football', 'cfb_terminal', 'history', String(season), 'snapshots.jsonl');
  const snaps = F.readJsonl(histFile);
  const perGame = V.gameChanges(snaps, board, { threshold: 0.5 });
  const sysNow = {
    at: now, champion: freeze.champion.model_version,
    pricing_fingerprint: F.fingerprint('PRICING').sha, research_fingerprint: F.fingerprint('RESEARCH').sha, decision_policy: gov.policy_dir,
    calibration: gov.calibration_version + ' · ' + ((global.EDCfbDisagreementParams && global.EDCfbDisagreementParams.calibration && global.EDCfbDisagreementParams.calibration.version) || 'cfb_margin_cal_v1'),
    modules: Canon.MODULES.map((m) => m.id + ':' + m.maturity).join(','),
    rating_week: etsr.season + '-w' + etsr.week, slate_generated_at: (readJson('football/fbs/slate.json', {}) || {}).generated_at || null,
    qb_resolved_pct: board && board.rows && board.rows.length ? r(100 * (games ? Object.values(games.games).filter((o) => o.qb && o.qb.home && o.qb.home.confirmed !== undefined && !o.qb.home.contested && o.qb.away && !o.qb.away.contested).length : 0) / board.rows.length, 0) : null,
    market_fresh_pct: board && board.rows && board.rows.length ? r(100 * board.rows.filter((x) => x.market && !x.market_stale).length / board.rows.length, 0) : null,
    market_multibook_pct: board && board.rows && board.rows.length ? r(100 * board.rows.filter((x) => x.market && !x.market_stale && (x.books || 0) >= 2).length / board.rows.length, 0) : null
  };
  const sysFile = path.join(HERE, 'system_history.jsonl');
  const sysOld = F.readJsonl(sysFile);
  const lastSys = sysOld[sysOld.length - 1] || null;
  const strip = (o) => { const x = Object.assign({}, o); delete x.at; return JSON.stringify(x); };
  const sysAppend = !lastSys || strip(lastSys) !== strip(sysNow) ? [sysNow] : [];
  const weekAgo = sysOld.filter((x) => ms(x.at) <= ms(now) - 6 * 86400e3).pop() || sysOld[0] || null;
  const sysDiff = V.systemDiff(weekAgo && weekAgo !== sysNow ? weekAgo : null, sysNow);

  /* 7 — maturity, audit, next 100, north star */
  const mat = maturity(D, freeze, Vw, backtest, now);
  const named = [['West Virginia', 'Iowa State'], ['Ohio State', 'Iowa'], ['Temple', 'South Florida'], ['Syracuse', 'UConn'], ['North Texas', 'Tulsa'], ['Marshall', 'James Madison'], ['Miami', 'Clemson']];
  const audit = slateAudit(board, games, named, now);
  const n100 = V.next100(S.plan, Vw);
  const liveCounts = { champion_live_snapshots: (D.preds || []).filter((p) => p.origin === 'LIVE' && p.model_version === freeze.champion.model_version).length };
  const ns = V.northStar(Vw, sig, freeze, liveCounts);

  const live = {
    schema: 'edgedesk_cfb_live_validation_v1', generated_at: now, season,
    question: 'Is the current version actually getting better?',
    freeze: { release: freeze.release_id, label: freeze.label, champion: freeze.champion, effective_at: freeze.effective_at, fingerprints: freeze.fingerprints },
    versions: versions.map((v) => ({ event: v.event, kind: v.kind, version: v.version, effective_at: v.effective_at, reason: v.reason, changed_files: v.changed_files || null })),
    pending_patches: patches.map((v) => v.version + ': ' + v.reason),
    north_star: ns,
    views: Vw,
    separation: 'FOOTBALL MODEL, MARKET INTELLIGENCE and BETTING DECISIONS are computed and shown apart. A betting record is only ever the decision engine’s qualified wagers; research leans are hypothetical and labelled.',
    scorecard_latest: latestSc,
    triggers: trig,
    backlog: { open: backlog.filter((x) => x.event === 'OPENED').map((x) => ({ id: x.candidate_id, title: x.title, stage: x.stage, source: x.source, created_at: x.created_at })), file: 'football/cfb_validation/backlog.jsonl' },
    next_100: n100,
    weekly_files: (fs.existsSync(weekDir) ? fs.readdirSync(weekDir) : []).concat(writtenWeeks.map((x) => path.basename(x.file)))
      .filter((f, i, a) => /\.json$/.test(f) && a.indexOf(f) === i).sort().map((f) => ({ file: 'football/cfb_validation/weekly/' + f, md: 'football/cfb_validation/weekly/' + f.replace(/\.json$/, '.md') })),
    what_changed_this_week: sysDiff,
    lab_alerts: REPORT.alerts(D, now, require(path.join(ROOT, 'football', 'cfb_lab', 'governance.js')).currentRoles(D.roles)),
    definitions: 'docs/cfb-validation/DELIVERABLE.md · docs/cfb-lab/METRICS.md'
  };
  const out = {
    'live.json': live,
    'divergence.json': Object.assign({ schema: 'edgedesk_cfb_rating_divergence_v1', generated_at: now, names: { current: Canon.RATINGS.CURRENT_FBS_POWER_RATING, state: Canon.RATINGS.PRODUCTION_PRICING_STATE } }, div),
    'maturity.json': mat,
    'signals.json': Object.assign({ schema: 'edgedesk_cfb_signal_scorecards_v1', generated_at: now }, sig),
    'postmortems.json': Object.assign({ schema: 'edgedesk_cfb_postmortems_v1', generated_at: now, classes: Canon.POSTMORTEM }, pm),
    'slate_audit.json': audit,
    'changes.json': { schema: 'edgedesk_cfb_changes_v1', generated_at: now, threshold_points: 0.5, rule: 'market movement can never move the pure fair line, so it is never an attribution; an unexplained move is UNATTRIBUTED', system: sysDiff, games: perGame }
  };
  const summary = { generated_at: now, patches: patches.length, views: Vw.map((v) => v.id + ':' + v.football_model.n), divergence: { n: div.n, median: div.median_abs, p90: div.p90_abs, flagged: div.flagged.length, error: div.state_error || null },
    signals: { verified: sig.verified.summary.n, investigate: sig.investigate.summary.n, flips: sig.favorite_flips.summary.n, not_run: sig.verdict_not_run.n },
    postmortems: pm.rows.length, triggers: trig.state, backlog_new: backlogNew.length, weeks_to_write: writtenWeeks.map((x) => x.sc.week), slate_audit: { games: audit.games.length, inconsistent: audit.inconsistent }, changes: perGame.length };
  if (check) { console.log(JSON.stringify(summary, null, 1)); return; }
  Object.keys(out).forEach((f) => fs.writeFileSync(path.join(HERE, f), JSON.stringify(out[f], null, 1) + '\n'));
  if (writtenWeeks.length) fs.mkdirSync(weekDir, { recursive: true });
  writtenWeeks.forEach((x) => {
    fs.writeFileSync(x.file, JSON.stringify(Object.assign({ schema: 'edgedesk_cfb_weekly_scorecard_v1', written_at: now, immutable: 'written once when the week completed; never regenerated',
      written_retroactively: x.sc.epoch === 'LEGACY' ? 'this LEGACY week was scored when the validation layer first ran (' + now + '), from reconstructed numbers frozen long before' : null }, x.sc), null, 1) + '\n');
    fs.writeFileSync(x.file.replace(/\.json$/, '.md'), x.sc.report.text + '\n');
  });
  const app = (f, rows) => { if (rows.length) fs.appendFileSync(f, rows.map((x) => JSON.stringify(x)).join('\n') + '\n'); };
  app(backlogFile, backlogNew); app(F.VERSIONS, patches); app(sysFile, sysAppend);
  console.log(JSON.stringify(summary));
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { monitor, maturity, slateAudit, auditRequirement, REQUIRED, pricingState };

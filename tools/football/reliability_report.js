#!/usr/bin/env node
/* ===========================================================================
   THE RELIABILITY REPORT — the slate dashboard, the walk-forward backfill,
   and the calibration that decides whether the score means anything.

   Reliability (lib/cfb_reliability.js) is a formula that LOOKS sensible. That
   is not evidence. This tool asks the only question that is: across graded
   games, does a higher PREGAME reliability go with a smaller projection
   error? Until it does, in every bucket with a usable sample, the score is
   published as NOT VALIDATED.

   Three commands:

     dashboard   the slate-wide distribution from football/fbs/reliability.json:
                 mean, median, P10-P90, grades, conferences, FBS vs FCS, every
                 cap and flag, the 20 lowest and highest games with their exact
                 reasons, and the most common deductions across the slate

     backfill    WALK-FORWARD, NO LEAKAGE. For every graded game in
                 record/football/cfb_<season>.json, open the exact slate its
                 pick was published from (the entry's `provenance` commit) and
                 score reliability from what that slate carried THEN:
                   - the input contract, the starters and the QB identities
                     exactly as published before kickoff;
                   - the engine's additive terms, from a rating state rebuilt
                     by replaying ONLY the games completed before that slate
                     was generated;
                   - the ranking layer's team gates from the latest weekly
                     snapshot whose data_as_of precedes the slate;
                   - judged at the slate's own generated_at.
                 No close, no result and no later artifact is read while
                 scoring. A slate that predates the input contract cannot be
                 scored and is counted, never guessed.

     calibrate   projection error grouped by pregame reliability bucket
                 (90-100 ... <50): MAE and RMSE against the close and the
                 result, median absolute error, favourite accuracy, ATS as
                 research only, sample sizes — from the backfill plus every
                 pick the record has frozen WITH its reliability since v2
                 shipped. The formula was fixed before any of these outcomes
                 were looked at and is never tuned against them.

   Usage
     node tools/football/reliability_report.js dashboard [--json]
     node tools/football/reliability_report.js backfill [--season 2026] [--slates DIR] [--write]
     node tools/football/reliability_report.js calibrate [--season 2026] [--write]
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'cfb_reliability.js'));

const args = process.argv.slice(2);
const cmd = args[0] || 'dashboard';
const flag = (n) => args.indexOf('--' + n) >= 0;
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SEASON = +opt('season', 2026);
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const VALIDATION = path.join(ROOT, 'football', 'validation');
const BACKFILL = path.join(VALIDATION, 'reliability_backfill_cfb_' + SEASON + '.json');
const CALIBRATION = path.join(VALIDATION, 'reliability_calibration_cfb.json');

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

/* ================================================================ dashboard */
function dashboard() {
  const A = readJson(path.join(ROOT, 'football', 'fbs', 'reliability.json'), null);
  if (!A || !A.games) { console.error('football/fbs/reliability.json is missing — run node football/fbs/build_coverage.js'); return 2; }
  const S = A.summary;
  const games = Object.values(A.games).filter((g) => g.reliability);
  if (flag('json')) { console.log(JSON.stringify({ summary: S, games }, null, 1)); return 0; }
  console.log('RELIABILITY DASHBOARD — ' + A.generated_at + ' (' + A.version + ')');
  console.log('Reliability is a 0-100 data-quality, uncertainty and stability score. It is NOT a probability.\n');
  console.log('games ' + S.games + '  mean ' + S.mean + '  median ' + S.median + '  min ' + S.min + '  max ' + S.max);
  console.log('P10 ' + S.percentiles.p10 + '  P25 ' + S.percentiles.p25 + '  P50 ' + S.percentiles.p50
    + '  P75 ' + S.percentiles.p75 + '  P90 ' + S.percentiles.p90);
  console.log('\nBY GRADE');
  S.by_grade.forEach((g) => console.log('  ' + pad(g.label, 12) + lpad(g.n, 4) + '  ' + '#'.repeat(g.n)));
  console.log('\nFBS vs FBS  n ' + S.fbs_vs_fcs.fbs_fbs.n + '  mean ' + S.fbs_vs_fcs.fbs_fbs.mean + '  median ' + S.fbs_vs_fcs.fbs_fbs.median);
  console.log('FBS vs FCS  n ' + S.fbs_vs_fcs.fbs_fcs.n + '  mean ' + S.fbs_vs_fcs.fbs_fcs.mean + '  median ' + S.fbs_vs_fcs.fbs_fcs.median);
  console.log('\nBY CONFERENCE (a game counts under each conference in it)');
  S.by_conference.forEach((c) => console.log('  ' + pad(c.conference, 18) + lpad(c.n, 4) + '  mean ' + lpad(c.mean, 5) + '  median ' + lpad(c.median, 5)));
  console.log('\nFLAGS');
  Object.keys(S.flags).forEach((k) => console.log('  ' + pad(k.replace(/_/g, ' '), 30) + lpad(S.flags[k], 4)));
  console.log('\nTOP RELIABILITY BOTTLENECKS (games carrying the deduction, points lost across the slate)');
  S.bottlenecks.slice(0, 15).forEach((b, i) => console.log('  ' + lpad(i + 1, 2) + '. ' + pad(b.label, 52) + lpad(b.games, 4) + ' games  ' + lpad(b.points, 7) + ' pts'));
  /* THE ENRICHMENT (football/enrichment/): the same slate scored without the
     evidence packages, and the data bottlenecks ranked by ENRICHMENT ROI */
  if (A.summary_without_evidence) {
    const W = A.summary_without_evidence;
    console.log('\nWITH vs WITHOUT THE EVIDENCE PACKAGES (same games, same run, same projections)');
    console.log('  mean ' + W.mean + ' -> ' + S.mean + '   median ' + W.median + ' -> ' + S.median);
    S.by_grade.forEach((g, i) => console.log('  ' + pad(g.label, 12) + lpad(W.by_grade[i].n, 4) + ' -> ' + lpad(g.n, 4)));
  }
  if (A.roi && A.roi.families) {
    console.log('\nDATA BOTTLENECKS \u2014 ENRICHMENT ROI (estimated recoverable points / cost; an engineering diagnostic)');
    console.log('   #  ' + pad('bottleneck', 30) + lpad('games', 6) + lpad('lost', 8) + lpad('max rec', 9) + lpad('est', 7) + lpad('cost', 6) + lpad('ROI', 8));
    A.roi.families.forEach((b) => console.log('  ' + lpad(b.engineering_priority == null ? '-' : b.engineering_priority, 2) + '  ' + pad(b.label, 30)
      + lpad(b.games_affected, 6) + lpad(b.current_points_lost == null ? '-' : b.current_points_lost, 8) + lpad(b.maximum_recoverable_points == null ? '-' : b.maximum_recoverable_points, 9)
      + lpad(b.estimated_recoverable_points == null ? '-' : b.estimated_recoverable_points, 7) + lpad(b.cost, 6) + lpad(b.enrichment_roi == null ? '-' : b.enrichment_roi, 8)));
    if (A.roi.potential) console.log('  potential reliability (mean): ' + A.roi.potential.mean_potential + ' against ' + A.roi.potential.mean_score + ' now \u2014 ' + A.roi.potential.basis);
  }
  const sorted = games.slice().sort((a, b) => a.reliability.score - b.reliability.score || String(a.game_id).localeCompare(String(b.game_id)));
  const line = (g) => lpad(g.reliability.score, 3) + ' ' + pad(g.reliability.grade_label, 11) + ' ' + pad(g.away + ' @ ' + g.home, 44);
  console.log('\n20 LOWEST');
  sorted.slice(0, 20).forEach((g) => {
    console.log('  ' + line(g));
    (g.reliability.penalties || []).slice(0, 3).forEach((p) => console.log('        -' + p.points + '  ' + p.reason));
    (g.reliability.gates || []).filter((x) => x.binding).forEach((x) => console.log('        cap ' + x.cap + '  ' + x.id));
  });
  console.log('\n20 HIGHEST');
  sorted.slice(-20).reverse().forEach((g) => {
    console.log('  ' + line(g) + '  main deduction: ' + (g.reliability.main_deduction || 'none'));
  });
  return 0;
}

/* ================================================================= backfill */
function slateAt(sha, dir) {
  if (dir) {
    const f = path.join(dir, 'slate_' + sha + '.json');
    if (fs.existsSync(f)) return readJson(f, null);
  }
  try {
    const txt = execFileSync('git', ['show', sha + ':football/fbs/slate.json'], { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8' });
    return JSON.parse(txt);
  } catch (e) { return null; }
}
function snapshotBefore(t) {
  const dir = path.join(ROOT, 'football', 'rankings', 'snapshots');
  let best = null;
  (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d{4}-w\d+\.json$/.test(f) && f.indexOf(String(SEASON)) === 0).forEach((f) => {
    const s = readJson(path.join(dir, f), null);
    if (!s || s.reconstructed) return;             /* a reconstructed snapshot carries later data */
    const at = Date.parse(s.data_as_of || s.generated_at);
    if (!isFinite(at) || at >= t) return;
    if (!best || at > best.at) best = { at, file: f, s };
  });
  return best;
}
async function backfill() {
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const P = global.EDCfbP4Params;
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
  const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
  const L = readJson(path.join(ROOT, 'record', 'football', 'cfb_' + SEASON + '.json'), null);
  if (!L) { console.error('no record for ' + SEASON); return 2; }
  const text = await BC.loadSeason(SEASON, true).catch(() => null) || await BC.loadSeason(SEASON, false).catch(() => null);
  if (!text) { console.error('the ' + SEASON + ' schedule could not be read'); return 2; }
  const rows = BC.normRows(BC.parseCsv(text));
  const eff = readJson(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), null);
  const graded = Object.values(L.games).filter((e) => e.grade && e.grade.status === 'GRADED' && e.provenance);
  const bySha = {};
  graded.forEach((e) => { const sha = String(e.provenance).replace(/^git\s+/, ''); (bySha[sha] = bySha[sha] || []).push(e); });
  const dir = opt('slates', null);
  const out = { schema: 'edgedesk_cfb_reliability_backfill_v1', version: R.version, season: SEASON,
    generated_at: new Date().toISOString(),
    method: 'walk-forward: each graded pick scored from the slate it was published from, judged at that slate’s generated_at, '
      + 'with the engine’s additive terms from a replay of ONLY the games completed before it and the ranking gates from the latest '
      + 'earlier snapshot. No close, result or later artifact is read while scoring.',
    limits: [
      'the personnel impact layer did not exist when these slates were published, so non-QB impact falls back to the contract availability state',
      'the starter persistence calibration is not carried on a slate row, so QB identity certainty uses the declared evidence-class rates',
      'the replayed rating state approximates the one that priced the pick (the engine-efficiency join has changed since); the gap is published per game as replay_vs_pick'
    ],
    slates: [], unscorable: [], rows: [] };
  const shas = Object.keys(bySha).sort();
  for (const sha of shas) {
    const sl = slateAt(sha, dir);
    const entries = bySha[sha];
    if (!sl || !sl.games) { out.unscorable.push({ provenance: sha, games: entries.length, why: 'the slate at this commit could not be read' }); continue; }
    const cut = Date.parse(sl.generated_at);
    const hasContract = sl.games.some((g) => Array.isArray(g.input_contract));
    out.slates.push({ provenance: sha, generated_at: sl.generated_at, games: entries.length, has_contract: hasContract });
    if (!hasContract) { out.unscorable.push({ provenance: sha, games: entries.length, why: 'this slate predates the input contract (published ' + sl.generated_at + '), so its inputs cannot be scored' }); continue; }
    /* the rating state as it stood: only games completed before the slate */
    const before = rows.map((r) => Object.assign({}, r, (Date.parse(r.start_date) < cut && r.completed) ? {} : { completed: false, home_points: null, away_points: null }));
    const { st } = BC.buildState({ [SEASON]: before }, SEASON, eff);
    const snap = snapshotBefore(cut);
    const rk = {};
    if (snap) Object.values(snap.s.teams || {}).forEach((t) => { if (t && t.key) rk[t.key] = t; });
    const venues = (P.universe && P.universe.venues) || {};
    for (const e of entries) {
      const g = sl.games.find((x) => String(x.game_id) === String(e.game_id));
      if (!g || !Array.isArray(g.input_contract)) { out.unscorable.push({ game_id: e.game_id, why: 'not on its provenance slate with a contract' }); continue; }
      const hk = g.home_team_id || FBS.normKey(g.home_team), ak = g.away_team_id || FBS.normKey(g.away_team);
      const homeFbs = g.home_division === 'fbs', awayFbs = g.away_division === 'fbs';
      const sched = rows.find((r) => String(r.game_id) === String(g.game_id)) || {};
      const req = { season: SEASON, week: g.week, state: st,
        game: { home: g.home_team, away: g.away_team, neutral_site: !!g.neutral_site, venue_id: sched.venue_id,
          kickoff: g.kickoff, home_fbs: homeFbs, away_fbs: awayFbs },
        teams: { home: { conference: g.home_conference, roster: null, qb: null, qb_context: null, injuries: null, news: null, coaching: null, schedule: null },
          away: { conference: g.away_conference, roster: null, qb: null, qb_context: null, injuries: null, news: null, coaching: null, schedule: null } },
        venue: { home: venues[hk] || null, away: venues[ak] || null }, weather: null, market: {}, timestamps: {} };
      let p = null;
      try { p = E.projectGame(req); } catch (_) { p = null; }
      const rel = R.score(R.inputFor({
        now: cut, game: { game_id: g.game_id, home_team: g.home_team, away_team: g.away_team, start_date: g.kickoff,
          neutral_site: g.neutral_site, venue: g.venue, week: g.week },
        meta: { home: { key: hk, is_fbs: homeFbs, conference_id: g.home_conference_id, conference: g.home_conference },
          away: { key: ak, is_fbs: awayFbs, conference_id: g.away_conference_id, conference: g.away_conference },
          matchup_type: g.matchup_type },
        projection: p, contract: g.input_contract,
        starters: { home: g.home_starter, away: g.away_starter },
        qb_epa: { home: g.home_qb_epa, away: g.away_qb_epa },
        injuries: {}, venues: { home: venues[hk] || null, away: venues[ak] || null }, rosters: {},
        personnel: null,
        team_quality: { home: R.teamQuality(rk[hk]), away: R.teamQuality(rk[ak]) },
        market: null, built_at: sl.generated_at, engine: E, state: st, params: P
      }));
      const replayMargin = p && p.status === 'PREDICTED' ? p.model.fair_spread : null;
      out.rows.push({
        game_id: String(e.game_id), week: e.week, kickoff: e.kickoff, home: e.home, away: e.away, group: e.group,
        provenance: sha, judged_at: sl.generated_at, snapshot: snap ? snap.file : null,
        reliability: rel.score, grade: rel.grade, capped_by: rel.capped_by,
        components: R.compact(rel).components, stability: R.compact(rel).stability,
        model_margin: -e.pick.home_line,
        replay_vs_pick: replayMargin == null ? null : Math.round((replayMargin - -e.pick.home_line) * 100) / 100,
        close_margin: e.close && e.close.home_line != null ? -e.close.home_line : null,
        final_margin: e.final ? e.final.home_score - e.final.away_score : null
      });
    }
  }
  const diffs = out.rows.map((r) => r.replay_vs_pick).filter((x) => x != null).map(Math.abs).sort((a, b) => a - b);
  out.replay_fidelity = { n: diffs.length, median_abs_diff: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null,
    within_1pt: diffs.filter((x) => x <= 1).length,
    basis: 'how far the replayed number sits from the number the pick actually published; the stability terms are read off the replay' };
  console.log('backfill: ' + out.rows.length + ' graded games scored from ' + out.slates.filter((s) => s.has_contract).length
    + ' contract-bearing slates; ' + out.unscorable.reduce((n, u) => n + (u.games || 1), 0) + ' could not be scored');
  console.log('replay fidelity: median |replay - pick| ' + out.replay_fidelity.median_abs_diff + ' pts, '
    + out.replay_fidelity.within_1pt + '/' + out.replay_fidelity.n + ' within 1 pt');
  if (flag('write')) { fs.mkdirSync(VALIDATION, { recursive: true }); fs.writeFileSync(BACKFILL, JSON.stringify(out, null, 1) + '\n'); console.log('wrote ' + path.relative(ROOT, BACKFILL)); }
  return 0;
}

/* ================================================================ calibrate */
function calibrate() {
  const B = readJson(BACKFILL, null);
  const L = readJson(path.join(ROOT, 'record', 'football', 'cfb_' + SEASON + '.json'), null);
  const rows = [], seen = {};
  /* forward: picks the record froze WITH a reliability (v2 onward) win over
     the backfill for the same game — they are the score as actually published */
  if (L) Object.values(L.games).forEach((e) => {
    if (!e.grade || e.grade.status !== 'GRADED' || !e.pick || !e.pick.reliability) return;
    seen[e.game_id] = 1;
    rows.push({ source: 'record', game_id: e.game_id, week: e.week, group: e.group || null, reliability: e.pick.reliability.score, model_margin: -e.pick.home_line,
      close_margin: e.close && e.close.home_line != null ? -e.close.home_line : null,
      final_margin: e.final ? e.final.home_score - e.final.away_score : null });
  });
  if (B) B.rows.forEach((r) => { if (!seen[r.game_id]) rows.push(Object.assign({ source: 'backfill' }, r)); });
  const all = R.calibrate(rows);
  /* walk-forward: each week scored only with what stood before it; the
     split by week shows whether an ordering holds out of time, not only pooled */
  const weeks = {};
  rows.forEach((r) => { (weeks[r.week] = weeks[r.week] || []).push(r); });
  const byWeek = Object.keys(weeks).sort((a, b) => a - b).map((w) => ({ week: +w, calibration: R.calibrate(weeks[w]) }));
  /* the cruder split with more games per cell: above and below the median */
  const med = rows.map((r) => r.reliability).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  function half(xs) {
    const e = xs.filter((r) => r.close_margin != null).map((r) => Math.abs(r.model_margin - r.close_margin));
    const f = xs.filter((r) => r.final_margin != null).map((r) => Math.abs(r.model_margin - r.final_margin));
    const m = (a) => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 100) / 100 : null;
    return { n: xs.length, mae_vs_close: m(e), mae_vs_result: m(f) };
  }
  const split = med == null ? null : { median_reliability: med,
    above: half(rows.filter((r) => r.reliability > med)), at_or_below: half(rows.filter((r) => r.reliability <= med)) };
  /* THE CONFOUND, taken out: FBS-vs-FCS games sit at the bottom of the scale
     (the shared FCS floor, THIN DATA) and are also where the model is known
     to miss most. An ordering that holds only because of them says nothing
     about the rest of the slate */
  const fbsOnly = R.calibrate(rows.filter((r) => r.group !== 'fbs_fcs'));
  const out = { schema: 'edgedesk_cfb_reliability_calibration_v1', version: R.version, season: SEASON,
    generated_at: new Date().toISOString(),
    sources: { record_forward: rows.filter((r) => r.source === 'record').length, backfill: rows.filter((r) => r.source === 'backfill').length,
      unscorable: B ? B.unscorable.reduce((n, u) => n + (u.games || 1), 0) : null },
    pooled: all, fbs_only: fbsOnly, median_split: split, by_week: byWeek,
    validated: all.validated,
    statement: all.validated
      ? 'Higher pregame reliability went with lower projection error in every bucket with a usable sample.'
      : all.verdict + '. Reliability is published as a transparent data-quality measure, not as a validated predictor of error.' };
  console.log('CALIBRATION — ' + rows.length + ' graded games (' + out.sources.record_forward + ' frozen with the pick, '
    + out.sources.backfill + ' walk-forward backfill; ' + out.sources.unscorable + ' unscorable)');
  console.log(pad('bucket', 8) + lpad('n', 5) + lpad('MAE close', 11) + lpad('RMSE close', 12) + lpad('MedAE close', 13)
    + lpad('MAE result', 12) + lpad('fav acc', 9) + lpad('ATS*', 7));
  all.buckets.forEach((b) => console.log(pad(b.bucket, 8) + lpad(b.n, 5) + lpad(b.mae_vs_close, 11) + lpad(b.rmse_vs_close, 12)
    + lpad(b.median_abs_vs_close, 13) + lpad(b.mae_vs_result, 12) + lpad(b.favorite_accuracy, 9) + lpad(b.ats_research_only, 7)));
  console.log('* ATS is research only.');
  console.log('FBS vs FBS only (the FCS confound removed):');
  fbsOnly.buckets.filter((b) => b.n).forEach((b) => console.log('  ' + pad(b.bucket, 8) + lpad(b.n, 5) + '  MAE close ' + lpad(b.mae_vs_close, 6)
    + '  MAE result ' + lpad(b.mae_vs_result, 6)));
  if (split) console.log('median split at ' + split.median_reliability + ': above n ' + split.above.n + ' MAE close ' + split.above.mae_vs_close
    + ' / result ' + split.above.mae_vs_result + '  |  at or below n ' + split.at_or_below.n + ' MAE close ' + split.at_or_below.mae_vs_close
    + ' / result ' + split.at_or_below.mae_vs_result);
  console.log(out.statement);
  if (flag('write')) { fs.mkdirSync(VALIDATION, { recursive: true }); fs.writeFileSync(CALIBRATION, JSON.stringify(out, null, 1) + '\n'); console.log('wrote ' + path.relative(ROOT, CALIBRATION)); }
  return 0;
}

if (require.main === module) {
  const run = cmd === 'backfill' ? backfill() : (cmd === 'calibrate' ? calibrate() : dashboard());
  Promise.resolve(run).then((c) => process.exit(c || 0)).catch((e) => { console.error(e && e.stack || e); process.exit(2); });
}
module.exports = { snapshotBefore };

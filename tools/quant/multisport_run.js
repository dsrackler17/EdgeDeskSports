#!/usr/bin/env node
/* ===========================================================================
   THE MULTI-SPORT QUANT DESK, RUN FROM THE COMMAND LINE — a live run on the
   committed artifacts, or a POINT-IN-TIME REPLAY from git history.

   The same three modules the edge function inlines (EDPROJ, EDMKT, EDMULTI),
   in the same enforced order: every engine artifact read, the projections
   frozen, then (unless --odds off) the prices compared.

   REPLAY (--replay --at ISO): each artifact is read as it was committed at or
   before --at (`git log -1 --before`), and an artifact whose own generated_at
   is later than --at is REFUSED (look-ahead), never used. Prices are the
   scoreboard snapshot committed by then, labelled as a previously captured
   quote. Capture's Supabase signals are not in git, so a replay says so.

   LIVE (default): the working tree's committed artifacts, as of --at or now.
   Nothing here reaches the network: this environment's live feeds are the
   scheduled builds that commit these files.

   Usage
     node tools/quant/multisport_run.js --replay --at 2026-10-15T13:00:00Z --tz America/Chicago
     node tools/quant/multisport_run.js --tz America/Chicago --odds off
     ... [--question "What's the best researched opportunity tonight?"] [--json out.json] [--date YYYY-MM-DD]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
globalThis.EDFAIR = globalThis.EDFAIR || require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const EDPROJ = require(path.join(ROOT, 'lib', 'edgedesk_projections.js'));
const EDMKT = require(path.join(ROOT, 'lib', 'edgedesk_market_compare.js'));
const EDMULTI = require(path.join(ROOT, 'lib', 'edgedesk_multisport.js'));

const PATHS = EDPROJ.artifactsNeeded().concat(['today/slate.json']);

function git(args) { return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
/** Every artifact as committed at or before `at`; a file built after `at` is refused (look-ahead). */
function fromGit(at, paths) {
  const A = {}, meta = {}, errors = {};
  (paths || PATHS).forEach((p) => {
    let sha = '';
    try { sha = git(['log', '-1', '--format=%H %cI', '--before=' + at, '--', p]).trim(); } catch (_) { sha = ''; }
    if (!sha) { A[p] = null; errors[p] = 'no commit of this file at or before ' + at; return; }
    const [h, committed] = sha.split(' ');
    let j = null;
    try { j = JSON.parse(git(['show', h + ':' + p])); } catch (e) { A[p] = null; errors[p] = 'unreadable at ' + h.slice(0, 8); return; }
    const gen = j && j.generated_at ? Date.parse(j.generated_at) : null;
    if (gen != null && gen > Date.parse(at)) { A[p] = null; errors[p] = 'LOOK-AHEAD REFUSED: generated ' + j.generated_at + ', after the replay time'; return; }
    A[p] = j; meta[p] = { commit: h.slice(0, 8), committed_at: committed, generated_at: j && j.generated_at || null };
  });
  return { artifacts: A, meta, errors };
}
function fromTree(paths) {
  const A = {}, meta = {}, errors = {};
  (paths || PATHS).forEach((p) => {
    try { A[p] = JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); meta[p] = { generated_at: A[p] && A[p].generated_at || null }; }
    catch (e) { A[p] = null; errors[p] = String(e && e.message || e).slice(0, 120); }
  });
  return { artifacts: A, meta, errors };
}
/** Prices AFTER the freeze: the scoreboard snapshot's single-book lines, as previously captured quotes. */
function scoreboardQuotes(today) {
  if (!today || !today.markets) return { quotes: [], sources: [] };
  const q = EDMKT.quotesFromScoreboard(today, (e) => EDPROJ.SCHEDULE_CODE[String(e.sport)] || e.sport);
  return { quotes: q, sources: q.length ? ['today/slate.json markets — the ESPN scoreboard\'s single-book lines captured ' + today.generated_at + ' (previously captured, never live)'] : [] };
}
/**
 * One run. o: { artifacts, artifact_errors, at (ms), tz, question, odds_off, date, mode, meta }
 * Phase 1 (no price), then the quotes, then phase 2 — the same order the edge function enforces.
 */
function run(o) {
  const prep = EDMULTI.prepare({ artifacts: o.artifacts, artifact_errors: o.artifact_errors, question: o.question, now: o.at, timezone: o.tz, date: o.date || null });
  const q = o.odds_off ? { quotes: [], sources: [] } : scoreboardQuotes(o.artifacts['today/slate.json']);
  if (!o.odds_off) q.sources.push(o.mode === 'replay' ? 'capture\'s Supabase signals are not in git, so a replay compares only the committed scoreboard snapshot' : 'capture\'s Supabase signals are read by the edge function, not by this command-line run');
  const res = EDMULTI.complete(prep, { quotes: q.quotes, quote_sources: q.sources, odds_disabled: !!o.odds_off, now: o.at + 1000 });
  return { prep, res };
}
function acceptance(r, o) {
  const c = r.res.counts, cov = r.res.coverage;
  return {
    mode: o.mode, at: new Date(o.at).toISOString(), timezone: o.tz, window: r.res.window, odds: o.odds_off ? 'DISABLED' : 'captured scoreboard snapshot only',
    '1_sports_discovered': c.sports_discovered, '1_sports_discovered_list': cov.filter((x) => x.events_discovered).map((x) => x.label),
    '2_sports_with_operational_models': c.sports_with_operational_models, '2_operational_list': cov.filter((x) => x.model_executed).map((x) => x.label),
    '3_eligible_games_per_sport': Object.fromEntries(cov.filter((x) => x.events_discovered).map((x) => [x.label, x.events_discovered])),
    '4_successful_research_evaluations': c.research_evaluations, research_outcomes: Object.fromEntries(cov.filter((x) => x.events_discovered).map((x) => [x.label, x.research_outcomes])),
    '5_valid_sportsbook_price_captures': c.valid_price_captures, price_captures_seen_for_these_events: c.price_captures_seen,
    '6_independent_projections': c.independent_projections,
    '7_verified_positive_ev': c.verified_positive_ev, comparison_outcomes: r.res.comparison.counts,
    '8_top_research_candidates': r.res.research_ranking.ranked.slice(0, 6).map((x) => ({ rank: x.rank, sport: x.sport_label, event: x.event, pick: x.modeled.selection, p: x.modeled.probability, sigma: x.modeled.sigma.total, conservative: x.modeled.conservative_probability, tier: x.tier, outcome: x.research_outcome })),
    '9_failures': Object.assign({}, o.artifact_errors, Object.fromEntries(cov.filter((x) => x.blockers.length).map((x) => [x.label, x.blockers]))),
    '10_not_hardcoded_to_football': { sports_researched: cov.filter((x) => x.events_researched).map((x) => x.label), best_research_sport: r.res.sections.best_research ? r.res.sections.best_research.sport_label : null },
    order: r.res.order, artifacts: o.meta
  };
}
function main() {
  const args = process.argv.slice(2);
  const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const replay = args.includes('--replay');
  const atIso = val('--at', null);
  const at = atIso ? Date.parse(atIso) : Date.now();
  if (!Number.isFinite(at)) { console.error('--at must be an ISO time'); process.exit(2); }
  const tz = val('--tz', 'America/Chicago');
  const question = val('--question', "What's the best researched opportunity tonight?");
  const oddsOff = val('--odds', 'on') === 'off' || process.env.EDGEDESK_ODDS_DISABLED === '1';
  const src = replay ? fromGit(new Date(at).toISOString(), PATHS) : fromTree(PATHS);
  const o = { artifacts: src.artifacts, artifact_errors: src.errors, at, tz, question, odds_off: oddsOff, date: val('--date', null), mode: replay ? 'replay' : 'live', meta: src.meta };
  const r = run(o);
  console.log(r.res.answer);
  console.log('\n──── ACCEPTANCE (' + (replay ? 'HISTORICAL REPLAY at ' : 'LIVE (committed artifacts) at ') + new Date(at).toISOString() + ') ────');
  const acc = acceptance(r, o);
  console.log(JSON.stringify(acc, null, 1));
  const out = val('--json', null);
  if (out) fs.writeFileSync(out, JSON.stringify({ acceptance: acc, answer: r.res.answer, result: { sections: r.res.sections, coverage: r.res.coverage, counts: r.res.counts, order: r.res.order } }, null, 1));
}
module.exports = { fromGit, fromTree, run, acceptance, scoreboardQuotes, PATHS };
if (require.main === module) main();

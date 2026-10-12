#!/usr/bin/env node
/* ===========================================================================
   Inline the canonical shared libraries into every host that carries them.

   TWO SOURCES, each with its own marker pair:

     _presentation.js  EDPRES   — translates a decision that already exists
                                  into sportsbook language and cards.
       hosts: edgedesk_ai/index.ts, app.html, brief.html, record.html

     _intelligence.js  EDINTEL  — OWNS the decision: slate state, fair-price
                                  provenance, quote freshness, push-aware EV,
                                  the model-validation gate, the ledger.
       hosts: edgedesk_ai/index.ts, app.html

     _research.js      EDRESEARCH — the typed tool layer, the normalised
                                  research packet, the label rules, the answer
                                  contract and the critic.
       hosts: edgedesk_ai/index.ts

     fbs.js  EDFBSKEY + EDFBSRESOLVE — the team resolver and its alias table,
                                  the ONLY thing that can join a book's
                                  "North Texas Mean Green" to a schedule's
                                  "North Texas". Copied INTO _intelligence.js
                                  (and so on into the two hosts above) rather
                                  than re-implemented, because a second alias
                                  table is a board and a desk that disagree
                                  about who is playing.
       hosts: edgedesk_ai/_intelligence.js

   Each host carries the marker pair and this replaces everything between them
   with the canonical block, byte for byte. presentation_sync.test.js fails
   when a host drifts, so the fix is always "edit the canonical file, run
   this". Run: node tools/presentation/inline.js   (add --check to only verify)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');

const LIBS = [
  /* Which sports are a current product and which are retired. One list, read
     by the terminal (routes, live pools, record), the public record page, the
     desk's support boundary, and the two functions that spend odds credits —
     so retiring a sport is an edit to lib/edgedesk_sports.js, not a hunt. */
  {
    name: 'EDSPORTS',
    src: path.join(ROOT, 'lib', 'edgedesk_sports.js'),
    start: '/*__EDSPORTS_START__*/', end: '/*__EDSPORTS_END__*/',
    hosts: [path.join(ROOT, 'app.html'), path.join(ROOT, 'record.html'), path.join(FN, 'index.ts'),
      path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts'),
      path.join(ROOT, 'supabase', 'functions', 'close', 'index.ts')],
  },
  /* ORDER MATTERS. The FBS resolver's host is _intelligence.js, which is
     itself the source EDINTEL is copied FROM, so the two resolver blocks must
     land before EDINTEL is read — one pass then carries a fbs.js edit all the
     way to index.ts and app.html. */
  {
    name: 'EDFBSKEY',
    src: path.join(ROOT, 'football', 'fbs', 'fbs.js'),
    start: '/*__EDFBSKEY_START__*/', end: '/*__EDFBSKEY_END__*/',
    hosts: [path.join(FN, '_intelligence.js')],
  },
  {
    name: 'EDFBSRESOLVE',
    src: path.join(ROOT, 'football', 'fbs', 'fbs.js'),
    start: '/*__EDFBSRESOLVE_START__*/', end: '/*__EDFBSRESOLVE_END__*/',
    hosts: [path.join(FN, '_intelligence.js')],
  },
  /* The research library (PART 1 of index.ts): retrieval, evidence and its
     provenance, freshness windows, conflict detection, completeness,
     snapshots, findings, the scout and the thesis attack. index.ts named
     _lib.ts as its source of truth for a long time while no such file
     existed, so those 8,885 lines were the one layer of the desk with no
     canonical copy — and the only place they lived, the 2.2 MB single-file
     build, is past the size above which GitHub will not render a file at
     all. Extracted byte-for-byte; the deployed artifact did not change. */
  {
    name: 'EDLIB',
    src: path.join(FN, '_lib.ts'),
    start: '/*__EDLIB_START__*/', end: '/*__EDLIB_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDPRES',
    src: path.join(FN, '_presentation.js'),
    start: '/*__EDPRES_START__*/', end: '/*__EDPRES_END__*/',
    hosts: [path.join(FN, 'index.ts'), path.join(ROOT, 'app.html'), path.join(ROOT, 'brief.html'), path.join(ROOT, 'record.html')],
  },
  {
    name: 'EDINTEL',
    src: path.join(FN, '_intelligence.js'),
    start: '/*__EDINTEL_START__*/', end: '/*__EDINTEL_END__*/',
    hosts: [path.join(FN, 'index.ts'), path.join(ROOT, 'app.html')],
  },
  /* The typed tool layer, the normalised research packet, the label rules,
     the answer contract and the critic. Server-side only for now: the
     browser renders the structured answer the function returns rather than
     rebuilding it. */
  {
    name: 'EDRESEARCH',
    src: path.join(FN, '_research.js'),
    start: '/*__EDRESEARCH_START__*/', end: '/*__EDRESEARCH_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The TENNIS retrieval layer: intent routing for the nine tennis questions,
     the five bounded database calls that answer them, the answer contract
     (data timestamp, market timestamp, model version, what is missing, whether
     the match passes the research gates) and the rules the model is held to.
     Server-side only: the browser's own board reads the same views directly. */
  {
    name: 'EDTENNIS',
    src: path.join(FN, '_tennis.js'),
    start: '/*__EDTENNIS_START__*/', end: '/*__EDTENNIS_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The analyst layer: the matchup interaction engine, recent-form
     assessment, nearby-line sensitivity from the registered margin
     distributions, conditional scenarios, follow-up resolution and the
     investigation planner. Server-side only, like EDRESEARCH. */
  {
    name: 'EDANALYST',
    src: path.join(FN, '_analyst.js'),
    start: '/*__EDANALYST_START__*/', end: '/*__EDANALYST_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The pricing layer: the fair line from the validated blend, cover
     probability at any number, bet-to lines, per-side status, the ranked
     slate and the sizing rule. Server-side only. */
  {
    name: 'EDPRICE',
    src: path.join(FN, '_pricing.js'),
    start: '/*__EDPRICE_START__*/', end: '/*__EDPRICE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The board layer (Slice 7): scope in the reader's time zone, the eligible
     slate across sports, qualification and ranking of both pricing methods,
     the deterministic answer, follow-ups and the record. Server-side only. */
  {
    name: 'EDBOARD',
    src: path.join(FN, '_board.js'),
    start: '/*__EDBOARD_START__*/', end: '/*__EDBOARD_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The canonical research arithmetic and the per-game research contract
     (lib/research_core.js, lib/game_research.js) — the same files the
     terminal and the Collective load in the browser — so the desk reads a
     game through the one typed-evidence object rather than re-deriving it.
     ORDER MATTERS: game_research reads EDResearch when it loads. */
  {
    name: 'EDRCORE',
    src: path.join(ROOT, 'lib', 'research_core.js'),
    start: '/*__EDRCORE_START__*/', end: '/*__EDRCORE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDGAMERES',
    src: path.join(ROOT, 'lib', 'game_research.js'),
    start: '/*__EDGAMERES_START__*/', end: '/*__EDGAMERES_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The linemaker: one projection priced in every market (lib/edgedesk_fairline.js,
     the same file the Lines panel loads) and the desk's deterministic answers
     for team totals and alternate lines over the published sheets
     (football/linemaker/desk.js). ORDER MATTERS: both read EDResearchCore,
     and the desk reads EDFairLine. */
  {
    name: 'EDFAIRLINE',
    src: path.join(ROOT, 'lib', 'edgedesk_fairline.js'),
    start: '/*__EDFAIRLINE_START__*/', end: '/*__EDFAIRLINE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDLINESDESK',
    src: path.join(ROOT, 'football', 'linemaker', 'desk.js'),
    start: '/*__EDLINESDESK_START__*/', end: '/*__EDLINESDESK_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The desk layer: the sport-aware typed-evidence contract, the price
     verdict and ladder, the deterministic board ranking, intent, the
     conversation state, Similar Situations' gate and the short answer.
     Server-side only. */
  {
    name: 'EDDESK',
    src: path.join(FN, '_desk.js'),
    start: '/*__EDDESK_START__*/', end: '/*__EDDESK_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* Non-QB personnel availability for the desk: intent, the game and the
     player a question names, the deterministic answer, the packet block and
     the critic check that fails an injury turned into spread points. Its
     canonical copy lives with the scoring core in football/personnel/.
     Server-side only; the page reads the committed artifact directly. */
  {
    name: 'EDPERSONNEL',
    src: path.join(ROOT, 'football', 'personnel', 'desk.js'),
    start: '/*__EDPERSONNEL_START__*/', end: '/*__EDPERSONNEL_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* PLAYER PROPS for the desk. EDPROPS is the one prop core every surface
     prices with (lib/edgedesk_props.js — the Props page and the build load
     the SAME file), and EDPROPSDESK the deterministic answers over the
     committed Player Props boards (football/props/desk.js). ORDER MATTERS:
     the desk reads EDProps. Server-side copies of browser/Node files. */
  {
    name: 'EDPROPS',
    src: path.join(ROOT, 'lib', 'edgedesk_props.js'),
    start: '/*__EDPROPS_START__*/', end: '/*__EDPROPS_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDPROPSDESK',
    src: path.join(ROOT, 'football', 'props', 'desk.js'),
    start: '/*__EDPROPSDESK_START__*/', end: '/*__EDPROPSDESK_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* THE OPPORTUNITY LAYER (lib/edgedesk_opportunity.js): one object for a
     game market and a player prop, the per-event prop summary, the research
     score and the Card's exposure — the desk answers "what should I research
     in X vs Y" and "what is on my card" with the same code the page runs.
     ORDER MATTERS: it reads EDProps. */
  {
    name: 'EDOPP',
    src: path.join(ROOT, 'lib', 'edgedesk_opportunity.js'),
    start: '/*__EDOPP_START__*/', end: '/*__EDOPP_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The CFB explanation fact boundary (brief §90-91; docs/cfb-production/
     SECURITY.md §5): the only facts an explanation of a CFB game may use (the
     stored canonical projection and the governed decision), the tool-less
     prompt, the refusal audit and the deterministic fallback. Server-side
     only: the function explains; it never decides or changes a number. */
  {
    name: 'EDCFBEXPLAIN',
    src: path.join(FN, '_cfb_explain.js'),
    start: '/*__EDCFBEXPLAIN_START__*/', end: '/*__EDCFBEXPLAIN_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The personal research layer: the research state, what changed, the
     alert wording, the Top-5 explanations, the journal's grade and the
     decision-quality analytics. The SAME file the terminal loads as
     window.EDPersonal. ORDER MATTERS: it reads EDResearch (EDRCORE). */
  {
    name: 'EDPERSONAL',
    src: path.join(ROOT, 'lib', 'edgedesk_personal.js'),
    start: '/*__EDPERSONAL_START__*/', end: '/*__EDPERSONAL_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The desk's answers over the reader's own rows (watchlist, alerts,
     journal) and the shared slate research state. Server-side only. */
  {
    name: 'EDMINE',
    src: path.join(FN, '_mine.js'),
    start: '/*__EDMINE_START__*/', end: '/*__EDMINE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The staking layer (Slice 8): the bankroll policy, the reliability score,
     the conservative probability, expected value at the executable price,
     Kelly under every exposure cap, the portfolio rules, the card and the
     parlay policy. Server-side only, like EDBOARD. */
  {
    name: 'EDSTAKE',
    src: path.join(FN, '_stake.js'),
    start: '/*__EDSTAKE_START__*/', end: '/*__EDSTAKE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The fair-odds engine (lib/edgedesk_fairodds.js): typed units, exact
     decimals, venue fee schedules, contract and wager EV, the maximum entry
     price and the cross-venue comparison. ORDER MATTERS: EDAUDIT and EDQUANT
     read EDFAIR (and EDADAPT) when they run. Server-side copy of a lib file
     Node requires directly. */
  {
    name: 'EDFAIR',
    src: path.join(ROOT, 'lib', 'edgedesk_fairodds.js'),
    start: '/*__EDFAIR_START__*/', end: '/*__EDFAIR_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The sport adapters (lib/edgedesk_sport_adapters.js): capture status,
     model capability and tier, settlement rules and key roles per sport. */
  {
    name: 'EDADAPT',
    src: path.join(ROOT, 'lib', 'edgedesk_sport_adapters.js'),
    start: '/*__EDADAPT_START__*/', end: '/*__EDADAPT_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The adversarial auditor: a second, separate verification of the top
     candidates on a fresh read, with the bounded correction loop. */
  {
    name: 'EDAUDIT',
    src: path.join(FN, '_audit.js'),
    start: '/*__EDAUDIT_START__*/', end: '/*__EDAUDIT_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The quant desk: routing for the scan, contract and price checks,
     coverage, outage and explain-EV questions, and their deterministic
     answers. */
  {
    name: 'EDQUANT',
    src: path.join(FN, '_quant.js'),
    start: '/*__EDQUANT_START__*/', end: '/*__EDQUANT_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* Phase 2, the research system. ORDER MATTERS: EDAGENTS reads EDGRAPH,
     EDDISAGREE, EDFAIR and EDADAPT when it runs. The evidence graph, the
     model disagreement engine and the research budget are lib files Node
     requires directly; the agent roles live beside the auditor. */
  {
    name: 'EDGRAPH',
    src: path.join(ROOT, 'lib', 'edgedesk_evidence_graph.js'),
    start: '/*__EDGRAPH_START__*/', end: '/*__EDGRAPH_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDDISAGREE',
    src: path.join(ROOT, 'lib', 'edgedesk_disagreement.js'),
    start: '/*__EDDISAGREE_START__*/', end: '/*__EDDISAGREE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDBUDGET',
    src: path.join(ROOT, 'lib', 'edgedesk_research_budget.js'),
    start: '/*__EDBUDGET_START__*/', end: '/*__EDBUDGET_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDAGENTS',
    src: path.join(FN, '_agents.js'),
    start: '/*__EDAGENTS_START__*/', end: '/*__EDAGENTS_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The bet-history answer ("why did I lose money … singles or parlays?"). ORDER MATTERS: EDBETS reads
     EDPortfolio's exact decimals and the importer's vocabulary (ticket money fields, market-type inference)
     AT LOAD, so both are inlined first. The desk itself reads the caller's stored positions (fromPositions). */
  {
    name: 'EDPORTFOLIO',
    src: path.join(ROOT, 'lib', 'edgedesk_portfolio.js'),
    start: '/*__EDPORTFOLIO_START__*/', end: '/*__EDPORTFOLIO_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDPORTIMPORT',
    src: path.join(ROOT, 'lib', 'edgedesk_portfolio_import.js'),
    start: '/*__EDPORTIMPORT_START__*/', end: '/*__EDPORTIMPORT_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDREADY',
    src: path.join(ROOT, 'lib', 'edgedesk_readiness.js'),
    start: '/*__EDREADY_START__*/', end: '/*__EDREADY_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDORCH',
    src: path.join(ROOT, 'lib', 'edgedesk_orchestrator.js'),
    start: '/*__EDORCH_START__*/', end: '/*__EDORCH_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDEVIDENCE',
    src: path.join(ROOT, 'lib', 'edgedesk_evidence.js'),
    start: '/*__EDEVIDENCE_START__*/', end: '/*__EDEVIDENCE_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  {
    name: 'EDBETS',
    src: path.join(ROOT, 'lib', 'edgedesk_bet_history.js'),
    start: '/*__EDBETS_START__*/', end: '/*__EDBETS_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The MLB historical query layer. ORDER MATTERS, for the same reason the
     FBS resolver above does: its host is _mlbhist.js, which is itself the
     source EDMLBHIST is copied FROM, so this must land before EDMLBHIST is
     read. One pass then carries a lib/mlb_pitcher_history.js edit all the way
     to index.ts.

     It is the SAME file the browser loads with a <script> tag and the pipeline
     requires under Node, so a pitcher's K-BB% is computed once and reads the
     same on a profile page, in a chat answer and in the feature build. */
  {
    name: 'EDMLBQ',
    src: path.join(ROOT, 'lib', 'mlb_pitcher_history.js'),
    start: '/*__EDMLBQ_START__*/', end: '/*__EDMLBQ_END__*/',
    hosts: [path.join(FN, '_mlbhist.js')],
  },
  /* The MLB history layer: the router that decides a question is about the
     2016-2025 pitching record, the deterministic retrieval that runs whether
     or not the model has a tool loop, the prompt block, the seven tools and
     the critic checks that keep an archive from being read as tonight.
     Server-side only. */
  {
    name: 'EDMLBHIST',
    src: path.join(FN, '_mlbhist.js'),
    start: '/*__EDMLBHIST_START__*/', end: '/*__EDMLBHIST_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
  /* The MLB OFFENSIVE query layer. Same ordering rule as EDMLBQ above: its
     host is _mlboff.js, which is itself the source EDMLBOFFAI is copied from,
     so this must land before that is read. One pass then carries a
     lib/mlb_offense_history.js edit all the way to index.ts. */
  {
    name: 'EDMLBOFF',
    src: path.join(ROOT, 'lib', 'mlb_offense_history.js'),
    start: '/*__EDMLBOFF_START__*/', end: '/*__EDMLBOFF_END__*/',
    hosts: [path.join(FN, '_mlboff.js')],
  },
  /* The MLB offensive layer: the router that decides a question is about the
     2016-2025 hitting record, the deterministic retrieval, the prompt block,
     the eleven tools, and the critic checks that keep a completed-season
     archive from being read as tonight's lineup. Server-side only. */
  {
    name: 'EDMLBOFFAI',
    src: path.join(FN, '_mlboff.js'),
    start: '/*__EDMLBOFF_AI_START__*/', end: '/*__EDMLBOFF_AI_END__*/',
    hosts: [path.join(FN, 'index.ts')],
  },
];

function block(src, START, END) {
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0 || b <= a) return null;
  return src.slice(a, b + END.length);
}

function main(check) {
  let drift = 0, hosts = 0;
  for (const lib of LIBS) {
    const canonical = block(fs.readFileSync(lib.src, 'utf8'), lib.start, lib.end);
    if (!canonical) throw new Error(lib.name + ': canonical file has no marker block');
    for (const host of lib.hosts) {
      if (!fs.existsSync(host)) { console.log('skip (missing): ' + path.relative(ROOT, host)); continue; }
      hosts++;
      const text = fs.readFileSync(host, 'utf8');
      const have = block(text, lib.start, lib.end);
      if (!have) { console.log('NO ' + lib.name + ' MARKERS: ' + path.relative(ROOT, host)); drift++; continue; }
      if (have === canonical) { console.log('in sync: ' + lib.name + ' -> ' + path.relative(ROOT, host)); continue; }
      drift++;
      if (check) { console.log('DRIFT: ' + lib.name + ' -> ' + path.relative(ROOT, host)); continue; }
      fs.writeFileSync(host, text.replace(have, function () { return canonical; }));
      console.log('updated: ' + lib.name + ' -> ' + path.relative(ROOT, host));
    }
  }
  if (check && drift) process.exit(1);
  return hosts;
}
module.exports = { LIBS: LIBS, main: main };
if (require.main === module) main(process.argv.includes('--check'));

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

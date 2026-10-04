#!/usr/bin/env node
/* ============================================================================
   ONE STATUS, EVERY VIEW (audit 2026-09-30 #6).

   Pitt @ Virginia Tech read one thing on the Desk, another in Top Research
   Priorities, a third in the research-flags table and a fourth in the export.
   Each view carried its own copy of the rule: the board word, the Desk's
   row flags (thin from the engine's PASS_LOW_CONFIDENCE, fault from the guard
   gap alone), the export's classifier, the press brief's. There is now one
   classifier — lib/edgedesk_canon.js researchStatus — and every view reads
   its result.

   This boots the REAL football module out of app.html (tools/football/
   _module.js), stages one board of college games that land on different
   canonical statuses — Pitt @ Virginia Tech with Virginia Tech in a REGIME
   CHANGE, an aligned game, a research gap, an orientation flip, thin data —
   and reads each game's label through the page's own functions:

     board        fbP4Row(u).st                 (the board word)
     research     fbP4ViewFor(u,p,mkt).research_label   (the card, the Desk)
     desk         fbP4DeskHTML(rows)            (the CFB research desk counts)
     rows         fbGameRows() row .cs / thin / fault / stale (the Research
                  Desk's picks, the overview, the reading order's gates)
     priorities   fbWrCandidate(...).status and fbP4TopItems(...)
     flags        fbP4QueueHTML(rows)           (RESEARCH FLAGS)
     export       fbP4FbsTail(u,p,mkt)          (the CSV's board_status)
     counters     fbResearchStatusOfRow(row)
     offline      football/cfb_p4/export_csv.js boardStatus (same rule)
     press        tools/football/press_brief.js statusFor (reads the word)

   and holds that they are the SAME status, game by game.

     node tools/football/label_parity.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./_module.js');
const ROOT = M.ROOT;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 500); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function section(t) { console.log('  · ' + t); }

const BOOT = M.boot({ probe: ['fbP4Row', 'fbP4ViewFor', 'fbP4StatusFor', 'fbGameRows', 'fbTodayItems', 'fbWrCandidate', 'fbP4TopItems',
  'fbP4QueueHTML', 'fbP4FbsTail', 'fbResearchStatusOfRow', 'fbP4DeskHTML', 'fbP4Request', 'fbP4Market', 'fbP4ContractFor'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
['function _escHtml(', 'function edEsc(', 'function edAttrJs(', 'function ago('].forEach((sig) => {
  const at = BOOT.app.indexOf(sig);
  if (at < 0) { console.error('app.html no longer defines ' + sig); process.exit(1); }
  vm.runInContext(BOOT.app.slice(at, BOOT.app.indexOf('\n', at)), win);
});
win.whenLabel = win.whenLabel || ((iso) => String(iso));
win.edEvent = win.edEvent || (() => {});
const E = M.loadEngine(win, ROOT);
/* the libraries the page loads with <script> tags: the one classifier, the
   research view, the shared research layer and the reading order */
['lib/edgedesk_canon.js', 'lib/cfb_research_view.js', 'lib/research_core.js', 'lib/research_eval.js', 'lib/game_research.js', 'lib/research_priority.js']
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f }));
const C = win.EDCanon;
chk('the page\'s libraries are loaded (the classifier, the view, the research layer, the reading order)',
  !!(C && win.EDCfbResearchView && win.EDGameResearch && win.EDResearchPriority));

/* ---- one board ------------------------------------------------------------ */
/* the regime-change record the board loads (football/coaching/regime.json):
   Virginia Tech, as the committed record has it — the engine prices it on the
   regime curve and the research gate blocks it until 6 games */
const RJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'coaching', 'regime.json'), 'utf8'));
chk('the committed regime record has Virginia Tech in a regime change (the audit\'s game)', RJ.by_team.virginiatech && RJ.by_team.virginiatech.regime_change === true);
win.FB.p4.art = { at: Date.now(), regime: { season: 2026, by_team: { virginiatech: RJ.by_team.virginiatech } } };
win.FB.p4._ictx = null;

/* id, home, away, target home margin, market spread (cfb.lines: negative =
   the home side laying points), input coverage, the status it should land on */
const GAMES = [
  ['PV', 'Virginia Tech', 'Pittsburgh', 1.0, 2.0, 0.82, 'INVESTIGATE'],      /* 3-pt gap, VT in a regime change: blocked */
  ['AL', 'Duke', 'Wake Forest', 3.5, -3.0, 0.82, 'MARKET_ALIGNED'],         /* 0.5-pt gap */
  ['RS', 'Georgia', 'Florida', 6.0, -3.0, 0.82, 'WORTH_RESEARCHING'],        /* 3-pt gap, no regime */
  ['OF', 'Syracuse', 'UConn', 12.0, 8.0, 0.82, 'DATA_FAULT'],               /* 20 pts apart, 4 when flipped */
  ['TH', 'Kansas', 'Baylor', 5.0, -1.0, 0.05, null]                          /* thin inputs: whatever the rule says */
];
const st = E.newState();
st.canonicalRatingMeta = { schema: 'staged', staged: true };
win.FB.p4.engineEfficiency = { schema: 'edgedesk_cfb_engine_efficiency_v1', staged: true };
win.FB.p4.efficiencyReplay = { games: 0, team_rows: 0, missing: 0, error: null, late_joined: 0 };
win.FB.p4.schedFallback = [];
st.canonicalRatings = {};
GAMES.forEach((g) => { st.canonicalRatings[E.normKey(g[1])] = { value: 0 }; st.canonicalRatings[E.normKey(g[2])] = { value: 0 }; });
win.FB.p4.state = st;
const kick = new Date(Date.now() + 48 * 3600e3).toISOString();
const units = GAMES.map((g) => {
  const stage = { home: g[1], away: g[2], game_id: g[0], market_spread: g[4], start_date: kick, home_conference: 'ACC', away_conference: 'ACC' };
  M.stageGame(win, stage);
  const u0 = M.stageGame(win, stage);
  const rest = E.projectGame(T.fbP4Request(u0)).model.fair_spread;
  st.canonicalRatings[E.normKey(g[1])].value = g[3] - rest;
  return M.stageGame(win, stage);
});
win.FB.p4.up = units;
win.FB.p4.lines = {};
GAMES.forEach((g) => { if (g[4] != null) win.FB.p4.lines[g[0]] = { game_id: g[0], provider: 'consensus', spread: g[4] }; });
win.FB.p4.loadedAt = Date.now();
win.FB.p4._pc = null; win.FB.p4._proj = {}; win.FB.p4._mkt = {};
units.forEach((u, i) => {
  win.FB.p4._mkt[u.g.game_id] = T.fbP4Market(u);
  win.FB.p4._proj[u.g.game_id] = E.projectGame(T.fbP4Request(u));
  T.fbP4ContractFor(u);
  u._contract.v = { rows: [], summary: { input_coverage: GAMES[i][5], known: Math.round(GAMES[i][5] * 17), applicable: 17 } };
  u._rv = null;
});
win.FB.p4._projAt = win.FB.p4.loadedAt;
win.FB.p4rec = win.FB.p4rec || {}; win.FB.p4rec.data = null;
win.FB.p4seen = { base: null, read: true, wroteAt: 0 };

/* ---- every view, game by game -------------------------------------------- */
section('1. the staged board lands where the scenarios say');
const boardRows = units.map((u) => T.fbP4Row(u));
const byId = {}; boardRows.forEach((r) => { byId[r.gid] = r; });
GAMES.forEach((g) => {
  if (!g[6]) return;
  const r = byId[g[0]];
  chk(g[2] + ' @ ' + g[1] + ': the board reads ' + g[6], r && r.st && r.st.key === g[6], r && { key: r.st.key, rule: r.st.rule, t: r.st.t, gap: r.gap });
});
chk('Pitt @ Virginia Tech is INVESTIGATE because of the regime change, not the gap', byId.PV.st.rule === 'regime_change' && /REGIME CHANGE: Virginia Tech/.test(byId.PV.st.reason || ''), byId.PV.st);
chk('Syracuse @ UConn is the orientation invariant\'s DATA FAULT', byId.OF.st.rule === 'orientation_flip', byId.OF.st);

section('2. one status in every view');
const gameRows = T.fbGameRows().filter((r) => r.sport === 'p4');
const ix = {}; units.forEach((u) => { ix[String(u.g.game_id)] = u; });
const visible = boardRows;
const top = T.fbP4TopItems(visible);
const topIds = top ? top.items.map((x) => x.candidate.gid) : [];
const queue = T.fbP4QueueHTML(visible);
const desk = T.fbP4DeskHTML(visible);
GAMES.forEach((g) => {
  const id = g[0], label = g[2] + ' @ ' + g[1];
  const b = byId[id], key = b.st.key, word = b.st.t;
  chk(label + ': the board word is the canon\'s name for its status', word === C.boardWord({ key, rule: b.st.rule }), [word, key]);
  const v = T.fbP4ViewFor(b.u, b.p, b.mkt);
  chk(label + ': the research view (the card, the CFB desk) reads the same canonical status', v.research_label.canonical_key === key && C.fromResearchView(v.research_label) === key,
    [v.research_label.key, v.research_label.canonical_key, key]);
  const gr = gameRows.find((r) => r.gid === id);
  chk(label + ': the overview/Desk row carries the same status, and its thin/fault/stale are read off it', gr && gr.cs && gr.cs.key === key
    && gr.thin === (key === 'LIMITED_DATA') && gr.fault === (key === 'DATA_FAULT' || key === 'MARKET_FAULT'), gr && { cs: gr.cs && gr.cs.key, thin: gr.thin, fault: gr.fault, stale: gr.stale });
  const cand = T.fbWrCandidate(gr, ix);
  chk(label + ': Top Research Priorities\' candidate carries the board word', cand.status === word, [cand.status, word]);
  const elig = win.EDResearchPriority.eligibility(cand);
  chk(label + ': …and is eligible for the reading order only if the status is a rankable research read', !elig.eligible || b.st.rankable !== false, [elig, b.st.rankable]);
  chk(label + ': …a DATA FAULT or LIMITED DATA game never appears in Top Research Priorities', !(key === 'DATA_FAULT' || key === 'LIMITED_DATA' || key === 'MARKET_FAULT') || topIds.indexOf(id) < 0, topIds);
  const inTop = top && top.items.find((x) => x.candidate.gid === id);
  if (inTop) chk(label + ': …and where it appears, its label is the research view\'s canonical one', inTop.candidate.view.research_label.canonical_key === key);
  const tail = T.fbP4FbsTail(b.u, b.p, b.mkt);
  chk(label + ': the CSV export\'s board_status is the board word', tail[14] === word, [tail[14], word]);
  chk(label + ': the counters read the same status', T.fbResearchStatusOfRow(gr) === key, [T.fbResearchStatusOfRow(gr), key]);
  const inQueue = queue.indexOf('fbP4Gate(\'' + id + '\')') >= 0;
  if (inQueue) chk(label + ': RESEARCH FLAGS prints the board word beside the flags', queue.indexOf('data-status="' + word + '"') >= 0, word);
  chk(label + ': RESEARCH FLAGS never lists a game the classifier excludes from ranking', !inQueue || b.st.rankable !== false, [b.st.key, b.st.rankable]);
});
chk('Pitt @ Virginia Tech reads INVESTIGATE (regime change) in every view: board, card, Desk row, Top Priorities, CSV, counters', (() => {
  const b = byId.PV, gr = gameRows.find((r) => r.gid === 'PV'), c = T.fbWrCandidate(gr, ix);
  return b.st.t === 'INVESTIGATE' && T.fbP4ViewFor(b.u, b.p, b.mkt).research_label.canonical_key === 'INVESTIGATE' && gr.cs.key === 'INVESTIGATE'
    && c.status === 'INVESTIGATE' && c.qualifiers.indexOf('REGIME_CHANGE') >= 0 && T.fbP4FbsTail(b.u, b.p, b.mkt)[14] === 'INVESTIGATE' && T.fbResearchStatusOfRow(gr) === 'INVESTIGATE';
})());
chk('the CFB research desk counts each label once, off the same research view', (() => {
  const tally = {};
  boardRows.forEach((r) => { const k = T.fbP4ViewFor(r.u, r.p, r.mkt).research_label.key; tally[k] = (tally[k] || 0) + 1; });
  return Object.keys(tally).every((k) => { const L = win.EDCfbResearchView.LABELS[k]; return desk.indexOf('<b>' + tally[k] + '</b> <span class="rv-lab ' + L.tone + '">' + L.label + '</span>') >= 0; });
})(), desk.slice(0, 400));

section('3. the Research Desk picks from the same status');
{
  const items = T.fbTodayItems(T.fbGameRows());
  const big = items.find((i) => i.k === 'Largest spread disagreement');
  chk('the Desk\'s largest disagreement is never a faulted game (the orientation flip is 20 pts apart and is not picked)', !big || big.r.gid !== 'OF', big && big.r.gid);
  if (big) chk('…and its note names the board word', big.note.indexOf('Status: ' + byId[big.r.gid].st.t) >= 0, big.note);
  const dq = items.find((i) => i.k === 'Data-quality warning');
  chk('the Desk\'s data warning is the orientation flip, with the canonical reason (not "past the guard bound": it is not)', dq && dq.r.gid === 'OF' && /possible orientation flip/.test(dq.note) && !/guard bound/.test(dq.note), dq && [dq.r.gid, dq.note]);
}

section('4. the files read the same rule');
{
  /* the offline exporter: the same classifier over the same projection */
  const EX = fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'), 'utf8');
  const bs = EX.slice(EX.indexOf('function boardStatus('), EX.indexOf('function fbsTail('));
  chk('football/cfb_p4/export_csv.js boardStatus classifies nothing itself: canon researchStatusFromProjection, named by boardWord', /CANON\.researchStatusFromProjection/.test(bs)
    && /CANON\.boardWord/.test(bs) && !/>= *7|> *21|gap/.test(bs.replace(/guard_gap/g, '')), bs.slice(0, 300));
  const b = byId.PV;
  chk('…and over the Pitt @ Virginia Tech projection it lands on the same word the board shows (at the board\'s reliability)',
    C.boardWord(C.researchStatusFromProjection(b.p, b.mkt, { reliability: T.fbP4ViewFor(b.u, b.p, b.mkt).reliability.pct, thresholds: { guard_gap: 21 } })) === b.st.t);
  /* the research terminal's older seven-word status (its brief and the record
     print it) never says more than the one classifier: football/cfb_terminal/
     board.json, as built */
  const TB = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), 'utf8'));
  const SEVEN = { DATA_FAULT: ['DATA_FAULT'], MARKET_FAULT: ['INVESTIGATE', 'DATA_FAULT'], INVESTIGATE: ['INVESTIGATE', 'DATA_FAULT'], NO_MARKET: ['NO_MARKET', 'DATA_FAULT'] };
  const bad = (TB.rows || []).filter((r) => (SEVEN[r.research_status] && SEVEN[r.research_status].indexOf(r.status) < 0)
    || (r.research_status === 'LIMITED_DATA' && ['BET', 'RESEARCH', 'WAIT'].indexOf(r.status) >= 0));
  chk('the research terminal\'s seven-word status agrees with the canonical research status on every published row', (TB.rows || []).length > 0 && bad.length === 0,
    bad.map((r) => r.away + ' @ ' + r.home + ': ' + r.status + ' vs ' + r.research_status));
  const pv = (TB.rows || []).find((r) => r.home === 'Virginia Tech' && r.away === 'Pittsburgh');
  /* the committed board is whatever snapshot the last build saw: with a
     current quote Pitt @ Virginia Tech is INVESTIGATE (the regime change,
     named); with a stale one it is NO MARKET. Never RESEARCH, WAIT or BET
     while Virginia Tech is in a regime change (the staged board above holds
     the INVESTIGATE case on fixed inputs) */
  chk('…Pitt @ Virginia Tech never reads RESEARCH, WAIT or BET in the terminal: its status is its research status\'s word', !pv || (['RESEARCH', 'WAIT', 'BET'].indexOf(pv.status) < 0
    && ((pv.research_status === 'INVESTIGATE' && pv.status === 'INVESTIGATE' && /REGIME CHANGE|implausible EV/.test(pv.status_reason || ''))
      || (pv.research_status === 'NO_MARKET' && pv.status === 'NO_MARKET') || (pv.research_status === 'DATA_FAULT' && pv.status === 'DATA_FAULT'))),
    pv && [pv.status, pv.research_status, pv.status_reason]);
  /* the press brief prints the word it is given and classifies nothing */
  const PB = require(path.join(ROOT, 'tools', 'football', 'press_brief.js'));
  chk('the press brief prints the board word it reads from the slate CSV', GAMES.every((g) => {
    const w = byId[g[0]].st.t; const s = PB.statusFor({ board_status: w, spread_gap: byId[g[0]].gap });
    return s.word === w;
  }));
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'label parity — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }

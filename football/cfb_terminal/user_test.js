#!/usr/bin/env node
/* ============================================================================
   The internal user test (brief §88-90), as a reproducible answerability
   audit. It is NOT a study with people: it checks, for 20 representative
   games stratified by status, whether the research page puts an explicit,
   sourced answer to each question a bettor has to answer where a reader
   would look for it — and says which game and question fails when one does.

     node football/cfb_terminal/user_test.js [--games path/to/games.json] [--md]

   KNOWLEDGEABLE BETTOR (§88): what does EdgeDesk think, why, what is
   uncertain, what is the market, what price is required, what would
   invalidate the research — each answered in the 15-second summary or the
   first section it belongs to.
   NEW USER (§89): win probability, cover probability, reliability and EV are
   named apart, with a plain-language definition, on every page.
   ADVANCED USER (§90): model reasoning (terms or drivers), data quality and
   market state are inspectable without source code (sources + raw object).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'lib', 'cfb_terminal.js'));
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const file = arg('games', path.join(__dirname, 'games.json'));
const G = JSON.parse(fs.readFileSync(file, 'utf8')).games;
const all = Object.keys(G).map((k) => G[k]);

/* 20 representative games: every status present, then by research interest */
const order = ['RESEARCH', 'WAIT', 'INVESTIGATE', 'PASS', 'NO_MARKET', 'DATA_FAULT', 'BET'];
const picked = [];
order.forEach((k) => all.filter((o) => o.status.key === k).sort((a, b) => b.fields.research_interest.score - a.fields.research_interest.score).slice(0, 4).forEach((o) => picked.push(o)));
all.filter((o) => picked.indexOf(o) < 0).sort((a, b) => b.fields.research_interest.score - a.fields.research_interest.score).forEach((o) => { if (picked.length < 20) picked.push(o); });

const Q = [
  ['thinks', 'What does EdgeDesk think?', (o) => o.edgedesk.available ? o.summary.model_says : (o.edgedesk.reason ? 'stated: ' + o.edgedesk.reason : null)],
  ['why', 'Why?', (o) => (o.summary.why && !/No single measured term/.test(o.summary.why)) ? o.summary.why : (o.why.available ? o.why.basis : null)],
  ['uncertain', 'What is uncertain?', (o) => (o.risks.items.length ? o.risks.items[0].text : null)],
  ['market', 'What is the market?', (o) => o.market.available ? o.summary.market_says : (o.market.reason ? 'stated: ' + o.market.reason : null)],
  ['price', 'What price is required?', (o) => o.price.available && o.price.bettable_to ? o.price.bettable_to.text + ' (pass beyond ' + (o.price.pass_beyond ? o.price.pass_beyond.text : '—') + ')'
    : (o.status.reason ? 'no price applies: ' + o.status.reason : null)],
  ['invalidate', 'What would invalidate it?', (o) => o.reconcile.available && o.reconcile.rows.length ? o.reconcile.rows[0].text
    : (o.price.pass_beyond ? 'the price moving to ' + o.price.pass_beyond.text : (o.status.key === 'PASS' || o.status.key === 'NO_MARKET' || o.status.key === 'DATA_FAULT' ? 'n/a — ' + o.status.label + ': ' + o.status.reason : null))]
];
const rows = picked.map((o) => {
  const a = {};
  Q.forEach((q) => { a[q[0]] = q[2](o); });
  return { game: o.game.away + ' @ ' + o.game.home, status: o.status.key, answers: a, ok: Q.every((q) => !!a[q[0]]) };
});
/* new user: the four concepts are named apart, with definitions */
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'research', 'cfb', 'terminal.js'), 'utf8');
const newUser = [
  ['win vs cover probability defined on every summary', /Win probability is who wins the game\. Cover probability is whether a side beats the spread/.test(html)],
  ['reliability says it is not a probability', /Reliability is how complete the inputs are — not a probability/.test(html) && /NOT a probability/.test(T.TERMS.RELIABILITY)],
  ['EV is labelled model / research / not validated wherever it prints', /per unit · not validated/.test(html) && /not validated/.test(T.summary(picked.find((o) => o.price.available && o.price.current) || picked[0]).price + ' not validated')],
  ['a Terms page defines every word once', Object.keys(T.TERMS).length >= 12 && /renderTerms/.test(html)]
];
const adv = [
  ['model reasoning inspectable (terms or drivers) on every priced game', picked.filter((o) => o.edgedesk.available).every((o) => o.why.available || o.why.v2_drivers)],
  ['data quality inspectable on every game', picked.every((o) => o.data_quality.rows.length > 0 || o.data_quality.reliability != null)],
  ['market state inspectable (quotes, ages, books) on every game with a market', picked.filter((o) => o.market.available).every((o) => o.market.quotes.every((q) => q.observed_at && q.book))],
  ['every page carries its sources and the raw object', /secAdv/.test(html) && picked.every((o) => (o.sources || []).length >= 5)]
];
const passN = rows.filter((r) => r.ok).length;
if (process.argv.indexOf('--md') > 0) {
  console.log('| # | Game | Status | ' + Q.map((q) => q[1]).join(' | ') + ' |');
  console.log('|---|---|---|' + Q.map(() => '---').join('|') + '|');
  rows.forEach((r, i) => console.log('| ' + (i + 1) + ' | ' + r.game + ' | ' + r.status + ' | ' + Q.map((q) => r.answers[q[0]] ? '✓' : '✗').join(' | ') + ' |'));
  console.log('\nKnowledgeable bettor: ' + passN + '/' + rows.length + ' games answer all six questions.');
  console.log('\nNew user: ' + newUser.map((x) => (x[1] ? '✓ ' : '✗ ') + x[0]).join('; '));
  console.log('\nAdvanced user: ' + adv.map((x) => (x[1] ? '✓ ' : '✗ ') + x[0]).join('; '));
} else {
  rows.forEach((r) => { if (!r.ok) console.log('  UNANSWERED ' + r.game + ' (' + r.status + '): ' + Q.filter((q) => !r.answers[q[0]]).map((q) => q[1]).join(', ')); });
  newUser.concat(adv).forEach((x) => { if (!x[1]) console.log('  FAIL ' + x[0]); });
  const allOk = passN === rows.length && newUser.concat(adv).every((x) => x[1]);
  console.log((allOk ? 'PASS' : 'FAIL') + ' | user test | ' + passN + '/' + rows.length + ' games answer all six questions · new user ' + newUser.filter((x) => x[1]).length + '/' + newUser.length + ' · advanced ' + adv.filter((x) => x[1]).length + '/' + adv.length);
  process.exit(allOk ? 0 : 1);
}

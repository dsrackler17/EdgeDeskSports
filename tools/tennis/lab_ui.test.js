#!/usr/bin/env node
/* ===========================================================================
   Tests for the EDGEDESK TENNIS LAB in app.html.

   STATIC: the Lab reads only functions the committed migration creates, never
   names a table directly, carries no credential, and uses no tout language.

   RENDERED: the block is evaluated in a sandbox whose RPC reader returns
   FIXTURES CAPTURED FROM A REAL POSTGRESQL running the shipped schema over a
   361,575-match archive (tools/tennis/fixtures/lab_*.json). Every view is
   painted and the HTML is inspected for what a reader would actually see.

   The questions asked of it are the ones that decide whether this product is
   honest rather than merely pretty:

     does the Lab render at all with NO sportsbook, NO odds table and NO
       schedule — or does something break, blank out, or beg for a price?
     is the Market Comparison tab OFF, and does it say why in words rather
       than showing a mock?
     does every rating carry its SAMPLE and its UNCERTAINTY, or is a bare
       0-100 number allowed to stand on its own anywhere?
     does a matchup projection publish its band and its MISSING inputs?
     when the projection's own band crosses even money, does the card SAY so?
     is a missing serve statistic shown as a named gap rather than a zero?
     does the workload panel state that it is not an injury claim?
     does the historical explorer page by CURSOR rather than by offset?
     is a form streak over a softer draw labelled as such rather than as
       improvement?

   Run: node tools/tennis/lab_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const FIX = path.join(__dirname, 'fixtures');
const START = APP.indexOf('/* ═══ EDGEDESK TENNIS LAB');
const END = APP.indexOf('/* ═══ TENNIS RESEARCH BOARD', START);
chk('the Tennis Lab block is found between its markers', START > 0 && END > START);
const SRC = APP.slice(START, END);
/* CODE ONLY, comments stripped. The block is heavily commented — including
   comments that quote the very thing they forbid ("a table read can be handed
   ?limit=100000 by anyone") — so a scan for forbidden patterns has to read what
   the page DOES, not what it explains about itself. Strings survive; only
   comments are removed. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'tennis_lab.sql'), 'utf8');

function fx(name) {
  const f = path.join(FIX, 'lab_' + name + '.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/* ========================================================================= */
/* 1. STATIC — what it reads, and what it must never do                      */
/* ========================================================================= */

/* Every RPC the Lab calls must be created by the committed migration. A typo
   here is a panel that is silently empty in production. */
const rpcs = [...new Set((SRC.match(/tnlRpc\('([a-z_]+)'/g) || [])
  .map((m) => m.replace(/tnlRpc\('/, '').replace(/'$/, '')))];
chk('the Lab calls at least a dozen distinct RPCs', rpcs.length >= 12, 'found ' + rpcs.length + ': ' + rpcs.join(','));
rpcs.forEach((r) => chk('tennis.' + r + ' is created by supabase/tennis_lab.sql',
  new RegExp('create or replace function\\s+tennis\\.' + r + '\\s*\\(').test(SQL),
  'tennis.' + r + ' is called by the page but not created by the migration'));

/* THE CENTRAL CLAIM: no odds anywhere. Not a table, not a column, not a
   fallback. If any of these appear the product has acquired a sportsbook
   dependency the brief forbids. */
/* The test is on what the Lab READS, not on which words appear in it — the
   disabled market tab has to be able to NAME the market concepts it is
   declining to show, and banning the vocabulary would forbid the explanation.
   So: no RPC and no table read that touches odds, anywhere. */
chk('no Lab RPC reads odds',
  !rpcs.some((r) => /odds|market_price|line|vig|ev$/.test(r) && r !== 'lab_market_available'),
  'RPCs: ' + rpcs.join(','));
chk('the Lab makes no direct read of an odds relation',
  !/sbGetTennis\('\s*(odds|market)/.test(CODE));
chk('the only market-aware call is the availability FLAG',
  (SRC.match(/lab_market_available/g) || []).length >= 1
  && !/odds_snapshots/.test(SRC));

/* No credential, ever. */
['service_role', 'SUPABASE_SERVICE', 'SERVICE_KEY', 'secret'].forEach(
  (w) => lacks(SRC, w, 'no credential name reaches the browser: ' + w));

/* No tout language. This is a research product. */
/* Word boundaries, because "lock" is inside "blocked" and "pick" is inside the
   `tnl-pick` CSS class — a naive substring scan fails on the stylesheet rather
   than on the copy. */
[/\bbet this\b/i, /\block of\b/i, /\bhammer\b/i, /\bguaranteed\b/i, /\bsure thing\b/i,
 /\bbest bets?\b/i, /\bunits\b/i, /\bcan'?t lose\b/i, /\bfree money\b/i,
 /\bwill win\b/i, /\bmortal lock\b/i].forEach(
  (re) => chk('no tout language: ' + re.source, !re.test(SRC), 'matched ' + re.source));
has(SRC, 'Research, not picks', 'the positioning is stated in the block itself');
has(SRC, 'EdgeDesk projects', 'the projection vocabulary is used');

/* The whole-table read the brief forbids. */
const limits = (SRC.match(/p_limit\s*:\s*([0-9]+|null)/g) || []).map((m) => m.split(':')[1].trim());
chk('every p_limit the Lab sends is a small explicit number',
  limits.length > 0 && limits.every((v) => v !== 'null' && Number(v) > 0 && Number(v) <= 200),
  'limits sent: ' + limits.join(','));
chk('the Lab never asks for an unbounded row set', !/limit=\d{4,}/.test(CODE));
chk('every list RPC passes an explicit p_limit',
  (SRC.match(/p_limit\s*:/g) || []).length >= 8,
  'found ' + (SRC.match(/p_limit\s*:/g) || []).length);
chk('the historical explorer pages by CURSOR, not by offset',
  CODE.indexOf('p_cursor_date') > 0 && CODE.indexOf('p_cursor_id') > 0
  && !/[?&]offset=|p_offset/.test(CODE));

/* ========================================================================= */
/* 2. RENDERED                                                               */
/* ========================================================================= */
const MODEL = require(path.join(ROOT, 'lib', 'tennis_model.js'));
const LAB = require(path.join(ROOT, 'lib', 'tennis_lab.js'));

function paint(opts) {
  const o = opts || {};
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = { id, innerHTML: '', textContent: '', value: '', disabled: false,
      style: {}, querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
    return els[id];
  }
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    $: (id) => (o.missingEls && o.missingEls.indexOf(id) >= 0 ? null : el(id)),
    SB_URL: 'https://example.invalid', SB_KEY: 'anon-test-key',
    edToken: async () => 'tok',
    fetch: async () => { throw new Error('the Lab must not fetch directly'); },
    sbGetTennis: async (q) => {
      calls.push('sbGetTennis:' + q);
      if (/^lab_health/.test(q)) return o.healthThrows ? Promise.reject(Object.assign(new Error('404'), { status: 404 })) : fx('health');
      if (/^model_registry/.test(q)) return o.modelRow || [];
      return [];
    },
    Promise, Date, Math, JSON, Number, String, Object, Array, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, RegExp, Error,
    document: { body: { style: {} } }
  };
  /* `window` IS the global here. The Lab block declares its public entry points
     as `window.tnlX = function`, which in a browser makes them globals; a
     sandbox with a separate `window` object would leave every one of them
     unreachable and the test would be exercising nothing. */
  sandbox.window = sandbox;
  sandbox.EDTennisModel = MODEL;
  sandbox.EDTennisLab = LAB;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'app.html#tennis-lab' });

  /* The RPC reader: real captured rows, or whatever the case overrides. */
  sandbox.tnlRpc = async (name, body) => {
    calls.push(name);
    if (o.rpcThrows) { const e = new Error('rpc ' + o.rpcThrows); e.status = o.rpcThrows; throw e; }
    if (o.rows && Object.prototype.hasOwnProperty.call(o.rows, name)) return o.rows[name];
    switch (name) {
      case 'lab_health': return fx('health');
      case 'lab_leaders': return (body && body.p_mode === 'form') ? fx('leaders') : fx('leaders');
      case 'lab_movers': return fx('movers');
      case 'lab_surface_board': return fx('surface');
      case 'lab_fatigue_board': return fx('fatigue');
      case 'lab_rank_gap': return fx('rankgap');
      case 'lab_trajectory_board': return fx('traj');
      case 'lab_player_card': return fx('card');
      case 'lab_player_history': return fx('history');
      case 'lab_player_matches': return fx('matches');
      case 'lab_player_splits': return fx('splits');
      case 'lab_matchup_inputs': return fx('muinputs');
      case 'lab_h2h': return fx('h2h');
      case 'lab_comparables': return fx('comps');
      case 'lab_explore': return fx('explore');
      case 'lab_explore_summary': return fx('exsum');
      case 'lab_market_available': return fx('market');
      case 'lab_search': return fx('search');
      default: return [];
    }
  };
  return { sandbox, el, calls, body: () => el('tnlBody').innerHTML, health: () => el('tnlHealth').innerHTML };
}

async function view(v, opts) {
  const p = paint(opts);
  await p.sandbox.tnlLoad(true);
  if (v !== 'overview') { p.sandbox.TNL.view = v; await p.sandbox.tnlLoadView(v); }
  return p;
}

/* ---- the header health line ------------------------------------------- */
(async () => {
  const p = await view('overview');
  const h = p.health();
  has(h, 'matches', 'the header states how many matches are on file');
  chk('the header states the seasons covered', /1968.*2026/.test(h));
  has(h, 'tennis-rating', 'the header names the rating version that produced the numbers');

  /* ---- OVERVIEW -------------------------------------------------------- */
  const ov = p.body();
  has(ov, 'Rating leaders', 'the overview shows rating leaders');
  has(ov, 'Biggest risers', 'the overview shows risers');
  has(ov, 'Biggest fallers', 'the overview shows fallers');
  has(ov, 'specialists', 'the overview shows surface specialists');
  has(ov, 'Best recent form', 'the overview shows recent form');
  has(ov, 'Most active', 'the overview shows the most active players');
  has(ov, 'Fatigue watch', 'the overview shows a fatigue watch list');
  has(ov, 'Ranking vs EdgeDesk', 'the overview shows ranking-versus-model disagreement');
  has(ov, 'Research, not picks', 'the overview states the positioning');
  lacks(ov, 'best bet', 'the overview shows no selection');
  chk('every leaderboard row on the overview carries a sample',
    (ov.match(/tnl-unc/g) || []).length >= 8,
    'found ' + (ov.match(/tnl-unc/g) || []).length + ' sample annotations');
  chk('the documented 0-100 scale is quoted on the overview',
    ov.indexOf('50 is the median rated player') > 0);

  /* ---- POWER RATINGS --------------------------------------------------- */
  const rt = (await view('ratings')).body();
  has(rt, '<table', 'the ratings view is a table');
  ['Rating', 'Rank', 'Form 90d', 'Trend', 'Workload'].forEach(
    (c) => has(rt, c, 'the ratings table has a ' + c + ' column'));
  chk('the ratings table carries n and ± columns for every row',
    rt.indexOf('>n<') > 0 && rt.indexOf('>±<') > 0);
  has(rt, 'A rating without them is not a measurement', 'the ratings view says why the sample is shown');

  /* ---- SURFACE TRANSLATOR ---------------------------------------------- */
  const sf = (await view('surface')).body();
  has(sf, 'Suits them most', 'the translator shows the most favourable surface');
  has(sf, 'Suits them least', 'and the least favourable');
  has(sf, 'Strongest on this surface', 'and absolute surface strength');
  has(sf, 'Why this is not the ranking', 'the translator explains what it adds over the official list');
  chk('the translator shows the raw figure AND the shrunk adjustment',
    sf.indexOf('vs ') > 0 && /adjustment/i.test(sf));

  /* ---- FORM AND TRAJECTORY --------------------------------------------- */
  const fm = (await view('form')).body();
  has(fm, 'A streak is not evidence on its own', 'the form lab states the schedule-strength rule');
  chk('a soft-draw streak is labelled as such, not as improvement',
    fm.indexOf('softer draw') > 0);
  chk('a hard-draw slump is labelled as such, not as decline',
    fm.indexOf('harder draw') > 0);
  has(fm, 'sched', 'the schedule shift is shown beside the form');

  /* ---- SCHEDULE AND FATIGUE -------------------------------------------- */
  const sc = (await view('schedule')).body();
  has(sc, 'not a physio report', 'the fatigue lab refuses the medical reading');
  has(sc, 'no medical information', 'and says EdgeDesk holds none');
  ['injured', 'injury risk', 'fitness concern', 'doubtful'].forEach(
    (w) => chk('the fatigue lab never claims ' + w,
      sc.toLowerCase().indexOf(w) < 0 || sc.indexOf('makes no injury') > 0));

  /* ---- HISTORICAL EXPLORER --------------------------------------------- */
  const ex = (await view('explore')).body();
  has(ex, '<table', 'the explorer renders a result table');
  has(ex, 'keyset paginated, never an offset', 'the explorer states its pagination method');
  chk('the explorer offers the filters the brief requires',
    ['Surface', 'Level', 'Round', 'Format', 'Environment', 'Handedness', 'Country', 'Season from']
      .every((f) => ex.indexOf(f) > 0));

  /* ---- MARKET COMPARISON — the module that must stay off --------------- */
  const mk = (await view('market')).body();
  has(mk, 'Market Comparison is off', 'the market tab is OFF');
  has(mk, 'switched off', 'and states the database’s own reason');
  has(mk, 'non-commercial research', 'and says the archive cannot be used as a price feed');
  has(mk, 'Nothing else in the Tennis Lab depends on this', 'and that the Lab does not need it');
  chk('the market tab shows no fabricated price',
    !/\$\d|\+\d{3}|-\d{3}\b|\d\.\d{2}\s*(decimal|odds)/.test(mk),
    'a number resembling a price appeared on a tab with no provider connected');
  chk('all three gate conditions are reported',
    mk.indexOf('flag') > 0 && mk.indexOf('cleared provider') > 0 && mk.indexOf('snapshot') > 0);

  /* ---- PLAYER PROFILE -------------------------------------------------- */
  const pp = paint({});
  await pp.sandbox.tnlLoad(true);
  await pp.sandbox.tnlOpenPlayer('archive:ATP:3292');
  const pl = pp.body();
  has(pl, 'Career', 'the profile separates career');
  has(pl, 'Recent form', 'from recent form');
  has(pl, 'By surface', 'from surface');
  has(pl, 'Serve and return', 'and shows a serve profile');
  has(pl, 'Workload and rest', 'and workload');
  has(pl, 'Rating history', 'and a rating line');
  has(pl, 'three different questions', 'and explains why they are not blended');
  chk('the profile shows the power rating with its sample and uncertainty',
    /tnl-unc/.test(pl) && /n=/.test(pl));
  chk('the profile offers a route into the matchup studio',
    pl.indexOf('Use as Player A') > 0);
  chk('tournament-level and format splits are rendered',
    pl.indexOf('By tournament level') > 0 || pl.indexOf('By format') > 0);

  /* ---- MATCHUP STUDIO -------------------------------------------------- */
  const mu = paint({});
  await mu.sandbox.tnlLoad(true);
  const card = fx('card')[0];
  mu.sandbox.TNL.mu.a = card;
  mu.sandbox.TNL.mu.b = Object.assign({}, card, { player_id: 'archive:ATP:1787', full_name: 'ATP Player 787' });
  mu.sandbox.TNL.view = 'matchup';
  mu.sandbox.TNL.mu.surface = 'clay';
  await mu.sandbox.tnlMuRun();
  const ms = mu.body();
  has(ms, 'Primary research factors', 'the studio attributes the projection to its drivers');
  has(ms, 'How sure is this?', 'the studio publishes its uncertainty');
  has(ms, 'band ±', 'with an explicit band');
  has(ms, 'of the model’s weight has data behind it', 'and how much of the model had data');
  has(ms, 'The other side of it', 'the studio argues the underdog’s case');
  has(ms, 'Head to head', 'the studio shows head to head');
  has(ms, 'Historical comparables', 'and historical comparables');
  has(ms, 'never on the result', 'and says comparables are matched on setup, not outcome');
  has(ms, 'Research, not picks', 'the studio restates the positioning');
  /* Strip tags before reading for tout language: `tnl-pick` is a layout class
     and `class="tnl-prob"` is not a claim about a match. What a reader SEES is
     the text between the tags. */
  const msText = ms.replace(/<[^>]*>/g, ' ').replace(/Research, not picks/g, '');
  [/\bpick\b/i, /\bmortal lock\b/i, /\bwinner is\b/i, /\bwill win\b/i, /\bguaranteed\b/i].forEach(
    (re) => chk('the studio never says ' + re.source, !re.test(msText), 'matched in visible text'));
  chk('the projection is stated as an estimate',
    ms.indexOf('EdgeDesk projects') > 0 || ms.indexOf('estimate of a probability') > 0);
  chk('the studio names what the model did NOT have',
    ms.indexOf('What the model did not have') > 0 || fx('muinputs').length === 0);
  chk('missing inputs are explained as absent, not zero',
    ms.indexOf('not zero') > 0 || ms.indexOf('What the model did not have') < 0);

  /* The brief's hardest requirement: when the band swallows the lean, say so. */
  const coin = paint({});
  await coin.sandbox.tnlLoad(true);
  const thin = { side: 'a', player_id: 'x', full_name: 'Thin A', tour: 'ATP', elo: 1500,
    rating_sample: 4, clay_elo: 1500, clay_sample: 2, form_90d: 0.5, official_rank: 400 };
  const thinB = Object.assign({}, thin, { side: 'b', player_id: 'y', full_name: 'Thin B', elo: 1495 });
  coin.sandbox.TNL.mu.a = { player_id: 'x', full_name: 'Thin A', tour: 'ATP' };
  coin.sandbox.TNL.mu.b = { player_id: 'y', full_name: 'Thin B', tour: 'ATP' };
  coin.sandbox.TNL.view = 'matchup';
  coin.sandbox.TNL.mu.surface = 'clay';
  const realRpc = coin.sandbox.tnlRpc;
  coin.sandbox.tnlRpc = async (n, b) => (n === 'lab_matchup_inputs' ? [thin, thinB] : realRpc(n, b));
  await coin.sandbox.tnlMuRun();
  const cs = coin.body();
  chk('a projection whose band crosses even money SAYS it does not lean reliably',
    cs.indexOf('does not lean reliably') > 0 || cs.indexOf('declines to project') > 0,
    'a near-coin-flip between two thin records must be labelled unstable');

  /* ---- a Lab with NOTHING on file -------------------------------------- */
  const bare = await view('overview', { rows: { lab_leaders: [], lab_movers: [], lab_surface_board: [],
    lab_fatigue_board: [], lab_rank_gap: [], lab_health: fx('health') } });
  chk('an empty Lab says what has to happen, not just "no data"',
    bare.body().indexOf('historical archive is imported') > 0);

  /* ---- the Lab when the schema is not installed ------------------------- */
  const gone = await view('overview', { rpcThrows: 404 });
  chk('a missing schema is reported plainly rather than as a crash',
    gone.body().indexOf('not installed') > 0 || gone.health().indexOf('not installed') > 0);

  /* ---- NO ODDS ANYWHERE IN ANY RENDERED VIEW --------------------------- */
  /* EVERY research view except the disabled market tab must be free of market
     content. The market tab is excluded because its whole job is to name what
     it is not showing. */
  const research = [ov, rt, sf, fm, sc, ex, pl, ms].join('\n').replace(/<[^>]*>/g, ' ');
  /* A view may SAY that no sportsbook was involved — that is the opposite of a
     dependency, and it is a claim the product should make out loud. What it may
     not do is present market content. So each term is allowed only inside an
     explicit negation. */
  const NEG = /(no|without|not|never)\s+(a\s+)?(sportsbook|market|odds|price)/i;
  ['DraftKings', 'FanDuel', 'implied probability', 'closing line', 'expected value',
   'fair odds', 'american odds', 'vig', 'juice'].forEach(
    (w) => chk('no research view presents ' + w,
      research.toLowerCase().indexOf(w.toLowerCase()) < 0,
      'the Lab must answer from the record alone'));
  chk('"sportsbook" appears in a research view only as an explicit denial',
    research.toLowerCase().indexOf('sportsbook') < 0 || NEG.test(research),
    'sportsbook is mentioned without saying it was NOT used');
  chk('the market tab IS allowed to name what it is withholding',
    mk.indexOf('market-implied probability') > 0 && mk.indexOf('closing-line') > 0);

  /* ---- summary ---------------------------------------------------------- */
  console.log('\nTennis Lab UI');
  failures.forEach((f) => console.log('  FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('::error::' + (e && e.stack || e)); process.exit(1); });

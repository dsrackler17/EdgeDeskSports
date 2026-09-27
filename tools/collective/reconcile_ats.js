#!/usr/bin/env node
/* ===========================================================================
   Reconcile a model's against-the-spread record, game by game.

   WHY THIS EXISTS. A model page read "Record (ATS) 5-3-0" over a game log of
   91 played games, and there was no way to ask the obvious question: which
   eight, and what happened to the other eighty-three? The record, the
   rankings row and the log were each computed in the page and agreed with
   each other, and none of them could be checked against the games behind
   them by anybody who was not reading the source.

   So this prints the reconciliation. One row per completed game: the
   submission that was graded, the side the published rule selects, the
   Collective's captured closing spread, the final score, the arithmetic
   (margin + close), the grade, or the exact reason there is none. Then the
   cumulative W-L-P, which must equal the sum of the rows above it.

   IT RUNS THE SHIPPED FUNCTIONS. rowGrade, atsResult, impliedSide, atsReason,
   modelRecord and localGameLog are lifted out of collective/index.html and
   driven here, so this is a reading of the page's own arithmetic and not a
   second implementation that could quietly disagree with it. That is the
   whole point: a reconciliation computed by different code proves nothing
   about the number on the page.

   SOURCES, in the order they are tried:
     --games <file>   a JSON array of the games feed's own shape, or an object
                      with a `games` key. This is the offline path, and the
                      only one that works where the Collective's API is not
                      reachable: export /v1/games for the weeks you want.
     the live feed    collective_public /v1/games, one request per week.
   Either way, finals and captured closes missing from the games payload are
   filled from the committed settlement record in collective/settled, exactly
   as the site fills them.

   Usage:
     node tools/collective/reconcile_ats.js --model <creator>/<model> \
          [--sport CFB] [--season 2026] [--games export.json] [--json]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const API = (process.env.COLLECTIVE_API ||
  'https://iattxbkbufslbauoumga.supabase.co/functions/v1').replace(/\/$/, '');

/* ---- the page's own grading functions, loaded out of the page ----------- */
function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, 'collective', 'index.html'), 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) if (m[1].trim()) blocks.push(m[1]);
  const stub = () => ({
    style: {}, children: [], value: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    getAttribute: () => null, setAttribute() {}, appendChild() {}, removeChild() {},
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => stub(), querySelectorAll: () => [], focus() {}, click() {},
  });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { hash: '', href: 'http://localhost/', search: '', pathname: '/',
      origin: 'http://localhost', replace() {}, assign() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'node' },
    document: { getElementById: () => stub(), querySelector: () => stub(),
      querySelectorAll: () => [], createElement: () => stub(), addEventListener() {},
      removeEventListener() {}, body: stub(), head: stub(), title: '', cookie: '' },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    Promise, JSON, Math, Date, RegExp, Intl,
    performance: { now: () => 0 },
    crypto: { getRandomValues: a => a, randomUUID: () => 'x' },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.scrollTo = () => {}; sandbox.requestAnimationFrame = () => 0;
  sandbox.alert = () => {}; sandbox.confirm = () => false;
  vm.createContext(sandbox);
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'collective', 'week.js'), 'utf8'),
      sandbox, { timeout: 20000 });
  } catch (_) {}
  /* The page's router fires on load and reaches for a DOM this has stubbed;
     the grading functions are already defined by then, so a throw out of the
     last line is not a failure to load them. */
  try { vm.runInContext(blocks.join('\n;\n'), sandbox, { timeout: 20000 }); } catch (_) {}
  const need = ['rowGrade', 'atsResult', 'atsReason', 'modelRecord', 'localGameLog',
    'finalResult', 'impliedSide', 'pickSideNorm', 'gradableRow', 'gameKey', 'atsMissingText'];
  const missing = need.filter(n => typeof sandbox[n] !== 'function');
  if (missing.length) throw new Error(`collective/index.html did not define: ${missing.join(', ')}`);
  return sandbox;
}

/* ---- the committed settlement record, the same file the site reads ------ */
function settledRecord(sport, season) {
  const f = path.join(ROOT, 'collective', 'settled',
    `${String(sport).toUpperCase()}_${season}.json`);
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (d && d.games) ? d : null;
  } catch (_) { return null; }
}

/* Fill the finals and closes the games payload left blank, from the record.
   The same precedence the page applies: a result the server really settled
   wins, and this only fills a blank. */
function fillFromRecord(games, rec) {
  if (!rec) return 0;
  let n = 0;
  games.forEach(g => {
    const e = g.game_id != null ? rec.games[String(g.game_id)] : null;
    if (!e) return;
    const zero = r => r && Number(r.home_score) === 0 && Number(r.away_score) === 0;
    if (!g.result || g.result.home_score == null || zero(g.result)) {
      if (e.home_score == null || e.away_score == null) return;
      if (Number(e.home_score) === 0 && Number(e.away_score) === 0) return;
      g.result = { home_score: Number(e.home_score), away_score: Number(e.away_score),
        closing_spread: e.closing_spread == null ? null : Number(e.closing_spread),
        closing_total: e.closing_total == null ? null : Number(e.closing_total),
        close_source: e.close_source || 'record', source: 'record' };
      n++;
      return;
    }
    if (g.result.closing_spread == null && e.closing_spread != null) {
      g.result.closing_spread = Number(e.closing_spread);
      g.result.close_source = e.close_source || 'record';
      n++;
    }
  });
  return n;
}

async function liveGames(sport, season, log) {
  const out = [];
  const seen = new Set();
  const head = await fetch(`${API}/collective_public/v1/games?sport=${encodeURIComponent(sport)}` +
    `&season=${encodeURIComponent(season)}`).then(r => r.ok ? r.json() : null);
  if (!head) throw new Error('the games feed did not answer');
  const cur = head.week == null ? 0 : Number(head.week);
  const pages = [head];
  for (let w = 0; w < cur; w++) {
    const p = await fetch(`${API}/collective_public/v1/games?sport=${encodeURIComponent(sport)}` +
      `&season=${encodeURIComponent(season)}&week=${w}`).then(r => r.ok ? r.json() : null)
      .catch(() => null);
    if (p) pages.push(p); else log(`  ! week ${w} did not answer; the reconciliation is short by that week`);
  }
  pages.forEach(p => (p.games || []).forEach(g => {
    const k = String(g.game_id != null ? g.game_id : `${g.away}@${g.home}|${g.kickoff_at}`);
    if (seen.has(k)) return;
    seen.add(k); out.push(g);
  }));
  return out;
}

function parseArgs(argv) {
  const a = { model: null, sport: 'CFB', season: 2026, games: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') a.model = argv[++i];
    else if (argv[i] === '--sport') a.sport = argv[++i];
    else if (argv[i] === '--season') a.season = Number(argv[++i]);
    else if (argv[i] === '--games') a.games = argv[++i];
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (...m) => console.log(...m);
  if (!args.model || args.model.indexOf('/') < 0)
    throw new Error('--model <creator-slug>/<model-slug> is required');
  const [cs, ms] = args.model.split('/');
  const S = loadPage();

  let games;
  if (args.games) {
    const d = JSON.parse(fs.readFileSync(args.games, 'utf8'));
    games = Array.isArray(d) ? d : (d.games || []);
    log(`Reading ${games.length} game(s) from ${args.games}.`);
  } else {
    log(`Reading the games feed for ${args.sport} ${args.season}.`);
    games = await liveGames(args.sport, args.season, log);
    log(`  ${games.length} game(s).`);
  }

  const rec = settledRecord(args.sport, args.season);
  const filled = fillFromRecord(games, rec);
  log(rec
    ? `The committed settlement record filled ${filled} blank(s) (score or close).`
    : 'No committed settlement record for this sport and season.');

  /* one row per game this model posted, in the page's own words */
  const mine = [];
  const seen = new Set();
  games.forEach(g => {
    const k = S.gameKey(g);
    if (seen.has(k)) return;
    const row = (g.models || []).find(r => r && r.creator_slug === cs && r.model_slug === ms);
    if (!row) return;
    seen.add(k);
    const fr = S.finalResult(g);
    const grade = S.rowGrade(g, row);
    const stated = S.pickSideNorm(row);
    const side = stated || (fr ? S.impliedSide(row, fr.closing_spread) : null);
    mine.push({
      game_id: g.game_id, label: g.label || `${g.away} @ ${g.home}`, week: g.week,
      kickoff_at: g.kickoff_at,
      submission: { projected_spread: row.projected_spread,
        proj_home_score: row.proj_home_score, proj_away_score: row.proj_away_score,
        home_win_probability: row.home_win_probability, pick_side: row.pick_side,
        movement_n: row.movement_n, late: !!row.late, locked: !!row.locked,
        data_origin: row.data_origin == null ? null : row.data_origin },
      side, side_from: stated ? 'stated' : (side ? 'implied by the model\'s own line vs the close' : null),
      closing_spread: fr ? fr.closing_spread : null,
      close_source: fr ? fr.close_source : null,
      final: fr ? `${fr.away}-${fr.home}` : null,
      home_margin: fr ? fr.margin : null,
      cover: (fr && fr.closing_spread != null) ? fr.margin + fr.closing_spread : null,
      grade: grade ? grade.pick_result : null,
      graded_by: grade ? grade.source : null,
      margin_error: grade ? grade.margin_error : null,
      brier: grade ? grade.brier : null,
      excluded: (grade && grade.pick_result != null) ? null : S.atsReason(g, row),
    });
  });
  mine.sort((a, b) => (Date.parse(a.kickoff_at || 0) || 0) - (Date.parse(b.kickoff_at || 0) || 0));

  const record = S.modelRecord(games, cs, ms);
  /* the page's own aggregate, and the same sum taken off the rows above it:
     if these two ever differ, the page is not reporting its own log */
  const tally = mine.reduce((t, r) => {
    if (r.grade === 'win') t.w++; else if (r.grade === 'loss') t.l++;
    else if (r.grade === 'push') t.p++;
    if (r.margin_error != null) t.mae++;
    if (r.brier != null) t.brier++;
    if (r.grade == null && r.excluded) t.miss[r.excluded] = (t.miss[r.excluded] || 0) + 1;
    return t;
  }, { w: 0, l: 0, p: 0, mae: 0, brier: 0, miss: {} });

  const agrees = tally.w === record.wins && tally.l === record.losses &&
    tally.p === record.pushes && tally.mae === record.margin_n && tally.brier === record.brier_n;

  if (args.json) {
    console.log(JSON.stringify({ model: args.model, sport: args.sport, season: args.season,
      games: mine, record, tally, agrees }, null, 2));
    return agrees ? 0 : 2;
  }

  log('');
  log(`${args.model} — ${mine.length} game(s) posted, ${mine.filter(r => r.final).length} completed`);
  log('');
  const pad = (v, n) => String(v == null ? '-' : v).padEnd(n).slice(0, n);
  const rpad = (v, n) => String(v == null ? '-' : v).padStart(n);
  log(pad('GAME', 26) + rpad('WK', 3) + '  ' + pad('SIDE', 9) + rpad('CLOSE', 7) +
    rpad('FINAL', 9) + rpad('MARGIN', 7) + rpad('COVER', 7) + '  ' + pad('RESULT', 7) + 'WHY NOT');
  mine.forEach(r => {
    log(pad(r.label, 26) + rpad(r.week, 3) + '  ' + pad(r.side, 9) +
      rpad(r.closing_spread, 7) + rpad(r.final, 9) + rpad(r.home_margin, 7) +
      rpad(r.cover, 7) + '  ' + pad(r.grade ? r.grade.toUpperCase() : '-', 7) +
      (r.excluded ? (S.ATS_REASON_SHORT[r.excluded] || r.excluded) : ''));
  });
  log('');
  log(`ATS            ${record.wins}-${record.losses}-${record.pushes} over ${record.ats_n} graded game(s)` +
    (record.win_pct == null ? '' : `  ·  ${(100 * record.win_pct).toFixed(1)}% (pushes excluded)`));
  log(`ungraded ATS   ${record.ats_missing_n} of ${record.games} played` +
    (record.ats_missing_n ? `  ·  ${S.atsMissingText(record.ats_missing)}` : ''));
  log(`margin MAE     ${record.margin_mae == null ? '-' : record.margin_mae.toFixed(2)} over ${record.margin_n} game(s)`);
  log(`Brier          ${record.brier == null ? '-' : record.brier.toFixed(4)} over ${record.brier_n} game(s)`);
  log('');
  log(agrees
    ? 'RECONCILED: the cumulative record equals the sum of the rows above it.'
    : `MISMATCH: rows say ${tally.w}-${tally.l}-${tally.p} (mae ${tally.mae}, brier ${tally.brier}); ` +
      `the record says ${record.wins}-${record.losses}-${record.pushes} (mae ${record.margin_n}, brier ${record.brier_n}).`);
  return agrees ? 0 : 2;
}

module.exports = { loadPage, settledRecord, fillFromRecord, parseArgs };

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => {
    console.error(`[reconcile] ${e.message}`);
    process.exit(1);
  });
}

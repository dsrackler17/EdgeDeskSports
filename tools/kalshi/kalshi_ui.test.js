#!/usr/bin/env node
/* ===========================================================================
   The Kalshi section on the NFL and CFB game cards, and its System health
   rows (app.html). The section's own script is extracted from app.html as
   shipped and run in a VM against a mocked public.kalshi_card_current:

     hooks       the NFL card (both branches), the graded NFL card and the CFB
                 card (both branches) call window.fbKalshiHTML, guarded
     states      loading; not deployed (a 404 is the section's own state, never
                 a database fault); unavailable; no matched market (visibly
                 inactive, nothing in its place)
     the rule    OK shows the mid, spread, volume and snapshot time; a wide or
                 stale market shows NO mid; the gap only where the view gave
                 one, labelled T2 Computed; prices labelled T0 Observed
     which game  by the card's game id, else by the book event the card
                 already shows; never by name in the browser
     limits      the three known limitations on every section that shows data
     health      System health reads public.kalshi_readiness and counts its
                 error and warn states like the NBA sync's
     provenance  T0 Kalshi prices and the T2 comparison are registered

   Run: node tools/kalshi/kalshi_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* ---------------------------------------------------------------- the hooks, statically */
const fnBody = (name) => { const a = HTML.indexOf('function ' + name + '('); return a < 0 ? '' : HTML.slice(a, HTML.indexOf('\nfunction ', a + 10)); };
const nfl = fnBody('fbGameCardNfl'), graded = fnBody('fbGameCardNflGraded'), cfb = fnBody('fbGameCardCfb');
chk('hooks: the NFL card calls the section in both branches, guarded', (nfl.match(/\(window\.fbKalshiHTML\?window\.fbKalshiHTML\('nfl',g,u\.t,M\.ev\):''\)/g) || []).length === 2);
chk('hooks: the graded NFL card shows the close', /window\.fbKalshiHTML\('nfl',g,it\.t,null,\{final:true\}\)/.test(graded));
chk('hooks: the CFB card calls the section in both branches, guarded', (cfb.match(/\(window\.fbKalshiHTML\?window\.fbKalshiHTML\('cfb',g,u\.t,ev\):''\)/g) || []).length === 2);
chk('hooks: the section is beside Market Structure, never inside the price lines', nfl.indexOf('fbKalshiHTML') > nfl.indexOf('fbMarketStructureHTML'));

/* ---------------------------------------------------------------- System health and provenance, statically */
const sh = fnBody('sysHealthHTML'), st = fnBody('sysHealthState');
chk('health: the readiness view is read as anon, apart from sbFetch', /function sysHealthKalshiLoad\(force\)[\s\S]{0,600}kalshi_readiness\?select=\*/.test(HTML) && /try\{sysHealthKalshiLoad\(force\);\}catch\(_\)\{\}/.test(fnBody('sysHealthLoad')));
chk('health: an error state fails the system check, warn asks for attention (as the NBA sync)', /ksr\.state==='error'\)fails\+\+;else if\(ksr\.state==='warn'\)warns\+\+/.test(st));
chk('health: rows for the sync, the last successful snapshot, close capture and the game links', ['Kalshi snapshot sync', 'Kalshi last successful snapshot', 'Kalshi close capture', 'Kalshi game links'].every((l) => sh.indexOf("'" + l + "'") >= 0));
chk('health: not deployed reads "not loaded", never a tick', /shRow\('Kalshi snapshot sync',SH\.ksErr\?[^;]*'not loaded','mut'\)/.test(sh));
chk('health: the limitations are stated beside the Kalshi rows', /5-minute snapshots, not live/.test(sh) && /6\\u00a2/.test(sh) && /trading fees are not reflected/.test(sh));
chk('provenance: Kalshi prices are T0 and the comparison is T2', /\{nm:'Kalshi prices on NFL and CFB game cards[^}]*tier:'T0',src:'Provider Kalshi/.test(HTML) && /\{nm:'Kalshi mid vs book fair[^}]*tier:'T2'/.test(HTML));
chk('limitations: the football module lists the three', /limitations:function\(\)\{return \['Kalshi prices are 5-minute snapshots, not live\.'/.test(HTML));

/* ---------------------------------------------------------------- the section, run */
const a = HTML.indexOf('<style id="ks-styles">');
const sA = HTML.indexOf('<script>', a) + '<script>'.length, sB = HTML.indexOf('</script>', sA);
const SRC = HTML.slice(sA, sB);
chk('the section ships one script after its styles', a > 0 && /window\.fbKalshiHTML=function/.test(SRC));

let ANSWER = null, CALLS = [], REPAINTS = 0;
const win = {
  SB_URL: 'https://db.test', SB_KEY: 'anon-key', console,
  edToken: async () => 'reader-jwt',
  setTimeout: (f) => { f(); return 1; }, Date, Math, JSON, Promise, String, Number, isFinite, Error, encodeURIComponent,
  renderFootball: () => { REPAINTS++; },
  fetch: async (u, init) => {
    CALLS.push({ u: String(u), auth: init && init.headers && init.headers.authorization });
    const [status, body] = ANSWER;
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  },
};
win.window = win;
vm.createContext(win);
vm.runInContext(SRC, win, { filename: 'app.html#kalshi' });
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const reset = () => { vm.runInContext('window.__edKalshi=false;', win); vm.runInContext(SRC, win); CALLS = []; REPAINTS = 0; };

const KICK = new Date(Date.now() + 3 * 3600e3).toISOString(), SNAP = new Date(Date.now() - 4 * 60e3).toISOString();
const base = { sport: 'nfl', game_id: '2026_08_DAL_PHI', game_key: 'nfl|2026_08_DAL_PHI', odds_event_id: 'ev-dalphi', event_ticker: 'KXNFLGAME-26OCT26DALPHI',
  home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys', kickoff_at: KICK, match_confidence: 'high', pregame: true, snapshot_at: SNAP, snapshot_age_minutes: 4,
  volume: 25000, volume_24h: 3000, open_interest: 9000 };
const PHI = Object.assign({}, base, { market_ticker: 'KXNFLGAME-26OCT26DALPHI-PHI', kalshi_yes_name: 'Philadelphia', yes_team: 'Philadelphia Eagles', opponent: 'Dallas Cowboys',
  state: 'OK', yes_mid: 0.65, yes_bid: 0.64, yes_ask: 0.66, spread: 0.02, gap_basis: 'latest_pregame', gap_snapshot_at: SNAP, gap_kalshi_mid: 0.65, book_fair_prob: 0.63, time_diff_minutes: 3, gap_pp: 2 });
const DAL = Object.assign({}, base, { market_ticker: 'KXNFLGAME-26OCT26DALPHI-DAL', kalshi_yes_name: 'Dallas', yes_team: 'Dallas Cowboys', opponent: 'Philadelphia Eagles',
  state: 'WIDE_SPREAD', yes_mid: null, yes_bid: 0.30, yes_ask: 0.40, spread: 0.10, gap_pp: null, book_fair_prob: null });
const G = { game_id: '2026_08_DAL_PHI', home_team: 'PHI', away_team: 'DAL' };
const html = (sport, g, ev, opts) => vm.runInContext('window.fbKalshiHTML', win)(sport, g, Date.parse(KICK), ev || null, opts);

(async () => {
  /* ---- loading, then the read ---- */
  ANSWER = [200, [PHI, DAL]];
  let h = html('nfl', G);
  chk('state: loading until the first read answers', /loading/.test(h) && !/<details/.test(h));
  await settle();
  chk('read: one request, with the reader’s own token, filtered to the last week', CALLS.length === 1 && CALLS[0].auth === 'Bearer reader-jwt' && /\/rest\/v1\/kalshi_card_current\?select=\*&kickoff_at=gte\./.test(CALLS[0].u));
  chk('read: the board repaints once the read answers', REPAINTS === 1);
  h = html('nfl', G);
  chk('read: a render inside a minute does not read again', CALLS.length === 1);
  chk('section: a collapsed details with the home side’s mid and gap in its summary', /<details class="ms-wrap ks-wrap"/.test(h) && /Philadelphia 65\.0%/.test(h) && /gap \+2\.0 pp/.test(h));
  chk('observed: labelled T0 Observed, provider Kalshi', /rs-badge rs-t0[^>]*title="T0: observed — provider Kalshi"/.test(h));
  chk('observed: OK shows the mid, spread, volume and snapshot time', /Philadelphia Eagles <span class="ms-m">YES<\/span>[\s\S]*?65\.0%[\s\S]*?spread 2¢[\s\S]*?vol 25,000[\s\S]*?ET/.test(h));
  const dalRow = (h.match(/Dallas Cowboys <span class="ms-m">YES<\/span><\/span><span class="v">([\s\S]*?)<\/span><\/div>/) || [])[1] || '';
  chk('the rule: a wide market shows no mid — the spread says why, visibly inactive', /too wide/.test(dalRow) && /no mid/.test(dalRow) && !/\d+\.\d%/.test(dalRow) && /ms-row ks-off"><span class="l">Dallas Cowboys <span class="ms-m">YES/.test(h), dalRow);
  chk('derived: labelled T2 Computed, "derived"', /rs-badge rs-t2[^>]*title="T2: deterministic transform/.test(h) && /Kalshi mid − book fair · derived/.test(h));
  chk('derived: the gap with both numbers and the capture timing', /\+2\.0 pp <span class="m">Kalshi 65\.0% vs book fair 63\.0% · [^·]*ET · book captured 3 min after/.test(h));
  chk('derived: no gap for the wide side — said, not filled', /Dallas Cowboys<\/span><span class="v"><span class="ms-m">none — no trusted Kalshi mid/.test(h));
  chk('limits: the three known limitations are on the section', /Known limitations/.test(h) && /5-minute snapshots, not live/.test(h) && /wider than 6¢ is excluded from the mid/.test(h) && /trading fees are not reflected in the raw gap/.test(h));
  chk('match: the confidence and the event are stated', /confidence high/.test(h) && /KXNFLGAME-26OCT26DALPHI/.test(h));

  /* ---- which game ---- */
  h = html('nfl', { game_id: 'other', home_team: 'PHI', away_team: 'DAL' }, { rows: [{ event_id: 'ev-dalphi' }] });
  chk('which game: by the book event this card already shows when its id is not on the link', /Philadelphia 65\.0%/.test(h));
  h = html('nfl', { game_id: 'other', home_team: 'PHI', away_team: 'DAL' }, { rows: [{ event_id: 'ev-other' }] });
  chk('which game: never by name — same teams, different id and event: no match, visibly inactive', /no Kalshi market matched to this game/.test(h) && /ks-off/.test(h) && !/65\.0%/.test(h));
  h = html('cfb', G);
  chk('which game: the sport is part of the key (an NFL id never reaches a CFB card)', /no Kalshi market matched/.test(h));
  chk('which game: nothing for another sport', html('nba', G) === '');

  /* ---- inactive pregame, the close, escaping ---- */
  reset();
  ANSWER = [200, [Object.assign({}, PHI, { state: 'STALE', yes_mid: null, gap_pp: null, snapshot_at: new Date(Date.now() - 40 * 60e3).toISOString() }), DAL]];
  html('nfl', G); await settle(); h = html('nfl', G);
  chk('the rule: nothing trusted: the summary says inactive and shows no percentage', /ms-chip warn">inactive/.test(h) && !/<summary>[^]*?\d+\.\d%[^]*?<\/summary>/.test(h) && /stale/.test(h) && /no mid shown/.test(h));
  reset();
  ANSWER = [200, [Object.assign({}, PHI, { pregame: false, gap_basis: 'close', yes_mid: 0.58, gap_kalshi_mid: 0.58, book_fair_prob: 0.56, snapshot_age_minutes: 6, gap_pp: 2 }),
    Object.assign({}, DAL, { pregame: false, yes_team: 'Dallas <img src=x onerror=alert(1)>' })]];
  html('nfl', G); await settle(); h = html('nfl', G, null, { final: true });
  chk('close: after kickoff the section is the close, and the gap says "at the close"', /YES mid at the close \(the last snapshot before kickoff\)/.test(h) && /ms-chip">close/.test(h) && /at the close/.test(h));
  chk('escaping: a name from the database is text, never markup', !/<img src=x/.test(h) && /Dallas &lt;img src=x onerror=alert\(1\)&gt;/.test(h));

  /* ---- not deployed, unavailable ---- */
  reset();
  ANSWER = [404, { code: 'PGRST205', message: "Could not find the table 'public.kalshi_card_current' in the schema cache" }];
  html('nfl', G); await settle(); h = html('nfl', G);
  chk('not deployed: the section’s own state, saying which file to apply', /Not deployed/.test(h) && /kalshi_market_data\.sql is not applied yet/.test(h) && !/<details/.test(h));
  reset();
  ANSWER = [500, { message: 'statement timeout' }];
  html('nfl', G); await settle(); h = html('nfl', G);
  chk('unavailable: a failed read says so and shows nothing in its place', /unavailable/.test(h) && /nothing is shown in their place/.test(h) && !/\d+\.\d%/.test(h));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' kalshi ui: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : ''));
  process.exit(fail ? 1 : 0);
})();

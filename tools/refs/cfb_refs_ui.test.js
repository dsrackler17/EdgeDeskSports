#!/usr/bin/env node
/* ===========================================================================
   The Officiating block in the Observed section of the CFB Analyst pass card
   (app.html, window.cfbAnalystHTML). The card's own script is extracted from
   app.html as shipped and run in a VM against a mocked
   public.cfb_game_ref_context:

     hooks        every branch of the card (NOT RUN, DATA_INSUFFICIENT, a full
                  pass) carries the block; it is never hidden
     states       loading; not deployed (a 404 is the block's own state, never
                  a database fault); unavailable; no assignment = "Assignment
                  not announced"; signed out = "Sign in" with no request made
                  (the view is signed-in only, as every supabase/cfb_*.sql table)
     the rule     the NFL Officiating block's rows (data/refs, PR #680): season
                  flags/game and holding/game vs the conference average (first)
                  and FBS, two decimals, "vs" in --pos/--neg, rank N of M;
                  offensive holding; the 3-season baseline with game counts;
                  under 3 games the numbers show with the count and NO rank; no
                  conference in the dataset's mapping = "conference unavailable"
                  and the FBS comparison; a final game with no referee reads
                  "No referee on record for this game"
     contract     every field the block reads is a column of the view
     display only the classification, drivers and CLV are not read or changed
     limitations  the five known limitations on every state

   Run: node tools/refs/cfb_refs_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'cfb_refs.sql'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* ---------------------------------------------------------------- the card's script, as shipped */
const mark = HTML.indexOf('EdgeDesk :: CFB Analyst card');
const sA = HTML.indexOf('<script>', mark) + '<script>'.length, sB = HTML.indexOf('</script>', sA);
const SRC = HTML.slice(sA, sB);
chk('the card ships one script after its styles', mark > 0 && /window\.cfbAnalystHTML=function/.test(SRC) && /window\.cfbRefHTML=refBlockHTML/.test(SRC));
const OFF = SRC.slice(SRC.indexOf('/* ---- Observed: Officiating'), SRC.indexOf('window.cfbAnalystHTML=function'));
const CODE = OFF.replace(/\/\*[\s\S]*?\*\//g, '');
chk('display only: the officiating code reads nothing of the analyst pass', CODE.length > 1000
  && !/\bF\.|classification|CFB\.flags|clv|INVESTIGATE|MONITOR/i.test(CODE));
chk('read with the reader\'s own token, apart from sbFetch; nothing requested while signed out',
  /SB_URL\+'\/rest\/v1\/cfb_game_ref_context\?game_id=eq\.'\+encodeURIComponent\(gid\)\+'&select=\*'/.test(CODE)
  && /edToken\(\)/.test(CODE) && /if\(!tok\|\|tok===SB_KEY\)throw/.test(CODE) && /authorization:'Bearer '\+tok/.test(CODE)
  && !/'Bearer '\+SB_KEY/.test(CODE) && !/sbFetch|sbGet/.test(CODE));

/* the view's columns (the select list of cfb_game_ref_context) against what the block reads */
const vA = SQL.indexOf('create or replace view public.cfb_game_ref_context');
const vSel = SQL.slice(SQL.indexOf('\nselect ', vA), SQL.indexOf('\n  from pick p', vA));
const cols = new Set((vSel.match(/\bas (\w+)|\b[a-z0-9]\.(\w+)(?=,|\s*$|\n)/gm) || []).map((m) => m.replace(/^as |^[a-z0-9]\./, '')));
const used = new Set((OFF.match(/\bR\.(\w+)/g) || []).map((m) => m.slice(2)));
const missing = [...used].filter((c) => !cols.has(c));
chk('every field the block reads is a column of cfb_game_ref_context', used.size >= 25 && missing.length === 0, { missing, used: [...used] });

/* provenance and the module's limitations name it */
chk('provenance: the officiating rows are registered T0 under cfb', /\{nm:'Officiating: referee, flags and holding per game[^}]*tier:'T0',src:'public\.cfb_game_ref_context/.test(HTML));
chk('limitations: the CFB module states it is display only and small samples', /'Referee tendencies are display only and small samples/.test(HTML));
chk('the hook in the CFB game detail is unchanged (the card is still the analyst pass)', /rows\+cfbLineHTML\(g\)\+cfbAnalystHTML\(gid\)\+/.test(HTML));

/* ---------------------------------------------------------------- run it */
let ANSWER = {}, CALLS = [], TOKEN = 'user-token';
const painted = {};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const win = {
  CFB: { flags: {} },
  stEsc: esc,
  fetch: (url, opts) => {
    CALLS.push({ url, opts });
    const gid = (/game_id=eq\.(\d+)/.exec(url) || [])[1];
    const a = ANSWER[gid] || { status: 200, body: [] };
    return Promise.resolve({ ok: a.status === 200, status: a.status, json: () => Promise.resolve(a.body), text: () => Promise.resolve(typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) });
  },
  document: { querySelectorAll: (sel) => { const gid = (/data-cfa-ref="(\d+)"/.exec(sel) || [])[1]; const el = { set innerHTML(v) { painted[gid] = v; } }; return [el]; } },
  SB_URL: 'https://example.supabase.co', SB_KEY: 'anon-key',
  edToken: () => Promise.resolve(TOKEN),
  Date, Math, String, Number, Object, JSON, Promise, encodeURIComponent, isFinite, Array, RegExp, Error, setTimeout,
};
win.window = win;
vm.createContext(win);
vm.runInContext(SRC, win);
const flush = () => new Promise((r) => setImmediate(r));

const ROW = {
  game_id: 401871100, season: 2026, week: 8, referee_id: 'jerrymagallanes', referee: 'Jerry Magallanes', source: 'ncaa_listed',
  referee_identity: 'inferred_crew_chief', basis: 'game_record', first_observed_at: null, observed_referees: 0, primary_conf: 'ACC',
  season_games: 9, season_holding_games: 9, season_flags_pg: 12.44, season_holding_pg: 2.33, season_off_holding_pg: 1.78,
  conf_flags_pg: 12.97, conf_holding_pg: 2.56, fbs_flags_pg: 12.36, fbs_holding_pg: 2.4,
  flags_vs_conf_pg: -0.53, holding_vs_conf_pg: -0.23, flags_vs_fbs_pg: 0.08, holding_vs_fbs_pg: -0.07,
  flags_rank_in_conf: 6, holding_rank_in_conf: 9, conf_refs_ranked: 11, flags_rank_fbs: 50, holding_rank_fbs: 60, fbs_refs_ranked: 95,
  y3_games: 34, y3_holding_games: 33, y3_first_season: 2024, y3_last_season: 2026, y3_flags_pg: 12.03, y3_holding_pg: 2.11,
  y3_off_holding_pg: 1.6, y3_flags_vs_fbs: -0.33, y3_holding_vs_fbs: -0.36, y3_fbs_flags_pg: 12.36, y3_fbs_holding_pg: 2.47,
};
const LIMS = ['Referee identity is inferred', 'NCAA box score', 'ESPN lists as Referee', 'counted per play from play-by-play',
  'accepted penalties from the box score', 'that conference’s average', 'Samples are small', 'no over/under record'];
const hasLims = (h) => LIMS.every((t) => h.indexOf(t) >= 0);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function card(gid, answer, F) {
  if (answer) ANSWER[gid] = answer;
  if (F) win.CFB.flags[gid] = F; else delete win.CFB.flags[gid];
  const first = win.cfbAnalystHTML(gid);
  await flush(); await flush();
  return { first, after: win.cfbAnalystHTML(gid), painted: painted[gid] };
}

(async () => {
  /* hooks: every branch carries the block */
  const notRun = await card('401871001', { status: 200, body: [] });
  chk('NOT RUN card: the Observed block is there, loading first', /NOT RUN/.test(notRun.first) && /<h5>Observed /.test(notRun.first) && /data-cfa-ref="401871001"/.test(notRun.first) && /loading…/.test(notRun.first));
  chk('no assignment yet: "Assignment not announced", block not hidden', /Assignment not announced/.test(notRun.after) && /Assignment not announced/.test(notRun.painted || '') && /Officiating/.test(notRun.after));
  chk('the read is by the card\'s game id, with the reader\'s token', CALLS.some((c) => /cfb_game_ref_context\?game_id=eq\.401871001&select=\*/.test(c.url)
    && c.opts.headers.apikey === 'anon-key' && c.opts.headers.authorization === 'Bearer user-token'));
  chk('limitations shown with no assignment', hasLims(notRun.after), strip(notRun.after));

  const di = await card('401871002', { status: 200, body: [] }, { classification: 'DATA_INSUFFICIENT', missing_inputs: '["SP+"]' });
  chk('DATA_INSUFFICIENT card carries the block before its data limitations', /Not classified/.test(di.after) && di.after.indexOf('<h5>Observed ') > 0
    && di.after.indexOf('<h5>Observed ') < di.after.indexOf('Data limitations'));

  const F = Object.freeze({ classification: 'INVESTIGATE', undervalued_side: 'home', why: 'Because.', observable_factors: Object.freeze(['a']),
    partial_factors: Object.freeze(['b']), hidden_factors: Object.freeze(['c']), data_limitations: Object.freeze(['d']), sp_disagreement_points: 3.2,
    close_at: '2026-10-24T19:00:00Z', spread_clv_points: 1.5, ml_clv_prob: 0.02 });
  const before = JSON.stringify(F);
  const full = await card('401871100', { status: 200, body: [ROW] }, F);
  const h = full.after;
  chk('full pass: the block sits in its Observed section, after the observability tiers, before data limitations', h.indexOf('Mostly hidden risks') < h.indexOf('<h5>Observed ')
    && h.indexOf('<h5>Observed ') < h.indexOf('<h5>Data limitations'));
  chk('display only: the classification, drivers and CLV are unchanged', JSON.stringify(F) === before && /cfa-badge investigate">INVESTIGATE/.test(h)
    && /spread CLV <b class="pos">\+1\.5 pt/.test(h) && /\+3\.2/.test(h));
  const t = strip(h);
  chk('the referee, the crew\'s conference, NCAA crew chief', /Officiating Jerry Magallanes · referee · ACC crew · crew chief on the NCAA box score \(inferred\)/.test(t), t.slice(0, 500));
  chk('season flags/game vs the conference average first, then FBS, with the rank', /Flags \/ game 2026 · 9 games 12\.44 −0\.53 vs ACC 12\.97 \+0\.08 vs FBS 12\.36 · rank 6 of 11 ACC refs/.test(t), t);
  chk('season holding/game the same way', /Holding \/ game 2026 · 9 games 2\.33 −0\.23 vs ACC 2\.56 −0\.07 vs FBS 2\.40 · rank 9 of 11 ACC refs/.test(t), t);
  chk('"vs" reads in --pos above the base and --neg below, as the NFL block', /color:var\(--neg\)">−0\.53</.test(h) && /color:var\(--pos\)">\+0\.08</.test(h));
  chk('offensive holding/game, this season and 3 seasons', /Offensive holding \/ game 1\.78 2026 · 1\.60 2024–2026/.test(t), t);
  chk('the 3-season baseline with its game count, vs FBS', /3-season baseline 2024–2026 · 34 games 12\.03 flags −0\.33 · 2\.11 holding −0\.36 per game, vs FBS 12\.36 \/ 2\.47/.test(t), t);
  chk('the rank is explained, and the sample called small', /Rank 1 is the most per game among the 11 ACC referees with 3 or more 2026 games; 9 games are a small sample/.test(t));
  chk('the rows are the NFL block\'s own (.ms-row / .ms-note / .ms-lim)', /class="ms-row"><span class="l">Officiating<\/span>/.test(h) && /class="ms-note"/.test(h) && /class="ms-lim"><b>Known limitations\.<\/b>/.test(h));
  chk('limitations on a full block', hasLims(h));

  const two = await card('401871101', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871101, season_games: 2, season_holding_games: 2, flags_rank_in_conf: null, holding_rank_in_conf: null,
    conf_refs_ranked: null, flags_rank_fbs: null, holding_rank_fbs: null, fbs_refs_ranked: null, y3_games: 2, y3_holding_games: 2 })] });
  const t2 = strip(two.after);
  chk('under 3 games: the numbers with the game count, and no rank', /Flags \/ game 2026 · 2 games 12\.44/.test(t2) && /not ranked \(under 3 games\)/.test(t2) && !/rank \d+ of/.test(t2)
    && /3-season baseline 2024–2026 · 2 games/.test(t2) && /2 games this season: shown without a rank/.test(t2), t2);
  const rankless = await card('401871104', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871104, season_games: 1, flags_rank_in_conf: 3, conf_refs_ranked: 11, flags_rank_fbs: 7, fbs_refs_ranked: 95 })] });
  chk('under 3 games no rank is shown even if one were sent', !/rank \d+ of/.test(strip(rankless.after)));

  const nc = await card('401871102', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871102, primary_conf: null, conf_flags_pg: null, conf_holding_pg: null,
    flags_vs_conf_pg: null, holding_vs_conf_pg: null, flags_rank_in_conf: null, holding_rank_in_conf: null, conf_refs_ranked: null })] });
  const t3 = strip(nc.after);
  chk('no conference in the mapping: "conference unavailable", the FBS comparison and FBS rank', /Jerry Magallanes · referee · conference unavailable/.test(t3) && /Conference unavailable: /.test(t3)
    && /12\.44 \+0\.08 vs FBS 12\.36 · rank 50 of 95 FBS refs/.test(t3) && !/vs ACC/.test(t3), t3);

  const espn = await card('401871103', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871103, basis: 'assignment', source: 'espn', referee_identity: 'espn_referee_role',
    first_observed_at: '2026-10-22T15:02:11Z', observed_referees: 2 })] });
  const t4 = strip(espn.after);
  chk('an ESPN assignment: listed by ESPN as Referee, when it was first seen, and that it changed', /listed by ESPN as Referee, first seen Thu, Oct 22, 11:02 AM ET/.test(t4)
    && /ESPN changed the referee; the earlier listing is kept/.test(t4), t4);

  const noSeason = await card('401871105', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871105, basis: 'assignment', source: 'espn', season_games: null, season_flags_pg: null })] });
  chk('a referee with no games this season yet: says so, the 3-season baseline still shown', /no 2026 game worked yet/.test(noSeason.after) && /3-season baseline/.test(noSeason.after));

  const nd = await card('401871106', { status: 404, body: '{"code":"PGRST205","message":"Could not find the table"}' });
  chk('not deployed: the block says so (its own state, not an outage) and keeps its limitations', /Not deployed/.test(nd.after) && /supabase\/cfb_refs\.sql is not applied yet/.test(nd.after) && hasLims(nd.after));
  const er = await card('401871107', { status: 500, body: 'boom' });
  chk('unavailable: the block says it could not be read', /could not be read \(HTTP 500\)/.test(er.after));

  const xss = await card('401871108', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871108, referee: '<img src=x onerror=alert(1)>', primary_conf: '<b>SEC</b>' })] });
  chk('names are escaped', !/<img src=x/.test(xss.after) && /&lt;img src=x/.test(xss.after) && !/<b>SEC<\/b>/.test(xss.after));

  win.cfbGameById = (gid) => (gid === '401871109' ? { game_id: 401871109, completed: true } : null);
  const fin = await card('401871109', { status: 200, body: [] });
  chk('a final game with no referee: "No referee on record for this game"', /No referee on record for this game/.test(fin.after) && !/Assignment not announced/.test(fin.after));

  TOKEN = 'anon-key';
  const nOut = CALLS.length;
  const out = await card('401871110', { status: 200, body: [ROW] });
  chk('signed out: "Sign in", the limitations, and no request made', /Sign in to see the referee/.test(out.after) && hasLims(out.after) && CALLS.length === nOut);
  TOKEN = 'user-token';
  await card('401871110', { status: 200, body: [Object.assign({}, ROW, { game_id: 401871110 })] });
  await flush(); await flush();
  chk('signing in shows the block on the next render (no five-minute wait), painted in place', /Jerry Magallanes/.test(painted['401871110'] || '')
    && /Jerry Magallanes/.test(win.cfbAnalystHTML('401871110')) && CALLS.length === nOut + 1);
  const exp = await card('401871111', { status: 401, body: '{"code":"42501","message":"permission denied for view cfb_game_ref_context"}' });
  chk('a refused token reads "Sign in", not an outage', /Sign in to see the referee/.test(exp.after) && !/unavailable/.test(exp.after));

  const n0 = CALLS.length;
  const bad = win.cfbAnalystHTML('not-a-number');
  await flush();
  chk('a non-numeric game id is never queried and reads "Assignment not announced"', CALLS.length === n0 && /Assignment not announced/.test(bad));
  win.cfbAnalystHTML('401871100'); await flush();
  chk('a loaded game is not re-read within five minutes', CALLS.filter((c) => /eq\.401871100&/.test(c.url)).length === 1);

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();

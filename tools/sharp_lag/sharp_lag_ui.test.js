#!/usr/bin/env node
/* ===========================================================================
   Sharp lag (Experimental) on the pages: the helpers the hosts draw with, the
   wiring in app.html, the game page, the matchup view and the Performance
   page, and the Performance script run against a stubbed database.
     helpers    one club across two feeds, a game's flags among a sport's,
                the validation line from the public counts, the sections'
                ids and headings, the style injected once
     wiring     every read goes through public.sharp_lag_flags() and
                public.sharp_lag_progress() under the reader's own token;
                the public /today/ page carries no Sharp-lag section; one
                script version everywhere
     public     the Performance script with public display OFF (counts and
                progress only, no flag, even if one were returned), ON (the
                record, the no-close line), not deployed and failing; it
                reads with the public anon key only
     language   research language on every new surface
   The browser run (tools/sharp_lag/sharp_lag_ui.e2e.js) draws the same
   sections in Chromium.
   Run: node tools/sharp_lag/sharp_lag_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const T = Date.parse('2026-11-02T18:00:00Z');
const at = (min) => new Date(T + min * 60000).toISOString();
const row = (o) => Object.assign({ flag_id: 1, flagged_at: at(-30), model_key: 'SHARP-LAG', model_version: '0.1', trigger_type: 'scheduled', sport_key: 'icehockey_nhl', event_id: 'ev1',
  home_team: 'Columbus Blue Jackets', away_team: 'Florida Panthers', commence_time: at(60), market: 'h2h', side: 'Columbus Blue Jackets', participant: null, point: null,
  target_venue: 'draftkings', target_price: 2.3, target_price_american: 130, target_cost_prob: 0.4348, fee_per_contract: null, fee_unverified: false, target_observed_at: at(-35),
  reference_kind: 'pinnacle_shin', reference_prob: 0.465, reference_observed_at: at(-40), gap_pp: 3.02, snapshot_resolution_s: 3600, close_status: null, clv_pp: null, access: 'subscriber' }, o || {});

(async () => {
  /* ── helpers ─────────────────────────────────────────────────────────── */
  chk('sameTeam: one name with and without its mascot', L.sameTeam('Ohio State', 'Ohio State Buckeyes') && L.sameTeam('Western Kentucky Hilltoppers', 'Western Kentucky'));
  chk('sameTeam: "LA Clippers" and "Los Angeles Clippers"', L.sameTeam('LA Clippers', 'Los Angeles Clippers'));
  chk('sameTeam: never a one-word name against a longer one it does not start', !L.sameTeam('Kentucky', 'Western Kentucky') && !L.sameTeam('Delaware', 'South Carolina') && !L.sameTeam('', 'Delaware'));
  const FL = [row({ flag_id: 1 }), row({ flag_id: 2, home_team: 'Florida Panthers', away_team: 'Columbus Blue Jackets' }), row({ flag_id: 3, commence_time: at(60 + 7 * 60) }),
    row({ flag_id: 4, sport_key: 'basketball_nba' }), row({ flag_id: 5, home_team: 'Carolina Hurricanes' })];
  const mine = L.flagsForGame(FL, { sport_key: 'icehockey_nhl', home: 'Columbus Blue Jackets', away: 'Florida Panthers', start: at(60) }).map((f) => f.flag_id);
  chk('flagsForGame: both clubs, or both swapped (a neutral listing), in the sport, within 6 hours of the start', JSON.stringify(mine) === '[1,2]', mine);
  chk('flagsForGame: a host with its own resolver passes it', L.flagsForGame(FL, { home: 'CBJ', away: 'FLA', start: at(60) }, { sameTeam: (a, b) => ({ CBJ: 'Columbus Blue Jackets', FLA: 'Florida Panthers' }[b] || b) === a }).length === 3);
  const graded = Array.from({ length: 10 }, (_, i) => row({ flag_id: 10 + i, event_id: 'g' + (i % 4), close_status: 'graded', clv_pp: i % 3 ? 1.5 : -0.5 }));
  let v = L.validationFrom({ models: [{ model_key: 'SHARP-LAG', flags: 300, graded: 250, no_close: 4, pending: 3, registered: true }] }, graded, 'SHARP-LAG');
  chk('validationFrom: the public counts win when the reader sees fewer graded flags; no interval is drawn from a partial sample', v.graded === 250 && v.ci === null && v.eligible === false && v.progress === '250 of 200 graded flags' && v.registered === true, v);
  v = L.validationFrom({ models: [{ model_key: 'SHARP-LAG', graded: 10, registered: true }] }, graded, 'SHARP-LAG');
  chk('validationFrom: with every graded flag visible, the game-clustered interval is drawn', v.graded === 10 && v.ci && v.ci.lo != null && v.ci.clusters === 4 && v.eligible === false, v.ci);
  chk('validationFrom: an unknown model reads as not registered, never as validated', L.validationFrom({ models: [] }, [], 'NBA-ROLE-SHIFT').registered === null && L.validationFrom(null, [], 'NBA-ROLE-SHIFT').status === 'EXPERIMENTAL');
  const ps = L.pendingSection({ cls: 'gm-dsec', id: 'gmSharp', h: 'h4', text: 'Checking <x>' });
  chk('pendingSection: the host\'s class, id and heading; the text escaped; tagged Experimental', /class="sl-sec gm-dsec"/.test(ps) && /id="gmSharp"/.test(ps) && /<h4 class="sl-h">/.test(ps) && /Checking &lt;x&gt;/.test(ps) && /Experimental/.test(ps));
  const gs = L.gameSection({ cls: 'gv-sec', id: 'gvSharp', now: T, flags: [row()], access: 'subscriber', validation: L.validation([], 'SHARP-LAG') });
  chk('gameSection: the host\'s class and id, an h2 by default', /class="sl-sec gv-sec" id="gvSharp"/.test(gs) && /<h2 class="sl-h">/.test(gs) && /0 of 200 graded flags/.test(gs));
  chk('gameSection: a reader without access before the start sees no flag, and is told when they are published', /until the game starts/.test(L.gameSection({ flags: [], access: 'none', started: false })) && !/<table/.test(L.gameSection({ flags: [row()], access: 'none', started: false })));
  chk('gameSection: after the start, the public sees the flag', /<table/.test(L.gameSection({ now: T, flags: [row({ commence_time: at(-10) })], access: 'public', started: true })));
  const doc = { els: {}, head: { kids: [], appendChild(e) { this.kids.push(e); doc.els[e.id] = e; } }, getElementById(id) { return this.els[id] || null; }, createElement() { return {}; } };
  L.injectStyle(doc); L.injectStyle(doc);
  chk('injectStyle: once per page, under its own id', doc.head.kids.length === 1 && doc.head.kids[0].id === 'edgedesk-sharp-lag-css' && /\.sl-sec\{/.test(doc.head.kids[0].textContent));
  chk('injectStyle: no document, no throw', (() => { try { L.injectStyle(null); L.injectStyle({}); return true; } catch (_) { return false; } })());
  chk('the style never scrolls the page sideways: the tables sit in an overflow-x wrapper', /\.sl-tblwrap\{overflow-x:auto;max-width:100%\}/.test(L.STYLE) && /sl-tblwrap/.test(gs));

  /* ── wiring ──────────────────────────────────────────────────────────── */
  const app = read('app.html'), gv = read('lib/edgedesk_game_view.js'), gu = read('lib/edgedesk_games_ui.js'), today = read('today/index.html'), perf = read('performance/index.html'), pjs = read('performance/sharp_lag.js');
  const ver = (html, lib) => { const m = new RegExp('<script src="/lib/' + lib.replace('.', '\\.') + '\\?v=([^"]+)"').exec(html); return m ? m[1] : null; };
  chk('app.html loads the Sharp-lag core once', (app.match(/<script src="\/lib\/edgedesk_sharp_lag\.js\?v=/g) || []).length === 1);
  chk('…under the same version as the Performance page', ver(app, 'edgedesk_sharp_lag.js') && ver(app, 'edgedesk_sharp_lag.js') === ver(perf, 'edgedesk_sharp_lag.js'), [ver(app, 'edgedesk_sharp_lag.js'), ver(perf, 'edgedesk_sharp_lag.js')]);
  chk('the games UI ships one version on the terminal and on /today/', ver(app, 'edgedesk_games_ui.js') === ver(today, 'edgedesk_games_ui.js'), [ver(app, 'edgedesk_games_ui.js'), ver(today, 'edgedesk_games_ui.js')]);
  const slBlock = (/window\.slData=\(function\(\)\{[\s\S]*?\n\}\)\(\);/.exec(app) || [''])[0];
  chk('app.html: window.slData exists', slBlock.length > 200);
  const rpcs = (slBlock.match(/rpc\('([a-z_]+)'/g) || []).map((s) => s.slice(5, -1)).sort();
  chk('slData reads only public.sharp_lag_flags() and public.sharp_lag_progress()', JSON.stringify([...new Set(rpcs)]) === '["sharp_lag_flags","sharp_lag_progress"]' && !/\/rest\/v1\/(sharp_flags|sharp_price_snapshots|sharp_flag_grades|sharp_lag_rows)/.test(slBlock), rpcs);
  chk('…under the reader\'s own token (edToken), never a stored key of its own', /edToken\(\)\.then\(function\(t\)/.test(slBlock) && /'Bearer '\+t/.test(slBlock) && !/service_role|SERVICE_ROLE/.test(slBlock));
  chk('…and a function not yet installed is "not deployed", never a fault', /status===404\)return \{notDeployed:true\}/.test(slBlock));
  chk('the Signals view holds the feed above Signal Center, and opening it fills the feed', /<section id="v-signals"[^>]*><div id="slFeed"><\/div><div id="scHost">/.test(app) && /function scOpen\([^)]*\)\{[\s\S]{0,200}window\.slData\.feed\(\$\('slFeed'\)\)/.test(app));
  chk('the game page and the matchup view are given opts.sharpLag', /function gvOpts\(\)\{return \{[\s\S]{0,400}sharpLag:function\(league,gid,g\)/.test(app) && /sharpLag:function\(q\)\{return window\.slData\?window\.slData\.forGame\(q\)/.test(app));
  chk('game view: the section sits after the market comparison, and only when the host supplies opts.sharpLag', /h \+= marketSection\(s, mk, av\);\s*\n\s*h \+= sharpLagSection\(s\);/.test(gv) && /if \(!S\.opts\.sharpLag \|\| !SL\) return '';/.test(gv));
  chk('game view: the read is asked for after the page paints, never waited on', /paint\(\); joinMarket\(\); joinKalshi\(\); joinSharpLag\(\);/.test(gv));
  chk('matchup view: never on the public page', /var slOn = S\.opts\.host !== 'public' && typeof S\.opts\.sharpLag === 'function'/.test(gu));
  chk('/today/ gives the games UI no Sharp-lag read and loads no Sharp-lag script', !/sharpLag|edgedesk_sharp_lag/.test(today));
  chk('Performance: the section sits before the methodology, with its own host element', perf.indexOf('id="sharp-lag"') > 0 && perf.indexOf('id="sharp-lag"') < perf.indexOf('id="methodology"') && /<div id="pf-sharplag"><\/div>/.test(perf));
  chk('Performance: the core loads before the page script', perf.indexOf('/lib/edgedesk_sharp_lag.js') < perf.indexOf('/performance/sharp_lag.js'));
  const key = (/var SB_KEY = '([^']+)'/.exec(pjs) || [])[1] || '';
  const role = (() => { try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString()).role; } catch (_) { return null; } })();
  chk('Performance reads with the public anon key every page already ships, never another', role === 'anon' && read('lib/edgedesk_public.js').indexOf(key) >= 0, role);

  /* ── public: the Performance script against a stubbed database ───────── */
  async function runPerf(answers) {
    const el = { innerHTML: '' }, calls = [];
    const document = { head: { appendChild() {} }, getElementById: (id) => (id === 'pf-sharplag' ? el : null), createElement: () => ({}) };
    const fetch = async (u, init) => {
      const name = String(u).replace(/^.*\/rest\/v1\/rpc\//, '');
      calls.push({ url: String(u), name, init });
      const a = answers[name];
      if (a instanceof Error) throw a;
      const status = a && a.status || 200;
      return { status, ok: status < 300, json: async () => (a && 'body' in a ? a.body : a) };
    };
    const ctx = { document, fetch, console };
    ctx.window = ctx; ctx.EDSharpLag = L;
    vm.runInNewContext(pjs, ctx);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    return { html: el.innerHTML, calls };
  }
  const progress = (pub, o) => Object.assign({ threshold: 200, public_display: pub, access: pub === 'on' ? 'public' : 'none', models: [{ model_key: 'SHARP-LAG', flags: 7, graded: 3, no_close: 1, pending: 3, registered: true }, { model_key: 'NBA-ROLE-SHIFT', flags: 0, graded: 0, no_close: 0, pending: 0, registered: true }] }, o || {});
  const started = [row({ flag_id: 1, event_id: 'a', commence_time: at(-300), close_status: 'graded', clv_pp: 1.2, converged: true, lag_to_converge_s: 1800 }),
    row({ flag_id: 2, event_id: 'a', commence_time: at(-300), close_status: 'graded', clv_pp: -0.4, converged: false }),
    row({ flag_id: 3, event_id: 'b', commence_time: at(-200), close_status: 'graded', clv_pp: 2.1, converged: true, lag_to_converge_s: 3600 }),
    row({ flag_id: 4, event_id: 'c', commence_time: at(-100), close_status: 'no_close', clv_pp: null })];

  let P = await runPerf({ sharp_lag_progress: progress('off'), sharp_lag_flags: started });
  chk('public display OFF: the counts, the registered threshold and the progress, tagged Experimental', /7 flags written, 1 without a usable close, 3 waiting for the game to start/.test(P.html) && /3 of 200 graded flags/.test(P.html)
    && /95% lower bound on mean CLV above zero, both/.test(P.html) && /Experimental/.test(P.html), P.html.slice(0, 600));
  chk('public display OFF: no flag and no price, even if one were returned', !/<table/.test(P.html) && !/Pinnacle fair|DraftKings \+/.test(P.html) && /confirmed the price source’s terms allow it/.test(P.html));
  chk('it asks only for the two public functions, with the anon key as both apikey and bearer', P.calls.map((c) => c.name).sort().join() === 'sharp_lag_flags,sharp_lag_progress'
    && P.calls.every((c) => c.init.headers.apikey === key && c.init.headers.authorization === 'Bearer ' + key && c.init.method === 'POST'));
  P = await runPerf({ sharp_lag_progress: progress('on'), sharp_lag_flags: started });
  chk('public display ON: the record, with every started flag counted', /<table/.test(P.html) && /Avg CLV/.test(P.html) && /Hit rate/.test(P.html) && /Avg lag to converge/.test(P.html) && /Snapshot resolution/.test(P.html), P.html.slice(0, 400));
  chk('public display ON: the flag count is the database\'s (7), not only the started games\' (4)', />Overall<\/h3>[\s\S]*?<th scope="row">All flags<\/th><td data-l="Flags">7<\/td><td data-l="Graded">3<\/td>/.test(P.html), (/>Overall<\/h3>[\s\S]{0,700}/.exec(P.html) || [''])[0]);
  chk('public display ON: split by sport, market and trigger, in words (NHL, Moneyline, Scheduled check)', /<th scope="row">NHL<\/th>/.test(P.html) && /<th scope="row">Moneyline<\/th>/.test(P.html) && /<th scope="row">Scheduled check<\/th>/.test(P.html));
  chk('public display ON: the no-close count and rate stay visible as data quality', /1 flag had no usable close \(25\.0% of closed flags\)/.test(P.html), (/Data quality:[^<]*/.exec(P.html) || [''])[0]);
  chk('public display ON: the threshold and progress, and the snapshot-cadence caveat', /3 of 200 graded flags/.test(P.html) && /measured only to the snapshot cadence/.test(P.html));
  P = await runPerf({ sharp_lag_progress: { status: 404, body: { code: 'PGRST202' } }, sharp_lag_flags: { status: 404, body: {} } });
  chk('not deployed: it says so, never an empty box', /not deployed yet/.test(P.html), P.html);
  P = await runPerf({ sharp_lag_progress: { status: 500, body: {} }, sharp_lag_flags: [] });
  chk('a failed read: it says so', /could not be read just now/.test(P.html), P.html);

  /* ── language ────────────────────────────────────────────────────────── */
  const perfSec = (/<section aria-labelledby="pf-sl-h"[\s\S]*?<\/section>/.exec(perf) || [''])[0];
  const surfaces = [slBlock, pjs, perfSec, gv.slice(gv.indexOf('function joinSharpLag'), gv.indexOf('function kalshiOf')), gu.slice(gu.indexOf('function fillSharpLag'), gu.indexOf('function gfxLink'))].join('\n');
  const BAD = /\b(bet|bets|betting|pick|picks|play this|lock|wager|take the|hammer|best bet|sharp action|units?|guaranteed|profit)\b/ig;
  chk('research language only on every new surface', !BAD.test(surfaces.replace(/not advice and not a recommendation/g, '')), surfaces.match(BAD));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp lag ui: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();

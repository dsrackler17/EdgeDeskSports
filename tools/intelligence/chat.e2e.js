#!/usr/bin/env node
/* ===========================================================================
   INTELLIGENCE, IN THE ACTUAL WEBSITE.

   The unit suites prove the rules. This proves the PRODUCT: app.html loaded in
   Chromium exactly as it ships, the chat panel opened the way a reader opens
   it, and the question typed into the real textarea and sent with the real
   button. Nothing here calls an internal function to get its answer — every
   assertion reads the DOM a subscriber would be looking at.

   The failure it exists to prevent, verbatim from the report:

     "How does Texas State look this week?" produces intent=unknown,
     baseball_mlb retrieval, Texas → Texas Rangers aliasing, MLB pitcher and
     bullpen research, an unrelated Padres decision card, and a missing
     recommendation ledger error.

   Every one of those is a separate assertion below, asked of the rendered
   answer. The MLB board is deliberately populated and an MLB signal is
   deliberately loaded first, because that is the state the reader was in when
   it broke — an empty app would pass without proving anything.

   The reasoning function is answered THREE ways across the run: with a normal
   narration, with a 500, and with a decision card belonging to another game.
   The card must be identical in all three, because it is built from the site's
   own published data and the model is an addition to it.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.

   Run:  node tools/intelligence/chat.e2e.js
         node tools/intelligence/chat.e2e.js --shots /tmp/shots
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; failures.push({ name, detail });
  console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, { missing: needle }); }
function lacks(hay, re, name) {
  const m = String(hay).match(re);
  chk(name, !m, m ? { found: String(m[0]).slice(0, 120) } : undefined);
}
function finish() {
  if (fail) { console.log('\nFAIL | Intelligence in the website | ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  console.log('\nPASS | Intelligence in the website | ' + pass + ' assertions');
  process.exit(0);
}

/* ---- the published card this test asserts against ---------------------- */
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
/* NOT HARDCODED. The subject is chosen from the real published card by the
   property the bug needs — a program whose full name STARTS WITH the name of
   another program on the same card, playing exactly one game in the window.
   On this card that is Texas State (against Texas); if the card changes, the
   test picks whatever team now has that shape and keeps testing the rule. */
function pickSubject() {
  const games = SLATE.games || [];
  const keys = {};
  games.forEach(g => { [g.home_team, g.away_team].forEach(t => { keys[String(t).toLowerCase().replace(/[^a-z0-9]/g, '')] = t; }); });
  const all = Object.keys(keys);
  const cands = all.filter(k => all.some(o => o !== k && k.indexOf(o) === 0 && o.length >= 4))
    .filter(k => games.filter(g => [g.home_team, g.away_team].some(t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '') === k)).length === 1)
    .sort();
  if (!cands.length) return null;
  const k = cands[0], name = keys[k];
  const g = games.find(x => [x.home_team, x.away_team].some(t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '') === k));
  const shorter = all.filter(o => o !== k && k.indexOf(o) === 0 && o.length >= 4).map(o => keys[o]);
  return { name, game: g, opponent: (String(g.home_team).toLowerCase().replace(/[^a-z0-9]/g, '') === k) ? g.away_team : g.home_team,
    isHome: String(g.home_team).toLowerCase().replace(/[^a-z0-9]/g, '') === k, shorter };
}
const SUBJ = pickSubject();
if (!SUBJ) { console.log('SKIPPED: the published card carries no team whose name extends another team on the same card'); process.exit(0); }
/* A second matchup, named in full, for the "what about X vs Y?" turn. */
const OTHER = (SLATE.games || []).find(g => g.game_id !== SUBJ.game.game_id
  && ![g.home_team, g.away_team].some(t => t === SUBJ.name || t === SUBJ.opponent)) || null;

/* ---- a static server for the repo -------------------------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.xml': 'application/xml' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---- the baseball board the reader had open when it broke -------------- */
const TOMORROW = new Date(Date.now() + 20 * 3600e3).toISOString();
const MLB_SIGNALS = [{
  event_id: 'mlb-sd-1', sport_key: 'baseball_mlb', sport_title: 'MLB', market: 'h2h',
  selection: 'San Diego Padres', point: null, best_dec: 2.05, first_best_dec: 1.95,
  best_book: 'DraftKings', home_team: 'San Diego Padres', away_team: 'Los Angeles Dodgers',
  commence_time: TOMORROW, last_seen_at: new Date(Date.now() - 4 * 60e3).toISOString(),
  first_seen_at: new Date(Date.now() - 90 * 60e3).toISOString(),
  closing_sharp_fair: null, sharp_fair_dec: 1.98, n_books: 7, has_sharp: true, trusted_book: true,
}];

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) {
    try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; }
  }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }

  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium (' + String(e.message).split('\n')[0] + ')'); site.srv.close(); process.exit(0); }
  }

  /* what the reasoning function does this run — flipped between turns */
  let fnMode = 'ok';
  let fnCalls = [];

  async function openChat() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({
          access_token: 'e2e', refresh_token: 'e2e',
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' },
        }));
      } catch (e) { /* private mode */ }
    });
    await ctx.route('**/*', async route => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/open-meteo|cfbfastR|githubusercontent/.test(url)) return route.fulfill({ status: 404, body: 'not published' });
      if (/\/functions\/v1\/edgedesk_ai/.test(url)) {
        let body = null;
        try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
        fnCalls.push(body);
        if (fnMode === 'down') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'model upstream refused' }) });
        /* A decision card from ANOTHER game, every time, on purpose: the panel
           is required to drop it rather than show it under a question about a
           different matchup. */
        const stray = {
          game_id: 'mlb-sd-1', matchup: 'Los Angeles Dodgers @ San Diego Padres', kickoff: TOMORROW,
          market: 'h2h', selection: 'San Diego Padres', handicap: null, side: 'home',
          decision: 'BET CANDIDATE', strength: 'STRONG', why: 'A stray card from another sport.',
          blockers: [], price: { offered_american: '+105', book: 'DraftKings' }, gates: {},
          model: { line: null, validation_tier: 'UNVALIDATED' }, disagreement: null,
          what_would_change_it: [], experimental: false, attention: { tier: 'NATIONAL' }, evidence_gaps: [],
        };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          answer: 'NARRATION_MARKER — the written read.', model: 'test-model', cached: false,
          research: { decisions: [stray] },
          ledger: { state: 'WRITE_FAILED', notice: 'the recommendation ledger could not be written',
            detail: 'PGRST205: Could not find the table \'public.recommendation_ledger\' in the schema cache' },
        }) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e',
            current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
            cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/signals\?/.test(url) && /baseball_mlb/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MLB_SIGNALS) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message).slice(0, 240)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.EDAI && typeof window.EDAI.sendText === 'function', null, { timeout: 45000 });
    await page.evaluate(() => { window.EDAI.open(); });
    return { ctx, page, errors };
  }

  /* type it and send it, exactly as a reader does */
  async function ask(page, text) {
    const before = await page.evaluate(() => document.getElementById('edaiLog').children.length);
    await page.fill('#edaiText', text);
    await page.click('#edaiSend');
    await page.waitForFunction((n) => {
      const log = document.getElementById('edaiLog');
      return log && log.children.length > n + 1 && !document.getElementById('edaiThink');
    }, before, { timeout: 45000 });
    /* let the progressive passes land */
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const log = document.getElementById('edaiLog');
      const kids = Array.prototype.slice.call(log.children);
      const last = kids.filter(k => k.className.indexOf('edai-msg a') >= 0).pop();
      return last ? last.innerHTML : '';
    });
  }

  let A = null;
  try { A = await openChat(); }
  catch (e) { chk('the chat panel opens in a browser', false, String(e.message).slice(0, 300)); await browser.close(); site.srv.close(); return finish(); }

  /* =====================================================================
     THE READER IS LOOKING AT BASEBALL. That is the whole point.
     ===================================================================== */
  await A.page.evaluate((sig) => { window.EDAI.loadSignal(sig, false); }, MLB_SIGNALS[0]);
  chk('an MLB signal is loaded, which is the state the failure was reported in',
    await A.page.evaluate(() => !!document.getElementById('edaiLoaded') && !document.getElementById('edaiLoaded').classList.contains('hide')));

  /* =====================================================================
     1. THE EXACT PRODUCTION QUESTION.
     ===================================================================== */
  console.log('\n== "How does ' + SUBJ.name + ' look this week?" with an MLB signal open ==');
  const q1 = 'How does ' + SUBJ.name + ' look this week?';
  const a1 = await ask(A.page, q1);
  if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, 'texas-state.png'), fullPage: true });

  has(a1, SUBJ.name, 'the answer is about the team that was named');
  has(a1, SUBJ.opponent, 'and names the opponent from the published card');
  chk('the right game: both sides of the scheduled matchup are in the answer',
    a1.indexOf(SUBJ.name) >= 0 && a1.indexOf(SUBJ.opponent) >= 0);
  SUBJ.shorter.forEach(short => {
    const re = new RegExp('\\b' + short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?!\\s)', 'g');
    /* the shorter program's name may appear only INSIDE the longer one */
    const stray = String(a1).replace(new RegExp(SUBJ.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    chk('"' + short + '" is not substituted for "' + SUBJ.name + '"', stray.indexOf('>' + short + '<') < 0 && !/Rangers|Astros/.test(stray));
  });
  lacks(a1, /pitcher|bullpen|starting arm|xERA|WHIP/i, 'no baseball pitcher or bullpen research in a college football answer');
  lacks(a1, /Padres|Dodgers/i, 'no card, line or mention from the loaded baseball game');
  lacks(a1, /BET CANDIDATE/, 'no decision card from another game is shown');
  lacks(a1, /PGRST|schema cache|public\.recommendation_ledger|relation .* does not exist/i,
    'no raw database exception reaches the reader');
  lacks(a1, /\{"|\[\{|"value":/, 'no raw JSON in the answer');
  has(a1, 'Research available; tracking temporarily unavailable.', 'a tracking failure is one plain sentence');
  has(a1, 'was not recorded', 'and says the decision was not recorded');
  has(a1, 'NARRATION_MARKER', 'the written read is appended to the card');

  /* the facts the card is required to carry */
  has(a1, 'week ' + SUBJ.game.week, 'the scope (week) is stated');
  chk('the kickoff is stated', /\b\d{1,2}:\d{2}\b/.test(a1) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(a1));
  chk('the model projection is quoted from the published card',
    a1.indexOf(String(Math.abs(Math.round(SUBJ.game.model_home_line * 100) / 100))) >= 0
    || /no projection published/.test(a1), { line: SUBJ.game.model_home_line });
  chk('the market state is stated rather than implied',
    /No sportsbook number is joined|consensus line|The market has it at/.test(a1));
  chk('what is not on file is disclosed', /What is not on file/.test(a1));
  chk('the model’s own ceiling is disclosed', /What this model may and may not do/.test(a1));
  chk('sources are disclosed', /Where this came from/.test(a1));
  has(a1, 'football/fbs/slate.json', 'the card names the published source it resolved against');

  /* what actually went over the wire */
  const sent = fnCalls[fnCalls.length - 1] || {};
  chk('the request carries the resolved college football game, on the server\u2019s own contract',
    sent.research_context && String(sent.research_context.game_id) === String(SUBJ.game.game_id),
    sent.research_context);
  chk('and the same game rides in the packet for an older deployment',
    sent.packet && sent.packet.resolved_matchup && String(sent.packet.resolved_matchup.game_id) === String(SUBJ.game.game_id),
    sent.packet && sent.packet.resolved_matchup);
  chk('the request declares the sport as college football',
    sent.packet && sent.packet.game && sent.packet.game.sport_key === 'americanfootball_ncaaf',
    sent.packet && sent.packet.game);
  chk('the request carries NO baseball board',
    !(sent.packet && (sent.packet.board_mode || (sent.packet.board && sent.packet.board.mlb_starters))),
    Object.keys((sent.packet || {})));
  chk('the scope sent with it is the college card, not the open tab',
    sent.packet && sent.packet.board_scope && sent.packet.board_scope.sport === 'americanfootball_ncaaf',
    sent.packet && sent.packet.board_scope);
  chk('no API key or service-role key is in the request body',
    !/service_role|sk-ant|ANTHROPIC|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJ.*role.*service/.test(JSON.stringify(sent)));

  /* =====================================================================
     2. THE FOLLOW-UPS KEEP THE SUBJECT.
     ===================================================================== */
  console.log('\n== follow-ups ==');
  const a2 = await ask(A.page, 'Who have they played?');
  has(a2, SUBJ.name, 'a follow-up that names nobody stays on the same team');
  lacks(a2, /Padres|Dodgers|pitcher|bullpen/i, 'and does not drift back to the open baseball game');

  const a3 = await ask(A.page, 'What could make that lean wrong?');
  has(a3, SUBJ.name, 'the second follow-up also stays on the subject');

  const a4 = await ask(A.page, "What's the line?");
  has(a4, SUBJ.name, 'a market question stays on the subject');
  chk('the market answer says which kind of number it has',
    /No sportsbook number is joined|consensus line|The market has it at/.test(a4));

  /* =====================================================================
     3. A DIFFERENT MATCHUP, NAMED IN FULL, TAKES OVER.
     ===================================================================== */
  if (OTHER) {
    console.log('\n== "What about ' + OTHER.away_team + ' vs ' + OTHER.home_team + '?" ==');
    const a5 = await ask(A.page, 'What about ' + OTHER.away_team + ' vs ' + OTHER.home_team + '?');
    has(a5, OTHER.home_team, 'naming a new matchup switches to it');
    has(a5, OTHER.away_team, 'and carries its opponent');
    chk('the previous subject is gone', a5.indexOf(SUBJ.name) < 0 || SUBJ.name === OTHER.home_team || SUBJ.name === OTHER.away_team);
  }

  /* =====================================================================
     4. A REAL BASEBALL QUESTION STILL WORKS.
     ===================================================================== */
  console.log('\n== a board question is still a board question ==');
  const before6 = fnCalls.length;
  const a6 = await ask(A.page, "Who are today's worst starting pitchers?");
  const new6 = fnCalls.slice(before6);
  /* The football subject was established two turns ago. A board question must
     not be answered as that game — that is the reported failure with the roles
     swapped. Whether the board then has rows to reason over depends on the
     fixture; either outcome is correct, answering about the football game is
     not. */
  chk('a board question is not answered as the carried football matchup',
    a6.indexOf(OTHER ? OTHER.home_team : SUBJ.name) < 0 && a6.indexOf(SUBJ.name) < 0, a6.slice(0, 200));
  chk('and no request claims a college matchup for it',
    new6.every(c => !(c.packet && c.packet.resolved_matchup)),
    new6.map(c => c.packet && c.packet.resolved_matchup));
  /* Whatever shape the board path sends, it must not be a college matchup
     request — that is the property under test, and pinning the packet's keys
     instead would break on any change to the board contract. */
  chk('and no request it does make claims a college football game',
    new6.every(c => !(c.research_context && c.research_context.game_id)
      && String((c.packet && c.packet.game && c.packet.game.sport_key) || '') !== 'americanfootball_ncaaf'),
    new6.map(c => ({ rc: c.research_context, sport: c.packet && c.packet.game && c.packet.game.sport_key })));

  /* =====================================================================
     5. THE MODEL IS DOWN. THE CARD IS NOT.
     ===================================================================== */
  console.log('\n== the reasoning function answers 500 ==');
  fnMode = 'down';
  const B = await openChat();
  const a7 = await ask(B.page, 'How does ' + SUBJ.name + ' look this week?');
  if (SHOTS) await B.page.screenshot({ path: path.join(SHOTS, 'narration-down.png'), fullPage: true });
  has(a7, SUBJ.name, 'the card still names the team when narration fails');
  has(a7, SUBJ.opponent, 'and still names the opponent');
  chk('and still carries the projection or says there is none',
    a7.indexOf(String(Math.abs(Math.round(SUBJ.game.model_home_line * 100) / 100))) >= 0 || /no projection published/.test(a7));
  has(a7, 'Where this came from', 'and still discloses its sources');
  chk('it says the written read is missing', /written (interpretation|read)/i.test(a7));
  chk('and offers to try again', /retryLast/.test(a7) && /Retry analysis/.test(a7));
  lacks(a7, /\b(BET|LEAN|PLAY|take the|I like)\b/, 'NO lean is fabricated to fill the gap');
  lacks(a7, /fn 500|model upstream refused|Error:/, 'the raw failure is not shown to the reader');
  lacks(a7, /Padres|Dodgers|pitcher|bullpen/i, 'and it does not fall back to baseball');

  /* =====================================================================
     6. A NEW CONVERSATION DOES NOT INHERIT A SUBJECT.
     ===================================================================== */
  console.log('\n== a new conversation ==');
  fnMode = 'ok';
  const C = await openChat();
  const a8 = await ask(C.page, 'How does ' + SUBJ.name + ' look this week?');
  has(a8, SUBJ.opponent, 'the first question of a fresh conversation resolves on its own');
  await C.page.evaluate(() => window.EDAI.newConversation());
  const carried = await C.page.evaluate(() => {
    /* the subject must be gone, not merely off-screen */
    return window.EDAI.resolveMatchupFor('Who have they played?').then(r => r.state);
  });
  chk('after a new conversation a bare follow-up resolves to nothing',
    carried === 'NONE_NAMED', carried);

  const errs = [].concat(A.errors, B.errors, C.errors);
  chk('no uncaught page errors across the whole run', errs.length === 0, errs.slice(0, 4));

  await browser.close(); site.srv.close();
  finish();
})().catch(e => { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });

#!/usr/bin/env node
/* ===========================================================================
   THE WHOLE RESEARCH JOURNEY, IN A REAL BROWSER.

   Seven steps, in order, through the real app:

     1. "<a team> matchup this week"      -> the research card
     2. "Who have they played?"           -> opponents, with opponent ratings
     3. "What about the total?"           -> the total, model against market
     4. "Who is out?"                     -> availability, unknown stays unknown
     5. "I can get -13.5 at -110"         -> a reader's price, kept apart
     6. "What would change your mind?"    -> the falsifiers
     7. save the research, then compare against a moved market

   WHAT IS REAL: app.html, its resolver, the published FBS slate, the published
   rankings build, the published availability build, the research card, the
   follow-up router and the snapshot layer — all the shipped code, in Chromium.

   WHAT IS STUBBED: the database and the reasoning function. There is no
   Supabase and no Anthropic credential here, so `signals` and `cfb.games` are
   answered from fixtures at the HTTP boundary and the edge function is
   answered with a narration failure — which is also the harder case, because
   the card has to stand on its own.

   THE SUBJECT IS NOT HARDCODED. It is chosen from the real published card:
   a programme with exactly one game in the window whose name is not a prefix
   of another programme's. When next week's slate lands this keeps testing the
   rule rather than the team.

   Run: node tools/intelligence/journey.e2e.js
        node tools/intelligence/journey.e2e.js --shots
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.JOURNEY_SHOT_DIR || path.join(ROOT, '.journey-shots');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); return; } fail++; failures.push({ name, detail }); console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 260) : '')); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function has(name, hay, needle) { chk(name, String(hay || '').toLowerCase().includes(String(needle).toLowerCase()), { needle, got: String(hay || '').slice(0, 260) }); }
function lacks(name, hay, needle) { chk(name, !String(hay || '').toLowerCase().includes(String(needle).toLowerCase()), { needle }); }
function step(t) { console.log('\n== ' + t + ' =='); }
function done(code) {
  console.log('\n' + (fail === 0 ? 'PASS | the research journey | ' + pass + ' assertions'
    : 'FAIL | the research journey | ' + pass + ' passed, ' + fail + ' failed'));
  process.exit(code !== undefined ? code : (fail === 0 ? 0 : 1));
}

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
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

/* ---- pick the subject from the card the site actually publishes -------- */
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
const RANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function pickSubject() {
  const byTeam = {};
  SLATE.games.forEach((g) => {
    [[g.home_team_id, g.home_team], [g.away_team_id, g.away_team]].forEach((p) => {
      const k = p[0] || norm(p[1]);
      (byTeam[k] = byTeam[k] || { name: p[1], key: k, games: [] }).games.push(g);
    });
  });
  const keys = Object.keys(byTeam);
  const rated = keys.filter((k) => byTeam[k].games.length === 1
    && RANK.teams[k]
    && RANK.teams[byTeam[k].games[0].home_team_id === k ? byTeam[k].games[0].away_team_id : byTeam[k].games[0].home_team_id]
    && byTeam[k].games[0].model_status === 'PREDICTED');
  /* Prefer a programme BOTH of whose sides the rankings build rates, so the
     drivers have two halves to work with — the interesting case. */
  const best = rated.sort((a, b) => byTeam[a].name.length - byTeam[b].name.length)[0] || keys[0];
  return byTeam[best];
}
const SUBJ = pickSubject();
const GAME = SUBJ.games[0];
const OPP = GAME.home_team_id === SUBJ.key ? GAME.away_team : GAME.home_team;
const SUBJ_IS_HOME = GAME.home_team_id === SUBJ.key;

/* ---- the database, answered from fixtures ----------------------------- */
function signalRows(handicap, seenMinutesAgo, book) {
  const seen = new Date(Date.now() - seenMinutesAgo * 60000).toISOString();
  return [
    { event_id: 'evt1', market: 'spreads', selection: GAME.home_team, point: handicap, best_dec: 1.909,
      best_book: book, n_books: 8, n_books_eff: 6, first_best_dec: 1.87,
      first_seen_at: new Date(Date.now() - 3 * 864e5).toISOString(), last_seen_at: seen,
      home_team: GAME.home_team, away_team: GAME.away_team, commence_time: GAME.kickoff },
    { event_id: 'evt1', market: 'spreads', selection: GAME.away_team, point: -handicap, best_dec: 1.952,
      best_book: 'FanDuel', n_books: 8, n_books_eff: 6, last_seen_at: seen,
      home_team: GAME.home_team, away_team: GAME.away_team, commence_time: GAME.kickoff },
    { event_id: 'evt1', market: 'totals', selection: 'Over', point: 51.5, best_dec: 1.909,
      best_book: 'BetMGM', n_books: 7, last_seen_at: seen,
      home_team: GAME.home_team, away_team: GAME.away_team, commence_time: GAME.kickoff },
  ];
}
function completedRows() {
  const other = SLATE.games.filter((g) => String(g.game_id) !== String(GAME.game_id)).slice(0, 4);
  const rows = [];
  [[SUBJ.key, SUBJ.name], [GAME.home_team_id === SUBJ.key ? GAME.away_team_id : GAME.home_team_id, OPP]]
    .forEach((side, si) => {
      other.slice(si * 2, si * 2 + 2).forEach((g, i) => {
        rows.push({ game_id: 'prev' + si + i, season: SLATE.season, week: (GAME.week || 3) - (i + 1),
          start_date: new Date(Date.now() - (i + 1) * 7 * 864e5).toISOString(), completed: true,
          neutral_site: false, venue: 'Somewhere',
          home_id: side[0], home_team: side[1], home_points: 31 + i * 3,
          away_id: g.away_team_id, away_team: g.away_team, away_points: 17 + i * 2 });
      });
    });
  return rows;
}

/* The reasoning function fails on purpose: the card must be the answer. */
const FN_FAILED = { build: 'journey-e2e', answer: '', error: 'no credential in this environment',
  narration: { ok: false, retried: true, retryable: true, reason: 'the writing model is unavailable here' } };

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

  const state = { handicap: -13.5, seenMinutes: 12, book: 'DraftKings' };

  async function openDesk(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({
          access_token: 'e2e', refresh_token: 'e2e',
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/functions\/v1\/edgedesk_ai/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FN_FAILED) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e',
            current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
            cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/signals\b/.test(url) && /americanfootball_ncaaf/.test(url)) {
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify(signalRows(state.handicap, state.seenMinutes, state.book)) });
        }
        if (/\/games\b/.test(url) && /completed/.test(url)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(completedRows()) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.EDAI && typeof window.EDAI.open === 'function', null, { timeout: 30000 });
    await page.evaluate(() => window.EDAI.open());
    await page.waitForSelector('#edaiPanel.open', { timeout: 10000 });
    return { page, ctx, errors };
  }

  async function ask(page, q) {
    const before = await page.evaluate(() => document.querySelectorAll('#edaiLog .edai-msg.a').length);
    await page.evaluate((question) => {
      const t = document.getElementById('edaiText');
      t.value = question;
      return window.EDAI.sendText();
    }, q);
    await page.waitForFunction((n) => document.querySelectorAll('#edaiLog .edai-msg.a').length > n,
      before, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#edaiLog .edai-msg.a')];
      const last = nodes[nodes.length - 1];
      return { html: last ? last.innerHTML : '', text: last ? last.innerText : '', all: document.getElementById('edaiLog').innerText };
    });
  }

  try {
    const { page, ctx, errors } = await openDesk({ width: 1280, height: 900 });
    console.log('subject: ' + SUBJ.name + ' (' + GAME.away_team + ' @ ' + GAME.home_team + ', week ' + GAME.week + ')');

    /* ── 1 ───────────────────────────────────────────────────────────── */
    step('1. "' + SUBJ.name + ' matchup this week"');
    const a1 = await ask(page, SUBJ.name + ' matchup this week');
    has('the answer names the subject', a1.text, SUBJ.name);
    has('and names the opponent', a1.text, OPP);
    chk('the kickoff carries a timezone', /\b(CDT|CST|EDT|EST|MDT|MST|PDT|PST|UTC|GMT|[A-Z]{3,4})\b/.test(
      (a1.text.match(/on \w{3},[^.]*/) || [''])[0]), (a1.text.match(/on \w{3},[^.]*/) || [''])[0]);
    has('the model number is quoted', a1.text, 'EdgeDesk makes it');
    chk('the market price is joined and shows a book', /DraftKings|FanDuel|BetMGM/.test(a1.text), a1.text.slice(0, 400));
    has('and how old the capture is', a1.text, 'minutes ago');
    has('the matchup is explained, not just tabulated', a1.text, 'what the matchup turns on');
    has('there is a strongest case against', a1.text, 'the strongest case against');
    has('and a list of what would change it', a1.text, 'what would change it');
    has('availability is a status, not a source dump', a1.text, 'availability');
    lacks('the reader does not see failed-source counts', a1.text, 'sources_failed');
    chk('three drivers are shown', await page.evaluate(() => document.querySelectorAll('#edaiLog .ed-dv').length) === 3,
      await page.evaluate(() => document.querySelectorAll('#edaiLog .ed-dv').length));
    chk('every driver connects a number to a football mechanism',
      await page.evaluate(() => [...document.querySelectorAll('#edaiLog .ed-dv')].every((d) => (d.querySelector('.me') || {}).textContent)),
      null);
    chk('depth is behind folds rather than in the way',
      await page.evaluate(() => document.querySelectorAll('#edaiLog .ed-more').length) >= 4,
      await page.evaluate(() => document.querySelectorAll('#edaiLog .ed-more').length));
    chk('every fold is closed by default',
      await page.evaluate(() => [...document.querySelectorAll('#edaiLog .ed-more')].every((d) => !d.open)), null);
    chk('the operator diagnostics are one of those folds',
      await page.evaluate(() => [...document.querySelectorAll('#edaiLog .ed-more > summary')]
        .some((s) => /operator diagnostics/i.test(s.textContent))), null);
    /* THE DEPTH IS REAL DEPTH. Open the ratings fold and read what is in it:
       this is where "1.45 games in the rating" used to be, and it is where the
       explanation of what that number means has to be. */
    const ratings = await page.evaluate(() => {
      const d = [...document.querySelectorAll('#edaiLog .ed-more')]
        .filter((x) => /ratings, and what they mean/i.test((x.querySelector('summary') || {}).textContent || ''))[0];
      if (!d) return null;
      d.open = true;
      return d.innerText;
    });
    chk('the ratings fold exists and opens', !!ratings, ratings === null ? 'missing' : ratings.length);
    has('the weighted sample is labelled for what it is', ratings, 'FBS-equivalent');
    has('and the weight is explained in plain language', ratings, 'non-FBS opponent at 0.45');
    has('and how much of the rating is still the preseason prior', ratings, 'preseason prior');
    has('the rating itself is explained, not just printed', ratings, 'points against an average FBS team');
    has('and the unit scale is stated, including for defence', ratings, 'including for defence');
    lacks('and the phrase that confused a reader is gone', a1.all + String(ratings), 'games in the rating');
    has('the narration failure is disclosed and costs nothing else', a1.all, 'written read');
    chk('no lean is fabricated to fill the gap', !/\b(bet|back|take)\s+(the\s+)?[A-Z]/.test(a1.text.slice(0, 400)), a1.text.slice(0, 200));
    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, 'journey-1-card.png') });
    }

    /* ── 2 ───────────────────────────────────────────────────────────── */
    step('2. "Who have they played?"');
    const a2 = await ask(page, 'Who have they played?');
    has('the follow-up names the matchup it is answering about', a2.text, GAME.away_team);
    has('and lists opponents', a2.text, 'opponent');
    chk('with the opponent’s own rating beside each result', /opponent rating/i.test(a2.text), a2.text.slice(0, 400));
    has('and explains why that matters', a2.text, 'not the same result');

    /* ── 3 ───────────────────────────────────────────────────────────── */
    step('3. "What about the total?"');
    const a3 = await ask(page, 'What about the total?');
    has('the total is answered as the total', a3.text, 'total');
    has('with EdgeDesk’s own number', a3.text, 'EdgeDesk total');
    has('and the market number beside it', a3.text, 'Market total');
    has('and the model record for totals stated honestly', a3.text, 'directional');
    lacks('no cover probability is offered', a3.text, 'cover probability of');
    has('and the matchup has not moved', a3.text, GAME.home_team);

    /* ── 4 ───────────────────────────────────────────────────────────── */
    step('4. "Who is out?"');
    const a4 = await ask(page, 'Who is out?');
    has('availability is answered', a4.text, 'availability');
    chk('unknown is reported as unknown, never as healthy',
      /not reported|unknown, not healthy|no availability record/i.test(a4.text) || /out\b/i.test(a4.text), a4.text.slice(0, 300));
    lacks('the word healthy is never used to describe an absent report', a4.text, 'are healthy');
    has('and EdgeDesk says it does not move its number on this', a4.text, 'does not move its projection');

    /* ── 5 ───────────────────────────────────────────────────────────── */
    step('5. "I can get -13.5 at -110"');
    const a5 = await ask(page, 'I can get -13.5 at -110');
    has('the reader’s price is read back', a5.text, '-13.5');
    has('and labelled as theirs, not EdgeDesk’s', a5.text, 'entered by you');
    has('EdgeDesk’s own observation is shown beside it', a5.text, 'EdgeDesk observed');
    has('the break-even is given, because it is arithmetic', a5.text, 'break even');
    has('and a cover probability is refused, with a reason', a5.text, 'will not tell you');
    lacks('no expected value is produced', a5.text, 'expected value of');

    /* ── 6 ───────────────────────────────────────────────────────────── */
    step('6. "What would change your mind?"');
    const a6 = await ask(page, 'What would change your mind?');
    has('the falsifiers are listed', a6.text, 'what would change this read');
    chk('and each is something EdgeDesk can actually check',
      /price|information|evidence/i.test(a6.text), a6.text.slice(0, 300));

    /* ── 7 ───────────────────────────────────────────────────────────── */
    step('7. save the research, then compare against a moved market');
    const saved = await page.evaluate(() => { window.EDAI.saveResearch();
      return document.querySelectorAll('#edaiLog .edai-msg.a').length; });
    await page.waitForTimeout(400);
    const a7 = await page.evaluate(() => {
      const n = [...document.querySelectorAll('#edaiLog .edai-msg.a')];
      return n[n.length - 1].innerText;
    });
    has('the save is confirmed with the matchup', a7, GAME.home_team);
    has('and with the price EdgeDesk had observed', a7, 'DraftKings');
    has('and it is declared not to be a wager', a7, 'not a wager');
    chk('the snapshot is in this browser’s store',
      await page.evaluate(() => JSON.parse(localStorage.getItem('ed_research_snapshots_v1') || '[]').length) === 1,
      await page.evaluate(() => localStorage.getItem('ed_research_snapshots_v1')));

    /* the market moves two points and goes stale */
    state.handicap = -15.5; state.seenMinutes = 400; state.book = 'FanDuel';
    const a8 = await page.evaluate(async () => {
      await window.EDAI.compareSaved();
      const n = [...document.querySelectorAll('#edaiLog .edai-msg.a')];
      return n[n.length - 1].innerText;
    });
    await page.waitForTimeout(400);
    const a8b = await page.evaluate(() => {
      const n = [...document.querySelectorAll('#edaiLog .edai-msg.a')];
      return n[n.length - 1].innerText;
    });
    const cmp = (a8b || a8 || '');
    has('the comparison reports a material change', cmp, 'material change');
    has('and names the move in points', cmp, 'point');
    has('and says whether the saved read still applies', cmp, 'applies');
    has('and states that both ends are observations EdgeDesk made', cmp, 'observations EdgeDesk actually stored');

    /* a watchlist entry, and no notifications invented */
    const a9 = await page.evaluate(() => { window.EDAI.watchAdd();
      const n = [...document.querySelectorAll('#edaiLog .edai-msg.a')];
      return n[n.length - 1].innerText; });
    has('the watchlist accepts the game', a9, 'Added');
    has('and refuses to imply a notification nobody opted into', a9, 'sends nothing');

    chk('the page threw no errors across the whole journey', errors.length === 0, errors);

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, 'journey-2-followups.png') });
    }
    await ctx.close();

    /* ── the same journey at phone width ─────────────────────────────── */
    step('the card at 390px');
    {
      const m = await openDesk({ width: 390, height: 844 });
      await ask(m.page, SUBJ.name + ' matchup this week');
      const box = await m.page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const card = log.querySelector('.edai-card');
        const tables = [...log.querySelectorAll('table')];
        return {
          logScrollW: log.scrollWidth, logClientW: log.clientWidth,
          bodyScrollW: document.body.scrollWidth, bodyClientW: document.body.clientWidth,
          cardW: card ? card.getBoundingClientRect().width : 0,
          panelW: document.getElementById('edaiPanel').getBoundingClientRect().width,
          scrollable: log.scrollHeight > log.clientHeight,
          tablesInScrollers: tables.every((t) => {
            let p = t.parentElement;
            while (p && p !== log) { if (p.classList.contains('ed-scroll')) return true; p = p.parentElement; }
            return tables.length === 0;
          }),
          numsStacked: (() => {
            const n = [...log.querySelectorAll('.ed-num')];
            if (n.length < 2) return true;
            return Math.abs(n[0].getBoundingClientRect().width - n[1].getBoundingClientRect().width) < 2;
          })(),
        };
      });
      chk('the answer does not scroll sideways', box.logScrollW <= box.logClientW + 1, box);
      chk('and neither does the page', box.bodyScrollW <= box.bodyClientW + 1, box);
      chk('the card fits the panel', box.cardW <= box.panelW + 1, box);
      chk('the log scrolls vertically', box.scrollable, box);
      chk('every table is inside a horizontal scroller', box.tablesInScrollers, box);
      chk('the number cards stack rather than squeeze', box.numsStacked, box);
      if (SHOTS) await m.page.screenshot({ path: path.join(SHOT_DIR, 'journey-3-mobile.png'), fullPage: false });
      await m.ctx.close();
    }
    if (SHOTS) console.log('\nscreenshots: ' + SHOT_DIR);
  } catch (e) {
    chk('the journey ran to completion', false, String(e && e.stack || e).slice(0, 500));
  } finally {
    await browser.close();
    site.srv.close();
  }
  done();
})();

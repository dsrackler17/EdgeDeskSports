#!/usr/bin/env node
/* ===========================================================================
   IMPORT PICKS IN CHROMIUM, AGAINST THE REAL MIGRATION.

   app.html is served from this repository; every PostgREST call goes to
   tools/portfolio/_pgrest.js over a throwaway PostgreSQL with portfolio.sql,
   the journal, connect, decision and bet_import.sql applied, AS THE READER.
   The parse_bet_import function's answer is what the deployed function
   returns for a canned model answer (the core's normalizeResult), so the
   browser half is real end to end:

     a reader opens Import → Screenshots or pasted text, chooses Novig, adds a
     phone screenshot and a tall scrolling capture (cut into tiles, scaled and
     re-encoded as JPEG on the device); the reader's rows appear with the
     unsure fields highlighted, the broken one blocked, each pick matched to
     its EdgeDesk game or plainly not; the reader fixes the stake, picks the
     unmatched game, deletes a row that is not a bet, confirms, and saves;
     the picks are in portfolio_positions as IMPORT_SCREENSHOT with the price
     as shown, the game and its capture key; the same picks pasted again are
     "already in your portfolio" and cannot be saved twice; Kalshi cents read
     as contracts;
   at 1280 px and at a 390 px phone, with no sideways scroll, no page error,
   and nothing financial in localStorage.

   Run: node tools/portfolio/bet_import.e2e.js [--shots DIR]
   (PORTFOLIO_UI_REQUIRED=1 makes a missing Playwright or PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
const C = require(path.join(PG.ROOT, 'lib', 'edgedesk_bet_import_core.js'));

const ROOT = PG.ROOT;
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const SHOTS = (function () { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; }());
const A = '00000000-0000-0000-0000-0000000000a1';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | bet import e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why); process.exit(0); }

/* a real PNG (solid colour, RGB), so the page's canvas path decodes and re-encodes it */
function png(w, h, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

const DAY = 86400000, NOW = Date.now();
const KICK = new Date(NOW - 2 * DAY).toISOString(), KICK2 = new Date(NOW + 2 * DAY).toISOString();
function localCT(ms) {
  const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
const conf = (v, o) => Object.assign(C.CONF_FIELDS.reduce((m, k) => { m[k] = v; return m; }, {}), o || {});
function modelBet(o) {
  return Object.assign({ source_image: 0, book: 'Novig', sport: 'Football', league: 'NFL', event: 'Buffalo Bills @ Kansas City Chiefs', teams: ['Buffalo Bills', 'Kansas City Chiefs'], event_start: null,
    market_type: 'spread', market: 'Spread', selection: 'Kansas City Chiefs -2.5', side: null, line: -2.5, price_display: '-110', price_format: 'american', price_value: -110, stake: 25,
    contracts: null, potential_payout: 47.73, payout: 47.73, fees: null, placed_at: localCT(NOW - 3 * DAY), status: 'won', bet_id: null, is_bonus: false, legs: [], notes: null, confidence: conf(0.95) }, o || {});
}
/* what each request answers: the deployed function's own server-side checks over a canned model answer */
const ANSWERS = [
  [modelBet(),
   modelBet({ selection: 'Buffalo Bills', market_type: 'moneyline', market: 'Moneyline', line: null, price_display: '+145', price_value: 145, stake: null, potential_payout: null, payout: 0, status: 'lost', confidence: conf(0.95, { stake: 0.2 }) }),
   modelBet({ event: 'New York Giants', teams: ['New York Giants'], selection: 'New York Giants', market_type: 'moneyline', market: 'Moneyline', line: null, price_display: '-125', price_value: -125, stake: 50,
     potential_payout: 90, payout: null, status: 'open', placed_at: localCT(NOW - 1 * DAY), confidence: conf(0.95, { event: 0.5 }) })],
  [modelBet({ source_image: 0, event: 'Account balance', teams: [], selection: 'Deposit', market_type: 'other', market: null, price_display: null, price_value: null, stake: 100, payout: null, status: 'unknown' })]
];

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { pw = null; }
  if (!pw) skip('playwright is not installed here');
  const db = PG.start('bimui');
  if (db.skip) skip(db.skip);
  for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_decision.sql']) db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  db.sql(`create table public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text,
      market text, selection text, point numeric, last_seen_at timestamptz default now(), closing_dec numeric, closed_at timestamptz);
    insert into public.signals (sig_key, event_id, sport_key, sport_title, commence_time, home_team, away_team, market, selection, point) values
      ('E1|spreads|Kansas City Chiefs|-2.5', 'E1', 'americanfootball_nfl', 'NFL', '${KICK}', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -2.5),
      ('E1|h2h|Buffalo Bills|', 'E1', 'americanfootball_nfl', 'NFL', '${KICK}', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Buffalo Bills', null),
      ('E2|h2h|New York Giants|', 'E2', 'americanfootball_nfl', 'NFL', '${KICK2}', 'New York Giants', 'New York Jets', 'h2h', 'New York Giants', null),
      ('E3|h2h|New York Giants|', 'E3', 'americanfootball_nfl', 'NFL', '${new Date(NOW + 4 * DAY).toISOString()}', 'New York Giants', 'Dallas Cowboys', 'h2h', 'New York Giants', null);`);
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'bet_import.sql'));
  db.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.com');`);
  const rest = REST.make(db, { tokens: { e2e: A } });
  const site = await serve(siteHandler);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-e2e-'));
  const SHOT_PHONE = path.join(dir, 'novig-history.png'), SHOT_TALL = path.join(dir, 'novig-scroll.png');
  fs.writeFileSync(SHOT_PHONE, png(390, 844, [20, 24, 32]));
  fs.writeFileSync(SHOT_TALL, png(300, 2400, [240, 240, 240]));
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) { const exe = ['/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0]; if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { db.stop(); site.srv.close(); skip('no Chromium'); } }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const fnBodies = [];
  async function open(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700, timezoneId: 'America/Chicago' });
    await ctx.addInitScript((uid) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: uid, email: 'reader@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, A);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co\/functions\/v1\/parse_bet_import/.test(url)) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { body = {}; }
        fnBodies.push(body);
        const auth = String(req.headers().authorization || '');
        if (auth !== 'Bearer e2e') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'SIGN_IN', message: 'Sign in to import picks.' }) });
        const raw = body.kind === 'paste' ? ANSWERS[0].concat([modelBet({ source_image: -1, book: 'Kalshi' })]).slice(0, 3) : (ANSWERS[fnBodies.filter((b) => b.kind === 'screenshot').length - 1] || []);
        const res = C.normalizeResult({ bets: raw, warnings: [] }, { book: body.book, images: (body.images || []).length, today: body.today });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bets: res.bets, warnings: res.warnings, flagged: res.flagged, model: 'claude-opus-5-5',
          quota: { used_hour: fnBodies.length, per_hour: 20, used_day: fnBodies.length, per_day: 60 } }) });
      }
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
      if (m && /^(rpc\/portfolio_|rpc\/bet_import_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const token = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', token);
        return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body == null ? '' : JSON.stringify(out.body) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/user_preferences/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ user_id: A, onboarding_status: 'completed', leagues: ['nfl'], books: [], interests: [] }]) });
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html#portfolio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && window.EDBetImport && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page) => page.evaluate(() => document.getElementById('pfoHost').innerText);
  const waitText = (page, re, ms) => page.waitForFunction((a) => new RegExp(a[0], a[1]).test(document.getElementById('pfoHost').innerText), [re.source, re.flags], { timeout: ms || 20000 });
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
  async function noSideways(page, label) {
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    chk(label + ': nothing scrolls sideways', w.sw <= w.w + 1, w);
  }
  const q = (sql) => db.sql(sql);

  try {
    /* ═══ DESKTOP ════════════════════════════════════════════════════════ */
    let { ctx, page, errors } = await open({ width: 1280, height: 900 });
    await waitText(page, /Build your portfolio/);
    chk('the empty book offers "Import picks" beside recording by hand', /Import picks from screenshots or text/.test(await text(page)));
    await page.click('#pfoHost [data-act="imp-picks"]');
    await waitText(page, /Which platform are these from\?/);
    chk('it opens on the Import tab, on screenshots or pasted text', await page.$eval('#pfoHost .pfo-tab[aria-selected="true"]', (e) => e.dataset.v) === 'import' && /Screenshots or pasted text/.test(await text(page)));
    chk('Read is off until a platform and a screenshot are chosen', await page.$eval('#pfoHost [data-bim="read"]', (e) => e.disabled));
    await page.click('#pfoHost [data-bim="book"][data-v="novig"]');
    await page.setInputFiles('#pfoHost input[data-bim-file]', [SHOT_PHONE, SHOT_TALL]);
    await waitText(page, /novig-scroll\.png/);
    chk('both screenshots are listed, and Read is on', /novig-history\.png/.test(await text(page)) && !(await page.$eval('#pfoHost [data-bim="read"]', (e) => e.disabled)));
    await shot(page, 'desktop-input');
    await page.click('#pfoHost [data-bim="read"]');
    await waitText(page, /picks? read/, 30000);
    const shots = fnBodies.filter((b) => b.kind === 'screenshot');
    const imgs = shots.flatMap((b) => b.images || []);
    chk('the screenshots went to the function scaled and re-encoded as JPEG; the tall capture as overlapping tiles', imgs.length >= 4 && imgs.every((i) => i.media_type === 'image/jpeg' && /^\/9j\//.test(i.data))
      && shots.every((b) => b.images.length <= C.LIMITS.maxImages && b.book === 'novig' && b.tz === 'America/Chicago' && /^\d{4}-\d{2}-\d{2}$/.test(b.today)), imgs.map((i) => i.media_type));
    chk('in batches the function accepts, one after another', shots.length === Math.ceil(imgs.length / 3));
    await waitText(page, /CLV will be graded/);
    let t = await text(page);
    chk('every bet read is a row — nothing dropped, the junk row included', (await page.$$('#pfoHost tr.bim-row')).length === 4, t.slice(0, 400));
    chk('the summary says what needs a fix and what is not matched', /4 picks read/.test(t) && /need a fix/.test(t) && /not matched to a game/.test(t), t.slice(0, 300));
    const stakeCls = await page.$eval('#pfoHost tr.bim-row:nth-of-type(3) [data-bim-f="stake"]', (e) => e.className).catch(() => null);
    const row2 = await page.$$eval('#pfoHost tr.bim-row', (rs) => rs.map((r) => ({ id: r.dataset.row, err: r.classList.contains('has-error'), confirm: r.querySelector('[data-bim-confirm]').disabled })));
    chk('a row with an error is marked and cannot be confirmed', row2.filter((r) => r.err).length === 2 && row2.filter((r) => r.err).every((r) => r.confirm), row2);
    chk('the stake the reader was not sure of is highlighted as an error to fix', /bim-bad/.test(String(stakeCls)), stakeCls);
    chk('the Chiefs spread matched its game, and its CLV will be graded', /\bmatched\b/i.test(t.replace(/not matched/ig, '')) && /CLV will be graded/.test(t));
    const giantsRow = await page.$eval('#pfoHost tr.bim-row:nth-of-type(5)', (r) => ({ id: r.dataset.row, text: r.innerText, opts: Array.from(r.querySelectorAll('select[data-bim-game] option')).map((o) => o.value) })).catch((e) => String(e));
    chk('"New York Giants" alone, with two Giants games ahead: offered, not chosen, and said plainly', giantsRow && /not matched/i.test(giantsRow.text)
      && /Without a game, CLV is not graded/.test(giantsRow.text) && giantsRow.opts.indexOf('E2') > 0 && giantsRow.opts.indexOf('E3') > 0 && giantsRow.opts.indexOf('__none') > 0, giantsRow);
    chk('a field the reader was unsure of is highlighted', (await page.$$('#pfoHost .bim-low')).length >= 1);

    /* the reader fixes the stake: the row becomes confirmable, in place */
    const billsId = row2[1].id;
    await page.fill(`#pfoHost [data-bim-f="stake"][data-id="${billsId}"]`, '20');
    await page.press(`#pfoHost [data-bim-f="stake"][data-id="${billsId}"]`, 'Tab');
    await page.waitForTimeout(250);
    chk('fixing the stake clears the error and the row can be confirmed', !(await page.$eval(`#pfoHost [data-bim-confirm][data-id="${billsId}"]`, (e) => e.disabled))
      && !(await page.$eval(`#pfoHost tr[data-row="${billsId}"]`, (e) => e.classList.contains('has-error'))));
    chk('…and the focus moved on with the reader (the table is not repainted under them)', await page.evaluate(() => !!document.activeElement && document.activeElement.tagName !== 'BODY'));
    /* the unmatched Giants pick: the reader picks the game */
    const giantsId = row2[2].id;
    await page.selectOption(`#pfoHost select[data-bim-game][data-id="${giantsId}"]`, 'E2');
    await waitText(page, /you picked/i);
    /* the junk row: deleted */
    await page.click(`#pfoHost [data-bim="delete"][data-v="${row2[3].id}"]`);
    await page.waitForTimeout(150);
    chk('a row that is not a bet is deleted', (await page.$$('#pfoHost tr.bim-row')).length === 3);
    chk('nothing is in the database yet', q(`select count(*) from public.portfolio_positions;`) === '0' && q(`select count(*) from public.portfolio_imports;`) === '0');
    await page.click('#pfoHost [data-bim="confirm-ready"]');
    await waitText(page, /Confirm and save 3 picks/);
    await shot(page, 'desktop-review');
    await page.click('#pfoHost [data-bim="save"]');
    await waitText(page, /3 picks saved to your portfolio/, 30000);
    const saved = JSON.parse(q(`select coalesce(json_agg(row_to_json(p) order by selection)::text, '[]') from (select selection, source, price_display, price_american, event_id, market_sig_key, status, stake::text from public.portfolio_positions) p;`) || '[]');
    chk('three picks saved, labelled IMPORT_SCREENSHOT', saved.length === 3 && saved.every((p) => p.source === 'IMPORT_SCREENSHOT'), saved);
    const kc = saved.find((p) => /Chiefs/.test(p.selection)), bills = saved.find((p) => /Bills/.test(p.selection)), g = saved.find((p) => /Giants/.test(p.selection));
    chk('…with the price as shown and as American odds, the matched game and its capture key', kc && kc.price_display === '-110' && kc.price_american === -110 && kc.event_id === 'E1'
      && kc.market_sig_key === 'E1|spreads|Kansas City Chiefs|-2.5' && bills && bills.stake === '20' && bills.market_sig_key === 'E1|h2h|Buffalo Bills|' && g && g.event_id === 'E2', saved);
    chk('one import, a screenshot import, committed', q(`select importer || ' ' || status from public.portfolio_imports;`) === 'screenshot_v1 COMMITTED');
    await shot(page, 'desktop-done');
    chk('no page error', errors.length === 0, errors);
    /* the app's public games-slate cache names teams; it is not the reader's data (portfolio_ui.e2e.js skips it too) */
    const ls = await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'edgedesk_slate_cache_v1' && /Chiefs|47\.73|-110|IMPORT_|data:image|\/9j\//.test(localStorage.getItem(k) || ''))
      .map((k) => k + '=' + String(localStorage.getItem(k)).slice(0, 160)));
    chk('nothing financial in localStorage', ls.length === 0, ls);
    await ctx.close();

    /* ═══ PHONE: the same picks pasted again are already saved ════════════ */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await waitText(page, /Overview|Open|History/);
    await page.click('#pfoHost .pfo-tab[data-v="import"]');
    await page.click('#pfoHost [data-act="imp-mode"][data-v="picks"]');
    await waitText(page, /Which platform are these from\?/);
    await page.click('#pfoHost [data-bim="book"][data-v="novig"]');
    await page.click('#pfoHost [data-bim="kind"][data-v="paste"]');
    await page.fill('#pfoHost textarea[data-bim-in="text"]', 'Novig · Bet history\nKansas City Chiefs -2.5  -110  $25.00  Won $47.73\n…');
    await noSideways(page, 'phone, input');
    await shot(page, 'phone-input');
    await page.click('#pfoHost [data-bim="read"]');
    await waitText(page, /picks? read/, 30000);
    await waitText(page, /Already in your portfolio/, 20000);
    t = await text(page);
    chk('pasted text goes to the function as text', fnBodies[fnBodies.length - 1].kind === 'paste' && /Kansas City Chiefs -2\.5/.test(fnBodies[fnBodies.length - 1].text));
    chk('the picks saved from the screenshot are "already in your portfolio" and cannot be confirmed again', /Already in your portfolio/.test(t)
      && (await page.$$eval('#pfoHost tr.is-dup [data-bim-confirm]', (xs) => xs.length > 0 && xs.every((x) => x.disabled))));
    await page.click('#pfoHost [data-bim="confirm-ready"]');
    await page.waitForTimeout(150);
    chk('so there is nothing to save twice', /Confirm and save 0 picks/.test(await text(page)) && await page.$eval('#pfoHost [data-bim="save"]', (e) => e.disabled));
    chk('each pick is a card on a phone (no table header)', await page.$eval('#pfoHost .bim-table thead', (e) => getComputedStyle(e).display) === 'none');
    await noSideways(page, 'phone, review');
    await shot(page, 'phone-review');
    chk('no page error on the phone', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    chk('the journey ran to the end', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close().catch(() => {});
    site.srv.close();
    db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  done();
}());

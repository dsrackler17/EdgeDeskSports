#!/usr/bin/env node
/* ===========================================================================
   THE DESK, IN A REAL BROWSER, AT BOTH WIDTHS.

   Everything else in this suite asserts on strings. This opens app.html in
   Chromium, seeds a signed-in reader, answers the edge function from a stub
   and asks the question the customer asked — then checks what is actually on
   the screen.

   THE FAILURES IT EXISTS TO CATCH, each one reported by a reader:
     - six near-identical cards where the answer should be
     - the PRICE NEEDED filed under "against it" instead of opposing evidence
     - the engine's vocabulary (intent names, tiers, table names) in the prose
     - a narration failure leaving nothing but an apology
     - a panel that reads as a generic assistant rather than as EdgeDesk

   Run: node tools/intelligence/desk_ui.e2e.js
        node tools/intelligence/desk_ui.e2e.js --shots   (writes PNGs)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.DESK_SHOT_DIR || path.join(ROOT, '.desk-shots');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function done(code) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
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

/* ---- the function's answer, in both shapes ----------------------------- */
const SUMMARY = {
  matchup: 'North Texas @ Texas State', kickoff: new Date(Date.now() + 6 * 864e5).toISOString(),
  read: "Texas State is favored by 2.5, but EdgeDesk doesn't have enough current evidence to call that value. "
      + "The last FanDuel quote is stale — 38.5 hours old, so I'd treat the matchup as research-only until the market refreshes.",
  why: ['The market number: Texas State is favored by 2.5, last seen at FanDuel.',
        "EdgeDesk's model projects -2.4 on this side. It has no validated outcome probability in this market, so it is a comparison point, not an edge."],
  could_be_wrong: ['Current edge 0.4% is already below the 0.5% floor.',
                   'This model is marked EXPERIMENTAL in this market — its walk-forward record does not beat the closing line.'],
  price_needed: 'Good to -112; worse than that and the expected return falls below the floor.',
  data_blockers: ['The FanDuel quote is 38.5 hours old. It is the last price EdgeDesk observed, not one you can take now.',
                  'Texas State: no availability report on file. That is UNKNOWN, not healthy.'],
  primary: { market: 'spreads', selection: 'North Texas', handicap: 2.5, offered_american: '-105',
             book: 'FanDuel', freshness: 'STALE', decision: 'WATCH', strength: null },
  other_markets: 5,
  ev_provenance: 'This expected return is measured against a sharp-market fair price, not produced by EdgeDesk’s model — '
    + 'the model has no validated outcome probability in this market.',
  source: 'deterministic',
};
const DECISIONS = [
  { primary: true, market: 'spreads', selection: 'North Texas', handicap: 2.5, decision: 'WATCH', price: { offered_american: '-105', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
  { primary: false, market: 'spreads', selection: 'Texas State', handicap: -2.5, decision: 'WATCH', price: { offered_american: '-115', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
  { primary: false, market: 'totals', selection: 'Over', handicap: 57.5, decision: 'WATCH', price: { offered_american: '-110', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
  { primary: false, market: 'totals', selection: 'Under', handicap: 57.5, decision: 'WATCH', price: { offered_american: '-110', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
  { primary: false, market: 'h2h', selection: 'North Texas', handicap: null, decision: 'WATCH', price: { offered_american: '+120', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
  { primary: false, market: 'h2h', selection: 'Texas State', handicap: null, decision: 'WATCH', price: { offered_american: '-142', book: 'FanDuel' }, gates: { freshness: { status: 'STALE' } } },
];
const RESEARCH = {
  intent: 'cfb_research_matchup', depth: 'DEEP', sport: 'americanfootball_ncaaf',
  decisions: DECISIONS, evidence_packets: [],
  research_context: { sport: 'americanfootball_ncaaf', game_id: '401858900', away: 'North Texas', home: 'Texas State',
    away_id: 'northtexas', home_id: 'texasstate', single_game: true, sport_source: 'a matchup named in this message' },
};
const NARRATED = {
  build: 'e2e', model: 'claude-test', answer:
`**The Desk's read**
Texas State is favored by 2.5, but EdgeDesk doesn't have enough current evidence to call that value. The last FanDuel quote is stale, so I'd treat the matchup as research-only until the market refreshes.

**Why**
- The market has Texas State -2.5 and EdgeDesk's own number sits at -2.4, so the two effectively agree.
- North Texas is 2-0 but has not played anyone who tests them.

**What could make it wrong**
- The model is experimental in this market and does not beat the closing line.

**Price and data limitations**
- The FanDuel quote is 38.5 hours old.
- Neither side has an availability report on file.`,
  matchup_summary: SUMMARY, research: RESEARCH,
  ledger: { state: 'NOTHING_TO_RECORD', notice: null },
  narration: { ok: true, retried: false, retry: null },
};
/* WHAT THE DEPLOYMENT ACTUALLY RETURNED, probed live on 2026-09-15: the model
   answered at length and in the wrong shape, opening with the engine's own
   staleness caveat instead of a football read. Verbatim opening, abridged
   body. This is the failure the panel must not pass through. */
const WRONG_SHAPE = { build: 'e2e', model: 'claude-test',
  answer: 'WARNING — this answer is provisional. All six priced markets on North Texas @ Texas State are on '
    + 'stale quotes (captured 2345 minutes ago, well past the 90-minute freshness limit), so nothing below is '
    + 'currently bettable.\n\nThe deterministic decision layer returned WATCH on all six selections. '
    + 'Research priority is MEDIUM. The validation registry caps spreads at RESEARCH_LEAN.',
  matchup_summary: SUMMARY, research: RESEARCH,
  ledger: { state: 'NOTHING_TO_RECORD', notice: null },
  narration: { ok: true, retried: false, retry: null } };

/* A GAME THAT KICKED OFF FORTY MINUTES AGO. The reader is watching it. Every
   number EdgeDesk holds describes the game before it started, and the panel
   has to say so above the read rather than inside the limitations. */
const LIVE = { build: 'e2e', model: 'claude-test', answer: NARRATED.answer,
  matchup_summary: Object.assign({}, SUMMARY, {
    game_state: 'IN_PROGRESS',
    kickoff: new Date(Date.now() - 40 * 60000).toISOString(),
    read: 'North Texas @ Texas State is already under way. EdgeDesk\u2019s research is pregame only — no live '
      + 'price, score or clock is ingested — so what follows is what the desk had before kickoff, not a read on '
      + 'the game as it stands.',
    price_needed: null,
  }),
  research: RESEARCH, ledger: { state: 'NOTHING_TO_RECORD', notice: null },
  narration: { ok: true, retried: false, retry: null } };

const FAILED = { build: 'e2e', answer: '', error: 'empty completion',
  why: 'the model returned no text (stop_reason max_tokens).',
  narration: { ok: false, retried: true, retryable: true, reason: 'the writing model returned no text twice' },
  matchup_summary: SUMMARY, research: RESEARCH, ledger: { state: 'NOTHING_TO_RECORD', notice: null } };

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

  async function openDesk(viewport, reply) {
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
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e',
            current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
            cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
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
    await page.evaluate((question) => {
      const t = document.getElementById('edaiText');
      t.value = question;
      return window.EDAI.sendText();
    }, q);
    await page.waitForFunction(() => {
      const log = document.getElementById('edaiLog');
      return log && /dk-read/.test(log.innerHTML);
    }, null, { timeout: 20000 }).catch(() => {});
    return page.evaluate(() => document.getElementById('edaiLog').innerHTML);
  }

  const Q = 'What do you think about North Texas vs Texas State this week? Anything worth betting?';
  try {
    /* ══ 1. THE IDENTITY ══════════════════════════════════════════════ */
    {
      const { page, ctx } = await openDesk({ width: 1280, height: 900 }, NARRATED);
      const brand = await page.evaluate(() => {
        const top = document.querySelector('#edaiPanel .edai-top');
        const mark = document.querySelector('#edaiPanel .edai-mark');
        const cs = getComputedStyle(document.getElementById('edaiPanel'));
        return {
          name: top.querySelector('.edai-brand b').textContent.trim(),
          tagline: top.querySelector('.edai-brand span').textContent.trim(),
          mark: mark ? mark.textContent.trim() : null,
          markIsImg: !!(mark && mark.querySelector('img')),
          citron: cs.getPropertyValue('--citron').trim(),
          ink: cs.getPropertyValue('--ink').trim(),
          bg: cs.backgroundColor,
        };
      });
      eq('the panel introduces itself as The Desk', brand.name, 'The Desk');
      eq('and carries the tagline', brand.tagline, 'Sharp research. No fake certainty.');
      eq('the mark is an ED monogram', brand.mark, 'ED');
      chk('and is not a photo or avatar image', brand.markIsImg === false);
      chk('the panel defines a citron accent', /^#d8f24b$/i.test(brand.citron), brand.citron);
      chk('and an indigo ink ground', /^#141a3a$/i.test(brand.ink), brand.ink);
      chk('the panel is no longer painted on the board’s brown', brand.bg !== 'rgb(16, 14, 10)', brand.bg);
      await ctx.close();
    }

    /* ══ 2. A NARRATED MATCHUP ANSWER ════════════════════════════════ */
    {
      const { page, ctx, errors } = await openDesk({ width: 1280, height: 900 }, NARRATED);
      const html = await ask(page, Q);
      const seen = await page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const heads = [...log.querySelectorAll('.dk-read .lab, .dk-sec > .h')].map((e) => e.textContent.trim());
        const det = log.querySelector('details.dk-more');
        return {
          heads,
          reads: log.querySelectorAll('.dk-read').length,
          primaries: log.querySelectorAll('.dk-primary').length,
          moreOpen: det ? det.hasAttribute('open') : null,
          moreLabel: det ? det.querySelector('summary').textContent.trim() : null,
          rows: det ? det.querySelectorAll('table tr').length : 0,
          next: [...log.querySelectorAll('.dk-next button')].map((b) => b.textContent.trim()),
          legacyCards: log.querySelectorAll('.gd-modelnote').length,
          text: log.innerText,
        };
      });
      chk('the answer leads with The Desk’s read', /^the desk[\u2019']s read$/i.test(seen.heads[0] || ''), seen.heads);
      chk('and carries all four sections in order',
        seen.heads.length === 4
        && /^the desk[\u2019']s read$/i.test(seen.heads[0])
        && /^why$/i.test(seen.heads[1])
        && /^what could make it wrong$/i.test(seen.heads[2])
        && /^price and data limitations$/i.test(seen.heads[3]),
        seen.heads);
      eq('exactly one read block', seen.reads, 1);
      /* THE SIX-CARD PILE-UP. */
      eq('exactly one primary market is shown', seen.primaries, 1);
      chk('the other markets are behind a disclosure', /View all markets \(6\)/.test(seen.moreLabel || ''), seen.moreLabel);
      eq('which is closed by default', seen.moreOpen, false);
      eq('and lists every market once opened', seen.rows, 6);
      /* CONTEXTUAL FOLLOW-UPS. */
      chk('contextual follow-ups are offered',
        seen.next.indexOf('Pressure-test this') >= 0 && seen.next.indexOf('Who have they played?') >= 0
        && seen.next.indexOf('What price works?') >= 0, seen.next);
      /* NO INTERNAL VOCABULARY ON SCREEN. */
      /* Case-insensitive: the research trace renders uppercase, which is how
         "CFB_RESEARCH_MATCHUP · DEEP" sat at the foot of the answer while a
         case-sensitive check called it clean. */
      const flatAll = seen.text.toLowerCase();
      const leaks = ['cfb_research_matchup', 'cfb_betting_candidate', 'research_lean', 'data_path',
        'americanfootball_ncaaf', 'single_game', 'pgrst', 'recommendation_ledger',
        'slate scope', 'validation registry', 'evidence_packet']
        .filter((w) => flatAll.includes(w));
      chk('no internal classification reaches the screen', leaks.length === 0, leaks);
      /* The depth label is an engine word too, and it rode the same line. */
      chk('and neither does a depth or mode label',
        !/\bdeep\b|\bslate\b|\bquick\b|\bstandard\b/.test(
          (seen.text.match(/matchup research[^\n]*/i) || [''])[0].toLowerCase()),
        (seen.text.match(/matchup research[^\n]*/i) || [''])[0]);
      chk('the trace says what the desk did, in words',
        /matchup research/i.test(seen.text), (seen.text.match(/.{0,40}research.{0,40}/i) || [''])[0]);
      chk('the page threw no errors', errors.length === 0, errors);
      if (SHOTS) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, 'desk-desktop.png'), fullPage: false });
      }
      await ctx.close();
    }

    /* ══ 3. NARRATION FAILED — the same four sections, no invented lean ══ */
    {
      const { page, ctx, errors } = await openDesk({ width: 1280, height: 900 }, FAILED);
      await ask(page, Q);
      const seen = await page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const secText = (cls) => [...log.querySelectorAll('.dk-sec.' + cls + ' li')].map((li) => li.textContent.trim());
        return {
          heads: [...log.querySelectorAll('.dk-read .lab, .dk-sec > .h')].map((e) => e.textContent.trim()),
          primaries: log.querySelectorAll('.dk-primary').length,
          retry: !!log.querySelector('button[onclick*="retryLast"]'),
          read: (log.querySelector('.dk-read p') || {}).textContent || '',
          wrong: secText('wrong'),
          limits: secText('limits'),
          text: log.innerText,
        };
      });
      chk('a narration failure still shows The Desk’s read',
        /^the desk[\u2019']s read$/i.test(seen.heads[0] || ''), seen.heads);
      chk('with the same four sections',
        seen.heads.length === 4, seen.heads);
      eq('and still one primary market', seen.primaries, 1);
      chk('it says the read is EdgeDesk’s own, not the model’s',
        /Written by EdgeDesk, not by the model/i.test(seen.text));
      chk('it does not invent a view', /No view has been invented/i.test(seen.text));
      chk('and offers a retry', seen.retry);
      /* THE TARGET SENTENCE. */
      chk('the read is the factual one, in football English',
        /favored by 2\.5/.test(seen.text) && /research-only until the market refreshes/.test(seen.text),
        seen.text.slice(0, 260));
      /* PRICE NEEDED AND DATA BLOCKERS ARE LIMITATIONS, NOT COUNTERARGUMENTS.
         Asserted on the SECTIONS rather than on positions in the flattened
         text: the read legitimately mentions the stale quote, because the
         staleness is the reason for the read. What must not happen is either
         of these appearing in "What could make it wrong". */
      const inWrong = (re) => seen.wrong.some((x) => re.test(x));
      const inLimits = (re) => seen.limits.some((x) => re.test(x));
      chk('the price needed is a limitation', inLimits(/good to -112/i), seen.limits);
      chk('and is NOT filed as opposing evidence', !inWrong(/good to -112/i), seen.wrong);
      chk('the stale quote is a limitation', inLimits(/38\.5 hours old/i), seen.limits);
      chk('and is NOT filed as opposing evidence', !inWrong(/hours old|stale/i), seen.wrong);
      chk('a missing availability report is a limitation too',
        inLimits(/availability report/i), seen.limits);
      chk('what could make it wrong holds only opposing evidence',
        seen.wrong.length > 0 && seen.wrong.every((x) => !/hours old|refresh|availability report|not ingested/i.test(x)),
        seen.wrong);
      chk('the page threw no errors', errors.length === 0, errors);
      await ctx.close();
    }

    /* ══ 3b. THE MODEL ANSWERED, IN THE WRONG SHAPE ═══════════════════
       The live failure: 3,781 characters, zero sections, an operational
       preamble where the football read belongs. The panel must lead with the
       answer to the question and demote the prose, not pass it through. */
    {
      const { page, ctx, errors } = await openDesk({ width: 1280, height: 900 }, WRONG_SHAPE);
      await ask(page, Q);
      const seen = await page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const read = log.querySelector('.dk-read p');
        return {
          heads: [...log.querySelectorAll('.dk-read .lab, .dk-sec > .h')].map((e) => e.textContent.trim()),
          readText: read ? read.textContent.trim() : '',
          firstBlock: log.querySelector('.edai-msg.a') ? log.querySelector('.edai-msg.a').firstElementChild.className : null,
          notes: !!log.querySelector('details.dk-more summary'),
          notesLabels: [...log.querySelectorAll('details.dk-more summary')].map((e) => e.textContent.trim()),
          text: log.innerText,
        };
      });
      chk('a wrong-shaped answer still gets the four sections', seen.heads.length === 4, seen.heads);
      chk('and the read answers the question rather than warning about freshness',
        /favored by 2\.5/.test(seen.readText) && !/^WARNING/i.test(seen.readText), seen.readText.slice(0, 160));
      chk('the operational preamble does not lead the answer',
        !/^warning/i.test(seen.text.trim().split('\n').filter((l) => l.trim())[1] || ''),
        seen.text.slice(0, 200));
      chk('the prose is kept, demoted to a disclosure',
        seen.notesLabels.some((l) => /longer notes/i.test(l)), seen.notesLabels);
      chk('the page threw no errors', errors.length === 0, errors);
      await ctx.close();
    }

    /* ══ 4. MOBILE ═══════════════════════════════════════════════════ */
    {
      const { page, ctx, errors } = await openDesk({ width: 390, height: 844 }, NARRATED);
      await ask(page, Q);
      const m = await page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const panel = document.getElementById('edaiPanel');
        return {
          overflow: log.scrollWidth - log.clientWidth,
          panelW: panel.getBoundingClientRect().width,
          winW: window.innerWidth,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          heads: [...log.querySelectorAll('.dk-read .lab, .dk-sec > .h')].map((e) => e.textContent.trim()).length,
          primaries: log.querySelectorAll('.dk-primary').length,
          readTop: log.querySelector('.dk-read').getBoundingClientRect().top,
          logTop: log.getBoundingClientRect().top,
        };
      });
      chk('the answer does not scroll sideways on a phone', m.overflow <= 1, m);
      chk('and neither does the page', m.docOverflow <= 1, m);
      chk('the panel fills the phone width', Math.abs(m.panelW - m.winW) <= 1, m);
      eq('all four sections survive the narrow width', m.heads, 4);
      eq('still one primary market', m.primaries, 1);
      chk('the read is the first thing in the log', m.readTop - m.logTop < 120, m);
      chk('the page threw no errors', errors.length === 0, errors);
      if (SHOTS) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, 'desk-mobile.png'), fullPage: false });
      }
      await ctx.close();
    }
    /* ══ 5. A GAME THAT HAS STARTED SAYS SO, FIRST ══════════════════ */
    {
      const { page, ctx } = await openDesk({ width: 1280, height: 900 }, LIVE);
      await ask(page, Q);
      const live = await page.evaluate(() => {
        const log = document.getElementById('edaiLog');
        const b = log.querySelector('.dk-live');
        const read = log.querySelector('.dk-read');
        return {
          present: !!b,
          text: b ? b.innerText.replace(/\s+/g, ' ').trim() : null,
          /* It must sit ABOVE the read, not below it and not in the
             limitations list, which is where a reader stops looking. */
          aboveRead: !!(b && read && b.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING),
          priceNeeded: /Price needed/i.test(log.innerText),
        };
      });
      chk('a game under way carries the notice', live.present, live);
      chk('and it says the game has started', /under way/i.test(live.text || ''), live.text);
      chk('and that the research below is pregame', /pregame/i.test(live.text || ''), live.text);
      chk('and that no live price, score or clock is held', /live price/i.test(live.text || ''), live.text);
      chk('and it sits above the read, not under the limitations', live.aboveRead, live);
      chk('and no price to look for is offered on a game in progress', !live.priceNeeded, live);
      await ctx.close();

      /* A SCHEDULED GAME IS UNTOUCHED BY ANY OF THIS. */
      const pre = await openDesk({ width: 1280, height: 900 }, NARRATED);
      await ask(pre.page, Q);
      const none = await pre.page.evaluate(() =>
        !document.getElementById('edaiLog').querySelector('.dk-live'));
      chk('a scheduled game carries no such notice', none);
      await pre.ctx.close();
    }
  } catch (e) {
    console.log('THREW: ' + String((e && e.stack) || e).slice(0, 900));
    fail++;
  } finally {
    await browser.close().catch(() => {});
    site.srv.close();
  }
  if (SHOTS) console.log('screenshots: ' + SHOT_DIR);
  done();
})();

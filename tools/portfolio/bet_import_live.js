#!/usr/bin/env node
/* ===========================================================================
   SCREENSHOT / PASTE IMPORT — THE LIVE CHECK, with the reader's own key.

   Every other bet-import test mocks the model. This one sends real
   screenshots (or a pasted history) to the Anthropic API exactly as the
   deployed parse_bet_import does — the same request checks (readRequest),
   the same prompt, schema and model call (buildMessages / callModel,
   imported from supabase/functions/parse_bet_import/index.ts as deployed)
   and the same server-side checks (normalizeResult) — and prints what the
   review table would show. Nothing is written anywhere; no Supabase is
   involved; the images are read from disk and sent once.

   It is OPT-IN and costs a real API call. CI never runs it.

     ANTHROPIC_API_KEY=… node tools/portfolio/bet_import_live.js shot1.png shot2.png
     ANTHROPIC_API_KEY=… node tools/portfolio/bet_import_live.js --paste kalshi_history.txt --book kalshi
     ANTHROPIC_API_KEY=… node tools/portfolio/bet_import_live.js IMG_0412.PNG IMG_0413.PNG IMG_0414.PNG \
         --expect tools/portfolio/fixtures/dk_predictions_trades.json

   OPTIONS
     --book KEY       auto (default) · novig · prophetx · kalshi ·
                      draftkings_predictions · other (with --label NAME)
     --tz ZONE        the reader's time zone (default America/Chicago)
     --today DATE     YYYY-MM-DD (default: today in --tz)
     --expect FILE    a fixture with an `expect.rows` list (selection,
                      price_american, status, valid): exits 1 on a mismatch
     --json           print the normalized answer as JSON

   ENVIRONMENT (never echoed): ANTHROPIC_API_KEY; optional BET_IMPORT_MODEL,
   BET_IMPORT_EFFORT, BET_IMPORT_MAX_TOKENS, BET_IMPORT_TIMEOUT_MS,
   BET_IMPORT_FALLBACKS — the function's own settings.

   Screenshots go as they are on disk (PNG, JPEG, WebP or GIF, up to 4.5 MB
   each, six per request); the page in the browser scales and tiles them
   first, so a very tall capture reads better there than here.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_bet_import_core.js'));

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
const FLAGS = ['--book', '--tz', '--today', '--expect', '--paste', '--label'];
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !FLAGS.includes(all[i - 1]));
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function die(msg) { console.error(msg); process.exit(2); }
function todayIn(tz) {
  const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}
function cfgFromEnv() {
  const e = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
  return { apiKey: e('ANTHROPIC_API_KEY', ''), model: e('BET_IMPORT_MODEL', 'claude-opus-5-5'),
    effort: ['low', 'medium', 'high'].includes(e('BET_IMPORT_EFFORT', 'medium')) ? e('BET_IMPORT_EFFORT', 'medium') : 'medium',
    maxTokens: Math.max(2000, Math.min(64000, parseInt(e('BET_IMPORT_MAX_TOKENS', '16000'), 10) || 16000)),
    timeoutMs: Math.max(10000, Math.min(380000, parseInt(e('BET_IMPORT_TIMEOUT_MS', '140000'), 10) || 140000)),
    fallbacks: e('BET_IMPORT_FALLBACKS', '1') !== '0' };
}
const pad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); };

(async () => {
  const cfg = cfgFromEnv();
  if (!cfg.apiKey) die('Set ANTHROPIC_API_KEY to run the live check (it makes one real API call per six screenshots). Nothing was sent.');
  const pasteFile = arg('paste', null);
  if (!pasteFile && !files.length) die('Name the screenshots to read, or --paste FILE. See the header of this file.');
  const tz = arg('tz', 'America/Chicago'), today = arg('today', todayIn(tz)), book = arg('book', 'auto');
  let F;
  try { F = await import(path.join(ROOT, 'supabase', 'functions', 'parse_bet_import', 'index.ts')); }
  catch (e) { die('Could not import the function (needs Node 22+ with type stripping): ' + (e && e.message)); }

  const requests = [];
  if (pasteFile) requests.push({ kind: 'paste', text: fs.readFileSync(pasteFile, 'utf8'), book, book_label: arg('label', undefined), tz, today });
  else {
    const images = files.map((f) => {
      const type = TYPES[path.extname(f).toLowerCase()];
      if (!type) die(f + ': not a PNG, JPEG, WebP or GIF (convert HEIC screenshots first).');
      return { media_type: type, data: fs.readFileSync(f).toString('base64'), name: path.basename(f) };
    });
    for (let i = 0; i < images.length; i += C.LIMITS.maxImages) {
      requests.push({ kind: 'screenshot', images: images.slice(i, i + C.LIMITS.maxImages).map((x) => ({ media_type: x.media_type, data: x.data })), book, book_label: arg('label', undefined), tz, today });
    }
  }

  const all = [], warnings = [];
  for (const body of requests) {
    const req = F.readRequest(body, Date.now());
    if (!req.ok) die('Refused before sending (' + req.reason + '): ' + req.message);
    const t0 = Date.now();
    const m = await F.callModel(req, cfg);
    if (!m.ok) die('The model call failed (' + m.reason + '): ' + m.message);
    const res = C.normalizeResult(m.answer, { book: C.BOOK_BY_KEY[req.book] ? req.book : 'other', bookLabel: req.bookLabel, bookType: req.bookType, images: req.images.length, today: req.today });
    console.log('read ' + (req.kind === 'paste' ? 'pasted text' : req.images.length + ' screenshot(s)') + ' with ' + m.model + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      + (m.usage ? ' · ' + m.usage.input_tokens + ' tokens in, ' + m.usage.output_tokens + ' out' : '') + (m.salvaged ? ' · CUT OFF, salvaged' : '')
      + ' · ' + res.bets.length + ' bet(s), ' + res.flagged + ' flagged');
    res.bets.forEach((b) => all.push(b));
    res.warnings.forEach((w) => warnings.push(w));
  }

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ bets: all, warnings }, null, 2)); }
  console.log('\n' + pad('#', 3) + pad('platform', 24) + pad('event', 34) + pad('pick', 22) + pad('price', 14) + pad('stake', 9) + pad('paid', 9) + pad('result', 8) + pad('placed', 17) + 'check');
  all.forEach((b, i) => {
    const p = b.price || {}, errs = b.issues.filter((x) => x.level === 'error').map((x) => x.code), warns = b.issues.filter((x) => x.level === 'warning').map((x) => x.code);
    console.log(pad(i + 1, 3) + pad((b.book_label || '?') + (b.book_detected ? '*' : ''), 24) + pad(b.event, 34) + pad((b.side && b.platform_type === 'PREDICTION_MARKET' ? b.side + ' ' : '') + b.selection, 22)
      + pad(b.price_display + (p.american != null ? ' (' + C.americanText(p.american) + ')' : ''), 14) + pad(b.stake, 9) + pad(b.payout, 9) + pad(b.status, 8) + pad(b.placed_at, 17)
      + (errs.length ? 'ERROR ' + errs.join(',') : warns.length ? 'check ' + warns.join(',') : b.low.length ? 'unsure: ' + b.low.join(',') : 'ok') + (b.boost_pct ? ' · boost ' + b.boost_pct + '%' : ''));
  });
  warnings.forEach((w) => console.log('  note: ' + w));
  console.log('  (* = platform told from the screenshot)');

  const expectFile = arg('expect', null);
  if (expectFile) {
    const rows = JSON.parse(fs.readFileSync(expectFile, 'utf8')).expect.rows;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const miss = [];
    rows.forEach((x) => {
      const b = all.find((y) => norm(y.selection) === norm(x.selection));
      if (!b) { miss.push(x.selection + ': not read'); return; }
      if (b.price.american !== x.price_american) miss.push(x.selection + ': price ' + b.price.american + ', expected ' + x.price_american);
      if (b.status !== x.status) miss.push(x.selection + ': ' + b.status + ', expected ' + x.status);
      if (b.valid !== x.valid) miss.push(x.selection + ': ' + (b.valid ? 'valid' : 'invalid') + ', expected ' + (x.valid ? 'valid' : 'invalid'));
    });
    console.log(miss.length ? '\nEXPECT: ' + miss.length + ' difference(s)\n  ' + miss.join('\n  ') : '\nEXPECT: every expected row read as expected (' + rows.length + ')');
    process.exit(miss.length ? 1 : 0);
  }
})();

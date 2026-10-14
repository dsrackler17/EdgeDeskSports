'use strict';
/* ===========================================================================
   lib/edgedesk_slip_reader.js — A BET SLIP SCREENSHOT BECOMES A FILLED-IN
   FORM, NEVER A SAVED BET.

   The OCR step (Tesseract.js, in the reader's browser) is not run here: these
   inputs are the TEXT an OCR pass returns. They are SYNTHETIC, written in the
   layouts sportsbook slips use ("Wager: $100.00 To Pay: $190.91" on one line;
   "$100.00 / WAGER" stacked) — not transcriptions of real slips, so they prove
   the reading rules, not accuracy on real screenshots. That is why the
   Portfolio always shows the reader the form to check before anything is
   saved.

   Then, against a real PostgreSQL (supabase/portfolio.sql), the bet saved
   from a slip keeps the book's bet id, so the same bet recorded again — from
   another screenshot or from the book's CSV — is refused as a duplicate.

   Run: node tools/portfolio/slip_reader.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SR = require(path.join(PG.ROOT, 'lib', 'edgedesk_slip_reader.js'));
const U = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_ui.js'));
const I = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_import.js'));

const T = PG.kit('bet slip screenshots');
const chk = T.chk;
const L = PG.lit;

/* ── reading: each field only where the text says it ── */
const dk = SR.read([
  'DraftKings Sportsbook', 'SINGLE', 'Kansas City Chiefs -2.5 -110', 'SPREAD', 'Miami Dolphins @ Kansas City Chiefs',
  'Wager: $100.00 To Pay: $190.91', 'Won', 'Placed: 9/7/26 12:45:31 PM', 'Bet ID: DK63850012345'].join('\n'));
chk('a single on one-line labels: book, event, selection, line, market, odds, stake, result, payout, bet id, time — all read, nothing missing',
  JSON.stringify(dk.values) === JSON.stringify({ platform: 'draftkings', position_type: 'SPREAD', event_name: 'Miami Dolphins @ Kansas City Chiefs',
    selection: 'Kansas City Chiefs -2.5', line: '-2.5', odds: '-110', stake: '100.00', status: 'WON', reported_payout: '190.91',
    external_position_id: 'DK63850012345', placed_at: '2026-09-07T12:45' }) && dk.missing.length === 0 && dk.warnings.length === 0, dk);

const fd = SR.read(['FanDuel', 'Miami Dolphins +2.5 -110', 'SPREAD BETTING', 'Miami Dolphins at Kansas City Chiefs',
  '$100.00', 'WAGER', '$190.91', 'TOTAL PAYOUT', 'LOST', 'BET ID: O/0123456/0000123', 'PLACED: 9/7/2026 12:45PM ET'].join('\n'));
chk('a slip that stacks the amount ABOVE its label: the stake is $100, not the payout below it; "at" becomes "@"',
  fd.values.platform === 'fanduel' && fd.values.stake === '100.00' && fd.values.reported_payout === '190.91' && fd.values.status === 'LOST'
    && fd.values.event_name === 'Miami Dolphins @ Kansas City Chiefs' && fd.values.selection === 'Miami Dolphins +2.5' && fd.values.external_position_id === 'O/0123456/0000123', fd.values);
const below = SR.read(['BetMGM', 'Yankees', 'Moneyline', 'Yankees vs Red Sox', '-130', 'Stake', '$26.00', 'Potential Payout', '$46.00', 'Open', 'Placed Sep 12, 2026 7:05 PM'].join('\n'));
chk('…and one that stacks it BELOW: stake $26; an open bet keeps no payout; "vs" kept; a month-name date with its time',
  below.values.stake === '26.00' && below.values.status === 'OPEN' && below.values.reported_payout === undefined && below.values.position_type === 'MONEYLINE'
    && below.values.event_name === 'Yankees vs Red Sox' && below.values.odds === '-130' && below.values.placed_at === '2026-09-12T19:05', below.values);

const open = SR.read(['Caesars Sportsbook', 'Buffalo Bills', 'MONEYLINE', 'New York Jets @ Buffalo Bills', '+150', 'Wager $20.00', 'To Win $30.00', 'Cash Out $18.40', '10/2/2026 8:15 PM'].join('\n'));
chk('"To Win" is not a win and a Cash Out offer is not a cash-out: an unsettled bet stays OPEN; no result printed is said so',
  open.values.status === 'OPEN' && open.values.stake === '20.00' && open.values.odds === '+150' && open.values.platform === 'williamhill_us'
    && open.warnings.some((w) => /No result was printed/.test(w)), open);

const parlay = SR.read(['DraftKings', '3 Leg Parlay', 'Odds +596', 'Kansas City Chiefs -150', 'Over 47.5 -110', 'Buffalo Bills -2.5 -105',
  'Won', 'Lost', 'Won', 'Wager: $10.00', 'Placed: 10/5/2026 1:02 PM'].join('\n'));
chk('a parlay: the labelled combined odds (not a leg\'s), each leg as one line of the selection, and a lost leg makes the ticket LOST',
  parlay.values.position_type === 'PARLAY' && parlay.values.odds === '+596' && parlay.values.status === 'LOST'
    && parlay.values.selection === 'Kansas City Chiefs; Over 47.5; Buffalo Bills -2.5' && parlay.values.line === undefined
    && parlay.warnings.some((w) => /Each leg/.test(w)), parlay);

const prop = SR.read(['FanDuel', 'Patrick Mahomes Over 275.5 Passing Yards -115', 'Chiefs @ Raiders', 'Bonus Bet', 'Wager $25.00', 'Open'].join('\n'));
chk('a player prop: its market, its line, a bonus bet marked as such; the missing placed time is reported, not invented',
  prop.values.position_type === 'PLAYER_PROP' && prop.values.line === '275.5' && prop.values.stake_type === 'BONUS' && prop.values.odds === '-115'
    && prop.missing.join() === 'placed_at' && prop.values.placed_at === undefined, prop);

const two = SR.read(['DraftKings', 'Chiefs ML', 'Chiefs @ Bills', '-120', 'Wager: $50.00', 'Won', 'Lost', '9/7/2026 1:00 PM'].join('\n'));
chk('a single that names two results: neither is chosen, and the reader is told', two.values.status === 'OPEN' && two.warnings.some((w) => /more than one result/.test(w)), two.warnings);

const bare = SR.read(['Chiefs -2.5', '-110', '$100.00', '$190.91'].join('\n'));
chk('amounts without a label are not guessed: no stake, no payout; no book named → missing, not assumed',
  bare.values.stake === undefined && bare.values.reported_payout === undefined && bare.missing.indexOf('stake') >= 0 && bare.missing.indexOf('platform') >= 0, bare);
const hinted = SR.read(['Chiefs -2.5', '-110', 'Wager $10'].join('\n'), { platform: 'betrivers' });
chk('the book the reader started from is used when the slip does not name one, and that is said', hinted.values.platform === 'betrivers'
  && hinted.values.stake === '10.00' && hinted.warnings.some((w) => /does not name the sportsbook/.test(w)));

chk('dates: month-first only — 13/02/2026 is not read; a 2-digit year is 20xx; 12 AM is midnight',
  SR.dateIn('13/02/2026 10:00 AM') === null && SR.dateIn('9/7/26 9:05 PM').value === '2026-09-07T21:05' && SR.dateIn('Oct 1, 2026 12:30 AM').value === '2026-10-01T00:30'
    && SR.dateIn('Oct 1, 2026').timed === false);
chk('odds: three digits and up only — a spread of -2.5 or a line of 47.5 is not a price; EVEN is +100',
  SR.oddsIn('Chiefs -2.5 -110').map((o) => o.value).join() === '-110' && SR.oddsIn('Over 47.5').length === 0 && SR.oddsIn('Even').map((o) => o.value).join() === '+100');
const nothing = SR.read('   \n  ');
chk('an image with no text: nothing read, everything missing', nothing.found.length === 0 && nothing.missing.join() === 'everything');

chk('only PNG, JPEG or WebP up to 10 MB', SR.checkFile(null) && SR.checkFile({ type: 'application/pdf', size: 10 }) && SR.checkFile({ type: 'image/png', size: SR.MAX_BYTES + 1 })
  && SR.checkFile({ type: 'image/jpeg', size: 2048 }) === null);
chk('the OCR library is pinned to an exact version on an allowed CDN, with an integrity hash', /^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@\d+\.\d+\.\d+\//.test(SR.TESSERACT_SRC)
  && /^sha384-[A-Za-z0-9+/]{64}$/.test(SR.TESSERACT_SRI));

/* ── the Portfolio: the slip opens the ordinary bet form, checked by the reader ── */
const values = Object.assign({ status: 'OPEN', position_type: 'SPREAD', placed_at: '2026-09-07T12:00' }, dk.values, { from_slip: true, notes: 'Recorded from a bet slip screenshot.' });
const formH = U.render.wagerForm(values, {});
chk('the bet form, filled in from the slip, shows the bet id to check', /name="external_position_id" value="DK63850012345"/.test(formH) && /Bet ID \(from the slip\)/.test(formH)
  && /name="stake" value="100.00"/.test(formH) && /name="odds" value="-110"/.test(formH));
chk('a form not from a slip has no bet id field', !/external_position_id/.test(U.render.wagerForm({ status: 'OPEN' }, {})));
const w = U.wagerFromForm(values, []);
chk('the saved row is the ordinary manual row, with the book\'s bet id kept and the derived checks passing',
  w.row.external_position_id === 'DK63850012345' && w.row.platform === 'draftkings' && w.row.status === 'WON' && w.row.stake === '100' && w.row.odds_american === -110
    && w.issues.filter((x) => x.level === 'error').length === 0, w);
chk('a blank bet id is not stored', U.wagerFromForm(Object.assign({}, values, { external_position_id: '  ' }), []).row.external_position_id === undefined);
const pick = Object.assign(U.defaults(), { tab: 'accounts', positions: [], accounts: [], tz: 'UTC' }); pick.setup.pick = 'draftkings';
const card = U.render.accounts(pick);
chk('a sportsbook\'s card offers a screenshot (an image picker, nothing uploaded by itself)',
  /<label class="pfo-btn ghost pfo-file">Read a bet slip screenshot<input type="file" accept="image\/png,image\/jpeg,image\/webp" data-f="slip" data-platform="draftkings"><\/label>/.test(card));

/* ── the database: the bet id prevents the same bet twice, whichever way it comes ── */
const db = PG.start('slip');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-0000000000a1';
const one = (s) => String(s).split('\n')[0];
try {
  db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'portfolio.sql'));
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com');`);
  const row = Object.assign({}, w.row, { source: 'MANUAL' });
  const keys = Object.keys(row).filter((k) => row[k] != null);
  const insert = `insert into public.portfolio_positions (${keys.join(', ')}) values (${keys.map((k) => L(String(row[k]))).join(', ')}) returning id;`;
  const id = one(db.as(A, insert));
  const saved = JSON.parse(one(db.as(A, `select row_to_json(p) from (select status, profit_loss::text, external_position_id, source from public.portfolio_positions where id = ${L(id)}) p;`)));
  chk('saved as the reader: MANUAL, the bet id kept, P&L derived by the database (+$90.91)', saved.source === 'MANUAL' && saved.external_position_id === 'DK63850012345' && saved.profit_loss === '90.91', saved);
  const again = db.mustFail(() => db.as(A, insert));
  chk('the same slip saved twice is refused by the bet id (and the page says so in words)', /external_once|duplicate key/.test(String(again))
    && /same platform bet id/.test(U.friendly ? U.friendly({ pg: { code: '23505', message: 'portfolio_positions_external_once' } }).text : 'same platform bet id'), again);
  const st = I.stage(['Date Placed,Sportsbook,Sport,Event,Market,Selection,Odds,Stake,Result,Payout,Bet ID',
    '2026-09-07 12:45,DraftKings,NFL,Miami Dolphins @ Kansas City Chiefs,Spread,Kansas City Chiefs -2.5,-110,100,Won,190.91,DK63850012345'].join('\n'), { timezone: 'UTC' });
  const imp = one(db.as(A, `insert into public.portfolio_imports (platform_type, importer, file_name, timezone) values (${L(st.platformType)}, ${L(st.adapter)}, 'dk.csv', 'UTC') returning id;`));
  const r0 = st.rows[0];
  db.as(A, `insert into public.portfolio_import_rows (import_id, row_number, raw, normalized, issues) values (${L(imp)}, ${r0.row_number}, ${L(JSON.stringify(r0.raw))}::jsonb, ${L(JSON.stringify(r0.normalized))}::jsonb, ${L(JSON.stringify(r0.issues))}::jsonb);`);
  const c = JSON.parse(one(db.as(A, `select public.portfolio_import_classify(${L(imp)});`)));
  const cls = one(db.as(A, `select classification || ':' || coalesce(duplicate_of::text, '') from public.portfolio_import_rows where import_id = ${L(imp)};`));
  chk('the book\'s CSV, imported later with the same bet: classified DUPLICATE of the slip\'s position, not added', c.duplicate === 1 && c.new === 0 && cls === 'DUPLICATE:' + id, { c, cls });
} catch (e) {
  chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());

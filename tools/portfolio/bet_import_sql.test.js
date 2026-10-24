#!/usr/bin/env node
/* ===========================================================================
   supabase/bet_import.sql — Screenshot / Paste Import — AGAINST A REAL
   POSTGRESQL, AS REAL READERS, WITH THE ROWS THE BROWSER BUILDS.

   The rows staged here are made by lib/edgedesk_bet_import.js stagedRows()
   from bets lib/edgedesk_bet_import_core.js normalized out of a model-shaped
   answer — the exact path the page takes — and then go through the
   Portfolio's own portfolio_import_commit(). It proves:

     - the file applies over portfolio.sql (+ journal, connect, personal,
       decision) twice, every report row ok, and re-running portfolio.sql
       afterwards does not narrow the insert policies back;
     - a Novig wager and a Kalshi contract land in portfolio_positions, under
       the reader, labelled IMPORT_SCREENSHOT / IMPORT_PASTE, with the price
       as shown, the price as American odds (54¢ = -117), the matched game
       and its capture key; the browser's fingerprint is the database's;
     - dedupe: the same picks again (screenshot or paste) are DUPLICATE and
       skip; twins in one upload are DUPLICATE_IN_FILE; a row that breaks a
       server rule is INVALID — flagged and kept, never silently dropped;
     - RLS: reader B sees and touches none of A's picks, imports or usage;
     - the allowance: per hour, per day, per image, refused claims recorded,
       a settle only once and only one's own;
     - the games lookup and the close job (book_quote_ticks first, then
       EdgeDesk's own close), once, for the scheduler only;
     - DraftKings Predictions, from a reader's own screenshots
       (fixtures/dk_predictions_trades.json): no platform chosen, 54% /
       Bought / Paid / a boost → contracts the database accepts exactly,
       the cost exactly what was paid, the database's P&L the book's; and a
       pick saved Open is settled IN PLACE by a later screenshot (the
       browser's own update plan, PATCHed under RLS), never inserted twice.

   Run: node tools/portfolio/bet_import_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const C = require(path.join(PG.ROOT, 'lib', 'edgedesk_bet_import_core.js'));
const BI = require(path.join(PG.ROOT, 'lib', 'edgedesk_bet_import.js'));

const T = PG.kit('bet import SQL');
const chk = T.chk;
const L = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'bet_import.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const SUPA = (f) => path.join(PG.ROOT, 'supabase', f);

/* ── STATIC: the folder's conventions ── */
chk('no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('idempotent create statements', !/create table (?!if not exists)/i.test(SQL) && !/create (unique )?index (?!if not exists)/i.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped but a re-created policy, trigger or the widened constraint', !/\bdrop table\b|\bdrop column\b|\bdrop schema\b|\bdrop function\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('row level security is never switched off', !/disable row level security/i.test(SQL));
chk('no column that could hold an image (no bytea column anywhere)', !/^\s+\w+\s+bytea\b/im.test(SQL) && !/add column[^;]*bytea/i.test(SQL));
chk('the migration mirror is the same file, byte for byte',
  fs.readFileSync(path.join(PG.ROOT, 'supabase', 'migrations', '20261024160000_bet_import.sql'), 'utf8') === SQL);
chk('portfolio.sql carries the same insert policies (so re-running it never narrows them)', (() => {
  const P = fs.readFileSync(SUPA('portfolio.sql'), 'utf8');
  return P.indexOf("with check (user_id = auth.uid() and source in ('MANUAL', 'CSV', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'));") > 0
    && (P.match(/'IMPORT_SCREENSHOT', 'IMPORT_PASTE'\)\);/g) || []).length === 2;
})());
chk('a future sync adopts an imported pick instead of counting it twice (aggregator and connect adoption lists)',
  /x\.source in \('MANUAL', 'CSV', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'\)/.test(fs.readFileSync(SUPA('portfolio_aggregator.sql'), 'utf8'))
  && /x\.source in \('MANUAL', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE'\)/.test(fs.readFileSync(SUPA('portfolio_connect.sql'), 'utf8')));

const db = PG.start('betimport');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}

const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
const one = (s) => s.split('\n')[0];
const json = (s) => { try { return JSON.parse(s || 'null'); } catch (e) { throw new Error('not JSON: ' + String(s).slice(0, 300)); } };
const TZ = 'America/Chicago';
const DAY = 86400000;
const NOW = Date.now();
const local = (ms) => BI.toLocal(new Date(ms).toISOString(), TZ);
const TODAY = BI.toLocal(new Date(NOW).toISOString(), TZ).slice(0, 10);

/* the world EdgeDesk captured: two games, their markets, a book tick, a close */
const KICK = new Date(NOW - 2 * DAY).toISOString();           /* the Chiefs game, two days ago */
const KICK2 = new Date(NOW + 3 * DAY).toISOString();          /* a game still to come */
const EV1 = 'evt_kc_buf_1', EV2 = 'evt_nyj_nyg_2';
const SK_SPREAD = EV1 + '|spreads|Kansas City Chiefs|-2.5';
const SK_ML = EV1 + '|h2h|Buffalo Bills|';

function signalsWorld() {
  db.sql(`create table if not exists public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz,
      home_team text, away_team text, market text, selection text, point numeric, last_seen_at timestamptz default now(), closing_dec numeric, closed_at timestamptz);
    create table if not exists public.book_quote_ticks (id bigserial primary key, sig_key text not null, book_key text, book_title text, dec numeric, fair numeric,
      is_sharp boolean, event_id text, seen_at timestamptz not null default now(), payload jsonb);
    grant select on public.signals, public.book_quote_ticks to service_role;
    insert into public.signals (sig_key, event_id, sport_key, sport_title, commence_time, home_team, away_team, market, selection, point, closing_dec, closed_at) values
      (${L(SK_SPREAD)}, ${L(EV1)}, 'americanfootball_nfl', 'NFL', ${L(KICK)}, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -2.5, null, null),
      (${L(EV1 + '|spreads|Buffalo Bills|2.5')}, ${L(EV1)}, 'americanfootball_nfl', 'NFL', ${L(KICK)}, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Buffalo Bills', 2.5, null, null),
      (${L(EV1 + '|h2h|Kansas City Chiefs|')}, ${L(EV1)}, 'americanfootball_nfl', 'NFL', ${L(KICK)}, 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Kansas City Chiefs', null, 1.62, ${L(KICK)}),
      (${L(SK_ML)}, ${L(EV1)}, 'americanfootball_nfl', 'NFL', ${L(KICK)}, 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Buffalo Bills', null, 2.45, ${L(KICK)}),
      (${L(EV1 + '|totals|Over|47.5')}, ${L(EV1)}, 'americanfootball_nfl', 'NFL', ${L(KICK)}, 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Over', 47.5, null, null),
      (${L(EV2 + '|h2h|New York Giants|')}, ${L(EV2)}, 'americanfootball_nfl', 'NFL', ${L(KICK2)}, 'New York Giants', 'New York Jets', 'h2h', 'New York Giants', null, null, null);
    insert into public.book_quote_ticks (sig_key, book_key, dec, seen_at) values
      (${L(SK_SPREAD)}, 'novig', 1.87, ${L(new Date(Date.parse(KICK) - 3600000).toISOString())}),
      (${L(SK_SPREAD)}, 'novig', 1.95, ${L(new Date(Date.parse(KICK) - 9 * 3600000).toISOString())}),
      (${L(SK_SPREAD)}, 'novig', 1.80, ${L(new Date(Date.parse(KICK) + 3600000).toISOString())});`);
}

/* what the model answers (the schema's shape), and what the browser makes of it */
function modelBet(o) {
  const conf = {}; C.CONF_FIELDS.forEach((k) => { conf[k] = 0.95; });
  return Object.assign({ source_image: 0, book: null, sport: 'Football', league: 'NFL', event: 'Buffalo Bills @ Kansas City Chiefs', teams: ['Buffalo Bills', 'Kansas City Chiefs'],
    event_start: null, market_type: 'spread', market: 'Spread', selection: 'Kansas City Chiefs -2.5', side: null, line: -2.5, price_display: '-110', price_format: 'american',
    price_value: -110, stake: 25, contracts: null, potential_payout: 47.73, payout: 47.73, fees: null, placed_at: local(NOW - 3 * DAY), status: 'won', bet_id: null,
    is_bonus: false, legs: [], notes: null, confidence: conf }, o || {});
}
function reviewed(raws, book, origin) {
  const res = C.normalizeResult({ bets: raws, warnings: [] }, { book, images: 1, today: TODAY });
  return res.bets.map((b, i) => {
    const r = Object.assign({}, b, { id: 'b' + i, origin: origin || 'screenshot', edited: {}, confirmed: true });
    r.check = C.checkBet(r, { today: TODAY });
    return r;
  });
}
function stageAs(uid, importer, bets, matchOf) {
  bets.forEach((b) => { b.match = matchOf ? matchOf(b) : { state: 'unmatched', event: null, sig_key: null }; });
  const built = BI.toImportRows(bets, { tz: TZ, today: TODAY });
  const plat = built.rows[0].normalized.platform, type = built.rows[0].normalized.platform_type;
  const imp = one(db.as(uid, `insert into public.portfolio_imports (platform_type, importer, file_name, timezone, platform)
    values (${L(type)}, ${L(importer)}, 'Screenshots', ${L(TZ)}, ${L(plat)}) returning id;`));
  const values = built.rows.map((r) => `(${L(imp)}, ${r.row_number}, ${L(JSON.stringify(r.raw))}::jsonb, ${L(JSON.stringify(r.normalized))}::jsonb, ${L(JSON.stringify(r.issues))}::jsonb)`);
  db.as(uid, `insert into public.portfolio_import_rows (import_id, row_number, raw, normalized, issues) values ${values.join(',\n')};`);
  return { imp, built };
}
const commit = (uid, imp) => json(one(db.as(uid, `select public.portfolio_import_commit(${L(imp)});`)));
const rowsOf = (uid, imp) => json(one(db.as(uid, `select coalesce(jsonb_agg(json_build_object('n', row_number, 'class', classification, 'outcome', outcome, 'issues', issues, 'pos', position_id) order by row_number), '[]'::jsonb) from public.portfolio_import_rows where import_id = ${L(imp)};`)));
const position = (uid, id) => json(one(db.as(uid, `select row_to_json(p) from (select id, source, platform, platform_type, status, odds_american, stake::text, price_display, price_american,
    market_sig_key, event_id, event_start_at, fingerprint, profit_loss::text, contracts::text, average_entry_price::text, platform_account_id from public.portfolio_positions where id = ${L(id)}) p;`)));

(async () => {
  try {
    const out0 = (() => {
      db.applyFileAtomic(SUPA('portfolio.sql')); db.applyFileAtomic(SUPA('portfolio_journal.sql')); db.applyFileAtomic(SUPA('portfolio_connect.sql'));
      db.applyFileAtomic(SUPA('personal_research.sql')); db.applyFileAtomic(SUPA('portfolio_decision.sql'));
      signalsWorld();
      return db.applyFileAtomic(FILE);
    })();
    chk('the file applies over the Portfolio schema', true);
    chk('every report row reads ok (10)', !/CHECK THIS/.test(out0) && (out0.match(/\|ok( —[^\n]*)?$/gm) || []).length === 10, out0.slice(-1600));
    const out1 = db.applyFileAtomic(FILE);
    chk('and applies a second time, still all ok', !/CHECK THIS/.test(out1));
    db.applyFileAtomic(SUPA('portfolio.sql'));
    chk('re-running portfolio.sql afterwards keeps the widened, owner-only insert policies',
      db.sql(`select count(*) from pg_policies where policyname in ('portfolio_positions_insert_own', 'portfolio_transactions_insert_own') and with_check like '%IMPORT_PASTE%' and with_check like '%auth.uid()%';`) === '2');
    chk('…and the source labels survive it (the triggers are this file\'s)', db.sql(`select count(*) from pg_trigger where tgname in ('portfolio_positions_source_trg', 'portfolio_transactions_source_trg', 'portfolio_positions_price_trg');`) === '3');
    db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com');`);

    /* ── 1. the core's rules, against the database's own arithmetic ── */
    const pairs = [['0.54', -117], ['0.40', 150], ['0.50', 100], ['0.32', 213], ['0.99', -9900], ['0.01', 9900], ['0.555', -125], ['0.4525', 121]];
    const sqlConv = db.sql(`select string_agg(public.portfolio_prob_to_american(x::numeric)::text, ',' order by n) from unnest(array[${pairs.map((p) => L(p[0])).join(',')}]) with ordinality as t(x, n);`);
    chk('cents → American odds: the browser and the database agree, half away from zero', sqlConv === pairs.map((p) => String(C.probToAmerican(p[0]))).join(',')
      && pairs.every((p) => C.probToAmerican(p[0]) === p[1]), { sqlConv });
    chk('decimal odds → American: the database matches the core', db.sql(`select public.portfolio_decimal_to_american(1.91)::text || ',' || public.portfolio_decimal_to_american(2.5)::text || ',' || public.portfolio_decimal_to_american(1.5)::text;`)
      === [C.parsePrice('1.91').american, C.parsePrice('2.5').american, C.parsePrice('1.5').american].join(','));

    /* ── 2. Novig: three wagers, two matched to the game ── */
    const novig = reviewed([
      modelBet(),                                                                                          /* KC -2.5 -110, won */
      modelBet({ market_type: 'moneyline', market: 'Moneyline', selection: 'Buffalo Bills', line: null, price_display: '+145', price_value: 145, stake: 20, potential_payout: 49, payout: 0, status: 'lost' }),
      modelBet({ event: 'New York Jets @ New York Giants', teams: ['New York Jets', 'New York Giants'], market_type: 'moneyline', market: 'Moneyline', selection: 'New York Giants', line: null,
        price_display: '-125', price_value: -125, stake: 50, potential_payout: 90, payout: null, status: 'open', placed_at: local(NOW - 1 * DAY) })
    ], 'novig', 'screenshot');
    chk('the model\'s answer becomes three valid rows for Novig, a sportsbook', novig.length === 3 && novig.every((b) => b.check.valid && b.book_key === 'novig' && b.platform_type === 'SPORTSBOOK'), novig.map((b) => b.check.issues));
    const events = json(one(db.as(A, `select jsonb_agg(e) from public.bet_import_events(${L(new Date(NOW - 10 * DAY).toISOString())}, ${L(new Date(NOW + 10 * DAY).toISOString())}, array['americanfootball_nfl']) e;`)));
    chk('the games lookup returns each EdgeDesk game once, with its teams and start', Array.isArray(events) && events.length === 2 && events.every((e) => e.home_team && e.away_team && e.commence_time), events);
    const markets = json(one(db.as(A, `select jsonb_agg(m) from public.bet_import_markets(array[${L(EV1)}, ${L(EV2)}]) m;`)));
    const matched = novig.map((b) => BI.matchBet(b, events, TZ));
    chk('matching: both teams named and the start fits → matched on its own, to the right game', matched.every((m) => m.state === 'auto') && matched[0].event.event_id === EV1 && matched[2].event.event_id === EV2, matched.map((m) => m.state));
    const keys = novig.map((b, i) => BI.sigKeyFor(b, matched[i].event, markets));
    chk('…and the exact capture key: KC -2.5 → its spread row, Bills ML → its h2h row', keys[0] === SK_SPREAD && keys[1] === SK_ML && keys[2] === EV2 + '|h2h|New York Giants|', keys);
    const s1 = stageAs(A, 'screenshot_v1', novig, (b) => { const i = novig.indexOf(b); return { state: 'auto', event: matched[i].event, sig_key: keys[i] }; });
    const c1 = commit(A, s1.imp);
    chk('the commit saves all three', c1.status === 'COMMITTED' && c1.imported === 3 && c1.failed === 0, c1);
    const fin = json(one(db.as(A, `select public.portfolio_bet_import_finalize(${L(s1.imp)});`)));
    chk('finalize puts the price as shown and the capture key on all three', fin.positions_updated === 3, fin);
    chk('finalize again changes nothing', json(one(db.as(A, `select public.portfolio_bet_import_finalize(${L(s1.imp)});`))).positions_updated === 0);
    const r1 = rowsOf(A, s1.imp), p1 = position(A, r1[0].pos), p2 = position(A, r1[1].pos), p3 = position(A, r1[2].pos);
    chk('saved under the reader, labelled IMPORT_SCREENSHOT, on a Novig import account', [p1, p2, p3].every((p) => p.source === 'IMPORT_SCREENSHOT' && p.platform === 'novig' && p.platform_account_id)
      && db.sql(`select connection_type from public.platform_accounts where id = ${L(p1.platform_account_id)};`) === 'CSV', [p1.source, p1.platform]);
    chk('the price as shown, and as American odds', p1.price_display === '-110' && p1.price_american === -110 && p2.price_display === '+145' && p2.price_american === 145);
    chk('the matched game, its start and capture key on the pick', p1.event_id === EV1 && Date.parse(p1.event_start_at) === Date.parse(KICK) && p1.market_sig_key === SK_SPREAD && p3.event_id === EV2);
    chk('the money is the database\'s: won $25 at -110 = +22.73; lost $20 = -20; open = no P&L', p1.status === 'WON' && p1.profit_loss === '22.73' && p2.status === 'LOST' && p2.profit_loss === '-20' && p3.status === 'OPEN' && p3.profit_loss === null, [p1.profit_loss, p2.profit_loss]);
    const fp = await BI.sha256Hex(BI.materialOf(s1.built.rows[0].normalized));
    chk('the browser\'s fingerprint is the database\'s (the duplicate check before Confirm is the real one)', fp === p1.fingerprint, { fp, db: p1.fingerprint });

    /* ── 3. dedupe ── */
    const again = reviewed([modelBet(), modelBet({ market_type: 'moneyline', market: 'Moneyline', selection: 'Buffalo Bills', line: null, price_display: '+145', price_value: 145, stake: 20, potential_payout: 49, payout: 0, status: 'lost' })], 'novig', 'paste');
    const s2 = stageAs(A, 'paste_v1', again);
    const c2 = commit(A, s2.imp), r2 = rowsOf(A, s2.imp);
    chk('the same picks again — pasted this time — are DUPLICATE and skipped; nothing new is saved', c2.imported === 0 && c2.duplicate === 2 && r2.every((r) => r.class === 'DUPLICATE' && r.outcome === 'SKIPPED'), c2);
    chk('…same user, same event, market, selection, price, stake and placed minute', db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`) === '3');
    const changed = reviewed([modelBet({ stake: 30, payout: 57.27, potential_payout: 57.27 })], 'novig', 'paste');
    const s3 = stageAs(A, 'paste_v1', changed);
    const c3 = commit(A, s3.imp), p4 = position(A, rowsOf(A, s3.imp)[0].pos);
    chk('a different stake is a different pick: saved, labelled IMPORT_PASTE', c3.imported === 1 && p4.source === 'IMPORT_PASTE', c3);
    const twins = reviewed([modelBet({ selection: 'Over 47.5', market_type: 'total', market: 'Total', line: 47.5, status: 'open', payout: null }),
      modelBet({ selection: 'Over 47.5', market_type: 'total', market: 'Total', line: 47.5, status: 'open', payout: null })], 'novig');
    const s4 = stageAs(A, 'screenshot_v1', twins), c4 = commit(A, s4.imp), r4 = rowsOf(A, s4.imp);
    chk('twins in one upload (overlapping screenshots): the first is saved, the second is DUPLICATE_IN_FILE', c4.imported === 1 && r4[1].class === 'DUPLICATE_IN_FILE' && r4[1].outcome === 'SKIPPED', r4.map((r) => r.class));

    /* ── 4. a row the server refuses is flagged and kept ── */
    const bad = reviewed([modelBet({ selection: 'Bad stake', stake: 25 })], 'novig');
    bad[0].stake = '12.345';
    const sb = stageAs(A, 'screenshot_v1', bad);
    db.as(A, `update public.portfolio_import_rows set normalized = jsonb_set(normalized, '{stake}', '"abc"') where import_id = ${L(sb.imp)};`);
    const cb = commit(A, sb.imp), rb = rowsOf(A, sb.imp);
    chk('a row that fails the server\'s checks is INVALID, with its reason, and is not saved', cb.invalid === 1 && cb.imported === 0 && rb[0].class === 'INVALID'
      && rb[0].issues.some((i) => i.code === 'BAD_STAKE'), rb);

    /* ── 5. Kalshi: contracts, cents and the BUY / SELL fills ── */
    const kalshi = reviewed([
      modelBet({ book: 'Kalshi', event: 'Chiefs vs Bills: who wins?', market_type: 'moneyline', market: 'Kansas City to win', selection: 'Kansas City', side: 'YES', line: null,
        price_display: '54¢', price_format: 'cents', price_value: 54, stake: 54, contracts: 100, potential_payout: 100, payout: 100, fees: 1.2, status: 'won' }),
      modelBet({ book: 'Kalshi', event: 'Jets vs Giants: who wins?', market_type: 'moneyline', market: 'New York Jets to win', selection: 'New York Jets', side: 'YES', line: null,
        price_display: '40¢', price_format: 'cents', price_value: 40, stake: 20, contracts: null, potential_payout: null, payout: 31, status: 'cashed_out', placed_at: local(NOW - 1 * DAY) })
    ], 'kalshi');
    chk('Kalshi rows are prediction-market rows; contracts are worked out from cost ÷ price and said so', kalshi.every((b) => b.check.valid && b.platform_type === 'PREDICTION_MARKET')
      && kalshi[1].check.issues.some((i) => i.code === 'CONTRACTS_DERIVED'), kalshi.map((b) => b.check.issues));
    const sk = stageAs(A, 'screenshot_v1', kalshi);
    chk('a cashed-out contract is staged as a BUY and a SELL', sk.built.rows.length === 3 && sk.built.rows[2].normalized.action === 'SELL' && sk.built.rows[2].normalized.price === '0.62', sk.built.rows.map((r) => r.normalized.action + ' ' + r.normalized.price));
    const ck = commit(A, sk.imp);
    db.as(A, `select public.portfolio_bet_import_finalize(${L(sk.imp)});`);
    const rk = rowsOf(A, sk.imp), k1 = position(A, rk[0].pos), k2 = position(A, rk[1].pos);
    chk('both contracts are saved', ck.imported === 3 && ck.failed === 0, ck);
    chk('a 54¢ YES that won: 100 contracts, settled, +$44.80 after the $1.20 fee; shown as 54¢, -117', k1.platform_type === 'PREDICTION_MARKET' && k1.status === 'SETTLED' && k1.contracts === '100'
      && k1.profit_loss === '44.8' && k1.price_display === '54¢' && k1.price_american === -117 && k1.source === 'IMPORT_SCREENSHOT', k1);
    chk('a 40¢ YES sold for $31: 50 contracts bought and sold, +$11, priced +150', k2.status === 'SETTLED' && k2.profit_loss === '11' && k2.price_american === 150 && k2.contracts === '0', k2);
    chk('the fills carry the import\'s label too', db.sql(`select string_agg(distinct source, ',') from public.portfolio_transactions where user_id = ${L(A)};`) === 'IMPORT_SCREENSHOT');
    const ffp = await BI.sha256Hex(BI.materialOf(sk.built.rows[0].normalized));
    chk('a fill\'s fingerprint, too, is the browser\'s', db.sql(`select count(*) from public.portfolio_transactions where fingerprint = ${L(ffp)};`) === '1');
    const sk2 = stageAs(A, 'paste_v1', reviewed([kalshi[0]].map(() => modelBet({ book: 'Kalshi', event: 'Chiefs vs Bills: who wins?', market_type: 'moneyline', market: 'Kansas City to win',
      selection: 'Kansas City', side: 'YES', line: null, price_display: '54¢', price_format: 'cents', price_value: 54, stake: 54, contracts: 100, potential_payout: 100, payout: 100, fees: 1.2, status: 'won' })), 'kalshi'));
    chk('the same contract again is a duplicate fill, and adds nothing', commit(A, sk2.imp).imported === 0 && db.sql(`select count(*) from public.portfolio_transactions where user_id = ${L(A)};`) === '3');

    /* a buy that joins a position the reader recorded by hand: the fill is the import's, the position stays theirs */
    db.as(A, `select public.portfolio_record_prediction(${L(JSON.stringify({ platform: 'kalshi', platform_label: 'Kalshi', event_name: 'Bills vs Dolphins: who wins?', market_name: 'Buffalo to win',
      side: 'YES', fills: [{ action: 'BUY', quantity: 10, price: 0.6, executed_at: new Date(NOW - 5 * DAY).toISOString() }] }))}::jsonb);`);
    const joined = stageAs(A, 'paste_v1', reviewed([modelBet({ book: 'Kalshi', event: 'Bills vs Dolphins: who wins?', teams: [], market_type: 'moneyline', market: 'Buffalo to win', selection: 'Buffalo',
      side: 'YES', line: null, price_display: '62¢', price_format: 'cents', price_value: 62, stake: 12.4, contracts: 20, potential_payout: 20, payout: null, status: 'open' })], 'kalshi'));
    const cj = commit(A, joined.imp);
    db.as(A, `select public.portfolio_bet_import_finalize(${L(joined.imp)});`);
    const manual = json(one(db.as(A, `select row_to_json(p) from (select source, price_display, contracts::text, (select count(*) from public.portfolio_transactions t where t.position_id = p.id and t.source = 'IMPORT_PASTE') as imported_fills
      from public.portfolio_positions p where p.market_name = 'Buffalo to win') p;`)));
    chk('a buy that joins a hand-recorded open contract adds its fill (labelled IMPORT_PASTE) and leaves the position the reader\'s, untouched by finalize',
      cj.imported === 1 && manual.source === 'MANUAL' && manual.price_display === null && manual.contracts === '30' && manual.imported_fills === 1, manual);

    /* ── 5b. DraftKings Predictions, from a reader's screenshots ── */
    const DKF = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dk_predictions_trades.json'), 'utf8'));
    const dkAll = C.normalizeResult(DKF.answer, { book: DKF.book, images: DKF.images, today: TODAY }).bets.map((b, i) => {
      const r = Object.assign({}, b, { id: 'd' + i, origin: 'screenshot', edited: {}, confirmed: true });
      r.check = C.checkBet(r, { today: TODAY });
      return r;
    });
    const dkOk = dkAll.filter((b) => b.check.valid), dkExp = DKF.expect.rows.filter((x) => x.valid);
    chk('DK Predictions: no platform chosen, three complete cards valid, the two cut off kept as invalid (never saved)', dkOk.length === 3 && dkAll.length === 5
      && dkAll.every((b) => b.book_key === 'draftkings_predictions' && b.platform_type === 'PREDICTION_MARKET'), dkAll.map((b) => b.check.issues));
    const sd = stageAs(A, 'screenshot_v1', dkOk, () => ({ state: 'none', auto: true, event: null, sig_key: null }));
    const cd = commit(A, sd.imp);
    db.as(A, `select public.portfolio_bet_import_finalize(${L(sd.imp)});`);
    const rd = rowsOf(A, sd.imp);
    chk('the commit takes every contract count as staged (none refused for its precision)', cd.status === 'COMMITTED' && cd.imported === 3 && cd.failed === 0 && cd.invalid === 0, [cd, rd.map((r) => r.issues)]);
    const dpos = rd.map((r) => json(one(db.as(A, `select row_to_json(p) from (select source, platform, status, resolution, contracts_bought::text, cost_basis::text, fees::text, reported_payout::text,
        profit_loss::text, price_display, price_american, market_name from public.portfolio_positions where id = ${L(r.pos)}) p;`))));
    const dOff = dpos.filter((p, i) => p.profit_loss !== dkExp[i].profit_loss || p.price_american !== dkExp[i].price_american || p.contracts_bought !== dkExp[i].quantity
      || p.market_name !== dkExp[i].market_name || p.source !== 'IMPORT_SCREENSHOT' || p.status !== 'SETTLED');
    chk('the database\'s P&L is the book\'s: Under 202.5 (54%, Bought $24.64, Paid $48.84 boosted) +24.20; Under 235.5 −24.64; Over 18.5 −24.78; shown as 54% and −117',
      dOff.length === 0 && dpos[0].price_display === '54%' && dpos[0].reported_payout === '48.84', dpos);
    chk('…the cost stored is exactly what was paid (contracts × price + the fraction of a cent as fee)', dpos.every((p, i) => C.micro(p.cost_basis) + C.micro(p.fees) === C.micro(['24.64', '24.64', '24.78'][i])), dpos.map((p) => [p.cost_basis, p.fees]));

    /* a pick saved while Open, then a later screenshot of its result */
    const openDk = Object.assign({}, dkOk[0], { id: 'o1', selection: 'Over 210.5', line: '210.5', status: 'open', payout: '', boost_pct: '', placed_at: '2026-10-23T20:05' });
    openDk.check = C.checkBet(openDk, { today: TODAY });
    const so = stageAs(A, 'screenshot_v1', [openDk], () => ({ state: 'none', auto: true, event: null, sig_key: null }));
    chk('the Open pick is saved, open', commit(A, so.imp).imported === 1 && position(A, rowsOf(A, so.imp)[0].pos).status === 'OPEN');
    const wonDk = Object.assign({}, openDk, { id: 'o2', status: 'won', payout: '45.63' });
    wonDk.check = C.checkBet(wonDk, { today: TODAY });
    const ctxSql = { tz: TZ, today: TODAY };
    /* what the browser does before Confirm: the fingerprint read, then the saved position */
    async function existingFor(uid, b) {
      const n = BI.stagedRows(b, ctxSql, 1)[0].normalized, fpx = await BI.sha256Hex(BI.materialOf(n));
      const pid = n.kind === 'wager' ? one(db.as(uid, `select id from public.portfolio_positions where fingerprint = ${L(fpx)};`))
        : one(db.as(uid, `select position_id from public.portfolio_transactions where fingerprint = ${L(fpx)};`));
      return pid ? json(one(db.as(uid, `select row_to_json(p) from (select id, status, resolution, reported_payout::text, source from public.portfolio_positions where id = ${L(pid)}) p;`))) : null;
    }
    const patchAs = (uid, plan) => db.as(uid, `update public.portfolio_positions set ${Object.keys(plan.patch).map((k) => k + ' = ' + (plan.patch[k] == null ? 'null' : L(plan.patch[k]))).join(', ')} where id = ${L(plan.id)} returning id;`);
    const exOpen = await existingFor(A, wonDk);
    const plan = BI.updatePlan(wonDk, exOpen, ctxSql);
    chk('the later screenshot finds the saved pick (the fingerprint leaves the result out) and plans one update: Open → Won, paid 45.63',
      exOpen && exOpen.status === 'OPEN' && plan && plan.to === 'WON' && plan.patch.resolution === 'YES' && plan.patch.reported_payout === '45.63', [exOpen, plan]);
    chk('reader B cannot apply it to A\'s pick (RLS: no row)', db.as(B, `update public.portfolio_positions set resolution = 'YES' where id = ${L(plan.id)} returning id;`) === '');
    patchAs(A, plan);
    const settled = json(one(db.as(A, `select row_to_json(p) from (select status, resolution, profit_loss::text, source, contracts_bought::text from public.portfolio_positions where id = ${L(plan.id)}) p;`)));
    chk('applied as the reader: settled in place, +20.99 (45.63 paid − 24.64 cost), still labelled IMPORT_SCREENSHOT, the same 45.6296 contracts',
      settled.status === 'SETTLED' && settled.resolution === 'YES' && settled.profit_loss === '20.99' && settled.source === 'IMPORT_SCREENSHOT' && settled.contracts_bought === '45.6296', settled);
    const sAgain = stageAs(A, 'screenshot_v1', [wonDk], () => ({ state: 'none', auto: true, event: null, sig_key: null }));
    chk('…and the Won screenshot through the commit is a duplicate: no second position, no second fill', commit(A, sAgain.imp).imported === 0
      && db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)} and market_name = 'Total Points · Over 210.5';`) === '1'
      && db.sql(`select count(*) from public.portfolio_transactions t join public.portfolio_positions p on p.id = t.position_id where p.market_name = 'Total Points · Over 210.5';`) === '1');
    chk('…once settled, the same screenshot plans nothing more; one that says Lost is a conflict, left alone', BI.updatePlan(wonDk, await existingFor(A, wonDk), ctxSql) === null
      && BI.updatePlan(Object.assign({}, wonDk, { status: 'lost', payout: '' }), await existingFor(A, wonDk), ctxSql).conflict === true);
    /* a sportsbook bet saved Open (the Giants, above), now Won */
    const nygWon = reviewed([modelBet({ event: 'New York Jets @ New York Giants', teams: ['New York Jets', 'New York Giants'], market_type: 'moneyline', market: 'Moneyline', selection: 'New York Giants', line: null,
      price_display: '-125', price_value: -125, stake: 50, potential_payout: 90, payout: 90, status: 'won', placed_at: local(NOW - 1 * DAY) })], 'novig')[0];
    nygWon.match = { state: 'auto', event: matched[2].event, sig_key: keys[2] };
    const wplan = BI.updatePlan(nygWon, await existingFor(A, nygWon), ctxSql);
    patchAs(A, wplan);
    const p3b = position(A, p3.id);
    chk('a sportsbook pick saved Open, then Won on a later screenshot: updated in place, +40 at -125, its game and price kept', wplan.id === p3.id && p3b.status === 'WON' && p3b.profit_loss === '40'
      && p3b.event_id === EV2 && p3b.price_display === '-125', [wplan, p3b]);

    /* ── 6. row level security ── */
    chk('reader B sees none of A\'s picks', db.as(B, `select count(*) from public.portfolio_positions;`) === '0');
    chk('reader B cannot finalize A\'s import', db.mustFail(() => db.as(B, `select public.portfolio_bet_import_finalize(${L(s1.imp)});`)) !== null);
    chk('reader B cannot commit A\'s import', db.mustFail(() => db.as(B, `select public.portfolio_import_commit(${L(s1.imp)});`)) !== null);
    chk('a reader cannot label their own row as synced', db.mustFail(() => db.as(A, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake, source)
      values ('novig', 'Novig', 'SPORTSBOOK', 'MONEYLINE', 'X @ Y', 'Moneyline', 'X', -110, 10, 'SYNC');`)) !== null);
    chk('a pick B inserts claiming to be A\'s is B\'s (the owner is the caller)', (() => {
      db.as(B, `insert into public.portfolio_positions (user_id, platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake, source)
        values (${L(A)}, 'novig', 'Novig', 'SPORTSBOOK', 'MONEYLINE', 'X @ Y', 'Moneyline', 'X', -110, 10, 'IMPORT_PASTE');`);
      return db.sql(`select user_id from public.portfolio_positions where event_name = 'X @ Y';`) === B;
    })());
    chk('price_american is derived, whatever a client sends', (() => {
      db.as(B, `update public.portfolio_positions set price_american = 500 where event_name = 'X @ Y';`);
      return db.sql(`select price_american from public.portfolio_positions where event_name = 'X @ Y';`) === '-110';
    })());
    chk('anon reaches none of it', db.mustFail(() => db.anon(`select * from public.bet_import_events(now(), now() + interval '1 day');`)) !== null
      && db.mustFail(() => db.anon(`select public.bet_import_claim('paste', 0, 0, 10);`)) !== null
      && db.mustFail(() => db.anon(`select count(*) from public.bet_import_usage;`)) !== null);
    chk('the games lookup refuses a window over 45 days', db.mustFail(() => db.as(A, `select * from public.bet_import_events(now() - interval '60 days', now());`)) !== null);

    /* ── 7. the allowance ── */
    db.service(`update public.bet_import_policy set per_hour = 3, per_day = 5, images_per_day = 10 where id = 1;`);
    const claim = (uid, kind, images) => json(one(db.as(uid, `select public.bet_import_claim(${L(kind)}, ${images}, 1000, 0);`)));
    const got = [claim(A, 'screenshot', 2), claim(A, 'screenshot', 2), claim(A, 'paste', 0), claim(A, 'paste', 0)];
    chk('three requests an hour, then HOURLY_LIMIT with a retry time', got[0].ok && got[1].ok && got[2].ok && !got[3].ok && got[3].reason === 'HOURLY_LIMIT' && got[3].retry_after_s >= 60, got.map((g) => g.reason));
    chk('another reader has their own allowance', claim(B, 'screenshot', 11).reason === 'IMAGE_LIMIT' && claim(B, 'screenshot', 3).ok === true);
    chk('refused claims are recorded and never count', db.sql(`select count(*) filter (where status = 'REFUSED') || '/' || count(*) filter (where status = 'CLAIMED') from public.bet_import_usage where user_id = ${L(A)};`) === '1/3');
    chk('a claim is settled once, by its own reader', db.as(B, `select public.bet_import_settle(${got[0].id}, 'parsed', 'm', 10, 10, 3, 1, 900);`) === 'f'
      && db.as(A, `select public.bet_import_settle(${got[0].id}, 'parsed', 'claude-opus-5-5', 1200, 800, 3, 1, 9000);`) === 't'
      && db.as(A, `select public.bet_import_settle(${got[0].id}, 'parsed', 'claude-opus-5-5', 1, 1, 1, 1, 1);`) === 'f');
    chk('a reader reads only their own usage, and can write none of it', db.as(B, `select count(*) from public.bet_import_usage where user_id = ${L(A)};`) === '0'
      && db.mustFail(() => db.as(A, `insert into public.bet_import_usage (user_id, kind, status) values (${L(A)}, 'paste', 'CLAIMED');`)) !== null
      && db.mustFail(() => db.as(A, `select * from public.bet_import_policy;`)) !== null);
    db.service(`update public.bet_import_policy set enabled = false where id = 1;`);
    chk('switched off, every request is refused', claim(B, 'paste', 0).reason === 'DISABLED');

    /* ── 8. the close for CLV ── */
    chk('the close job is the scheduler\'s, not a reader\'s', db.mustFail(() => db.as(A, `select public.portfolio_svc_attach_import_close(50);`)) !== null);
    const close = json(one(db.service(`select public.portfolio_svc_attach_import_close(50);`)));
    const j1 = json(one(db.sql(`select row_to_json(j) from (select closing_odds_decimal::text, closing_source, closing_book, closing_line::text from public.portfolio_journal_entries where position_id = ${L(p1.id)}) j;`)));
    const j2 = json(one(db.sql(`select row_to_json(j) from (select closing_odds_decimal::text, closing_source, closing_book from public.portfolio_journal_entries where position_id = ${L(p2.id)}) j;`)));
    chk('KC -2.5 at Novig closes at Novig\'s last tick before kickoff (1.87), not a later or older one', j1.closing_odds_decimal === '1.87' && j1.closing_source === 'EDGEDESK_CAPTURE' && j1.closing_book === 'novig' && j1.closing_line === '-2.5', j1);
    chk('Bills ML (no Novig tick) closes at EdgeDesk\'s own close for that market (2.45)', j2.closing_odds_decimal === '2.45' && j2.closing_book === 'edgedesk_close', j2);
    chk('a game still to come gets no close', db.sql(`select closing_odds_decimal is null from public.portfolio_journal_entries where position_id = ${L(p3.id)};`) === 't');
    chk('the closes are on the market path at the time they were observed (beside the journal\'s own RECORDED point)',
      db.sql(`select count(*) from public.portfolio_market_path where kind = 'CLOSE' and time_basis = 'OBSERVED' and position_id in (${L(p1.id)}, ${L(p2.id)});`) === '2'
      && db.sql(`select observed_at = ${L(new Date(Date.parse(KICK) - 3600000).toISOString())}::timestamptz from public.portfolio_market_path where kind = 'CLOSE' and time_basis = 'OBSERVED' and position_id = ${L(p1.id)};`) === 't');
    chk('run again, it adds nothing', close.closes === 2 && json(one(db.service(`select public.portfolio_svc_attach_import_close(50);`))).closes === 0, close);
    const facts = db.as(A, `select count(*) from public.portfolio_positions p join public.portfolio_journal_entries j on j.position_id = p.id where p.user_id = ${L(A)} and j.closing_odds_decimal is not null;`);
    chk('the reader reads their own closes (CLV is computed from them)', facts === '2');

    /* ── 9. still idempotent, with data in it ── */
    const out2 = db.applyFileAtomic(FILE);
    chk('re-applied with data in it: all ok, nothing lost', !/CHECK THIS/.test(out2) && db.sql(`select count(*) from public.portfolio_positions where source like 'IMPORT_%';`) === '12');
  } catch (e) {
    chk('the suite ran to the end', false, String(e && (e.sqlMessage || e.message)).replace(/psql:[^\n]*NOTICE:[^\n]*\n/g, '').slice(0, 1500));
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();

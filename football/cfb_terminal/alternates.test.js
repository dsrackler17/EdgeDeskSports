#!/usr/bin/env node
/* ============================================================================
   Alternate-spread capture (football/cfb_terminal/alternates.js): the parse,
   change-only persistence, the browser feed and the budget controls, run
   against a stubbed provider in a temporary directory. Nothing touches the
   network and nothing is written into the repository.

     node football/cfb_terminal/alternates.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ALT = require(path.join(__dirname, 'alternates.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

const NOW = Date.parse('2026-10-01T14:30:00Z');
const H = 3600e3;
function outcome(name, price, point) { return { name, price, point }; }
function event(id, home, away, kickoffMs, books) {
  return { id, commence_time: new Date(kickoffMs).toISOString(), home_team: home, away_team: away,
    bookmakers: books.map(([key, outs]) => ({ key, last_update: '2026-10-01T14:20:00Z', markets: [{ key: 'alternate_spreads', last_update: '2026-10-01T14:21:00Z', outcomes: outs }] })) };
}
const KC = 'Kansas City Chiefs', BUF = 'Buffalo Bills';
const E1 = event('nfl_ev_1', KC, BUF, NOW + 30 * H, [
  ['draftkings', [outcome(KC, -110, -3.5), outcome(BUF, -110, 3.5), outcome(KC, 120, -4.5), outcome(BUF, -145, 4.5),
    outcome(KC, -135, -2.5), outcome(BUF, 110, 2.5), outcome(BUF, -400, 13.5)]],
  ['fanduel', [outcome(KC, -108, -3.5), outcome(BUF, -112, 3.5), outcome(KC, 125, -4.5), outcome(BUF, -150, 4.5)]]]);

/* ======================================================================= 1 */
section('1. the parse: both sides paired by book, one-sided kept, the rest refused');
{
  const p = ALT.parseEventOdds(E1, null, '2026-10-01T14:30:00Z', { league: 'nfl', season: 2026 });
  const dk = p.quotes.filter((q) => q.book === 'draftkings');
  const at = (bk, hl) => p.quotes.find((q) => q.book === bk && q.home_line === hl);
  chk('two books, 4 + 2 numbers', p.books === 2 && dk.length === 4 && p.quotes.length === 6, p.quotes.length);
  chk('home −4.5: Chiefs +120 / Bills −145 (home line stated for the home team)', at('draftkings', -4.5).price_home === 120 && at('draftkings', -4.5).price_away === -145);
  chk('Bills +13.5 −400 with no Chiefs side stays one-sided at home −13.5', at('draftkings', -13.5).price_home === null && at('draftkings', -13.5).price_away === -400);
  chk('an NFL quote is keyed by the provider event, not a schedule id', p.quotes.every((q) => q.game_id === null && q.provider_event_id === 'nfl_ev_1' && q.league === 'nfl'));
  const refusing = event('x', KC, BUF, NOW + H, [['dk', [outcome(KC, -110, -3.25), outcome('Denver Broncos', -110, 3), outcome(KC, 50, -2.5),
    outcome(KC, -110, -6.5), outcome(KC, -115, -6.5), outcome(KC, -300, -9.5), outcome(BUF, -300, 9.5), outcome(KC, -110, -80.5)]]]);
  const r = ALT.parseEventOdds(refusing, null, '2026-10-01T14:30:00Z');
  chk('quarter line, a stranger, an impossible price, a duplicate, a two-way hold out of bounds and an out-of-range line are all refused',
    r.refused['not a half-point line'] === 1 && r.refused['outcome names neither team'] === 1 && r.refused['price not a valid American price'] === 1
    && r.refused['duplicate outcome'] === 1 && r.refused['two-way hold out of bounds'] === 1 && r.refused['spread out of bounds'] === 1, r.refused);
  chk('a refused number is never repaired into a quote', r.quotes.length === 1 && r.quotes[0].home_line === -6.5 && r.quotes[0].price_home === -110, r.quotes);
  const cfb = ALT.parseEventOdds(E1, 'g77', '2026-10-01T14:30:00Z');
  const q0 = cfb.quotes[0];
  chk('the CFB fingerprint is unchanged from the ledger already on disk (game id, book, number, both prices)',
    q0.fingerprint === sha([q0.game_id, q0.book, q0.home_line, q0.price_home, q0.price_away]).slice(0, 24));
  chk('no market other than alternate_spreads is read', ALT.parseEventOdds(Object.assign({}, E1, { bookmakers: [{ key: 'dk', markets: [{ key: 'spreads', outcomes: [outcome(KC, -110, -3.5)] }] }] }), null, 'x').quotes.length === 0);
}

/* ======================================================================= 2 */
section('2. change-only persistence');
{
  const a = ALT.parseEventOdds(E1, null, '2026-10-01T14:30:00Z', { league: 'nfl' }).quotes;
  const b = ALT.parseEventOdds(E1, null, '2026-10-01T17:30:00Z', { league: 'nfl' }).quotes;
  chk('an unchanged NFL alternate is not re-written', ALT.selectNew(a, b).length === 0);
  const moved = JSON.parse(JSON.stringify(E1)); moved.bookmakers[0].markets[0].outcomes[0].price = -115; moved.bookmakers[0].markets[0].outcomes[1].price = -105;
  const c = ALT.parseEventOdds(moved, null, '2026-10-01T17:30:00Z', { league: 'nfl' }).quotes;
  const n = ALT.selectNew(a, c);
  chk('only the number whose price moved is appended', n.length === 1 && n[0].home_line === -3.5 && n[0].book === 'draftkings' && n[0].price_home === -115, n.map((x) => x.home_line));
  const other = JSON.parse(JSON.stringify(E1)); other.id = 'nfl_ev_2';
  chk('the same numbers in another event are another game', ALT.selectNew(a, ALT.parseEventOdds(other, null, 'x', { league: 'nfl' }).quotes).length === a.length);
}

/* ======================================================================= 3 */
section('3. the browser feed');
{
  const t1 = '2026-10-01T11:30:00.000Z', t2 = '2026-10-01T14:30:00.000Z';
  const first = ALT.parseEventOdds(E1, null, t1, { league: 'nfl' }).quotes;
  const past = ALT.parseEventOdds(event('old', KC, BUF, NOW - H, [['draftkings', [outcome(KC, -110, -1.5), outcome(BUF, -110, 1.5)]]]), null, t1, { league: 'nfl' }).quotes;
  const f = ALT.buildFeed({ league: 'nfl', now: NOW, ledger: first.concat(past), rebuild: true });
  const e = f.events.nfl_ev_1;
  chk('schema, league, provider and market are stated', f.schema === 'edgedesk_alternates_feed_v1' && f.league === 'nfl' && f.sport === 'americanfootball_nfl' && f.market === 'alternate_spreads');
  chk('a game that has kicked off is not in the feed', !f.events.old && f.n_events === 1);
  const q = (bk, side, pt) => e.quotes.find((x) => x.book === bk && x.side === side && x.point === pt);
  chk('each side is stated in its own terms: Chiefs −4.5 +120, Bills +4.5 −145', q('draftkings', 'home', -4.5).price_american === 120 && q('draftkings', 'away', 4.5).price_american === -145
    && q('draftkings', 'home', -4.5).selection === KC && q('draftkings', 'away', 4.5).selection === BUF);
  chk('a one-sided number lists only the side that was offered', q('draftkings', 'away', 13.5) && !q('draftkings', 'home', -13.5));
  chk('rebuilt from the ledger, a quote carries the time its price was stored, never a later one', e.observed_at === null && e.quotes.every((x) => x.observed_at === t1 && x.first_seen_at === t1));
  chk('one quote per (book, side, number), with a stable quote id per side', new Set(e.quotes.map((x) => x.book + x.side + x.point)).size === e.quotes.length && e.quotes.every((x) => /^edra_[0-9a-f]{24}:(home|away)$/.test(x.quote_id)));
  chk('books listed; counts add up', e.books.join() === 'draftkings,fanduel' && f.n_quotes === e.quotes.length && e.quotes.length === 11, [e.books, e.quotes.length]);

  /* a later run polls the event again: FanDuel pulled −4.5, DraftKings moved −3.5 */
  const later = JSON.parse(JSON.stringify(E1));
  later.bookmakers[1].markets[0].outcomes = later.bookmakers[1].markets[0].outcomes.slice(0, 2);
  later.bookmakers[0].markets[0].outcomes[0].price = -115; later.bookmakers[0].markets[0].outcomes[1].price = -105;
  const now2 = ALT.parseEventOdds(later, null, t2, { league: 'nfl' }).quotes;
  const unpolled = ALT.parseEventOdds(event('nfl_ev_9', 'Detroit Lions', 'Green Bay Packers', NOW + 50 * H, [['draftkings', [outcome('Detroit Lions', -110, -2.5), outcome('Green Bay Packers', -110, 2.5)]]]), null, t1, { league: 'nfl' }).quotes;
  const prior = ALT.buildFeed({ league: 'nfl', now: NOW - 3 * H, ledger: first.concat(unpolled), rebuild: true });
  const g = ALT.buildFeed({ league: 'nfl', now: NOW, prior, ledger: first.concat(unpolled).concat(ALT.selectNew(first, now2)),
    run: { polled: ['nfl_ev_1'], quotes: now2, observed_at: t2 } });
  const e2 = g.events.nfl_ev_1, q2 = (bk, side, pt) => e2.quotes.find((x) => x.book === bk && x.side === side && x.point === pt);
  chk('a polled event carries the poll time', e2.observed_at === t2);
  chk('a number the book pulled is gone, never carried forward', !q2('fanduel', 'home', -4.5) && !q2('fanduel', 'away', 4.5) && q2('fanduel', 'home', -3.5));
  chk('a moved price is first seen now; an unchanged one keeps its first-seen time', q2('draftkings', 'home', -3.5).price_american === -115 && q2('draftkings', 'home', -3.5).first_seen_at === t2
    && q2('draftkings', 'home', -4.5).first_seen_at === t1);
  chk('an event not polled keeps its last listing and its own older time (it ages into STALE)', g.events.nfl_ev_9 && g.events.nfl_ev_9.quotes.every((x) => x.observed_at === t1));
  const none = ALT.buildFeed({ league: 'nfl', now: NOW, prior: g, ledger: [], run: { polled: ['nfl_ev_1'], quotes: [], observed_at: t2,
    events: { nfl_ev_1: { provider_event_id: 'nfl_ev_1', home_team: KC, away_team: BUF, kickoff_ts: E1.commence_time } } } });
  chk('a polled event with no alternates offered is listed with no quotes (honest "none")', none.events.nfl_ev_1 && none.events.nfl_ev_1.quotes.length === 0 && none.events.nfl_ev_1.observed_at === t2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-feed-'));
  const file = path.join(dir, 'alternates_nfl.json');
  chk('the feed is written once', ALT.writeFeed(file, g) === true && JSON.parse(fs.readFileSync(file, 'utf8')).n_events === 2);
  chk('an identical listing is not rewritten just to move generated_at', ALT.writeFeed(file, Object.assign({}, g, { generated_at: '2026-10-01T15:00:00.000Z' })) === false);
}

/* ======================================================================= 4 */
section('4. the runner: budget, credits, failures and the last-run clock');
function stubProvider(o) {
  const calls = [];
  const getter = async (url) => {
    calls.push(url);
    if (/\/events\?/.test(url)) {
      if (o.indexFails) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      return { body: o.events, remaining: o.remaining != null ? o.remaining : 480 };
    }
    const id = decodeURIComponent(url.match(/\/events\/([^/]+)\/odds/)[1]);
    if (o.fail && o.fail[id]) throw Object.assign(new Error('HTTP ' + o.fail[id]), { status: o.fail[id] });
    return { body: o.bodies[id], remaining: (o.remaining != null ? o.remaining : 480) - calls.length };
  };
  return { getter, calls };
}
function tmpPaths() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-run-'));
  return { dir: d, quotes: path.join(d, 'alternates.jsonl'), state: path.join(d, 'alternates_state.json'), feed: path.join(d, 'feed', 'alternates_nfl.json') };
}
const E2 = event('nfl_ev_2', 'Detroit Lions', 'Green Bay Packers', NOW + 50 * H, [['draftkings', [outcome('Detroit Lions', -110, -2.5), outcome('Green Bay Packers', -110, 2.5)]]]);
const FAR = event('nfl_ev_far', 'Dallas Cowboys', 'New York Giants', NOW + 200 * H, [['draftkings', [outcome('Dallas Cowboys', -110, -6.5), outcome('New York Giants', -110, 6.5)]]]);
const STARTED = event('nfl_ev_live', 'Miami Dolphins', 'New York Jets', NOW - H, []);
const index = [E1, E2, FAR, STARTED].map((e) => ({ id: e.id, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team }));
const base = { key: 'test-key', league: 'nfl', now: NOW, window_h: 72, max_events: 12, min_interval_h: 3, min_remaining: 25, bookmakers: 'draftkings,fanduel' };
(async function () {
  {
    const r = await ALT.run(Object.assign({}, base, { key: null, paths: tmpPaths() }));
    chk('no key: nothing captured, nothing spent', /no ODDS_API_KEY/.test(r.skipped));
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 } });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter }));
    const odds = S.calls.filter((u) => /\/odds\?/.test(u));
    chk('only games inside the window that have not kicked off are priced, nearest first', r.events_in_window === 2 && odds.length === 2 && /nfl_ev_1/.test(odds[0]) && /nfl_ev_2/.test(odds[1]), odds);
    chk('one market and one bookmakers list per call', odds.every((u) => /markets=alternate_spreads&bookmakers=draftkings%2Cfanduel&oddsFormat=american/.test(u)));
    chk('the NFL sport key is used', S.calls.every((u) => /americanfootball_nfl/.test(u)));
    const stored = fs.readFileSync(P.quotes, 'utf8').trim().split('\n');
    chk('the ledger gets every priced number (6 + 1)', r.written === 7 && stored.length === 7, r.written);
    const st = JSON.parse(fs.readFileSync(P.state, 'utf8'));
    chk('a run that priced events advances the clock', st.last_run === new Date(NOW).toISOString() && st.last_attempt === st.last_run);
    const feed = JSON.parse(fs.readFileSync(P.feed, 'utf8'));
    chk('the browser feed lists both polled events at the poll time', feed.n_events === 2 && feed.events.nfl_ev_1.observed_at === new Date(NOW).toISOString() && feed.events.nfl_ev_2.quotes.length === 2);
    const again = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter, now: NOW + H }));
    chk('a second run inside the interval spends nothing', /every 3 h at most/.test(again.skipped) && S.calls.length === 3);
    const later = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter, now: NOW + 4 * H }));
    chk('an unchanged board appends nothing (change-only)', later.events_priced === 2 && later.written === 0 && fs.readFileSync(P.quotes, 'utf8').trim().split('\n').length === 7);
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: {}, fail: { nfl_ev_1: 500, nfl_ev_2: 502 } });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter }));
    const st = JSON.parse(fs.readFileSync(P.state, 'utf8'));
    chk('when every event call fails the clock does not move (the next run is not locked out)', r.events_priced === 0 && st.last_run === null && st.last_attempt === new Date(NOW).toISOString(), st);
    chk('failures are counted by status', r.refused['event failed: 500'] === 1 && r.refused['event failed: 502'] === 1);
    const S2 = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 } });
    const r2 = await ALT.run(Object.assign({}, base, { paths: P, getJson: S2.getter, now: NOW + 10 * 60e3 }));
    chk('...so a retry ten minutes later is allowed and prices', r2.events_priced === 2);
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 }, fail: { nfl_ev_1: 429 } });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter }));
    chk('a 429 stops the run at once', r.events_priced === 0 && /429/.test(r.stopped) && S.calls.filter((u) => /\/odds\?/.test(u)).length === 1);
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 }, remaining: 10 });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter }));
    chk('below the credit floor nothing is spent', r.events_priced === 0 && /credits below floor/.test(r.stopped) && S.calls.length === 1);
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 } });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter, max_events: 1 }));
    chk('--max-events caps the spend', r.events_priced === 1 && r.events_joined === 2);
  }
  {
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: {}, indexFails: true });
    const r = await ALT.run(Object.assign({}, base, { paths: P, getJson: S.getter }));
    chk('a failed event index records the attempt and spends nothing', /event index failed/.test(r.skipped) && !fs.existsSync(P.quotes));
  }
  {
    /* CFB: the Model Lab's join decides the game id; an unjoined event is not priced */
    const P = tmpPaths(), S = stubProvider({ events: index, bodies: { nfl_ev_1: E1, nfl_ev_2: E2 } });
    const intel = { joinSignalsToGames: ({ signals }) => ({ by_game: { g77: signals.filter((s) => s.provider_event_id === 'nfl_ev_1') }, signals_refused: signals.length - 1 }) };
    const r = await ALT.run(Object.assign({}, base, { league: 'cfb', paths: P, getJson: S.getter, intel, market: { scheduleGames: () => [] } }));
    const rows = fs.readFileSync(P.quotes, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    chk('CFB: only joined events are priced, under their schedule game id', r.events_priced === 1 && r.join_refused === 1 && rows.every((q) => q.game_id === 'g77'));
    chk('CFB uses the NCAAF sport key', S.calls.every((u) => /americanfootball_ncaaf/.test(u)));
    const fo = ALT.feedOnly({ league: 'cfb', now: NOW, paths: P, dry_run: true });
    chk('--feed-only rebuilds the feed from the ledger with no network', fo.events === 1 && fo.feed_json.events.nfl_ev_1.game_id === 'g77' && fo.written === false);
  }
  {
    const P = ALT.ledgerPaths(2026, 'cfb'), N = ALT.ledgerPaths(2026, 'nfl');
    chk('the CFB ledger stays where build.js reads it', /football\/cfb_terminal\/read\/2026\/alternates\.jsonl$/.test(P.quotes));
    chk('the NFL ledger and both feeds live under football/markets', /football\/markets\/ledger\/nfl\/2026\/alternates\.jsonl$/.test(N.quotes)
      && /football\/markets\/alternates_cfb\.json$/.test(P.feed) && /football\/markets\/alternates_nfl\.json$/.test(N.feed));
    let threw = false; try { ALT.ledgerPaths(2026, 'mlb'); } catch (e) { threw = true; }
    chk('an unknown league is refused', threw);
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

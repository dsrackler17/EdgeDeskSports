#!/usr/bin/env node
/* ===========================================================================
   ADVERSARIAL TESTS for the capture edge function, run under Node.

   The DEPLOYED file is imported — not a copy — with a Deno shim and a mocked
   network, the same way tools/presentation/edgedesk_ai.test.js already tests
   edgedesk_ai. Nothing here reaches a network and nothing here writes.

   That was impossible until v9: v8 imported createClient from an https URL,
   which Node's type stripping cannot resolve, so the single function that
   decides what EdgeDesk calls a bet had no test that ran anywhere.

   WHAT IS UNDER TEST is the qualification contract, case by case, in the shape
   the brief asks for:

     1  one book posts 12.0 while everyone else is around 1.90
     2  one stale book offers a suspiciously good number
     3  Pinnacle missing
     4  Pinnacle stale
     5  Pinnacle present and fresh
     6  one book duplicated twice
     7  malformed market
     8  missing outcomes
     9  non-numeric odds
    10  one-book market
    11  two-book disagreement
    12  five-book tight consensus
    13  spread with mismatched points
    14  total with mismatched points
    15  line moving through 3
    16  line moving through 7
    17  exchange lay quote
    18  extreme longshot
    19  favourite at very short odds
    20  a temporary edge that appears for one capture and disappears
    21  a persistent edge across multiple captures
    22  duplicate event
    23  partial API failure
    24  write failure
    25  capture wall-clock cutoff
    26  a quote exactly at the allowed freshness threshold
    27  the board attempting to surface an unqualified positive-edge row
        (that one is tools/capture/board_contract.test.js — it belongs to the
        reader, and capture cannot assert it from here)

   Run: node tools/capture/capture.test.js
   =========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) {
    console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the Deno shim, installed BEFORE the import ------------------------- */
const ENV = {
  CRON_SECRET: 'test-secret',
  ODDS_API_KEY: 'test-odds-key',
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  CAPTURE_NO_SERVE: '1',
  CAPTURE_SPORTS: 'americanfootball_nfl',
  CAPTURE_AUTO_PREFIXES: '',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

/* ---- the mocked network ------------------------------------------------- */
const net = { calls: [], odds: {}, sports: ['americanfootball_nfl'], db: null, oddsFail: {}, eventOdds: {}, eventFail: null, eventRemaining: null };
function res(status, body, headers) {
  const h = headers || {};
  return {
    ok: status < 300, status,
    headers: { get: (n) => h[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}
globalThis.fetch = async function (url, init) {
  const u = String(url), method = (init && init.method) || 'GET';
  net.calls.push({ url: u, method, body: init && init.body ? JSON.parse(init.body) : null });
  if (u.indexOf('api.the-odds-api.com/v4/sports/?') >= 0) {
    return res(200, net.sports.map((k) => ({ key: k, active: true, has_outrights: false })));
  }
  /* The event-level endpoint, shaped like the provider: it returns only the
     markets asked for, and bills (unique markets returned) x (region
     equivalents) in x-requests-last. An unknown event is a 404, as before. */
  const em = /\/v4\/sports\/([^/]+)\/events\/([^/?]+)\/odds/.exec(u);
  if (em) {
    const sport = decodeURIComponent(em[1]), id = decodeURIComponent(em[2]);
    const asked = decodeURIComponent((/[?&]markets=([^&]*)/.exec(u) || [])[1] || '').split(',').filter(Boolean);
    const remaining = String(net.eventRemaining == null ? 4000 : net.eventRemaining);
    if (net.eventFail) { const st = net.eventFail(sport, id, asked); if (st) return res(st, 'upstream said no', { 'x-requests-remaining': remaining, 'x-requests-last': '0' }); }
    const full = (net.eventOdds[sport] || {})[id];
    if (!full) return res(404, 'nope');
    const books = (full.bookmakers || []).map((b) => Object.assign({}, b, { markets: (b.markets || []).filter((mk) => asked.includes(mk.key)) }))
      .filter((b) => b.markets.length);
    const returned = new Set();
    books.forEach((b) => b.markets.forEach((mk) => returned.add(mk.key)));
    const regions = /[?&]bookmakers=/.test(u) ? 1 : decodeURIComponent((/[?&]regions=([^&]*)/.exec(u) || [])[1] || 'us').split(',').length;
    return res(200, Object.assign({}, full, { bookmakers: books }),
      { 'x-requests-remaining': remaining, 'x-requests-used': '1000', 'x-requests-last': String(returned.size * regions) });
  }
  const m = /\/v4\/sports\/([^/]+)\/odds/.exec(u);
  if (m) {
    const sport = decodeURIComponent(m[1]);
    if (net.oddsFail[sport]) return res(net.oddsFail[sport], 'upstream said no', { 'x-requests-remaining': '100' });
    return res(200, net.odds[sport] || [], { 'x-requests-remaining': '4321', 'x-requests-used': '679', 'x-requests-last': '3' });
  }
  if (u.indexOf('sb.test') >= 0) return net.db ? net.db(u, method, init) : res(200, [], { 'content-range': '*/0' });
  return res(404, 'nope');
};

/* ---- fixtures ----------------------------------------------------------- */
const NOW = Date.now();
const KICK = new Date(NOW + 6 * 3600 * 1000).toISOString();     // 6h out -> "soon" bucket
const AGO = (s) => new Date(NOW - s * 1000).toISOString();

/** One bookmaker entry. `age` is seconds since its last update. */
function bk(key, outcomes, opts) {
  const o = opts || {};
  return {
    key, title: o.title || key.toUpperCase(),
    last_update: AGO(o.age == null ? 60 : o.age),
    markets: [{ key: o.market || 'spreads', last_update: AGO(o.age == null ? 60 : o.age), outcomes }],
  };
}
function spread(aPrice, bPrice, point) {
  return [
    { name: 'Chiefs', price: aPrice, point: point == null ? -3.5 : point },
    { name: 'Ravens', price: bPrice, point: point == null ? 3.5 : -point },
  ];
}
function ev(bookmakers, over) {
  return Object.assign({
    id: 'evt-1', sport_key: 'americanfootball_nfl', sport_title: 'NFL',
    commence_time: KICK, home_team: 'Chiefs', away_team: 'Ravens', bookmakers,
  }, over || {});
}

(async function main() {
  const M = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'));
  const cfg0 = M.defaultConfig(() => undefined);
  const cfgWith = (o) => Object.assign({}, cfg0, o || {});

  /** Price one event and return its candidates keyed market|selection|point. */
  function priceMap(event, cfg) {
    const r = M.priceEvent(event, cfg || cfg0, NOW);
    const map = {};
    r.candidates.forEach((c) => { map[c.market + '|' + c.selection + '|' + (c.point == null ? '' : c.point)] = c; });
    return { map, meta: r };
  }
  const q = (c, cfg, streak) => M.qualifySignal(c, { priorStreak: streak || 0, nowMs: NOW }, cfg || cfg0);

  chk('module exports the qualification engine', typeof M.qualifySignal === 'function' && typeof M.priceEvent === 'function');
  chk('build and policy version are both stamped', /^capture-v11-player-props/.test(M.BUILD) && /^qual-/.test(M.POLICY_VERSION), [M.BUILD, M.POLICY_VERSION]);

  /* ═══ MATH ══════════════════════════════════════════════════════════════ */
  {
    const s = M.devig([1.90, 2.00]);
    chk('shin devig sums to 1', Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9, s);
    chk('shin favours the shorter price', s[0] > s[1], s);
    const p = M.devig([1.90, 2.00], 'power');
    chk('power devig sums to 1', Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9, p);
    const mm = M.devig([2.5, 3.4, 3.0]);
    chk('three-way shin devig sums to 1', Math.abs(mm.reduce((a, b) => a + b, 0) - 1) < 1e-9, mm);

    /* THE UNDERROUND BUG. Two prices that sum to less than 1 in implied
       probability are an arbitrage, and v8's Shin solver had no root in its
       bracket for that case: it returned the bracket endpoint and produced
       "probabilities" summing to ~0.53, silently, which then multiplied a price
       to make an edge. */
    const under = M.devig([2.10, 2.10]);
    chk('an underround book still devigs to a unit sum', Math.abs(under.reduce((a, b) => a + b, 0) - 1) < 1e-9, under);
    const underP = M.devig([2.10, 2.10], 'power');
    chk('underround under power devigs to a unit sum', Math.abs(underP.reduce((a, b) => a + b, 0) - 1) < 1e-9, underP);

    chk('bisect refuses an unbracketed root instead of returning an endpoint',
      M.bisect((x) => x * x + 1, 0, 1) === null);
    chk('bisect solves a bracketed root', Math.abs(M.bisect((x) => x - 0.25, 0, 1) - 0.25) < 1e-9);

    chk('trimmedMedian drops one value from each tail at n>=5', M.trimmedMedian([1, 2, 3, 4, 100]) === 3);
    chk('trimmedMedian is exactly a median below n=5', M.trimmedMedian([1, 2, 3, 100]) === 2.5);
    chk('mad is robust to a single wild value', M.mad([1, 1, 1, 1, 50]) === 0);
  }

  /* ═══ 15 + 16 — FOOTBALL KEY NUMBERS ════════════════════════════════════ */
  {
    const nfl = 'americanfootball_nfl', cfb = 'americanfootball_ncaaf';
    chk('15 · 2.5 -> 3 lands on the key number', JSON.stringify(M.keyNumbersCrossed(2.5, 3, nfl)) === '[3]');
    chk('15 · 3 -> 3.5 leaves the key number', JSON.stringify(M.keyNumbersCrossed(3, 3.5, nfl)) === '[3]');
    chk('15 · 2.5 -> 3.5 crosses 3', JSON.stringify(M.keyNumbersCrossed(2.5, 3.5, nfl)) === '[3]');
    chk('15 · sign is irrelevant: -2.5 -> -3.5 crosses 3', JSON.stringify(M.keyNumbersCrossed(-2.5, -3.5, nfl)) === '[3]');
    chk('16 · 6.5 -> 7 lands on 7', JSON.stringify(M.keyNumbersCrossed(6.5, 7, nfl)) === '[7]');
    chk('16 · 7 -> 7.5 leaves 7', JSON.stringify(M.keyNumbersCrossed(7, 7.5, nfl)) === '[7]');
    chk('16 · 6.5 -> 7.5 crosses 7 in college too', JSON.stringify(M.keyNumbersCrossed(6.5, 7.5, cfb)) === '[7]');
    chk('4 -> 4.5 crosses nothing material', M.keyNumbersCrossed(4, 4.5, nfl).length === 0);
    chk('4 is available as a minor key when asked for explicitly', JSON.stringify(M.keyNumbersCrossed(4, 4.5, nfl, true)) === '[4]');
    chk('an unchanged line crosses nothing', M.keyNumbersCrossed(3, 3, nfl).length === 0);
    chk('2.5 -> 7.5 reports every key number it passed', JSON.stringify(M.keyNumbersCrossed(2.5, 7.5, nfl)) === '[3,6,7]');
    chk('a non-football sport has no key numbers', M.keyNumbersCrossed(2.5, 3.5, 'baseball_mlb').length === 0);
  }

  /* ═══ 13 + 14 — MISMATCHED POINTS ARE NOT THE SAME BET ══════════════════ */
  {
    /* Four books on Chiefs -3.5, one lone book on Chiefs -3 at a big price. If
       the -3 quote could reach the -3.5 consensus, that lone book would show a
       huge edge against a fair line derived from a DIFFERENT BET. Across a key
       number, no less. */
    const e = ev([
      bk('draftkings', spread(1.91, 1.91, -3.5)),
      bk('fanduel', spread(1.92, 1.90, -3.5)),
      bk('betmgm', spread(1.90, 1.92, -3.5)),
      bk('caesars', spread(1.91, 1.91, -3.5)),
      bk('bovada', spread(2.40, 1.60, -3)),
    ]);
    const { map } = priceMap(e);
    chk('13 · -3.5 and -3 are separate candidates', !!map['spreads|Chiefs|-3.5'] && !!map['spreads|Chiefs|-3']);
    chk('13 · the -3.5 consensus never sees the -3 quote',
      map['spreads|Chiefs|-3.5'].quotes.every((x) => x.book !== 'bovada'),
      map['spreads|Chiefs|-3.5'].quotes.map((x) => x.book));
    chk('13 · the lone -3 line stands on exactly one book',
      map['spreads|Chiefs|-3'].quotes.length === 1, map['spreads|Chiefs|-3'].quotes.length);
    const v3 = q(map['spreads|Chiefs|-3']);
    chk('13 · a one-book minority line across a key number is NOT actionable',
      v3.actionable === false, v3.reason);
    chk('13 · and the run records that it sat off the modal line',
      v3.point_is_modal === false && v3.modal_point === -3.5, [v3.point_is_modal, v3.modal_point]);
    chk('13 · the key number between the minority line and the market is reported',
      JSON.stringify(v3.key_numbers_to_modal) === '[3]', v3.key_numbers_to_modal);

    /* Totals: same trap, same rule. */
    const t = ev([
      bk('draftkings', [{ name: 'Over', price: 1.91, point: 47.5 }, { name: 'Under', price: 1.91, point: 47.5 }], { market: 'totals' }),
      bk('fanduel', [{ name: 'Over', price: 1.90, point: 47.5 }, { name: 'Under', price: 1.92, point: 47.5 }], { market: 'totals' }),
      bk('betmgm', [{ name: 'Over', price: 2.35, point: 47 }, { name: 'Under', price: 1.62, point: 47 }], { market: 'totals' }),
    ]);
    const tm = priceMap(t).map;
    chk('14 · O47 and O47.5 are separate candidates', !!tm['totals|Over|47.5'] && !!tm['totals|Over|47']);
    chk('14 · the O47.5 consensus never sees the O47 quote',
      tm['totals|Over|47.5'].quotes.every((x) => x.book !== 'betmgm'));
  }

  /* ═══ ALTERNATE LINES INSIDE ONE MARKET OBJECT ══════════════════════════ */
  {
    /* A book returning -3 and -3.5 in ONE market object is four prices across two
       markets. Devigging them together treats a double-counted outcome space as
       exhaustive and roughly halves every fair from that book. */
    const alt = ev([{
      key: 'draftkings', title: 'DraftKings', last_update: AGO(30),
      markets: [{ key: 'spreads', last_update: AGO(30), outcomes: [
        { name: 'Chiefs', price: 1.91, point: -3.5 }, { name: 'Ravens', price: 1.91, point: 3.5 },
        { name: 'Chiefs', price: 2.30, point: -3 }, { name: 'Ravens', price: 1.65, point: 3 },
      ] }],
    }]);
    const am = priceMap(alt).map;
    const f35 = am['spreads|Chiefs|-3.5'].quotes[0].fair;
    const f30 = am['spreads|Chiefs|-3'].quotes[0].fair;
    chk('alternate lines are devigged as two markets, not one', Math.abs(f35 - 0.5) < 0.02, f35);
    chk('and the alternate line gets its own honest fair', f30 > 0.40 && f30 < 0.46, f30);
    chk('each alternate line pairs with its own opposite side',
      Math.abs(am['spreads|Chiefs|-3.5'].quotes[0].oppDec - 1.91) < 1e-9
      && Math.abs(am['spreads|Chiefs|-3'].quotes[0].oppDec - 1.65) < 1e-9);
    chk('partitionOutcomes refuses a point group that is not a pair',
      M.partitionOutcomes([{ name: 'A', point: 3, price: 2 }, { name: 'B', point: 3, price: 2 }, { name: 'C', point: 3, price: 2 }])[0].ok === false);
    chk('partitionOutcomes keeps a three-way moneyline whole',
      M.partitionOutcomes([{ name: 'A', price: 2 }, { name: 'D', price: 3 }, { name: 'B', price: 4 }]).length === 1);
  }

  /* ═══ 1 — THE 12.0 AGAINST A PACK AT 1.90 ═══════════════════════════════ */
  {
    const e = ev([
      bk('draftkings', spread(1.90, 1.92)), bk('fanduel', spread(1.91, 1.91)),
      bk('betmgm', spread(1.92, 1.90)), bk('caesars', spread(1.89, 1.93)),
      bk('bovada', spread(12.0, 1.05)),
    ]);
    const c = priceMap(e).map['spreads|Chiefs|-3.5'];
    const v = q(c);
    chk('1 · the 12.0 is refused as an outlier', v.actionable === false && /outlier/.test(v.reason), v.reason);
    chk('1 · and it is refused in probability space, the tightest test', v.reason === 'best_price_outlier_abs', v.reason);
    chk('1 · the row is still PRICED and stored, not discarded', !!c && c.quotes.length === 5);
  }

  /* ═══ 18 + 19 — THE PRICE BANDS OUTLIER DETECTION MUST NOT CONFUSE ══════ */
  {
    /* A longshot pack around 10.0 with a best of 13.0 is ordinary disagreement:
       2.4 probability points. v8's decimal ratio of 1.35 refused it. */
    const lng = ev([
      bk('draftkings', spread(9.5, 1.10)), bk('fanduel', spread(10.0, 1.09)),
      bk('betmgm', spread(10.5, 1.08)), bk('caesars', spread(13.0, 1.06)),
      bk('betrivers', spread(10.2, 1.09)),
    ]);
    const vl = q(priceMap(lng).map['spreads|Chiefs|-3.5']);
    chk('18 · legitimate longshot disagreement is not called an outlier',
      !/outlier/.test(vl.reason), vl.reason);

    /* But doubling a longshot IS an outlier — the absolute gap stays small while
       the price has doubled, which is what minProbRatio is for. */
    const dbl = ev([
      bk('draftkings', spread(9.5, 1.10)), bk('fanduel', spread(10.0, 1.09)),
      bk('betmgm', spread(10.5, 1.08)), bk('caesars', spread(22.0, 1.03)),
      bk('betrivers', spread(10.2, 1.09)),
    ]);
    const vd = q(priceMap(dbl).map['spreads|Chiefs|-3.5']);
    chk('18 · a doubled longshot IS refused, by the ratio test',
      vd.actionable === false && /outlier/.test(vd.reason), vd.reason);

    /* A very short favourite below the tradeable bound is refused as a price. */
    const fav = ev([
      bk('draftkings', spread(1.01, 15.0)), bk('fanduel', spread(1.01, 16.0)),
      bk('betmgm', spread(1.015, 14.0)), bk('caesars', spread(1.01, 15.5)),
    ]);
    const vf = q(priceMap(fav).map['spreads|Chiefs|-3.5']);
    chk('19 · a price below the tradeable bound is refused',
      vf.reason === 'price_below_tradeable_bound', vf.reason);
    chk('19 · and the row still records that it is the favourite', vf.is_fav === true);
  }

  /* ═══ 2 + 26 — FRESHNESS ════════════════════════════════════════════════ */
  {
    const limit = M.freshnessLimit(cfg0, 'americanfootball_nfl', 'spreads', 6);
    chk('26 · the NFL "soon" freshness limit is the documented 1800s', limit === 1800, limit);

    const at = ev([bk('draftkings', spread(1.91, 1.91), { age: limit })]);
    chk('26 · a quote EXACTLY at the limit is fresh',
      priceMap(at).map['spreads|Chiefs|-3.5'].quotes[0].fresh === true);
    const past = ev([bk('draftkings', spread(1.91, 1.91), { age: limit + 1 })]);
    chk('26 · one second past the limit is not',
      priceMap(past).map['spreads|Chiefs|-3.5'].quotes[0].fresh === false);

    /* 2 — a STALE book offering a suspiciously good number must not set the
       price EdgeDesk claims. The executable price is the best FRESH one. */
    const stale = ev([
      bk('draftkings', spread(1.91, 1.91), { age: 60 }), bk('fanduel', spread(1.92, 1.90), { age: 90 }),
      bk('betmgm', spread(1.90, 1.92), { age: 45 }), bk('caesars', spread(1.93, 1.89), { age: 30 }),
      bk('bovada', spread(2.15, 1.75), { age: 9000 }),
    ]);
    const vs = q(priceMap(stale).map['spreads|Chiefs|-3.5']);
    chk('2 · the stale generous quote does not become the execution price',
      vs.best_book !== 'bovada', vs.best_book);
    chk('2 · the execution price is the best FRESH quote', Math.abs(vs.best_dec - 1.93) < 1e-9, vs.best_dec);
    chk('2 · and the stale book is excluded from the fresh count',
      vs.fresh_books === 4 && vs.total_books === 5, [vs.fresh_books, vs.total_books]);

    /* Everything stale => nothing actionable, and the reason says so. */
    const allStale = ev([
      bk('draftkings', spread(1.91, 1.91), { age: 99999 }), bk('fanduel', spread(1.92, 1.90), { age: 99999 }),
      bk('betmgm', spread(2.20, 1.70), { age: 99999 }),
    ]);
    const va = q(priceMap(allStale).map['spreads|Chiefs|-3.5']);
    chk('2 · a board of only stale quotes is refused with a freshness reason',
      va.actionable === false && va.reason === 'best_price_stale', va.reason);

    /* A quote with no timestamp at all is NOT assumed young. */
    const noTs = ev([{ key: 'draftkings', title: 'DK', markets: [{ key: 'spreads', outcomes: spread(1.91, 1.91) }] }]);
    const nq = priceMap(noTs);
    chk('a quote with no update stamp is treated as stale by default',
      nq.map['spreads|Chiefs|-3.5'].quotes[0].fresh === false);
    chk('and missing stamps are counted so a changed feed is loud', nq.meta.missingTimestamps === 2, nq.meta.missingTimestamps);
    const fq = M.priceEvent(noTs, cfgWith({ treatMissingTimestampAsFresh: true }), NOW);
    chk('the missing-stamp policy is an explicit, documented downgrade',
      fq.candidates[0].quotes[0].fresh === true);
  }

  /* ═══ 3 + 4 + 5 — THE REFERENCE TIER ════════════════════════════════════ */
  {
    /* Four books inside a cent of each other and one soft book at 2.02. */
    const pack = () => [
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ];

    /* 5 — Pinnacle present and fresh, agreeing with the tight pack rather than
       with the soft book, so its de-vigged fair beats the soft book's price. */
    const withPin = ev(pack().concat([bk('pinnacle', spread(1.87, 1.95))]));
    const vp = q(priceMap(withPin).map['spreads|Chiefs|-3.5']);
    chk('5 · Pinnacle present and fresh gives Tier A', vp.tier === 'A', [vp.tier, vp.reason]);
    chk('5 · reference_type says sharp, and means it', vp.reference_type === 'sharp' && vp.reference_book === 'pinnacle');
    chk('5 · has_sharp is true only with a real fresh reference book', vp.has_sharp === true);
    chk('5 · sharp_book_fair carries Pinnacle\'s own number', vp.sharp_book_fair != null && vp.sharp_book_fair === vp.fair_probability);
    chk('5 · the raw two-way Pinnacle price is stored for the method-sensitivity panel',
      Math.abs(vp.pin_dec - 1.87) < 1e-9 && Math.abs(vp.pin_opp_dec - 1.95) < 1e-9, [vp.pin_dec, vp.pin_opp_dec]);
    chk('5 · the sharp anchor is Pinnacle\'s fair, not the pack median',
      vp.edge > 0.015 && vp.best_book === 'betrivers', [vp.edge, vp.best_book]);
    chk('5 · a Tier A signal acts on the first sighting', vp.required_confirmations === 1);

    /* 3 — Pinnacle MISSING. The consensus must never be called sharp. */
    const noPin = ev(pack());
    const vn = q(priceMap(noPin).map['spreads|Chiefs|-3.5'], null, 5);
    chk('3 · Pinnacle missing gives Tier B, never Tier A', vn.tier !== 'A', vn.tier);
    chk('3 · reference_type is robust_consensus, not sharp', vn.reference_type === 'robust_consensus', vn.reference_type);
    chk('3 · has_sharp is FALSE — this is the v8 lie, closed', vn.has_sharp === false);
    chk('3 · sharp_book_fair is NULL and can never be a median', vn.sharp_book_fair === null);
    chk('3 · a Tier B signal must be seen twice before it acts', vn.required_confirmations === 2);

    /* 4 — Pinnacle present but STALE. Distinguished from missing, by reason. */
    const stalePin = ev([
      bk('draftkings', spread(1.91, 1.91)), bk('fanduel', spread(1.90, 1.92)),
      bk('pinnacle', spread(1.98, 1.94), { age: 99999 }),
    ]);
    const vsp = q(priceMap(stalePin).map['spreads|Chiefs|-3.5']);
    chk('4 · a stale Pinnacle does not anchor anything', vsp.tier !== 'A' && vsp.has_sharp === false, [vsp.tier, vsp.has_sharp]);
    chk('4 · and it is reported as stale, not as missing', vsp.reason === 'sharp_quote_stale', vsp.reason);
    chk('4 · the reference book is still named so coverage is auditable', vsp.reference_book === 'pinnacle');
  }

  /* ═══ THE BEST-PRICE BOOK CANNOT SET ITS OWN FAIR VALUE ═════════════════ */
  {
    const e = ev([
      bk('draftkings', spread(1.91, 1.91)), bk('fanduel', spread(1.91, 1.91)),
      bk('betmgm', spread(1.91, 1.91)), bk('caesars', spread(1.91, 1.91)),
      bk('betrivers', spread(2.05, 1.80)),
    ]);
    const c = priceMap(e).map['spreads|Chiefs|-3.5'];
    const v = q(c, null, 5);
    const bestFair = c.quotes.find((x) => x.book === v.best_book).fair;
    chk('the consensus excludes the book offering the best price',
      Math.abs(v.fair_probability - bestFair) > 1e-6, [v.fair_probability, bestFair]);
    chk('the pack fair is the four agreeing books, not five',
      Math.abs(v.fair_probability - 0.5) < 0.01, v.fair_probability);
  }

  /* ═══ 6 — ONE BOOK DUPLICATED TWICE ═════════════════════════════════════ */
  {
    const dup = ev([
      { key: 'draftkings', title: 'DraftKings', last_update: AGO(30), markets: [
        { key: 'spreads', last_update: AGO(30), outcomes: spread(1.91, 1.91) },
        { key: 'spreads', last_update: AGO(30), outcomes: spread(2.30, 1.65) },
      ] },
      bk('fanduel', spread(1.90, 1.92)),
    ]);
    const r = priceMap(dup);
    const c = r.map['spreads|Chiefs|-3.5'];
    chk('6 · a book listing the same selection twice counts once', c.quotes.length === 2, c.quotes.length);
    chk('6 · and the duplicate is counted so it is visible', r.meta.duplicateQuotes > 0, r.meta.duplicateQuotes);
    chk('6 · first quote wins, so the second cannot become the best price',
      Math.abs(c.quotes.find((x) => x.book === 'draftkings').dec - 1.91) < 1e-9);
    const v = q(c);
    chk('6 · two books is below every tier bar', v.actionable === false, v.reason);
  }

  /* ═══ 7 + 8 + 9 + 10 + 11 — MALFORMED AND THIN FEEDS ════════════════════ */
  {
    const bad = ev([
      { key: 'a', title: 'A', last_update: AGO(10), markets: [{ key: 'spreads' }] },                          // 7 no outcomes
      { key: 'b', title: 'B', last_update: AGO(10), markets: [{ key: 'spreads', outcomes: null }] },          // 8 null outcomes
      { key: 'c', title: 'C', last_update: AGO(10), markets: [{ key: 'spreads', outcomes: [{ name: 'Chiefs', price: 'abc', point: -3.5 }, { name: 'Ravens', price: 1.9, point: 3.5 }] }] }, // 9
      { key: 'd', title: 'D', last_update: AGO(10), markets: [{ key: 'spreads', outcomes: [{ name: 'Chiefs', price: 1.9, point: -3.5 }] }] },  // one-sided
      bk('draftkings', spread(1.91, 1.91)),
    ]);
    let r;
    let threw = false;
    try { r = priceMap(bad); } catch (e) { threw = true; }
    chk('7-9 · a malformed feed never throws out of priceEvent', threw === false);
    chk('7-9 · the malformed markets are counted, not silently dropped', r.meta.malformed >= 4, r.meta.malformed);
    chk('7-9 · the one good book still prices', !!r.map['spreads|Chiefs|-3.5']);
    chk('9 · a non-numeric price cannot reach a candidate',
      r.map['spreads|Chiefs|-3.5'].quotes.every((x) => Number.isFinite(x.dec)));

    /* 10 — a single-book market. */
    const one = ev([bk('draftkings', spread(2.30, 1.65))]);
    const v1 = q(priceMap(one).map['spreads|Chiefs|-3.5']);
    chk('10 · one book is not a consensus and is never actionable', v1.actionable === false, v1.reason);
    chk('10 · a one-book market fails on book count, not on price',
      v1.reason === 'insufficient_fresh_books' || v1.reason === 'insufficient_independent_books', v1.reason);

    /* 11 — two books that disagree materially. */
    const two = ev([bk('draftkings', spread(1.91, 1.91)), bk('bovada', spread(2.30, 1.65))]);
    const v2 = q(priceMap(two).map['spreads|Chiefs|-3.5']);
    chk('11 · two disagreeing books do not make a market', v2.actionable === false, v2.reason);
  }

  /* ═══ 12 — FIVE-BOOK TIGHT CONSENSUS ════════════════════════════════════ */
  {
    const e = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ]);
    const v = q(priceMap(e).map['spreads|Chiefs|-3.5'], null, 5);
    chk('12 · a tight five-book consensus with a real gap qualifies as Tier B',
      v.actionable === true && v.tier === 'B', [v.actionable, v.tier, v.reason, v.edge, v.edge_floor]);
    chk('12 · it clears the NFL spreads Tier B floor of 2.5%', v.edge >= 0.025, v.edge);
    chk('12 · five books, five families, low dispersion', v.fresh_books === 5 && v.families === 5 && v.dispersion < 0.02,
      [v.fresh_books, v.families, v.dispersion]);
    chk('12 · the quality components are all stored for audit',
      Object.keys(v.quality).sort().join(',') === 'consensus,edge,freshness,historical,persistence,reference');
    chk('12 · the historical component is honestly marked as no-information', v.quality.historical === 50);
    chk('12 · the segment names sport, market and tier', v.segment === 'nfl|spreads|B', v.segment);
  }

  /* ═══ FAMILY DE-DUPLICATION ═════════════════════════════════════════════ */
  {
    /* betonlineag and lowvig are one trading desk. Five feed rows, four opinions. */
    const e = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betonlineag', spread(1.88, 1.94)), bk('lowvig', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ]);
    const v = q(priceMap(e).map['spreads|Chiefs|-3.5'], null, 5);
    chk('n_books counts feed rows, families counts opinions',
      v.total_books === 5 && v.families === 4, [v.total_books, v.families]);
    chk('and n_books_eff is what app.html has always read and nothing ever wrote',
      M.signalRow(priceMap(e).map['spreads|Chiefs|-3.5'], v, '2026-09-05T12:00:00Z').n_books_eff === 4);
  }

  /* ═══ 17 — EXCHANGE LAY ═════════════════════════════════════════════════ */
  {
    chk('17 · backable() refuses every lay market shape',
      !M.backable('h2h_lay') && !M.backable('spreads_lay') && !M.backable('h2h_lay_1st_half') && M.backable('h2h'));
    const e = ev([
      bk('betfair_ex_uk', spread(1.91, 1.91), { market: 'h2h_lay' }),
      bk('matchbook', spread(1.90, 1.92), { market: 'h2h_lay' }),
      bk('smarkets', spread(2.60, 1.55), { market: 'h2h_lay' }),
      bk('betdaq', spread(1.92, 1.90), { market: 'h2h_lay' }),
    ]);
    const v = q(priceMap(e).map['h2h_lay|Chiefs|-3.5']);
    chk('17 · a lay quote is stored but never actionable',
      v.actionable === false && v.reason === 'exchange_lay_not_backable', v.reason);
  }

  /* ═══ 20 + 21 — PERSISTENCE ═════════════════════════════════════════════ */
  {
    const e = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ]);
    const c = priceMap(e).map['spreads|Chiefs|-3.5'];

    const first = q(c, null, 0);
    chk('21 · a Tier B candidate is not actionable on first sighting',
      first.actionable === false && first.reason === 'awaiting_confirmation', first.reason);
    chk('21 · but its streak advances so the next cycle can confirm it', first.confirmations === 1);
    const second = q(c, null, first.confirmations);
    chk('21 · a persistent Tier B edge becomes actionable on the second capture',
      second.actionable === true && second.confirmations === 2, [second.actionable, second.confirmations]);

    /* 20 — the edge disappears. The next cycle must not inherit the streak. */
    const gone = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(1.87, 1.95)),
    ]);
    const vg = q(priceMap(gone).map['spreads|Chiefs|-3.5'], null, 1);
    chk('20 · when the edge vanishes the candidate is not actionable', vg.actionable === false, vg.reason);
    chk('20 · and the row it writes back carries streak 0, so the count restarts',
      M.signalRow(priceMap(gone).map['spreads|Chiefs|-3.5'], vg, 'x').qual_streak === 0, vg.confirmations);

    /* A Tier A candidate does not wait. */
    const pinE = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(2.02, 1.83)), bk('pinnacle', spread(1.94, 1.98)),
    ]);
    const vpa = q(priceMap(pinE).map['spreads|Chiefs|-3.5'], null, 0);
    chk('a Tier A candidate is actionable on the first sighting',
      vpa.tier === 'A' && vpa.actionable === true, [vpa.tier, vpa.actionable, vpa.reason, vpa.edge]);
  }

  /* ═══ EDGE FLOORS ARE SEGMENTED ═════════════════════════════════════════ */
  {
    chk('the NFL spread Tier A floor is 1.5%, not 0.5%', M.EDGE_FLOOR['nfl|spreads|A'] === 0.015);
    chk('college football sits above the NFL on the same market',
      M.EDGE_FLOOR['ncaaf|spreads|A'] > M.EDGE_FLOOR['nfl|spreads|A']);
    chk('Tier B sits above Tier A in every football segment',
      M.EDGE_FLOOR['nfl|spreads|B'] > M.EDGE_FLOOR['nfl|spreads|A']
      && M.EDGE_FLOOR['ncaaf|totals|B'] > M.EDGE_FLOOR['ncaaf|totals|A']);
    chk('spreads and totals cap a plausible edge far below moneylines',
      M.EDGE_SANE_MAX['*|spreads'] === 0.10 && M.EDGE_SANE_MAX['*|h2h'] === 0.20);

    /* A segment set to null means "EdgeDesk has no demonstrated advantage here",
       and that must produce PASS rather than silently falling through. */
    const e = ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ]);
    const noAction = cfgWith({ edgeFloor: Object.assign({}, cfg0.edgeFloor, { 'nfl|spreads|B': null }) });
    const v = q(priceMap(e).map['spreads|Chiefs|-3.5'], noAction, 5);
    chk('a segment configured for NO ACTION produces PASS with that reason',
      v.actionable === false && v.reason === 'segment_not_qualified_for_action', v.reason);
  }

  /* ═══ CONFIG CANNOT FAIL OPEN ═══════════════════════════════════════════ */
  {
    const junk = M.defaultConfig((k) => (k === 'CAPTURE_MAX_ABS_PROB_DEV' || k === 'CAPTURE_MIN_BOOKS' ? 'not-a-number' : undefined));
    chk('a malformed numeric env var falls back to the default, never to NaN',
      junk.maxAbsProbDev === cfg0.maxAbsProbDev && Number.isFinite(junk.maxAbsProbDev), junk.maxAbsProbDev);
    const empty = M.defaultConfig((k) => (k === 'CAPTURE_REFERENCE_BOOKS' ? '' : undefined));
    chk('an empty reference-book list falls back to pinnacle rather than to nothing',
      empty.referenceBooks.join(',') === 'pinnacle', empty.referenceBooks);
    chk('the default regions include eu, without which Pinnacle is unreachable',
      /eu/.test(cfg0.regions), cfg0.regions);
    const off = M.defaultConfig((k) => (k === 'CAPTURE_AUTO_PREFIXES' ? '' : undefined));
    chk('auto-added sports can actually be turned off', off.autoPrefixes.length === 0, off.autoPrefixes);
    chk('and are on by default for both football codes',
      cfg0.autoPrefixes.indexOf('americanfootball_ncaaf') >= 0);
  }

  /* ═══ THE COST SHAPE OF THE BOOKMAKER LIST ══════════════════════════════ */
  {
    /* The odds endpoint bills at markets x regions, and the bookmakers parameter
       substitutes for the regions term in groups of ten ROUNDED UP. Ten keys is
       one region-equivalent; eleven is two. So this list reaches Pinnacle for
       what the broken us-only configuration cost, and an eleventh key silently
       doubles the bill — which is exactly the kind of thing that gets added by
       someone who does not know the rounding rule. */
    chk('the suggested bookmaker list is exactly ten keys, which is one region-equivalent',
      M.SUGGESTED_BOOKMAKERS.length === 10, M.SUGGESTED_BOOKMAKERS.length);
    chk('it contains the reference book, which is the entire reason it exists',
      M.SUGGESTED_BOOKMAKERS.indexOf('pinnacle') >= 0);
    chk('every key is a distinct operator family, so n_books_eff is not inflated',
      new Set(M.SUGGESTED_BOOKMAKERS.map((b) => M.bookFamily(b))).size === 10,
      M.SUGGESTED_BOOKMAKERS.map((b) => M.bookFamily(b)));
    const seenUrls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => { seenUrls.push(String(u)); return res(200, [], {}); };
    await M.fetchOdds('k', 'americanfootball_nfl', cfgWith({ bookmakers: ['pinnacle', 'draftkings'] }));
    await M.fetchOdds('k', 'americanfootball_nfl', cfgWith({ bookmakers: [] }));
    globalThis.fetch = realFetch;
    chk('a bookmaker list REPLACES regions rather than filtering within them',
      /bookmakers=/.test(seenUrls[0]) && !/regions=/.test(seenUrls[0]), seenUrls[0]);
    chk('and with no list it falls back to regions',
      /regions=us%2Ceu/.test(seenUrls[1]) && !/bookmakers=/.test(seenUrls[1]), seenUrls[1]);
  }

  /* ═══ THE FUNNEL IS MONOTONIC ═══════════════════════════════════════════ */
  {
    chk('every rejection reason is mapped to a funnel stage',
      Object.keys(M.STAGE_OF_REASON).length >= 20);
    chk('an unmapped reason reports zero stages rather than a phantom pass',
      M.stagesPassed('a_reason_nobody_added') === 0);
    chk('reaching the edge floor means every earlier gate was cleared',
      M.stagesPassed('below_segment_edge_floor') > M.stagesPassed('best_price_stale'));

    /* THE LAST STAGE HAS TO BE REACHABLE.
       `ok` mapped to the INDEX of the final stage (9) while the handler counts
       `for (s = 0; s < stagesPassed(reason); s++)`, so a candidate that cleared
       every gate registered on the first nine stages and left `actionable` at
       zero — for ever, on every run. The funnel's last row contradicted the
       `funnel.actionable` counter printed beside it, in the one report that
       exists to answer "why is the board empty". This replays the handler's own
       loop rather than asserting on the constant, so the guard survives a
       reshuffle of the table. */
    chk('a verdict that clears every gate clears ALL of them, the last included',
      M.stagesPassed('ok') === M.FUNNEL_STAGES.length, [M.stagesPassed('ok'), M.FUNNEL_STAGES.length]);
    {
      const counts = M.FUNNEL_STAGES.map(() => 0);
      for (let s = 0; s < M.stagesPassed('ok'); s++) counts[s]++;
      chk('so one actionable candidate registers on the actionable stage',
        counts[counts.length - 1] === 1, counts);
      chk('and the funnel stays monotonically non-increasing',
        counts.every((n, i) => i === 0 || n <= counts[i - 1]), counts);
    }
    {
      /* A rejection must NOT reach the stage that refused it. below_quality_floor
         stops at `quality_floor`, so that stage counts the ones that cleared it. */
      const counts = M.FUNNEL_STAGES.map(() => 0);
      for (let s = 0; s < M.stagesPassed('below_quality_floor'); s++) counts[s]++;
      chk('a rejection does not credit itself with the gate that refused it',
        counts[M.FUNNEL_STAGES.indexOf('quality_floor')] === 0
        && counts[M.FUNNEL_STAGES.indexOf('persistence')] === 1, counts);
    }
  }

  /* ═══ THE CADENCE TIER IS A NAME, NOT A LOOKUP ══════════════════════════ */
  {
    const base = M.defaultConfig(() => undefined);
    for (const t of ['near', 'day', 'board']) {
      const r = M.applyCadenceTier(base, t);
      chk('the ' + t + ' tier resolves and carries its own window',
        r.tier === t && Number.isFinite(r.cfg.nearHours) && Number.isFinite(r.cfg.maxDaysToStart),
        [t, r.cfg.nearHours, r.cfg.maxDaysToStart]);
    }
    chk('an unknown tier degrades to the environment window rather than to nothing',
      M.applyCadenceTier(base, 'nonsense').tier === null);
    /* `tier` is a query parameter. A bare CADENCE_TIERS[name] lookup also finds
       what the object INHERITS, and `constructor` survives toLowerCase(): it
       resolved to Object.prototype.constructor, reported itself as a real tier,
       and spread `maxDaysToStart: undefined` over the config — which silently
       disabled the actionable horizon, because every comparison against NaN is
       false and a game a month out stopped being beyond it. */
    for (const evil of ['constructor', '__proto__', 'hasownproperty']) {
      const r = M.applyCadenceTier(base, evil);
      chk('an inherited property name is not a cadence tier: ' + evil,
        r.tier === null && r.cfg.maxDaysToStart === base.maxDaysToStart
        && r.cfg.nearHours === base.nearHours,
        [evil, r.tier, r.cfg.maxDaysToStart]);
    }
  }

  /* ═══ 22-25 — THE HANDLER ═══════════════════════════════════════════════ */
  function okPack() {
    return [ev([
      bk('draftkings', spread(1.87, 1.95)), bk('fanduel', spread(1.88, 1.94)),
      bk('betmgm', spread(1.86, 1.96)), bk('caesars', spread(1.88, 1.94)),
      bk('betrivers', spread(2.02, 1.83)),
    ])];
  }
  const rq = (qs) => new Request('https://fn.test/capture' + (qs || ''), { headers: { 'x-cron-secret': 'test-secret' } });

  {
    const r = await M.handle(new Request('https://fn.test/capture'));
    chk('an unauthorized call is refused and names the precondition',
      r.status === 401 && /x-cron-secret/.test((await r.json()).reason));
  }
  {
    const saved = ENV.ODDS_API_KEY; ENV.ODDS_API_KEY = '';
    const j = await (await M.handle(rq())).json();
    chk('a missing odds key is a hard failure, never a quiet ok:true',
      j.ok === false && /ODDS_API_KEY/.test(j.error), j.error);
    ENV.ODDS_API_KEY = saved;
  }
  {
    const saved = ENV.SUPABASE_SERVICE_ROLE_KEY; ENV.SUPABASE_SERVICE_ROLE_KEY = '';
    const j = await (await M.handle(rq())).json();
    chk('capture refuses to price a board it cannot store', j.ok === false && /SERVICE_ROLE/.test(j.error), j.error);
    ENV.SUPABASE_SERVICE_ROLE_KEY = saved;
  }

  /* 22 — the same event returned twice. */
  {
    net.odds['americanfootball_nfl'] = okPack().concat(okPack());
    net.db = () => res(200, [], { 'content-range': '*/0' });
    const j = await (await M.handle(rq('?diag=1'))).json();
    chk('22 · a duplicate event cannot write the same sig_key twice',
      j.duplicate_sig_keys_dropped > 0, j.duplicate_sig_keys_dropped);
    chk('22 · diagnostics write nothing at all', j.persistence === 'skipped_intentionally');
  }

  /* 23 — one sport fails, the rest still capture. */
  {
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl,basketball_nba';
    net.odds['americanfootball_nfl'] = okPack();
    net.oddsFail['basketball_nba'] = 429;
    net.db = () => res(200, [], { 'content-range': '*/0' });
    const j = await (await M.handle(rq())).json();
    chk('23 · a failed sport is reported with its HTTP status', j.errored && j.errored[0].status === 429, j.errored);
    chk('23 · and the healthy sport still captured', j.priced > 0, j.priced);
    chk('23 · the run is neither a success nor a failure — it says partial', j.status === 'partial', j.status);
    delete net.oddsFail['basketball_nba'];
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
  }

  /* 24 — the database refuses the write. */
  {
    net.odds['americanfootball_nfl'] = okPack();
    net.db = (u, method) => (method === 'POST' ? res(500, 'insert exploded') : res(200, [], { 'content-range': '*/0' }));
    const j = await (await M.handle(rq())).json();
    chk('24 · a write failure is surfaced, never swallowed', (j.write_errors || []).length > 0, j.write_errors);
    chk('24 · and the run reports itself as partial rather than ok', j.status === 'partial', j.status);
  }

  /* 25 — the wall clock. */
  {
    ENV.CAPTURE_MAX_MS = '-1';
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl,basketball_nba';
    net.odds['americanfootball_nfl'] = okPack();
    net.odds['basketball_nba'] = okPack();
    net.db = () => res(200, [], { 'content-range': '*/0' });
    const j = await (await M.handle(rq())).json();
    chk('25 · a run out of clock stops cleanly and names what it skipped',
      (j.sports_skipped_for_time || []).length === 2, j.sports_skipped_for_time);
    chk('25 · and a run that captured nothing is never reported as ok', j.ok === false && j.status === 'failed');
    delete ENV.CAPTURE_MAX_MS;
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
  }

  /* 26 — a retired sport (lib/edgedesk_sports.js) is never requested, whatever
     the configuration or discovery says, and the run names what it skipped. */
  {
    const tennisReq = () => net.calls.filter((c) => /\/v4\/sports\/tennis_[^/]*\/(odds|events)/.test(c.url));
    chk('26 · the default auto prefixes no longer include tennis_', cfg0.autoPrefixes.indexOf('tennis_') < 0, cfg0.autoPrefixes);
    const explicit = M.defaultConfig((k) => (k === 'CAPTURE_AUTO_PREFIXES' ? 'tennis_,americanfootball_nfl' : undefined));
    chk('26 · a retired prefix set explicitly is dropped too', explicit.autoPrefixes.join() === 'americanfootball_nfl', explicit.autoPrefixes);

    net.db = () => res(200, [], { 'content-range': '*/0' });
    net.odds['americanfootball_nfl'] = okPack();
    net.odds['tennis_atp_us_open'] = okPack();
    net.calls.length = 0;
    ENV.CAPTURE_SPORTS = 'tennis_atp_us_open,americanfootball_nfl';
    let j = await (await M.handle(rq())).json();
    chk('26 · CAPTURE_SPORTS naming a tennis key requests no tennis odds', tennisReq().length === 0, tennisReq().map((c) => c.url));
    chk('26 · the supported sport still captures', j.priced > 0, j.priced);
    chk('26 · and the run reports the retired key it skipped', (j.retired_sports_skipped || []).indexOf('tennis_atp_us_open') >= 0, j.retired_sports_skipped);

    net.calls.length = 0;
    ENV.CAPTURE_SPORTS = '';
    net.sports = ['americanfootball_nfl', 'tennis_wta_guadalajara_open'];
    j = await (await M.handle(rq())).json();
    chk('26 · an empty CAPTURE_SPORTS (capture everything active) still requests no tennis odds', tennisReq().length === 0, tennisReq().map((c) => c.url));
    chk('26 · while the rest of the discovered board captures', j.priced > 0, j.priced);

    net.calls.length = 0;
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
    ENV.CAPTURE_AUTO_PREFIXES = 'tennis_';
    j = await (await M.handle(rq())).json();
    chk('26 · a stale CAPTURE_AUTO_PREFIXES=tennis_ secret adds no tennis key', tennisReq().length === 0 && (j.auto_added || []).length === 0, j.auto_added);

    net.calls.length = 0;
    ENV.CAPTURE_SPORTS = 'tennis_atp_us_open';
    ENV.CAPTURE_AUTO_PREFIXES = '';
    j = await (await M.handle(rq())).json();
    chk('26 · a board of only retired sports makes no odds request at all',
      net.calls.filter((c) => /\/odds/.test(c.url)).length === 0, net.calls.map((c) => c.url));
    chk('26 · and says so rather than reporting an ok run', j.ok === false && /retired/.test(j.reason || ''), j.reason);

    net.sports = ['americanfootball_nfl'];
    delete net.odds['tennis_atp_us_open'];
    ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
  }

  /* The freeze counts rows the database actually froze. */
  {
    net.odds['americanfootball_nfl'] = okPack();
    let patches = 0;
    net.db = (u, method, init) => {
      if (method === 'POST' && /signals/.test(u)) {
        const body = JSON.parse(init.body);
        return res(200, body.map((r) => ({ sig_key: r.sig_key })), { 'content-range': '*/' + body.length });
      }
      if (method === 'PATCH') {
        patches++;
        /* The guard is `flagged_at=is.null`. An already-flagged row matches
           NOTHING and still returns 200 — which is exactly what v8 counted as a
           frozen signal. */
        return res(200, [], { 'content-range': '*/0' });
      }
      if (method === 'GET' && /qual_streak/.test(u)) {
        return res(200, [{ sig_key: 'evt-1|spreads|Chiefs|-3.5', qual_streak: 5 }], { 'content-range': '*/1' });
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    const j = await (await M.handle(rq())).json();
    chk('a PATCH that matched no row is not counted as a frozen signal',
      patches > 0 && j.flag_frozen === 0, [patches, j.flag_frozen]);
    chk('prior persistence state is read so a confirmed candidate can act',
      j.funnel.actionable > 0, j.funnel);

    /* And when the database says it froze rows, they are counted. */
    net.db = (u, method, init) => {
      if (method === 'POST' && /signals/.test(u)) {
        const body = JSON.parse(init.body);
        return res(200, body.map((r) => ({ sig_key: r.sig_key })), { 'content-range': '*/' + body.length });
      }
      if (method === 'PATCH') return res(200, [{ sig_key: 'x' }], { 'content-range': '*/1' });
      if (method === 'GET' && /qual_streak/.test(u)) {
        return res(200, [{ sig_key: 'evt-1|spreads|Chiefs|-3.5', qual_streak: 5 }], { 'content-range': '*/1' });
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    const j2 = await (await M.handle(rq())).json();
    chk('a PATCH that returned a row IS counted', j2.flag_frozen === 1, j2.flag_frozen);
  }

  /* Phase A failing must not let phase B insert a row with no opening snapshot. */
  {
    net.odds['americanfootball_nfl'] = okPack();
    const posted = [];
    net.db = (u, method, init) => {
      if (method === 'POST' && /signals/.test(u)) {
        const body = JSON.parse(init.body);
        posted.push(body);
        return res(500, 'phase A exploded');
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    await M.handle(rq());
    chk('when phase A fails, phase B never inserts a row without its opening columns',
      posted.every((b) => b.every((r) => r.first_seen_at !== undefined)), posted.length);

    /* And it does not pay for that safety with a round trip per chunk. Phase A
       is an ignore-duplicates upsert: a chunk that returns without an error
       leaves every row in it present, so no confirming SELECT is needed — which
       matters because on every run after the first, phase A inserts nothing and
       a naive implementation would read the whole board back. */
    const gets = [];
    net.db = (u, method, init) => {
      if (method === 'GET') gets.push(u);
      if (method === 'POST' && /signals/.test(u)) {
        const body = JSON.parse(init.body);
        return res(200, [], { 'content-range': '*/0' });   // everything already existed
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    await M.handle(rq());
    chk('a steady-state run does not read the board back to verify its own writes',
      gets.filter((u) => /select=sig_key&sig_key=in/.test(u)).length === 0, gets.length);
  }

  /* The schema-gap fallback: deploy order must not take the board down. */
  {
    net.odds['americanfootball_nfl'] = okPack();
    let sawQual = true;
    net.db = (u, method, init) => {
      if (method === 'POST' && /signals/.test(u)) {
        const body = JSON.parse(init.body);
        if (body.some((r) => 'quality_score' in r)) {
          return res(400, JSON.stringify({ message: "Could not find the 'quality_score' column of 'signals' in the schema cache" }));
        }
        sawQual = false;
        return res(200, body.map((r) => ({ sig_key: r.sig_key })), { 'content-range': '*/' + body.length });
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    const j = await (await M.handle(rq())).json();
    chk('a column the database lacks is dropped, and the rest is still written',
      sawQual === false && j.new_signals > 0, [sawQual, j.new_signals]);
    chk('and the missing column is named loudly rather than failing silently',
      (j.schema_gaps || []).indexOf('quality_score') >= 0 && /capture_v9_qualification.sql/.test(j.schema_warning || ''),
      j.schema_gaps);
  }

  /* The reference warning fires when the configured sharp book never appears. */
  {
    net.odds['americanfootball_nfl'] = okPack();
    net.db = () => res(200, [], { 'content-range': '*/0' });
    const j = await (await M.handle(rq())).json();
    chk('a run with no reference book present says so, in words that name the fix',
      j.reference_present === false && /'us' region/.test(j.reference_warning), j.reference_warning);
    chk('the funnel is monotonically non-increasing',
      j.funnel.stages.every((s, i, a) => i === 0 || s.passed <= a[i - 1].passed), j.funnel.stages);
    chk('the run echoes the policy that produced its decisions',
      !!j.policy_in_force && j.policy === M.POLICY_VERSION);
    chk('quota spend for the run is reported, not just the remaining balance',
      j.quota_spent_this_run > 0 && j.quota_remaining === '4321', [j.quota_spent_this_run, j.quota_remaining]);
  }

  /* =====================================================================
     CADENCE. Capture was never scheduled -- not in pg_cron, not in GitHub
     Actions -- which is how a customer came to be shown a price captured
     2,345 minutes earlier. These assert the schedule exists, that it says
     the same thing in all three places it is written, and that a run reports
     honestly which reader rungs its own cadence cannot keep.
     ===================================================================== */
  {
    const fs = require('fs');
    const ROOT = path.join(__dirname, '..', '..');

    /* --- a tier narrows the window and says which one it was ------------- */
    net.odds['americanfootball_nfl'] = okPack();
    net.db = () => res(200, [], { 'content-range': '*/0' });
    const near = await (await M.handle(rq('?tier=near'))).json();
    chk('a tiered run says which tier produced it', near.cadence && near.cadence.tier === 'near', near.cadence);
    chk('and the tier set the window rather than the environment',
      near.cadence.near_hours === M.CADENCE_TIERS.near.nearHours
      && near.cadence.max_days_to_start === M.CADENCE_TIERS.near.maxDaysToStart, near.cadence);

    const board = await (await M.handle(rq('?tier=board'))).json();
    chk('the board tier skips no sport', board.cadence.near_hours === 0, board.cadence);
    chk('and carries the full horizon', board.cadence.max_days_to_start === 14, board.cadence);

    const bogus = await (await M.handle(rq('?tier=nonesuch'))).json();
    chk('an unknown tier degrades to the configured window rather than to one nobody chose',
      bogus.cadence.tier === null && bogus.cadence.max_days_to_start === 14, bogus.cadence);

    /* --- a run is honest about the rung it cannot keep -------------------- */
    chk('a ten-minute cadence admits it cannot keep the five-minute rung',
      near.cadence.reader_rungs.not_served.includes('imminent'), near.cadence.reader_rungs);
    chk('and names the rungs it does keep',
      near.cadence.reader_rungs.served.includes('close')
      && near.cadence.reader_rungs.served.includes('day'), near.cadence.reader_rungs);
    chk('and says so in words, with the cost of closing it',
      /five-minute|imminent/.test(near.cadence.reader_rungs.note)
      && /quota/.test(near.cadence.reader_rungs.note), near.cadence.reader_rungs.note);
    chk('the four-hour board tier keeps only the deepest rung',
      board.cadence.reader_rungs.served.join(',') === 'deep', board.cadence.reader_rungs);

    /* --- THE RUNGS ARE THE READER'S. Two copies, one policy. ------------- */
    {
      const intel = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'), 'utf8');
      const blk = /quote_ttl_buckets:\s*\[([\s\S]*?)\]/.exec(intel);
      chk('the reader publishes a quote-freshness ladder', !!blk);
      if (blk) {
        const rungs = [...blk[1].matchAll(/name:\s*'([a-z]+)'[^}]*?minutes:\s*(\d+)/g)]
          .map((m) => ({ name: m[1], minutes: Number(m[2]) }));
        chk('and capture mirrors it rung for rung, in the same order and the same minutes',
          JSON.stringify(rungs) === JSON.stringify(M.READER_RUNGS.map((r) => ({ name: r.name, minutes: r.minutes }))),
          [rungs, M.READER_RUNGS.map((r) => ({ name: r.name, minutes: r.minutes }))]);
      }
    }

    /* --- THE SCHEDULE EXISTS, and agrees with what the function claims ---- */
    {
      const sqlPath = path.join(ROOT, 'supabase', 'capture_cron.sql');
      chk('a capture schedule is committed', fs.existsSync(sqlPath));
      const sql = fs.readFileSync(sqlPath, 'utf8');

      /* cron -> minutes between runs, for the shapes this file uses. */
      const cadenceOf = (expr) => {
        const [min, hr] = expr.split(/\s+/);
        if (/^\*\/(\d+)$/.test(min) && hr === '*') return Number(/^\*\/(\d+)$/.exec(min)[1]);
        if (/^\d+(,\d+)+$/.test(min) && hr === '*') return 60 / min.split(',').length;
        if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hr)) return Number(/^\*\/(\d+)$/.exec(hr)[1]) * 60;
        if (/^\d+$/.test(min) && /^\d+(,\d+)+$/.test(hr)) return (24 / hr.split(',').length) * 60;
        return null;
      };

      for (const tier of Object.keys(M.CADENCE_TIERS)) {
        const m = new RegExp("cron\\.schedule\\('capture_" + tier + "',\\s*'([^']+)'").exec(sql);
        chk('the ' + tier + ' tier is actually scheduled', !!m, tier);
        if (!m) continue;
        const every = cadenceOf(m[1]);
        chk('the ' + tier + " tier's cron is a shape this contract can read", every != null, m[1]);
        chk('the ' + tier + ' tier runs on the cadence the function says it does',
          every === M.CADENCE_TIERS[tier].cadenceMin, [tier, m[1], every, M.CADENCE_TIERS[tier].cadenceMin]);
      }

      chk('the schedule sends the cron secret capture requires',
        /x-cron-secret/.test(sql), 'capture 401s every caller without it, its own scheduler included');
      chk('and refuses to send anything when a setting is missing, rather than producing a 401 that looks like a working schedule',
        /nothing was sent/.test(sql));
      chk('no credential is committed in the schedule itself',
        !/eyJ[A-Za-z0-9_-]{20,}/.test(sql) && !/service_role_key\s*=\s*'[^']+'/.test(sql));
    }

    /* --- THE BACKUP EXISTS and cannot pass while capturing nothing -------- */
    {
      const wf = path.join(ROOT, '.github', 'workflows', 'capture.yml');
      chk('a backup scheduler is committed', fs.existsSync(wf));
      const y = fs.readFileSync(wf, 'utf8');
      chk('the backup fails loudly when its secrets are missing rather than exiting green',
        /::error::missing Actions repository secret/.test(y) && /exit 1/.test(y));
      /* NAMING THE ONE THAT IS MISSING. This used to fail with "SB_URL and
         CAPTURE_CRON_SECRET are not both set", which sends an operator to
         audit two secrets when only one is absent — and on 2026-09-15 SB_URL
         was present (games-settle.yml reported the credential) while
         CAPTURE_CRON_SECRET was not, so the run said nothing useful. */
      chk('and names which secret is missing rather than listing both',
        /MISSING="\$MISSING SB_URL"/.test(y) && /MISSING="\$MISSING CAPTURE_CRON_SECRET"/.test(y));
      /* A missing Actions secret and a function deployed without CRON_SECRET
         look identical from here and have opposite fixes, so the preflight
         asks capture which one it is. The probe must carry no secret: capture
         401s before it reads a sport list, so this can never spend quota. */
      chk('and asks capture whether the FUNCTION is missing its secret too',
        /functions\/v1\/capture\?probe=1/.test(y) && /CRON_SECRET is not set on this function/.test(y));
      chk('and that preflight probe sends no cron secret of its own',
        (y.match(/-H "x-cron-secret:/g) || []).length === 1);
      chk('and fails when capture answers anything other than 200',
        /CODE" != "200"/.test(y));
      chk('the backup carries no odds key and no service role',
        !/ODDS_API_KEY/.test(y) && !/SB_SERVICE_ROLE/.test(y));
    }
  }

  /* ═══ PLAYER PROPS (v11) ════════════════════════════════════════════════
     The player lives in `description`; `name` is the side. Every test below
     is a way the game-market identity (event|market|selection|point) would
     have merged two humans, or the game pipeline would have been disturbed. */
  {
    const pbk = (key, markets, age) => ({
      key, title: key.toUpperCase(), last_update: AGO(age == null ? 60 : age),
      markets: markets.map((mk) => ({ key: mk.key, last_update: AGO(age == null ? 60 : age), outcomes: mk.outcomes })),
    });
    const ou = (player, point, over, under) => [
      { name: 'Over', description: player, price: over, point }, { name: 'Under', description: player, price: under, point }];
    const yn = (player, yes, no) => [{ name: 'Yes', description: player, price: yes }, { name: 'No', description: player, price: no }];
    const pev = (bookmakers, over) => ev(bookmakers, Object.assign({ id: 'evt-p' }, over || {}));
    const keyOf = (c) => c.market + '|' + (c.participant_key || '') + '|' + c.selection + '|' + (c.point == null ? '' : c.point);
    const priceP = (e, cfg) => { const r = M.priceEvent(e, cfg || cfg0, NOW); const m = {}; r.candidates.forEach((c) => { m[keyOf(c)] = c; }); return { r, m }; };
    const iso = new Date(NOW).toISOString();
    const v9Key = (o) => `${o.event_id}|${o.market}|${o.selection}|${o.point ?? ''}`;

    /* ── the market lists are exactly the provider's, nothing invented ───── */
    const STANDARD = ['player_assists', 'player_defensive_interceptions', 'player_field_goals', 'player_kicking_points',
      'player_pass_attempts', 'player_pass_completions', 'player_pass_interceptions', 'player_pass_longest_completion',
      'player_pass_rush_yds', 'player_pass_rush_reception_tds', 'player_pass_rush_reception_yds', 'player_pass_tds',
      'player_pass_yds', 'player_pass_yds_q1', 'player_pats', 'player_receptions', 'player_reception_longest',
      'player_reception_tds', 'player_reception_yds', 'player_rush_attempts', 'player_rush_longest',
      'player_rush_reception_tds', 'player_rush_reception_yds', 'player_rush_tds', 'player_rush_yds', 'player_sacks',
      'player_solo_tackles', 'player_tackles_assists', 'player_tds', 'player_tds_over', 'player_1st_td',
      'player_anytime_td', 'player_last_td'];
    const ALT = ['player_assists', 'player_field_goals', 'player_kicking_points', 'player_pass_attempts',
      'player_pass_completions', 'player_pass_interceptions', 'player_pass_longest_completion', 'player_pass_rush_yds',
      'player_pass_rush_reception_tds', 'player_pass_rush_reception_yds', 'player_pass_tds', 'player_pass_yds', 'player_pats',
      'player_receptions', 'player_reception_longest', 'player_reception_tds', 'player_reception_yds', 'player_rush_attempts',
      'player_rush_longest', 'player_rush_reception_tds', 'player_rush_reception_yds', 'player_rush_tds', 'player_rush_yds',
      'player_sacks', 'player_solo_tackles', 'player_tackles_assists'].map((k) => k + '_alternate');
    chk('props · the standard list is exactly the provider list (33 keys)',
      JSON.stringify(M.PLAYER_PROP_MARKETS) === JSON.stringify(STANDARD) && JSON.stringify(cfg0.playerPropMarkets) === JSON.stringify(STANDARD));
    chk('props · the alternate list is exactly the provider list (26 keys)',
      JSON.stringify(M.PLAYER_PROP_ALT_MARKETS) === JSON.stringify(ALT) && JSON.stringify(cfg0.playerPropAlternateMarkets) === JSON.stringify(ALT));
    chk('props · every alternate has its standard market in the standard list',
      ALT.every((k) => STANDARD.includes(M.playerPropBaseMarket(k))));
    chk('props · defaults: on, 30 h / 3 h windows, 80 events, 4 at a time, prop signals OFF',
      cfg0.playerProps === true && cfg0.playerPropMaxHours === 30 && cfg0.playerPropNearHours === 3
      && cfg0.playerPropMaxEvents === 80 && cfg0.playerPropConcurrency === 4 && cfg0.playerPropSignals === false);
    chk('props · "none" empties a list; overrides keep only player keys of the right kind',
      M.propMarketList('none', STANDARD, false).length === 0
      && JSON.stringify(M.propMarketList('player_rush_yds, spreads,player_rush_yds, player_rush_yds_alternate', STANDARD, false)) === '["player_rush_yds"]'
      && JSON.stringify(M.propMarketList('player_rush_yds_alternate,player_rush_yds', ALT, true)) === '["player_rush_yds_alternate"]');
    const cm = M.defaultConfig((k) => (k === 'CAPTURE_MARKETS' ? 'h2h,spreads,player_pass_yds,totals' : undefined));
    chk('props · a player market in CAPTURE_MARKETS is removed from the featured request, and named',
      cm.markets === 'h2h,spreads,totals' && JSON.stringify(cm.marketsIgnored) === '["player_pass_yds"]', [cm.markets, cm.marketsIgnored]);
    chk('props · the featured market string is untouched when it names no player market',
      cfg0.markets === 'h2h,spreads,totals' && cfg0.marketsIgnored.length === 0);
    chk('props · tennis is no longer auto-captured by default: NFL and NCAAF only',
      JSON.stringify(M.defaultConfig(() => undefined).autoPrefixes) === '["americanfootball_nfl","americanfootball_ncaaf"]');

    /* ── market helpers ─────────────────────────────────────────────────── */
    chk('props · isPlayerPropMarket', M.isPlayerPropMarket('player_pass_yds') && M.isPlayerPropMarket('player_pass_yds_alternate')
      && !M.isPlayerPropMarket('spreads') && !M.isPlayerPropMarket('alternate_spreads') && !M.isPlayerPropMarket('h2h'));
    chk('props · an alternate player ladder files under its base market',
      M.playerPropBaseMarket('player_rush_yds_alternate') === 'player_rush_yds'
      && M.canonicalMarket('player_reception_yds_alternate') === 'player_reception_yds'
      && M.canonicalMarket('player_pass_yds') === 'player_pass_yds');
    chk('props · canonicalMarket keeps the v10 game mapping exactly',
      M.canonicalMarket('alternate_spreads') === 'spreads' && M.canonicalMarket('alternate_totals') === 'totals'
      && M.canonicalMarket('h2h') === 'h2h' && M.canonicalMarket('spreads') === 'spreads' && M.canonicalMarket('totals') === 'totals');
    chk('props · every player market is one policy family; game markets are their own',
      M.marketPolicyFamily('player_pass_yds_alternate') === 'player_props' && M.marketPolicyFamily('player_anytime_td') === 'player_props'
      && M.marketPolicyFamily('spreads') === 'spreads' && M.marketPolicyFamily('alternate_totals') === 'totals');
    chk('props · qualification understands game markets and two-sided Over/Under props only',
      M.marketUnderstoodForQualification('h2h') && M.marketUnderstoodForQualification('player_pass_yds', 'Over')
      && M.marketUnderstoodForQualification('player_pass_yds', 'under')
      && !M.marketUnderstoodForQualification('player_anytime_td', 'Yes')
      && !M.marketUnderstoodForQualification('player_pass_yds', 'Yes')
      && !M.marketUnderstoodForQualification('player_pass_yds_alternate', 'Over')
      && !M.marketUnderstoodForQualification('player_made_up'.replace('made_up', '1st_td'), 'Yes'));

    /* ── player identity ────────────────────────────────────────────────── */
    chk('props · punctuation that never separates two people is folded',
      M.playerKey('A.J. Brown') === 'aj brown' && M.playerKey('AJ Brown') === 'aj brown' && M.playerKey('  a.j.   BROWN ') === 'aj brown');
    chk('props · accents and apostrophes fold; hyphens stay',
      M.playerKey('José Ramírez') === 'jose ramirez' && M.playerKey("Ja'Marr Chase") === 'jamarr chase'
      && M.playerKey('Ja’Marr Chase') === 'jamarr chase' && M.playerKey('Amon-Ra St. Brown') === 'amon-ra st brown');
    chk('props · a suffix is KEPT: father and son are never merged',
      M.playerKey('Michael Pittman Jr.') === 'michael pittman jr' && M.playerKey('Michael Pittman Jr.') !== M.playerKey('Michael Pittman')
      && M.playerKey('Marvin Harrison Jr.') !== M.playerKey('Marvin Harrison Sr.'));
    chk('props · a key can never carry the sig_key separator', !/\|/.test(M.playerKey('A | B')) && M.playerKey('A | B') === 'a b');
    chk('props · a non-Latin name keeps its letters rather than collapsing to nothing',
      M.playerKey('Дмитрий Иванов') === 'дмитрии иванов' && M.playerKey('Дмитрий Иванов') !== M.playerKey('Иван Дмитриев'));
    chk('props · the display name keeps what the book wrote', M.playerDisplayName('  Patrick   Mahomes ') === 'Patrick Mahomes');

    /* ── 28 · game-market sig_keys are byte-for-byte what they were ────────── */
    chk('28 · a spread sig_key is the v9 string', M.sigKey({ event_id: 'E', market: 'spreads', selection: 'Chiefs', point: -3.5 }) === 'E|spreads|Chiefs|-3.5');
    chk('28 · a total sig_key is the v9 string', M.sigKey({ event_id: 'E', market: 'totals', selection: 'Over', point: 47.5 }) === 'E|totals|Over|47.5');
    chk('28 · a moneyline sig_key keeps its load-bearing trailing pipe', M.sigKey({ event_id: 'E', market: 'h2h', selection: 'Chiefs', point: null }) === 'E|h2h|Chiefs|');
    chk('28 · a stray participant on a game object changes nothing',
      M.sigKey({ event_id: 'E', market: 'spreads', selection: 'Chiefs', point: -3.5, participant_key: 'x' }) === 'E|spreads|Chiefs|-3.5');
    {
      const nfl = ev([
        bk('draftkings', spread(1.91, 1.91)), bk('fanduel', spread(1.92, 1.90)),
        { key: 'betmgm', title: 'BetMGM', last_update: AGO(60), markets: [
          { key: 'h2h', last_update: AGO(60), outcomes: [{ name: 'Chiefs', price: 1.60 }, { name: 'Ravens', price: 2.45 }] },
          { key: 'totals', last_update: AGO(60), outcomes: [{ name: 'Over', price: 1.91, point: 47.5 }, { name: 'Under', price: 1.91, point: 47.5 }] }] },
      ]);
      const cfb = ev([bk('draftkings', spread(1.91, 1.91, -7)), bk('fanduel', spread(1.90, 1.92, -7))],
        { id: 'cfb-1', sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF', home_team: 'Chiefs', away_team: 'Ravens' });
      const all = M.priceEvent(nfl, cfg0, NOW).candidates.concat(M.priceEvent(cfb, cfg0, NOW).candidates);
      chk('28 · NFL and NCAAF spread, total and moneyline keys all equal the v9 template',
        all.length === 8 && all.every((c) => M.sigKey(c) === v9Key(c)), all.map((c) => [M.sigKey(c), v9Key(c)]));
      chk('28 · a game candidate names no player', all.every((c) => c.participant === null && c.participant_key === null && c.is_player_prop === false));
      const gv = q(all[0]);
      const gr = M.signalRow(all[0], gv, iso);
      chk('28 · a game signals row keeps exactly its v9 columns (no player column is sent)',
        !('participant' in gr) && !('participant_key' in gr) && !('is_player_prop' in gr) && !('source_market' in gr));
      chk('28 · and records no player quote', M.playerPropQuoteRows(all[0], iso).length === 0);

      /* v10 alternate spreads, merged before pricing */
      const merged = M.mergeEventOdds(nfl, { id: 'evt-1', bookmakers: [{ key: 'draftkings', title: 'DK', last_update: AGO(30), markets: [
        { key: 'alternate_spreads', outcomes: [{ name: 'Chiefs', price: 2.30, point: -7.5 }, { name: 'Ravens', price: 1.65, point: 7.5 },
                                               { name: 'Chiefs', price: 1.80, point: -3.5 }, { name: 'Ravens', price: 2.00, point: 3.5 }] }] }] });
      const am = {}; M.priceEvent(merged, cfg0, NOW).candidates.forEach((c) => { am[M.sigKey(c)] = c; });
      chk('28 · an alternate spread lands under `spreads` with its own point', !!am['evt-1|spreads|Chiefs|-7.5'] && am['evt-1|spreads|Chiefs|-7.5'].quotes[0].sourceMarket === 'alternate_spreads');
      chk('28 · a ladder repeating the featured number keeps the featured quote',
        am['evt-1|spreads|Chiefs|-3.5'].quotes.find((x) => x.book === 'draftkings').dec === 1.91
        && am['evt-1|spreads|Chiefs|-3.5'].quotes.find((x) => x.book === 'draftkings').sourceMarket === 'spreads');
      chk('28 · a response for another event is never merged in', M.mergeEventOdds(nfl, { id: 'other', bookmakers: [{ key: 'x', markets: [] }] }) === nfl);
    }

    /* ── 22 · two players, one book, the same line ─────────────────────────── */
    {
      const { r, m } = priceP(pev([pbk('draftkings', [{ key: 'player_pass_yds',
        outcomes: ou('Patrick Mahomes', 274.5, 1.91, 1.91).concat(ou('Josh Allen', 274.5, 1.95, 1.87)) }])]));
      const mo = m['player_pass_yds|patrick mahomes|Over|274.5'], ao = m['player_pass_yds|josh allen|Over|274.5'];
      chk('22 · Mahomes and Allen at 274.5 from one book are FOUR candidates, none malformed',
        r.candidates.length === 4 && r.malformed === 0 && !!mo && !!ao && !!m['player_pass_yds|patrick mahomes|Under|274.5'] && !!m['player_pass_yds|josh allen|Under|274.5'],
        Object.keys(m));
      chk('22 · each player is devigged as his own two-way market, never one four-way one',
        Math.abs(mo.quotes[0].fair - 0.5) < 1e-9 && ao.quotes[0].fair > 0.47 && ao.quotes[0].fair < 0.5
        && Math.abs(ao.quotes[0].fair + m['player_pass_yds|josh allen|Under|274.5'].quotes[0].fair - 1) < 1e-9,
        [mo.quotes[0].fair, ao.quotes[0].fair]);
      chk('22 · each Over pairs with its own player\'s Under', mo.quotes[0].oppDec === 1.91 && ao.quotes[0].oppDec === 1.87);
      const keys = r.candidates.map(M.sigKey);
      chk('22 · four distinct sig_keys, each naming its player', new Set(keys).size === 4, keys);
      chk('22 · the key is event|market|player|side|point', M.sigKey(mo) === 'evt-p|player_pass_yds|patrick mahomes|Over|274.5', M.sigKey(mo));
      chk('22 · the candidate carries the player as written and as keyed',
        mo.participant === 'Patrick Mahomes' && mo.participant_key === 'patrick mahomes' && mo.is_player_prop === true && mo.is_two_sided === true);
      const rows = r.candidates.flatMap((c) => M.playerPropQuoteRows(c, iso));
      chk('22 · four player quotes, four quote keys', rows.length === 4 && new Set(rows.map((x) => x.quote_key)).size === 4);
      chk('22 · partitionOutcomes, given the market, splits by player', M.partitionOutcomes(
        ou('A', 1.5, 1.9, 1.9).concat(ou('B', 1.5, 1.9, 1.9)), 'player_receptions').filter((x) => x.ok).length === 2);
      chk('22 · the v9 call shape (no market) still pairs a game market on |point|',
        M.partitionOutcomes(spread(1.9, 1.9)).length === 1 && M.partitionOutcomes(spread(1.9, 1.9))[0].ok === true);
    }

    /* ── 23 · different lines are different bets ────────────────────────── */
    {
      const { r, m } = priceP(pev([
        pbk('draftkings', [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.91, 1.91) }]),
        pbk('fanduel', [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 275.5, 2.10, 1.75) }]),
      ]));
      const a = m['player_pass_yds|patrick mahomes|Over|274.5'], b = m['player_pass_yds|patrick mahomes|Over|275.5'];
      chk('23 · 274.5 and 275.5 are separate candidates', r.candidates.length === 4 && !!a && !!b);
      chk('23 · the 274.5 candidate never sees the 275.5 book, and vice versa',
        a.quotes.every((x) => x.book === 'draftkings') && b.quotes.every((x) => x.book === 'fanduel'));
      const va = q(a);
      chk('23 · so the 274.5 price is never compared with a 275.5 fair',
        Math.abs(va.consensus_fair - a.quotes[0].fair) < 1e-12 && va.actionable === false, [va.consensus_fair, va.reason]);
      chk('23 · the census sees both lines for the player', a.points_offered === 2 && b.points_offered === 2);
    }

    /* ── 24 · one player, two books, one bet ─────────────────────────────── */
    {
      const { r, m } = priceP(pev([
        pbk('draftkings', [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.909, 1.909) }]),
        pbk('fanduel', [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.952, 1.87) }]),
      ]));
      const o = m['player_pass_yds|patrick mahomes|Over|274.5'];
      chk('24 · one candidate per player/market/side/point with both books on it',
        r.candidates.length === 2 && o.quotes.length === 2 && o.quotes.map((x) => x.book).sort().join() === 'draftkings,fanduel');
      chk('24 · the best price is found across the two books', q(o).best_dec === 1.952);
    }

    /* ── 25 · alternate player ladders ────────────────────────────────────── */
    {
      const ladder = [
        { name: 'Over', description: 'Patrick Mahomes', price: 1.40, point: 250.5 },
        { name: 'Over', description: 'Patrick Mahomes', price: 1.95, point: 275.5 },
        { name: 'Over', description: 'Patrick Mahomes', price: 2.90, point: 299.5 },
        { name: 'Over', description: 'Patrick Mahomes', price: 1.80, point: 274.5 },
      ];
      for (const order of ['featured-first', 'ladder-first']) {
        const mk = [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.91, 1.91) }, { key: 'player_pass_yds_alternate', outcomes: ladder }];
        const { r, m } = priceP(pev([pbk('draftkings', order === 'featured-first' ? mk : mk.slice().reverse())]));
        const overs = r.candidates.filter((c) => c.selection === 'Over');
        chk('25 · [' + order + '] every quote files under the base market player_pass_yds',
          r.candidates.every((c) => c.market === 'player_pass_yds'), r.candidates.map((c) => c.market));
        chk('25 · [' + order + '] four distinct Over points: 250.5, 274.5, 275.5, 299.5',
          JSON.stringify(overs.map((c) => c.point).sort((x, y) => x - y)) === '[250.5,274.5,275.5,299.5]');
        const main = m['player_pass_yds|patrick mahomes|Over|274.5'].quotes[0];
        chk('25 · [' + order + '] the ladder repeating 274.5 does not replace the standard quote',
          main.sourceMarket === 'player_pass_yds' && main.dec === 1.91 && main.fair != null && r.duplicateQuotes === 1, [main, r.duplicateQuotes]);
        chk('25 · [' + order + '] each ladder rung keeps its alternate source',
          ['250.5', '275.5', '299.5'].every((pt) => m['player_pass_yds|patrick mahomes|Over|' + pt].quotes[0].sourceMarket === 'player_pass_yds_alternate'));
        chk('25 · [' + order + '] a one-sided rung is kept, with no fair value',
          m['player_pass_yds|patrick mahomes|Over|299.5'].quotes[0].fair === null && m['player_pass_yds|patrick mahomes|Over|299.5'].is_two_sided === false);
      }
      const { r } = priceP(pev([pbk('draftkings', [{ key: 'player_pass_yds_alternate', outcomes: ladder.slice(0, 3) }])]));
      const rows = r.candidates.flatMap((c) => M.playerPropQuoteRows(c, iso));
      chk('25 · stored rows say standard or alternate, per quote',
        rows.length === 3 && rows.every((x) => x.market === 'player_pass_yds' && x.source_market === 'player_pass_yds_alternate'));
    }

    /* ── 26 · Yes / No, per player ────────────────────────────────────────── */
    {
      const { r, m } = priceP(pev([pbk('draftkings', [{ key: 'player_anytime_td', outcomes: yn('Travis Kelce', 2.10, 1.70).concat(yn('Isiah Pacheco', 3.50, 1.28)) }])]));
      const ky = m['player_anytime_td|travis kelce|Yes|'], kn = m['player_anytime_td|travis kelce|No|'];
      const py = m['player_anytime_td|isiah pacheco|Yes|'], pn = m['player_anytime_td|isiah pacheco|No|'];
      chk('26 · two scorers are four candidates', r.candidates.length === 4 && ky && kn && py && pn);
      chk('26 · each player\'s Yes/No devigs to 1 on its own — the TD scorers are never one probability space',
        Math.abs(ky.quotes[0].fair + kn.quotes[0].fair - 1) < 1e-9 && Math.abs(py.quotes[0].fair + pn.quotes[0].fair - 1) < 1e-9
        && ky.quotes[0].fair > 0.4 && py.quotes[0].fair > 0.2, [ky.quotes[0].fair, py.quotes[0].fair]);
      chk('26 · the no-point key ends in a pipe, like a moneyline', M.sigKey(ky) === 'evt-p|player_anytime_td|travis kelce|Yes|');
      const blank = M.priceEvent(pev([pbk('draftkings', [{ key: 'player_anytime_td', outcomes: [
        { name: 'Yes', description: 'Travis Kelce', price: 2.10, point: '' }, { name: 'No', description: 'Travis Kelce', price: 1.70, point: '' }] }])]), cfg0, NOW);
      chk('26 · an empty point is no line — never a line of 0', blank.candidates.length === 2 && blank.candidates.every((c) => c.point === null), blank.candidates.map((c) => c.point));
      const v = q(ky);
      chk('26 · a scorer market is captured but not yet qualified', v.actionable === false && v.reason === 'prop_market_not_yet_qualifiable', v.reason);
      chk('26 · and its stored quote says why', M.playerPropQuoteRows(ky, iso)[0].unqualifiable_reason === 'prop_market_not_yet_qualifiable'
        && M.playerPropQuoteRows(ky, iso)[0].qualifiable === false && M.playerPropQuoteRows(ky, iso)[0].is_two_sided === true);
    }

    /* ── 27 · a one-sided market ──────────────────────────────────────────── */
    {
      const { r, m } = priceP(pev([pbk('draftkings', [{ key: 'player_tds_over', outcomes: [{ name: 'Over', description: 'Player A', price: 2.50, point: 0.5 }] }])]));
      const c = m['player_tds_over|player a|Over|0.5'];
      chk('27 · the raw quote is captured', r.candidates.length === 1 && !!c && c.quotes[0].dec === 2.5 && r.malformed === 0 && r.oneSidedQuotes === 1);
      chk('27 · no Under is invented', !r.candidates.some((x) => x.selection === 'Under'));
      chk('27 · no fair value is invented', c.quotes[0].fair === null && c.quotes[0].oppDec === null && c.is_two_sided === false);
      const v = q(c, cfg0, 9);
      chk('27 · it is never actionable, and says exactly why',
        v.actionable === false && v.reason === 'one_sided_player_market' && v.fair_probability === null && v.edge === null, v);
      const row = M.playerPropQuoteRows(c, iso)[0];
      chk('27 · stored with is_two_sided false, no fair, not qualifiable, with the reason',
        row.is_two_sided === false && row.book_fair_probability === null && row.opposite_decimal_odds === null
        && row.qualifiable === false && row.unqualifiable_reason === 'one_sided_player_market');
      chk('27 · the one-sided reason is mapped in the funnel', M.stagesPassed('one_sided_player_market') === 0 && 'one_sided_player_market' in M.STAGE_OF_REASON);
      /* A one-sided book beside two-sided ones contributes nothing to the fair. */
      const mix = priceP(pev([
        pbk('draftkings', [{ key: 'player_receptions', outcomes: ou('Player B', 4.5, 1.91, 1.91) }]),
        pbk('fanduel', [{ key: 'player_receptions', outcomes: [{ name: 'Over', description: 'Player B', price: 3.00, point: 4.5 }] }]),
      ]));
      const mc = mix.m['player_receptions|player b|Over|4.5'];
      const mv = q(mc);
      chk('27 · a one-sided quote beside a two-sided one never enters the consensus or the best price',
        mc.quotes.length === 2 && mc.is_two_sided === true && mv.total_books === 1 && mv.best_book === 'draftkings'
        && Math.abs(mv.consensus_fair - 0.5) < 1e-9, [mv.total_books, mv.best_book, mv.consensus_fair]);
    }

    /* ── the census is per player ────────────────────────────────────────── */
    {
      const { m } = priceP(pev(['draftkings', 'fanduel', 'betmgm'].map((b) => pbk(b, [{ key: 'player_pass_yds',
        outcomes: ou('Patrick Mahomes', 274.5, 1.91, 1.91).concat(ou('Josh Allen', b === 'draftkings' ? 250.5 : 251.5, 1.91, 1.91)) }]))));
      const mo = m['player_pass_yds|patrick mahomes|Over|274.5'], a1 = m['player_pass_yds|josh allen|Over|250.5'];
      chk('census · Mahomes\' modal line is his own, untouched by Allen\'s', mo.modal_point === 274.5 && mo.points_offered === 1 && mo.books_at_modal === 3);
      chk('census · Allen\'s minority line is visible as a minority line', a1.modal_point === 251.5 && a1.points_offered === 2 && a1.point_is_modal !== true);
      chk('census · a player line reports no football key numbers', q(a1).key_numbers_to_modal.length === 0);
    }

    /* ── malformed player outcomes are refused, not guessed ─────────────── */
    {
      const bad = (outcomes) => M.priceEvent(pev([pbk('draftkings', [{ key: 'player_pass_yds', outcomes }])]), cfg0, NOW);
      const noPlayer = bad([{ name: 'Over', price: 1.9, point: 274.5 }, { name: 'Under', price: 1.9, point: 274.5 }]);
      chk('malformed · a player outcome with no player is refused', noPlayer.candidates.length === 0 && noPlayer.malformed === 2);
      const noLine = bad([{ name: 'Over', description: 'X', price: 1.9 }, { name: 'Under', description: 'X', price: 1.9 }]);
      chk('malformed · an Over/Under with no line is refused', noLine.candidates.length === 0 && noLine.malformed === 2);
      const garbled = bad([{ name: 'Over', description: 'X', price: 1.9, point: 'abc' }]);
      chk('malformed · a line that is not a number is refused', garbled.candidates.length === 0 && garbled.malformed === 1);
      const dup = bad([{ name: 'Over', description: 'X', price: 1.9, point: 4.5 }, { name: 'Over', description: 'X', price: 2.2, point: 4.5 },
        { name: 'Under', description: 'X', price: 1.9, point: 4.5 }]);
      chk('malformed · a side repeated for one player and line is a duplicate, first wins',
        dup.duplicateQuotes === 1 && dup.candidates.find((c) => c.selection === 'Over').quotes[0].dec === 1.9);
      const price = bad([{ name: 'Over', description: 'X', price: 'n/a', point: 4.5 }, { name: 'Under', description: 'X', price: 1.9, point: 4.5 }]);
      chk('malformed · a non-numeric price refuses that player line', price.candidates.length === 0 && price.malformed === 1);
    }

    /* ── 12 · no prop inherits a game-line edge floor ─────────────────────── */
    {
      const five = (market, outcomesFor) => pev(['draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers'].map((b) => pbk(b, [{ key: market, outcomes: outcomesFor(b) }])));
      const { m } = priceP(five('player_receptions', (b) => (b === 'betrivers' ? ou('Player C', 4.5, 2.02, 1.83) : ou('Player C', 4.5, 1.87, 1.95))));
      const c = m['player_receptions|player c|Over|4.5'];
      const v = q(c, cfg0, 5);
      chk('12 · the same numbers that make a spread actionable leave a prop at PASS',
        v.actionable === false && v.reason === 'segment_not_qualified_for_action' && v.edge > 0.025 && v.edge_floor === null, [v.reason, v.edge]);
      const noRows = cfgWith({ edgeFloor: Object.fromEntries(Object.entries(cfg0.edgeFloor).filter(([k]) => !/player_props/.test(k))) });
      chk('12 · even with the player_props rows deleted, a prop never falls through to `*|*`',
        q(c, noRows, 5).reason === 'segment_not_qualified_for_action' && noRows.edgeFloor['*|*|B'] === 0.035);
      const floored = cfgWith({ edgeFloor: Object.assign({}, cfg0.edgeFloor, { '*|player_props|B': 0.02 }) });
      const fv = q(c, floored, 5);
      chk('12 · a player_props floor, once evidence sets one, is the only thing that changes',
        fv.actionable === true && fv.segment === 'nfl|player_receptions|B', [fv.reason, fv.segment]);
    }

    /* ── 31 · fifty players, every identity preserved ─────────────────────── */
    {
      const players = Array.from({ length: 50 }, (_, i) => ['Player', String.fromCharCode(65 + (i % 26)), 'Number' + i].join(' '));
      const books = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers'];
      const e50 = (id) => pev(books.map((b) => pbk(b, [{ key: 'player_receptions',
        outcomes: players.flatMap((p, i) => ou(p, 2.5 + (i % 5), 1.91, 1.91)) }])), { id });
      const r = M.priceEvent(e50('evt-50'), cfg0, NOW);
      const keys = new Set(r.candidates.map((c) => c.participant_key));
      chk('31 · 50 players x Over/Under = 100 candidates, 50 distinct identities',
        r.candidates.length === 100 && keys.size === 50 && r.malformed === 0, [r.candidates.length, keys.size, r.malformed]);
      chk('31 · every player line has all five books on it', r.candidates.every((c) => c.quotes.length === 5));
      const rows = r.candidates.flatMap((c) => M.playerPropQuoteRows(c, iso));
      chk('31 · 500 quotes, 500 distinct quote keys', rows.length === 500 && new Set(rows.map((x) => x.quote_key)).size === 500);
      const complete = rows.every((x) => x.player_name && x.player_key && x.market === 'player_receptions'
        && (x.side === 'Over' || x.side === 'Under') && typeof x.point === 'number' && books.includes(x.book_key)
        && x.decimal_odds === 1.91 && x.source_updated_at && x.captured_at === iso && x.event_id === 'evt-50'
        && x.home_team && x.away_team && x.commence_time && x.source_market === 'player_receptions'
        && typeof x.is_fresh === 'boolean' && typeof x.quote_age_s === 'number');
      chk('31 · every quote answers who, what, side, line, where, price, when, game, source and freshness', complete, rows[0]);
      const two = M.priceEvent(e50('evt-51'), cfg0, NOW).candidates.flatMap((c) => M.playerPropQuoteRows(c, iso));
      chk('31 · the same names in another game are different quotes', two.every((x) => !rows.some((y) => y.quote_key === x.quote_key)));
      const sk = new Set(r.candidates.map(M.sigKey));
      chk('31 · and 100 distinct sig_keys', sk.size === 100);
    }

    /* ── windows, clocks and billing ─────────────────────────────────────── */
    {
      chk('16 · props by tier: BOARD none, DAY 30 h, NEAR 3 h, untiered = DAY',
        M.playerPropHoursForTier(cfg0, 'board') === 0 && M.playerPropHoursForTier(cfg0, 'day') === 30
        && M.playerPropHoursForTier(cfg0, 'near') === 3 && M.playerPropHoursForTier(cfg0, null) === 30);
      chk('16 · off, or with no markets, buys nothing', M.playerPropHoursForTier(cfgWith({ playerProps: false }), 'day') === 0
        && M.playerPropHoursForTier(cfgWith({ playerPropMarkets: [], playerPropAlternateMarkets: [] }), 'day') === 0);
      chk('v10 · alternate spreads by tier: BOARD none, DAY 30 h, NEAR 2 h',
        M.alternateHoursForTier(cfg0, 'board') === 0 && M.alternateHoursForTier(cfg0, 'day') === 30 && M.alternateHoursForTier(cfg0, 'near') === 2);
      const min = 60000;
      chk('clock · an event never polled is due', M.propEventDue(null, 10, cfg0, NOW));
      chk('clock · inside 3 h the 20-minute interval applies (with 2 minutes of drift)',
        !M.propEventDue(NOW - 10 * min, 2, cfg0, NOW) && M.propEventDue(NOW - 18 * min, 2, cfg0, NOW));
      chk('clock · beyond 3 h the 120-minute interval applies',
        !M.propEventDue(NOW - 60 * min, 10, cfg0, NOW) && M.propEventDue(NOW - 118 * min, 10, cfg0, NOW));
      chk('billing · us,eu is two region-equivalents; ten bookmakers one; eleven two',
        M.regionEquivalents(cfg0) === 2 && M.regionEquivalents(cfgWith({ bookmakers: M.SUGGESTED_BOOKMAKERS })) === 1
        && M.regionEquivalents(cfgWith({ bookmakers: M.SUGGESTED_BOOKMAKERS.concat(['fanatics']) })) === 2);
      const batches = M.propMarketBatches(cfg0);
      chk('billing · 59 markets go out in batches of 12, standard first, none twice',
        batches.length === 5 && batches.flat().length === 59 && new Set(batches.flat()).size === 59 && batches[0][0] === 'player_assists');
    }

    /* ── THE HANDLER, with props ─────────────────────────────────────────── */
    const propBoard = {
      id: 'evt-1', sport_key: 'americanfootball_nfl', sport_title: 'NFL', commence_time: KICK, home_team: 'Chiefs', away_team: 'Ravens',
      bookmakers: [
        pbk('draftkings', [
          { key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.91, 1.91).concat(ou('Josh Allen', 274.5, 1.95, 1.87)) },
          { key: 'player_pass_yds_alternate', outcomes: [{ name: 'Over', description: 'Patrick Mahomes', price: 1.40, point: 250.5 }] },
          { key: 'player_anytime_td', outcomes: yn('Patrick Mahomes', 7.0, 1.08) },
          { key: 'player_tds_over', outcomes: [{ name: 'Over', description: 'Travis Kelce', price: 2.5, point: 0.5 }] },
        ]),
        pbk('fanduel', [{ key: 'player_pass_yds', outcomes: ou('Patrick Mahomes', 274.5, 1.95, 1.87) }]),
      ],
    };
    const writes = {};
    const propDb = (opts) => (u, method, init) => {
      const o = opts || {};
      const table = (/\/rest\/v1\/([a-z_]+)/.exec(u) || [])[1];
      if (method === 'GET' && table === 'player_prop_quotes' && o.storageMissing) return res(404, '{"code":"PGRST205","message":"Could not find the table public.player_prop_quotes"}');
      if (method === 'GET' && table === 'player_prop_event_polls') return res(200, o.polls || [], { 'content-range': '*/0' });
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        (writes[table] = writes[table] || []).push({ url: u, body });
        if (table === 'player_prop_quotes') return res(201, body.map((r) => ({ price_changed_at: o.unchanged ? '2020-01-01T00:00:00Z' : r.captured_at })), { 'content-range': '*/' + body.length });
        if (/select=sig_key/.test(u)) return res(201, body.map((r) => ({ sig_key: r.sig_key })), { 'content-range': '*/' + body.length });
        return res(201, '', { 'content-range': '*/' + body.length });
      }
      return res(200, [], { 'content-range': '*/0' });
    };
    const reset = () => { for (const k in writes) delete writes[k]; net.calls = []; net.eventFail = null; net.eventRemaining = null; };
    const propCalls = () => net.calls.filter((c) => /\/events\/[^/]+\/odds/.test(c.url) && /markets=player_/.test(c.url));
    net.odds['americanfootball_nfl'] = okPack();
    net.eventOdds['americanfootball_nfl'] = { 'evt-1': propBoard };
    /* The mocked account reports 4,321 credits left, under the default 5,000
       floor, so these runs set a lower floor; the floor has its own case below. */
    ENV.CAPTURE_PROP_MIN_QUOTA_REMAINING = '1000';

    /* A game-line run with props OFF, as the baseline game rows. */
    reset();
    ENV.CAPTURE_PLAYER_PROPS = 'false';
    net.db = propDb();
    let j = await (await M.handle(rq('?tier=day'))).json();
    const strip = (rows) => JSON.stringify(rows.map((r) => { const o = Object.assign({}, r); ['last_seen_at', 'first_seen_at'].forEach((k) => delete o[k]); return o; }));
    const baseline = strip((writes.signals || [])[0].body);
    chk('handler · props off: no player request, and the pass says it is disabled',
      propCalls().length === 0 && j.player_props.status === 'disabled');
    delete ENV.CAPTURE_PLAYER_PROPS;

    /* The same run with props ON (the default). */
    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    const P = j.player_props;
    chk('handler · the game-line rows are identical with props on and off', strip((writes.signals || [])[0].body) === baseline);
    chk('handler · no signals row carries a player market or a player column (prop signals are off by default)',
      (writes.signals || []).every((w) => w.body.every((r) => !/^player_/.test(r.market || '') && !('participant' in r))));
    chk('handler · ONE event, one request per batch of markets — never one per player',
      P.status === 'ok' && P.events_requested === 1 && P.requests === 5 && propCalls().length === 5 && P.markets_requested === 59, P);
    chk('handler · markets returned are counted from the response', P.markets_returned === 4, P.markets_returned);
    chk('handler · prop spend is the provider\'s own x-requests-last (4 markets x 2 regions)',
      P.quota_spent === 8 && P.quota_spent_is_exact === true && j.prop_quota_spent === 8, P.quota_spent);
    chk('handler · the run total includes the prop spend', j.quota_spent_this_run === 3 + 8 + 0, j.quota_spent_this_run);
    chk('handler · three players seen, with their markets', P.unique_players === 3 && P.unique_player_markets === 4, [P.unique_players, P.unique_player_markets]);
    const qrows = (writes.player_prop_quotes || []).flatMap((w) => w.body);
    chk('handler · every quote is written, upserted on quote_key', P.quotes_seen === 10 && P.quotes_written === 10 && qrows.length === 10
      && (writes.player_prop_quotes || []).every((w) => /on_conflict=quote_key/.test(w.url)), [P.quotes_seen, P.quotes_written, qrows.length]);
    chk('handler · Mahomes and Allen at the same line are two stored quotes',
      qrows.some((x) => x.quote_key === 'evt-1|player_pass_yds|patrick mahomes|Over|274.5|draftkings')
      && qrows.some((x) => x.quote_key === 'evt-1|player_pass_yds|josh allen|Over|274.5|draftkings'));
    chk('handler · one-sided quotes are stored, not dropped', P.one_sided_quotes === 2
      && qrows.filter((x) => x.is_two_sided === false).length === 2 && qrows.find((x) => x.player_key === 'travis kelce').book_fair_probability === null);
    chk('handler · ticks are the ones the database says it made', P.ticks_written === 10 && P.ticks_written_is_exact === true, [P.ticks_written]);
    const polls = (writes.player_prop_event_polls || []).flatMap((w) => w.body);
    chk('handler · the event\'s poll time is recorded for its own clock',
      polls.length === 1 && polls[0].event_id === 'evt-1' && polls[0].last_polled_at && polls[0].poll_status === 'ok'
      && (writes.player_prop_event_polls || [])[0].url.indexOf('on_conflict=event_id') > 0, polls);
    const prior = net.calls.find((c) => c.method === 'GET' && /qual_streak/.test(c.url));
    chk('handler · the game prior-state read excludes player rows', prior && /market=not\.like\.player_\*/.test(decodeURIComponent(prior.url)), prior && prior.url);
    chk('handler · the flat prop_* summary is in the run log', ['prop_quota_spent', 'prop_events_eligible', 'prop_events_requested', 'prop_markets_requested',
      'prop_markets_returned', 'prop_players_seen', 'prop_quotes_seen', 'prop_quotes_written', 'prop_ticks_written',
      'prop_events_skipped_budget', 'prop_failures'].every((k) => typeof j[k] === 'number'));
    chk('handler · the game run status is unaffected by the prop pass', j.ok === true && j.status === 'ok', [j.status, j.write_errors]);

    /* An unchanged board writes no ticks. */
    reset();
    net.db = propDb({ unchanged: true });
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('handler · a re-seen, unchanged price is upserted but ticks nothing', j.player_props.quotes_written === 10 && j.player_props.ticks_written === 0);

    /* BOARD never buys props. */
    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=board'))).json();
    chk('handler · the BOARD tier buys no player props', propCalls().length === 0 && j.player_props.status === 'skipped' && /BOARD/.test(j.player_props.reason));
    chk('handler · nor alternate ladders', net.calls.filter((c) => /alternate_spreads/.test(c.url)).length === 0);

    /* NEAR: the game is 6 h out, outside the 3 h prop window. */
    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=near'))).json();
    chk('handler · NEAR buys props only inside its 3 h window', propCalls().length === 0 && j.player_props.events_eligible === 0);

    /* The event was polled five minutes ago; it is 6 h out, so its interval is 120 min. */
    reset();
    net.db = propDb({ polls: [{ event_id: 'evt-1', last_polled_at: new Date(Date.now() - 5 * 60000).toISOString() }] });
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('handler · an event inside its own refresh interval is not re-bought',
      propCalls().length === 0 && j.player_props.events_skipped_interval === 1 && j.player_props.events_due === 0);

    /* ── 17 · budgets ─────────────────────────────────────────────────────── */
    reset();
    ENV.CAPTURE_PROP_MAX_CREDITS_PER_RUN = '20';
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('17 · a credit budget smaller than one batch\'s worst case spends nothing',
      propCalls().length === 0 && j.player_props.stopped === 'credit_budget' && j.player_props.events_skipped_budget === 1, j.player_props);
    ENV.CAPTURE_PROP_MAX_CREDITS_PER_RUN = '26';
    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('17 · the credit budget stops BEFORE a request that could pass it, mid-event',
      propCalls().length === 3 && j.player_props.stopped === 'credit_budget' && j.player_props.quota_spent <= 26, j.player_props);
    chk('17 · and what was already bought is still stored', j.player_props.quotes_written > 0
      && (writes.player_prop_event_polls || [])[0].body[0].poll_status === 'partial');
    delete ENV.CAPTURE_PROP_MAX_CREDITS_PER_RUN;

    reset();
    ENV.CAPTURE_PROP_MAX_MARKET_REQUESTS_PER_RUN = '12';
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('17 · the (event x market) request budget stops the pass', propCalls().length === 1 && j.player_props.stopped === 'market_request_budget', j.player_props.stopped);
    delete ENV.CAPTURE_PROP_MAX_MARKET_REQUESTS_PER_RUN;

    reset();
    delete ENV.CAPTURE_PROP_MIN_QUOTA_REMAINING;
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('17 · below the (default 5,000) quota floor no prop request is made; the game lines still run',
      propCalls().length === 0 && j.player_props.stopped === 'quota_floor' && j.priced > 0 && j.ok === true, j.player_props.stopped);
    ENV.CAPTURE_PROP_MIN_QUOTA_REMAINING = '1000';

    reset();
    net.eventFail = (sport, id, asked) => (asked.some((k) => /^player_/.test(k)) ? 429 : 0);
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('17 · a 429 stops the prop pass at once', propCalls().length === 1 && j.player_props.stopped === 'provider_429'
      && j.player_props.failures === 1 && j.player_props.failure_samples[0].status === 429);
    chk('17 · and a failed event gets no poll time, so it is retried next run', !(writes.player_prop_event_polls || []).length);
    chk('17 · the game-line run is still ok', j.ok === true && j.status === 'ok');

    /* Storage first, credits second. */
    reset();
    net.db = propDb({ storageMissing: true });
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('handler · with no player_prop_quotes table nothing is bought', propCalls().length === 0 && j.player_props.status === 'storage_missing'
      && /capture_v11_player_props\.sql/.test(j.player_props.reason));

    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day&props=0'))).json();
    chk('handler · ?props=0 turns the pass off for one run', propCalls().length === 0 && j.player_props.status === 'skipped');

    reset();
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day&diag=1'))).json();
    chk('handler · a diagnostic run never buys props', propCalls().length === 0 && j.player_props.status === 'skipped');

    /* ── 11 · optional prop signals ──────────────────────────────────────── */
    reset();
    ENV.CAPTURE_PLAYER_PROP_SIGNALS = 'true';
    net.db = propDb();
    j = await (await M.handle(rq('?tier=day'))).json();
    const propSig = (writes.signals || []).flatMap((w) => w.body).filter((r) => /^player_/.test(r.market || ''));
    chk('11 · with prop signals on, two-sided props reach `signals` carrying their player',
      propSig.length > 0 && propSig.every((r) => r.participant && r.participant_key && r.is_player_prop === true && r.source_market), propSig[0]);
    chk('11 · one-sided props never do', !propSig.some((r) => r.participant_key === 'travis kelce' || r.point === 250.5));
    chk('11 · and none is actionable: the player_props floor is null',
      propSig.every((r) => r.actionable === false) && j.player_props.qualification.actionable === 0
      && (j.player_props.qualification.by_reason.segment_not_qualified_for_action > 0 || j.player_props.qualification.by_reason.insufficient_fresh_books > 0),
      j.player_props.qualification);
    chk('11 · prop signal rows are sent in their own batches, apart from game rows',
      (writes.signals || []).every((w) => w.body.every((r) => /^player_/.test(r.market || '')) || w.body.every((r) => !/^player_/.test(r.market || ''))));
    chk('11 · no signal tick is written for a prop', !(writes.signal_ticks || []).flatMap((w) => w.body).some((r) => /\|player_/.test(r.sig_key)));
    const propPrior = net.calls.find((c) => c.method === 'GET' && /qual_streak/.test(c.url) && /market=like\.player_/.test(decodeURIComponent(c.url)));
    chk('11 · prop persistence is read separately from game persistence', !!propPrior);
    delete ENV.CAPTURE_PLAYER_PROP_SIGNALS;
    delete ENV.CAPTURE_PROP_MIN_QUOTA_REMAINING;
    reset();
  }

  done();
})().catch((e) => { console.log('FAIL | suite threw'); console.error(e); process.exit(1); });

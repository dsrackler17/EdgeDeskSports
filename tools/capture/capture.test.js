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
const net = { calls: [], odds: {}, sports: ['americanfootball_nfl'], db: null, oddsFail: {} };
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
const NOW = Date.parse('2026-09-05T12:00:00.000Z');
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
  chk('build and policy version are both stamped', /^capture-v9/.test(M.BUILD) && /^qual-/.test(M.POLICY_VERSION), [M.BUILD, M.POLICY_VERSION]);

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
      Object.keys(M.STAGE_OF_REASON).length >= 20 && M.STAGE_OF_REASON.ok === M.FUNNEL_STAGES.length - 1);
    chk('an unmapped reason reports zero stages rather than a phantom pass',
      M.stagesPassed('a_reason_nobody_added') === 0);
    chk('reaching the edge floor means every earlier gate was cleared',
      M.stagesPassed('below_segment_edge_floor') > M.stagesPassed('best_price_stale'));
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

  done();
})().catch((e) => { console.log('FAIL | suite threw'); console.error(e); process.exit(1); });

// @ts-nocheck — the plain JavaScript core (lib/edgedesk_sharp_lag.js) inlined in a .ts file, as kalshi_sync inlines its identity.
// ============================================================
//  FILE:    supabase/functions/sharp_lag/index.ts
//  TYPE:    Edge Function — Sharp lag research (EXPERIMENTAL): the FREE job
//  DEPLOY:  supabase functions deploy sharp_lag --no-verify-jwt
//           .github/workflows/deploy-sharp-lag.yml does it, tests first
//  CRON:    supabase/sharp_lag_cron.sql — every 10 minutes
//  SQL:     supabase/sharp_lag.sql (docs/sharp-lag/README.md)
// ============================================================
// IT NEVER CALLS THE ODDS GATEWAY OR THE PROVIDER, and spends nothing. It
// reads what is already stored (the gateway's snapshots in
// public.odds_api_snapshots; from step B Kalshi's 5-minute snapshots, the NBA
// injury reports, the NHL starting goalies and the published NBA roster
// inputs) and writes only the append-only sharp_* tables. Its cron command
// matches no pattern in public.odds_api_spend_patterns(), so it may run every
// 10 minutes. The one paid caller is supabase/functions/sharp_check.
//
// EACH RUN, in order; a failing step is recorded and never stops the next:
//   1 ingest   the Pinnacle and DraftKings prices of every gateway snapshot
//              it has not read, one append-only row each
//
// AUTH. pg_cron sends the Vault secret sharp_lag_cron_secret as
// x-cron-secret; it must equal SHARP_LAG_CRON_SECRET. A GET is a health probe.
// POST body (all optional): { dry, now (dry only), steps: ["ingest", ...] }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHARP_LAG_CRON_SECRET
// ============================================================

export const BUILD = "sharp_lag@2026-10-27.1";

// ── BEGIN SHARP LAG CORE ── copied from lib/edgedesk_sharp_lag.js by tools/sharp_lag/inline_core.js; do not edit here
/* ===========================================================================
   EdgeDesk SHARP LAG — the research core. EXPERIMENTAL.

   The hypothesis (research/sharp_lag/registration_sharp_lag.json): when a
   slow market (a Kalshi game-winner YES price, a DraftKings line) sits at
   least 2.5 percentage points below Pinnacle's de-vigged fair for the same
   outcome, after the slow market's own fees, the slow market is LAGGING, and
   the gap shows up as positive closing-line value against Pinnacle's close.
   Every flag is graded against the close, in the open, losses included. This
   module never says what anyone should do with a price: it measures a gap.

   ONE IMPLEMENTATION, THREE HOSTS
     supabase/functions/sharp_lag    the free job: ingest, triggers, flags, grades
     supabase/functions/sharp_check  the hourly paid dispatcher (through odds_gateway)
     app.html, performance/          the Experimental sections (window.EDSharpLag)
   The two functions carry a verbatim copy between BEGIN/END SHARP LAG CORE
   markers (tools/sharp_lag/inline_core.js; a test fails on drift), because
   the dashboard deploy bundles one folder.

   THE NUMBERS (frozen here and in public.sharp_lag_rule(); a test holds the
   two equal, so changing one is a reviewed code change in both)
     gap_pp 2.5                Pinnacle fair minus the target's all-in cost
     converge_pp 1.0           the lag is over once the gap is under this
     reference_max_age_min 90  an older Pinnacle observation is a past price
     book_target_max_age_min 90, kalshi_max_age_min 15, kalshi_max_spread 0.06
     kalshi_move 0.03          a trigger: the Kalshi mid moved 3¢ or more
                               between consecutive 5-minute snapshots
     close_max_lead_min 90     the close: the last observation at or before
                               the start, at most 90 minutes before it
     validation_min_graded 200 and the game-clustered bootstrap's 95% lower
                               bound on the mean CLV above zero, BOTH, before a
                               person may promote the model (never automatic)

   DE-VIG: SHIN, the same function capture prices signals.sharp_fair with
   (supabase/functions/capture/index.ts devig(), copied below with its
   bracket-checking bisection), so a Pinnacle fair here and on the board is
   one number. An underround pair is normalised proportionally, as capture
   does, and says so in devig_method.

   COSTS. DraftKings: 1 / decimal price (the vig is paid, so it stays in).
   Kalshi: the YES ask plus the taker fee. Until an operator records Kalshi's
   CURRENT published schedule as verified (public.market_execution_costs),
   the fee is the HIGHEST PLAUSIBLE one — coefficient 0.07 rounded up to the
   cent on a single-contract order, the most rounding the schedule allows —
   and every such flag is marked fee_unverified.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDSharpLag = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var L = { VERSION: 'edgedesk_sharp_lag/1' };

  L.RULES = {
    gap_pp: 2.5,
    role_shift_gap_pp: 2.5,
    converge_pp: 1.0,
    reference_max_age_min: 90,
    book_target_max_age_min: 90,
    kalshi_max_age_min: 15,
    kalshi_max_spread: 0.06,
    kalshi_move: 0.03,
    kalshi_pair_max_min: 10,
    close_max_lead_min: 90,
    check_window_hours: 24,
    validation_min_graded: 200,
    ci_level: 0.95,
    bootstrap_resamples: 2000,
    bootstrap_seed: 20261026,
    past_price_min: 90
  };
  L.MODELS = {
    sharp_lag: { key: 'SHARP-LAG', version: '0.1', label: 'Sharp lag' },
    role_shift: { key: 'NBA-ROLE-SHIFT', version: '0.1', label: 'NBA role shift' }
  };
  L.TRIGGERS = {
    scheduled: 'Scheduled check',
    nba_injury: 'NBA starter status change',
    nhl_goalie: 'NHL goalie change',
    kalshi_move: 'Kalshi move of 3¢ or more',
    role_shift: 'NBA role shift'
  };

  /* ------------------------------------------------------------ numbers */
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(iso) { var t = typeof iso === 'number' ? iso : Date.parse(iso); return isFinite(t) ? t : null; }
  function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
  function r2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
  L.num = num;

  L.amToDec = function (a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
  L.decToAm = function (d) { d = num(d); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };
  L.probToAm = function (p) { p = num(p); if (p == null || p <= 0 || p >= 1) return null; return L.decToAm(1 / p); };

  /* Bisection that checks its bracket (capture/index.ts bisect, verbatim in behaviour) */
  function bisect(f, lo, hi, it) {
    it = it || 80;
    var fl = f(lo); var fh = f(hi);
    if (!isFinite(fl) || !isFinite(fh)) return null;
    if (Math.abs(fl) < 1e-12) return lo;
    if (Math.abs(fh) < 1e-12) return hi;
    if ((fl < 0) === (fh < 0)) return null;
    for (var i = 0; i < it; i++) {
      var m = (lo + hi) / 2, fm = f(m);
      if (Math.abs(fm) < 1e-12) return m;
      if ((fl < 0) === (fm < 0)) { lo = m; fl = fm; } else hi = m;
    }
    return (lo + hi) / 2;
  }
  /* Shin de-vig (capture/index.ts devig(decs, 'shin'), the same arithmetic).
     Returns { probs, method }: method 'shin', or 'multiplicative' when the
     pair is underround or the root is not bracketed (as capture falls back). */
  L.devigShin = function (decs) {
    var q = decs.map(function (d) { return 1 / d; });
    var S = q.reduce(function (a, b) { return a + b; }, 0);
    var normalised = function () { return q.map(function (x) { return x / S; }); };
    if (!isFinite(S) || S <= 0) return { probs: decs.map(function () { return 0; }), method: 'invalid' };
    if (!(S > 1)) return { probs: normalised(), method: 'multiplicative' };
    var fair = function (z) { return q.map(function (qi) { return (Math.sqrt(z * z + 4 * (1 - z) * qi * qi / S) - z) / (2 * (1 - z)); }); };
    var z = bisect(function (zz) { return fair(zz).reduce(function (a, b) { return a + b; }, 0) - 1; }, 1e-9, 0.5);
    if (z == null) return { probs: normalised(), method: 'multiplicative' };
    var out = fair(z);
    var s2 = out.reduce(function (a, b) { return a + b; }, 0);
    if (!isFinite(s2) || s2 <= 0) return { probs: normalised(), method: 'multiplicative' };
    return { probs: out.map(function (x) { return x / s2; }), method: 'shin' };
  };

  /* ------------------------------------------------------------ The Odds API bodies */
  /* every outcome of the named books in a gateway snapshot body (/odds: an
     array of events; /events/{id}/odds: one event), decimal prices. A book
     listed twice for one market keeps its latest update. */
  L.quotesFromOdds = function (body, o) {
    o = o || {};
    var books = o.books ? o.books.map(function (b) { return String(b).toLowerCase(); }) : null;
    var markets = o.markets || null;
    var american = String(o.format || 'decimal').toLowerCase() === 'american';
    var want = o.participants ? o.participants : null;
    var events = Array.isArray(body) ? body : (body && typeof body === 'object' && body.id ? [body] : []);
    var keep = {};
    events.forEach(function (ev) {
      if (!ev || !ev.id) return;
      (ev.bookmakers || []).forEach(function (bk) {
        var book = String(bk && bk.key || '').toLowerCase();
        if (!book || (books && books.indexOf(book) < 0)) return;
        (bk.markets || []).forEach(function (m) {
          var mk = String(m && m.key || '');
          if (!mk || (markets && markets.indexOf(mk) < 0)) return;
          var upd = m.last_update || bk.last_update || null;
          (m.outcomes || []).forEach(function (oc) {
            var dec = american ? L.amToDec(oc.price) : num(oc.price);
            if (dec == null || !(dec > 1)) return;
            var participant = oc.description ? String(oc.description) : null;
            if (want && participant && !want(participant)) return;
            var row = { event_id: String(ev.id), sport_key: ev.sport_key || o.sport_key || null, home_team: ev.home_team || null, away_team: ev.away_team || null,
              commence_time: ev.commence_time || null, book: book, book_last_update: upd, market: mk, side: String(oc.name || ''),
              participant: participant, point: num(oc.point), price_dec: r4(dec) };
            var k = [row.event_id, book, mk, row.side, participant || '', row.point == null ? '' : row.point].join('|');
            var prev = keep[k];
            if (!prev || String(upd || '') > String(prev.book_last_update || '')) keep[k] = row;
          });
        });
      });
    });
    return Object.keys(keep).map(function (k) { return keep[k]; });
  };

  /* one side of one market, independent of the book: what a target must match */
  L.sideKey = function (r) { return [r.market, r.side, r.participant || '', r.point == null ? '' : num(r.point)].join('|'); };
  /* the complete market a side belongs to (both sides devig together) */
  function pairKey(r) {
    if (r.market === 'h2h') return 'h2h';
    if (r.market === 'spreads') return 'spreads|' + Math.abs(num(r.point));
    return r.market + '|' + (r.participant || '') + '|' + (r.point == null ? '' : num(r.point));
  }
  function completePair(rows) {
    if (rows.length !== 2) return false;
    var a = rows[0], b = rows[1];
    if (a.side === b.side) return false;
    if (a.market === 'spreads') return num(a.point) != null && num(a.point) === -num(b.point);
    if (a.market === 'totals' || a.participant) return /^over$/i.test(a.side) !== /^over$/i.test(b.side) && num(a.point) === num(b.point);
    return true;
  }
  /* every two-way market in one book's rows of ONE observation, de-vigged:
     sideKey -> { side row, fair, opp_dec, method } */
  L.fairs = function (rows) {
    var groups = {}, out = {};
    (rows || []).forEach(function (r) { var k = pairKey(r); (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (!completePair(g)) return;
      var d = L.devigShin([num(g[0].price_dec), num(g[1].price_dec)]);
      if (d.method === 'invalid') return;
      for (var i = 0; i < 2; i++) {
        out[L.sideKey(g[i])] = { row: g[i], fair: r4(d.probs[i]), dec: num(g[i].price_dec), opp_dec: num(g[1 - i].price_dec), method: d.method };
      }
    });
    return out;
  };

  /* The resolution of an observation: the seconds since the previous one of
     the same source and event. The first has none, so it gets the cadence the
     source is held to: the gateway's bands for a board (60 minutes inside
     24 h of the start, 120 to 72 h, 360 beyond; supabase/odds_api_gateway.sql
     odds_api_cadence) and 5 minutes for Kalshi's snapshots. */
  L.nominalResolution = function (source, hoursToStart) {
    if (source === 'kalshi') return 300;
    var h = num(hoursToStart);
    return h == null || h <= 24 ? 3600 : h <= 72 ? 7200 : 21600;
  };

  return L;
}));
// ── END SHARP LAG CORE ──

type Any = any;
const SL: Any = (globalThis as Any).EDSharpLag;
const env = (k: string): string => ((globalThis as Any).Deno?.env.get(k) ?? "");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const iso = (t: number) => new Date(t).toISOString();
const enc = encodeURIComponent;
function deadline(t: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(t); } catch { return undefined; } }

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
async function db(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init?.headers as Any) ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) { const e: Any = new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300)); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function dbAll(path: string, pages = 20): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < pages; p++) {
    const rows = (await db(path + "&limit=1000&offset=" + p * 1000)) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
/* append-only writes: a row already there is left alone, never rewritten */
const insertOnce = (table: string, rows: Any[], key: string) => rows.length
  ? db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=ignore-duplicates" } })
  : null;
const insert = (table: string, rows: Any[]) => rows.length ? db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal" } }) : null;
const inList = (xs: Any[]) => "(" + xs.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(",") + ")";
async function chunks(rows: Any[], n: number, fn: (c: Any[]) => Promise<Any>) { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); }

async function setting(key: string): Promise<string | null> {
  const r = await db("sharp_lag_config?select=value&key=eq." + enc(key));
  return r && r[0] ? String(r[0].value) : null;
}

/* ================================================================ 1 INGEST */
const MAIN = ["h2h", "spreads", "totals"];
async function ingest(ctx: Any) {
  const since = iso(ctx.nowMs - 6 * 3600e3);
  const snaps = await dbAll("odds_api_snapshots?select=fingerprint,category,sport_key,event_id,odds_format,last_request_id,last_success_at,body"
    + "&category=in.(featured,close,sharp_check)&last_success_at=gte." + enc(since) + "&order=last_success_at.asc");
  const ids = snaps.map((s: Any) => s.last_request_id).filter((x: Any) => x != null);
  const done = new Set<string>();
  await chunks(ids, 100, async (c) => {
    (await dbAll("sharp_price_snapshots?select=source_request_id&source_request_id=in." + inList(c))).forEach((r: Any) => done.add(String(r.source_request_id)));
  });
  let read = 0, rowsOut = 0;
  for (const s of snaps) {
    if (!s.body || s.last_request_id == null || done.has(String(s.last_request_id))) continue;
    const rows = SL.quotesFromOdds(s.body, { books: ["pinnacle", "draftkings"], markets: MAIN, format: s.odds_format, sport_key: s.sport_key });
    const out = rows.map((r: Any) => ({ captured_at: s.last_success_at, source: "odds_api", source_request_id: s.last_request_id, source_category: s.category,
      odds_format: s.odds_format || null, sport_key: r.sport_key || s.sport_key, event_id: r.event_id, home_team: r.home_team, away_team: r.away_team,
      commence_time: r.commence_time, book: r.book, book_last_update: r.book_last_update, market: r.market, side: r.side,
      participant: r.participant, point: r.point, price_dec: r.price_dec }));
    if (!ctx.dry) await chunks(out, 500, (c) => insertOnce("sharp_price_snapshots", c, "source_request_id,event_id,book,market,side,participant_key,point_key"));
    read++; rowsOut += out.length;
  }
  ctx.out.ingest = { snapshots_seen: snaps.length, snapshots_read: read, price_rows: rowsOut };
}

/* ================================================================ the run */
const STEPS: Any = { ingest };
export async function runOnce(opts: Any = {}) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const dry = !!opts.dry;
  const steps: string[] = Array.isArray(opts.steps) && opts.steps.length ? opts.steps : Object.keys(STEPS);
  const warnings: Any[] = [];
  const ctx: Any = { nowMs, dry, out: {}, eventCache: {}, trigCache: {}, fee: undefined,
    warn: (code: string, message: string) => warnings.push({ code, message }) };
  const run: Any = { run_id: crypto.randomUUID(), fn: "sharp_lag", status: "ok", started_at: iso(nowMs) };
  const out: Any = { ok: true, build: BUILD, run_id: run.run_id, dry };
  try {
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this function");
    if (!SL) throw new Error("the inlined Sharp-lag core did not load");
    for (const s of steps) {
      if (!STEPS[s]) { ctx.warn("unknown_step", s); continue; }
      try { await STEPS[s](ctx); } catch (e) { ctx.warn(s, msg(e)); }
    }
    run.status = warnings.length ? "warn" : "ok";
  } catch (e) {
    run.status = "error"; run.message = msg(e);
  } finally {
    run.finished_at = iso(Math.max(Date.now(), nowMs));
    run.message = run.message || (warnings.map((w) => w.code + ": " + w.message).join("; ").slice(0, 600) || null);
    run.details = Object.assign({}, ctx.out, { warnings });
    Object.assign(out, ctx.out, { status: run.status, warnings, ok: run.status !== "error" });
    if (!dry) { try { await insert("sharp_lag_runs", [run]); } catch (e) { out.ok = false; out.record_error = msg(e); } }
    console.log("SHARP_LAG", JSON.stringify({ run_id: run.run_id, status: run.status, ingest: ctx.out.ingest || null, triggers: ctx.out.triggers || null,
      flags: ctx.out.flags ? { written: ctx.out.flags.written, events: ctx.out.flags.events } : null, grades: ctx.out.grades || null, warnings: warnings.map((w) => w.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: SL ? SL.VERSION : null });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("SHARP_LAG_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "SHARP_LAG_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const dry = !!body.dry;
  const out = await runOnce({ dry, now: dry ? body.now : undefined, steps: body.steps });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as Any).Deno !== "undefined" && (globalThis as Any).Deno.serve) (globalThis as Any).Deno.serve(handle);

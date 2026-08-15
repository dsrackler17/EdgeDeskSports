// ============================================================================
//  FILE:  supabase/tests/ufc_live_stats.cases.ts
//  WHAT:  The UFC live-capture test cases, defined ONCE.
//
//  The core is INJECTED rather than imported, so the same assertions run under
//  two different runners without being copied:
//
//    supabase/tests/ufc_live_stats.test.ts   Deno — imports the real module
//    supabase/tests/run_node.mjs             Node — extracts the marked cores
//
//  Two copies of a test suite drift, and the copy that drifts is always the one
//  nobody ran. One definition, two runners.
// ============================================================================

export interface Assert {
  eq(actual: unknown, expected: unknown, msg?: string): void;
  ok(v: unknown, msg?: string): void;
  is(actual: unknown, expected: unknown, msg?: string): void;
}

export interface Case { name: string; fn: (a: Assert) => void | Promise<void>; }

export function defineCases(core: any): Case[] {
  const {
    normKey, normalizeName, canonicalStatSlot, parseStatValue, assignStat,
    emptyStats, statsAreEmpty, flattenStatEntries, normalizeStatBag, sumRounds,
    parseClockSeconds, elapsedSeconds, normalizeStatus, parseDecisionType,
    snapshotHash, isEventInWindow, prioritizeBouts, sourceFreshnessSeconds,
    resolveFighter, buildFighterIndex, httpGet, Telemetry, mapLimit,
  } = core;

  const cases: Case[] = [];
  const T = (name: string, fn: (a: Assert) => void | Promise<void>) => cases.push({ name, fn });

  /* ── key + name normalization ──────────────────────────────────────────── */
  T("normKey folds camelCase, spacing, punctuation and case together", (a) => {
    a.eq(normKey("Sig. Strikes Landed"), "sig_strikes_landed");
    a.eq(normKey("sigStrikesLanded"), "sig_strikes_landed");
    a.eq(normKey("SIG_STRIKES_LANDED"), "sig_strikes_landed");
    a.eq(normKey("  sig strikes landed  "), "sig_strikes_landed");
    a.eq(normKey(null), "");
  });

  T("normalizeName strips accents, suffixes and punctuation", (a) => {
    a.eq(normalizeName("José Aldó Jr."), "jose aldo");
    a.eq(normalizeName("Conor McGregor"), "conor mcgregor");
    a.eq(normalizeName("  O'Malley, Sean  "), "o malley sean");
    a.eq(normalizeName(undefined), "");
  });

  /* ── value parsing ─────────────────────────────────────────────────────── */
  T("parseStatValue reads every pair spelling feeds actually use", (a) => {
    a.eq(parseStatValue("12 of 30"), { kind: "pair", landed: 12, attempted: 30 });
    a.eq(parseStatValue("12/30"), { kind: "pair", landed: 12, attempted: 30 });
    a.eq(parseStatValue("12 - 30"), { kind: "pair", landed: 12, attempted: 30 });
  });

  T("parseStatValue reads clocks as time, not as counts", (a) => {
    a.eq(parseStatValue("2:31"), { kind: "time", seconds: 151 });
    a.eq(parseStatValue("1:02:03"), { kind: "time", seconds: 3723 });
    a.eq(parseStatValue("0:00"), { kind: "time", seconds: 0 });
  });

  T("parseStatValue reads percentages as fractions", (a) => {
    a.eq(parseStatValue("45%"), { kind: "pct", p: 0.45 });
    a.eq(parseStatValue("100%"), { kind: "pct", p: 1 });
  });

  T("BLANKS ARE NULL, NEVER ZERO — the rule the whole system rests on", (a) => {
    for (const blank of ["", "  ", "-", "--", "—", "N/A", "n/a", "null", "TBD", null, undefined]) {
      a.eq(parseStatValue(blank), null, `blank ${JSON.stringify(blank)} must parse to null, not 0`);
    }
  });

  T("parseStatValue refuses garbage rather than coercing it", (a) => {
    a.eq(parseStatValue("abc"), null);
    a.eq(parseStatValue("NaN"), null);
    a.eq(parseStatValue({}), null);
    a.eq(parseStatValue(Infinity), null);
  });

  /* ── alias mapping ─────────────────────────────────────────────────────── */
  T("canonicalStatSlot maps known spellings and refuses unknown ones", (a) => {
    a.eq(canonicalStatSlot("sigStrikesLanded"), { kind: "field", field: "sig_strikes_landed" });
    a.eq(canonicalStatSlot("Sig. Strikes"), { kind: "pair", base: "sig_strikes" });
    a.eq(canonicalStatSlot("Takedowns"), { kind: "pair", base: "takedowns" });
    a.eq(canonicalStatSlot("Control Time"), { kind: "field", field: "control_seconds" });
    a.eq(canonicalStatSlot("KD"), { kind: "field", field: "knockdowns" });
    a.eq(canonicalStatSlot("wingspan_velocity"), null, "an unknown key must map to nothing, not to a guess");
  });

  T("a pair slot given a bare number is REFUSED, not guessed", (a) => {
    const s = emptyStats();
    // "12" for a Sig. Strikes pair is ambiguous: landed, or thrown? Guessing
    // would put a number in a column it may not belong in.
    a.eq(assignStat(s, canonicalStatSlot("Sig. Strikes"), "12"), false);
    a.eq(s.sig_strikes_landed, null);
    a.eq(s.sig_strikes_attempted, null);
  });

  T("control time accepts a clock and a raw second count", (a) => {
    const s1 = emptyStats();
    assignStat(s1, canonicalStatSlot("Control"), "2:31");
    a.eq(s1.control_seconds, 151);
    const s2 = emptyStats();
    assignStat(s2, canonicalStatSlot("control_time_seconds"), 151);
    a.eq(s2.control_seconds, 151);
  });

  T("takedown percentage normalizes both 0-1 and 0-100 conventions", (a) => {
    const a1 = emptyStats(); assignStat(a1, canonicalStatSlot("takedown_percentage"), "40%");
    a.eq(a1.takedowns_pct, 0.4);
    const a2 = emptyStats(); assignStat(a2, canonicalStatSlot("takedown_percentage"), 40);
    a.eq(a2.takedowns_pct, 0.4);
    const a3 = emptyStats(); assignStat(a3, canonicalStatSlot("takedown_percentage"), 0.4);
    a.eq(a3.takedowns_pct, 0.4);
  });

  T("fractional strike counts are refused rather than silently rounded", (a) => {
    const s = emptyStats();
    a.eq(assignStat(s, canonicalStatSlot("knockdowns"), "1.4"), false);
    a.eq(s.knockdowns, null);
    a.eq(assignStat(s, canonicalStatSlot("knockdowns"), "2.0"), true, "2.0 means 2");
    a.eq(s.knockdowns, 2);
  });

  T("negative counts are refused", (a) => {
    const s = emptyStats();
    a.eq(assignStat(s, canonicalStatSlot("knockdowns"), -3), false);
    a.eq(s.knockdowns, null);
  });

  /* ── flattening arbitrary provider shapes ──────────────────────────────── */
  T("flattenStatEntries handles the name/displayValue array shape", (a) => {
    const bag = flattenStatEntries([
      { name: "Sig. Strikes", displayValue: "38 of 71" },
      { name: "Takedowns", displayValue: "2 of 4" },
      { name: "Control", displayValue: "2:14" },
    ]);
    a.eq(bag["sig_strikes"], "38 of 71");
    a.eq(bag["takedowns"], "2 of 4");
    a.eq(bag["control"], "2:14");
  });

  T("flattenStatEntries handles flat objects and nested categories alike", (a) => {
    const flat = flattenStatEntries({ sig_strikes_landed: 38, knockdowns: 1 });
    a.eq(flat["sig_strikes_landed"], 38);
    const nested = flattenStatEntries({
      categories: [{ name: "striking", stats: [{ name: "Head", displayValue: "20 of 30" }] }],
    });
    a.eq(nested["head"], "20 of 30");
  });

  T("flattenStatEntries survives cycles and absurd nesting without hanging", (a) => {
    const cyclic: any = { name: "x" }; cyclic.self = cyclic;
    const bag = flattenStatEntries(cyclic);
    a.ok(bag, "a cyclic payload must return, not spin");
    a.eq(flattenStatEntries(null), {});
    a.eq(flattenStatEntries(undefined), {});
  });

  /* ── the normalizer end to end ─────────────────────────────────────────── */
  T("normalizeStatBag maps a full corner and reports nothing unmapped", (a) => {
    const r = normalizeStatBag(flattenStatEntries([
      { name: "Sig. Strikes", displayValue: "38 of 71" },
      { name: "Total Strikes", displayValue: "52 of 89" },
      { name: "Head", displayValue: "20 of 40" },
      { name: "Body", displayValue: "10 of 18" },
      { name: "Leg", displayValue: "8 of 13" },
      { name: "Distance", displayValue: "30 of 60" },
      { name: "Clinch", displayValue: "5 of 7" },
      { name: "Ground", displayValue: "3 of 4" },
      { name: "Takedowns", displayValue: "2 of 4" },
      { name: "Submission Attempts", displayValue: "1" },
      { name: "Reversals", displayValue: "0" },
      { name: "Control", displayValue: "2:14" },
      { name: "Knockdowns", displayValue: "1" },
    ]));
    a.eq(r.stats.sig_strikes_landed, 38);
    a.eq(r.stats.sig_strikes_attempted, 71);
    a.eq(r.stats.head_strikes_landed, 20);
    a.eq(r.stats.ground_strikes_attempted, 4);
    a.eq(r.stats.takedowns_landed, 2);
    a.eq(r.stats.control_seconds, 134);
    a.eq(r.stats.knockdowns, 1);
    a.eq(r.stats.reversals, 0, "an explicit 0 from the source IS a zero");
    a.eq(r.unmapped.length, 0);
    a.eq(r.mapped, 13);
  });

  T("PARTIAL RESPONSE: present fields map, absent ones stay null", (a) => {
    const r = normalizeStatBag(flattenStatEntries([{ name: "Sig. Strikes", displayValue: "10 of 20" }]));
    a.eq(r.stats.sig_strikes_landed, 10);
    a.eq(r.stats.takedowns_landed, null, "a field the source never sent must stay null");
    a.eq(r.stats.control_seconds, null);
    a.eq(r.stats.knockdowns, null);
  });

  T("MALFORMED STATISTIC: one bad value costs one field, not the corner", (a) => {
    const r = normalizeStatBag(flattenStatEntries([
      { name: "Sig. Strikes", displayValue: "38 of 71" },
      { name: "Takedowns", displayValue: "!!broken!!" },
      { name: "Knockdowns", displayValue: 1 },
    ]));
    a.eq(r.stats.sig_strikes_landed, 38, "the good fields still land");
    a.eq(r.stats.knockdowns, 1);
    a.eq(r.stats.takedowns_landed, null, "the bad field is null, not garbage");
  });

  T("A RENAMED SOURCE FIELD IS REPORTED, NOT SWALLOWED", (a) => {
    const r = normalizeStatBag(flattenStatEntries([
      { name: "Significant Strikes Delivered", displayValue: "38 of 71" },
    ]));
    a.ok(r.unmapped.includes("significant_strikes_delivered"),
      "an unrecognised key must surface in unmapped so the alias table can be extended");
    a.eq(r.stats.sig_strikes_landed, null, "and must NOT be guessed into a column");
  });

  T("scaffolding keys are ignored rather than reported as mysteries", (a) => {
    const r = normalizeStatBag(flattenStatEntries({ id: "123", name: "x", logo: "y", knockdowns: 1 }));
    a.eq(r.unmapped.length, 0, "id/name/logo must not pollute the diagnostic");
    a.eq(r.stats.knockdowns, 1);
  });

  T("an empty corner is detectable — that is what drives stats_available", (a) => {
    a.eq(statsAreEmpty(emptyStats()), true);
    const r = normalizeStatBag(flattenStatEntries([{ name: "Knockdowns", displayValue: "0" }]));
    a.eq(statsAreEmpty(r.stats), false, "an explicit zero is data, so the corner is not empty");
  });

  /* ── round summing ─────────────────────────────────────────────────────── */
  T("sumRounds adds published rounds and derives the takedown rate", (a) => {
    const r1 = emptyStats(); r1.sig_strikes_landed = 10; r1.sig_strikes_attempted = 20;
    r1.takedowns_landed = 1; r1.takedowns_attempted = 2;
    const r2 = emptyStats(); r2.sig_strikes_landed = 15; r2.sig_strikes_attempted = 25;
    r2.takedowns_landed = 1; r2.takedowns_attempted = 2;
    const tot = sumRounds([r1, r2]);
    a.eq(tot.sig_strikes_landed, 25);
    a.eq(tot.sig_strikes_attempted, 45);
    a.eq(tot.takedowns_pct, 0.5);
  });

  T("SUMMING NOTHING IS NULL, NOT ZERO", (a) => {
    const tot = sumRounds([emptyStats(), emptyStats()]);
    a.eq(tot.sig_strikes_landed, null, "no round published it, so the total must not claim zero");
    a.eq(tot.control_seconds, null);
  });

  T("sumRounds adds only the rounds that published a field", (a) => {
    const r1 = emptyStats(); r1.knockdowns = 1;
    const r2 = emptyStats();                       // round 2 published nothing
    a.eq(sumRounds([r1, r2]).knockdowns, 1);
  });

  /* ── clock and elapsed ─────────────────────────────────────────────────── */
  T("parseClockSeconds parses a round clock and refuses nonsense", (a) => {
    a.eq(parseClockSeconds("2:14"), 134);
    a.eq(parseClockSeconds("0:07"), 7);
    a.eq(parseClockSeconds("abc"), null);
    a.eq(parseClockSeconds(""), null);
    a.eq(parseClockSeconds(null), null);
  });

  T("elapsedSeconds counts a COUNT-DOWN round clock correctly", (a) => {
    a.eq(elapsedSeconds(2, 134), 466, "R2 with 2:14 left = 300 + (300-134)");
    a.eq(elapsedSeconds(1, 300), 0, "start of R1");
    a.eq(elapsedSeconds(1, 0), 300, "end of R1");
    a.eq(elapsedSeconds(null, 134), null, "unknown round is not guessed");
    a.eq(elapsedSeconds(2, null), null, "unknown clock is not guessed");
  });

  /* ── status ────────────────────────────────────────────────────────────── */
  T("normalizeStatus collapses provider vocabularies onto four states", (a) => {
    a.eq(normalizeStatus("STATUS_IN_PROGRESS"), "in");
    a.eq(normalizeStatus("in"), "in");
    a.eq(normalizeStatus("live"), "in");
    a.eq(normalizeStatus("STATUS_FINAL"), "post");
    a.eq(normalizeStatus("closed"), "post");
    a.eq(normalizeStatus("STATUS_SCHEDULED"), "pre");
    a.eq(normalizeStatus("cancelled"), "canceled");
    a.eq(normalizeStatus("postponed"), "postponed");
  });

  T("an unknown status is NULL — never defaulted to 'pre'", (a) => {
    a.eq(normalizeStatus("banana"), null,
      "a live fight shown as upcoming is worse than one shown as unknown");
    a.eq(normalizeStatus(""), null);
    a.eq(normalizeStatus(null), null);
  });

  T("parseDecisionType only reports what the string actually said", (a) => {
    a.eq(parseDecisionType("Decision - Unanimous"), "Unanimous");
    a.eq(parseDecisionType("Split Decision"), "Split");
    a.eq(parseDecisionType("Majority Decision"), "Majority");
    a.eq(parseDecisionType("Decision"), "Decision");
    a.eq(parseDecisionType("KO/TKO"), null, "a knockout has no decision type");
    a.eq(parseDecisionType("Submission"), null);
  });

  /* ── snapshot dedup ────────────────────────────────────────────────────── */
  T("DUPLICATE SNAPSHOT: identical stats produce an identical hash", (a) => {
    const s1 = emptyStats(); s1.sig_strikes_landed = 10; s1.knockdowns = 0;
    const s2 = emptyStats(); s2.sig_strikes_landed = 10; s2.knockdowns = 0;
    a.eq(snapshotHash(1, s1), snapshotHash(1, s2));
  });

  T("THE CLOCK IS NOT IN THE HASH — this is what stops snapshot spam", (a) => {
    const s = emptyStats(); s.sig_strikes_landed = 10;
    // Same numbers, two different polls seconds apart. If the clock were
    // hashed, every tick would write a row and the timeline would be useless.
    a.eq(snapshotHash(1, s), snapshotHash(1, s));
  });

  T("a changed statistic produces a different hash", (a) => {
    const s1 = emptyStats(); s1.sig_strikes_landed = 10;
    const s2 = emptyStats(); s2.sig_strikes_landed = 11;
    a.ok(snapshotHash(1, s1) !== snapshotHash(1, s2));
  });

  T("the same numbers in a different round do not collide", (a) => {
    const s = emptyStats(); s.sig_strikes_landed = 10;
    a.ok(snapshotHash(1, s) !== snapshotHash(2, s));
  });

  T("null and zero hash differently — they are different claims", (a) => {
    const nul = emptyStats();
    const zero = emptyStats(); zero.knockdowns = 0;
    a.ok(snapshotHash(1, nul) !== snapshotHash(1, zero),
      "'not published' and 'zero happened' must never dedup together");
  });

  /* ── idle detection ────────────────────────────────────────────────────── */
  const HOUR = 3600000;
  const now = Date.parse("2026-08-15T20:00:00Z");

  T("NO ACTIVE EVENT: a card three days out is outside the window", (a) => {
    a.eq(isEventInWindow({ status: "pre", start_time: "2026-08-18T20:00:00Z" }, now, 4 * HOUR, 5 * HOUR), false);
  });

  T("UPCOMING EVENT: a card two hours out is inside the window", (a) => {
    a.eq(isEventInWindow({ status: "pre", start_time: "2026-08-15T22:00:00Z" }, now, 4 * HOUR, 5 * HOUR), true);
  });

  T("ACTIVE EVENT: a live card is captured", (a) => {
    a.eq(isEventInWindow({ status: "in", start_time: "2026-08-15T19:00:00Z" }, now, 4 * HOUR, 5 * HOUR), true);
  });

  T("COMPLETED EVENT: still captured briefly so the result and finals land", (a) => {
    a.eq(isEventInWindow({ status: "post", start_time: "2026-08-15T17:00:00Z" }, now, 4 * HOUR, 5 * HOUR), true);
    a.eq(isEventInWindow({ status: "post", start_time: "2026-08-14T00:00:00Z" }, now, 4 * HOUR, 5 * HOUR), false);
  });

  T("A ROW STUCK AT 'in' FOREVER DOES NOT PIN THE POLLER TO A DEAD EVENT", (a) => {
    a.eq(isEventInWindow({ status: "in", start_time: "2026-07-01T20:00:00Z" }, now, 4 * HOUR, 5 * HOUR), false,
      "the same staleness discipline the UI already applies to live_events");
  });

  T("CANCELLED and POSTPONED events are handled without crashing", (a) => {
    a.eq(isEventInWindow({ status: "canceled", start_time: "2026-08-15T21:00:00Z" }, now, 4 * HOUR, 5 * HOUR), false);
    a.eq(isEventInWindow({ status: "postponed", start_time: "2026-08-15T21:00:00Z" }, now, 4 * HOUR, 5 * HOUR), true,
      "a postponed card still has a start time in the window and is cheap to re-check");
  });

  T("a missing or unparseable start time never throws", (a) => {
    a.eq(isEventInWindow({ status: "pre", start_time: null }, now, 4 * HOUR, 5 * HOUR), false);
    a.eq(isEventInWindow({ status: "pre", start_time: "not a date" }, now, 4 * HOUR, 5 * HOUR), false);
    a.eq(isEventInWindow({}, now, 4 * HOUR, 5 * HOUR), false);
  });

  /* ── prioritization ────────────────────────────────────────────────────── */
  T("MULTIPLE SIMULTANEOUS FIGHTS: live first, then upcoming, then card order", (a) => {
    const b = (fight_id: string, status: string, fight_order: number) =>
      ({ fight_id, status, fight_order } as any);
    const order = prioritizeBouts([
      b("done1", "post", 1), b("next2", "pre", 5), b("live1", "in", 3),
      b("next1", "pre", 4), b("live2", "in", 2),
    ]).map((x: any) => x.fight_id);
    a.eq(order, ["live2", "live1", "next1", "next2", "done1"]);
  });

  T("bouts with no order still sort deterministically", (a) => {
    const out = prioritizeBouts([
      { fight_id: "a", status: null, fight_order: null } as any,
      { fight_id: "b", status: "in", fight_order: null } as any,
    ]);
    a.eq(out[0].fight_id, "b");
  });

  /* ── freshness ─────────────────────────────────────────────────────────── */
  T("sourceFreshnessSeconds measures the PROVIDER's staleness, not ours", (a) => {
    a.eq(sourceFreshnessSeconds("2026-08-15T19:59:30Z", now), 30);
    a.eq(sourceFreshnessSeconds(null, now), null);
    a.eq(sourceFreshnessSeconds("garbage", now), null);
  });

  /* ── fighter resolution ────────────────────────────────────────────────── */
  T("a fighter resolves through normalized name matching", (a) => {
    const ix = buildFighterIndex([
      { fighter_id: "f1", full_name: "Conor McGregor" },
      { fighter_id: "f2", full_name: "José Aldó" },
    ]);
    a.eq(resolveFighter("Conor McGregor", ix).fighter_id, "f1");
    a.eq(resolveFighter("Jose Aldo Jr.", ix).fighter_id, "f2", "accents and suffixes reconcile");
  });

  T("MISSING FIGHTER: an unknown name resolves to nothing, not to a neighbour", (a) => {
    const ix = buildFighterIndex([{ fighter_id: "f1", full_name: "Conor McGregor" }]);
    const r = resolveFighter("Somebody Debuting", ix);
    a.eq(r.fighter_id, null);
    a.eq(r.match_method, "unresolved");
  });

  T("AN AMBIGUOUS NAME RESOLVES TO NOTHING — never to a coin flip", (a) => {
    const ix = buildFighterIndex([
      { fighter_id: "f1", full_name: "John Smith" },
      { fighter_id: "f2", full_name: "John Smith" },
    ]);
    const r = resolveFighter("John Smith", ix);
    a.eq(r.fighter_id, null, "attaching one man's career to another man's fight is the worst outcome here");
    a.eq(r.match_method, "ambiguous");
  });

  T("buildFighterIndex survives malformed rows", (a) => {
    const ix = buildFighterIndex([
      { fighter_id: "f1", full_name: "Real Fighter" },
      { fighter_id: null, full_name: "No Id" } as any,
      { fighter_id: "f3", full_name: null } as any,
      null as any, undefined as any,
    ]);
    a.eq(resolveFighter("Real Fighter", ix).fighter_id, "f1");
    a.eq(ix.size, 1, "junk rows are skipped, not indexed");
  });

  /* ── transport: the required HTTP failure modes ────────────────────────── */
  const cfg = { timeoutMs: 50, retries: 2, backoffBaseMs: 1, backoffMaxMs: 2 };
  const withFetch = async (impl: any, fn: (t: any) => Promise<void>) => {
    const orig = (globalThis as any).fetch;
    (globalThis as any).fetch = impl;
    try { await fn(new Telemetry()); } finally { (globalThis as any).fetch = orig; }
  };
  const res = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  T("HTTP 200 returns parsed data and counts one request", async (a) => {
    await withFetch(async () => res(200, { hello: 1 }), async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, true); a.eq(r.data.hello, 1);
      a.eq(t.api_requests, 1); a.eq(t.api_failures, 0);
      a.eq(t.http_status["200"], 1);
    });
  });

  T("HTTP 401 FAILS FAST — retrying bad credentials just burns quota", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; return res(401, { error: "unauthorized" }); }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, false); a.eq(r.status, 401);
      a.eq(calls, 1, "a 401 must not be retried");
      a.eq(t.http_status["401"], 1);
    });
  });

  T("HTTP 429 IS RETRIED and counted as a rate limit", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; return res(429, { error: "slow down" }); }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.status, 429);
      a.eq(calls, 3, "initial attempt plus 2 retries");
      a.eq(t.rate_limited, 3);
    });
  });

  T("HTTP 429 honours Retry-After when the provider sends one", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; return calls === 1 ? res(429, {}, { "retry-after": "0" }) : res(200, { ok: 1 }); },
      async (t) => {
        const r = await httpGet("http://x", {}, t, cfg);
        a.eq(r.ok, true, "it recovers on the retry");
        a.eq(t.rate_limited, 1);
      });
  });

  T("HTTP 500 IS RETRIED then reported with its status", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; return res(500, { error: "boom" }); }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, false); a.eq(r.status, 500);
      a.eq(calls, 3, "5xx is transient, so it is retried");
      a.eq(t.http_status["500"], 3);
    });
  });

  T("HTTP 500 that recovers on retry succeeds", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; return calls < 3 ? res(500, {}) : res(200, { ok: 1 }); }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, true); a.eq(r.data.ok, 1);
    });
  });

  T("API TIMEOUT aborts, retries, and is counted as a timeout", async (a) => {
    await withFetch((_u: string, o: any) => new Promise((_res, rej) => {
      o.signal.addEventListener("abort", () => {
        const e: any = new Error("aborted"); e.name = "AbortError"; rej(e);
      });
    }), async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, false);
      a.eq(t.api_timeouts, 3, "each attempt timed out");
      a.ok(String(r.detail).includes("timeout"));
    });
  });

  T("A 200 WITH A NON-JSON BODY is a broken source, not a retry candidate", async (a) => {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => { throw new Error("Unexpected token <"); }, text: async () => "<html>" };
    }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, false);
      a.eq(calls, 1, "asking again returns the same garbage and costs quota");
      a.ok(String(r.detail).includes("non-JSON"));
    });
  });

  T("a network throw is retried and reported", async (a) => {
    let calls = 0;
    await withFetch(async () => { calls++; throw new Error("ECONNRESET"); }, async (t) => {
      const r = await httpGet("http://x", {}, t, cfg);
      a.eq(r.ok, false); a.eq(calls, 3);
      a.eq(t.api_failures, 3);
    });
  });

  /* ── bounded concurrency ───────────────────────────────────────────────── */
  T("mapLimit never exceeds its concurrency ceiling", async (a) => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapLimit(items, 4, async (x: number) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--; return x * 2;
    });
    a.ok(peak <= 4, `peak concurrency was ${peak}, ceiling is 4`);
    a.eq(out.length, 20);
    a.eq(out[19], 38, "results stay in input order");
  });

  T("mapLimit handles an empty list", async (a) => {
    a.eq((await mapLimit([], 4, async () => 1)).length, 0);
  });

  return cases;
}

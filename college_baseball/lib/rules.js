'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the versioned game-rules registry.

   A rule is used to price a game only with the evidence that it governs that
   game. Each entry below carries its status:

     STRUCTURAL   true of baseball itself (the home side bats last; it does not
                  bat when already winning; a walk-off ends the game)
     MEASURED     inferred from this warehouse's own innings data, with the
                  measurement in validation/rules_evidence.json
     DOMAIN       a widely published NCAA convention I have NOT verified against
                  the official rule book from this environment (stats.ncaa.org
                  and ncaa.org are unreachable here). Used only where MEASURED
                  data agrees with it, and listed as an open item
                  (research/UNRESOLVED.md).
     UNVERIFIED   not used to price anything.

   NEVER A SEVEN-INNING GAME PRICED AS NINE. A game's scheduled length is not
   in the source's schedule. For history it is inferred from innings played
   (inferScheduled, with an explicit basis); for an upcoming game it is a
   probability (scheduledLengthPrior) learned from measured history by
   context (doubleheader game, season), and the simulator prices the mixture.

   NEVER A RUN RULE APPLIED UNIVERSALLY. Whether a ten-run rule ends games is
   measured per context (conference game, non-conference, inferred NCAA
   tournament) as the share of games that stopped early when the margin
   allowed it; the simulator applies it with that measured probability.
   =========================================================================== */
const RULES_VERSION = 'cbase_rules_v1';

const REGISTRY = [
  { id: 'R01', rule: 'Home team bats last', status: 'STRUCTURAL', applies: 'all' },
  { id: 'R02', rule: 'Home team does not bat in the bottom of the final scheduled inning when leading', status: 'STRUCTURAL', applies: 'all', check: 'validation/rules_evidence.json home_not_batting_when_leading' },
  { id: 'R03', rule: 'A game tied after the scheduled innings continues by full innings until one side leads after a complete inning, or the home side takes the lead (walk-off)', status: 'STRUCTURAL', applies: 'all' },
  { id: 'R04', rule: 'Regulation length is nine innings', status: 'DOMAIN', applies: 'default', evidence: 'innings-played distribution, 2017-2026' },
  { id: 'R05', rule: 'Doubleheader games may be scheduled for seven innings (by conference rule or agreement)', status: 'MEASURED', applies: 'doubleheaders', evidence: 'share of DH games ending after 7 with a margin < 10, by DH game number and season' },
  { id: 'R06', rule: 'A ten-run lead after seven innings (by conference rule or agreement) may end a game', status: 'MEASURED', applies: 'context-specific probability', evidence: 'share of games with a 10+ margin after 7 complete that stopped, by context' },
  { id: 'R07', rule: 'Extra innings start with the bases empty (no automatic runner)', status: 'MEASURED', applies: 'all', evidence: 'mean runs per extra half-inning vs innings 1-9; an automatic runner on second would raise it by roughly 0.5 runs' },
  { id: 'R08', rule: 'A game called for weather after five innings (4.5 with the home side ahead) is official', status: 'DOMAIN', applies: 'history only; never priced', evidence: 'games ending before the 7th with a margin < 10' },
  { id: 'R09', rule: 'Suspended games are resumed from the point of suspension', status: 'UNVERIFIED', applies: 'not priced: the source does not mark suspensions' },
];

function parseLine(s) { return String(s || '').trim() ? String(s).trim().split(/\s+/).map((v) => (v === 'x' ? null : Number(v))) : []; }
function runsThrough(line, k) { let s = 0; for (let i = 0; i < Math.min(k, line.length); i++) s += line[i] || 0; return s; }

/** pure: innings history of one completed game -> {scheduled, basis, ended_early, run_rule} */
function inferScheduled(g) {
  const a = parseLine(g.away_line); const h = parseLine(g.home_line);
  const n = Math.max(a.length, h.length) || g.innings_played || null;
  if (!n) return { scheduled: null, basis: 'UNKNOWN_NO_INNINGS', ended_early: null, run_rule: null };
  const marginAfter = (k) => Math.abs(runsThrough(a, k) - runsThrough(h, k));
  const tiedAfter = (k) => a.length >= k && h.length >= k && runsThrough(a, k) === runsThrough(h, k);
  const finalMargin = Math.abs(runsThrough(a, n) - runsThrough(h, n));
  if (n >= 10) {
    if (tiedAfter(9)) return { scheduled: 9, basis: 'EXTRA_AFTER_9', ended_early: 0, run_rule: 0 };
    if (tiedAfter(7)) return { scheduled: 7, basis: 'EXTRA_AFTER_7', ended_early: 0, run_rule: 0 };
    return { scheduled: 9, basis: 'PLAYED_10_PLUS_UNTIED', ended_early: 0, run_rule: 0 };
  }
  if (n === 9) {
    if (tiedAfter(7) && g.dh) return { scheduled: null, basis: 'AMBIGUOUS_9_OR_7_PLUS_2', ended_early: 0, run_rule: 0 };
    return { scheduled: 9, basis: 'PLAYED_9', ended_early: 0, run_rule: 0 };
  }
  if (n === 8) {
    if (tiedAfter(7)) return { scheduled: 7, basis: 'EXTRA_AFTER_7', ended_early: 0, run_rule: 0 };
    if (finalMargin >= 10) return { scheduled: 9, basis: 'RUN_RULE_AFTER_8', ended_early: 1, run_rule: 1 };
    return { scheduled: 9, basis: 'ENDED_AFTER_8_UNCLEAR', ended_early: 1, run_rule: 0 };
  }
  if (n === 7) {
    if (finalMargin >= 10) return { scheduled: g.dh ? 7 : 9, basis: g.dh ? 'SEVEN_OR_RUN_RULE_DH' : 'RUN_RULE_AFTER_7', ended_early: g.dh ? null : 1, run_rule: g.dh ? null : 1 };
    return { scheduled: 7, basis: 'ENDED_AFTER_7', ended_early: 0, run_rule: 0 };
  }
  /* fewer than seven innings */
  if (finalMargin >= 10) return { scheduled: null, basis: 'RUN_RULE_EARLY', ended_early: 1, run_rule: 1 };
  return { scheduled: null, basis: 'SHORTENED', ended_early: 1, run_rule: 0 };
}

/**
 * The scheduled-length prior for an upcoming game, from measured history.
 * evidence: { by_context: { key: {n, seven} } } built by measure(); a context
 * with fewer than `minN` games falls back to its parent (dh -> all).
 */
function scheduledLengthPrior(ctx, evidence, minN) {
  minN = minN || 100;
  const keys = [];
  if (ctx.dh) keys.push(`dh${ctx.dh}:${ctx.season}`, `dh${ctx.dh}`);
  keys.push(ctx.dh ? 'dh' : 'single:' + ctx.season, ctx.dh ? 'dh' : 'single');
  for (const k of keys) {
    const e = evidence && evidence.by_context && evidence.by_context[k];
    if (e && e.n >= minN) return { p7: e.seven / e.n, n: e.n, context: k };
  }
  return { p7: ctx.dh ? 0.5 : 0.02, n: 0, context: 'DEFAULT_UNMEASURED' };
}

/** run-rule probability given a 10+ margin after 7 complete innings, by context */
function runRuleProbability(ctx, evidence, minN) {
  minN = minN || 50;
  const keys = [ctx.ncaa_tourney ? 'ncaa_tourney' : (ctx.conf_game ? 'conf' : 'nonconf'), 'all'];
  for (const k of keys) {
    const e = evidence && evidence.run_rule && evidence.run_rule[k];
    if (e && e.eligible >= minN) return { p: e.stopped / e.eligible, n: e.eligible, context: k };
  }
  return { p: 0, n: 0, context: 'NOT_APPLIED_NO_EVIDENCE' };
}

/** measure rule evidence from completed games with innings lines */
function measure(games) {
  const by = {}; const add = (k, seven) => { if (!by[k]) by[k] = { n: 0, seven: 0 }; by[k].n++; if (seven) by[k].seven++; };
  const rr = {}; const addRR = (k, stopped) => { if (!rr[k]) rr[k] = { eligible: 0, stopped: 0 }; rr[k].eligible++; if (stopped) rr[k].stopped++; };
  let homeLeadNoBat = 0; let homeLeadAfterTop = 0; let homeBatWhenLeading = 0; let homeZeroRecorded = 0;
  const extraRuns = { n: 0, runs: 0 }; const regRuns = { n: 0, runs: 0 };
  for (const g of games) {
    const a = parseLine(g.away_line); const h = parseLine(g.home_line);
    if (!a.length) continue;
    const inf = inferScheduled(g);
    if (inf.scheduled === 7 || inf.scheduled === 9) {
      const seven = inf.scheduled === 7 ? 1 : 0;
      if (g.dh) { add(`dh${g.dh}:${g.season}`, seven); add(`dh${g.dh}`, seven); add('dh', seven); }
      else { add('single:' + g.season, seven); add('single', seven); }
    }
    /* run rule: games scheduled for nine with a 10+ margin after seven complete innings */
    if (a.length >= 7 && h.length >= 7 && h[6] != null && inf.scheduled !== 7 && !(g.dh && inf.basis === 'SEVEN_OR_RUN_RULE_DH')) {
      const m = Math.abs(runsThrough(a, 7) - runsThrough(h, 7));
      if (m >= 10) {
        const k = g.ncaa_tourney_inferred ? 'ncaa_tourney' : (g.conf_game ? 'conf' : 'nonconf');
        const stopped = a.length === 7 ? 1 : 0;
        addRR(k, stopped); addRR('all', stopped);
      }
    }
    /* R02: in the final SCHEDULED inning the home side bats only if not already
       ahead. Only games that went exactly their scheduled length count (a
       run-rule game legitimately lets the home side bat in the 7th). The
       source writes an unplayed bottom half as 0 as often as x, so a 0 is
       recorded as a convention; runs scored there would be a real violation. */
    const n = a.length;
    if (h.length === n && inf.scheduled === n && !inf.ended_early) {
      const awayTotal = runsThrough(a, n); const homeBefore = runsThrough(h, n - 1);
      if (homeBefore > awayTotal) {
        homeLeadAfterTop++;
        if (h[n - 1] == null) homeLeadNoBat++;
        else if (h[n - 1] === 0) homeZeroRecorded++;
        else homeBatWhenLeading++;
      }
    }
    for (let i = 0; i < n; i++) {
      for (const line of [a, h]) {
        const v = line[i]; if (v == null) continue;
        if (i >= 9) { extraRuns.n++; extraRuns.runs += v; } else { regRuns.n++; regRuns.runs += v; }
      }
    }
  }
  return {
    rules_version: RULES_VERSION, by_context: by, run_rule: rr,
    home_not_batting_when_leading: { leading_after_top_of_last: homeLeadAfterTop, recorded_x: homeLeadNoBat, recorded_zero_convention: homeZeroRecorded, runs_scored_violation: homeBatWhenLeading },
    extra_inning_runs: { half_innings: extraRuns.n, mean: extraRuns.n ? Math.round(extraRuns.runs / extraRuns.n * 1000) / 1000 : null,
      regulation_mean: regRuns.n ? Math.round(regRuns.runs / regRuns.n * 1000) / 1000 : null },
  };
}

module.exports = { RULES_VERSION, REGISTRY, inferScheduled, scheduledLengthPrior, runRuleProbability, measure, parseLine, runsThrough };

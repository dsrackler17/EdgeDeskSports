#!/usr/bin/env node
/* ===========================================================================
   EDODDSPLAN — the market-data recovery planner (lib/edgedesk_odds_recovery.js)
   and its report (tools/research/odds_recovery_report.js). Hand-checked credit
   rules, cadence and verifiability on a single game, the refresh cap, the
   budget fit, the report on the committed slates — and that nothing here can
   buy anything.
   Run: node tools/intelligence/odds_recovery.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_odds_recovery.js'));
const R = require(path.join(ROOT, 'tools', 'research', 'odds_recovery_report.js'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }

ok('credits: 3 markets over one region = 3 (the incident\'s game-line request)', P.creditsPerRequest({ markets: 3, regions: 1 }) === 3);
ok('credits: a 12-book list counts two regions; us,eu counts two', P.creditsPerRequest({ markets: 3, bookmakers: 12 }) === 6 && P.creditsPerRequest({ markets: 3, regions: 2 }) === 6 && P.creditsPerRequest({ markets: 3, bookmakers: 10 }) === 3);
ok('readiness limits match EDINTEL\'s quote_ttl_buckets', P.ttlFor(0.25) === 5 && P.ttlFor(1) === 15 && P.ttlFor(4) === 45 && P.ttlFor(12) === 90 && P.ttlFor(48) === 180 && P.ttlFor(100) === 360);
const intel = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'), 'utf8');
ok('…read from the same source the readiness state uses', /\{ name: 'imminent', max_hours_to_start: 0\.5, minutes: 5 \}/.test(intel) && /\{ name: 'close', max_hours_to_start: 2, minutes: 15 \}/.test(intel) && /\{ name: 'soon', max_hours_to_start: 6, minutes: 45 \}/.test(intel));
const cron = fs.readFileSync(path.join(ROOT, 'supabase', 'capture_cron.sql'), 'utf8');
ok('the gateway cadence is the one capture_cron.sql documents (60 / 120 / 360 min; hourly floor since 2026-10-21)', /60 min inside 24 h of its next\s*\n?--\s*kickoff, 2 h inside 72 h, 6 h beyond/.test(cron) && JSON.stringify(P.GATEWAY_CADENCE) === JSON.stringify([[24, 60], [72, 120], [Infinity, 360]]));

/* one game, kickoff 3 hours after the window opens: gateway cadence 60 min (the hourly floor) → captures at T-180, T-120, T-60 */
const one = P.simulate({ sports: { x: ['2026-10-13T03:00:00Z'] }, from: '2026-10-13T00:00:00Z', to: '2026-10-13T03:00:00Z' });
ok('one game, 3 hours: a request every hour → 3 requests, 9 credits', one.requests === 3 && one.credits === 9, one);
ok('…inside 30 min the last capture is 30–60 min old, so the 5-min limit never holds (0 of 30); 0.5–2 h 32 of 90 (16 minutes after each of T-120 and T-60); 2–3 h 46 of 60 (45-min limit after T-180)', one.verifiable['≤0.5 h'].ok === 0 && one.verifiable['≤0.5 h'].minutes === 30 && one.verifiable['0.5–2 h'].ok === 32 && one.verifiable['0.5–2 h'].minutes === 90 && one.verifiable['2–6 h'].ok === 46, one.verifiable);
const al = P.simulate({ sports: { x: ['2026-10-13T03:00:00Z'] }, from: '2026-10-13T00:00:00Z', to: '2026-10-13T03:00:00Z', cadence: R.ALIGNED });
ok('aligned cadence: every near-kickoff minute is verifiable, at a cost', al.verifiable['≤0.5 h'].share === 1 && al.verifiable['0.5–2 h'].share === 1 && al.verifiable['2–6 h'].share === 1 && al.credits > one.credits, [al.credits, al.verifiable]);
const capped = P.simulate({ sports: { x: ['2026-10-13T03:00:00Z'] }, from: '2026-10-13T00:00:00Z', to: '2026-10-13T03:00:00Z', refresh: { enabled: true, within_hours: 6, min_gap_min: 5, daily_credit_cap: 9 } });
ok('research-triggered refresh never spends past its daily cap', capped.refresh.credits <= 9 && capped.refresh.capped_minutes > 0, capped.refresh);
const fitR = P.fit(3562, { planned: 35000, operational: 60000, breaker_latch: 57000 });
ok('fit: planned + proposed against the operational ceiling and the breaker latch', fitR.total === 38562 && fitR.headroom === 21438 && fitR.within === true && fitR.share_of_operational === 0.643, fitR);
ok('fit: a proposal past the latch is reported as not within', P.fit(30000, { planned: 35000 }).within === false);

/* the report on the committed slates */
const s = R.scenarios();
ok('report: football schedules read from the committed NFL and FBS slates', s.football.gateway.by_sport.americanfootball_nfl.games >= 10 && s.football.gateway.by_sport.americanfootball_ncaaf.games >= 30, s.football.gateway.by_sport);
ok('report: the planned cadence leaves the last two hours partly unverifiable; aligned closes it; refresh in between', s.football.gateway.verifiable['≤0.5 h'].share < 0.5 && s.football.aligned.verifiable['≤0.5 h'].share === 1 && s.football.refresh.verifiable['≤0.5 h'].share > s.football.gateway.verifiable['≤0.5 h'].share, [s.football.gateway.verifiable['≤0.5 h'], s.football.refresh.verifiable['≤0.5 h']]);
ok('report: the MLB week is labelled SYNTHETIC', /SYNTHETIC/.test(R.md(s)) && R.mlbSynthetic().length === 105);
ok('report: the recommended mix fits under the breaker latch', /under the 57,000 breaker latch: yes/.test(R.md(s)), R.md(s).split('\n').slice(-1)[0]);

/* nothing here buys anything */
const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_odds_recovery.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'tools', 'research', 'odds_recovery_report.js'), 'utf8');
ok('the planner and its report make no network call and touch no switch', !/\bfetch\s*\(|https?:\/\/[a-z]|odds_api_set_enabled|odds_api_resume|cron\.alter_job|XMLHttpRequest/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

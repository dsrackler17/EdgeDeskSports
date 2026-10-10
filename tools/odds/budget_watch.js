#!/usr/bin/env node
/* ===========================================================================
   ODDS API BUDGET WATCH — an hourly look at the gateway's ledger that spends
   nothing.

   2026-10-10 (docs/odds-api-incident-2026-10/INCIDENT.md): 99,336 of 100,000
   monthly credits went in 9.5 days and nobody was told until the provider
   said no. The gateway (supabase/odds_api_gateway.sql) now raises alerts in
   public.odds_api_alerts at 50 / 80 / 95 % of the monthly budget and on every
   quota refusal; this job turns an unacknowledged critical or emergency alert
   into a red GitHub run, which emails whoever owns the schedule.

   It reads ONE thing: rpc/odds_api_dashboard, with the service role. It never
   calls odds_gateway and never calls the provider, so it costs zero credits.

   Exit 0  normal, or only warnings (printed as ::warning annotations)
   Exit 1  an unacknowledged critical/emergency alert, spend past the day's
           ceiling while the breaker is on, or the dashboard cannot be read

   Run: EDGD_SB_URL=... EDGD_SB_SERVICE=... node tools/odds/budget_watch.js
   =========================================================================== */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'lib', 'odds_gateway.js'));

const n = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

/** The verdict on one dashboard payload. Pure, so the suite can drive it. */
function evaluate(dash) {
  const out = { fail: [], warn: [], info: [] };
  if (!dash || typeof dash !== 'object' || !dash.budget) {
    out.fail.push('the dashboard answered without a budget block: is supabase/odds_api_gateway.sql applied?');
    return out;
  }
  const b = dash.budget, br = dash.breaker || {}, today = dash.today || {};
  if (b.configured === false) { out.fail.push('odds_api_config has no row: apply supabase/odds_api_emergency_stop.sql, then the gateway SQL'); return out; }

  const open = (dash.alerts || []).filter((a) => !a.acknowledged_at);
  const serious = open.filter((a) => a.level === 'critical' || a.level === 'emergency');
  const warnings = open.filter((a) => a.level === 'warning');
  serious.forEach((a) => out.fail.push(a.level.toUpperCase() + ' alert ' + a.code + ' (' + a.at + '): ' + a.message));
  warnings.forEach((a) => out.warn.push('warning alert ' + a.code + ' (' + a.at + '): ' + a.message));

  const spent = n(b.spent_today) || 0, allow = n(b.daily_allowance), budget = n(b.monthly_budget) || 0;
  if (br.enabled) {
    if (budget <= 0) out.fail.push('the breaker is ON with a zero monthly budget: nothing should be bought; pause it (odds_api_admin_pause)');
    if (allow != null && allow > 0 && spent > allow * 1.25) out.fail.push('spent ' + spent + ' credits today against an allowance of ' + allow + ' (more than the 25 % overdraft)');
    if (b.threshold === 'emergency') out.fail.push('the cycle is past the emergency threshold (' + b.budget_used_pct + ' of budget) with the breaker still ON');
    else if (b.threshold === 'critical') out.warn.push('the cycle is past the critical threshold (' + b.budget_used_pct + ' of budget): props and far events are shed');
    if (br.cooldown_until && Date.parse(br.cooldown_until) > Date.now()) out.warn.push('the provider is cooling down until ' + br.cooldown_until + ' (' + (br.cooldown_reason || 'temporary failures') + ')');
  } else {
    out.info.push('paid retrieval is PAUSED (' + (br.reason || 'no reason recorded') + '): readers are served stored snapshots');
    if ((n(today.dispatched) || 0) > 0) out.warn.push(today.dispatched + ' request(s) reached the provider today although the breaker is now off (bought before the pause?)');
  }
  out.info.push('today: ' + spent + ' credits, ' + (n(today.dispatched) || 0) + ' bought, ' + (n(today.cache_hits) || 0) + ' served from cache, '
    + (n(today.collapsed_in_flight) || 0) + ' collapsed in flight, ' + (n(today.denied) || 0) + ' denied');
  out.info.push('cycle: ' + (n(b.spent_cycle) || 0) + ' of ' + budget + ' budget (' + (b.threshold || '?') + '), provider remaining '
    + (b.provider_remaining == null ? 'unknown' : b.provider_remaining) + ', next reset ' + b.next_reset);
  return out;
}

async function main(env, fetchImpl) {
  env = env || process.env;
  const f = fetchImpl || ((...a) => fetch(...a));
  const cfg = G.config(env);
  if (!cfg || !cfg.service) {
    console.log('::warning::EDGD_SB_SERVICE (the service role) is not set: the budget watch cannot read the ledger');
    return 0;
  }
  let dash = null, err = null;
  try {
    const r = await f(cfg.url + '/rest/v1/rpc/odds_api_dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg.service, authorization: 'Bearer ' + cfg.service },
      body: JSON.stringify({ p_days: 2 }),
    });
    const text = await r.text();
    if (!r.ok) err = 'HTTP ' + r.status + ' ' + text.slice(0, 200);
    else { try { dash = JSON.parse(text); } catch (_) { err = 'unreadable answer'; } }
  } catch (e) { err = String(e && e.message || e).slice(0, 200); }
  const v = err ? { fail: ['rpc/odds_api_dashboard failed: ' + err], warn: [], info: [] } : evaluate(dash);
  v.info.forEach((l) => console.log(l));
  v.warn.forEach((l) => console.log('::warning::' + l));
  v.fail.forEach((l) => console.log('::error::' + l));
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      require('fs').appendFileSync(env.GITHUB_STEP_SUMMARY, '## Odds API budget watch\n\n'
        + v.fail.map((l) => '- **FAIL** ' + l).concat(v.warn.map((l) => '- warning: ' + l), v.info.map((l) => '- ' + l)).join('\n') + '\n');
    } catch (_) { /* the summary is a courtesy */ }
  }
  return v.fail.length ? 1 : 0;
}

module.exports = { evaluate, main };
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.log('::error::' + e.message); process.exit(1); });

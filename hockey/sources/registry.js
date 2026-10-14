#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the data-source registry.

     node hockey/sources/registry.js           write hockey/sources/registry.json
     node hockey/sources/registry.js --check   the committed registry is consistent

   Every provider EdgeDesk uses or investigated, with what it may be used for
   and what it actually contributes. STATIC facts (access method, terms as
   the build understood them, cost, coverage) are written here; DYNAMIC facts
   (last successful sync, freshness, measured model contribution) are read
   from the artifacts the pipeline produces, so the registry cannot claim a
   sync or a contribution that did not happen.

   STATUS (one per provider, computed):
     OPERATIONAL             authorised for this use, wired, fresh
     STALE                   wired, but its newest data is older than allowed
     INCOMPLETE              wired, but coverage the models need is missing
     AWAITING_AUTHORISATION  wired, switched off until the owner authorises
                             spend (the odds feed)
     AWAITING_PERMISSION     useful, but its terms require the provider's
                             permission for EdgeDesk's use: not wired, a
                             request is drafted (docs/engine/access-requests/)
     METHODOLOGY_ONLY        only its published methods are used (re-implemented
                             independently); none of its data
     RESEARCH_COPY           a one-off copy used for verification only
     NOT_AVAILABLE           nothing usable exists yet (e.g. a licensed archive)

   TERMS. This build's environment could not reach the providers' sites (its
   egress policy refuses them), so each `terms` entry is the build's reading
   of the provider's published terms and is marked `verified: false` until the
   owner confirms it at the listed URL. A provider is never wired on an
   unverified permissive reading.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');

const OUT = path.join(__dirname, 'registry.json');
const SCHEMA = 'edgedesk_nhl_source_registry_v1';
function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(C.ROOT, p), 'utf8')); } catch (_) { return null; } }

const PROVIDERS = [
  {
    id: 'sportsdataverse_nhl', name: 'sportsdataverse fastRhockey-nhl-data / -raw (public mirror of the NHL\'s own game feeds)',
    url: 'https://github.com/sportsdataverse/fastRhockey-nhl-data', access: 'keyless HTTPS (raw.githubusercontent.com), cached, quota-guarded (engine/http.js)',
    datasets: ['play-by-play with on-ice ids and coordinates', 'goalie box', 'skater box', 'team box', 'game info', 'season schedule (incl. future games)', 'shifts, rosters (available, not yet used)'],
    coverage: '2010-11 → the season in progress, regular season and playoffs',
    terms: { summary: 'repositories MIT-licensed; the game data is the NHL\'s, whose terms restrict commercial use of NHL content', verified: false, url: 'https://www.nhl.com/info/terms-of-service', owner_action: 'confirm before NHL output is sold in a paid tier (already flagged in docs/engine/DATA.md)' },
    authorised_for: ['research', 'modelling', 'storage'], cost: 'free', cadence: 'season in progress every 3 h; every season weekly',
    wired: true, use: 'every production input: shots, xG, ratings, results, starters, lineups; box scores for reconciliation and player research',
  },
  {
    id: 'nhl_api_web', name: 'NHL public web API (api-web.nhle.com)',
    url: 'https://api-web.nhle.com/v1/schedule/{date}', access: 'keyless, undocumented; ≤ 4 requests/s, cached 10 min (hockey/sources/nhl_api.js)',
    datasets: ['today\'s schedule, start times and game states'], coverage: 'live',
    terms: { summary: 'no published terms for automated use; NHL.com terms restrict commercial use', verified: false, url: 'https://www.nhl.com/info/terms-of-service', owner_action: 'as above' },
    authorised_for: ['schedule freshness'], cost: 'free', cadence: 'each slate build (CI only: this build environment cannot reach it)',
    wired: true, use: 'start times and states between mirror refreshes',
  },
  {
    id: 'espn_nhl_pack', name: 'EdgeDesk NHL Data Pack (ESPN public responses, 2024-25)',
    url: 'datapack/nhl_v1', access: 'one-off import, verified (tools/datapack/verify_nhl.js)',
    datasets: ['games, events, shot attempts, player and goalie boxes, officials, lagged features'], coverage: '2024-25 only',
    terms: { summary: 'ESPN public responses; redistribution rights not certified — research copy, never resold', verified: false, url: 'https://disneytermsofuse.com/', owner_action: 'none while it stays a verification copy' },
    authorised_for: ['verification'], cost: 'delivered', cadence: 'fixed', wired: true, research_copy: true,
    use: 'event-by-event second source; it exposed the blocked-shot attribution error',
  },
  {
    id: 'moneypuck', name: 'MoneyPuck', url: 'https://moneypuck.com/data.htm',
    access: 'public CSV downloads (shots, team/skater/goalie season data)', datasets: ['shot-level data with their xG', 'season summaries'], coverage: '2007-08 onward',
    terms: { summary: 'free for non-commercial use with attribution; commercial use requires their permission', verified: false, url: 'https://moneypuck.com/data.htm', owner_action: 'send docs/engine/access-requests/moneypuck.md' },
    authorised_for: [], cost: 'unknown (by agreement)', wired: false, methodology: 'their published xG feature set informed hockey/xg/model.js (re-implemented; none of their code or data)',
    value_if_granted: 'an independent xG to reconcile against ours shot by shot (a second opinion on 2022-23 onward, where the NHL changed how it records locations)',
  },
  {
    id: 'natural_stat_trick', name: 'Natural Stat Trick', url: 'https://www.naturalstattrick.com',
    access: 'web tables', datasets: ['team, skater, line and goalie stats by strength and score state'], coverage: '2007-08 onward',
    terms: { summary: 'the site asks that it not be scraped; data access is offered to supporters for personal use', verified: false, url: 'https://www.naturalstattrick.com', owner_action: 'send docs/engine/access-requests/natural-stat-trick.md' },
    authorised_for: [], cost: 'unknown (by agreement)', wired: false, methodology: 'scoring-chance and high-danger definitions (zones by location, rebound and rush flags) — the same signals are features of our xG model',
    value_if_granted: 'line-combination and score-state tables to reconcile against our own on-ice aggregation',
  },
  {
    id: 'evolving_hockey', name: 'Evolving-Hockey', url: 'https://evolving-hockey.com',
    access: 'subscription web app', datasets: ['RAPM, GAR/xGAR, xG, contracts'], coverage: '2007-08 onward',
    terms: { summary: 'subscriber content; redistribution and automated collection not permitted without agreement', verified: false, url: 'https://evolving-hockey.com', owner_action: 'send docs/engine/access-requests/evolving-hockey.md' },
    authorised_for: [], cost: 'subscription + licence by agreement', wired: false, methodology: 'their published RAPM / GAR / xG write-ups (ridge regression on stints; replacement level) — the reference for any EdgeDesk player-impact work, implemented independently',
    value_if_granted: 'a published player-impact series to benchmark an EdgeDesk RAPM against',
  },
  {
    id: 'hockeyviz', name: 'HockeyViz (Micah McCurdy)', url: 'https://hockeyviz.com',
    access: 'subscription site', datasets: ['team and player visualisations, Magnus model outputs'], coverage: 'recent seasons',
    terms: { summary: 'subscriber content; no data licence for commercial reuse', verified: false, url: 'https://hockeyviz.com', owner_action: 'send docs/engine/access-requests/hockeyviz.md' },
    authorised_for: [], cost: 'subscription', wired: false, methodology: 'score-and-venue adjustment (applied in hockey/model/ratings.js); shot-rate model write-ups',
    value_if_granted: 'methodological review only; no data is needed',
  },
  {
    id: 'hockey_reference', name: 'Hockey-Reference (Sports Reference)', url: 'https://www.hockey-reference.com',
    access: 'web pages; Stathead subscription', datasets: ['historical box scores, standings, player seasons'], coverage: '1917-18 onward',
    terms: { summary: 'automated collection is rate-limited and building a competing database is not permitted; commercial data use needs a licence', verified: false, url: 'https://www.sports-reference.com/data_use.html', owner_action: 'send docs/engine/access-requests/sports-reference.md only if pre-2010 history is wanted' },
    authorised_for: [], cost: 'licence by agreement', wired: false, methodology: null,
    value_if_granted: 'little: the NHL feed covers every season the models use',
  },
  {
    id: 'odds_gateway_nhl', name: 'The Odds API through supabase/functions/odds_gateway', url: 'supabase/odds_api_gateway.sql',
    access: 'one gateway, one quota (odds_api_acquire); row icehockey_nhl created DISABLED; job switch NHL_PRICES', datasets: ['h2h, spreads (puck line), totals by book'], coverage: 'live only',
    terms: { summary: 'commercial API under the account\'s plan', verified: true, url: 'https://the-odds-api.com/terms-and-conditions.html', owner_action: 'authorise spend: odds_api_set_sport(\'icehockey_nhl\', true) and NHL_PRICES=on' },
    authorised_for: ['market comparison (once enabled)'], cost: '≈3 credits per featured call; the gateway cadence caps it at ≈24 credits/day', wired: true, awaiting_authorisation: true,
    use: 'price comparison only; never a model input',
  },
  {
    id: 'closing_archive', name: 'A licensed archive of timestamped NHL closing prices', url: 'hockey/market/closing/<season>.csv',
    access: 'none yet', datasets: ['closing moneyline, puck line, totals with capture times'], coverage: 'none',
    terms: { summary: 'must be licensed (e.g. the odds provider\'s historical endpoint, ≈10 credits per snapshot per market, or a licensed dataset)', verified: false, url: null, owner_action: 'authorise a historical purchase or supply a licensed file' },
    authorised_for: [], cost: 'depends on source', wired: true, not_available: true,
    use: 'the market test (hockey/model/market_test.js) — the only proof of betting value; until it exists no NHL price is called value',
  },
  {
    id: 'confirmed_starters', name: 'Confirmed starting goalies (e.g. team announcements, Daily Faceoff)', url: 'hockey/data/confirmed_starters.json',
    access: 'manual entry with source and time (schema in docs/engine/DATA.md)', datasets: ['the announced starter and when'], coverage: 'manual only',
    terms: { summary: 'team announcements are public; aggregator sites have their own terms — no automated feed is wired', verified: false, url: null, owner_action: 'choose a licensed starter feed, or keep manual entries' },
    authorised_for: ['manual entry'], cost: 'free (manual)', wired: true,
    use: 'replaces the projected starter; diagnostics show projections are right ~66% of the time',
  },
  {
    id: 'sportradar', name: 'Sportradar (the NHL\'s official data distributor)', url: 'https://sportradar.com',
    access: 'commercial API', datasets: ['official play-by-play, injuries, lineups, starters'], coverage: 'live and historical',
    terms: { summary: 'commercial licence', verified: false, url: 'https://sportradar.com', owner_action: 'a quote, only if paid NHL output needs a licensed feed' },
    authorised_for: [], cost: 'paid (quote)', wired: false, methodology: null,
    value_if_granted: 'resolves the commercial-use question and supplies injuries and confirmed lineups in one licensed feed',
  },
];

function freshnessOf() {
  const slate = readJson('hockey/slate.json');
  const man = readJson('hockey/data/manifest.json');
  const cur = man && man.seasons ? man.seasons[String(C.CURRENT_SEASON)] : null;
  const fetched = cur && cur.sources && cur.sources.pbp ? cur.sources.pbp.fetched_at : null;
  return { slate_data_state: slate && slate.readiness ? slate.readiness.data.state : null, latest_completed_game: slate && slate.readiness ? slate.readiness.data.latest_completed_game : null, last_fetch: fetched, manifest_updated_at: man ? man.updated_at : null };
}

/** what each dataset measurably adds out of sample, from the validation files (never asserted) */
function contributions() {
  const wf = readJson('hockey/validation/nhl_walkforward.json');
  const lab = readJson('hockey/validation/nhl_lab.json');
  const pack = readJson('hockey/validation/nhl_pack_features.json');
  const box = readJson('hockey/validation/nhl_crosscheck_box.json');
  const espn = readJson('hockey/validation/nhl_crosscheck_espn.json');
  const c = {};
  const ce = wf && wf.comparisons[wf.selection.chosen + '_vs_elo'];
  if (ce) c.sportsdataverse_nhl = { role: 'PRODUCTION', evidence: 'the production model (expected-goals GLM, ' + wf.selection.chosen + ') beats Elo by ' + ce.mean_diff + ' log loss on ' + ce.n + ' held-out games (95% ' + ce.ci95.join(' to ') + ')', file: 'hockey/validation/nhl_walkforward.json' };
  if (lab && lab.models) {
    const m = (k) => lab.models[k] && lab.models[k].vs_incumbent ? lab.models[k].vs_incumbent.confirmation : null;
    c.goalie_box = { role: 'SCENARIOS', evidence: m('C_goalie_projected') ? 'projected starters change held-out log loss by ' + m('C_goalie_projected').mean_diff + ' (95% ' + m('C_goalie_projected').ci95.join(' to ') + '): real but below the 0.001 bar, so starters drive the goalie scenarios, not the price' : null, file: 'hockey/validation/nhl_lab.json' };
    c.skater_box = { role: 'LINEUP SENSITIVITY, RECONCILIATION, PLAYER RESEARCH', evidence: m('D_lineup_projected') ? 'projected lineups ' + m('D_lineup_projected').mean_diff + ' (95% ' + m('D_lineup_projected').ci95.join(' to ') + '); confirmed lineups help (' + (m('D_lineup_confirmed') || {}).mean_diff + ') but arrive only at warmups' : null, file: 'hockey/validation/nhl_lab.json' };
    const ctx = (lab.ablation && lab.ablation.add || []).find((a) => a.feature === 'all_context');
    c.arenas_and_schedule = { role: 'MEASURED, NOT PRICED', evidence: ctx ? 'travel, time zones, congestion, road trips, form and luck together: ' + ctx.selection_ml_delta + ' on selection, ' + ctx.confirmation_ml_delta + ' on confirmation — ' + ctx.verdict : null, file: 'hockey/validation/nhl_lab.json' };
  }
  if (pack) c.espn_nhl_pack = { role: 'VERIFICATION', evidence: pack.conclusion || 'its lagged features add nothing beyond the model', file: 'hockey/validation/nhl_pack_features.json', crosscheck: espn ? 'games ' + espn.results.compared + ' matched; shot attempts ' + espn.events.matched + ' of ' + espn.events.espn_attempts : null };
  if (box && box.overall) c.boxscore_reconciliation = { role: 'INTEGRITY', evidence: Object.entries(box.overall).map(([k, v]) => k + ' ' + v.rate).join('; '), file: 'hockey/validation/nhl_crosscheck_box.json' };
  return c;
}

function build() {
  const fr = freshnessOf(); const contrib = contributions();
  const providers = PROVIDERS.map((p) => {
    let status;
    if (p.not_available) status = 'NOT_AVAILABLE';
    else if (p.awaiting_authorisation) status = 'AWAITING_AUTHORISATION';
    else if (p.research_copy) status = 'RESEARCH_COPY';
    else if (!p.wired && p.methodology) status = 'METHODOLOGY_ONLY';
    else if (!p.wired) status = 'AWAITING_PERMISSION';
    else if (p.id === 'sportsdataverse_nhl' || p.id === 'nhl_api_web') status = fr.slate_data_state === 'STALE' ? 'STALE' : 'OPERATIONAL';
    else status = 'OPERATIONAL';
    /* a methodology-only provider is also awaiting permission for its data */
    const data_permission = !p.wired && !p.not_available ? 'AWAITING_PERMISSION' : null;
    return Object.assign({}, p, { status, data_permission, last_sync: p.id === 'sportsdataverse_nhl' ? fr.last_fetch : null, contribution: contrib[p.id] || null });
  });
  const counts = {}; for (const p of providers) counts[p.status] = (counts[p.status] || 0) + 1;
  return {
    schema: SCHEMA, generated_at: new Date().toISOString(), counts, freshness: fr,
    datasets_measured: contrib,
    rule: 'a provider is wired only when its terms permit EdgeDesk\'s use; a provider whose data needs permission is AWAITING_PERMISSION with a drafted request, and its published methods may be re-implemented independently (METHODOLOGY_ONLY). More statistics never earn weight by themselves: each dataset\'s contribution is the out-of-sample result in its file.',
    environment_note: 'the build environment that wrote this registry could not reach the providers\' sites (egress policy); terms are marked verified:false until the owner confirms them',
    access_requests: 'docs/engine/access-requests/',
    providers,
  };
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const fails = [];
  if (r.schema !== SCHEMA) fails.push('schema');
  for (const p of r.providers || []) {
    if (!p.status) fails.push(p.id + ' has no status');
    if (p.status === 'OPERATIONAL' && !(p.authorised_for && p.authorised_for.length)) fails.push(p.id + ' is operational without an authorised use');
    if (!p.wired && /^(OPERATIONAL|STALE)$/.test(p.status)) fails.push(p.id + ' is not wired but claims to operate');
    if (p.status === 'AWAITING_PERMISSION' || p.data_permission === 'AWAITING_PERMISSION') { const f = path.join(C.ROOT, 'docs', 'engine', 'access-requests'); if (!fs.existsSync(f)) fails.push('no access-request drafts'); }
  }
  if (fails.length) { console.error('[nhl registry --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl registry --check] ok: ' + r.providers.length + ' providers ' + JSON.stringify(r.counts));
}

if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else { const r = build(); fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n'); console.log('[nhl registry] ' + r.providers.length + ' providers ' + JSON.stringify(r.counts)); }
}
module.exports = { build, PROVIDERS, SCHEMA };

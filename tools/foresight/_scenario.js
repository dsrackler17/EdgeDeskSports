'use strict';
/* ===========================================================================
   Market Foresight — the shared test scenario for the worker and page suites.

   The DraftKings quotes and EdgeDesk forecasts are the REAL committed records,
   evaluated as of a fixed instant. Kalshi and the Collective live only in the
   database, so for ONE real game this seeds, in a THROWAWAY database only:
     - Kalshi markets for both teams, the home market quoted every 5 minutes
       for its last 79 hours along DraftKings' de-vigged path, two cents wide;
     - three listed Collective models and one revision inside the lock.
   TEST DATA ONLY: never written anywhere but the throwaway cluster, and every
   page or screenshot made from it is labelled as test-seeded.
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = require('./sources.js');
const C = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const lit = PG.lit;

const NOW = '2026-10-25T06:00:00.000Z';
const ADMIN = '00000000-0000-0000-0000-0000000000cc';
const SUB = '00000000-0000-0000-0000-0000000000aa';

/* ONE real CFB game: an EdgeDesk forecast captured live 4-70 h before
   kickoff with a fresh DraftKings moneyline before it, kicked off before NOW */
function pickGame(log) {
  const local = SRC.readLocal(ROOT, log || []);
  const cfb = local.sports.cfb, nowMs = Date.parse(NOW);
  const pick = Object.keys(cfb.events).sort().map((id) => cfb.events[id]).filter((ev) => {
    const K = Date.parse(ev.kickoff);
    if (K > nowMs - 6 * 3600000 || ev.state !== 'FINAL') return false;
    const ml = (cfb.dk.byGame[ev.event_id] || []).filter((q) => q.market_type === 'moneyline');
    const f = cfb.edgedesk.forecasts.filter((x) => x.event_id === ev.event_id && x.evidence === 'ledger_captured' && x.values.moneyline !== null);
    return ml.length >= 6 && f.length && K - Date.parse(f[0].published_at) < 70 * 3600000 && K - Date.parse(f[0].published_at) > 4 * 3600000
      && ml.some((q) => Date.parse(q.observed_at) <= Date.parse(f[0].published_at) && Date.parse(f[0].published_at) - Date.parse(q.observed_at) < 300 * 60000);
  })[0] || null;
  return { pick, local };
}

const M = { M1: 'd0000000-0000-0000-0000-000000000001', M2: 'd0000000-0000-0000-0000-000000000002', M3: 'd0000000-0000-0000-0000-000000000003' };

/* the project's entitlement and operator rules, then the layer */
function install(db, opts) {
  opts = opts || {};
  db.sql(`create or replace function public.community_is_entitled(u uuid) returns boolean language sql stable as $$ select u = ${lit(opts.entitled || '00000000-0000-0000-0000-000000000000')}::uuid $$;
    create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select auth.uid() = ${lit(ADMIN)}::uuid $$;`);
  db.applyFile(path.join(ROOT, 'supabase', 'market_foresight.sql'));
}

function seed(db, pick, local) {
  const K = Date.parse(pick.kickoff);
  const RULES = 'If ' + pick.home + ' wins the game, including any overtime, the market resolves to Yes.';
  db.sql(`create table public.kalshi_markets (ticker text primary key, series_ticker text, rules_primary text);
    create table public.kalshi_game_links (market_ticker text primary key, event_ticker text, series_ticker text, sport text, yes_team text, opponent text,
      home_team text, away_team text, kickoff_at timestamptz, game_id text);
    create table public.kalshi_price_snapshots (id bigint generated always as identity primary key, ticker text, captured_at timestamptz, yes_bid numeric, yes_ask numeric,
      no_bid numeric, no_ask numeric, last_price numeric, yes_bid_size numeric, yes_ask_size numeric, volume numeric, open_interest numeric);
    create table public.kalshi_readiness (x int);
    insert into public.kalshi_markets values ('KXNCAAFGAME-T-HOME', 'KXNCAAFGAME', ${lit(RULES)}), ('KXNCAAFGAME-T-AWAY', 'KXNCAAFGAME', ${lit(RULES.replace(pick.home, pick.away))});
    insert into public.kalshi_game_links values
      ('KXNCAAFGAME-T-HOME', 'KXNCAAFGAME-T', 'KXNCAAFGAME', 'cfb', ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.kickoff)}, ${lit(pick.event_id)}),
      ('KXNCAAFGAME-T-AWAY', 'KXNCAAFGAME-T', 'KXNCAAFGAME', 'cfb', ${lit(pick.away)}, ${lit(pick.home)}, ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.kickoff)}, ${lit(pick.event_id)});`);
  const ml = local.sports.cfb.dk.byGame[pick.event_id].filter((q) => q.market_type === 'moneyline').sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const fairAt = (t) => { let p = null; ml.forEach((q) => { if (Date.parse(q.observed_at) <= t) { const d = C.noVigTwoWay(q.price_home, q.price_away); if (d) p = d.a; } }); return p; };
  const snaps = [];
  for (let t = K - 79 * 3600000, v = 1000; t < K; t += 5 * 60000, v += 3) {
    const p = fairAt(t); if (p === null) continue;
    const mid = Math.min(0.97, Math.max(0.03, Math.round(p * 100) / 100));
    snaps.push('(' + ["'KXNCAAFGAME-T-HOME'", lit(new Date(t).toISOString()), (mid - 0.01).toFixed(2), (mid + 0.01).toFixed(2), 'null', 'null', mid.toFixed(2), 50, 60, v, 500].join(',') + ')');
  }
  db.sql('insert into public.kalshi_price_snapshots (ticker, captured_at, yes_bid, yes_ask, no_bid, no_ask, last_price, yes_bid_size, yes_ask_size, volume, open_interest) values ' + snaps.join(',') + ';');
  const C1 = 'c0000000-0000-0000-0000-000000000001', C2 = 'c0000000-0000-0000-0000-000000000002', C3 = 'c0000000-0000-0000-0000-000000000003';
  const at = (h) => lit(new Date(K + h * 3600000).toISOString());
  db.sql(`create schema collective;
    create table collective.teams (id text primary key, name text, code text);
    create table collective.games (id uuid primary key, sport_code text, season int, week int, kickoff_at timestamptz, home_team_id text, away_team_id text, status text, external_ref text);
    create table collective.creators (id uuid primary key, slug text, display_name text, is_listed boolean, status text, removed_at timestamptz);
    create table collective.models (id uuid primary key, creator_id uuid, slug text, name text, sport_code text, is_listed boolean, source_kind text, source_ref text);
    create table collective.projections (id uuid primary key default gen_random_uuid(), model_id uuid, game_id uuid, received_at timestamptz, projected_spread numeric,
      projected_total numeric, home_win_prob numeric, data_origin text, resolution_status text);
    insert into collective.teams values ('T_HOME', ${lit(pick.home)}, null), ('T_AWAY', ${lit(pick.away)}, null);
    insert into collective.games values ('e0000000-0000-0000-0000-000000000001', 'NCAAF', 2026, 8, ${lit(pick.kickoff)}, 'T_HOME', 'T_AWAY', 'final', ${lit('espn:' + pick.event_id)});
    insert into collective.creators values (${lit(C1)}, 'one', 'Test creator one', true, 'active', null), (${lit(C2)}, 'two', 'Test creator two', true, 'active', null), (${lit(C3)}, 'three', 'Test creator three', true, 'active', null);
    insert into collective.models values (${lit(M.M1)}, ${lit(C1)}, 'one-cfb', 'Alpha (test)', 'NCAAF', true, null, null), (${lit(M.M2)}, ${lit(C2)}, 'two-cfb', 'Beta (test)', 'NCAAF', true, null, null),
      (${lit(M.M3)}, ${lit(C3)}, 'three-cfb', 'Gamma (test)', 'NCAAF', true, null, null);
    insert into collective.projections (model_id, game_id, received_at, projected_spread, projected_total, home_win_prob, data_origin, resolution_status) values
      (${lit(M.M1)}, 'e0000000-0000-0000-0000-000000000001', ${at(-30)}, -3.5, 50.5, 0.62, 'live', 'resolved'),
      (${lit(M.M2)}, 'e0000000-0000-0000-0000-000000000001', ${at(-27)}, -6.0, 52.0, 0.70, 'live', 'resolved'),
      (${lit(M.M3)}, 'e0000000-0000-0000-0000-000000000001', ${at(-26)}, 2.0, 47.0, 0.45, 'live', 'resolved'),
      (${lit(M.M1)}, 'e0000000-0000-0000-0000-000000000001', ${at(-0.2)}, -9.0, 50.5, 0.80, 'live', 'resolved');
    create view public.collective__games as select * from collective.games;
    create view public.collective__teams as select * from collective.teams;
    create view public.collective__models as select * from collective.models;
    create view public.collective__creators as select * from collective.creators;
    create view public.collective__projections as select * from collective.projections;
    grant select on public.collective__games, public.collective__teams, public.collective__models, public.collective__creators, public.collective__projections,
      public.kalshi_markets, public.kalshi_game_links, public.kalshi_price_snapshots, public.kalshi_readiness to service_role;`);
  return { RULES, snaps: snaps.length };
}

/* the stand-in serves public only, so the Collective is reached through views */
function collectiveFetch(stand) {
  return (url, init) => {
    const h = (init && init.headers) || {};
    return stand.fetch(h['Accept-Profile'] === 'collective' ? url.replace('/rest/v1/', '/rest/v1/collective__') : url, init);
  };
}

module.exports = { NOW, ADMIN, SUB, M, pickGame, install, seed, collectiveFetch };

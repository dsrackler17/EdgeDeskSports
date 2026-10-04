#!/usr/bin/env node
/* ============================================================================
   EXTRA MARKETS — the door, and the honest report that nothing is behind it.

   The staking kernel refuses to size a team total or a player prop unless a
   SEPARATELY VALIDATED model for that market is registered. There is no path
   that approximates a prop from a game line, by design: a 47.5 game total and
   a 24.5 team total are not the same random variable, and pricing the second
   off the first would be a projection nobody validated wearing a number
   somebody did.

   That refusal was previously unopenable from outside the code. This script
   is the opening: it looks for what a registration would need, and writes
   football/validation/markets_extra.json with whatever qualified.

   AS OF TODAY IT QUALIFIES NOTHING, and the artifact says so with the reason
   per market rather than being absent. Neither closing-line archive carries a
   team total or a player prop line at all:

     lines_nfl.json close: home_line, home_spread_odds, away_spread_odds,
                           total, over_odds, under_odds,
                           home_moneyline, away_moneyline
     lines_cfb.json close: home_line, total, books

   So there is no history to hold out, no record to grade, and no tier to
   award. Collecting those lines is the prerequisite; this script is what will
   read them when they exist, and what states their absence until then.

   Run: node tools/intelligence/validate_extra_markets.js [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { writeIfChanged } = require(path.join(ROOT, 'tools', 'football', 'write_if_changed.js'));

const SCHEMA = 'edgedesk_extra_markets_v1';
const OUT = path.join(ROOT, 'football', 'validation', 'markets_extra.json');

/* Every market the kernel will consider opening, and the exact archive field
   a validation of it would have to read. A market is listed here so its
   absence is a stated absence rather than an oversight. */
const WANTED = [
  { sport: 'americanfootball_nfl', market: 'team_totals', archive: 'football/pricing/lines_nfl.json',
    needs: ['close.home_team_total', 'close.away_team_total', 'close.home_team_total_over_odds'],
    outcome: 'home_points and away_points, which the archive already carries' },
  { sport: 'americanfootball_ncaaf', market: 'team_totals', archive: 'football/pricing/lines_cfb.json',
    needs: ['close.home_team_total', 'close.away_team_total'],
    outcome: 'home_points and away_points, which the archive already carries' },
  { sport: 'americanfootball_nfl', market: 'player_props', archive: 'football/pricing/lines_nfl.json',
    needs: ['close.player_props[]'],
    outcome: 'a per-player box-score line, which no archive in this repository stores per game and per market' },
];

/* The floors a registration has to clear. They are the staking validation's
   own floors, deliberately: a prop market does not get an easier bar than the
   spread just because it is newer. */
const RULES = {
  min_sample: 500,
  tiers: ['VALIDATED', 'LEAN', 'PROBABILITY'],
  holdout: 'a walk-forward on seasons the model never saw, scored at the closing price, the same shape tools/intelligence/validate_staking.js runs for the game markets',
  note: 'A tier here opens a market the kernel otherwise declares out of scope. It is never awarded from a fitted record, from a partial season, or from a market priced off the game line.',
};

function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }

/** Does this archive carry the fields a validation of this market would read? */
function probe(w) {
  const a = readJson(w.archive);
  if (!a) return { present: false, games: 0, with_field: 0, why: 'the archive ' + w.archive + ' is not on file' };
  const games = a.games || [];
  if (!games.length) return { present: false, games: 0, with_field: 0, why: 'the archive ' + w.archive + ' carries no games' };
  /* the leaf name under close/open, probed across the whole archive rather
     than a sample: a market that appears in one season and not the rest is
     not a market this can validate, and a sample would miss that */
  const leaves = w.needs.map((n) => n.replace(/^close\./, '').replace(/\[\]$/, ''));
  let hit = 0;
  for (const g of games) {
    const c = g.close || {};
    if (leaves.every((k) => c[k] != null)) hit++;
  }
  const seen = new Set();
  games.slice(0, 5000).forEach((g) => Object.keys(g.close || {}).forEach((k) => seen.add(k)));
  return {
    present: hit > 0, games: games.length, with_field: hit,
    fields_the_archive_has: Array.from(seen).sort(),
    why: hit > 0 ? null : 'the archive carries no ' + leaves.join(' / ') + ' on any of its ' + games.length + ' games',
  };
}

function build() {
  const refused = [];
  const markets = [];
  for (const w of WANTED) {
    const p = probe(w);
    if (!p.present) {
      refused.push({
        sport: w.sport, market: w.market, archive: w.archive,
        needs: w.needs, outcome_available: w.outcome,
        games_in_archive: p.games, games_with_the_line: p.with_field,
        fields_the_archive_has: p.fields_the_archive_has || [],
        why: p.why + ', so there is no history to hold out, no record to grade and no tier to award',
        what_would_change_it: 'collect and commit the closing ' + w.market.replace('_', ' ') + ' line per game into ' + w.archive + '; this script then holds it out season by season and awards a tier only if it clears the same floors the game markets clear',
      });
      continue;
    }
    /* THE PATH THAT EXISTS BUT HAS NOT RUN. When an archive starts carrying
       these lines, the walk-forward goes here. Until then it must not be
       possible to reach a registration without one, so the market is refused
       with that reason rather than registered on the strength of the data
       merely being present. */
    refused.push({
      sport: w.sport, market: w.market, archive: w.archive,
      games_in_archive: p.games, games_with_the_line: p.with_field,
      why: 'the archive now carries this line on ' + p.with_field + ' games, but no walk-forward has been run over it, and a market is never registered on the strength of the data existing',
      what_would_change_it: 'extend tools/intelligence/validate_staking.js with an arm for this market and hold it out season by season; a tier is awarded here only from that run',
    });
  }
  return {
    schema: SCHEMA, generated_at: new Date().toISOString(),
    source: 'tools/intelligence/validate_extra_markets.js',
    markets,
    refused,
    rules: RULES,
    note: markets.length
      ? markets.length + ' market(s) cleared the floors and are open for staking; each carries the held-out record it cleared them on'
      : 'NO extra market is open for staking. The kernel declares team totals and player props out of scope, and this file is the record of that being a measured refusal rather than an omission: the archives carry no such closing line, so nothing could be held out.',
    reading: 'An empty `markets` list is the expected state and is a result. The staking kernel reads this file and registers what is in it; an entry has to carry a tier, a basis and a held-out sample, and anything short of that is refused here with the reason rather than registered quietly.',
  };
}

function print(rep) {
  console.log('extra markets — ' + rep.markets.length + ' open, ' + rep.refused.length + ' refused');
  rep.markets.forEach((m) => console.log('  OPEN     ' + m.sport + ' ' + m.market + '  ' + m.tier + '  n ' + m.sample_n));
  rep.refused.forEach((r) => console.log('  REFUSED  ' + r.sport + ' ' + r.market + '\n           ' + r.why));
  console.log('  ' + rep.note);
}

function main() {
  const rep = build();
  print(rep);
  if (process.argv.includes('--write')) console.log('  ' + writeIfChanged(OUT, rep, { pretty: true }) + ' ' + path.relative(ROOT, OUT));
}
module.exports = { build, probe, WANTED, RULES, SCHEMA, OUT };
if (require.main === module) main();

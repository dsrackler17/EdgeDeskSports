#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — who shot a blocked attempt, season by season.

     node hockey/crosscheck/blocked.js            writes hockey/validation/nhl_blocked_attribution.json
     node hockey/crosscheck/blocked.js --check    the committed audit still supports the rule

   The NHL data pack's instructions warned that on a blocked attempt the
   provider's team can be the DEFENDING team. In my NHL feed (sportsdataverse
   fastRhockey) it is: event_player_1 is the shooter, event_player_2 the
   blocker, and event_team is the blocker's club. This audit proves it for
   every season from the feed's own skater box scores (each player's club in
   that game), so hockey/ingest/game.js shooterView() rests on the whole
   history, not on one example. The 2024-25 season is also checked event by
   event against ESPN (hockey/crosscheck/espn.js).

   Reads the cached parquet in .cache/nhl_src (the NHL workflow's cache); a
   season whose files are absent is reported ABSENT, never guessed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const io = require('../lib/io');

const OUT = path.join(C.PATHS.validation, 'nhl_blocked_attribution.json');

async function season(s) {
  const pbp = path.join(C.PATHS.cacheSrc, 'play_by_play_lite_' + s + '.parquet');
  const box = path.join(C.PATHS.cacheSrc, 'skater_box_' + s + '.parquet');
  if (!fs.existsSync(pbp) || !fs.existsSync(box)) return { season: s, state: 'ABSENT' };
  const club = new Map();
  for await (const r of io.parquetRows(box, ['game_id', 'team_abbrev', 'player_id'])) club.set(r.game_id + '|' + r.player_id, r.team_abbrev);
  const o = { season: s, state: 'MEASURED', blocked: 0, event_team_is_shooters_club: 0, event_team_is_blockers_club: 0, event_team_is_neither: 0, shooter_club_unknown: 0, player_1_is_shooter: 0 };
  for await (const r of io.parquetRows(pbp, ['game_id', 'event_type', 'event_team_abbr', 'event_player_1_id', 'event_player_1_type', 'event_player_2_id'])) {
    if (r.event_type !== 'BLOCKED_SHOT') continue;
    o.blocked++;
    if (r.event_player_1_type === 'Shooter') o.player_1_is_shooter++;
    const shooter = club.get(r.game_id + '|' + r.event_player_1_id), blocker = club.get(r.game_id + '|' + r.event_player_2_id);
    if (!shooter) { o.shooter_club_unknown++; continue; }
    if (shooter === r.event_team_abbr) o.event_team_is_shooters_club++;
    else if (blocker === r.event_team_abbr) o.event_team_is_blockers_club++;
    else o.event_team_is_neither++;
  }
  return o;
}

async function main() {
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const rows = []; for (const s of seasons) { const r = await season(s); rows.push(r); console.log('[nhl blocked] ' + JSON.stringify(r)); }
  const m = rows.filter((r) => r.state === 'MEASURED');
  const tot = (k) => m.reduce((a, r) => a + r[k], 0);
  const report = {
    schema: 'edgedesk_nhl_blocked_attribution_v1',
    rule: 'On BLOCKED_SHOT the feed\'s event team is not the shooter\'s club (it is the blocker\'s; "neither" rows are blocks by a teammate or with no blocker recorded). The ingest credits every blocked attempt to the other club and rotates its fixed-frame location (hockey/ingest/game.js shooterView). Exceptions are counted, not hidden.',
    totals: { seasons_measured: m.length, blocked: tot('blocked'), event_team_is_shooters_club: tot('event_team_is_shooters_club'), event_team_is_blockers_club: tot('event_team_is_blockers_club'), event_team_is_neither: tot('event_team_is_neither'), shooter_club_unknown: tot('shooter_club_unknown'), player_1_is_shooter: tot('player_1_is_shooter') },
    seasons: rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  console.log('[nhl blocked] ' + JSON.stringify(report.totals) + ' -> ' + path.relative(C.ROOT, OUT));
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const t = r.totals;
  /* one row in 610,859 (2012-13) names the shooter's club: a feed error the rule then mis-credits, kept visible here */
  const ok = t.seasons_measured >= 15 && t.event_team_is_shooters_club <= t.blocked / 1e5 && t.player_1_is_shooter === t.blocked;
  if (!ok) { console.error('[nhl blocked --check] FAILED ' + JSON.stringify(t)); process.exit(1); }
  console.log('[nhl blocked --check] ok: ' + t.blocked + ' blocked attempts over ' + t.seasons_measured + ' seasons; the event team is the shooter\'s club in ' + t.event_team_is_shooters_club);
}

if (require.main === module) { if (process.argv.includes('--check')) check(); else main().catch((e) => { console.error(e && e.stack || e); process.exit(1); }); }
module.exports = { season };

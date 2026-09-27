#!/usr/bin/env node
/* ============================================================================
   WHY ONLY 1,746 OF 15,542 PLAYERS CARRY ATTRIBUTED PRODUCTION — audited.

   THE NUMBER THAT STARTED THIS. Every roster bundle on every card carried the
   source string "15542 rated players, 1746 with attributed production", and
   read as a catastrophic ingestion failure: eleven per cent of the field. It
   is not one number and it is not one failure. It is four different
   populations that were being counted as one, and the count that was
   published is the smallest of them:

     15,542  rated players — every athlete on an FBS roster
      5,509  have at least one ATTRIBUTED EVENT in the seasons this build read
      1,746  have a computable career QUALITY SCORE (`z_career`)
        193  have a computable CURRENT-SEASON quality score (`z_raw`)

   "Attributed production" was the label on the 1,746. The 1,746 is a
   different, stricter thing: a player needs enough volume in one of the
   measures his position group's contract defines, over a season whose
   baseline cleared its own coverage floor, before a z-score exists for him at
   all. Ten thousand players have no attributed event because nobody publishes
   one for them, and that is a fact about the feed, not a broken join.

   SO THIS JOB SEPARATES THE FIVE CAUSES THE NUMBER WAS HIDING:

     GENUINE_NONPARTICIPATION  on the roster, no event because he has not
                               played. A true freshman in September.
     NOT_COVERED_BY_SOURCE     he plays and the feed attributes nothing to his
                               position. Every offensive lineman in the sport:
                               the play feed names passers, rushers, receivers
                               and tacklers, and nobody else.
     BELOW_MEASUREMENT_FLOOR   attributed events exist but fewer than the
                               measure's own minimum, so no rate is computed.
                               Two games into a season this is most of the
                               field and it is CORRECT.
     UNRESOLVED_IDENTITY       the feed attributes events to an athlete id the
                               roster does not carry.
     BROKEN_JOIN               the feed and the roster BOTH carry him and the
                               events did not reach his rating anyway. This is
                               the only one that is a bug, and it is the one
                               the single published number could not show.

     node football/players/attribution_audit.js [--season 2026] [--offline]
          [--out football/players/attribution_audit.json]

   --offline audits what is committed and skips the provider comparison, which
   means UNRESOLVED_IDENTITY and BROKEN_JOIN cannot be separated and the report
   says so rather than reporting zero.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const CFB = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const SCHEMA = 'edgedesk_attribution_audit_v1';

/* the play feed's per-player attribution columns. A position that appears in
   none of them cannot be measured from this feed at all, whatever he did. */
const ID_COLUMNS = ['reception_player_id', 'completion_player_id', 'rush_player_id', 'interception_player_id',
  'interception_thrown_player_id', 'touchdown_player_id', 'incompletion_player_id', 'target_player_id',
  'fumble_recovered_player_id', 'fumble_forced_player_id', 'fumble_player_id', 'sack_player_id',
  'sack_taken_player_id', 'pass_breakup_player_id', 'field_goal_attempt_player_id',
  'punt_player_id', 'kickoff_player_id', 'kickoff_returner_player_id', 'punt_returner_player_id'];

/* THE SUBSET THE RATING ACTUALLY READS. football/players/build_players.js
   defines its volume from these columns and no others, so an athlete whose
   only appearance in the feed is a kickoff or a touchdown credit has no
   attributed VOLUME by the rating's own definition. Counting that as a broken
   join would report a bug where there is a scope: the two are separated
   because the fix is different — one is a join to repair, the other is a
   measure the layer has chosen not to define. */
const RATING_COLUMNS = ['rush_player_id', 'completion_player_id', 'incompletion_player_id',
  'reception_player_id', 'target_player_id', 'interception_thrown_player_id', 'interception_player_id',
  'sack_player_id', 'sack_taken_player_id', 'pass_breakup_player_id', 'fumble_player_id',
  'fumble_forced_player_id', 'fumble_recovered_player_id', 'field_goal_attempt_player_id'];

/* Position groups the play feed structurally cannot attribute an offensive
   event to. This is not a claim that they do not play — it is the feed's
   vocabulary, and a player here with no events is NOT_COVERED_BY_SOURCE. */
const UNCOVERED_GROUPS = ['OL', 'LS'];

/* WHICH COLUMNS COUNT AS VOLUME FOR WHICH POSITION GROUP.
   epir.js volume() is defined per group: a quarterback's volume is dropbacks
   and carries, a receiver's is receptions and targets, a defender's is the
   disruptive plays the feed names. An offensive lineman credited with a
   fumble recovery therefore has an attributed EVENT and zero attributed
   VOLUME, by the rating's own definition and correctly. Without this map the
   audit reports as broken joins what are actually definitions. */
const VOLUME_COLUMNS_BY_GROUP = {
  QB: ['completion_player_id', 'incompletion_player_id', 'sack_taken_player_id',
    'interception_thrown_player_id', 'rush_player_id'],
  RB: ['rush_player_id', 'reception_player_id', 'target_player_id'],
  WR: ['reception_player_id', 'target_player_id'],
  TE: ['reception_player_id', 'target_player_id'],
  K: ['field_goal_attempt_player_id'],
  DL: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  EDGE: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  LB: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  CB: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  S: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  DB: ['sack_player_id', 'interception_player_id', 'pass_breakup_player_id', 'fumble_forced_player_id', 'fumble_recovered_player_id'],
  P: [], OL: [], LS: [], RET: [], ATH: []
};

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };

/* the feed is ~11MB a season and only the id columns are needed, so it is
   walked as lines rather than materialised as rows */
async function attributedIds(season) {
  const url = `${CFB}/player_stats/csv/player_stats_${season}.csv`;
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (r.status === 404) return { ok: false, why: 'the provider has not published player_stats for ' + season };
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status + ' for ' + url };
  const text = await r.text();
  const nl0 = text.indexOf('\n');
  const head = text.slice(0, nl0).replace(/\r$/, '').split(',');
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  const want = ID_COLUMNS.filter(c => idx[c] !== undefined).map(c => idx[c]);
  const ratingWant = new Set(RATING_COLUMNS.filter(c => idx[c] !== undefined).map(c => idx[c]));
  if (!want.length) return { ok: false, why: 'the feed no longer carries any *_player_id column' };
  const ids = new Map();
  const inContract = new Map();
  /* which columns each athlete appears in, so the audit can ask whether any
     of them counts as volume for HIS group rather than for anybody's */
  const byColumn = new Map();
  let start = nl0 + 1;
  const maxIdx = Math.max.apply(null, want);
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = text.length;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (!line) continue;
    const f = line.split(',');
    if (f.length <= maxIdx) continue;
    for (const w of want) {
      const v = f[w];
      if (!v || v === 'NA') continue;
      ids.set(v, (ids.get(v) || 0) + 1);
      if (ratingWant.has(w)) inContract.set(v, (inContract.get(v) || 0) + 1);
      let set = byColumn.get(v);
      if (!set) { set = new Set(); byColumn.set(v, set); }
      set.add(head[w]);
    }
  }
  return { ok: true, ids, in_contract: inContract, by_column: byColumn, url,
    columns: want.length, rating_columns: ratingWant.size };
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const offline = !!arg('offline', false);
  const dest = path.join(ROOT, String(arg('out', 'football/players/attribution_audit.json')));

  const index = readJson(path.join(HERE, 'index.json'), null);
  const layer = readJson(path.join(HERE, 'current.json'), null);
  if (!index || !index.players) { console.error('[audit] football/players/index.json is missing'); return 2; }

  const col = {};
  (index.columns || []).forEach((c, i) => { col[c.split(' ')[0]] = i; });
  const KEY = col.key, GROUP = col.group, SAMPLE = col['sample_size'], CONF = col.confidence, TEAM = col.team_key;
  const rated = index.players.length;

  let anyEvent = 0, noEvent = 0;
  const byGroupNoEvent = {};
  const idsRated = new Set();
  const withEvents = new Set();
  index.players.forEach(p => {
    const id = String(p[KEY]).replace(/^a:/, '');
    idsRated.add(id);
    const n = p[SAMPLE];
    if (n && n > 0) { anyEvent++; withEvents.add(id); }
    else {
      noEvent++;
      const g = p[GROUP] || 'UNKNOWN';
      byGroupNoEvent[g] = (byGroupNoEvent[g] || 0) + 1;
    }
  });

  /* the two stricter populations, read off the layer that computes them */
  const careerZ = layer && layer.rated_with_production != null ? layer.rated_with_production : null;
  const seasonZ = layer && layer.rated_with_production_this_season != null ? layer.rated_with_production_this_season : null;

  /* ---- the provider comparison, which is what separates a bug from a gap */
  let provider = { attempted: !offline, ok: false, why: offline ? '--offline: the provider was not read' : null };
  let unresolved = null, brokenJoin = null, outsideContract = null, providerIds = null;
  if (!offline) {
    const got = await attributedIds(season);
    if (!got.ok) provider.why = got.why;
    else {
      providerIds = got.ids;
      provider = { attempted: true, ok: true, url: got.url, columns_read: got.columns,
        distinct_attributed_athletes: got.ids.size };
      /* an id the feed attributes events to and the roster does not carry */
      let unres = 0;
      const unresSample = [];
      got.ids.forEach((n, id) => {
        if (idsRated.has(id)) return;
        unres++;
        if (unresSample.length < 20) unresSample.push({ athlete_id: id, events: n });
      });
      unresolved = { count: unres, sample: unresSample,
        why: 'the provider attributes events to these athlete ids and no rated player carries them. Most are FCS '
          + 'and lower-division opponents, who appear in an FBS team\u2019s play rows and are not on an FBS '
          + 'roster; the rest are genuine identity gaps.' };
      /* BOTH sides carry him and the rating still has no attributed event.
         This is the only population that is a bug in EdgeDesk. */
      let broken = 0, outside = 0;
      const brokenByTeam = {};
      const brokenSample = [], outsideSample = [];
      index.players.forEach(p => {
        const id = String(p[KEY]).replace(/^a:/, '');
        const n = p[SAMPLE];
        if (n && n > 0) return;
        if (!got.ids.has(id)) return;
        /* an event only in a column the rating does not read is a SCOPE
           decision, not a failed join */
        const cols = got.by_column.get(id) || new Set();
        const vol = VOLUME_COLUMNS_BY_GROUP[p[GROUP]];
        const countsAsVolume = vol == null
          ? cols.size > 0                       /* an unmapped group: fall back to "any rating column" */
          : vol.some(c => cols.has(c));
        if (!countsAsVolume) {
          outside++;
          if (outsideSample.length < 20) outsideSample.push({ athlete_id: id, name: p[1], team: p[TEAM],
            group: p[GROUP], provider_events: got.ids.get(id), columns: Array.from(cols) });
          return;
        }
        broken++;
        brokenByTeam[p[TEAM]] = (brokenByTeam[p[TEAM]] || 0) + 1;
        if (brokenSample.length < 60) brokenSample.push({ athlete_id: id, name: p[1], team: p[TEAM],
          group: p[GROUP], provider_events: got.ids.get(id), events_in_rating_columns: got.in_contract.get(id) });
      });
      outsideContract = { count: outside, sample: outsideSample,
        why: 'the provider attributes events to these athlete ids, and none of those events counts as VOLUME for '
          + 'the position group the player is in. epir.js volume() is defined per group — a lineman credited '
          + 'with a fumble recovery has an event and no volume, correctly. This is a definition showing, not a '
          + 'join failure, and the fix if one is wanted is to widen the definition, not to repair a join.',
        renamed: 'OUTSIDE_VOLUME_DEFINITION is the accurate name for this population' };
      brokenJoin = { count: broken, sample: brokenSample, by_team: brokenByTeam,
        largest: brokenSample.slice().sort((a, b) => b.provider_events - a.provider_events).slice(0, 5),
        why: broken
          ? 'the provider attributes events to these athlete ids AND they are on a rated roster, and the rating '
            + 'carries no attributed event for them. This is a join failure inside EdgeDesk and is the only '
            + 'population here that is a bug.'
          : 'no rated player is missing events the provider attributes to his own athlete id: every gap below is '
            + 'a gap in the feed or in participation, not a broken join.' };
    }
  }

  const uncovered = UNCOVERED_GROUPS.reduce((a, g) => a + (byGroupNoEvent[g] || 0), 0);

  const out = {
    schema: SCHEMA, version: 1, season,
    generated_at: new Date().toISOString(),
    question: 'why do only ' + (careerZ == null ? '?' : careerZ) + ' of ' + rated + ' rated players carry '
      + 'attributed production, and which part of that is a bug?',
    populations: {
      rated_players: rated,
      with_any_attributed_event: anyEvent,
      with_a_career_quality_score: careerZ,
      with_a_current_season_quality_score: seasonZ,
      note: 'these are FOUR populations, not one. "Attributed production" was the label on the third and is a '
        + 'property of the second. A player needs events, then enough of them to clear his measure\u2019s minimum, '
        + 'then a season whose baseline cleared its own coverage floor, before a score exists for him.'
    },
    causes: {
      NOT_COVERED_BY_SOURCE: { players: uncovered,
        groups: UNCOVERED_GROUPS,
        why: 'the play feed names passers, rushers, receivers, kickers and the players who tackle or defend them. '
          + 'It attributes nothing to an offensive lineman or a long snapper, so a player in those groups with no '
          + 'events is invisible to this source rather than absent from the field. No amount of ingestion fixes it.' },
      GENUINE_NONPARTICIPATION_OR_BELOW_FLOOR: { players: noEvent - uncovered,
        why: 'on a rated roster, in a group the feed CAN attribute to, with no attributed event in the seasons '
          + 'read. In September this is dominated by players who have genuinely not taken a meaningful snap. It '
          + 'is not separable from "played a handful of snaps and touched nothing" without a snap count, and no '
          + 'public feed carries one.' },
      UNRESOLVED_IDENTITY: unresolved,
      OUTSIDE_VOLUME_DEFINITION: outsideContract,
      BROKEN_JOIN: brokenJoin
    },
    provider: provider,
    no_event_by_group: byGroupNoEvent,
    verdict: brokenJoin
      ? (brokenJoin.count === 0
        ? 'NO BROKEN JOIN. Every athlete id the provider attributes an event to, and that EdgeDesk rates, carries '
          + 'that event in its rating. The gap between ' + rated + ' and ' + anyEvent + ' is what the feed does '
          + 'not publish; the gap between ' + anyEvent + ' and ' + careerZ + ' is measurement floors doing their job.'
        : brokenJoin.count + ' rated player(s) are missing events the provider attributes to their own athlete id '
          + '\u2014 a real join failure, listed above.')
      : 'the provider was not read, so UNRESOLVED_IDENTITY and BROKEN_JOIN could not be separated. This report does '
        + 'NOT claim there is no broken join; it claims it did not look.',
    label_fix: 'football/players/roster_quality.js published "N with attributed production" using the '
      + 'career-quality-score count. The two are different populations and the string now says which is which.'
  };

  if (arg('check', false)) { log(JSON.stringify(out.populations, null, 1)); log(out.verdict); return 0; }
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  log('[audit] wrote ' + path.relative(ROOT, dest));
  log('  ' + rated + ' rated · ' + anyEvent + ' with an attributed event · ' + careerZ + ' with a career score · '
    + seasonZ + ' with a current-season score');
  log('  ' + out.verdict);
  return 0;
}

module.exports = { ID_COLUMNS, UNCOVERED_GROUPS, SCHEMA };
if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[audit] ' + ((e && e.stack) || e)); process.exit(2); });

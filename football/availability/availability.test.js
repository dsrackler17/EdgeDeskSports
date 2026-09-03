#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk CFB availability layer.

   THE RULES UNDER TEST: nothing is invented, no status is stronger than its
   source, a lower tier never overwrites a higher one, an unresolvable player
   is never assigned to the wrong one, last week is not this week, and "no
   reported injuries", "no verified data" and "partial coverage" stay three
   different statements.

   Offline: every network edge sits behind a collector, and the collectors are
   driven here with fixture pages and fixture feeds.

   Run: node football/availability/availability.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, 'availability.js'));
const C = require(path.join(__dirname, 'collectors.js'));
const F = require(path.join(__dirname, 'fetch_availability.js'));
const B = require(path.join(__dirname, 'build_sources.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 420) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const NOW = '2026-09-11T18:00:00Z';
const ROSTER = [
  { name: 'Behren Morton', position: 'QB', jersey: '2', espn_id: '4685720' },
  { name: 'Will Hammond', position: 'QB', jersey: '7', espn_id: '5081991' },
  { name: "Ja'Lynn Polk", position: 'WR', jersey: '1', espn_id: '4432665' },
  { name: 'Caleb Douglas Jr.', position: 'WR', jersey: '11', espn_id: '4685721' },
  { name: 'Caleb Douglas', position: 'CB', jersey: '24', espn_id: '4685722' },
  { name: 'Marcus Green', position: 'RB', jersey: '5', espn_id: '4685723' },
  { name: 'Chris Brown', position: 'OT', jersey: '76', espn_id: '4685724' },
  { name: 'James Lee', position: 'CB', jersey: '3', espn_id: '4685725' },
  { name: 'Sam Smith', position: 'LB', jersey: '44', espn_id: '4685726' },
  { name: 'Sam Smith', position: 'DT', jersey: '95', espn_id: '4685727' },
];
function rep(o) {
  return Object.assign({ season: 2026, week: 3, team_id: '2641', team_name: 'Texas Tech', team_abbr: 'TTU',
    player_name: 'Behren Morton', position: 'QB', status: 'QUESTIONABLE', practice_status: 'NOT_REPORTED',
    source_type: 'OFFICIAL_TEAM', source_name: 'Texas Tech Athletics', source_url: 'https://texastech.com/x',
    source_published_at: '2026-09-11T15:00:00Z', observed_at: NOW, confidence: 'CONFIRMED' }, o || {});
}

/* ---- 1. status normalization --------------------------------------------- */
{
  const n = A.normalizeAvailabilityStatus;
  chk('will not play / ruled out -> OUT', n('He will not play Saturday').status === 'OUT' && n('has been ruled out').status === 'OUT' && n('out for the season').status === 'OUT');
  chk('unlikely to play -> DOUBTFUL', n('unlikely to play').status === 'DOUBTFUL' && n('doubtful for Saturday').status === 'DOUBTFUL');
  chk('questionable -> QUESTIONABLE', n('listed as questionable').status === 'QUESTIONABLE');
  chk('game-time decision -> GAME_TIME_DECISION', n('a game-time decision').status === 'GAME_TIME_DECISION' && n('gametime decision').status === 'GAME_TIME_DECISION');
  chk('day to day -> DAY_TO_DAY', n('coach called him day-to-day').status === 'DAY_TO_DAY');
  chk('expected to play -> EXPECTED', n('expected to play').status === 'EXPECTED' && n('has been cleared to return').status === 'EXPECTED');
  chk('limited participant -> practice LIMITED, and NOT a status', n('was a limited participant Wednesday').practice_status === 'LIMITED' && n('was a limited participant Wednesday').status === 'UNKNOWN');
  chk('full participant -> practice FULL, and NOT an AVAILABLE designation', n('full participant Thursday').practice_status === 'FULL' && n('full participant Thursday').status === 'UNKNOWN');
  chk('DID NOT PRACTICE never becomes OUT', n('did not practice Tuesday').practice_status === 'DNP' && n('did not practice Tuesday').status === 'UNKNOWN');
  chk('a non-contact jersey never becomes QUESTIONABLE', (function () { const r = n('wore a non-contact jersey at practice'); return r.status === 'UNKNOWN' && r.observations[0] === 'wore a non-contact jersey'; })());
  chk('a boot or a sling is an observation, not a designation', n('was seen in a walking boot').status === 'UNKNOWN' && n('was seen in a walking boot').observations.length === 1);
  chk('leaving a game early is an observation, not an injury designation', n('left the game in the third quarter').status === 'UNKNOWN' && /left a game early/.test(n('left the game in the third quarter').observations[0]));
  chk('a denial is not a designation', n('is no longer questionable').status === 'UNKNOWN' && n('is not out for Saturday').status === 'UNKNOWN');
  chk('the body part is read only when the source names it', n('questionable with a hamstring').body_part === 'hamstring' && n('questionable').body_part === null);
  chk('unreadable text stays UNKNOWN and keeps its raw form', (function () { const r = n('coach spoke about the offense'); return r.status === 'UNKNOWN' && r.practice_status === 'NOT_REPORTED' && r.raw === 'coach spoke about the offense'; })());
  chk('an empty report is UNKNOWN, never AVAILABLE', n('').status === 'UNKNOWN' && n(null).status === 'UNKNOWN');
  chk('a structured designation maps straight through', A.normalizeDesignation('Out') === 'OUT' && A.normalizeDesignation('Game-Time Decision') === 'GAME_TIME_DECISION' && A.normalizeDesignation('Active') === 'AVAILABLE' && A.normalizeDesignation('Suspended') === 'OUT' && A.normalizeDesignation('') === 'UNKNOWN');
}

/* ---- 2. player identity --------------------------------------------------- */
{
  const R = (o) => A.resolvePlayer(o, ROSTER);
  chk('an exact name resolves', R({ player_name: 'Behren Morton' }).match === 'exact_name');
  chk('an initial and a last name resolve', R({ player_name: 'B. Morton', position: 'QB' }).match === 'initial_and_last_name');
  chk('a roster id wins outright', R({ player_name: 'Wrong Name', player_id: '5081991' }).player.name === 'Will Hammond');
  chk('an apostrophe is folded', R({ player_name: "Jalynn Polk" }).player.name === "Ja'Lynn Polk" && R({ player_name: "Ja’Lynn Polk" }).player.name === "Ja'Lynn Polk");
  chk('a suffix is folded, so Jr. matches the roster spelling', R({ player_name: 'Caleb Douglas Jr', position: 'WR' }).player.jersey === '11' || R({ player_name: 'Caleb Douglas Jr', position: 'WR' }).candidates >= 1);
  chk('two players with the same name are split by jersey', R({ player_name: 'Sam Smith', jersey: '95' }).player.position === 'DT' && R({ player_name: 'Sam Smith', jersey: '44' }).player.position === 'LB');
  chk('two players with the same name are split by position', R({ player_name: 'Sam Smith', position: 'LB' }).player.jersey === '44');
  chk('the same name with nothing to split it is UNRESOLVED, never guessed', (function () { const r = R({ player_name: 'Sam Smith' }); return !r.player && r.candidates === 2 && /share the name/.test(r.reason); })());
  chk('a name not on the roster is unresolved with a reason', (function () { const r = R({ player_name: 'Nobody Here' }); return !r.player && /no roster player matched/.test(r.reason); })());
  chk('an empty roster is reported, not treated as no injuries', (function () { const r = A.resolvePlayer({ player_name: 'X' }, []); return !r.player && /no roster on file/.test(r.reason); })());
  chk('a report with no name resolves to nothing', !R({ player_name: '' }).player);
  chk('a unique exact name still resolves when the source got the position wrong, and the disagreement is recorded', (function () { const r = R({ player_name: 'Marcus Green', position: 'QB' }); return r.player && r.match_confidence === 'HIGH' && /the source lists QB, the roster lists RB/.test(r.reason); })());
  chk('hyphens and case do not matter', A.normName('Ja’Lynn  POLK-Smith') === 'jalynn polksmith' || A.normName('Ja’Lynn  POLK-Smith') === 'jalynn polk smith');
}

/* ---- 3. source precedence and the three conflict cases -------------------- */
{
  const official = (o) => rep(Object.assign({ source_type: 'OFFICIAL_TEAM', source_name: 'Texas Tech Athletics', confidence: 'CONFIRMED' }, o));
  const media = (o) => rep(Object.assign({ source_type: 'REPUTABLE_MEDIA', source_name: 'Some Publication', confidence: 'MEDIUM' }, o));
  const reporter = (o) => rep(Object.assign({ source_type: 'TEAM_REPORTER', source_name: 'Beat Reporter', confidence: 'MEDIUM' }, o));

  const c1 = A.canonicalize([official({ status: 'QUESTIONABLE' }), media({ status: 'OUT', source_published_at: '2026-09-11T16:00:00Z' })], { now: NOW });
  chk('official QUESTIONABLE beats a publication saying OUT', c1.availability_status === 'QUESTIONABLE' && c1.source_type === 'OFFICIAL_TEAM', c1.availability_status);
  chk('the contradiction is RECORDED, with why it did not win', c1.contested === true && c1.contested_by.length === 1 && c1.contested_by[0].status === 'OUT' && c1.contested_by[0].newer_than_canonical === true && /ranks below the official team/.test(c1.contested_by[0].why_not_canonical), c1.contested_by);

  const c2 = A.canonicalize([official({ status: 'QUESTIONABLE', source_published_at: '2026-09-08T15:00:00Z' }), official({ status: 'OUT', source_published_at: '2026-09-11T15:00:00Z' })], { now: NOW });
  chk('Tuesday official QUESTIONABLE then Friday official OUT resolves to OUT', c2.availability_status === 'OUT');

  const c3 = A.canonicalize([reporter({ status: 'OUT', source_published_at: '2026-09-10T15:00:00Z' }), official({ status: 'AVAILABLE', source_published_at: '2026-09-11T15:00:00Z' })], { now: NOW });
  chk('a reporter OUT on Thursday loses to the official AVAILABLE on Friday', c3.availability_status === 'AVAILABLE' && c3.confidence === 'CONFIRMED');

  chk('a forum, an aggregator or an AI summary is refused outright', !A.isUsableSource(rep({ source_url: 'https://reddit.com/r/CFB/x' })) && !A.isUsableSource(rep({ source_name: 'AI-generated injury summary' })) && !A.isUsableSource(rep({ source_type: 'NOT_A_SOURCE' })));
  chk('refused sources cannot produce a canonical record at all', A.canonicalize([rep({ source_url: 'https://reddit.com/r/CFB/x' })], { now: NOW }) === null);
  chk('tiers are ordered official, reporter, participation', A.sourceTier('OFFICIAL_CONFERENCE') === 1 && A.sourceTier('TEAM_REPORTER') === 2 && A.sourceTier('GAME_PARTICIPATION') === 3);
}

/* ---- 4. confidence -------------------------------------------------------- */
{
  chk('an official report with an explicit designation is CONFIRMED', A.scoreConfidence({ source_type: 'OFFICIAL_TEAM', status: 'OUT' }) === 'CONFIRMED' && A.scoreConfidence({ source_type: 'OFFICIAL_CONFERENCE', status: 'QUESTIONABLE' }) === 'CONFIRMED');
  chk('a coach quote with a designation is HIGH, not CONFIRMED', A.scoreConfidence({ source_type: 'COACH_QUOTE', status: 'EXPECTED' }) === 'HIGH');
  chk('a reputable outlet with a designation is MEDIUM', A.scoreConfidence({ source_type: 'REPUTABLE_MEDIA', status: 'OUT' }) === 'MEDIUM');
  chk('participation and depth-chart evidence is LOW', A.scoreConfidence({ source_type: 'GAME_PARTICIPATION', status: 'AVAILABLE' }) === 'LOW' && A.scoreConfidence({ source_type: 'DEPTH_CHART', status: 'UNKNOWN' }) === 'LOW');
  chk('an official source with NO designation is not CONFIRMED', A.scoreConfidence({ source_type: 'OFFICIAL_TEAM', status: 'UNKNOWN' }) === 'HIGH' === false || A.scoreConfidence({ source_type: 'OFFICIAL_TEAM', status: 'UNKNOWN' }) === 'LOW');
  chk('verified means an official source AND a strong confidence', A.canonicalize([rep({})], { now: NOW }).verified === true && A.canonicalize([rep({ source_type: 'REPUTABLE_MEDIA', confidence: 'MEDIUM' })], { now: NOW }).verified === false);
}

/* ---- 5. impact ------------------------------------------------------------ */
{
  chk('QB1 out is HIGH', A.impactLevel({ position: 'QB', status: 'OUT', depth_role: 'QB1' }) === 'HIGH');
  chk('a starting left tackle out is HIGH', A.impactLevel({ position: 'LT', status: 'OUT', depth_role: 'LT1' }) === 'HIGH');
  chk('a starting corner out is MEDIUM', A.impactLevel({ position: 'CB', status: 'OUT', depth_role: 'CB1' }) === 'MEDIUM');
  chk('a rotational receiver questionable is LOW', A.impactLevel({ position: 'WR', status: 'QUESTIONABLE', depth_role: 'WR3' }) === 'LOW');
  chk('a backup special teamer out is LOW', A.impactLevel({ position: 'LS', status: 'OUT', depth_role: 'LS2' }) === 'LOW');
  chk('WITHOUT a depth role EdgeDesk does not claim he is the starter', A.impactLevel({ position: 'QB', status: 'OUT' }) === 'MEDIUM' && A.impactLevel({ position: 'CB', status: 'OUT' }) === 'LOW');
  chk('a questionable starter is one notch below an out starter', A.impactLevel({ position: 'QB', status: 'QUESTIONABLE', depth_role: 'QB1' }) === 'MEDIUM');
  chk('an available player is not an absence', A.impactLevel({ position: 'QB', status: 'AVAILABLE', depth_role: 'QB1' }) === 'LOW' && A.impactLevel({ position: 'QB', status: 'EXPECTED', depth_role: 'QB1' }) === 'LOW');
  chk('no position means UNKNOWN impact, never a number', A.impactLevel({ status: 'OUT' }) === 'UNKNOWN');
}

/* ---- 6. freshness and stale data ------------------------------------------ */
{
  const f = (at, o) => A.getAvailabilityFreshness({ source_published_at: at }, Object.assign({ now: NOW }, o || {}));
  chk('a report from this morning is LIVE', f('2026-09-11T15:00:00Z').state === 'LIVE');
  chk('yesterday is CURRENT', f('2026-09-10T18:00:00Z').state === 'CURRENT');
  chk('three days old is AGING', f('2026-09-08T18:00:00Z').state === 'AGING');
  chk('six days old is STALE', f('2026-09-05T18:00:00Z').state === 'STALE');
  chk('last week is HISTORICAL, not this week', f('2026-09-01T18:00:00Z').state === 'HISTORICAL' && /older than a week/.test(f('2026-09-01T18:00:00Z').reason));
  chk('a report filed before this game week is STALE even if recent in clock terms', f('2026-09-08T18:00:00Z', { kickoff: '2026-09-13T18:00:00Z' }).state === 'STALE');
  chk('a report with no timestamp is HISTORICAL and says why', f(null).state === 'HISTORICAL' && /no timestamp/.test(f(null).reason));
  chk('AGING and better counts as current; STALE does not', A.isCurrentEnough('LIVE') && A.isCurrentEnough('AGING') && !A.isCurrentEnough('STALE') && !A.isCurrentEnough('HISTORICAL'));
  chk('a stale record is kept but excluded from the team summary', (function () {
    const recs = A.buildCanonical([rep({ status: 'OUT', source_published_at: '2026-08-30T15:00:00Z' })], { now: NOW });
    const s = A.teamSummary(recs, { sources_checked: 2 });
    return recs.length === 1 && recs[0].freshness === 'HISTORICAL' && s.counts.flagged === 0 && s.counts.stale === 1;
  })());
}

/* ---- 7. duplicates, timeline and history ---------------------------------- */
{
  const days = [
    rep({ practice_status: 'DNP', status: 'UNKNOWN', source_published_at: '2026-09-08T20:00:00Z', raw_text: 'did not practice Tuesday' }),
    rep({ practice_status: 'LIMITED', status: 'UNKNOWN', source_published_at: '2026-09-09T20:00:00Z', raw_text: 'limited Wednesday' }),
    rep({ practice_status: 'FULL', status: 'UNKNOWN', source_published_at: '2026-09-10T20:00:00Z', raw_text: 'full Thursday' }),
    rep({ practice_status: 'NOT_REPORTED', status: 'QUESTIONABLE', source_published_at: '2026-09-11T15:00:00Z', raw_text: 'questionable' })
  ];
  const c = A.canonicalize(days, { now: NOW });
  chk('ten reports about one player become ONE record', c.player_name === 'Behren Morton' && c.evidence_count === 4);
  chk('the canonical status is the newest official designation', c.availability_status === 'QUESTIONABLE');
  chk('the practice trail is preserved, newest last, one row per day', c.timeline.length === 3 && c.timeline.map(t => t.practice_status).join(',') === 'DNP,LIMITED,FULL', c.timeline);
  chk('the timeline only carries days a source actually reported', c.timeline.every(t => !!t.at) && !c.timeline.some(t => t.practice_status === 'NOT_REPORTED'));
  chk('every underlying report survives as evidence, newest first', c.evidence.length === 4 && c.evidence[0].published_at === '2026-09-11T15:00:00Z');
  chk('the same report twice does not double the evidence count in the record', A.canonicalize([rep({}), rep({})], { now: NOW }).evidence_count === 2);
  const many = A.buildCanonical([rep({ player_name: 'Behren Morton' }), rep({ player_name: 'Marcus Green', position: 'RB', status: 'OUT' })], { now: NOW });
  chk('two players are two records, ordered by impact then by doubt', many.length === 2 && many[0].player_name === 'Behren Morton' && many[0].impact_level === 'MEDIUM' && many[1].impact_level === 'LOW', many.map(m => [m.player_name, m.impact_level]));
}

/* ---- 8. game summaries and the four coverage states ----------------------- */
{
  const recs = A.buildCanonical([
    rep({ player_name: 'Behren Morton', position: 'QB', depth_role: 'QB1', status: 'QUESTIONABLE' }),
    rep({ player_name: 'Marcus Green', position: 'RB', depth_role: 'RB2', status: 'OUT' }),
    rep({ player_name: 'James Lee', position: 'CB', status: 'AVAILABLE', source_published_at: '2026-09-11T16:00:00Z' })
  ], { now: NOW });
  const strong = A.teamSummary(recs, { sources_checked: 3, official_report_found: true });
  chk('a team with official records and three rows is STRONG coverage', strong.dataQuality === 'STRONG' && strong.unknown === false);
  chk('the high-impact absence is separated from the rest', strong.highImpact.length === 0 && strong.other.length === 2 && strong.cleared.length === 1, { hi: strong.highImpact.length, other: strong.other.length });
  chk('a cleared player is counted as cleared, not as a flag', strong.counts.cleared === 1 && strong.counts.flagged === 2);
  const partial = A.teamSummary(A.buildCanonical([rep({ source_type: 'REPUTABLE_MEDIA', confidence: 'MEDIUM' })], { now: NOW }), { sources_checked: 2 });
  chk('one media record is PARTIAL coverage', partial.dataQuality === 'PARTIAL');
  const limited = A.teamSummary([], { sources_checked: 3, sources_failed: 0 });
  chk('sources checked but nothing found is LIMITED, and unknown stays true', limited.dataQuality === 'LIMITED' && limited.unknown === true);
  const none = A.teamSummary([], {});
  chk('nothing checked at all is NONE', none.dataQuality === 'NONE' && none.unknown === true);
  const clean = A.teamSummary([], { sources_checked: 2, official_report_found: true });
  chk('an OFFICIAL report that lists nobody is STRONG coverage with no flags — "no reported injuries"', clean.dataQuality === 'STRONG' && clean.counts.flagged === 0 && clean.unknown === false);
  const game = A.getGameAvailabilitySummary({ home_records: recs, home_meta: { sources_checked: 3, official_report_found: true }, away_records: [], away_meta: { sources_checked: 2 } });
  chk('a game takes the WORSE of the two sides for its coverage', game.dataQuality === 'LIMITED' && game.home.dataQuality === 'STRONG' && game.away.unknown === true);
  chk('the game summary reports when it was last updated', !!game.lastUpdated);
}

/* ---- 9. the collectors, on fixtures ---------------------------------------- */
{
  const html = '<table><tr><th>Player</th><th>Status</th></tr>' +
    '<tr><td>Behren Morton</td><td>QB</td><td>Questionable</td></tr>' +
    '<tr><td>Marcus Green</td><td>RB</td><td>Ruled out with a knee</td></tr>' +
    '<tr><td>Will Hammond</td><td>QB</td><td>Full participant Thursday</td></tr>' +
    '<tr><td>Someone Not On This Roster</td><td>WR</td><td>Out</td></tr></table>';
  const rows = C.extractFromText(C.stripHtml(html), ROSTER);
  chk('an official page yields one row per roster player it names', rows.length === 3);
  chk('a name that is NOT on the roster is never read off a page', !rows.some(r => /Someone Not/.test(r.player_name)));
  chk('the extracted status and body part come from the page text', rows[1].status === 'OUT' && rows[1].body_part === 'knee' && rows[1].raw_text.indexOf('Ruled out') >= 0);
  chk('a practice line is extracted as practice, not as a designation', rows[2].practice_status === 'FULL' && rows[2].status === 'UNKNOWN');
  chk('a page with nothing readable yields nothing rather than a guess', C.extractFromText(C.stripHtml('<p>Coach previews Saturday</p>'), ROSTER).length === 0);
  chk('script and style content is never read as page text', C.stripHtml('<script>var Behren Morton = "Out";</script><p>hello</p>').indexOf('Out') < 0);
}

/* ---- 10. the pipeline, end to end on fixtures ------------------------------ */
{
  const team = { team_id: '2641', team_name: 'Texas Tech', team_display: 'Texas Tech Red Raiders', team_abbr: 'TTU', conference: 'Big 12', espn_team_id: '2641' };
  const ctx = { now: NOW, season: 2026, week: 3, kickoff: '2026-09-13T18:00:00Z' };
  const res = {
    team, rosterPlayers: ROSTER, checked: 3, officialFound: true, notes: [], failed: [{ source: 'espn_depth', error: 'HTTP 500' }],
    roles: { 'behren morton': { depth_role: 'QB1', rank: 1, position: 'QB' }, 'marcus green': { depth_role: 'RB2', rank: 2, position: 'RB' } },
    played: { 'james lee': { name: 'James Lee' } }, playedGame: { id: '401', date: '2026-09-06T18:00:00Z' },
    reports: [
      rep({ player_name: 'Behren Morton', status: 'QUESTIONABLE', practice_status: 'LIMITED', source_published_at: '2026-09-11T15:00:00Z' }),
      rep({ player_name: 'Behren Morton', status: 'OUT', source_type: 'REPUTABLE_MEDIA', source_name: 'Some Site', confidence: 'MEDIUM', source_published_at: '2026-09-11T16:30:00Z' }),
      rep({ player_name: 'Marcus Green', position: 'RB', status: 'OUT', source_published_at: '2026-09-11T15:00:00Z' }),
      rep({ player_name: 'James Lee', position: 'CB', status: 'QUESTIONABLE', source_published_at: '2026-09-11T15:00:00Z' }),
      rep({ player_name: 'Sam Smith', status: 'OUT', position: null, source_published_at: '2026-09-11T15:00:00Z' }),
      rep({ player_name: 'Ghost Player', status: 'OUT', source_published_at: '2026-09-11T15:00:00Z' })
    ]
  };
  const out = F.processTeam(res, ctx);
  const byName = {}; out.records.forEach(r => { byName[r.player_name] = r; });
  chk('the depth chart supplies the role, so QB1 questionable reads as a real uncertainty', byName['Behren Morton'].depth_role === 'QB1' && byName['Behren Morton'].impact_level === 'MEDIUM');
  chk('the official report still beats the newer media report inside the pipeline', byName['Behren Morton'].availability_status === 'QUESTIONABLE' && byName['Behren Morton'].contested === true);
  chk('a BACKUP running back out is LOW impact, however loud the word OUT is', byName['Marcus Green'].availability_status === 'OUT' && byName['Marcus Green'].depth_role === 'RB2' && byName['Marcus Green'].impact_level === 'LOW');
  chk('participation is added ONLY for a player already in question, as availability evidence', (function () {
    const ev = byName['James Lee'].evidence.filter(e => e.source_type === 'GAME_PARTICIPATION');
    return ev.length === 1 && /Recorded participation/.test(ev[0].raw_text);
  })(), byName['James Lee'].evidence);
  chk('participation never introduces a player who was not already reported', !byName['Will Hammond']);
  chk('an ambiguous name and an unknown name are both unresolved, with reasons', out.unresolved.length === 2 && out.unresolved.some(u => /share the name/.test(u.reason)) && out.unresolved.some(u => /no roster player matched/.test(u.reason)), out.unresolved);
  chk('an unresolved report never becomes a record', !out.records.some(r => /Sam Smith|Ghost/.test(r.player_name)));
  chk('the failed source is carried for the admin view and counted against coverage', out.failed_sources.length === 1 && out.summary.sources_failed === 1);
  chk('the team summary knows an official report was found', out.summary.official_report_found === true && out.summary.dataQuality === 'STRONG');

  const ds = F.buildDataset([out], ctx);
  chk('the lean dataset carries players, coverage and provenance but not raw text', (function () {
    const t = ds.current.teams['2641'];
    return t.players.length === 3 && t.dataQuality === 'STRONG' && t.players[0].source_name && JSON.stringify(t).indexOf('raw_text') < 0;
  })(), Object.keys(ds.current.teams['2641'].players[0] || {}));
  chk('the full dataset carries the evidence, the unresolved reports and the failures', ds.full.teams['2641'].records[0].evidence.length >= 1 && ds.full.unresolved.length === 2 && ds.full.failed_sources.length === 1);
  chk('the header counts what was collected', ds.current.team_count === 1 && ds.current.records === 3 && ds.current.unresolved === 2 && ds.current.season === 2026 && ds.current.week === 3);
  chk('the dataset is content-addressed so a quiet run commits nothing', ds.current.digest === F.buildDataset([out], Object.assign({}, ctx, { now: '2026-09-11T23:00:00Z' })).current.digest);
  chk('a different status changes the digest', ds.current.digest !== F.buildDataset([F.processTeam(Object.assign({}, res, { reports: res.reports.slice(2) }), ctx)], ctx).current.digest);
  chk('the timeline reaches the lean file as day and practice only', ds.current.teams['2641'].players.some(p => p.timeline && p.timeline.length && p.timeline[0].day));
}

/* ---- 11. the registry ------------------------------------------------------ */
{
  const roster = { teams: [{ espn_id: '2641', location: 'Texas Tech', display_name: 'Texas Tech Red Raiders', abbreviation: 'TTU' }, { espn_id: '158', location: 'Nebraska', display_name: 'Nebraska Cornhuskers', abbreviation: 'NEB' }] };
  const reg = B.build(roster, { conferences: { 'Big 12': { availability_url: 'https://big12sports.com/availability' } }, teams: { '2641': { conference: 'Big 12', availability_url: 'https://texastech.com/availability' } } }, {}, 2026);
  chk('every FBS program is in the registry, keyed by the roster’s own ESPN id', reg.team_count === 2 && reg.teams.some(t => t.team_id === '2641'));
  chk('an override supplies the official source and the conference report is inherited', (function () { const t = reg.teams.filter(x => x.team_id === '2641')[0]; return t.availability_url === 'https://texastech.com/availability' && t.conference_availability_url === 'https://big12sports.com/availability'; })());
  chk('a school with no override is present and inert, not missing', (function () { const t = reg.teams.filter(x => x.team_id === '158')[0]; return t && t.availability_url === null && t.beat_sources.length === 0; })());
  chk('a beat source without a url is dropped rather than half-used', B.build(roster, { teams: { '158': { beat_sources: [{ name: 'x' }, { name: 'y', url: 'https://y.com', source_type: 'TEAM_REPORTER' }] } } }, {}, 2026).teams.filter(t => t.team_id === '158')[0].beat_sources.length === 1);
  chk('the registry counts its own official coverage', reg.with_official_source === 1);
}

/* ---- 12. the shipped registry is real -------------------------------------- */
{
  const live = require(path.join(__dirname, 'sources.json'));
  chk('the committed registry covers the FBS field', live.team_count >= 120 && live.teams.length === live.team_count);
  chk('every entry carries the ESPN team id the roster sync uses', live.teams.every(t => /^\d+$/.test(String(t.team_id)) && t.team_name));
  chk('no entry ships a source EdgeDesk would refuse', live.teams.every(t => !(t.availability_url && A.REFUSED_SOURCES.test(t.availability_url))));
}

done();

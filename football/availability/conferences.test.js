#!/usr/bin/env node
/* ============================================================================
   THE AMERICAN, THE MAC AND THE PAC-12 — wired, and held to what they file.

   Until 2026-09-25 all three sat in football/availability/policy.js as
   UNVERIFIED with no URL, so every one of their fixture-sides reached the
   contract as an unread source. The probe (probe_sources.js, run on GitHub
   Actions) found each conference's own report page, and these checks pin
   what it found:

     1  the registry: each policy PUBLISHED, sourced and dated, with the
        scope, cadence and vocabulary the conference actually uses
     2  the American's real Army-Temple game-day listing, read as published,
        to the engine's injury list and the quarterback's availability
     3  the MAC: every game a member plays, a one-team entry matched to its
        one fixture, a pending entry never a report, and a listing that
        designates the whole roster judged comprehensive on its own evidence
     4  the Pac-12's own feed: the shape its page renders, reported players
        only, so a side it lists nobody for is never a clean bill of health

   Offline: fixtures/hdi_published_2026-09-25_american_mac.json (captured)
   and fixtures/pac12_feed_shape.json (the renderer's fields; the Pac-12 had
   filed nothing yet).
   ========================================================================== */
'use strict';
const path = require('path');
const POLICY = require(path.join(__dirname, 'policy.js'));
const HDI = require(path.join(__dirname, 'hdi.js'));
const P12 = require(path.join(__dirname, 'pac12.js'));
const R = require(path.join(__dirname, 'reports.js'));
const OVERLAY = require(path.join(__dirname, 'overlay.js'));
const ROOT = path.join(__dirname, '..', '..');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const CONTRACT = require(path.join(ROOT, 'football', 'matchup', 'contract.js'));
const FX = require(path.join(__dirname, 'fixtures', 'hdi_published_2026-09-25_american_mac.json'));
const P12FX = require(path.join(__dirname, 'fixtures', 'pac12_feed_shape.json'));

let pass = 0, fail = 0;
function chk(what, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL | ' + what + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 600)));
}
function section(t) { console.log('\n' + t); }
const H = 3600e3;

/* the fixtures these listings are about, as the slate names them */
const GAMES = [
  { game_id: '401862779', away_team: 'Army', home_team: 'Temple', kickoff: '2026-09-25T20:00:00.000Z',
    home_conference: 'American', away_conference: 'American', is_conference_game: true },
  { game_id: '401862778', away_team: 'Navy', home_team: 'UAB', kickoff: '2026-09-25T23:00:00.000Z',
    home_conference: 'American', away_conference: 'American', is_conference_game: true },
  { game_id: '401860893', away_team: 'San Diego State', home_team: 'Toledo', kickoff: '2026-09-26T16:00:00.000Z',
    home_conference: 'MAC', away_conference: 'Pac-12', is_conference_game: false },
  { game_id: '401866425', away_team: 'Ball State', home_team: 'Kent State', kickoff: '2026-09-26T16:00:00.000Z',
    home_conference: 'MAC', away_conference: 'MAC', is_conference_game: true },
  { game_id: 'P12-OSU-CSU', away_team: 'Oregon State', home_team: 'Colorado State', kickoff: '2026-10-03T22:00:00.000Z',
    home_conference: 'Pac-12', away_conference: 'Pac-12', is_conference_game: true },
  { game_id: 'P12-USU-BSU', away_team: 'Utah State', home_team: 'Boise State', kickoff: '2026-10-03T23:30:00.000Z',
    home_conference: 'Pac-12', away_conference: 'Pac-12', is_conference_game: true },
  { game_id: 'P12-TXST-SDSU', away_team: 'Texas State', home_team: 'San Diego State', kickoff: '2026-10-04T02:30:00.000Z',
    home_conference: 'Pac-12', away_conference: 'Pac-12', is_conference_game: true }
];
const G = id => GAMES.find(g => g.game_id === id);
const forGame = (g, side, now) => POLICY.forGame({ home_conference: g.home_conference, away_conference: g.away_conference,
  is_conference_game: g.is_conference_game, kickoff: g.kickoff }, side, now);

section('1. the registry: published, sourced, dated, scoped');
{
  const aac = POLICY.forConference('American'), mac = POLICY.forConference('MAC'), p12 = POLICY.forConference('Pac-12');
  [['American', aac], ['MAC', mac], ['Pac-12', p12]].forEach(([n, p]) => {
    chk(n + ' is PUBLISHED, no longer UNVERIFIED', p && p.state === 'PUBLISHED', p && p.state);
    chk(n + ' carries its report page, its source and the date it was checked',
      p && /^https:\/\//.test(p.report_url) && /^https:\/\//.test(p.source) && p.verified_at === '2026-09-25', p);
  });
  chk('the American reads from the platform its page embeds, under its own code',
    aac.platform === 'hdintelligence' && aac.platform_code === 'American');
  chk('so does the MAC', mac.platform === 'hdintelligence' && mac.platform_code === 'MAC');
  chk('the Pac-12 reads the file its own page renders', p12.platform === 'pac12-feed' && /report\.json$/.test(p12.data_url)
    && p12.data_url === P12.DATA_URL);
  chk('"Mid-American" is the MAC and never the American', POLICY.forConference('Mid-American').id === 'midamerican'
    && POLICY.forConference('American Athletic Conference').id === 'american');
  chk('only the American claims comprehensiveness: its filing designates the whole roster',
    POLICY.silenceMeansAvailable(aac) === true && POLICY.silenceMeansAvailable(mac) === false
    && POLICY.silenceMeansAvailable(p12) === false);
  chk('the Pac-12 vocabulary is left unclaimed until it files', Array.isArray(p12.statuses) && p12.statuses.length === 0);
  chk('every PUBLISHED policy names its source', POLICY.published().every(p => !!p.source && !!p.report_url),
    POLICY.published().filter(p => !p.source || !p.report_url).map(p => p.id));

  /* scope and cadence */
  const tol = G('401860893');
  chk('the MAC files for every game a member plays: Toledo, hosting San Diego State, is covered',
    forGame(tol, 'home', Date.parse(tol.kickoff) - 0.5 * H).state === 'REQUIRED');
  chk('but the Pac-12 side of that game is not taken to require a report',
    forGame(tol, 'away', Date.parse(tol.kickoff) - 0.5 * H).state === 'NOT_REQUIRED_FOR_THIS_GAME');
  chk('a MAC game-day report is not due until an hour before kickoff',
    forGame(tol, 'home', Date.parse(tol.kickoff) - 3 * H).state === 'NOT_DUE_YET');
  const at = G('401862779');
  chk('the American files on game day only: three hours out is NOT_DUE_YET, ninety minutes out is REQUIRED',
    forGame(at, 'home', Date.parse(at.kickoff) - 3 * H).state === 'NOT_DUE_YET'
    && forGame(at, 'home', Date.parse(at.kickoff) - 1.5 * H).state === 'REQUIRED');
  const nonCon = { home_conference: 'American', away_conference: 'Sun Belt', is_conference_game: false,
    kickoff: '2026-09-26T23:00:00.000Z' };
  chk('the American covers conference games only', POLICY.forGame(nonCon, 'home', Date.parse(nonCon.kickoff) - H).state
    === 'NOT_REQUIRED_FOR_THIS_GAME');
  const osu = G('P12-OSU-CSU');
  chk('the Pac-12 files three days out: 80 hours before is NOT_DUE_YET, 70 is REQUIRED',
    forGame(osu, 'home', Date.parse(osu.kickoff) - 80 * H).state === 'NOT_DUE_YET'
    && forGame(osu, 'home', Date.parse(osu.kickoff) - 70 * H).state === 'REQUIRED');
}

section('2. the American: Army at Temple, the real game-day listing');
const AAC = HDI.readEntry(FX.entries.American.id, FX.entries.American);
const side = (e, name) => HDI.sideOf(e, name, FBS.normKey);
const listing = (e, team, gid, extra) => R.fromListing(Object.assign({ conference: 'American', team, roster: [],
  game_id: gid, kickoff: G(gid).kickoff, source_url: HDI.publicViewUrl('American'), published_at: e.published_at,
  listed: side(e, team).listed, vocabulary: e.vocabulary, report_type: e.report_type, report_id: e.report_id,
  platform: 'hdintelligence', is_conference_game: true, now: Date.parse('2026-09-25T18:30:00Z') }, extra || {}));
{
  chk('filed 13:00 CT on game day is 18:00Z', AAC.published_at === '2026-09-25T18:00:00.000Z', AAC.published_at);
  chk('a game-day report', AAC.report_type === 'Game Day');
  chk('the listing is matched to its one fixture', (HDI.matchFixture(AAC, GAMES, FBS.normKey) || {}).game_id === '401862779');
  chk('"Army West Point" is Army', !!side(AAC, 'Army'));
  chk('every status in the real listing is one EdgeDesk maps',
    AAC.teams.every(t => t.listed.every(l => l.known)), AAC.teams.map(t => t.listed.filter(l => !l.known).map(l => l.status_raw)));
  const army = listing(AAC, 'Army', '401862779'), temple = listing(AAC, 'Temple', '401862779');
  chk('Army: 191 listed, 11 designated (7 questionable, 4 out)', army.ok && army.listed_n === 191 && army.rows.length === 11
    && army.rows.filter(r => r.status === 'QUESTIONABLE').length === 7, army.why);
  chk('Temple: 116 listed, 10 designated', temple.ok && temple.listed_n === 116 && temple.rows.length === 10, temple.why);
  chk('a listing of the whole roster is FULL_ROSTER and comprehensive', army.listing_scope === 'FULL_ROSTER'
    && army.comprehensive === true);
  chk('Army’s Bryson Luter and Temple’s Jaxon Smolik are questionable, as filed',
    army.rows.some(r => r.player_name === 'Bryson Luter' && r.status === 'QUESTIONABLE')
    && temple.rows.some(r => r.player_name === 'Jaxon Smolik' && r.status === 'QUESTIONABLE'));

  /* to the engine */
  const merged = OVERLAY.build({ current: null, operator: { live: [] }, reports: [army, temple],
    now: Date.parse('2026-09-25T18:30:00Z') });
  const byTeam = {};
  Object.keys(merged.teams).forEach(k => { const t = merged.teams[k]; byTeam[CONTRACT.normKey(t.team_name)] = t; });
  const fs = require('fs');
  const details = {};
  ['army', 'temple'].forEach(k => {
    const f = path.join(ROOT, 'football', 'players', 'teams', k + '.json');
    if (fs.existsSync(f)) details[k] = CONTRACT.playerDetailsFrom(JSON.parse(fs.readFileSync(f, 'utf8')));
  });
  const ctx = { availability_by_team: byTeam, availability_as_of: null, player_details_by_team: details };
  const deps = { AV_OVERLAY: OVERLAY };
  const opts = { kickoff: G('401862779').kickoff, now: Date.parse('2026-09-25T18:30:00Z') };
  const inj = CONTRACT.injuriesFor(ctx, 'Army', '401862779', deps, opts);
  chk('Army’s designations reach the engine’s injury list', Array.isArray(inj) && inj.length === 11, inj && inj.length);
  chk('dated by the conference’s filing', inj && inj.every(x => x.as_of === '2026-09-25T18:00:00.000Z'));
  const fx = CONTRACT.fixtureAvailability(ctx, 'Army', '401862779', deps, opts);
  chk('the fixture is graded OFFICIAL from its own filing', fx && fx.grade === 'OFFICIAL' && !!fx.official);
  const hellums = CONTRACT.qbAvailabilityFor(ctx, 'Army', '401862779',
    { player_id: '5150297', player_name: 'Cale Hellums', availability: {} }, fx, deps);
  chk('Army’s starter Cale Hellums, listed available, is available by the comprehensive filing',
    hellums.evidence === 'COMPREHENSIVE_SILENCE' && hellums.state === 'AVAILABLE', hellums);
  chk('and the reason says he is not designated, not that he is missing',
    /does not list Cale Hellums as out, doubtful or questionable/.test(hellums.why), hellums.why);
  const luter = CONTRACT.qbAvailabilityFor(ctx, 'Army', '401862779',
    { player_id: '5293684', player_name: 'Bryson Luter', availability: {} }, fx, deps);
  chk('Bryson Luter, had he been the starter, is EXPLICIT QUESTIONABLE', luter.evidence === 'EXPLICIT'
    && luter.state === 'QUESTIONABLE', luter);
  chk('Navy-UAB, not yet filed, is not graded from Army-Temple’s filing',
    CONTRACT.injuriesFor(ctx, 'Temple', '401862778', deps, opts) === null);
}

section('3. the MAC: every game, one team, and a listing that shows its own scope');
{
  const pending = HDI.readEntry(FX.entries.MAC.id, FX.entries.MAC);
  chk('the MAC entry for Toledo’s non-conference game carries Toledo alone', pending.teams.length === 1
    && pending.teams[0].team_display === 'Toledo');
  chk('and is matched to Toledo’s one fixture that day', (HDI.matchFixture(pending, GAMES, FBS.normKey) || {}).game_id === '401860893');
  const twice = GAMES.concat([Object.assign({}, G('401860893'), { game_id: 'SECOND', kickoff: '2026-09-26T23:00:00.000Z' })]);
  chk('a second Toledo game in the window makes the match ambiguous, and it is refused',
    HDI.matchFixture(pending, twice, FBS.normKey) === null);
  const stillPending = R.fromListing({ conference: 'MAC', team: 'Toledo', roster: [], game_id: '401860893',
    kickoff: G('401860893').kickoff, source_url: HDI.publicViewUrl('MAC'), published_at: pending.published_at,
    listed: pending.teams[0].listed, vocabulary: pending.vocabulary, report_type: pending.report_type,
    platform: 'hdintelligence', now: Date.parse('2026-09-26T13:00:00Z') });
  chk('a "Report Pending" entry is never a report', stillPending.ok === false, stillPending.why);

  /* a listing the MAC has not filed yet, built to its declared vocabulary */
  const mk = (n, out) => Array.from({ length: n }, (_, i) => ({ position: i ? 'DL' : 'QB', jersey: String(i),
    player_name: 'Player ' + i, status_raw: i < out ? 'Out' : 'Available', status: i < out ? 'OUT' : 'AVAILABLE',
    known: true, raw_text: 'Player ' + i }));
  const read = (listed, roster) => R.fromListing({ conference: 'MAC', team: 'Toledo', roster: roster || [],
    game_id: '401860893', kickoff: G('401860893').kickoff, source_url: HDI.publicViewUrl('MAC'),
    published_at: '2026-09-26T15:00:00.000Z', listed, vocabulary: pending.vocabulary, report_type: 'Game Day',
    platform: 'hdintelligence', now: Date.parse('2026-09-26T15:10:00Z') });
  const full = read(mk(110, 3));
  chk('a MAC listing that designates the whole roster is comprehensive on its own evidence',
    full.ok && full.comprehensive === true && full.listing_scope === 'FULL_ROSTER' && /110 players/.test(full.comprehensive_basis),
    full);
  chk('with its three absences as rows', full.rows.length === 3 && full.rows.every(r => r.status === 'OUT'));
  const partial = read(mk(6, 3));
  chk('a short list proves nothing: it stays SELECTED, as the policy says', partial.ok && partial.comprehensive === false
    && partial.listing_scope === 'PARTIAL');
  const bigRoster = Array.from({ length: 250 }, (_, i) => ({ name: 'Roster ' + i }));
  const half = read(mk(110, 3), bigRoster);
  chk('110 listed against a 250-man roster is not the whole roster', half.comprehensive === false
    && half.listing_scope === 'PARTIAL');
  const merged = OVERLAY.build({ current: null, operator: { live: [] }, reports: [full], now: Date.parse('2026-09-26T15:10:00Z') });
  const t = Object.keys(merged.teams).map(k => merged.teams[k])[0];
  chk('the overlay carries the listing’s own comprehensiveness', t && CONTRACT.officialReportForGame(t, '401860893')
    && CONTRACT.officialReportForGame(t, '401860893').comprehensive === true);
}

section('4. the Pac-12: its own feed, reported players only');
{
  chk('a raw line break inside a string is repaired, as the page repairs it',
    P12.parseTolerant(P12FX.feed_text).games.length === 4);
  const feed = P12.readFeed(P12.parseTolerant(P12FX.feed_text));
  chk('one entry per game: the latest filing wins, as the page shows it', feed.length === 3
    && feed.find(e => e.report_id === 'P12-OSU-CSU').report_type === 'Update 1', feed.map(e => e.report_id + ':' + e.report_type));
  const osu = feed.find(e => e.report_id === 'P12-OSU-CSU');
  chk('dated by the conference’s UTC stamp', osu.published_at === '2026-10-02T01:55:00.000Z');
  chk('matched to its one fixture', (HDI.matchFixture(osu, GAMES, FBS.normKey) || {}).game_id === 'P12-OSU-CSU');
  const read = (e, team, gid) => R.fromListing({ conference: 'Pac-12', team, roster: [], game_id: gid,
    kickoff: G(gid).kickoff, source_url: P12.PAGE_URL, published_at: e.published_at, listed: HDI.sideOf(e, team, FBS.normKey).listed,
    vocabulary: e.vocabulary, report_type: e.report_type, report_id: e.report_id, platform: 'pac12-feed',
    reported_only: true, is_conference_game: true, now: Date.parse('2026-10-02T12:00:00Z') });
  const ore = read(osu, 'Oregon State', 'P12-OSU-CSU'), csu = read(osu, 'Colorado State', 'P12-OSU-CSU');
  chk('Oregon State’s two reported players are rows', ore.ok && ore.rows.length === 2 && ore.listing_scope === 'REPORTED_ONLY');
  chk('a Pac-12 filing is never comprehensive, however it reads', ore.comprehensive === false && csu.comprehensive === false);
  chk('a side it reports nobody for is a read that names nobody — not a failure, not health',
    csu.ok === true && csu.rows.length === 0 && csu.explicit_none === false && csu.silence_means_available === false, csu.why);
  const judged = OVERLAY.corroborate([ore, csu]);
  chk('and it stands, because the same document named someone on the other side', judged[1].ok === true);
  const txst = feed.find(e => e.report_id === 'P12-TXST-SDSU');
  const both = OVERLAY.corroborate([read(txst, 'Texas State', 'P12-TXST-SDSU'), read(txst, 'San Diego State', 'P12-TXST-SDSU')]);
  chk('a game naming nobody on either side is a failed read, not two clean reports', both.every(r => r.ok === false));
  const usu = read(feed.find(e => e.report_id === 'P12-USU-BSU'), 'Utah State', 'P12-USU-BSU');
  chk('a word nobody maps ("Limited (knee)") is quarantined, never guessed', usu.ok && usu.rows.length === 0
    && usu.unparsed.length === 1, usu);
}

section('5. the feed request is the page’s own');
{
  let seen = null;
  const stub = body => (url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200,
    text: () => Promise.resolve(body), headers: { get: () => 'Thu, 01 Oct 2026 01:40:00 GMT' } }); };
  P12.fetchFeed(stub(P12FX.feed_text), 1790000000000).then(r => {
    chk('it reads the feed', r.ok && r.data.games.length === 4, r.why);
    chk('from the file the page renders', seen.url === P12.DATA_URL + '?ts=1790000000000', seen.url);
    chk('with no credential of any kind', !Object.keys((seen.init && seen.init.headers) || {})
      .some(k => /authorization|cookie|token|key/i.test(k)));
    return P12.fetchFeed(stub('<html>not json</html>'));
  }).then(r => {
    chk('a page that is not the feed is a failed read', r.ok === false && /not JSON/.test(r.why), r);
    return P12.fetchFeed(stub('{"config":{}}'));
  }).then(r => {
    chk('a file with no games list is a failed read', r.ok === false && /no list of games/.test(r.why), r);
    scheduleSection();
    finish();
  }).catch(e => { chk('the feed checks ran', false, String(e && e.stack || e)); finish(); });
}

/* 6. A GAME-DAY REPORT IS ONLY WIRED IF THE SYNC RUNS WHILE IT EXISTS. The
   American files two hours before kickoff and the MAC one, so a sync that
   runs every two or three hours can pass a whole filing window by. For every
   kickoff a conference plays on a weeknight or a Friday or Saturday — on the
   hour and the half hour, in both daylight and standard time — the schedule
   in availability-sync.yml must fire inside [kickoff − window, kickoff). */
function scheduleSection() {
  section('6. the sync runs inside every game-day filing window');
  const fs = require('fs');
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'availability-sync.yml'), 'utf8');
  const crons = [...yml.matchAll(/cron:\s*'([^']+)'/g)].map(m => m[1]);
  const field = (f, max) => {
    const out = new Set();
    f.split(',').forEach(part => {
      const [range, step] = part.split('/');
      const [lo, hi] = range === '*' ? [0, max] : range.split('-').map(Number).concat(range.indexOf('-') < 0 ? [Number(range)] : []).slice(0, 2);
      for (let v = lo; v <= (hi == null ? lo : hi); v += step ? Number(step) : 1) out.add(v);
    });
    return out;
  };
  const runs = crons.map(c => { const [m, h, , , dow] = c.split(/\s+/); return { m: Number(m), h: field(h, 23), dow: field(dow, 6) }; });
  const fires = t => { const d = new Date(t); return runs.some(r => r.m === d.getUTCMinutes() && r.h.has(d.getUTCHours()) && r.dow.has(d.getUTCDay())); };
  const firesIn = (from, to) => { for (let t = Math.ceil(from / 60e3) * 60e3; t < to; t += 60e3) if (fires(t)) return true; return false; };
  chk('the schedule was read', runs.length > 0, crons);
  const misses = [];
  /* a Tuesday in October (UTC-4) and one in November (UTC-5) */
  [['2026-10-27', 4], ['2026-11-17', 5]].forEach(([tue, off]) => {
    for (let day = 0; day < 5; day++) {                      /* Tue..Sat, ET */
      const base = Date.parse(tue + 'T00:00:00Z') + day * 24 * H;
      const hours = day < 3 ? [18, 18.5, 19, 19.5, 20, 20.5, 21, 22] : [11, 12, 12.5, 13, 14, 15.5, 16, 17, 18, 19, 19.5, 20, 21, 22];
      hours.forEach(hEt => [1, 2].forEach(win => {
        const kick = base + (hEt + off) * H;
        if (!firesIn(kick - win * H, kick)) misses.push(new Date(kick).toISOString() + ' window ' + win + 'h');
      }));
    }
  });
  chk('every weeknight, Friday and Saturday kickoff has a run inside its 1h and 2h filing windows', misses.length === 0, misses);
}

function finish() {
  console.log('\nAmerican, MAC and Pac-12 reports: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

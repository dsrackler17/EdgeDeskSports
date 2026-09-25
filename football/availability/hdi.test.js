#!/usr/bin/env node
/* ============================================================================
   THE CONFERENCE LISTINGS, READ AS PUBLISHED — and carried to the engine.

   football/availability/hdi.js reads the table the SEC, ACC, Big Ten and
   Big 12 report pages embed. These checks run on four real listings captured
   on 2026-09-25 (fixtures/hdi_published_2026-09-24.json) and prove, offline:

     - a name, a status and a filing time are read exactly as published;
     - each listing is matched to its one fixture, and to nothing else;
     - a listing becomes a report file the overlay reads, a team with
       nobody designated is an EXPLICIT report of no absences, and a status
       nobody maps is quarantined, never guessed;
     - the request is the public screen's own, with no key;
     - and the week-4 case that started this: Ole Miss listing Kewan Lacy
       questionable reaches the engine as Ole Miss's identified starting
       running back.
   ========================================================================== */
'use strict';
const path = require('path');
const HDI = require(path.join(__dirname, 'hdi.js'));
const R = require(path.join(__dirname, 'reports.js'));
const OVERLAY = require(path.join(__dirname, 'overlay.js'));
const ROOT = path.join(__dirname, '..', '..');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const CONTRACT = require(path.join(ROOT, 'football', 'matchup', 'contract.js'));
const FX = require(path.join(__dirname, 'fixtures', 'hdi_published_2026-09-24.json'));

let pass = 0, fail = 0;
function chk(what, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL | ' + what + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 600)));
}
function section(t) { console.log('\n' + t); }
const NOW = Date.parse('2026-09-25T15:00:00Z');

section('1. a name, a status and a filing time, as published');
{
  const p = HDI.parseName('RB #5 Kewan Lacy');
  chk('position, jersey and name come apart', p.position === 'RB' && p.jersey === '5' && p.name === 'Kewan Lacy', p);
  const n = HDI.parseName('S CJ Christian');
  chk('a listing with no jersey keeps the name', n.position === 'S' && n.jersey === null && n.name === 'CJ Christian', n);
  const q = HDI.parseName('RB #21 Anthony “Turbo” Rogers');
  chk('a quoted nickname is kept apart from the name a roster carries', q.name === 'Anthony Rogers' && q.nickname === 'Turbo', q);
  chk('a two-part position is a position', HDI.parseName('N/S #23 Emory Snyder').position === 'N/S');
  const map = { Available: 'AVAILABLE', Probable: 'PROBABLE', Questionable: 'QUESTIONABLE', Doubtful: 'DOUBTFUL',
    Out: 'OUT', 'Out - (1st Half)': 'OUT_FIRST_HALF', Exempt: 'EXEMPT', 'Game-Time Decision': 'GAME_TIME_DECISION' };
  Object.keys(map).forEach(k => chk('"' + k + '" reads as ' + map[k], HDI.statusOf(k).status === map[k], HDI.statusOf(k)));
  chk('a status nobody mapped is unknown, not guessed', HDI.statusOf('Limited (knee)').known === false);
  chk('a Thursday 7:10pm CT filing is 00:10Z Friday (daylight time)',
    HDI.zonedToIso('2026-09-24', '19:10:00', 'CT') === '2026-09-25T00:10:00.000Z');
  chk('an ET filing is offset as ET', HDI.zonedToIso('2026-09-24', '20:00:00', 'ET') === '2026-09-25T00:00:00.000Z');
  chk('and a January CT filing as standard time', HDI.zonedToIso('2026-01-10', '19:00:00', 'CT') === '2026-01-11T01:00:00.000Z');
  chk('an unknown zone is no filing time at all', HDI.zonedToIso('2026-09-24', '19:00:00', 'XT') === null);
}

/* the fixtures these four listings are about, as the slate names them */
const GAMES = [
  { game_id: '401856704', home_team: 'Tennessee', away_team: 'Texas', kickoff: '2026-09-26T16:00:00.000Z', home_conference: 'SEC', away_conference: 'SEC' },
  { game_id: '401858234', home_team: 'California', away_team: 'Clemson', kickoff: '2026-09-26T02:30:00.000Z', home_conference: 'ACC', away_conference: 'ACC' },
  { game_id: '401858461', home_team: 'Indiana', away_team: 'Northwestern', kickoff: '2026-09-26T00:00:00.000Z', home_conference: 'Big Ten', away_conference: 'Big Ten' },
  { game_id: '401856813', home_team: 'Baylor', away_team: 'Colorado', kickoff: '2026-09-26T16:00:00.000Z', home_conference: 'Big 12', away_conference: 'Big 12' },
  /* a decoy: same teams a week later */
  { game_id: 'DECOY', home_team: 'Tennessee', away_team: 'Texas', kickoff: '2026-10-03T16:00:00.000Z', home_conference: 'SEC', away_conference: 'SEC' }
];
const entries = {};
Object.keys(FX.entries).forEach(c => { entries[c] = HDI.readEntry(FX.entries[c].id, FX.entries[c]); });

section('2. each listing is matched to its one fixture');
{
  const want = { SEC: '401856704', ACC: '401858234', B10: '401858461', B12: '401856813' };
  Object.keys(want).forEach(c => {
    const g = HDI.matchFixture(entries[c], GAMES, FBS.normKey);
    chk(c + ': ' + entries[c].teams.map(t => t.team_display).join(' / ') + ' → ' + want[c], g && g.game_id === want[c], g);
  });
  chk('a Friday-night listing matches a game that is Saturday in UTC', HDI.matchFixture(entries.B10, GAMES, FBS.normKey).game_id === '401858461');
  chk('the same teams a week later are not the same fixture',
    HDI.matchFixture(entries.SEC, GAMES.filter(g => g.game_id === 'DECOY'), FBS.normKey) === null);
  const st = HDI.readEntry('x', Object.assign({}, FX.entries.SEC, { games: FX.entries.SEC.games.map((g, i) => i
    ? Object.assign({}, g, { teamName: 'Mississippi St.', teamDisplayName: 'Mississippi St.' }) : g) }));
  chk('"St." is read as "State"', HDI.sideOf(st, 'Mississippi State', FBS.normKey) !== null);
  chk('the filing time is the conference’s, stamped in its zone', entries.SEC.published_at === '2026-09-25T00:10:00.000Z',
    entries.SEC.published_at);
  chk('no status in the four real listings falls outside the vocabulary',
    Object.keys(entries).every(c => entries[c].teams.every(t => t.listed.every(l => l.known))));
}

section('3. a listing becomes the report the overlay reads');
const TEX = entries.SEC.teams.find(t => t.team_display === 'Texas');
const report = side => R.fromListing({ conference: 'SEC', team: side.team_display, roster: [], game_id: '401856704',
  kickoff: '2026-09-26T16:00:00.000Z', source_url: HDI.publicViewUrl('SEC'), published_at: entries.SEC.published_at,
  listed: side.listed, vocabulary: entries.SEC.vocabulary, report_type: entries.SEC.report_type,
  report_id: entries.SEC.report_id, platform: 'hdintelligence', is_conference_game: true, now: NOW });
{
  const r = report(TEX);
  const designated = TEX.listed.filter(l => l.status !== 'AVAILABLE' && l.status !== 'EXEMPT');
  chk('it reads', r.ok === true, r.why);
  chk('every designated player becomes a row, and no available one does', r.rows.length === designated.length && r.rows.length === 5, r.rows.length);
  chk('Texas’s Hollywood Smothers is QUESTIONABLE', r.rows.some(x => x.player_name === 'Hollywood Smothers' && x.status === 'QUESTIONABLE'));
  chk('it is dated by the conference, not by EdgeDesk', r.published_at === '2026-09-25T00:10:00.000Z');
  chk('it names the listing it came from', r.report_type === 'Update 1' && r.report_id === '2818' && r.platform === 'hdintelligence');
  chk('a team with designations is not a report of no absences', r.explicit_none === false && r.silence_means_available === false);

  const clean = Object.assign({}, TEX, { listed: TEX.listed.map(l => Object.assign({}, l,
    l.status === 'EXEMPT' ? {} : { status: 'AVAILABLE', status_raw: 'Available' })) });
  const c = report(clean);
  chk('a listing that marks every player available is an EXPLICIT report of no absences',
    c.ok && c.rows.length === 0 && c.explicit_none === true && c.silence_means_available === true, c.why);
  const merged = OVERLAY.build({ current: null, operator: { live: [] }, reports: [c], now: NOW });
  const t = Object.keys(merged.teams).map(k => merged.teams[k])[0];
  chk('and the overlay honours it without corroboration from the other side',
    t && t.official_report && t.official_report.report_of_no_absences === true, t && t.official_report);

  const odd = Object.assign({}, TEX, { listed: TEX.listed.map((l, i) => i === 0
    ? Object.assign({}, l, { status: null, known: false, status_raw: 'Limited (knee)' }) : Object.assign({}, l,
      l.status === 'EXEMPT' ? {} : { status: 'AVAILABLE', status_raw: 'Available' })) });
  const o = report(odd);
  chk('a status nobody maps is quarantined, and the listing is then NOT read as whole',
    o.ok && o.unparsed.length === 1 && o.explicit_none === false && o.silence_means_available === false, o.why);
  const none = report(Object.assign({}, TEX, { listed: [] }));
  chk('a listing with nobody on it is a failed read, not a clean one', none.ok === false, none.why);
  const undated = R.fromListing(Object.assign({ conference: 'SEC', team: 'Texas', listed: TEX.listed, now: NOW }));
  chk('an undated listing is refused', undated.ok === false && /filing time/.test(undated.why), undated.why);
}

section('4. the request is the public screen’s own');
{
  let seen = null;
  const stub = (url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ '1': FX.entries.SEC }) }); };
  HDI.fetchPublished('SEC', stub).then(r => {
    chk('it reads the published table', r.ok && Object.keys(r.data).length === 1);
    chk('from the public endpoint', seen.url === 'https://app.hdintelligence.com/api/get-publish-public');
    const body = JSON.parse(seen.init.body), h = seen.init.headers || {};
    chk('with the public view’s parameters', body.sport === 'Football' && body.organization === 'SEC' && body.conference === 'SEC', body);
    chk('and no key or credential of any kind',
      !Object.keys(h).some(k => /api-key|authorization|cookie|token/i.test(k)) && !/7N4q2/.test(JSON.stringify(seen.init)), h);
  }).then(section5).catch(e => { chk('the request check ran', false, String(e && e.stack || e)); finish(); });
}

/* 5. THE CASE THAT STARTED THIS. Ole Miss's week-4 listing (Update 1, filed
   2026-09-24 19:10 CT) has RB #5 Kewan Lacy questionable. */
function section5() {
  section('5. Ole Miss lists Kewan Lacy questionable: the engine hears it');
  const fs = require('fs');
  const listed = [
    { position: 'RB', jersey: '5', player_name: 'Kewan Lacy', status_raw: 'Questionable', status: 'QUESTIONABLE', known: true, raw_text: 'RB #5 Kewan Lacy · Questionable' },
    { position: 'QB', jersey: '6', player_name: 'Trinidad Chambliss', status_raw: 'Available', status: 'AVAILABLE', known: true, raw_text: 'QB #6 Trinidad Chambliss · Available' }
  ];
  const r = R.fromListing({ conference: 'SEC', team: 'Ole Miss', roster: [], game_id: '401856699',
    kickoff: '2026-09-26T19:30:00.000Z', source_url: HDI.publicViewUrl('SEC'), published_at: '2026-09-25T00:10:00.000Z',
    listed, vocabulary: entries.SEC.vocabulary, report_type: 'Update 1', report_id: '2851', platform: 'hdintelligence',
    is_conference_game: true, now: NOW });
  const merged = OVERLAY.build({ current: null, operator: { live: [] }, reports: [r], now: NOW });
  const byTeam = {};
  Object.keys(merged.teams).forEach(k => { const t = merged.teams[k]; byTeam[CONTRACT.normKey(t.team_name)] = t; });
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'teams', 'olemiss.json'), 'utf8'));
  const ctx = { availability_by_team: byTeam, availability_as_of: null,
    player_details_by_team: { olemiss: CONTRACT.playerDetailsFrom(file) } };
  const inj = CONTRACT.injuriesFor(ctx, 'Ole Miss', '401856699', { AV_OVERLAY: OVERLAY });
  const lacy = inj && inj.find(x => x.player === 'Kewan Lacy');
  chk('the listing reaches the engine’s injury list', !!lacy, inj);
  chk('as questionable', lacy && lacy.status === 'questionable');
  chk('identified from the player layer as the starting running back',
    lacy && lacy.starter === true && lacy.position === 'RB' && lacy.athlete_id != null, lacy);
  chk('with his measured snap share', lacy && lacy.snap_share === 0.85, lacy && lacy.snap_share);
  chk('and nobody the listing marks available is handed to the engine', inj.every(x => x.player !== 'Trinidad Chambliss'));
  finish();
}

function finish() {
  console.log('\nconference listings: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

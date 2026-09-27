#!/usr/bin/env node
/* ============================================================================
   AN EMPTY RESPONSE IS NEVER A CLEAN BILL OF HEALTH.

   Everything in the availability layer turns on one distinction, and every way
   of losing it is tested here:

     a source that named nobody         a report, if and only if that source
                                        designates every player
     a source that could not be read    a FAILED READ, always
     a report that was not required     a fact about the fixture, never about
                                        anybody's fitness
     a report not yet due               a document that does not exist yet
     a roster listing                   not evidence of anything

   It also holds the policy registry to what it actually says: conference
   reports cover CONFERENCE games, three of the registered conferences file
   only absences rather than designating everybody, and two are recorded as
   UNVERIFIED rather than as publishing nothing.
   ========================================================================== */
'use strict';
const path = require('path');
const R = require(path.join(__dirname, 'reports.js'));
const POLICY = require(path.join(__dirname, 'policy.js'));
const OPERATOR = require(path.join(__dirname, 'operator.js'));
const OVERLAY = require(path.join(__dirname, 'overlay.js'));
const PDF = require(path.join(__dirname, 'pdf_text.js'));
const zlib = require('zlib');

let pass = 0, fail = 0;
function chk(what, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL | ' + what + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}
function section(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-09-17T12:00:00Z');
const ROSTER = [
  { name: 'Carson Beck', position: 'QB', espn_id: '1' },
  { name: 'Rueben Bain Jr.', position: 'DL', espn_id: '2' },
  { name: 'Darian Mensah', position: 'QB', espn_id: '3' }
];
const BASE = { conference: 'ACC', team: 'Miami', roster: ROSTER, source_url: 'https://theacc.com/x',
  published_at: '2026-09-17T02:00:00Z', game_id: '401858226', kickoff: '2026-09-18T23:30:00Z',
  is_conference_game: true, now: NOW };

/* ═════ 1. the policy registry says what it knows and no more ═════════ */
section('1. the policy registry — scope, vocabulary, and what it has not checked');
{
  chk('every registered conference carries a state', POLICY.CONFERENCES.every(c => !!c.state));
  chk('every PUBLISHED conference carries a url and a source for the claim',
    POLICY.published().every(c => !!c.report_url && !!c.source),
    POLICY.published().filter(c => !c.report_url || !c.source).map(c => c.id));
  /* ONE EXCEPTION, ON THE CONFERENCE'S OWN FILINGS: the MAC's 2026 archive
     carries its schools' reports for non-conference games too
     (conferences.test.js). No other conference may claim it. */
  chk('every PUBLISHED policy covers conference games only, except the MAC, whose filings cover every game',
    POLICY.published().every(c => c.applies_to === 'CONFERENCE_GAMES' || (c.applies_to === 'ALL_GAMES' && c.id === 'midamerican')),
    POLICY.published().map(c => c.id + '=' + c.applies_to));
  /* THE THING THE TASK NAMES: not every conference publishes the same report */
  const comp = POLICY.published().filter(c => c.comprehensive).map(c => c.id);
  const sel = POLICY.published().filter(c => !c.comprehensive).map(c => c.id);
  chk('some conferences designate every player and some file only absences, and they are not treated alike',
    comp.length > 0 && sel.length > 0, { comprehensive: comp, selected: sel });
  chk('a conference that files only OUT/QUESTIONABLE can never mean everybody else is available',
    POLICY.published().filter(c => !c.comprehensive).every(c => !POLICY.silenceMeansAvailable(c)));
  chk('an UNVERIFIED conference is recorded as unresearched, NOT as publishing nothing',
    POLICY.CONFERENCES.filter(c => c.state === 'UNVERIFIED')
      .every(c => /gap in EdgeDesk|not a finding/i.test(c.why || '')),
    POLICY.CONFERENCES.filter(c => c.state === 'UNVERIFIED').map(c => c.id));

  const nonConf = POLICY.forGame({ home_conference: 'Big Ten', away_conference: 'Missouri Valley',
    is_conference_game: false, kickoff: '2026-09-19T23:00:00Z' }, 'home', NOW);
  chk('a non-conference fixture requires no report', nonConf.state === 'NOT_REQUIRED_FOR_THIS_GAME');
  chk('and says so without implying anybody is fit',
    /not.*evidence that anybody is healthy/i.test(nonConf.why), nonConf.why);

  const early = POLICY.forGame({ home_conference: 'ACC', away_conference: 'ACC', is_conference_game: true,
    kickoff: '2026-09-25T23:00:00Z' }, 'home', NOW);
  chk('a conference game outside the filing window is NOT_DUE_YET, not missing', early.state === 'NOT_DUE_YET');
  const due = POLICY.forGame({ home_conference: 'ACC', away_conference: 'ACC', is_conference_game: true,
    kickoff: '2026-09-18T23:30:00Z' }, 'home', NOW);
  chk('and inside it the report is REQUIRED, with the url to fetch',
    due.state === 'REQUIRED' && /theacc\.com/.test(due.report_url || ''), due);
  const unknownConf = POLICY.forGame({ home_conference: 'Some New League', away_conference: 'Some New League',
    is_conference_game: true, kickoff: '2026-09-18T23:30:00Z' }, 'home', NOW);
  chk('an unregistered conference is UNREGISTERED, not "no policy"', unknownConf.state === 'UNREGISTERED');
  chk('and says it is an open question rather than a settled finding',
    /open question/i.test(unknownConf.why), unknownConf.why);
}

/* ═════ 2. reading a document ════════════════════════════════════════ */
section('2. what a read produces, and what a failed read produces');
{
  const table = '<table><tr><td>Carson Beck</td><td>QB</td><td>Out</td></tr>'
    + '<tr><td>Rueben Bain Jr.</td><td>DL</td><td>Questionable</td></tr></table>';
  const r = R.ingest(Object.assign({}, BASE, { body: table, content_type: 'text/html' }));
  chk('a filed report resolves its named players', r.ok && r.rows.length === 2, r.rows);
  chk('statuses come from the document, mapped into the vocabulary',
    r.rows.map(x => x.status).sort().join(',') === 'OUT,QUESTIONABLE', r.rows.map(x => x.status));
  chk('each row carries the position from the ROSTER, not from the document',
    r.rows.every(x => !!x.position));
  chk('the publication time and the retrieval time are separate fields',
    r.published_at === BASE.published_at && r.retrieved_at !== r.published_at, r);
  chk('the report records the conference scope it was filed under', r.scope === 'CONFERENCE_GAMES');
  chk('and whether silence about a player means anything', r.comprehensive === true);

  /* THE CORE GUARANTEE, FOUR WAYS */
  const empty = R.ingest(Object.assign({}, BASE, { body: '', content_type: 'text/html' }));
  chk('an EMPTY response is a failed read, never a report', empty.ok === false, empty);
  chk('and it can never mean nobody is out', empty.silence_means_available !== true, empty);
  const blocked = R.ingest(Object.assign({}, BASE, { body: null, content_type: 'text/html' }));
  chk('a blocked request is a failed read too', blocked.ok === false);
  const scan = R.ingest(Object.assign({}, BASE,
    { body: Buffer.from('%PDF-1.4\nnothing here\n%%EOF'), content_type: 'application/pdf' }));
  chk('a PDF this reader cannot extract is a failed read, never an empty report',
    scan.ok === false && /could not be read/.test(scan.why), scan.why);
  const undated = R.ingest(Object.assign({}, BASE, { body: table, content_type: 'text/html', published_at: null }));
  chk('an undated document is refused rather than dated from when EdgeDesk read it',
    undated.ok === false && /no publication date/.test(undated.why), undated.why);
  const future = R.ingest(Object.assign({}, BASE, { body: table, content_type: 'text/html',
    published_at: '2027-01-01T00:00:00Z' }));
  chk('a document dated in the future is refused', future.ok === false && /in the future/.test(future.why));

  /* the ONE route from silence to available, and the one that is not */
  const quiet = R.ingest(Object.assign({}, BASE, { body: '<p>No Miami players are listed this week.</p>',
    content_type: 'text/html' }));
  chk('a COMPREHENSIVE report read in full and naming nobody IS a report of no absences',
    quiet.ok === true && quiet.silence_means_available === true, quiet.why);
  const selective = R.ingest(Object.assign({}, BASE, { conference: 'Mountain West', team: 'Miami',
    body: '<p>Nobody listed.</p>', content_type: 'text/html' }));
  chk('the same silence from a conference that files only absences says nothing',
    selective.ok === true && selective.silence_means_available === false, selective.why);
  chk('and it says why rather than leaving the reader to infer it',
    /not a statement that the roster is whole/.test(selective.why), selective.why);

  /* a status outside the conference's published vocabulary: the Mountain
     West files only OUT and QUESTIONABLE (the ACC, whose example this once
     was, lists PROBABLE in its own policy and files it) */
  const odd = R.ingest(Object.assign({}, BASE, { conference: 'Mountain West',
    body: '<table><tr><td>Carson Beck</td><td>Probable</td></tr></table>', content_type: 'text/html' }));
  chk('a designation the conference does not publish is quarantined, not mapped onto a neighbour',
    odd.rows.length === 0 && odd.unparsed.length === 1
      && /not in this conference/.test(odd.unparsed[0].why || ''), odd.unparsed);

  /* a name that is not on the roster cannot become a player */
  const stray = R.ingest(Object.assign({}, BASE,
    { body: '<table><tr><td>Somebody Nobody</td><td>QB</td><td>Out</td></tr></table>', content_type: 'text/html' }));
  chk('a name not on the roster never becomes a player', stray.rows.length === 0, stray.rows);
}

/* ═════ 3. PDFs ══════════════════════════════════════════════════════ */
section('3. a PDF is read or refused, never half-read');
{
  const content = 'BT (Miami Availability) Tj T* (Carson Beck QB OUT) Tj T* (Rueben Bain Jr. DL QUESTIONABLE) Tj ET';
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'),
    Buffer.from('1 0 obj << /Length ' + z.length + ' /Filter /FlateDecode >> stream\n'), z,
    Buffer.from('\nendstream endobj\n%%EOF\n')]);
  const out = PDF.extract(pdf);
  chk('a text PDF extracts its lines', out.ok && out.lines.length === 3, out);
  const r = R.ingest(Object.assign({}, BASE, { body: pdf, content_type: 'application/pdf' }));
  chk('and ingests to resolved players', r.ok && r.rows.length === 2, r.rows.map(x => x.player_name + '=' + x.status));
  chk('the format is recorded so a parser gap is attributable', r.format === 'pdf');
  const notPdf = PDF.extract(Buffer.from('<html>error page</html>'));
  chk('an error page served as a PDF is refused with the reason',
    notPdf.ok === false && /not a PDF/.test(notPdf.why), notPdf.why);
}

/* ═════ 4. conflicts ═════════════════════════════════════════════════ */
section('4. two filings, one player — the later one wins and the earlier one is kept');
{
  const a = { player_name: 'Carson Beck', player_id: '1', game_id: 'g1', status: 'QUESTIONABLE',
    published_at: '2026-09-17T02:00:00Z', retrieved_at: '2026-09-17T03:00:00Z', source_url: 'u1' };
  const b = { player_name: 'Carson Beck', player_id: '1', game_id: 'g1', status: 'OUT',
    published_at: '2026-09-18T20:00:00Z', retrieved_at: '2026-09-18T21:00:00Z', source_url: 'u2' };
  const rec = R.reconcile([a], [b]);
  chk('the later filing wins', rec.records.length === 1 && rec.records[0].status === 'OUT', rec.records);
  chk('the earlier one is kept beside it rather than overwritten',
    !!rec.records[0].superseded && rec.records[0].superseded.status === 'QUESTIONABLE', rec.records[0]);
  chk('and the conflict is recorded with both sources', rec.conflicts.length === 1
    && rec.conflicts[0].resolved_by === 'the later filing', rec.conflicts);

  const tie = R.reconcile([a], [Object.assign({}, b, { published_at: a.published_at })]);
  chk('two filings at the same instant with different statuses are NOT resolved',
    tie.conflicts.length === 1 && tie.conflicts[0].resolved_to === null, tie.conflicts);
  chk('and the record is marked conflicting rather than silently picking one',
    tie.records[0].conflicting === true, tie.records[0]);
}

/* ═════ 5. the operator door is narrow ═══════════════════════════════ */
section('5. an operator correction needs a source, a date, a fixture and an author');
{
  const good = { kind: 'AVAILABILITY', team: 'Miami', player: 'Carson Beck', status: 'OUT',
    game_id: '401858226', kickoff: '2026-09-18T23:30:00Z', source_name: 'ACC report',
    source_url: 'https://theacc.com/x', published_at: '2026-09-17T02:00:00Z',
    recorded_by: 'ops', recorded_at: '2026-09-17T03:00:00Z' };
  chk('a complete entry is accepted', OPERATOR.validate(good, NOW).ok === true);
  chk('and it expires', !!OPERATOR.validate(good, NOW).entry.expires_at);
  [['source_url', 'not a url'], ['published_at', null], ['recorded_by', null], ['player', null],
    ['source_name', null]].forEach(([k, v]) => {
    const bad = Object.assign({}, good); bad[k] = v;
    chk('an entry with no valid ' + k + ' is refused outright', OPERATOR.validate(bad, NOW).ok === false);
  });
  const noFixture = Object.assign({}, good); delete noFixture.game_id; delete noFixture.kickoff;
  chk('an entry with no fixture and no expiry is refused — a permanent claim is not accepted',
    OPERATOR.validate(noFixture, NOW).ok === false);
  const blogStarter = { kind: 'STARTER', team: 'Miami', player: 'Darian Mensah', position: 'QB', confirmed: true,
    game_id: 'g', source_name: 'a blog', source_url: 'https://example.com/p',
    published_at: '2026-09-17T02:00:00Z', recorded_by: 'ops', recorded_at: '2026-09-17T03:00:00Z' };
  const v = OPERATOR.validate(blogStarter, NOW);
  chk('an operator cannot promote a projection to a confirmation without an official source',
    v.ok && v.entry.confirmed === false && !!v.entry.downgraded_why, v.entry);
  const official = OPERATOR.validate(Object.assign({}, blogStarter,
    { source_url: 'https://hurricanesports.com/news/x' }), NOW);
  chk('an official source may carry one', official.entry.confirmed === true && official.entry.tier === 1);
  chk('there is no status meaning "everybody is available"',
    OPERATOR.STATUSES.indexOf('ALL_AVAILABLE') < 0 && OPERATOR.STATUSES.indexOf('HEALTHY') < 0,
    OPERATOR.STATUSES);
  const expired = OPERATOR.load({ entries: [Object.assign({}, good,
    { expires_at: '2026-09-01T00:00:00Z' })] }, NOW);
  chk('an expired entry stops being applied and is published as expired',
    expired.live.length === 0 && expired.expired.length === 1);
  const refused = OPERATOR.load({ entries: [{ kind: 'AVAILABILITY' }] }, NOW);
  chk('a half-filled entry is published as refused rather than sitting silently inert',
    refused.refused.length === 1 && refused.refused[0].why.length > 0, refused.refused);
}

/* ═════ 6. the overlay grades what is actually on file ════════════════ */
section('6. the merged view never grades a failed read as a clean one');
{
  const current = { teams: { m: { team_id: '2390', team_name: 'Miami', team_display: 'Miami Hurricanes',
    dataQuality: 'LIMITED', players: [], counts: {} } } };
  const failedRead = { schema: R.SCHEMA, team: 'Miami', ok: false, rows: [],
    source_url: 'u', why: 'HTTP 403', retrieved_at: '2026-09-17T03:00:00Z' };
  const a = OVERLAY.build({ current, operator: { live: [] }, reports: [failedRead], now: NOW });
  chk('a failed read does not raise the grade', a.teams.m.dataQuality === 'LIMITED', a.teams.m.dataQuality);
  chk('and it is recorded as a failed read, with the reason',
    !!a.teams.m.official_report_failed && /403/.test(a.teams.m.official_report_failed.why));
  chk('the team is NOT given a report object it does not have', a.teams.m.official_report === null);

  const real = { schema: R.SCHEMA, team: 'Miami', ok: true, comprehensive: true, silence_means_available: false,
    conference: 'Atlantic Coast Conference', source_url: 'u', published_at: '2026-09-17T02:00:00Z',
    retrieved_at: '2026-09-17T03:00:00Z', scope: 'CONFERENCE_GAMES', vocabulary: ['OUT'],
    rows: [{ player_name: 'Carson Beck', player_id: '1', position: 'QB', status: 'OUT' }], unparsed: [] };
  const b = OVERLAY.build({ current, operator: { live: [] }, reports: [real], now: NOW });
  chk('an ingested report grades the team OFFICIAL', b.teams.m.dataQuality === 'OFFICIAL');
  chk('its players land on the team with the OFFICIAL source type',
    b.teams.m.players.length === 1 && b.teams.m.players[0].source_type === 'OFFICIAL');
  chk('the observation time is the report’s publication, not the sync’s run time',
    Date.parse(b.teams.m.observed_at) === Date.parse('2026-09-17T02:00:00Z'), b.teams.m.observed_at);

  /* SILENCE HAS TO BE CORROBORATED. A document read for one side that names
     nobody is indistinguishable from a page that is not the report; the same
     document naming the OTHER side's players is what shows it is this game's
     report and that it simply lists none of ours. */
  const quiet = Object.assign({}, real, { rows: [], silence_means_available: true, game_id: 'G1' });
  const alone = OVERLAY.build({ current, operator: { live: [] }, reports: [quiet], now: NOW });
  chk('a report naming nobody on EITHER side of its fixture is a failed read, not a clean bill of health',
    alone.teams.m.official_report === null && !!alone.teams.m.official_report_failed
      && /named nobody on either side/.test(alone.teams.m.official_report_failed.why), alone.teams.m);
  chk('and it does not raise the grade', alone.teams.m.dataQuality === 'LIMITED', alone.teams.m.dataQuality);
  const other = Object.assign({}, real, { team: 'Florida State', game_id: 'G1',
    rows: [{ player_name: 'Some One', player_id: '9', position: 'WR', status: 'QUESTIONABLE' }] });
  const c = OVERLAY.build({ current, operator: { live: [] }, reports: [quiet, other], now: NOW });
  chk('the same document naming the other side’s players corroborates it: report_of_no_absences, no invented records',
    c.teams.m.official_report && c.teams.m.official_report.report_of_no_absences === true && c.teams.m.players.length === 0,
    c.teams.m.official_report);
  const elsewhere = Object.assign({}, other, { source_url: 'another-document' });
  const d = OVERLAY.build({ current, operator: { live: [] }, reports: [quiet, elsewhere], now: NOW });
  chk('a different document does not corroborate it', d.teams.m.official_report === null, d.teams.m.official_report);
  const said = Object.assign({}, quiet, { explicit_none: true });
  const e = OVERLAY.build({ current, operator: { live: [] }, reports: [said], now: NOW });
  chk('a parser that read an explicit "none listed" for this team makes it a report of no absences',
    e.teams.m.official_report && e.teams.m.official_report.report_of_no_absences === true, e.teams.m.official_report);
  const judged = OVERLAY.corroborate([quiet]);
  chk('corroborate never edits the report it was handed', quiet.ok === true && judged[0] !== quiet && judged[0].ok === false);
}

section('7. a web page is never dated from its server header');
{
  const html = Buffer.from('<html><body>report</body></html>');
  const pdf = Buffer.from('%PDF-1.4 ...');
  const LM = 'Fri, 25 Sep 2026 14:59:23 GMT';
  chk('a CMS page’s Last-Modified is its cache rebuild, not a filing time', R.publishedFromHeaders(LM, 'text/html; charset=utf-8', html) === null);
  chk('a PDF’s Last-Modified is when it was uploaded', R.publishedFromHeaders(LM, 'application/pdf', pdf) === LM);
  chk('a PDF is recognised by its bytes when the server mislabels it', R.publishedFromHeaders(LM, 'application/octet-stream', pdf) === LM);
  chk('no header, no date', R.publishedFromHeaders(null, 'application/pdf', pdf) === null);
}

section('8. the reports already on file');
{
  /* every committed file that names nobody on either side of its fixture —
     this season, every ACC, Big 12 and Big Ten read, taken from a homepage
     or a policy page — is read as the failed read it was */
  const fs = require('fs');
  const all = R.readAll(path.join(__dirname, 'reports')).map(x => x.report);
  const merged = OVERLAY.build({ current: null, operator: { live: [] }, reports: all, now: NOW });
  const clean = Object.keys(merged.teams).map(k => merged.teams[k])
    .filter(t => t.official_report && t.official_report.report_of_no_absences && !t.official_report.names);
  const uncorroborated = OVERLAY.corroborate(all).filter(r => r.uncorroborated).length;
  chk('no committed file becomes a report of no absences without corroboration',
    clean.every(t => all.some(r => r.ok && (r.rows || []).length && String(r.game_id) === String(t.official_report.game_id)
      && r.source_url === t.official_report.source_url) || all.some(r => r.explicit_none && r.team === t.team_name)),
    clean.map(t => t.team_name));
  console.log('       (' + uncorroborated + ' committed read(s) named nobody on either side and are read as failed reads)');
}

/* THE BUNDLE THE BOARD READS IS THE DIRECTORY THE BUILD READS. The board
   cannot list football/availability/reports/, so it reads the one-file copy;
   a report written without rewriting the copy would put the board back to
   reporting "no report" for a filing the published slate has. */
{
  const fs = require('fs');
  const dir = path.join(__dirname, 'reports');
  const committed = JSON.parse(fs.readFileSync(R.BUNDLE_FILE, 'utf8'));
  const fresh = R.bundle(dir);
  chk('the committed reports bundle carries every report in the directory, in file-name order',
    JSON.stringify(committed) === JSON.stringify(fresh),
    { committed: (committed.reports || []).length, directory: fresh.reports.length });
  chk('the bundle is the schema the board reads', committed.schema === R.BUNDLE_SCHEMA);
  /* the overlay reads a bundled report exactly as it reads the file */
  const files = R.readAll(dir);
  if (files.length) {
    const fromFiles = OVERLAY.build({ current: null, operator: { live: [] }, reports: files.map(x => x.report), now: NOW });
    const fromBundle = OVERLAY.build({ current: null, operator: { live: [] }, reports: committed.reports, now: NOW });
    chk('the overlay merges the bundle to the same teams, grades and official reports as the files',
      JSON.stringify(fromFiles.teams) === JSON.stringify(fromBundle.teams));
  }
  const src = fs.readFileSync(path.join(__dirname, 'sync_reports.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'ingest_report.js'), 'utf8');
  chk('both report writers rewrite the bundle', (src.match(/R\.writeBundle\(/g) || []).length >= 2);
}

console.log('\navailability reports: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

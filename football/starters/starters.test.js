#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk starter-context layer.

   THE RULES UNDER TEST, one assertion group each:
     - an expected starter is never published as a confirmed one
     - a transfer's previous team never follows him into this season
     - a duplicate name resolves to nobody rather than to the wrong player
     - two sources at one tier are a competition, not a coin toss
     - a lower tier never overwrites a higher one, and the disagreement is kept
     - "no report found" is UNKNOWN, never healthy
     - a stale piece of evidence stops resolving and says why
     - a research-only record cannot become a priced engine input
     - data present upstream survives the join into the record (the regression
       that produced 77 unknown quarterbacks: the play feed had the answer and
       the request said null)

   Offline: every network edge is behind recovery.js, driven here with a
   fixture fetch.

   Run: node football/starters/starters.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, 'starters.js'));
const R = require(path.join(__dirname, '..', 'data', 'recovery.js'));
const B = require(path.join(__dirname, 'build_starters.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 460) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const NOW = Date.parse('2026-09-15T12:00:00Z');
const ROSTER = [
  { athlete_id: '1001', name: 'Sam Leavitt', position: 'QB', team: 'LSU' },
  { athlete_id: '1002', name: 'Landen Clark', position: 'QB', team: 'LSU' },
  { athlete_id: '1003', name: 'Chris Brown', position: 'QB', team: 'LSU' },
  { athlete_id: '1004', name: 'Chris Brown', position: 'WR', team: 'LSU' },
  { athlete_id: '1005', name: "Ke'Shawn O'Neal Jr.", position: 'QB', team: 'LSU' }
];
const IDX = S.rosterIndex(ROSTER, { team: 'LSU' });

function ev(o) {
  return Object.assign({ team: 'LSU', season: 2026, week: 2, source: 'fixture',
    source_url: 'https://example.invalid/fixture', published_at: '2026-09-13T00:00:00Z',
    retrieved_at: '2026-09-15T08:00:00Z' }, o);
}
function resolve(evidence, extra) {
  return S.resolveStarter(Object.assign({
    team: 'LSU', team_id: 'lsu', season: 2026, week: 3, position: 'QB',
    evidence: evidence, roster_index: IDX, now: NOW
  }, extra || {}));
}

/* ---- 1. the six states are represented, and none of them is "confirmed" --- */
{
  const announced = resolve([ev({ kind: 'OFFICIAL_ANNOUNCEMENT', player_id: '1001' })]);
  chk('an official announcement resolves to ANNOUNCED', announced.status === 'ANNOUNCED', announced.status);
  chk('an announced starter is the only one marked confirmed', announced.confirmed === true && announced.announced === true);

  const media = resolve([ev({ kind: 'MEDIA_REPORT', player_id: '1001' })]);
  chk('a media report can reach EXPECTED and no further', media.status === 'EXPECTED', media.status);
  chk('an expected starter is NEVER published as confirmed', media.confirmed === false && media.announced === false);
  chk('the expected label says it is not an announcement', /not an official announcement/.test(media.label), media.label);

  const usage = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })]);
  chk('a previous start resolves to PREVIOUS_GAME', usage.status === 'PREVIOUS_GAME', usage.status);
  chk('a previous-game starter is not confirmed', usage.confirmed === false);
  chk('the previous-game label says no announcement exists', /no announcement/.test(usage.label), usage.label);

  const depth = resolve([ev({ kind: 'DEPTH_CHART', player_id: '1002' })]);
  chk('a depth chart resolves to DEPTH_CHART', depth.status === 'DEPTH_CHART', depth.status);

  const none = resolve([]);
  chk('no evidence at all resolves to UNKNOWN', none.status === 'UNKNOWN' && none.player_id === null);
  chk('UNKNOWN says nothing reached the team', /no usable evidence/.test(none.basis), none.basis);

  /* a PROJECTION on its own may never name a starter: tier 4 tops out at
     COMPETITION, which is the engine's way of saying "this is not evidence" */
  const proj = resolve([ev({ kind: 'PROJECTION', player_id: '1001' })]);
  chk('a model projection alone never resolves a starter', proj.status === 'COMPETITION', proj.status);
}

/* ---- 2. the strongest tier wins, and disagreement is recorded ------------- */
{
  const r = resolve([
    ev({ kind: 'GAME_USAGE', player_id: '1002' }),
    ev({ kind: 'OFFICIAL_ANNOUNCEMENT', player_id: '1001' })
  ]);
  chk('an official announcement outranks last week\'s start', r.player_id === '1001' && r.status === 'ANNOUNCED', r.status + '/' + r.player_id);
  chk('the lower-tier disagreement is kept, not dropped', r.conflicts.length === 1 && r.conflicts[0].names[0].player_id === '1002', r.conflicts);
  chk('every piece of evidence survives into the record', r.evidence.length === 2);
}

/* ---- 3. two names at one tier is a competition ---------------------------- */
{
  const r = resolve([
    ev({ kind: 'MEDIA_REPORT', player_id: '1001', source: 'outlet A' }),
    ev({ kind: 'MEDIA_REPORT', player_id: '1002', source: 'outlet B' })
  ]);
  chk('two same-tier sources naming different players is COMPETITION', r.status === 'COMPETITION', r.status);
  chk('a competition names nobody as the starter', r.player_id === null);
  chk('a competition records both names', r.conflicts.length && r.conflicts[0].names.length === 2, r.conflicts);
  chk('a competition is a CONFLICTING field state', r.field_state === 'CONFLICTING', r.field_state);
}

/* ---- 4. a split usage picture overrides a single previous start ----------- */
{
  const comp = { contested: true, games: 2, players: [
    { player_id: '1001', player_name: 'Sam Leavitt', share: 0.55 },
    { player_id: '1002', player_name: 'Landen Clark', share: 0.45 }] };
  const r = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })], { usage_competition: comp });
  chk('a contested QB room turns a previous start into a competition', r.status === 'COMPETITION', r.status);
  chk('the split is stated with both shares', /55%.*45%|55% \/ Landen/.test(r.basis), r.basis);
  /* and it must NOT override an announcement */
  const r2 = resolve([ev({ kind: 'OFFICIAL_ANNOUNCEMENT', player_id: '1001' })], { usage_competition: comp });
  chk('a contested room does not override an announcement', r2.status === 'ANNOUNCED', r2.status);
}

/* ---- 5. identity: transfers, duplicate names, season rollover ------------- */
{
  const lastSeason = resolve([ev({ kind: 'MEDIA_REPORT', player_id: '1001', season: 2025 })]);
  chk('evidence from another season is refused outright', lastSeason.status === 'UNKNOWN', lastSeason.status);
  chk('the refusal says which season it came from', /season 2025/.test(JSON.stringify(lastSeason.refused)), lastSeason.refused);

  const dup = resolve([ev({ kind: 'MEDIA_REPORT', player_name: 'Chris Brown' })]);
  chk('a duplicate name resolves to nobody', dup.status === 'UNKNOWN' && dup.player_id === null, dup.status);
  chk('the duplicate-name refusal says why', /not unique/.test(JSON.stringify(dup.refused)), dup.refused);

  /* THE TWO THINGS AN ABSENT ID CAN MEAN, and they need different answers. */
  const IDX_G = S.rosterIndex(ROSTER, { team: 'LSU', team_key: 'lsu',
    global: { 1001: 'lsu', 1002: 'lsu', 1003: 'lsu', 1004: 'lsu', 1005: 'lsu', 8888: 'texas' } });
  const transferred = S.resolveStarter({ team: 'LSU', team_id: 'lsu', season: 2026, week: 3,
    evidence: [ev({ kind: 'MEDIA_REPORT', player_id: '8888' })], roster_index: IDX_G, now: NOW });
  chk('a player on another team\'s current roster never resolves here', transferred.status === 'UNKNOWN', transferred.status);
  chk('the transfer refusal names the team he is actually on',
    /belongs to texas/.test(JSON.stringify(transferred.refused)), transferred.refused);

  const uncorroborated = S.resolveStarter({ team: 'LSU', team_id: 'lsu', season: 2026, week: 3,
    evidence: [ev({ kind: 'GAME_USAGE', player_id: '9999', player_name: 'Walk On' })], roster_index: IDX_G, now: NOW });
  chk('an id no roster file carries still resolves off the play feed',
    uncorroborated.status === 'PREVIOUS_GAME' && uncorroborated.player_id === '9999', uncorroborated.status);
  chk('an uncorroborated identity says so rather than pretending to be confirmed',
    uncorroborated.identity_corroborated === false && /no roster file/.test(uncorroborated.identity_basis),
    uncorroborated.identity_basis);

  const unique = resolve([ev({ kind: 'MEDIA_REPORT', player_name: 'Sam Leavitt' })]);
  chk('a unique name on the current roster resolves to its athlete id', unique.player_id === '1001', unique.player_id);
  chk('the identity basis names how it was resolved', /unique name match/.test(unique.identity_basis), unique.identity_basis);

  chk('a suffix and an apostrophe do not split one player into two',
    S.normName("Ke'Shawn O'Neal Jr.") === S.normName('KeShawn ONeal'), [S.normName("Ke'Shawn O'Neal Jr."), S.normName('KeShawn ONeal')]);
}

/* ---- 6. staleness stops a resolution and says why ------------------------- */
{
  const old = resolve([ev({ kind: 'MEDIA_REPORT', player_id: '1001', retrieved_at: '2026-09-01T00:00:00Z' })]);
  chk('a report past its freshness floor stops resolving', old.status === 'UNKNOWN', old.status);
  chk('the stale evidence is still carried with its age', old.evidence.length === 1 && old.evidence[0].stale === true, old.evidence);
  chk('the stale record says how old it is', /past the 96h floor/.test(old.evidence[0].stale_why || ''), old.evidence[0].stale_why);
  chk('an all-stale record reads as STALE, not as missing', old.field_state === 'STALE' || old.field_state === 'UNAVAILABLE', old.field_state);

  const oldStart = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001', week: 0 })]);
  chk('a start three weeks old no longer stands as this week\'s expectation', oldStart.status === 'UNKNOWN', oldStart.status);
}

/* ---- 7. availability is a second axis and is never read as healthy -------- */
{
  const r = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })], { availability_checked: true });
  chk('no availability record is UNKNOWN, not AVAILABLE', r.availability.state === 'UNKNOWN', r.availability.state);
  chk('the reason distinguishes "checked and nothing filed"',
    /no report found is not the same as healthy/.test(r.availability.why), r.availability.why);
  chk('an unchecked source says it was never read',
    /no availability source was read/.test(resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })]).availability.why));

  const hurt = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })], {
    availability_checked: true,
    availability: [{ player_id: '1001', player_name: 'Sam Leavitt', status: 'DOUBTFUL',
      source: 'official report', source_url: 'https://example.invalid/report', retrieved_at: '2026-09-15T08:00:00Z' }]
  });
  chk('an explicit report is carried as explicit evidence', hurt.availability.evidence === 'EXPLICIT' && hurt.availability.state === 'DOUBTFUL');
  chk('the starter stays resolved while the doubt travels with him', hurt.player_id === '1001' && hurt.status === 'PREVIOUS_GAME');
  chk('the label carries the doubt', /doubtful/.test(hurt.label), hurt.label);

  const exit = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })], {
    availability_checked: true,
    participation: { player_id: '1001', share: 0.18, week: 2, replaced_by: 'Landen Clark', source: 'fixture', source_url: 'https://example.invalid' }
  });
  chk('an unfinished game is reported as participation, not as an injury',
    exit.availability.participation && /not an injury report/.test(exit.availability.participation.note), exit.availability.participation);
  chk('participation never changes the availability state', exit.availability.state === 'UNKNOWN');
}

/* ---- 8. usage: who started, from play attribution ------------------------- */
{
  const rows = [];
  /* Leavitt opens and throws 30; Clark mops up with 5 */
  for (let i = 0; i < 30; i++) rows.push({ team: 'LSU', team_key: 'lsu', game_id: 'g1', season: 2026, week: 2, player_id: '1001', player_name: 'Sam Leavitt', order: i * 2 });
  for (let i = 0; i < 5; i++) rows.push({ team: 'LSU', team_key: 'lsu', game_id: 'g1', season: 2026, week: 2, player_id: '1002', player_name: 'Landen Clark', order: 200 + i });
  const u = S.usageFromPlays(rows);
  chk('one team-game is produced from the play rows', u.length === 1 && u[0].dropbacks === 35, u.length);
  const st = S.starterOfGame(u[0]);
  chk('the opener is the starter', st.starter.player_id === '1001' && st.settled === true, st);
  chk('the reason names the opening dropback', /first dropback/.test(st.why), st.why);

  /* now the opener leaves after three snaps: NOT a settled start */
  const rows2 = [];
  for (let i = 0; i < 3; i++) rows2.push({ team: 'MIN', team_key: 'min', game_id: 'g2', season: 2026, week: 1, player_id: '2001', player_name: 'K.Murray', order: i });
  for (let i = 0; i < 30; i++) rows2.push({ team: 'MIN', team_key: 'min', game_id: 'g2', season: 2026, week: 1, player_id: '2002', player_name: 'C.Wentz', order: 100 + i });
  const st2 = S.starterOfGame(S.usageFromPlays(rows2)[0]);
  chk('an opener who takes 9% of the dropbacks is not called the starter', st2.settled === false && st2.starter === null, st2);
  chk('both the opener and the usage leader are named', st2.opened.player_id === '2001' && st2.leader.player_id === '2002');

  const comp = S.usageCompetition(S.usageFromPlays(rows2));
  chk('a 9/91 split is not a contested ROOM — the competition comes from the unsettled start',
    comp.contested === false, comp);
  const comp2 = S.usageCompetition(S.usageFromPlays(rows));
  chk('an 86/14 split is not a contested room', comp2.contested === false, comp2);
  const rows3 = [];
  for (let i = 0; i < 18; i++) rows3.push({ team: 'X', team_key: 'x', game_id: 'g3', season: 2026, week: 2, player_id: '3001', player_name: 'A', order: i });
  for (let i = 0; i < 14; i++) rows3.push({ team: 'X', team_key: 'x', game_id: 'g3', season: 2026, week: 2, player_id: '3002', player_name: 'B', order: 100 + i });
  chk('a 56/44 split IS a contested room', S.usageCompetition(S.usageFromPlays(rows3)).contested === true);
}

/* ---- 9. research-only inputs are excluded from pricing -------------------- */
{
  const r = resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })]);
  const q = S.engineQbInput(r, { approved_statuses: ['ANNOUNCED'], attempts: 300, season_epa_per_db: 0.12 });
  chk('a previous-game starter is NOT priced when only announcements are approved', q.priced === false, q.why);
  chk('the refusal names the whitelist', /not on the pricing whitelist/.test(q.why), q.why);
  chk('the shadow input still exists for validation', !!q.shadow && q.shadow.player_id === '1001');
  chk('the shadow input carries the status so nothing downstream can mistake it',
    q.shadow.starter_status === 'PREVIOUS_GAME' && q.shadow.starter_confirmed === false);

  const q2 = S.engineQbInput(r, { approved_statuses: ['ANNOUNCED', 'PREVIOUS_GAME'], attempts: 300, season_epa_per_db: 0.12 });
  chk('the same record prices once its status is approved', q2.priced === true && q2.input.attempts === 300);

  const q3 = S.engineQbInput(r, { approved_statuses: ['PREVIOUS_GAME'] });
  chk('an approved status with no efficiency history still does not price', q3.priced === false, q3.why);
  chk('the empty-history refusal says so', /nothing for the/.test(q3.why), q3.why);

  const q4 = S.engineQbInput(resolve([]), { approved_statuses: ['PREVIOUS_GAME'] });
  chk('an unresolved starter never prices', q4.priced === false && q4.input === null);
}

/* ---- 10. "not applicable" is not "missing" -------------------------------- */
{
  const states = S.FIELD_STATES;
  chk('the seven field states are distinguished', states.length === 7
    && states.indexOf('NOT_APPLICABLE') >= 0 && states.indexOf('FETCH_FAILED') >= 0
    && states.indexOf('RESEARCH_ONLY') >= 0 && states.indexOf('STALE') >= 0
    && states.indexOf('CONFLICTING') >= 0 && states.indexOf('UNAVAILABLE') >= 0, states);
  const cov = S.coverage([resolve([ev({ kind: 'GAME_USAGE', player_id: '1001' })]), resolve([])]);
  chk('coverage counts resolved and unresolved separately', cov.total === 2 && cov.with_player === 1 && cov.resolved_share === 0.5, cov);
  chk('coverage never reports an inferred starter as announced', cov.announced === 0);
}

/* ---- 11. the join the old pipeline lost ----------------------------------- */
/* Data present upstream must survive into the record. This drives the REAL
   college builder over a fixture feed, through the real recovery layer. */
{
  const header = 'game_id,season,week,team,opponent,play_id,completion_player_id,completion_player,'
    + 'incompletion_player_id,incompletion_player,sack_taken_player_id,sack_taken_player,'
    + 'interception_thrown_player_id,interception_thrown_player\n';
  let body = '';
  for (let i = 0; i < 30; i++) body += `g1,2026,2,LSU,Florida,${100 + i},1001,Sam Leavitt,NA,NA,NA,NA,NA,NA\n`;
  for (let i = 0; i < 4; i++) body += `g1,2026,2,LSU,Florida,${300 + i},NA,NA,1002,Landen Clark,NA,NA,NA,NA\n`;
  const rosterCsv = 'athlete_id,first_name,last_name,team,weight,height,jersey,year,position,season\n'
    + '1001,Sam,Leavitt,LSU,200,74,10,3,QB,2026\n1002,Landen,Clark,LSU,205,75,12,2,QB,2026\n';
  const schedCsv = 'game_id,start_date,completed,home_team,away_team\ng1,2026-09-12T23:30:00.000Z,true,LSU,Florida\n';

  const served = {};
  const fakeFetch = async (url) => {
    let text = null;
    if (/player_stats_2026/.test(url)) text = header + body;
    else if (/cfb_rosters_2026/.test(url)) text = rosterCsv;
    else if (/cfb_schedules_2026/.test(url)) text = schedCsv;
    served[url] = (served[url] || 0) + 1;
    if (text == null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => text };
  };

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'edstart-'));
  const prev = process.env.EDP_CACHE;
  process.env.EDP_CACHE = tmp;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'data', 'recovery.js'))];
  delete require.cache[require.resolve(path.join(__dirname, 'build_starters.js'))];
  const R2 = require(path.join(__dirname, '..', 'data', 'recovery.js'));
  const B2 = require(path.join(__dirname, 'build_starters.js'));

  const sess = R2.session({ fetch: fakeFetch });

  B2.buildCfb(sess, 2026, { offline: false }).then(out => {
    chk('the college builder runs end to end over a fixture feed', out.ok === true, out.why);
    const lsu = out.ok && out.records.filter(r => r.team_id === 'lsu')[0];
    chk('the team that appears in the play feed appears in the record', !!lsu, out.ok && out.records.map(r => r.team_id));
    chk('the quarterback present upstream survives the join',
      lsu && lsu.player_id === '1001' && lsu.player_name === 'Sam Leavitt', lsu && { id: lsu.player_id, n: lsu.player_name });
    chk('the record is PREVIOUS_GAME, not UNKNOWN and not confirmed',
      lsu && lsu.status === 'PREVIOUS_GAME' && lsu.confirmed === false, lsu && lsu.status);
    chk('the record carries the source URL, the publication time and the retrieval time',
      lsu && /player_stats_2026\.csv$/.test(lsu.source_url) && lsu.published_at && lsu.retrieved_at,
      lsu && { u: lsu.source_url, p: lsu.published_at, r: lsu.retrieved_at });
    chk('the record carries player id, team and season',
      lsu && lsu.player_id && lsu.team === 'LSU' && lsu.season === 2026);
    chk('coverage reports a resolved starter for this slate', out.ok && out.coverage.with_player === 1, out.ok && out.coverage);

    /* ---- 12. provider failure and fallback ----------------------------- */
    const flaky = (() => {
      let n = 0;
      return async (url) => {
        if (/player_stats_2026/.test(url)) {
          n++;
          if (n <= 2) throw new Error('socket hang up');
          return { ok: true, status: 200, text: async () => header + body };
        }
        return fakeFetch(url);
      };
    })();
    const s2 = R2.session({ fetch: flaky, backoff_ms: 1, host_min_gap_ms: 0 });
    s2.get('https://raw.githubusercontent.com/x/player_stats_2026.csv', { retries: 2 }).then(r => {
      chk('a transient failure is retried with backoff and then succeeds', r.ok === true && r.attempts === 3, { ok: r.ok, a: r.attempts });

      const hard = async () => ({ ok: false, status: 403, text: async () => '' });
      const s3 = R2.session({ fetch: hard, backoff_ms: 1, host_min_gap_ms: 0, host_failure_breaker: 2 });
      Promise.all([
        s3.get('https://blocked.invalid/a'), s3.get('https://blocked.invalid/b')
      ]).then(() => s3.get('https://blocked.invalid/c')).then(third => {
        chk('a 403 is an answer and is never retried', third.from === 'breaker' || third.attempts <= 1, third);
        chk('a host refusing repeatedly is cut once, not counted 138 times',
          third.from === 'breaker' && /circuit open/.test(third.error || ''), third);
        const rep = s3.report();
        chk('the report groups a systematic refusal as systematic',
          rep.failure_groups.length && rep.failure_groups[0].systematic === true, rep.failure_groups);

        /* ---- 13. an ordered fallback names which provider answered ----- */
        let calls = 0;
        const two = async (url) => {
          calls++;
          if (/primary/.test(url)) return { ok: false, status: 404, text: async () => '' };
          return { ok: true, status: 200, text: async () => 'fallback body' };
        };
        const s4 = R2.session({ fetch: two, backoff_ms: 1, host_min_gap_ms: 0 });
        s4.firstOf([
          { name: 'primary', url: 'https://a.invalid/primary' },
          { name: 'fallback', url: 'https://b.invalid/secondary' }
        ]).then(r4 => {
          chk('the fallback answers when the primary 404s', r4.ok === true && r4.provider === 'fallback', r4);
          chk('the record says it fell back and what refused first',
            r4.fell_back === true && r4.tried.length === 1 && r4.tried[0].status === 404, r4.tried);

          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
          if (prev == null) delete process.env.EDP_CACHE; else process.env.EDP_CACHE = prev;
          shipped();
        });
      });
    });
  }).catch(e => { chk('the college builder runs end to end over a fixture feed', false, String(e && e.stack || e)); shipped(); });
}

/* ---- 14. the shipped artifact is real ------------------------------------ */
function shipped() {
  const f = path.join(__dirname, 'cfb_2026.json');
  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    chk('the committed college artifact resolves most of the field',
      d.coverage.total > 100 && d.coverage.resolved_share > 0.8, d.coverage);
    chk('the committed artifact marks nothing as announced that was inferred',
      d.coverage.by_status.ANNOUNCED === d.coverage.announced, d.coverage);
    const some = Object.keys(d.teams).slice(0, 25).map(k => d.teams[k]);
    chk('every record carries player id, team, season, source url and retrieval time where it resolved',
      some.every(r => r.status === 'UNKNOWN' || r.status === 'COMPETITION'
        || (r.player_id && r.team && r.season && r.source_url && r.retrieved_at)),
      some.filter(r => r.status !== 'UNKNOWN' && r.status !== 'COMPETITION' && !(r.player_id && r.source_url)).slice(0, 2));
    chk('no committed record claims a confirmed starter without an official source',
      some.every(r => !r.confirmed || r.status === 'ANNOUNCED'));
  }
  const nf = path.join(__dirname, 'nfl_2026.json');
  if (fs.existsSync(nf)) {
    const d = JSON.parse(fs.readFileSync(nf, 'utf8'));
    chk('the committed NFL artifact covers the league', d.coverage.total === 32, d.coverage.total);
    chk('the NFL artifact carries an availability axis separate from the starter axis',
      Object.keys(d.teams).every(k => d.teams[k].availability && d.teams[k].availability.state));
  }
  done();
}

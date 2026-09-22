#!/usr/bin/env node
/* ===========================================================================
   Tests for the football research layer: the input assembly, the team-game
   profiles, the shared snapshot contract and the matchup packet.

   THE REGRESSIONS UNDER TEST — one group each, named for the failure it
   would otherwise reproduce:

     1  data present upstream is lost in a join (the hard-coded nulls that
        made football/fbs/slate.json publish data_completeness 0.0 on every
        game while the board priced the same games with four inputs present)
     2  "not applicable" counted as "missing" (a dome has no weather to be
        missing; a neutral site has no travel asymmetry)
     3  research-only inputs reaching the priced number
     4  a stale quote presented as the market, and a fresh model implying a
        fresh price
     5  movement claimed from two quotes that are not comparable
     6  an archived edition price presented as current
     7  a defence's sacks credited to the offence
     8  a collapsed attribution column scored as a zero
     9  home/away spread signs
    10  a place difference across two different position-group boards
    11  a large model-market gap ordering research on its own
    12  the rankings and the game projection presented as if they were one
        model on one scale

   Run: node football/matchup/research.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');

global.window = global.window || global;
require(path.join(__dirname, '..', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(__dirname, '..', 'cfb_p4', 'engine.js'));
const IN = require(path.join(__dirname, 'inputs.js'));
const PROF = require(path.join(__dirname, 'profiles.js'));
const PK = require(path.join(__dirname, 'packet.js'));
const SNAP = require(path.join(__dirname, '..', '..', 'tools', 'lib', 'snapshot_contract.js'));
const FBS = require(path.join(__dirname, '..', 'fbs', 'fbs.js'));
const OVERLAY = require(path.join(__dirname, '..', 'availability', 'overlay.js'));

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

const NOW = Date.parse('2026-09-15T18:00:00Z');

/* ===================================================== 1 + 2. the contract */
{
  const ctx = IN.load({ season: 2026, params: P, normKey: FBS.normKey });
  chk('the assembly loads roster bundles from the committed sync',
    ctx.rosters && Object.keys(ctx.rosters).length > 100, Object.keys(ctx.rosters || {}).length);
  chk('the assembly loads the starter context', !!(ctx.starters && ctx.starters.teams), ctx.problems);
  chk('the assembly loads the availability layer', !!ctx.availability_by_team);
  chk('the venue supplement refuses an entry with no coordinates and no source',
    ctx.venue_supplement && Array.isArray(ctx.venue_supplement.refused));

  const state = E.newState();
  const g = {
    game_id: 'T1', season: 2026, week: 3, start_date: '2026-09-19T23:30:00.000Z',
    home_team: 'Ole Miss', away_team: 'LSU', neutral_site: false, venue_id: 1,
    home_conference: 'SEC', away_conference: 'SEC'
  };
  const meta = { home: { key: 'olemiss', is_fbs: true }, away: { key: 'lsu', is_fbs: true } };
  const asm = IN.buildRequest(ctx, { game: g, meta, state, now: NOW });

  /* THE JOIN THE OLD BUILDER LOST */
  chk('the roster reaches the engine request', !!asm.baseline.teams.home.roster && !!asm.baseline.teams.away.roster);
  /* THE AVAILABILITY JOIN, AND THE GRADE ON IT.

     This used to assert only that an array came out, which passed while the
     assembly was handing the engine [] — "the sources were read and named
     nobody" — for every team in the registry regardless of how that read had
     gone. In the current dataset that statement would be made about all 138
     FBS programmes at once, off two sources returning 403/404 and a third
     answering empty, and it is what made football/fbs/slate.json publish a
     higher completeness than the board on screen for the same game.

     So the invariant is the one that actually matters: the join exists, and
     what comes out of it reflects the registry's own grade. A graded read
     yields a list (empty or not); an ungraded one yields null, which the
     engine prices as maximum injury uncertainty and never as health. */
  /* The graded set is read from the overlay, which is the module that grades.
     This test carried its own copy ({ STRONG, PARTIAL }); when the overlay
     began grading an ingested conference filing OFFICIAL, the copy was stale
     and the weekly build's suite failed on the four teams with the best read
     on file. The vocabulary itself is asserted just below. */
  const AV_GRADED = OVERLAY.GRADED;
  Object.keys(ctx.availability_by_team).forEach(k => {
    const t = ctx.availability_by_team[k];
    const q = OVERLAY.normGrade(t.dataQuality || t.data_quality);
    const name = t.team_name || t.team_display;
    if (!AV_GRADED[q]) {
      const got = IN.injuriesFor(ctx, name, 'CURRENT_FIXTURE');
      chk('an ungraded availability read stays unknown for ' + (name || k),
        got === null, { grade: q, got: got === null ? 'null' : ('array[' + got.length + ']') });
      return;
    }
    /* OFFICIAL is not a magic synonym for current. A filing belongs to one
       fixture, so calling without that fixture must never let an old report
       leak into the next game. Detailed matching/current-fixture behavior is
       pinned in availability_fixture.test.js. */
    if (q === 'OFFICIAL' && t.official_report && t.official_report.game_id != null) {
      const got = IN.injuriesFor(ctx, name, 'definitely-not-' + String(t.official_report.game_id));
      chk('an official availability report is fixture-scoped for ' + (name || k),
        got === null, { grade: q, report_game: t.official_report.game_id, got: got === null ? 'null' : ('array[' + got.length + ']') });
    }
  });
  chk('the overlay names every grade it can produce, and says which of them are reports',
    OVERLAY.GRADES.join(',') === 'OFFICIAL,STRONG,PARTIAL,LIMITED,NONE'
      && OVERLAY.isGraded('OFFICIAL') && OVERLAY.isGraded('STRONG') && OVERLAY.isGraded('PARTIAL')
      && !OVERLAY.isGraded('LIMITED') && !OVERLAY.isGraded('NONE') && !OVERLAY.isGraded(undefined),
    OVERLAY.GRADES);
  chk('an OFFICIAL read for this fixture reaches the engine as a real report',
    (() => {
      const fake = { availability_by_team: { someteam: { team_name: 'Someteam', dataQuality: 'OFFICIAL',
        official_report: { ok: true, game_id: 'G1', comprehensive: true },
        players: [{ player_name: 'A Player', position: 'WR', status: 'OUT', depth_role: 'WR2', game_id: 'G1' }] } },
        availability_as_of: null };
      const r = IN.injuriesFor(fake, 'Someteam', 'G1');
      return Array.isArray(r) && r.length === 1 && r[0].status === 'out';
    })());
  chk('a comprehensive OFFICIAL report for this fixture may report no absences',
    (() => {
      const fake = { availability_by_team: { someteam: { team_name: 'Someteam', dataQuality: 'OFFICIAL',
        official_report: { ok: true, game_id: 'G1', comprehensive: true, report_of_no_absences: true },
        players: [] } }, availability_as_of: null };
      const r = IN.injuriesFor(fake, 'Someteam', 'G1');
      return Array.isArray(r) && r.length === 0;
    })());
  chk('an ungraded availability read never reaches the engine as a clean report',
    (() => {
      const fake = { availability_by_team: { someteam: { team_name: 'Someteam', dataQuality: 'LIMITED', players: [] } },
        availability_as_of: null };
      return IN.injuriesFor(fake, 'Someteam') === null;
    })());
  chk('a graded non-comprehensive read that names nobody stays unknown',
    (() => {
      const fake = { availability_by_team: { someteam: { team_name: 'Someteam', dataQuality: 'STRONG', players: [] } },
        availability_as_of: null };
      return IN.injuriesFor(fake, 'Someteam', 'G1') === null;
    })());
  chk('the injury join itself is intact — a graded read with a listed player carries him through',
    (() => {
      const fake = { availability_by_team: { someteam: { team_name: 'Someteam', dataQuality: 'PARTIAL',
        players: [{ player_name: 'A Player', position: 'QB', status: 'OUT', depth_role: 'QB1' }] } },
        availability_as_of: null };
      const r = IN.injuriesFor(fake, 'Someteam');
      return Array.isArray(r) && r.length === 1 && r[0].status === 'out' && r[0].starter === true;
    })());
  chk('the venue reaches the engine request', !!asm.baseline.venue.home);
  chk('the timestamps travel with the request', !!asm.baseline.timestamps.roster);

  const byField = {};
  asm.contract.forEach(c => { byField[c.field + ':' + (c.side || '-')] = c; });
  chk('the contract reports a state for every contracted field', asm.contract.length >= 14, asm.contract.length);
  chk('a retrieved roster is USABLE', byField['roster:home'].state === 'USABLE', byField['roster:home']);
  chk('the starter is RESEARCH_ONLY, not USABLE and not missing',
    byField['qb_starter:home'].state === 'RESEARCH_ONLY', byField['qb_starter:home']);
  chk('the starter row says why it is not priced',
    /out-of-sample record/.test(byField['qb_starter:home'].detail), byField['qb_starter:home'].detail);
  /* RECRUITING SPLIT INTO THE TWO STATEMENTS THAT WERE HIDING IN ONE.
     The old row said "per-player recruiting ratings are subscription data" and
     was UNAVAILABLE on every game. That sentence is still true and it was
     answering a narrower question than the field asks: the per-TEAM composite
     is public and keyless, is now ingested, and fills the field as RESEARCH
     because no coefficient has been fitted against it. */
  const rec = byField['recruiting_talent:home'];
  chk('the recruiting field is published per side, because it is a fact about a team', !!rec, Object.keys(byField));
  if (rec && rec.state === 'RESEARCH_ONLY') {
    chk('an ingested team composite is RESEARCH_ONLY, never USABLE — nothing prices it',
      rec.priced === false, rec);
    chk('and it says it is per-team only, so nobody reads it as per-player recruiting',
      /PER-TEAM only/.test(rec.detail) && /still not\s+substituted/.test(rec.detail.replace(/\s+/g, ' ')), rec.detail);
    chk('identity is resolved on an id and corroborated, not on a name alone',
      /ESPN team id/.test(rec.identity || ''), rec.identity);
  } else {
    chk('with no artifact built the field is UNAVAILABLE and says how to fill it',
      rec && rec.state === 'UNAVAILABLE' && !!rec.fix, rec);
  }

  /* NOT APPLICABLE IS NOT MISSING */
  const neutral = IN.buildRequest(ctx, { game: Object.assign({}, g, { neutral_site: true }), meta, state, now: NOW });
  const nField = {};
  neutral.contract.forEach(c => { nField[c.field + ':' + (c.side || '-')] = c; });
  chk('a neutral site makes the away venue NOT_APPLICABLE rather than missing',
    nField['venue_geography:away'].state === 'NOT_APPLICABLE', nField['venue_geography:away']);
  chk('NOT_APPLICABLE is excluded from the coverage denominator',
    neutral.summary.applicable === neutral.summary.fields - neutral.summary.by_state.NOT_APPLICABLE,
    neutral.summary);
  /* THE GUARANTEE IS NOT THAT COVERAGE RISES. Removing a field that was
     PRESENT (the away venue) from both halves of a ratio can move it either
     way, and pretending otherwise would be its own lie. What must hold is
     that a NOT_APPLICABLE field is never counted as a hole: coverage computed
     the honest way is always at least coverage computed the old way, where
     everything inapplicable was scored as missing. */
  const oldWay = neutral.summary.known / neutral.summary.fields;
  chk('a NOT_APPLICABLE field is never counted as missing',
    neutral.summary.input_coverage >= oldWay - 1e-9,
    { honest: neutral.summary.input_coverage, counting_na_as_missing: Math.round(oldWay * 1000) / 1000 });

  const fcsMeta = { home: { key: 'olemiss', is_fbs: true }, away: { key: 'norfolkstate', is_fbs: false } };
  const fcs = IN.buildRequest(ctx, { game: Object.assign({}, g, { away_team: 'Norfolk State' }), meta: fcsMeta, state, now: NOW });
  const fField = {};
  fcs.contract.forEach(c => { fField[c.field + ':' + (c.side || '-')] = c; });
  /* THIS ASSERTION CHANGED, AND THE REASON IS THE POINT.

     It used to demand NOT_APPLICABLE for an FCS opponent's roster — "not a gap
     in this game's inputs". The weighted score disagreed with that on every
     one of these games: with no roster for the FCS side the engine's
     roster_away term is unmeasured and it charges the full 6.1 points. A
     contract that excludes a field from its own denominator while the score
     charges for it publishes two numbers about one game that cannot both be
     right, and football/matchup/confidence.js surfaced exactly that
     disagreement on eighteen fixtures.

     So the contract agrees with the score. Coverage on an FBS-vs-FCS game
     falls, which is the correct direction. What must NOT change is the
     reason: this is still the rated universe, not a feed that failed. */
  chk('an FCS opponent\'s roster is a real gap, counted as one',
    fField['roster:away'].state === 'UNAVAILABLE', fField['roster:away']);
  chk('the reason names the rated universe rather than blaming a feed',
    /outside the 2026 FBS universe/.test(fField['roster:away'].detail), fField['roster:away'].detail);
  chk('and it says why it is counted rather than excused',
    /charges the full weight/.test(fField['roster:away'].detail), fField['roster:away'].detail);
  /* the two states that genuinely do not arise are still excluded */
  chk('a dome still makes weather NOT_APPLICABLE, and a neutral site the away venue',
    nField['venue_geography:away'].state === 'NOT_APPLICABLE');

  /* ============================================ 3. research never prices */
  chk('the pricing whitelist is empty, so no starter status can price today',
    IN.PRICED_STARTER_STATUSES.length === 0, IN.PRICED_STARTER_STATUSES);
  chk('neither side\'s starter is priced', asm.qb_pricing.home.priced === false && asm.qb_pricing.away.priced === false);
  chk('the refusal names the whitelist', /not on the pricing whitelist/.test(asm.qb_pricing.home.why), asm.qb_pricing.home.why);
  chk('the BASELINE request the published number is priced from carries no QB at all',
    asm.baseline.teams.home.qb === null && asm.baseline.teams.away.qb === null);
  chk('the SHADOW request carries the starter', !!asm.enriched.teams.home.qb && !!asm.enriched.teams.away.qb);
  chk('the shadow QB input is stamped with its status so nothing downstream can mistake it',
    asm.enriched.teams.home.qb.starter_confirmed === false && !!asm.enriched.teams.home.qb.starter_status,
    asm.enriched.teams.home.qb);

  const base = E.projectGame(asm.baseline);
  const shadow = E.projectGame(asm.enriched);
  chk('both requests project', base.status === 'PREDICTED' && shadow.status === 'PREDICTED', [base.status, shadow.status]);
  chk('the priced QB layer contributes nothing in the baseline',
    (base.contributions || []).filter(c => c.key === 'qb')[0].available === false);
  chk('the shadow moves the QB stability term off its unknown-starter floor',
    shadow.layers.qb.home.stability.available === true && shadow.layers.qb.home.stability.value > 0,
    shadow.layers.qb.home.stability);

  /* ================================================= 9. home/away signs */
  chk('a home favourite has a negative home LINE and a positive home MARGIN',
    base.model.fair_spread > 0, base.model.fair_spread);
  const flipped = IN.buildRequest(ctx, {
    game: Object.assign({}, g, { home_team: 'LSU', away_team: 'Ole Miss', home_conference: 'SEC', away_conference: 'SEC' }),
    meta: { home: { key: 'lsu', is_fbs: true }, away: { key: 'olemiss', is_fbs: true } }, state, now: NOW });
  const flip = E.projectGame(flipped.baseline);
  const hfa = (base.contributions || []).filter(c => c.key === 'hfa')[0].points;
  chk('swapping the sides negates the margin apart from home-field advantage',
    Math.abs((base.model.fair_spread - hfa) + (flip.model.fair_spread - hfa)) < 0.5,
    { base: base.model.fair_spread, flipped: flip.model.fair_spread, hfa });
}

/* ===================================== 7 + 8. the profiles, on real plays */
{
  const rows = [];
  const mk = (o) => Object.assign({
    game_id: 'g1', season: '2026', week: '1', team: 'A', opponent: 'B', conference: 'X',
    team_score: '0', opponent_score: '0', drive_id: 'd1', play_id: '1000', period: '1',
    yards_to_goal: '70', down: '1', distance: '10',
    reception_player_id: 'NA', reception_yds: 'NA', completion_player_id: 'NA', rush_player_id: 'NA', rush_yds: 'NA',
    incompletion_player_id: 'NA', sack_taken_player_id: 'NA', sack_player_id: 'NA',
    interception_player_id: 'NA', interception_thrown_player_id: 'NA',
    touchdown_player_id: 'NA', fumble_player_id: 'NA', fumble_forced_player_id: 'NA', pass_breakup_player_id: 'NA'
  }, o);
  /* A's offence gets sacked twice; the sacker is B's player, on A's row */
  rows.push(mk({ play_id: '1001', sack_taken_player_id: 'qb1', sack_player_id: 'dl1' }));
  rows.push(mk({ play_id: '1002', sack_taken_player_id: 'qb1', sack_player_id: 'dl2' }));
  for (let i = 0; i < 30; i++) rows.push(mk({ play_id: String(1010 + i), completion_player_id: 'qb1', reception_player_id: 'wr1', reception_yds: '9' }));
  for (let i = 0; i < 30; i++) rows.push(mk({ team: 'B', opponent: 'A', play_id: String(2000 + i), rush_player_id: 'rb1', rush_yds: '4' }));
  const built = PROF.build(rows);
  chk('a sack on the offence\'s row is credited to the defending team',
    built.b && built.b.all_plays.raw_counts.sacks_made === 2, built.b && built.b.all_plays.raw_counts);
  chk('the offence is credited with the sacks it ALLOWED, not with making them',
    built.a.all_plays.raw_counts.sacks_taken === 2 && built.a.all_plays.raw_counts.sacks_made === 0,
    built.a.all_plays.raw_counts);

  /* a collapsed column must not become a zero */
  const gates = built.__gates;
  chk('a column the feed never fills is gated MISSING, not scored',
    gates.pass_breakups.state === 'MISSING', gates.pass_breakups);
  chk('a gated column comes back null rather than 0',
    built.a.all_plays.pass_breakups === null, built.a.all_plays.pass_breakups);
  chk('the raw count is still visible beside the gated view',
    built.a.all_plays.raw_counts.pass_breakups === 0);
  chk('the gate says what it compared against', /per team-game against roughly/.test(gates.pass_breakups.why), gates.pass_breakups.why);

  /* running score: the last play of the game, not the last row of the file */
  const late = rows.concat([
    mk({ play_id: '9999', period: '4', team_score: '41', opponent_score: '38', rush_player_id: 'rb2', rush_yds: '2' }),
    mk({ play_id: '5000', period: '2', team_score: '14', opponent_score: '7', rush_player_id: 'rb2', rush_yds: '2' })
  ]);
  const b2 = PROF.build(late);
  chk('the final score is read at the highest play id, not the last row seen',
    b2.a.scoring.points_for_per_game === 41, b2.a.scoring);

  /* garbage time is removed from the second view and the rule is published */
  const gt = rows.concat([
    mk({ play_id: '8000', period: '4', team_score: '48', opponent_score: '10', rush_player_id: 'rb3', rush_yds: '30' })
  ]);
  const b3 = PROF.build(gt);
  chk('a garbage-time play is counted in the all-plays view', b3.a.all_plays.plays > b3.a.excluding_garbage_time.plays,
    { all: b3.a.all_plays.plays, clean: b3.a.excluding_garbage_time.plays });
  chk('the garbage-time rule is stated rather than implied', /clock-and-score rule/.test(PROF.GARBAGE_BASIS));
  chk('the artifact declares that no EPA is computable from this feed',
    PROF.LIMITS.some(l => /EPA/.test(l)), PROF.LIMITS);
  chk('the league gate and the standing limits are not repeated on every team',
    b3.a.column_gates === undefined && b3.a.limits === undefined,
    { gates: b3.a.column_gates !== undefined, limits: b3.a.limits !== undefined });
}

/* ============================= 4 + 5 + 6. the shared snapshot contract */
{
  const q = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 2.5,
    book: 'DraftKings', best_dec: 1.91, captured_at: '2026-09-13T10:00:00Z', kickoff: '2026-09-19T23:30:00Z' },
  { now: NOW, snapshot_kind: 'EDITION', model_version: 'v1', model_generated_at: '2026-09-15T17:00:00Z' });
  chk('a captured decimal price becomes an American one', q.odds_american === -110, q.odds_american);
  chk('the market type is normalised', q.market_type === 'spreads');
  chk('a two-day-old capture is STALE', q.freshness === 'STALE', q.freshness);
  chk('the freshness sentence says how old it is', /captured 2\.\d days ago/.test(q.freshness_why), q.freshness_why);
  chk('a fresh model does not make a stale price fresh — both stamps travel',
    q.model_generated_at === '2026-09-15T17:00:00.000Z' && q.captured_at === '2026-09-13T10:00:00.000Z');
  chk('the one-line label carries book, price and age', /DraftKings/.test(q.label) && /-110/.test(q.label) && /days ago/.test(q.label), q.label);

  const fresh = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 2.5,
    book: 'DraftKings', best_dec: 1.91, captured_at: new Date(NOW - 5 * 60000).toISOString() }, { now: NOW });
  chk('a five-minute-old capture is LIVE', fresh.freshness === 'LIVE', fresh.freshness);

  const archived = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 3,
    book: 'DraftKings', captured_at: '2026-09-10T10:00:00Z' }, { now: NOW, snapshot_kind: 'ARCHIVE' });
  chk('an archived edition price is ARCHIVED, never STALE or LIVE', archived.freshness === 'ARCHIVED', archived.freshness);
  chk('the archived sentence says it is a record, not an offer',
    /not a price anybody is offering now/.test(archived.freshness_why), archived.freshness_why);

  const noPrice = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'X', side: 'home', point: 3,
    book: 'B', captured_at: '2026-09-15T17:30:00Z' }, { now: NOW });
  chk('a handicap with no price says so in `missing`',
    noPrice.missing.some(m => /odds/.test(m)), noPrice.missing);

  /* movement needs two comparable quotes */
  const a1 = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 2.5, book: 'DraftKings', captured_at: '2026-09-13T10:00:00Z' }, { now: NOW });
  const a2 = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 1.5, book: 'DraftKings', captured_at: '2026-09-15T10:00:00Z' }, { now: NOW });
  const mv = SNAP.movement(a1, a2);
  chk('two captures of one book\'s number give a movement', mv.comparable === true && mv.points === -1, mv);
  chk('the movement names what makes it comparable', /captured twice/.test(mv.why), mv.why);

  const other = SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'Ole Miss', side: 'home', point: 1.5, book: 'FanDuel', captured_at: '2026-09-15T10:00:00Z' }, { now: NOW });
  const bad = SNAP.movement(a1, other);
  chk('two different books are never a line move', bad.comparable === false, bad);
  chk('the refusal names the books', /different books/.test(bad.why), bad.why);
  const sides = SNAP.movement(a1, SNAP.quote({ game_id: 'g', market: 'spreads', selection: 'LSU', side: 'away', point: -2.5, book: 'DraftKings', captured_at: '2026-09-15T10:00:00Z' }, { now: NOW }));
  chk('two sides of the same handicap are never a line move', sides.comparable === false && /different sides/.test(sides.why), sides.why);

  const rec = SNAP.reconcile([a1, other], { now: NOW });
  chk('two current quotes that disagree are CONFLICTING, not a move', rec.state === 'CONFLICTING', rec.state);
  chk('the reconciliation says it is a disagreement between sources',
    /disagreement between sources, not as a line move/.test(rec.why), rec.why);
  const archOnly = SNAP.reconcile([archived], { now: NOW });
  chk('a game with only archived prices has no current quote to show', archOnly.state === 'ARCHIVE_ONLY', archOnly.state);

  const cov = SNAP.coverage([q, fresh, archived], { model_generated_at: '2026-09-15T17:00:00Z' });
  chk('the slate summary counts each freshness state separately',
    cov.by_freshness.LIVE === 1 && cov.by_freshness.STALE === 1 && cov.by_freshness.ARCHIVED === 1, cov.by_freshness);
  chk('the summary states that a model stamp says nothing about a price\'s age',
    /A model timestamp says nothing about a price/.test(cov.statement), cov.statement);
}

/* ================================== 10 + 11 + 12. the packet's judgements */
{
  const ctx = PK.loadContext({ season: 2026, params: P });
  chk('the packet finds the committed card', !!(ctx.slate && ctx.slate.games && ctx.slate.games.length), ctx.slate && ctx.slate.games && ctx.slate.games.length);
  chk('the packet finds the profiles artifact', !!(ctx.profiles && ctx.profiles.teams));

  const row = ctx.slate.games.filter(g => g.home_team_id && g.away_team_id && g.model_status === 'PREDICTED')[0];
  const packet = PK.build({ context: ctx, row, projection: null, now: NOW });
  chk('a packet builds for a real game on the card', packet.ok === true, packet.why);

  /* ---- 10. no place difference across two boards ---- */
  const st = packet.football.unit_standing.home_qb_room_vs_away_secondary
    || packet.football.unit_standing.home_pass_offence_vs_away_secondary;
  if (st) {
    chk('a cross-board unit pairing publishes no place difference', st.place_difference === null, st);
    chk('it says why the subtraction is refused', /no unit and no meaning/.test(st.place_difference_why), st.place_difference_why);
    chk('it gives each unit\'s percentile inside its OWN board',
      st.offense.percentile != null && st.defense.percentile != null, st);
    chk('the read states that these are two different boards', /two different boards/.test(st.read), st.read);
  }

  /* ---- 11. a gap alone orders no research ---- */
  const bare = PK.disagreement({ model_home_line: -8.5, market_home_line: 2.5 });
  chk('an 11-point gap with no supporting evidence orders no research', bare.priority === 0, bare);
  chk('the rule is stated on the object', /size of the gap contributes nothing/.test(bare.rule), bare.rule);
  chk('the gap is still reported', bare.gap_points === -11 && bare.band === 'LARGE', bare);

  const evidenced = PK.disagreement({ model_home_line: -8.5, market_home_line: 2.5,
    input_coverage: 0.7, market_freshness: 'LIVE',
    starters: [{ side: 'home', rec: { player_id: '1', status: 'PREVIOUS_GAME', availability: { evidence: 'EXPLICIT' } } },
      { side: 'away', rec: { player_id: '2', status: 'PREVIOUS_GAME', availability: { evidence: 'EXPLICIT' } } }] });
  chk('the same gap with evidence around it does order research', evidenced.priority > 0, evidenced.priority);
  chk('the priority basis itemises the EVIDENCE, never the size',
    !/gap of|points apart/.test(evidenced.priority_basis) && /input contract/.test(evidenced.priority_basis),
    evidenced.priority_basis);

  const huge = PK.disagreement({ model_home_line: -20, market_home_line: 2.5,
    input_coverage: 0.9, market_freshness: 'LIVE',
    starters: [{ side: 'home', rec: { player_id: '1', status: 'ANNOUNCED', availability: { evidence: 'EXPLICIT' } } },
      { side: 'away', rec: { player_id: '2', status: 'ANNOUNCED', availability: { evidence: 'EXPLICIT' } } }] });
  chk('a gap past anything the model has been right by reads as a fault, not an opportunity',
    huge.questions.verdict === 'MODEL_OR_DATA_FAULT', huge.questions.verdict);
  chk('and its priority is capped rather than maximised', huge.priority <= 25, huge.priority);

  const stale = PK.disagreement({ model_home_line: -8.5, market_home_line: 2.5,
    input_coverage: 0.7, market_freshness: 'STALE', starters: [] });
  chk('a stale price is recorded as evidence AGAINST the gap',
    stale.questions.contradicting_evidence.some(e => /no longer exists/.test(e.claim)),
    stale.questions.contradicting_evidence);

  const thin = PK.disagreement({ model_home_line: -8.5, market_home_line: 2.5,
    input_coverage: 0.3, market_freshness: 'LIVE', starters: [] });
  chk('a half-empty input contract is recorded as evidence against the gap',
    thin.questions.contradicting_evidence.some(e => /absence of information/.test(e.claim)),
    thin.questions.contradicting_evidence);

  chk('all six questions are always present',
    ['what_drives_the_model', 'supporting_evidence', 'contradicting_evidence', 'how_each_side_wins',
      'missing_facts_that_would_change_it', 'verdict'].every(k => k in bare.questions), Object.keys(bare.questions));

  /* ---- 12. two models, two scales, said so ---- */
  const lsu = ctx.slate.games.filter(g => g.game_id === '401856688')[0]
    || ctx.slate.games.filter(g => g.model_status === 'PREDICTED' && ctx.rankings.teams[g.home_team_id] && ctx.rankings.teams[g.away_team_id])[0];
  if (lsu) {
    const p2 = PK.build({ context: ctx, row: lsu, projection: null, now: NOW });
    const rr = p2.ratings;
    chk('the packet reconciles the published ranking with the game projection', rr.available === true, rr.why);
    chk('it names both models', !!rr.published_ranking.model && rr.published_ranking.scale && rr.game_model.scale);
    chk('it states the rank pool the ranking actually ranked, not the number of teams it rated',
      rr.published_ranking.home.ranked_of != null && rr.published_ranking.rank_note
      && /not of/.test(rr.published_ranking.rank_note), rr.published_ranking.rank_note);
    chk('it refuses to force the two into agreement',
      /NOT reconciled to each other/.test(rr.read), rr.read);
    chk('it points at the projection\'s own preseason seed as the source of the difference',
      /preseason view/.test(rr.read) || /stated rather than smoothed/.test(rr.read), rr.read);
  }

  /* the arithmetic must reconcile or say it does not */
  const withProj = ctx.slate.games.filter(g => g.model_status === 'PREDICTED')[0];
  const state = E.newState();
  const ictx = IN.load({ season: 2026, params: P, normKey: FBS.normKey });
  const asm = IN.buildRequest(ictx, {
    game: { game_id: withProj.game_id, season: withProj.season, week: withProj.week,
      start_date: withProj.kickoff, home_team: withProj.home_team, away_team: withProj.away_team,
      neutral_site: withProj.neutral_site, home_conference: withProj.home_conference,
      away_conference: withProj.away_conference },
    meta: { home: { key: withProj.home_team_id, is_fbs: true }, away: { key: withProj.away_team_id, is_fbs: true } },
    state, now: NOW });
  const proj = E.projectGame(asm.baseline);
  const ar = PK.arithmetic(withProj, proj);
  chk('the arithmetic decomposes base rating through every adjustment', ar.available && ar.steps.length >= 5, ar.steps && ar.steps.length);
  chk('every step carries a running total', ar.steps.every(s => s.running_total != null));
  chk('the adjustments sum to the published number', ar.reconciles === true, { sum: ar.sum_of_steps, published: ar.published_home_margin });
  chk('an adjustment that did not apply says why', ar.steps.filter(s => !s.applied).every(s => !!s.why_absent),
    ar.steps.filter(s => !s.applied).slice(0, 2));
  chk('the sign convention is stated on the object', /HOME MARGIN/.test(ar.convention), ar.convention);
}

/* ============================================= the shipped card, verified */
{
  const slate = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fbs', 'slate.json'), 'utf8'));
  const withContract = slate.games.filter(g => g.input_contract_summary);
  chk('every game on the committed card carries an input contract',
    withContract.length === slate.games.length, { with: withContract.length, total: slate.games.length });
  chk('no game on the committed card reports zero input coverage',
    slate.games.every(g => g.input_coverage == null || g.input_coverage > 0),
    slate.games.filter(g => g.input_coverage === 0).slice(0, 3).map(g => g.game_id));
  const fbsfbs = slate.games.filter(g => g.home_division === 'fbs' && g.away_division === 'fbs');
  const resolved = fbsfbs.filter(g => g.home_starter && g.home_starter.player_id && g.away_starter && g.away_starter.player_id);
  chk('most FBS-vs-FBS games on the card carry a resolved starter on both sides',
    resolved.length >= fbsfbs.length * 0.8, { resolved: resolved.length, of: fbsfbs.length });
  chk('no card marks an inferred starter as confirmed',
    slate.games.every(g => !g.home_starter || !g.home_starter.confirmed || g.home_starter.status === 'ANNOUNCED'));
  /* `Math.round(null * 10) / 10` is 0, and that is how eighteen FBS-vs-FCS
     games published a projected total of 0.0 while the engine was declaring
     the total unavailable for them. A declared absence must never round into
     a number. */
  chk('a total the engine declared unavailable is null on the card, never 0',
    slate.games.every(g => g.model_fair_total !== 0),
    slate.games.filter(g => g.model_fair_total === 0).slice(0, 3).map(g => g.away_team + '@' + g.home_team));
  chk('and the games that carry no total are the ones with an unrated opponent',
    slate.games.filter(g => g.model_status === 'PREDICTED' && g.model_fair_total == null)
      .every(g => g.matchup_type === 'fbs_fcs'),
    slate.games.filter(g => g.model_status === 'PREDICTED' && g.model_fair_total == null
      && g.matchup_type !== 'fbs_fcs').slice(0, 3).map(g => g.away_team + '@' + g.home_team));
  chk('a game with no total still carries its spread',
    slate.games.filter(g => g.model_status === 'PREDICTED' && g.model_fair_total == null)
      .every(g => typeof g.model_home_line === 'number'));
  chk('no shadow total rounds a null into a zero either',
    slate.games.every(g => g.shadow_fair_total !== 0));

  chk('every shadow row is labelled research-only',
    slate.games.every(g => !g.shadow_home_line || /RESEARCH ONLY/.test(g.shadow_status || '')));
  chk('the shadow never silently equals the model without saying why',
    slate.games.filter(g => g.shadow_delta_vs_model === 0).every(g => g.shadow_effect && g.shadow_effect.why),
    slate.games.filter(g => g.shadow_delta_vs_model === 0 && !(g.shadow_effect && g.shadow_effect.why)).length);
}

done();

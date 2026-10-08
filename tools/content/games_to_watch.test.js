#!/usr/bin/env node
/* ===========================================================================
   FIVE GAMES TO WATCH — the regression on the October 10, 2026 games
   docs/content-engine/GAMES_TO_WATCH.md

   The five games of the owner's brief, from a FROZEN HISTORICAL FIXTURE
   (tools/content/fixtures/games_to_watch_2026_w6.json.gz, written by
   freeze_games_to_watch.js from the artifacts committed on October 8):

     Ole Miss at Vanderbilt     ESPN  3:30 p.m. ET
     Texas A&M at Missouri      ABC   noon ET
     Texas vs. Oklahoma         ABC   3:30 p.m. ET
     UCLA at Oregon             CBS   3:30 p.m. ET
     Georgia at Alabama         ABC   7:30 p.m. ET

   The broadcast listings are a fixture (the networks named in the brief, .test
   URLs); an article built from the fixture can never be published.

     P  PACKETS    real football evidence for all five, two or more independent
                   facts each, the six questions answered; the named cases:
                   Vanderbilt's quarterback split, Missouri's run defense against
                   Texas A&M, Oklahoma's pass defense and interceptions, UCLA's
                   run game and Oregon's quarterback availability, Alabama's
                   quarterback and a verified weather-related schedule move
     Q  DATA       the sack columns are quarantined (the feed credits sacks to
                   the wrong side); finals are verified; no running score is a final
     B  BROADCAST  ESPN-operated networks confirmed, CBS held until the owner
                   verifies it, a stale verification held, a changed listing
                   held, a postponement withdrawn, ET and CT by their own DST
     S  SELECTION  never by the largest gap; a stale market cannot select a game;
                   a required game that fails the gate is held, not featured
     A  ARTICLES   both editions pass every check; they share facts, not
                   sentences; the publisher edition is held while a broadcast
                   is unverified; the fixture is rejected for publication
     X  BLOCKS     a wrong network, a placeholder kickoff, a duplicate game,
                   filler, an invented stat, an unverified injury, an upset the
                   evidence does not make, betting language, a missing link
     I  INFORMATIVE  measurably more football evidence than the old
                   projection-only preview from the same research
     C  COST       the AI request carries the packets, not the raw research; a
                   one-game rewrite is a fraction of the article
     F  FIRST PARTY  the EdgeDesk edition becomes an article-store record that
                   the publisher refuses while any gate fails or the switch is off
     D  DATABASE   (PostgreSQL) owner broadcast checks, auto-reject, the publisher
                   response, the template report, and the weekly job end to end

   Run: node tools/content/games_to_watch.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
['edgedesk_calc', 'edgedesk_schedule', 'edgedesk_availability', 'edgedesk_integrity', 'edgedesk_broadcast', 'edgedesk_matchup'].forEach((f) => require(path.join(ROOT, 'lib', f + '.js')));
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const M = require(path.join(ROOT, 'lib', 'edgedesk_matchup.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_broadcast.js'));
const BP = require(path.join(__dirname, 'build_packets.js'));
const COLLECT = require(path.join(ROOT, 'football', 'broadcasts', 'collect.js'));
const FP = require(path.join(__dirname, 'first_party.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'games_to_watch_2026_w6.json.gz'))).toString('utf8'));
const NOW = Date.parse(FX.now);
const ID = { vandy: '401856718', mizzou: '401856716', ou: '401856717', oregon: '401858484', bama: '401856712' };
const CBS_OWNER = { network: 'CBS', source_url: 'https://fixture.test/bigten-football-schedule', source_kind: 'conference', source_name: 'Big Ten Conference football schedule (fixture)', verified_at: '2026-10-08T18:00:00Z' };
const TEAMS = { cfb: FX.team_names, nfl: [] };
/* the engine's default model: the first row of its price table */
const MODEL = Object.keys(CE.cost.PRICES)[0];
const PUB = { id: null, slug: 'stadium-rant', name: 'Stadium Rant', utm_source: 'stadiumrant', editorial: Object.assign({}, CE.PUBLISHER_TEMPLATES['stadium-rant'].editorial) };

/* the content engine's view of the fixture: the five terminal games, the
   ratings, and the packets with their broadcasts re-verified now */
function artOf(doc) {
  return { cfbGames: FX.terminal, cfbBrief: { week: FX.week }, rankings: FX.rankings, nflSlate: null, nflInjuries: null, marketSnapshots: [], published: null, performance: null, packets: doc };
}
function oppOf(doc, checks, opts) {
  const snap = CE.research.fromArtifacts(artOf(doc), { now: (opts && opts.now) || NOW, broadcastChecks: checks || [] });
  const opps = CE.discover(snap, { now: (opts && opts.now) || NOW, publisher: PUB, games_to_watch: (opts && opts.gtw) || {} });
  return { snap, opp: opps.find((o) => o.kind === 'games_to_watch') || null, opps };
}
function factText(p, pred) { return p.facts.filter(pred).map((f) => f.text).join(' | '); }
function sectionOf(a, heading) { return a.sections.find((s) => /^game_/.test(s.key) && String(s.heading).indexOf(heading) >= 0); }
function fails(rep, id) { return rep.checks.some((c) => c.id === id && c.status === 'fail'); }
function mutate(a, fn) { const b = JSON.parse(JSON.stringify(a)); fn(b); return b; }

/* the live (non-fixture) build of the same inputs, CBS verified by the owner */
const DOC = BP.buildFromFixture(FX, { fixture: null, owner: { [ID.oregon]: CBS_OWNER } });
const P = {}; DOC.packets.forEach((p) => { P[p.game_id] = p; });

section('P packets: real football evidence for all five');
chk('P five packets, one per game of the brief', DOC.packets.length === 5 && Object.values(ID).every((id) => P[id]));
Object.keys(ID).forEach((k) => {
  const p = P[ID[k]];
  chk('P ' + p.identity.heading + ': the six questions are answered', p.gate.ok && Object.values(p.gate.answers).every((v) => v === true || v > 0), p.gate.missing);
  chk('P ' + p.identity.heading + ': two or more independent facts besides the projection', p.gate.independent_facts >= 2, p.gate.independent_facts);
  chk('P ' + p.identity.heading + ': the deciding matchup rests on two measured counts with samples', p.arguments.deciding && p.arguments.deciding.facts.every((id) => { const f = p.facts.find((x) => x.id === id); return f && f.independent && f.kind === 'unit' && f.numbers.length >= 2; }));
  chk('P ' + p.identity.heading + ': no fact counts a projection, a rating or a model metric as independent',
    p.facts.filter((f) => f.independent).every((f) => ['result', 'form', 'qb', 'qb_split', 'availability', 'qb_availability', 'unit', 'turnovers'].indexOf(f.kind) >= 0)
    && p.facts.filter((f) => f.kind === 'qb_efficiency' || f.kind === 'opposition').every((f) => !f.independent));
  chk('P ' + p.identity.heading + ': both teams’ official availability reports are on file', p.availability.home.official && p.availability.away.official);
});
/* Vanderbilt: the quarterback split is a measured fact, not a guess */
const vq = P[ID.vandy].quarterbacks.home;
chk('P Vanderbilt: the dropback split is measured (Jared Curtis 57%, Blaze Berlowitz 38%)', vq.split && vq.split.primary === 'Jared Curtis' && Math.round(vq.split.primary_share * 100) === 57 && vq.split.secondary === 'Blaze Berlowitz' && Math.round(vq.split.secondary_share * 100) === 38, vq.split);
chk('P Vanderbilt: both quarterbacks’ season lines are in the packet', /Jared Curtis has completed 63 of 99/.test(factText(P[ID.vandy], (f) => f.kind === 'qb')) && /Blaze Berlowitz has completed 25 of 47/.test(factText(P[ID.vandy], (f) => f.kind === 'qb')));
chk('P Vanderbilt: the SEC report does not list either quarterback, and the packet says so from the report', /Jared Curtis and Blaze Berlowitz are not on the Southeastern Conference availability report/.test(factText(P[ID.vandy], (f) => f.kind === 'qb_availability')));
chk('P Vanderbilt: the starter question is UNRESOLVED, stated as a split, not as uncertainty', P[ID.vandy].unresolved.some((u) => u.code === 'QB_STARTER_UNSETTLED') && P[ID.vandy].arguments.why_watch.some((w) => w.kind === 'QB_SPLIT'));
/* Missouri's run defense against Texas A&M */
const mrun = P[ID.mizzou].pairings.find((x) => x.key === 'run_game' && x.attacker === 'Texas A&M');
chk('P Missouri run defense vs Texas A&M: 3.4 yards a carry allowed on 130 carries, against A&M’s 4.6 on 150', mrun && mrun.def_text === '3.4 yards a carry' && mrun.def_n === 130 && mrun.off_text === '4.6 yards a carry' && mrun.off_n === 150, mrun);
chk('P Missouri run defense: one of the two things to watch', P[ID.mizzou].arguments.watch_for.some((w) => /Texas A&M’s yards per carry against Missouri’s run defense/.test(w.text)));
/* Oklahoma's pass defense and its offence's interceptions */
const opass = P[ID.ou].pairings.find((x) => x.key === 'passing' && x.defender === 'Oklahoma');
chk('P Oklahoma pass defense: 48.7% completions allowed (89 dropbacks), FBS average 61.5%', opass && opass.def_text === '48.7%' && opass.def_n === 89 && opass.league === '61.5%', opass);
chk('P Oklahoma pass defense decides the game on the evidence', P[ID.ou].arguments.deciding.pair_id === 'passing:texas' && P[ID.ou].arguments.deciding.favors === 'Oklahoma', P[ID.ou].arguments.deciding);
chk('P Oklahoma turnovers: John Mateer, four interceptions in 110 attempts (3.6%) against an FBS 2.4%', /John Mateer has thrown four interceptions in 110 attempts \(3\.6%\), against an FBS rate of 2\.4%/.test(factText(P[ID.ou], (f) => f.kind === 'turnovers')));
chk('P Oklahoma turnovers weigh against the upset case, not for it', P[ID.ou].arguments.upset.counter.some((c) => c.kind === 'DOG_TURNOVERS'));
/* UCLA's run game and Oregon's quarterbacks */
const urun = P[ID.oregon].pairings.find((x) => x.key === 'run_game' && x.attacker === 'UCLA');
chk('P UCLA rushing offense: 7.5 yards a carry (128 carries), the deciding matchup', urun && urun.off_text === '7.5 yards a carry' && urun.off_n === 128 && P[ID.oregon].arguments.deciding.pair_id === 'run_game:ucla', urun);
const oq = P[ID.oregon].quarterbacks.home;
chk('P Oregon quarterbacks: a measured split (Dylan Raiola 42%, Dante Moore 39%)', oq.split && oq.split.primary === 'Dylan Raiola' && oq.split.secondary === 'Dante Moore', oq.split);
chk('P Oregon quarterback availability: neither is on the Big Ten report', /Dylan Raiola and Dante Moore are not on the Big Ten Conference availability report/.test(factText(P[ID.oregon], (f) => f.kind === 'qb_availability')) && oq.availability.listed.length === 0);
/* Alabama's quarterback */
chk('P Alabama QB performance: Keelon Russell 93 of 132, 1,412 yards, 11 TD, 2 INT', /Alabama’s Keelon Russell has completed 93 of 132 passes \(70\.5%\) for 1,412 yards, 11 touchdowns and 2 interceptions/.test(factText(P[ID.bama], (f) => f.kind === 'qb')));
chk('P Alabama: kickoff 7:30 p.m. ET (6:30 p.m. CT), from the schedule', P[ID.bama].schedule.times.et === '7:30 PM EDT' && P[ID.bama].schedule.times.ct === '6:30 PM CDT');
chk('P Alabama: no schedule change on file, so none is claimed', P[ID.bama].schedule.schedule_change === null && !P[ID.bama].problems.some((x) => /TIME/.test(x.code)));
/* a verified weather move: the owner records it from the official source */
const WX = { network: 'ABC', kickoff: '2026-10-11T00:00:00Z', reason: 'weather: lightning in the area (fixture)', source_url: 'https://fixture.test/sec-schedule-update', source_kind: 'conference', source_name: 'SEC schedule update (fixture)', verified_at: '2026-10-08T19:30:00Z' };
const wxRec = B.verify(ID.bama, P[ID.bama].broadcast_input.listing, WX, { kickoff: P[ID.bama].broadcast_input.schedule_kickoff, kickoff_verified: true });
const bamaWx = M.applyBroadcast(P[ID.bama], wxRec, NOW);
chk('P Alabama weather move: the verified kickoff replaces the schedule’s, with its reason and source', bamaWx.schedule.kickoff === '2026-10-11T00:00:00.000Z' && bamaWx.schedule.times.et === '8:00 PM EDT' && bamaWx.schedule.times.ct === '7:00 PM CDT'
  && bamaWx.schedule.schedule_change.reason === WX.reason && bamaWx.schedule.schedule_change.source_url === WX.source_url && bamaWx.broadcast.publishable, bamaWx.schedule);
const wxConflict = B.verify(ID.bama, Object.assign({}, P[ID.bama].broadcast_input.listing, { kickoff: '2026-10-11T00:00:00.000Z' }), null, { kickoff: P[ID.bama].broadcast_input.schedule_kickoff, kickoff_verified: true });
chk('P Alabama: a listing that moves the time without a verification is a CONFLICT and holds the game', wxConflict.status === 'CONFLICT' && !B.publishable(wxConflict, NOW).ok && wxConflict.problems.some((x) => x.code === 'TIME_CONFLICT'));

section('Q data truth');
chk('Q the sack columns are quarantined: offence and defence views of the same plays disagree', DOC.league.quarantined.some((q) => q.field === 'sack_taken_rate'), DOC.league.quarantined);
chk('Q no packet argues from a sack rate', DOC.packets.every((p) => !p.pairings.some((x) => x.key === 'pass_protection') && !p.facts.some((f) => /sack on|sacked the quarterback on/.test(f.text))));
chk('Q the quarantine is stated in every packet’s limits', DOC.packets.every((p) => p.limits.some((l) => /sack rates are not used/.test(l))));
chk('Q every result in a packet is a verified final, never a running score', DOC.packets.every((p) => ['home', 'away'].every((s) => p.teams[s].results.every((r) => /record\.json|collective\/settled|settlement record/.test(r.source)))));
chk('Q a team with an unverified game states no season record (Vanderbilt: FCS opponent without a final)', P[ID.vandy].teams.home.record_complete === false && !P[ID.vandy].facts.some((f) => f.team === 'Vanderbilt' && /is \d+-\d+,/.test(f.text)) && P[ID.vandy].facts.some((f) => f.team === 'Vanderbilt' && /last three games/.test(f.text)));
chk('Q every independent fact names its source', DOC.packets.every((p) => p.facts.filter((f) => f.independent).every((f) => f.source && f.source.name)));

section('B broadcasts');
const raw = BP.buildFromFixture(FX, { fixture: null });
const RP = {}; raw.packets.forEach((p) => { RP[p.game_id] = p; });
chk('B ESPN and ABC from ESPN’s own listing are the rights holder’s: CONFIRMED', [ID.vandy, ID.mizzou, ID.ou, ID.bama].every((id) => RP[id].broadcast.status === 'CONFIRMED' && RP[id].broadcast.tier === 'OFFICIAL_NETWORK'));
chk('B CBS from ESPN’s listing is a third party’s: TENTATIVE, held', RP[ID.oregon].broadcast.status === 'TENTATIVE' && !RP[ID.oregon].broadcast.publishable && RP[ID.oregon].gate.holds.some((h) => h.code === 'BROADCAST_TENTATIVE'));
chk('B the owner’s verification from the Big Ten schedule confirms CBS, with its URL', P[ID.oregon].broadcast.status === 'CONFIRMED' && P[ID.oregon].broadcast.tier === 'OWNER_VERIFIED' && P[ID.oregon].broadcast.source.url === CBS_OWNER.source_url);
chk('B streaming is the network’s own service, described as such (Paramount+ for CBS; the ESPN app for ABC)', P[ID.oregon].broadcast.streaming.some((s) => s.service === 'Paramount+' && s.basis === 'NETWORK_SERVICE') && RP[ID.bama].broadcast.streaming.some((s) => s.service === 'the ESPN app'));
const staleAt = Date.parse('2026-10-09T08:00:00Z');
chk('B inside 72 hours of kickoff a verification older than 12 hours is STALE and held', !B.publishable(RP[ID.bama].broadcast_input.listing ? B.verify(ID.bama, RP[ID.bama].broadcast_input.listing, null, { kickoff: RP[ID.bama].schedule.kickoff, kickoff_verified: true }) : null, staleAt).ok
  && B.publishable(B.verify(ID.bama, RP[ID.bama].broadcast_input.listing, null, { kickoff: RP[ID.bama].schedule.kickoff, kickoff_verified: true }), staleAt).reason === 'STALE');
const flexed = Object.assign({}, RP[ID.oregon].broadcast_input.listing, { outlets: [{ network: 'FOX', type: 'TV', market: 'national' }], retrieved_at: '2026-10-08T19:45:00.000Z' });
const chg = B.verify(ID.oregon, flexed, CBS_OWNER, { kickoff: RP[ID.oregon].schedule.kickoff, kickoff_verified: true });
chk('B a listing that changes after the owner verified (flex) is CHANGED and held', chg.status === 'CHANGED' && !B.publishable(chg, NOW).ok);
const pp = B.verify(ID.ou, Object.assign({}, RP[ID.ou].broadcast_input.listing, { status: 'STATUS_POSTPONED' }), null, { kickoff: RP[ID.ou].schedule.kickoff, kickoff_verified: true });
chk('B a postponed game is withdrawn, not held', pp.status === 'POSTPONED' && B.publishable(pp, NOW).withdraw === true);
chk('B ET and CT each keep their own daylight time (EDT/CDT in October, EST/CST in November)', B.timesText('2026-10-10T16:00:00Z').et === '12:00 PM EDT' && B.timesText('2026-11-07T17:00:00Z').ct === '11:00 AM CST');
chk('B no network is invented: a game with no listing is UNVERIFIED and held', B.verify('1', null, null, { kickoff: '2026-10-10T16:00:00Z', kickoff_verified: true }).status === 'UNVERIFIED');
(function () {
  const prev = { listings: { [ID.oregon]: RP[ID.oregon].broadcast_input.listing } };
  const fresh = { [ID.oregon]: flexed };
  const m1 = COLLECT.merge(prev, {}, [ID.oregon], '2026-10-09T10:00:00Z');
  const m2 = COLLECT.merge(prev, fresh, [ID.oregon], '2026-10-09T10:00:00Z');
  chk('B the collector keeps the last listing, with its real time, when a fetch fails', m1.listings[ID.oregon].retrieved_at === RP[ID.oregon].broadcast_input.listing.retrieved_at && m1.changes.length === 0);
  chk('B the collector records a network change with both listings', m2.changes.length === 1 && m2.changes[0].from.outlets[0].network === 'CBS' && m2.changes[0].to.outlets[0].network === 'FOX');
})();

section('S selection');
const CBS_ROW = Object.assign({ game_id: ID.oregon }, CBS_OWNER);
const live = oppOf(DOC, [CBS_ROW], { gtw: { required: Object.values(ID) } });
chk('S the five required games are featured', live.opp && live.opp.research.matchups.length === 5 && Object.values(ID).every((id) => live.opp.research.matchups.some((m) => m.game_id === id)));
chk('S no featured game is chosen by its market gap: every market here is stale, and the market part is zero', live.opp.research.selection.games.every((g) => g.parts.market === 0));
chk('S a comparable market gap is capped context, never a selector', (function () {
  const p = JSON.parse(JSON.stringify(P[ID.bama])); p.model.gap_state = 'COMPARABLE'; p.model.gap = { points: 25 };
  const a = M.scoreGame(P[ID.bama]), b = M.scoreGame(p);
  return b.parts.market === 30 && b.score - a.score <= 1;
})());
chk('S a required game that fails the gate is held for review, not featured', (function () {
  const bad = JSON.parse(JSON.stringify(P[ID.vandy])); bad.arguments.deciding = null; bad.gate = M.gate(bad);
  const s = M.select([bad, P[ID.mizzou], P[ID.ou], P[ID.oregon], P[ID.bama]], { count: 5, required: [ID.vandy] });
  return s.report.required_failed.some((r) => r.game_id === ID.vandy) && !s.games.some((g) => g.game_id === ID.vandy);
})());
chk('S each featured game has its own storyline label', (function () { const st = live.opp.research.selection.games.map((g) => g.storyline); return st.length === 5 && st.every(Boolean); })());
chk('S the count is configurable (three games)', oppOf(DOC, [CBS_ROW], { gtw: { count: 3 } }).opp.research.matchups.length === 3);

section('A articles');
const O = live.opp;
const pubA = CE.draft(O, { publisher: PUB, format: 'weekly_games_to_watch', now: NOW });
const fpA = CE.draft(O, { format: 'weekly_games_to_watch_first_party', now: NOW });
const vPub = CE.validate(pubA, O, { publisher: PUB, now: NOW, teamLists: TEAMS });
const vFp = CE.validate(fpA, O, { now: NOW, teamLists: TEAMS, siblings: [{ id: 'pub', title: pubA.title, text: pubA.sections.map((s) => s.body).join('\n\n') }] });
chk('A the publisher edition passes every check', vPub.ok && vPub.integrity_status !== 'BLOCKED', vPub.checks.filter((c) => c.status === 'fail'));
chk('A the EdgeDesk edition passes every check', vFp.ok && vFp.integrity_status !== 'BLOCKED', vFp.checks.filter((c) => c.status === 'fail'));
chk('A the editorial review is READY for both', CE.gamesToWatch.review(pubA, O, vPub).verdict === 'READY' && CE.gamesToWatch.review(fpA, O, vFp).verdict === 'READY');
chk('A five game sections, each with the six parts', ['weekly_games_to_watch', 'weekly_games_to_watch_first_party'].every((f) => { const a = f === 'weekly_games_to_watch' ? pubA : fpA; const g = a.sections.filter((s) => /^game_/.test(s.key)); return g.length === 5 && g.every((s) => CE.gamesToWatch.PARTS.every((P0) => P0.re.test(s.body))); }));
chk('A where to watch: date, ET and CT, venue, TV, streaming, the source and the verification time', (function () {
  const s = sectionOf(pubA, 'Texas A&M at').body;
  return /Saturday, Oct\. 10, noon ET \(11 a\.m\. CT\)/.test(s) && /Memorial Stadium/.test(s) && /\*\*TV:\*\* ABC/.test(s) && /\*\*Streaming:\*\* the ESPN app/.test(s) && /Broadcast verified Thu\., Oct\. 8, 3 p\.m\. ET from ESPN’s public scoreboard listing/.test(s);
})());
chk('A the owner-verified CBS game cites the verification source by link', /Broadcast verified Thu\., Oct\. 8, 2 p\.m\. ET from \[Big Ten Conference football schedule \(fixture\)\]\(https:\/\/fixture\.test\/bigten-football-schedule\)/.test(sectionOf(pubA, 'UCLA at').body));
chk('A the five named cases reach the article', (function () {
  const t = pubA.sections.map((s) => s.body).join('\n');
  return /Jared Curtis has taken 57% of Vanderbilt’s recent dropbacks and Blaze Berlowitz 38%/.test(t)
    && /Texas A&M’s yards per carry against Missouri’s run defense: 4\.6 yards a carry this season against 3\.4 yards a carry allowed/.test(t)
    && /Oklahoma has allowed a 48\.7% completion rate \(89 dropbacks\)/.test(t) && /John Mateer has thrown four interceptions in 110 attempts/.test(t)
    && /UCLA has run for 7\.5 yards per carry this season \(128 carries/.test(t) && /Dylan Raiola and Dante Moore are not on the Big Ten Conference availability report/.test(t)
    && /Keelon Russell has completed 93 of 132 passes/.test(t);
})());
chk('A the two editions share the evidence, not the sentences', CE.similarity(pubA.sections.map((s) => s.body).join('\n'), fpA.sections.map((s) => s.body).join('\n')) < 0.45 && pubA.title !== fpA.title && pubA.meta_description !== fpA.meta_description);
chk('A the EdgeDesk edition links each game’s research page and the free signup, untagged', (fpA.sections.map((s) => s.body).join('\n').match(/\]\(https:\/\/edgedesksports\.com\/research\/cfb\/#\/game\/\d+\)/g) || []).length >= 5
  && /\/newsletter\/\?from=/.test(CE.toMarkdown(fpA, { opportunity: O })) && !/utm_/.test(CE.toMarkdown(fpA, { opportunity: O })));
chk('A the publisher edition credits EdgeDesk and tags its link with the campaign', /Research by EdgeDesk Sports/.test(CE.toMarkdown(pubA, { publisher: PUB, opportunity: O, campaign: 'ce_stadiumrant_test' })) && /utm_campaign=ce_stadiumrant_test/.test(CE.toMarkdown(pubA, { publisher: PUB, opportunity: O, campaign: 'ce_stadiumrant_test' })));
chk('A Ole Miss at Vanderbilt is a coin flip on the numbers, so no upset is claimed either way', /Upset potential\.\*\* EdgeDesk sees this as close to even \(50% for Ole Miss\), so neither result would be an upset/.test(sectionOf(pubA, 'Ole Miss at').body));
chk('A no game prints a gap to a stale market', !/points from EdgeDesk’s number/.test(pubA.sections.map((s) => s.body).join('\n')) && /older than EdgeDesk’s three-hour freshness rule, so no gap to the market is stated/.test(sectionOf(pubA, 'Georgia at').body));
/* CBS unverified: the same article is HELD, not rejected */
const held = oppOf(raw, [], { gtw: { required: Object.values(ID) } }).opp;
const heldA = CE.draft(held, { publisher: PUB, format: 'weekly_games_to_watch', now: NOW });
const heldV = CE.validate(heldA, held, { publisher: PUB, now: NOW, teamLists: TEAMS });
const heldR = CE.gamesToWatch.review(heldA, held, heldV);
chk('A with CBS unverified the article is HELD (EDIT.BROADCAST), not rejected, and prints no network for it', heldR.verdict === 'HOLD' && heldR.hold.some((h) => h.id === 'EDIT.BROADCAST') && /\*\*TV:\*\* not yet verified/.test(sectionOf(heldA, 'UCLA at').body), heldR);
chk('A readiness re-verifies at the moment of sending: a verification grown stale fails the broadcast item', (function () {
  const rd = CE.readiness({ format: 'weekly_games_to_watch', checks: vPub, research_as_of: O.research.as_of, title: pubA.title, sections: pubA.sections }, { opportunity: O, now: staleAt });
  return rd.items.some((i) => i.id === 'broadcasts' && i.status === 'fail');
})());
/* the fixture itself */
const FIXT = BP.buildFromFixture(FX, { owner: { [ID.oregon]: CBS_OWNER } });
const fxO = oppOf(FIXT, [CBS_ROW], { gtw: { required: Object.values(ID) } }).opp;
const fxA = CE.draft(fxO, { publisher: PUB, format: 'weekly_games_to_watch', now: NOW });
const fxV = CE.validate(fxA, fxO, { publisher: PUB, now: NOW, teamLists: TEAMS });
chk('A an article built from the historical fixture is BLOCKED and REJECTED for publication (EDIT.FIXTURE)', fails(fxV, 'not_fixture') && fxV.integrity_status === 'BLOCKED' && CE.gamesToWatch.review(fxA, fxO, fxV).verdict === 'REJECT');
chk('A after the games, the same packets hold nothing: every game has kicked off', (function () {
  const after = oppOf(DOC, [CBS_ROW], { now: Date.parse('2026-10-11T12:00:00Z') }).opp;
  return after === null;
})());

section('X what is blocked');
const g2 = (a) => a.sections.find((s) => s.key === 'game_2');
const X = [
  ['a wrong TV network', 'where_to_watch', (a) => { const s = sectionOf(a, 'Texas A&M at'); s.body = s.body.replace('**TV:** ABC', '**TV:** FOX'); }],
  ['a wrong network in the schedule table', 'where_to_watch', (a) => { const s = a.sections.find((x) => x.key === 'watch_guide'); s.body = s.body.replace(/(Georgia at Alabama\*\* — [^\n]*), ABC/, '$1, CBS'); }],
  ['a placeholder kickoff', 'kickoff_times', (a) => { const s = sectionOf(a, 'Georgia at'); s.body = s.body.replace('7:30 p.m. ET (6:30 p.m. CT)', '12:00 a.m. ET (11 p.m. CT)'); }],
  ['a duplicated game', 'duplicate_matchup', (a) => { const s = a.sections.find((x) => x.key === 'game_5'); s.heading = g2(a).heading; s.body = g2(a).body; }],
  ['generic filler', 'generic_filler', (a) => { g2(a).body += '\n\nAnything can happen on any given Saturday.'; }],
  ['an invented statistic', 'numbers_in_evidence', (a) => { g2(a).body = g2(a).body.replace('**Why it matters.**', '**Why it matters.** Missouri has rushed for 412 yards in a game twice this season.'); }],
  ['an unverified injury', 'injury_claims', (a) => { const s = sectionOf(a, 'Texas vs.'); s.body = s.body.replace('**Why it matters.**', '**Why it matters.** Arch Manning is questionable with a shoulder injury.'); }],
  ['an upset the evidence does not make', 'upset_supported', (a) => { const s = sectionOf(a, 'Ole Miss at'); s.body = s.body.replace(/\*\*Upset potential\.\*\*[^\n]*/, '**Upset potential.** Upset alert: Vanderbilt could pull off the upset here.'); }],
  ['betting language', 'no_recommendation', (a) => { g2(a).body += '\n\nMissouri is our best bet of the week.'; }],
  ['a missing part', 'six_parts', (a) => { g2(a).body = g2(a).body.replace(/\*\*What to watch\*\*[\s\S]*$/, ''); }],
  ['a game section with fewer than two independent facts', 'facts_per_game', (a) => { const s = sectionOf(a, 'UCLA at'); s.body = s.body.split('\n\n').filter((b) => /^\*\*(Where to watch|EdgeDesk’s projection|Upset potential|What to watch)|^- /.test(b)).join('\n\n').replace(/\*\*Upset potential\.\*\*[^\n]*/, '**Upset potential.** EdgeDesk gives UCLA a 41% chance.').replace(/- UCLA’s yards[^\n]*\n?/, '').replace(/- Who takes[^\n]*/, '- Who takes the first snap for Oregon.') + '\n\n**Why it matters.** It is a Big Ten game.\n\n**The key matchup.** The line of scrimmage.'; }]
];
X.forEach((x) => {
  const bad = mutate(pubA, x[2]);
  const r = CE.validate(bad, O, { publisher: PUB, now: NOW, teamLists: TEAMS });
  /* an invented number is caught by whichever number check reaches it first */
  const hit = x[1] === 'numbers_in_evidence' ? (fails(r, 'numbers_in_evidence') || fails(r, 'numbers_per_game')) : fails(r, x[1]);
  chk('X blocks ' + x[0] + ' (' + x[1] + ')', hit && !r.ok, r.checks.filter((c) => c.status === 'fail').map((c) => c.id + ': ' + c.detail));
});
chk('X the EdgeDesk edition without its research links is blocked', (function () {
  const bad = mutate(fpA, (a) => { a.sections.forEach((s) => { s.body = s.body.replace(/\[([^\]]+)\]\(https:\/\/edgedesksports\.com\/research\/[^)]+\)/g, '$1'); }); });
  return fails(CE.validate(bad, O, { now: NOW, teamLists: TEAMS }), 'first_party_links');
})());
chk('X a wrong network or an invented stat REJECTS; an unverified broadcast HOLDS', (function () {
  const bad = mutate(pubA, X[0][2]); const r = CE.validate(bad, O, { publisher: PUB, now: NOW, teamLists: TEAMS });
  return CE.gamesToWatch.review(bad, O, r).verdict === 'REJECT' && heldR.verdict === 'HOLD';
})());

section('I more informative than the old projection-only preview');
const oldO = live.opps.find((o) => o.kind === 'weekly_preview' && o.league === 'cfb');
const oldA = CE.draft(oldO, { publisher: PUB, format: 'cfb_weekly_preview', now: NOW });
const infNew = CE.gamesToWatch.informativeness(pubA, O), infOld = CE.gamesToWatch.informativeness(oldA, O);
chk('I the new article states two or more independent facts in every game', infNew.min_facts_per_game >= 2 && infNew.games === 5, infNew.per_game);
chk('I it states at least five times the old preview’s independent facts', infNew.independent_facts >= 5 * Math.max(1, infOld.independent_facts), { new: infNew.independent_facts, old: infOld.independent_facts });
chk('I it covers more kinds of evidence (results, form, quarterbacks, availability, units, turnovers)', infNew.fact_kinds.length >= 6 && infNew.fact_kinds.length > infOld.fact_kinds.length, { new: infNew.fact_kinds, old: infOld.fact_kinds });
chk('I it says where to watch; the old preview did not', infNew.where_to_watch && !infOld.where_to_watch);
console.log('  informativeness: new ' + infNew.independent_facts + ' independent facts across ' + infNew.games + ' games (min ' + infNew.min_facts_per_game + ', ' + infNew.fact_kinds.length + ' kinds); old preview ' + infOld.independent_facts + ' (' + infOld.fact_kinds.length + ' kinds)');

section('C cost');
const reqFull = CE.ai.buildRequest(O, { publisher: PUB, format: 'weekly_games_to_watch', current: pubA });
const reqOne = CE.ai.buildRequest(O, { publisher: PUB, format: 'weekly_games_to_watch', current: pubA, section: 'game_3' });
const user = reqFull.messages[0].content;
chk('C the request carries the verified facts and the where-to-watch block, not the raw pairings or cards', /where_to_watch_block/.test(user) && !/"pairings"|"adjusted_cards"|"broadcast_input"/.test(user) && /FIVE GAMES TO WATCH — RULES/.test(user));
chk('C a one-game rewrite carries one packet and a smaller output budget', reqOne.messages[0].content.length < user.length / 3 && reqOne.max_tokens === 4000 && CE.cost.estimate(reqOne, MODEL) < CE.cost.estimate(reqFull, MODEL) / 2,
  { one: reqOne.messages[0].content.length, full: user.length, est1: CE.cost.estimate(reqOne, MODEL), estF: CE.cost.estimate(reqFull, MODEL) });
chk('C the full request’s upper-bound reservation fits the $10 month several times over', CE.cost.estimate(reqFull, MODEL) < 1);
chk('C a failure in one game names that game’s section for a targeted rewrite', (function () {
  const bad = mutate(pubA, X[0][2]); const r = CE.validate(bad, O, { publisher: PUB, now: NOW, teamLists: TEAMS });
  const fsx = CE.ai.failingSections(r, bad); return fsx.sections.length === 1 && fsx.sections[0] === sectionOf(bad, 'Texas A&M at').key && !fsx.whole_article;
})());
chk('C a one-section reply keeps every other section as it was', (function () {
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: pubA.title, meta_description: pubA.meta_description, standfirst: pubA.standfirst, sections: [{ key: 'game_3', heading: 'x', body: 'rewritten' }] }) }] };
  const p = CE.ai.parseReply(reply, pubA);
  return p.ok && p.article.sections.find((s) => s.key === 'game_3').body === 'rewritten' && p.article.sections.find((s) => s.key === 'game_1').body === pubA.sections.find((s) => s.key === 'game_1').body;
})());

section('F first-party publication');
const rec = FP.recordFor(fpA, O, vFp);
chk('F the EdgeDesk edition becomes an article-store record of its own type', rec.article_type === 'games_to_watch' && rec.canonical_url === 'https://edgedesksports.com/articles/' + fpA.slug + '/' && rec.gtw.games.length === 5);
chk('F its own publication checks pass on the live build', FP.checks(rec).every((c) => c.ok), FP.checks(rec).filter((c) => !c.ok));
const fxRec = FP.recordFor(CE.draft(fxO, { format: 'weekly_games_to_watch_first_party', now: NOW }), fxO, CE.validate(CE.draft(fxO, { format: 'weekly_games_to_watch_first_party', now: NOW }), fxO, { now: NOW, teamLists: TEAMS }));
chk('F the fixture’s record fails its publication checks', FP.checks(fxRec).some((c) => c.id === 'not_fixture' && !c.ok) && FP.checks(fxRec).some((c) => c.id === 'editorial_review' && !c.ok));
chk('F every broadcast is re-verified at publication: fresh now, stale twelve hours later', FP.broadcastsFresh(rec, NOW).ok && !FP.broadcastsFresh(rec, staleAt).ok);
const PUBLISHER = require(path.join(ROOT, 'tools', 'editorial', 'publisher.js'));
const AMODEL = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
chk('F the one publisher refuses the fixture’s record', (function () { const r = PUBLISHER.publish(AMODEL.hydrate(fxRec), { now: NOW, others: [] }); return !r.ok && r.action === 'held'; })());
chk('F the one publisher accepts the live record (the switch decides whether it ever runs)', (function () { const r = PUBLISHER.publish(AMODEL.hydrate(rec), { now: NOW, others: [] }); return r.ok && r.action === 'published'; })(),
  (function () { const r = PUBLISHER.publish(AMODEL.hydrate(rec), { now: NOW, others: [] }); return r.blocking; })());
chk('F the page renders through the one renderer, with each game as a section and no SportsEvent claim', (function () {
  const R = require(path.join(ROOT, 'tools', 'articles', 'article_render.js'));
  const html = R.articlePage(AMODEL.hydrate(Object.assign({}, rec, { status: 'published', published_at: FX.now, updated_at: FX.now })), { now: FX.now });
  return /Week 6 games to watch/.test(html) && (html.match(/class="a-sec a-md"/g) || []).length >= 8 && !/"SportsEvent"/.test(html) && /Broadcast verified/.test(html);
})());
chk('F automatic publication is off in the committed config', JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'content', 'config.json'), 'utf8')).first_party_auto_publish === false);

/* ── D the database: the new doors and the weekly job, end to end ───────── */
async function database() {
  section('D database (PostgreSQL)');
  const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
  const db = PG.start('gtwsql');
  if (db.skip) { console.log((process.env.CONTENT_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); if (process.env.CONTENT_PG_REQUIRED) { fail++; failures.push('D PostgreSQL required'); } return; }
  const { sqlVal } = require(path.join(ROOT, 'tools', 'growth', '_rpc_shim.js'));
  const PGR = require(path.join(ROOT, 'tools', 'lib', 'pgrest.js'));
  const RUN = require(path.join(__dirname, 'run.js'));
  const lit = PG.lit;
  const OWNER = '00000000-0000-0000-0000-0000000000c1';
  const J = (x) => (x === '' ? null : JSON.parse(x));
  const own = (q) => J(db.as(OWNER, q));
  const svc = (q) => J(db.service(q));
  const one = (q) => db.sql(q);
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'growth_outbound.sql', 'growth_engine.sql']
    .forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  const rep = db.applyFileAtomic(path.join(ROOT, 'supabase', 'content_engine.sql'));
  chk('D the file applies and its report reads ok', rep.split('\n').filter((l) => l && !/\|ok\|/.test(l)).length === 0, rep);
  one(`insert into auth.users (id, email, email_confirmed_at) values (${lit(OWNER)}, 'owner@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values (${lit(OWNER)});
       select growth_outbound.grant_owner('owner@edgedesk.test');
       update content_engine.settings set drafts_per_run = 10, min_priority = 0 where id = 1;`);
  const vrow = (o) => `select public.content_engine_broadcast_verify(${lit(JSON.stringify(o))}::jsonb);`;
  chk('D an owner records a broadcast verification from the official source', own(vrow({ game_id: ID.oregon, season: 2026, network: 'CBS', source_url: CBS_OWNER.source_url, source_kind: 'conference', source_name: CBS_OWNER.source_name })).ok === true);
  chk('D the service role cannot record one', !!db.mustFail(() => db.service(vrow({ game_id: ID.oregon, season: 2026, network: 'CBS', source_url: 'https://x.test/a', source_kind: 'conference', source_name: 'x y z' }))));
  chk('D a verification needs its official https URL', own(vrow({ game_id: ID.oregon, season: 2026, network: 'CBS', source_url: 'http://x.test/a', source_kind: 'conference', source_name: 'x y z' })).reason === 'source_url_required');
  chk('D a schedule move needs its reason', own(vrow({ game_id: ID.bama, season: 2026, kickoff: '2026-10-11T00:00:00Z', source_url: 'https://x.test/a', source_kind: 'conference', source_name: 'SEC update' })).ok === false);
  const cur = svc(`select public.content_engine_broadcast_checks_current(14);`);
  chk('D the job reads the current verification per game', Array.isArray(cur) && cur.length === 1 && cur[0].network === 'CBS' && cur[0].source_url === CBS_OWNER.source_url, cur);
  chk('D verifications are append-only', !!db.mustFail(() => one(`update content_engine.broadcast_checks set network = 'FOX';`)));
  /* the weekly job against the database, through the same REST shim run.test.js uses */
  const SB = 'https://gtw.supabase.test', SERVICE = 'service-role-key-for-tests';
  const fakeFetch = async (url, init) => {
    url = String(url);
    if (url.startsWith(SB + '/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body || '{}');
      const q = `select public.${fn}(${Object.entries(args).map(([k, v]) => k + ' => ' + sqlVal(v)).join(', ')});`;
      try { const o = db.service(q); return new Response(o === '' ? 'null' : o, { status: 200 }); }
      catch (e) { return new Response(JSON.stringify({ message: String(e.sqlMessage || e.message).slice(0, 300) }), { status: 400 }); }
    }
    return new Response('nope', { status: 404 });
  };
  const client = PGR.client({ url: SB, key: SERVICE }, fakeFetch, { retries: 0 });
  const r1 = await RUN.weekly({ db: client, art: artOf(DOC), now: NOW, network: false, log: () => {} });
  chk('D the weekly job ran', r1 && r1.ran, r1);
  const gtw = J(one(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'format', format, 'verdict', checks -> 'review' ->> 'verdict')), '[]'::jsonb) from content_engine.articles where format = 'weekly_games_to_watch';`));
  chk('D it drafted the publisher edition with its editorial review on file', gtw.length === 1 && gtw[0].verdict === 'READY', gtw);
  chk('D … and, every gate passing, queued it for the owner’s review (never approved or sent)', gtw[0] && gtw[0].status === 'in_review', gtw);
  /* the fixture's packets: the job rejects its own draft, with the reasons */
  /* the first article retired by the owner, so the fixture's research gets its own */
  chk('D (setup) the owner archives the first draft', own(`select public.content_engine_article_transition(${lit(gtw[0].id)}, 'archived', '{}'::jsonb);`).ok === true);
  const gtwOpp = one(`select id from content_engine.opportunities where kind = 'games_to_watch';`);
  chk('D (setup) … and reopens the topic', own(`select public.content_engine_opportunity_set_status(${lit(gtwOpp)}, 'new', null);`).ok === true);
  const r2 = await RUN.weekly({ db: client, art: artOf(BP.buildFromFixture(FX)), now: NOW, network: false, force: true, log: () => {} });
  const rej = J(one(`select coalesce(jsonb_agg(jsonb_build_object('status', status, 'verdict', checks -> 'review' ->> 'verdict')), '[]'::jsonb) from content_engine.articles where format = 'weekly_games_to_watch' and status = 'rejected';`));
  chk('D a draft whose own review is REJECT is rejected automatically', r2 && r2.ran && rej.length === 1 && rej[0].verdict === 'REJECT', { r2, rej });
  chk('D … and the reasons are logged', Number(one(`select count(*) from content_engine.events where kind = 'article_auto_rejected';`)) === 1);
  const readyId = gtw[0] && gtw[0].id;
  chk('D the auto-reject door refuses a draft its review did not reject', (function () {
    const oppId = one(`select id from content_engine.opportunities where kind = 'weekly_preview' limit 1;`);
    const d = svc(`select public.content_engine_article_create(${lit(oppId)}, null, 'cfb_weekly_preview', 'gtw_test',
      ${lit(JSON.stringify({ title: 'College Football Week 6 Predictions: a test draft', slug: 'gtw-test-draft', meta_description: 'x', standfirst: 'x', sections: [{ key: 'intro', heading: null, body: 'A projection is not a bet.' }], generator: 'template:test', checks: { ok: false, failed: ['x'], review: { verdict: 'HOLD' } } }))}::jsonb, null);`);
    return d && d.ok && svc(`select public.content_engine_article_auto_reject(${lit(d.id)}, '[]'::jsonb);`).reason === 'not_rejected_by_review';
  })());
  chk('D the auto-reject door refuses an article past draft', svc(`select public.content_engine_article_auto_reject(${lit(readyId)}, '[]'::jsonb);`).reason === 'not_a_draft');
  chk('D a publisher’s response is recorded only for a sent article', own(`select public.content_engine_publisher_response(${lit(readyId)}, '{"response":"accepted"}'::jsonb);`).reason === 'not_sent');
  one(`select set_config('content_engine.door', 'mark_sent', false);
       update content_engine.articles set status = 'approved', approved_by = ${lit(OWNER)}, approved_hash = content_hash where false;`);
  const tr = own(`select public.content_engine_template_report('[{"format":"weekly_games_to_watch_first_party","path":"/articles/college-football-week-6-games-to-watch-the-evidence-behind-each/"}]'::jsonb);`);
  const row = (tr.templates || []).find((t) => t.format === 'weekly_games_to_watch');
  chk('D the template report counts the template: generated, auto-rejected, first-pass approval', row && row.articles_generated === 2 && row.auto_rejected === 1 && row.first_pass_approval_rate === 0, row);
  chk('D … and the EdgeDesk page by its path, measured or null, never invented', (tr.templates || []).some((t) => t.format === 'weekly_games_to_watch_first_party' && t.first_party_pages === 1) && /never zero/.test(tr.basis) && /no search ranking/.test(tr.not_claimed));
  chk('D the template report is owner-only', !!db.mustFail(() => db.service(`select public.content_engine_template_report('[]'::jsonb);`)));
  chk('D a reservation is tied to its article once the article exists', (function () {
    one(`insert into content_engine.ai_months (month) values (content_engine.ai_month_now()) on conflict do nothing;
         insert into content_engine.ai_spend (request_key, month, purpose, actor, status, estimated_usd, actual_usd) values ('abcdef0123456789abcd', content_engine.ai_month_now(), 'draft', 'schedule', 'committed', 0.5, 0.21);`);
    const a = svc(`select public.content_engine_ai_attribute('["abcdef0123456789abcd"]'::jsonb, ${lit(readyId)});`);
    const t2 = own(`select public.content_engine_template_report('[]'::jsonb);`).templates.find((t) => t.format === 'weekly_games_to_watch');
    return a.ok && a.attributed === 1 && Number(t2.generation_cost_usd) === 0.21;
  })());
  chk('D draft → rejected is in the database’s transition matrix and the library’s', one(`select content_engine.can_transition('draft', 'rejected');`) === 't' && CE.util.canTransition('draft', 'rejected'));
}

(async function () {
  try { await database(); } catch (e) { fail++; failures.push('D database section threw — ' + String(e && e.stack || e).slice(0, 400)); }
  console.log('');
  failures.forEach((f) => console.log('  × ' + f));
  console.log((fail ? 'FAIL' : 'PASS') + ' | five games to watch | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

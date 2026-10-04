/* ============================================================================
   THE AVAILABILITY AGGREGATOR — many sources in, one answer per player out,
   with every source that disagreed still on the record.

     injury_evidence            every normalized statement any provider made
                                about a player (never edited, never merged)
       -> player_availability   one reconciled status per player for ONE
                                fixture, with the evidence behind it and the
                                evidence that disagreed
       -> team_availability_summary
                                what EdgeDesk knows about one side of one game,
                                and exactly how much: the coverage class, the
                                share of projected starters whose status is
                                known, the providers that answered, failed or
                                were never configured

   THE RULES, all enforced here and nowhere else:

     - FIXTURE-SCOPED. A report filed for last week's game says nothing about
       this one, except a designation that outlasts a game (out for the
       season, transferred, no longer with the team), which is carried.
     - HIERARCHY. A manual verified override outranks an official report,
       which outranks trusted reporting, which outranks a structured provider,
       which outranks an inference from participation. A stale high-tier
       record yields to a fresh lower-tier one, and the disagreement is kept.
     - SAME TIER, DIFFERENT WORDS: the later filing wins; the same timestamp
       is a CONFLICT and the player's status is UNKNOWN until it is settled.
     - SILENCE. Only a fresh COMPREHENSIVE official report for this fixture
       turns "not listed" into AVAILABLE. Everywhere else an unlisted player
       is UNKNOWN.
     - HISTORY IS NOT EVIDENCE. A structured row published before this game
       week (ESPN's college endpoint returns 2020-2022 rows) is refused and
       counted as refused.
     - A PROVIDER FAILURE IS NOT A HEALTHY ROSTER. A team every configured
       provider failed for is PROVIDER_FAILED, coverage 0, with each failure
       named.

   Pure: the caller supplies the evidence, the fixture, the policy verdict and
   the projected starters; nothing here reads a file or the clock.
   ========================================================================== */
'use strict';

const C = require('../config.js');
const S = require('./status.js');
const AV = require('../../availability/availability.js');
const { ms, iso, r1 } = require('../core/lineage.js');

const FIXTURE_FRESH_H = 48;   /* football/matchup/contract.js: an availability read older than 48h is STALE */
/* a designation that outlasts a game (season-ending, transferred, left the
   team) filed for an earlier fixture is carried this long: an in-season
   departure does not reverse itself inside two months, and any newer report
   outranks it */
const PERSIST_CARRY_H = 60 * 24;

function tierOf(e) {
  const st = C.SOURCE_TYPES[e.source_type];
  return st ? st.tier : 9;
}
function nkey(s) { return AV.normName ? AV.normName(s || '') : String(s || '').toLowerCase(); }
function playerKey(e) { return e.player_id ? 'id:' + e.player_id : 'n:' + nkey(e.player_name); }

/* judge one piece of evidence for one fixture:
   {use: 'FRESH'|'STALE'|false, why, carried_from_fixture} */
function judge(e, fx, now) {
  const at = ms(e.source_timestamp) != null ? ms(e.source_timestamp) : ms(e.retrieved_at);
  if (at == null) return { use: false, why: 'NO_TIMESTAMP' };
  if (at > now + 5 * 60e3) return { use: false, why: 'FUTURE_TIMESTAMP' };
  const age = (now - at) / 3600e3;
  if (e.game_id != null && fx.game_id != null && String(e.game_id) !== String(fx.game_id)) {
    /* another fixture's report: only a designation that outlasts a game says
       anything about this one, and only while it may still be carried */
    if (S.persists(e.availability_status) && age <= PERSIST_CARRY_H) return { use: 'STALE', why: 'CARRIED_PERSISTENT', carried_from_fixture: e.game_id };
    return { use: false, why: 'OTHER_FIXTURE' };
  }
  if (e.game_id != null) return age <= FIXTURE_FRESH_H ? { use: 'FRESH' } : { use: 'STALE', why: 'FIXTURE_REPORT_AGED' };
  /* a team-scoped statement (a structured feed row, an operator entry):
     judged by the availability layer's own freshness ladder */
  const f = AV.getAvailabilityFreshness({ source_published_at: iso(at) }, { now, kickoff: fx.kickoff });
  if (f.state === 'HISTORICAL') return { use: false, why: 'HISTORICAL' };
  if (f.state === 'STALE') return { use: 'STALE', why: 'AGED' };
  return { use: 'FRESH' };
}

/* reconcile the usable evidence about one player */
function reconcile(list) {
  const sorted = list.slice().sort((a, b) => (tierOf(a.e) - tierOf(b.e))
    || ((a.j.use === 'FRESH' ? 0 : 1) - (b.j.use === 'FRESH' ? 0 : 1))
    || ((ms(b.e.source_timestamp) || 0) - (ms(a.e.source_timestamp) || 0)));
  /* a fresh record outranks a stale one of a higher tier: the stale record
     stays on the list as a disagreement if it disagrees */
  const fresh = sorted.filter((x) => x.j.use === 'FRESH');
  const pool = fresh.length ? fresh : sorted;
  let chosen = pool[0];
  const conflicts = [];
  let conflicted = false;
  for (const x of sorted) {
    if (x === chosen || x.e.availability_status === chosen.e.availability_status) continue;
    const sameTier = tierOf(x.e) === tierOf(chosen.e);
    const sameTime = ms(x.e.source_timestamp) === ms(chosen.e.source_timestamp);
    const bothFresh = x.j.use === 'FRESH' && chosen.j.use === 'FRESH';
    const c = { status: x.e.availability_status, source: x.e.source, source_type: x.e.source_type,
      source_timestamp: x.e.source_timestamp, evidence_id: x.e.evidence_id, resolution: null };
    if (sameTier && bothFresh && sameTime) { conflicted = true; c.resolution = 'UNRESOLVED: same tier, same timestamp, different designation'; }
    else if (tierOf(x.e) < tierOf(chosen.e)) c.resolution = 'overruled: a higher-tier record, but stale while this one is fresh';
    else if (sameTier) c.resolution = 'overruled: an earlier filing at the same tier (the later filing wins)';
    else c.resolution = 'overruled: a lower-tier source';
    conflicts.push(c);
  }
  return { chosen, conflicts, conflicted };
}

/* aggregate one side of one fixture.
   o: { fixture: {game_id, kickoff, side, team_key, team_name, is_fbs},
        policy: policy.forGame(...) verdict,
        evidence: [injury_evidence],            every record about this team
        official: {ok, comprehensive, published_at, retrieved_at, rows_n, source_url, game_id} | null
                                                 the official report FOR THIS FIXTURE (corroborated)
        starters: [{player_id, name, pos, group, slot, unit, role, share}]   projected starters
        contributors: [...]                      key contributors (superset of starters)
        providers: {name: health summary}         the providers that cover this team
        now }                                     */
function aggregate(o) {
  const fx = o.fixture, now = ms(o.now);
  const refused = { HISTORICAL: 0, OTHER_FIXTURE: 0, NO_TIMESTAMP: 0, FUTURE_TIMESTAMP: 0 };
  const byPlayer = {};
  const usedProviders = { FRESH: {}, STALE: {} };
  (o.evidence || []).forEach((e) => {
    const j = judge(e, fx, now);
    if (!j.use) { refused[j.why] = (refused[j.why] || 0) + 1; return; }
    (byPlayer[playerKey(e)] = byPlayer[playerKey(e)] || []).push({ e, j });
    usedProviders[j.use][e.provider] = (usedProviders[j.use][e.provider] || 0) + 1;
  });

  const off = o.official && o.official.ok ? o.official : null;
  const offAge = off ? (now - (ms(off.published_at) || ms(off.retrieved_at) || now)) / 3600e3 : null;
  const offFresh = !!(off && offAge != null && offAge <= FIXTURE_FRESH_H);
  const silence = !!(off && offFresh && off.comprehensive);

  const roleOf = {};
  (o.contributors || []).concat(o.starters || []).forEach((p) => { if (p && p.player_id) roleOf[p.player_id] = p; });

  /* ---- player_availability */
  const players = [];
  const seen = {};
  Object.keys(byPlayer).forEach((k) => {
    const r = reconcile(byPlayer[k]);
    const e = r.chosen.e, j = r.chosen.j;
    const role = e.player_id ? roleOf[e.player_id] : null;
    const status = r.conflicted ? 'UNKNOWN' : e.availability_status;
    const tier = tierOf(e);
    players.push({
      player_id: e.player_id || null, team_id: fx.team_key, player_name: e.player_name, position: e.position || (role && role.pos) || null,
      availability_status: status, reported_status: e.reported_status, injury_type: e.injury_type || null,
      body_part: e.body_part || null, practice_status: e.practice_status || null,
      expected_role: role ? role.role : null, projected_starter: !!(role && role.starter),
      usage_share: role && role.share != null ? role.share : null,
      expected_snap_share: null, expected_snap_share_basis: 'no snap-count feed: usage_share is the players layer’s participation/touch share, not snaps',
      source: e.source, source_type: e.source_type, tier,
      source_timestamp: e.source_timestamp, retrieved_at: e.retrieved_at,
      freshness: j.use, carried_from_fixture: j.carried_from_fixture || null,
      confidence: Math.round(1000 * (C.SOURCE_TYPES[e.source_type] ? C.SOURCE_TYPES[e.source_type].weight : 0.4)
        * (j.use === 'FRESH' ? 1 : 0.5) * (r.conflicted ? 0.5 : 1) * (e.identity && e.identity.confidence === 'EXACT' ? 1 : 0.85)) / 1000,
      is_confirmed: !r.conflicted && tier <= 1 && j.use === 'FRESH',
      conflict: r.conflicted, conflicts: r.conflicts,
      evidence_ids: byPlayer[k].map((x) => x.e.evidence_id),
      basis: r.conflicted ? 'sources at the same tier filed different designations at the same time: UNKNOWN until settled'
        : (j.use === 'FRESH' ? 'the highest-ranked current source' : 'the best evidence on file is stale: ' + (j.why || '').toLowerCase().replace(/_/g, ' ')),
      raw_evidence_reference: e.raw_evidence_reference || null
    });
    if (e.player_id) seen[e.player_id] = players[players.length - 1];
  });

  /* ---- starters and key contributors: known, or UNKNOWN — never assumed */
  function knownOf(p) {
    const rec = p.player_id ? seen[p.player_id] : null;
    if (rec && rec.availability_status !== 'UNKNOWN') return { known: true, status: rec.availability_status, via: 'listed' };
    if (silence) return { known: true, status: 'AVAILABLE', via: 'comprehensive official report: not listed means available' };
    return { known: false, status: 'UNKNOWN', via: rec ? 'listed, but the designation is unresolved' : 'no current source states his status' };
  }
  function tally(list) {
    const out = { total: 0, known: 0, unknown: 0, known_pct: null, unknown_list: [], out_list: [], doubt_list: [] };
    (list || []).forEach((p) => {
      out.total++;
      const k = knownOf(p);
      if (k.known) out.known++; else { out.unknown++; out.unknown_list.push({ player_id: p.player_id, name: p.name, pos: p.pos, slot: p.slot, unit: p.unit }); }
      if (S.isAbsent(k.status)) out.out_list.push({ player_id: p.player_id, name: p.name, pos: p.pos, status: k.status });
      else if (S.isDoubt(k.status)) out.doubt_list.push({ player_id: p.player_id, name: p.name, pos: p.pos, status: k.status });
      if (silence && !seen[p.player_id] && p.player_id) {
        players.push({ player_id: p.player_id, team_id: fx.team_key, player_name: p.name, position: p.pos,
          availability_status: 'AVAILABLE', reported_status: null, injury_type: null, body_part: null, practice_status: null,
          expected_role: p.role || null, projected_starter: !!p.starter, usage_share: p.share == null ? null : p.share,
          expected_snap_share: null, expected_snap_share_basis: 'no snap-count feed',
          source: off.source || 'official conference availability report', source_type: 'PRIMARY_STRUCTURED', tier: 1,
          source_timestamp: iso(off.published_at), retrieved_at: iso(off.retrieved_at), freshness: 'FRESH',
          confidence: 0.9, is_confirmed: true, conflict: false, conflicts: [], evidence_ids: [],
          basis: 'COMPREHENSIVE_SILENCE: the official report for this game is comprehensive and does not list him',
          raw_evidence_reference: off.source_url || null });
        seen[p.player_id] = players[players.length - 1];
      }
    });
    out.known_pct = out.total ? Math.round(1000 * out.known / out.total) / 10 : null;
    return out;
  }
  const starters = tally(o.starters);
  const contributors = tally(o.contributors);

  /* ---- the coverage class: ONE interpretation of how much is known */
  const provs = o.providers || {};
  const pol = o.policy || {};
  const freshProviders = Object.keys(usedProviders.FRESH);
  const staleProviders = Object.keys(usedProviders.STALE);
  /* each provider's verdict FOR THIS TEAM. A source that does not cover the
     team (a conference report for a conference with no policy, an operator
     file with no entry for it) is not counted as covering it, and is not
     counted as failing it either */
  const provList = Object.keys(provs).map((n) => {
    const p = provs[n] || {};
    let relevant = true, verdict;
    if (p.state === 'NOT_CONFIGURED') { relevant = false; verdict = 'NOT_CONFIGURED'; }
    else if (fx.is_fbs === false) { relevant = false; verdict = 'NOT_COVERED'; }
    else if (n === 'conference_reports' && ['UNREGISTERED', 'UNVERIFIED', 'NO_CONFERENCE_POLICY'].indexOf(pol.state) >= 0) { relevant = false; verdict = 'NOT_COVERED'; }
    else if (n === 'operator_overrides' && !usedProviders.FRESH[n] && !usedProviders.STALE[n]) { relevant = false; verdict = 'NO_ENTRIES'; }
    else if (usedProviders.FRESH[n]) verdict = 'ANSWERED';
    else if (usedProviders.STALE[n]) verdict = 'STALE_ONLY';
    else if (['AUTH_FAILURE', 'DOWN', 'RATE_LIMITED'].indexOf(p.state) >= 0) verdict = 'FAILED';
    else if (p.state === 'STALE') verdict = 'HISTORICAL_ONLY';
    else if (n === 'conference_reports') verdict = (pol.state === 'NOT_DUE_YET' || pol.state === 'NOT_REQUIRED_FOR_THIS_GAME' || pol.state === 'BEFORE_POLICY_START') ? 'NOT_DUE' : 'NOT_READ';
    else verdict = 'ANSWERED_NOTHING';
    return { provider: n, state: p.state, relevant, verdict };
  });
  const relevantProv = provList.filter((p) => p.relevant);
  const failed = relevantProv.filter((p) => p.verdict === 'FAILED');
  const deadEnds = relevantProv.filter((p) => ['FAILED', 'HISTORICAL_ONLY', 'NOT_READ'].indexOf(p.verdict) >= 0);
  let cls, why;
  if (fx.is_fbs === false) { cls = 'NO_SOURCE'; why = 'no availability source is registered for non-FBS programmes'; }
  else if (off && !offFresh) { cls = 'STALE_CARRIED'; why = 'the official report for this game is ' + Math.round(offAge) + 'h old, past the ' + FIXTURE_FRESH_H + 'h freshness floor'; }
  else if (off && off.comprehensive) { cls = 'COMPREHENSIVE_OFFICIAL'; why = 'a comprehensive official report for this game (' + (off.rows_n || 0) + ' listed; everyone else is available)'; }
  else if (off && (off.rows_n || 0) > 0) { cls = 'OFFICIAL_THIS_GAME'; why = 'an official report for this game lists ' + off.rows_n + ', but its vocabulary is absence-only, so silence is not availability'; }
  else if (off) { cls = 'OFFICIAL_ABSENCE_ONLY'; why = 'an official, absence-only report for this game'; }
  else if (freshProviders.length >= 2) { cls = 'MULTI_SOURCE_CURRENT'; why = freshProviders.length + ' independent current sources (' + freshProviders.join(', ') + '), none official'; }
  else if (freshProviders.length === 1) { cls = 'STRUCTURED_CURRENT'; why = 'one current source (' + freshProviders[0] + '); nobody states the rest of the roster is whole'; }
  else if (staleProviders.length) { cls = 'STALE_CARRIED'; why = 'only stale evidence is on file (' + staleProviders.join(', ') + ')'; }
  else if (pol.state === 'NOT_DUE_YET') { cls = 'NOT_DUE_YET'; why = (pol.conference || 'the conference') + '’s report for this game is not due yet — nobody is assumed fit'; }
  else if (pol.state === 'NOT_REQUIRED_FOR_THIS_GAME') { cls = 'NOT_REQUIRED'; why = 'no conference report is required for this fixture, and no other source covers it'; }
  else if (relevantProv.length && failed.length && deadEnds.length === relevantProv.length) {
    cls = 'PROVIDER_FAILED';
    why = 'every source that covers ' + fx.team_name + ' failed or held nothing current: '
      + deadEnds.map((p) => p.provider + ' ' + (p.verdict === 'FAILED' ? p.state.toLowerCase().replace(/_/g, ' ')
        : (p.verdict === 'NOT_READ' ? 'report due but not read' : 'historical rows only'))).join(', ')
      + ' — a failure, not a healthy roster'
      + (refused.HISTORICAL ? ' (' + refused.HISTORICAL + ' historical row' + (refused.HISTORICAL === 1 ? '' : 's') + ' refused)' : '');
  } else {
    cls = 'NO_SOURCE';
    why = 'no current source covers ' + fx.team_name
      + (pol.state === 'REQUIRED' ? '; the conference report is due and was not read' : '')
      + (refused.HISTORICAL ? '; ' + refused.HISTORICAL + ' historical row' + (refused.HISTORICAL === 1 ? '' : 's') + ' refused' : '');
  }
  const score = C.AVAIL_COVERAGE[cls];
  const counts = {};
  players.forEach((p) => { counts[p.availability_status] = (counts[p.availability_status] || 0) + 1; });
  const asOf = players.map((p) => p.source_timestamp).filter(Boolean).sort().pop() || null;
  return {
    players,
    summary: {
      team_id: fx.team_key, team_name: fx.team_name, side: fx.side, game_id: fx.game_id,
      coverage_class: cls, coverage_score: score == null ? null : Math.round(score * 1000) / 1000, coverage_reason: why,
      comprehensive: silence, official: off ? { for_this_game: true, comprehensive: !!off.comprehensive, fresh: offFresh,
        published_at: iso(off.published_at), age_hours: r1(offAge), listed: off.rows_n || 0, source_url: off.source_url || null } : null,
      policy: { state: pol.state || null, conference: pol.conference || null, comprehensive: pol.comprehensive == null ? null : !!pol.comprehensive,
        hours_to_kickoff: pol.hours_to_kickoff == null ? null : pol.hours_to_kickoff },
      providers: provList.map((p) => ({ provider: p.provider, state: p.state, verdict: p.verdict, relevant: p.relevant,
        contributed_fresh: usedProviders.FRESH[p.provider] || 0, contributed_stale: usedProviders.STALE[p.provider] || 0 })),
      sources_answered: freshProviders.length + (off && freshProviders.indexOf('conference_reports') < 0 ? 1 : 0), sources_failed: failed.length,
      sources_not_configured: provList.filter((p) => p.state === 'NOT_CONFIGURED').length,
      listed: counts, players_listed: players.filter((p) => p.basis.indexOf('COMPREHENSIVE_SILENCE') < 0).length,
      refused, starters, key_contributors: contributors,
      as_of: asOf, stale: cls === 'STALE_CARRIED', provider_failure: cls === 'PROVIDER_FAILED'
    }
  };
}

module.exports = { aggregate, judge, reconcile, FIXTURE_FRESH_H };

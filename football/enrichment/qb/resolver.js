/* ============================================================================
   THE QB EVIDENCE RESOLVER — who is expected to start at quarterback, how
   sure EdgeDesk is, and every piece of evidence that says otherwise.

   For each side of each game it publishes:

     { player_id, player_name, status, starter_probability, probability_basis,
       confirmation_level, sources[], last_updated, conflict, conflict_resolved,
       conflicting_sources[], resolution, backup, reasoning_codes[],
       agreement, contested, refresh }

   THE HIERARCHY (config.js QB_TIERS, configurable):
     Tier 1  official announcement, official depth chart, coach announcement
     Tier 2  trusted beat reporting, conference/team availability report
     Tier 3  a major sports-data provider's depth chart
     Tier 4  a depth-chart aggregator
     Tier 5  inference: the observed start in the previous game, and — below
             it — EdgeDesk's own player-quality ranking, which is an opinion
             about who is BETTER, not evidence about who STARTS

   THE RULES:
     - Fresh evidence at a higher tier always wins. Tier 5 never overrides a
       fresh Tier 1.
     - A disagreement is DETECTED whenever fresh evidence names two players.
       It is RESOLVED automatically only when the hierarchy clearly permits:
         AUTHORITY          the winner's tier outranks every dissenting tier
         OBSERVED_OVER_MODEL the observed start was decisive (>= 65% of the
                            dropbacks) and the only dissent is EdgeDesk's
                            own quality ranking
         INJURY             the higher-ranked name is ruled out by a current
                            availability designation
       Anything else stays CONFLICTED, with both sides published.
     - Stale evidence never conflicts with fresh evidence; it is kept as
       context.
     - The labels are NOT probabilities. `starter_probability` is filled only
       from a calibrated rate (football/starters/persistence.json, the
       measured rate at which a last-game opener opens the next game); it is
       null everywhere else and says why.

   CONFIRMATION LEVELS:
     CONFIRMED          fresh Tier 1, the player not ruled out or in doubt
     STRONGLY_EXPECTED  fresh Tier 2, or two independent sources agreeing with
                        at least one at Tier 4 or better
     EXPECTED           one fresh source at Tier 3-5 (a decisive observed start
                        counts), any disagreement resolved by the hierarchy
     UNCERTAIN          only stale evidence, a split job, only EdgeDesk's own
                        ranking, or the starter listed questionable/doubtful
     CONFLICTED         sources disagree and the hierarchy cannot settle it
     UNKNOWN            no evidence names anybody

   Pure: no file, no clock.
   ========================================================================== */
'use strict';

const C = require('../config.js');
const S = require('../availability/status.js');
const { ms, iso, r1 } = require('../core/lineage.js');

const KIND_MAP = {
  OFFICIAL_ANNOUNCEMENT: 'OFFICIAL_ANNOUNCEMENT', OFFICIAL_DEPTH_CHART: 'OFFICIAL_DEPTH_CHART',
  COACH_ANNOUNCEMENT: 'COACH_ANNOUNCEMENT', MEDIA_REPORT: 'BEAT_REPORT', BEAT_REPORT: 'BEAT_REPORT',
  CONFERENCE_REPORT: 'CONFERENCE_REPORT', DEPTH_CHART: 'PROVIDER_DEPTH_CHART',
  PROVIDER_DEPTH_CHART: 'PROVIDER_DEPTH_CHART', AGGREGATOR_DEPTH_CHART: 'AGGREGATOR_DEPTH_CHART',
  GAME_USAGE: 'PREVIOUS_GAME_START', PREVIOUS_GAME_START: 'PREVIOUS_GAME_START',
  PROJECTION: 'MODEL_PROJECTION', MODEL_PROJECTION: 'MODEL_PROJECTION'
};

function tierOf(kind) { return (C.QB_TIERS[kind] || { tier: 9 }).tier; }
function subOf(kind) { return (C.QB_TIERS[kind] || { sub: 9 }).sub; }
function weightOf(item) {
  const w = C.QB_TIER_WEIGHT[tierOf(item.kind)] || 0.1;
  return item.kind === 'MODEL_PROJECTION' ? w * C.QB_MODEL_WEIGHT_FACTOR : w;
}
function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a.player_id && b.player_id) return String(a.player_id) === String(b.player_id);
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/^(dj|jj|cj|tj|aj)/, (m) => m);
  return n(a.player_name) === n(b.player_name);
}

/* the share of the dropbacks the named player took in the game an observed-
   start item describes */
function shareOf(item, rec) {
  const m = /(\d+) of (\d+) dropbacks/.exec(item.detail || '');
  if (m && +m[2] > 0) return +m[1] / +m[2];
  const h = (rec && rec.history || []).filter((x) => x.week === item.week && x.starter && samePlayer(x.starter, item)).pop();
  return h && typeof h.starter.share === 'number' ? h.starter.share : null;
}

/* evidence items from every source, in one shape */
function itemsFrom(o) {
  const out = [];
  const rec = o.record || null;
  (rec && rec.evidence || []).forEach((e) => {
    const kind = KIND_MAP[e.kind] || null;
    if (!kind || !e.player_name) return;
    out.push({ kind, tier: tierOf(kind), player_id: e.player_id ? String(e.player_id) : null, player_name: e.player_name,
      source: e.source || null, source_url: e.source_url || null, observed_at: iso(e.published_at), retrieved_at: iso(e.retrieved_at),
      detail: e.detail || null, week: e.week == null ? null : e.week, provider: kind === 'MODEL_PROJECTION' ? 'epir_projection' : (kind === 'PREVIOUS_GAME_START' ? 'starters_usage' : 'starters_layer'),
      upstream_stale: e.stale === true ? true : (e.stale === false ? false : null) });
  });
  (o.operator || []).forEach((e) => {
    const kind = e.confirmed ? (/coach/i.test(e.source_name || '') ? 'COACH_ANNOUNCEMENT' : 'OFFICIAL_ANNOUNCEMENT') : 'BEAT_REPORT';
    out.push({ kind, tier: tierOf(kind), player_id: e.player_id ? String(e.player_id) : null, player_name: e.player,
      source: e.source_name || 'operator', source_url: e.source_url || null, observed_at: iso(e.published_at), retrieved_at: iso(e.recorded_at),
      detail: e.note || null, week: null, provider: 'operator_overrides', game_id: e.game_id || null });
  });
  (o.extra || []).forEach((e) => out.push(Object.assign({ tier: tierOf(e.kind) }, e)));
  const now = ms(o.now);
  out.forEach((it) => {
    const age = ms(it.observed_at) == null ? null : (now - ms(it.observed_at)) / 3600e3;
    const ttl = C.QB_FRESH_HOURS[it.kind] || 96;
    it.age_hours = r1(age);
    it.future = age != null && age < -0.1;
    it.fresh = age != null && age >= -0.1 && age <= ttl;
    it.stale_why = it.fresh ? null : (age == null ? 'no timestamp' : (it.future ? 'stamped after the judging time' : 'observed ' + Math.round(age) + 'h ago, past its ' + ttl + 'h window'));
    /* a play-attribution row with no kickoff time (common for FCS games in
       the feed) still names its WEEK; the starter layer judges those by week
       (usage more than two weeks old is stale), and that judgment is used
       rather than calling a known recent start "unknown". The missing clock
       is published */
    if (age == null && it.upstream_stale === false) { it.fresh = true; it.stale_why = null; it.timestamp_missing = true; }
    if (it.game_id && o.game_id && String(it.game_id) !== String(o.game_id)) { it.fresh = false; it.stale_why = 'filed for another game'; }
    if (it.kind === 'PREVIOUS_GAME_START') it.share = shareOf(it, rec);
  });
  return out.filter((it) => !it.future);
}

function order(a, b) {
  return (a.tier - b.tier) || (subOf(a.kind) - subOf(b.kind)) || ((ms(b.observed_at) || 0) - (ms(a.observed_at) || 0));
}

/* resolve(o)
   o: { team_key, team_name, game_id, kickoff, now,
        record          the team's starters record (football/starters/cfb_<season>.json)
        operator        operator STARTER entries for this team (validated, live)
        extra           any further normalized items [{kind, player_id, player_name, source, observed_at, ...}]
        availability    {byId: {player_id: player_availability}, summary: team_availability_summary}
        quality         the players layer's projected QB list (slot order)
        persistence     football/starters/persistence.json
        qbc             football/matchup/qb_context.js (for the calibrated rate) } */
function resolve(o) {
  const items = itemsFrom(o).sort(order);
  const fresh = items.filter((i) => i.fresh), stale = items.filter((i) => !i.fresh);
  const codes = [];
  const rec = o.record || null;
  const avById = (o.availability && o.availability.byId) || {};
  const avSummary = (o.availability && o.availability.summary) || null;
  const statusOf = (p) => {
    if (!p) return { status: 'UNKNOWN', basis: 'no player' };
    const a = p.player_id ? avById[p.player_id] : null;
    if (a) return { status: a.availability_status, basis: a.basis, source: a.source, is_confirmed: a.is_confirmed, freshness: a.freshness };
    return { status: 'UNKNOWN', basis: avSummary ? ('not listed; ' + avSummary.coverage_reason) : 'no availability read for this fixture' };
  };

  let chosen = null, resolution = null, conflict = false, resolved = false, presettled = false;
  const dissent = [];
  if (fresh.length) {
    const top = fresh[0];
    const peers = fresh.filter((i) => i.tier === top.tier && subOf(i.kind) === subOf(top.kind));
    const names = [];
    peers.forEach((i) => { if (!names.some((n) => samePlayer(n, i))) names.push(i); });
    chosen = top;
    if (names.length > 1) {
      /* two names on the same rung. The later filing wins only for FILED
         statements (announcements, reports, depth charts) an hour or more
         apart; two openers in one game is a split job unless one of them was
         decisive */
      const filed = top.kind !== 'PREVIOUS_GAME_START' && top.kind !== 'MODEL_PROJECTION';
      const newest = names.slice().sort((x, y) => (ms(y.observed_at) || 0) - (ms(x.observed_at) || 0));
      const dec = top.kind === 'PREVIOUS_GAME_START' ? names.filter((n) => n.share != null && n.share >= C.QB_DECISIVE_SHARE) : [];
      if (filed && ms(newest[0].observed_at) - ms(newest[1].observed_at) >= 3600e3) { chosen = newest[0]; resolution = 'LATER_FILING'; presettled = true; }
      else if (dec.length === 1) { chosen = dec[0]; resolution = 'DECISIVE_OPENER'; presettled = true; }
      else codes.push('SAME_TIER_DISAGREEMENT');
    }
    fresh.forEach((i) => { if (!samePlayer(i, chosen)) dissent.push(i); });
  }
  /* only stale evidence: a start three weeks ago names somebody, but it is not
     evidence about THIS game. The name is kept as context and the answer
     stays UNKNOWN */
  let lastKnown = null;
  if (!chosen && stale.length) {
    lastKnown = { player_id: stale[0].player_id, player_name: stale[0].player_name, kind: stale[0].kind,
      observed_at: stale[0].observed_at, why: stale[0].stale_why };
    codes.push('STALE_EVIDENCE_ONLY');
  }

  /* every dissenting fresh item is settled by the hierarchy or it is not */
  if (chosen && dissent.length) {
    conflict = true;
    const open = dissent.filter((d) => {
      if (d.tier > chosen.tier) return false;                                  /* AUTHORITY */
      if (d.tier === chosen.tier && subOf(d.kind) > subOf(chosen.kind)) {
        /* inside Tier 5: an observed start outranks the quality ranking only
           when the start was decisive */
        if (chosen.kind === 'PREVIOUS_GAME_START' && d.kind === 'MODEL_PROJECTION') return !(chosen.share != null && chosen.share >= C.QB_DECISIVE_SHARE);
        return true;
      }
      if (d.tier === chosen.tier && subOf(d.kind) === subOf(chosen.kind)) return !presettled;
      return true;
    });
    resolved = open.length === 0;
    if (resolved && !resolution) {
      if (dissent.every((d) => d.tier > chosen.tier)) resolution = 'AUTHORITY';
      else resolution = 'OBSERVED_OVER_MODEL';
    }
    if (resolved) codes.push(resolution === 'AUTHORITY' ? 'RESOLVED_BY_AUTHORITY' : (resolution === 'OBSERVED_OVER_MODEL'
      ? 'OBSERVED_START_OVER_QUALITY_RANKING' : 'RESOLVED_' + resolution));
    else if (chosen.kind === 'PREVIOUS_GAME_START' && open.every((d) => d.kind === 'MODEL_PROJECTION')) codes.push('OBSERVED_START_NOT_DECISIVE');
    else codes.push('HIERARCHY_CANNOT_SETTLE');
  }
  if (dissent.some((d) => d.kind === 'MODEL_PROJECTION')) codes.push('QUALITY_RANKING_PREFERS_ANOTHER_QB');

  /* the chosen QB's availability; a ruled-out starter hands the job on */
  let st = statusOf(chosen);
  let handedFrom = null;
  if (chosen && S.isAbsent(st.status)) {
    const alt = fresh.concat(stale).find((i) => !samePlayer(i, chosen) && !S.isAbsent(statusOf(i).status));
    handedFrom = { player_id: chosen.player_id, player_name: chosen.player_name, status: st.status };
    codes.push('STARTER_RULED_OUT');
    if (alt) { chosen = alt; resolution = 'INJURY'; resolved = true; conflict = true; st = statusOf(alt); }
    else chosen = null;
  }
  if (chosen && S.isDoubt(st.status) && st.status !== 'PROBABLE') codes.push('STARTER_' + st.status);

  /* the history: a projected QB1 who opened earlier this season and has not
     opened since is information about availability, not only about the job */
  if (rec && rec.history && chosen) {
    const openers = rec.history.filter((h) => h.starter).map((h) => h.starter);
    const lost = openers.filter((s) => !samePlayer(s, chosen));
    if (lost.length && openers.length && samePlayer(openers[openers.length - 1], chosen)) codes.push('EARLIER_OPENER_NO_LONGER_STARTING');
  }
  if (rec && rec.competition && rec.competition.contested) codes.push('JOB_CONTESTED_BY_USAGE');
  (rec && rec.refused || []).forEach((r) => codes.push('REFUSED_' + String(r.kind || 'EVIDENCE').toUpperCase() + ':' + String(r.why || '').slice(0, 40).replace(/[^A-Za-z]+/g, '_').toUpperCase()));

  /* agreement: the share of the fresh evidence's weight naming the choice */
  const pool = fresh.length ? fresh : stale;
  let wAll = 0, wAgree = 0;
  pool.forEach((i) => { const w = weightOf(i) * (i.fresh ? 1 : 0.5); wAll += w; if (chosen && samePlayer(i, chosen)) wAgree += w; });
  const agreement = wAll ? Math.round(1000 * wAgree / wAll) / 1000 : null;

  /* the confirmation level */
  const agreeing = fresh.filter((i) => chosen && samePlayer(i, chosen));
  const independent = new Set(agreeing.map((i) => i.provider)).size;
  const contested = !!(rec && rec.competition && rec.competition.contested);
  let level;
  if (!chosen) level = 'UNKNOWN';
  else if (conflict && !resolved) level = 'CONFLICTED';
  else if (!fresh.length) level = 'UNCERTAIN';
  else if (agreeing.some((i) => i.tier === 1) && !S.isDoubt(st.status)) level = 'CONFIRMED';
  else if (agreeing.some((i) => i.tier === 2) || (independent >= 2 && agreeing.some((i) => i.tier <= 4 && i.kind !== 'MODEL_PROJECTION'))) level = 'STRONGLY_EXPECTED';
  else if (agreeing.every((i) => i.kind === 'MODEL_PROJECTION')) level = 'UNCERTAIN';
  else if (contested && !(chosen.share != null && chosen.share >= C.QB_DECISIVE_SHARE)) level = 'UNCERTAIN';
  else level = 'EXPECTED';
  if ((level === 'CONFIRMED' || level === 'STRONGLY_EXPECTED' || level === 'EXPECTED') && ['QUESTIONABLE', 'DOUBTFUL'].indexOf(st.status) >= 0) { level = 'UNCERTAIN'; }
  if (resolution === 'INJURY' && level === 'CONFIRMED') level = 'EXPECTED';

  /* a CALIBRATED probability, or none */
  let prob = null, probBasis = 'no calibrated rate exists for this evidence class: the confirmation label is a description, not a probability';
  if (chosen && rec && o.qbc && o.persistence && chosen.kind === 'PREVIOUS_GAME_START' && String(rec.player_id) === String(chosen.player_id)) {
    const q = o.qbc.build(rec, { persistence: o.persistence });
    if (q && q.persistence && typeof q.persistence.rate === 'number') {
      prob = q.persistence.rate;
      probBasis = 'measured: a last-game opener in the ' + q.persistence.band + ' cell opened the next game ' + Math.round(prob * 1000) / 10
        + '% of the time (' + q.persistence.pairs + ' pairs, football/starters/persistence.json)';
    }
  }

  /* the backup: the next QB by observed usage, else by EdgeDesk's quality
     ranking — and it says which */
  let backup = null;
  const comp = rec && rec.competition && rec.competition.players || [];
  const byUse = comp.find((p) => chosen && !samePlayer(p, chosen) && p.share > 0);
  if (byUse) backup = { player_id: String(byUse.player_id), player_name: byUse.player_name, basis: 'next by observed dropbacks (' + Math.round(byUse.share * 100) + '% of the room\u2019s last ' + (rec.competition.games || 2) + ' games)' };
  else {
    const q2 = (o.quality || []).find((p) => chosen && !samePlayer({ player_id: String(p.key || '').replace(/^a:/, ''), player_name: p.name }, chosen));
    if (q2) backup = { player_id: String(q2.key || '').replace(/^a:/, ''), player_name: q2.name, basis: 'next by EdgeDesk\u2019s quality ranking (not a depth chart)' };
  }
  if (backup) backup.status = statusOf(backup).status;

  const last = items.map((i) => i.retrieved_at || i.observed_at).filter(Boolean).sort().pop() || null;
  const describe = (i) => ({ kind: i.kind, tier: i.tier, label: (C.QB_TIERS[i.kind] || {}).label || i.kind, player_id: i.player_id, player_name: i.player_name,
    source: i.source, source_url: i.source_url, observed_at: i.observed_at, retrieved_at: i.retrieved_at, fresh: i.fresh,
    stale_why: i.stale_why, detail: i.detail, share: i.share == null ? null : Math.round(i.share * 1000) / 1000,
    agrees: !!(chosen && samePlayer(i, chosen)) });
  let resText = null;
  if (conflict) {
    const names = dissent.map((d) => d.player_name + ' [' + (C.QB_TIERS[d.kind] || {}).label + ']').join('; ');
    const bare = Array.from(new Set(dissent.map((d) => d.player_name))).join(' / ');
    if (resolution === 'OBSERVED_OVER_MODEL') resText = chosen.player_name + ' opened the last game with ' + Math.round(chosen.share * 100)
      + '% of the dropbacks; EdgeDesk\u2019s quality ranking prefers ' + bare + '. An observed start outranks the model\u2019s own ranking, which is not a source.';
    else if (resolution === 'AUTHORITY') resText = chosen.player_name + ' is named by ' + (C.QB_TIERS[chosen.kind] || {}).label + ', which outranks ' + names;
    else if (resolution === 'INJURY') resText = handedFrom.player_name + ' is listed ' + handedFrom.status + '; ' + chosen.player_name + ' is the next name the evidence supports';
    else if (resolution === 'LATER_FILING') resText = 'two filings at the same tier disagree; the later one names ' + chosen.player_name;
    else if (resolution === 'DECISIVE_OPENER') resText = 'two openers are on file for the last game; ' + chosen.player_name + ' took ' + Math.round(chosen.share * 100) + '% of its dropbacks';
    else resText = 'UNRESOLVED: ' + (chosen ? chosen.player_name + ' vs ' : '') + names + ' \u2014 the hierarchy cannot settle it';
  }
  return {
    team_id: o.team_key, team_name: o.team_name, game_id: o.game_id,
    player_id: chosen ? chosen.player_id : null, player_name: chosen ? chosen.player_name : null,
    status: chosen ? st.status : 'UNKNOWN', status_basis: chosen ? st.basis : null, status_confirmed: !!(chosen && st.is_confirmed),
    starter_probability: prob, probability_basis: probBasis,
    confirmation_level: level,
    contested,
    sources: items.map(describe),
    last_updated: last,
    conflict, conflict_resolved: conflict ? resolved : null,
    resolution: conflict ? (resolved ? resolution : 'UNRESOLVED') : null, resolution_text: resText,
    conflicting_sources: dissent.map(describe),
    handed_from: handedFrom,
    last_known: lastKnown,
    backup,
    agreement,
    reasoning_codes: Array.from(new Set(codes))
  };
}

module.exports = { resolve, itemsFrom, KIND_MAP };

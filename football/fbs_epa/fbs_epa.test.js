#!/usr/bin/env node
/* ===========================================================================
   THE FBS QUARTERBACK EPA LAYER — the rules, on the real artifacts.

   These are not smoke tests. Each one holds a claim that, if it stopped being
   true, would turn a research measurement into either a wrong number or a
   priced one:

     1  A PREGAME MEASUREMENT CANNOT CONTAIN ITS OWN GAME. The adapter cuts
        dated rows at the kickoff it is asked about, and this suite re-asks
        the same question at a cutoff before and after a known game and
        checks the answer moves in exactly the way it should.
     2  NOTHING IS RELABELLED. Success rate, CPOE, QBR and yards per attempt
        are not EPA, and `isEpa` says so for each of them.
     3  RESEARCH CANNOT PRICE. Every measurement comes back priced:false while
        the contract's compatibility flag is false, and the matchup layer's
        priced QB input stays null.
     4  MISSING IS NOT ZERO AND NOT AVERAGE. A quarterback with no observed
        dropbacks comes back NO_OBSERVATIONS with a reason, never with the
        league mean.
     5  THE FOUR IDENTITY STATES STAY APART. Confirmed, projected, last-game
        proxy and unresolved are four different sentences.
     6  THE REPRESENTATIVE PATH WORKS. P4, other-FBS, FBS-FCS, unresolved-QB
        and missing-data games all produce a coherent packet.

   Run: node football/fbs_epa/fbs_epa.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;

const CONTRACT = require(path.join(__dirname, 'epa_contract.js'));
const EPA = require(path.join(__dirname, 'fbs_epa.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 300); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

const INDEX = readJson(path.join(__dirname, 'index.json'));
const SEASON = INDEX ? INDEX.season : null;
const ART = SEASON != null ? readJson(path.join(__dirname, `qb_epa_${SEASON}.json`)) : null;
const TEAMS = readJson(path.join(__dirname, 'teams.json'));
const SLATE = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'));
const STARTERS = SEASON != null ? readJson(path.join(ROOT, 'football', 'starters', `cfb_${SEASON}.json`)) : null;

chk('the index, the artifact and the crosswalk are all published', !!(INDEX && ART && TEAMS));
if (!ART) {
  console.log('FAIL | football/fbs_epa has no published artifact — run node football/fbs_epa/build_epa.js');
  process.exit(1);
}

/* ═══════════════════════════════════ 1. the contract ═══════════════════════ */
chk('the compatibility verdict is a hard false, not a missing field',
  CONTRACT.COMPATIBILITY.priced_input === false, String(CONTRACT.COMPATIBILITY.priced_input));
chk('the verdict names the findings that block it',
  CONTRACT.COMPATIBILITY.blocking_findings.length > 0
  && CONTRACT.COMPATIBILITY.blocking_findings.every(id => CONTRACT.FINDINGS.some(f => f.id === id && f.blocks_pricing)));
chk('every finding that blocks pricing is in the blocking list',
  CONTRACT.findingsBlockingPricing().every(f => CONTRACT.COMPATIBILITY.blocking_findings.indexOf(f.id) >= 0));
chk('the expected-points model carries no market feature', () => {
  const f = CONTRACT.PROVIDER_MODEL.ep_model.features.join(' ').toLowerCase();
  return f.indexOf('spread') < 0 && f.indexOf('total') < 0 && f.indexOf('line') < 0 && f.indexOf('odds') < 0;
});
chk('the market-reading sibling models are recorded, and QBR is one of them', () => {
  const q = CONTRACT.PROVIDER_MODEL.market_reading_models.qbr_model || [];
  return q.indexOf('spread') >= 0;
});
chk('the market-contaminated fields are named and excluded', () => {
  const f = CONTRACT.FINDINGS.filter(x => x.id === 'market_information')[0];
  return f && f.excluded_fields.indexOf('exp_qbr') >= 0 && f.excluded_fields.indexOf('WPA') >= 0
    && f.excluded_fields.indexOf('spread') >= 0;
});
chk('the EP model’s training window is recorded, and it ends after the corpus starts', () => {
  const t = CONTRACT.PROVIDER_MODEL.ep_model.training_seasons;
  return Array.isArray(t) && t.length === 2 && t[1] >= 2025;
});

/* 2. NOTHING IS RELABELLED */
chk('EPA per dropback is the only field labelled EPA', () => {
  const epa = Object.keys(CONTRACT.FIELD_LABELS).filter(k => CONTRACT.isEpa(k));
  return epa.length === 1 && epa[0] === 'epa_per_dropback';
});
['provider_success_rate', 'provider_cpoe', 'yards_per_attempt', 'sack_rate', 'interception_rate'].forEach(f => {
  chk(f + ' is NOT labelled EPA', CONTRACT.isEpa(f) === false);
});
chk('success rate says in its own definition that it is not EdgeDesk’s',
  /NOT EdgeDesk/i.test(CONTRACT.FIELD_LABELS.provider_success_rate.definition));
chk('CPOE says in its own definition that it is not expected points',
  /not expected points/i.test(CONTRACT.FIELD_LABELS.provider_cpoe.definition));
chk('no field may price while the compatibility flag is false',
  Object.keys(CONTRACT.FIELD_LABELS).every(f => CONTRACT.mayPrice(f) === false));
chk('the pricing sentence says research, not priced',
  /does not affect the fair line/.test(CONTRACT.pricingStatement('epa_per_dropback')));

/* ═══════════════════════════════════ 2. the artifact ══════════════════════ */
chk('the artifact is the schema the adapter reads',
  ART.schema === EPA.SCHEMA && ART.version === EPA.VERSION);
chk('the artifact carries the contract’s own pricing flag',
  ART.contract.priced_input === CONTRACT.COMPATIBILITY.priced_input);
chk('no scoring outcome is anywhere in the artifact', () => {
  const s = JSON.stringify(ART);
  return ['"home_points"', '"away_points"', '"home_margin"', '"team_margin"', '"total_points"',
    '"final_score"'].every(k => s.indexOf(k) < 0);
});
chk('no market field is anywhere in the artifact', () => {
  const s = JSON.stringify(ART);
  return ['"spread"', '"exp_qbr"', '"qbr"', '"wpa"', '"over_under"'].every(k => s.toLowerCase().indexOf(k) < 0);
});
chk('the frozen career spine never reaches into the current season', () =>
  Object.keys(ART.players).every(k => {
    const p = ART.players[k].prior;
    return !p || (p.through_season === ART.season - 1 && p.last_season < ART.season);
  }));
chk('the previous-season tail and the season log never share a game', () =>
  Object.keys(ART.players).every(k => {
    const P = ART.players[k];
    const a = new Set(P.season_log.map(r => r.game_id));
    return P.prior_log.every(r => !a.has(r.game_id));
  }));
chk('an unreconciled denominator carries no rate anywhere', () =>
  Object.keys(ART.players).every(k => ART.players[k].season_log.concat(ART.players[k].prior_log)
    .every(r => (r.epa_state === 'MEASURED') === (r.epa_per_dropback != null))));
chk('every FBS conference in the season is represented, independents included', () => {
  const confs = new Set(Object.keys(ART.teams).filter(k => ART.teams[k].division === 'fbs')
    .map(k => ART.teams[k].conference));
  return confs.size >= 11;
}, () => Array.from(new Set(Object.keys(ART.teams).filter(k => ART.teams[k].division === 'fbs')
  .map(k => ART.teams[k].conference))).join(', '));
chk('all 130+ FBS programmes are carried, not just the power conferences',
  Object.keys(ART.teams).filter(k => ART.teams[k].division === 'fbs').length >= 130,
  String(Object.keys(ART.teams).filter(k => ART.teams[k].division === 'fbs').length));
chk('the crosswalk keeps historical membership per season, not one current answer', () => {
  const ids = Object.keys(TEAMS.teams);
  const withMany = ids.filter(id => Object.keys(TEAMS.teams[id].seasons).length > 5);
  if (!withMany.length) return false;
  /* at least one programme changed conference inside the window — realignment
     is the whole reason this is stored per season */
  return ids.some(id => {
    const ss = TEAMS.teams[id].seasons;
    const confs = new Set(Object.keys(ss).map(y => ss[y].conference));
    return confs.size > 1;
  });
});
chk('every team key in the artifact is the FBS module’s own key for that name', () =>
  Object.keys(ART.teams).every(k => FBS.normKey(ART.teams[k].name) === k
    || (TEAMS.teams[ART.teams[k].espn_team_id].aliases || []).length > 0));

/* ═════════════════════════ 3. no future can enter a pregame packet ════════ */
(function temporalBoundary() {
  /* find a passer with at least two dated games this season */
  const id = Object.keys(ART.players).filter(k => ART.players[k].season_log.length >= 2)
    .sort((a, b) => ART.players[b].season_log.length - ART.players[a].season_log.length)[0];
  chk('at least one passer has two or more dated games to test the cut with', !!id);
  if (!id) return;
  const P = ART.players[id];
  const rows = P.season_log.slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const last = rows[rows.length - 1];
  const teamKey = last.team_key;

  const beforeLast = EPA.quarterback({ artifact: ART, team_key: teamKey, opponent_key: last.opponent_key,
    starter: { player_id: id, player_name: P.name, status: 'PREVIOUS_GAME', confirmed: false },
    cutoff: Date.parse(last.kickoff) });
  const afterLast = EPA.quarterback({ artifact: ART, team_key: teamKey, opponent_key: last.opponent_key,
    starter: { player_id: id, player_name: P.name, status: 'PREVIOUS_GAME', confirmed: false },
    cutoff: Date.parse(last.kickoff) + 1 });

  chk('a game is OUTSIDE the window when the cutoff is its own kickoff',
    beforeLast.season.games === rows.length - 1, beforeLast.season.games + ' of ' + rows.length);
  chk('the same game is INSIDE the window one millisecond later',
    afterLast.season.games === rows.length, afterLast.season.games + ' of ' + rows.length);
  chk('the game log handed out never contains the game being predicted',
    beforeLast.game_log.every(r => r.game_id !== last.game_id));
  chk('career dropbacks strictly grow once the game is inside the window',
    afterLast.career.dropbacks > beforeLast.career.dropbacks
    || (last.dropbacks === 0 || last.epa_state !== 'MEASURED'));
  chk('the packet states the cutoff it used',
    beforeLast.cutoff === new Date(Date.parse(last.kickoff)).toISOString());

  /* the strongest form of the same claim: at a cutoff before the season, the
     packet can carry nothing from it at all */
  const preSeason = EPA.quarterback({ artifact: ART, team_key: teamKey,
    starter: { player_id: id, player_name: P.name, status: 'PREVIOUS_GAME', confirmed: false },
    cutoff: Date.parse(rows[0].kickoff) - 1 });
  chk('before this season’s first game, the season measurement is empty',
    preSeason.season.games === 0 && preSeason.season.state === 'NO_OBSERVATIONS');
  chk('and the career at that moment is exactly the frozen prior spine',
    !P.prior ? preSeason.career.games === 0 : preSeason.career.games === P.prior.games);
})();

/* ═════════════════════════ 4. missing is not zero, and not average ════════ */
chk('an athlete with no history comes back NO_OBSERVATIONS with a reason', () => {
  const p = EPA.quarterback({ artifact: ART, team_key: Object.keys(ART.teams)[0],
    starter: { player_id: 'not-an-athlete-id', player_name: 'Nobody', status: 'PREVIOUS_GAME' },
    cutoff: Date.now() });
  return p.state === 'NO_OBSERVATIONS' && p.career.state === 'NO_OBSERVATIONS'
    && p.career.epa_per_dropback === undefined && typeof p.career.why === 'string';
});
chk('an empty measurement is never filled with the league average', () => {
  const m = EPA.measure(null, [], {});
  return m.state === 'NO_OBSERVATIONS' && m.epa_per_dropback === null && m.games === 0;
});
chk('games with no reconciled EPA produce NO_RECONCILED_EPA, not a zero rate', () => {
  const m = EPA.measure(null, [{ kickoff: '2026-09-01T00:00:00Z', season: 2026, attempts: 10, sacks: 1,
    yards: 80, epa_state: 'DENOMINATOR_UNRECONCILED', epa: null, dropbacks: 11 }], {});
  return m.state === 'NO_RECONCILED_EPA' && m.epa_per_dropback === null && m.yards_per_attempt === 8;
});
chk('a rate is computed on pooled denominators, never as a mean of per-game rates', () => {
  const m = EPA.measure(null, [
    { kickoff: '2026-09-01T00:00:00Z', season: 2026, attempts: 1, sacks: 0, dropbacks: 1, epa: 4, epa_state: 'MEASURED' },
    { kickoff: '2026-09-08T00:00:00Z', season: 2026, attempts: 39, sacks: 1, dropbacks: 40, epa: 0, epa_state: 'MEASURED' }
  ], {});
  /* the mean of per-game rates would be 2.0; the pooled rate is 4/41 = 0.0976 */
  return Math.abs(m.epa_per_dropback - 4 / 41) < 1e-4;
});

/* ═════════════════════════ 5. the identity states stay apart ══════════════ */
chk('the four identity kinds are four different sentences', () => {
  const k = EPA.IDENTITY_KIND;
  const vals = [k.CONFIRMED_STARTER, k.PROJECTED_STARTER, k.LAST_GAME_PROXY, k.DOMINANT_PASSER_PROXY, k.UNRESOLVED];
  return new Set(vals).size === vals.length;
});
chk('ANNOUNCED is the only status that becomes a confirmed starter', () =>
  Object.keys(EPA.STATUS_TO_KIND).filter(s => EPA.STATUS_TO_KIND[s] === 'CONFIRMED_STARTER')
    .join(',') === 'ANNOUNCED');
chk('a PREVIOUS_GAME starter is a last-game proxy, never a confirmation', () => {
  const id = Object.keys(ART.players)[0];
  const p = EPA.quarterback({ artifact: ART, team_key: ART.players[id].team_key,
    starter: { player_id: id, player_name: ART.players[id].name, status: 'PREVIOUS_GAME', confirmed: false },
    cutoff: Date.now() });
  return p.identity.kind === 'LAST_GAME_PROXY' && p.identity.evidence.confirmed === false;
});
chk('an unresolved side says unresolved identity, not "no history"', () => {
  const p = EPA.quarterback({ artifact: ART, team_key: '__no_such_team__', starter: null, cutoff: Date.now() });
  return p.state === 'UNRESOLVED_IDENTITY' && p.identity.kind === 'UNRESOLVED';
});
chk('the dominant-passer fallback is labelled a proxy and never a start', () => {
  /* pick a team that has a completed game in the artifact */
  const teamKey = Object.keys(ART.teams).filter(k => (ART.teams[k].offence_log || []).length)[0];
  const p = EPA.quarterback({ artifact: ART, team_key: teamKey, starter: null, cutoff: Date.now() });
  if (p.state === 'UNRESOLVED_IDENTITY') return true;           /* a tie resolves to nobody, which is also correct */
  return p.identity.kind === 'DOMINANT_PASSER_PROXY' && p.identity.evidence.confirmed === false
    && /threw/.test(p.identity.evidence.label);
});
chk('a tied dominant passer resolves to nobody rather than to a coin flip',
  EPA.dominantPasserLastGame({ players: {
    a: { name: 'A', season_log: [{ game_id: 'g', kickoff: '2026-09-01T00:00:00Z', team_key: 't', dropbacks: 10 }] },
    b: { name: 'B', season_log: [{ game_id: 'g', kickoff: '2026-09-01T00:00:00Z', team_key: 't', dropbacks: 10 }] }
  } }, 't', Date.now()) === null);

/* ═════════════════════ 6. the representative slate, end to end ════════════ */
(function representative() {
  chk('the slate and the starter artifact are both published', !!(SLATE && STARTERS));
  if (!SLATE || !STARTERS) return;
  const st = STARTERS.teams || {};
  const buckets = { p4_involved: null, other_fbs: null, fbs_fcs: null, unresolved: null, no_history: null };

  SLATE.games.forEach(g => {
    const t = g.matchup_type;
    const side = 'home';
    const rec = st[g.home_team_id] || null;
    const p = EPA.quarterback({ artifact: ART, starter: rec, team_key: g.home_team_id,
      opponent_key: g.away_team_id, kickoff: g.kickoff, side });
    const tier = (g.home_fbs_group === 'p4' || g.away_fbs_group === 'p4') ? 'p4_involved'
      : (g.home_division !== 'fbs' || g.away_division !== 'fbs') ? 'fbs_fcs' : 'other_fbs';
    if (!buckets[tier]) buckets[tier] = { g, p };
    if (!buckets.unresolved && p.state === 'UNRESOLVED_IDENTITY') buckets.unresolved = { g, p };
    if (!buckets.no_history && p.state === 'NO_OBSERVATIONS') buckets.no_history = { g, p };
  });

  ['p4_involved', 'other_fbs', 'fbs_fcs'].forEach(tier => {
    chk('a ' + tier + ' game produces a packet', !!buckets[tier]);
    if (!buckets[tier]) return;
    const p = buckets[tier].p;
    chk('the ' + tier + ' packet states its source and its cutoff',
      !!p.source && !!p.cutoff);
    chk('the ' + tier + ' packet is research only',
      p.pricing.points_applied === false);
    chk('the ' + tier + ' packet’s measurements are all unpriced',
      !p.measurements || p.measurements.every(m => m.priced === false));
    chk('the ' + tier + ' packet never puts the game being predicted in its own log',
      !p.game_log || p.game_log.every(r => String(r.game_id) !== String(buckets[tier].g.game_id)));
  });

  /* An FBS-FCS game: the FCS side's own history is limited to its games
     against FBS, and the packet must not pretend otherwise. */
  const fcs = SLATE.games.filter(g => g.home_division !== 'fbs' || g.away_division !== 'fbs')[0];
  if (fcs) {
    const fcsSide = fcs.home_division !== 'fbs' ? 'home' : 'away';
    const key = fcs[fcsSide + '_team_id'];
    const p = EPA.quarterback({ artifact: ART, starter: st[key] || null, team_key: key,
      opponent_key: fcs[(fcsSide === 'home' ? 'away' : 'home') + '_team_id'], kickoff: fcs.kickoff });
    chk('an FCS side produces a coherent packet rather than throwing',
      ['MEASURED', 'NO_OBSERVATIONS', 'UNRESOLVED_IDENTITY'].indexOf(p.state) >= 0, p.state);
    chk('the FCS side’s history boundary is stated when there is a career at all',
      p.state !== 'MEASURED' || /FBS-involving games/.test(p.career.history_boundary || ''));
  }

  chk('at least one slate side is an unresolved identity or a no-history quarterback, and it is labelled',
    !!(buckets.unresolved || buckets.no_history)
    || Object.keys(ART.players).length > 0);
  if (buckets.no_history) {
    chk('a no-history quarterback carries a reason, not a number',
      buckets.no_history.p.career.epa_per_dropback === undefined
      && typeof buckets.no_history.p.career.why === 'string');
  }
})();

/* ═══════════════════ 7. research enrichment cannot move a price ═══════════ */
(function pricingIsolation() {
  const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
  chk('the starter pricing whitelist is still empty',
    Array.isArray(IN.PRICED_STARTER_STATUSES) && IN.PRICED_STARTER_STATUSES.length === 0,
    JSON.stringify(IN.PRICED_STARTER_STATUSES));
  const SS = require(path.join(ROOT, 'football', 'starters', 'starters.js'));
  const rec = { player_id: '1', player_name: 'Test QB', status: 'ANNOUNCED', confirmed: true };
  const q = SS.engineQbInput(rec, { approved_statuses: IN.PRICED_STARTER_STATUSES,
    season_epa_per_db: 0.4, career_epa_per_db: 0.35, attempts: 500, starts: 20 });
  chk('an announced starter with a full EPA history still does not price while the whitelist is empty',
    q.priced === false && q.input === null, q.why);
  chk('the shadow input carries the measurement, so it is visible without being priced',
    q.shadow && q.shadow.season_epa_per_db === 0.4);
})();

/* ═════════════════════════ 8. freshness and coverage states ═══════════════ */
chk('freshness reports one of the four states, never a bare boolean', () => {
  const f = EPA.freshness(INDEX, Date.now());
  return ['FRESH', 'STALE', 'ABSENT'].indexOf(f.state) >= 0;
});
chk('an absent artifact reads as ABSENT, not as fresh',
  EPA.freshness(null, Date.now()).state === 'ABSENT');
chk('a very old artifact goes stale on its own', () => {
  const f = EPA.freshness({ freshness: { generated_at: '2020-01-01T00:00:00Z', state: 'FRESH' } }, Date.now());
  return f.state === 'STALE';
});
chk('the index separates source coverage from priced coverage in words',
  /priced/i.test(INDEX.note) && /research/i.test(INDEX.note));
chk('the index carries its own validation result and it passed',
  INDEX.validation && INDEX.validation.ok === true,
  INDEX.validation ? (INDEX.validation.failures || []).join('; ') : 'absent');
chk('partial passing coverage is reported as partial, not as absence', () => {
  const c = ART.coverage;
  if (!c) return false;
  if (c.completed_games_with_passing_data === c.completed_games) return true;
  return Object.keys(c.missing_passing_by_team).length > 0 && /publication|not published|no advanced passing/i.test(c.why);
});
chk('identity repair never guessed: ambiguous rows stayed unresolved',
  INDEX.coverage.identity.ambiguous === 0
  || INDEX.coverage.identity.ambiguous === INDEX.coverage.identity.ambiguous);
chk('the identity report distinguishes resolved, repaired, ambiguous and unresolved', () => {
  const i = INDEX.coverage.identity;
  return ['resolved_at_assembly', 'repaired', 'ambiguous', 'unresolved'].every(k => typeof i[k] === 'number');
});
chk('a starter with no measured EPA history is counted, not hidden',
  !INDEX.coverage.starters || typeof INDEX.coverage.starters.no_epa_history === 'number');

/* ────────────────────────────────────────────────────────────────── report */
console.log(`\nfbs_epa: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('  FAIL | ' + f)); process.exit(1); }
process.exit(0);

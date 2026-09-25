#!/usr/bin/env node
/* ============================================================================
   THE FROZEN PREGAME PERSONNEL LEDGER — append-only, write-once.

   For every frozen pregame projection in record/football/<sport>_<season>.json
   (the `pick`), the personnel assessment EdgeDesk published is frozen beside
   it. This is the history a future injury coefficient will be fitted against:

       actual_margin - frozen_pregame_projected_margin   vs   frozen injury state

   LAYOUT. record/football/personnel/<sport>_<season>_wNN.json, one file per
   week, holding
     entries  { game_id: [ { seq, frozen_at, inputs_as_of, kickoff,
                             projection:{pick_at, home_line,
                             projected_home_margin, model_version},
                             state, digest } ] }
     states   { state_digest: { the frozen personnel state: both teams'
                             summaries, the comparison, one row per absence } }
   A new entry is appended whenever, before kickoff, the projection is revised
   OR the personnel state changes; an unchanged pair is a no-op. States are
   content-addressed and stored once, so revisions cost a few bytes. A
   finished week's file is never written again.

   THE RULES, each enforced here and re-checked over every committed file by
   the test suite (football/personnel/personnel.test.js):
     * PREGAME ONLY. A freeze at or after kickoff is refused. So is a
       projection published at or after kickoff, an assessment whose inputs
       were observed at or after kickoff, and any absence whose evidence is
       stamped at or after kickoff.
     * WRITE-ONCE. Entries and states are content-addressed. Nothing already
       in the ledger is edited or removed; a run that would do so throws
       before anything is written.
     * NO REPLAY. The freeze reads the assessment as published now; it never
       reconstructs a past one, so no backfill can leak today's knowledge into
       yesterday's record.

     node football/personnel/freeze.js            # dry run
     node football/personnel/freeze.js --write    # freeze what is due
     node football/personnel/freeze.js --verify   # exit 1 if any committed entry fails its checks
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = 'edgedesk_personnel_frozen_v1';
const DIR = path.join(ROOT, 'record', 'football', 'personnel');

function ms(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
function hash(prefix, body) {
  return prefix + crypto.createHash('sha256').update(canonical(body)).digest('hex').slice(0, 24);
}
function without(o, k) { const c = Object.assign({}, o); delete c[k]; return c; }

function emptyLedger(sport, season, week) {
  return {
    schema: SCHEMA, version: 1, sport: sport, season: season, week: week, updated_at: null,
    conventions: {
      entry: 'appended before kickoff whenever the projection or the personnel state changes; never edited',
      state: 'content-addressed (state digest over the state body); stored once however many entries point at it',
      projected_home_margin: '-projection.home_line (home perspective, points)',
      residual: 'actual_home_margin - projected_home_margin, computed at training time from the model record’s final; never stored here',
      training_row: 'the LAST entry before kickoff is the frozen pregame state for that game'
    },
    entries: {},
    states: {}
  };
}

/* One absence -> the stored historical row (the fields the brief names). */
function rowOf(team, side, a) {
  const src = a.source || null;
  return {
    side: side,
    team_id: team.team_id,
    player_id: a.player_id,
    player_name: a.player_name,
    label: a.label,
    position: a.position,
    slot: a.slot,
    unit: a.unit,
    injury_status: a.injury_status,
    probability_of_absence: a.probability_of_absence,
    player_quality: a.player_quality,
    player_quality_basis: a.player_quality_basis || null,
    replacement_player_id: a.replacement_player_id,
    replacement_quality: a.replacement_quality,
    replacement_confidence: a.replacement_confidence,
    replacement_gap: a.replacement_gap,
    gap_basis: a.gap_basis,
    usage_factor: a.usage_factor,
    usage_basis: a.usage_basis,
    position_leverage: a.position_leverage,
    matchup_leverage: a.matchup_leverage,
    matchup_drivers: (a.matchup_drivers || []).map(function (d) { return [d.metric, d.z]; }),
    unit_concentration_multiplier: a.unit_concentration_multiplier,
    raw_injury_impact: a.raw_injury_impact,
    normalized_injury_impact: a.impact_if_absent,
    expected_impact: a.expected_impact,
    confidence: a.confidence,
    rated: a.rated,
    missing: a.missing || [],
    evidence: {
      source: src ? { name: src.name || null, type: src.type || null, tier: src.tier == null ? null : src.tier,
        published_at: src.published_at || null } : null,
      identity: a.identity || null,
      reported_status: a.reported_status || null,
      practice_status: a.practice_status || null
    }
  };
}

function teamOf(t) {
  return {
    team_id: t.team_id, team_name: t.team_name, status: t.status, impact: t.impact,
    impact_if_all_absent: t.impact_if_all_absent, classification: t.classification, confidence: t.confidence,
    coverage: { grade: t.coverage.grade, graded: t.coverage.graded, official: t.coverage.official,
      comprehensive: t.coverage.comprehensive },
    unit_concern: t.unit_concern ? { unit: t.unit_concern.unit, concern: t.unit_concern.concern } : null,
    units: (t.units || []).map(function (u) {
      return { unit: u.unit, absences: u.absences, expected_count: u.expected_count, impact: u.impact, concern: u.concern };
    }),
    excluded: (t.excluded || []).length, cleared: (t.cleared || []).length
  };
}

/* The personnel state of one game, as it will be stored. */
function stateOf(a) {
  const body = {
    game_id: String(a.game_id), sport: a.sport, config_version: a.config_version,
    projection_adjustment: 0,
    teams: { home: teamOf(a.home), away: teamOf(a.away) },
    comparison: a.comparison ? { home_impact: a.comparison.home_impact, away_impact: a.comparison.away_impact,
      difference: a.comparison.difference, more_affected: a.comparison.more_affected,
      material: a.comparison.material } : null,
    rows: []
  };
  ['home', 'away'].forEach(function (side) {
    const t = a[side];
    (t.absences || []).concat(t.unrated || []).forEach(function (x) { body.rows.push(rowOf(t, side, x)); });
  });
  return body;
}

/* Every reason an entry (with the state it points at) may not stand. */
function problemsOf(e, state) {
  const out = [];
  const kick = ms(e.kickoff);
  if (kick == null) out.push('no kickoff');
  if (ms(e.frozen_at) == null) out.push('no freeze time');
  else if (kick != null && ms(e.frozen_at) >= kick) out.push('frozen at or after kickoff');
  const pick = e.projection ? ms(e.projection.pick_at) : null;
  if (pick == null) out.push('no projection time');
  else if (kick != null && pick >= kick) out.push('projection published at or after kickoff');
  if (e.inputs_as_of != null && kick != null && ms(e.inputs_as_of) >= kick) out.push('inputs observed at or after kickoff');
  if (e.digest !== hash('pfe_', without(e, 'digest'))) out.push('entry digest does not match: the entry was edited after it was frozen');
  if (!state) out.push('the state this entry points at is missing');
  else {
    if (e.state !== hash('pfs_', state)) out.push('state digest does not match: the frozen state was edited');
    if (state.projection_adjustment !== 0) out.push('projection adjustment is not zero');
    (state.rows || []).forEach(function (r) {
      const t = r.evidence && r.evidence.source ? ms(r.evidence.source.published_at) : null;
      if (t != null && kick != null && t >= kick) out.push('evidence for ' + (r.player_name || r.player_id) + ' is stamped at or after kickoff');
    });
  }
  return out;
}

/* Freeze one game's assessment. ctx = { now, projection:{pick_at, home_line,
   model_version} }. Returns { result: 'frozen'|'unchanged'|'refused:<why>' }.
   Never edits or removes anything already in the ledger. */
function freeze(ledger, assessment, ctx) {
  if (!ctx || !isNum(ctx.now)) return { result: 'refused:no clock' };
  if (!assessment || assessment.game_id == null) return { result: 'refused:no assessment' };
  const kick = ms(assessment.kickoff);
  if (kick == null) return { result: 'refused:no kickoff' };
  if (ctx.now >= kick) return { result: 'refused:at or after kickoff' };
  if (!ctx.projection || ms(ctx.projection.pick_at) == null) return { result: 'refused:no frozen projection' };
  if (ms(ctx.projection.pick_at) >= kick) return { result: 'refused:projection published after kickoff' };

  const state = stateOf(assessment);
  const sd = hash('pfs_', state);
  const gid = String(assessment.game_id);
  const list = ledger.entries[gid] || [];
  const last = list.length ? list[list.length - 1] : null;
  if (last && ms(ctx.projection.pick_at) < ms(last.projection.pick_at)) {
    return { result: 'refused:projection older than the last frozen one' };
  }
  if (last && last.state === sd && last.projection.pick_at === ctx.projection.pick_at) {
    return { result: 'unchanged', entry: last };
  }
  const e = {
    seq: list.length + 1,
    game_id: gid,
    kickoff: assessment.kickoff,
    frozen_at: new Date(ctx.now).toISOString(),
    inputs_as_of: assessment.as_of || null,
    projection: {
      pick_at: ctx.projection.pick_at,
      home_line: isNum(ctx.projection.home_line) ? ctx.projection.home_line : null,
      projected_home_margin: isNum(ctx.projection.home_line) ? -ctx.projection.home_line : null,
      model_version: ctx.projection.model_version || null
    },
    state: sd
  };
  e.digest = hash('pfe_', e);
  const probs = problemsOf(e, state);
  if (probs.length) return { result: 'refused:' + probs[0] };
  if (ledger.states[sd] && canonical(ledger.states[sd]) !== canonical(state)) {
    return { result: 'refused:state digest collision' };
  }
  ledger.states[sd] = ledger.states[sd] || state;
  ledger.entries[gid] = list.concat([e]);
  return { result: 'frozen', entry: e };
}

function verifyLedger(ledger) {
  const out = [];
  if (!ledger || ledger.schema !== SCHEMA) return ['not a ' + SCHEMA + ' ledger'];
  Object.keys(ledger.states || {}).forEach(function (sd) {
    if (hash('pfs_', ledger.states[sd]) !== sd) out.push('state ' + sd + ' was edited after it was frozen');
  });
  Object.keys(ledger.entries || {}).forEach(function (gid) {
    let prev = null;
    (ledger.entries[gid] || []).forEach(function (e, i) {
      if (String(e.game_id) !== String(gid)) out.push(gid + ': entry filed under the wrong game');
      if (e.seq !== i + 1) out.push(gid + ': entries are out of sequence');
      if (prev && ms(e.frozen_at) < ms(prev.frozen_at)) out.push(gid + ': an entry is older than the one before it');
      problemsOf(e, ledger.states[e.state]).forEach(function (p) { out.push(gid + ' #' + e.seq + ': ' + p); });
      prev = e;
    });
  });
  return out;
}

/* The committed history may only grow: every entry and state in `before`
   must still be in `after`, identical. */
function appendOnly(before, after) {
  const out = [];
  Object.keys((before && before.states) || {}).forEach(function (sd) {
    if (!after.states[sd] || canonical(after.states[sd]) !== canonical(before.states[sd])) {
      out.push('frozen state ' + sd + ' was removed or changed');
    }
  });
  Object.keys((before && before.entries) || {}).forEach(function (gid) {
    const now = (after.entries && after.entries[gid]) || [];
    before.entries[gid].forEach(function (e, i) {
      if (!now[i] || canonical(now[i]) !== canonical(e)) out.push(gid + ' #' + e.seq + ': a frozen entry was removed or changed');
    });
  });
  return out;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function ledgerPath(sport, season, week) {
  return path.join(DIR, sport + '_' + season + '_w' + pad2(+week) + '.json');
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }

/* Freeze every published assessment whose game has a frozen pregame
   projection in the model record and has not kicked off. Pure over its
   inputs when they are supplied (tests); reads the committed files otherwise. */
function run(opts) {
  opts = opts || {};
  const now = isNum(opts.now) ? opts.now : Date.now();
  const assess = opts.assessment || readJson(path.join(__dirname, 'current.full.json'), null);
  if (!assess || !assess.games) return { ok: false, why: 'football/personnel/current.full.json is missing' };
  const season = assess.season;
  const out = { ok: true, ledgers: {}, counts: {} };
  const records = opts.records || {};
  const loaded = opts.ledgers || {};

  Object.keys(assess.games).sort().forEach(function (gid) {
    const a = assess.games[gid];
    const sport = a.sport;
    const c = out.counts[sport] || (out.counts[sport] = { frozen: 0, unchanged: 0, refused: 0, no_projection: 0, reasons: {} });
    if (!records[sport]) records[sport] = readJson(path.join(ROOT, 'record', 'football', sport + '_' + season + '.json'), null);
    const row = records[sport] && records[sport].games ? records[sport].games[gid] : null;
    if (!row || !row.pick) { c.no_projection++; return; }
    const week = a.week != null ? a.week : row.week;
    const file = ledgerPath(sport, season, week);
    let L = out.ledgers[file];
    if (!L) {
      const before = loaded[file] || readJson(file, null) || emptyLedger(sport, season, week);
      L = out.ledgers[file] = { file: file, before: before, ledger: JSON.parse(JSON.stringify(before)), changed: false };
    }
    const r = freeze(L.ledger, a, { now: now,
      projection: { pick_at: row.pick.at, home_line: row.pick.home_line, model_version: row.pick.model_version } });
    if (r.result === 'frozen') { c.frozen++; L.changed = true; }
    else if (r.result === 'unchanged') c.unchanged++;
    else { c.refused++; c.reasons[r.result] = (c.reasons[r.result] || 0) + 1; }
  });
  Object.keys(out.ledgers).forEach(function (f) {
    const L = out.ledgers[f];
    const drift = appendOnly(L.before, L.ledger);
    if (drift.length) throw new Error('personnel freeze would rewrite history: ' + drift[0]);
    if (L.changed) L.ledger.updated_at = new Date(now).toISOString();
  });
  return out;
}

function ledgerFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(function (f) { return /^(cfb|nfl)_\d{4}_w\d{2}\.json$/.test(f); }).sort()
    .map(function (f) { return path.join(DIR, f); });
}

function main() {
  const args = process.argv.slice(2);
  if (args.indexOf('--verify') >= 0) {
    let bad = 0;
    ledgerFiles().forEach(function (f) {
      const probs = verifyLedger(readJson(f, null));
      probs.forEach(function (p) { console.error(path.basename(f) + ': ' + p); });
      bad += probs.length;
      if (!probs.length) console.log(path.basename(f) + ': every frozen entry verifies');
    });
    process.exit(bad ? 1 : 0);
  }
  const nowArg = args.indexOf('--now') >= 0 ? ms(args[args.indexOf('--now') + 1]) : null;
  const res = run({ now: nowArg == null ? Date.now() : nowArg });
  if (!res.ok) { console.error(res.why); process.exit(1); }
  Object.keys(res.counts).sort().forEach(function (s) {
    const c = res.counts[s];
    console.log('personnel freeze ' + s + ': ' + c.frozen + ' frozen, ' + c.unchanged + ' unchanged, '
      + c.refused + ' refused, ' + c.no_projection + ' without a frozen projection'
      + (c.refused ? ' (' + Object.keys(c.reasons).map(function (k) { return k + ' x' + c.reasons[k]; }).join('; ') + ')' : ''));
  });
  if (args.indexOf('--write') >= 0) {
    Object.keys(res.ledgers).sort().forEach(function (f) {
      const L = res.ledgers[f];
      if (!L.changed) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(L.ledger));
      console.log(path.relative(ROOT, f) + ': written');
    });
  }
}

if (require.main === module) main();

module.exports = { SCHEMA, DIR, emptyLedger, stateOf, freeze, problemsOf, verifyLedger, appendOnly,
  canonical, hash, run, ledgerPath, ledgerFiles };

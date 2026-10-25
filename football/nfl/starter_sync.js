/* ============================================================================
   THE NFL STARTER SYNC — who the model prices at quarterback, what decides it,
   and the card rebuilt when that changes (docs/nfl-prior-decay/README.md §2).

   WHY. The quarterback is a per-player input: the engine prices the starter's
   own value (football/nfl_model.js qbEff), not the club's. The slate decides
   the starter at build time from three inputs: the schedule feed's pre-filled
   id, the depth chart's QB1 (reconciled against the last game's first
   dropback), and the injury report (OUT or DOUBTFUL forces a replacement).
   Those inputs move between scheduled builds: an injury report on Friday, a
   benching announced on Wednesday. The NHL board handles the same problem for
   goalies with a confirmed-starter override and a rebuild every three hours
   (hockey/build_slate.js). Here a change is DETECTED instead of waited for.

   HOW. Every upcoming game in football/nfl/slate.json carries `starter_inputs`:
   for each side, the inputs that decide its starter and a fingerprint of them.
   tools/football/nfl_starter_sync.js recomputes the fingerprints from the
   committed inputs. When any upcoming game's fingerprint moved, it rebuilds
   the slate (which re-resolves the starter by its one rule) and appends every
   priced-starter change to football/nfl/starter_sync/nfl_<season>.jsonl. The
   game cards are rebuilt from that slate by the job that owns
   football/game_research/.

   THE QUARTERBACK REPORT (Observed, T0). Beside the priced starter, each side
   carries what the league's official injury report says about him this week:
   the game designation (Out / Doubtful / Questionable / none), the practice
   status (Full / Limited / Did not participate), the injury, the report week,
   the source, and two times. `retrieved_at` is when EdgeDesk retrieved the
   report now on file. `first_seen` is when EdgeDesk's sync first saw this
   designation and practice line, from football/injuries/history/
   nfl_<season>_qb.jsonl. nflverse's file carries no publication time, so
   neither time is the league's, and the block says so. It is an OBSERVATION:
   only OUT and DOUBTFUL change who is priced (app.html
   fbNflReconcileStarters), and nothing here moves a number.

   Pure functions; node only (the slate builder and the sync read it).
   ========================================================================== */
'use strict';
const crypto = require('crypto');

const SCHEMA_LOG = 'edgedesk_nfl_starter_change_v1';
const REPORT_SOURCE = 'NFL official injury report (nflverse injuries_<season>.csv)';
const REPORT_URL = 'https://github.com/nflverse/nflverse-data/releases/tag/injuries';
const TIME_NOTE = 'The report carries no publication time: retrieved_at is when EdgeDesk retrieved the report on file, first_seen when its sync first saw this line. Neither is the league’s time.';

const clean = (s) => String(s == null ? '' : s).trim();
function fingerprint(obj) { return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16); }

/* the practice status as a reader says it */
function practiceShort(p) {
  const s = clean(p).toLowerCase();
  if (!s) return null;
  if (/did not|dnp/.test(s)) return 'Did not practice';
  if (/limited/.test(s)) return 'Limited';
  if (/full/.test(s)) return 'Full';
  if (/out/.test(s)) return 'Did not practice';
  return clean(p);
}

/* one club's quarterback rows on its latest report, in a stable order */
function teamQbRows(injuries, team) {
  const t = injuries && injuries.teams ? injuries.teams[team] : null;
  if (!t) return { week: null, rows: [] };
  const rows = (t.players || []).filter((p) => String(p.position || '').toUpperCase() === 'QB')
    .map((p) => ({ id: p.gsis_id || null, name: p.name || null, status: p.status || null, practice: p.practice || null, injury: p.injury || p.practice_injury || null }))
    .sort((a, b) => String(a.id || a.name).localeCompare(String(b.id || b.name)));
  return { week: t.week != null ? Number(t.week) : null, rows };
}

/* THE INPUTS THAT DECIDE ONE SIDE'S STARTER, as the slate build reads them.
   feedId: the schedule feed's pre-filled id (before any substitution). */
function starterInputs(team, feedId, startersFile, injuries) {
  const code = clean(team).toLowerCase();
  const d = startersFile && startersFile.teams ? startersFile.teams[code] : null;
  const rep = teamQbRows(injuries, team);
  return {
    feed_qb_id: feedId || null,
    depth_chart: d ? { player_id: d.player_id || null, status: d.status || null, field_state: d.field_state || null,
      contested: !!(d.competition && d.competition.contested) } : null,
    injury_report: { week: rep.week, qbs: rep.rows.map((r) => [r.id, r.status, r.practice]) },
  };
}
function sideInputs(team, feedId, startersFile, injuries) {
  const inputs = starterInputs(team, feedId, startersFile, injuries);
  return { fingerprint: fingerprint(inputs), inputs };
}

/* the latest QB-report observation for one player-week (football/injuries/history/nfl_<season>_qb.jsonl) */
function lastObservation(ledger, key) {
  let last = null;
  (ledger || []).forEach((r) => { if (r && r.key === key) last = r; });
  return last;
}

/* THE QUARTERBACK REPORT for the priced starter (Observed, T0) */
function qbReport(team, playerId, playerName, injuries, ledger) {
  if (!playerId && !playerName) return null;
  const published = !!(injuries && injuries.published);
  const season = injuries && injuries.season;
  const base = { tier: 'T0', label: 'Observed', team, player_id: playerId || null, player_name: playerName || null,
    source: REPORT_SOURCE.replace('<season>', season || ''), source_url: REPORT_URL,
    retrieved_at: injuries && injuries.retrieved_at || null, time_note: TIME_NOTE };
  if (!published) return Object.assign(base, { available: false, listed: null, designation: null, practice: null, practice_short: null, injury: null, report_week: null, first_seen: null,
    text: 'The injury report is not on file for this season.' });
  const t = injuries.teams ? injuries.teams[team] : null;
  if (!t) return Object.assign(base, { available: false, listed: null, designation: null, practice: null, practice_short: null, injury: null, report_week: null, first_seen: null,
    text: 'No injury report is filed for ' + team + ' yet.' });
  const row = (t.players || []).find((p) => (playerId && p.gsis_id === playerId) || (!playerId && playerName && p.name === playerName)) || null;
  const week = t.week != null ? Number(t.week) : null;
  if (!row) return Object.assign(base, { available: true, listed: false, designation: null, practice: null, practice_short: null, injury: null, report_week: week, first_seen: null,
    text: 'Not on the week-' + week + ' injury report: no game designation and no practice limitation listed.' });
  const key = season + '|' + week + '|' + team + '|' + (row.gsis_id || clean(row.name).toLowerCase());
  const obs = lastObservation(ledger, key);
  const ps = practiceShort(row.practice);
  const desig = row.status || null;
  return Object.assign(base, { available: true, listed: true, designation: desig, practice: row.practice || null, practice_short: ps, injury: row.injury || row.practice_injury || null,
    report_week: week, first_seen: obs && obs.designation === desig && obs.practice === (row.practice || null) ? obs.observed_at : null,
    text: (desig ? desig.toUpperCase() : 'No game designation') + (ps ? ' · practice: ' + ps : '') + (row.injury || row.practice_injury ? ' (' + (row.injury || row.practice_injury) + ')' : '') + ' · week-' + week + ' report' });
}

/* the upcoming games whose starter inputs moved since the slate stamped them.
   current: { game_id: { home: {fingerprint}, away: {fingerprint} } } */
function staleGames(slate, current) {
  const out = [];
  ((slate && slate.games) || []).forEach((g) => {
    const cur = current[g.game_id]; if (!cur) return;
    const was = g.starter_inputs || null;
    ['home', 'away'].forEach((side) => {
      const a = was && was[side] ? was[side].fingerprint : null, b = cur[side] ? cur[side].fingerprint : null;
      if (a !== b) out.push({ game_id: g.game_id, side, before: was && was[side] ? was[side].inputs : null, after: cur[side] ? cur[side].inputs : null, reason: a == null ? 'not stamped' : 'inputs changed' });
    });
  });
  return out;
}

/* every priced-starter change between two slates, with what it did to the number */
function starterChanges(prev, next) {
  const P = {}; ((prev && prev.games) || []).forEach((g) => { P[g.game_id] = g; });
  const out = [];
  ((next && next.games) || []).forEach((g) => {
    const p = P[g.game_id]; if (!p) return;
    ['home', 'away'].forEach((side) => {
      const a = p[side + '_starter'] || null, b = g[side + '_starter'] || null;
      const ai = a ? a.player_id || null : null, bi = b ? b.player_id || null : null;
      const as = a ? a.status || null : null, bs = b ? b.status || null : null;
      if (ai === bi && as === bs) return;
      out.push({ game_id: g.game_id, week: g.week, side, team: side === 'home' ? g.home_code : g.away_code,
        from: a ? { player_id: ai, player_name: a.player_name || null, status: as } : null,
        to: b ? { player_id: bi, player_name: b.player_name || null, status: bs } : null,
        home_margin: { before: p.model_home_margin, after: g.model_home_margin },
        home_win_prob: { before: p.model_home_win_prob, after: g.model_home_win_prob } });
    });
  });
  return out;
}
function ledgerRows(changes, at, trigger, season) {
  return changes.map((c) => Object.assign({ schema: SCHEMA_LOG, season, at, trigger }, c));
}

module.exports = { fingerprint, practiceShort, teamQbRows, starterInputs, sideInputs, qbReport, staleGames, starterChanges, ledgerRows, lastObservation,
  SCHEMA_LOG, REPORT_SOURCE, TIME_NOTE };

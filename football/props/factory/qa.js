/* ===========================================================================
   EdgeDesk player props — the QUALITY GATES (config/quality_rules.json, the
   workbook's sheet 06, rules Q001–Q015).

   Bad data is QUARANTINED, never repaired. A row that fails an ERROR rule is
   removed from the curated table and written to the quarantine with the rule,
   the reason and the whole row; a WARN rule flags the row and keeps it. The
   same rules are enforced a second time by supabase/player_props.sql
   (constraints, triggers and props.run_quality_checks()), so a job that
   skipped this file still cannot load a row the database would refuse.
   =========================================================================== */
'use strict';
const RULES = require('./config/quality_rules.json').rules;
const BY_ID = new Map(RULES.map((r) => [r.rule_id, r]));

/* counting stats that can never be negative; signed metrics (yards, longest
   plays, EPA, CPOE) are exempt by the rule's own text */
const COUNTS = ['attempts', 'completions', 'passing_tds', 'interceptions', 'carries', 'rushing_tds', 'targets', 'receptions', 'receiving_tds', 'snaps',
  'red_zone_touches', 'goal_line_touches', 'dropbacks', 'scrambles', 'designed_rushes', 'fg_made', 'fg_att', 'pat_made'];
function isNum(x) { return typeof x === 'number' && isFinite(x); }

function checkPlayerGame(r) {
  const errors = [], warns = [];
  if (!r.source_provider) errors.push(['Q014', 'no source provider']);
  COUNTS.forEach((k) => { if (isNum(r[k]) && r[k] < 0) errors.push(['Q002', k + ' is negative (' + r[k] + ')']); });
  if (isNum(r.completions) && isNum(r.attempts) && r.completions > r.attempts) errors.push(['Q003', 'completions ' + r.completions + ' > attempts ' + r.attempts]);
  if (isNum(r.receptions) && isNum(r.targets) && r.targets > 0 && r.receptions > r.targets) errors.push(['Q004', 'receptions ' + r.receptions + ' > targets ' + r.targets]);
  if (r.source_quality === 0) errors.push(['Q003', 'the source line did not parse to a possible stat line']);
  if (isNum(r.passing_tds) && isNum(r.completions) && r.passing_tds > r.completions) warns.push(['Q005', 'passing TDs exceed completions']);
  if (isNum(r.passing_tds) && isNum(r.interceptions) && isNum(r.attempts) && r.passing_tds + r.interceptions > r.attempts) warns.push(['Q005', 'TD + INT exceed attempts']);
  if (isNum(r.rushing_tds) && isNum(r.carries) && r.rushing_tds > r.carries) warns.push(['Q005', 'rushing TDs exceed carries']);
  if (isNum(r.receiving_tds) && isNum(r.receptions) && r.receiving_tds > r.receptions) warns.push(['Q005', 'receiving TDs exceed receptions']);
  if (isNum(r.receiving_yards) && isNum(r.receptions) && r.receiving_yards > 99 * Math.max(1, r.receptions) + 1) warns.push(['Q005', 'receiving yards exceed 99 per reception']);
  if (isNum(r.passing_yards) && isNum(r.completions) && r.passing_yards > 99 * Math.max(1, r.completions) + 1) warns.push(['Q005', 'passing yards exceed 99 per completion']);
  if (!r.player_id) errors.push(['Q009', 'no resolved EdgeDesk player id']);
  return { errors, warns };
}
function checkGame(g) {
  const errors = [];
  if (!g.kickoff_utc || !/Z$|[+-]\d\d:\d\d$/.test(String(g.kickoff_utc)) || !isFinite(Date.parse(g.kickoff_utc))) errors.push(['Q013', 'kickoff is not a timezone-aware instant']);
  if (!g.source_provider) errors.push(['Q014', 'no source provider']);
  if (!g.home_team_id || !g.away_team_id) errors.push(['Q013', 'missing a team']);
  return { errors, warns: [] };
}
/* the odds rules a quote must pass before it may be stored (Q006, Q011, Q014) */
function checkQuote(q) {
  const errors = [], warns = [];
  if (q.lineage !== 'observed' && q.lineage !== 'reconstructed') errors.push(['Q006', 'lineage must be observed or reconstructed (got ' + (q.lineage == null ? 'nothing' : q.lineage) + ')']);
  if (!q.provider) errors.push(['Q014', 'no provider']);
  if (isNum(q.american_price) && q.american_price > -100 && q.american_price < 100) errors.push(['Q011', 'American price ' + q.american_price + ' is inside the -99..99 gap']);
  if (!isNum(q.american_price)) errors.push(['Q011', 'no American price']);
  if (!q.snapshot_at || !isFinite(Date.parse(q.snapshot_at))) errors.push(['Q013', 'no snapshot time']);
  if (['over', 'under', 'yes', 'no'].indexOf(q.side) < 0) errors.push(['Q006', 'side ' + q.side + ' is not over/under/yes/no']);
  if ((q.side === 'over' || q.side === 'under') && !isNum(q.line)) errors.push(['Q006', 'an over/under quote has no line']);
  return { errors, warns };
}

/* Run a rule set over rows. Returns {kept, quarantined, flagged, counts}. */
function gate(rows, checker, scope, keyOf) {
  const kept = [], quarantined = [], counts = {};
  let flagged = 0;
  const seen = new Set();
  rows.forEach((r) => {
    const c = checker(r);
    if (keyOf) {
      const k = keyOf(r);
      if (seen.has(k)) c.errors.push(['Q001', 'duplicate ' + scope + ' key ' + k]);
      seen.add(k);
    }
    if (c.errors.length) {
      c.errors.forEach((e) => { counts[e[0]] = (counts[e[0]] || 0) + 1; });
      quarantined.push({ scope, rule_id: c.errors[0][0], severity: 'ERROR', reasons: c.errors.map((e) => e[0] + ': ' + e[1]), natural_key: keyOf ? keyOf(r) : null, row: r });
      return;
    }
    if (c.warns.length) { flagged++; r.qa_warnings = c.warns.map((e) => e[0] + ': ' + e[1]); c.warns.forEach((e) => { counts[e[0]] = (counts[e[0]] || 0) + 1; }); }
    kept.push(r);
  });
  return { kept, quarantined, flagged, counts };
}

module.exports = { RULES, BY_ID, COUNTS, checkPlayerGame, checkGame, checkQuote, gate };

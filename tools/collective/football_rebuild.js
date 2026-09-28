#!/usr/bin/env node
/* ===========================================================================
   football-v2 — REBUILD AND RECONCILE the Collective's 2026 football records.

   The database does the work (collective.fg2_rebuild, installed by
   supabase/migrations/20260928120000_football_grading_v2.sql): canonical
   games, market events and captured snapshots from every source it holds,
   links, one official close per game, the latest pre-lock prediction per
   model, the settlement, and the legacy tables brought into line. This tool
   drives it, one sport at a time, and writes the reconciliation a reader can
   audit: every count, each model's corrected record beside the legacy one it
   replaces, the consensus, the diagnostics, and a sample of graded
   model-games whose arithmetic is re-derived here, in JS, from the numbers
   the database printed.

   Doors:
     --pg          psql against $SB_DB_URL (or --pg-url <url>); the way the
                   football-regrade workflow runs it
     --rest        PostgREST RPC with EDGD_SB_SERVICE / EDGD_SB_URL
     --offline     no database: what the committed record and the repository's
                   own ledgers can establish (no per-model numbers: those need
                   the predictions, which live only in the database)

   Options:
     --sport NFL|CFB (repeatable; default both)   --season 2026
     --commit          write (default is the rolled-back preview)
     --apply-migration apply the migration first (--pg only; idempotent)
     --out <dir>       where the report goes (default collective/reports)
     --sample <n>      graded model-games to sample per sport (default 20)
     --statement-timeout <interval>  how long one rebuild may run (--pg;
                       default 25min). A season of capture history is more
                       than a pooled connection's default limit (2 min on
                       Supabase), so each rebuild runs in its own transaction
                       with SET LOCAL: the limit is raised for that call only.

   Exit 0 ok · 2 an ERROR-level diagnostic or a sample that does not re-derive
        1 could not run
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'football_grading.js'));
const I = require(path.join(ROOT, 'lib', 'football_identity.js'));
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260928120000_football_grading_v2.sql');
/* The migration is re-applied in place, so fg2_config.install_revision says
   which functions the database carries. Revision 2 made the snapshot import
   window-bounded and index-driven; a revision-1 database times out. */
const REQUIRED_REVISION = 2;

const CLASS_TEXT = {
  A: 'valid captured close already linked to the game',
  B: 'snapshots existed and were linked; the close selector produced nothing (recovered)',
  C: 'snapshots existed under another event id / source, unlinked to the game (recovered)',
  D: 'the market was linked to a duplicate row of the same game (recovered)',
  E: 'a market event for this game could not be resolved (team-name mismatch)',
  F: 'a market event for these teams exists with a kickoff outside the tolerance',
  G: 'snapshots exist only for another market or an unconfigured source',
  H: 'spread snapshots whose line could not be oriented to the home team',
  I: 'snapshots were captured, all at or after kickoff (never a close)',
  J: 'no market snapshot for this game exists in any source the database holds',
  K: 'every submission on the game was late',
  L: 'snapshots exist, none inside the final-pregame window (stale)',
};
const REASON_TEXT = Object.assign({}, G.REASON_TEXT);

function parseArgs(argv) {
  const a = { mode: null, sports: [], season: 2026, commit: false, apply: false, out: path.join(ROOT, 'collective', 'reports'),
    sample: 20, statementTimeout: '25min', pgUrl: process.env.SB_DB_URL || process.env.PGURL || process.env.SUPABASE_DB_URL || '' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--pg') a.mode = 'pg';
    else if (v === '--rest') a.mode = 'rest';
    else if (v === '--offline') a.mode = 'offline';
    else if (v === '--pg-url') a.pgUrl = argv[++i];
    else if (v === '--sport') a.sports.push(String(argv[++i]).toUpperCase());
    else if (v === '--season') a.season = Number(argv[++i]);
    else if (v === '--commit') a.commit = true;
    else if (v === '--apply-migration') a.apply = true;
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--sample') a.sample = Number(argv[++i]);
    else if (v === '--statement-timeout') a.statementTimeout = String(argv[++i]);
  }
  if (!a.sports.length) a.sports = ['NFL', 'CFB'];
  return a;
}

/* ---- the database doors ------------------------------------------------- */
/* One statement, in its own transaction, with the time limit raised for
   that transaction only (SET LOCAL: nothing leaks into a pooled connection). */
function pgStatement(sql, statementTimeout) {
  if (!/^\d+\s*(ms|s|min|h)?$/.test(String(statementTimeout))) throw new Error('bad --statement-timeout: ' + statementTimeout);
  return `set client_min_messages = warning; begin; set local statement_timeout = '${statementTimeout}'; ` +
    `set local lock_timeout = '2min'; ${sql} commit;`;
}
function pgRunner(url, statementTimeout) {
  if (!url) throw new Error('--pg needs a connection string ($SB_DB_URL or --pg-url).');
  const psql = (args, input) => cp.execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    apply() { return psql(['-f', MIGRATION]); },
    json(sql) {
      const out = psql(['-qAt', '-c', pgStatement(sql, statementTimeout || '25min')]).trim();
      return out ? JSON.parse(out.split('\n').filter(Boolean).pop()) : null;
    },
    revision() {
      return this.json(`select to_json(coalesce((select (value #>> '{}')::int from collective.fg2_config where key = 'install_revision'), 1));`);
    },
  };
}
function restRunner() {
  const S = require('./settle_finals.js');
  const cfg = S.directConfig();
  if (!cfg) throw new Error('--rest needs EDGD_SB_SERVICE and EDGD_SB_URL.');
  const db = S.dbClient(cfg);
  return {
    rpc: (fn, args) => db.rpc(fn, args),
    async revision() {
      try { return Number(await db.rpc('fg2_install_revision', {})) || 1; }
      catch (e) { if (S.isFg2Missing(e)) return 1; throw e; }
    },
  };
}
function revisionProblem(rev) {
  return rev >= REQUIRED_REVISION ? null :
    `the database carries revision ${rev} of the football-v2 migration; this tool needs ${REQUIRED_REVISION}. ` +
    'Re-apply supabase/migrations/20260928120000_football_grading_v2.sql (the Football regrade workflow with apply_migration: true, or --apply-migration).';
}

async function rebuildOne(runner, mode, sport, season, commit, sample) {
  const q = s => runner.json(s);
  if (mode === 'pg') {
    const rep = commit
      ? q(`select collective.fg2_rebuild('${sport}', ${season}, true);`)
      : q(`select collective.fg2_rebuild_preview('${sport}', ${season});`);
    /* a preview rolls back, so its report is the only record of it; after a
       commit the full reconciliation is read from what was written */
    const recon = commit ? q(`select collective.fg2_report('${sport}', ${season}, ${sample});`) : null;
    return { rebuild: rep, report: recon };
  }
  const rep = commit
    ? await runner.rpc('fg2_rebuild', { p_sport: sport, p_season: season, p_commit: true })
    : await runner.rpc('fg2_rebuild_preview', { p_sport: sport, p_season: season });
  const recon = commit ? await runner.rpc('fg2_report', { p_sport: sport, p_season: season, p_sample: sample }) : null;
  return { rebuild: rep, report: recon };
}

/* Every sampled row, re-derived from the numbers the database printed. */
function verifySample(sample) {
  return (sample || []).map(t => {
    const cv = G.atsCover(t.home_score, t.away_score, t.close_home_spread);
    const side = G.deriveSide(t.explicit_side, t.fair_home_spread, t.close_home_spread);
    const res = cv ? G.gradeSide(t.ats_side, cv.cover) : null;
    const ok = !!cv && res === t.ats_result && side.side === t.ats_side &&
      (t.ats_side_source === 'explicit' || side.source === t.ats_side_source);
    return Object.assign({}, t, { js_cover: cv && cv.cover, js_margin: cv && cv.ats_margin_home, js_result: res,
      js_side: side.side, verified: ok });
  });
}

/* ---- the report ----------------------------------------------------------- */
const fmt = (v, d) => (v === null || v === undefined || v === '') ? '—' : (typeof v === 'number' ? (d === undefined ? String(v) : v.toFixed(d)) : String(v));
const pct = v => (v === null || v === undefined) ? '—' : (Number(v) * 100).toFixed(1) + '%';
function markdownFor(sport, season, res, commit) {
  const rep = res.report, rb = res.rebuild || {};
  const L = [];
  L.push(`## ${sport} ${season} — football-v2 ${commit ? '(committed)' : '(preview, rolled back)'}`, '');
  if (!rep) {
    L.push('Preview only: counts from the rolled-back run.', '');
    L.push('| | |', '|---|---|');
    Object.entries(rb.close_classes || {}).forEach(([k, n]) => L.push(`| Close class ${k} — ${CLASS_TEXT[k] || ''} | ${n} |`));
    L.push(`| Settlements evaluated | ${fmt(rb['7_settlements_evaluated'])} |`, `| Grade changes that would be audited | ${fmt(rb.audit_rows_this_run)} |`, '');
    const n = v => (v === null || v === undefined) ? null : Number(v);
    (rb.standings || []).forEach(s => L.push(`- ${s.creator_slug}/${s.model_slug}: ${s.wins}-${s.losses}-${s.pushes} ATS (n=${s.ats_n}), ` +
      `MAE ${fmt(n(s.mae), 2)} (n=${s.mae_n}), Brier ${fmt(n(s.brier), 4)} (n=${s.brier_n})`));
    return L.join('\n');
  }
  L.push('| Measure | Count |', '|---|---:|');
  [['Total completed events with model submissions', rep.completed_events_with_submissions],
   ['Total model-game predictions (completed events)', rep.model_game_predictions],
   ['Valid pre-lock predictions', rep.valid_prelock_predictions],
   ['Games with a captured spread (official close)', rep.games_with_captured_spread],
   ['Recovered closes from previously orphaned snapshots (B+C+D)', rep.recovered_closes],
   ['Games with no historical market capture anywhere (J)', rep.no_market_capture],
   ['Late submissions', rep.late_submissions],
   ['ATS graded (W/L)', rep.ats_graded], ['ATS pushes', rep.ats_pushes], ['ATS ungraded', rep.ats_ungraded],
   ['Margin MAE graded', rep.mae_graded], ['Brier graded', rep.brier_graded]]
    .forEach(([k, v]) => L.push(`| ${k} | ${fmt(v)} |`));
  if (rep.legacy_closes_superseded) {
    L.push('', `**${rep.legacy_closes_superseded} close(s) the Collective had already published were superseded by a timed final-pregame snapshot**`, '',
      '| Game | Legacy close | Official close | Source | Book | Observed |', '|---|---:|---:|---|---|---|');
    (rep.legacy_closes_superseded_list || []).forEach(x => L.push(`| ${x.event} | ${x.legacy_close} | ${x.official_close} | ${x.source} | ${x.book || '—'} | ${x.observed_at || '—'} |`));
    L.push('', 'Every grade this moved is in collective.fg2_grade_audit with reason close_changed or ats_changed.');
  }
  L.push('', '**ATS ungraded, exact reasons**', '', '| Reason | Model-games |', '|---|---:|');
  Object.entries(rep.ats_ungraded_reasons || {}).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => L.push(`| ${k} — ${REASON_TEXT[k] || ''} | ${n} |`));
  L.push('', '**Why each completed game did or did not have a close (A–L)**', '', '| Class | Meaning | Games |', '|---|---|---:|');
  Object.keys(CLASS_TEXT).forEach(k => { if (rep.close_classes && rep.close_classes[k]) L.push(`| ${k} | ${CLASS_TEXT[k]} | ${rep.close_classes[k]} |`); });
  L.push('', '**Models — corrected (football-v2) beside the legacy record it replaces**', '',
    '| Model | W-L-P | ATS % | ATS n | Missing close | No side | Late | Margin MAE | MAE n | Brier | Brier n | Coverage % | Legacy W-L-P | Legacy MAE (n) | Legacy Brier (n) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|');
  (rep.models || []).forEach(m => {
    const lg = m.legacy || {};
    L.push(`| ${m.creator_slug}/${m.model_slug} | ${m.wins}-${m.losses}-${m.pushes} | ${pct(m.ats_pct)} | ${m.ats_n} | ${m.ats_missing_close} | ${m.ats_no_side} | ${m.ats_late} | ` +
      `${fmt(m.mae === null ? null : Number(m.mae), 2)} | ${m.mae_n} | ${fmt(m.brier === null ? null : Number(m.brier), 4)} | ${m.brier_n} | ${fmt(m.coverage_pct === null ? null : Number(m.coverage_pct), 1)} | ` +
      `${fmt(lg.wins)}-${fmt(lg.losses)}-${fmt(lg.pushes)} | ${fmt(lg.mae === null ? null : Number(lg.mae), 2)} (${fmt(lg.mae_n)}) | ${fmt(lg.brier === null ? null : Number(lg.brier), 4)} (${fmt(lg.brier_n)}) |`);
  });
  const c = rep.consensus || {};
  L.push('', '**The Collective (consensus of the same graded rows)**', '',
    `- Consensus ATS: ${fmt(c.ats_wins)}-${fmt(c.ats_losses)}-${fmt(c.ats_pushes)} (${pct(c.ats_pct)}); excluded: ${fmt(c.ats_fewer_than_2)} with fewer than 2 eligible models, ${fmt(c.ats_even_split)} dead-even splits`,
    `- Consensus outright: ${fmt(c.ml_wins)}-${fmt(c.ml_losses)} (${pct(c.ml_pct)})`);
  L.push('', '**Diagnostics by week**', '', '| Week | Capture % | Pred. coverage % | Canonical match % | ATS gradable % | ATS graded % | Finals % | Dupes | Orphans | Late | Warnings |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  (rep.diagnostics || []).forEach(d => L.push(`| ${d.week} | ${fmt(d.market_capture_pct)} | ${fmt(d.prediction_coverage_pct)} | ${fmt(d.canonical_match_pct_season)} | ` +
    `${fmt(d.ats_gradable_pct)} | ${fmt(d.ats_graded_pct)} | ${fmt(d.final_score_settlement_pct)} | ${d.duplicate_event_count_season} | ${d.orphan_event_count_season} | ` +
    `${d.late_submission_count} | ${(d.warnings || []).join(', ') || '—'} |`));
  L.push('', `**Verification sample (${(res.verified || []).length} graded model-games, re-derived here in JS from the printed numbers)**`, '',
    '| Event | Model | Side (source) | Close (source, book, observed) | Final | Margin + close | Result | Re-derived |',
    '|---|---|---|---|---|---|---|---|');
  (res.verified || []).forEach(t => L.push(`| ${t.event} (wk ${t.week}) | ${t.creator_slug}/${t.model_slug} v${t.prediction_version} | ${t.ats_side} (${t.ats_side_source}) | ` +
    `${t.close_home_spread} (${t.close_source}, ${t.close_book || '—'}, ${t.close_observed_at || 'untimed'}) | ${t.away_score}-${t.home_score} | ${t.ats_calculation} | ${t.ats_result} | ${t.verified ? 'yes' : '**NO**'} |`));
  return L.join('\n');
}

/* ---- offline: what the repository alone can establish ---------------------- */
function offline(args) {
  const rd = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const out = { mode: 'offline', generated_at: new Date().toISOString(), sports: {} };
  for (const sport of args.sports) {
    const file = path.join(ROOT, 'collective', 'settled', `${sport}_${args.season}.json`);
    if (!fs.existsSync(file)) { out.sports[sport] = { missing: file }; continue; }
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const games = Object.entries(rec.games).map(([id, g]) => Object.assign({ game_id: id }, g));
    const withClose = games.filter(g => g.closing_spread !== null && g.closing_spread !== undefined);
    const bySrc = {}, byWeek = {};
    games.forEach(g => {
      const k = g.close_source || 'none';
      bySrc[k] = (bySrc[k] || 0) + 1;
      const w = byWeek[g.week] = byWeek[g.week] || { games: 0, closes: 0 };
      w.games++; if (g.closing_spread !== null && g.closing_spread !== undefined) w.closes++;
    });
    /* duplicate fixtures in the record: same pair within 36h */
    const dups = I.findDuplicateGames(games.map(g => ({ game_id: g.game_id, sport, season: args.season,
      home_team_id: g.home, away_team_id: g.away, kickoff_at: g.kickoff_at })));
    /* the cover, per game, for every game carrying a close: model-independent */
    const covers = withClose.map(g => Object.assign({ game_id: g.game_id, label: g.label, week: g.week, final: `${g.away_score}-${g.home_score}`,
      close: g.closing_spread, close_source: g.close_source }, G.atsCover(g.home_score, g.away_score, g.closing_spread)));
    const s = { games: games.length, with_close: withClose.length, close_sources: bySrc, weeks: byWeek,
      duplicate_fixtures: dups, covers };
    if (sport === 'CFB') {
      const lab = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(args.season));
      if (fs.existsSync(lab)) {
        const codes = new Set(); games.forEach(g => { codes.add(g.home); codes.add(g.away); });
        const reg = I.buildRegistry('CFB', [...codes].map(c => ({ id: c, code: c, name: c })));
        const ev = new Map(); const quotes = [];
        ['quotes', 'predictions'].forEach(d => fs.readdirSync(path.join(lab, d)).forEach(f => rd(path.join(lab, d, f)).forEach(q => {
          if (!ev.has(q.game_id) && q.home_team) ev.set(q.game_id, { source: 'espn', source_event_id: q.game_id, sport: 'CFB',
            season: args.season, home_name: q.home_team, away_name: q.away_team, kickoff_at: q.kickoff_ts });
          if (d === 'quotes' && q.market_type === 'spread') quotes.push(q);
        })));
        const res = new Map(rd(path.join(lab, 'results.jsonl')).map(x => [x.game_id, x]));
        const played = games.filter(g => Date.parse(g.kickoff_at) < Date.now());
        const L = I.linkEvents(reg, [...ev.values()], played.map(g => ({ game_id: g.game_id, sport: 'CFB', season: args.season,
          home_team_id: g.home, away_team_id: g.away, kickoff_at: g.kickoff_at })));
        let agree = 0, disagree = 0; const linked = new Set();
        L.links.forEach(l => {
          linked.add(l.game_id);
          const g = games.find(x => x.game_id === l.game_id), r = res.get(l.source_event_id);
          if (!r) return;
          const ok = l.orientation === 'swapped' ? (r.home_points === g.away_score && r.away_points === g.home_score)
            : (r.home_points === g.home_score && r.away_points === g.away_score);
          if (ok) agree++; else disagree++;
        });
        /* which ledger quotes would qualify as a captured pregame close under
           football-v2 (observed before kickoff, inside the window) */
        const lead = {};
        quotes.forEach(q => {
          const k = Date.parse(q.kickoff_ts), o = Date.parse(q.observed_at);
          if (!(k < Date.now())) return;
          const b = o >= k ? 'at_or_after_kickoff (provider close fetched later)' : ((k - o) / 60000 <= G.DEFAULTS.closeWindowMinutes ? 'inside_window' : 'stale (older than window)');
          lead[b] = (lead[b] || 0) + 1;
        });
        s.identity_vs_espn_ledger = { record_games_played: played.length, linked: linked.size, scores_agree: agree,
          scores_disagree: disagree, refused: L.reasons, conflicts: L.conflicts.length,
          unlinked: played.filter(g => !linked.has(g.game_id)).map(g => `${g.away}@${g.home} ${String(g.kickoff_at).slice(0, 10)}`) };
        s.ledger_spread_quotes_on_played_games = lead;
      }
    }
    out.sports[sport] = s;
  }
  return out;
}
function offlineMarkdown(o) {
  const L = [`# football-v2 — offline reconciliation (repository data only)`, '', `Generated ${o.generated_at}.`, '',
    'The Collective\'s predictions, market snapshots and grades live in its database, which this run could not reach.',
    'Everything below is what the committed settlement record and EdgeDesk\'s own committed ledgers establish on their own.', ''];
  Object.entries(o.sports).forEach(([sport, s]) => {
    L.push(`## ${sport}`, '');
    if (s.missing) { L.push(`No record at ${s.missing}.`, ''); return; }
    L.push(`- Finished games in the committed record: **${s.games}**; with a captured close: **${s.with_close}**`);
    L.push(`- Close source: ${Object.entries(s.close_sources).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    L.push(`- By week: ${Object.entries(s.weeks).map(([w, x]) => `wk${w} ${x.closes}/${x.games}`).join(', ')}`);
    L.push(`- Duplicate fixtures in the record: ${s.duplicate_fixtures.length}`);
    if (s.identity_vs_espn_ledger) {
      const x = s.identity_vs_espn_ledger;
      L.push(`- Canonical identity (record's ten-character codes → ESPN ledger's full names): **${x.linked} of ${x.record_games_played}** played games linked; ` +
        `final scores agree on **${x.scores_agree}**, disagree on **${x.scores_disagree}**; conflicts ${x.conflicts}`);
      L.push(`- Unlinked (absent from the ESPN ledger): ${x.unlinked.join(', ') || 'none'}`);
      L.push(`- The ledger's spread quotes on played games, under the final-pregame rule: ` +
        Object.entries(s.ledger_spread_quotes_on_played_games || {}).map(([k, n]) => `${k} ${n}`).join(', '));
    }
    L.push('');
  });
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) throw new Error('say which door: --pg, --rest or --offline');
  fs.mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  if (args.mode === 'offline') {
    const o = offline(args);
    const base = path.join(args.out, `football-v2-offline-${args.season}`);
    fs.writeFileSync(base + '.json', JSON.stringify(o, null, 1) + '\n');
    fs.writeFileSync(base + '.md', offlineMarkdown(o) + '\n');
    console.log(offlineMarkdown(o));
    return 0;
  }
  const runner = args.mode === 'pg' ? pgRunner(args.pgUrl, args.statementTimeout) : restRunner();
  if (args.apply) {
    if (args.mode !== 'pg') throw new Error('--apply-migration needs --pg');
    const out = runner.apply();
    console.log(out.split('\n').filter(l => /\|/.test(l)).join('\n'));
  }
  const problem = revisionProblem(await runner.revision());
  if (problem) throw new Error(problem);
  const all = { mode: args.mode, committed: args.commit, generated_at: new Date().toISOString(), sports: {} };
  const md = [`# football-v2 reconciliation — ${args.season}`, '', `Generated ${all.generated_at} (${args.commit ? 'committed' : 'preview: rolled back'}).`, ''];
  let bad = 0;
  for (const sport of args.sports) {
    const res = await rebuildOne(runner, args.mode, sport, args.season, args.commit, args.sample);
    res.verified = verifySample(res.report && res.report.sample);
    bad += res.verified.filter(t => !t.verified).length;
    const diag = (res.report && res.report.diagnostics) || (res.rebuild && res.rebuild.diagnostics) || [];
    bad += diag.filter(d => (d.warnings || []).some(w => /^ERROR/.test(w))).length;
    all.sports[sport] = res;
    md.push(markdownFor(sport, args.season, res, args.commit), '');
  }
  const base = path.join(args.out, `football-v2-${args.season}-${stamp}`);
  fs.writeFileSync(base + '.json', JSON.stringify(all, null, 1) + '\n');
  fs.writeFileSync(base + '.md', md.join('\n') + '\n');
  console.log(md.join('\n'));
  console.log(`\nwrote ${path.relative(process.cwd(), base)}.{md,json}`);
  return bad ? 2 : 0;
}

module.exports = { parseArgs, verifySample, markdownFor, offline, offlineMarkdown, CLASS_TEXT,
  REQUIRED_REVISION, revisionProblem, pgStatement };

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('[football_rebuild] ' + e.message); process.exit(1); });
}

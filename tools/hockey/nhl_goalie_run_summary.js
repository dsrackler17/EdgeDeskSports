// The NHL goalie sync as a GitHub job summary: what one run of the deployed
// nhl_goalie_sync function wrote, whether pg_cron is calling it, the
// readiness KPIs (public.nhl_goalie_readiness) and each game's current card
// with what its headline is priced by (the slate, or the lineup lock), with the
// verdict the job exits on. Read by .github/workflows/nhl-goalie-sync.yml and by the first run in
// deploy-nhl-goalie.yml. docs/engine/NHL_GOALIES.md §9.
//
//   node tools/hockey/nhl_goalie_run_summary.js --title "NHL goalie sync"
//        [--run run.json --http 200] [--cron cron.json] [--readiness readiness.json] [--cards cards.json]
//        [--cron-stale-min 15]
//
// Prints the markdown, appends it to $GITHUB_STEP_SUMMARY when that is set,
// prints ::warning:: / ::error:: annotations, and exits 1 when an error stands.
// An input that was asked for and is empty or unreadable is itself an error:
// a check that could not be made is never reported as a pass.
'use strict';
const fs = require('fs');

const cell = (v) => (v == null || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
const pct = (p) => (p == null ? '—' : (p * 100).toFixed(1) + '%');
const yesNo = (b) => (b === true ? 'yes' : b === false ? 'no' : '—');
const ageMin = (iso, nowMs) => (iso ? Math.round((nowMs - Date.parse(iso)) / 60000) : null);
/* the timing probe for one game (tools/hockey/sql/nhl_goalie_cards_check.sql): when the NHL boxscore first listed both dressed lineups, else what the last read before puck drop saw */
function probeText(p) {
  if (!p || !p.reads) return 'not read';
  const pre = p.last_pre ? 'T−' + p.last_pre.min + ': ' + (p.last_pre.state || '?') + ', ' + ((p.last_pre.skaters || {}).home ?? '?') + ' / ' + ((p.last_pre.skaters || {}).away ?? '?') + ' skaters, ' + (p.last_pre.starters ?? '?') + ' starters flagged' : null;
  if (p.first_listed_min != null && p.first_listed_min >= 0) return 'listed T−' + p.first_listed_min + ' min';
  if (p.first_listed_min != null) return 'listed T+' + (-p.first_listed_min) + ' min, after puck drop (' + (pre ? 'by ' + pre + '; ' : '') + p.reads + ' reads)';
  return 'not listed' + (pre ? ' by ' + pre.replace(/^T−(\d+): /, 'T−$1 (') + ';' : ' before puck drop (') + ' ' + p.reads + ' reads)';
}
const utc = (iso, withDate) => { const t = Date.parse(iso); return isFinite(t) ? new Date(t).toISOString().slice(withDate ? 0 : 11, 16).replace('T', ' ') + ' UTC' : '—'; };

/** a JSON file: the value, null when empty, or { _unreadable } */
function readJson(file) {
  if (!file) return undefined;
  try { const t = fs.readFileSync(file, 'utf8').trim(); return t ? JSON.parse(t) : null; } catch (e) { return { _unreadable: String((e && e.message) || e).slice(0, 200) }; }
}

// The one failure that is not EdgeDesk's: no outside starter source answered
// (Daily Faceoff refused, and the NHL API was down or not yet in its window).
// The function records that run as an error and keeps the starters on file;
// the cards say so and stay gated, and System health shows it. The job warns.
// Everything else that fails (the scheduler, the function, the cron secret,
// the slate's inputs, a parser that no longer reads a source's page) fails it.
const OUTSIDE = 'sources_down';
// What a refused or failed answer says, verbatim: the function's own
// {error, reason}, or the Supabase gateway's {msg} / {message} (a gateway 401
// means the function is checking JWTs: it was deployed without --no-verify-jwt).
const said = (r) => (r ? [r.error, r.reason, r.msg, r.message].filter((x) => typeof x === 'string' && x).join(': ') : '');
const outsideOnly = (codes) => codes.length > 0 && codes.every((c) => c === OUTSIDE);

/** what the job says: errors fail it, warnings annotate it */
function verdict(o, nowMs) {
  const errors = [], warnings = [];
  const staleMin = o.cronStaleMin || 15;
  if (o.run !== undefined) {
    const r = o.run, code = String(o.http || '');
    const failures = r && !r._unreadable ? (r.alerts || []).filter((a) => a.severity === 'FAILURE') : [];
    const outside = outsideOnly(failures.map((a) => a.code));
    if (!r || r._unreadable) errors.push('the sync gave no readable answer (HTTP ' + (code || '000') + ')' + (r && r._unreadable ? ': ' + r._unreadable : ''));
    else if (code === '401' && r.error === 'unauthorized') errors.push('the sync refused the cron secret (HTTP 401' + (r.reason ? ': ' + r.reason : '') + '): run Deploy NHL goalie layer with set_cron_secret');
    else if (code === '401') errors.push('the Supabase gateway refused the call (HTTP 401' + (said(r) ? ': ' + said(r) : '') + '): nhl_goalie_sync is checking JWTs; redeploy it with Deploy NHL goalie layer (deploy_function, which passes --no-verify-jwt)');
    else if (code !== '200' && !(code === '500' && outside)) errors.push('the sync answered HTTP ' + code + (failures.length ? ': ' + failures.map((a) => a.code + ': ' + a.message).join('; ') : ''));
    if (r && !r._unreadable) for (const a of r.alerts || []) {
      if (a.severity === 'FAILURE') {
        if (a.code === OUTSIDE) warnings.push('FAILURE ' + a.code + ' (an outside source, not EdgeDesk; the cards keep the starters on file and stay gated): ' + a.message);
        else if (code === '200') errors.push(a.code + ': ' + a.message);
      } else if (a.severity === 'DRIFT') errors.push('DRIFT ' + a.code + ' (a source\'s page no longer reads: the parser in hockey/goalies/core.js needs a fix): ' + a.message);
      else if (a.severity !== 'WARNING' || a.code === 'unmatched_names' || a.code === 'source_conflict') warnings.push(a.severity + ' ' + a.code + ': ' + a.message);
    }
  }
  if (o.cron !== undefined) {
    const c = o.cron;
    if (!c || c._unreadable) errors.push('pg_cron could not be read' + (c && c._unreadable ? ': ' + c._unreadable : '') + ' (is pg_cron enabled?)');
    else if (!c.exists) errors.push('pg_cron has no nhl_goalie_sync job: run Deploy NHL goalie layer with apply_sql');
    else if (c.active === false) errors.push('the pg_cron job nhl_goalie_sync is inactive');
    else if (!c.last_start) errors.push('pg_cron has never called nhl_goalie_sync');
    else {
      const age = ageMin(c.last_start, nowMs);
      if (age > staleMin) errors.push('pg_cron last called nhl_goalie_sync ' + age + ' minutes ago (' + c.last_start + '): it is meant to every five minutes');
      else if (c.last_status === 'failed') errors.push('pg_cron\'s last call of nhl_goalie_sync failed: ' + (c.last_message || 'no message'));
    }
    // what the function answered pg_cron (pg_net's record of each poke): the SQL running is not the sync answering
    const last = c && !c._unreadable && Array.isArray(c.answers) ? c.answers.find((x) => x.status != null || x.timed_out || x.error) : null;
    if (last && c.exists) {
      const body = last.content ? ': ' + String(last.content).slice(0, 160) : '';
      if (last.status === 401) errors.push('pg_cron\'s calls are refused (HTTP 401' + body + '). The function\'s NHL_GOALIE_CRON_SECRET and Vault nhl_goalie_cron_secret disagree (or the function checks JWTs): run Deploy NHL goalie layer with set_cron_secret, and deploy_function for a JWT refusal');
      else if (last.timed_out) warnings.push('pg_cron\'s last call of nhl_goalie_sync timed out (pg_net waits 120 s)');
      else if (last.status == null && last.error) errors.push('pg_cron\'s last call of nhl_goalie_sync did not connect: ' + last.error);
      else if (last.status !== 200 && last.status !== 500) errors.push('pg_cron\'s last call of nhl_goalie_sync answered HTTP ' + last.status + body);
      // a 500 is a run the function recorded as an error: readiness says why
    }
  }
  if (o.readiness !== undefined) {
    const R = o.readiness;
    // last_check_alerts ("SEVERITY:code" of the last non-skipped run) is added by the workflows' query, beside the view's columns
    const lastFailures = (Array.isArray(R && R.last_check_alerts) ? R.last_check_alerts : []).filter((s) => /^FAILURE:/.test(s)).map((s) => s.slice(8));
    if (!R || R._unreadable) errors.push('public.nhl_goalie_readiness could not be read' + (R && R._unreadable ? ': ' + R._unreadable : ''));
    else if (R.state === 'error' && R.last_check_status === 'error' && outsideOnly(lastFailures)) warnings.push('readiness: ' + (R.state_reason || 'error') + ' (an outside source, not EdgeDesk: see System health)');
    else if (R.state === 'error') errors.push('readiness: ' + (R.state_reason || 'error'));
    else if (R.state === 'warn') warnings.push('readiness: ' + (R.state_reason || 'warn (see nhl_goalie_alerts and System health)'));
  }
  if (o.cards !== undefined && !Array.isArray(o.cards)) errors.push('public.nhl_game_cards_current could not be read' + (o.cards && o.cards._unreadable ? ': ' + o.cards._unreadable : ''));
  return { errors, warnings };
}

function render(o, nowMs) {
  const L = ['### ' + (o.title || 'NHL goalie sync'), ''];
  const r = o.run;
  if (r !== undefined) {
    L.push('**The run**', '');
    if (!r || r._unreadable) L.push('No readable answer (HTTP ' + cell(o.http) + ').', '');
    else {
      const R = r.run || {}, C = (r.cards && r.cards.versions) || [];
      L.push('| | |', '|---|---|', '| Status | ' + cell(r.status) + (r.dry ? ' (dry: nothing written)' : '') + ' |', '| HTTP | ' + cell(o.http) + ' |');
      if (r.skipped) L.push('| Not run | ' + cell(r.skipped) + ' |');
      if ((r.ok === false || String(o.http) !== '200') && said(r)) L.push('| Answer | ' + cell(said(r)) + ' |');
      else if (r.reason) L.push('| Reason | ' + cell(r.reason) + ' |');
      L.push('| Due | ' + cell((R.due_kinds || []).join(', ')) + ' |',
        '| Observations / consensus written | ' + cell(R.observations_written) + ' / ' + cell(R.consensus_written) + ' |',
        '| Cards written / unchanged | ' + cell(R.cards_written) + ' / ' + cell(R.cards_unchanged) + ' |',
        '| Edge events written | ' + cell(R.edge_events_written) + ' |',
        '| Open conflicts | ' + cell(R.conflicts_open) + ' |', '| Next slot | ' + cell(R.next_due_at) + ' |',
        '| Alerts | ' + ((r.alerts || []).map((a) => cell(a.severity + ' ' + a.code + ': ' + a.message)).join('<br>') || 'none') + ' |', '');
      if (C.length) {
        /* the pairing's goalie-only number, and the card's headline: the slate's price, or the lineup-lock price once locked */
        L.push('| Game | v | Trigger | Starters (home / away) | Status | Gate | Home win % (pairing) | Change | Headline home win % |', '|---|---|---|---|---|---|---|---|---|');
        for (const c of C) L.push('| ' + [c.matchup, c.version, c.trigger, (c.pairing || []).join(' / '), (c.status || []).join(' / '), c.gate, pct(c.p_home_pairing), c.change,
          c.p_home_headline == null ? null : pct(c.p_home_headline) + (c.lineup_locked ? ' (lineup lock)' : '')].map(cell).join(' | ') + ' |');
        L.push('');
      }
    }
  }
  const c = o.cron;
  if (c !== undefined) {
    L.push('**pg_cron** (the five-minute poke)', '');
    if (!c || c._unreadable) L.push('Could not be read.', '');
    else L.push('| | |', '|---|---|', '| Job | ' + (c.exists ? 'nhl_goalie_sync, ' + cell(c.schedule) + (c.active === false ? ', inactive' : '') : 'missing') + ' |',
      '| Last call | ' + (c.last_start ? cell(c.last_start) + ' (' + ageMin(c.last_start, nowMs) + ' min ago), ' + cell(c.last_status) : 'never') + ' |',
      '| Failed calls, last hour | ' + cell(c.failed_1h) + ' |',
      '| The sync\'s answers (latest first) | ' + ((Array.isArray(c.answers) ? c.answers : []).map((x) => x.status != null ? 'HTTP ' + x.status : x.timed_out ? 'timed out' : x.error ? 'no connection' : 'no answer yet').join(', ') || '—') + ' |', '');
  }
  const R = o.readiness;
  if (R !== undefined) {
    L.push('**Readiness** (public.nhl_goalie_readiness)', '');
    if (!R || R._unreadable) L.push('Could not be read.', '');
    else L.push('| | |', '|---|---|', '| State | ' + cell(R.state) + (R.state_reason ? ': ' + cell(R.state_reason) : '') + ' |',
      '| Last check | ' + cell(R.last_check_status) + ' at ' + cell(R.last_check_at) + (Array.isArray(R.last_check_alerts) && R.last_check_alerts.length ? ' (' + cell(R.last_check_alerts.join(', ')) + ')' : '') + ' |',
      '| Last success | ' + cell(R.last_success_at) + (R.minutes_since_success != null ? ' (' + R.minutes_since_success + ' min ago)' : '') + ' |',
      '| Daily Faceoff / NHL API read | ' + yesNo(R.daily_faceoff_ok) + ' / ' + yesNo(R.nhl_api_ok) + ' |',
      '| Upcoming cards / gated | ' + cell(R.cards_upcoming) + ' / ' + cell(R.cards_gated) + ' |',
      '| Sides in the next 3h / not Confirmed | ' + cell(R.sides_next_3h) + ' / ' + cell(R.sides_unconfirmed_next_3h) + ' |',
      '| Both starters Confirmed by T-30, last 7 days | ' + (R.pct_confirmed_by_t30_7d == null ? '— (no game yet)' : cell(R.pct_confirmed_by_t30_7d) + '% of ' + cell(R.games_7d)) + ' (target ' + cell(R.confirmed_by_t30_target_pct) + '%) |',
      '| Source conflicts open / 24h / 7d | ' + cell(R.conflicts_open) + ' / ' + cell(R.conflicts_24h) + ' / ' + cell(R.conflicts_7d) + ' |',
      '| Sync failures, last 24h | ' + cell(R.sync_failures_24h) + ' of ' + cell(R.runs_24h) + ' runs |',
      '| Next slot | ' + cell(R.next_due_at) + ' |', '');
  }
  const K = o.cards;
  if (K !== undefined) {
    // each game's current card (tools/hockey/sql/nhl_goalie_cards_check.sql): its headline, and whether the lineup lock priced it (docs/engine/NHL_GOALIES.md §11)
    L.push('**The cards** (each game\'s current version, from 6 hours ago to 24 hours ahead)', '');
    if (!Array.isArray(K)) L.push('Could not be read.', '');
    else if (!K.length) L.push('No game in the window.', '');
    else {
      const started = K.filter((k) => Date.parse(k.start_utc) <= nowMs), locked = started.filter((k) => k.basis === 'lineup_lock');
      const listed = started.filter((k) => k.probe && k.probe.first_listed_min != null && k.probe.first_listed_min >= 0);
      if (started.length) L.push('Started: ' + started.length + ' game' + (started.length === 1 ? '' : 's') + ', ' + locked.length + ' priced at lineup lock before puck drop. The NHL boxscore listed both lineups before puck drop for ' + listed.length + ' of them.', '');
      L.push('| Game | Puck drop | v | Written | Status (home / away) | Gate | Headline home win % | Priced at | NHL boxscore lineups |', '|---|---|---|---|---|---|---|---|---|');
      for (const k of K) {
        const sk = k.skaters && k.skaters.home != null ? ', ' + k.skaters.home + ' / ' + k.skaters.away + ' skaters' : '';
        const at = k.basis === 'lineup_lock' ? 'lineup lock' + sk + (k.before_p_home != null ? ' (before lock ' + pct(k.before_p_home) + ')' : '') : 'slate (' + (k.model_id || '—') + ')';
        L.push('| ' + [k.matchup, utc(k.start_utc, true), k.version, utc(k.generated_at) + ' (T−' + Math.round((Date.parse(k.start_utc) - Date.parse(k.generated_at)) / 60000) + ' min)',
          (k.status || []).join(' / ') + (k.conflict ? ', conflict' : ''), k.gate, pct(k.p_home), at, probeText(k.probe)].map(cell).join(' | ') + ' |');
      }
      L.push('');
    }
  }
  const v = verdict(o, nowMs);
  L.push(v.errors.length ? '**Failed:** ' + v.errors.map(cell).join('; ') : v.warnings.length ? '**Passed with warnings.**' : '**Passed.**', '');
  return { markdown: L.join('\n'), verdict: v };
}

const annotation = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  const o = { title: a.title, http: a.http, run: readJson(a.run), cron: readJson(a.cron), readiness: readJson(a.readiness), cards: readJson(a.cards), cronStaleMin: a['cron-stale-min'] ? Number(a['cron-stale-min']) : undefined };
  const out = render(o, Date.now());
  console.log(out.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.markdown + '\n');
  for (const w of out.verdict.warnings) console.log('::warning::' + annotation(w));
  for (const e of out.verdict.errors) console.log('::error::' + annotation(e));
  return out.verdict.errors.length ? 1 : 0;
}

module.exports = { render, verdict, readJson };
if (require.main === module) process.exit(main(process.argv.slice(2)));

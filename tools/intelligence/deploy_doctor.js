#!/usr/bin/env node
/* ===========================================================================
   MERGED IS NOT DEPLOYED.

   This repository has no workflow that deploys an edge function and none that
   applies a SQL migration: every function carries a manual
   `supabase functions deploy <name>` in its header, and every .sql file is
   applied by hand. So a green CI run and a merged pull request say exactly
   nothing about what is answering at the other end, and the only honest way to
   tell them apart is to ASK the deployment.

   That is what this does. Four questions, each answerable, each reported as a
   fact rather than an assumption:

     1. is edgedesk_ai deployed, and is it serving THIS commit's build?
     2. has supabase/recommendation_ledger.sql been applied?
     3. does the deployed build carry the intelligence kernel and the
        correction columns, and is its decision layer switched on?
     4. is the published site serving the artifacts the desk reads?

   IT NEEDS NO NEW CREDENTIAL. SB_URL and SB_SERVICE_ROLE are the secrets the
   newsletter workflow already holds; the anon key alone answers 1, 3 and 4.
   Nothing is written, nothing is deployed, and no secret is printed —
   presence is reported as a boolean, exactly as the function's own probe does.

   Run: node tools/intelligence/deploy_doctor.js
        SB_URL=... SB_ANON=... node tools/intelligence/deploy_doctor.js --json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function env(...names) {
  for (const n of names) { const v = String(process.env[n] || '').trim(); if (v) return v; }
  return '';
}

/** The build this checkout would deploy, read from the source of truth. */
function expectedBuild() {
  const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'), 'utf8');
  const m = /export const BUILD = "([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

/** The same question for capture, which stamps its build into every response it
    gives — including the 401 it answers an unauthenticated probe with. So the
    deployed-versus-merged question is answerable for capture with no credential
    at all, and it is worth asking: capture is deployed by hand, and a board that
    stopped filling because the fix for it was merged and never deployed looks
    exactly like a board that stopped filling for any other reason. */
function expectedCaptureBuild() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts'), 'utf8');
    const m = /export const BUILD = "([^"]+)"/.exec(src);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

async function get(url, headers, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 12000) : null;
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl && ctrl.signal });
    const text = await r.text().catch(() => '');
    if (timer) clearTimeout(timer);
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
  }
}

async function doctor(opts) {
  opts = opts || {};
  const url = (opts.url || env('SB_URL', 'EDGD_SB_URL', 'SUPABASE_URL')
    || 'https://iattxbkbufslbauoumga.supabase.co').replace(/\/+$/, '');
  const key = opts.key || env('SB_ANON', 'SUPABASE_ANON_KEY', 'SB_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY');
  const site = (opts.site || env('EDGEDESK_SITE_BASE') || 'https://edgedesksports.com').replace(/\/+$/, '');
  const want = expectedBuild();
  const out = { checked_at: new Date().toISOString(), expected_build: want, checks: [] };
  const add = (name, state, detail, fix) => out.checks.push({ name, state, detail, fix: fix || null });

  /* ---- 1 + 3. the function ------------------------------------------- */
  const probe = await get(`${url}/functions/v1/edgedesk_ai?probe=1`, key ? { apikey: key, authorization: 'Bearer ' + key } : {});
  if (probe.status === 0) {
    add('edgedesk_ai reachable', 'UNKNOWN', `could not reach ${url} (${probe.error || 'no response'})`,
      'Run this from somewhere with network access to the Supabase project.');
  } else if (probe.status === 404) {
    add('edgedesk_ai deployed', 'NOT_DEPLOYED', `HTTP 404 from ${url}/functions/v1/edgedesk_ai`,
      'supabase functions deploy edgedesk_ai');
  } else if (!probe.ok) {
    add('edgedesk_ai deployed', 'UNKNOWN', `HTTP ${probe.status} from the probe`,
      probe.status === 401 ? 'Pass SB_ANON so the probe can be reached.' : null);
  } else {
    let j = null; try { j = JSON.parse(probe.text); } catch (_) { /* below */ }
    if (!j) {
      add('edgedesk_ai deployed', 'UNKNOWN', 'the probe answered but not with JSON');
    } else {
      add('edgedesk_ai deployed', 'DEPLOYED', `serving build ${j.build}`);
      add('deployed build matches this checkout',
        j.build === want ? 'CURRENT' : 'STALE',
        j.build === want ? `both are ${want}`
          : `deployed ${j.build}, this checkout would deploy ${want}`,
        j.build === want ? null : 'supabase functions deploy edgedesk_ai');
      add('intelligence kernel loaded in the deployed build',
        j.intelligence_loaded === true ? 'PRESENT'
          : j.intelligence_loaded === false ? 'ABSENT' : 'UNKNOWN',
        j.intelligence_loaded === undefined
          ? 'this build predates the kernel probe field' : `EDINTEL v${j.intelligence_version}`,
        j.intelligence_loaded ? null : 'supabase functions deploy edgedesk_ai');
      add('decision layer',
        j.decisions_enabled === false ? 'DISABLED' : j.decisions_enabled === true ? 'ENABLED' : 'UNKNOWN',
        j.decisions_enabled === false
          ? 'EDGEDESK_DECISIONS_ENABLED is off: the desk researches and recommends nothing'
          : j.decisions_enabled === true ? 'recommendations are being produced' : 'this build predates the flag');
      add('model credential configured on the deployment',
        j.env && j.env.anthropic_key ? 'PRESENT' : 'ABSENT',
        j.env && j.env.anthropic_key ? 'set (value never read)' : 'ANTHROPIC_API_KEY is not set, so chat will 503',
        j.env && j.env.anthropic_key ? null : 'supabase secrets set ANTHROPIC_API_KEY=...');
      /* What the deployed build says about its own last packet write. Absent
         on a build older than r12, which is not a finding about that build;
         null on a build that has not yet answered a single-game football
         question in this isolate, which is a fact and not a failure. */
      if (j.packet_health && typeof j.packet_health === 'object') {
        const w = j.packet_health.last_packet_write;
        if (w == null) {
          add('research packets are being snapshotted', 'IDLE',
            'no single-game football question has run in this isolate yet, so there is no write to judge');
        } else if (w.ok === false) {
          add('research packets are being snapshotted', 'FAILING',
            `the deployed build's last packet write failed${w.at ? ' at ' + w.at : ''}${w.status ? ' (HTTP ' + w.status + ')' : ''}`
              + (w.detail ? ': ' + String(w.detail).slice(0, 160) : ''),
            'apply supabase/research_packets.sql (Deploy intelligence with apply_research_packets), then re-run this doctor');
        } else {
          add('research packets are being snapshotted', 'WRITING',
            `the deployed build's last packet write succeeded${w.at ? ' at ' + w.at : ''}`);
        }
      }
    }
  }

  /* ---- 2. the migration ----------------------------------------------- */
  if (!key) {
    add('recommendation_ledger applied', 'UNKNOWN', 'no SB_ANON or SB_SERVICE_ROLE in the environment',
      'SB_ANON=... node tools/intelligence/deploy_doctor.js');
  } else {
    const t = await get(`${url}/rest/v1/recommendation_ledger?select=entry_key&limit=1`,
      { apikey: key, authorization: 'Bearer ' + key });
    const missing = /does not exist|schema cache|PGRST205|42P01/i.test(t.text);
    if (t.status === 0) add('recommendation_ledger applied', 'UNKNOWN', t.error || 'no response');
    else if (missing || t.status === 404) {
      add('recommendation_ledger applied', 'NOT_APPLIED',
        'the table is not in the schema — every decision the desk publishes is going unrecorded',
        'psql "$DATABASE_URL" -f supabase/recommendation_ledger.sql');
    } else if (t.ok || t.status === 401 || t.status === 403) {
      add('recommendation_ledger applied', 'APPLIED',
        t.ok ? 'the table answered' : `the table exists and row-level security refused this key (HTTP ${t.status}), which is the table being there`);
      /* The correction columns are the newest part of the migration, so a
         table that exists is not proof the CURRENT migration was applied. */
      const c = await get(`${url}/rest/v1/recommendation_ledger?select=correction_reason&limit=1`,
        { apikey: key, authorization: 'Bearer ' + key });
      const noCol = /correction_reason.*does not exist|PGRST204|42703/i.test(c.text);
      add('official-correction columns applied',
        noCol ? 'NOT_APPLIED' : (c.ok || c.status === 401 || c.status === 403) ? 'APPLIED' : 'UNKNOWN',
        noCol ? 'the table predates append-only settlement corrections'
          : 'correction_reason is present',
        noCol ? 'psql "$DATABASE_URL" -f supabase/recommendation_ledger.sql  (it is idempotent)' : null);
    } else {
      add('recommendation_ledger applied', 'UNKNOWN', `HTTP ${t.status}`);
    }

    /* THE PACKET LEDGER, which the r12+ build snapshots every single-game
       football packet into for grading against the close. The function
       carries on when the write fails — a customer's answer does not wait on
       a ledger — so a missing migration is silent from the outside: the desk
       answers, nothing is recorded, and every calibration built on the table
       later is built on nothing. The doctor asks the table directly, and the
       deployed build reports the outcome of its own last write. */
    const rp = await get(`${url}/rest/v1/research_packets?select=packet_id&limit=1`,
      { apikey: key, authorization: 'Bearer ' + key });
    const rpMissing = /does not exist|schema cache|PGRST205|42P01/i.test(rp.text);
    if (rp.status === 0) add('research_packets applied', 'UNKNOWN', rp.error || 'no response');
    else if (rpMissing || rp.status === 404) {
      add('research_packets applied', 'NOT_APPLIED',
        'the table is not in the schema — every research packet the desk builds is going unrecorded',
        'run the Deploy intelligence workflow with apply_research_packets, or psql "$DATABASE_URL" -f supabase/research_packets.sql');
    } else if (rp.ok || rp.status === 401 || rp.status === 403) {
      add('research_packets applied', 'APPLIED',
        rp.ok ? 'the table answered' : `the table exists and row-level security refused this key (HTTP ${rp.status}), which is the table being there`);
    } else {
      add('research_packets applied', 'UNKNOWN', `HTTP ${rp.status}`);
    }
  }

  /* ---- 3b. IS ANYTHING FILLING THE BOARD? ------------------------------
     The failure this check exists for went unnoticed for as long as it did
     because nothing was watching for it: `capture` was never scheduled, the
     board quietly aged, and the first report came from a customer being shown
     a thirty-nine-hour-old price. Every other check here answers "is the
     right code deployed". This one answers "is the deployed code being run",
     which is a different question and was the one that mattered.

     It compares the newest capture against the reader's OWN rung for the
     nearest kickoff, not against a flat number, so a six-day-out board that
     is two hours old reads healthy and a board two hours old twenty minutes
     before kickoff does not. */
  if (!key) {
    add('the board is being captured', 'UNKNOWN', 'no SB_ANON or SB_SERVICE_ROLE in the environment',
      'SB_ANON=... node tools/intelligence/deploy_doctor.js');
  } else {
    const nowIso = new Date().toISOString();
    const q = `${url}/rest/v1/signals?select=last_seen_at,commence_time,sport_key,market`
      + `&commence_time=gte.${encodeURIComponent(nowIso)}&order=last_seen_at.desc&limit=1`;
    const b = await get(q, { apikey: key, authorization: 'Bearer ' + key });
    let rows = null; try { rows = JSON.parse(b.text); } catch (_) { /* below */ }
    if (b.status === 0) {
      add('the board is being captured', 'UNKNOWN', b.error || 'no response');
    } else if (!b.ok && b.status !== 401 && b.status !== 403) {
      add('the board is being captured', 'UNKNOWN', `HTTP ${b.status} reading signals`);
    } else if (b.status === 401 || b.status === 403) {
      add('the board is being captured', 'UNKNOWN',
        `row-level security refused this key (HTTP ${b.status}), so the board's age could not be read`,
        'Pass SB_SERVICE_ROLE to read it.');
    } else if (!Array.isArray(rows) || !rows.length) {
      add('the board is being captured', 'EMPTY',
        'not one signal row exists for any game that has not started yet',
        'Apply supabase/capture_cron.sql, then check cron.job_run_details.');
    } else {
      const r = rows[0];
      const ageMin = (Date.now() - Date.parse(r.last_seen_at)) / 60000;
      const hrsToKick = (Date.parse(r.commence_time) - Date.now()) / 3600000;
      /* The reader's ladder, mirrored. capture/index.ts holds the same table as
         READER_RUNGS and _intelligence.js holds it as quote_ttl_buckets. */
      const RUNGS = [[0.5, 5], [2, 15], [6, 45], [24, 90], [72, 180], [Infinity, 360]];
      const limit = (RUNGS.find(([h]) => hrsToKick <= h) || RUNGS[RUNGS.length - 1])[1];
      /* THE CADENCE FLOOR, WHICH THIS CHECK USED TO IGNORE AND SO CRIED WOLF.
         capture/index.ts is explicit that a cadence looser than the rung it
         feeds "IS NOT A BUG, BUT IT MUST NOT BE SILENT": the near tier runs
         every ten minutes and the rung inside half an hour of kickoff is five,
         so in that window a ten-minute-old price is the system working exactly
         as designed and the reader is already calling the quote aging.
         Grading that against the rung alone made every Saturday evening red —
         and it accused the scheduler of not running while the scheduler was
         running, because a ten-minute-old price is PROOF of a ten-minute
         cadence, not evidence against it. The tiers mirror CADENCE_TIERS.
         Slack covers the poke, the odds request and the upsert; past it the
         age is longer than the cadence can explain and something really has
         stopped calling capture. */
      const TIERS = [[8, 10], [30, 30], [Infinity, 240]];
      const cadence = (TIERS.find(([h]) => hrsToKick <= h) || TIERS[TIERS.length - 1])[1];
      const floor = cadence + 3;
      const state = ageMin <= limit ? 'CURRENT' : ageMin <= floor ? 'AGING' : 'STALE';
      const age = ageMin >= 120 ? `${(ageMin / 60).toFixed(1)} hours` : `${Math.round(ageMin)} minutes`;
      if (state === 'AGING') {
        add('the board is being captured', 'AGING',
          `the newest capture on an upcoming game is ${age} old, inside the ${cadence}-minute cadence that `
          + `feeds it but outside the ${limit}-minute rung for a game starting in ${hrsToKick.toFixed(1)} hours `
          + `(${r.sport_key || 'unknown sport'}, ${r.market || 'market unknown'}, kicks off ${r.commence_time || 'at an unknown time'}). `
          + 'The scheduler is keeping its cadence; that cadence cannot serve this rung, and the reader reports '
          + 'those quotes as aging rather than current. Not a fault.',
          null);
      } else {
        add('the board is being captured',
          state,
          `the newest capture on an upcoming game is ${age} old, against a ${limit}-minute limit `
          + `for a game starting in ${hrsToKick < 24 ? hrsToKick.toFixed(1) + ' hours' : (hrsToKick / 24).toFixed(1) + ' days'}`
          /* which game: a STALE verdict at 01:39 UTC on a Wednesday read as a
             football board nobody was capturing, and was a tennis match — the
             board's sports are not all football, and the sport is the first
             thing the operator needs to know */
          + ` (${r.sport_key || 'unknown sport'}, ${r.market || 'market unknown'}, kicks off ${r.commence_time || 'at an unknown time'})`,
          state === 'CURRENT' ? null
            /* the age is past what the cadence can account for, so this really
               is a caller that has stopped rather than a rung the cadence
               never served */
            : `${Math.round(ageMin)} minutes is beyond the ${cadence}-minute cadence for this tier, so capture is `
              + 'not being called on it. Read the next check first — it says whether capture is refusing its '
              + 'callers or simply not being called. Then apply supabase/capture_cron.sql and check '
              + 'cron.job_run_details; the GitHub backup is .github/workflows/capture.yml.');
      }
    }
  }

  /* ---- 3b. is capture ABLE to accept its scheduler? ---------------------
     A stale board has two completely different causes that look identical
     from the signals table: nothing is CALLING capture, or everything is
     calling it and capture is REFUSING them all. The second happens whenever
     the function is deployed without CRON_SECRET, and it is invisible to
     every other check here — pg_cron reports a successful HTTP POST, the
     workflow reports a 401 nobody reads, and the board just stops filling.

     Capture says which one it is in the body of its own 401, so this asks it.
     The request carries NO credential on purpose: the auth gate is the first
     thing in the handler and `CRON_SECRET !== ""` is the left side of its
     &&, so an unauthenticated call is refused on both branches and can never
     reach a sport list, an odds request or a write. It costs one 401. */
  {
    const cap = await get(`${url}/functions/v1/capture`, {}, 8000);
    let reason = '', servingBuild = '';
    try {
      const j = JSON.parse(cap.text) || {};
      reason = String(j.reason || '');
      servingBuild = String(j.build || '');
    } catch (_) { /* below */ }

    /* Capture stamps its build into the 401, so the merged-is-not-deployed
       question is answerable here for free. Only asked when it answered. */
    const wantCap = expectedCaptureBuild();
    if (servingBuild && wantCap) {
      add('deployed capture matches this checkout',
        servingBuild === wantCap ? 'CURRENT' : 'STALE',
        servingBuild === wantCap ? `both are ${wantCap}`
          : `deployed ${servingBuild}, this checkout would deploy ${wantCap}`,
        servingBuild === wantCap ? null : 'supabase functions deploy capture --no-verify-jwt');
    }

    if (cap.status === 0) {
      add('capture can accept its scheduler', 'UNKNOWN', cap.error || 'no response');
    } else if (cap.status === 404) {
      add('capture can accept its scheduler', 'NOT_DEPLOYED',
        `HTTP 404 from ${url}/functions/v1/capture`,
        'supabase functions deploy capture --no-verify-jwt');
    } else if (cap.status === 401 && /CRON_SECRET is not set/.test(reason)) {
      add('capture can accept its scheduler', 'MISSING',
        'capture is deployed but holds no CRON_SECRET, so it refuses EVERY caller including pg_cron and '
        + '.github/workflows/capture.yml. This alone empties the board; no amount of scheduling fixes it.',
        'supabase secrets set CRON_SECRET=<value>, then set the same value as edgedesk.cron_secret for the '
        + 'database (supabase/capture_cron.sql step 3) and as the CAPTURE_CRON_SECRET Actions secret.');
    } else if (cap.status === 401) {
      add('capture can accept its scheduler', 'ARMED',
        'capture holds a CRON_SECRET and refused this unauthenticated probe, which is correct. The function '
        + 'side is healthy, so a stale board above is a caller that is not firing or not matching.');
    } else {
      add('capture can accept its scheduler', 'UNKNOWN',
        `HTTP ${cap.status} from capture rather than the expected 401`);
    }
  }

  /* ---- 4. the artifacts the desk reads over HTTP ----------------------- */
  for (const [label, p] of [['FBS slate', '/football/fbs/slate.json'], ['availability', '/football/availability/current.json']]) {
    const a = await get(site + p, { accept: 'application/json' });
    /* A 404 IS AN ABSENT FILE. A 403 IS SOMEBODY ELSE SAYING NO.
       An egress proxy, a corporate gateway or a CDN rule all answer 403 to a
       file that is sitting there perfectly well, and reporting that as MISSING
       would send an operator to redeploy an artifact that never moved. The
       whole point of this tool is to stop calling one thing another. */
    if (a.status === 0) add(`${label} artifact published`, 'UNKNOWN', a.error || 'no response');
    else if (a.status === 404 || a.status === 410) {
      add(`${label} artifact published`, 'MISSING', `HTTP ${a.status} from ${site}${p}`,
        'The desk reads this over HTTP; without it the CFB slate falls back to cfb.games.');
    } else if (!a.ok) {
      add(`${label} artifact published`, 'UNKNOWN',
        `HTTP ${a.status} from ${site}${p} — refused rather than absent, so this says nothing about whether the file is published`,
        a.status === 403 || a.status === 407
          ? 'Run this from somewhere with direct network access to the site; a proxy is answering for it.' : null);
    }
    else {
      let n = null, gen = null;
      try { const j = JSON.parse(a.text); n = (j.games || []).length || Object.keys(j.teams || {}).length || null; gen = j.generated_at || null; } catch (_) { /* ignore */ }
      add(`${label} artifact published`, 'PUBLISHED', `${n == null ? 'served' : n + ' entries'}${gen ? ', generated ' + gen : ''}`);
    }
  }

  const bad = out.checks.filter((c) => /NOT_DEPLOYED|NOT_APPLIED|STALE|MISSING|ABSENT|EMPTY|FAILING/.test(c.state));
  out.verdict = bad.length ? 'ACTION NEEDED' : out.checks.some((c) => c.state === 'UNKNOWN') ? 'INCOMPLETE' : 'DEPLOYED AND CURRENT';
  return out;
}

/* GitHub workflow-command lines for one doctor result.
 *
 * WHY THIS IS NOT COSMETIC. The doctor workflow used to run the doctor TWICE:
 * once to produce the report, and once more with its output sent to /dev/null
 * purely to set the exit code. So the step that went red printed nothing at
 * all — "Process completed with exit code 1" and not one word about which
 * check failed — while the report sat in a different step's summary. A monitor
 * whose failure does not say what failed makes you go and find out, which is
 * the job it was supposed to be doing for you.
 *
 * `::error::` puts the failing check on the run itself, so the runs list is
 * readable without opening anything. A check the doctor could not determine is
 * a `::warning::` and never an error: UNKNOWN means nobody asked the question
 * successfully, which is not the same as a failure and must not be dressed up
 * as one. */
function annotations(r) {
  const out = [];
  const one = (level, c) =>
    `::${level}::${c.name} — ${String(c.state)}`
    + (c.detail ? ': ' + c.detail : '')
    + (c.fix ? ' | fix: ' + c.fix : '');
  const bad = (r.checks || []).filter((c) => /NOT_DEPLOYED|NOT_APPLIED|STALE|MISSING|ABSENT|EMPTY|FAILING/.test(c.state));
  const unknown = (r.checks || []).filter((c) => c.state === 'UNKNOWN');
  bad.forEach((c) => out.push(one('error', c)));
  unknown.forEach((c) => out.push(one('warning', c)));
  /* The verdict last, so it is the line nearest the summary. A run that found
     nothing wrong still says so — silence reads the same as not having run. */
  out.push(`::notice::VERDICT: ${r.verdict}`
    + (bad.length ? ` — ${bad.length} check(s) need action` : '')
    + (unknown.length ? `, ${unknown.length} undetermined` : ''));
  return out;
}

module.exports = { doctor, expectedBuild, expectedCaptureBuild, annotations };

if (require.main === module) {
  doctor().then((r) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(r, null, 1));
      /* --json USED TO EXIT 0 WHATEVER IT FOUND. A caller that asked for the
         machine-readable form and then trusted the exit code was told every
         run was fine. Same verdict, same code, both forms. */
      process.exit(r.verdict === 'ACTION NEEDED' ? 1 : 0);
    }
    console.log('EDGEDESK DEPLOYMENT DOCTOR — merged is not deployed\n');
    console.log('this checkout would deploy: ' + r.expected_build + '\n');
    r.checks.forEach((c) => {
      console.log('  ' + String(c.state).padEnd(14) + c.name);
      if (c.detail) console.log('                 ' + c.detail);
      if (c.fix) console.log('                 fix: ' + c.fix);
    });
    console.log('\n  VERDICT: ' + r.verdict);
    /* One line per failing check, in the form GitHub renders against the run
       itself, so the runs list says WHAT is wrong without anyone opening a
       step. Off unless asked for, so the other callers of this file
       (deploy-intelligence.yml runs it too) do not sprout annotations. */
    if (process.argv.includes('--annotate')) annotations(r).forEach((l) => console.log(l));
    process.exit(r.verdict === 'ACTION NEEDED' ? 1 : 0);
  }).catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(2); });
}

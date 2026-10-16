#!/usr/bin/env node
/* ===========================================================================
   supabase/discord.sql, discord_samples.sql and discord_cron.sql, AGAINST A
   REAL POSTGRESQL.

   What is pinned:
     · a post key is claimed once; only a REJECTED send (failed) may be
       claimed again, a capped number of times; unknown / partial never; only
       an operator can release one, and never a sent one
     · the log is insert-only for the service role, closed to readers, and
       refuses a row that carries a webhook URL
     · the sample ledger cannot be cherry-picked: sightings and selections are
       append-only and stamped by the database clock; a selection is written
       once, with its samples, in one transaction, its detection time and line
       copied from the sighting; a sample's decided columns are frozen, its
       outcomes written once, its status forward-only, nothing deleted, and
       nothing posted later than 60 minutes before kickoff
     · the cron jobs fire at 10:00 Central under CDT and CST, call
       discord_cron with the Vault secret and no other key, refuse without it,
       and re-running the file replaces the jobs

   pg_cron, pg_net and Vault are stood in for by cron.job, net.posted and
   vault.secrets (the pattern of tools/personal/research_cron_sql.test.js).

   Run: node tools/discord/discord_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require('../personal/_pg.js');

const T = PG.kit('discord SQL');
const chk = T.chk;
const F = (n) => path.join(PG.ROOT, 'supabase', n);
const FILES = ['discord.sql', 'discord_samples.sql', 'discord_cron.sql'];
const URL = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/discord_cron';

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
for (const f of FILES) {
  const s = fs.readFileSync(F(f), 'utf8');
  chk(`${f}: no psql meta-commands`, !/^\s*\\/m.test(s));
  chk(`${f}: under the SQL editor paste limit (18 KB)`, Buffer.byteLength(s) <= 18000, Buffer.byteLength(s));
  chk(`${f}: additive — no table, column or index is dropped, nothing deleted`, !/\bdrop (table|column|index|schema)\b/i.test(s) && !/\bdelete from\b/i.test(s) && !/\btruncate\b/i.test(s));
  chk(`${f}: ends in its report`, /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(`${f}: commits no key`, !/eyJ[A-Za-z0-9_-]{10,}/.test(s) && !/discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{10,}/.test(s) && !/github_pat_|ghp_[A-Za-z0-9]{10,}/.test(s));
}
const CRON = fs.readFileSync(F('discord_cron.sql'), 'utf8');
chk('discord_cron.sql calls the function at the project URL, reads Vault, no database setting', CRON.includes(`'${URL}'`) && /vault\.decrypted_secrets/.test(CRON) && !/current_setting\(/.test(CRON));

const db = PG.start('dscsql');
if (db.skip) {
  if (process.env.DISCORD_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscsql-'));
const cronFile = path.join(dir, 'cron.sql');
fs.writeFileSync(cronFile, CRON.replace(/^create extension if not exists pg_(cron|net);$/mg, ''));
fs.chmodSync(dir, 0o755); fs.chmodSync(cronFile, 0o644);
const ok = (out, n) => !/CHECK THIS/.test(out) && (out.match(/\|ok$/mg) || []).length === n;
const fails = (fn, re) => { const e = db.mustFail(fn); return e !== null && (!re || re.test(e)); };

try {
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid serial, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    create schema if not exists net;
    create table if not exists net.posted (url text, body jsonb, headers jsonb, timeout_ms integer);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
      language sql as $$ insert into net.posted values (url, body, headers, timeout_milliseconds); select 1::bigint $$;
    create schema if not exists vault;
    create table if not exists vault.secrets (name text primary key, secret text);
    create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
    insert into cron.job (jobname, schedule, command) values ('discord_slate', '0 9 * * *', 'select 1');`);

  /* ── ORDER ─────────────────────────────────────────────────────────────── */
  chk('discord_samples.sql refuses before discord.sql, naming it', fails(() => db.applyFileAtomic(F('discord_samples.sql')), /discord\.sql first/));
  chk('discord_cron.sql refuses before the tables, naming them', fails(() => db.applyFileAtomic(cronFile), /discord_samples\.sql first/)
    && db.sql("select schedule from cron.job where jobname = 'discord_slate';") === '0 9 * * *');

  let out = db.applyFileAtomic(F('discord.sql'));
  chk('discord.sql applies; all five report rows ok', ok(out, 5), out);
  chk('…and again (idempotent)', ok(db.applyFileAtomic(F('discord.sql')), 5));
  out = db.applyFileAtomic(F('discord_samples.sql'));
  chk('discord_samples.sql applies; all five report rows ok', ok(out, 5), out);
  chk('…and again (idempotent)', ok(db.applyFileAtomic(F('discord_samples.sql')), 5));

  /* ── THE CLAIM ─────────────────────────────────────────────────────────── */
  const claim = (k) => JSON.parse(db.service(`select public.discord_claim_post('${k}', 'DISCORD_WEBHOOK_NFL', 'slate', '2026-10-18');`));
  const finish = (k, st) => db.service(`select public.discord_finish_post('${k}', '${st}', array['m1'], null);`);
  let c = claim('slate:NFL:2026-10-18');
  chk('the first claim of a key wins', c.claimed === true && c.attempts === 1);
  chk('a second claim of the same key is refused (the rerun posts nothing)', claim('slate:NFL:2026-10-18').claimed === false);
  chk('finishing as sent', finish('slate:NFL:2026-10-18', 'sent') === 't' && claim('slate:NFL:2026-10-18').state === 'sent');
  chk('finish only moves a claimed key', finish('slate:NFL:2026-10-18', 'failed') === 'f' && claim('slate:NFL:2026-10-18').state === 'sent');
  claim('k:failed'); finish('k:failed', 'failed');
  c = claim('k:failed');
  chk('a REJECTED send may be claimed again', c.claimed === true && c.attempts === 2);
  finish('k:failed', 'failed'); claim('k:failed'); finish('k:failed', 'failed');
  chk('…at most three times in all', claim('k:failed').claimed === false);
  claim('k:unknown'); finish('k:unknown', 'unknown');
  claim('k:partial'); finish('k:partial', 'partial');
  chk('an unknown or partial send is never claimed again automatically', claim('k:unknown').claimed === false && claim('k:partial').claimed === false);
  chk('finish refuses a made-up state', fails(() => finish('k:unknown', 'posted')));
  chk('the service role cannot release a key', fails(() => db.service("select public.discord_release_post('k:unknown', 'checked');")));
  chk('…nor rewrite a claim directly', fails(() => db.service("update public.discord_post_claims set state = 'failed' where post_key = 'k:unknown';")));
  chk('an operator release needs a reason', fails(() => db.sql("select public.discord_release_post('k:unknown', '');"), /say why/));
  db.sql("select public.discord_release_post('k:unknown', 'checked the channel: it never appeared');");
  chk('…and makes an unknown key sendable again', claim('k:unknown').claimed === true);
  chk('a sent key can never be released', db.sql("select (public.discord_release_post('slate:NFL:2026-10-18', 'oops')->>'released');") === 'false' && claim('slate:NFL:2026-10-18').state === 'sent');
  chk('readers can neither claim nor read claims', fails(() => db.anon("select public.discord_claim_post('x', 'DISCORD_WEBHOOK_NFL', 'slate', '2026-10-18');"))
    && fails(() => db.as('00000000-0000-0000-0000-00000000000a', 'select count(*) from public.discord_post_claims;')));

  /* ── THE LOG ───────────────────────────────────────────────────────────── */
  const ins = (extra) => db.service(`insert into public.discord_posts (channel, type, status, error, payload) values ('DISCORD_WEBHOOK_CFB', 'slate', 'sent', ${extra || 'null'}, '{"messages":[]}');`);
  chk('the service role writes the log', fails(() => ins()) === false);
  chk('…but cannot change or delete a row', fails(() => db.service("update public.discord_posts set status = 'sent';")) && fails(() => db.service('delete from public.discord_posts;')));
  chk('a webhook URL can never be written into it', fails(() => ins("'HTTP 404 for https://discord.com/api/webhooks/123456/abcdefSECRET'"), /discord_posts_no_webhook_url/));
  chk('a channel must be a webhook secret NAME', fails(() => db.service("insert into public.discord_posts (channel, type, status) values ('https://discord.com/x', 'slate', 'sent');"), /discord_posts_channel/));
  chk('readers cannot see the log', fails(() => db.anon('select count(*) from public.discord_posts;')) && fails(() => db.as('00000000-0000-0000-0000-00000000000a', "insert into public.discord_posts (channel, type, status) values ('DISCORD_WEBHOOK_NFL', 'slate', 'sent');")));

  /* ── THE SAMPLE LEDGER ─────────────────────────────────────────────────── */
  db.service(`insert into public.discord_sample_sightings (sport, game_id, classification, first_seen_at, kickoff_at, home, away, side, line_home, line_source)
    values ('cfb', '1001', 'INVESTIGATE', '2020-01-01', now() + interval '10 hours', 'Tulane', 'Memphis', 'away', 7, 'CFB Lab consensus'),
           ('cfb', '1002', 'INVESTIGATE', now(), now() + interval '2 hours', 'Ohio State', 'Oklahoma State', 'home', -4, 'CFB Lab consensus');`);
  chk('a sighting\'s first_seen_at is the database clock, not the caller\'s', db.sql("select first_seen_at > now() - interval '1 minute' from public.discord_sample_sightings where game_id = '1001';") === 't');
  chk('a second sighting of the same game and class is ignored by the upsert', fails(() => db.service("insert into public.discord_sample_sightings (sport, game_id, classification) values ('cfb', '1001', 'INVESTIGATE') on conflict do nothing;")) === false
    && db.sql("select count(*) from public.discord_sample_sightings;") === '2');
  chk('sightings are append-only, even for the owner', fails(() => db.service("update public.discord_sample_sightings set line_home = 1;"))
    && fails(() => db.sql("update public.discord_sample_sightings set line_home = 1;"), /append-only/) && fails(() => db.sql('delete from public.discord_sample_sightings;'), /append-only/));

  const chosen = JSON.stringify([
    { game_id: '1001', rank: 1, classification: 'INVESTIGATE', reason: 'INVESTIGATE, #1', home: 'Tulane', away: 'Memphis', kickoff_at: db.sql("select (now() + interval '10 hours')::text;"), side: 'away', signal: { factors: ['x'] } },
    { game_id: '1002', rank: 2, classification: 'INVESTIGATE', reason: 'INVESTIGATE, #2', home: 'Ohio State', away: 'Oklahoma State', kickoff_at: db.sql("select (now() + interval '2 hours')::text;"), side: 'home', signal: {} },
  ]).replace(/'/g, "''");
  const record = (sport, date, ch) => JSON.parse(db.service(`select public.discord_record_selection('${sport}', '${date}', 'discord_sample_order_v1', 3, 15, 'DISCORD_WEBHOOK_CFB', '[{"order":1}]', '${ch}', 'note');`));
  chk('the service role cannot write a selection or a sample directly', fails(() => db.service("insert into public.discord_sample_selections (sport, slate_date, rule_version, delay_hours, buffer_minutes) values ('cfb', '2026-10-17', 'x', 3, 15);"))
    && fails(() => db.service("insert into public.discord_samples (sport, slate_date, game_id, rank, classification, reason, kickoff_at, detected_at, channel, scheduled_post_at) values ('cfb', '2026-10-17', '9', 1, 'MONITOR', 'r', now(), now(), 'DISCORD_WEBHOOK_CFB', now());")));
  const bad = JSON.stringify([{ game_id: '1001', rank: 1, classification: 'INVESTIGATE', reason: 'r', kickoff_at: '2030-01-01T00:00:00Z' }, { game_id: '7777', rank: 2, classification: 'INVESTIGATE', reason: 'r', kickoff_at: '2030-01-01T00:00:00Z' }]);
  chk('a chosen game with no sighting refuses the whole selection', fails(() => record('cfb', '2026-10-16', bad), /no sighting/)
    && db.sql("select count(*) from public.discord_sample_selections;") === '0' && db.sql('select count(*) from public.discord_samples;') === '0');
  chk('more than two samples a slate is refused', fails(() => record('cfb', '2026-10-16', JSON.stringify([{}, {}, {}])), /at most 2/));
  const r1 = record('cfb', '2026-10-17', chosen);
  chk('a selection is recorded with its samples', r1.created === true && r1.samples === 2 && db.sql("select count(*) from public.discord_samples;") === '2');
  chk('…detection time and line copied from the sighting', db.sql("select (detected_at = (select first_seen_at from public.discord_sample_sightings where game_id = '1001'))::text || '|' || line_at_detection from public.discord_samples where game_id = '1001';") === 'true|7.00');
  chk('…scheduled at detection + delay, or kickoff - 75 min if that is sooner', db.sql(`select (scheduled_post_at = detected_at + interval '3 hours')::text from public.discord_samples where game_id = '1001';`) === 'true'
    && db.sql(`select (scheduled_post_at = kickoff_at - interval '75 minutes')::text from public.discord_samples where game_id = '1002';`) === 'true');
  const r2 = record('cfb', '2026-10-17', '[]');
  chk('a second selection for the slate changes nothing', r2.created === false && r2.samples === 2 && db.sql("select jsonb_array_length(chosen) from public.discord_sample_selections;") === '2');
  chk('a selection is append-only', fails(() => db.sql("update public.discord_sample_selections set chosen = '[]';"), /append-only/) && fails(() => db.sql('delete from public.discord_sample_selections;'), /append-only/));

  const upd = (set, id) => db.service(`update public.discord_samples set ${set} where game_id = '${id || '1001'}';`);
  chk('what was decided at selection is frozen', fails(() => upd("game_id = '1003'"), /frozen/) && fails(() => upd("side = 'home'"), /frozen/)
    && fails(() => upd("line_at_detection = 9"), /frozen/) && fails(() => upd("scheduled_post_at = now()"), /frozen/) && fails(() => upd("detected_at = now()"), /frozen/));
  chk('posting needs its time and message', fails(() => upd("status = 'posted'"), /discord_samples_posted/));
  chk('never posted later than 60 minutes before kickoff', fails(() => upd("status = 'posted', posted_at = kickoff_at - interval '30 minutes', message_id = 'm1'"), /post_window/));
  upd("status = 'posted', posted_at = now(), message_id = 'm1', line_at_post = 7.5");
  chk('a sample is posted once', db.sql("select status from public.discord_samples where game_id = '1001';") === 'posted');
  chk('…its outcome columns are written once', fails(() => upd("message_id = 'm2'"), /written once/) && fails(() => upd("line_at_post = 8"), /written once/));
  chk('…its status only moves forward', fails(() => upd("status = 'scheduled'"), /cannot move/) && fails(() => upd("status = 'missed', miss_reason = 'x'"), /cannot move/));
  upd("thread_id = 'm1'");
  upd("status = 'followed_up', followup_at = now(), close_line = 8.5, clv_at_detection = 1.5, clv_at_post = 1");
  chk('…and the follow-up records the close and CLV once', db.sql("select status || '|' || clv_at_post from public.discord_samples where game_id = '1001';") === 'followed_up|1.00'
    && fails(() => upd('clv_at_post = 3'), /written once/));
  chk('a missed sample says why', fails(() => upd("status = 'missed'", '1002'), /discord_samples_missed/));
  upd("status = 'missed', miss_reason = 'no fresh consensus line before the post window closed'", '1002');
  chk('nothing is ever deleted, even by the owner', fails(() => db.service('delete from public.discord_samples;')) && fails(() => db.sql('delete from public.discord_samples;'), /never deleted/));
  chk('readers cannot see the ledger', fails(() => db.anon('select count(*) from public.discord_samples;')) && fails(() => db.as('00000000-0000-0000-0000-00000000000a', 'select count(*) from public.discord_sample_sightings;')));

  /* ── THE SCHEDULES ─────────────────────────────────────────────────────── */
  out = db.applyFileAtomic(cronFile);
  chk('discord_cron.sql applies; without the Vault secret its report says CHECK THIS on that row only', (out.match(/CHECK THIS/g) || []).length === 1 && /5\|the Vault secret discord_cron_secret is present\|0\|1\|CHECK THIS/.test(out), out);
  chk('a poke without the Vault secret raises: nothing is sent', fails(() => db.sql("select public.discord_poke('slate');"), /discord_cron_secret is missing/) && db.sql('select count(*) from net.posted;') === '0');
  db.sql("insert into vault.secrets values ('discord_cron_secret', 'the-shared-secret');");
  out = db.applyFileAtomic(cronFile);
  chk('with the secret all five report rows are ok, and re-running replaced the jobs', ok(out, 5) && db.sql("select count(*) from cron.job where jobname like 'discord_%';") === '3', out);
  chk('the scorecard fires Mondays at :00 and :30 in 15 and 16 UTC (10:00 CT under CDT and CST)', db.sql("select schedule from cron.job where jobname = 'discord_scorecard';") === '0,30 15,16 * * 1');
  chk('the slate fires daily in the same window', db.sql("select schedule from cron.job where jobname = 'discord_slate';") === '0,30 15,16 * * *');
  chk('the samples tick every 15 minutes', db.sql("select schedule from cron.job where jobname = 'discord_samples';") === '4,19,34,49 * * * *');
  for (const [job, action] of [['discord_scorecard', 'scorecard'], ['discord_slate', 'slate'], ['discord_samples', 'samples']]) {
    db.sql('truncate net.posted;');
    db.sql(`do $$ begin execute (select command from cron.job where jobname = '${job}'); end $$;`);
    chk(`${job} posts to discord_cron with the action '${action}', the Vault secret as x-cron-secret, and no other key`,
      db.sql("select url || '|' || (body->>'action') || '|' || (headers->>'x-cron-secret') || '|' || (headers ? 'authorization')::text || '|' || timeout_ms from net.posted;") === `${URL}|${action}|the-shared-secret|false|150000`);
  }
  chk('discord_poke refuses an unknown action', fails(() => db.sql("select public.discord_poke('drop');"), /action must be/));
  chk('no API role can poke', fails(() => db.anon("select public.discord_poke('slate');")) && fails(() => db.service("select public.discord_poke('slate');")));
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 800));
} finally { db.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(T.done());

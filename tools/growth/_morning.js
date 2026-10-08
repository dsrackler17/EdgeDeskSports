'use strict';
/* ===========================================================================
   The morning run, for the Edge Function tests: stand in for pg_net (record
   what the tick asks it to send), turn automation on with a window around
   the real clock, and tick — the REAL growth_outbound.schedule_tick, so the
   ticket a test hands the function is one the database minted.
   =========================================================================== */
const { lit } = require('../personal/_pg.js');

const BASE = 'https://proj.supabase.co/functions/v1/';
// a fixed zone where the real clock reads 12:xx, so a run started now is "this morning" there
function middayZone() {
  const h = new Date().getUTCHours(), k = h <= 12 ? 12 - h : 36 - h > 14 ? 12 - h : 36 - h;
  return k === 0 ? 'Etc/GMT' : k > 0 ? 'Etc/GMT-' + k : 'Etc/GMT+' + (-k);
}
function install(db) {
  db.sql(`create schema if not exists net;
    create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
    create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                             headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds)
                                       values (url, body, headers, timeout_milliseconds) returning id $$;
    update growth_outbound.settings set automation_enabled = true, automation_timezone = ${lit(middayZone())},
           automation_start_hour = 11, automation_hours = 3 where id = 1;`);
}
// one tick; the ticket it posted (or null), and to which function
function tick(db) {
  const r = JSON.parse(db.sql(`select growth_outbound.schedule_tick(${lit(BASE)}, now());`));
  if (r.action !== 'started') return { r, ticket: null, fn: null };
  const c = JSON.parse(db.sql(`select to_jsonb(c) from net.calls c order by id desc limit 1;`));
  return { r, ticket: c.body.ticket, fn: c.url.slice(BASE.length) };
}
module.exports = { install, tick, BASE, middayZone };

/* ===========================================================================
   One clock for a test's whole world. A suite that reads the frozen week
   (ART.frozen()) at a pinned moment also runs code that reads the clock
   itself: the Edge Function, as deployed, judges a draft at Date.now(), and
   the database's doors at now() (an opportunity expires at its first kickoff,
   so content_engine_job_targets stops offering it). Left on the wall clock,
   those disagree with the research the moment its games kick off.

     node(at)          this process's Date reads `at` plus the time since the
                       call (new Date() and Date.now(); a date given
                       explicitly is untouched)
     database(db, at)  the throwaway PostgreSQL's now() does the same (its
                       transaction time, moved back): every door, default
                       and trigger reads it

   The clock keeps running from `at`, so order and elapsed time are real. Only
   for throwaway test databases: database() replaces pg_catalog.now().
   =========================================================================== */
'use strict';

const RealDate = Date;

function node(at) {
  const off = (typeof at === 'number' ? at : Date.parse(at)) - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + off); }
    static now() { return RealDate.now() + off; }
  }
  global.Date = PinnedDate;
  return off;
}

function database(db, at) {
  const ms = Math.round(RealDate.now() - (typeof at === 'number' ? at : Date.parse(at)));
  db.sql(`create or replace function pg_catalog.now() returns timestamptz language sql stable parallel safe
            as $$ select pg_catalog.transaction_timestamp() - interval '${ms} milliseconds' $$;`);
  return ms;
}

module.exports = { node, database };

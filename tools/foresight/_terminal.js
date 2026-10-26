'use strict';
/* ===========================================================================
   Market Foresight, for the terminal's journey test (tools/research_os/
   journey.e2e.js). Everything that names the layer stays in this directory
   (tools/foresight/isolation.test.js): the journey test asks this module to
   install the SHIPPED migration, measure a real committed game with the
   SHIPPED worker, switch the mode through the operator's own door, and tell
   which requests are this layer's.

     install(db)                      supabase/market_foresight.sql, applied twice,
                                      every report row ok (the billing rule and
                                      the operator list must already be in place)
     measure(db, stand, adminId)      a finished CFB game from the committed
                                      ledgers, with test-seeded Kalshi quotes and
                                      Collective models (_scenario.js), run through
                                      the worker; returns { sport, eventId, home, away }
     mode(db, adminId, m)             'shadow' | 'live' | 'off', by mf_admin_set_mode
     owns(url)                        true for this layer's doors
     gameDoor(sport, id)              [path, args] of one game's record door
     readsRecord(url)                 true when a request read a game's record
   =========================================================================== */
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const RUN = require(path.join(__dirname, 'run.js'));
const SC = require(path.join(__dirname, '_scenario.js'));
const lit = PG.lit;
const quiet = { log: () => {}, error: () => {} };

function install(db) {
  let out = db.applyFile(path.join(ROOT, 'supabase', 'market_foresight.sql'));
  if (/CHECK THIS/.test(out)) throw new Error('market_foresight.sql: ' + out.slice(-600));
  out = db.applyFile(path.join(ROOT, 'supabase', 'market_foresight.sql'));
  if (/CHECK THIS/.test(out)) throw new Error('market_foresight.sql (second apply): ' + out.slice(-600));
  return true;
}
async function measure(db, stand, adminId) {
  const picked = SC.pickGame([]);
  if (!picked.pick) throw new Error('no committed game qualifies for the scenario');
  const seeded = SC.seed(db, picked.pick, picked.local);
  const env = { SB_URL: 'http://standin', SB_SERVICE_ROLE: stand.SERVICE };
  const go = () => RUN.execute({ write: true, dry: false, now: SC.NOW, since: '2026-08-01T00:00:00.000Z', cache: null, trigger: 'test' }, env, Object.assign({ fetchImpl: SC.collectiveFetch(stand), sleep: async () => {} }, quiet));
  if (await go() !== 0) throw new Error('the worker did not store the record');
  const digest = crypto.createHash('sha256').update(seeded.RULES, 'utf8').digest('hex');
  db.as(adminId, 'select public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNCAAFGAME', sport: 'cfb', rules_sha256: digest, overtime: 'included', tie: 'impossible', note: 'journey e2e (test-seeded market)' })) + '::jsonb);');
  if (await go() !== 0) throw new Error('the worker did not store the record after verification');
  return { sport: 'cfb', eventId: picked.pick.event_id, home: picked.pick.home, away: picked.pick.away };
}
function mode(db, adminId, m) { return db.as(adminId, 'select public.mf_admin_set_mode(' + lit(m) + ', ' + lit('journey e2e') + ');'); }
function owns(url) { return /\/rest\/v1\/rpc\/mf_[a-z_]+/.test(url); }
/* one game's door and its arguments, and whether a request read a game's record */
function gameDoor(sport, eventId) { return ['rpc/mf_game', { p_sport: sport, p_event_id: String(eventId) }]; }
function readsRecord(url) { return /\/rpc\/mf_game\b/.test(url); }
/* what the in-app record draws, for the journey test's selectors */
const SEL = { status: '#mf-status', timeline: '#v-foresight .mf-svg', findings: '#v-foresight .mf-units', title: '#mf-title' };

module.exports = { install, measure, mode, owns, gameDoor, readsRecord, SEL };

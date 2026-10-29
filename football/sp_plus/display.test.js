#!/usr/bin/env node
/* ============================================================================
   SP+ DISPLAY RULE — lib/cfb_sp_plus.js rowFor() and fetchLines(): what a
   card shows, and every reason it shows "unavailable" instead. Offline.

   Run: node football/sp_plus/display.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const SP = require('../../lib/cfb_sp_plus.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

const CAP = '2026-10-26T15:17:00.000Z', NOW = Date.parse('2026-10-28T20:00:00.000Z');
function doc(over) {
  return Object.assign({
    schema: 'edgedesk_cfb_sp_plus_lines_v1', status: 'OK', season: 2026,
    last_attempt: { at: CAP, week_key: '2026:0:09', status: 'OK', reason: null },
    snapshot: { season: 2026, week: 9, week_key: '2026:0:09', captured_at: CAP, source_version: 'cfbd-ratings-sp:2026:abcdef012345' },
    games: {
      401871058: { home: 'Middle Tennessee', away: 'Kennesaw State', week: 9, week_key: '2026:0:09', state: 'AVAILABLE', reason: null, home_margin: 1.3, home_line: -1.3 },
      401869963: { home: 'James Madison', away: 'Troy', week: 9, week_key: '2026:0:09', state: 'AVAILABLE', reason: null, home_margin: 16.8, home_line: -16.8 },
      F1: { home: 'James Madison', away: 'Wagner', week: 9, week_key: '2026:0:09', state: 'UNAVAILABLE', reason: 'no SP+ rating for Wagner (FCS: SP+ rates FBS teams)', home_margin: null, home_line: null },
      OLD: { home: 'A', away: 'B', week: 8, week_key: '2026:0:08', state: 'AVAILABLE', reason: null, home_margin: 3, home_line: -3 }
    }
  }, over || {});
}

/* ------------------------------------------------------------ available */
{
  const r = SP.rowFor('401871058', { doc: doc(), now: NOW, edgedesk_home_margin: 4.52 });
  eq([r.state, r.text, r.home_line], ['AVAILABLE', 'Middle Tennessee −1.3', -1.3], 'the line, named for its favourite');
  eq(r.source_text, 'SP+ week 9 · captured 2026-10-26', 'with the SP+ week and the capture date');
  eq(r.tier_text, 'T3 external model · T2 computed line', 'labelled external (T3) and computed (T2)');
  eq(r.attribution, 'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.', 'with the attribution, word for word');
  eq([r.disagree, r.disagreement.points], [true, 3.22], 'EdgeDesk 4.5 vs SP+ 1.3: Models disagree');
  ok(/3\.2 points apart\. The two numbers are never combined\./.test(r.disagree_text), 'and says so in plain words', r.disagree_text);
  const near = SP.rowFor('401869963', { doc: doc(), now: NOW, edgedesk_home_margin: 15.0 });
  eq([near.text, near.disagree, near.disagree_text], ['James Madison −16.8', false, null], 'within 3 points: no disagreement note');
  const none = SP.rowFor('401869963', { doc: doc(), now: NOW });
  eq([none.state, none.disagreement, none.disagree], ['AVAILABLE', null, false], 'no EdgeDesk number: the line shows, no comparison is made');
  eq(SP.rowFor('401871058', { doc: doc(), now: NOW, home: 'MTSU', away: 'KSU' }).text, 'MTSU −1.3', 'a surface may print its own team names');
  ok(!('average' in r) && !('blend' in r) && !('combined' in r), 'nothing in the row combines the two numbers');
}

/* ---------------------------------------------- every unavailable reason */
{
  const U = (gid, d, now, why) => {
    const r = SP.rowFor(gid, { doc: d, now: now == null ? NOW : now, edgedesk_home_margin: 4.52 });
    ok(r.state === 'UNAVAILABLE' && r.text === null && r.home_line === null && r.attribution === null && !r.disagree, why + ': unavailable, and no number', r);
    return r.reason;
  };
  ok(/did not load/.test(U('401871058', null, null, 'no file')), 'no file: says the file did not load');
  ok(/not one this page reads/.test(U('401871058', doc({ schema: 'x' }), null, 'unknown schema')), 'an unknown file is refused');
  ok(/not been synced yet/.test(U('401871058', doc({ snapshot: null, last_attempt: null, status: 'NEVER_SYNCED' }), null, 'never synced')), 'never synced: says so');
  ok(/the SP\+ sync failed: CollegeFootballData answered HTTP 500/.test(U('401871058', doc({ snapshot: null, last_attempt: { status: 'FAILED', reason: 'CollegeFootballData answered HTTP 500', week_key: '2026:0:09' } }), null, 'first sync failed')),
    'the first sync failed: says why');
  ok(/stale: the last SP\+ capture is week 9 \(2026-10-26\), older than the current week/.test(U('401871058', doc(), Date.parse('2026-11-04T16:00:00.000Z'), 'stale capture')),
    'a capture older than 8 days is stale, never shown');
  ok(/lines are published for week 9, the captured week, only/.test(U('W10', doc(), null, 'next week')), 'a game from another week: no line, and why');
  ok(/the sync for week 10 failed \(CollegeFootballData answered HTTP 503\)/.test(U('W10', doc({ status: 'FAILED', last_attempt: { status: 'FAILED', week_key: '2026:0:10', reason: 'CollegeFootballData answered HTTP 503' } }), null, 'next week failed')),
    'a newer week whose sync failed: says it failed, and why');
  ok(/found SP\+ not yet updated/.test(U('W10', doc({ status: 'UNCHANGED', last_attempt: { status: 'UNCHANGED', week_key: '2026:0:10', reason: 'x' } }), null, 'not updated')),
    'a newer week where SP+ had not updated: says so');
  ok(/stale: this line is from week 8/.test(U('OLD', doc(), null, 'an older week’s entry')), 'an entry from an older week is never shown');
  ok(/no SP\+ rating for Wagner \(FCS/.test(U('F1', doc(), null, 'FCS opponent')), 'an FCS opponent: the entry’s own reason');
  ok(/stale/.test(U('401871058', doc(), NaN, 'no clock')), 'without a readable clock nothing is shown');
}

/* -------------------------------------------------- the file and the clock */
(async () => {
  {
    const calls = [];
    const f = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => doc() }; };
    const d1 = await SP.fetchLines('/x/lines.json', f), d2 = await SP.fetchLines('/x/lines.json', f);
    eq([calls.length, d1 === d2], [1, true], 'fetchLines reads a URL once per page');
    eq(SP.rowFor('401871058', { now: NOW }).state, 'AVAILABLE', 'and rowFor reads the loaded file');
    const bad = async () => ({ ok: false, status: 404, json: async () => null });
    let threw = false;
    try { await SP.fetchLines('/y/lines.json', bad); } catch (_) { threw = true; }
    ok(threw, 'a failed read rejects');
    eq(SP.rowFor('401871058', { now: NOW }).reason, 'the SP+ file did not load', 'and leaves no file: every row says unavailable');
    eq(SP.URL, '/football/sp_plus/lines.json', 'the file every surface reads');
  }
  /* the committed file parses and reads as the page reads it */
  {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, 'lines.json'), 'utf8'));
    eq(committed.schema, SP.SCHEMA, 'the committed lines.json is the schema the page reads');
    ok(SP.rowFor('401871058', { doc: committed, now: NOW }).state === 'UNAVAILABLE' || committed.snapshot, 'until the first sync, every card says unavailable');
  }
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

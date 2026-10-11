#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_saved_research.js (EDSaved) with a stubbed fetch: the request
   it sends for each call, and the reason it gives when the account save is
   not possible. The table's own rules are proven on PostgreSQL by
   saved_research_sql.test.js.
   Run: node tools/intelligence/saved_research_client.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_saved_research.js'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
let sent = [], reply = { status: 201, body: [{ id: '11111111-2222-3333-4444-555555555555', title: 'x' }] };
const fakeFetch = (url, init) => { sent.push({ url, init }); if (reply.throw) return Promise.reject(new Error('down')); return Promise.resolve({ ok: reply.status < 300, status: reply.status, text: () => Promise.resolve(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) }); };
let token = 'user-jwt';
S.configure({ url: 'https://sb.test', key: 'anon-key', token: () => token, fetch: fakeFetch });

(async function main() {
  sent = [];
  let r = await S.save({ kind: 'desk_answer', title: 'Jets @ Patriots', sport: 'americanfootball_nfl', game_id: '2026_06_NYJ_NE', question: 'Is NE -7 worth it?', answer: 'No.', payload: { route: { tier: 'LITE' } } });
  ok('a signed-in reader saves to their account', r.ok === true && r.row && r.row.id, r);
  const s0 = sent[0];
  ok('it posts to saved_research under the reader’s own token', s0.url === 'https://sb.test/rest/v1/saved_research' && s0.init.method === 'POST' && s0.init.headers.authorization === 'Bearer user-jwt' && s0.init.headers.apikey === 'anon-key', s0);
  const body = JSON.parse(s0.init.body);
  ok('and never sends a reader id (RLS sets it)', !('user_id' in body) && body.kind === 'desk_answer' && body.title === 'Jets @ Patriots', body);
  token = 'anon-key'; sent = [];
  r = await S.save({ kind: 'note', title: 'x' });
  ok('the public key is not an account: nothing is sent, the reason says sign in', r.ok === false && /sign in/.test(r.why) && sent.length === 0, r);
  token = 'user-jwt';
  reply = { status: 404, body: { message: 'relation does not exist' } };
  r = await S.save({ kind: 'note', title: 'x' });
  ok('a table that is not deployed says so', r.ok === false && /not set up on the server/.test(r.why), r);
  reply = { status: 401, body: {} };
  r = await S.save({ kind: 'note', title: 'x' });
  ok('a session the server refuses says sign in again', r.ok === false && /sign in again/.test(r.why), r);
  reply = { status: 400, body: { message: 'saved_research: 500 saved items is the limit; delete or archive some first' } };
  r = await S.save({ kind: 'note', title: 'x' });
  ok('the cap is explained in the reader’s words', r.ok === false && /500 saved items/.test(r.why), r);
  reply = { throw: true };
  r = await S.save({ kind: 'note', title: 'x' });
  ok('a network failure is an answer, not an exception', r.ok === false && /could not be reached/.test(r.why), r);
  reply = { status: 201, body: [{ id: '11111111-2222-3333-4444-555555555555' }] };
  ok('an unknown kind is refused before any request', (await S.save({ kind: 'bet', title: 'x' })).ok === false);
  ok('an empty title is refused before any request', (await S.save({ kind: 'note', title: '   ' })).ok === false);
  const big = { s: 'a'.repeat(210000) };
  ok('an item over 200 KB is refused with the reason', /too large/.test((await S.save({ kind: 'fair_line', title: 'x', payload: big })).why || ''));
  sent = [];
  await S.save({ kind: 'note', title: 't'.repeat(400), answer: 'a'.repeat(30000) });
  const b2 = JSON.parse(sent[0].init.body);
  ok('long fields are cut to the table’s limits', b2.title.length === 160 && b2.answer.length === 20000, { t: b2.title.length, a: b2.answer.length });
  reply = { status: 200, body: [{ id: 'a' }, { id: 'b' }] }; sent = [];
  r = await S.list({ limit: 999, kind: 'fair_line' });
  ok('list reads the reader’s own rows, newest first, capped, unarchived', r.ok && r.rows.length === 2 && /order=created_at\.desc/.test(sent[0].url) && /limit=200/.test(sent[0].url) && /archived=is\.false/.test(sent[0].url) && /kind=eq\.fair_line/.test(sent[0].url), sent[0].url);
  ok('a malformed id is refused before any request', (await S.remove("1' or 1=1")).ok === false && (await S.rename('x', 'y')).ok === false && (await S.get('../x')).ok === false);
  reply = { status: 204, body: '' }; sent = [];
  r = await S.remove('11111111-2222-3333-4444-555555555555');
  ok('delete targets exactly one id', r.ok && sent[0].init.method === 'DELETE' && /id=eq\.11111111-2222-3333-4444-555555555555$/.test(sent[0].url), sent[0]);
  sent = [];
  r = await S.rename('11111111-2222-3333-4444-555555555555', 'New title', 'a note');
  ok('rename patches only the title and the note', r.ok && JSON.stringify(Object.keys(JSON.parse(sent[0].init.body)).sort()) === '["note","title"]', sent[0] && sent[0].init.body);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'saved research client — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();

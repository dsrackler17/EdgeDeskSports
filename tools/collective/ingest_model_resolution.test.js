#!/usr/bin/env node
/* ===========================================================================
   THE SLATE FINDS ITS OWN MODEL — collective_ingest, driven for real.

   THE BUG. A slate attaches to a MODEL and the Collective resolves that
   slate's games in that model's sport. collective_ingest chose the model from
   the envelope's `model` field alone: name nothing, own exactly one model, and
   whatever sport the slate said it was, it was filed under that one model. A
   contributor with a college model posting an NFL slate therefore had every
   NFL game looked up in the COLLEGE schedule, every row came back unmatched,
   and nothing anywhere said why. The dashboard's answer was to tell them to
   ask the operator for a model.

   So the sport decides now, and a sport with no model gets one. These are the
   brief's cases, against the DEPLOYED file — imported, not copied, with a Deno
   shim and a mocked PostgREST, the same way tools/capture/capture.test.js
   tests capture. Nothing here reaches a network and nothing here writes.

     C  a contributor posts an NFL slate having never made an NFL model
     D  an NFL slate resolves against the NFL schedule
     E  a CFB slate resolves against the CFB schedule
     F  an existing CFB contributor's submissions still work, unchanged
     G  an API-key ingest works when the sport's model does not exist yet

   plus the ones that decide whether the fix is real: aliases collapse, a
   second post makes no second model, a named model in the wrong sport does not
   win silently, and a database without the migration still self-serves.

   Run: node tools/collective/ingest_model_resolution.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name
    + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the Deno shim, installed BEFORE the import ------------------------ */
const ENV = {
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  SUPABASE_ANON_KEY: 'test-anon-key',
};
let HANDLER = null;
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (fn) => { HANDLER = fn; },
};

/* ---- the world, and the PostgREST it is served through ----------------- */
const LIVE_KEY = 'mck_live_' + 'AbCd1234' + 'x'.repeat(32);
const KEY_HASH = crypto.createHash('sha256').update(LIVE_KEY).digest('hex');

const CRE = { id: 'cre-1', slug: 'blizzard-performance', display_name: 'Blizzard Performance', status: 'active' };

let DB;            // reset per scenario
let CALLS;         // every request the function made
let RPC_MISSING;   // simulate a database without the migration

function reset(models, opts) {
  opts = opts || {};
  DB = {
    models: models.map((m, i) => Object.assign({ id: 'mod-' + (i + 1) }, m)),
    // Two schedules, deliberately disjoint: an NFL game that exists only in the
    // NFL schedule and a college game that exists only in the college one. A
    // slate resolved against the wrong sport matches nothing, which is exactly
    // the failure being tested.
    games: [
      { game_id: 'g-nfl-1', sport: 'NFL', season: 2026, week: 2, kickoff_at: '2026-09-14T17:00:00Z',
        status: 'scheduled', home: 'KC', away: 'BUF', label: 'BUF @ KC' },
      { game_id: 'g-cfb-1', sport: 'NCAAF', season: 2026, week: 3, kickoff_at: '2026-09-19T23:00:00Z',
        status: 'scheduled', home: 'TCU', away: 'SMU', label: 'SMU @ TCU' },
    ],
    nextModelId: models.length + 1,
  };
  CALLS = [];
  RPC_MISSING = !!opts.rpcMissing;
}

function res(status, body, headers) {
  const h = headers || {};
  return {
    ok: status < 300, status,
    headers: { get: (n) => h[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}
function qs(u) { return new URL(u).searchParams; }
function eqv(sp, k) { const v = sp.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; }

globalThis.fetch = async function (url, init) {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(init.body) : null;
  CALLS.push({ url: u, method, body });

  /* ---- RPCs ---- */
  if (u.includes('/rest/v1/rpc/rate_check')) return res(200, true);

  if (u.includes('/rest/v1/rpc/get_or_create_model')) {
    if (RPC_MISSING) {
      return res(404, { code: 'PGRST202', message: 'Could not find the function collective.get_or_create_model' });
    }
    // The real function's contract, in miniature: normalise, then get or create.
    const fam = family(body.p_sport);
    const have = DB.models.find((m) => m.creator_id === body.p_creator_id && family(m.sport_code) === fam);
    if (have) {
      return res(200, [{ model_id: have.id, model_slug: have.slug, model_name: have.name,
        sport: have.sport_code, created: false }]);
    }
    const canon = fam === 'CFB' ? 'NCAAF' : fam;    // this server spells college NCAAF
    const row = {
      id: 'mod-' + (DB.nextModelId++), creator_id: body.p_creator_id,
      slug: CRE.slug + '-' + canon.toLowerCase(), name: CRE.display_name + ' ' + canon,
      sport_code: canon,
    };
    DB.models.push(row);
    return res(200, [{ model_id: row.id, model_slug: row.slug, model_name: row.name,
      sport: row.sport_code, created: true }]);
  }

  if (u.includes('/rest/v1/rpc/ingest_submission')) {
    // The store, reduced to the one thing this suite is about: a row resolves
    // only if the game is in the schedule FOR THE SPORT the envelope carries.
    const env = body.p_envelope, key = body.p_key;
    const sched = DB.games.filter((g) => family(g.sport) === family(env.sport));
    const rows = (env.rows || []).map((r) => {
      const hit = sched.find((g) => g.game_id === r.game_ref
        || (g.home === r.home_team && g.away === r.away_team));
      return { game_ref: r.game_ref, status: hit ? 'resolved' : 'quarantined',
        reason: hit ? null : 'unknown_team_home' };
    });
    return res(200, {
      ok: true,
      submission_id: 'sub-1',
      received_at: '2026-09-08T12:00:00Z',
      counts: {
        resolved: rows.filter((r) => r.status === 'resolved').length,
        quarantined: rows.filter((r) => r.status === 'quarantined').length,
        late: 0, rejected: 0,
      },
      rows,
      // echoed back so the suite can see what the store was told
      stored_under: { model_id: key.model_id, model_slug: key.model_slug, sport: key.sport },
    });
  }

  /* ---- views ---- */
  if (u.includes('/rest/v1/api_keys')) {
    if (method === 'PATCH') return res(200, []);
    return res(200, [{ id: 'key-1', creator_id: CRE.id, key_prefix: 'AbCd1234',
      kind: 'live', status: 'active', key_hash: KEY_HASH }]);
  }
  if (u.includes('/rest/v1/creators')) return res(200, [CRE]);
  if (u.includes('/rest/v1/models')) {
    if (method === 'POST') {
      const row = Object.assign({ id: 'mod-' + (DB.nextModelId++) }, body[0]);
      if (DB.models.some((m) => m.slug === row.slug)) {
        return res(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      }
      DB.models.push(row);
      return res(201, [row]);
    }
    const sp = qs(u);
    const slug = eqv(sp, 'slug');
    let out = DB.models.filter((m) => m.creator_id === (eqv(sp, 'creator_id') || m.creator_id));
    if (slug) out = out.filter((m) => m.slug === slug);
    return res(200, out.map((m) => ({ id: m.id, slug: m.slug, name: m.name, sport_code: m.sport_code })));
  }
  if (u.includes('/rest/v1/game_detail')) {
    const sport = eqv(qs(u), 'sport');
    return res(200, DB.games.filter((g) => g.sport === sport));
  }
  if (u.includes('/rest/v1/odds_snapshot') || u.includes('/rest/v1/market')) return res(200, []);
  // Anything else the market snapshot reaches for: empty, never an error.
  return res(200, []);
};

/* The same alias map the function and the migration carry. Written out here
   rather than imported, so a drift between them fails this suite. */
function family(code) {
  const k = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const MAP = {
    NFL: 'NFL', NATIONALFOOTBALLLEAGUE: 'NFL', PROFOOTBALL: 'NFL', NFLFOOTBALL: 'NFL',
    AMERICANFOOTBALLNFL: 'NFL',
    CFB: 'CFB', NCAAF: 'CFB', CFBP4: 'CFB', COLLEGE: 'CFB', NCAAFOOTBALL: 'CFB',
    COLLEGEFOOTBALL: 'CFB', NCAAFB: 'CFB', CFP: 'CFB', AMERICANFOOTBALLNCAAF: 'CFB',
  };
  if (!k) return null;
  return MAP[k] || k;
}

const CFB_MODEL = { creator_id: CRE.id, slug: 'blizzard-performance-p4', name: 'Blizzard P4', sport_code: 'NCAAF' };
const NFL_MODEL = { creator_id: CRE.id, slug: 'blizzard-performance-nfl', name: 'Blizzard NFL', sport_code: 'NFL' };

const NFL_ROWS = [{ game_ref: 'g-nfl-1', home_team: 'KC', away_team: 'BUF',
  kickoff: '2026-09-14T17:00:00Z', spread: -2.5 }];
const CFB_ROWS = [{ game_ref: 'g-cfb-1', home_team: 'TCU', away_team: 'SMU',
  kickoff: '2026-09-19T23:00:00Z', spread: -3.5 }];

async function post(pathname, envelope, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (opts.key !== null) headers['x-collective-key'] = opts.key || LIVE_KEY;
  const r = await HANDLER(new Request('https://sb.test/functions/v1/collective_ingest' + pathname, {
    method: 'POST', headers, body: JSON.stringify(envelope),
  }));
  let body = null;
  try { body = await r.json(); } catch (_) { /* leave null */ }
  return { status: r.status, body };
}
async function get(pathname) {
  const r = await HANDLER(new Request('https://sb.test/functions/v1/collective_ingest' + pathname, {
    headers: { 'x-collective-key': LIVE_KEY },
  }));
  let body = null;
  try { body = await r.json(); } catch (_) { /* leave null */ }
  return { status: r.status, body };
}

(async function main() {
  await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'collective_ingest', 'index.ts'));
  chk('the deployed bundle serves', typeof HANDLER === 'function');
  if (typeof HANDLER !== 'function') done();

  /* ═══ C + G: an NFL slate from an account that has never had an NFL model ══ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections', { sport: 'NFL', season: 2026, week: 2, data_origin: 'live', rows: NFL_ROWS });

    chk('C: the slate is accepted rather than refused for want of a model',
      r.status === 200, { status: r.status, body: r.body });
    chk('G: an API-key ingest works when the sport has no model yet',
      r.body && r.body.counts && r.body.counts.resolved === 1, r.body);
    chk('C: the model was created by this submission',
      r.body && r.body.model_created === true, r.body && r.body.model_created);
    chk('C: and the receipt says so, rather than leaving it to be noticed',
      /had no NFL model/.test((r.body && r.body.model_note) || ''), r.body && r.body.model_note);
    chk('C: the slate was filed under the NEW model, not the college one',
      r.body && r.body.model === 'blizzard-performance-nfl', r.body && r.body.model);
    chk('C: and the receipt states the sport it was filed in',
      r.body && r.body.sport === 'NFL', r.body && r.body.sport);
    chk('C: exactly one model was created, not two',
      DB.models.length === 2, DB.models.map((m) => m.slug + ':' + m.sport_code));
    chk('C: the college model is untouched — same id, same slug, same sport',
      DB.models[0].slug === 'blizzard-performance-p4' && DB.models[0].sport_code === 'NCAAF'
      && DB.models[0].id === 'mod-1');

    /* D: the schedule it was resolved against was the NFL one. The mocked
       store resolves a row only when the game is in the schedule for the
       envelope's sport, so a resolved count of 1 IS that proof — and the
       store was told the model and sport the function decided on. */
    chk('D: an NFL slate resolves against the NFL schedule',
      r.body.counts.resolved === 1 && r.body.counts.quarantined === 0, r.body.counts);
    chk('D: and the store was told the NFL model and the NFL sport',
      r.body.stored_under && r.body.stored_under.sport === 'NFL'
      && r.body.stored_under.model_slug === 'blizzard-performance-nfl', r.body.stored_under);
  }

  /* ═══ the second post makes no second model ═══════════════════════════ */
  {
    reset([CFB_MODEL]);
    const a = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    const b = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('B: the second NFL slate is filed under the SAME model',
      a.body.model === b.body.model && b.status === 200, [a.body.model, b.body.model]);
    chk('B: and the second one did not create anything',
      b.body.model_created === false && !b.body.model_note, b.body.model_created);
    chk('B: still exactly two models on the account', DB.models.length === 2,
      DB.models.map((m) => m.slug));

    /* The aliases are the real test of "never create duplicate models": a
       creator whose file says CFB and whose key says NCAAF is one contributor
       with one college model, not two. */
    const c1 = await post('/v1/projections', { sport: 'CFB', season: 2026, rows: CFB_ROWS });
    const c2 = await post('/v1/projections', { sport: 'NCAAF', season: 2026, rows: CFB_ROWS });
    const c3 = await post('/v1/projections', { sport: 'college football', season: 2026, rows: CFB_ROWS });
    chk('every spelling of college football reaches the one college model',
      c1.body.model === 'blizzard-performance-p4' && c2.body.model === 'blizzard-performance-p4'
      && c3.body.model === 'blizzard-performance-p4',
      [c1.body.model, c2.body.model, c3.body.model]);
    chk('and none of them created a model', DB.models.length === 2, DB.models.map((m) => m.slug));
    chk('nor did the long spelling of NFL',
      (await post('/v1/projections', { sport: 'National Football League', season: 2026, rows: NFL_ROWS }))
        .body.model === 'blizzard-performance-nfl' && DB.models.length === 2);
  }

  /* ═══ E + F: the college contributor who was already here ═════════════ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections', { sport: 'CFB', season: 2026, week: 3,
      data_origin: 'live', model: 'blizzard-performance-p4', rows: CFB_ROWS });
    chk('F: an existing CFB submission still works, exactly as it did',
      r.status === 200 && r.body.model === 'blizzard-performance-p4', { s: r.status, b: r.body });
    chk('F: nothing was created for it', r.body.model_created === false && DB.models.length === 1);
    chk('E: a CFB slate resolves against the CFB schedule',
      r.body.counts.resolved === 1 && r.body.counts.quarantined === 0, r.body.counts);
    chk('E: and is stored under the college sport code THIS server uses',
      r.body.sport === 'NCAAF' && r.body.stored_under.sport === 'NCAAF', r.body.sport);

    /* The old envelope: no sport at all, one model on the account. That is how
       every submission before this change looked, and it must not have moved. */
    reset([CFB_MODEL]);
    const legacy = await post('/v1/projections', { season: 2026, week: 3, rows: CFB_ROWS });
    chk('F: an envelope with no sport at all still posts under the one model',
      legacy.status === 200 && legacy.body.model === 'blizzard-performance-p4', legacy.body);
    chk('F: and still resolves', legacy.body.counts.resolved === 1, legacy.body.counts);

    reset([CFB_MODEL, NFL_MODEL]);
    const named = await post('/v1/projections', { season: 2026, model: 'blizzard-performance-nfl', rows: NFL_ROWS });
    chk('F: naming a model with no sport on the envelope still works',
      named.status === 200 && named.body.model === 'blizzard-performance-nfl', named.body);
  }

  /* ═══ the wrong-sport model does not win, and does not lose quietly ═══ */
  {
    reset([CFB_MODEL, NFL_MODEL]);
    const r = await post('/v1/projections', { sport: 'NFL', season: 2026,
      model: 'blizzard-performance-p4', rows: NFL_ROWS });
    chk('an NFL slate sent under a CFB model is filed under the NFL model instead',
      r.status === 200 && r.body.model === 'blizzard-performance-nfl', r.body && r.body.model);
    chk('because the other way round matches nothing',
      r.body.counts.resolved === 1 && r.body.counts.quarantined === 0, r.body.counts);
    chk('and the receipt SAYS the model was overridden, so it is never silent',
      /blizzard-performance-p4/.test(r.body.model_note || '')
      && /wrong schedule/.test(r.body.model_note || ''), r.body.model_note);
    chk('nothing was created — the account already had the right model',
      r.body.model_created === false && DB.models.length === 2);
  }

  /* ═══ what it still refuses, and what it never says ═══════════════════ */
  {
    reset([]);
    const r = await post('/v1/projections', { season: 2026, rows: NFL_ROWS });
    chk('an envelope with no sport from an account with no models is refused',
      r.status === 422, r.status);
    chk('and the fix it names is ONE WORD FROM THE CALLER, never an operator',
      /"sport"/.test(r.body.error.message)
      && !/operator|administrator|contact|dashboard before/i.test(r.body.error.message),
      r.body.error.message);

    reset([
      { creator_id: CRE.id, slug: 'nfl-a', name: 'A', sport_code: 'NFL' },
      { creator_id: CRE.id, slug: 'nfl-b', name: 'B', sport_code: 'NFL' },
      CFB_MODEL,
    ]);
    const amb = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('two models in the SAME sport is a real ambiguity and is still asked about',
      amb.status === 422 && /several NFL models/.test(amb.body.error.message), amb.body);
    chk('and only the models in that sport are offered, not the college one',
      /nfl-a/.test(amb.body.error.message) && /nfl-b/.test(amb.body.error.message)
      && !/blizzard-performance-p4/.test(amb.body.error.message), amb.body.error.message);

    reset([CFB_MODEL]);
    const bad = await post('/v1/projections', { sport: 'NFL', season: 2026,
      model: 'not-a-model', rows: NFL_ROWS });
    chk('a model name that is not on the account is still refused, not created',
      bad.status === 422 && /No model named/.test(bad.body.error.message), bad.body);
    chk('and nothing was created by the attempt', DB.models.length === 1);
  }

  /* ═══ a database that has not been migrated yet still self-serves ════ */
  {
    reset([CFB_MODEL], { rpcMissing: true });
    const r = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('with the RPC absent the slate still posts',
      r.status === 200 && r.body.model_created === true, { s: r.status, b: r.body });
    chk('and the model it wrote directly is an NFL one for this creator',
      DB.models.length === 2 && DB.models[1].sport_code === 'NFL'
      && DB.models[1].creator_id === CRE.id, DB.models);

    /* And a second one does not double it: the direct write loses the race and
       re-reads rather than reporting a failure. */
    const again = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('a second post against the un-migrated database makes no second model',
      again.status === 200 && DB.models.length === 2, DB.models.map((m) => m.slug));
  }

  /* ═══ the dry run behaves identically, and stores nothing ════════════ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections/dry-run', { sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('a dry run for a sport with no model reports what would happen',
      r.status === 200 && r.body.dry_run === true && r.body.counts.resolved === 1,
      { s: r.status, b: r.body });
    chk('and it does not store a submission', r.body.submission_id === null);
    /* The model IS created by a dry run, and that is the honest behaviour: the
       dry run's whole job is to answer "would this post", and the answer is
       different if the model does not exist. Nothing about the record changes
       — an empty model has no projections, no grades and no rank. */
    chk('the model exists afterwards, so the real post has nothing left to fail on',
      DB.models.length === 2 && r.body.model === 'blizzard-performance-nfl', r.body.model);
  }

  /* ═══ retract resolves by sport, and never creates ═══════════════════ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections/retract', { sport: 'NFL', season: 2026 });
    chk('retracting from a sport with no model is a 404, not a new model',
      r.status === 404 && DB.models.length === 1, { s: r.status, models: DB.models.length });
    chk('and it says which models this account does have',
      /blizzard-performance-p4/.test(r.body.error.message), r.body.error.message);

    reset([CFB_MODEL, NFL_MODEL]);
    const r2 = await post('/v1/projections/retract', { sport: 'NFL', season: 2026 });
    chk('retract with a sport picks the model for THAT sport',
      r2.status === 200 && r2.body.model === 'blizzard-performance-nfl', r2.body);
  }

  /* ═══ /v1/me tells a script the wall is gone ═════════════════════════ */
  {
    reset([CFB_MODEL]);
    const r = await get('/v1/me');
    chk('/v1/me still lists the models it always did',
      r.status === 200 && r.body.models.length === 1
      && r.body.models[0].model === 'blizzard-performance-p4', r.body);
    chk('/v1/me says a missing sport is not a wall',
      r.body.creates_models === true && /created with the submission/.test(r.body.sport_note || ''),
      r.body.sport_note);
  }

  /* ═══ /v1/market is addressable by sport too ═════════════════════════ */
  {
    reset([CFB_MODEL, NFL_MODEL]);
    const a = await get('/v1/market?sport=NFL');
    const b = await get('/v1/market?sport=college%20football');
    chk('the market can be asked for by sport, not only by model slug',
      a.status === 200 && a.body.sport === 'NFL'
      && b.status === 200 && b.body.sport === 'NCAAF',
      [a.body && a.body.sport, b.body && b.body.sport]);
    chk('and naming a model still answers for that model',
      (await get('/v1/market?model=blizzard-performance-p4')).body.sport === 'NCAAF');

    /* A sport this account has no model for still has a market. Requiring one
       would be the same wall in a smaller place. */
    reset([CFB_MODEL]);
    const c = await get('/v1/market?sport=NFL');
    chk('a sport with no model on the account is still answerable',
      c.status === 200 && c.body.sport === 'NFL' && c.body.model === null,
      { s: c.status, b: c.body });
    chk('and asking about it creates nothing', DB.models.length === 1);
  }

  /* ═══ a key still only ever writes to its own account ════════════════ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS,
      creator: 'somebody-else', creator_id: 'cre-999', model_id: 'mod-999' });
    chk('a body cannot name a creator: the key decides whose model is made',
      r.status === 200 && DB.models.every((m) => m.creator_id === CRE.id),
      DB.models.map((m) => m.creator_id));
    const rpcCall = CALLS.filter((c) => c.url.includes('get_or_create_model')).pop();
    chk('and the creator sent to the database is the key\'s own',
      rpcCall && rpcCall.body.p_creator_id === CRE.id, rpcCall && rpcCall.body);
    const store = CALLS.filter((c) => c.url.includes('ingest_submission')).pop();
    chk('the store is told the key\'s creator and the resolved model, never the body\'s',
      store.body.p_key.creator_id === CRE.id && store.body.p_key.model_slug === 'blizzard-performance-nfl'
      && store.body.p_envelope.sport === 'NFL', store.body.p_key);
  }

  /* ═══ no key, no model ═══════════════════════════════════════════════ */
  {
    reset([CFB_MODEL]);
    const r = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS }, { key: null });
    chk('an unauthenticated post creates nothing at all',
      r.status === 401 && DB.models.length === 1, { s: r.status, models: DB.models.length });
    const bad = await post('/v1/projections', { sport: 'NFL', season: 2026, rows: NFL_ROWS },
      { key: 'mck_live_ZZZZ9999' + 'y'.repeat(32) });
    chk('nor does a key that is not on the account', bad.status === 401 && DB.models.length === 1);
  }

  done();
})().catch((e) => {
  console.log('FAIL | the suite itself threw  ' + (e && e.stack || e));
  process.exit(1);
});

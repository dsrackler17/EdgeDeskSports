#!/usr/bin/env node
/* ===========================================================================
   THE DASHBOARD'S OWN POSTING PATH, AND THE DOOR BESIDE IT.

   collective_ingest was fixed so the SPORT decides which model a slate is
   filed under, and a sport with no model gets one. That is the API path --
   the Universal Prompt, an API key, app.html's Sync button. It is NOT the
   path the dashboard's uploader posts to: that is
   collective_public /v1/dashboard/submit, which was carrying the identical
   bug, unfixed, because the function was not in this repository to fix.

     let model = models[0];
     if (typeof body.model === "string" && body.model) { ...find by slug... }
     else if (models.length > 1) { ...422... }
     const envelope = { ...body, model: model.slug, sport: model.sport_code };

   `body.sport` is read nowhere. So a creator with only a college model,
   posting an NFL slate through the dashboard, had the envelope's sport
   OVERWRITTEN with CFB, every NFL game looked up in the college schedule, and
   every row came back unmatched. The browser resolves this before it posts
   now -- but a server that trusts the client to pick the right record is
   exactly what made the original bug possible, so it is enforced here too.

   And collective_join grew POST /v1/models: the second door the dashboard
   tries, which until now did not exist, so a backend without the database
   migration had no self-serve path at all.

   Both DEPLOYED bundles are imported -- not copies -- with a Deno shim and a
   mocked PostgREST, the same way tools/collective/ingest_model_resolution.test.js
   drives collective_ingest. Nothing here reaches a network and nothing writes.

   Run: node tools/collective/dashboard_model_resolution.test.js
   =========================================================================== */
'use strict';
const path = require('path');

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

/* ---- the Deno shim. Each bundle is loaded in its own child so their
   top-level `const SB_URL` declarations cannot collide. ------------------- */
const ENV = {
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  SUPABASE_ANON_KEY: 'test-anon-key',
};
let HANDLER = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (fn) => { HANDLER = fn; } };

const USER = { id: 'user-1', email: 'blizzard@example.test' };
const CRE = {
  id: 'cre-1', user_id: USER.id, slug: 'blizzard-performance',
  display_name: 'Blizzard Performance', status: 'active', founding_member: false,
  billing_mode: 'standard', referral_share_bps: 0, pinned_model_id: null,
  description: null, website_url: null, x_handle: null, logo_url: null,
  created_at: '2026-01-01T00:00:00Z',
};

let DB, CALLS, OPTS;
function reset(models, opts) {
  OPTS = opts || {};
  DB = {
    models: models.map((m, i) => Object.assign({ id: 'mod-' + (i + 1), creator_id: CRE.id }, m)),
    next: models.length + 1,
    // Two disjoint schedules: a row resolves only if its game is in the
    // schedule FOR THE SPORT the envelope carries.
    games: [
      { id: 'g-nfl-1', sport: 'NFL', home: 'KC', away: 'BUF' },
      { id: 'g-cfb-1', sport: 'NCAAF', home: 'TCU', away: 'SMU' },
    ],
    creators: OPTS.noCreator ? [] : [CRE],
    keys: OPTS.noKey ? [] : [{ id: 'key-1' }],
  };
  CALLS = [];
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
function eqv(u, k) {
  const v = new URL(u).searchParams.get(k);
  return v && v.startsWith('eq.') ? v.slice(3) : null;
}
/* The same alias map the bundles carry, written out rather than imported, so
   a drift between them fails this suite. */
function family(code) {
  const k = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const MAP = {
    NFL: 'NFL', NATIONALFOOTBALLLEAGUE: 'NFL', PROFOOTBALL: 'NFL', NFLFOOTBALL: 'NFL',
    AMERICANFOOTBALLNFL: 'NFL',
    CFB: 'CFB', NCAAF: 'CFB', CFBP4: 'CFB', COLLEGE: 'CFB', NCAAFOOTBALL: 'CFB',
    COLLEGEFOOTBALL: 'CFB', NCAAFB: 'CFB', CFP: 'CFB', AMERICANFOOTBALLNCAAF: 'CFB',
  };
  return k ? (MAP[k] || k) : null;
}

globalThis.fetch = async function (url, init) {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(init.body) : null;
  CALLS.push({ url: u, method, body });

  if (u.includes('/auth/v1/user')) {
    const authz = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    return /^Bearer /.test(authz) ? res(200, USER) : res(401, {});
  }
  if (u.includes('/rest/v1/rpc/get_config')) return res(200, null);
  if (u.includes('/rest/v1/rpc/rate_check')) return res(200, true);

  if (u.includes('/rest/v1/rpc/get_or_create_model')) {
    if (OPTS.rpcMissing) {
      return res(404, { code: 'PGRST202', message: 'Could not find the function collective.get_or_create_model' });
    }
    const fam = family(body.p_sport);
    const have = DB.models.find((m) => m.creator_id === body.p_creator_id && family(m.sport_code) === fam);
    if (have) {
      return res(200, [{ model_id: have.id, model_slug: have.slug, model_name: have.name,
        sport: have.sport_code, created: false }]);
    }
    const canon = fam === 'CFB' ? 'NCAAF' : fam;        // this server spells college NCAAF
    const row = {
      id: 'mod-' + (DB.next++), creator_id: body.p_creator_id,
      slug: CRE.slug + '-' + canon.toLowerCase(),
      name: (body.p_model_name || CRE.display_name + ' ' + canon), sport_code: canon,
    };
    DB.models.push(row);
    return res(200, [{ model_id: row.id, model_slug: row.slug, model_name: row.name,
      sport: row.sport_code, created: true }]);
  }

  if (u.includes('/rest/v1/rpc/ingest_submission')) {
    const env = body.p_envelope, key = body.p_key;
    const sched = DB.games.filter((g) => family(g.sport) === family(env.sport));
    const rows = (env.rows || []).map((r) => {
      const hit = sched.find((g) => g.id === r.game_ref || (g.home === r.home_team && g.away === r.away_team));
      return { game_ref: r.game_ref, status: hit ? 'resolved' : 'quarantined' };
    });
    return res(200, {
      ok: true, submission_id: 'sub-1',
      counts: {
        resolved: rows.filter((r) => r.status === 'resolved').length,
        quarantined: rows.filter((r) => r.status === 'quarantined').length,
        late: 0, rejected: 0,
      },
      rows,
      stored_under: { model_slug: key.model_slug, sport: key.sport },
    });
  }

  if (u.includes('/rest/v1/creators')) return res(200, DB.creators);
  if (u.includes('/rest/v1/api_keys')) return res(200, DB.keys);
  if (u.includes('/rest/v1/sports')) {
    return res(200, [{ code: 'NFL', name: 'Football', active: true },
      { code: 'NCAAF', name: 'College Football', active: true }]);
  }
  if (u.includes('/rest/v1/models')) {
    if (method === 'POST') {
      const row = Object.assign({ id: 'mod-' + (DB.next++) }, body[0]);
      if (DB.models.some((m) => m.slug === row.slug)) {
        return res(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      }
      DB.models.push(row);
      return res(201, [row]);
    }
    const slug = eqv(u, 'slug');
    let out = DB.models;
    if (slug) out = out.filter((m) => m.slug === slug);
    return res(200, out.map((m) => ({ id: m.id, slug: m.slug, name: m.name, sport_code: m.sport_code })));
  }
  return res(200, []);
};

const NFL_ROWS = [{ game_ref: 'g-nfl-1', home_team: 'KC', away_team: 'BUF', kickoff: '2026-09-14T17:00:00Z', spread: -2.5 }];
const CFB_ROWS = [{ game_ref: 'g-cfb-1', home_team: 'TCU', away_team: 'SMU', kickoff: '2026-09-19T23:00:00Z', spread: -3.5 }];
const CFB_MODEL = { slug: 'blizzard-performance-p4', name: 'Blizzard P4', sport_code: 'NCAAF' };
const NFL_MODEL = { slug: 'blizzard-performance-nfl', name: 'Blizzard NFL', sport_code: 'NFL' };

async function call(fn, pathname, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (opts.signedIn !== false) headers.authorization = 'Bearer test-session-token';
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await HANDLER(new Request(`https://sb.test/functions/v1/${fn}${pathname}`, init));
  let body = null;
  try { body = await r.json(); } catch (_) { /* leave null */ }
  return { status: r.status, body };
}

(async function main() {
  const FN = path.join(__dirname, '..', '..', 'supabase', 'functions');

  /* ═══ collective_public: the dashboard's own uploader ══════════════════ */
  await import(path.join(FN, 'collective_public', 'index.ts'));
  chk('the deployed collective_public bundle serves', typeof HANDLER === 'function');
  if (typeof HANDLER !== 'function') done();
  const pubHandler = HANDLER;
  const submit = (body, opts) => {
    HANDLER = pubHandler;
    return call('collective_public', '/v1/dashboard/submit', Object.assign({ method: 'POST', body }, opts || {}));
  };
  const get = (p, opts) => { HANDLER = pubHandler; return call('collective_public', p, opts); };

  {
    reset([CFB_MODEL]);
    const r = await submit({ sport: 'NFL', season: 2026, data_origin: 'live', rows: NFL_ROWS });
    chk('a dashboard NFL slate from a CFB-only account is accepted',
      r.status === 200, { s: r.status, b: r.body });
    chk('it is filed under a NEW NFL model, not the college one',
      r.body.model === 'blizzard-performance-nfl' && r.body.model_created === true, r.body);
    chk('and the store was told the NFL model and the NFL sport',
      r.body.stored_under && r.body.stored_under.sport === 'NFL'
      && r.body.stored_under.model_slug === 'blizzard-performance-nfl', r.body.stored_under);
    chk('so the slate resolves against the NFL schedule instead of quarantining',
      r.body.counts.resolved === 1 && r.body.counts.quarantined === 0, r.body.counts);
    chk('the receipt says a model was created rather than leaving it to be noticed',
      /had no NFL model/.test(r.body.model_note || ''), r.body.model_note);
    chk('exactly one model was created', DB.models.length === 2, DB.models.map((m) => m.slug));
    chk('and the college model is untouched',
      DB.models[0].slug === 'blizzard-performance-p4' && DB.models[0].id === 'mod-1');
  }

  {
    reset([CFB_MODEL]);
    const a = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    const b = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('a second dashboard slate reuses the same model and creates nothing',
      a.body.model === b.body.model && b.body.model_created === false && DB.models.length === 2,
      DB.models.map((m) => m.slug));
    const c = await submit({ sport: 'college football', season: 2026, rows: CFB_ROWS });
    chk('an alias of a sport reaches the model that already exists',
      c.body.model === 'blizzard-performance-p4' && DB.models.length === 2, c.body.model);
  }

  {
    reset([CFB_MODEL, NFL_MODEL]);
    const r = await submit({ sport: 'NFL', season: 2026, model: 'blizzard-performance-p4', rows: NFL_ROWS });
    chk('an NFL slate sent under a CFB model is filed under the NFL model instead',
      r.body.model === 'blizzard-performance-nfl' && r.body.counts.resolved === 1, r.body);
    chk('and the receipt SAYS the model was overridden',
      /wrong schedule/.test(r.body.model_note || ''), r.body.model_note);
  }

  {
    reset([CFB_MODEL]);
    const r = await submit({ season: 2026, model: 'blizzard-performance-p4', rows: CFB_ROWS });
    chk('the envelope the dashboard sent before this change still works unchanged',
      r.status === 200 && r.body.model === 'blizzard-performance-p4'
      && r.body.model_created === false && DB.models.length === 1, r.body);
    reset([CFB_MODEL]);
    const legacy = await submit({ season: 2026, rows: CFB_ROWS });
    chk('and so does one naming neither a model nor a sport, on a one-model account',
      legacy.status === 200 && legacy.body.model === 'blizzard-performance-p4', legacy.body);
  }

  {
    reset([{ slug: 'nfl-a', name: 'A', sport_code: 'NFL' }, { slug: 'nfl-b', name: 'B', sport_code: 'NFL' }, CFB_MODEL]);
    const r = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('two models in ONE sport is a real ambiguity and is still asked about',
      r.status === 422 && /several NFL models/.test(r.body.error.message), r.body);
    chk('and only the models in that sport are offered',
      /nfl-a/.test(r.body.error.message) && !/blizzard-performance-p4/.test(r.body.error.message),
      r.body.error.message);
  }

  {
    reset([]);
    const r = await submit({ season: 2026, rows: NFL_ROWS });
    chk('an account with no models and no sport on the envelope is refused',
      r.status === 422 && /"sport"/.test(r.body.error.message), r.body);
    chk('and the fix it names is one word from the caller, never an operator',
      !/operator|administrator|contact/i.test(r.body.error.message), r.body.error.message);
    reset([]);
    const ok = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('but with the sport named, an account with NO models posts and gets one',
      ok.status === 200 && ok.body.model_created === true && DB.models.length === 1, ok.body);
  }

  {
    reset([CFB_MODEL], { rpcMissing: true });
    const r = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('with the database routine absent the dashboard slate still posts',
      r.status === 200 && r.body.model_created === true && DB.models.length === 2,
      { s: r.status, models: DB.models.map((m) => m.slug) });
    const again = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('and a second one makes no second model', again.status === 200 && DB.models.length === 2);
  }

  {
    reset([CFB_MODEL]);
    const r = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS }, { signedIn: false });
    chk('an unauthenticated dashboard post creates nothing',
      r.status === 401 && DB.models.length === 1, { s: r.status });
    reset([CFB_MODEL], { noCreator: true });
    const nc = await submit({ sport: 'NFL', season: 2026, rows: NFL_ROWS });
    chk('an account with no creator profile creates nothing either',
      nc.status === 404 && DB.models.length === 1, { s: nc.status });
  }

  /* THE PUBLISHED RULES. The site's Rules page renders /v1/rules verbatim. */
  {
    reset([CFB_MODEL]);
    const r = await get('/v1/rules');
    chk('the published rules are version 2', r.body.version === 2, r.body.version);
    chk('and no longer state a ranking minimum the product removed',
      !r.body.rules.some((x) => /60 percent|at least 20 graded/.test(x)),
      r.body.rules.filter((x) => /60 percent|20 graded/.test(x)));
    chk('they say instead what the boards actually do',
      r.body.rules.some((x) => /ranked from its first graded game/.test(x)), r.body.rules);
  }

  /* THE UNIVERSAL PROMPT, for an account that has not wired anything up yet. */
  {
    reset([]);
    const r = await get('/v1/dashboard/prompt');
    chk('the prompt renders for an account with no model',
      r.status === 200 && typeof r.body.prompt === 'string' && r.body.prompt.length > 500,
      { s: r.status, len: r.body && r.body.prompt && r.body.prompt.length });
    chk('it says so rather than refusing',
      r.body.model === null && /created with the submission/.test(r.body.note || ''), r.body.note);
    chk('and it is addressed to the creator by name',
      r.body.prompt.indexOf('Blizzard Performance') >= 0);
    reset([CFB_MODEL]);
    const withModel = await get('/v1/dashboard/prompt');
    chk('with a model it names that model, as it always did',
      withModel.body.model.model_slug === 'blizzard-performance-p4'
      && withModel.body.prompt.indexOf('Blizzard P4') >= 0, withModel.body.model);
  }

  /* ═══ collective_join: POST /v1/models, the second door ════════════════ */
  HANDLER = null;
  await import(path.join(FN, 'collective_join', 'index.ts'));
  chk('the deployed collective_join bundle serves', typeof HANDLER === 'function');
  const joinHandler = HANDLER;
  const models = (body, opts) => {
    HANDLER = joinHandler;
    return call('collective_join', '/v1/models', Object.assign({ method: 'POST', body }, opts || {}));
  };

  {
    reset([CFB_MODEL]);
    const r = await models({ sport: 'NFL' });
    chk('POST /v1/models exists at all — it did not before',
      r.status === 200, { s: r.status, b: r.body });
    chk('it creates the NFL model and hands it back',
      r.body.created === true && r.body.model.model_slug === 'blizzard-performance-nfl'
      && r.body.model.sport === 'NFL', r.body);
    const again = await models({ sport: 'NFL' });
    chk('asking again returns the same model and says it already existed',
      again.body.already === true && again.body.created === false
      && again.body.model.model_slug === 'blizzard-performance-nfl', again.body);
    chk('and no duplicate was made', DB.models.length === 2, DB.models.map((m) => m.slug));
  }

  {
    reset([]);
    const named = await models({ sport: 'CFB', model_name: 'My College Model' });
    chk('a sport named by an alias is stored in the code THIS server uses',
      named.body.model.sport === 'NCAAF', named.body.model);
    chk('and the name the contributor chose is the name it has',
      named.body.model.model_name === 'My College Model', named.body.model);
  }

  {
    reset([CFB_MODEL]);
    chk('a sport this server does not carry is refused, not invented',
      (await models({ sport: 'CRICKET' })).status === 422 && DB.models.length === 1);
    chk('an empty sport is refused',
      (await models({})).status === 422 && DB.models.length === 1);
    chk('a name over 60 characters is refused',
      (await models({ sport: 'NFL', model_name: 'x'.repeat(61) })).status === 422
      && DB.models.length === 1);
    const anon = await models({ sport: 'NFL' }, { signedIn: false });
    chk('and nobody signed out can create anything',
      anon.status === 401 && DB.models.length === 1, { s: anon.status });
  }

  {
    reset([CFB_MODEL], { noCreator: true });
    const r = await models({ sport: 'NFL' });
    chk('an account with no active creator profile is refused, and told why',
      r.status === 403 && /no active creator profile/.test(r.body.error.message), r.body);
    chk('and no model was made for it', DB.models.length === 1);
  }

  {
    reset([CFB_MODEL]);
    await models({ sport: 'NFL', creator: 'somebody-else', creator_id: 'cre-999' });
    const rpcCall = CALLS.filter((c) => c.url.includes('get_or_create_model')).pop();
    chk('the body cannot name a creator: the SESSION decides whose model is made',
      rpcCall && rpcCall.body.p_creator_id === CRE.id, rpcCall && rpcCall.body);
    chk('and every model on the account still belongs to it',
      DB.models.every((m) => m.creator_id === CRE.id));
  }

  {
    reset([CFB_MODEL], { rpcMissing: true });
    const r = await models({ sport: 'NFL' });
    chk('with the database routine absent the door still works',
      r.status === 200 && DB.models.length === 2 && DB.models[1].sport_code === 'NFL', DB.models);
    const again = await models({ sport: 'NFL' });
    chk('and does not double the model', again.status === 200 && DB.models.length === 2);
  }

  /* The www host check, which as pasted compared a hostname to a markdown
     link and so refused every join POST from www. */
  {
    const src = require('fs').readFileSync(
      path.join(FN, 'collective_join', 'index.ts'), 'utf8');
    /* Asked of the CODE. The header comment quotes the broken line on purpose,
       so that the next person reading this file knows what was wrong; the
       check is that no line the runtime executes still carries it. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*/gm, ' ');
    chk('the www origin check compares a hostname, not a markdown link',
      /host === `www\.\$\{base\}`/.test(code) && !/\]\(https:\/\/www\./.test(code),
      (code.match(/const allowed = [^;]*/) || [])[0]);
  }

  done();
})().catch((e) => {
  console.log('FAIL | the suite itself threw  ' + (e && e.stack || e));
  process.exit(1);
});

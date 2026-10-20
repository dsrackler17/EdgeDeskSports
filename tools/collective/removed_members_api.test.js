#!/usr/bin/env node
/* ===========================================================================
   A REMOVED MEMBER LEAVES THE PUBLIC COLLECTIVE.

   supabase/collective_member_removal.sql removes a contributor by stamping
   removed_at on their creator row and moving its status off 'active'. It
   KEEPS the creator row and their models, and model_wall filters on neither
   — so a member removed from the admin page went on sitting in the model
   directory, with a profile, inside the counts, as if nothing had happened.

   supabase/functions/collective_public/index.ts is imported for real under
   a Deno shim, its own handler is driven, and PostgREST is mocked:

     wall / directory   the removed member's rows are gone; everyone else's
                        are untouched
     profile            /v1/creators/<removed> is a 404, like any slug that
                        was never a member
     rankings           gone from every board, and each model below them moves
                        up by the removed models that ranked ahead of it in
                        its own league (ties stay ties, other leagues untouched)
                        — on the settlement's boards and on the legacy view's
     activity           their uploads leave the feed
     counts             /v1/meta counts creators and models without them
     no removal yet     a project whose creators table has no removed_at at
                        all serves every member, unchanged

   Run: node tools/collective/removed_members_api.test.js
   =========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); }
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' };
let HANDLER = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { HANDLER = h; } };

function wallRow(slug, name, model, membership, graded) {
  return { creator_slug: slug, creator_name: name, logo_url: null, monogram: name[0], founding: true,
    website_url: null, x_handle: null, membership, model_slug: model, model_name: name + ' NFL', sport: 'NFL',
    graded, wins: graded ? 5 : null, losses: graded ? 4 : null, pushes: graded ? 0 : null,
    win_pct: graded ? 0.556 : null, margin_mae: graded ? 9.4 : null, brier: graded ? 0.23 : null,
    coverage_pct: graded ? 100 : 0, last_submission_at: graded ? '2026-10-14T12:00:00Z' : null };
}
function rank(league, slug, model, w, m, b) {
  return { league, season: 2026, model_id: slug + '-' + league, creator_slug: slug, model_slug: model,
    wins: 1, losses: 1, pushes: 0, ats_n: 2, ats_pct: 0.5, mae: 9, mae_n: 2, brier: 0.2, brier_n: 2, coverage_pct: 100,
    ats_missing_close: 0, ats_no_side: 0, ats_late: 0, ats_game_not_final: 0, ats_excluded_other: 0,
    is_ranked: w !== null || m !== null || b !== null, unranked_reason: null,
    rank_win_pct: w, rank_margin_mae: m, rank_brier: b, min_coverage_pct: 0, min_graded_games: 1 };
}

/* The screenshot's directory, plus a removed member WITH a graded history
   (ghost), whose status column took no removal label so removed_at alone
   says so — the case an enum status produces. */
const DATA = {
  sports: [{ code: 'NFL', name: 'Football', active: true }],
  sport_seasons: [{ sport_code: 'NFL', season: 2026, starts_on: '2026-08-01', ends_on: '2027-02-28' }],
  creators: [
    { id: 'c-moose', slug: 'mustbemoose', display_name: 'MustBeMoose', status: 'active', removed_at: null, pinned_model_id: null },
    { id: 'c-bliz', slug: 'blizzard', display_name: 'Blizzard Performance', status: 'active', removed_at: null, pinned_model_id: null },
    { id: 'c-jaded', slug: 'jadedbettor-murse2-0', display_name: 'JadedBettor(Murse2.0)', status: 'removed',
      removed_at: '2026-10-19T18:00:00Z', removal_mode: 'membership_only', pinned_model_id: null },
    { id: 'c-ghost', slug: 'ghost', display_name: 'Ghost', status: 'active',
      removed_at: '2026-10-01T00:00:00Z', removal_mode: 'membership_only', pinned_model_id: null },
  ],
  model_wall: [
    wallRow('mustbemoose', 'MustBeMoose', 'moose-metrics', 'ACTIVE CONTRIBUTOR', 9),
    wallRow('blizzard', 'Blizzard Performance', 'blizzard-nfl', 'ACTIVE CONTRIBUTOR', 9),
    wallRow('ghost', 'Ghost', 'ghost-nfl', 'ACTIVE CONTRIBUTOR', 9),
    wallRow('jadedbettor-murse2-0', 'JadedBettor(Murse2.0)', 'nfl-math-madness', 'MEMBER', null),
  ],
  fg2_model_standings: [],
  /* NFL: ghost first on win %, moose and blizzard tied second; brier moose,
     ghost, blizzard. CFB: nobody removed, so nothing there may move. */
  fg2_model_rankings: [
    rank('NFL', 'ghost', 'ghost-nfl', 1, 1, 2),
    rank('NFL', 'mustbemoose', 'moose-metrics', 2, 2, 1),
    rank('NFL', 'blizzard', 'blizzard-nfl', 2, 3, 3),
    rank('CFB', 'blizzard', 'blizzard-cfb', 1, 1, 1),
    rank('CFB', 'mustbemoose', 'moose-cfb', 2, 2, 2),
  ],
  model_rankings: [
    { creator_slug: 'ghost', creator_name: 'Ghost', model_slug: 'ghost-nfl', model_name: 'Ghost NFL', sport: 'NFL',
      graded: 9, coverage_pct: 100, win_pct: 0.7, margin_mae: 8, brier: 0.2, is_ranked: true, unranked_reason: null,
      rank_win_pct: 1, rank_margin_mae: 1, rank_brier: 1 },
    { creator_slug: 'mustbemoose', creator_name: 'MustBeMoose', model_slug: 'moose-metrics', model_name: 'Moose Metrics', sport: 'NFL',
      graded: 9, coverage_pct: 100, win_pct: 0.55, margin_mae: 9, brier: 0.23, is_ranked: true, unranked_reason: null,
      rank_win_pct: 2, rank_margin_mae: 2, rank_brier: 2 },
  ],
  activity_feed: [
    { at: '2026-10-14T12:00:00Z', creator_slug: 'ghost', creator_name: 'Ghost', model_name: 'Ghost NFL', sport: 'NFL', n_rows: 14, n_first: 14, week: 7 },
    { at: '2026-10-14T11:00:00Z', creator_slug: 'mustbemoose', creator_name: 'MustBeMoose', model_name: 'Moose Metrics', sport: 'NFL', n_rows: 14, n_first: 14, week: 7 },
  ],
  model_backfill: [],
  models: [],
};
let INSTALLED = true;
const HEADS = [];
function reply(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text),
    headers: { get: (k) => (headers || {})[k.toLowerCase()] || null } };
}
globalThis.fetch = async function (url, init) {
  const u = new URL(String(url));
  const method = (init && init.method) || 'GET';
  if (u.pathname.startsWith('/auth/')) return reply(401, { msg: 'no session' });
  if (u.pathname === '/rest/v1/rpc/get_config') return reply(200, 'null');
  const rel = u.pathname.replace('/rest/v1/', '');
  if (method === 'HEAD') { HEADS.push(rel + '?' + decodeURIComponent(u.search.slice(1))); return reply(200, '', { 'content-range': '0-0/0' }); }
  if (rel.startsWith('fg2_') && !INSTALLED) {
    return reply(404, { code: 'PGRST205', message: `Could not find the table 'collective.${rel}' in the schema cache` });
  }
  let rows = DATA[rel];
  if (!rows) return reply(200, []);
  u.searchParams.forEach((v, k) => {
    if (k === 'select' || k === 'order' || k === 'limit') return;
    if (/^eq\./.test(v)) rows = rows.filter(r => r[k] === undefined || String(r[k]) === v.slice(3));
  });
  return reply(200, rows);
};

(async function () {
  await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'collective_public', 'index.ts'));
  chk('the function registered its handler', typeof HANDLER === 'function');
  const get = async (p) => {
    const res = await HANDLER(new Request('https://sb.test/functions/v1/collective_public' + p));
    return { status: res.status, body: await res.json() };
  };
  const slugsOf = (rows) => (rows || []).map(r => r.creator_slug).sort();

  /* ---- the directory ------------------------------------------------------ */
  let r = await get('/v1/wall');
  chk('wall: a member removed with no submissions is not in the directory',
    !slugsOf(r.body.rows).includes('jadedbettor-murse2-0'), slugsOf(r.body.rows));
  chk('wall: a member removed with a graded history is not in it either (removed_at alone, status untouched)',
    !slugsOf(r.body.rows).includes('ghost'), slugsOf(r.body.rows));
  chk('wall: every current member is still there',
    JSON.stringify(slugsOf(r.body.rows)) === JSON.stringify(['blizzard', 'mustbemoose']), slugsOf(r.body.rows));

  /* ---- the profile -------------------------------------------------------- */
  r = await get('/v1/creators/jadedbettor-murse2-0');
  chk('profile: a removed member’s page is a 404, like a slug that never existed', r.status === 404, r);
  r = await get('/v1/models/jadedbettor-murse2-0/nfl-math-madness');
  chk('profile: and so is their model’s', r.status === 404, r);
  r = await get('/v1/creators/mustbemoose');
  chk('profile: a current member’s page still answers', r.status === 200 && r.body.creator.slug === 'mustbemoose', r);

  /* ---- the rankings (settlement) ------------------------------------------ */
  r = await get('/v1/rankings');
  const b = r.body.boards || {};
  const at = (board, slug, model) => (board || []).find(x => x.creator_slug === slug && x.model_slug === model);
  chk('rankings: the removed member is on no board',
    ['win_pct', 'margin_mae', 'brier'].every(k => !(b[k] || []).some(x => x.creator_slug === 'ghost')), b);
  chk('rankings: the two models tied behind them both move up to first, still tied',
    at(b.win_pct, 'mustbemoose', 'moose-metrics').rank === 1 && at(b.win_pct, 'blizzard', 'blizzard-nfl').rank === 1, b.win_pct);
  chk('rankings: below them, each model moves up one place per removed model ahead of it',
    at(b.margin_mae, 'mustbemoose', 'moose-metrics').rank === 1 && at(b.margin_mae, 'blizzard', 'blizzard-nfl').rank === 2 &&
    at(b.brier, 'mustbemoose', 'moose-metrics').rank === 1 && at(b.brier, 'blizzard', 'blizzard-nfl').rank === 2, { m: b.margin_mae, br: b.brier });
  chk('rankings: another league’s ranks are not touched',
    at(b.win_pct, 'blizzard', 'blizzard-cfb').rank === 1 && at(b.win_pct, 'mustbemoose', 'moose-cfb').rank === 2, b.win_pct);
  chk('rankings: the thresholds still come from the settlement',
    r.body.thresholds && r.body.thresholds.min_graded_games === 1, r.body.thresholds);

  /* ---- the activity feed --------------------------------------------------- */
  r = await get('/v1/activity');
  chk('activity: a removed member’s uploads leave the feed',
    JSON.stringify(slugsOf(r.body.rows)) === JSON.stringify(['mustbemoose']), r.body.rows);

  /* ---- the counts ---------------------------------------------------------- */
  HEADS.length = 0;
  r = await get('/v1/meta');
  const cq = HEADS.find(h => h.startsWith('creators?')) || '', mq = HEADS.find(h => h.startsWith('models?')) || '';
  chk('meta: the creator count leaves both removed members out',
    /id=not\.in\.\((c-jaded,c-ghost|c-ghost,c-jaded)\)/.test(cq), cq);
  chk('meta: and the model count leaves out their models',
    /creator_id=not\.in\.\((c-jaded,c-ghost|c-ghost,c-jaded)\)/.test(mq), mq);

  /* ---- the legacy rankings view --------------------------------------------- */
  INSTALLED = false;
  r = await get('/v1/rankings');
  const lb = r.body.boards || {};
  chk('legacy rankings: the removed member is gone and the next model is first',
    (lb.win_pct || []).length === 1 && lb.win_pct[0].creator_slug === 'mustbemoose' && lb.win_pct[0].rank === 1, lb.win_pct);
  INSTALLED = true;

  /* ---- a project the removal was never pasted into -------------------------- */
  const saved = DATA.creators;
  DATA.creators = saved.map(c => ({ id: c.id, slug: c.slug, display_name: c.display_name, status: 'active', pinned_model_id: null }));
  r = await get('/v1/wall');
  chk('no removal installed: no removed_at column, every member is served',
    slugsOf(r.body.rows).length === 4, slugsOf(r.body.rows));
  HEADS.length = 0;
  await get('/v1/meta');
  chk('no removal installed: the counts carry no exclusion',
    HEADS.filter(h => /not\.in/.test(h)).length === 0, HEADS);
  DATA.creators = saved;

  if (fail) {
    fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
    console.log(`FAILED ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`ALL GREEN ${pass} passed, 0 failed`);
})().catch(e => { console.error(e); process.exit(1); });

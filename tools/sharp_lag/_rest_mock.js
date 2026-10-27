'use strict';
/* ===========================================================================
   An in-memory PostgREST for the Sharp-lag function suites: the reads and
   writes supabase/functions/sharp_lag and sharp_check make, nothing more.
     GET     eq / neq / in / not.in / is / not.is / gt / gte / lt / lte filters,
             order=<col>.<asc|desc>, limit, offset, select (ignored: whole rows)
     POST    on_conflict=<cols> with resolution=ignore-duplicates (an existing
             key is left alone); without it a duplicate primary key is a 409
     PATCH / DELETE are refused: every Sharp-lag table is append-only, so a
             function that tried either would fail its suite
   Views are functions of the tables: sharp_lag_rows joins flags and grades.
   =========================================================================== */
function create(seed) {
  const DB = Object.assign({
    odds_api_snapshots: [], odds_api_events: [], sharp_price_snapshots: [], sharp_triggers: [], sharp_check_requests: [],
    sharp_flags: [], sharp_flag_grades: [], sharp_lag_runs: [], sharp_lag_config: [], kalshi_game_links: [], kalshi_price_snapshots: [],
    nba_injury_reports: [], nba_injury_report_snapshots: [], nhl_goalie_starters: [], market_execution_costs: []
  }, seed || {});
  const seq = { n: 1000 };
  const calls = [];
  const IDS = { sharp_triggers: 'id', sharp_check_requests: 'id', sharp_flags: 'flag_id', sharp_price_snapshots: 'id' };
  const PK = { sharp_flag_grades: ['flag_id'], sharp_lag_config: ['key'] };
  const views = {
    sharp_lag_rows: () => DB.sharp_flags.map((f) => Object.assign({}, f, DB.sharp_flag_grades.find((g) => g.flag_id === f.flag_id) || { close_status: null })),
  };
  function val(v) { return v; }
  function cmp(v, op, x) {
    if (op === 'eq') return v != null && String(v) === x;
    if (op === 'neq') return v == null || String(v) !== x;
    if (op === 'is') return x === 'null' ? v == null : x === 'true' ? v === true : v === false;
    if (op === 'not.is') return x === 'null' ? v != null : true;
    if (op === 'in' || op === 'not.in') {
      const set = x.replace(/^\(|\)$/g, '').match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || [];
      const hit = set.map((s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"')).includes(String(v));
      return op === 'in' ? hit : !hit;
    }
    if (v == null) return false;
    const a = Date.parse(v), b = Date.parse(x);
    const [l, r] = isFinite(a) && isFinite(b) && /\d{4}-\d\d-\d\dT/.test(String(x)) ? [a, b] : [Number(v), Number(x)];
    return op === 'gte' ? l >= r : op === 'lte' ? l <= r : op === 'gt' ? l > r : op === 'lt' ? l < r : true;
  }
  function select(rows, q) {
    let out = rows.slice();
    for (const [k, raw] of q.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      const m = /^(not\.in|not\.is|eq|neq|is|in|gte|lte|gt|lt)\.(.*)$/.exec(raw);
      if (!m) throw new Error('mock: unparsed filter ' + k + '=' + raw);
      out = out.filter((r) => cmp(r[k], m[1], m[2]));
    }
    const ord = q.get('order');
    if (ord) {
      const [col, dir] = ord.split('.');
      out.sort((a, b) => { const x = a[col], y = b[col]; const c = x == null ? -1 : y == null ? 1 : (x < y ? -1 : x > y ? 1 : 0); return dir === 'desc' ? -c : c; });
    }
    const off = Number(q.get('offset') || 0), lim = q.get('limit') ? Number(q.get('limit')) : Infinity;
    return out.slice(off, off + lim);
  }
  function rest(u, init) {
    const url = new URL(u), name = url.pathname.replace('/rest/v1/', ''), q = url.searchParams, m = (init && init.method) || 'GET';
    calls.push(m + ' ' + name);
    if (m === 'GET') {
      if (views[name]) return [200, select(views[name](), q)];
      if (!(name in DB)) return [404, { message: 'relation "public.' + name + '" does not exist' }];
      return [200, select(DB[name], q)];
    }
    if (m === 'POST') {
      if (!(name in DB)) return [404, { message: 'no table ' + name }];
      const rows = JSON.parse(init.body), prefer = (init.headers && init.headers.prefer) || '';
      const key = q.get('on_conflict') ? q.get('on_conflict').split(',') : (PK[name] || null);
      for (const r0 of rows) {
        const r = Object.assign({}, r0);
        if (name === 'sharp_price_snapshots') { r.participant_key = r.participant == null ? '' : r.participant; r.point_key = r.point == null ? -999999 : r.point; }
        const i = key ? DB[name].findIndex((x) => key.every((k) => String(x[k]) === String(r[k]))) : -1;
        if (i >= 0 && /ignore-duplicates/.test(prefer)) continue;
        if (i >= 0) return [409, { message: 'duplicate key value violates unique constraint' }];
        if (IDS[name] && r[IDS[name]] == null) r[IDS[name]] = ++seq.n;
        if (name === 'sharp_triggers' && !r.detected_at) r.detected_at = new Date().toISOString();
        if (name === 'sharp_check_requests' && !r.requested_at) r.requested_at = new Date().toISOString();
        DB[name].push(r);
      }
      return [201, ''];
    }
    return [405, { message: 'mock: ' + m + ' refused (append-only)' }];
  }
  return { DB, rest, calls, seq };
}
function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
module.exports = { create, resp };

#!/usr/bin/env node
/* ===========================================================================
   REMOVING A CONTRIBUTOR — the admin screen, driven offline.

   The database side of this feature is held by
   tools/collective/member_removal_sql.test.js, which runs the real SQL against
   a real PostgreSQL. This is the other half: the screen an operator actually
   uses to fire it, and the three things that screen has to get right.

     1. IT CANNOT DELETE ANYTHING BY ITSELF. Opening the panel is a read.
        The destructive option is gated on the typed word, and the page says
        out loud that the server checks it too.
     2. IT SHOWS THE REAL NUMBERS. Every figure in the impact panel comes from
        the preview the database returned. Nothing is computed here, and a
        member the activity roll cannot describe reads as unknown, never as
        zero.
     3. IT DEGRADES. supabase/collective_member_removal.sql is PASTED by hand,
        like every file in that folder. Until it is, the page must say so —
        not throw, not show an empty table, and not offer a button that 404s.

   Two passes, both offline: a STATIC scan for identifiers the new code
   references but never declares (the exact class of bug collective/tests.js
   was written for), then the REAL functions driven inside a DOM shim.

   Run:  node tools/collective/member_removal.test.js
   =========================================================================== */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');

var PAGE = path.join(__dirname, '..', '..', 'collective', 'admin.html');
var html = fs.readFileSync(PAGE, 'utf8');
var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, m, blocks = [];
while ((m = re.exec(html)) !== null) if (m[1].trim()) blocks.push(m[1]);
var CODE = blocks.join('\n;\n');

var pass = 0, fail = 0, fails = [];
function chk(n, ok, d) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; d = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; fails.push({ n: n, d: d });
}

/* ═══ STATIC: what the page says about itself ═════════════════════════════ */
chk('the page loads odds.js before its own script, so MCOdds is still defined',
  html.indexOf('src="odds.js"') < html.indexOf('"use strict"'));
chk('the removal panel is opened by a read, never by a delete',
  /NOTHING IS DELETED BY OPENING THIS/.test(CODE));
chk('the destructive option asks for the word DELETE',
  /Type <b class="mono" style="color:var\(--neg\)">DELETE<\/b> to confirm/.test(CODE));
chk('and says the server checks it as well, so nobody thinks the box is the guard',
  /The server checks this word too/.test(CODE));
chk('the acting admin is never sent as an argument — the database reads auth.uid()',
  !/p_actor/.test(CODE));
chk('the page never calls the removal routine without a mode',
  /collective_member_remove',\s*\{[\s\S]*?p_mode:mode/.test(CODE));
chk('a full delete sends the typed word and a membership removal sends null',
  /p_confirm:mode==='full_collective_delete'\?/.test(CODE));
chk('the double-click guard is in the click handler, not only in the database',
  /if\(REMOVAL_BUSY\)return;/.test(CODE));
chk('a missing migration is explained rather than shown as a status code',
  /MIGRATION_NOTE/.test(CODE) && /collective_member_removal\.sql/.test(CODE));
chk('the list refreshes from the server after a removal instead of a hard reload',
  /MEM_ACT=null;\s*\n\s*if\(app\)secMembers\(app\)/.test(CODE) && !/location\.reload\(\)/.test(
    CODE.slice(CODE.indexOf('rmGo').onclick === undefined ? CODE.indexOf('$(\'rmGo\').onclick') : 0)));
chk('the panel is scrollable and reflows on a phone',
  /\.mask\{[^}]*overflow-y:auto/.test(html) && /@media\(max-width:560px\)\{\.impact\{grid-template-columns:1fr\}/.test(html));
chk('the wide members table still scrolls inside its own box',
  /\.tblwrap\{overflow-x:auto/.test(html));

/* The identifier scan: anything the new code references and nothing declares. */
(function () {
  var declared = {};
  ['var ', 'let ', 'const ', 'function '].forEach(function () {});
  var decl = /(?:^|[\s;{(])(?:var|let|const)\s+([A-Za-z_$][\w$]*)|function\s+([A-Za-z_$][\w$]*)/g, d;
  while ((d = decl.exec(CODE)) !== null) declared[d[1] || d[2]] = true;
  /* the parameters of every function, too */
  var params = /function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g, pm;
  while ((pm = params.exec(CODE)) !== null)
    pm[1].split(',').map(function (x) { return x.trim(); }).filter(Boolean)
      .forEach(function (x) { declared[x] = true; });
  var GLOBALS = ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'history',
    'navigator', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'JSON', 'Math', 'Date',
    'Number', 'String', 'Boolean', 'Array', 'Object', 'Promise', 'URL', 'URLSearchParams',
    'Error', 'console', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'RegExp', 'Intl',
    'encodeURIComponent', 'decodeURIComponent', 'MCOdds', 'CFG', 'API', 'crypto', 'undefined',
    'confirm', 'alert', 'toast',
    'null', 'true', 'false', 'this', 'e', 'ev'];
  GLOBALS.forEach(function (g) { declared[g] = true; });
  /* only scan the block this change added, with comments and string literals
     stripped first — prose is not code, and a word inside a comment that
     happens to be followed by a bracket is not a call. */
  var start = CODE.indexOf('function memberStatus');
  var end = CODE.indexOf('async function secQuarantine');
  var block = CODE.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  var used = {}, u = /(?:^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g, uu;
  while ((uu = u.exec(block)) !== null) used[uu[1]] = true;
  var missing = Object.keys(used).filter(function (k) {
    return !declared[k] && !/^(if|for|while|switch|catch|return|typeof|function|new|await|else|do)$/.test(k);
  });
  chk('every function the removal code calls is declared on the page', missing.length === 0, missing);
})();

/* ═══ THE DOM SHIM ════════════════════════════════════════════════════════ */
var ELS = {};
/* A selector engine small enough to read and real enough to click: it parses
   the HTML a render just produced and hands back nodes carrying that tag's
   attributes, so the tests below drive the same elements an operator does. */
function matchAll(htmlStr, sel) {
  var out = [];
  var attr = /^([a-z]*)\[([-\w]+)\]$/.exec(sel);
  var cls = /^\.([-\w]+)$/.exec(sel);
  var tagRe = /<([a-z][\w-]*)\b([^>]*)>/gi, t;
  while ((t = tagRe.exec(htmlStr)) !== null) {
    var tag = t[1].toLowerCase(), rest = t[2];
    var ok = false;
    if (attr) ok = (!attr[1] || attr[1] === tag) && new RegExp('\\b' + attr[2] + '\\s*=').test(rest);
    else if (cls) ok = new RegExp('class\\s*=\\s*"[^"]*\\b' + cls[1] + '\\b').test(rest);
    if (!ok) continue;
    var n = node();
    var a = /([-\w]+)\s*=\s*"([^"]*)"/g, aa;
    while ((aa = a.exec(rest)) !== null) n.setAttribute(aa[1], aa[2]);
    out.push(n);
  }
  return out;
}
function node() {
  var n = {
    _html: '', _q: {}, value: '', textContent: '', disabled: false, style: {}, className: '',
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
    getAttribute: function (k) { return n['_attr_' + k] === undefined ? null : n['_attr_' + k]; },
    setAttribute: function (k, v) { n['_attr_' + k] = v; if (k === 'id') ELS[v] = n; },
    appendChild: function () {}, removeChild: function () {}, remove: function () { n._removed = true; },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function (sel) { if (!n._q[sel]) n._q[sel] = node(); return n._q[sel]; },
    /* Memoized per (selector, current HTML): the page wires its handlers onto
       the nodes this returns, so a second call with the same markup has to
       hand back the SAME nodes or every handler is lost and the suite would
       be testing a page nobody can click. */
    querySelectorAll: function (sel) {
      var k = sel + '\u0000' + n._html;
      if (!n._qa) n._qa = {};
      if (!n._qa[k]) n._qa[k] = matchAll(n._html, sel);
      return n._qa[k];
    },
    focus: function () {}, click: function () {}, onclick: null, onchange: null, oninput: null
  };
  Object.defineProperty(n, 'innerHTML', { get: function () { return n._html; }, set: function (v) { n._html = String(v); } });
  Object.defineProperty(n, 'id', { get: function () { return n._id; }, set: function (v) { n._id = v; ELS[v] = n; } });
  return n;
}

var MEMBERS = {
  rows: [
    { creator_slug: 'alpha', display_name: 'Alpha Analytics', founding: true, membership: 'ACTIVE CONTRIBUTOR',
      account_status: 'active', joined_at: '2026-01-14T00:00:00Z', last_submission_at: '2026-09-05T12:00:00Z',
      models: [{ name: 'Model Alpha', slug: 'alpha-1', sport: 'NFL' }], key_prefixes: ['mck_live_AAAA'], origins: [] },
    { creator_slug: 'gamma', display_name: 'Gamma', founding: false, membership: 'MEMBER',
      account_status: 'active', joined_at: '2026-08-01T00:00:00Z', last_submission_at: null,
      models: [], key_prefixes: [], origins: [] },
    { creator_slug: 'delta', display_name: 'Delta', founding: false, membership: 'INACTIVE',
      account_status: 'active', joined_at: '2026-02-01T00:00:00Z', last_submission_at: '2026-05-01T00:00:00Z',
      models: [{ name: 'Model Delta', slug: 'd-1', sport: 'NFL' }], key_prefixes: [], origins: [] }
  ]
};
var ACTIVITY = { ok: true, available: true, rows: [
  { creator_slug: 'alpha', submissions: 42, graded: 31, last_submission_at: '2026-09-05T12:00:00Z', removed_at: null, removal_mode: null },
  { creator_slug: 'gamma', submissions: 0, graded: 0, last_submission_at: null, removed_at: null, removal_mode: null },
  { creator_slug: 'delta', submissions: 9, graded: 9, last_submission_at: '2026-05-01T00:00:00Z', removed_at: '2026-09-01T00:00:00Z', removal_mode: 'membership_only' }
] };
var PREVIEW = { ok: true,
  creator: { id: 'c1', slug: 'alpha', display_name: 'Alpha Analytics', user_id: 'u1',
    joined_at: '2026-01-14T00:00:00Z', account_status: 'active', removed_at: null, is_admin: false },
  models: [{ id: 'm1', name: 'Model Alpha', slug: 'alpha-1', sport: 'NFL' }],
  counts: { submissions: 42, graded: 31, pending: 11, late: 2, quarantined: 3, counting_rows: 40,
    last_submission_at: '2026-09-05T12:00:00Z', graded_basis: 'result' },
  will_delete: { rows: 131, tables: [
    { table: 'projections', rows: 42, depth: 2, action: 'deleted' },
    { table: 'consensus_contributions', rows: 42, depth: 3, action: 'deleted' },
    { table: 'calibration_samples', rows: 4, depth: 2, action: 'deleted' },
    { table: 'earnings_ledger', rows: 6, depth: 1, action: 'preserved' }] },
  will_preserve: { rows_in_protected_tables: 6, protected_tables: [{ table: 'earnings_ledger', rows: 6 }],
    games: 376, other_contributors: 12, other_contributor_submissions: 918, auth_account: 'never touched' },
  guards: { actor_is_target: false, target_is_admin: false, admin_count: 2, already_removed: false } };

var RPC_CALLS = [], NEXT_RPC = null, ACT_AVAILABLE = true;
function reply(body, ok, status) {
  return Promise.resolve({ ok: ok !== false, status: status || 200,
    json: function () { return Promise.resolve(body); } });
}
function fakeFetch(url, opts) {
  var u = String(url);
  var body = null; try { body = JSON.parse((opts && opts.body) || 'null'); } catch (e) {}
  if (/\/rest\/v1\/rpc\//.test(u)) {
    var fn = u.split('/rpc/')[1];
    RPC_CALLS.push({ fn: fn, body: body, headers: (opts && opts.headers) || {} });
    if (!ACT_AVAILABLE) return reply({ code: 'PGRST202', message: 'Could not find the function' }, false, 404);
    if (fn === 'collective_member_activity') return reply(ACTIVITY);
    if (fn === 'collective_member_removal_preview') return reply(PREVIEW);
    if (fn === 'collective_member_remove') return reply(NEXT_RPC || { ok: true, mode: body.p_mode,
      rows_deleted: 131, submissions_deleted: 42, creator_slug: body.p_creator_slug });
    return reply({});
  }
  if (/\/v1\/admin\/members/.test(u)) return reply(MEMBERS);
  if (/\/v1\/admin\/earnings/.test(u)) return reply({ summary: { founder_pool_bps: 4000, founder_count: 4 }, rows: [] });
  return reply({});
}

/* The sheet is rendered once and then REPAINTED in three places (#rmOpts,
   #rmImpact, #rmConfirm). A browser composes those into one document; the shim
   keeps them as separate nodes, so this puts them back together — otherwise the
   suite would read a snapshot from before the operator changed anything. */
function shown() {
  var sheet = ELS.rmMask.querySelector('.sheet').innerHTML;
  var out = [sheet];
  ['rmOpts', 'rmImpact', 'rmConfirm', 'rmErr'].forEach(function (id) {
    /* only if the sheet still HOLDS that panel: replacing the sheet's markup
       destroys its children in a browser, and a stale panel read back here
       would let a test pass on markup no longer on screen. */
    if (ELS[id] && sheet.indexOf('id="' + id + '"') >= 0) out.push(ELS[id].innerHTML);
  });
  return out.join('\n');
}
/* the two option cards, as the operator sees them right now */
function optionCards() { return ELS.rmOpts ? matchAll(ELS.rmOpts.innerHTML, '[data-mode]') : []; }

var TOASTS = [];
var sandbox = {
  console: console,
  setTimeout: function (f) { return 0; }, clearTimeout: function () {},
  setInterval: function () { return 1; }, clearInterval: function () {},
  fetch: fakeFetch,
  localStorage: { _d: { collective_admin_session: JSON.stringify({ access_token: 'tok-admin' }) },
    getItem: function (k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem: function (k, v) { this._d[k] = v; }, removeItem: function (k) { delete this._d[k]; } },
  location: { hash: '', href: 'http://localhost/collective/admin.html', search: '',
    pathname: '/collective/admin.html', origin: 'http://localhost' },
  history: { replaceState: function () {} },
  navigator: { userAgent: 'node', clipboard: { writeText: function () { return Promise.resolve(); } } },
  document: {
    getElementById: function (id) { if (!ELS[id]) ELS[id] = node(); return ELS[id]; },
    querySelector: function () { return node(); }, querySelectorAll: function () { return []; },
    createElement: function () { return node(); },
    addEventListener: function () {}, removeEventListener: function () {},
    body: node(), head: node() },
  URL: URL, URLSearchParams: URLSearchParams, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp,
  Intl: Intl, Promise: Promise, Error: Error,
  atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
  crypto: { getRandomValues: function (a) { return a; } }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {}; sandbox.confirm = function () { return true; };
sandbox.alert = function () {}; sandbox.scrollTo = function () {};
vm.createContext(sandbox);
try { vm.runInContext(CODE, sandbox, { timeout: 20000 }); }
catch (e) { console.log('[boot] ' + e.message); }
var S = sandbox;
/* capture the toasts without changing the page */
var realToast = S.toast;
S.toast = function (m, k) { TOASTS.push({ m: m, k: k }); };

(function main() {
  chk('the page defines everything this suite drives',
    ['memberStatus', 'activityIndex', 'removalMessage', 'impactLines', 'num', 'shortDate',
      'rpc', 'restBase', 'secMembers', 'memberDetail', 'openRemoval', 'renderRemoval', 'closeRemoval']
      .every(function (n) { return typeof S[n] === 'function'; }),
    ['memberStatus', 'activityIndex', 'removalMessage', 'impactLines', 'num', 'shortDate',
      'rpc', 'restBase', 'secMembers', 'memberDetail', 'openRemoval', 'renderRemoval', 'closeRemoval']
      .filter(function (n) { return typeof S[n] !== 'function'; }));

  /* ── the pure parts ───────────────────────────────────────────────────── */
  chk('a removed member reads as removed whatever their membership says',
    S.memberStatus({ membership: 'ACTIVE CONTRIBUTOR' }, { removed_at: '2026-09-01', submissions: 9 }).key === 'REMOVED');
  chk('a member with no stored submissions is called out',
    S.memberStatus({ membership: 'MEMBER' }, { submissions: 0 }).key === 'NO SUBMISSIONS');
  chk('otherwise the status is the SERVER\'s, never a second opinion',
    S.memberStatus({ membership: 'ACTIVE CONTRIBUTOR' }, { submissions: 5 }).key === 'ACTIVE'
    && S.memberStatus({ membership: 'INACTIVE' }, { submissions: 5 }).key === 'INACTIVE');
  chk('with no activity row at all, nothing is invented',
    S.memberStatus({ membership: 'MEMBER' }, null).key === 'MEMBER');
  chk('an unavailable activity roll indexes to nothing rather than to zeros',
    Object.keys(S.activityIndex({ ok: true, available: false, rows: [] })).length === 0
    && Object.keys(S.activityIndex(null)).length === 0);
  chk('the roll indexes by slug', S.activityIndex(ACTIVITY).alpha.submissions === 42);

  chk('a membership removal reports that the history was kept',
    /kept/.test(S.removalMessage({ ok: true, mode: 'membership_only', submissions_deleted: 0 })));
  chk('a full delete reports the exact number the server deleted',
    S.removalMessage({ ok: true, mode: 'full_collective_delete', submissions_deleted: 42 })
      === 'Contributor and 42 Collective submissions deleted.');
  chk('one submission is not "1 submissions"',
    /and 1 Collective submission deleted/.test(
      S.removalMessage({ ok: true, mode: 'full_collective_delete', submissions_deleted: 1 })));
  chk('a contributor with nothing stored says so',
    /and 0 Collective submissions deleted/.test(
      S.removalMessage({ ok: true, mode: 'full_collective_delete', submissions_deleted: 0 })));
  chk('a repeated removal says nothing changed',
    /Nothing changed/.test(S.removalMessage({ ok: true, no_op: true })));

  var full = S.impactLines(PREVIEW, 'full_collective_delete');
  var keepOnly = S.impactLines(PREVIEW, 'membership_only');
  function has(list, label) { return list.some(function (x) { return String(x[0]).indexOf(label) >= 0; }); }
  function val(list, label) { var r = list.filter(function (x) { return String(x[0]).indexOf(label) >= 0; })[0]; return r && r[1]; }
  chk('a full delete lists the submissions it will take', val(full.del, 'Collective submissions') === 42);
  chk('and the graded and pending split', val(full.del, 'graded results') === 31 && val(full.del, 'pending') === 11);
  chk('and every dependent table the database named',
    has(full.del, 'consensus contributions') && has(full.del, 'calibration samples'));
  chk('a preserved table is NEVER listed as something that will be deleted',
    !has(full.del, 'earnings ledger') && has(full.keep, 'earnings ledger'));
  chk('the preserved column names the games, the other contributors and their rows',
    val(full.keep, 'games') === 376 && val(full.keep, 'other contributors') === 12
    && val(full.keep, 'their submissions') === 918);
  chk('and says the EdgeDesk account is never touched',
    val(full.keep, 'their EdgeDesk account') === 'never touched');
  chk('a membership removal deletes no submission and says the record is kept',
    !has(keepOnly.del, 'Collective submissions') && has(keepOnly.keep, 'Collective submissions')
    && val(keepOnly.keep, 'Collective submissions') === 42);
  chk('a preview that failed produces no impact lines to act on',
    S.impactLines({ ok: false }, 'full_collective_delete').del.length === 0);

  chk('the REST base is derived from the resolved API base, not hardcoded',
    /\/rest\/v1$/.test(S.restBase()));

  /* ── the members list ─────────────────────────────────────────────────── */
  var app = node();
  return S.secMembers(app).then(function () {
    var h = app.innerHTML;
    chk('the list gained the columns that make inactivity visible',
      /<th>Subs<\/th>/.test(h) && /<th[^>]*>Last slate<\/th>/.test(h)
      && /<th[^>]*>Joined<\/th>/.test(h) && /<th>Status<\/th>/.test(h), h.slice(0, 400));
    chk('on a phone the table drops the columns it can, never the removal action',
      /@media\(max-width:700px\)\{[\s\S]*?#memTable \.c-role,#memTable \.c-joined,#memTable \.c-model,#memTable \.c-slate\{display:none\}/.test(html));
    chk('and the two facts those columns carried move into the name cell instead of vanishing',
      /class="note c-inline">last slate .* · joined /.test(h) && /\.c-inline\{display:none\}/.test(html), h.slice(0, 700));
    chk('and the removal link says what clicking it does',
      /Nothing is deleted by clicking this/.test(h));
    chk('a member\'s real submission count is shown, not a guess', />42</.test(h));
    chk('a member who never posted is labelled, not left blank', /No submissions/.test(h));
    chk('a removed member is labelled removed', /Removed<\/span>/.test(h) || />Removed</.test(h));
    chk('every member has a removal action', matchAll(h, '[data-rm]').length === 3);
    chk('the removal action is styled as destructive', /class="linkdanger"/.test(h));
    chk('clicking the row still opens the member, and the remove link does not',
      /class="go"/.test(h));
    chk('the activity roll was read with the admin\'s own token',
      RPC_CALLS.some(function (c) { return c.fn === 'collective_member_activity'
        && String(c.headers.authorization || '').indexOf('tok-admin') > 0; }),
      RPC_CALLS.map(function (c) { return c.fn; }));

    /* ── the removal sheet ──────────────────────────────────────────────── */
    RPC_CALLS.length = 0; TOASTS.length = 0;
    return S.openRemoval(MEMBERS.rows[0], app);
  }).then(function () {
    var sheet = ELS.rmMask.querySelector('.sheet');
    var h = shown();
    chk('opening the panel asked the database what it would touch, and nothing else',
      RPC_CALLS.length === 1 && RPC_CALLS[0].fn === 'collective_member_removal_preview',
      RPC_CALLS.map(function (c) { return c.fn; }));
    chk('opening the panel deleted nothing',
      !RPC_CALLS.some(function (c) { return c.fn === 'collective_member_remove'; }));
    chk('the panel names the contributor, the slug and the model',
      /Alpha Analytics/.test(h) && /alpha/.test(h) && /Model Alpha/.test(h), h.slice(0, 300));
    chk('the panel shows the date they joined', /Joined/.test(h) && /2026/.test(h));
    chk('the panel shows submissions, graded and pending',
      />42</.test(h) && />31</.test(h) && />11</.test(h));
    chk('the panel shows the quarantined rows when there are any', /Quarantined/.test(h) && />3</.test(h));
    chk('both removals are offered', optionCards().length === 2, optionCards().length);
    chk('membership-only is the one selected first — the destructive option is never the default',
      /class="opt on"/.test(h) && !/class="opt danger on"/.test(h));
    chk('no DELETE box is shown until the destructive option is chosen', !/id="rmType"/.test(h));
    chk('the impact panel is on screen before anything is chosen', /Will be deleted/.test(h) && /Will be preserved/.test(h));
    chk('and it says the games and the other contributors stay',
      /376/.test(h) && /918/.test(h) && /never touched/.test(h));

    /* choose the destructive option, exactly as an operator does: through the
       same nodes the page wired its handlers onto. */
    var wired = ELS.rmOpts.querySelectorAll('.opt');
    chk('both option cards are wired to a handler',
      wired.length === 2 && wired.every(function (n) { return typeof n.onclick === 'function'; }),
      wired.length);
    return null;
  }).then(function () {
    var optNodes = ELS.rmOpts.querySelectorAll('.opt');
    var b = optNodes.filter(function (n) { return n.getAttribute('data-mode') === 'full_collective_delete'; })[0];
    chk('the destructive option exists to be clicked', !!b);
    if (b && b.onclick) b.onclick();
    var h = shown();
    chk('choosing the destructive option asks for the typed word', /id="rmType"/.test(h), h.slice(-800));
    chk('and warns that it cannot be undone', /cannot be undone/.test(h));
    chk('and its option card is the one now selected', /class="opt danger on"/.test(h));
    chk('the confirm button is destructive and names the number',
      ELS.rmGo.className.indexOf('danger') >= 0 && /42/.test(ELS.rmGo.textContent),
      { cls: ELS.rmGo.className, txt: ELS.rmGo.textContent });
    chk('and it is DISABLED until the word is typed', ELS.rmGo.disabled === true);

    ELS.rmType.value = 'delete';
    if (ELS.rmType.oninput) ELS.rmType.oninput();
    chk('the wrong case does not unlock it', ELS.rmGo.disabled === true);
    ELS.rmType.value = 'DELETE';
    if (ELS.rmType.oninput) ELS.rmType.oninput();
    chk('the exact word unlocks it', ELS.rmGo.disabled === false);

    RPC_CALLS.length = 0; TOASTS.length = 0;
    return ELS.rmGo.onclick();
  }).then(function () {
    chk('exactly one removal request was sent', RPC_CALLS.length === 1, RPC_CALLS.length);
    chk('and it carried the slug, the mode and the typed word',
      RPC_CALLS[0].body.p_creator_slug === 'alpha'
      && RPC_CALLS[0].body.p_mode === 'full_collective_delete'
      && RPC_CALLS[0].body.p_confirm === 'DELETE', RPC_CALLS[0] && RPC_CALLS[0].body);
    chk('it never sends who is acting — the database decides that',
      !('p_actor' in RPC_CALLS[0].body));
    chk('the success toast reports what the SERVER said it deleted',
      TOASTS.length && TOASTS[0].m === 'Contributor and 42 Collective submissions deleted.'
      && TOASTS[0].k === 'good', TOASTS);
    chk('the panel closed', ELS.rmMask._removed === true);

    /* a refusal from the database is shown, and the panel stays open */
    NEXT_RPC = { ok: false, code: 'last_admin', message: 'This contributor is the only configured Collective administrator.' };
    RPC_CALLS.length = 0; TOASTS.length = 0;
    return S.openRemoval(MEMBERS.rows[0], app);
  }).then(function () {
    return ELS.rmGo.onclick();
  }).then(function () {
    chk('a refusal is shown in the panel, not swallowed',
      /only configured Collective administrator/.test(ELS.rmErr.innerHTML), ELS.rmErr.innerHTML);
    chk('and as an error toast', TOASTS.length && TOASTS[TOASTS.length - 1].k === 'bad', TOASTS);
    chk('the panel stays open so the admin can act on it', ELS.rmMask._removed !== true);
    chk('and the button comes back rather than staying dead', ELS.rmGo.disabled === false);

    /* a double click must not send two removals */
    NEXT_RPC = { ok: true, mode: 'membership_only', submissions_deleted: 0 };
    RPC_CALLS.length = 0;
    var p1 = ELS.rmGo.onclick();
    var p2 = ELS.rmGo.onclick();
    return Promise.all([p1, p2]).then(function () {
      chk('a double click sends ONE removal', RPC_CALLS.length === 1, RPC_CALLS.length);
    });
  }).then(function () {
    /* the admin's own row, and an admin target */
    var pv = JSON.parse(JSON.stringify(PREVIEW));
    pv.guards.actor_is_target = true;
    S.renderRemoval(pv, MEMBERS.rows[0], null);
    var h = shown();
    chk('an admin is told they cannot remove themselves', /cannot remove themselves/.test(h));
    chk('and the button is dead', ELS.rmGo.disabled === true);

    pv = JSON.parse(JSON.stringify(PREVIEW));
    pv.guards.target_is_admin = true; pv.guards.admin_count = 2;
    S.renderRemoval(pv, MEMBERS.rows[0], null);
    h = shown();
    chk('removing an administrator carries a stronger warning',
      /is a Collective administrator/.test(h) && /admin\.user_ids/.test(h));
    chk('and it says removal does not take their admin rights away',
      /does not remove their admin rights/.test(h));

    pv.guards.admin_count = 1;
    S.renderRemoval(pv, MEMBERS.rows[0], null);
    h = shown();
    chk('the last administrator is told the removal will be refused',
      /ONLY configured administrator/.test(h));

    pv = JSON.parse(JSON.stringify(PREVIEW));
    pv.guards.already_removed = true; pv.creator.removed_at = '2026-09-01T00:00:00Z';
    S.renderRemoval(pv, MEMBERS.rows[0], null);
    h = shown();
    chk('an already-removed member says so, and says what a full delete would still take',
      /Already removed/.test(h) && /full delete would still remove/.test(h));

    /* a contributor with nothing stored */
    pv = JSON.parse(JSON.stringify(PREVIEW));
    pv.counts = { submissions: 0, graded: 0, pending: 0, late: 0, quarantined: 0, last_submission_at: null };
    pv.will_delete = { rows: 1, tables: [{ table: 'api_keys', rows: 1, depth: 1, action: 'deleted' }] };
    S.renderRemoval(pv, MEMBERS.rows[1], null);
    h = shown();
    chk('a contributor with zero submissions still gets the same panel and the same safeguards',
      /Will be deleted/.test(h) && optionCards().length === 2);
    chk('and it shows a zero rather than a dash', />0</.test(h));
    var zb = ELS.rmOpts.querySelectorAll('.opt')
      .filter(function (n) { return n.getAttribute('data-mode') === 'full_collective_delete'; })[0];
    if (zb && zb.onclick) zb.onclick();
    chk('deleting a contributor with nothing stored still asks for the word', /id="rmType"/.test(shown()));
    chk('the button names zero submissions honestly',
      /Delete 0 submissions and remove/.test(ELS.rmGo.textContent), ELS.rmGo.textContent);
  }).then(function () {
    /* ── the migration has not been pasted yet ──────────────────────────── */
    ACT_AVAILABLE = false; S.MEM_ACT = null;
    var app2 = node();
    return S.secMembers(app2).then(function () {
      var h = app2.innerHTML;
      chk('without the migration the list still renders every member',
        /Alpha Analytics/.test(h) && /Gamma/.test(h), h.slice(0, 200));
      chk('and says why the counts are missing rather than showing zeros',
        /not installed on this project yet/.test(h) && /collective_member_removal\.sql/.test(h));
      chk('and shows a dash where it does not know', /—/.test(h));
      return S.openRemoval(MEMBERS.rows[0], app2);
    }).then(function () {
      chk('and the removal panel explains it instead of offering a button that 404s',
        /not installed on this project yet/.test(ELS.rmMask.querySelector('.sheet').innerHTML)
        && !/id="rmType"/.test(shown()));
    });
  }).then(done, function (e) {
    chk('the suite ran to the end', false, { threw: String((e && e.stack) || e) });
    done();
  });
})();

function done() {
  fails.forEach(function (f) {
    console.log('FAIL | ' + f.n + (f.d !== undefined ? '  ' + JSON.stringify(f.d).slice(0, 500) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

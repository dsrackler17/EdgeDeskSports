#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — the social layer, on the client side.
 
   The server-side guarantees live in tools/games/sql_security.test.js, which
   applies the real schema to a real PostgreSQL and attacks it. This suite holds
   the half that lives in the browser:
 
     1  the grading rules are deterministic and settle the way they are
        documented, including every draw
     2  the client library cannot invent an identity, and treats a bearer
        secret as a credential
     3  the pages never render an answer the server did not send
     4  private routes are noindex and the public explainer is not
     5  the viral funnel is instrumented end to end
     6  the pages are mobile-first and thumb-friendly
     7  the responsible-product language holds across the new surfaces
 
   Run: node tools/games/social.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const G = f => path.join(ROOT, 'games', f);

let MEM = {}, COOKIES = {};
global.localStorage = {
  getItem: k => (MEM[k] == null ? null : MEM[k]),
  setItem: (k, v) => { MEM[k] = String(v); },
  removeItem: k => { delete MEM[k]; }
};
global.document = {
  get cookie() { return Object.keys(COOKIES).map(k => k + '=' + COOKIES[k]).join('; '); },
  set cookie(v) { const m = String(v).match(/^([^=]+)=([^;]*)/); if (m) COOKIES[m[1]] = m[2]; }
};
global.location = { search: '', pathname: '/games/h2h/', origin: 'https://edgedesksports.com' };
/* Node 22 exposes globalThis.crypto as a getter-only property, so it cannot be
   assigned. The library only ever asks for getRandomValues. */
if (!global.crypto || !global.crypto.getRandomValues) {
  Object.defineProperty(global, 'crypto', {
    value: require('crypto').webcrypto, configurable: true
  });
}
global.window = global.window || global;

const SC = require(G('lib/scoring.js'));
const GRADE = require(G('lib/h2h_grade.js'));
const S = require(G('lib/social.js'));

/* ═══ 1. GRADING ══════════════════════════════════════════════════════════ */

/* winner */
eq('the side that wins takes it',
  GRADE.gradeWinner({ side: 'home' }, { side: 'away' }, 31, 20).outcome_a, 'win');
eq('and the other player loses it',
  GRADE.gradeWinner({ side: 'away' }, { side: 'home' }, 31, 20).outcome_a, 'loss');
eq('a tied game is a draw',
  GRADE.gradeWinner({ side: 'home' }, { side: 'away' }, 20, 20).outcome_a, 'draw');
eq('two players on the same side is a draw, not a double win',
  GRADE.gradeWinner({ side: 'home' }, { side: 'home' }, 31, 20).outcome_a, 'draw');
eq('an ungradeable winner challenge settles nothing',
  GRADE.gradeWinner({ side: 'home' }, { side: 'away' }, null, 20), null);

/* spread — always against the SNAPSHOT */
eq('covering the locked line wins',
  GRADE.gradeSpread({ side: 'home' }, { side: 'away' }, -7, 31, 21).outcome_a, 'win');
eq('failing to cover loses',
  GRADE.gradeSpread({ side: 'home' }, { side: 'away' }, -7, 24, 21).outcome_a, 'loss');
eq('landing exactly on the line is a DRAW, not a win for anyone',
  GRADE.gradeSpread({ side: 'home' }, { side: 'away' }, -7, 28, 21).outcome_a, 'draw');
eq('a push says so', GRADE.gradeSpread({ side: 'home' }, { side: 'away' }, -7, 28, 21).covered, 'push');
eq('an underdog covering wins for the side that took it',
  GRADE.gradeSpread({ side: 'away' }, { side: 'home' }, -10, 24, 21).outcome_a, 'win');
eq('no snapshotted line settles nothing',
  GRADE.gradeSpread({ side: 'home' }, { side: 'away' }, null, 31, 21), null);

(() => {
  /* the whole point of a snapshot: a moved market must not change a result */
  const ch = { mode: 'spread', market_snapshot: { spread: -3 } };
  const r = GRADE.grade(ch, { side: 'home' }, { side: 'away' }, { home_score: 27, away_score: 21 });
  eq('a spread challenge grades on its own snapshot', r.outcome_a, 'win');
  const moved = { mode: 'spread', market_snapshot: { spread: -10 } };
  eq('and a different snapshot genuinely grades differently',
    GRADE.grade(moved, { side: 'home' }, { side: 'away' },
      { home_score: 27, away_score: 21 }).outcome_a, 'loss');
})();

/* price it */
(() => {
  const r = GRADE.gradePriceIt({ spread: -8 }, { spread: -3 }, { close: -8.5 });
  eq('the closer line wins Price It', r.outcome_a, 'win');
  eq('and the benchmark is named', r.benchmark_basis, 'closing line');
  eq('with both distances recorded', r.distance_a, 0.5);
  eq('and both scores', r.score_a, 100);
  eq('an equal distance is a draw',
    GRADE.gradePriceIt({ spread: -7 }, { spread: -10 }, { close: -8.5 }).outcome_a, 'draw');
  eq('without a close it falls back to the market',
    GRADE.gradePriceIt({ spread: -8 }, { spread: -3 }, { market: -8.5 }).benchmark_basis, 'market');
  eq('and to EdgeDesk only when there is nothing else',
    GRADE.gradePriceIt({ spread: -8 }, { spread: -3 }, { edgedesk: -8.5 }).benchmark_basis,
    'EdgeDesk projection');
  eq('with no benchmark at all it settles nothing',
    GRADE.gradePriceIt({ spread: -8 }, { spread: -3 }, {}), null);
  chk('Price It grading reuses the published scoring rule',
    r.score_a === SC.scoreForDistance(r.distance_a));
})();

/* the one entry point */
(() => {
  const ch = { mode: 'winner', market_snapshot: {} };
  const r = GRADE.grade(ch, { side: 'home' }, { side: 'away' }, { home_score: 31, away_score: 20 });
  eq('grade() returns both outcomes', r.outcome_b, 'loss');
  eq('and they are always opposites', GRADE.flip(r.outcome_a), r.outcome_b);
  chk('and freezes the evidence', r.evidence.home_score === 31 && r.evidence.mode === 'winner');
  eq('a draw flips to a draw', GRADE.flip('draw'), 'draw');
  eq('an unknown mode settles nothing',
    GRADE.grade({ mode: 'roulette' }, { side: 'home' }, { side: 'away' },
      { home_score: 1, away_score: 0 }), null);
  eq('a missing result settles nothing',
    GRADE.grade(ch, { side: 'home' }, { side: 'away' }, null), null);
})();

/* determinism */
(() => {
  const ch = { mode: 'spread', market_snapshot: { spread: -3.5 } };
  const a = JSON.stringify(GRADE.grade(ch, { side: 'home' }, { side: 'away' },
    { home_score: 27, away_score: 21 }));
  let stable = true;
  for (let i = 0; i < 500; i++) {
    if (JSON.stringify(GRADE.grade(ch, { side: 'home' }, { side: 'away' },
      { home_score: 27, away_score: 21 })) !== a) { stable = false; break; }
  }
  chk('grading is deterministic', stable);
})();

/* ═══ 2. THE CLIENT LIBRARY ═══════════════════════════════════════════════ */

eq('an unconfigured client reports itself unavailable rather than guessing',
  S.available(), null);
(async () => {
  const r = await S.rpc('h2h_view', {});
  eq('and a call against it fails cleanly instead of throwing', r.ok, false);
  eq('with a reason a page can render', r.error, 'not_configured');
  chk('and a sentence a person can read', typeof r.message === 'string' && r.message.length > 10);
  finish();
})();

eq('nobody is signed in without a session', S.signedIn(), false);
eq('and there is no user to name', S.user(), null);

(() => {
  /* an expired token is not a signed-in user */
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', email: 'a@b.c', exp: 1 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  MEM['edgedesk_session'] = JSON.stringify({ access_token: 'x.' + payload + '.y' });
  global.atob = s => Buffer.from(s, 'base64').toString('binary');
  eq('an expired session is not a signed-in user', S.signedIn(), false);

  const live = Buffer.from(JSON.stringify({ sub: 'u1', email: 'davis@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600, user_metadata: { display_name: 'Davis' } }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  MEM['edgedesk_session'] = JSON.stringify({ access_token: 'x.' + live + '.y' });
  eq('a live session is', S.signedIn(), true);
  eq('and carries the display name', S.displayName(), 'Davis');
  eq('the user id comes from the token, never from an argument', S.user().id, 'u1');
  MEM = {}; COOKIES = {};
})();

(() => {
  const a = S.secret();
  chk('an anonymous player gets a bearer secret', !!a && a.length >= 32, String(a));
  eq('and it is stable across calls', S.secret(), a);
  chk('it is hex from the platform CSPRNG, not Math.random', /^[0-9a-f]{64}$/.test(a));
  /* comments may NAME the thing they rule out; the code may not use it */
  const src = fs.readFileSync(G('lib/social.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  lacks(src, 'Math.random', 'a credential is never generated from Math.random');
  chk('and the absence of a CSPRNG is an error, not a fallback',
    /getRandomValues/.test(src) && /return null/.test(src));
  MEM = {};
})();

/* the phase machine — one place decides what a screen is */
(() => {
  const soon = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  eq('a stranger on an open challenge takes their turn',
    S.phase({ status: 'WAITING', your_slot: null }), 'YOUR_TURN');
  eq('the creator waits', S.phase({ status: 'WAITING', your_slot: 'a' }), 'WAITING_FOR_OPPONENT');
  eq('both in, before kickoff, is locked',
    S.phase({ status: 'LOCKED', locked_at: past, kickoff: soon }), 'LOCKED');
  eq('after kickoff it is in progress',
    S.phase({ status: 'LOCKED', locked_at: past, kickoff: past }), 'IN_PROGRESS');
  eq('a settled challenge is final',
    S.phase({ status: 'FINAL', locked_at: past, settled_at: past }), 'FINAL');
  eq('a settled draw is a draw',
    S.phase({ status: 'DRAW', locked_at: past, settled_at: past }), 'DRAW');
  eq('an expired challenge is expired', S.phase({ status: 'EXPIRED' }), 'EXPIRED');
  eq('nothing is missing', S.phase(null), 'MISSING');
  Object.keys(S.PHASE_LABEL).forEach(k => {
    chk('every phase has a label: ' + k, !!S.PHASE_LABEL[k]);
  });
})();

/* selections are read from what the server sent, never reconstructed */
(() => {
  const sealed = { your_slot: 'b', selections: { b: { side: 'home' } },
    entries: [{ slot: 'a', display_name: 'Davis' }, { slot: 'b', display_name: 'Robert' }] };
  eq('your own answer is readable', S.selectionOf(sealed, 'b').side, 'home');
  eq('an answer the server withheld is simply absent', S.selectionOf(sealed, 'a'), null);
  eq('and the opponent is still nameable', S.them(sealed).display_name, 'Davis');
  eq('and you are still you', S.you(sealed).display_name, 'Robert');
  const src = fs.readFileSync(G('lib/social.js'), 'utf8');
  chk('the client has no way to ask for a hidden answer',
    !/reveal|force|show_all|include_selections/i.test(src));
})();

eq('a challenge link is the pretty form people paste',
  S.challengeUrl('abc123'), 'https://edgedesksports.com/games/h2h/abc123');
eq('a group link too', S.groupUrl('xyz789'), 'https://edgedesksports.com/games/groups/xyz789');
chk('tokens are escaped into links', S.challengeUrl('a/b').indexOf('a%2Fb') > 0);

/* ═══ 3-7. THE SHIPPED FILES ══════════════════════════════════════════════ */
const H2H = fs.readFileSync(G('h2h/index.html'), 'utf8');
const GRP = fs.readFileSync(G('groups/index.html'), 'utf8');
const HOME = fs.readFileSync(G('index.html'), 'utf8');
const JS = fs.readFileSync(G('games.js'), 'utf8');
const CSS = fs.readFileSync(G('games.css'), 'utf8');
const SOC = fs.readFileSync(G('lib/social.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_social.sql'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const SOCIAL_PAGES = [['head-to-head', H2H], ['groups', GRP]];

/* ── 3. no page renders an answer the server withheld ──────────────────── */
SOCIAL_PAGES.forEach(([n, p]) => {
  chk(n + ' reads selections only through the library',
    !/selections\s*\[/.test(p) || /S\.selectionOf/.test(p));
});
has(H2H, 'S.selectionOf', 'the challenge page asks the library for an answer');
chk('the challenge page never fabricates a missing answer',
  H2H.indexOf('pickLabel') >= 0 && /if\(!sel\)return '—'/.test(H2H));
has(H2H, 'is hidden', 'the invite screen states that the opponent’s pick is sealed');
has(H2H, 'nothing to peek at', 'and says why it cannot be peeked at');
chk('the sealed notice is shown before a pick, not after',
  H2H.indexOf('sealed') < H2H.indexOf('Lock my pick'));

/* the guarantee is in the database, and the SQL says so structurally */
has(SQL, 'game_challenge_selections', 'the secret lives in its own table');
chk('and no policy grants read on it',
  !/create policy[^;]*on public\.game_challenge_selections/i.test(SQL),
  'a policy was added to the table whose whole point is having none');
has(SQL, 'security definer', 'privileged reads go through security-definer functions');
chk('every security-definer function pins its search_path',
  (SQL.match(/security definer/g) || []).length
  === (SQL.match(/security definer set search_path = public, pg_temp/g) || []).length,
  'a definer function without a pinned search_path is an escalation waiting to happen');
chk('settlement is granted to no client role',
  /revoke all on function public\.h2h_settle/.test(SQL));
chk('nor is the correction path', /revoke all on function public\.h2h_correct/.test(SQL));
chk('a bearer secret is stored hashed, never in the clear',
  /digest\(p_secret, 'sha256'\)/.test(SQL));
chk('a short secret is refused rather than hashed',
  /length\(p_secret\) < 16/.test(SQL));
chk('invite tokens come from the CSPRNG', /gen_random_bytes/.test(SQL));
chk('the client never supplies a user id as proof',
  !/p_user_id|p_uid/.test(SQL));

/* challenging a named member from a group */
chk('a challenge started from a group names who the link is for',
  /var VS=param\('vs'\)/.test(H2H) && /Challenge '\+esc\(VS\)/.test(H2H));
chk('and the share text names them too', /VS\?\(VS\+' — I'\)/.test(H2H));
chk('but an invite is still a link anyone can open, not a directed message',
  /there is no way to push a challenge at/.test(H2H));
chk('the group member row starts that flow',
  /\/games\/h2h\/\?vs='\+encodeURIComponent/.test(GRP));

/* ── 4. private routes are noindex ─────────────────────────────────────── */
SOCIAL_PAGES.forEach(([n, p]) => {
  has(p, 'name="robots" content="noindex,nofollow"', n + ' is not indexable');
  chk(n + ' still declares a title', /<title>[^<]{6,}<\/title>/.test(p));
  has(p, 'property="og:title"', n + ' has an Open Graph title for the share sheet');
});
has(HOME, 'name="robots" content="index,follow"', 'the public games home stays crawlable');
has(HOME, 'Challenge a friend', 'and carries the public explainer for the social layer');
chk('no private route is in the sitemap',
  SITEMAP.indexOf('/h2h') < 0 && SITEMAP.indexOf('/groups') < 0);
has(NOTFOUND, "p[1]==='h2h'", 'a pretty challenge link routes');
has(NOTFOUND, "p[1]==='groups'", 'a pretty group link routes');

/* ── 5. the viral funnel ───────────────────────────────────────────────── */
const REQUIRED = ['h2h_create', 'h2h_invite_generated', 'h2h_invite_open', 'h2h_opponent_submit',
  'h2h_both_locked', 'h2h_settled', 'h2h_rematch', 'group_create', 'group_invite_generated',
  'group_invite_open', 'group_join', 'group_weekly_return', 'research_open_from_h2h',
  'research_open_from_group', 'signup_from_h2h', 'signup_from_group', 'subscription_from_games'];
REQUIRED.forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
const ALL = H2H + GRP + HOME + JS;
['h2h_create', 'h2h_invite_generated', 'h2h_invite_open', 'h2h_opponent_submit',
 'h2h_both_locked', 'h2h_settled', 'h2h_rematch', 'group_create', 'group_invite_generated',
 'group_invite_open', 'group_join', 'group_weekly_return', 'research_open_from_h2h',
 'signup_from_h2h', 'signup_from_group'].forEach(e => {
  chk('and actually fires ' + e, new RegExp("track\\('" + e + "'").test(ALL));
});
SOCIAL_PAGES.forEach(([n, p]) => {
  has(p, 'G-1PXVBV53FZ', n + ' reports to the existing analytics property');
});
chk('no second analytics vendor rides in with the social layer',
  !/posthog|mixpanel|segment\.com|amplitude|plausible\.io|fathom/i.test(ALL));
chk('social events carry the mode', /mode:\s*ch\.mode|mode:\s*DRAFT\.mode/.test(ALL));
chk('and whether the player was anonymous',
  /identity:S\.signedIn\(\)\?'authenticated':'anonymous'/.test(ALL));
chk('attribution is carried into the terminal from the social pages',
  /withAttribution/.test(H2H) && /withAttribution/.test(GRP));

/* ── 6. mobile first ───────────────────────────────────────────────────── */
SOCIAL_PAGES.forEach(([n, p]) => {
  has(p, 'width=device-width', n + ' is responsive');
  has(p, 'viewport-fit=cover', n + ' handles a notched phone');
});
chk('a side button meets the tap minimum', /\.side\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('a mode button meets the tap minimum', /\.mode\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('a member row meets the tap minimum', /\.member\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('an active-challenge row meets the tap minimum',
  /\.act-row\{[^}]*min-height:var\(--tap\)/.test(CSS));
chk('the versus block is a grid that survives a long team name',
  /\.vs\{[^}]*grid-template-columns/.test(CSS) && /\.vs-n\{[^}]*overflow-wrap:break-word/.test(CSS));
chk('an invite URL wraps instead of overflowing',
  /\.invite \.url\{[^}]*word-break:break-all/.test(CSS));

/* ── 7. responsible product ────────────────────────────────────────────── */
const COPY = H2H + GRP + HOME + JS + CSS + SOC;
[/guaranteed edge/i, /free money/i, /can'?t lose/i, /sure thing/i, /risk-?free/i,
 /\bwager\b(?!ing)/i, /\bbet slip\b/i, /\bparlay\b/i, /\bodds boost\b/i].forEach(re => {
  chk('the social copy avoids ' + re,
    !re.test(COPY.replace(/no real-money wagering/gi, '')),
    (COPY.match(re) || [''])[0]);
});
(() => {
  const DENIALS = [/No deposits, no wallet, no balance, no entry fee\s*and no prizes\./gi,
    /no deposits/gi, /no wallet/gi, /no balance/gi, /no entry fee/gi, /no cash prize/gi,
    /no prizes/gi];
  let copy = COPY;
  DENIALS.forEach(re => { copy = copy.replace(re, ''); });
  chk('the social layer introduces no balance, wallet, entry fee or prize',
    !/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize|virtual currency|loot box/i.test(copy),
    (copy.match(/\bdeposit\b|\bwallet\b|\bbalance\b|entry fee|cash prize/i) || [''])[0]);
})();
SOCIAL_PAGES.forEach(([n, p]) => {
  chk(n + ' states that it is free to play', /Free to play|free to play/.test(p));
});
chk('a rating is described as a game rating, never a betting skill rating',
  !/betting (skill|ability) rating/i.test(COPY) && /game rating/i.test(COPY));
chk('a loss is never framed as the player being shown up',
  !/you were wrong|you lost because|should have known/i.test(COPY));
has(H2H, 'EdgeDesk gets games wrong too', 'and the research CTA stays honest about the model');

/* the feed is a sports activity feed, not a social network */
chk('the activity feed has no free-text field to post into',
  !/textarea|contenteditable|post a message|comment/i.test(GRP));
chk('there is no chat, DM or follower mechanic anywhere',
  !/direct message|\bDM\b|follower|following count/i.test(COPY));
chk('the feed renders only known event kinds',
  /a\.kind==='h2h_settled'/.test(GRP) && /return ''/.test(GRP));

/* free vs premium: no pay-to-win */
chk('nothing in the social layer scores differently for a subscriber',
  !/subscriber.*(bonus|multiplier|extra points)|pro.*multiplier/i.test(COPY));
chk('and none of the social games are paywalled',
  !/subscribe to (play|challenge|join)|upgrade to (play|challenge|join)/i.test(COPY));
chk('the group gate asks for an account, not a subscription',
  /free account/i.test(GRP) && !/subscribe/i.test(GRP.slice(0, GRP.indexOf('</main>'))));

/* privacy */
chk('no page renders an email address',
  !/\.email\b/.test(H2H + GRP) || !/textContent\s*=\s*[^;]*\.email/.test(H2H + GRP));
/* A stranger holding an invite link may learn the group's name and how many
   people are in it. Not who they are — that is membership information and it
   belongs to the members. Checked against the FUNCTION BODY, not the file. */
(() => {
  const i = SQL.indexOf('function public.group_preview');
  const body = SQL.slice(i, SQL.indexOf('$$;', i));
  chk('the group preview reports a headcount', /'members', v_n/.test(body));
  chk('and names no member', !/display_name/.test(body), body.slice(0, 200));
  chk('and does not leak the owner', !/owner_user_id/.test(body));
  const j = SQL.indexOf('function public.group_dashboard');
  const dash = SQL.slice(j, SQL.indexOf('$$;', j));
  chk('the dashboard, which members alone can open, does name them',
    /display_name/.test(dash));
  chk('and refuses a non-member outright', /not a member of this group/.test(dash));
})();
chk('display names are what the product shows', /display_name/.test(SOC));

/* ── the status read-out ───────────────────────────────────────────────── */
(() => {
  const ST_PAGE = fs.readFileSync(G('status/index.html'), 'utf8');
  has(ST_PAGE, 'name="robots" content="noindex,nofollow"', 'the status page is not indexable');
  chk('it is reachable from every page', /\/games\/status\//.test(JS));
  chk('it reports the challenge board', /Challenge board/.test(ST_PAGE));
  chk('it reports the market feed, which gates Pick 5 and Spread',
    /Market feed/.test(ST_PAGE) && /Pick 5 and the Spread/.test(ST_PAGE));
  chk('it names the service-role cause rather than just saying "no market"',
    /SUPABASE_SERVICE_KEY/.test(ST_PAGE) && /auth\.uid\(\)/.test(ST_PAGE));
  chk('it reports the social layer and how to deploy it',
    /Social layer/.test(ST_PAGE) && /games_social\.sql/.test(ST_PAGE));
  chk('it distinguishes an undeployed backend from a broken one',
    /r\.status===404/.test(ST_PAGE));
  chk('it says plainly what still works when a feed is down',
    /unaffected/.test(ST_PAGE));
  chk('it changes nothing — a read-out, not a control panel',
    !/<input(?![^>]*type="range")/.test(ST_PAGE) && !/rpc\('h2h_create/.test(ST_PAGE));
})();

/* ── the builder reads the market as a role that can actually see it ───── */
(() => {
  const B = fs.readFileSync(G('build_challenges.js'), 'utf8');
  chk('the builder prefers the service role', /EDGD_SB_SERVICE/.test(B));
  chk('and reports which role it read as', /reading as the ' \+ cfg\.role/.test(B));
  chk('it reads both of the sources the terminal uses',
    /signals\?select=/.test(B) && /accept-profile/.test(B));
  chk('a zero market on an anon key names the RLS cause out loud',
    /keys on auth\.uid\(\)/.test(B) && /EDGD_SB_SERVICE \(the service-role key\)/.test(B));
  chk('an inverted lines table is refused rather than published',
    /linesLookInverted/.test(B) && /sign error, not a slate/.test(B));
  chk('the home-line convention is stated where it is written',
    /HOME team's betting line \(home -7 = -7\)/.test(B));
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-challenges.yml'), 'utf8');
  chk('CI passes the service key to the build', /EDGD_SB_SERVICE: \$\{\{ secrets\.SUPABASE_SERVICE_KEY/.test(WF));
  chk('and warns loudly when the board ships with no market',
    /::warning::No game on this board carries a book number/.test(WF));
})();

function finish() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | games social | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
  process.exit(fail ? 1 : 0);
}

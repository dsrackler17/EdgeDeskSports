#!/usr/bin/env node
/* ============================================================================
   THE DESK, offline. No database, no network: the shipped modules against
   this season's committed data.

     lib            formats, the query language, the voice rules, the
                    verifier, the Markdown escaper, UTM, the kit
     generators     all five types build from real data, pass their own voice
                    and source checks, and every number re-derives from the
                    file AT THE COMMIT the draft recorded (tools/desk/verify.js)
     the rules      a hand-typed number, an em dash, "we", a third-person
                    "EdgeDesk thinks" and a changed source file are each caught
     planner        what is due today, and never a one-game leftover week
     pages          the desk page carries the take, "Data as of", the author
                    and valid Article + Person + Dataset JSON-LD; a game page
                    carries a Person author; the build refuses a desk record
                    without a take
     editorial      the publisher holds a NEW game article without a take and
                    never touches one already published
     takes, sync    fail closed; a failed read changes nothing
     desk_cron      imported as deployed: secret, owner check, claim, DM,
                    webhook, dry run, dispatch, no secret in any output

   Run: node tools/desk/desk.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../../lib/edgedesk_desk.js');
const SRC = require('./sources.js');
const G = require('./generators.js');
const GEN = require('./generate.js');
const V = require('./verify.js');
const DR = require('./desk_render.js');
const STORE = require('./store.js');
const SYNC = require('./sync.js');
const TAKES = require('./takes.js');
const R = require('../articles/article_render.js');
const PUBLISH = require('../editorial/publisher.js');
const ASTORE = require('../articles/store.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  × ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function section(s) { console.log('· ' + s); }

(async function main() {
  /* ── the lib ──────────────────────────────────────────────────────── */
  section('lib');
  chk('line format', D.fmt(-2.5, 'line') === '-2.5' && D.fmt(3, 'line') === '+3' && D.fmt(0, 'line') === 'PK' && D.fmt(-7.30, 'line') === '-7.3');
  chk('odds format', D.fmt(-110, 'odds') === '-110' && D.fmt(140, 'odds') === '+140');
  chk('points format', D.fmt(0, 'pts') === '0' && D.fmt(5.5, 'pts') === '+5.5' && D.fmt(-2, 'pts') === '-2' && D.fmt(0.51, 'pts2') === '+0.51' && D.fmt(-0.004, 'pts2') === '0.00');
  chk('units and percent', D.fmt(0.925926, 'units') === '+0.93u' && D.fmt(52.38, 'pct1') === '52.4%' && D.fmt(0.333, 'prob0') === '33%');
  chk('month and date from data', D.fmt('2026-09-27T16:00:00Z', 'month') === 'September 2026' && D.fmt('2026-09-27T16:00:00Z', 'date') === 'Sep 27');
  const S0 = { s: { doc: { rows: [{ id: 'a', v: 2, w: 1 }, { id: 'b', v: 4, w: 5 }, { id: 'c', v: null, w: 0 }], m: { x: { k: 1 } } }, file: 'f.json' } };
  chk('query: find', D.evalQuery(S0, { src: 's', path: ['rows', { find: [['id', '=', 'b']] }, 'v'] }) === 4);
  chk('query: filter + count', D.evalQuery(S0, { src: 's', path: ['rows', { filter: [['v', 'notnull']] }], agg: { fn: 'count' } }) === 2);
  chk('query: avg ignores nulls', D.evalQuery(S0, { src: 's', path: ['rows'], agg: { fn: 'avg', field: 'v' } }) === 3);
  chk('query: field-to-field', D.evalQuery(S0, { src: 's', path: ['rows', { filter: [['v', '>', { field: 'w' }]] }], agg: { fn: 'count' } }) === 1);
  chk('query: derived abs_sub', D.evalQuery(S0, { op: 'abs_sub', args: [{ src: 's', path: ['rows', 0, 'v'] }, { src: 's', path: ['rows', 1, 'v'] }] }) === 2);
  chk('query: a map of games is walked in key order', D.evalQuery(S0, { src: 's', path: ['m', '*', 0, 'k'] }) === 1);
  chk('query: described in words', /f\.json :: rows > first\[id = "b"\] > v/.test(D.describeQuery({ src: 's', path: ['rows', { find: [['id', '=', 'b']] }, 'v'] }, S0)));
  chk('a record is not a minus sign', JSON.stringify(D.numberTokens('went 4-9, then -2.5 and 2024-25')) === JSON.stringify(['4', '9', '-2.5', '2024', '25']));

  section('voice');
  const vc = (t) => D.voiceCheck(t).issues.map(i => i.id);
  chk('an em dash is refused', vc('My number moved — a lot.').indexOf('em_dash') >= 0);
  chk('"we" is refused', vc('We think my number is right.').indexOf('plural') >= 0);
  chk('third person is refused', vc('EdgeDesk thinks the close was wrong. I agree.').indexOf('third_person') >= 0);
  chk('hype is refused', vc('My lock of the week.').indexOf('hype') >= 0 && vc('I am a sharp.').indexOf('hype') >= 0);
  chk('advice is refused', vc('I say you should bet it.').indexOf('advice') >= 0);
  chk('plain first person passes', D.voiceCheck('My number missed by 3 points. I was wrong about the passing game.').ok);
  chk('"US" and "USC" are not "us"', D.voiceCheck('I had USC in the US Bank game.').ok);
  chk('a take is never rewritten, only measured', D.takeCheck('short').ok === false && D.takeCheck('x'.repeat(240)).ok && D.takeCheck('  a\n\n  b  ', 3).chars === 3);

  section('Markdown is escaped');
  const html = D.mdToHtml('## Head <script>x</script>\n\nA **bold** [mine](https://edgedesksports.com/record.html) and [theirs](https://evil.example/) <img src=x onerror=alert(1)>\n\n| A | B |\n|---|---|\n| <b>1</b> | 2 |');
  chk('no raw tag survives', !/<script|<img|<b>1/.test(html) && /&lt;script&gt;/.test(html));
  chk('only my own site is linked', /href="https:\/\/edgedesksports\.com\/record\.html"/.test(html) && !/evil\.example/.test(html.replace(/>theirs</, '')) && !/href="https:\/\/evil/.test(html));
  chk('tables render with labels for phones', /<td data-l="A">/.test(html));

  /* ── the generators, on this season's data ───────────────────────── */
  section('generators on real data');
  const S = SRC.loader({});
  const NOW = '2026-10-19T16:00:00.000Z';
  /* the committed data moves every hour, so the week ahead is whatever the
     planner says it is today; the past weeks below never change */
  const REAL_NOW = new Date().toISOString();
  const ahead = GEN.plan(S, REAL_NOW).filter(j => j.type === 'disagreement')[0];
  const jobs = [
    ['weekly_clv', { sport: 'nfl', week: 5 }], ['weekly_clv', { sport: 'cfb', week: 7 }],
    ['disagreement', ahead ? ahead.o : { sport: 'nfl', week: 7, now: NOW }], ['line_movement', { sport: 'nfl', week: 5 }],
    ['got_wrong', { month: '2026-09' }], ['research_notes', { study: 'EXP-001' }]];
  const made = {};
  for (const [t, o] of jobs) {
    let d;
    try { d = G.generate(t, S, o); } catch (e) { chk(t + ' builds', false, e.message); continue; }
    made[t + ':' + (o.sport || o.month || o.study)] = d;
    chk(t + ' ' + JSON.stringify(o) + ': voice', d.voice.ok, d.voice.issues);
    chk(t + ' ' + JSON.stringify(o) + ': every number re-derives', d.verify.ok && d.verify.checked > 10, d.verify.problems);
    chk(t + ': leads with a number', D.numberTokens(d.lead).length > 0, d.lead);
    chk(t + ': written as me', /\b(I|my|My)\b/.test(d.body_md));
    chk(t + ': no em dash anywhere', !/[—–]/.test([d.title, d.lead, d.body_md].join(' ')));
    chk(t + ': cites the public record, never the signed-in terminal', /edgedesksports\.com\/record(\.html|\/football\/)/.test(d.body_md) && !/app\.html#/.test(d.body_md));
    chk(t + ': slug fits the tracker', /^[a-z0-9-]{3,70}$/.test(d.slug), d.slug);
    const row = GEN.packageDraft(d, S, NOW);
    /* a clean checkout (CI, the drafting job) re-reads every file at its
       commit; a working tree with uncommitted data records no commit for
       those files, and is verified against the files as they stand */
    const committed = row.data_snapshot.sources.every(p => p.commit);
    const at = V.verifyRow(row, { tree: !committed });
    chk(t + ': re-verified ' + (committed ? 'at the commit it recorded' : 'against the working tree (uncommitted data)'), at.ok && at.checked === d.numbers.length + d.facts.length, at.problems.slice(0, 3));
    if (!committed) chk(t + ': an uncommitted source never claims a commit', row.data_snapshot.sources.filter(p => !p.commit).every(p => p.uncommitted === true));
  }
  const wk = made['weekly_clv:nfl'];
  chk('weekly: wins AND losses are on the page', wk && /\| Win \|/.test(wk.body_md) && /\| Loss \|/.test(wk.body_md));
  chk('weekly: price taken and the close sit side by side', wk && /Line locked/.test(wk.body_md) && /Market then/.test(wk.body_md));
  chk('weekly: the season CLV and record are there', wk && /Season to date/.test(wk.body_md) && /Break-even/.test(wk.body_md));
  chk('weekly: never claims an edge', wk && /not proof of an edge/.test(wk.body_md));
  chk('weekly: moneylines carry no computed CLV', wk && /Moneylines carry no CLV grade/.test(wk.body_md));
  const dg = made['disagreement:nfl'];
  chk('disagreement: components, what is not in it, and the tier', dg && /What is in my number/.test(dg.body_md) && /What is not in my number/.test(dg.body_md) && /Validation tier/.test(dg.body_md));
  const gw = made['got_wrong:2026-09'];
  chk('got wrong: ranked by how far the close beat me', gw && /nearer the final than I did/.test(gw.lead));
  const rn = made['research_notes:EXP-001'];
  chk('research note: labelled experimental', rn && /^> Experimental\./m.test(rn.body_md));
  const ev = (S.cfb_promotion.doc.evaluations || []).filter(e => e.challenger === 'edgedesk_cfb_v2.1.0' && e.champion === 'edgedesk_cfb_p4_v1.0.0')[0];
  chk('research note: says exactly what the interval allows', rn && ev && (ev.mae_diff_ci[0] < 0 && ev.mae_diff_ci[1] > 0
    ? /cannot tell the two models apart/.test(rn.body_md) : /does not include zero/.test(rn.body_md)));

  section('the verifier catches what it must');
  const forged = Object.assign({}, wk, { body_md: wk.body_md + '\nI was up 47.9 units.\n' });
  chk('a hand-typed number fails', !D.verifyDraft(forged, S).ok && /47\.9/.test(JSON.stringify(D.verifyDraft(forged, S).problems)));
  const n0 = wk.numbers[0], tamper = Object.assign({}, wk, { numbers: [Object.assign({}, n0, { value: 999, display: '999' })].concat(wk.numbers.slice(1)) });
  chk('a value that no longer matches its source fails', !D.verifyDraft(tamper, S).ok);
  const bogusSrc = Object.assign({}, S.record_summary, { doc: JSON.parse(JSON.stringify(S.record_summary.doc)) });
  bogusSrc.doc.sports.nfl.weeks.forEach(w => { if (w.clv) w.clv.avg = 9.99; });
  const Sx = new Proxy({}, { get: (t, k) => k === 'record_summary' ? bogusSrc : S[k] });
  chk('a source file that changed under a draft fails', !D.verifyDraft(wk, Sx).ok);
  chk('a week that is not graded is not drafted', (() => { try { G.generate('weekly_clv', S, { sport: 'nfl', week: 30 }); return false; } catch (e) { return !!e.notReady; } })());
  chk('CFB disagreement is refused, not estimated', (() => { try { G.generate('disagreement', S, { sport: 'cfb', week: 8 }); return false; } catch (e) { return /NOT JOINED/.test(e.message); } })());

  section('crossings');
  const cx = (o, c) => G.crossings(o, c, [3, 6, 7, 10]);
  chk('2.5 to 3.5 goes through 3', JSON.stringify(cx(-2.5, -3.5).keys) === JSON.stringify([{ k: 3, how: 'through' }]));
  chk('2.5 to 3 lands onto 3', JSON.stringify(cx(2.5, 3).keys) === JSON.stringify([{ k: 3, how: 'onto' }]));
  chk('7 to 7.5 comes off 7', JSON.stringify(cx(-7, -7.5).keys) === JSON.stringify([{ k: 7, how: 'off' }]));
  chk('-2.5 to +3 flips the favorite onto 3', cx(-2.5, 3).flip && JSON.stringify(cx(-2.5, 3).keys) === JSON.stringify([{ k: 3, how: 'onto' }]));
  chk('no move, no keys', cx(-3, -3).keys.length === 0);

  section('planner');
  const plan = GEN.plan(S, NOW);
  const types = plan.map(j => j.type);
  chk('every type is planned', ['weekly_clv', 'disagreement', 'line_movement', 'got_wrong', 'research_notes'].every(t => types.indexOf(t) >= 0), types);
  const dis = plan.filter(j => j.type === 'disagreement')[0];
  const recWeeks = S.record_summary.doc.sports.nfl.weeks;
  const slateAhead = (w) => S.nfl_slate.doc.games.filter(g => g.week === w && Date.parse(g.kickoff) > Date.parse(NOW)).length;
  const sizeOf = (w) => Math.max((recWeeks.filter(x => x.week === w)[0] || {}).recorded || 0, S.nfl_slate.doc.games.filter(g => g.week === w).length);
  chk('the disagreement week has most of its games still to play, never one leftover game', dis && slateAhead(dis.o.week) * 2 >= sizeOf(dis.o.week) && slateAhead(dis.o.week) > 1, dis);
  const wkJob = plan.filter(j => j.type === 'weekly_clv' && j.o.sport === 'nfl')[0];
  const wkRow = wkJob && recWeeks.filter(x => x.week === wkJob.o.week)[0];
  chk('the weekly report waits for a complete week', wkRow && wkRow.graded === wkRow.recorded && wkRow.graded > 0, wkRow);

  /* ── pages ───────────────────────────────────────────────────────── */
  section('pages');
  chk('the author is stated once (lib and renderer agree)', ['name', 'url', 'path', 'photo', 'bio', 'short', 'record_url', 'job'].every(k => D.AUTHOR[k] === R.AUTHOR[k]));
  const take = 'I keep coming back to the spread CLV more than the record. The close moving my way is the part I can check; the result in one week is mostly noise. What bothers me is the totals, where the market moved against me more often than it moved with me.';
  const row = GEN.packageDraft(wk, S, NOW);
  const rec = STORE.toRecord(Object.assign({}, row, { draft_id: 7, my_take: take, published_at: NOW, updated_at: NOW }));
  const page = DR.page(rec, { more: [rec] });
  chk('the take is on the page, under the lead', page.indexOf('a-take') > 0 && page.indexOf('a-take') < page.indexOf('My number against the close'));
  chk('the take is escaped', !/<script>alert/.test(DR.page(Object.assign({}, rec, { my_take: take + ' <script>alert(1)</script>' }))));
  chk('"Data as of" is printed', /Data as of <time datetime="[^"]+">/.test(page));
  chk('the author box links the live CLV record', /au-box/.test(page) && /href="https:\/\/edgedesksports\.com\/record\.html"/.test(page));
  chk('every source file is named with its digest', row.data_snapshot.sources.every(s => page.indexOf(s.file) > 0 && page.indexOf(String(s.sha256).slice(0, 12)) > 0));
  chk('the page is indexable and tracked', /index,follow/.test(page) && /edgedesk_public\.js/.test(page) && /data-ed-engage/.test(page));
  const ld = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  const art = ld.filter(b => b['@type'] === 'Article')[0], ds = ld.filter(b => b['@type'] === 'Dataset')[0];
  chk('Article JSON-LD: Person author, dates', art && art.author['@type'] === 'Person' && art.author.name === 'Davis Rackler' && art.datePublished && art.dateModified);
  chk('Dataset JSON-LD: creator, description, variables, distributions', ds && ds.creator['@type'] === 'Person' && ds.description.length >= 50
    && ds.variableMeasured.indexOf('CLV') >= 0 && ds.distribution.length > 0 && ds.distribution.every(x => fs.existsSync(path.join(SRC.ROOT, x.contentUrl.replace(D.SITE + '/', '')))));
  chk('no photo, no image claimed', !('image' in art.author));
  chk('a published record with a take passes the build', DR.publishable(rec).ok, DR.publishable(rec).failed);
  chk('the build refuses a desk record without a take', DR.publishable(Object.assign({}, rec, { my_take: 'Fine.' })).failed.some(f => f.id === 'my_take'));
  chk('the build refuses a number edited into the body by hand', DR.publishable(Object.assign({}, rec, { body_md: rec.body_md + '\nUp 88.8 units.\n' })).failed.some(f => f.id === 'untraced_number'));
  chk('hub and author pages render', /CollectionPage/.test(DR.hub([rec])) && /ProfilePage/.test(DR.authorPage([rec])) && /From my desk/.test(DR.strip([rec])));
  const game = ASTORE.loadAll().filter(r => r.status === 'published' && r.article_type !== 'postgame')[0];
  const gpage = R.articlePage(game, { now: NOW });
  const gld = [...gpage.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])).filter(b => b['@type'] === 'Article')[0];
  chk('a game article now has a person on it', gld.author['@type'] === 'Person' && /au-box/.test(gpage) && /Data as of/.test(gpage));
  chk('a game article with a take shows it', /a-take/.test(R.articlePage(Object.assign({}, game, { my_take: take }), { now: NOW })) && !/a-take"/.test(gpage));

  /* ── the editorial gate ──────────────────────────────────────────── */
  section('editorial publisher');
  const unpublished = ASTORE.loadAll().filter(r => r.status === 'ready' && !r.published_at)[0];
  const base = PUBLISH.preflight(unpublished, { now: NOW }).blocking.map(b => b.id);
  const gated = PUBLISH.preflight(unpublished, { now: NOW, requireTake: true, minTake: 240 }).blocking.map(b => b.id);
  chk('without a take a new article gains exactly one blocking reason: my_take', gated.length === base.length + 1 && gated.indexOf('my_take') >= 0, { base, gated });
  const withTake = PUBLISH.preflight(Object.assign({}, unpublished, { my_take: take }), { now: NOW, requireTake: true, minTake: 240 }).blocking.map(b => b.id);
  chk('with a take the blocking reasons are what they were', JSON.stringify(withTake) === JSON.stringify(base), { base, withTake });
  chk('a short take still blocks', PUBLISH.preflight(Object.assign({}, unpublished, { my_take: 'Short.' }), { now: NOW, requireTake: true }).blocking.some(b => b.id === 'my_take'));
  const live = ASTORE.loadAll().filter(r => r.status === 'published')[0];
  chk('an article already published is never held for a take', !PUBLISH.preflight(live, { now: NOW, requireTake: true }).blocking.some(b => b.id === 'my_take'));
  chk('the rule is off unless the caller turns it on', !PUBLISH.preflight(unpublished, { now: NOW }).blocking.some(b => b.id === 'my_take'));
  /* the postgame half rebuilds its record every run: the stored copy decides */
  const takeBlocks = (r, o) => PUBLISH.preflight(r, Object.assign({ now: NOW, requireTake: true }, o)).blocking.some(b => b.id === 'my_take');
  chk('a rebuilt record whose stored copy is live is not held for a take', !takeBlocks(unpublished, { previous: Object.assign({}, unpublished, { status: 'published', published_at: NOW }) }));
  chk('a stored copy that was never public does not excuse it', takeBlocks(unpublished, { previous: unpublished }));
  chk('a game that kicked off before the rule started is not held', !takeBlocks(Object.assign({}, unpublished, { game_time: '2026-10-18T17:00:00.000Z' }), { takeFrom: TAKES.RULE_FROM }));
  chk('a game after the rule started still is', takeBlocks(Object.assign({}, unpublished, { game_time: '2026-10-25T17:00:00.000Z' }), { takeFrom: TAKES.RULE_FROM }));
  const held = PUBLISH.publish(unpublished, { now: NOW, requireTake: true });
  chk('publish() holds it in manual_review and names the take', !held.ok && held.record.status === 'manual_review' && /my_take/.test(held.record.publish_state.hold_reason), held.reason);

  section('takes and sync fail closed');
  const none = await TAKES.load({ env: {} });
  chk('no credential: required, nothing read', none.require === true && none.reachable === false && Object.keys(none.map).length === 0);
  const fakeFetch = (rows, settings) => async (url) => ({ ok: true, json: async () => (/article_takes_for_pipeline/.test(url) ? rows : settings) });
  const got = await TAKES.load({ env: { DESK_SB_URL: 'https://x.supabase.co', DESK_SB_SERVICE_ROLE: 'k' }, fetch: fakeFetch([{ article_id: 'nfl-1', take: take }], [{ min_take_chars: 300, require_take_for_game_articles: true }]) });
  chk('takes read under the desk’s own names', got.reachable && got.map['nfl-1'] === take && got.min === 300 && got.source === 'database');
  const off = await TAKES.load({ env: { DESK_SB_URL: 'https://x.supabase.co', DESK_SB_SERVICE_ROLE: 'k' }, fetch: fakeFetch([], [{ min_take_chars: 240, require_take_for_game_articles: false }]) });
  chk('the owner’s switch in the database turns it off', off.require === false);
  const down = await TAKES.load({ env: { DESK_SB_URL: 'https://x.supabase.co', DESK_SB_SERVICE_ROLE: 'k', EDGD_REQUIRE_MY_TAKE: '' }, fetch: async () => { throw new Error('ECONNRESET'); } });
  chk('a database outage holds, it does not publish', down.require === true && !down.reachable);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-sync-'));
  STORE.save(Object.assign({}, rec, { slug: 'old-withdrawn-one' }), tmp);
  const quiet = console.log; console.log = () => {};
  const okSync = await SYNC.sync({ write: true, dir: tmp, fetch: async () => ({ ok: true, json: async () => [Object.assign({}, row, { draft_id: 7, my_take: take, published_at: NOW, updated_at: NOW })] }) });
  const badSync = await SYNC.sync({ write: true, dir: tmp, fetch: async () => ({ ok: false, status: 503 }) });
  console.log = quiet;
  const files = fs.readdirSync(tmp).sort();
  chk('sync writes the published article and removes the withdrawn one', okSync.ok && JSON.stringify(files) === JSON.stringify([rec.slug + '.json']), files);
  chk('a failed read changes nothing', !badSync.ok && fs.readdirSync(tmp).length === 1);
  fs.rmSync(tmp, { recursive: true, force: true });

  /* ── the kit ─────────────────────────────────────────────────────── */
  section('distribution kit');
  const A = { type: rec.type, slug: rec.slug, url: rec.canonical_url, title: rec.title, lead: rec.lead, highlights: rec.highlights, body_md: rec.body_md,
    take: take, numbers: rec.data_snapshot.numbers, reddit_title: rec.reddit_title, published: true };
  const k = D.kit(A);
  ['x', 'linkedin', 'discord', 'reddit'].forEach(c => chk(c + ': passes its own check', k[c].check.ok, k[c].check.why));
  chk('X fits in 280 with the link counted as 23', k.x.chars <= 280, k.x.chars);
  chk('every link is UTM-tagged by channel and article', /utm_source=x&utm_medium=social&utm_campaign=desk_/.test(k.x.text) && /utm_source=linkedin/.test(k.linkedin.text)
    && /utm_source=discord&utm_medium=community/.test(k.discord.text) && /utm_source=reddit/.test(k.reddit.comment));
  chk('the campaign fits the funnel’s pattern', /^[a-z0-9_.-]{1,64}$/.test(D.campaignOf(rec.slug)));
  chk('Reddit: no link in the body, value delivered, link in the comment', !/https?:\/\//.test(k.reddit.text) && /My take:/.test(k.reddit.text) && k.reddit.text.length > 400 && /edgedesksports\.com/.test(k.reddit.comment));
  chk('each post leads with the article’s number', ['x', 'linkedin', 'discord', 'reddit'].every(c => k[c].text.indexOf(rec.lead.slice(0, 40)) >= 0));
  chk('an unpublished article has nothing to link to', !D.kit(Object.assign({}, A, { published: false })).x.check.ok);
  chk('a snippet with no number from the article fails', !D.snippetCheck({ channel: 'x', text: 'Big week! ' + rec.canonical_url }, A).ok);

  /* ── the edge function, as deployed ──────────────────────────────── */
  section('desk_cron');
  const ENV = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', DESK_CRON_SECRET: 's3cret-value',
    EDITORIAL_GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123', DISCORD_BOT_TOKEN: 'bot-token-abcdefghijklmnop', DESK_OWNER_DISCORD_ID: '123456' };
  globalThis.Deno = { env: { get: (k2) => ENV[k2] } };
  let M;
  try { M = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'desk_cron', 'index.ts')); }
  catch (e) { console.log('SKIP | desk_cron: could not import the function (needs Node 22+ type stripping): ' + e.message); M = null; }
  if (M) {
    const calls = [];
    const realFetch = globalThis.fetch;
    let claimRows = [{ id: 11, article_key: 'weekly_clv:nfl:2026:w05', type: 'weekly_clv', title: 'NFL Week 5 CLV report', lead: 'x', status: 'awaiting_take' }];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      const u = String(url);
      const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
      if (/rpc\/desk_notify_claim/.test(u)) { const r = { enabled: true, drafts: claimRows }; claimRows = []; return res(200, r); }
      if (/rpc\/desk_notify_done/.test(u)) return res(200, { logged: true });
      if (/rpc\/desk_is_owner/.test(u)) return res(200, /owner-token/.test(init.headers.authorization));
      if (/users\/@me\/channels/.test(u)) return res(200, { id: 'dm1' });
      if (/channels\/dm1\/messages/.test(u)) return res(200, { id: 'm1' });
      if (/api\.github\.com/.test(u)) return { ok: false, status: 204, text: async () => '' };
      return res(404, {});
    };
    const req = (method, body, headers) => new Request('https://p.supabase.co/functions/v1/desk_cron', { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const health = await (await M.handle(req('GET'))).json();
    chk('the probe reports what is set, never a value', health.set.DESK_CRON_SECRET === true && health.notify_channel === 'discord_dm' && !/s3cret|ghp_|bot-token/.test(JSON.stringify(health)));
    chk('no secret, no run', (await M.handle(req('POST', { action: 'notify' }))).status === 401);
    chk('a wrong secret, no run', (await M.handle(req('POST', { action: 'notify' }, { 'x-cron-secret': 'nope' }))).status === 401);
    const n1 = await (await M.handle(req('POST', { action: 'notify' }, { 'x-cron-secret': 's3cret-value' }))).json();
    const dm = calls.filter(c => /channels\/dm1\/messages/.test(c.url));
    chk('notify: one DM to the owner', n1.ok && n1.sent === 1 && n1.channel === 'discord_dm' && dm.length === 1, n1);
    const content = dm.length ? JSON.parse(dm[0].init.body).content : '';
    chk('the DM names the draft, says nothing publishes without a take, links the desk, pings nobody', /NFL Week 5 CLV report/.test(content) && /until you write your take/.test(content)
      && /edgedesksports\.com\/admin\/desk\//.test(content) && JSON.parse(dm[0].init.body).allowed_mentions.parse.length === 0 && !/[—–]/.test(content));
    const done = calls.filter(c => /desk_notify_done/.test(c.url)).map(c => JSON.parse(c.init.body))[0];
    chk('the outcome is logged against the claimed draft', done && done.p_ok === true && done.p_ids[0] === 11 && done.p_channel === 'discord_dm');
    const n2 = await (await M.handle(req('POST', { action: 'notify' }, { 'x-cron-secret': 's3cret-value' }))).json();
    chk('nothing claimed, nothing sent', n2.ok && n2.sent === 0 && calls.filter(c => /channels\/dm1\/messages/.test(c.url)).length === 1);
    const gen = await (await M.handle(req('POST', { action: 'generate' }, { 'x-cron-secret': 's3cret-value' }))).json();
    const gh = calls.filter(c => /actions\/workflows\/desk-drafts\.yml\/dispatches/.test(c.url));
    chk('generate dispatches the drafts workflow and nothing else', gen.ok && gh.length === 1 && JSON.parse(gh[0].init.body).inputs.source === 'supabase_cron');
    chk('publish_now without a token is refused', (await M.handle(req('POST', { action: 'publish_now' }))).status === 401);
    chk('publish_now for a reader is refused', (await M.handle(req('POST', { action: 'publish_now' }, { authorization: 'Bearer reader-token' }))).status === 403);
    const pn = await M.handle(req('POST', { action: 'publish_now' }, { authorization: 'Bearer owner-token' }));
    chk('publish_now for the owner starts the publish workflow', pn.status === 200 && calls.some(c => /publish-articles\.yml\/dispatches/.test(c.url)) && pn.headers.get('access-control-allow-origin') === 'https://edgedesksports.com');
    chk('scrub removes webhooks and tokens', !/discord\.com\/api\/webhooks|ghp_|Bot abc/.test(M.scrub('see https://discord.com/api/webhooks/1/abc and Bot abcdefghijklmnopqrst and ghp_abcdefghijklmnopqrstuvwxyz')));
    ENV.DESK_DRY_RUN = '1'; claimRows = [{ id: 12, article_key: 'k', type: 'got_wrong', title: 't', lead: 'l', status: 'awaiting_take' }];
    const before = calls.length;
    const dry = await (await M.handle(req('POST', { action: 'notify' }, { 'x-cron-secret': 's3cret-value' }))).json();
    chk('dry run claims nothing and sends nothing', dry.dry_run === true && calls.length === before);
    delete ENV.DESK_DRY_RUN; delete ENV.DISCORD_BOT_TOKEN; ENV.DISCORD_WEBHOOK_OWNER = '';
    const dash = await (await M.handle(req('POST', { action: 'notify' }, { 'x-cron-secret': 's3cret-value' }))).json();
    chk('with no Discord set up the badge is the notification', dash.ok && dash.channel === 'dashboard_only');
    globalThis.fetch = realFetch;
  }

  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk desk | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL | edgedesk desk | ' + (e && e.stack || e)); process.exit(1); });

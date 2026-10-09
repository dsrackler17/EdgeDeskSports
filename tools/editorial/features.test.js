#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FEATURES — the Monday / Wednesday / Friday first-party articles.

     C  CALENDAR   Central Time slots (Mon review, Wed storylines, Fri
                   preview), the publish hour across daylight saving, the week
     B  BUILD      each article from the committed research; each one declines
                   (with its reason) when the research cannot support it
     G  GATES      all twelve pass on a clean article, and each one fails on
                   the thing it exists to catch
     P  PAGE       a crawlable page: canonical to itself, NewsArticle and
                   BreadcrumbList (no SportsEvent), one call to action, no
                   campaign tags on internal links, the disclaimer, noindex
                   until published; the hub's categories and archive; the
                   sitemap and the published index
     J  JOB        no database: always a dry run, nothing written; a local
                   rehearsal publishes, holds and schedules as the gates say
     D  DATABASE   (a throwaway PostgreSQL with supabase/content_engine.sql)
                   dry run by default; the job can never approve; publishing
                   needs all twelve gates in auto mode or the owner's approval
                   of the exact text; three a week at most; rejected stays
                   rejected; a published record removed by a push race is put
                   back; the console never prints an unpublished headline

   Run: node tools/editorial/features.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const ART = require(path.join(ROOT, 'tools', 'content', 'artifacts.js'));
const MODEL = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
const STORE = require(path.join(ROOT, 'tools', 'articles', 'store.js'));
const BUILD = require(path.join(ROOT, 'tools', 'articles', 'build_articles.js'));
const FEATURE = require('./feature_model.js');
const JOB = require('./features.js');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const PGR = require(path.join(ROOT, 'tools', 'lib', 'pgrest.js'));
const { sqlVal } = require(path.join(ROOT, 'tools', 'growth', '_rpc_shim.js'));
const FP = CE.firstParty;

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return true; }
  fail++; console.log('  × ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

const MON = Date.parse('2026-10-05T13:30:00Z'), WED = Date.parse('2026-10-07T13:30:00Z'), FRI = Date.parse('2026-10-09T13:30:00Z');
const art = ART.load();
const TL = ART.teamLists(art);
const snapAt = (t) => CE.research.fromArtifacts(art, { now: t });
/* the committed record as it stood before the week of t was graded: the live
   record keeps grading games, so "no graded weekend" is built, never assumed */
const ungradedAt = (t) => Object.assign({}, art, { records: Object.fromEntries(Object.entries(art.records || {}).map(([lg, rec]) => [lg, rec && rec.games
  ? Object.assign({}, rec, { games: (Array.isArray(rec.games) ? rec.games : Object.values(rec.games)).filter((g) => Date.parse(g.kickoff) < t - 7 * 864e5) }) : rec])) });
const currentOf = (snap) => { const c = {}; ['cfb', 'nfl'].forEach((lg) => ((snap[lg] && snap[lg].games) || []).forEach((p) => { c[p.game_id] = p; })); return c; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = () => {};

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-store-'));
  return {
    dir,
    save: (rec) => { fs.writeFileSync(path.join(dir, rec.id + '.json'), JSON.stringify(MODEL.compact(rec))); return rec; },
    load: () => fs.readdirSync(dir).filter((f) => /^feature-.*\.json$/.test(f)).map((f) => MODEL.hydrate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))),
    files: () => fs.readdirSync(dir).filter((f) => /\.json$/.test(f))
  };
}

(async () => {
  /* ── C calendar ─────────────────────────────────────────────────────── */
  section('C calendar');
  const sMon = FP.slot(MON), sWed = FP.slot(WED), sFri = FP.slot(FRI);
  chk('C Monday is the Weekend Model Review, Wednesday the storylines, Friday the research preview', sMon.kind === 'weekend_review' && sWed.kind === 'storylines' && sFri.kind === 'research_preview');
  chk('C Tuesday, Thursday, Saturday and Sunday have no slot', ['2026-10-06', '2026-10-08', '2026-10-10', '2026-10-11'].every((d) => FP.slot(Date.parse(d + 'T15:00:00Z')) === null));
  chk('C the day is Central Time’s: 1 a.m. Tuesday UTC is still Monday evening in Chicago', FP.slot(Date.parse('2026-10-06T01:00:00Z')).kind === 'weekend_review');
  chk('C 7 a.m. Central in October (CDT) is 12:00 UTC', sMon.publish_at === '2026-10-05T12:00:00.000Z', sMon.publish_at);
  chk('C … and in December (CST) 13:00 UTC', FP.slot(Date.parse('2026-12-07T16:00:00Z')).publish_at === '2026-12-07T13:00:00.000Z');
  chk('C the owner’s publish hour moves the slot', FP.slot(MON, { publish_hour_ct: 9 }).publish_at === '2026-10-05T14:00:00.000Z');
  chk('C one id per slot, one week for all three', sMon.id === 'feature-2026-10-05-weekend-review' && sWed.week === '2026-10-05' && sFri.week === '2026-10-05' && FP.slot(Date.parse('2026-10-12T15:00:00Z')).week === '2026-10-12');

  /* ── B build ────────────────────────────────────────────────────────── */
  section('B build');
  const bMon = FP.build('weekend_review', snapAt(MON), { now: MON });
  const bWed = FP.build('storylines', snapAt(WED), { now: WED });
  const bFri = FP.build('research_preview', snapAt(FRI), { now: FRI });
  chk('B all three build from the committed research', bMon.ok && bWed.ok && bFri.ok, [bMon.reason, bWed.reason, bFri.reason]);
  const body = (a) => a.sections.map((s) => s.body).join('\n\n');
  chk('B the review covers both leagues’ graded weekend', bMon.ok && bMon.o.research.leagues_used.join() === 'cfb,nfl' && /college football Week 5 and NFL Week 4/.test(body(bMon.article)));
  chk('B the storylines are three to five, each a different game, each from a number', bWed.ok && bWed.o.research.stories.length >= 3 && bWed.o.research.stories.length <= 5
    && new Set(bWed.o.research.stories.map((s) => s.game_id)).size === bWed.o.research.stories.length);
  chk('B the preview is four or five numbers, each with its game', bFri.ok && bFri.o.research.numbers.length >= 4 && bFri.o.research.numbers.every((n) => bFri.o.research.games.some((p) => p.game_id === n.game_id)));
  chk('B a game whose market gap EdgeDesk cannot explain is left out, and the page says so', bFri.ok && bFri.o.research.games.every((p) => !p.discrepancy || p.discrepancy.review === 'NONE')
    && (bFri.o.research.disputed ? /Left out for review/.test(body(bFri.article)) : true));
  chk('B headlines lead with a storyline and fit a search result', [bMon, bWed, bFri].every((b) => b.article.title.length >= 20 && b.article.title.length <= 70), [bMon, bWed, bFri].map((b) => b.article.title));
  chk('B every headline number is in the research', [bMon, bWed, bFri].every((b) => (b.article.title.match(/\d+(?:\.\d+)?/g) || []).every((n) => CE.evidence(b.o).numbers[String(+n)])));
  const late = Date.parse('2026-10-12T15:00:00Z');
  const noReview = FP.build('weekend_review', CE.research.fromArtifacts(ungradedAt(late), { now: late }), { now: late });
  chk('B no graded weekend: no review, and why', !noReview.ok && /no graded games/.test(noReview.reason), noReview);
  const empty = FP.build('storylines', { cfb: null, nfl: null, results: {}, sources: [] }, { now: WED });
  chk('B no slate: no storylines, and why', !empty.ok && /storyline/.test(empty.reason));
  const thin = FP.build('research_preview', { cfb: null, nfl: null, results: {}, sources: [] }, { now: FRI });
  chk('B no slate: no preview, and why', !thin.ok && /numbers/.test(thin.reason));

  /* ── G gates ────────────────────────────────────────────────────────── */
  section('G gates');
  const ctxW = (extra) => Object.assign({ now: WED, slot: sWed, current: currentOf(snapAt(WED)), teamLists: TL, publishedThisWeek: [], site: [], taken: {}, publisherTexts: [] }, extra || {});
  const gW = FP.gates(bWed.article, bWed.o, ctxW());
  chk('G twelve gates, all passing on the clean Wednesday article', gW.gates.length === 12 && gW.ok, gW.gates.filter((x) => !x.ok));
  const failsOn = (g, key) => g.gates.find((x) => x.key === key) && !g.gates.find((x) => x.key === key).ok;
  chk('G 1 slot: Wednesday’s article on a Friday fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ slot: sFri })), 'slot'));
  chk('G 2 cadence: three already published this week fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ publishedThisWeek: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })), 'cadence'));
  chk('G 2 cadence: the same slot twice fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ publishedThisWeek: [{ id: sWed.id }] })), 'cadence'));
  const oStale = clone(bWed.o); oStale.research.as_of = new Date(WED - 40 * 3600000).toISOString();
  chk('G 3 freshness: research read 40 hours ago fails', failsOn(FP.gates(bWed.article, oStale, ctxW()), 'freshness'));
  const oKick = clone(bWed.o); oKick.research.games[0].kickoff = new Date(WED + 30 * 60000).toISOString();
  chk('G 4 schedule: a featured game kicking off within the hour fails', failsOn(FP.gates(bWed.article, oKick, ctxW()), 'schedule'));
  const disputed = Object.values(currentOf(snapAt(WED))).find((p) => p.discrepancy && p.discrepancy.review === 'BLOCK');
  if (disputed) {
    const oD = clone(bWed.o); oD.research.games.push(disputed);
    const aD = clone(bWed.article); aD.sections.find((s) => s.key === 'story_1').body += ' ' + disputed.away + ' at ' + disputed.home + ' is on the slate too.';
    chk('G 5 editorial gate: featuring a game with an unexplained market gap fails', failsOn(FP.gates(aD, oD, ctxW()), 'editorial_gate'));
  }
  const aNoLimits = clone(bWed.article); aNoLimits.sections = aNoLimits.sections.filter((s) => s.key !== 'limits');
  chk('G 6 hard checks: a missing required section fails', failsOn(FP.gates(aNoLimits, bWed.o, ctxW()), 'hard_checks'));
  const g0 = bWed.o.research.games[0];
  const aNum = clone(bWed.article); const s1 = aNum.sections.find((s) => s.key === 'story_1');
  s1.body = s1.body.replace(g0.model.fav_win_pct + '% chance', (g0.model.fav_win_pct + 9) + '% chance');
  chk('G 7 numbers: a win chance that is not EdgeDesk’s fails', failsOn(FP.gates(aNum, bWed.o, ctxW()), 'numbers'), s1.body.slice(0, 200));
  const aPick = clone(bWed.article); aPick.sections[0].body += ' Our best bet is ' + g0.home + '.';
  chk('G 8 responsible: pick language fails', failsOn(FP.gates(aPick, bWed.o, ctxW()), 'responsible'));
  const sameText = CE.firstParty.record(bWed.article, bWed.o, { now: WED, slot: sWed });
  const txt = [sameText.title, sameText.standfirst].concat(sameText.sections.map((s) => (s.heading || '') + '\n' + s.body)).join('\n\n');
  chk('G 9 duplicate on EdgeDesk: a near-copy of a published page fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ site: [{ id: 'feature-old', title: 'old', text: txt }] })), 'duplicate_site'));
  chk('G 9 … and so does a URL another article owns', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ taken: { [bWed.article.slug]: 'cfb-123' } })), 'duplicate_site'));
  chk('G 10 duplicate with a publisher: a near-copy of the week’s publisher article fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ publisherTexts: [{ label: 'a publisher draft', text: txt }] })), 'duplicate_publisher'));
  const aLong = clone(bWed.article); aLong.title = aLong.title + ' — And Everything Else Worth Knowing This Weekend';
  chk('G 11 SEO: a headline too long for a search result fails', failsOn(FP.gates(aLong, bWed.o, ctxW()), 'seo'));
  chk('G 12 cost: AI used outside the budget ledger fails', failsOn(FP.gates(bWed.article, bWed.o, ctxW({ ai: { used: true, ledgered: false } })), 'cost'));
  chk('G 12 cost: AI through the ledger passes', !failsOn(FP.gates(bWed.article, bWed.o, ctxW({ ai: { used: true, ledgered: true, call: 7 } })), 'cost'));
  chk('G every gate says what it checked', gW.gates.every((x) => x.label && x.key));
  const pxy = JOB.publisherProxies(snapAt(WED), WED);
  chk('G with no database, the week’s publisher drafts stand in, and the angle is distinct from each', pxy.length >= 2 && FP.gates(bWed.article, bWed.o, ctxW({ publisherTexts: pxy })).gates.find((x) => x.key === 'duplicate_publisher').ok);
  chk('G … the Monday review too (its own shape, not the publisher recap’s)', FP.gates(bMon.article, bMon.o, { now: MON, slot: sMon, current: currentOf(snapAt(MON)), teamLists: TL, publisherTexts: JOB.publisherProxies(snapAt(MON), MON) }).gates.find((x) => x.key === 'duplicate_publisher').ok);

  /* ── P page ─────────────────────────────────────────────────────────── */
  section('P page');
  const rec = Object.assign(FP.record(bWed.article, bWed.o, { now: WED, slot: sWed, status: 'published' }), { gates: gW.gates });
  chk('P the record is a feature: its own URL, canonical to itself, no game', rec.article_type === 'feature' && rec.canonical_url === 'https://edgedesksports.com/articles/' + rec.slug + '/' && rec.game_id === undefined);
  chk('P it passes its own publication checks', MODEL.publishable(MODEL.hydrate(rec)).ok, MODEL.publishable(MODEL.hydrate(rec)).failed);
  const tampered = clone(rec); tampered.sections[2].body += ' An extra sentence.';
  chk('P a text changed after the gates ran fails its integrity check', !MODEL.publishable(MODEL.hydrate(tampered)).ok);
  const ungated = clone(rec); delete ungated.gates;
  chk('P a feature with neither the twelve gates nor the owner’s approval cannot publish', !MODEL.publishable(MODEL.hydrate(ungated)).ok);
  const html = FEATURE.page(MODEL.hydrate(rec), { related: [{ title: 'Georgia vs. Alabama', url: 'https://edgedesksports.com/articles/georgia-vs-alabama-2026/', kind: 'Pregame research' }] });
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  chk('P structured data: a NewsArticle and a BreadcrumbList, and no SportsEvent', ld.map((x) => x['@type']).join() === 'NewsArticle,BreadcrumbList' && ld[0].datePublished && ld[0].headline === rec.title);
  chk('P canonical, robots index, Open Graph and Twitter tags', html.indexOf('<link rel="canonical" href="' + rec.canonical_url + '">') >= 0 && /name="robots" content="index,follow"/.test(html)
    && /property="og:type" content="article"/.test(html) && /name="twitter:card"/.test(html) && /article:published_time/.test(html));
  chk('P one heading 1, the byline, Central Time dates, the breadcrumbs', (html.match(/<h1/g) || []).length === 1 && /By <a href="\/methodology\/" rel="author">EdgeDesk Research/.test(html)
    && /<time datetime="[^"]+">[^<]+CT<\/time>/.test(html) && /class="a-crumbs"[\s\S]*Features[\s\S]*Weekend Storylines/.test(html));
  chk('P exactly one call to action, the research one; no trial strip, no header button', (html.match(/data-ed-cta=/g) || []).length === 1 && /data-ed-cta="feature_research"/.test(html)
    && /Explore the full matchup research on EdgeDesk\./.test(html) && !/header_trial|article_trial|7-day free trial/.test(html));
  chk('P server-rendered: every section’s words are in the markup', bWed.article.sections.every((s) => html.indexOf(CE.util.esc(s.heading || '').slice(0, 30)) >= 0));
  chk('P no campaign tags on internal links', !/edgedesksports\.com[^"\s]*utm_/.test(html) && !/href="\/[^"]*utm_/.test(html));
  chk('P the disclaimer, and the engagement marker for the reader funnel', /21\+\. Gamble responsibly — 1-800-GAMBLER/.test(html) && /data-ed-engage="feature"/.test(html) && /edgedesk_public\.js/.test(html));
  chk('P related research is linked', /Related EdgeDesk research[\s\S]*georgia-vs-alabama-2026/.test(html));
  const draftHtml = FEATURE.page(MODEL.hydrate(Object.assign({}, rec, { status: 'draft' })));
  chk('P an unpublished feature is noindex, with no structured data and no tracking', /noindex,nofollow/.test(draftHtml) && !/ld\+json/.test(draftHtml) && !/edgedesk_public\.js/.test(draftHtml));
  const hubHtml = FEATURE.hub([MODEL.hydrate(rec)]);
  chk('P the hub: three categories, an archive by month, a CollectionPage', ['weekend-model-review', 'weekend-storylines', 'weekend-research-preview', 'archive'].every((id) => hubHtml.indexOf('id="' + id + '"') >= 0)
    && /"@type":\s*"CollectionPage"/.test(hubHtml) && hubHtml.indexOf('/articles/' + rec.slug + '/') >= 0);
  const xml = BUILD.articleSitemap([rec]);
  chk('P the sitemap lists the feature and its hub, as settled pages', xml.indexOf('<loc>' + rec.canonical_url + '</loc>') >= 0 && /articles\/features\/<\/loc>/.test(xml) && /<changefreq>yearly<\/changefreq>/.test(xml));
  chk('P the store keeps features apart: game tools never see one', STORE.loadAll().every((r) => r.article_type !== 'feature') && STORE.FEATURES.endsWith(path.join('features', 'records')));

  /* ── W the workflow ─────────────────────────────────────────────────── */
  section('W workflow');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'edgedesk-features.yml'), 'utf8');
  chk('W Mon/Wed/Fri heartbeats, the job deciding in Central Time', /cron: '41 10-21 \* \* 1,3,5'/.test(wf) && /--if-due/.test(wf));
  chk('W the checks run before the slot', wf.indexOf('features.test.js') < wf.indexOf('node tools/editorial/features.js $args'));
  chk('W publishing pushes the features directory and nothing else', /push_generated\.sh main "[^"]+" -- features\n/.test(wf) && !/-- [^\n]*\barticles\b/.test(wf));
  chk('W only when the job wrote a record', /if: steps\.fp\.outputs\.published == '1'/.test(wf));
  chk('W a dispatch can only make it more careful', /--mode dry_run/.test(wf) && !/--mode auto/.test(wf));
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  chk('W the raw records are not offered to crawlers; the pages are', /Disallow: \/features\//.test(robots) && /Allow: \/articles\//.test(robots));

  /* ── J job, no database ─────────────────────────────────────────────── */
  section('J job without a database');
  const logs = [];
  const st1 = tempStore();
  const dry = await JOB.run({ now: WED, db: null, ifDue: true, saveFeature: st1.save, loadFeatures: st1.load, log: (l) => logs.push(l) });
  chk('J no database: a dry run that writes nothing', dry.mode === 'dry_run' && dry.results[0].status === 'dry_run' && dry.results[0].would_be === 'published' && st1.files().length === 0, dry);
  chk('J … and the console names the slot, never the headline', logs.join('\n').indexOf(bWed.article.title) < 0 && /feature-2026-10-07-storylines/.test(logs.join('\n')));
  const st2 = tempStore();
  const a1 = await JOB.run({ now: WED, db: null, localAuto: true, ifDue: true, saveFeature: st2.save, loadFeatures: st2.load, log: quiet });
  chk('J a local rehearsal in auto mode publishes the slot, all twelve gates passing', a1.published.length === 1 && st2.files().length === 1 && st2.load()[0].status === 'published' && st2.load()[0].gates.every((g) => g.ok), a1.results);
  const a2 = await JOB.run({ now: WED, db: null, localAuto: true, ifDue: true, saveFeature: st2.save, loadFeatures: st2.load, log: quiet });
  chk('J the same slot is never published twice', a2.published.length === 0 && a2.results[0].status === 'published' && /already/.test(a2.results[0].reason), a2.results);
  const st3 = tempStore();
  const early = await JOB.run({ now: Date.parse('2026-10-09T10:30:00Z'), db: null, localAuto: true, ifDue: true, saveFeature: st3.save, loadFeatures: st3.load, log: quiet });
  chk('J before the publish hour: SCHEDULED, nothing written yet', early.results[0].status === 'scheduled' && st3.files().length === 0, early.results);
  const tooEarly = await JOB.run({ now: Date.parse('2026-10-09T08:00:00Z'), db: null, localAuto: true, ifDue: true, saveFeature: st3.save, loadFeatures: st3.load, log: quiet });
  chk('J --if-due: more than two hours early, nothing runs', tooEarly.results.length === 0);
  const off = await JOB.run({ now: Date.parse('2026-10-08T15:00:00Z'), db: null, localAuto: true, ifDue: true, saveFeature: st3.save, loadFeatures: st3.load, log: quiet });
  chk('J Thursday: no slot, nothing runs', off.results.length === 0 && off.slot === null);

  /* ── D database ─────────────────────────────────────────────────────── */
  section('D database');
  const db = PG.start('fpjob');
  if (db.skip) { console.log('NOTE | ' + db.skip + ' — database section skipped'); return finish(); }
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql', 'content_engine.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    const lit = PG.lit, one = (s) => db.sql(s);
    const OWNER = '00000000-0000-0000-0000-0000000000c1';
    one(`insert into auth.users (id, email, email_confirmed_at) values (${lit(OWNER)}, 'owner@edgedesk.test', now());
         insert into public.affiliate_admins (user_id) values (${lit(OWNER)});
         select growth_outbound.grant_owner('owner@edgedesk.test');`);
    const own = (s) => db.as(OWNER, s);
    const SB = 'https://fp.supabase.test', SERVICE = 'service-role-key-for-tests';
    const fakeFetch = async (url, init) => {
      url = String(url);
      if (!url.startsWith(SB + '/rest/v1/rpc/')) return new Response('nope', { status: 404 });
      const fn = url.split('/rpc/')[1], args = JSON.parse(init.body || '{}');
      const sql = `select public.${fn}(${Object.entries(args).map(([k, v]) => k + ' => ' + sqlVal(v)).join(', ')});`;
      try { const o = db.service(sql); return new Response(o === '' ? 'null' : o, { status: 200 }); }
      catch (e) { return new Response(JSON.stringify({ message: String(e.sqlMessage || e.message).slice(0, 300) }), { status: 400 }); }
    };
    const client = PGR.client({ url: SB, key: SERVICE }, fakeFetch, { retries: 0 });
    const S = tempStore();
    const go = (t, extra) => JOB.run(Object.assign({ now: t, db: client, ifDue: true, saveFeature: S.save, loadFeatures: S.load, log: quiet }, extra || {}));
    const row = (id) => JSON.parse(one(`select coalesce((select to_jsonb(f) - 'article' from content_engine.first_party f where id = ${lit(id)}), 'null');`));

    chk('D the default mode is a dry run', one(`select fp_mode from content_engine.settings where id = 1;`) === 'dry_run');
    const d1 = await go(MON);
    chk('D a dry run records what would happen, owner-only, and publishes nothing', d1.results[0].status === 'dry_run' && row(sMon.id).status === 'dry_run' && S.files().length === 0 && row(sMon.id).failed.length === 0);
    chk('D … the full article is kept for the owner, not printed', own(`select jsonb_array_length(public.content_engine_fp_list(10));`) === '1'
      && own(`select public.content_engine_fp_list(10) -> 0 -> 'article' -> 'record' ->> 'title';`) === bMon.article.title);
    chk('D the job can never approve', JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: sMon.id, kind: 'weekend_review', slot_date: '2026-10-05', week_of: '2026-10-05', status: 'approved' }))}::jsonb);`)).reason === 'owner_decides');
    chk('D … nor reach the owner’s doors', !!db.mustFail(() => db.service(`select public.content_engine_fp_decide('x', 'approve', null, null);`)) && !!db.mustFail(() => db.service(`select public.content_engine_fp_settings_save('{"fp_mode":"auto"}'::jsonb);`)));
    chk('D anon reaches nothing', !!db.mustFail(() => db.anon(`select public.content_engine_fp_state('2026-10-05');`)));
    const fakeGates = Array.from({ length: 12 }, (_, i) => ({ key: 'g' + i, ok: true }));
    const forced = JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: 'feature-2026-10-06-storylines', kind: 'storylines', slot_date: '2026-10-06', week_of: '2026-10-05', status: 'published', mode: 'auto', gates: fakeGates }))}::jsonb);`));
    chk('D in dry-run mode the database refuses to mark anything published, gates or not', forced.ok === false && forced.reason === 'not_cleared', forced);

    chk('D the owner turns automation on', own(`select public.content_engine_fp_settings_save('{"fp_mode":"auto"}'::jsonb) ->> 'ok';`) === 'true');
    chk('D … only to a mode that exists', own(`select public.content_engine_fp_settings_save('{"fp_mode":"yolo"}'::jsonb) ->> 'reason';`) === 'invalid');
    const elevenGates = fakeGates.slice(0, 11).concat([{ key: 'cost', ok: false }]);
    chk('D eleven of twelve gates is not enough', JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: 'feature-2026-10-06-storylines', kind: 'storylines', slot_date: '2026-10-06', week_of: '2026-10-05', status: 'published', mode: 'auto', gates: elevenGates }))}::jsonb);`)).reason === 'not_cleared');
    const w1 = await go(WED);
    chk('D auto mode: Wednesday clears all twelve gates and is published', w1.published[0] === sWed.id && row(sWed.id).status === 'published' && S.load().some((r) => r.id === sWed.id && r.status === 'published'), w1.results);
    const w2 = await go(WED + 3600000);
    chk('D an hour later the slot is not touched again', w2.published.length === 0 && /already published/.test(w2.results[0].reason || ''));
    chk('D a published feature is final in the database', JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: sWed.id, kind: 'storylines', slot_date: '2026-10-07', week_of: '2026-10-05', status: 'held' }))}::jsonb);`)).reason === 'already_published');

    own(`select public.content_engine_fp_settings_save('{"fp_max_per_week":1}'::jsonb);`);
    const f1 = await go(FRI);
    chk('D the weekly cap holds Friday for review (one a week this time)', f1.results[0].status === 'held' && row(sFri.id).status === 'held' && row(sFri.id).failed.indexOf('cadence') >= 0 && !S.load().some((r) => r.id === sFri.id), f1.results);
    const hashF = row(sFri.id).content_hash;
    chk('D the owner rejects it', own(`select public.content_engine_fp_decide(${lit(sFri.id)}, 'reject', 'not this week', null) ->> 'ok';`) === 'true');
    const f2 = await go(FRI + 1800000);
    chk('D a rejected feature stays rejected: the job does not rebuild or publish it', f2.published.length === 0 && row(sFri.id).status === 'rejected');
    chk('D the owner reopens it', own(`select public.content_engine_fp_decide(${lit(sFri.id)}, 'reopen', null, null) ->> 'ok';`) === 'true' && row(sFri.id).status === 'held');
    chk('D approval binds to the exact text: a stale hash is refused', own(`select public.content_engine_fp_decide(${lit(sFri.id)}, 'approve', 'ok', 'not-the-hash') ->> 'reason';`) === 'changed_since_loaded');
    own(`select public.content_engine_fp_settings_save('{"fp_max_per_week":3}'::jsonb);`);
    chk('D the owner approves this exact text', own(`select public.content_engine_fp_decide(${lit(sFri.id)}, 'approve', 'checked the numbers', ${lit(hashF)}) ->> 'ok';`) === 'true' && row(sFri.id).status === 'approved');
    const f3 = await go(FRI + 3600000);
    chk('D the next run publishes what the owner approved, marked as the owner’s', f3.published.indexOf(sFri.id) >= 0 && row(sFri.id).status === 'published' && row(sFri.id).mode === 'owner'
      && S.load().some((r) => r.id === sFri.id && r.owner_approved === true), f3.results);
    chk('D three a week at most, counted by the database', JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: 'feature-2026-10-10-storylines', kind: 'storylines', slot_date: '2026-10-10', week_of: '2026-10-05', status: 'published', mode: 'auto', gates: fakeGates }))}::jsonb);`)).ok === true
      && JSON.parse(db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: 'feature-2026-10-11-storylines', kind: 'storylines', slot_date: '2026-10-11', week_of: '2026-10-05', status: 'published', mode: 'auto', gates: fakeGates }))}::jsonb);`)).reason === 'weekly_cap');
    fs.unlinkSync(path.join(S.dir, sWed.id + '.json'));
    const h1 = await go(Date.parse('2026-10-08T15:00:00Z'));
    chk('D a published record a push race removed is written back', h1.healed.indexOf(sWed.id) >= 0 && S.load().some((r) => r.id === sWed.id && r.status === 'published'), h1);
    const nrAt = Date.parse('2026-10-12T13:30:00Z');
    const nr = await go(nrAt, { art: ungradedAt(nrAt) });
    chk('D a Monday with no graded weekend is recorded as skipped, with the reason', nr.results[0].status === 'skipped' && row('feature-2026-10-12-weekend-review').status === 'skipped' && /no graded games/.test(row('feature-2026-10-12-weekend-review').reason));
    chk('D every published file is a feature the build will accept', S.load().filter((r) => r.status === 'published').every((r) => MODEL.publishable(r).ok));
    chk('D the owner turns it off; nothing runs', own(`select public.content_engine_fp_settings_save('{"fp_mode":"off"}'::jsonb) ->> 'ok';`) === 'true' && (await go(Date.parse('2026-10-14T13:30:00Z'))).ran === false);
  } catch (e) {
    chk('the database section reached its end — ' + String(e && e.stack || e).slice(0, 600), false);
  } finally { db.stop(); }
  finish();
})();

function finish() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk features | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

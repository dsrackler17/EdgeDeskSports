#!/usr/bin/env node
/* ===========================================================================
   THE WEEKLY JOB (tools/content/run.js), against the real database as the
   SERVICE ROLE — the credential the GitHub workflow holds — through a small
   PostgREST stand-in. The research is the committed one; the clock is fixed
   at Thursday of CFB Week 6. Claude and the feeds are stubbed.

     L  LEASE     one run per week's slates; a second run does nothing; a
                  forced run supersedes without duplicating any article; the
                  owner's off switch stops it
     D  DRAFTS    at most drafts_per_run, the highest priority first; a draft
                  that passes every check goes to review, never further
     C  CLAUDE    raw HTTPS with the key in x-api-key only, the fallback beta,
                  structured output; a version that fails the checks is
                  discarded and the deterministic draft kept; no budget, no call
     X  EXAMPLE   the example command writes Markdown, HTML, the SEO sheet and
                  the check report from the current research, and they pass

   Run: node tools/content/run.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const { sqlVal } = require(path.join(__dirname, '..', 'growth', '_rpc_shim.js'));
const PGR = require(path.join(__dirname, '..', 'lib', 'pgrest.js'));
const RUN = require(path.join(__dirname, 'run.js'));
const CE = require(path.join(__dirname, '..', '..', 'lib', 'content_engine.js'));

const T = PG.kit('content engine weekly job');
const chk = T.chk;
const NOW = Date.parse('2026-10-08T17:30:00Z');

(async () => {
  /* X — no database needed */
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-example-'));
  const ex = await RUN.example({ now: NOW, out });
  const md = fs.readFileSync(ex.file, 'utf8');
  chk('X the example article passes every hard check', ex.ok, ex.failed);
  chk('X … and carries the disclaimer, the UTM link and no pick language', /1-800-GAMBLER/.test(md) && /utm_campaign=ce_stadiumrant_/.test(md) && !/best bet|our pick|guarantee/i.test(md));
  chk('X Markdown, HTML, SEO sheet and check report were written', ['.md', '.html', '.seo.txt', '.checks.json'].every((x) => fs.existsSync(ex.file.replace(/\.md$/, x))));
  fs.rmSync(out, { recursive: true, force: true });

  const db = PG.start('contentjob');
  if (db.skip) { console.log((process.env.CONTENT_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); if (process.env.CONTENT_PG_REQUIRED) process.exit(1); process.exit(T.done()); }
  const lit = PG.lit;
  const one = (s) => db.sql(s);
  const SB = 'https://job.supabase.test', SERVICE = 'service-role-key-for-tests';
  let CLAUDE = [], FEEDS = 0, claudeAnswer = null;
  const fakeFetch = async (url, init) => {
    url = String(url);
    if (url.startsWith(SB + '/rest/v1/rpc/')) {
      if ((init.headers.authorization || '') !== 'Bearer ' + SERVICE) return new Response('{"message":"no"}', { status: 401 });
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body || '{}');
      const sql = `select public.${fn}(${Object.entries(args).map(([k, v]) => k + ' => ' + sqlVal(v)).join(', ')});`;
      try { const o = db.service(sql); return new Response(o === '' ? 'null' : o, { status: 200 }); }
      catch (e) { return new Response(JSON.stringify({ message: String(e.sqlMessage || e.message).slice(0, 300) }), { status: /permission denied/.test(String(e.message)) ? 403 : 400 }); }
    }
    if (url === 'https://api.anthropic.com/v1/messages') { CLAUDE.push(init); return new Response(JSON.stringify(claudeAnswer(JSON.parse(init.body))), { status: 200 }); }
    if (/rss|headlines/.test(url)) { FEEDS++; return new Response('<rss><channel></channel></rss>', { status: 200 }); }
    return new Response('nope', { status: 404 });
  };
  const client = PGR.client({ url: SB, key: SERVICE }, fakeFetch, { retries: 0 });
  const quiet = () => {};
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql', 'content_engine.sql', 'content_engine_evidence.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));

    /* L + D — no Claude */
    const r1 = await RUN.weekly({ db: client, now: NOW, network: true, fetch: fakeFetch, log: quiet });
    chk('L the first run of the week runs', r1.ran && /^2026-cfb-w6-nfl-w5$/.test(r1.period), r1);
    chk('D opportunities were recorded', r1.counts.opportunities >= 8 && r1.counts.created === r1.counts.opportunities, r1.counts);
    chk('D the feeds were read, each fetch counted', FEEDS === 6 && one(`select calls from content_engine.usage where provider = 'fetch';`) === '6');
    chk('D at most two drafts (the default), both new', r1.counts.drafted === 2, r1.counts);
    const arts = JSON.parse(one(`select coalesce(jsonb_agg(jsonb_build_object('status', a.status, 'by', a.created_by, 'gen', a.generator, 'prio', o.priority, 'pub', p.slug) order by o.priority desc), '[]') from content_engine.articles a join content_engine.opportunities o on o.id = a.opportunity_id left join content_engine.publishers p on p.id = a.publisher_id;`));
    chk('D drafts that pass every check are queued for review, never further', arts.length === 2 && arts.every((a) => a.status === 'in_review' && a.by === 'schedule' && /^template:/.test(a.gen)), arts);
    chk('D … for the default publisher', arts.every((a) => a.pub === 'stadium-rant'));
    const top = JSON.parse(one(`select coalesce(jsonb_agg(priority order by priority desc), '[]') from content_engine.opportunities;`));
    chk('D the highest-priority opportunities were drafted first', arts.every((a) => a.prio >= top[2]), { arts, top });
    chk('G each new draft carries the editorial gate, run against the research as read', (r1.counts.gate_pass || 0) + (r1.counts.gate_warning || 0) + (r1.counts.gate_blocked || 0) === 2
      && one(`select count(*) from content_engine.articles where gate_hash = content_hash and gate_verdict = first_gate_verdict;`) === '2', r1.counts);
    const cfbGate = JSON.parse(one(`select gate from content_engine.articles a join content_engine.opportunities o on o.id = a.opportunity_id where o.key = 'cfb:2026:w6:weekly_preview';`));
    const rel = cfbGate.items.find((i) => i.key === 'reliability');
    chk('G the college preview is BLOCKED on its two unexplained market gaps, each waiting on the owner', cfbGate.verdict === 'BLOCKED' && rel.status === 'BLOCKED'
      && rel.findings.filter((f) => f.status === 'BLOCKED').map((f) => f.ack_key).sort().join() === 'discrepancy:401856718,discrepancy:401858484'
      && cfbGate.items.filter((i) => i.status === 'BLOCKED').length === 1, rel);
    chk('D nothing approved, sent or published', one(`select count(*) from content_engine.articles where status in ('approved','ready_to_send','sent','published');`) === '0');
    const r2 = await RUN.weekly({ db: client, now: NOW, network: false, log: quiet });
    chk('L the same week does not run twice', r2.ran === false && r2.reason === 'already_done');
    const r3 = await RUN.weekly({ db: client, now: NOW, network: false, force: true, log: quiet });
    chk('L a forced run re-runs: refreshes, drafts the next two, duplicates nothing', r3.ran && r3.counts.created === 0 && r3.counts.refreshed === r1.counts.opportunities && r3.counts.drafted === 2
      && one(`select count(*) from content_engine.articles;`) === '4'
      && one(`select count(*) from (select opportunity_id from content_engine.articles group by opportunity_id having count(*) > 1) x;`) === '0', r3.counts);

    /* C — Claude */
    one(`update content_engine.settings set drafts_per_run = 1;`);
    let calls = 0;
    claudeAnswer = (body) => {
      calls++;
      const cur = JSON.parse(/CURRENT DRAFT:\n([\s\S]*)$/.exec(body.messages[0].content)[1]);
      /* first call invents a number; the retry is honest */
      if (calls === 1) { cur.sections[0].body += ' They have won 83 percent of their games since 1987.'; }
      else cur.standfirst = cur.standfirst + ' The numbers, explained.';
      return { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 8000, output_tokens: 2500 }, content: [{ type: 'text', text: JSON.stringify(cur) }] };
    };
    const r4 = await RUN.weekly({ db: client, now: NOW, network: false, force: true, anthropicKey: 'sk-ant-job-key-12345', model: 'claude-opus-5-5', fetch: fakeFetch, log: quiet });
    chk('C Claude was asked twice: an invented number refused, the honest retry kept', r4.counts.ai_used === 1 && CLAUDE.length === 2 && r4.counts.drafted === 1, r4.counts);
    const h = CLAUDE[0].headers, b = JSON.parse(CLAUDE[0].body);
    chk('C raw HTTPS: the key in x-api-key, the version and the fallback beta', h['x-api-key'] === 'sk-ant-job-key-12345' && h['anthropic-version'] === '2023-06-01' && h['anthropic-beta'] === 'server-side-fallback-2026-07-01');
    chk('C structured output, fallbacks, the model', b.output_config && b.output_config.format.type === 'json_schema' && b.fallbacks === 'default' && b.model === 'claude-opus-5-5');
    chk('C the retry carried the objections', /REJECTED FOR/.test(JSON.parse(CLAUDE[1].body).messages[0].content));
    const led = JSON.parse(one(`select coalesce(jsonb_agg(jsonb_build_object('a', attempt, 'actor', actor, 'op', operation, 'st', status, 'out', outcome, 'est', est_usd, 'in', input_tokens) order by id), '[]') from content_engine.ai_calls;`));
    chk('$ both calls went through the ledger: reserved first, settled with the usage reported', led.length === 2 && led.every((x) => x.actor === 'schedule' && x.op === 'draft' && x.st === 'completed' && x.in === 8000)
      && led[0].out === 'discarded' && led[1].out === 'accepted' && led[0].a === 1 && led[1].a === 2, led);
    chk('$ priced per model at list price: 8,000 in + 2,500 out', led.every((x) => Math.abs(+x.est - (8000 * 4 + 2500 * 20) / 1e6) < 1e-6), led);
    chk('C Claude’s checked version is the saved draft', one(`select count(*) from content_engine.articles where generator like 'claude:%' and standfirst like '%The numbers, explained.%';`) === '1');
    chk('C the key reached no log or row', !/sk-ant-job-key/.test(one(`select coalesce(string_agg(detail::text, ' '), '') from content_engine.events;`)) && !/sk-ant-job-key/.test(one(`select coalesce(string_agg(sections::text, ' '), '') from content_engine.articles;`)));
    CLAUDE = [];
    claudeAnswer = (body) => { const cur = JSON.parse(/CURRENT DRAFT:\n([\s\S]*)$/.exec(body.messages[0].content)[1]); cur.title = 'Our best bets for the weekend'; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(cur) }] }; };
    const r5 = await RUN.weekly({ db: client, now: NOW, network: false, force: true, anthropicKey: 'sk-ant-job-key-12345', model: 'claude-opus-5-5', fetch: fakeFetch, log: quiet });
    chk('C a version that fails twice is discarded; the deterministic draft is kept and queued', r5.counts.ai_discarded === 1 && r5.counts.queued_for_review === 1
      && one(`select count(*) from content_engine.articles where title ilike '%best bets%';`) === '0', r5.counts);
    one(`update content_engine.settings set llm_calls_per_day = 0;`);
    CLAUDE = [];
    const r6 = await RUN.weekly({ db: client, now: NOW, network: false, force: true, anthropicKey: 'sk-ant-job-key-12345', model: 'claude-opus-5-5', fetch: fakeFetch, log: quiet });
    chk('C no budget: no call; the draft is still written', CLAUDE.length === 0 && r6.counts.drafted === 1, r6.counts);
    one(`update content_engine.settings set llm_calls_per_day = 100, ai_monthly_budget_usd = 0.05;`);
    CLAUDE = [];
    const r6b = await RUN.weekly({ db: client, now: NOW, network: false, force: true, anthropicKey: 'sk-ant-job-key-12345', model: 'claude-opus-5-5', fetch: fakeFetch, log: quiet });
    chk('$ the monthly dollar budget refuses the call before it is made; the draft is still written', CLAUDE.length === 0 && r6b.counts.drafted === 1 && r6b.counts.ai_used === 0
      && one(`select count(*) from content_engine.events where kind = 'ai_discarded' and run_id = '${r6b.run}';`) === '1', r6b.counts);

    /* L — the owner's switch */
    one(`update content_engine.settings set schedule_enabled = false;`);
    const r7 = await RUN.weekly({ db: client, now: NOW, network: false, force: true, log: quiet });
    chk('L the owner’s off switch stops the job', r7.ran === false && r7.reason === 'schedule_disabled');
    chk('L every run is on record (six ran; the refused ones never opened a lease)', +one(`select count(*) from content_engine.runs;`) === 6);
  } catch (e) {
    chk('the suite reached its end — ' + String(e && e.stack || e).slice(0, 600), false);
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();

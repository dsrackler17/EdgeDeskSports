/* ===========================================================================
   THE TERMINAL'S PAYWALL DEFERS TO THE ONE RULE: supabase/paywall_rule.sql,
   and Deploy Fairline's before/after comparison
   (tools/billing/sql/paywall_before.psql, paywall_after.psql), on a real
   PostgreSQL.

   Production's has_active_sub() restated the rule: it read subscriptions'
   status itself (Deploy Fairline's paywall check, 2026-10-29). This suite
   stands that shape up, then applies the fix the way the deploy does, in one
   transaction with the comparison around it, and proves:

     a Fairline (black) or Bet Checker (red) row  -> passed before, never after
     the terminal (blue), a comp, an unlearned price, a past_due row in its
     grace                                        -> pass after, and read signals
     lapsed, cancelled, no row                    -> never
     an EdgeDesk operator (billing_is_admin()) with
     no subscriptions row                         -> keeps the terminal
     the change keeps the function's grants       -> anon still cannot run it
     an account with access through something the rule cannot see
                                                  -> the change is refused, and
                                                     nothing is changed
     the deploy's own paywall check               -> fails before, passes after

   Needs PostgreSQL (skips loudly without it; PAYWALL_RULE_REQUIRED=1 makes a
   missing one a failure). Run: node tools/billing/paywall_rule.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../personal/_pg.js');

const ROOT = path.join(__dirname, '..', '..');
const T = PG.kit('paywall rule');
const chk = T.chk;
const lit = PG.lit;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RULE = read('supabase/paywall_rule.sql');
const BEFORE = read('tools/billing/sql/paywall_before.psql');
const AFTER = read('tools/billing/sql/paywall_after.psql');
const WF = read('.github/workflows/deploy-fairline.yml');

/* ── STATIC ─────────────────────────────────────────────────────────────── */
chk('the migration mirror is byte for byte', read('supabase/migrations/20261029140000_paywall_rule.sql') === RULE);
chk('the fix grants and revokes nothing, and touches no policy', !/\b(grant|revoke)\b/i.test(RULE.replace(/--[^\n]*/g, '')) && !/\bpolicy\b/i.test(RULE.replace(/--[^\n]*/g, '')));
chk('Deploy Fairline applies it between the comparison, before its paywall check',
  /tools\/billing\/sql\/paywall_before\.psql -f supabase\/paywall_rule\.sql -f tools\/billing\/sql\/paywall_after\.psql/.test(WF) &&
  WF.indexOf('paywall_rule.sql') < WF.indexOf('The paywall defers to the rule'));
chk('a dry run rolls back, and only apply commits', /dry_run\) end=rollback/.test(WF) && /apply\) end=commit/.test(WF));

/* production's shape before the fix: the statuses inlined, no tier */
const OLD = `create or replace function public.has_active_sub() returns boolean language sql stable security definer
  set search_path = public, pg_temp as $$
    select exists (select 1 from public.subscriptions s where s.user_id = auth.uid()
                    and s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now())) $$;
  revoke all on function public.has_active_sub() from public, anon;
  grant execute on function public.has_active_sub() to authenticated;`;

(async () => {
  const db = PG.start('paywall');
  if (db.skip) {
    if (process.env.PAYWALL_RULE_REQUIRED === '1') chk('environment: ' + db.skip, false);
    console.log('SKIP | paywall rule | ' + db.skip + ' (not verified)');
    process.exit(T.done());
  }
  const sql = (q) => db.sql(q);
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'subscription_price.sql', 'site_articles.sql', 'community_posts.sql', 'billing_hardening.sql']
      .forEach((f) => db.applyFile(path.join(ROOT, 'supabase', f)));
    const noRule = db.mustFail(() => sql(RULE.replace(/billing_row_grants_access\(text, text, timestamptz, timestamptz\)/, 'no_such_rule(text)')));
    chk('without the rule it stops and names billing_hardening.sql', /billing_hardening\.sql/.test(noRule || ''), noRule && noRule.slice(0, 200));

    sql(OLD + `
      create table public.signals (sig_key text primary key, sharp_fair numeric);
      insert into public.signals values ('k1', 0.52), ('k2', 0.48);
      alter table public.signals enable row level security;
      create policy signals_sub on public.signals for select to authenticated using (public.has_active_sub());
      grant select on public.signals to authenticated;
      create table public.issue_report_admins (user_id uuid primary key);
      insert into public.billing_price_tiers (price_id, tier, source) values
        ('price_blue', 'blue', 'test'), ('price_red', 'red', 'test'), ('price_black', 'black', 'test');`);

    /* the accounts, one row each (subscriptions is one row per account) */
    const A = {};
    let n = 0;
    const acct = (name, row) => {
      n++;
      const id = '00000000-0000-4000-9000-' + String(n).padStart(12, '0');
      sql('insert into auth.users (id, email) values (' + lit(id) + ', ' + lit(name + '@x.co') + ');');
      if (row) sql('insert into public.subscriptions (user_id, status, price_id, current_period_end) values (' +
        [lit(id), lit(row[0]), lit(row[1]), row[2] == null ? 'null' : "now() + interval '" + row[2] + " days'"].join(', ') + ');');
      A[name] = id;
    };
    acct('blue', ['active', 'price_blue', 20]);
    acct('black', ['active', 'price_black', 20]);
    acct('red', ['active', 'price_red', 20]);
    acct('comp', ['active', 'owner_comp', null]);
    acct('unlearned', ['active', 'price_never_seen', 20]);
    acct('grace', ['past_due', 'price_blue', -3]);
    acct('lapsed', ['active', 'price_blue', -2]);
    acct('cancelled', ['canceled', 'price_blue', 20]);
    acct('nobody', null);
    acct('operator', null);
    sql('insert into public.issue_report_admins (user_id) values (' + lit(A.operator) + ');');

    const has = (u) => db.as(A[u], 'select public.has_active_sub();') === 't';
    const seen = (u) => Number(db.as(A[u], 'select count(*) from public.signals;'));

    /* BEFORE: production's shape lets the cheaper tiers read the terminal */
    chk('before: a Fairline (black) subscription passes has_active_sub() and reads signals', has('black') && seen('black') === 2);
    chk('before: so does a Bet Checker (red) one', has('red') && seen('red') === 2);
    chk('before: a past_due row in its 21-day grace is shut out (the rule keeps it)', !has('grace'));
    chk('before: this stand-in shuts an operator with no row out', !has('operator'));

    /* the deploy's own paywall check (deploy-fairline.yml), read-only, before */
    const check = () => sql("select case when pg_get_functiondef(to_regprocedure('public.has_active_sub()')) similar to '(%billing_row_grants_access%|%community_is_entitled%)' then 'defers' else 'restates' end;");
    chk('the deploy\'s paywall check says it restates the rule', check() === 'restates');

    /* THE CHANGE, as Deploy Fairline makes it: one transaction, compared */
    const out = sql('begin;\n' + BEFORE + '\n' + RULE + '\n' + AFTER + '\ncommit;');
    const line = (re) => (out.split('\n').filter((l) => re.test(l))[0] || '');
    chk('the comparison counts every account', /PAYWALL accounts 10 · granted before 5 · after 5 · gained 2 · lost 2/.test(line(/^PAYWALL accounts/)), line(/^PAYWALL accounts/));
    chk('and names why each lost it: a Fairline row, a Bet Checker row', /a Fairline \(black\) row 1/.test(out) && /a Bet Checker \(red\) row 1/.test(out), out.split('\n').filter((l) => /^PAYWALL/.test(l)));
    chk('the report: it defers, names no status, pins its search_path, keeps operators', ['01', '02', '03', '04'].every((r) => new RegExp('^' + r + ' [^|]*\\|ok$', 'm').test(out)), out.slice(-600));
    chk('the deploy\'s paywall check now passes', check() === 'defers');

    /* AFTER: the rule */
    chk('after: a Fairline (black) subscription never passes, and reads no signal', !has('black') && seen('black') === 0);
    chk('after: nor a Bet Checker (red) one', !has('red') && seen('red') === 0);
    chk('after: the terminal (blue) still does, and reads them', has('blue') && seen('blue') === 2);
    chk('after: a comp still does', has('comp') && seen('comp') === 2);
    chk('after: a price never learned still does (the rule\'s coalesce to blue)', has('unlearned'));
    chk('after: past_due in its grace now does, as the rule says', has('grace'));
    chk('after: lapsed, cancelled and no row never do', !has('lapsed') && !has('cancelled') && !has('nobody'));
    chk('after: an EdgeDesk operator with no subscriptions row keeps the terminal, and reads signals', has('operator') && seen('operator') === 2);
    chk('it agrees with community_is_entitled() for every account but the operator', Object.keys(A).filter((u) => u !== 'operator').every((u) => has(u) === (sql('select public.community_is_entitled(' + lit(A[u]) + ');') === 't')));
    chk('the grants are kept: anon still cannot run it', !!db.mustFail(() => db.anon('select public.has_active_sub();')));
    chk('and it applies a second time, identically', /^01 [^|]*\|ok$/m.test(sql(RULE)));

    /* REFUSED: access the rule cannot see (no subscriptions row) is never dropped silently */
    sql(OLD.replace("s.user_id = auth.uid()\n", 's.user_id = auth.uid()\n').replace('select exists (select 1 from public.subscriptions s where s.user_id = auth.uid()',
      "select auth.uid() = " + lit(A.nobody) + "::uuid or exists (select 1 from public.subscriptions s where s.user_id = auth.uid()"));
    chk('(a function that also opens an account with no row)', has('nobody'));
    const refused = db.mustFail(() => sql('begin;\n' + BEFORE + '\n' + RULE + '\n' + AFTER + '\ncommit;'));
    chk('the change is refused: it counts the account the rule cannot see, and names it masked', /1 account\(s\) had the terminal through something other than a subscriptions row, which the rule cannot see \(00000000…\)/.test(refused || ''), refused && refused.slice(0, 300));
    chk('and nothing was changed: the old function still answers', has('nobody') && check() === 'restates');
    /* a dry run rolls back */
    sql(OLD);
    sql('begin;\n' + BEFORE + '\n' + RULE + '\n' + AFTER + '\nrollback;');
    chk('a dry run changes nothing', check() === 'restates' && has('black'));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();

'use strict';
/* ===========================================================================
   Seeding outbound prospects the way they are now made: from EVIDENCE.

   Since Phase 3 a prospect's name, confidences, fit score, email status and
   research status are computed by growth_outbound.evaluate() and no statement
   may write them — not even the superuser's. So a test that needs a prospect
   "ready for review" builds one the honest way: the row with only its email
   and URLs, then evidence from independent first-party sources, fit reasons
   citing that evidence, a draft whose claims cite it, then evaluate().

   Every function returns SQL for the superuser session (db.sql), which is
   what the research pipeline's server side amounts to.
   =========================================================================== */
const { lit } = require('../personal/_pg.js');

const FIT_STRONG = ['quant_analysis', 'publishes_models', 'odds_markets_probability', 'ev_fair_pricing',
  'covers_cfb', 'runs_newsletter_or_channel', 'discusses_clv']; // 18+15+14+14+8+8+12 = 89

const evaluate = (id) => `do $ev$ begin perform growth_outbound.evaluate(${lit(id)}); end $ev$;\n`;

/* A prospect that clears every gate: two independent first-party sources for
   the name, organization and the project cited, an owner-checked email
   published on their own site, and seven evidenced fit reasons. */
function strong(o) {
  const id = o.id, d = o.domain, h = o.handle;
  const ev = (field, claim, url, kind, excerpt) =>
    `(${lit(id)}, ${lit(field)}, ${lit(claim)}, ${lit(url)}, ${lit(kind)}, ${lit(excerpt)}, 'owner')`;
  return `
    insert into growth_outbound.prospects (id, is_test, email, prospect_type, sports_focus, website_url, x_url)
    values (${lit(id)}, ${o.test ? 'true' : 'false'}, ${lit(o.email)}, ${lit(o.type || 'cfb_analyst')}, '{CFB}',
            ${lit('https://' + d)}, ${lit('https://x.com/' + h)});
    insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
      ${ev('full_name', o.name, 'https://' + d + '/about', 'own_site', 'I am ' + o.name)},
      ${ev('full_name', o.name, 'https://x.com/' + h, 'own_profile', o.name + ' (@' + h + ')')},
      ${ev('organization', o.org, 'https://' + d + '/about', 'own_site', 'I run ' + o.org)},
      ${ev('organization', o.org, 'https://x.com/' + h, 'own_profile', 'founder, ' + o.org)},
      ${ev('email', o.email, 'https://' + d + '/contact', 'own_site', 'Email me: ' + o.email)},
      ${ev('email', o.email, 'https://' + d + '/contact', 'owner_verified', null)},
      ${ev('project', o.project || 'CFB power ratings against the market', 'https://' + d + '/ratings', 'own_site', 'Week 5 power ratings against the closing line')},
      ${ev('project', o.project || 'CFB power ratings against the market', 'https://x.com/' + h + '/status/1', 'own_profile', 'New: ' + (o.project || 'CFB power ratings against the market'))},
      ${ev('fit_signal', 'prices every game with a market model', 'https://' + d + '/method', 'own_site', 'our model prices every game and tracks CLV')};
    update growth_outbound.prospects set fit_factors = (
      select jsonb_agg(jsonb_build_object('code', c, 'evidence', jsonb_build_array(e.id)))
        from unnest(${lit('{' + (o.fit || FIT_STRONG).join(',') + '}')}::text[]) c,
             (select id from growth_outbound.evidence where prospect_id = ${lit(id)} and field_name = 'fit_signal' order by id limit 1) e)
     where id = ${lit(id)};
    ${evaluate(id)}`;
}

/* A prospect found only in a directory, with a guessed address: nothing about
   them clears a gate. */
function weak(o) {
  const id = o.id;
  return `
    insert into growth_outbound.prospects (id, email, prospect_type) values (${lit(id)}, ${lit(o.email)}, 'other');
    insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
      (${lit(id)}, 'full_name', ${lit(o.name)}, 'https://directory.test/people/1', 'directory', ${lit(o.name + ', media')}, 'owner'),
      (${lit(id)}, 'email', ${lit(o.email)}, 'https://directory.test/people/1', 'pattern_guess', null, 'owner'),
      (${lit(id)}, 'project', 'a sports show', 'https://directory.test/people/1', 'directory', 'hosts a sports show', 'owner');
    update growth_outbound.prospects set fit_factors = '[{"code": "generic_content"}]'::jsonb where id = ${lit(id)};
    ${evaluate(id)}`;
}

/* A draft whose one personalised claim cites the prospect's project evidence,
   and says it in the email — a cited claim must appear in the words. */
function draft(o) {
  return `
    insert into growth_outbound.drafts (id, prospect_id, sequence_number, is_test, subject, body_text, claims)
    select ${lit(o.id)}, ${lit(o.prospect)}, ${o.seq || 1}, ${o.test ? 'true' : 'false'}, ${lit(o.subject)},
           ${lit(o.body)} || coalesce(' I read your ' || e.claim || '.', ''),
           case when e.id is null then '[]'::jsonb
                else jsonb_build_array(jsonb_build_object('text', 'your ' || e.claim, 'evidence_id', e.id)) end
      from (select 1) one
      left join lateral (select id, claim from growth_outbound.evidence where prospect_id = ${lit(o.prospect)} and field_name = 'project'
                          order by id limit 1) e on true;
    ${evaluate(o.prospect)}`;
}

/* (Phase 13) Live sending needs the opt-out endpoint CHECKED at its current
   base and Resend's webhook PROVEN by a signed event received since the
   secret was set. A suite that sends live emails stands both in, exactly as
   the database would hold them after the owner's "Check the opt-out endpoint"
   and a delivered test send. Run it after the base and the secret are set. */
function liveReady() {
  return `
    update growth_outbound.settings
       set optout_check = jsonb_build_object('base', unsubscribe_url_base, 'ok', true, 'redirect_ok', true, 'post_ok', true,
                                             'detail', 'stood in by the test suite'),
           optout_checked_at = now()
     where id = 1 and unsubscribe_url_base is not null;
    insert into growth_outbound.provider_events (event_id, event_type, outcome)
    values ('evt_ready_' || gen_random_uuid(), 'email.delivered', 'not_outbound');`;
}

module.exports = { strong, weak, draft, evaluate, FIT_STRONG, liveReady };

-- Model Collective, migration 8: seeds. Config numbers (Section 5, decided,
-- one place only), the NFL, its 2026 season window, all 32 teams, and a
-- generous alias vocabulary for canonical resolution.

insert into collective.config (key, value, description) values
  ('pricing.monthly_cents',      '2000',  'Retail price, fixed everywhere: $20 per month'),
  ('pricing.annual_cents',       '20000', 'Retail price, annual: $200 per year'),
  ('share.referral_bps_default', '4000',  'Mode A default: 40 percent recurring'),
  ('share.founding_bps',         '5000',  'Founding member Mode A rate: 50 percent recurring, locked for membership life'),
  ('share.founding_seats',       '10',    'How many founding invitations exist'),
  ('wholesale.seat_cents',       '1400',  'Mode B: $14 per seat per month'),
  ('wholesale.min_seats',        '10',    'Mode B minimum seats'),
  ('wholesale.floor_cents',      '2000',  'Mode B may not sell standalone below this; bundle only'),
  ('payout.min_cents',           '5000',  '$50 payout minimum, balance rolls forward'),
  ('payout.net_days',            '30',    'Monthly payouts, net 30 after month close'),
  ('payout.clawback_days',       '60',    'Refund and chargeback clawback window'),
  ('ranking.min_coverage_pct',   '60',    'Minimum season-to-date slate coverage to be ranked'),
  ('ranking.min_graded_games',   '20',    'Minimum graded games to be ranked'),
  ('ranking.per_sport',          '{}',    'Optional per-sport overrides of the ranking minimums'),
  ('status.active_days',         '10',    'Live submission within this many days = ACTIVE CONTRIBUTOR in season'),
  ('status.inactive_days',       '45',    'Silence this long in season = INACTIVE'),
  ('billing.enabled',            'false', 'Money switch. Attribution records either way (rule 8.13)'),
  ('invite.expiry_days',         '30',    'Invite tokens live this long'),
  ('ingest.max_rows',            '500',   'Rows per submission'),
  ('ingest.max_bytes',           '524288','Bytes per submission body'),
  ('ingest.rate_per_hour',       '60',    'Requests per key per hour'),
  ('admin.user_ids',             '[]',    'Auth user ids allowed on collective_admin endpoints'),
  ('embed.cache_seconds',        '60',    'Embed bootstrap cache TTL'),
  ('embed.allow_localhost',      'true',  'Allow localhost origins for embed testing');

insert into collective.sports (code, name) values ('NFL', 'Football');
insert into collective.sport_seasons (sport_code, season, starts_on, ends_on)
values ('NFL', 2026, '2026-09-04', '2027-02-08');

-- Teams plus aliases. Format: code | city | nickname | extra;extra.
-- Every team answers to its code, nickname, and full name. City aliases are
-- seeded only where unambiguous (New York and Los Angeles are not).
do $$
declare
  rows text[] := array[
    'ARI|Arizona|Cardinals|ARZ;AZ',
    'ATL|Atlanta|Falcons|',
    'BAL|Baltimore|Ravens|BLT',
    'BUF|Buffalo|Bills|',
    'CAR|Carolina|Panthers|',
    'CHI|Chicago|Bears|',
    'CIN|Cincinnati|Bengals|',
    'CLE|Cleveland|Browns|CLV',
    'DAL|Dallas|Cowboys|',
    'DEN|Denver|Broncos|',
    'DET|Detroit|Lions|',
    'GB|Green Bay|Packers|GNB',
    'HOU|Houston|Texans|',
    'IND|Indianapolis|Colts|',
    'JAX|Jacksonville|Jaguars|JAC',
    'KC|Kansas City|Chiefs|KAN',
    'LAC|Los Angeles|Chargers|SD;San Diego Chargers',
    'LAR|Los Angeles|Rams|LA;STL;St. Louis Rams',
    'LV|Las Vegas|Raiders|OAK;Oakland Raiders',
    'MIA|Miami|Dolphins|',
    'MIN|Minnesota|Vikings|',
    'NE|New England|Patriots|NWE',
    'NO|New Orleans|Saints|NOR',
    'NYG|New York|Giants|',
    'NYJ|New York|Jets|',
    'PHI|Philadelphia|Eagles|',
    'PIT|Pittsburgh|Steelers|',
    'SEA|Seattle|Seahawks|',
    'SF|San Francisco|49ers|SFO;Niners',
    'TB|Tampa Bay|Buccaneers|TAM;Bucs',
    'TEN|Tennessee|Titans|TENN',
    'WAS|Washington|Commanders|WSH;Washington Football Team'
  ];
  r text;
  parts text[];
  v_team uuid;
  a text;
  city_ambiguous boolean;
begin
  foreach r in array rows loop
    parts := string_to_array(r, '|');
    insert into collective.teams (sport_code, code, name)
    values ('NFL', parts[1], parts[2] || ' ' || parts[3])
    returning id into v_team;

    -- code, nickname, full name
    insert into collective.team_aliases (sport_code, alias, team_id) values
      ('NFL', parts[1], v_team),
      ('NFL', parts[3], v_team),
      ('NFL', parts[2] || ' ' || parts[3], v_team);

    -- city alias where it is unambiguous
    city_ambiguous := parts[2] in ('New York', 'Los Angeles');
    if not city_ambiguous then
      insert into collective.team_aliases (sport_code, alias, team_id)
      values ('NFL', parts[2], v_team)
      on conflict do nothing;
    end if;

    if parts[4] <> '' then
      foreach a in array string_to_array(parts[4], ';') loop
        insert into collective.team_aliases (sport_code, alias, team_id)
        values ('NFL', a, v_team)
        on conflict do nothing;
      end loop;
    end if;
  end loop;
end $$;

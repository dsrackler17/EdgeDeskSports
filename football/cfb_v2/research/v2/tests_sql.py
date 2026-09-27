"""Exercise supabase/cfb_v2_model.sql against a real Postgres.

    CFB_V2_PG="-h /tmp/pg -p 55432 -U postgres" python3 -m v2.tests_sql

Applies the migration twice (idempotency), then proves the triggers refuse:
updates to a frozen prediction, deletes, a prediction at/after kickoff, a
feature_ts after prediction_ts, a market decision after kickoff, a fair line
whose sign disagrees with the projected margin, and a second write of a
training snapshot's features. Skips (exit 0) when no Postgres is configured.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SQL = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..', 'supabase', 'cfb_v2_model.sql'))
PG = os.environ.get('CFB_V2_PG')


def psql(sql, expect_error=False):
    p = subprocess.run('psql %s -v ON_ERROR_STOP=1 -q -At' % PG, input=sql, shell=True,
                       capture_output=True, text=True)
    failed = p.returncode != 0
    if failed != expect_error:
        raise AssertionError('expected %s, got rc=%d\nSQL: %s\nERR: %s' % (
            'an error' if expect_error else 'success', p.returncode, sql[:200], p.stderr[-400:]))
    return p.stdout


PRED = """insert into cfb_model_versions(model_version, feature_version, trained_through)
  values ('t_v', 'fv', 2025) on conflict do nothing;
insert into cfb_predictions(game_id, prediction_ts, model_version, feature_version, season, week, kickoff_ts,
  feature_ts, home_team_id, away_team_id, neutral_site, projected_margin, fair_home_line, home_win_prob, sigma,
  snapshot_hash) values (%d, '2026-09-29T12:00Z', 't_v', 'fv', 2026, 5, '%s', '%s', 1, 2, false, %s, %s, 0.6, 14, 'h');"""


def main():
    if not PG:
        print('skipped: set CFB_V2_PG to a psql connection string')
        return 0
    sql = open(SQL).read()
    out1 = psql(sql)
    out2 = psql(sql)
    assert 'CHECK THIS' not in out1 + out2, 'migration report flagged a check'
    psql("delete from cfb_prediction_intervals where false;")
    gid = 900000 + (os.getpid() % 90000)
    psql(PRED % (gid, '2026-10-03T19:30Z', '2026-09-29T12:00Z', 6.5, -6.5))
    print('ok   insert a pregame prediction')
    psql("update cfb_predictions set projected_margin = 9 where game_id = %d;" % gid, expect_error=True)
    print('ok   a frozen prediction cannot be updated')
    psql("delete from cfb_predictions where game_id = %d;" % gid, expect_error=True)
    print('ok   a prediction cannot be deleted')
    psql(PRED % (gid + 1, '2026-09-29T11:00Z', '2026-09-29T11:00Z', 3, -3), expect_error=True)
    print('ok   prediction at/after kickoff is refused')
    psql(PRED % (gid + 2, '2026-10-03T19:30Z', '2026-09-30T12:00Z', 3, -3), expect_error=True)
    print('ok   feature_ts after prediction_ts is refused')
    psql(PRED % (gid + 3, '2026-10-03T19:30Z', '2026-09-29T12:00Z', 3, 3), expect_error=True)
    print('ok   a fair line with the wrong sign is refused')
    psql("""insert into cfb_market_decisions(game_id, prediction_ts, model_version, decided_at, kickoff_ts,
      pure_fair_margin, status) values (%d, '2026-09-29T12:00Z', 't_v', '2026-10-03T20:00Z', '2026-10-03T19:30Z',
      6.5, 'PASS');""" % gid, expect_error=True)
    print('ok   a market decision after kickoff is refused')
    psql("""insert into cfb_market_decisions(game_id, prediction_ts, model_version, decided_at, kickoff_ts,
      pure_fair_margin, status) values (%d, '2026-09-29T12:00Z', 't_v', '2026-10-01T20:00Z', '2026-10-03T19:30Z',
      6.5, 'PASS');""" % gid)
    print('ok   a pregame market decision is stored beside (not inside) the pure projection')
    out = psql("""insert into cfb_market_snapshots(game_id, captured_at, book, home_line, source)
      values (%d, now(), 'test', -7, 'test') returning home_margin;""" % gid)
    assert out.strip().startswith('7'), out
    print('ok   book -7 is stored as home margin +7 by the database')
    psql("""insert into cfb_model_training_snapshots(game_id, prediction_ts, feature_version, season, features)
      values (%d, '2026-09-29T12:00Z', 'fv', 2026, '{"edge_epa": 1}');""" % gid)
    psql("update cfb_model_training_snapshots set final_home_points = 30, final_away_points = 20 where game_id = %d;" % gid)
    print('ok   outcomes may be filled once after the game')
    psql("update cfb_model_training_snapshots set features = '{\"edge_epa\": 2}' where game_id = %d;" % gid,
         expect_error=True)
    print('ok   frozen training features cannot be rewritten')
    psql("update cfb_model_training_snapshots set final_home_points = 31 where game_id = %d;" % gid, expect_error=True)
    print('ok   an outcome cannot be rewritten')
    psql("update cfb_model_versions set params = '{\"x\":1}' where model_version = 't_v';", expect_error=True)
    psql("update cfb_model_versions set is_shadow = false where model_version = 't_v';")
    print('ok   a model version only changes its flags')
    print('all SQL trigger checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())

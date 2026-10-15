"""The weekly engine's committed state: append-only JSON Lines under
football/cfb_weekly/<season>/ (mirrored insert-only to Postgres).

EXACTLY ONCE. A state row has a natural key (e.g. team x season x week x
feature_version). The first write of a key is state_version 1. Writing the
same content again is a no-op, so an idempotent re-run adds nothing. Writing
DIFFERENT content for a key that already exists (a provider corrected the
play-by-play) appends state_version n+1 with `supersedes` and `reason`. The
old row stays, because a prediction may have depended on it. Nothing is ever
edited or deleted, with one exception: Store.compact drops a version that
changed nothing (the database mirror keeps it).
"""
import json
import os

from . import ids
from .sources import REPO

ROOT = os.path.join(REPO, 'football', 'cfb_weekly')

# kind -> (file, id field, natural-key fields, id prefix)
KINDS = {
    'runs': ('runs.jsonl', 'run_id', None, None),
    'game_validation': ('game_validation.jsonl', 'validation_id', ('game_id', 'rule_version'), 'cfbv_'),
    'game_performance': ('game_performance.jsonl', 'performance_id', ('game_id', 'team_id', 'rule_version'), 'cfbg_'),
    'team_week_state': ('team_week_state.jsonl', 'state_id', ('team_id', 'season', 'week', 'feature_version'), 'cfbs_'),
    'qb_week_state': ('qb_week_state.jsonl', 'qb_state_id', ('player_id', 'team_id', 'season', 'week', 'feature_version'), 'cfbq_'),
    'unit_week_state': ('unit_week_state.jsonl', 'unit_state_id', ('team_id', 'season', 'week', 'unit', 'rule_version'), 'cfbu_'),
    'qb_events': ('qb_events.jsonl', 'event_id', None, None),
    'projections': ('projections.jsonl', 'projection_id', None, None),
    'projection_changes': ('projection_changes.jsonl', 'change_id', None, None),
    'research': ('research.jsonl', 'item_id', None, None),
    'misses': ('misses.jsonl', 'miss_id', None, None),
}
# fields that never make two versions "different" (provenance, not content)
# (the source versions are provenance too: a re-run on a newer data version that computes the same
#  state writes nothing; the record keeps the versions it was first computed from)
PROVENANCE = {'run_id', 'computed_at', 'state_version', 'supersedes', 'reason', 'content_hash', 'recorded_at',
              'data_version', 'pbp_version', 'roster_version', 'injury_version'}
# per kind: the instant a row was computed at, and what follows from that
# instant alone, are provenance too. They move on every run, so as content they
# made every daily run append a "provider correction" of every key: 23 copies
# of each game's validation, 100 MB, and GitHub refused the push (2026-10-15).
# (team and QB state keep as_of as content: it is the week's freeze, and the
#  next week's build reads it back as T_prev.)
VOLATILE = {
    'game_validation': ('validated_at',),
    'game_performance': ('as_of',),
    'unit_week_state': ('as_of', 'status_age_hours'),
}


def content_hash(kind, row):
    """The hash two versions of a key are compared by: the row without its id,
    provenance or volatile fields. Recomputed from a stored row, it equals the
    stored content_hash for every kind without volatile fields."""
    skip = PROVENANCE | set(VOLATILE.get(kind, ())) | {KINDS[kind][1]}
    return ids.content_hash({k: v for k, v in row.items() if k not in skip})


def season_dir(season, root=None):
    return os.path.join(root or ROOT, str(season))


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def append_jsonl(path, rows):
    if not rows:
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a') as f:
        for r in rows:
            f.write(json.dumps(ids.clean(r), sort_keys=True, separators=(',', ':')) + '\n')
    return len(rows)


class Store:
    def __init__(self, season, root=None):
        self.season = season
        self.dir = season_dir(season, root)

    def path(self, kind):
        return os.path.join(self.dir, KINDS[kind][0])

    def read(self, kind):
        return read_jsonl(self.path(kind))

    def append_unique(self, kind, rows):
        """Append rows whose id is new (write-once facts: runs, projections, changes)."""
        idf = KINDS[kind][1]
        have = {r[idf] for r in self.read(kind)}
        fresh, seen = [], set()
        for r in rows:
            if r[idf] in have or r[idf] in seen:
                continue
            seen.add(r[idf])
            fresh.append(r)
        return append_jsonl(self.path(kind), fresh)

    def write_versioned(self, kind, rows, reason='provider correction'):
        """Exactly-once state with explicit correction versions (see module doc).
        Returns {'written', 'unchanged', 'corrected'}."""
        _, idf, key_fields, prefix = KINDS[kind]
        current = {}
        for r in self.read(kind):
            k = tuple(r.get(f) for f in key_fields)
            if k not in current or r.get('state_version', 1) > current[k].get('state_version', 1):
                current[k] = r
        out, stats = [], {'written': 0, 'unchanged': 0, 'corrected': 0}
        for r in rows:
            r = dict(r)
            k = tuple(r.get(f) for f in key_fields)
            ch = content_hash(kind, r)
            prev = current.get(k)
            # the stored version is re-hashed, not trusted: rows written before
            # VOLATILE carry a content_hash that includes the volatile fields
            if prev is not None and content_hash(kind, prev) == ch:
                stats['unchanged'] += 1
                continue
            ver = (prev.get('state_version', 1) + 1) if prev else 1
            r['state_version'] = ver
            r['supersedes'] = prev[idf] if prev else None
            r['reason'] = reason if prev else None
            r['content_hash'] = ch
            r[idf] = prefix + ids.h(*k, ver)
            out.append(r)
            current[k] = r
            stats['corrected' if prev else 'written'] += 1
        append_jsonl(self.path(kind), out)
        return stats

    def compact(self, kind):
        """Drop the versions that changed nothing: per key, a version whose
        content equals the next version's goes, so the newest of each run of
        identical versions stays. Kept lines are copied byte for byte, so
        current() and the next state_version are unchanged, and a version the
        database already holds is never numbered again. The database mirror is
        insert-only and keeps every version. Returns {'kept', 'dropped'}."""
        _, _, key_fields, _ = KINDS[kind]
        path = self.path(kind)
        if not key_fields or not os.path.exists(path):
            return {'kept': 0, 'dropped': 0}
        with open(path) as f:
            lines = [l for l in f if l.strip()]
        rows = [json.loads(l) for l in lines]
        by_key = {}
        for i, r in enumerate(rows):
            by_key.setdefault(tuple(r.get(f) for f in key_fields), []).append(i)
        drop = set()
        for idx in by_key.values():
            idx = sorted(idx, key=lambda i: rows[i].get('state_version', 1))
            for a, b in zip(idx, idx[1:]):
                if content_hash(kind, rows[a]) == content_hash(kind, rows[b]):
                    drop.add(a)
        if drop:
            tmp = path + '.tmp'
            with open(tmp, 'w') as f:
                f.writelines(l if l.endswith('\n') else l + '\n' for i, l in enumerate(lines) if i not in drop)
            os.replace(tmp, path)
        return {'kept': len(lines) - len(drop), 'dropped': len(drop)}

    def current(self, kind):
        """The newest version of every key."""
        _, idf, key_fields, _ = KINDS[kind]
        cur = {}
        for r in self.read(kind):
            k = tuple(r.get(f) for f in key_fields) if key_fields else r[idf]
            if k not in cur or r.get('state_version', 1) >= cur[k].get('state_version', 1):
                cur[k] = r
        return list(cur.values())

    def write_json(self, name, obj):
        p = os.path.join(self.dir, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            json.dump(ids.clean(obj), f, indent=1, sort_keys=True)
            f.write('\n')
        return p


if __name__ == '__main__':
    # python3 -m v2.weekly.store --compact [--season 2026]: drop the no-change
    # versions from the committed ledgers (see Store.compact)
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--compact', action='store_true', required=True)
    ap.add_argument('--season', type=int, default=None)
    a = ap.parse_args()
    seasons = [a.season] if a.season else sorted(int(d) for d in os.listdir(ROOT) if d.isdigit())
    for s in seasons:
        st = Store(s)
        for kind in KINDS:
            if KINDS[kind][2]:
                print(json.dumps({'season': s, 'kind': kind, **st.compact(kind)}, sort_keys=True))

"""The weekly engine's committed state: append-only JSON Lines under
football/cfb_weekly/<season>/ (mirrored insert-only to Postgres).

EXACTLY ONCE. A state row has a natural key (e.g. team x season x week x
feature_version). The first write of a key is state_version 1. Writing the
same content again is a no-op, so an idempotent re-run adds nothing. Writing
DIFFERENT content for a key that already exists (a provider corrected the
play-by-play) appends state_version n+1 with `supersedes` and `reason`. The
old row stays, because a prediction may have depended on it. Nothing is ever
edited or deleted.
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
}
# fields that never make two versions "different" (provenance, not content)
PROVENANCE = {'run_id', 'computed_at', 'state_version', 'supersedes', 'reason', 'content_hash', 'recorded_at'}


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
            ch = ids.content_hash({kk: v for kk, v in r.items() if kk not in PROVENANCE and kk != idf})
            prev = current.get(k)
            if prev is not None and prev.get('content_hash') == ch:
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

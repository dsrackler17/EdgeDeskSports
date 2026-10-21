"""The version history of one sport's model: which configuration is served,
every version that was ever promoted, why, and on what evidence.

docs/model-loop/<sport>/versions.json is the source of truth (committed, so
every change is reviewable and any version can be restored by pointing
`current` back at it); the research registry (research_model_versions /
research_model_results) mirrors it.

Versions are immutable. A promotion appends a new version and moves
`current`; a rollback moves `current` back. Nothing is ever edited in place.
"""
import json
import os
import time

from .walkforward import content_hash


class Versions:
    def __init__(self, path):
        self.path = path
        with open(path) as f:
            self.doc = json.load(f)

    @classmethod
    def create(cls, path, sport, first):
        doc = {"schema": "edgedesk_model_loop_versions_v1", "sport": sport, "current": first["version"], "versions": [first]}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(doc, f, indent=1)
        return cls(path)

    @property
    def current(self):
        return self.get(self.doc["current"])

    def get(self, version):
        for v in self.doc["versions"]:
            if v["version"] == version:
                return v
        raise KeyError(version)

    def next_version(self):
        major, minor, *_ = (self.doc["current"].split("-")[0].split(".") + ["0", "0"])[:3]
        taken = {v["version"] for v in self.doc["versions"]}
        m = int(minor) + 1
        while f"{major}.{m}.0" in taken:
            m += 1
        return f"{major}.{m}.0"

    def promote(self, cfg, reason, evidence, promoted_by="weekly-loop", status="SERVED"):
        v = {"version": self.next_version(), "parent": self.doc["current"], "config": cfg,
             "config_sha256": content_hash(cfg), "status": status, "promoted_by": promoted_by,
             "promoted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "reason": reason, "evidence": evidence}
        for old in self.doc["versions"]:
            if old.get("status") == "SERVED":
                old["status"] = "RETIRED (rollback target)"
        self.doc["versions"].append(v)
        self.doc["current"] = v["version"]
        self.save()
        return v

    def rollback(self, version, reason):
        self.get(version)
        self.doc.setdefault("rollbacks", []).append({"from": self.doc["current"], "to": version, "reason": reason,
                                                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        for v in self.doc["versions"]:
            v["status"] = "SERVED" if v["version"] == version else ("RETIRED (rollback target)" if v.get("status") == "SERVED" else v.get("status"))
        self.doc["current"] = version
        self.save()

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.doc, f, indent=1)

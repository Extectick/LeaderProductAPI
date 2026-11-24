#!/usr/bin/env python3
"""One maintenance pass. SQL is static and runs inside the selected database container."""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import subprocess

BASE = Path(__file__).resolve().parent
TARGETS = {
    "prod": ("leader_postgres_prod", "LeaderAPI"),
    "copy": (os.environ.get("LEADER_AUDIT_COPY_CONTAINER", "leader-audit-table-copy"), "lp_audit_copy"),
}

def query(target, sql):
    container, database = TARGETS[target]
    cmd = ["docker", "exec", "-i", container, "sh", "-ec",
           'exec psql -XqAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"', "sh", database]
    return subprocess.run(cmd, input=sql, text=True, capture_output=True, timeout=20, check=True).stdout.strip()

def main():
    args = argparse.ArgumentParser()
    args.add_argument("target", choices=TARGETS)
    args.add_argument("action", choices=["sample", "maintain"])
    args.add_argument("--state", type=Path, required=True)
    cfg = args.parse_args()
    os.umask(0o077)
    now = datetime.now(timezone.utc)
    state = cfg.state / cfg.target
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    sample = json.loads(query(cfg.target, (BASE / "table-health.sql").read_text()))
    removed = 0
    if cfg.action == "maintain":
        sql = (BASE / "expire-tokens.sql").read_text()
        for _ in range(32):
            n = int(query(cfg.target, sql))
            removed += n
            if n < 500:
                break
    sample["expiredTokensRemovedThisPass"] = removed
    path = state / (now.date().isoformat() + ".json")
    tmp = state / (path.stem + "." + str(os.getpid()) + ".tmp")
    try:
        tmp.write_text(json.dumps(sample, separators=(",", ":")) + "\n")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)
    for previous in state.glob("????-??-??.json"):
        try:
            day = datetime.strptime(previous.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < now.date() - timedelta(days=180):
            previous.unlink()
    print(json.dumps({"tableCount":len(sample["tables"]), "databaseBytes":sample["databaseBytes"], "expiredTokensRemoved":removed}))

if __name__ == "__main__":
    main()

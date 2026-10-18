#!/usr/bin/env python3
"""Query project code memory like `pcm.py query`, but keep stale records for the gateway to refresh."""

import sys
from pathlib import Path

# Importing pcm must not leave __pycache__ inside the installed skill, even without -B.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pcm  # noqa: E402

prune = pcm.prune_record


def keep_stale(records, path, identifier):
    # A record that still loads under its own id is only stale: the gateway refreshes or deletes it.
    # Unreadable, malformed or orphaned records are still pruned as before.
    try:
        if pcm.load_record(path)["id"] == identifier:
            return
    except pcm.MemoryError:
        pass
    prune(records, path, identifier)


pcm.prune_record = keep_stale
sys.argv.insert(1, "query")
raise SystemExit(pcm.main())

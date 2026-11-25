#!/usr/bin/env python3
"""Print the CodeArts model catalog this account is entitled to.

The CodeArts desktop app caches the agent-center config response in its
Electron `state.vscdb` (key `huaweicloud.codearts-snap`). That cached document
is what the app itself uses to populate its model picker, so it is the
authoritative local copy of `user_model_list`.

Output is a JSON array of `{id, name, contextWindow, maxTokens,
supportsImages, agents}` sorted by model id — the same field set
`DEFAULT_MODELS` in `lib/index.js` declares, so the two can be diffed directly.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

STATE_DB = os.path.expandvars(
    r"%APPDATA%\codearts-agent\User\globalStorage\state.vscdb"
)
SNAP_ROW = "huaweicloud.codearts-snap"
CONFIG_ROW = "hc-plugin-config-key"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def load_snap() -> dict:
    if not os.path.exists(STATE_DB):
        fail(f"CodeArts state database not found: {STATE_DB}")
    connection = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT value FROM ItemTable WHERE key = ?", (SNAP_ROW,)
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        fail(f"no '{SNAP_ROW}' row in the CodeArts state database")
    return json.loads(row[0])


def iter_models(snap: dict):
    """Yield `(agent, model)` pairs from the cached per-agent plugin config."""
    entries = snap.get(CONFIG_ROW)
    if not isinstance(entries, list):
        fail(f"'{CONFIG_ROW}' is missing or not a list")

    for entry in entries:
        config = entry.get("config")
        # The cached value is a JSON string inside the already-parsed document.
        if isinstance(config, str):
            try:
                config = json.loads(config)
            except json.JSONDecodeError:
                continue
        if not isinstance(config, list):
            continue

        for agent_config in config:
            if not isinstance(agent_config, dict):
                continue
            agent = agent_config.get("agent")
            for model in agent_config.get("user_model_list") or []:
                if isinstance(model, dict):
                    yield agent, model


def main() -> None:
    snap = load_snap()

    # The same model is published under several agents (CodeAgent, InLineChat,
    # Pangu_Doer_in_CodeArts) with identical parameters, so collapse by id and
    # keep the agent names for diagnostics.
    merged: dict[str, dict] = {}
    for agent, model in iter_models(snap):
        model_id = model.get("model_id") or model.get("model_name")
        if not model_id:
            continue
        slot = merged.setdefault(
            model_id,
            {
                "id": model_id,
                "name": model.get("model_name") or model_id,
                "contextWindow": model.get("context_window"),
                "maxTokens": model.get("max_tokens"),
                "supportsImages": bool(model.get("supports_images")),
                "agents": [],
            },
        )
        if agent and agent not in slot["agents"]:
            slot["agents"].append(agent)

    print(json.dumps(sorted(merged.values(), key=lambda m: m["id"]), indent=2))


if __name__ == "__main__":
    main()

"""
Even Crop — state storage utilities (shared)

This module centralizes reading/writing the Brain state JSON and applies
lightweight migrations so older files keep working as we add fields.

NOTE: The current `brain/server.py` carries its own minimal state helpers
so it can run standalone. This module is drop-in compatible; you can
switch server.py to `from .state_store import *` if you prefer a single
source of truth.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
STATE_PATH = DATA_DIR / "state.json"
BACKUP_PATH = DATA_DIR / "state.backup.json"

# ---------------------------
# Defaults & migrations
# ---------------------------

def _default_units() -> List[Dict[str, Any]]:
    out = []
    for i in range(11):
        out.append({
            "id": i+1,
            "enabled": i < 4,                 # first 4 enabled by default
            "group": "A" if (i % 2 == 0) else "B",
            "momentary": "M1",
            "offset": 0,                      # legacy % (0..100)
            "perDelayMs": 0,                  # NEW: per-unit delay in ms
            "lastDeliveredMl": None,
            "deviation": None,                # float (0..1) or None
            "status": "OK",
            "pulsesPerCycle": 100,
            "msPerMl": 5.0,
            "mode": "inherit"                 # inherit|flow|timed
        })
    return out

def default_state() -> Dict[str, Any]:
    return {
        "targetMl": 100,
        "running": False,
        "deliveryMode": "flow",              # flow|timed
        "momentary": { "M1":{"enabled":True,"offset":0},
                       "M2":{"enabled":False,"offset":0},
                       "M3":{"enabled":False,"offset":0} },
        "tramline": {},                      # {unitId: true} => temp OFF
        "tramPresets": {"left":[], "right":[], "active": None},
        "buzzer": {"muted": False, "hardMute": False},
        "autoDelay": { "enabled": True, "manualMs": 500, "geomLeadMs": 0, "currentMs": 500 },
        "units": _default_units(),
        "eventLog": [],
        "pressHistory": [],                  # timestamps of last M-presses (for auto Δ)
        "simulation": {"telemetry": False, "full": False},
        "gpio": {}                           # optional pin mapping
    }

def _migrate(st: Dict[str, Any]) -> Dict[str, Any]:
    # Ensure keys exist
    st.setdefault("targetMl", 100)
    st.setdefault("running", False)
    st.setdefault("deliveryMode", "flow")
    st.setdefault("momentary", { "M1":{"enabled":True,"offset":0},
                                 "M2":{"enabled":False,"offset":0},
                                 "M3":{"enabled":False,"offset":0} })
    st.setdefault("tramline", {})
    st.setdefault("tramPresets", {"left":[], "right":[], "active": None})
    st.setdefault("buzzer", {"muted": False, "hardMute": False})
    st.setdefault("autoDelay", { "enabled": True, "manualMs": 500, "geomLeadMs": 0, "currentMs": 500 })
    st.setdefault("units", _default_units())
    st.setdefault("eventLog", [])
    st.setdefault("pressHistory", [])
    st.setdefault("simulation", {"telemetry": False, "full": False})
    st.setdefault("gpio", {})

    # Per-unit fields
    for u in st.get("units", []):
        u.setdefault("enabled", True)
        u.setdefault("group", "A")
        u.setdefault("momentary", "M1")
        u.setdefault("offset", 0)
        u.setdefault("perDelayMs", 0)
        u.setdefault("lastDeliveredMl", None)
        u.setdefault("deviation", None)
        u.setdefault("status", "OK")
        u.setdefault("pulsesPerCycle", 100)
        u.setdefault("msPerMl", 5.0)
        u.setdefault("mode", "inherit")

    # Auto delay current value
    ad = st["autoDelay"]
    if "currentMs" not in ad:
        ad["currentMs"] = int(ad.get("manualMs", 500))

    return st

# ---------------------------
# IO helpers
# ---------------------------

def save_state_atomic(st: Dict[str, Any], path: Path = STATE_PATH):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    data = json.dumps(st, indent=2)
    tmp.write_text(data)
    # Best effort backup
    try:
        if path.exists():
            shutil.copy2(path, BACKUP_PATH)
    except Exception:
        pass
    tmp.replace(path)

def load_state(path: Path = STATE_PATH) -> Dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            st = json.loads(path.read_text())
            st = _migrate(st)
            save_state_atomic(st, path)  # write back normalized
            return st
        except Exception as e:
            # Try backup before giving up
            try:
                if BACKUP_PATH.exists():
                    st = json.loads(BACKUP_PATH.read_text())
                    st = _migrate(st)
                    save_state_atomic(st, path)
                    return st
            except Exception:
                pass
            print("state_store: load error, resetting:", e)
    st = default_state()
    save_state_atomic(st, path)
    return st

def log_event(st: Dict[str, Any], msg: str, max_keep: int = 100):
    st.setdefault("eventLog", [])
    st["eventLog"].append({"t": int(time.time()*1000), "msg": msg})
    if len(st["eventLog"]) > max_keep:
        st["eventLog"] = st["eventLog"][-max_keep:]
    save_state_atomic(st)

# Convenience helpers (optional use)
def get_state() -> Dict[str, Any]:
    return load_state()

def set_value(key: str, value: Any):
    st = load_state()
    st[key] = value
    save_state_atomic(st)

def update_state(patch: Dict[str, Any]):
    st = load_state()
    st.update(patch or {})
    save_state_atomic(st)

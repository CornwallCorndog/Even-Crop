"""
Even Crop — profiles helper

Lightweight helpers to save/load named profiles under ../data/profiles.
A "profile" is a subset of the full runtime state: only the persistent
configuration needed to reproduce behavior (units, modes, offsets, target,
auto-delay config, GPIO mapping, etc). Ephemeral things like eventLog or
pressHistory are excluded.

This module is optional: server.py can call these functions directly or
you can wire them behind HTTP endpoints later if desired.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
PROF_DIR = DATA_DIR / "profiles"
PROF_DIR.mkdir(parents=True, exist_ok=True)

PROFILE_KEYS = [
    "targetMl",
    "deliveryMode",
    "momentary",
    "autoDelay",
    "units",
    "gpio",
]

# ----- utilities -----

def _strip_runtime(state: Dict[str, Any]) -> Dict[str, Any]:
    """Return only the configuration parts of state."""
    out = {}
    for k in PROFILE_KEYS:
        if k in state:
            out[k] = state[k]
    # Ensure units do not carry volatile readings
    for u in out.get("units", []):
        u.pop("lastDeliveredMl", None)
        u.pop("deviation", None)
        u.pop("status", None)
    return out

def _sanitize_name(name: str) -> str:
    safe = "".join(c for c in name if c.isalnum() or c in ("-", "_", " ", ".")).strip()
    return safe or "profile"

def profile_path(name: str) -> Path:
    return PROF_DIR / f"{_sanitize_name(name)}.json"

# ----- public API -----

def list_profiles() -> List[str]:
    """Return list of profile basenames (without extension)."""
    out: List[str] = []
    for p in sorted(PROF_DIR.glob("*.json")):
        out.append(p.stem)
    return out

def save_profile(name: str, state: Dict[str, Any]) -> Path:
    """Save configuration subset to a profile file. Returns path."""
    p = profile_path(name)
    p.write_text(json.dumps(_strip_runtime(state), indent=2), encoding="utf-8")
    return p

def load_profile(name: str) -> Dict[str, Any]:
    """Load a profile and return its dict. Raises FileNotFoundError if missing."""
    p = profile_path(name)
    data = json.loads(p.read_text(encoding="utf-8"))
    # Basic shape guards
    data.setdefault("targetMl", 100)
    data.setdefault("deliveryMode", "flow")
    data.setdefault("momentary", {"M1":{"enabled":True,"offset":0},
                                  "M2":{"enabled":False,"offset":0},
                                  "M3":{"enabled":False,"offset":0}})
    data.setdefault("autoDelay", {"enabled":True,"manualMs":500,"geomLeadMs":0,"currentMs":500})
    data.setdefault("units", [])
    data.setdefault("gpio", {})
    return data

def apply_profile(state: Dict[str, Any], prof: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge a profile dict into the live state (in place) and return state.
    Only profile keys are updated; event log / tramline / runtime flags are left intact.
    """
    for k in PROFILE_KEYS:
        if k in prof:
            state[k] = prof[k]
    # Normalize currentMs based on enabled/manual if missing
    ad = state.get("autoDelay", {})
    if "currentMs" not in ad:
        ad["currentMs"] = int(ad.get("manualMs", 500))
    state["autoDelay"] = ad
    return state

def delete_profile(name: str) -> bool:
    """Delete a profile; returns True if removed."""
    p = profile_path(name)
    if p.exists():
        p.unlink()
        return True
    return False

# ----- example CLI -----
if __name__ == "__main__":
    import argparse, sys, json
    ap = argparse.ArgumentParser(description="Even Crop profiles")
    ap.add_argument("cmd", choices=["list","save","load","delete"])
    ap.add_argument("--name", help="profile name")
    ap.add_argument("--state", help="path to state.json when saving (defaults to ../data/state.json)")
    args = ap.parse_args()

    if args.cmd == "list":
        print("\n".join(list_profiles()))
        sys.exit(0)

    if args.cmd == "delete":
        if not args.name: ap.error("--name is required for delete")
        ok = delete_profile(args.name)
        print("deleted" if ok else "not-found")
        sys.exit(0)

    if args.cmd == "save":
        if not args.name: ap.error("--name is required for save")
        src = Path(args.state) if args.state else (DATA_DIR / "state.json")
        st = json.loads(src.read_text(encoding="utf-8"))
        p = save_profile(args.name, st)
        print("saved:", p)
        sys.exit(0)

    if args.cmd == "load":
        if not args.name: ap.error("--name is required for load")
        prof = load_profile(args.name)
        print(json.dumps(prof, indent=2))
        sys.exit(0)

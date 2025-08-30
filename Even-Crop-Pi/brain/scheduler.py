"""
Even Crop — cycle timing scheduler

This module computes WHEN each unit should fire relative to a detected
momentary switch press, given the current pattern, Auto-Diamond B delay,
momentary offsets, and per-unit delay (ms).

It does not talk to GPIO directly; a caller can use the computed schedule
to drive hardware (e.g., io_gpio.open_valve(...) for a duration).

fire_time(unit) = press_time_ms
                + pattern_base_ms(unit)            # e.g., 0 for A, BΔ for B (Diamond)
                + momentary_offset_ms(unit.Mx)     # 0–100% → 0–1000 ms
                + per_unit_delay_ms(unit)          # individual delay (may be negative for B in Diamond)
"""

from dataclasses import dataclass
from typing import Dict, List, Literal, Tuple, Callable, Optional
import time

Pattern = Literal["diamond", "diagonal", "line"]

@dataclass
class UnitState:
    id: int
    enabled: bool
    group: Literal["A","B"]
    momentary: str              # "M1" | "M2" | "M3" | "None"
    offset: int                 # legacy % (0..100), retained for back-compat (not used here)
    perDelayMs: int             # per-unit delay (ms), may be negative for B in Diamond
    mode: Literal["inherit","flow","timed"]
    pulsesPerCycle: int
    msPerMl: float

@dataclass
class MomentaryCfg:
    enabled: bool
    offset: int                 # 0..100 % mapped to 0..1000 ms

@dataclass
class AutoDelay:
    enabled: bool
    manualMs: int
    geomLeadMs: int
    currentMs: int

@dataclass
class BrainStateView:
    targetMl: int
    deliveryMode: Literal["flow","timed"]
    autoDelay: AutoDelay
    momentary: Dict[str, MomentaryCfg]
    units: List[UnitState]

# ---- helpers ----

def _momentary_ms(m: Dict[str, MomentaryCfg], name: str) -> int:
    """Map momentary offset % to ms using 0..100 → 0..1000ms."""
    try:
        cfg = m.get(name or "", None)
        if not cfg: return 0
        pct = max(0, min(100, int(cfg.offset)))
        return int(round(pct * 10))
    except Exception:
        return 0

def _pattern_base_ms(pattern: Pattern, unit: UnitState, auto: AutoDelay, diagonal_step_ms: int = 80) -> int:
    """
    Base delay set by the pattern *before* momentary and per-unit offsets.

    - diamond: A = 0; B = current B delay (auto.currentMs)
    - diagonal: Unit index order 1..N fires with fixed step between units
                (simple default: 80 ms per step; caller can change)
    - line: all 0
    """
    if pattern == "diamond":
        return 0 if unit.group == "A" else max(0, int(auto.currentMs))
    if pattern == "diagonal":
        # Use unit.id ordering for a simple stagger; adjust as needed
        return max(0, (unit.id - 1) * int(diagonal_step_ms))
    # line (simultaneous)
    return 0

def _inherit_mode(global_mode: str, unit_mode: str) -> str:
    return unit_mode if unit_mode in ("flow","timed") else global_mode

# ---- public scheduler ----

class Scheduler:
    """
    Pure timing planner.

    supply:
      - state_fn() -> BrainStateView   # live state snapshot supplier
      - pattern: "diamond" | "diagonal" | "line"

    use:
      plan = sched.plan_cycle(now_ms=ms(), pressed_m="M1")
      -> list of schedule entries for enabled/non-tramlined units

    Each entry: (unit_id, start_ms, duration_ms, mode_dict)
      - duration_ms for "timed" is computed from target and msPerMl
      - for "flow", duration_ms may be None; mode contains pulses info:
            {"mode":"flow", "pulses": int, "target_ml": int}
    """

    def __init__(self,
                 state_fn: Callable[[], BrainStateView],
                 tramline_off_fn: Callable[[int], bool],
                 pattern: Pattern = "diamond"):
        self._state_fn = state_fn
        self._tram_off = tramline_off_fn
        self._pattern: Pattern = pattern

    def set_pattern(self, p: Pattern):
        self._pattern = p

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _unit_fire_ms(self, base_ms: int, unit: UnitState, st: BrainStateView) -> int:
        base = _pattern_base_ms(self._pattern, unit, st.autoDelay)
        mom = _momentary_ms(st.momentary, unit.momentary)
        per = int(unit.perDelayMs or 0)

        # Diamond rule: B cannot advance earlier than A (not negative beyond -BΔ)
        # Assume UI already clamps perDelayMs, but re-safety here:
        if self._pattern == "diamond" and unit.group == "B":
            min_neg = -max(0, int(st.autoDelay.currentMs))
            if per < min_neg: per = min_neg
        if self._pattern == "diamond" and unit.group == "A":
            if per < 0: per = 0

        return base_ms + base + mom + per

    def _duration_and_mode(self, unit: UnitState, st: BrainStateView) -> Tuple[Optional[int], Dict]:
        target = max(1, int(getattr(st, "targetMl", 100)))
        mode = _inherit_mode(st.deliveryMode, unit.mode)

        if mode == "timed":
            ms_per_ml = max(0.1, float(unit.msPerMl or 5.0))
            dur = int(round(target * ms_per_ml))
            return dur, {"mode":"timed", "ms_per_ml": ms_per_ml, "target_ml": target}
        else:
            # flow: hardware layer will count pulses; we provide desired pulses/cycle
            pulses = max(1, int(unit.pulsesPerCycle or 100))
            return None, {"mode":"flow", "pulses": pulses, "target_ml": target}

    def plan_cycle(self, now_ms: Optional[int] = None, pressed_m: Optional[str] = None) -> List[Tuple[int,int,Optional[int],Dict]]:
        """
        Returns a list of tuples:
          (unit_id, start_ms, duration_ms, mode_dict)

        Only includes units that are enabled and not temporarily OFF (tramline).
        """
        st = self._state_fn()
        t0 = now_ms if now_ms is not None else self._now_ms()
        out: List[Tuple[int,int,Optional[int],Dict]] = []

        for u in st.units:
            if not u.enabled:
                continue
            if self._tram_off(u.id):
                continue
            # If a specific momentary pressed filter is required, skip non-matching units:
            if pressed_m and u.momentary and u.momentary != pressed_m:
                # If the press is physically per-row, you may want this filter true;
                # if press is global/virtual, ignore this condition.
                pass

            start_ms = self._unit_fire_ms(t0, u, st)
            duration_ms, mode_info = self._duration_and_mode(u, st)
            out.append((u.id, start_ms, duration_ms, mode_info))

        # stable order by start time then unit id
        out.sort(key=lambda e: (e[1], e[0]))
        return out

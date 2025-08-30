"""
Even Crop — GPIO abstraction layer

This module isolates all hardware I/O so the rest of the Brain can run
unchanged on a dev laptop (mock) or on a Raspberry Pi (real).

It AUTO-DETECTS environment and falls back to a safe mock if RPi libs are
missing. You can also force mock by setting EVENCROP_GPIO=mock.

Features used by the Brain:
- configure mapping for:
    • FlowMeter input (count pulses)
    • Buzzer output (on/off beep)
    • Momentary switches M1/M2/M3 (read edges / debounce)
    • Unit outputs (1..11) (open valve for duration)
- simple async helpers to:
    • read switches
    • count flow pulses
    • drive unit outputs for a duration (non-blocking)
    • buzz

This is a lean reference implementation — adapt as needed (e.g., add
hardware current limiting, relays, opto, etc).
"""
from __future__ import annotations

import os
import time
import asyncio
from typing import Dict, Optional, Callable, Any, List

# -----------------------------------------------------------------------------
# Backend selection
# -----------------------------------------------------------------------------
_FORCE = os.environ.get("EVENCROP_GPIO", "").lower().strip()
try:
    if _FORCE != "mock":
        import RPi.GPIO as RGPIO  # type: ignore
        _HAVE_RPI = True
    else:
        _HAVE_RPI = False
except Exception:
    _HAVE_RPI = False


# -----------------------------------------------------------------------------
# Base interface
# -----------------------------------------------------------------------------
class BaseGPIO:
    def __init__(self):
        self.mapping: Dict[str, Any] = {
            "flow": None,     # flow meter pin
            "buzzer": None,   # buzzer pin
            "M1": None, "M2": None, "M3": None,  # momentary inputs
            "units": {}       # {unit_id: pin}
        }
        self._loop = asyncio.get_event_loop()
        self._pulse_count = 0
        self._switch_state: Dict[str, bool] = {"M1": False, "M2": False, "M3": False}
        self._tasks: List[asyncio.Task] = []

    # ----- lifecycle -----
    async def start(self): ...
    async def stop(self):
        # cancel all pending output tasks
        for t in list(self._tasks):
            t.cancel()
        self._tasks.clear()

    # ----- mapping -----
    def set_mapping(self, name: str, pin: int):
        """Set a single mapping key -> pin. name in {'flow','buzzer','M1','M2','M3'} or 'unit:<id>'."""
        if name.startswith("unit:"):
            uid = int(name.split(":")[1])
            self.mapping["units"][uid] = pin
        elif name in ("flow", "buzzer", "M1", "M2", "M3"):
            self.mapping[name] = pin

    # ----- inputs -----
    async def read_switch(self, name: str) -> bool:
        """Return debounced state for M1/M2/M3 (True when pressed)."""
        return bool(self._switch_state.get(name, False))

    def get_pulses_and_reset(self) -> int:
        """Return accumulated flow meter pulses and reset counter."""
        c = self._pulse_count
        self._pulse_count = 0
        return c

    # ----- outputs -----
    async def open_unit_for(self, unit_id: int, ms: int):
        """Open a unit output for ms milliseconds (non-blocking)."""
        # Default: fire a mock task; subclasses override for real GPIO
        async def _job():
            await asyncio.sleep(ms / 1000.0)
        task = self._loop.create_task(_job())
        self._tasks.append(task)
        def _done(_): 
            try:
                self._tasks.remove(task)
            except Exception:
                pass
        task.add_done_callback(_done)

    async def buzzer(self, on: bool, ms: Optional[int] = None):
        """Turn buzzer on/off. If ms provided, buzz for duration then off."""
        if ms is None:
            return
        await asyncio.sleep(ms / 1000.0)

    # ----- simulation hooks (mock uses these; real can ignore) -----
    def _simulate_switch_pulse(self, name: str):
        """Simulate a brief press on M1/M2/M3 (for tests)."""
        self._switch_state[name] = True
        # auto release shortly
        self._loop.call_later(0.05, lambda: self._switch_state.__setitem__(name, False))

    def _simulate_flow_pulse(self, n: int = 1):
        self._pulse_count += int(n)


# -----------------------------------------------------------------------------
# Mock implementation
# -----------------------------------------------------------------------------
class MockGPIO(BaseGPIO):
    def __init__(self):
        super().__init__()
        self._running = False

    async def start(self):
        self._running = True
        # no hardware; nothing to set up

    async def stop(self):
        await super().stop()
        self._running = False


# -----------------------------------------------------------------------------
# Raspberry Pi implementation (RPi.GPIO)
# -----------------------------------------------------------------------------
class RPiGPIO(BaseGPIO):
    def __init__(self):
        super().__init__()
        self._chan_setup = False
        self._flow_pin = None

    async def start(self):
        # BCM numbering
        RGPIO.setmode(RGPIO.BCM)
        # Inputs
        for name in ("M1", "M2", "M3"):
            p = self.mapping.get(name)
            if p is not None:
                RGPIO.setup(p, RGPIO.IN, pull_up_down=RGPIO.PUD_UP)
                # Falling edge = pressed, debounce 10 ms
                RGPIO.add_event_detect(p, RGPIO.FALLING, callback=self._mk_switch_cb(name), bouncetime=10)
        # Flow meter input (count pulses)
        self._flow_pin = self.mapping.get("flow")
        if self._flow_pin is not None:
            RGPIO.setup(self._flow_pin, RGPIO.IN, pull_up_down=RGPIO.PUD_UP)
            RGPIO.add_event_detect(self._flow_pin, RGPIO.FALLING, callback=self._flow_cb, bouncetime=1)
        # Outputs
        bz = self.mapping.get("buzzer")
        if bz is not None:
            RGPIO.setup(bz, RGPIO.OUT, initial=RGPIO.LOW)
        for uid, pin in self.mapping["units"].items():
            RGPIO.setup(pin, RGPIO.OUT, initial=RGPIO.LOW)

    async def stop(self):
        await super().stop()
        try:
            RGPIO.cleanup()
        except Exception:
            pass

    # ---- callbacks ----
    def _mk_switch_cb(self, name: str) -> Callable[[int], None]:
        def _cb(channel_pin: int):
            # Debounced falling edge => pressed True followed by auto release
            self._switch_state[name] = True
            # release after 50 ms
            self._loop.call_later(0.05, lambda: self._switch_state.__setitem__(name, False))
        return _cb

    def _flow_cb(self, channel_pin: int):
        self._pulse_count += 1

    # ---- outputs ----
    async def open_unit_for(self, unit_id: int, ms: int):
        pin = self.mapping["units"].get(unit_id)
        if pin is None:  # silently ignore if not mapped
            await asyncio.sleep(ms / 1000.0)
            return
        RGPIO.output(pin, RGPIO.HIGH)
        try:
            await asyncio.sleep(max(0, ms) / 1000.0)
        finally:
            RGPIO.output(pin, RGPIO.LOW)

    async def buzzer(self, on: bool, ms: Optional[int] = None):
        pin = self.mapping.get("buzzer")
        if pin is None:
            if ms: await asyncio.sleep(ms / 1000.0)
            return
        if ms is None:
            RGPIO.output(pin, RGPIO.HIGH if on else RGPIO.LOW)
            return
        # pulse for ms
        RGPIO.output(pin, RGPIO.HIGH)
        try:
            await asyncio.sleep(max(0, ms) / 1000.0)
        finally:
            RGPIO.output(pin, RGPIO.LOW)


# -----------------------------------------------------------------------------
# Factory
# -----------------------------------------------------------------------------
def make_gpio() -> BaseGPIO:
    if _HAVE_RPI and _FORCE != "mock":
        return RPiGPIO()
    return MockGPIO()


# -----------------------------------------------------------------------------
# Ad-hoc test
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    async def _demo():
        gpio = make_gpio()
        # Example mapping (BCM numbers)
        gpio.set_mapping("buzzer", 18)
        gpio.set_mapping("M1", 23)
        gpio.set_mapping("flow", 24)
        gpio.set_mapping("unit:1", 12)
        await gpio.start()
        print("Buzz 200ms")
        await gpio.buzzer(True, 200)
        print("Open unit 1 for 500ms")
        await gpio.open_unit_for(1, 500)
        print("Sim pulses (mock only)")
        gpio._simulate_flow_pulse(5)
        print("Pulses:", gpio.get_pulses_and_reset())
        await gpio.stop()

    asyncio.run(_demo())

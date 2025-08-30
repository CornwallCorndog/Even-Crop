#!/usr/bin/env python3
"""
Even Crop v1.0 — Brain server
Serves the GUI (static files) and a WebSocket at /ws for live control.

- Static GUI: served from ../gui on port 8000
- WebSocket: /ws
- State file: ../data/state.json (created on first run)

This is a lean, single-file backend that`s enough to exercise the GUI:
  • keeps full configuration/state
  • simulates telemetry and cycles when requested
  • supports the GUI`s “set/*” and tramline/calibration messages
  • computes/streams Auto Diamond B-delay if enabled

For production, you`ll likely split IO, scheduler, and calibration into
modules (see filenames listed in the project tree), but this runs today.
"""

import asyncio, json, os, random, time
from pathlib import Path
from typing import Dict, Any, Set

from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parents[1]
GUI_DIR = ROOT / "gui"
DATA_DIR = ROOT / "data"
STATE_PATH = DATA_DIR / "state.json"

PORT = int(os.environ.get("EVENCROP_PORT", "8000"))

# ---------------------------
# State helpers
# ---------------------------
def default_state() -> Dict[str, Any]:
    units = []
    for i in range(11):
        units.append({
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
            "pulsesPerLiter": 450,
            "msPerMl": 5.0,
            "mode": "inherit"                 # inherit|flow|timed
        })
    st = {
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
        "units": units,
        "eventLog": [],
        "pressHistory": [],                  # timestamps of last M-presses (for auto Δ)
        "simulation": {"telemetry": False, "full": False}
    }
    return st

def load_state() -> Dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if STATE_PATH.exists():
        try:
            st = json.loads(STATE_PATH.read_text())
            # migration: ensure perDelayMs exists
            for u in st.get("units", []):
                if "perDelayMs" not in u:
                    u["perDelayMs"] = 0
            if "tramPresets" not in st:
                st["tramPresets"] = {"left":[], "right":[], "active": None}
            if "buzzer" not in st:
                st["buzzer"] = {"muted": False, "hardMute": False}
            if "pressHistory" not in st:
                st["pressHistory"] = []
            if "simulation" not in st:
                pass
            # add K-factor default per unit
            for u in st.get("units", []):
                if "pulsesPerLiter" not in u:
                    u["pulsesPerLiter"] = 450

                st["simulation"] = {"telemetry": False, "full": False}
            if "autoDelay" in st:
                st["autoDelay"].setdefault("currentMs", st["autoDelay"].get("manualMs", 500))
            else:
                st["autoDelay"] = { "enabled": True, "manualMs": 500, "geomLeadMs": 0, "currentMs": 500 }
            return st
        except Exception as e:
            print("State load error:", e)
    st = default_state()
    save_state(st)
    return st

def save_state(st: Dict[str, Any]):
    try:
        STATE_PATH.write_text(json.dumps(st, indent=2))
    except Exception as e:
        print("State save error:", e)

def log_event(st: Dict[str, Any], msg: str):
    st["eventLog"].append({"t": int(time.time()*1000), "msg": msg})
    if len(st["eventLog"]) > 100:            # keep up to 100 recent
        st["eventLog"] = st["eventLog"][-100:]
    save_state(st)

# ---------------------------
# WebSocket hub
# ---------------------------
class Hub:
    def __init__(self):
        self.clients: Set[web.WebSocketResponse] = set()
        self.state = load_state()
        self._tel_task = None
        self._cyc_task = None
        self._auto_task = None
        self._lock = asyncio.Lock()

    async def start(self, app: web.Application):
        # background tasks
        self._auto_task = asyncio.create_task(self._auto_delay_loop())

    async def stop(self, app: web.Application):
        for t in [self._tel_task, self._cyc_task, self._auto_task]:
            if t:
                t.cancel()
        for ws in list(self.clients):
            await ws.close()

    async def register(self, ws: web.WebSocketResponse):
        self.clients.add(ws)
        # emit current auto delay on join
        await self.send({"type":"auto-delay", "value": self.state["autoDelay"]["currentMs"]}, ws=ws)

    async def unregister(self, ws: web.WebSocketResponse):
        self.clients.discard(ws)

    async def send(self, obj: Dict[str, Any], ws: web.WebSocketResponse=None):
        msg = json.dumps(obj)
        if ws:
            await ws.send_str(msg)
            return
        dead = []
        for c in self.clients:
            try:
                await c.send_str(msg)
            except Exception:
                dead.append(c)
        for d in dead:
            self.clients.discard(d)

    # -----------------------
    # Simulators
    # -----------------------
    async def telemetry_loop(self):
        try:
            while self.state["simulation"]["telemetry"] or self.state["simulation"]["full"]:
                # plausibly varying values
                flow = round(random.uniform(6, 10), 1)
                pressure = round(random.uniform(1.5, 2.7), 1)
                speed = round(random.uniform(5, 10), 1)
                await self.send({"type":"telemetry", "flow":flow, "pressure":pressure, "speed":speed})
                await asyncio.sleep(0.9)
        except asyncio.CancelledError:
            pass

    async def cycle_loop(self):
        try:
            # simulate “switch presses” cadence ~ every 1.0–1.5s
            while self.state["simulation"]["full"]:
                now = time.time()
                # record synthetic press
                self.state["pressHistory"].append(now)
                self.state["pressHistory"] = self.state["pressHistory"][-20:]
                # deliver to enabled & not-tramline units
                target = max(5, int(self.state.get("targetMl", 100)))
                for u in self.state["units"]:
                    if not u["enabled"]: continue
                    if self.state["tramline"].get(str(u["id"])) or self.state["tramline"].get(u["id"]):
                        continue
                    # simulate delivered ml
                    dev = random.uniform(-0.05, 0.05)  # ±5%
                    delivered = max(0, round(target * (1.0 + dev)))
                    u["lastDeliveredMl"] = delivered
                    u["deviation"] = (delivered - target) / max(1, target)
                    # status
                    absd = abs(u["deviation"] or 0.0)
                    if absd <= 0.05:
                        u["status"] = "OK"
                    elif absd <= 0.10:
                        u["status"] = "WARN"
                    elif absd <= 0.15:
                        u["status"] = "INSPECT"
                    else:
                        u["status"] = "BLOCKED"
                save_state(self.state)
                await self.send({"type":"cycle"})
                await asyncio.sleep(random.uniform(1.0, 1.5))
        except asyncio.CancelledError:
            pass

    async def _auto_delay_loop(self):
        try:
            while True:
                await asyncio.sleep(0.5)
                ad = self.state["autoDelay"]
                if not ad.get("enabled", True):
                    # stick to manual, but still publish current=manual+geom
                    cur = int(ad.get("manualMs", 500)) + int(ad.get("geomLeadMs", 0))
                    cur = max(0, cur)
                    if cur != ad.get("currentMs"):
                        ad["currentMs"] = cur
                        save_state(self.state)
                        await self.send({"type":"auto-delay","value":cur})
                    continue
                # derive from recent press cadence
                ph = [p for p in self.state["pressHistory"] if time.time()-p < 15]
                if len(ph) >= 3:
                    intervals = [ (ph[i]-ph[i-1]) for i in range(1,len(ph)) ]
                    avg = sum(intervals)/len(intervals)
                    b = max(0, int(avg*1000/2))  # half the average interval, ms
                else:
                    b = int(ad.get("manualMs", 500))
                b += int(ad.get("geomLeadMs", 0))
                b = max(0, b)
                if b != ad.get("currentMs"):
                    ad["currentMs"] = b
                    save_state(self.state)
                    await self.send({"type":"auto-delay","value":b})
        except asyncio.CancelledError:
            pass

    def _restart_tel_task(self):
        if self._tel_task and not self._tel_task.done():
            self._tel_task.cancel()
        if self.state["simulation"]["telemetry"] or self.state["simulation"]["full"]:
            self._tel_task = asyncio.create_task(self.telemetry_loop())

    def _restart_cyc_task(self):
        if self._cyc_task and not self._cyc_task.done():
            self._cyc_task.cancel()
        if self.state["simulation"]["full"]:
            self._cyc_task = asyncio.create_task(self.cycle_loop())

    # -----------------------
    # Message handling
    # -----------------------
    async def handle_msg(self, m: Dict[str, Any]):
        t = m.get("type")
        if t == "set":
            key = m.get("key")
            # simple setters
            if key == "target":
                self.state["targetMl"] = int(m.get("value", 100))
                save_state(self.state)
                log_event(self.state, f"Target set to {self.state['targetMl']} ml/plant")
            elif key == "running":
                self.state["running"] = bool(m.get("value"))
                save_state(self.state)
                log_event(self.state, "RUN" if self.state["running"] else "STOP")
            elif key == "unit-enabled":
                uid = int(m.get("id"))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["enabled"] = bool(m.get("value"))
                save_state(self.state)
            elif key == "unit-momentary":
                uid = int(m.get("id")); val = m.get("value","M1")
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["momentary"] = val
                save_state(self.state)
            elif key == "unit-group":
                uid = int(m.get("id")); val = m.get("value","A")
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["group"] = "A" if val=="A" else "B"
                save_state(self.state)
            elif key == "unit-offset":
                uid = int(m.get("id")); val = int(m.get("value",0))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["offset"] = max(0, min(100, val))
                save_state(self.state)
            elif key == "unit-delay-ms":
                uid = int(m.get("id")); val = int(m.get("value",0))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["perDelayMs"] = val
                save_state(self.state)
            elif key == "delivery-mode":
                self.state["deliveryMode"] = "timed" if m.get("value")=="timed" else "flow"
                save_state(self.state)
            elif key == "unit-delivery-mode":
                uid = int(m.get("id")); val = m.get("value","inherit")
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["mode"] = val if val in ("inherit","flow","timed") else "inherit"
                save_state(self.state)
            elif key == "unit-ppc":
                uid = int(m.get("id")); val = max(1, int(m.get("value",100)))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["pulsesPerCycle"] = val
                save_state(self.state)
            
            elif key == "unit-kfactor":
                uid = int(m.get("id")); val = max(1, int(m.get("value",450)))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["pulsesPerLiter"] = val
                save_state(self.state)
elif key == "unit-msperml":
                uid = int(m.get("id")); val = max(1, float(m.get("value",5.0)))
                for u in self.state["units"]:
                    if u["id"] == uid:
                        u["msPerMl"] = val
                save_state(self.state)
            elif key == "auto-delay":
                cfg = m.get("value",{})
                ad = self.state["autoDelay"]
                ad["enabled"]   = bool(cfg.get("enabled", ad.get("enabled", True)))
                if "manualMs" in cfg:   ad["manualMs"] = int(cfg["manualMs"])
                if "geomLeadMs" in cfg: ad["geomLeadMs"] = int(cfg["geomLeadMs"])
                # currentMs will be recomputed by loop; broadcast now with best guess
                cur = (ad.get("manualMs",500) if not ad.get("enabled",True) else ad.get("currentMs",500))
                await self.send({"type":"auto-delay","value": int(cur)})
                save_state(self.state)
            elif key == "gpio":
                # store minimal gpio mapping; real hardware layer would apply this
                name = m.get("name"); pin = m.get("pin")
                self.state.setdefault("gpio", {})[name] = pin
                save_state(self.state)
            elif key == "buzzer-muted":
                self.state["buzzer"]["muted"] = bool(m.get("value"))
                save_state(self.state)
            elif key == "buzzer-hardmute":
                self.state["buzzer"]["hardMute"] = bool(m.get("value"))
                save_state(self.state)

        elif t == "tram":
            uid = str(m.get("id"))
            off = bool(m.get("off"))
            self.state["tramline"][uid] = off
            # clean false entries
            for k in list(self.state["tramline"].keys()):
                if not self.state["tramline"][k]:
                    self.state["tramline"].pop(k, None)
            save_state(self.state)
        elif t == "tram-clear":
            self.state["tramline"] = {}
            save_state(self.state)
        elif t == "simulate":
            mode = m.get("mode","telemetry")
            on = bool(m.get("on"))
            if mode == "full":
                self.state["simulation"]["full"] = on
                self._restart_cyc_task()
                # full also implies telemetry
                if on:
                    self.state["simulation"]["telemetry"] = True
                self._restart_tel_task()
            else:
                self.state["simulation"]["telemetry"] = on
                self._restart_tel_task()
            save_state(self.state)
        elif t == "cal":
            # simple acknowledgment / logging so GUI flows; real impl would drive IO
            mode = m.get("mode")
            cmd  = m.get("cmd")
            uid  = m.get("id")
            if mode == "timed" and cmd == "start":
                ms = int(m.get("ms", 5000))
                log_event(self.state, f"Timed calibration start: unit {uid}, {ms} ms")
            elif mode == "timed" and cmd == "stop":
                log_event(self.state, f"Timed calibration stop: unit {uid}")
            elif mode == "flow" and cmd == "start":
                tgt = int(m.get("targetMl", 1000))
                log_event(self.state, f"Flow calibration run: unit {uid}, target {tgt} ml")
            save_state(self.state)

# ---------------------------
# HTTP / Web handlers
# ---------------------------
hub = Hub()

async def ws_handler(request: web.Request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    await hub.register(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    await hub.handle_msg(data)
                except Exception as e:
                    print("WS parse/handle error:", e)
            elif msg.type == WSMsgType.ERROR:
                print("WS error:", ws.exception())
    finally:
        await hub.unregister(ws)
    return ws

async def index_handler(request: web.Request):
    return web.FileResponse(GUI_DIR / "index.html")

def make_app() -> web.Application:
    app = web.Application()
    # routes
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/", index_handler)
    # serve entire GUI at root
    app.router.add_static("/", str(GUI_DIR), show_index=False)
    # lifecycle
    app.on_startup.append(hub.start)
    app.on_shutdown.append(hub.stop)
    return app

def main():
    app = make_app()
    print(f"Even Crop Brain — serving GUI from {GUI_DIR}")
    print(f"Open: http://localhost:{PORT}/  (WebSocket at /ws)")
    web.run_app(app, host="0.0.0.0", port=PORT)

if __name__ == "__main__":
    main()

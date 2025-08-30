Even-Crop-Pi — Plug & Play (v2.2)

Quick start
-----------
1) Ensure Python 3 is installed.
2) Unzip this folder.
3) Run:
   - Windows:  scripts\run.bat
   - macOS/Linux:  bash scripts/run.sh
4) Open your browser at: http://localhost:8000

Highlights in this build
------------------------
- Per-unit flow meters: set K‑factor (pulses/L) on the GPIO page. Derived Hz per L/min is shown.
- Offsets moved: per‑unit timing offset is edited on the Calibration page (Per‑unit delay ms). 
- Existing Flow/Timed calibration retained (pulses per cycle & ms per ml).
- Simulation mode + Start/Stop on Dashboard for quick testing.

Notes
-----
- Hardware I/O is mocked by default on non-RPi hosts.
- State is saved under data/state.json.

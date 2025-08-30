// ui.calibration.js — Calibration & per-unit timing/delivery config
import { state, saveState, getEnabledUnits, logEvent } from './state.js';
import {
  startTimedSquirt, stopTimedSquirt, startFlowCal,
  setUnitMode, setPulsesPerCycle, setUnitMsPerMl,
  assignMomentary, setGroup, setUnitDelayMs
} from './api.js';
import { openCustomModal, openRangeModal } from './components.modal.js';

export function mountCalibration(root){
  root.innerHTML = `
    <div class="grid">
      <div class="card col-12">
        <h3>Calibration & Setup</h3>
        <p class="desc">
          Edit delivery parameters, then run Flow or Timed wizards to fine-tune.
          Per-unit delay (ms) stacks on top of momentary offset and pattern base.
        </p>

        <div class="space"></div>

        <table class="table" id="calTable" aria-label="Calibration table">
          <thead>
            <tr>
              <th>#</th>
              <th>Mode</th>
              <th class="right">Pulses/Cycle</th>
              <th class="right">ms per ml</th>
              <th class="right">Per-unit delay (ms)</th>
              <th>Group</th>
              <th>M</th>
              <th class="right">Last (ml)</th>
              <th class="right">Δ%</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>

        <div class="space"></div>

        <h4>Global momentary offsets</h4>
        <p class="desc">Applied to all units assigned to each momentary (0–100% ⇒ 0–1000&nbsp;ms).</p>
        <div class="row">
          ${['M1','M2','M3'].map(m=>{
            const cfg = state.momentary?.[m] || {enabled:false, offset:0};
            return `
              <label>${m} offset %
                <input type="number" class="mom-off" data-m="${m}" min="0" max="100" step="1" value="${cfg.offset||0}">
              </label>
              <span class="small">(${(cfg.offset||0)*10} ms)</span>
            `;
          }).join('<span style="width:12px"></span>')}
        </div>
      </div>
    </div>
  `;

  renderTable(root);
  bindMomentaryOffsetEditors(root);
}

/* ---------- table render & bindings ---------- */

function renderTable(root){
  const tb = root.querySelector('#calTable tbody');
  tb.innerHTML = '';

  const enabledUnits = getEnabledUnits(); // only enabled, sorted by id
  const bDelay = Number(state.autoDelay?.currentMs ?? 500);

  enabledUnits.forEach((u, idx)=>{
    const tr = document.createElement('tr');
    tr.setAttribute('data-id', String(u.id));

    // compute valid delay bounds depending on Diamond rules
    const isB = (u.group === 'B');
    const minDelay = isB ? -Math.max(0, bDelay) : 0;
    const perDelay = Number.isFinite(u.perDelayMs) ? u.perDelayMs : 0;

    tr.innerHTML = `
      <td>${u.seq}</td>

      <td>
        <select class="in-mode">
          ${opt('inherit', u.mode)}${opt('flow', u.mode)}${opt('timed', u.mode)}
        </select>
      </td>

      <td class="right">
        <input class="in-ppc" type="number" min="1" step="1" value="${u.pulsesPerCycle}">
      </td>

      <td class="right">
        <input class="in-msml" type="number" min="0.1" step="0.1" value="${u.msPerMl}">
      </td>

      <td class="right">
        <input class="in-delay" type="number" step="1" value="${perDelay}"
               title="${isB ? `B may be negative up to −${bDelay} ms` : 'A cannot be negative'}">
        <div class="small">${isB?`min ${-bDelay} ms`:`min 0 ms`}</div>
      </td>

      <td>
        <select class="in-group">
          ${opt('A', u.group)}${opt('B', u.group)}
        </select>
      </td>

      <td>
        <select class="in-mom">
          ${opt('None', u.momentary)}${opt('M1', u.momentary)}${opt('M2', u.momentary)}${opt('M3', u.momentary)}
        </select>
      </td>

      <td class="right">${u.lastDeliveredMl==null?'-':u.lastDeliveredMl}</td>
      <td class="right">${u.deviation==null?'-':(u.deviation*100).toFixed(1)}</td>

      <td>
        <div class="row">
          <button class="btn" data-act="flow">Cal. Flow</button>
          <button class="btn" data-act="timed">Cal. Timed</button>
          <button class="btn ghost" data-act="flush">Flush</button>
        </div>
      </td>
    `;

    // editors
    tr.querySelector('.in-mode').onchange = (e)=>{
      const v = e.target.value;
      setUnitMode(u.id, v);
      u.mode = v; saveState();
    };
    tr.querySelector('.in-ppc').onchange = (e)=>{
      const v = Math.max(1, parseInt(e.target.value||'0',10));
      setPulsesPerCycle(u.id, v);
      u.pulsesPerCycle = v; saveState();
    };
    tr.querySelector('.in-msml').onchange = (e)=>{
      const v = Math.max(0.1, parseFloat(e.target.value||'0'));
      setUnitMsPerMl(u.id, v);
      u.msPerMl = v; saveState();
    };
    const delayEl = tr.querySelector('.in-delay');
    delayEl.onchange = (e)=>{
      let v = parseInt(e.target.value||'0',10);
      if(isB) v = Math.max(-bDelay, v); else v = Math.max(0, v);
      e.target.value = String(v);
      setUnitDelayMs(u.id, v);
      u.perDelayMs = v; saveState();
    };
    tr.querySelector('.in-group').onchange = (e)=>{
      const g = (e.target.value==='B'?'B':'A');
      setGroup(u.id, g);
      u.group = g; saveState();
      // Re-render bounds if group changed
      renderTable(root);
    };
    tr.querySelector('.in-mom').onchange = (e)=>{
      const m = e.target.value;
      assignMomentary(u.id, m);
      u.momentary = m; saveState();
    };

    // actions
    tr.querySelector('[data-act="flow"]').onclick  = ()=> openFlowCalWizard(u, root);
    tr.querySelector('[data-act="timed"]').onclick = ()=> openTimedWizard(u, root);
    tr.querySelector('[data-act="flush"]').onclick = ()=> openFlushControl(u);

    tb.appendChild(tr);
  });
}

function opt(v, cur){ return `<option value="${v}" ${cur===v?'selected':''}>${v}</option>`; }

/* ---------- momentary offsets (global) ---------- */
function bindMomentaryOffsetEditors(root){
  root.querySelectorAll('.mom-off').forEach(inp=>{
    inp.onchange = ()=>{
      const m = inp.getAttribute('data-m');
      const v = Math.max(0, Math.min(100, parseInt(inp.value||'0',10)));
      state.momentary = state.momentary || {M1:{enabled:true,offset:0}, M2:{enabled:false,offset:0}, M3:{enabled:false,offset:0}};
      if(!state.momentary[m]) state.momentary[m] = {enabled:(m==='M1'), offset:0};
      state.momentary[m].offset = v;
      saveState();
      // live hint "(xxx ms)"
      const hint = inp.parentElement.nextElementSibling;
      if(hint && hint.classList.contains('small')){
        hint.textContent = `${v*10} ms`;
      }
    };
  });
}

/* ---------- Calibration wizards ---------- */

/**
 * Flow wizard
 *  - You will run the unit until about 1000 ml is collected (press your own control or use Brain).
 *  - Enter *measured ml* and *pulses counted* during the run.
 *  - We compute pulsesPerMl = pulses / ml, then Pulses/Cycle = pulsesPerMl * targetMl.
 *  - Repeat until within ±5% of 1000 ml. Stays open between runs.
 */
function openFlowCalWizard(unit, root){
  const targetRefMl = 1000;
  let lastMeasured = null, lastPulses = null;

  const m = openCustomModal({
    title: `Calibrate (Flow) — Unit ${unit.id}`,
    render(api){
      const box = document.createElement('div');
      box.innerHTML = `
        <p class="hint">1) Prepare a 1L container. 2) Start the run and collect near 1000 ml. 3) Enter readings below.</p>
        <div class="row" style="gap:16px; align-items:flex-end;">
          <label>Measured ml
            <input id="ml" type="number" min="1" step="1" style="width:140px">
          </label>
          <label>Pulses counted
            <input id="pulses" type="number" min="1" step="1" style="width:140px">
          </label>
          <button class="btn" id="btnStartRun">Start run</button>
        </div>
        <div class="space"></div>
        <div id="status" class="small">Target reference: ${targetRefMl} ml</div>
      `;
      api.body.appendChild(box);

      const inpMl = box.querySelector('#ml');
      const inpP = box.querySelector('#pulses');
      const status = box.querySelector('#status');

      box.querySelector('#btnStartRun').onclick = ()=>{
        startFlowCal(unit.id, targetRefMl);
        status.textContent = 'Running… collect ≈1000 ml, then enter values.';
      };

      api.setConfirm(()=>{
        const ml = parseFloat(inpMl.value||'0');
        const p  = parseInt(inpP.value||'0',10);
        if(ml<=0 || p<=0){ status.textContent = 'Enter measured ml and pulses.'; return false; }
        lastMeasured = ml; lastPulses = p;

        const err = Math.abs(ml - targetRefMl) / targetRefMl;
        const ppm = p / ml; // pulses per ml
        const newPPC = Math.max(1, Math.round(ppm * Math.max(1, state.targetMl||100)));

        // apply
        setPulsesPerCycle(unit.id, newPPC);
        unit.pulsesPerCycle = newPPC; saveState();

        // live update row
        renderTable(root);

        status.innerHTML = `
          <div>Δ vs 1000 ml: <span class="bigNum">${(err*100).toFixed(1)}%</span></div>
          <div>Set Pulses/Cycle → <strong>${newPPC}</strong> (target ${state.targetMl||100} ml)</div>
          <div class="hint">Repeat runs until Δ ≤ 5%. Keep this dialog open.</div>
        `;
        return false; // keep modal open
      }, {label:'Compute & Apply', close:false});

      api.setCancel(()=>{}, {label:'Close'});
    }
  });
}

/**
 * Timed wizard
 *  - 10 s countdown, then Brain squirts for 5 s (5000 ms).
 *  - Enter measured ml. We set msPerMl = 5000 / ml.
 *  - Repeat until within ±5% of 1000 ml if you choose to run for 5 s *twice* (optional),
 *    but typically you just want ms/ml calibrated; the dialog stays open for multiple runs.
 */
function openTimedWizard(unit, root){
  const squirtMs = 5000;
  let countdown = 10;
  let timer = null;

  const m = openCustomModal({
    title: `Calibrate (Timed) — Unit ${unit.id}`,
    render(api){
      const box = document.createElement('div');
      box.innerHTML = `
        <p class="hint">When you press “Begin”, a 10 s countdown starts. At 0, the unit runs for 5 s.</p>
        <div class="row" style="justify-content:center;margin:8px 0;">
          <div class="bigNum" id="cd">10</div>
        </div>
        <div class="row" style="gap:16px; align-items:flex-end;">
          <button class="btn primary" id="begin">Begin</button>
          <label>Measured ml
            <input id="ml" type="number" min="1" step="1" style="width:140px">
          </label>
          <div id="status" class="small">ms per ml (current): <strong>${unit.msPerMl}</strong></div>
        </div>
      `;
      api.body.appendChild(box);
      const cd = box.querySelector('#cd');
      const ml = box.querySelector('#ml');
      const status = box.querySelector('#status');

      function resetCD(){ countdown = 10; cd.textContent = String(countdown); }
      function tick(){
        countdown--;
        cd.textContent = String(countdown);
        if(countdown <= 0){
          clearInterval(timer); timer = null;
          // Fire squirt
          startTimedSquirt(unit.id, squirtMs);
          status.textContent = 'Squirting 5 s…';
          setTimeout(()=>{ stopTimedSquirt(unit.id); status.textContent = 'Done. Enter measured ml and press “Apply”.'; }, squirtMs+50);
        }
      }

      box.querySelector('#begin').onclick = ()=>{
        if(timer) return;
        resetCD();
        timer = setInterval(tick, 1000);
      };

      api.setConfirm(()=>{
        const mL = parseFloat(ml.value||'0');
        if(mL <= 0){ status.textContent = 'Enter measured ml.'; return false; }
        const newMsPerMl = +(squirtMs / mL).toFixed(3);
        setUnitMsPerMl(unit.id, newMsPerMl);
        unit.msPerMl = newMsPerMl; saveState();

        // live update row
        renderTable(root);

        status.innerHTML = `
          Set ms/ml → <strong>${newMsPerMl}</strong>.
          <span class="hint">Run again if needed; this dialog stays open.</span>
        `;
        return false; // keep open
      }, {label:'Apply', close:false});

      api.setCancel(()=>{
        if(timer){ clearInterval(timer); timer = null; }
      }, {label:'Close'});
    }
  });
}

/**
 * Flush control — simple start/stop button that leaves dialog open.
 * You can repeatedly start/stop for spot cleaning.
 */
function openFlushControl(unit){
  let running = false, h = null;

  const m = openCustomModal({
    title: `Flush — Unit ${unit.id}`,
    render(api){
      const box = document.createElement('div');
      box.innerHTML = `
        <p class="hint">Start to open the valve. Stop to close. Use for purging lines.</p>
        <div class="row">
          <button class="btn" id="btn">Start</button>
          <label>Timed flush (ms)
            <input id="ms" type="number" min="100" step="100" value="2000" style="width:140px">
          </label>
        </div>
      `;
      api.body.appendChild(box);
      const btn = box.querySelector('#btn');
      const msEl = box.querySelector('#ms');

      btn.onclick = ()=>{
        const ms = Math.max(100, parseInt(msEl.value||'0',10));
        running = !running;
        if(running){
          btn.textContent = 'Stop';
          startTimedSquirt(unit.id, ms);
          // auto stop after ms
          if(h) clearTimeout(h);
          h = setTimeout(()=>{ running=false; btn.textContent='Start'; stopTimedSquirt(unit.id); }, ms+50);
        }else{
          btn.textContent = 'Start';
          stopTimedSquirt(unit.id);
          if(h) { clearTimeout(h); h=null; }
        }
      };

      api.setConfirm(()=>true, {label:'Close', close:true});
      api.setCancel(()=>{ if(running) stopTimedSquirt(unit.id); }, {label:'Cancel'});
    }
  });
}

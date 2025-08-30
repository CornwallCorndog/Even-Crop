// ui.dashboard.js — Dashboard: Telemetry, Presets, Units strip
import { state, saveState, getEnabledUnits, logEvent } from './state.js';
import {
  onTelemetry, onCycle, onEvent,
  setTargetMl, setSimulation, setRunning,
  setTramline, clearTramline,
  setBuzzerMute, setBuzzerHardMute
} from './api.js';
import { openRangeModal } from './components.modal.js';

let blockedStreak = {};   // { unitId: count of consecutive BLOCKED cycles }
let audioEl = null;

export function mountDashboard(root){
  // build DOM
  root.innerHTML = `
    <div class="grid">
      <!-- Telemetry / controls -->
      <div class="card col-12">
        <h3>Live Telemetry</h3>
        <p class="desc">Use Sim buttons to generate demo data or exercise Brain scheduling.</p>
        <div class="space"></div>

        <div class="kpiWrap">
          <div class="kpi" id="kpi-flow">
            <label>Flow</label>
            <div class="value"><span id="flowVal">0.0</span> <small>L/min</small></div>
            <span class="badge" id="flowBadge">OK</span>
          </div>
          <div class="kpi" id="kpi-pressure">
            <label>Pressure</label>
            <div class="value"><span id="presVal">0.0</span> <small>bar</small></div>
            <span class="badge" id="presBadge">OK</span>
          </div>
          <div class="kpi" id="kpi-speed">
            <label>Speed</label>
            <div class="value"><span id="speedVal">0.0</span> <small>km/h</small></div>
            <span class="badge" id="speedBadge">OK</span>
          </div>
          <div class="kpi" id="kpi-rate">
            <label>Target (ml/plant)</label>
            <div class="value">
              <span id="rateVal">${state.targetMl ?? 100}</span> <small>ml/plant</small>
            </div>
            <button class="btn secondary" id="btnTarget">Adjust</button>
          </div>
        </div>

        <div class="space"></div>
        <div class="row">
          <button class="btn success" id="btnStart">Start</button>
          <button class="btn danger" id="btnStop">Stop</button>
          <span class="spacer"></span>
          <button class="btn" id="btnSimTel">Sim Telemetry: <strong id="simTelState">${state.simulation ? 'ON' : 'OFF'}</strong></button>
          <button class="btn" id="btnSimFull">Sim Cycles</button>
          <span class="spacer"></span>
          <button class="btn" id="btnMute">${state.buzzer?.muted ? '🔕 Unmute' : '🔔 Mute'}</button>
          <label class="small"><input type="checkbox" id="chkHardMute" ${state.buzzer?.hardMute ? 'checked':''}> Alarm OFF</label>
          <span class="pill" id="autoDeltaChip" title="Diamond B delay">Δ <span id="autoDelta">…</span> ms</span>
        </div>
      </div>

      <!-- Tramline presets bar -->
      <div class="card col-12" id="presetsCard">
        <div class="row" style="gap:12px;">
          <button class="btn" id="btnPresetLeft" style="flex:1; display:flex; justify-content:center; gap:8px; align-items:center;">
            ⬅️ <span>Left Preset</span>
          </button>
          <button class="btn" id="btnPresetRight" style="flex:1; display:flex; justify-content:center; gap:8px; align-items:center;">
            <span>Right Preset</span> ➡️
          </button>
        </div>
        <p class="small" style="margin-top:6px;">Tip: First press while some units are OFF to capture. Next press clears. Press again reapplies. Only one side active at a time.</p>
      </div>

      <!-- Units strip -->
      <div class="card col-12">
        <h3>Units</h3>
        <p class="desc">Enabled units only. ON/OFF here is temporary (tramline) and does not change Settings.</p>
        <div class="space"></div>
        <div class="unitsRow" id="dashUnits"></div>
        <div class="space"></div>
        <div class="row">
          <button class="btn ghost" id="btnClearTram">Clear Tramline Overrides</button>
        </div>
      </div>
    </div>
  `;

  // prepare audio
  ensureAudio();

  // bind
  bindTelemetry();
  bindControls(root);
  renderPresetsBar(root);
  renderUnits(root);

  // live updates
  onCycle(()=> {
    updateUnitTiles(root);
    maybeBuzz();
  });
  onEvent((ev)=>{
    if(ev?.ev === 'auto-delay'){
      const el = document.getElementById('autoDelta');
      if(el){ el.textContent = String(ev.value); }
    }
  });
}

/* ---------- telemetry ---------- */
function bindTelemetry(){
  const flowVal = document.getElementById('flowVal');
  const presVal = document.getElementById('presVal');
  const speedVal = document.getElementById('speedVal');

  const flowBox = document.getElementById('kpi-flow');
  const presBox = document.getElementById('kpi-pressure');
  const speedBox = document.getElementById('kpi-speed');

  const flowBadge = document.getElementById('flowBadge');
  const presBadge = document.getElementById('presBadge');
  const speedBadge = document.getElementById('speedBadge');

  // init Δ chip
  const autoD = document.getElementById('autoDelta');
  if(autoD) autoD.textContent = String(state.autoDelay?.currentMs ?? 500);

  onTelemetry(({flow, pressure, speed})=>{
    flowVal.textContent = Number(flow).toFixed(1);
    presVal.textContent = Number(pressure).toFixed(1);
    speedVal.textContent = Number(speed).toFixed(1);

    setStateBox(flowBox, flowBadge, flow, 0.5, 12);
    setStateBox(presBox, presBadge, pressure, 1.0, 3.5);
    setStateBox(speedBox, speedBadge, speed, 1.0, 16);
  });
}

function setStateBox(box, badge, val, low, high){
  box.classList.remove('state-ok','state-warn','state-bad');
  if(val < low) { box.classList.add('state-bad');  badge.textContent = 'LOW'; }
  else if(val > high) { box.classList.add('state-warn'); badge.textContent = 'HIGH'; }
  else { box.classList.add('state-ok'); badge.textContent = 'OK'; }
}

/* ---------- controls ---------- */
function bindControls(root){
  // run
  root.querySelector('#btnStart').onclick = ()=> setRunning(true);
  root.querySelector('#btnStop').onclick  = ()=> setRunning(false);

  // sim
  const simTelBtn = root.querySelector('#btnSimTel');
  const simFullBtn = root.querySelector('#btnSimFull');
  simTelBtn.onclick = ()=>{
    const on = !state.simulation;
    setSimulation(on, 'telemetry');
    simTelBtn.querySelector('#simTelState').textContent = on ? 'ON' : 'OFF';
  };
  simFullBtn.onclick = ()=>{
    // toggle full sim independent of simTel text
    // use API same as telemetry but with mode='full'
    // we don't track a separate flag; pressing it just sends a toggle intent
    setSimulation(true, 'full');
    logEvent('Sim cycles toggled (Brain side)');
  };

  // target
  root.querySelector('#btnTarget').onclick = async ()=>{
    const v = await openRangeModal({
      title:'Target per plant (ml)',
      value: state.targetMl ?? 100,
      min: 5, max: 4000, step: 5
    }).catch(()=>null);
    if(v != null){
      setTargetMl(v);
      document.getElementById('rateVal').textContent = v;
    }
  };

  // buzzer
  const btnMute = root.querySelector('#btnMute');
  const chkHard = root.querySelector('#chkHardMute');
  btnMute.onclick = ()=>{
    const to = !(state.buzzer?.muted);
    setBuzzerMute(to);
    btnMute.textContent = to ? '🔕 Unmute' : '🔔 Mute';
    if(to && audioEl){ try{ audioEl.pause(); audioEl.currentTime = 0; }catch{} }
  };
  chkHard.onchange = ()=>{
    setBuzzerHardMute(!!chkHard.checked);
    if(!!chkHard.checked && audioEl){ try{ audioEl.pause(); audioEl.currentTime = 0; }catch{} }
  };

  // tramline clear
  root.querySelector('#btnClearTram').onclick = ()=>{
    clearTramline();
    renderUnits(root);
    saveState();
  };

  // presets
  root.querySelector('#btnPresetLeft').onclick  = ()=> togglePreset('left', root);
  root.querySelector('#btnPresetRight').onclick = ()=> togglePreset('right', root);
}

function renderPresetsBar(root){
  const setActiveStyle = ()=>{
    const L = root.querySelector('#btnPresetLeft');
    const R = root.querySelector('#btnPresetRight');
    const active = state.tramPresets?.active || null;
    L.classList.toggle('primary', active === 'left');
    R.classList.toggle('primary', active === 'right');
  };
  setActiveStyle();
}

function togglePreset(side, root){
  // Ensure structure
  state.tramPresets = state.tramPresets || {left:[], right:[], active:null};

  const anyOff = Object.values(state.tramline || {}).some(v => !!v);
  const currentOffIds = Object.entries(state.tramline || {})
    .filter(([_,v])=>!!v)
    .map(([k,_])=> +k);

  if(anyOff){
    // Capture current OFF map as preset for this side and keep it applied
    state.tramPresets[side] = currentOffIds.slice();
    state.tramPresets.active = side;
    saveState();
    // Visually mark
    renderPresetsBar(root);
  }else{
    // No OFFs at the moment:
    // If this side is active -> clear all
    // else -> apply stored preset
    if(state.tramPresets.active === side){
      // clear all
      clearTramline();
      state.tramPresets.active = null;
      saveState();
      renderPresetsBar(root);
      renderUnits(root);
      return;
    }else{
      const preset = (state.tramPresets[side] || []).slice();
      // apply: first clear all, then set those OFF
      state.tramline = {};
      preset.forEach(id => state.tramline[id] = true);
      saveState();
      // send to Brain
      clearTramline();
      preset.forEach(id => setTramline(id, true));
      state.tramPresets.active = side;
      saveState();
      renderPresetsBar(root);
      renderUnits(root);
    }
  }
}

/* ---------- units ---------- */
function renderUnits(root){
  const wrap = root.querySelector('#dashUnits');
  wrap.innerHTML = '';

  const enabled = getEnabledUnits(); // sorted by id
  // Insert separators between different momentary groups
  let lastM = null;

  enabled.forEach((u)=>{
    const realId = u.id;
    const disabledTmp = !!(state.tramline[realId] || state.tramline[String(realId)]);
    const st = (u.status || 'OK');

    // group separator if momentary changes
    if(lastM !== null && lastM !== u.momentary){
      const sep = document.createElement('div');
      sep.className = 'sep';
      wrap.appendChild(sep);
    }
    lastM = u.momentary || 'None';

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('data-id', realId);

    const t = state.targetMl || 100;
    const last = (u.lastDeliveredMl==null)?'-':u.lastDeliveredMl;
    const dev = (u.deviation==null)?'-':((u.deviation*100).toFixed(1)+'%');

    addStatusClass(tile, st, disabledTmp);

    tile.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <div class="chip">Unit ${u.seq}</div>
        <span class="badge ${badgeClass(st, disabledTmp)}">${labelFor(st, disabledTmp)}</span>
      </div>
      <div class="small">Last: <strong>${last}</strong> ml &nbsp; Δ <strong>${dev}</strong></div>
      <div class="row" style="margin-top:8px;">
        <button class="btn ${disabledTmp?'danger':'success'}" data-id="${realId}">
          ${disabledTmp?'OFF':'ON'}
        </button>
        <span class="small pill">${u.momentary || 'No M'}</span>
      </div>
    `;

    tile.querySelector('button').onclick = ()=>{
      const to = !disabledTmp;
      // Optimistic UI first
      state.tramline[realId] = to; saveState();
      // Re-render tile quickly
      renderUnits(root);
      // Inform brain (async fire-and-forget)
      Promise.resolve().then(()=> setTramline(realId, to)).catch(()=>{});
    };

    wrap.appendChild(tile);
  });
}

function updateUnitTiles(root){
  const wrap = root.querySelector('#dashUnits');
  if(!wrap) return;

  wrap.querySelectorAll('.tile').forEach(tile=>{
    const id = +tile.getAttribute('data-id');
    const u = state.units.find(x=>x.id===id);
    if(!u) return;

    const disabledTmp = !!(state.tramline[id] || state.tramline[String(id)]);
    const st = (u.status || 'OK');
    resetStatusClasses(tile);
    addStatusClass(tile, st, disabledTmp);

    const smalls = tile.querySelectorAll('.small');
    // small[0] contains Last/Δ line
    if(smalls[0]){
      const last = (u.lastDeliveredMl==null)?'-':u.lastDeliveredMl;
      const dev = (u.deviation==null)?'-':((u.deviation*100).toFixed(1)+'%');
      smalls[0].innerHTML = `Last: <strong>${last}</strong> ml &nbsp; Δ <strong>${dev}</strong>`;
    }

    const statusBadge = tile.querySelector('.badge');
    if(statusBadge){
      statusBadge.className = 'badge ' + badgeClass(st, disabledTmp);
      statusBadge.textContent = labelFor(st, disabledTmp);
    }

    const btn = tile.querySelector('button');
    if(btn){
      btn.className = 'btn ' + (disabledTmp ? 'danger' : 'success');
      btn.textContent = disabledTmp ? 'OFF' : 'ON';
    }
  });
}

/* ---------- status helpers ---------- */
function addStatusClass(el, st, disabledTmp){
  const cls = statusClass(st, disabledTmp);
  if(cls) el.classList.add(cls);
}
function resetStatusClasses(el){
  el.classList.remove('status-ok','status-warn','status-inspect','status-blocked','status-ignored');
}
function statusClass(st, disabledTmp){
  if(disabledTmp) return 'status-ignored';
  if(st==='OK') return 'status-ok';
  if(st==='WARN') return 'status-warn';
  if(st==='INSPECT') return 'status-inspect';
  if(st==='BLOCKED') return 'status-blocked';
  return null;
}
function badgeClass(st, disabledTmp){
  if(disabledTmp) return 'ignored';
  if(st==='OK') return 'ok';
  if(st==='WARN') return 'warn';
  if(st==='INSPECT') return 'inspect';
  if(st==='BLOCKED') return 'blocked';
  return '';
}
function labelFor(st, disabledTmp){
  if(disabledTmp) return 'IGNORED';
  return st || 'OK';
}

/* ---------- audio alarm ---------- */
function ensureAudio(){
  if(audioEl) return audioEl;
  audioEl = document.createElement('audio');
  audioEl.src = './Sounds/Blocked.wav';
  audioEl.loop = true;
  audioEl.preload = 'auto';
  audioEl.style.display = 'none';
  document.body.appendChild(audioEl);
  return audioEl;
}

function maybeBuzz(){
  // Update blocked streak counts
  const enabled = state.units.filter(u=>u.enabled);
  const anyBlocked = enabled.some(u=> (u.status==='BLOCKED') && !(state.tramline[u.id]||state.tramline[String(u.id)]));
  enabled.forEach(u=>{
    const key = String(u.id);
    if(u.status==='BLOCKED'){
      blockedStreak[key] = (blockedStreak[key]||0) + 1;
    }else{
      blockedStreak[key] = 0;
    }
  });

  const shouldPlay = anyBlocked && Object.values(blockedStreak).some(c=>c>=2)
                     && !(state.buzzer?.muted) && !(state.buzzer?.hardMute);

  try{
    if(shouldPlay){
      audioEl?.play?.();
    }else{
      if(audioEl && !audioEl.paused){
        audioEl.pause();
        audioEl.currentTime = 0;
      }
    }
  }catch(_){}
}

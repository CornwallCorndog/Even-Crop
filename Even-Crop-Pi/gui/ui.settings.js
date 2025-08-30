// ui.settings.js — Profiles • Units • Delivery & Diamond • Event Log
import { state, saveState, getEnabledUnits } from './state.js';
import {
  setUnitEnabled, setGroup, assignMomentary,
  setDeliveryMode, setAutoDiamond
} from './api.js';
import { openCustomModal } from './components.modal.js';

export function mountSettings(root){
  root.innerHTML = `
    <div class="grid">
      <!-- Profiles -->
      <div class="card col-12">
        <h3>Profiles</h3>
        <p class="desc">Save/Load configuration snapshots on this device. Use Export/Import to move between devices.</p>
        <div class="space"></div>
        <div class="row" style="flex-wrap:wrap; gap:10px;">
          <label>Active:
            <input id="profActive" type="text" value="${state.activeProfile || 'UNSAVED PROFILE'}" style="min-width:220px;">
          </label>
          <button class="btn" id="profSave">Save</button>
          <button class="btn" id="profSaveAs">Save As…</button>
          <button class="btn" id="profLoad">Load…</button>
          <span class="spacer"></span>
          <button class="btn ghost" id="profExport">Export</button>
          <input id="profImportFile" type="file" accept="application/json" style="display:none">
          <button class="btn ghost" id="profImport">Import</button>
        </div>
      </div>

      <!-- Units (column) -->
      <div class="card col-12">
        <h3>Units</h3>
        <p class="desc">Tap a row to enable/disable. Group = A/B (Diamond). “M” assigns a momentary switch. Offset % is legacy per-unit % (independent of per-unit delay in Calibration).</p>
        <div class="space"></div>
        <table class="table" id="unitsTable" aria-label="Units">
          <thead>
            <tr>
              <th>#</th><th>Status</th><th>Group</th><th>M</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <!-- Delivery & Diamond -->
      <div class="card col-12">
        <h3>Delivery & Diamond Timing</h3>
        <div class="space"></div>
        <div class="row">
          <label>Delivery Mode
            <select id="selMode">
              <option value="flow" ${state.deliveryMode==='flow'?'selected':''}>Flow (pulses)</option>
              <option value="timed" ${state.deliveryMode==='timed'?'selected':''}>Timed (ms/ml)</option>
            </select>
          </label>

          <span class="spacer"></span>

          <label><input type="checkbox" id="chkAuto" ${state.autoDelay?.enabled ? 'checked' : ''}> Auto Diamond Delay</label>
          <label>Manual Δ (ms)
            <input type="number" id="manDelta" min="0" step="10" value="${state.autoDelay?.manualMs ?? 500}">
          </label>
          <label>Geometric lead (ms)
            <input type="number" id="geomLead" min="0" step="10" value="${state.autoDelay?.geomLeadMs ?? 0}">
          </label>
          <span class="pill">Current Δ: <strong id="curDelta">${state.autoDelay?.currentMs ?? state.autoDelay?.manualMs ?? 500}</strong> ms</span>
        </div>
      </div>

      <!-- Event log -->
      <div class="card col-12">
        <h3>Event Log</h3>
        <p class="desc">Shows most recent up to 100 events. 10 visible per page.</p>
        <div class="space"></div>
        <table class="table" id="logTable">
          <thead><tr><th>Time</th><th>Event</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="space"></div>
        <div class="row">
          <button class="btn secondary" id="btnLogNewer">&larr; Newer</button>
          <span class="small" id="logPageText">Page 1</span>
          <button class="btn secondary" id="btnLogOlder">Older &rarr;</button>
          <span class="pill" id="logCount">0 total</span>
          <span class="spacer"></span>
          <button class="btn ghost" id="btnSaveLog">Save Log</button>
          <button class="btn danger" id="btnClearLog">Clear Log</button>
        </div>
      </div>
    </div>
  `;

  bindProfiles(root);
  renderUnitsTable(root);
  bindDelivery(root);
  renderLog(root);
}

/* =================== PROFILES (localStorage) =================== */

const PROFS_KEY = 'ec_profiles'; // { name: { ...config... }, ... }

function readProfiles(){
  try{
    const raw = localStorage.getItem(PROFS_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch(_){ return {}; }
}
function writeProfiles(obj){
  try{ localStorage.setItem(PROFS_KEY, JSON.stringify(obj)); }catch(_){}
}

function snapshotConfig(){
  // Keep only configuration parts (roughly mirrors server/profiles.py)
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.eventLog;
  delete copy.logPage;
  delete copy.simulation;
  delete copy.tramline;     // transient
  delete copy.tramPresets;  // transient
  return copy;
}

function applyConfig(cfg){
  // Merge minimal with safety
  const keep = snapshotConfig();
  const merged = Object.assign(keep, cfg || {});
  // write back and persist
  Object.assign(state, merged);
  saveState();
}

function bindProfiles(root){
  const inpActive = root.querySelector('#profActive');
  const btnSave   = root.querySelector('#profSave');
  const btnSaveAs = root.querySelector('#profSaveAs');
  const btnLoad   = root.querySelector('#profLoad');
  const btnExport = root.querySelector('#profExport');
  const fileImp   = root.querySelector('#profImportFile');
  const btnImport = root.querySelector('#profImport');

  btnSave.onclick = ()=>{
    const name = (inpActive.value || '').trim() || 'profile';
    const all = readProfiles();
    all[name] = snapshotConfig();
    writeProfiles(all);
    state.activeProfile = name; saveState();
    toast(`Saved profile “${name}”`);
  };

  btnSaveAs.onclick = ()=>{
    const name = prompt('Profile name:', state.activeProfile || 'profile');
    if(!name) return;
    const all = readProfiles();
    all[name] = snapshotConfig();
    writeProfiles(all);
    state.activeProfile = name; saveState();
    inpActive.value = name;
    toast(`Saved as “${name}”`);
  };

  btnLoad.onclick = ()=>{
    const all = readProfiles();
    const names = Object.keys(all);
    if(!names.length){ toast('No profiles saved on this device yet.'); return; }
    // Simple picker
    const m = openCustomModal({
      title:'Load Profile',
      render(api){
        const box = document.createElement('div');
        box.innerHTML = `
          <p class="hint">Choose a profile to load:</p>
          <div class="row" style="flex-wrap:wrap; gap:8px;">
            ${names.map(n=>`<button class="btn" data-n="${encodeURIComponent(n)}">${n}</button>`).join('')}
          </div>
        `;
        api.body.appendChild(box);
        box.querySelectorAll('button[data-n]').forEach(b=>{
          b.onclick = ()=>{
            const nm = decodeURIComponent(b.getAttribute('data-n'));
            applyConfig(all[nm]);
            state.activeProfile = nm; saveState();
            inpActive.value = nm;
            // Re-render dependent sections
            renderUnitsTable(root);
            bindDelivery(root, true);
            toast(`Loaded “${nm}”`);
            api.close();
          };
        });
        api.setConfirm(()=>true, {label:'Close'});
      }
    });
  };

  btnExport.onclick = ()=>{
    const name = (inpActive.value || 'profile').trim();
    const blob = new Blob([JSON.stringify(snapshotConfig(), null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name || 'profile'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  btnImport.onclick = ()=> fileImp.click();
  fileImp.onchange = ()=>{
    const f = fileImp.files && fileImp.files[0];
    if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const cfg = JSON.parse(String(r.result));
        applyConfig(cfg);
        state.activeProfile = (cfg.__name || 'IMPORTED'); saveState();
        inpActive.value = state.activeProfile;
        renderUnitsTable(root);
        bindDelivery(root, true);
        toast('Imported profile.');
      }catch(e){ toast('Import failed: invalid JSON'); }
    };
    r.readAsText(f);
    fileImp.value = '';
  };
}

function toast(msg){
  try{
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#0f1620;border:1px solid #1f2937;padding:8px 12px;border-radius:10px;color:#e8eef5;z-index:2000;';
    document.body.appendChild(el);
    setTimeout(()=>{ el.remove(); }, 1400);
  }catch(_){}
}

/* =================== UNITS TABLE =================== */

function renderUnitsTable(root){
  const tb = root.querySelector('#unitsTable tbody');
  tb.innerHTML = '';

  // Show all 11 in index order, regardless of enabled, as requested
  const rows = state.units.slice().sort((a,b)=>a.id-b.id);

  rows.forEach(u=>{
    const tr = document.createElement('tr');
    tr.setAttribute('data-id', String(u.id));
    tr.style.cursor = 'pointer';

    tr.innerHTML = `
      <td>${u.id}</td>
      <td>
        <span class="badge ${u.enabled ? 'ok' : 'ignored'}">${u.enabled ? 'ENABLED' : 'DISABLED'}</span>
      </td>
      <td>
        <select class="u-group">
          <option value="A" ${u.group==='A'?'selected':''}>A</option>
          <option value="B" ${u.group==='B'?'selected':''}>B</option>
        </select>
      </td>
      <td>
        <select class="u-mom">
          <option value="None" ${u.momentary==='None'?'selected':''}>None</option>
          <option value="M1" ${u.momentary==='M1'?'selected':''}>M1</option>
          <option value="M2" ${u.momentary==='M2'?'selected':''}>M2</option>
          <option value="M3" ${u.momentary==='M3'?'selected':''}>M3</option>
        </select>
      </td>
      
    `;

    // Click row toggles enable/disable, but not clicks on inputs
    tr.addEventListener('click', (e)=>{
      if(e.target.closest('select') || e.target.closest('input')) return;
      const to = !u.enabled;
      u.enabled = to; saveState(); setUnitEnabled(u.id, to);
      // update badge text/color
      const badge = tr.querySelector('.badge');
      badge.textContent = to ? 'ENABLED' : 'DISABLED';
      badge.className = 'badge ' + (to ? 'ok' : 'ignored');
    });

    // Editors
    tr.querySelector('.u-group').onchange = (e)=>{
      u.group = (e.target.value==='B'?'B':'A'); saveState(); setGroup(u.id, u.group);
    };
    tr.querySelector('.u-mom').onchange = (e)=>{
      u.momentary = e.target.value; saveState(); assignMomentary(u.id, u.momentary);
    };
    // offset moved to Calibration

    tb.appendChild(tr);
  });
}

/* =================== DELIVERY & DIAMOND =================== */

function bindDelivery(root, onlyRefresh=false){
  const selMode = root.querySelector('#selMode');
  const chkAuto = root.querySelector('#chkAuto');
  const manDelta = root.querySelector('#manDelta');
  const geomLead = root.querySelector('#geomLead');
  const curDelta = root.querySelector('#curDelta');

  if(onlyRefresh){
    selMode.value = state.deliveryMode || 'flow';
    chkAuto.checked = !!(state.autoDelay?.enabled);
    manDelta.value = state.autoDelay?.manualMs ?? 500;
    geomLead.value = state.autoDelay?.geomLeadMs ?? 0;
    curDelta.textContent = String(state.autoDelay?.currentMs ?? state.autoDelay?.manualMs ?? 500);
    return;
  }

  selMode.onchange = ()=>{ setDeliveryMode(selMode.value); };

  const pushCfg = ()=>{
    const cfg = {
      enabled: !!chkAuto.checked,
      manualMs: Math.max(0, parseInt(manDelta.value||'0',10)),
      geomLeadMs: Math.max(0, parseInt(geomLead.value||'0',10))
    };
    setAutoDiamond(cfg);
    // optimistic UI for chip
    const current = cfg.enabled ? (state.autoDelay.currentMs ?? cfg.manualMs) : cfg.manualMs + cfg.geomLeadMs;
    curDelta.textContent = String(current);
  };

  chkAuto.onchange = pushCfg;
  manDelta.onchange = pushCfg;
  geomLead.onchange = pushCfg;
}

/* =================== EVENT LOG =================== */

function renderLog(root){
  const tbody = root.querySelector('#logTable tbody');
  const pageText = root.querySelector('#logPageText');
  const count = root.querySelector('#logCount');

  const total = state.eventLog.length;
  const page = state.logPage || 0;
  const pageSize = 10;

  const end = total - page*pageSize;
  const start = Math.max(0, end - pageSize);
  const slice = state.eventLog.slice(start, end);

  tbody.innerHTML = '';
  slice.forEach(ev=>{
    const tr = document.createElement('tr');
    const timeStr = new Date(ev.t).toLocaleString();
    tr.innerHTML = `<td>${timeStr}</td><td>${ev.msg}</td>`;
    tbody.prepend(tr);
  });

  pageText.textContent = 'Page ' + (page+1);
  count.textContent = `${total} total`;

  // controls
  const newer = document.getElementById('btnLogNewer');
  const older = document.getElementById('btnLogOlder');
  const clear = document.getElementById('btnClearLog');
  const save = document.getElementById('btnSaveLog');

  newer.onclick = ()=>{ state.logPage = Math.max(0, page-1); saveState(); renderLog(root); };
  older.onclick = ()=>{ state.logPage = page+1; saveState(); renderLog(root); };
  clear.onclick = ()=>{ state.eventLog = []; state.logPage = 0; saveState(); renderLog(root); };
  save.onclick = ()=>{
    const blob = new Blob([JSON.stringify(state.eventLog, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'even-crop-event-log.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

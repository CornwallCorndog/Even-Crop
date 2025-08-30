// ui.gpio.js — PIN-protected GPIO mapping editor
import { state, saveState } from './state.js';
import { setGpio } from './api.js';
import { openKeypadModal, openCustomModal } from './components.modal.js';

const PIN_CODE = '5005';
let unlockedUntil = 0; // epoch ms

export function mountGPIO(root){
  // relock if time passed or on every mount
  const now = Date.now();
  const stillUnlocked = now < unlockedUntil;
  root.innerHTML = '';
  if(!stillUnlocked){
    renderLocked(root);
  }else{
    renderEditor(root);
  }
}

function renderLocked(root){
  root.innerHTML = `
    <div class="grid">
      <div class="card col-12" style="text-align:center; padding:32px;">
        <h3>GPIO (Locked)</h3>
        <p class="desc">Enter PIN to edit GPIO mapping.</p>
        <div class="space"></div>
        <button class="btn primary" id="enterPin">Enter PIN</button>
      </div>
    </div>
  `;
  root.querySelector('#enterPin').onclick = async ()=>{
    try{
      const pin = await openKeypadModal({ title:'Enter GPIO PIN', maxLen:6, mask:true });
      if(String(pin) === PIN_CODE){
        // unlock for 2 minutes
        unlockedUntil = Date.now() + 2*60*1000;
        renderEditor(root);
      }else{
        toast('Wrong PIN');
      }
    }catch(_){/* cancelled */}
  };
}

function renderEditor(root){
  const gpio = state.gpio || {};
  const get = (key, def=null)=> (key in gpio ? gpio[key] : def);

  // names & labels for fixed signals + 11 units
  const fixed = [
    {key:'flow',   label:'Flow meter (input)'},
    {key:'buzzer', label:'Buzzer (output)'},
    {key:'M1',     label:'Momentary M1 (input)'},
    {key:'M2',     label:'Momentary M2 (input)'},
    {key:'M3',     label:'Momentary M3 (input)'},
  ];
  const units = Array.from({length:11}, (_,i)=>({ key:`unit:${i+1}`, label:`Unit ${i+1} (output)` }));

  root.innerHTML = `
    <div class="grid">
      <div class="card col-12">
        <div class="row" style="align-items:center;">
          <h3 style="margin:0;">GPIO Mapping</h3>
          <span class="spacer"></span>
          <button class="btn" id="btnLock">Lock</button>
          <button class="btn ghost" id="btnExport">Export</button>
          <input id="impFile" type="file" accept="application/json" style="display:none">
          <button class="btn ghost" id="btnImport">Import</button>
        </div>
        <p class="desc">BCM numbering. Leave blank to ignore a signal.</p>
        <div class="space"></div>

        <table class="table" id="gpioTable">
          <thead>
            <tr><th>Signal</th><th class="right">BCM Pin</th></tr>
          </thead>
          <tbody>
            ${[...fixed, ...units].map(row=>{
              const val = get(row.key, '');
              return `
                <tr data-key="${row.key}">
                  <td>${row.label}</td>
                  <td class="right">
                    <input type="number" class="pin" min="0" step="1" value="${val ?? ''}" style="width:110px;">
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div class="space"></div>
        <h3>Flow meters per unit</h3>
        <p class="desc">Each solenoid has its own flow meter. Set the K‑factor (<strong>pulses per liter</strong>).
           The derived <em>Hz per L/min</em> is shown for reference (K/60).</p>
        <table class="table" id="kTable">
          <thead>
            <tr><th>#</th><th class="right">K‑factor (pulses/L)</th><th class="right">Hz per L/min (ref)</th></tr>
          </thead>
          <tbody>
            ${state.units.map(u=>`
              <tr data-uid="${u.id}">
                <td>${u.id}</td>
                <td class="right"><input class="k-input" type="number" min="1" step="1" value="${u.pulsesPerLiter||450}" style="width:140px;"></td>
                <td class="right"><span class="hz-ref">${((u.pulsesPerLiter||450)/60).toFixed(2)}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
    

        <div class="space"></div>
        <div class="row">
          <button class="btn primary" id="btnApply">Apply to Brain</button>
          <button class="btn" id="btnSaveLocal">Save Locally</button>
          <button class="btn danger" id="btnClear">Clear All</button>
          <span class="spacer"></span>
          <label class="small">Unlock time left: <span id="left">–</span></label>
        </div>
      </div>
    </div>
  `;

  // countdown label
  const left = root.querySelector('#left');
  let tmr = setInterval(()=>{
    const ms = Math.max(0, unlockedUntil - Date.now());
    const s = Math.ceil(ms/1000);
    left.textContent = s + 's';
    if(ms<=0){
      clearInterval(tmr);
      mountGPIO(root); // relock
    }
  }, 500);

  root.querySelector('#btnLock').onclick = ()=>{
    unlockedUntil = 0;
    clearInterval(tmr);
    mountGPIO(root);
  };

  // Import/Export
  const impFile = root.querySelector('#impFile');
  root.querySelector('#btnImport').onclick = ()=> impFile.click();
  impFile.onchange = ()=>{
    const f = impFile.files && impFile.files[0];
    if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const obj = JSON.parse(String(r.result));
        if(typeof obj !== 'object') throw new Error('bad');
        state.gpio = obj; saveState();
        toast('Imported GPIO mapping.');
        renderEditor(root);
      }catch(e){ toast('Invalid JSON'); }
    };
    r.readAsText(f);
    impFile.value='';
  };
  root.querySelector('#btnExport').onclick = ()=>{
    const blob = new Blob([JSON.stringify(state.gpio || {}, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gpio-mapping.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Buttons actions
  root.querySelector('#btnClear').onclick = ()=>{
    confirmModal('Clear all GPIO mappings?', ()=>{
      state.gpio = {}; saveState();
      renderEditor(root);
    });
  };

  root.querySelector('#btnSaveLocal').onclick = ()=>{
    const obj = readTableIntoObject(root);
    state.gpio = obj; saveState();
    toast('Saved locally.');
  };

  root.querySelector('#btnApply').onclick = async ()=>{
    const obj = readTableIntoObject(root);
    state.gpio = obj; saveState();
    // push to Brain
    const entries = Object.entries(obj);
    for(const [name, pin] of entries){
      if(pin === '' || pin === null || Number.isNaN(+pin)) continue;
      await setGpio(name, +pin);
    }
    toast('Applied to Brain.');
  };

  // Bind K-factor editors
  root.querySelectorAll('#kTable .k-input').forEach(inp=>{
    const tr = inp.closest('tr');
    const uid = parseInt(tr.getAttribute('data-uid'),10);
    inp.onchange = ()=>{
      let v = Math.max(1, parseInt(inp.value||'450',10));
      // update derived Hz/Lpm
      const hz = (v/60).toFixed(2);
      tr.querySelector('.hz-ref').textContent = hz;
      // save locally and send to brain
      const u = state.units.find(x=>x.id===uid);
      if(u){ u.pulsesPerLiter = v; }
      saveState();
      import('./api.js').then(mod=>mod.setUnitKFactor(uid, v));
      toast('Saved K-factor for unit '+uid);
    };
  });
}

function readTableIntoObject(root){
  const obj = {};
  root.querySelectorAll('#gpioTable tbody tr').forEach(tr=>{
    const key = tr.getAttribute('data-key');
    const v = tr.querySelector('.pin').value;
    if(v === '' || v === null){
      // omit unmapped
    }else{
      obj[key] = +v;
    }
  });
  return obj;
}

function confirmModal(msg, onOk){
  openCustomModal({
    title:'Confirm',
    render(api){
      const p = document.createElement('p');
      p.textContent = msg;
      api.body.appendChild(p);
      api.setConfirm(()=>{ if(onOk) onOk(); return true; }, {label:'Yes'});
      api.setCancel(()=>{}, {label:'No'});
    }
  });
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

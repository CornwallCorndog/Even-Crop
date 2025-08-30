// api.js — GUI ↔ Brain bridge (WebSocket) + mock fallback
import { state, saveState } from './state.js';

let ws = null;
let wsOpen = false;

const listeners = { tel: [], cyc: [], evt: [] };

export function onTelemetry(cb){ listeners.tel.push(cb); }
export function onCycle(cb){ listeners.cyc.push(cb); }
export function onEvent(cb){ listeners.evt.push(cb); }

function emitTel(d){ for(const f of listeners.tel){ try{ f(d); }catch(_){} } }
function emitCycle(){ for(const f of listeners.cyc){ try{ f(); }catch(_){} } }
function emitEvt(e){ for(const f of listeners.evt){ try{ f(e); }catch(_){} } }

const isMock = () => /\bmode=mock\b/i.test(location.search);

// ---------- init ----------
export async function initAPI(){
  if(isMock()){
    enableMock();
    return;
  }
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  const wsURL = `${proto}://${location.host}/ws`;
  try{
    await tryWS(wsURL);
  }catch(e){
    console.warn('WS connect failed, switching to mock mode:', e);
    enableMock();
  }
}

async function tryWS(url){
  ws = new WebSocket(url);
  await new Promise((res, rej)=>{
    const to = setTimeout(()=> rej(new Error('WS timeout')), 4000);
    ws.onopen = ()=>{ clearTimeout(to); wsOpen = true; res(); };
    ws.onerror = (err)=>{ clearTimeout(to); rej(err); };
  });

  ws.onmessage = (ev)=>{
    try{
      const m = JSON.parse(ev.data);
      if(m.type === 'telemetry') emitTel(m);
      else if(m.type === 'cycle') emitCycle();
      else if(m.type === 'event') emitEvt(m);
      else if(m.type === 'auto-delay'){
        state.autoDelay.currentMs = m.value;
        saveState();
        emitEvt({ ev:'auto-delay', value:m.value });
      }
    }catch(e){
      console.warn('WS parse error', e);
    }
  };

  ws.onclose = ()=>{ wsOpen = false; };
}

function send(obj){
  if(ws && wsOpen){
    try{ ws.send(JSON.stringify(obj)); }catch(e){ /* noop */ }
  }
}

// ---------- mock ----------
function enableMock(){
  state.mock = true; saveState();
  // plausible numbers
  setInterval(()=>{
    emitTel({
      flow: (Math.random()*4+6),        // 6..10 L/min
      pressure: (Math.random()*1.2+1.5),// 1.5..2.7 bar
      speed: (Math.random()*3+6)        // 6..9 km/h
    });
  }, 900);

  // cycles “tick”
  setInterval(()=>{
    // update lastDelivered and deviation a bit
    const tgt = Math.max(5, state.targetMl || 100);
    state.units.forEach(u=>{
      if(!u.enabled) return;
      if(state.tramline[u.id] || state.tramline[String(u.id)]) return;
      const dev = (Math.random()*0.10 - 0.05); // ±5%
      const ml = Math.max(0, Math.round(tgt * (1+dev)));
      u.lastDeliveredMl = ml;
      u.deviation = (ml - tgt) / tgt;
      const absd = Math.abs(u.deviation || 0);
      u.status = absd<=0.05 ? 'OK' : absd<=0.10 ? 'WARN' : absd<=0.15 ? 'INSPECT' : 'BLOCKED';
    });
    saveState();
    emitCycle();
  }, 1500);
}

// ---------- high-level controls ----------
export function setTargetMl(v){
  state.targetMl = +v; saveState();
  send({ type:'set', key:'target', value:+v });
}
export function setRunning(b){
  state.running = !!b; saveState();
  send({ type:'set', key:'running', value:!!b });
}
export function setSimulation(on, mode='telemetry'){
  state.simulation = !!on; saveState();
  send({ type:'simulate', mode, on:!!on });
}

// Tramline (temporary per-unit ignore)
export function setTramline(id, off){
  state.tramline[id] = !!off; saveState();
  send({ type:'tram', id, off:!!off });
  return Promise.resolve();
}
export function clearTramline(){
  state.tramline = {}; saveState();
  send({ type:'tram-clear' });
}

// Units & settings
export function setUnitEnabled(id, en){
  const u = state.units.find(x=>x.id===id);
  if(u){ u.enabled = !!en; saveState(); send({type:'set', key:'unit-enabled', id, value:!!en}); }
}
export function assignMomentary(id, name){
  const u = state.units.find(x=>x.id===id);
  if(u){ u.momentary = name; saveState(); send({type:'set', key:'unit-momentary', id, value:name});}
}
export function setGroup(id, g){
  const u = state.units.find(x=>x.id===id);
  if(u){ u.group = (g==='B'?'B':'A'); saveState(); send({type:'set', key:'unit-group', id, value:u.group});}
}
export function setOffset(id, p){
  const u = state.units.find(x=>x.id===id);
  if(u){ u.offset = +p; saveState(); send({type:'set', key:'unit-offset', id, value:+p});}
}

// NEW: per-unit timing delay (ms)
export function setUnitDelayMs(id, ms){
  const u = state.units.find(x=>x.id===id);
  if(u){ u.perDelayMs = +ms; saveState(); send({type:'set', key:'unit-delay-ms', id, value:+ms}); }
}

// Delivery mode & per-unit overrides
export function setDeliveryMode(m){
  state.deliveryMode = (m==='timed' ? 'timed' : 'flow'); saveState();
  send({ type:'set', key:'delivery-mode', value: state.deliveryMode });
}
export function setUnitMode(id, m){
  const u = state.units.find(x=>x.id===id);
  if(u){
    u.mode = (m==='flow'||m==='timed') ? m : 'inherit';
    saveState();
    send({ type:'set', key:'unit-delivery-mode', id, value: u.mode });
  }
}
export function setPulsesPerCycle(id, v){
  const u = state.units.find(x=>x.id===id);
  if(u){
    u.pulsesPerCycle = Math.max(1, +v); saveState();
    send({ type:'set', key:'unit-ppc', id, value: u.pulsesPerCycle });
  }
}
export function setUnitMsPerMl(id, v){
  const u = state.units.find(x=>x.id===id);
  if(u){
    u.msPerMl = Math.max(0.1, +v); saveState();
    send({ type:'set', key:'unit-msperml', id, value: u.msPerMl });
  }
}

// Auto diamond delay cfg
export function setAutoDiamond(cfg){
  state.autoDelay = { ...(state.autoDelay||{}), ...(cfg||{}) };
  saveState();
  send({ type:'set', key:'auto-delay', value: cfg });
}

// Calibration (GUI-driven; Brain logs/acts)
export function startTimedSquirt(unitId, ms=5000){
  send({ type:'cal', mode:'timed', cmd:'start', id:unitId, ms });
}
export function stopTimedSquirt(unitId){
  send({ type:'cal', mode:'timed', cmd:'stop', id:unitId });
}
export function startFlowCal(unitId, targetMl=1000){
  send({ type:'cal', mode:'flow', cmd:'start', id:unitId, targetMl });
}


// Per-unit K-factor (pulses per liter)
export function setUnitKFactor(id, ppl){
  const val = Math.max(1, parseInt(ppl||'450',10));
  send({ type:'set', key:'unit-kfactor', id, value: val });
}
// GPIO & buzzer
export function setGpio(name, pin){
  send({ type:'set', key:'gpio', name, pin });
}
export function setBuzzerMute(muted){
  state.buzzer.muted = !!muted; saveState();
  send({ type:'set', key:'buzzer-muted', value: !!muted });
}
export function setBuzzerHardMute(off){
  state.buzzer.hardMute = !!off; saveState();
  send({ type:'set', key:'buzzer-hardmute', value: !!off });
}

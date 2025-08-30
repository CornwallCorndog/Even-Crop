// state.js — GUI-side state (mirrors Brain schema where practical)

const STORE_KEY = 'ec_state';

export const state = loadState();

// ---------- defaults & migrations ----------

function defaultUnits(){
  return Array.from({length:11}, (_,i)=>({
    id: i+1,
    enabled: i < 4,              // first 4 enabled by default
    group: (i % 2 === 0) ? 'A' : 'B',
    momentary: 'M1',
    offset: 0,                   // legacy per-unit % (0..100)
    perDelayMs: 0,               // NEW: per-unit delay (ms)
    lastDeliveredMl: null,
    deviation: null,             // fraction +/- (e.g., 0.05 = +5%)
    status: 'OK',                // OK|WARN|INSPECT|BLOCKED
    pulsesPerCycle: 100,
    msPerMl: 5,
    mode: 'inherit'              // inherit|flow|timed
  }));
}

function defaultState(){
  return {
    targetMl: 100,
    running: false,
    deliveryMode: 'flow',        // flow|timed
    momentary: {
      M1:{enabled:true, offset:0},
      M2:{enabled:false, offset:0},
      M3:{enabled:false, offset:0}
    },
    tramline: {},                // {unitId:true} => temp OFF
    tramPresets: { left:[], right:[], active:null }, // NEW
    buzzer: { muted:false, hardMute:false },         // NEW
    autoDelay: { enabled:true, manualMs:500, geomLeadMs:0, currentMs:500 },
    units: defaultUnits(),
    eventLog: [],
    logPage: 0,
    simulation: false,
    lang: localStorage.getItem('ec_lang') || 'en'
  };
}

function migrate(s){
  const st = s && typeof s === 'object' ? s : {};
  // top-level
  if(!('targetMl' in st)) st.targetMl = 100;
  if(!('running' in st)) st.running = false;
  if(!('deliveryMode' in st)) st.deliveryMode = 'flow';
  if(!st.momentary) st.momentary = { M1:{enabled:true,offset:0}, M2:{enabled:false,offset:0}, M3:{enabled:false,offset:0} };
  if(!st.tramline) st.tramline = {};
  if(!st.tramPresets) st.tramPresets = { left:[], right:[], active:null };
  if(!st.buzzer) st.buzzer = { muted:false, hardMute:false };
  if(!st.autoDelay) st.autoDelay = { enabled:true, manualMs:500, geomLeadMs:0, currentMs:500 };
  if(st.autoDelay && typeof st.autoDelay.currentMs !== 'number'){
    st.autoDelay.currentMs = st.autoDelay.manualMs ?? 500;
  }
  if(!Array.isArray(st.units)) st.units = defaultUnits();
  if(!Array.isArray(st.eventLog)) st.eventLog = [];
  if(typeof st.logPage !== 'number') st.logPage = 0;
  if(typeof st.simulation !== 'boolean') st.simulation = false;
  if(!st.lang) st.lang = localStorage.getItem('ec_lang') || 'en';

  // per-unit migration
  st.units.forEach(u=>{
    if(typeof u.enabled !== 'boolean') u.enabled = true;
    if(!u.group) u.group = 'A';
    if(!u.momentary) u.momentary = 'M1';
    if(typeof u.offset !== 'number') u.offset = 0;
    if(typeof u.perDelayMs !== 'number') u.perDelayMs = 0;
    if(!('lastDeliveredMl' in u)) u.lastDeliveredMl = null;
    if(!('deviation' in u)) u.deviation = null;
    if(!u.status) u.status = 'OK';
    if(typeof u.pulsesPerCycle !== 'number') u.pulsesPerCycle = 100;
    if(typeof u.msPerMl !== 'number') u.msPerMl = 5;
    if(!u.mode) u.mode = 'inherit';
  });

  return st;
}

// ---------- persistence ----------

export function saveState(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }catch(e){
    console.warn('state: save failed', e);
  }
}

export function loadState(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  }catch(e){
    console.warn('state: load error, resetting', e);
    return defaultState();
  }
}

export function logEvent(msg){
  state.eventLog.push({ t: Date.now(), msg });
  if(state.eventLog.length > 300) state.eventLog.shift();
  saveState();
}

// Utility: enabled units with sequential index for dashboard labels
export function getEnabledUnits(){
  const arr = state.units.filter(u=>u.enabled).slice().sort((a,b)=>a.id-b.id);
  return arr.map((u, i)=> ({ ...u, seq: i+1 }));
}

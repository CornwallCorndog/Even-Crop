// app.js — tiny router + view mounting

import { mountDashboard } from './ui.dashboard.js';
import { mountCalibration } from './ui.calibration.js';
import { mountSettings } from './ui.settings.js';
import { mountGPIO } from './ui.gpio.js';

let currentRoute = 'dashboard';
const routes = new Set(['dashboard','calibration','settings','gpio']);

function getRoot(){
  const el = document.getElementById('view');
  if(!el) throw new Error('#view not found');
  return el;
}

export function navigate(route){
  if(!routes.has(route)) route = 'dashboard';
  currentRoute = route;
  mount(route);
  // also toggle active tab if user navigates programmatically
  const tabs = document.querySelectorAll('.tabs .tab');
  tabs.forEach(b => b.classList.toggle('active', b.dataset.route === route));
}

export function mount(route = currentRoute){
  const root = getRoot();
  // clear current view
  root.innerHTML = '';

  switch(route){
    case 'dashboard':
      mountDashboard(root);
      document.title = 'Even Crop — Dashboard';
      break;
    case 'calibration':
      mountCalibration(root);
      document.title = 'Even Crop — Calibration';
      break;
    case 'settings':
      mountSettings(root);
      document.title = 'Even Crop — Settings';
      break;
    case 'gpio':
      mountGPIO(root);
      document.title = 'Even Crop — GPIO';
      break;
    default:
      mountDashboard(root);
      document.title = 'Even Crop — Dashboard';
  }

  // accessibility: move focus to view for screen readers
  try{ root.focus({preventScroll:true}); }catch(e){}
}

// Keyboard shortcuts: Ctrl+1..4 to switch tabs
window.addEventListener('keydown', (e)=>{
  if(e.ctrlKey && !e.shiftKey && !e.altKey){
    if(e.key === '1') navigate('dashboard');
    else if(e.key === '2') navigate('calibration');
    else if(e.key === '3') navigate('settings');
    else if(e.key === '4') navigate('gpio');
  }
});

// Expose for debugging (optional)
window.__ec_nav = navigate;

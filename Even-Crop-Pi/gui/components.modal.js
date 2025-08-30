// components.modal.js — small modal helper toolkit

/**
 * openCustomModal({
 *   title: 'Title',
 *   render(api){ ... append to api.body ... },
 *   escClose: true,
 *   clickBackdropToClose: true
 * }) -> api
 *
 * api = {
 *   el, back, body,
 *   close(), destroy(),
 *   setConfirm(fn, opts?), setCancel(fn, opts?)
 * }
 *
 * Usage example:
 *   const m = openCustomModal({
 *     title:'Adjust',
 *     render(api){
 *       const input = document.createElement('input');
 *       input.type='number'; api.body.appendChild(input);
 *       api.setConfirm(()=> { console.log(input.value); return true; }, {label:'Save', close:true});
 *     }
 *   });
 */
export function openCustomModal(opts={}){
  const escClose = opts.escClose !== false;
  const clickBackdropToClose = opts.clickBackdropToClose !== false;

  // Backdrop
  const back = document.createElement('div');
  back.className = 'modalBack show';
  back.id = 'modalBack';

  // Dialog
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  // Header
  const h4 = document.createElement('h4');
  h4.id = 'modalTitle';
  h4.textContent = opts.title || 'Dialog';
  modal.appendChild(h4);

  // Body container
  const body = document.createElement('div');
  body.id = 'modalBody';
  modal.appendChild(body);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn';
  btnCancel.textContent = (opts.cancelLabel || 'Cancel');

  const btnOk = document.createElement('button');
  btnOk.className = 'btn primary';
  btnOk.textContent = (opts.confirmLabel || 'OK');

  actions.appendChild(btnCancel);
  actions.appendChild(btnOk);
  modal.appendChild(actions);

  // Mount
  back.appendChild(modal);
  document.body.appendChild(back);

  // Focus management
  const prevActive = document.activeElement;
  const focusFirst = ()=> {
    // try to focus first input/button in body; otherwise OK
    const cand = modal.querySelector('input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
    (cand || btnOk).focus({preventScroll:true});
  };
  setTimeout(focusFirst, 0);

  const api = {
    back, el: modal, body,
    close(){
      back.classList.remove('show');
      try{ document.body.removeChild(back); }catch(_){}
      if(prevActive && prevActive.focus) { try{ prevActive.focus({preventScroll:true}); }catch(_){} }
    },
    destroy(){ this.close(); },
    setConfirm(handler, opt={}){
      if(typeof handler !== 'function') return;
      if(opt.label) btnOk.textContent = opt.label;
      btnOk.onclick = ()=>{
        const res = handler();
        if(res !== false && opt.close !== false) api.close();
      };
    },
    setCancel(handler, opt={}){
      if(opt && opt.label) btnCancel.textContent = opt.label;
      btnCancel.onclick = ()=>{
        if(typeof handler === 'function') handler();
        api.close();
      };
    }
  };

  // Defaults if user didn't set handlers
  api.setCancel(null, {label: (opts.cancelLabel || 'Cancel')});
  api.setConfirm(()=>true, {label: (opts.confirmLabel || 'OK')});

  // Backdrop/ESC close
  if(clickBackdropToClose){
    back.addEventListener('click', (e)=>{
      if(e.target === back) api.close();
    });
  }
  if(escClose){
    const onKey = (e)=>{
      if(e.key === 'Escape'){ api.close(); }
    };
    document.addEventListener('keydown', onKey, {once:true});
  }

  // Let caller render body
  try{
    if(typeof opts.render === 'function'){
      opts.render(api);
    }
  }catch(e){
    console.error('modal render error', e);
  }

  return api;
}

/**
 * openRangeModal({title, value, min, max, step}) -> Promise<number>
 * Simple numeric editor with +/- buttons.
 */
export function openRangeModal({title='Set value', value=0, min=0, max=100, step=1}={}){
  return new Promise((resolve, reject)=>{
    const m = openCustomModal({
      title,
      render(api){
        const wrap = document.createElement('div');
        wrap.innerHTML = `
          <p class="hint">Tap +/- or type a value.</p>
          <div class="row">
            <button class="btn" id="dec">−</button>
            <input id="val" type="number" style="width:140px;font-size:1.2rem"
                   value="${value}" min="${min}" max="${max}" step="${step}">
            <button class="btn" id="inc">+</button>
          </div>
        `;
        api.body.appendChild(wrap);
        const inp = wrap.querySelector('#val');
        wrap.querySelector('#dec').onclick = ()=>{ inp.stepDown(); };
        wrap.querySelector('#inc').onclick = ()=>{ inp.stepUp(); };
        api.setConfirm(()=>{
          let v = parseFloat(inp.value);
          if(Number.isNaN(v)) return false;
          if(v < min) v = min;
          if(v > max) v = max;
          resolve(v);
          return true;
        }, {label:'Save', close:true});
        api.setCancel(()=> reject(new Error('cancel')));
      }
    });
  });
}

/**
 * openKeypadModal({title='Enter PIN', maxLen=6, mask=true}) -> Promise<string>
 * Numeric keypad for PIN entry (used by GPIO page).
 */
export function openKeypadModal({title='Enter PIN', maxLen=6, mask=true}={}){
  return new Promise((resolve, reject)=>{
    const m = openCustomModal({
      title,
      render(api){
        const box = document.createElement('div');
        box.innerHTML = `
          <div class="row" style="justify-content:center; margin-bottom:10px;">
            <input id="pin" type="${mask?'password':'text'}" inputmode="numeric" pattern="[0-9]*"
                   maxlength="${maxLen}" style="font-size:1.4rem; text-align:center; width:180px;">
          </div>
          <div class="keypad">
            ${[1,2,3,4,5,6,7,8,9,'←',0,'✓'].map(k=>`<button class="btn${k==='✓'?' primary':''}" data-k="${k}">${k}</button>`).join('')}
          </div>
        `;
        api.body.appendChild(box);
        const inp = box.querySelector('#pin');
        const keys = box.querySelectorAll('button[data-k]');
        keys.forEach(b=> b.onclick = ()=>{
          const k = b.getAttribute('data-k');
          if(k === '←'){ inp.value = inp.value.slice(0,-1); return; }
          if(k === '✓'){
            const v = inp.value.trim();
            if(!v) return;
            resolve(v); return api.close();
          }
          if(/\d/.test(k) && inp.value.length < maxLen){ inp.value += k; }
          inp.focus();
        });
        api.setConfirm(()=>{
          const v = inp.value.trim();
          if(!v) return false;
          resolve(v);
          return true;
        }, {label:'OK', close:true});
        api.setCancel(()=> reject(new Error('cancel')));
        setTimeout(()=> inp.focus(), 0);
      }
    });
  });
}

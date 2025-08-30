// i18n.js — tiny client-side translations with .lng JSON files
// Usage:
//  - currentLang() -> "en" | "lt"
//  - await setLang("lt")
//  - applyTranslations(document.body)
//  - t("key") -> string

const STORE_KEY = "ec_lang";
const CACHE = {}; // { lang: {key:value} }

export function currentLang(){
  return localStorage.getItem(STORE_KEY) || "en";
}

export async function setLang(lang){
  localStorage.setItem(STORE_KEY, lang);
  await loadLanguage(lang);
}

export async function loadLanguage(lang){
  if(CACHE[lang]) return CACHE[lang];
  const url = `./i18n/${lang}.lng`;
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok){
    console.warn("i18n: failed to load", url, res.status);
    CACHE[lang] = {};
    return CACHE[lang];
  }
  try{
    const data = await res.json();
    CACHE[lang] = data || {};
    return CACHE[lang];
  }catch(e){
    console.error("i18n: parse error", e);
    CACHE[lang] = {};
    return CACHE[lang];
  }
}

export function t(key, fallback){
  const lang = currentLang();
  const dict = CACHE[lang] || {};
  return dict[key] ?? fallback ?? key;
}

// Apply translations to any element under root with [data-i18n].
// If element has data-i18n-attr="placeholder|title|value", set that attribute
// instead of textContent.
export function applyTranslations(root){
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach(el=>{
    const key = el.getAttribute("data-i18n");
    const which = el.getAttribute("data-i18n-attr");
    const val = t(key);
    if(which){
      // support multiple attributes: data-i18n-attr="placeholder,title"
      which.split(",").map(s=>s.trim()).forEach(attr=>{
        try{ el.setAttribute(attr, val); }catch(_e){}
      });
    }else{
      // default to textContent (preserve any child structure only if empty)
      if(el.children.length === 0){
        el.textContent = val;
      }else{
        // if the element has children, try a [data-i18n-target] child first
        const tgt = el.querySelector("[data-i18n-target]");
        if(tgt){ tgt.textContent = val; }
        else { el.setAttribute("aria-label", val); }
      }
    }
  });
}

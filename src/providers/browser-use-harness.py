import json
import os
import re
import time

PARAMS = json.loads(os.environ.get("VENTI_BU_PARAMS", "{}"))
OP = os.environ.get("VENTI_BU_OP", "")

def emit(ok, result=None, error=None):
    payload = {"ok": ok}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    print("__VENTI_BROWSER_USE_RESULT__" + json.dumps(payload, ensure_ascii=False), flush=True)

def normalize(value):
    return " ".join(str(value or "").split())

def role_selector(role):
    return {
        "button": 'button,[role="button"]',
        "link": 'a,[role="link"]',
        "heading": 'h1,h2,h3,h4,h5,h6,[role="heading"]',
        "textbox": 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"],[role="textbox"]',
        "checkbox": 'input[type="checkbox"],[role="checkbox"]',
        "radio": 'input[type="radio"],[role="radio"]',
        "combobox": 'select,input,[role="combobox"]',
        "listbox": 'select,[role="listbox"]',
        "option": 'option,[role="option"]',
        "img": 'img,[role="img"]',
        "region": 'main,section,article,[role="region"]',
    }.get(role, '[role="' + str(role).replace('"', '\\"') + '"]')

def css_path(locator):
    locator = locator or {}
    if locator.get("css"):
        return locator["css"]
    if locator.get("xpath"):
        raise RuntimeError("XPath locators require a custom Browser Use bridge")
    payload = json.dumps(locator, ensure_ascii=False)
    role = json.dumps(role_selector(locator.get("role", "")))
    expression = r"""(()=> {
      const l=PAYLOAD;
      const roleSelector=ROLE_SELECTOR;
      const norm=(v)=>String(v||'').replace(/\s+/g,' ').trim();
      const name=(e)=>norm(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.value||e.getAttribute('alt')||'');
      const exact=l.exact === true;
      const matches=(e,needle)=>{ const n=name(e); return exact ? n===String(needle) : n.includes(String(needle)); };
      const path=(e)=>{
        if(!e) return null;
        if(e.id) return '#'+CSS.escape(e.id);
        const parts=[];
        while(e && e.nodeType===1 && e!==document.body){
          let p=e.tagName.toLowerCase();
          let i=1, s=e;
          while((s=s.previousElementSibling)) if(s.tagName===e.tagName) i++;
          p += ':nth-of-type('+i+')';
          parts.unshift(p); e=e.parentElement;
        }
        return parts.join(' > ');
      };
      let candidates=[];
      if(l.test_id) candidates=[...document.querySelectorAll('[data-testid="'+CSS.escape(l.test_id)+'"],[data-test-id="'+CSS.escape(l.test_id)+'"]')];
      else if(l.placeholder) candidates=[...document.querySelectorAll('[placeholder="'+CSS.escape(l.placeholder)+'"]')];
      else if(l.alt) candidates=[...document.querySelectorAll('[alt]')].filter(e=>matches(e,l.alt));
      else if(l.title) candidates=[...document.querySelectorAll('[title]')].filter(e=>matches(e,l.title));
      else if(l.label){
        const label=[...document.querySelectorAll('label')].find(e=>matches(e,l.label));
        if(label){ const id=label.htmlFor; candidates=id?[document.getElementById(id)]:[label.querySelector('input,textarea,select,[contenteditable="true"]')].filter(Boolean); }
      } else if(l.role) candidates=[...document.querySelectorAll(roleSelector)].filter(e=>matches(e,l.name||l.role));
      else if(l.text) candidates=[...document.querySelectorAll('body *')].filter(e=>norm(e.innerText)===String(l.text)||norm(e.innerText).includes(String(l.text))).sort((a,b)=>norm(a.innerText).length-norm(b.innerText).length);
      else if(l.name) candidates=[...document.querySelectorAll('body *')].filter(e=>matches(e,l.name));
      const e=candidates.filter(Boolean)[Math.max(0,Number(l.nth||0))];
      return path(e);
    })()"""
    expression = expression.replace("PAYLOAD", payload).replace("ROLE_SELECTOR", role)
    selector = js(expression)
    if not selector:
        raise RuntimeError("Element not found for locator: " + json.dumps(locator, ensure_ascii=False))
    return selector

def rect(selector):
    raw = js("(()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,visible:!!(r.width&&r.height)})})()")
    return json.loads(raw) if isinstance(raw, str) else raw

def point(locator):
    selector = css_path(locator)
    value = rect(selector)
    if not value:
        raise RuntimeError("Element has no visible box: " + selector)
    return selector, value

def press_value(key):
    parts = str(key).split("+")
    base = parts[-1]
    modifiers = 0
    for part in parts[:-1]:
        modifiers |= {"ALT": 1, "CTRL": 2, "CONTROL": 2, "CMD": 4, "META": 4, "SHIFT": 8}.get(part.upper(), 0)
    return base, modifiers

try:
    if OP == "open":
        ensure_real_tab()
        goto_url(PARAMS["url"])
        wait_for_load()
        result = page_info()
    elif OP == "reload":
        current = page_info().get("url", "about:blank")
        goto_url(current)
        wait_for_load()
        result = page_info()
    elif OP == "observe":
        ensure_real_tab()
        info = page_info()
        text = js("document.body.innerText") or ""
        nodes = cdp("Accessibility.getFullAXTree").get("nodes", [])
        snapshot = "\n".join((str(n.get("role", {}).get("value", "")) + " " + str(n.get("name", {}).get("value", ""))).strip() for n in nodes if n.get("role", {}).get("value") or n.get("name", {}).get("value"))
        result = {"provider": "browser-use", "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": info.get("url", ""), "title": info.get("title", ""), "text": text, "snapshot": snapshot}
    elif OP == "snapshot":
        result = (json.loads(json.dumps({"snapshot": (js("document.body.innerText") or "")})))["snapshot"]
    elif OP == "click":
        selector, value = point(PARAMS["locator"])
        click_at_xy(value["x"], value["y"])
        result = {"selector": selector}
    elif OP == "fill":
        selector = css_path(PARAMS["locator"])
        fill_input(selector, PARAMS.get("value", ""), clear_first=True, timeout=5)
        result = {"selector": selector}
    elif OP == "type":
        selector, value = point(PARAMS["locator"])
        click_at_xy(value["x"], value["y"])
        type_text(PARAMS.get("value", ""))
        result = {"selector": selector}
    elif OP == "press":
        locator = PARAMS.get("locator")
        if locator:
            selector, value = point(locator)
            click_at_xy(value["x"], value["y"])
        base, modifiers = press_value(PARAMS["key"])
        press_key(base, modifiers=modifiers)
        result = {}
    elif OP == "select":
        selector, value = point(PARAMS["locator"])
        js("(()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return false;e.value=" + json.dumps(PARAMS["value"]) + ";e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
        result = {"selector": selector}
    elif OP == "upload":
        selector = css_path(PARAMS["locator"])
        upload_file(selector, PARAMS["path"])
        result = {"selector": selector}
    elif OP == "scroll":
        direction = PARAMS.get("direction", "down")
        amount = int(PARAMS.get("amount", 600))
        scroll(0, 0, dy=(-amount if direction == "up" else amount if direction == "down" else 0), dx=(-amount if direction == "left" else amount if direction == "right" else 0))
        result = {}
    elif OP == "waitFor":
        condition = PARAMS["condition"]
        timeout = float(condition.get("timeout_ms", 30000)) / 1000
        deadline = time.time() + timeout
        if "load" in condition:
            wait_for_load(timeout=timeout)
        elif "text" in condition:
            while time.time() < deadline and str(condition["text"]) not in (js("document.body.innerText") or ""):
                time.sleep(0.25)
            if str(condition["text"]) not in (js("document.body.innerText") or ""):
                raise RuntimeError("Text not found: " + str(condition["text"]))
        elif "visible" in condition:
            selector = css_path(condition["visible"].get("by", condition["visible"]))
            if not wait_for_element(selector, timeout=timeout, visible=True):
                raise RuntimeError("Element not visible: " + selector)
        elif "url_matches" in condition:
            while time.time() < deadline and str(condition["url_matches"]) not in page_info().get("url", ""):
                time.sleep(0.25)
            if str(condition["url_matches"]) not in page_info().get("url", ""):
                raise RuntimeError("URL pattern not found")
        else:
            raise RuntimeError("Unsupported wait condition")
        result = {}
    elif OP == "screenshot":
        capture_screenshot(PARAMS["path"], full=True)
        result = {"path": PARAMS["path"]}
    elif OP == "isVisible":
        selector = css_path(PARAMS["locator"])
        raw = js("(()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !!(r.width&&r.height&&s.visibility!=='hidden'&&s.display!=='none')})()")
        result = bool(raw)
    elif OP == "count":
        selector = css_path(PARAMS["locator"])
        result = int(js("document.querySelectorAll(" + json.dumps(selector) + ").length") or 0)
    elif OP == "value":
        selector = css_path(PARAMS["locator"])
        result = js("(()=>{const e=document.querySelector(" + json.dumps(selector) + ");return e ? (e.value ?? e.textContent ?? '') : null})()")
    elif OP == "close":
        result = {}
    else:
        raise RuntimeError("Unsupported Browser Use operation: " + OP)
    emit(True, result=result)
except Exception as error:
    emit(False, error={"code": "BROWSER_USE_OPERATION_FAILED", "message": str(error), "retryable": False})

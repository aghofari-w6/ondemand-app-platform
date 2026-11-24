/**
 * The embeddable web chat widget: a small launcher script for the host page and a
 * self-contained chat document shown in an iframe. No framework and no build step, so
 * the tenant's site loads one small script. WCAG 2.1 AA: labelled controls, a live
 * message log, visible focus, 44 px targets, and readable text on any accent colour.
 */

/** `<script async src="…/widget.js" data-key="wk_…">`: adds a launcher button and the chat iframe. */
export const WIDGET_JS = String.raw`(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key || window.__aodWidget) return;
  window.__aodWidget = true;
  var base = new URL(script.src).origin;
  var identity = '';
  if (script.getAttribute('data-user-id') && script.getAttribute('data-user-hash')) {
    identity = '&user_id=' + encodeURIComponent(script.getAttribute('data-user-id')) + '&user_hash=' + encodeURIComponent(script.getAttribute('data-user-hash'));
  }
  var frame = document.createElement('iframe');
  frame.title = 'Chat with us';
  frame.src = base + '/widget/frame?key=' + encodeURIComponent(key) + identity;
  frame.style.cssText = 'position:fixed;right:16px;bottom:76px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));border:1px solid #c9ced6;border-radius:12px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.18);z-index:2147483646;display:none';
  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Chat with us';
  button.setAttribute('aria-expanded', 'false');
  button.style.cssText = 'position:fixed;right:16px;bottom:16px;min-height:48px;padding:0 20px;border:2px solid #fff;border-radius:24px;background:#1b1f27;color:#fff;font:600 16px system-ui,sans-serif;cursor:pointer;z-index:2147483647';
  button.addEventListener('click', function () {
    var open = frame.style.display === 'none';
    frame.style.display = open ? 'block' : 'none';
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Close chat' : 'Chat with us';
    if (open) frame.contentWindow && frame.contentWindow.postMessage({ type: 'aod-widget-open' }, base);
  });
  document.body.appendChild(frame);
  document.body.appendChild(button);
})();`;

const FRAME_CSS = `
:root { --accent: #2856D9; --on-accent: #ffffff; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; font: 16px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1b1f27; background: #ffffff; }
header { padding: 12px 16px; background: var(--accent); color: var(--on-accent); }
h1 { margin: 0; font-size: 1.05rem; }
header p { margin: 2px 0 0; font-size: .875rem; }
main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#log { flex: 1; overflow-y: auto; margin: 0; padding: 12px 16px; }
#log .msg { margin: 0 0 10px; max-width: 85%; padding: 8px 12px; border-radius: 12px; background: #eef0f4; color: #1b1f27; overflow-wrap: anywhere; white-space: pre-wrap; }
#log .msg.you { margin-left: auto; background: #1b1f27; color: #ffffff; }
#log .msg .who { display: block; font-size: .75rem; font-weight: 600; }
#log .msg .cite { display: block; margin-top: 4px; font-size: .75rem; }
#status { min-height: 1.4em; margin: 0; padding: 0 16px; font-size: .875rem; color: #4a5160; }
form { display: flex; gap: 8px; align-items: flex-end; padding: 10px 16px 14px; border-top: 1px solid #c9ced6; }
form.email { border-top: 0; padding-bottom: 0; }
.field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
label { font-size: .875rem; font-weight: 600; }
textarea, input { width: 100%; min-height: 44px; padding: 10px; border: 1px solid #6b7280; border-radius: 8px; font: inherit; color: inherit; background: #ffffff; resize: none; }
button { min-height: 44px; min-width: 44px; padding: 0 16px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
button.quiet { background: #ffffff; color: #1b1f27; border: 1px solid #6b7280; }
button:disabled { opacity: .6; cursor: default; }
:focus-visible { outline: 3px solid #1b1f27; outline-offset: 2px; box-shadow: 0 0 0 5px #ffffff; }
[hidden] { display: none !important; }
`;

const FRAME_JS = String.raw`(function () {
  var q = new URLSearchParams(location.search);
  var key = q.get('key') || '';
  var store = 'aod-widget:' + key;
  var log = document.getElementById('log');
  var status = document.getElementById('status');
  var form = document.getElementById('send');
  var input = document.getElementById('text');
  var emailForm = document.getElementById('email-form');
  var emailInput = document.getElementById('email');
  var token = null, lastSeq = 0, source = null, seen = {};
  function say(t) { status.textContent = t; }
  function readable(hex) {
    var n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
    var l = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    return (1.05) / (l + .05) >= (l + .05) / .05 ? '#ffffff' : '#111318';
  }
  function api(path, body) {
    return fetch('/widget/api/' + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.message || 'Something went wrong'); return d; }); });
  }
  function add(m) {
    if (seen[m.id]) return;
    seen[m.id] = true;
    lastSeq = Math.max(lastSeq, m.seq);
    var li = document.createElement('div');
    li.className = m.from === 'you' ? 'msg you' : 'msg them';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.from === 'you' ? 'You' : m.from === 'bot' ? 'Assistant' : m.from === 'system' ? 'Update' : 'Support';
    li.appendChild(who);
    li.appendChild(document.createTextNode(m.body));
    if (m.citations && m.citations.length) {
      var c = document.createElement('span');
      c.className = 'cite';
      c.textContent = 'Source: ' + m.citations.map(function (x) { return '[' + x.n + '] ' + x.title; }).join('; ');
      li.appendChild(c);
    }
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }
  function refresh() {
    return api('messages?after=' + lastSeq).then(function (d) { d.messages.forEach(add); });
  }
  function listen() {
    if (source) source.close();
    source = new EventSource('/widget/api/events?token=' + encodeURIComponent(token));
    source.addEventListener('changed', function () { refresh().catch(function () {}); });
    source.addEventListener('ready', function () { refresh().catch(function () {}); });
  }
  function start() {
    var saved = null;
    try { saved = localStorage.getItem(store); } catch (e) { saved = null; }
    var body = { key: key, visitor_token: saved || undefined };
    if (q.get('user_id') && q.get('user_hash')) body.identity = { user_id: q.get('user_id'), hash: q.get('user_hash') };
    fetch('/widget/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.message || 'Chat is unavailable'); return d; }); })
      .then(function (d) {
        token = d.token;
        try { localStorage.setItem(store, d.token); } catch (e) { /* private mode: the session lasts for this page */ }
        document.documentElement.style.setProperty('--accent', d.config.accent);
        document.documentElement.style.setProperty('--on-accent', readable(d.config.accent));
        document.getElementById('greeting').textContent = d.config.greeting;
        emailForm.hidden = d.has_email || d.verified;
        form.querySelector('button').disabled = false;
        say('');
        return refresh().then(listen);
      })
      .catch(function (e) { say(e.message); });
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || !token) return;
    var button = form.querySelector('button');
    button.disabled = true;
    api('messages', { text: text })
      .then(function (d) { input.value = ''; add(d.message); say('Sent'); })
      .catch(function (e) { say(e.message); })
      .then(function () { button.disabled = false; input.focus(); });
  });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
  });
  emailForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('email', { email: emailInput.value.trim() })
      .then(function () { emailForm.hidden = true; say('Thanks. We will email you if you leave the chat.'); })
      .catch(function (e) { say(e.message); });
  });
  window.addEventListener('pagehide', function () { if (source) source.close(); });
  start();
})();`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The chat document. Scripts and styles carry a per-response nonce (CSP allows nothing else). */
export function widgetFrameHtml(nonce: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} chat</title>
<style nonce="${nonce}">${FRAME_CSS}</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p id="greeting">Hi! How can we help?</p>
</header>
<main>
<div id="log" role="log" aria-live="polite" aria-label="Messages" tabindex="0"></div>
<p id="status" role="status">Connecting…</p>
<form id="email-form" class="email" hidden>
<div class="field"><label for="email">Your email (optional, so we can follow up)</label><input id="email" type="email" autocomplete="email" maxlength="200" required></div>
<button type="submit" class="quiet">Save</button>
</form>
<form id="send">
<div class="field"><label for="text">Your message</label><textarea id="text" rows="2" maxlength="2000" required></textarea></div>
<button type="submit" disabled>Send</button>
</form>
</main>
<script nonce="${nonce}">${FRAME_JS}</script>
</body>
</html>`;
}

/** A stand-in for the tenant's website (demo and e2e): one page that embeds the widget script. */
export function widgetDemoHtml(key: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}: widget demo page</title>
</head>
<body style="font:16px/1.5 system-ui,sans-serif;color:#1b1f27;background:#f6f7f9;margin:0;padding:32px">
<main>
<h1>${esc(title)}</h1>
<p>This page stands in for your website. The chat button in the corner is the embedded widget.</p>
</main>
<script async src="/widget.js" data-key="${esc(key)}"></script>
</body>
</html>`;
}

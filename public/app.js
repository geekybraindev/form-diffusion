// app.js — Form Diffusion
// Pipeline: snapDOM(form) -> 704x704 JPEG -> FLUX 2 Klein realtime (img2img) -> <canvas>
// The real <form> stays on top, fully accessible. "Overlay" makes it transparent.

const STYLE_PROMPTS = {
  playdoh:   'Turn this sign-up form into a scene sculpted entirely from colorful Play-Doh modeling clay, soft fingerprints, squishy rounded letters, studio light',
  lego:      'Turn this sign-up form into LEGO bricks and minifigure parts, glossy plastic studs, snap-together panels, toy photography',
  cyberpunk: 'Turn this sign-up form into a neon cyberpunk holographic interface, glowing magenta and cyan, rain-slick chrome, Blade Runner UI',
  felt:      'Turn this sign-up form into hand-stitched felt and wool craft, soft fuzzy fabric letters, visible thread, warm cozy lighting',
};

const els = {
  stage:    document.getElementById('stage'),
  canvas:   document.getElementById('paint'),
  capture:  document.getElementById('form-capture'),
  toggleAI: document.getElementById('toggle-ai'),
  overlay:  document.getElementById('toggle-overlay'),
  style:    document.getElementById('style'),
  custom:   document.getElementById('custom-prompt'),
  status:   document.getElementById('status'),
  fps:      document.getElementById('fps'),
  form:     document.getElementById('signup'),
  formMsg:  document.getElementById('form-msg'),
  gate:     document.getElementById('gate'),
  keyInput: document.getElementById('key-input'),
  keySave:  document.getElementById('key-save'),
  keyDemo:  document.getElementById('key-demo'),
};
const ctx = els.canvas.getContext('2d');
const LS_KEY = 'fd_fal_key';

let running = false;
let connection = null;       // fal realtime connection (live mode)
let mode = 'unknown';        // 'live-proxy' | 'live-direct' | 'demo'
let frames = 0, lastFpsT = performance.now();
let inFlight = false;
let falKey = localStorage.getItem(LS_KEY) || '';   // only used when the server has no key

// Self-hosted first — CDN loads are blocked on some of Evan's devices.
async function importFal() {
  for (const src of ['/vendor/fal-client.mjs', 'https://esm.sh/@fal-ai/client']) {
    try { return (await import(src)).fal; } catch (e) { console.warn('fal client import failed from', src, e); }
  }
  throw new Error('could not load the fal client (vendor + CDN both failed)');
}

// ---- config probe: server proxy key > browser key > demo ----
async function detectMode() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.hasFalKey) return 'live-proxy';
    }
  } catch (_) {}
  return falKey ? 'live-direct' : 'demo';
}

// Appended to every prompt. Klein is an instruction-editing model: naming the
// exact labels is what keeps its lettering legible — without this the text
// melts into alphabet soup (A/B-tested against the live endpoint, 2026-07-08).
const COHERENCE = ' Keep the exact same layout with the panel, the three input boxes and the button clearly visible. Every text label must remain exactly as written and clearly legible: "Sign Up", "Name", "Email", "Password", "Create account".';

function currentPrompt() {
  if (els.style.value === 'custom') {
    const theme = els.custom.value.trim();
    // A bare theme word ("sushi") only decorates AROUND the form; wrapping it in
    // the restyle instruction makes the form BE the theme.
    if (theme) return `Turn this sign-up form into a scene made entirely of ${theme} — restyle the panel, input fields and button in that theme.` + COHERENCE;
    return STYLE_PROMPTS.playdoh + COHERENCE;
  }
  return (STYLE_PROMPTS[els.style.value] || STYLE_PROMPTS.playdoh) + COHERENCE;
}
function setStatus(t) { els.status.textContent = t; }

// 1024 matches fal's square_hd output — capturing at the model's native size
// keeps small letterforms sharp end to end.
const SIZE = 1024;

// ---- capture the real form to a SIZE x SIZE JPEG data URI ----
async function captureFrame() {
  const ok = await window.__snapdomReady;
  if (!ok || !window.snapdom) throw new Error('snapDOM unavailable');
  // scale 2 = crisp letterforms; the letterbox tone must CONTRAST the dark card
  // (same-color letterboxing made the panel invisible to the model — it painted
  // floating words with no form structure).
  const result = await window.snapdom(els.capture, { scale: 2, backgroundColor: '#606a78' });
  const srcCanvas = await result.toCanvas();
  const off = document.createElement('canvas');
  off.width = SIZE; off.height = SIZE;
  const octx = off.getContext('2d');
  octx.fillStyle = '#606a78';
  octx.fillRect(0, 0, SIZE, SIZE);
  // letterbox the form into a square
  const s = Math.min(SIZE / srcCanvas.width, SIZE / srcCanvas.height);
  const w = srcCanvas.width * s, h = srcCanvas.height * s;
  octx.drawImage(srcCanvas, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  return off.toDataURL('image/jpeg', 0.5); // 50% quality per fal perf guidance
}

let _lastBlobUrl = null;
function paint(dataUrlOrBytes) {
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, SIZE, SIZE); if (_lastBlobUrl) { URL.revokeObjectURL(_lastBlobUrl); _lastBlobUrl = null; } };
  if (typeof dataUrlOrBytes === 'string') {
    img.src = dataUrlOrBytes.startsWith('data:') ? dataUrlOrBytes : 'data:image/jpeg;base64,' + dataUrlOrBytes;
  } else {
    // fal realtime returns a Uint8Array of raw JPEG bytes
    const bytes = dataUrlOrBytes instanceof ArrayBuffer ? new Uint8Array(dataUrlOrBytes) : dataUrlOrBytes;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    _lastBlobUrl = url; img.src = url;
  }
}
function tickFps() {
  frames++;
  const now = performance.now();
  if (now - lastFpsT >= 1000) {
    els.fps.textContent = frames + ' fps';
    frames = 0; lastFpsT = now;
  }
}

// ---- LIVE MODE: fal realtime websocket ----
async function startLive() {
  let fal;
  try {
    fal = await importFal();
  } catch (e) {
    console.error(e);
    setStatus('⚠ ' + e.message);
    return;
  }
  // proxy mode keeps the key on the server; direct mode uses the browser key
  if (mode === 'live-proxy') fal.config({ proxyUrl: '/api/fal/proxy' });
  else fal.config({ credentials: falKey });
  connection = fal.realtime.connect('fal-ai/flux-2/klein/realtime', {
    connectionKey: 'form-diffusion',
    throttleInterval: 64,
    onResult: (result) => {
      inFlight = false; misses = 0;
      const im = result?.images?.[0];
      if (im?.content) { paint(im.content); if (els.status.textContent !== 'live · streaming') setStatus('live · streaming'); }
      tickFps();
    },
    onError: (e) => { inFlight = false; console.error('fal error', e); },
  });

  setStatus('live · streaming');
  // Paced loop: setTimeout (not tight rAF) so low-power machines keep a responsive UI.
  let sentAt = 0, capCost = 0, misses = 0;
  const loop = async () => {
    if (!running) return;
    // watchdog: normal klein results land in <500ms. 3s of nothing means the
    // connection is gone: fal recycles realtime sockets every ~31s with a code-1000
    // close (no onError fires for 1000), and occasionally hands out sockets that
    // open but never respond. The fal client only reconnects on *close*, never on
    // a silent stall (verified against @fal-ai/client 1.10.1) — close() forces the
    // next send to re-auth with a fresh token and open a new socket (~250ms).
    if (inFlight && Date.now() - sentAt > 3000) {
      inFlight = false; misses++;
      console.warn('fal result timeout #' + misses + ' — closing stalled connection, will reconnect on next frame');
      setStatus('stream stalled — reconnecting…');
      try { connection.close(); } catch (_) {}
      if (misses >= 3) setStatus('⚠ reconnects not helping — check FAL_KEY / credits at fal.ai');
    }
    if (!inFlight && !document.hidden) {
      try {
        const t0 = performance.now();
        const image_url = await captureFrame();
        capCost = performance.now() - t0;
        inFlight = true; sentAt = Date.now();
        connection.send({
          image_url,
          prompt: currentPrompt(),
          // steps 4 + square_hd + fixed seed: best text legibility in the
          // 2026-07-08 param sweep, still <400ms/frame warm.
          num_inference_steps: 4,
          image_size: 'square_hd',
          seed: 35,
          output_feedback_strength: 0.9,
          sync_mode: true,
        });
      } catch (e) { console.error(e); setStatus('capture failed'); }
    }
    setTimeout(loop, Math.max(90, capCost));
  };
  loop();
}

// ---- DEMO MODE: no key. Calls /api/diffuse once per ~throttle via server image tool, OR
// just shows the captured frame so the mechanic is visible. ----
async function startDemo() {
  setStatus('demo · no FAL key (single-shot restyle)');
  const tryOnce = async () => {
    if (!running) return;
    try {
      const image_url = await captureFrame();
      // Ask the optional local /api/diffuse (if the server wired one up); else just show capture.
      const r = await fetch('/api/diffuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url, prompt: currentPrompt() }),
      }).catch(() => null);
      if (r && r.ok) {
        const { image } = await r.json();
        if (image) paint(image);
        setStatus('demo · restyled (single-shot)');
      } else {
        paint(image_url); // at minimum, prove the capture works
        setStatus('demo · showing raw capture (wire FAL key for AI paint)');
      }
      tickFps();
    } catch (e) { console.error(e); setStatus('capture failed — see console'); }
  };
  tryOnce();
  // gentle re-capture so toggling overlay/typing updates the shown frame
  const iv = setInterval(() => { if (!running) return clearInterval(iv); tryOnce(); }, 2500);
}

async function start() {
  mode = await detectMode();
  // No server key and no browser key: ask for one instead of silently demoing.
  if (mode === 'demo' && !gateDismissed) { showGate(); return; }
  running = true;
  els.stage.classList.add('ai-on');
  els.toggleAI.setAttribute('aria-pressed', 'true');
  els.toggleAI.textContent = 'Stop AI';
  if (mode.startsWith('live')) startLive(); else startDemo();
}
function stop() {
  running = false;
  els.stage.classList.remove('ai-on');
  els.toggleAI.setAttribute('aria-pressed', 'false');
  els.toggleAI.textContent = 'Start AI';
  setStatus('idle');
  els.fps.textContent = '0 fps';
  if (connection?.close) { try { connection.close(); } catch (_) {} connection = null; }
}

// ---- key gate (only reachable when the server has no FAL_KEY) ----
let gateDismissed = false;
function showGate() { els.gate.classList.remove('hidden'); }
function hideGate() { els.gate.classList.add('hidden'); }
els.keySave.addEventListener('click', () => {
  const k = els.keyInput.value.trim();
  if (!k) return;
  falKey = k; localStorage.setItem(LS_KEY, k);
  hideGate(); start();
});
els.keyDemo.addEventListener('click', () => { gateDismissed = true; hideGate(); start(); });
els.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.keySave.click(); });

// ---- wiring ----
els.toggleAI.addEventListener('click', () => running ? stop() : start());
els.overlay.addEventListener('click', () => {
  const on = els.overlay.getAttribute('aria-pressed') !== 'true';
  els.overlay.setAttribute('aria-pressed', String(on));
  els.stage.classList.toggle('overlay-on', on);
});
els.style.addEventListener('change', () => {
  els.custom.hidden = els.style.value !== 'custom';
});
// default: overlay on
els.stage.classList.add('overlay-on');

// the form REALLY works (proves accessibility/functionality)
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(els.form);
  if (!data.get('name') || !data.get('email') || String(data.get('password')).length < 8) {
    els.formMsg.textContent = 'Please complete all fields (password 8+ chars).';
    els.formMsg.className = 'form-msg err';
    return;
  }
  els.formMsg.textContent = `Welcome, ${data.get('name')}! (real submit — the AI is only skin-deep)`;
  els.formMsg.className = 'form-msg ok';
});

setStatus('ready — press Start AI');

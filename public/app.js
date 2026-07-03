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
};
const ctx = els.canvas.getContext('2d');

let running = false;
let connection = null;       // fal realtime connection (live mode)
let mode = 'unknown';        // 'live' | 'demo'
let frames = 0, lastFpsT = performance.now();
let inFlight = false;

// ---- config probe: does the backend expose a fal proxy/token? ----
async function detectMode() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.hasFalKey) return 'live';
    }
  } catch (_) {}
  return 'demo';
}

function currentPrompt() {
  if (els.style.value === 'custom') return els.custom.value.trim() || STYLE_PROMPTS.playdoh;
  return STYLE_PROMPTS[els.style.value] || STYLE_PROMPTS.playdoh;
}
function setStatus(t) { els.status.textContent = t; }

// ---- capture the real form to a 704x704 JPEG data URI ----
async function captureFrame() {
  const ok = await window.__snapdomReady;
  if (!ok || !window.snapdom) throw new Error('snapDOM unavailable');
  // snapdom(el) -> result with toCanvas/toPng; we render to an offscreen canvas at 704.
  const result = await window.snapdom(els.capture, { scale: 1, backgroundColor: '#11151c' });
  const srcCanvas = await result.toCanvas();
  const off = document.createElement('canvas');
  off.width = 704; off.height = 704;
  const octx = off.getContext('2d');
  octx.fillStyle = '#11151c';
  octx.fillRect(0, 0, 704, 704);
  // letterbox the form into a square
  const s = Math.min(704 / srcCanvas.width, 704 / srcCanvas.height);
  const w = srcCanvas.width * s, h = srcCanvas.height * s;
  octx.drawImage(srcCanvas, (704 - w) / 2, (704 - h) / 2, w, h);
  return off.toDataURL('image/jpeg', 0.5); // 50% quality per fal perf guidance
}

let _lastBlobUrl = null;
function paint(dataUrlOrBytes) {
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, 704, 704); if (_lastBlobUrl) { URL.revokeObjectURL(_lastBlobUrl); _lastBlobUrl = null; } };
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
  const { fal } = await import('https://esm.sh/@fal-ai/client');
  fal.config({ proxyUrl: '/api/fal/proxy' });
  connection = fal.realtime.connect('fal-ai/flux-2/klein/realtime', {
    connectionKey: 'form-diffusion',
    throttleInterval: 64,
    onResult: (result) => {
      inFlight = false;
      const im = result?.images?.[0];
      if (im?.content) paint(im.content);
      tickFps();
    },
    onError: (e) => { inFlight = false; console.error('fal error', e); setStatus('error — see console'); },
  });

  setStatus('live · streaming');
  // Paced loop: setTimeout (not tight rAF) so low-power machines keep a responsive UI.
  let sentAt = 0, capCost = 0;
  const loop = async () => {
    if (!running) return;
    if (inFlight && Date.now() - sentAt > 6000) { inFlight = false; console.warn('fal result timeout — resetting'); }
    if (!inFlight && !document.hidden) {
      try {
        const t0 = performance.now();
        const image_url = await captureFrame();
        capCost = performance.now() - t0;
        inFlight = true; sentAt = Date.now();
        connection.send({
          image_url,
          prompt: currentPrompt(),
          num_inference_steps: 3,
          image_size: 'square',
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
  running = true;
  els.stage.classList.add('ai-on');
  els.toggleAI.setAttribute('aria-pressed', 'true');
  els.toggleAI.textContent = 'Stop AI';
  mode = await detectMode();
  if (mode === 'live') startLive(); else startDemo();
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

# Form Diffusion 🪄

A working recreation of **Wes Bos's "Form Diffusion"** demo:

> *What if we just prompt user interfaces and streamed them in via video?*

A **real, fully-accessible HTML sign-up form** sits on top. Every frame, [snapDOM](https://github.com/zumerlab/snapdom)
rasterizes the form to an image, sends it to **FLUX 2 Klein realtime** (`fal-ai/flux-2/klein/realtime`,
image-to-image) with a style prompt, and the AI-restyled frame is painted behind the form.
Hit **Overlay** and the real form turns transparent — so it *looks* like an AI-hallucinated
video (Play-Doh, LEGO, Cyberpunk, Felt…) while staying **100% keyboard-accessible and functional**.
Real DOM, diffusion-painted skin.

```
 ┌─────────────────────────────────────────────────────────────┐
 │  Real <form>  ──snapDOM──▶  704×704 JPEG                     │
 │                               │                              │
 │                               ▼  WebSocket (img2img)         │
 │                    fal-ai/flux-2/klein/realtime              │
 │                               │                              │
 │                               ▼                              │
 │   <canvas> background  ◀── restyled frame  (Play-Doh, …)     │
 │   real transparent form ON TOP → still accessible           │
 └─────────────────────────────────────────────────────────────┘
```

## ✅ Proof it works

The pipeline is verified end-to-end against the real model. See `proof/`:

| Real form (DOM) | → Play-Doh | → Cyberpunk |
|---|---|---|
| `proof/01-real-form.png` | `proof/02-playdoh.png` | `proof/03-cyberpunk.png` |

Those restyles were produced by feeding the actual rendered form into `fal-ai/flux-2/klein` img2img —
the same model family the live app streams to.

## Run it

```bash
cd form-diffusion
node server.js              # DEMO mode (no key) — http://localhost:5173
```

No `npm install` needed — zero dependencies. snapDOM and the fal client load from CDN in the browser.

### Live streaming mode (the full 30fps effect)

You need your own [fal.ai](https://fal.ai) API key (browsers can't safely hold a key, so the
included Node server proxies it). Realtime FLUX 2 Klein is **~$0.00194 / compute-second**.

```bash
FAL_KEY=your_fal_key_here node server.js
```

The page auto-detects the key via `/api/config` and switches from **demo** (single-shot / raw
capture) to **live** (continuous WebSocket streaming). Then: open the page → **Start AI** → pick a
style → **Overlay**.

## How the magic works (the important bits)

- **`public/index.html`** — `#form-capture` is the real form snapDOM rasterizes. A `<canvas>`
  sits behind it; the real form sits on top (`z-index`).
- **`public/style.css`** — `.stage.overlay-on.ai-on .card` makes the card background transparent
  and labels ~4% opacity. Inputs stay interactive and in the accessibility tree — they're just
  visually nearly-invisible, so the AI paint reads as the UI.
- **`public/app.js`** —
  - `captureFrame()` → snapDOM → letterboxed 704×704 JPEG @ 50% quality (fal's recommended input).
  - **live**: `fal.realtime.connect("fal-ai/flux-2/klein/realtime", …)` with `throttleInterval`,
    sends `{ image_url, prompt, num_inference_steps: 3, output_feedback_strength: 0.9 }` each frame;
    `output_feedback_strength: 0.9` feeds 10% of the previous latent back for temporal stability.
  - **demo**: posts one frame to `/api/diffuse` (if a key is set) or just shows the raw capture so
    the capture half is still visible.
- **`server.js`** — static server + `/api/config` (live vs demo) + `/api/fal/proxy` (keeps your
  FAL key server-side, official fal proxy pattern) + `/api/diffuse` (single-shot for demo).

## Tuning the look

- **Style prompts** live in `STYLE_PROMPTS` in `app.js`. Add your own, or use the **Custom…**
  dropdown option to type a prompt live.
- **Temporal stability vs responsiveness**: raise `output_feedback_strength` toward 1.0 for more
  shimmer/variety, lower toward 0.8 for a smoother, more "stuck" look.
- **Speed**: keep input at 704×704; `num_inference_steps: 3` is the sweet spot. `enable_interpolation`
  doubles frames via RIFE if you want smoother motion (costs more).

## Credit

Concept: **Wes Bos** (@wesbos). Capture: **snapDOM** by Zumerlab. Diffusion: **FLUX.2 [klein]**
by Black Forest Labs, served by **fal.ai**.

// server.js — Form Diffusion backend
// - serves /public
// - GET  /api/config       -> { hasFalKey }   (client picks live vs demo)
// - ALL  /api/fal/proxy    -> fal realtime/queue proxy (keeps FAL_KEY server-side)
// - POST /api/diffuse      -> single-shot img2img restyle (demo mode, optional)
//
// Run:  FAL_KEY=xxxxx node server.js   (live streaming)
//   or: node server.js                (demo mode — capture shows, no AI paint unless /api/diffuse works)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');

// Auto-load .env if present (Node 20.12+/24 built-in — no dependency needed).
try { process.loadEnvFile(join(__dirname, '.env')); } catch (_) { /* no .env, fine */ }

const PORT = process.env.PORT || 5173;
const FAL_KEY = process.env.FAL_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- fal realtime proxy (official pattern) ----
// The @fal-ai/client posts here with x-fal-target-url; we forward with the key.
async function falProxy(req, res) {
  const targetUrl = req.headers['x-fal-target-url'];
  if (!targetUrl) return send(res, 400, 'missing x-fal-target-url');
  if (!FAL_KEY)   return send(res, 503, 'FAL_KEY not configured on server');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Accept': req.headers['accept'] || 'application/json',
      },
      body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    send(res, upstream.status, buf, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
  } catch (e) {
    send(res, 502, 'proxy error: ' + e.message);
  }
}

// ---- single-shot restyle for demo mode (queue API, not realtime) ----
async function diffuseOnce(req, res) {
  if (!FAL_KEY) return send(res, 503, JSON.stringify({ error: 'no FAL_KEY' }), { 'Content-Type': 'application/json' });
  try {
    const { image_url, prompt } = JSON.parse(await readBody(req));
    const r = await fetch('https://fal.run/fal-ai/flux-2/klein/realtime', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url, prompt, num_inference_steps: 3, image_size: 'square' }),
    });
    const data = await r.json();
    const img = data?.images?.[0];
    const out = img?.content ? ('data:image/jpeg;base64,' + img.content) : null;
    send(res, 200, JSON.stringify({ image: out }), { 'Content-Type': 'application/json' });
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
  }
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const full = normalize(join(PUBLIC, p));
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(full);
    send(res, 200, data, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/config')     return send(res, 200, JSON.stringify({ hasFalKey: !!FAL_KEY }), { 'Content-Type': 'application/json' });
  if (pathname === '/api/fal/proxy')  return falProxy(req, res);
  if (pathname === '/api/diffuse' && req.method === 'POST') return diffuseOnce(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Form Diffusion → http://localhost:${PORT}`);
  console.log(`  Mode: ${FAL_KEY ? 'LIVE (FAL key detected) ⚡' : 'DEMO (no FAL key — set FAL_KEY for live streaming)'}\n`);
});

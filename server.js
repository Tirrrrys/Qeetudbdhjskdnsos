#!/usr/bin/env node
/* ============================================================
 * Luminous — Backend proxy (zero-dependency, Node 18+)
 * ------------------------------------------------------------
 * Menjalankan:  sh start.sh  (atau: cd backend && node server.js)
 * Buka:         http://localhost:7766
 *
 * Endpoint:
 *   GET  /                        -> serve luminous.html
 *   GET  /api/health              -> status backend
 *   POST /api/chat                -> proxy ke provider (chat)
 *   POST /api/models              -> proxy ke provider (list models)
 *
 * Frontend kirim konfigurasi (provider/baseUrl/key/model) di
 * body/header tiap request — backend stateless, tidak menyimpan
 * key apa pun di disk.
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7766;
const ROOT = __dirname;
const FRONTEND = path.join(ROOT, '..', 'frontend');
const HTML_FILE = path.join(FRONTEND, 'luminous.html');

const DEFAULT_BASE = {
  openai:    'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini:    'https://generativelanguage.googleapis.com'
};

/* ---------------- helpers ---------------- */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('Body terlalu besar')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('Body bukan JSON valid')); }
    });
    req.on('error', reject);
  });
}
function normBase(cfg) {
  const b = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  return b || DEFAULT_BASE[cfg.provider] || DEFAULT_BASE.openai;
}
function errFromProvider(status, text) {
  /* FIX: kalau provider/tunnel balikin halaman HTML (502/504 gateway,
     halaman "reminder" tunnel, dsb), jangan pass-through mentah —
     dulu gejalanya user lihat "502 <!DOCTYPE html>..." apa adanya. */
  const htmlish = /<!DOCTYPE|<html[\s>]/i.test(text.slice(0, 500));
  if (htmlish) {
    const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const hint = status === 502 || status === 504
      ? ' — gateway/tunnel-nya hidup tapi server upstream-nya mati atau timeout. Cek service di server origin (mis. 9Router) / restart tunnel client.'
      : ' — endpoint balikin halaman HTML, bukan JSON. Cek Base URL (harus ujungnya /v1) dan status tunnel.';
    return new Error(`${status}${title ? ' (' + title.trim().slice(0, 80) + ')' : ''}: halaman HTML dari upstream${hint}`);
  }
  try {
    const j = JSON.parse(text);
    let msg = j.error?.message || j.message || j.error || `${status} ${text.slice(0, 300)}`;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    return new Error(msg);
  } catch (_) {
    return new Error(`${status} ${text.slice(0, 300)}`);
  }
}

/* ---------------- provider calls (server-side fetch) ---------------- */
// Header wajib untuk tunnel berbasis localtunnel (*.lokal.to dkk.) biar GET /models
// tidak diintersep halaman "reminder" HTML. Harmless untuk provider lain.
const TUNNEL_HEADERS = { 'Bypass-Tunnel-Reminder': 'true' };

/* Retry otomatis utk error transient dari provider/gateway (429/5xx, network).
   4xx selain itu (401/400) langsung dilempar — retry cuma buang waktu. */
const RETRYABLE = /\b(429|500|502|503|504)\b|overloaded|rate.?limit|timeout|timed? ?out|econnreset|socket hang up|fetch failed|network/i;
async function withRetry(fn, label = 'provider call', maxRetry = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (!RETRYABLE.test(msg) || attempt === maxRetry) throw e;
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`[${label}] attempt ${attempt + 1} gagal (${msg.slice(0, 120)}) — retry dalam ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function callProvider(cfg, prompt, system, maxTokens, temperature) {
  const base = normBase(cfg);
  const model = cfg.model || 'gpt-4o';

  if (cfg.provider === 'anthropic') {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key || '',
        'anthropic-version': '2023-06-01',
        ...TUNNEL_HEADERS
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    const d = await r.json();
    return d.content?.[0]?.text || '';
  }

  if (cfg.provider === 'gemini') {
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent${cfg.key ? `?key=${encodeURIComponent(cfg.key)}` : ''}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature }
      })
    });
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    const d = await r.json();
    const t = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!t) throw new Error('Respons kosong dari Gemini (cek model: ' + model + ')');
    return t;
  }

  // OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, 9Router, dll.)
  const headers = { 'Content-Type': 'application/json', ...TUNNEL_HEADERS };
  if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!r.ok) throw await errFromProvider(r.status, await r.text());
  const d = await r.json();
  const ct = (d.choices?.[0]?.message?.content);
  const t = typeof ct === 'string' ? ct
    : Array.isArray(ct) ? ct.map(p => p?.text || '').join('')
    : '';
  if (!t) throw new Error('Respons kosong dari endpoint (cek model: ' + model + ')');
  return t;
}

async function readSSE(r, handle) {
  /* baca body SSE upstream, panggil handle() untuk tiap payload "data:" */
  if (!r.body) throw new Error('Upstream tidak mengembalikan stream');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      handle(data);
    }
  }
}

/* versi streaming dari callProvider — dipakai /api/chat-stream.
   Byte diteruskan begitu masuk lewat onDelta → koneksi tidak idle,
   gateway/tunnel tidak timeout saat generate panjang (PRD). */
async function streamProvider(cfg, prompt, system, maxTokens, temperature, onDelta) {
  const base = normBase(cfg);
  const model = cfg.model || 'gpt-4o';

  if (cfg.provider === 'anthropic') {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key || '',
        'anthropic-version': '2023-06-01',
        ...TUNNEL_HEADERS
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature, system, stream: true,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    await readSSE(r, d => {
      try {
        const j = JSON.parse(d);
        if (j.type === 'content_block_delta' && j.delta?.text) onDelta(j.delta.text);
      } catch (_) {}
    });
    return;
  }

  if (cfg.provider === 'gemini') {
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse${cfg.key ? `&key=${encodeURIComponent(cfg.key)}` : ''}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature }
      })
    });
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    await readSSE(r, d => {
      try {
        const j = JSON.parse(d);
        const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
        if (t) onDelta(t);
      } catch (_) {}
    });
    return;
  }

  // OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, 9Router, dll.)
  const headers = { 'Content-Type': 'application/json', ...TUNNEL_HEADERS };
  if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature, stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!r.ok) throw await errFromProvider(r.status, await r.text());
  await readSSE(r, d => {
    try {
      const j = JSON.parse(d);
      const t = j.choices?.[0]?.delta?.content;
      if (t) onDelta(t);
    } catch (_) {}
  });
}

async function listModels(cfg) {
  const base = normBase(cfg);

  if (cfg.provider === 'gemini') {
    const url = `${base}/v1beta/models${cfg.key ? `?key=${encodeURIComponent(cfg.key)}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    const d = await r.json();
    const models = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
    return { models: [...new Set(models)].sort() };
  }

  if (cfg.provider === 'anthropic') {
    const r = await fetch(base + '/v1/models', {
      headers: { 'x-api-key': cfg.key || '', 'anthropic-version': '2023-06-01', ...TUNNEL_HEADERS }
    });
    if (!r.ok) throw await errFromProvider(r.status, await r.text());
    const d = await r.json();
    return { models: [...new Set((d.data || []).map(m => m.id))].sort() };
  }

  // OpenAI-compatible
  const headers = { ...TUNNEL_HEADERS };
  if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
  const r = await fetch(base + '/models', { headers });
  if (!r.ok) throw await errFromProvider(r.status, await r.text());
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); }
  catch (_) { throw new Error('Endpoint balikin bukan JSON (kemungkinan halaman tunnel/reminder). Cek Base URL — harus ujungnya /v1: ' + text.slice(0, 120)); }
  const models = (d.data || d.models || []).map(m => m.id || m.name).filter(Boolean);
  return { models: [...new Set(models)].sort() };
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  // CORS preflight (untuk frontend yang dibuka dari origin/port berbeda)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* health */
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'luminous-backend', node: process.version, time: Date.now() });
    }

    /* chat */
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = body.config || {};
      if (!cfg.provider) return json(res, 400, { ok: false, error: 'config.provider wajib' });

      /* stream:true → jalankan sebagai SSE di endpoint yang sama.
         Respons JSON tunggal untuk generate panjang bikin gateway/tunnel
         idle → 502/504 HTML; streaming bikin byte selalu mengalir. */
      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const send = ev => res.write('data: ' + JSON.stringify(ev) + '\n\n');
        send({ type: 'open' });
        let text = '';
        try {
          await withRetry(attempt => streamProvider(
            cfg, body.prompt || '', body.system || 'You are a helpful assistant.',
            Math.min(body.maxTokens || 8000, 32000),
            typeof body.temperature === 'number' ? body.temperature : 0.7,
            t => { if (attempt > 0) text = ''; text += t; send({ type: 'delta', t }); }
          ), 'chat-stream');
          send({ type: 'done', text });
        } catch (e) {
          send({ type: 'error', error: e.message || 'Upstream error' });
        }
        return res.end();
      }

      const text = await withRetry(() => callProvider(
        cfg,
        body.prompt || '',
        body.system || 'You are a helpful assistant.',
        Math.min(body.maxTokens || 8000, 32000),
        typeof body.temperature === 'number' ? body.temperature : 0.7
      ), 'chat');
      return json(res, 200, { ok: true, text });
    }

    /* chat streaming (SSE) — dipakai frontend untuk generate panjang (PRD).
       Byte diteruskan secepat masuk → gateway/tunnel tidak timeout. */
    if (p === '/api/chat-stream' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = body.config || {};
      if (!cfg.provider) return json(res, 400, { ok: false, error: 'config.provider wajib' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = ev => res.write('data: ' + JSON.stringify(ev) + '\n\n');
      send({ type: 'open' });
      let text = '';
      try {
        await withRetry(attempt => streamProvider(
          cfg, body.prompt || '', body.system || 'You are a helpful assistant.',
          Math.min(body.maxTokens || 8000, 32000),
          typeof body.temperature === 'number' ? body.temperature : 0.7,
          t => { if (attempt > 0) text = ''; text += t; send({ type: 'delta', t }); }
        ), 'chat-stream');
        send({ type: 'done', text });
      } catch (e) {
        send({ type: 'error', error: e.message || 'Upstream error' });
      }
      return res.end();
    }

    /* models */
    if (p === '/api/models' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = body.config || {};
      if (!cfg.provider) return json(res, 400, { ok: false, error: 'config.provider wajib' });
      const out = await listModels(cfg);
      return json(res, 200, { ok: true, ...out });
    }

    /* static: root -> html */
    if ((p === '/' || p === '/luminous.html') && req.method === 'GET') {
      try {
        const html = fs.readFileSync(HTML_FILE);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('luminous.html tidak ditemukan di folder frontend');
      }
    }

    /* static: curated.html */
    if (p === '/curated.html' && req.method === 'GET') {
      try {
        const html = fs.readFileSync(path.join(FRONTEND, 'curated.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('curated.html tidak ditemukan di folder frontend');
      }
    }

    /* static: logo */
    if (p === '/logo.png' && req.method === 'GET') {
      try {
        const img = fs.readFileSync(path.join(FRONTEND, 'logo.png'));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(img);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('logo.png tidak ditemukan di folder frontend');
      }
    }

    json(res, 404, { ok: false, error: 'Not found: ' + p });
  } catch (e) {
    /* FIX: fetch gagal total (upstream mati/DNS gagal/tunnel down) —
       "fetch failed" mentah nggak informatif; beri konteks + penyebab asli */
    if (e instanceof TypeError && e.message === 'fetch failed' && e.cause) {
      const c = e.cause;
      const code = c.code || c.cause?.code || '';
      const why = {
        ECONNREFUSED: 'upstream menolak koneksi (service mati / port salah)',
        ENOTFOUND: 'hostname tidak ketemu (DNS gagal / salah ketik)',
        ECONNRESET: 'koneksi direset upstream',
        ETIMEDOUT: 'timeout menyambung ke upstream',
        CERT_HAS_EXPIRED: 'sertifikat TLS upstream kedaluwarsa'
      }[code] || c.message || 'tidak bisa menghubungi upstream';
      return json(res, 502, { ok: false, error: `Upstream tidak terjangkau: ${why} (${code || 'network error'})` });
    }
    json(res, 502, { ok: false, error: e.message || 'Upstream error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ⚡ Luminous backend jalan!');
  console.log(`  ➜  Buka:  http://localhost:${PORT}`);
  console.log('  ➜  Tekan Ctrl+C untuk berhenti');
  console.log('');
});

/* graceful shutdown — beri waktu request aktif selesai (max 10s) */
function shutdown(sig) {
  console.log(`\n  ${sig} diterima — menutup server…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

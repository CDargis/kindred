// Single-password auth with a long-lived HMAC-signed cookie ("stay logged in").
// No DB, no session store — the signed cookie IS the session. Personal tool.
//
// Env: APP_PASSWORD (the one password), SESSION_SECRET (HMAC key).
import express from 'express';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

const COOKIE = 'kindred_session';
const MAX_AGE_DAYS = 365;
const TOKEN_PAYLOAD = 'v1'; // static — single user, no per-user data to encode

const secret = () => process.env.SESSION_SECRET || 'dev-insecure-secret';

function sign(payload) {
  const mac = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Constant-time password check (hash to fixed length first, avoid length leak).
function passwordOk(input) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const LOGIN_PAGE = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kindred — sign in</title>
<style>
  body{background:#12140f;color:#e4e8da;font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#1a1e15;border:1px solid #2d3324;border-radius:12px;padding:28px;width:min(320px,90vw)}
  h1{color:#8fbc5a;font-size:20px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;background:#12140f;color:#e4e8da;border:1px solid #2d3324;border-radius:8px;padding:11px;font-size:16px}
  button{width:100%;margin-top:12px;background:#8fbc5a;color:#16200a;border:0;border-radius:8px;padding:11px;font-weight:700;font-size:15px;cursor:pointer}
  .err{color:#e08080;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/login">
  <h1>🌱 Kindred</h1>
  <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form></body></html>`;

/**
 * Mount the login routes and the auth guard on `app`. Call BEFORE registering
 * protected routes — everything registered after mountAuth() requires a session.
 */
export function mountAuth(app) {
  app.get('/login', (req, res) => {
    if (verify(readCookie(req, COOKIE))) return res.redirect('/');
    res.type('html').send(LOGIN_PAGE(req.query.e ? 'Wrong password' : ''));
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (!passwordOk(req.body?.password)) return res.redirect('/login?e=1');
    const cookie = [
      `${COOKIE}=${encodeURIComponent(sign(TOKEN_PAYLOAD))}`,
      'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax',
      `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`,
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);
    res.redirect('/');
  });

  app.get('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    res.redirect('/login');
  });

  // Guard everything below.
  app.use((req, res, next) => {
    if (verify(readCookie(req, COOKIE))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    res.redirect('/login');
  });
}

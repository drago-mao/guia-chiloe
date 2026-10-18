// Servidor de "Chiloé a tu Manera" (V 1.7).
// Maneja cuentas, perfiles (administrador / usuario registrado), lugares, fotos, sugerencias, favoritos y mareas.
// Los datos se guardan en Netlify Blobs. Quien no inicia sesión es "visualizador": solo puede mirar.
import { getStore } from '@netlify/blobs';
import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { PLACES as SEED_PLACES, TIDES as SEED_TIDES, TIDES_SRC as SEED_TIDES_SRC } from './seed.mjs';
import { SETUP } from './setup.mjs';
import { computeTides, chileDate, CALC_SRC } from './mareas-calc.mjs';

const scrypt = promisify(_scrypt);

const CATS = ['comer', 'visitar', 'comprar', 'servicios'];
const ROLES = ['admin', 'usuario'];
const COOKIE = 'gc';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const BOUNDS = { latMin: -43.5, latMax: -41.4, lngMin: -74.8, lngMax: -72.5 };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- almacenamiento (Netlify Blobs) ---------- */
export function blobKV(name) {
  // Se abre el almacén en cada operación: la credencial de Netlify Blobs vence a los pocos minutos
  // y, si se guardara entre llamadas, el servidor fallaría con "Token expired".
  const store = () => getStore({ name, consistency: 'strong' });
  return {
    async getJSON(key) {
      const r = await store().getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async setJSON(key, val, opts) { return store().setJSON(key, val, opts || {}); },
    async del(key) { await store().delete(key); },
    async list(prefix) { const { blobs } = await store().list({ prefix }); return blobs.map((b) => b.key); },
    async getBin(key) {
      const r = await store().getWithMetadata(key, { type: 'arrayBuffer' });
      return r ? { buf: Buffer.from(r.data), type: (r.metadata && r.metadata.type) || 'image/jpeg' } : null;
    },
    async setBin(key, buf, type) {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      await store().set(key, ab, { metadata: { type } });
    }
  };
}

/* ---------- utilidades ---------- */
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;
const b64u = (x) => Buffer.from(x).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const newId = () => 'n' + Date.now().toString(36) + randomBytes(2).toString('hex');

function safeUrl(u) {
  u = clean(u, 300);
  if (!u) return '';
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(u)) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return '';
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') && x.hostname.indexOf('.') > 0 ? u : '';
  } catch (e) { return ''; }
}
function numOrNull(v, min, max, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, label + ' no es válido.');
  return n;
}
function userOut(u) { return { email: u.email, name: u.name, role: u.role }; }

async function hashPw(pw, saltHex) { return (await scrypt(pw, Buffer.from(saltHex, 'hex'), 64)).toString('hex'); }
function sameHex(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(10), (b) => A[b % A.length]).join('');
}
function decodeJpeg(dataUrl, maxBytes) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'La foto debe ser una imagen JPG.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new HttpError(400, 'La foto no es un JPG válido.');
  if (buf.length > maxBytes) throw new HttpError(413, 'La foto es muy pesada. Prueba con otra más liviana.');
  return buf;
}

/* ---------- validación de lugares y mareas ---------- */
function cleanPlace(input, existing) {
  const p = input || {};
  const name = clean(p.name, 120);
  if (name.length < 2) throw new HttpError(400, 'Escribe el nombre del lugar.');
  if (CATS.indexOf(p.cat) < 0) throw new HttpError(400, 'Elige qué tipo de lugar es.');
  let lat = numOrNull(p.lat, BOUNDS.latMin, BOUNDS.latMax, 'La latitud');
  let lng = numOrNull(p.lng, BOUNDS.lngMin, BOUNDS.lngMax, 'La longitud');
  if ((lat === null) !== (lng === null)) throw new HttpError(400, 'Para ubicar el lugar en el mapa hacen falta latitud y longitud.');
  let rating = numOrNull(p.rating, 0, 5, 'La valoración');
  if (rating !== null) rating = Math.round(rating * 10) / 10;
  let count = numOrNull(p.count, 0, 1000000, 'La cantidad de opiniones');
  count = count === null ? 0 : Math.round(count);
  const hours = clean(p.hours, 200);
  const prev = existing || {};
  return {
    id: prev.id || newId(),
    cat: p.cat,
    sub: clean(p.sub, 40) || 'Otro',
    name,
    town: clean(p.town, 40) || 'Otro',
    lat, lng,
    hours,
    tel: clean(p.tel, 40),
    rating, count,
    desc: cleanMultiline(p.desc, 1500),
    web: safeUrl(p.web),
    hs: hours === (prev.hours || '') ? (prev.hs || '') : '',
    photo: prev.photo || 0
  };
}

function cleanTides(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 120) throw new HttpError(400, 'La tabla de mareas debe tener entre 1 y 120 días.');
  const seen = {};
  const out = input.map((d) => {
    if (!Array.isArray(d) || typeof d[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d[0]) || !Array.isArray(d[1])) throw new HttpError(400, 'Hay un día con formato incorrecto en las mareas.');
    const t = new Date(d[0] + 'T00:00:00Z');
    if (isNaN(t) || t.toISOString().slice(0, 10) !== d[0]) throw new HttpError(400, 'La fecha ' + d[0] + ' no existe.');
    if (seen[d[0]]) throw new HttpError(400, 'La fecha ' + d[0] + ' está repetida.');
    seen[d[0]] = true;
    if (d[1].length < 1 || d[1].length > 6) throw new HttpError(400, 'El día ' + d[0] + ' debe tener entre 1 y 6 mareas.');
    const ev = d[1].map((e) => {
      if (!Array.isArray(e) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e[0]) || (e[1] !== 'H' && e[1] !== 'L')) throw new HttpError(400, 'Hay una marea con formato incorrecto el ' + d[0] + '.');
      const h = Number(e[2]);
      if (!Number.isFinite(h) || h < -2 || h > 10) throw new HttpError(400, 'Hay una altura de marea fuera de rango el ' + d[0] + '.');
      return [e[0], e[1], Math.round(h * 100) / 100];
    }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return [d[0], ev];
  });
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/* ---------- mareas siempre al día ---------- */
// Se entregan desde AYER hasta 30 días después de hoy (hora de Chile). Los días que el administrador cargó a mano
// (o los de la tabla inicial) se respetan; todos los demás se calculan solos (mareas-calc.mjs).
const TIDES_AHEAD = 30, TIDES_MAX_AHEAD = 120;
const isoPlus = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function currentTides(base, nowMs) {
  try {
    const today = chileDate(nowMs), from = isoPlus(today, -1);
    const manual = {};
    let last = null;
    for (const d of base.tides) if (d[0] >= from) { manual[d[0]] = d; if (!last || d[0] > last) last = d[0]; }
    let to = isoPlus(today, TIDES_AHEAD);
    if (last && last > to) to = last < isoPlus(today, TIDES_MAX_AHEAD) ? last : isoPlus(today, TIDES_MAX_AHEAD);
    const calc = computeTides(from, to);
    const tides = calc.map((d) => manual[d[0]] || d);
    const usedManual = calc.some((d) => manual[d[0]]), usedCalc = calc.some((d) => !manual[d[0]]);
    const src = usedManual && usedCalc ? clean(base.src, 300) + ' · Después de esa fecha: ' + CALC_SRC.charAt(0).toLowerCase() + CALC_SRC.slice(1) : usedManual ? base.src : CALC_SRC;
    return { tides, src };
  } catch (e) {
    return base; // si el cálculo fallara, se muestra la tabla guardada
  }
}

/* ---------- la API ---------- */
export function createApi(kv, opts) {
  const now = (opts && opts.now) || Date.now;
  const setup = (opts && opts.setup) || SETUP;
  const cfg = kv('guia-config'), users = kv('guia-usuarios'), data = kv('guia-datos'),
    fotos = kv('guia-fotos'), sugs = kv('guia-sugerencias'), tries = kv('guia-intentos');
  let secretCache = null;

  const send = (status, obj, headers) => new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, headers || {})
  });

  async function secret() {
    if (secretCache) return secretCache;
    let r = await cfg.getJSON('secret');
    if (!r) {
      const val = randomBytes(32).toString('hex');
      const w = await cfg.setJSON('secret', { v: val }, { onlyIfNew: true });
      r = w && w.modified === false ? await cfg.getJSON('secret') : { data: { v: val } };
    }
    secretCache = r.data.v;
    return secretCache;
  }
  async function makeToken(u) {
    const body = b64u(JSON.stringify({ e: u.email, v: u.v || 0, x: now() + SESSION_MS }));
    const sig = createHmac('sha256', await secret()).update(body).digest('base64url');
    return body + '.' + sig;
  }
  async function readToken(tok) {
    const i = String(tok || '').indexOf('.');
    if (i < 1) return null;
    const body = tok.slice(0, i), sig = tok.slice(i + 1);
    const want = createHmac('sha256', await secret()).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p && p.x > now() ? p : null; } catch (e) { return null; }
  }
  const ukey = (email) => 'u/' + encodeURIComponent(email);
  async function loadUser(email) { const r = await users.getJSON(ukey(email)); return r ? r.data : null; }
  async function currentUser(req) {
    const c = req.headers.get('cookie') || '';
    let tok = '';
    c.split(';').forEach((part) => { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) tok = part.slice(i + 1).trim(); });
    if (!tok) return null;
    const p = await readToken(tok);
    if (!p) return null;
    const u = await loadUser(p.e);
    return u && (u.v || 0) === p.v ? u : null;
  }
  const needUser = async (req) => { const u = await currentUser(req); if (!u) throw new HttpError(401, 'Inicia sesión para continuar.'); return u; };
  const needAdmin = async (req) => { const u = await needUser(req); if (u.role !== 'admin') throw new HttpError(403, 'Solo el administrador puede hacer esto.'); return u; };

  async function sessionHeaders(req, u) {
    const https = new URL(req.url).protocol === 'https:';
    const tok = await makeToken(u);
    return { 'set-cookie': COOKIE + '=' + tok + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_MS / 1000) + (https ? '; Secure' : '') };
  }
  function clearCookie(req) {
    const https = new URL(req.url).protocol === 'https:';
    return { 'set-cookie': COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (https ? '; Secure' : '') };
  }

  // Límite simple de intentos (contra adivinar contraseñas o llenar de cuentas falsas)
  async function hit(key, max, windowMs, msg) {
    const k = sha(key);
    const r = await tries.getJSON(k);
    const t = now();
    if (r && t - r.data.t < windowMs) {
      if (r.data.n >= max) throw new HttpError(429, msg);
      await tries.setJSON(k, { n: r.data.n + 1, t: r.data.t });
    } else {
      await tries.setJSON(k, { n: 1, t });
    }
  }
  const clearHit = (key) => tries.del(sha(key)).catch(() => {});

  async function readBody(req) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > 3 * 1024 * 1024) throw new HttpError(413, 'El envío es demasiado grande.');
    try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch (e) { throw new HttpError(400, 'No se entendió lo enviado.'); }
  }
  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'La contraseña necesita al menos 8 caracteres.');
    if (pw.length > 100) throw new HttpError(400, 'La contraseña es demasiado larga.');
  }
  async function newUser(email, name, pw, role) {
    const salt = randomBytes(16).toString('hex');
    return { email, name: clean(name, 60) || email.split('@')[0], role, salt, hash: await hashPw(pw, salt), v: 0, favs: [], created: now(), lastLogin: now() };
  }
  const adminCount = async () => {
    const keys = await users.list('u/');
    let n = 0;
    for (const k of keys) { const r = await users.getJSON(k); if (r && r.data.role === 'admin') n++; }
    return n;
  };

  /* --- lugares --- */
  async function readPlaces() {
    const r = await data.getJSON('lugares');
    return r ? { places: r.data.places, etag: r.etag } : { places: SEED_PLACES.map((p) => Object.assign({}, p)), etag: null };
  }
  async function mutatePlaces(fn) {
    for (let i = 0; i < 6; i++) {
      const cur = await readPlaces();
      const result = fn(cur.places.map((p) => Object.assign({}, p)));
      const w = await data.setJSON('lugares', { places: result.list, at: now() }, cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (!w || w.modified !== false) return result.value;
    }
    throw new HttpError(409, 'Otra persona editó al mismo tiempo. Vuelve a intentarlo.');
  }
  const savePlace = (input) => mutatePlaces((list) => {
    if (input && input.id) {
      const i = list.findIndex((p) => p.id === String(input.id));
      if (i < 0) throw new HttpError(404, 'Ese lugar ya no existe.');
      const upd = cleanPlace(input, list[i]);
      list[i] = upd;
      return { list, value: upd };
    }
    const created = cleanPlace(input, null);
    list.push(created);
    return { list, value: created };
  });

  /* --- rutas --- */
  async function route(req, ip) {
    const url = new URL(req.url);
    let path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers.get('x-guia') !== '1') throw new HttpError(403, 'Petición no permitida.');
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Petición no permitida.');
    }
    let m;

    // ----- público -----
    if (method === 'GET' && path === '/estado') {
      const a = await cfg.getJSON('admin');
      return send(200, { hasAdmin: !!a });
    }
    if (method === 'GET' && path === '/lugares') {
      const cur = await readPlaces();
      return send(200, { places: cur.places });
    }
    if (method === 'GET' && path === '/mareas') {
      const r = await data.getJSON('mareas');
      return send(200, currentTides(r ? r.data : { tides: SEED_TIDES, src: SEED_TIDES_SRC }, now()));
    }
    if (method === 'GET' && (m = /^\/foto\/([A-Za-z0-9_-]{1,30})$/.exec(path))) {
      const f = await fotos.getBin('p/' + m[1]);
      if (!f) return send(404, { error: 'Sin foto.' });
      return new Response(f.buf, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
    }

    // ----- cuenta -----
    if (method === 'GET' && path === '/yo') {
      const u = await currentUser(req);
      return send(200, u ? { user: userOut(u), favs: u.favs || [] } : { user: null });
    }
    if (method === 'POST' && path === '/registro') {
      const b = await readBody(req);
      const email = clean(b.email, 120).toLowerCase();
      if (!isEmail(email)) throw new HttpError(400, 'Escribe un correo válido, por ejemplo nombre@correo.cl.');
      checkPassword(b.password);
      await hit('reg:' + ip, 8, 3600 * 1000, 'Se crearon muchas cuentas desde este lugar. Inténtalo más tarde.');
      const u = await newUser(email, b.name, b.password, 'usuario');
      const w = await users.setJSON(ukey(email), u, { onlyIfNew: true });
      if (w && w.modified === false) throw new HttpError(409, 'Ese correo ya tiene una cuenta. Usa "Entrar".');
      return send(200, { user: userOut(u), favs: [] }, await sessionHeaders(req, u));
    }
    if (method === 'POST' && path === '/entrar') {
      const b = await readBody(req);
      const email = clean(b.email, 120).toLowerCase();
      const key = 'login:' + ip + ':' + email;
      await hit(key, 6, 10 * 60 * 1000, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      const u = isEmail(email) ? await loadUser(email) : null;
      const bad = new HttpError(401, 'Correo o contraseña incorrectos.');
      if (!u || typeof b.password !== 'string') { await hashPw('x', 'ab'.repeat(16)); throw bad; }
      if (!sameHex(await hashPw(b.password, u.salt), u.hash)) throw bad;
      await clearHit(key);
      u.lastLogin = now();
      await users.setJSON(ukey(email), u);
      return send(200, { user: userOut(u), favs: u.favs || [] }, await sessionHeaders(req, u));
    }
    if (method === 'POST' && path === '/salir') return send(200, { ok: true }, clearCookie(req));
    if (method === 'POST' && path === '/instalar') {
      if (await cfg.getJSON('admin')) throw new HttpError(403, 'Ya existe un administrador.');
      const b = await readBody(req);
      await hit('setup:' + ip, 10, 3600 * 1000, 'Demasiados intentos. Espera un rato.');
      const code = String(b.codigo || '').trim().toUpperCase();
      if (!sameHex(await hashPw(code, setup.salt), setup.hash)) throw new HttpError(403, 'El código de instalación no es correcto.');
      const email = clean(b.email, 120).toLowerCase();
      if (!isEmail(email)) throw new HttpError(400, 'Escribe un correo válido.');
      checkPassword(b.password);
      const claim = await cfg.setJSON('admin', { email, at: now() }, { onlyIfNew: true });
      if (claim && claim.modified === false) throw new HttpError(403, 'Ya existe un administrador.');
      const u = await newUser(email, b.name, b.password, 'admin');
      const prev = await loadUser(email);
      if (prev) { u.favs = prev.favs || []; u.created = prev.created || u.created; u.v = (prev.v || 0) + 1; }
      await users.setJSON(ukey(email), u);
      return send(200, { user: userOut(u), favs: u.favs }, await sessionHeaders(req, u));
    }
    if (method === 'POST' && path === '/cuenta/clave') {
      const u = await needUser(req);
      const b = await readBody(req);
      await hit('pw:' + u.email, 8, 3600 * 1000, 'Demasiados intentos. Espera un rato.');
      if (typeof b.actual !== 'string' || !sameHex(await hashPw(b.actual, u.salt), u.hash)) throw new HttpError(400, 'La contraseña actual no coincide.');
      checkPassword(b.nueva);
      u.salt = randomBytes(16).toString('hex');
      u.hash = await hashPw(b.nueva, u.salt);
      u.v = (u.v || 0) + 1;
      await users.setJSON(ukey(u.email), u);
      return send(200, { ok: true }, await sessionHeaders(req, u));
    }
    if (method === 'PUT' && path === '/favoritos') {
      const u = await needUser(req);
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(x)).slice(0, 300) : [];
      u.favs = Array.from(new Set(ids));
      await users.setJSON(ukey(u.email), u);
      return send(200, { favs: u.favs });
    }

    // ----- sugerencias (usuarios registrados) -----
    if (method === 'POST' && path === '/sugerencias') {
      const u = await needUser(req);
      const b = await readBody(req);
      await hit('sug:' + u.email, 6, 24 * 3600 * 1000, 'Ya enviaste varias sugerencias hoy. Inténtalo mañana.');
      const name = clean(b.name, 120);
      if (name.length < 2) throw new HttpError(400, 'Escribe el nombre del lugar.');
      if (CATS.indexOf(b.cat) < 0) throw new HttpError(400, 'Elige qué tipo de lugar es.');
      const id = newId();
      let hasPhoto = false;
      if (b.photo) { await fotos.setBin('s/' + id, decodeJpeg(b.photo, 400 * 1024), 'image/jpeg'); hasPhoto = true; }
      const lat = b.lat === null || b.lat === undefined || b.lat === '' ? null : Number(b.lat);
      const lng = b.lng === null || b.lng === undefined || b.lng === '' ? null : Number(b.lng);
      const okXY = Number.isFinite(lat) && Number.isFinite(lng) && lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lng >= BOUNDS.lngMin && lng <= BOUNDS.lngMax;
      await sugs.setJSON('s/' + id, {
        id, name, cat: b.cat, town: clean(b.town, 40) || 'Otro', tel: clean(b.tel, 40), web: safeUrl(b.web), mapUrl: clean(b.mapUrl, 300),
        lat: okXY ? lat : null, lng: okXY ? lng : null, note: cleanMultiline(b.note, 600), by: u.name, byEmail: u.email, at: now(), photo: hasPhoto
      });
      return send(200, { ok: true });
    }

    // ----- solo administrador -----
    if (method === 'POST' && path === '/lugares') {
      await needAdmin(req);
      const b = await readBody(req);
      return send(200, { place: await savePlace(b.place) });
    }
    if (method === 'DELETE' && (m = /^\/lugares\/([A-Za-z0-9_-]{1,30})$/.exec(path))) {
      await needAdmin(req);
      const id = m[1];
      await mutatePlaces((list) => {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) throw new HttpError(404, 'Ese lugar ya no existe.');
        list.splice(i, 1);
        return { list, value: true };
      });
      await fotos.del('p/' + id).catch(() => {});
      return send(200, { ok: true });
    }
    if ((method === 'PUT' || method === 'DELETE') && (m = /^\/foto\/([A-Za-z0-9_-]{1,30})$/.exec(path))) {
      await needAdmin(req);
      const id = m[1];
      let buf = null;
      if (method === 'PUT') { const b = await readBody(req); buf = decodeJpeg(b.data, 1500 * 1024); }
      const stamp = method === 'PUT' ? now() : 0;
      const place = await mutatePlaces((list) => {
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) throw new HttpError(404, 'Ese lugar ya no existe.');
        list[i].photo = stamp;
        return { list, value: list[i] };
      });
      if (buf) await fotos.setBin('p/' + id, buf, 'image/jpeg'); else await fotos.del('p/' + id).catch(() => {});
      return send(200, { place });
    }
    if (method === 'GET' && path === '/sugerencias') {
      await needAdmin(req);
      const keys = await sugs.list('s/');
      const out = [];
      for (const k of keys) { const r = await sugs.getJSON(k); if (r) out.push(r.data); }
      out.sort((a, b) => b.at - a.at);
      return send(200, { suggestions: out });
    }
    if (method === 'GET' && (m = /^\/sugerencias\/([A-Za-z0-9_-]{1,30})\/foto$/.exec(path))) {
      await needAdmin(req);
      const f = await fotos.getBin('s/' + m[1]);
      if (!f) return send(404, { error: 'Sin foto.' });
      return new Response(f.buf, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (method === 'POST' && (m = /^\/sugerencias\/([A-Za-z0-9_-]{1,30})\/(aprobar|rechazar)$/.exec(path))) {
      await needAdmin(req);
      const id = m[1];
      const s = await sugs.getJSON('s/' + id);
      if (!s) throw new HttpError(404, 'Esa sugerencia ya fue resuelta.');
      let place = null;
      if (m[2] === 'aprobar') {
        const b = await readBody(req);
        place = await savePlace(Object.assign({}, b.place, { id: undefined }));
        if (s.data.photo) {
          const f = await fotos.getBin('s/' + id);
          if (f) {
            await fotos.setBin('p/' + place.id, f.buf, 'image/jpeg');
            place = await mutatePlaces((list) => { const i = list.findIndex((p) => p.id === place.id); list[i].photo = now(); return { list, value: list[i] }; });
          }
        }
      }
      await sugs.del('s/' + id);
      await fotos.del('s/' + id).catch(() => {});
      return send(200, { ok: true, place });
    }
    if (method === 'PUT' && path === '/mareas') {
      await needAdmin(req);
      const b = await readBody(req);
      const tides = cleanTides(b.tides);
      // El panel muestra la fuente ya combinada con la del cálculo automático; se guarda solo la parte propia.
      const src = clean(b.src, 300).split(' · Después de esa fecha: ')[0].trim() || SEED_TIDES_SRC;
      await data.setJSON('mareas', { tides, src, at: now() });
      return send(200, currentTides({ tides, src }, now()));
    }
    if (method === 'GET' && path === '/usuarios') {
      await needAdmin(req);
      const keys = await users.list('u/');
      const out = [];
      for (const k of keys) { const r = await users.getJSON(k); if (r) out.push({ email: r.data.email, name: r.data.name, role: r.data.role, created: r.data.created, lastLogin: r.data.lastLogin }); }
      out.sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));
      return send(200, { users: out });
    }
    if (method === 'POST' && path === '/usuarios/rol') {
      const me = await needAdmin(req);
      const b = await readBody(req);
      const email = clean(b.email, 120).toLowerCase();
      if (ROLES.indexOf(b.role) < 0) throw new HttpError(400, 'Perfil no válido.');
      const u = await loadUser(email);
      if (!u) throw new HttpError(404, 'No existe esa cuenta.');
      if (u.role === 'admin' && b.role !== 'admin' && (await adminCount()) <= 1) throw new HttpError(400, 'Debe quedar al menos un administrador.');
      u.role = b.role;
      await users.setJSON(ukey(email), u);
      return send(200, { ok: true, self: me.email === email });
    }
    if (method === 'POST' && path === '/usuarios/clave') {
      await needAdmin(req);
      const b = await readBody(req);
      const email = clean(b.email, 120).toLowerCase();
      const u = await loadUser(email);
      if (!u) throw new HttpError(404, 'No existe esa cuenta.');
      const pw = tempPassword();
      u.salt = randomBytes(16).toString('hex');
      u.hash = await hashPw(pw, u.salt);
      u.v = (u.v || 0) + 1;
      await users.setJSON(ukey(email), u);
      return send(200, { clave: pw });
    }
    if (method === 'DELETE' && (m = /^\/usuarios\/([^/]+)$/.exec(path))) {
      const me = await needAdmin(req);
      let email = '';
      try { email = decodeURIComponent(m[1]).toLowerCase(); } catch (e) { throw new HttpError(400, 'Correo no válido.'); }
      if (email === me.email) throw new HttpError(400, 'No puedes borrar tu propia cuenta.');
      const u = await loadUser(email);
      if (!u) throw new HttpError(404, 'No existe esa cuenta.');
      if (u.role === 'admin' && (await adminCount()) <= 1) throw new HttpError(400, 'Debe quedar al menos un administrador.');
      await users.del(ukey(email));
      return send(200, { ok: true });
    }

    throw new HttpError(404, 'No existe esa dirección.');
  }

  return async function handle(req, ip) {
    try { return await route(req, ip || 'local'); }
    catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error('Error en la API:', e && e.stack ? e.stack : e);
      return send(500, { error: 'Algo salió mal en el servidor. Inténtalo de nuevo en un momento.' });
    }
  };
}

/* ---------- Netlify ---------- */
let api = null;
export default async (req, context) => {
  if (!api) api = createApi(blobKV);
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'sin-ip';
  return api(req, ip);
};

export const config = { path: '/api/*' };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { createApi } from '../netlify/functions/api.mjs';
import { memoryKV } from './memory-kv.mjs';
import { computeTides } from '../netlify/functions/mareas-calc.mjs';
import { TIDES as SEED_TIDES } from '../netlify/functions/seed.mjs';

const CODE = 'CHILOE-PRUEBA-0000';
const salt = randomBytes(16);
const SETUP = { salt: salt.toString('hex'), hash: scryptSync(CODE, salt, 64).toString('hex') };

// Un "navegador" de mentira: guarda la cookie de sesión y manda siempre el encabezado x-guia.
function browser(api, ip) {
  let cookie = '';
  async function call(method, path, body, extra) {
    const headers = Object.assign({ 'x-guia': '1' }, extra || {});
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await api(new Request('https://guia.test/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ip || '1.1.1.1');
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), res };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
const fresh = () => createApi(memoryKV(), { setup: SETUP });
const jpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]).toString('base64');
const place = (o) => Object.assign({ name: 'Lugar de prueba', cat: 'comer', sub: 'Café', town: 'Castro', lat: -42.48, lng: -73.76, hours: 'L–V 10:00–18:00', tel: '+56912345678', web: 'ejemplo.cl', desc: 'Rico.' }, o || {});

async function withAdmin(nowMs) {
  const api = createApi(memoryKV(), { setup: SETUP, now: nowMs ? () => nowMs : undefined });
  const admin = browser(api);
  const r = await admin.call('POST', '/instalar', { codigo: CODE, name: 'Drago', email: 'Admin@Correo.cl', password: 'clave-larga-1' });
  assert.equal(r.status, 200);
  return { api, admin };
}

test('visualizador: puede mirar, no puede cambiar nada', async () => {
  const api = fresh(); const v = browser(api);
  const l = await v.call('GET', '/lugares');
  assert.equal(l.status, 200); assert.equal(l.body.places.length, 65);
  assert.ok((await v.call('GET', '/mareas')).body.tides.length >= 1);
  assert.equal((await v.call('GET', '/yo')).body.user, null);
  assert.equal((await v.call('POST', '/lugares', { place: place() })).status, 401);
  assert.equal((await v.call('GET', '/usuarios')).status, 401);
  assert.equal((await v.call('GET', '/sugerencias')).status, 401);
  assert.equal((await v.call('POST', '/sugerencias', { name: 'x' })).status, 401);
  assert.equal((await v.call('PUT', '/favoritos', { ids: ['1'] })).status, 401);
});

test('seguridad: sin encabezado x-guia o con otro origen no se puede escribir', async () => {
  const api = fresh();
  const r1 = await api(new Request('https://guia.test/api/registro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(r1.status, 403);
  const r2 = await api(new Request('https://guia.test/api/registro', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guia': '1', origin: 'https://malo.example' }, body: '{}' }));
  assert.equal(r2.status, 403);
  const r3 = await api(new Request('https://guia.test/api/lugares', { method: 'GET' }));
  assert.equal(r3.status, 200);
});

test('instalación del administrador: código correcto, una sola vez', async () => {
  const api = fresh(); const a = browser(api);
  assert.equal((await a.call('GET', '/estado')).body.hasAdmin, false);
  assert.equal((await a.call('POST', '/instalar', { codigo: 'MAL', email: 'a@b.cl', password: '12345678' })).status, 403);
  assert.equal((await a.call('GET', '/estado')).body.hasAdmin, false);
  const ok = await a.call('POST', '/instalar', { codigo: CODE.toLowerCase(), name: 'Drago', email: 'Admin@Correo.cl', password: '12345678' });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.role, 'admin'); assert.equal(ok.body.user.email, 'admin@correo.cl');
  assert.match(ok.res.headers.get('set-cookie'), /HttpOnly/); assert.match(ok.res.headers.get('set-cookie'), /SameSite=Strict/); assert.match(ok.res.headers.get('set-cookie'), /Secure/);
  assert.equal((await a.call('GET', '/estado')).body.hasAdmin, true);
  assert.equal((await browser(api).call('POST', '/instalar', { codigo: CODE, email: 'otro@b.cl', password: '12345678' })).status, 403);
  assert.equal((await a.call('GET', '/yo')).body.user.role, 'admin');
});

test('registro y entrada: validaciones, duplicados, contraseña mala, bloqueo por intentos', async () => {
  const api = fresh(); const u = browser(api);
  assert.equal((await u.call('POST', '/registro', { name: 'Ana', email: 'no-es-correo', password: '12345678' })).status, 400);
  assert.equal((await u.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: '123' })).status, 400);
  const r = await u.call('POST', '/registro', { name: 'Ana', email: 'Ana@Correo.cl', password: 'secreta-123' });
  assert.equal(r.status, 200); assert.equal(r.body.user.role, 'usuario');
  assert.equal((await browser(api).call('POST', '/registro', { name: 'Otra', email: 'ana@correo.cl', password: 'secreta-123' })).status, 409);
  const b = browser(api);
  const bad = await b.call('POST', '/entrar', { email: 'ana@correo.cl', password: 'incorrecta' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error, 'Correo o contraseña incorrectos.');
  assert.equal((await b.call('POST', '/entrar', { email: 'nadie@correo.cl', password: 'incorrecta' })).body.error, 'Correo o contraseña incorrectos.');
  assert.equal((await b.call('POST', '/entrar', { email: 'ana@correo.cl', password: 'secreta-123' })).status, 200);
  assert.equal((await b.call('GET', '/yo')).body.user.name, 'Ana');
  // bloqueo tras 6 intentos fallidos desde el mismo lugar
  const c = browser(api, '9.9.9.9');
  for (let i = 0; i < 6; i++) assert.equal((await c.call('POST', '/entrar', { email: 'ana@correo.cl', password: 'x' + i })).status, 401);
  assert.equal((await c.call('POST', '/entrar', { email: 'ana@correo.cl', password: 'secreta-123' })).status, 429);
  // otra persona desde otro lugar sí puede entrar
  assert.equal((await browser(api, '8.8.8.8').call('POST', '/entrar', { email: 'ana@correo.cl', password: 'secreta-123' })).status, 200);
  // cerrar sesión
  await b.call('POST', '/salir', {}); assert.equal((await b.call('GET', '/yo')).body.user, null);
});

test('una cookie falsificada o alterada no sirve', async () => {
  const { api, admin } = await withAdmin();
  const f = browser(api);
  f.cookie = admin.cookie.slice(0, -3) + 'AAA';
  assert.equal((await f.call('GET', '/yo')).body.user, null);
  f.cookie = 'gc=' + Buffer.from(JSON.stringify({ e: 'admin@correo.cl', v: 0, x: Date.now() + 1e9 })).toString('base64url') + '.firmafalsa';
  assert.equal((await f.call('GET', '/usuarios')).status, 401);
});

test('usuario registrado: favoritos y sugerencias sí; editar la guía no', async () => {
  const api = fresh(); const u = browser(api);
  await u.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  assert.deepEqual((await u.call('PUT', '/favoritos', { ids: ['1', '2', '2', '<script>', 'x'.repeat(50)] })).body.favs, ['1', '2']);
  assert.deepEqual((await u.call('GET', '/yo')).body.favs, ['1', '2']);
  assert.equal((await u.call('POST', '/sugerencias', { name: 'Cocinería Rosa', cat: 'comer', town: 'Dalcahue', note: 'Muy rica', photo: jpeg() })).status, 200);
  assert.equal((await u.call('POST', '/sugerencias', { name: 'A', cat: 'comer' })).status, 400);
  assert.equal((await u.call('POST', '/sugerencias', { name: 'Algo', cat: 'otra' })).status, 400);
  assert.equal((await u.call('POST', '/sugerencias', { name: 'Algo', cat: 'comer', photo: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await u.call('POST', '/lugares', { place: place() })).status, 403);
  assert.equal((await u.call('DELETE', '/lugares/1')).status, 403);
  assert.equal((await u.call('PUT', '/foto/1', { data: jpeg() })).status, 403);
  assert.equal((await u.call('PUT', '/mareas', { tides: [] })).status, 403);
  assert.equal((await u.call('GET', '/usuarios')).status, 403);
  assert.equal((await u.call('POST', '/usuarios/rol', { email: 'ana@correo.cl', role: 'admin' })).status, 403);
  assert.equal((await u.call('GET', '/sugerencias')).status, 403);
});

test('administrador: crear, editar, borrar lugares y validar datos', async () => {
  const { admin } = await withAdmin();
  const c = await admin.call('POST', '/lugares', { place: place({ lat: '-42,48', rating: 4.66, count: '12' }) });
  assert.equal(c.status, 200);
  const p = c.body.place;
  assert.ok(p.id.startsWith('n')); assert.equal(p.web, 'https://ejemplo.cl'); assert.equal(p.lat, -42.48); assert.equal(p.rating, 4.7); assert.equal(p.count, 12);
  assert.equal((await admin.call('GET', '/lugares')).body.places.length, 66);
  const u = await admin.call('POST', '/lugares', { place: Object.assign({}, p, { name: 'Nuevo nombre', hours: 'Todos los días' }) });
  assert.equal(u.body.place.name, 'Nuevo nombre'); assert.equal(u.body.place.id, p.id);
  assert.equal((await admin.call('GET', '/lugares')).body.places.length, 66);
  // el primer lugar de la guía también se puede editar
  const first = (await admin.call('GET', '/lugares')).body.places[0];
  assert.equal((await admin.call('POST', '/lugares', { place: Object.assign({}, first, { desc: 'Texto nuevo' }) })).body.place.desc, 'Texto nuevo');
  // validaciones
  for (const bad of [{ name: 'x' }, { cat: 'otra' }, { lat: -10, lng: -73 }, { lat: -42.4, lng: null }, { lat: 'abc', lng: -73.7 }, { rating: 9 }]) {
    assert.equal((await admin.call('POST', '/lugares', { place: place(bad) })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin.call('POST', '/lugares', { place: place({ id: 'noexiste' }) })).status, 404);
  const xss = await admin.call('POST', '/lugares', { place: place({ web: 'javascript:alert(1)', name: '<b>Hola</b>' }) });
  assert.equal(xss.body.place.web, ''); // la dirección peligrosa se descarta
  assert.equal((await admin.call('DELETE', '/lugares/' + p.id)).status, 200);
  assert.equal((await admin.call('DELETE', '/lugares/' + p.id)).status, 404);
  // un lugar sin ubicación en el mapa es válido
  assert.equal((await admin.call('POST', '/lugares', { place: place({ lat: null, lng: null }) })).body.place.lat, null);
});

test('administrador: dos ediciones a la vez no se pisan', async () => {
  const { admin } = await withAdmin();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => admin.call('POST', '/lugares', { place: place({ name: 'Simultáneo ' + i }) })));
  rs.forEach((r) => assert.equal(r.status, 200));
  assert.equal((await admin.call('GET', '/lugares')).body.places.length, 70);
});

test('fotos: el administrador sube y quita; cualquiera las ve', async () => {
  const { api, admin } = await withAdmin();
  assert.equal((await browser(api).call('GET', '/foto/3')).status, 404);
  assert.equal((await admin.call('PUT', '/foto/3', { data: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await admin.call('PUT', '/foto/noexiste', { data: jpeg() })).status, 404);
  const up = await admin.call('PUT', '/foto/3', { data: jpeg() });
  assert.equal(up.status, 200); assert.ok(up.body.place.photo > 0);
  const g = await browser(api).call('GET', '/foto/3');
  assert.equal(g.status, 200); assert.equal(g.res.headers.get('content-type'), 'image/jpeg'); assert.equal(g.body[0], 0xff);
  assert.ok((await browser(api).call('GET', '/lugares')).body.places.find((p) => p.id === '3').photo > 0);
  assert.equal((await admin.call('DELETE', '/foto/3')).body.place.photo, 0);
  assert.equal((await browser(api).call('GET', '/foto/3')).status, 404);
});

test('sugerencias: el usuario envía, el administrador aprueba (con foto) o rechaza', async () => {
  const { api, admin } = await withAdmin();
  const ana = browser(api);
  await ana.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  await ana.call('POST', '/sugerencias', { name: 'Cocinería Rosa', cat: 'comer', town: 'Dalcahue', note: 'Muy rica', lat: -42.38, lng: -73.65, photo: jpeg() });
  await ana.call('POST', '/sugerencias', { name: 'Mirador Lindo', cat: 'visitar', town: 'Castro' });
  const l = (await admin.call('GET', '/sugerencias')).body.suggestions;
  assert.equal(l.length, 2);
  const rosa = l.find((s) => s.name === 'Cocinería Rosa');
  assert.equal(rosa.by, 'Ana'); assert.equal(rosa.photo, true);
  assert.equal((await admin.call('GET', '/sugerencias/' + rosa.id + '/foto')).status, 200);
  assert.equal((await ana.call('GET', '/sugerencias/' + rosa.id + '/foto')).status, 403);
  const ap = await admin.call('POST', '/sugerencias/' + rosa.id + '/aprobar', { place: place({ name: 'Cocinería Rosa', town: 'Dalcahue', lat: -42.38, lng: -73.65 }) });
  assert.equal(ap.status, 200); assert.ok(ap.body.place.photo > 0);
  assert.equal((await browser(api).call('GET', '/foto/' + ap.body.place.id)).status, 200);
  assert.ok((await browser(api).call('GET', '/lugares')).body.places.some((p) => p.name === 'Cocinería Rosa'));
  assert.equal((await admin.call('POST', '/sugerencias/' + rosa.id + '/aprobar', { place: place() })).status, 404);
  const mir = l.find((s) => s.name === 'Mirador Lindo');
  assert.equal((await admin.call('POST', '/sugerencias/' + mir.id + '/rechazar', {})).status, 200);
  assert.equal((await admin.call('GET', '/sugerencias')).body.suggestions.length, 0);
});

test('mareas: el administrador corrige días a mano, el resto sigue calculándose, y se validan', async () => {
  const { api, admin } = await withAdmin(Date.parse('2026-10-28T15:00:00Z'));
  const ok = await admin.call('PUT', '/mareas', { tides: [['2026-11-02', [['10:00', 'H', 5.1], ['04:00', 'L', 1.2]]], ['2026-11-01', [['09:00', 'H', 5]]]], src: 'SHOA' });
  assert.equal(ok.status, 200);
  const g = (await browser(api).call('GET', '/mareas')).body;
  const day = (d) => g.tides.find((x) => x[0] === d);
  assert.deepEqual(day('2026-11-01')[1], [['09:00', 'H', 5]]);                       // lo escrito a mano se respeta
  assert.deepEqual(day('2026-11-02')[1], [['04:00', 'L', 1.2], ['10:00', 'H', 5.1]]);
  assert.ok(day('2026-11-03')[1].length >= 3 && day('2026-10-30')[1].length >= 3);   // el resto se calcula solo
  assert.ok(g.src.startsWith('SHOA') && g.src.includes('cálculo automático') && g.src.includes('TICON-4'));
  // Si el panel devuelve la fuente ya combinada, no se duplica el texto del cálculo automático.
  const again = await admin.call('PUT', '/mareas', { tides: [['2026-11-01', [['09:00', 'H', 5]]]], src: g.src });
  assert.equal(again.status, 200);
  const g2 = (await browser(api).call('GET', '/mareas')).body;
  assert.equal(g2.src.split('Después de esa fecha').length, 2, g2.src);
  assert.ok(g2.src.startsWith('SHOA'));
  for (const bad of [[], 'x', [['2026-13-01', [['10:00', 'H', 5]]]], [['2026-02-30', [['10:00', 'H', 5]]]], [['2026-11-01', [['25:00', 'H', 5]]]], [['2026-11-01', [['10:00', 'X', 5]]]], [['2026-11-01', [['10:00', 'H', 99]]]], [['2026-11-01', []]], [['2026-11-01', [['10:00', 'H', 5]]], ['2026-11-01', [['10:00', 'H', 5]]]]]) {
    assert.equal((await admin.call('PUT', '/mareas', { tides: bad })).status, 400, JSON.stringify(bad));
  }
});

test('mareas: siempre hay días seguidos desde ayer hasta 30 días después de hoy, también al cambiar la hora de Chile', async () => {
  for (const [nowIso, desde, hasta] of [['2027-03-05T15:00:00Z', '2027-03-04', '2027-04-04'], ['2027-04-02T15:00:00Z', '2027-04-01', '2027-05-02'], ['2027-08-30T15:00:00Z', '2027-08-29', '2027-09-29'], ['2031-01-10T03:00:00Z', '2031-01-09', '2031-02-09']]) {
    const api = createApi(memoryKV(), { setup: SETUP, now: () => Date.parse(nowIso) });
    const g = (await browser(api).call('GET', '/mareas')).body;
    assert.equal(g.tides[0][0], desde, nowIso); assert.equal(g.tides.at(-1)[0], hasta, nowIso);
    assert.ok(g.src.includes('TICON-4'));
    let prev = null;
    for (const [d, ev] of g.tides) {
      if (prev) assert.equal(d, new Date(Date.parse(prev + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10), 'faltan días: ' + prev + ' → ' + d);
      prev = d;
      assert.ok(ev.length >= 3 && ev.length <= 5, d + ' tiene ' + ev.length + ' mareas');
      for (let i = 0; i < ev.length; i++) {
        assert.match(ev[i][0], /^([01]\d|2[0-3]):[0-5]\d$/);
        assert.ok(ev[i][2] > 0 && ev[i][2] < 7.5, d + ' altura rara ' + ev[i][2]);
        if (i) { assert.ok(ev[i][0] > ev[i - 1][0], d + ' horas desordenadas'); assert.notEqual(ev[i][1], ev[i - 1][1], d + ' dos pleamares/bajamares seguidas'); }
      }
    }
  }
});

test('mareas: el cálculo automático coincide con los 10 días del modelo FES2022 que traía la guía', () => {
  const calc = computeTides(SEED_TIDES[0][0], SEED_TIDES.at(-1)[0]);
  const dh = [], dt = [];
  const mins = (hm) => (+hm.slice(0, 2)) * 60 + (+hm.slice(3));
  for (let i = 0; i < SEED_TIDES.length; i++) {
    assert.equal(calc[i][0], SEED_TIDES[i][0]);
    assert.equal(calc[i][1].length, SEED_TIDES[i][1].length, 'distinta cantidad de mareas el ' + SEED_TIDES[i][0]);
    SEED_TIDES[i][1].forEach((e, k) => { const c = calc[i][1][k]; assert.equal(c[1], e[1]); dt.push(mins(c[0]) - mins(e[0])); dh.push(c[2] - e[2]); });
  }
  const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length), mx = (a) => Math.max(...a.map(Math.abs));
  assert.ok(rms(dt) < 12 && mx(dt) <= 25, 'hora: rms ' + rms(dt).toFixed(1) + ' máx ' + mx(dt));
  assert.ok(rms(dh) < 0.09 && mx(dh) <= 0.2, 'altura: rms ' + rms(dh).toFixed(3) + ' máx ' + mx(dh));
});

test('usuarios: cambiar perfil, restablecer clave, borrar, y nunca quedarse sin administrador', async () => {
  const { api, admin } = await withAdmin();
  const ana = browser(api);
  await ana.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  const list = (await admin.call('GET', '/usuarios')).body.users;
  assert.deepEqual(list.map((x) => x.role), ['admin', 'usuario']);
  assert.ok(!JSON.stringify(list).includes('hash'));
  // no se puede quitar al único administrador
  assert.equal((await admin.call('POST', '/usuarios/rol', { email: 'admin@correo.cl', role: 'usuario' })).status, 400);
  assert.equal((await admin.call('DELETE', '/usuarios/' + encodeURIComponent('admin@correo.cl'))).status, 400);
  // Ana pasa a administradora: el cambio vale de inmediato
  assert.equal((await ana.call('GET', '/usuarios')).status, 403);
  assert.equal((await admin.call('POST', '/usuarios/rol', { email: 'ana@correo.cl', role: 'admin' })).status, 200);
  assert.equal((await ana.call('GET', '/usuarios')).status, 200);
  assert.equal((await admin.call('POST', '/usuarios/rol', { email: 'ana@correo.cl', role: 'superman' })).status, 400);
  // ahora sí se puede quitar al primero
  assert.equal((await ana.call('POST', '/usuarios/rol', { email: 'admin@correo.cl', role: 'usuario' })).status, 200);
  assert.equal((await admin.call('GET', '/usuarios')).status, 403);
  // restablecer clave: la sesión anterior se cierra y la clave temporal funciona
  const anaOld = ana.cookie;
  const t = await ana.call('POST', '/usuarios/clave', { email: 'admin@correo.cl' });
  assert.equal(t.status, 200); assert.equal(t.body.clave.length, 10);
  assert.equal((await admin.call('GET', '/yo')).body.user, null);
  assert.equal((await browser(api, '5.5.5.5').call('POST', '/entrar', { email: 'admin@correo.cl', password: t.body.clave })).status, 200);
  assert.equal((await browser(api, '5.5.5.6').call('POST', '/entrar', { email: 'admin@correo.cl', password: 'clave-larga-1' })).status, 401);
  assert.equal(anaOld, ana.cookie);
  // borrar
  assert.equal((await ana.call('DELETE', '/usuarios/' + encodeURIComponent('ana@correo.cl'))).status, 400); // a sí misma, no
  assert.equal((await ana.call('DELETE', '/usuarios/' + encodeURIComponent('admin@correo.cl'))).status, 200);
  assert.equal((await ana.call('DELETE', '/usuarios/' + encodeURIComponent('admin@correo.cl'))).status, 404);
});

test('cambiar mi contraseña: pide la actual y cierra las otras sesiones', async () => {
  const api = fresh(); const a = browser(api), b = browser(api, '2.2.2.2');
  await a.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  await b.call('POST', '/entrar', { email: 'ana@correo.cl', password: 'secreta-123' });
  assert.equal((await a.call('POST', '/cuenta/clave', { actual: 'mala', nueva: 'nueva-clave-1' })).status, 400);
  assert.equal((await a.call('POST', '/cuenta/clave', { actual: 'secreta-123', nueva: 'corta' })).status, 400);
  assert.equal((await a.call('POST', '/cuenta/clave', { actual: 'secreta-123', nueva: 'nueva-clave-1' })).status, 200);
  assert.equal((await a.call('GET', '/yo')).body.user.email, 'ana@correo.cl'); // esta sesión sigue
  assert.equal((await b.call('GET', '/yo')).body.user, null); // la otra se cerró
  assert.equal((await browser(api, '3.3.3.3').call('POST', '/entrar', { email: 'ana@correo.cl', password: 'nueva-clave-1' })).status, 200);
});

test('rutas desconocidas y errores no filtran información interna', async () => {
  const api = fresh(); const v = browser(api);
  assert.equal((await v.call('GET', '/nada')).status, 404);
  const bad = await api(new Request('https://guia.test/api/registro', { method: 'POST', headers: { 'x-guia': '1', 'content-type': 'application/json' }, body: '{no es json' }));
  assert.equal(bad.status, 400);
});

/* ---------- secciones editables (V 1.13) ---------- */
const sec = (id, n, icon, color) => Object.assign({ n, icon: icon || 'estrella', color: color || '#0E5A6B' }, id ? { id } : {});

test('secciones: todos las ven; solo el administrador las cambia', async () => {
  const { api, admin } = await withAdmin();
  const v = browser(api);
  const l = await v.call('GET', '/lugares');
  assert.deepEqual(l.body.cats.map((c) => c.id), ['comer', 'visitar', 'comprar', 'servicios']);
  assert.deepEqual(l.body.cats.map((c) => c.n), ['Comer', 'Visitar', 'Comprar', 'Servicios']);
  const nuevas = l.body.cats.concat([sec(null, 'Alojamiento')]);
  assert.equal((await v.call('PUT', '/secciones', { cats: nuevas })).status, 401);
  const ana = browser(api, '2.2.2.2');
  await ana.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  assert.equal((await ana.call('PUT', '/secciones', { cats: nuevas })).status, 403);
  assert.equal((await v.call('GET', '/lugares')).body.cats.length, 4); // nada cambió
  assert.equal((await admin.call('PUT', '/secciones', { cats: nuevas })).status, 200);
  assert.equal((await v.call('GET', '/lugares')).body.cats.length, 5);
});

test('secciones: agregar, renombrar sin perder lugares, cambiar ícono y color, reordenar', async () => {
  const { api, admin } = await withAdmin();
  const v = browser(api);
  const cats0 = (await v.call('GET', '/lugares')).body.cats;
  const add = await admin.call('PUT', '/secciones', { cats: cats0.concat([sec(null, 'Alojamiento y más', 'cama', '#7a3fa0')]) });
  assert.equal(add.status, 200);
  const nueva = add.body.cats[4];
  assert.equal(nueva.id, 'alojamiento-y-mas'); assert.equal(nueva.color, '#7A3FA0'); assert.equal(nueva.icon, 'cama');
  // se puede publicar un lugar en la sección nueva
  const p = await admin.call('POST', '/lugares', { place: place({ name: 'Cabañas del Mar', cat: nueva.id }) });
  assert.equal(p.status, 200);
  // renombrar: el identificador se mantiene y el lugar sigue en la sección
  const ren = add.body.cats.map((c) => (c.id === nueva.id ? Object.assign({}, c, { n: 'Dónde dormir', icon: 'casa', color: '#112233' }) : c));
  const r2 = await admin.call('PUT', '/secciones', { cats: ren });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.cats[4].id, nueva.id); assert.equal(r2.body.cats[4].n, 'Dónde dormir');
  const l = (await v.call('GET', '/lugares')).body;
  assert.equal(l.places.find((x) => x.name === 'Cabañas del Mar').cat, nueva.id);
  // reordenar: la nueva pasa al primer lugar
  const orden = [r2.body.cats[4]].concat(r2.body.cats.slice(0, 4));
  assert.deepEqual((await admin.call('PUT', '/secciones', { cats: orden })).body.cats.map((c) => c.id), [nueva.id, 'comer', 'visitar', 'comprar', 'servicios']);
  assert.equal((await v.call('GET', '/lugares')).body.cats[0].id, nueva.id);
});

test('secciones: validaciones de nombre, ícono, color, cantidad e identificadores', async () => {
  const { api, admin } = await withAdmin();
  const cats = (await browser(api).call('GET', '/lugares')).body.cats;
  const put = (list) => admin.call('PUT', '/secciones', { cats: list });
  assert.equal((await put([])).status, 400);
  assert.equal((await put('x')).status, 400);
  assert.equal((await put(cats.concat([sec(null, 'A')]))).status, 400); // nombre muy corto
  assert.equal((await put(cats.concat([sec(null, 'comer')]))).status, 400); // repetido
  assert.equal((await put(cats.concat([sec(null, 'Cómer')]))).status, 400); // repetido sin tildes ni mayúsculas
  assert.equal((await put(cats.concat([sec(null, 'Playas', 'no-existe')]))).status, 400);
  assert.equal((await put(cats.concat([sec(null, 'Playas', 'olas', 'rojo')]))).status, 400);
  assert.equal((await put(cats.concat([sec(null, 'Playas', 'olas', 'javascript:1')]))).status, 400);
  assert.equal((await put(cats.concat([sec('inventada', 'Playas', 'olas')]))).status, 400); // id que no existe
  assert.equal((await put(cats.concat([cats[0]]))).status, 400); // misma sección dos veces
  const trece = cats.slice(); for (let i = 0; i < 9; i++) trece.push(sec(null, 'Sección ' + (i + 1)));
  assert.equal((await put(trece)).status, 400); // más de 12
  assert.equal((await put(cats.concat([sec(null, '<b>Hola</b> ' + 'x'.repeat(40))]))).status, 200); // se recorta y limpia
  const l = (await browser(api).call('GET', '/lugares')).body.cats;
  assert.ok(l[4].n.length <= 24);
});

test('secciones: nombres raros no chocan con identificadores existentes ni con "guardados"', async () => {
  const { api, admin } = await withAdmin();
  const cats = (await browser(api).call('GET', '/lugares')).body.cats;
  const r = await admin.call('PUT', '/secciones', { cats: cats.concat([sec(null, 'Guardados'), sec(null, 'Constructor'), sec(null, 'Áéí ñ'), sec(null, '!!!')]) });
  assert.equal(r.status, 200);
  const ids = r.body.cats.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z0-9-]{1,24}$/.test(id)));
  assert.ok(!ids.includes('guardados'));
  assert.equal((await admin.call('PUT', '/secciones', { cats: [sec('constructor', 'X')].concat(cats) })).status, 400);
});

test('secciones: al eliminar una con lugares hay que elegir a dónde se mueven', async () => {
  const { api, admin } = await withAdmin();
  const v = browser(api);
  const base = (await v.call('GET', '/lugares')).body;
  const nComprar = base.places.filter((p) => p.cat === 'comprar').length;
  const nVisitar = base.places.filter((p) => p.cat === 'visitar').length;
  assert.ok(nComprar > 0);
  const sinComprar = base.cats.filter((c) => c.id !== 'comprar');
  const sinMover = await admin.call('PUT', '/secciones', { cats: sinComprar });
  assert.equal(sinMover.status, 400); assert.match(sinMover.body.error, /Comprar/); assert.match(sinMover.body.error, /moverlos/);
  assert.equal((await admin.call('PUT', '/secciones', { cats: sinComprar, moves: { comprar: 'no-existe' } })).status, 400);
  assert.equal((await admin.call('PUT', '/secciones', { cats: sinComprar, moves: { comprar: 'comprar' } })).status, 400); // no puede moverlos a sí misma
  assert.equal((await v.call('GET', '/lugares')).body.cats.length, 4); // nada cambió
  const ok = await admin.call('PUT', '/secciones', { cats: sinComprar, moves: { comprar: 'visitar' } });
  assert.equal(ok.status, 200);
  const l = (await v.call('GET', '/lugares')).body;
  assert.deepEqual(l.cats.map((c) => c.id), ['comer', 'visitar', 'servicios']);
  assert.equal(l.places.length, 65); // no se perdió ningún lugar
  assert.equal(l.places.filter((p) => p.cat === 'visitar').length, nVisitar + nComprar);
  assert.equal(l.places.filter((p) => p.cat === 'comprar').length, 0);
  // ya no se puede publicar en una sección que no existe
  assert.equal((await admin.call('POST', '/lugares', { place: place({ cat: 'comprar' }) })).status, 400);
  assert.equal((await admin.call('POST', '/lugares', { place: place({ cat: 'visitar' }) })).status, 200);
});

test('secciones: una sección vacía se elimina sin pedir destino; no se puede dejar sin secciones', async () => {
  const { api, admin } = await withAdmin();
  const cats = (await browser(api).call('GET', '/lugares')).body.cats;
  const con = (await admin.call('PUT', '/secciones', { cats: cats.concat([sec(null, 'Eventos', 'calendario')]) })).body.cats;
  const evento = con[4];
  assert.equal((await admin.call('PUT', '/secciones', { cats })).status, 200); // la vacía se va sin problema
  assert.equal((await browser(api).call('GET', '/lugares')).body.cats.length, 4);
  assert.ok(evento.id);
  assert.equal((await admin.call('PUT', '/secciones', { cats: [] })).status, 400);
});

test('secciones: las sugerencias pendientes también se mueven y se pueden aprobar', async () => {
  const { api, admin } = await withAdmin();
  const ana = browser(api, '2.2.2.2');
  await ana.call('POST', '/registro', { name: 'Ana', email: 'ana@correo.cl', password: 'secreta-123' });
  const cats = (await ana.call('GET', '/lugares')).body.cats;
  const con = (await admin.call('PUT', '/secciones', { cats: cats.concat([sec(null, 'Eventos', 'calendario')]) })).body.cats;
  const ev = con[4].id;
  assert.equal((await ana.call('POST', '/sugerencias', { name: 'Feria costumbrista', cat: ev, town: 'Castro' })).status, 200);
  assert.equal((await ana.call('POST', '/sugerencias', { name: 'Algo', cat: 'no-existe', town: 'Castro' })).status, 400);
  const sinDestino = await admin.call('PUT', '/secciones', { cats, moves: {} });
  assert.equal(sinDestino.status, 400); assert.match(sinDestino.body.error, /Eventos/); // la sugerencia pendiente también cuenta
  assert.equal((await admin.call('PUT', '/secciones', { cats, moves: { [ev]: 'comer' } })).status, 200); // y pasa a la sección elegida
  const s = (await admin.call('GET', '/sugerencias')).body.suggestions;
  assert.equal(s.length, 1); assert.equal(s[0].cat, 'comer');
  const ap = await admin.call('POST', '/sugerencias/' + s[0].id + '/aprobar', { place: place({ name: 'Feria costumbrista', cat: s[0].cat }) });
  assert.equal(ap.status, 200);
});

test('secciones: dos cambios al mismo tiempo no se pisan', async () => {
  const { api, admin } = await withAdmin();
  const cats = (await browser(api).call('GET', '/lugares')).body.cats;
  const [a, b] = await Promise.all([
    admin.call('PUT', '/secciones', { cats: cats.concat([sec(null, 'Uno')]) }),
    admin.call('PUT', '/secciones', { cats: cats.concat([sec(null, 'Dos')]) })
  ]);
  const estados = [a.status, b.status].sort();
  assert.ok(estados[0] === 200 && (estados[1] === 200 || estados[1] === 409));
  const final = (await browser(api).call('GET', '/lugares')).body.cats;
  assert.equal(final.length, 5);
});

/* ---------- recorridos editables (V 1.16) ---------- */
const rutaOk = () => ({
  rutas: [{ id: 'prueba', nombre: 'Prueba', resumen: 'Un paseo', km: 12.34, min: 30, cruce: null, tramos: ['t1'],
    paradas: [{ n: 'Castro (Plaza de Armas)', lat: -42.4824, lng: -73.7625, nota: 'Punto de partida' }, { n: 'Dalcahue', lat: -42.3784, lng: -73.6504, lugar: 'Feria de Dalcahue' }] }],
  tramos: { t1: { t: 'c', e: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, sobrante: { t: 'c', e: '_p~iF~ps|U' } },
});

test('recorridos: nadie los guarda salvo el administrador; sin nada guardado se usa el archivo original', async () => {
  const { api, admin } = await withAdmin();
  const v = browser(api);
  assert.deepEqual((await v.call('GET', '/rutas')).body, { custom: false });
  assert.equal((await v.call('PUT', '/rutas', rutaOk())).status, 401);
  assert.equal((await v.call('DELETE', '/rutas')).status, 401);
  const ok = await admin.call('PUT', '/rutas', rutaOk());
  assert.equal(ok.status, 200);
  const g = (await v.call('GET', '/rutas')).body;
  assert.equal(g.custom, true);
  assert.equal(g.rutas[0].km, 12.3);
  assert.deepEqual(Object.keys(g.tramos), ['t1']);          // los tramos que ningún recorrido usa no se guardan
  assert.equal(g.rutas[0].paradas[1].lugar, 'Feria de Dalcahue');
  assert.equal((await admin.call('DELETE', '/rutas')).status, 200);
  assert.deepEqual((await v.call('GET', '/rutas')).body, { custom: false });
});

test('recorridos: se rechazan datos mal formados', async () => {
  const { admin } = await withAdmin();
  const mut = (f) => { const b = rutaOk(); f(b); return b; };
  const bad = [
    mut((b) => { b.rutas = 'x'; }),
    mut((b) => { b.rutas[0].id = 'Mayúsculas y espacios'; }),
    mut((b) => { b.rutas.push(JSON.parse(JSON.stringify(b.rutas[0]))); }),                // id repetido
    mut((b) => { b.rutas[0].nombre = ' '; }),
    mut((b) => { b.rutas[0].cruce = 'avión'; }),
    mut((b) => { b.rutas[0].paradas = [b.rutas[0].paradas[0]]; }),                          // una sola parada
    mut((b) => { b.rutas[0].paradas[1].lat = -10; }),                                       // fuera de Chiloé
    mut((b) => { b.rutas[0].paradas[1].lng = 'x'; }),
    mut((b) => { b.rutas[0].paradas[1].n = ''; }),
    mut((b) => { b.rutas[0].tramos = ['no-existe']; }),
    mut((b) => { b.rutas[0].tramos = []; }),
    mut((b) => { b.tramos.t1 = { t: 'c', e: 'con espacios <script>' }; }),
    mut((b) => { b.tramos.t1 = { t: 'z', e: 'abcd' }; }),
    mut((b) => { b.tramos.t1 = { t: 'b', a: [-42.3, -73.3] }; }),
    mut((b) => { b.tramos = []; }),
  ];
  for (const b of bad) assert.equal((await admin.call('PUT', '/rutas', b)).status, 400, JSON.stringify(b).slice(0, 120));
  const lancha = mut((b) => { b.tramos.t1 = { t: 'b', a: [-42.3317, -73.3751], b: [-42.3028, -73.2719] }; b.rutas[0].cruce = 'lancha'; });
  assert.equal((await admin.call('PUT', '/rutas', lancha)).status, 200);
});

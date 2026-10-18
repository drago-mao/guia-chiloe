// Revisa que public/rutas.json (recorridos con camino) esté completo y sin errores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../public/rutas.json', import.meta.url), 'utf8'));

function decode(str) {
  let i = 0, la = 0, lo = 0; const out = [];
  while (i < str.length) {
    let b, sh = 0, r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    la += (r & 1) ? ~(r >> 1) : (r >> 1);
    sh = 0; r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    lo += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([la / 1e5, lo / 1e5]);
  }
  return out;
}
const dist = (a, b) => { const k = 111320, c = Math.cos(a[0] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * k * c); };
const pts = (t) => (t.t === 'b' ? [t.a, t.b] : decode(t.e));
const inIsla = ([la, lo]) => la > -43.5 && la < -41.4 && lo > -74.8 && lo < -72.5;

test('hay 12 recorridos con datos básicos', () => {
  assert.equal(data.rutas.length, 12);
  const ids = new Set();
  for (const r of data.rutas) {
    assert.ok(r.id && r.nombre && r.resumen, 'falta nombre o resumen en ' + r.id);
    assert.ok(!ids.has(r.id), 'id repetido ' + r.id); ids.add(r.id);
    assert.ok(r.km > 0 && r.min > 0, 'km o minutos inválidos en ' + r.id);
    assert.ok(r.paradas.length >= 2, 'pocas paradas en ' + r.id);
    assert.ok([null, 'barco', 'lancha'].includes(r.cruce), 'cruce inválido en ' + r.id);
  }
});

test('cada recorrido usa tramos que existen y están pegados uno con otro', () => {
  for (const r of data.rutas) {
    const segs = r.tramos.map((id) => { assert.ok(data.tramos[id], `${r.id}: no existe el tramo ${id}`); return pts(data.tramos[id]); });
    for (const s of segs) { assert.ok(s.length >= 2); s.forEach((p) => assert.ok(inIsla(p), `${r.id}: punto fuera de Chiloé`)); }
    for (let i = 0; i < segs.length - 1; i++) {
      const gap = dist(segs[i][segs[i].length - 1], segs[i + 1][0]);
      assert.ok(gap < 400, `${r.id}: salto de ${Math.round(gap)} m entre tramos ${i + 1} y ${i + 2}`);
    }
  }
});

test('las paradas están dentro de Chiloé y la primera es Castro', () => {
  for (const r of data.rutas) {
    r.paradas.forEach((s) => assert.ok(s.n && inIsla([s.lat, s.lng]), `${r.id}: parada inválida ${s.n}`));
    assert.match(r.paradas[0].n, /^Castro/);
  }
});

test('los recorridos con cruce tienen un tramo de barco o lancha', () => {
  for (const r of data.rutas) {
    const tipos = r.tramos.map((id) => data.tramos[id].t);
    if (r.cruce === 'barco') assert.ok(tipos.includes('f'), r.id + ': falta tramo de barco');
    if (r.cruce === 'lancha') assert.ok(tipos.includes('b'), r.id + ': falta tramo de lancha');
    if (!r.cruce) assert.ok(!tipos.includes('f') && !tipos.includes('b'), r.id + ': tiene cruce pero no lo declara');
  }
});

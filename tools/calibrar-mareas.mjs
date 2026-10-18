// Calibra las mareas calculadas de Castro (netlify/functions/mareas-calc.mjs) contra una tabla de mareas de Castro.
// Sirve si algún día se consigue una tabla más larga o más confiable (por ejemplo, la oficial del SHOA).
//
// Uso:
//   npm install --no-save @neaps/tide-database
//   node tools/calibrar-mareas.mjs tabla.json
//
// "tabla.json" es una lista de días con el mismo formato de la guía, hora de Chile:
//   [["2026-10-17", [["05:41","H",4.45], ["12:42","L",2.77], ["18:53","H",3.68]]], ...]
// Mientras más días y más meses distintos tenga, mejor se separan la marea lunar y la solar (con 10 días solo se
// alcanza a ver media vuelta del ciclo de mareas vivas y muertas).
//
// Muestra los 5 números nuevos para CALIB y el error con validación cruzada (se calibra con unos días y se prueba con otros).
import fs from 'node:fs';
import { stationsById } from '@neaps/tide-database';
import { createTidePredictor, constituents as LIB } from '@neaps/tide-predictor';

const file = process.argv[2];
if (!file) { console.error('Falta el archivo. Uso: node tools/calibrar-mareas.mjs tabla.json'); process.exit(1); }
const TABLE = JSON.parse(fs.readFileSync(file, 'utf8'));
const hc = stationsById.get('ticon/puerto_montt-684-chl-uhslc_fd').harmonic_constituents;
const SOLAR = ['S2', 'K2', 'T2', 'R2'];

// Hora de Chile -> instante UTC (usa la regla de horario de verano de America/Santiago).
function chileToMs(day, hm) {
  const guess = Date.parse(day + 'T' + hm + ':00Z');
  for (const off of [3, 4]) {
    const ms = guess + off * 3600000;
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
    const g = Object.fromEntries(f.map((x) => [x.type, x.value]));
    if (g.year + '-' + g.month + '-' + g.day === day && g.hour + ':' + g.minute === hm) return ms;
  }
  return guess + 3 * 3600000;
}
const truth = [];
for (const [day, evs] of TABLE) for (const [hm, type, h] of evs) truth.push({ t: chileToMs(day, hm), type, h, day });
truth.sort((a, b) => a.t - b.t);
const START = truth[0].t - 86400000, END = truth.at(-1).t + 86400000;

const build = (q) => createTidePredictor(hc.map((c) => {
  const [a, tau] = SOLAR.includes(c.name) ? [q[3], q[4]] : [q[1], q[2]];
  return { name: c.name, amplitude: c.amplitude * a, phase: c.phase + LIB[c.name].speed * tau / 60 };
}), { offset: q[0] });
const extremes = (q) => build(q).getExtremesPrediction({ start: new Date(START), end: new Date(END) }).map((e) => ({ t: +e.time, type: e.high ? 'H' : 'L', h: e.level }));
function match(ex, sub) {
  return sub.map((c) => {
    let best = null;
    for (const e of ex) if (e.type === c.type) { const d = (e.t - c.t) / 60000; if (Math.abs(d) < 240 && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, dh: e.h - c.h }; }
    return best;
  });
}
const score = (q, sub) => match(extremes(q), sub).reduce((s, b) => s + (b ? (b.d / 10) ** 2 + (b.dh / 0.08) ** 2 : 1e4), 0);

function nelderMead(f, x0, steps, iters = 500) {
  const n = x0.length; let sim = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; sim.push(x); }
  let fv = sim.map(f);
  for (let it = 0; it < iters; it++) {
    const o = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]); sim = o.map((i) => sim[i]); fv = o.map((i) => fv[i]);
    const c = Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += sim[i][j] / n;
    const xr = c.map((v, j) => v + (v - sim[n][j])), fr = f(xr);
    if (fr < fv[0]) { const xe = c.map((v, j) => v + 2 * (v - sim[n][j])), fe = f(xe); if (fe < fr) { sim[n] = xe; fv[n] = fe; } else { sim[n] = xr; fv[n] = fr; } }
    else if (fr < fv[n - 1]) { sim[n] = xr; fv[n] = fr; }
    else { const xc = c.map((v, j) => v + 0.5 * (sim[n][j] - v)), fc = f(xc); if (fc < fv[n]) { sim[n] = xc; fv[n] = fc; } else { for (let i = 1; i <= n; i++) { sim[i] = sim[i].map((v, j) => sim[0][j] + 0.5 * (v - sim[0][j])); fv[i] = f(sim[i]); } } }
  }
  const b = fv.indexOf(Math.min(...fv)); return sim[b];
}
// q = [nivel base, factor lunar, desfase lunar (min), factor solar, desfase solar (min)]
const fit = (sub) => nelderMead((q) => score(q, sub), [3.5, 0.82, -5, 0.82, -5], [0.3, 0.05, 8, 0.05, 8]);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length), mx = (a) => Math.max(...a.map(Math.abs));
const report = (q, sub, label) => {
  const m = match(extremes(q), sub).filter(Boolean);
  console.log(label.padEnd(26), 'n=' + m.length, '| hora: típico', rms(m.map((b) => b.d)).toFixed(1), 'min, máx', mx(m.map((b) => b.d)).toFixed(0), '| altura: típico', rms(m.map((b) => b.dh)).toFixed(3), 'm, máx', mx(m.map((b) => b.dh)).toFixed(2));
};

const all = fit(truth);
console.log('\nCALIB nuevo para mareas-calc.mjs:');
console.log(`export const CALIB = { off: ${all[0].toFixed(3)}, M: [${all[1].toFixed(3)}, ${all[2].toFixed(3)}], S: [${all[3].toFixed(3)}, ${all[4].toFixed(3)}] };\n`);
report(all, truth, 'ajuste con todos los días');
// validación cruzada: bloques de 2 días alternados
const dayNo = (d) => Math.floor(Date.parse(d + 'T12:00:00Z') / 86400000);
const A = truth.filter((c) => Math.floor(dayNo(c.day) / 2) % 2 === 0), B = truth.filter((c) => Math.floor(dayNo(c.day) / 2) % 2 === 1);
if (A.length > 8 && B.length > 8) { report(fit(A), B, 'calibra con A, prueba con B'); report(fit(B), A, 'calibra con B, prueba con A'); }

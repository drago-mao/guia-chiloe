// Genera netlify/functions/seed.mjs a partir de los lugares y mareas que vienen en public/index.html (V 1.6).
// Solo se usa una vez para sembrar los datos iniciales; después todo se edita desde el panel web.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const grab = (re, what) => { const m = html.match(re); if (!m) throw new Error('No encontré ' + what); return m[1]; };
const P = new Function('return ' + grab(/var P=(\[[\s\S]*?\n\]);/, 'P'))();
const TIDES = new Function('return ' + grab(/var TIDES=(\[[\s\S]*?\n\]);/, 'TIDES'))();
const TIDES_SRC = grab(/var TIDES_SRC='([^']*)'/, 'TIDES_SRC');
const places = P.map((r, i) => ({
  id: String(i), cat: r[0], sub: r[1], name: r[2], town: r[3], lat: r[4], lng: r[5],
  hours: r[6], tel: r[7], rating: r[8], count: r[9], desc: r[10], web: r[11], hs: r[12] || '', photo: 0
}));
const out = '// Datos iniciales de la guía (generado por tools/make-seed.mjs). No hace falta editarlo.\n' +
  'export const PLACES = ' + JSON.stringify(places, null, 1) + ';\n' +
  'export const TIDES = ' + JSON.stringify(TIDES) + ';\n' +
  'export const TIDES_SRC = ' + JSON.stringify(TIDES_SRC) + ';\n';
writeFileSync(new URL('../netlify/functions/seed.mjs', import.meta.url), out);
console.log('Lugares:', places.length, '· días de marea:', TIDES.length);

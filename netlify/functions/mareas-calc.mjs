// Mareas de Castro calculadas automáticamente (V 1.12).
// Así la tabla nunca "vence": se calcula para la fecha de hoy y los días siguientes, sin depender de ningún sitio externo.
//
// Cómo funciona:
//  1) Base: constantes armónicas de la estación Puerto Montt (la más cercana a Castro con datos abiertos), de TICON-4
//     (Hart-Davis, Dettmering y Seitz, 2025, SEANOE, https://doi.org/10.17882/109129, licencia CC BY 4.0),
//     tomadas de la base abierta @neaps/tide-database (MIT).
//  2) Corrección a Castro: el mismo cálculo con las amplitudes multiplicadas por ~0,80 y con un pequeño adelanto de hora
//     (distinto para la parte lunar y la solar), más un nivel base. Estos 5 números se calibraron con los 10 días de
//     mareas de Castro del modelo FES2022 (tidesatlas.com, consultado el 18-10-2026) que traía la guía.
//  3) Validación: contra esos mismos 10 días el error típico es ~7 min y ~6 cm (máximo 19 min y 14 cm). Calibrando con la
//     mitad de los días (intercalados) y probando con la otra mitad, el error típico fue 5–9 min y 5–7 cm.
//     Ver tools/calibrar-mareas.mjs para repetir la calibración si algún día hay datos más largos de Castro.
//
// Son predicciones astronómicas: no incluyen viento, presión atmosférica ni lluvias. No sirven para navegar.
import { createTidePredictor, constituents as LIB } from '@neaps/tide-predictor';

export const CALC_SRC = 'Cálculo automático con constantes de Puerto Montt (TICON-4, Hart-Davis et al. 2025, CC BY 4.0), calibrado para Castro con el modelo FES2022';

const TZ = 'America/Santiago';
// [nombre, amplitud (m), fase (°)] — estación TICON-4 Puerto Montt (684)
const PUERTO_MONTT = [
  ["M2", 1.8765, 158.443],
  ["N2", 0.45002, 133.674],
  ["S2", 0.78872, 181.13],
  ["K2", 0.24196, 176.786],
  ["2N2", 0.0597, 104.513],
  ["S1", 0.00626, 91.928],
  ["K1", 0.23035, 71.083],
  ["P1", 0.07285, 66.719],
  ["O1", 0.15538, 26.981],
  ["Q1", 0.02977, 3.678],
  ["M1", 0.00902, 317.055],
  ["M4", 0.01195, 199.235],
  ["MM", 0.00422, 158.71],
  ["MF", 0.01206, 159.903],
  ["SA", 0.02365, 70.386],
  ["SSA", 0.02452, 203.149],
  ["T2", 0.03284, 173.502],
  ["J1", 0.01114, 110.582],
  ["L2", 0.08636, 128.715],
  ["R2", 0.00867, 200.336],
  ["2Q1", 0.00286, 331.578],
  ["MSF", 0.00379, 187.275],
  ["MSQM", 0.00172, 58.961],
  ["EP2", 0.02471, 161.235],
  ["M3", 0.00502, 245.844],
  ["MU2", 0.08517, 175.459],
  ["MTM", 0.00435, 154.863],
  ["NU2", 0.09041, 127.776],
  ["LAMBDA2", 0.05156, 90.924],
  ["MN4", 0.00633, 160.693],
  ["MS4", 0.01106, 203.615],
  ["MKS2", 0.02128, 237.443],
  ["N4", 0.00125, 126.055],
  ["M6", 0.0042, 82.259],
  ["M8", 0.00022, 224.657],
  ["S4", 0.00042, 272.31],
  ["OO1", 0.00859, 164.982],
  ["S3", 0.00316, 317.213],
  ["MA2", 0.03225, 349.002],
  ["MB2", 0.01092, 202.956],
  ["T3", 0.00474, 117.674],
  ["R3", 0.00413, 340.267],
  ["RHO1", 0.00592, 1.937],
  ["SGM", 0.00505, 189.031],
  ["3L2", 0.03005, 319.522],
  ["3N2", 0.01568, 260.137],
  ["2SM2", 0.03766, 327.15],
  ["2MS6", 0.00535, 94.074],
  ["2MK5", 0.00032, 326.215],
  ["2MO5", 0.00007, 28.221]
];
// Grupos: S = parte solar; el resto sigue a la lunar (incluye diurnas, de largo plazo y sobremareas).
const SOLAR = ['S2', 'K2', 'T2', 'R2'];
// Calibración a Castro: nivel base (m) y, por grupo, [factor de amplitud, desfase en minutos (negativo = adelanta)]
export const CALIB = { off: 3.525, M: [0.804, -7.235], S: [0.806, -18.392] };

let predictor = null;
function getPredictor() {
  if (!predictor) {
    predictor = createTidePredictor(PUERTO_MONTT.map(([name, amp, phase]) => {
      const [a, tau] = SOLAR.indexOf(name) >= 0 ? CALIB.S : CALIB.M;
      return { name, amplitude: amp * a, phase: phase + LIB[name].speed * tau / 60 };
    }), { offset: CALIB.off });
  }
  return predictor;
}

let fmtDate = null, fmtTime = null;
function localDate(ms) {
  fmtDate = fmtDate || new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmtDate.format(ms);
}
function localTime(ms) {
  fmtTime = fmtTime || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return fmtTime.format(ms);
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Fecha de hoy en Chile (AAAA-MM-DD) para un instante dado.
export function chileDate(ms) { return localDate(ms); }

// Mareas de los días desde "from" (AAAA-MM-DD, fecha de Chile) hasta "to", en el formato de la guía:
// [['2026-10-27', [['02:30','H',5.1], ['08:41','L',1.2], ...]], ...]
export function computeTides(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new Error('Fechas de mareas no válidas');
  // Ventana con 1 día de margen por lado, para no perder mareas cerca de la medianoche (hora de Chile = UTC-3 o UTC-4).
  const start = new Date(addDays(from, -1) + 'T00:00:00Z'), end = new Date(addDays(to, 2) + 'T00:00:00Z');
  const ex = getPredictor().getExtremesPrediction({ start, end });
  const byDay = {};
  for (const e of ex) {
    const ms = e.time.getTime(), d = localDate(ms);
    if (d < from || d > to) continue;
    (byDay[d] = byDay[d] || []).push([localTime(ms), e.high ? 'H' : 'L', Math.round(e.level * 100) / 100]);
  }
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push([d, (byDay[d] || []).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]);
  return out;
}

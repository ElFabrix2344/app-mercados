// Íconos PNG de la app instalable, con el mismo dibujo que public/icon.svg (la rueda cian sobre negro).
// Sin dependencias: cada píxel se pinta según su distancia a las figuras (bordes suaves de 1 px) y el PNG se arma
// con el zlib de Node. Uso: npm run icons (reescribe public/icons/*.png).
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const DARK = [0x0a, 0x0a, 0x0a]; // --bg
const CYAN = [0x45, 0xc8, 0xe6]; // --accent

// Geometría de icon.svg (viewBox de 64, centro en 32,32): aro, cuatro rayos y cubo, con trazo de 4.
const RIM = 21;
const HUB = 6.5;
const STROKE = 4;
const SPOKES = [
  [32, 11, 32, 53],
  [11, 32, 53, 32],
  [17.2, 17.2, 46.8, 46.8],
  [46.8, 17.2, 17.2, 46.8],
];
const OUTER = RIM + STROKE / 2; // radio exterior de la rueda

// [archivo, lado en px, parte del ancho que ocupa la rueda, radio de las esquinas (parte del lado) o null si el
// fondo llena todo el cuadrado, con transparencia]
const ICONS = [
  // Pestañas y ventanas: igual que icon.svg (rueda al 72 %, esquinas redondeadas).
  ['icon-32.png', 32, 46 / 64, 12 / 64, true],
  ['icon-192.png', 192, 46 / 64, 12 / 64, true],
  ['icon-512.png', 512, 46 / 64, 12 / 64, true],
  // Android recorta este con la forma del sistema (círculo, gota…): fondo entero y la rueda dentro de la zona segura.
  ['maskable-512.png', 512, 0.6, null, false],
  // iPhone y iPad redondean las esquinas solos y rellenan de negro lo transparente: fondo entero, sin alfa.
  ['apple-touch-icon.png', 180, 0.64, null, false],
];

/** Cuánto de un píxel cubre una figura, según la distancia (en px) de su centro al borde: negativa = adentro. */
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));

function segmentDistance(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function roundedSquareDistance(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function render(size, wheel, corner, alpha) {
  const k = (wheel * size) / (2 * OUTER); // px por unidad del SVG
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((size * channels + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filtro PNG «None»
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Color premultiplicado por su opacidad; las capas van en el orden del SVG.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const paint = ([cr, cg, cb], c) => {
        r = cr * c + r * (1 - c);
        g = cg * c + g * (1 - c);
        b = cb * c + b * (1 - c);
        a = c + a * (1 - c);
      };
      paint(DARK, corner === null ? 1 : cover(roundedSquareDistance(px, py, size, corner * size)));
      const ux = (px - size / 2) / k + 32;
      const uy = (py - size / 2) / k + 32;
      const d = Math.hypot(ux - 32, uy - 32);
      if (d < OUTER + 2 / k) {
        const spoke = Math.min(...SPOKES.map((s) => segmentDistance(ux, uy, s)));
        paint(CYAN, cover((Math.min(Math.abs(d - RIM), spoke) - STROKE / 2) * k)); // aro y rayos
        paint(DARK, cover((d - HUB) * k)); // relleno del cubo (tapa el cruce de los rayos)
        paint(CYAN, cover((Math.abs(d - HUB) - STROKE / 2) * k)); // borde del cubo
      }
      for (const v of a > 0 ? [r / a, g / a, b / a] : [0, 0, 0]) raw[o++] = Math.round(v);
      if (alpha) raw[o++] = Math.round(a * 255);
    }
  }
  return png(size, raw, alpha);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, raw, alpha) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = alpha ? 6 : 2; // RGBA o RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [file, size, wheel, corner, alpha] of ICONS) {
  const data = render(size, wheel, corner, alpha);
  writeFileSync(new URL(file, dir), data);
  console.log(`${file}: ${size}×${size}, ${data.length} bytes`);
}

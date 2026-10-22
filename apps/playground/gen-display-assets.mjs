// Generates the playground's Display-view sample images so the repository ships no
// third-party media: ten procedural landscape scenes (image_1..10.webp, 1200×628).
// Deterministic (seeded palettes); re-run to regenerate:
//
//   node apps/playground/gen-display-assets.mjs
//
// Renders with the workspace's Playwright Chromium (canvas → WebP), so it needs
// `pnpm exec playwright install chromium` once. No other dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'public', 'display');
const W = 1200;
const H = 628;

/** Ten scenes: sky stops top→horizon, light source, haze (far ridge) → ridge (near) colors. */
const SCENES = [
  {
    name: 'dawn lake',
    sky: ['#2b2d5c', '#c3658a', '#f7b267'],
    sun: { x: 0.62, y: 0.92, r: 26, disc: '#ffe9c4', color: 'rgba(255,200,140,0.75)', glow: 0.45 },
    haze: '#e8a98f',
    ridge: '#2a1e3d',
    water: true,
    clouds: 0.6,
    cloud: [255, 214, 196],
  },
  {
    name: 'golden hour',
    sky: ['#3d5a80', '#e9a86b', '#f8d49b'],
    sun: { x: 0.8, y: 0.86, r: 22, disc: '#fff1cc', color: 'rgba(255,210,150,0.7)', glow: 0.5 },
    haze: '#f2c08a',
    ridge: '#3b2a24',
    trees: '#1e1612',
    clouds: 0.5,
    cloud: [255, 230, 200],
  },
  {
    name: 'blue hour',
    sky: ['#0b1a3a', '#26466f', '#8fb3d9'],
    sun: { x: 0.3, y: 0.4, r: 10, disc: '#f4f1e6', color: 'rgba(200,220,255,0.35)', glow: 0.25 },
    haze: '#7f9bc0',
    ridge: '#0e1626',
    water: true,
    stars: 0.4,
    clouds: 0.3,
    cloud: [170, 190, 220],
  },
  {
    name: 'night',
    sky: ['#02040f', '#0a1230', '#1c2b57'],
    sun: { x: 0.72, y: 0.3, r: 18, disc: '#f5f3e6', color: 'rgba(220,225,255,0.3)', glow: 0.3 },
    haze: '#34477a',
    ridge: '#0c1430',
    stars: 1,
    trees: '#070b18',
    clouds: 0.2,
    cloud: [60, 70, 110],
  },
  {
    name: 'misty morning',
    sky: ['#9fb3bd', '#c9d6da', '#e7eeef'],
    sun: { x: 0.5, y: 0.7, r: 0, disc: '#fff', color: 'rgba(255,255,255,0.5)', glow: 0.6 },
    haze: '#d5dfe2',
    ridge: '#39525a',
    fog: 0.8,
    trees: '#2c3f44',
    clouds: 0.4,
    cloud: [240, 244, 245],
  },
  {
    name: 'desert',
    sky: ['#4e7bb0', '#d7a569', '#f3d3a3'],
    sun: { x: 0.2, y: 0.35, r: 24, disc: '#fff6dc', color: 'rgba(255,235,190,0.6)', glow: 0.4 },
    haze: '#e6b784',
    ridge: '#5a2e1c',
    layers: 5,
    mesa: true,
    clouds: 0.25,
    cloud: [255, 240, 220],
  },
  {
    name: 'alpine',
    sky: ['#1f4e8c', '#6fa3d6', '#d9e8f5'],
    sun: { x: 0.15, y: 0.55, r: 16, disc: '#ffffff', color: 'rgba(255,255,255,0.45)', glow: 0.35 },
    haze: '#b8d0e8',
    ridge: '#2b3b55',
    trees: '#17241c',
    clouds: 0.6,
    cloud: [255, 255, 255],
  },
  {
    name: 'tropical sunset',
    sky: ['#3a1c5e', '#c84c7a', '#ff9a5c'],
    sun: { x: 0.55, y: 0.95, r: 34, disc: '#ffd27a', color: 'rgba(255,170,110,0.8)', glow: 0.5 },
    haze: '#ff9d80',
    ridge: '#24102e',
    water: true,
    clouds: 0.5,
    cloud: [255, 190, 170],
  },
  {
    name: 'forest fog',
    sky: ['#5c6f66', '#8ea39a', '#c8d5cd'],
    sun: { x: 0.5, y: 0.6, r: 0, disc: '#fff', color: 'rgba(255,255,255,0.35)', glow: 0.5 },
    haze: '#aebfb6',
    ridge: '#1f3127',
    fog: 0.6,
    trees: '#15221b',
    clouds: 0.3,
    cloud: [225, 232, 228],
  },
  {
    name: 'autumn',
    sky: ['#4a5c8a', '#d58f5e', '#f0c48a'],
    sun: { x: 0.68, y: 0.8, r: 20, disc: '#ffe8bf', color: 'rgba(255,200,140,0.65)', glow: 0.45 },
    haze: '#dca786',
    ridge: '#4a2a1f',
    trees: '#2e1a12',
    water: true,
    clouds: 0.4,
    cloud: [255, 225, 200],
  },
];

/** Runs inside Chromium: draws one scene on the page's canvas and returns encoded images. */
function renderScene({ P, seed, W, H }) {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  // --- seeded PRNG + value noise ---
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hash = (x, y) => perm[(perm[x & 255] + y) & 255] / 255;
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = fade(x - xi);
    const v = fade(y - yi);
    return lerp(
      lerp(hash(xi, yi), hash(xi + 1, yi), u),
      lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u),
      v,
    );
  };
  const fbm = (x, y, oct = 5, lac = 2, gain = 0.5) => {
    let sum = 0;
    let a = 1;
    let f = 1;
    let n = 0;
    for (let i = 0; i < oct; i++) {
      sum += a * noise(x * f, y * f);
      n += a;
      a *= gain;
      f *= lac;
    }
    return sum / n;
  };
  // --- color helpers ---
  const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const rgb = (c) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
  const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  const dark = (c, k) => c.map((v) => v * (1 - k));

  const horizon = H * (0.5 + (rnd() - 0.5) * 0.12);
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, P.sky[0]);
  sky.addColorStop(0.55, P.sky[1]);
  sky.addColorStop(1, P.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // stars
  if (P.stars) {
    const n = Math.floor(420 * P.stars);
    for (let i = 0; i < n; i++) {
      const x = rnd() * W;
      const y = rnd() * horizon * 0.95;
      const b = rnd();
      ctx.fillStyle = `rgba(255,255,255,${(0.25 + b * 0.75) * P.stars})`;
      ctx.fillRect(x, y, b > 0.92 ? 2 : 1, b > 0.92 ? 2 : 1);
    }
  }
  // clouds (soft fbm over the sky)
  if (P.clouds > 0) {
    const hs = Math.floor(horizon);
    const img = ctx.getImageData(0, 0, W, hs);
    const d = img.data;
    const ox = rnd() * 100;
    const oy = rnd() * 100;
    for (let y = 0; y < hs; y++) {
      for (let x = 0; x < W; x++) {
        const n = fbm(ox + x / 260, oy + y / 120, 5);
        const c = Math.max(0, n - 0.47) * 2.4 * P.clouds * (1 - (y / hs) * 0.5);
        if (c > 0) {
          const i = (y * W + x) * 4;
          d[i] = lerp(d[i], P.cloud[0], c);
          d[i + 1] = lerp(d[i + 1], P.cloud[1], c);
          d[i + 2] = lerp(d[i + 2], P.cloud[2], c);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  // light source + glow
  const sx = W * P.sun.x;
  const sy = horizon * P.sun.y;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * P.sun.glow);
  glow.addColorStop(0, P.sun.color);
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  if (P.sun.r > 0) {
    ctx.fillStyle = P.sun.disc;
    ctx.beginPath();
    ctx.arc(sx, sy, P.sun.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // ridges, far → near (atmospheric perspective: haze → ridge color)
  const layers = P.layers ?? 6;
  const haze = hex(P.haze);
  const ridge = hex(P.ridge);
  for (let L = 0; L < layers; L++) {
    const t = L / (layers - 1);
    const base = horizon + (H - horizon) * (0.1 + t * 0.55);
    const amp = H * 0.2 * (0.55 + t * 0.9);
    const freq = P.mesa ? 1.6 + t * 0.8 : 2.6 + t * 2.2; // cycles across the width
    const ox = rnd() * 1000;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) {
      const n = fbm(ox + (x / W) * freq, L * 7.3, 6, 2.0, 0.55);
      const peaks = (1 - Math.abs(n * 2 - 1)) ** 1.4; // ridged: sharp summits, soft valleys
      const rough = (fbm(ox + x / 70, L * 3.1 + 11, 3) - 0.5) * 0.12;
      let h = n * 0.3 + peaks * 0.7 + rough;
      if (P.mesa) h = n * 0.85 + rough * 0.5; // dunes: rolling, no summits
      const y = base - h * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    const col = mix(haze, ridge, t ** 0.8);
    const lg = ctx.createLinearGradient(0, base - amp, 0, H);
    lg.addColorStop(0, rgb(col));
    lg.addColorStop(1, rgb(dark(col, 0.4)));
    ctx.fillStyle = lg;
    ctx.fill();
  }
  // fog band around the horizon
  if (P.fog) {
    const fg = ctx.createLinearGradient(0, horizon - 60, 0, horizon + 140);
    fg.addColorStop(0, 'rgba(255,255,255,0)');
    fg.addColorStop(0.5, `rgba(235,240,240,${0.55 * P.fog})`);
    fg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(0, horizon - 60, W, 200);
  }
  // water with reflection streaks
  if (P.water) {
    const y0 = Math.floor(horizon + (H - horizon) * 0.62);
    const wg = ctx.createLinearGradient(0, y0, 0, H);
    wg.addColorStop(0, rgb(dark(hex(P.sky[2]), 0.25)));
    wg.addColorStop(1, rgb(dark(hex(P.sky[0]), 0.5)));
    ctx.fillStyle = wg;
    ctx.fillRect(0, y0, W, H - y0);
    const img = ctx.getImageData(0, y0, W, H - y0);
    const d = img.data;
    const oy = rnd() * 100;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < W; x++) {
        const k = 1 + (fbm(x / 28, oy + y / 2.5, 3) - 0.5) * 0.3;
        const i = (y * W + x) * 4;
        d[i] *= k;
        d[i + 1] *= k;
        d[i + 2] *= k;
      }
    }
    ctx.putImageData(img, 0, y0);
    // sun path on the water: broken horizontal streaks that widen and fade with distance
    ctx.fillStyle = P.sun.color;
    for (let yy = y0 + 2; yy < H; yy += 3) {
      const k = (yy - y0) / (H - y0);
      const wd = (24 + k * 120) * (0.4 + rnd() * 0.9);
      ctx.globalAlpha = 0.45 * (1 - k) * (0.5 + rnd() * 0.5);
      ctx.fillRect(sx - wd / 2 + (rnd() - 0.5) * 16, yy, wd, 2);
    }
    ctx.globalAlpha = 1;
  }
  // conifer silhouettes along the foreground
  if (P.trees) {
    ctx.fillStyle = P.trees;
    const n = 90 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) {
      const x = rnd() * W;
      const h = 50 + rnd() * 110;
      const yb = H + 6 - rnd() * 30;
      const w = h * (0.16 + rnd() * 0.08);
      ctx.beginPath();
      ctx.moveTo(x, yb - h);
      const steps = 9;
      for (let k = 1; k <= steps; k++) {
        const yy = yb - h + (h * k) / steps;
        const ww = w * (k / steps) * (0.75 + rnd() * 0.5);
        ctx.lineTo(x - ww, yy);
      }
      for (let k = steps; k >= 1; k--) {
        const yy = yb - h + (h * k) / steps;
        const ww = w * (k / steps) * (0.75 + rnd() * 0.5);
        ctx.lineTo(x + ww, yy);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  // vignette + grain
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  const all = ctx.getImageData(0, 0, W, H);
  const d = all.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (rnd() - 0.5) * 14;
    d[i] += g;
    d[i + 1] += g;
    d[i + 2] += g;
  }
  ctx.putImageData(all, 0, 0);
  return canvas.toDataURL('image/webp', 0.82);
}

// ---- main ----
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(`<canvas id="c" width="${W}" height="${H}"></canvas>`);
for (let i = 0; i < SCENES.length; i++) {
  const webp = await page.evaluate(renderScene, {
    P: SCENES[i],
    seed: 1000 + i * 7919,
    W,
    H,
  });
  const file = join(OUT, `image_${i + 1}.webp`);
  const bytes = Buffer.from(webp.split(',')[1], 'base64');
  writeFileSync(file, bytes);
  console.log(
    `${SCENES[i].name.padEnd(16)} → image_${i + 1}.webp (${(bytes.length / 1024).toFixed(0)} KB)`,
  );
}
await browser.close();

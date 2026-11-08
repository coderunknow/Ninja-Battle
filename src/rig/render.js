// Character renderer: bone-driven articulated figures with cel shading, outline
// pass, costume layers, procedural hair and cloth.
//
// Drawing contract
// ----------------
// Local space: +x = facing direction, +y = DOWN, origin = the point on the ground
// between the feet. The caller supplies world position, facing and rotation.
//
// No DOM dependencies: works on any Canvas2D context (browser or @napi-rs/canvas
// in the headless QA renderer).

import { clamp, clamp01, lerp, TAU, noise1, hash, smoothstep } from '../core/math.js';
const smoothstep01 = (t) => smoothstep(t);
import { solveSkeleton } from './skeleton.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const PALETTES = {
  naruto: {
    skin: '#f7cfa8', skinShade: '#dda277', skinLine: '#7d4526',
    hair: '#f5c542', hairLight: '#ffe89b', hairShade: '#d1971b',
    jacket: '#ff7d1a', jacketLight: '#ffa552', jacketShade: '#c9560a',
    jacketDark: '#20222e', jacketDarkLight: '#3a3f52',
    jacketSleeve: '#22242f', jacketSleeveShade: '#0e0f15', jacketSleeveFar: '#171923',
    pants: '#f0721a', pantsShade: '#b34a08',
    shin: '#1b1d28', sandal: '#26325a', sandalLight: '#465f9c',
    bandCloth: '#1a3a70', bandClothLight: '#2f5da8',
    plate: '#d6dfea', plateShade: '#7f8b9c',
    eye: '#2f8fd8', eyeLight: '#a8ddff',
    line: '#1d1410',
    aura: '255,180,70',
  },
  sasuke: {
    skin: '#f2ccae', skinShade: '#d09d78', skinLine: '#6f4029',
    hair: '#1b1d29', hairLight: '#3b4462', hairShade: '#070810',
    jacket: '#414d69', jacketLight: '#61719a', jacketShade: '#242c41',
    jacketDark: '#151926', jacketDarkLight: '#2c3346',
    jacketSleeve: '#3c4761', jacketSleeveShade: '#202739', jacketSleeveFar: '#2a3348',
    pants: '#242a3c', pantsShade: '#12151f',
    shin: '#171b26', sandal: '#101318', sandalLight: '#2b3344',
    bandCloth: '#16203a', bandClothLight: '#26354f',
    plate: '#cdd7e3', plateShade: '#76828f',
    eye: '#cf2f24', eyeLight: '#ff8a6a',
    line: '#08090e',
    aura: '150,200,255',
  },
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function normalsOf(pts) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x, dy = next.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    out.push({ x: -dy / l, y: dx / l });
  }
  return out;
}

// Smooth tapered limb silhouette with rounded caps.
function ribbonPath(ctx, pts, widths) {
  const n = pts.length;
  if (n < 2) return;
  const nm = normalsOf(pts);
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const w = widths[i] * 0.5;
    L.push({ x: pts[i].x + nm[i].x * w, y: pts[i].y + nm[i].y * w });
    R.push({ x: pts[i].x - nm[i].x * w, y: pts[i].y - nm[i].y * w });
  }
  const cap = (p, nrm, w, start) => {
    const a = Math.atan2(nrm.y, nrm.x);
    ctx.arc(p.x, p.y, w * 0.5, start ? a + Math.PI / 2 : a - Math.PI / 2, start ? a - Math.PI / 2 : a + Math.PI / 2, start ? true : true);
  };
  ctx.beginPath();
  ctx.moveTo(L[0].x, L[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i].x, L[i].y);
  const aE = Math.atan2(nm[n - 1].y, nm[n - 1].x);
  ctx.arc(pts[n - 1].x, pts[n - 1].y, widths[n - 1] * 0.5, aE, aE - Math.PI, true);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i].x, R[i].y);
  const aS = Math.atan2(nm[0].y, nm[0].x);
  ctx.arc(pts[0].x, pts[0].y, widths[0] * 0.5, aS + Math.PI, aS, true);
  ctx.closePath();
}

// Filled + outlined limb. Outline is what sells the "inked anime" look and
// guarantees silhouettes read against busy backgrounds.
function limb(ctx, pts, widths, fill, outline, lw, shadeColor) {
  ribbonPath(ctx, pts, widths);
  ctx.fillStyle = fill;
  ctx.fill();
  if (shadeColor) {
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.34;
    const nm = normalsOf(pts);
    ctx.beginPath();
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i], o = nm[i], w = widths[i];
      const sx = p.x + o.x * w * 0.18, sy = p.y + o.y * w * 0.18;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i], o = nm[i], w = widths[i];
      ctx.lineTo(p.x + o.x * w * 1.5, p.y + o.y * w * 1.5);
    }
    ctx.closePath();
    ctx.fillStyle = shadeColor;
    ctx.fill();
    ctx.restore();
  }
  if (outline) {
    ribbonPath(ctx, pts, widths);
    ctx.strokeStyle = outline;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function smoothPoly(pts, subdiv = 5) {
  if (pts.length < 3) return pts.slice();
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < subdiv; s++) {
      const t = s / subdiv, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Thin strand (hair spike, band tail): quadratic taper.
function spikeShape(ctx, bx, by, len, ang, w, curl = 0) {
  const tipx = bx + Math.cos(ang) * len;
  const tipy = by + Math.sin(ang) * len;
  const mx = (bx + tipx) / 2 - Math.sin(ang) * curl * len * 0.5;
  const my = (by + tipy) / 2 + Math.cos(ang) * curl * len * 0.5;
  ctx.beginPath();
  ctx.moveTo(bx - Math.sin(ang) * w, by + Math.cos(ang) * w);
  ctx.quadraticCurveTo(mx - Math.sin(ang) * w * 1.25, my + Math.cos(ang) * w * 1.25, tipx, tipy);
  ctx.quadraticCurveTo(mx + Math.sin(ang) * w * 0.5, my - Math.cos(ang) * w * 0.5, bx + Math.sin(ang) * w, by - Math.cos(ang) * w);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------
function drawHairBack(ctx, kind, pal, st, R) {
  const t = st.time;
  const fl = (k) => (noise1(t * 1.8 + k * 3.3, kind === 'naruto' ? 3 : 7) * (0.7 + st.flow * 2.2) + Math.sin(t * 6.2 + k) * 0.25) * 0.1;

  ctx.save();
  ctx.fillStyle = pal.hair;
  ctx.strokeStyle = pal.hairShade;
  ctx.lineWidth = R * 0.06;

  if (kind === 'naruto') {
    // messy blonde crown radiating up and back
    const spikes = [
      [-0.95, 0.05, 0.62, 2.85, 0.16, 0.2],
      [-0.99, -0.28, 0.82, 3.05, 0.18, 0.25],
      [-0.72, -0.62, 0.95, 3.40, 0.19, 0.3],
      [-0.36, -0.88, 1.02, 3.75, 0.2, 0.32],
      [0.0, -0.98, 0.98, 4.20, 0.2, 0.3],
      [0.36, -0.94, 0.9, 4.72, 0.19, 0.28],
      [0.66, -0.76, 0.8, 5.15, 0.17, 0.24],
      [0.86, -0.5, 0.66, 5.5, 0.15, 0.2],
      [0.95, -0.16, 0.5, 5.8, 0.13, 0.15],
    ];
    spikes.forEach(([x, y, l, a, w, c], i) => {
      spikeShape(ctx, x * R, y * R, l * R, a + fl(i), w * R, c);
      ctx.fill();
      ctx.stroke();
    });
    // skull mass
    ctx.beginPath();
    ctx.ellipse(-R * 0.04, -R * 0.42, R * 1.0, R * 0.78, 0, Math.PI * 0.94, Math.PI * 2.16);
    ctx.fill();
    // sheen
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = pal.hairLight;
    ctx.beginPath();
    ctx.ellipse(R * 0.16, -R * 0.78, R * 0.42, R * 0.16, -0.42, 0, TAU);
    ctx.fill();
  } else {
    // Sasuke: sharp crown + long duck-tail at the back
    const rear = [
      [-1.02, -0.5, 1.05, 3.55, 0.22, 0.35],
      [-1.16, -0.12, 0.98, 3.32, 0.2, 0.28],
      [-1.12, 0.3, 0.8, 3.1, 0.18, 0.2],
      [-0.86, -0.8, 0.95, 3.8, 0.2, 0.4],
      [-1.02, 0.62, 0.6, 2.95, 0.15, 0.12],
    ];
    rear.forEach(([x, y, l, a, w, c], i) => {
      spikeShape(ctx, x * R, y * R, l * R, a + fl(i), w * R, c);
      ctx.fill(); ctx.stroke();
    });
    const top = [
      [-0.6, -0.78, 0.85, 3.85, 0.19, 0.32],
      [-0.22, -0.95, 0.92, 4.2, 0.2, 0.28],
      [0.16, -0.96, 0.86, 4.55, 0.2, 0.24],
      [0.52, -0.84, 0.76, 4.95, 0.18, 0.2],
      [0.8, -0.62, 0.62, 5.3, 0.15, 0.16],
    ];
    top.forEach(([x, y, l, a, w, c], i) => {
      spikeShape(ctx, x * R, y * R, l * R, a + fl(i + 5), w * R, c);
      ctx.fill(); ctx.stroke();
    });
    ctx.beginPath();
    ctx.ellipse(-R * 0.03, -R * 0.4, R * 1.02, R * 0.8, 0, Math.PI * 0.94, Math.PI * 2.14);
    ctx.fill();
    // blue sheen
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = pal.hairLight;
    ctx.lineWidth = R * 0.09;
    ctx.beginPath();
    ctx.arc(R * 0.04, -R * 0.44, R * 0.66, Math.PI * 1.16, Math.PI * 1.6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHairFront(ctx, kind, pal, st, R) {
  const t = st.time;
  ctx.save();
  ctx.fillStyle = pal.hair;
  ctx.strokeStyle = pal.hairShade;
  ctx.lineWidth = R * 0.05;
  const n = kind === 'naruto' ? 6 : 5;
  for (let i = 0; i < n; i++) {
    const x = (-0.62 + i * (1.24 / (n - 1))) * R;
    const w = noise1(t * 2.1 + i * 1.3, 11) * (0.4 + st.flow * 1.6);
    // Bang length controls how much of the face survives. Sasuke's used to hang
    // 0.62-0.95R from the forehead, which is past the eye line (eyes sit ~0.6R
    // below the hair root), so both eyes were completely buried at every camera
    // distance and his face read as a blank oval. A fringe that stops at the
    // brow keeps the spiky silhouette while leaving the eyes legible.
    const len = kind === 'naruto' ? R * (0.34 + (i % 2) * 0.14) : R * (i === 1 ? 0.40 : 0.30);
    const ang = Math.PI * 0.5 + i * 0.13 + w * 0.08;
    spikeShape(ctx, x, -R * 0.62, len, ang, R * 0.15, -0.5);
    ctx.fill();
  }
  if (kind === 'sasuke') {
    // The single asymmetric bang that defines his silhouette. It crosses the
    // *rear* eye only (offset toward the back of the head) and stops above the
    // mouth: enough to read as Sasuke, without turning his face into hair.
    const back = st.facing > 0 ? -1 : 1;
    spikeShape(ctx, back * R * 0.16, -R * 0.72, R * 0.34, Math.PI * 0.5 + back * 0.10, R * 0.12, -0.55 * back);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------
// Neck is drawn as its own layer BEHIND the torso and head. Previously it was
// stroked inside drawHead, on top of the torso, which made it look like a tube
// glued over the face.
function drawNeck(ctx, rig, j, pal, style) {
  const a = j.neck, b = j.head;
  const w = rig.headR * 0.46;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  // extend slightly into the skull so no gap shows when the head turns
  const x0 = a.x - ux * 4, y0 = a.y - uy * 4;
  const x1 = a.x + ux * (L + 3), y1 = a.y + uy * (L + 3);
  const nx = -uy, ny = ux;
  ctx.beginPath();
  ctx.moveTo(x0 + nx * w, y0 + ny * w);
  ctx.lineTo(x1 + nx * w * 0.86, y1 + ny * w * 0.86);
  ctx.quadraticCurveTo(x1, y1, x1 - nx * w * 0.86, y1 - ny * w * 0.86);
  ctx.lineTo(x0 - nx * w, y0 - ny * w);
  ctx.closePath();
  ctx.fillStyle = pal.skinShade;
  ctx.fill();
  // shadow where the jaw sits on the neck
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = pal.skinLine;
  const g = ctx.createLinearGradient(x1, y1, x0, y0);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(Math.min(x0, x1) - 30, Math.min(y0, y1) - 30, Math.abs(x1 - x0) + 60, Math.abs(y1 - y0) + 60);
  ctx.restore();
}

function drawHead(ctx, rig, pose, j, pal, style, st) {
  const R = rig.headR;
  ctx.save();
  ctx.translate(j.head.x, j.head.y);
  ctx.rotate(j.headAng);

  drawHairBack(ctx, style, pal, st, R);

  // skull silhouette
  // Skull: a rounded cranium tapering to a small chin. Both fighters share this
  // base shape; hair and the headband do the character-specific work.
  const skull = () => {
    ctx.beginPath();
    ctx.moveTo(R * 0.30, R * 0.52);                                  // jaw front
    ctx.bezierCurveTo(R * 0.62, R * 0.40, R * 0.84, R * 0.10, R * 0.84, -R * 0.22);
    ctx.bezierCurveTo(R * 0.86, -R * 0.78, R * 0.46, -R * 1.06, -R * 0.02, -R * 1.06);
    ctx.bezierCurveTo(-R * 0.54, -R * 1.06, -R * 0.90, -R * 0.74, -R * 0.88, -R * 0.20);
    ctx.bezierCurveTo(-R * 0.86, R * 0.22, -R * 0.58, R * 0.40, -R * 0.30, R * 0.54);
    ctx.bezierCurveTo(-R * 0.10, R * 0.64, R * 0.12, R * 0.62, R * 0.30, R * 0.52);
    ctx.closePath();
  };
  skull();
  ctx.fillStyle = pal.skin;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = pal.skinShade;
  ctx.beginPath();
  ctx.ellipse(-R * 0.62, R * 0.12, R * 0.42, R * 0.86, 0.12, 0, TAU);
  ctx.fill();
  // cheek warmth
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#e2745c';
  ctx.beginPath();
  ctx.ellipse(R * 0.5, R * 0.16, R * 0.26, R * 0.16, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Ear. It sits at the back of the skull, not on the cheek: at -0.14R it was
  // drawn across the middle of the face and read as a pink blob (very visible on
  // Sasuke's pale skin). The skull's rear edge is around -0.88R.
  ctx.beginPath();
  ctx.ellipse(-R * 0.62, R * 0.02, R * 0.14, R * 0.22, 0.18, 0, TAU);
  ctx.fillStyle = pal.skinShade;
  ctx.fill();
  ctx.strokeStyle = pal.skinLine;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = R * 0.045;
  ctx.stroke();
  ctx.globalAlpha = 1;

  drawBand(ctx, R, pal, st);

  drawFace(ctx, R, pal, style, st);

  // Rear-eye bang: a hair-shaped occluder sitting over the back eye only. Drawn
  // between the face and the fringe so it reads as hair in front of the eye,
  // with the fringe layering over its root.
  if (style === 'sasuke') {
    ctx.save();
    ctx.fillStyle = pal.hair;
    const back = st.facing > 0 ? -1 : 1;
    spikeShape(ctx, back * R * 0.30, -R * 0.66, R * 0.60, Math.PI * 0.52 + back * 0.05, R * 0.20, -0.45 * back);
    ctx.fill();
    ctx.restore();
  }

  drawHairFront(ctx, style, pal, st, R);

  // head outline (kept subtle so the face stays soft)
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = pal.skinLine;
  ctx.lineWidth = R * 0.055;
  skull();
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

function drawBand(ctx, R, pal, st) {
  // sits on the forehead, above the brow line
  const bandY = -R * 0.60;
  const t = st.time;
  // cloth tails behind the head
  for (let k = 0; k < 2; k++) {
    const wav = noise1(t * 2.4 + k * 2.2, 21) * (2.0 + st.flow * 10);
    const pts = [
      { x: -R * 0.8, y: bandY + R * 0.12 },
      { x: -R * 1.28, y: bandY + R * 0.34 + wav * 0.28 },
      { x: -R * 1.62 - st.flow * 2, y: bandY + R * 0.82 + wav * 0.7 + k * R * 0.26 },
      { x: -R * 1.8 - st.flow * 5, y: bandY + R * 1.34 + wav * 1.2 + k * R * 0.4 },
    ];
    const sp = smoothPoly(pts, 4);
    ctx.beginPath();
    ctx.moveTo(sp[0].x, sp[0].y - R * 0.13);
    for (const p of sp) ctx.lineTo(p.x, p.y - R * 0.1);
    for (let i = sp.length - 1; i >= 0; i--) ctx.lineTo(sp[i].x, sp[i].y + R * 0.1);
    for (const p of sp) ctx.lineTo(p.x, p.y + R * 0.13);
    ctx.closePath();
    ctx.fillStyle = k === 0 ? pal.bandCloth : pal.bandClothLight;
    ctx.fill();
  }

  // headband over the forehead
  ctx.save();
  ctx.fillStyle = pal.bandCloth;
  ctx.beginPath();
  ctx.moveTo(-R * 0.98, bandY - R * 0.1);
  ctx.quadraticCurveTo(-R * 0.1, bandY - R * 0.4, R * 0.9, bandY - R * 0.16);
  ctx.lineTo(R * 0.9, bandY + R * 0.28);
  ctx.quadraticCurveTo(-R * 0.1, bandY + R * 0.04, -R * 0.98, bandY + R * 0.26);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = pal.bandClothLight;
  ctx.lineWidth = R * 0.04;
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Steel plate. It has to read as a forehead protector, not a visor: it covers
  // the front half of the band, is tall enough to sit inside the cloth, and its
  // outer edge stops inside the skull silhouette (0.84R was past the temple, so
  // the plate appeared to float off the side of the head).
  // The plate's vertical span must stay *inside* the cloth band, or it pokes up
  // through the hair line and reads as a grey bar floating on the forehead.
  // The cloth spans bandY-0.10 .. bandY+0.26 here (its top curves up further
  // toward the centre), so the plate sits at -0.06 .. +0.24.
  const px0 = R * 0.12, px1 = R * 0.70;
  ctx.beginPath();
  ctx.moveTo(px0, bandY - R * 0.06);
  ctx.lineTo(px1, bandY - R * 0.10);
  ctx.lineTo(px1, bandY + R * 0.24);
  ctx.lineTo(px0, bandY + R * 0.20);
  ctx.closePath();
  const g = ctx.createLinearGradient(px0, bandY, px1, bandY + R * 0.2);
  g.addColorStop(0, pal.plateShade);
  g.addColorStop(0.4, pal.plate);
  g.addColorStop(1, pal.plateShade);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,44,52,0.6)';
  ctx.lineWidth = R * 0.05;
  ctx.stroke();

  // konoha leaf spiral
  ctx.strokeStyle = '#4a5260';
  ctx.lineWidth = R * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(R * 0.45, bandY + R * 0.06, R * 0.10, 0.7, 4.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(R * 0.34, bandY - R * 0.15);
  ctx.lineTo(R * 0.58, bandY - R * 0.03);
  ctx.stroke();

  if (st.scratched) {
    // Sasuke's slashed plate
    ctx.strokeStyle = '#7d8796';
    ctx.lineWidth = R * 0.08;
    ctx.beginPath();
    ctx.moveTo(px0 + R * 0.04, bandY - R * 0.08);
    ctx.lineTo(px1 - R * 0.03, bandY + R * 0.22);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFace(ctx, R, pal, style, st) {
  // Which eye is covered by hair. Sasuke's asymmetric bang crosses the eye on
  // the back of his head; drawing it *over* the eye is the whole point of the
  // look, but drawing it over the *front* eye would hide the eye the viewer is
  // meant to read. The face is drawn, then the occluder, then the fringe on top.

  const blink = clamp01(st.blink);
  const angry = clamp01(st.angry);
  const eyeOpen = clamp01((1 - blink) * (0.55 + 0.45 * clamp01(st.alert)));

  const drawEye = (ex, sx) => {
    ctx.save();
    ctx.translate(ex, -R * 0.02);
    ctx.scale(sx, 1);
    // white
    ctx.beginPath();
    ctx.moveTo(-R * 0.19, 0);
    ctx.quadraticCurveTo(0, -R * 0.28 * eyeOpen, R * 0.19, R * 0.005);
    ctx.quadraticCurveTo(0, R * 0.12 * (1 - angry * 0.3), -R * 0.19, 0);
    ctx.closePath();
    ctx.fillStyle = '#fdfaf6';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const ir = R * 0.135;
    ctx.beginPath();
    ctx.arc(R * 0.015, -R * 0.015 * eyeOpen, ir, 0, TAU);
    if (style === 'sasuke') {
      const g = ctx.createRadialGradient(R * 0.015, -R * 0.015, 0, R * 0.015, -R * 0.015, ir);
      g.addColorStop(0, '#ff7a58');
      g.addColorStop(1, pal.eye);
      ctx.fillStyle = g;
    } else {
      const g = ctx.createRadialGradient(R * 0.015, -R * 0.03, 0, R * 0.015, 0, ir);
      g.addColorStop(0, pal.eyeLight);
      g.addColorStop(1, pal.eye);
      ctx.fillStyle = g;
    }
    ctx.fill();
    if (style === 'sasuke' && st.sharingan > 0.1) {
      ctx.globalAlpha = clamp01(st.sharingan);
      ctx.fillStyle = '#340606';
      ctx.beginPath();
      ctx.arc(R * 0.015, -R * 0.015, ir * 0.3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#340606';
      ctx.lineWidth = R * 0.03;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + st.time * 0.5;
        ctx.beginPath();
        ctx.arc(R * 0.015 + Math.cos(a) * ir * 0.6, -R * 0.015 + Math.sin(a) * ir * 0.6, ir * 0.17, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(R * 0.015, -R * 0.015, ir * 0.72, a + 0.5, a + 1.35);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#111318';
      ctx.beginPath();
      ctx.arc(R * 0.015, -R * 0.015, ir * 0.44, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(R * 0.07, -R * 0.085, ir * 0.26, 0, TAU);
    ctx.fill();
    ctx.restore();
    // upper lid
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = R * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-R * 0.2, R * 0.005);
    ctx.quadraticCurveTo(0, -R * 0.3 * eyeOpen, R * 0.2, R * 0.01 + angry * R * 0.03);
    ctx.stroke();
    if (angry > 0.04) {
      ctx.strokeStyle = style === 'sasuke' ? '#0e1016' : '#c39244';
      ctx.lineWidth = R * 0.085;
      ctx.beginPath();
      ctx.moveTo(-R * 0.21, -R * (0.16 + angry * 0.08));
      ctx.lineTo(R * 0.2, -R * (0.3 + angry * 0.04));
      ctx.stroke();
    }
    ctx.restore();
  };

  // Three-quarter view: the near eye sits forward, the far eye sits back and
  // smaller. They used to be at 0.38R and 0.0R, and since each eye spans +-0.19R
  // they overlapped into a single smeared shape — which is why the faces read as
  // one eye plus a blur at any distance. Separated and pushed apart.
  const fdir = st.facing > 0 ? 1 : -1;
  drawEye(fdir * R * 0.45, 1);
  drawEye(fdir * R * 0.10, 0.52);

  // nose
  ctx.strokeStyle = pal.skinLine;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = R * 0.045;
  ctx.beginPath();
  ctx.moveTo(fdir * R * 0.46, R * 0.02);
  ctx.lineTo(fdir * R * 0.54, R * 0.17);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // mouth
  const mo = clamp01(st.scream);
  ctx.save();
  ctx.translate(fdir * R * 0.3, R * 0.36);
  if (mo > 0.1) {
    ctx.beginPath();
    ctx.ellipse(0, mo * R * 0.08, R * (0.1 + mo * 0.05), R * (0.045 + mo * 0.16), 0, 0, TAU);
    ctx.fillStyle = '#5a2028';
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = R * 0.04;
    ctx.stroke();
  } else {
    ctx.strokeStyle = pal.line;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = R * 0.05;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-R * 0.1, 0);
    ctx.quadraticCurveTo(0, R * 0.07, R * 0.11, -R * 0.015);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // whisker marks
  if (style === 'naruto') {
    ctx.strokeStyle = 'rgba(140,66,34,0.8)';
    ctx.lineWidth = R * 0.032;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const y = R * (0.14 + i * 0.12);
      ctx.beginPath();
      ctx.moveTo(fdir * R * 0.36, y);
      ctx.lineTo(fdir * R * 0.66, y + R * (i - 1) * 0.02);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Torso & costume
// ---------------------------------------------------------------------------
function drawTorso(ctx, rig, pose, j, pal, style, st) {
  // The torso is built as an explicit silhouette (hips -> waist -> chest ->
  // shoulders) rather than a tube, so the character has a real body shape.
  const hx = j.hip.x, hy = j.hip.y;
  const nx = j.neck.x, ny = j.neck.y;
  const ax = nx - hx, ay = ny - hy;
  const L = Math.hypot(ax, ay) || 1;
  const ux = ax / L, uy = ay / L;      // along spine
  const px = -uy, py = ux;             // perpendicular

  // width at t along the spine (t=0 hips, t=1 neck)
  // Width profile along the spine: narrow waist, broad chest, then a shoulder
  // slope that tucks in sharply toward the neck. The chest peak sits at t=0.84
  // so the widest point is at the deltoids rather than mid-ribs.
  const prof = (t) => {
    const waist = rig.hipWidth * 1.30;
    const chest = rig.shoulderWidth * 1.16;
    const hipPeak = rig.hipWidth * 1.46;
    let w;
    if (t < 0.30) {
      w = lerp(hipPeak, waist, smoothstep01(t / 0.30));
    } else if (t < 0.84) {
      w = lerp(waist, chest, smoothstep01((t - 0.30) / 0.54));
    } else {
      w = lerp(chest, rig.shoulderWidth * 0.62, smoothstep01((t - 0.84) / 0.16));
    }
    return w;
  };
  const P = (t, side) => {
    const cx = hx + ux * L * t, cy = hy + uy * L * t;
    const w = prof(t) * 0.5 * side;
    return { x: cx + px * w, y: cy + py * w };
  };

  const torsoPath = () => {
    const N = 12;
    ctx.beginPath();
    // one side up
    const left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      left.push(P(t, 1));
      right.push(P(t, -1));
    }
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) {
      const a = left[i - 1], b = left[i];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.lineTo(left[N].x, left[N].y);
    // shoulder cap
    ctx.quadraticCurveTo(nx + ux * 3, ny + uy * 3, right[N].x, right[N].y);
    for (let i = N; i > 0; i--) {
      const a = right[i], b = right[i - 1];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.lineTo(right[0].x, right[0].y);
    ctx.quadraticCurveTo(hx, hy + 6, left[0].x, left[0].y);
    ctx.closePath();
  };

  torsoPath();
  ctx.fillStyle = pal.jacket;
  ctx.fill();

  // shading down the far side
  ctx.save();
  torsoPath();
  ctx.clip();
  ctx.globalAlpha = 0.42;
  const g = ctx.createLinearGradient(hx - px * 20, hy - py * 20, hx + px * 20, hy + py * 20);
  g.addColorStop(0, pal.jacketShade);
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(hx - 90, hy - 140, 180, 240);
  ctx.globalAlpha = 1;

  // costume details in torso-local space (x = along spine, y = across)
  ctx.translate(hx, hy);
  ctx.rotate(Math.atan2(uy, ux));
  // in this frame: +x runs hip->neck, +y runs to the character's back
  const bw = rig.shoulderWidth;
  const TL = L;

  if (style === 'naruto') {
    // black shoulder yoke
    ctx.fillStyle = pal.jacketDark;
    ctx.beginPath();
    ctx.moveTo(TL * 0.52, -bw * 0.75);
    ctx.lineTo(TL * 1.02, -bw * 0.62);
    ctx.quadraticCurveTo(TL * 1.08, 0, TL * 1.02, bw * 0.62);
    ctx.lineTo(TL * 0.52, bw * 0.75);
    ctx.quadraticCurveTo(TL * 0.46, 0, TL * 0.52, -bw * 0.75);
    ctx.closePath();
    ctx.fill();
    // orange collar band
    ctx.strokeStyle = pal.jacketLight;
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(TL * 0.5, -bw * 0.78);
    ctx.quadraticCurveTo(TL * 0.44, 0, TL * 0.5, bw * 0.78);
    ctx.stroke();
    // zip
    ctx.strokeStyle = pal.jacketDarkLight;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(TL * 0.5, 0);
    ctx.lineTo(TL * 0.02, 0);
    ctx.stroke();
    // folds
    ctx.strokeStyle = pal.jacketShade;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.2;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(TL * 0.55, sgn * bw * 0.42);
      ctx.quadraticCurveTo(TL * 0.3, sgn * bw * 0.5, TL * 0.08, sgn * bw * 0.38);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    // open jacket: pale inner shirt, dark lapels, purple rope belt
    ctx.fillStyle = '#cdd7e7';
    ctx.beginPath();
    ctx.moveTo(TL * 0.98, -bw * 0.16);
    ctx.lineTo(TL * 0.12, bw * 0.3);
    ctx.lineTo(TL * 0.06, -bw * 0.02);
    ctx.lineTo(TL * 0.94, -bw * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pal.jacketDark;
    ctx.beginPath();
    ctx.moveTo(TL * 1.04, -bw * 0.66);
    ctx.lineTo(TL * 0.9, -bw * 0.1);
    ctx.lineTo(TL * 0.1, bw * 0.44);
    ctx.lineTo(TL * -0.05, bw * 0.5);
    ctx.lineTo(TL * 0.05, -bw * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(TL * 1.04, bw * 0.62);
    ctx.lineTo(TL * 0.98, bw * 0.2);
    ctx.lineTo(TL * 0.2, bw * 0.2);
    ctx.lineTo(TL * 0.05, bw * 0.9);
    ctx.lineTo(TL * 1.02, bw * 0.72);
    ctx.closePath();
    ctx.fill();
    // rope belt
    ctx.strokeStyle = '#6d4796';
    ctx.lineWidth = 5.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(TL * 0.18, -bw * 0.7);
    ctx.quadraticCurveTo(TL * 0.06, 0, TL * 0.18, bw * 0.72);
    ctx.stroke();
    ctx.strokeStyle = '#a279d0';
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(TL * 0.2, -bw * 0.7);
    ctx.quadraticCurveTo(TL * 0.08, 0, TL * 0.2, bw * 0.72);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // outline
  ctx.save();
  torsoPath();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawCollar(ctx, rig, j, pal, style, st) {
  const S = rig.scale;
  ctx.save();
  ctx.translate(j.neck.x, j.neck.y);
  ctx.rotate(j.torsoAngle + Math.PI / 2);
  if (style === 'sasuke') {
    // tall open collar framing the jaw
    const cw = rig.shoulderWidth * 0.44;
    ctx.beginPath();
    ctx.moveTo(-cw * 1.05, 10);
    ctx.quadraticCurveTo(-cw * 1.0, -14, -cw * 0.1, -17);
    ctx.lineTo(cw * 0.5, -15);
    ctx.quadraticCurveTo(cw * 0.8, 0, cw * 0.62, 8);
    ctx.quadraticCurveTo(0, 0, -cw * 1.05, 10);
    ctx.closePath();
    ctx.fillStyle = pal.jacketDark;
    ctx.fill();
    ctx.strokeStyle = pal.jacketDarkLight;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    const sway = noise1(st.time * 2.0, 33) * (1 + st.flow * 5);
    ctx.strokeStyle = '#8a5cbb';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cw * 0.3, 2);
    ctx.quadraticCurveTo(cw * 0.55 + sway, 16, cw * 0.3 + sway * 1.5, 30);
    ctx.moveTo(cw * 0.05, 4);
    ctx.quadraticCurveTo(cw * 0.25 + sway * 0.5, 18, cw * 0.02 + sway, 32);
    ctx.stroke();
  } else {
    // High orange collar. Sits low on the neck so the jaw and chin stay clear;
    // the front edge is cut away where the chin overlaps it.
    const cw = rig.shoulderWidth * 0.265;
    ctx.beginPath();
    ctx.moveTo(-cw, 5.0);
    ctx.quadraticCurveTo(-cw * 0.9, -2.4, -cw * 0.44, -4.0);
    ctx.lineTo(cw * 0.48, -4.0);
    ctx.quadraticCurveTo(cw * 0.92, -2.2, cw * 0.94, 5.0);
    ctx.quadraticCurveTo(0, 9.0, -cw, 5.0);
    ctx.closePath();
    ctx.fillStyle = pal.jacketLight;
    ctx.fill();
    ctx.strokeStyle = pal.jacketShade;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    // inner shadow of the collar opening
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.ellipse(0, -3.4, cw * 0.44, 2.0, 0, 0, TAU);
    ctx.fillStyle = pal.jacketShade;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawJacketHem(ctx, rig, j, pal, st) {
  const flow = st.flow;
  ctx.save();
  ctx.translate(j.hip.x, j.hip.y);
  ctx.rotate(j.torsoAngle + Math.PI / 2);

  // Flaps: broad and short, flaring backwards with speed. Drawn before the
  // waistband so the band caps them cleanly.
  for (const dir of [-1, 1]) {
    const wav = noise1(st.time * 2.6 + dir, 41) * (1.2 + flow * 6);
    const drop = (dir > 0 ? 19 : 23) * (1 - flow * 0.15);
    const halfW = rig.hipWidth * (dir > 0 ? 0.62 : 0.7);
    ctx.beginPath();
    ctx.moveTo(dir * rig.hipWidth * 0.30, -4);
    ctx.quadraticCurveTo(
      dir * (halfW + 3.0) - flow * 5, drop * 0.45 + wav * 0.3,
      dir * (halfW + 1.0) - flow * 11, drop + wav
    );
    ctx.quadraticCurveTo(
      dir * halfW * 0.35 - flow * 7, drop * 0.72 + wav * 0.5,
      dir * rig.hipWidth * 0.02, drop * 0.20
    );
    ctx.closePath();
    ctx.fillStyle = dir > 0 ? pal.jacket : pal.jacketShade;
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.globalAlpha = 0.40;
    ctx.lineWidth = 1.0;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Waistband caps the top of both flaps so they read as one garment.
  ctx.beginPath();
  ctx.roundRect(-rig.hipWidth * 0.92, -7.5, rig.hipWidth * 1.84, 7.0, 3.0);
  ctx.fillStyle = pal.jacketShade;
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.0;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Limbs
// ---------------------------------------------------------------------------
function drawFist(ctx, arm, pal, S, closed) {
  const r = 4.2;
  ctx.save();
  ctx.translate(arm.wrist.x, arm.wrist.y);
  ctx.rotate(arm.angle + Math.PI / 2);
  const g = closed > 0.5;
  ctx.beginPath();
  if (g) {
    // mitt-shaped fist: wide at the knuckles, narrowing to the wrist
    ctx.moveTo(-r, -r * 0.35);
    ctx.quadraticCurveTo(-r, r * 1.15, 0, r * 1.2);
    ctx.quadraticCurveTo(r, r * 1.15, r, -r * 0.35);
    ctx.quadraticCurveTo(0, -r * 0.85, -r, -r * 0.35);
    ctx.closePath();
  } else {
    ctx.ellipse(0, r * 0.25, r * 0.82, r * 1.05, 0, 0, TAU);
  }
  ctx.fillStyle = pal.skin;
  ctx.fill();
  ctx.strokeStyle = pal.skinLine;
  ctx.lineWidth = 1.15;
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (g) {
    // single knuckle crease + top highlight: enough to read as a fist at 8 px
    ctx.strokeStyle = pal.skinShade;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, r * 0.34);
    ctx.quadraticCurveTo(0, r * 0.52, r * 0.55, r * 0.32);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.22, r * 0.02, r * 0.34, r * 0.2, -0.5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawArm(ctx, rig, arm, pal, style, st, isBack) {
  const lw = 2.0;
  const outline = pal.line;

  if (isBack) ctx.globalAlpha *= 0.94;

  // Upper arm and forearm are separate tapered segments that OVERLAP at the
  // elbow. Drawing the forearm first and capping the joint with the upper arm
  // hides the seam, so the arm reads as one continuous limb instead of two
  // sticks joined by a step.
  // Both arms are the same dark sleeve; the far arm is only slightly darker so
  // it separates without changing colour (it used to switch to the orange
  // "shade" tint, which read as a different garment entirely).
  const sleeve = isBack ? pal.jacketSleeveFar : pal.jacketSleeve;
  limb(ctx, [arm.elbow, arm.wrist], [7.6, 6.0], sleeve, outline, lw, pal.jacketSleeveShade);
  limb(ctx, [arm.root, arm.elbow], [10.2, 7.4], sleeve, outline, lw, pal.jacketSleeveShade);

  // elbow joint: a filled disc in the sleeve colour bridges the two capsules
  ctx.beginPath();
  ctx.arc(arm.elbow.x, arm.elbow.y, 3.9, 0, TAU);
  ctx.fillStyle = sleeve;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.75;
  ctx.stroke();

  // shoulder cap: only Naruto's jacket has the dark yoke pauldron
  if (style === 'naruto') {
    ctx.beginPath();
    ctx.arc(arm.root.x, arm.root.y, 4.6, 0, TAU);
    ctx.fillStyle = isBack ? pal.jacketDarkLight : pal.jacketDark;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
  }

  drawFist(ctx, arm, pal, rig.scale, st.grip);
  ctx.globalAlpha = 1;
}

function drawLeg(ctx, rig, leg, pal, style, st, isBack) {
  const lw = 2.1;
  const outline = pal.line;

  if (isBack) ctx.globalAlpha *= 0.96;

  // shin first, then thigh overlaps it at the knee (same trick as the arms)
  limb(ctx, [leg.knee, leg.ankle], [8.4, 6.4], isBack ? '#0e1016' : pal.shin, outline, lw, null);
  limb(ctx, [leg.root, leg.knee], [12.6, 8.4], isBack ? pal.pantsShade : pal.pants, outline, lw, pal.pantsShade);

  // knee cap
  ctx.beginPath();
  ctx.arc(leg.knee.x, leg.knee.y, 4.4, 0, TAU);
  ctx.fillStyle = isBack ? pal.pantsShade : pal.pants;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.7;
  ctx.stroke();

  // Sandal: built in a frame aligned to the actual ankle->toe direction, so it
  // can never float off the ankle regardless of foot rotation.
  const a = leg.ankle, t = leg.toe;
  const fa = Math.atan2(t.y - a.y, t.x - a.x);
  const fl = Math.hypot(t.x - a.x, t.y - a.y) || rig.footLen;
  ctx.save();
  ctx.translate(a.x, a.y);
  // the ankle joint is the pivot; the sole sits just under it
  ctx.beginPath();
  ctx.arc(0, 0, 3.2, 0, TAU);
  ctx.fillStyle = isBack ? '#0a0c11' : pal.shin;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.65;
  ctx.stroke();

  ctx.rotate(fa);
  const heel = -3.0, toe = fl + 1.5, h = 3.1;
  ctx.beginPath();
  ctx.moveTo(heel, -h * 0.15);
  ctx.quadraticCurveTo(heel - 1.4, h * 0.9, heel + 2.2, h);      // heel
  ctx.lineTo(toe - 1.6, h);                                       // sole
  ctx.quadraticCurveTo(toe + 1.4, h * 0.55, toe, -h * 0.55);      // toe box
  ctx.quadraticCurveTo(heel + 5, -h * 1.05, heel, -h * 0.15);     // instep
  ctx.closePath();
  ctx.fillStyle = isBack ? '#0b0e14' : pal.sandal;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.8;
  ctx.stroke();
  // sole rim + strap
  ctx.strokeStyle = pal.sandalLight;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(heel + 1.6, h * 0.82);
  ctx.lineTo(toe - 1.2, h * 0.82);
  ctx.stroke();
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(fl * 0.30, -h * 0.72);
  ctx.lineTo(fl * 0.56, h * 0.35);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // ankle wrap (sandal cuff)
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(fa);
  ctx.beginPath();
  ctx.roundRect(-3.6, -4.0, 7.2, 6.4, 2.2);
  ctx.fillStyle = isBack ? '#11141c' : pal.sandalLight;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = lw * 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawPelvis(ctx, rig, j, pal) {
  const h = j.hip;
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(j.torsoAngle + Math.PI / 2);
  // narrower than the torso hem so it tucks underneath instead of bulging out
  ctx.beginPath();
  ctx.ellipse(0, 2.5, rig.hipWidth * 1.02, 9.0, 0, 0, TAU);
  ctx.fillStyle = pal.pants;
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1.7;
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// World-space anchors for a fighter without drawing anything. Used to attach
// effects to the actual animated hands/feet/chest so a technique always reads as
// the character's action rather than a sprite pasted on top.
export function fighterAnchors(o) {
  const rig = o.rig;
  const joints = solveSkeleton(rig, o.pose);
  const facing = o.facing ?? 1;
  const sc = (o.scale ?? 1) * rig.scale;
  const rot = o.rot || 0;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const toWorld = (p) => {
    const lx = p.x * facing * sc, ly = p.y * sc;
    return { x: o.x + lx * cs - ly * sn, y: o.y + lx * sn + ly * cs };
  };
  return {
    hip: toWorld(joints.hip),
    chest: toWorld(joints.chest),
    neck: toWorld(joints.neck),
    head: toWorld(joints.head),
    frontHand: toWorld(joints.armFront.wrist),
    backHand: toWorld(joints.armBack.wrist),
    frontElbow: toWorld(joints.armFront.elbow),
    frontFoot: toWorld(joints.legFront.ankle),
    backFoot: toWorld(joints.legBack.ankle),
    frontToe: toWorld(joints.legFront.toe),
    backToe: toWorld(joints.legBack.toe),
    scale: sc,
    raw: joints,
  };
}

export function drawFighter(ctx, o) {
  const { rig, pose, style } = o;
  const pal = PALETTES[style];
  const S = rig.scale;
  const st = {
    time: o.time ?? 0,
    flow: o.flow ?? 0,
    facing: o.facing ?? 1,
    blink: o.blink ?? 0,
    angry: o.angry ?? 0.55,
    scream: o.scream ?? 0,
    alert: o.alert ?? 1,
    sharingan: o.sharingan ?? 0,
    scratched: style === 'sasuke',
    grip: 1,
  };
  const joints = solveSkeleton(rig, pose);

  const facing = o.facing ?? 1;
  const rot = o.rot || 0;
  const sc = (o.scale ?? 1) * S;

  ctx.save();
  ctx.translate(o.x, o.y);
  if (rot) ctx.rotate(rot);
  ctx.scale(facing * sc * 1, sc); // horizontal mirror for facing
  ctx.scale(1, 1);
  ctx.globalAlpha *= o.alpha ?? 1;

  // Aura behind the fighter: layered, noisy flame tongues rather than one soft
  // ellipse (a plain radial gradient reads as a visible halo).
  if ((o.auraStrength ?? 0) > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const a = clamp01(o.auraStrength);
    const H = rig.height;
    const t = o.time ?? 0;
    for (let i = 0; i < 9; i++) {
      const ph = t * 2.2 + i * 0.9;
      const wob = noise1(ph, 3 + i) * H * 0.06;
      const hh = H * (0.30 + 0.12 * ((i % 3) + 1)) * (1 + 0.06 * Math.sin(ph));
      const cy = -H * (0.32 + 0.12 * (i % 4)) + wob * 0.4;
      const cw = H * (0.10 + 0.035 * (i % 4));
      const g = ctx.createRadialGradient(wob * 0.5, cy, 0, wob * 0.5, cy, cw);
      g.addColorStop(0, `rgba(${pal.aura},${0.16 * a})`);
      g.addColorStop(0.5, `rgba(${pal.aura},${0.06 * a})`);
      g.addColorStop(1, `rgba(${pal.aura},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(wob * 0.5, cy, cw, hh * 0.9, 0, 0, TAU);
      ctx.fill();
    }
    // rising energy sparks
    for (let i = 0; i < 12; i++) {
      const ph = (t * (0.5 + hash(i) * 0.7) + hash(i + 20)) % 1;
      const px = (hash(i + 40) - 0.5) * H * 0.5;
      const py = -ph * H * 1.05 - H * 0.08;
      const r = (1.2 + hash(i + 60) * 2.2) * (1 - ph);
      const al = (0.5 * a) * Math.sin(ph * Math.PI);
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 3);
      g.addColorStop(0, `rgba(255,255,235,${al})`);
      g.addColorStop(1, `rgba(${pal.aura},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r * 3, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // back layer
  drawLeg(ctx, rig, joints.legBack, pal, style, st, true);
  drawArm(ctx, rig, joints.armBack, pal, style, st, true);
  drawNeck(ctx, rig, joints, pal, style);

  drawTorso(ctx, rig, pose, joints, pal, style, st);
  drawJacketHem(ctx, rig, joints, pal, st);
  drawCollar(ctx, rig, joints, pal, style, st);

  drawPelvis(ctx, rig, joints, pal);
  drawLeg(ctx, rig, joints.legFront, pal, style, st, false);
  drawHead(ctx, rig, pose, joints, pal, style, st);
  drawArm(ctx, rig, joints.armFront, pal, style, st, false);

  ctx.restore();

  return fighterAnchors(o);
}

/* ============================================================
   樹木：シマトネリコ／ソヨゴ／オリーブ
   tree3d.html の生成コードを部品化したもの
   ※ 本体アプリへの移植にあたり、5.5MB の tree.obj を読み込む「標準樹木」は外し、
      手続き生成の樹種だけにしてある（配布サイズを増やさないため）
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/geom.js';
import { thin } from '../util/quality.js';   // ★追加：ドラッグ中は葉の数を間引く

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const GOLDEN = 2.39996;
const OBJ_LEAF_DENSITY = 1.11;          // m²/m³（tree.obj の実測）

const SPECIES = {
  'シマトネリコ': { leaf:'pinnate', leafLen:0.20, levels:5, angle:42, dens:1.00, color:'#7ea94f',
                    upward:1.0, hang:0.15, pitch:0.25, bark:0xa89684 },
  'ソヨゴ':       { leaf:'ovate',   leafLen:0.095,levels:5, angle:40, dens:1.80, color:'#4a7a3c',
                    upward:0.9, hang:0.25, pitch:0.15, bark:0x9a958b },
  'オリーブ':     { leaf:'linear',  leafLen:0.16, levels:5, angle:46, dens:1.30, color:'#8b9b76',
                    upward:1.0, hang:0.15, pitch:0.30, bark:0xa39a8a },
};

/* ---------- マテリアル ---------- */
function barkTexture(){
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#3d291c'; g.fillRect(0, 0, 128, 512);
  const r = mulberry32(20240);
  for (let i = 0; i < 300; i++){
    const x = r()*128, w = 1 + r()*7, h = 50 + r()*280, y = r()*512;
    g.globalAlpha = 0.10 + r()*0.32;
    g.fillStyle = r() < 0.55 ? '#180f08' : '#6f5036';
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x + (r()-0.5)*12, y + h*0.5, x + (r()-0.5)*9, y + h);
    g.lineTo(x + w + (r()-0.5)*9, y + h);
    g.quadraticCurveTo(x + w + (r()-0.5)*12, y + h*0.5, x + w, y);
    g.closePath(); g.fill();
  }
  for (let i = 0; i < 1100; i++){
    g.globalAlpha = 0.05 + r()*0.14;
    g.fillStyle = r() < 0.5 ? '#1c120a' : '#7d5c3d';
    g.fillRect(r()*128, r()*512, 2 + r()*14, 1);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const barkMap = barkTexture();
const matCache = new Map();
const barkMat = hex => cached('bark' + hex, () => new THREE.MeshStandardMaterial(
  { map: barkMap, color: hex, roughness: 0.95 }));
const leafMat = col => cached('leaf' + col, () => new THREE.MeshLambertMaterial(
  { color: col, side: THREE.DoubleSide }));
function cached(k, f){ if (!matCache.has(k)) matCache.set(k, f()); return matCache.get(k); }

/* ============================================================
   骨格
   ============================================================ */
function buildSkeleton(P, SP, rnd){
  const branches = [], anchors = [];
  const maxDepth = SP.levels;
  const angRad = THREE.MathUtils.degToRad(SP.angle);
  const trunkLen = P.clear * 2.4 + 0.25;
  const firstLen = (1 - P.clear) * 2.0;
  let forkY = 0;

  function addAnchors(pts, dir, density){
    for (let i = 1; i < pts.length; i++){
      if (rnd() > density) continue;
      const p = pts[i].clone().lerp(pts[i-1], rnd()*0.6);
      const d = pts[i].clone().sub(pts[i-1]).normalize().lerp(dir, 0.3).normalize();
      anchors.push({ pos: p, dir: d, tip: false });
    }
  }
  function grow(origin, dir, len, rad, depth){
    const segCount = depth === 0 ? 8 : 5;
    const pts = [origin.clone()], radii = [rad];
    const endRad = rad * 0.72;
    const d = dir.clone().normalize();
    let pos = origin.clone();
    const dr = depth / maxDepth;
    const phase = rnd() * Math.PI * 2;
    const curlAxis = new THREE.Vector3(rnd()-0.5, (rnd()-0.5)*0.25, rnd()-0.5).normalize();
    const curl = P.gnarl * (0.05 + rnd()*0.09) * (depth === 0 ? 0.45 : 1);
    const jit = P.gnarl * 0.05;
    const rise = 0.14 * (1 - dr*0.8) * SP.upward;
    const fall = P.droop * 0.17 * (0.25 + dr);

    for (let i = 1; i <= segCount; i++){
      const t = i / segCount;
      d.applyAxisAngle(curlAxis, curl);
      d.x += (rnd()-0.5)*jit; d.z += (rnd()-0.5)*jit;
      d.y += rise - fall;
      if (depth > 0){
        const room = pos.y - forkY;
        if (room < 0.15) d.y += (0.15 - room) * 1.6;
      }
      d.normalize();
      pos = pos.clone().addScaledVector(d, len / segCount);
      if (depth > 0 && pos.y < forkY) pos.y = forkY;
      pts.push(pos.clone());
      radii.push(THREE.MathUtils.lerp(rad, endRad, t));
    }
    branches.push({ pts, radii, depth });
    if (depth === 0) forkY = pos.y;

    if (depth >= maxDepth){
      addAnchors(pts, d, 1.0);
      anchors.push({ pos: pos.clone(), dir: d.clone(), tip: true });
      return;
    }
    if (depth >= maxDepth - 1) addAnchors(pts, d, 0.65);
    else if (depth >= maxDepth - 2) addAnchors(pts, d, 0.30);

    const cScale = depth === 0 ? firstLen / trunkLen : 1;
    const kids = [{ az: phase, ang: angRad*(0.18 + rnd()*0.18), len: len*(0.78 + rnd()*0.10)*cScale }];
    const extra = depth === 0 ? (rnd() < 0.6 ? 2 : 1) : (rnd() < 0.3 ? 2 : 1);
    for (let k = 0; k < extra; k++)
      kids.push({ az: phase + (k+1)*GOLDEN + (rnd()-0.5)*0.5,
                  ang: angRad*(0.80 + rnd()*0.45), len: len*(0.52 + rnd()*0.20)*cScale });
    const sum = kids.reduce((a, k) => a + k.len, 0);
    for (const k of kids)
      spawn(pos, d, k.az, k.ang, k.len, rad * Math.sqrt(k.len / sum) * 0.93, depth + 1);

    if (depth >= 1){
      const sides = depth <= 2 ? 1 + Math.floor(rnd()*2) : (rnd() < 0.55 ? 1 : 0);
      for (let s = 0; s < sides; s++){
        const i = 2 + Math.floor(rnd()*(segCount-2));
        const t = i / segCount;
        const tang = pts[i].clone().sub(pts[i-1]).normalize();
        spawn(pts[i], tang, phase + 1.7 + s*GOLDEN, angRad*(0.95 + rnd()*0.45),
              len*(0.40 + rnd()*0.20), THREE.MathUtils.lerp(rad, endRad, t)*0.48, depth + 1);
      }
    }
  }
  const tmpAxis = new THREE.Vector3(), tmpSide = new THREE.Vector3();
  function spawn(origin, dir, az, ang, len, rad, depth){
    tmpSide.set(Math.cos(az), 0, Math.sin(az));
    tmpAxis.crossVectors(dir, tmpSide);
    if (tmpAxis.lengthSq() < 1e-8) tmpAxis.set(1, 0, 0);
    tmpAxis.normalize();
    const child = dir.clone().applyAxisAngle(tmpAxis, ang);
    if (child.y < -0.35) child.y = -0.35;
    grow(origin.clone(), child.normalize(), len, rad, depth);
  }

  const lean = new THREE.Vector3((rnd()-0.5)*0.16, 1, (rnd()-0.5)*0.16).normalize();
  grow(new THREE.Vector3(0,0,0), lean, trunkLen, 0.060, 0);

  /* 実寸へ正規化 */
  let maxY = 0, maxR = 0.001;
  for (const b of branches) for (const p of b.pts) maxY = Math.max(maxY, p.y);
  const kY = P.height / Math.max(maxY, 1e-4);
  for (const b of branches) for (const p of b.pts){
    p.multiplyScalar(kY);
    maxR = Math.max(maxR, Math.hypot(p.x, p.z));
  }
  const kXZ = (P.spread * 0.5) / maxR;
  for (const b of branches){
    for (const p of b.pts){ p.x *= kXZ; p.z *= kXZ; }
    for (let i = 0; i < b.radii.length; i++) b.radii[i] *= kY * P.trunk;
  }
  for (const a of anchors){
    a.pos.multiplyScalar(kY); a.pos.x *= kXZ; a.pos.z *= kXZ;
    a.dir.set(a.dir.x*kXZ, a.dir.y, a.dir.z*kXZ).normalize();
  }
  /* 枝下高をぴったりに */
  const yF = forkY * kY, yT = P.clear * P.height;
  if (yF > 1e-3 && P.height - yF > 1e-3){
    const kLow = yT / yF, kHigh = (P.height - yT) / (P.height - yF);
    const remap = y => (y <= yF ? y * kLow : yT + (y - yF) * kHigh);
    for (const b of branches) for (const p of b.pts) p.y = remap(p.y);
    for (const a of anchors) a.pos.y = remap(a.pos.y);
  }
  for (let i = anchors.length - 1; i >= 0; i--) if (anchors[i].pos.y < yT) anchors.splice(i, 1);

  const t0 = branches[0];
  t0.pts[0].y -= 0.05;
  t0.radii[0] *= 1.45;
  if (t0.radii.length > 1) t0.radii[1] *= 1.12;
  return { branches, anchors };
}

/* 枝のチューブ */
function tubeGeometry(pts, radii, radial, lengthDiv){
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  const tubular = Math.max(3, (pts.length - 1) * (lengthDiv || 2));
  const frames = curve.computeFrenetFrames(tubular, false);
  const len = curve.getLength();
  const position = [], normal = [], uv = [], index = [];
  const Pv = new THREE.Vector3(), Nv = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++){
    const t = i / tubular;
    curve.getPointAt(t, Pv);
    const f = t * (radii.length - 1);
    const i0 = Math.min(radii.length - 1, Math.floor(f));
    const i1 = Math.min(radii.length - 1, i0 + 1);
    const r = THREE.MathUtils.lerp(radii[i0], radii[i1], f - i0);
    const N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= radial; j++){
      const a = j / radial * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      Nv.set(c*N.x + s*B.x, c*N.y + s*B.y, c*N.z + s*B.z).normalize();
      position.push(Pv.x + r*Nv.x, Pv.y + r*Nv.y, Pv.z + r*Nv.z);
      normal.push(Nv.x, Nv.y, Nv.z);
      uv.push(j / radial * 1.6, t * len * 1.1);
    }
  }
  for (let i = 0; i < tubular; i++) for (let j = 0; j < radial; j++){
    const a = (radial+1)*i + j, b = (radial+1)*(i+1) + j;
    index.push(a, b, a+1, b, b+1, a+1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/* 葉（1房） */
function ClusterBuilder(){
  const position = [], normal = [], uv = [], index = [];
  const side = new THREE.Vector3();
  function blade(base, dir, nrm, L, W, prof, segs){
    segs = segs || 2;
    side.crossVectors(nrm, dir).normalize();
    const i0 = position.length / 3;
    for (let i = 0; i <= segs; i++){
      const t = i / segs, hw = W * prof(t);
      for (const s of [-1, 1]){
        position.push(base.x + dir.x*L*t + side.x*hw*s,
                      base.y + dir.y*L*t + side.y*hw*s,
                      base.z + dir.z*L*t + side.z*hw*s);
        normal.push(nrm.x, nrm.y, nrm.z);
        uv.push(s < 0 ? 0 : 1, t);
      }
    }
    for (let i = 0; i < segs; i++){ const a = i0 + i*2; index.push(a, a+1, a+2, a+1, a+3, a+2); }
  }
  function diamond(base, dir, nrm, L, W){
    side.crossVectors(nrm, dir).normalize();
    const i0 = position.length / 3;
    for (const [a, b] of [[0,0],[0.38,1],[1,0],[0.38,-1]]){
      position.push(base.x + dir.x*L*a + side.x*W*b,
                    base.y + dir.y*L*a + side.y*W*b,
                    base.z + dir.z*L*a + side.z*W*b);
      normal.push(nrm.x, nrm.y, nrm.z);
      uv.push(b*0.5 + 0.5, a);
    }
    index.push(i0, i0+1, i0+2, i0, i0+2, i0+3);
  }
  function stem(ptFn, len, w, segs){
    segs = segs || 6;
    const i0 = position.length / 3;
    for (let i = 0; i <= segs; i++){
      const t = i / segs, p = ptFn(t), ww = w * (1 - t*0.7);
      position.push(p.x - ww, p.y, p.z, p.x + ww, p.y, p.z);
      normal.push(0,0,1, 0,0,1);
      uv.push(0, t, 1, t);
    }
    for (let i = 0; i < segs; i++){ const a = i0 + i*2; index.push(a, a+1, a+2, a+1, a+3, a+2); }
  }
  function geometry(){
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute('normal',   new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    return g;
  }
  return { blade, diamond, stem, geometry };
}
const PROF = {
  lance:  t => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.75),
  ovate:  t => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.60)), 0.85),
  linear: t => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.80)), 0.55),
};

function leafClusterGeometry(sp, len, lp){
  const B = ClusterBuilder();
  const r = mulberry32(99);
  const axis = droop => t => new THREE.Vector3(0, t*len, -droop*len*t*t);
  const K = lp ? 1.5 : 1;
  if (sp.leaf === 'pinnate'){
    const pairs = lp ? 4 : 8, pt = axis(0.35);
    if (!lp) B.stem(pt, len, len*0.008);
    for (let i = 0; i < pairs; i++){
      const t = 0.12 + (i + 0.5)/pairs*0.86, base = pt(t);
      const taper = Math.sin(Math.min(1, t*1.15) * Math.PI * 0.92);
      const L = len*(0.20 + 0.16*taper)*K, W = L*0.17*K;
      for (const s of [-1, 1]){
        const spin = (r()-0.5)*0.7;
        const dir = new THREE.Vector3(s*0.94, 0.44, 0.10 + spin*0.25).normalize();
        const nrm = new THREE.Vector3(-s*0.20, 0.55, 0.81).normalize().applyAxisAngle(UP, spin);
        const LL = L*(0.85 + r()*0.3);
        if (lp) B.diamond(base, dir, nrm, LL, W); else B.blade(base, dir, nrm, LL, W, PROF.lance);
      }
    }
    const tipL = len*0.26*K;
    const tipDir = new THREE.Vector3(0, 0.86, -0.5).normalize();
    const tipNrm = new THREE.Vector3(0, 0.5, 0.86).normalize();
    if (lp) B.diamond(pt(0.99), tipDir, tipNrm, tipL, tipL*0.17*K);
    else    B.blade(pt(0.99), tipDir, tipNrm, tipL, tipL*0.17, PROF.lance);
  } else if (sp.leaf === 'ovate'){
    const n = lp ? 3 : 6, pt = axis(0.25);
    if (!lp) B.stem(pt, len, len*0.010);
    for (let i = 0; i < n; i++){
      const t = 0.15 + (i + 0.5)/n*0.85, base = pt(t), s = i % 2 ? 1 : -1;
      const spin = (r()-0.5)*1.0 + i*1.1;
      const L = len*(0.46 + r()*0.16)*K, W = L*0.44;
      const dir = new THREE.Vector3(s*0.78, 0.52, (r()-0.5)*0.5).normalize().applyAxisAngle(UP, spin*0.3);
      const nrm = new THREE.Vector3(-s*0.25, 0.62, 0.74).normalize().applyAxisAngle(UP, spin*0.3);
      if (lp) B.diamond(base, dir, nrm, L, W*0.85); else B.blade(base, dir, nrm, L, W, PROF.ovate, 3);
    }
  } else {
    const n = lp ? 5 : 11, pt = axis(0.15);
    if (!lp) B.stem(pt, len, len*0.006, 8);
    for (let i = 0; i < n; i++){
      const t = 0.10 + (i + 0.5)/n*0.88, base = pt(t), s = i % 2 ? 1 : -1;
      const spin = (r()-0.5)*0.8 + i*0.9;
      const L = len*(0.30 + r()*0.10)*K, W = L*0.15*K;
      const dir = new THREE.Vector3(s*0.80, 0.42, 0.15 + spin*0.15).normalize().applyAxisAngle(UP, spin*0.25);
      const nrm = new THREE.Vector3(-s*0.30, 0.40, 0.86).normalize().applyAxisAngle(UP, spin*0.25);
      if (lp) B.diamond(base, dir, nrm, L, W); else B.blade(base, dir, nrm, L, W, PROF.linear, 3);
    }
  }
  return B.geometry();
}

function geometryArea(geo){
  const pos = geo.attributes.position, idx = geo.index;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  const count = idx ? idx.count : pos.count;
  const at = i => (idx ? idx.getX(i) : i);
  let sum = 0;
  for (let i = 0; i < count; i += 3){
    A.fromBufferAttribute(pos, at(i)); B.fromBufferAttribute(pos, at(i+1)); C.fromBufferAttribute(pos, at(i+2));
    ab.subVectors(B, A); ac.subVectors(C, A);
    sum += cr.crossVectors(ab, ac).length() * 0.5;
  }
  return sum;
}

/* ============================================================
   生成木
   ============================================================ */
function buildTree(P){
  const g = new THREE.Group();
  const SP = SPECIES[P.species] || SPECIES['シマトネリコ'];
  const rnd = mulberry32(P.seed || 12345);
  const lp = !P.detail;
  const spread = Math.min(Math.max(P.spread, P.height*0.5), P.height*1.2);
  const par = { ...P, spread };
  const { branches, anchors } = buildSkeleton(par, SP, rnd);

  const geos = [];
  const minRad = lp ? 0.004 : 0.0015;
  for (const b of branches){
    if (b.radii[0] < minRad) continue;
    const radial = lp ? (b.depth === 0 ? 6 : 4)
                      : (b.depth === 0 ? 10 : (b.depth === 1 ? 7 : 5));
    geos.push(tubeGeometry(b.pts, b.radii, radial, lp ? 1 : 2));
  }
  if (geos.length){
    const merged = mergeGeometries(geos, false);
    geos.forEach(x => x.dispose());
    const trunk = new THREE.Mesh(merged, barkMat(SP.bark));
    trunk.castShadow = true; trunk.receiveShadow = true;
    g.add(trunk);
  }

  const sprayLen = SP.leafLen, MAX = 6000;
  const geo = anchors.length ? leafClusterGeometry(SP, sprayLen, lp) : null;
  const crownH = Math.max(0.2, par.height * (1 - par.clear));
  const crownVol = Math.PI / 6 * spread * spread * crownH;
  const areaPer = geo ? geometryArea(geo) * 1.085 : 1;
  let count = geo ? Math.round(OBJ_LEAF_DENSITY * SP.dens * par.leafAmount * crownVol / Math.max(areaPer, 1e-9)) : 0;
  count = thin(Math.max(0, Math.min(MAX, count)));

  const list = [];
  if (count > 0 && anchors.length){
    const tips = anchors.filter(a => a.tip), mids = anchors.filter(a => !a.tip);
    const pick = (src, k) => {
      if (!src.length || k <= 0) return;
      const step = src.length / k;
      for (let i = 0; i < k; i++) list.push(src[Math.floor(i*step) % src.length]);
    };
    pick(tips, Math.min(count, tips.length));
    pick(mids, Math.max(0, count - tips.length));
  }
  count = list.length;
  if (count > 0){
    const mesh = new THREE.InstancedMesh(geo, leafMat(P.leafColor || SP.color), count);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    const sc = new THREE.Vector3(), dir = new THREE.Vector3(), pos = new THREE.Vector3();
    for (let i = 0; i < count; i++){
      const a = list[i];
      dir.copy(a.dir).add(new THREE.Vector3((rnd()-0.5)*0.9, (rnd()-0.5)*0.7 + SP.pitch, (rnd()-0.5)*0.9)).normalize();
      if (SP.hang > 0) dir.lerp(DOWN, SP.hang * (0.75 + rnd()*0.5)).normalize();
      q.setFromUnitVectors(UP, dir);
      q2.setFromAxisAngle(UP, rnd()*Math.PI*2);
      q.multiply(q2);
      const s = 0.78 + rnd()*0.5;
      sc.set(s, s, s);
      pos.set(a.pos.x + (rnd()-0.5)*sprayLen*0.5,
              a.pos.y + (rnd()-0.5)*sprayLen*0.35,
              a.pos.z + (rnd()-0.5)*sprayLen*0.5);
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    g.add(mesh);
  } else if (geo) geo.dispose();
  return g;
}

/* ※ planner にあった「標準樹木（tree.obj）」は、5.5MB の OBJ を配布に含めないため移植していない。
   必要になったら tree/js/items/tree.js の loadTree / buildObjTree を戻すこと。 */


/* ---------- カタログ ---------- */
const genParams = [
  { k:'height',     l:'樹高',     min:2.0, max:5.0, step:0.1,  def:3.0, fmt:v=>v.toFixed(1)+' m' },
  { k:'spread',     l:'枝張り',   min:1.0, max:6.0, step:0.1,  def:2.9,
    fmt:(v,P)=>v.toFixed(1)+' m ×'+(v/P.height).toFixed(2)+'（0.5〜1.2倍に丸め）' },
  { k:'clear',      l:'枝下高',   min:0.05,max:0.7, step:0.01, def:0.34, fmt:(v,P)=>(v*P.height).toFixed(1)+' m' },
  { k:'gnarl',      l:'曲がり',   min:0,   max:1,   step:0.01, def:0.42, fmt:v=>v.toFixed(2) },
  { k:'droop',      l:'垂れ',     min:-0.3,max:1,   step:0.01, def:0.30, fmt:v=>v.toFixed(2) },
  { k:'trunk',      l:'幹の太さ', min:0.4, max:2.5, step:0.05, def:1.00, fmt:v=>'×'+v.toFixed(2) },
  { k:'leafAmount', l:'葉の量',   min:0,   max:2,   step:0.05, def:1.00, fmt:v=>v.toFixed(2) },
];

/* ★葉の色は色コードのままだと選びにくいので、和名で選べるようにする。
   （保存済みデータに色コードが入っていても、そのまま色として使えるようにしてある） */
const LEAF_COLORS = {
  '濃緑':   '#4a7a3c',
  '若草色': '#7ea94f',
  '黄緑':   '#9dbd55',
  '銀緑':   '#8b9b76',
  '枯葉色': '#b5ac74',
};
const leafColorOf = (name, species) =>
  name === '標準' ? SPECIES[species].color : (LEAF_COLORS[name] || name);

export default {
  group: '樹木',
  items: [
    ...Object.keys(SPECIES).map(name => ({
      id: 'tree_' + name, name, place: 'point', rotatable: true,
      params: genParams,
      options: [
        { k:'detail', l:'詳細化（高精細）', type:'check', def:false },
        { k:'leafColor', l:'葉の色', type:'select',
          values:['標準', ...Object.keys(LEAF_COLORS)], def:'標準' },
      ],
      build: P => buildTree({ ...P, species: name,
        leafColor: leafColorOf(P.leafColor, name) }),
      info: P => `樹高 ${P.height.toFixed(1)} m ／ 枝張り ${Math.min(Math.max(P.spread, P.height*0.5), P.height*1.2).toFixed(1)} m`,
    })),
  ],
};

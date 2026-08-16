/* ============================================================
   囲い：ブロック塀／フェンス／石積＋生垣
   fence3d.html の生成コードを部品化したもの。長さは引いた線から決まる
   ============================================================ */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { box, addMerged, mulberry32, scaleUV, setColorAttr } from '../util/geom.js';

const BLK = { w: 0.39, h: 0.19, modX: 0.40, modY: 0.20, thickness: 0.15 };
const CAP = { unit: 0.30, gap: 0.005, out: 0.03, h: 0.055 };
const UVM = 0.6;
const m2 = v => v.toFixed(2) + ' m';

/* ---------- マテリアル ---------- */
function blockTexture(){
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c8c2'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 4000; i++){
    const v = 200 + Math.random() * 55;
    g.fillStyle = `rgba(${v|0},${v|0},${(v-4)|0},${0.05 + Math.random()*0.25})`;
    g.fillRect(Math.random()*128, Math.random()*128, 1 + Math.random()*2, 1 + Math.random()*2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function sandTexture(){
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#eae4d6'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 26000; i++){
    const r = Math.random();
    g.fillStyle = r < 0.5 ? 'rgba(172,164,148,0.26)'
               : r < 0.86 ? 'rgba(255,253,247,0.34)' : 'rgba(138,130,116,0.20)';
    g.fillRect(Math.random()*256, Math.random()*256, 1 + Math.random()*1.5, 1 + Math.random()*1.5);
  }
  for (let i = 0; i < 12; i++){
    const x = Math.random()*256, y = Math.random()*256, rr = 20 + Math.random()*45;
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(196,186,166,0.045)');
    gr.addColorStop(1, 'rgba(196,186,166,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, Math.PI*2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const sandMap   = sandTexture();
const blockMat  = new THREE.MeshStandardMaterial({ map: blockTexture(), color: 0xbfbeb8, roughness: 0.95 });
const stuccoMat = new THREE.MeshStandardMaterial({ map: sandMap, bumpMap: sandMap,
                    bumpScale: 0.005, color: 0xefeade, roughness: 1.0 });
/* 目地（ブロックの奥にある下地の板）。
   ⚠️ ブロックは目地より 10.5mm しか手前に出ていない。このアプリのカメラは
     near 1mm / far 1,000,000mm と範囲が極端で、20m 先での深度の分解能は 20mm 程度しか
     ないため、その差では前後が決まらず縞状にちらつく。既定色どうしは色が近いので
     目立たないが、02 で対比の強い色を塗ると 2色が争ってはっきり出る。
     目地の側をポリゴンオフセットで奥へ逃がし、ブロックが必ず手前に描かれるようにする。
     考え方は core/store.js の applyGroundPolygonOffset（地面と方眼の対策）と同じ。 */
const jointMat  = new THREE.MeshStandardMaterial({ color: 0x8e8d88, roughness: 1.0,
                    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
const capMat    = new THREE.MeshStandardMaterial({ color: 0xd3d7d9, roughness: 0.45 });
const stoneMat  = new THREE.MeshStandardMaterial({ color: 0x9d9a92, roughness: 1.0, vertexColors: true });
const mortarMat = new THREE.MeshStandardMaterial({ color: 0x4b483f, roughness: 1.0 });
const hedgeMat  = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85,
                    vertexColors: true, side: THREE.DoubleSide });
const hedgeCoreMat = new THREE.MeshStandardMaterial({ color: 0x24401d, roughness: 1.0 });

const FENCE_COLORS = { 'シルバー':0xb6babd, 'ダークブロンズ':0x4a4038, 'ホワイト':0xe6e6e1, 'グリーン':0x546b4a };
const fenceMats = {};
const fenceMat = c => fenceMats[c] || (fenceMats[c] =
  new THREE.MeshStandardMaterial({ color: FENCE_COLORS[c], roughness: 0.5, metalness: 0.35 }));

/* ============================================================
   ブロック塀
   ============================================================ */
/* 長さは丸めず、端は現場と同じように半端なブロックで納める
   （折れ線の角をぴったり合わせるため） */
function buildWall(len, courses, th, finish){
  const blocks = [], joints = [];
  const full = Math.floor(len / BLK.modX + 1e-6);
  const rest = len - full * BLK.modX;
  const x0 = -len / 2, h = courses * BLK.modY;
  if (finish === 'stucco'){
    const g = box(len, h, th + 0.02, 0, h / 2, 0, blocks);
    scaleUV(g, len / UVM, h / UVM);
    return { blocks, joints, height: h, count: full * courses };
  }
  for (let c = 0; c < courses; c++){
    const y = c * BLK.modY;
    for (let i = 0; i < full; i++)
      box(BLK.w, BLK.h, th, x0 + BLK.modX * i + BLK.modX / 2, y + BLK.modY / 2, 0, blocks);
    if (rest > 0.03){                                  // 半端は切ったブロックで埋める
      const w = rest - (BLK.modX - BLK.w);
      if (w > 0.02) box(w, BLK.h, th, x0 + BLK.modX * full + w / 2, y + BLK.modY / 2, 0, blocks);
    }
    box(len, BLK.modY, th * 0.86, 0, y + BLK.modY / 2, 0, joints);
  }
  return { blocks, joints, height: h, count: (full + (rest > 0.03 ? 1 : 0)) * courses };
}

/* 笠木瓦 */
function buildCap(len, topY, th, out){
  const w = th + CAP.out * 2;
  const n = Math.max(1, Math.round(len / CAP.unit)), u = len / n;
  const s = new THREE.Shape();
  s.moveTo(-w/2, 0); s.lineTo(w/2, 0); s.lineTo(w/2, CAP.h*0.55);
  s.lineTo(w/2 - 0.018, CAP.h*0.86); s.lineTo(0, CAP.h);
  s.lineTo(-w/2 + 0.018, CAP.h*0.86); s.lineTo(-w/2, CAP.h*0.55); s.closePath();
  for (let i = 0; i < n; i++){
    const g = new THREE.ExtrudeGeometry(s, { depth: u - CAP.gap, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(Math.PI / 2);
    g.translate(-len / 2 + u * i + CAP.gap / 2, topY, 0);
    out.push(g);
  }
  return n;
}

/* 控壁（令第62条の8）：高さ1.2m超のとき 3.4m 以下ごと */
function buttressPlan(len, courses, totalH, hasFence){
  const over = totalH > 1.2 + 1e-6;
  const need = courses > 0 && over && (!hasFence || courses >= 4);
  if (!need) return { need:false, n:0, courses:0, depth:0, pitch:0,
    reason: courses === 0 ? '' : (!over ? '高さ1.2m以下' : 'ブロック3段以下') };
  const bCourses = hasFence ? courses : Math.max(1, courses - 2);
  const depth = (totalH / 5) <= BLK.w / 2 ? BLK.w / 2 : BLK.w;
  const nSpan = Math.max(1, Math.ceil(len / 3.4));
  return { need:true, n: nSpan - 1, courses: bCourses, depth, pitch: len / nSpan, reason:'' };
}
function buildButtress(len, plan, th, out, side, finish){
  if (!plan.need || plan.n < 1) return;
  const zc = (th / 2 + plan.depth / 2) * side;
  const bh = plan.courses * BLK.modY;
  for (let k = 1; k <= plan.n; k++){
    const x = -len / 2 + plan.pitch * k;
    if (finish === 'stucco'){
      const g = box(th + 0.02, bh, plan.depth, x, bh / 2, zc, out);
      scaleUV(g, plan.depth / UVM, bh / UVM);
      continue;
    }
    for (let c = 0; c < plan.courses; c++)
      box(th, BLK.h, plan.depth - 0.01, x, c * BLK.modY + BLK.modY / 2, zc, out);
  }
}

/* フェンス（opt.noStart / opt.noEnd で端の支柱を省く＝角柱は別に立てる） */
const POST = 0.055;
function buildFence(len, baseY, h, pitch, kind, opt = {}){
  const geos = [], x0 = -len / 2;
  const RAIL = 0.05, FRAME = 0.04;
  const nSpan = Math.max(1, Math.round(len / pitch)), step = len / nSpan;
  for (let i = 0; i <= nSpan; i++){
    if (i === 0 && opt.noStart) continue;
    if (i === nSpan && opt.noEnd) continue;
    box(POST, h, POST, x0 + step * i, baseY + h / 2, 0, geos);
  }
  const yTop = baseY + h - FRAME / 2;
  const yBot = baseY + FRAME / 2 + Math.min(0.05, h * 0.06);
  box(len, FRAME, RAIL, 0, yTop, 0, geos);
  box(len, FRAME, RAIL, 0, yBot, 0, geos);
  const iy0 = yBot + FRAME / 2, iy1 = yTop - FRAME / 2;
  const ih = Math.max(0.02, iy1 - iy0), cy = (iy0 + iy1) / 2;
  const nv = Math.max(1, Math.round(len / 0.11)), sv = len / nv;
  for (let i = 1; i < nv; i++) box(0.018, ih, 0.018, x0 + sv * i, cy, 0.004, geos);
  if (kind === 'grid'){
    const nh = Math.max(1, Math.round(ih / 0.11)), sh = ih / nh;
    for (let i = 1; i < nh; i++) box(len, 0.016, 0.016, 0, iy0 + sh * i, -0.004, geos);
  }
  return { geos, posts: nSpan + 1 };
}

/* ============================================================
   玉石積み
   ============================================================ */
function rockGeometry(w, h, d, round, rnd){
  const g = new THREE.IcosahedronGeometry(0.5, 2);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3();
  const f1 = 1.8 + rnd()*1.3, f2 = 2.8 + rnd()*1.6;
  const a1 = 0.06 + rnd()*0.05, a2 = 0.03 + rnd()*0.03;
  const ph = [rnd()*6.283, rnd()*6.283, rnd()*6.283];
  for (let i = 0; i < p.count; i++){
    v.fromBufferAttribute(p, i);
    n.copy(v).normalize();
    const m = Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z));
    b.copy(n).multiplyScalar(0.5 / m);
    v.copy(n).multiplyScalar(0.5).lerp(b, 1 - round);
    const k = 1
      + a1 * Math.sin(n.x*f1 + ph[0]) * Math.cos(n.y*f1 + ph[1])
      + a2 * Math.sin(n.z*f2 + ph[2])
      + 0.022 * Math.sin(n.x*7.3 + ph[1]) * Math.sin(n.y*6.1 + ph[2]) * Math.cos(n.z*5.7 + ph[0]);
    p.setXYZ(i, v.x*k, v.y*k, v.z*k);
  }
  g.scale(w, h, d);
  g.deleteAttribute('uv');
  const m = mergeVertices(g);
  g.dispose();
  m.computeVertexNormals();
  return m;
}

function buildStone(len, h, size, wallDepth, round, out){
  const rnd = mulberry32(20240229);
  const col = new THREE.Color();
  const nRow = Math.max(1, Math.round(h / (size * 0.78)));
  const rowH = h / nRow;
  const joints = [];
  let count = 0;
  const addStone = (w, hh, depth, x, y, z, tone) => {
    const x0 = Math.max(x - w/2, -len/2), x1 = Math.min(x + w/2, len/2);
    const ww = x1 - x0;
    if (ww < 0.04) return;
    const g = rockGeometry(ww, hh, depth, round, rnd);
    g.translate((x0 + x1) / 2, y, z);
    const warm = (rnd() - 0.5) * 0.13;
    col.setRGB(tone * (1 + warm), tone * (1 + warm*0.25), tone * (1 - warm*0.9));
    setColorAttr(g, col);
    out.push(g);
    count++;
  };
  const blocked = Array.from({ length: nRow + 1 }, () => []);
  for (let r = 0; r < nRow; r++){
    const y0 = r * rowH;
    const depth = wallDepth * (0.98 - r * 0.04);
    let x = -len / 2;
    while (x < len / 2){
      const hit = blocked[r].find(([a, b]) => x + 0.02 > a && x + 0.02 < b);
      if (hit){ x = Math.max(x + size*0.2, hit[1] - size*0.10); continue; }
      const big = r < nRow - 1 && rnd() < 0.18 && x + size*1.6 < len/2;
      const w  = big ? size * (1.15 + rnd()*0.55) : size * (0.85 + rnd()*0.55);
      const hh = big ? rowH * 2 * (1.06 + rnd()*0.10) : rowH * (1.24 + rnd()*0.18);
      const cy = big ? y0 + rowH + (rnd()-0.5)*rowH*0.06
                     : y0 + rowH/2 + (rnd()-0.5)*rowH*0.08;
      const tone = rnd() < 0.30 ? 0.95 + rnd()*0.30 : 0.55 + rnd()*0.34;
      addStone(w * 1.24, hh, depth * (big ? 1.12 : 1), x + w/2, cy, (rnd()-0.5)*0.015, tone);
      if (big) blocked[r + 1].push([x, x + w]);
      x += w * 0.82;
      joints.push({ x, y: cy });
    }
  }
  for (const j of joints){
    if (j.x > len/2 - 0.02) continue;
    const s = size * (0.42 + rnd()*0.24);
    addStone(s*1.3, s*(0.95 + rnd()*0.5), wallDepth*0.55,
             j.x + (rnd()-0.5)*size*0.10, j.y + (rnd()-0.5)*rowH*0.6,
             (rnd()-0.5)*0.02, 0.36 + rnd()*0.16);
  }
  return count;
}

/* 生垣（細かい葉の集まり） */
const LEAF_DENSITY = 520, LEAF_MAX = 16000;
function buildHedge(len, baseY, h, d){
  const rnd = mulberry32(777);
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color(), base = new THREE.Color(0x4a7538), red = new THREE.Color(0x8f5240);
  const n = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), p0 = new THREE.Vector3();
  const UPV = new THREE.Vector3(0,1,0), XV = new THREE.Vector3(1,0,0);
  function leaf(cx, cy, cz, nx, ny, nz, s, up){
    n.set(nx + (rnd()-0.5)*1.1, ny + (rnd()-0.5)*1.1, nz + (rnd()-0.5)*1.1).normalize();
    u.crossVectors(Math.abs(n.y) > 0.9 ? XV : UPV, n);
    if (u.lengthSq() < 1e-6) u.set(1,0,0);
    u.normalize(); v.crossVectors(n, u);
    const a = rnd() * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    const ux = u.x*ca+v.x*sa, uy = u.y*ca+v.y*sa, uz = u.z*ca+v.z*sa;
    const vx = -u.x*sa+v.x*ca, vy = -u.y*sa+v.y*ca, vz = -u.z*sa+v.z*ca;
    const w = s*0.62, t = s, i0 = pos.length/3;
    p0.set(cx, cy, cz);
    const isRed = rnd() < 0.02 + 0.10*up*up;
    const tone = 0.7 + rnd()*0.6;
    c.copy(isRed ? red : base).multiplyScalar(tone);
    if (!isRed) c.offsetHSL((rnd()-0.5)*0.045, 0, 0);
    for (const [a1, b1] of [[-w,-t],[w,-t],[w,t],[-w,t]]){
      pos.push(p0.x + ux*a1 + vx*b1, p0.y + uy*a1 + vy*b1, p0.z + uz*a1 + vz*b1);
      nor.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b);
    }
    idx.push(i0, i0+1, i0+2, i0, i0+2, i0+3);
  }
  const y0 = baseY, y1 = baseY + h, hx = len/2, hz = d/2;
  const faces = [
    { a: len*h, f:(r1,r2,s)=>[-hx + r1*len, y0 + r2*h, s*hz], nx:0, ny:0, nz:1, both:true },
    { a: len*d, f:(r1,r2)=>[-hx + r1*len, y1, -hz + r2*d],     nx:0, ny:1, nz:0 },
    { a: d*h,   f:(r1,r2,s)=>[s*hx, y0 + r2*h, -hz + r1*d],    nx:1, ny:0, nz:0, both:true },
  ];
  let total = 0;
  for (const f of faces) total += f.a * (f.both ? 2 : 1);
  const scale = Math.min(1, LEAF_MAX / (total * LEAF_DENSITY));
  for (const face of faces) for (const sgn of (face.both ? [1,-1] : [1])){
    const cnt = Math.round(face.a * LEAF_DENSITY * scale);
    for (let i = 0; i < cnt; i++){
      const [x, y, z] = face.f(rnd(), rnd(), sgn);
      const off = (rnd()-0.5)*0.09, s = 0.030 + rnd()*0.022;
      const up = THREE.MathUtils.clamp((y - y0) / Math.max(h, 0.01), 0, 1);
      leaf(x + face.nx*sgn*off, y + face.ny*off, z + face.nz*sgn*off,
           face.nx*sgn, face.ny, face.nz*sgn, s, face.ny > 0 ? 1 : up);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* ============================================================
   組み立て
   ============================================================ */
function buildBlockFence(P, len, T, opt = {}){
  const g = new THREE.Group();
  let wallTop = 0;

  if (T.wall && P.courses > 0){
    const w = buildWall(len, P.courses, BLK.thickness, P.finish);
    const useCap = P.cap && !T.fence;
    if (useCap){
      const caps = [];
      buildCap(len, w.height, BLK.thickness + (P.finish === 'stucco' ? 0.02 : 0), caps);
      addMerged(caps, capMat, g);
    }
    const totalH = P.courses * BLK.modY + (T.fence ? P.fenceH : 0) + (useCap ? CAP.h : 0);
    const plan = buttressPlan(len, P.courses, totalH, T.fence);
    buildButtress(len, plan, BLK.thickness, w.blocks, P.side === '奥側' ? -1 : 1, P.finish);
    addMerged(w.joints, jointMat, g);
    addMerged(w.blocks, P.finish === 'stucco' ? stuccoMat : blockMat, g);
    wallTop = w.height + (useCap ? CAP.h : 0);
    g.userData.plan = plan;
  }
  if (T.fence){
    const baseY = T.wall ? wallTop : 0.10;
    const f = buildFence(len, baseY, P.fenceH, P.pitch,
                         P.panel === '縦桟のみ' ? 'vert' : 'grid', opt);
    if (!T.wall){                                   // 独立フェンスは支柱を地面まで伸ばす
      const x0 = -len/2, nSpan = Math.max(1, Math.round(len / P.pitch)), step = len / nSpan;
      for (let i = 0; i <= nSpan; i++){
        if (i === 0 && opt.noStart) continue;
        if (i === nSpan && opt.noEnd) continue;
        box(POST, baseY + 0.01, POST, x0 + step*i, (baseY + 0.01)/2, 0, f.geos);
      }
    }
    addMerged(f.geos, fenceMat(P.fenceColor), g);
    g.userData.top = baseY + P.fenceH;
  } else g.userData.top = wallTop;
  g.userData.len = len;
  return g;
}

function buildStoneHedge(P, len){
  const g = new THREE.Group();
  const wallD = P.stoneH;
  const geos = [];
  buildStone(len, P.stoneH, P.stoneSize, wallD, P.stoneRound, geos);
  const back = [];
  const bh = P.stoneH - 0.06;
  box(Math.max(0.1, len - P.stoneSize*0.9), bh, wallD*0.34, 0, bh/2, 0, back);
  addMerged(back, mortarMat, g);
  addMerged(geos, stoneMat, g);

  const sink = 0.10, baseY = P.stoneH - sink, hh = P.hedgeH + sink;
  const hd = Math.min(P.hedgeD, wallD - 0.06);
  const core = new THREE.Mesh(new THREE.BoxGeometry(len - 0.05, hh - 0.06, hd - 0.05), hedgeCoreMat);
  core.position.y = baseY + hh/2 - 0.01;
  core.castShadow = core.receiveShadow = true;
  g.add(core);
  const hm = new THREE.Mesh(buildHedge(len, baseY, hh, hd), hedgeMat);
  hm.castShadow = hm.receiveShadow = true;
  g.add(hm);
  g.userData.len = len;
  g.userData.top = baseY + hh;
  return g;
}

/* ============================================================
   折れ線に沿って区間を並べ、角を納める
   ・塀／石積：区間を厚みの半分だけ延ばして角の隙間を埋める
   ・フェンス：区間の端の支柱を省き、角には二等分線を向いた支柱を1本立てる
   ============================================================ */
const dirOf = (a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  return { dx: dx / L, dz: dz / L, L };
};

function buildPoly(P, pl, T, seg){
  const g = new THREE.Group();
  const pts = (pl.pts && pl.pts.length > 1) ? pl.pts
            : [{ x: -(pl.length || 4)/2, z: 0 }, { x: (pl.length || 4)/2, z: 0 }];
  const n = pts.length - 1;
  /* 角を埋めるための延長量 */
  const ext = T.stone ? Math.min(P.stoneH, P.hedgeD) / 2
            : T.wall  ? (BLK.thickness + (P.finish === 'stucco' ? 0.02 : 0)) / 2
                      : 0;
  const posts = [];

  for (let i = 0; i < n; i++){
    const a = pts[i], b = pts[i+1];
    const { dx, dz, L } = dirOf(a, b);
    if (L < 0.05) continue;
    const es = i > 0 ? ext : 0, ee = i < n - 1 ? ext : 0;
    const sub = seg(L + es + ee, { noStart: i > 0, noEnd: i < n - 1 });
    const off = (ee - es) / 2;                       // 延長したぶん中心をずらす
    sub.position.set((a.x + b.x)/2 + dx*off, 0, (a.z + b.z)/2 + dz*off);
    sub.rotation.y = -Math.atan2(dz, dx);
    g.add(sub);
    if (i === 0) g.userData.top = sub.userData.top;
  }

  /* フェンスの角柱（曲がり角には必ず1本立てる） */
  if (T.fence){
    const baseY = T.wall ? (P.courses * BLK.modY) : 0.10;
    const y0 = T.wall ? baseY : 0;
    const h = (baseY + P.fenceH) - y0;
    for (let i = 1; i < n; i++){
      const p = pts[i];
      const u = dirOf(pts[i-1], p), v = dirOf(p, pts[i+1]);
      let bx = u.dx + v.dx, bz = u.dz + v.dz;         // 二等分線
      if (Math.hypot(bx, bz) < 1e-6){ bx = u.dx; bz = u.dz; }
      const c = box(POST * 1.15, h, POST * 1.15, 0, y0 + h/2, 0, posts);
      c.rotateY(-Math.atan2(bz, bx));
      c.translate(p.x, 0, p.z);
    }
    addMerged(posts, fenceMat(P.fenceColor), g);
  }
  return g;
}

/* ---------- 共通のパラメータ定義 ---------- */
const wallParams = [
  { k:'courses', l:'ブロック段数', min:0, max:8, step:1, def:3,
    fmt:v=>v+' 段（'+(v*BLK.modY).toFixed(2)+'m）' },
];
const fenceParams = [
  { k:'fenceH', l:'フェンス高さ', min:0.30, max:2.00, step:0.05, def:0.60, fmt:m2 },
  { k:'pitch',  l:'支柱ピッチ',   min:1.0,  max:2.5,  step:0.1,  def:2.0,  fmt:v=>v.toFixed(1)+' m' },
];
const wallOpts = [
  { k:'finish', l:'仕上げ', type:'select', values:['ブロック素地','塗り壁（砂壁状）'], def:'ブロック素地' },
  { k:'side',   l:'控壁の向き', type:'select', values:['手前側','奥側'], def:'手前側' },
];
const fenceOpts = [
  { k:'panel', l:'面材', type:'select', values:['縦横桟','縦桟のみ'], def:'縦横桟' },
  { k:'fenceColor', l:'色', type:'select', values:Object.keys(FENCE_COLORS), def:'シルバー' },
];
const norm = P => ({ ...P, finish: P.finish === '塗り壁（砂壁状）' ? 'stucco' : 'block' });

const lenInfo = pl => `L=${(pl.length || 0).toFixed(2)}m` +
  (pl.corners ? `（${pl.corners} 箇所で折れ）` : '');

export default {
  group: '囲い',
  items: [
    {
      id: 'wall_fence', name: 'ブロック塀＋フェンス', place: 'poly',
      params: [...wallParams, ...fenceParams],
      options: [...wallOpts, ...fenceOpts],
      build: (P, pl) => { const p = norm(P), T = { wall:true, fence:true };
        return buildPoly(p, pl, T, (L, o) => buildBlockFence(p, L, T, o)); },
      info: (P, pl) => `${lenInfo(pl)} ／ 総高 ${(P.courses*BLK.modY + P.fenceH).toFixed(2)}m`,
    },
    {
      id: 'wall', name: 'ブロック塀のみ', place: 'poly',
      params: wallParams,
      options: [{ k:'cap', l:'笠木瓦をのせる', type:'check', def:false }, ...wallOpts],
      build: (P, pl) => { const p = norm(P), T = { wall:true, fence:false };
        return buildPoly(p, pl, T, (L, o) => buildBlockFence(p, L, T, o)); },
      info: (P, pl) => `${lenInfo(pl)} ／ 高さ ${(P.courses*BLK.modY).toFixed(2)}m`,
    },
    {
      id: 'fence', name: 'フェンスのみ', place: 'poly',
      params: fenceParams,
      options: fenceOpts,
      build: (P, pl) => { const p = norm(P), T = { wall:false, fence:true };
        return buildPoly(p, pl, T, (L, o) => buildBlockFence(p, L, T, o)); },
      info: (P, pl) => `${lenInfo(pl)} ／ 高さ ${P.fenceH.toFixed(2)}m`,
    },
    {
      id: 'stone_hedge', name: '石積＋生垣', place: 'poly',
      params: [
        { k:'stoneH',    l:'石積の高さ',   min:0.40, max:0.80, step:0.05, def:0.60, fmt:v=>v.toFixed(2)+' m（奥行も同寸）' },
        { k:'stoneSize', l:'石の大きさ',   min:0.20, max:0.50, step:0.01, def:0.35, fmt:v=>Math.round(v*1000)+' mm' },
        { k:'stoneRound',l:'石の丸み',     min:0,    max:1,    step:0.05, def:0.85, fmt:v=>v.toFixed(2) },
        { k:'hedgeH',    l:'生垣の高さ',   min:0.80, max:1.20, step:0.05, def:1.00, fmt:m2 },
        { k:'hedgeD',    l:'生垣の奥行',   min:0.35, max:0.50, step:0.01, def:0.40, fmt:m2 },
      ],
      build: (P, pl) => buildPoly(P, pl, { stone:true, hedge:true }, L => buildStoneHedge(P, L)),
      info: (P, pl) => `${lenInfo(pl)} ／ 総高 ${(P.stoneH + P.hedgeH).toFixed(2)}m`,
    },
  ],
};

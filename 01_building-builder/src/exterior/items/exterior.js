/* ============================================================
   外構：カーポート／機能門柱／車（car.obj）
   exterior.html の生成コードを部品化したもの
   ============================================================ */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { box, addMerged } from '../util/geom.js';
import { rebuildAll } from '../core/store.js';

const mm = v => Math.round(v * 1000) + ' mm';
const m2 = v => v.toFixed(2) + ' m';

/* ---------- マテリアル ---------- */
const FRAME_COLORS = { 'ダークブロンズ':0x413a33, 'ブラック':0x2b2c2e, 'ブラウン':0x6a5847,
                       'シャイングレー':0xa8a8a3, 'ホワイト':0xe6e4de };
const ROOF_COLORS  = { 'クリアマット':[0xdfe7ea,0.30], 'ブルースモーク':[0x9fc0d6,0.34],
                       'ブロンズ':[0xb59a78,0.38], '熱線遮断ブルー':[0xb9cfd4,0.32] };
const BODY_COLORS  = { 'シャンパン':0xc9c0b0, 'ホワイト':0xe8e6e0, 'ダークグレー':0x4a4b4d,
                       'ブラック':0x2c2d2f, '木調ブラウン':0x8a6a49 };

const matCache = new Map();
const frameMat = c => cached('f' + c, () => new THREE.MeshStandardMaterial(
  { color: FRAME_COLORS[c], roughness: 0.45, metalness: 0.35 }));
const roofMat  = c => cached('r' + c, () => new THREE.MeshPhysicalMaterial(
  { color: ROOF_COLORS[c][0], transparent: true, opacity: ROOF_COLORS[c][1],
    roughness: 0.35, side: THREE.DoubleSide, depthWrite: false }));
const bodyMat  = c => cached('b' + c, () => new THREE.MeshStandardMaterial(
  { color: BODY_COLORS[c], roughness: 0.45, metalness: 0.25 }));
function cached(k, f){ if (!matCache.has(k)) matCache.set(k, f()); return matCache.get(k); }

const darkMat  = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.5, metalness: 0.3 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xe8f0f2, transparent: true,
                   opacity: 0.45, roughness: 0.25, side: THREE.DoubleSide });
const lampMat  = new THREE.MeshStandardMaterial({ color: 0xfdf3d8, emissive: 0x000000, roughness: 0.4 });
const panelMat = new THREE.MeshStandardMaterial({ color: 0xd8d5cd, roughness: 0.35, metalness: 0.2 });

/* ============================================================
   カーポート
   ============================================================ */
const MEM = { post:{w:.10,d:.10}, beam:{w:.10,h:.15}, raft:{w:.045,h:.07},
              frame:{w:.06,h:.09}, panel:.0025 };

function buildCarport(P){
  const g = new THREE.Group();
  const roofY = t => P.height + MEM.beam.h + 0.02 - P.sag * Math.pow(1 - t, 1.7);
  const xAt   = t => -P.width / 2 + P.width * t;
  const F = [];
  const halfD = P.depth / 2, halfW = P.width / 2;
  const postX = halfW - P.eave;

  /* アールに沿った部材 */
  const curvedBar = (w, h, z, out, seg = 16) => {
    for (let i = 0; i < seg; i++){
      const t0 = i / seg, t1 = (i + 1) / seg;
      const x0 = xAt(t0), x1 = xAt(t1), y0 = roofY(t0), y1 = roofY(t1);
      const dx = x1 - x0, dy = y1 - y0;
      const bg = new THREE.BoxGeometry(Math.hypot(dx, dy) * 1.02, h, w);
      bg.rotateZ(Math.atan2(dy, dx));
      bg.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
      out.push(bg);
    }
  };

  for (const z of [-halfD + P.postIn, halfD - P.postIn]){
    box(MEM.post.w, P.height, MEM.post.d, postX, P.height / 2, z, F);
    box(MEM.post.w + 0.06, 0.02, MEM.post.d + 0.06, postX, 0.01, z, F);
    const br = 0.28;                                      // 方杖
    const bg = new THREE.BoxGeometry(br * 1.42, 0.05, MEM.post.d * 0.8);
    bg.rotateZ(-Math.PI / 4);
    bg.translate(postX - br / 2, P.height - br / 2, z);
    F.push(bg);
  }
  box(MEM.beam.w, MEM.beam.h, P.depth, postX, P.height + MEM.beam.h / 2, 0, F);

  const n = Math.max(2, Math.round(P.depth / P.pitch));
  for (let i = 0; i <= n; i++) curvedBar(MEM.raft.w, MEM.raft.h, -halfD + (P.depth / n) * i, F);
  box(MEM.frame.w, MEM.frame.h, P.depth, xAt(0), roofY(0), 0, F);
  box(MEM.frame.w, MEM.frame.h, P.depth, xAt(1), roofY(1), 0, F);
  for (const z of [-halfD, halfD]) curvedBar(MEM.frame.w, MEM.frame.h * 0.7, z, F);
  addMerged(F, frameMat(P.frameColor), g);

  /* 屋根パネル（アール面） */
  const seg = 24, pos = [], nor = [], idx = [];
  for (let i = 0; i <= seg; i++){
    const t = i / seg, x = xAt(t), y = roofY(t) + MEM.raft.h * 0.5;
    const t2 = Math.min(1, t + 0.001);
    const nx = -(roofY(t2) - y), ny = (xAt(t2) - x), nl = Math.hypot(nx, ny) || 1;
    for (const z of [-halfD, halfD]){ pos.push(x, y, z); nor.push(nx/nl, ny/nl, 0); }
  }
  for (let i = 0; i < seg; i++){
    const a = i * 2; idx.push(a, a+1, a+2, a+1, a+3, a+2);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  pg.setAttribute('normal',   new THREE.Float32BufferAttribute(nor, 3));
  pg.setIndex(idx);
  g.add(new THREE.Mesh(pg, roofMat(P.roofColor)));
  return g;
}

/* ============================================================
   機能門柱
   ============================================================ */
function mailboxGeometry(w, h, d){
  const slope = 0.055, hw = w / 2, hd = d / 2;
  const v = [[-hw,0,-hd],[hw,0,-hd],[hw,0,hd],[-hw,0,hd],
             [-hw,h,-hd],[hw,h,-hd],[hw,h-slope,hd],[-hw,h-slope,hd]];
  const faces = [[0,1,2,3],[7,6,5,4],[4,5,1,0],[3,2,6,7],[0,3,7,4],[2,1,5,6]];
  const pos = [], nor = [], idx = [];
  for (const f of faces){
    const a = v[f[0]], b = v[f[1]], c = v[f[2]];
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const nl = Math.hypot(nx,ny,nz) || 1;
    const i0 = pos.length / 3;
    for (const k of f){ pos.push(...v[k]); nor.push(nx/nl, ny/nl, nz/nl); }
    idx.push(i0, i0+1, i0+2, i0, i0+2, i0+3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function buildGatepost(P){
  const g = new THREE.Group();
  const B = [], D = [], G = [], L = [], PL = [];
  const pw = P.postW, pd = P.postD, ph = P.postH, front = pd / 2;

  box(pw, ph, pd, 0, ph / 2, 0, B);
  box(pw + 0.02, 0.012, pd + 0.02, 0, 0.006, 0, B);

  const lh = P.lamp ? Math.min(P.lampH, ph * 0.3) : 0;
  if (P.lamp){
    const gl = 0.014;
    box(pw + 0.004, lh - gl, pd + 0.004, 0, ph - (lh - gl) / 2, 0, D);
    box(pw + 0.002, gl, pd + 0.002, 0, ph - lh + gl / 2, 0, L);
  }
  if (P.sign){
    const y = ph - lh - 0.02 - P.signH / 2;
    box(pw * 0.90, P.signH + 0.02, 0.004, 0, y, front + 0.001, PL);
    box(pw * 0.86, P.signH, 0.008, 0, y, front + 0.005, G);
  }
  if (P.phone){
    const w = Math.min(0.100, pw * 0.7), h = 0.135;
    box(w + 0.012, h + 0.012, 0.012, 0, P.phoneY, front + 0.006, PL);
    box(w, h, 0.016, 0, P.phoneY, front + 0.010, D);
    box(w * 0.55, h * 0.26, 0.006, 0, P.phoneY + h * 0.22, front + 0.019, PL);
    box(w * 0.30, w * 0.30, 0.006, 0, P.phoneY - h * 0.26, front + 0.019, PL);
  }
  const bz = front + 0.085 - P.boxD / 2, boxY = P.boxTop - P.boxH;
  const mb = mailboxGeometry(P.boxW, P.boxH, P.boxD);
  mb.translate(0, boxY, bz);
  const mesh = new THREE.Mesh(mb, bodyMat(P.bodyColor));
  mesh.castShadow = mesh.receiveShadow = true;
  g.add(mesh);
  box(P.boxW * 0.98, 0.006, P.boxD * 0.98, 0, P.boxTop - 0.035, bz, D);
  box(P.boxW * 0.55, 0.010, 0.006, 0, boxY + P.boxH * 0.30, bz + P.boxD/2 + 0.002, D);

  addMerged(B, bodyMat(P.bodyColor), g);
  addMerged(D, darkMat, g);
  addMerged(G, glassMat, g, false);
  addMerged(PL, panelMat, g);
  addMerged(L, lampMat, g, false);
  lampMat.emissive.setHex(P.lampOn ? 0xffe9b0 : 0x000000);
  return g;
}

/* ============================================================
   車（car.obj をそのまま読み込む）
   ============================================================ */
const CAR_SIZE = { L: 3.450, W: 1.540, H: 1.411 };
const carBodyMat  = new THREE.MeshStandardMaterial({ color: 0xb6bcc0, roughness: 0.30, metalness: 0.55 });
const carGlassMat = new THREE.MeshStandardMaterial({ color: 0x2b3540, roughness: 0.12, metalness: 0.55 });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.9 });
const rimMat  = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, roughness: 0.35, metalness: 0.7 });
const headMat = new THREE.MeshStandardMaterial({ color: 0xeff3f4, emissive: 0x0e1418, roughness: 0.12 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x8d1f24, emissive: 0x2a0507, roughness: 0.12 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x25272a, roughness: 0.55 });
const OBJ_MAT = n =>
  /glass/i.test(n) ? carGlassMat : /tire/i.test(n) ? tireMat :
  /metal/i.test(n) ? rimMat : /^plt/i.test(n) ? headMat :
  /Color_A06|Color_D01/i.test(n) ? tailMat :
  /Black_Plastic|grill|Gray8/i.test(n) ? trimMat : carBodyMat;

let carRoot = null, carState = 'idle';
function loadCar(){
  if (carState !== 'idle') return;
  carState = 'loading';
  /* ★変更：本体アプリ（Vite）では public/car.obj として配られるので、
     公開ベース（GitHub Pages のサブフォルダ配下でも正しくなる）を前に付ける */
  new OBJLoader().load(import.meta.env.BASE_URL + 'car.obj', root => {
    root.traverse(o => {
      if (!o.isMesh) return;
      const pick = m => OBJ_MAT(m && m.name || '');
      o.material = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
      o.geometry.translate(-9863.9, 0, 5914.65);     // 車体中心を原点へ（mm）
      o.geometry.scale(0.001, 0.001, 0.001);
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    });
    carRoot = root; carState = 'ready';
    rebuildAll();                                    // 読み込めたら置いてある車を作り直す
  }, undefined, () => { carState = 'error'; });
}

function buildCar(P){
  const g = new THREE.Group();
  if (carState === 'idle') loadCar();
  if (carState !== 'ready'){
    /* 読み込み中は目安の箱を出しておく */
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(P.carW, P.carH, P.carL),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.35 }));
    b.position.y = P.carH / 2;
    g.add(b);
    return g;
  }
  const inst = carRoot.clone();
  inst.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    o.userData.shared = true;                        // ジオメトリは共有（破棄しない）
  });
  inst.scale.set(P.carW / CAR_SIZE.W, P.carH / CAR_SIZE.H, P.carL / CAR_SIZE.L);
  g.add(inst);
  return g;
}

/* ============================================================
   カタログ登録
   ============================================================ */
export default {
  group: '外構',
  items: [
    {
      id: 'carport', name: 'カーポート', place: 'point', rotatable: true,
      params: [
        { k:'width',  l:'屋根幅',   min:1.8, max:4.0, step:0.05, def:2.7, fmt:m2 },
        { k:'depth',  l:'屋根奥行', min:3.0, max:9.0, step:0.1,  def:6.0, fmt:m2 },
        { k:'height', l:'柱の高さ', min:1.8, max:3.0, step:0.05, def:2.2, fmt:v=>m2(v)+'（梁下）' },
        { k:'sag',    l:'屋根の反り', min:0, max:0.7, step:0.01, def:0.35, fmt:mm },
        { k:'pitch',  l:'垂木ピッチ', min:0.3, max:1.0, step:0.05, def:0.6, fmt:mm },
        { k:'postIn', l:'柱の控え', min:0.2, max:2.0, step:0.05, def:0.7, fmt:mm },
        { k:'eave',   l:'柱側の出', min:0, max:0.6, step:0.05, def:0.15, fmt:mm },
      ],
      options: [
        { k:'frameColor', l:'フレーム色', type:'select', values:Object.keys(FRAME_COLORS), def:'ダークブロンズ' },
        { k:'roofColor',  l:'屋根材',     type:'select', values:Object.keys(ROOF_COLORS),  def:'クリアマット' },
      ],
      build: buildCarport,
      info: P => `屋根 ${P.width.toFixed(2)} × ${P.depth.toFixed(1)} m ＝ ${(P.width*P.depth).toFixed(1)} m²`,
    },
    {
      id: 'gatepost', name: '機能門柱', place: 'point', rotatable: true,
      params: [
        { k:'postW', l:'柱の幅',   min:0.10, max:0.30, step:0.005, def:0.150, fmt:mm },
        { k:'postD', l:'柱の奥行', min:0.10, max:0.30, step:0.005, def:0.165, fmt:mm },
        { k:'postH', l:'柱の高さ', min:1.20, max:2.00, step:0.01,  def:1.550, fmt:mm },
        { k:'boxW',  l:'郵便受け 幅',   min:0.25, max:0.50, step:0.005, def:0.370, fmt:mm },
        { k:'boxH',  l:'郵便受け 高さ', min:0.25, max:0.60, step:0.005, def:0.420, fmt:mm },
        { k:'boxD',  l:'郵便受け 奥行', min:0.15, max:0.40, step:0.005, def:0.245, fmt:mm },
        { k:'boxTop',l:'郵便受け 上端', min:0.70, max:1.40, step:0.01,  def:1.080, fmt:mm },
        { k:'lampH', l:'照明の高さ',   min:0.05, max:0.30, step:0.005, def:0.150, fmt:mm },
        { k:'signH', l:'サインの高さ', min:0.05, max:0.20, step:0.005, def:0.090, fmt:mm },
        { k:'phoneY',l:'インターホン高さ', min:0.90, max:1.60, step:0.01, def:1.180, fmt:mm },
      ],
      options: [
        { k:'lamp',   l:'照明',         type:'check', def:true },
        { k:'sign',   l:'ガラスサイン', type:'check', def:true },
        { k:'phone',  l:'インターホン', type:'check', def:true },
        { k:'lampOn', l:'照明を点灯',   type:'check', def:false },
        { k:'bodyColor', l:'本体色', type:'select', values:Object.keys(BODY_COLORS), def:'シャンパン' },
      ],
      build: buildGatepost,
      info: P => `柱 ${mm(P.postW)} × ${mm(P.postD)} ／ 地上高 ${mm(P.postH)}`,
    },
    {
      id: 'car', name: '車（car.obj）', place: 'point', rotatable: true,
      params: [
        { k:'carL', l:'全長', min:2.80, max:5.40, step:0.01, def:3.45, fmt:m2 },
        { k:'carW', l:'全幅', min:1.30, max:2.00, step:0.01, def:1.54, fmt:m2 },
        { k:'carH', l:'全高', min:1.15, max:2.10, step:0.01, def:1.41, fmt:m2 },
      ],
      build: buildCar,
      info: P => carState === 'ready'
        ? `car.obj ／ ${P.carL.toFixed(2)} × ${P.carW.toFixed(2)} × ${P.carH.toFixed(2)} m`
        : carState === 'error' ? 'car.obj を読み込めません' : 'car.obj 読み込み中…',
    },
  ],
};

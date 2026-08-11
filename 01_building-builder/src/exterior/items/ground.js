/* ============================================================
   地面：芝生／アスファルト／コンクリート／砂利
   ground3d.html の生成コードを部品化したもの。範囲は引いた矩形から決まる
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/geom.js';
import { thin } from '../util/quality.js';   // ★追加：ドラッグ中は葉・粒の数を間引く

const MAX_BLADES = 60000, MAX_GRAINS = 60000;
const SLIT_W = 0.10;

const GREENS = { '青草（濃いめ）':0x6a9c4e, '若草':0x86b45c, '夏芝（黄緑）':0x9dbd55, '冬枯れ':0xb5ac74 };
const PAVE = {
  asphalt:  { base:0xb4b3b8, grain:0.020, dens:2000, joint:0,   bright:1.00, gcol:[0x8f9095,0x4c4d50], flat:0.45 },
  concrete: { base:0xdedbd2, grain:0.010, dens:700,  joint:3.0, bright:1.20, gcol:[0xe8e3d6,0xaba79c], flat:0.40 },
  gravel:   { base:0xc9c2b4, grain:0.030, dens:1500, joint:0,   bright:1.00, gcol:[0xcac2b1,0x8d8677], flat:0.72 },
};

/* ---------- テクスチャ・マテリアル ---------- */
function soilTexture(){
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7d674f'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 3500; i++){
    const v = 90 + Math.random() * 95;
    g.fillStyle = `rgba(${(v+26)|0},${(v+10)|0},${v|0},${0.15 + Math.random()*0.4})`;
    g.fillRect(Math.random()*128, Math.random()*128, 1 + Math.random()*2.5, 1 + Math.random()*2.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function paveTexture(kind){
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const cfg = { asphalt:{bg:'#605f63',n:9000,lo:70,hi:135,dot:2.2},
                concrete:{bg:'#c9c6bd',n:5000,lo:170,hi:225,dot:2.6},
                gravel:{bg:'#b4ada0',n:7000,lo:130,hi:205,dot:3.0} }[kind];
  g.fillStyle = cfg.bg; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < cfg.n; i++){
    const v = cfg.lo + Math.random() * (cfg.hi - cfg.lo);
    g.fillStyle = `rgba(${v|0},${(v-2)|0},${(v-6)|0},${0.12 + Math.random()*0.35})`;
    g.fillRect(Math.random()*256, Math.random()*256, 1 + Math.random()*cfg.dot, 1 + Math.random()*cfg.dot);
  }
  if (kind === 'concrete'){
    g.globalAlpha = 0.07;
    for (let i = 0; i < 180; i++){
      g.strokeStyle = Math.random() < 0.5 ? '#ffffff' : '#8d8a82';
      g.beginPath(); const y = Math.random()*256;
      g.moveTo(0, y); g.lineTo(256, y + (Math.random()-0.5)*3); g.stroke();
    }
    g.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const paveMaps = { asphalt: paveTexture('asphalt'), concrete: paveTexture('concrete'), gravel: paveTexture('gravel') };
const paveMatBase = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0 });
const grainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9,
                   vertexColors: true, flatShading: true });
const jointMat = new THREE.MeshStandardMaterial({ color: 0x6d6b66, roughness: 1.0 });
const soilMap  = soilTexture();
const soilMat  = new THREE.MeshStandardMaterial({ map: soilMap, color: 0xc0ab90, roughness: 1.0 });
const grassMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });

/* 芝の葉（3節） */
function bladeGeometry(){
  const seg = 3, w = 0.05, bend = 0.35;
  const position = [], normal = [], uv = [], color = [], index = [];
  for (let i = 0; i <= seg; i++){
    const t = i / seg, ww = w * Math.pow(1 - t, 0.7), y = t, z = bend * t * t;
    position.push(-ww, y, z, ww, y, z);
    normal.push(0, 0.82, 0.57, 0, 0.82, 0.57);
    uv.push(0, t, 1, t);
    const c = 0.78 + t * 0.34;
    color.push(c*0.95, c, c*0.85, c*0.95, c, c*0.85);
  }
  for (let i = 0; i < seg; i++){ const a = i*2; index.push(a, a+1, a+2, a+1, a+3, a+2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(color, 3));
  g.setIndex(index);
  return g;
}

/* ============================================================
   芝生
   ============================================================ */
function buildGrass(P, pl){
  const g = new THREE.Group();
  const w = pl.w || 4, d = pl.d || 3;
  const rnd = mulberry32(1234);

  if (P.soil > 0.001){                              // 土の下地
    const bg = new THREE.BoxGeometry(w, P.soil, d);
    bg.translate(0, -P.soil / 2, 0);
    const uv = bg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 0.5, uv.getY(i) * d / 0.5);
    const m = new THREE.Mesh(bg, soilMat);
    m.receiveShadow = true;
    g.add(m);
  }
  if (P.base !== 'なし'){                            // 芝の下地
    const pg = new THREE.PlaneGeometry(w, d);
    pg.rotateX(-Math.PI / 2);
    pg.translate(0, 0.001, 0);
    let mat;
    if (P.base === '土'){
      const uv = pg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 0.5, uv.getY(i) * d / 0.5);
      mat = soilMat;
    } else {
      mat = new THREE.MeshStandardMaterial({ roughness: 1.0 });
      mat.color.set(GREENS[P.green]).multiplyScalar(0.62);
      /* ★この面は土の下地（箱）の上面とわずか 1mm しか離れていない。
         本体アプリのカメラは深度の分解能が粗く、遠くを見るほど前後が決まらずに
         茶色い土が勝ってしまう（カメラの向きで芝が茶色く見える原因）。
         土より強いポリゴンオフセットを与えて、必ずこちらが手前に描かれるようにする。 */
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -12;
    }
    const m = new THREE.Mesh(pg, mat);
    m.receiveShadow = true;
    g.add(m);
  }

  const n = thin(Math.min(MAX_BLADES, Math.round(w * d * P.density)));
  if (n > 0){
    const geo = bladeGeometry();
    const mesh = new THREE.InstancedMesh(geo, grassMat, n);
    mesh.castShadow = false; mesh.receiveShadow = true;      // 芝の影で真っ黒になるのを避ける
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const base = new THREE.Color(GREENS[P.green]), col = new THREE.Color();
    for (let i = 0; i < n; i++){
      const margin = P.height * 0.10;
      const px = (rnd()-0.5) * Math.max(0.05, w - margin*2);
      const pz = (rnd()-0.5) * Math.max(0.05, d - margin*2);
      pos.set(px, 0, pz);
      const reach = P.height * 0.7;
      const ix = (w/2 - Math.abs(px) < reach) ? -Math.sign(px) : 0;
      const iz = (d/2 - Math.abs(pz) < reach) ? -Math.sign(pz) : 0;
      const yaw = (ix || iz) ? Math.atan2(ix, iz) + (rnd()-0.5)*1.1 : rnd()*Math.PI*2;
      e.set((rnd()-0.5)*0.25, yaw, (rnd()-0.5)*0.25);
      q.setFromEuler(e);
      const h = Math.max(0.01, P.height * (1 + (rnd()-0.5)*2*P.variation));
      sc.set(h * (0.8 + rnd()*0.7), h, h);
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
      col.copy(base).offsetHSL((rnd()-0.5)*0.06, (rnd()-0.5)*0.15, (rnd()-0.5)*0.18);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    g.add(mesh);
  }
  /* ★下地の厚みは地盤面より「上」へ積む（芝の面は地盤面 +厚み の高さになる）。
     形は 0 から下へ作ってあるので、まるごと持ち上げれば底が地盤面に揃う。 */
  g.position.y = Math.max(0, P.soil);
  return g;
}

/* ============================================================
   舗装
   ============================================================ */
function buildPavement(kind, P, pl){
  const g = new THREE.Group();
  const w = pl.w || 4, d = pl.d || 3;
  const rnd = mulberry32(1234);
  const cfg = PAVE[kind];
  const th = Math.max(0.01, P.soil);
  const slit = (kind === 'concrete' && P.slit && P.joint > 0.05);

  const mat = paveMatBase.clone();
  mat.map = paveMaps[kind];
  if (kind === 'gravel'){
    mat.color.copy(new THREE.Color(cfg.gcol[0]))
             .lerp(new THREE.Color(cfg.gcol[1]), 0.5).multiplyScalar(P.bright * 1.15);
  } else mat.color.set(cfg.base).multiplyScalar(P.bright);

  const nx = slit ? Math.max(1, Math.ceil(w / P.joint)) : 1;
  const nz = slit ? Math.max(1, Math.ceil(d / P.joint)) : 1;
  const cw = w / nx, cd = d / nz;
  const bx = i => -w/2 + cw*i, bz = i => -d/2 + cd*i;
  const inSlit = (x, z) => {
    if (!slit) return false;
    for (let i = 1; i < nx; i++) if (Math.abs(x - bx(i)) < SLIT_W/2) return true;
    for (let i = 1; i < nz; i++) if (Math.abs(z - bz(i)) < SLIT_W/2) return true;
    return false;
  };

  /* 版 */
  {
    const geos = [];
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++){
      const x0 = bx(ix)   + (ix === 0      ? 0 : SLIT_W/2);
      const x1 = bx(ix+1) - (ix === nx - 1 ? 0 : SLIT_W/2);
      const z0 = bz(iz)   + (iz === 0      ? 0 : SLIT_W/2);
      const z1 = bz(iz+1) - (iz === nz - 1 ? 0 : SLIT_W/2);
      const pw = Math.max(0.02, x1-x0), pd = Math.max(0.02, z1-z0);
      const bgeo = new THREE.BoxGeometry(pw, th, pd);
      const uv = bgeo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i)*pw, uv.getY(i)*pd);
      bgeo.translate((x0+x1)/2, -th/2, (z0+z1)/2);
      geos.push(bgeo);
    }
    const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    if (geos.length > 1) geos.forEach(x => x.dispose());
    const slab = new THREE.Mesh(merged, mat);
    slab.receiveShadow = true; slab.castShadow = true;
    g.add(slab);
  }

  /* スリットの土＋芝 */
  if (slit){
    const soil = new THREE.PlaneGeometry(w, d);
    soil.rotateX(-Math.PI/2);
    soil.translate(0, -th*0.55, 0);
    const suv = soil.attributes.uv;
    for (let i = 0; i < suv.count; i++) suv.setXY(i, suv.getX(i)*w/0.5, suv.getY(i)*d/0.5);
    const sm = new THREE.Mesh(soil, soilMat);
    sm.receiveShadow = true;
    g.add(sm);

    const slitArea = SLIT_W * (d*(nx-1) + w*(nz-1));
    const nBlade = thin(Math.min(20000, Math.round(slitArea * 3000)));
    if (nBlade > 0){
      const geo = bladeGeometry();
      const mesh = new THREE.InstancedMesh(geo, grassMat, nBlade);
      mesh.castShadow = false; mesh.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const pos = new THREE.Vector3(), sc = new THREE.Vector3();
      const base = new THREE.Color(GREENS[P.green]), col = new THREE.Color();
      let placed = 0, guard = 0;
      while (placed < nBlade && guard < nBlade * 40){
        guard++;
        const x = (rnd()-0.5)*w, z = (rnd()-0.5)*d;
        if (!inSlit(x, z)) continue;
        const h = Math.max(0.01, (P.slitH || 0.10) * (1 + (rnd()-0.5)*0.7));
        pos.set(x, -th*0.5 + 0.002, z);
        e.set((rnd()-0.5)*0.3, rnd()*Math.PI*2, (rnd()-0.5)*0.3);
        q.setFromEuler(e);
        sc.set(h*(0.8 + rnd()*0.7), h, h);
        m.compose(pos, q, sc);
        mesh.setMatrixAt(placed, m);
        col.copy(base).offsetHSL((rnd()-0.5)*0.06, (rnd()-0.5)*0.15, (rnd()-0.5)*0.18);
        mesh.setColorAt(placed, col);
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      g.add(mesh);
    }
  }

  /* 伸縮目地 */
  if (!slit && P.joint > 0.05){
    const geos = [], gw = 0.008;
    for (let x = -w/2 + P.joint; x < w/2 - 0.01; x += P.joint){
      const bgeo = new THREE.BoxGeometry(gw, 0.004, d);
      bgeo.translate(x, -0.001, 0); geos.push(bgeo);
    }
    for (let z = -d/2 + P.joint; z < d/2 - 0.01; z += P.joint){
      const bgeo = new THREE.BoxGeometry(w, 0.004, gw);
      bgeo.translate(0, -0.001, z); geos.push(bgeo);
    }
    if (geos.length){
      const merged = mergeGeometries(geos, false);
      geos.forEach(x => x.dispose());
      g.add(new THREE.Mesh(merged, jointMat));
    }
  }

  /* 粒（骨材・砂利） */
  const n = thin(Math.min(MAX_GRAINS, Math.round(w * d * P.gdens)));
  if (n > 0){
    const geo = kind === 'gravel' ? new THREE.IcosahedronGeometry(0.5, 0)
                                  : new THREE.OctahedronGeometry(0.5, 0);
    const vc = new Float32Array(geo.attributes.position.count * 3).fill(1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
    const mesh = new THREE.InstancedMesh(geo, grainMat, n);
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const c1 = new THREE.Color(cfg.gcol[0]), c2 = new THREE.Color(cfg.gcol[1]), col = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < n; i++){
      const s = P.grain * (0.65 + rnd()*0.8), mg = s * 0.5;
      let x = 0, z = 0, ok = false;
      for (let t = 0; t < 6 && !ok; t++){
        x = (rnd()-0.5) * Math.max(0.02, w - mg*2);
        z = (rnd()-0.5) * Math.max(0.02, d - mg*2);
        ok = !inSlit(x, z);
      }
      if (!ok) continue;
      pos.set(x, kind === 'gravel' ? s*(0.18 + rnd()*0.22) : s*(rnd()*0.16 - 0.02), z);
      e.set(rnd()*3.14, rnd()*3.14, rnd()*3.14);
      q.setFromEuler(e);
      sc.set(s*(0.8 + rnd()*0.5), s*cfg.flat*(0.8 + rnd()*0.5), s*(0.8 + rnd()*0.5));
      m.compose(pos, q, sc);
      mesh.setMatrixAt(placed, m);
      col.copy(c1).lerp(c2, rnd()).multiplyScalar(P.bright);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    g.add(mesh);
  }
  /* ★舗装厚も地盤面より「上」へ積む（舗装面は地盤面 +舗装厚 の高さになる） */
  g.position.y = th;
  return g;
}

/* ---------- カタログ ---------- */
const areaInfo = pl => `${(pl.w||0).toFixed(1)} × ${(pl.d||0).toFixed(1)} m ＝ ${((pl.w||0)*(pl.d||0)).toFixed(1)} m²`;
const paveItem = (id, name, kind, extraOpts = []) => ({
  id, name, place: 'rect',
  params: [
    { k:'bright', l:'明るさ', min:0.6, max:1.6, step:0.02, def:PAVE[kind].bright, fmt:v=>'×'+v.toFixed(2) },
    { k:'grain',  l:'粒の大きさ', min:0.003, max:0.05, step:0.001, def:PAVE[kind].grain, fmt:v=>Math.round(v*1000)+' mm' },
    { k:'gdens',  l:'粒の密度', min:100, max:4000, step:50, def:PAVE[kind].dens, fmt:v=>Math.round(v)+' 個/m²' },
    { k:'joint',  l:'目地の間隔', min:0, max:6, step:0.5, def:PAVE[kind].joint, fmt:v=>v < 0.05 ? 'なし' : v.toFixed(1)+' m' },
    /* ★厚みは地盤面より上へ積むので、この値がそのまま舗装面の高さ（GL＋）になる */
    { k:'soil',   l:'舗装厚', min:0.02, max:0.20, step:0.01, def:0.10, fmt:v=>'GL＋'+Math.round(v*1000)+' mm' },
  ],
  options: extraOpts,
  build: (P, pl) => buildPavement(kind, P, pl),
  info: (P, pl) => areaInfo(pl),
});

export default {
  group: '地面',
  items: [
    {
      id: 'grass', name: '芝生', place: 'rect',
      params: [
        { k:'height',    l:'芝丈',       min:0.02, max:0.20, step:0.005, def:0.06, fmt:v=>Math.round(v*1000)+' mm' },
        { k:'density',   l:'密度',       min:60, max:3000, step:20, def:900, fmt:v=>Math.round(v)+' 株/m²' },
        { k:'variation', l:'丈のばらつき', min:0, max:0.8, step:0.05, def:0.35, fmt:v=>Math.round(v*100)+' %' },
        /* ★厚みは地盤面より上へ積むので、この値がそのまま芝の面の高さ（GL＋）になる */
        { k:'soil',      l:'下地の厚み', min:0, max:0.20, step:0.01, def:0.10, fmt:v=>'GL＋'+Math.round(v*1000)+' mm' },
      ],
      options: [
        { k:'green', l:'芝の色', type:'select', values:Object.keys(GREENS), def:'青草（濃いめ）' },
        { k:'base',  l:'下地',   type:'select', values:['芝マット（緑）','土','なし'], def:'芝マット（緑）' },
      ],
      build: buildGrass,
      info: (P, pl) => areaInfo(pl),
    },
    paveItem('asphalt', 'アスファルト舗装', 'asphalt'),
    paveItem('concrete', 'コンクリート舗装', 'concrete', [
      { k:'slit',  l:'スリットグリーン', type:'check', def:false },
      { k:'green', l:'芝の色', type:'select', values:Object.keys(GREENS), def:'青草（濃いめ）' },
    ]),
    paveItem('gravel', '砂利舗装', 'gravel'),
  ],
};
/* スリットの芝丈はコンクリートの標準値を使う */
export const SLIT_HEIGHT = 0.10;

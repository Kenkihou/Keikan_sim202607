/* ============================================================
   共有ジオメトリ・ユーティリティ
   各地物モジュールから使う小道具をまとめたもの
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* 決定的な擬似乱数（同じ種なら毎回同じ形） */
export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* 箱を1つ作って配列へ積む */
export function box(w, h, d, x, y, z, out){
  const g = new THREE.BufferGeometry().copy(new THREE.BoxGeometry(w, h, d));
  g.translate(x, y, z);
  out.push(g);
  return g;
}

/* 配列のジオメトリを1つのメッシュにまとめて親に足す。戻り値は三角形数 */
export function addMerged(geos, mat, parent, cast = true){
  if (!geos.length) return 0;
  const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
  if (geos.length > 1) geos.forEach(g => g.dispose());
  const m = new THREE.Mesh(merged, mat);
  m.castShadow = cast; m.receiveShadow = true;
  parent.add(m);
  return merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
}

/* UV を貼り直す（テクスチャの繰り返し用） */
export function scaleUV(geo, su, sv){
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/* 頂点色を一色で入れる（InstancedMesh を使わない色ばらつき用） */
export function setColorAttr(g, c){
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ arr[i*3] = c.r; arr[i*3+1] = c.g; arr[i*3+2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/* 頂点を少し揺らす（自然物のばらつき） */
export function jitter(g, ax, ay, az, rnd, keepY = false){
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++){
    const y = p.getY(i);
    if (keepY && y < 1e-4) continue;
    p.setXYZ(i, p.getX(i) + (rnd()-0.5)*ax, y + (rnd()-0.5)*ay, p.getZ(i) + (rnd()-0.5)*az);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/* グループ内のジオメトリを破棄して空にする */
export function disposeGroup(g){
  /* userData.shared のジオメトリは他とも共有しているので捨てない */
  g.traverse(o => { if (o.isMesh && !o.userData.shared) o.geometry.dispose(); });
  g.clear();
}

/* 三角形数を数える */
export function triCount(g){
  let n = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const c = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
    n += c * (o.isInstancedMesh ? o.count : 1);
  });
  return n;
}

/* --- よく使う手続きテクスチャ --- */
export function noiseTexture(size, base, spots, spotColor, alpha = 0.25){
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  const rnd = mulberry32(7);
  for (let i = 0; i < spots; i++){
    const x = rnd() * size, y = rnd() * size, r = 0.5 + rnd() * 2.2;
    g.globalAlpha = alpha * (0.4 + rnd() * 0.6);
    g.fillStyle = spotColor;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

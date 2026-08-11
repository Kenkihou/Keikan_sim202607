/* ============================================================
   配置した地物の管理（追加・再生成・選択・削除）
   ============================================================ */
import * as THREE from 'three';
import { world, scene } from './viewer.js';
import { disposeGroup, triCount } from '../util/geom.js';

export const items = [];
let uid = 0;
let selected = null;
let boxHelper = null;
const listeners = [];

export function onChange(fn){ listeners.push(fn); }
function emit(){ listeners.forEach(f => f()); }

/* 定義から初期パラメータを作る */
export function defaultParams(def){
  const p = {};
  for (const c of def.params || []) p[c.k] = c.def;
  for (const o of def.options || []) p[o.k] = o.def;
  return p;
}

/* 追加。pts は place に応じて 1点（point）／2点（line・rect）／2点以上（poly） */
export function addItem(def, pts){
  const rec = {
    uid: ++uid, def, params: defaultParams(def),
    pts: pts.map(p => ({ x: p.x, z: p.z })),
    rot: 0,
    obj: new THREE.Group(),
  };
  rec.obj.userData.item = rec;
  world.add(rec.obj);
  items.push(rec);
  build(rec);
  emit();
  return rec;
}

/* 配置情報から寸法と姿勢を求める */
export function placementOf(rec){
  const { def, pts } = rec;
  const a = pts[0], b = pts[1];
  if (def.place === 'line' && b){
    const dx = b.x - a.x, dz = b.z - a.z;
    return {
      length: Math.hypot(dx, dz),
      cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2,
      /* rotation.y は +X を -Z 方向へ回すので、線の方位角は符号を反転して渡す */
      ry: -Math.atan2(dz, dx),
    };
  }
  if (def.place === 'rect' && b){
    return {
      w: Math.max(Math.abs(b.x - a.x), 0.5),
      d: Math.max(Math.abs(b.z - a.z), 0.5),
      cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, ry: 0,
    };
  }
  if (def.place === 'poly'){
    /* 重心を原点にして、折れ線をローカル座標で渡す（回転は使わない） */
    let cx = 0, cz = 0;
    for (const p of pts){ cx += p.x; cz += p.z; }
    cx /= pts.length; cz /= pts.length;
    const local = pts.map(p => ({ x: p.x - cx, z: p.z - cz }));
    let length = 0;
    for (let i = 1; i < local.length; i++)
      length += Math.hypot(local[i].x - local[i-1].x, local[i].z - local[i-1].z);
    return { pts: local, length, corners: Math.max(0, pts.length - 2), cx, cz, ry: 0 };
  }
  return { cx: a.x, cz: a.z, ry: THREE.MathUtils.degToRad(rec.rot) };
}

/* 形をつくり直す */
export function build(rec){
  disposeGroup(rec.obj);
  const pl = placementOf(rec);
  const g = rec.def.build(rec.params, pl);
  if (g) rec.obj.add(g);
  rec.obj.position.set(pl.cx, 0, pl.cz);
  rec.obj.rotation.y = pl.ry;
  rec.tris = triCount(rec.obj);
  if (selected === rec) refreshHelper();
}

export function rebuildAll(){ items.forEach(build); emit(); }

export function removeItem(rec){
  const i = items.indexOf(rec);
  if (i < 0) return;
  items.splice(i, 1);
  disposeGroup(rec.obj);
  world.remove(rec.obj);
  if (selected === rec) select(null);
  emit();
}

export function clearAll(){
  [...items].forEach(removeItem);
}

/* 種類を差し替える（同じ場所のまま別の地物へ） */
export function swapDef(rec, def){
  rec.def = def;
  rec.params = defaultParams(def);
  build(rec);
  emit();
}

export function select(rec){
  selected = rec;
  refreshHelper();
  emit();
}
export function getSelected(){ return selected; }

function refreshHelper(){
  if (boxHelper){ scene.remove(boxHelper); boxHelper.geometry.dispose(); boxHelper = null; }
  if (!selected) return;
  boxHelper = new THREE.BoxHelper(selected.obj, 0xff8a3d);
  boxHelper.material.depthTest = false;
  boxHelper.renderOrder = 9;
  scene.add(boxHelper);
}

export function totalTris(){
  return items.reduce((s, r) => s + (r.tris || 0), 0);
}

/* ============================================================
   配置した外構地物の管理（追加・再生成・選択・削除・保存）

   tree/planner.html の js/core/store.js を移植したもの。
   違いは単位だけ：pts は m のまま持ち、シーンへ置くときに
   「地物のグループ自体を 1000倍」して mm 空間に合わせる。
   ============================================================ */
import * as THREE from 'three';
import { world, getScene, render, MM } from './viewer.js';
import { itemById } from '../catalog.js';
import { disposeGroup, triCount } from '../util/geom.js';
import { isDraft } from '../util/quality.js';

export const items = [];
let uid = 0;
let selected = null;
let boxHelper = null;
const listeners = [];

export function onChange(fn){ listeners.push(fn); }
function emit(){ listeners.forEach(f => f()); render(); }

/* 定義から初期パラメータを作る */
export function defaultParams(def){
  const p = {};
  for (const c of def.params || []) p[c.k] = c.def;
  for (const o of def.options || []) p[o.k] = o.def;
  return p;
}

/* 追加。pts は place に応じて 1点（point）／2点（line・rect）／2点以上（poly）。単位は m */
export function addItem(def, pts, opts = {}){
  const rec = {
    uid: ++uid, def, params: { ...defaultParams(def), ...(opts.params || {}) },
    pts: pts.map(p => ({ x: p.x, z: p.z })),
    rot: opts.rot || 0,
    obj: new THREE.Group(),
  };
  /* ★ userData.item は「列挙されない」形で持たせる。
     GLTFExporter は userData を JSON 化して glTF の extras に書き込むが、
     rec は rec.obj を参照し返す循環構造なので、そのまま持たせると
     書き出しのたびに警告が出る（子アプリへ渡す GLB に含める意味もない）。 */
  Object.defineProperty(rec.obj.userData, 'item', { value: rec, enumerable: false, writable: true });
  rec.obj.scale.setScalar(MM);            // ★ m で作られた形を mm 空間へ
  world.add(rec.obj);
  items.push(rec);
  build(rec);
  emit();
  return rec;
}

/* 配置情報から寸法と姿勢を求める（すべて m） */
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

/* ★追加：地面ものと本体アプリの方眼（Y = -1mm）の Z ファイト対策

   芝生やアスファルトの面は地盤面（Y = 0 付近）にあり、方眼とは 1〜2mm しか離れていない。
   本体アプリのカメラは near 1mm / far 1,000,000mm と範囲が極端に広く、20m 先での
   深度の分解能は 20mm 程度しかないため、1mm の差では前後が決まらず縞状にちらつく。
   ポリゴンオフセットは「深度の最小分解能」を単位に手前へずらす仕組みなので、
   遠近によらず確実に方眼より手前に描ける（線には効かないので面側をずらす）。 */
function applyGroundPolygonOffset(rec){
  if (rec.def.group !== '地面') return;
  rec.obj.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats){
      if (!m || m.polygonOffset) continue;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -4;
      m.needsUpdate = true;
    }
  });
}

/* 形をつくり直す */
export function build(rec){
  const t0 = performance.now();
  disposeGroup(rec.obj);
  const pl = placementOf(rec);
  const g = rec.def.build(rec.params, pl);
  if (g) rec.obj.add(g);
  rec.obj.position.set(pl.cx * MM, 0, pl.cz * MM);     // ★ m → mm
  rec.obj.rotation.y = pl.ry;
  applyGroundPolygonOffset(rec);
  rec.tris = triCount(rec.obj);
  if (selected === rec) refreshHelper();
  /* ★この地物を作り直すのに何 ms かかるか覚えておく（ドラッグ中に間引くかどうかの判断に使う）。
     間引いた状態の値は当てにならないので、本来の細かさのときだけ更新する。 */
  if (!isDraft()) rec.buildMs = performance.now() - t0;
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

/* ★選択枠は作り直さず使い回す（毎回 new すると芝1枚あたり 7ms ほど食う） */
function refreshHelper(){
  if (!selected){
    if (boxHelper) boxHelper.visible = false;
    return;
  }
  if (!boxHelper){
    boxHelper = new THREE.BoxHelper(selected.obj, 0xff8a3d);
    boxHelper.material.depthTest = false;
    boxHelper.renderOrder = 9;
    getScene().add(boxHelper);
  } else {
    boxHelper.visible = true;
    boxHelper.setFromObject(selected.obj);
  }
}

export function totalTris(){
  return items.reduce((s, r) => s + (r.tris || 0), 0);
}

/* ============================================================
   ★追加：JSON セーブ／ロード用（本体アプリの 💾 📂 と繋ぐ）
   ============================================================ */
export function serialize(){
  return items.map(r => ({
    defId: r.def.id,
    pts: r.pts.map(p => ({ x: p.x, z: p.z })),
    params: { ...r.params },
    rot: r.rot || 0,
  }));
}

export function restore(list){
  clearAll();
  if (!Array.isArray(list)) return;
  for (const d of list){
    const def = itemById(d.defId);
    if (!def || !Array.isArray(d.pts) || !d.pts.length) continue;   // 知らない地物は読み飛ばす
    addItem(def, d.pts, { params: d.params, rot: d.rot });
  }
  select(null);
}

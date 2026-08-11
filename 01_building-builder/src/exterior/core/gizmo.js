/* ============================================================
   ギズモ：選択した外構地物の移動・回転と、線／範囲の端部ドラッグ

   tree/planner.html の js/core/gizmo.js を移植したもの。変更点は2つ。
     ① three r169 以降、TransformControls は Object3D ではなくなったので、
        シーンには controls.getHelper() を足す（本体アプリは three 0.184）
     ② 単位が mm。地物の座標 rec.pts は m のままなので、ここで換算する
   ============================================================ */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { getScene, getCamera, getRenderer, getControls, pickGround, render, MM } from './viewer.js';
import * as store from './store.js';
import { scheduleRebuild, finishRebuild } from './rebuild.js';

let tc = null;                       // TransformControls
let tcHelper = null;                 // ★ r169+：シーンに置くのはこちら
let mode = 'translate';
let target = null;                   // 操作中の rec
let snap = null;                     // ドラッグ開始時の pts / rot
let onChange = () => {};
let active = false;                  // 外構モード中だけ true
let getSnapMM = () => 500;

/* --- 頂点ハンドル（線・範囲・折れ線の各点） --- */
const handles = new THREE.Group();
handles.renderOrder = 12;
const handleGeo = new THREE.SphereGeometry(0.16 * MM, 16, 12);
const handleMat = new THREE.MeshBasicMaterial({ color: 0xffb066, depthTest: false });
let dragEnd = null;                  // ドラッグ中の頂点番号
const hasVerts = rec => rec && rec.pts.length > 1;
let busyUntil = 0;                   // 操作直後の click を拾わないための猶予
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();

/* ギズモ／ハンドルを触っている間（と直後）は true */
export const gizmoBusy = () =>
  dragEnd !== null || (tc && tc.dragging) || performance.now() < busyUntil;

export function initGizmo(handler, opts = {}){
  onChange = handler || (() => {});
  if (opts.getSnapMM) getSnapMM = opts.getSnapMM;

  const scene = getScene(), camera = getCamera(), renderer = getRenderer(), controls = getControls();

  tc = new TransformControls(camera, renderer.domElement);
  tc.setTranslationSnap(getSnapMM());
  tc.setRotationSnap(THREE.MathUtils.degToRad(15));
  tc.setSize(0.8);
  tc.enabled = false;
  tc.addEventListener('dragging-changed', e => {
    controls.enabled = !e.value;
    busyUntil = performance.now() + 250;
    /* 掴んだ瞬間に現状を控え、離した瞬間に本来の細かさで作り直す */
    if (e.value) takeSnapshot();
    else finishRebuild(target, () => { refreshHandles(); onChange(); render(); });
  });
  tc.addEventListener('objectChange', applyGizmo);
  tc.addEventListener('change', render);

  tcHelper = tc.getHelper ? tc.getHelper() : tc;    // r169 以降は getHelper()
  tcHelper.visible = false;
  scene.add(tcHelper);
  scene.add(handles);

  /* 端部ハンドルのドラッグ */
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', ev => {
    if (!active || !hasVerts(target)) return;
    const h = hitHandle(ev);
    if (!h) return;
    dragEnd = h.userData.idx;
    controls.enabled = false;
    busyUntil = performance.now() + 250;
    try { dom.setPointerCapture(ev.pointerId); } catch { /* 合成イベントでは無視 */ }
    ev.stopPropagation();
  }, true);
  dom.addEventListener('pointermove', ev => {
    if (!active || dragEnd === null || !target) return;
    const p = pickGround(ev);
    if (!p) return;
    /* 隣の点と重なると長さ 0 になるので弾く */
    const near = target.pts.some((q, i) =>
      i !== dragEnd && Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.z - q.z) < 1e-6);
    if (near) return;
    target.pts[dragEnd] = { x: p.x, z: p.z };
    /* ★引いている間は粗い形で（1フレームに1回）。手を離したら作り直す */
    scheduleRebuild(target, () => { refreshHandles(); onChange(); render(); });
    refreshHandles();
    ev.stopPropagation();
  }, true);
  dom.addEventListener('pointerup', ev => {
    if (!active || dragEnd === null) return;
    dragEnd = null;
    controls.enabled = true;
    busyUntil = performance.now() + 250;
    finishRebuild(target, () => { refreshHandles(); render(); });
    onChange();
    ev.stopPropagation();
  }, true);
}

/* 外構モードの出入り */
export function setGizmoActive(v){
  active = v;
  if (!v){
    dragEnd = null;
    attachGizmo(null);
  }
}

function hitHandle(ev){
  ptr.x = (ev.clientX / window.innerWidth) * 2 - 1;
  ptr.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  ray.setFromCamera(ptr, getCamera());
  return ray.intersectObjects(handles.children.filter(h => h.visible), false)[0]?.object;
}

function takeSnapshot(){
  if (!target) return;
  snap = { pts: target.pts.map(p => ({ ...p })), rot: target.rot, pl: store.placementOf(target) };
}

/* ギズモの結果を配置情報へ書き戻す（obj は mm、pts は m） */
function applyGizmo(){
  if (!target || !snap) return;
  const obj = target.obj;
  if (mode === 'translate'){
    /* ★変更：TransformControls の座標スナップは「中心の絶対位置」を丸めるため、
       範囲もののように中心が格子の中間にあると、角の点が格子から外れてしまう。
       ここでは「移動量」をスナップ幅で丸めて、角の点を格子上に保つ。 */
    const g = getSnapMM() / MM;                                  // スナップ幅（m）
    const dx = Math.round((obj.position.x / MM - snap.pl.cx) / g) * g;
    const dz = Math.round((obj.position.z / MM - snap.pl.cz) / g) * g;
    target.pts = snap.pts.map(p => ({ x: p.x + dx, z: p.z + dz }));
  } else {
    const d = obj.rotation.y - snap.pl.ry;                 // 回した量
    if (target.pts.length > 1){                            // 線：各点を中心まわりに回す
      const cs = Math.cos(-d), sn = Math.sin(-d);
      const cx = snap.pl.cx, cz = snap.pl.cz;
      target.pts = snap.pts.map(p => ({ x: cx + (p.x-cx)*cs - (p.z-cz)*sn,
                                        z: cz + (p.x-cx)*sn + (p.z-cz)*cs }));
    } else {
      target.rot = (Math.round(THREE.MathUtils.radToDeg(snap.pl.ry + d) / 15) * 15 + 360) % 360;
    }
  }
  /* ★ギズモを動かしている間も 1フレームに1回・粗い形で作り直す
       （位置だけの変更でも、芝や葉は形ごと作り直しになるため） */
  scheduleRebuild(target, () => { refreshHandles(); onChange(); });
  refreshHandles();
}

/* 選択が変わったら付け替える */
export function attachGizmo(rec){
  target = rec || null;
  if (!tc) return;
  if (!rec || !active){
    tc.detach();
    tc.enabled = false;
    tcHelper.visible = false;
    hideHandles();
    render();
    return;
  }
  if (rec.def.place === 'rect' && mode === 'rotate') setMode('translate');
  tc.setTranslationSnap(getSnapMM());          // スナップ量の切替に追従する
  tc.attach(rec.obj);
  tc.enabled = true;
  tcHelper.visible = true;
  applyMode();
  refreshHandles();
  render();
}

export function setMode(m){
  mode = m;
  if (tc) applyMode();
}
export const getMode = () => mode;

function applyMode(){
  tc.setMode(mode);
  if (mode === 'translate'){ tc.showX = true; tc.showZ = true; tc.showY = false; }
  else { tc.showX = false; tc.showZ = false; tc.showY = true; }
}

function hideHandles(){ handles.children.forEach(h => h.visible = false); }

export function refreshHandles(){
  if (!active || !hasVerts(target)){ hideHandles(); return; }
  /* 点の数に合わせてハンドルを用意する */
  while (handles.children.length < target.pts.length){
    const m = new THREE.Mesh(handleGeo, handleMat);
    m.userData.idx = handles.children.length;
    m.renderOrder = 12;
    handles.add(m);
  }
  handles.children.forEach((h, i) => {
    const p = target.pts[i];
    h.visible = !!p;
    if (p) h.position.set(p.x * MM, 0.05 * MM, p.z * MM);
  });
}

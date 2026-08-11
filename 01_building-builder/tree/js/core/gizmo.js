/* ============================================================
   ギズモ：選択した地物の移動・回転と、線／範囲の端部ドラッグ
   ============================================================ */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { scene, camera, renderer, controls, pickGround, GRID } from './viewer.js';
import * as store from './store.js';

let tc = null;                       // TransformControls
let mode = 'translate';
let target = null;                   // 操作中の rec
let snap = null;                     // ドラッグ開始時の a / b / rot
let onChange = () => {};

/* --- 頂点ハンドル（線・範囲・折れ線の各点） --- */
const handles = new THREE.Group();
handles.renderOrder = 12;
const handleGeo = new THREE.SphereGeometry(0.16, 16, 12);
const handleMat = new THREE.MeshBasicMaterial({ color: 0xffb066, depthTest: false });
let dragEnd = null;                  // ドラッグ中の頂点番号
const hasVerts = rec => rec && rec.pts.length > 1;
let busyUntil = 0;                   // 操作直後の click を拾わないための猶予
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();

/* ギズモ／ハンドルを触っている間（と直後）は true */
export const gizmoBusy = () =>
  dragEnd !== null || (tc && tc.dragging) || performance.now() < busyUntil;

export function initGizmo(handler){
  onChange = handler || (() => {});
  tc = new TransformControls(camera, renderer.domElement);
  tc.setTranslationSnap(GRID);
  tc.setRotationSnap(THREE.MathUtils.degToRad(15));
  tc.setSize(0.8);
  tc.addEventListener('dragging-changed', e => {
    controls.enabled = !e.value;
    busyUntil = performance.now() + 250;
    if (e.value) takeSnapshot(); else onChange();
  });
  tc.addEventListener('objectChange', applyGizmo);
  scene.add(tc);
  scene.add(handles);

  /* 端部ハンドルのドラッグ */
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', ev => {
    if (!hasVerts(target)) return;
    const h = hitHandle(ev);
    if (!h) return;
    dragEnd = h.userData.idx;
    controls.enabled = false;
    busyUntil = performance.now() + 250;
    try { dom.setPointerCapture(ev.pointerId); } catch { /* 合成イベントでは無視 */ }
    ev.stopPropagation();
  }, true);
  dom.addEventListener('pointermove', ev => {
    if (dragEnd === null || !target) return;
    const p = pickGround(ev);
    if (!p) return;
    /* 隣の点と重なると長さ 0 になるので弾く */
    const near = target.pts.some((q, i) =>
      i !== dragEnd && Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.z - q.z) < 1e-6);
    if (near) return;
    target.pts[dragEnd] = { x: p.x, z: p.z };
    store.build(target);
    refreshHandles();
    onChange();
    ev.stopPropagation();
  }, true);
  dom.addEventListener('pointerup', ev => {
    if (dragEnd === null) return;
    dragEnd = null;
    controls.enabled = true;
    busyUntil = performance.now() + 250;
    onChange();
    ev.stopPropagation();
  }, true);
}

function hitHandle(ev){
  ptr.x = (ev.clientX / innerWidth) * 2 - 1;
  ptr.y = -(ev.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  return ray.intersectObjects(handles.children.filter(h => h.visible), false)[0]?.object;
}

function takeSnapshot(){
  if (!target) return;
  snap = { pts: target.pts.map(p => ({ ...p })), rot: target.rot, pl: store.placementOf(target) };
}

/* ギズモの結果を配置情報へ書き戻す */
function applyGizmo(){
  if (!target || !snap) return;
  const obj = target.obj;
  if (mode === 'translate'){
    const dx = obj.position.x - snap.pl.cx, dz = obj.position.z - snap.pl.cz;
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
  store.build(target);
  refreshHandles();
  onChange();
}

/* 選択が変わったら付け替える */
export function attachGizmo(rec){
  target = rec || null;
  if (!tc) return;
  if (!rec){ tc.detach(); tc.visible = false; hideHandles(); return; }
  if (rec.def.place === 'rect' && mode === 'rotate') setMode('translate');
  tc.attach(rec.obj);
  tc.visible = true;
  applyMode();
  refreshHandles();
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
  if (!hasVerts(target)){ hideHandles(); return; }
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
    if (p) h.position.set(p.x, 0.05, p.z);
  });
}

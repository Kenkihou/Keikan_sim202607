/* ============================================================
   外構作図モード（tree/planner.html の機能を本体アプリへ移植）

   ツールバーの「外構作図」ボタンで出入りする。モード中は
     ・建物を半透明のゴーストにして、建物側の編集操作を止める
     ・地盤面（Y=0）の上に、地面／囲い／外構／樹木を作図できる
   という状態になる。地物の中身（形の作り方）は planner のものをそのまま使い、
   このファイルは「モードの出入り」と「クリック操作」だけを受け持つ。
   ============================================================ */
import { initViewer, pickGround, pickItem, showMarker, showRubber, clearOverlays,
         focusOn, world, render } from './core/viewer.js';
import * as store from './core/store.js';
import { initUI, showUI, setActive, getActive, refreshReadouts } from './core/ui.js';
import { initGizmo, refreshHandles, gizmoBusy, setGizmoActive } from './core/gizmo.js';

let active = false;
let houseGroup = null;
let setBuildingLocked = () => {};
let canvas = null;

let draw = [];                 // 作図中にクリックした点（m）
let down = null;               // 押した位置（カメラ操作とクリックの区別に使う）
const moved = () => !down || down.d > 5;
const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/* --- 建物のゴースト表示（元の設定を覚えておいて、抜けるときに戻す） --- */
const ghostBackup = new Map();
const GHOST_OPACITY = 0.35;

function ghostMaterial(m){
  if (!m || ghostBackup.has(m)) return;
  ghostBackup.set(m, { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
  m.transparent = true;
  m.opacity = GHOST_OPACITY;
  m.depthWrite = false;
  m.needsUpdate = true;
}

/* 建物のメッシュだけ半透明にする（黒い輪郭線はそのまま残す） */
export function applyGhost(){
  if (!active || !houseGroup) return;
  houseGroup.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(ghostMaterial);
  });
}

function clearGhost(){
  for (const [m, prev] of ghostBackup){
    m.transparent = prev.transparent;
    m.opacity = prev.opacity;
    m.depthWrite = prev.depthWrite;
    m.needsUpdate = true;
  }
  ghostBackup.clear();
}

/* ============================================================
   起動
   ============================================================ */
export function initExterior(ctx){
  houseGroup = ctx.houseGroup;
  setBuildingLocked = ctx.setBuildingLocked || (() => {});
  canvas = ctx.renderer.domElement;

  initViewer(ctx);
  initGizmo(() => { refreshHandles(); refreshReadouts(); }, { getSnapMM: ctx.getSnapMM });
  initUI({
    onPick: def => { draw = []; showRubber(null); showMarker(null); if (def) store.select(null); },
    onEdit: () => {},
    onExit: () => exitExterior(),
  });
  showUI(false);
  setupEvents();
}

/* ============================================================
   モードの出入り
   ============================================================ */
export function isExteriorActive(){ return active; }

/* 外構作図中は使えなくするツールバーのボタン（建物側の作図・チュートリアル） */
const LOCKED_BUTTONS = ['btn-draw', 'btn-start-tutorial'];
function lockToolbarButtons(v){
  for (const id of LOCKED_BUTTONS)
    document.getElementById(id)?.classList.toggle('disabled', v);
}

export function enterExterior(){
  if (active) return;
  active = true;
  setBuildingLocked(true);            // 建物側のクリック編集を止める
  lockToolbarButtons(true);
  applyGhost();
  setGizmoActive(true);
  showUI(true);
  setActive(null);
  store.select(null);
  document.getElementById('btn-exterior')?.classList.add('active');
  render();
}

export function exitExterior(){
  if (!active) return;
  active = false;
  setActive(null);
  store.select(null);
  draw = [];
  clearOverlays();
  setGizmoActive(false);
  showUI(false);
  clearGhost();
  lockToolbarButtons(false);
  setBuildingLocked(false);
  document.getElementById('btn-exterior')?.classList.remove('active');
  render();
}

export function toggleExterior(){ active ? exitExterior() : enterExterior(); }

/* ============================================================
   セーブ・ロード・全消去（本体アプリの 💾 📂 ✖ から呼ぶ）
   ============================================================ */
export const serializeExterior = () => store.serialize();
export function restoreExterior(list){
  store.restore(list);
  if (active) applyGhost();
  render();
}
export function clearExterior(){ store.clearAll(); render(); }
export const exteriorCount = () => store.items.length;

/* ============================================================
   操作（planner の js/main.js 相当）
   ============================================================ */
function finishDraw(){
  const def = getActive();
  if (!def || draw.length < 2) return false;
  const rec = store.addItem(def, draw);
  draw = [];
  showRubber(null);
  store.select(rec);
  setActive(null);
  return true;
}
function cancelDraw(){ draw = []; showRubber(null); }

function setupEvents(){
  canvas.addEventListener('pointerdown', ev => {
    if (!active) return;
    down = { x: ev.clientX, y: ev.clientY, d: 0 };
  });

  canvas.addEventListener('pointermove', ev => {
    if (!active) return;
    if (ev.buttons){
      if (down) down.d = Math.max(down.d, Math.hypot(ev.clientX - down.x, ev.clientY - down.y));
      showMarker(null);
      return;
    }
    const def = getActive();
    if (!def) { showMarker(null); return; }
    const p = pickGround(ev);
    showMarker(p);
    if (draw.length && p) showRubber(draw, p); else showRubber(null);
  });

  canvas.addEventListener('click', ev => {
    if (!active) return;
    if (moved() || gizmoBusy()) return;                  // カメラ操作／ギズモ操作の直後
    const def = getActive();

    if (!def){                                           // 選択モード
      const hit = pickItem(ev);
      store.select(hit ? hit.userData.item : null);
      return;
    }
    const p = pickGround(ev);
    if (!p) return;

    if (def.place === 'point'){
      store.select(store.addItem(def, [p]));
      setActive(null);
      return;
    }
    if (draw.length && same(p, draw[draw.length - 1])) return;   // 同じ点の連打は無視
    draw.push(p);
    showRubber(draw, p);
    /* 線・範囲は2点で確定。折れ線はダブルクリック／Enter まで続ける */
    if (def.place !== 'poly' && draw.length >= 2) finishDraw();
  });

  /* 折れ線の確定 */
  canvas.addEventListener('dblclick', () => {
    if (!active) return;
    if (getActive()?.place === 'poly') finishDraw();
  });

  window.addEventListener('keydown', ev => {
    if (!active) return;
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
    if (ev.key === 'Enter'){ finishDraw(); return; }
    if (ev.key === 'Escape'){
      if (draw.length) cancelDraw();
      else if (getActive()) setActive(null);
      else if (store.getSelected()) store.select(null);
      else exitExterior();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace'){
      const rec = store.getSelected();
      if (rec) store.removeItem(rec);
    }
    if (ev.key === 'f' || ev.key === 'F'){
      const rec = store.getSelected();
      if (rec) focusOn(rec.obj);
    }
  });
}

/* 外構オブジェクトの入れ物（デバッグ・拡張用に公開しておく） */
export const exteriorWorld = world;

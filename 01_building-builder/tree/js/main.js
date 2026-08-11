/* ============================================================
   外構プランナー：起動と操作（配置 → 選択 → 編集）
   ============================================================ */
import { initViewer, pickGround, pickItem, showMarker, showRubber, controls, focusOn } from './core/viewer.js';
import * as store from './core/store.js';
import { initUI, setActive, getActive, refreshReadouts } from './core/ui.js';
import { initGizmo, refreshHandles, gizmoBusy } from './core/gizmo.js';

initViewer(document.getElementById('canvas-container'));
initGizmo(() => { refreshHandles(); refreshReadouts(); });
initUI({
  onPick: def => { draw = []; showRubber(null); showMarker(null); if (def) store.select(null); },
  onEdit: () => {},
});

let draw = [];                 // 作図中にクリックした点
let down = null;               // 押した位置（カメラ操作とクリックの区別に使う）
const moved = () => !down || down.d > 5;
const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

const canvas = document.querySelector('#canvas-container canvas');

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

canvas.addEventListener('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY, d: 0 }; });
canvas.addEventListener('pointermove', ev => {
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
canvas.addEventListener('dblclick', () => { if (getActive()?.place === 'poly') finishDraw(); });

addEventListener('keydown', ev => {
  if (ev.key === 'Enter'){ finishDraw(); return; }
  if (ev.key === 'Escape'){
    if (draw.length) cancelDraw();
    else if (getActive()) setActive(null);
    else store.select(null);
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

/* パネルの開閉 */
for (const id of ['palette', 'inspector']){
  const el = document.getElementById(id);
  el.querySelector('.toggle').onclick = () => {
    el.classList.toggle('collapsed');
    el.querySelector('.toggle').textContent = el.classList.contains('collapsed') ? '＋' : '−';
  };
}

/* 起動時のお試し配置（説明代わり。消してよい） */
store.select(null);

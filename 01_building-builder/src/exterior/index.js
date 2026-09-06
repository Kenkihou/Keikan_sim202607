/* ============================================================
   外構作図モード（tree/planner.html の機能を本体アプリへ移植）

   ツールバーの「外構作図」ボタンで出入りする。モード中は
     ・建物を半透明のゴーストにして、建物側の編集操作を止める
     ・地盤面（Y=0）の上に、地面／囲い／外構／樹木を作図できる
   という状態になる。地物の中身（形の作り方）は planner のものをそのまま使い、
   このファイルは「モードの出入り」と「クリック操作」だけを受け持つ。
   ============================================================ */
import { initViewer, pickGround, pickItem, showMarker, showRubber, clearOverlays,
         focusOn, world, render, getControls, toScreen, setMarkerHot,
         getSnapM } from './core/viewer.js';
import * as store from './core/store.js';
import { initUI, showUI, setActive, getActive, refreshReadouts } from './core/ui.js';
import { initGizmo, refreshHandles, gizmoBusy, setGizmoActive } from './core/gizmo.js';
import * as paint from './core/paint.js';

let active = false;
let houseGroup = null;
let setBuildingLocked = () => {};
let canvas = null;

let draw = [];                 // 作図中にクリックした点（m）
let down = null;               // 押した位置（カメラ操作とクリックの区別に使う）
// ★追加：範囲（地面）を【ドラッグ】で描いている最中。{ p0 }
//   ⚠️ 建物の平面作図と同じ手つきにするため。同じ「四角を描く」のに、
//     建物はドラッグ・外構は2点クリック、と作法が違うのは覚え直しになる。
let rectDrag = null;
// ドラッグで描き終えた直後の click を1回だけ捨てるための目印。
//   ⚠️ 捨てないと、置いたばかりのものが click で選び直され（あるいは外れ）る。
let eatClick = false;
// ★追加：囲い（折れ線）も、まず【ドラッグで1本】引く。
//   ★ 囲いの多くは1本の直線か、せいぜい L 字。いちばん多い使い方が
//     「覚えることゼロ」で終わるようにする。折り曲げは、そのあとの選択肢。
let polyDrag = null;
// 直前に置いたもの。「続ける」で開き直すために覚えておく。
let lastRec = null;
// 折れ線を、最初の点に戻して閉じられる状態か。
let canClose = false;
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
    onPick: def => { draw = []; showRubber(null); showMarker(null);
      hideTag(); hideSize(); setMarkerHot(false); canClose = false;
      if (def) store.select(null); },
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
   ★追加：外構の着色（02＝マンセル値シミュレーターとの色のやり取り）
   名前の付け方と、共有マテリアルであることの帰結は core/paint.js の頭に書いてある。
   ============================================================ */
export { nameExteriorMaterials, EXT_MAT_PREFIX, getExteriorColors } from './core/paint.js';

/* 02 から返ってきた色を取り込んで塗り直す。戻り値は「取り込むものがあったか」。 */
export function mergeExteriorColors(colorMap){
  const changed = paint.mergeReturnedColors(colorMap);
  if (changed) render();   // 外構は本体アプリの rebuildMeshes では作り直されないので自分で描き直す
  return changed;
}

/* 保存ファイルから色を戻す。地物を組み立て終わってから呼ぶこと
   （マテリアルは地物を作った時点で生まれるため、順序を逆にすると当たらない）。 */
export function restoreExteriorColors(map){
  paint.setExteriorColors(map);
  render();
}

/* ============================================================
   操作（planner の js/main.js 相当）
   ============================================================ */
function finishDraw(){
  const def = getActive();
  if (!def || draw.length < 2) return false;
  const rec = store.addItem(def, draw);
  draw = [];
  showRubber(null);
  hideTag();
  hideSize();
  setMarkerHot(false);
  canClose = false;
  store.select(rec);
  setActive(null);
  return true;
}
function cancelDraw(){ draw = []; showRubber(null); hideTag(); hideSize(); }

/* ★追加：モデルのそばに出す小さな札。
   ⚠️ 「次に何をすればいいか」は、画面の端ではなく【手を動かしている場所】に
     置くこと。上の帯に書いても読まれない（実際に読み落とされていた）。 */
let tagEl = null;
function tag(){
  if (tagEl) return tagEl;
  tagEl = document.createElement('div');
  tagEl.style.cssText = 'position:fixed;z-index:100002;display:none;gap:4px;'
    + 'transform:translate(-50%,-50%);font:12px/1 system-ui,sans-serif;';
  document.body.appendChild(tagEl);
  return tagEl;
}
function showTag(p, buttons){
  const el = tag();
  el.innerHTML = '';
  for (const [label, kind, fn] of buttons){
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:none;border-radius:6px;padding:7px 11px;cursor:pointer;'
      + 'font-weight:700;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      + (kind === 'go' ? 'background:#007acc;color:#fff;' : 'background:#fff;color:#333;');
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    // ⚠️ 札の上での押下がキャンバスへ抜けると、作図が1回ぶん進んでしまう。
    b.onpointerdown = (ev) => ev.stopPropagation();
    el.appendChild(b);
  }
  const s = toScreen(p);
  el.style.left = s.x + 'px';
  el.style.top = (s.y - 34) + 'px';
  el.style.display = 'flex';
}
function hideTag(){ if (tagEl) tagEl.style.display = 'none'; }

/* ★追加：引いている最中の寸法。カーソルのそばに出す。 */
let sizeEl = null;
function showSize(text, sx, sy){
  if (!sizeEl){
    sizeEl = document.createElement('div');
    sizeEl.style.cssText = 'position:fixed;z-index:100002;display:none;pointer-events:none;'
      + 'background:rgba(33,37,41,.9);color:#fff;padding:3px 8px;border-radius:5px;'
      + 'font:12px/1.4 system-ui,sans-serif;white-space:nowrap;transform:translate(14px,14px);';
    document.body.appendChild(sizeEl);
  }
  sizeEl.textContent = text;
  sizeEl.style.left = sx + 'px';
  sizeEl.style.top = sy + 'px';
  sizeEl.style.display = 'block';
}
function hideSize(){ if (sizeEl) sizeEl.style.display = 'none'; }

const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const fmtM = (v) => (Math.round(v * 10) / 10).toFixed(1) + ' m';

/* ★追加：引いた直後に出す札。押さなければ、そのまま確定したまま。 */
function offerContinue(rec){
  lastRec = rec;
  const pts = rec.pts;
  showTag(pts[pts.length - 1], [
    ['＋ ここから続ける', 'go', () => {
      // 置いたものをいったん取り消し、点だけ引き継いで作図に戻る。
      const def = rec.def, keep = rec.pts.map(q => ({ x: q.x, z: q.z }));
      store.removeItem(rec);
      lastRec = null;
      setActive(def);
      draw = keep;
      showRubber(draw, null);
      showTag(draw[draw.length - 1], [['終わり', 'go', () => finishDraw()]]);
    }],
    ['終わり', 'plain', () => { hideTag(); lastRec = null; }],
  ]);
}

function setupEvents(){
  canvas.addEventListener('pointerdown', ev => {
    if (!active) return;
    down = { x: ev.clientX, y: ev.clientY, d: 0 };
    // ★ 範囲ものは、押した所を起点にドラッグで描く。
    //   ⚠️ 描いているあいだはカメラを止める。止めないと、引っぱるたびに
    //     視点が回って、どこを掴んでいるのか分からなくなる。
    const def = getActive();
    if (def && def.place === 'rect' && ev.button === 0){
      const p = pickGround(ev);
      if (p){
        rectDrag = { p0: p };
        draw = [];
        const c = getControls();
        if (c) c.enabled = false;
      }
    }
    // ★ 囲いも、1本目は【ドラッグ】で引く。折れ点を足すのは、そのあと。
    //   ⚠️ 折れ点を足す途中（draw に点がある）は、クリックで進める作図の
    //     途中なので、ここでドラッグを始めてはいけない。
    if (def && def.place === 'poly' && ev.button === 0 && !draw.length){
      const p = pickGround(ev);
      if (p){
        polyDrag = { p0: p };
        const c = getControls();
        if (c) c.enabled = false;
      }
    }
  });

  canvas.addEventListener('pointermove', ev => {
    if (!active) return;
    // ★ 範囲をドラッグ中。四隅をつないで【長方形のまま】見せる。
    //   ⚠️ 対角線1本だと、どこまでが範囲なのか読み取れない。
    if (rectDrag){
      const p = pickGround(ev);
      if (p){
        const a = rectDrag.p0;
        showRubber([a, { x: p.x, z: a.z }, p, { x: a.x, z: p.z }], a);
        showMarker(p);
        showSize(fmtM(Math.abs(p.x - a.x)) + ' × ' + fmtM(Math.abs(p.z - a.z)),
          ev.clientX, ev.clientY);
      }
      return;
    }
    // ★ 囲いを1本引いている最中。長さを数字でも見せる。
    if (polyDrag){
      const p = pickGround(ev);
      if (p){
        showRubber([polyDrag.p0], p);
        showMarker(p);
        showSize(fmtM(dist(polyDrag.p0, p)), ev.clientX, ev.clientY);
      }
      return;
    }
    if (ev.buttons){
      if (down) down.d = Math.max(down.d, Math.hypot(ev.clientX - down.x, ev.clientY - down.y));
      showMarker(null);
      return;
    }
    const def = getActive();
    if (!def) { showMarker(null); return; }
    let p = pickGround(ev);
    // ★ 折れ点を足している最中、最初の点に近づいたら【そこへ吸い付く】。
    //   戻れば閉じられる、ということを印の色と大きさで見せる。
    canClose = false;
    if (p && draw.length >= 2 && dist(p, draw[0]) < snapNear()){
      p = { x: draw[0].x, z: draw[0].z };
      canClose = true;
    }
    setMarkerHot(canClose);
    showMarker(p);
    if (draw.length && p){
      showRubber(draw, p);
      showSize(fmtM(dist(draw[draw.length - 1], p))
        + (canClose ? '　クリックで閉じる' : ''), ev.clientX, ev.clientY);
    } else {
      showRubber(null);
      hideSize();
    }
  });

  /* 「最初の点に戻った」とみなす距離。スナップ幅より少し広く取る。 */
  function snapNear(){ return Math.max(0.4, getSnapM() * 1.2); }

  /* ★追加：範囲のドラッグの終わり。離した所がもう一方の隅。 */
  /* ★追加：囲いのドラッグの終わり。1本引けたら、その場で置いて札を出す。 */
  window.addEventListener('pointerup', ev => {
    if (!polyDrag) return;
    const a = polyDrag.p0;
    const p = pickGround(ev);
    polyDrag = null;
    eatClick = true;
    const c = getControls();
    if (c) c.enabled = true;
    showRubber(null);
    hideSize();
    if (p && dist(a, p) > 0.2){
      const def = getActive();
      draw = [a, p];
      const rec = store.addItem(def, draw);
      draw = [];
      store.select(rec);
      setActive(null);
      // ★ 押さなければ、このまま確定。折り曲げたい人にだけ道を見せる。
      offerContinue(rec);
    } else {
      draw = [];
    }
  });

  window.addEventListener('pointerup', ev => {
    if (!rectDrag) return;
    const a = rectDrag.p0;
    const p = pickGround(ev);
    rectDrag = null;
    eatClick = true;
    const c = getControls();
    if (c) c.enabled = true;
    showRubber(null);
    // ⚠️ 押しただけ（ほとんど動いていない）ときは何も置かない。
    //   置くと、選ぼうとしただけで極小の地面ができてしまう。
    if (p && Math.abs(p.x - a.x) > 0.2 && Math.abs(p.z - a.z) > 0.2){
      draw = [a, p];
      finishDraw();
    } else {
      draw = [];
    }
  });

  canvas.addEventListener('click', ev => {
    if (!active) return;
    if (eatClick){ eatClick = false; return; }
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
    if (def.place === 'rect') return;                     // ★ 範囲はドラッグ専用
    // ★ 最初の点に戻ったら、そこで閉じて確定する（敷地をぐるりと囲うとき）。
    if (def.place === 'poly' && canClose && draw.length >= 2){
      draw.push({ x: draw[0].x, z: draw[0].z });
      finishDraw();
      return;
    }
    if (draw.length && same(p, draw[draw.length - 1])) return;   // 同じ点の連打は無視
    draw.push(p);
    showRubber(draw, p);
    /* 線は2点で確定。折れ線は札の「終わり」／ダブルクリック／Enter まで続ける */
    if (def.place !== 'poly' && draw.length >= 2) finishDraw();
    if (def.place === 'poly' && draw.length >= 2){
      showTag(draw[draw.length - 1], [['終わり', 'go', () => finishDraw()]]);
    }
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

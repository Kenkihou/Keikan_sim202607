// =============================================================================
// usermodel — 親アプリ（01_building-builder）で作った建物を、この地形の上に置く。
//
//   ・GLB は親が sessionStorage に blob URL を入れて渡す（02/03 と同じ流儀）。
//     同一オリジンで配信されている前提（dev は vite proxy、公開時は同じサイトの
//     /earth-api/ 以下）。単独起動でモデルが無いときは何も表示しない。
//   ・置く場所は【注目地点】。右下の地図で地点を選ぶとモデルもそこへ移る。
//   ・高さは地形から拾って接地させる。★地形は後から細かいタイルに置き換わるので、
//     「一度置いて終わり」にはできない。core の dirty.userModel が立つたびに
//     置き直す（断面や眺望ポリゴンと同じ作法）。
// =============================================================================
import {
  THREE, scene, el, focusLocal, EARTH_R, markUserModelDirty,
  camera, controls, renderer, hideLoading, requestRender,
} from './core.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  DEG2RAD, ORIGIN_LAT, ORIGIN_LON, SEA_LEVEL_Y,
  USER_MODEL_GLB_KEY, USER_MODEL_HEADING_KEY, USER_MODEL_OFFSET_KEY, USER_MODEL_FOCUS_KEY,
  USER_MODEL_CAMERA_KEY,
  USER_MODEL_SCALE, USER_MODEL_YAW_BASE, USER_MODEL_SNAP_RADIUS, USER_MODEL_SNAP_CELL,
  USER_MODEL_GIZMO_MOVE_SNAP, USER_MODEL_GIZMO_ROTATE_SNAP,
} from './config.js';
import { buildTerrainHeightGrid, sampleGrid } from './viewareas.js';
import { setFocusLatLon, isTerrainReady } from './tiles.js';
import { setPickerCenter } from './ui.js';

const RAD2DEG = 180 / Math.PI;

// 親の画面（モデリング or ポータル）から呼ばれたのか、単独で開いたのかを URL で判別する
// （02/03 と同じ ?from=modeling / ?from=portal）。
let fromParam = new URLSearchParams(location.search).get('from');
const isEmbedded = window.parent && window.parent !== window;

// モデルの状態。offset は【東westではなく東east・北north】で持つ（UIの「東へ」「北へ」と
// 一致させるため）。ローカル座標へは x=-east / z=north で変換する。
const userModelState = {
  present: false,      // GLB を受け取ったか
  loaded: false,       // 読み込みが済んだか
  error: null,
  visible: true,
  heading: 0,          // 向き[rad]（北から時計回り）
  offsetEast: 0,       // 注目地点からの微調整[m]
  offsetNorth: 0,
  groundY: NaN,        // 接地したローカルY（地形が読めていなければ NaN）
  snapped: false,
  provisional: false,  // 粗い地形で暫定的に接地している（＝あとで自動的に直る）
};

const userModelGroup = new THREE.Group();
userModelGroup.name = 'user-model';
scene.add(userModelGroup);

// モデルを置いたあとに親のカメラへ合わせ替える／その後しばらく接地の上下にカメラを追従させる
let pendingHandoffCamera = false;
let cameraFollowsGround = false;
// ギズモでドラッグ中は、毎フレームの置き直し（updateUserModel）に位置を上書きさせない
let gizmoDragging = false;

// =========================================================================
// 受け取り（sessionStorage）
// =========================================================================
function readSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* 単独起動などで使えなくても無視 */ }
}

// 親へ返す値。親は閉じるときにこれを読んでセーブデータに引き継ぐ。
function saveBackToSession() {
  writeSession(USER_MODEL_HEADING_KEY, String(userModelState.heading));
  writeSession(USER_MODEL_OFFSET_KEY, JSON.stringify({
    e: userModelState.offsetEast, n: userModelState.offsetNorth,
  }));
  // 今の注目地点（＝モデルを置いた場所）も返す。親の lastPlacedLocation に入る。
  const lat = ORIGIN_LAT + focusLocal.z / EARTH_R;
  const lon = ORIGIN_LON - focusLocal.x / (EARTH_R * Math.cos(lat));
  writeSession(USER_MODEL_FOCUS_KEY, JSON.stringify({
    lat: lat * RAD2DEG, lng: lon * RAD2DEG,
  }));
}

// 親アプリが覚えている「前回置いた場所」から始める。
//   注目地点だけ動かすと右下の地図の十字とずれるので、地図の中心も合わせる。
function restoreInitialFocus() {
  let loc = null;
  try { loc = JSON.parse(readSession(USER_MODEL_FOCUS_KEY) || 'null'); } catch { /* 無視 */ }
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
  setFocusLatLon(loc.lat * DEG2RAD, loc.lng * DEG2RAD, true);
  setPickerCenter(loc.lat, loc.lng);
}

// =========================================================================
// 読み込み
// =========================================================================
function loadUserModel() {
  const glbUrl = readSession(USER_MODEL_GLB_KEY);
  if (!glbUrl) return;              // 単独起動：モデル無しで街並みだけ見る
  userModelState.present = true;

  // 前回の向き・微調整を引き継ぐ（親のセーブデータから戻ってくる場合もある）
  const h = parseFloat(readSession(USER_MODEL_HEADING_KEY));
  if (Number.isFinite(h)) userModelState.heading = h;
  try {
    const o = JSON.parse(readSession(USER_MODEL_OFFSET_KEY) || 'null');
    if (o && Number.isFinite(o.e) && Number.isFinite(o.n)) {
      userModelState.offsetEast = o.e;
      userModelState.offsetNorth = o.n;
    }
  } catch { /* 壊れていたら既定値のまま */ }

  new GLTFLoader().load(glbUrl, (gltf) => {
    const root = gltf.scene;
    root.scale.setScalar(USER_MODEL_SCALE);   // 親は mm、こちらは m
    // 親から来たメッシュは片面マテリアルのことがある。断面を切らない今は
    // 裏返って抜けて見えると分かりにくいので両面にしておく。
    root.traverse((c) => {
      if (!c.isMesh || !c.material) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) m.side = THREE.DoubleSide;
    });
    userModelGroup.add(root);
    userModelState.loaded = true;
    // ★ 街並みや地形の到着を待たない。モデリング画面から持ってきた建物を先に出して、
    //   地盤・PLATEAU建物はその周りに後から埋まっていく形にする（切り替えの地続き感）。
    hideLoading();
    pendingHandoffCamera = !!readSession(USER_MODEL_CAMERA_KEY);
    markUserModelDirty();
    updateUserModelUi();
    setGizmoMode(gizmoMode);   // モデルが載ったのでギズモを取り付ける
    if (!pendingHandoffCamera) notifyParentReady();  // カメラ引き継ぎが無いならこの時点で出せる
  }, undefined, (err) => {
    userModelState.error = String(err && err.message ? err.message : err);
    console.warn('自作モデルの読み込みに失敗:', err);
    updateUserModelUi();
    notifyParentReady();
  });
}

// =========================================================================
// 置き直し（注目地点への追従 ＋ 接地）
//   ★ 接地の高さは【読み込み済みの地形】から作った高さグリッドで引く。
//     表示中だけを見るとカメラを回した拍子に高さが取れなくなる（眺望ポリゴンと同じ罠）。
//   ★ 地形が粗いうちは値が信用できないので、取れなければ前回の高さを保つ。
//     地形タイルが増えるたびに dirty が立つので、細かくなれば自動的に正しくなる。
// =========================================================================
function updateUserModel() {
  if (!userModelState.loaded) return;
  if (gizmoDragging) return;   // ドラッグ中の位置・向きはギズモが持っている

  const prevY = userModelGroup.position.y;
  const x = focusLocal.x - userModelState.offsetEast;   // +X=西なので東へは -X
  const z = focusLocal.z + userModelState.offsetNorth;  // +Z=北

  const grid = buildTerrainHeightGrid(x, z, USER_MODEL_SNAP_RADIUS, USER_MODEL_SNAP_CELL);
  const y = sampleGrid(grid, x, z);
  if (Number.isFinite(y)) {
    userModelState.groundY = y;
    userModelState.snapped = true;
    // ★ 地形が粗いうちの高さは当てにならない。京都は盆地なので、粗いタイルの三角形は
    //   市街地と山地をまたぎ、切り取ると山側の標高が混ざって数十m 高く出る
    //   （実測: 市役所前で 標高43m のところが 103m と出た）。
    //   地形が十分細かくなれば dirty が立って自動的に直るので、それまでは「仮」と示す。
    userModelState.provisional = !isTerrainReady();
  }

  const newY = Number.isFinite(userModelState.groundY) ? userModelState.groundY : 0;
  userModelGroup.position.set(x, newY, z);
  // 北から時計回りの方位角。上から見て時計回りは Y軸まわりの負回転なので符号を反転する。
  userModelGroup.rotation.y = USER_MODEL_YAW_BASE - userModelState.heading;
  userModelGroup.visible = userModelState.visible;

  // ★ 接地の高さは地形が細かくなるまで数十m 動くことがある。そのぶんカメラも一緒に
  //   上下させて、画面の中でモデルが動かないようにする（モデリング画面から地続きに
  //   見せるのが目的なので、動いてよいのは「周りの世界」だけ）。
  //   地形が落ち着いたら連動をやめ、以後は普通のカメラ操作に戻す。
  if (cameraFollowsGround && prevY !== newY) {
    camera.position.y += newY - prevY;
    controls.target.y += newY - prevY;
    controls.update();
  }
  if (pendingHandoffCamera) {
    pendingHandoffCamera = false;
    applyHandoffCamera();
    cameraFollowsGround = true;
    notifyParentReady();
  }
  if (cameraFollowsGround && isTerrainReady()) cameraFollowsGround = false;

  saveBackToSession();
  updateUserModelInfo();
}

// =========================================================================
// ギズモ（ドラッグで平面移動・向き変更）
//   ★ ドラッグを離した時点で【注目地点そのもの】をモデルの位置へ移す。
//     こうすると建物タイルの読み込み範囲・切り抜き箱・右下の地図の十字が
//     すべてモデルに付いてくる（モデルだけが注目地点から離れて置き去りにならない）。
//   ※ 移動量が 1m 以下なら setFocusLatLon はタイルを読み直さないので、
//     細かい詰めのドラッグでいちいち街並みが再読み込みされることはない。
// =========================================================================
let gizmoMode = 'translate';     // 'translate' | 'rotate' | 'off'
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('translate');
gizmo.showY = false;             // 高さは地形から決めるので上下には動かさない
gizmo.setTranslationSnap(USER_MODEL_GIZMO_MOVE_SNAP);
gizmo.setRotationSnap(THREE.MathUtils.degToRad(USER_MODEL_GIZMO_ROTATE_SNAP));
// three r169 以降、TransformControls 自体は Object3D ではなくヘルパーを scene に足す
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
gizmo.enabled = false;
if (gizmo.getHelper) gizmo.getHelper().visible = false;

// ★ オンデマンド描画なので、ギズモが自分で見た目を変えるとき（軸のホバー強調・
//   ドラッグ中の追従）は描画ループを起こしてやる必要がある。
//   カメラ操作と違って controls の change は飛ばないため、ここで拾う。
gizmo.addEventListener('change', () => requestRender());

gizmo.addEventListener('dragging-changed', (e) => {
  gizmoDragging = e.value;
  controls.enabled = !e.value;   // ドラッグ中はカメラを回さない
  if (!e.value) commitGizmoDrag();
});

// ドラッグ中の回転は状態にも反映しておく（UIの数値と食い違わないように）
gizmo.addEventListener('objectChange', () => {
  const h = USER_MODEL_YAW_BASE - userModelGroup.rotation.y;
  userModelState.heading = ((h % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  updateUserModelInfo();
});

// ドラッグを離したとき：モデルの居る場所を新しい注目地点にする
function commitGizmoDrag() {
  const x = userModelGroup.position.x, z = userModelGroup.position.z;
  const lat = ORIGIN_LAT + z / EARTH_R;
  const lon = ORIGIN_LON - x / (EARTH_R * Math.cos(lat));
  userModelState.offsetEast = 0;   // ずれではなく注目地点そのものが動いた
  userModelState.offsetNorth = 0;
  setFocusLatLon(lat, lon, false); // カメラは動かさない（見ている絵をそのまま保つ）
  setPickerCenter(lat * RAD2DEG, lon * RAD2DEG);
  markUserModelDirty();            // 移動先の地形で接地し直す
}

function setGizmoMode(mode) {
  gizmoMode = mode;
  const on = mode !== 'off' && userModelState.loaded && userModelState.visible;
  gizmo.enabled = on;
  if (gizmo.getHelper) gizmo.getHelper().visible = on;
  if (on) {
    gizmo.attach(userModelGroup);
    gizmo.setMode(mode);
    gizmo.showX = mode === 'translate';
    gizmo.showZ = mode === 'translate';
    gizmo.showY = mode === 'rotate';   // 回転はY軸（方位）まわりだけ
  } else {
    gizmo.detach();
  }
  updateGizmoButtons();
}

// モデリング画面のカメラを、地球上に置いたモデルの位置・向きに合わせて移し替える。
//   親のカメラはモデル原点基準の mm。こちらはモデルを置いた場所・向きに変換してから使う。
function applyHandoffCamera() {
  let st = null;
  try { st = JSON.parse(readSession(USER_MODEL_CAMERA_KEY) || 'null'); } catch { /* 無視 */ }
  if (!st || !Array.isArray(st.position) || !Array.isArray(st.target)) return;

  const rot = new THREE.Matrix4().makeRotationY(userModelGroup.rotation.y);
  const toHere = (arr) => new THREE.Vector3().fromArray(arr)
    .multiplyScalar(USER_MODEL_SCALE).applyMatrix4(rot).add(userModelGroup.position);
  const pos = toHere(st.position);
  const tgt = toHere(st.target);

  // ⚠️ 親と OrbitControls の距離制限が違う。範囲外のまま渡すと update() で一気に飛ぶので、
  //   向きは保ったまま距離だけ収める。
  const dir = pos.clone().sub(tgt);
  const dist = dir.length();
  if (dist > 1e-6) {
    const clamped = Math.min(Math.max(dist, controls.minDistance * 1.05), controls.maxDistance * 0.95);
    pos.copy(tgt).addScaledVector(dir.divideScalar(dist), clamped);
  }

  camera.position.copy(pos);
  controls.target.copy(tgt);
  if (Number.isFinite(st.fov) && st.fov > 0 && camera.fov !== st.fov) {
    camera.fov = st.fov;              // 画角も揃えないと同じ構図にならない
    camera.updateProjectionMatrix();
  }
  controls.update();
}

// 今のカメラを親アプリの座標（mm・モデル原点基準）に戻して預ける。
//   applyHandoffCamera の逆変換。モデリング画面へ戻ったときに同じアングルで続けられる。
//   ⚠️ モデルを持ち込んでいないとき（ポータルからの単独起動）は基準が無いので何もしない。
function saveCameraToSession() {
  if (!userModelState.loaded) return;
  const invRot = new THREE.Matrix4().makeRotationY(-userModelGroup.rotation.y);
  const toParent = (v) => v.clone().sub(userModelGroup.position)
    .applyMatrix4(invRot).divideScalar(USER_MODEL_SCALE).toArray();
  writeSession(USER_MODEL_CAMERA_KEY, JSON.stringify({
    position: toParent(camera.position),
    target: toParent(controls.target),
    fov: camera.fov,
  }));
}
// カメラ操作が一段落するたびに預けておく（親は「戻る」を押した時点の値を読む）。
controls.addEventListener('end', saveCameraToSession);

// 親に「もう出してよい」と伝える（それまで親は iframe を透明のままにしている）
let notifiedParent = false;
function notifyParentReady() {
  if (notifiedParent) return;
  notifiedParent = true;
  if (isEmbedded && typeof window.parent.showEarthSimulator === 'function') {
    window.parent.showEarthSimulator();
  }
}

// 明示的な接地のやり直し（地形が細かくなった後に押してもらう用）
function resnapUserModel() {
  userModelState.snapped = false;
  markUserModelDirty();
}

// =========================================================================
// HUD（自作モデルの操作）
// =========================================================================
let infoEl = null;
let gizmoButtonsRow = null;

// 選ばれているモードのボタンを押し込んだ見た目にする（.active は HUD 共通のスタイル）
function updateGizmoButtons() {
  if (!gizmoButtonsRow) return;
  for (const b of gizmoButtonsRow.children) {
    b.classList.toggle('active', b.dataset.gizmoMode === gizmoMode);
  }
}

function updateUserModelInfo() {
  if (!infoEl) return;
  if (userModelState.error) {
    infoEl.textContent = '読み込みに失敗: ' + userModelState.error;
    return;
  }
  if (!userModelState.loaded) { infoEl.textContent = 'モデルを読み込み中…'; return; }
  const elev = Number.isFinite(userModelState.groundY)
    ? (userModelState.groundY - SEA_LEVEL_Y) : NaN;
  const ground = !userModelState.snapped
    ? '接地待ち（地形の読み込み中）'
    : userModelState.provisional
      ? `接地（仮）: 標高 ${elev.toFixed(1)} m ／ 地形の読み込み中`
      : `接地: 標高 ${elev.toFixed(1)} m`;
  // 向きは操作するものではなく「今どうなっているか」を見るための表示
  infoEl.textContent = `${ground} ／ 向き ${Math.round(userModelState.heading * RAD2DEG) % 360}°`;
}

function updateUserModelUi() {
  const box = el('userModelUi');
  if (!box) return;
  box.style.display = userModelState.present ? 'flex' : 'none';
  updateUserModelInfo();
}

function buildUserModelUi() {
  const box = el('userModelUi');
  if (!box) return;

  const head = document.createElement('label');
  const showCb = document.createElement('input');
  showCb.type = 'checkbox';
  showCb.checked = userModelState.visible;
  showCb.addEventListener('change', () => {
    userModelState.visible = showCb.checked;
    setGizmoMode(gizmoMode);   // 隠したらギズモも一緒に消す
    markUserModelDirty();
  });
  head.appendChild(showCb);
  head.appendChild(document.createTextNode(' 自作モデルを表示'));
  box.appendChild(head);

  infoEl = document.createElement('div');
  infoEl.className = 'stats-line';
  box.appendChild(infoEl);

  // ---- ギズモ（ドラッグ操作）の切り替え ----
  const gizmoRow = document.createElement('div');
  gizmoRow.className = 'map-switch';
  gizmoRow.style.marginTop = '0';
  const mkGizmoBtn = (label, mode) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.gizmoMode = mode;
    b.addEventListener('click', () => setGizmoMode(mode));
    gizmoRow.appendChild(b);
    return b;
  };
  mkGizmoBtn('移動', 'translate');
  mkGizmoBtn('回転', 'rotate');
  mkGizmoBtn('操作なし', 'off');
  gizmoButtonsRow = gizmoRow;
  box.appendChild(gizmoRow);

  // ※ 位置と向きの操作はギズモのドラッグに一本化した（数値入力・微調整ボタンは廃止）。
  //   パネルに残すのは「表示の切り替え」「状態の表示」「ギズモのモード」だけ。
  updateUserModelUi();
}

// ※ 親アプリへの復帰用ボタンは廃止した。
//   モデリングへ戻るのは【親の下部バーの切り抜きスライダーを 0（地球なし）にする】、
//   ポータルへ戻るのは親の「ポータルに戻る」ボタン、と入口と出口が揃っているため。
//   戻るときに必要な値（向き・配置地点・カメラ）は、
//   saveBackToSession（置き直しのたび）と saveCameraToSession（カメラ操作のたび）で
//   常に預けてあるので、どの経路で閉じられても引き継がれる。

// =========================================================================
// セッションのやり直し
//   ★ 親は地球モードを閉じるとき、この画面を破棄せずに隠すだけにしている
//     （タイルも地形も抱えたままにして、次に開いたとき一瞬で戻すため）。
//     そのため「開き直し」＝ページの再読み込みではなく、ここでモデルだけ入れ替える。
// =========================================================================
function disposeUserModel() {
  for (const child of [...userModelGroup.children]) {
    userModelGroup.remove(child);
    child.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
          if (m[k]) m[k].dispose();
        }
        m.dispose();
      }
    });
  }
}

function restartUserModelSession(opts = {}) {
  if (opts.from) fromParam = opts.from;

  disposeUserModel();
  userModelState.present = false;
  userModelState.loaded = false;
  userModelState.error = null;
  userModelState.snapped = false;
  userModelState.provisional = false;
  userModelState.groundY = NaN;
  userModelState.offsetEast = 0;
  userModelState.offsetNorth = 0;
  pendingHandoffCamera = false;
  cameraFollowsGround = false;
  gizmoDragging = false;
  notifiedParent = false;          // 「もう出してよい」を今回のぶん改めて知らせる
  setGizmoMode(gizmoMode);         // モデルが無い状態なので一旦ギズモを外す

  restoreInitialFocus();
  loadUserModel();
  updateUserModelUi();
  if (!userModelState.present) notifyParentReady();
}

// 親の「ポータルに戻る」ボタン（画面左上・固定）と HUD が重なるので、
// iframe に埋め込まれているときだけ HUD を下げる。
if (isEmbedded) document.body.classList.add('embedded');

buildUserModelUi();
restoreInitialFocus();
loadUserModel();
// ※ モデルが無いとき（ポータルからの単独起動）の「準備OK」の通知は main.js の最後で行う。
//   ここで同期的に知らせると、親が折り返しで呼んでくる window.setEarthClipSize などが
//   main.js の本体でまだ定義されておらず、初期値が届かない。

export {
  userModelState, userModelGroup, updateUserModel, resnapUserModel,
  restartUserModelSession, saveBackToSession, saveCameraToSession, notifyParentReady,
};

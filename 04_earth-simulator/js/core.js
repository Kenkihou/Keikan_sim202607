// =============================================================================
// core — 土台。DOM・Three.js の基本セット・全モジュールが共有する状態。
//   ここは他のどのモジュールにも依存しない（依存の向きを一方向に保つため）。
// =============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_CAMERA_DISTANCE } from './config.js';

const container = document.getElementById('app');
const loadingEl = document.getElementById('loading');
const errEl = document.getElementById('err');
const el = (id) => document.getElementById(id);
function showError(msg) {
  errEl.style.display = 'block';
  errEl.textContent = 'エラー: ' + msg;
  console.error(msg);
}

// =========================================================================
// Three.js 基本セット（ここは普通の Three.js。自作モデルもこの scene に足せる）
// =========================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true; // 断面表現などを使う場合に備えて有効化
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1626);
// 霧はカメラを引ける上限に連動させる。
//   ⚠️ 固定値(3000〜9000m)のままカメラ上限を 2000→4000m に広げたら、引いた先で
//     視界のほとんどが霧に沈んで真っ暗になった。上限の 1.5〜4.5 倍を目安にする。
scene.fog = new THREE.Fog(0x0e1626, MAX_CAMERA_DISTANCE * 1.5, MAX_CAMERA_DISTANCE * 4.5);

// 座標系（再配置後）: +Z=北 / +X=西 / +Y=上、単位=メートル
const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 1, 100000,
);
camera.position.set(-220, 300, -300);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2b2f38, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-800, 1200, -600);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

// 作業用グリッド（原点=モデル配置基準。不要なら消してよい）
const grid = new THREE.GridHelper(4000, 80, 0x3b4a63, 0x223046);
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 20;
controls.maxDistance = MAX_CAMERA_DISTANCE;
// パン（平行移動）を有効にする。広域（地形・眺望規制の標高面）を見て回るために必要。
//   ・右ドラッグ、または Shift/Ctrl + 左ドラッグ でパン（OrbitControls の標準動作）
//   ・screenSpacePanning=false なので地面に沿って動く（地図のような操作感）
//   ※ パンで動くのは【注視点(controls.target)】だけで、建物を読む【注目地点(focusLocal)】は
//     動かない。だから遠くへパンしても建物の読み直しは起きない。
//     注目地点自体を移すのは小窓の地図から（setFocusLatLon）。
controls.screenSpacePanning = false;
controls.enablePan = true;
controls.panSpeed = 1.0;
controls.target.set(0, 0, 0);


let hidLoading = false;
function hideLoading() {
  if (hidLoading) return;
  hidLoading = true;
  loadingEl.classList.add('hidden');
  setTimeout(() => (loadingEl.style.display = 'none'), 700);
}

const RETRY_MAX = 3;

// 注目地点（9タイルの中心）。ローカル座標(+X=西/+Y=上/+Z=北, m)。既定は原点=自作モデル位置。
const focusLocal = new THREE.Vector3(0, 0, 0);

// 緯度経度→ローカル座標の変換に使う地球半径[m]（局所ENU近似）
export const EARTH_R = 6378137;

// パンで注視点が遠くへ行ったとき、見る向きと距離を保ったまま注目地点へ戻す。
//   パンを有効にすると迷子になりやすいので、HUD のボタンから呼べるようにしている。
const _recenterOff = new THREE.Vector3();
export function recenterOnFocus() {
  _recenterOff.copy(camera.position).sub(controls.target);   // 今の視点オフセットを保つ
  controls.target.copy(focusLocal);
  camera.position.copy(controls.target).add(_recenterOff);
  controls.update();
}

// ---- 再構築フラグ ------------------------------------------------------------
//   断面や眺望ポリゴンは「変化があったときだけ」作り直す。
//   ★ フラグをここ（最下層）に置くのが要点。タイル側や地形側は
//     section/viewareas を import せずに「汚れた」と伝えられるので、
//     モジュールの依存が循環しない。
//   ★ ゾーンレイヤー（風致地区など）は複数あるので、真偽値ではなく【世代番号】にする。
//     viewareas 側は「前に見た世代と違えば全レイヤーを作り直し待ちに入れる」だけでよく、
//     レイヤーの種類を core が知らずに済む（＝ここに増やす必要がない）。
export const dirty = { section: true, viewArea: false, viewLimit: false, zone: 0, userModel: false };
export const markSectionDirty = () => { dirty.section = true; };
export const markViewAreaDirty = () => { dirty.viewArea = true; };
export const markViewLimitDirty = () => { dirty.viewLimit = true; };
export const markZonesDirty = () => { dirty.zone++; };
// 自作モデル（親アプリから受け取った建物）の置き直し。
//   注目地点が動いたとき・地形が増えたときに接地し直す必要があるので、
//   断面や眺望ポリゴンと同じくフラグで伝える（tiles 側が usermodel を import せずに済む）。
export const markUserModelDirty = () => { dirty.userModel = true; };

export {
  THREE,
  container, loadingEl, errEl, el, showError,
  renderer, scene, camera, controls, sun, grid,
  hideLoading, RETRY_MAX, focusLocal,
};

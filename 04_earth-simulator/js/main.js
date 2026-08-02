// =============================================================================
// main — エントリーポイント。各モジュールを組み立てて描画ループを回す。
//        自作モデルもここに追加する（一番下）。
//
//   依存の向き（下から上へ。循環しない）:
//     config（設定値だけ）
//       └ core（DOM・Three.js基本・共有状態・再構築フラグ）
//           ├ section（切り抜き＋断面）
//           │   ├ tiles（建物・地形・注目地点の移動）
//           │   │   └ ui（左上パネル・右下の地図）
//           │   └ viewareas（眺望空間保全地域）
//           └ main（組み立て・描画ループ・自作モデル）
// =============================================================================
import {
  THREE, renderer, scene, camera, controls, focusLocal,
  hideLoading, dirty, markSectionDirty, markViewAreaDirty, markViewLimitDirty, markZonesDirty,
  markUserModelDirty,
} from './core.js';
import { ORIGIN_ELEVATION, SEA_LEVEL_Y, TILESET_URLS_LOD1, TILESET_URLS_LOD2 } from './config.js';
import {
  clipState, buildingClipPlanes, terrainClipPlanes, clipMeshes, updateClipPlanes,
  sectionFillGroup, soilFillGroup, soilBottomMesh, labelGroup,
  groundLines, groundLineMats, soilContourLines, soilContourMats, soilMats,
  buildSectionFill, getSoilDiag,
} from './section.js';
import {
  wardTiles, focusBox, focusRegion, updateLoadRegion, updateLoadPhase,
  setLoadPhase, getLoadPhase, resetWardTiles, makeWardTiles,
  getTerrainTiles, setFocusLatLon, runEvictBurst, updateTerrainReady, isTerrainReady,
} from './tiles.js';
import {
  viewAreaGroup, viewAreaState, viewAreaLineMat, buildViewAreas, getViewAreaStats,
  buildTerrainHeightGrid, sampleGrid, sampleExcess, lonLatToLocal,
  viewLimitGroup, viewLimitState, buildViewLimits, getViewLimitStats,
  zoneLayers, zoneLineMats, zonesStep, buildZone, setZoneKind, getZoneStats,
} from './viewareas.js';
import { updateHud, setClipSizeFromParent, getClipSize } from './ui.js';
import {
  userModelState, userModelGroup, updateUserModel, resnapUserModel, restartUserModelSession,
  notifyParentReady,
} from './usermodel.js';

// =========================================================================
// リサイズ＆描画ループ（3d-tiles-renderer の標準的な使い方）
// =========================================================================
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Line2 系は画面解像度を知らないと太さが正しく出ない
  for (const m of groundLineMats) m.resolution.set(window.innerWidth, window.innerHeight);
  for (const m of soilContourMats) m.resolution.set(window.innerWidth, window.innerHeight);
  viewAreaLineMat.resolution.set(window.innerWidth, window.innerHeight);
  for (const m of zoneLineMats) m.resolution.set(window.innerWidth, window.innerHeight);
  for (const t of wardTiles) t.setResolutionFromRenderer(camera, renderer);
  const tt = getTerrainTiles();
  if (tt) tt.setResolutionFromRenderer(camera, renderer);
}
window.addEventListener('resize', onResize);

// 作り直しのスロットリング用（描画ループ側の状態なのでここに置く）
let sectionLastBuild = 0;
let viewAreaLastBuild = 0;
// 眺望ポリゴンは【全域を描く】ので、範囲が広いと1回の生成が数百ms かかる
// （実測: 全12地域・約40万三角形で 340ms、切り抜きONなら 17ms）。
// 地形の読み込み中は毎回作り直したくなるので、【前回かかった時間に応じて間隔を延ばす】。
// こうすると重いときほど頻度が落ち、描画がカクつかない。
let viewAreaLastMs = 0;
const VIEW_AREA_MIN_INTERVAL = 500;
const VIEW_AREA_DUTY = 6;      // 生成にかけてよいのは経過時間の 1/6 まで
// ゾーンレイヤー（風致地区・自然風景保全地区）も同じ扱い。
// ★ 眺望ポリゴンとも、レイヤーどうしでも【同じフレームでは作らない】。
//   どれも 500ms 級なので、重なると1フレームが1秒を超えて明確にカクつく。
//   1フレームに1つだけ作って分散させる（レイヤーの順送りは zonesStep が持つ）。
let zoneLastBuild = 0;
let zoneLastMs = 0;

// ★ 親アプリは地球モードを閉じるとき、この画面を破棄せずに隠すだけにしている
//   （読み込んだタイルと地形を抱えたまま待機し、次に開いたとき一瞬で戻すため）。
//   隠れている間に描画ループを回し続けるとモデリング画面のCPUを食うので、
//   ループごと止める（rAF を積まないので完全に停止する）。
let running = true;

function animate() {
  if (!running) return;
  requestAnimationFrame(animate);
  controls.update();
  camera.updateMatrixWorld();
  updateLoadPhase();                        // 第1段（1枚だけ）が済んだら第2段（500m四方）へ
  updateLoadRegion();                       // 注目地点まわりだけ読み込むよう矩形を更新
  updateClipPlanes();                       // 中心の切り抜き（クリップ面・断面板の位置）
  const terrainTiles = getTerrainTiles();
  if (terrainTiles) terrainTiles.update();  // 地形（建物より先に更新。距離制限なし）
  updateTerrainReady();                     // 地形が十分細かくなったら表示に切り替える
  for (const t of wardTiles) t.update();    // 各区：注目地点近傍のタイルだけロード
  runEvictBurst();                          // ※update後（この時点で旧タイルが未使用になる）
  // 断面ポリゴン／地盤ラインを必要なときだけ作り直す（毎フレームだと重いのでスロットル）。
  // タイルが読み込み中は形が変わり続けるので、少し間隔を空けて追従させる。
  if (dirty.section && performance.now() - sectionLastBuild > 200) {
    dirty.section = false;
    sectionLastBuild = performance.now();
    // ⚠️ buildSectionFill は先に sectionFillGroup を空にしてから作り直すので、途中で例外が出ると
    //   「断面が消えたまま」になる。しかも animate 内で投げると以降の renderer.render() も
    //   飛ばされる。1枚の異常なタイルで全体が止まらないよう、ここで受け止めて次回に賭ける。
    try {
      buildSectionFill();
    } catch (err) {
      console.warn('断面の生成に失敗（次のフレームで再試行）:', err);
      markSectionDirty();
    }
  }
  // 眺望空間保全地域の地形沿わせ。地形の高さグリッドを作り直すので断面より重い。
  // 間隔を広めに取り、地形が変わったときと注目地点が動いたときだけ作り直す。
  let heavyDone = false;
  const viewAreaWait = Math.max(VIEW_AREA_MIN_INTERVAL, viewAreaLastMs * VIEW_AREA_DUTY);
  if (dirty.viewArea && performance.now() - viewAreaLastBuild > viewAreaWait) {
    dirty.viewArea = false;
    const t0 = performance.now();
    try {
      buildViewAreas();
    } catch (err) {
      console.warn('眺望空間保全地域の生成に失敗（次のフレームで再試行）:', err);
      markViewAreaDirty();
    }
    viewAreaLastMs = performance.now() - t0;
    viewAreaLastBuild = performance.now();
    heavyDone = true;
  }
  // ゾーンレイヤーの地形沿わせ。1フレームに1レイヤーだけ作る（上のコメント参照）。
  const zoneWait = Math.max(VIEW_AREA_MIN_INTERVAL, zoneLastMs * VIEW_AREA_DUTY);
  if (!heavyDone && performance.now() - zoneLastBuild > zoneWait) {
    const t0 = performance.now();
    let built = false;
    try {
      built = zonesStep();
    } catch (err) {
      console.warn('ゾーンレイヤーの生成に失敗（次のフレームで再試行）:', err);
      markZonesDirty();
      built = true;
    }
    if (built) {
      zoneLastMs = performance.now() - t0;
      zoneLastBuild = performance.now();
    }
  }
  // 自作モデルの置き直し（注目地点への追従＋接地）。地形の高さグリッドを作るが、
  // 半径 60m と狭いので断面より安い。フラグが立ったときだけ。
  if (dirty.userModel) {
    dirty.userModel = false;
    try {
      updateUserModel();
    } catch (err) {
      console.warn('自作モデルの配置に失敗（次のフレームで再試行）:', err);
      markUserModelDirty();
    }
  }
  // 眺望規制の標高面。地形に依存しないので、切り替えと注目地点の移動のときだけ作り直す。
  if (dirty.viewLimit) {
    dirty.viewLimit = false;
    try {
      buildViewLimits();
    } catch (err) {
      console.warn('眺望規制面の生成に失敗（次のフレームで再試行）:', err);
      markViewLimitDirty();
    }
  }
  const visible = updateHud();
  if (visible > 0) hideLoading();
  renderer.render(scene, camera);
}

setLoadPhase(0);   // 起動時も「まず指定地点のタイル1枚」から
animate();

// =========================================================================
// 親アプリ（01）から呼ばれる待機・再開の入口。
//   閉じる  → pauseEarthSimulator()  : 描画ループを止めるだけ。タイルは抱えたまま。
//   開き直す → resumeEarthSimulator() : ループを回し直し、自作モデルだけ入れ替える。
//   ※ ページを読み直さないので、2回目以降の切り替えは街並みの再読み込みが起きない。
// =========================================================================
window.pauseEarthSimulator = function() {
  running = false;
};

// 親アプリ下部の切り抜きスライダーと双方向でつなぐための入口
window.setEarthClipSize = (m) => setClipSizeFromParent(m);
window.getEarthClipSize = () => getClipSize();

window.resumeEarthSimulator = function(opts = {}) {
  if (!running) {
    running = true;
    animate();
  }
  // 画面サイズが変わっている可能性があるので、隠れている間の変化を取り込む
  onResize();
  restartUserModelSession(opts);
};

// デバッグ用（コンソールから描画状態を確認できるように公開）
window.__dbg = {
  renderer, scene, camera, controls, focusRegion, focusBox, focusLocal,
  updateLoadRegion, setFocusLatLon,
  wardTiles, getTerrainTiles,
  setLoadPhase, getLoadPhase, resetWardTiles, makeWardTiles,
  clipState, buildingClipPlanes, terrainClipPlanes, clipMeshes, updateClipPlanes,
  groundLines, groundLineMats, soilFillGroup, soilMats, soilBottomMesh,
  soilContourLines, soilContourMats, labelGroup,
  ORIGIN_ELEVATION, SEA_LEVEL_Y, THREE, TILESET_URLS_LOD1, TILESET_URLS_LOD2,
  sectionFillGroup, buildSectionFill, markSectionDirty, getSoilDiag,
  viewAreaGroup, viewAreaState, buildViewAreas, markViewAreaDirty,
  buildTerrainHeightGrid, sampleGrid, sampleExcess, lonLatToLocal, getViewAreaStats,
  viewLimitGroup, viewLimitState, buildViewLimits, getViewLimitStats, markViewLimitDirty,
  zoneLayers, zonesStep, buildZone, setZoneKind, getZoneStats, markZonesDirty,
  isTerrainReady,
  userModelState, userModelGroup, updateUserModel, resnapUserModel, markUserModelDirty,
  render: () => renderer.render(scene, camera),
};
window.__plateauWards = wardTiles;   // 互換用
window.__plateauTiles = wardTiles[5];

// モデルを受け取っていないとき（ポータルからの単独起動）は待たせる理由がないので即座に出す。
// ★ここまで下げてあるのが要点：親は合図を受け取った折り返しで window.setEarthClipSize などを
//   呼んでくるので、window.* の入口を全部作り終えてから知らせる。
if (!userModelState.present) notifyParentReady();

// =========================================================================
// 自作モデルは usermodel.js が受け持つ（親アプリ 01_building-builder から GLB で受け取り、
// 注目地点の地形に接地させて置く）。手書きのモデルをここに足すこともできる:
//
//   ・座標系: 原点(0,0,0)=config.js で指定した緯度経度の地表、+Y=上、+Z=北、+X=西、単位=メートル。
//   ・PLATEAU 建物と同じ scene・同じ renderer なので、通常の Three.js のように
//     メッシュ追加・カスタムマテリアル・ステンシル・クリッピング断面などが使えます。
//   ・renderer は stencil:true / localClippingEnabled=true 済み。
// =========================================================================

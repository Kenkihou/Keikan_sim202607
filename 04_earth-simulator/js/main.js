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
  markUserModelDirty, markMountainsDirty,
  setFrameScheduler, requestRender, isRenderHeld, updateFog, resetCamera,
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
  reloadAllTiles, tilesBusy, isEvictBursting, setFocusChangeHandler,
} from './tiles.js';
import {
  viewAreaGroup, viewAreaState, viewAreaLineMat, buildViewAreas, getViewAreaStats,
  buildTerrainHeightGrid, sampleGrid, sampleExcess, lonLatToLocal,
  viewLimitGroup, viewLimitState, buildViewLimits, getViewLimitStats,
  zoneLayers, zoneLineMats, zonesStep, zonesPending, buildZone, setZoneKind, getZoneStats,
} from './viewareas.js';
import { updateHud, setClipSizeFromParent, getClipSize, setPickerCenter } from './ui.js';
import { rebuildBuildingSection, profileState, setEnabled as setProfileEnabled, setSectionLat } from './profile.js';
// 建物を1棟ずつ編集する（クリック選択・透過・非表示・高さ変更）。
// 読み込むだけで UI と操作を自前で組み立てる（tiles.js へはフックを差し込む方式）。
import { editState as buildingEditState, resetAll as resetBuildingEdits, updateSelectionBox } from './buildingedit.js';
// 建物を「後退面より外側だけ」削る／「両側を残して切って片側ずつ高さを変える」。
// 読み込むだけで UI と、タイルへのフックを自前で組み立てる。
import { updateSetbackGuide } from './buildingsetback.js';
// 跡地の検討用に、地面へ箱を置く（04 の中だけで完結する簡易モデル）。
// 読み込むだけで UI と操作を自前で組み立てる。
import './blocks.js';
// 地球モードの検討内容を 01 のセーブJSONへ渡す入口（window.getEarthEditState）
import './savestate.js';
// 画面に浮いているパネル（建物の編集・床面積・箱）を見出しのドラッグで動かせるようにする。
// 読み込むだけで対象パネルへ自分で取り付く。
import './panelmove.js';
// 街の屋根を1枚のスクリーンに見立てて文字を流す（読み込むだけでUIと配線を自前で持つ）。
import { roofTextState, updateRoofText } from './rooftext.js';
// PLATEAU の道路データ（tran / MVT）を地形に投影して光らせる。既定はOFF。
import { roadsBusy, initRoadUi, refreshRoadRange } from './roads.js';
// 足跡を道路に落として、その場に立って歩き回るモード（👣ボタン）。
import { streetViewState, initStreetView, updateStreetView } from './streetview.js';
import {
  mountainGroup, mountainState, buildMountains, updateMountainVisibility,
} from './mountains.js';
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
// 山名ラベルも高さグリッドを作るので同じ扱い（作り直しの間隔を実測時間に連動させる）
let mountainsLastBuild = 0;
let mountainsLastMs = 0;
const MOUNTAIN_MIN_INTERVAL = 800;
const MOUNTAIN_DUTY = 6;

// ★ 親アプリは地球モードを閉じるとき、この画面を破棄せずに隠すだけにしている
//   （読み込んだタイルと地形を抱えたまま待機し、次に開いたとき一瞬で戻すため）。
//   隠れている間に描画ループを回し続けるとモデリング画面のCPUを食うので、
//   ループごと止める（rAF を積まないので完全に停止する）。
let running = true;

// =========================================================================
// オンデマンド描画のスケジューラ
//   ★ requestAnimationFrame を無条件に積み直さない。1フレーム描き終えたら
//     「まだ絵が変わる理由があるか」を needsMoreFrames() で確かめ、
//     無ければ rAF を積まずに眠る（＝CPU/GPU の消費がゼロになる）。
//   ★ 眠りから起こすのは core.js の requestRender()。カメラ操作・HUD の操作・
//     タイルの到着（mark〇〇Dirty）など、絵が変わりうる出来事すべてがここに繋がっている。
// =========================================================================
let rafId = 0;
function scheduleFrame() {
  if (rafId || !running) return;
  rafId = requestAnimationFrame(animate);
}
setFrameScheduler(scheduleFrame);

// まだフレームを回し続ける必要があるか。
//   ここに挙げたものは「人が触っていなくても絵が変わり続ける」条件。
//   どれにも当たらなければ、次の操作まで完全に止まってよい。
function needsMoreFrames() {
  if (roofTextState.enabled) return true;                // 屋根テキストが流れている（常に絵が変わる）
  if (isRenderHeld()) return true;                       // 直近の操作・到着からの余韻
  if (dirty.section || dirty.viewArea || dirty.viewLimit
      || dirty.userModel || dirty.mountains) return true; // 作り直し待ち（スロットル中を含む）
  if (zonesPending()) return true;                        // ゾーンレイヤーの作り直し待ち
  if (getLoadPhase() === 0) return true;                  // 第1段（中心1枚）の判定中
  if (getTerrainTiles() && !isTerrainReady()) return true; // 地形が十分細かくなるのを待っている
  if (isEvictBursting()) return true;                     // 古いタイルの掃き出し中
  if (tilesBusy()) return true;                           // 取得中・解析中のタイルがある
  if (roadsBusy()) return true;                           // 道路モデルを取得中
  if (streetViewState.active) return true;                // ストリートビューで歩いている
  return false;
}

function animate() {
  rafId = 0;
  if (!running) return;
  // ⚠️ OrbitControls.update() は enabled=false でも【カメラの位置と向きを毎フレーム
  //   上書きする】（注視点からの球座標で position を作り直し、lookAt を掛ける）。
  //   enabled が止めるのは入力の受け付けだけ。ストリートビュー中はこちらがカメラを
  //   持っているので、呼ぶと見回しも進行方向も毎フレーム打ち消されてしまう。
  if (!streetViewState.active) controls.update();
  camera.updateMatrixWorld();
  updateFog();                              // 霧の距離を今のカメラ距離に合わせる
  updateLoadPhase();                        // 第1段（1枚だけ）が済んだら第2段（500m四方）へ
  updateLoadRegion();                       // 注目地点まわりだけ読み込むよう矩形を更新
  updateClipPlanes();                       // 中心の切り抜き（クリップ面・断面板の位置）
  updateRoofText(performance.now());        // 屋根テキストの流れ（ONのときだけ動く）
  updateStreetView(performance.now());      // ストリートビューの歩き（立っている間だけ動く）
  updateSetbackGuide();                     // 壁面後退の面ガイド（選択が変わったときだけ描き直す）
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
    // 縦断図の建物断面も同じ登録簿（clipMeshes）から作っているので、建物タイルが
    // 増減したこのタイミングで作り直す。dirty.section は箱庭断面の表示状態とは無関係に
    // タイルの読込／破棄で立つので、「建物が変わった」の合図としてちょうどよい。
    try {
      rebuildBuildingSection();
    } catch (err) {
      console.warn('縦断図の建物断面の生成に失敗:', err);
    }
    // 選択中の建物の枠も、タイルが入れ替われば位置・大きさを測り直す
    // （LOD が切り替わると同じ建物でも頂点が別物になるため）。
    if (buildingEditState.selected) {
      try { updateSelectionBox(); } catch (err) { console.warn('選択枠の更新に失敗:', err); }
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
  // 山名ラベルの置き直し（地形の面に合わせるので、地形が細かくなるたびに引き直す）。
  //   高さグリッドを1枚作るので断面より重い。前回かかった時間に応じて間隔を空ける
  //   （眺望ポリゴンと同じ考え方。重い日は自動的に頻度が落ちる）。
  const mountainWait = Math.max(MOUNTAIN_MIN_INTERVAL, mountainsLastMs * MOUNTAIN_DUTY);
  if (dirty.mountains && performance.now() - mountainsLastBuild > mountainWait) {
    dirty.mountains = false;
    const t0 = performance.now();
    try {
      buildMountains();
    } catch (err) {
      console.warn('山名ラベルの配置に失敗（次のフレームで再試行）:', err);
      markMountainsDirty();
    }
    mountainsLastMs = performance.now() - t0;
    mountainsLastBuild = performance.now();
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
  updateMountainVisibility();   // カメラが近づいた山名だけを出す（位置の計算は不要なので軽い）
  const visible = updateHud();
  if (visible > 0) hideLoading();
  renderer.render(scene, camera);
  if (needsMoreFrames()) scheduleFrame();   // ★ 必要なときだけ次のフレームを積む
}

setLoadPhase(0);   // 起動時も「まず指定地点のタイル1枚」から
requestRender();   // 最初の1フレームを起こす（あとは needsMoreFrames が繋いでいく）

// =========================================================================
// 親アプリ（01）から呼ばれる待機・再開の入口。
//   閉じる  → pauseEarthSimulator()  : 描画ループを止めるだけ。タイルは抱えたまま。
//   開き直す → resumeEarthSimulator() : ループを回し直し、自作モデルだけ入れ替える。
//   ※ ページを読み直さないので、2回目以降の切り替えは街並みの再読み込みが起きない。
// =========================================================================
window.pauseEarthSimulator = function() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
};

// 親アプリ下部の切り抜きスライダーと双方向でつなぐための入口
window.setEarthClipSize = (m) => setClipSizeFromParent(m);
window.getEarthClipSize = () => getClipSize();

// 親アプリ下部バーの「断面」ボタン（切り抜きスライダーの右）と双方向でつなぐ入口。
//   30km の東西断面（縦断図）の表示・非表示は、左上パネルではなくこちらだけで操作する。
window.setEarthProfileOn = (on) => setProfileEnabled(!!on);
window.getEarthProfileOn = () => profileState.enabled;

// ★ 親アプリが「ポータルに戻る」たびに呼ぶ入口。
//   この画面は破棄せず隠して待機させているので、明示的に戻さないと
//   次にポータルから単独起動したとき前回いじった視点のまま始まってしまう。
window.resetEarthCamera = () => resetCamera();

window.resumeEarthSimulator = function(opts = {}) {
  running = true;
  // 画面サイズが変わっている可能性があるので、隠れている間の変化を取り込む
  onResize();
  restartUserModelSession(opts);
  requestRender();   // 眠っていた描画ループを起こす
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
  isTerrainReady, reloadAllTiles, tilesBusy, requestRender, needsMoreFrames,
  userModelState, userModelGroup, updateUserModel, resnapUserModel, markUserModelDirty,
  mountainGroup, mountainState, buildMountains, updateMountainVisibility, markMountainsDirty,
  buildingEditState, resetBuildingEdits, updateSelectionBox,
  render: () => renderer.render(scene, camera),
};
window.__plateauWards = wardTiles;   // 互換用
window.__plateauTiles = wardTiles[5];

// 注目地点が動いたら、右下の地図の表示範囲と東西断面の緯度を追従させる。
//   ★ 以前は断面線が原点の緯度に固定だったため、注目地点を動かすと「建物タイルは
//     読み込まれているのに断面線とずれていて何も切れない」という食い違いが起きた。
setFocusChangeHandler((latDeg, lonDeg) => {
  setPickerCenter(latDeg, lonDeg);
  setSectionLat(latDeg);
  refreshRoadRange();   // 道路は注目地点まわりだけ読むので、移動先のぶんを取りに行かせる
});

initRoadUi();
initStreetView();

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

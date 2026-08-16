// =============================================================================
// tiles — PLATEAU のデータ読み込み全般。
//   ・建築物タイル（全11区）… 注目地点まわりの矩形だけ・2段階ロード
//   ・地形タイル（Quantized Mesh）＋ 航空写真／地図のオーバーレイ
//   ・注目地点の移動 … 変えたら「その地点が初期地点であるかのように」読み直す
// =============================================================================
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  ReorientationPlugin, GLTFExtensionsPlugin, TilesFadePlugin,
  QuantizedMeshPlugin, ImageOverlayPlugin, XYZTilesOverlay,
  LoadRegionPlugin, OBBRegion,
} from '3d-tiles-renderer/plugins';
import { OBB } from '3d-tiles-renderer/three';
import {
  THREE, scene, camera, renderer, controls, focusLocal, EARTH_R,
  hideLoading, RETRY_MAX, markSectionDirty, markViewAreaDirty, markZonesDirty, markUserModelDirty,
  markMountainsDirty,
} from './core.js';
import {
  WARD_TILESETS,
  ORIGIN_LAT, ORIGIN_LON, ORIGIN_HEIGHT,
  LOCAL_WIDTH_EW, LOCAL_WIDTH_NS, LOCAL_HEIGHT,
  SEED_WIDTH, SEED_IDLE_MS, SEED_TIMEOUT_MS,
  SHOW_TERRAIN, TERRAIN_URL, TERRAIN_VERTICAL_OFFSET, IMAGERY, DEFAULT_IMAGERY,
  HEIGHT_BANDS, SEA_LEVEL_Y,
  ELEVATION_TINT_STOPS, ELEVATION_TINT_RANGE, ELEVATION_TINT_DEFAULT_STEP,
  ELEVATION_TINT_LINE_STRENGTH,
} from './config.js';
import {
  CAP_COLOR, buildingClipPlanes, terrainClipPlanes, clipMeshes,
  registerClipMeshes, unregisterClipMeshes, computeClipMeshWorld,
} from './section.js';

//   （手動キュー駆動などの小細工はしない＝実ブラウザで滑らかに順次描画される）
// =========================================================================
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/libs/draco/gltf/');

// テクスチャを最大 MAX_TEX_SIZE px に縮小してメモリを抑える（LOD2テクスチャは巨大なため）。
const MAX_TEX_SIZE = 512;
const _texCanvas = document.createElement('canvas');
const _texCtx = _texCanvas.getContext('2d');
function downscaleTexture(tex) {
  if (!tex || !tex.image) return;
  const img = tex.image;
  const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
  if (!w || !h) return;
  const scale = MAX_TEX_SIZE / Math.max(w, h);
  if (scale >= 1) return;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  _texCanvas.width = cw; _texCanvas.height = ch;
  _texCtx.clearRect(0, 0, cw, ch);
  try { _texCtx.drawImage(img, 0, 0, cw, ch); } catch (e) { return; }
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(_texCanvas, 0, 0);
  if (img.close) { try { img.close(); } catch (e) {} }
  tex.image = out;
  tex.needsUpdate = true;
}


//   （＝断面ポリゴンと色味が揃う）。map より後に上書きするのが要点。
//   ⚠️ onBeforeCompile を使うので customProgramCacheKey を必ず添える。無いと、
//     同じ材質クラス・同じ設定の【断面ポリゴン用マテリアル】とプログラムが混線しうる
//     （テクスチャの無い建物マテリアルはキーの材料が断面用とほぼ同じになる）。
const capColorLinear = new THREE.Color(CAP_COLOR); // three は色管理ONなので線形値が入る
function makeInteriorCap(m) {
  if (m.__interiorCap) return;
  m.__interiorCap = true;
  // ※ 既定の customProgramCacheKey は onBeforeCompile の全文を返すので、そのまま連結すると
  //   キーが巨大になる。プラグインが【自前で】設定していた場合だけ引き継ぐ。
  const ownKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')
    ? m.customProgramCacheKey : null;
  m.customProgramCacheKey = function () {
    return 'interiorCap|' + (ownKey ? ownKey.call(this) : '');
  };
  const prev = m.onBeforeCompile; // フェード等の既存改造を壊さないよう連結する
  m.onBeforeCompile = function (shader, rendererRef) {
    if (prev) prev.call(this, shader, rendererRef);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      if ( !gl_FrontFacing ) {
        diffuseColor.rgb = vec3(${capColorLinear.r}, ${capColorLinear.g}, ${capColorLinear.b});
      }`,
    );
  };
  m.needsUpdate = true;
}

// 建物マテリアルの調整＋テクスチャ縮小（全区共通）。
function styleBuildingModel(modelScene) {
  modelScene.traverse((c) => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) {
        m.side = THREE.DoubleSide; // 内側も描く（切り口を見せるために必須）
        if ('metalness' in m) m.metalness = 0.0;
        if ('roughness' in m) m.roughness = 0.85;
        m.clippingPlanes = buildingClipPlanes; // 中心の箱で切り抜く
        makeInteriorCap(m);                    // 切ると見える内側を断面と同じ灰色にする
        downscaleTexture(m.map);
        if (m.map) m.map.anisotropy = 4;
      }
    }
  });
}

// ---- 建物の個別編集（buildingedit.js）のフック --------------------------------
//   タイルは読み込み・破棄・LOD切替を繰り返すので、編集（透過・非表示・高さ変更）は
//   「タイルが届くたびに当て直す」必要がある。ここで buildingedit.js に処理を渡す。
//   ★ 直接 import すると tiles ↔ buildingedit で循環参照になる（buildingedit は
//     レイキャストのために wardTiles を使う）。関数を差し込む形にして向きを一方向に保つ。
let buildingEditHook = null;
function setBuildingEditHook(fn) { buildingEditHook = fn; }

// ---- 注目地点が動いたときの通知先 --------------------------------------------
//   右下の地図の表示範囲と、東西断面の緯度を注目地点に追従させるために使う。
//   ★ ここも直接 import せず差し込みにする（ui.js は tiles.js を import しているので
//     逆向きに import すると循環参照になる）。
let focusChangeHandler = null;
function setFocusChangeHandler(fn) { focusChangeHandler = fn; }

// ---- 屋根テキスト（rooftext.js）のフック ------------------------------------
//   屋根面にテキストを投影するシェーダは、建物マテリアルへ後から差し込む方式なので、
//   タイルが届くたびに当て直す必要がある（建物編集フックと同じ理由）。
let roofTextHook = null;
function setRoofTextHook(fn) { roofTextHook = fn; }

// ---- 建物の見せ方（テクスチャ／高さ色分け／白モデル）--------------------------
// 白モデルの色。真っ白(0xffffff)だと陰影が飛んで形が読めないので、ごく僅かに落とす。
const BUILDING_WHITE = 0xf2f2f2;

//   PLATEAU の b3dm には建物ごとの属性表（batchTable）と、頂点がどの建物に属するかを示す
//   `_batchid` 属性が入っている。これを使って建物単位で色を付ける。
//   ★ 頂点カラー方式にしている（`color` 属性を書いて material.vertexColors = true）。
//     ジオメトリを分割しないので【ドローコール数も三角形数も増えない】＝描画コストは不変。
//     実測: 102メッシュ・89.6万頂点・建物16,228件の着色で 59ms（1タイルあたり約0.6ms）。
//     追加メモリは頂点あたり12バイト（実測 10.25MB）。
//   ※ シェーダで `_batchid` からルックアップテクスチャを引けばメモリはほぼゼロにできるが、
//     断面の灰色（makeInteriorCap の onBeforeCompile）と連結する手間が増えるので採らない。
// 'default'（PLATEAUのテクスチャ）/ 'height'（高さで色分け）/ 'white'（真っ白）
const buildingColorState = { mode: 'default' };

// この建物（batchid）の高さ[m]を返す配列を作る。
//   1) 属性 bldg:measuredHeight があればそれを使う
//   2) 無ければ `_batchid` ごとの鉛直方向の広がり（＝モデルの高さ）で代用する
//      PLATEAU の建物は地盤から立ち上がっているので、この値がそのまま高さになる。
//
//   ⚠️⚠️ ジオメトリ空間の Y は鉛直ではない。b3dm の中身は ECEF 系なので、
//     geometry の +Y は「地球の Y 軸」であって「上」ではない。京都(北緯35°/東経135.8°)では
//     鉛直方向の ECEF-Y 成分は約0.57しかなく、しかも建物の【水平方向の広がり】が Y に
//     大きく混入する。実測: 属性18.9mの建物の geometry-Y 幅が 124.5m、
//     属性130.5m(京都タワー)で 82.6m というように全く対応しなかった。
//     → 必ず【ワールド行列を掛けてから】Y範囲を測ること（ワールドでは +Y=上）。
//   ⚠️ もう一点。1つの建物のジオメトリは【タイル内の複数メッシュに分かれる】ことがある
//     （マテリアルごとに分割されるため）。メッシュ単位で Y 範囲を取ると、屋根だけ・
//     壁だけといった断片になって高さが 0 や過小になる（実測でも 0 が多発した）。
//     → タイル（modelScene）全体で batchid ごとに集計してから高さを決めること。
const _bhWorld = new THREE.Matrix4();
function buildingHeightsForScene(modelScene, attrH, batchCount, updatedRoots) {
  const n = batchCount || 1;
  const ymin = new Float64Array(n).fill(Infinity);
  const ymax = new Float64Array(n).fill(-Infinity);
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
    if (!pos) return;
    const hasWorld = computeClipMeshWorld(mesh, _bhWorld, updatedRoots);
    const e = _bhWorld.elements;
    for (let i = 0; i < pos.count; i++) {
      const b = bid ? bid.getX(i) : 0;
      if (b >= n) continue;
      const x = pos.getX(i), y0 = pos.getY(i), z = pos.getZ(i);
      // ワールドの Y だけが要るので、行列の2行目だけ適用する
      const y = hasWorld ? (e[1] * x + e[5] * y0 + e[9] * z + e[13]) : y0;
      if (y < ymin[b]) ymin[b] = y;
      if (y > ymax[b]) ymax[b] = y;
    }
  });
  const out = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const a = attrH ? Number(attrH[b]) : NaN;
    out[b] = Number.isFinite(a) && a > 0 ? a : (ymax[b] - ymin[b]);
  }
  return out;
}

const _bandColor = new THREE.Color();
// 高さ→色の `color` 属性を作ってジオメトリに持たせる（一度作ったら使い回す）。
function ensureHeightColorAttribute(modelScene) {
  const bt = modelScene.batchTable;
  let attrH = null;
  if (bt) { try { attrH = bt.getData('bldg:measuredHeight'); } catch (e) { attrH = null; } }
  const updatedRoots = new Set();
  // タイル内の建物数。batchTable の count を基本に、実データからも念のため確認する。
  let n = bt && bt.count ? bt.count : 1;
  modelScene.traverse((mesh) => {
    const bid = mesh.isMesh && mesh.geometry && mesh.geometry.attributes._batchid;
    if (!bid) return;
    let mx = 0;
    for (let i = 0; i < bid.count; i++) { const v = bid.getX(i); if (v > mx) mx = v; }
    n = Math.max(n, mx + 1);
  });
  // ★ タイル全体で集計してから高さを決める（建物が複数メッシュに分かれるため）
  const heights = buildingHeightsForScene(modelScene, attrH, n, updatedRoots);
  // 建物ごとの色を先に決めておく（頂点ごとに帯を探索しないで済むように）
  const rgb = new Float32Array(n * 3);
  for (let b = 0; b < n; b++) {
    const h = heights[b];
    let band = HEIGHT_BANDS[HEIGHT_BANDS.length - 1];
    for (const bd of HEIGHT_BANDS) if (h <= bd.max) { band = bd; break; }
    _bandColor.setHex(band.color);
    rgb[b * 3] = _bandColor.r; rgb[b * 3 + 1] = _bandColor.g; rgb[b * 3 + 2] = _bandColor.b;
  }
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    if (!g || !g.attributes.position || g.__heightColorAttr) return;
    const pos = g.attributes.position, bid = g.attributes._batchid;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const b = bid ? Math.min(bid.getX(i), n - 1) : 0;
      col[i * 3] = rgb[b * 3]; col[i * 3 + 1] = rgb[b * 3 + 1]; col[i * 3 + 2] = rgb[b * 3 + 2];
    }
    g.__heightColorAttr = new THREE.BufferAttribute(col, 3);
  });
}

// 1タイルぶんのマテリアルを、建物の見せ方（'default' / 'height' / 'white'）に合わせる。
//   default … PLATEAU のテクスチャそのまま
//   height  … 高さで色分け（頂点カラー。テクスチャとは排他）
//   white   … LOD2 のテクスチャも外して真っ白にする（形だけを見たいとき用）
function applyBuildingColorMode(modelScene) {
  const mode = buildingColorState.mode;
  if (mode === 'height') ensureHeightColorAttribute(modelScene);
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.material) return;
    const g = mesh.geometry;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.__origMap === undefined) m.__origMap = m.map || null;   // 元のテクスチャを覚えておく
      if (mode === 'height') {
        if (g.__heightColorAttr) g.setAttribute('color', g.__heightColorAttr);
        m.map = null;              // テクスチャは外す（色分けと排他）
        m.vertexColors = true;
        m.color.setHex(0xffffff);  // 頂点カラーは乗算されるので白にしておく
      } else if (mode === 'white') {
        g.deleteAttribute('color');
        m.map = null;              // ★テクスチャを外すのが要点（LOD2でも真っ白になる）
        m.vertexColors = false;
        m.color.setHex(BUILDING_WHITE);
      } else {
        g.deleteAttribute('color');
        m.map = m.__origMap;
        m.vertexColors = false;
        m.color.setHex(0xffffff);
      }
      m.needsUpdate = true;        // vertexColors / map の変更はシェーダの再コンパイルが要る
    }
  });
}

// 読み込み済みの全建物に反映する（切り替え操作時）。
function setBuildingColorMode(mode) {
  buildingColorState.mode = mode;
  for (const t of wardTiles) t.forEachLoadedModel((modelScene) => applyBuildingColorMode(modelScene));
}

// 注目地点まわりの「約9タイル」だけを読み込むための矩形(OBB)マスク。全区で同じインスタンスを
// 共有し、毎フレーム updateLoadRegion() で位置を更新する。calculateError=0 で純粋な範囲マスク。
//   OBB は「箱形状(box)」と「箱をワールドへ配置する行列(transform)」に分かれる。
//   box は東西/南北/鉛直の半幅を持つ原点中心の直方体として一度だけ作る（サイズ固定）。
//   transform は毎フレーム、注目地点の位置に合わせて更新する（下記 updateLoadRegion）。
const focusBox = new THREE.Box3(
  new THREE.Vector3(-LOCAL_WIDTH_EW / 2, -LOCAL_HEIGHT / 2, -LOCAL_WIDTH_NS / 2),
  new THREE.Vector3(LOCAL_WIDTH_EW / 2, LOCAL_HEIGHT / 2, LOCAL_WIDTH_NS / 2),
);
// 純粋な範囲マスク（この外は一切読まない）。精細度は各区の errorTarget に任せるため
// calculateError は 0 を返す＝初回読み込み時とまったく同じ条件で読み込ませる。
//   ※「遠方は粗く／近傍は高精細」の2段リージョン構成も試したが、注目エリアの詳細タイルが
//     いつまでも表示に上がらず（実測 nearLeaf=0）体感が悪化したので採用しなかった。
//     範囲自体を絞る方が単純で確実。
const focusRegion = new OBBRegion({ mask: true, obb: new OBB(focusBox) });
focusRegion.calculateError = () => 0;

// ---- 2段階ロードの状態 ----------------------------------------------------
//   loadPhase 0 : 指定地点を含むタイル1枚（＋その祖先）だけ
//   loadPhase 1 : 500m 四方に広げて、足りない周辺タイルを足す
//   ※ 精細度や優先度はいじらない。触るのは「読む範囲」だけ（＝過去に効果が確認できた唯一の
//     レバー。優先度コールバックは REPLACE 細分化と噛み合わず逆効果だった）。
let loadPhase = -1;      // -1 = 未設定（setLoadPhase で必ず初期化する）
let seedStartMs = 0;     // 第1段を開始した時刻
let seedBusyMs = 0;      // 第1段で最後にキューが空でなかった時刻
function setLoadPhase(phase) {
  if (loadPhase === phase) return;
  loadPhase = phase;
  const halfEW = (phase === 0 ? SEED_WIDTH : LOCAL_WIDTH_EW) / 2;
  const halfNS = (phase === 0 ? SEED_WIDTH : LOCAL_WIDTH_NS) / 2;
  // ⚠️ OBBRegion はコンストラクタで OBB をコピーして持つので、focusBox ではなく
  //    リージョン自身の obb.box を書き換える必要がある（transform と同じ罠）。
  focusRegion.obb.box.min.set(-halfEW, -LOCAL_HEIGHT / 2, -halfNS);
  focusRegion.obb.box.max.set(halfEW, LOCAL_HEIGHT / 2, halfNS);
  focusRegion.obb.update();
  if (phase === 0) { seedStartMs = seedBusyMs = performance.now(); }
}

// 第1段が済んだら第2段へ進める。animate から毎フレーム呼ぶ。
//   「済んだ」＝キュー・DL・パースがすべて空（＝読めるものは読み切った）。
//   ⚠️ 判定はフレーム数ではなく【時間】で行う。3D Tiles の走査は外部 tileset JSON を
//     読み込んで初めて子タイルが見えるので、「1枚読み終えた直後・次を積む前」に
//     pending が一瞬 0 になる瞬間がある。数フレームでは通信の往復に足りず、
//     まだ降りている途中で第2段へ進んでしまう。
//   1枚も読めないまま止まる可能性（恒久的な404など）に備えてタイムアウトも置く。
function updateLoadPhase() {
  if (loadPhase !== 0) return;
  const now = performance.now();
  let pending = 0, loaded = 0;
  for (const t of wardTiles) {
    const s = t.stats;
    pending += (s.queued || 0) + (s.downloading || 0) + (s.parsing || 0);
    loaded += (s.loaded || 0);
  }
  // root JSON の取得中はまだ pending が 0 のことがあるので「1枚以上読めた」も条件にする。
  if (pending > 0 || loaded === 0) seedBusyMs = now;
  if (now - seedBusyMs > SEED_IDLE_MS || now - seedStartMs > SEED_TIMEOUT_MS) setLoadPhase(1);
}

// ★ 同時ダウンロード数を「本体転送まで含めて」正しく制限するためのプラグイン。
//
//   ⚠️ ライブラリ標準のままだと downloadQueue.maxJobs が効くのは
//     【fetch() のヘッダ受信まで】で、本体（5〜7MBのb3dm）の転送はキューの外で
//     無制限に並列実行される:
//         downloadQueue.add(tile, () => fetchData(...))   ← ヘッダで解決
//           .then(res => res.arrayBuffer())               ← 本体はキュー外
//     そのため地図で場所を移すと、移動先の作業セット（数十枚）の本体が一斉に流れて
//     共倒れになり、「キューは空なのに stats.downloading が何十秒も減らない」
//     ＝建物がほとんど出てこない状態になっていた（実測で確認）。
//
//   → fetchData で arrayBuffer() まで読み切ってから解決すれば、
//     1タイルのDLがキューの1ジョブに収まり maxJobs が本来の意味で効く。
//     読み終えたバイト列は Response に包み直して返すので後段の処理は変更不要。
function makeFullBodyFetchPlugin() {
  return {
    name: 'FULL_BODY_FETCH_PLUGIN',
    priority: -100, // plugins は priority 昇順。fetchData を最優先で担当する
    fetchData(url, options) {
      return (async () => {
        const res = await fetch(url, options);
        // エラーや本体を持てないステータスはそのまま返し、既存のエラー処理に任せる
        if (!res.ok || res.status === 204 || res.status === 205 || res.status === 304) return res;
        const buf = await res.arrayBuffer();
        const headers = new Headers();
        const ct = res.headers.get('content-type');
        if (ct) headers.set('content-type', ct);
        return new Response(buf, { status: 200, statusText: 'OK', headers });
      })();
    },
  };
}

// 1区分の TilesRenderer を作る。全区とも同じ緯度経度で整列するので同一ワールドに載る。
// 全区に focusRegion を付けるので、注目地点を含む区だけがその近傍タイルを読む
// （他区は root が矩形に触れず何も読まない＝軽い）。
function makeWardTiles(url) {
  const t = new TilesRenderer(url);
  t.registerPlugin(makeFullBodyFetchPlugin());                // 本体転送まで maxJobs で律速させる
  t.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader })); // b3dm内 glTF の Draco 対応
  t.registerPlugin(new TilesFadePlugin());                    // タイルのフェードイン
  t.registerPlugin(new ReorientationPlugin({                  // 原点・上方向の整列（全区共通）
    lat: ORIGIN_LAT, lon: ORIGIN_LON, height: ORIGIN_HEIGHT,
  }));
  const rp = new LoadRegionPlugin();                          // 注目地点まわりだけ読む
  t.registerPlugin(rp);
  rp.addRegion(focusRegion);   // 指定地点まわり 1km 四方だけ読む
  t.setCamera(camera);
  t.setResolutionFromRenderer(camera, renderer);
  t.errorTarget = 16; // 小さいほど高精細＝タイル数増（12〜16 が快適）
  // 粗い祖先タイルを先に出して徐々に精細化（root=201KB / 中間=324KB〜1MB / 葉=5〜7MB と
  // 上位が桁違いに軽いので、注目地点の中心からすぐ描画が始まる）。
  t.loadAncestors = true;
  t.addEventListener('load-model', ({ scene: modelScene, tile }) => {
    styleBuildingModel(modelScene);
    registerClipMeshes(modelScene, false, tile, t.group);
    // ⚠️ 着色は registerClipMeshes の後。高さの算出にワールド行列が要り、
    //   その復元に __clipRoot / __clipGroup（登録時に付与）を使うため。
    if (buildingColorState.mode !== 'default') applyBuildingColorMode(modelScene);
    // 個別編集（透過・非表示・高さ）を当て直す。タイルは何度も出入りするので毎回必要。
    if (buildingEditHook) {
      try { buildingEditHook(modelScene); }
      catch (err) { console.warn('建物編集の再適用に失敗:', err); }
    }
    // 屋根テキストの投影シェーダも同様に当て直す。
    if (roofTextHook) {
      try { roofTextHook(modelScene); }
      catch (err) { console.warn('屋根テキストの再適用に失敗:', err); }
    }
    markSectionDirty();   // 建物が増えたので断面を作り直す
    hideLoading();
  });
  t.addEventListener('dispose-model', ({ scene: modelScene }) => {
    unregisterClipMeshes(modelScene);
    markSectionDirty();
  });
  // LOD の切替（表示タイルの入れ替わり）でも断面の形が変わる
  t.addEventListener('tile-visibility-change', markSectionDirty);
  // 一時的な取得失敗は赤エラーを出さず静かに数回リトライ（LRUから外すと次updateで再取得）。
  t.addEventListener('load-error', (e) => {
    const tile = e.tile;
    if (tile) {
      tile.__retry = (tile.__retry || 0) + 1;
      if (tile.__retry <= RETRY_MAX) {
        setTimeout(() => { try { t.lruCache.remove(tile); } catch (err) {} }, 600 * tile.__retry);
        return;
      }
    }
    console.warn('タイル読み込み失敗（リトライ上限）:', (e.url || e.error?.message || ''));
  });
  scene.add(t.group);
  return t;
}

// 全区の TilesRenderer。区ごとに LOD2 があれば LOD2、無ければ LOD1 で補完（config.js の
// WARD_TILESETS。都市によって区の数・LOD2配信区が異なるので、組み立ては config.js 側で行う）。
// どこに注目地点を移してもその区の建物が出るよう全区ぶん用意するが、focusRegion により
// 実際に読むのは注目地点を含む区の近傍タイルだけ（起動時は各 root JSON のみ）。
const wardTiles = WARD_TILESETS.map(makeWardTiles);

// キャッシュとキューを「全区で共有」して、全体を1つのシステムとして管理する。
//   ・lruCache 共有 … メモリ上限を全体で1つに（公式の複数tileset手法）。
//   ・downloadQueue 共有 … これが重要。区ごとに別キューだと 11区×maxJobs 本もの同時接続が
//     PLATEAU の CDN（1ホスト）に集中し、HTTP/3(QUIC) が飽和して ERR_QUIC_PROTOCOL_ERROR で
//     大量に失敗→リトライで激遅になる。共有して同時接続数を全体で絞れば失敗が激減し、
//     さらに「最も近いタイルから」グローバルに優先ロードされる（＝見ている方向の区が先に出る）。
//   ・parse/processNode も共有して CPU 側の同時処理も全体で1本化。
// ⚠️ let にしてあるのは、地点移動時に全区を作り直す（resetWardTiles）ときに
//    キャッシュ／キューごと新品に差し替えて「ページを開き直したのと同じ状態」にするため。
let sharedCache, sharedDownload, sharedParse, sharedProcess;
function wireSharedCacheAndQueues() {
  sharedCache = wardTiles[0].lruCache;
  sharedCache.minBytesSize = Infinity;   // テクスチャ縮小済みで byte 見積りが過大なので枚数管理
  sharedCache.maxBytesSize = Infinity;
  // minSize は「最低これだけは保持する枚数」。大きすぎると画角外になった不要タイルが
  // いつまでも解放されない（退避は unused 枚数が上限なので、必要なタイルが捨てられることはない）。
  // ⚠️ minSize は「最低これだけは保持する枚数」で、退避量は
  //   excessNodes = max(min(itemList.length - minSize, unused), 0) で決まる。
  //   つまり【保持枚数が minSize を超えていないと不要タイルが1枚も退避されない】。
  //   以前は minSize=200 で、局所描画の実使用が 90〜170枚程度だったため退避が永久に
  //   起こらず、地図で移動するたびに前の場所のタイルが残り続けた（実測: 172枚中86枚が
  //   unused のまま unloadUnusedContent() を10回呼んでも1枚も減らない）。
  //   その結果 maxSize に達すると LRUCache.add() が false を返し
  //   【新規タイルがリクエストすらされなくなる】＝移動先の建物が出ない・激遅の原因。
  //   実使用より小さい値にしておくこと。
  sharedCache.minSize = 64;
  sharedCache.maxSize = 800;             // 局所しか読まないので小さくてよい
  sharedCache.unloadPercent = 0.4;       // 1回の退避パスで捨てる割合（既定0.05は遅すぎる）
  sharedDownload = wardTiles[0].downloadQueue;
  // 全区合計の同時DL数。計測すると常にこの上限に張り付く＝ここがパン後の描画速度を決める。
  // 上げると速くなるが、上げ過ぎると1ホスト(PLATEAU CDN)への接続過多で HTTP/3(QUIC) が
  // 飽和し ERR_QUIC_PROTOCOL_ERROR が多発する（区ごと別キューで最大66本だった時に発生）。
  // FULL_BODY_FETCH_PLUGIN により、この値は「本体転送まで含めた」真の同時DL数になった。
  // LOD2 の葉タイルは1枚5〜7MBあるので、多すぎると1枚あたりの完了が遅れて
  // 「いつまでも何も出ない」状態になる。少なめにして1枚ずつ確実に完成させる方が体感が良い。
  sharedDownload.maxJobs = 8;

  // ※ 読み込み優先度はライブラリ既定（loadAncestors=true → errorPriorityCallback）のまま使う。
  //   「注目地点からの距離」を第一基準にする独自コールバックも試したが、
  //   3D Tiles の REPLACE 細分化は【親を置き換えるのに兄弟タイル全部が揃う】必要があるため、
  //   距離順にすると近い兄弟だけ先に来て遠い兄弟が最後まで残り、揃うまで表示に切り替われず
  //   「読込済52枚なのに表示4枚」という状態が長く続いた（実測）。
  //   誤差優先（粗い順）は階層ごとに揃うので、粗→細と段階的に表示が進む＝体感が良い。
  //   注目地点を早く出したいなら「優先順位」ではなく【読み込む範囲そのものを絞る】のが正解
  //   （下の updateLoadRegion 参照）。
  sharedParse = wardTiles[0].parseQueue;
  sharedProcess = wardTiles[0].processNodeQueue;
  for (let i = 1; i < wardTiles.length; i++) {
    wardTiles[i].lruCache = sharedCache;
    wardTiles[i].downloadQueue = sharedDownload;
    wardTiles[i].parseQueue = sharedParse;
    wardTiles[i].processNodeQueue = sharedProcess;
  }
}
wireSharedCacheAndQueues();

// =========================================================================
// 地点移動時の「完全リセット」
//   ご要望：地点を変えたら今までのデータはすべて消し、その地点が初期地点であるかのように
//   読み込みをやり直す。
//
//   これまでは LRU の退避バーストだけで済ませていたが、それでは以下が引き継がれてしまう：
//     ・downloadQueue に積まれた【前の場所ぶんのジョブ】
//       → 移動先のタイルはその後ろに並ぶので、前の場所の 5〜7MB の葉タイルを
//         全部拾い終えるまで移動先が始まらない。これが「移動先が極端に遅い」主因の一つ。
//     ・各 TilesRenderer が保持する走査状態（どのタイルを展開済みか）
//     ・LRU に残った tile オブジェクトと、それに紐づく AbortController
//
//   TilesRenderer を dispose して作り直せば、キャッシュもキューも走査状態も新品になり、
//   文字通り「ページを開き直した直後」と同じ条件から移動先を読み始められる。
//   （区の root JSON だけは再取得になるが 201KB×11 と軽く、ブラウザキャッシュにも載る）
// =========================================================================
function resetWardTiles() {
  for (const t of wardTiles) {
    // dispose() は配下タイルを破棄するので 'dispose-model' が飛び、
    // unregisterClipMeshes / markSectionDirty も連鎖して呼ばれる。
    try { t.dispose(); } catch (e) { console.warn('dispose に失敗:', e); }
    if (t.group.parent) t.group.parent.remove(t.group);
  }
  // 全区を破棄したので、clipMeshes に残る建物メッシュはすべて幽霊。
  // （地形は別の TilesRenderer なので残す）
  for (const m of Array.from(clipMeshes)) if (!m.__clipIsTerrain) clipMeshes.delete(m);
  // 同じ配列オブジェクトを使い回す（animate や __dbg が参照を握っているため）。
  wardTiles.length = 0;
  for (const url of WARD_TILESETS) wardTiles.push(makeWardTiles(url));
  wireSharedCacheAndQueues();   // 新品のキャッシュ／キューで配線し直す
  markSectionDirty();
}



//     反映されない。SphereRegion の sphere と同じ罠）。
const _invGroupMat = new THREE.Matrix4();
const _focusTranslation = new THREE.Matrix4();
function updateLoadRegion() {
  const group = wardTiles[0].group;
  group.updateMatrixWorld();
  _invGroupMat.copy(group.matrixWorld).invert();
  _focusTranslation.makeTranslation(focusLocal.x, focusLocal.y, focusLocal.z);
  focusRegion.obb.transform.copy(_invGroupMat).multiply(_focusTranslation);
  focusRegion.obb.update();
}

// =========================================================================
// 地形レイヤー（PLATEAU Terrain / Quantized Mesh）
//   建物と同じ ReorientationPlugin(lat, lon, height) で整列 → 同一 ECEF 座標系に載るので
//   建物は地形の標高の上に自動的に乗る（＝地盤高さに合わせた設置）。
// =========================================================================
//   ★ 作る手順を関数にまとめてある。「再読み込み」ボタン（reloadAllTiles）で
//     建物と同じように【破棄して作り直す】ため。
let terrainTiles = null;
let terrainWrapGroup = null;
let overlayPlugin = null;
let currentOverlay = null;
let currentImageryKey = DEFAULT_IMAGERY;

// =========================================================================
// 標高段彩（地形を標高で色分けする）
//
//   ★ ジオメトリにも頂点属性にも一切手を触れない。地形メッシュのフラグメントシェーダーに
//     「ワールド座標のYから標高を出して色を決める」数行を差し込むだけなので、
//     ドローコールも頂点数もメモリも増えない（＝描画コストは実質ゼロ）。
//     色の階調だけ 256×1 のテクスチャ（1KB）に持つ。
//
//   ★ 段は【フラグメント側】で切ること。建物の「高さで色分け」と同じ頂点カラー方式に
//     すると、頂点と頂点のあいだで色が補間されて 10m の段がぼやけてしまう。
//     ピクセルごとに floor(標高/刻み) すれば、等高線図のようにくっきり出る。
//
//   ★ 地球の丸みを戻すこと。この座標系は原点での接平面なので、遠方の地形はワールドYが
//     実標高より沈む。実測で 15km 先の山で約 20m、30km 先で約 70m 低く出ていた。
//     放物線近似 (x²+z²)/2R を足せば、この範囲ならセンチ単位まで戻る。
//
//   ★ 切り替えは【uniform だけ】で行い、シェーダーは組み直さない。
//     100枚を超える地形マテリアルを needsUpdate で再コンパイルすると一瞬固まるため、
//     読み込み時に一度だけ差し込んでおき、以後は on/off も刻みも uniform の値で変える。
// =========================================================================
const terrainTintState = { on: false, step: ELEVATION_TINT_DEFAULT_STEP };

// 段彩の色見本（256×1）。config の色を標高で並べて補間したもの。
function makeTintRamp() {
  const N = 256;
  const [lo, hi] = ELEVATION_TINT_RANGE;
  const data = new Uint8Array(N * 4);
  const c0 = new THREE.Color(), c1 = new THREE.Color(), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const ele = lo + (hi - lo) * (i / (N - 1));
    let a = ELEVATION_TINT_STOPS[0], b = ELEVATION_TINT_STOPS[ELEVATION_TINT_STOPS.length - 1];
    for (let k = 0; k < ELEVATION_TINT_STOPS.length - 1; k++) {
      if (ele >= ELEVATION_TINT_STOPS[k].ele && ele <= ELEVATION_TINT_STOPS[k + 1].ele) {
        a = ELEVATION_TINT_STOPS[k]; b = ELEVATION_TINT_STOPS[k + 1]; break;
      }
    }
    const t = b.ele === a.ele ? 0 : (ele - a.ele) / (b.ele - a.ele);
    // ⚠️ 色の混ぜ合わせは【線形空間で】行い、テクスチャには sRGB に戻して詰める。
    //   setHex(..., SRGBColorSpace) で線形に直してから lerp し、最後に sRGB へ。
    //   テクスチャ側で colorSpace を宣言してあるので、GPU が読むときにまた線形へ戻る。
    c0.setHex(a.color, THREE.SRGBColorSpace);
    c1.setHex(b.color, THREE.SRGBColorSpace);
    c.copy(c0).lerp(c1, Math.max(0, Math.min(1, t)));
    const srgb = c.clone().convertLinearToSRGB();
    data[i * 4] = Math.round(srgb.r * 255);
    data[i * 4 + 1] = Math.round(srgb.g * 255);
    data[i * 4 + 2] = Math.round(srgb.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;   // GPU が sRGB→線形に直して読む
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// 全マテリアルで【同じ uniform オブジェクトを共有】する。値を書き換えるだけで
// 読み込み済みの地形すべてに一斉に効く（作り直しも再コンパイルも不要）。
const tintUniforms = {
  uTintOn:   { value: 0 },
  uTintStep: { value: ELEVATION_TINT_DEFAULT_STEP },
  uTintRamp: { value: makeTintRamp() },
  uTintLo:   { value: ELEVATION_TINT_RANGE[0] },
  uTintHi:   { value: ELEVATION_TINT_RANGE[1] },
  uTintSea:  { value: SEA_LEVEL_Y },
  uTintR2:   { value: 2 * EARTH_R },
  uTintLine: { value: ELEVATION_TINT_LINE_STRENGTH },
};

// 地形マテリアル1枚に段彩のシェーダーを差し込む。
//   ⚠️ ImageOverlayPlugin が既に onBeforeCompile を持っているので【置き換えず連結】する。
//     しかもプラグインは customProgramCacheKey を自分では持たない（three の既定＝
//     onBeforeCompile の全文がキーになる）ので、こちらで必ずキーを添えること。
//     建物の makeInteriorCap で踏んだのと同じ罠。
//   ⚠️ 差し込む位置は <roughnessmap_fragment>。プラグインは <color_fragment> の直後で
//     航空写真を合成するので、それより後でなければ画像に上書きされる。
function applyTerrainTint(material) {
  if (material.__terrainTint) return;
  material.__terrainTint = true;

  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey : null;
  material.customProgramCacheKey = function () {
    return 'terrainTint|' + (ownKey ? ownKey.call(this) : '');
  };

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, rendererRef) {
    if (prev) prev.call(this, shader, rendererRef);
    Object.assign(shader.uniforms, tintUniforms);

    shader.vertexShader = 'varying vec3 vTintWorld;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vTintWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
    );

    shader.fragmentShader = `
      varying vec3 vTintWorld;
      uniform float uTintOn;
      uniform float uTintStep;
      uniform sampler2D uTintRamp;
      uniform float uTintLo;
      uniform float uTintHi;
      uniform float uTintSea;
      uniform float uTintR2;
      uniform float uTintLine;
    ` + shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      if ( uTintOn > 0.5 ) {
        // 接平面座標なので、遠方は地球の丸みで沈む。放物線近似で実標高に戻す。
        float elev = vTintWorld.y - uTintSea
          + ( vTintWorld.x * vTintWorld.x + vTintWorld.z * vTintWorld.z ) / uTintR2;
        float idx  = floor( elev / uTintStep );      // 何段目か
        float band = idx * uTintStep;                // その段の下端の標高
        float t = clamp( ( band - uTintLo ) / ( uTintHi - uTintLo ), 0.0, 1.0 );
        vec3 tint = texture2D( uTintRamp, vec2( t, 0.5 ) ).rgb;
        // 平地では隣り合う段の色がほとんど変わらないので、1段おきに僅かに落として
        // 段の切れ目が必ず読めるようにする。
        tint *= mix( 1.0, 0.93, mod( idx, 2.0 ) );
        // 段の境目に等高線。fwidth で線幅を1ピクセルに保つ。
        // 段が画面上で細かくなりすぎたら線を消す（モアレで真っ黒になるのを防ぐ）。
        float f = elev / uTintStep;
        float w = max( fwidth( f ), 1e-5 );
        float line = ( 1.0 - clamp( abs( fract( f + 0.5 ) - 0.5 ) / w, 0.0, 1.0 ) )
                   * ( 1.0 - smoothstep( 0.35, 1.0, w ) );
        tint = mix( tint, tint * ( 1.0 - uTintLine ), line );
        diffuseColor.rgb = tint;
      }`,
    );
  };
}

// on/off と刻みの変更。uniform を書き換えるだけなので即座に全タイルへ効く。
function setTerrainTint(on) { terrainTintState.on = on; tintUniforms.uTintOn.value = on ? 1 : 0; }
function setTerrainTintStep(step) {
  terrainTintState.step = step;
  tintUniforms.uTintStep.value = step;
}

// --- 航空写真／地図の切り替え（地形を作り直しても選択が引き継がれるよう外に出す）----
let onImageryChange = () => {};
const setImageryChangeHandler = (fn) => { onImageryChange = fn; };

// --- 道路オーバーレイ（roads.js）の差し込み ------------------------------------
//   overlayPlugin は地形と一緒に作り直される（reloadAllTiles）ので、作り直すたびに
//   roads.js へ新しいインスタンスを渡し直す必要がある。建物編集・屋根テキストと同じ
//   フック方式（循環参照を避けるため直接 import しない）。
//   ⚠️ 道路オーバーレイは overlayPlugin.addOverlay(overlay, 1) で order=1 固定にすること
//     （0は航空写真／地図。setImagery 側もそちらを参照）。
let roadOverlayHook = null;
function setRoadOverlayHook(fn) { roadOverlayHook = fn; }

function setImagery(key) {
  if (!IMAGERY[key]) return;
  currentImageryKey = key;
  // 標高段彩と航空写真は排他。段彩のときは画像を貼らない（url=null なので自動的にそうなる）。
  setTerrainTint(!!IMAGERY[key].tint);
  if (overlayPlugin) {
    // deleteOverlay は読込中テクスチャがあると稀に内部で例外(DataCache二重解放)を
    // 投げることがあるので握りつぶす（切り替え自体は成立させる）。
    if (currentOverlay) {
      try { overlayPlugin.deleteOverlay(currentOverlay); } catch (err) { /* ignore */ }
      currentOverlay = null;
    }
    const def = IMAGERY[key];
    if (def.url) {
      currentOverlay = new XYZTilesOverlay({ url: def.url, levels: def.levels ?? 18 });
      // order=0固定（航空写真／地図は最下層）。道路オーバーレイ（roads.js）は order=1 で
      // 常にその上に乗る。addOverlay の order 省略時の自動採番に任せると、切替の順序次第で
      // 道路が下に潜ることがあるため固定する。
      overlayPlugin.addOverlay(currentOverlay, 0);
    }
  }
  // ボタンの見た目を更新
  document.querySelectorAll('#mapSwitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.key === key);
  });
  onImageryChange(key);   // 段彩のときだけ出す操作（刻み・凡例）を ui.js が付け外しする
}
window.__setImagery = setImagery; // デバッグ用

function createTerrainTiles() {
  terrainTiles = new TilesRenderer(TERRAIN_URL);
  // QuantizedMeshPlugin は他プラグインより先に登録する（コンテンツ生成を担うため）。
  terrainTiles.registerPlugin(new QuantizedMeshPlugin({
    useRecommendedSettings: true, // 地形向けの誤差・取得設定を自動適用
    smoothSkirtNormals: true,     // タイル境界の法線を滑らかに
    // 地形の断面は「地盤ラインを線で描く」だけで土の塗りつぶしはしないので、
    // 底面を作る solid は不要（底面があると断面線が二重になる）。
    solid: false,
  }));
  // 航空写真／地図テクスチャを地形に貼るプラグイン（コンテンツ生成の後に登録）。
  overlayPlugin = new ImageOverlayPlugin({ renderer, overlays: [] });
  currentOverlay = null;
  terrainTiles.registerPlugin(overlayPlugin);
  terrainTiles.registerPlugin(new ReorientationPlugin({
    lat: ORIGIN_LAT, lon: ORIGIN_LON, height: ORIGIN_HEIGHT, // 建物と完全に同じ整列
  }));
  terrainTiles.setCamera(camera);
  terrainTiles.setResolutionFromRenderer(camera, renderer);
  terrainTiles.errorTarget = 6; // 背景なので建物ほど高精細でなくてよい（大きいほど粗い＝軽い）

  // 地形は全球データ。狭い範囲を背景に使うので枚数で管理し、バイト上限は無効化。
  terrainTiles.lruCache.minBytesSize = Infinity;
  terrainTiles.lruCache.maxBytesSize = Infinity;
  // 建物側と同じ理由で minSize は実使用（数十枚）より小さくしておく。
  // 大きいと移動しても前の場所の地形タイルが退避されず溜まり続ける。
  terrainTiles.lruCache.minSize = 32;
  terrainTiles.lruCache.maxSize = 400;
  terrainTiles.lruCache.unloadPercent = 0.4;

  // 地形マテリアルの調整。ImageOverlayPlugin が各タイルのマテリアル(MeshStandardMaterial)を
  // ラップして航空写真/地図を合成するので、ここでは「置換せず」プロパティのみ変更する
  // （置換するとオーバーレイのラップが壊れる）。color は読込中のプレースホルダ（画像が
  // 載れば置き換わる）。white 寄りにして画像本来の色を保つ。
  terrainTiles.addEventListener('load-model', ({ scene: s, tile }) => {
    s.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material.color.setHex(0x9098a4);
        c.material.metalness = 0.0;
        c.material.roughness = 1.0;
        c.material.side = THREE.DoubleSide;
        c.material.clippingPlanes = terrainClipPlanes; // 建物とは別配列（地形だけ切らない選択が可能）
        c.renderOrder = -1;
        applyTerrainTint(c.material);   // 標高段彩の数行を仕込む（切り替えは uniform だけで効く）
      }
    });
    registerClipMeshes(s, true, tile, terrainTiles.group); // 断面の対象に登録（地形として）
    markSectionDirty();
    markViewAreaDirty();   // 地形が増えた＝沿わせ先が変わった
    markZonesDirty();
    markUserModelDirty();  // 接地の基準になる地形が増えた＝置き直す
    markMountainsDirty();  // 標高データが無い山名も、地形が増えれば高さを拾える
    hideLoading();
  });
  terrainTiles.addEventListener('dispose-model', ({ scene: s }) => {
    unregisterClipMeshes(s);
    markSectionDirty();
    markViewAreaDirty();
    markZonesDirty();
    markUserModelDirty();
  });
  // ※ 眺望ポリゴンは読み込み済みの地形から作るので、tile-visibility-change では
  //   作り直さない。表示・非表示は結果に影響しないうえ、カメラを回すたびに大量に
  //   発火して無駄な再構築が続くため（断面は表示状態と無関係に markSectionDirty 済み）。
  // 建物と同じく一時的な取得失敗は静かに数回リトライ。
  // ただしオーバーレイ画像(e.overlay あり)の失敗は「再試行しない」。地理院の航空写真は
  // 山地などでタイルが部分的に存在せず 404 になるが、これは恒久的な欠損なので再試行すると
  // 404 の無限ループ（コンソール大量エラー＋通信を食い潰して建物DLが遅延）になる。
  // 欠損箇所はプラグインが自動的に下位ズームの画像で埋めるので、放置してよい。
  //   ⚠️ ハンドラの中では module 変数 terrainTiles ではなく【この renderer 自身】を掴む。
  //     再読み込みで作り直したあとに古い renderer のエラーが遅れて届くと、
  //     新しい方のキャッシュを触ってしまうため。
  const self = terrainTiles;
  self.addEventListener('load-error', (e) => {
    if (e.overlay) return; // オーバーレイ画像の失敗は無視（リトライ嵐を防ぐ）
    const tile = e.tile;
    if (tile) {
      tile.__retry = (tile.__retry || 0) + 1;
      if (tile.__retry <= RETRY_MAX) {
        setTimeout(() => { try { self.lruCache.remove(tile); } catch (err) {} }, 600 * tile.__retry);
        return;
      }
    }
    console.warn('地形タイル読み込み失敗（リトライ上限）:', (e.url || e.error?.message || ''));
  });

  // 鉛直方向の微調整用に親 Group で包む（reorientation が子の transform を上書きしても効くように）。
  const terrainWrap = new THREE.Group();
  terrainWrap.position.y = TERRAIN_VERTICAL_OFFSET;
  terrainWrap.add(terrainTiles.group);
  terrainWrap.visible = false;   // ★ 十分に細かくなるまで出さない（下の updateTerrainReady）
  scene.add(terrainWrap);
  terrainWrapGroup = terrainWrap;
  window.__plateauTerrain = terrainTiles; // デバッグ用

  setImagery(currentImageryKey);   // 選ばれている画（既定は航空写真）を貼り直す
  if (roadOverlayHook) {
    try { roadOverlayHook(overlayPlugin); } catch (err) { console.warn('道路オーバーレイの差し込みに失敗:', err); }
  }
}

// 地形レイヤーを丸ごと捨てる（再読み込み用）。dispose() は配下タイルを破棄するので
// 'dispose-model' が飛び、unregisterClipMeshes / markSectionDirty も連鎖して呼ばれる。
function disposeTerrainTiles() {
  if (!terrainTiles) return;
  try { terrainTiles.dispose(); } catch (e) { console.warn('地形の破棄に失敗:', e); }
  if (terrainWrapGroup && terrainWrapGroup.parent) terrainWrapGroup.parent.remove(terrainWrapGroup);
  // 取りこぼした地形メッシュが断面の対象に残らないよう掃除する（建物は別の renderer なので残す）
  for (const m of Array.from(clipMeshes)) if (m.__clipIsTerrain) clipMeshes.delete(m);
  terrainTiles = null;
  terrainWrapGroup = null;
  overlayPlugin = null;
  currentOverlay = null;
  if (roadOverlayHook) {
    try { roadOverlayHook(null); } catch (err) { console.warn('道路オーバーレイの破棄通知に失敗:', err); }
  }
}

if (SHOW_TERRAIN) {
  createTerrainTiles();
  // HUD に画の切り替えボタンを生成して配線（ボタンは作り直さないのでここで1回だけ）
  const mapSwitch = document.getElementById('mapSwitch');
  if (mapSwitch) {
    for (const [key, def] of Object.entries(IMAGERY)) {
      const btn = document.createElement('button');
      btn.textContent = def.label;
      btn.dataset.key = key;
      btn.addEventListener('click', () => setImagery(key));
      mapSwitch.appendChild(btn);
    }
    // 生成前に setImagery を通っているので、選択の見た目だけここで合わせる
    mapSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === currentImageryKey);
    });
  }
}

// ---- 地形を「見せてよいか」の判定 -------------------------------------------
//   起動直後（と地点移動直後）は非常に粗い地形タイルしか無い。粗いタイルは1枚が
//   数km〜数百kmをまたぐ平面なので、注目地点の真上では実際の地盤より数百m も高い位置に出る。
//   それが細かいタイルに置き換わるにつれて下がっていくため、
//   【空から地面が降ってくる】ように見えていた。
//
//   PLATEAU 地形の geometricError は1階層ごとにほぼ半減する（実測）:
//     深さ1=78,492m / 4=9,633 / 8=602 / 11=75 / 13=18.8 / 15=4.7 / 17=0.15
//   errorTarget=6 の最終状態で表示されていたタイルは 0.3〜9.6m だったので、
//   「注目地点を覆う地形タイルの geometricError が TERRAIN_READY_ERROR 以下」を
//   表示開始の条件にする。それまでは地形グループごと隠す（読み込みは進める）。
//
//   ⚠️ 「表示中か」を scene まで辿って判定してはいけない。ここで隠しているのは
//     祖先の terrainWrap なので、辿ると常に非表示になり永久に条件を満たさない。
//     タイル自身（と terrainTiles.group までの間）の visible だけを見ること。
//   ⚠️ 閾値は【カメラ距離に連動】させること。固定10mにしていたら、カメラを引ける上限を
//     2000→4000m に広げた途端に地形が出なくなった。遠くから見るとレンダラーは当然
//     粗いタイルを選ぶので（実測: 距離3,970m で注目地点を覆うタイルの誤差 19.2m）、
//     固定閾値だと「適切に粗い」だけの地形まで弾いてしまい、ゲートが永久に開かない。
//     元々防ぎたかったのは誤差が数百m の near-root タイルなので、
//     カメラ距離の1%（＝見た目で判別できない程度）を下限に足せば両立する。
const TERRAIN_READY_ERROR = 10;
const TERRAIN_READY_ERROR_RATIO = 0.01;
let terrainReady = false;
const _trBox = new THREE.Box3();
const _trWorld = new THREE.Matrix4();
function updateTerrainReady() {
  if (!terrainTiles || !terrainWrapGroup || terrainReady) return;
  const fx = focusLocal.x, fz = focusLocal.z;
  const updatedRoots = new Set();
  let best = Infinity;
  for (const mesh of clipMeshes) {
    if (!mesh.__clipIsTerrain) continue;
    const tile = mesh.__clipTile;
    if (!tile || !Number.isFinite(tile.geometricError)) continue;
    // レンダラーが「今出している」ものだけを見る（terrainTiles.group までで打ち切る）
    let node = mesh, shown = true;
    while (node && node !== terrainTiles.group) {
      if (!node.visible) { shown = false; break; }
      node = node.parent;
    }
    if (!shown || !node) continue;
    const g = mesh.geometry;
    if (!g || !g.attributes.position) continue;
    if (!computeClipMeshWorld(mesh, _trWorld, updatedRoots)) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    _trBox.copy(g.boundingBox).applyMatrix4(_trWorld);
    if (fx < _trBox.min.x || fx > _trBox.max.x || fz < _trBox.min.z || fz > _trBox.max.z) continue;
    if (tile.geometricError < best) best = tile.geometricError;
  }
  const limit = Math.max(TERRAIN_READY_ERROR,
    camera.position.distanceTo(controls.target) * TERRAIN_READY_ERROR_RATIO);
  if (best <= limit) {
    terrainReady = true;
    terrainWrapGroup.visible = true;
    markSectionDirty();
    markViewAreaDirty();
    markZonesDirty();
    markUserModelDirty();  // 十分細かい地形が揃った＝ここで接地し直すと正確になる
    markMountainsDirty();
  }
}

// 地点を移したら、その場所の地形が細かくなるまでまた隠す（同じ理由）。
function resetTerrainReady() {
  terrainReady = false;
  if (terrainWrapGroup) terrainWrapGroup.visible = false;
}

// =========================================================================
// 「データを再読み込み」（HUD 最下部のボタン）
//   通信の失敗やキューの詰まりで建物・地形が出てこなくなったときの立て直し用。
//   ページを開き直さずに、建物と地形の TilesRenderer を丸ごと作り直す
//   ＝キャッシュ・ダウンロードキュー・走査状態がすべて新品になり、
//   「いまの注目地点でページを開いた直後」と同じ状態から読み直す。
//   ★ 見ているカメラ・注目地点・自作モデル・各レイヤーの選択はそのまま残る。
// =========================================================================
function reloadAllTiles() {
  loadPhase = -1;         // setLoadPhase(0) を必ず通す（同じ値だと素通りするため）
  setLoadPhase(0);        // 再読み込みでも「まず中心の1枚」から
  updateLoadRegion();     // 作り直し直後の update が正しい範囲を見るように先に矩形を合わせる
  resetWardTiles();
  if (SHOW_TERRAIN) {
    disposeTerrainTiles();
    createTerrainTiles();
  }
  resetTerrainReady();    // 地形が十分細かくなるまではまた隠す（空から降ってくるのを防ぐ）
  evictBurstFrames = 30;
  markSectionDirty();
  markViewAreaDirty();
  markZonesDirty();
  markUserModelDirty();
  markMountainsDirty();
}

// ---- 読み込み中かどうか（オンデマンド描画の継続判定に使う）--------------------
//   取得中・解析中・キュー待ちが1つでもあれば「まだ絵が変わる」＝描き続ける。
function tilesBusy() {
  let n = 0;
  for (const t of wardTiles) {
    const s = t.stats;
    if (!s) continue;
    n += (s.queued || 0) + (s.downloading || 0) + (s.parsing || 0);
  }
  if (terrainTiles && terrainTiles.stats) {
    const s = terrainTiles.stats;
    n += (s.queued || 0) + (s.downloading || 0) + (s.parsing || 0);
  }
  return n > 0;
}

// 緯度経度[rad]を注目地点に設定する。カメラも（現在の見る向き・距離を保ったまま）そこへ移す。
//   ローカル座標への変換（原点まわりの局所ENU近似。市内スケールなら十分正確）:
//     north[m] = (lat - ORIGIN_LAT) * R,  east[m] = (lon - ORIGIN_LON) * R * cos(lat)
//     scene では +Z=北 / +X=西 なので  z = north,  x = -east

// 注目地点を移したときに、前の場所のタイルを速やかに片付けるためのバースト退避。
//   ライブラリの退避は rAF スケジュール＆1パス unloadPercent 分ずつなので、
//   「一気に不要になる」移動時には追いつかない。数フレームだけ明示的に強く回す。
//   これは前の場所の【進行中フェッチの中断】も兼ねる（unloadUnusedContent が
//   AbortController.abort() を呼ぶ）＝移動先のDL枠がすぐ空く。
let evictBurstFrames = 0;
function runEvictBurst() {
  if (evictBurstFrames <= 0) return;
  evictBurstFrames--;
  for (let i = 0; i < 8; i++) sharedCache.unloadUnusedContent();
  if (terrainTiles) for (let i = 0; i < 4; i++) terrainTiles.lruCache.unloadUnusedContent();
}

function setFocusLatLon(latRad, lonRad, moveCamera = true) {
  const north = (latRad - ORIGIN_LAT) * EARTH_R;
  const east = (lonRad - ORIGIN_LON) * EARTH_R * Math.cos(latRad);
  const nx = -east, nz = north;
  if (moveCamera) {
    const off = camera.position.clone().sub(controls.target); // 今の視点オフセットを保つ
    controls.target.set(nx, focusLocal.y, nz);
    camera.position.copy(controls.target).add(off);
  }
  const moved = Math.hypot(nx - focusLocal.x, nz - focusLocal.z) > 1;
  focusLocal.set(nx, focusLocal.y, nz);
  if (moved) {
    // 全区を作り直して「その地点が初期地点」の状態から読み直す。
    // 新しい focusRegion で root JSON から走査が始まるので、前の場所の
    // キュー待ちジョブに邪魔されない。
    setLoadPhase(0);      // 移動先でも「まず1枚」からやり直す
    updateLoadRegion();   // 先に矩形を移す（resetWardTiles 直後の update で正しい範囲を見るため）
    resetWardTiles();
    resetTerrainReady();  // 移動先の地形が細かくなるまで隠す（空から降ってくるのを防ぐ）
  }
  evictBurstFrames = 30;   // 地形側（作り直さない）の古いタイルを一掃する
  markSectionDirty();
  markViewAreaDirty();     // 沿わせる範囲は切り抜き箱に追従するので作り直す
  markZonesDirty();        // ゾーンレイヤーも同じ（切り抜きONなら箱まで絞る）
  markUserModelDirty();    // 自作モデルは注目地点に追従して置き直す
  markMountainsDirty();    // 山名の表示範囲は注目地点からの距離で決まる
  // ※ 標高面（viewLimit）は格子JSONだけから作れて注目地点に依存しないので作り直さない。
  // 右下の地図と東西断面の緯度を、新しい注目地点に合わせる。
  if (focusChangeHandler) {
    try { focusChangeHandler(latRad * (180 / Math.PI), lonRad * (180 / Math.PI)); }
    catch (err) { console.warn('注目地点の追従処理に失敗:', err); }
  }
}

// 注目地点まわりだけ読み込むよう、矩形(OBB)の位置をワールド座標から ECEF へ変換して更新する。
//   ※ タイルの境界判定はグループのローカル座標（＝ECEF）で行われるので、box自体はローカル
//     原点中心の固定サイズのまま、transform（box→ECEFへの変換行列）だけを毎フレーム
//     更新する: transform = invGroupMat(ECEF→ワールドの逆) * translate(focusLocal)。
//     こうすると box の東西/南北/鉛直の各軸が group の回転（＝再配置の向き）に正しく
//     追従して回転する（focusLocal に平行移動してからワールド→ECEFへ変換するのと等価）。
//   ※ OBBRegion はコンストラクタで OBB を「コピー」して保持するため、リージョン自身の
//     obb.transform を更新し、update() を呼ばないと効かない（共有変数を書き換えるだけでは

export {
  wardTiles, focusBox, focusRegion, updateLoadRegion,
  setLoadPhase, updateLoadPhase, resetWardTiles, makeWardTiles,
  sharedCache, downscaleTexture, dracoLoader,
  setFocusLatLon, runEvictBurst, updateTerrainReady,
  setBuildingColorMode, buildingColorState, setBuildingEditHook, setFocusChangeHandler,
  setRoofTextHook, setRoadOverlayHook,
  reloadAllTiles, tilesBusy,
  terrainTintState, setTerrainTintStep, setImageryChangeHandler,
};
export const isEvictBursting = () => evictBurstFrames > 0;
export const isTerrainReady = () => terrainReady;
export const getLoadPhase = () => loadPhase;
export const getTerrainTiles = () => terrainTiles;
// ★ createTerrainTiles() はモジュール読込直後（top-level）に一度走るため、その時点では
//   roads.js の setRoadOverlayHook がまだ登録されていない（import順の都合）。
//   なので roads.js 側は初回だけこのgetterで「今の overlayPlugin」を直接取りに来る。
export const getOverlayPlugin = () => overlayPlugin;

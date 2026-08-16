// =============================================================================
// section — 中心の切り抜きと、その断面表現。
//   ・クリップ面（一辺 clipState.size[m] の四角柱）と、切り抜き対象メッシュの登録簿
//   ・建物の断面を塗りつぶす（CPUで交線を計算しループ化して面を張る。灰色＋黒ハッチ）
//   ・地形の切り口に青い地盤ラインを引き、その下に土・等高線・標高ラベルを描く
// =============================================================================
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { THREE, scene, focusLocal, dirty, markSectionDirty, markViewAreaDirty, markZonesDirty } from './core.js';
import { ORIGIN_ELEVATION, SEA_LEVEL_Y } from './config.js';

// =========================================================================
// 中心の切り抜き（クリッピング + 断面表現）
//   注目地点を中心とした「一辺 clipState.size[m] の四角柱」の内側だけを残す。
//
//   ★ 断面の作り方（データの性質を実測した上での方針）:
//     ・建物 … 切断面との交線を CPU で計算し、輪郭をループ化して面を張る（灰色＋黒ハッチ）。
//       PLATEAU の建築物モデルは【底面が無い開いたシェル】で水密ではないため
//       （実測: 463エッジ中248が境界エッジ）、ステンシルによる断面キャップは
//       「表面数と裏面数が釣り合う」前提が崩れて破綻する（実際にシルエット全体が塗り潰された）。
//       幾何的に断面を作れば位相の破綻に強く、毎フレーム安定する。
//     ・地形 … 地盤ラインだけを青い太線で描く（土の塗りつぶしはしない）。
//       同じ交線計算を使い、面を張らずに線分のまま描画する。
// =========================================================================
const CLIP_SIZE_DEFAULT = 300;                 // 一辺[m]
const CLIP_SIZE_MIN = 50, CLIP_SIZE_MAX = 500, CLIP_SIZE_STEP = 10;
// 建物の切り口の色。断面の塗りつぶしと、切ると見える建物の内側（裏面）で共通に使う。
//   建築図面の断面表現に合わせて【灰色の塗りつぶし＋黒のハッチ】にしている
//   （ハッチが付くのは断面ポリゴンだけ。裏面はハッチ無しの灰色）。
const CAP_COLOR = 0x9a9a9a;
const CAP_HATCH_COLOR = 0x000000;              // 断面ハッチの色
const CAP_HATCH = { periodPx: 8, widthPx: 1.6, angle: 45 };  // 画面px基準の斜線
const GROUND_LINE_COLOR = 0x1a3cd8;            // 地盤ラインの色
const GROUND_LINE_WIDTH = 4;                   // 地盤ラインの太さ[px]
const SOIL_COLOR = 0x9c6b3e;                   // 土の色（側面・底面）
const SOIL_CONTOUR_COLOR = 0x000000;           // 等高線の色
const SOIL_CONTOUR_STEP = 10;                  // 等高線の間隔[m]
const SOIL_CONTOUR_WIDTH = 1.5;                // 等高線の太さ[px]
// 異常値を捨てる許容窓の「最小」幅[m]。実際の窓は標高分布のばらつきに応じて自動で広がる
// （平地では±この値、山地では分布幅に比例して広がる）。固定幅だと大文字山のような
// 急斜面で正当な地形まで捨ててしまうため、適応的にしている。
const SOIL_MAX_RELIEF_FROM_MEDIAN = 40;
// 地盤プロファイルで「異常」とみなす勾配の上限（高さ/水平距離）。
// これを超える段差が【両隣に対して同方向】に現れたビンはスパイク＝データ異常として
// 平均で置き換える。本物の斜面は勾配の符号が揃って続くので残る（1.0 ≒ 45°）。
const SOIL_MAX_SLOPE = 1.0;
const SOIL_LABEL_WIDTH = 16, SOIL_LABEL_HEIGHT = 8; // 標高ラベル1枚のサイズ[m]
// ★ 地盤ライン／土を描き始める条件（＝プロファイルが信用できるか）。
//   起動直後は非常に粗い地形タイルしか無く、その三角形は京都盆地から東山の山地までを
//   1枚でまたぐ。無限平面で切ると切り口に山側の標高が混ざり、300m四方の箱の中なのに
//   標高270mといった値が出て【土が天高く伸びる】（実際に毎回発生していた）。
//   これは外れ値除去では防げない（サンプルが全部同じだけ粗いので「外れ」にならない）。
//   → 「地形の分解能そのもの」で判定する。切り口の線分1本の水平長さが、箱の一辺を
//     この本数で割った値より長いなら、その地形は箱を解像できていない＝まだ描かない。
const SOIL_MIN_SAMPLES_ACROSS = 8;
// ★ ただし「箱の一辺 ÷ 8」だけだと【箱を小さくしたとき土が消える】。
//   地形の細かさは箱の大きさとは無関係（実測: 通常の地形で交線長の中央値 8〜16.8m）なのに、
//   100m四方だと上限12.5m、50m四方だと6.25m となり、正常な地形まで弾いてしまっていた。
//   弾きたいのは「箱ごとまたぐ数百mの粗いタイル」（実測 866〜3076m）なので、
//   絶対値の下限を設けて、小さい箱でも通常の地形なら通るようにする。
const SOIL_MAX_SEG_LEN = 40;
// この面の地形が箱を解像できているとみなす、交線1本の水平長さの上限[m]
const soilSegLenLimit = () =>
  Math.max(clipState.size / SOIL_MIN_SAMPLES_ACROSS, SOIL_MAX_SEG_LEN);

// terrain: 地形も切り抜くか（ON=地形を切り、切り口に青い地盤ラインを描く／OFF=全域表示）
const clipState = { enabled: true, size: CLIP_SIZE_DEFAULT, terrain: true };

// 4枚の垂直なクリップ面。three.js は dot(normal, p) + constant < 0 を切り捨てるので、
// 法線は「残す側」を向ける。
//   ※ 枚数が変わるとシェーダの再コンパイルが起きるので、常に4枚のまま保ち、
//     無効化したいときは constant を遠方に飛ばす（＝何も切られない）。
function makeClipPlanes() {
  return [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e9), // x <= cx+h
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e9),  // x >= cx-h
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9), // z <= cz+h
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e9),  // z >= cz-h
  ];
}
const buildingClipPlanes = makeClipPlanes(); // 建物用
const terrainClipPlanes = makeClipPlanes();  // 地形用（別配列＝地形だけ切らない選択が可能）

// 切り抜き対象メッシュの登録簿（タイルは動的に増減するので都度登録／解除する）。
// タイルも一緒に覚えておく：交差判定は mesh.matrixWorld ではなく
// tile.cached.boundingVolume（＝常に ECEF 基準で一貫）で行う必要があるため。
const clipMeshes = new Set();
function registerClipMeshes(modelScene, isTerrain, tile, group) {
  modelScene.traverse((c) => {
    if (!c.isMesh) return;
    c.__clipIsTerrain = isTerrain;
    c.__clipTile = tile;
    c.__clipRoot = modelScene;  // タイルの scene ルート（切り離されても行列を復元するのに使う）
    c.__clipGroup = group;      // その TilesRenderer の group（ワールドへの変換）
    clipMeshes.add(c);
  });
}
function unregisterClipMeshes(modelScene) {
  modelScene.traverse((c) => { if (c.isMesh) clipMeshes.delete(c); });
}

// ---- 読み込み済みタイルのワールド行列を求める（断面・眺望ポリゴンで共用）--------
//   ★ 対象は「表示中」ではなく【読み込み済み】にすること。
//     3D Tiles は視錐台の外／REPLACE 細分化の待ち合わせ中のタイルを非表示にするので、
//     表示中だけを使うと【カメラを回しただけで結果が変わる】。実際、眺望ポリゴンで
//     「orbit すると表示地域が 5→3 に減る」という不具合になった。
//   ⚠️ ただし切り離されたタイル（root.parent === null。子に置き換わった祖先）は
//     matrixWorld が更新されず生の ECEF のまま残るので、そのままでは使えない。
//     ・シーンに繋がっているもの … 標準の updateWorldMatrix（絶対に書き換えないこと。
//       書き換えると描画中のタイルの行列が壊れて建物も地形も出なくなる）
//     ・切り離されたもの … scene ルート基準で更新し group.matrixWorld を前から掛ける
//       （描画に使われないので書き換えて構わない）
function computeClipMeshWorld(mesh, out, updatedRoots) {
  const root = mesh.__clipRoot, grp = mesh.__clipGroup;
  if (!root || !grp) return false;
  if (root.parent) {
    mesh.updateWorldMatrix(true, false);
    out.copy(mesh.matrixWorld);
  } else {
    if (!updatedRoots || !updatedRoots.has(root)) {
      if (updatedRoots) updatedRoots.add(root);
      root.updateMatrixWorld(true);   // = グループ内ローカル
    }
    out.multiplyMatrices(grp.matrixWorld, mesh.matrixWorld);
  }
  return true;
}

// 同じ枝で最も細かい LOD だけを残す。粗い祖先と細かい子が両方読み込み済みのことがあり、
// 両方使うと断面が二重になったり、地盤の高さが粗い側に引っ張られたりする。
function keepFinestLod(cands) {
  const superseded = new Set();
  for (const c of cands) {
    if (!c.tile) continue;
    for (let p = c.tile.parent; p; p = p.parent) superseded.add(p);
  }
  return cands.filter((c) => !c.tile || !superseded.has(c.tile));
}


let _lastClipCx = NaN, _lastClipCz = NaN, _lastClipSize = NaN, _lastClipOn = null, _lastClipTerrain = null;

// クリップ面の位置を注目地点に合わせて更新する。
function updateClipPlanes() {
  const h = clipState.size / 2;
  const cx = focusLocal.x, cz = focusLocal.z;
  const apply = (planes, on) => {
    if (on) {
      planes[0].constant = cx + h;
      planes[1].constant = -(cx - h);
      planes[2].constant = cz + h;
      planes[3].constant = -(cz - h);
    } else {
      for (const p of planes) p.constant = 1e9; // 何も切らない
    }
  };
  apply(buildingClipPlanes, clipState.enabled);
  apply(terrainClipPlanes, clipState.enabled && clipState.terrain);

  // 切り抜きの位置・大きさが変わったら断面ポリゴン／地盤ラインを作り直す
  const size = clipState.size;
  if (cx !== _lastClipCx || cz !== _lastClipCz || size !== _lastClipSize ||
      clipState.enabled !== _lastClipOn || clipState.terrain !== _lastClipTerrain) {
    _lastClipCx = cx; _lastClipCz = cz; _lastClipSize = size;
    _lastClipOn = clipState.enabled; _lastClipTerrain = clipState.terrain;
    markSectionDirty();
    // 眺望ポリゴン・風致地区は切り抜き範囲に合わせて作る範囲を変えるので、こちらも作り直す
    markViewAreaDirty();
    markZonesDirty();
  }
}

// --- 建物の断面「塗りつぶし」（CPUで実際に断面ポリゴンを作る方式）-------------
//   画面空間のステンシル系は建物が非水密なため安定しなかったので、
//   幾何的に断面を計算する:
//     1) 各三角形と切断面の交線（線分）を集める
//     2) 端点が一致する線分どうしを繋いでループにする（＝建物ごとに独立した輪郭）
//     3) 開いたループ（建物に底面が無いため端が余る）は両端を直結して閉じる
//     4) 閉じた輪郭を三角形分割して面を張る
//   位相の破綻に強く、描画は普通のメッシュなので毎フレーム安定する。
const sectionFillGroup = new THREE.Group();
scene.add(sectionFillGroup);
// 面ごとにマテリアルを分ける。断面は「その面の上」にあるので自分の面では切らず、
// 残り3面で切ることで箱からはみ出た部分を落とす（同一平面での自己クリップを避ける）。
// 断面に黒い斜線ハッチを入れる。
//   ★ 断面は【不透明】なので、ゾーンレイヤーのように alpha を落とす方式は使えない
//     （何も起きない）。線の上だけ色をハッチ色に寄せる＝ mix する。
//   縞の位相は画面座標なので、ズームしてもハッチの間隔が変わらない。
//   ⚠️ onBeforeCompile を使うので customProgramCacheKey が必須。
//     また GLSL ES の予約語（half など）を変数名に使わないこと（無言で描画が壊れる）。
const _capHatchColor = new THREE.Color(CAP_HATCH_COLOR);
function applyCapHatch(mat, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const cs = Math.cos(rad).toFixed(6), sn = Math.sin(rad).toFixed(6);
  const period = CAP_HATCH.periodPx.toFixed(1), width = CAP_HATCH.widthPx.toFixed(1);
  mat.customProgramCacheKey = () => `capHatch:${cs},${sn},${period},${width}`;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        float cT = mod( gl_FragCoord.x * ${cs} + gl_FragCoord.y * ${sn}, ${period} );
        float cDist = min( cT, ${period} - cT );
        float cCov = 1.0 - smoothstep( ${width} * 0.5 - 0.7, ${width} * 0.5 + 0.7, cDist );
        diffuseColor.rgb = mix( diffuseColor.rgb,
          vec3(${_capHatchColor.r}, ${_capHatchColor.g}, ${_capHatchColor.b}), cCov );
      }`,
    );
  };
  mat.needsUpdate = true;
}
// ★ ハッチの向きは【東西の面と南北の面で逆】にする。
//   箱の角では必ず「X面とZ面」が隣り合うので、向きを変えると
//   隣接する2つの断面が別の面だと一目で分かる（＝角で折れているのが読める）。
//   面の定義: i=0:+X(西), 1:-X(東), 2:+Z(北), 3:-Z(南)。
const sectionFillMats = [0, 1, 2, 3].map((i) => {
  const m = new THREE.MeshStandardMaterial({
    color: CAP_COLOR, metalness: 0.0, roughness: 0.9, side: THREE.DoubleSide,
    clippingPlanes: buildingClipPlanes.filter((_, j) => j !== i),
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, // 壁面とのZ争い防止
  });
  applyCapHatch(m, i < 2 ? CAP_HATCH.angle : 180 - CAP_HATCH.angle);
  return m;
});
// --- 地形の断面「地盤ライン」（青い太線）--------------------------------------
//   面を張らず、交線の線分をそのまま太線で描く。土の塗りつぶしはしない。
//   WebGL の linewidth は 1px 固定で効かないので Line2 系（画面空間で太らせる）を使う。
const groundLineMats = [0, 1, 2, 3].map((i) => new LineMaterial({
  color: GROUND_LINE_COLOR,
  linewidth: GROUND_LINE_WIDTH,     // px
  worldUnits: false,                // px 指定
  // 断面は「その面の上」にあるので自分の面では切らず、残り3面で箱の外を落とす
  clippingPlanes: buildingClipPlanes.filter((_, j) => j !== i),
  depthTest: true,
  transparent: true,                // 端をなめらかに
  // 建物断面・土の面と完全に同一平面上になり得るので Z ファイティング対策で手前へ押し出す
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
}));
for (const m of groundLineMats) m.resolution.set(window.innerWidth, window.innerHeight);
const groundLines = groundLineMats.map((mat) => {
  const l = new LineSegments2(new LineSegmentsGeometry(), mat);
  l.frustumCulled = false;          // 断面は常に注目地点にあるので culling 不要
  l.renderOrder = 6;                // 建物断面(5)のすぐ後
  l.visible = false;
  scene.add(l);
  return l;
});

// --- 地形の下：土（側面4面＋底面）と 10m ごとの等高線 -----------------------
//   地盤ライン（青、地表の輪郭）から標高0まで、同じ交線データを使って
//   帯状の四角形（カーテン）を並べて埋める。ポリゴン結合が要らないぶん頑丈。
const soilFillGroup = new THREE.Group();
scene.add(soilFillGroup);
const soilMats = [0, 1, 2, 3].map((i) => new THREE.MeshStandardMaterial({
  color: SOIL_COLOR, metalness: 0.0, roughness: 1.0, side: THREE.DoubleSide,
  clippingPlanes: buildingClipPlanes.filter((_, j) => j !== i), // 自分の面では切らない
}));
// 底面（標高0の水平面、箱の footprint と同じ大きさ）。地形の凹凸に関係なく平らに閉じる。
const soilBottomMat = new THREE.MeshStandardMaterial({
  color: SOIL_COLOR, metalness: 0.0, roughness: 1.0, side: THREE.DoubleSide,
});
const soilBottomMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), soilBottomMat);
soilBottomMesh.rotation.x = -Math.PI / 2;
soilBottomMesh.renderOrder = 4;
soilBottomMesh.visible = false;
scene.add(soilBottomMesh);

// 等高線（黒・細い・SOIL_CONTOUR_STEP m ごと）。地盤ラインと同じ Line2 系。
const soilContourMats = [0, 1, 2, 3].map((i) => new LineMaterial({
  color: SOIL_CONTOUR_COLOR,
  linewidth: SOIL_CONTOUR_WIDTH,
  worldUnits: false,
  clippingPlanes: buildingClipPlanes.filter((_, j) => j !== i),
  depthTest: true,
  transparent: true,
  // 等高線は土の面と完全に同一平面上にあるため Z ファイティングする。
  // 手前へわずかに押し出して確実に勝たせる（three.js のデカール手法）。
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
}));
for (const m of soilContourMats) m.resolution.set(window.innerWidth, window.innerHeight);
const soilContourLines = soilContourMats.map((mat) => {
  const l = new LineSegments2(new LineSegmentsGeometry(), mat);
  l.frustumCulled = false;
  l.renderOrder = 7;
  l.visible = false;
  scene.add(l);
  return l;
});

// 等高線の標高ラベル（"10m" 等）。キャンバスにテキストを描いてテクスチャにし、
// 断面と同じ平面に埋め込む小さい板として側面4面すべてに置く。
const _labelTexCache = new Map(); // elevation(整数m) -> THREE.CanvasTexture（使い回す）
function getLabelTexture(elevM) {
  let tex = _labelTexCache.get(elevM);
  if (tex) return tex;
  const cvs = document.createElement('canvas');
  cvs.width = 256; cvs.height = 128;
  const ctx = cvs.getContext('2d');
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = elevM + 'm';
  // 白フチをつけて土（茶色）の上でも読みやすくする
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(label, 128, 64);
  ctx.fillStyle = '#000000';
  ctx.fillText(label, 128, 64);
  tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  _labelTexCache.set(elevM, tex);
  return tex;
}
const labelGroup = new THREE.Group();
scene.add(labelGroup);
// 面ごとに「外側に立って断面を見た人にとっての左右」と u 軸の増える向きが一致しない面がある
// （X面は u=z、Z面は u=x で、外向き法線の向きによって画面右方向が変わるため）。
//   実測して判定: face0(+X, val=cx+h) と face3(-Z, val=cz-h) は反転が必要、
//   face1(-X) と face2(+Z) はそのままで正しい（実際に描画して確認済み）。
const FACE_LABEL_FLIP_U = [true, false, false, true];
// toXYZ(u,v) で断面上の実座標に変換しながら、中心 (uCenter, level) に幅×高さの板を作る。
function makeLabelMesh(fi, tex, toXYZ, uCenter, level) {
  const hw = SOIL_LABEL_WIDTH / 2, hh = SOIL_LABEL_HEIGHT / 2;
  const p0 = toXYZ(uCenter - hw, level - hh); // 左下
  const p1 = toXYZ(uCenter + hw, level - hh); // 右下
  const p2 = toXYZ(uCenter + hw, level + hh); // 右上
  const p3 = toXYZ(uCenter - hw, level + hh); // 左上
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p3], 3));
  const uv = FACE_LABEL_FLIP_U[fi]
    ? [1, 0, 0, 0, 0, 1, 1, 1]  // U 反転（外から見て正しく読めるように）
    : [0, 0, 1, 0, 1, 1, 0, 1];
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthTest: true, side: THREE.DoubleSide,
    clippingPlanes: buildingClipPlanes.filter((_, j) => j !== fi),
    // 等高線よりさらに手前へ（土→等高線→ラベルの順で確実に勝たせる）
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 8;
  return mesh;
}

// 地盤プロファイルの信頼性判定の内訳（デバッグ用に最後の結果を保持）
let lastSoilDiag = null;
// ★ 前回きちんと描けた土が、どの箱に対するものだったか。
//   カメラを引いたり回したりすると、その場に読み込まれている地形が粗いものだけになり
//   「解像できていない」と判定されて土が消えてしまう（実際にそう見えていた）。
//   箱が同じ場所・同じ大きさのままなら、前に細かい地形で作った土をそのまま残す方が正しい。
let lastGoodSoilKey = null;

// ---- 断面ポリゴンの生成（建物用）-------------------------------------------
// 面の定義: i=0:+X面, 1:-X面, 2:+Z面, 3:-Z面。
//   断面は平面上の2次元問題になるので、(u,v) の2次元座標で扱う:
//     X面 → u=z, v=y ／ Z面 → u=x, v=y
const SECTION_EPS = 1e-4;   // 平面上とみなす距離
const SECTION_Q = 1000;     // 端点一致判定の量子化（1mm）
// 「この付近で現実的にありえない高さ」の絶対的な上限・下限[m]（原点からの相対Y）。
//   個別メッシュの bbox に頼ったクランプだけだと、bbox 自体が壊れている（＝シーングラフ
//   から外れて matrixWorld が更新されていないメッシュが紛れ込んだ）場合に無力
//   （実際にこれで京都駅原点なのに標高637万mという値が出た＝地球半径スケール）。
//   ここは個別メッシュの状態に一切頼らない、絶対的な最終防衛ライン。
export const SECTION_SANE_Y_MIN = -300, SECTION_SANE_Y_MAX = 3000;

// 三角形1枚と平面(coord[axis] = val)の交線を求めて segs に push する。
//   minY/maxY: このメッシュの実際のワールドY範囲（呼び出し側で bbox から計算済み）。
//   三角形が切断面にほぼ平行（ほぼ同一平面上）だと、境界付近の割り算 t=d0/(d0-d1) の
//   分母がほぼ0になり、数値誤差で実際のメッシュ範囲を大きく超えた高さの交点が出ることが
//   ある（実際にこれで「土が無限に高く伸びる」不具合が起きた）。メッシュの実測Y範囲で
//   クランプし、外れた交点は打ち切って捨てる（推測に頼らず、実際の頂点データで検証する）。
function triPlaneSegment(ax, ay, az, bx, by, bz, cx2, cy2, cz2, axis, val, uAxis, minY, maxY, segs) {
  const da = (axis === 0 ? ax : az) - val;
  const db = (axis === 0 ? bx : bz) - val;
  const dc = (axis === 0 ? cx2 : cz2) - val;
  // 全て同じ側なら交わらない
  if ((da > SECTION_EPS && db > SECTION_EPS && dc > SECTION_EPS) ||
      (da < -SECTION_EPS && db < -SECTION_EPS && dc < -SECTION_EPS)) return;
  const pts = [];
  const yEps = 1; // メッシュ実測範囲からのはみ出し許容[m]（float誤差の吸収）
  const edge = (d0, d1, x0, y0, z0, x1, y1, z1) => {
    if ((d0 > 0 && d1 > 0) || (d0 < 0 && d1 < 0)) return;
    if (Math.abs(d0 - d1) < 1e-9) return; // 分母がほぼ0＝三角形が面にほぼ平行。破棄する。
    const t = d0 / (d0 - d1);
    if (t < -1e-6 || t > 1 + 1e-6) return; // 本来 [0,1] のはずが外れた＝数値的に不正
    const y = y0 + (y1 - y0) * t;
    if (y < SECTION_SANE_Y_MIN || y > SECTION_SANE_Y_MAX) return; // 絶対的な最終防衛ライン
    if (y < minY - yEps || y > maxY + yEps) return; // 実測Y範囲を超えた＝不正な交点として破棄
    const u = uAxis === 0 ? x0 + (x1 - x0) * t : z0 + (z1 - z0) * t;
    pts.push(u, y);
  };
  edge(da, db, ax, ay, az, bx, by, bz);
  edge(db, dc, bx, by, bz, cx2, cy2, cz2);
  edge(dc, da, cx2, cy2, cz2, ax, ay, az);
  if (pts.length < 4) return;                    // 交点が2つ未満（片方が上の検査で破棄された等）
  const [u0, v0, u1, v1] = pts;
  if (Math.abs(u0 - u1) < 1e-6 && Math.abs(v0 - v1) < 1e-6) return; // 退化
  segs.push(u0, v0, u1, v1);
}

// 線分群を端点一致で繋いでループ化する。開いたループは両端を直結して閉じる。
function linkLoops(segs) {
  const n = segs.length / 4;
  const key = (u, v) => Math.round(u * SECTION_Q) + '_' + Math.round(v * SECTION_Q);
  const ends = new Map(); // key -> [ {seg, which} ]
  for (let s = 0; s < n; s++) {
    for (const w of [0, 1]) {
      const k = key(segs[s * 4 + w * 2], segs[s * 4 + w * 2 + 1]);
      let a = ends.get(k); if (!a) { a = []; ends.set(k, a); }
      a.push({ s, w });
    }
  }
  const used = new Uint8Array(n);
  const loops = [];
  // curU,curV から未使用の線分を辿れるだけ辿り、通った点を out に積む。
  const walk = (startU, startV, out) => {
    let curU = startU, curV = startV;
    for (let guard = 0; guard < 100000; guard++) {
      const cands = ends.get(key(curU, curV));
      if (!cands) return false;
      let nx = null;
      for (const c of cands) { if (!used[c.s]) { nx = c; break; } }
      if (!nx) return false;
      used[nx.s] = 1;
      const o = nx.w === 0 ? 1 : 0; // 反対側の端点へ進む
      curU = segs[nx.s * 4 + o * 2];
      curV = segs[nx.s * 4 + o * 2 + 1];
      out.push(curU, curV);
      if (Math.abs(curU - startU) < 1e-6 && Math.abs(curV - startV) < 1e-6) return true; // 閉じた
    }
    return false;
  };
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    // s0 の端点0から出発して端点1へ、そこから繋がる線分を辿る
    const pts = [segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]];
    const fwd = [];
    const closed = walk(segs[s0 * 4 + 2], segs[s0 * 4 + 3], fwd);
    // ↑ walk は「出発点に戻ったか」で閉じたと判定するが、ここでの出発点は s0 の端点1。
    //   実際に閉じたかどうかは、辿り終えた先端が pts の先頭に戻ったかで見る。
    const tipU = fwd.length ? fwd[fwd.length - 2] : segs[s0 * 4 + 2];
    const tipV = fwd.length ? fwd[fwd.length - 1] : segs[s0 * 4 + 3];
    const isClosed = Math.abs(tipU - pts[0]) < 1e-6 && Math.abs(tipV - pts[1]) < 1e-6;
    for (const v of fwd) pts.push(v);
    // ★ 開いたままなら、出発点から【逆方向】にも辿って前に継ぎ足す。
    //   これをしないと、開いた鎖の【途中】の線分から探索を始めたときに手前半分を
    //   取りこぼし、1本の鎖が複数の断片に割れる。閉ループでは起きないので長く
    //   表面化しなかったが、床面を持たない LOD2/LOD3 の建物を切ると断面が開くため、
    //   壁と屋根がバラバラの折れ線になって現れた。
    if (!isClosed) {
      const back = [];
      walk(pts[0], pts[1], back);
      if (back.length) {
        const head = [];
        for (let i = back.length - 2; i >= 0; i -= 2) head.push(back[i], back[i + 1]);
        pts.unshift(...head);
      }
    }
    if (pts.length >= 6) loops.push(pts); // 3点以上あれば面になる
  }
  return loops;
}

// 断面メッシュを作り直す。
const _secTmpBox = new THREE.Box3();
function buildSectionFill() {
  for (const c of sectionFillGroup.children) c.geometry.dispose();
  sectionFillGroup.clear();
  if (!clipState.enabled) {
    for (const l of groundLines) l.visible = false;
    for (const l of soilContourLines) l.visible = false;
    for (const c of soilFillGroup.children) c.geometry.dispose();
    soilFillGroup.clear();
    for (const c of labelGroup.children) { c.geometry.dispose(); c.material.dispose(); }
    labelGroup.clear();
    soilBottomMesh.visible = false;
    lastGoodSoilKey = null;   // 全体表示に切り替えた＝残しておく土は無い
    return;
  }

  const h = clipState.size / 2, cx = focusLocal.x, cz = focusLocal.z;
  // [axis(0=x,2=z), 面の座標値, uAxis(0=x,2=z)]
  const faces = [
    [0, cx + h, 2], [0, cx - h, 2],
    [2, cz + h, 0], [2, cz - h, 0],
  ];
  const segsPerFace = [[], [], [], []];        // 建物（面を張る）
  const groundSegsPerFace = [[], [], [], []];  // 地形（線のまま描く）

  // ★ 対象は「表示中」ではなく【読み込み済み】のメッシュ。
  //   3D Tiles の REPLACE 細分化は「親を置き換えるのに兄弟タイル全部が揃う」必要があるため、
  //   読み込みが済んだタイルでも長時間ずっと非表示のままになる。断面を表示中メッシュから
  //   作っていると、この間ずっと断面が作れない＝「断面が出ない／出るのが極端に遅い」
  //   の正体だった（実測: 移動後48秒間ずっと「表示タイル1枚・断面3面」のまま、
  //   その間に読込済は23枚まで増えていた）。
  //   読込済から作れば、指定地点のタイルが届いた時点ですぐ断面が完成する。
  //
  //   ワールド行列の求め方は computeClipMeshWorld を参照（切り離されたタイルの扱いが肝）。
  const secCandidates = [];
  // 1つのタイル scene に複数メッシュがあると updateMatrixWorld が重複して O(n²) になるので、
  // scene ルート単位で1回だけ更新する。
  const updatedRoots = new Set();
  const _secWorld = new THREE.Matrix4();
  for (const mesh of clipMeshes) {
    const g = mesh.geometry, posAttr = g && g.attributes.position;
    if (!posAttr) continue;
    if (!computeClipMeshWorld(mesh, _secWorld, updatedRoots)) continue;
    const world = _secWorld.clone();
    // 箱に掠りもしないメッシュは飛ばす
    if (!g.boundingBox) g.computeBoundingBox();
    const wb = new THREE.Box3().copy(g.boundingBox).applyMatrix4(world);
    if (wb.max.x < cx - h || wb.min.x > cx + h ||
        wb.max.z < cz - h || wb.min.z > cz + h) continue;
    secCandidates.push({ mesh, world, wb, tile: mesh.__clipTile, isTerrain: !!mesh.__clipIsTerrain });
  }

  // 「同じ枝で最も細かい LOD だけ」を使う（建物・地形とも）。粗い祖先と細かい子が
  // 両方読み込み済みのことがあり、両方使うと壊れる：
  //   ・建物 … 同じ建物の断面が二重にできる。
  //   ・地形 … 【地盤ラインが実際より高くなる】。京都は盆地なので、粗い地形タイルは
  //     駅と東山の山地をまたぐ巨大な三角形を持つ。それを切断面で切ると山側の標高が
  //     混ざった高い交点が出る。ビンごとの中央値を取れば細かい方に寄ると考えて
  //     地形だけ除外しない実装にしたが、粗い祖先が階層ぶん積み上がると
  //     サンプル数で押し負けて中央値ごと持ち上がった（実測: 正解 25.8〜28.5m に対し
  //     30m 等高線より上に描画された）。表示中メッシュだけを使っていた頃と同じく、
  //     最も細かい LOD だけに絞るのが正しい。
  //   欠けたビンはプロファイル側の線形補間で埋まるので、絞っても線は途切れない。
  for (const cand of keepFinestLod(secCandidates)) {
    const { mesh, world, isTerrain } = cand;
    const g = mesh.geometry, posAttr = g.attributes.position;
    _secTmpBox.copy(cand.wb);

    // 頂点をワールド座標に変換して一度だけ持つ
    const pa = posAttr.array, vc = posAttr.count, e = world.elements;
    const wp = new Float64Array(vc * 3);
    for (let i = 0; i < vc; i++) {
      const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
      wp[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      wp[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      wp[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const idx = g.index ? g.index.array : null;
    const triCount = (idx ? idx.length : vc) / 3;
    // 地形は「地表面のグループだけ」を対象にする。
    //   QuantizedMeshLoader はジオメトリを groups で区切っており、group[0]=地表面、
    //   その後に（solid なら底面キャップ、）スカート（タイル縁から垂れ下がる裾）が続く。
    //   以前は「ほぼ垂直な線分ならスカート」と傾斜で推測していたが、大文字山のような
    //   急斜面では【地盤線そのものが急勾配】なので正当な線まで捨ててしまい、
    //   青線と土が途切れる原因になっていた。グループで切ればデータ構造に基づく厳密な判定。
    let triStart = 0, triEnd = triCount;
    if (isTerrain && g.groups && g.groups.length > 0) {
      const gp = g.groups[0];
      triStart = gp.start / 3;
      triEnd = (gp.start + gp.count) / 3;
    }
    for (let f = triStart; f < triEnd; f++) {
      const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
      const ax = wp[i0 * 3], ay = wp[i0 * 3 + 1], az = wp[i0 * 3 + 2];
      const bx = wp[i1 * 3], by = wp[i1 * 3 + 1], bz = wp[i1 * 3 + 2];
      const c0 = wp[i2 * 3], c1 = wp[i2 * 3 + 1], c2 = wp[i2 * 3 + 2];
      for (let fi = 0; fi < 4; fi++) {
        const [axis, val, uAxis] = faces[fi];
        triPlaneSegment(ax, ay, az, bx, by, bz, c0, c1, c2, axis, val, uAxis,
          _secTmpBox.min.y, _secTmpBox.max.y,
          isTerrain ? groundSegsPerFace[fi] : segsPerFace[fi]);
      }
    }
  }

  // 面ごとにループ化→三角形分割→メッシュ化
  for (let fi = 0; fi < 4; fi++) {
    const segs = segsPerFace[fi];
    if (segs.length === 0) continue;
    const loops = linkLoops(segs);
    const verts = [];
    for (const pts of loops) {
      const contour = [];
      for (let i = 0; i < pts.length; i += 2) contour.push(new THREE.Vector2(pts[i], pts[i + 1]));
      // 末尾が始点と重なっていたら取り除く
      if (contour.length > 1) {
        const a = contour[0], b = contour[contour.length - 1];
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) contour.pop();
      }
      if (contour.length < 3) continue;
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (err) { continue; }
      const [axis, val, uAxis] = faces[fi];
      for (const tri of tris) {
        for (const vi of tri) {
          const p = contour[vi];
          if (uAxis === 0) verts.push(p.x, p.y, val);   // Z面: u=x, 面はz=val
          else verts.push(val, p.y, p.x);               // X面: u=z, 面はx=val
        }
      }
    }
    if (verts.length === 0) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, sectionFillMats[fi]);
    mesh.renderOrder = 5;
    sectionFillGroup.add(mesh);
  }

  // --- 地形：地盤ライン（青）／ 土（側面の帯状カーテン＋底面）／ 等高線（黒）---
  // 「地形も切り抜く」ON のときだけ描く（＝地形が実際に切られている場所を示す線）。
  // ※ 消して作り直すのは【今回きちんと描けると分かってから】。粗い地形しか無い瞬間に
  //   先に消してしまうと、前に作った正しい土まで失われて消えたように見える。
  // ★ 地盤の高さを「u 方向に等間隔サンプリングした連続プロファイル」に変換する。
  //   交線をそのまま使うと、地形メッシュの継ぎ目・欠け・LOD 切替の隙間で線分が足りず
  //   青線と土が途切れる（大文字山のような急斜面で顕著だった）。
  //   ビンに入れて欠けを線形補間で埋めれば【構造的に途切れない】＝多少ファジーでも連続。
  //   各ビンの代表値は「そのビンに入った全サンプルの中央値」＝粗いタイルと細かいタイルが
  //   同時に見えていても、サンプル数の多い（=細かい）方に自然に寄る。
  const uMinAll = [cz - h, cz - h, cx - h, cx - h]; // 面ごとの u の下限（X面はu=z, Z面はu=x）
  const NBINS = Math.max(64, Math.min(512, Math.round(clipState.size / 1.5)));
  const allV = [];
  for (let fi = 0; fi < 4; fi++) {
    const segs = clipState.terrain ? groundSegsPerFace[fi] : [];
    for (let s = 0; s < segs.length; s += 4) { allV.push(segs[s + 1], segs[s + 3]); }
  }
  // 外れ値の許容窓を「実際の標高分布」から適応的に決める。
  //   固定幅（旧: 中央値±40m）だと山地で正当な地形まで捨ててしまうので、
  //   分布のパーセンタイル幅に応じて窓を広げる。平地では狭く保たれ異常値を確実に落とす。
  let vLo = -Infinity, vHi = Infinity;
  if (allV.length > 0) {
    const sorted = allV.slice().sort((a, b) => a - b);
    const q = (t) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(t * (sorted.length - 1))))];
    const p2 = q(0.02), p98 = q(0.98);
    const margin = Math.max(SOIL_MAX_RELIEF_FROM_MEDIAN, (p98 - p2) * 0.5);
    vLo = p2 - margin; vHi = p98 + margin;
  }
  // 面ごとに profile[bin] を作る（null=データ無し）
  const profiles = [];
  let globalMaxV = 0;
  for (let fi = 0; fi < 4; fi++) {
    const segs = clipState.terrain ? groundSegsPerFace[fi] : [];
    const uMin = uMinAll[fi], uSpan = clipState.size;
    const binW = uSpan / NBINS;
    const buckets = new Array(NBINS);
    const uLo = uMin, uHi = uMin + uSpan;
    const segLens = [];   // 交線1本あたりの水平長さ＝地形の分解能の指標
    for (let s = 0; s < segs.length; s += 4) {
      let u0 = segs[s], v0 = segs[s + 1], u1 = segs[s + 2], v1 = segs[s + 3];
      if (v0 < vLo || v0 > vHi || v1 < vLo || v1 > vHi) continue; // 異常値
      if (u1 < u0) { const tu = u0; u0 = u1; u1 = tu; const tv = v0; v0 = v1; v1 = tv; }
      // ⚠️ 切断面は「無限平面」なので、箱の外（遠方）の地形との交線も入ってくる。
      //   以前はビン番号を clamp していたため、遠方の全く無関係な標高が両端のビンに
      //   大量に積み上がり、【4隅で異常に急な勾配】が出ていた。
      //   clamp ではなく「箱の u 範囲で線分をクリップ（範囲外は完全に破棄）」が正解。
      if (u1 <= uLo || u0 >= uHi) continue;         // 完全に範囲外
      // 分解能の指標は「切る前」の長さで測る（箱の端で切ると短く見えてしまうため）
      segLens.push(u1 - u0);
      let a0 = u0, b0v = v0, a1 = u1, b1v = v1;
      const span = u1 - u0;
      if (span > 1e-9) {                            // 端をまたぐ場合は境界で補間して切る
        if (u0 < uLo) { const t = (uLo - u0) / span; b0v = v0 + (v1 - v0) * t; a0 = uLo; }
        if (u1 > uHi) { const t = (uHi - u0) / span; b1v = v0 + (v1 - v0) * t; a1 = uHi; }
      }
      // この線分が覆うビンすべてに、線形補間した高さを入れる
      let bi0 = Math.floor((a0 - uMin) / binW), bi1 = Math.floor((a1 - uMin) / binW);
      bi0 = Math.max(0, Math.min(NBINS - 1, bi0));
      bi1 = Math.max(0, Math.min(NBINS - 1, bi1));
      const aSpan = a1 - a0;
      for (let b = bi0; b <= bi1; b++) {
        const uc = uMin + (b + 0.5) * binW;
        let vv;
        if (aSpan < 1e-9) vv = (b0v + b1v) / 2;
        else {
          const t = Math.max(0, Math.min(1, (uc - a0) / aSpan));
          vv = b0v + (b1v - b0v) * t;
        }
        (buckets[b] || (buckets[b] = [])).push(vv);
      }
    }
    // 各ビンの代表値＝中央値
    const prof = new Array(NBINS).fill(null);
    for (let b = 0; b < NBINS; b++) {
      const arr = buckets[b];
      if (!arr || arr.length === 0) continue;
      arr.sort((a, b2) => a - b2);
      prof[b] = arr[Math.floor(arr.length / 2)];
    }
    // 欠けたビンを埋める（両隣の既知ビンから線形補間、端は最近傍で外挿）
    let firstKnown = -1, lastKnown = -1;
    for (let b = 0; b < NBINS; b++) if (prof[b] !== null) { if (firstKnown < 0) firstKnown = b; lastKnown = b; }
    if (firstKnown >= 0) {
      for (let b = 0; b < firstKnown; b++) prof[b] = prof[firstKnown];
      for (let b = lastKnown + 1; b < NBINS; b++) prof[b] = prof[lastKnown];
      let b = firstKnown;
      while (b <= lastKnown) {
        if (prof[b] !== null) { b++; continue; }
        let e = b; while (e <= lastKnown && prof[e] === null) e++;
        const vA = prof[b - 1], vB = prof[e];
        for (let k = b; k < e; k++) prof[k] = vA + (vB - vA) * ((k - b + 1) / (e - b + 1));
        b = e;
      }
      // --- 異常勾配の除去と平滑化 ---
      // 1) メディアン3フィルタ：孤立した1ビンだけのスパイクを消す（段差は保つ）
      const med = prof.slice();
      for (let b = 1; b + 1 < NBINS; b++) {
        const a = prof[b - 1], c = prof[b], d = prof[b + 1];
        med[b] = Math.max(Math.min(a, c), Math.min(Math.max(a, c), d)); // median(a,c,d)
      }
      // 2) 「両隣に対して同方向へ急」なビンはスパイク＝データ異常として両隣の平均に置換。
      //    本物の斜面は勾配の符号が揃って続くのでこの条件に当たらず、そのまま残る。
      const maxRise = SOIL_MAX_SLOPE * binW;
      for (let pass = 0; pass < 3; pass++) {
        for (let b = 1; b + 1 < NBINS; b++) {
          const dPrev = med[b] - med[b - 1], dNext = med[b] - med[b + 1];
          if (Math.abs(dPrev) > maxRise && Math.abs(dNext) > maxRise &&
              Math.sign(dPrev) === Math.sign(dNext)) {
            med[b] = (med[b - 1] + med[b + 1]) / 2;
          }
        }
      }
      // 3) 軽い平滑化（1-2-1）でギザギザを均す
      const sm = med.slice();
      for (let b = 1; b + 1 < NBINS; b++) sm[b] = (med[b - 1] + 2 * med[b] + med[b + 1]) / 4;
      for (let b = 0; b < NBINS; b++) prof[b] = sm[b];
    }
    // ★ この面の地形が箱を解像できているか。交線の水平長さの中央値で判定する。
    //   粗いタイルは1本が数百mあり、箱の中に山側の標高を持ち込んでしまう。
    segLens.sort((a, b2) => a - b2);
    const medSegLen = segLens.length ? segLens[Math.floor(segLens.length / 2)] : Infinity;
    const resolved = segLens.length > 0 && medSegLen <= soilSegLenLimit();
    profiles.push({ prof, uMin, binW, hasData: firstKnown >= 0, resolved, medSegLen });
  }
  // ★ 土・地盤ラインは【プロファイルが信用できるようになってから】描き始める。
  //   データのある面がすべて解像できていることを条件にする（一部だけ描くと不整合に見える）。
  //   まだなら何も描かず、地形が細かくなって markSectionDirty が走るのを待つ。
  const withData = profiles.filter((p) => p.hasData);
  const soilReliable = withData.length > 0 && withData.every((p) => p.resolved);
  // 等高線の範囲は「信用できる面」からだけ決める（粗い面の異常値を持ち込まない）
  if (soilReliable) {
    for (const p of withData) {
      for (let b = 0; b < NBINS; b++) if (p.prof[b] > globalMaxV) globalMaxV = p.prof[b];
    }
  }
  // ★ カメラを引く・回すと、その場に読み込まれている地形が粗いものだけになって
  //   「解像できていない」と判定され、土と地盤ラインが消えてしまっていた。
  //   箱が同じ場所・同じ大きさなら【前に細かい地形で作った土をそのまま残す】。
  //   （箱が動いた／大きさが変わった／切り抜きをやめたときは、古い土は意味がないので作り直す）
  const soilKey = `${cx.toFixed(1)},${cz.toFixed(1)},${clipState.size},${clipState.terrain}`;
  const keepPreviousSoil = !soilReliable && lastGoodSoilKey === soilKey;

  lastSoilDiag = { 解像できた: soilReliable,
    前回の土を維持: keepPreviousSoil,
    面ごとの交線長中央値m: profiles.map((p) => (Number.isFinite(p.medSegLen) ? +p.medSegLen.toFixed(1) : null)),
    必要な上限m: +soilSegLenLimit().toFixed(1) };

  if (keepPreviousSoil) return;   // 土まわりは前回のものを残したまま、ここで終わり

  // ここから先で作り直すので、いま出ている土とラベルを片付ける
  for (const c of soilFillGroup.children) c.geometry.dispose();
  soilFillGroup.clear();
  for (const c of labelGroup.children) { c.geometry.dispose(); c.material.dispose(); }
  labelGroup.clear();
  lastGoodSoilKey = soilReliable ? soilKey : null;
  // 等高線の高さ一覧。実際の標高（海水準基準）のキリのいい数字（10, 20, ...）に揃える。
  //   ローカルY と標高の関係: 標高 = ORIGIN_ELEVATION + ローカルY なので、
  //   標高が10の倍数になるローカルY = (10の倍数) − ORIGIN_ELEVATION。
  //   標高0（＝ローカルY=SEA_LEVEL_Y）は底面がすでに示すので等高線には含めない。
  const contourLevels = [];
  for (let elev = SOIL_CONTOUR_STEP; elev - ORIGIN_ELEVATION <= globalMaxV; elev += SOIL_CONTOUR_STEP) {
    contourLevels.push(elev - ORIGIN_ELEVATION);
  }

  for (let fi = 0; fi < 4; fi++) {
    const { prof, uMin, binW, hasData } = profiles[fi];
    const [axis, val, uAxis] = faces[fi];
    const toXYZ = (u, v) => (uAxis === 0 ? [u, v, val] : [val, v, u]);
    const line = groundLines[fi], cline = soilContourLines[fi];
    if (!hasData || !clipState.terrain || !soilReliable) {
      line.visible = false; cline.visible = false; continue;
    }
    const uAt = (b) => uMin + (b + 0.5) * binW;

    // 地盤ライン（青）: プロファイルを繋いだ連続折れ線（欠けは補間済みなので必ず繋がる）
    const linePts = [];
    for (let b = 0; b + 1 < NBINS; b++) {
      const [x0, y0, z0] = toXYZ(uAt(b), prof[b]);
      const [x1, y1, z1] = toXYZ(uAt(b + 1), prof[b + 1]);
      linePts.push(x0, y0, z0, x1, y1, z1);
    }
    const lg = new LineSegmentsGeometry(); lg.setPositions(linePts);
    line.geometry.dispose(); line.geometry = lg; line.visible = true;

    // 土（帯状カーテン）: 隣り合うビン間を、標高0m（海水準=SEA_LEVEL_Y）まで下ろした四角形。
    // プロファイルが連続なので土も途切れない。
    const soilVerts = [];
    for (let b = 0; b + 1 < NBINS; b++) {
      const v0 = Math.max(SEA_LEVEL_Y, prof[b]), v1 = Math.max(SEA_LEVEL_Y, prof[b + 1]);
      if (v0 === SEA_LEVEL_Y && v1 === SEA_LEVEL_Y) continue; // 標高0以下（土なし）
      const u0 = uAt(b), u1 = uAt(b + 1);
      const [x0t, y0t, z0t] = toXYZ(u0, v0), [x1t, y1t, z1t] = toXYZ(u1, v1);
      const [x0b, y0b, z0b] = toXYZ(u0, SEA_LEVEL_Y), [x1b, y1b, z1b] = toXYZ(u1, SEA_LEVEL_Y);
      soilVerts.push(x0t, y0t, z0t, x1t, y1t, z1t, x1b, y1b, z1b);
      soilVerts.push(x0t, y0t, z0t, x1b, y1b, z1b, x0b, y0b, z0b);
    }
    if (soilVerts.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(soilVerts, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, soilMats[fi]);
      mesh.renderOrder = 4;
      soilFillGroup.add(mesh);
    }

    // 等高線（黒）＋標高ラベル: プロファイルを高さ H で切った区間を線分にする。
    const uCenter = axis === 0 ? cz : cx; // この面の水平方向の中心
    const contourPts = [];
    for (const H of contourLevels) {
      if (H <= SEA_LEVEL_Y) continue;
      let found = false, coversCenter = false, fallbackU = null;
      for (let b = 0; b + 1 < NBINS; b++) {
        const v0 = prof[b], v1 = prof[b + 1];
        const hi = Math.max(v0, v1), lo = Math.min(v0, v1);
        if (H > hi) continue;               // この区間はHより低い＝土が無い
        let a = uAt(b), c = uAt(b + 1);
        if (H > lo) {                        // 部分区間：交点まで
          const t = (H - v0) / (v1 - v0);
          const uH = a + (c - a) * t;
          if (v0 >= v1) c = uH; else a = uH;
        }
        const [xa, ya, za] = toXYZ(a, H), [xb, yb, zb] = toXYZ(c, H);
        contourPts.push(xa, ya, za, xb, yb, zb);
        found = true;
        if (fallbackU === null) fallbackU = (a + c) / 2;
        if (uCenter >= Math.min(a, c) && uCenter <= Math.max(a, c)) coversCenter = true;
      }
      if (found) {
        const labelU = coversCenter ? uCenter : fallbackU;
        const elevInt = Math.round(H + ORIGIN_ELEVATION);
        labelGroup.add(makeLabelMesh(fi, getLabelTexture(elevInt), toXYZ, labelU, H));
      }
    }
    if (contourPts.length === 0) { cline.visible = false; }
    else {
      const clg = new LineSegmentsGeometry(); clg.setPositions(contourPts);
      cline.geometry.dispose(); cline.geometry = clg; cline.visible = true;
    }
  }

  // 底面（標高0m=海水準=SEA_LEVEL_Y、箱の footprint と同じ大きさの水平面）
  if (clipState.terrain && clipState.enabled && soilReliable) {
    soilBottomMesh.position.set(focusLocal.x, SEA_LEVEL_Y, focusLocal.z);
    soilBottomMesh.scale.set(clipState.size, clipState.size, 1);
    soilBottomMesh.visible = true;
  } else {
    soilBottomMesh.visible = false;
  }
}

export {
  CLIP_SIZE_MIN, CLIP_SIZE_MAX, CLIP_SIZE_STEP, CLIP_SIZE_DEFAULT,
  CAP_COLOR, clipState, buildingClipPlanes, terrainClipPlanes, updateClipPlanes,
  clipMeshes, registerClipMeshes, unregisterClipMeshes,
  computeClipMeshWorld, keepFinestLod,
  sectionFillGroup, soilFillGroup, soilBottomMesh, labelGroup,
  groundLines, groundLineMats, soilContourLines, soilContourMats, soilMats,
  buildSectionFill,
  triPlaneSegment, linkLoops,   // 断面図（profile.js）の建物断面トライアルで再利用
};
export const getSoilDiag = () => lastSoilDiag;

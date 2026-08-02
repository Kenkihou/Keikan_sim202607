// =============================================================================
// viewareas — 眺望空間保全地域（ポリゴン）を地形の起伏に沿わせて重ねる。
//   元データは EPSG:2448 の .shp。shp2json.py で WGS84 の JSON に変換済み。
// =============================================================================
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { THREE, scene, el, focusLocal, dirty, markViewAreaDirty, markViewLimitDirty } from './core.js';
import {
  DEG2RAD, ORIGIN_LAT, ORIGIN_LON,
  VIEW_AREA_URL, VIEW_AREA_FILL_COLOR, VIEW_AREA_FILL_OPACITY,
  VIEW_AREA_LINE_COLOR, VIEW_AREA_LINE_WIDTH,
  VIEW_AREA_MAX_RADIUS, VIEW_AREA_GRID_MAX_SIDE, VIEW_AREA_LIFT,
  VIEW_AREA_GRID_CELL, VIEW_AREA_MAX_EDGE, VIEW_AREA_MIN_EDGE, VIEW_AREA_HEIGHT_TOL, VIEW_AREA_MAX_TRIS,
  VIEW_LIMIT_URL, VIEW_LIMIT_COLOR, VIEW_LIMIT_OPACITY,
  VIEW_LIMIT_MAX_EDGE, VIEW_LIMIT_MIN_EDGE, VIEW_LIMIT_HEIGHT_TOL,
  ZONE_LAYERS, ZONE_GRID_MAX_SIDE, ZONE_GRID_CELL, ZONE_MAX_EDGE,
  ZONE_MIN_EDGE, ZONE_HEIGHT_TOL, ZONE_MAX_TRIS, ZONE_MAX_RADIUS, ZONE_LIFT,
  ZONE_FILL_OPACITY, ZONE_LINE_WIDTH, ZONE_LINE_LIFT, ZONE_STACK_GAP,
  SEA_LEVEL_Y,
} from './config.js';
import { EARTH_R } from './core.js';
import { clipState, terrainClipPlanes, clipMeshes, computeClipMeshWorld, keepFinestLod,
  SECTION_SANE_Y_MIN, SECTION_SANE_Y_MAX } from './section.js';

// =========================================================================
// 眺望空間保全地域（ポリゴン）を地形に沿わせて重ねる
//   ・元は EPSG:2448 の .shp。事前に WGS84 経緯度の JSON へ変換してある。
//   ・「地形に沿わせる」＝ポリゴンを細かく分割し、各頂点の高さを地形から取る。
//     地形メッシュに1点ずつ Raycaster を撃つと、分割後は数千〜1万点になり重すぎるので、
//     【一度だけ地形の高さグリッドを作り、以後は O(1) で引く】方式にしている。
// =========================================================================
const viewAreaGroup = new THREE.Group();
viewAreaGroup.renderOrder = 4;
scene.add(viewAreaGroup);
const viewAreaState = { enabled: false, loaded: false, error: null, features: [] };

// ポリゴンは地面に貼り付くものなので、切り抜き箱は【地形と同じ terrainClipPlanes】に従わせる。
//   ＝「中心を切り抜く」＋「地形も切り抜く」が ON のときだけ 500m 四方などの線で切れる。
//   地形を全域表示しているのにポリゴンだけ宙で切れる、という不整合を避けられる。
const viewAreaFillMat = new THREE.MeshBasicMaterial({
  color: VIEW_AREA_FILL_COLOR, transparent: true, opacity: VIEW_AREA_FILL_OPACITY,
  side: THREE.DoubleSide, depthWrite: false,
  clippingPlanes: terrainClipPlanes,
  // ⚠️ 大きくし過ぎると地形だけでなく【建物にも勝ってしまい建物が埋まる】
  //   （factor -8 / units -16 にしたら実際にそうなった）。
  //   地形は事実上ポリゴンと同一平面なので、数LSBの控えめな値で十分勝てる。
  //   factor は傾き成分で浅い仰角に効くが、効き過ぎるのもここなので小さく保つ。
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3,
});
const viewAreaLineMat = new LineMaterial({
  color: VIEW_AREA_LINE_COLOR, linewidth: VIEW_AREA_LINE_WIDTH,
  transparent: true, depthTest: true, dashed: false,
  clippingPlanes: terrainClipPlanes,
  // 外周線は面より少しだけ手前に（面と同一平面なので線が消えないように）
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -5,
});
viewAreaLineMat.resolution.set(window.innerWidth, window.innerHeight);

// 経緯度[deg] → ローカル座標(x,z)。setFocusLatLon と同じ局所ENU近似。
function lonLatToLocal(lonDeg, latDeg) {
  const lat = latDeg * DEG2RAD, lon = lonDeg * DEG2RAD;
  const north = (lat - ORIGIN_LAT) * EARTH_R;
  const east = (lon - ORIGIN_LON) * EARTH_R * Math.cos(lat);
  return [-east, north];   // scene は +X=西 / +Z=北
}

async function loadViewAreas() {
  try {
    const res = await fetch(VIEW_AREA_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    viewAreaState.features = json.features.map((f) => ({
      name: f.name, no: f.no,
      // 各リングを [x0,z0, x1,z1, ...] のローカル座標配列にしておく（毎回変換しない）
      rings: f.rings.map((r) => {
        const a = new Float64Array(r.length * 2);
        for (let i = 0; i < r.length; i++) {
          const [x, z] = lonLatToLocal(r[i][0], r[i][1]);
          a[i * 2] = x; a[i * 2 + 1] = z;
        }
        return a;
      }),
    }));
    viewAreaState.loaded = true;
    markViewAreaDirty();
  } catch (e) {
    viewAreaState.error = String(e.message || e);
    console.warn('眺望空間保全地域の読み込みに失敗:', e);
  }
  updateViewAreaInfo();
}

// ---- 地形の高さグリッド ---------------------------------------------------
//   地形メッシュの三角形を上から見て格子に焼き込む（＝簡易ラスタライズ）。
//   セル中心が三角形の内側なら重心座標で高さを補間して入れる。
//   ★ 対象は【読み込み済み】の地形（表示中だけではない）。
//     表示中だけを使うと、視錐台の外に出たタイルが非表示になった瞬間に高さが取れなくなり、
//     【カメラを回しただけでポリゴンが消える】（実測: orbit で表示地域が 5→3 に減った）。
//     読込済から作れば、カメラの向きに関係なく同じ結果になる。
//   最も細かい LOD だけに絞る（粗い祖先が混ざると地盤が持ち上がる。断面と同じ理由）。
const _vaTriBox = new THREE.Box3();
const _vaWorld = new THREE.Matrix4();
function buildTerrainHeightGrid(cx, cz, radius, cell, excessRadiusCells = 0) {
  const nx = Math.ceil((radius * 2) / cell) + 1;
  const nz = nx;
  const x0 = cx - radius, z0 = cz - radius;
  const data = new Float32Array(nx * nz).fill(NaN);
  const wp = [];
  const updatedRoots = new Set();
  const cands = [];
  for (const mesh of clipMeshes) {
    if (!mesh.__clipIsTerrain) continue;
    const g = mesh.geometry;
    if (!g || !g.attributes.position) continue;
    if (!computeClipMeshWorld(mesh, _vaWorld, updatedRoots)) continue;
    const world = _vaWorld.clone();
    if (!g.boundingBox) g.computeBoundingBox();
    _vaTriBox.copy(g.boundingBox).applyMatrix4(world);
    if (_vaTriBox.max.x < x0 || _vaTriBox.min.x > x0 + radius * 2 ||
        _vaTriBox.max.z < z0 || _vaTriBox.min.z > z0 + radius * 2) continue;
    cands.push({ mesh, world, tile: mesh.__clipTile });
  }
  const used = keepFinestLod(cands);
  for (const cand of used) {
    const mesh = cand.mesh, g = mesh.geometry, pos = g.attributes.position;
    // 頂点をワールドへ
    const vc = pos.count, pa = pos.array, e = cand.world.elements;
    if (wp.length < vc * 3) wp.length = vc * 3;
    for (let i = 0; i < vc; i++) {
      const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
      wp[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      wp[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      wp[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const idx = g.index ? g.index.array : null;
    // 地表面グループだけ（断面と同じ理由。以降はスカート＝タイル縁から垂れる裾）
    let triStart = 0, triEnd = (idx ? idx.length : vc) / 3;
    if (g.groups && g.groups.length > 0) {
      triStart = g.groups[0].start / 3;
      triEnd = (g.groups[0].start + g.groups[0].count) / 3;
    }
    for (let f = triStart; f < triEnd; f++) {
      const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
      const ax = wp[i0 * 3], ay = wp[i0 * 3 + 1], az = wp[i0 * 3 + 2];
      const bx = wp[i1 * 3], by = wp[i1 * 3 + 1], bz = wp[i1 * 3 + 2];
      const gx = wp[i2 * 3], gy = wp[i2 * 3 + 1], gz = wp[i2 * 3 + 2];
      // ★ 絶対的な健全性チェック（断面と同じ最終防衛ライン）。
      //   keepFinestLod で粗い祖先は落ちるが、【finer な子が1枚も読めていない場所】では
      //   誤差 78,492m といった planet 規模のルートタイルが最精細として残る。その三角形は
      //   局所ENU系で地球の裏側（Y ≈ -1.16e7）まで届き、そのまま焼き込むと
      //   高さグリッドに 1,000万m 級の値が入る（実測: 半径13kmの格子で2節点が -12,709,466）。
      //   1点でも常識外なら三角形ごと捨てる（planet 規模なので局所の高さには使えない）。
      if (ay < SECTION_SANE_Y_MIN || ay > SECTION_SANE_Y_MAX ||
          by < SECTION_SANE_Y_MIN || by > SECTION_SANE_Y_MAX ||
          gy < SECTION_SANE_Y_MIN || gy > SECTION_SANE_Y_MAX) continue;
      const minX = Math.min(ax, bx, gx), maxX = Math.max(ax, bx, gx);
      const minZ = Math.min(az, bz, gz), maxZ = Math.max(az, bz, gz);
      let ci0 = Math.floor((minX - x0) / cell), ci1 = Math.ceil((maxX - x0) / cell);
      let cj0 = Math.floor((minZ - z0) / cell), cj1 = Math.ceil((maxZ - z0) / cell);
      if (ci1 < 0 || cj1 < 0 || ci0 >= nx || cj0 >= nz) continue;
      ci0 = Math.max(0, ci0); cj0 = Math.max(0, cj0);
      ci1 = Math.min(nx - 1, ci1); cj1 = Math.min(nz - 1, cj1);
      const d = (bz - gz) * (ax - gx) + (gx - bx) * (az - gz);
      if (Math.abs(d) < 1e-12) continue;   // 上から見て潰れている三角形
      for (let j = cj0; j <= cj1; j++) {
        const pz = z0 + j * cell;
        for (let i = ci0; i <= ci1; i++) {
          const px = x0 + i * cell;
          const w0 = ((bz - gz) * (px - gx) + (gx - bx) * (pz - gz)) / d;
          const w1 = ((gz - az) * (px - gx) + (ax - gx) * (pz - gz)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const y = w0 * ay + w1 * by + w2 * gy;
          const k = j * nx + i;
          // LOD が重なった場合に地表側を採る（スカートは除外済みだが保険）
          if (!(data[k] >= y)) data[k] = y;
        }
      }
    }
  }
  const grid = { x0, z0, cell, nx, nz, data };
  if (excessRadiusCells > 0) grid.excess = buildExcessGrid(grid, used, excessRadiusCells);
  return grid;
}

// ---- 「地形が高さグリッドの面からどれだけ飛び出しているか」の格子 ----------------
//   ★ これが必要な理由（実測で分かった）:
//     地形に貼るポリゴンは高さグリッドの節点を頂点にした【平らな三角形】なので、
//     尾根のように節点と節点の間が盛り上がっている所では、面が地形の下をくぐる。
//     そこは地形が手前に描かれ、見る角度によってポリゴンに穴が開いたように見える。
//     実測（風致地区・セル28.8m・浮かせ0.3m）: 西山で三角形の 13.3% が突き抜け、最大 9.95m。
//   ⚠️ 「三角形を細かくする」でも「一律に浮かせる」でも解決しない（実測）:
//     三角形を倍(85万→171万)にしても突き抜けは 12.6%→7.6% にしか減らず、
//     一律 5m 浮かせると 1.7% まで減るが【平地でも 5m 浮いて建物が埋まる】。
//   → 地形が飛び出している量そのものを測って、その場所だけ浮かせるのが正解。
//     各地形頂点について「実際の高さ − グリッド面の高さ」を求め、
//     周囲の節点に max で置く。その後、三角形の最大辺ぶんだけ最大値フィルタで広げる
//     （面の内部＝頂点と頂点の間で潜るので、頂点位置だけ見ても足りないため）。
//
//   ⚠️ もっと強い測り方（節点の接平面からのずれ／弦のたるみ）も試したが、どちらも
//     突き抜けは 0% になる代わりに【山で 30〜40m も浮く】ので採らなかった。
//     この「地形頂点 − グリッド面」方式は控えめだが、浮きが 平地 0.30m / 山 p90 5.6m に
//     収まりつつ突き抜けを 13.3%→4.3% に落とせる、という釣り合いが良い。
function buildExcessGrid(grid, cands, radiusCells) {
  const { x0, z0, cell, nx, nz } = grid;
  const ex = new Float32Array(nx * nz);   // 0 で初期化（＝飛び出しなし）
  for (const cand of cands) {
    const g = cand.mesh.geometry, pos = g.attributes.position;
    const pa = pos.array, e = cand.world.elements;
    // 地表面グループの頂点だけを見る（スカートは除外。高さグリッドと同じ理由）
    const idx = g.index ? g.index.array : null;
    const has = g.groups && g.groups.length > 0;
    const start = has ? g.groups[0].start : 0;
    const count = has ? g.groups[0].count : (idx ? idx.length : pos.count);
    for (let f = 0; f < count; f++) {
      const vi = idx ? idx[start + f] : start + f;
      const px = pa[vi * 3], py = pa[vi * 3 + 1], pz = pa[vi * 3 + 2];
      const wx = e[0] * px + e[4] * py + e[8] * pz + e[12];
      const wy = e[1] * px + e[5] * py + e[9] * pz + e[13];
      const wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
      if (wy < SECTION_SANE_Y_MIN || wy > SECTION_SANE_Y_MAX) continue;
      const h = sampleGrid(grid, wx, wz);
      if (Number.isNaN(h)) continue;
      const d = wy - h;
      if (d <= 0) continue;
      const i = Math.round((wx - x0) / cell), j = Math.round((wz - z0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const k = j * nx + i;
      if (d > ex[k]) ex[k] = d;
    }
  }
  // 分離型の最大値フィルタで radiusCells だけ広げる（横→縦の2パス）
  const tmp = new Float32Array(nx * nz);
  const r = Math.max(1, Math.round(radiusCells));
  for (let j = 0; j < nz; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let m = 0;
      const a = Math.max(0, i - r), b = Math.min(nx - 1, i + r);
      for (let t = a; t <= b; t++) { const v = ex[row + t]; if (v > m) m = v; }
      tmp[row + i] = m;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      let m = 0;
      const a = Math.max(0, j - r), b = Math.min(nz - 1, j + r);
      for (let t = a; t <= b; t++) { const v = tmp[t * nx + i]; if (v > m) m = v; }
      ex[j * nx + i] = m;
    }
  }
  return ex;
}


// 飛び出し量を引く（高さと同じ双線形補間。節点が欠けていても 0 として扱う＝浮かせない）
function sampleExcess(grid, x, z) {
  const ex = grid.excess;
  if (!ex) return 0;
  const fx = (x - grid.x0) / grid.cell, fz = (z - grid.z0) / grid.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i + 1 >= grid.nx || j + 1 >= grid.nz) return 0;
  const tx = fx - i, tz = fz - j, n = grid.nx;
  const h00 = ex[j * n + i], h10 = ex[j * n + i + 1];
  const h01 = ex[(j + 1) * n + i], h11 = ex[(j + 1) * n + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// グリッドから高さを引く（4隅すべてにデータがある時だけ双線形補間。無ければ NaN）
function sampleGrid(grid, x, z) {
  const fx = (x - grid.x0) / grid.cell, fz = (z - grid.z0) / grid.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i + 1 >= grid.nx || j + 1 >= grid.nz) return NaN;
  const tx = fx - i, tz = fz - j;
  const d = grid.data, n = grid.nx;
  const h00 = d[j * n + i], h10 = d[j * n + i + 1], h01 = d[(j + 1) * n + i], h11 = d[(j + 1) * n + i + 1];
  if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) return NaN;
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// 三角形を分割して地形に沿わせる。
//   ★【最長辺の二分割】を使うこと。全辺を半分にする4分割は、三角形分割(ear clipping)が生む
//     細長い三角形で破綻する。例えば 1m×3000m の三角形は 4分割だと 8段で 65,536 枚に
//     爆発するが、最長辺だけ割れば長辺が縮むだけなので数百枚で済む
//     （実測: 4分割 26,770枚 → 最長辺二分割 1,000枚前後／300m四方）。
//   ★【高さの誤差で分割を止める】こと。以前は「辺が maxEdge 以下」だけで打ち切っていたが、
//     それだと起伏のある土地で三角形の内部（頂点を結ぶ弦）が地形から大きく浮く
//     （実測: 岩倉付近で重心の浮きが最大 22m ＝建物より高い位置にポリゴンが乗った）。
//     最長辺の中点で「弦の高さ」と「実際の地形の高さ」を比べ、tol を超えるなら更に割る。
//     こうすると平坦地は粗いまま・急な場所だけ細かくなるので、枚数を抑えたまま密着する。
//   ⚠️ 分割前に【描画範囲(box)と交差しない三角形を捨てる】ことも重要。眺望ポリゴンは
//     1辺が数kmあるので、範囲外まで細かく割ってから捨てるのは完全な無駄になる。
//   再帰だとスタックが深くなるので明示スタックで回す。
function subdivideTri(tri, maxEdge, minEdge, tol, sampleAt, box, out, maxTris = VIEW_AREA_MAX_TRIS) {
  const stack = [tri];
  while (stack.length) {
    const t = stack.pop();
    const ax = t[0], az = t[1], bx = t[2], bz = t[3], cx2 = t[4], cz2 = t[5];
    if (Math.min(ax, bx, cx2) > box.maxX || Math.max(ax, bx, cx2) < box.minX ||
        Math.min(az, bz, cz2) > box.maxZ || Math.max(az, bz, cz2) < box.minZ) continue;
    const e0 = Math.hypot(bx - ax, bz - az);
    const e1 = Math.hypot(cx2 - bx, cz2 - bz);
    const e2 = Math.hypot(ax - cx2, az - cz2);
    const m = Math.max(e0, e1, e2);
    // 暴走止め。ここに達すると以降は分割せず粗いまま出すので、
    // 常時張り付くようなら tol を緩めるか半径を縮めること。
    if (out.length > maxTris) { out.push(t); continue; }
    let split = m > maxEdge;
    // 最長辺の中点で「直線で結んだ高さ」と「地形の高さ」を比べる
    let mx, mz;
    if (m === e0) { mx = (ax + bx) / 2; mz = (az + bz) / 2; }
    else if (m === e1) { mx = (bx + cx2) / 2; mz = (bz + cz2) / 2; }
    else { mx = (cx2 + ax) / 2; mz = (cz2 + az) / 2; }
    if (!split && m > minEdge) {
      const hA = m === e0 ? sampleAt(ax, az) : m === e1 ? sampleAt(bx, bz) : sampleAt(cx2, cz2);
      const hB = m === e0 ? sampleAt(bx, bz) : m === e1 ? sampleAt(cx2, cz2) : sampleAt(ax, az);
      const hM = sampleAt(mx, mz);
      if (!Number.isNaN(hA) && !Number.isNaN(hB) && !Number.isNaN(hM) &&
          Math.abs((hA + hB) / 2 - hM) > tol) split = true;
    }
    if (!split) { out.push(t); continue; }
    if (m === e0) stack.push([ax, az, mx, mz, cx2, cz2], [mx, mz, bx, bz, cx2, cz2]);
    else if (m === e1) stack.push([bx, bz, mx, mz, ax, az], [mx, mz, cx2, cz2, ax, az]);
    else stack.push([cx2, cz2, mx, mz, bx, bz], [mx, mz, ax, az, bx, bz]);
  }
}

function clearViewAreaGroup() {
  for (const c of viewAreaGroup.children) {
    c.geometry.dispose();
  }
  viewAreaGroup.clear();
}

let viewAreaStats = { 面: 0, 範囲内: 0, 三角形: 0, ms: 0 };
function buildViewAreas() {
  clearViewAreaGroup();
  if (!viewAreaState.enabled || !viewAreaState.loaded) { updateViewAreaInfo(); return; }
  const t0 = performance.now();
  const cx = focusLocal.x, cz = focusLocal.z;
  // 描く範囲の決め方:
  //   ・切り抜きが効いているとき … どうせ箱の外は描かれないので箱まで絞る（細かい格子で高精度）
  //   ・それ以外 … ★【全ポリゴンを覆う】。建物タイルの読み込み範囲とは無関係に全域を描く。
  //     以前は注目地点から半径1500mに絞っていたので、広域を見てもほとんど描かれなかった。
  const clipping = clipState.enabled && clipState.terrain;
  let R;
  if (clipping) {
    R = clipState.size / 2 + VIEW_AREA_MAX_EDGE * 2;
  } else {
    R = 0;
    for (const f of viewAreaState.features) {
      for (const ring of f.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const dx = Math.abs(ring[i] - cx), dz = Math.abs(ring[i + 1] - cz);
          if (dx > R) R = dx;
          if (dz > R) R = dz;
        }
      }
    }
    R = Math.min(VIEW_AREA_MAX_RADIUS, R + VIEW_AREA_MAX_EDGE * 2);
  }
  // 範囲が広いときはセルを粗くして格子のノード数を抑える。
  //   高さグリッドのコストは格子サイズより「地形三角形の走査」で決まるので範囲を広げても安く、
  //   粗くしても地形との差はほとんど増えない（config.js の実測値を参照）。
  const cell = Math.max(VIEW_AREA_GRID_CELL, (R * 2) / VIEW_AREA_GRID_MAX_SIDE);
  const grid = buildTerrainHeightGrid(cx, cz, R, cell);
  // 分割の細かさは格子の粗さに合わせる。格子が表現できない細かさまで割っても情報は増えず、
  // 三角形が無駄に増えるだけ（実測: 全域を tol 0.4m で割ると 478,153枚・547ms）。
  //   ・最大辺は格子の2倍まで
  //   ・許容誤差は「格子自体の誤差」を下回らせない（15mセルの格子は最大1.28mずれる）
  const maxEdge = Math.max(VIEW_AREA_MAX_EDGE, cell * 2);
  const tol = Math.max(VIEW_AREA_HEIGHT_TOL, cell * 0.08);
  const box = { minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R };
  const verts = [], linePts = [];
  let nFeat = 0, nTri = 0, nOverlap = 0;
  for (const feat of viewAreaState.features) {
    let used = false, overlap = false;
    for (const ring of feat.rings) {
      const n = ring.length / 2;
      if (n < 3) continue;
      // 注目地点の周辺にかすりもしないリングは飛ばす
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = ring[i * 2], z = ring[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (maxX < cx - R || minX > cx + R || maxZ < cz - R || minZ > cz + R) continue;
      overlap = true;   // 範囲には掛かっている（描けるかは地形が読めているか次第）

      // --- 面: 三角形分割 → 細分化 → 地形の高さを与える ---
      const contour = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
      // 終点が始点と重なっていたら取り除く（shapefile のリングは閉じている）
      const a0 = contour[0], aN = contour[contour.length - 1];
      if (Math.abs(a0.x - aN.x) < 1e-9 && Math.abs(a0.y - aN.y) < 1e-9) contour.pop();
      if (contour.length >= 3) {
        let tris = null;
        try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (err) { tris = null; }
        if (tris) {
          const small = [];
          for (const t of tris) {
            const p = contour[t[0]], q = contour[t[1]], r = contour[t[2]];
            subdivideTri([p.x, p.y, q.x, q.y, r.x, r.y], maxEdge, VIEW_AREA_MIN_EDGE,
              tol, (x, z) => sampleGrid(grid, x, z), box, small);
          }
          for (const t of small) {
            const y0 = sampleGrid(grid, t[0], t[1]);
            const y1 = sampleGrid(grid, t[2], t[3]);
            const y2 = sampleGrid(grid, t[4], t[5]);
            // 地形が読めていない三角形は描かない（宙に浮くのを防ぐ）
            if (Number.isNaN(y0) || Number.isNaN(y1) || Number.isNaN(y2)) continue;
            verts.push(t[0], y0 + VIEW_AREA_LIFT, t[1],
                       t[2], y1 + VIEW_AREA_LIFT, t[3],
                       t[4], y2 + VIEW_AREA_LIFT, t[5]);
            nTri++; used = true;
          }
        }
      }

      // --- 外周線: 各辺をセル幅で分割して地形に沿わせる ---
      for (let i = 0; i < n; i++) {
        const x1 = ring[i * 2], z1 = ring[i * 2 + 1];
        const j = (i + 1) % n;
        const x2 = ring[j * 2], z2 = ring[j * 2 + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / cell));
        let px = x1, pz = z1, py = sampleGrid(grid, px, pz);
        for (let s = 1; s <= steps; s++) {
          const qx = x1 + (x2 - x1) * s / steps, qz = z1 + (z2 - z1) * s / steps;
          const qy = sampleGrid(grid, qx, qz);
          if (!Number.isNaN(py) && !Number.isNaN(qy)) {
            linePts.push(px, py + VIEW_AREA_LIFT * 1.5, pz, qx, qy + VIEW_AREA_LIFT * 1.5, qz);
            used = true;
          }
          px = qx; pz = qz; py = qy;
        }
      }
    }
    if (used) nFeat++;
    if (overlap) nOverlap++;
  }
  if (verts.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const m = new THREE.Mesh(geom, viewAreaFillMat);
    m.renderOrder = 4;
    viewAreaGroup.add(m);
  }
  if (linePts.length) {
    const lg = new LineSegmentsGeometry();
    lg.setPositions(linePts);
    const l = new LineSegments2(lg, viewAreaLineMat);
    l.renderOrder = 5;
    l.computeLineDistances();
    viewAreaGroup.add(l);
  }
  viewAreaStats = { 面: nFeat, 範囲内: nOverlap, 三角形: nTri,
    半径m: Math.round(R), セルm: +cell.toFixed(1), 最大辺m: Math.round(maxEdge),
    許容ずれm: +tol.toFixed(2), ms: Math.round(performance.now() - t0) };
  updateViewAreaInfo();
}

function updateViewAreaInfo() {
  const infoEl = el('viewAreaInfo');
  if (!infoEl) return;
  if (viewAreaState.error) { infoEl.textContent = '眺望データ読込失敗: ' + viewAreaState.error; return; }
  if (!viewAreaState.enabled) { infoEl.textContent = ''; return; }
  if (!viewAreaState.loaded) { infoEl.textContent = '眺望データ読込中…'; return; }
  // 「付近に無い」のか「あるが地形がまだ読めていない」のかを区別する
  if (viewAreaStats.面 > 0) {
    infoEl.textContent = `眺望空間保全区域: ${viewAreaStats.面} 区域を表示中`;
  } else if (viewAreaStats.範囲内 > 0) {
    infoEl.textContent = `眺望空間保全区域 ${viewAreaStats.範囲内} 区域が範囲内（地形の読み込み待ち）`;
  } else {
    infoEl.textContent = `この付近には眺望空間保全区域はありません（全${viewAreaState.features.length}区域）`;
  }
}

loadViewAreas();


// =============================================================================
// 眺望規制の「標高面」を斜面として描く
//   眺望空間保全地域は実務上「建物の標高規制」のエリアで、その上限が【標高面】。
//   ・視点場上の任意の点＋1.5m と、視対象（五山の字の底辺）a・b の3点で張る三角形の面。
//     視点場が線の地域では平面族になり、効くのはその最小値（どの視点からも遮らないため）。
//   ・面そのものは公式の 規制値等高線.shp を contour2surface.py で経緯度の規則格子
//     （高さの2次元配列）に変換したものを読む。等高線の間はラプラス補間で埋めてある。
//   ・格子は経緯度なので、config.js の原点を変えても影響を受けない
//     （EPSG:2448 のままだと京都では子午線収差 約0.14度＝4kmで約10mの回転ずれが出る）。
// =============================================================================
const viewLimitGroup = new THREE.Group();
scene.add(viewLimitGroup);
const viewLimitState = { enabled: false, loaded: false, error: null, areas: [] };

const viewLimitMat = new THREE.MeshLambertMaterial({
  color: VIEW_LIMIT_COLOR, transparent: true, opacity: VIEW_LIMIT_OPACITY,
  side: THREE.DoubleSide, depthWrite: false,
  // ポリゴンと同じく地形側の切り抜きに従わせる（カットモデルでは天井面も一緒に切る）
  clippingPlanes: terrainClipPlanes,
});

async function loadViewLimits() {
  try {
    const res = await fetch(VIEW_LIMIT_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    viewLimitState.areas = json.areas.map((a) => {
      // 格子ノードの経緯度 → ローカル座標を先に作っておく（毎回変換しない）
      const xs = new Float64Array(a.nx), zs = new Float64Array(a.nz);
      for (let j = 0; j < a.nz; j++) zs[j] = lonLatToLocal(a.lon0, a.lat0 + j * a.dLat)[1];
      const latm = a.lat0 + (a.nz - 1) * a.dLat / 2;
      for (let i = 0; i < a.nx; i++) xs[i] = lonLatToLocal(a.lon0 + i * a.dLon, latm)[0];
      // 規制範囲の輪郭もローカル座標にしておく（縁を正確に出すため三角形分割に使う）
      const ring = new Float64Array(a.ring.length * 2);
      for (let k = 0; k < a.ring.length; k++) {
        const [x, z] = lonLatToLocal(a.ring[k][0], a.ring[k][1]);
        ring[k * 2] = x; ring[k * 2 + 1] = z;
      }
      // 格子はローカル座標でもほぼ等間隔なので、位置→添字は線形で逆算できる
      const stepX = a.nx > 1 ? (xs[a.nx - 1] - xs[0]) / (a.nx - 1) : 1;
      const stepZ = a.nz > 1 ? (zs[a.nz - 1] - zs[0]) / (a.nz - 1) : 1;
      return { ...a, xs, zs, ring, stepX, stepZ,
        minX: Math.min(xs[0], xs[a.nx - 1]), maxX: Math.max(xs[0], xs[a.nx - 1]),
        minZ: Math.min(zs[0], zs[a.nz - 1]), maxZ: Math.max(zs[0], zs[a.nz - 1]) };
    });
    viewLimitState.loaded = true;
    markViewLimitDirty();
  } catch (e) {
    viewLimitState.error = String(e.message || e);
    console.warn('眺望規制面の読み込みに失敗:', e);
  }
  updateViewLimitInfo();
}


// 標高面の格子から標高[m]を引く。
//   4隅すべてに値があれば双線形補間。無ければ【当てはめた平面】で代用する。
//   ⚠️ 平面での代用が無いと、視点場が点の地域で面が先端まで届かない。
//     そういう地域の規制範囲は「視点場を頂点・視対象の底辺を底」とする三角形なので、
//     先端は必ず格子セル(20m)より細くなり格子に値が入らない。
//     実測の欠け: funehou 240m / funedai 128m / funemyou 93m / funayamahidari 77m。
//   代用が効くのは輪郭の内側の細い部分だけなので、面全体の精度には影響しない。
function sampleLimit(a, x, z) {
  const fx = (x - a.xs[0]) / a.stepX, fz = (z - a.zs[0]) / a.stepZ;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i >= 0 && j >= 0 && i + 1 < a.nx && j + 1 < a.nz) {
    const H = a.h, n = a.nx, tx = fx - i, tz = fz - j;
    const h00 = H[j * n + i], h10 = H[j * n + i + 1];
    const h01 = H[(j + 1) * n + i], h11 = H[(j + 1) * n + i + 1];
    if (h00 !== null && h10 !== null && h01 !== null && h11 !== null) {
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    }
  }
  const p = a.plane;
  return p ? p[0] * fx + p[1] * fz + p[2] : NaN;
}

// 法線は【格子の勾配から直接作る】。
//   ⚠️ 輪郭を三角形分割した非索引メッシュに computeVertexNormals() を使うと
//     面ごとの法線になってファセット（階段状の陰影）が出る。頂点を溶接する手も
//     あるが分割経路によって座標が一致しない場合があり確実でない。
//     格子の勾配から法線を作れば、三角形の切り方に関係なく必ず滑らかになる。
const _lnA = [0, 0, 0];
function limitNormal(a, x, z, out) {
  const d = Math.max(Math.abs(a.stepX), Math.abs(a.stepZ));
  const hx0 = sampleLimit(a, x - d, z), hx1 = sampleLimit(a, x + d, z);
  const hz0 = sampleLimit(a, x, z - d), hz1 = sampleLimit(a, x, z + d);
  const c = sampleLimit(a, x, z);
  const dhdx = Number.isNaN(hx0) || Number.isNaN(hx1) ? 0 : (hx1 - hx0) / (2 * d);
  const dhdz = Number.isNaN(hz0) || Number.isNaN(hz1) ? 0 : (hz1 - hz0) / (2 * d);
  let nx = -dhdx, ny = 1, nz = -dhdz;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
  return c;
}

let viewLimitStats = { 地域: 0, 三角形: 0, ms: 0 };
function buildViewLimits() {
  for (const c of viewLimitGroup.children) c.geometry.dispose();
  viewLimitGroup.clear();
  if (!viewLimitState.enabled || !viewLimitState.loaded) { updateViewLimitInfo(); return; }
  const t0 = performance.now();
  const verts = [], norms = [];
  let nArea = 0, nTri = 0;
  const nrm = [0, 0, 0];
  // ★ 距離で絞り込まず【12地域すべて】を作る。標高面は格子JSONだけから作れて
  //   地形にも建物タイルにも依存しないので、注目地点がどこにあっても結果は同じ。
  //   よってこの関数は JSON 到着時の1回で完成し、地点移動では作り直さない。
  for (const a of viewLimitState.areas) {
    // ★ 面は【規制範囲の輪郭】を三角形分割して作る。格子セル単位で作ると縁が
    //   格子に量子化されてガタガタになるため（上から見ると顕著だった）。
    //   高さだけを格子から引くので、縁は輪郭そのままの精度になる。
    const ring = a.ring, np = ring.length / 2;
    if (np < 3) continue;
    const contour = [];
    for (let k = 0; k < np; k++) contour.push(new THREE.Vector2(ring[k * 2], ring[k * 2 + 1]));
    const p0 = contour[0], pN = contour[contour.length - 1];
    if (Math.abs(p0.x - pN.x) < 1e-9 && Math.abs(p0.y - pN.y) < 1e-9) contour.pop();
    if (contour.length < 3) continue;
    let tris = null;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { tris = null; }
    if (!tris) continue;
    const box = { minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ };
    const sampleAt = (x, z) => sampleLimit(a, x, z);
    const small = [];
    for (const t of tris) {
      const p = contour[t[0]], q = contour[t[1]], r = contour[t[2]];
      subdivideTri([p.x, p.y, q.x, q.y, r.x, r.y], VIEW_LIMIT_MAX_EDGE, VIEW_LIMIT_MIN_EDGE,
        VIEW_LIMIT_HEIGHT_TOL, sampleAt, box, small);
    }
    let used = false;
    for (const t of small) {
      const y0 = limitNormal(a, t[0], t[1], nrm), n0 = [nrm[0], nrm[1], nrm[2]];
      const y1 = limitNormal(a, t[2], t[3], nrm), n1 = [nrm[0], nrm[1], nrm[2]];
      const y2 = limitNormal(a, t[4], t[5], nrm), n2 = [nrm[0], nrm[1], nrm[2]];
      if (Number.isNaN(y0) || Number.isNaN(y1) || Number.isNaN(y2)) continue;
      verts.push(t[0], y0 + SEA_LEVEL_Y, t[1], t[2], y1 + SEA_LEVEL_Y, t[3], t[4], y2 + SEA_LEVEL_Y, t[5]);
      norms.push(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], n2[0], n2[1], n2[2]);
      nTri++; used = true;
    }
    if (used) nArea++;
  }
  if (verts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));  // 格子の勾配から作った滑らかな法線
    const m = new THREE.Mesh(g, viewLimitMat);
    m.renderOrder = 3;
    viewLimitGroup.add(m);
  }
  viewLimitStats = { 地域: nArea, 三角形: nTri, ms: Math.round(performance.now() - t0) };
  updateViewLimitInfo();
}

function updateViewLimitInfo() {
  const infoEl = el('viewLimitInfo');
  if (!infoEl) return;
  if (viewLimitState.error) { infoEl.textContent = '標高面の読込失敗: ' + viewLimitState.error; return; }
  if (!viewLimitState.enabled) { infoEl.textContent = ''; return; }
  if (!viewLimitState.loaded) { infoEl.textContent = '標高面を読込中…'; return; }
  infoEl.textContent = viewLimitStats.地域 > 0
    ? `標高面: ${viewLimitStats.地域} 区域（${viewLimitStats.三角形.toLocaleString()} 面）を表示中`
    : '標高面を作れませんでした';
}

loadViewLimits();


// =============================================================================
// ゾーンレイヤー（風致地区・自然風景保全地区）を地形に沿わせて重ねる
//   眺望空間保全地域と同じ方式だが、面積が桁違いに大きい（179.5km² / 259.9km²）ので、
//   ・高さグリッドは粗め（ZONE_GRID_MAX_SIDE=900）にして節点数を抑える
//   ・種別ごとに別メッシュにして、切り替えは【visible の付け替えだけ】にする
//     （作り直さないので、チェックを付け外ししても一切コストがかからない）
//   ・穴（内環）を ShapeUtils.triangulateShape の holes に渡す
//     ※ 眺望空間保全地域には穴が無かったので、この扱いはここで初めて要る。
//   ・尾根での突き抜け対策に「飛び出し格子」で場所ごとに浮かせ量を変える（後述）
//   レイヤーの追加は config.js の ZONE_LAYERS に1行足すだけでよい。
// =============================================================================
// 面を「斜線ハッチ」で描くようにマテリアルを改造する。
//   ★ 重ね指定を読ませるための仕掛け（config の hatch のコメント参照）。
//   画面ピクセル基準（gl_FragCoord）なので、ズームしても縞の間隔が変わらない。
//   縞の位相は gl_FragCoord.x*cos + gl_FragCoord.y*sin。この式の勾配の大きさは
//   常に 1 なので、アンチエイリアスの幅は fwidth を使わず 0.7px 固定でよい
//   （mod() の折り返しで fwidth が跳ねるのを避けられる）。
//   ⚠️ `customProgramCacheKey` を必ず一緒に定義すること。three.js は onBeforeCompile の
//     中身をプログラムのキャッシュキーに含めないので、同じ材質クラス・同じ設定の
//     マテリアルが既にあると【改造前のプログラムが使い回されてハッチが出ない】。
//   ⚠️⚠️ 変数名に `half` を使わないこと。GLSL ES の【予約語】なので
//     `ERROR: 'half' : Illegal use of reserved word` でコンパイルに失敗する。
//     しかも three.js 側はこの失敗を握りつぶすことがあり、コンソールに何も出ないまま
//     【面だけ描かれない】状態になる（実際にこれで小一時間溶かした）。
//     怪しいときは、素の WebGL で `gl.compileShader` して `getShaderInfoLog` を見るのが速い。
function applyHatch(mat, hatch) {
  const period = Number(hatch.periodPx || 10).toFixed(1);
  let body, key;
  if (hatch.pattern === 'dots') {
    // 点々（正方格子に丸を並べる）
    const r = Number(hatch.radiusPx || 1.6).toFixed(2);
    key = `dots:${period},${r}`;
    body = `
        vec2 hG = mod( gl_FragCoord.xy, ${period} ) - ${period} * 0.5;
        float hCov = smoothstep( ${r} - 0.7, ${r} + 0.7, length( hG ) );`;
  } else {
    // 縞。angles: [0, 90] のように複数渡すとクロスハッチになる（各方向の縞の和集合）
    const angles = hatch.angles || [hatch.angle != null ? hatch.angle : 45];
    const width = Number(hatch.widthPx || 3).toFixed(1);
    key = `lines:${angles.join('/')},${period},${width}`;
    // hCov は「線に乗っていない度合い」。方向ごとの smoothstep の min を取ると和集合になる。
    const passes = angles.map((a, i) => {
      const rad = a * Math.PI / 180;
      const cs = Math.cos(rad).toFixed(6), sn = Math.sin(rad).toFixed(6);
      return `
        { float hT${i} = mod( gl_FragCoord.x * ${cs} + gl_FragCoord.y * ${sn}, ${period} );
          float hD${i} = min( hT${i}, ${period} - hT${i} );   // 縞の中心線からの距離[px]
          hCov = min( hCov, smoothstep( hHalf - 0.7, hHalf + 0.7, hD${i} ) ); }`;
    }).join('');
    body = `
        float hHalf = ${width} * 0.5;
        float hCov = 1.0;${passes}`;
  }
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {${body}
        diffuseColor.a *= 1.0 - hCov;
      }`,
    );
  };
  mat.needsUpdate = true;
}

const ZONE_STENCIL_BIT = 1;   // 重なり除去に使うステンシルの値（他で未使用）
const zoneLineMats = [];      // 画面リサイズ時に resolution を更新するため main.js が使う
const zonePending = new Set(); // 作り直し待ちのレイヤー
const zoneLayers = ZONE_LAYERS.map((def, order) => {
  const group = new THREE.Group();
  scene.add(group);
  // ★ 重なる所で「どちらが手前か」を安定させる。
  //   風致地区と自然風景保全地区は山地で大きく重なるので、同じ高さ・同じ深度オフセットだと
  //   Z ファイトでまだら模様になる。配列の後ろのレイヤーほど、
  //   ・幾何的に ZONE_STACK_GAP ぶん高く（近距離で効く）
  //   ・深度オフセットも段違いに（遠距離で効く。眺望ポリゴンと同じ役割分担）
  //   ・renderOrder も後ろに（半透明の描画順を固定して混色を安定させる）
  const offUnits = -3 - order * 2;
  group.renderOrder = 4 + order;
  // ★ 重なりを消す（subtract）ためのステンシル。
  //   「別のレイヤーと重なった所は描かない」を、ポリゴンの論理差分を計算せずに実現する。
  //   ・自分を消す側に使われるレイヤー（＝誰かの subtract に名前が挙がっている）は、
  //     描画時にステンシルへ 1 を書く（塗りつぶし・ハッチの隙間も含めて面全体が対象）。
  //   ・消される側は「ステンシルが 0 の画素だけ描く」。
  //   ポリゴンのブーリアン演算は堅牢な実装が要るうえ境界がギザギザになりがちだが、
  //   この方法は【画素単位で厳密】かつ幾何計算がゼロ。消す側のレイヤーを非表示にすれば
  //   ステンシルが書かれなくなり、自動的に元の全域が出るのも都合が良い。
  //   ⚠️ 消す側が【先に】描かれる必要があるので、ZONE_LAYERS では消す側を前に置くこと。
  const isMask = ZONE_LAYERS.some((o) => (o.subtract || []).includes(def.id));
  const subtracted = (def.subtract || []).length > 0;
  const mats = new Map();
  for (const k of def.kinds) {
    const fill = new THREE.MeshBasicMaterial({
      color: k.fill, transparent: true,
      opacity: def.opacity != null ? def.opacity : ZONE_FILL_OPACITY,
      side: THREE.DoubleSide, depthWrite: false,
      clippingPlanes: terrainClipPlanes,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: offUnits,
    });
    if (isMask) {
      fill.stencilWrite = true;
      fill.stencilFunc = THREE.AlwaysStencilFunc;
      fill.stencilRef = ZONE_STENCIL_BIT;
      fill.stencilZPass = THREE.ReplaceStencilOp;   // 深度テストを通った画素に印を付ける
    }
    if (subtracted) {
      fill.stencilWrite = true;                     // three.js は write=false だとテストも無効
      fill.stencilFunc = THREE.NotEqualStencilFunc; // 印が付いていない所だけ描く
      fill.stencilRef = ZONE_STENCIL_BIT;
      fill.stencilZPass = THREE.KeepStencilOp;
      fill.stencilFail = THREE.KeepStencilOp;
      fill.stencilZFail = THREE.KeepStencilOp;
    }
    if (def.hatch) applyHatch(fill, def.hatch);
    // ★ 破線の外周線（`dash` を指定したレイヤーだけ）。
    //   `LineSegmentsGeometry.computeLineDistances()` は【線分をまたいで距離を積算する】ので、
    //   セル幅で細かく刻んだ外周でも破線が途切れずに続く（リングの切れ目で位相がずれるだけ）。
    //   dashSize / gapSize はワールド単位[m]。
    const line = new LineMaterial({
      color: k.line, linewidth: def.lineWidth != null ? def.lineWidth : ZONE_LINE_WIDTH,
      transparent: true, depthTest: true,
      dashed: !!def.dash,
      dashSize: def.dash ? def.dash.dashSize : 1,
      gapSize: def.dash ? def.dash.gapSize : 1,
      clippingPlanes: terrainClipPlanes,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: offUnits - 2,
    });
    // 外周線は消さない。「どこまでが保存区域か」は境界線で分かる必要があるため。
    // （面だけを消して線は残す＝重なった所は特別保存地区の模様＋保存区域の外周線になる）
    line.resolution.set(window.innerWidth, window.innerHeight);
    zoneLineMats.push(line);
    mats.set(k.kind, { fill, line });
  }
  return {
    def, group, mats, order,
    extraLift: order * ZONE_STACK_GAP,
    enabled: false, loaded: false, error: null, features: [],
    // 種別ごとの表示 ON/OFF。既定は全部 ON（マスターのチェックで一括切り替え）
    kinds: new Set(def.kinds.map((k) => k.kind)),
    stats: { 面: 0, 三角形: 0, ms: 0 },
  };
});

async function loadZone(layer) {
  try {
    const res = await fetch(layer.def.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const toLocal = (r) => {
      const a = new Float64Array(r.length * 2);
      for (let i = 0; i < r.length; i++) {
        const [x, z] = lonLatToLocal(r[i][0], r[i][1]);
        a[i * 2] = x; a[i * 2 + 1] = z;
      }
      return a;
    };
    layer.features = json.features.map((f) => ({
      kind: f.kind, name: f.name, no: f.no,
      rings: f.rings.map(toLocal),
      holes: (f.holes || []).map(toLocal),
    }));
    layer.loaded = true;
    zonePending.add(layer);
  } catch (e) {
    layer.error = String(e.message || e);
    console.warn(layer.def.label + 'の読み込みに失敗:', e);
  }
  updateZoneInfo(layer);
}

function clearZoneGroup(layer) {
  for (const c of layer.group.children) c.geometry.dispose();
  layer.group.clear();
}

function buildZone(layer) {
  clearZoneGroup(layer);
  if (!layer.enabled || !layer.loaded) { updateZoneInfo(layer); return; }
  const t0 = performance.now();
  // 範囲の決め方は眺望ポリゴンと同じ（切り抜き中は箱まで絞る＝細かい格子で高精度）。
  //   ★ 全域のときは中心を【注目地点ではなくそのレイヤーの広がりの中心】に置く。
  //     注目地点(京都駅)基準だと風致地区が南北に偏っているぶん半径が 16.8km 必要になり、
  //     同じ節点数なら格子が粗くなる（実測: 中心をずらすだけで 半径16.0km/セル35.6m →
  //     半径13.0km/セル28.8m）。しかも MAX_RADIUS で頭打ちになって北端が切れていた。
  const clipping = clipState.enabled && clipState.terrain;
  let cx, cz, R;
  if (clipping) {
    cx = focusLocal.x; cz = focusLocal.z;
    R = clipState.size / 2 + ZONE_MAX_EDGE * 2;
  } else {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const f of layer.features) {
      for (const ring of f.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i], z = ring[i + 1];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
    if (!Number.isFinite(minX)) { updateZoneInfo(layer); return; }
    cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
    R = Math.min(ZONE_MAX_RADIUS, Math.max(maxX - cx, maxZ - cz) + ZONE_MAX_EDGE * 2);
  }
  const cell = Math.max(ZONE_GRID_CELL, (R * 2) / ZONE_GRID_MAX_SIDE);
  const maxEdge = Math.max(ZONE_MAX_EDGE, cell * 2);
  const tol = Math.max(ZONE_HEIGHT_TOL, cell * 0.08);
  // ★ 飛び出し格子も一緒に作る。広げる幅は【三角形の最大辺】ぶん。
  //   平らな三角形が尾根をまたぐ以上、その三角形が覆う範囲の一番高い所まで持ち上げないと
  //   必ずどこかで刺さる。つまりこの幅は調整値ではなく幾何から決まる。
  //   実測（風致地区・西山ほか3窓＋市街地・突き抜けた三角形の割合 / 実際の浮き p90）:
  //     広げ幅 0m（＝浮かせ一律0.3m）… 13.3% / 0.30m
  //     広げ幅 29m (0.5辺)          …  6.0% / 2.49m
  //     広げ幅 58m (1.0辺)          …  4.3% / 5.56m  ← 採用
  //     広げ幅 86m (1.5辺)          …  2.3% / 8.34m（これ以上は浮きが増えるだけ）
  //   ※ 平地の浮きはどの設定でも 0.30m のまま（中央値）。上がるのは起伏のある所だけ。
  //   ※ 浮きを減らしたいなら ZONE_GRID_MAX_SIDE を上げて三角形を細かくすること。
  const grid = buildTerrainHeightGrid(cx, cz, R, cell, maxEdge / cell);
  const box = { minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R };
  const sample = (x, z) => sampleGrid(grid, x, z);
  // 地形が飛び出している所だけ余分に浮かせる（平地は ZONE_LIFT のまま）。
  //   extraLift はレイヤーの重ね順ぶん（後ろのレイヤーほど手前に来る）。
  const base = ZONE_LIFT + layer.extraLift;
  const liftAt = (x, z) => base + sampleExcess(grid, x, z);
  // 種別ごとに貯める（メッシュを分けて visible だけで切り替えるため）
  const bins = new Map();
  for (const k of layer.def.kinds) bins.set(k.kind, { verts: [], line: [], feats: 0 });
  let nTri = 0, capped = false;
  for (const feat of layer.features) {
    const bin = bins.get(feat.kind);
    if (!bin) continue;
    let used = false;
    for (const ring of feat.rings) {
      const n = ring.length / 2;
      if (n < 3) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = ring[i * 2], z = ring[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (maxX < cx - R || minX > cx + R || maxZ < cz - R || minZ > cz + R) continue;

      const contour = toContour(ring);
      if (contour.length < 3) continue;
      // ★ 穴（内環）は triangulateShape の holes に渡す
      //   （shapefile は面ごとに環をまとめているので、その面の穴とみなしてよい）。
      const holes = [];
      for (const h of feat.holes) {
        const hc = toContour(h);
        if (hc.length >= 3) holes.push(hc);
      }
      let tris = null;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (err) { tris = null; }
      if (tris) {
        // triangulateShape のインデックスは [輪郭..., 穴1..., 穴2...] の通し番号
        const all = holes.length ? contour.concat(...holes) : contour;
        // 暴走止めは【全体の残り枚数】で見る（面ごとに上限を持つと合計で青天井になる）
        const room = Math.max(0, ZONE_MAX_TRIS - nTri);
        const small = [];
        for (const t of tris) {
          const p = all[t[0]], q = all[t[1]], r = all[t[2]];
          if (!p || !q || !r) continue;
          subdivideTri([p.x, p.y, q.x, q.y, r.x, r.y], maxEdge, ZONE_MIN_EDGE,
            tol, sample, box, small, room);
        }
        if (small.length > room) capped = true;
        for (const t of small) {
          const y0 = sample(t[0], t[1]), y1 = sample(t[2], t[3]), y2 = sample(t[4], t[5]);
          if (Number.isNaN(y0) || Number.isNaN(y1) || Number.isNaN(y2)) continue;
          bin.verts.push(t[0], y0 + liftAt(t[0], t[1]), t[1],
                         t[2], y1 + liftAt(t[2], t[3]), t[3],
                         t[4], y2 + liftAt(t[4], t[5]), t[5]);
          nTri++; used = true;
        }
      }
      // 外周線（穴の縁も引く。区域の境目が読めるように）
      for (const r of [ring, ...feat.holes]) drapeOutline(r, grid, cell, liftAt, bin.line);
    }
    if (used) bin.feats++;
  }
  let nFeat = 0;
  for (const k of layer.def.kinds) {
    const bin = bins.get(k.kind);
    nFeat += bin.feats;
    const mats = layer.mats.get(k.kind);
    const on = layer.kinds.has(k.kind);
    if (bin.verts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bin.verts, 3));
      const m = new THREE.Mesh(g, mats.fill);
      m.renderOrder = 4 + layer.order * 2; m.visible = on; m.userData.zoneKind = k.kind;
      layer.group.add(m);
    }
    if (bin.line.length) {
      const lg = new LineSegmentsGeometry();
      lg.setPositions(bin.line);
      const l = new LineSegments2(lg, mats.line);
      l.renderOrder = 5 + layer.order * 2; l.visible = on; l.userData.zoneKind = k.kind;
      l.computeLineDistances();
      layer.group.add(l);
    }
  }
  layer.stats = { 面: nFeat, 三角形: nTri, 半径m: Math.round(R), セルm: +cell.toFixed(1),
    最大辺m: Math.round(maxEdge), 許容ずれm: +tol.toFixed(2),
    上限に達した: capped, ms: Math.round(performance.now() - t0) };
  updateZoneInfo(layer);
}

// リングを Vector2 の輪郭にする（終点が始点と重なっていたら落とす）
function toContour(ring) {
  const n = ring.length / 2;
  const c = [];
  for (let i = 0; i < n; i++) c.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  const a0 = c[0], aN = c[c.length - 1];
  if (c.length > 1 && Math.abs(a0.x - aN.x) < 1e-9 && Math.abs(a0.y - aN.y) < 1e-9) c.pop();
  return c;
}

// リングの各辺をセル幅で刻んで地形に沿わせ、線分配列に積む。
//   線は面と【同じ高さ】に置き、ZONE_LINE_LIFT（2cm）だけ足す。
//   ⚠️ ここを倍率にすると線だけ宙に浮く（config の ZONE_LINE_LIFT のコメント参照）。
function drapeOutline(ring, grid, cell, liftAt, out) {
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = ring[i * 2], z1 = ring[i * 2 + 1];
    const j = (i + 1) % n;
    const x2 = ring[j * 2], z2 = ring[j * 2 + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / cell));
    let px = x1, pz = z1, py = sampleGrid(grid, px, pz);
    for (let s = 1; s <= steps; s++) {
      const qx = x1 + (x2 - x1) * s / steps, qz = z1 + (z2 - z1) * s / steps;
      const qy = sampleGrid(grid, qx, qz);
      if (!Number.isNaN(py) && !Number.isNaN(qy)) {
        out.push(px, py + liftAt(px, pz) + ZONE_LINE_LIFT, pz,
                 qx, qy + liftAt(qx, qz) + ZONE_LINE_LIFT, qz);
      }
      px = qx; pz = qz; py = qy;
    }
  }
}

// 種別の表示切り替え。★ 作り直さず visible を付け替えるだけ（コスト 0）。
function setZoneKind(layer, kind, on) {
  if (on) layer.kinds.add(kind); else layer.kinds.delete(kind);
  for (const c of layer.group.children) {
    if (c.userData.zoneKind === kind) c.visible = on;
  }
  updateZoneInfo(layer);
}

function updateZoneInfo(layer) {
  const infoEl = el('zoneInfo_' + layer.def.id);
  if (!infoEl) return;
  const name = layer.def.label;
  if (layer.error) { infoEl.textContent = name + 'の読込失敗: ' + layer.error; return; }
  if (!layer.enabled) { infoEl.textContent = ''; return; }
  if (!layer.loaded) { infoEl.textContent = name + 'を読込中…'; return; }
  // 種別が1つだけのレイヤーは「◯種別を表示中」を出さない（意味が無いので）
  const shown = layer.def.kinds.filter((k) => layer.kinds.has(k.kind)).length;
  const kindPart = layer.def.kinds.length > 1 ? `／${shown} 種別を表示中` : ' を表示中';
  infoEl.textContent = layer.stats.面 > 0
    ? `${name}: ${layer.stats.面} 面（${layer.stats.三角形.toLocaleString()} 三角形）${kindPart}`
    : `この付近に${name}はありません`;
}

// ---- 作り直しの管理 --------------------------------------------------------
//   ★ 1フレームに作るのは【1レイヤーだけ】。どのレイヤーも数百ms かかるので、
//     まとめて作ると1フレームが1秒を超えて明確にカクつく。
//   地形の増減や注目地点の移動は core の dirty.zone（世代番号）で伝わる。
//   タイル側・断面側から viewareas を import しないための仕掛け（循環回避）。
let zoneEpochSeen = -1;
function zonesStep() {
  if (dirty.zone !== zoneEpochSeen) {
    zoneEpochSeen = dirty.zone;
    for (const l of zoneLayers) zonePending.add(l);
  }
  for (const l of zonePending) {
    zonePending.delete(l);
    buildZone(l);
    return true;      // 1つ作った
  }
  return false;       // 作るものが無かった
}

// 凡例の色見本。★ 画面上の見え方と凡例を一致させる（ハッチならハッチで見せる）。
//   CSS の repeating-linear-gradient は角度が時計回りなので、GLSL 側と合わせるには 180-angle。
//   クロスハッチは方向のぶんだけグラデーションを重ねる。
function styleSwatch(sw, def, k) {
  const col = '#' + k.fill.toString(16).padStart(6, '0');
  // 破線のレイヤーは、色見本も「破線の枠」にして画面と揃える
  if (def.dash) {
    sw.style.background = col;
    sw.style.border = '1px dashed #' + k.line.toString(16).padStart(6, '0');
    return;
  }
  if (!def.hatch) { sw.style.background = col; return; }
  const p = def.hatch.periodPx || 10;
  if (def.hatch.pattern === 'dots') {
    const r = def.hatch.radiusPx || 1.6;
    sw.style.background = `radial-gradient(circle at 50% 50%, ${col} 0 ${r}px, transparent ${r + 0.7}px)`;
    sw.style.backgroundSize = `${p}px ${p}px`;
    return;
  }
  const w = def.hatch.widthPx || 3;
  const angles = def.hatch.angles || [def.hatch.angle != null ? def.hatch.angle : 45];
  sw.style.background = angles
    .map((a) => `repeating-linear-gradient(${180 - a}deg, ${col} 0 ${w}px, transparent ${w}px ${p}px)`)
    .join(', ');
}

// 凡例の1行（チェック＋色見本＋ラベル）を作る
function makeLegendRow(id, label, def, k, checked, onChange) {
  const row = document.createElement('div');
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  const sw = document.createElement('i');
  styleSwatch(sw, def, k);
  lab.append(cb, sw, document.createTextNode(label));
  row.appendChild(lab);
  return row;
}

(function setupZoneUI() {
  const host = el('zoneLayers');
  if (!host) return;
  // ★ group が同じ【連続した】レイヤーは1つのまとまりにする。
  //   まとめても描画・生成は独立のまま。まとめるのは HUD の見せ方だけ。
  const blocks = [];
  for (const layer of zoneLayers) {
    const g = layer.def.group;
    const last = blocks[blocks.length - 1];
    if (g && last && last.group === g) last.layers.push(layer);
    else blocks.push({ group: g, layers: [layer] });
  }
  // ★ メニューの並び順は描画順とは別（uiOrder）。
  //   ZONE_LAYERS の並びは【描画順・重ね順・浮かせ量の段差】を決めるものなので、
  //   見せたい順に並べ替えると重なりの前後関係まで変わってしまう。
  //   （例: 美観地区をメニュー先頭にしたいからと配列先頭に移すと、
  //     市街地で美観地区が風致地区の下に潜って見えなくなる）
  blocks.sort((a, b) => (a.layers[0].def.uiOrder || 0) - (b.layers[0].def.uiOrder || 0));
  for (const block of blocks) {
    const grouped = block.layers.length > 1;
    const head = grouped ? block.group : block.layers[0].def.label;
    // マスターのチェック（グループならまとめて ON/OFF）
    const lab = document.createElement('label');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.id = 'zoneOn_' + (grouped ? block.layers.map((l) => l.def.id).join('-') : block.layers[0].def.id);
    lab.append(on);
    // ★ 凡例が1行だけになる場合は、その色見本をマスターのラベルに付けて凡例を出さない
    //   （マスターと同じものが2つ並ぶのを避けるため）。
    const single = !grouped && block.layers[0].def.kinds.length === 1;
    if (single) {
      const sw = document.createElement('i');
      styleSwatch(sw, block.layers[0].def, block.layers[0].def.kinds[0]);
      lab.append(sw);
    }
    lab.append(document.createTextNode(head));
    host.appendChild(lab);

    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.id = 'zoneLegend_' + (grouped ? block.group : block.layers[0].def.id);
    if (!single) {
      // 凡例の行は config の並び順どおりに作る。1つのグループに
      // 「種別を持つレイヤーの種別行」と「種別を持たないレイヤーの行」が混在してよい
      // （例: 風致地区の第1〜5種のすぐ下に特別修景地域が並ぶ）。
      for (const l of block.layers) {
        const def = l.def;
        if (def.kinds.length > 1) {
          for (const k of def.kinds) {
            legend.appendChild(makeLegendRow(
              'zoneKind_' + def.id + '_' + k.kind, k.label, def, k, l.kinds.has(k.kind),
              (v) => setZoneKind(l, k.kind, v)));
          }
        } else {
          // 種別が無いレイヤーは、そのレイヤー自身を1行にする。
          //   既定は ON（実際に出るかはマスターとの AND）。
          legend.appendChild(makeLegendRow(
            'zoneOn_' + def.id, def.rowLabel || def.label, def, def.kinds[0], true,
            (v) => { l.enabled = on.checked && v; zonePending.add(l); }));
        }
      }
    }
    host.appendChild(legend);
    for (const l of block.layers) {
      const info = document.createElement('div');
      info.className = 'stats-line';
      info.id = 'zoneInfo_' + l.def.id;
      host.appendChild(info);
    }

    // レイヤー自身の行（種別が無いレイヤーのぶん）。無い場合は null。
    const rowOf = (l) => (l.def.kinds.length > 1 ? null : el('zoneOn_' + l.def.id));
    const sync = () => {
      legend.classList.toggle('on', on.checked);
      // マスターが OFF のときは行のチェックを触れなくする（DOM 側だけ）
      for (const l of block.layers) {
        const cb = rowOf(l);
        if (cb && cb !== on) cb.disabled = !on.checked;
      }
    };
    on.addEventListener('change', () => {
      for (const l of block.layers) {
        const cb = rowOf(l);
        l.enabled = on.checked && (!cb || cb === on || cb.checked);
        zonePending.add(l);
      }
      sync();
    });
    sync();
    for (const l of block.layers) loadZone(l);
  }

  // ---- 眺望空間保全区域（ゾーンレイヤーとは別系統だが、同じ見た目で最後に並べる）----
  //   ・区域そのもの（地形に貼るポリゴン）と、その上限である標高面の2つを切り替える。
  //   ・こちらは ZONE_LAYERS ではなく viewAreaState / viewLimitState を直に持つので、
  //     同じ「マスター＋行」の形を手で組み立てる。
  const vLab = document.createElement('label');
  const vOn = document.createElement('input');
  vOn.type = 'checkbox';
  vOn.id = 'viewSpaceOn';
  vLab.append(vOn, document.createTextNode('眺望空間保全区域'));
  host.appendChild(vLab);

  const vLegend = document.createElement('div');
  vLegend.className = 'legend';
  vLegend.id = 'viewSpaceLegend';
  const vRow = (id, label, color, onChange) => {
    const row = document.createElement('div');
    const lab2 = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = true;
    cb.addEventListener('change', () => onChange(cb.checked));
    const sw = document.createElement('i');
    sw.style.background = color;
    lab2.append(cb, sw, document.createTextNode(label));
    row.appendChild(lab2);
    vLegend.appendChild(row);
    return cb;
  };
  const vAreaCb = vRow('viewAreaOn', '眺望空間保全区域',
    '#' + VIEW_AREA_FILL_COLOR.toString(16).padStart(6, '0'),
    (v) => { viewAreaState.enabled = vOn.checked && v; markViewAreaDirty(); });
  const vLimitCb = vRow('viewLimitOn', '標高面',
    '#' + VIEW_LIMIT_COLOR.toString(16).padStart(6, '0'),
    (v) => { viewLimitState.enabled = vOn.checked && v; markViewLimitDirty(); });
  host.appendChild(vLegend);
  for (const id of ['viewAreaInfo', 'viewLimitInfo']) {
    const info = document.createElement('div');
    info.className = 'stats-line';
    info.id = id;
    host.appendChild(info);
  }
  const vSync = () => {
    vLegend.classList.toggle('on', vOn.checked);
    vAreaCb.disabled = !vOn.checked;
    vLimitCb.disabled = !vOn.checked;
  };
  vOn.addEventListener('change', () => {
    viewAreaState.enabled = vOn.checked && vAreaCb.checked;
    viewLimitState.enabled = vOn.checked && vLimitCb.checked;
    markViewAreaDirty();
    markViewLimitDirty();
    vSync();
  });
  vSync();
})();

// 「景観・眺望規制」の折りたたみ
(function setupZoneDisclosure() {
  const head = el('zoneSectionHead'), body = el('zoneLayers');
  if (!head || !body) return;
  head.addEventListener('click', () => {
    const open = !head.classList.contains('open');
    head.classList.toggle('open', open);
    body.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  });
})();


export {
  viewLimitGroup, viewLimitState, buildViewLimits,
  viewAreaGroup, viewAreaState, viewAreaLineMat,
  buildViewAreas, buildTerrainHeightGrid, sampleGrid, sampleExcess, lonLatToLocal, loadViewAreas,
  zoneLayers, zoneLineMats, zonesStep, buildZone, setZoneKind,
};
export const getViewAreaStats = () => viewAreaStats;
export const getViewLimitStats = () => viewLimitStats;
export const getZoneStats = () => Object.fromEntries(
  zoneLayers.map((l) => [l.def.label, l.stats]));

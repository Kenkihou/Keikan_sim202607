// =============================================================================
// profile — 東西の地形断面（縦断図）。
//   箱庭の断面（section.js／一辺 最大500m）とは別に、市域スケール（既定20km）で
//   地形を東西に切った縦断図を画面下のパネルに描く。
//
//   ★ 高さは【国土地理院の標高タイル(DEM)】から取る。読み込み済みの PLATEAU 地形は
//     使わない（理由は config.js の PROFILE_* の解説を参照。要は 20km 先の LOD が
//     カメラ次第で変わるので断面の形が安定しないため）。
//   ★ 断面線は「緯度」だけを持つ東西の直線。右下の地図の上を上下にドラッグして動かす
//     （＝どこを切っているかを示すキープランを兼ねる。配線は ui.js 側）。
//
//   依存の向き: config / core にだけ依存する（ui.js がこちらを import する）。
// =============================================================================
import { THREE, el, focusLocal } from './core.js';
import { roadNames, loadRoadNames, riverNames, loadRiverNames } from './roadnames.js';
import { localToLonLat, NORMAL_R } from './geo.js';
import {
  DEG2RAD, ORIGIN_LAT, ORIGIN_LON, ORIGIN_HEIGHT, ORIGIN_ELEVATION, SEA_LEVEL_Y,
  PROFILE_LENGTH, PROFILE_DEM_ZOOM, PROFILE_DEM_URL, PROFILE_SAMPLES,
  PROFILE_EXAGGERATIONS, PROFILE_DEFAULT_EXAGGERATION,
  PROFILE_SOIL_COLOR, PROFILE_LINE_COLOR, PROFILE_SEA_COLOR,
  MOUNTAIN_URL, CITY_WARD_BOUNDARY_URL, CITY_TEMPLES_URL,
  PROFILE_MOUNTAIN_BAND_M, PROFILE_MOUNTAIN_COLOR,
  PROFILE_ROAD_MERGE_M, PROFILE_LABEL_MIN_GAP_PX, PROFILE_ROAD_COLOR,
  PROFILE_MOUNTAIN_SOIL_COLOR, PROFILE_MOUNTAIN_RISE_M, PROFILE_MOUNTAIN_WINDOW_M,
  PROFILE_MOUNTAIN_MIN_RUN_M, PROFILE_ROAD_SURFACE_COLOR, PROFILE_ROAD_EDGE_COLOR,
  PROFILE_ROAD_DEPTH_M, PROFILE_ROAD_MIN_PX, ROAD_WIDTH_M, ROAD_WIDTH_DEFAULT_M,
  PROFILE_RIVER_COLOR, PROFILE_RIVER_BED_COLOR, PROFILE_RIVER_LABEL_COLOR,
  PROFILE_RIVER_DEPTH_RATIO, PROFILE_RIVER_DEPTH_MIN_M, PROFILE_RIVER_DEPTH_MAX_M,
  PROFILE_RIVER_BED_RATIO, PROFILE_RIVER_MIN_PX, PROFILE_RIVER_MERGE_M,
  PROFILE_WARD_PALETTE, PROFILE_WARD_BAND_OPACITY,
  PROFILE_WARD_OUTSIDE_LABEL, PROFILE_WARD_OUTSIDE_COLOR,
  PROFILE_TEMPLE_BAND_M, PROFILE_TEMPLE_COLOR,
  PROFILE_INITIAL_LAT_DEG,
} from './config.js';
// 建物断面は、3D表示のために【すでに読み込み済み】のタイルのメッシュをそのまま切る。
//   ★ b3dm を自前で取り直す必要はない。箱庭の断面（buildSectionFill）と同じ登録簿
//     （clipMeshes）を共有すれば、断面線を動かした瞬間に切り直せる（通信ゼロ）。
import { triPlaneSegment, linkLoops, CAP_COLOR, clipMeshes, computeClipMeshWorld, keepFinestLod } from './section.js';

const RAD2DEG = 180 / Math.PI;
const ORIGIN_LAT_DEG = ORIGIN_LAT * RAD2DEG;
const ORIGIN_LON_DEG = ORIGIN_LON * RAD2DEG;

// 断面の状態。
//   latDeg   … 断面線の緯度[度]（東西の直線なのでこれだけで位置が決まる）
//   lonCDeg  … 断面の中心経度[度]。原点（主要駅）に固定する。
//   exag     … 鉛直強調の倍率（断面図右のつまみで操作）
//   showRoads / showMountains / showTemples / showWards … 断面に重ねるラベル。
//     常時 true 固定（切り替え UI は廃止した。値そのものは他コードが参照するので残す）。
const profileState = {
  enabled: false,
  latDeg: PROFILE_INITIAL_LAT_DEG,
  lonCDeg: ORIGIN_LON_DEG,
  exag: PROFILE_DEFAULT_EXAGGERATION,
  samples: null,       // Float32Array（標高[m]。欠測は NaN）
  loading: false,
  error: null,
  reqId: 0,            // 取得の世代番号（ドラッグ中に古い応答が後着しても捨てるため）
  showRoads: true,
  showRivers: true,
  showMountains: true,
  showTemples: true,
  showWards: true,
  showBuildings: false, // 断面線上の建物断面（断面ヘッダの「建物」ボタンで切り替え）
  wardBand: null,      // 直近に計算した区の帯（[{name,x0Frac,x1Frac,color}]）。latDeg が変わるたび作り直す
  zoomRange: null,     // 範囲ドラッグで拡大中の区間 {i0,i1}（サンプル添字。null=全体表示）
};

// =========================================================================
// 通り名・山名（断面線との交点にラベルを出す）
//   ★ どちらも【ライブでは取得しない】。通り名は OpenStreetMap の Overpass API から、
//     山名は mountain.geojson（既存・3Dの山名ラベルと共用）から、開発時に一度だけ
//     読み込んでコミット済みのファイルを使う。理由は CITY_ROADS_URL の解説を参照
//     （Overpass はレート制限があり、断面線を動かすたびに叩く用途には向かない）。
// =========================================================================
//   ★ 通り名の実データは roadnames.js が持つ（ストリートビューの路面ラベル＝
//     streetnames.js と同じ 600KB のファイルを見るので、読み込み口をそちらへ寄せた）。
const roadsData = roadNames;                                  // [{name, pts:[[lon,lat],...]}]
const peaksData = { loaded: false, error: null, peaks: [] };  // [{name, ele, lon, lat}]

function loadRoads() {
  loadRoadNames().then(() => { if (profileState.enabled) drawPanel(); });
}

async function loadPeaks() {
  if (!MOUNTAIN_URL) return;
  try {
    const res = await fetch(MOUNTAIN_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const out = [];
    for (const f of json.features || []) {
      const p = f.properties || {}, g = f.geometry || {};
      if (!p.name || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lon, lat] = g.coordinates;
      const ele = p.ele !== undefined ? parseFloat(p.ele) : NaN;
      out.push({ name: p.name, ele, lon, lat });
    }
    peaksData.peaks = out;
    peaksData.loaded = true;
    if (profileState.enabled) drawPanel();
  } catch (e) {
    peaksData.error = String(e.message || e);
    console.warn('山名データの読み込みに失敗:', e);
  }
}
// 河川（断面に水色の帯と川底を描く）。実データは roadnames.js が持つ
//   （ストリートビューの3Dラベルと同じファイルなので、読み込み口を共有する）。
const riversData = riverNames;

function loadRivers() {
  loadRiverNames().then(() => { if (profileState.enabled) drawPanel(); });
}

const wardsData = { loaded: false, error: null, wards: [] };   // [{name, rings:[[[lon,lat],...]]}]
const templesData = { loaded: false, error: null, temples: [] }; // [{name, religion, lon, lat}]

async function loadWards() {
  if (!CITY_WARD_BOUNDARY_URL) return;
  try {
    const res = await fetch(CITY_WARD_BOUNDARY_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    wardsData.wards = (json.features || []).map((f) => ({ name: f.name, rings: f.rings }));
    wardsData.loaded = true;
    if (profileState.enabled) { updateWardBand(); drawPanel(); }
  } catch (e) {
    wardsData.error = String(e.message || e);
    console.warn('行政区データの読み込みに失敗:', e);
  }
}

async function loadTemples() {
  if (!CITY_TEMPLES_URL) return;
  try {
    const res = await fetch(CITY_TEMPLES_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    templesData.temples = json.features || [];
    templesData.loaded = true;
    if (profileState.enabled) drawPanel();
  } catch (e) {
    templesData.error = String(e.message || e);
    console.warn('寺社データの読み込みに失敗:', e);
  }
}
loadRoads();
loadRivers();
loadPeaks();
loadWards();
loadTemples();

// 経度→水平画面px の一次変換をよく使うので、呼び出し側で作った関数を渡してもらう形にする。
// ラベルどうしが近すぎるとき、後着（＝x が大きい方）を間引く。
//   ★ 名前ではなく画面上の位置で間引くので、密集地区（京都の通り、山地の峰々）で
//     ラベルが重なって読めなくなるのを防ぐ。市街地中心はどうしても間引かれるが、
//     断面線を動かして見たい場所へ寄せれば、その付近は間引かれずに出る。
function thinByGap(items, toX, minGapPx) {
  const sorted = items.slice().sort((a, b) => toX(a) - toX(b));
  const out = [];
  let lastX = -Infinity;
  for (const it of sorted) {
    const x = toX(it);
    if (x - lastX >= minGapPx) { out.push(it); lastX = x; }
  }
  return out;
}

// =========================================================================
// 「山」の区間を、断面そのものから見分ける
//
//   ★ 絶対標高で切らない。盆地の外の高い平坦地（亀岡側の 100m 台など）まで
//     山に見えてしまう。【まわり ±PROFILE_MOUNTAIN_WINDOW_M の最低点より
//     PROFILE_MOUNTAIN_RISE_M 以上高く盛り上がっているか】で決める。
//   ★ 短い凹凸は均す（橋・堤防・小さな段差で塗りが細切れになるのを防ぐ）。
//   戻り値は sample と同じ長さの Uint8Array（1＝山）。
// =========================================================================
let mountainMaskFor = null;   // どの samples に対して作ったマスクか
let mountainMask = null;

function computeMountainMask(samples) {
  const n = samples.length;
  const mask = new Uint8Array(n);
  const spacing = PROFILE_LENGTH / (n - 1);                    // 1サンプルの間隔[m]
  const win = Math.max(1, Math.round(PROFILE_MOUNTAIN_WINDOW_M / spacing));
  const minRun = Math.max(1, Math.round(PROFILE_MOUNTAIN_MIN_RUN_M / spacing));
  // まわりの最低点。単純な窓の最小値（n は数百なので素直に回して十分速い）。
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    let lo = Infinity;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      const u = samples[j];
      if (Number.isFinite(u) && u < lo) lo = u;
    }
    if (lo !== Infinity && v - lo >= PROFILE_MOUNTAIN_RISE_M) mask[i] = 1;
  }
  // 短い切れ目・短い塊を均す（0の島 → 1、1の島 → 0 の順で1回ずつ）
  const smooth = (target) => {
    let i = 0;
    while (i < n) {
      if (mask[i] !== target) { i++; continue; }
      let j = i;
      while (j < n && mask[j] === target) j++;
      if (j - i < minRun && i > 0 && j < n) for (let k = i; k < j; k++) mask[k] = 1 - target;
      i = j;
    }
  };
  smooth(0);
  smooth(1);
  return mask;
}

function getMountainMask(samples) {
  if (!samples) return null;
  if (mountainMaskFor !== samples) {
    mountainMask = computeMountainMask(samples);
    mountainMaskFor = samples;
  }
  return mountainMask;
}

// 断面線（緯度 latDeg）と各通りのポリラインの交点を求める。
//   同じ名前の通りが近接して複数回交わる（交差点・蛇行）場合は1本にまとめる。
function computeRoadCrossings(latDeg, lonW, lonE) {
  if (!roadsData.loaded) return [];
  const raw = [];
  for (const way of roadsData.ways) {
    const pts = way.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [lon0, lat0] = pts[i], [lon1, lat1] = pts[i + 1];
      if ((lat0 - latDeg) * (lat1 - latDeg) > 0 || lat0 === lat1) continue;
      const t = (latDeg - lat0) / (lat1 - lat0);
      const lon = lon0 + (lon1 - lon0) * t;
      if (lon < lonW || lon > lonE) continue;
      raw.push({ name: way.name, lon, highway: way.highway });
    }
  }
  // 同名かつ近接（PROFILE_ROAD_MERGE_M 以内）の交点を1つにまとめる
  raw.sort((a, b) => a.lon - b.lon);
  const mergeDeg = PROFILE_ROAD_MERGE_M / (111320 * Math.cos(latDeg * DEG2RAD));
  const merged = [];
  for (const c of raw) {
    const last = merged[merged.length - 1];
    if (last && last.name === c.name && c.lon - last.lon <= mergeDeg) continue; // 直前と同名近接
    merged.push(c);
  }
  return merged;
}

// 断面線と河川の交点。道路と同じ要領だが、幅（width）も持ち帰る。
function computeRiverCrossings(latDeg, lonW, lonE) {
  if (!riversData.loaded) return [];
  const raw = [];
  for (const r of riversData.rivers) {
    const pts = r.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [lon0, lat0] = pts[i], [lon1, lat1] = pts[i + 1];
      if ((lat0 - latDeg) * (lat1 - latDeg) > 0 || lat0 === lat1) continue;
      const t = (latDeg - lat0) / (lat1 - lat0);
      const lon = lon0 + (lon1 - lon0) * t;
      if (lon < lonW || lon > lonE) continue;
      raw.push({ name: r.name, lon, width: r.width, waterway: r.waterway });
    }
  }
  raw.sort((a, b) => a.lon - b.lon);
  const mergeDeg = PROFILE_RIVER_MERGE_M / (111320 * Math.cos(latDeg * DEG2RAD));
  const merged = [];
  for (const c of raw) {
    const last = merged[merged.length - 1];
    if (last && last.name === c.name && c.lon - last.lon <= mergeDeg) continue;
    merged.push(c);
  }
  return merged;
}

// 断面線から PROFILE_MOUNTAIN_BAND_M 以内にある山頂を、東西の範囲内で拾う。
function computeNearbyPeaks(latDeg, lonW, lonE) {
  if (!peaksData.loaded) return [];
  const bandDeg = PROFILE_MOUNTAIN_BAND_M / 110574;
  const out = [];
  for (const p of peaksData.peaks) {
    if (p.lon < lonW || p.lon > lonE) continue;
    if (Math.abs(p.lat - latDeg) > bandDeg) continue;
    out.push(p);
  }
  return out;
}

// 断面線から PROFILE_TEMPLE_BAND_M 以内にある主要な寺社を、東西の範囲内で拾う。
//   （山名と同じ考え方。computeNearbyPeaks と処理は同一だが対象データが別なので分けてある）
function computeNearbyTemples(latDeg, lonW, lonE) {
  if (!templesData.loaded) return [];
  const bandDeg = PROFILE_TEMPLE_BAND_M / 110574;
  const out = [];
  for (const t of templesData.temples) {
    if (t.lon < lonW || t.lon > lonE) continue;
    if (Math.abs(t.lat - latDeg) > bandDeg) continue;
    out.push(t);
  }
  return out;
}

// 点がポリゴン（複数リング＝飛び地に対応）の内側にあるか（一般的な射線交差法）。
function pointInRings(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const hit = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
  }
  return inside;
}

// 区の名前から固定の色を選ぶ（文字コードの合計を使うだけの簡易ハッシュ）。
//   ★ 断面線の緯度を変えても同じ区は同じ色になるようにするための工夫
//     （毎回「出現順」で色を割り当てると、線を動かすたびに色の対応が変わって紛らわしい）。
function colorForWard(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PROFILE_WARD_PALETTE[h % PROFILE_WARD_PALETTE.length];
}

// 断面線に沿って「どの区を通っているか」を求め、連続する同じ区をひとまとめの帯にする。
//   DEM のサンプル点(PROFILE_SAMPLES)と同じ刻みで判定するので、距離軸のピクセルと
//   そのまま対応する（表示側で改めて補間する必要がない）。
function updateWardBand() {
  if (!wardsData.loaded) { profileState.wardBand = null; return; }
  const latDeg = profileState.latDeg;
  const [lonW, lonE] = profileLonRange();
  const N = PROFILE_SAMPLES;
  const names = new Array(N);
  for (let i = 0; i < N; i++) {
    const lon = lonW + (lonE - lonW) * (i / (N - 1));
    let found = null;
    for (const w of wardsData.wards) {
      if (pointInRings(lon, latDeg, w.rings)) { found = w.name; break; }
    }
    names[i] = found;
  }
  const segs = [];
  let start = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || names[i] !== names[start]) {
      // ★ どの区にも入らない区間も帯にする（＝市域の外）。以前は空白にしていたが、
      //   「データが無いのか市外なのか」が読み取れず紛らわしいので明示する。
      //   断面は 30km あり、京都市の東西幅を超えて市外まで伸びるのが普通。
      const nm = names[start] || PROFILE_WARD_OUTSIDE_LABEL;
      segs.push({
        name: nm, i0: start, i1: i - 1,
        color: names[start] ? colorForWard(nm) : PROFILE_WARD_OUTSIDE_COLOR,
        outside: !names[start],
      });
      start = i;
    }
  }
  profileState.wardBand = segs;
}

// =========================================================================
// 建物断面 — 断面線の上に載っている建物を、塗りつぶしの断面として描く。
//   ★ データは【3D表示のためにすでに読み込み済み】のタイルのメッシュ（section.js の
//     clipMeshes）をそのまま使う。b3dm を自前で取り直さないので通信はゼロ。
//     断面線（緯度）を動かした瞬間に切り直せるのはこのため。
//   ★ 見えている範囲は 3D 側の読み込み状況に従う。まだ届いていない場所の建物は
//     出ない（タイルが届けば markSectionDirty 経由で自動的に描き足される）。
// =========================================================================
const buildingSectionState = { loops: null, meshCount: 0, buildingCount: 0 };

// --- WGS84楕円体でのECEF変換 -------------------------------------------------
//   ★ 建物タイルの座標は楕円体ベースの真の ECEF / CESIUM_RTC なので、正確な
//     楕円体で変換する（球体近似だと高さ方向に数十m規模のズレが出かねない）。
//     水平方向の局所ENU変換は geo.js に切り出してある。
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
function llhToECEF(latRad, lonRad, h) {
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * Math.cos(lonRad),
    (N + h) * cosLat * Math.sin(lonRad),
    (N * (1 - WGS84_E2) + h) * sinLat,
  ];
}
// ECEF差分ベクトルを、原点における East/North/Up 成分に回転する。
function ecefDeltaToENU(dx, dy, dz, latRad, lonRad) {
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);
  const E = -sinLon * dx + cosLon * dy;
  const N = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const U = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  return [E, N, U];
}
const ORIGIN_ECEF = llhToECEF(ORIGIN_LAT, ORIGIN_LON, ORIGIN_HEIGHT);
// ECEF座標 → アプリのローカル座標（+X=西 / +Y=上 / +Z=北）。3Dシーンと同じ向きに揃える。
function ecefToLocal(ex, ey, ez) {
  const [ox, oy, oz] = ORIGIN_ECEF;
  const [E, N, U] = ecefDeltaToENU(ex - ox, ey - oy, ez - oz, ORIGIN_LAT, ORIGIN_LON);
  return [-E, U, N];
}
// 断面線の緯度に対応する「ローカルZ（北成分）」。建物側と同じ楕円体変換で求めることで、
// 断面線側だけ球体近似を使ってズレる、という事態を避ける。
function sectionLocalZ(latDeg) {
  const [ex, ey, ez] = llhToECEF(latDeg * DEG2RAD, ORIGIN_LON, ORIGIN_HEIGHT);
  return ecefToLocal(ex, ey, ez)[2];
}

// --- 断面抽出（triPlaneSegment/linkLoops を再利用）--------------------------------
// 断面線まわりの帯だけを切り出す。切り口は Sutherland-Hodgman法で半平面ごとに2回
// クリップする（箱庭断面がWebGLの clippingPlanes で直方体に切っているのと同じ考え方を、
// 2Dの多角形で行う）。
//   ★ 幅は箱庭の既定（300m）ではなく 1km にしている。京都駅は東西に約470mあり、
//     300mだと帯がまるごと駅舎の内側に収まって、駅以外の建物が1棟も出ない。
//     ±500m まで広げると駅の東西に並ぶ建物が一緒に見える。
//   ★ 帯の中心は原点固定ではなく【注目地点（focusLocal.x）】。建物タイルは注目地点の
//     まわりだけ読み込む（tiles.js の LoadRegionPlugin）ので、帯だけ原点に据え置くと
//     注目地点を移した先でタイルはあるのに帯の外、という食い違いが起きる。
const PROFILE_BUILDING_HALF_WIDTH = 500;
// 帯の東西の範囲[m]（ローカルX。+X=西）。注目地点に追従する。
function buildingBandRange() {
  const c = focusLocal.x;
  return [c - PROFILE_BUILDING_HALF_WIDTH, c + PROFILE_BUILDING_HALF_WIDTH];
}
function clipLoopHalfPlane(pts, bound, keepGreaterEqual) {
  const n = pts.length / 2;
  if (n < 3) return [];
  const inside = (u) => (keepGreaterEqual ? u >= bound : u <= bound);
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const cu = pts[i * 2], cv = pts[i * 2 + 1];
    const pu = pts[j * 2], pv = pts[j * 2 + 1];
    const cIn = inside(cu), pIn = inside(pu);
    if (cIn !== pIn) {
      const t = (bound - pu) / (cu - pu);
      out.push(bound, pv + (cv - pv) * t);
    }
    if (cIn) out.push(cu, cv);
  }
  return out;
}
function clipLoopToBand(pts, uMin, uMax) {
  let p = clipLoopHalfPlane(pts, uMin, true);
  if (p.length < 6) return null;
  p = clipLoopHalfPlane(p, uMax, false);
  return p.length >= 6 ? p : null;
}

// 1棟ぶんの交線（線分の集まり）から、塗りつぶす多角形を作る。
//   ★ linkLoops で輪郭を閉じる方式はやめた。PLATEAU の建物は【水密ではない】ので
//     （床面を持たない、壁と屋根が別メッシュ、面が欠けている等）、切り口が
//     閉じたループにならないことが珍しくない。開いた鎖を端点どうしで直結して
//     塗ると、建物の一部が欠けたり細い三角形のヒゲが出たりする（実際にそうなった）。
//   ★ 代わりに「各位置での交線の一番上」＝上側シルエットを取り、そこから建物の
//     足元（baseY）まで垂らして塗る。建物は地面から立ち上がる中実の塊なので、
//     多少面が欠けていても輪郭は正しく出る＝欠けが起きない。
//     中庭のように上まで抜けている空隙は、交線が無い列で多角形が分かれるので残る。
function silhouettePolys(segs, baseY, uMin, uMax) {
  const n = segs.length / 4;
  if (!n || !Number.isFinite(baseY)) return [];
  let lo = Infinity, hi = -Infinity;
  for (let s = 0; s < n; s++) {
    lo = Math.min(lo, segs[s * 4], segs[s * 4 + 2]);
    hi = Math.max(hi, segs[s * 4], segs[s * 4 + 2]);
  }
  lo = Math.max(lo, uMin); hi = Math.min(hi, uMax);
  if (!(hi > lo)) return [];
  // 刻みは 0.5m 程度あれば画面上は十分（1.5km を 1000px で見て 1px≒1.5m）。
  // 細かくしすぎても見た目は変わらず、棟数が多いときに重くなるだけ。
  const cols = Math.min(256, Math.max(8, Math.ceil((hi - lo) / 0.5)));
  const step = (hi - lo) / cols;
  const out = [];
  let us = null, tops = null;
  const flush = () => {
    if (us && us.length >= 2) {
      const poly = [];
      for (let i = 0; i < us.length; i++) poly.push(us[i], tops[i]);
      for (let i = us.length - 1; i >= 0; i--) poly.push(us[i], baseY);
      out.push(poly);
    }
    us = null; tops = null;
  };
  for (let c = 0; c <= cols; c++) {
    const u = c === cols ? hi : lo + step * c;
    let top = -Infinity;
    for (let s = 0; s < n; s++) {
      const a = segs[s * 4], av = segs[s * 4 + 1];
      const b = segs[s * 4 + 2], bv = segs[s * 4 + 3];
      const sLo = Math.min(a, b), sHi = Math.max(a, b);
      if (u < sLo - 1e-9 || u > sHi + 1e-9) continue;
      if (Math.abs(b - a) < 1e-9) {          // 鉛直な線分は両端とも候補
        if (av > top) top = av;
        if (bv > top) top = bv;
      } else {
        const v = av + (bv - av) * ((u - a) / (b - a));
        if (v > top) top = v;
      }
    }
    if (top === -Infinity || top <= baseY) { flush(); continue; }   // 交線が無い列で切る
    if (!us) { us = []; tops = []; }
    us.push(u); tops.push(top);
  }
  flush();
  return out;
}

const _pbWorld = new THREE.Matrix4();
const _pbBox = new THREE.Box3();
// 直前に建物断面を作ったときの注目地点X。動いたら表示範囲も追従させる判定に使う。
let lastBuildingFocusX = 0;

// 読み込み済みの建物メッシュを断面線の鉛直面で切って、塗りつぶし用のループを作り直す。
//   同期処理・通信ゼロ。断面線を動かすたびにそのまま呼べる。
function buildBuildingSection() {
  if (!profileState.showBuildings) { buildingSectionState.loops = null; return; }
  const [bandMin, bandMax] = buildingBandRange();
  const zSection = sectionLocalZ(profileState.latDeg);

  // ★ 対象は「表示中」ではなく【読み込み済み】のメッシュ（理由は section.js の
  //   buildSectionFill の解説と同じ。表示中だけだと視錐台の外や細分化待ちで消える）。
  const cands = [];
  const updatedRoots = new Set();
  for (const mesh of clipMeshes) {
    if (mesh.__clipIsTerrain) continue;               // 地形は地盤ライン側の担当
    const g = mesh.geometry;
    if (!g || !g.attributes.position) continue;
    if (!computeClipMeshWorld(mesh, _pbWorld, updatedRoots)) continue;
    const world = _pbWorld.clone();
    if (!g.boundingBox) g.computeBoundingBox();
    _pbBox.copy(g.boundingBox).applyMatrix4(world);
    // 断面線をまたがない／帯の外のメッシュは、頂点を触る前に落とす
    if (_pbBox.max.z < zSection || _pbBox.min.z > zSection) continue;
    if (_pbBox.max.x < bandMin || _pbBox.min.x > bandMax) continue;
    cands.push({ mesh, world, tile: mesh.__clipTile });
  }

  const loops = [];
  let nBuilding = 0;
  // 粗い祖先と細かい子が両方読み込み済みのことがあるので、細かい方だけ使う
  //   （両方使うと同じ建物の断面が二重に描かれる）。
  const used = keepFinestLod(cands);

  // ★ 建物のまとめ方は【ルート×建物ID】。メッシュ単位にしてはいけない。
  //   1枚のタイルの中で、建物の面はマテリアルごとに複数のメッシュ（プリミティブ）へ
  //   分かれている（壁と屋根、テクスチャ違いなど）。メッシュごとに切って linkLoops
  //   すると、1棟の断面が「壁だけの開いた鎖」「屋根だけの線」に割れてしまい、
  //   それぞれを閉じた結果、建物の中身ではなく外側が塗られる。京都タワーでは
  //   胴体と頂部が別メッシュだったため、断面が底面の線と頂部の弧に分断されていた。
  //   ＝同じルート（modelScene）の全メッシュから同じ建物IDの三角形を集めてから、
  //   まとめて切る（_batchid はルート内で振られる番号なので、キーはルートと組にする）。
  //   ★ ルートには __clipRoot（登録時の modelScene）を使う。PLATEAU タイルなら
  //     b3dm ごとに別オブジェクトで __clipTile と同じ粒度になり、自作モデル
  //     （usermodel.js）なら userModelGroup 1個で全メッシュがまとまる＝
  //     複数メッシュに分かれた自作モデルも「1棟」として断面が作れる。
  const meshData = [];             // {wx,wy,wz,idx,isUser}
  const byBuilding = new Map();    // root -> Map<bid, {faces:[[meshIdx,f]], min, max, isUser}>
  for (const { mesh, world } of used) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const bid = g.attributes._batchid;   // 建物ごとのID（b3dm の _BATCHID）
    const idx = g.index ? g.index.array : null;
    const n = pos.count;
    const e = world.elements;
    // 頂点をワールド（＝アプリのローカル座標。+X=西 / +Y=上 / +Z=北）へ一度だけ変換
    const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      wx[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      wy[i] = e[1] * x + e[5] * y + e[9] * z + e[13];
      wz[i] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const mi = meshData.length;
    const isUser = !!mesh.__clipIsUserModel;
    meshData.push({ wx, wy, wz, idx });
    const rootKey = mesh.__clipRoot || mesh;   // ルートが無ければメッシュ単位に退避
    let perBid = byBuilding.get(rootKey);
    if (!perBid) { perBid = new Map(); byBuilding.set(rootKey, perBid); }
    const triCount = (idx ? idx.length : n) / 3;
    for (let f = 0; f < triCount; f++) {
      const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
      // 断面線をまたがない三角形は捨てる（大半がここで落ちるので効く）
      const zmin = Math.min(wz[i0], wz[i1], wz[i2]), zmax = Math.max(wz[i0], wz[i1], wz[i2]);
      if (zmax < zSection || zmin > zSection) continue;
      const b = bid ? bid.getX(i0) : 0;   // 三角形の3頂点は同じ建物に属する
      let rec = perBid.get(b);
      if (!rec) { rec = { faces: [], min: Infinity, max: -Infinity, isUser }; perBid.set(b, rec); }
      rec.min = Math.min(rec.min, wy[i0], wy[i1], wy[i2]);
      rec.max = Math.max(rec.max, wy[i0], wy[i1], wy[i2]);
      rec.faces.push(mi, f);
    }
  }

  for (const perBid of byBuilding.values()) {
    for (const rec of perBid.values()) {
      const segs = [];
      for (let k = 0; k < rec.faces.length; k += 2) {
        const { wx, wy, wz, idx } = meshData[rec.faces[k]];
        const f = rec.faces[k + 1];
        const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
        triPlaneSegment(
          wx[i0], wy[i0], wz[i0], wx[i1], wy[i1], wz[i1], wx[i2], wy[i2], wz[i2],
          2, zSection, 0, rec.min, rec.max, segs,
        );
      }
      if (!segs.length) continue;
      nBuilding++;
      for (const pts of silhouettePolys(segs, rec.min, bandMin, bandMax)) {
        loops.push({ pts, isUser: rec.isUser });
      }
    }
  }
  buildingSectionState.loops = loops;
  buildingSectionState.meshCount = used.length;
  buildingSectionState.buildingCount = nBuilding;
}

// 断面線が動いた／建物タイルが増減したときに呼ぶ。作り直して即描画する。
function rebuildBuildingSection() {
  if (!profileState.enabled) return;
  // 注目地点が動いたら、表示範囲も一緒に移す。
  //   ★ 帯（＝建物を切り出す範囲）だけ注目地点に付いていくと、拡大中の狭い窓は
  //     元の場所に残るので、建物はできているのに画面の外、という状態になる。
  //     倍率（窓の幅）は変えずに中心だけ合わせる＝ユーザーの拡大具合は保つ。
  if (profileState.showBuildings && profileState.zoomRange &&
      Math.abs(focusLocal.x - lastBuildingFocusX) > 1) {
    const mPerSample = PROFILE_LENGTH / (PROFILE_SAMPLES - 1);
    const { i0, i1 } = profileState.zoomRange;
    const half = (i1 - i0) / 2;
    const center = (PROFILE_SAMPLES - 1) / 2 - focusLocal.x / mPerSample; // +X=西 ＝ 添字は減る向き
    setViewRange(center - half, center + half);
  }
  lastBuildingFocusX = focusLocal.x;
  buildBuildingSection();
  updateBuildingSectionStatus();
  drawPanel();
}

function updateBuildingSectionStatus() {
  const s = el('profileBuildingStatus');
  if (!s) return;
  if (!profileState.showBuildings) { s.textContent = ''; return; }
  const st = buildingSectionState;
  s.textContent = st.loops && st.loops.length
    ? `建物断面: ${st.buildingCount}棟（読込済メッシュ ${st.meshCount} 枚から生成）`
    : '建物断面: この断面線上に読み込み済みの建物がありません';
}

// ローカルX(西+)/ローカルY(上+) の断面ループを、今の画面マッピングで塗りつぶし描画する。
//   ★ 楕円体ベースで求めた u(=ローカルX) を、他の要素（山名・通り名・DEM）と同じ
//     球体近似の経度変換で画面に置く。1タイル(500m四方)程度の範囲では差は無視できるサイズ。
// PLATEAU建物：箱庭の断面（section.js）と同じ「灰色＋黒の斜線ハッチ」。
// 自作モデル：一目で「自分が置いた建物」と分かるよう、暖色の塗り＋濃い輪郭にする
//   （ハッチは掛けない。既存建物と紛れないことが目的なので、質感を揃える必要はない）。
const USER_MODEL_FILL = '#e0a94a';
const USER_MODEL_STROKE = 'rgba(107,66,10,0.95)';

// pts の配列（各要素は [u0,v0,u1,v1,...] のループ）を、塗り色・ハッチの有無を指定して描く。
function fillLoops(g, ptsList, xOf, toY, fillColor, { hatch } = {}) {
  const path = new Path2D();
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const pts of ptsList) {
    if (pts.length < 6) continue;
    for (let i = 0; i < pts.length; i += 2) {
      const x = xOf(pts[i]), y = toY(pts[i + 1] + ORIGIN_ELEVATION);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    path.closePath();
  }
  if (!Number.isFinite(bx0)) return;
  g.fillStyle = fillColor;
  g.fill(path);
  if (hatch) {
    // ハッチ（45°の斜線）。切り口の中だけに引く。
    //   ★ 走らせる範囲はグラフ枠に丸める。鉛直強調を上げると建物の上端が枠のはるか上に
    //     行くので、素の境界箱で回すと画面外のぶんまで延々と線を引くことになる。
    g.save();
    g.clip(path);
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    const HATCH_GAP = 6;
    const hy0 = Math.max(by0, lastGeom.padT);
    const hy1 = Math.min(by1, lastGeom.yBottom);
    const hx0 = Math.max(bx0, lastGeom.x0);
    const hx1 = Math.min(bx1, lastGeom.x0 + lastGeom.plotW);
    const span = Math.max(0, hy1 - hy0);
    for (let d = hx0 - span - HATCH_GAP; d <= hx1 + HATCH_GAP; d += HATCH_GAP) {
      g.moveTo(d, hy1);
      g.lineTo(d + span, hy0);   // 右上がり45°
    }
    g.stroke();
    g.restore();
  }
  // 輪郭は塗りと同系の濃い色で細く（図面の線の太さに近い印象にする）
  g.strokeStyle = hatch ? 'rgba(40,44,52,0.9)' : USER_MODEL_STROKE;
  g.lineWidth = 1;
  g.stroke(path);
}

function drawBuildingSection(g, toX, toY) {
  const loops = buildingSectionState.loops;
  if (!loops || !loops.length || !lastGeom) return;
  const lonAtX = (localX) => localToLonLat(localX, 0).lon;   // 断面線の緯度での東西位置
  const { viewI0, viewI1 } = lastGeom;
  const [fullLonW, fullLonE] = profileLonRange();
  const idxFromLon = (lon) => (lon - fullLonW) / (fullLonE - fullLonW) * (PROFILE_SAMPLES - 1);
  const xOf = (localX) => {
    const idx = idxFromLon(lonAtX(localX));
    return lastGeom.x0 + ((idx - viewI0) / Math.max(1, viewI1 - viewI0)) * lastGeom.plotW;
  };
  g.save();
  // ハッチは同色のループをまとめて1つのクリップ領域にしてから引く
  //   （ループごとに引くと重なった部分で線が二重になって濃く見える）。
  const plateauLoops = loops.filter((l) => !l.isUser).map((l) => l.pts);
  const userLoops = loops.filter((l) => l.isUser).map((l) => l.pts);
  const cap = '#' + CAP_COLOR.toString(16).padStart(6, '0');
  if (plateauLoops.length) fillLoops(g, plateauLoops, xOf, toY, cap, { hatch: true });
  if (userLoops.length) fillLoops(g, userLoops, xOf, toY, USER_MODEL_FILL, { hatch: false });
  g.restore();
}

// =========================================================================
// 標高タイル（国土地理院 DEM）
//   PNG の RGB に標高が埋まっている。仕様:
//     x = 2^16·R + 2^8·G + B
//     x <  2^23 → 標高 =  x         × 0.01[m]
//     x == 2^23 → 無効値（データ無し）
//     x >  2^23 → 標高 = (x - 2^24) × 0.01[m]（負の標高）
//   ⚠️ 画素を読むので crossOrigin='anonymous' が必須（付けないと canvas が汚染されて
//     getImageData が例外になる）。GSI は Access-Control-Allow-Origin: * を返す。
// =========================================================================
const demCache = new Map();   // 'z/x/y' → Promise<Float32Array|null>

function loadDemTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = demCache.get(key);
  if (hit) return hit;
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(256 * 256);
        for (let i = 0; i < 256 * 256; i++) {
          const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
          let v = r * 65536 + g * 256 + b;
          if (v === 0x800000) { out[i] = NaN; continue; }
          if (v > 0x800000) v -= 0x1000000;
          out[i] = v * 0.01;
        }
        resolve(out);
      } catch (e) {
        console.warn('標高タイルの読み取りに失敗:', e);
        resolve(null);
      }
    };
    // 海域など、そもそもタイルが無い場所は 404 になる（異常ではないので静かに欠測扱い）
    img.onerror = () => resolve(null);
    img.src = PROFILE_DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  });
  demCache.set(key, p);
  return p;
}

// Web メルカトルのタイル座標（小数）。整数部がタイル番号、小数部がタイル内の位置。
const lonToTileX = (lonDeg, z) => (lonDeg + 180) / 360 * Math.pow(2, z);
const latToTileY = (latDeg, z) => {
  const la = latDeg * DEG2RAD;
  return (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * Math.pow(2, z);
};

// 断面線の東西の端（経度）。緯度によって1度あたりの距離が変わるので cos で補正する。
function profileLonRange() {
  const half = (PROFILE_LENGTH / 2) / (111320 * Math.cos(profileState.latDeg * DEG2RAD));
  return [profileState.lonCDeg - half, profileState.lonCDeg + half];
}

// 「今表示している範囲」＝ profileLonRange()（常に全長 PROFILE_LENGTH）そのもの、または
//   範囲ドラッグで選んだ部分区間（zoomRange）。どちらも「元の20kmの中の添字 i0..i1」で
//   表す。★ サンプル配列(profileState.samples)は常に全長ぶん取得済みなので、拡大表示は
//   新たな取得をせず【同じ配列の一部を大きく引き伸ばして描くだけ】で済む。
function viewIndexRange() {
  const zr = profileState.zoomRange;
  return zr ? { i0: zr.i0, i1: zr.i1 } : { i0: 0, i1: PROFILE_SAMPLES - 1 };
}
function viewLonRange() {
  const [fullW, fullE] = profileLonRange();
  const { i0, i1 } = viewIndexRange();
  const lonW = fullW + (fullE - fullW) * (i0 / (PROFILE_SAMPLES - 1));
  const lonE = fullW + (fullE - fullW) * (i1 / (PROFILE_SAMPLES - 1));
  const lengthM = (lonE - lonW) * Math.cos(profileState.latDeg * DEG2RAD) * NORMAL_R * DEG2RAD;
  return { lonW, lonE, i0, i1, lengthM };
}

// ホイールでの拡大縮小・ドラッグでのパン（横スクロール）。
//   ★ どちらも新たなデータ取得はしない。samples は常に全長ぶん取得済みなので、
//     表示範囲(zoomRange)の添字だけを動かして描き直すだけで済む。
const ZOOM_MIN_SAMPLES = 24;   // これ以上は寄れない下限（狭すぎて描画が破綻しないように）
function clampRange(i0, i1) {
  const span = i1 - i0;
  if (i0 < 0) { i1 -= i0; i0 = 0; }
  if (i1 > PROFILE_SAMPLES - 1) { i0 -= (i1 - (PROFILE_SAMPLES - 1)); i1 = PROFILE_SAMPLES - 1; }
  i0 = Math.max(0, i0);
  return { i0, i1: i0 + span > PROFILE_SAMPLES - 1 ? PROFILE_SAMPLES - 1 : i0 + span };
}
function setViewRange(i0, i1) {
  ({ i0, i1 } = clampRange(Math.min(i0, i1), Math.max(i0, i1)));
  // 全体（誤差1サンプル程度）まで戻ったら null にして「全体表示」の状態に揃える
  // （そうしないと、わずかに残った端数のせいで距離軸の基準がずれて見えることがある）。
  profileState.zoomRange = (i1 - i0 >= PROFILE_SAMPLES - 2) ? null : { i0: Math.round(i0), i1: Math.round(i1) };
  drawPanel();
  updateReadout();
}
// カーソル位置を中心に拡大・縮小する（マウスホイール）。
//   deltaY<0（上スクロール）で拡大、>0 で縮小。カーソル下の地点が画面上で動かないように、
//   その地点の「範囲内での割合」を保ったまま新しい範囲を作る。
function zoomAt(idxAtCursor, deltaY) {
  const { i0: curI0, i1: curI1 } = viewIndexRange();
  const curSpan = curI1 - curI0;
  const factor = deltaY < 0 ? 0.82 : 1 / 0.82;
  const span = Math.max(ZOOM_MIN_SAMPLES, Math.min(PROFILE_SAMPLES - 1, curSpan * factor));
  const frac = curSpan > 0 ? (idxAtCursor - curI0) / curSpan : 0.5;
  setViewRange(idxAtCursor - frac * span, idxAtCursor - frac * span + span);
}
function resetZoom() {
  if (!profileState.zoomRange) return;
  profileState.zoomRange = null;
  drawPanel();
  updateReadout();
}

// 断面に沿って標高を取る。
//   東西の直線なので緯度は一定＝【タイル行は1行だけ】。20km でも横に11枚読めば足りる。
async function buildProfile() {
  const z = PROFILE_DEM_ZOOM;
  const myReq = ++profileState.reqId;
  profileState.loading = true;
  profileState.error = null;
  drawPanel();

  const [lonW, lonE] = profileLonRange();
  const fy = latToTileY(profileState.latDeg, z);
  const ty = Math.floor(fy);
  const row = Math.min(255, Math.max(0, Math.floor((fy - ty) * 256)));
  const txW = Math.floor(lonToTileX(lonW, z));
  const txE = Math.floor(lonToTileX(lonE, z));

  const xs = [];
  for (let tx = txW; tx <= txE; tx++) xs.push(tx);
  let tiles;
  try {
    tiles = await Promise.all(xs.map((tx) => loadDemTile(z, tx, ty)));
  } catch (e) {
    if (myReq !== profileState.reqId) return;      // 新しい要求に追い越された
    profileState.loading = false;
    profileState.error = String(e && e.message ? e.message : e);
    drawPanel();
    return;
  }
  if (myReq !== profileState.reqId) return;        // ドラッグ中に追い越された＝この結果は捨てる

  const N = PROFILE_SAMPLES;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const lon = lonW + (lonE - lonW) * (i / (N - 1));
    const fx = lonToTileX(lon, z);
    const tx = Math.floor(fx);
    const col = Math.min(255, Math.max(0, Math.floor((fx - tx) * 256)));
    const t = tiles[tx - txW];
    out[i] = t ? t[row * 256 + col] : NaN;
  }
  profileState.samples = out;
  profileState.loading = false;
  drawPanel();
  updateReadout();   // 標高の幅は取得後でないと出せないので、ここで必ず更新する
}

// 断面線を動かす／作り直す入口。
//   ★ ドラッグ中は連続で呼ばれるので、タイルはキャッシュに任せて毎回作り直してよい
//     （同じタイル行の中で緯度を動かしている限り、2回目以降はネットワークに出ない）。
function setSectionLat(latDeg) {
  if (!Number.isFinite(latDeg)) return;
  if (Math.abs(latDeg - profileState.latDeg) < 1e-9) return;
  profileState.latDeg = latDeg;
  // 断面線を動かしたら拡大表示は解除する（別の場所の話になるため）。
  //   ただし建物断面を見ているときは維持する。建物が見える倍率（幅1km程度）は
  //   全長30kmの中ではごく一部で、動かすたびに解除されると毎回ズームし直しになるため。
  //   東西の断面なので、緯度が変わっても「見ている経度の窓」は同じ意味を保てる。
  if (!profileState.showBuildings) profileState.zoomRange = null;
  updateWardBand();   // 区の帯は DEM を待たずに作れる（読み込み済みなら即座に反映）
  // 建物断面も読み込み済みメッシュから作り直す（通信なしなのでドラッグ中でも即座に追従する）
  if (profileState.enabled && profileState.showBuildings) buildBuildingSection();
  if (profileState.enabled) buildProfile();
  updateReadout();
  updateBuildingSectionStatus();
}

// 倍率ボタンの選択状態を更新する関数（UI組み立て時に差し込まれる）。
let syncExagButtons = null;
function setExaggeration(x) {
  profileState.exag = x;
  drawPanel();
}

// =========================================================================
// パネルの描画（canvas）
//   横軸: 断面の中心からの距離[m]（西←→東）
//   縦軸: 標高[m]。1ピクセルあたりの縦の縮尺は「横の縮尺 × 鉛直強調」。
//         ＝倍率1なら実スケール、5なら5倍に引き伸ばす。
// =========================================================================
// 左は標高の目盛り文字（最大4桁 + 単位）が入る幅。文字を 12px にしたぶん広げてある。
// 上は単位の凡例（「標高[m] / 距離[km]」）1行ぶん。斜めラベルの領域より上に置く。
const PANEL_PAD_L = 54, PANEL_PAD_R = 12, PANEL_PAD_T = 18, PANEL_PAD_B = 24;
// グラフの高さ。
//   ★ 中身（地形と建物の一番上）に合わせて詰める。固定にすると、地形が 476m しかない
//     ところに 1000m 超の目盛りぶんの空白が残って画面を無駄に食う。
//   ★ ただし【画面の高さの約1/3】を超えないよう頭を押さえる。14型のノートPCだと
//     断面パネルが画面の半分近くを占めて3Dが見えなくなる、という問題があったため。
//   ★ 高さは 16px 刻みに丸める。ホイールで拡大縮小している間は横の縮尺→縦の縮尺→
//     必要な高さ、と連鎖して毎フレーム変わるので、そのままだとキャンバスの作り直しが
//     続いて重くなる。粗く量子化しておけば実際に作り直すのは数回で済む。
// 最小値は「これ以上縮めると流石に読めない」という下限。14型ノートPC（高さ768px前後）で
// ラベル・区の帯を出したまま 1/3 に収めようとすると、この下限に張り付くのが通常状態になる
// （固定の見出し・余白だけで軽く 150px 超あるため）。実測しつつ小さめに振ってある。
const PLOT_H_MIN = 64, PLOT_H_CAP = 260, PLOT_H_QUANTUM = 16;
// グラフ（canvas）の外でパネルが使う高さ：見出し行＋建物ステータス行＋外側の余白＋
// 縦に並べる flex の gap＋枠線。ここは padT/padB と違って表示状態に依らずほぼ一定。
const PANEL_OUTER_CHROME_H = 65;
// キャップは「グラフの高さ」ではなく【パネル全体の高さ】を画面の1/3に収める、という
// 要求なので、グラフの外側だけでなく、グラフの中の上下の余白（padT/padB。ラベルの
// 有無や区の帯の有無で変わる）も差し引いてから決める。
//   ★ ただし、この1/3キャップは【地形の見える範囲】より優先させない。鉛直強調を
//     上げるほど 1m あたりの必要pxが増えるので、14型ノートPC（高さ768px前後）だと
//     5倍のとき 300m 程度で地形が見切れてしまっていた（実測）。標高1000mまでは
//     見切れないことを保証し、それでもキャップより高さが要るときは、ラベル用の
//     余白（LABEL_HEADROOM）を犠牲にしてでも地形を優先してパネルを伸ばす。
//     ＝「山名などの文字は多少見切れてもよいので地形を優先」という要望どおり。
const PLOT_GUARANTEE_ELEV_M = 1000;
function plotHeightFor(needH, padT, padB, vScale) {
  const cap = Math.min(PLOT_H_CAP,
    Math.max(PLOT_H_MIN, Math.round(window.innerHeight / 3) - PANEL_OUTER_CHROME_H - padT - padB));
  // 実際のコンテンツ（needH）と「標高1000mぶん」の小さい方までは、キャップを無視してでも見せる。
  const guaranteed = Math.min(needH, PLOT_GUARANTEE_ELEV_M * vScale + 12);
  // 際限なく伸びないよう、最後に画面の9割という緩い上限だけは掛けておく。
  const hardCap = Math.max(PLOT_H_MIN, window.innerHeight * 0.9 - padT - padB);
  const q = (v) => Math.ceil(v / PLOT_H_QUANTUM) * PLOT_H_QUANTUM;
  const raw = Math.max(Math.min(cap, needH), guaranteed);
  return Math.max(PLOT_H_MIN, Math.min(q(hardCap), q(raw)));
}
// 通り名・山名・寺社のラベルは地表から斜め上に伸ばして描くので、そのぶんの余白を上に確保する。
//   どれか1つでも出しているときだけ足す（すべて OFF ならこれまでどおりの高さに戻る）。
//   文字を 10px から 12px に上げたぶん、斜めラベルの占める高さも増えるので広げてある。
const LABEL_HEADROOM = 50;
// 行政区の帯（距離軸のすぐ上）の太さと、地表とのすき間。
// キャンバス内の文字は、左上のUIパネル（#hud の本文 12px）と同じ大きさに揃える。
//   ★ 以前は 10px で、パネルの文字より明らかに小さく読みにくかった。
//     ここを変えたら、文字が載る帯の高さとラベルの間引き幅も一緒に見直すこと。
const FONT_PX = 12;
const FONT = `${FONT_PX}px system-ui, sans-serif`;
const FONT_BOLD = `bold ${FONT_PX}px system-ui, sans-serif`;
// ラベルは斜めに置くので、間引き幅は文字サイズにほぼ比例させる。
const LABEL_MIN_GAP_PX = PROFILE_LABEL_MIN_GAP_PX * (FONT_PX / 10);
const WARD_BAND_H = 18, WARD_BAND_GAP = 3;   // 12px の文字が収まる高さ

// 直近の描画ジオメトリ（範囲ドラッグ選択が「画面px→サンプル添字」を逆算するのに使う）。
let lastGeom = null;

function drawPanel() {
  const cv = el('profileCanvas');
  if (!cv || !profileState.enabled) return;
  const host = cv.parentElement;
  const cssW = Math.max(320, host.clientWidth);

  const s = profileState.samples;
  const { i0: viewI0, i1: viewI1, lengthM: viewLengthM } = viewLonRange();
  const finite = [];
  if (s) for (let i = viewI0; i <= viewI1; i++) if (Number.isFinite(s[i])) finite.push(s[i]);
  let maxEl = finite.length ? Math.max(...finite) : 100;
  // 建物断面を出しているときは、その頂部までは入るようにする
  if (buildingSectionState.loops) {
    for (const { pts } of buildingSectionState.loops) {
      for (let i = 1; i < pts.length; i += 2) {
        const elev = pts[i] + ORIGIN_ELEVATION;
        if (elev > maxEl) maxEl = elev;
      }
    }
  }
  const minEl = finite.length ? Math.min(...finite) : 0;

  const padT = PANEL_PAD_T +
    ((profileState.showRoads || profileState.showMountains || profileState.showTemples
      || profileState.showRivers) ? LABEL_HEADROOM : 0);
  const bandH = (profileState.showWards && profileState.wardBand) ? WARD_BAND_GAP + WARD_BAND_H : 0;
  const padB = PANEL_PAD_B + bandH;

  // 縦の縮尺。横の縮尺（px/m。今表示している範囲の実長で決まる）に鉛直強調を掛けたもの。
  //   ★ 範囲ドラッグで拡大表示中は viewLengthM が短くなる＝ hScale が自動的に上がる
  //     （＝距離1mあたりの画面pxが増える＝拡大される）。取得し直しは不要。
  const plotW = cssW - PANEL_PAD_L - PANEL_PAD_R;
  const hScale = plotW / Math.max(1, viewLengthM);    // px per m（水平）
  const vScale = hScale * profileState.exag;          // px per m（鉛直）
  // 底は「標高0m」または最低標高の少し下（負の標高がある都市に備える）。
  const base = Math.min(0, Math.floor(minEl / 50) * 50);
  // 中身がちょうど収まる高さ。上に少しだけ余白（ラベルが天井に貼り付かない程度）。
  const plotH = plotHeightFor((maxEl - base) * vScale + 12, padT, padB, vScale);
  const cssH = plotH + padT + padB;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const x0 = PANEL_PAD_L, yBottom = padT + plotH;
  // toX はサンプル添字(0..PROFILE_SAMPLES-1、常に全長20km基準)→画面px。
  //   表示範囲(viewI0..viewI1)だけを plotW いっぱいに引き伸ばす。
  const toX = (i) => x0 + ((i - viewI0) / Math.max(1, viewI1 - viewI0)) * plotW;
  const toY = (elev) => yBottom - (elev - base) * vScale;
  lastGeom = { x0, plotW, padT, yBottom, viewI0, viewI1 };

  // --- 背景 ---
  g.fillStyle = 'rgba(15,23,42,0.55)';
  g.fillRect(x0, padT, plotW, plotH);

  // --- 標高のグリッドと目盛り ---
  //   刻みは「表示できる高さ」に合わせて自動で選ぶ（強調倍率を変えても目盛りが潰れない）。
  const spanEl = (plotH / vScale);
  const steps = [10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((v) => spanEl / v <= 6) || 1000;
  g.font = FONT;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let e = base; e <= base + spanEl; e += step) {
    const y = toY(e);
    if (y < padT - 1 || y > yBottom + 1) continue;
    g.strokeStyle = e === 0 ? PROFILE_SEA_COLOR : 'rgba(148,163,184,0.22)';
    g.lineWidth = e === 0 ? 1.2 : 1;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + plotW, y); g.stroke();
    g.fillStyle = e === 0 ? PROFILE_SEA_COLOR : '#9fb0c7';
    g.fillText(String(e), x0 - 6, y);
  }

  if (!s) {
    g.fillStyle = '#c7d2e0';
    g.textAlign = 'center';
    g.fillText(profileState.error ? ('標高データの取得に失敗: ' + profileState.error)
      : '標高データを読み込み中…', x0 + plotW / 2, padT + plotH / 2);
    return;
  }

  // --- 地形と建物はグラフ枠の中だけに描く ---
  //   ★ グラフの高さを固定したので、鉛直強調を上げると内容が枠から溢れることがある。
  //     クリップしておかないと、上のラベル帯や下の距離軸の上に地形がはみ出す。
  g.save();
  g.beginPath();
  g.rect(x0, padT, plotW, plotH);
  g.clip();

  // --- 土の塗りつぶし（地表から下）---
  //   欠測(NaN)は前後を繋いで埋める。1本の帯として塗るため、まず地表の折れ線を作る。
  g.beginPath();
  let started = false, lastY = yBottom;
  for (let i = viewI0; i <= viewI1; i++) {
    const v = s[i];
    const y = Number.isFinite(v) ? toY(v) : lastY;
    if (Number.isFinite(v)) lastY = y;
    if (!started) { g.moveTo(toX(i), y); started = true; } else g.lineTo(toX(i), y);
  }
  g.lineTo(x0 + plotW, yBottom);
  g.lineTo(x0, yBottom);
  g.closePath();
  g.fillStyle = PROFILE_SOIL_COLOR;
  g.globalAlpha = 0.92;      // 塗りを濃くして山との対比を出す
  g.fill();
  g.globalAlpha = 1;

  // --- 山の区間だけ土の色を変える ---
  //   ★ 一律の茶色だと、市街地の平地も背後の山も同じに見えて地形が読めない。
  //     判定はまわりからの盛り上がり（computeMountainMask）。
  const mask = getMountainMask(s);
  if (mask) {
    g.fillStyle = PROFILE_MOUNTAIN_SOIL_COLOR;
    g.globalAlpha = 0.92;
    let i = viewI0;
    while (i <= viewI1) {
      if (!mask[i]) { i++; continue; }
      const a = i;
      while (i <= viewI1 && mask[i]) i++;
      const b = i - 1;                       // a..b が山の区間
      g.beginPath();
      let ly = yBottom;
      for (let k = a; k <= b; k++) {
        const v = s[k];
        const y = Number.isFinite(v) ? toY(v) : ly;
        if (Number.isFinite(v)) ly = y;
        if (k === a) g.moveTo(toX(k), y); else g.lineTo(toX(k), y);
      }
      g.lineTo(toX(b), yBottom);
      g.lineTo(toX(a), yBottom);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // --- 地盤ライン（青）---
  g.beginPath();
  started = false; lastY = yBottom;
  for (let i = viewI0; i <= viewI1; i++) {
    const v = s[i];
    const y = Number.isFinite(v) ? toY(v) : lastY;
    if (Number.isFinite(v)) lastY = y;
    if (!started) { g.moveTo(toX(i), y); started = true; } else g.lineTo(toX(i), y);
  }
  g.strokeStyle = PROFILE_LINE_COLOR;
  g.lineWidth = 1.6;
  g.stroke();

  // --- 道路の断面（地表に敷く舗装の帯）---
  //   ★ 幅は OSM の道路種別から決める（config.js の ROAD_WIDTH_M）。
  //   ⚠️ 全長30kmの表示では 1px が 25m 前後あり、幅6mの道は 0.2px で見えない。
  //     細くても【必ず 2px は描く】ことで、拡大していないときも位置が分かるようにする
  //     （拡大するほど実際の幅に近づく）。
  if (profileState.showRivers) drawRiverSections(g, s, toX, toY, viewI0, viewI1);
  if (profileState.showRoads) drawRoadSurfaces(g, s, toX, toY, viewI0, viewI1);

  // --- 建物断面（断面線上の読み込み済みタイルから生成）---
  drawBuildingSection(g, toX, toY);

  g.restore();   // ここまでがグラフ枠内のクリップ

  // --- 注目地点の位置（断面線に最も近い東西位置）を縦線で示す ---
  //   注目地点は断面線から南北に離れていることがあるので、あくまで「東西方向の位置」。
  const [fullLonW, fullLonE] = profileLonRange();
  const lonToIndex = (lon) => (lon - fullLonW) / (fullLonE - fullLonW) * (PROFILE_SAMPLES - 1);
  const focusLonDeg = localToLonLat(focusLocal.x, 0).lon;
  const focusIdx = lonToIndex(focusLonDeg);
  if (focusIdx >= viewI0 && focusIdx <= viewI1) {
    const fx = toX(focusIdx);
    g.strokeStyle = '#ff5d5d';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(fx, padT); g.lineTo(fx, yBottom); g.stroke();
    g.setLineDash([]);
  }

  // --- 通り名・山名・寺社（断面線との交点／近傍にラベル）---
  const view = viewLonRange();
  if (profileState.showRoads || profileState.showMountains || profileState.showTemples
      || profileState.showRivers) {
    drawLabels(g, padT, yBottom, view, fullLonW, fullLonE, s, toX, toY);
  }

  // --- 行政区の帯（地表のすぐ下。連続する同じ区をまとめて色分け＋区名）---
  const axisY = yBottom + bandH;   // 帯を出すぶん、距離軸はその下へ押し下げる
  if (bandH > 0) {
    const bandTop = yBottom + WARD_BAND_GAP;
    // 表示範囲(viewI0..viewI1)の外にはみ出す区間は切り詰める（拡大表示中の対応）。
    const visibleSegs = profileState.wardBand
      .map((seg) => ({ ...seg, i0: Math.max(seg.i0, viewI0), i1: Math.min(seg.i1, viewI1) }))
      .filter((seg) => seg.i0 <= seg.i1);
    for (const seg of visibleSegs) {
      const bx0 = toX(seg.i0), bx1 = toX(seg.i1);
      g.fillStyle = seg.color;
      g.globalAlpha = PROFILE_WARD_BAND_OPACITY;
      g.fillRect(bx0, bandTop, Math.max(1, bx1 - bx0), WARD_BAND_H);
      g.globalAlpha = 1;
    }
    // 区名は、帯として十分な幅がある区間にだけ載せる（狭い区間に無理に詰めない）
    g.font = FONT_BOLD;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const seg of visibleSegs) {
      const bx0 = toX(seg.i0), bx1 = toX(seg.i1), w = bx1 - bx0;
      const labelW = g.measureText(seg.name).width;
      if (w < labelW + 6) continue;
      g.strokeStyle = 'rgba(15,23,42,0.85)';
      g.lineWidth = 2.5;
      g.strokeText(seg.name, (bx0 + bx1) / 2, bandTop + WARD_BAND_H / 2);
      g.fillStyle = '#f4f7fb';
      g.fillText(seg.name, (bx0 + bx1) / 2, bandTop + WARD_BAND_H / 2);
    }
  }

  // --- 距離の目盛り（西←→東）---
  //   ★ 「元の20kmの中心からの距離」を基準にする（全体表示のときの目盛りと揃うように）。
  //     拡大表示中でも、元の断面のどのあたりを見ているかがそのまま読める。
  g.strokeStyle = 'rgba(148,163,184,0.35)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x0, axisY); g.lineTo(x0 + plotW, axisY); g.stroke();
  g.fillStyle = '#9fb0c7';
  g.textBaseline = 'top';
  g.font = FONT;
  const kmAtIndex = (i) => ((i / (PROFILE_SAMPLES - 1)) - 0.5) * (PROFILE_LENGTH / 1000);
  const indexAtKm = (km) => (km / (PROFILE_LENGTH / 1000) + 0.5) * (PROFILE_SAMPLES - 1);
  const kmLo = kmAtIndex(viewI0), kmHi = kmAtIndex(viewI1);
  const kmSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10];
  const kmStep = kmSteps.find((v) => (kmHi - kmLo) / v <= 8) || 10;
  const kmStart = Math.ceil(kmLo / kmStep) * kmStep;
  // 両端の「西」「東」に重なる距離ラベルは出さない（目盛り線だけ残す）。
  //   ★ 全体表示だと端の目盛り（-15 / 15）がちょうど「西」「東」の位置に来て
  //     文字が重なって読めなくなっていた。
  const EDGE_KEEPOUT = 22;
  for (let km = kmStart; km <= kmHi + 1e-9; km += kmStep) {
    const x = toX(indexAtKm(km));
    g.beginPath(); g.moveTo(x, axisY); g.lineTo(x, axisY + 3); g.stroke();
    if (x - x0 < EDGE_KEEPOUT || (x0 + plotW) - x < EDGE_KEEPOUT) continue;
    g.textAlign = 'center';
    const near0 = Math.abs(km) < kmStep / 2;
    g.fillText(near0 ? '0' : km.toFixed(kmStep < 1 ? 1 : 0), x, axisY + 5);
  }
  g.textAlign = 'left';
  g.fillText('西', x0, axisY + 5);
  g.textAlign = 'right';
  g.fillText('東', x0 + plotW, axisY + 5);
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillStyle = '#9fb0c7';
  // 斜めラベル（padT のうち LABEL_HEADROOM の帯）と重ならないよう、いちばん上の余白に置く。
  g.fillText('標高[m] / 距離[km]', x0 + plotW, 3);

  publishPanelHeight();
}

/* 河川の断面（水色の帯＋川底）を描く。
   ★ 川底は「幅なりに掘り込む」台形。深さの実データは無いので幅から見積もる
     （一律の深さより地形として自然に見える）。
   ⚠️ 道路より先に描くこと。橋のところで道路が水面の上に乗る順になる。 */
function drawRiverSections(g, s, toX, toY, viewI0, viewI1) {
  const [fullLonW, fullLonE] = profileLonRange();
  const lonToIndex = (lon) => (lon - fullLonW) / (fullLonE - fullLonW) * (PROFILE_SAMPLES - 1);
  const { lonW, lonE, lengthM } = viewLonRange();
  const crossings = computeRiverCrossings(profileState.latDeg, lonW, lonE);
  if (!crossings.length) return;
  const pxPerM = (toX(viewI1) - toX(viewI0)) / Math.max(1, lengthM);
  const pxPerVM = toY(0) - toY(1);        // 高さ1mが画面上で何px（鉛直強調込み）
  for (const c of crossings) {
    const idx = lonToIndex(c.lon);
    const i = Math.round(Math.max(0, Math.min(PROFILE_SAMPLES - 1, idx)));
    const v = s ? s[i] : NaN;
    if (!Number.isFinite(v)) continue;
    const wM = Math.max(1, c.width || 6);
    const wPx = Math.max(PROFILE_RIVER_MIN_PX, wM * pxPerM);
    const depthM = Math.min(PROFILE_RIVER_DEPTH_MAX_M,
      Math.max(PROFILE_RIVER_DEPTH_MIN_M, wM * PROFILE_RIVER_DEPTH_RATIO));
    const dPx = Math.max(2, depthM * pxPerVM);
    const x = toX(idx), y = toY(v);
    const halfTop = wPx / 2, halfBed = halfTop * PROFILE_RIVER_BED_RATIO;
    // 掘り込んだ河床（台形）を水色で塗る
    g.beginPath();
    g.moveTo(x - halfTop, y);
    g.lineTo(x - halfBed, y + dPx);
    g.lineTo(x + halfBed, y + dPx);
    g.lineTo(x + halfTop, y);
    g.closePath();
    g.fillStyle = PROFILE_RIVER_COLOR;
    g.globalAlpha = 0.92;
    g.fill();
    g.globalAlpha = 1;
    // 川底と岸の線（細い川でも輪郭で分かるように）
    g.strokeStyle = PROFILE_RIVER_BED_COLOR;
    g.lineWidth = 1;
    g.stroke();
  }
}

/* 道路の断面（舗装の帯）を地表に沿って描く。
   通り名ラベルと同じ交点（computeRoadCrossings）を使うので、位置は必ず一致する。 */
function drawRoadSurfaces(g, s, toX, toY, viewI0, viewI1) {
  const [fullLonW, fullLonE] = profileLonRange();
  const lonToIndex = (lon) => (lon - fullLonW) / (fullLonE - fullLonW) * (PROFILE_SAMPLES - 1);
  const { lonW, lonE, lengthM } = viewLonRange();
  const crossings = computeRoadCrossings(profileState.latDeg, lonW, lonE);
  if (!crossings.length) return;
  // 1m が画面上で何pxか（拡大するほど大きくなる）
  const pxPerM = (toX(viewI1) - toX(viewI0)) / Math.max(1, lengthM);
  const depthPx = Math.max(2, PROFILE_ROAD_DEPTH_M * (toY(0) - toY(1)));
  for (const c of crossings) {
    const idx = lonToIndex(c.lon);
    const i = Math.round(Math.max(0, Math.min(PROFILE_SAMPLES - 1, idx)));
    const v = s ? s[i] : NaN;
    if (!Number.isFinite(v)) continue;
    const wM = ROAD_WIDTH_M[c.highway] || ROAD_WIDTH_DEFAULT_M;
    const wPx = Math.max(PROFILE_ROAD_MIN_PX, wM * pxPerM);
    const x = toX(idx), y = toY(v);
    g.fillStyle = PROFILE_ROAD_SURFACE_COLOR;
    g.fillRect(x - wPx / 2, y, wPx, depthPx);
    // 路面の線（帯が細いときでも「道がある」ことが分かるように）
    g.strokeStyle = PROFILE_ROAD_EDGE_COLOR;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x - wPx / 2, y + 0.5);
    g.lineTo(x + wPx / 2, y + 0.5);
    g.stroke();
  }
}

// 通り名・山名のラベル。どちらも「地表から斜め上に伸ばした案内線＋回転文字」で示す
// （交点そのものにラベルを横書きすると、密集地区で真横に文字が重なって読めなくなるため）。
//   view … 今表示している範囲 {lonW,lonE}（範囲ドラッグで拡大中はその部分だけ）。
//   fullLonW/fullLonE … 断面全体（常に20km）の東西端。lon→サンプル添字の変換に使う
//     （toX は添字ベースなので、経度から一度添字に戻してから toX に渡す必要がある）。
function drawLabels(g, padT, yBottom, view, fullLonW, fullLonE, s, toX, toY) {
  const { lonW, lonE } = view;
  const lonToIndex = (lon) => (lon - fullLonW) / (fullLonE - fullLonW) * (PROFILE_SAMPLES - 1);
  const xFromLon = (lon) => toX(lonToIndex(lon));
  const groundY = (lon) => {
    if (!s) return yBottom;
    const idx = Math.round(Math.max(0, Math.min(PROFILE_SAMPLES - 1, lonToIndex(lon))));
    const v = s[idx];
    return Number.isFinite(v) ? toY(v) : yBottom;
  };
  const LABEL_ANGLE = -55 * Math.PI / 180;

  const drawTick = (lon, groundTopY, color, label) => {
    const x = xFromLon(lon);
    const topY = Math.max(padT + 2, groundTopY - 34);
    g.strokeStyle = 'rgba(148,163,184,0.55)';
    g.lineWidth = 1;
    g.setLineDash([2, 2]);
    g.beginPath(); g.moveTo(x, groundTopY); g.lineTo(x, topY); g.stroke();
    g.setLineDash([]);
    g.save();
    g.translate(x, topY);
    g.rotate(LABEL_ANGLE);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = FONT;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(15,23,42,0.9)';   // 縁取り（地形や他ラベルの上でも読めるように）
    g.strokeText(label, 2, 0);
    g.fillStyle = color;
    g.fillText(label, 2, 0);
    g.restore();
  };

  if (profileState.showMountains) {
    const peaks = thinByGap(computeNearbyPeaks(profileState.latDeg, lonW, lonE),
      (p) => xFromLon(p.lon), LABEL_MIN_GAP_PX);
    for (const p of peaks) {
      const x = xFromLon(p.lon), gy = groundY(p.lon);
      // 山頂を示す小さな三角マーカー（地表の上に乗せる）
      g.fillStyle = PROFILE_MOUNTAIN_COLOR;
      g.beginPath();
      g.moveTo(x, gy - 7); g.lineTo(x - 4, gy); g.lineTo(x + 4, gy);
      g.closePath(); g.fill();
      const label = p.name + (Number.isFinite(p.ele) ? `（${p.ele}m）` : '');
      drawTick(p.lon, gy - 7, PROFILE_MOUNTAIN_COLOR, label);
    }
  }
  if (profileState.showTemples) {
    const temples = thinByGap(computeNearbyTemples(profileState.latDeg, lonW, lonE),
      (t) => xFromLon(t.lon), LABEL_MIN_GAP_PX);
    for (const t of temples) {
      const x = xFromLon(t.lon), gy = groundY(t.lon);
      // 山のマーカー（三角）と区別できるよう、寺社はひし形にする
      g.fillStyle = PROFILE_TEMPLE_COLOR;
      g.beginPath();
      g.moveTo(x, gy - 8); g.lineTo(x - 4, gy - 4); g.lineTo(x, gy); g.lineTo(x + 4, gy - 4);
      g.closePath(); g.fill();
      drawTick(t.lon, gy - 8, PROFILE_TEMPLE_COLOR, t.name);
    }
  }
  if (profileState.showRoads) {
    const crossings = thinByGap(computeRoadCrossings(profileState.latDeg, lonW, lonE),
      (c) => xFromLon(c.lon), LABEL_MIN_GAP_PX);
    for (const c of crossings) drawTick(c.lon, groundY(c.lon), PROFILE_ROAD_COLOR, c.name);
  }
  if (profileState.showRivers) {
    const rivers = thinByGap(computeRiverCrossings(profileState.latDeg, lonW, lonE),
      (c) => xFromLon(c.lon), LABEL_MIN_GAP_PX);
    for (const c of rivers) {
      drawTick(c.lon, groundY(c.lon), PROFILE_RIVER_LABEL_COLOR, c.name);
    }
  }
}

// パネルの実際の高さを CSS 変数に流す。
//   右下の地図と左下の読み込み表示は、この高さぶんだけ持ち上げて重なりを避ける。
//   ★ 鉛直強調を変えるとパネルの高さも変わるので、描くたびに更新する必要がある。
function publishPanelHeight() {
  const panel = el('profilePanel');
  if (!panel) return;
  const h = profileState.enabled ? panel.offsetHeight : 0;
  document.body.style.setProperty('--profile-h', h + 'px');
}

// パネル上部の情報行（緯度・標高の幅・強調倍率・拡大表示中の範囲）
function updateReadout() {
  const r = el('profileReadout');
  if (!r) return;
  const s = profileState.samples;
  const { i0, i1, lengthM } = viewLonRange();
  let range = '';
  if (s) {
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const v = s[i];
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (Number.isFinite(mn)) range = ` ／ 標高 ${mn.toFixed(1)}〜${mx.toFixed(1)} m`;
  }
  const lengthLabel = profileState.zoomRange
    ? `約 ${(lengthM / 1000).toFixed(2)} km を拡大表示中（全体は ${PROFILE_LENGTH / 1000} km）`
    : `全長 ${PROFILE_LENGTH / 1000} km`;
  r.textContent = `北緯 ${profileState.latDeg.toFixed(5)}° の東西断面（${lengthLabel}）${range}`;

  const resetBtn = el('profileZoomReset');
  if (resetBtn) resetBtn.style.display = profileState.zoomRange ? '' : 'none';
}

// 断面パネルの開閉。地図側のキープライン（ui.js）も一緒に出し入れする。
let onEnabledChange = () => {};
const setEnabledChangeHandler = (fn) => { onEnabledChange = fn; };

function setEnabled(on) {
  profileState.enabled = on;
  const panel = el('profilePanel');
  if (panel) panel.style.display = on ? 'flex' : 'none';
  // パネルのぶん右下の地図を持ち上げる（重ならないように）
  document.body.classList.toggle('has-profile', on);
  if (on) {
    if (!profileState.wardBand) updateWardBand();
    if (!profileState.samples) buildProfile();
    else { drawPanel(); updateReadout(); }
  } else {
    profileState.zoomRange = null;   // 次に開いたときは全体表示から始める
    publishPanelHeight();   // 0 に戻して地図・読み込み表示を元の位置へ
  }
  onEnabledChange(on);
  // 親アプリ（01）の下部バーのボタンにも反映する。
  //   ★ ここで報告しないと、パネルの「×」で閉じたときに親のボタンだけ「表示中」の
  //     見た目のまま残る（次に開き直すまで気づけない）。setEarthClipSize が
  //     window.parent.syncEarthClipSize で送り返しているのと同じ作法。
  if (window.parent !== window && typeof window.parent.syncEarthProfileOn === 'function') {
    window.parent.syncEarthProfileOn(on);
  }
}

// =========================================================================
// 断面パネル自身の操作（開閉は左上パネルではなく親の下部バーからのみ行う。
// setEnabled / rebuildBuildingSection は main.js からの window ブリッジ経由で
// 呼ばれる。ここでは「開いているパネルの中」だけで完結する操作を組み立てる：
//   ・鉛直強調のつまみ（縦のスライダー、断面図の右）
//   ・建物断面のオン・オフ（断面ヘッダのボタン）
//   ・閉じるボタン
// 山名・通り名・寺社・行政区は常時表示（showMountains 等の初期値 true のまま、
// 切り替え UI 自体を廃止した）。
// =========================================================================
(function setupProfileUI() {
  const exagSlider = el('profileExagSlider');
  const exagLabel = el('profileExagLabel');
  const btBtn = el('profileBuildingToggle');
  const close = el('profileClose');
  if (!exagSlider || !close) return;

  // 鉛直強調は PROFILE_EXAGGERATIONS の【段】でしか選べない（連続値にすると
  // 「1.37倍」のような半端な状態になり、目盛りとの対応が読み取れなくなるため）。
  // スライダーの値はその配列の添字。writing-mode:vertical-lr と direction:rtl で
  // 縦向きにしてあるので、min(下)=配列の先頭(1倍)、max(上)=配列の末尾(最大倍率)。
  exagSlider.max = String(PROFILE_EXAGGERATIONS.length - 1);
  const syncExag = () => {
    const idx = Math.max(0, PROFILE_EXAGGERATIONS.indexOf(profileState.exag));
    exagSlider.value = String(idx);
    if (exagLabel) exagLabel.textContent = profileState.exag + '倍';
  };
  syncExagButtons = syncExag;
  exagSlider.addEventListener('input', () => {
    const x = PROFILE_EXAGGERATIONS[Number(exagSlider.value)];
    if (Number.isFinite(x)) { setExaggeration(x); syncExag(); }
  });
  syncExag();

  // 閉じるボタン。開くのは親（下部バー）からの setEnabled(true) 呼び出しのみ。
  close.addEventListener('click', () => setEnabled(false));

  // 建物断面。読み込み済みメッシュから作るので、断面線を動かせばそのつど追従する。
  const syncBuildingBtn = () => btBtn.classList.toggle('active', profileState.showBuildings);
  if (btBtn) {
    syncBuildingBtn();
    btBtn.addEventListener('click', () => {
      profileState.showBuildings = !profileState.showBuildings;
      syncBuildingBtn();
      if (profileState.showBuildings) {
        // 建物が見える倍率まで自動で寄せる。全長30kmのままでは幅1kmの帯が
        // 1px 未満になって何も見えないため。鉛直強調も等倍に戻す（この倍率では
        // 5倍だと建物が画面上端で切れる）。
        setExaggeration(1);
        syncExag();
        // 帯は注目地点に追従するので、寄せる先も原点ではなく注目地点にする。
        const mPerSample = PROFILE_LENGTH / (PROFILE_SAMPLES - 1);
        const center = (PROFILE_SAMPLES - 1) / 2 - focusLocal.x / mPerSample; // +X=西 ＝ 添字は減る向き
        const halfSamples = (PROFILE_BUILDING_HALF_WIDTH * 1.6) / mPerSample;
        setViewRange(center - halfSamples, center + halfSamples);
      }
      rebuildBuildingSection();
    });
  }

  window.addEventListener('resize', () => { if (profileState.enabled) drawPanel(); });
})();

// =========================================================================
// 断面図の拡大縮小（ホイール）とパン（ドラッグ）
//   ★ どちらも新たなデータ取得はしない（zoomAt/setViewRange の解説を参照）。
//   ・ホイール … カーソル位置を中心に拡大縮小（地図やチャートでよくある操作感）。
//   ・左ドラッグ … 今表示している範囲を左右に動かす（山名・通り名などが乗っている
//     地表の上でも同様にドラッグできるよう、pointerdown はキャンバス全体で受ける）。
(function setupZoomPanUI() {
  const cv = el('profileCanvas');
  if (!cv) return;
  const canvasX = (clientX) => clientX - cv.getBoundingClientRect().left;
  const idxFromX = (px) => {
    const { x0, plotW, viewI0, viewI1 } = lastGeom;
    return viewI0 + ((px - x0) / plotW) * (viewI1 - viewI0);
  };

  cv.addEventListener('wheel', (e) => {
    if (!profileState.samples || !lastGeom) return;
    e.preventDefault();   // ページ全体のスクロールを起こさない
    zoomAt(idxFromX(canvasX(e.clientX)), e.deltaY);
  }, { passive: false });

  let panning = false, panStartX = 0, panStartI0 = 0, panStartI1 = 0;
  cv.addEventListener('pointerdown', (e) => {
    if (!profileState.samples || !lastGeom) return;
    panning = true;
    panStartX = canvasX(e.clientX);
    ({ i0: panStartI0, i1: panStartI1 } = viewIndexRange());
    cv.style.cursor = 'grabbing';
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dxPx = canvasX(e.clientX) - panStartX;
    const span = panStartI1 - panStartI0;
    // ドラッグした画面距離を「今の縮尺でのサンプル数」に変換し、逆向きに範囲をずらす
    // （右へドラッグ＝地形を右へ引き出す＝表示範囲は左へ動く、という向き）。
    const dIdx = (dxPx / lastGeom.plotW) * span;
    setViewRange(panStartI0 - dIdx, panStartI1 - dIdx);
  });
  const endPan = () => { panning = false; cv.style.cursor = 'grab'; };
  cv.addEventListener('pointerup', endPan);
  cv.addEventListener('pointercancel', endPan);

  const resetBtn = el('profileZoomReset');
  if (resetBtn) resetBtn.addEventListener('click', resetZoom);
})();

export {
  profileState, setSectionLat, setExaggeration, setEnabled, buildProfile,
  profileLonRange, setEnabledChangeHandler,
  rebuildBuildingSection,
};

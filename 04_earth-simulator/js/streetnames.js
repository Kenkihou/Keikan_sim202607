// =============================================================================
// streetnames — ストリートビューで、目の前の路面に通り名と矢印を描く。
//
//   【データ】
//     通り名つきの道路中心線（OpenStreetMap）。roadnames.js が読む
//     roads-kyoto.json / roads-osaka.json で、断面図の通り名ラベルと同じもの。
//     ⚠️ roads.js が貼っている PLATEAU の道路（MVT）は【面】で名前を持たないので、
//       ラベルには使えない。位置合わせも中心線のほうが素直（帯を中心線に載せる）。
//
//   =========================================================================
//   ★ 見せ方は「路面標示（止まれ）」方式。Google と同じ“道なりに寝かせた文字”は
//     やめた。
//   =========================================================================
//     Google ストリートビューのように文字を道の伸びる向きに沿わせると、
//     ・文字の上が横（進行方向の左）を向くので画面上では90度寝て見える
//     ・目線が地面から1〜2mしかないため、奥ほど猛烈に潰れる
//     の二重苦で読めない（実際に作って確認した。仰角-16°でほぼ判読不能）。
//
//     実物の路面標示（「止まれ」「この先」）はこの問題を昔から解いている。
//       ① 文字は道を【横切る向き】に読ませ、文字の上を【進む先】へ向ける
//          → 運転席から見て正立する（＝寝ない）
//       ② 進む向きへ大きく引き伸ばす
//          → 浅い角度で潰れるぶんを先に伸ばして相殺する
//     ここでも同じことをする。①は向きの取り方だけ、②は頂点の置き方だけなので
//     【毎フレームの負荷はゼロ】（テクスチャは文字列ごとに1枚焼くだけ）。
//
//   【引き伸ばし方＝逆遠近】
//     引き伸ばし量を固定倍率にすると、手前は伸びすぎ・奥は潰れたままになる。
//     平らな地面では、距離 D の点の画面上の高さはほぼ 1/D に比例するので、
//     帯の節を【1/D が等間隔になる距離】に置けば、テクスチャの各行が画面上で
//     同じ高さに写る（＝逆遠近補正）。D_k = 1/( (1-t)/D手前 + t/D奥 )。
//     頂点の置き場所を変えるだけなので、これも実質タダ。
//
//   【どこに置くか】
//     手前端は「キャラクターの頭より奥」に自動で決める。カメラの高さ h、
//     キャラクターまでの距離 d、身長 H とすると、頭のてっぺんの伏角は
//     (h-H)/d なので、そこに地面が来る距離は h*d/(h-H)。ここより奥に置けば
//     文字がキャラクターに隠れない（見下ろすほど近く、水平に構えるほど遠くなる）。
//
//   【地形への沿わせ方】
//     帯は平らな板ではなく、進む向きに SEG_N 個へ割った短冊。節ごとに真上から
//     地形へレイを撃って高さを測り、路面から LIFT だけ浮かせる。
//     ⚠️ 1枚の平板だと、坂や起伏のある道では帯の中ほどが地面に潜って千切れる。
//     地形の高さを測る関数は streetview.js から渡してもらう（あちらが持っている
//     「見えているタイルだけを見る」判定をそのまま使いたい。逆向きに import すると
//     循環参照になるので、呼ばれるたびに受け取る形にした）。
//
//   【文字が鏡文字にならない条件】
//     地面に寝かせた文字は「読む向き = 文字の上 × 上方向(Y)」を満たすときだけ
//     正しく読める。文字の上＝進む向き dir なので、読む向き r = dir × Y。
//     （これを取り違えると、見た目は同じ帯なのに文字だけ裏返る。）
//
//   【着地点を選んでいる間は別の見せ方】
//     👣 を押して降りる場所を探している間は、カメラは上空から街を見下ろしている。
//     この視点に路面標示方式（逆遠近で手前に引き伸ばす）は合わないので、
//     【地図のように、道・川の上に沿って寝かせた文字】を出す。川名も一緒に出す。
//     文字の大きさはカメラ距離に比例させ、画面上でほぼ一定に見えるようにする。
// =============================================================================
import { THREE, scene, camera, requestRender } from './core.js';
import { DEG2RAD } from './config.js';
import { lonLatToLocal } from './geo.js';
import { roadNames, loadRoadNames, riverNames, loadRiverNames } from './roadnames.js';

const DEG = 180 / Math.PI;

// ---- 見せ方の寸法 ----------------------------------------------------------
// 同時に出す通りの数。★ 立っている通りだけでなく、まわりの通りも名前を出す
//   （京都の通りの格子を歩きながら覚えられるようにしたい、という意図）。
//   近い順に選ぶので、増やしても出るのは足元まわりから。
const MAX_LABELS = 6;
const SEARCH_R = 60;         // この距離までの通りを拾う[m]（通り1〜2本ぶん先まで）
// 文字の横幅[m]（道路を横切る向き）。道の格に応じて変える。
//   ⚠️ 一律に広くしてはいけない。御幸町通・麩屋町通のような幅4m前後の通りでは
//     帯が路肩をはみ出し、両端が建物の壁に食われて文字が欠ける。
const BLOCK_W = {
  motorway: 6, trunk: 6, primary: 6,
  secondary: 5.5, tertiary: 5.5,
  unclassified: 4.5, residential: 4,
  living_street: 3.5, pedestrian: 3.5,
};
const BLOCK_W_DEFAULT = 5;
const BAND_DEG = 7;          // 帯を画面上で何度ぶんの高さに写すか[度]（大きいほど文字が大きい）
const D_NEAR_MIN = 8;        // 手前端の距離の下限・上限[m]
const D_NEAR_MAX = 16;
const D_FAR_RATIO = 2.5;     // 奥端は手前端の何倍までにするか（引き伸ばしの上限）
// 奥端の絶対上限[m]。ふだんは D_FAR_RATIO のほうが先に効く歯止め。
//   ⚠️ ここを 40m のように小さく固定してはいけない。離れた通り（35m先の二条通など）は
//     帯が数mしか取れず、画面上で潰れて判読不能なゴミになる。遠い通りほど帯は長く要る。
const D_FAR_MAX = 100;
const CHARA_H = 1.5;         // キャラクターの身長[m]（頭の隠れ具合の計算に使う）
const LIFT = 0.25;           // 路面から浮かせる高さ[m]（地形の凹凸に埋もれない程度）
const SEG_N = 8;             // 帯を地形に沿わせる分割数
// 作り直しの間引き。歩くたびに毎フレーム作り直すとレイキャストが増えすぎる。
const REBUILD_MOVE = 1.0;    // これだけ動いたら作り直す[m]
const REBUILD_YAW = 10;      // これだけ向きが変わったら作り直す[度]
const REBUILD_EYE = 0.25;    // カメラの高さがこれだけ変わったら作り直す[m]（見上げ・見下ろし）
const REBUILD_MS = 1500;     // 止まっていても、この間隔では作り直す（地形が細かくなるため）

const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

// ★座標変換は geo.js（楕円体の曲率半径を使う正確版）を使うこと。
//   球の簡易式（アプリの他所で使っている EARTH_R 版）だと南北が 0.34% 伸び、
//   駅から3km北で約10m ずれる。東西の通りではこれが真横のずれになり、
//   ラベルが道から外れて隣の街区に乗る（実際にそうなっていた）。

// -----------------------------------------------------------------------------
// 線分の索引（格子）
//   市域全体で1.5万本ほどの線分があるので、足元まわりだけを速く引けるように
//   128m の格子へ放り込んでおく。作るのは最初の1回だけ。
// -----------------------------------------------------------------------------
const CELL = 128;
const grid = new Map();      // 'cx,cz' → [線分, ...]
let indexed = false;

const cellKey = (cx, cz) => cx + ',' + cz;

function buildIndex() {
  if (indexed || !roadNames.loaded) return;
  for (const way of roadNames.ways) {
    const pts = way.pts;
    if (!way.name || !pts || pts.length < 2) continue;
    let a = lonLatToLocal(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const b = lonLatToLocal(pts[i][0], pts[i][1]);
      const seg = { name: way.name, w: BLOCK_W[way.highway] || BLOCK_W_DEFAULT,
                    x0: a.x, z0: a.z, x1: b.x, z1: b.z };
      const cx0 = Math.floor(Math.min(a.x, b.x) / CELL), cx1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const cz0 = Math.floor(Math.min(a.z, b.z) / CELL), cz1 = Math.floor(Math.max(a.z, b.z) / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = cellKey(cx, cz);
          let arr = grid.get(k);
          if (!arr) grid.set(k, arr = []);
          arr.push(seg);
        }
      }
      a = b;
    }
  }
  indexed = true;
}

/* 点(x,z) から線分へのいちばん近い点と、その距離。 */
function closestOnSeg(x, z, s) {
  const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((x - s.x0) * dx + (z - s.z0) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = s.x0 + dx * t, pz = s.z0 + dz * t;
  return { px, pz, dist: Math.hypot(x - px, z - pz), dx, dz };
}

/* 足元まわりの通りを、名前ごとに「いちばん近い1本」へまとめて返す。 */
function nearbyRoads(x, z) {
  const c0 = Math.floor((x - SEARCH_R) / CELL), c1 = Math.floor((x + SEARCH_R) / CELL);
  const d0 = Math.floor((z - SEARCH_R) / CELL), d1 = Math.floor((z + SEARCH_R) / CELL);
  const byName = new Map();
  for (let cx = c0; cx <= c1; cx++) {
    for (let cz = d0; cz <= d1; cz++) {
      const arr = grid.get(cellKey(cx, cz));
      if (!arr) continue;
      for (const s of arr) {
        const hit = closestOnSeg(x, z, s);
        if (hit.dist > SEARCH_R) continue;
        const prev = byName.get(s.name);
        if (!prev || hit.dist < prev.dist) byName.set(s.name, { name: s.name, w: s.w, ...hit });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.dist - b.dist);
}

// -----------------------------------------------------------------------------
// 文字のテクスチャ（上段＝通り名／下段＝矢印＋「西向き」）
//   ★ 縦横比は路面の帯と揃えなくてよい。帯の長さは逆遠近で決まり、その差が
//     そのまま「路面標示の引き伸ばし」になる（このキャンバスは伸びる前の絵）。
//   文字列ごとに1枚作って使い回す（歩いている間、同じ文字列が続くため）。
// -----------------------------------------------------------------------------
const TEX_W = 512, TEX_H = 288;     // 横＝道を横切る向き／縦＝進む向き（上が進む先）
const BAND_Y = 176;                 // 上段（通り名）と下段（矢印＋向き）の境
const texCache = new Map();         // 'name|向き' → CanvasTexture
const TEX_CACHE_MAX = 24;

const FONT = (px) => 'bold ' + px + 'px "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';

/* 白抜き＋黒縁で描く（明るい路面でも暗い路面でも読めるように）。 */
function paint(ctx, draw, lw) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#ffffff';
  draw();
}

function makeTexture(name, dirName) {
  const key = name + '|' + dirName;
  const cached = texCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = TEX_W; canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';

  // ---- 上段：通り名（幅いっぱいまで大きく。長い名前だけ小さくする）
  let px = 132;
  ctx.font = FONT(px);
  const maxW = TEX_W * 0.92;
  const w = ctx.measureText(name).width;
  if (w > maxW) { px = Math.max(52, Math.floor(px * maxW / w)); ctx.font = FONT(px); }
  ctx.textAlign = 'center';
  paint(ctx, () => {
    ctx.strokeText(name, TEX_W / 2, BAND_Y / 2);
    ctx.fillText(name, TEX_W / 2, BAND_Y / 2);
  }, Math.max(6, px * 0.09));

  // ---- 下段：矢印（キャンバスの上＝進む先を指す）＋「◯向き」
  const dPx = 74;
  ctx.font = FONT(dPx);
  ctx.textAlign = 'left';
  const label = dirName + '向き';
  const tw = ctx.measureText(label).width;
  const chW = 62, gap = 14;
  const x0 = (TEX_W - (chW + gap + tw)) / 2;
  const my = (BAND_Y + TEX_H) / 2;
  paint(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(x0, my + 26);
    ctx.lineTo(x0 + chW / 2, my - 30);
    ctx.lineTo(x0 + chW, my + 26);
    ctx.lineTo(x0 + chW / 2, my + 10);
    ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.strokeText(label, x0 + chW + gap, my);
    ctx.fillText(label, x0 + chW + gap, my);
  }, 8);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (texCache.size >= TEX_CACHE_MAX) {
    const oldestKey = texCache.keys().next().value;
    texCache.get(oldestKey).dispose();
    texCache.delete(oldestKey);
  }
  texCache.set(key, tex);
  return tex;
}

// -----------------------------------------------------------------------------
// 帯（短冊）ひとつ分の入れ物。頂点数は固定なので、位置だけ書き換えて使い回す。
//   u（0→1）＝読む向き（道を横切る）／ v（0→1）＝手前→奥（文字の上が奥）
// -----------------------------------------------------------------------------
const labels = [];   // [{mesh, geom, mat}]

function ensureLabel(i) {
  if (labels[i]) return labels[i];
  const geom = new THREE.BufferGeometry();
  const n = (SEG_N + 1) * 2;
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  const idx = [];
  for (let k = 0; k <= SEG_N; k++) {
    const v = k / SEG_N;
    uv[(k * 2) * 2] = 0;     uv[(k * 2) * 2 + 1] = v;       // 読み始め側（u=0）
    uv[(k * 2 + 1) * 2] = 1; uv[(k * 2 + 1) * 2 + 1] = v;   // 読み終わり側（u=1）
    if (k < SEG_N) {
      const a = k * 2, b = k * 2 + 1, c = (k + 1) * 2, d = (k + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.95, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
    // 路面とほぼ同じ高さに置くので、深度の取り合いで縞が出ないようずらす
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;   // 頂点を直に書き換えるので、境界球は当てにしない
  mesh.renderOrder = 990;
  mesh.visible = false;
  scene.add(mesh);
  return (labels[i] = { mesh, geom, mat });
}

// -----------------------------------------------------------------------------
// 毎フレーム呼ばれる入口（streetview.js から）
// -----------------------------------------------------------------------------
const last = { x: 1e9, z: 1e9, yaw: 1e9, eye: 1e9, ms: 0 };

export function updateStreetNames(stand, yaw, sampleGroundY) {
  if (!roadNames.loaded) { loadRoadNames(); return; }
  buildIndex();

  // カメラの高さ（地面から）と、キャラクターまでの水平距離。
  //   どちらも見上げ・見下ろしで変わる（三人称なのでカメラが回り込む）。
  const eyeH = Math.max(0.6, camera.position.y - stand.y);
  const charaD = Math.max(0.5, Math.hypot(camera.position.x - stand.x, camera.position.z - stand.z));

  const now = performance.now();
  const moved = Math.hypot(stand.x - last.x, stand.z - last.z);
  let dYaw = Math.abs((yaw - last.yaw) * DEG) % 360;
  if (dYaw > 180) dYaw = 360 - dYaw;
  if (moved < REBUILD_MOVE && dYaw < REBUILD_YAW
      && Math.abs(eyeH - last.eye) < REBUILD_EYE && now - last.ms < REBUILD_MS) return;
  last.x = stand.x; last.z = stand.z; last.yaw = yaw; last.eye = eyeH; last.ms = now;

  // ★帯の手前端の最短距離＝キャラクターの頭のてっぺんが地面と重なって見える距離の
  //   少し奥。ここより手前に置くと、文字の真ん中がキャラクターに隠れる。
  const dNearMin = Math.min(D_NEAR_MAX, Math.max(D_NEAR_MIN,
    1.15 * eyeH * charaD / Math.max(0.15, eyeH - CHARA_H)));

  // 見ている向き（水平）。
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);

  let n = 0;
  for (const road of nearbyRoads(stand.x, stand.z)) {
    if (n >= MAX_LABELS) break;
    // 通りの伸びる向きのうち、見ている向きに近いほうを「進む向き」にする
    const len = Math.hypot(road.dx, road.dz);
    if (len < 1e-6) continue;
    let dx = road.dx / len, dz = road.dz / len;
    if (dx * fx + dz * fz < 0) { dx = -dx; dz = -dz; }
    // 読む向き r = 進む向き × Y（地面に寝かせた文字が鏡文字にならない向き）
    const rx = -dz, rz = dx;

    // カメラを道の中心線へ下ろした足（沿う向きの座標 sCam と、線までの横ずれ lat）。
    //   道の上の点で「カメラから距離 D」になるのは s = sCam + √(D² - lat²)。
    const wx = camera.position.x - road.px, wz = camera.position.z - road.pz;
    const sCam = wx * dx + wz * dz;
    const lat2 = Math.max(0, wx * wx + wz * wz - sCam * sCam);

    // ⚠️ 帯は最寄りの線分の【接線に沿った直線】として置く（曲がった道では、遠くへ
    //   伸びるほど実際の道からずれていく）。京都の通りは直線なので実害はないが、
    //   曲線路で目立つようなら、way のポリラインを弧長で辿る形に変えること。
    // ★帯を置く距離は【その通りごと】に決める。
    //   離れた通り（横切る通りの1本先など）は、どう置いても最接近点より近くには
    //   置けないので、そこを手前端にする。近い通りは dNearMin（＝キャラの頭の奥）。
    //   これをやらないと「カメラから dNearMin の点」が道の上に存在せず、
    //   少し離れた通りが軒並み出なくなる（二条通・押小路通が出なかった原因）。
    const dN = Math.max(dNearMin, Math.sqrt(lat2));
    // 奥端＝手前端から BAND_DEG ぶん伏角を浅くした距離（＝画面上での帯の高さ）。
    const thNear = Math.atan(eyeH / dN);
    const thFar = Math.max(thNear * 0.25, thNear - BAND_DEG * DEG2RAD);
    const dFar = Math.min(D_FAR_MAX, dN * D_FAR_RATIO, eyeH / Math.tan(thFar));

    // 前後どちらの端もカメラの背中側なら出さない（真横の通りは残す）
    const s0 = sCam + Math.sqrt(Math.max(0, dN * dN - lat2));
    const s1 = sCam + Math.sqrt(Math.max(0, dFar * dFar - lat2));
    const ah0 = (road.px + dx * s0 - camera.position.x) * fx + (road.pz + dz * s0 - camera.position.z) * fz;
    const ah1 = (road.px + dx * s1 - camera.position.x) * fx + (road.pz + dz * s1 - camera.position.z) * fz;
    if (ah0 <= 0 && ah1 <= 0) continue;

    // 方位（北=0°、東回り）。ワールドは +Z=北 / +X=西 なので東成分は -dx。
    let bearing = Math.atan2(-dx, dz) * DEG;
    if (bearing < 0) bearing += 360;

    const slot = ensureLabel(n);
    const tex = makeTexture(road.name, COMPASS[Math.round(bearing / 45) % 8]);
    if (slot.mat.map !== tex) { slot.mat.map = tex; slot.mat.needsUpdate = true; }

    // ★逆遠近。1/D を等間隔に刻むと、テクスチャの各行が画面上で同じ高さに写る。
    //   遠い帯は画面上で数十pxしかないので、地形を測る間隔を粗くする
    //   （ラベルを増やしたぶんレイキャストが増えるのを抑える）。
    const stride = dN < 25 ? 1 : 2;
    const pos = slot.geom.getAttribute('position');
    const half = road.w / 2;
    let y = stand.y, prevK = 0, prevY = null;
    for (let k = 0; k <= SEG_N; k++) {
      const t = k / SEG_N;
      const d = 1 / ((1 - t) / dN + t / dFar);
      const s = sCam + Math.sqrt(Math.max(0.25, d * d - lat2));
      const cx = road.px + dx * s, cz = road.pz + dz * s;
      if (k % stride === 0 || k === SEG_N) {
        // 高さは中心線の1点だけ測って左右で共有する（レイキャストを半分に減らす）
        const gy = sampleGroundY(cx, cz, y);
        if (gy !== null) y = gy;
        // 測らなかった節は、前に測った高さとの間を按分して埋める
        if (prevY !== null) {
          for (let j = prevK + 1; j < k; j++) {
            const f = (j - prevK) / (k - prevK);
            const yj = prevY + (y - prevY) * f + LIFT;
            pos.setY(j * 2, yj); pos.setY(j * 2 + 1, yj);
          }
        }
        prevK = k; prevY = y;
      }
      const yy = y + LIFT;
      pos.setXYZ(k * 2, cx - rx * half, yy, cz - rz * half);       // 読み始め側（u=0）
      pos.setXYZ(k * 2 + 1, cx + rx * half, yy, cz + rz * half);   // 読み終わり側（u=1）
    }
    pos.needsUpdate = true;
    slot.geom.computeBoundingSphere();
    slot.mesh.visible = true;
    n++;
  }
  for (let i = n; i < labels.length; i++) labels[i].mesh.visible = false;
}

// =============================================================================
// 着地点を選んでいる間の3Dラベル（道と川の上に、地図のように寝かせた文字）
// =============================================================================
// ★ 道と川で枠を分ける。まとめて近い順に選ぶと、道が密な市街地では川が
//   いつまでも入らない（実測: 注視点から 211m 以内に道が6本ある一方、いちばん近い
//   川は 592m 先だった）。川は数が少なく目印になるので、別枠＋少し広めに拾う。
const PICK_MAX_ROAD = 12;
const PICK_MAX_RIVER = 6;
const PICK_RIVER_RANGE = 1.6;   // 川を拾う範囲は道の何倍か
const PICK_TEXT_RATIO = 0.028; // 文字の高さ ÷ カメラ距離（画面上でほぼ一定にする）
const PICK_TEXT_MIN = 6, PICK_TEXT_MAX = 260;   // 文字の高さの下限・上限[m]
const PICK_LIFT = 1.5;        // 地面から浮かせる高さ[m]
const PICK_SEG = 4;           // 地形に沿わせる分割数（横方向）
const PICK_REBUILD_MOVE = 0.06; // カメラがこの割合だけ動いたら作り直す
const PICK_ROAD_COLOR = '#ffffff';
const PICK_RIVER_COLOR = '#7fd4ff';

const pickLabels = [];        // [{mesh, geom, mat}]
const pickTexCache = new Map();
const PICK_TEX_MAX = 64;

/* 1行だけの文字テクスチャ（白または水色、黒縁）。戻り値に縦横比も持たせる。 */
function pickTexture(name, color) {
  const key = name + '|' + color;
  const hit = pickTexCache.get(key);
  if (hit) return hit;
  const px = 96, pad = 18;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = FONT(px);
  const w = Math.ceil(probe.measureText(name).width) + pad * 2;
  const h = px + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = FONT(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(8, px * 0.14);
  ctx.strokeStyle = 'rgba(8,12,20,0.92)';
  ctx.strokeText(name, w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(name, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const entry = { tex, aspect: w / h };
  if (pickTexCache.size >= PICK_TEX_MAX) {
    const oldest = pickTexCache.keys().next().value;
    pickTexCache.get(oldest).tex.dispose();
    pickTexCache.delete(oldest);
  }
  pickTexCache.set(key, entry);
  return entry;
}

function ensurePickLabel(i) {
  if (pickLabels[i]) return pickLabels[i];
  const geom = new THREE.BufferGeometry();
  const n = (PICK_SEG + 1) * 2;
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  const idx = [];
  for (let k = 0; k <= PICK_SEG; k++) {
    const u = k / PICK_SEG;
    uv[(k * 2) * 2] = u;     uv[(k * 2) * 2 + 1] = 0;
    uv[(k * 2 + 1) * 2] = u; uv[(k * 2 + 1) * 2 + 1] = 1;
    if (k < PICK_SEG) {
      const a = k * 2, b = k * 2 + 1, c = (k + 1) * 2, d = (k + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 991;
  mesh.visible = false;
  mesh.raycast = () => {};       // 着地点を拾うレイキャストに当てない
  scene.add(mesh);
  return (pickLabels[i] = { mesh, geom, mat });
}

/* 線データ（道 or 川）から、中心 (cx,cz) の近くのものを名前ごとに1本ずつ拾う。 */
function nearestLines(list, cx, cz, radius, isRiver) {
  const byName = new Map();
  for (const w of list) {
    const pts = w.pts;
    if (!w.name || !pts || pts.length < 2) continue;
    let a = lonLatToLocal(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const b = lonLatToLocal(pts[i][0], pts[i][1]);
      const hit = closestOnSeg(cx, cz, { x0: a.x, z0: a.z, x1: b.x, z1: b.z });
      if (hit.dist <= radius) {
        const prev = byName.get(w.name);
        if (!prev || hit.dist < prev.dist) {
          byName.set(w.name, { name: w.name, isRiver, ...hit });
        }
      }
      a = b;
    }
  }
  return [...byName.values()];
}

/* 着地点を選んでいる間のラベルを作り直す。
     center … 画面の中心あたり（注視点）のワールド座標
     camDist … カメラから注視点までの距離（文字の大きさに使う）
     camRight … カメラの右向き（文字が上下逆にならないよう向きを決めるのに使う） */
const _pickLast = { x: 1e9, z: 1e9, d: 1e9, ms: 0 };
export function updatePickLabels(center, camDist, camRight, sampleGroundY) {
  // データが未着なら読み始める。届いたら描き直す（着地点選択中は描画がオンデマンド
  // なので、読み終わっただけでは画面が更新されないため）。
  if (!roadNames.loaded) loadRoadNames().then(requestRender);
  if (!riverNames.loaded) loadRiverNames().then(requestRender);
  if (!roadNames.loaded && !riverNames.loaded) return;
  buildIndex();

  const now = performance.now();
  const moved = Math.hypot(center.x - _pickLast.x, center.z - _pickLast.z);
  const zoomed = Math.abs(camDist - _pickLast.d) / Math.max(1, camDist);
  if (moved < camDist * PICK_REBUILD_MOVE && zoomed < PICK_REBUILD_MOVE
      && now - _pickLast.ms < 400) return;
  _pickLast.x = center.x; _pickLast.z = center.z; _pickLast.d = camDist; _pickLast.ms = now;

  const radius = Math.min(4000, Math.max(120, camDist * 0.9));
  const textH = Math.min(PICK_TEXT_MAX, Math.max(PICK_TEXT_MIN, camDist * PICK_TEXT_RATIO));
  const byDist = (a, b) => a.dist - b.dist;
  const found = [
    ...nearestLines(roadNames.ways, center.x, center.z, radius, false)
      .sort(byDist).slice(0, PICK_MAX_ROAD),
    ...nearestLines(riverNames.rivers, center.x, center.z, radius * PICK_RIVER_RANGE, true)
      .sort(byDist).slice(0, PICK_MAX_RIVER),
  ];

  let n = 0;
  for (const line of found) {
    const len = Math.hypot(line.dx, line.dz);
    if (len < 1e-6) continue;
    let dx = line.dx / len, dz = line.dz / len;
    // 上下逆さまにならないよう、カメラの右向きに近いほうを「読む向き」にする
    if (dx * camRight.x + dz * camRight.z < 0) { dx = -dx; dz = -dz; }
    // 文字の上向き ＝ 読む向き × Y の逆（地面に寝かせた文字が鏡文字にならない向き）
    const ux = dz, uz = -dx;
    const entry = pickTexture(line.name, line.isRiver ? PICK_RIVER_COLOR : PICK_ROAD_COLOR);
    const slot = ensurePickLabel(n);
    if (slot.mat.map !== entry.tex) { slot.mat.map = entry.tex; slot.mat.needsUpdate = true; }
    const halfW = textH * entry.aspect / 2, halfH = textH / 2;
    const pos = slot.geom.getAttribute('position');
    let y = 0, gotY = false;
    for (let k = 0; k <= PICK_SEG; k++) {
      const t = (k / PICK_SEG - 0.5) * 2 * halfW;
      const cx = line.px + dx * t, cz = line.pz + dz * t;
      const gy = sampleGroundY(cx, cz, gotY ? y : null);
      if (gy !== null) { y = gy; gotY = true; }
      const yy = y + PICK_LIFT;
      pos.setXYZ(k * 2, cx - ux * halfH, yy, cz - uz * halfH);
      pos.setXYZ(k * 2 + 1, cx + ux * halfH, yy, cz + uz * halfH);
    }
    pos.needsUpdate = true;
    slot.geom.computeBoundingSphere();
    slot.mesh.visible = true;
    n++;
  }
  for (let i = n; i < pickLabels.length; i++) pickLabels[i].mesh.visible = false;
}

export function hidePickLabels() {
  for (const l of pickLabels) l.mesh.visible = false;
  _pickLast.x = _pickLast.z = _pickLast.d = 1e9;
  _pickLast.ms = 0;
}

export function hideStreetNames() {
  for (const l of labels) l.mesh.visible = false;
  last.x = last.z = last.yaw = last.eye = 1e9;
  last.ms = 0;
}

// =============================================================================
// sky — 青空（スカイドーム）と、時刻に応じた太陽の光。
//
//   【空の作り方】
//     three の Sky（Preetham 大気散乱）は使わず、【自前のグラデーションのドーム】に
//     した。Sky シェーダは出力が HDR で、まともに見せるには renderer 側の
//     トーンマッピングを入れる必要がある。これは【画面全体の見え方】を変える設定で、
//     白モデル・標高段彩・断面の灰色など、既に色を詰めてある表現がまとめて変わって
//     しまう。グラデーションなら LDR のまま完結し、色も直接決められる。
//
//     ドームは半径 60km の球を裏から見る。カメラの位置へ毎フレーム移動させるので、
//     どこまで歩いても（飛んでも）同じ空が回りにある。深度は書かない（常に最背面）。
//
//   【太陽の位置】
//     時刻と日付から【実際の太陽の高度・方位】を計算する（NOAA の近似式）。
//     緯度経度は config.js の原点（京都駅／大阪駅）、時差は日本標準時 +9。
//     ワールドは +Z=北 / +X=西 なので、方位角 A・高度 h の向きは
//       z = cos(A)cos(h) （北）, x = -sin(A)cos(h) （東は -X）, y = sin(h)
//     影の検討にそのまま使えるよう、見た目優先の適当な角度にはしない。
//
//   【明るさ】
//     太陽の高度から、直射（DirectionalLight）・空の色・環境光をまとめて決める。
//     日の出前・日没後は青い残照 → 夜は暗い紺。もとの暗い画面はこの夜の状態に近い。
//
//   【箱庭のときは「空だけ」出さない】
//     切り抜き（箱庭）表示は模型を眺める画面なので、空（ドーム）と明るい背景は出さず、
//     背景は暗いままにする。ただし【時刻による明るさの変化は効かせる】。
//
//   【影は箱庭のときだけ】
//     影は箱庭の中身（一辺 最大500m）に絞ってこそ意味がある。市域全体（数十km）に
//     1枚のシャドウマップを張ると、1画素が数十mになって影の形が出ない。
//     ⚠️ 影を落とす面には material.clipShadows を立てること。既定では切り抜き
//       （clippingPlanes）が深度パスに効かず、箱の外の建物が箱の中へ影を落とす。
// =============================================================================
import { THREE, scene, camera, sun, el, requestRender, renderer, focusLocal } from './core.js';
import { ORIGIN_LAT, ORIGIN_LON, DEG2RAD } from './config.js';
import { clipState } from './section.js';
import { wardTiles, getTerrainTiles } from './tiles.js';

// 空を出さないときの背景・霧の色（core.js の初期値と同じ。もとの暗い見え方）。
const PLAIN_COLOR = 0x0e1626;

const RAD2DEG = 180 / Math.PI;
const DOME_R = 60000;          // ドームの半径[m]（カメラの far=100000 より内側）
const TZ_HOURS = 9;            // 日本標準時（東経135度）

// 既定は夏の昼下がり。季節は「春分・夏至・秋分・冬至」から選ぶ（設計の検討で使う4つ）。
export const skyState = {
  enabled: true,     // 空（ドーム）を描くか。※明るさは箱庭でも常に時刻に従う
  hour: 13,          // 0〜24（小数）
  dayOfYear: 172,    // 夏至あたり
  brightness: 1,     // 明るさの手動調整（0.4〜1.6）
  shadows: true,     // 影を落とす（箱庭表示のときだけ効く）
};

// -----------------------------------------------------------------------------
// 太陽の位置（NOAA の近似式）
//   戻り値は高度 alt[rad]（地平線から上が正）と方位 az[rad]（北=0、東回り）。
// -----------------------------------------------------------------------------
export function sunAltAz(dayOfYear, hour) {
  const lat = ORIGIN_LAT;                       // rad
  const lonDeg = ORIGIN_LON * RAD2DEG;
  // 均時差と赤緯（フーリエ近似）
  const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (hour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));           // 分
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);             // rad
  // 真太陽時 → 時角
  const timeOffset = eqTime + 4 * lonDeg - 60 * TZ_HOURS;                 // 分
  const trueSolarTime = (hour * 60 + timeOffset + 1440) % 1440;           // 分
  const ha = (trueSolarTime / 4 - 180) * DEG2RAD;                         // rad
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  let az = Math.atan2(-Math.sin(ha) * Math.cos(decl),
    Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(ha));
  az = (az + 2 * Math.PI) % (2 * Math.PI);      // 北=0、東回り
  return { alt, az };
}

/* 高度・方位 → ワールドの向き（+Z=北 / +X=西 / +Y=上）。 */
function altAzToDir(alt, az, out) {
  const c = Math.cos(alt);
  return out.set(-Math.sin(az) * c, Math.sin(alt), Math.cos(az) * c);
}

// -----------------------------------------------------------------------------
// ドーム（グラデーション＋太陽のにじみ）
// -----------------------------------------------------------------------------
const uniforms = {
  uZenith:   { value: new THREE.Color(0x2a6fd6) },
  uHorizon:  { value: new THREE.Color(0xbcd8f0) },
  uGround:   { value: new THREE.Color(0x0e1626) },   // 地平線より下（霧と同じ色）
  uSunDir:   { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(0xfff2cf) },
  uSunGlow:  { value: 1 },                           // 太陽まわりのにじみの強さ
};

const domeMat = new THREE.ShaderMaterial({
  uniforms,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  fog: false,
  toneMapped: false,
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uZenith, uHorizon, uGround, uSunColor;
    uniform vec3 uSunDir;
    uniform float uSunGlow;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      // 天頂〜地平線のグラデーション。地平線際を厚く見せるため pow で寄せる。
      float up = clamp(d.y, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(up, 0.45));
      // 地平線より下は霧と同じ色へ落とす（地形の外側と繋がって見えるように）
      float below = clamp(-d.y * 12.0, 0.0, 1.0);
      col = mix(col, uGround, below);
      // 太陽のにじみ（円盤は描かない。まぶしさだけ）
      float s = max(dot(d, normalize(uSunDir)), 0.0);
      col += uSunColor * (pow(s, 220.0) * 1.4 + pow(s, 8.0) * 0.10) * uSunGlow;
      // ⚠️ 生の ShaderMaterial には three の色空間変換が入らない。uniform の色は
      //   リニアで渡ってくるので、ここで sRGB へ戻さないと指定より暗く沈む
      //   （実測: 指定 #2a6fd6 が #2b4fbb で出た）。
      col = mix(1.055 * pow(max(col, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                col * 12.92, step(col, vec3(0.0031308)));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 32, 16), domeMat);
dome.frustumCulled = false;
dome.renderOrder = -1000;     // 何よりも先に描く（深度は書かないので背景になる）
dome.raycast = () => {};      // 空はどのレイキャストにも当てない
dome.visible = false;
scene.add(dome);

// -----------------------------------------------------------------------------
// 色と明るさの決め方（太陽高度で連続的に変える）
// -----------------------------------------------------------------------------
const NIGHT = {
  zenith: new THREE.Color(0x070c18), horizon: new THREE.Color(0x121d33),
  fog: new THREE.Color(PLAIN_COLOR),
};
const DAY = {
  zenith: new THREE.Color(0x2a6fd6), horizon: new THREE.Color(0xc3dcf2),
  fog: new THREE.Color(0xb9d3ea),
};
const DUSK = {
  zenith: new THREE.Color(0x1d3a6b), horizon: new THREE.Color(0xe8a765),
  fog: new THREE.Color(0xc28f68),
};

const _dir = new THREE.Vector3();
// ⚠️ 使い回しの色は用途ごとに分ける。mix3 の戻り値と同じものを別用途で上書きすると、
//   霧の色が太陽の色で潰れる（実際に一度そうなった）。
const _c1 = new THREE.Color();     // mix3 の作業用
const _fog = new THREE.Color();    // 霧の色
const _sunCol = new THREE.Color(), _white = new THREE.Color(0xffffff);

// もとの（空を出さないときの）暗い見え方。箱庭表示ではこれに戻す。
const BASE_BG = new THREE.Color(PLAIN_COLOR);
const BASE_SUN_INT = 2.2, BASE_HEMI_INT = 1.6, BASE_AMB_INT = 0.35;

let hemi = null, amb = null;
function findLights() {
  if (hemi && amb) return;
  scene.traverse((o) => {
    if (o.isHemisphereLight) hemi = o;
    else if (o.isAmbientLight) amb = o;
  });
}

/* 太陽高度 alt[rad] から、空・光の色と強さを決めて当てる。 */
function applySun(alt, az) {
  const altDeg = alt * RAD2DEG;
  // 3段（夜 → 夕 → 昼）を高度で混ぜる
  const dusk = THREE.MathUtils.smoothstep(altDeg, -8, 4);    // 夜→夕
  const day = THREE.MathUtils.smoothstep(altDeg, 2, 22);     // 夕→昼
  const mix3 = (key) => {
    _c1.copy(NIGHT[key]).lerp(DUSK[key], dusk);
    return _c1.lerp(DAY[key], day);
  };
  uniforms.uZenith.value.copy(mix3('zenith'));
  uniforms.uHorizon.value.copy(mix3('horizon'));
  _fog.copy(mix3('fog'));
  uniforms.uGround.value.copy(_fog).multiplyScalar(0.55);

  // 直射光。高度が低いほど弱く・赤くする。
  //   ★ 直射と環境光の【比】は影の濃さそのもの。環境光が直射より強いと、影が
  //     落ちていても薄くて読めない（実測で、半球光2.56に対し直射2.05のとき
  //     影の暗さは平均35/255しかなかった）。日なたの明るさは保ったまま、
  //     直射を強め・環境光を弱めて比を付ける。
  const b = skyState.brightness;
  const s = Math.max(0, Math.sin(Math.max(0, alt)));
  sun.intensity = BASE_SUN_INT * b * (0.08 + 1.10 * Math.pow(s, 0.6));
  _sunCol.setHex(0xffe0b0).lerp(_white, day);                // 低いと橙、高いと白
  sun.color.copy(_sunCol);
  altAzToDir(alt, az, _dir);
  sun.position.copy(_dir).multiplyScalar(2000);

  // 環境光。夜は元の暗さ、昼は空の照り返しぶんだけ持ち上げる。
  findLights();
  const ambBoost = 0.35 + 0.65 * day;
  if (hemi) {
    hemi.intensity = BASE_HEMI_INT * b * (0.35 + 0.60 * day);
    hemi.color.copy(uniforms.uHorizon.value);
  }
  if (amb) amb.intensity = BASE_AMB_INT * b * ambBoost;

  uniforms.uSunGlow.value = 0.2 + 0.8 * day;
  return _fog;
}

// -----------------------------------------------------------------------------
// 影（箱庭表示のときだけ）
// -----------------------------------------------------------------------------
const SHADOW_MAP = 2048;       // シャドウマップの一辺[px]
const SHADOW_DIST = 1800;      // 光源を箱の中心からどれだけ離すか[m]
const SHADOW_FLAG_MS = 400;    // 影を落とす面の登録をやり直す間隔[ms]
let shadowReady = false;
let flagMs = 0;

function ensureShadowSetup() {
  if (shadowReady) return;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  // ⚠️ 地形は三角形が大きく、bias だけだと縞（シャドウアクネ）が出る。
  //   normalBias（法線方向へ押し出す量）をメートル単位で入れておくと収まる。
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun.target);        // target は scene に居ないと行列が更新されない
  shadowReady = true;
}

/* タイルのメッシュへ「影を落とす／受ける」を付ける。タイルは後から届くので繰り返す。 */
function applyShadowFlags() {
  const groups = [];
  for (const t of wardTiles) if (t.group) groups.push(t.group);
  const tt = getTerrainTiles();
  if (tt && tt.group) groups.push(tt.group);
  for (const g of groups) {
    g.traverse((o) => {
      if (!o.isMesh || o.__shadowFlagged) return;
      o.__shadowFlagged = true;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        // ★ 切り抜き（箱庭の箱）を深度パスにも効かせる。これが無いと箱の外の
        //   建物が箱の中へ影を落とす。
        if (m && !m.clipShadows) { m.clipShadows = true; m.needsUpdate = true; }
      }
    });
  }
}

/* 影の当て方を今の状態に合わせる。dir は太陽の向き（単位ベクトル）。 */
function updateShadow(dir, alt) {
  const on = skyState.shadows && clipState.enabled && alt > 0.05;
  sun.castShadow = on;
  if (!on) return;
  ensureShadowSetup();
  // 箱の大きさに合わせて影の範囲を絞る（広げるほど1画素が粗くなる）
  const half = Math.max(60, clipState.size * 0.8);
  const cam = sun.shadow.camera;
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.near = 10; cam.far = SHADOW_DIST * 2;
  cam.updateProjectionMatrix();
  // 光源も的も箱の中心（注目地点）に合わせる
  sun.target.position.copy(focusLocal);
  sun.target.updateMatrixWorld();
  sun.position.copy(focusLocal).addScaledVector(dir, SHADOW_DIST);
}

// -----------------------------------------------------------------------------
// 毎フレームの更新（描画ループから呼ぶ）
// -----------------------------------------------------------------------------
let lastKey = '';
export function updateSky() {
  // ★ 明るさ（太陽の向き・光の強さ）は【箱庭でも全体でも】時刻に従う。
  //   箱庭で出さないのは空のドームと明るい背景だけ。
  const showDome = skyState.enabled && !clipState.enabled;
  const key = [showDome, skyState.hour.toFixed(3), skyState.dayOfYear, skyState.brightness,
    skyState.shadows, clipState.enabled, Math.round(clipState.size),
    Math.round(focusLocal.x), Math.round(focusLocal.z)].join('|');
  if (key !== lastKey) {
    lastKey = key;
    const { alt, az } = sunAltAz(skyState.dayOfYear, skyState.hour);
    altAzToDir(alt, az, _dir);
    uniforms.uSunDir.value.copy(_dir);
    const fogCol = applySun(alt, az);        // 光と空の色（向きも intensity もここで決まる）
    dome.visible = showDome;
    if (showDome) {
      scene.background = null;               // ドームが背景になる
      scene.fog.color.copy(fogCol);
    } else {
      scene.background = BASE_BG;            // 箱庭は暗い背景のまま
      scene.fog.color.copy(BASE_BG);
    }
    updateShadow(_dir, alt);                 // ※光源の位置を上書きするので applySun の後
    updateSkyReadout();
  }
  // タイルは後から届くので、影を落とす面の登録は時々やり直す
  if (sun.castShadow && performance.now() - flagMs > SHADOW_FLAG_MS) {
    flagMs = performance.now();
    applyShadowFlags();
  }
  // ドームは常にカメラを包む（歩いても飛んでも同じ空）
  if (dome.visible) dome.position.copy(camera.position);
}

// -----------------------------------------------------------------------------
// 操作（HUD の「空と太陽」）
// -----------------------------------------------------------------------------
const SEASONS = [
  { label: '春分（3/21）', day: 80 },
  { label: '夏至（6/21）', day: 172 },
  { label: '秋分（9/23）', day: 266 },
  { label: '冬至（12/22）', day: 356 },
];

function hourText(h) {
  const m = Math.round(h * 60);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function updateSkyReadout() {
  const out = el('skyReadout');
  if (!out) return;
  const { alt, az } = sunAltAz(skyState.dayOfYear, skyState.hour);
  const altD = alt * RAD2DEG;
  out.textContent = altD > 0
    ? `太陽 高度 ${altD.toFixed(0)}° ／ 方位 ${(az * RAD2DEG).toFixed(0)}°`
    : `太陽 地平線の下（${altD.toFixed(0)}°）`;
}

(function setupSkyUI() {
  const on = el('skyOn'), hour = el('skyHour'), hourOut = el('skyHourOut');
  const season = el('skySeason'), bright = el('skyBright'), shadow = el('skyShadow');
  if (!on || !hour || !season || !bright) return;

  for (const s of SEASONS) {
    const opt = document.createElement('option');
    opt.value = String(s.day);
    opt.textContent = s.label;
    if (s.day === skyState.dayOfYear) opt.selected = true;
    season.appendChild(opt);
  }
  on.checked = skyState.enabled;
  hour.value = String(skyState.hour * 60);
  bright.value = String(skyState.brightness * 100);
  if (hourOut) hourOut.textContent = hourText(skyState.hour);

  const changed = () => { lastKey = ''; requestRender(); };
  on.addEventListener('change', () => { skyState.enabled = on.checked; changed(); });
  hour.addEventListener('input', () => {
    skyState.hour = Number(hour.value) / 60;
    if (hourOut) hourOut.textContent = hourText(skyState.hour);
    changed();
  });
  season.addEventListener('change', () => { skyState.dayOfYear = Number(season.value); changed(); });
  bright.addEventListener('input', () => {
    skyState.brightness = Number(bright.value) / 100;
    changed();
  });
  if (shadow) {
    shadow.checked = skyState.shadows;
    shadow.addEventListener('change', () => { skyState.shadows = shadow.checked; changed(); });
  }
})();

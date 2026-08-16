// =============================================================================
// rooftext — 街の屋根を1枚のスクリーンに見立てて、入力した文字を流す。
//
//   注目地点まわり ROOF_TEXT_SIZE[m] 四方を1枚のスクリーンとみなし、その絵を
//   【真上からの平行投影】で建物の屋根面だけに貼る。黒地に白文字。
//
//   ★ 動き方（2行送り・電光掲示板と同じ向き）
//     文字は【右から左】へ流れる。1行目の左端まで行った文字は、そのまま2行目の
//     右端に現れて続きを流れる。
//     ⚠️ 逆向き（左から右）にすると、文字列が右から順に現れることになり
//       文として読めない。流す向きは必ず読む向きと逆にすること。
//
//     仕掛けは「1行ぶんの帯テクスチャを、行ごとに1画面ぶんずらして読む」だけ。
//     帯の座標を σ、画面内の横位置を x(0..1)、流れの進み具合を s とすると
//         1行目（上）… σ = x + s
//         2行目（下）… σ = x + s - 1     ← 1画面ぶん手前を読む
//     ある文字（σ 固定）の画面位置は x = σ - s なので、s が増えると左へ動く。
//     上の行の左端(x=0)で消えるのは s = σ のとき、下の行の右端(x=1)に現れるのも
//     s = σ のときで一致する＝繋がって見える。
//     スナップショットでは上の行が σ∈[s, s+1]、下の行が σ∈[s-1, s] なので
//     上のほうが「後の文」になる。文は上の行を読んでから下の行へ続く。
//
//     ⚠️ 帯の周期は【必ず2画面ぶん以上】にすること。1画面ちょうどにすると
//       「1画面ずらし」がテクスチャの繰り返し1周と同じになり、上下の行が
//       まったく同じ絵になってしまう（実際にそうなった）。
//
//   ★ 文字の大きさは固定
//     文が長くなっても文字は小さくしない。帯を長く（2画面 → 4画面 → …）して、
//     そのぶん流れる時間が延びる形にしている。
//
//   ★ 屋根と壁の見分け方
//     PLATEAU の CityGML は屋根(RoofSurface)と壁(WallSurface)を意味的に持つが、
//     3D Tiles(b3dm) へ変換された時点でその区別は【失われている】。実測すると
//     1メッシュ＝1マテリアル・geometry.groups は 0 で、batchTable の属性も
//     建物単位（面単位の情報は無い）。
//     代わりに法線で判別できる。読み込み済みの全建物で法線Yを面積で重み付けして
//     数えると、-1.0（底面 29.5万m²）/ 0.0（壁 239万m²）/ +0.7〜1.0（屋根 211万m²）
//     にきれいに三峰分離し、中間の曖昧な帯は全体の 0.2% 以下だった。
//     ＝ normal.y > ROOF_TEXT_NORMAL_MIN のひとつで実用上十分に切り分けられる。
//
//   ★ ジオメトリは一切いじらない
//     屋根メッシュを結合したり UV を作り直したりはしない。既存の建物マテリアルへ
//     onBeforeCompile でシェーダを差し込み、フラグメント側で
//     「ワールド座標XZ → スクリーンUV」を計算して色を混ぜるだけ。
//     このため【描画コールも三角形数も増えない】（実測: 101fps を維持）。
//
//   依存の向き: core / config / section に依存する（tiles からは
//   setRoofTextHook 経由で呼び返してもらう＝循環参照にしない）。
// =============================================================================
import { THREE, el, focusLocal, requestRender } from './core.js';
import {
  ROOF_TEXT_SIZE, ROOF_TEXT_ROWS, ROOF_TEXT_HEIGHT_RATIO, ROOF_TEXT_SPEED,
  ROOF_TEXT_NORMAL_MIN, ROOF_TEXT_DEFAULT,
} from './config.js';
import { clipMeshes } from './section.js';
import { setRoofTextHook } from './tiles.js';

const roofTextState = {
  enabled: false,
  text: ROOF_TEXT_DEFAULT,
};

// =========================================================================
// 帯テクスチャ（黒地に白文字を【1行だけ】）
// =========================================================================
//   ★ 2行ぶんを1枚に描くのではなく、1行の帯を用意してシェーダ側で行ごとに
//     ずらして読む。こうしないと「上の行から下の行へ繋がる」動きが作れない。
//   ★ 帯の長さは「画面幅の偶数倍」。文が長ければ 2→4→6 画面ぶんと伸ばす
//     （文字の大きさは変えない）。
const ROW_PX = 256;                                   // 帯1本の高さ[px]（= SIZE/ROWS m ぶん）
const SCREEN_PX = ROW_PX * ROOF_TEXT_ROWS;            // 画面幅1つぶんの px（縦横の縮尺を合わせる）
const MAX_SCREENS = 16;                               // 帯の長さの上限（= 8192px）
const FONT_PX = Math.round(ROW_PX * ROOF_TEXT_HEIGHT_RATIO);

const canvas = document.createElement('canvas');
canvas.height = ROW_PX;
canvas.width = SCREEN_PX * 2;                         // 最短でも2画面ぶん
const ctx = canvas.getContext('2d');

const texture = new THREE.CanvasTexture(canvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.wrapS = THREE.RepeatWrapping;      // 横は無限に繋げる
texture.wrapT = THREE.ClampToEdgeWrapping; // 縦は1行ぶんしか無いので繰り返さない
texture.anisotropy = 4;

// 帯が何画面ぶんの長さか。シェーダに渡して σ → テクスチャUV の換算に使う。
let stripScreens = 2;

function drawTile() {
  const text = (roofTextState.text || '').trim() || ROOF_TEXT_DEFAULT;

  // 文字は固定サイズ。文の長さに応じて【帯のほうを伸ばす】。
  ctx.font = `bold ${FONT_PX}px system-ui, sans-serif`;
  const textW = Math.max(1, ctx.measureText(text).width);

  // 帯の長さは画面幅の偶数倍。
  //   ⚠️ 2画面ちょうどにしてはいけない。上下2行で見える範囲は合計ちょうど2画面ぶんなので、
  //     周期が2だと文が常にどこかに映っていて【消えて出直す】間ができない。
  //     4画面以上にすると「上の行→下の行と流れ切って一度消え、また上の行に現れる」
  //     というループになる（1文字が見えている長さは常に2画面ぶん、残りは休み）。
  //   ⚠️ 1画面ちょうども不可。「1画面ずらし」がテクスチャの繰り返し1周と同じになり、
  //     上下の行がまったく同じ絵になってしまう。
  const MIN_SCREENS = 4;
  stripScreens = Math.max(MIN_SCREENS, Math.ceil(textW / SCREEN_PX / 2) * 2);
  if (stripScreens > MAX_SCREENS) stripScreens = MAX_SCREENS;
  const stripW = stripScreens * SCREEN_PX;

  if (canvas.width !== stripW) canvas.width = stripW;  // ※ 代入でキャンバスは初期化される
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, stripW, ROW_PX);

  // ★ 文は帯に【1回だけ】描く。繰り返し描くと、短い文のときに同じ言葉が
  //   画面のあちこちに同時に出てしまい、流れているというより模様に見える。
  //   1回だけにすれば「文が1つ、ぐるりと回ってくる」というループになる。
  ctx.font = `bold ${FONT_PX}px system-ui, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, 0, ROW_PX / 2);
  uStrip.value = stripScreens;
  texture.needsUpdate = true;
}

// =========================================================================
// 建物マテリアルへの差し込み
// =========================================================================
//   ★ uniform は【1つの入れ物を全マテリアルで共有】する。こうしておけば
//     流れる位置や投影範囲の更新が、材質の数によらず1回の代入で済む。
const uProjMap = { value: texture };
const uBoxMin = { value: new THREE.Vector2() };
const uBoxSize = { value: ROOF_TEXT_SIZE };
const uScroll = { value: 0 };
const uStrip = { value: 2 };   // 帯の長さ[画面幅]
const uOn = { value: 0 };      // 0=素通し / 1=投影する（マテリアルを外さずに切り替える）

drawTile();

const ROWS_F = ROOF_TEXT_ROWS.toFixed(1);
const TOP_ROW_F = (ROOF_TEXT_ROWS - 1).toFixed(1);

function patchMaterial(mat) {
  if (!mat || mat.__roofTextPatched) return;
  mat.__roofTextPatched = true;
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    shader.uniforms.uRoofMap = uProjMap;
    shader.uniforms.uRoofBoxMin = uBoxMin;
    shader.uniforms.uRoofBoxSize = uBoxSize;
    shader.uniforms.uRoofScroll = uScroll;
    shader.uniforms.uRoofStrip = uStrip;
    shader.uniforms.uRoofOn = uOn;
    shader.vertexShader = 'varying vec3 vRoofWPos;\nvarying vec3 vRoofWNrm;\n' + shader.vertexShader
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vRoofWNrm = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vRoofWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader =
      'uniform sampler2D uRoofMap;\nuniform vec2 uRoofBoxMin;\nuniform float uRoofBoxSize;\n' +
      'uniform float uRoofScroll;\nuniform float uRoofStrip;\nuniform float uRoofOn;\n' +
      'varying vec3 vRoofWPos;\nvarying vec3 vRoofWNrm;\n' + shader.fragmentShader
      .replace('#include <dithering_fragment>',
        `#include <dithering_fragment>
         if (uRoofOn > 0.5) {
           // 上を向いている面だけ（境目は少しぼかして、勾配屋根の縁がギザつかないように）
           float up = smoothstep(${(ROOF_TEXT_NORMAL_MIN - 0.1).toFixed(2)}, ${ROOF_TEXT_NORMAL_MIN.toFixed(2)}, vRoofWNrm.y);
           vec2 puv = (vRoofWPos.xz - uRoofBoxMin) / uRoofBoxSize;
           if (up > 0.0 && puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0) {
             // ★ このアプリは +X=西 なので、そのまま貼ると文字が鏡像になる。
             //   反転して「x が増える＝画面の右」に揃える。
             float x = 1.0 - puv.x;
             // 何行目か（+Z=北＝画面の上なので、値が大きいほど上の行）
             float rowF = puv.y * ${ROWS_F};
             float rowIdx = floor(rowF);
             float vIn = fract(rowF);
             // ★ 下の行は帯の1画面ぶん【手前】を読む。
             //   上の行の左端で消えた文字が、下の行の右端に現れて続く。
             float back = (rowIdx > ${TOP_ROW_F} - 0.5) ? 0.0 : 1.0;
             float sigma = x + uRoofScroll - back;
             vec4 c = texture2D(uRoofMap, vec2(sigma / uRoofStrip, vIn));
             gl_FragColor.rgb = mix(gl_FragColor.rgb, c.rgb, up);
           }
         }`);
  };
  // パッチ前後で同じプログラムを使い回されないようにキーを分ける
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|roofText';
  mat.needsUpdate = true;
}

// 1タイル（modelScene）ぶんの建物マテリアルにシェーダを差し込む。
function applyToModel(modelScene) {
  if (!roofTextState.enabled) return;   // 使っていない間は触らない（無駄な再コンパイルを避ける）
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) patchMaterial(m);
  });
}
setRoofTextHook(applyToModel);

// 読み込み済みの建物すべてに差し込む（機能をONにした瞬間に使う）。
function patchAllLoaded() {
  for (const mesh of clipMeshes) {
    if (mesh.__clipIsTerrain || !mesh.material) continue;   // 地形の上向き面には出さない
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) patchMaterial(m);
  }
}

// =========================================================================
// 流れの更新
// =========================================================================
//   ★ 文字は描き直さず、読み出す位置（uRoofScroll）をずらすだけ。
//   ★ 投影範囲は注目地点に追従させる（建物タイルが読まれているのはその周りだけなので、
//     範囲を原点に固定すると移動先で何も出なくなる）。
let lastMs = 0;
function updateRoofText(nowMs) {
  if (!roofTextState.enabled) return;
  const dt = lastMs ? Math.min((nowMs - lastMs) / 1000, 0.1) : 0;
  lastMs = nowMs;
  uBoxMin.value.set(focusLocal.x - ROOF_TEXT_SIZE / 2, focusLocal.z - ROOF_TEXT_SIZE / 2);
  // σ = x + uScroll を裏返すと x = σ - uScroll。つまり uScroll を【増やす】と
  // 帯の各文字は画面の左へ動く（＝右から左へ流れる＝電光掲示板と同じ向き）。
  //   値が際限なく増えると精度が落ちるので、帯1周ぶん（stripScreens）で巻き戻す。
  uScroll.value += ROOF_TEXT_SPEED * dt;
  if (uScroll.value >= stripScreens) uScroll.value -= stripScreens;
  requestRender();
}

function setRoofTextEnabled(on) {
  roofTextState.enabled = !!on;
  uOn.value = roofTextState.enabled ? 1 : 0;
  if (roofTextState.enabled) {
    patchAllLoaded();
    lastMs = 0;
  }
  syncUI();
  requestRender();
}

function setRoofText(text) {
  roofTextState.text = text;
  drawTile();
  requestRender();
}

// =========================================================================
// UI（建物パネルの中）
// =========================================================================
let ui = null;
function syncUI() {
  if (!ui) return;
  ui.body.style.display = roofTextState.enabled ? '' : 'none';
}

(function setupUI() {
  const onCb = el('roofTextOn');
  if (!onCb) return;   // この画面に屋根テキストUIが無い構成でも動くように
  ui = { body: el('roofTextBody'), input: el('roofTextInput') };
  ui.input.value = roofTextState.text;
  onCb.addEventListener('change', () => setRoofTextEnabled(onCb.checked));
  ui.input.addEventListener('input', () => setRoofText(ui.input.value));
  syncUI();
})();

export { roofTextState, setRoofTextEnabled, setRoofText, updateRoofText };

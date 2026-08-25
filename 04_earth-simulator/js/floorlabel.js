// =============================================================================
// floorlabel — 仮想フロアの床面に「+15.0 m ／ 6階相当」を貼る。
//
//   見せ方は streetnames.js（路面の通り名）とそろえる＝【路面標示】方式。
//     ① 文字は視線を横切る向きに読ませ、文字の上を【奥】へ向ける → 正立して見える
//     ② 奥へ大きく引き伸ばす（逆遠近）→ 浅い角度で潰れるぶんを先に相殺する
//   道路と違うのは「向きの基準」だけ。通りには伸びる向きがあるが、床にはないので、
//   【今見ている向き】を奥とする（向きを変えたら貼り直す）。
//
//   ★ 床は平らなので、地形のように節ごとの高さを測る必要はない。高さは床の高さで一定。
//   ★ 帯が床からはみ出さないよう、節ごとに「そこに床があるか」を確かめて、
//     途切れたところで打ち切る（吹き抜けや外周の外へ文字がはみ出さない）。
//
//   依存の向き: core だけ。呼び出し側（streetview）から必要な値を受け取る。
// =============================================================================
import { THREE, scene, camera } from './core.js';

// ---- 見せ方の寸法 ----------------------------------------------------------
// ★ 置き場所は【キャラクターの足元】。しかも足元から【カメラ側】へ伸ばす。
//   ⚠️ 通り名と同じように「前方 2.5〜7m」へ置いてはいけない。部屋は道路より狭く、
//     文字の大半が壁の外へ出て見切れる（実測でそうなった）。
//   ★ 足元からカメラ寄りに置くと三つ得がある。
//     ・カメラに近いぶん画面上で大きい
//     ・キャラクターは帯より奥にいるので、体で隠れない
//     ・床の中央付近なので、狭い床でもはみ出しにくい
const BLOCK_W = 3.6;         // 文字の横幅[m]
const BAND_LEN = 3.6;        // 帯の奥行き[m]
// ★ 手前端は【画面の下端に切られない距離】から決める。
//   ⚠️ 足元からの距離で決めてはいけない。カメラは足元の 2m ほど上にあるので、
//     足元のすぐ手前は画面の下へ外れる（実測で、帯の頂点18個のうち16個が画面外）。
//     見下ろし角 ＋ 画角の半分 が「画面の下端が地面に当たる角度」なので、そこから
//     少し内側（EDGE_MARGIN）を手前端にすれば必ず入る。
const EDGE_MARGIN = 0.72;    // 画角の半分のうち、どこまで端に寄せるか（小さいほど内側）
const D_MIN = 1.0, D_MAX = 15;   // 手前端の下限・上限[m]
const LIFT = 0.06;           // 床から浮かせる高さ[m]（床スラブ自身が +0.03）
const SEG_N = 8;             // 逆遠近の分割数

// -----------------------------------------------------------------------------
// 文字のテクスチャ（上段＝高さ／下段＝階）
// -----------------------------------------------------------------------------
const TEX_W = 512, TEX_H = 288;
const BAND_Y = 152;
const texCache = new Map();
const TEX_CACHE_MAX = 16;
const FONT = (px) => 'bold ' + px + 'px "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';

function fitFont(ctx, text, px, maxW) {
  ctx.font = FONT(px);
  const w = ctx.measureText(text).width;
  if (w > maxW) { px = Math.max(40, Math.floor(px * maxW / w)); ctx.font = FONT(px); }
  return px;
}

function makeTexture(topText, bottomText) {
  const key = topText + '|' + bottomText;
  const cached = texCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = TEX_W; canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#ffffff';

  const draw = (text, px, y) => {
    const size = fitFont(ctx, text, px, TEX_W * 0.92);
    ctx.lineWidth = Math.max(6, size * 0.09);
    ctx.strokeText(text, TEX_W / 2, y);
    ctx.fillText(text, TEX_W / 2, y);
  };
  draw(topText, 116, BAND_Y / 2);
  draw(bottomText, 92, (BAND_Y + TEX_H) / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (texCache.size >= TEX_CACHE_MAX) {
    const oldest = texCache.keys().next().value;
    texCache.get(oldest).dispose();
    texCache.delete(oldest);
  }
  texCache.set(key, tex);
  return tex;
}

// -----------------------------------------------------------------------------
// 帯（短冊）。頂点数は固定なので、位置だけ書き換えて使い回す。
// -----------------------------------------------------------------------------
let mesh = null, geom = null, mat = null;
const _fwd = new THREE.Vector3();

function ensureMesh() {
  if (mesh) return;
  geom = new THREE.BufferGeometry();
  const n = (SEG_N + 1) * 2;
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  const idx = [];
  for (let k = 0; k <= SEG_N; k++) {
    const v = k / SEG_N;
    uv[(k * 2) * 2] = 0;     uv[(k * 2) * 2 + 1] = v;
    uv[(k * 2 + 1) * 2] = 1; uv[(k * 2 + 1) * 2 + 1] = v;
    if (k < SEG_N) {
      const a = k * 2, b = k * 2 + 1, c = (k + 1) * 2, d = (k + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.95, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 996;      // 床（994）と稜線（995）より手前
  mesh.visible = false;
  mesh.raycast = () => {};     // 飾りなので、どのレイキャストにも当てない
  scene.add(mesh);
}

/* 床のラベルを出す。
     stand … 足元（床の上の立ち位置）
     yaw   … 見ている向き[rad]（+Z=北 / +X=西 のワールド）
   ★ 呼ばれたら【必ず描く】。床からはみ出すかどうかで消したりしない
     （消えるくらいなら少しはみ出すほうがよい、という判断）。
   ⚠️ 位置は毎フレーム更新する。足元に置くので、1m でも遅れると足からずれて見える。
     計算は頂点18個ぶんの四則演算だけなので、毎フレームでも負荷にならない。 */
export function updateFloorLabel(stand, yaw, topText, bottomText) {
  ensureMesh();
  const tex = makeTexture(topText, bottomText);
  if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }

  // 見ている向き（水平）を「奥」とする。読む向きは 奥 × Y（鏡文字にならない向き）。
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const rx = -dz, rz = dx;

  // 画面の下端が床に当たる距離を出し、その少し奥を帯の手前端にする。
  camera.getWorldDirection(_fwd);
  // 見下ろしを正とする角度。★見上げているときは負のまま使う（0で止めない）。
  //   見上げると床は画面の下へ逃げるので、そのぶん帯を奥へ置かないと入らない。
  const pitchDown = -Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
  const halfFov = (camera.fov * Math.PI / 180) / 2;
  const eyeH = Math.max(0.6, camera.position.y - stand.y);
  const angle = Math.min(1.4, Math.max(0.08, pitchDown + halfFov * EDGE_MARGIN));
  const dNear = Math.min(D_MAX, Math.max(D_MIN, eyeH / Math.tan(angle)));
  const dFar = dNear + BAND_LEN;

  // 逆遠近（1/D を等間隔に刻む）＝テクスチャの各行が画面上で同じ高さに写る。
  const pos = geom.getAttribute('position');
  const half = BLOCK_W / 2;
  const y = stand.y + LIFT;
  const cxCam = camera.position.x, czCam = camera.position.z;
  for (let k = 0; k <= SEG_N; k++) {
    const t = k / SEG_N;
    const d = 1 / ((1 - t) / dNear + t / dFar);
    const cx = cxCam + dx * d, cz = czCam + dz * d;
    pos.setXYZ(k * 2, cx - rx * half, y, cz - rz * half);
    pos.setXYZ(k * 2 + 1, cx + rx * half, y, cz + rz * half);
  }
  pos.needsUpdate = true;
  geom.computeBoundingSphere();
  mesh.visible = true;
}

export function hideFloorLabel() {
  if (mesh) mesh.visible = false;
}

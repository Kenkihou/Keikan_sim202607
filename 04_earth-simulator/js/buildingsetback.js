// =============================================================================
// buildingsetback — 選んだ建物を、決めた鉛直面より外側だけ削る（壁面後退）。
//
//   高さの上げ下げ（buildingedit.js）に対して、こちらは水平方向の操作。
//
//   【面の決め方】
//     選択した建物群をまとめて囲む箱を作り、その4つの側面を候補として出す。
//     切りたい面をクリックで選び、ギズモ（移動・回転）で位置と角度を決める。
//     削られるのは常に【箱の外側】で、面を内側へ押し込むほど深く削れる。
//
//   【基準線】
//     まず面を道路境界線などに合わせて「ここを基準線に」で 0m を決める。
//     以後は面を動かすたびに、そこから何メートル後退したかが数字で出る。
//     手で道路に合わせてから後退距離を詰める、という進め方に合わせたもの。
//
//   【まとめて選ぶ】
//     確定した対象群は buildingedit 側に登録され、あとで群の1棟を選び直すだけで
//     群ごと選ばれる（後退距離の直しを楽にするため）。
//     ⚠️ 選択を固定するわけではない。別の建物を選ぶのも解除するのも自由で、
//       「選ばれたのが群の一員なら仲間も連れてくる」だけ。
//
//   【なぜ頂点を動かさないのか — 前回の失敗から】
//     以前「線の片側だけ高さを変える」機能を、対象建物の三角形を独立メッシュへ
//     取り出して作り直す方式で実装したが、モデルが崩れる不具合が出て取り下げた。
//     原因は、元のジオメトリを潰して別メッシュで置き換える手順の多さにある
//     （同じ建物が複数タイル・複数LODに居る／タイルは絶えず入れ替わる）。
//
//     そこで今回は【元のジオメトリの座標を一切触らない】。やることは2つだけ:
//       ① その頂点が「削る対象の建物か」を 0/1 で示す属性を1本足す
//       ② 断片シェーダで、対象かつ後退面の外側なら discard する
//     座標も面の構成も元のままなので、崩れようがない。属性を消せば元通りになる。
//     高さ色分けが頂点属性方式を採っている（tiles.js）のと同じ考え方。
//
//   【切り口の見え方】
//     建物マテリアルは side=DoubleSide で、裏面を灰色に塗る細工（makeInteriorCap）が
//     既に入っている。discard で穴を開けると、その奥にある内側の面が裏面として
//     描かれるので、箱庭で切ったときと同じ灰色の切り口に見える。
//     つまり切り口専用の面を張らなくても、断面として読める。
//
//   【床面積】
//     削れた平面積 × 階数。平面積は「三角形を水平面へ落とし、後退面の外側だけを
//     切り出した投影面積」の合計。階数と階高の決め方は buildingedit.js と揃える。
// =============================================================================
import {
  THREE, scene, el, camera, controls, renderer, requestRender, markSectionDirty,
} from './core.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  computeClipMeshWorld, keepFinestLod, CAP_COLOR, buildingClipPlanes,
  setSetbackTriClip, clipMeshes,
} from './section.js';
import { wardTiles, getTerrainTiles, setBuildingSetbackHook } from './tiles.js';
import {
  editState, gmlIndexOf, floorHeightOf, registerSelectionGroup, clearSelectionGroup,
  setSetbackBusy, setSetbackStepHooks, setStep, clearSelection,
  columns, setColumnHook,
} from './buildingedit.js';

// =============================================================================
// 後退セット — 「1か所ぶんの壁面後退」をひとまとまりにしたもの
//
//   ★ 街の何か所かで別々に後退を検討したいので、後退は【複数持てる】。
//     以前は平面を1枚だけシェーダへ渡す作りで、2か所目を始めると1か所目が消えた。
//   1セット = { 対象の建物群, 後退面, 基準線, 後退距離 }。
//   ⚠️ 同じ建物が複数のセットに属してよい（角地で2方向から下げる場合）。
//     だから「建物 → セット」は1対1ではなく、ビットの集合で持つ。
// =============================================================================
//   シェーダへ渡せる面の数。頂点属性にビットで詰めるので、float が正確に表せる
//   範囲（2^24）より十分小さく取る。8か所あれば検討には足りる。
const MAX_SETBACKS = 8;

let nextSetbackId = 1;
/* 1セットぶんの入れ物を作る。 */
function makeSetbackSet(targetIds) {
  return {
    id: nextSetbackId++,
    targets: new Set(targetIds),
    line: null,       // { ax, az, bx, bz } 面が通る水平線
    offset: 0,        // その線を法線方向へずらす量[m]
    side: 1,          // どちら側を削るか（+1 / -1）
    baseline: null,   // { x, z, nx, nz } 後退の起点（道路境界線など）
    distance: NaN,    // 基準線から何メートル後退したか
    // ★ 対象建物の属性（階数・高さ）の控え。
    //   確定したあとは選択が外れるので、editState.selection からは引けなくなる。
    //   床面積の集計に必要なので、確定した時点でこちらへ写しておく。
    info: new Map(),  // gmlId -> { storeys, height, measuredHeight }
  };
}

// 効いている後退セット。先頭から順に、シェーダの面スロット 0,1,2… に対応する。
const setbackSets = [];
// いま調整中のセット（setbackSets の要素そのもの）。確定すると null に戻る。
let draftSet = null;

/* 互換のための窓口。savestate.js など外から「いま調整中の1件」を見るために残す。
   ⚠️ これ自体は状態を持たない。実体は draftSet。 */
const setbackState = {
  get line() { return draftSet ? draftSet.line : null; },
  set line(v) { if (draftSet) draftSet.line = v; },
  get offset() { return draftSet ? draftSet.offset : 0; },
  set offset(v) { if (draftSet) draftSet.offset = v; },
  get side() { return draftSet ? draftSet.side : 1; },
  set side(v) { if (draftSet) draftSet.side = v; },
  get baseline() { return draftSet ? draftSet.baseline : null; },
  set baseline(v) { if (draftSet) draftSet.baseline = v; },
  get distance() { return draftSet ? draftSet.distance : NaN; },
  set distance(v) { if (draftSet) draftSet.distance = v; },
  get active() { return setbackSets.length > 0; },
};

/* いま調整中のセットの対象建物。UI と savestate が読む。 */
const targets = {
  get size() { return draftSet ? draftSet.targets.size : 0; },
  clear() { if (draftSet) draftSet.targets.clear(); },
  add(id) { if (draftSet) draftSet.targets.add(id); },
  has(id) { return draftSet ? draftSet.targets.has(id) : false; },
  [Symbol.iterator]() {
    return (draftSet ? draftSet.targets : new Set())[Symbol.iterator]();
  },
};

/* 後退の対象になっている建物すべて（全セットの和）。 */
function allTargetIds() {
  const out = new Set();
  for (const set of setbackSets) for (const id of set.targets) out.add(id);
  return out;
}

// シェーダへ渡す面。xyz=法線（水平）, w=定数。スロットの数は固定で、
// 使っていないスロットは法線ゼロ＝「削らない」を意味する
// （dot(0,p)+0 = 0 で判定式 `< 0.0` が常に偽になり、無効化に分岐が要らない）。
const setbackPlanesUniform = {
  value: Array.from({ length: MAX_SETBACKS }, () => new THREE.Vector4(0, 0, 0, 0)),
};
const setbackCountUniform = { value: 0 };

// 属性を書いたジオメトリを覚えておく（消すときに使う）。
const markedGeoms = new Set();

// -----------------------------------------------------------------------------
// 平面
// -----------------------------------------------------------------------------
/* セットの後退面を作る。戻り値は { nx, nz, c } で、
   削る側が nx*x + nz*z + c < 0 になる向き。 */
function computePlaneOf(set) {
  const L = set && set.line;
  if (!L) return null;
  let dx = L.bx - L.ax, dz = L.bz - L.az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  dx /= len; dz /= len;
  // 水平な法線（線に直交）。side で向きを入れ替える。
  const nx = -dz * set.side, nz = dx * set.side;
  // 線を法線方向へ offset だけずらした位置を通る面
  const px = L.ax + nx * set.offset, pz = L.az + nz * set.offset;
  return { nx, nz, c: -(nx * px + nz * pz) };
}

/* いま調整中のセットの面。 */
function computePlane() { return computePlaneOf(draftSet); }

/* 三角形を、その建物に効いている後退面の「残る側」だけに切り取る。
   箱庭の断面（section.js）から呼ばれる。
     戻り値 null … 削る面が無いのでそのまま使ってよい
            []   … まるごと削られた
            [[9個の座標], …] … 残った部分を三角形に分けたもの
   ⚠️ 凸多角形を順に切っていく（Sutherland–Hodgman）。面は鉛直なので
     判定は水平座標だけで足り、高さは補間で付いてくる。 */
function clipTriBySetback(mask, ax, ay, az, bx, by, bz, cx2, cy, cz2) {
  let poly = [ax, ay, az, bx, by, bz, cx2, cy, cz2];
  let cut = false;
  for (let i = 0; i < setbackSets.length && i < MAX_SETBACKS; i++) {
    if (Math.floor(mask / Math.pow(2, i)) % 2 < 1) continue;   // このセットの対象ではない
    const p = computePlaneOf(setbackSets[i]);
    if (!p) continue;
    cut = true;
    const out = [];
    const n = poly.length / 3;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const x0 = poly[k * 3], y0 = poly[k * 3 + 1], z0 = poly[k * 3 + 2];
      const x1 = poly[j * 3], y1 = poly[j * 3 + 1], z1 = poly[j * 3 + 2];
      const d0 = p.nx * x0 + p.nz * z0 + p.c;
      const d1 = p.nx * x1 + p.nz * z1 + p.c;
      if (d0 >= 0) out.push(x0, y0, z0);
      if ((d0 >= 0) !== (d1 >= 0)) {
        const t = d0 / (d0 - d1);
        out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t);
      }
    }
    poly = out;
    if (poly.length < 9) return [];   // 何も残らなかった
  }
  if (!cut) return null;
  // 残った凸多角形を扇状に三角形へ分ける
  const tris = [];
  const n = poly.length / 3;
  for (let k = 1; k + 1 < n; k++) {
    tris.push([
      poly[0], poly[1], poly[2],
      poly[k * 3], poly[k * 3 + 1], poly[k * 3 + 2],
      poly[(k + 1) * 3], poly[(k + 1) * 3 + 1], poly[(k + 1) * 3 + 2],
    ]);
  }
  return tris;
}
setSetbackTriClip(clipTriBySetback);

/* 全セットの面を uniform へ流す。 */
function syncPlaneUniform() {
  for (let i = 0; i < MAX_SETBACKS; i++) {
    const p = i < setbackSets.length ? computePlaneOf(setbackSets[i]) : null;
    if (p) setbackPlanesUniform.value[i].set(p.nx, 0, p.nz, p.c);
    else setbackPlanesUniform.value[i].set(0, 0, 0, 0);
  }
  setbackCountUniform.value = Math.min(setbackSets.length, MAX_SETBACKS);
  requestRender();
}

// -----------------------------------------------------------------------------
// シェーダ（対象かつ面の外側なら描かない）
// -----------------------------------------------------------------------------
//   ⚠️ 建物マテリアルには既に makeInteriorCap（裏面を灰色に）とフェードの改造が
//     入っている。置き換えず【連結】すること。customProgramCacheKey も必ず添える
//     （無いと、同じ設定の別マテリアルとシェーダプログラムが混線しうる）。
function applySetbackShader(m) {
  if (m.__setbackPatched) return;
  m.__setbackPatched = true;
  const ownKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')
    ? m.customProgramCacheKey : null;
  m.customProgramCacheKey = function () {
    return 'setback|' + (ownKey ? ownKey.call(this) : '');
  };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function (shader, rendererRef) {
    if (prev) prev.call(this, shader, rendererRef);
    shader.uniforms.uSetbackPlanes = setbackPlanesUniform;
    shader.uniforms.uSetbackCount = setbackCountUniform;
    // --- 頂点側: どのセットに属するかのビットと、判定に使うワールド座標を渡す
    //   ⚠️ ワールド座標は自前で出す。three の worldPosition は影の設定しだいで
    //     定義されないことがあるため、あるものとして書くと環境によって壊れる。
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float _setback;
        varying float vSetbackMask;
        varying vec3 vSetbackWorld;`)
      .replace('#include <project_vertex>', `
        vSetbackMask = _setback;
        vSetbackWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        #include <project_vertex>`);
    // --- 断片側: 属しているセットのどれか1つでも外側なら捨てる
    //   色を決める前に捨てる（後だと無駄な計算をしてから捨てることになる）。
    //   ⚠️ ビットの取り出しは整数演算ではなく mod で行う。整数ビット演算は
    //     GLSL ES 3.00 でしか使えず、WebGL1 に落ちた環境でコンパイルが通らない。
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uSetbackPlanes[ ${MAX_SETBACKS} ];
        uniform int uSetbackCount;
        varying float vSetbackMask;
        varying vec3 vSetbackWorld;`)
      .replace('#include <clipping_planes_fragment>', `
        if ( vSetbackMask > 0.5 ) {
          for ( int si = 0; si < ${MAX_SETBACKS}; si ++ ) {
            if ( si >= uSetbackCount ) break;
            float bit = mod( floor( vSetbackMask / pow( 2.0, float( si ) ) ), 2.0 );
            if ( bit > 0.5 &&
                 dot( uSetbackPlanes[ si ].xyz, vSetbackWorld )
                   + uSetbackPlanes[ si ].w < 0.0 ) discard;
          }
        }
        #include <clipping_planes_fragment>`);
  };
  m.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// 頂点属性（この頂点は削る対象か）
// -----------------------------------------------------------------------------
/* gmlId → 属するセットのビット和。
   ★ 毎タイルで作り直すと無駄なので、セットが変わったときだけ組み直す。 */
let maskIndex = new Map();
function rebuildMaskIndex() {
  maskIndex = new Map();
  for (let i = 0; i < setbackSets.length && i < MAX_SETBACKS; i++) {
    const bit = Math.pow(2, i);
    for (const gmlId of setbackSets[i].targets) {
      maskIndex.set(gmlId, (maskIndex.get(gmlId) || 0) + bit);
    }
  }
}

/* 1タイルぶんの属性を書く。対象が1棟も居なければ属性は作らない。 */
function markModelScene(modelScene) {
  const index = gmlIndexOf(modelScene);
  if (!index.size) return;
  // このタイルに居る対象建物の batchid → ビット
  const wanted = new Map();
  for (const [gmlId, bits] of maskIndex) {
    const b = index.get(gmlId);
    if (b !== undefined) wanted.set(b, bits);
  }
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry;
    const pos = g.attributes.position, bid = g.attributes._batchid;
    if (!pos) return;
    // ★ 属性は「対象が居るタイル」にだけ作る。全タイルに作ると頂点あたり4バイトが
    //   街ぜんたいぶん無駄になる（高さ色分けの色属性が12バイトで10MB使っている）。
    if (!wanted.size && !g.attributes._setback) return;
    let attr = g.attributes._setback;
    if (!attr) {
      attr = new THREE.BufferAttribute(new Float32Array(pos.count), 1);
      g.setAttribute('_setback', attr);
      markedGeoms.add(g);
    }
    const arr = attr.array;
    for (let i = 0; i < pos.count; i++) {
      arr[i] = bid ? (wanted.get(bid.getX(i)) || 0) : 0;
    }
    attr.needsUpdate = true;
    // シェーダはこのメッシュのマテリアルに当てる
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m) applySetbackShader(m);
  });
}

/* 嵩上げの赤い柱にも、建物と同じ「どのセットに属するか」を書き込む。
   ★ 柱は建物1棟につき1メッシュなので、全頂点が同じビットでよい。
   ⚠️ 柱を切らないと、建物だけ削れて赤い柱が空中に残る。 */
function markColumn(mesh, gmlId) {
  if (!mesh || !mesh.geometry) return;
  const g = mesh.geometry;
  const pos = g.attributes.position;
  if (!pos) return;
  const bits = maskIndex.get(gmlId) || 0;
  let attr = g.attributes._setback;
  if (!attr || attr.count !== pos.count) {
    attr = new THREE.BufferAttribute(new Float32Array(pos.count), 1);
    g.setAttribute('_setback', attr);
    markedGeoms.add(g);
  }
  attr.array.fill(bits);
  attr.needsUpdate = true;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) if (m) applySetbackShader(m);
}

// 柱ができた瞬間にも当てる（そのときの maskIndex を使う）
setColumnHook(markColumn);

/* 読み込み済みの全タイルへ当て直す。 */
function markAll() {
  rebuildMaskIndex();
  for (const t of wardTiles) t.forEachLoadedModel(markModelScene);
  for (const [gmlId, mesh] of columns) markColumn(mesh, gmlId);
}

// タイルが届くたびに当て直す（タイルは絶えず入れ替わるため）
setBuildingSetbackHook((modelScene) => {
  if (!setbackSets.length) return;
  markModelScene(modelScene);
});

// -----------------------------------------------------------------------------
// 削れた床面積
// -----------------------------------------------------------------------------
/* 多角形の符号付き面積（水平面）。 */
function polygonArea(poly) {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return a / 2;
}

/* 多角形を「nx*x + nz*z + c >= 0」の側（＝残る側）だけに切り取る。
   ⚠️ 複数の後退が重なる建物では、削れた量を面ごとに足してはいけない。
     同じ場所を二度数えてしまう（角地で2方向から下げると顕著）。
     残る側は【すべての面の内側の共通部分】＝凸領域なので、順に切っていけば
     厳密に求まる。削れた量は「元の面積 − 残った面積」で出す。 */
function clipPolygonToInside(poly, nx, nz, c) {
  const out = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly[i * 2], z0 = poly[i * 2 + 1];
    const x1 = poly[j * 2], z1 = poly[j * 2 + 1];
    const d0 = nx * x0 + nz * z0 + c;
    const d1 = nx * x1 + nz * z1 + c;
    const in0 = d0 >= 0, in1 = d1 >= 0;
    if (in0) out.push(x0, z0);
    if (in0 !== in1) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    }
  }
  return out;
}

/* 削れる平面積[㎡]を測る。gmlId ごとに返す。
   ★ 測り方は buildingedit.js の底面積と同じ考え（三角形の水平投影を向きごとに
     合計し、大きいほうを採る）。違うのは、削れて無くなる分だけを取り出す点。
   ⚠️ 同じ建物が複数タイル（LOD違い）に居るので、三角形数がいちばん多い
     ＝最も細かい表現のものを採る（足すと二重に数える）。 */
const _saW = new THREE.Matrix4();
function measureCutArea() {
  const out = new Map();   // gmlId -> 面積
  if (!setbackSets.length) return out;
  // 建物ごとに、その建物へ効いている面を集めておく
  const planesOf = new Map();   // gmlId -> [{nx,nz,c}, ...]
  for (const set of setbackSets) {
    const p = computePlaneOf(set);
    if (!p) continue;
    for (const gmlId of set.targets) {
      if (!planesOf.has(gmlId)) planesOf.set(gmlId, []);
      planesOf.get(gmlId).push(p);
    }
  }
  if (!planesOf.size) return out;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      for (const gmlId of planesOf.keys()) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.set(b, gmlId);
      }
      if (!wanted.size) return;
      const acc = new Map();      // gmlId -> { up, dn, tris }
      const updatedRoots = new Set();
      modelScene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
        if (!pos || !bid) return;
        if (!computeClipMeshWorld(mesh, _saW, updatedRoots)) return;
        const idx = g.index ? g.index.array : null;
        const triCount = (idx ? idx.length : pos.count) / 3;
        for (let f = 0; f < triCount; f++) {
          const i0 = idx ? idx[f * 3] : f * 3;
          const i1 = idx ? idx[f * 3 + 1] : f * 3 + 1;
          const i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
          const gmlId = wanted.get(bid.getX(i0));
          if (gmlId === undefined) continue;
          A.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(_saW);
          B.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(_saW);
          C.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(_saW);
          const tri = [A.x, A.z, B.x, B.z, C.x, C.z];
          // 残る側＝効いている面すべての内側。順に切っていけば共通部分になる。
          let kept = tri;
          for (const p of planesOf.get(gmlId)) {
            if (kept.length < 6) break;
            kept = clipPolygonToInside(kept, p.nx, p.nz, p.c);
          }
          const whole = polygonArea(tri);
          const rest = kept.length < 6 ? 0 : polygonArea(kept);
          // 削れた分＝元 − 残り。符号は元の三角形の向きに合わせて数える。
          const s = whole - rest;
          let a = acc.get(gmlId);
          if (!a) { a = { up: 0, dn: 0, tris: 0 }; acc.set(gmlId, a); }
          a.tris++;
          if (s > 0) a.up += s; else a.dn -= s;
        }
      });
      for (const [gmlId, a] of acc) {
        const cur = out.get(gmlId);
        const area = Math.max(a.up, a.dn);
        if (!cur || cur.tris < a.tris) out.set(gmlId, { area, tris: a.tris });
      }
    });
  }
  const areas = new Map();
  for (const [gmlId, v] of out) areas.set(gmlId, v.area);
  return areas;
}

/* 確定済みセットが控えている、その建物の属性。 */
function infoOfTarget(gmlId) {
  for (const set of setbackSets) {
    const v = set.info.get(gmlId);
    if (v) return v;
  }
  return null;
}

/* 削れた床面積[㎡]の合計。階数は buildingedit と同じ決め方（属性→実測→3m仮定）。 */
function measureCutFloorArea() {
  const areas = measureCutArea();
  let total = 0, assumed = false;
  const per = new Map();
  for (const [gmlId, area] of areas) {
    // 選択が外れていてもセットの控えから引ける（確定後の集計のため）
    const info = editState.selection.get(gmlId) || infoOfTarget(gmlId) || {};
    const fh = floorHeightOf(info);
    // その建物の高さ ÷ 階高 ＝ 階数。削るのは全層なので、階数ぶんの床が消える。
    const h = Number.isFinite(info.measuredHeight) ? info.measuredHeight : NaN;
    const floors = Number.isFinite(h) && h > 0 ? h / fh.h : NaN;
    const fa = Number.isFinite(floors) ? area * floors : NaN;
    if (fh.assumed) assumed = true;
    if (Number.isFinite(fa)) total += fa;
    per.set(gmlId, { area, floors, floorArea: fa });
  }
  return { total, per, assumed };
}

// -----------------------------------------------------------------------------
// セットの出し入れ
// -----------------------------------------------------------------------------
/* 新しい後退セットを始める。いま選択中の建物が対象になる。
   ★ この時点で setbackSets へ入れてしまう。プレビューと確定済みで別の仕組みを
     持つと、面を動かすたびに2通りの経路を通ることになって食い違う。
     やめたときは removeSet で取り除けばよい。 */
function beginSetbackSet() {
  if (setbackSets.length >= MAX_SETBACKS) {
    return { ok: false, reason: `後退は同時に ${MAX_SETBACKS} か所までです` };
  }
  if (!editState.selection.size) return { ok: false, reason: '建物が選ばれていません' };
  draftSet = makeSetbackSet(editState.selection.keys());
  captureInfo(draftSet);
  setbackSets.push(draftSet);
  return { ok: true };
}

/* 対象建物の属性を控える（確定後に選択が外れても集計できるように）。 */
function captureInfo(set) {
  for (const [gmlId, info] of editState.selection) {
    if (!set.targets.has(gmlId)) continue;
    set.info.set(gmlId, {
      storeys: info.storeys, height: info.height, measuredHeight: info.measuredHeight,
    });
  }
}

/* セットを取り除く。 */
function removeSet(set) {
  const i = setbackSets.indexOf(set);
  if (i < 0) return;
  setbackSets.splice(i, 1);
  if (draftSet === set) draftSet = null;
  refreshSetbacks();
}

/* いま選んでいる建物に関わるセットを全部取り除く。 */
function removeSetsOfSelection() {
  const ids = new Set(editState.selection.keys());
  for (const set of [...setbackSets]) {
    for (const id of set.targets) {
      if (ids.has(id)) { removeSet(set); break; }
    }
  }
}

/* 全部取り消して元に戻す。 */
function clearSetback() {
  setbackSets.length = 0;
  draftSet = null;
  refreshSetbacks();
}

/* 面・属性・断面・断面図を、いまのセット一式に合わせて作り直す。
   ★ セットを足した・消した・面を動かした、のどれでもここを通す。
     経路を1本にしておかないと、どれかの更新を書き忘れる。 */
function refreshSetbacks() {
  markAll();          // 頂点属性（どのセットに属するか）
  syncPlaneUniform(); // シェーダへ渡す面
  rebuildCaps();      // 切り口の面
  markSectionDirty(); // 箱庭・縦断図
  requestRender();
}

// -----------------------------------------------------------------------------
// 調整中のセットへの操作
// -----------------------------------------------------------------------------
/* 後退面のもとになる線を決める（ワールド座標の2点）。 */
function setSetbackLine(ax, az, bx, bz) {
  if (!draftSet) return;
  draftSet.line = { ax, az, bx, bz };
  syncPlaneUniform();
}

/* 線からずらす量[m]。正で削る側が広がる。 */
function setSetbackOffset(m) {
  if (!draftSet) return;
  draftSet.offset = Number(m) || 0;
  syncPlaneUniform();
}

/* どちら側を削るか入れ替える。 */
function flipSetbackSide() {
  if (!draftSet) return;
  draftSet.side *= -1;
  syncPlaneUniform();
}

/* 面を動かしたあとの作り直し（対象は変えない）。 */
function reapplyCurrent() {
  if (draftSet) refreshSetbacks();
}

/* いま調整中のセットを確定する。 */
function applySetback() {
  if (!draftSet) return { ok: false, reason: '後退の面が決まっていません' };
  if (!draftSet.targets.size) return { ok: false, reason: '建物が選ばれていません' };
  if (!draftSet.line) return { ok: false, reason: '後退面が決まっていません' };
  // 基準線と後退距離は、候補面が片付く前にここで控える
  if (faceState.baseline) draftSet.baseline = { ...faceState.baseline };
  const d0 = setbackDistance();
  if (Number.isFinite(d0)) draftSet.distance = d0;
  captureInfo(draftSet);
  const done = draftSet;
  draftSet = null;          // 確定＝調整対象から外れる
  refreshSetbacks();
  const fa = measureCutFloorArea();
  return { ok: true, 棟数: done.targets.size, 削れた床面積: fa.total, 内訳: fa.per };
}

/* 確定済みセットの後退距離をあとから直す。
   ★ 基準線と向きはセットが覚えているので、距離だけ与えれば面を置き直せる。
     引き直さずに「6mを7mに」といった微調整ができるようにするため。 */
function setDistanceOfSet(set, d) {
  const b = set && set.baseline;
  const p = computePlaneOf(set);
  if (!b || !p || !Number.isFinite(d)) return false;
  // ★ 内側（建物が残る側）は【面の法線そのもの】。computePlaneOf は
  //   「削る側が負」になる向きで法線を返すので、法線方向へ進めば必ず内側になる。
  //   基準線の法線 b.n は引いたときの向き次第で裏返っていることがあり、
  //   そちらを使うと後退の向きが反転する。
  // ⚠️ 面に沿った向きの取り方で、線から出る法線の符号が変わる。
  //   computePlaneOf は線の方向 (dx,dz) から n = (-dz, dx)*side を作るので、
  //   u = (nz, -nx) にしないと法線が裏返り、削る側が入れ替わる。
  //   （u = (-nz, nx) にしていたため、距離を変えるたびに削りが反転して
  //     面積が 0 と全体を行き来していた。）
  const ux = p.nz, uz = -p.nx;
  const px = b.x + p.nx * d, pz = b.z + p.nz * d;
  set.line = { ax: px - ux * 300, az: pz - uz * 300, bx: px + ux * 300, bz: pz + uz * 300 };
  set.offset = 0;
  // ★ 念のため向きを検算して、ずれていたら側を入れ替える。
  //   取り方を1か所間違えるだけで「削る側が反転する」という分かりにくい壊れ方を
  //   するので、結果そのものを確かめてから確定させる。
  const after = computePlaneOf(set);
  if (after && (after.nx * p.nx + after.nz * p.nz) < 0) set.side *= -1;
  set.distance = d;
  refreshSetbacks();
  return true;
}

// =============================================================================
// 切り口を塞ぐ（断面の面を張る）
//
//   discard で削るだけだと、建物の内側が覗けてしまう（裏面が灰色に塗られるので
//   「塞がっているように」は見えるが、面としては開いている）。切り口に実物の面を張る。
//
//   【なぜ輪郭をループに繋がないのか】
//     箱庭の断面（section.js）は「交線をループに繋ぎ、三角形分割して張る」方式で、
//     あちらは実績がある。同じやり方を最初に試したが、この用途では破綻した。
//     ⚠️ PLATEAU の建物は【底面が無い】ので、切り口の輪郭は必ず開いたループになる。
//       それを両端直結で閉じる方式は建物の形しだいで自己交差し、
//       triangulateShape は自己交差した輪郭でも例外を投げずに三角形を取りこぼす。
//       実測: 112 通りの切り方のうち 42 通り（37%）で断面に穴が空いた。
//       タイルをまたいだ重複を除いても割合は変わらず、判定でふるい分けても
//       「一見成功して局所だけ破綻する」ものが残る。
//
//   【採った方法 — 走査線で塗る】
//     高さを細かく刻み、その高さで交線を横切る点を並べ、
//     【偶数番目から奇数番目までが建物の内側】として帯を塗る。
//     交差の回数だけで内外が決まるので、線分が断片化していても、順番がばらばらでも、
//     自己交差していても、そもそも閉じていなくても正しく塗れる。
//     輪郭が刻み幅ぶんギザつくのが唯一の欠点だが、刻みを十分細かくすれば見えない。
// =============================================================================
const capStats = { segs: 0, tris: 0 };

const capGroup = new THREE.Group();
scene.add(capGroup);
const capMat = new THREE.MeshStandardMaterial({
  color: CAP_COLOR, metalness: 0.0, roughness: 0.9, side: THREE.DoubleSide,
  clippingPlanes: buildingClipPlanes,   // 箱庭表示のときは建物と同じ箱で切る
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, // 壁とのZ争い防止
});

/* 三角形1枚と後退面の交線を (u,v) で out に積む。
   plane = { nx, nz, c }、u軸 = (ux,uz)（面に沿った水平の単位ベクトル）。 */
//   ⚠️ 交点は【必ず量子化してから積む】こと。
//     隣り合う三角形は辺を共有するので交点も一致するはずだが、辺をたどる向きが
//     逆だと t = d0/(d0-d1) の計算順序が変わり、浮動小数の誤差でごく僅かにずれる。
//     ずれると走査線が拾う交点が本来より1つ多くなったり少なくなったりして、
//     内外の判定（偶数番目から奇数番目まで）が入れ替わり、帯が抜ける。
//     1mm に丸めれば誤差は必ず吸収され、建物の断面としては十分な精度が残る。
const CUT_Q = 1000;
const qz = (v) => Math.round(v * CUT_Q) / CUT_Q;
// 頂点がちょうど面の上に乗っているとみなす幅[m]
const ON_PLANE_EPS = 1e-6;

function triCutSegment(ax, ay, az, bx, by, bz, cx2, cy, cz2, plane, ux, uz, out) {
  const { nx, nz, c } = plane;
  const da = nx * ax + nz * az + c;
  const db = nx * bx + nz * bz + c;
  const dc = nx * cx2 + nz * cz2 + c;
  const pts = [];
  const put = (x, y, z) => pts.push(qz(x * ux + z * uz), qz(y));   // (u,v) に落とす
  const edge = (x0, y0, z0, d0, x1, y1, z1, d1) => {
    const on0 = Math.abs(d0) < ON_PLANE_EPS, on1 = Math.abs(d1) < ON_PLANE_EPS;
    // ★ 辺が丸ごと面の上に乗っている場合。その辺そのものが交線になる。
    //   これを拾わないと、面と平行な壁のところで輪郭が途切れる。
    if (on0 && on1) { put(x0, y0, z0); put(x1, y1, z1); return; }
    if (on0) { put(x0, y0, z0); return; }        // 端点が面の上＝そこが交点
    if (on1) { put(x1, y1, z1); return; }
    if ((d0 < 0) === (d1 < 0)) return;           // 同じ側＝またがない
    const t = d0 / (d0 - d1);
    put(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t);
  };
  edge(ax, ay, az, da, bx, by, bz, db);
  edge(bx, by, bz, db, cx2, cy, cz2, dc);
  edge(cx2, cy, cz2, dc, ax, ay, az, da);
  if (pts.length < 4) return;
  // 端点が面上だと同じ点を2回拾うことがある。長さゼロの線分は輪郭を繋ぐ邪魔になる。
  if (Math.abs(pts[0] - pts[2]) < 1 / CUT_Q && Math.abs(pts[1] - pts[3]) < 1 / CUT_Q) return;
  out.push(pts[0], pts[1], pts[2], pts[3]);
}

// 塗り潰しの帯の高さ[m]。細かいほど輪郭がなめらかになるが三角形が増える。
const SCAN_STEP = 0.12;

/* 交線を「繋がずに」塗り潰す。戻り値は (u,v) の三角形リスト。
   ★ 輪郭をループに繋ぐのを諦めた場合の受け皿。高さを細かく刻み、その高さで
     交線を横切る点を並べ、【偶数番目から奇数番目までが建物の内側】として帯を塗る。
     交差の回数で内外を決めるので、線分が断片化していても、順番がばらばらでも、
     自己交差していても正しく塗れる。閉じている必要すらない。
   ⚠️ 代わりに輪郭が刻み幅ぶんギザつくので、輪郭方式が成功したときはそちらを使う。 */
function fillByScanline(segs, uLo = -Infinity, uHi = Infinity) {
  let vMin = Infinity, vMax = -Infinity;
  for (let i = 1; i < segs.length; i += 2) {
    if (segs[i] < vMin) vMin = segs[i];
    if (segs[i] > vMax) vMax = segs[i];
  }
  if (!Number.isFinite(vMin) || vMax - vMin < 1e-6) return [];
  const out = [];
  const xs = [];
  for (let v = vMin; v < vMax; v += SCAN_STEP) {
    const vMid = v + SCAN_STEP / 2;
    xs.length = 0;
    for (let i = 0; i < segs.length; i += 4) {
      const u0 = segs[i], v0 = segs[i + 1], u1 = segs[i + 2], v1 = segs[i + 3];
      // その高さを跨ぐ線分だけ。境界の二重取りを避けるため片側を含めない。
      if ((v0 <= vMid) === (v1 <= vMid)) continue;
      xs.push(u0 + (u1 - u0) * ((vMid - v0) / (v1 - v0)));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const vTop = Math.min(v + SCAN_STEP, vMax);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // ★ 塗る帯だけを他の後退面の内側に縮める。
      //   ⚠️ 交線そのものを切ってはいけない。走査線は「交点の本数の偶奇」で
      //     内外を決めているので、線分を途中で切ると切り口の端点が
      //     余分な交点として数えられ、内外が反転して断面がまるごと消える。
      //     輪郭は元のまま残し、塗る区間だけを狭めるのが正しい。
      const a = Math.max(xs[k], uLo), b = Math.min(xs[k + 1], uHi);
      if (b - a < 1e-4) continue;
      out.push(a, v, b, v, b, vTop, a, v, b, vTop, a, vTop);
    }
  }
  return out;
}

/* 対象建物の三角形を1枚ずつ渡す（ワールド座標）。
   fn(cand, i0, i1, i2, wx, wy, wz) — wx/wy/wz は頂点番号からワールド座標を返す関数。
   ★ 候補は【全タイルぶんを1つにまとめてから】重複を除くこと。
     ⚠️ keepFinestLod はタイルの親子関係で「粗い祖先」を落とす。タイルごとに呼ぶと
       タイルをまたいだ親子が見えないので、同じ建物の粗いLODと細かいLODから
       三角形が【二重に】集まる。断面では走査線の内外判定が狂い、
       独立メッシュでは同じ面が二重に描かれてちらつく。
       箱庭の断面（section.js の buildSectionFill）が clipMeshes 全体に対して
       1回だけ適用しているのと同じ形にする。 */
const _capW = new THREE.Matrix4();
function forEachTargetTriangle(targetIds, fn) {
  const cands = [];
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      // ★ batchId -> gmlId の対応も持たせる（Set ではなく Map）。
      //   分割で「棟ごと」に三角形を仕分けるために、どの棟の三角形かを
      //   呼び出し側へ返す必要がある。
      const wanted = new Map();
      for (const gmlId of targetIds) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.set(b, gmlId);
      }
      if (!wanted.size) return;
      modelScene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        if (!g || !g.attributes.position || !g.attributes._batchid) return;
        if (!computeClipMeshWorld(mesh, _capW, updatedRoots)) return;
        cands.push({ mesh, world: _capW.clone(), tile: mesh.__clipTile, wanted });
      });
    });
  }
  // ★ 嵩上げの柱も混ぜる。柱は建物と地続きの立体なので、切り口も一緒に
  //   塞がないと赤い部分だけ口が開いて見える。
  //   ⚠️ 柱は LOD の選別（keepFinestLod）に混ぜない。タイルの親子関係を持たず、
  //     建物1棟につき1つしかないので、選別に入れると弾かれかねない。
  const columnCands = [];
  for (const [gmlId, mesh] of columns) {
    if (!targetIds.has || !targetIds.has(gmlId)) continue;
    if (!mesh.visible || !mesh.geometry || !mesh.geometry.attributes.position) continue;
    mesh.updateWorldMatrix(true, false);
    columnCands.push({ mesh, world: mesh.matrixWorld.clone(), gmlId });
  }
  for (const cand of [...keepFinestLod(cands), ...columnCands]) {
    const g = cand.mesh.geometry;
    const pos = g.attributes.position, bid = g.attributes._batchid;
    const e = cand.world.elements;
    const idx = g.index ? g.index.array : null;
    const triCount = (idx ? idx.length : pos.count) / 3;
    const wx = (i) => e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12];
    const wy = (i) => e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13];
    const wz = (i) => e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14];
    for (let f = 0; f < triCount; f++) {
      const i0 = idx ? idx[f * 3] : f * 3;
      const i1 = idx ? idx[f * 3 + 1] : f * 3 + 1;
      const i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
      // 柱は 1メッシュ＝1棟なので batchid を持たない。cand.gmlId をそのまま使う。
      const gmlId = cand.gmlId !== undefined
        ? cand.gmlId : cand.wanted.get(bid.getX(i0));
      if (gmlId === undefined) continue;
      fn(cand, i0, i1, i2, wx, wy, wz, gmlId);
    }
  }
}

/* 切り口の面を作り直す。 */
/* この断面の上で、他の後退面に削られずに【残っている】u の範囲を出す。
   ★ 断面は平面の上にあるので、他の面までの距離は u について 1次式になる。
     d(u) = d0 + k*u。これが 0 以上の側が残る側で、k の符号で
     「u がある値以上」か「以下」かが決まる。面が平行なら全域が同じ側。
   複数の面が効いていれば、その共通部分を返す。 */
function keptURange(gmlId, self, ux, uz, px, pz, baseU) {
  let lo = -Infinity, hi = Infinity;
  for (const set of setbackSets) {
    if (set === self || !set.targets.has(gmlId)) continue;
    const p = computePlaneOf(set);
    if (!p) continue;
    const k = p.nx * ux + p.nz * uz;
    const d0 = p.nx * px + p.nz * pz + p.c - baseU * k;
    if (Math.abs(k) < 1e-9) {
      // 面が平行。全域が残る側か、全域が削られた側か。
      if (d0 < 0) return { lo: 0, hi: -1 };   // 空の範囲
      continue;
    }
    const edge = -d0 / k;
    if (k > 0) lo = Math.max(lo, edge);
    else hi = Math.min(hi, edge);
  }
  return { lo, hi };
}

/* 断面の頂点（ワールド座標の三角形リスト）を作る。
   ★ 建物ごとに分けて塗る。走査線は交線の本数の偶奇で内外を決めるので、
     別の建物の交線が混ざると内外が入れ替わってしまう。 */
function buildCapVerts(set, plane) {
  const L = set.line;
  let ux = L.bx - L.ax, uz = L.bz - L.az;
  const ulen = Math.hypot(ux, uz) || 1; ux /= ulen; uz /= ulen;
  // 面上の点 (u,v) をワールドへ戻すための基準点（＝原点から面へ下ろした足）
  const px = -plane.nx * plane.c, pz = -plane.nz * plane.c;
  const baseU = px * ux + pz * uz;

  // 対象建物の三角形を集めて交線を取る（棟ごとに分けて持つ）
  const perBuilding = new Map();   // gmlId -> segs
  forEachTargetTriangle(set.targets, (cand, i0, i1, i2, wx, wy, wz, gmlId) => {
    let segs = perBuilding.get(gmlId);
    if (!segs) { segs = []; perBuilding.set(gmlId, segs); }
    triCutSegment(wx(i0), wy(i0), wz(i0), wx(i1), wy(i1), wz(i1),
      wx(i2), wy(i2), wz(i2), plane, ux, uz, segs);
  });

  const verts = [];
  let nsegs = 0;
  for (const [gmlId, segs] of perBuilding) {
    if (!segs.length) continue;
    nsegs += segs.length / 4;
    const { lo, hi } = keptURange(gmlId, set, ux, uz, px, pz, baseU);
    if (hi - lo < 1e-4) continue;   // 他の後退で丸ごと削られている
    const sv = fillByScanline(segs, lo, hi);
    for (let i = 0; i < sv.length; i += 2) {
      // u はワールドの水平方向、v は高さ。基準点から u 方向へ戻す。
      const uu = sv[i] - baseU;
      verts.push(px + ux * uu, sv[i + 1], pz + uz * uu);
    }
  }
  capStats.segs = nsegs;
  capStats.tris = verts.length / 9;
  return verts;
}

/* 断面のジオメトリを作る。
   ★ 法線は【面の法線で一定】にする。computeVertexNormals は三角形の巻き順から
     法線を出すが、走査線で塗った帯は巻き順が揃わない。すると一部だけ裏を向いて
     照明で暗く落ち、平らな断面に黒い三角形が浮いて見える（実測でこれが起きた）。
     断面は平らなので向きは1つで足り、DoubleSide なので裏から見たときは
     three が法線を反転してくれる。 */
function makeCapGeometry(verts, plane, offset = 0) {
  const geom = new THREE.BufferGeometry();
  // ★ offset は面の法線方向へずらす量[m]。両側の断面がまったく同じ平面に
  //   重なるのを避けるために使う（詳しくは呼び出し側の注記）。
  const pos = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    pos[i] = verts[i] + plane.nx * offset;
    pos[i + 1] = verts[i + 1];
    pos[i + 2] = verts[i + 2] + plane.nz * offset;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nrm = new Float32Array(verts.length);
  for (let i = 0; i < nrm.length; i += 3) { nrm[i] = plane.nx; nrm[i + 2] = plane.nz; }
  geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/* 削りの切り口を、効いているセットぶんまとめて作り直す。
   ⚠️ セットごとに別のメッシュにする。1つに統合すると、片方を消したときに
     もう片方まで作り直すことになり、面を動かすたびの手戻りが大きい。 */
function rebuildCaps() {
  for (const ch of capGroup.children) { clipMeshes.delete(ch); ch.geometry.dispose(); }
  capGroup.clear();
  capStats.segs = 0; capStats.tris = 0;
  let segs = 0, tris = 0;
  for (const set of setbackSets) {
    const plane = computePlaneOf(set);
    if (!plane || !set.targets.size) continue;
    const verts = buildCapVerts(set, plane);
    segs += capStats.segs; tris += capStats.tris;
    if (!verts.length) continue;
    const mesh = new THREE.Mesh(makeCapGeometry(verts, plane), capMat);
    mesh.__setbackSetId = set.id;
    capGroup.add(mesh);
    // ★ 箱庭の断面にもこの切り口を数えさせる。
    //   ⚠️ 登録しないと、後退で削った側の輪郭が開いたままになり、
    //     箱庭の断面（輪郭をループに繋いで面を張る方式）が閉じられない。
    //   ワールド行列はこのメッシュ自身のもので足りる（scene 直下ではないが
    //   capGroup は動かないので、自分を root として登録すれば正しく働く）。
    mesh.__clipRoot = mesh;
    mesh.__clipGroup = capGroup;
    mesh.__clipTile = null;
    mesh.__clipIsTerrain = false;
    mesh.updateWorldMatrix(true, false);
    clipMeshes.add(mesh);
  }
  capStats.segs = segs; capStats.tris = tris;
  requestRender();
}

// =============================================================================
// 面を引く操作（地面を2点クリック）
// =============================================================================
//   ⚠️ pointerdown は buildingedit.js も握っている（建物の選択・高さドラッグ）。
//     面を引いている間はそちらへ渡してはいけないので、【捕捉フェーズ】で受けて
//     stopPropagation する。捕捉フェーズなら、あとから登録した側でも先に受け取れる。
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/* 画面に出ているメッシュだけを集める。
   ⚠️ グループを丸ごと intersectObject に渡してはいけない。3D Tiles は粗い段のタイルも
     読み込んだまま残していて（表示だけ切っている）、Raycaster は visible を見ないので
     それらにも当たる。見えていない面にクリックが吸われる。 */
function collectVisible(root, out) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
    out.push(o);
  });
}

/* 画面座標 → ワールドの点。地形と建物の両方を見て、いちばん手前を採る。 */
function pickPoint(clientX, clientY) {
  const meshes = [];
  const terrain = getTerrainTiles();
  if (terrain && terrain.group) collectVisible(terrain.group, meshes);
  for (const t of wardTiles) if (t.group) collectVisible(t.group, meshes);
  if (!meshes.length) return null;
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hits = _rc.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.clone() : null;
}

// =============================================================================
// 切断面の決め方 — 選択中の建物群の「囲み箱の側面」を1つ選び、ギズモで動かす
//
//   ★ 地面を2点クリックして線を引く方式はやめた。狙った向きに引くのが難しく、
//     建物との位置関係も掴みにくかったため。
//   選択した建物群をまとめて囲む箱を作り、その4つの側面を半透明の板として出す。
//     → 板をクリックすると、その面が切断面になる
//     → ギズモ（移動・回転）で面を動かし、位置と角度を決める
//     → 「後退を確定」で削りを実行し、ギズモを畳む
//   削る向きは常に【箱の内側】。面を内側へ押し込むほど深く削れる。
// =============================================================================
const FACE_COLOR = 0x4ea1ff;        // 候補として出ている側面
const FACE_COLOR_ACTIVE = 0xd8402f; // 選ばれて切断面になった側面

// box    … 選択建物群をまとめた囲み箱（THREE.Box3、ワールド）
// faces  … 候補の4面（THREE.Mesh）
// picked … 選ばれた面の Mesh（null なら未選択）
// handle … ギズモが掴む対象（面の位置と向きだけを持つ空の入れ物）
const faceState = {
  box: null, faces: [], picked: null, handle: null, hover: null,
  // 壁面後退の中の小さな手順。
  //   'face' … 削る面を選ぶ（囲み箱の4側面が出ている）
  //   'base' … ギズモで基準線に合わせて確定する
  //   'move' … 面をドラッグ／数値入力で後退量を決める
  //   'done' … 確定済み（ギズモも面も畳んである）
  //   ⚠️ 基準線を決める場面と後退量を決める場面を分ける。以前は同じ画面で
  //     ギズモ1つに両方をやらせていて、いま何を合わせているのか分からなかった。
  phase: 'face',
  arrows: [],   // 面の中央に出す「削る向き」の矢印
  rotBar: null, // 面の上に立てる回転バー（上下ドラッグで面を回す）
  // ★ 後退の起点となる線（道路境界線などに手で合わせたもの）。
  //   { x, z, nx, nz } … 線が通る点と、その法線（水平）。
  //   これを決めておくと、そこから何メートル後退したかを数字で出せる。
  baseline: null,
};

// 基準線の見せ方（黄色い線）。後退面（赤）と見分けられるようにする。
const BASELINE_COLOR = 0xf4c542;
let baselineMesh = null;

const faceGroup = new THREE.Group();
faceGroup.renderOrder = 5;
scene.add(faceGroup);

/* 選択中の建物すべてを囲む箱（ワールド）。1棟も無ければ null。 */
const _fbW = new THREE.Matrix4();
const _fbV = new THREE.Vector3();
function selectionBox() {
  const ids = new Set(editState.selection.keys());
  if (!ids.size) return null;
  const box = new THREE.Box3();
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Set();
      for (const gmlId of ids) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.add(b);
      }
      if (!wanted.size) return;
      modelScene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
        if (!pos || !bid) return;
        if (!computeClipMeshWorld(mesh, _fbW, updatedRoots)) return;
        for (let i = 0; i < pos.count; i++) {
          if (!wanted.has(bid.getX(i))) continue;
          _fbV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_fbW);
          box.expandByPoint(_fbV);
        }
      });
    });
  }
  return box.isEmpty() ? null : box;
}

function disposeFaces() {
  showFaceHint(null);
  if (faceState.rotBar) {
    // 線と球でマテリアルを共有しているので、後始末は1回だけ
    let mat = null;
    for (const ch of faceState.rotBar.children) { ch.geometry.dispose(); mat = ch.material; }
    if (mat) mat.dispose();
    if (faceState.rotBar.parent) faceState.rotBar.parent.remove(faceState.rotBar);
    faceState.rotBar = null;
  }
  rotDrag = null;
  for (const a of faceState.arrows) {
    a.geometry.dispose();
    a.material.dispose();
    if (a.parent) a.parent.remove(a);
  }
  faceState.arrows = [];
  for (const m of faceGroup.children) { m.geometry.dispose(); m.material.dispose(); }
  faceGroup.clear();
  faceState.faces = [];
  faceState.picked = null;
  faceState.hover = null;
}

/* 候補の4側面を作る。
   ⚠️ 板は箱より少しだけ外へ出しておく。ぴったり同じ位置だと建物の壁と
     深度が拮抗してちらつき、クリックも壁に吸われる。 */
const FACE_MARGIN = 0.5;   // 箱から外へ出す量[m]
function buildFaces() {
  disposeFaces();
  const box = selectionBox();
  faceState.box = box;
  if (!box) { requestRender(); return; }
  const { min, max } = box;
  const cy = (min.y + max.y) / 2, hy = Math.max((max.y - min.y) / 2, 2);
  const midX = (min.x + max.x) / 2, midZ = (min.z + max.z) / 2;
  const halfX = (max.x - min.x) / 2, halfZ = (max.z - min.z) / 2;
  // 各面の中心と、箱の内側を向く法線
  const defs = [
    { cx: min.x - FACE_MARGIN, cz: midZ, half: halfZ, nx: 1, nz: 0 },
    { cx: max.x + FACE_MARGIN, cz: midZ, half: halfZ, nx: -1, nz: 0 },
    { cx: midX, cz: min.z - FACE_MARGIN, half: halfX, nx: 0, nz: 1 },
    { cx: midX, cz: max.z + FACE_MARGIN, half: halfX, nx: 0, nz: -1 },
  ];
  const newFace = (w, h) => {
    const mat = new THREE.MeshBasicMaterial({
      color: FACE_COLOR, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(w, 1), Math.max(h, 1)), mat);
    mesh.frustumCulled = false;
    faceGroup.add(mesh);
    faceState.faces.push(mesh);
    return mesh;
  };
  for (const d of defs) {
    const mesh = newFace(d.half * 2, hy * 2);
    mesh.position.set(d.cx, cy, d.cz);
    // PlaneGeometry は既定で +Z を向くので、法線の向きへ回す
    mesh.rotation.y = Math.atan2(d.nx, d.nz);
    mesh.__faceKind = 'side';
    // ★ その面を押すとどちらへ削れるのかを、面の中央の矢印で見せる。
    //   面を選んでから初めて削れる向きが分かる、では選び直しが増える。
    faceState.arrows.push(makeFaceArrow(mesh, hy));
  }
  // ★ 上面。ここを押すと高さの変更に進む。
  //   ⚠️ 側面と同じ「面を押して決める」入口に揃える。ボタンで選ばせると
  //     囲み箱が出ているのに別の場所を押させることになって、視線が飛ぶ。
  //   ⚠️ 上面は箱より【内側に縮めて】置く。同じ大きさだと、見下ろす角度では
  //     側面の手前に上面が重なり、側面を押したつもりで高さの変更に入ってしまう。
  //     縁を空けておけば、そこを押せば必ず側面が当たる。
  const TOP_SHRINK = 0.72;
  const top = newFace(halfX * 2 * TOP_SHRINK, halfZ * 2 * TOP_SHRINK);
  top.position.set(midX, max.y + FACE_MARGIN, midZ);
  top.rotation.x = -Math.PI / 2;   // 水平に寝かせる（+Z が上を向く）
  top.__faceKind = 'top';
  faceState.arrows.push(makeFaceArrow(top, Math.min(halfX, halfZ) * TOP_SHRINK, ARROW_COLOR_TOP));
  requestRender();
}

/* 面の中央に出す「削る向き」の矢印。面と同じ向きに寝かせた平たい矢。
   ⚠️ 矢印は面の【子】にする。面を動かすと矢印も一緒に動いてほしいし、
     面を捨てるときに消し忘れることもなくなる。 */
const ARROW_COLOR = 0xffd23c;        // 側面＝壁面後退
const ARROW_COLOR_TOP = 0xd8402f;    // 上面＝高さの変更（切断面の赤に合わせる）
function makeFaceArrow(faceMesh, sizeHint, color = ARROW_COLOR) {
  // 矢の長さ[m]。面の高さを基準にする（幅は建物の並びしだいで極端に長くなるため）。
  const L = Math.max(Math.min(sizeHint * 0.9, 22), 6);
  const w = L * 0.16;      // 竿の幅の半分
  const hw = L * 0.42;     // 矢羽根の幅の半分
  const hl = L * 0.45;     // 矢羽根の長さ
  // 面のローカル座標で作る。
  //   ⚠️ 面は mesh.rotation.y = atan2(nx, nz) で「箱の内側の向き」へ回してある。
  //     PlaneGeometry の法線は +Z なので、【+Z が箱の内側】。
  //     矢を -Z へ向けていたため外を指していた。動かす向き＝+Z へ向ける。
  const verts = [
    -w, 0, 0, w, 0, 0, w, 0, (L - hl),
    -w, 0, 0, w, 0, (L - hl), -w, 0, (L - hl),
    -hw, 0, (L - hl), hw, 0, (L - hl), 0, 0, L,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthTest: false,
  });
  const mesh = new THREE.Mesh(g, m);
  // ⚠️ 回転は掛けない。頂点は既に面のローカル XZ 平面（Y=0）で作ってあり、
  //   矢先は +Z ＝【面に直角な内向き】を指している。
  //   ここで X 軸まわりに回していたため、矢が面に沿って倒れて見えていた。
  mesh.renderOrder = 7;
  mesh.frustumCulled = false;
  faceMesh.add(mesh);
  return mesh;
}

/* 基準線を今のギズモ位置で決める。 */
function setBaselineHere() {
  const h = faceState.handle;
  if (!h) return;
  faceState.baseline = {
    x: h.position.x, z: h.position.z,
    nx: Math.sin(h.rotation.y), nz: Math.cos(h.rotation.y),
  };
  // ★ 基準線を確定したらギズモは畳む。ここから先は「面をどれだけ下げるか」
  //   だけの操作で、向きはもう動かさない。ギズモを出したままだと、
  //   基準線ごと動かせてしまい 0m の位置がずれる。
  detachGizmos();
  faceState.phase = 'move';
  updateBaselineMesh();
  syncSetbackUI();
  requestRender();
}

/* ギズモを対象から外して隠す（畳むだけ。面や基準線はそのまま）。 */
function detachGizmos() {
  for (const g of gizmos) {
    g.detach();
    g.enabled = false;
    if (g.getHelper) g.getHelper().visible = false;
  }
}

/* 基準線を消す。 */
function clearBaseline() {
  faceState.baseline = null;
  updateBaselineMesh();
  syncSetbackUI();
}

/* 基準線を線で描く（面と同じ幅・高さで、少しだけ手前に出す）。 */
function updateBaselineMesh() {
  if (baselineMesh) {
    baselineMesh.geometry.dispose();
    baselineMesh.material.dispose();
    scene.remove(baselineMesh);
    baselineMesh = null;
  }
  const b = faceState.baseline;
  if (!b || !faceState.box) { requestRender(); return; }
  const sz = new THREE.Vector3(); faceState.box.getSize(sz);
  const half = Math.max(sz.x, sz.z) * 0.7 + 10;
  // 線に沿った向き（法線に直交）
  const ux = -b.nz, uz = b.nx;
  const y0 = faceState.box.min.y, y1 = faceState.box.max.y;
  const pts = [
    b.x - ux * half, y0, b.z - uz * half,
    b.x + ux * half, y0, b.z + uz * half,
    b.x + ux * half, y1, b.z + uz * half,
    b.x - ux * half, y1, b.z - uz * half,
    b.x - ux * half, y0, b.z - uz * half,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: BASELINE_COLOR, depthTest: false, transparent: true, opacity: 0.9,
  });
  baselineMesh = new THREE.Line(geo, mat);
  baselineMesh.renderOrder = 6;
  baselineMesh.frustumCulled = false;
  scene.add(baselineMesh);
  requestRender();
}

/* 基準線から今の後退面までの距離[m]。基準線が無ければ NaN。
   ★ 符号は「箱の内側へ入った量」を正にする。道路境界線を基準にして
     何メートル下がったかを、そのまま読めるようにするため。 */
function setbackDistance() {
  const b = faceState.baseline, h = faceState.handle, box = faceState.box;
  if (!b || !h || !box) return NaN;
  // 基準線の法線方向に測った、面の移動量
  const d = (h.position.x - b.x) * b.nx + (h.position.z - b.z) * b.nz;
  // 箱の中心が基準線から見てどちら側かで符号を合わせる
  const c = new THREE.Vector3(); box.getCenter(c);
  const toCenter = (c.x - b.x) * b.nx + (c.z - b.z) * b.nz;
  return toCenter >= 0 ? d : -d;
}

/* 後退距離を数値で決める（基準線から d メートル内側へ面を置く）。
   ★ ギズモで詰めるほかに、6m・10m といった決まった値を直接入れたい場面のため。
     向きは基準線のまま変えない。動かすのは法線方向だけ。 */
function setSetbackDistance(d) {
  const b = faceState.baseline, h = faceState.handle, box = faceState.box;
  if (!b || !h || !box || !Number.isFinite(d)) return;
  const c = new THREE.Vector3(); box.getCenter(c);
  const toCenter = (c.x - b.x) * b.nx + (c.z - b.z) * b.nz;
  const sign = toCenter >= 0 ? 1 : -1;   // 内側を正にするための向き合わせ
  h.position.x = b.x + b.nx * d * sign;
  h.position.z = b.z + b.nz * d * sign;
  h.rotation.set(0, Math.atan2(b.nx, b.nz), 0);
  syncPlaneFromHandle();
  syncSetbackUI();
}

/* ギズモが掴む対象。面の板そのものを掴ませると板の大きさに引きずられるので、
   位置と向きだけを持つ空の入れ物を用意して、そちらを動かす。 */
function ensureHandle() {
  if (faceState.handle) return faceState.handle;
  const h = new THREE.Object3D();
  h.visible = false;
  scene.add(h);
  faceState.handle = h;
  return h;
}

/* ギズモの位置・向きから切断面を作る。
   ★ 削る向きは常に【箱の内側】。面を内側へ押し込むほど深く削れる。 */
function syncPlaneFromHandle() {
  const h = faceState.handle, box = faceState.box;
  if (!h || !box) return;
  // 面の法線（水平）と、面に沿った向き（＝切断線の向き）
  //   ⚠️ 線の向きは【法線がそのまま出る取り方】にすること。
  //     computePlaneOf は線の方向 (dx,dz) から n = (-dz, dx)*side を作るので、
  //     u = (nz, -nx) なら n がそっくり戻る。u = (-nz, nx) にすると法線が裏返り、
  //     輪を回すと切断面だけ逆向きに回っていた。その食い違いを「削る側の反転」で
  //     埋め合わせていたため、回している途中で削りが突然裏返り、
  //     狙った角度で止められなかった。
  const nx = Math.sin(h.rotation.y), nz = Math.cos(h.rotation.y);
  const ux = nz, uz = -nx;
  setbackState.offset = 0;
  // ★ 候補の面は【箱の内側】を向けて作ってある（buildFaces の nx,nz）。
  //   その向きを法線にすれば、削られるのは常に法線の裏側＝箱の外側になる。
  //   だから側の入れ替えは要らない。回している間ずっと同じ側が削れる。
  setbackState.side = 1;
  setSetbackLine(h.position.x - ux * 300, h.position.z - uz * 300,
    h.position.x + ux * 300, h.position.z + uz * 300);
  // 選ばれている板も handle に追従させる
  if (faceState.picked) {
    faceState.picked.position.copy(h.position);
    faceState.picked.rotation.y = h.rotation.y;
  }
  // 動かしている間は面（uniform）だけ。重い作り直しは手を離してから。
  if (faceAdjusting) syncPlaneUniform();
  else reapplyCurrent();
  requestRender();
}

/* 面を選ぶ。選んだ面から切断面を決め、ギズモを付ける。 */
function pickFace(mesh) {
  // ★ 面を選んだ時点で新しいセットを立てる。ここから先の面の動きは、
  //   そのセットを直接いじる＝プレビューがそのまま確定内容になる。
  const r = beginSetbackSet();
  if (!r.ok) { setInfo(r.reason); return; }
  faceState.picked = mesh;
  // ★ 壁面後退の作業中は、選択が空になってもパネルの中身を畳ませない
  //   （畳まれると調整の途中で操作先が消えてしまう）。
  setSetbackBusy(true);
  faceState.hover = null;
  // ★ 選ばなかった3面は【消す】。残しておくと、基準線を合わせている最中に
  //   別の面を掴んでしまい、選び直しになってしまう。
  for (const m of [...faceState.faces]) {
    if (m === mesh) continue;
    m.geometry.dispose();
    m.material.dispose();
    faceGroup.remove(m);
  }
  faceState.faces = [mesh];
  faceState.arrows = faceState.arrows.filter((a) => a.parent === mesh);
  faceState.phase = 'base';
  // 面の上に回転バーを立てる（面の高さの半分ぶんを目安に）
  const hy = (faceState.box.max.y - faceState.box.min.y) / 2;
  faceState.rotBar = buildRotBar(mesh, Math.max(hy, 2));
  refreshFaceLook();
  const h = ensureHandle();
  h.position.copy(mesh.position);
  h.rotation.set(0, mesh.rotation.y, 0);
  h.visible = true;
  for (const g of gizmos) {
    g.attach(h);
    g.enabled = true;
    if (g.getHelper) g.getHelper().visible = true;
  }
  // 面の位置から切断面を決める。セットは既に効いているので、これだけで
  // 削りのプレビューが出る（確定はギズモと面を畳むだけ）。
  syncPlaneFromHandle();
  requestRender();
}

// ---- ギズモ（面の移動・回転）------------------------------------------------
//   ⚠️ three r169 以降、TransformControls 自体は Object3D ではなく、
//     getHelper() が返すものを scene に足す（usermodel.js と同じ扱い）。
//   ★ 移動と回転は【同時に出す】。切り替えボタンを押させると、面を動かすたびに
//     モードを行き来することになって手数が増えるため。
//     TransformControls は1つで1モードしか持てないので、2つ用意して同じ対象に付ける。
const gizmoMove = new TransformControls(camera, renderer.domElement);
gizmoMove.setMode('translate');
gizmoMove.showY = false;        // 面は鉛直のまま。上下には動かさない
// ⚠️ 回転は TransformControls の輪を使わない。
//   水平の輪は見る角度によって細い楕円に潰れ、掴んだ点のわずかな動きが
//   大きな角度変化になる。狙った向きで止められず「きれいに回らない」となる。
//   代わりに、面から上へ伸びる【バーを上下にドラッグ】して回す（下の rotBar）。
//   上下の動きは視点の傾きに左右されないので、どこから見ても同じ感触で回せる。
const gizmos = [gizmoMove];
for (const g of gizmos) {
  scene.add(g.getHelper ? g.getHelper() : g);
  g.enabled = false;
  if (g.getHelper) g.getHelper().visible = false;
}
// オンデマンド描画なので、ギズモが見た目を変えたら描画を起こす
for (const g of gizmos) {
  g.addEventListener('change', () => requestRender());
  g.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;   // ドラッグ中はカメラを回さない
    // ⚠️ 掴んでいない方のギズモは止める。2つ重ねているので、
    //   そのままだと掴んでいない側が同じドラッグを拾って二重に動く。
    for (const other of gizmos) if (other !== g) other.enabled = !e.value;
    setFaceAdjusting(e.value);
  });
  g.addEventListener('objectChange', () => { syncPlaneFromHandle(); syncSetbackUI(); });
}

// ---- 回転バー（面から上へ伸びる棒。上下ドラッグで面を回す）--------------------
const ROTBAR_COLOR = ARROW_COLOR;   // 矢印と同じ黄色（後退の道具として揃える）
// 1ピクセル動かすと何度回るか。180度を約300pxに割り当てる。
//   ⚠️ 大きすぎると狙った角度で止められない。ここが操作感の要。
const ROT_DEG_PER_PX = 0.6;

/* 面の中心から上へ伸びる細い線と、その先端の球。
   面の子にしておくと、回した向きにそのまま付いてくる。
   ★ 掴むのは先端の球。線は「どこから伸びているか」を示すだけなので細くてよい。
     球を大きめにしておけば、どの距離からでも掴める。 */
function buildRotBar(faceMesh, halfH) {
  // 面のローカルは X=面に沿う / Y=高さ / Z=法線。原点（面の中心）から上へ。
  const len = halfH + Math.max(halfH * 0.6, 6);   // 線の長さ[m]
  const rad = Math.max(len * 0.010, 0.10);        // 線の太さ[m]
  const knobR = Math.max(len * 0.075, 1.3);       // 先端の球の半径[m]
  const mat = new THREE.MeshBasicMaterial({
    color: ROTBAR_COLOR, transparent: true, opacity: 0.95, depthTest: false,
  });
  const grp = new THREE.Group();
  grp.renderOrder = 8;
  const stemGeo = new THREE.CylinderGeometry(rad, rad, len, 8);
  stemGeo.translate(0, len / 2, 0);
  const stem = new THREE.Mesh(stemGeo, mat);
  stem.frustumCulled = false;
  const knobGeo = new THREE.SphereGeometry(knobR, 20, 14);
  knobGeo.translate(0, len, 0);
  const knob = new THREE.Mesh(knobGeo, mat);
  knob.frustumCulled = false;
  grp.add(stem, knob);
  faceMesh.add(grp);
  return grp;
}

// 回転ドラッグの状態。{ y0, angle0 }
let rotDrag = null;

// 面を動かしている最中かどうか。
//   ★ 動かしている間は【シェーダへ渡す面だけ】を更新する。
//   ⚠️ 頂点属性の書き直し・切り口の作り直し・箱庭断面の作り直しまで毎回やると、
//     1回あたり数百ミリ秒かかってドラッグが追いつかない。輪を回しても角度が飛び、
//     狙った向きで止められなくなる（実際そうなっていた）。
//     重いものは【手を離したとき】にまとめて1回だけ作り直す。
let faceAdjusting = false;
function setFaceAdjusting(on) {
  if (faceAdjusting === !!on) return;
  faceAdjusting = !!on;
  // 動かしている間は切り口を隠す。古い位置に取り残された灰色の面が見えると、
  // どこまで削れるのか却って分からなくなる。
  capGroup.visible = !faceAdjusting;
  if (!faceAdjusting) refreshSetbacks();
  requestRender();
}

/* 面の選択・ギズモを畳む（確定したとき／やめたとき）。 */
function endFaceEditing() {
  // ★ 確定していないセットは捨てる。面を選んだ時点で setbackSets に入れてあるので、
  //   ここで消さないと「やめたはずの後退」が残る。
  if (draftSet) removeSet(draftSet);
  setSetbackBusy(false);
  detachGizmos();
  faceState.phase = 'face';
  faceDrag = null;
  if (faceState.handle) faceState.handle.visible = false;
  disposeFaces();
  faceState.box = null;
  clearBaseline();
  requestRender();
}

/* 面の見た目を今の状態（選択中／カーソルが乗っている／それ以外）に合わせる。 */
function refreshFaceLook() {
  for (const m of faceState.faces) {
    const isPicked = (m === faceState.picked);
    const isHover = (m === faceState.hover);
    m.material.color.setHex(isPicked ? FACE_COLOR_ACTIVE : FACE_COLOR);
    m.material.opacity = isPicked ? 0.34 : (isHover ? 0.42 : 0.18);
  }
  requestRender();
}

/* カーソルが乗っている面を光らせる。
   ⚠️ ギズモを掴んでいる間は当たり判定を取らない。ドラッグ中に面の上を通ると
     光り方が目まぐるしく変わって、掴んでいる軸が分からなくなる。 */
/* 面にカーソルを乗せたときの案内札。押すと何が起きるかを言葉で出す。
   ★ 色を変えるだけでは、側面と上面で行き先が違うことが伝わらない。 */
let hintEl = null;
function showFaceHint(mesh, ev) {
  if (!hintEl) hintEl = el('faceHint');
  if (!hintEl) return;
  if (!mesh) { hintEl.style.display = 'none'; return; }
  const isTop = mesh.__faceKind === 'top';
  hintEl.textContent = isTop ? 'この面で高さを変更する' : 'この面で壁面後退する';
  hintEl.classList.toggle('top', isTop);
  hintEl.style.display = 'block';
  moveFaceHint(ev);
}

function moveFaceHint(ev) {
  if (!hintEl || hintEl.style.display === 'none' || !ev) return;
  // カーソルの右下に少しずらして置く（カーソルの下に隠れないように）
  hintEl.style.left = (ev.clientX + 14) + 'px';
  hintEl.style.top = (ev.clientY + 16) + 'px';
}

function onFaceHover(ev) {
  if (!faceState.faces.length) { showFaceHint(null); return; }
  if (gizmos.some((g) => g.dragging)) { showFaceHint(null); return; }
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hit = _rc.intersectObjects(faceState.faces, false)[0];
  const next = hit ? hit.object : null;
  moveFaceHint(ev);                       // 札は毎回カーソルに付いてくる
  if (next === faceState.hover) return;   // 面が変わったときだけ描き直す
  faceState.hover = next;
  // 面を選んだあと（基準線を合わせる場面）は札を出さない。もう選ぶ場面ではない。
  showFaceHint(faceState.phase === 'face' ? next : null, ev);
  refreshFaceLook();
}

// ---- 面をドラッグして後退量を決める ----------------------------------------
//   ★ 基準線を確定したあとは、面そのものを掴んで動かす。ギズモを出したままだと
//     基準線ごと動かせてしまい、0m の位置がずれる。
//   ⚠️ カーソルの動きは【基準線の法線方向】にだけ効かせる。画面上の自由な動きを
//     そのまま渡すと、面が斜めに逃げて後退距離が読めなくなる。
let faceDrag = null;   // { x0, y0, pos0, vx, vy, len2 }

/* 面を法線方向へ 1m 動かしたとき、画面上で何ピクセル動くか。
   ⚠️ 「カーソルが指す水平面上の点」で測ってはいけない。視線が水平に近づくほど
     交点が遠くへ飛び、数十ピクセルの操作が百メートル単位の移動になる
     （実測でドラッグ 50px が 153m 動いた）。画面上の 1m の長さで割れば、
     見えている大きさのぶんだけ動くので、どの角度から見ても破綻しない。 */
const _fsA = new THREE.Vector3();
const _fsB = new THREE.Vector3();
function faceScreenScale() {
  const b = faceState.baseline, h = faceState.handle;
  if (!b || !h) return null;
  const r = renderer.domElement.getBoundingClientRect();
  _fsA.copy(h.position).project(camera);
  _fsB.set(h.position.x + b.nx, h.position.y, h.position.z + b.nz).project(camera);
  const vx = (_fsB.x - _fsA.x) * r.width / 2;
  const vy = -(_fsB.y - _fsA.y) * r.height / 2;
  // 面を真正面から見ていると 1m が 0px になり、感度が無限大になる。下限で止める。
  const len2 = Math.max(vx * vx + vy * vy, 4);
  return { vx, vy, len2 };
}

// 面のクリック。捕捉フェーズで受けて buildingedit へ渡さない
//   （建物を掴んで高さが変わってしまうため）。
//   ⚠️ 面に当たらなかったときは素通しする。そうしないとカメラ操作ができない。
function onFaceDown(ev) {
  if (!faceState.faces.length || ev.button !== 0) return;
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  // ★ 回転バーが先。面より手前に立っているので、こちらを先に見る。
  if (faceState.rotBar && faceState.handle
      && _rc.intersectObject(faceState.rotBar, true).length) {
    ev.stopPropagation();
    ev.preventDefault();
    rotDrag = { y0: ev.clientY, angle0: faceState.handle.rotation.y };
    setFaceAdjusting(true);
    controls.enabled = false;
    return;
  }
  const hit = _rc.intersectObjects(faceState.faces, false)[0];
  if (!hit) return;
  ev.stopPropagation();
  ev.preventDefault();
  if (faceState.phase === 'face') {
    // ★ 押した面の種類で行き先が決まる。上面＝高さの変更、側面＝壁面後退。
    if (hit.object.__faceKind === 'top') {
      endFaceEditing();      // 囲み箱を畳んでから高さの手順へ
      setStep('height');
      return;
    }
    pickFace(hit.object);
    setStep('setback');
    syncSetbackUI();
    return;
  }
  if (faceState.phase !== 'move') return;   // 基準線を合わせている間はギズモの担当
  const sc = faceScreenScale();
  if (!sc) return;
  faceDrag = { x0: ev.clientX, y0: ev.clientY, pos0: faceState.handle.position.clone(), ...sc };
  setFaceAdjusting(true);
  controls.enabled = false;   // 面を動かしている間はカメラを止める
}

function onFaceDrag(ev) {
  // 回転バーを掴んでいる間は、上下の動きをそのまま角度にする。
  //   ⚠️ 判断材料は画面の上下だけ。カメラをどこへ回しても同じ手触りになる。
  if (rotDrag && faceState.handle) {
    const dy = rotDrag.y0 - ev.clientY;
    faceState.handle.rotation.y = rotDrag.angle0 + dy * ROT_DEG_PER_PX * Math.PI / 180;
    syncPlaneFromHandle();
    syncSetbackUI();
    return;
  }
  if (!faceDrag) return;
  const b = faceState.baseline, h = faceState.handle;
  if (!b || !h) return;
  // カーソルの動きを「法線方向の 1m」に射影して、動かす量[m]を出す
  const dx = ev.clientX - faceDrag.x0, dy = ev.clientY - faceDrag.y0;
  const d = (dx * faceDrag.vx + dy * faceDrag.vy) / faceDrag.len2;
  h.position.x = faceDrag.pos0.x + b.nx * d;
  h.position.z = faceDrag.pos0.z + b.nz * d;
  syncPlaneFromHandle();
  syncSetbackUI();
}

function onFaceUp() {
  if (rotDrag) {
    rotDrag = null;
    setFaceAdjusting(false);   // ここで切り口を作り直す
    controls.enabled = true;
    return;
  }
  if (!faceDrag) return;
  faceDrag = null;
  setFaceAdjusting(false);   // ここで切り口を作り直す
  controls.enabled = true;
}

// =============================================================================
// UI
// =============================================================================
let sbUi = {};
function setInfo(text) { if (sbUi.info) sbUi.info.textContent = text; }

function syncSetbackUI() {
  if (!sbUi.info) return;
  const ph = faceState.phase;
  // 小さな手順ごとに、その場面のものだけ出す
  if (sbUi.stepBase) sbUi.stepBase.style.display = (ph === 'base') ? '' : 'none';
  if (sbUi.stepMove) sbUi.stepMove.style.display = (ph === 'move') ? '' : 'none';

  const dist = setbackDistance();
  if (sbUi.distVal) {
    sbUi.distVal.textContent = Number.isFinite(dist) ? `${dist.toFixed(2)} m` : '— m';
  }
  if (sbUi.distInput && Number.isFinite(dist)
      && document.activeElement !== sbUi.distInput) {
    // 打ち込んでいる最中は上書きしない（打った端から戻ると入力できない）
    sbUi.distInput.value = dist.toFixed(2);
  }

  // 削れた量は結果の要約なので、手順の案内とは分けて1行だけ出す。
  // ★ 合計は【全部の場所ぶん】。1か所ずつ足し合わせるのではなく、建物ごとに
  //   「残る側の共通部分」から出しているので、重なっても二重に数えない。
  const lines = [];
  if (setbackSets.length) {
    const fa = measureCutFloorArea();
    const n = allTargetIds().size;
    lines.push(`${setbackSets.length} か所 ／ ${n} 棟 ／ `
      + `削れた延床 約 ${Math.round(fa.total).toLocaleString('ja-JP')} ㎡`);
    if (fa.assumed) lines.push('※ 階数が無い建物は階高 3m と仮定');
  }
  sbUi.info.textContent = lines.join('\n');
  renderSetbackList();
}

/* 後退した場所の一覧を描き直す。
   ⚠️ 毎回作り直すが、数値入力に触っている最中は差し替えない
     （打っている途中で入力欄が入れ替わると、値が飛んで打てなくなる）。 */
function renderSetbackList() {
  const wrap = sbUi.listWrap, list = sbUi.list;
  if (!wrap || !list) return;
  wrap.style.display = setbackSets.length ? '' : 'none';
  if (!setbackSets.length) { list.innerHTML = ''; return; }
  if (list.contains(document.activeElement)) return;
  list.innerHTML = '';
  setbackSets.forEach((set, i) => {
    const row = document.createElement('div');
    row.className = 'sb-row' + (set === draftSet ? ' sb-draft' : '');
    const no = document.createElement('span');
    no.className = 'sb-no';
    no.textContent = String(i + 1);
    const n = document.createElement('span');
    n.className = 'sb-n';
    n.textContent = `${set.targets.size} 棟`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.5';
    inp.value = Number.isFinite(set.distance) ? set.distance.toFixed(2) : '';
    // 基準線を控えていない場所は、距離だけでは面を置き直せない
    inp.disabled = !set.baseline;
    inp.title = set.baseline ? '後退距離[m]' : '基準線が無いので数値では直せません';
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) setDistanceOfSet(set, v);
    });
    const unit = document.createElement('span');
    unit.className = 'muted';
    unit.style.fontSize = '11px';
    unit.textContent = 'm';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '消す';
    del.addEventListener('click', () => { removeSet(set); syncSetbackUI(); });
    row.append(no, n, inp, unit, del);
    list.appendChild(row);
  });
}

/* 囲み箱の面を出す（buildingedit が手順 'pick' に入るときに呼ぶ）。
   ここで出す面のうち、上面を押せば高さの変更、側面を押せば壁面後退へ進む。 */
function enterSetbackStep() {
  if (!editState.selection.size) { setInfo('先に建物を選んでください'); return; }
  faceState.phase = 'face';
  clearBaseline();
  buildFaces();
  syncSetbackUI();
}

/* 面を選ぶところからやり直す（1か所確定したあと、続けて別の場所をやるため）。 */
function restartFacePick() {
  faceState.phase = 'face';
  clearBaseline();
  buildFaces();
  syncSetbackUI();
}

(function setupSetbackUI() {
  const apply = el('setbackApply');
  if (!apply) return;   // この画面に後退UIが無い構成でも動くように
  sbUi = {
    info: el('setbackInfo'),
    stepBase: el('setbackStepBase'),
    stepMove: el('setbackStepMove'),
    distVal: el('setbackDistVal'), distInput: el('setbackDistInput'),
    listWrap: el('setbackListWrap'), list: el('setbackList'),
  };
  // buildingedit の手順切り替えから、この機能の開始・終了を呼んでもらう
  setSetbackStepHooks(enterSetbackStep, endFaceEditing);

  el('setbackBaseSet').addEventListener('click', () => setBaselineHere());
  sbUi.distInput.addEventListener('input', () => {
    setSetbackDistance(Number(sbUi.distInput.value));
  });
  apply.addEventListener('click', () => {
    const r = applySetback();
    if (!r.ok) { setInfo(r.reason); return; }
    // ★ この対象群を「まとめて扱った群」として覚える。あとで群の1棟を選び直すだけで
    //   群ごと選ばれるので、後退距離の直しがしやすい。選択自体は自由に変えられる。
    registerSelectionGroup();
    // ★ 確定したら【建物を選ぶところ】まで戻す。
    //   面だけ出し直すと、確定した直後に囲み箱がまた現れて
    //   「まだ何か操作させられている」ように見える。次にやることは
    //   たいてい別の建物の検討なので、選択も外して最初の状態に揃える。
    endFaceEditing();
    clearSelection();
    setStep('select');
    syncSetbackUI();
  });
  el('setbackClear').addEventListener('click', () => {
    endFaceEditing();
    // ★ 消すのは【いま選んでいる建物に関わる後退】だけ。他の場所の検討は残す。
    removeSetsOfSelection();
    clearSelectionGroup();
    clearSelection();
    setStep('select');
  });
  el('setbackClearAll').addEventListener('click', () => {
    endFaceEditing();
    clearSetback();
    clearSelectionGroup();
    clearSelection();
    setStep('select');
  });
  // ★ 捕捉フェーズで受ける（buildingedit より先に横取りするため）
  renderer.domElement.addEventListener('pointerdown', onFaceDown, true);
  renderer.domElement.addEventListener('pointermove', onFaceHover);
  renderer.domElement.addEventListener('pointermove', onFaceDrag);
  renderer.domElement.addEventListener('pointerup', onFaceUp);
  renderer.domElement.addEventListener('pointercancel', onFaceUp);
  syncSetbackUI();
})();

/* 毎フレーム呼ぶ軽い見張り（main.js の描画ループから）。
   ★ 建物の選択は buildingedit.js の中だけで変わるので、こちらへ届く通知が無い。
     フックを増やして両者を結ぶよりも、変化を見張るほうが結び付きが浅くて済む。
     ⚠️ 実際に作り直すのは【変わった瞬間だけ】。毎フレーム描き直してはいけない。 */
let lastGuideKey = '';
function updateSetbackGuide() {
  const key = `${editState.selection.size}|${editState.enabled ? 1 : 0}`
    + `|${faceState.faces.length}|${faceState.picked ? 1 : 0}`;
  if (key === lastGuideKey) return;
  lastGuideKey = key;
  // 編集モードを抜けたら候補面もギズモも畳む
  if (!editState.enabled && faceState.faces.length) endFaceEditing();
  syncSetbackUI();
}

export {
  setbackState, targets, faceState,
  setbackSets, MAX_SETBACKS, makeSetbackSet, removeSet, setDistanceOfSet,
  beginSetbackSet, refreshSetbacks, allTargetIds,
  setSetbackLine, setSetbackOffset, flipSetbackSide,
  applySetback, clearSetback, updateSetbackGuide, capStats,
  enterSetbackStep, restartFacePick, endFaceEditing, setBaselineHere, clearBaseline,
  setbackDistance, setSetbackDistance,
  measureCutArea, measureCutFloorArea,
};

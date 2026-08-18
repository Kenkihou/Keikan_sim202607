// =============================================================================
// buildingsetback — 選んだ建物を、引いた鉛直面で切る。切り方は2通り。
//
//   高さの上げ下げ（buildingedit.js）に対して、こちらは水平方向の操作。
//   ユーザーが地面を2点クリックして決めた鉛直面を基準に、
//
//     ① 壁面後退 … 面より外側（道路側）を【削り落とす】。
//        削れた体積に相当する床面積を出す。
//     ② 分割     … 面の【両側とも残し】、側ごとに違う絶対高さへ揃える。
//        こちらは削らないので床面積の増減は buildingedit 側の集計に乗る。
//
//   どちらも同じ面・同じ対象の仕組みを共有しており、排他に切り替わる
//   （同じ建物に両方かけると二重に描かれるため）。
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
import {
  computeClipMeshWorld, keepFinestLod, CAP_COLOR, buildingClipPlanes,
} from './section.js';
import { wardTiles, getTerrainTiles, setBuildingSetbackHook } from './tiles.js';
import { editState, gmlIndexOf, floorHeightOf } from './buildingedit.js';

// 後退面。ワールドの水平面上の直線 (ax,az)→(bx,bz) を通る鉛直面として持つ。
//   offset … その直線を法線方向へずらす量[m]。正で「削る側」が広がる。
//   side   … どちら側を削るか（+1 / -1）。
const setbackState = {
  line: null,       // { ax, az, bx, bz }
  offset: 0,
  side: 1,
  active: false,    // 適用中か
};

// 削る対象の建物（gml_id の集合）。
const targets = new Set();

// シェーダへ渡す平面。xyz=法線（水平）, w=定数。
//   ★ 全建物マテリアルで【同じオブジェクトを共有】する。こうしておけば、
//     平面を動かしたときの更新が1か所で済み、マテリアルの数によらず一定コストになる。
//   ⚠️ 法線がゼロベクトルのときは「削らない」を意味する。dot(0,p)+0 = 0 で、
//     判定式 `< 0.0` が常に偽になるので、無効化のために特別な分岐が要らない。
const setbackPlaneUniform = { value: new THREE.Vector4(0, 0, 0, 0) };

// 属性を書いたジオメトリを覚えておく（消すときに使う）。
const markedGeoms = new Set();

// -----------------------------------------------------------------------------
// 平面
// -----------------------------------------------------------------------------
/* 後退面を作る。戻り値は { nx, nz, c } で、削る側が nx*x + nz*z + c < 0 になる向き。 */
function computePlane() {
  const L = setbackState.line;
  if (!L) return null;
  let dx = L.bx - L.ax, dz = L.bz - L.az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  dx /= len; dz /= len;
  // 水平な法線（線に直交）。side で向きを入れ替える。
  const nx = -dz * setbackState.side, nz = dx * setbackState.side;
  // 線を法線方向へ offset だけずらした位置を通る面
  const px = L.ax + nx * setbackState.offset, pz = L.az + nz * setbackState.offset;
  return { nx, nz, c: -(nx * px + nz * pz) };
}

/* uniform へ反映する。active でなければゼロにして「削らない」状態にする。 */
function syncPlaneUniform() {
  if (splitState.active) {
    // ★ 分割中は元の建物を【丸ごと】消す（両側を独立メッシュで描き直すため）。
    //   法線をゼロ・定数を負にすると判定式 dot(0,p) + (-1) = -1 < 0 が常に成り立ち、
    //   対象の頂点はすべて discard される。
    //   ⚠️ 専用の uniform を別に足す手も試したが、シェーダまで値が届かず
    //     元の建物が消えなかった（実測: 元の建物が手前に描かれ続けた）。
    //     既に確実に効いているこの1本だけで済ませるほうが取りこぼしがない。
    setbackPlaneUniform.value.set(0, 0, 0, -1);
  } else {
    const p = setbackState.active ? computePlane() : null;
    if (p) setbackPlaneUniform.value.set(p.nx, 0, p.nz, p.c);
    else setbackPlaneUniform.value.set(0, 0, 0, 0);
  }
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
    shader.uniforms.uSetbackPlane = setbackPlaneUniform;
    // --- 頂点側: 対象フラグと、判定に使うワールド座標を渡す
    //   ⚠️ ワールド座標は自前で出す。three の worldPosition は影の設定しだいで
    //     定義されないことがあるため、あるものとして書くと環境によって壊れる。
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float _setback;
        varying float vSetbackFlag;
        varying vec3 vSetbackWorld;`)
      .replace('#include <project_vertex>', `
        vSetbackFlag = _setback;
        vSetbackWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        #include <project_vertex>`);
    // --- 断片側: 対象かつ面の外側なら捨てる
    //   色を決める前に捨てる（後だと無駄な計算をしてから捨てることになる）。
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uSetbackPlane;
        varying float vSetbackFlag;
        varying vec3 vSetbackWorld;`)
      .replace('#include <clipping_planes_fragment>', `
        if ( vSetbackFlag > 0.5 &&
             dot( uSetbackPlane.xyz, vSetbackWorld ) + uSetbackPlane.w < 0.0 ) discard;
        #include <clipping_planes_fragment>`);
  };
  m.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// 頂点属性（この頂点は削る対象か）
// -----------------------------------------------------------------------------
/* 1タイルぶんの属性を書く。対象が1棟も居なければ属性は作らない。 */
function markModelScene(modelScene) {
  const index = gmlIndexOf(modelScene);
  if (!index.size) return;
  // このタイルに居る対象建物の batchid
  const wanted = new Set();
  for (const gmlId of targets) {
    const b = index.get(gmlId);
    if (b !== undefined) wanted.add(b);
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
      arr[i] = (bid && wanted.has(bid.getX(i))) ? 1 : 0;
    }
    attr.needsUpdate = true;
    // シェーダはこのメッシュのマテリアルに当てる
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m) applySetbackShader(m);
  });
}

/* 読み込み済みの全タイルへ当て直す。 */
function markAll() {
  for (const t of wardTiles) t.forEachLoadedModel(markModelScene);
}

// タイルが届くたびに当て直す（タイルは絶えず入れ替わるため）
setBuildingSetbackHook((modelScene) => {
  if (!setbackState.active && !splitState.active) return;
  markModelScene(modelScene);
});

// -----------------------------------------------------------------------------
// 削れた床面積
// -----------------------------------------------------------------------------
/* 多角形を「nx*x + nz*z + c < 0」の側だけに切り取る（Sutherland–Hodgman）。
   poly は [x0,z0, x1,z1, ...]。戻り値も同じ並び。 */
function clipPolygonToOutside(poly, nx, nz, c) {
  const out = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly[i * 2], z0 = poly[i * 2 + 1];
    const x1 = poly[j * 2], z1 = poly[j * 2 + 1];
    const d0 = nx * x0 + nz * z0 + c;
    const d1 = nx * x1 + nz * z1 + c;
    const in0 = d0 < 0, in1 = d1 < 0;
    if (in0) out.push(x0, z0);
    if (in0 !== in1) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    }
  }
  return out;
}

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

/* 削れる平面積[㎡]を測る。gmlId ごとに返す。
   ★ 測り方は buildingedit.js の底面積と同じ考え（三角形の水平投影を向きごとに
     合計し、大きいほうを採る）。違うのは、後退面より外側だけを切り出す点。
   ⚠️ 同じ建物が複数タイル（LOD違い）に居るので、三角形数がいちばん多い
     ＝最も細かい表現のものを採る（足すと二重に数える）。 */
const _saW = new THREE.Matrix4();
function measureCutArea() {
  const plane = computePlane();
  const out = new Map();   // gmlId -> 面積
  if (!plane || !targets.size) return out;
  const { nx, nz, c } = plane;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      for (const gmlId of targets) {
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
          const clipped = clipPolygonToOutside(
            [A.x, A.z, B.x, B.z, C.x, C.z], nx, nz, c,
          );
          let a = acc.get(gmlId);
          if (!a) { a = { up: 0, dn: 0, tris: 0 }; acc.set(gmlId, a); }
          a.tris++;
          if (clipped.length < 6) continue;      // 面の外側に何も残らなかった
          const s = polygonArea(clipped);
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

/* 削れた床面積[㎡]の合計。階数は buildingedit と同じ決め方（属性→実測→3m仮定）。 */
function measureCutFloorArea() {
  const areas = measureCutArea();
  let total = 0, assumed = false;
  const per = new Map();
  for (const [gmlId, area] of areas) {
    const info = editState.selection.get(gmlId) || {};
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
// 公開API（段階1ではスクリプトから呼ぶ。UIは次の段階で作る）
// -----------------------------------------------------------------------------
/* 後退面のもとになる線を決める（ワールド座標の2点）。 */
function setSetbackLine(ax, az, bx, bz) {
  setbackState.line = { ax, az, bx, bz };
  syncPlaneUniform();
}

/* いま適用中のもの（削る／分割）を、対象を選び直さずに作り直す。
   ★ 面を引き直した・後退量を変えた・削る側を反転した、のいずれでも呼ぶ。
     どれも「対象は同じまま、面だけが変わった」場面なので、
     建物を選び直させる必要がない。 */
function reapplyCurrent() {
  if (splitState.active) applySplit({ keepTargets: true });
  else if (setbackState.active) applySetback({ keepTargets: true });
}

/* 線からずらす量[m]。正で削る側が広がる。 */
function setSetbackOffset(m) {
  setbackState.offset = Number(m) || 0;
  syncPlaneUniform();
}

/* どちら側を削るか入れ替える。 */
function flipSetbackSide() {
  setbackState.side *= -1;
  syncPlaneUniform();
}

/* いま選択中の建物を対象にして、削りを有効にする。 */
/* keepTargets … true なら【いま適用中の対象をそのまま使う】。
   ★ 後退量や切断面を調整するときに使う。適用したあと建物の選択を外していても、
     対象は targets に控えてあるので選び直さずに済む。
     ⚠️ 選択から作り直してしまうと、選択が空の瞬間に対象がゼロになって
       それまでの削り・分割が消える（実際そうなっていた）。 */
function applySetback({ keepTargets = false } = {}) {
  if (!keepTargets) {
    targets.clear();
    for (const gmlId of editState.selection.keys()) targets.add(gmlId);
  }
  if (!targets.size) return { ok: false, reason: '建物が選ばれていません' };
  if (!setbackState.line) return { ok: false, reason: '後退面が決まっていません' };
  // 分割とは併用しない（同じ建物に両方かけると二重に描かれる）
  if (splitState.active) clearSplit();
  setbackState.active = true;
  markAll();
  syncPlaneUniform();
  rebuildCap();          // 切り口に面を張る
  markSectionDirty();
  const fa = measureCutFloorArea();
  return { ok: true, 棟数: targets.size, 削れた床面積: fa.total, 内訳: fa.per };
}

/* 削りを解除して元に戻す。 */
function clearSetback() {
  setbackState.active = false;
  targets.clear();
  // 属性を 0 で埋め直す（属性そのものは残しても描画に影響しない）
  markAll();
  syncPlaneUniform();
  rebuildCap();          // 切り口の面も消える（active でなくなるため）
  markSectionDirty();
  requestRender();
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
function fillByScanline(segs) {
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
      const a = xs[k], b = xs[k + 1];
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
function forEachTargetTriangle(fn) {
  const cands = [];
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      // ★ batchId -> gmlId の対応も持たせる（Set ではなく Map）。
      //   分割で「棟ごと」に三角形を仕分けるために、どの棟の三角形かを
      //   呼び出し側へ返す必要がある。
      const wanted = new Map();
      for (const gmlId of targets) {
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
  for (const cand of keepFinestLod(cands)) {
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
      const gmlId = cand.wanted.get(bid.getX(i0));
      if (gmlId === undefined) continue;
      fn(cand, i0, i1, i2, wx, wy, wz, gmlId);
    }
  }
}

/* 切り口の面を作り直す。 */
/* 断面の頂点（ワールド座標の三角形リスト）を作る。分割でも使うので分けてある。 */
function buildCapVerts(plane) {
  const L = setbackState.line;
  let ux = L.bx - L.ax, uz = L.bz - L.az;
  const ulen = Math.hypot(ux, uz) || 1; ux /= ulen; uz /= ulen;

  // 対象建物の三角形を集めて交線を取る
  const segs = [];
  forEachTargetTriangle((cand, i0, i1, i2, wx, wy, wz) => {
    triCutSegment(wx(i0), wy(i0), wz(i0), wx(i1), wy(i1), wz(i1),
      wx(i2), wy(i2), wz(i2), plane, ux, uz, segs);
  });
  capStats.segs = segs.length / 4;
  if (!segs.length) { capStats.tris = 0; return []; }

  // 面上の点 (u,v) をワールドへ戻すための基準点（＝原点から面へ下ろした足）
  const px = -plane.nx * plane.c, pz = -plane.nz * plane.c;
  const baseU = px * ux + pz * uz;
  const verts = [];
  const sv = fillByScanline(segs);
  for (let i = 0; i < sv.length; i += 2) {
    // u はワールドの水平方向、v は高さ。基準点から u 方向へ戻す。
    const uu = sv[i] - baseU;
    verts.push(px + ux * uu, sv[i + 1], pz + uz * uu);
  }
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

/* 削り（片側を消す）の切り口を作り直す。 */
function rebuildCap() {
  for (const ch of capGroup.children) ch.geometry.dispose();
  capGroup.clear();
  const plane = computePlane();
  if (!setbackState.active || !plane || !targets.size) { requestRender(); return; }
  const verts = buildCapVerts(plane);
  if (!verts.length) { requestRender(); return; }
  capGroup.add(new THREE.Mesh(makeCapGeometry(verts, plane), capMat));
  requestRender();
}

// -----------------------------------------------------------------------------
// 嵩上げの柱（分割で片側を持ち上げたときに下にできる隙間を埋める）
//
//   buildingedit.js の「1棟ずつ編集」で嵩上げしたときの赤い柱と同じ見た目にする。
//   ★ 柱の平面図形は【底面の輪郭を切断面で片側だけに切ったもの】。
//     切断面で新しくできる辺（柱の切り口）は、輪郭が切断面と交わる点どうしを
//     つないで別途張る。この考え方は以前作った「片側だけ高さを変える」機能
//     （buildingsplit.js。座標を潰す設計が原因で取り下げた）から、柱の輪郭の
//     取り方だけを引き継いでいる。座標を潰す部分は引き継いでいない。
// -----------------------------------------------------------------------------
const COLUMN_BASE_EPS = 0.05;   // 底面の判定に使う許容誤差[m]
const columnMat = new THREE.MeshStandardMaterial({
  color: 0xd8402f, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
  clippingPlanes: buildingClipPlanes,
  // 柱の側面は、持ち上げた建物の壁と【同じ鉛直面】に並ぶ（同じ輪郭から立ち上がるため）。
  // 高さの範囲は接するだけで重ならないが、境界の1本だけは深度が拮抗しうるので少し手前へ。
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});

/* 底面の輪郭（棟ごと）を集める。
   ① 壁の下端の辺（三角形の3頂点のうち2つが底にある）を優先する。
   ② 無ければ、床面キャップ（3頂点とも底）の外周（1回しか現れない辺）で代用する。
     PLATEAU の建物には壁が底まで届かないものが実在するため（実測で確認済み）。
   ★ タイルの走査は1回にまとめ、棟ごとに仕分ける。 */
function buildBaseOutlinesPerBuilding(heightRange) {
  const wallEdgesByBuilding = new Map();    // gmlId -> [[ax,az,bx,bz], ...]
  const floorTrisByBuilding = new Map();    // gmlId -> [[x0,z0,x1,z1,x2,z2], ...]
  forEachTargetTriangle((cand, i0, i1, i2, wx, wy, wz, gmlId) => {
    const hr = heightRange.get(gmlId);
    if (!hr) return;
    const baseY = hr.min;
    const px = [wx(i0), wx(i1), wx(i2)];
    const py = [wy(i0), wy(i1), wy(i2)];
    const pz = [wz(i0), wz(i1), wz(i2)];
    const atBase = [py[0] <= baseY + COLUMN_BASE_EPS, py[1] <= baseY + COLUMN_BASE_EPS,
      py[2] <= baseY + COLUMN_BASE_EPS];
    const n = (atBase[0] ? 1 : 0) + (atBase[1] ? 1 : 0) + (atBase[2] ? 1 : 0);
    if (n === 3) {
      let arr = floorTrisByBuilding.get(gmlId);
      if (!arr) { arr = []; floorTrisByBuilding.set(gmlId, arr); }
      arr.push([px[0], pz[0], px[1], pz[1], px[2], pz[2]]);
    } else if (n === 2) {
      let arr = wallEdgesByBuilding.get(gmlId);
      if (!arr) { arr = []; wallEdgesByBuilding.set(gmlId, arr); }
      for (let e = 0; e < 3; e++) {
        const a = e, b = (e + 1) % 3;
        if (!atBase[a] || !atBase[b]) continue;
        arr.push([px[a], pz[a], px[b], pz[b]]);
      }
    }
  });
  const out = new Map();
  const allGml = new Set([...wallEdgesByBuilding.keys(), ...floorTrisByBuilding.keys()]);
  for (const gmlId of allGml) {
    const wallEdges = wallEdgesByBuilding.get(gmlId);
    if (wallEdges && wallEdges.length) { out.set(gmlId, wallEdges); continue; }
    const floorTris = floorTrisByBuilding.get(gmlId) || [];
    const key = (x, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    const count = new Map();
    for (const t of floorTris) {
      for (let e = 0; e < 3; e++) {
        const ax = t[e * 2], az = t[e * 2 + 1];
        const b = (e + 1) % 3;
        const bx = t[b * 2], bz = t[b * 2 + 1];
        const ka = key(ax, az), kb = key(bx, bz);
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const rec = count.get(k);
        if (rec) rec.n++; else count.set(k, { n: 1, e: [ax, az, bx, bz] });
      }
    }
    const edges = [];
    for (const rec of count.values()) if (rec.n === 1) edges.push(rec.e);
    out.set(gmlId, edges);
  }
  return out;
}

/* 線分 (x0,z0)→(x1,z1) を、面の「残す側」だけに切り取る。
   plane={nx,nz,c}、keepPositive なら nx*x+nz*z+c>=0 の側を残す。 */
function clipSegmentToPlaneSide(x0, z0, x1, z1, plane, keepPositive) {
  const side = (x, z) => plane.nx * x + plane.nz * z + plane.c;
  let s0 = side(x0, z0), s1 = side(x1, z1);
  if (!keepPositive) { s0 = -s0; s1 = -s1; }
  const in0 = s0 > 0, in1 = s1 > 0;
  if (in0 && in1) return { seg: [x0, z0, x1, z1], cross: null };
  if (!in0 && !in1) return { seg: null, cross: null };
  const t = s0 / (s0 - s1);
  const cx = x0 + (x1 - x0) * t, cz = z0 + (z1 - z0) * t;
  return in0 ? { seg: [x0, z0, cx, cz], cross: [cx, cz] } : { seg: [cx, cz, x1, z1], cross: [cx, cz] };
}

/* 1棟ぶんの柱ジオメトリ。dy<=0（上げていない）か輪郭が無ければ null。
   ★ 法線は【押し出した辺ごとに、その面の向きで固定する】。
     ⚠️ computeVertexNormals は三角形の巻き順から法線を出すが、底面の輪郭を
       集めた時点で辺の向きは揃っていない（特に床面キャップの外周から拾った場合）。
       すると隣り合う面どうしで法線が表裏バラバラになり、DoubleSide で描かれても
       明暗だけが交互に変わって【縞模様】に見える。断面で同じ症状に当たったのと同じ理屈。
       押し出した面の法線は「辺に垂直な水平向き」と分かっているので、計算させずに与える。 */
function buildColumnGeometry(edges, baseY, dy, plane, keepPositive) {
  if (dy <= 0 || !edges || !edges.length) return null;
  const out = [];
  const nrm = [];
  const crossings = [];
  /* 辺 (x0,z0)→(x1,z1) を baseY から baseY+dy まで鉛直に押し出す。 */
  const pushWall = (x0, z0, x1, z1) => {
    let nx = -(z1 - z0), nz = (x1 - x0);      // 辺に垂直な水平ベクトル
    const len = Math.hypot(nx, nz);
    if (len < 1e-9) return;                    // 長さゼロの辺は面にならない
    nx /= len; nz /= len;
    out.push(x0, baseY, z0, x1, baseY, z1, x1, baseY + dy, z1);
    out.push(x0, baseY, z0, x1, baseY + dy, z1, x0, baseY + dy, z0);
    for (let k = 0; k < 6; k++) nrm.push(nx, 0, nz);
  };
  for (const [ax, az, bx, bz] of edges) {
    const c = clipSegmentToPlaneSide(ax, az, bx, bz, plane, keepPositive);
    if (c.cross) crossings.push(c.cross);
    if (!c.seg) continue;
    pushWall(c.seg[0], c.seg[1], c.seg[2], c.seg[3]);
  }
  // 切断面で新しくできる辺（柱の切り口）。交点を線に沿って並べ、隣り合う2点ずつを辺にする。
  if (crossings.length >= 2) {
    const L = setbackState.line;
    let ux = L.bx - L.ax, uz = L.bz - L.az;
    const ulen = Math.hypot(ux, uz) || 1; ux /= ulen; uz /= ulen;
    const uniq = [];
    for (const [cx, cz] of crossings) {
      const t = cx * ux + cz * uz;
      if (!uniq.some((u) => Math.abs(u.t - t) < 0.01)) uniq.push({ t, x: cx, z: cz });
    }
    uniq.sort((p, q) => p.t - q.t);
    for (let i = 0; i + 1 < uniq.length; i += 2) {
      pushWall(uniq[i].x, uniq[i].z, uniq[i + 1].x, uniq[i + 1].z);
    }
  }
  if (out.length < 9) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* 断面の頂点を【棟ごと】に作る。分割では棟ごとに高さを別々に動かすので、
   断面も棟ごとに独立していないと、1棟だけ動かしたときに他の棟の断面まで
   一緒に動いてしまう。
   ★ タイルの走査は1回にまとめる（棟数ぶんの繰り返しにしない）。 */
function buildCapVertsPerBuilding(plane) {
  const L = setbackState.line;
  let ux = L.bx - L.ax, uz = L.bz - L.az;
  const ulen = Math.hypot(ux, uz) || 1; ux /= ulen; uz /= ulen;

  const segsByBuilding = new Map();   // gmlId -> segs[]
  forEachTargetTriangle((cand, i0, i1, i2, wx, wy, wz, gmlId) => {
    let segs = segsByBuilding.get(gmlId);
    if (!segs) { segs = []; segsByBuilding.set(gmlId, segs); }
    triCutSegment(wx(i0), wy(i0), wz(i0), wx(i1), wy(i1), wz(i1),
      wx(i2), wy(i2), wz(i2), plane, ux, uz, segs);
  });

  const px = -plane.nx * plane.c, pz = -plane.nz * plane.c;
  const baseU = px * ux + pz * uz;
  const out = new Map();   // gmlId -> verts[]
  let totalSegs = 0, totalTris = 0;
  for (const [gmlId, segs] of segsByBuilding) {
    totalSegs += segs.length / 4;
    if (!segs.length) { out.set(gmlId, []); continue; }
    const sv = fillByScanline(segs);
    const verts = [];
    for (let i = 0; i < sv.length; i += 2) {
      const uu = sv[i] - baseU;
      verts.push(px + ux * uu, sv[i + 1], pz + uz * uu);
    }
    totalTris += verts.length / 9;
    out.set(gmlId, verts);
  }
  capStats.segs = totalSegs;
  capStats.tris = totalTris;
  return out;
}

// =============================================================================
// 両側を残して切る（分割）
//
//   「削る」が片側を消すのに対して、こちらは【両側とも残す】。そのうえで
//   片側ずつ高さを別々に下げられるようにする。
//
//   【作り方】
//     ① 元の建物は、タイルの中では両側とも消す（削りの平面を「常に成立」にする）
//     ② その建物の三角形だけを抜き出した独立メッシュを【側ごとに】作る
//     ③ 側ごとに逆向きのクリップ平面を与える（three 標準の material.clippingPlanes。
//        専用マテリアルなので、他の建物には影響しない）
//     ④ 高さは mesh.position.y を動かすだけ
//
//   ★ 独立メッシュは scene 直下に置くので、タイルの読み込み・破棄・LOD切替に
//     影響されない。タイル側でやることは「元の建物を消し続ける」ことだけで、
//     それは既存のフックがそのまま面倒を見る。
//
//   ⚠️ 元のジオメトリの座標は【ここでも一切触らない】。以前この機能を
//     「元を頂点ごと潰して置き換える」方式で作ってモデルが崩れた。消すのは
//     シェーダの仕事に任せる。
// =============================================================================
// 分割の状態。sides[0] が面の正側、sides[1] が負側。
//   targetH … その側を揃える【絶対高さ】[m]。NaN のうちは「まだ触っていない」で、
//     各棟は元の高さのまま（棟ごとの group.position.y = 0）。
const splitState = {
  active: false,
  sides: [
    { targetH: NaN, group: null, cap: null },
    { targetH: NaN, group: null, cap: null },
  ],
};

// 分割中の棟ごとの情報（gmlId -> {baseH, baseY, edges}）。
//   ★ rebuildSplit で1回だけ集めて使い回す。柱はスライダーを動かすたびに
//     高さが変わって作り直しが要るが、その都度タイルを走査し直す必要はない
//     （底面の輪郭・元の高さは dy に関係なく不変なため）。
let buildingInfoCache = new Map();

/* 対象建物の三角形を、【棟ごと・マテリアルごと】に独立ジオメトリへ抜き出す。
   ⚠️ 1棟の建物はマテリアルごとに複数メッシュへ分かれていることがある
     （LOD2 はテクスチャが複数枚）。ひとまとめにすると見た目が壊れるので、
     元のマテリアルごとに分けて作る。
   ⚠️ 棟ごとに分けるのは、複数棟を選んだときに「奥側を8mに揃える」のような
     【絶対高さ指定】をするため。棟によって元の高さが違うので、同じ絶対高さに
     揃えるには棟ごとに違う移動量（絶対高さ − その棟の元の高さ）が要る。
     ついでにワールドYの範囲も棟ごとに集計しておく（次の baseHeightFor で使う。
     属性 bldg:measuredHeight が無い棟の高さをここから代用する）。 */
function extractBuildingMeshes() {
  const byBuilding = new Map();     // gmlId -> Map(元マテリアル -> {pos,uv,hasUV})
  const heightRange = new Map();    // gmlId -> { min, max }（ワールドY）
  forEachTargetTriangle((cand, i0, i1, i2, wx, wy, wz, gmlId) => {
    const mesh = cand.mesh;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;
    let matMap = byBuilding.get(gmlId);
    if (!matMap) { matMap = new Map(); byBuilding.set(gmlId, matMap); }
    let rec = matMap.get(mat);
    if (!rec) { rec = { pos: [], uv: [], hasUV: true }; matMap.set(mat, rec); }
    let hr = heightRange.get(gmlId);
    if (!hr) { hr = { min: Infinity, max: -Infinity }; heightRange.set(gmlId, hr); }
    const uvAttr = mesh.geometry.attributes.uv;
    for (const i of [i0, i1, i2]) {
      const y = wy(i);
      rec.pos.push(wx(i), y, wz(i));
      // ⚠️ UV は【必ず頂点数ぶん詰める】こと。無い頂点を飛ばすと配列の長さが
      //   位置とずれ、テクスチャが全く別の場所を指してしまう。
      rec.uv.push(uvAttr ? uvAttr.getX(i) : 0, uvAttr ? uvAttr.getY(i) : 0);
      if (!uvAttr) rec.hasUV = false;
      if (y < hr.min) hr.min = y;
      if (y > hr.max) hr.max = y;
    }
  });
  return { byBuilding, heightRange };
}

/* その棟の元の高さ[m]。
   ① 属性 bldg:measuredHeight（選択時に控えてある info.height）
   ② 無ければ、いま抜き出した三角形のワールドY範囲（min〜max）から実測
   両方とも駄目なら NaN（このときは絶対高さの計算を諦め、常に dy=0 にする）。
   ★ buildingedit.js の baseHeightOf と同じ考え方（属性 → 実測の順）。 */
function baseHeightFor(gmlId, heightRange) {
  const info = editState.selection.get(gmlId);
  const attrH = info ? Number(info.height) : NaN;
  if (Number.isFinite(attrH) && attrH > 0) return attrH;
  const hr = heightRange.get(gmlId);
  if (hr && Number.isFinite(hr.min) && Number.isFinite(hr.max)) return hr.max - hr.min;
  return NaN;
}

/* 側ごとの平面（THREE.Plane）。keepPositive なら面の正側だけを残す。 */
function makeSidePlane(plane, keepPositive) {
  const n = new THREE.Vector3(plane.nx, 0, plane.nz);
  const c = plane.c;
  return keepPositive ? new THREE.Plane(n, c) : new THREE.Plane(n.negate(), -c);
}

/* ⚠️ side.group の直下は【棟ごとの sub（Group）】と【柱（Mesh）】が混在する
   （sub は building.js の位置合わせ、柱は setSideHeight のたびに直下へ足し引きする）。
   直下だけを見て m.geometry を呼ぶと、sub（Group には geometry が無い）で例外になる。
   traverse で実際の Mesh だけを拾うこと。 */
function disposeSide(side) {
  if (side.group) {
    side.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(side.group);
    side.group = null;
  }
  if (side.cap) {
    side.cap.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(side.cap);
    side.cap = null;
  }
}

/* 側の中に棟ごとの小グループを1つ作る（メッシュ本体・断面のどちらも同じ形）。
   userData に gmlId と baseH（その棟の元の高さ）を持たせておき、
   setSideHeight はこれを見て「絶対高さ − baseH」を position.y に入れる。 */
function makeBuildingSubGroup(gmlId, baseH, targetH) {
  const g = new THREE.Group();
  g.userData = { gmlId, baseH };
  g.position.y = Number.isFinite(targetH) && Number.isFinite(baseH) ? targetH - baseH : 0;
  return g;
}

/* 分割を作り直す。 */
function rebuildSplit() {
  for (const s of splitState.sides) disposeSide(s);
  const plane = computePlane();
  if (!splitState.active || !plane || !targets.size) { requestRender(); return; }

  const { byBuilding, heightRange } = extractBuildingMeshes();
  if (!byBuilding.size) { requestRender(); return; }
  const capVertsByBuilding = buildCapVertsPerBuilding(plane);
  // 柱の輪郭は側に依存しない（底面の形そのもの）ので、side のループの外で1回だけ集める。
  const outlinesByBuilding = buildBaseOutlinesPerBuilding(heightRange);

  for (let si = 0; si < 2; si++) {
    const side = splitState.sides[si];
    const clip = makeSidePlane(plane, si === 0);
    const group = new THREE.Group();
    const capGrpAll = new THREE.Group();

    for (const [gmlId, matMap] of byBuilding) {
      const baseH = baseHeightFor(gmlId, heightRange);
      const sub = makeBuildingSubGroup(gmlId, baseH, side.targetH);
      for (const [srcMat, rec] of matMap) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(rec.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(rec.uv, 2));
        // 元の建物と同じ見た目にするため、_setback は全部 0（＝消さない）で持たせる。
        //   ⚠️ 属性が無いと、元マテリアル由来のシェーダが参照する attribute が
        //     欠けた状態になる。値が 0 なら「対象でない」と読まれるので安全。
        g.setAttribute('_setback', new THREE.BufferAttribute(
          new Float32Array(rec.pos.length / 3), 1));
        g.computeVertexNormals();
        g.computeBoundingBox();
        g.computeBoundingSphere();
        // ★ 元のマテリアルは【clone しない】。テクスチャだけ借りて新しく作る。
        //   ⚠️ タイルの建物マテリアルには、フェード（3d-tiles-renderer）・裏面の灰色
        //     （makeInteriorCap）・屋根テキスト・壁面後退と、何段もの onBeforeCompile が
        //     積み重なっている。clone するとそれらを丸ごと引き継ぐが、フェードは
        //     タイルごとの状態を uniform で持つため、切り離した途端に「完全に透明」の
        //     ままになる。実測で、位置も形も正しいのに1画素も描かれなかった。
        //   素のマテリアルなら余計な状態を持たないので、確実に見える。
        const m = new THREE.MeshStandardMaterial({
          // UV が取れなかったときはテクスチャを外す（UV 無しで map を残すと全頂点が
          // 同じ画素を引いて真っ黒になる）
          map: rec.hasUV ? srcMat.map || null : null,
          color: srcMat.color ? srcMat.color.clone() : new THREE.Color(0xffffff),
          metalness: 0.0, roughness: 0.85,
          side: THREE.DoubleSide,
          // ⚠️ 箱庭の面（buildingClipPlanes）は毎フレーム動かされるので、
          //   要素の参照を保ったまま側の面を足すこと（配列だけ新しくする）。
          clippingPlanes: [...buildingClipPlanes, clip],
        });
        m.clipShadows = false;
        sub.add(new THREE.Mesh(g, m));
      }
      group.add(sub);

      // 断面（棟ごとに1枚）。高さは同じ棟の本体と一緒に動く。
      //   ★ 断面は【側ごとに向きを変えた同じ面】なので、両側に持たせると
      //     まったく同じ平面に2枚が重なる。深度が拮抗して視点しだいで勝敗が
      //     入れ替わり、縞模様になる（polygonOffset を側ごとにずらしても、
      //     同一平面である以上は完全には避けられない）。
      //   ⚠️ だから断面は【この側のぶんだけ】を持つ。切り口は本来1枚で足りる。
      //     side.targetH が側ごとに違えば断面も別の高さへ動くので、
      //     「片側だけ下げたのに断面が動かない」ということも起きない。
      const capVerts = capVertsByBuilding.get(gmlId) || [];
      if (capVerts.length) {
        // ★ 断面は【側ごとに、その側の建物のほうへ僅かにずらして】置く。
        //   ⚠️ 両側の断面はまったく同じ平面に重なるので、そのままだと深度が拮抗し、
        //     視点しだいで勝敗が入れ替わって縞模様になる。polygonOffset は
        //     深度値を動かすだけなので、同一平面では完全には避けられない。
        //     ジオメトリ自体を離してしまえば確実に決着がつく。
        //     ずらす量は 1cm。建物の縮尺では見えないが、深度としては十分に離れる。
        //   ⚠️ 裏面を描かない（FrontSide）方式も試したが、断面がカメラ側を向かない
        //     角度で【丸ごと消えて穴が開いた】ので採らない。両面のまま離すのが確実。
        const cg = makeCapGeometry(capVerts, plane, (si === 0 ? 1 : -1) * 0.01);
        const cm = capMat.clone();
        // ⚠️ 側のクリップ平面は【付けない】。断面はその平面の【ちょうど上】にあるので、
        //   dot(n,p)+c が 0 近傍になり、通るか切られるかが浮動小数の誤差で決まる。
        //   これが縞模様のもう一つの原因だった。断面はすでにその側の形に作ってあり、
        //   クリップで削る必要がそもそもない。
        cm.clippingPlanes = buildingClipPlanes;
        const capSub = makeBuildingSubGroup(gmlId, baseH, side.targetH);
        capSub.add(new THREE.Mesh(cg, cm));
        capGrpAll.add(capSub);
      }
    }
    scene.add(group);
    side.group = group;
    scene.add(capGrpAll);
    side.cap = capGrpAll;
  }

  // 柱は側ごとに作り直す（高さがまだ NaN＝未設定のうちは1本も出ない）。
  buildingInfoCache = new Map();
  for (const gmlId of byBuilding.keys()) {
    buildingInfoCache.set(gmlId, {
      baseH: baseHeightFor(gmlId, heightRange),
      baseY: heightRange.get(gmlId)?.min,
      edges: outlinesByBuilding.get(gmlId),
    });
  }
  rebuildColumnsForSide(0);
  rebuildColumnsForSide(1);

  markSectionDirty();
  requestRender();
}

/* 側の柱を作り直す。buildingInfoCache（底面の輪郭・元の高さ）はタイル走査済みの
   ものを使い回すので、スライダーを動かすたびにここを呼んでも軽い。
   ⚠️ side.group の直下には棟ごとの sub（Group）と柱（Mesh）が混在するので、
     柱だけを見分けて先に取り除いてから作り直す（sub は setSideHeight が
     別に動かすので、ここでは触らない）。 */
function rebuildColumnsForSide(index) {
  const side = splitState.sides[index];
  if (!side || !side.group) return;
  const plane = computePlane();
  for (const child of [...side.group.children]) {
    if (!child.isMesh) continue;   // Mesh＝柱、Group＝棟の sub（残す）
    side.group.remove(child);
    child.geometry.dispose();
    child.material.dispose();
  }
  if (!plane) return;
  const keepPositive = index === 0;
  const clip = makeSidePlane(plane, keepPositive);
  for (const [gmlId, info] of buildingInfoCache) {
    const dy = Number.isFinite(side.targetH) && Number.isFinite(info.baseH)
      ? side.targetH - info.baseH : 0;
    if (dy <= 0 || !Number.isFinite(info.baseY)) continue;
    const colGeo = buildColumnGeometry(info.edges, info.baseY, dy, plane, keepPositive);
    if (!colGeo) continue;
    const cmat = columnMat.clone();
    cmat.clippingPlanes = [...buildingClipPlanes, clip];
    side.group.add(new THREE.Mesh(colGeo, cmat));
  }
}

/* 片側を【絶対高さ】targetH[m] に揃える。
   ★ 複数棟を選んでいても、それぞれの元の高さ（baseH）が違えば動く量は棟ごとに
     変わる。「奥側を8mに」なら、20m の棟は -12m、5m の棟は +3m 動く、という具合。
   targetH が NaN なら「まだ触っていない」＝全棟とも動かさない（position.y=0）。 */
function setSideHeight(index, targetH) {
  const side = splitState.sides[index];
  if (!side) return;
  side.targetH = Number.isFinite(targetH) ? Number(targetH) : NaN;
  const apply = (grp) => {
    if (!grp) return;
    for (const sub of grp.children) {
      if (!sub.isGroup) continue;   // 柱（Mesh）はここでは動かさない。下で作り直す。
      const baseH = sub.userData.baseH;
      sub.position.y = Number.isFinite(side.targetH) && Number.isFinite(baseH)
        ? side.targetH - baseH : 0;
    }
  };
  apply(side.group);
  apply(side.cap);
  // 柱は高さそのもの（ジオメトリ）が変わるので、動かすのではなく作り直す。
  //   ⚠️ buildingInfoCache（底面の輪郭・元の高さ）はタイルを走査し直さず使い回すので、
  //     スライダーをドラッグするたびに呼んでも重くならない。
  rebuildColumnsForSide(index);
  markSectionDirty();
  requestRender();
}

/* 選択中の建物の代表的な「元の高さ」。UI のスライダーを最初にどこへ置くかの
   目安に使う（実際に動かす量は棟ごとに baseHeightFor で別々に決まる）。 */
function representativeBaseHeight() {
  const info = editState.primary;
  if (!info) return NaN;
  const h = Number(info.height);
  if (Number.isFinite(h) && h > 0) return h;
  return Number.isFinite(info.measuredHeight) ? info.measuredHeight : NaN;
}

/* 両側を残して切る。選択中の建物が対象。 */
/* keepTargets … applySetback と同じ意味（対象を選び直さずに作り直す）。 */
function applySplit({ keepTargets = false } = {}) {
  if (!keepTargets) {
    targets.clear();
    for (const gmlId of editState.selection.keys()) targets.add(gmlId);
  }
  if (!targets.size) return { ok: false, reason: '建物が選ばれていません' };
  if (!setbackState.line) return { ok: false, reason: '切断面が決まっていません' };
  // 「削る」とは併用しない（同じ建物に両方かけると二重になる）
  setbackState.active = false;
  splitState.active = true;
  syncPlaneUniform();      // 削りの平面は無効に
  markAll();               // 元の建物を「全部消す」印にする
  rebuildCap();            // 削り用の断面は消える
  rebuildSplit();
  return { ok: true, 棟数: targets.size };
}

/* 分割を解除して元に戻す。 */
function clearSplit() {
  splitState.active = false;
  splitState.sides[0].targetH = NaN;
  splitState.sides[1].targetH = NaN;
  targets.clear();
  markAll();
  rebuildSplit();
  syncPlaneUniform();
  markSectionDirty();
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

// ---- 面の見せ方 -------------------------------------------------------------
//   白い線 … 引いた2点を結ぶ線（もとの面）
//   赤い板 … 後退させたあとの、実際に切る面
const PLANE_H = 60;      // 板の高さ[m]（見えれば十分なので固定）
const PLANE_EXT = 30;    // 2点の外側へ伸ばす長さ[m]。建物の端まで届くように

let guideGroup = null;
function ensureGuide() {
  if (guideGroup) return guideGroup;
  guideGroup = new THREE.Group();
  guideGroup.renderOrder = 5;
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95,
  });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  line.frustumCulled = false;
  const planeMat = new THREE.MeshBasicMaterial({
    color: 0xd8402f, transparent: true, opacity: 0.28,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.BufferGeometry(), planeMat);
  plane.frustumCulled = false;
  guideGroup.add(line, plane);
  guideGroup.userData = { line, plane };
  scene.add(guideGroup);
  return guideGroup;
}

/* 白線と赤板を今の状態に合わせて描き直す。 */
/* ガイド（白線と赤板）を出してよい場面か。
   ★ 面はあくまで「これから削る位置」を示す道具なので、削る相手が居ないときに
     出しっぱなしにしない。編集モードを抜けたときと、建物の選択を解いたときは消す。
     ただし【適用中は選択を解いても残す】。削りは選択と切り離して保持しているので、
     どこで切ったのかが分からなくなるほうが困る。 */
function guideVisible() {
  if (!setbackState.line || !pickState.showGuide) return false;
  if (!editState.enabled) return false;
  // ★ 適用中（削る／分割）は実際の切り口メッシュが同じ平面に出ているので、
  //   プレビュー用の半透明の板は消す。
  //   ⚠️ 消し忘れると、実際の断面と全く同じ平面に半透明の板が重なり、
  //     深度精度の限界でZファイトを起こして縞模様になる（実測でこれが起きた）。
  //     プレビューの役目は「切る前にどこで切れるかを見せる」ことなので、
  //     切ったあとは要らない。
  if (setbackState.active || splitState.active) return false;
  return editState.selection.size > 0 || pickState.picking;
}

function updateGuide() {
  if (!guideVisible()) {
    if (guideGroup) guideGroup.visible = false;
    requestRender();
    return;
  }
  const L = setbackState.line;
  const g = ensureGuide();
  g.visible = true;
  const { line, plane } = g.userData;
  const y = pickState.baseY;
  // 2点の外側へ少し伸ばした線分にする
  let dx = L.bx - L.ax, dz = L.bz - L.az;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const ax = L.ax - dx * PLANE_EXT, az = L.az - dz * PLANE_EXT;
  const bx = L.bx + dx * PLANE_EXT, bz = L.bz + dz * PLANE_EXT;
  line.geometry.setAttribute('position',
    new THREE.Float32BufferAttribute([ax, y, az, bx, y, bz], 3));
  line.geometry.attributes.position.needsUpdate = true;
  // 赤板は後退させた位置に立てる
  const p = computePlane();
  if (p) {
    const ox = p.nx * setbackState.offset, oz = p.nz * setbackState.offset;
    const x0 = ax + ox, z0 = az + oz, x1 = bx + ox, z1 = bz + oz;
    plane.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      x0, y - 5, z0, x1, y - 5, z1, x1, y + PLANE_H, z1,
      x0, y - 5, z0, x1, y + PLANE_H, z1, x0, y + PLANE_H, z0,
    ], 3));
    plane.geometry.attributes.position.needsUpdate = true;
    plane.geometry.computeBoundingSphere();
    plane.visible = true;
  } else {
    plane.visible = false;
  }
  requestRender();
}

// 面を引いている最中の状態
const pickState = {
  picking: false,   // 「面を引く」を押して点を待っている
  first: null,      // 1点目
  baseY: 0,         // 線を描く高さ（1点目の地面の高さ）
  showGuide: false,
};

function onPickDown(ev) {
  if (!pickState.picking || ev.button !== 0) return;
  // buildingedit へ渡さない（建物を掴んで高さが変わってしまうため）
  ev.stopPropagation();
  ev.preventDefault();
  const p = pickPoint(ev.clientX, ev.clientY);
  if (!p) { setInfo('地面が取れませんでした。もう一度クリックしてください'); return; }
  if (!pickState.first) {
    pickState.first = p;
    pickState.baseY = p.y;
    setInfo('2点目をクリックしてください');
    return;
  }
  setSetbackLine(pickState.first.x, pickState.first.z, p.x, p.z);
  pickState.picking = false;
  pickState.first = null;
  pickState.showGuide = true;
  renderer.domElement.style.cursor = '';
  controls.enabled = true;
  // ★ すでに適用中なら、新しい面で作り直す。建物は選び直さなくてよい。
  reapplyCurrent();
  updateGuide();
  syncSetbackUI();
}

function startPicking() {
  pickState.picking = true;
  pickState.first = null;
  pickState.showGuide = true;
  renderer.domElement.style.cursor = 'crosshair';
  setInfo('1点目をクリックしてください（Esc で中止）');
}

function cancelPicking() {
  if (!pickState.picking) return;
  pickState.picking = false;
  pickState.first = null;
  renderer.domElement.style.cursor = '';
  syncSetbackUI();
}

// =============================================================================
// UI
// =============================================================================
let sbUi = {};
function setInfo(text) { if (sbUi.info) sbUi.info.textContent = text; }

function syncSetbackUI() {
  if (!sbUi.info) return;
  if (pickState.picking) return;   // 案内文はピック中の指示を優先
  const lines = [];
  if (!setbackState.line) {
    lines.push('「面を引く」で地面を2点クリックしてください');
  } else if (splitState.active) {
    const a = splitState.sides[0].targetH, b = splitState.sides[1].targetH;
    lines.push(`${targets.size} 棟を両側に分割中`);
    const fmtH = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}m` : '未設定');
    if (Number.isFinite(a) || Number.isFinite(b)) {
      lines.push(`手前 ${fmtH(a)} ／ 奥 ${fmtH(b)}（絶対高さ・棟ごとに揃える）`);
    }
  } else if (setbackState.active) {
    const fa = measureCutFloorArea();
    const n = targets.size;
    lines.push(`${n} 棟を後退中 ／ 削れた延床 約 ${Math.round(fa.total).toLocaleString('ja-JP')} ㎡`);
    if (fa.assumed) lines.push('※ 階数が無い建物は階高 3m と仮定');
  } else {
    lines.push('面ができました。建物を選んで「後退を実行」を押してください');
  }
  sbUi.info.textContent = lines.join('\n');
  // 高さスライダーは分割中だけ出す（削り単体・面を引いただけのときは要らない）
  if (sbUi.splitHeights) sbUi.splitHeights.style.display = splitState.active ? '' : 'none';
}

(function setupSetbackUI() {
  const pick = el('setbackPick');
  if (!pick) return;   // この画面に後退UIが無い構成でも動くように
  sbUi = {
    info: el('setbackInfo'), offset: el('setbackOffset'),
  };
  pick.addEventListener('click', startPicking);
  // 削る側の反転・後退量の変更・面の引き直しは、いずれも【対象を選び直さない】。
  //   適用したあとで建物の選択を外していても、そのまま調整を続けられる。
  el('setbackFlip').addEventListener('click', () => {
    flipSetbackSide();
    updateGuide();
    reapplyCurrent();
    syncSetbackUI();
  });
  sbUi.offset.addEventListener('input', () => {
    setSetbackOffset(sbUi.offset.value);
    updateGuide();
    reapplyCurrent();
    syncSetbackUI();
  });
  el('setbackApply').addEventListener('click', () => {
    const r = applySetback();
    if (!r.ok) { setInfo(r.reason); return; }
    syncSetbackUI();
  });
  el('setbackClear').addEventListener('click', () => {
    clearSetback();
    syncSetbackUI();
  });
  // ---- 両側を残して切る ----
  sbUi.splitHeights = el('splitHeights');
  sbUi.dyA = el('splitDyA'); sbUi.dyAVal = el('splitDyAVal');
  sbUi.dyB = el('splitDyB'); sbUi.dyBVal = el('splitDyBVal');
  el('splitApply').addEventListener('click', () => {
    const r = applySplit();
    if (!r.ok) { setInfo(r.reason); return; }
    // ★ スライダーの初期位置は「代表の棟の元の高さ」に合わせるだけの見た目調整。
    //   実際にはまだ setSideHeight を呼ばない（targetH は NaN のまま）ので、
    //   ボタンを押した直後は【どの棟も動かない】。触って初めて絶対高さが効く。
    const h = representativeBaseHeight();
    const initial = Number.isFinite(h) ? Math.min(100, Math.max(0, h)) : 0;
    sbUi.dyA.value = String(initial); sbUi.dyB.value = String(initial);
    sbUi.dyAVal.textContent = `${initial.toFixed(1)} m`;
    sbUi.dyBVal.textContent = `${initial.toFixed(1)} m`;
    syncSetbackUI();
  });
  el('splitClear').addEventListener('click', () => { clearSplit(); syncSetbackUI(); });
  // スライダーの値は【絶対高さ】。棟ごとの実際の移動量は setSideHeight が
  // 棟ごとの元の高さを見て別々に計算する（複数棟を選んでいても同じ絶対高さに揃う）。
  const bindDy = (input, label, index) => input.addEventListener('input', () => {
    const v = Number(input.value);
    setSideHeight(index, v);
    label.textContent = `${v.toFixed(1)} m`;
    syncSetbackUI();
  });
  bindDy(sbUi.dyA, sbUi.dyAVal, 0);
  bindDy(sbUi.dyB, sbUi.dyBVal, 1);
  // ★ 捕捉フェーズで受ける（buildingedit より先に横取りするため）
  renderer.domElement.addEventListener('pointerdown', onPickDown, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPicking(); });
  syncSetbackUI();
})();

/* 毎フレーム呼ぶ軽い見張り（main.js の描画ループから）。
   ★ 建物の選択は buildingedit.js の中だけで変わるので、こちらへ届く通知が無い。
     フックを増やして両者を結ぶよりも、変化を見張るほうが結び付きが浅くて済む。
     ⚠️ 実際に作り直すのは【変わった瞬間だけ】。毎フレーム描き直してはいけない。 */
let lastGuideKey = '';
function updateSetbackGuide() {
  const key = `${guideVisible() ? 1 : 0}|${editState.selection.size}|${editState.enabled ? 1 : 0}`;
  if (key === lastGuideKey) return;
  lastGuideKey = key;
  updateGuide();
  syncSetbackUI();
}

export {
  setbackState, targets,
  setSetbackLine, setSetbackOffset, flipSetbackSide,
  applySetback, clearSetback, updateSetbackGuide, capStats,
  splitState, applySplit, clearSplit, setSideHeight, representativeBaseHeight,
  measureCutArea, measureCutFloorArea,
};

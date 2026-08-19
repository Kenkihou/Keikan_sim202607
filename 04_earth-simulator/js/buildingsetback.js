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
} from './section.js';
import { wardTiles, getTerrainTiles, setBuildingSetbackHook } from './tiles.js';
import {
  editState, gmlIndexOf, floorHeightOf, registerSelectionGroup, clearSelectionGroup,
  setSetbackBusy,
} from './buildingedit.js';

// 後退面。ワールドの水平面上の直線 (ax,az)→(bx,bz) を通る鉛直面として持つ。
//   offset … その直線を法線方向へずらす量[m]。正で「削る側」が広がる。
//   side   … どちら側を削るか（+1 / -1）。
const setbackState = {
  line: null,       // { ax, az, bx, bz }
  offset: 0,
  side: 1,
  active: false,    // 適用中か
  // ★ 確定したときの基準線と後退距離の控え。
  //   確定すると endFaceEditing() が候補面もろとも基準線を片付けてしまうので、
  //   ここへ写しておかないと「何メートル後退させたのか」が残らない
  //   （セーブJSONへ持ち出すのも、あとで見直すのもこの値を使う）。
  baseline: null,   // { x, z, nx, nz }
  distance: NaN,
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
  const p = setbackState.active ? computePlane() : null;
  if (p) setbackPlaneUniform.value.set(p.nx, 0, p.nz, p.c);
  else setbackPlaneUniform.value.set(0, 0, 0, 0);
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
  if (!setbackState.active) return;
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
  if (setbackState.active) applySetback({ keepTargets: true });
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
  setbackState.active = true;
  // 基準線と後退距離は、候補面が片付く前にここで控える
  setbackState.baseline = faceState.baseline ? { ...faceState.baseline } : setbackState.baseline;
  const d0 = setbackDistance();
  if (Number.isFinite(d0)) setbackState.distance = d0;
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
  setbackState.baseline = null;
  setbackState.distance = NaN;
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
  for (const d of defs) {
    const geo = new THREE.PlaneGeometry(Math.max(d.half * 2, 1), hy * 2);
    const mat = new THREE.MeshBasicMaterial({
      color: FACE_COLOR, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(d.cx, cy, d.cz);
    // PlaneGeometry は既定で +Z を向くので、法線の向きへ回す
    mesh.rotation.y = Math.atan2(d.nx, d.nz);
    mesh.frustumCulled = false;
    faceGroup.add(mesh);
    faceState.faces.push(mesh);
  }
  requestRender();
}

/* 基準線を今のギズモ位置で決める。 */
function setBaselineHere() {
  const h = faceState.handle;
  if (!h) return;
  faceState.baseline = {
    x: h.position.x, z: h.position.z,
    nx: Math.sin(h.rotation.y), nz: Math.cos(h.rotation.y),
  };
  updateBaselineMesh();
  syncSetbackUI();
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
  const nx = Math.sin(h.rotation.y), nz = Math.cos(h.rotation.y);
  const ux = -nz, uz = nx;
  setbackState.offset = 0;
  setSetbackLine(h.position.x - ux * 300, h.position.z - uz * 300,
    h.position.x + ux * 300, h.position.z + uz * 300);
  // 箱の中心が「残る側」に来るよう向きを合わせる（＝外側が削られる）
  const c = new THREE.Vector3(); box.getCenter(c);
  const p0 = computePlane();
  if (p0 && (p0.nx * c.x + p0.nz * c.z + p0.c) < 0) setbackState.side *= -1;
  // 選ばれている板も handle に追従させる
  if (faceState.picked) {
    faceState.picked.position.copy(h.position);
    faceState.picked.rotation.y = h.rotation.y;
  }
  reapplyCurrent();
  syncPlaneUniform();
  requestRender();
}

/* 面を選ぶ。選んだ面から切断面を決め、ギズモを付ける。 */
function pickFace(mesh) {
  faceState.picked = mesh;
  // ★ 壁面後退の作業中は、選択が空になってもパネルの中身を畳ませない
  //   （畳まれると調整の途中で操作先が消えてしまう）。
  setSetbackBusy(true);
  faceState.hover = null;
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
  // ★ 面を選んだ時点で削りを効かせる（確定前のプレビュー）。
  //   面を動かすたびに結果が見えないと、どこまで削れるのか分からないため。
  //   「後退を確定」はこのプレビューを確定させ、ギズモを畳むだけ。
  //   ⚠️ 先に切断面を作ること。applySetback は面が決まっていないと失敗する。
  syncPlaneFromHandle();
  applySetback();
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
const gizmoRot = new TransformControls(camera, renderer.domElement);
gizmoRot.setMode('rotate');
gizmoRot.showX = false;         // 面は鉛直のまま。傾けるのは水平の向きだけ
gizmoRot.showZ = false;
const gizmos = [gizmoMove, gizmoRot];
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
  });
  g.addEventListener('objectChange', () => { syncPlaneFromHandle(); syncSetbackUI(); });
}

/* 面の選択・ギズモを畳む（確定したとき／やめたとき）。 */
function endFaceEditing() {
  setSetbackBusy(false);
  for (const g of gizmos) {
    g.detach();
    g.enabled = false;
    if (g.getHelper) g.getHelper().visible = false;
  }
  if (faceState.handle) faceState.handle.visible = false;
  disposeFaces();
  faceState.box = null;
  clearBaseline();
  requestRender();
}

/* 「面を選ぶ」を始める（候補の4面を出す）。 */
function startFacePick() {
  if (!editState.selection.size) { setInfo('先に建物を選んでください'); return; }
  buildFaces();
  setInfo('囲み箱の面をクリックして、切る面を選んでください');
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
function onFaceHover(ev) {
  if (!faceState.faces.length) return;
  if (gizmos.some((g) => g.dragging)) return;
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hit = _rc.intersectObjects(faceState.faces, false)[0];
  const next = hit ? hit.object : null;
  if (next === faceState.hover) return;   // 変わったときだけ描き直す
  faceState.hover = next;
  refreshFaceLook();
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
  const hit = _rc.intersectObjects(faceState.faces, false)[0];
  if (!hit) return;
  ev.stopPropagation();
  ev.preventDefault();
  pickFace(hit.object);
  syncSetbackUI();
}

// =============================================================================
// UI
// =============================================================================
let sbUi = {};
function setInfo(text) { if (sbUi.info) sbUi.info.textContent = text; }

function syncSetbackUI() {
  if (!sbUi.info) return;
  const lines = [];
  const n = editState.selection.size;
  if (setbackState.active) {
    const fa = measureCutFloorArea();
    lines.push(`${targets.size} 棟を後退中 ／ 削れた延床 約 ${Math.round(fa.total).toLocaleString('ja-JP')} ㎡`);
    if (fa.assumed) lines.push('※ 階数が無い建物は階高 3m と仮定');
    if (faceState.picked) lines.push('ギズモで面を動かすと削り方が変わります');
  } else if (faceState.picked) {
    if (faceState.baseline) lines.push('ギズモで面を動かし、「後退を確定」を押してください');
    else lines.push('まず道路境界線などに面を合わせて「ここを基準線に」を押してください');
  } else if (faceState.faces.length) {
    lines.push('囲み箱の面をクリックして、切る面を選んでください');
  } else if (!n) {
    lines.push('建物を選ぶと「面を選ぶ」が使えます');
  } else {
    lines.push(`${n} 棟を選択中。「面を選ぶ」を押してください`);
  }
  sbUi.info.textContent = lines.join('\n');
  // 基準線まわりのボタンは、面を選んでいるときだけ意味がある
  if (sbUi.baseRow) sbUi.baseRow.style.display = faceState.picked ? 'flex' : 'none';
  if (sbUi.baseSet) {
    sbUi.baseSet.textContent = faceState.baseline ? '基準線を引き直す' : 'ここを基準線に';
  }
  // ★ 後退距離は数字そのものが主役なので、案内文に混ぜず大きく別立てで出す。
  //   ⚠️ 行は【面を選んでいる間つねに出す】。基準線がまだ無いときも枠だけ見せて
  //     「先に基準線を決める」と促す。出したり消したりすると、入力欄がどこにあるのか
  //     分からなくなる（実際「入力欄が見当たらない」となった）。
  const dist = setbackDistance();
  const hasBase = !!faceState.baseline;
  if (sbUi.distRow) sbUi.distRow.style.display = faceState.picked ? 'flex' : 'none';
  if (sbUi.distVal) {
    sbUi.distVal.textContent = Number.isFinite(dist) ? `${dist.toFixed(2)} m` : '— m';
  }
  if (sbUi.distInput) {
    sbUi.distInput.disabled = !hasBase;
    // 打ち込んでいる最中は上書きしない（打った端から戻ると入力できない）
    if (Number.isFinite(dist) && document.activeElement !== sbUi.distInput) {
      sbUi.distInput.value = dist.toFixed(2);
    }
    if (!hasBase) sbUi.distInput.value = '';
  }
  if (sbUi.distHint) {
    sbUi.distHint.style.display = (faceState.picked && !hasBase) ? '' : 'none';
  }
}

(function setupSetbackUI() {
  const pick = el('setbackPick');
  if (!pick) return;   // この画面に後退UIが無い構成でも動くように
  sbUi = {
    info: el('setbackInfo'), baseRow: el('setbackBaseRow'),
    baseSet: el('setbackBaseSet'), distRow: el('setbackDistRow'),
    distHint: el('setbackDistHint'),
    distVal: el('setbackDistVal'), distInput: el('setbackDistInput'),
  };
  pick.addEventListener('click', () => { startFacePick(); syncSetbackUI(); });
  el('setbackBaseSet').addEventListener('click', () => setBaselineHere());
  el('setbackBaseClear').addEventListener('click', () => clearBaseline());
  sbUi.distInput.addEventListener('input', () => {
    setSetbackDistance(Number(sbUi.distInput.value));
  });
  el('setbackApply').addEventListener('click', () => {
    const r = applySetback();
    if (!r.ok) { setInfo(r.reason); return; }
    // ★ この対象群を「まとめて扱った群」として覚える。あとで群の1棟を選び直すだけで
    //   群ごと選ばれるので、後退距離の直しがしやすい。選択自体は自由に変えられる。
    registerSelectionGroup();
    // 確定したらギズモと候補面を畳む（削りはそのまま残る）
    endFaceEditing();
    syncSetbackUI();
  });
  el('setbackClear').addEventListener('click', () => {
    clearSetback();
    endFaceEditing();
    // 削りを取り消したら「まとめて選ぶ」の登録も解く
    clearSelectionGroup();
    syncSetbackUI();
  });
  // ★ 捕捉フェーズで受ける（buildingedit より先に横取りするため）
  renderer.domElement.addEventListener('pointerdown', onFaceDown, true);
  renderer.domElement.addEventListener('pointermove', onFaceHover);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && faceState.faces.length) { endFaceEditing(); syncSetbackUI(); }
  });
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
  setSetbackLine, setSetbackOffset, flipSetbackSide,
  applySetback, clearSetback, updateSetbackGuide, capStats,
  startFacePick, endFaceEditing, setBaselineHere, clearBaseline,
  setbackDistance, setSetbackDistance,
  measureCutArea, measureCutFloorArea,
};

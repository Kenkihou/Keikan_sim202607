// =============================================================================
// buildingedit — PLATEAU の建物を1棟ずつ選んで手を加える。
//   ・透過度を変える
//   ・非表示にする
//   ・高さを下げる（地面にめり込ませる）
//   ・高さを上げる（底面と同じ平面図形を下に嵩増しする）
//   ・初期状態に戻す
//
//   ★ 前提となる3つの厄介さ（ここを外すと必ず壊れる）
//
//   1) 建物は【独立したメッシュではない】。1タイル＝1〜数メッシュに何十棟ぶんもの
//      三角形が詰まっていて、どの頂点がどの棟かは `_batchid` 属性でしか分からない。
//      さらに【1棟のジオメトリはタイル内の複数メッシュに分かれる】ことがある
//      （マテリアルごとに分割されるため。tiles.js の高さ色分けでも同じ罠を踏んでいる）。
//      → 対象頂点は「タイル内の全メッシュ × 指定 batchid」で集める。
//
//   2) ジオメトリ空間の +Y は【鉛直ではない】。b3dm の中身は ECEF 系なので、
//      「上へ動かす」にはワールドの上方向をメッシュのローカル空間へ引き戻してから
//      足す必要がある。ここを怠ると建物が斜めにずれる。
//
//   3) タイルは読み込み・破棄・LOD切替を絶えず繰り返す。編集内容をジオメトリにだけ
//      持たせると、カメラを動かしてタイルが入れ替わった瞬間に消える。
//      → 編集は gml_id（LODが変わっても同じ建物を指す永続ID）をキーに Map で保持し、
//        タイルが届くたびに当て直す（tiles.js の load-model フック）。
//
//   依存の向き: core / config / section / tiles に依存する（tiles からは
//   setBuildingEditHook 経由で呼び返してもらう＝循環参照にしない）。
// =============================================================================
import {
  THREE, scene, el, camera, controls, renderer, requestRender, markSectionDirty,
} from './core.js';
import { computeClipMeshWorld, clipMeshes, buildingClipPlanes } from './section.js';
import { wardTiles, setBuildingEditHook } from './tiles.js';

// 高さ変更で「底面」とみなす帯の厚み[m]。
//   嵩上げのとき、底面リングの頂点だけを据え置いて他を持ち上げると、両者をつなぐ
//   壁面がそのまま鉛直に伸びる＝底面と同じ平面図形を下に足したのと同じ形になる。
//   PLATEAU の建物は底面がぴたりと揃っているので、ごく薄い判定で足りる。
const BASE_EPS = 0.05;
// ドラッグの感度。画面上を1px動かしたときに変わる高さ[m]は、その建物までの距離に
// 応じて決める（遠くの建物ほど1pxの意味が大きい）ので、ここでは倍率だけ持つ。
const DRAG_GAIN = 1.0;
// クリック（選択）とドラッグ（高さ変更）を分ける移動量[px]。
const DRAG_THRESHOLD_PX = 4;
const SELECT_COLOR = new THREE.Color(0x4ea1ff);

// 建物ごとの編集内容。キーは gml_id。
//   opacity … 1=不透明, 0=完全に透明
//   hidden  … true で非表示
//   dy      … 高さの変更量[m]。正=嵩上げ、負=めり込み
const edits = new Map();
const defaultEdit = () => ({ opacity: 1, hidden: false, dy: 0 });
const isPristine = (e) => e.opacity === 1 && !e.hidden && e.dy === 0;

const editState = {
  enabled: false,     // 編集モード（ONのときだけクリックで選択・ドラッグできる）
  // 選択は【集合】で持つ。gmlId -> { gmlId, name, usage, height, buildingId, baseH }
  //   baseH … その建物の元の高さ[m]。まとめて「全部同じ高さにする」ときに1棟ずつ
  //           必要な変更量が違うので、選んだ時点で測って覚えておく。
  selection: new Map(),
  primary: null,      // 最後に選んだ1棟（1棟だけのときの情報表示に使う）
};
// 1棟だけ選ばれているときの互換用（既存の呼び出し・デバッグ表示のため）
Object.defineProperty(editState, 'selected', {
  get() { return this.selection.size === 1 ? this.primary : (this.selection.size ? this.primary : null); },
});

// =========================================================================
// タイル内の建物を引くための小道具
// =========================================================================
// batchTable から属性を1件取り出す（キーが無いタイルもあるので必ず try で包む）。
function btValue(batchTable, key, index) {
  if (!batchTable) return null;
  try {
    const arr = batchTable.getData(key);
    return arr ? arr[index] : null;
  } catch (e) { return null; }
}
// タイル(modelScene)の batchid → gml_id。
function gmlIdOf(modelScene, batchId) {
  return btValue(modelScene && modelScene.batchTable, 'gml_id', batchId);
}

// タイル内の全メッシュを走査して、gml_id ごとの batchid を引けるようにする。
//   gml_id は建物ごとに一意なので、batchid → gml_id の対応表を1本作れば足りる。
function gmlIndexOf(modelScene) {
  if (modelScene.__gmlIndex) return modelScene.__gmlIndex;
  const map = new Map();   // gmlId -> batchid
  const bt = modelScene.batchTable;
  let ids = null;
  try { ids = bt ? bt.getData('gml_id') : null; } catch (e) { ids = null; }
  if (ids) for (let b = 0; b < ids.length; b++) if (ids[b]) map.set(ids[b], b);
  modelScene.__gmlIndex = map;
  return map;
}

// 指定 batchid の頂点を、タイル内の全メッシュから集める。
//   併せて「元の座標」を控えておく。編集はいつでも元の座標から作り直す方式にする。
//   ★ 差分を継ぎ足していく方式にすると、めり込み↔嵩上げを行き来したときに
//     底面判定の前提が崩れて形が壊れる。毎回まっさらから作れば取り違えようがない。
function collectBuildingVerts(modelScene, batchId) {
  return collectBuildingVertsMulti(modelScene, new Set([batchId])).get(batchId) || [];
}

// 複数の建物ぶんをタイル1回の走査でまとめて集める。
//   ★ 1棟ずつ collectBuildingVerts を呼ぶと「棟数 × 頂点数」の掛け算になる。
//     矩形選択では数千棟を一度に扱うので、まとめ操作が現実的な速さで終わらなくなる
//     （実測: 全画面の矩形で3961棟を選んで1.8秒）。走査は必ず1回にまとめること。
function collectBuildingVertsMulti(modelScene, batchIds) {
  const out = new Map();   // batchId -> parts[]
  if (!batchIds.size) return out;
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g && g.attributes.position;
    const bid = g && g.attributes._batchid;
    if (!pos || !bid) return;
    const idxsByBid = new Map();
    for (let i = 0; i < pos.count; i++) {
      const b = bid.getX(i);
      if (!batchIds.has(b)) continue;
      let a = idxsByBid.get(b);
      if (!a) { a = []; idxsByBid.set(b, a); }
      a.push(i);
    }
    if (!idxsByBid.size) return;
    // 元の座標を控える（対象の頂点ぶんだけ。編集した棟しか持たないので軽い）
    let store = g.__editOrig;
    if (!store) { store = new Map(); g.__editOrig = store; }
    for (const [b, idxs] of idxsByBid) {
      let orig = store.get(b);
      if (!orig) {
        orig = new Float32Array(idxs.length * 3);
        for (let k = 0; k < idxs.length; k++) {
          const i = idxs[k];
          orig[k * 3] = pos.getX(i); orig[k * 3 + 1] = pos.getY(i); orig[k * 3 + 2] = pos.getZ(i);
        }
        store.set(b, orig);
      }
      let parts = out.get(b);
      if (!parts) { parts = []; out.set(b, parts); }
      parts.push({ mesh, idxs: Uint32Array.from(idxs), orig, batchId: b });
    }
  });
  return out;
}

// =========================================================================
// 編集の適用
// =========================================================================
const _weWorld = new THREE.Matrix4();
const _weNormal = new THREE.Matrix3();
const _weUp = new THREE.Vector3();

// 建物の底面のワールドY（＝接地高さ）を、タイル内の全メッシュをまたいで求める。
//   ⚠️ メッシュ単位で測ると屋根だけ・壁だけの断片になり、底面を取り違える。
function baseWorldY(parts) {
  let minY = Infinity;
  const updatedRoots = new Set();
  for (const p of parts) {
    if (!computeClipMeshWorld(p.mesh, _weWorld, updatedRoots)) continue;
    const e = _weWorld.elements;
    for (let k = 0; k < p.idxs.length; k++) {
      const x = p.orig[k * 3], y = p.orig[k * 3 + 1], z = p.orig[k * 3 + 2];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];   // ワールドYだけ要る
      if (wy < minY) minY = wy;
    }
  }
  return minY;
}

// 高さの変更を、控えておいた元の座標から作り直して当てる。
//   ★ 上げるときも下げるときも【建物は平行移動だけ】。壁を引き伸ばすと窓や外壁の
//     テクスチャがそのまま間延びしてしまうので、浮いたぶんは別ジオメトリの柱
//     （底面と同じ平面図形の押し出し）を継ぎ足して埋める＝buildColumn の役目。
function applyHeight(parts, dy) {
  const updatedRoots = new Set();
  for (const p of parts) {
    const g = p.mesh.geometry;
    const pos = g.attributes.position;
    const hasWorld = computeClipMeshWorld(p.mesh, _weWorld, updatedRoots);
    // ワールドの「上」をこのメッシュのローカル空間へ引き戻す。
    //   ⚠️ ジオメトリの +Y は鉛直ではない（ECEF系）。ここを省くと斜めにずれる。
    _weUp.set(0, 1, 0);
    if (hasWorld) {
      _weNormal.setFromMatrix4(_weWorld).invert();
      _weUp.applyMatrix3(_weNormal);
    }
    for (let k = 0; k < p.idxs.length; k++) {
      const i = p.idxs[k];
      const ox = p.orig[k * 3], oy = p.orig[k * 3 + 1], oz = p.orig[k * 3 + 2];
      pos.setXYZ(i, ox + _weUp.x * dy, oy + _weUp.y * dy, oz + _weUp.z * dy);
    }
    pos.needsUpdate = true;
    // 形が変わったので、レイキャストと視錐台カリングの当たり判定を作り直す
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
}

// ---- 嵩上げの柱 --------------------------------------------------------
//   持ち上げた建物の下にできる隙間を、底面と同じ平面図形の柱で埋める。
//   ★ 平面図形は【壁の一番下の辺】を拾って作る。底面キャップ（床面）は LOD2/LOD3 では
//     持っていない建物が多く（縦断図の断面が⊓形に開いたのと同じ理由）、床面から
//     footprint を取ろうとすると柱が作れない。壁の下端は必ずあるので確実。
//     凹んだ形・中庭のある形でも、辺をそのまま押し出すだけなので正しく回る。
const columnMat = new THREE.MeshStandardMaterial({
  color: 0xd8402f,          // 嵩増しした部分だとひと目で分かるよう赤で塗る
  roughness: 0.85, metalness: 0.0,
  side: THREE.DoubleSide,   // 柱の内側が見えても穴が開いて見えないように
  clippingPlanes: buildingClipPlanes,   // 箱庭表示のとき建物と同じ箱で切る
});
const columns = new Map();   // gmlId -> THREE.Mesh

// 柱1本ぶんのマテリアルを作る。
//   ★ 透明度は棟ごとに違うので、共有マテリアルではなく複製を持たせる。
//   ⚠️ Material.clone() は clippingPlanes を【複製】してしまい、
//     updateClipPlanes が動かす本体と切り離される（箱庭の箱に追従しなくなる）。
//     複製したあとに必ず元の配列を差し直すこと。
function makeColumnMat() {
  const m = columnMat.clone();
  m.clippingPlanes = buildingClipPlanes;
  return m;
}

// 柱の透明度を建物に合わせる。
function applyColumnOpacity(mesh, opacity) {
  const m = mesh.material;
  m.opacity = opacity;
  const t = opacity < 1;
  if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
}

function disposeColumn(gmlId) {
  const m = columns.get(gmlId);
  if (!m) return;
  columns.delete(gmlId);
  clipMeshes.delete(m);      // 断面の対象からも外す
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();
}

// 建物の三角形から「壁の下端の辺」を拾って、baseY から baseY+dy まで押し出す。
//   戻り値はワールド座標の頂点配列。
function columnVertices(parts, baseY, dy) {
  const out = [];
  const updatedRoots = new Set();
  const wv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const p of parts) {
    const g = p.mesh.geometry;
    const pos = g.attributes.position;
    const bid = g.attributes._batchid;
    const idx = g.index ? g.index.array : null;
    if (!computeClipMeshWorld(p.mesh, _weWorld, updatedRoots)) continue;
    // 「元の座標」で判定する必要がある（この時点で建物はもう持ち上がっているため）
    const slot = new Map();
    for (let k = 0; k < p.idxs.length; k++) slot.set(p.idxs[k], k);
    const origWorld = (i) => {
      const k = slot.get(i);
      return new THREE.Vector3(p.orig[k * 3], p.orig[k * 3 + 1], p.orig[k * 3 + 2])
        .applyMatrix4(_weWorld);
    };
    const triCount = (idx ? idx.length : pos.count) / 3;
    const targetBid = p.batchId;
    for (let f = 0; f < triCount; f++) {
      const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
      if (bid && bid.getX(i0) !== targetBid) continue;
      if (!slot.has(i0) || !slot.has(i1) || !slot.has(i2)) continue;
      wv[0].copy(origWorld(i0)); wv[1].copy(origWorld(i1)); wv[2].copy(origWorld(i2));
      const atBase = [
        wv[0].y <= baseY + BASE_EPS,
        wv[1].y <= baseY + BASE_EPS,
        wv[2].y <= baseY + BASE_EPS,
      ];
      const nBase = atBase[0] + atBase[1] + atBase[2];
      if (nBase === 3) {
        // 床面キャップ。柱の底として、元の位置のまま置いて下から見ても塞がるようにする
        out.push(wv[0].x, wv[0].y, wv[0].z, wv[1].x, wv[1].y, wv[1].z, wv[2].x, wv[2].y, wv[2].z);
        continue;
      }
      if (nBase !== 2) continue;   // 壁の下端の辺を持つ三角形だけが柱を作る
      // 三角形の巻き順のまま辺を取る（そうすれば柱の面も外向きに揃う）
      for (let e = 0; e < 3; e++) {
        const a = e, b = (e + 1) % 3;
        if (!atBase[a] || !atBase[b]) continue;
        const ax = wv[a].x, ay = wv[a].y, az = wv[a].z;
        const bx = wv[b].x, by = wv[b].y, bz = wv[b].z;
        // 下の辺(a,b) と、dy だけ持ち上げた辺(a',b') で四角形を張る
        out.push(ax, ay, az, bx, by, bz, bx, by + dy, bz);
        out.push(ax, ay, az, bx, by + dy, bz, ax, ay + dy, az);
      }
    }
  }
  return out;
}

// 嵩上げの柱を作り直す（dy<=0 なら消すだけ）。
function rebuildColumn(gmlId, parts, dy) {
  disposeColumn(gmlId);
  if (dy <= 0 || !parts.length) return;
  const baseY = baseWorldY(parts);
  if (!Number.isFinite(baseY)) return;
  const verts = columnVertices(parts, baseY, dy);
  if (verts.length < 9) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, makeColumnMat());
  mesh.renderOrder = 0;
  mesh.__colDy = dy;   // 同じ高さのまま透明度だけ変わったときに作り直しを省くための控え
  scene.add(mesh);
  // 断面（箱庭・縦断図）にも柱が出るように、切り抜き対象として登録しておく。
  //   computeClipMeshWorld は __clipRoot.parent があれば素直に matrixWorld を使うので、
  //   scene 直下に置いたこのメッシュ自身を root として登録すれば正しく働く。
  mesh.__clipRoot = mesh;
  mesh.__clipGroup = scene;
  mesh.__clipTile = null;
  mesh.__clipIsTerrain = false;
  mesh.updateWorldMatrix(true, false);
  clipMeshes.add(mesh);
  columns.set(gmlId, mesh);
}

// 非表示は「頂点を1点に潰す」で実現する（三角形が面積ゼロになって描かれなくなる）。
//   ★ 透明マテリアルにする手もあるが、非表示のためだけに tile 全体を半透明扱いに
//     すると描画順の問題が出るうえ重い。潰すだけならマテリアルに一切触らずに済み、
//     元の座標を控えてあるので戻すのも確実。
function applyCollapse(parts) {
  for (const p of parts) {
    const g = p.mesh.geometry;
    const pos = g.attributes.position;
    const cx = p.orig[0], cy = p.orig[1], cz = p.orig[2];
    for (let k = 0; k < p.idxs.length; k++) pos.setXYZ(p.idxs[k], cx, cy, cz);
    pos.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
}

// ---- 透過度 ------------------------------------------------------------
//   1タイルの1メッシュに何十棟も入っているので、マテリアルの opacity では棟ごとに
//   変えられない。頂点ごとの alpha を持たせてシェーダで掛ける。
//   ★ 既存の色分け（tiles.js）は `color` 属性を使うので、そこと取り合いにならないよう
//     専用の attribute（editAlpha）を足す方式にしている。
//   ⚠️ シェーダを差し替えたマテリアルを使うメッシュ全部に editAlpha が無いと、
//     属性が 0 と解釈されて【そのタイルが丸ごと消える】。パッチはタイル単位で、
//     全メッシュに 1 で埋めた属性を付けてから行うこと。
function ensureAlphaPatched(modelScene) {
  if (modelScene.__alphaPatched) return;
  modelScene.__alphaPatched = true;
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g && g.attributes.position;
    if (!pos) return;
    if (!g.attributes.editAlpha) {
      const a = new Float32Array(pos.count).fill(1);
      g.setAttribute('editAlpha', new THREE.BufferAttribute(a, 1));
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || m.__editAlphaPatched) continue;
      m.__editAlphaPatched = true;
      m.transparent = true;
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, rendererRef) => {
        if (prev) prev(shader, rendererRef);
        shader.vertexShader = 'attribute float editAlpha;\nvarying float vEditAlpha;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vEditAlpha = editAlpha;',
          );
        shader.fragmentShader = 'varying float vEditAlpha;\n' +
          shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\n  gl_FragColor.a *= vEditAlpha;',
          );
      };
      // パッチ前後で同じプログラムを使い回されないようにキーを分ける
      const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
      m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|editAlpha';
      m.needsUpdate = true;
    }
  });
}

// このタイルに半透明の建物が1棟でも残っているかで、マテリアルの transparent を切り替える。
//   ★ 一度パッチしたシェーダはそのままでよい（alpha=1 を掛けるだけなので無害）が、
//     transparent を立てっぱなしにすると、そのタイルの建物が全部【半透明の描画順】に
//     回り続けて、交差する形で描画順の乱れが出るうえ無駄に重い。使っていないときは倒す。
function refreshTransparentFlag(modelScene) {
  if (!modelScene.__alphaPatched) return;
  let any = false;
  modelScene.traverse((mesh) => {
    if (any || !mesh.isMesh) return;
    const a = mesh.geometry && mesh.geometry.attributes.editAlpha;
    if (!a) return;
    for (let i = 0; i < a.count; i++) if (a.getX(i) < 1) { any = true; return; }
  });
  modelScene.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || !m.__editAlphaPatched || m.transparent === any) continue;
      m.transparent = any;
      m.needsUpdate = true;
    }
  });
}

function applyOpacity(modelScene, parts, opacity) {
  if (opacity >= 1 && !modelScene.__alphaPatched) return;   // まだ誰も透過していない＝何もしない
  if (opacity < 1) ensureAlphaPatched(modelScene);
  for (const p of parts) {
    const a = p.mesh.geometry.attributes.editAlpha;
    if (!a) continue;
    for (let k = 0; k < p.idxs.length; k++) a.setX(p.idxs[k], opacity);
    a.needsUpdate = true;
  }
  refreshTransparentFlag(modelScene);
}

// 元の座標へ戻す（高さ変更・非表示の解除）。
function restoreGeometry(parts) {
  for (const p of parts) {
    const g = p.mesh.geometry;
    const pos = g.attributes.position;
    for (let k = 0; k < p.idxs.length; k++) {
      pos.setXYZ(p.idxs[k], p.orig[k * 3], p.orig[k * 3 + 1], p.orig[k * 3 + 2]);
    }
    pos.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
}

// 集めた頂点に編集を当てる。
function applyEditToParts(modelScene, parts, edit) {
  if (!parts || !parts.length) return;
  if (edit.hidden) applyCollapse(parts);
  else if (edit.dy !== 0) applyHeight(parts, edit.dy);
  else restoreGeometry(parts);
  applyOpacity(modelScene, parts, edit.hidden ? 1 : edit.opacity);
}
// 1棟ぶんの編集を、あるタイルに当てる。
function applyEditToModel(modelScene, batchId, edit) {
  applyEditToParts(modelScene, collectBuildingVerts(modelScene, batchId), edit);
}

// 嵩上げの柱を作り直す。
//   ★ 同じ建物は複数のタイル（LOD違い）に入っているが、柱は1本だけあればよい。
//     いちばん頂点数の多い＝最も細かい表現から作る（粗いLODで作ると footprint が荒れる）。
function rebuildColumnsFor(gmlIds, { force = false } = {}) {
  const need = new Set();
  for (const gmlId of gmlIds) {
    const edit = edits.get(gmlId);
    if (!edit || edit.hidden || edit.dy <= 0) { disposeColumn(gmlId); continue; }
    const cur = columns.get(gmlId);
    // 高さが変わっていなければ形はそのままでよい（透明度だけ合わせて作り直しを省く）。
    //   ★ 透明度スライダーを動かすたびに数百棟ぶんの柱を作り直すと目に見えて重くなる。
    if (!force && cur && cur.__colDy === edit.dy) {
      applyColumnOpacity(cur, edit.opacity);
      continue;
    }
    need.add(gmlId);
  }
  if (!need.size) return;
  // タイルごとに1回だけ走査し、棟ごとに「いちばん頂点数の多い＝細かい」表現を選ぶ
  const best = new Map();   // gmlId -> { parts, count }
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      for (const gmlId of need) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.set(b, gmlId);
      }
      if (!wanted.size) return;
      const got = collectBuildingVertsMulti(modelScene, new Set(wanted.keys()));
      for (const [b, parts] of got) {
        const gmlId = wanted.get(b);
        let n = 0;
        for (const p of parts) n += p.idxs.length;
        const cur = best.get(gmlId);
        if (!cur || n > cur.count) best.set(gmlId, { parts, count: n });
      }
    });
  }
  for (const gmlId of need) {
    const b = best.get(gmlId);
    const edit = edits.get(gmlId);
    rebuildColumn(gmlId, b ? b.parts : [], edit.dy);
    const col = columns.get(gmlId);
    if (col) applyColumnOpacity(col, edit.opacity);   // 建物と同じ透明度に揃える
  }
}
const rebuildColumnFor = (gmlId) => rebuildColumnsFor([gmlId]);

// タイルが届いたときに、そのタイルに含まれる編集済みの建物へまとめて当て直す。
//   ★ これが無いと、カメラを動かしてタイルが入れ替わった瞬間に編集が消える。
function applyEditsToModel(modelScene) {
  if (!edits.size) return;
  const index = gmlIndexOf(modelScene);
  if (!index.size) return;
  const wanted = new Map();   // batchId -> gmlId
  const needColumn = [];
  for (const [gmlId, edit] of edits) {
    const batchId = index.get(gmlId);
    if (batchId === undefined) continue;
    wanted.set(batchId, gmlId);
    if (edit.dy > 0 && !edit.hidden) needColumn.push(gmlId);
  }
  if (!wanted.size) return;
  const got = collectBuildingVertsMulti(modelScene, new Set(wanted.keys()));
  for (const [b, parts] of got) {
    applyEditToParts(modelScene, parts, edits.get(wanted.get(b)) || defaultEdit());
  }
  // 届いたタイルの方が細かければ、柱もそちらから作り直す。
  //   高さが同じでも LOD が変われば footprint が変わるので、ここは必ず作り直す。
  if (needColumn.length) rebuildColumnsFor(needColumn, { force: true });
}
setBuildingEditHook(applyEditsToModel);

// 読み込み済みの全タイルへ、指定した建物すべての編集を当て直す。
//   同じ建物が複数のタイル（LOD違い・隣接タイル）に入っていることがあるので全部見る。
//   ★ 棟ごとに全タイルを回すのではなく、タイルごとに1回走査して全棟をさばく。
function applyEditsEverywhere(gmlIds) {
  const set = gmlIds instanceof Set ? gmlIds : new Set(gmlIds);
  if (!set.size) return;
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      for (const gmlId of set) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.set(b, gmlId);
      }
      if (!wanted.size) return;
      const got = collectBuildingVertsMulti(modelScene, new Set(wanted.keys()));
      for (const [b, parts] of got) {
        applyEditToParts(modelScene, parts, edits.get(wanted.get(b)) || defaultEdit());
      }
    });
  }
  rebuildColumnsFor(set);
  markSectionDirty();   // 断面（箱庭・縦断図）にも形の変化を反映する
  requestRender();
}
const applyEditEverywhere = (gmlId) => applyEditsEverywhere([gmlId]);

// =========================================================================
// 選択（レイキャスト）
// =========================================================================
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

// 画面座標(px)から建物を1棟拾う。当たらなければ null。
function pickBuildingAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  _rc.setFromCamera(_ndc, camera);
  const hits = _rc.intersectObjects(wardTiles.map((t) => t.group), true);
  for (const h of hits) {
    const g = h.object.geometry;
    const bid = g && g.attributes._batchid;
    if (!bid || !h.face) continue;
    // 三角形の3頂点は同じ建物に属するので、代表して1つ目を見ればよい
    const batchId = bid.getX(h.face.a);
    const modelScene = h.object.__clipRoot;
    const gmlId = gmlIdOf(modelScene, batchId);
    if (!gmlId) continue;
    return {
      gmlId, batchId, modelScene, point: h.point.clone(),
      name: btValue(modelScene.batchTable, 'gml:name', batchId),
      usage: btValue(modelScene.batchTable, 'bldg:usage', batchId),
      height: btValue(modelScene.batchTable, 'bldg:measuredHeight', batchId),
      buildingId: btValue(modelScene.batchTable, 'uro:BuildingIDAttribute_uro:buildingID', batchId),
    };
  }
  return null;
}

// ---- 選択中の建物を示す枠 ------------------------------------------------
//   選択した棟だけを縁取りたいが、メッシュは棟ごとに分かれていないので
//   「その棟の頂点から作った箱」を線で描く（軽く、LODが変わっても作り直せる）。
const boxGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const boxMat = new THREE.LineBasicMaterial({
  color: SELECT_COLOR, depthTest: false, transparent: true, opacity: 0.9,
});
const selectionGroup = new THREE.Group();
selectionGroup.frustumCulled = false;
scene.add(selectionGroup);
// 枠は選択数だけ要るので使い回す（毎回作り直すと GC が増える）
const boxPool = [];
function boxAt(i) {
  let b = boxPool[i];
  if (!b) {
    b = new THREE.LineSegments(boxGeom, boxMat);
    b.renderOrder = 999;
    b.frustumCulled = false;
    boxPool[i] = b;
    selectionGroup.add(b);
  }
  return b;
}

const _selBox = new THREE.Box3();
const _selV = new THREE.Vector3();

// 選択中の建物すべての境界箱を、タイル1回の走査でまとめて測る。
//   ★ 1棟ずつ measureBuildingBox を呼ぶと棟数×頂点数になって現実的でない
//     （矩形選択で数千棟を選べるため）。
function measureSelectionBoxes() {
  const boxes = new Map();   // gmlId -> Box3
  if (!editState.selection.size) return boxes;
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      for (const gmlId of editState.selection.keys()) {
        const b = index.get(gmlId);
        if (b !== undefined) wanted.set(b, gmlId);
      }
      if (!wanted.size) return;
      modelScene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
        if (!pos || !bid) return;
        if (!computeClipMeshWorld(mesh, _weWorld, updatedRoots)) return;
        for (let i = 0; i < pos.count; i++) {
          const gmlId = wanted.get(bid.getX(i));
          if (gmlId === undefined) continue;
          let box = boxes.get(gmlId);
          if (!box) { box = new THREE.Box3(); boxes.set(gmlId, box); }
          _selV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_weWorld);
          box.expandByPoint(_selV);
        }
      });
    });
  }
  return boxes;
}

// 選択中の建物すべてに枠を合わせる。
function updateSelectionBox() {
  const boxes = measureSelectionBoxes();
  let n = 0;
  for (const info of editState.selection.values()) {
    const box = boxes.get(info.gmlId);
    if (!box || box.isEmpty()) continue;
    _selBox.copy(box);
    // ★ 建物そのものの高さは、柱を足す前にここで控える（UI の総高さ表示に使う）。
    _selBox.getSize(_selV);
    info.measuredHeight = _selV.y;
    // 枠は嵩上げの柱まで含めて囲う（持ち上げた建物と柱で1つの塊に見えるように）
    const col = columns.get(info.gmlId);
    if (col) {
      col.geometry.computeBoundingBox();
      _selBox.union(col.geometry.boundingBox);
    }
    const b = boxAt(n++);
    _selBox.getSize(_selV);
    b.scale.set(Math.max(_selV.x, 0.1), Math.max(_selV.y, 0.1), Math.max(_selV.z, 0.1));
    _selBox.getCenter(_selV);
    b.position.copy(_selV);
    b.visible = true;
  }
  for (let i = n; i < boxPool.length; i++) boxPool[i].visible = false;
  requestRender();
}

// =========================================================================
// 操作（クリックで選択 / ドラッグで高さ変更）
// =========================================================================
//   ・選択は【ダブルクリック】。シングルクリックだと、カメラを回すつもりの
//     わずかな操作でも建物を掴んでしまい誤指定が多発するため。
//   ・シングルクリック（動かさずに離す）は、選択中の建物以外ならどこでも「選択解除」。
//   ・高さ変更のドラッグは【選択中の建物の上】でのみ始まる。それ以外で始めたドラッグは
//     これまでどおりカメラ操作に渡す。
let drag = null;   // { gmlId, startY, startDy, mPerPx, moved }

// カメラからその地点までの距離をもとに、1pxが何メートルに相当するかを出す。
function metersPerPixelAt(worldPoint) {
  const dist = camera.position.distanceTo(worldPoint);
  const vFov = (camera.fov * Math.PI) / 180;
  return (2 * Math.tan(vFov / 2) * dist) / renderer.domElement.clientHeight;
}

// 選択中の建物以外を押したときの記録。動かさずに離したら「選択の解除」にする。
//   ★ ドラッグ（カメラの回転・パン）と区別する必要があるので、押した位置を覚えておいて
//     離した位置との差で判定する。カメラ操作の邪魔はしない（controls はそのまま動く）。
let clearDown = null;

// ---- 矩形選択（Shift＋ドラッグ）----------------------------------------
//   ★ 判定は「建物の境界箱の中心が矩形の中に入るか」。CADの窓選択と同じ考え方で、
//     大きな建物が矩形にかすっただけで巻き込まれるのを防ぐ。
//   Alt を併用すると、今の選択に足し込む。
let rect = null;   // { x0,y0,x1,y1, add }
let rectEl = null;
function showRectBox() {
  if (!rectEl) {
    rectEl = document.createElement('div');
    rectEl.style.cssText = 'position:fixed; border:1px solid #4ea1ff; background:rgba(78,161,255,0.15);' +
      'pointer-events:none; z-index:9999;';
    document.body.appendChild(rectEl);
  }
  const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1);
  rectEl.style.left = x + 'px';
  rectEl.style.top = y + 'px';
  rectEl.style.width = Math.abs(rect.x1 - rect.x0) + 'px';
  rectEl.style.height = Math.abs(rect.y1 - rect.y0) + 'px';
  rectEl.style.display = '';
}
function hideRectBox() { if (rectEl) rectEl.style.display = 'none'; }

const _rsBox = new THREE.Box3();
const _rsV = new THREE.Vector3();
// 読み込み済みの建物すべての境界箱を batchid ごとに測って、矩形に入るものを選ぶ。
//   ★ 同じ建物が複数タイル（LOD違い）に入っているので gml_id でまとめる。
function applyRectSelection(r) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  if (x1 - x0 < 3 && y1 - y0 < 3) return;   // ただのクリックとみなす
  const dom = renderer.domElement;
  const vr = dom.getBoundingClientRect();
  const boxes = new Map();   // gmlId -> {box, info}
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const bt = modelScene.batchTable;
      let ids = null;
      try { ids = bt ? bt.getData('gml_id') : null; } catch (e) { ids = null; }
      if (!ids) return;
      modelScene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
        if (!pos || !bid) return;
        if (!computeClipMeshWorld(mesh, _weWorld, updatedRoots)) return;
        for (let i = 0; i < pos.count; i++) {
          const b = bid.getX(i);
          const gmlId = ids[b];
          if (!gmlId) continue;
          let rec = boxes.get(gmlId);
          if (!rec) {
            rec = { box: new THREE.Box3(), batchId: b, modelScene };
            boxes.set(gmlId, rec);
          }
          _rsV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_weWorld);
          rec.box.expandByPoint(_rsV);
        }
      });
    });
  }
  const hits = [];
  for (const [gmlId, rec] of boxes) {
    rec.box.getCenter(_rsV);
    _rsV.project(camera);
    if (_rsV.z > 1) continue;                     // カメラの後ろ
    const px = vr.left + (_rsV.x + 1) / 2 * vr.width;
    const py = vr.top + (1 - _rsV.y) / 2 * vr.height;
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    const ms = rec.modelScene, b = rec.batchId;
    hits.push({
      gmlId,
      name: btValue(ms.batchTable, 'gml:name', b),
      usage: btValue(ms.batchTable, 'bldg:usage', b),
      height: btValue(ms.batchTable, 'bldg:measuredHeight', b),
      buildingId: btValue(ms.batchTable, 'uro:BuildingIDAttribute_uro:buildingID', b),
    });
  }
  setSelection(hits, { add: r.add });
}

// 押した先が「いま選択中の建物」かどうか。
function isSelectedHit(hit) {
  return !!(hit && editState.selection.has(hit.gmlId));
}

function onPointerDown(ev) {
  if (!editState.enabled || ev.button !== 0) return;
  // Shift＋ドラッグは矩形選択。カメラ操作より先に横取りする。
  if (ev.shiftKey) {
    rect = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY, add: ev.altKey };
    controls.enabled = false;
    capturePointer(ev.pointerId, true);
    showRectBox();
    return;
  }
  const hit = pickBuildingAt(ev.clientX, ev.clientY);
  if (!isSelectedHit(hit)) {
    // 地面・空・選択していない建物。カメラ操作はそのまま通しつつ、
    // 動かさずに離したときだけ選択を解除する。
    clearDown = { x: ev.clientX, y: ev.clientY };
    return;
  }
  clearDown = null;
  // 選択中の全棟の「開始時の dy」を控える（まとめて同じ量だけ動かすため）
  const startDys = new Map();
  for (const gmlId of editState.selection.keys()) {
    startDys.set(gmlId, (edits.get(gmlId) || defaultEdit()).dy);
  }
  drag = {
    hit, startDys,
    startY: ev.clientY,
    mPerPx: metersPerPixelAt(hit.point) * DRAG_GAIN,
    moved: false,
  };
  // ドラッグ中はカメラを止める（回転と高さ変更が同時に起きないように）
  controls.enabled = false;
  capturePointer(ev.pointerId, true);
}

// ポインタ捕捉は「取れなくても操作自体は成立する」おまけなので、例外は握りつぶす。
//   ⚠️ ここで投げさせてはいけない。捕捉に失敗した pointerId で release すると
//     NotFoundError が飛び、その先の【選択の確定】まで巻き添えで飛ぶ。
function capturePointer(pointerId, on) {
  const dom = renderer.domElement;
  try {
    if (on) dom.setPointerCapture?.(pointerId);
    else dom.releasePointerCapture?.(pointerId);
  } catch (e) { /* 捕捉できなくてもドラッグは成立する */ }
}

function onPointerMove(ev) {
  if (rect) { rect.x1 = ev.clientX; rect.y1 = ev.clientY; showRectBox(); return; }
  if (!drag) return;
  const dyPx = drag.startY - ev.clientY;           // 上へ動かすと正
  if (!drag.moved && Math.abs(dyPx) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  // ★ ドラッグは【選択中の全棟】に同じ量を足す（＝「同じ高さだけ嵩上げ」）。
  //   1棟だけ選んでいれば、これまでどおりその棟だけが動く。
  const delta = dyPx * drag.mPerPx;
  for (const [gmlId, startDy] of drag.startDys) {
    const edit = edits.get(gmlId) || defaultEdit();
    edit.dy = startDy + delta;
    edit.hidden = false;                           // 高さをいじるなら表示状態に戻す
    edits.set(gmlId, edit);
  }
  applyEditsEverywhere(drag.startDys.keys());      // 走査は1回にまとめる
  updateSelectionBox();
  syncUI();
}

function onPointerUp(ev) {
  if (rect) {
    const r = rect;
    rect = null;
    controls.enabled = true;
    capturePointer(ev.pointerId, false);
    hideRectBox();
    applyRectSelection(r);
    return;
  }
  if (!drag) {
    // 選択中の建物以外を「動かさずに」クリックした＝選択を解除する
    if (clearDown && editState.enabled) {
      const moved = Math.hypot(ev.clientX - clearDown.x, ev.clientY - clearDown.y);
      if (moved < DRAG_THRESHOLD_PX && editState.selection.size) clearSelection();
    }
    clearDown = null;
    return;
  }
  const d = drag;
  drag = null;
  controls.enabled = true;
  capturePointer(ev.pointerId, false);
  if (d.moved) for (const gmlId of d.startDys.keys()) pruneIfPristine(gmlId);
}

// 選択は【ダブルクリック】でのみ行う。
//   ★ 先行するシングルクリックが選択解除として走るが、その直後にここで選び直すので
//     結果は「その建物が選ばれた状態」に落ち着く。
//   Shift＋ダブルクリックなら、選択に足す／外す（1棟ずつの調整用）。
function onDoubleClick(ev) {
  if (!editState.enabled) return;
  const hit = pickBuildingAt(ev.clientX, ev.clientY);
  if (!hit) return;
  if (ev.shiftKey) toggleSelection(hit);
  else setSelection([hit]);
}

// 何も変わっていない編集は捨てる（「初期状態」と同じ扱いに戻す）。
function pruneIfPristine(gmlId) {
  const e = edits.get(gmlId);
  if (e && isPristine(e)) { edits.delete(gmlId); disposeColumn(gmlId); }
  syncUI();
}

// 選択を差し替える／足す／外す。
//   hits … pickBuildingAt が返した形の配列（gmlId とラベル用の属性を持つ）
function setSelection(hits, { add = false } = {}) {
  if (!add) editState.selection.clear();
  for (const h of hits) {
    editState.selection.set(h.gmlId, {
      gmlId: h.gmlId, name: h.name, usage: h.usage, height: h.height,
      buildingId: h.buildingId, measuredHeight: NaN,
    });
    editState.primary = editState.selection.get(h.gmlId);
  }
  if (!editState.selection.size) editState.primary = null;
  updateSelectionBox();   // ここで各棟の measuredHeight も測る
  syncUI();
}
function toggleSelection(hit) {
  if (editState.selection.has(hit.gmlId)) {
    editState.selection.delete(hit.gmlId);
    if (editState.primary && editState.primary.gmlId === hit.gmlId) {
      const last = [...editState.selection.values()].pop();
      editState.primary = last || null;
    }
    updateSelectionBox();
    syncUI();
  } else {
    setSelection([hit], { add: true });
  }
}
const clearSelection = () => setSelection([]);

// 高さスライダーの目盛り（総高さ[m]）。0〜100m 固定。
const SLIDER_MIN_H = 0, SLIDER_MAX_H = 100;
const clampSlider = (v) => Math.min(SLIDER_MAX_H, Math.max(SLIDER_MIN_H, v));
// 元の高さが分からない建物では、変更量そのものを目盛りとして扱う（0m 起点）。
const sliderHeight = (baseH, dy) => (Number.isFinite(baseH) && baseH > 0 ? baseH : 0) + dy;

// 1棟の「元の高さ」[m]。
//   属性 bldg:measuredHeight があればそれを使い、無ければ実際のジオメトリから測る。
//   ★ 高さ変更は上げも下げも【平行移動】なので、建物そのものの高さは編集しても変わらない。
//     嵩上げぶんは別ジオメトリの柱なので、ここで測る値には入らない。
function baseHeightOf(info) {
  if (!info) return NaN;
  const attr = Number(info.height);
  if (Number.isFinite(attr) && attr > 0) return attr;
  return Number.isFinite(info.measuredHeight) ? info.measuredHeight : NaN;
}
const baseHeightOfSelected = () => baseHeightOf(editState.primary);

// =========================================================================
// UI
// =========================================================================
let ui = null;
function syncUI() {
  if (!ui) return;
  const n = editState.selection.size;
  ui.panel.style.display = editState.enabled ? '' : 'none';
  if (!n) {
    ui.info.textContent = editState.enabled
      ? '建物をダブルクリックで選択／Shift＋ドラッグで矩形選択（Alt併用で追加）'
      : '';
    ui.id.textContent = '';
    ui.controls.style.display = 'none';
    ui.count.textContent = edits.size ? `編集中: ${edits.size} 棟` : '';
    return;
  }
  const sel = editState.primary;
  const e = edits.get(sel.gmlId) || defaultEdit();
  const baseH = baseHeightOfSelected();
  if (n > 1) {
    // 複数選択中は、まとめ操作が主役なので棟数と高さの範囲だけ出す
    let lo = Infinity, hi = -Infinity;
    for (const info of editState.selection.values()) {
      const b = baseHeightOf(info);
      if (Number.isFinite(b)) { lo = Math.min(lo, b); hi = Math.max(hi, b); }
    }
    const range = Number.isFinite(lo) ? `／ 元の高さ ${lo.toFixed(1)}〜${hi.toFixed(1)}m` : '';
    ui.info.textContent = `${n} 棟を選択中 ${range}`;
    ui.id.textContent = '';
  } else {
    const head = [sel.name || '（名称なし）'];
    if (Number.isFinite(baseH) && baseH > 0) head.push(`元の高さ ${baseH.toFixed(1)}m`);
    if (sel.usage) head.push(sel.usage);
    ui.info.textContent = head.join(' ／ ');
    // 建物IDは PLATEAU の建物ID属性。無いタイルもあるので gml_id で補う。
    ui.id.textContent = sel.buildingId ? `建物ID: ${sel.buildingId}` : `gml_id: ${sel.gmlId}`;
    ui.id.title = `gml_id: ${sel.gmlId}`;
  }
  ui.controls.style.display = '';
  ui.opacity.value = String(Math.round(e.opacity * 100));
  ui.opacityVal.textContent = `${Math.round(e.opacity * 100)}%`;
  ui.hidden.checked = e.hidden;
  // スライダーは「変更量」ではなく【総高さ】を 0〜100m の固定目盛りで表す。
  //   ★ 元の高さの目盛りから始まるので、つまみの位置がそのまま「今の建物の高さ」になる。
  //     元が100mを超える建物では目盛りに収まらないので端に寄せて表示する
  //     （その状態からつまみを動かすと、その高さまで下げる操作になる）。
  ui.dy.value = String(clampSlider(sliderHeight(baseH, e.dy)));
  // 総高さを主に出し、元からどれだけ変えたかを添える
  const total = sliderHeight(baseH, e.dy);
  const delta = e.dy === 0 ? ''
    : (e.dy > 0 ? `（+${e.dy.toFixed(1)} 嵩上げ）` : `（${e.dy.toFixed(1)} めり込み）`);
  ui.dyVal.textContent = n > 1
    ? `${total.toFixed(1)} m ${delta}（動かすと ${n} 棟すべて同じ高さになります）`
    : `${total.toFixed(1)} m ${delta}`;
  ui.count.textContent = edits.size ? `編集中: ${edits.size} 棟` : '';
}

// 選択中の【全棟】に同じ変更を当てる。fn には (編集内容, その棟の情報) が渡る。
function mutateSelected(fn) {
  if (!editState.selection.size) return;
  const touched = new Set();
  for (const info of editState.selection.values()) {
    const e = edits.get(info.gmlId) || defaultEdit();
    fn(e, info);
    edits.set(info.gmlId, e);
    touched.add(info.gmlId);
  }
  applyEditsEverywhere(touched);            // 走査は1回にまとめる
  for (const gmlId of touched) {
    const e = edits.get(gmlId);
    if (e && isPristine(e)) { edits.delete(gmlId); disposeColumn(gmlId); }
  }
  updateSelectionBox();
  syncUI();
}

// まとめて「同じ高さだけ」上げ下げする（相対）。＝各棟の今の高さに delta を足す。
function raiseSelectedBy(delta) {
  if (!Number.isFinite(delta)) return;
  mutateSelected((e) => { e.dy += delta; e.hidden = false; });
}

// まとめて「全部同じ総高さ」にする（絶対）。
//   ★ 必要な変更量は棟ごとに違う（元の高さが違うため）ので、1棟ずつ差を計算する。
function setSelectedHeight(targetH) {
  if (!Number.isFinite(targetH)) return;
  mutateSelected((e, info) => {
    const baseH = baseHeightOf(info);
    const origin = Number.isFinite(baseH) && baseH > 0 ? baseH : 0;
    e.dy = targetH - origin;
    e.hidden = false;
  });
}

// 選択中を初期状態へ戻す。
function resetSelected() {
  if (!editState.selection.size) return;
  const ids = [...editState.selection.keys()];
  for (const gmlId of ids) edits.delete(gmlId);
  applyEditsEverywhere(ids);   // 編集が無い＝元の座標・不透明で当て直される
  updateSelectionBox();
  syncUI();
}

// 全部を初期状態へ戻す。
function resetAll() {
  const ids = [...edits.keys()];
  edits.clear();
  applyEditsEverywhere(ids);
  updateSelectionBox();
  syncUI();
}

function setEditEnabled(on) {
  editState.enabled = on;
  if (!on) {
    editState.selection.clear();
    editState.primary = null;
    for (const b of boxPool) b.visible = false;
    if (drag) { drag = null; controls.enabled = true; }
    if (rect) { rect = null; hideRectBox(); controls.enabled = true; }
  }
  syncUI();
  requestRender();
}

(function setupUI() {
  const onCb = el('buildingEditOn');
  if (!onCb) return;   // この画面に編集UIが無い構成でも動くように
  ui = {
    panel: el('buildingEditPanel'),
    info: el('buildingEditInfo'),
    id: el('buildingEditId'),
    controls: el('buildingEditControls'),
    opacity: el('buildingEditOpacity'),
    opacityVal: el('buildingEditOpacityVal'),
    hidden: el('buildingEditHidden'),
    dy: el('buildingEditDy'),
    dyVal: el('buildingEditDyVal'),
    count: el('buildingEditCount'),
    bumpAmount: el('buildingEditBumpAmount'),
    bumpBy: el('buildingEditBumpUp'),
    bumpDown: el('buildingEditBumpDown'),
    setToHeight: el('buildingEditSetHeight'),
    setTo: el('buildingEditSetTo'),
  };
  onCb.addEventListener('change', () => setEditEnabled(onCb.checked));
  ui.opacity.addEventListener('input', () => {
    mutateSelected((e) => { e.opacity = Number(ui.opacity.value) / 100; });
  });
  ui.hidden.addEventListener('change', () => {
    mutateSelected((e) => { e.hidden = ui.hidden.checked; });
  });
  // つまみの位置＝目指す総高さ。複数選んでいれば全部その高さに揃う（絶対指定）。
  ui.dy.addEventListener('input', () => setSelectedHeight(Number(ui.dy.value)));
  // まとめて同じ量だけ上げ下げ（相対指定）
  ui.bumpBy.addEventListener('click', () => raiseSelectedBy(Number(ui.bumpAmount.value)));
  ui.bumpDown.addEventListener('click', () => raiseSelectedBy(-Number(ui.bumpAmount.value)));
  // まとめて同じ総高さに（絶対指定。スライダーの範囲外も入れられる数値入力）
  ui.setTo.addEventListener('click', () => setSelectedHeight(Number(ui.setToHeight.value)));
  el('buildingEditReset').addEventListener('click', resetSelected);
  el('buildingEditResetAll').addEventListener('click', resetAll);

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('dblclick', onDoubleClick);
  syncUI();
})();

export {
  editState, edits, setEditEnabled, resetSelected, resetAll,
  applyEditsToModel, updateSelectionBox,
};

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
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { computeClipMeshWorld, clipMeshes, buildingClipPlanes } from './section.js';
import { wardTiles, setBuildingEditHook } from './tiles.js';
// 箱を置く道具。建物編集と同じボタンで出し入れするので、こちらから面倒を見る。
import { setBlocksEnabled, setBlocksOpenHook } from './blocks.js';

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
//   ★ 床面積の集計に使う値（階数・高さ・底面積）も一緒に控える。
//     これらは選択したときにしか測れないが、集計は【選択を解除したあとの編集済み全棟】を
//     対象にしたい。選択情報の側に置いたままだと、選択を外した瞬間に集計から消える。
const defaultEdit = () => ({
  opacity: 1, hidden: false, dy: 0,
  storeys: null, height: null, measuredHeight: NaN, footprint: NaN,
});
const isPristine = (e) => e.opacity === 1 && !e.hidden && e.dy === 0;

// -------------------------------------------------------------------------
// 「今その中に居る建物」を透かす（ストリートビュー用の一時的な見せ方）
//   ★ edits（ユーザーの編集）とは別に持つ。歩いて出入りするたびに変わる一時的な
//     状態なので、セーブに残ってはいけないし、透かしを解いたときは【ユーザーが
//     設定した透過度】に戻す必要がある。だから edits には触れず、別集合で持って
//     描画時に「濃いほう（小さいほう）」を採る。
//   透かす濃さ。0=完全に透明。中の様子と外の街並みの両方が見える程度に。
//   （0.16→0.35→0.60 と実際に歩いて調整した値。薄すぎると建物が消えたように見える）
const SEE_THROUGH_ALPHA = 0.6;
const seeThrough = new Set();   // 一時的に透かしている gml_id
// 透かしを一時的に止める（屋上に立っているとき）。集合や稜線はそのままにして、
// 塗りだけ元に戻す。集合から外してしまうと、稜線も階数の情報も消えてしまう。
let seeThroughOpaque = false;
// その棟を「実際に見ている」メッシュ（内外判定のレイが当たったもの）。
//   稜線と床をどのタイルから作るかを決めるのに使う。
const seeThroughMeshes = new Map();   // gml_id → Mesh | null

// 透かした建物は【面を薄くするぶん、稜線を描いて形が分かるようにする】。
//   面だけ薄くすると建物が消えたようになり、どこに躯体があるのか分からなくなる。
//   ★ 太さを指定できるよう Line2 系（LineMaterial）を使う。素の LineBasicMaterial は
//     linewidth が WebGL でほぼ無視され、常に1pxになる（眺望規制の外周線と同じ理由）。
//     px 指定なので画面サイズを教える必要がある → main.js の onResize が面倒を見る。
const SEE_THROUGH_EDGE_WIDTH = 2;   // 稜線の太さ[px]
const seeThroughEdgeMat = new LineMaterial({
  color: 0x9fd8ff, linewidth: SEE_THROUGH_EDGE_WIDTH,
  transparent: true, opacity: 0.85, depthWrite: false, dashed: false,
});
seeThroughEdgeMat.resolution.set(window.innerWidth, window.innerHeight);
const seeThroughEdgeGroup = new THREE.Group();   // 稜線はタイルの外（scene直下）に置く
seeThroughEdgeGroup.frustumCulled = false;
scene.add(seeThroughEdgeGroup);
const seeThroughEdges = new Map();   // gml_id → { parts: [{line, mesh, box}] }

// 上の階へ上がったときに描く「床」。
//   ★ 形は【その棟の底面（または屋根面）の三角形を、そのまま水平に寝かせたもの】。
//     PLATEAU の LOD1 は footprint を垂直に押し出した角柱なので、底面の形＝どの
//     高さの床の形でもある。L字でも中庭付きでも正しい形が出る（外接矩形で代用
//     すると壁からはみ出す）。
//   ★ ジオメトリは XZ だけワールド座標で持ち、高さは position.y で毎フレーム
//     合わせる。こうすると、歩いて地盤の高さが変わっても足元と床がずれない。
const floorSlabMat = new THREE.MeshBasicMaterial({
  color: 0xccd6e2, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});
const floorSlabs = new Map();   // gml_id → { mesh, rings } | null
// 透かしている棟の「上端の高さ」と「階高」。ストリートビューの仮想フロア
// （2階・3階から外を眺める）で、上限の階と1階ぶんの高さを決めるのに使う。
const seeThroughInfo = new Map();   // gml_id → { boxes[], floorH, storeys, assumed }

/* その建物を実際に描くときの不透明度。ユーザー設定と透かしの濃いほうを採る。 */
function effectiveOpacity(gmlId, edit) {
  const base = edit.hidden ? 1 : edit.opacity;   // 非表示はジオメトリを潰す側で表現される
  const fade = !seeThroughOpaque && gmlId !== null && seeThrough.has(gmlId);
  return fade ? Math.min(base, SEE_THROUGH_ALPHA) : base;
}

const editState = {
  enabled: false,     // 編集モード（ONのときだけクリックで選択・ドラッグできる）
  // 選択は【集合】で持つ。gmlId -> { gmlId, name, usage, height, buildingId, baseH }
  //   baseH … その建物の元の高さ[m]。まとめて「全部同じ高さにする」ときに1棟ずつ
  //           必要な変更量が違うので、選んだ時点で測って覚えておく。
  selection: new Map(),
  primary: null,      // 最後に選んだ1棟（1棟だけのときの情報表示に使う）
  // ★ 壁面後退が作業中か（buildingsetback.js が立てる）。
  //   立っている間は、選択が空になってもパネルの中身を畳まない。
  //   畳むと、面の位置を調整している最中に操作先ごと消えてしまう。
  setbackBusy: false,
  // ★ いまどの手順にいるか。パネルはこれ1つで出し分ける。
  //   'select'  … 建物を選ぶ
  //   'pick'    … 囲み箱の面を押して、高さか壁面後退かを決める
  //   'height'  … 高さの変更
  //   'setback' … 壁面後退
  //   ⚠️ 選択と操作を1画面に同居させない。以前はタブで両方見えていたが、
  //     壁面後退の途中で高さのスライダーを触ってしまう取り違えが起きた。
  step: 'select',
  // ★ 建物のクリック選択を受け付けているか。
  //   ⚠️ 手順が 'select' でも、これが立っていない限りクリックに反応しない。
  //     編集モードに入った時点で拾い始めると、カメラを回すつもりの操作で
  //     建物を掴んでしまう誤爆が絶えなかった。
  //     「既存の PLATEAU 建物を編集する」を押している間だけ拾う。
  picking: false,
};

// ★ まとめて扱った建物のまとまり（群）。
//   壁面後退を確定した対象群をここへ登録しておくと、あとでその中の1棟を
//   選び直しただけで【群ごと】選ばれる。まとめて後退した建物の後退距離を
//   直したいときに、毎回全部を選び直さずに済ませるため。
//   ⚠️ 選択そのものは固定しない（別の建物を選ぶのも解除するのも自由）。
//     「選ばれたのが群の一員なら、仲間も一緒に連れてくる」だけの仕掛け。
//   gmlId -> Map<gmlId, info>（その建物が属する群の全メンバーと、選んだ時の属性）
const selectionGroups = new Map();
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
  // ★ 嵩上げの柱も壁面後退で切りたい。切る仕組みは buildingsetback.js が
  //   持っているので、柱ができたことだけ知らせる（あちらを import すると
  //   相互参照になるため、差し込み口で繋ぐ）。
  if (columnHook) {
    try { columnHook(mesh, gmlId); } catch (e) { console.warn('柱の後退処理に失敗', e); }
  }
}

// 柱ができたときに呼ぶ差し込み口（buildingsetback.js が登録する）。
let columnHook = null;
function setColumnHook(fn) { columnHook = fn; }

// ---- めり込みの矢印 ------------------------------------------------------
//   高さを下げた建物は「低くなった」ことが空からは分かりにくい（元の高さが
//   もう画面に無いため）。元の屋根の高さから、今の屋根まで下向きの矢印を立てて
//   「ここからここまで下げた」を空間で示す。
//
//   ★ 柱（嵩上げ）と対になる表現なので、寿命の管理も柱と同じ仕組みに乗せる
//     （edits を正として作り直し、タイルの入れ替えでも消えない）。
//   ★ 矢印は【板1枚の2D】で描き、常にカメラの方へ向ける（ビルボード）。
//     立体の矢印にすると、見る向きによって奥行き方向に潰れて何の形か分からなくなるうえ、
//     太さを建物の大きさに合わせる必要があって調整が難しい（実際、京都駅のような
//     大きな建物では円錐が「長さ10m・直径14m」になり矢印に見えなかった）。
//     板なら常に同じ形で読める。
const arrowMat = new THREE.MeshBasicMaterial({
  color: 0x2f7dd8,          // 嵩上げの赤と対にした青。下げたとひと目で分かるように
  side: THREE.DoubleSide,   // 裏返っても見えるように（向きは毎フレーム直すが保険）
  clippingPlanes: buildingClipPlanes,   // 箱庭表示のとき建物と同じ箱で切る
});
const arrows = new Map();   // gmlId -> THREE.Mesh

// 矢印の寸法[m]は【一定】。竿の長さだけが下げた量に応じて変わる。
//   ★ 太さまで下げた量に比例させると、街ぜんたいを俯瞰したときに矢印の大きさが
//     まちまちになり、街並みそのものが見えなくなる（251棟を編集した実測で確認）。
//     大きさが揃っていれば「どこを下げたか」を数として読み取れる。
const ARROW_SHAFT_HW = 1.5;   // 竿の幅の半分
const ARROW_HEAD_HW = 3.6;    // 矢羽根の幅の半分
const ARROW_HEAD_LEN = 6.0;   // 矢羽根の長さ

function makeArrowMat() {
  const m = arrowMat.clone();
  m.clippingPlanes = buildingClipPlanes;   // clone は配列ごと複製するので差し直す（柱と同じ理由）
  return m;
}

function disposeArrow(gmlId) {
  const m = arrows.get(gmlId);
  if (!m) return;
  arrows.delete(gmlId);
  clipMeshes.delete(m);
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();
}

/* 下向きの矢印を1枚の板として作る。原点が上端で、-Y 方向へ length[m] 伸びる。
   板は XY 平面に置く（法線は +Z）。この向きのまま、あとで Y 軸だけ回してカメラへ向ける。
   太さは矢印の長さから決める（建物の大きさは見ない。板なので潰れる心配がなく、
   「下げた量が大きいほど矢印も大きい」という素直な対応にできる）。 */
function makeArrowGeometry(length) {
  const hw = ARROW_HEAD_HW;
  const w = ARROW_SHAFT_HW;
  // 矢羽根は決まった大きさのまま。竿だけが下げた量に応じて伸び縮みする。
  //   ⚠️ 下げた量が矢羽根より小さいときだけは、矢羽根を縮めて全体をその長さに収める
  //     （そうしないと矢印が元の屋根より上へはみ出す）。
  const headLen = Math.min(ARROW_HEAD_LEN, length);
  const sy = -(length - headLen);                           // 竿と矢羽根の境目
  const pos = new Float32Array([
    // 竿（長方形＝三角形2枚）
    -w, 0, 0,   w, 0, 0,   w, sy, 0,
    -w, 0, 0,   w, sy, 0,  -w, sy, 0,
    // 矢羽根（三角形1枚）
    -hw, sy, 0,  hw, sy, 0,  0, -length, 0,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 2; i < nrm.length; i += 3) nrm[i] = 1;      // 全部 +Z 向き
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* 板をカメラの方へ向ける（Y 軸まわりだけ回す）。
   ★ カメラの姿勢をそのまま写すと、真上から見たとき板が寝てしまい「下向き」の意味が
     消える。鉛直は保ったまま向きだけ合わせるのが正しい。
   ⚠️ 更新は onBeforeRender で行う。描画ループへ配線を足さずに済み、
     この矢印が画面に出るときだけ確実に呼ばれる（three は onBeforeRender の【あと】に
     modelViewMatrix を作るので、ここで matrixWorld を直せばその場で効く）。 */
function faceCameraOnRender(mesh) {
  mesh.onBeforeRender = (renderer, scene2, cam) => {
    mesh.rotation.y = Math.atan2(
      cam.position.x - mesh.position.x,
      cam.position.z - mesh.position.z,
    );
    mesh.updateMatrixWorld();
  };
}

/* めり込みの矢印を作り直す（dy>=0 なら消すだけ）。
   box は【今の】建物の境界箱（＝もう下がったあとの形）。 */
function rebuildArrow(gmlId, box, dy) {
  disposeArrow(gmlId);
  if (dy >= 0 || !box || box.isEmpty()) return;
  const drop = -dy;                      // 下げた量[m]（正の値）
  if (drop < 0.5) return;                // ごくわずかな変更に矢印は出さない
  const mesh = new THREE.Mesh(makeArrowGeometry(drop), makeArrowMat());
  // 上端＝元の屋根の高さ。今の屋根(box.max.y)から下げたぶんだけ上に戻した位置。
  mesh.position.set((box.min.x + box.max.x) / 2, box.max.y + drop, (box.min.z + box.max.z) / 2);
  mesh.renderOrder = 1;                  // 柱より後（重なったとき矢印を上に）
  faceCameraOnRender(mesh);
  scene.add(mesh);
  mesh.__arrowDy = dy;
  // ⚠️ 柱と違い clipMeshes には【登録しない】。あれは断面（縦断図）に切り口の線を
  //   描くための一覧で、矢印は建物ではなく注釈なので断面図に現れると邪魔になる。
  //   箱庭で切り抜かれること自体はマテリアルの clippingPlanes が受け持つ。
  arrows.set(gmlId, mesh);
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
function applyEditToParts(modelScene, parts, edit, gmlId = null) {
  if (!parts || !parts.length) return;
  if (edit.hidden) applyCollapse(parts);
  else if (edit.dy !== 0) applyHeight(parts, edit.dy);
  else restoreGeometry(parts);
  applyOpacity(modelScene, parts, effectiveOpacity(gmlId, edit));
}
// 1棟ぶんの編集を、あるタイルに当てる。
function applyEditToModel(modelScene, batchId, edit) {
  applyEditToParts(modelScene, collectBuildingVerts(modelScene, batchId), edit,
                   gmlIdOf(modelScene, batchId));
}

// 高さ変更に付ける表示物を作り直す。
//   嵩上げ(dy>0)なら【柱】、めり込み(dy<0)なら【下向きの矢印】。どちらも同じ寿命なので
//   1か所でまとめて面倒を見る（別々にすると、上げ↔下げの行き来で片方が残る）。
//   ★ 同じ建物は複数のタイル（LOD違い）に入っているが、付ける表示物は1つでよい。
//     いちばん頂点数の多い＝最も細かい表現から作る（粗いLODで作ると footprint が荒れる）。
function rebuildColumnsFor(gmlIds, { force = false } = {}) {
  const need = new Set();
  for (const gmlId of gmlIds) {
    const edit = edits.get(gmlId);
    if (!edit || edit.hidden || edit.dy === 0) {
      disposeColumn(gmlId); disposeArrow(gmlId); continue;
    }
    // ★ 反対の表現は必ず消す。上げ↔下げを行き来したときに前のものが残ると、
    //   持ち上げた建物の頭上に「下げた矢印」が浮いたままになる。
    if (edit.dy > 0) {
      disposeArrow(gmlId);
      const cur = columns.get(gmlId);
      // 高さが変わっていなければ形はそのままでよい（透明度だけ合わせて作り直しを省く）。
      //   ★ 透明度スライダーを動かすたびに数百棟ぶんの柱を作り直すと目に見えて重くなる。
      if (!force && cur && cur.__colDy === edit.dy) {
        applyColumnOpacity(cur, edit.opacity);
        continue;
      }
    } else {
      disposeColumn(gmlId);
      const cur = arrows.get(gmlId);
      if (!force && cur && cur.__arrowDy === edit.dy) continue;
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
    const parts = b ? b.parts : [];
    if (edit.dy > 0) {
      rebuildColumn(gmlId, parts, edit.dy);
      const col = columns.get(gmlId);
      if (col) applyColumnOpacity(col, edit.opacity);   // 建物と同じ透明度に揃える
    } else {
      // 矢印は「今の（下がったあとの）屋根の高さ」を起点に置くので、
      // ここで現在の頂点から箱を測る（applyEditToParts の後に呼ばれている）。
      rebuildArrow(gmlId, parts.length ? partsWorldBox(parts) : null, edit.dy);
    }
  }
}

// parts（＝その建物の頂点）の【今の】ワールド境界箱。
const _pwV = new THREE.Vector3();
function partsWorldBox(parts) {
  const box = new THREE.Box3();
  const updatedRoots = new Set();
  for (const p of parts) {
    const pos = p.mesh.geometry.attributes.position;
    if (!computeClipMeshWorld(p.mesh, _weWorld, updatedRoots)) continue;
    for (const i of p.idxs) {
      _pwV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_weWorld);
      box.expandByPoint(_pwV);
    }
  }
  return box;
}
const rebuildColumnFor = (gmlId) => rebuildColumnsFor([gmlId]);

// タイルが届いたときに、そのタイルに含まれる編集済みの建物へまとめて当て直す。
//   ★ これが無いと、カメラを動かしてタイルが入れ替わった瞬間に編集が消える。
function applyEditsToModel(modelScene) {
  // ★ 透かしている建物も対象。歩いている先のタイルは後から届くので、ここで当て直さないと
  //   「中に入っているのに、その棟のタイルが読み直された瞬間だけ不透明に戻る」が起きる。
  if (!edits.size && !seeThrough.size) return;
  const index = gmlIndexOf(modelScene);
  if (!index.size) return;
  const wanted = new Map();   // batchId -> gmlId
  const needDecor = [];
  for (const [gmlId, edit] of edits) {
    const batchId = index.get(gmlId);
    if (batchId === undefined) continue;
    wanted.set(batchId, gmlId);
    if (edit.dy !== 0 && !edit.hidden) needDecor.push(gmlId);
  }
  for (const gmlId of seeThrough) {
    const batchId = index.get(gmlId);
    if (batchId !== undefined) wanted.set(batchId, gmlId);
  }
  if (!wanted.size) return;
  const got = collectBuildingVertsMulti(modelScene, new Set(wanted.keys()));
  const reEdge = new Set();
  for (const [b, parts] of got) {
    const gmlId = wanted.get(b);
    applyEditToParts(modelScene, parts, edits.get(gmlId) || defaultEdit(), gmlId);
    if (seeThrough.has(gmlId)) reEdge.add(gmlId);
  }
  // ★ 届いたタイルが透かしている棟を含むなら、稜線もそのメッシュから作り直す
  //   （LODが変わると形が変わるので、古い稜線が残ると輪郭が二重に見える）。
  if (reEdge.size) refreshSeeThroughEdges(reEdge);
  // 届いたタイルの方が細かければ、柱・矢印もそちらから作り直す。
  //   高さが同じでも LOD が変われば footprint が変わるので、ここは必ず作り直す。
  if (needDecor.length) rebuildColumnsFor(needDecor, { force: true });
}
setBuildingEditHook(applyEditsToModel);

// 読み込み済みの全タイルへ、指定した建物すべての編集を当て直す。
//   同じ建物が複数のタイル（LOD違い・隣接タイル）に入っていることがあるので全部見る。
//   ★ 棟ごとに全タイルを回すのではなく、タイルごとに1回走査して全棟をさばく。
function applyEditsEverywhere(gmlIds, { geometryChanged = true } = {}) {
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
        const gmlId = wanted.get(b);
        applyEditToParts(modelScene, parts, edits.get(gmlId) || defaultEdit(), gmlId);
      }
    });
  }
  // 透かしの出入りは【形を変えない】。柱・矢印の作り直しと断面の再計算は要らない
  //   （歩くたびに走らせると、建物に出入りするだけで断面が毎回組み直される）。
  if (geometryChanged) {
    rebuildColumnsFor(set);
    markSectionDirty();   // 断面（箱庭・縦断図）にも形の変化を反映する
  }
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
      storeys: btValue(modelScene.batchTable, 'bldg:storeysAboveGround', batchId),
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

// 底面積を測るための一時ベクトル
const _faA = new THREE.Vector3(), _faB = new THREE.Vector3(), _faC = new THREE.Vector3();

// 選択中の建物すべての境界箱と底面積を、タイル1回の走査でまとめて測る。
//   ★ 1棟ずつ measureBuildingBox を呼ぶと棟数×頂点数になって現実的でない
//     （矩形選択で数千棟を選べるため）。
//
//   【底面積の測り方】
//     三角形を水平面へ落とした【符号付き】投影面積を、向きごとに足し合わせる。
//     上を向いた面（屋根）の合計が、そのまま建物の底面積になる。壁は真横なので
//     投影面積がゼロになり、勝手に落ちる。凹んだ形・中庭のある形でも正しく出る。
//
//     ⚠️ 屋根と床のどちらが「正」になるかは座標系の向きしだいで決まる。このワールドは
//       +X が西・+Z が北で鏡像になっているため、実測では上向きの面が【負】に出た。
//       向きを決め打ちにせず、正負それぞれの合計のうち大きいほうを採る。
//       閉じた立体なら両者は一致し、底が開いた建物（LOD2に多い）なら屋根側が残る。
//
//     ⚠️ 同じ建物が複数のタイル（LOD違い）に居ることがある。面積は箱のように
//       union できない（足すと二重に数える）ので、タイルごとに別々に集計して
//       いちばん細かい表現（三角形の多いもの）を採る。
function measureSelectionBoxes() {
  const boxes = new Map();   // gmlId -> Box3
  const areas = new Map();   // gmlId -> { area, tris }
  if (!editState.selection.size) return { boxes, areas };
  const updatedRoots = new Set();
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const index = gmlIndexOf(modelScene);
      const wanted = new Map();   // batchId -> gmlId
      // ★ 底面積は【まだ測っていない建物だけ】測る。
      //   高さ変更は平行移動なので底面積は変わらない。ところがこの関数は高さドラッグ中に
      //   毎フレーム呼ばれるので、毎回すべての三角形を回すと矩形選択（数千棟）で
      //   目に見えて重くなる。箱は動くたびに測り直す必要があるが、面積は初回だけでよい。
      const wantArea = new Set();   // batchId
      for (const [gmlId, info] of editState.selection) {
        const b = index.get(gmlId);
        if (b === undefined) continue;
        wanted.set(b, gmlId);
        if (!Number.isFinite(info.footprint)) wantArea.add(b);
      }
      if (!wanted.size) return;
      // このタイルぶんの集計（gmlId -> { up, dn, tris }）
      const acc = new Map();
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
        // 底面積は三角形ごとに見る（まだ測っていない建物がある場合だけ）
        if (!wantArea.size) return;
        const idx = g.index ? g.index.array : null;
        const triCount = (idx ? idx.length : pos.count) / 3;
        for (let f = 0; f < triCount; f++) {
          const i0 = idx ? idx[f * 3] : f * 3;
          const i1 = idx ? idx[f * 3 + 1] : f * 3 + 1;
          const i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
          const b = bid.getX(i0);
          if (!wantArea.has(b)) continue;
          const gmlId = wanted.get(b);
          if (gmlId === undefined) continue;
          _faA.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(_weWorld);
          _faB.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(_weWorld);
          _faC.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(_weWorld);
          const s = ((_faB.x - _faA.x) * (_faC.z - _faA.z)
                   - (_faB.z - _faA.z) * (_faC.x - _faA.x)) / 2;
          let a = acc.get(gmlId);
          if (!a) { a = { up: 0, dn: 0, tris: 0 }; acc.set(gmlId, a); }
          if (s > 0) a.up += s; else a.dn -= s;
          a.tris++;
        }
      });
      for (const [gmlId, a] of acc) {
        const cur = areas.get(gmlId);
        if (cur && cur.tris >= a.tris) continue;   // より細かい表現が既にある
        areas.set(gmlId, { area: Math.max(a.up, a.dn), tris: a.tris });
      }
    });
  }
  return { boxes, areas };
}

// 選択中の建物すべてに枠を合わせる。
function updateSelectionBox() {
  const { boxes, areas } = measureSelectionBoxes();
  let n = 0;
  for (const info of editState.selection.values()) {
    const box = boxes.get(info.gmlId);
    if (!box || box.isEmpty()) continue;
    // 測れたときだけ入れる（測らなかった＝前に測った値をそのまま使う）
    const a = areas.get(info.gmlId);
    if (a) info.footprint = a.area;
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

// ---- 矩形選択（2点クリック）--------------------------------------------
//   ★ 判定は「建物の境界箱の中心が矩形の中に入るか」。CADの窓選択と同じ考え方で、
//     大きな建物が矩形にかすっただけで巻き込まれるのを防ぐ。
//   ⚠️ ドラッグではなく【2点クリック】で取る。ドラッグで取ろうとすると
//     カメラの回転・パンと同じ操作になり、どちらを意図したのか区別できない。
//     Shift 併用で逃げていたが、押し忘れるとカメラが回ってしまい使いづらかった。
//   1点目を押すと rectPending に控え、2点目で確定する。Esc でやめられる。
let rectPending = null;   // { x, y }
let rectCursor = null;    // 2点目を決めるまでのカーソル位置
let rectEl = null;
function showRectBox() {
  if (!rectPending || !rectCursor) return;
  if (!rectEl) {
    rectEl = document.createElement('div');
    rectEl.style.cssText = 'position:fixed; border:1px solid #4ea1ff; background:rgba(78,161,255,0.15);' +
      'pointer-events:none; z-index:9999;';
    document.body.appendChild(rectEl);
  }
  const x = Math.min(rectPending.x, rectCursor.x), y = Math.min(rectPending.y, rectCursor.y);
  rectEl.style.left = x + 'px';
  rectEl.style.top = y + 'px';
  rectEl.style.width = Math.abs(rectCursor.x - rectPending.x) + 'px';
  rectEl.style.height = Math.abs(rectCursor.y - rectPending.y) + 'px';
  rectEl.style.display = '';
}
function hideRectBox() { if (rectEl) rectEl.style.display = 'none'; }

const _rsBox = new THREE.Box3();
const _rsV = new THREE.Vector3();
// 読み込み済みの建物すべての境界箱を batchid ごとに測って、矩形に入るものを選ぶ。
//   ★ 同じ建物が複数タイル（LOD違い）に入っているので gml_id でまとめる。
function applyRectSelection(a, b, { add = false } = {}) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
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
      storeys: btValue(ms.batchTable, 'bldg:storeysAboveGround', b),
      buildingId: btValue(ms.batchTable, 'uro:BuildingIDAttribute_uro:buildingID', b),
    });
  }
  setSelection(hits, { add });
}

// 押した先が「いま選択中の建物」かどうか。
function isSelectedHit(hit) {
  return !!(hit && editState.selection.has(hit.gmlId));
}

function onPointerDown(ev) {
  if (!editState.enabled || ev.button !== 0) return;
  // ★ 建物を掴んで高さを変えられるのは【高さの手順のときだけ】。
  //   ⚠️ 以前は「選ぶ手順以外なら掴める」としていたため、壁面後退で側面を
  //     選んだあと、囲み箱の外に出ている建物本体をドラッグすると高さが
  //     変わってしまった（後退の調整中に建物が伸び縮みする）。
  //     面を選ぶ場面（pick）でも同じで、選ぶだけのつもりが編集になる。
  if (editState.step !== 'height') { clearDown = { x: ev.clientX, y: ev.clientY }; return; }
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
  // 1点目を打ったあとは、カーソルまでの矩形を見せる
  if (rectPending) { rectCursor = { x: ev.clientX, y: ev.clientY }; showRectBox(); }
  if (!drag) return;
  const dyPx = drag.startY - ev.clientY;           // 上へ動かすと正
  if (!drag.moved && Math.abs(dyPx) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  // ★ ドラッグは【選択中の全棟】に同じ量を足す（＝「同じ高さだけ嵩上げ」）。
  //   1棟だけ選んでいれば、これまでどおりその棟だけが動く。
  const delta = dyPx * drag.mPerPx;
  for (const [gmlId, startDy] of drag.startDys) {
    const edit = carryMetrics(gmlId, edits.get(gmlId) || defaultEdit());
    edit.dy = startDy + delta;
    edit.hidden = false;                           // 高さをいじるなら表示状態に戻す
    edits.set(gmlId, edit);
  }
  applyEditsEverywhere(drag.startDys.keys());      // 走査は1回にまとめる
  updateSelectionBox();
  syncUI();
}

function onPointerUp(ev) {
  if (!drag) {
    // 「動かさずに離した」＝クリック。カメラを回した後には反応しない。
    const still = clearDown
      && Math.hypot(ev.clientX - clearDown.x, ev.clientY - clearDown.y) < DRAG_THRESHOLD_PX;
    clearDown = null;
    if (!still || !editState.enabled) return;
    if (editState.step === 'select') {
      if (!editState.picking) return;   // 受付前。クリックは素通しする
      // ★ 2点クリックで矩形選択。1点目を控え、2点目で確定する。
      //   ⚠️ ダブルクリックの1回目もここを通る。矩形の1点目として控えるだけなので
      //     実害はなく、ダブルクリックが成立すればそちらが選択を上書きする。
      if (!rectPending) {
        rectPending = { x: ev.clientX, y: ev.clientY };
        rectCursor = { x: ev.clientX, y: ev.clientY };
        syncUI();
      } else {
        const a = rectPending;
        rectPending = null; rectCursor = null;
        hideRectBox();
        applyRectSelection(a, { x: ev.clientX, y: ev.clientY }, { add: ev.altKey });
        syncUI();
      }
      return;
    }
    // ★ 高さをいじったあと、関係ないところをクリックしたら最初の状態へ戻す。
    //   スライダーのパネルが出たままだと、次の建物を選ぶ場面なのか
    //   まだ操作中なのか分からなくなる。
    //   ⚠️ 壁面後退の最中は戻さない。面のドラッグやギズモの外側を押しただけで
    //     作業が畳まれてしまう。
    if (editState.step === 'height') {
      clearSelection();
      setStep('select');
    }
    // ⚠️ 'pick' と 'setback' では何もしない。囲み箱の外を押しただけで
    //   選択が外れると、面を選び直したいだけなのに最初からやり直しになる。
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
  if (!editState.enabled || !editState.picking) return;
  const hit = pickBuildingAt(ev.clientX, ev.clientY);
  if (!hit) return;
  if (ev.shiftKey) toggleSelection(hit);
  else setSelection([hit]);
}

// 何も変わっていない編集は捨てる（「初期状態」と同じ扱いに戻す）。
function pruneIfPristine(gmlId) {
  const e = edits.get(gmlId);
  if (e && isPristine(e)) { edits.delete(gmlId); disposeColumn(gmlId); disposeArrow(gmlId); }
  syncUI();
}

// 選択を差し替える／足す／外す。
//   hits … pickBuildingAt が返した形の配列（gmlId とラベル用の属性を持つ）
function setSelection(hits, { add = false } = {}) {
  if (!add) editState.selection.clear();
  for (const h of hits) {
    // ★ 選んだ建物が「まとめて扱った群」の一員なら、仲間もまとめて選ぶ。
    //   後退させた建物群の距離を直すとき、1棟つつくだけで群が揃う。
    const group = selectionGroups.get(h.gmlId);
    if (group) {
      for (const [gid, info] of group) {
        if (editState.selection.has(gid)) continue;
        editState.selection.set(gid, { ...info, measuredHeight: NaN, footprint: NaN });
      }
    }
    editState.selection.set(h.gmlId, {
      gmlId: h.gmlId, name: h.name, usage: h.usage, height: h.height,
      storeys: h.storeys, buildingId: h.buildingId,
      measuredHeight: NaN,
      footprint: NaN,   // 底面積[㎡]。updateSelectionBox で実際の形から測る。
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
// 床面積の増減を概算する
//
//   高さを変えた結果、延床面積がどれだけ増えた／減ったかをその場で見せる。
//
//   ★ PLATEAU の属性は【欠けているのが普通】なので、どこが欠けても必ず値が出るよう
//     段階的な代替をあらかじめ決めてある。使った値が実データか仮定かは UI に出す。
//
//   【階高】次の順に、最初に成立したものを使う
//     ① 属性の高さ ÷ 属性の階数（bldg:measuredHeight ÷ bldg:storeysAboveGround）
//     ② 実測の高さ ÷ 属性の階数   … 高さ属性が無いとき。高さはジオメトリから測る
//                                   （baseHeightOf が既にこの代替を持っている）
//     ③ 3.0m を仮定               … 階数が無いとき。一般的な階高
//
//     ⚠️ 属性の高さは塔屋・パラペットまで含んだ実測値なので、こうして割った階高は
//       実際の階高より大きめに出る（実測した1棟は 50.6m / 7階 = 7.2m だった）。
//       あくまで概算であることを踏まえた使い方をしてもらう前提の数値。
//
//   【底面積】属性は使わず、必ずその建物の形から測る（measureSelectionBoxes）。
//     属性の延床面積（uro:totalFloorArea）は欠損や複数棟一括の値が混じっていて
//     当てにならない。実測なら常に得られるので、これが最も確実。
//     ただしタイルが未読込の間だけは測れないので、そのときは面積を「—」と出す
//     （階数の増減だけは階高から出せるので、そちらは表示する）。
//
//   【床面積】底面積 × 増減した階数。階数は整数に丸める（半端な階は無いため）。
// =========================================================================
const ASSUMED_FLOOR_HEIGHT = 3.0;   // 階数が分からない建物で仮定する階高[m]

/* その建物の階高[m]と、それが実データか仮定かを返す */
function floorHeightOf(info) {
  const st = Number(info && info.storeys);
  // 高さは baseHeightOf が「属性 → 実測」の順で埋めてくれる
  const h = baseHeightOf(info);
  if (Number.isFinite(st) && st > 0 && Number.isFinite(h) && h > 0) {
    return { h: h / st, assumed: false, storeys: st };
  }
  return { h: ASSUMED_FLOOR_HEIGHT, assumed: true, storeys: NaN };
}

/* 1棟ぶんの増減。dy[m] を階数と床面積に直す。
   ⚠️ 階数は【丸めない】。高さの変更は連続量なので、整数階に丸めると
     「階高より小さい変更」がすべて 0 階＝増減なしになって集計から消える。
     実測でこれが起きた: 階高 21.1m（1階建て21m）の建物を 6m 下げたとき
     round(-6/21.1)=0 となり、矢印は出ているのに集計に入らなかった。
     表示の段で小数1桁に丸めるだけにする。 */
function floorDeltaOf(info, dy) {
  const fh = floorHeightOf(info);
  const floors = dy / fh.h;
  const area = Number.isFinite(info.footprint) ? info.footprint * floors : NaN;
  return { floors, area, floorHeight: fh.h, assumed: fh.assumed, storeys: fh.storeys };
}

/* 選択中の全棟をまとめた増減。 */
function floorDeltaOfSelection() {
  let floors = 0, area = 0, anyArea = false, anyAssumed = false;
  for (const info of editState.selection.values()) {
    const e = edits.get(info.gmlId);
    const dy = e ? e.dy : 0;
    if (!dy) continue;
    const d = floorDeltaOf(info, dy);
    floors += d.floors;
    if (Number.isFinite(d.area)) { area += d.area; anyArea = true; }
    if (d.assumed) anyAssumed = true;
  }
  return { floors, area: anyArea ? area : NaN, assumed: anyAssumed };
}

// 面積の表示（3桁区切り）。
const fmtArea = (v) => (Number.isFinite(v)
  ? `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')} ㎡` : '—');

// 金額の表示。桁が大きくなりやすい（面積×単価）ので、億／万を自動で選ぶ。
const fmtMoney = (yen) => {
  if (!Number.isFinite(yen)) return '—';
  const sign = yen < 0 ? '−' : '+';
  const a = Math.abs(yen);
  if (a >= 1e8) return `${sign}${(a / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} 億円`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ja-JP')} 万円`;
  return `${sign}${Math.round(a).toLocaleString('ja-JP')} 円`;
};

/* 選択中に測った値を、その建物の編集内容へ写す。
   ★ 編集を作る・変える処理は必ずここを通すこと。ここを飛ばすと、その棟だけ
     底面積が分からないまま編集され、集計の「面積不明」に落ちる。 */
function carryMetrics(gmlId, e) {
  const info = editState.selection.get(gmlId);
  if (!info) return e;
  if (Number.isFinite(info.footprint)) e.footprint = info.footprint;
  if (Number.isFinite(info.measuredHeight)) e.measuredHeight = info.measuredHeight;
  if (info.storeys !== undefined && info.storeys !== null) e.storeys = info.storeys;
  if (info.height !== undefined && info.height !== null) e.height = info.height;
  return e;
}

/* 編集済みの【全棟】をまとめた増減。増やした側・減らした側を分けて返す。
   ⚠️ floorDeltaOf に渡すのは編集内容そのもの。storeys / height / measuredHeight /
     footprint を選択情報と同じ名前で持たせてあるので、そのまま同じ計算に載る。 */
function floorDeltaOfAll() {
  const up = { n: 0, area: 0, floors: 0 };
  const down = { n: 0, area: 0, floors: 0 };
  let assumed = false, unknownArea = 0;
  for (const e of edits.values()) {
    if (!e.dy || e.hidden) continue;
    const d = floorDeltaOf(e, e.dy);
    if (d.assumed) assumed = true;
    if (!Number.isFinite(d.area)) { unknownArea++; continue; }
    const side = d.area >= 0 ? up : down;
    side.n++; side.area += d.area; side.floors += d.floors;
  }
  return { up, down, total: up.area + down.area, assumed, unknownArea };
}

// =========================================================================
// UI
// =========================================================================
let ui = null;
// 「同じ量だけ上げ下げ」スライダーの基準。高さの手順に入った時点の各棟の dy。
//   ★ スライダーの値をそのまま「基準からの増減」として読む。差分を足し込む方式だと
//     つまみを戻しても元に戻らず、行ったり来たりできない。
let relBase = new Map();   // gmlId -> dy
let faUi = {};        // 右上の「床面積の増減」パネル
/* 手順を切り替える。パネルの出し分けと、その手順に入るときの下ごしらえを1か所に集める。
   ⚠️ 手順の入り口と出口をここへ寄せること。ボタンごとに散らすと、
     「壁面後退から抜けたのに面が残る」といった消し忘れが必ず出る。 */
function setStep(next) {
  const prev = editState.step;
  editState.step = next;
  // 囲み箱の面は 'pick' と 'setback' でだけ要る。そこから離れたら片付ける。
  //   ⚠️ 'pick' → 'setback' は面を選んだ流れの続きなので片付けない。
  const usedFaces = (prev === 'pick' || prev === 'setback');
  const needsFaces = (next === 'pick' || next === 'setback');
  if (usedFaces && !needsFaces) endSetbackStep();
  if (next === 'pick') startSetbackStep();
  if (next === 'height') captureRelBase();
  if (next === 'select') {
    // 手順の先頭へ戻ったら、受付は切っておく（押し直してもらう）
    editState.picking = false;
    rectPending = null; rectCursor = null; hideRectBox();
  }
  syncUI();
  requestRender();
}

/* 建物のクリック選択を受け付けるかどうかを切り替える。 */
function setPicking(on) {
  editState.picking = !!on;
  if (!on) { rectPending = null; rectCursor = null; hideRectBox(); }
  // ★ 選び始めたら、自分で置いた建物の道具は畳む。
  //   どちらもクリックで拾う道具なので、同時に開いていると取り違える。
  if (on) setBlocksEnabled(false);
  syncUI();
  requestRender();
}

/* 「同じ量だけ」スライダーの基準を、いまの高さで取り直す。
   ★ 呼ぶのは【高さの手順に入るとき】だけ。基準は「その建物の元の高さ」に
     据え置く。
   ⚠️ 「高さを揃える」を動かしたあとに取り直してはいけない。2本のスライダーは
     どちらも【元の高さから見た指定】であって、積み重ねるものではない。
     揃えた結果を基準にすると「揃えてから同じ量だけ」が加算になってしまう。
     揃えたあとに「同じ量だけ」を動かしたら、揃えた指定は捨てて
     元の高さ＋その量へ飛ぶ（不連続に切り替わる）のが正しい。 */
function captureRelBase() {
  relBase = new Map();
  for (const gmlId of editState.selection.keys()) {
    relBase.set(gmlId, (edits.get(gmlId) || defaultEdit()).dy);
  }
}

// 壁面後退の開始・終了は buildingsetback.js が持っている。読み込み順の都合で
// 直接は呼べないので、あちらから差し込んでもらう（循環 import を作らないため）。
let setbackStepHooks = { start: null, end: null };
function setSetbackStepHooks(start, end) { setbackStepHooks = { start, end }; }
function startSetbackStep() { if (setbackStepHooks.start) setbackStepHooks.start(); }
function endSetbackStep() { if (setbackStepHooks.end) setbackStepHooks.end(); }

function syncUI() {
  if (!ui) return;
  const n = editState.selection.size;
  // ★ 選択が無くても呼ぶ。集計の対象は選択ではなく【編集済みの全棟】なので、
  //   選択を外した瞬間にパネルが消えてしまってはいけない。
  syncFloorArea();
  // パネルは編集モードのときだけ出す（.on で表示を切り替える）
  ui.panel.classList.toggle('on', editState.enabled);
  // ★ 群として覚えられていることを見せる。黙って仲間まで選ばれると
  //   「余計なものまで選ばれた」と映るので、理由が分かるようにしておく。
  if (ui.lockRow) {
    const g = selectionGroupSize();
    ui.lockRow.style.display = g >= 2 ? 'flex' : 'none';
    if (g >= 2 && ui.lockLabel) ui.lockLabel.textContent = `${g} 棟をまとめて選択中`;
  }
  // 手順ごとの区画を出し分ける
  for (const [name, box] of Object.entries(ui.steps)) {
    if (box) box.style.display = (name === editState.step) ? '' : 'none';
  }
  // 選択を確定できるのは1棟以上選ばれているときだけ
  if (ui.confirmSel) ui.confirmSel.disabled = !n;
  // 「選び始める」の開閉。受付中だけ中身を出す。
  if (ui.pickBody) ui.pickBody.style.display = editState.picking ? '' : 'none';
  if (ui.startPick) {
    ui.startPick.textContent = editState.picking
      ? '既存の PLATEAU 建物を編集する ▴' : '既存の PLATEAU 建物を編集する ▾';
    ui.startPick.setAttribute('aria-expanded', String(editState.picking));
  }
  if (ui.rectHint) ui.rectHint.style.display = rectPending ? '' : 'none';

  // 見出し行（何棟選んでいるか／1棟なら属性）
  if (!n) {
    ui.info.textContent = editState.enabled ? '建物が選ばれていません' : '';
    ui.id.textContent = '';
  } else {
    const sel = editState.primary;
    const baseH = baseHeightOfSelected();
    if (n > 1) {
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
  }

  // 高さの手順の入力欄
  if (editState.step === 'height' && n) {
    const sel = editState.primary;
    const e = edits.get(sel.gmlId) || defaultEdit();
    const baseH = baseHeightOfSelected();
    const pct = Math.round(e.opacity * 100);
    ui.opacity.value = String(pct);
    // ★ 0% は「非表示」と読ませる。別に非表示のチェックを置いていたが、
    //   透過0%とチェックONの2通りで同じ見た目になり、どちらが効いているのか
    //   分からなくなっていた。0%＝非表示に一本化した。
    ui.opacityVal.textContent = pct === 0 ? '非表示' : `${pct}%`;
    // 「同じ量だけ」のつまみは、元の高さから見た増減を指す。
    //   ⚠️ 「高さを揃える」で動かしたぶんもここに映る（揃えた結果を
    //     元の高さと比べた差）。つまみを掴んだ瞬間にその値が採用されるので、
    //     表示と操作の意味が食い違わない。
    const rel = e.dy - (relBase.get(sel.gmlId) ?? 0);
    ui.rel.value = String(Math.max(-50, Math.min(50, rel)));
    ui.relVal.textContent = rel === 0 ? '±0 m'
      : `${rel > 0 ? '+' : ''}${rel.toFixed(1)} m`;
    const total = sliderHeight(baseH, e.dy);
    ui.dy.value = String(clampSlider(total));
    ui.dyVal.textContent = `${total.toFixed(1)} m`;
  }
  ui.count.textContent = edits.size ? `編集中: ${edits.size} 棟` : '';
}

// 右上の「床面積の増減」パネルを描き直す。
//   対象は【編集済みの全棟】。選択を外しても集計は残る（編集そのものが残るため）。
//   1棟も高さを変えていなければパネルごと隠す。
function syncFloorArea() {
  if (!faUi.panel) return;
  const d = floorDeltaOfAll();
  const n = d.up.n + d.down.n + d.unknownArea;
  if (!n) { faUi.panel.classList.remove('on'); return; }
  faUi.panel.classList.add('on');

  const row = (cls, label, side) => (side.n
    ? `<div class="fa-row ${cls}"><span class="fa-label">${label}</span>`
      + `<span class="fa-n">${side.n} 棟 ／ ${side.floors > 0 ? '+' : ''}${side.floors.toFixed(1)} 階</span>`
      + `<span class="fa-v">${fmtArea(side.area)}</span></div>`
    : '');

  const parts = [row('fa-up', '増', d.up), row('fa-dn', '減', d.down)];
  // 合計は、増と減の両方があるときだけ出す（片側だけなら同じ数字が並ぶだけなので）
  if (d.up.n && d.down.n) {
    parts.push('<div class="fa-row fa-total"><span class="fa-label">合計</span>'
      + `<span class="fa-n">${d.up.n + d.down.n} 棟</span>`
      + `<span class="fa-v">${fmtArea(d.total)}</span></div>`);
  }

  const notes = [];
  // 1棟だけを選んでいるときは、その建物の根拠（階高・底面積）を添える
  if (editState.selection.size === 1 && editState.primary) {
    const info = editState.primary;
    const fh = floorHeightOf(info);
    const src = fh.assumed ? '階数不明のため 3m と仮定' : `${fh.storeys}階から算出`;
    const fp = Number.isFinite(info.footprint)
      ? `${Math.round(info.footprint).toLocaleString('ja-JP')} ㎡` : '測定中';
    notes.push(`選択中: 階高 ${fh.h.toFixed(1)}m（${src}）／ 底面積 ${fp}`);
  } else if (d.assumed) {
    notes.push('※ 階数が無い建物は階高 3m と仮定');
  }
  if (d.unknownArea) notes.push(`※ ${d.unknownArea} 棟は底面積を測れていません`);
  if (notes.length) parts.push(`<div class="fa-note">${notes.join('<br>')}</div>`);

  faUi.body.innerHTML = parts.join('');
  syncLandPrice(d);
}

// -----------------------------------------------------------------------------
// 地価換算（暫定：単価は手入力）
//
//   ★ 国交省「不動産情報ライブラリ」の地価公示データ（座標ごとに最寄り地点の
//     ㎡単価を自動で引く）を組み込む予定だが、APIキーが審査待ちのため、
//     それまでは単価をこのパネルで手入力してもらう形にしておく。
//     計算そのもの（面積 × 単価）は先に用意しておき、データが揃ったら
//     「単価をどこから取るか」の1点だけ差し替えれば済むようにしてある。
// -----------------------------------------------------------------------------
// 1坪 = 400/121 ㎡（尺貫法の定義そのまま。約 3.305785 ㎡）。
const TSUBO_M2 = 400 / 121;

function syncLandPrice(d) {
  if (!faUi.landPriceBody) return;
  // 内部の単位は「円/㎡」に統一する（万円/㎡ の入力欄が正なので、そこから作る）。
  const manYenPerM2 = Number(faUi.landPricePerM2.value);
  const unit = Number.isFinite(manYenPerM2) ? manYenPerM2 * 10000 : NaN;
  if (!Number.isFinite(unit) || unit <= 0) {
    faUi.landPriceNote.textContent = '単価を入力すると金額換算を表示します（地価公示データ導入まで手入力）';
    faUi.landPriceBody.innerHTML = '';
    return;
  }
  faUi.landPriceNote.textContent = '';
  const upYen = Number.isFinite(d.up.area) ? d.up.area * unit : NaN;
  const dnYen = Number.isFinite(d.down.area) ? d.down.area * unit : NaN;
  const parts = [];
  if (d.up.n) parts.push(`<div class="fa-row fa-up"><span class="fa-label">増</span>`
    + `<span class="fa-v">${fmtMoney(upYen)}</span></div>`);
  if (d.down.n) parts.push(`<div class="fa-row fa-dn"><span class="fa-label">減</span>`
    + `<span class="fa-v">${fmtMoney(dnYen)}</span></div>`);
  if (d.up.n && d.down.n) {
    const total = (Number.isFinite(upYen) ? upYen : 0) + (Number.isFinite(dnYen) ? dnYen : 0);
    parts.push(`<div class="fa-row fa-total"><span class="fa-label">通算</span>`
      + `<span class="fa-v">${fmtMoney(total)}</span></div>`);
  }
  faUi.landPriceBody.innerHTML = parts.join('');
}

// 計算根拠の説明文（折りたたみパネルの中身）。固定文なので初回に1度だけ組み立てる。
const FA_BASIS_HTML = `
<b>階高の出し方（優先順）</b><br>
① 属性の高さ ÷ 属性の階数（bldg:measuredHeight ÷ bldg:storeysAboveGround）<br>
② 実測の高さ ÷ 属性の階数（高さ属性が無い建物。高さは3Dモデルの形から測る）<br>
③ 3.0m と仮定（階数の属性が無い建物。一般的な階高）<br>
※ 属性の高さは塔屋・パラペットを含む実測値のため、①②で出す階高は実際より
大きめに出ることがあります。<br><br>
<b>底面積の出し方</b><br>
属性値（延床面積）は使わず、必ず3Dモデルの形から測ります。属性は欠損や
複数棟一括の値が混じっていて当てにならないためです。建物の三角形を水平面へ
投影した面積を、上向き・下向きそれぞれ合計し、大きいほうを底面積とします
（壁は真横を向くため投影面積がゼロになり、自動的に無視されます）。<br><br>
<b>床面積の増減</b><br>
底面積 × （高さの変更量 ÷ 階高）。整数階には丸めません（階高より小さい
変更も比例配分で数えます）。<br><br>
<b>地価換算</b><br>
床面積の増減 × 単価。単価は「万円/㎡」「万円/坪」のどちらに入力しても
自動的にもう片方へ換算します（1坪 = 400/121 ㎡）。地価公示データを導入する
までの間、単価は上の欄に手入力してください。`;

/* 床面積パネルの畳み開き。長いので既定では開いておき、邪魔なら畳めるようにする。 */
function initFaFoldToggle() {
  const btn = el('faFoldToggle'), body = el('faFoldBody');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    btn.setAttribute('aria-expanded', String(!open));
    btn.textContent = open ? '床面積の増減 ▾' : '床面積の増減 ▴';
  });
}

function initFaBasisToggle() {
  const btn = el('faBasisToggle'), body = el('faBasisBody');
  if (!btn || !body) return;
  body.innerHTML = FA_BASIS_HTML;
  btn.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    btn.setAttribute('aria-expanded', String(!open));
    btn.textContent = open ? '計算根拠を見る ▾' : '計算根拠を隠す ▴';
  });
}

// 選択中の【全棟】に同じ変更を当てる。fn には (編集内容, その棟の情報) が渡る。
function mutateSelected(fn) {
  if (!editState.selection.size) return;
  const touched = new Set();
  for (const info of editState.selection.values()) {
    const e = carryMetrics(info.gmlId, edits.get(info.gmlId) || defaultEdit());
    fn(e, info);
    edits.set(info.gmlId, e);
    touched.add(info.gmlId);
  }
  applyEditsEverywhere(touched);            // 走査は1回にまとめる
  for (const gmlId of touched) {
    const e = edits.get(gmlId);
    if (e && isPristine(e)) { edits.delete(gmlId); disposeColumn(gmlId); disposeArrow(gmlId); }
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
  // ★ 箱の道具は編集パネルの中に畳んである。編集モードを抜けるときだけ
  //   閉じる（入るときに勝手に開かない＝建物を選ぶ場面で箱を掴まない）。
  if (!on) setBlocksEnabled(false);
  if (!on) {
    editState.selection.clear();
    editState.primary = null;
    for (const b of boxPool) b.visible = false;
    if (drag) { drag = null; controls.enabled = true; }
    rectPending = null; rectCursor = null; hideRectBox();
  }
  // ★ 入るときも出るときも手順を最初へ戻す。setStep 経由にすること。
  //   壁面後退の途中で編集モードを閉じたとき、面やギズモを片付けるのは
  //   setStep の仕事なので、ここで editState.step を直接書いてはいけない。
  setStep('select');
  requestRender();
}

/* 01（モデリング画面）のツールバーから呼ばれる入口。
   同一オリジンの iframe なので、あちらは window.toggleEarthBuildingEdit() を直接呼べる。 */
window.toggleEarthBuildingEdit = function () {
  setEditEnabled(!editState.enabled);
  return editState.enabled;
};
window.getEarthBuildingEditOn = () => editState.enabled;

(function setupUI() {
  faUi = {
    panel: el('floorAreaPanel'), body: el('floorAreaBody'),
    landPricePerM2: el('landPricePerM2'), landPricePerTsubo: el('landPricePerTsubo'),
    landPriceNote: el('landPriceNote'), landPriceBody: el('landPriceBody'),
  };
  // ㎡単価・坪単価は【どちらに入力してももう片方へ自動換算する】。
  //   ⚠️ 換算先の .value を書き換えても input イベントは発火しない（DOM の仕様）ので、
  //     無限ループの心配はない。片方が空欄になったらもう片方も空欄に揃える
  //     （半端な換算値が残って「入力していないのに単価が入っている」ように見えるのを防ぐ）。
  if (faUi.landPricePerM2 && faUi.landPricePerTsubo) {
    faUi.landPricePerM2.addEventListener('input', () => {
      const v = Number(faUi.landPricePerM2.value);
      faUi.landPricePerTsubo.value = (faUi.landPricePerM2.value === '' || !Number.isFinite(v))
        ? '' : (v * TSUBO_M2).toFixed(1);
      syncFloorArea();
    });
    faUi.landPricePerTsubo.addEventListener('input', () => {
      const v = Number(faUi.landPricePerTsubo.value);
      faUi.landPricePerM2.value = (faUi.landPricePerTsubo.value === '' || !Number.isFinite(v))
        ? '' : (v / TSUBO_M2).toFixed(1);
      syncFloorArea();
    });
  }
  initFaBasisToggle();
  initFaFoldToggle();
  const panel = el('editPanel');
  if (!panel) return;   // この画面に編集UIが無い構成でも動くように
  ui = {
    panel,
    lockRow: el('selectionLockRow'),
    lockLabel: el('selectionLockLabel'),
    info: el('buildingEditInfo'),
    id: el('buildingEditId'),
    count: el('buildingEditCount'),
    confirmSel: el('buildingEditConfirmSel'),
    startPick: el('buildingEditStartPick'),
    pickBody: el('buildingEditPickBody'),
    rectHint: el('buildingEditRectHint'),
    opacity: el('buildingEditOpacity'),
    opacityVal: el('buildingEditOpacityVal'),
    rel: el('buildingEditRel'),
    relVal: el('buildingEditRelVal'),
    dy: el('buildingEditDy'),
    dyVal: el('buildingEditDyVal'),
    steps: {},
  };
  for (const box of document.querySelectorAll('.ep-step')) {
    ui.steps[box.dataset.epStep] = box;
  }

  // ---- 手順1: 選ぶ ----
  ui.startPick.addEventListener('click', () => setPicking(!editState.picking));
  // 自分で置く建物の道具が開いたら、こちらの受付は切る
  setBlocksOpenHook(() => setPicking(false));
  ui.confirmSel.addEventListener('click', () => {
    if (editState.selection.size) setStep('pick');
  });
  el('buildingEditClearSel').addEventListener('click', () => {
    rectPending = null; rectCursor = null; hideRectBox();
    clearSelection();
  });

  // ---- 手順2 は囲み箱の面をクリックして決める（buildingsetback.js が受ける）----
  // どの手順からでも「選び直す」で最初へ戻れる
  for (const b of document.querySelectorAll('.ep-back')) {
    b.addEventListener('click', () => setStep('select'));
  }

  // ---- 手順3-1: 高さ ----
  //   透過度は 0% を「非表示」として扱う（別のチェックは置かない）。
  ui.opacity.addEventListener('input', () => {
    const pct = Number(ui.opacity.value);
    mutateSelected((e) => { e.opacity = pct / 100; e.hidden = pct === 0; });
  });
  //   相対：この手順に入った時点の高さから、全棟を同じ量だけ動かす
  ui.rel.addEventListener('input', () => {
    const v = Number(ui.rel.value);
    mutateSelected((e, info) => {
      e.dy = (relBase.get(info.gmlId) ?? 0) + v;
      if (e.hidden) { e.hidden = false; e.opacity = 1; }
    });
  });
  //   絶対：つまみの位置＝目指す総高さ。全棟がその高さに揃う
  ui.dy.addEventListener('input', () => setSelectedHeight(Number(ui.dy.value)));
  el('buildingEditReset').addEventListener('click', () => {
    resetSelected();
    // 戻したら相対スライダーの基準も取り直す（つまみが±0を指すように）
    setStep('height');
  });
  el('selectionUnlock').addEventListener('click', () => clearSelectionGroup());

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('dblclick', onDoubleClick);
  // Esc で矩形の1点目を取り消す（打った点を消す手段が無いと詰む）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !rectPending) return;
    rectPending = null; rectCursor = null; hideRectBox(); syncUI();
  });
  syncUI();
})();

/* 壁面後退の作業中フラグを立てる／降ろす（buildingsetback が呼ぶ）。
   ★ フラグを変えたら必ずパネルの見た目も更新する。切り替えただけでは
     次に何かが syncUI を呼ぶまで反映されず、畳まれたままに見える。 */
function setSetbackBusy(on) {
  editState.setbackBusy = !!on;
  syncUI();
}

/* いま選択中の建物を「まとめて扱った群」として覚える（壁面後退が確定時に呼ぶ）。
   ★ 1棟だけのときは登録しない（群にする意味がないうえ、その1棟を選ぶたびに
     余計な処理が走るのを避ける）。 */
function registerSelectionGroup() {
  if (editState.selection.size < 2) return;
  const members = new Map();
  for (const [gid, info] of editState.selection) {
    members.set(gid, {
      gmlId: gid, name: info.name, usage: info.usage, height: info.height,
      storeys: info.storeys, buildingId: info.buildingId,
    });
  }
  for (const gid of members.keys()) selectionGroups.set(gid, members);
  syncUI();
}

/* 群の登録を解く。gmlIds を省くと、いま選択中の建物が属する群をすべて解く。 */
function clearSelectionGroup(gmlIds) {
  const ids = gmlIds || [...editState.selection.keys()];
  for (const gid of ids) {
    const group = selectionGroups.get(gid);
    if (!group) continue;
    for (const member of group.keys()) selectionGroups.delete(member);
  }
  syncUI();
}

/* その建物が群の一員か（UI 表示用）。 */
function selectionGroupSize() {
  const p = editState.primary;
  if (!p) return 0;
  const g = selectionGroups.get(p.gmlId);
  return g ? g.size : 0;
}

// =========================================================================
// 「中に居る建物を透かす」公開API（ストリートビューから使う）
// =========================================================================
// ---- 透かした建物の稜線 --------------------------------------------------
//   建物メッシュは棟ごとに分かれていないので、その棟の三角形だけを _batchid で
//   拾い直して1つのジオメトリにまとめ、EdgesGeometry で稜線を出す。
//
//   ★ 稜線は【元メッシュのローカル座標で作り、姿勢は行列をコピーして合わせる】。
//     ⚠️ ワールド座標に焼いてはいけない。この関数はタイルが届いた瞬間（読み込み
//       フック）からも呼ばれるが、そのときタイル側の姿勢（ReorientationPlugin が
//       与える変換）はまだ入っていないことがあり、localToWorld が ECEF 座標を返す。
//       実測で、稜線が数百万m先に作られて消えた。
//     ⚠️ かといって元メッシュの【子】にもしないこと。LineSegments2 は Mesh の派生
//       なので、タイルの下に置くと「建物メッシュ」として扱われてしまう
//       （実測: ストリートビューの内外判定のレイキャストが稜線に当たって
//       LineSegments2.raycast がカメラを要求し例外。透過シェーダの差し込み先にも
//       混ざる）。scene 直下の専用グループに置き、行列だけ毎回合わせる。
//   ⚠️ 見えているメッシュだけを見ること。LOD違いの同じ棟が両方読み込まれていると
//     稜線が二重に出る。
const EDGE_ANGLE_DEG = 12;   // これ以上折れている稜だけ描く（面内の三角形分割は出さない）
const _ev = new THREE.Vector3();
const _wm = new THREE.Matrix4();
const _chain = [];

/* そのオブジェクトのワールド行列を、親をたどって【その場で組み立てる】。
   ⚠️ matrixWorld（キャッシュ）を当てにしてはいけない。3D Tiles のタイル群は
     matrixWorldAutoUpdate を切って自前で姿勢を入れており、描画が走る前や
     タイルが届いた直後は matrixWorld がまだ単位行列のことがある。実測で、
     稜線や床が ECEF 座標（数百万m先）に作られた。
     updateWorldMatrix(true,...) も親が matrixWorldAutoUpdate=false だと
     親をたどってくれないので当てにならない。 */
/* そのオブジェクトが【いま scene にぶら下がっているか】。
   ⚠️ forEachLoadedModel は「読み込み済み」を全部渡してくるが、3D Tiles は表示して
     いないタイルを scene から外したまま保持している。外れているタイルは姿勢
     （ReorientationPlugin の変換）も掛からないので、頂点を読むと ECEF 座標のまま
     出てくる。実測で、透かした棟の上端が 364万m と出て階数がめちゃくちゃになった。
     幾何を読むときは必ずこれで濾すこと。 */
function inScene(obj) {
  for (let o = obj; o; o = o.parent) if (o === scene) return true;
  return false;
}

function worldMatrixOf(obj, out) {
  _chain.length = 0;
  for (let o = obj; o; o = o.parent) _chain.push(o);
  out.identity();
  for (let i = _chain.length - 1; i >= 0; i--) {
    const o = _chain[i];
    if (o.matrixAutoUpdate) o.updateMatrix();
    out.multiply(o.matrix);
  }
  _chain.length = 0;
  return out;
}

/* その棟の稜線・床を作る元にするメッシュを選ぶ。
   ★ 選ぶ基準は【内外判定のレイが実際に当たったメッシュ】。そのタイルの中で、
     同じ棟の batchid を持つメッシュをすべて返す。
   ⚠️ 「頂点数がいちばん多い段」を選ぶ作りにしてはいけない（最初はそうしていた）。
     同じ gml_id が複数のタイルに入っており、粗い段では【複数棟が1つの batch に
     まとめられている】ことがある。実測で、10×24m の棟に対して粗い段の batch は
     35×38m あり、頂点数も倍だったため、そちらが選ばれて稜線が街区大に膨らんだ。
     レイが当たったメッシュなら、いま画面に見えているその棟そのものになる。
   ⚠️ 同じ棟が複数の段で同時に「見えている」ことがある（TilesFadePlugin は
     切り替わりの間、前の段を重ねて表示する）。全部から作ると稜線が二重になる。 */
function bestMeshesFor(gmlId) {
  const seen = seeThroughMeshes.get(gmlId);
  const root = seen && inScene(seen) ? seen.__clipRoot : null;
  const collect = (modelScene) => {
    const batchId = gmlIndexOf(modelScene).get(gmlId);
    if (batchId === undefined) return [];
    const meshes = [];
    modelScene.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.visible || mesh.isLineSegments2) return;
      for (let p = mesh.parent; p; p = p.parent) if (!p.visible) return;
      if (!inScene(mesh)) return;          // 表示されていないタイル（座標が ECEF のまま）
      const g = mesh.geometry;
      const pos = g && g.attributes.position, bid = g && g.attributes._batchid;
      if (!pos || !bid) return;
      for (let i = 0; i < bid.count; i++) {
        if (bid.getX(i) === batchId) { meshes.push({ mesh, batchId }); break; }
      }
    });
    return meshes;
  };
  if (root) {
    const m = collect(root);
    if (m.length) return m;
  }
  // レイの当たりが分からないとき（タイルが入れ替わった直後など）は、
  // その棟をいちばん小さく囲んでいる段を採る＝まとめ描きの粗い段を避ける。
  let best = null;
  for (const t of wardTiles) {
    t.forEachLoadedModel((modelScene) => {
      const meshes = collect(modelScene);
      if (!meshes.length) return;
      const box = new THREE.Box3();
      for (const { mesh, batchId } of meshes) {
        const pos = mesh.geometry.attributes.position, bid = mesh.geometry.attributes._batchid;
        for (let i = 0; i < pos.count; i++) {
          if (bid.getX(i) !== batchId) continue;
          box.expandByPoint(_ev.fromBufferAttribute(pos, i));
        }
      }
      const size = box.getSize(_ev);
      const vol = Math.max(1e-3, size.x * size.y * size.z);
      if (!best || vol < best.vol) best = { meshes, vol };
    });
  }
  return best ? best.meshes : [];
}

/* その棟の稜線（メッシュごとに1本）と、高さを測るための箱を作る。 */
function buildingEdgeParts(gmlId) {
  const parts = [];
  for (const { mesh, batchId } of bestMeshesFor(gmlId)) {
    const g = mesh.geometry;
    const pos = g.attributes.position, bid = g.attributes._batchid;
    const idx = g.index;
    const triCount = (idx ? idx.count : pos.count) / 3;
    const verts = [];
    const box = new THREE.Box3();
    for (let f = 0; f < triCount; f++) {
      const a = idx ? idx.getX(f * 3) : f * 3;
      if (bid.getX(a) !== batchId) continue;      // 3頂点は同じ棟なので1つ見れば足りる
      const b = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const c = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      for (const i of [a, b, c]) {
        _ev.fromBufferAttribute(pos, i);          // ローカル座標のまま使う
        verts.push(_ev.x, _ev.y, _ev.z);
        box.expandByPoint(_ev);
      }
    }
    if (verts.length < 9) continue;
    const solid = new THREE.BufferGeometry();
    solid.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    const edges = new THREE.EdgesGeometry(solid, EDGE_ANGLE_DEG);
    solid.dispose();
    const lg = new LineSegmentsGeometry();
    lg.setPositions(edges.attributes.position.array);   // 2点で1本の並び
    edges.dispose();
    const line = new LineSegments2(lg, seeThroughEdgeMat);
    line.frustumCulled = false;
    line.renderOrder = 995;
    line.matrixAutoUpdate = false;      // 姿勢は元メッシュから毎回コピーする
    line.raycast = () => {};            // 飾りなので、どのレイキャストにも当てない
    seeThroughEdgeGroup.add(line);
    parts.push({ line, mesh, box });
  }
  syncEdgeMatrices(parts);
  return parts;
}

/* 稜線の姿勢を元メッシュに合わせ直す。タイルの姿勢は後から入ることがあるので、
   作った直後だけでなく、定期的に（ストリートビューの見回し更新のたびに）呼ぶ。 */
function syncEdgeMatrices(parts) {
  for (const { line, mesh } of parts) {
    if (!inScene(mesh)) { line.visible = false; continue; }
    line.visible = true;
    line.matrix.copy(worldMatrixOf(mesh, _wm));
    line.matrixWorldNeedsUpdate = true;
  }
}

/* 透かしている稜線ぜんぶの姿勢を合わせ直す（streetview から毎回呼ばれる）。 */
function syncSeeThroughEdges() {
  for (const entry of seeThroughEdges.values()) syncEdgeMatrices(entry.parts);
}

// ---- 仮想フロアの床（建物モデルの【水平断面】） ---------------------------
//   ★ その高さの水平面で建物を切った断面を、そのまま床にする。底面を写すやり方だと、
//     セットバックした上層や塔屋のある棟で床が実際より広く出てしまう
//     （＝壁の外にはみ出した床の上を歩けてしまう）。
//   手順は3つ。
//     ① 切る … 三角形ごとに平面 y と交わる辺を求め、線分の集まりにする
//     ② 繋ぐ … 端点を突き合わせて閉じた輪（外形と中庭の穴）にする
//     ③ 貼る … 外形＋穴を三角形分割して面にする（THREE.ShapeUtils）
//   ⚠️ 断面は【床が有るか無いか】の判定にも使う。輪の中に居なければ床が無い＝落ちる。
const SECTION_TOL = 0.05;      // 端点を同じ点とみなす距離[m]
const SECTION_MIN_AREA = 0.5;  // これより小さい輪は捨てる[m2]（数値誤差のかけら）
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sc = new THREE.Vector3();

/* ① その棟を平面 y で切って、線分（[x1,z1,x2,z2]）の集まりにする。 */
function sliceBuildingAt(gmlId, y) {
  const segs = [];
  for (const { mesh, batchId } of bestMeshesFor(gmlId)) {
    const g = mesh.geometry;
    const pos = g.attributes.position, bid = g.attributes._batchid;
    worldMatrixOf(mesh, _wm);
    const idx = g.index;
    const triCount = (idx ? idx.count : pos.count) / 3;
    for (let f = 0; f < triCount; f++) {
      const ia = idx ? idx.getX(f * 3) : f * 3;
      if (bid.getX(ia) !== batchId) continue;
      const ib = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const ic = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      _sa.fromBufferAttribute(pos, ia).applyMatrix4(_wm);
      _sb.fromBufferAttribute(pos, ib).applyMatrix4(_wm);
      _sc.fromBufferAttribute(pos, ic).applyMatrix4(_wm);
      // 3辺のうち平面をまたぐものの交点（ふつう2つ）
      let n = 0, x1 = 0, z1 = 0, x2 = 0, z2 = 0;
      for (let e = 0; e < 3 && n < 2; e++) {
        const p = e === 0 ? _sa : (e === 1 ? _sb : _sc);
        const q = e === 0 ? _sb : (e === 1 ? _sc : _sa);
        const dp = p.y - y, dq = q.y - y;
        if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0) || dp === dq) continue;
        const t = dp / (dp - dq);
        if (t < 0 || t > 1) continue;
        const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
        if (n === 0) { x1 = x; z1 = z; } else { x2 = x; z2 = z; }
        n++;
      }
      if (n === 2 && (Math.abs(x1 - x2) > 1e-6 || Math.abs(z1 - z2) > 1e-6)) {
        segs.push([x1, z1, x2, z2]);
      }
    }
  }
  return segs;
}

/* ② 線分をつないで閉じた輪にする。 */
function stitchLoops(segs) {
  const key = (x, z) => Math.round(x / SECTION_TOL) + ',' + Math.round(z / SECTION_TOL);
  const ends = new Map();       // 端点 → その端点を持つ線分の番号
  segs.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
      let a = ends.get(k);
      if (!a) ends.set(k, a = []);
      a.push(i);
    }
  });
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const s = segs[i];
    const loop = [[s[0], s[1]], [s[2], s[3]]];
    let cx = s[2], cz = s[3];
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const list = ends.get(key(cx, cz));
      let next = -1;
      if (list) for (const j of list) if (!used[j]) { next = j; break; }
      if (next < 0) break;
      used[next] = true;
      const t = segs[next];
      // つながった側の反対の端へ進む
      const sameStart = Math.hypot(t[0] - cx, t[1] - cz) <= Math.hypot(t[2] - cx, t[3] - cz);
      cx = sameStart ? t[2] : t[0];
      cz = sameStart ? t[3] : t[1];
      loop.push([cx, cz]);
      if (Math.hypot(cx - loop[0][0], cz - loop[0][1]) <= SECTION_TOL) break;   // 閉じた
    }
    if (loop.length < 4) continue;
    let area2 = 0;
    for (let k = 0, m = loop.length - 1; k < loop.length; m = k++) {
      area2 += (loop[m][0] * loop[k][1]) - (loop[k][0] * loop[m][1]);
    }
    if (Math.abs(area2) / 2 < SECTION_MIN_AREA) continue;   // 数値誤差のかけらは捨てる
    loops.push(loop);
  }
  return loops;
}

/* 点が輪の内側か（XZ平面での多角形内外判定）。 */
function pointInLoop(loop, x, z) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i][0], zi = loop[i][1], xj = loop[j][0], zj = loop[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const loopArea = (l) => {
  let a2 = 0;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) a2 += (l[j][0] * l[i][1]) - (l[i][0] * l[j][1]);
  return Math.abs(a2) / 2;
};

/* ③ 外形と穴を仕分けて三角形に貼る。戻りは {mesh, rings} または null。
     rings … [{outer, holes}]（床の有無の判定にも使う） */
function classifyRings(loops) {
  const sorted = loops.slice().sort((a, b) => loopArea(b) - loopArea(a));   // 大きい順＝外形が先
  const rings = [];
  for (const loop of sorted) {
    const owner = rings.find((r) => pointInLoop(r.outer, loop[0][0], loop[0][1]));
    if (owner) owner.holes.push(loop);      // 大きい輪の内側にある＝穴（中庭など）
    else rings.push({ outer: loop, holes: [] });
  }
  return rings;
}

/* 外形の中に入っていて、穴には入っていないか。 */
function pointInRings(rings, x, z) {
  for (const r of rings) {
    if (!pointInLoop(r.outer, x, z)) continue;
    let inHole = false;
    for (const h of r.holes) if (pointInLoop(h, x, z)) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

function buildSectionMesh(loops) {
  if (!loops.length) return null;
  const rings = classifyRings(loops);
  const verts = [];
  for (const r of rings) {
    const contour = r.outer.map(([x, z]) => new THREE.Vector2(x, z));
    const holes = r.holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    let tris = null;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { tris = null; }
    if (!tris) continue;
    const all = contour.concat(...holes);
    for (const t of tris) {
      for (const i of t) { const v = all[i]; if (v) verts.push(v.x, 0, v.y); }
    }
  }
  if (verts.length < 9) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geom.computeVertexNormals();
  const slab = new THREE.Mesh(geom, floorSlabMat);
  slab.frustumCulled = false;
  slab.renderOrder = 994;      // 稜線より先に描く
  slab.raycast = () => {};     // 飾りなので、どのレイキャストにも当てない
  seeThroughEdgeGroup.add(slab);
  return { mesh: slab, rings };
}

function disposeSlab(entry) {
  if (!entry || !entry.mesh) return;
  seeThroughEdgeGroup.remove(entry.mesh);
  entry.mesh.geometry.dispose();
}

/* 仮想フロアの床を、その高さ[m]の断面として出す。null を渡すと引っ込める。 */
let floorSlabY = null;
function setFloorSlabHeight(worldY) {
  if (worldY === null || !seeThrough.size) {
    for (const e of floorSlabs.values()) if (e && e.mesh) e.mesh.visible = false;
    floorSlabY = null;
    return;
  }
  // 高さが変わったら切り直す（同じ高さのままなら作り置きを使う）
  if (floorSlabY === null || Math.abs(worldY - floorSlabY) > 0.05) {
    for (const [gmlId, e] of floorSlabs) { disposeSlab(e); floorSlabs.delete(gmlId); }
    floorSlabY = worldY;
  }
  for (const gmlId of seeThrough) {
    let e = floorSlabs.get(gmlId);
    if (e === undefined) {
      e = buildSectionMesh(stitchLoops(sliceBuildingAt(gmlId, worldY))) || null;
      floorSlabs.set(gmlId, e);      // 作れなかったら null を覚えて二度と試さない
    }
    if (!e) continue;
    e.mesh.visible = true;
    // わずかに浮かせる。断面と壁がぴたり同じ高さになる箇所でちらつくのを防ぐ。
    e.mesh.position.y = worldY + 0.03;
  }
  for (const [gmlId, e] of floorSlabs) {
    if (e && e.mesh && !seeThrough.has(gmlId)) e.mesh.visible = false;
  }
}

/* いま出している床が、その位置を覆っているか（覆っていなければ落ちる）。 */
function floorCoversAt(x, z) {
  if (floorSlabY === null) return false;
  for (const [gmlId, e] of floorSlabs) {
    if (!e || !seeThrough.has(gmlId)) continue;
    if (pointInRings(e.rings, x, z)) return true;
  }
  return false;
}

/* 出していない高さでも、そこに床（＝断面）が有るかを調べる。
   落ちる先の階を探すのに使う。切り直すので、続けて何度も呼ばないこと。 */
function sectionCoversAt(worldY, x, z) {
  for (const gmlId of seeThrough) {
    const rings = classifyRings(stitchLoops(sliceBuildingAt(gmlId, worldY)));
    if (pointInRings(rings, x, z)) return true;
  }
  return false;
}

/* その建物の属性（階数・高さ）を batchTable から拾う。floorHeightOf に渡す形。 */
/* その建物の属性（階数・高さ）を batchTable から拾う。floorHeightOf に渡す形。 */
function buildingAttrsOf(gmlId) {
  for (const t of wardTiles) {
    let found = null;
    t.forEachLoadedModel((modelScene) => {
      if (found) return;
      const b = gmlIndexOf(modelScene).get(gmlId);
      if (b === undefined) return;
      found = {
        storeys: btValue(modelScene.batchTable, 'bldg:storeysAboveGround', b),
        height: btValue(modelScene.batchTable, 'bldg:measuredHeight', b),
      };
    });
    if (found) return found;
  }
  return null;
}

/* 今そこに居る建物の、仮想フロアに必要な情報（いちばん高い棟を採る）。
   ⚠️ 高さは【呼ばれた時点で】メッシュの姿勢を当てて測る。作った時点の値を控えて
     おくと、姿勢がまだ入っていないタイルで ECEF 座標のまま固定されてしまう。 */
const _wbox = new THREE.Box3();
function getSeeThroughFloors() {
  let best = null;
  for (const info of seeThroughInfo.values()) {
    let topY = -Infinity, baseY = Infinity;
    for (const { mesh, box } of info.parts) {
      if (!inScene(mesh)) continue;               // タイルが捨てられた／表示されていない
      _wbox.copy(box).applyMatrix4(worldMatrixOf(mesh, _wm));
      if (_wbox.max.y > topY) topY = _wbox.max.y;
      if (_wbox.min.y < baseY) baseY = _wbox.min.y;
    }
    if (!Number.isFinite(topY)) continue;
    if (!best || topY > best.topY) {
      best = { topY, baseY, floorH: info.floorH, storeys: info.storeys, assumed: info.assumed };
    }
  }
  return best;
}

/* 稜線を今の seeThrough 集合に合わせる。rebuild に入れた棟は作り直す。 */
function refreshSeeThroughEdges(rebuild = null) {
  for (const [gmlId, entry] of seeThroughEdges) {
    if (seeThrough.has(gmlId) && !(rebuild && rebuild.has(gmlId))) continue;
    for (const { line } of entry.parts) {
      seeThroughEdgeGroup.remove(line);
      line.geometry.dispose();
    }
    seeThroughEdges.delete(gmlId);
    seeThroughInfo.delete(gmlId);
    disposeSlab(floorSlabs.get(gmlId));
    floorSlabs.delete(gmlId);
  }
  for (const gmlId of seeThrough) {
    if (seeThroughEdges.has(gmlId)) continue;
    const parts = buildingEdgeParts(gmlId);
    if (!parts.length) continue;
    seeThroughEdges.set(gmlId, { parts });
    const fh = floorHeightOf(buildingAttrsOf(gmlId));
    seeThroughInfo.set(gmlId, {
      parts, floorH: fh.h, storeys: fh.storeys, assumed: fh.assumed,
    });
  }
}

/* 屋上に立っているあいだなど、透かすのをやめて元の見え方に戻す。
   （建物の外に立っているので中を透かす意味がない、というときに使う） */
function setSeeThroughOpaque(on) {
  const v = !!on;
  if (v === seeThroughOpaque) return;
  seeThroughOpaque = v;
  if (seeThrough.size) applyEditsEverywhere([...seeThrough], { geometryChanged: false });
}

/* 透かす建物を入れ替える。渡した集合が「今そこに居る建物」のすべて。
   変化がなければ何もしない（毎フレーム同じ集合で呼んでよい）。 */
function setSeeThroughBuildings(ids) {
  // Map（gml_id → 当たったメッシュ）でも Set でも受ける
  const next = new Map();
  if (ids instanceof Map) for (const [k, v] of ids) next.set(k, v);
  else if (ids) for (const k of ids) next.set(k, null);
  const changed = [];
  for (const id of next.keys()) if (!seeThrough.has(id)) changed.push(id);
  for (const id of seeThrough) if (!next.has(id)) changed.push(id);
  // 当たったメッシュは毎回入れ替える（タイルが差し替わっても追随する）
  seeThroughMeshes.clear();
  for (const [k, v] of next) seeThroughMeshes.set(k, v);
  if (!changed.length) return false;
  seeThrough.clear();
  for (const id of next.keys()) seeThrough.add(id);
  // 形は変わらないので、柱の作り直しと断面の再計算はしない
  applyEditsEverywhere(changed, { geometryChanged: false });
  refreshSeeThroughEdges();
  return true;
}

/* レイキャストの当たり(intersection)から、その三角形が属する建物の gml_id を引く。
   建物メッシュは棟ごとに分かれておらず、_batchid 属性でしか区別できない。 */
function gmlIdFromHit(hit) {
  const g = hit && hit.object && hit.object.geometry;
  const bid = g && g.attributes._batchid;
  if (!bid || !hit.face) return null;
  // 三角形の3頂点は同じ建物に属するので、代表して1つ目を見ればよい
  return gmlIdOf(hit.object.__clipRoot, bid.getX(hit.face.a));
}

export {
  setSeeThroughBuildings, setSeeThroughOpaque, gmlIdFromHit,
  getSeeThroughFloors, syncSeeThroughEdges,
  setFloorSlabHeight, floorCoversAt, sectionCoversAt,
  // 稜線は px 指定の太さなので、画面サイズが変わったら resolution を伝えること（main.js）
  seeThroughEdgeMat,
  editState, edits, setEditEnabled, resetSelected, resetAll,
  registerSelectionGroup, clearSelectionGroup, selectionGroupSize, setSetbackBusy,
  setStep, setSetbackStepHooks, clearSelection, columns, setColumnHook, setPicking,
  applyEditsToModel, updateSelectionBox, applyEditsEverywhere, defaultEdit,
  // ★ 壁面後退（buildingsetback.js）へ貸し出す道具。
  //   あちらは「gml_id → batchid」と「その建物の階高」を必要とするが、どちらも
  //   決め方（索引の作り方／属性が欠けたときの代替）をこちらが持っているので、
  //   作り直させずに共有する。同じ建物に対して両者が違う階高を出すと、
  //   高さ変更と壁面後退で床面積の根拠が食い違ってしまう。
  gmlIndexOf, floorHeightOf,
};

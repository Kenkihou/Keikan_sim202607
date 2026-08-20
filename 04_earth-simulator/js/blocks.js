// =============================================================================
// blocks — 地面に「箱」を置いて、大きさ・向き・位置を手で決める。
//
//   壁面後退で空いた跡地に、どれくらいの建物なら収まるかを置いて確かめるための道具。
//   01（モデリング）の自作モデルとは別物で、こちらは 04 の中だけで完結する
//   （持ち帰りは考えない代わりに、その場でぱっと置いて測れることを優先する）。
//
//   【置き方】
//     「箱を置く」で画面の中心あたりの地面に 10m 角の箱が出る。
//     ・位置 … 箱そのものをドラッグする
//     ・向き・寸法 … ギズモ（回転の輪／角のハンドル）で決める
//     地面の高さには自動で合わせる。箱の外を（動かさずに）クリックすると選択が外れる。
//
//   【複製】
//     「複製」を押すと、いま選んでいる箱と同じ大きさ・向きの半透明の箱が
//     カーソルに付いてくる。置きたいところでクリックすると、そこに確定する。
//     同じ規模の建物を何棟も並べて検討する用。
//
//   ⚠️ 地面の高さは【見えている地形メッシュだけ】にレイキャストして取る。
//     3D Tiles は粗い段のタイルも読み込んだまま残していて（表示だけ切っている）、
//     Raycaster は visible を見ないので、そのままだと見えていない粗い面に当たって
//     高さが実際より高く出る（streetview.js が同じ理由で同じ対策をしている）。
// =============================================================================
import {
  THREE, scene, el, camera, controls, renderer, requestRender,
} from './core.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { getTerrainTiles } from './tiles.js';
import { buildingClipPlanes } from './section.js';

const DEFAULT_SIZE = 10;        // 置いたときの一辺[m]
const BLOCK_COLOR = 0x63b3ed;
// 次に置く箱の色。パレットで変えるとここも追従し、以後の箱に引き継がれる。
let nextBlockColor = BLOCK_COLOR;
const GHOST_OPACITY = 0.45;     // 複製中、カーソルに付いてくる箱の濃さ

const blocksState = {
  enabled: false,
  list: [],        // 置いた箱（THREE.Mesh）
  picked: null,    // 選んでいる箱
  ghost: null,     // 複製中にカーソルへ付いてくる箱
};

const blockGroup = new THREE.Group();
scene.add(blockGroup);

function makeBlockMaterial(ghost = false) {
  return new THREE.MeshStandardMaterial({
    color: nextBlockColor, roughness: 0.7, metalness: 0.0,
    transparent: ghost, opacity: ghost ? GHOST_OPACITY : 1,
    depthWrite: !ghost,
    clippingPlanes: buildingClipPlanes,   // 箱庭表示のとき建物と同じ箱で切る
  });
}

// -----------------------------------------------------------------------------
// 地面の高さ
// -----------------------------------------------------------------------------
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _visible = [];

function visibleTerrainMeshes() {
  _visible.length = 0;
  const t = getTerrainTiles();
  const root = t && t.group;
  if (!root) return _visible;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
    _visible.push(o);
  });
  return _visible;
}

/* その x,z の地面の高さ。真上から下向きに撃つ。取れなければ null。 */
function groundYAt(x, z) {
  const meshes = visibleTerrainMeshes();
  if (!meshes.length) return null;
  _rc.set(_origin.set(x, 4000, z), _down);
  _rc.far = Infinity;
  const hits = _rc.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.y : null;
}

/* 画面座標 → 地形上の点。取れなければ null。 */
function pickGround(clientX, clientY) {
  const meshes = visibleTerrainMeshes();
  if (!meshes.length) return null;
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((clientX - r.left) / r.width) * 2 - 1,
    -((clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hits = _rc.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.clone() : null;
}

/* 箱の底面を地面に合わせる。
   ⚠️ BoxGeometry は中心が原点なので、底を地面に付けるには
     「地面の高さ ＋ 高さの半分」に中心を置く。scale で伸ばしているので
     高さは geometry の値ではなく scale.y から出すこと。 */
function dropOnGround(mesh) {
  const gy = groundYAt(mesh.position.x, mesh.position.z);
  if (gy === null) return;
  mesh.position.y = gy + (mesh.geometry.parameters.height * mesh.scale.y) / 2;
}

// -----------------------------------------------------------------------------
// ギズモ（回転・寸法）
// -----------------------------------------------------------------------------
//   ★ ギズモは【寸法と向きだけ】。切り替えボタンは置かず同時に出す
//     （箱を1つ調整するたびにモードを行き来させたくないため）。
//   ★ 平面の位置は【箱そのものをドラッグ】して決める。
//     移動ギズモも出すと矢印・輪・角ハンドルが1か所に集まって掴み分けにくい。
//     位置は「掴んで動かす」が直感に合うので、ギズモを1つ減らせる。
/* ギズモから要らないハンドルを【物理的に取り除く】。
   ⚠️ 見えなくするだけでは足りない。TransformControls の当たり判定は picker を
     直接レイキャストしていて、見えていないハンドルも掴めてしまう。
     消したいものは親から外すこと。 */
const HANDLES_TO_DROP = {
  // 回転は水平の輪だけ。X/Z の輪、画面向きの輪(E)、球(XYZE)は捨てる
  rotate: new Set(['X', 'Z', 'E', 'XYZE']),
  // 寸法はタテ・ヨコ・高さの3本のバーだけ。面ハンドルと一様拡大の箱は捨てる
  scale: new Set(['XY', 'YZ', 'XZ', 'XYZ', 'XYZX', 'XYZY', 'XYZZ']),
};

function dropHandles(g, names) {
  const root = g.getHelper ? g.getHelper() : g;
  const doomed = [];
  root.traverse((o) => { if (names.has(o.name)) doomed.push(o); });
  for (const o of doomed) if (o.parent) o.parent.remove(o);
}

/* 寸法バーの【下向き】を消す。
   高さのバーは上に伸ばす向きだけあればよく、下は地面へ潜るので使わない。
   ⚠️ three r180 台では、ハンドルの位置は object.position ではなく
     ジオメトリ側に焼き込まれている（position はどれも 0）。だから
     「どこにあるか」はバウンディングボックスで見るしかない。
   ⚠️ ジオメトリは X/Z のハンドルと共用なので、形を変えるときは必ず複製する。
     そのまま触ると他の軸のバーまで一緒に崩れる。 */
function dropDownwardScaleBar(g) {
  const root = g.getHelper ? g.getHelper() : g;
  const doomed = [];
  root.traverse((o) => {
    if (o.name !== 'Y' || !o.geometry) return;
    if (!isScaleGroup(o.parent)) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (bb.max.y <= 0.01) { doomed.push(o); return; }   // まるごと下側＝下の掴み手
    if (bb.min.y >= -0.01) return;                      // すでに上側だけ
    // 上下にまたがる棒。上半分だけになるように潰して持ち上げる
    const top = bb.max.y;
    o.geometry = o.geometry.clone();
    o.geometry.scale(1, 0.5, 1);
    o.geometry.translate(0, top / 2, 0);
  });
  for (const o of doomed) if (o.parent) o.parent.remove(o);
}

/* そのグループが寸法ギズモ（gizmo.scale / picker.scale）かどうか。
   回転や移動の 'Y' まで削らないための歯止め。 */
function isScaleGroup(grp) {
  if (!grp || !grp.parent) return false;
  const owner = grp.parent;
  return (owner.gizmo && owner.gizmo.scale === grp)
    || (owner.picker && owner.picker.scale === grp)
    || (owner.helper && owner.helper.scale === grp);
}

const gizmos = ['rotate', 'scale'].map((mode) => {
  const g = new TransformControls(camera, renderer.domElement);
  g.setMode(mode);
  dropHandles(g, HANDLES_TO_DROP[mode]);
  if (mode === 'scale') dropDownwardScaleBar(g);
  // ⚠️ 回転の輪は【寸法バーより外側】に出すこと。
  //   既定の大きさだと輪の半径と横バーの先端がぴったり重なり、当たり判定は
  //   先に登録した回転が勝つ。赤・青のバーを掴んだのに回ってしまう原因がこれ。
  if (mode === 'rotate') g.size = 1.7;
  // 当たり判定に使う picker を後で引けるように控えておく
  {
    const root = g.getHelper ? g.getHelper() : g;
    root.traverse((o) => { if (o.picker && o.gizmo) g.__picker = o.picker[mode]; });
  }
  scene.add(g.getHelper ? g.getHelper() : g);
  g.enabled = false;
  if (g.getHelper) g.getHelper().visible = false;
  g.addEventListener('change', () => requestRender());
  g.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    // 寸法ドラッグを始めた時点の大きさを控える（下の増幅の基準）
    if (mode === 'scale') scaleBase = (e.value && g.object) ? g.object.scale.clone() : null;
    // ⚠️ 掴んでいない方のギズモは止める。重ねて出しているので、そのままだと
    //   掴んでいない側が同じドラッグを拾って二重に動く。
    for (const other of gizmos) if (other !== g) other.enabled = !e.value;
  });
  g.addEventListener('objectChange', () => {
    if (mode === 'scale') amplifyScale(g.object);
    if (blocksState.picked) dropOnGround(blocksState.picked);   // 動かしても接地を保つ
    syncBlocksUI();
  });
  return g;
});
const [gizmoRot, gizmoScale] = gizmos;

/* ドラッグでの寸法の変わり方を SCALE_GAIN 倍に増幅する。
   既定の効き方だと大きく変えるのに何度も引き直すことになるため。
   ⚠️ TransformControls は毎回【掴んだ時点の大きさ】から計算し直すので、
     ここで上書きしても増幅が二重に効くことはない。掴んだ時点の値を
     scaleBase に控えておき、そこからの差だけを伸ばす。 */
const SCALE_GAIN = 1.5;
let scaleBase = null;

function amplifyScale(obj) {
  if (!obj || !scaleBase) return;
  for (const ax of ['x', 'y', 'z']) {
    const v = scaleBase[ax] + (obj.scale[ax] - scaleBase[ax]) * SCALE_GAIN;
    obj.scale[ax] = Math.max(v, 0.05);   // 潰れて裏返るのを防ぐ
  }
}

/* この画面位置でギズモのハンドルを掴んでいるか。
   ⚠️ 回転の輪と寸法バーは奥行き方向で重なって見えることがある。
     TransformControls は各自が自分の picker だけを見るので、重なると
     先に作った回転が横取りする（赤・青のバーを引いたのに回ってしまう）。
     ここで先に判定して、寸法を掴んでいるときは回転を黙らせる。 */
function gizmoPickerHit(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hit = (g) => !!(g.__picker && g.object && g.enabled
    && _rc.intersectObject(g.__picker, true).length);
  return { rotate: hit(gizmoRot), scale: hit(gizmoScale) };
}

function attachGizmos(mesh) {
  for (const g of gizmos) {
    g.attach(mesh);
    g.enabled = true;
    if (g.getHelper) g.getHelper().visible = true;
  }
  requestRender();
}

function detachGizmos() {
  for (const g of gizmos) {
    g.detach();
    g.enabled = false;
    if (g.getHelper) g.getHelper().visible = false;
  }
  requestRender();
}

// -----------------------------------------------------------------------------
// 置く・選ぶ・消す
// -----------------------------------------------------------------------------
/* 画面の中心あたりの地面に箱を1つ置く。 */
function addBlock() {
  const r = renderer.domElement.getBoundingClientRect();
  const p = pickGround(r.left + r.width / 2, r.top + r.height / 2);
  if (!p) return { ok: false, reason: '地面が見えている場所で押してください' };
  const geo = new THREE.BoxGeometry(DEFAULT_SIZE, DEFAULT_SIZE, DEFAULT_SIZE);
  const mesh = new THREE.Mesh(geo, makeBlockMaterial());
  mesh.position.set(p.x, 0, p.z);
  dropOnGround(mesh);
  blockGroup.add(mesh);
  blocksState.list.push(mesh);
  pickBlock(mesh);
  return { ok: true };
}

/* 保存データから箱を1つ作る（セーブJSONの復元用）。
   ⚠️ 接地は呼び出し側の指定を使わず、その場の地形から測り直す。地形は
     LOD が上がると高さが変わるので、保存時の数値をそのまま使うと浮いたり潜ったりする。 */
function addBlockAt({ x, z, 幅 = DEFAULT_SIZE, 高さ = DEFAULT_SIZE, 奥行 = DEFAULT_SIZE,
  向き = 0, 色 = null } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const geo = new THREE.BoxGeometry(DEFAULT_SIZE, DEFAULT_SIZE, DEFAULT_SIZE);
  const mesh = new THREE.Mesh(geo, makeBlockMaterial());
  if (色) mesh.material.color.set(色);
  mesh.scale.set(幅 / DEFAULT_SIZE, 高さ / DEFAULT_SIZE, 奥行 / DEFAULT_SIZE);
  mesh.rotation.y = 向き * Math.PI / 180;
  mesh.position.set(x, 0, z);
  // ⚠️ 復元の直後は地形タイルがまだ届いていないことが多く、その場では
  //   地面の高さが測れない。測れたかどうかを覚えておき、あとで測り直す。
  mesh.userData.needsGround = groundYAt(x, z) === null;
  dropOnGround(mesh);
  blockGroup.add(mesh);
  blocksState.list.push(mesh);
  syncBlocksUI();
  requestRender();
  return mesh;
}

/* まだ地面に載せられていない箱を載せ直す。載せ残しの数を返す。
   地形が届くまで何度か呼ぶ想定（savestate.js が復元後に繰り返す）。 */
function regroundBlocks() {
  let left = 0;
  for (const m of blocksState.list) {
    if (!m.userData.needsGround) continue;
    if (groundYAt(m.position.x, m.position.z) === null) { left++; continue; }
    dropOnGround(m);
    m.userData.needsGround = false;
  }
  if (left < blocksState.list.length) requestRender();
  return left;
}

function pickBlock(mesh) {
  blocksState.picked = mesh;
  if (mesh) attachGizmos(mesh);
  else detachGizmos();
  syncBlocksUI();
  requestRender();
}

function removeBlock(mesh) {
  if (!mesh) return;
  const i = blocksState.list.indexOf(mesh);
  if (i >= 0) blocksState.list.splice(i, 1);
  blockGroup.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  if (blocksState.picked === mesh) pickBlock(null);
  requestRender();
}

function removeAllBlocks() {
  for (const m of [...blocksState.list]) removeBlock(m);
  cancelGhost();
}

/* いま選んでいる箱の寸法[m]（scale をかけた実寸）。 */
function blockSize(mesh) {
  if (!mesh) return null;
  const p = mesh.geometry.parameters;
  return {
    x: p.width * mesh.scale.x,
    y: p.height * mesh.scale.y,
    z: p.depth * mesh.scale.z,
  };
}

/* 寸法を数値で決める（scale に直して入れる）。 */
function setBlockSize(axis, value) {
  const mesh = blocksState.picked;
  if (!mesh || !Number.isFinite(value) || value <= 0) return;
  const p = mesh.geometry.parameters;
  const base = axis === 'x' ? p.width : (axis === 'y' ? p.height : p.depth);
  mesh.scale[axis] = value / base;
  dropOnGround(mesh);
  syncBlocksUI();
  requestRender();
}

/* 箱の向き[度]。水平回転だけ扱う。 */
function setBlockRotation(deg) {
  const mesh = blocksState.picked;
  if (!mesh || !Number.isFinite(deg)) return;
  mesh.rotation.y = deg * Math.PI / 180;
  syncBlocksUI();
  requestRender();
}

/* 箱の色。選んでいる箱があればそれを塗り替え、以後に置く箱の既定色にもする。 */
function setBlockColor(hex) {
  const c = new THREE.Color(hex);
  nextBlockColor = c.getHex();
  if (blocksState.picked) blocksState.picked.material.color.copy(c);
  requestRender();
}

// -----------------------------------------------------------------------------
// 複製（カーソルに付いてくる半透明の箱を、クリックで確定する）
// -----------------------------------------------------------------------------
function startGhost() {
  const src = blocksState.picked;
  if (!src) return { ok: false, reason: '複製したい建物を選んでください' };
  cancelGhost();
  const mesh = new THREE.Mesh(src.geometry.clone(), makeBlockMaterial(true));
  mesh.material.color.copy(src.material.color);   // 色も元の箱に合わせる
  mesh.scale.copy(src.scale);
  mesh.rotation.copy(src.rotation);
  mesh.position.copy(src.position);
  blockGroup.add(mesh);
  blocksState.ghost = mesh;
  renderer.domElement.style.cursor = 'copy';
  detachGizmos();     // 置き場所を決めている間はギズモを畳む
  syncBlocksUI();
  requestRender();
  return { ok: true };
}

function cancelGhost() {
  const g = blocksState.ghost;
  if (!g) return;
  blockGroup.remove(g);
  g.geometry.dispose();
  g.material.dispose();
  blocksState.ghost = null;
  renderer.domElement.style.cursor = '';
  syncBlocksUI();
  requestRender();
}

/* 半透明の箱を今の位置で確定する。 */
function commitGhost() {
  const g = blocksState.ghost;
  if (!g) return;
  const color = g.material.color.clone();
  g.material.dispose();
  g.material = makeBlockMaterial(false);
  g.material.color.copy(color);
  blocksState.ghost = null;
  renderer.domElement.style.cursor = '';
  blocksState.list.push(g);
  pickBlock(g);
}

// -----------------------------------------------------------------------------
// 操作（クリック・移動）
// -----------------------------------------------------------------------------
//   ⚠️ 捕捉フェーズで受ける。buildingedit / buildingsetback も pointerdown を
//     握っているので、箱に当たったときだけこちらで止める。
//     当たらなかったときは素通しする（カメラ操作や建物の選択を邪魔しない）。
// 箱をつまんで動かしている最中の状態。
//   grabX/grabZ … 掴んだ地点と箱の中心のずれ。これを保つと、箱が
//   カーソルの下へ飛ばずに「掴んだところを持ったまま」動く。
let drag = null;
// 掴んでから動かさずに離したときは「クリック」とみなす閾値[px]
const DRAG_THRESHOLD_PX = 4;
// 箱以外をクリックしたときに選択を外すための控え
let clearDown = null;

function onPointerDown(ev) {
  if (!blocksState.enabled || ev.button !== 0) return;
  // 複製中は、どこをクリックしても「そこに置く」
  if (blocksState.ghost) {
    ev.stopPropagation();
    ev.preventDefault();
    commitGhost();
    return;
  }
  // ⚠️ ギズモを掴んでいるときは何もしない。掴み始めの pointerdown が
  //   こちらにも届くので、そのまま進むと箱のドラッグが二重に始まる。
  if (gizmos.some((g) => g.dragging)) return;
  const gh = gizmoPickerHit(ev);
  if (gh.scale || gh.rotate) {
    // 寸法バーを掴んだなら、奥で重なっている回転には割り込ませない
    gizmoRot.enabled = !gh.scale;
    return;   // あとはギズモに任せる（箱本体のドラッグは始めない）
  }
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  const hit = blocksState.list.length
    ? _rc.intersectObjects(blocksState.list, false)[0] : null;
  if (!hit) {
    // ★ 箱の外。ここでは選択を外さず、「動かさずに離したら外す」ために控えるだけ。
    //   すぐ外すと、カメラを回そうとしただけで選択が消えてしまう。
    if (blocksState.picked) clearDown = { x: ev.clientX, y: ev.clientY };
    return;
  }
  ev.stopPropagation();
  ev.preventDefault();
  pickBlock(hit.object);
  // 掴んだ地点と箱の中心のずれを覚えて、つまんだ位置を保ったまま動かす
  const g = pickGround(ev.clientX, ev.clientY);
  drag = {
    mesh: hit.object, moved: false,
    grabX: g ? hit.object.position.x - g.x : 0,
    grabZ: g ? hit.object.position.z - g.z : 0,
  };
  controls.enabled = false;   // ドラッグ中はカメラを回さない
}

function onPointerMove(ev) {
  // 複製中の半透明の箱はカーソルに付いてくる
  const ghost = blocksState.ghost;
  if (ghost) {
    const p = pickGround(ev.clientX, ev.clientY);
    if (!p) return;
    ghost.position.x = p.x;
    ghost.position.z = p.z;
    dropOnGround(ghost);
    requestRender();
    return;
  }
  if (!drag) { updateHoverCursor(ev); return; }
  const p = pickGround(ev.clientX, ev.clientY);
  if (!p) return;
  drag.moved = true;
  drag.mesh.position.x = p.x + drag.grabX;
  drag.mesh.position.z = p.z + drag.grabZ;
  dropOnGround(drag.mesh);
  syncBlocksUI();
  requestRender();
}

/* 箱の上にカーソルが乗ったら「掴んで動かせる」ことを形で示す。
   ⚠️ ギズモのハンドルに乗っているときは触らない。ギズモ側が出している
     カーソルを上書きすると、どちらを掴んでいるのか分からなくなる。 */
let cursorOwned = false;   // いまカーソルを自分で書き換えているか
function setOwnCursor(v) {
  if (v) { renderer.domElement.style.cursor = v; cursorOwned = true; }
  else if (cursorOwned) { renderer.domElement.style.cursor = ''; cursorOwned = false; }
}

function updateHoverCursor(ev) {
  if (!blocksState.enabled || blocksState.ghost) return;
  if (gizmos.some((g) => g.axis)) { setOwnCursor(null); return; }
  if (!blocksState.list.length) { setOwnCursor(null); return; }
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  setOwnCursor(_rc.intersectObjects(blocksState.list, false).length ? 'move' : null);
}

function onPointerUp(ev) {
  if (blocksState.picked) gizmoRot.enabled = true;   // 黙らせた回転を戻す
  if (drag) {
    drag = null;
    controls.enabled = true;
    return;
  }
  // 箱の外を「動かさずに」クリックした＝選択を外す
  if (clearDown) {
    const moved = Math.hypot(ev.clientX - clearDown.x, ev.clientY - clearDown.y);
    if (moved < DRAG_THRESHOLD_PX) pickBlock(null);
    clearDown = null;
  }
}

// =============================================================================
// UI
// =============================================================================
let ui = {};

function syncBlocksUI() {
  if (!ui.panel) return;
  const has = !!blocksState.picked;
  if (ui.sizeRow) ui.sizeRow.style.display = has ? '' : 'none';
  // ★ 選んでいる箱があるかどうかで、押せるボタンを丸ごと入れ替える。
  if (ui.idleRow) ui.idleRow.style.display = has ? 'none' : 'flex';
  if (ui.pickedRow) ui.pickedRow.style.display = has ? 'flex' : 'none';
  if (has && document.activeElement !== ui.sizeX
      && document.activeElement !== ui.sizeY && document.activeElement !== ui.sizeZ) {
    const s = blockSize(blocksState.picked);
    ui.sizeX.value = s.x.toFixed(1);
    ui.sizeY.value = s.y.toFixed(1);
    ui.sizeZ.value = s.z.toFixed(1);
  }
  if (has && ui.rotY && document.activeElement !== ui.rotY) {
    // -180〜180 に畳んで出す。360 を超えた値が並ぶと読みにくいため。
    let deg = (blocksState.picked.rotation.y * 180 / Math.PI) % 360;
    if (deg > 180) deg -= 360;
    if (deg < -180) deg += 360;
    ui.rotY.value = deg.toFixed(0);
  }
  if (ui.color) {
    const c = has ? blocksState.picked.material.color : new THREE.Color(nextBlockColor);
    ui.color.value = '#' + c.getHexString();
  }
  const lines = [];
  if (blocksState.ghost) lines.push('置きたいところでクリックしてください（Esc で中止）');
  else if (has) lines.push('建物をドラッグで移動／ギズモで大きさ・向きを調整');
  else if (blocksState.list.length) lines.push('建物をクリックすると選べます');
  else lines.push('「新規作成」で画面中央の地面に 10m 角の建物が出ます');
  lines.push(`置いた建物: ${blocksState.list.length} 個`);
  if (ui.info) ui.info.textContent = lines.join('\n');
}

// 道具を開いたときに呼ぶ差し込み口（buildingedit.js が登録する）。
//   ⚠️ あちらを import すると相互参照になるので、関数を預けてもらう。
let openHook = null;
function setBlocksOpenHook(fn) { openHook = fn; }

function setBlocksEnabled(on) {
  blocksState.enabled = !!on;
  if (!on) {
    cancelGhost();
    pickBlock(null);
    setOwnCursor(null);
    // 道具を閉じたら、開閉ボタンの見た目も畳んだ状態に揃える
    if (ui.body && ui.open) {
      ui.body.style.display = 'none';
      ui.open.setAttribute('aria-expanded', 'false');
      ui.open.textContent = '建物を置く ▾';
    }
  }
  // ★ 置いた箱は【いつでも見えたまま】にする。
  //   ⚠️ 以前は enabled に連動して消していたが、道具を閉じたり編集モードを
  //     抜けたりするたびに検討した箱ごと消えてしまう。enabled が決めるのは
  //     「触れるかどうか」だけ。消すのは「全部消す」の役目。
  blockGroup.visible = true;
  syncBlocksUI();
  requestRender();
}

(function setupBlocksUI() {
  // ⚠️ かつては左上のチェックボックス（#blocksOn）の有無で「この画面に箱UIがあるか」を
  //   判定していた。入口を 01 のツールバーへ移してチェックを消したとき、ここが
  //   即 return するようになり、パネルが一切出なくなった。判定はパネル自体で行う。
  if (!el('blocksPanel')) return;
  ui = {
    panel: el('blocksPanel'), body: el('blocksBody'), open: el('blocksOpen'),
    idleRow: el('blocksIdleRow'), pickedRow: el('blocksPickedRow'),
    info: el('blocksInfo'), sizeRow: el('blocksSizeRow'),
    sizeX: el('blocksSizeX'), sizeY: el('blocksSizeY'), sizeZ: el('blocksSizeZ'),
    rotY: el('blocksRotY'), color: el('blocksColor'),
  };
  // 「建物を置く」の畳み開き。既定は閉じておき、必要なときだけ道具一式を出す。
  //   ⚠️ 開いている間だけ箱を触れるようにする。閉じているのに箱を掴めると、
  //     建物を選ぼうとして箱を動かしてしまう。
  if (ui.open && ui.body) {
    ui.open.addEventListener('click', () => {
      const shown = ui.body.style.display !== 'none';
      ui.body.style.display = shown ? 'none' : '';
      ui.open.setAttribute('aria-expanded', String(!shown));
      ui.open.textContent = shown ? '建物を置く ▾' : '建物を置く ▴';
      setBlocksEnabled(!shown);
      // ★ 開いたら PLATEAU 建物の選択受付は切ってもらう。
      //   どちらもクリックで拾う道具なので、両方が受け付けていると取り違える。
      if (!shown && openHook) openHook();
    });
  }
  el('blocksAdd').addEventListener('click', () => {
    const r = addBlock();
    if (!r.ok && ui.info) ui.info.textContent = r.reason;
  });
  el('blocksCopy').addEventListener('click', () => {
    const r = startGhost();
    if (!r.ok && ui.info) ui.info.textContent = r.reason;
  });
  el('blocksDelete').addEventListener('click', () => removeBlock(blocksState.picked));
  el('blocksClear').addEventListener('click', () => removeAllBlocks());
  ui.sizeX.addEventListener('input', () => setBlockSize('x', Number(ui.sizeX.value)));
  ui.sizeY.addEventListener('input', () => setBlockSize('y', Number(ui.sizeY.value)));
  ui.sizeZ.addEventListener('input', () => setBlockSize('z', Number(ui.sizeZ.value)));
  if (ui.rotY) ui.rotY.addEventListener('input', () => setBlockRotation(Number(ui.rotY.value)));
  if (ui.color) ui.color.addEventListener('input', () => setBlockColor(ui.color.value));
  renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cancelGhost(); return; }
    // Delete / Backspace で、選んでいる箱を消す。
    //   ⚠️ 入力欄に文字を打っている最中は横取りしない。寸法を打ち直そうとして
    //     Backspace を押しただけで箱が消えてしまう。
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!blocksState.enabled || !blocksState.picked) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    e.preventDefault();
    removeBlock(blocksState.picked);
  });
  setBlocksEnabled(false);
})();

export {
  blocksState, addBlock, addBlockAt, regroundBlocks, removeAllBlocks,
  setBlocksEnabled, setBlocksOpenHook,
};

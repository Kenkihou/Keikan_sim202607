// =============================================================================
// importobjects — ファイル（点群 .spz/.splat/.ply ／ モデル .glb/.gltf）を取り込み、
//   クリックした場所へ置いて、ギズモで位置合わせする。
//
//   【使い方】
//     ① 「ファイルを選ぶ」か、画面へドラッグ&ドロップ
//     ② 取り込むと「配置待ち」になる → 街のどこかをクリックするとそこへ置かれる
//     ③ 一覧で選ぶとギズモが付く。移動・回転・拡大縮小で詰める
//
//   【入れ子のかたち】★ ここが設計の要点。
//       group   … ギズモが動かす／保存される「街のどこに置くか」
//         └ content … 元ファイルの座標系を直す固定の回転（点群のみ）
//     動画からの再構成（COLMAP系）は +Y が【下】向きの規約で出てくることが多く、
//     そのまま読むと天地が逆になる。これは「ファイルの直し」であって「配置」では
//     ないので、ギズモの操作対象から外して内側に持たせる。こうしておくと、
//     配置をリセットしても天地だけが戻ってしまうことがない。
//     .glb/.gltf は +Y=上 が規格なので、この補正は掛けない。
//
//   【保存されるもの】
//     配置（位置・向き・倍率）だけを localStorage に「ファイル名→変換」で覚える。
//     ★ ファイルの中身は保存しない（86MB級を抱え込むため）。再読み込み後に
//       同じ名前のファイルをもう一度取り込むと、前回合わせた位置に戻る。
//
//   【点群が重い事情】
//     実写の点群は粒が密集する（実測の京都の庭は 2,836,254粒が20m四方）。
//     スプラットは1粒ごとに半透明の四角形を2枚描いて奥から順にブレンドするので、
//     コストは「粒の数」ではなく【画面上で塗る面積の総和】で決まる
//     （実測: 面積上位1%の粒だけで総面積の56.6%）。上空から眺める間は画面の一部に
//     しか映らないので問題にならないが、ストリートビューは【点群の中に立つ】ので
//     1画素あたりの重ね塗りが最大になる。
//     → 歩いている間だけ描画品質を落とす（QUALITY.walk）。抜けたら戻す。
// =============================================================================
import {
  THREE, scene, el, camera, controls, renderer, requestRender, BASE_PIXEL_RATIO,
} from './core.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// 圧縮された GLB を読むためのデコーダ（下の getGltfLoader を参照）。
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import {
  AUTOLOAD_URLS, AUTOLOAD_ORIGIN, SPLAT_BASE_ROTATION, STL_BASE_ROTATION,
  IMPORT_SPLAT_EXT, IMPORT_MESH_EXT, IMPORT_STATE_KEY, SPLAT_FILE_TYPE,
  IMPORT_GIZMO_MOVE_SNAP, IMPORT_GIZMO_ROTATE_SNAP,
} from './config.js';
import { lonLatToLocal, localToLonLat } from './geo.js';
import { pickLanding } from './streetview.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// ---- 点群の描画品質のプロファイル ---------------------------------------------
//   値の意味（いずれも Spark の SparkRenderer の設定）:
//     maxStdDev        … ガウス分布を何σまで描くか。既定 √8≒2.83。小さくすると
//                        1粒あたりの四角形が小さくなる＝塗り面積が直接減る。
//                        公式は √4〜√9 なら見た目は許容範囲としている。
//                        √5 は √8 に対して面積比 5/8＝【塗り 37%減】。
//     maxPixelRadius   … 1粒が画面上で広がってよい半径[px]の上限。既定 512。
//                        中に立つと近くの粒が画面いっぱいに膨らむので、そこを抑える。
//     minSortIntervalMs… 奥行きソートの最小間隔[ms]。既定 0（毎フレーム）。
//                        歩くとカメラが動き続けてソートも毎フレーム走るため、
//                        間隔を空けてフレームレートから切り離す。
//                        ※ 粒がパラついて見えるならここを 0〜15 に戻すこと。
const QUALITY = {
  // 上空から眺める間。画質優先（Spark の既定値のまま）。
  normal: { pixelRatio: BASE_PIXEL_RATIO, maxStdDev: Math.sqrt(8), maxPixelRadius: 512, minSortIntervalMs: 0 },
  // 点群の中に立って歩く間。速度優先。
  walk: { pixelRatio: 1, maxStdDev: Math.sqrt(5), maxPixelRadius: 128, minSortIntervalMs: 30 },
};

// Spark は「splat 用の描画パス」を scene に足すだけの Object3D。
// 通常の renderer.render(scene, camera) の中で一緒に処理される。
const sparkRenderer = new SparkRenderer({ renderer });
scene.add(sparkRenderer);

// 取り込んだオブジェクトの一覧。1件 = { id, name, kind, group, content, objectUrl }
const items = [];
let nextId = 1;
let selected = null;     // 選んでいる item（ギズモが付く）
let placing = null;      // 「クリック待ち」の item（取り込んだ直後）

const importState = {
  walk: false,           // いま歩行モードの品質になっているか
  message: '',           // パネルに出す一言（読み込み中・エラーなど）
  isError: false,        // その一言が失敗の知らせかどうか（色分け用）
};

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
};
const kindOf = (name) => {
  const e = extOf(name);
  if (IMPORT_SPLAT_EXT.includes(e)) return 'splat';
  if (IMPORT_MESH_EXT.includes(e)) return 'mesh';
  return null;
};
const hasSplat = () => items.some((it) => it.kind === 'splat' && it.group.visible);

// =========================================================================
// 配置の保存・復元（localStorage）
//   ★ ギズモで合わせた結果が再読み込みで消えると、位置合わせが毎回やり直しになる。
//     保存するのは group の変換だけ（＝人が決めた「どこに置くか」）。
// =========================================================================
function readStore() {
  try { return JSON.parse(localStorage.getItem(IMPORT_STATE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveTransform(item) {
  try {
    const store = readStore();
    store[item.name] = {
      p: item.group.position.toArray(),
      q: item.group.quaternion.toArray(),
      s: item.group.scale.x,
    };
    localStorage.setItem(IMPORT_STATE_KEY, JSON.stringify(store));
  } catch { /* 保存できなくても動作は続ける */ }
}
// 覚えている配置があれば適用する。あったかどうかを返す。
function restoreTransform(item) {
  const st = readStore()[item.name];
  if (!st || !Array.isArray(st.p) || !Array.isArray(st.q)
      || !st.p.every(Number.isFinite) || !st.q.every(Number.isFinite)) return false;
  item.group.position.fromArray(st.p);
  item.group.quaternion.fromArray(st.q);
  item.group.scale.setScalar(Number.isFinite(st.s) && st.s > 0 ? st.s : 1);
  return true;
}

// =========================================================================
// 描画品質
// =========================================================================
function applyQuality() {
  // ★ 落とすのは【点群が実際に描かれているときだけ】。点群が無い・消しているのに
  //   画面全体の解像度が下がると、原因の分からない画質低下として現れる。
  const q = (importState.walk && hasSplat()) ? QUALITY.walk : QUALITY.normal;
  sparkRenderer.maxStdDev = q.maxStdDev;
  sparkRenderer.maxPixelRadius = q.maxPixelRadius;
  sparkRenderer.minSortIntervalMs = q.minSortIntervalMs;
  // ⚠️ setPixelRatio は内部で setSize を呼び直すので、これだけでよい
  //   （別途 setSize を呼ぶと今の画面サイズを取り違える恐れがある）。
  if (renderer.getPixelRatio() !== q.pixelRatio) renderer.setPixelRatio(q.pixelRatio);
  requestRender();
}

// ストリートビューの出入りに合わせて呼ばれる（main.js が状態の変化を見て呼ぶ）。
function setSplatWalkMode(on) {
  if (importState.walk === !!on) return;
  importState.walk = !!on;
  applyQuality();
}

// =========================================================================
// 読み込み
// =========================================================================
// 点群。Spark の SplatMesh は作った時点で読み込みが始まるので、成功を待ってから使う。
//   ⚠️ fileType を必ず渡すこと。ドラッグ&ドロップしたファイルは blob URL になって
//     拡張子が消えるため、.splat/.ksplat は形式を判別できずに読み込みが失敗する。
async function loadSplatContent(url, fileType) {
  const mesh = new SplatMesh(fileType ? { url, fileType } : { url });
  try {
    await mesh.initialized;
  } catch (err) {
    mesh.dispose?.();
    throw err;
  }
  // ※ 座標系の直し（SPLAT_BASE_ROTATION）は addItem がまとめて掛ける。
  return mesh;
}

// モデル（GLB/GLTF）。
//   ★ 圧縮された GLB に対応するため、デコーダを繋いだ GLTFLoader を1つ使い回す。
//     素の GLTFLoader では、次のいずれかが使われていると読み込みに失敗する:
//       ・Draco 圧縮ジオメトリ（Blender の書き出しや配布モデルで非常に多い）
//       ・Meshopt 圧縮（gltfpack を通したもの）
//       ・KTX2/Basis テクスチャ
//     いずれも「デコーダを渡していない」という理由で例外になるだけなので、
//     繋いでおけば読める。デコーダ本体は CDN から取る（three 本体と同じ流儀）。
//   ⚠️ デコーダの用意に失敗しても、素の GLB は読めるようにしておくこと
//     （CDN に届かないだけで全部読めなくなるのは割に合わない）。
let gltfLoader = null;
function getGltfLoader() {
  if (gltfLoader) return gltfLoader;
  gltfLoader = new GLTFLoader();
  try {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    gltfLoader.setDRACOLoader(draco);
  } catch (err) { console.warn('Draco デコーダを用意できませんでした:', err); }
  try {
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('https://unpkg.com/three@0.185.0/examples/jsm/libs/basis/');
    ktx2.detectSupport(renderer);
    gltfLoader.setKTX2Loader(ktx2);
  } catch (err) { console.warn('KTX2 デコーダを用意できませんでした:', err); }
  try {
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  } catch (err) { console.warn('Meshopt デコーダを用意できませんでした:', err); }
  return gltfLoader;
}

// 取り込んだメッシュの共通の仕上げ。
//   ⚠️ 片面マテリアルのモデルは、裏から見ると面が抜けて見える。取り込んだものは
//     どの向きから眺めるか分からないので両面にする（usermodel.js と同じ扱い）。
function faceBothSides(root) {
  root.traverse((c) => {
    if (!c.isMesh || !c.material) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    for (const m of mats) m.side = THREE.DoubleSide;
  });
  return root;
}

// OBJ。★ 材質は別ファイル（.mtl）なので、単体では色が付かない（形だけ）。
//   ドラッグ&ドロップは blob URL で参照を解決できないため、.mtl は読みに行かない。
async function loadObjContent(url) {
  const root = await new OBJLoader().loadAsync(url);
  // 既定は白い MeshPhongMaterial。この画面は空と太陽の光なので、
  // そのままだと白飛びしがち。少し落ち着いた灰色にしておく。
  //   ⚠️ 法線（vn）を持たない OBJ は珍しくない。そのまま光を当てる材質を割り当てると
  //     陰影が計算できず【真っ黒】になる（実際にそうなった）。無ければここで作る。
  root.traverse((c) => {
    if (!c.isMesh) return;
    if (c.geometry && !c.geometry.getAttribute('normal')) c.geometry.computeVertexNormals();
    c.material = new THREE.MeshStandardMaterial({ color: 0xb9c0cb, roughness: 0.85 });
  });
  return faceBothSides(root);
}

// STL。★ 返ってくるのは【ジオメトリ1つ】でシーンではないので、こちらで包む。
async function loadStlContent(url) {
  const geo = await new STLLoader().loadAsync(url);
  // ⚠️ 法線は「有無」だけ見ても足りない。STL は面ごとに法線を持つ規格だが、
  //   【全部ゼロで書き出す道具が実在する】（読む側が頂点の並び順から求める前提）。
  //   属性としては存在するので有無の判定はすり抜け、長さ0の法線で陰影を計算した
  //   結果【モデルが真っ黒になる】（実際にそうなった）。長さを見て作り直す。
  const nrm = geo.getAttribute('normal');
  let degenerate = !nrm;
  if (nrm) {
    const step = Math.max(1, Math.floor(nrm.count / 300));   // 全部見なくても足りる
    degenerate = true;
    for (let i = 0; i < nrm.count; i += step) {
      const x = nrm.getX(i), y = nrm.getY(i), z = nrm.getZ(i);
      if (x * x + y * y + z * z > 1e-6) { degenerate = false; break; }
    }
  }
  if (degenerate) geo.computeVertexNormals();
  // STL は色を持たないのが普通だが、頂点色付きの方言もある。あれば活かす。
  const mat = new THREE.MeshStandardMaterial({
    color: geo.hasColors ? 0xffffff : 0xb9c0cb,
    vertexColors: !!geo.hasColors,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

async function loadGltfContent(url) {
  const gltf = await getGltfLoader().loadAsync(url);
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  // ⚠️ scene を持たない glTF（アニメーションやマテリアルだけの断片）もあり得る。
  //   そのまま traverse すると意味の分からない TypeError になるので、ここで弾く。
  if (!root) throw new Error('モデル（scene）が入っていません');
  return faceBothSides(root);
}

// 拡張子ごとの読み込み口。
async function loadMeshContent(url, ext) {
  if (ext === '.obj') return loadObjContent(url);
  if (ext === '.stl') return loadStlContent(url);
  return loadGltfContent(url);
}

// 元ファイルの座標系を直すための固定の回転[度]（配置とは別物。冒頭の解説を参照）。
function baseRotationFor(kind, ext) {
  if (kind === 'splat') return SPLAT_BASE_ROTATION;
  if (ext === '.stl') return STL_BASE_ROTATION;
  return null;   // .glb/.gltf は +Y=上 が規格、.obj も慣例的に Y-up
}

// 1件を作って一覧に加える。place: 'click'（クリック待ち）/ 'origin'（既定位置）
async function addItem(name, url, { objectUrl = null, place = 'click' } = {}) {
  const kind = kindOf(name);
  if (!kind) {
    importState.message = `対応していない形式です: ${name}`;
    importState.isError = true;
    updateUi();
    return null;
  }
  importState.message = `読み込み中… ${name}`;
  importState.isError = false;
  updateUi();

  const ext = extOf(name);
  let content;
  try {
    content = kind === 'splat'
      ? await loadSplatContent(url, SPLAT_FILE_TYPE[ext])
      : await loadMeshContent(url, ext);
  } catch (err) {
    // ★ 理由まで出すこと。ファイル名だけだと「なぜ駄目なのか」が分からず、
    //   コンソールを開かない限り手の打ちようがない（実際にそれで詰まった）。
    console.warn('取り込みに失敗:', name, err);
    const reason = String(err && err.message ? err.message : err);
    importState.isError = true;
    importState.message = `読み込みに失敗: ${name}\n${reason}`;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    updateUi();
    return null;
  }

  // 元ファイルの座標系の直し。ギズモの操作対象ではないので内側に固定で持たせる
  // （こうしておくと、配置をリセットしても向きの補正だけが戻ることがない）。
  const baseRot = baseRotationFor(kind, ext);
  if (baseRot) {
    content.rotation.set(
      baseRot.x * DEG2RAD, baseRot.y * DEG2RAD, baseRot.z * DEG2RAD,
    );
  }

  const group = new THREE.Group();
  group.name = `placed:${name}`;
  group.add(content);
  scene.add(group);

  const item = { id: nextId++, name, kind, group, content, objectUrl };
  items.push(item);

  // 覚えている配置があればそれを使い、無ければ指定の置き方に従う。
  const restored = restoreTransform(item);
  if (!restored && place === 'origin') {
    const { x, z } = lonLatToLocal(AUTOLOAD_ORIGIN.lon, AUTOLOAD_ORIGIN.lat);
    group.position.set(x, AUTOLOAD_ORIGIN.y ?? 0, z);
  }
  if (!restored && place === 'click') {
    // まだ置き場所が決まっていない。クリックされるまで足元に隠しておく
    // （原点にいきなり出すと、遠くの街に紛れて見失う）。
    group.visible = false;
    startPlacing(item);
  }

  importState.message = '';
  importState.isError = false;
  selectItem(item);
  applyQuality();
  updateUi();
  requestRender();
  return item;
}

// 起動時の自動読み込み。候補を順に試して、先に見つかった1つだけを使う。
async function autoload() {
  for (const url of AUTOLOAD_URLS) {
    const name = url.split('/').pop();
    const kind = kindOf(name);
    if (!kind) continue;
    try {
      // ★ 先に HEAD で存在を確かめる。いきなり読ませると、404 のときに
      //   Spark 側が worker のエラーとして投げるので原因が分かりにくい。
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) continue;
    } catch { continue; }
    const item = await addItem(name, url, { place: 'origin' });
    if (item) return;
  }
}

// =========================================================================
// クリックで置く
//   ★ pointerdown は消費しない。消費するとカメラを回せなくなるので、
//     「ほとんど動かさずに離した＝クリック」のときだけ置く（blocks.js と同じ作法）。
// =========================================================================
const CLICK_THRESHOLD_PX = 4;
let downAt = null;

function startPlacing(item) {
  placing = item;
  renderer.domElement.style.cursor = 'crosshair';
  updateUi();
}
function stopPlacing() {
  placing = null;
  renderer.domElement.style.cursor = '';
  updateUi();
}

function onPointerDown(ev) {
  if (!placing || ev.button !== 0) return;
  downAt = { x: ev.clientX, y: ev.clientY };
}
function onPointerUp(ev) {
  if (!placing || !downAt) return;
  const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
  downAt = null;
  if (moved > CLICK_THRESHOLD_PX) return;   // カメラを回しただけ
  const hit = pickLanding(ev.clientX, ev.clientY);
  if (!hit) {
    importState.message = '街の上でクリックしてください（空をクリックしても置けません）';
    importState.isError = true;
    updateUi();
    return;
  }
  const item = placing;
  item.group.position.copy(hit.point);
  item.group.visible = true;
  saveTransform(item);
  stopPlacing();
  selectItem(item);
  applyQuality();
  requestRender();
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);
renderer.domElement.addEventListener('pointerup', onPointerUp);

// =========================================================================
// 取り込み（ファイル選択・ドラッグ&ドロップ）
// =========================================================================
async function importFiles(fileList) {
  for (const file of fileList) {
    if (!kindOf(file.name)) {
      importState.message = `対応していない形式です: ${file.name}`;
      importState.isError = true;
      updateUi();
      continue;
    }
    // ⚠️ blob URL には拡張子が無いので、形式の判別は【ファイル名】から行う
    //   （addItem が kindOf / SPLAT_FILE_TYPE に名前を通す）。
    const objectUrl = URL.createObjectURL(file);
    await addItem(file.name, objectUrl, { objectUrl, place: 'click' });
  }
}

function setupDropZone() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const t of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(t, stop, false);
  }
  window.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) importFiles([...files]);
  });
}

// =========================================================================
// 削除
// =========================================================================
function disposeContent(item) {
  if (item.kind === 'splat') {
    item.content.dispose?.();
    return;
  }
  item.content.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
        if (m[k]) m[k].dispose();
      }
      m.dispose();
    }
  });
}

function removeItem(item) {
  const i = items.indexOf(item);
  if (i < 0) return;
  if (placing === item) stopPlacing();
  if (selected === item) selectItem(null);
  scene.remove(item.group);
  disposeContent(item);
  // blob URL は取り込んだファイルの実体を掴んでいる。消すまで解放しない。
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  items.splice(i, 1);
  applyQuality();
  updateUi();
  requestRender();
}

// =========================================================================
// ギズモ（移動・回転・拡大縮小）
//   ★ 地形への接地・注目地点への追従はしない。ドラッグした場所・向き・大きさが
//     そのまま最終結果になり、離した時点で保存される。
// =========================================================================
let gizmoMode = 'translate';   // 'translate' | 'rotate' | 'scale' | 'off'
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('translate');
gizmo.setTranslationSnap(IMPORT_GIZMO_MOVE_SNAP);
gizmo.setRotationSnap(THREE.MathUtils.degToRad(IMPORT_GIZMO_ROTATE_SNAP));
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
gizmo.enabled = false;
if (gizmo.getHelper) gizmo.getHelper().visible = false;

gizmo.addEventListener('change', () => requestRender());
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;   // ドラッグ中はカメラを回さない
  if (!e.value && selected) { saveTransform(selected); requestRender(); }
});
gizmo.addEventListener('objectChange', () => updateInfo());

function refreshGizmo() {
  const on = gizmoMode !== 'off' && selected && selected.group.visible;
  gizmo.enabled = !!on;
  if (gizmo.getHelper) gizmo.getHelper().visible = !!on;
  if (on) {
    gizmo.attach(selected.group);
    gizmo.setMode(gizmoMode);
  } else {
    gizmo.detach();
  }
  requestRender();
}

function setGizmoMode(mode) {
  gizmoMode = mode;
  refreshGizmo();
  updateUi();
}

function selectItem(item) {
  selected = item;
  refreshGizmo();
  updateUi();
}

// =========================================================================
// HUD
// =========================================================================
const ui = {};

function sizeOf(item) {
  // 取り込んだものの実寸。mm で書き出したモデルを取り込むと桁で分かるので、
  // 倍率を決める手がかりになる（例: 20000m と出たら mm → 倍率 0.001）。
  const box = item.kind === 'splat' && item.content.getBoundingBox
    ? item.content.getBoundingBox(false)
    : new THREE.Box3().setFromObject(item.content);
  if (!box || box.isEmpty()) return null;
  const s = box.getSize(new THREE.Vector3()).multiplyScalar(item.group.scale.x);
  return s;
}

function updateInfo() {
  if (!ui.info) return;
  if (!selected) {
    ui.info.textContent = items.length ? '一覧から選ぶと動かせます' : '';
    ui.latlon.textContent = '';
    return;
  }
  const g = selected.group;
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'YXZ');
  const sz = sizeOf(selected);
  ui.info.textContent =
    `高さ ${g.position.y.toFixed(1)} m ／ 向き ${Math.round(e.y * RAD2DEG)}° `
    + `／ 倍率 ${g.scale.x.toFixed(3)}`
    + (sz ? `\n実寸 ${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)} m` : '');
  // ★ 緯度経度も出す。合わせ込んだ値は config.js の AUTOLOAD_ORIGIN に書き戻せる。
  const { lat, lon } = localToLonLat(g.position.x, g.position.z);
  ui.latlon.textContent = `緯度 ${lat.toFixed(6)} ／ 経度 ${lon.toFixed(6)}`;
  if (ui.scaleInput && document.activeElement !== ui.scaleInput) {
    ui.scaleInput.value = String(+g.scale.x.toFixed(4));
  }
}

function updateList() {
  if (!ui.list) return;
  ui.list.textContent = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'imp-row' + (item === selected ? ' imp-sel' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.group.visible;
    cb.title = '表示・非表示';
    cb.addEventListener('change', () => {
      item.group.visible = cb.checked;
      refreshGizmo();
      applyQuality();
      requestRender();
    });
    row.appendChild(cb);

    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'imp-name';
    nameEl.textContent = item.name + (item === placing ? '（配置待ち）' : '');
    nameEl.title = 'クリックで選ぶ';
    nameEl.addEventListener('click', () => selectItem(item));
    row.appendChild(nameEl);

    const place = document.createElement('button');
    place.type = 'button';
    place.textContent = '置き直す';
    place.title = 'このあと街をクリックした場所へ移します';
    place.addEventListener('click', () => { selectItem(item); startPlacing(item); });
    row.appendChild(place);

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = '取り除く';
    del.addEventListener('click', () => removeItem(item));
    row.appendChild(del);

    ui.list.appendChild(row);
  }
}

function updateUi() {
  const box = el('importUi');
  if (!box) return;
  updateList();
  updateInfo();
  // ⚠️ 状態（読み込み中・失敗の理由）と配置の案内は【別の行に出す】こと。
  //   1つの行を取り合うと、配置待ちのものがあるときに失敗の理由が消えてしまい、
  //   「取り込んだのに何も出ない、理由も分からない」という状態になる。
  if (ui.msg) {
    ui.msg.textContent = importState.message;
    ui.msg.style.color = importState.isError ? '#fca5a5' : '#9fb0c7';
    ui.msg.style.display = importState.message ? '' : 'none';
  }
  if (ui.placeMsg) {
    ui.placeMsg.textContent = placing
      ? `「${placing.name}」を置く場所を街の上でクリックしてください` : '';
    ui.placeMsg.style.display = placing ? '' : 'none';
  }
  for (const b of ui.gizmoRow ? ui.gizmoRow.children : []) {
    b.classList.toggle('active', b.dataset.gizmoMode === gizmoMode);
  }
}

function buildUi() {
  const box = el('importUi');
  if (!box) return;
  box.style.display = 'flex';

  // ---- 取り込み ----
  const pickRow = document.createElement('div');
  pickRow.className = 'map-switch';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = [...IMPORT_SPLAT_EXT, ...IMPORT_MESH_EXT].join(',');
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) importFiles([...fileInput.files]);
    fileInput.value = '';   // 同じファイルをもう一度選べるようにする
  });
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.textContent = '3Dモデルをインポート';
  pickBtn.addEventListener('click', () => fileInput.click());
  pickRow.appendChild(pickBtn);
  pickRow.appendChild(fileInput);
  box.appendChild(pickRow);

  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.style.fontSize = '11px';
  // ★ 対応形式は config の配列から組み立てる（増やしたときに書き換え忘れないように）。
  hint.textContent = '画面へドラッグ&ドロップでも取り込めます（'
    + `点群 ${IMPORT_SPLAT_EXT.join(' ')} ／ モデル ${IMPORT_MESH_EXT.join(' ')}）`;
  box.appendChild(hint);

  // ---- 一覧 ----
  ui.list = document.createElement('div');
  ui.list.id = 'importList';
  box.appendChild(ui.list);

  // ---- 状況・案内 ----
  ui.msg = document.createElement('div');
  ui.msg.className = 'stats-line';
  ui.msg.style.whiteSpace = 'pre-line';   // 失敗の理由を2行目に出すため
  box.appendChild(ui.msg);

  ui.placeMsg = document.createElement('div');
  ui.placeMsg.className = 'stats-line';
  ui.placeMsg.style.color = '#f4c542';
  box.appendChild(ui.placeMsg);

  // ---- 選択中のものの操作 ----
  ui.info = document.createElement('div');
  ui.info.className = 'stats-line';
  ui.info.style.whiteSpace = 'pre-line';
  box.appendChild(ui.info);

  ui.latlon = document.createElement('div');
  ui.latlon.className = 'stats-line';
  box.appendChild(ui.latlon);

  const gizmoRow = document.createElement('div');
  gizmoRow.className = 'map-switch';
  gizmoRow.style.marginTop = '0';
  for (const [label, mode] of [['移動', 'translate'], ['回転', 'rotate'],
    ['拡大縮小', 'scale'], ['操作なし', 'off']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.gizmoMode = mode;
    b.addEventListener('click', () => setGizmoMode(mode));
    gizmoRow.appendChild(b);
  }
  ui.gizmoRow = gizmoRow;
  box.appendChild(gizmoRow);

  // 倍率は数値でも決められるようにする（mm で書き出した GLB は 0.001 と入れれば合う）。
  const scaleRow = document.createElement('div');
  scaleRow.className = 'clip-row';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'sub-title';
  scaleLabel.textContent = '倍率';
  ui.scaleInput = document.createElement('input');
  ui.scaleInput.type = 'number';
  ui.scaleInput.step = '0.001';
  ui.scaleInput.min = '0.0001';
  ui.scaleInput.style.width = '6em';
  ui.scaleInput.addEventListener('input', () => {
    const v = Number(ui.scaleInput.value);
    if (!selected || !Number.isFinite(v) || v <= 0) return;
    selected.group.scale.setScalar(v);
    saveTransform(selected);
    updateInfo();
    requestRender();
  });
  scaleRow.appendChild(scaleLabel);
  scaleRow.appendChild(ui.scaleInput);
  box.appendChild(scaleRow);

  updateUi();
}

buildUi();
setupDropZone();
autoload();

export {
  importState, items, sparkRenderer,
  setSplatWalkMode, importFiles, removeItem, selectItem, startPlacing,
};

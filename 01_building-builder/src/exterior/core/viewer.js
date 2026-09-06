/* ============================================================
   外構ビューア：本体アプリ（01_building-builder）のシーンに相乗りする層

   tree/planner.html の js/core/viewer.js を、本体アプリ用に置き換えたもの。
   planner は「自前のシーン・カメラ・地面」を持っていたが、こちらは本体アプリの
   scene / camera / renderer / controls をそのまま借りる。

   ⚠️ 単位の違いに注意
     ・本体アプリ … mm（グリッド 20000mm、スナップ 500mm）
     ・外構の地物 … m（planner から移植した items/*.js は m で形を作る）
   このファイルが両者の境界。外向きの座標（pickGround の戻り値など）は m、
   シーンに置くときだけ MM 倍して mm に直す。
   ============================================================ */
import { markTool } from '../../subcam.js';
import * as THREE from 'three';

export const MM = 1000;                 // 1m = 1000mm

/* 外構の地物はすべてこの中に入る（mm 空間。中身の各地物は自分で 1000倍される） */
export const world = new THREE.Group();
world.name = 'exteriorWorld';

let scene = null, camera = null, renderer = null, controls = null;
let requestRender = () => {};
let getSnapMM = () => 500;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

let marker = null, rubber = null, lights = null;

export function initViewer(ctx){
  scene = ctx.scene;
  camera = ctx.camera;
  renderer = ctx.renderer;
  controls = ctx.controls;
  requestRender = ctx.render || (() => {});
  if (ctx.getSnapMM) getSnapMM = ctx.getSnapMM;

  scene.add(world);

  /* --- 照明 ---
     本体アプリのシーンにはライトが無い（建物は MeshBasicMaterial の白模型表現）。
     外構の地物は MeshStandardMaterial 系なので、光が無いと真っ黒になる。
     ここで足すライトは Basic マテリアルの建物には一切影響しない。 */
  lights = new THREE.Group();
  lights.name = 'exteriorLights';
  lights.add(new THREE.HemisphereLight(0xd6e8f5, 0x64705a, 1.05));
  lights.add(new THREE.AmbientLight(0xffffff, 0.22));

  const sun = new THREE.DirectionalLight(0xfff4e2, 1.45);
  sun.position.set(16000, 26000, 12000);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 60;                 // 60mm
  const sc = sun.shadow.camera;
  sc.left = -40000; sc.right = 40000; sc.top = 40000; sc.bottom = -40000;
  sc.near = 1000; sc.far = 120000;
  sc.updateProjectionMatrix();
  lights.add(sun, sun.target);
  scene.add(lights);

  /* three 0.184 では PCFSoftShadowMap が廃止予定（警告が出る）ので PCF を使う */
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  /* --- スナップ位置の印（mm） --- */
  marker = new THREE.Mesh(
    new THREE.RingGeometry(0.12 * MM, 0.20 * MM, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.95, depthTest: false })
  );
  marker.position.y = 10;
  marker.visible = false;
  marker.renderOrder = 10;
  markTool(marker);               // ★ 作図中の印も道具
  scene.add(marker);

  /* --- 作図中の線（折れ線にも使うので余裕をもった頂点数で確保しておく） --- */
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 256), 3));
  rg.setDrawRange(0, 0);
  rubber = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0xff8a3d, depthTest: false }));
  rubber.position.y = 20;
  rubber.visible = false;
  rubber.renderOrder = 10;
  markTool(rubber);               // ★ 作図中の線も道具
  scene.add(rubber);
}

export const getScene = () => scene;
export const getCamera = () => camera;
export const getRenderer = () => renderer;
export const getControls = () => controls;
export const getSnapM = () => getSnapMM() / MM;      // スナップ量を m で
export function render(){ requestRender(); }

/* ★追加：地盤面上の点（m）→ 画面の位置（px）。
   作図中の札や寸法を、手を動かしている場所のそばに出すために使う。 */
export function toScreen(p){
  const v = new THREE.Vector3(p.x * MM, 0, p.z * MM).project(camera);
  return { x: (v.x + 1) / 2 * window.innerWidth,
           y: (-v.y + 1) / 2 * window.innerHeight };
}

/* ★追加：目印を【閉じられる合図】として強調する。
   ⚠️ 最初の点に戻れば閉じられる、ということは言葉で説明しても読まれない。
     近づいたら印の色と大きさが変わる、という形で見せる。 */
export function setMarkerHot(on){
  if (!marker) return;
  marker.material.color.set(on ? 0x1f9d55 : 0xff8a3d);
  marker.scale.setScalar(on ? 1.6 : 1);
  render();
}

/* 画面座標 → 地盤面上の点（m 単位・スナップ済み） */
export function pickGround(ev, snap = true){
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  if (!hit) return null;
  const g = getSnapMM();
  const p = { x: hit.x / MM, z: hit.z / MM, y: 0 };
  if (snap){
    p.x = Math.round(hit.x / g) * g / MM;
    p.z = Math.round(hit.z / g) * g / MM;
  }
  return p;
}

/* 画面座標 → 配置済みの外構地物（クリックで選択） */
export function pickItem(ev){
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(world.children, true);
  for (const h of hits){
    let o = h.object;
    while (o && o.parent !== world) o = o.parent;
    if (o && o.userData.item) return o;
  }
  return null;
}

/* 作図中の目印（p は m 単位） */
export function showMarker(p){
  if (!marker) return;
  if (!p){ marker.visible = false; render(); return; }
  marker.visible = true;
  marker.position.set(p.x * MM, 10, p.z * MM);
  render();
}

/* 作図中の線を描く。pts は確定済みの点、cursor は今マウスがある点（ともに m 単位） */
export function showRubber(pts, cursor){
  if (!rubber) return;
  const list = [];
  if (Array.isArray(pts)) list.push(...pts);
  else if (pts) list.push(pts);
  if (cursor) list.push(cursor);
  if (list.length < 2){ rubber.visible = false; render(); return; }
  const pos = rubber.geometry.attributes.position;
  const n = Math.min(list.length, pos.count);
  for (let i = 0; i < n; i++) pos.setXYZ(i, list[i].x * MM, 0, list[i].z * MM);
  pos.needsUpdate = true;
  rubber.geometry.setDrawRange(0, n);
  rubber.geometry.computeBoundingSphere();
  rubber.visible = true;
  render();
}

/* 外構モードの出入りで、作図中の表示だけ消す */
export function clearOverlays(){
  if (marker) marker.visible = false;
  if (rubber) rubber.visible = false;
}

/* 地物を画面に収める */
export function focusOn(obj){
  const b = new THREE.Box3().setFromObject(obj);
  if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3());
  const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.6, 1500);
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 2.2);
  controls.update();
  render();
}

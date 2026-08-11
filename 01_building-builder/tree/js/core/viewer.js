/* ============================================================
   ビューア：シーン・カメラ・光・地面（1m方眼）・ピッキング
   ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const GRID = 1.0;                 // 方眼の間隔 (m)
export const HALF = 30;                  // 方眼の広さ（±30m）

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 800);
export const renderer = new THREE.WebGLRenderer({ antialias: true });
export let controls;

export const world = new THREE.Group();  // 配置した地物はここに入る
scene.add(world);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let groundPlane, gridHelper, marker, rubber;

function skyTexture(){
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#93aabf');
  grad.addColorStop(0.55, '#c4ced6');
  grad.addColorStop(1.0, '#e3e5e0');
  g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function initViewer(container){
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0xc4ced6, 60, 240);

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 1.5;
  controls.maxDistance = 160;
  controls.target.set(0, 0.6, 0);

  camera.position.set(-11, 8, 13);

  scene.add(new THREE.HemisphereLight(0xd6e8f5, 0x64705a, 1.05));
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  const sun = new THREE.DirectionalLight(0xfff4e2, 1.45);
  sun.position.set(16, 26, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.06;
  const c = sun.shadow.camera;
  c.left = -30; c.right = 30; c.top = 30; c.bottom = -30;
  c.near = 1; c.far = 90;
  c.updateProjectionMatrix();
  scene.add(sun, sun.target);

  /* 地面 */
  groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 4, HALF * 4),
    new THREE.MeshStandardMaterial({ color: 0xb9b6ac, roughness: 1.0 })
  );
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = -0.002;
  groundPlane.receiveShadow = true;
  scene.add(groundPlane);

  /* 1m 方眼 */
  gridHelper = new THREE.GridHelper(HALF * 2, HALF * 2, 0x7d8a92, 0xa9b1b3);
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.55;
  scene.add(gridHelper);

  /* スナップ位置の印 */
  marker = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.2, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.95, depthTest: false })
  );
  marker.position.y = 0.01;
  marker.visible = false;
  marker.renderOrder = 10;
  scene.add(marker);

  /* 作図中の線（折れ線にも使うので余裕をもった頂点数で確保しておく） */
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 256), 3));
  rg.setDrawRange(0, 0);
  rubber = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0xff8a3d, depthTest: false }));
  rubber.position.y = 0.02;
  rubber.visible = false;
  rubber.renderOrder = 10;
  scene.add(rubber);

  resize();
  addEventListener('resize', resize);
  (function loop(){
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function resize(){
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

export function setGridVisible(v){ gridHelper.visible = v; }

/* 画面座標 → 地面上の点（スナップ済み） */
export function pickGround(ev, snap = true){
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(groundPlane, false)[0];
  if (!hit) return null;
  const p = hit.point.clone();
  if (snap){
    p.x = Math.round(p.x / GRID) * GRID;
    p.z = Math.round(p.z / GRID) * GRID;
  }
  p.y = 0;
  return p;
}

/* 画面座標 → 配置済み地物（クリックで選択） */
export function pickItem(ev){
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(world.children, true);
  for (const h of hits){
    let o = h.object;
    while (o && o.parent !== world) o = o.parent;
    if (o && o.userData.item) return o;
  }
  return null;
}

export function showMarker(p){
  if (!p){ marker.visible = false; return; }
  marker.visible = true;
  marker.position.set(p.x, 0.01, p.z);
}

/* 作図中の線を描く。pts は確定済みの点、cursor は今マウスがある点 */
export function showRubber(pts, cursor){
  const list = [];
  if (Array.isArray(pts)) list.push(...pts);
  else if (pts) list.push(pts);
  if (cursor) list.push(cursor);
  if (list.length < 2){ rubber.visible = false; return; }
  const pos = rubber.geometry.attributes.position;
  const n = Math.min(list.length, pos.count);
  for (let i = 0; i < n; i++) pos.setXYZ(i, list[i].x, 0, list[i].z);
  pos.needsUpdate = true;
  rubber.geometry.setDrawRange(0, n);
  rubber.geometry.computeBoundingSphere();
  rubber.visible = true;
}

/* 地物を画面に収める */
export function focusOn(obj){
  const b = new THREE.Box3().setFromObject(obj);
  if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3());
  const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.6, 1.5);
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 2.2);
  controls.update();
}

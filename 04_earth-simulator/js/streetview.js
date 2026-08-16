// =============================================================================
// streetview — 足跡を道路に落として、その場に立って歩き回るモード。
//
//   【操作の流れ】
//     ① 足跡ボタン（👣）を押す … 「着地点をさがす」状態に入る。
//        道路が消えていると降りる場所が分からないので、ここで道路の表示を自動で点ける。
//     ② 地面の上でポインタを動かす … 足跡マークが地面に貼り付いて追いかけてくる。
//        道路の上なら緑、それ以外なら赤（＝降りられない）。
//     ③ 道路の上で離す（クリック） … そこへ人の目の高さで降りる。
//     ④ 左下のスティックで前後左右へ歩く。画面をドラッグすると見回せる。
//     ⑤ ✕ で元の視点へ戻る（入る前のカメラをそのまま復元する）。
//
//   【道路かどうかの判定】
//     roads.js の isRoadAt に任せている。あちらは「実際に描かれた絵（MVTを焼いた canvas）」の
//     不透明度を読むので、画面で黄色く光って見えている場所とズレようがない。
//
//   【歩ける範囲】
//     降りるときも歩くときも道路の上だけ。判定は canBeAt() 1か所に閉じ込めてあるので、
//     「降りられたのに歩けない」というような食い違いが起きない。
//
//   【01（モデリング）へ移すときの想定】
//     道路の概念が無いので、canBeAt() を「地盤面ならどこでも true」に差し替えるだけでよい。
// =============================================================================
import {
  THREE, scene, camera, controls, renderer, el, requestRender,
  EARTH_R, focusLocal,
} from './core.js';
import { ORIGIN_LAT, ORIGIN_LON, ORIGIN_ELEVATION } from './config.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getTerrainTiles } from './tiles.js';
import { isRoadAt, setRoadHighlightStrength } from './roads.js';

const DEG = 180 / Math.PI;

// 人の目の高さ[m]。地面からこの高さにカメラを置く。
const EYE_HEIGHT = 1.5;
// 速さ[m/s]は2段階。スティックを浅く倒すと歩き、深く倒すと走る。
//   途中で連続的に変えず段にしているのは、「今どちらで動いているか」が体で分かるようにするため。
const WALK_SPEED = 1.8;   // 歩き（実際の徒歩は約1.4）
const RUN_SPEED = 13.5;   // 走り
// この深さ（0〜1）を超えて倒すと走りに切り替わる
const RUN_THRESHOLD = 0.6;
// 見回すときの感度[rad/px]
const LOOK_SPEED = 0.0035;
// 見上げ・見下ろしの限界（真上・真下で像が破綻するので少し手前で止める）
const MAX_PITCH = Math.PI / 2 - 0.05;
// ストリートビュー中のカメラの near[m]。
//   ⚠️ 通常は near=1 だが、目の高さ1.6mで立つと手前1mまでが消えてしまい、
//     足元の地面や目の前の壁が抜けて見える。近くまで写るように詰める。
const SV_NEAR = 0.1;

// ---- キャラクター（girl3.glb）--------------------------------------------------
//   ★歩く姿を見せるので、カメラはキャラクターの周りを回る「三人称」にしてある。
//     頭の中に居ては本人が見えないため。FOLLOW_DISTANCE を 0 にすれば一人称に戻せる。
const CHARACTER_URL = 'girl3.glb';
const CHARACTER_HEIGHT = 1.5;       // このモデルをこの高さ[m]に揃える（目線の高さに合わせる）
const FOLLOW_DISTANCE = 3.4;        // キャラクターからカメラまでの距離[m]
const FOLLOW_HEIGHT = 1.5;          // 足元からカメラの高さ[m]
const LOOK_AT_HEIGHT = 1.2;         // 見る先（キャラクターの胸あたり）の高さ[m]
const TURN_SPEED = 10;              // 進行方向へ向き直る速さ[1/s]
const CAM_MIN_ABOVE_GROUND = 0.5;   // カメラを地面からこれ以上下げない[m]
// これ以上見上げたらキャラクターを消す[度]。真下から見上げる格好になって見苦しいため。
const CHARA_HIDE_PITCH_DEG = 45;
// glb の中のアクション名。walk1(child) を「歩き」に使う。
const CLIP_IDLE = 'idle', CLIP_WALK = 'walk1(child)', CLIP_RUN = 'run';
const FADE = 0.18;                  // アクションの切り替えにかける時間[s]

const streetViewState = {
  placing: false,   // 着地点をさがしている
  active: false,    // 立って歩いている
};

// 入る前のカメラ・操作の状態（抜けるときにそのまま戻す）
let saved = null;

// -----------------------------------------------------------------------------
// 座標の変換（tiles.js の setFocusLatLon と逆向き。roads.js と同じ式）
//   ワールドは +Z=北 / +X=西 なので、north = z, east = -x。
// -----------------------------------------------------------------------------
function worldToLonLat(x, z) {
  const lat = ORIGIN_LAT + z / EARTH_R;
  const lon = ORIGIN_LON + (-x) / (EARTH_R * Math.cos(lat));
  return { lat: lat * DEG, lon: lon * DEG };
}

// -----------------------------------------------------------------------------
// 地形へのレイキャスト
// -----------------------------------------------------------------------------
const _rc = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _down = new THREE.Vector3(0, -1, 0);

function terrainRoot() {
  const t = getTerrainTiles();
  return t ? t.group : null;
}

/* いま【表示されている】地形メッシュだけを集める。
   ⚠️ グループを丸ごと intersectObject に渡してはいけない。3D Tiles は粗い段のタイルも
     読み込んだままグループに残していて（表示だけ切っている）、Raycaster は visible を
     見ないので、それらにも当たってしまう。上から撃つと粗い段のほうが手前で当たり、
     地面の高さが実際より高く出る（実測で 0.66m の地点が 6.64m と出た）。 */
const _visMeshes = [];
function visibleTerrainMeshes() {
  _visMeshes.length = 0;
  const root = terrainRoot();
  if (!root) return _visMeshes;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    // 祖先がひとつでも非表示なら、その枝は画面に出ていない
    for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
    _visMeshes.push(o);
  });
  return _visMeshes;
}

/* 画面座標(px) → 地形上の点。当たらなければ null。 */
function pickGround(clientX, clientY) {
  const meshes = visibleTerrainMeshes();
  if (!meshes.length) return null;
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
  _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
  _rc.setFromCamera(_ndc, camera);
  const hits = _rc.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.clone() : null;
}

/* ある x,z の地面の高さ。真上から下向きに撃つ。見つからなければ null。
   ⚠️ いちばん手前（＝いちばん高い）当たりを採ってはいけない。地形は粗い段と細かい段が
     重なって存在し、しかも読み込み中は入れ替わるので、上から見て最初に当たる面が
     「今見えている地面」とは限らない（実測で、地面 1.25m の場所が 4.97m と出た）。
     直前の地面の高さがあれば、それにいちばん近い当たりを採る。 */
const _origin = new THREE.Vector3();
function groundYAt(x, z, near = null) {
  const meshes = visibleTerrainMeshes();
  if (!meshes.length) return null;
  // 十分上から撃つ（山の上でも抜けないように）
  _rc.set(_origin.set(x, 4000, z), _down);
  const hits = _rc.intersectObjects(meshes, false);
  if (!hits.length) return null;
  if (near === null) return hits[0].point.y;
  let best = hits[0].point.y;
  for (const h of hits) {
    if (Math.abs(h.point.y - near) < Math.abs(best - near)) best = h.point.y;
  }
  return best;
}

/* ★そこに居てよいか（降りる先・歩く先の両方でこれを使う）。
   降りられる場所と歩ける場所を必ず一致させたいので、判定はこの1か所だけに置く。
   01（モデリング）へ移すときは、ここを「地盤面ならどこでも true」に差し替えるだけでよい。 */
function canBeAt(x, z) {
  const { lat, lon } = worldToLonLat(x, z);
  return isRoadAt(lat, lon);
}

/* 道路の中心寄りへ少しだけ寄せる。
   道路の縁ぎりぎりに降りると、あとから細かいタイルが届いて縁がずれたときに
   外側へ取り残されやすい。渦巻き状に探して、いちばん近い道路上の点へ置き直す。 */
function snapOntoRoad(x, z, maxR = 4) {
  if (canBeAt(x, z)) return { x, z };
  for (let r = 0.5; r <= maxR; r += 0.5) {
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      const nx = x + Math.cos(th) * r, nz = z + Math.sin(th) * r;
      if (canBeAt(nx, nz)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}

// -----------------------------------------------------------------------------
// 着地点を示す足跡マーカー（地面に貼り付く輪）
// -----------------------------------------------------------------------------
let marker = null;
function ensureMarker() {
  if (marker) return marker;
  marker = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.1, 1.5, 40),
    new THREE.MeshBasicMaterial({ color: 0x38d16a, transparent: true, opacity: 0.95,
      depthTest: false, side: THREE.DoubleSide }),
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 40),
    new THREE.MeshBasicMaterial({ color: 0x38d16a, transparent: true, opacity: 0.3,
      depthTest: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = disc.rotation.x = -Math.PI / 2;
  marker.add(disc, ring);
  marker.renderOrder = 999;   // 地面に埋もれず必ず見えるように
  marker.visible = false;
  scene.add(marker);
  marker.userData.mats = [disc.material, ring.material];
  return marker;
}

function showMarker(point, ok) {
  const m = ensureMarker();
  m.position.set(point.x, point.y + 0.05, point.z);
  m.visible = true;
  for (const mat of m.userData.mats) mat.color.setHex(ok ? 0x38d16a : 0xe4483d);
}
function hideMarker() { if (marker) marker.visible = false; }

// -----------------------------------------------------------------------------
// キャラクター（girl3.glb）
//   立ち・歩き・走りの3つを、動いている速さに応じて切り替える。
//   読み込みは初回に入るときだけ（4MBあるので起動時には読まない）。
// -----------------------------------------------------------------------------
const chara = {
  root: null,          // 位置と向きを持つ入れ物（足元が原点）
  mixer: null,
  actions: {},
  current: null,
  facing: 0,           // 今向いている方位[rad]（進行方向へ滑らかに追従させる）
  loading: null,
};

function loadCharacter() {
  if (chara.root) return Promise.resolve(chara.root);
  if (chara.loading) return chara.loading;
  chara.loading = new Promise((resolve) => {
    new GLTFLoader().load(CHARACTER_URL, (gltf) => {
      const model = gltf.scene;
      // モデルの実寸を測って CHARACTER_HEIGHT に揃える（glb の単位が何であっても合う）
      const box = new THREE.Box3().setFromObject(model);
      const h = box.max.y - box.min.y;
      const s = h > 1e-6 ? CHARACTER_HEIGHT / h : 1;
      model.scale.setScalar(s);
      // 足元が原点に来るように下げる
      model.position.y = -box.min.y * s;

      const root = new THREE.Group();
      root.add(model);
      root.visible = false;
      scene.add(root);

      const mixer = new THREE.AnimationMixer(model);
      const byName = {};
      for (const clip of gltf.animations) byName[clip.name] = clip;
      const pick = (name) => (byName[name] ? mixer.clipAction(byName[name]) : null);
      chara.actions = { idle: pick(CLIP_IDLE), walk: pick(CLIP_WALK), run: pick(CLIP_RUN) };
      for (const k in chara.actions) {
        const a = chara.actions[k];
        if (a) { a.enabled = true; a.setEffectiveWeight(0); a.play(); }
      }
      chara.root = root;
      chara.mixer = mixer;
      playClip('idle');
      resolve(root);
    }, undefined, (err) => {
      console.warn('キャラクターの読み込みに失敗:', err);
      resolve(null);
    });
  });
  return chara.loading;
}

/* アクションを切り替える（重なりを滑らかに） */
function playClip(name) {
  const next = chara.actions[name];
  if (!next || chara.current === next) return;
  next.reset().setEffectiveWeight(1).fadeIn(FADE).play();
  if (chara.current) chara.current.fadeOut(FADE);
  chara.current = next;
}

// -----------------------------------------------------------------------------
// UI（足跡ボタン・スティック・終了ボタン）
//   このモジュールだけで完結させたいので、要素も見た目もここで作る。
// -----------------------------------------------------------------------------
let ui = {};

function buildUi() {
  const style = document.createElement('style');
  style.textContent = `
    /* 👣（開始）は親アプリ 01 の下部パネルに置いてあるので、こちらには出さない。
       単独で 04 を開いたときだけ使えるよう、要素自体は残して JS で出し分ける。 */
    #svEnter, #svExit {
      position: fixed; left: 16px; bottom: 16px; z-index: 60;
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(20,22,28,0.86); color: #fff;
      border: 1px solid rgba(255,255,255,0.28);
      font-size: 24px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    #svEnter:hover, #svExit:hover { background: rgba(38,42,52,0.92); }
    #svEnter.armed { background: #2f7d4a; border-color: #7ee0a2; }
    #svExit { display: none; }
    #svStick {
      position: fixed; left: 24px; bottom: 24px; z-index: 60;
      width: 132px; height: 132px; border-radius: 50%;
      background: rgba(255,255,255,0.16);
      border: 2px solid rgba(255,255,255,0.5);
      display: none; touch-action: none;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35);
    }
    #svKnob {
      position: absolute; left: 50%; top: 50%;
      width: 54px; height: 54px; margin: -27px 0 0 -27px;
      border-radius: 50%; background: rgba(255,255,255,0.92);
      border: 1px solid rgba(0,0,0,0.18);
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    }
    /* 深く倒して走っている間だけ色を変える（今どちらで動いているかの目印） */
    #svKnob.running { background: #ffd23c; border-color: #b98b00; }
    #svHint {
      position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
      z-index: 60; padding: 7px 14px; border-radius: 999px;
      background: rgba(20,22,28,0.86); color: #fff; font-size: 12px;
      display: none; pointer-events: none; white-space: nowrap;
    }
    /* 今どこに立って、どちらを向いているかの読み取り（右上） */
    #svReadout {
      position: fixed; right: 12px; top: 12px; z-index: 60;
      padding: 8px 12px; border-radius: 8px;
      background: rgba(15,15,25,0.85); color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      font-size: 12px; line-height: 1.7; display: none;
      font-variant-numeric: tabular-nums; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #svReadout b { font-weight: 600; color: #9fd0ff; margin-right: 6px; }
    /* パネル自体は操作を通さない（pointer-events:none）ので、ボタンだけ受け取り直す */
    #svCharaToggle {
      margin-top: 7px; width: 100%; pointer-events: auto;
      padding: 5px 8px; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,0.12); color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
      font-size: 12px; font-family: inherit;
    }
    #svCharaToggle:hover { background: rgba(255,255,255,0.2); }
    /* カーナビ風の追従地図（右下）。原点を決める地図（#pickerWrap）とは別物で、
       ストリートビュー中はあちらを隠してこちらだけ出す。 */
    #svMap {
      position: fixed; right: 12px; bottom: 12px; z-index: 60;
      width: 190px; height: 190px; border-radius: 10px; overflow: hidden;
      background: #eee; display: none; cursor: zoom-in;
      border: 2px solid rgba(255,255,255,0.75);
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
    }
    #svMap canvas { display: block; width: 100%; height: 100%; }
    #svMapLabel {
      position: absolute; left: 0; right: 0; top: 0; padding: 3px 26px 3px 6px;
      background: rgba(15,15,25,0.7); color: #fff; font-size: 11px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    /* 地図そのものの大きさを変えるボタン（縮尺の切り替えとは別物）。
       地図本体のクリック＝縮尺の切り替えを邪魔しないよう、こちらは伝播を止める。 */
    #svMapSize {
      position: absolute; right: 3px; top: 2px; z-index: 1;
      width: 20px; height: 18px; padding: 0; cursor: pointer;
      background: rgba(255,255,255,0.18); color: #fff;
      border: 1px solid rgba(255,255,255,0.35); border-radius: 4px;
      font-size: 11px; line-height: 1; font-family: inherit;
    }
    #svMapSize:hover { background: rgba(255,255,255,0.32); }
  `;
  document.head.appendChild(style);

  const enter = document.createElement('button');
  enter.id = 'svEnter'; enter.type = 'button';
  enter.textContent = '👣';
  enter.title = 'ストリートビュー：道路に降りて歩く';

  // ★終了ボタン（✕）は置かない。終わるのは 01 のパネルの 👣（もう一度押す）か Esc。
  //   要素だけは残してあるが、常に隠したまま（他の処理が参照しているため）。
  const exit = document.createElement('button');
  exit.id = 'svExit'; exit.type = 'button';
  exit.style.display = 'none';

  const stick = document.createElement('div');
  stick.id = 'svStick';
  const knob = document.createElement('div');
  knob.id = 'svKnob';
  stick.appendChild(knob);

  const hint = document.createElement('div');
  hint.id = 'svHint';

  // 読み取りは毎フレーム innerHTML を書き換えるので、ボタンは別の要素にして巻き込まない
  const readout = document.createElement('div');
  readout.id = 'svReadout';
  const readoutBody = document.createElement('div');
  readoutBody.id = 'svReadoutBody';
  const charaToggle = document.createElement('button');
  charaToggle.id = 'svCharaToggle'; charaToggle.type = 'button';
  readout.append(readoutBody, charaToggle);

  const map = document.createElement('div');
  map.id = 'svMap';
  const mapCanvas = document.createElement('canvas');
  mapCanvas.width = 190; mapCanvas.height = 190;
  const mapLabel = document.createElement('div');
  mapLabel.id = 'svMapLabel';
  mapLabel.textContent = '現在地';
  const mapSize = document.createElement('button');
  mapSize.id = 'svMapSize'; mapSize.type = 'button';
  mapSize.textContent = '⤢';
  mapSize.title = '地図の大きさを変える';
  map.append(mapCanvas, mapLabel, mapSize);

  document.body.append(enter, exit, stick, hint, readout, map);
  ui = { enter, exit, stick, knob, hint, readout, readoutBody, charaToggle,
         map, mapCanvas, mapSize };
  applyMapSize();

  // 01 の中（iframe）で開かれているときは、👣は親のパネル側にあるのでこちらは隠す。
  const embedded = window.parent && window.parent !== window;
  if (embedded) enter.style.display = 'none';
}

// -----------------------------------------------------------------------------
// 右上の読み取り（今どこに立って、どちらを向いているか）
// -----------------------------------------------------------------------------
const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
const _fwdProbe = new THREE.Vector3();   // 仰角を測るのに使い回す

// キャラクターを見せるかどうか（右上のパネルのボタンで切り替える）
let charaVisible = true;
function applyCharaVisible() {
  // ★見上げすぎたら自動で消す。真下から見上げる格好になって見苦しいため
  //   （手で「人を隠す」にしているときは、角度に関わらず消えたまま）。
  const tooSteep = cameraPitchDeg() > CHARA_HIDE_PITCH_DEG;
  if (chara.root) chara.root.visible = streetViewState.active && charaVisible && !tooSteep;
  if (ui.charaToggle) ui.charaToggle.textContent = charaVisible ? '人を隠す' : '人を表示';
}
function toggleCharaVisible() {
  charaVisible = !charaVisible;
  applyCharaVisible();
  requestRender();
}
function updateReadout() {
  if (!ui.readout) return;
  if (!streetViewState.active) { ui.readout.style.display = 'none'; return; }
  const { lat, lon } = worldToLonLat(stand.x, stand.z);
  // 方位角（北=0°、東回り）。ワールドは +Z=北 / +X=西 なので、東成分は +sin(yaw)。
  //   視線は (-sin yaw, 0, -cos yaw) なので、北成分 = -cos(yaw)、東成分 = sin(yaw)。
  let az = Math.atan2(Math.sin(yawPitch.yaw), -Math.cos(yawPitch.yaw)) * DEG;
  if (az < 0) az += 360;
  const dirName = COMPASS[Math.round(az / 45) % 8];
  // ワールドY=0 が原点の地表（標高 ORIGIN_ELEVATION）。そこからの差が標高の増減。
  const elev = stand.y + ORIGIN_ELEVATION;
  // 仰角は「実際のカメラがどれだけ上を向いているか」を直接測る（+が見上げ）。
  //   orbit の計算式から逆算するより、カメラの姿勢そのものを見るほうが確実。
  _fwdProbe.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, _fwdProbe.y))) * DEG;
  ui.readout.style.display = 'block';
  ui.readoutBody.innerHTML =
    `<div><b>緯度</b>${lat.toFixed(6)}</div>` +
    `<div><b>経度</b>${lon.toFixed(6)}</div>` +
    `<div><b>向き</b>${dirName}（${az.toFixed(0)}°）</div>` +
    `<div><b>仰角</b>${pitchDeg >= 0 ? '+' : ''}${pitchDeg.toFixed(0)}°</div>` +
    `<div><b>画角</b>${camera.fov.toFixed(0)}°</div>` +
    `<div><b>標高</b>${elev.toFixed(1)} m</div>` +
    `<div><b>目線</b>地面 +${EYE_HEIGHT.toFixed(1)} m</div>`;
}

// -----------------------------------------------------------------------------
// カーナビ風の追従地図（右下）
//   ★原点を決める地図（#pickerWrap）とは別物。ストリートビュー中はあちらを隠して
//     こちらだけ出す。中心は常にキャラクターで、歩くと地図のほうが流れる。
//   タイルは地理院地図（ui.js の小窓と同じもの）。読み込んだ画像は使い回す。
// -----------------------------------------------------------------------------
/* 原点（3Dモデルの置き場所）を決める地図の出し入れ。
   ストリートビュー中は場所を決める操作ができないので引っ込め、代わりに追従地図を出す。
   ⚠️ display を直接いじる（ui.js は自前で表示を組み立てているので、そちらの状態は
     変えずに見せ方だけ切り替える。抜けたら元に戻す）。 */
let pickerDisplayBackup = null;
function setPickerVisible(on) {
  const w = document.getElementById('pickerWrap');
  if (!w) return;
  if (!on) {
    if (pickerDisplayBackup === null) pickerDisplayBackup = w.style.display || '';
    w.style.display = 'none';
  } else if (pickerDisplayBackup !== null) {
    w.style.display = pickerDisplayBackup;
    pickerDisplayBackup = null;
  }
}

// 縮尺は地図をクリックで切り替える（広い→細かい→…と一周する）
const SVMAP_ZOOMS = [15, 16, 17, 18];
let svMapZoomIdx = 2;                       // 既定は 17（徒歩で街区と通りが読める細かさ）
const svMapZoom = () => SVMAP_ZOOMS[svMapZoomIdx];

// 地図そのものの大きさ[px]。⤢ボタンで一周する。縮尺とは別物
// （縮尺＝どれだけ広い範囲を写すか／大きさ＝画面上で何pxを占めるか）。
const SVMAP_SIZES = [150, 190, 260, 340];
let svMapSizeIdx = 1;
function applyMapSize() {
  if (!ui.map) return;
  const s = SVMAP_SIZES[svMapSizeIdx];
  ui.map.style.width = `${s}px`;
  ui.map.style.height = `${s}px`;
  ui.mapCanvas.width = s;
  ui.mapCanvas.height = s;
  svMapCtx = null;                            // 大きさが変わると描画コンテキストを取り直す
  svMapLastDraw = { x: 1e9, z: 1e9, yaw: 1e9 };  // 必ず描き直させる
  drawStreetViewMap();
  requestRender();
}
const SVMAP_TILE = 256;
const SVMAP_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const svTiles = new Map();      // 'z/x/y' → Image（読み込み済みタイル）
let svMapCtx = null;
let svMapLastDraw = { x: 1e9, z: 1e9, yaw: 1e9 };

/* 緯度経度 → タイル座標（小数。整数部がタイル番号、小数部がタイル内の位置） */
function lonLatToTileXY(latDeg, lonDeg, z) {
  const n = 2 ** z;
  const latRad = latDeg / DEG;
  return {
    x: (lonDeg + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n,
  };
}

function svTileImage(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let img = svTiles.get(key);
  if (img) return img;
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { svMapLastDraw.x = 1e9; requestRender(); };  // 届いたら描き直す
  img.onerror = () => { img.__failed = true; };
  img.src = SVMAP_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  svTiles.set(key, img);
  return img;
}

function drawStreetViewMap() {
  if (!ui.map || !streetViewState.active) return;
  // 動いていなければ描き直さない（タイル貼りは毎フレームやるほど軽くない）
  if (Math.abs(stand.x - svMapLastDraw.x) < 0.5 &&
      Math.abs(stand.z - svMapLastDraw.z) < 0.5 &&
      Math.abs(yawPitch.yaw - svMapLastDraw.yaw) < 0.02) return;
  svMapLastDraw = { x: stand.x, z: stand.z, yaw: yawPitch.yaw };
  // 見出しに今の縮尺を出す（クリックで切り替わることの手がかりにもする）
  const label = document.getElementById('svMapLabel');
  if (label) label.textContent = `現在地（クリックで縮尺 z${svMapZoom()}）`;

  const cv = ui.mapCanvas;
  if (!svMapCtx) svMapCtx = cv.getContext('2d');
  const ctx = svMapCtx;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const { lat, lon } = worldToLonLat(stand.x, stand.z);
  const t = lonLatToTileXY(lat, lon, svMapZoom());
  // 中心のタイル内オフセット[px]
  const cx = W / 2, cy = H / 2;
  const fx = (t.x - Math.floor(t.x)) * SVMAP_TILE;
  const fy = (t.y - Math.floor(t.y)) * SVMAP_TILE;
  const span = Math.ceil(Math.max(W, H) / SVMAP_TILE) + 1;
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const img = svTileImage(svMapZoom(), Math.floor(t.x) + dx, Math.floor(t.y) + dy);
      if (!img.complete || img.__failed || !img.naturalWidth) continue;
      ctx.drawImage(img, Math.round(cx - fx + dx * SVMAP_TILE),
                         Math.round(cy - fy + dy * SVMAP_TILE), SVMAP_TILE, SVMAP_TILE);
    }
  }

  // 中心の現在地マーカー（視線の向きを指す矢印）
  //   方位角は読み取りと同じ求め方。画面上は「北が上」なので、そのまま回せばよい。
  let az = Math.atan2(Math.sin(yawPitch.yaw), -Math.cos(yawPitch.yaw));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(az);
  ctx.beginPath();
  ctx.moveTo(0, -21); ctx.lineTo(13, 15); ctx.lineTo(0, 7); ctx.lineTo(-13, 15);
  ctx.closePath();
  ctx.fillStyle = '#1e73e8';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function setHint(text) {
  if (!ui.hint) return;
  ui.hint.textContent = text || '';
  ui.hint.style.display = text ? 'block' : 'none';
}

// -----------------------------------------------------------------------------
// 着地点さがし
// -----------------------------------------------------------------------------
function startPlacing() {
  if (streetViewState.active) return;
  streetViewState.placing = true;
  ui.enter.classList.add('armed');
  renderer.domElement.style.cursor = 'crosshair';
  // 道路が消えていると降りる場所が分からないので点けておく
  const cb = el('roadOn');
  if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  setRoadHighlightStrength('picking');   // 降りられる場所をはっきり見せる
  loadCharacter();                       // 4MB あるので、選んでいる間に裏で読み始める
  setHint('道路（黄色）の上でクリックすると、そこに降ります　／　Esc で中止');
  requestRender();
}

function stopPlacing() {
  streetViewState.placing = false;
  ui.enter.classList.remove('armed');
  renderer.domElement.style.cursor = '';
  hideMarker();
  // 立っている間は薄く戻す（下の航空写真と重ねて見せたいので）
  if (!streetViewState.active) setRoadHighlightStrength('normal');
  setHint('');
  requestRender();
}

function onPlacingMove(e) {
  if (!streetViewState.placing) return;
  const p = pickGround(e.clientX, e.clientY);
  if (!p) { hideMarker(); requestRender(); return; }
  showMarker(p, canBeAt(p.x, p.z));
  requestRender();
}

function onPlacingClick(e) {
  if (!streetViewState.placing) return;
  const p = pickGround(e.clientX, e.clientY);
  if (!p) return;
  if (!canBeAt(p.x, p.z)) { setHint('そこは道路ではありません。黄色い道路の上を選んでください'); return; }
  enterStreetView(p);
}

// -----------------------------------------------------------------------------
// 立って歩くモードの出入り
// -----------------------------------------------------------------------------
const yawPitch = { yaw: 0, pitch: 0 };

function enterStreetView(point) {
  stopPlacing();
  saved = {
    pos: camera.position.clone(),
    quat: camera.quaternion.clone(),
    target: controls.target.clone(),
    near: camera.near,
    rotOrder: camera.rotation.order,
    controlsEnabled: controls.enabled,
  };
  controls.enabled = false;
  camera.near = SV_NEAR;
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';   // 見回しは「左右→上下」の順で掛けたい

  // ★基準はクリックで当たった面そのもの。それが「その瞬間に画面で見えていた地面」なので、
  //   別途撃ち直すより確実（撃ち直すと重なった別の段に当たることがある）。
  groundY = point.y;
  // キャラクターを立たせる。カメラはこの人の周りを回る（三人称）。
  stand.set(point.x, groundY, point.z);
  // 入った瞬間の向きは、それまで見ていた方向をそのまま引き継ぐ（急に別の方角を向かない）
  const dir = saved.target.clone().sub(saved.pos);
  yawPitch.yaw = Math.atan2(-dir.x, -dir.z);
  yawPitch.pitch = 0;
  chara.facing = yawPitch.yaw;

  loadCharacter().then((root) => {
    if (!root || !streetViewState.active) return;
    root.visible = charaVisible;
    root.position.copy(stand);
    root.rotation.y = chara.facing;
    playClip('idle');
    requestRender();
  });
  applyCamera();

  streetViewState.active = true;
  setRoadHighlightStrength('normal');
  setPickerVisible(false);          // 原点を決める地図は引っ込める
  ui.map.style.display = 'block';   // 代わりに追従地図を出す
  svMapLastDraw = { x: 1e9, z: 1e9, yaw: 1e9 };
  drawStreetViewMap();   // 立ったら薄くして航空写真と重ねる
  // ✕ は置かない（終わるのは 01 のパネルの 👣 か Esc）。ここで出さないこと。
  ui.enter.style.display = 'none';
  ui.stick.style.display = 'block';
  setHint('左下のスティックで歩く　／　画面をドラッグで見回す');
  setTimeout(() => setHint(''), 4000);
  requestRender();
}

function exitStreetView() {
  if (!streetViewState.active) return;
  streetViewState.active = false;
  stick.active = false;
  stick.x = stick.y = 0;
  moveKnob(0, 0);
  wasRunning = false; updateStickLook(false);
  if (chara.root) chara.root.visible = false;
  setRoadHighlightStrength('normal');
  if (saved) {
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    camera.near = saved.near;
    camera.rotation.order = saved.rotOrder;
    camera.updateProjectionMatrix();
    controls.target.copy(saved.target);
    controls.enabled = saved.controlsEnabled;
    controls.update();
    saved = null;
  }
  ui.exit.style.display = 'none';
  // 01 の中で開かれているときは 👣 は親のパネルにあるので、こちらには戻さない
  if (!(window.parent && window.parent !== window)) ui.enter.style.display = 'flex';
  notifyParentState();
  ui.stick.style.display = 'none';
  if (ui.readout) ui.readout.style.display = 'none';
  if (ui.map) ui.map.style.display = 'none';
  setPickerVisible(true);           // 原点を決める地図を戻す
  setHint('');
  requestRender();
}

// キャラクターが立っている足元の位置（これがモードの「現在地」）
const stand = new THREE.Vector3();
const _camOff = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

/* カメラをキャラクターの周りに配置し直す。
   yaw/pitch は「キャラクターを中心にどこから見るか」を表す。
   FOLLOW_DISTANCE を 0 にすればそのまま一人称になる。 */
function applyCamera() {
  _lookAt.set(stand.x, stand.y + LOOK_AT_HEIGHT, stand.z);
  if (FOLLOW_DISTANCE <= 1e-6) {
    camera.position.set(stand.x, stand.y + EYE_HEIGHT, stand.z);
    camera.rotation.set(yawPitch.pitch, yawPitch.yaw, 0, 'YXZ');
    return;
  }
  // 視線の逆向きへ FOLLOW_DISTANCE 下がった位置に置く（見上げ・見下ろしも反映）
  const cp = Math.cos(yawPitch.pitch);
  _camOff.set(
    Math.sin(yawPitch.yaw) * cp,
    Math.sin(yawPitch.pitch) + (FOLLOW_HEIGHT - LOOK_AT_HEIGHT) / FOLLOW_DISTANCE,
    Math.cos(yawPitch.yaw) * cp,
  ).multiplyScalar(FOLLOW_DISTANCE);
  camera.position.copy(_lookAt).add(_camOff);
  // ★カメラを地面より下へ潜らせない。
  //   見上げるほどカメラは後ろ下がりに回り込むので、そのままだと地面を突き抜けて
  //   地下から見上げる絵になる。回り込みの角度は変えず、高さだけ地面の上へ押し戻す。
  const camG = groundYAt(camera.position.x, camera.position.z, groundY);
  const minY = (camG !== null ? camG : stand.y) + CAM_MIN_ABOVE_GROUND;
  if (camera.position.y < minY) camera.position.y = minY;
  camera.lookAt(_lookAt);
  applyCharaVisible();   // 見上げ角に応じてキャラクターを出し入れする
}

/* 今カメラがどれだけ上を向いているか[度]。+が見上げ。
   yawPitch から逆算せず、実際のカメラの姿勢を測る（地面での押し戻しも反映されるため）。 */
function cameraPitchDeg() {
  _fwdProbe.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.asin(Math.max(-1, Math.min(1, _fwdProbe.y))) * DEG;
}

// -----------------------------------------------------------------------------
// 見回し（画面のドラッグ）
// -----------------------------------------------------------------------------
let looking = null;
function onLookDown(e) {
  if (!streetViewState.active) return;
  if (e.target.closest && e.target.closest('#svStick')) return;   // スティックは別扱い
  looking = { id: e.pointerId, x: e.clientX, y: e.clientY };
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
}
function onLookMove(e) {
  if (!looking || e.pointerId !== looking.id) return;
  // 左右は「カメラがキャラクターの周りを、指を動かした向きへ回り込む」向き。
  //   ⚠️ 一人称だったときは逆向き（景色が指について来る）が自然だったが、
  //     三人称にして中心にキャラクターが居ると、回り込む側の感覚のほうが合う。
  yawPitch.yaw -= (e.clientX - looking.x) * LOOK_SPEED;
  yawPitch.pitch += (e.clientY - looking.y) * LOOK_SPEED;
  yawPitch.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, yawPitch.pitch));
  looking.x = e.clientX; looking.y = e.clientY;
  applyCamera();
  updateReadout();
  drawStreetViewMap();
  requestRender();
}
function onLookUp(e) {
  if (!looking || e.pointerId !== looking.id) return;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}
  looking = null;
}

// -----------------------------------------------------------------------------
// スティック（前後左右）
// -----------------------------------------------------------------------------
const stick = { active: false, id: -1, x: 0, y: 0 };
const STICK_RADIUS = 44;   // つまみを動かせる範囲[px]

function moveKnob(dx, dy) {
  if (ui.knob) ui.knob.style.transform = `translate(${dx}px, ${dy}px)`;
}

/* 走りに入ったらつまみの色を変えて、今どちらで動いているか分かるようにする */
let wasRunning = false;
function updateStickLook(running) {
  if (ui.knob) ui.knob.classList.toggle('running', running);
}

function onStickDown(e) {
  if (!streetViewState.active) return;
  stick.active = true; stick.id = e.pointerId;
  try { ui.stick.setPointerCapture(e.pointerId); } catch (err) {}
  onStickMove(e);
  e.preventDefault();
}
function onStickMove(e) {
  if (!stick.active || e.pointerId !== stick.id) return;
  const r = ui.stick.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy);
  if (len > STICK_RADIUS) { dx = dx / len * STICK_RADIUS; dy = dy / len * STICK_RADIUS; }
  moveKnob(dx, dy);
  stick.x = dx / STICK_RADIUS;   // 右が +
  stick.y = dy / STICK_RADIUS;   // 下（＝手前）が +
  requestRender();
}
function onStickUp(e) {
  if (!stick.active || e.pointerId !== stick.id) return;
  try { ui.stick.releasePointerCapture(e.pointerId); } catch (err) {}
  stick.active = false; stick.x = stick.y = 0;
  moveKnob(0, 0);
  wasRunning = false; updateStickLook(false);
}

// -----------------------------------------------------------------------------
// 毎フレームの更新（main.js の animate から呼ぶ）
// -----------------------------------------------------------------------------
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
let lastMs = 0;
let groundY = 0;    // いま立っている地面の高さ。地形が細かくなるにつれて追従させる。

function updateStreetView(nowMs) {
  if (!streetViewState.active) { lastMs = nowMs; return; }
  // 0 未満にしないこと。負の dt はそのまま「逆向きに歩く」ことになる。
  const dt = Math.max(0, Math.min(0.1, (nowMs - lastMs) / 1000 || 0));
  lastMs = nowMs;

  let x = stand.x, z = stand.z;
  let moved = false, running = false;
  const walking = stick.active && (stick.x !== 0 || stick.y !== 0);
  if (walking) {
    // カメラの向きから「水平面での前・右」を作る（上下を向いていても歩く向きは水平）
    _fwd.set(-Math.sin(yawPitch.yaw), 0, -Math.cos(yawPitch.yaw));
    _right.set(Math.cos(yawPitch.yaw), 0, -Math.sin(yawPitch.yaw));
    // 倒した深さで歩き／走りを切り替える。向きは倒した方向のまま変えない。
    const depth = Math.min(1, Math.hypot(stick.x, stick.y));
    running = depth > RUN_THRESHOLD;
    const step = (running ? RUN_SPEED : WALK_SPEED) * dt;
    // 深さは速さの段にだけ使い、進む向きは正規化して取り出す（浅く倒しても向きは同じ）
    const ux = depth > 1e-4 ? stick.x / depth : 0;
    const uy = depth > 1e-4 ? stick.y / depth : 0;
    const dx = (_fwd.x * -uy + _right.x * ux) * step;
    const dz = (_fwd.z * -uy + _right.z * ux) * step;
    if (running !== wasRunning) { wasRunning = running; updateStickLook(running); }
    // ★歩けるのは道路の上だけ。
    //   両方向だめでも軸ごとに試すのは、道路の縁に斜めに突き当たったときに
    //   ピタッと止まらず縁に沿って滑れるようにするため（当たらない方向だけ進む）。
    //
    //   ⚠️ ただし【今いる場所が道路の外なら、どこへでも動けるようにする】。
    //     道路タイルは歩いている間もさらに細かいものが届き、そのたびに判定の基準にする
    //     1枚が入れ替わって道路の縁が少しずれる。そのため、降りた直後は道路の上でも、
    //     あとから縁の外側に取り残されることがある（実測で発生）。
    //     そのとき全方向を塞ぐと二度と動けなくなるので、外に居る間は素通しにして
    //     道路へ歩いて戻れるようにしておく。
    const stuckOutside = !canBeAt(x, z);
    const ok = (px, pz) => stuckOutside || canBeAt(px, pz);
    if (ok(x + dx, z + dz)) { x += dx; z += dz; }
    else if (ok(x + dx, z)) { x += dx; }
    else if (ok(x, z + dz)) { z += dz; }
    moved = (x !== stand.x || z !== stand.z);
    // 進んだ向きへ体を向ける（急に振り向かないよう、少しずつ回す）
    if (moved) {
      const want = Math.atan2(-(x - stand.x), -(z - stand.z));
      let diff = want - chara.facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      chara.facing += diff * Math.min(1, TURN_SPEED * dt);
    }
  }

  // ★止まっていても毎フレーム地面を測り直す。地形は歩いている間も細かい段が届き続けるので、
  //   降りた瞬間の高さのまま固定すると、地面に埋まったり浮いたりする。
  // 縁の外へ取り残されていたら、道路へ引き戻す（上の stuckOutside と対になる救済）
  if (!walking && !canBeAt(x, z)) { const s = snapOntoRoad(x, z); x = s.x; z = s.z; }

  const gy = groundYAt(x, z, groundY);
  if (gy !== null) groundY = gy;
  stand.set(x, groundY, z);

  // 立ち／歩き／走りの切り替え。壁に当たって進めていないときは立ちに戻す。
  playClip(!moved ? 'idle' : (running ? 'run' : 'walk'));
  if (chara.mixer) chara.mixer.update(dt);
  if (chara.root) {
    chara.root.position.copy(stand);
    chara.root.rotation.y = chara.facing;
  }
  applyCamera();
  updateReadout();
  drawStreetViewMap();
  requestRender();
}

// -----------------------------------------------------------------------------
// 組み立て
// -----------------------------------------------------------------------------
function initStreetView() {
  buildUi();
  ui.enter.addEventListener('click', () => {
    if (streetViewState.placing) stopPlacing(); else startPlacing();
  });
  ui.exit.addEventListener('click', exitStreetView);
  ui.charaToggle.addEventListener('click', toggleCharaVisible);
  // ⤢ は地図そのものの大きさを変える。地図本体のクリック（＝縮尺）とは別なので伝播を止める。
  ui.mapSize.addEventListener('click', (e) => {
    e.stopPropagation();
    svMapSizeIdx = (svMapSizeIdx + 1) % SVMAP_SIZES.length;
    applyMapSize();
  });
  // 地図をクリックすると縮尺が一周する（広い ⇄ 細かい）
  ui.map.addEventListener('click', () => {
    svMapZoomIdx = (svMapZoomIdx + 1) % SVMAP_ZOOMS.length;
    svMapLastDraw = { x: 1e9, z: 1e9, yaw: 1e9 };   // 必ず描き直させる
    drawStreetViewMap();
    requestRender();
  });
  applyCharaVisible();   // ボタンの文字を初期化

  const dom = renderer.domElement;
  dom.addEventListener('pointermove', onPlacingMove);
  dom.addEventListener('click', onPlacingClick);
  dom.addEventListener('pointerdown', onLookDown);
  dom.addEventListener('pointermove', onLookMove);
  dom.addEventListener('pointerup', onLookUp);
  dom.addEventListener('pointercancel', onLookUp);

  ui.stick.addEventListener('pointerdown', onStickDown);
  ui.stick.addEventListener('pointermove', onStickMove);
  ui.stick.addEventListener('pointerup', onStickUp);
  ui.stick.addEventListener('pointercancel', onStickUp);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (streetViewState.active) exitStreetView();
    else if (streetViewState.placing) stopPlacing();
  });
}

// -----------------------------------------------------------------------------
// 親アプリ（01）からの操作口
//   👣ボタンは 01 の下部パネル（地形断面ボタンの右）に置いてあるので、そこから呼ばれる。
//   地形断面の app1-profile-toggle と同じ作法（親がボタン、こちらが実体）。
// -----------------------------------------------------------------------------
function toggleStreetViewFromParent() {
  if (streetViewState.active) { exitStreetView(); return false; }
  if (streetViewState.placing) { stopPlacing(); return false; }
  startPlacing();
  return true;
}
window.toggleEarthStreetView = toggleStreetViewFromParent;
// 親がボタンの見た目を合わせるために現在の状態を聞きに来る
window.getEarthStreetViewOn = () => streetViewState.active || streetViewState.placing;
// こちら側から抜けたとき（✕ や Esc）に親のボタンの見た目も戻す
function notifyParentState() {
  try {
    const on = streetViewState.active || streetViewState.placing;
    if (window.parent && window.parent !== window && window.parent.syncEarthStreetView) {
      window.parent.syncEarthStreetView(on);
    }
  } catch (e) { /* 別ドメインなら黙って諦める */ }
}

export { streetViewState, initStreetView, updateStreetView, exitStreetView };

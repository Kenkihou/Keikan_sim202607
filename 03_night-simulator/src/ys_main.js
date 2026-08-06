import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import {
    baseWallMat, baseRoofMat, floorMat, floorMatDay, floorMatFlat,
    windowMatDay, windowMatFlat, edgeMaterial, createWindowMaterial, setupWindowPaneUniforms
} from './ys_material.js';
import {
    initLights, sunLight, moonLight, skyFillLight, ambientLight,
    updateNightTint, kelvinToColor
} from './ys_lighting.js';
import { buildNightEnvironment } from './ys_env_builder.js';
import { createThreeModeMaterials } from './ys_material_factory.js';
import { FilmGrainShader } from './ys_post.js';

let currentMode = 1; 
let needsRender = true;
window.requestRender = function() { needsRender = true; };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);
scene.fog = new THREE.FogExp2(0x050510, 0.005);

// ファークリップは SkyBox の球半径(180)より外側に取る必要がある。
// 100 のままだと、毎フレーム カメラ位置に置き直される天球が丸ごとクリップされてしまい、
// 空が一度も描画されない（見えていたのは scene.background の単色）状態だった
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(22, 14, 28); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// three r184 の PCFShadowMap は Vogel ディスク5サンプル + ノイズ回転のソフトシャドウで、
// ぼけ幅は各ライトの shadow.radius で指定する（PCFSoftShadowMap は非推奨になった）
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.target.set(0, 3, 0);
controls.addEventListener('change', window.requestRender);

window.camera = camera;
window.controls = controls;

// カメラ状態の復元
const sharedCameraState = sessionStorage.getItem('sharedCameraState');
if (sharedCameraState) {
    try {
        const camData = JSON.parse(sharedCameraState);
        camera.position.set(camData.position[0]*0.001, camData.position[1]*0.001, camData.position[2]*0.001);
        controls.target.set(camData.target[0]*0.001, camData.target[1]*0.001, camData.target[2]*0.001);
        if (camData.fov) { camera.fov = camData.fov; camera.updateProjectionMatrix(); }
        controls.update();
    } catch (e) { console.error(e); }
}

// 地盤・ライトの初期化
initLights(scene);
const { water, roadMat } = buildNightEnvironment(scene);

// 地盤の色。陰影なし（図面表現）では敷地と道路が判別できる明るさを優先し、
// 昼夜は実際の舗装・土に近い反射率にする
const GROUND_COLOR_DIAGRAM = 0xffffff;
const GROUND_COLOR_LIT = 0x8a8a86;

// 💡 ★追加：マンセル値シミュレーターから空と雲（SkyBox）を完全移植
// 天球テクスチャは上端が天頂、縦の中央(0.5)が地平線に対応する

// 雲の配置は全時刻で共通にする。時刻ごとに位置が変わると、
// テクスチャをクロスフェードしたときに雲が二重像になってしまう
const cloudLayout = [];
for (let i = 0; i < 26; i++) {
    cloudLayout.push({
        x: Math.random() * 2048,
        // 地平線はテクスチャ中央(512)なので、雲はそれより上に置く
        y: 120 + Math.random() * 330,
        // 2048px幅が全周360°に対応するため、半径100pxの雲は視野角で約35°を占めてしまう。
        // 雲として妥当な大きさまで縮める
        s: 0.16 + Math.random() * 0.34
    });
}

// 時刻ごとの空。グラデーションの色と雲の色だけを差し替えて生成する
function createSkyTexture(stops, cloudColor) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048; canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    stops.forEach(([pos, color]) => gradient.addColorStop(pos, color));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const drawCloud = (x, y, s) => {
        ctx.fillStyle = cloudColor;
        ctx.beginPath();
        ctx.arc(x, y, 40*s, 0, Math.PI*2);
        ctx.arc(x+50*s, y-20*s, 50*s, 0, Math.PI*2);
        ctx.arc(x+100*s, y, 40*s, 0, Math.PI*2);
        ctx.arc(x+50*s, y+10*s, 30*s, 0, Math.PI*2);
        ctx.fill();
    };
    // 輪郭をぼかす。arc をそのまま塗ると縁が硬く、綿ではなく円の集合に見える
    ctx.filter = 'blur(7px)';
    cloudLayout.forEach(c => drawCloud(c.x, c.y, c.s));
    ctx.filter = 'none';

    const texture = new THREE.CanvasTexture(canvas);
    // 色情報のテクスチャなので sRGB として読ませる。
    // 既定の NoColorSpace では sRGB値がリニア値として扱われ、空全体が白っぽく退色する
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// 夜空。真っ黒な単色だと背景が抜けて見えるので、
// 天頂を暗く落としつつ地平付近を街明かり（スカイグロー）で持ち上げる
function createNightSkyTexture() {
    const canvas = document.createElement('canvas');
    // 昼空より高解像度にする。2048幅だと1テクセルが画面上で約3画素に拡大され、
    // 星が点ではなく滲んだ塊に見えてしまうため
    canvas.width = 4096; canvas.height = 2048;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0.00, "#02040a"); // 天頂
    gradient.addColorStop(0.30, "#04070f");
    gradient.addColorStop(0.44, "#0b1120");
    gradient.addColorStop(0.50, "#1b2036"); // 地平線：市街の照り返しで最も明るい
    gradient.addColorStop(0.54, "#282234"); // やや紫〜暖色に振れる
    gradient.addColorStop(0.62, "#11131c");
    gradient.addColorStop(1.00, "#05060a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 星。地平に近いほど大気で減光するので、天頂側ほど密度と明るさを上げる
    for (let i = 0; i < 2600; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height * 0.5;
        const altitude = 1.0 - (y / (canvas.height * 0.5)); // 0=地平 1=天頂
        if (Math.random() > altitude * 0.9 + 0.1) continue;
        const a = (0.08 + Math.random() * 0.34) * altitude;
        const r = Math.random() < 0.94 ? 0.6 : 1.0;
        ctx.fillStyle = `rgba(255, 252, 245, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// 快晴の南中
const daySkyTexture = createSkyTexture([
    [0.0, "#2b6fb8"], [0.4, "#63a4ff"], [0.6, "#bce6ff"], [1.0, "#f0f9ff"]
], "rgba(255, 255, 255, 0.55)");

// 朝方。太陽高度が低く、大気を通る距離が長いぶん青が浅く白っぽく霞む
const morningSkyTexture = createSkyTexture([
    [0.0, "#33619b"], [0.4, "#7fa8cf"], [0.55, "#c9d8e2"], [1.0, "#e4ecf1"]
], "rgba(246, 248, 252, 0.5)");

// 夕焼け。上空には青を残し、焼ける橙は地平付近に集中させる。
// 空全体を橙にすると画面が単色になり、かえって夕景に見えない
const sunsetSkyTexture = createSkyTexture([
    [0.00, "#12294f"], [0.30, "#2f5a92"], [0.40, "#6b6f9c"],
    [0.46, "#c07f78"], [0.50, "#f0a468"], [0.54, "#e08a4e"],
    [0.60, "#9a6244"], [1.00, "#5a4032"]
], "rgba(255, 178, 132, 0.6)");

const nightSkyTexture = createNightSkyTexture();

// 時刻でテクスチャを切り替えると、スライダーを動かしたときに空が不連続に飛ぶ。
// 2枚を保持して混ぜられるようにし、朝夕は南中の空との中間として連続的に変化させる
const skyUniforms = {
    mapA: { value: daySkyTexture },
    mapB: { value: daySkyTexture },
    mixFactor: { value: 0.0 }
};

// fog: false 相当（霧の計算を持たないので、霧でくすまず常に綺麗に反射します）
const skyBox = new THREE.Mesh(
    new THREE.SphereGeometry(180, 48, 32),
    new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        side: THREE.BackSide,
        vertexShader: /* glsl */`
            varying vec2 vSkyUv;
            void main() {
                vSkyUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            }
        `,
        fragmentShader: /* glsl */`
            uniform sampler2D mapA;
            uniform sampler2D mapB;
            uniform float mixFactor;
            varying vec2 vSkyUv;
            void main() {
                // sRGB指定のテクスチャはGPU側でリニアに復号されて返る。
                // コンポーザ経由なので、ここではリニアのまま出力してよい
                gl_FragColor = vec4( mix( texture2D( mapA, vSkyUv ).rgb,
                                          texture2D( mapB, vSkyUv ).rgb, mixFactor ), 1.0 );
            }
        `
    })
);
scene.add(skyBox);

function setSky(texA, texB, mix) {
    skyUniforms.mapA.value = texA;
    skyUniforms.mapB.value = texB || texA;
    skyUniforms.mixFactor.value = mix || 0.0;
}

// ==========================================
// IBL（環境マップ）
// MeshStandardMaterial は環境マップが無いと鏡面反射項がほぼゼロになり、
// roughness をどう振ってもマットな塗料にしか見えない。
// 夜空テクスチャをそのまま PMREM に通して環境光源にすることで、
// 外部HDRIファイルを持たずに、空の明るさの分布を材質へ反映させる。
// ==========================================
function buildEnvironmentMap(sourceTexture) {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    // SphereGeometry のUVは正距円筒なので、複製に equirect のマッピングを指定して渡す
    // （複製元は SkyBox の map として使い続けるため、mapping を書き換えない）
    const equirect = sourceTexture.clone();
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.needsUpdate = true;

    const renderTarget = pmremGenerator.fromEquirectangular(equirect);

    equirect.dispose();
    pmremGenerator.dispose();
    return renderTarget.texture;
}

const nightEnvMap = buildEnvironmentMap(nightSkyTexture);

const houseGroup = new THREE.Group();
scene.add(houseGroup); // スケールはロードするモデル側にかけるため、ここでは設定しません

const windowLights = [];
const managedMeshes = [];

// ==========================================
// 窓ごとの個体差（部屋ごとの明るさ・色温度・点灯/消灯）
// 全窓が同一マテリアルを共有していると、明るさも色も完全に揃ってしまい
// 実在の建物に見えなくなるため、窓を「部屋」単位でまとめて振れ幅を与える。
// ==========================================
const windowUnits = [];

const ROOM_CELL_H = 2.5;  // 水平方向にこの距離内の窓は同じ部屋の窓とみなす(m)
const ROOM_CELL_V = 3.0;  // 階高(m)

function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// 位置から決まる種を使うので、リロードしても毎回同じ部屋が同じ明るさで点灯する
function createWindowVariation(worldPos, isExterior) {
    const key = `${Math.round(worldPos.x / ROOM_CELL_H)}_${Math.floor(worldPos.y / ROOM_CELL_V)}_${Math.round(worldPos.z / ROOM_CELL_H)}`;
    let s = hashString(key);
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

    if (isExterior) {
        // 外灯は常時点灯。個体差もごく控えめにする
        return { isOn: true, tempOffset: (rnd() * 2 - 1) * 120, intensityFactor: 0.9 + rnd() * 0.2 };
    }
    return {
        isOn: rnd() > 0.25,                  // 約1/4の部屋は消灯（全窓点灯は非現実的）
        tempOffset: (rnd() * 2 - 1) * 350,   // 部屋ごとに ±350K
        intensityFactor: 0.65 + rnd() * 0.7  // 部屋ごとに 0.65〜1.35倍
    };
}

// 開口の面積。大きい窓ほど光溜まりが目立つので、影を落とすライトの選定に使う
function approxWindowArea(mesh) {
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
    return dims[0] * dims[1];
}

// シャドウマップはテクスチャユニットを消費するため、影を落とす窓の本数には上限を設ける。
// 面積の大きい（＝光の切り出しが目立つ）点灯中の窓から順に割り当てる。
function assignWindowShadows(count) {
    const casters = windowUnits
        .filter(u => u.light && (!params.windowVariation || u.isOn))
        .sort((a, b) => b.area - a.area);

    casters.forEach((unit, i) => {
        const shouldCast = i < count;
        if (unit.light.castShadow === shouldCast) return;

        unit.light.castShadow = shouldCast;
        if (shouldCast) {
            unit.light.shadow.mapSize.set(1024, 1024);
            unit.light.shadow.camera.near = 0.1;
            unit.light.shadow.camera.far = unit.light.distance;
            unit.light.shadow.bias = -0.002;
            unit.light.shadow.normalBias = 0.03;
            unit.light.shadow.focus = 1.0;
            // 窓は面光源に近く、遠ざかるほど影が滲むので、月光より大きくぼかす
            unit.light.shadow.radius = 4.0;
        } else if (unit.light.shadow.map) {
            unit.light.shadow.map.dispose();
            unit.light.shadow.map = null;
        }
    });
    window.requestRender();
}

// 月明かりの強度・色を水面にも反映する（Water は光源を参照しないので手で渡す必要がある）
function refreshWaterMoonlight() {
    if (currentMode !== 3 || !water) return;
    water.material.uniforms.sunDirection.value.copy(moonLight.position).normalize();
    water.material.uniforms.sunColor.value
        .copy(moonLight.color)
        .multiplyScalar(params.moonLightIntensity);
}

// 色温度・発光強度・漏れ光を、部屋ごとの個体差を掛けたうえで全窓に反映する
const _windowColor = new THREE.Color();
function refreshNightWindows() {
    if (currentMode !== 3) return;
    const vary = params.windowVariation;

    windowUnits.forEach(unit => {
        const isOn = vary ? unit.isOn : true;
        const tempOffset = vary ? unit.tempOffset : 0;
        const factor = vary ? unit.intensityFactor : 1.0;

        kelvinToColor(params.colorTemperature + tempOffset, _windowColor);
        unit.material.emissive.copy(_windowColor);
        unit.material.emissiveIntensity = isOn ? params.windowEmissiveIntensity * factor : 0.0;
        // 面内の明暗のムラ（「光の不均一さ」スライダー）
        if (unit.material.userData.shoji) unit.material.userData.shoji.uUneven.value = params.gradientStrength;
        // 消灯している窓は、真っ黒な穴に見えないよう僅かに素地の色を残す
        unit.material.color.setHex(isOn ? 0x000000 : 0x0b0d14);

        if (unit.light) {
            unit.light.color.copy(_windowColor);
            unit.light.intensity = isOn ? params.spillLightIntensity * factor * unit.lightScale : 0.0;
            unit.light.visible = isOn;
        }
    });
}

// 💡 ★追加1：水面判定用のRaycasterと監視リスト
const waterMeshes = [];
if (water) waterMeshes.push(water); // 環境ビルダーの川を登録
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isHoveringWater = false; // 水面にマウスが乗っているかのフラグ

// ==========================================
// ★変更：単独起動・連携起動の両方に対応したモデルロード処理
// ==========================================
const nightCustomGlb = sessionStorage.getItem('night_custom_glb');

// 💡 メインアプリ側で実際に「メッシュ（建物）」が描画されているかチェックを挟む
let isMainAppEmpty = true;
if (nightCustomGlb && window.parent && typeof window.parent.getHouseGroup === 'function') {
    const parentHouseGroup = window.parent.getHouseGroup();
    if (parentHouseGroup) {
        // 子要素の中に一つでもMeshがあるかスキャン
        parentHouseGroup.traverse((child) => {
            if (child.isMesh) {
                isMainAppEmpty = false;
            }
        });
    }
}

// 💡 メイン側が完全に空、または単独起動（nightCustomGlbがない）の場合はデフォルトモデルを使用
const useDefaultModel = !nightCustomGlb || isMainAppEmpty;
const modelUrl = useDefaultModel ? `${import.meta.env.BASE_URL}normal_house.glb` : nightCustomGlb;

const gltfLoader = new GLTFLoader();
gltfLoader.load(modelUrl, (gltf) => {
    const importedScene = gltf.scene;
    
    if (!useDefaultModel) {
        // メインアプリからのデータ（mm単位）を夜間（m単位）のスケールに縮小
        importedScene.scale.set(0.001, 0.001, 0.001);
        importedScene.position.set(0, 0, 0);
    } else {
        // 単独起動またはデフォルトモデル（m単位）はそのまま等倍で配置
        importedScene.scale.set(1, 1, 1);
        importedScene.position.set(0, 0.1, 0); // 地面に少し沈むのを防止
    }
    
    houseGroup.add(importedScene);

    // 門柱灯などの外構照明を「建物から見て外向き」に向けるための基準点
    const modelCenter = new THREE.Box3().setFromObject(importedScene).getCenter(new THREE.Vector3());

    importedScene.traverse((child) => {
        if (child.isLineSegments) {
            child.castShadow = false; child.receiveShadow = false;
        } else if (child.isMesh) {
            child.castShadow = true; child.receiveShadow = true;

            // 💡 ★追加2：名前やデータにwaterが含まれていれば監視リストに登録
            if (child.name.toLowerCase().includes('water') || (child.userData && child.userData.type === 'water')) {
                child.userData.type = 'water';
                waterMeshes.push(child);
            }

            // 各パーツにエッジ線を付与
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry), edgeMaterial);
            edges.visible = false; 
            child.add(edges); 
            child.userData.edges = edges;

            let nMat, dMat, fMat;

            // 窓枠(windowframe)等が誤って光らないよう完全一致に限定し、外灯用の exteria_poal_light も追加
            const matName = (child.material && child.material.name) ? child.material.name.toLowerCase() : '';
            if ((child.userData && child.userData.isGlass) || 
                matName === 'window_glass' || 
                matName === 'windowglass' ||
                matName === 'exteria_poal_light') {
                
                child.userData.type = 'window';

                // 障子・ガラスに不透明な影を落とさせない。
                // 発光面そのものが、直前に置く漏れ光スポットライトを遮ってしまうのを防ぐ意味もある
                child.castShadow = false;

                // 窓ごとに専用マテリアルを持たせ、部屋単位で明るさと色温度を変えられるようにする
                const nightWindowMat = createWindowMaterial();
                nMat = nightWindowMat; dMat = windowMatDay; fMat = windowMatFlat;

                child.updateMatrixWorld();
                const worldPos = new THREE.Vector3(); child.getWorldPosition(worldPos);

                // 面内の濃淡を出すための座標系。種を窓ごとに変えてムラの出方をずらす
                setupWindowPaneUniforms(nightWindowMat, child,
                    hashString(`${worldPos.x.toFixed(2)}_${worldPos.y.toFixed(2)}_${worldPos.z.toFixed(2)}`) % 1000);

                const isExterior = (matName === 'exteria_poal_light');
                const unit = Object.assign(
                    { mesh: child, material: nightWindowMat, light: null, area: 0, lightScale: 1.0, isExterior },
                    createWindowVariation(worldPos, isExterior)
                );

                // 発光面が向いている方向。窓も門柱灯も、この向きに光を放つ
                const normal = new THREE.Vector3(0, 0, 1).transformDirection(child.matrixWorld).normalize();

                if (isExterior) {
                    // 外灯は発光するだけで周囲を一切照らしていなかった。
                    // 門柱灯は柱の前面に取り付いた照明なので、真下ではなく面の向く方向へ光を出す
                    // （真下に向けると柱を中心に均等に広がり、裏側まで照らしてしまう）。
                    // ただし法線の符号はモデル依存なので、建物中心から見て外向き＝道路側に揃える
                    const outward = new THREE.Vector3(worldPos.x - modelCenter.x, 0, worldPos.z - modelCenter.z);
                    if (outward.lengthSq() < 1e-6) outward.set(0, 0, 1);
                    outward.normalize();

                    const poleDir = new THREE.Vector3(normal.x, 0, normal.z);
                    if (poleDir.lengthSq() < 1e-6) poleDir.copy(outward);
                    else poleDir.normalize();
                    if (poleDir.dot(outward) < 0) poleDir.negate();

                    const poleLight = new THREE.SpotLight(0xffffff, 3.0, 8, Math.PI / 2.8, 0.7, 2);
                    poleLight.position.copy(worldPos).add(poleDir.clone().multiplyScalar(0.02));

                    // 門灯は足元のアプローチを照らすものなので、窓より強く下向きに振る
                    const poleAim = poleDir.clone().multiplyScalar(2.0).add(new THREE.Vector3(0, -2.0, 0));
                    const poleTarget = new THREE.Object3D();
                    poleTarget.position.copy(worldPos).add(poleAim);

                    scene.add(poleTarget); poleLight.target = poleTarget; scene.add(poleLight);
                    windowLights.push(poleLight);

                    unit.light = poleLight;
                    unit.area = approxWindowArea(child);
                    // 漏れ光のスライダーを共用するが、外灯は窓ほど強くないので控えめに掛ける
                    unit.lightScale = 0.5;
                } else {
                    const spLight = new THREE.SpotLight(0xffffff, 40.0, 15, Math.PI / 3, 0.8, 2);
                    // 光源を室内側に少し引き込む。こうすると開口まわりの壁が絞りとして働き、
                    // 円錐がそのまま漏れるのではなく、窓の形に切り出された光が外に落ちる
                    spLight.position.copy(worldPos).add(normal.clone().multiplyScalar(-0.25));
                    // 実際の窓は半球状に光を放つ。真正面に向けたままだと足元に光が届かないので、
                    // 円錐をやや下向きに傾け、窓下の地面まで照らすようにする
                    const aim = normal.clone().multiplyScalar(5).add(new THREE.Vector3(0, -2.5, 0));
                    const targetObj = new THREE.Object3D(); targetObj.position.copy(worldPos).add(aim);

                    scene.add(targetObj); spLight.target = targetObj; scene.add(spLight);
                    windowLights.push(spLight);

                    unit.light = spLight;
                    unit.area = approxWindowArea(child);
                }

                windowUnits.push(unit);

            } else {
                // 通常パーツ（外壁・屋根・サッシなど）：ベース色を引き継いで3モード用を生成
                const currentMat = Array.isArray(child.material) ? child.material[0] : child.material;
                const baseColor = (currentMat && currentMat.color) ? currentMat.color.clone() : new THREE.Color(0xe8e8e8);

                const createModeMats = (col) => {
                    return {
                        f: new THREE.MeshBasicMaterial({ color: col, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
                        d: new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide }),
                        n: new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, side: THREE.DoubleSide })
                    };
                };
                
                if (Array.isArray(child.material)) {
                    nMat = []; dMat = []; fMat = [];
                    child.material.forEach(m => { const mats = createModeMats(m.color || baseColor); fMat.push(mats.f); dMat.push(mats.d); nMat.push(mats.n); });
                } else {
                    const mats = createModeMats(baseColor); fMat = mats.f; dMat = mats.d; nMat = mats.n;
                }
            }
            managedMeshes.push({ mesh: child, nightMat: nMat, dayMat: dMat, flatMat: fMat });
        }
    });

    // 窓の光が窓枠の形に切り出されて地面や前庭に落ちるよう、影を落とすライトを割り当てる
    assignWindowShadows(params.windowShadowCount);

    // 💡 デフォルトモデル読み込み時はカメラの注視点をハウスの高さ(2.7m)に自動フィット
    if (useDefaultModel) {
        controls.target.set(0, 2.7, 0);
        controls.update();
    }

    // ▼▼▼ 修正: ロード完了後に追加されたライト類を、現在の時刻(スライダー)に合わせて初期化・非表示にする ▼▼▼
    const timeSliderElem = document.getElementById('time-slider');
    if (timeSliderElem) {
        updateSceneByTime(convertSliderPctToTime(parseFloat(timeSliderElem.value)));
    }
    
    // 読み込み完了後に画面を更新
    window.requestRender();

}, undefined, (err) => console.error("夜間GLBの読み込みに失敗しました:", err));

function setMaterialMode(mode) {
    const showEdges = (mode === 1);
    managedMeshes.forEach(item => {
        if (mode === 3) item.mesh.material = item.nightMat;
        else if (mode === 2) item.mesh.material = item.dayMat;
        else if (mode === 1) item.mesh.material = item.flatMat;
        if (item.mesh.userData.edges) item.mesh.userData.edges.visible = showEdges;
    });
    
    // 💡 ★変更：トーンマッピングを常時 AgX に統一。
    // ACESFilmic は強い光源をすぐ純白に張り付かせてしまうが、AgX は白飛びさせずに
    // 自然に脱彩度させるため、夜間の窓明かりや外灯との相性が良い
    if (renderer.toneMapping !== THREE.AgXToneMapping) {
        renderer.toneMapping = THREE.AgXToneMapping;
        scene.traverse(c => { if (c.isMesh && c.material) c.material.needsUpdate = true; });
    }

    // 💡 ★追加：露出（画面の明るさ）をモードごとに微調整
    // AgX は ACESFilmic より中間調を暗く落とすので、昼側は露出を上げて従来の明るさに戻す
    if (mode === 2) {
        renderer.toneMappingExposure = 1.85; // 昼間は露出を上げてパキッと明るく晴れ渡らせる
    } else if (mode === 3) {
        renderer.toneMappingExposure = 1.0;  // 夜間は電飾やブルームが引き立つ適正露出にする
    } else {
        renderer.toneMappingExposure = 1.55; // 陰影なしは図面表現なので、沈ませず明るく保つ
    }

    window.requestRender();
}

// 💡 ★変更：HalfFloatTypeに加え、samples: 4（マルチサンプルアンチエイリアス）を明示してジャギーを完全消滅させる
const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    samples: 4 // 💡 マンセル側の高画質モードと同等の4倍サンプリングでエッジを滑らかに補正
});

// ポストプロセス
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.0, 1.0);

// グレインとディザは表示色空間で掛けるものなので、OutputPass（トーンマッピング＋sRGB変換）の後段に置く
const grainPass = new ShaderPass(FilmGrainShader);

const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(renderPass); composer.addPass(bloomPass); composer.addPass(new OutputPass());
composer.addPass(grainPass);

// GUI設定
const gui = new GUI({ title: '照明とブルームの調整' });
const dayFolder = gui.addFolder('昼間明かりの設定');
// 従来は 環境光0.3 / 太陽光0.2 で、一様な回り込み光の方が太陽より強く、
// 陰影のコントラストが 1.7:1 程度しか付かないため日中がぼんやりしていた。
// 実際の快晴時は直射光が天空光の数倍あるので、その比率に寄せる
// 快晴時の水平面照度は 直射:天空 ≒ 4:1。この比率に寄せる
const dayParams = { noonAmbient: 0.12, noonSun: 1.0, falloffCurve: 1.0 };
dayFolder.add(dayParams, 'noonAmbient', 0.0, 0.6, 0.01).name('南中時の環境光').onChange(() => triggerDayUpdate());
dayFolder.add(dayParams, 'noonSun', 0.1, 3.0, 0.05).name('南中時の太陽光').onChange(() => triggerDayUpdate());
dayFolder.add(dayParams, 'falloffCurve', 1.0, 5.0, 0.1).name('朝夕の減衰カーブ').onChange(() => triggerDayUpdate());

function triggerDayUpdate() {
    if (currentMode === 2) { updateSceneByTime(convertSliderPctToTime(parseFloat(document.getElementById('time-slider').value))); window.requestRender(); }
}

const nightFolder = gui.addFolder('夜間明かりの設定');
const presets = {
    // 行燈のような、淡くて眩しくない光。
    // 「光源が明るいか」ではなく「滲みで眩しく見えるか」が体感を決めるので、
    // ブルームは広く弱く掛け、発光そのものも白飛びしない範囲に抑える。
    // 発光を上げすぎると AgX が高輝度部を脱彩度させ、琥珀色が淡い黄色に転んでしまう
    '朧げ': { colorTemperature: 2100, windowEmissiveIntensity: 0.26, spillLightIntensity: 0.7, moonLightIntensity: 0.2, moonLightBlueness: 0.6, bloomStrength: 0.3, bloomRadius: 0.6, gradientStrength: 0.75, bloomThreshold: 0.4 },
    // 煌々も面内に濃淡を持たせる。ただし全室に灯りが回っている状態なので、
    // 朧げより濃淡は浅くする。発光を上げすぎると明部が飽和して濃淡が潰れるため、
    // 明るさは保ちつつ階調が残る値に抑える
    '煌々': { colorTemperature: 2500, windowEmissiveIntensity: 1.15, spillLightIntensity: 3.0, moonLightIntensity: 0.5, moonLightBlueness: 0.4, bloomStrength: 0.15, bloomRadius: 0.942, gradientStrength: 0.4, bloomThreshold: 1.0 }
};
// 以下はプリセットで上書きしない、画づくり全体に効く設定
const params = Object.assign({}, presets['朧げ'], {
    filmGrain: 0.035,        // フィルムグレインの量
    windowShadowCount: 6,    // 影を落とす窓の本数
    envIntensity: 2.0,       // 夜空を光源とした環境反射の強さ
    // 部屋ごとの明るさ・色温度・点灯のばらつき。
    // 「部屋」は窓の位置をセル単位に丸めて判定しているため、同じ窓の左右のガラスが
    // セル境界をまたぐと別の部屋と見なされ、窓が半分だけ消灯することがある。
    // 既定では切っておき、破綻しないモデルでのみ有効にする
    windowVariation: false
});

const ctController = nightFolder.add(params, 'colorTemperature', 2500, 6500, 50).name('色温度 (K)').onChange(() => { refreshNightWindows(); window.requestRender(); });
const weController = nightFolder.add(params, 'windowEmissiveIntensity', 0, 5).name('窓ガラスの発光強度').onChange(() => { refreshNightWindows(); window.requestRender(); });
const slController = nightFolder.add(params, 'spillLightIntensity', 0, 10).name('漏れ出す光の強度').onChange(() => { refreshNightWindows(); window.requestRender(); });
const mlController = nightFolder.add(params, 'moonLightIntensity', 0, 1).name('月明かりの強度').onChange(v => { if (currentMode === 3) moonLight.intensity = v; refreshWaterMoonlight(); window.requestRender(); });
const mbController = nightFolder.add(params, 'moonLightBlueness', 0, 1).name('月明かりの青味').onChange(v => { updateNightTint(v, currentMode); refreshWaterMoonlight(); window.requestRender(); });
const bsController = nightFolder.add(params, 'bloomStrength', 0, 1).name('ブルームの強さ').onChange(v => { if (currentMode === 3) bloomPass.strength = v * 0.3; window.requestRender(); });
const brController = nightFolder.add(params, 'bloomRadius', 0, 1).name('ブルームの半径').onChange(v => { bloomPass.radius = v; window.requestRender(); });
const gsController = nightFolder.add(params, 'gradientStrength', 0.0, 1.0).name('光の不均一さ').onChange(() => { refreshNightWindows(); window.requestRender(); });

const btController = nightFolder.add(params, 'bloomThreshold', 0.0, 3.0, 0.05).name('ブルームのしきい値').onChange(v => { bloomPass.threshold = v; window.requestRender(); });
nightFolder.add(params, 'filmGrain', 0.0, 0.15, 0.005).name('フィルムグレイン').onChange(v => { if (currentMode === 3) grainPass.uniforms.uGrain.value = v; window.requestRender(); });
nightFolder.add(params, 'windowShadowCount', 0, 12, 1).name('窓の影の本数（重い）').onChange(v => assignWindowShadows(v));
nightFolder.add(params, 'envIntensity', 0.0, 3.0, 0.05).name('環境反射の強さ').onChange(v => { if (currentMode === 3) scene.environmentIntensity = v; window.requestRender(); });
nightFolder.add(params, 'windowVariation').name('窓ごとのばらつき').onChange(() => { refreshNightWindows(); assignWindowShadows(params.windowShadowCount); window.requestRender(); });

const presetState = { '朧げの照明': true, '煌々の照明': false };
function applyPreset(presetName) {
    const p = presets[presetName]; Object.assign(params, p);
    ctController.setValue(p.colorTemperature); weController.setValue(p.windowEmissiveIntensity); slController.setValue(p.spillLightIntensity); mlController.setValue(p.moonLightIntensity); mbController.setValue(p.moonLightBlueness); bsController.setValue(p.bloomStrength); brController.setValue(p.bloomRadius); gsController.setValue(p.gradientStrength); btController.setValue(p.bloomThreshold);
}
nightFolder.add(presetState, '朧げの照明').listen().onChange(v => { if (v) { presetState['煌々の照明'] = false; applyPreset('朧げ'); } else if (!presetState['煌々の照明']) presetState['朧げの照明'] = true; });
nightFolder.add(presetState, '煌々の照明').listen().onChange(v => { if (v) { presetState['朧げの照明'] = false; applyPreset('煌々'); } else if (!presetState['朧げの照明']) presetState['煌々の照明'] = true; });

const tickPercentages = [0, 13.636, 13.636+9.091, 13.636+9.091*2, 13.636+9.091*3, 13.636+9.091*4, 13.636+9.091*5, 13.636+9.091*6, 13.636+9.091*7, 13.636+9.091*8, 100];
function convertSliderPctToTime(pct) {
    if (pct <= tickPercentages[0]) return 8; if (pct >= tickPercentages[10]) return 18; 
    if (pct < tickPercentages[1]) return 8 + (pct - tickPercentages[0]) / (tickPercentages[1] - tickPercentages[0]);
    if (pct > tickPercentages[9]) return 17 + (pct - tickPercentages[9]) / (tickPercentages[10] - tickPercentages[9]);
    for (let i = 1; i <= 8; i++) { if (pct >= tickPercentages[i] && pct <= tickPercentages[i+1]) return (8 + i) + (pct - tickPercentages[i]) / (tickPercentages[i+1] - tickPercentages[i]); }
    return 18;
}

const LATITUDE = 35.0167; const LONGITUDE = 135.7333; const DATE_WINTER_SOLSTICE = new Date('2024-12-22T12:00:00+09:00'); 

export function updateSceneByTime(val) {
    sunLight.castShadow = false;
    if (val < 8.5) {
        currentMode = 1; gui.hide(); setMaterialMode(1); bloomPass.strength = 0;
        grainPass.uniforms.uGrain.value = 0; // 陰影なしは図面的な表現なので粒状感は載せない
        moonLight.intensity = 0; skyFillLight.intensity = 0; sunLight.intensity = 0;
        moonLight.visible = false; // 影を落とさない＝シャドウマップの描画自体を省く
        // ▼▼▼ 修正: intensity=0 に加え、ライト自体を非表示(false)にする ▼▼▼
        windowLights.forEach(l => {
            l.intensity = 0;
            l.visible = false;
        });
        ambientLight.color.setHex(0xffffff); ambientLight.intensity = 1.0;
        scene.background.setHex(0x87ceeb); scene.fog.color.setHex(0x87ceeb);
        scene.fog.density = 0.0; // 💡 追加：陰影なしモードでは霧を完全にオフにする
        skyBox.visible = true; setSky(daySkyTexture);
        roadMat.color.setHex(GROUND_COLOR_DIAGRAM);
        scene.environment = null; // 図面表現なので環境反射は載せない
        // 💡 修正：マンセル値シミュレーターと同じデフォルト値
        if (water) {
            water.material.uniforms.sunDirection.value.set(15, 25, 12).normalize();
            water.material.uniforms.sunColor.value.setHex(0xffffff);
            water.material.uniforms.waterColor.value.setHex(0x0a1c15);
            if (water.material.uniforms.alpha) water.material.uniforms.alpha.value = 1.0;
        }
    } else if (val > 17.5) {
        currentMode = 3; gui.show(); dayFolder.hide(); nightFolder.show(); setMaterialMode(3);
        bloomPass.strength = params.bloomStrength; bloomPass.threshold = params.bloomThreshold;
        grainPass.uniforms.uGrain.value = params.filmGrain;
        sunLight.intensity = 0; moonLight.intensity = params.moonLightIntensity;
        // 空からの回り込みは IBL が受け持つようになったので、半球光は補助程度まで落とす
        // （両方を効かせると空の光を二重に数えることになる）
        skyFillLight.intensity = 0.03;
        // 夜間分岐では環境光の強さが一度も指定されておらず、直前に通った昼／陰影なしモードの値
        // （9時経由なら約0.47）を引き継いでいた。経路で夜の明るさが変わるうえ、
        // 全方向から一様に当たるこの光が月光の影を塗り潰していたので、明示的に固定する。
        // IBL では真下を向いた面（軒裏など）が完全に黒く潰れるため、その底上げとして僅かに残す
        ambientLight.intensity = 0.06;
        moonLight.visible = true; // 月光の影を有効にする
        updateNightTint(params.moonLightBlueness, currentMode);
        scene.background.setHex(0x02040a);
        // 遠景が真っ黒に沈むと空と地面の境が消えるので、霧の色は夜空の地平付近に合わせる
        scene.fog.color.setHex(0x131725);
        scene.fog.density = 0.005; // 💡 追加：夜間は元の濃さの霧に戻して雰囲気を出す
        skyBox.visible = true; setSky(nightSkyTexture);
        roadMat.color.setHex(GROUND_COLOR_LIT);
        // 夜空を環境光源にする。空の明るさの分布が材質の鏡面反射に乗る
        scene.environment = nightEnvMap;
        scene.environmentIntensity = params.envIntensity;
        // 部屋ごとの色温度・明るさ・点灯状態をここで一括反映する（消灯窓のライトはここで非表示になる）
        refreshNightWindows();

        // 💡 修正：月光のブーストや透過を廃止
        if (water) {
            water.material.uniforms.sunDirection.value.copy(moonLight.position).normalize();
            // Water シェーダーは光源の強度を持たず色だけを受け取るため、色をそのまま渡すと
            // 月光でも真昼と同じ強さの拡散光が乗り、水面が明るい青一色になって映り込みが埋もれる。
            // 月明かりの強度を色に畳み込んで、反射が読める暗さまで落とす
            water.material.uniforms.sunColor.value
                .copy(moonLight.color)
                .multiplyScalar(params.moonLightIntensity);
            water.material.uniforms.waterColor.value.setHex(0x0a1c15); 
            if (water.material.uniforms.alpha) water.material.uniforms.alpha.value = 1.0;
        }
    } else {
        currentMode = 2; gui.show(); nightFolder.hide(); dayFolder.show(); setMaterialMode(2); bloomPass.strength = 0;
        grainPass.uniforms.uGrain.value = 0; // 粒状感は夜景のみに掛ける
        moonLight.intensity = 0; // 半球光(skyFillLight)は昼の空の回り込みとして下で設定する
        moonLight.visible = false;
        // ▼▼▼ 修正: intensity=0 に加え、ライト自体を非表示(false)にする ▼▼▼
        windowLights.forEach(l => {
            l.intensity = 0;
            l.visible = false;
        });
        const times = SunCalc.getTimes(DATE_WINTER_SOLSTICE, LATITUDE, LONGITUDE);
        const targetDate = new Date(times.solarNoon.getTime() + (val - 12.0) * 60 * 60 * 1000);
        const sunPos = SunCalc.getPosition(targetDate, LATITUDE, LONGITUDE);
        const rSun = Math.cos(sunPos.altitude);
        
        sunLight.position.set(rSun * -Math.sin(sunPos.azimuth) * 45, Math.max(0.05, Math.sin(sunPos.altitude)) * 45, rSun * Math.cos(sunPos.azimuth) * 45);

        const sunsetFactor = Math.max(0, Math.min(1.0, (val - 15.0) / (17.0 - 15.0)));
        const morningFactor = Math.max(0, Math.min(1.0, (11.0 - val) / (11.0 - 9.0)));
        
        sunLight.color.setHex(0xffffff).lerp(new THREE.Color(0xff986a), sunsetFactor);
        windowMatDay.color.setHex(0xffffff).lerp(new THREE.Color(0xffdcb8), sunsetFactor);

        // 空そのものを時刻に追従させる。
        // SkyBox を描画するようにしたことで、scene.background の色は天球に隠れて見えなくなり、
        // 朝夕の空色の変化がどこにも出ていなかった
        skyBox.visible = true;
        if (sunsetFactor > 0) setSky(daySkyTexture, sunsetSkyTexture, sunsetFactor);
        else setSky(daySkyTexture, morningSkyTexture, morningFactor);

        // 空を代表する色。背景と霧をこれに合わせる。
        // 彩度を上げすぎると遠景まで単色のオレンジで覆われてしまうので、霞んだ色味に留める
        const currentSkyColor = new THREE.Color(0x87ceeb);
        if (morningFactor > 0) currentSkyColor.lerp(new THREE.Color(0xb9cbd8), morningFactor);
        else if (sunsetFactor > 0) currentSkyColor.lerp(new THREE.Color(0xd9a583), sunsetFactor);
        scene.background.copy(currentSkyColor);

        // 夕方は大気の光路が長くなり、遠景が薄く霞む。快晴の南中では霧を掛けない
        scene.fog.color.copy(currentSkyColor);
        scene.fog.density = 0.0016 * sunsetFactor;

        const maxSunYInWinter = Math.sin((90 - LATITUDE - 23.44) * Math.PI / 180);
        const contrastCurve = Math.pow(Math.max(0, Math.min(1.0, Math.sin(sunPos.altitude) / maxSunYInWinter)), dayParams.falloffCurve);

        // 回り込み光を「全方向から一様」な環境光から半球光へ移す。
        // 一様光は陰影を平坦に均してしまい、これが日中のぼんやりした印象の一因になっていた
        const fillLevel = Math.PI * dayParams.noonAmbient * THREE.MathUtils.lerp(0.5, 1.0, contrastCurve);

        // フィル光は「太陽と反対側の空」の色。夕方でも天頂側には青が残るので、
        // ここまで暖色に振ると直射光との色対比が消え、画面全体が単色のオレンジになる。
        // 夕景は「暖色のハイライト／寒色の影」の対比で成立する
        const fillColor = new THREE.Color(0x87ceeb);
        if (morningFactor > 0) fillColor.lerp(new THREE.Color(0xb9cbd8), morningFactor);
        else if (sunsetFactor > 0) fillColor.lerp(new THREE.Color(0x6f83b2), sunsetFactor);

        skyFillLight.color.copy(fillColor);
        // 地面からの照り返しは、夕方は暖色寄りになる
        skyFillLight.groundColor.setHex(0x6b665e).lerp(new THREE.Color(0x8a6a4e), sunsetFactor);
        skyFillLight.intensity = fillLevel;

        // 環境光は、下を向いた面（軒裏など）が黒く潰れないための底上げに留める
        ambientLight.color.setHex(0xffffff).lerp(new THREE.Color(0xc9d2e4), sunsetFactor);
        ambientLight.intensity = fillLevel * 0.25;

        sunLight.intensity = Math.PI * (dayParams.noonSun * THREE.MathUtils.lerp(contrastCurve, 0.35, sunsetFactor));
        sunLight.castShadow = true;
        roadMat.color.setHex(GROUND_COLOR_LIT);
        scene.environment = null; // 昼間は今回の対象外（従来の見た目を維持する）

        // 💡 修正：太陽のブーストや透過を廃止し、自然な鏡面反射を取り戻す
        if (water) {
            // 実際の太陽ライトの位置（sunLight.position）を追尾させるのをやめ、マンセル側の固定値にする
            water.material.uniforms.sunDirection.value.set(15, 25, 12).normalize();
            // 夕焼けでオレンジ色に染めず、常に純白（0xffffff）にすることでシルバーの輝きを維持
            water.material.uniforms.sunColor.value.setHex(0xffffff);
            water.material.uniforms.waterColor.value.setHex(0x0a1c15);
            if (water.material.uniforms.alpha) {
                water.material.uniforms.alpha.value = 1.0; 
            }
        }
    }
    window.requestRender();
}

window.setSimulationTime = function(pct) {
    updateSceneByTime(convertSliderPctToTime(pct));
    window.requestRender();
};

const timeSlider = document.getElementById('time-slider');
const ticksContainer = document.getElementById('slider-ticks');
tickPercentages.forEach(pct => { const t = document.createElement('div'); t.className = 'tick'; t.style.left = `${pct}%`; ticksContainer.appendChild(t); });

let isReturning = false;
function closeAndReturn() {
    if (isReturning) return; isReturning = true;
    sessionStorage.setItem('sharedCameraState', JSON.stringify({ position: [camera.position.x*1000, camera.position.y*1000, camera.position.z*1000], target: [controls.target.x*1000, controls.target.y*1000, controls.target.z*1000] }));
    if (window.parent && window.parent.closeNightSimulation) window.parent.closeNightSimulation();
    else window.location.href = 'index.html';
}

timeSlider.addEventListener('input', (e) => {
    let pct = parseFloat(e.target.value);
    if (pct > 0 && pct < 13.636) { pct = pct < 6.818 ? 0 : 13.636; timeSlider.value = pct; } 
    else if (pct > 86.364 && pct < 100) { pct = pct < 93.182 ? 86.364 : 100; timeSlider.value = pct; }
    if (pct === 0) { closeAndReturn(); return; }
    updateSceneByTime(convertSliderPctToTime(pct));
    window.requestRender();
});

let initialSliderPct = 13.636;
const sharedSliderValStr = sessionStorage.getItem('sharedSliderValue');
if (sharedSliderValStr !== null) initialSliderPct = parseFloat(sharedSliderValStr);

updateSceneByTime(12); updateSceneByTime(8);
timeSlider.value = initialSliderPct;
updateSceneByTime(convertSliderPctToTime(initialSliderPct));

let initialRenderFrames = 45;
let isFirstFrame = true;

// 💡 ★追加3：マウスが動くたびに水面に乗っているか判定
renderer.domElement.addEventListener('pointermove', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(waterMeshes, true);

    if (intersects.length > 0) {
        isHoveringWater = true; // 水面に乗っている！
    } else {
        isHoveringWater = false; // 外れた
    }
});

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    if (skyBox) skyBox.position.copy(camera.position);

    // 💡 ★追加：水面の波アニメーションを進行させる（これで波がゆらゆら動きます）
        if (isHoveringWater) {
        waterMeshes.forEach(w => {
            if (w.material && w.material.uniforms && w.material.uniforms['time']) {
                w.material.uniforms['time'].value += 1.0 / 60.0;
            }
        });
        needsRender = true; // ホバー中のみ毎フレーム描画を要求（GPUの負荷を激減させます）
    }

    if (needsRender || initialRenderFrames > 0) {
        // 描画するフレームだけ粒を打ち直す。静止中は粒が固定されるので、
        // 画面の汚れのようには見えず、カメラ操作中だけ自然にざらつく
        grainPass.uniforms.uTime.value = performance.now() * 0.001;
        composer.render(); needsRender = false;
        if (initialRenderFrames > 0) initialRenderFrames--;
    }
    if (isFirstFrame) {
        isFirstFrame = false;
        if (window.parent && window.parent.showNightSimulation) window.parent.showNightSimulation();
    }
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight);
    window.requestRender();
});

// ==========================================================================
// ★追加：ポータル起動（単独起動）時のコントロール（スライダー制限＆終了ボタン非表示）
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    // 親から「夜間の建物データ」が渡されていなければ単独起動（ポータル起動）とみなす
    const isSingleMode = !sessionStorage.getItem('night_custom_glb');

    if (isSingleMode) {
        // 1. 画面右上の「終了」ボタンを完全に非表示にする
        const exitBtn = document.getElementById('btn-exit');
        if (exitBtn) {
            exitBtn.style.display = 'none';
        }

        // 2. タイムスライダーの可動域を制限する
        const timeSlider = document.getElementById('time-slider');
        if (timeSlider) {
            // HTML5のネイティブ属性 min を 13.636 (09:00) に設定し、これより左（陰影なし=0）にドラッグできないようにロック
            timeSlider.min = '13.636';

            // もし初期値が 13.636 未満（例えば 0）になっていた場合は、強制的に 13.636 に引き上げて再描画
            if (parseFloat(timeSlider.value) < 13.636) {
                timeSlider.value = '13.636';
                timeSlider.dispatchEvent(new Event('input'));
            }
        }

        // 3. 「陰影なし」の文字ラベルを半透明にして、選択不可であることを視覚的に示す（親切なUIフィードバック）
        const labels = document.querySelectorAll('.slider-labels-wrapper span');
        labels.forEach(span => {
            if (span.textContent.includes('陰影なし')) {
                span.style.opacity = '0.25';
                span.style.textDecoration = 'line-through'; // 打ち消し線を表示
                span.style.cursor = 'not-allowed';
            }
        });
    }
});
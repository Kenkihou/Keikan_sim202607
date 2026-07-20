import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { 
    baseWallMat, baseRoofMat, floorMat, floorMatDay, floorMatFlat, 
    windowMatDay, windowMatFlat, edgeMaterial, windowMat, updateShojiTexture 
} from './ys_material.js';
import { 
    initLights, sunLight, moonLight, moonFillLight, ambientLight, 
    updateNightTint, updateLightColorByTemperature 
} from './ys_lighting.js';
import { buildNightEnvironment } from './ys_env_builder.js';
import { createThreeModeMaterials } from './ys_material_factory.js';

let currentMode = 1; 
let needsRender = true;
window.requestRender = function() { needsRender = true; };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);
scene.fog = new THREE.FogExp2(0x050510, 0.005);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(22, 14, 28); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
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
const { water } =buildNightEnvironment(scene); 

// 💡 ★追加：マンセル値シミュレーターから空と雲（SkyBox）を完全移植
function createDynamicSkyBox() {
    const canvas = document.createElement('canvas');
    canvas.width = 2048; canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0.0, "#2b6fb8"); 
    gradient.addColorStop(0.4, "#63a4ff"); 
    gradient.addColorStop(0.6, "#bce6ff"); 
    gradient.addColorStop(1.0, "#f0f9ff"); 
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const drawCloud = (x, y, s) => {
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.beginPath();
        ctx.arc(x, y, 40*s, 0, Math.PI*2);
        ctx.arc(x+50*s, y-20*s, 50*s, 0, Math.PI*2);
        ctx.arc(x+100*s, y, 40*s, 0, Math.PI*2);
        ctx.arc(x+50*s, y+10*s, 30*s, 0, Math.PI*2);
        ctx.fill();
    };
    for(let i=0; i<15; i++) {
        const cx = Math.random() * canvas.width;
        const cy = 250 + Math.random() * 300; 
        const scale = 0.5 + Math.random() * 1.5;
        drawCloud(cx, cy, scale);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const skyGeo = new THREE.SphereGeometry(180, 32, 32);
    // fog: false にすることで、霧でくすまず常に綺麗に反射します
    const skyMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false });
    return new THREE.Mesh(skyGeo, skyMat);
}
const skyBox = createDynamicSkyBox();
scene.add(skyBox);

const houseGroup = new THREE.Group();
scene.add(houseGroup); // スケールはロードするモデル側にかけるため、ここでは設定しません

const windowLights = [];
const managedMeshes = []; 

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
                nMat = windowMat; dMat = windowMatDay; fMat = windowMatFlat;
                
                // ▼▼▼ 修正: ポールライトの場合は「漏れ出す光(スポットライト)」を生成しない ▼▼▼
                if (matName !== 'exteria_poal_light') {
                    child.updateMatrixWorld();
                    const worldPos = new THREE.Vector3(); child.getWorldPosition(worldPos);
                    const normal = new THREE.Vector3(0, 0, 1).transformDirection(child.matrixWorld).normalize();

                    const spLight = new THREE.SpotLight(0xffffff, 40.0, 15, Math.PI / 3, 0.8, 2);
                    spLight.position.copy(worldPos).add(normal.clone().multiplyScalar(0.01));
                    const targetObj = new THREE.Object3D(); targetObj.position.copy(worldPos).add(normal.clone().multiplyScalar(5));
                    
                    scene.add(targetObj); spLight.target = targetObj; scene.add(spLight); 
                    windowLights.push(spLight);
                }
                // ▲▲▲ 修正ここまで ▲▲▲
                
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
    
    // 💡 ★変更：トーンマッピングを常時 ACESFilmic に統一
    if (renderer.toneMapping !== THREE.ACESFilmicToneMapping) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        scene.traverse(c => { if (c.isMesh && c.material) c.material.needsUpdate = true; });
    }

    // 💡 ★追加：露出（画面の明るさ）をモードごとに微調整
    if (mode === 2) {
        renderer.toneMappingExposure = 1.25; // 昼間は露出を上げてパキッと明るく晴れ渡らせる
    } else if (mode === 3) {
        renderer.toneMappingExposure = 1.0;  // 夜間は電飾やブルームが引き立つ適正露出にする
    } else {
        renderer.toneMappingExposure = 1.0;
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
const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(renderPass); composer.addPass(bloomPass); composer.addPass(new OutputPass());

// GUI設定
const gui = new GUI({ title: '照明とブルームの調整' });
const dayFolder = gui.addFolder('昼間明かりの設定');
const dayParams = { noonAmbient: 0.3, noonSun: 0.2, falloffCurve: 1.0 }; 
dayFolder.add(dayParams, 'noonAmbient', 0.1, 2.0, 0.05).name('南中時の環境光').onChange(() => triggerDayUpdate());
dayFolder.add(dayParams, 'noonSun', 0.1, 3.0, 0.05).name('南中時の太陽光').onChange(() => triggerDayUpdate());
dayFolder.add(dayParams, 'falloffCurve', 1.0, 5.0, 0.1).name('朝夕の減衰カーブ').onChange(() => triggerDayUpdate());

function triggerDayUpdate() {
    if (currentMode === 2) { updateSceneByTime(convertSliderPctToTime(parseFloat(document.getElementById('time-slider').value))); window.requestRender(); }
}

const nightFolder = gui.addFolder('夜間明かりの設定');
const presets = {
    '朧げ': { colorTemperature: 3000, windowEmissiveIntensity: 0.6, spillLightIntensity: 3.0, moonLightIntensity: 0.5, moonLightBlueness: 0.4, bloomStrength: 1.0, bloomRadius: 0.0, gradientStrength: 1.0 },
    '煌々': { colorTemperature: 2500, windowEmissiveIntensity: 1.5, spillLightIntensity: 3.0, moonLightIntensity: 0.5, moonLightBlueness: 0.4, bloomStrength: 0.15, bloomRadius: 0.942, gradientStrength: 0.0 }
};
const params = Object.assign({}, presets['朧げ']);

const ctController = nightFolder.add(params, 'colorTemperature', 2500, 6500, 50).name('色温度 (K)').onChange(v => { updateLightColorByTemperature(v, currentMode, windowLights); window.requestRender(); });
const weController = nightFolder.add(params, 'windowEmissiveIntensity', 0, 3).name('窓ガラスの発光強度').onChange(v => { if (currentMode === 3) windowMat.emissiveIntensity = v; window.requestRender(); });
const slController = nightFolder.add(params, 'spillLightIntensity', 0, 10).name('漏れ出す光の強度').onChange(v => { if (currentMode === 3) windowLights.forEach(l => l.intensity = v); window.requestRender(); });
const mlController = nightFolder.add(params, 'moonLightIntensity', 0, 1).name('月明かりの強度').onChange(v => { if (currentMode === 3) moonLight.intensity = v; window.requestRender(); });
const mbController = nightFolder.add(params, 'moonLightBlueness', 0, 1).name('月明かりの青味').onChange(v => { updateNightTint(v, currentMode); window.requestRender(); });
const bsController = nightFolder.add(params, 'bloomStrength', 0, 1).name('ブルームの強さ').onChange(v => { if (currentMode === 3) bloomPass.strength = v * 0.3; window.requestRender(); });
const brController = nightFolder.add(params, 'bloomRadius', 0, 1).name('ブルームの半径').onChange(v => { bloomPass.radius = v; window.requestRender(); });
const gsController = nightFolder.add(params, 'gradientStrength', 0.0, 1.0).name('光の不均一さ').onChange(v => { if (currentMode === 3) updateShojiTexture(v); window.requestRender(); });

const presetState = { '朧げの照明': true, '煌々の照明': false };
function applyPreset(presetName) {
    const p = presets[presetName]; Object.assign(params, p);
    ctController.setValue(p.colorTemperature); weController.setValue(p.windowEmissiveIntensity); slController.setValue(p.spillLightIntensity); mlController.setValue(p.moonLightIntensity); mbController.setValue(p.moonLightBlueness); bsController.setValue(p.bloomStrength); brController.setValue(p.bloomRadius); gsController.setValue(p.gradientStrength);
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
        moonLight.intensity = 0; moonFillLight.intensity = 0; sunLight.intensity = 0; windowMat.emissiveIntensity = 0;
        // ▼▼▼ 修正: intensity=0 に加え、ライト自体を非表示(false)にする ▼▼▼
        windowLights.forEach(l => {
            l.intensity = 0;
            l.visible = false;
        });
        ambientLight.color.setHex(0xffffff); ambientLight.intensity = 1.0;
        scene.background.setHex(0x87ceeb); scene.fog.color.setHex(0x87ceeb);
        scene.fog.density = 0.0; // 💡 追加：陰影なしモードでは霧を完全にオフにする
        skyBox.visible = true; skyBox.material.color.setHex(0xffffff);
        // 💡 修正：マンセル値シミュレーターと同じデフォルト値
        if (water) {
            water.material.uniforms.sunDirection.value.set(15, 25, 12).normalize();
            water.material.uniforms.sunColor.value.setHex(0xffffff);
            water.material.uniforms.waterColor.value.setHex(0x0a1c15);
            if (water.material.uniforms.alpha) water.material.uniforms.alpha.value = 1.0;
        }
    } else if (val > 17.5) {
        currentMode = 3; gui.show(); dayFolder.hide(); nightFolder.show(); setMaterialMode(3);
        bloomPass.strength = params.bloomStrength; sunLight.intensity = 0; moonLight.intensity = params.moonLightIntensity; moonFillLight.intensity = 0.2; 
        // ▼▼▼ 修正: ライトを再表示(true)にする ▼▼▼
        windowLights.forEach(l => {
            l.intensity = params.spillLightIntensity;
            l.visible = true;
        });        
        windowLights.forEach(l => l.intensity = params.spillLightIntensity); windowMat.emissiveIntensity = params.windowEmissiveIntensity;
        updateNightTint(params.moonLightBlueness, currentMode);
        scene.background.setHex(0x050510); scene.fog.color.setHex(0x050510);
        scene.fog.density = 0.005; // 💡 追加：夜間は元の濃さの霧に戻して雰囲気を出す
        skyBox.visible = false;
        updateShojiTexture(params.gradientStrength); updateLightColorByTemperature(params.colorTemperature, currentMode, windowLights);

        // 💡 修正：月光のブーストや透過を廃止
        if (water) {
            water.material.uniforms.sunDirection.value.copy(moonLight.position).normalize();
            water.material.uniforms.sunColor.value.copy(moonLight.color);
            water.material.uniforms.waterColor.value.setHex(0x0a1c15); 
            if (water.material.uniforms.alpha) water.material.uniforms.alpha.value = 1.0;
        }
    } else {
        currentMode = 2; gui.show(); nightFolder.hide(); dayFolder.show(); setMaterialMode(2); bloomPass.strength = 0;
        moonLight.intensity = 0; moonFillLight.intensity = 0; windowMat.emissiveIntensity = 0; windowLights.forEach(l => l.intensity = 0);
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

        let currentSkyColor = new THREE.Color(0x87ceeb);
        if (morningFactor > 0) currentSkyColor.lerp(new THREE.Color(0x4a7294), morningFactor);
        else if (sunsetFactor > 0) currentSkyColor.lerp(new THREE.Color(0xb7b1ae), sunsetFactor);

        scene.background.copy(currentSkyColor); scene.fog.color.copy(currentSkyColor);
        scene.fog.density = 0.0;
        ambientLight.color.setHex(0xffffff).lerp(new THREE.Color(0xffe3dc), sunsetFactor);

        const maxSunYInWinter = Math.sin((90 - LATITUDE - 23.44) * Math.PI / 180); 
        const contrastCurve = Math.pow(Math.max(0, Math.min(1.0, Math.sin(sunPos.altitude) / maxSunYInWinter)), dayParams.falloffCurve);

        ambientLight.intensity = Math.PI * (0.15 + (dayParams.noonAmbient - 0.15) * contrastCurve); 
        sunLight.intensity = Math.PI * (dayParams.noonSun * THREE.MathUtils.lerp(contrastCurve, 0.35, sunsetFactor));
        sunLight.castShadow = true;
        skyBox.visible = true;

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
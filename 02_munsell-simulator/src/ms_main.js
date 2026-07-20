import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Water } from 'three/addons/objects/Water.js';

// --- 1. 外部モジュールのインポート ---
import { injectStyles } from './ms_styles.js';
import { neutralHexLut } from './ms_color_data.js';
import { allHues, munsellTreeCache, getMunsellHexSafe, loadError } from './ms_color_space.js';
import { initUIManager, updateUIInfo, setHueWheel, currentHueIndex } from './ms_ui_manager.js';
import { applyCustomTexture } from './ms_material_factory.js';
import { buildEnvironment } from './ms_env_builder.js';

// --- 2. CSSスタイルの動的注入 ---
injectStyles();

// ★最強の判定：親から「建物データ」が渡されていなければ単独起動（ポータル起動）とみなす
const isSingleMode = !sessionStorage.getItem('munsell_custom_glb');

// --- 3. HTML要素の動的生成 ---
document.body.innerHTML = `
    <div id="loading-screen">
        <div>Munsell 限界形状データを生成中...</div>
        <div id="error-message"></div>
    </div>

    <div id="canvas-wrapper">
        <div id="camera-hud">camera.position.set(-);<br>controls.target.set(-);</div>

        <div id="canvas-container"></div>
    </div>

    <div id="ui-toggle-btn">▶</div>

    <div id="bottom-ui-wrapper">
        <div id="col-info">
            <div id="panel-header-row">
                <div id="spec-toggle-container">
                    <span class="toggle-label active-low" id="label-low">軽量</span> <label class="toggle-switch">
                        <input type="checkbox" id="spec-toggle-checkbox"> <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label" id="label-high">高画質</span> 
                </div>
                <div class="canvas-tooltip">クリックで面を選択</div>
            </div>

            <div id="color-info-panel">
                <div class="info-row munsell-input-row">
                    <span class="integrated-label">MUN:</span>
                    <div class="manual-controls compact-manual">
                        <input type="number" id="in-h-val" class="manual-input" placeholder="2.5" step="0.1" min="0" max="10">
                        <select id="in-h-type" class="manual-input">
                            <option value="R">R</option><option value="YR">YR</option>
                            <option value="Y">Y</option><option value="GY">GY</option>
                            <option value="G">G</option><option value="BG">BG</option>
                            <option value="B">B</option><option value="PB">PB</option>
                            <option value="P">P</option><option value="RP">RP</option>
                        </select>
                        <input type="number" id="in-v" class="manual-input" placeholder="V" step="0.1" min="0" max="10">
                        <span class="integrated-slash">/</span>
                        <input type="number" id="in-c" class="manual-input" placeholder="C" step="0.1" min="0">
                    </div>
                </div>
                
                <div class="info-row hex-row">HEX:<span id="info-hex" class="info-val">-</span></div>
                <div class="info-row rgb-row">RGB:<span id="info-rgb" class="info-val">-</span></div>
                
                <div class="dropdown-split-row">
                    <div class="custom-dropdown" id="preset-custom-dropdown">
                        <div id="selected-color-box" class="custom-dropdown-selected" style="padding:0; position:relative; border-radius:6px; overflow:hidden; border: 1px solid #555; height: 40px; transition: all 0.2s; box-sizing: border-box; width: 100%;">
                            <span class="chip-arrow">▼</span>
                        </div>
                        <ul class="custom-dropdown-options preset-options">
                            <li data-value="N 4"><span class="texture-thumb" style="background-color: #5e5e5e;"></span>いぶし銀</li>
                            <li data-value="N 2"><span class="texture-thumb" style="background-color: #323232;"></span>ギングロ</li>
                            <li data-value="5Y 6.5/1"><span class="texture-thumb" style="background-color: #9c9a91;"></span>シャイングレー</li>
                            <li data-value="7.5YR 5.5/1"><span class="texture-thumb" style="background-color: #8c8279;"></span>ステンカラー</li>
                            <li data-value="N 1.5"><span class="texture-thumb" style="background-color: #272727;"></span>ブラック</li>
                        </ul>
                    </div>

                    <div class="custom-dropdown" id="texture-custom-dropdown">
                        <div class="custom-dropdown-selected" style="height: 40px; padding: 0 8px; box-sizing: border-box; width: 100%;">
                            <span class="texture-thumb thumb-none" style="margin-right: 2px;"></span>
                            <span class="custom-dropdown-text" style="margin-left: 2px; font-size: 13px;">テクスチャなし</span> <span class="custom-dropdown-arrow">▼</span>
                        </div>
                        <ul class="custom-dropdown-options">
                            <li data-value="none"><span class="texture-thumb thumb-none"></span>テクスチャなし</li> <li data-value="sunakabe"><span class="texture-thumb thumb-sunakabe"></span>砂壁調</li>
                            <li data-value="sugi"><span class="texture-thumb thumb-sugi"></span>杉板調</li>
                            <li data-value="metallic"><span class="texture-thumb thumb-metallic"></span>つや消しメタリック</li>
                            <li data-value="glass"><span class="texture-thumb thumb-glass"></span>ガラス調</li>
                        </ul>
                    </div>
                </div>
                
                <select id="preset-select" style="display: none;">
                    <option value="">-- 定番建材色から選ぶ --</option>
                    <option value="N 4">いぶし銀</option>
                    <option value="N 2">ギングロ</option>
                    <option value="5Y 6.5/1">シャイングレー</option>
                    <option value="7.5YR 5.5/1">ステンカラー</option>
                    <option value="N 1.5">ブラック</option>
                </select>

                <select id="texture-select" class="texture-select" style="display: none;">
                    <option value="none">テクスチャなし</option> <option value="sunakabe">砂壁調</option>
                    <option value="sugi">杉板調</option>
                    <option value="metallic">つや消しメタリック</option>
                    <option value="glass">ガラス調</option> 
                </select>
            </div>
        </div>
        
        <div id="col-wheel">
            <div class="wheel-tooltip tooltip-box">ドラッグで色相変更</div>
            <div id="wheel-container">
                <div id="wheel-knob-container">
                    <div id="wheel-knob"></div>
                </div>
                <div id="wheel-center">
                    <div class="hue-label">色相 (Hue)</div>
                    <div id="hue-display">-</div>
                </div>
            </div>
        </div>

        <div id="col-palette">
                <div id="palette-container"></div>
            </div>
        </div> </div>

    <div id="hover-message-box"></div>
`;

// --- 4. アプリケーション状態の管理 ---
let activeMaterial = null;
let activeMesh = null;      // 選択中のメッシュを保持
let activeMatIndex = -1;    // 選択中のマテリアルインデックスを保持

const loader = document.getElementById('loading-screen');
if (loadError) {
    document.getElementById('error-message').textContent = `エラー: ${loadError}`;
} else {
    if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.remove(), 300); }
}

// --- 5. Three.js 基本環境の構築 ---
const canvasContainer = document.getElementById('canvas-container');
const scene = new THREE.Scene();

// 環境構築モジュールを呼び出し、空・護岸・道路・水面・ライトを構築
const { dirLight } = buildEnvironment(scene);

const renderWidth = window.innerWidth;
const renderHeight = window.innerHeight;

const camera = new THREE.PerspectiveCamera(45, renderWidth / renderHeight, 0.1, 200);
// ★修正：カメラの初期位置を画像と同じベストアングルに設定
camera.position.set(-0.24, 7.59, 29.43); 

// メインカメラ（肉眼）に、レイヤー1（護岸）も同時に映す許可を与える
camera.layers.enable(1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(renderWidth, renderHeight);
renderer.shadowMap.enabled = true; // 影（シャドウマップ）を有効化
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 影のフチを滑らかにする

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
canvasContainer.appendChild(renderer.domElement);

// --- 6. ポストプロセッシングの構築 ---
// 高精度なカラーバッファで細部の目地のかすれ・歪みを防止
const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType
});

const composer = new EffectComposer(renderer, renderTarget);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// GTAOPassの初期化（常にオン）
const gtaoPass = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
gtaoPass.updateGtaoMaterial({ radius: 0.5 });
gtaoPass.blendIntensity = 1.0;
composer.addPass(gtaoPass);

// 基本的なピクセル比の設定（初期表示は軽量モードのため1に設定）
const customPixelRatio = Math.max(2, window.devicePixelRatio);
renderer.setPixelRatio(1); // 初期表示が軽量モードなので、最初は1に設定
composer.setPixelRatio(1);

const outputPass = new OutputPass();
composer.addPass(outputPass);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false; // 慣性を無効化してピタッと止める
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.8;
controls.target.set(0, 2.7, 0);

// ==========================================
// ★追加：親アプリ(main.js)から渡されたカメラ状態を読み込んで反映
// ==========================================
const savedCamState = sessionStorage.getItem('munsellCameraState');
if (savedCamState && !isSingleMode) { // ポータルからの単独起動でない場合のみ同期
    try {
        const camData = JSON.parse(savedCamState);
        // ★修正：親アプリ(mm)から子アプリ(m)への変換のため、1/1000倍にします
        camera.position.fromArray(camData.position).multiplyScalar(0.001);
        controls.target.fromArray(camData.target).multiplyScalar(0.001);
        controls.update();
    } catch(e) {
        console.warn("カメラ状態の引き継ぎに失敗しました", e);
    }
}

// ==========================================
// ★追加：親アプリがこのiframeを閉じる際、現在のカメラ情報を
// 読み取れるようにグローバル変数として公開しておく
// ==========================================
window.camera = camera;
window.controls = controls;


controls.addEventListener('change', () => {
    requestRender(); // カメラが動いたら描画する（常に高画質）
});

let houseModel = null;
const gltfLoader = new GLTFLoader();

// --- 7. コントロールとモデルの読み込み ---
let stopRenderTimeout = null;
let isHighRes = false;

// メインアプリから渡されたカスタムGLBがあるかチェック
const customGlb = sessionStorage.getItem('munsell_custom_glb');
const modelUrl = customGlb ? customGlb : `${import.meta.env.BASE_URL}normal_house.glb`;

gltfLoader.load(modelUrl, (gltf) => {
    houseModel = gltf.scene;

    // カスタムGLB（メインアプリのデータ）なら、スケールをmmからmに変換（1000分の1）
    if (customGlb) {
        houseModel.scale.set(0.001, 0.001, 0.001);
        houseModel.position.set(0, 0, 0); // 基準位置
    } else {
        houseModel.position.set(0, 0.1, 0); 
    }
    
    // モデル内のすべてのメッシュに影の設定を適用し、初期色をバックアップ
    houseModel.traverse((child) => {
        if (child.isMesh) {
            child.castShadow = true;    
            child.receiveShadow = true; 
            
            // 各メッシュのマテリアルの初期色（Hex）を記録
            if (child.material) {
                const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                if (mat.color && !defaultColorCache.has(mat.uuid)) {
                    defaultColorCache.set(mat.uuid, mat.color.getHex());
                }
            }
        }
    });
    
    // ==========================================================================
    // ★追加：親アプリ（モデリングシミュレーター）側で選ばれていた質感を、
    // このアプリ自身のシェーダー質感として再構築する。
    // 親アプリはフラット表示向けの簡易テクスチャしか焼き込まないため、GLBに含まれる
    // マテリアルの見た目をそのまま使うのではなく、質感タイプ（sunakabe/sugiなど）の
    // ヒントだけを受け取ってこちら側で正しく作り直す。
    // ==========================================================================
    if (customGlb) {
        try {
            const rawHints = sessionStorage.getItem('munsell_initial_textures');
            const hints = rawHints ? JSON.parse(rawHints) : null;
            if (hints && Object.keys(hints).length > 0) {
                const replacements = new Map(); // 元のマテリアルuuid -> 再構築後の新マテリアル

                houseModel.traverse((child) => {
                    if (!child.isMesh || !child.material) return;
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach((m) => {
                        if (!m || !m.name || replacements.has(m.uuid)) return;
                        const texType = hints[m.name];
                        if (!texType || texType === 'none') return;
                        m.userData.texType = texType;
                        replacements.set(m.uuid, applyCustomTexture(m));
                    });
                });

                if (replacements.size > 0) {
                    houseModel.traverse((child) => {
                        if (!child.isMesh || !child.material) return;
                        if (Array.isArray(child.material)) {
                            child.material = child.material.map(m => (m && replacements.has(m.uuid)) ? replacements.get(m.uuid) : m);
                        } else if (child.material && replacements.has(child.material.uuid)) {
                            child.material = replacements.get(child.material.uuid);
                        }
                    });
                }
            }
        } catch (err) {
            console.warn('親アプリからの質感の引き継ぎに失敗しました:', err);
        }
    }

    scene.add(houseModel);

    // ロード完了後、カメラのターゲットを更新
    // ★修正：親アプリと連携している場合は、引き継いだカメラ情報を優先するため上書きしない
    if (isSingleMode) {
        controls.target.set(0, customGlb ? 3.0 : 2.7, 0);
        controls.update();
    }
    
    requestRender();
}, undefined, (error) => {
    console.error('モデルの読み込みに失敗しました:', error);
});

// 各マテリアルの初期色を保持するバックアップ領域
const defaultColorCache = new Map();

// ★追加：いつでも親アプリ側から復帰できるように、最新のカラー状態を自動集計してセッションに格納する関数
function saveCurrentColors() {
    const colorMap = {};
    const textureMap = {}; // ★追加：質感（砂壁調・杉板調など）も親アプリに引き継ぐ
    try {
        if (houseModel) {
            houseModel.traverse(child => {
                if (child.isMesh && child.material) {
                    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                    if (mat.name) {
                        if (mat.uniforms && mat.uniforms.colorBase && mat.uniforms.colorBase.value) {
                            colorMap[mat.name] = "#" + mat.uniforms.colorBase.value.getHexString();
                        } else if (mat.color && typeof mat.color.getHexString === 'function') {
                            colorMap[mat.name] = "#" + mat.color.getHexString();
                        }
                        if (mat.userData && mat.userData.texType) {
                            textureMap[mat.name] = mat.userData.texType;
                        }
                    }
                }
            });
        }
    } catch (err) {
        console.warn("マテリアル色の自動抽出中にエラーが発生しました:", err);
    }
    sessionStorage.setItem('munsell_returned_colors', JSON.stringify(colorMap));
    sessionStorage.setItem('munsell_returned_textures', JSON.stringify(textureMap));
}

// --- 8. 2D UIマネージャーの初期化 ---
initUIManager({
    onColorChange: (hexColor) => {
        // UIで色が選ばれたら、3Dの選択中部位を塗り替える
        if (activeMaterial !== null) {
            if (activeMaterial.isShaderMaterial) {
                if (activeMaterial.uniforms.colorBase) activeMaterial.uniforms.colorBase.value.set(hexColor);
                if (activeMaterial.uniforms.colorShadow) activeMaterial.uniforms.colorShadow.value.set(hexColor).multiplyScalar(0.63);
            } else if (activeMaterial.color) {
                activeMaterial.color.set(hexColor);
            }
        }
        requestRender();
        saveCurrentColors(); // ★追加：色が変わるたびにリアルタイム自動保存
    },
    onTextureChange: (texType) => {
        // テクスチャが変更されたら、マテリアルを再生成して貼り替える
        if (!activeMesh || !activeMaterial) return;
        const oldMaterial = activeMaterial;
        oldMaterial.userData.texType = texType;
        const newMaterial = applyCustomTexture(oldMaterial);

        // ★修正：クリックしたメッシュ1つだけでなく、同じマテリアル（＝同じ部位）を
        // 共有している建物内の全メッシュに新しいテクスチャ付きマテリアルを反映する
        houseModel.traverse((child) => {
            if (child.isMesh && child.name !== 'selectionOutline' && child.material) {
                if (Array.isArray(child.material)) {
                    const idx = child.material.indexOf(oldMaterial);
                    if (idx !== -1) child.material[idx] = newMaterial;
                } else if (child.material === oldMaterial) {
                    child.material = newMaterial;
                }
            }
        });

        activeMaterial = newMaterial;

        // 現在の色を新しい質感にも引き継ぐ
        const currentHex = document.getElementById('info-hex').textContent;
        if (currentHex && currentHex.startsWith('#')) {
            const col = new THREE.Color(currentHex);
            if (activeMaterial.isShaderMaterial) {
                if (activeMaterial.uniforms.colorBase) activeMaterial.uniforms.colorBase.value.copy(col);
                if (activeMaterial.uniforms.colorShadow) activeMaterial.uniforms.colorShadow.value.copy(col.clone().multiplyScalar(0.63));
            } else {
                if (activeMaterial.color) activeMaterial.color.copy(col);
            }
        }
        requestRender();
        saveCurrentColors(); // ★追加：テクスチャの切り替え時にも最新の状態を自動保存
    }
});

// --- 9. インタラクション（クリック判定と選択） ---
const raycaster = new THREE.Raycaster();
//raycaster.far = 3.0; // 意図しない奥のオブジェクト選択を防ぐためのレイ長制限（必要に応じて有効化）
const mouse = new THREE.Vector2();

// 右上のツールチップ要素を取得して、動的クリックに対応できるように設定
const canvasTooltip = document.querySelector('.canvas-tooltip');
if (canvasTooltip) {
    canvasTooltip.style.pointerEvents = 'auto'; // ツールチップをクリック可能にする
}

// ツールチップのメッセージボックスをクリックした時の「デフォルト色に戻す」処理
canvasTooltip.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // 3D空間のクリック判定を防止
    
    if (activeMaterial && defaultColorCache.has(activeMaterial.uuid)) {
        // バックアップから初期の色の数値を復元
        const defaultHexNum = defaultColorCache.get(activeMaterial.uuid);
        const defaultHexStr = "#" + defaultHexNum.toString(16).padStart(6, '0');
        
        // 砂壁などのテクスチャを強制解除（標準マテリアルに戻す）
        if (activeMaterial.userData) activeMaterial.userData.texType = 'none';
        const resetMat = applyCustomTexture(activeMaterial);
        resetMat.color.setHex(defaultHexNum);

        if (activeMesh) {
            if (activeMatIndex !== -1 && Array.isArray(activeMesh.material)) {
                activeMesh.material[activeMatIndex] = resetMat;
            } else {
                activeMesh.material = resetMat;
            }
        }
        activeMaterial = resetMat;
        if (document.getElementById('texture-select')) document.getElementById('texture-select').value = 'none';
        
        // 下部のUI表示や手入力欄を初期色に同期
        updateUIInfo("キューブから取得", defaultHexStr);
        
        // カラーピッカー（逆算処理）をもう一度走らせてダイヤルやパレットも同期
        const searchHex = defaultHexStr.toLowerCase();
        let matchedMunsell = "-";
        let foundHueIndex = currentHueIndex; 
        let minDiff = Infinity;
        const r1 = parseInt(searchHex.slice(1, 3), 16);
        const g1 = parseInt(searchHex.slice(3, 5), 16);
        const b1 = parseInt(searchHex.slice(5, 7), 16);
        const isNeutralColor = (Math.max(r1, g1, b1) - Math.min(r1, g1, b1)) < 15;

        if (!isNeutralColor) {
            for (const hStr in munsellTreeCache) {
                for (const vStr in munsellTreeCache[hStr]) {
                    for (const cStr in munsellTreeCache[hStr][vStr]) {
                        const cacheHex = munsellTreeCache[hStr][vStr][cStr].toLowerCase();
                        const r2 = parseInt(cacheHex.slice(1, 3), 16);
                        const g2 = parseInt(cacheHex.slice(3, 5), 16);
                        const b2 = parseInt(cacheHex.slice(5, 7), 16);
                        const diff = Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2);
                        if (diff < minDiff) { minDiff = diff; matchedMunsell = `${hStr} ${vStr}/${cStr}`; foundHueIndex = allHues.indexOf(hStr); }
                    }
                }
            }
        }
        for (let v = 1; v <= 9; v++) {
            const cacheHex = neutralHexLut[v].toLowerCase();
            const r2 = parseInt(cacheHex.slice(1, 3), 16);
            const g2 = parseInt(cacheHex.slice(3, 5), 16);
            const b2 = parseInt(cacheHex.slice(5, 7), 16);
            const diff = Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2);
            if (diff < minDiff) { minDiff = diff; matchedMunsell = `N ${v}`; foundHueIndex = currentHueIndex; }
        }

        if (foundHueIndex !== -1) setHueWheel(foundHueIndex);
        updateUIInfo(matchedMunsell, defaultHexStr);
        
        requestRender();
    }
});

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (!houseModel) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(houseModel, true);

    const outlinesToRemove = [];
    houseModel.traverse((child) => {
        if (child.name === 'selectionOutline') outlinesToRemove.push(child);
    });
    outlinesToRemove.forEach(outline => {
        outline.parent.remove(outline);
        outline.geometry.dispose();
        outline.material.dispose();
    });

    if (intersects.length > 0) {
        activeMesh = intersects[0].object; // メッシュへの参照を記録

        if (Array.isArray(activeMesh.material)) {
            activeMatIndex = intersects[0].face.materialIndex; // インデックスを記録
            activeMaterial = activeMesh.material[activeMatIndex];
        } else {
            activeMatIndex = -1;
            activeMaterial = activeMesh.material;
        }

        // クリックした部位のテクスチャ設定をUIに反映
        const currentTexType = activeMaterial.userData.texType || 'none';
        const texSelect = document.getElementById('texture-select');
        if (texSelect) {
            texSelect.value = currentTexType;
        }
        // テクスチャ設定のUI反映完了

        houseModel.traverse((child) => {
            if (child.isMesh && child.name !== 'selectionOutline') {
                let isMatch = false;
                if (Array.isArray(child.material)) {
                    isMatch = child.material.includes(activeMaterial);
                } else {
                    isMatch = (child.material === activeMaterial);
                }

                if (isMatch) {
                    const edges = new THREE.EdgesGeometry(child.geometry);
                    const lineMat = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false }); 
                    const outline = new THREE.LineSegments(edges, lineMat);
                    outline.name = 'selectionOutline';
                    child.add(outline);
                }
            }
        });

        // 部位を選択した時の案内メッセージテキストを切り替える
        if (canvasTooltip) {
            canvasTooltip.innerHTML = '👈 下の色票で色を選ぶ<br><span style="text-decoration: underline; font-weight: bold; color: #ff7521;">（デフォルト色に戻す場合はここをクリック）</span>';
            canvasTooltip.style.cursor = 'pointer';
        }

        // ShaderMaterialとMeshStandardMaterialの両方の色取得に対応
        let currentHex = "#ffffff";
        if (activeMaterial.isShaderMaterial && activeMaterial.uniforms.colorBase) {
            currentHex = "#" + activeMaterial.uniforms.colorBase.value.getHexString();
        } else if (activeMaterial.color) {
            currentHex = "#" + activeMaterial.color.getHexString();
        }
        
        let matchedMunsell = "-";
        let foundHueIndex = currentHueIndex; 
        let minDiff = Infinity;
        const searchHex = currentHex.toLowerCase();
        const r1 = parseInt(searchHex.slice(1, 3), 16);
        const g1 = parseInt(searchHex.slice(3, 5), 16);
        const b1 = parseInt(searchHex.slice(5, 7), 16);
        const isNeutralColor = (Math.max(r1, g1, b1) - Math.min(r1, g1, b1)) < 15;

        if (!isNeutralColor) {
            for (const hStr in munsellTreeCache) {
                for (const vStr in munsellTreeCache[hStr]) {
                    for (const cStr in munsellTreeCache[hStr][vStr]) {
                        const cacheHex = munsellTreeCache[hStr][vStr][cStr].toLowerCase();
                        const r2 = parseInt(cacheHex.slice(1, 3), 16);
                        const g2 = parseInt(cacheHex.slice(3, 5), 16);
                        const b2 = parseInt(cacheHex.slice(5, 7), 16);
                        const diff = Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2);
                        if (diff < minDiff) { minDiff = diff; matchedMunsell = `${hStr} ${vStr}/${cStr}`; foundHueIndex = allHues.indexOf(hStr); }
                    }
                }
            }
        }

        for (let v = 1; v <= 9; v++) {
            const cacheHex = neutralHexLut[v].toLowerCase();
            const r2 = parseInt(cacheHex.slice(1, 3), 16);
            const g2 = parseInt(cacheHex.slice(3, 5), 16);
            const b2 = parseInt(cacheHex.slice(5, 7), 16);
            const diff = Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2);
            if (diff < minDiff) { minDiff = diff; matchedMunsell = `N ${v}`; foundHueIndex = currentHueIndex; }
        }

        if (foundHueIndex !== -1) setHueWheel(foundHueIndex);
        updateUIInfo(matchedMunsell, currentHex);
        requestRender();
        
    } else {
        activeMesh = null;
        activeMatIndex = -1;
        activeMaterial = null;
        
        // 何もないところをクリックして解除されたら、案内テキストも初期状態に戻す
        if (canvasTooltip) {
            canvasTooltip.innerHTML = '🖱️ クリックで面を選択<br>(余白クリックで解除)';
            canvasTooltip.style.cursor = 'default';
        }

        updateUIInfo("-", "-");
        
        requestRender(); 
    }
});


window.addEventListener('resize', () => {
    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight;
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(newWidth, newHeight);
    composer.setSize(newWidth, newHeight);
    gtaoPass.setSize(newWidth, newHeight); // サイズの更新
    requestRender();
});

// --- 10. レンダリングループと画面リサイズ ---
var renderRequested = false;

function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(renderLoop);
    }
}

var isLowSpecModeToggle = true; // 最初から軽量モードで起動

function renderLoop(time) {
    renderRequested = false;

    controls.update();

    // 動いているカメラの最新パラメータを画面に表示
    const hud = document.getElementById('camera-hud');
    if (hud) {
        const cp = camera.position;
        const ct = controls.target;
        hud.innerHTML = `camera.position.set(${cp.x.toFixed(2)}, ${cp.y.toFixed(2)}, ${cp.z.toFixed(2)});<br>controls.target.set(${ct.x.toFixed(2)}, ${ct.y.toFixed(2)}, ${ct.z.toFixed(2)});`;
    }

    // 安全な太陽光のリアルタイム同期処理
    if (activeMaterial && activeMaterial.isMeshStandardMaterial && activeMaterial.userData.texType === 'sunakabe' && dirLight) {
        // マテリアルがコンパイルされた後に生成される uniforms 領域に安全にアクセスする
        if (activeMaterial.__shader && activeMaterial.__shader.uniforms && activeMaterial.__shader.uniforms.uSunDirection) {
            activeMaterial.__shader.uniforms.uSunDirection.value.copy(dirLight.position).normalize();
        }
    }

    // 画質フラグに応じて、ネイティブ（軽量）とコンポーザー（高画質）の描画ルートを分岐
    if (isLowSpecModeToggle) {
        renderer.render(scene, camera); // ポストプロセッシングを一切通らない100%トーンマッピングのみ
    } else {
        composer.render(); // GTAOと高解像度バッファを通す
    }
}

// --- 11. 画質モード（パフォーマンス）の切替 ---
const specToggleCheckbox = document.getElementById('spec-toggle-checkbox');
const labelLow = document.getElementById('label-low');
const labelHigh = document.getElementById('label-high');

specToggleCheckbox.addEventListener('change', (e) => {
    const isHighQuality = e.target.checked;
    
    if (!isHighQuality) {
        // 軽量モードON（左側）
        isLowSpecModeToggle = true;
        renderer.setPixelRatio(1); // ベースの解像度を通常に落とす
        
        labelLow.classList.add('active-low');
        labelHigh.classList.remove('active-high');
    } else {
        // 高画質モード（右側）
        isLowSpecModeToggle = false;
        renderer.setPixelRatio(customPixelRatio); // 高解像度に戻す
        composer.setPixelRatio(customPixelRatio); // コンポーザーも高解像度化する
        
        labelLow.classList.remove('active-low');
        labelHigh.classList.add('active-high');
    }
    
    // 設定変更を即座に画面に反映させる
    requestRender();
});

requestRender();

// --- 12. 新統合UI（定番色アコーディオン＆カスタムテクスチャドロップダウン）の制御 ---
setTimeout(() => {
    // ★追加：引き出し式UIの開閉アニメーション制御
    const bottomUiWrapper = document.getElementById('bottom-ui-wrapper');
    const uiToggleBtn = document.getElementById('ui-toggle-btn');
    if (uiToggleBtn && bottomUiWrapper) {
        uiToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            bottomUiWrapper.classList.toggle('is-closed');
            if (bottomUiWrapper.classList.contains('is-closed')) {
                uiToggleBtn.textContent = '◀';
            } else {
                uiToggleBtn.textContent = '▶';
            }
        });
    }

    // 1. 色票チップ（定番色メニュー）のカスタムドロップダウン制御
    const presetDropdown = document.getElementById('preset-custom-dropdown');
    if (presetDropdown) {
        const colorBox = document.getElementById('selected-color-box');
        const optionLis = presetDropdown.querySelectorAll('.custom-dropdown-options li');
        const nativeSelect = document.getElementById('preset-select');

        colorBox.addEventListener('click', (e) => {
            e.stopPropagation();
            presetDropdown.classList.toggle('open');
            // テクスチャ側が開いていたら閉じる
            const texDropdown = document.getElementById('texture-custom-dropdown');
            if (texDropdown) texDropdown.classList.remove('open');
        });

        optionLis.forEach(li => {
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = li.getAttribute('data-value');
                presetDropdown.classList.remove('open');
                
                // 隠しセレクトボックスの値を書き換えて発火
                if (nativeSelect) {
                    nativeSelect.value = val;
                    nativeSelect.dispatchEvent(new Event('change'));
                }
            });
        });
    }

    // 2. カスタムテクスチャドロップダウン（案A）の制御
    const customDropdown = document.getElementById('texture-custom-dropdown');
    if (customDropdown) {
        const selectedEl = customDropdown.querySelector('.custom-dropdown-selected');
        const optionLis = customDropdown.querySelectorAll('.custom-dropdown-options li');
        const nativeSelect = document.getElementById('texture-select');

        selectedEl.addEventListener('click', (e) => {
            e.stopPropagation();
            customDropdown.classList.toggle('open');
            // 定番色側が開いていたら閉じる
            if (presetDropdown) presetDropdown.classList.remove('open');
        });

        optionLis.forEach(li => {
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = li.getAttribute('data-value');
                const text = li.textContent.trim();
                const thumbClass = li.querySelector('.texture-thumb').className;

                selectedEl.querySelector('.texture-thumb').className = thumbClass;
                selectedEl.querySelector('.custom-dropdown-text').textContent = text;
                customDropdown.classList.remove('open');

                if (nativeSelect) {
                    nativeSelect.value = val;
                    nativeSelect.dispatchEvent(new Event('change'));
                }
            });
        });
    }

    // 画面の他の場所をクリックした時に両方のドロップダウンを閉じる
    window.addEventListener('click', () => {
        if (presetDropdown) presetDropdown.classList.remove('open');
        if (customDropdown) customDropdown.classList.remove('open');
    });
}, 100);
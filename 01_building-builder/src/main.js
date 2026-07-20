// main.js
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { initCesium, placeModelOnEarth, manualSnapToGround, focusOnModel } from './cesiumApp.js';
import { openMapModal } from './mapApp.js'; 
import { ModelingEngine } from './modelingEngine.js';
import { AppState } from './appState.js';
import { UIController } from './uiController.js';
import { InteractionHandler } from './interactionHandler.js';
import { ViewManager } from './viewManager.js';
import { AppInit } from './init.js';
import { VisibilitySimulator } from './visibilitySimulator.js';
import { TutorialManager } from './tutorialManager.js';
import { setOnTextureAssetsReady, SUGI_BOARD_WIDTH_M, SUGI_BOARD_HEIGHT_M } from './materialTextureFactory.js';

// --- UI・操作状態（画面固有のもの） ---
let interactiveMeshes = [];
let meshMap = {}; 

// ==========================================
// 1. 環境の初期セットアップ (init.jsへ委譲)
// ==========================================
const { scene, camera, renderer, controls, materials, hoverMesh, houseGroup } = AppInit.run();
const { wallMat, activeMat, selectedMat, roofMat, edgeMat } = materials;
// ★追加：杉板調の目地線専用マテリアル（共有インスタンス、edgeMatと同様に使い回す）
const sugiJointMat = new THREE.LineBasicMaterial({ color: 0x2a2018 });

// ==========================================
// 2. UI・履歴・ステータスの連携
// ==========================================
function saveState() {
    AppState.saveState();
    UIController.updateActionButtons();
}

function undo() {
    if (AppState.undo()) {
        UIController.clearGUI();
        rebuildMeshes();
        UIController.updateActionButtons();
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
    }
}

function redo() {
    if (AppState.redo()) {
        UIController.clearGUI();
        rebuildMeshes();
        UIController.updateActionButtons();
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
    }
}

// ==========================================================================
// ★追加：壁材質が「杉板調」のとき、板1枚分の実寸幅ごとに目地線を描く。
// テクスチャに焼き込んだ線は縮小表示で潰れて見えなくなるため、
// このアプリの黒い輪郭線と同じ「線分ジオメトリ」として描画することで、
// どの距離・繰り返し数でもクッキリ見えるようにする。
// ==========================================================================
function buildWallJointLines(b, baseY) {
    const group = new THREE.Group();
    if (!b.materialTextures || b.materialTextures.wall !== 'sugi') return group;

    const boardWidthMM = SUGI_BOARD_WIDTH_M * 1000;   // 0.2m -> 200mm
    const boardHeightMM = SUGI_BOARD_HEIGHT_M * 1000; // 2.0m -> 2000mm
    const w2 = b.w / 2, d2 = b.d / 2;
    const yBot = baseY, yTop = baseY + b.h;
    const positions = [];

    // faceLength: 対象面の幅(mm)、toWorld: 面内オフセット(mm)からブロック中心基準の(x,z)を返す関数
    const addVerticalJoints = (faceLength, toWorld) => {
        const boardCount = Math.max(1, Math.round(faceLength / boardWidthMM));
        const actualWidth = faceLength / boardCount;
        for (let i = 1; i < boardCount; i++) {
            const offset = -faceLength / 2 + i * actualWidth;
            const { x, z } = toWorld(offset);
            positions.push(b.x + x, yBot, b.z + z, b.x + x, yTop, b.z + z);
        }
    };

    // ★追加：板の高さ(2mごと)に対応する横方向の目地線
    const addHorizontalJoints = (faceLength, toWorld) => {
        const rowCount = Math.max(1, Math.round(b.h / boardHeightMM));
        const actualHeight = b.h / rowCount;
        for (let i = 1; i < rowCount; i++) {
            const y = yBot + i * actualHeight;
            const start = toWorld(-faceLength / 2);
            const end = toWorld(faceLength / 2);
            positions.push(b.x + start.x, y, b.z + start.z, b.x + end.x, y, b.z + end.z);
        }
    };

    // pz(手前)・nz(奥)：X方向に沿って板が並ぶ
    addVerticalJoints(b.w, (off) => ({ x: off, z: d2 }));
    addVerticalJoints(b.w, (off) => ({ x: off, z: -d2 }));
    // px(右)・nx(左)：Z方向に沿って板が並ぶ
    addVerticalJoints(b.d, (off) => ({ x: w2, z: off }));
    addVerticalJoints(b.d, (off) => ({ x: -w2, z: off }));

    addHorizontalJoints(b.w, (off) => ({ x: off, z: d2 }));
    addHorizontalJoints(b.w, (off) => ({ x: off, z: -d2 }));
    addHorizontalJoints(b.d, (off) => ({ x: w2, z: off }));
    addHorizontalJoints(b.d, (off) => ({ x: -w2, z: off }));

    if (positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        group.add(new THREE.LineSegments(geo, sugiJointMat));
    }
    return group;
}

function rebuildMeshes() {
    while(houseGroup.children.length > 0){
        const child = houseGroup.children[0];
        houseGroup.remove(child);

        child.traverse((obj) => {
            if (obj.geometry) {
                obj.geometry.dispose();
            }
            // ★追加：建物ごと・階ごと・部位ごとに個別クローンされたマテリアルは
            // 使い回しの共有マテリアル（selectedMat/activeMat/edgeMat/ガラス類など）とは異なり、
            // 毎回新規生成されるためGPUリソースのリークを防ぐために破棄する
            if (obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(m => {
                    if (m && m.userData && m.userData.isClonedPartMaterial) m.dispose();
                });
            }
        });
    }
    meshMap = {};
    interactiveMeshes = [];

    // ★追加：rebuild1回につき1回、部位ごとのマテリアルキャッシュを完全リセット
    ModelingEngine.resetMaterialCache();

    AppState.buildingData.forEach(b => {
        // ★追加：このブロック（階）専用の壁色・屋根色・軒裏色マテリアルを解決（他の階・他の建物とは独立）
        const wallMatB = ModelingEngine.getMaterial(b, 'wall', wallMat);
        const roofMatB = ModelingEngine.getMaterial(b, 'roof', roofMat);
        // ★追加：大屋根・下屋・庇の「白層（軒裏・破風の水平面）」を壁面とは別に着色できるようにする
        const roofEaveMatB = ModelingEngine.getMaterial(b, 'roofEave', wallMat);
        // ★追加：ボックス自体の上面（屋上）は、大屋根・下屋・庇・バルコニー枠の屋根色(roof)とは
        // 別のマテリアルにして、両者が同じ色に連動してしまわないようにする
        const roofTopMatB = ModelingEngine.getMaterial(b, 'roofTop', roofMat);

        const geo = new THREE.BoxGeometry(b.w, b.h, b.d);

        // ★変更：側面(px/nx/pz/nz)は壁色、上面(top)は屋上専用色を使い、外壁と屋上を別々に着色できるようにする
        const mats = [wallMatB, wallMatB, roofTopMatB, wallMatB, wallMatB, wallMatB];
        if (b.id === AppState.selectedId && AppState.selectedFaceDir) {
            const fmap = { 'px':0, 'nx':1, 'top':2, 'bottom':3, 'pz':4, 'nz':5 };
            const idx = fmap[AppState.selectedFaceDir];
            if (idx !== undefined) mats[idx] = selectedMat;
        }

        const mesh = new THREE.Mesh(geo, mats);
        const baseY = b.y || 0;
        mesh.position.set(b.x, baseY + b.h / 2, b.z);
        mesh.userData.id = b.id; 

        const edges = new THREE.EdgesGeometry(geo);
        const line = new THREE.LineSegments(edges, edgeMat);
        line.position.copy(mesh.position);

        houseGroup.add(mesh, line);
        interactiveMeshes.push(mesh);
        meshMap[b.id] = { mesh, line };

        // ★追加：壁が杉板調テクスチャのとき、板幅ごとの目地線を描く
        houseGroup.add(buildWallJointLines(b, baseY));

        if (baseY === 0 && b.h > 100) {
            const kisoY = 100;
            const pts = [
                new THREE.Vector3(-b.w/2, kisoY, b.d/2),
                new THREE.Vector3(b.w/2, kisoY, b.d/2),
                new THREE.Vector3(b.w/2, kisoY, -b.d/2),
                new THREE.Vector3(-b.w/2, kisoY, -b.d/2),
                new THREE.Vector3(-b.w/2, kisoY, b.d/2)
            ];
            const kisoGeo = new THREE.BufferGeometry().setFromPoints(pts);
            const kisoLine = new THREE.Line(kisoGeo, edgeMat);
            kisoLine.position.set(b.x, baseY, b.z);
            kisoLine.userData = { id: b.id };
            houseGroup.add(kisoLine);
        }

        const roofMaterials = { wallMat: roofEaveMatB, roofMat: roofMatB, edgeMat: edgeMat, gableWallMat: wallMatB };
        const roofsGroup = ModelingEngine.buildRoofs(b, baseY, AppState.buildingData, roofMaterials);

        roofsGroup.traverse(child => {
            if (child.isMesh && child.userData.isRoof) {
                interactiveMeshes.push(child);
            }
        });
        houseGroup.add(roofsGroup);

        const visorMaterials = { roofMat: roofMatB, wallMat: roofEaveMatB, edgeMat: edgeMat, gableWallMat: wallMatB };
        const visorsGroup = ModelingEngine.buildVisorsAndSkirts(b, baseY, visorMaterials);
        houseGroup.add(visorsGroup);

        const balcMaterials = { roofMat: roofMatB, edgeMat: edgeMat };
        const balconiesGroup = ModelingEngine.buildBalconies(b, baseY, balcMaterials);
        houseGroup.add(balconiesGroup);

        const pilasterMaterials = { edgeMat: edgeMat };
        const pilastersGroup = ModelingEngine.buildPilasters(b, baseY, pilasterMaterials);
        houseGroup.add(pilastersGroup);

        const windowMaterials = { edgeMat: edgeMat };
        const windowsGroup = ModelingEngine.buildWindows(b, baseY, windowMaterials);
        houseGroup.add(windowsGroup);

        const doorMaterials = { edgeMat: edgeMat };
        const doorsGroup = ModelingEngine.buildDoors(b, baseY, doorMaterials);
        houseGroup.add(doorsGroup);

        // ★変更：そで壁・垂れ壁は本体の壁色とは独立した専用パーツとして着色できるようにする
        const sodeMaterials = { wallMat: ModelingEngine.getMaterial(b, 'sodeWall', wallMat), edgeMat: edgeMat };
        const sodeWallsGroup = ModelingEngine.buildSodeWalls(b, baseY, sodeMaterials);
        houseGroup.add(sodeWallsGroup);

        const tareMaterials = { wallMat: ModelingEngine.getMaterial(b, 'tareWall', wallMat), edgeMat: edgeMat };
        const tareWallsGroup = ModelingEngine.buildTareWalls(b, baseY, tareMaterials);
        houseGroup.add(tareWallsGroup);

    });

    if (window.renderAllViews) window.renderAllViews();
    // ★追加：メッシュを再構築した直後に、編集中の水色ハイライト状態を復元する
    if (window.triggerHighlightSync) window.triggerHighlightSync();
}

// ★追加：質感用の画像（砂壁調・杉板調の合成テクスチャ）の読み込みが完了したら再描画する
// （初回はまだ画像が読み込み中のため、テクスチャなしの状態で一度描画されることがある）
setOnTextureAssetsReady(() => rebuildMeshes());

// ==========================================
// ★追加：子アプリ（マンセル値シミュレーター）から返ってきた色・質感マップを
// 「建物ごと・階ごと・部位ごと」のマテリアル名（`${blockId}__${partKey}`）から解析し、
// AppState.buildingData に永続化する（保存・undo/redo・再描画のすべてで正しく維持されるようにする）
// ==========================================
function applyReturnedMunsellColors(colorMap, textureMap) {
    if (!colorMap && !textureMap) return;
    let changed = false;

    const applyMap = (map, targetField) => {
        if (!map) return;
        for (const matName in map) {
            const idx = matName.lastIndexOf('__');
            if (idx === -1) continue;
            const blockId = matName.slice(0, idx);
            const partKey = matName.slice(idx + 2);

            const b = AppState.buildingData.find(x => x.id === blockId);
            if (!b) continue;

            if (!b[targetField]) b[targetField] = {};
            b[targetField][partKey] = map[matName];
            changed = true;
        }
    };

    applyMap(colorMap, 'materialColors');
    applyMap(textureMap, 'materialTextures');

    if (changed) {
        AppState.saveState();
        UIController.updateActionButtons();
        rebuildMeshes();
    }
}

// 履歴初期保存
AppState.saveState();

// ==========================================
// 3. インタラクションブリッジ ＆ ハンドラー初期化
// ==========================================
window.setMeshActiveMaterial = function(id) {
    if (meshMap[id]) meshMap[id].mesh.material = activeMat;
};
window.getHouseGroup = function() { return houseGroup; };
window.getEdgeMat = function() { return edgeMat; };

// ViewManagerの初期化
ViewManager.init({ scene, camera, renderer, houseGroup });
window.renderAllViews = () => ViewManager.renderAllViews();

// InteractionHandlerの初期化
InteractionHandler.init({
    camera, scene, controls, hoverMesh, activeMat, rebuildMeshes, saveState,
    getInteractiveMeshes: () => interactiveMeshes
});

// ==========================================
// ★追加：チュートリアルマネージャーの初期化と登録
// ==========================================
TutorialManager.init({
    camera: camera,
    controls: controls,
    scene: scene,
    rebuildMeshes: rebuildMeshes,
    activeMat: activeMat,
    edgeMat: edgeMat
});
window.TutorialManager = TutorialManager;

// (※不要になった裏側でのクリック連動処理はすべて綺麗に削除しました)

// コントロール・リサイズイベントのバインド
controls.addEventListener('change', () => {
    // 全画面描画に伴い、アスペクト比の計算を画面全体の幅ベースに変更します
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (window.renderAllViews) window.renderAllViews();
});        

// ツールバーボタン（HTML）用グローバルバインド
window.undo = undo;
window.redo = redo;
window.toggleSnap = function() {
    InteractionHandler.toggleSnap();
};

window.clearAll = function() {
    if(confirm('すべてのオブジェクトを消去しますか？')) {
        AppState.clearAll();
        window.setTool(null);
        rebuildMeshes();
        UIController.hideFloatingMenu(); 
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
        UIController.updateActionButtons();
    }
};

// ==========================================
// 4. エクスポート ＆ Cesium連携フロー
// ==========================================
window.lastPlacedLocation = { lat: 34.9858, lng: 135.7588 };
window.lastPlacedHeading = 0; // ★追加：回転角度（ラジアン）の記憶用初期値

document.getElementById('btn-export-cesium').addEventListener('click', () => {
    if (houseGroup.children.length === 0) {
        return alert('配置する建物がありません。');
    }
    UIController.clearGUI();
    UIController.hideFloatingMenu();
    controls.enabled = false;

    // ★追加：2D地図モーダルが開くこの瞬間に「チュートリアルを開始」ボタンを非表示にする
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) {
        tutorialBtn.style.display = 'none';
    }

    // ★必須：線のデータをGLB出力前に直接抽出してCesiumへ渡す（これが消えてエラーになっていました）
    const linesData = [];
    houseGroup.traverse(child => {
        // LineSegments(表示されている線)を見つけたら頂点を抽出
        if (child.isLineSegments && child.geometry) {
            child.updateMatrixWorld(true);
            const posAttr = child.geometry.attributes.position;
            if (!posAttr) return;
            for (let i = 0; i < posAttr.count; i += 2) {
                const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i);
                const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i+1);
                v1.applyMatrix4(child.matrixWorld);
                v2.applyMatrix4(child.matrixWorld);
                
                // Three.js(x,y,z) -> CesiumのEntityローカル軸(z,x,y)へ変換
                linesData.push({
                    p1: { x: v1.z/1000, y: v1.x/1000, z: v1.y/1000 },
                    p2: { x: v2.z/1000, y: v2.x/1000, z: v2.y/1000 }
                });
            }
        }
    });

    openMapModal(window.lastPlacedLocation, 
        (selectedLocation) => {
            window.lastPlacedLocation = selectedLocation;
            const exporter = new GLTFExporter();
            exporter.parse(houseGroup, (gltf) => {
                const blob = new Blob([JSON.stringify(gltf)], { type: 'application/json' });
                const glbUrl = URL.createObjectURL(blob);

                document.getElementById('cesium-overlay').style.display = 'block';
                const myCesiumToken = import.meta.env.VITE_CESIUM_TOKEN;
                initCesium('cesiumContainer', myCesiumToken, selectedLocation).then(() => {
                    // ここで抽出した linesData を渡して地球上に配置
                    placeModelOnEarth(glbUrl, linesData, selectedLocation); 
                });
            }, (err) => console.error(err), { binary: false });
        },
        () => { 
            // 2D地図でキャンセルを押して戻った時の処理
            controls.enabled = true; 

            // ★追加：キャンセル時にも「チュートリアルを開始」ボタンを再表示する
            const tutorialBtn = document.getElementById('btn-start-tutorial');
            if (tutorialBtn) {
                tutorialBtn.style.display = 'block';
            }
        }
    );
});

document.getElementById('btn-back-to-model').addEventListener('click', () => {
    document.getElementById('cesium-overlay').style.display = 'none';
    controls.enabled = true; 

    // ★追加：「チュートリアルを開始」ボタンを再表示する
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) {
        tutorialBtn.style.display = 'block'; // 元のCSSに合わせて 'flex' などでも可
    }
});

const snapBtn = document.getElementById('snapRetryBtn');
if (snapBtn) {
    snapBtn.addEventListener('click', () => manualSnapToGround());
}

const focusBtn = document.getElementById('btn-focus-model');
if (focusBtn) {
    focusBtn.addEventListener('click', () => focusOnModel());
}

// UIController初期化 ＆ 初回描画
UIController.init(rebuildMeshes, window.setTool);
if (window.renderAllViews) window.renderAllViews();

// ==========================================
// ★追加：JSONセーブ・ロード機能の実装
// ==========================================

// ■ セーブ処理
document.getElementById('btn-save-json').addEventListener('click', () => {
    // セーブ中、一時的にGUIやメニューを隠してクリーンな状態にする
    UIController.clearGUI();
    UIController.hideFloatingMenu();

    // 保存するJSONデータ全体のパッケージング
    const saveData = {
        version: "1.0", // 将来のマイグレーション用バージョン
        savedAt: new Date().toISOString(),
        appState: {
            buildingData: AppState.buildingData
        },
        cesiumState: {
            lastPlacedLocation: window.lastPlacedLocation,
            lastPlacedHeading: window.lastPlacedHeading // 地球上でのモデルの回転角度
        }
    };

    // Blobオブジェクトを作成し、ローカルへファイルとしてダウンロード
    const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    // ファイル名に今日の日付を付与 (例: modeling_state_20260523.json)
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    a.download = `modeling_state_${dateStr}.json`;
    a.href = url;
    a.click();
    
    URL.revokeObjectURL(url);
});

// ■ ロード処理
const btnLoadJson = document.getElementById('btn-load-json');
const inputLoadJson = document.getElementById('input-load-json');

btnLoadJson.addEventListener('click', () => {
    // 地球モード（Cesium画面）が表示されている時は誤動作を防ぐため実行させない
    if (document.getElementById('cesium-overlay').style.display === 'block') {
        alert('ロード処理はモデリング画面でのみ実行可能です。一度戻ってからロードしてください。');
        return;
    }
    
    if (confirm('現在の作業内容は上書き消去されます。JSONファイルをロードしますか？')) {
        inputLoadJson.click(); // 隠されている <input type="file"> を発火
    }
});

inputLoadJson.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const json = JSON.parse(event.target.result);
            
            // 最低限必要なモデリングデータの器が存在するかチェック
            if (!json.appState || !json.appState.buildingData) {
                throw new Error('不適切なファイル形式か、データが破損しています。');
            }

            // 1. AppStateへデータを流し込み（マイグレーション含む）
            AppState.loadState(json.appState.buildingData, json.version || "1.0");

            // 2. 地球上での配置・回転設定の復元
            if (json.cesiumState) {
                if (json.cesiumState.lastPlacedLocation) {
                    window.lastPlacedLocation = json.cesiumState.lastPlacedLocation;
                }
                if (json.cesiumState.lastPlacedHeading !== undefined) {
                    window.lastPlacedHeading = json.cesiumState.lastPlacedHeading;
                }
            } else {
                // 地球モードの設定が含まれない古いデータの場合は安全に初期化
                window.lastPlacedLocation = { lat: 34.9858, lng: 135.7588 };
                window.lastPlacedHeading = 0;
            }

            // 3. 各種3DメッシュとUIパネルの同期・再描画
            UIController.clearGUI();
            UIController.hideFloatingMenu();
            rebuildMeshes(); // Three.jsシーンを完全再構築
            
            // ボタンの活性・非活性状態やステータス表示の更新
            UIController.updateActionButtons();
            UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());

            alert('作業状態を正常にロードしました。');
        } catch (err) {
            alert('ロードに失敗しました:\n' + err.message);
        }
        
        // 連続で同じファイルを読み込めるように選択内容をクリア
        inputLoadJson.value = '';
    };
    reader.readAsText(file);
});

// ==========================================
// ★変更：夜間シミュレーター起動処理（main.js側は起動制限を解除するだけ）
// ==========================================
let isNightModeActive = false; 

function openNightSimulation(initialSliderPct = 13.636, fromPortal = false) {
    if (isNightModeActive) return; 
    
    // アプリ2起動時に「チュートリアルを開始」ボタンを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';

    // ★修正：「着色モードへ」ボタンの正しいIDを指定し、確実にクリックを無効化する
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.style.pointerEvents = 'none'; // 物理的にクリック不能にする
        munsellBtn.style.opacity = '0.4';
    }

    isNightModeActive = true; 

    // スライダー位置を保存
    sessionStorage.setItem('sharedSliderValue', initialSliderPct.toString());
    
    // マテリアルに名前をつけて保持（夜間側で個別に色を扱うため）
    houseGroup.traverse(child => {
        if (child.isMesh && child.material) {
            const mat = Array.isArray(child.material) ? child.material[0] : child.material;
            if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
        }
    });

    if (fromPortal) {
        // ★ポータルから起動時は現在のモデルのGLBパッキングをスキップ
        sessionStorage.removeItem('night_custom_glb');
        proceedOpenNightIframe(initialSliderPct, true);
    } else {
        // ★通常（モデリング画面）から起動時は現在のモデルをパッキング
        const exporter = new GLTFExporter();
        exporter.parse(houseGroup, (glb) => {
            const blob = new Blob([glb], { type: 'application/octet-stream' });
            const glbUrl = URL.createObjectURL(blob);
            sessionStorage.setItem('night_custom_glb', glbUrl);
            
            // パッキング完了後に実際のiframe立ち上げに移行
            proceedOpenNightIframe(initialSliderPct, false);
        }, (err) => console.error(err), { binary: true });
    }
}

// iframe生成とカメラスナップの後半処理を分離
// --- [main.js 内の proceedOpenNightIframe を以下に丸ごと差し替えてください] ---
function proceedOpenNightIframe(initialSliderPct, fromPortal = false) {
    const cameraState = {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        fov: camera.fov 
    };
    sessionStorage.setItem('sharedCameraState', JSON.stringify(cameraState));
    
    const app1Slider = document.getElementById('app1-time-slider-container');
    if (app1Slider) app1Slider.style.zIndex = '10000';

    let iframe = document.getElementById('night-sim-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'night-sim-iframe';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        // 以下は下の条件分岐で動的に設定するため、ここでは最低限のスタイルのみ記述
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.zIndex = '5000';
        iframe.style.opacity = '0';
        iframe.style.transition = 'opacity 0.3s ease-out';
        document.body.appendChild(iframe);
    }
    
    // ★追加：全画面描画に伴い、モデリング画面からの連携時も画面いっぱいに iframe を広げるように統一します
    iframe.style.left = '0';
    iframe.style.width = '100%';
    /* 以前のサブ画面回避用の処理は不要になったため廃止
    if (fromPortal) {
        iframe.style.left = '0';
        iframe.style.width = '100%';
    } else {
        iframe.style.left = '37.5vh';
        iframe.style.width = 'calc(100% - 37.5vh)';
    }
    */
    
    iframe.style.opacity = '0'; 
    // 起動元に応じて、夜間側の画面にパラメータを付与してロード
    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./night-api/${urlParam}`;
    iframe.style.display = 'block';
}
// ★追加：アプリ2から「描画完了」の合図を受け取って透明化を解除する
window.showNightSimulation = function() {
    const iframe = document.getElementById('night-sim-iframe');
    if (iframe) {
        iframe.style.opacity = '1'; // フワッと表示させる
    }
};

// 夜間シミュレーター側から安全に閉じるためのグローバル関数
window.closeNightSimulation = function() {
    isNightModeActive = false; 

    // アプリ2起動時に「チュートリアルを開始」ボタンを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';

    // ★修正：正しいIDを指定し、ロックと半透明を解除する
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.style.pointerEvents = '';
        munsellBtn.style.opacity = '';
    }

    const iframe = document.getElementById('night-sim-iframe');
    if (iframe) {
        if (iframe.contentWindow && iframe.contentWindow.camera && iframe.contentWindow.controls) {
            const cam2 = iframe.contentWindow.camera;
            const ctrl2 = iframe.contentWindow.controls;
            const updatedCameraState = {
                position: [cam2.position.x * 1000, cam2.position.y * 1000, cam2.position.z * 1000],
                target: [ctrl2.target.x * 1000, ctrl2.target.y * 1000, ctrl2.target.z * 1000]
            };
            sessionStorage.setItem('sharedCameraState', JSON.stringify(updatedCameraState));
        }

        iframe.style.opacity = '0'; 
        setTimeout(() => {
            iframe.style.display = 'none';
            iframe.src = 'about:blank'; 
        }, 300);
    }
    
    // カメラ位置の復元
    const sharedCameraState = sessionStorage.getItem('sharedCameraState');
    if (sharedCameraState) {
        try {
            const camData = JSON.parse(sharedCameraState);
            camera.position.fromArray(camData.position);
            controls.target.fromArray(camData.target);
            controls.update();
        } catch (e) {
            console.error('カメラデータの復元に失敗しました', e);
        }
    }

    // アプリ1のスライダーを「陰影なし(0)」の位置にリセット
    const timeSlider = document.getElementById('app1-time-slider');
    const timeDisplay = document.getElementById('app1-time-display');
    if (timeSlider) timeSlider.value = 0;
    if (timeDisplay) timeDisplay.textContent = "陰影なし";
};

// ==========================================
// ★追加：アプリ1 時刻スライダーのダミー制御ロジック (アプリ2完全準拠)
// ==========================================
(function setupApp1TimeSlider() {
    const timeSlider = document.getElementById('app1-time-slider');
    const timeDisplay = document.getElementById('app1-time-display');
    const ticksContainer = document.getElementById('app1-slider-ticks');

    if (!timeSlider) return;

    // アプリ2と同じ比率の目盛り位置
    const tickPercentages = [
        0, 13.636, 13.636 + 9.091 * 1, 13.636 + 9.091 * 2, 13.636 + 9.091 * 3, 13.636 + 9.091 * 4, 13.636 + 9.091 * 5, 13.636 + 9.091 * 6, 13.636 + 9.091 * 7, 13.636 + 9.091 * 8, 100                                                 
    ];

    // 目盛りの生成
    tickPercentages.forEach(pct => {
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = `${pct}%`; 
        ticksContainer.appendChild(tick);
    });

    // スライダーの％から時刻(数値)へ変換するロジック（アプリ2完全同期）
    function convertSliderPctToTime(pct) {
        if (pct <= tickPercentages[0]) return 8.0;
        if (pct >= tickPercentages[10]) return 18.0; 
        
        if (pct < tickPercentages[1]) {
            return 8.0 + (pct - tickPercentages[0]) / (tickPercentages[1] - tickPercentages[0]);
        }
        if (pct > tickPercentages[9]) {
            return 17.0 + (pct - tickPercentages[9]) / (tickPercentages[10] - tickPercentages[9]);
        }
        
        for (let i = 1; i <= 8; i++) {
            if (pct >= tickPercentages[i] && pct <= tickPercentages[i+1]) {
                const baseHour = 8.0 + i; 
                const segmentProgress = (pct - tickPercentages[i]) / (tickPercentages[i+1] - tickPercentages[i]);
                return baseHour + segmentProgress;
            }
        }
        return 18.0;
    }

    // スライダー更新時の表示反映
    function updateSliderUI() {
        let pct = parseFloat(timeSlider.value);
        
        // ★アプリ2と同様のスナップ処理（カクっと動かす）
        if (pct > 0 && pct < 13.636) {
            pct = pct < 6.818 ? 0 : 13.636;
            timeSlider.value = pct;
        } 
        else if (pct > 86.364 && pct < 100) {
            pct = pct < 93.182 ? 86.364 : 100;
            timeSlider.value = pct;
        }

        // 09:00 (13.636%) 以上になったら自動的にアプリ2を起動、または時間を送る
        if (pct >= 13.636) {
            if (!isNightModeActive) {
                openNightSimulation(pct); // 起動
            } else {
                // 起動済みなら、裏側のiframeにリアルタイムに時間を送る
                const iframe = document.getElementById('night-sim-iframe');
                if (iframe && iframe.contentWindow && typeof iframe.contentWindow.setSimulationTime === 'function') {
                    iframe.contentWindow.setSimulationTime(pct);
                }
            }
        } else if (pct === 0) {
            // 陰影なし(0)に戻ったらアプリ1へ戻る（閉じる）処理もここで一元管理
            if (isNightModeActive) {
                window.closeNightSimulation();
            }
        }

        const calculatedTime = convertSliderPctToTime(pct);

        // 時刻テキストの更新
        if (timeDisplay) {
            if (calculatedTime < 8.5) {
                timeDisplay.textContent = "陰影なし";
            } else if (calculatedTime > 17.5) {
                timeDisplay.textContent = "夜間照明";
            } else {
                const h = Math.floor(calculatedTime);
                const m = Math.floor((calculatedTime % 1) * 60);
                timeDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
        }
    }

    // イベントリスナーの登録
    timeSlider.addEventListener('input', updateSliderUI);

    // 初期化 (アプリ2に合わせて 0% 陰影なしスタート)
    timeSlider.value = 0;
    updateSliderUI();
})();

// ==========================================
// ★変更：マンセル値シミュレーターのデータ連携付き起動
// ==========================================
let isMunsellModeActive = false;

function openMunsellIframe(fromPortal = false) {
    // 起動時にメインアプリ側の各UIを隠す
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';

    // ★修正：スライダーコンテナごと隠すのをやめ、スライダー部分だけをグレーアウト（無効化）します
    const sliderInner = document.querySelector('#app1-time-slider-container .slider-ui-inner');
    if (sliderInner) sliderInner.classList.add('slider-disabled');

    // ★追加：🎨ボタンを「へこみ状態（ON）」にします
    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.classList.add('active');
        // マンセル起動中（着色モードON）なので、次はモデリングに戻る案内を出す
        munsellBtn.setAttribute('data-tooltip', '✏️ モデリングモードへ');
    }

    // ==========================================
    // ★追加：メイン画面のカメラ状態をセッションに保存（マンセル画面へ渡す用）
    // ==========================================
    const cameraState = {
        position: camera.position.toArray(),
        target: controls.target.toArray()
    };
    sessionStorage.setItem('munsellCameraState', JSON.stringify(cameraState));

    let iframe = document.getElementById('munsell-sim-iframe');
    // 送信処理はここから削除し、子画面からの応答待ち（下のイベントリスナー）に移譲します
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'munsell-sim-iframe';
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.zIndex = '5000';
        iframe.style.opacity = '0';
        iframe.style.transition = 'opacity 0.3s ease-out';
        document.body.appendChild(iframe);
    }
    
    // 起動元に応じて、マンセル側の画面にパラメータを付与してロード
    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./munsell-api/${urlParam}`;
    iframe.style.display = 'block';
    setTimeout(() => { iframe.style.opacity = '1'; }, 50);
}

// ==========================================================================
// ★追加：子アプリ（マンセル値シミュレーター）へエクスポートする直前に、
// このアプリ側の簡易テクスチャ（.map）を一時的に取り外す。
// 理由：ここで焼き込んだ簡易テクスチャをそのままGLBに含めてしまうと、
// マンセル側で再度読み込んだ際に本来のシェーダー質感より優先されて表示されてしまうため。
// マンセル側へは「どの部位がどの質感か」だけを別途 sessionStorage で伝え、
// マンセル側自身の質感描画で正しく再構築してもらう。
// ==========================================================================
function stripPartTexturesForExport(root) {
    const restoreList = [];
    root.traverse(obj => {
        if (obj.isMesh && obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                if (m && m.userData && m.userData.isClonedPartMaterial && m.map) {
                    restoreList.push({ mat: m, map: m.map });
                    m.map = null;
                    m.needsUpdate = true;
                }
            });
        }
    });
    return () => {
        restoreList.forEach(({ mat, map }) => { mat.map = map; mat.needsUpdate = true; });
    };
}

function collectMaterialTextureHints() {
    const hints = {};
    AppState.buildingData.forEach(b => {
        if (!b.materialTextures) return;
        for (const partKey in b.materialTextures) {
            const texType = b.materialTextures[partKey];
            if (texType && texType !== 'none') {
                hints[`${b.id}__${partKey}`] = texType;
            }
        }
    });
    return hints;
}

function toggleMunsellSimulator(fromPortal = false) {
    const cesiumOverlay = document.getElementById('cesium-overlay');
    if (cesiumOverlay && cesiumOverlay.style.display === 'block') return;

    if (!isMunsellModeActive) {
        isMunsellModeActive = true;

        if (fromPortal) {
            // ★ ポータルからの起動時：現在のモデルのパッキングをスキップ
            sessionStorage.removeItem('munsell_custom_glb');
            sessionStorage.removeItem('munsell_initial_textures');
            openMunsellIframe(true);
        } else if (AppState.buildingData.length > 0) {
            houseGroup.traverse(child => {
                if (child.isMesh && child.material) {
                    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                    if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
                }
            });

            // ★追加：質感ヒントをマンセル側へ引き継ぐ（GLB本体には焼き込まない）
            sessionStorage.setItem('munsell_initial_textures', JSON.stringify(collectMaterialTextureHints()));

            const restoreTextures = stripPartTexturesForExport(houseGroup);
            const exporter = new GLTFExporter();
            exporter.parse(houseGroup, (glb) => {
                restoreTextures(); // ★このアプリ自身の表示には簡易テクスチャを戻す
                const blob = new Blob([glb], { type: 'application/octet-stream' });
                const glbUrl = URL.createObjectURL(blob);
                sessionStorage.setItem('munsell_custom_glb', glbUrl);
                openMunsellIframe(false);
            }, (err) => { restoreTextures(); console.error(err); }, { binary: true });
        } else {
            sessionStorage.removeItem('munsell_custom_glb');
            sessionStorage.removeItem('munsell_initial_textures');
            openMunsellIframe(false);
        }
    } else {
        window.closeMunsellSimulator();
    }
}

window.closeMunsellSimulator = function() {
    isMunsellModeActive = false;
    const iframe = document.getElementById('munsell-sim-iframe');
    
    // チュートリアルボタンを再表示
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';

    // ★修正：スライダーのグレーアウト（無効化）を解除して操作できるように戻します
    const sliderInner = document.querySelector('#app1-time-slider-container .slider-ui-inner');
    if (sliderInner) sliderInner.classList.remove('slider-disabled');

    const munsellBtn = document.getElementById('app1-munsell-btn');
    if (munsellBtn) {
        munsellBtn.classList.remove('active');
        // マンセル終了（モデリングモード）なので、次は着色モードへ行く案内を出す
        munsellBtn.setAttribute('data-tooltip', '🎨 着色モードへ');
    }
    
    if (iframe) {
        // ==========================================
        // ★追加：iframe内のカメラ状態を直接取得して、メインカメラに反映（帰りの同期）
        // ==========================================
        try {
            if (iframe.contentWindow && iframe.contentWindow.camera && iframe.contentWindow.controls) {
                const mCam = iframe.contentWindow.camera;
                const mCtrl = iframe.contentWindow.controls;
                // ★修正：子アプリ(m)から親アプリ(mm)への変換のため、1000倍にしてコピーします
                camera.position.copy(mCam.position).multiplyScalar(1000);
                controls.target.copy(mCtrl.target).multiplyScalar(1000);
                controls.update(); // 変更を適用
            }
        } catch (e) {
            console.warn('マンセル画面からのカメラ状態の復元に失敗しました', e);
        }

        const savedColors = sessionStorage.getItem('munsell_returned_colors');
        const savedTextures = sessionStorage.getItem('munsell_returned_textures');
        if (savedColors || savedTextures) {
            applyReturnedMunsellColors(
                savedColors ? JSON.parse(savedColors) : null,
                savedTextures ? JSON.parse(savedTextures) : null
            );
        }

        iframe.style.opacity = '0'; 
        setTimeout(() => {
            iframe.style.display = 'none';
            iframe.src = 'about:blank'; 
        }, 300);
    }
};

// サブアプリ(iframe)からのメッセージ送信を安全に受信するリスナー
window.addEventListener('message', (event) => {
    if (!event.data) return;

    // マンセル側から戻りデータが送られてきた時
    if (event.data.type === 'MUNSELL_RETURN') {
        const colorMap = event.data.colors;
        
        // 色情報がある場合はメイン側のマテリアルに反映
        if (colorMap) {
            applyReturnedMunsellColors(colorMap);
        }
        
        // 連携用関数を実行してiframeを安全に閉じる
        if (typeof window.closeMunsellSimulator === 'function') {
            window.closeMunsellSimulator();
        }
    }
});

/* ==========================================================================
   ★追加：ポータル画面・アプリ切り替え＆親「戻る」ボタン制御ロジック
   ========================================================================== */

/**
 * 3Dモデリング画面内の全表示オブジェクト（Canvas、UI、ViewManagerパーツ）の表示/非表示を切り替える
 */
function setMainAppVisibility(visible) {
    const displayVal = visible ? 'block' : 'none';
    const flexVal = visible ? 'flex' : 'none';
    
    // 1. Three.js Canvasの表示切り替え
    if (renderer && renderer.domElement) {
        renderer.domElement.style.display = displayVal;
    }
    
    // 2. モデリング画面の各種UIパネルを切り替え（要素が統合されたためスッキリします）
    const mainUiIds = [
        'status-panel',
        'main-toolbar',
        'app1-time-slider-container'
    ];
    mainUiIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            // スライダーコンテナも display: flex になったため flexVal で統一します
            el.style.display = visible ? flexVal : 'none';
        }
    });
    
    // 3. 画面上に散らばる lil-gui パネルをすべて隠す
    document.querySelectorAll('.lil-gui').forEach(gui => {
        gui.style.display = displayVal;
    });
    
    // 4. ViewManagerの分割線や方向表示用ラベルを一括切り替え
    if (ViewManager) {
        if (ViewManager.vLine) ViewManager.vLine.style.display = displayVal;
        if (ViewManager.hLines) {
            ViewManager.hLines.forEach(hl => hl.style.display = displayVal);
        }
        if (ViewManager.labels) {
            ViewManager.labels.forEach(lb => lb.style.display = displayVal);
        }
    }
    
    // 5. 画面が表示された瞬間にビューをフィットさせて再描画
    if (visible) {
        window.dispatchEvent(new Event('resize'));
        if (window.renderAllViews) window.renderAllViews();
    }
}

// ポータル用イベントの設定
document.addEventListener('DOMContentLoaded', () => {
    const portalScreen = document.getElementById('portal-screen');
    const btnBackToPortal = document.getElementById('btn-back-to-portal');
    const munsellBtn = document.getElementById('app1-munsell-btn');

    // パレットボタンからの起動（Eventオブジェクトの混入を防ぐためラップする）
    if (munsellBtn) {
        munsellBtn.addEventListener('click', () => {
            toggleMunsellSimulator(false);
        });
    }

    // ■ [3Dモデリング] タイル起動
    const portalBtnModeling = document.getElementById('portal-btn-modeling');
    if (portalBtnModeling) {
        portalBtnModeling.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            setMainAppVisibility(true);
        });
    }

    // ■ [マンセル値] タイル単独起動
    const portalBtnMunsell = document.getElementById('portal-btn-munsell');
    if (portalBtnMunsell) {
        portalBtnMunsell.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            
            sessionStorage.removeItem('munsell_custom_glb');
            toggleMunsellSimulator(true);
        });
    }

    // ■ [夜間景観] タイル単独起動
    const portalBtnNight = document.getElementById('portal-btn-night');
    if (portalBtnNight) {
        portalBtnNight.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            
            sessionStorage.removeItem('night_custom_glb');
            openNightSimulation(13.636, true);
            
            // 親アプリ側のスライダーを「夜間（一番右）」の位置にダミー移動
            const timeSlider = document.getElementById('app1-time-slider');
            if (timeSlider) {
                timeSlider.value = 100;
                timeSlider.dispatchEvent(new Event('input'));
            }
        });
    }

    // ■ 親画面で一括管理する「ポータルに戻る」ボタン
    if (btnBackToPortal) {
        btnBackToPortal.addEventListener('click', () => {
            if (isMunsellModeActive) {
                if (typeof window.closeMunsellSimulator === 'function') window.closeMunsellSimulator();
            }
            if (isNightModeActive) {
                if (typeof window.closeNightSimulation === 'function') window.closeNightSimulation();
            }
            
            setMainAppVisibility(false);
            UIController.clearGUI();
            UIController.hideFloatingMenu();
            
            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
            rebuildMeshes();
            
            portalScreen.style.display = 'flex';
            btnBackToPortal.style.display = 'none';
        });
    }

    // 初期起動時：メイン3D画面を非表示にしてポータル画面のみを表示した状態にする
    setMainAppVisibility(false);
});
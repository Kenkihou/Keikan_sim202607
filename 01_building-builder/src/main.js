// main.js
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { ModelingEngine } from './modelingEngine.js';
import { AppState } from './appState.js';
import { UIController } from './uiController.js';
import { InteractionHandler } from './interactionHandler.js';
import { ViewManager } from './viewManager.js';
import { AppInit } from './init.js';
import { TutorialManager } from './tutorialManager.js';
import { setOnTextureAssetsReady, SUGI_BOARD_WIDTH_M, SUGI_BOARD_HEIGHT_M } from './materialTextureFactory.js';
import { setupEarthPrefetchTriggers } from './earthPrefetch.js';
// ★追加：外構作図モード（tree/planner.html から移植した地面・囲い・外構・樹木の作図機能）
import { initExterior, toggleExterior, exitExterior, isExteriorActive,
         applyGhost as applyExteriorGhost, serializeExterior, restoreExterior,
         clearExterior, exteriorWorld,
         nameExteriorMaterials, mergeExteriorColors, restoreExteriorColors,
         getExteriorColors, EXT_MAT_PREFIX } from './exterior/index.js';

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

        const baseY = b.y || 0;
        // ★変更：窓・玄関の位置に実際の開口をくり抜いた本体ジオメトリを使う
        //   （建具を壁に貼り付けるのをやめ、開口に落とし込む納まりにしたため）
        //   グループ順・法線は BoxGeometry と同じなので、下の面別マテリアルと面選択はそのまま効く。
        const geo = ModelingEngine.buildBodyGeometry(b, baseY);

        // ★変更：側面(px/nx/pz/nz)は壁色、上面(top)は屋上専用色を使い、外壁と屋上を別々に着色できるようにする
        const mats = [wallMatB, wallMatB, roofTopMatB, wallMatB, wallMatB, wallMatB];
        if (b.id === AppState.selectedId && AppState.selectedFaceDir) {
            const fmap = { 'px':0, 'nx':1, 'top':2, 'bottom':3, 'pz':4, 'nz':5 };
            const idx = fmap[AppState.selectedFaceDir];
            if (idx !== undefined) mats[idx] = selectedMat;
        }

        const mesh = new THREE.Mesh(geo, mats);
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

        // ★変更：開口の見込み面（内側の筒）を壁と同じ色で仕上げるため wallMat を渡す
        const windowMaterials = { edgeMat: edgeMat, wallMat: wallMatB };
        const windowsGroup = ModelingEngine.buildWindows(b, baseY, windowMaterials);
        houseGroup.add(windowsGroup);

        const doorMaterials = { edgeMat: edgeMat, wallMat: wallMatB };
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

    // ★追加：外構作図モード中に建物を作り直したときは、半透明ゴーストを塗り直す
    //   （メッシュ・マテリアルは rebuild のたびに作り直されるため）
    applyExteriorGhost();

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
            // ★外構は建物とは別に持つ（下の applyExteriorMap で拾う）。ここでは飛ばす。
            if (matName.startsWith(EXT_MAT_PREFIX)) continue;

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

    // ★追加：外構（芝生・囲い・カーポート・樹木）の色。
    //   建物は「ブロックごと」に色を持つが、外構のマテリアルは地物の種類ごとの共有
    //   インスタンスなので、それを持っている exterior 側にまとめて覚えさせる
    //   （保存時は getExteriorColors で取り出す）。塗り直しも向こうがやる。
    const exteriorChanged = mergeExteriorColors(colorMap);

    if (changed) {
        AppState.saveState();
        UIController.updateActionButtons();
        rebuildMeshes();
    }
    if (changed || exteriorChanged) UIController.updateActionButtons();
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
// ★追加：外構（芝生・囲い・カーポートなど）の入れ物。子アプリ（夜間景観）が
//   「モデリング画面に中身があるか」を判定するのに使う
window.getExteriorWorld = function() { return exteriorWorld; };
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
// ★追加：外構作図モードの初期化
//   本体アプリのシーン・カメラ・レンダラーをそのまま貸して、その上に
//   外構専用のレイヤー（照明・作図用の目印・地物の入れ物）を足す。
//   ・単位は本体が mm、外構の地物は m。境界は src/exterior/core/viewer.js
//   ・スナップ量はツールバーの「📏」と共有する
// ==========================================
initExterior({
    scene, camera, renderer, controls, houseGroup,
    render: () => { if (window.renderAllViews) window.renderAllViews(); },
    getSnapMM: () => InteractionHandler.getSnap(),
    setBuildingLocked: (v) => InteractionHandler.setLocked(v),
});
window.toggleExterior = toggleExterior;

// ==========================================================================
// ★追加：子アプリ（夜間景観・マンセル値・地球モード）へ渡す GLB の書き出し対象。
//   建物（houseGroup）に加えて、外構（芝生・囲い・カーポート・樹木）も一緒に渡す。
//   GLTFExporter は Object3D の配列を受け取れるので、シーングラフを組み替えずに済む。
// ==========================================================================
function getExportRoots() {
    // 外構作図モード中は建物が半透明ゴーストのままなので、書き出す前にモードを閉じて
    // 元のマテリアルへ戻す（透けた建物が子アプリへ渡ってしまうのを防ぐ）
    if (isExteriorActive()) exitExterior();

    const hasExterior = exteriorWorld && exteriorWorld.children.length > 0;
    if (!hasExterior) return houseGroup;

    // 子アプリ側は「マテリアル名」で色を扱うので、外構にも名前を付ける。
    // ※ 建物側の `${ブロックID}__${部位}` 形式とは別物とわかるよう ext__ を頭に付ける
    //   （マンセル側から戻ってきた色を、建物用と外構用に振り分けるのに使う）
    // ⚠️ 以前はここで `ext_<uuidの先頭8桁>` を付けていたが、uuid はページを開き直すたびに
    //   変わるので、02 で塗った色を保存しても次に開いたとき対応先が分からなくなっていた。
    //   読み込み直しても同じになる名前の付け方は exterior/core/paint.js を参照。
    nameExteriorMaterials();

    return [houseGroup, exteriorWorld];
}

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

// ==========================================
// ★修正：画面サイズの追従
//   以前はカメラ操作（controls の change）でしか setSize していなかったため、
//   ウィンドウの大きさを変えてもキャンバスが古い寸法のままで、
//   画面の右端と下端が描画されない（切れて見える）状態になっていた。
//   → resize イベントで確実に合わせる。カメラ操作では再描画だけ行う。
//   ※ setMainAppVisibility はポータルから戻るときに resize を投げているので、
//     モードを行き来したあとのズレもこれで解消される。
// ==========================================
function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (window.renderAllViews) window.renderAllViews();
}
window.addEventListener('resize', handleResize);
handleResize();   // 起動直後の食い違いもここで解消しておく

controls.addEventListener('change', () => {
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
        clearExterior();          // ★追加：外構（芝生・フェンス・カーポートなど）も一緒に消す
        window.setTool(null);
        rebuildMeshes();
        UIController.hideFloatingMenu(); 
        UIController.updateStatusDisplay(InteractionHandler.getCurrentTool());
        UIController.updateActionButtons();
    }
};

// ---- PLATEAU 建物の編集（04 側の buildingedit.js）----------------------
//   ボタンの見た目だけこちらが持ち、実体は 04。👣（ストリートビュー）と同じ作法。
let isBuildingEditOn = false;
function applyBuildingEditButtonState() {
    const btn = document.getElementById('app1-buildingedit-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isBuildingEditOn);
    btn.setAttribute('data-tooltip',
        isBuildingEditOn ? '🏢 建物の編集を終わる' : '🏢 PLATEAU 建物を編集する');
}
(function setupApp1BuildingEditToggle() {
    const btn = document.getElementById('app1-buildingedit-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.toggleEarthBuildingEdit !== 'function') return;
        // ★ 先に他を終わらせる。あとから止めると、こちらのパネルまで
        //   一緒に畳まれてしまう場合がある。
        if (!isBuildingEditOn) stopOtherEarthModes('buildingedit');
        isBuildingEditOn = !!win.toggleEarthBuildingEdit();
        applyBuildingEditButtonState();
        updateBottomBar();
    });
    applyBuildingEditButtonState();
})();

// ==========================================
// 4. 地球モード（04_earth-simulator）への受け渡し
// ==========================================
// 既定の配置地点。京都駅前は高層の駅ビルに埋もれて自作モデルが見えないので、
// 開けていて分かりやすい市役所前広場を初期値にしている。
// （市役所の建物と重ならないよう、広場の中心から約30m南＝緯度 -0.00027°）
const DEFAULT_PLACE_LOCATION = { lat: 35.01129, lng: 135.76812 }; // 京都市役所前広場
window.lastPlacedLocation = { ...DEFAULT_PLACE_LOCATION };
window.lastPlacedHeading = 0; // ★追加：回転角度（ラジアン）の記憶用初期値

// ※ 地球モードの入口はツールバーのボタンから、下部パネルの「切り抜き」スライダーへ移した
//   （0 から動かすと起動する）。起動処理は openEarthSimulator。


// UIController初期化 ＆ 初回描画
UIController.init(rebuildMeshes, window.setTool);
if (window.renderAllViews) window.renderAllViews();

// ==========================================
// ★追加：JSONセーブ・ロード機能の実装
// ==========================================

// 地球モード（04）の検討内容を iframe から受け取る。
//   04 と 01 は同一オリジンなので、あちらが用意した window.getEarthEditState() を
//   そのまま呼べる（postMessage を待つ必要がない＝セーブを同期処理のままにできる）。
//   ⚠️ 地球モードを一度も開いていない／古い 04 が入っている場合もあるので、
//     取れなければ黙って null にする。ここでセーブ自体を失敗させてはいけない。
function readEarthState() {
    try {
        const frame = document.getElementById('earth-sim-iframe');
        if (!frame) return null;   // 地球モードを一度も開いていない＝残すものが無い
        const fn = frame.contentWindow && frame.contentWindow.getEarthEditState;
        if (typeof fn !== 'function') {
            // ⚠️ ここに来るのは、受け渡し口ができる前に作られた iframe が生き残っている場合。
            //   地球モードは「閉じても iframe を捨てずに隠すだけ」なので（タイルの読み直しを
            //   避けるため）、04 を更新しても開きっぱなしの iframe は古いままになる。
            //   黙って null にすると「何も保存されない」ようにしか見えないので、必ず知らせる。
            console.warn('地球モード側に受け渡し口（getEarthEditState）がありません。'
                + 'ページを再読み込みしてから地球モードを開き直してください。');
            return null;
        }
        return fn() || null;
    } catch (e) {
        console.warn('地球モードの検討内容を取得できませんでした', e);
        return null;
    }
}

// ロードで読み込んだ地球モードの検討内容の控え。
//   ⚠️ ロード時点では地球モードがまだ開かれていないことの方が多く、開いていても
//     タイルの読み込みが終わっていない。すぐ送っても当てる先が無いので、ここへ
//     預けておき「地球側の準備ができた」合図（showEarthSimulator）で送る。
let pendingEarthState = null;
// 送り済みかどうか。開き直すたびに送り直さないための目印。
let earthStateApplied = true;

// 控えてある検討内容を地球モードへ送る。まだ開いていなければ何もしない。
function pushEarthState() {
    if (earthStateApplied) return;
    const frame = document.getElementById('earth-sim-iframe');
    const fn = frame && frame.contentWindow && frame.contentWindow.applyEarthEditState;
    if (typeof fn !== 'function') return;   // まだ準備できていない。次の機会に送る
    try {
        fn(pendingEarthState);
        earthStateApplied = true;
    } catch (e) {
        console.warn('地球モードへ検討内容を反映できませんでした', e);
    }
}

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
        // ※ キー名 cesiumState は旧・地球モード（Cesium）時代のもの。中身は今の地球モードでも
        //   そのまま使う（配置地点と向き）ので、既存のセーブデータを読めるよう名前は変えない。
        cesiumState: {
            lastPlacedLocation: window.lastPlacedLocation,
            lastPlacedHeading: window.lastPlacedHeading // 地球上でのモデルの回転角度
        },
        // ★追加：外構（地面・囲い・外構・樹木）の配置。地物の種類・位置(m)・寸法パラメータだけを持つ
        exteriorState: {
            items: serializeExterior(),
            // ★追加：02 で塗った外構の色（マテリアル名 → #rrggbb）。
            //   地物ごとではなく種類ごとの共有マテリアルなので、配置とは別に1つのマップで持つ。
            colors: getExteriorColors()
        },
        // ★追加：地球モード（04）での検討内容。
        //   PLATEAU 建物の高さ変更・壁面後退・置いた箱を、緯度経度付きで残す。
        //   地球モードを開いていなければ null（キーは残す＝あとから読む側の分岐が減る）。
        earthState: readEarthState()
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
    // 地球モードの表示中は誤動作を防ぐため実行させない
    if (isEarthModeActive) {
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
                window.lastPlacedLocation = { ...DEFAULT_PLACE_LOCATION };
                window.lastPlacedHeading = 0;
            }

            // ★追加：3. 外構の復元（含まれない古いデータなら空にする）
            restoreExterior(json.exteriorState && json.exteriorState.items);
            // ★追加：外構の色も戻す。地物を組み立て終わってから当てること
            //   （マテリアルは地物を作った時点で生まれるため、順序を逆にすると当たらない）。
            restoreExteriorColors(json.exteriorState && json.exteriorState.colors);

            // ★追加：5. 地球モード（04）の検討内容。
            //   含まれない古いデータなら null＝地球モード側もまっさらに戻す。
            pendingEarthState = json.earthState || null;
            earthStateApplied = false;
            pushEarthState();   // すでに地球モードが立ち上がっていればその場で当たる

            // 4. 各種3DメッシュとUIパネルの同期・再描画
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

// 時刻スライダーで 09:00 に当たる位置[%]（この位置から夜間シミュレーターが動き出す）
const NIGHT_START_PCT = 13.636;

// スライダーを 0（＝そのモードの終了）まで下げてよいか。単独起動中だけ false になる。
//   ⚠️ 下のスライダー初期化（updateSliderUI）が読むので、必ずそれより前で宣言すること。
let clipSliderZeroAllowed = true;
let timeSliderZeroAllowed = true;

function openNightSimulation(initialSliderPct = NIGHT_START_PCT, fromPortal = false) {
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
    document.body.classList.add('night-mode');
    updateBottomBar();   // 地球モードの切り抜きスライダーを止める

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
        // ★通常（モデリング画面）から起動時は現在のモデルをパッキング（外構も含む）
        const exporter = new GLTFExporter();
        exporter.parse(getExportRoots(), (glb) => {
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
    document.body.classList.remove('night-mode');
    updateBottomBar();

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
    setNightLamp(false);   // 🌃ランプも消す（ここは input を発火させないので手で戻す）
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
        
        // ★夜間シミュレーターの単独起動中は「陰影なし(0)」に戻せない（終了させないため）。
        //   0 の側へ寄せても 09:00 の位置に吸い付かせる。
        if (!timeSliderZeroAllowed && pct < NIGHT_START_PCT) {
            pct = NIGHT_START_PCT;
            timeSlider.value = pct;
        }
        // ★アプリ2と同様のスナップ処理（カクっと動かす）
        else if (pct > 0 && pct < 13.636) {
            pct = pct < 6.818 ? 0 : 13.636;
            timeSlider.value = pct;
        }
        else if (pct > 86.364 && pct < 100) {
            pct = pct < 93.182 ? 86.364 : 100;
            timeSlider.value = pct;
        }

        // 左端の🌃ランプ：スライダーが 0 から動いている＝夜間シミュレーターが動いている
        setNightLamp(pct > 0);

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

    // ★左端の🌃ボタンでオンオフする（スライダーの近道）。
    //   起動・終了・ランプ・時刻表示の判定はすべて updateSliderUI が持っているので、
    //   ここではスライダーの値を動かして同じ処理へ流すだけにする（判定を二重に書かない）。
    //   ・オフ（0）→ 09:00 の位置（＝夜間シミュレーターが起動する最初の位置）へ
    //   ・オン（0より右）→ 0（陰影なし）へ戻して終了
    //   ※ 夜間シミュレーターの単独起動中は 0 に戻せない決まりだが、その差し戻しも
    //     updateSliderUI が行うので、ここで気にする必要はない。
    const nightBtn = document.getElementById('app1-night-lamp');
    if (nightBtn) {
        nightBtn.addEventListener('click', () => {
            timeSlider.value = parseFloat(timeSlider.value) > 0 ? 0 : NIGHT_START_PCT;
            updateSliderUI();
        });
    }

    // 初期化 (アプリ2に合わせて 0% 陰影なしスタート)
    timeSlider.value = 0;
    updateSliderUI();
})();

// 切り抜きスライダーの上限（500＝04側の CLIP_SIZE_MAX）を超えた1段分＝「全体表示」を表す値。
//   04 側（js/ui.js の setClipSizeFromParent）も、箱の上限を超える値が来たら
//   同じ意味（全体表示＝切り抜きなし）に解釈するようにしてある。変えるなら両方直すこと。
const APP1_CLIP_MAX_SIZE = 500, APP1_CLIP_FULL_SIZE = 550;
// 切り抜きの下限（＝地球モードをオンにしたときの最初の大きさ）。🌐ボタンでオンにするときも
// スライダーをここへ動かす。
const APP1_CLIP_MIN_SIZE = 50;

// ==========================================
// ★追加：地球モードの「切り抜き」スライダー（時刻スライダーの右隣）
//   0＝地球モードなし。50m以上に動かすと地球モードが起動し、その大きさで中心を切り抜く。
//   起動中に動かせば、そのまま地球側へ大きさを送る（時刻スライダーと同じ作法）。
// ==========================================
(function setupApp1ClipSlider() {
    const slider = document.getElementById('app1-clip-slider');
    const display = document.getElementById('app1-clip-display');
    const ticks = document.getElementById('app1-clip-ticks');
    if (!slider) return;

    // 04 側の切り抜き（50〜500m・10m刻み）に合わせる。0 だけが「地球モードなし」。
    const MIN_SIZE = APP1_CLIP_MIN_SIZE, MAX_SIZE = APP1_CLIP_MAX_SIZE, FULL_SIZE = APP1_CLIP_FULL_SIZE, TICK_STEP = 50;

    // 目盛り（0・50・…・500）＋ 最後にもう1つ、全体表示の目印（太い目盛り）
    if (ticks) {
        for (let v = 0; v <= MAX_SIZE; v += TICK_STEP) {
            const tick = document.createElement('div');
            tick.className = 'tick';
            tick.style.left = `${(v / FULL_SIZE) * 100}%`;
            ticks.appendChild(tick);
        }
        const fullTick = document.createElement('div');
        fullTick.className = 'tick full';
        fullTick.style.left = '100%';
        ticks.appendChild(fullTick);
    }

    function sendSizeToEarth(size) {
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (win && typeof win.setEarthClipSize === 'function') win.setEarthClipSize(size);
    }

    function onSliderInput() {
        let raw = Number(slider.value);
        // 500 を超えたところを触った瞬間に、中間値を作らず最後（全体表示）へカクッと
        // 吸い付かせる。50刻みの続きのような曖昧な位置を作らないための処置。
        if (raw > MAX_SIZE) {
            raw = FULL_SIZE;
            slider.value = String(raw);
        }
        let size = raw;
        // 0 の次は 50m（04 の切り抜きの下限）。間の値はつまみごと 50 に吸い付かせて、
        // 目盛りの位置と実際の大きさが食い違わないようにする。
        // ★地球モードの単独起動中は 0（終了）も許さないので、0 まで下げても 50 に戻す。
        const floor = clipSliderZeroAllowed ? 0 : MIN_SIZE;
        if (size < MIN_SIZE && (size > 0 || floor === MIN_SIZE)) {
            size = MIN_SIZE;
            slider.value = String(size);
        }
        updateClipPanelDisplay(size);

        if (size === 0) {
            // 0 に戻したら地球モードを終了（時刻スライダーを「陰影なし」に戻すのと同じ）
            if (isEarthModeActive && typeof window.closeEarthSimulator === 'function') {
                window.closeEarthSimulator();
            }
            return;
        }

        if (!isEarthModeActive) {
            pendingEarthClipSize = size;   // 準備ができ次第送る
            openEarthSimulator(false);
        } else {
            sendSizeToEarth(size);
        }
    }

    slider.addEventListener('input', onSliderInput);

    // ★左端の🌐ボタンでオンオフする（時刻パネルの🌃と同じ作法）。
    //   起動・終了・大きさの送信はすべて onSliderInput が持っているので、ここでは
    //   スライダーの値を動かして同じ処理へ流すだけにする。
    //   ・オフ（0）→ 50m（切り抜きの下限＝地球モードが起動する最初の大きさ）へ
    //   ・オン（0より右）→ 0（地球なし）へ戻して終了
    //   ※ 地球モードの単独起動中は 0 に戻せない決まりだが、その差し戻しは onSliderInput が行う。
    const earthBtn = document.getElementById('app1-earth-lamp');
    if (earthBtn) {
        earthBtn.addEventListener('click', () => {
            slider.value = Number(slider.value) > 0 ? '0' : String(MIN_SIZE);
            onSliderInput();
        });
    }

    slider.value = '0';
    updateClipPanelDisplay(0);
})();

// ==========================================
// ★追加：東西30km断面のオン・オフ（切り抜きスライダーの右のボタン）
//   地球モード中だけ押せる。地球側の表示状態を持ち主とし、こちらはボタンの見た目を
//   合わせるだけ（地球側が実際に開いたときに getEarthProfileOn() で現在値を取りに行く）。
// ==========================================
let isProfileOn = false;
// 地球側で断面を閉じたとき（パネルの「×」など、こちらのボタンを経由しない操作）に
// ボタンの見た目だけ合わせる。window.syncEarthClipSize と同じ作法。
window.syncEarthProfileOn = function(on) {
    isProfileOn = !!on;
    applyProfileButtonState();
};
function applyProfileButtonState() {
    const btn = document.getElementById('app1-profile-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isProfileOn);
    btn.setAttribute('data-tooltip', isProfileOn ? '断面を非表示にする' : '東西断面を表示する');
}
// ⛰ 地形断面 / 👣 ストリートビュー / 🏢 建物編集 は【同時には使わない】。
//   どれかを始めたら、他は終わらせる。
//   ⚠️ 3つとも「地球モードの上に別の見せ方を重ねる」道具で、重ねると
//     どのモードにいるのか分からなくなる（断面を見ながら建物を選ぼうとして
//     選べない、といった行き違いが起きる）。
//   except に「これから始めるもの」を渡す。
function stopOtherEarthModes(except) {
    const iframe = document.getElementById('earth-sim-iframe');
    const win = iframe && iframe.contentWindow;
    if (!win) return;
    if (except !== 'profile' && isProfileOn && typeof win.setEarthProfileOn === 'function') {
        isProfileOn = false;
        win.setEarthProfileOn(false);
        applyProfileButtonState();
    }
    if (except !== 'buildingedit' && isBuildingEditOn
        && typeof win.toggleEarthBuildingEdit === 'function') {
        win.toggleEarthBuildingEdit();          // ON のときに呼べば OFF になる
        isBuildingEditOn = false;
        applyBuildingEditButtonState();
    }
    if (except !== 'streetview' && isStreetViewOn
        && typeof win.toggleEarthStreetView === 'function') {
        isStreetViewOn = !!win.toggleEarthStreetView();
        if (!isStreetViewOn) restoreClipSizeAfterStreetView();
        applyStreetViewButtonState();
    }
    updateBottomBar();
}

(function setupApp1ProfileToggle() {
    const btn = document.getElementById('app1-profile-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない（膜で押せなくもしてある）
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.setEarthProfileOn !== 'function') return;
        isProfileOn = !isProfileOn;
        if (isProfileOn) stopOtherEarthModes('profile');
        win.setEarthProfileOn(isProfileOn);
        applyProfileButtonState();
        updateBottomBar();
    });
    applyProfileButtonState();
})();

// ==========================================
// ★追加：ストリートビュー（道路に降りて歩く）のボタン。地形断面ボタンの右隣。
//   実体は 04 側の js/streetview.js。こちらはボタンの見た目と呼び出しだけを持つ
//   （地形断面の app1-profile-toggle と同じ作法）。
// ==========================================
let isStreetViewOn = false;
// ストリートビューに入る直前の切り抜きの大きさ（抜けるときに戻す）
let clipSizeBeforeStreetView = null;
function restoreClipSizeAfterStreetView() {
    const cs = document.getElementById('app1-clip-slider');
    if (!cs || clipSizeBeforeStreetView === null) return;
    if (cs.value !== clipSizeBeforeStreetView) {
        cs.value = clipSizeBeforeStreetView;
        cs.dispatchEvent(new Event('input', { bubbles: true }));
    }
    clipSizeBeforeStreetView = null;
}
// 04 側で Esc で抜けたとき（こちらのボタンを経由しない操作）に見た目だけ合わせる
window.syncEarthStreetView = function(on) {
    isStreetViewOn = !!on;
    if (!isStreetViewOn) restoreClipSizeAfterStreetView();
    applyStreetViewButtonState();
    updateBottomBar();
};
function applyStreetViewButtonState() {
    const btn = document.getElementById('app1-streetview-toggle');
    if (!btn) return;
    btn.classList.toggle('active', isStreetViewOn);
    btn.setAttribute('data-tooltip', isStreetViewOn ? '👣 ストリートビューを終わる' : '👣 道路に降りて歩く');
}
(function setupApp1StreetViewToggle() {
    const btn = document.getElementById('app1-streetview-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isEarthModeActive) return;   // 地球モード以外では意味がない
        const iframe = document.getElementById('earth-sim-iframe');
        const win = iframe && iframe.contentWindow;
        if (!win || typeof win.toggleEarthStreetView !== 'function') return;
        // ★入るときは箱庭をやめて全体表示にする。
        //   切り抜きの箱が小さいと、その外の道路には降りられず歩いても壁で止まるため。
        //   入る前の大きさを覚えておいて、抜けるときに戻す。
        if (!isStreetViewOn) {
            stopOtherEarthModes('streetview');
            const cs = document.getElementById('app1-clip-slider');
            if (cs) {
                clipSizeBeforeStreetView = cs.value;
                if (Number(cs.value) !== APP1_CLIP_FULL_SIZE) {
                    cs.value = String(APP1_CLIP_FULL_SIZE);
                    cs.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
        isStreetViewOn = !!win.toggleEarthStreetView();
        if (!isStreetViewOn) restoreClipSizeAfterStreetView();
        applyStreetViewButtonState();
        updateBottomBar();   // スライダーと断面ボタンの膜を掛け外しする
    });
    applyStreetViewButtonState();
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
    if (isEarthModeActive) return;   // 地球モード表示中は着色モードへ入らせない

    if (!isMunsellModeActive) {
        isMunsellModeActive = true;
        updateBottomBar();

        if (fromPortal) {
            // ★ ポータルからの起動時：現在のモデルのパッキングをスキップ
            sessionStorage.removeItem('munsell_custom_glb');
            sessionStorage.removeItem('munsell_initial_textures');
            openMunsellIframe(true);
        // ★変更：建物が無くても外構だけ置かれていれば書き出す
        } else if (AppState.buildingData.length > 0 || exteriorWorld.children.length > 0) {
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
            exporter.parse(getExportRoots(), (glb) => {
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
    updateBottomBar();
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

// ==========================================
// ★追加：地球シミュレーター（04_earth-simulator）連携
//   PLATEAUの街並み・地形の上に、このアプリで作った建物を置いて確認する。
//   マンセル・夜間と同じく全画面 iframe で重ねる方式。GLBの受け渡しも同じ流儀
//   （sessionStorage に blob URL を入れる）。
//   ※ 置く場所は地球側の地図で選ぶ。選んだ地点と向きは戻ってきたときに引き継ぐ。
// ==========================================
let isEarthModeActive = false;
// 切り抜きスライダーから起動したときに、地球側の準備ができ次第この大きさを送る
let pendingEarthClipSize = null;

function openEarthSimulator(fromPortal = false) {
    if (isEarthModeActive) return;
    isEarthModeActive = true;
    updateBottomBar();

    // 起動中はモデリング画面側のUIを隠す。時刻スライダーは iframe より前面に出るので、
    // 中身を無効化するだけでは足りず、コンテナごと隠す（CSSの body.earth-mode）。
    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = 'none';
    document.body.classList.add('earth-mode');

    // 前回の向き・配置地点を地球側へ引き継ぐ
    sessionStorage.setItem('earth_model_heading', String(window.lastPlacedHeading || 0));
    if (window.lastPlacedLocation) {
        sessionStorage.setItem('earth_focus_latlon', JSON.stringify(window.lastPlacedLocation));
    }

    // 前回渡したGLBを解放する（地球画面を閉じずに残す作りなので、切り替えのたびに溜まる）
    const prevGlb = sessionStorage.getItem('earth_custom_glb');
    if (prevGlb && prevGlb.startsWith('blob:')) URL.revokeObjectURL(prevGlb);

    // ★変更：建物が無くても外構だけ置かれていれば、それを持って地球へ行く
    if (fromPortal || (AppState.buildingData.length === 0 && exteriorWorld.children.length === 0)) {
        // ポータルからの単独起動（またはモデルが無いとき）は街並みだけを表示する
        sessionStorage.removeItem('earth_custom_glb');
        sessionStorage.removeItem('earth_camera_state');
        proceedOpenEarthIframe(fromPortal);
    } else {
        // ★モデリング画面の見え方をそのまま引き継ぐためのカメラ状態（mm・モデル原点基準）。
        //   地球側でモデルを置いた位置・向きに合わせて変換される（02/03 と同じ考え方）。
        sessionStorage.setItem('earth_camera_state', JSON.stringify({
            position: camera.position.toArray(),
            target: controls.target.toArray(),
            fov: camera.fov,
        }));
        houseGroup.traverse(child => {
            if (child.isMesh && child.material) {
                const mat = Array.isArray(child.material) ? child.material[0] : child.material;
                if (!mat.name) mat.name = 'mat_' + mat.uuid.substring(0, 8);
            }
        });
        const exporter = new GLTFExporter();
        exporter.parse(getExportRoots(), (glb) => {
            const blob = new Blob([glb], { type: 'application/octet-stream' });
            sessionStorage.setItem('earth_custom_glb', URL.createObjectURL(blob));
            proceedOpenEarthIframe(fromPortal);
        }, (err) => {
            console.error(err);
            sessionStorage.removeItem('earth_custom_glb');
            proceedOpenEarthIframe(fromPortal);
        }, { binary: true });
    }
}

let earthRevealTimer = null;

function proceedOpenEarthIframe(fromPortal) {
    let iframe = document.getElementById('earth-sim-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'earth-sim-iframe';
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

    iframe.style.visibility = 'visible';
    iframe.style.pointerEvents = '';
    iframe.style.display = 'block';
    iframe.style.opacity = '0';

    // ★ 2回目以降：前回の地球画面をそのまま生かしてある（タイルも地形も読み込み済み）。
    //   ページを読み直さず、待機を解除してモデルだけ入れ替える＝街並みの再読み込みが起きない。
    const win = iframe.contentWindow;
    if (win && typeof win.resumeEarthSimulator === 'function') {
        win.resumeEarthSimulator({ from: fromPortal ? 'portal' : 'modeling' });
        clearTimeout(earthRevealTimer);
        earthRevealTimer = setTimeout(() => window.showEarthSimulator(), 5000);
        return;
    }

    const urlParam = fromPortal ? '?from=portal' : '?from=modeling';
    iframe.src = `./earth-api/${urlParam}`;

    // ★すぐには出さない。地球側が「モデルを置いてカメラを合わせた」と知らせてきてから
    //   フェードインする（夜間シミュレーターの showNightSimulation と同じ作法）。
    //   こうするとモデリング画面の絵から地続きで切り替わり、暗いだけの画面が挟まらない。
    //   万一あちらが知らせてこなくても取り残されないよう、保険のタイマーも仕掛ける。
    clearTimeout(earthRevealTimer);
    earthRevealTimer = setTimeout(() => window.showEarthSimulator(), 5000);
}

// 地球側から「描画準備ができた」合図を受け取って表示する
window.showEarthSimulator = function() {
    clearTimeout(earthRevealTimer);
    const iframe = document.getElementById('earth-sim-iframe');
    if (!iframe || !isEarthModeActive) return;
    iframe.style.opacity = '1';

    // ★追加：ロードで読み込んだ検討内容が控えてあれば、ここで当てる
    pushEarthState();

    // 切り抜きの大きさを合わせる。スライダーから起動したならその値を送り、
    // それ以外（🌍ボタンやポータル）なら地球側の現在値をこちらのスライダーに映す。
    const win = iframe.contentWindow;
    if (pendingEarthClipSize && win && typeof win.setEarthClipSize === 'function') {
        win.setEarthClipSize(pendingEarthClipSize);
        window.syncEarthClipSize(pendingEarthClipSize);
    } else if (win && typeof win.getEarthClipSize === 'function') {
        window.syncEarthClipSize(win.getEarthClipSize());
    }
    pendingEarthClipSize = null;

    // 断面（30km東西縦断図）のオン・オフも、地球側の現在値にボタンを合わせる
    // （前回開いたときの状態を隠して待機させているだけなので、消えているとは限らない）。
    if (win && typeof win.getEarthProfileOn === 'function') {
        isProfileOn = !!win.getEarthProfileOn();
        applyProfileButtonState();
    }
};

// パネル左端の表示灯を点けたり消したりする。
// ランプの点灯＝そのモードが動いている状態。ホバー時の説明も状態に合わせて入れ替える
// （🎨ボタンが「着色モードへ」⇄「モデリングモードへ」と変わるのと同じ考え方）。
function setPanelLamp(id, on, offText, onText) {
    const lamp = document.getElementById(id);
    if (!lamp) return;
    lamp.classList.toggle('active', on);
    lamp.setAttribute('data-tooltip', on ? onText : offText);
}

function setNightLamp(on) {
    setPanelLamp('app1-night-lamp', on,
        '🌃 夜間景観モードにする',
        '🌃 夜間景観モードを終了する');
}

// 切り抜きパネルの表示（大きさのラベルと、左端の🌐ランプ）をまとめて更新する。
function updateClipPanelDisplay(size) {
    const display = document.getElementById('app1-clip-display');
    const v = Number(size) || 0;
    // ★中央の表示は短くする（「250 m 四方」だと左の「地球なし」と重なるため）。
    //   0 のときは何も出さない（左端の「地球なし」が状態を示している）。
    //   全体表示（550）のときも同じ理由で「全体」とだけ出す（右端の固定ラベルと同じ表記）。
    if (display) display.textContent = v === 0 ? '' : (v > APP1_CLIP_MAX_SIZE ? '全体' : `${v}m`);
    setPanelLamp('app1-earth-lamp', v > 0,
        '🌐 地球モードにする',
        '🌐 地球モードを終了する');
}

// 地球側のHUDで切り抜きが変わったときに、こちらのスライダーの位置だけ合わせる
// （input を発火させない＝ここから起動・終了の判定は走らせない）
window.syncEarthClipSize = function(size) {
    const slider = document.getElementById('app1-clip-slider');
    if (!slider) return;
    const v = Number(size) || 0;
    slider.value = String(v);
    updateClipPanelDisplay(v);
};

// 地球側の「モデリング画面に戻る」ボタンから呼ばれる（同一オリジンなので直接呼べる）
window.closeEarthSimulator = function() {
    isEarthModeActive = false;
    updateBottomBar();
    applyProfileButtonState();   // ボタンの表示（active/tooltip）を非地球モードの状態に戻す
    isStreetViewOn = false;
    applyStreetViewButtonState();
    isBuildingEditOn = false;
    applyBuildingEditButtonState();

    // 地球側で決めた向き・配置地点を受け取り、セーブデータに残るようにする
    const heading = parseFloat(sessionStorage.getItem('earth_model_heading'));
    if (Number.isFinite(heading)) window.lastPlacedHeading = heading;
    try {
        const loc = JSON.parse(sessionStorage.getItem('earth_focus_latlon') || 'null');
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            window.lastPlacedLocation = loc;
        }
    } catch (e) {
        console.warn('地球側から配置地点を受け取れませんでした', e);
    }

    // ★地球側で見ていたアングルを引き継ぐ（あちらが mm・モデル原点基準に戻して預けている）
    try {
        const camState = JSON.parse(sessionStorage.getItem('earth_camera_state') || 'null');
        if (camState && Array.isArray(camState.position) && Array.isArray(camState.target)) {
            camera.position.fromArray(camState.position);
            controls.target.fromArray(camState.target);
            controls.update();
            if (window.renderAllViews) window.renderAllViews();
        }
    } catch (e) {
        console.warn('地球側からカメラ状態を受け取れませんでした', e);
    }

    const tutorialBtn = document.getElementById('btn-start-tutorial');
    if (tutorialBtn) tutorialBtn.style.display = '';
    document.body.classList.remove('earth-mode');

    // 切り抜きスライダーを 0（地球なし）に戻す。時刻スライダーの戻し方と同じ考え方。
    pendingEarthClipSize = null;
    window.syncEarthClipSize(0);

    // ★ 破棄せずに隠すだけにする。読み込み済みのPLATEAUタイル・地形を抱えたまま
    //   待機させておけば、次に開いたときは一瞬で戻る（src を捨てると全部やり直しになる）。
    //   ・visibility:hidden … 見えず触れず、それでいて iframe の大きさは保たれる
    //     （display:none にすると中の画面サイズが 0 になり、再開時にカメラの比率が崩れる）
    //   ・描画ループは地球側の pauseEarthSimulator() で止めてもらう（CPUを食わせない）
    const iframe = document.getElementById('earth-sim-iframe');
    if (iframe) {
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        setTimeout(() => {
            if (isEarthModeActive) return;   // 待っている間に開き直されたら何もしない
            iframe.style.visibility = 'hidden';
            const win = iframe.contentWindow;
            if (win && typeof win.pauseEarthSimulator === 'function') win.pauseEarthSimulator();
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
   ★追加：下部の操作バー（時刻スライダー／🎨／地球の切り抜きスライダー）の共通制御

   このバーは【01〜04 のどれを開いていても同じ位置に居る】。サブアプリ（02〜04）は
   全画面 iframe で上に重なるだけなので、バーを親が出しっぱなしにしておけば
   位置は自動的に完全一致する（各アプリに複製を置くと必ずズレるので置かない）。

   そのうえで「今のモードでは使えない操作」を半透明の膜で塞ぐ（.locked）。

     モデリング   … 全部使える
     マンセル     … 時刻・切り抜きを塞ぐ（🎨はモデリングへ戻る操作なので生かす。
                    ただしポータルから単独で開いたときは戻り先が無いので塞ぐ）
     夜間         … 🎨・切り抜きを塞ぐ（時刻スライダーが操作子）
     地球         … 時刻・🎨を塞ぐ（切り抜きスライダーが操作子）
   ========================================================================== */
function setBottomBarVisible(visible) {
    ['app1-time-slider-container', 'app1-clip-slider-container'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? 'flex' : 'none';
    });
}

function updateBottomBar() {
    // variant は膜の大きさの指定（'locked-slider' / 'locked-btn' / 省略＝要素そのまま）
    const lock = (id, on, variant) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('locked', on);
        if (variant) el.classList.toggle(variant, on);
    };
    const timeLocked = isEarthModeActive || isMunsellModeActive;
    const clipLocked = isNightModeActive || isMunsellModeActive;
    // 🎨はマンセルの入り口／出口。モデリングから開いたときだけ「戻る」操作として生かす。
    const munsellLocked = isEarthModeActive || isNightModeActive ||
                          (isMunsellModeActive && isPortalLaunch);

    lock('app1-time-slider-group', timeLocked, 'locked-slider');
    // 🌃表示灯（夜間シミュレーターへの入口の案内）もスライダーと同じ条件で塞ぐ。
    //   ★ これが無いと、時刻スライダーが塞がっている間（マンセルモード中など）でも
    //     表示灯だけはホバーできてしまい、「動かすと夜間モードへ」というツールチップが
    //     出てしまう（実際には動かせないのに、という食い違いになる）。
    //     .locked は pointer-events:none も兼ねるので、これを付けるだけでツールチップも
    //     自然に出なくなる（ホバー自体が起きないため）。
    lock('app1-night-lamp', timeLocked, 'locked-btn');
    lock('app1-munsell-btn', munsellLocked, 'locked-btn');
    lock('app1-clip-slider-container', clipLocked);   // こちらはパネルごと塞ぐ
    // 断面ボタンは「地球モードが動いていない間」も塞ぐ（切り抜きスライダー自体は
    // 塞がれていなくても、地球モードに入る前は断面を開いても意味がないため）。
    // ★ストリートビュー中は切り抜きスライダーと断面ボタンを塞ぐ。
    //   歩いている間に箱庭へ戻されると、道路が箱の外に出て動けなくなるため。
    //   👣だけは塞がない（これが唯一の出口になる）。
    lock('app1-clip-slider-group', isStreetViewOn, 'locked-slider');
    // 🌐（地球モードの入口／出口）を塞ぐ条件。
    //   ・ストリートビュー中 … 先にストビューを抜けさせる（歩いている最中に地球モードごと
    //     畳まれると、キャラクターも道路も消えたまま操作だけ残る）。
    //   ・ポータルから地球モードを単独起動したとき … 戻る先が無いので終了させない
    //     （切り抜きスライダーを 0 に戻せない clipSliderZeroAllowed と対になる扱い）。
    lock('app1-earth-lamp',
         clipLocked || isStreetViewOn || (isEarthModeActive && isPortalLaunch),
         'locked-btn');
    lock('app1-profile-toggle', !isEarthModeActive || clipLocked || isStreetViewOn, 'locked-btn');
    lock('app1-streetview-toggle', !isEarthModeActive || clipLocked, 'locked-btn');
    lock('app1-buildingedit-toggle',
         !isEarthModeActive || clipLocked || isStreetViewOn, 'locked-btn');

    // ★単独起動（ポータルのタイルから直接開いた）中は、スライダーを 0 まで下げて
    //   そのシミュレーターを終了できないようにする。モデリング画面から開いたときは
    //   0 に戻せばモデリングへ帰れるが、単独起動では帰り先が無く、
    //   何も無い画面が残ってしまうため（終了は「ポータルに戻る」ボタン）。
    clipSliderZeroAllowed = !(isEarthModeActive && isPortalLaunch);
    timeSliderZeroAllowed = !(isNightModeActive && isPortalLaunch);
}

// ポータルのタイルから直接サブアプリを起動したか（＝モデリング画面を経由していないか）
let isPortalLaunch = false;

/* ==========================================================================
   ★追加：ポータル画面・アプリ切り替え＆親「戻る」ボタン制御ロジック
   ========================================================================== */

/**
 * 3Dモデリング画面内の全表示オブジェクト（Canvas、UI、ViewManagerパーツ）の表示/非表示を切り替える
 */
function setMainAppVisibility(visible) {
    const displayVal = visible ? 'block' : 'none';
    const flexVal = visible ? 'flex' : 'none';

    // ★追加：他のシミュレーターやポータルへ移る前に外構作図モードを閉じる
    //   （建物のゴースト表示と外構パネルを出しっぱなしにしないため）
    if (!visible && isExteriorActive()) exitExterior();

    // 1. Three.js Canvasの表示切り替え
    if (renderer && renderer.domElement) {
        renderer.domElement.style.display = displayVal;
    }
    
    // 2. モデリング画面の各種UIパネルを切り替え（要素が統合されたためスッキリします）
    //    ※ 下部の操作バー（時刻・🎨・切り抜き）はここでは扱わない。
    //      あれはサブアプリを開いている間も出しっぱなしにするので、
    //      setBottomBarVisible / updateBottomBar が別に面倒を見る。
    const mainUiIds = [
        'status-panel',
        'main-toolbar'
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
            isPortalLaunch = false;
            setMainAppVisibility(true);
            setBottomBarVisible(true);
            updateBottomBar();
        });
    }

    // ■ [マンセル値] タイル単独起動
    const portalBtnMunsell = document.getElementById('portal-btn-munsell');
    if (portalBtnMunsell) {
        portalBtnMunsell.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';
            
            isPortalLaunch = true;
            setBottomBarVisible(true);
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
            
            isPortalLaunch = true;
            setBottomBarVisible(true);

            // ★単独起動は毎回まっさらな状態から始める。
            //   前回の続き（持ち込んだモデル、前回いじった時刻）が残っていると
            //   「単独で開いたのに前回の続きが出る」ことになるので、必ずリセットする。
            //   ※ カメラ状態(sharedCameraState)は openNightSimulation の中で
            //     今の視点から書き直されるので、ここで消す必要はない。
            sessionStorage.removeItem('night_custom_glb');
            openNightSimulation(NIGHT_START_PCT, true);   // 時刻は常に 09:00 から

            // 親アプリ側のスライダーも 09:00 の位置に合わせる
            const timeSlider = document.getElementById('app1-time-slider');
            if (timeSlider) {
                timeSlider.value = NIGHT_START_PCT;
                timeSlider.dispatchEvent(new Event('input'));
            }
        });
    }

    // ■ [地球モード] タイル単独起動
    const portalBtnEarth = document.getElementById('portal-btn-earth');
    if (portalBtnEarth) {
        portalBtnEarth.addEventListener('click', () => {
            portalScreen.style.display = 'none';
            btnBackToPortal.style.display = 'flex';

            isPortalLaunch = true;
            setBottomBarVisible(true);
            sessionStorage.removeItem('earth_custom_glb');
            openEarthSimulator(true);
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
            if (isEarthModeActive) {
                if (typeof window.closeEarthSimulator === 'function') window.closeEarthSimulator();
            }

            // ★地球モードのカメラを初期アングルへ戻す。
            //   地球画面は破棄せず隠して待機させてある（タイルを抱えたまま次に備えるため）ので、
            //   何もしないと「01→地球でぐるぐる回した視点」のままポータルから単独起動されてしまう。
            //   ※ closeEarthSimulator は上で済ませてある＝あちらのアングルは既に 01 側へ取り込み済み。
            const earthFrame = document.getElementById('earth-sim-iframe');
            const earthWin = earthFrame && earthFrame.contentWindow;
            if (earthWin && typeof earthWin.resetEarthCamera === 'function') earthWin.resetEarthCamera();
            sessionStorage.removeItem('earth_camera_state');   // 預けてあるアングルも捨てる

            setMainAppVisibility(false);
            setBottomBarVisible(false);   // ポータル画面では下部バーも引っ込める
            isPortalLaunch = false;
            UIController.clearGUI();
            UIController.hideFloatingMenu();

            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
            rebuildMeshes();

            portalScreen.style.display = 'flex';
            btnBackToPortal.style.display = 'none';
        });
    }

    // ★地球モードのデータを先にキャッシュへ入れておく。
    //   入口（ポータルのタイル／ツールバーの🌍）にホバーした時点＝開くつもりが見えた時点と、
    //   手が空いたとき（アイドル）に温める。切り替えた瞬間の待ち時間がここで消える。
    setupEarthPrefetchTriggers(['portal-btn-earth', 'app1-clip-slider-container']);

    // 初期起動時：メイン3D画面を非表示にしてポータル画面のみを表示した状態にする
    setMainAppVisibility(false);
    setBottomBarVisible(false);
});
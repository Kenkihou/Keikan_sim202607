// interactionHandler.js
import * as THREE from 'three';
import { AppState } from './appState.js';
import { UIController } from './uiController.js';

let camera, scene, controls, hoverMesh, activeMat;
let getInteractiveMeshes = () => [];
let rebuildMeshes = () => {};
let saveState = () => {};

let currentTool = null;
// ★追加：外構作図モードの間は、建物側の作図・押し出し・編集操作をすべて止める
//   （キャンバス上のクリックは外構モジュールが受け取る）
let isLocked = false;
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let activePlane = new THREE.Plane(); 
const raycaster = new THREE.Raycaster();

let isDrawing = false;
const drawStartPt = new THREE.Vector3();
let currentDrawObj = null; 

let isExtruding = false;
let extrudeTargetId = null;
const extrudeNormal = new THREE.Vector3();
let connectedBlocks = []; 
const extrudeStartPt = new THREE.Vector3(); 

const downPointer = new THREE.Vector2(); 
const tooltip = document.getElementById('tooltip');

let currentSnap = 500; // 現在のスナップ量
function snap(val) { return Math.round(val / currentSnap) * currentSnap; }
// ==========================================
// ★変更：ダブルクリック＆トリプルクリック編集モード用変数
// ==========================================
let isEditing = false; 
let isGroupEditing = false; // ★追加：建物全体移動モードかどうかのフラグ
let editingBlock = null; 
let editingGroupBlocks = []; // ★追加：一緒に動かす建物パーツのリスト
let isDraggingBlock = false; 
const dragStartMouse = new THREE.Vector3(); 
const dragStartBlockPos = new THREE.Vector3();
let moveGizmo = null; 
// ==========================================
// ★追加：編集ハイライト用の青色マテリアル（使い回し用）
// ==========================================
const editBlueMat = new THREE.MeshBasicMaterial({ 
    color: 0xcceeff, 
    polygonOffset: true, 
    polygonOffsetFactor: 1, 
    polygonOffsetUnits: 1, 
    side: THREE.DoubleSide 
});
// ==========================================


function getMainPointer(e) {
    // 全画面描画に伴い、左側サブ画面の除外判定や幅調整を廃止し、画面全体を基準に正規化座標計算を行います
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    return { x, y };
}

function getGroundIntersect(e) {
    const p = getMainPointer(e);
    if (!p) return null;
    pointer.x = p.x;
    pointer.y = p.y;
    raycaster.setFromCamera(pointer, camera);
    const target = new THREE.Vector3();
    
    const intersect = raycaster.ray.intersectPlane(groundPlane, target);
    if(intersect) {
        target.x = snap(target.x);
        target.z = snap(target.z);
        return target;
    }
    return null;
}

function updateHoverMesh(b, normal) {
    const baseY = b.y || 0;
    if (normal.y > 0.5) { 
        hoverMesh.scale.set(b.w, b.d, 1);
        hoverMesh.rotation.set(-Math.PI/2, 0, 0);
        hoverMesh.position.set(b.x, baseY + b.h + 2, b.z);
    } else if (normal.x > 0.5) { 
        hoverMesh.scale.set(b.d, b.h, 1);
        hoverMesh.rotation.set(0, Math.PI/2, 0);
        hoverMesh.position.set(b.x + b.w/2 + 2, baseY + b.h/2, b.z);
    } else if (normal.x < -0.5) { 
        hoverMesh.scale.set(b.d, b.h, 1);
        hoverMesh.rotation.set(0, -Math.PI/2, 0);
        hoverMesh.position.set(b.x - b.w/2 - 2, baseY + b.h/2, b.z);
    } else if (normal.z > 0.5) { 
        hoverMesh.scale.set(b.w, b.h, 1);
        hoverMesh.rotation.set(0, 0, 0);
        hoverMesh.position.set(b.x, baseY + b.h/2, b.z + b.d/2 + 2);
    } else if (normal.z < -0.5) { 
        hoverMesh.scale.set(b.w, b.h, 1);
        hoverMesh.rotation.set(0, Math.PI, 0);
        hoverMesh.position.set(b.x, baseY + b.h/2, b.z - b.d/2 - 2);
    }
    hoverMesh.visible = true;
}

// ==========================================
// ★追加：ギズモの作成・更新・削除関数
// ==========================================
function createGizmo() {
    if (moveGizmo) return;

    moveGizmo = new THREE.Group();

    const axisLength = 3000;
    const arrowLength = 500;
    const arrowWidth = 200;

    // X軸 (赤)
    const dirX = new THREE.Vector3(1, 0, 0);
    const origin = new THREE.Vector3(0, 0, 0);
    const arrowHelperX1 = new THREE.ArrowHelper(dirX, origin, axisLength, 0xff0000, arrowLength, arrowWidth);
    
    // Z軸 (青)
    const dirZ = new THREE.Vector3(0, 0, 1);
    const arrowHelperZ1 = new THREE.ArrowHelper(dirZ, origin, axisLength, 0x0000ff, arrowLength, arrowWidth);

    [arrowHelperX1, arrowHelperZ1].forEach(arrow => { // ★X2とZ2を削除
        arrow.line.material.depthTest = false;
        arrow.line.material.depthWrite = false;
        arrow.line.material.linewidth = 3;
        arrow.cone.material.depthTest = false;
        arrow.cone.material.depthWrite = false;
    });

    moveGizmo.add(arrowHelperX1, arrowHelperZ1);
    moveGizmo.position.y = 50; // 地面に埋もれないように少し浮かせる
    moveGizmo.visible = false; // ★追加：初期状態では非表示にする
    scene.add(moveGizmo);
}

function updateGizmo() {
    if (isEditing && editingBlock && moveGizmo) {
        moveGizmo.position.x = editingBlock.x;
        moveGizmo.position.z = editingBlock.z;
        
        // カメラ距離に応じて大きさを一定に保つ
        const dist = camera.position.distanceTo(moveGizmo.position);
        const scale = Math.max(0.5, dist / 15000);
        moveGizmo.scale.set(scale, scale, scale);
        
        moveGizmo.visible = true;
    } else if (moveGizmo) {
        moveGizmo.visible = false;
    }
}

function removeGizmo() {
    if (moveGizmo) moveGizmo.visible = false;
}

// 【重要】現在のアクティブなIDを判定する関数を追加
function isBlockHighlighted(blockId) {
    if (!isEditing) return false;
    return isGroupEditing 
        ? editingGroupBlocks.some(b => b.id === blockId)
        : (editingBlock && editingBlock.id === blockId);
}

// ==========================================
// ★差し替え：編集中のオブジェクトを青くハイライトする関数
// ==========================================
function highlightEditingBlocks() {
    if (!scene) return;
    const houseGroup = window.getHouseGroup?.() || scene;
    
    // 現在のハイライト対象IDリストを作成
    let targetIds = [];
    if (isEditing && editingBlock) {
        targetIds = isGroupEditing ? editingGroupBlocks.map(b => b.id) : [editingBlock.id];
    }
    
    houseGroup.traverse((child) => {
        // メッシュであり、IDを持っているものだけを対象とする
        if (!child.isMesh || !child.userData || !child.userData.id) return;
        
        const isTarget = targetIds.includes(child.userData.id);
        
        if (isTarget) {
            // 【ターゲットの場合：使い回し用の青マテリアルを直接適用する】
            if (Array.isArray(child.material)) {
                child.material = [editBlueMat, editBlueMat, editBlueMat, editBlueMat, editBlueMat, editBlueMat];
            } else {
                child.material = editBlueMat;
            }
        }
        // ※ターゲット以外の場合は、再構築時に元の色が自動的に割り当てられているため何もしなくてOKです
    });

    // ★ココが最重要！ 色を塗り替えた後に強制的に画面を再描画する
    if (window.renderAllViews) {
        window.renderAllViews();
    }
}
window.triggerHighlightSync = highlightEditingBlocks;

// 編集モードを完全に終了する共通関数
function exitEditMode() {
    isEditing = false;
    isGroupEditing = false;
    editingBlock = null;
    editingGroupBlocks = [];
    isDraggingBlock = false;
    
    removeGizmo();
    rebuildMeshes(); // ★再構築を呼ぶだけで、自動的に元の色に戻ります
    document.body.style.cursor = 'default';
}

export const InteractionHandler = {
toggleSnap() {
        // 500と100を切り替える
        currentSnap = currentSnap === 500 ? 100 : 500;
        
        // HTMLのUI表示を更新する
        const btn = document.getElementById('btn-snap-toggle');
        const span = document.getElementById('snap-val');
        if (btn) btn.setAttribute('data-tooltip', `📏 スナップ: ${currentSnap}mm`);
        if (span) span.innerText = currentSnap;
        
        return currentSnap;
    },    
// init(params) の末尾までを以下に置き換え
init(params) {
        camera = params.camera;
        scene = params.scene;
        controls = params.controls;
        getInteractiveMeshes = params.getInteractiveMeshes;
        hoverMesh = params.hoverMesh;
        activeMat = params.activeMat;
        
        // ★修正：再構築の直後に、必ず色を塗る処理を連動させる
        const originalRebuildMeshes = params.rebuildMeshes;
        rebuildMeshes = () => {
            originalRebuildMeshes();
            highlightEditingBlocks();
        };
        
        saveState = params.saveState;
        
        createGizmo();
        this.setupEventListeners();

        // 外部からツールを切り替える用
        window.setTool = (toolName) => this.setTool(toolName);
    },

    getCurrentTool() {
        return currentTool;
    },

    // ★追加：現在のスナップ量（mm）。外構作図モードでも同じ刻みで点を拾うために使う
    getSnap() {
        return currentSnap;
    },

    // ★追加：外構作図モードの出入りで、建物側の操作をまるごとロック／解除する
    setLocked(v) {
        isLocked = !!v;
        if (isLocked) {
            this.setTool(null);          // 作図・押し出し中なら解除（編集モードもここで抜ける）
            hoverMesh.visible = false;
            document.body.style.cursor = 'default';
            if (tooltip) tooltip.style.display = 'none';
            UIController.clearGUI();
            UIController.hideFloatingMenu();
        }
    },

    isLocked() {
        return isLocked;
    },

    setTool(toolName) {
        currentTool = toolName;
        // ★追加：別のツールが選ばれたら編集・移動モードを解除
        if (isEditing) {
            exitEditMode(); // これ一行にまとめます
        }

        // ★追加：ツールを切り替えた時に、作図中の仮平面があれば強制的に消去する
        if (currentDrawObj) {
            scene.remove(currentDrawObj.mesh, currentDrawObj.line);
            if (currentDrawObj.mesh.geometry) currentDrawObj.mesh.geometry.dispose();
            currentDrawObj = null;
            isDrawing = false;
        }

        const btnDraw = document.getElementById('btn-draw');
        const btnExtrude = document.getElementById('btn-extrude');
        const modeText = document.getElementById('mode-text');
        const modeDesc = document.getElementById('mode-desc');

        if (btnDraw) btnDraw.classList.toggle('active', toolName === 'DRAW');
        if (btnExtrude) btnExtrude.classList.toggle('active', toolName === 'EXTRUDE');

        if (tooltip) tooltip.style.display = 'none';
        hoverMesh.visible = false;
        document.body.style.cursor = 'default';           
        if (toolName !== 'EXTRUDE') {
            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
        }
        rebuildMeshes();

        UIController.hideFloatingMenu(); 
        UIController.updateStatusDisplay(currentTool); 
    },

    setupEventListeners() {
        window.addEventListener('pointerdown', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            if (e.target.closest('#floating-menu')) return;
            UIController.hideFloatingMenu();
            if (e.button !== 0) return; 
            if (e.target.tagName !== 'CANVAS') return; 

            downPointer.set(e.clientX, e.clientY);

            const p = getMainPointer(e);
            if (!p) return; 
            pointer.x = p.x;
            pointer.y = p.y;
            raycaster.setFromCamera(pointer, camera);

            // ==========================================
            // ★追加：編集モード時のブロックドラッグ開始
            // ==========================================
            if (isEditing && editingBlock && currentTool === null) {
                const houseGroup = window.getHouseGroup?.() || scene;
                const intersects = raycaster.intersectObject(houseGroup, true);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;
                    
                    // ★追加：グループ移動中なら「グループ内のどれか」をクリックしていればOKとする
                    const isTargetHit = isGroupEditing 
                        ? editingGroupBlocks.some(b => b.id === hitId)
                        : hitId === editingBlock.id;

                    if (isTargetHit) {
                        const pt = getGroundIntersect(e);
                        if (pt) {
                            isDraggingBlock = true;
                            dragStartMouse.copy(pt);
                            dragStartBlockPos.set(editingBlock.x, 0, editingBlock.z);
                            
                            // ★追加：グループ全体の移動開始時の座標を記憶する
                            if (isGroupEditing) {
                                editingGroupBlocks.forEach(b => {
                                    b.startX = b.x;
                                    b.startZ = b.z;
                                });
                            }
                            controls.enabled = false; 
                            return; 
                        }
                    } else {
                        exitEditMode();
                    }
                } else {
                    exitEditMode(); // これ一行にまとめます
                }
            }

            if (currentTool === 'DRAW') {
                const pt = getGroundIntersect(e);
                if (!pt) return;
                isDrawing = true;
                drawStartPt.copy(pt);
                controls.enabled = false;

            } else if (currentTool === 'EXTRUDE') {
                const interactiveMeshes = getInteractiveMeshes();
                const intersects = raycaster.intersectObjects(interactiveMeshes);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;

                    if (!AppState.selectedId || AppState.selectedId !== hitId) return;

                    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                    
                    let hitFaceDir = null;
                    if (hit.object.userData.isRoof || normal.y > 0.5) hitFaceDir = 'top';
                    else if (normal.y < -0.5) hitFaceDir = 'bottom';
                    else if (normal.z > 0.5) hitFaceDir = 'pz';
                    else if (normal.z < -0.5) hitFaceDir = 'nz';
                    else if (normal.x > 0.5) hitFaceDir = 'px';
                    else if (normal.x < -0.5) hitFaceDir = 'nx';

                    if (!AppState.selectedFaceDir || AppState.selectedFaceDir !== hitFaceDir) return;

                    const baseBlock = AppState.buildingData.find(d => d.id === hitId);

                    extrudeNormal.set(0,0,0);
                    if (hitFaceDir === 'top') extrudeNormal.set(0,1,0); 
                    else if (hitFaceDir === 'bottom') return; 
                    else if (hitFaceDir === 'px') extrudeNormal.set(1,0,0); 
                    else if (hitFaceDir === 'nx') extrudeNormal.set(-1,0,0); 
                    else if (hitFaceDir === 'pz') extrudeNormal.set(0,0,1); 
                    else if (hitFaceDir === 'nz') extrudeNormal.set(0,0,-1); 
                    else return;

                    isExtruding = true;
                    connectedBlocks = [];

                    const camDir = camera.getWorldDirection(new THREE.Vector3()).negate();
                    const axis = extrudeNormal.clone();
                    
                    const cross1 = new THREE.Vector3().crossVectors(axis, camDir);
                    let planeNormal = new THREE.Vector3().crossVectors(cross1, axis).normalize();
                    
                    if (planeNormal.lengthSq() < 0.001) {
                        planeNormal = axis.y === 0 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
                    }
                    
                    activePlane.setFromNormalAndCoplanarPoint(planeNormal, hit.point);
                    extrudeStartPt.copy(hit.point);

                    if (extrudeNormal.y > 0) {
                        if (e.shiftKey) {
                            const newY = (baseBlock.y || 0) + baseBlock.h;
                            const newId = Date.now().toString();
                            const newBlock = {
                                id: newId, // ★変更
                                rootBuildingId: baseBlock.rootBuildingId || baseBlock.id,
                                x: baseBlock.x, y: newY, z: baseBlock.z,
                                w: baseBlock.w, d: baseBlock.d, h: 500 
                            };
                            AppState.buildingData.push(newBlock);
                            extrudeTargetId = newBlock.id;
                            connectedBlocks.push({ block: newBlock, startBox: { ...newBlock }, type: 'resize' });
                            
                            rebuildMeshes(); 
                            window.setMeshActiveMaterial?.(newBlock.id);
                        } else {
                            extrudeTargetId = hitId;
                            const stackedBlocks = AppState.getStackedBlocks([baseBlock]);
                            
                            stackedBlocks.forEach(ob => {
                                if (ob.id === baseBlock.id) {
                                    connectedBlocks.push({ block: ob, startBox: { ...ob }, type: 'resize' });
                                } else {
                                    connectedBlocks.push({ block: ob, startBox: { ...ob }, type: 'translate' });
                                }
                            });
                            rebuildMeshes();
                            connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                        }
                    } 
                    else {
                        if (e.shiftKey) {
                            const newId = Date.now().toString();
                            const newBlock = {
                                id: newId, // ★変更
                                rootBuildingId: baseBlock.rootBuildingId || baseBlock.id, // ★追加：親のルーツを受け継ぐ
                                x: baseBlock.x, y: baseBlock.y || 0, z: baseBlock.z,
                                w: baseBlock.w, d: baseBlock.d, h: baseBlock.h 
                            };
                            if (extrudeNormal.x !== 0) {
                                newBlock.w = 500;
                                newBlock.x = baseBlock.x + (baseBlock.w / 2 + 250) * extrudeNormal.x;
                            } else if (extrudeNormal.z !== 0) {
                                newBlock.d = 500;
                                newBlock.z = baseBlock.z + (baseBlock.d / 2 + 250) * extrudeNormal.z;
                            }
                            AppState.buildingData.push(newBlock);
                            extrudeTargetId = newBlock.id;
                            connectedBlocks.push({ block: newBlock, startBox: { ...newBlock }, type: 'resize', normal: extrudeNormal.clone() });
                            
                            rebuildMeshes(); 
                            window.setMeshActiveMaterial?.(newBlock.id);
                        } else {
                            extrudeTargetId = hitId;
                            
                            AppState.buildingData.forEach(ob => {
                                if (ob.id === baseBlock.id) return;
                                
                                let isTouchingOpposite = false;
                                if (extrudeNormal.x !== 0) {
                                    const targetEdge = baseBlock.x + (baseBlock.w/2) * extrudeNormal.x;
                                    const obOppositeEdge = ob.x - (ob.w/2) * extrudeNormal.x; 
                                    
                                    if (Math.abs(obOppositeEdge - targetEdge) < 1) { 
                                        const overlapZ = Math.abs(ob.z - baseBlock.z) * 2 < (ob.d + baseBlock.d) - 1;
                                        const overlapY = Math.max((ob.y||0), (baseBlock.y||0)) < Math.min((ob.y||0)+ob.h, (baseBlock.y||0)+baseBlock.h) - 1;
                                        if (overlapZ && overlapY) isTouchingOpposite = true;
                                    }
                                } else if (extrudeNormal.z !== 0) {
                                    const targetEdge = baseBlock.z + (baseBlock.d/2) * extrudeNormal.z;
                                    const obOppositeEdge = ob.z - (ob.d/2) * extrudeNormal.z;
                                    
                                    if (Math.abs(obOppositeEdge - targetEdge) < 1) { 
                                        const overlapX = Math.abs(ob.x - baseBlock.x) * 2 < (ob.w + baseBlock.w) - 1;
                                        const overlapY = Math.max((ob.y||0), (baseBlock.y||0)) < Math.min((ob.y||0)+ob.h, (baseBlock.y||0)+baseBlock.h) - 1;
                                        if (overlapX && overlapY) isTouchingOpposite = true;
                                    }
                                }
                                
                                if (isTouchingOpposite) {
                                    connectedBlocks.push({ block: ob, startBox: { ...ob }, type: 'resize', normal: extrudeNormal.clone().negate() });
                                }
                            });
                            connectedBlocks.push({ block: baseBlock, startBox: { ...baseBlock }, type: 'resize', normal: extrudeNormal.clone() });
                            
                            rebuildMeshes();
                            connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                        }
                    }
                    controls.enabled = false;
                }
            }
        });

        window.addEventListener('pointermove', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            const p = getMainPointer(e);
            if (!p) {
                document.body.style.cursor = 'default';
                return; 
            }
            pointer.x = p.x;
            pointer.y = p.y;

            updateGizmo(); // ★追加：ギズモの表示位置を更新

            // ==========================================
            // ★追加：編集モード時のカーソル変更 (ホバー判定)
            // ==========================================
            if (isEditing && editingBlock && currentTool === null && !isDraggingBlock) {
                raycaster.setFromCamera(pointer, camera);
                const houseGroup = window.getHouseGroup?.() || scene;
                const intersects = raycaster.intersectObject(houseGroup, true);
                
                let isHoveringEditingBlock = false;
                if (intersects.length > 0) {
                    const hitId = intersects[0].object.userData.id;
                    // ★グループ編集時は、グループ内のどのブロックに乗っても十字カーソルにする
                    if (isGroupEditing) {
                        if (editingGroupBlocks.some(b => b.id === hitId)) isHoveringEditingBlock = true;
                    } else {
                        if (hitId === editingBlock.id) isHoveringEditingBlock = true;
                    }
                }
                
                document.body.style.cursor = isHoveringEditingBlock ? 'move' : 'default';
            }

            // ==========================================
            // ★追加：ドラッグ移動 ＆ 頂点マグネットスナップ
            // ==========================================
            if (isDraggingBlock && editingBlock) {
                document.body.style.cursor = 'move'; 
                
                const pt = getGroundIntersect(e);
                if (!pt) return;

                const deltaX = pt.x - dragStartMouse.x;
                const deltaZ = pt.z - dragStartMouse.z;
                
                let newX = dragStartBlockPos.x + deltaX;
                let newZ = dragStartBlockPos.z + deltaZ;

                const SNAP_DIST = 200; 
                let snapedX = newX;
                let snapedZ = newZ;
                let minSqDist = SNAP_DIST * SNAP_DIST;

                const w2 = editingBlock.w / 2;
                const d2 = editingBlock.d / 2;
                const myCorners = [
                    { x: -w2, z: -d2 }, { x: w2, z: -d2 },
                    { x: -w2, z: d2 }, { x: w2, z: d2 }
                ];

                for (let ob of AppState.buildingData) {
                    // ★追加：全体移動時は、同じ家（グループ内）のブロック同士のマグネット干渉を無視する
                    if (isGroupEditing && editingGroupBlocks.some(gb => gb.id === ob.id)) continue;
                    if (!isGroupEditing && ob.id === editingBlock.id) continue;
                    
                    const obW2 = ob.w / 2;
                    const obD2 = ob.d / 2;
                    const obCorners = [
                        { x: ob.x - obW2, z: ob.z - obD2 },
                        { x: ob.x + obW2, z: ob.z - obD2 },
                        { x: ob.x - obW2, z: ob.z + obD2 },
                        { x: ob.x + obW2, z: ob.z + obD2 }
                    ];

                    for (let myC of myCorners) {
                        const myWorldX = newX + myC.x;
                        const myWorldZ = newZ + myC.z;

                        for (let obC of obCorners) {
                            const dx = obC.x - myWorldX;
                            const dz = obC.z - myWorldZ;
                            const sqDist = dx * dx + dz * dz;

                            if (sqDist < minSqDist) {
                                minSqDist = sqDist;
                                snapedX = newX + dx;
                                snapedZ = newZ + dz;
                            }
                        }
                    }
                }

                // ★追加：実際の移動量に基づいて全体を動かす
                const actualMoveX = snapedX - dragStartBlockPos.x;
                const actualMoveZ = snapedZ - dragStartBlockPos.z;

                if (isGroupEditing) {
                    editingGroupBlocks.forEach(b => {
                        b.x = b.startX + actualMoveX;
                        b.z = b.startZ + actualMoveZ;
                    });
                } else {
                    editingBlock.x = snapedX;
                    editingBlock.z = snapedZ;
                }
                
                updateGizmo(); 
                AppState.updateAllLowerRoofs();
                rebuildMeshes();
                return;
            }

            if (isDrawing) {
                const pt = getGroundIntersect(e);
                if (!pt) return;

                const w = Math.abs(pt.x - drawStartPt.x);
                const d = Math.abs(pt.z - drawStartPt.z);
                const cx = (pt.x + drawStartPt.x) / 2;
                const cz = (pt.z + drawStartPt.z) / 2;
                const h = 100; 

                if (currentDrawObj) {
                    scene.remove(currentDrawObj.mesh, currentDrawObj.line);
                    currentDrawObj.mesh.geometry.dispose();
                }

                if (w > 0 && d > 0) {
                    const geo = new THREE.BoxGeometry(w, h, d);
                    const mesh = new THREE.Mesh(geo, activeMat);
                    mesh.position.set(cx, h / 2, cz);
                    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), window.getEdgeMat?.() || activeMat);
                    line.position.copy(mesh.position);
                    scene.add(mesh, line);
                    currentDrawObj = { mesh, line, x: cx, z: cz, w: w, d: d, h: h };
                    
                    if (tooltip) {
                        tooltip.style.display = 'block';
                        tooltip.style.left = (e.clientX + 15) + 'px';
                        tooltip.style.top = (e.clientY + 15) + 'px';
                        tooltip.innerText = `間口: ${(w / 1000).toFixed(1)} m\n奥行: ${(d / 1000).toFixed(1)} m`;
                    }
                } else {
                    if (tooltip) tooltip.style.display = 'none';
                }
                window.renderAllViews?.();

            } else if (isExtruding) {
                let tooltipText = "";

                raycaster.setFromCamera(pointer, camera);
                const target = new THREE.Vector3();              
                const intersect = raycaster.ray.intersectPlane(activePlane, target);

                if (intersect) {
                    if (extrudeNormal.y > 0) {
                        const deltaY = target.y - extrudeStartPt.y; 
                        const mainCb = connectedBlocks.find(cb => cb.type === 'resize');
                        
                        let newH = snap(mainCb.startBox.h + deltaY);
                        if (newH < 500) newH = 500;
                        
                        const actualDeltaY = newH - mainCb.startBox.h;

                        connectedBlocks.forEach(cb => {
                            if (cb.type === 'resize') {
                                cb.block.h = newH;
                            } else if (cb.type === 'translate') {
                                cb.block.y = cb.startBox.y + actualDeltaY;
                            }
                        });
                        tooltipText = `階高: ${(newH / 1000).toFixed(1)} m`;

                    } else if (extrudeNormal.x !== 0) {
                        const deltaX = target.x - extrudeStartPt.x;
                        let validDeltaX = Math.round(deltaX / currentSnap) * currentSnap;
                        let minDeltaX = -Infinity;
                        let maxDeltaX = Infinity;

                        for (let cb of connectedBlocks) {
                            if (cb.type !== 'resize') continue;
                            const startMovingEdge = cb.startBox.x + (cb.startBox.w/2) * cb.normal.x;
                            const fixedEdge = cb.startBox.x - (cb.startBox.w/2) * cb.normal.x;

                            if (cb.normal.x > 0) {
                                const limit = fixedEdge + 100 - startMovingEdge;
                                if (limit > minDeltaX) minDeltaX = limit;
                            } else if (cb.normal.x < 0) {
                                const limit = fixedEdge - 100 - startMovingEdge;
                                if (limit < maxDeltaX) maxDeltaX = limit;
                            }
                        }

                        if (validDeltaX < minDeltaX) validDeltaX = minDeltaX;
                        if (validDeltaX > maxDeltaX) validDeltaX = maxDeltaX;

                        connectedBlocks.forEach(cb => {
                            if (cb.type !== 'resize') return;
                            const startMovingEdge = cb.startBox.x + (cb.startBox.w/2) * cb.normal.x;
                            const fixedEdge = cb.startBox.x - (cb.startBox.w/2) * cb.normal.x;
                            const movingEdge = startMovingEdge + validDeltaX;
                            
                            cb.block.w = Math.abs(movingEdge - fixedEdge);
                            cb.block.x = (movingEdge + fixedEdge) / 2;
                            if (cb.block.id === extrudeTargetId) tooltipText = `間口: ${(cb.block.w / 1000).toFixed(2)} m`; 
                        });

                    } else if (extrudeNormal.z !== 0) {
                        const deltaZ = target.z - extrudeStartPt.z;
                        let validDeltaZ = Math.round(deltaZ / currentSnap) * currentSnap; // ★変更
                        let minDeltaZ = -Infinity;
                        let maxDeltaZ = Infinity;

                        for (let cb of connectedBlocks) {
                            if (cb.type !== 'resize') continue;
                            const startMovingEdge = cb.startBox.z + (cb.startBox.d/2) * cb.normal.z;
                            const fixedEdge = cb.startBox.z - (cb.startBox.d/2) * cb.normal.z;

                            if (cb.normal.z > 0) {
                                const limit = fixedEdge + 100 - startMovingEdge;
                                if (limit > minDeltaZ) minDeltaZ = limit;
                            } else if (cb.normal.z < 0) {
                                const limit = fixedEdge - 100 - startMovingEdge;
                                if (limit < maxDeltaZ) maxDeltaZ = limit;
                            }
                        }

                        if (validDeltaZ < minDeltaZ) validDeltaZ = minDeltaZ;
                        if (validDeltaZ > maxDeltaZ) validDeltaZ = maxDeltaZ;

                        connectedBlocks.forEach(cb => {
                            if (cb.type !== 'resize') return;
                            const startMovingEdge = cb.startBox.z + (cb.startBox.d/2) * cb.normal.z;
                            const fixedEdge = cb.startBox.z - (cb.startBox.d/2) * cb.normal.z;
                            const movingEdge = startMovingEdge + validDeltaZ;
                            
                            cb.block.d = Math.abs(movingEdge - fixedEdge);
                            cb.block.z = (movingEdge + fixedEdge) / 2;
                            if (cb.block.id === extrudeTargetId) tooltipText = `奥行: ${(cb.block.d / 1000).toFixed(2)} m`; 
                        });
                    }
                }
                
                AppState.updateAllLowerRoofs(); 
                rebuildMeshes(); 
                connectedBlocks.forEach(cb => window.setMeshActiveMaterial?.(cb.block.id));
                
                const mainB = AppState.buildingData.find(d => d.id === extrudeTargetId);
                if (mainB) updateHoverMesh(mainB, extrudeNormal);
                
                if (tooltip) {
                    tooltip.style.display = 'block';
                    tooltip.style.left = (e.clientX + 15) + 'px';
                    tooltip.style.top = (e.clientY + 15) + 'px';
                    tooltip.innerText = tooltipText;
                }

            } else if (currentTool === 'EXTRUDE' && !isExtruding) {
                raycaster.setFromCamera(pointer, camera);
                const interactiveMeshes = getInteractiveMeshes();
                const intersects = raycaster.intersectObjects(interactiveMeshes);
                
                let isHoverValid = false; 

                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;
                    
                    if (AppState.selectedId && AppState.selectedId === hitId) {
                        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                        
                        let hitFaceDir = null;
                        if (hit.object.userData.isRoof || normal.y > 0.5) hitFaceDir = 'top';
                        else if (normal.y < -0.5) hitFaceDir = 'bottom';
                        else if (normal.z > 0.5) hitFaceDir = 'pz';
                        else if (normal.z < -0.5) hitFaceDir = 'nz';
                        else if (normal.x > 0.5) hitFaceDir = 'px';
                        else if (normal.x < -0.5) hitFaceDir = 'nx';

                        if (AppState.selectedFaceDir && AppState.selectedFaceDir === hitFaceDir) {
                            isHoverValid = true;
                            const b = AppState.buildingData.find(d => d.id === hitId);
                            if (b) {
                                let nDir = new THREE.Vector3();
                                if (hitFaceDir === 'top') nDir.set(0,1,0);
                                else if (hitFaceDir === 'bottom') nDir.set(0,-1,0);
                                else if (hitFaceDir === 'px') nDir.set(1,0,0);
                                else if (hitFaceDir === 'nx') nDir.set(-1,0,0);
                                else if (hitFaceDir === 'pz') nDir.set(0,0,1);
                                else if (hitFaceDir === 'nz') nDir.set(0,0,-1);

                                if (nDir.y > 0) {
                                    if (b.roof) {
                                        hoverMesh.visible = false; 
                                    } else {
                                        updateHoverMesh(b, nDir);  
                                    }
                                    document.body.style.cursor = e.shiftKey ? 'copy' : 'ns-resize'; 
                                } else if (nDir.x !== 0) {
                                    updateHoverMesh(b, nDir);
                                    document.body.style.cursor = e.shiftKey ? 'copy' : 'ew-resize';
                                } else if (nDir.z !== 0) {
                                    updateHoverMesh(b, nDir);
                                    document.body.style.cursor = e.shiftKey ? 'copy' : 'ns-resize'; 
                                }
                            }
                        }
                    }
                }

                if (!isHoverValid) {
                    hoverMesh.visible = false;
                    document.body.style.cursor = 'default';
                }
                window.renderAllViews?.();
            }
        });

        window.addEventListener('keydown', (e) => {
            if (isLocked) return;                 // ★外構作図モード中（Delete等は外構側が受け取る）
            if (currentTool === 'EXTRUDE' && !isExtruding && hoverMesh.visible && e.key === 'Shift') {
                document.body.style.cursor = 'copy'; 
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId !== null) {
                AppState.buildingData = AppState.buildingData.filter(b => b.id !== AppState.selectedId);
                AppState.selectedId = null;
                saveState(); 
                rebuildMeshes();
                UIController.hideFloatingMenu();    
                UIController.updateStatusDisplay(currentTool); 
                hoverMesh.visible = false;

                exitEditMode();
                UIController.clearGUI();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            if (currentTool === 'EXTRUDE' && !isExtruding && e.key === 'Shift' && hoverMesh.visible) {
                if (hoverMesh.rotation.x === -Math.PI/2) document.body.style.cursor = 'ns-resize'; 
                else if (hoverMesh.rotation.y === Math.PI/2 || hoverMesh.rotation.y === -Math.PI/2) document.body.style.cursor = 'ew-resize';
                else document.body.style.cursor = 'ns-resize';
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            const upPointer = new THREE.Vector2(e.clientX, e.clientY);
            const isClick = downPointer.distanceTo(upPointer) < 5;
            
            // ==========================================
            // ★追加：ドラッグ移動の終了と履歴保存
            // ==========================================
            if (isDraggingBlock) {
                isDraggingBlock = false;
                controls.enabled = true;
                if (!isClick) {
                    saveState(); // 位置を確定して履歴（戻るボタン）に保存
                    return; // ドラッグした場合はここで終了
                }
            }

            if (isClick && e.target.tagName === 'CANVAS') {
                if (currentTool === null) {
                    const p = getMainPointer(e);
                    if (!p) return;
                    pointer.x = p.x;
                    pointer.y = p.y;
                    raycaster.setFromCamera(pointer, camera);
                    
                    const houseGroup = window.getHouseGroup?.() || scene;
                    const intersects = raycaster.intersectObject(houseGroup, true);

                    if (intersects.length > 0) {
                        const hit = intersects[0];
                        const hitId = hit.object.userData.id;
                        const targetBlock = AppState.buildingData.find(d => d.id === hitId);

                        if (targetBlock && targetBlock.h >= 100) {
                            AppState.selectedId = hitId;
                            
                            let faceType = null;
                            let faceDir = null;
                            let clickedDecoType = null;

                            if (hit.object.userData.isRoof) {
                                faceType = 'top';
                                AppState.selectedFaceDir = 'top';
                            } else if (hit.object.userData.isDeco) {
                                clickedDecoType = hit.object.userData.type; 
                                
                                if (clickedDecoType === 'lowerRoof') {
                                    faceType = 'top';
                                    AppState.selectedFaceDir = 'top';
                                } else {
                                    faceType = 'side';
                                    faceDir = hit.object.userData.dir;
                                    
                                    if (!faceDir && hit.point) {
                                        const dx = hit.point.x - targetBlock.x;
                                        const dz = hit.point.z - targetBlock.z;
                                        if (Math.abs(dz) / targetBlock.d > Math.abs(dx) / targetBlock.w) {
                                            faceDir = dz > 0 ? 'pz' : 'nz';
                                        } else {
                                            faceDir = dx > 0 ? 'px' : 'nx';
                                        }
                                    }
                                    AppState.selectedFaceDir = faceDir;
                                }
                            } else {
                                const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                                if (normal.y > 0.5) { faceType = 'top'; AppState.selectedFaceDir = 'top'; }
                                else if (normal.y < -0.5) { faceType = 'bottom'; AppState.selectedFaceDir = 'bottom'; }
                                else {
                                    faceType = 'side';
                                    if (normal.z > 0.5) faceDir = 'pz';
                                    else if (normal.z < -0.5) faceDir = 'nz';
                                    else if (normal.x > 0.5) faceDir = 'px';
                                    else if (normal.x < -0.5) faceDir = 'nx';
                                    AppState.selectedFaceDir = faceDir;
                                }
                            }

                            UIController.showFloatingMenu(e.clientX, e.clientY, targetBlock, faceType, faceDir);

                            if (faceType === 'top') {
                                if (targetBlock.roof) UIController.updateGUI(targetBlock, 'roof');
                                else if (targetBlock.lowerRoof) UIController.updateGUI(targetBlock, 'lowerRoof');
                                else UIController.clearGUI();
                            } else if (faceType === 'side') {
                                if (clickedDecoType) {
                                    if (clickedDecoType === 'visor' || clickedDecoType === 'flatVisor') {
                                        UIController.updateGUI(targetBlock, 'side', faceDir);
                                    } else {
                                        UIController.updateGUI(targetBlock, clickedDecoType, faceDir);
                                    }
                                }
                                else if (targetBlock.balconies && targetBlock.balconies[faceDir]) {
                                    UIController.updateGUI(targetBlock, 'balcony', faceDir);
                                } else if (targetBlock.pilasters && targetBlock.pilasters[faceDir]) { 
                                    UIController.updateGUI(targetBlock, 'pilaster', faceDir);
                                } else if (targetBlock.windows && targetBlock.windows[faceDir]) {
                                    UIController.updateGUI(targetBlock, 'window', faceDir);
                                } else if (targetBlock.doors && targetBlock.doors[faceDir]) {
                                    UIController.updateGUI(targetBlock, 'door', faceDir);
                                } else {
                                    UIController.updateGUI(targetBlock, 'side', faceDir);
                                }
                            } else {
                                UIController.clearGUI();
                            }
                        } else {
                            AppState.selectedId = null; AppState.selectedFaceDir = null; UIController.hideFloatingMenu(); UIController.clearGUI(); 
                        }
                    } else {
                        AppState.selectedId = null; AppState.selectedFaceDir = null; UIController.hideFloatingMenu(); UIController.clearGUI(); 
                    }
                    
                    rebuildMeshes();
                    UIController.updateStatusDisplay(currentTool);
                }
                else {
                    if (!isDrawing && !isExtruding) {
                        this.setTool(null); 
                    }
                }
            }

            if (isDrawing) {
                isDrawing = false;
                controls.enabled = true;
                if (tooltip) tooltip.style.display = 'none'; 
                
                if (currentDrawObj && currentDrawObj.w > 0 && currentDrawObj.d > 0) {
                    const newId = Date.now().toString();
                    AppState.buildingData.push({
                        id: newId,
                        rootBuildingId: newId,
                        x: currentDrawObj.x,
                        y: 0, 
                        z: currentDrawObj.z,
                        w: currentDrawObj.w,
                        d: currentDrawObj.d,
                        h: currentDrawObj.h
                    });
                    saveState(); 
                    // ★追記：「作図が完了したよ」とチュートリアルマネージャーに通知
                    if (window.TutorialManager) {
                        window.TutorialManager.notifyTrigger("draw_complete");
                    }
                }

                // ==========================================
                // ★追加：作図が終わったら、一時的な平面（ゴースト）をシーンから完全に消去する
                if (currentDrawObj) {
                    scene.remove(currentDrawObj.mesh, currentDrawObj.line);
                    if (currentDrawObj.mesh.geometry) currentDrawObj.mesh.geometry.dispose();
                }
                // ==========================================

                currentDrawObj = null;
                rebuildMeshes();
                this.setTool(null); 
            }

            if (isExtruding) {
                isExtruding = false;
                controls.enabled = true;
                if (tooltip) tooltip.style.display = 'none'; 
                hoverMesh.visible = false;   
                document.body.style.cursor = 'default';

                extrudeTargetId = null;
                connectedBlocks = [];
                saveState(); 
                rebuildMeshes();
                this.setTool(null); 
                // ★追記：「押し出しが完了したよ」とチュートリアルマネージャーに通知
                if (window.TutorialManager) {
                        window.TutorialManager.notifyTrigger("extrude_complete");
                    }

                const currentGUI = window.currentGUI; 
                if (currentGUI && AppState.selectedId) {
                    const b = AppState.buildingData.find(d => d.id === AppState.selectedId);
                    if (currentGUI._title.includes('つけ柱')) {
                        UIController.updateGUI(b, 'pilaster', AppState.selectedFaceDir);
                    } else if (currentGUI._title.includes('バルコニー')) {
                        UIController.updateGUI(b, 'balcony', AppState.selectedFaceDir);
                    }
                }
            }
        });

        // =========================================
        // ★前回のダブルクリック処理を更新（フラグ追加）
        // =========================================
        window.addEventListener('dblclick', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            if (e.target.tagName !== 'CANVAS') return;

            const p = getMainPointer(e);
            if (!p) return;
            pointer.x = p.x;
            pointer.y = p.y;
            raycaster.setFromCamera(pointer, camera);
            
            const houseGroup = window.getHouseGroup?.() || scene;
            const intersects = raycaster.intersectObject(houseGroup, true);

            if (intersects.length > 0) {
                const hit = intersects[0];
                const hitId = hit.object.userData.id;
                
                if (hit.object.userData.isDeco || hit.object.userData.isRoof) return;

                const targetBlock = AppState.buildingData.find(d => d.id === hitId);
                
                if (targetBlock) {
                    this.setTool(null);
                    AppState.selectedId = hitId;
                    AppState.selectedFaceDir = null;
                    
                    UIController.hideFloatingMenu();
                    UIController.updateGUI(targetBlock, 'size');
                    
                    // ★ココが追加分：編集モードに移行
                    isEditing = true;
                    isGroupEditing = false;
                    editingBlock = targetBlock;
                    editingGroupBlocks = [];
                    updateGizmo(); // ★追加：ダブルクリックでモードに入ったらギズモを表示
                    rebuildMeshes();
                    UIController.updateStatusDisplay(currentTool);
                }
            } else {
                // 何もない場所をダブルクリックしたら編集解除
                isEditing = false;
                editingBlock = null;
                removeGizmo(); // ★追加：編集が解除されたらギズモも消す
            }
        });

        // =========================================
        // ★新規追加：トリプルクリック処理（建物全体の選択・移動）
        // =========================================
        window.addEventListener('click', (e) => {
            if (isLocked) return;                 // ★外構作図モード中
            // e.detail に連続クリック回数が入っています
            if (e.detail === 3) {
                if (e.target.tagName !== 'CANVAS') return;

                const p = getMainPointer(e);
                if (!p) return;
                pointer.x = p.x;
                pointer.y = p.y;
                raycaster.setFromCamera(pointer, camera);
                
                const houseGroup = window.getHouseGroup?.() || scene;
                const intersects = raycaster.intersectObject(houseGroup, true);

                if (intersects.length > 0) {
                    const hit = intersects[0];
                    const hitId = hit.object.userData.id;
                    
                    if (hit.object.userData.isDeco || hit.object.userData.isRoof) return;

                    const targetBlock = AppState.buildingData.find(d => d.id === hitId);
                    
                    if (targetBlock) {
                        this.setTool(null);
                        AppState.selectedId = hitId; // Delete用にホバーした一つだけを記憶
                        AppState.selectedFaceDir = null;
                        
                        UIController.hideFloatingMenu();
                        UIController.clearGUI(); // ★全体移動なので個別の寸法パネルは閉じる
                        
                       // ★全体モードに移行
                        isEditing = true;
                        isGroupEditing = true;
                        editingBlock = targetBlock;
                        
                        // ★縦に積まれているオブジェクト全てを集める
                        // 1. まず下方向にたどって一番下のブロック（最下層）を見つける
                        let baseBlock = targetBlock;
                        let foundLower = true;
                        while(foundLower) {
                            foundLower = false;
                            for (let ob of AppState.buildingData) {
                                if (ob.id === baseBlock.id) continue;
                                const obTop = (ob.y || 0) + ob.h;
                                const baseBottom = baseBlock.y || 0;
                                // 上下が接しており、かつX・Z座標が重なっているか判定
                                if (Math.abs(obTop - baseBottom) < 1) {
                                    const overlapX = Math.abs(ob.x - baseBlock.x) * 2 < (ob.w + baseBlock.w) - 1;
                                    const overlapZ = Math.abs(ob.z - baseBlock.z) * 2 < (ob.d + baseBlock.d) - 1;
                                    if (overlapX && overlapZ) {
                                        baseBlock = ob; // より下のブロックを更新
                                        foundLower = true;
                                        break; 
                                    }
                                }
                            }
                        }
                        
                        // 2. 一番下のブロックから、上に向かって積まれているブロックを全取得
                        editingGroupBlocks = AppState.getStackedBlocks([baseBlock]);
                        
                        updateGizmo(); 
                        rebuildMeshes();
                        UIController.updateStatusDisplay(currentTool);
                    }
                }
            }
        });

    }   
};
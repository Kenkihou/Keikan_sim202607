// visibilitySimulator.js
// 視認シミュレーション（リアルタイム透視ゴーストモード・CSSスマートロック完全対応版）

import * as THREE from 'three';
import { getCesiumViewer, getTargetEntity, getCurrentLinesData } from './cesiumApp.js';

export const VisibilitySimulator = {
    isActive: false,
    wireframePrimitive: null, 
    preRenderListener: null,
    colorCallback: null,

    init() {
        const startBtn = document.getElementById('btn-visibility-sim');
        const exitBtn = document.getElementById('btn-exit-sim'); 
        
        if (startBtn) {
            startBtn.addEventListener('click', () => this.toggleMode());
        }
        if (exitBtn) {
            exitBtn.addEventListener('click', () => this.exitMode());
        }
    },

    toggleMode() {
        const viewer = getCesiumViewer();
        if (!viewer) {
            alert('Cesiumの地球画面を開いてから実行してください。');
            return;
        }

        const targetEntity = getTargetEntity();
        if (!targetEntity) {
            alert('モデルが配置されていません。');
            return;
        }

        this.isActive = !this.isActive;
        const toggleBtn = document.getElementById('btn-visibility-sim');
        
        if (this.isActive) {
            if (toggleBtn) {
                toggleBtn.innerHTML = '👁️ シミュレーション終了';
                toggleBtn.style.background = '#ff4444';
            }
            this.enableGhostMode(viewer, targetEntity);
        } else {
            this.exitMode();
        }
    },

    exitMode() {
        this.isActive = false;
        const toggleBtn = document.getElementById('btn-visibility-sim');
        
        if (toggleBtn) {
            toggleBtn.innerHTML = '👁️ 視認シミュレーション';
            toggleBtn.style.background = '#0077ff';
        }
        
        const panel = document.getElementById('visibility-sim-panel');
        if (panel) panel.style.display = 'none';
        
        const targetEntity = getTargetEntity();
        if (targetEntity && targetEntity.model) {
            targetEntity.model.color = Cesium.Color.WHITE;
            targetEntity.model.colorBlendMode = Cesium.ColorBlendMode.HIGHLIGHT;
        }
        
        this.resetGhostMode();
    },

    resetGhostMode() {
        // ★UIとカメラのロックを解除
        this._unlockUI();

        const viewer = getCesiumViewer();
        if (viewer) {
            if (this.wireframePrimitive) {
                viewer.scene.primitives.remove(this.wireframePrimitive);
                this.wireframePrimitive = null;
            }
            if (this.preRenderListener) {
                viewer.scene.preRender.removeEventListener(this.preRenderListener);
                this.preRenderListener = null;
            }
        }
        this.colorCallback = null;
    },

    enableGhostMode(viewer, targetEntity) {
        this.resetGhostMode();

        // ★UIとカメラを安全にロック
        this._lockUI(viewer);

        const panel = document.getElementById('visibility-sim-panel');
        if (panel) panel.style.display = 'none';

        let hue = 0;
        this.colorCallback = new Cesium.CallbackProperty((time, result) => {
            hue += 0.02; 
            if (hue > 1.0) hue = 0.0;
            return Cesium.Color.fromHsl(hue, 1.0, 0.6, 1.0, result);
        }, false);

        targetEntity.model.color = this.colorCallback;
        targetEntity.model.colorBlendMode = Cesium.ColorBlendMode.REPLACE;

        this.extractAndDrawWireframe(viewer, targetEntity);
    },

    extractAndDrawWireframe(viewer, targetEntity) {
        const linesData = getCurrentLinesData();
        if (!linesData || linesData.length === 0) return;

        const initialPos = targetEntity.position.getValue(viewer.clock.currentTime);
        const initialOri = targetEntity.orientation.getValue(viewer.clock.currentTime);
        const initialTransform = Cesium.Matrix4.fromRotationTranslation(
            Cesium.Matrix3.fromQuaternion(initialOri),
            initialPos
        );
        const initialInverse = Cesium.Matrix4.inverseTransformation(initialTransform, new Cesium.Matrix4());

        const instances = linesData.map(seg => {
            const local1 = new Cesium.Cartesian3(seg.p1.x, seg.p1.y, seg.p1.z);
            const local2 = new Cesium.Cartesian3(seg.p2.x, seg.p2.y, seg.p2.z);
            
            const world1 = Cesium.Matrix4.multiplyByPoint(initialTransform, local1, new Cesium.Cartesian3());
            const world2 = Cesium.Matrix4.multiplyByPoint(initialTransform, local2, new Cesium.Cartesian3());

            return new Cesium.GeometryInstance({
                geometry: new Cesium.PolylineGeometry({
                    positions: [world1, world2],
                    width: 2.0,
                    vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                    arcType: Cesium.ArcType.NONE 
                }),
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE)
                }
            });
        });

        this.wireframePrimitive = new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PolylineColorAppearance({
                translucent: false,
                renderState: {
                    depthTest: { enabled: false },
                    depthMask: false
                }
            }),
            asynchronous: false 
        });

        viewer.scene.primitives.add(this.wireframePrimitive);

        this.preRenderListener = viewer.scene.preRender.addEventListener(() => {
            if (!this.wireframePrimitive) return; 

            const currentPos = targetEntity.position.getValue(viewer.clock.currentTime);
            const currentOri = targetEntity.orientation.getValue(viewer.clock.currentTime);
            if (currentPos && currentOri) {
                const currentTransform = Cesium.Matrix4.fromRotationTranslation(
                    Cesium.Matrix3.fromQuaternion(currentOri),
                    currentPos
                );
                const deltaTransform = Cesium.Matrix4.multiply(currentTransform, initialInverse, new Cesium.Matrix4());
                this.wireframePrimitive.modelMatrix = deltaTransform;
            }
        });
    },

    // ==========================================
    // CSSプロパティを活用したスマートロック
    // ==========================================
    _lockUI(viewer) {
        // 1. Cesium地球のカメラ操作を停止
        if (viewer && viewer.scene) {
            viewer.scene.screenSpaceCameraController.enableInputs = false;
        }

        // 2. 地球表示エリアをクリックしたときに警告を出す
        const cesiumContainer = document.getElementById('cesiumContainer');
        if (cesiumContainer) {
            cesiumContainer.style.cursor = 'not-allowed';
            this._alertHandler = () => alert('先に視認シミュレーションを解除してください');
            cesiumContainer.addEventListener('click', this._alertHandler);
        }

        // 3. ★修正：index.htmlの構成に合わせて、右側メニュー内のボタンとペグマンを確実に指定
        const menuInteractiveElements = document.querySelectorAll('#cesium-ui button, #cesium-ui #pegman');
        
        menuInteractiveElements.forEach(el => {
            // 「終了ボタン」以外はすべてロックして半透明にする
            if (el.id !== 'btn-visibility-sim') {
                el.style.pointerEvents = 'none'; // クリックもドラッグも物理的に不能にする
                el.style.opacity = '0.4';        // 視覚的に「押せない」ことを示す
            }
        });
    },

    _unlockUI() {
        const viewer = getCesiumViewer();
        if (viewer && viewer.scene) {
            viewer.scene.screenSpaceCameraController.enableInputs = true;
        }

        const cesiumContainer = document.getElementById('cesiumContainer');
        if (cesiumContainer) {
            cesiumContainer.style.cursor = '';
            if (this._alertHandler) {
                cesiumContainer.removeEventListener('click', this._alertHandler);
                this._alertHandler = null;
            }
        }

        // ロックした要素をすべて元に戻す
        const menuInteractiveElements = document.querySelectorAll('#cesium-ui button, #cesium-ui #pegman');
        menuInteractiveElements.forEach(el => {
            el.style.pointerEvents = '';
            el.style.opacity = '';
        });
    }
};

// visibilitySimulator.js の一番最後（オブジェクト定義の外）に追加
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => VisibilitySimulator.init());
} else {
    VisibilitySimulator.init();
}
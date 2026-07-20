// viewManager.js
import * as THREE from 'three';

export const ViewManager = {
    scene: null,
    camera: null,
    renderer: null,
    houseGroup: null,

    subCameras: [],
    humanoids: [],
    labels: [],
    vLine: null,
    hLines: [],

    viewDefs: [
        { name: '北西から', colorHex: 0x0077ff, cssColor: '#0077ff' },
        { name: '北東から', colorHex: 0x22aa22, cssColor: '#22aa22' },
        { name: '南東から', colorHex: 0xffaa00, cssColor: '#ffaa00' },
        { name: '南西から', colorHex: 0xdd3333, cssColor: '#dd3333' }
    ],

    init(params) {
        this.scene = params.scene;
        this.camera = params.camera;
        this.renderer = params.renderer;
        this.houseGroup = params.houseGroup;

        // 全画面化に伴い、サブカメラ用のレイヤー、人型、DOM、サブカメラの初期化処理をスキップします
        // メインカメラはレイヤー1（グリッド・人）も表示する
        // this.camera.layers.enable(1);

        // this.setupHumanoids();
        // this.setupDOM();
        // this.setupSubCameras();
    },

    setupHumanoids() {
        const createHumanoid = (colorHex) => {
            const group = new THREE.Group();
            const bodyMat = new THREE.MeshBasicMaterial({ color: colorHex });
            
            const head = new THREE.Mesh(new THREE.SphereGeometry(100, 16, 16), bodyMat);
            head.position.y = 1600;

            const body = new THREE.Mesh(new THREE.CylinderGeometry(150, 100, 700, 8), bodyMat);
            body.position.y = 1150;

            const legGeo = new THREE.CylinderGeometry(50, 50, 800, 8);
            const legL = new THREE.Mesh(legGeo, bodyMat); legL.position.set(-60, 400, 0);
            const legR = new THREE.Mesh(legGeo, bodyMat); legR.position.set(60, 400, 0);

            [head, body, legL, legR].forEach(m => m.layers.set(1));

            group.add(head, body, legL, legR);
            group.visible = false;
            return group;
        };

        this.humanoids = this.viewDefs.map(def => {
            const h = createHumanoid(def.colorHex);
            this.scene.add(h);
            return h;
        });
    },

    setupDOM() {
        const outerBorder = document.createElement('div');
        Object.assign(outerBorder.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
            border: '2px solid #000', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '5'
        });
        document.body.appendChild(outerBorder);

        this.vLine = document.createElement('div');
        Object.assign(this.vLine.style, {
            position: 'absolute', top: '0', width: '2px', height: '100%',
            backgroundColor: '#000', pointerEvents: 'none', zIndex: '5'
        });
        document.body.appendChild(this.vLine);

        this.hLines = Array.from({length: 3}, () => {
            const hl = document.createElement('div');
            Object.assign(hl.style, {
                position: 'absolute', left: '0', height: '2px',
                backgroundColor: '#000', pointerEvents: 'none', zIndex: '5'
            });
            document.body.appendChild(hl);
            return hl;
        });

        this.labels = this.viewDefs.map(def => {
            const lb = document.createElement('div');
            Object.assign(lb.style, {
                position: 'absolute', background: 'rgba(255, 255, 255, 0.9)',
                padding: '4px 10px', borderRadius: '4px', fontFamily: 'sans-serif',
                fontSize: '12px', fontWeight: 'bold', border: `2px solid ${def.cssColor}`,
                whiteSpace: 'nowrap', zIndex: '10', pointerEvents: 'none', boxShadow: '2px 2px 5px rgba(0,0,0,0.1)'
            });
            lb.innerHTML = `<span style="color:${def.cssColor}">●</span> ${def.name}`;
            document.body.appendChild(lb);
            return lb;
        });
    },

    setupSubCameras() {
        this.subCameras = this.viewDefs.map(() => new THREE.PerspectiveCamera(45, 1.5, 100, 100000));
    },

    updateSubCameras() {
        const box = new THREE.Box3().setFromObject(this.houseGroup);
        if (box.isEmpty()) {
            this.humanoids.forEach(h => h.visible = false);
            return;
        }
        this.humanoids.forEach(h => h.visible = true);

        const center = new THREE.Vector3(); box.getCenter(center);
        const size = new THREE.Vector3(); box.getSize(size);
        
        const fovHalfRad = (45/2) * (Math.PI/180);
        const reqDist = Math.max(size.y / Math.tan(fovHalfRad), Math.max(size.x, size.z) / Math.tan(fovHalfRad)) * 0.8;
        const dist = Math.max(5000, reqDist);
        const offset = dist / Math.sqrt(2);

        const corners = [
            new THREE.Vector3(box.min.x - offset, 1500, box.min.z - offset),
            new THREE.Vector3(box.max.x + offset, 1500, box.min.z - offset),
            new THREE.Vector3(box.max.x + offset, 1500, box.max.z + offset),
            new THREE.Vector3(box.min.x - offset, 1500, box.max.z + offset)
        ];

        this.subCameras.forEach((cam, i) => {
            cam.position.copy(corners[i]);
            cam.lookAt(center);
            this.humanoids[i].position.set(corners[i].x, 0, corners[i].z);
            this.humanoids[i].lookAt(center.x, 0, center.z);
        });
    },

    renderAllViews() {
        const fullW = window.innerWidth;
        const fullH = window.innerHeight;

        // ★UIの中央寄せロジック
        // 画面全体になったので、単純に画面横幅の半分（50%位置）を中心にします
        const mainCenterX = fullW / 2;
        const statusPanel = document.getElementById('status-panel');
        const mainToolbar = document.getElementById('main-toolbar');
        if (statusPanel) statusPanel.style.left = mainCenterX + 'px';
        if (mainToolbar) mainToolbar.style.left = mainCenterX + 'px';

        // シザーテスト（画面分割）を無効化します
        this.renderer.setScissorTest(false);

        // A. メインカメラの描画（描画領域を画面全体に設定）
        this.renderer.setViewport(0, 0, fullW, fullH);
        this.renderer.setScissor(0, 0, fullW, fullH);
        this.renderer.setClearColor(0xf5f5f5);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        
        // ※サブカメラ、人型、分割線の更新処理はすべて削除しました
    }    
};
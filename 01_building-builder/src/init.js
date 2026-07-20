// init.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const AppInit = {
    run() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        // 1. シーンの作成
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf5f5f5);

        // 2. カメラの作成
        // 全画面描画に伴い、サブカメラ用の幅計算を廃止し、ウィンドウ全体の比率でカメラを作成します
        const camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000000);
        camera.position.set(12000, 10000, 15000);

        // 3. レンダラーの作成
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        document.body.appendChild(renderer.domElement);

        // 4. コントロールの設定
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0);
        controls.update(); 

        // 5. グリッドヘルパーの作成
        const gridHelper = new THREE.GridHelper(20000, 40, 0xcccccc, 0xe0e0e0);
        gridHelper.position.y = -1; 
        scene.add(gridHelper);

        // 6. 共通マテリアルの作成
        const materials = {
            wallMat: new THREE.MeshBasicMaterial({ color: 0xe8e8e8, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            activeMat: new THREE.MeshBasicMaterial({ color: 0xcceeff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            selectedMat: new THREE.MeshBasicMaterial({ color: 0xffaaaa, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            roofMat: new THREE.MeshBasicMaterial({ color: 0x555555, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            edgeMat: new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 }),
            hoverMat: new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
        };

        // 7. ホバー用メッシュとハウスグループの作成
        const hoverMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), materials.hoverMat);
        hoverMesh.visible = false;
        scene.add(hoverMesh);

        const houseGroup = new THREE.Group();
        scene.add(houseGroup);

        // 組み立てたパーツをすべてまとめて出力（リターン）する
        return {
            scene,
            camera,
            renderer,
            controls,
            materials,
            hoverMesh,
            houseGroup
        };
    }
};
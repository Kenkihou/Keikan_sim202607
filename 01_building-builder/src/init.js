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
        // ★ 手前の面（near）は 50mm。1mm にすると、1km 先まで映すこの画面では
        //   奥行きの精度が足りず、地面に接する線や板の縁が点線になる。
        //   ⚠️ 対数の深度バッファでも直るが、そちらは polygonOffset が効かなく
        //     なり、壁と同じ面に引いた線（水平庇の付け根など）が今度は点線に
        //     なる。手前を切る方が副作用が無い。
        const camera = new THREE.PerspectiveCamera(45, width / height, 50, 1000000);
        camera.position.set(12000, 10000, 15000);

        // 3. レンダラーの作成
        //   ★ preserveDrawingBuffer は【画面の絵をあとから取り出す】ため。
        //     手順書のスクリーンショットや、画像コピーに要る。
        //   ⚠️ logarithmicDepthBuffer は使わない。奥行きの精度は上がるが、
        //     polygonOffset が効かなくなり、壁と同じ面に引いた線（水平庇の
        //     付け根など）が点線になる。精度は near を上げて稼ぐ（上を参照）。
        const renderer = new THREE.WebGLRenderer({
            antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(width, height);
        document.body.appendChild(renderer.domElement);

        // 4. コントロールの設定
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0);
        controls.update(); 

        // 5. 方眼の作成。
        //   ★ 方眼の目はスナップ幅と同じにする。目盛りと吸い付きが食い違うと、
        //     どこに置いたのかが読めない。
        //   ⚠️ 10mm では線が細かすぎて面になってしまう。そのときは方眼をやめ、
        //     原点を通る X（東西）と Z（南北）の2本だけを残す。
        const GRID_SPAN = 20000;                      // 方眼の一辺[mm]
        let gridHelper = null, axisLines = null;
        const setGrid = (step) => {
            if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper = null; }
            if (axisLines) { scene.remove(axisLines); axisLines.geometry.dispose(); axisLines = null; }
            if (step >= 100) {
                gridHelper = new THREE.GridHelper(GRID_SPAN, Math.round(GRID_SPAN / step),
                    0xcccccc, 0xe0e0e0);
                // ⚠️ 方眼は【少し下】に敷く。同じ高さだと、地面に接する建物の線と
                //   奥行きを取り合って線が途切れる。
                gridHelper.position.y = -20;
                scene.add(gridHelper);
                return;
            }
            const H = GRID_SPAN / 2;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(
                [-H, 0, 0, H, 0, 0, 0, 0, -H, 0, 0, H], 3));
            axisLines = new THREE.LineSegments(g,
                new THREE.LineBasicMaterial({ color: 0xbbbbbb }));
            axisLines.position.y = -20;
            scene.add(axisLines);
        };
        // ⚠️ 張り替えたら描き直しを頼む。この画面は動きがあるときだけ描くので、
        //   頼まないと次に画面が動くまで前の方眼のままになる。
        const setGridAndDraw = (step) => { setGrid(step); window.renderAllViews?.(); };
        setGrid(500);
        // スナップ幅を変えたら方眼も張り替える（interactionHandler から呼ぶ）。
        window.setSnapGrid = setGridAndDraw;

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
// ys_env_builder.js
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

export function buildNightEnvironment(scene) {
    // --- 1. 京都風・U字溝護岸構造 パラメータ ---
    const riverWidth = 7.0;
    const wallThickness = 0.5;
    const riverDepth = 1.5;
    const totalLength = 50.0; // 少し長めに確保
    const riverZ = 13.0;
    const wallAngleDeg = 30.0;

    // 地盤。純白(反射率1.0)だと画面内で最も明るい大面積が地面になり、白い外壁と同じ明るさで並んでしまう。
    // 実際の舗装・土は白漆喰の 1/4 程度。ただし「陰影なし」モードでは図面的な読みやすさを優先したいので、
    // 実際の色はモードごとに ys_main 側から差し替える（そのため roadMat を返す）
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.95 });
    
    // --- 2. カスタム護岸マテリアル ---
    const wallMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x999999, roughness: 0.9, metalness: 0.0
    });
    wallMaterial.shadowSide = THREE.DoubleSide;

    wallMaterial.onBeforeCompile = (shader) => {
        shader.vertexShader = `
        varying vec3 vWorldPos;
        varying vec3 wNormal;
    ` + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        // 影の有無で消滅する worldPosition は使わず、独自に計算する
        vec4 customWorldPosition = modelMatrix * vec4( transformed, 1.0 );
        vWorldPos = customWorldPosition.xyz;
        
        wNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
        `
    );

        shader.fragmentShader = `
            varying vec3 vWorldPos;
            varying vec3 wNormal;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
            
            float smoothNoise(vec2 p) {
                vec2 i = floor(p); vec2 f = fract(p);
                f = f*f*(3.0-2.0*f);
                float a = hash(i); float b = hash(i + vec2(1.0, 0.0));
                float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }

            vec3 getStonePattern(vec3 pos, vec3 norm) {
                vec2 uv = (abs(norm.z) > 0.5) ? pos.xy : pos.zy;
                float stoneWidth = 0.5; float stoneHeight = 0.35;
                
                vec2 edgeNoise = vec2(
                    smoothNoise(uv * 3.0) * 0.07 + smoothNoise(uv * 8.0) * 0.02,
                    smoothNoise(uv * 3.5 + 5.0) * 0.07 + smoothNoise(uv * 9.0) * 0.02
                );
                uv += edgeNoise;

                float rowId = floor(uv.y / stoneHeight);
                uv.x += mod(rowId, 2.0) * (stoneWidth * 0.5);

                vec2 gridPos = vec2(uv.x / stoneWidth, uv.y / stoneHeight);
                vec2 stoneId = floor(gridPos);
                vec2 localUV = fract(gridPos);

                float borderX = smoothstep(0.0, 0.06, localUV.x) * smoothstep(1.0, 0.94, localUV.x);
                float borderY = smoothstep(0.0, 0.08, localUV.y) * smoothstep(1.0, 0.92, localUV.y);
                float jointMask = borderX * borderY;

                float dome = sin(localUV.x * 3.14159) * sin(localUV.y * 3.14159);
                return vec3(jointMask, hash(stoneId), dome);
            }
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
            #include <color_fragment>
            vec3 stoneData = getStonePattern(vWorldPos, normalize(wNormal));
            float joint = stoneData.x; float stoneSeed = stoneData.y;

            float brightness = 0.85 + stoneSeed * 0.3;
            diffuseColor.rgb *= brightness;

            if (stoneSeed > 0.75) diffuseColor.rgb *= vec3(0.92, 0.88, 0.82); 
            if (stoneSeed < 0.15) diffuseColor.rgb *= vec3(0.85, 0.92, 0.85); 

            vec3 jointColor = diffuseColor.rgb * 0.25; 
            diffuseColor.rgb = mix(jointColor, diffuseColor.rgb, joint);
            `
        );

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            `
            #include <normal_fragment_maps>
            float delta = 0.01; vec3 nVal = normalize(wNormal);
            
            vec3 sC = getStonePattern(vWorldPos, nVal);
            vec3 sR = getStonePattern(vWorldPos + vec3(delta, 0.0, 0.0), nVal);
            vec3 sU = getStonePattern(vWorldPos + vec3(0.0, delta, 0.0), nVal);
            if(abs(nVal.z) < 0.5) sU = getStonePattern(vWorldPos + vec3(0.0, 0.0, delta), nVal);

            float hC = (sC.x * 0.8) + (sC.z * 0.15) + (hash(vWorldPos.xy * 120.0) * 0.015);
            float hR = (sR.x * 0.8) + (sR.z * 0.15);
            float hU = (sU.x * 0.8) + (sU.z * 0.15);

            float dX = (hR - hC) * 2.5; float dY = (hU - hC) * 2.5;

            vec3 perturbedNormal = nVal;
            if (abs(nVal.z) > 0.5) perturbedNormal += vec3(-dX, -dY, 0.0);
            else perturbedNormal += vec3(0.0, -dY, -dX);
            
            normal = normalize((viewMatrix * vec4(normalize(perturbedNormal), 0.0)).xyz);
            `
        );
    };

    // --- 3. 地盤の配置 ---
    const groundLeftWidth = 250 - (totalLength / 2);
    const groundLeftGeo = new THREE.PlaneGeometry(groundLeftWidth, 500);
    const groundLeft = new THREE.Mesh(groundLeftGeo, roadMat);
    groundLeft.rotation.x = -Math.PI / 2;
    groundLeft.position.set(-(totalLength / 2) - (groundLeftWidth / 2), 0, 0);
    groundLeft.receiveShadow = true;
    scene.add(groundLeft);

    const groundRightWidth = 250 - (totalLength / 2);
    const groundRightGeo = new THREE.PlaneGeometry(groundRightWidth, 500);
    const groundRight = new THREE.Mesh(groundRightGeo, roadMat);
    groundRight.rotation.x = -Math.PI / 2;
    groundRight.position.set((totalLength / 2) + (groundRightWidth / 2), 0, 0);
    groundRight.receiveShadow = true;
    scene.add(groundRight);

    const groundCenterBackGeo = new THREE.PlaneGeometry(totalLength, 250);
    const groundCenterBack = new THREE.Mesh(groundCenterBackGeo, roadMat);
    groundCenterBack.rotation.x = -Math.PI / 2;
    groundCenterBack.position.set(0, 0, riverZ - (riverWidth / 2 + wallThickness) - 125);
    groundCenterBack.receiveShadow = true;
    scene.add(groundCenterBack);

    const groundCenterFrontGeo = new THREE.PlaneGeometry(totalLength, 250);
    const groundCenterFront = new THREE.Mesh(groundCenterFrontGeo, roadMat);
    groundCenterFront.rotation.x = -Math.PI / 2;
    groundCenterFront.position.set(0, 0, riverZ + (riverWidth / 2 + wallThickness) + 125);
    groundCenterFront.receiveShadow = true;
    scene.add(groundCenterFront);

    // --- 4. 護岸壁の生成 ---
    const rad = (wallAngleDeg * Math.PI) / 180;
    const wallOffsetAtBottom = riverDepth * Math.tan(rad);

    const shapeBack = new THREE.Shape();
    shapeBack.moveTo(0, 0);
    shapeBack.lineTo(wallThickness, 0);
    shapeBack.lineTo(wallThickness, -riverDepth);
    shapeBack.lineTo(-wallOffsetAtBottom, -riverDepth);
    shapeBack.lineTo(0, 0);

    const shapeFront = new THREE.Shape();
    shapeFront.moveTo(0, 0);
    shapeFront.lineTo(-wallThickness, 0);
    shapeFront.lineTo(-wallThickness, -riverDepth);
    shapeFront.lineTo(wallOffsetAtBottom, -riverDepth);
    shapeFront.lineTo(0, 0);

    const extrudeSettings = { steps: 1, depth: totalLength, bevelEnabled: false };

    const wallBackGeo = new THREE.ExtrudeGeometry(shapeBack, extrudeSettings);
    const wallBack = new THREE.Mesh(wallBackGeo, wallMaterial);
    wallBack.castShadow = true; wallBack.receiveShadow = true;
    wallBack.rotation.y = Math.PI / 2;
    wallBack.position.set(-totalLength / 2, 0, riverZ - riverWidth / 2);
    scene.add(wallBack);

    const wallFrontGeo = new THREE.ExtrudeGeometry(shapeFront, extrudeSettings);
    const wallFront = new THREE.Mesh(wallFrontGeo, wallMaterial);
    wallFront.castShadow = true; wallFront.receiveShadow = true;
    wallFront.rotation.y = Math.PI / 2;
    wallFront.position.set(-totalLength / 2, 0, riverZ + riverWidth / 2);
    scene.add(wallFront);

    // --- 5. かまぼこ型道路の生成 ---
    const roadWidth = 3.7;
    const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.85, metalness: 0.05 });

    roadMaterial.onBeforeCompile = (shader) => {
        shader.vertexShader = `
            varying vec2 vRoadUv;
        ` + shader.vertexShader.replace(
            '#include <uv_vertex>',
            `
            #include <uv_vertex>
            vRoadUv = uv;
            `
        );
        
        shader.fragmentShader = `
            varying vec2 vRoadUv;
        ` + shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
            #include <color_fragment>
            float linePos1 = 0.12; 
            float linePos2 = 0.88; 
            float lineWidth = 0.02; 
            
            float line1 = smoothstep(lineWidth + 0.002, lineWidth, abs(vRoadUv.y - linePos1));
            float line2 = smoothstep(lineWidth + 0.002, lineWidth, abs(vRoadUv.y - linePos2));
            float lineMask = clamp(line1 + line2, 0.0, 1.0);
            
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.9, 0.92), lineMask);
            `
        );
    };

    const roadWidthSegments = 16;
    const roadGeometry = new THREE.PlaneGeometry(totalLength, roadWidth, 1, roadWidthSegments);
    const roadPosAttr = roadGeometry.attributes.position;
    for (let i = 0; i < roadPosAttr.count; i++) {
        const y = roadPosAttr.getY(i); 
        const maxBulge = 0.05; 
        const bulge = (1.0 - Math.pow(y / (roadWidth / 2), 2)) * maxBulge;
        roadPosAttr.setZ(i, bulge);
    }
    roadGeometry.computeVertexNormals(); 

    const roadBack = new THREE.Mesh(roadGeometry, roadMaterial);
    roadBack.rotation.x = -Math.PI / 2; 
    roadBack.receiveShadow = true;      
    roadBack.castShadow = true;
    roadBack.position.set(0, 0.001, riverZ - riverWidth / 2 - roadWidth / 2);
    scene.add(roadBack);

    // --- 6. 川の底板 ---
    const bottomWidth = riverWidth + wallThickness * 2 - wallOffsetAtBottom * 2;
    const bottomGeo = new THREE.PlaneGeometry(totalLength, Math.max(0.1, bottomWidth));
    const bottom = new THREE.Mesh(bottomGeo, wallMaterial);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(0, -riverDepth + 0.01, riverZ); 
    bottom.receiveShadow = true;
    scene.add(bottom);

    // --- 7. 水面と波の生成 ---
    const waterGeometry = new THREE.PlaneGeometry(totalLength, riverWidth, 80, 20);
    const posAttr = waterGeometry.attributes.position;
    const initialVertices = [];
    for (let i = 0; i < posAttr.count; i++) {
        initialVertices.push({ x: posAttr.getX(i), y: posAttr.getY(i), z: posAttr.getZ(i) });
    }

    const animateWaterMeshVertices = (geometry, time) => {
        const pos = geometry.attributes.position;
        const t1 = time * 1.3; const t2 = time * 2.1; const t3 = time * 0.7;
        for (let i = 0; i < pos.count; i++) {
            const init = initialVertices[i];
            const baseWave = Math.sin(init.x * 0.8 + t1) * Math.cos(init.y * 0.6 + t1 * 0.5) * 0.03;
            const crossWave = Math.sin((init.x + init.y) * 2.3 - t2) * 0.01;
            const noiseWave = Math.sin(init.x * 5.5 + t3) * Math.cos(init.y * 6.2 - t2) * 0.004;
            pos.setZ(i, init.z + baseWave + crossWave + noiseWave);
        }
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    };

    // 水面法線マップ。
    // 以前は sin/cos をそのまま並べていたため、波紋を細かくすると格子模様の繰り返しが露見した。
    // 周期付き格子ノイズを数オクターブ重ね、継ぎ目なく繰り返しつつ規則性の見えない高さ場を作る。
    const createWaterNormalTexture = () => {
        const SIZE = 256;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(SIZE, SIZE);

        const hash = (x, y, seed) => {
            const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
            return n - Math.floor(n);
        };
        const fade = (t) => t * t * (3.0 - 2.0 * t);

        // period で格子点を折り返すので、テクスチャの端が必ず繋がる
        const noise = (x, y, period, seed) => {
            const xi = Math.floor(x), yi = Math.floor(y);
            const u = fade(x - xi), v = fade(y - yi);
            const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
            const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
            const top = hash(x0, y0, seed) + (hash(x1, y0, seed) - hash(x0, y0, seed)) * u;
            const bot = hash(x0, y1, seed) + (hash(x1, y1, seed) - hash(x0, y1, seed)) * u;
            return top + (bot - top) * v;
        };

        const octaves = [{ p: 4, a: 1.0 }, { p: 8, a: 0.5 }, { p: 16, a: 0.25 }, { p: 32, a: 0.125 }];
        const height = new Float32Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                let h = 0;
                for (const o of octaves) {
                    h += noise((x / SIZE) * o.p, (y / SIZE) * o.p, o.p, o.p) * o.a;
                }
                height[y * SIZE + x] = h;
            }
        }

        // 高さ場の傾きから接空間法線を作る（Water シェーダーは R を x、G を z、B を上として読む）
        const at = (x, y) => height[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)];
        const strength = 2.5;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
                const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
                const len = Math.sqrt(dx * dx + dy * dy + 1.0);
                const i = (y * SIZE + x) * 4;
                imgData.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
                imgData.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
                imgData.data[i + 2] = Math.round((1.0 / len * 0.5 + 0.5) * 255);
                imgData.data[i + 3] = 255;
            }
        }

        ctx.putImageData(imgData, 0, 0);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
        return tex;
    };

    const water = new Water(waterGeometry, {
        // 反射は専用のレンダーターゲットに描いたものを貼り付けている。
        // 512では建物の輪郭が潰れるため、解像度を上げて像を読めるようにする
        textureWidth: 1024, textureHeight: 1024,
        waterNormals: createWaterNormalTexture(),
        sunDirection: new THREE.Vector3(15, 25, 12).normalize(), // ※夜間側はライトが動的に回るので初期値のみ
        sunColor: 0xffffff, waterColor: 0x0a1c15,
        // シェーダー内の歪み量は distortionScale * (0.001 + 1/視点距離) で、
        // 1.5 だと10m先でも画面の7%以上ずれて像が原形を留めない。
        // 流れの緩い掘割として、映り込みが判別できる範囲まで落とす
        distortionScale: 0.4,
        fog: scene.fog !== undefined
    });

    // 法線ノイズのスケール。既定の 1.0 では波紋の周期が約100mになり、
    // 細かいさざ波ではなく大きなうねりとして反射を歪めてしまう
    water.material.uniforms['size'].value = 20.0;
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -riverDepth + 0.15, riverZ); 
    scene.add(water);

    animateWaterMeshVertices(waterGeometry, 42.0);

    return { water, roadMat };
}
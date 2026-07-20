// ms_env_builder.js
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

export function buildEnvironment(scene) {
    // --- 1. 空と雲の生成 ---
    function createSkyBox() {
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
        const skyGeo = new THREE.SphereGeometry(80, 32, 32);
        const skyMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide });
        return new THREE.Mesh(skyGeo, skyMat);
    }
    scene.add(createSkyBox());

    // --- 2. 京都風・U字溝護岸構造 パラメータ ---
    const riverWidth = 7.0;
    const wallThickness = 0.5;
    const riverDepth = 1.5;
    const totalLength = 30.0;
    const riverZ = 13.0;
    const wallAngleDeg = 30.0;

    const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    
    // --- 3. カスタム護岸マテリアル ---
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
            vWorldPos = worldPosition.xyz;
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

    // --- 4. 地盤の配置 ---
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

    // --- 5. 護岸壁の生成 ---
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
    wallBack.layers.set(1);
    scene.add(wallBack);

    const wallFrontGeo = new THREE.ExtrudeGeometry(shapeFront, extrudeSettings);
    const wallFront = new THREE.Mesh(wallFrontGeo, wallMaterial);
    wallFront.castShadow = true; wallFront.receiveShadow = true;
    wallFront.rotation.y = Math.PI / 2;
    wallFront.position.set(-totalLength / 2, 0, riverZ + riverWidth / 2);
    wallFront.layers.set(1);
    scene.add(wallFront);

    // --- 6. かまぼこ型道路の生成 ---
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
    roadBack.layers.set(0);
    scene.add(roadBack);

    // --- 7. 川の底板 ---
    const bottomWidth = riverWidth + wallThickness * 2 - wallOffsetAtBottom * 2;
    const bottomGeo = new THREE.PlaneGeometry(totalLength, Math.max(0.1, bottomWidth));
    const bottom = new THREE.Mesh(bottomGeo, wallMaterial);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(0, -riverDepth + 0.01, riverZ); 
    bottom.receiveShadow = true;
    scene.add(bottom);

    // --- 8. 水面と波の生成 ---
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

    const createSimpleWaterNormal = () => {
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d'); const imgData = ctx.createImageData(256, 256);
        for (let y = 0; y < 256; y++) {
            for (let x = 0; x < 256; x++) {
                const i = (y * 256 + x) * 4;
                const nx = (Math.sin(x * 0.4) + Math.cos(y * 0.4)) * 15 + 128;
                const ny = (Math.cos(x * 0.4) + Math.sin(y * 0.4)) * 15 + 128;
                imgData.data[i] = Math.max(0, Math.min(255, nx)); imgData.data[i + 1] = Math.max(0, Math.min(255, ny));
                imgData.data[i + 2] = 255; imgData.data[i + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        const tex = new THREE.CanvasTexture(canvas); tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
        return tex;
    };

    const water = new Water(waterGeometry, {
        textureWidth: 512, textureHeight: 512,
        waterNormals: createSimpleWaterNormal(),
        sunDirection: new THREE.Vector3(15, 25, 12).normalize(),
        sunColor: 0xffffff, waterColor: 0x0a1c15, distortionScale: 1.5,
        fog: scene.fog !== undefined
    });
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -riverDepth + 0.15, riverZ); 
    scene.add(water);

    // 水面の波形を1回だけ静的に計算しておく
    animateWaterMeshVertices(waterGeometry, 42.0);

    // --- 9. ライティング（環境光と平行光源） ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.95); 
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.15); 
    dirLight.position.set(15, 25, 12);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 60;
    const d = 20;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // メインループでの太陽光同期用にdirLightを返す
    return { dirLight };
}
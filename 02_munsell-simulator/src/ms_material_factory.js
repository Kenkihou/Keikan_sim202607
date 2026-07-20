// ms_material_factory.js
import * as THREE from 'three';

const baseTextureLoader = new THREE.TextureLoader();

// 砂壁・杉板マテリアル用のキャッシュ
const customTextures = {
    sunakabe: baseTextureLoader.load(`${import.meta.env.BASE_URL}sunakabe_r.png`),
    sugi1: baseTextureLoader.load(`${import.meta.env.BASE_URL}sugi_mask1.png`),
    sugi2: baseTextureLoader.load(`${import.meta.env.BASE_URL}sugi_mask2.png`),
    sugi3: baseTextureLoader.load(`${import.meta.env.BASE_URL}sugi_mask3.png`),
    sugi4: baseTextureLoader.load(`${import.meta.env.BASE_URL}sugi_mask4.png`)
};

customTextures.sunakabe.wrapS = THREE.RepeatWrapping;
customTextures.sunakabe.wrapT = THREE.RepeatWrapping;

// すべての杉板テクスチャにリピート設定を適用
for (let i = 1; i <= 4; i++) {
    const tex = customTextures[`sugi${i}`];
    if (tex) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
    }
}

// つや消しメタリック専用の疑似環境マップ（空と地面のダミー景色）
const createMetallicEnvMap = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    const skyGrad = ctx.createLinearGradient(0, 0, 0, 128);
    skyGrad.addColorStop(0.0, '#ffffff');
    skyGrad.addColorStop(1.0, '#b0cfff');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, 512, 128);
    
    const groundGrad = ctx.createLinearGradient(0, 128, 0, 256);
    groundGrad.addColorStop(0.0, '#999999');
    groundGrad.addColorStop(1.0, '#333333');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, 128, 512, 128);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
};

const metallicEnvMap = createMetallicEnvMap();

// ガラスの歪み（うねり）を表現する法線マップ
const createGlassNormalMap = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    
    for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
            const i = (y * 256 + x) * 4;
            const nx = Math.sin(x * 0.12) * 30 + 128; 
            const ny = Math.sin(y * 0.12) * 30 + 128; 
            imgData.data[i]     = nx;
            imgData.data[i + 1] = ny;
            imgData.data[i + 2] = 255;
            imgData.data[i + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
};

const glassNormalMap = createGlassNormalMap();

export function applyCustomTexture(material) {
    const texType = material.userData.texType || 'none';
    const currentColor = material.color ? material.color.clone() : new THREE.Color('#ffffff');
    const matName = material.name || ""; 

    const isTextureMissing = (texType === 'sunakabe' && !customTextures.sunakabe) || 
                             (texType === 'sugi' && !customTextures.sugi1);

    if (texType === 'none' || isTextureMissing) {
        if (material.userData.isCustomized) {
            const standardMat = new THREE.MeshStandardMaterial({
                color: currentColor,
                roughness: 0.9,
                metalness: 0.1
            });
            standardMat.userData = { ...material.userData, texType: 'none', isCustomized: false };
            standardMat.name = matName; 
            return standardMat;
        }
        return material;
    }

    if (texType === 'sunakabe') {
        const tex = customTextures.sunakabe;
        const sunakabeMat = new THREE.MeshStandardMaterial({
            color: currentColor,
            roughness: 0.9,
            metalness: 0.1
        });
        
        sunakabeMat.userData = { ...material.userData, texType: 'sunakabe', isCustomized: true };
        sunakabeMat.customProgramCacheKey = () => 'sunakabe';
        sunakabeMat.name = matName;

        sunakabeMat.onBeforeCompile = (shader) => {
            shader.uniforms.tMask = { value: tex };
            shader.uniforms.texScale = { value: 1.0 };
            shader.uniforms.uBumpDepth = { value: 20.0 };
            shader.uniforms.uShadowDarkness = { value: 0.0 };
            shader.uniforms.uContrastMin = { value: 0.44 };
            shader.uniforms.uContrastMax = { value: 0.45 };

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
                uniform sampler2D tMask;
                uniform float texScale;
                uniform float uBumpDepth;
                uniform float uShadowDarkness;
                uniform float uContrastMin;
                uniform float uContrastMax;
                varying vec3 vWorldPos;
                varying vec3 wNormal;

                float getProjection(sampler2D tex, vec3 pos, vec3 norm, float scale) {
                    vec3 absNorm = abs(norm);
                    vec2 uv;
                    if (absNorm.y > absNorm.x && absNorm.y > absNorm.z) {
                        uv = pos.xz;
                    } else if (absNorm.x > absNorm.z) {
                        uv = pos.zy;
                    } else {
                        uv = pos.xy;
                    }
                    return texture2D(tex, uv * scale).r;
                }
            ` + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <color_fragment>',
                `
                #include <color_fragment>
                float hC = getProjection(tMask, vWorldPos, normalize(wNormal), texScale);
                vec3 customShadowColor = diffuseColor.rgb * uShadowDarkness;
                diffuseColor.rgb = mix(customShadowColor, diffuseColor.rgb, smoothstep(uContrastMin, uContrastMax, hC));
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_maps>',
                `
                #include <normal_fragment_maps>
                float texelSize = 0.002;
                vec3 normVec = normalize(wNormal);
                vec3 absN = abs(normVec);
                float hC_b = getProjection(tMask, vWorldPos, normVec, texScale);
                float hR, hU;
                if (absN.y > absN.x && absN.y > absN.z) {
                    hR = getProjection(tMask, vWorldPos + vec3(texelSize, 0.0, 0.0), normVec, texScale);
                    hU = getProjection(tMask, vWorldPos + vec3(0.0, 0.0, texelSize), normVec, texScale);
                } else if (absN.x > absN.z) {
                    hR = getProjection(tMask, vWorldPos + vec3(0.0, 0.0, texelSize), normVec, texScale);
                    hU = getProjection(tMask, vWorldPos + vec3(0.0, texelSize, 0.0), normVec, texScale);
                } else {
                    hR = getProjection(tMask, vWorldPos + vec3(texelSize, 0.0, 0.0), normVec, texScale);
                    hU = getProjection(tMask, vWorldPos + vec3(0.0, texelSize, 0.0), normVec, texScale);
                }
                float dX = (hR - hC_b) * uBumpDepth;
                float dY = (hU - hC_b) * uBumpDepth;
                vec3 modifiedWorldNormal = normVec;
                if (absN.y > absN.x && absN.y > absN.z) {
                    modifiedWorldNormal += vec3(dX, 0.0, dY);
                } else if (absN.x > absN.z) {
                    modifiedWorldNormal += vec3(0.0, dY, dX);
                } else {
                    modifiedWorldNormal += vec3(dX, dY, 0.0);
                }
                normal = normalize((viewMatrix * vec4(normalize(modifiedWorldNormal), 0.0)).xyz);
                `
            );
        };
        return sunakabeMat;
    }

    if (texType === 'sugi') {
        const sugiMat = new THREE.MeshStandardMaterial({
            color: currentColor,
            roughness: 0.85,
            metalness: 0.1
        });
        
        sugiMat.userData = { ...material.userData, texType: 'sugi', isCustomized: true };
        sugiMat.customProgramCacheKey = () => 'sugi';
        sugiMat.name = matName;

        const isWall = matName.toLowerCase().includes("wall");

        sugiMat.onBeforeCompile = (shader) => {
            shader.uniforms.tMask1 = { value: customTextures.sugi1 };
            shader.uniforms.tMask2 = { value: customTextures.sugi2 };
            shader.uniforms.tMask3 = { value: customTextures.sugi3 };
            shader.uniforms.tMask4 = { value: customTextures.sugi4 };
            shader.uniforms.uIsWall = { value: isWall ? 1.0 : 0.0 };

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
                uniform sampler2D tMask1;
                uniform sampler2D tMask2;
                uniform sampler2D tMask3;
                uniform sampler2D tMask4;
                uniform float uIsWall;
                varying vec3 vWorldPos;
                varying vec3 wNormal;

                vec3 hash32(vec2 p) {
                    vec3 p3 = fract(vec3(p.xyx) * vec3(443.897, 441.423, 437.195));
                    p3 += dot(p3, p3.yxz + 19.19);
                    return fract((p3.xxy + p3.yzz) * p3.zyx);
                }
            ` + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <color_fragment>',
                `
                #include <color_fragment>
                vec3 absNorm = abs(wNormal);
                vec2 projPos;
                
                if (absNorm.y > absNorm.x && absNorm.y > absNorm.z) {
                    projPos = vWorldPos.xz;
                } else if (absNorm.x > absNorm.z) {
                    projPos = vec2(vWorldPos.z, vWorldPos.y);
                } else {
                    projPos = vec2(vWorldPos.x, vWorldPos.y);
                }

                float boardWidth = 0.2;
                float boardHeight = 2.0;

                vec2 gridPos = vec2(projPos.x / boardWidth, projPos.y / boardHeight);
                vec2 gridId = floor(gridPos);
                vec2 plankUV = fract(gridPos);

                vec3 rand = hash32(gridId);

                if (rand.x > 0.5) plankUV.x = 1.0 - plankUV.x;
                if (rand.y > 0.5) plankUV.y = 1.0 - plankUV.y;

                float m1 = texture2D(tMask1, plankUV).r;
                float m2 = texture2D(tMask2, plankUV).r;
                float m3 = texture2D(tMask3, plankUV).r;
                float m4 = texture2D(tMask4, plankUV).r;

                float maskValue = m1;
                if (rand.z > 0.25 && rand.z <= 0.50) maskValue = m2;
                else if (rand.z > 0.50 && rand.z <= 0.75) maskValue = m3;
                else if (rand.z > 0.75) maskValue = m4;

                float edgeMask = 1.0; 

                if (uIsWall > 0.5) {
                    float borderX = smoothstep(0.0, 0.08, fract(gridPos.x)) * smoothstep(1.0, 0.92, fract(gridPos.x));
                    float borderY = smoothstep(0.0, 0.0035, fract(gridPos.y)) * smoothstep(1.0, 0.9965, fract(gridPos.y));
                    edgeMask = mix(0.1, 1.0, borderX * borderY);
                }

                vec3 customLineColor = diffuseColor.rgb * 0.3;
                vec3 woodColor = mix(customLineColor, diffuseColor.rgb, maskValue);
                diffuseColor.rgb = mix(customLineColor, woodColor, edgeMask);
                `
            );
        };
        return sugiMat;
    }

    if (texType === 'metallic') {
        const metallicMat = new THREE.MeshStandardMaterial({
            color: currentColor,
            roughness: 0.6,
            metalness: 1.00,
            envMap: metallicEnvMap,
            envMapIntensity: 0.5
        });
        metallicMat.userData = { ...material.userData, texType: 'metallic', isCustomized: true };
        metallicMat.name = matName;
        return metallicMat;
    }

    if (texType === 'glass') {
        const glassMat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color('#bce2ff'),
            transmission: 0.9,
            ior: 1.54,
            thickness: 0.15,
            roughness: 0.3,
            metalness: 0.00,
            envMap: metallicEnvMap,
            envMapIntensity: 2.5,
            normalMap: glassNormalMap,
            normalScale: new THREE.Vector2(0.6, 0.6)
        });        
        glassMat.userData = { ...material.userData, texType: 'glass', isCustomized: true };
        glassMat.name = matName;        
        return glassMat;
    }

    return material;
}
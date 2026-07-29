import * as THREE from 'three';

export const ambientLight = new THREE.AmbientLight(0x1a237e, 0.1);
export const moonLight = new THREE.DirectionalLight(0x77aaff, 30.0);
// 夜間のフィル光。
// 以前は月と正反対かつ地面より下(y=-10)から差す平行光だったため、月光が届かない壁面が
// 「地面に落ちる影と逆向き」に明るくなり、陰影の辻褄が合わなくなっていた。
// 実際の夜のフィルは空全体からの散乱光なので、方向性を持たない半球光に置き換える。
export const skyFillLight = new THREE.HemisphereLight(0x77aaff, 0x14161c, 0.0);
export const sunLight = new THREE.DirectionalLight(0xffffff, 0.0);

export function initLights(scene) {
    scene.add(ambientLight);

    moonLight.position.set(15, 20, 10);
    // 夜間に影が一切落ちていなかったため、月光にシャドウマップを持たせる。
    // 実際の月光は太陽と視直径がほぼ同じで影の輪郭は硬いので、太陽と同等の設定で構わない。
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.width = 2048;
    moonLight.shadow.mapSize.height = 2048;
    moonLight.shadow.camera.near = 0.5;
    moonLight.shadow.camera.far = 120;
    const mCamDist = 45;
    moonLight.shadow.camera.left = -mCamDist;
    moonLight.shadow.camera.right = mCamDist;
    moonLight.shadow.camera.top = mCamDist;
    moonLight.shadow.camera.bottom = -mCamDist;
    moonLight.shadow.bias = -0.0006;
    moonLight.shadow.normalBias = 0.02;
    moonLight.shadow.radius = 2.0; // 月光の影は輪郭が硬いので、ぼかしは最小限に留める
    scene.add(moonLight);

    // 半球光の「上」軸。空側の色を天頂から、地面側の色を足元から回り込ませる
    skyFillLight.position.set(0, 1, 0);
    scene.add(skyFillLight);

    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 100;
    const sCamDist = 45;
    sunLight.shadow.camera.left = -sCamDist;
    sunLight.shadow.camera.right = sCamDist;
    sunLight.shadow.camera.top = sCamDist;
    sunLight.shadow.camera.bottom = -sCamDist;
    sunLight.shadow.bias = -0.0008;
    sunLight.shadow.normalBias = 0.02; // ソフトシャドウ化に伴うシャドウアクネ対策
    sunLight.shadow.radius = 1.5;
    scene.add(sunLight);
}

export function updateNightTint(blueness, currentMode) {
    const moonNeutral = new THREE.Color(0xffffff);
    const moonBlue = new THREE.Color(0x77aaff);
    
    moonLight.color.copy(moonNeutral).lerp(moonBlue, blueness);
    skyFillLight.color.copy(moonNeutral).lerp(moonBlue, blueness);

    const ambientNeutral = new THREE.Color(0x222222);
    const ambientBlue = new THREE.Color(0x1a237e);
    
    if (currentMode === 3) {
        ambientLight.color.copy(ambientNeutral).lerp(ambientBlue, blueness);
    }
}

// 色温度(K)を RGB に変換して target に書き込む。
// 窓ごとに違う色温度を割り当てられるよう、適用先を持たない純粋な変換関数として切り出している。
export function kelvinToColor(kelvin, target = new THREE.Color()) {
    let temp = THREE.MathUtils.clamp(kelvin, 1000, 12000) / 100;
    let r, g, b;

    if (temp <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(temp) - 161.1195681661;
        b = temp <= 19 ? 0 : (138.5177312231 * Math.log(temp - 10) - 305.0447927307);
    } else {
        r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
        b = 255;
    }
    const clamp = (c) => Math.max(0, Math.min(255, c));
    let rNorm = clamp(r) / 255; let gNorm = clamp(g) / 255; let bNorm = clamp(b) / 255;

    if (kelvin < 4000) {
        const factor = (4000 - kelvin) / 1500; 
        gNorm = gNorm * (1.0 - (0.2 * factor)); bNorm = bNorm * (1.0 - (0.5 * factor)); 
    }

    const luminance = 0.299 * rNorm + 0.587 * gNorm + 0.114 * bNorm;
    if (luminance > 0) {
        const boost = 1.0 / luminance;
        rNorm *= boost; gNorm *= boost; bNorm *= boost;
    }

    return target.setRGB(rNorm, gNorm, bNorm);
}
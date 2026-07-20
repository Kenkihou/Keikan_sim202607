import * as THREE from 'three';
import { windowMat } from './ys_material.js';

export const ambientLight = new THREE.AmbientLight(0x1a237e, 0.1);
export const moonLight = new THREE.DirectionalLight(0x77aaff, 30.0);
export const moonFillLight = new THREE.DirectionalLight(0x77aaff, 0.0);
export const sunLight = new THREE.DirectionalLight(0xffffff, 0.0);

export function initLights(scene) {
    scene.add(ambientLight);
    
    moonLight.position.set(15, 20, 10);
    scene.add(moonLight);
    
    moonFillLight.position.set(-15, -10, -10);
    scene.add(moonFillLight);
    
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
    scene.add(sunLight);
}

export function updateNightTint(blueness, currentMode) {
    const moonNeutral = new THREE.Color(0xffffff);
    const moonBlue = new THREE.Color(0x77aaff);
    
    moonLight.color.copy(moonNeutral).lerp(moonBlue, blueness);
    moonFillLight.color.copy(moonNeutral).lerp(moonBlue, blueness);

    const ambientNeutral = new THREE.Color(0x222222);
    const ambientBlue = new THREE.Color(0x1a237e);
    
    if (currentMode === 3) {
        ambientLight.color.copy(ambientNeutral).lerp(ambientBlue, blueness);
    }
}

export function updateLightColorByTemperature(kelvin, currentMode, windowLights) {
    let temp = kelvin / 100;
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

    if (currentMode === 3) {
        windowMat.emissive.setRGB(rNorm, gNorm, bNorm);
        windowLights.forEach(light => {
            light.color.setRGB(rNorm, gNorm, bNorm);
        });
    }
}
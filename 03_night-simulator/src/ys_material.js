import * as THREE from 'three';

// ガラスグラデーションテクスチャの生成
export function createGlassTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 2;    
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#8ab8e6');   
    grad.addColorStop(0.5, '#d4e8fc'); 
    grad.addColorStop(1, '#5c8fbf');   
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    return new THREE.CanvasTexture(canvas);
}

// 障子テクスチャ用キャンバスとマテリアルの初期化
const shojiCanvas = document.createElement('canvas');
shojiCanvas.width = 256;
shojiCanvas.height = 256;
const shojiCtx = shojiCanvas.getContext('2d');
export const shojiTexture = new THREE.CanvasTexture(shojiCanvas);

export function updateShojiTexture(strength) {
    const minBrightness = 40; 
    const bgVal = Math.floor(255 - (255 - minBrightness) * strength); 
    shojiCtx.fillStyle = `rgb(${bgVal}, ${bgVal}, ${bgVal})`;
    shojiCtx.fillRect(0, 0, 256, 256);

    if (strength > 0) {
        const cx = 128; const cy = 256; 
        const gradient = shojiCtx.createRadialGradient(cx, cy, 0, cx, cy, 256);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${strength})`); 
        gradient.addColorStop(1, `rgba(255, 255, 255, 0)`); 
        shojiCtx.fillStyle = gradient;
        shojiCtx.fillRect(0, 0, 256, 256);
    }
    shojiTexture.needsUpdate = true;
}

export const windowMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissiveIntensity: 0.6, emissiveMap: shojiTexture,
    roughness: 0.9, metalness: 0.1
});

// ベース用マテリアルの作成
export const baseWallMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8, side: THREE.DoubleSide });
export const baseRoofMat = new THREE.MeshBasicMaterial({ color: 0x555555, side: THREE.DoubleSide });
export const floorMat = new THREE.MeshStandardMaterial({ color: 0xDDDDDD, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
export const floorMatDay = new THREE.MeshBasicMaterial({ color: 0xeeeeee, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }); 
export const floorMatFlat = new THREE.MeshBasicMaterial({ color: 0xeeeeee, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }); 

const glassTexture = createGlassTexture();
export const windowMatDay = new THREE.MeshLambertMaterial({ map: glassTexture, color: 0xffffff, transparent: true, opacity: 0.85 });
export const windowMatFlat = new THREE.MeshBasicMaterial({ map: glassTexture, color: 0xffffff, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
export const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x222222 });
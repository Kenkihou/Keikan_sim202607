// ys_material_factory.js
import * as THREE from 'three';

const baseTextureLoader = new THREE.TextureLoader();

// 砂壁・杉板マテリアル用のキャッシュ (publicフォルダ等から読み込み)
const customTextures = {
    sunakabe: baseTextureLoader.load('/night-api/sunakabe_r.png'),
    sugi1: baseTextureLoader.load('/night-api/sugi_mask1.png'),
    sugi2: baseTextureLoader.load('/night-api/sugi_mask2.png'),
    sugi3: baseTextureLoader.load('/night-api/sugi_mask3.png'),
    sugi4: baseTextureLoader.load('/night-api/sugi_mask4.png')
};

customTextures.sunakabe.wrapS = THREE.RepeatWrapping; customTextures.sunakabe.wrapT = THREE.RepeatWrapping;
for (let i = 1; i <= 4; i++) {
    const tex = customTextures[`sugi${i}`];
    if (tex) { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; }
}

// 💡 外部から呼ばれる「3モード対応マテリアル」の生成エンジン
export function createThreeModeMaterials(baseMaterial) {
    const texType = baseMaterial.userData.texType || 'none';
    const baseColor = baseMaterial.color ? baseMaterial.color.clone() : new THREE.Color('#e8e8e8');
    
    // 基本的な3モードマテリアル（フラット・昼用・夜用）の雛形を作る関数
    const createBaseMats = (col) => {
        return {
            f: new THREE.MeshBasicMaterial({ color: col, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            d: new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide }),
            n: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(1.0), roughness: 0.9, side: THREE.DoubleSide })
        };
    };

    const mats = createBaseMats(baseColor);

    // テクスチャなし、またはテクスチャ読み込み失敗時は基本マテリアルを返す
    if (texType === 'none') {
        return mats;
    }

    // 🌟 杉板調・砂壁調などの特殊シェーダーを夜用(n)と昼用(d)に組み込む処理をここに追加できます
    // (今回はひな形として、そのままmatsを返します。後日シェーダーを合成します)
    
    return mats;
}
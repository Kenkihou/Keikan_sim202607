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
    
    // ★元のマテリアルから引き継ぐ属性。
    //   ⚠️ 以前は color だけを見て作り直していたため、色を【頂点カラー】で持っている
    //     ものが白一色になっていた。外構の生垣の葉・石積み・芝生は
    //     color:0xffffff（または灰色）× vertexColors で色を出しているので、
    //     vertexColors を落とすと元の色がまったく出ない。
    //     テクスチャ（ブロック塀の割付など）や透明度も同じ理由で落ちていたので一緒に運ぶ。
    const carry = {
        vertexColors: baseMaterial.vertexColors === true,
        map: baseMaterial.map || null,
        alphaMap: baseMaterial.alphaMap || null,
        transparent: baseMaterial.transparent === true,
        opacity: (typeof baseMaterial.opacity === 'number') ? baseMaterial.opacity : 1,
        alphaTest: baseMaterial.alphaTest || 0,
    };

    // 基本的な3モードマテリアル（フラット・昼用・夜用）の雛形を作る関数
    const createBaseMats = (col) => {
        return {
            f: new THREE.MeshBasicMaterial({ ...carry, color: col, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            d: new THREE.MeshLambertMaterial({ ...carry, color: col, side: THREE.DoubleSide }),
            n: new THREE.MeshStandardMaterial({ ...carry, color: col.clone().multiplyScalar(1.0), roughness: 0.9, side: THREE.DoubleSide })
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
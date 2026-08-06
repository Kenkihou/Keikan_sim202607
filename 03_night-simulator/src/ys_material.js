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

// 夜間の窓マテリアルの雛形。
// 実際の描画には窓ごとにこれを複製したものを使い、部屋ごとに明るさと色温度を変える。
// roughness 0.9 は塗装面の値で、ガラスとしては粗すぎた。
// 環境マップ(IBL)を入れたことで、粗さを落とすと夜空の映り込みが乗るようになる。
// 消灯している窓が「真っ黒な穴」に見えなくなるのもこの効果による
export const windowMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissiveIntensity: 0.6,
    roughness: 0.25, metalness: 0.1
});

// 面内の濃淡を作るシェーダー。
// 以前は canvas で描いた emissiveMap を使っていたが、GLB側の窓メッシュのUVが退化しており
// 面全体が1テクセルだけを拾うため、どんな模様を描いても一様な発光にしかならなかった。
// UVに依存せず、メッシュのローカル座標を面内の座標系に正規化して濃淡を組み立てる。
const SHOJI_PARS = /* glsl */`
    varying vec3 vPaneWorld;
    varying vec3 vPaneNormalW;
    uniform float uUneven;
    uniform vec3 uPaneCenter;
    uniform vec3 uPaneSize;
    uniform float uSeed;

    float shHash( vec2 p ) {
        return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) + uSeed ) * 43758.5453123 );
    }

    float shNoise( vec2 p ) {
        vec2 i = floor( p );
        vec2 f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        float a = shHash( i );
        float b = shHash( i + vec2( 1.0, 0.0 ) );
        float c = shHash( i + vec2( 0.0, 1.0 ) );
        float d = shHash( i + vec2( 1.0, 1.0 ) );
        return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
    }

    float shojiUnevenness() {
        // 面の法線から面内の座標系を組む。
        // 境界ボックスの軸から推測すると、窓が斜めに置かれたモデルで軸の判定が外れ、
        // ほぼゼロの寸法で割ってUVが発散し、ノイズがエイリアシングして滲みになる
        vec3 n = normalize( vPaneNormalW );
        vec3 upRef = ( abs( n.y ) > 0.95 ) ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );
        vec3 right = normalize( cross( upRef, n ) );
        vec3 up = normalize( cross( n, right ) );

        // 面内の広がりは、ワールド境界ボックスをその2軸へ射影して求める
        vec3 d = vPaneWorld - uPaneCenter;
        float extR = max( dot( abs( right ), uPaneSize ), 1e-4 );
        float extU = max( dot( abs( up ), uPaneSize ), 1e-4 );
        vec2 uv = clamp( vec2( dot( d, right ) / extR, dot( d, up ) / extU ) + 0.5, 0.0, 1.0 );

        // 室内の灯りは窓の正面には無い。中心を外した位置に光の溜まりを作る
        float pool = 1.0 - smoothstep( 0.15, 1.05, distance( uv, vec2( 0.40, 0.62 ) ) );

        // 障子紙やカーテンのムラ
        float mottle = shNoise( uv * 3.5 ) * 0.6 + shNoise( uv * 9.0 ) * 0.3 + shNoise( uv * 21.0 ) * 0.1;

        // 建具の桟に遮られて、面の周縁は暗く落ちる
        float edge = smoothstep( 0.0, 0.16, uv.x ) * smoothstep( 1.0, 0.84, uv.x )
                   * smoothstep( 0.0, 0.12, uv.y ) * smoothstep( 1.0, 0.88, uv.y );

        // 桟や欄間のリズム。硬い線にはせず、緩い横方向の濃淡として乗せる
        float band = 0.5 + 0.5 * cos( uv.y * 6.2831853 * 3.0 );

        float f = 0.35 + 0.85 * pool;
        f *= mix( 1.0, 0.55 + 0.9 * mottle, 0.55 );
        f *= mix( 1.0, band, 0.18 );
        f = mix( f, f * ( 0.25 + 0.75 * edge ), 0.85 );
        f *= 1.45; // 濃淡を掛けても面全体の平均的な明るさが変わらないよう戻す

        // uUneven = 0 で完全に均一、上げるほど明暗の差が開く
        return mix( 1.0, f, clamp( uUneven, 0.0, 1.0 ) );
    }
`;

// 窓1枚ぶんの夜間マテリアルを生成する。
// uniform は複製ごとに持たせるので、窓ごとに面の寸法と種を変えられる
export function createWindowMaterial() {
    const mat = windowMat.clone();

    const uniforms = {
        uUneven: { value: 0.5 },
        uPaneCenter: { value: new THREE.Vector3() },
        uPaneSize: { value: new THREE.Vector3(1, 1, 1) },
        uSeed: { value: 0.0 }
    };
    mat.userData.shoji = uniforms;

    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);

        shader.vertexShader = 'varying vec3 vPaneWorld;\nvarying vec3 vPaneNormalW;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vPaneWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
            vPaneNormalW = normalize( ( modelMatrix * vec4( objectNormal, 0.0 ) ).xyz );`
        );

        shader.fragmentShader = SHOJI_PARS + shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
            totalEmissiveRadiance *= shojiUnevenness();`
        );
    };

    return mat;
}

// 窓メッシュのワールド境界ボックスを uniform に流し込む。
// 面内のどの向きを縦横に使うかはシェーダー側が法線から決めるため、ここでは軸を推測しない。
// ワールド空間で取るので、mm単位のモデルを 0.001 倍して読み込む場合でも寸法が合う
export function setupWindowPaneUniforms(material, mesh, seed) {
    const uniforms = material.userData.shoji;
    if (!uniforms) return;

    const box = new THREE.Box3().setFromObject(mesh);
    box.getCenter(uniforms.uPaneCenter.value);
    box.getSize(uniforms.uPaneSize.value);
    uniforms.uSeed.value = seed;
}

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
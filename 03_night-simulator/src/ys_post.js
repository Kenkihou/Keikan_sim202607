// ys_post.js
// 最終出力（OutputPass によるトーンマッピング／sRGB変換のあと）に掛ける仕上げシェーダー。
// - フィルムグレイン : ノイズが皆無な画は、それだけでCGに見えてしまうため
// - ディザ           : 夜空やフォグの緩やかな階調に出るバンディング（縞）を潰す

export const FilmGrainShader = {

    name: 'FilmGrainShader',

    uniforms: {
        'tDiffuse': { value: null },
        'uTime': { value: 0.0 },
        'uGrain': { value: 0.0 },   // グレイン強度（0でオフ）
        'uDither': { value: 1.0 }   // ディザ量（1.0 = ±0.5/255）
    },

    vertexShader: /* glsl */`
        varying vec2 vUv;

        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,

    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uGrain;
        uniform float uDither;

        varying vec2 vUv;

        // ピクセル座標と時間から 0〜1 の疑似乱数を作る
        float hash13( vec3 p ) {
            p = fract( p * 0.1031 );
            p += dot( p, p.yzx + 33.33 );
            return fract( ( p.x + p.y ) * p.z );
        }

        void main() {
            vec4 texel = texture2D( tDiffuse, vUv );

            // --- フィルムグレイン ---
            if ( uGrain > 0.0 ) {
                // 独立した2つの乱数の和を取り、-1〜1 の三角分布にする（一様分布より粒が自然）
                float n1 = hash13( vec3( gl_FragCoord.xy, uTime ) );
                float n2 = hash13( vec3( gl_FragCoord.yx, uTime + 17.0 ) );
                float grain = ( n1 + n2 ) - 1.0;

                float luma = dot( texel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
                // 実際のセンサーノイズに倣い、中間〜暗部に厚く、ハイライトでは目立たせない
                float weight = ( 1.0 - luma ) * ( 0.35 + 0.65 * smoothstep( 0.0, 0.25, luma ) );

                texel.rgb += grain * uGrain * weight;
            }

            // --- ディザ（8bit量子化前に微小ノイズを足してバンディングを分散させる） ---
            float d = hash13( vec3( gl_FragCoord.xy, 7.0 ) ) - 0.5;
            texel.rgb += d * uDither / 255.0;

            gl_FragColor = texel;
        }
    `
};

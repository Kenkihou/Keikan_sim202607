// materialTextureFactory.js
// マンセル値シミュレーターで選ばれた質感（砂壁調・杉板調など）を、
// このアプリのフラットな表示（MeshBasicMaterial・照明なし）向けに簡易的に近似して描画するためのモジュール
import * as THREE from 'three';

const imageLoader = new THREE.ImageLoader();

// ロード完了後に外部（main.js）へ再描画を促すためのコールバック
let onAssetsReady = null;
export function setOnTextureAssetsReady(cb) {
    onAssetsReady = cb;
}

// ==========================================================================
// ★変更：砂壁調は sunakabe_r.png（正方形画像）を単純に繰り返すと、画像自体の
// クセ（濃淡のムラなど）が同じ向き・同じ位置で何度も現れて模様に見えてしまう。
// そこで、正方形画像の対称性を利用し、90度刻みの回転(0/90/180/270)と
// 左右反転の有無を組み合わせた8パターンから、マス目ごとにランダムに選んで
// 敷き詰めた合成タイルを作る。正方形かつ無方向性の砂目模様のため、
// 回転・反転を混ぜても継ぎ目の破綻が起きにくい。
// ==========================================================================
let sunakabeRandomTex = null;
const SUNAKABE_GRID = 4; // 縦横4x4マス（16マス）に分割してランダム配置
const SUNAKABE_CELL_METERS = 1.0; // 元画像1枚分の実寸目安

// 画像を、正方形セルの中心を軸にrotIndex*90度回転＋(flip時)左右反転して描画する
function drawTransformedCell(ctx, img, size, destX, destY, rotIndex, flip) {
    ctx.save();
    ctx.translate(destX + size / 2, destY + size / 2);
    ctx.rotate(rotIndex * Math.PI / 2);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
}

(function buildSunakabeRandomTile() {
    imageLoader.load(`${import.meta.env.BASE_URL}sunakabe_r.png`, (img) => {
        const size = img.width; // 正方形画像を前提
        const canvas = document.createElement('canvas');
        canvas.width = size * SUNAKABE_GRID;
        canvas.height = size * SUNAKABE_GRID;
        const ctx = canvas.getContext('2d');

        for (let row = 0; row < SUNAKABE_GRID; row++) {
            for (let col = 0; col < SUNAKABE_GRID; col++) {
                const rotIndex = Math.floor(Math.random() * 4); // 0,90,180,270度
                const flip = Math.random() < 0.5;               // 左右反転の有無
                drawTransformedCell(ctx, img, size, col * size, row * size, rotIndex, flip);
            }
        }

        sunakabeRandomTex = new THREE.CanvasTexture(canvas);
        sunakabeRandomTex.wrapS = THREE.RepeatWrapping;
        sunakabeRandomTex.wrapT = THREE.RepeatWrapping;

        if (onAssetsReady) onAssetsReady();
    });
})();

// ==========================================================================
// ★変更：杉板調は sugi_mask1〜4.png（板1枚分の縦長画像）を横に4枚並べた
// 合成テクスチャを作る。板ごとの継ぎ目（目地）は、テクスチャの縮小表示で
// 潰れて見えなくなるため、ここでは描かない。継ぎ目は実寸の板幅に基づいた
// 線分ジオメトリ（buildWallJointLines、main.js側）で別途描画する。
// ==========================================================================
let sugiCompositeTex = null;
const SUGI_BOARDS_PER_TILE = 4;
export const SUGI_BOARD_WIDTH_M = 0.2;  // 板1枚分の実寸幅（縦目地線の間隔にも使用）
export const SUGI_BOARD_HEIGHT_M = 2.0; // 板1枚分の実寸高さ（横目地線の間隔にも使用）

(function buildSugiComposite() {
    const urls = [1, 2, 3, 4].map(i => `${import.meta.env.BASE_URL}sugi_mask${i}.png`);
    const images = new Array(urls.length);
    let loadedCount = 0;

    urls.forEach((url, i) => {
        imageLoader.load(url, (img) => {
            images[i] = img;
            loadedCount++;
            if (loadedCount === urls.length) {
                const boardW = img.width;
                const boardH = img.height;
                const canvas = document.createElement('canvas');
                canvas.width = boardW * SUGI_BOARDS_PER_TILE;
                canvas.height = boardH;
                const ctx = canvas.getContext('2d');

                images.forEach((im, idx) => {
                    ctx.drawImage(im, idx * boardW, 0, boardW, boardH);
                });

                sugiCompositeTex = new THREE.CanvasTexture(canvas);
                sugiCompositeTex.wrapS = THREE.RepeatWrapping;
                sugiCompositeTex.wrapT = THREE.RepeatWrapping;

                if (onAssetsReady) onAssetsReady();
            }
        });
    });
})();

// 各質感の「1タイル分の実寸（メートル）」の目安（簡易近似用）
const TILE_SIZE_M = {
    sunakabe: { w: SUNAKABE_CELL_METERS * SUNAKABE_GRID, h: SUNAKABE_CELL_METERS * SUNAKABE_GRID }, // 砂壁調：ランダム合成タイル(4x4マス)1枚分
    sugi: { w: SUGI_BOARD_WIDTH_M * SUGI_BOARDS_PER_TILE, h: SUGI_BOARD_HEIGHT_M },                 // 杉板調：合成タイル＝板4枚分（横0.2m×4）×縦2.0m
};

/**
 * マテリアルに質感タイプを反映する（色はmaterial.colorを変えずそのまま維持）
 * @param {THREE.Material} material - 対象マテリアル
 * @param {string} texType - 'none' | 'sunakabe' | 'sugi' | 'metallic' | 'glass'
 * @param {Object} block - 実寸(w/h/d, mm単位)を持つブロックデータ（繰り返し数の計算に使用）
 */
export function applyPartTexture(material, texType, block) {
    material.userData.texType = texType || 'none';

    if (texType === 'sunakabe' || texType === 'sugi') {
        const baseTex = texType === 'sunakabe' ? sunakabeRandomTex : sugiCompositeTex;

        if (!baseTex) {
            // 合成テクスチャがまだ読み込み中の場合は、いったんテクスチャなしで表示しておく
            // （読み込み完了時に setOnTextureAssetsReady 経由で再描画がかかり、正しい見た目になる）
            material.map = null;
            material.transparent = false;
            material.opacity = 1;
            material.needsUpdate = true;
            return material;
        }

        const tile = TILE_SIZE_M[texType];

        // ★変更：質感ごとに独立したテクスチャインスタンスを複製する
        // （同じ画像を使い回しつつ、ブロックごとに異なるrepeat値を安全に持たせるため）
        const tex = baseTex.clone();
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;

        // ブロックの実寸(mm→m)から、おおよその繰り返し回数を計算する簡易近似
        const wM = Math.max(0.1, ((block && block.w) || 1000) / 1000);
        const dM = Math.max(0.1, ((block && block.d) || 1000) / 1000);
        const hM = Math.max(0.1, ((block && block.h) || 1000) / 1000);
        const horizM = (wM + dM) / 2; // 前後左右で幅が異なるため、平均値を目安として使う

        tex.repeat.set(horizM / tile.w, hM / tile.h);

        material.map = tex;
        material.transparent = false;
        material.opacity = 1;
    } else if (texType === 'glass') {
        material.map = null;
        material.transparent = true;
        material.opacity = 0.6;
    } else {
        // 'metallic' や 'none' は、このアプリではフラット表示のため色以外の見た目を変えない
        material.map = null;
        material.transparent = false;
        material.opacity = 1;
    }

    material.needsUpdate = true;
    return material;
}

// ★追加：書き出しの前に、ボーン（骨組み）入りのモデルを【いまの姿のまま固める】。
//
//   ⚠️ なぜ要るか。
//     人物モデルなどはボーンで形が決まる。glTF の決まりでは、ボーン入りの
//     メッシュは【置いてある節の位置を無視して】、骨組みの位置だけで描かれる。
//     この決まりの汲み方はソフトによってまちまちで、こちらが正しく書き出しても
//     受け取る側で沈んだり浮いたりする（実際、PowerPoint 等で沈んだ）。
//   ★ 01 はモデルを動かさない（ポーズは取り込んだときのまま）ので、
//     書き出すときに骨組みごと【ただのメッシュ】へ焼き付けてしまえば、
//     どのソフトで開いても画面と同じ姿になる。
import * as THREE from 'three';

/* root の下のボーン入りメッシュを、いまの姿の【ただのメッシュ】に置き換える。
   戻し方（undo）を返すので、書き出しが終わったら必ず呼ぶこと。 */
export function freezeSkinned(roots) {
    const list = Array.isArray(roots) ? roots : [roots];
    const hidden = [];
    const added = [];
    const v = new THREE.Vector3();

    for (const root of list) {
        root.updateMatrixWorld(true);
        const skins = [];
        root.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });

        for (const sm of skins) {
            const src = sm.geometry.attributes.position;
            if (!src) continue;
            const geo = sm.geometry.clone();
            const dst = geo.attributes.position;
            // 1点ずつ、骨組みの効いたあとの位置を求める（画面と同じ計算）。
            for (let i = 0; i < src.count; i++) {
                v.fromBufferAttribute(src, i);
                sm.applyBoneTransform(i, v);
                dst.setXYZ(i, v.x, v.y, v.z);
            }
            dst.needsUpdate = true;
            // ⚠️ 法線は焼き直す。元の法線は骨が効く前の向きなので、
            //   そのまま使うと陰影がおかしくなる。
            geo.deleteAttribute('skinIndex');
            geo.deleteAttribute('skinWeight');
            geo.computeVertexNormals();

            const baked = new THREE.Mesh(geo, sm.material);
            baked.name = sm.name || 'baked';
            // 置き場所は、元のメッシュの節と同じにする。
            baked.matrixAutoUpdate = false;
            baked.matrix.copy(sm.matrixWorld);
            baked.matrix.decompose(baked.position, baked.quaternion, baked.scale);
            baked.matrixWorld.copy(sm.matrixWorld);

            root.add(baked);
            added.push({ root, baked });
            // 元のほうは書き出しから外す（見えないものは書き出されない）。
            hidden.push({ obj: sm, was: sm.visible });
            sm.visible = false;
        }
    }

    return function undo() {
        for (const { root, baked } of added) {
            root.remove(baked);
            baked.geometry.dispose();
        }
        for (const { obj, was } of hidden) obj.visible = was;
    };
}

// tutorialSteps.js
import * as THREE from 'three';
import { AppState } from './appState.js';

export const tutorialSteps = [
    // ==========================================
    // 【第1章】 平面作図
    // ==========================================
    {
        chapter: 1,
        chapterTitle: "1. 平面作図",
        id: "demo_draw",
        title: "平面作図（見本）",
        text: "まずは建物の土台となる「6m × 6m」の平面を作図します。見本をご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 10000, 15000),
        lookAt: new THREE.Vector3(0, 0, 0),
        prerequisiteState: null,
        demoSequence: [
            { type: "real_click_dom", targetId: "btn-draw", cursorEffect: "click", duration: 1000 },
            { type: "real_drag_3d", startPos: new THREE.Vector3(-3000, 0, 3000), endPos: new THREE.Vector3(3000, 0, -3000), cursorEffect: "drag", duration: 1500 }
        ]
    },
    {
        chapter: 1,
        chapterTitle: "1. 平面作図",
        id: "try_draw",
        title: "1. 平面作図", 
        text: "では今の操作をあなた自身でやってみましょう",
        successText: "デモの通り操作できなかった場合、デモか作図を繰り返してください。<br>この操作がマスターできた場合は、次の操作のデモに進んでください。",
        action: "wait_for_draw",
        cameraPos: new THREE.Vector3(12000, 10000, 15000),
        lookAt: new THREE.Vector3(0, 0, 0),
        triggerType: "draw_complete",
        prerequisiteState: null
    },

    // ==========================================
    // 【第2章】 高さを変える（プッシュプル）
    // ==========================================
    {
        chapter: 2,
        chapterTitle: "2. 高さを変える（プッシュプル）",
        id: "demo_extrude",
        title: "高さを変える（プッシュプル）（見本）",
        text: "次に、作図した平面を押し上げて、高さ3mの立体にします。見本をご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 6000, 12000),
        lookAt: new THREE.Vector3(0, 500, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 100 }
        ],
        demoSequence: [
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 100, 0), cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "プッシュプル", cursorEffect: "click", duration: 800 },
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 100, 0), endPos: new THREE.Vector3(0, 3000, 0), cursorEffect: "drag", duration: 1800 }
        ]
    },
    {
        chapter: 2,
        chapterTitle: "2. 高さを変える（プッシュプル）",
        id: "try_extrude",
        title: "2. 高さを変える（プッシュプル）",
        text: "では今の操作をあなた自身でやってみましょう",
        successText: "デモの通り操作できなかった場合、デモか作図を繰り返してください。<br>この操作がマスターできた場合は、次の操作のデモに進んでください。",
        action: "wait_for_extrude",
        cameraPos: new THREE.Vector3(12000, 6000, 12000),
        lookAt: new THREE.Vector3(0, 500, 0),
        triggerType: "extrude_complete",
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 100 }
        ]
    },

    // ==========================================
    // 【第3章】 2階の作成（SHIFT＋プッシュプル）
    // ==========================================
    {
        chapter: 3,
        chapterTitle: "3. 2階の作成<br>（SHIFT＋プッシュプル）",
        id: "demo_extrude_shift",
        title: "2階の作成<br>（SHIFT＋プッシュプル）（見本）",
        text: "Shiftキーを押しながらドラッグすると、別オブジェクト（上階など）としてプッシュプルすることができます。見本をご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 9000, 12000), 
        lookAt: new THREE.Vector3(0, 3000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 }
        ],
        demoSequence: [
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 3000, 0), cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "プッシュプル", cursorEffect: "click", duration: 800 },
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 3000, 0), endPos: new THREE.Vector3(0, 6000, 0), shiftKey: true, cursorEffect: "shift_drag", duration: 1800 }
        ]
    },
    {
        chapter: 3,
        chapterTitle: "3. 2階の作成<br>（SHIFT＋プッシュプル）",
        id: "try_extrude_shift",
        title: "3. 2階の作成<br>（SHIFT＋プッシュプル）",
        text: "では今の操作をあなた自身でやってみましょう",
        successText: "デモの通り操作できなかった場合、デモか作図を繰り返してください。<br>この操作がマスターできた場合は、次の操作のデモに進んでください。",
        action: "wait_for_extrude",
        cameraPos: new THREE.Vector3(12000, 9000, 12000),
        lookAt: new THREE.Vector3(0, 3000, 0),
        triggerType: "extrude_complete",
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 }
        ]
    },

    // ==========================================
    // 【第4章】 大屋根の作成
    // ==========================================
    {
        chapter: 4,
        chapterTitle: "4. 大屋根の作成",
        id: "demo_roof",
        title: "大屋根の作成（見本）",
        text: "最上階の上面をクリックすると大屋根を複数種類の中から作成することができます。見本をご覧ください。<br><span style='color: #ff4444; font-weight: bold;'>※右上のスライダーを動かすと寸法などを色々変えることができます。</span><br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 10000, 15000), 
        lookAt: new THREE.Vector3(0, 4500, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ],
        demoSequence: [
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 6000, 0), cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "大屋根を追加", cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "切妻", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "寄棟", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "パラペット", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "陸屋根", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "削除", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "大屋根を追加", cursorEffect: "click", duration: 800 }
        ]
    },
    {
        chapter: 4,
        chapterTitle: "4. 大屋根の作成",
        id: "try_roof",
        title: "4. 大屋根の作成",
        text: "では今の操作をあなた自身でやってみましょう",
        successText: "デモの通り操作できなかった場合、デモか作図を繰り返してください。<br>この操作がマスターできた場合は、次の操作のデモに進んでください。",
        action: "wait_for_extrude", 
        cameraPos: new THREE.Vector3(12000, 10000, 15000),
        lookAt: new THREE.Vector3(0, 4500, 0),
        triggerType: "roof_complete",
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ]
    },

    // ==========================================
    // 【第5章】 下屋の作成
    // ==========================================
    {
        chapter: 5,
        chapterTitle: "5. 下屋の作成",
        id: "demo_shita_roof",
        title: "下屋の作成（見本）",
        text: "2階の壁を押し込んでスペースを作り、そこに下屋（1階の屋根）を作成します。見本をご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 8000, 15000), 
        lookAt: new THREE.Vector3(0, 2000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000,
              roof: { type: '切妻', params: { '切妻': { slope: 4, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, rotate90: false } } }
            }
        ],
        demoSequence: [
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 4500, 3000), cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "プッシュプル", cursorEffect: "click", duration: 800 },
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 4500, 3000), endPos: new THREE.Vector3(0, 4500, 2000), cursorEffect: "drag", duration: 1500 },
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 3000, 2500), cursorEffect: "click", duration: 1200 },
            { type: "real_click_dom", text: "下屋を追加", cursorEffect: "click", duration: 1000 },
            { type: "real_click_dom", text: "妻入", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "陸屋根", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "削除", cursorEffect: "click", duration: 800 },
            { type: "real_click_dom", text: "下屋を追加", cursorEffect: "click", duration: 800 }
        ]
    },
    {
        chapter: 5,
        chapterTitle: "5. 下屋の作成",
        id: "try_shita_roof",
        title: "5. 下屋の作成",
        text: "では今の操作をあなた自身でやってみましょう",
        successText: "デモの通り操作できなかった場合、デモか作図を繰り返してください。<br>この操作がマスターできた場合は、次の操作のデモに進んでください。",
        action: "wait_for_extrude", 
        cameraPos: new THREE.Vector3(12000, 8000, 15000),
        lookAt: new THREE.Vector3(0, 2000, 0),
        triggerType: "roof_complete",
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000,
              roof: { type: '切妻', params: { '切妻': { slope: 4, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, rotate90: false } } }
            }
        ]
    },

    // ==========================================
    // 【第6章】 壁面の修景
    // ==========================================
    {
        chapter: 6,
        chapterTitle: "6. 壁面の修景",
        id: "demo_wall_deco",
        title: "壁面の修景（見本）",
        text: "壁面をクリックすると様々な壁面修景を追加することができます。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 8000, 15000),
        lookAt: new THREE.Vector3(0, 2000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000,
              lowerRoof: { type: "平入り/切妻1", eaves: 600, slope: 4, thick: 150, keraba: 300, out_nx: 0, out_px: 0, out_nz: 0, out_pz: 1000, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, ridgeOffset: 0 }
            },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: -500, w: 6000, d: 5000, h: 3000,
              roof: { type: '切妻', params: { '切妻': { slope: 4, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, rotate90: false, ridgeOffset: 0 } } }
            }
        ],
        demoSequence: [
            // １ 1階の正面壁面をクリック (Z=3000)
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 1500, 3000), cursorEffect: "click", duration: 1000 },
            
            // ２ 玄関を追加をクリック
            { type: "real_click_dom", text: "玄関を追加", cursorEffect: "click", duration: 1000 },
            
            // Orbit操作：1回目のドラッグ（正面から側面へゆっくり90度回転）
            { type: "real_drag_3d", startPos: new THREE.Vector3(3000, 2000, 0), endPos: new THREE.Vector3(-3000, 2000, 0), cursorEffect: "drag", duration: 2500 },
            
            // Orbit操作：2回目のドラッグ（側面から裏面へゆっくり90度回転）
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 2000, -3000), endPos: new THREE.Vector3(0, 2000, 3000), cursorEffect: "drag", duration: 2500 },
            
            // ３ その裏面の2階の壁面をクリック (裏面壁の座標は Z=-3000)
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 4500, -3000), cursorEffect: "click", duration: 1200 },
            
            // ４ 窓を追加をクリック
            { type: "real_click_dom", text: "窓を追加", cursorEffect: "click", duration: 1000 },
            
            // ５ 同じ裏面の2階の壁面をクリック
            { type: "real_click_3d", targetPos: new THREE.Vector3(0, 4500, -3000), cursorEffect: "click", duration: 1000 },
            
            // ６ バルコニーを追加をクリック
            { type: "real_click_dom", text: "バルコニーを追加", cursorEffect: "click", duration: 1000 },

            // さらに180度回転して、正面（玄関）に戻る
            // Orbit操作：3回目のドラッグ（裏面から左側面へゆっくり90度回転）
            { type: "real_drag_3d", startPos: new THREE.Vector3(-3000, 2000, 0), endPos: new THREE.Vector3(3000, 2000, 0), cursorEffect: "drag", duration: 2500 },
            
            // Orbit操作：4回目のドラッグ（左側面から正面へゆっくり90度回転）
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 2000, 3000), endPos: new THREE.Vector3(0, 2000, -3000), cursorEffect: "drag", duration: 2500 }
        ]
    },
    {
        chapter: 6,
        chapterTitle: "6. 壁面の修景",
        id: "try_wall_deco",
        title: "6. 壁面の修景",
        text: "では、今の操作をあなた自身でやってみましょう。<br>正面に玄関を追加したあと、画面をドラッグして裏面に回り込み、2階の壁面に窓とバルコニーを追加してください。最後にもう一度画面を回して正面に戻ってみましょう。",
        successText: "素晴らしい！画面を回転させて裏面の壁面にも正しく修景パーツを追加することができました。",
        action: "wait_for_extrude", 
        cameraPos: new THREE.Vector3(12000, 8000, 15000),
        lookAt: new THREE.Vector3(0, 2000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000,
              lowerRoof: { type: "平入り/切妻1", eaves: 600, slope: 4, thick: 150, keraba: 300, out_nx: 0, out_px: 0, out_nz: 0, out_pz: 1000, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, ridgeOffset: 0 }
            },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: -500, w: 6000, d: 5000, h: 3000,
              roof: { type: '切妻', params: { '切妻': { slope: 4, eaves_l: 600, eaves_r: 600, keraba_l: 300, keraba_r: 300, rotate90: false, ridgeOffset: 0 } } }
            }
        ]
    },

    // ==========================================
    // 【基礎操作】 1. 画面の回転・拡大縮小・パン
    // ==========================================
    {
        chapter: 7,
        chapterTitle: "1. 画面の回転・拡大縮小・パン",
        id: "demo_base_control",
        title: "1. 画面の回転・拡大縮小・パン（見本）",
        text: "3Dモデリングを快適に行うための、基本の画面操作方法を学びます。見本デモをご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 9000, 12000), 
        lookAt: new THREE.Vector3(0, 3000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ],
        demoSequence: [
            // １ ドラッグで回転
            { type: "real_drag_3d", startPos: new THREE.Vector3(3000, 3000, -3000), endPos: new THREE.Vector3(-3000, 3000, 3000), cursorEffect: "drag", duration: 2000 },
            
            // ２ マウスホイールで拡大
            { type: "real_wheel_3d", targetPos: new THREE.Vector3(0, 3000, 0), deltaY: -400, cursorEffect: "wheel", duration: 1500 },
            
            // ２ マウスホイールで縮小
            { type: "real_wheel_3d", targetPos: new THREE.Vector3(0, 3000, 0), deltaY: 400, cursorEffect: "wheel", duration: 1500 },
            
            // ３ Shift+ドラッグでパン（画面上でオブジェクトが左から右へ動くように右から左へドラッグ）
            { type: "real_drag_3d", startPos: new THREE.Vector3(2000, 3000, -2000), endPos: new THREE.Vector3(-2000, 3000, 2000), shiftKey: true, cursorEffect: "shift_drag", duration: 2000 }
        ]
    },
    {
        chapter: 7,
        chapterTitle: "1. 画面の回転・拡大縮小・パン",
        id: "try_base_control",
        title: "1. 画面の回転・拡大縮小・パン",
        text: "では、今の操作をあなた自身でやってみましょう。<br><br>・<b>ドラッグ</b>で画面を回転<br>・<b>マウスホイール</b>で拡大・縮小（ズーム）<br>・<b>Shift＋ドラッグ</b>で平行移動（パン）<br><br>これらを試して、カメラアングルを自由に動かしてみてください。",
        successText: "素晴らしい！画面の操作を完全にマスターしました。これで自由なアングルから精巧なモデリングが行えます。",
        action: "wait_for_camera",
        cameraPos: new THREE.Vector3(12000, 9000, 12000),
        lookAt: new THREE.Vector3(0, 3000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ]
    },

    // ==========================================
    // 【基礎操作】 2. オブジェクトの移動
    // ==========================================
    {
        chapter: 8,
        chapterTitle: "2. オブジェクトの移動",
        id: "demo_object_move",
        title: "2. オブジェクトの移動（見本）",
        text: "作成したオブジェクトを移動させる方法と、スナップ単位の切り替えを学びます。見本をご覧ください。<br><br><span style='color:#007acc; font-weight:bold;'>※自動で再生されています</span>",
        action: "play_demo_sequence",
        cameraPos: new THREE.Vector3(12000, 9000, 12000), 
        lookAt: new THREE.Vector3(0, 3000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ],
        demoSequence: [
            // １ 2階部分の直方体をダブルクリック（単体選択）
            { type: "real_dblclick_3d", targetPos: new THREE.Vector3(0, 6000, 0), cursorEffect: "dblclick", duration: 1200 },
            
            // ２ 2階部分をドラッグして横にずらす（★修正：1000mmドラッグして動かす）
            { type: "real_drag_3d", startPos: new THREE.Vector3(0, 6000, 0), endPos: new THREE.Vector3(1000, 6000, 0), cursorEffect: "drag", duration: 1500 },
            
            // ３ オブジェクトをトリプルクリック（建物全体選択）。★修正：移動後のターゲット座標(X=1000)を指定
            { type: "real_tplclick_3d", targetPos: new THREE.Vector3(1000, 6000, 0), cursorEffect: "tplclick", duration: 1200 },
            
            // ４ 下メニューの「500」スナップボタンを探して1回押し、100に切り替える
            { type: "real_click_dom", text: "500", cursorEffect: "click", duration: 1200 },
            
            // ５ 再度オブジェクトをドラッグして微調整する（★修正：スタート位置X=1000から1200mm横にずらしてX=2200へ）
            { type: "real_drag_3d", startPos: new THREE.Vector3(1000, 6000, 0), endPos: new THREE.Vector3(2200, 6000, 0), cursorEffect: "drag", duration: 1500 }
        ]
    },
    {
        chapter: 8,
        chapterTitle: "2. オブジェクトの移動",
        id: "try_object_move",
        title: "2. オブジェクトの移動",
        text: "では、今の操作をあなた自身でやってみましょう。<br><br>・<b>ダブルクリック</b>でブロック単体を選択<br>・<b>トリプルクリック</b>で建物全体を選択<br>・画面下部の<b>スナップボタン</b>で移動の刻み幅を変更できます。<br><br>自由にオブジェクトを動かしてみてください。",
        successText: "素晴らしい！オブジェクトの選択と移動、スナップの切り替えが完了しました。",
        action: "wait_for_any_action", 
        cameraPos: new THREE.Vector3(12000, 9000, 12000),
        lookAt: new THREE.Vector3(0, 3000, 0),
        prerequisiteState: [
            { id: "tutorial_bldg_1", rootBuildingId: "tutorial_bldg_1", x: 0, y: 0, z: 0, w: 6000, d: 6000, h: 3000 },
            { id: "tutorial_bldg_2", rootBuildingId: "tutorial_bldg_1", x: 0, y: 3000, z: 0, w: 6000, d: 6000, h: 3000 }
        ]
    }
];
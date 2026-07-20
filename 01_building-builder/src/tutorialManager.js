// tutorialManager.js
import * as THREE from 'three';
import { tutorialSteps } from './tutorialSteps.js';
import { AppState } from './appState.js';

// ユーザーが直前に物理操作していた最新のマウス座標を常時記録する変数（ワープ暴走防止用）
let lastPhysicalX = window.innerWidth / 2;
let lastPhysicalY = window.innerHeight / 2;

const createPointerEvent = (type, x, y, shiftKey = false) => {
    return new PointerEvent(type, {
        clientX: x, clientY: y,
        screenX: x, screenY: y,
        button: 0, buttons: (type.includes('up') || type.includes('leave') || type.includes('cancel')) ? 0 : 1,
        bubbles: true, cancelable: true, composed: true,
        isPrimary: true, pointerId: 1, pointerType: 'mouse',
        shiftKey: shiftKey
    });
};

const createMouseEvent = (type, x, y, shiftKey = false, detail = 1) => {
    return new MouseEvent(type, {
        clientX: x, clientY: y,
        screenX: x, screenY: y,
        button: 0, buttons: (type === 'mouseup' || type === 'click') ? 0 : 1,
        bubbles: true, cancelable: true, view: window,
        shiftKey: shiftKey,
        detail: detail 
    });
};

const createWheelEvent = (type, x, y, deltaY) => {
    return new WheelEvent(type, {
        clientX: x, clientY: y,
        screenX: x, screenY: y,
        deltaY: deltaY,
        deltaMode: 0,
        bubbles: true, cancelable: true, view: window
    });
};

// =======================================================
// デモ中のユーザー物理操作を最優先で強制ブロックする処理
// =======================================================
const blockUserInteraction = (e) => {
    // ユーザーの実際の物理操作である場合、最新の座標を常にトラッキングしておく
    if (e.isTrusted) {
        lastPhysicalX = e.clientX;
        lastPhysicalY = e.clientY;
    }

    // どんなイベントであっても、ターゲットが終了ボタンなら絶対にブロックせず最優先で通す
    // ★修正：e.target が window や document の場合 closest メソッドが存在しないため、関数があるかチェックする
    if (e.target) {
        if (e.target.id === 'btn-terminate-tutorial') return;
        if (typeof e.target.closest === 'function' && e.target.closest('#btn-terminate-tutorial')) return;
    }

    // デモ再生中であり、かつイベントがユーザーの実際の物理操作(isTrusted=true)から発生した場合
    if (TutorialManager && TutorialManager.demoActive && e.isTrusted) {
        e.stopPropagation(); // OrbitControlsなどの後続リスナーにイベントを渡さない
        if (e.cancelable) e.preventDefault();
    }
};

window.addEventListener('pointerdown', blockUserInteraction, true);
window.addEventListener('pointermove', blockUserInteraction, true);
window.addEventListener('pointerup', blockUserInteraction, true);
window.addEventListener('wheel', blockUserInteraction, true);
// =======================================================

export const TutorialManager = {
    isActive: false,
    currentStepIndex: -1, 
    demoActive: false,
    isDemoShapeShowing: false, 
    taskCompleted: false, 
    
    // ★追加：メニューの開閉状態を管理するフラグ
    isDrawMenuOpen: true,
    isBaseMenuOpen: true,
    
    // 非同期アニメーションの多重起動（暴走）を防ぐための実行ID
    demoRunToken: 0,
    
    three: { camera: null, controls: null, scene: null, rebuildMeshes: null },
    cursorDom: null,
    shieldDom: null,
    entryBtn: null,
    sidebar: null,
    controlContainer: null, 
    
    userBackupData: null,
    _userActionListener: null, 

    init(params) {
        this.three.camera = params.camera;
        this.three.controls = params.controls;
        this.three.scene = params.scene;
        this.three.rebuildMeshes = params.rebuildMeshes;

        const style = document.createElement('style');
        style.innerHTML = `
            .tutorial-mini-btn { width: 100%; padding: 8px 4px; cursor: pointer; background: #f8f9fa; border: 1px solid #ccc; border-radius: 4px; text-align: center; font-size: 11px; font-weight: bold; transition: 0.2s; color: #333; box-sizing: border-box; height: 32px; }
            .tutorial-mini-btn:hover { background: #e2e6ea; border-color: #a1a1a1; }
            .tutorial-chapter-btn { width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 6px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-weight: bold; color: #007acc; transition: 0.2s; font-size: 13px; opacity: 0.85; line-height: 1.4; display: flex; align-items: flex-start; }
            .tutorial-chapter-btn:hover { background: #f0f7ff; border-color: #007acc; opacity: 1; }
            .tutorial-chapter-btn .icon { margin-right: 4px; margin-top: 1px; }
            .tutorial-chapter-btn .text { flex: 1; word-break: keep-all; overflow-wrap: break-word; }
            
            /* コンテナロック時、終了ボタン「以外」のすべての子要素を半透明＆操作不可にする */
            .control-container-locked > *:not(#btn-terminate-tutorial) { pointer-events: none !important; opacity: 0.5 !important; cursor: wait !important; }
            .control-container-locked > *:not(#btn-terminate-tutorial) * { cursor: wait !important; }
            .control-container-locked #btn-terminate-tutorial { pointer-events: auto !important; opacity: 1 !important; cursor: pointer !important; }
            
            .tutorial-sidebar { pointer-events: auto; }

            @keyframes tutorial-wheel-scroll {
                0% { transform: translate(-50%, -4px); opacity: 0; }
                50% { opacity: 1; }
                100% { transform: translate(-50%, 4px); opacity: 0; }
            }
            @keyframes tutorial-wheel-glow {
                0%, 100% { filter: drop-shadow(0 0 2px #007acc); box-shadow: 0 0 2px #007acc; }
                50% { filter: drop-shadow(0 0 8px #005a9e); box-shadow: 0 0 6px #007acc; }
            }
            .tutorial-wheel-active {
                animation: tutorial-wheel-scroll 0.8s infinite linear, tutorial-wheel-glow 0.4s infinite ease-in-out;
            }
        `;
        document.head.appendChild(style);

        this.shieldDom = document.createElement('div');
        this.shieldDom.id = 'tutorial-shield';
        Object.assign(this.shieldDom.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            zIndex: '99999', background: 'transparent', display: 'none', cursor: 'default' 
        });
        document.body.appendChild(this.shieldDom);

        // ★変更：動的なボタン作成を廃止し、index.htmlの上段ツールバーにあるボタンを取得する
        const startBtn = document.getElementById('btn-start-tutorial');
        this.entryBtn = startBtn; 

        if (startBtn) {
            startBtn.onclick = () => {
                if (!startBtn.disabled) this.beginTutorial();
            };

            // スライダーの状態を監視して、0%（陰影なし）のときのみツールバーボタンを有効にする
            setInterval(() => {
                const slider = document.querySelector('#app1-time-slider-container input[type="range"]');
                if (slider) {
                    const isZero = parseFloat(slider.value) === 0;
                    if (isZero) {
                        startBtn.style.opacity = '1';
                        startBtn.style.cursor = 'pointer';
                        startBtn.disabled = false;
                        startBtn.setAttribute('data-tooltip', '🎓 チュートリアル');
                    } else {
                        startBtn.style.opacity = '0.5';
                        startBtn.style.cursor = 'not-allowed';
                        startBtn.disabled = true;
                        startBtn.setAttribute('data-tooltip', '※時刻スライダーを「陰影なし」に戻してください');
                    }
                }
            }, 500);
        }

        this.sidebar = document.createElement('div');
        this.sidebar.className = 'tutorial-sidebar';
        Object.assign(this.sidebar.style, {
            position: 'absolute', top: '20px', width: '227px',
            zIndex: '100000', display: 'none', flexDirection: 'column'
        });
        document.body.appendChild(this.sidebar);

        this.updateUIPosition();
        window.addEventListener('resize', () => this.updateUIPosition());

        this.cursorDom = document.createElement('div');
        this.cursorDom.innerHTML = `
            <div id="cursor-label" style="position:absolute; top:-36px; left:24px; font-weight:bold; font-size:22px; color:#007acc; text-shadow: 1.5px 1.5px 0 #fff, -1.5px 1.5px 0 #fff, 1.5px -1.5px 0 #fff, -1.5px -1.5px 0 #fff; opacity:0; transition: opacity 0.2s; pointer-events:none; white-space:nowrap; font-family:sans-serif;"></div>
            <div id="cursor-shift-key" style="position:absolute; top:28px; left:-54px; opacity:0; transition: opacity 0.2s; background: #333; color: white; padding: 4px 8px; border-radius: 6px; font-size: 16px; font-weight: bold; font-family: sans-serif; box-shadow: 0 4px 6px rgba(0,0,0,0.5); border: 2px solid #555; pointer-events: none;">Shift+</div>
            
            <div id="cursor-wheel-glow" style="position:absolute; top:10px; left:24px; width:4px; height:6px; background:#007acc; border-radius:2px; opacity:0; transition: opacity 0.2s; pointer-events:none; z-index:10;"></div>
            
            <svg id="cursor-arrow" viewBox="0 0 24 24" width="48" height="48" style="position:absolute; top:0; left:0; transition: opacity 0.2s;">
                <path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4-4.4 4.5z" fill="white" stroke="black" stroke-width="1.5"/>
            </svg>
            <svg id="cursor-mouse" viewBox="0 0 24 24" width="48" height="48" style="position:absolute; top:0; left:0; opacity:0; transition: opacity 0.2s;">
                <rect x="5" y="2" width="14" height="20" rx="6" fill="white" stroke="black" stroke-width="1.5"/>
                <path id="mouse-left-btn" d="M5 10 V 8 a 6 6 0 0 1 6 -6 h 1 v 8 z" fill="white"/>
                <path d="M5 10 h14" stroke="black" stroke-width="1.5"/>
                <path d="M12 2 v8" stroke="black" stroke-width="1.5"/>
                <rect x="5" y="2" width="14" height="20" rx="6" fill="none" stroke="black" stroke-width="1.5"/>
            </svg>
        `;
        Object.assign(this.cursorDom.style, {
            position: 'absolute', display: 'none', pointerEvents: 'none', 
            zIndex: '9999999', width: '48px', height: '48px',
            filter: 'drop-shadow(2px 4px 6px rgba(0,0,0,0.4))',
            transition: 'transform 0.1s ease', marginLeft: '-2px', marginTop: '-1px'
        });
        document.body.appendChild(this.cursorDom);

        window.addEventListener('pointerdown', (e) => {
            if (!this.isActive || !this.isDemoShapeShowing) return;
            if (e.target.closest('.tutorial-sidebar')) return;
            if (!e.isTrusted) return; 
            if (e.button === 1 || e.button === 2) return; 
            this.clearDemoShapeAndSwitchToTry();
        }, true);
    },

    updateUIPosition() {
        if (!this.sidebar) return;
        // 全画面化に合わせてサイドバーを左端に配置し、ツールバーボタンの強制移動を解除します
        this.sidebar.style.left = '20px';
    },

    update() {},

    start() {
        if (this.entryBtn) this.entryBtn.style.display = '';
    },

    beginTutorial() {
        // ★追加：チュートリアル中は時刻スライダーを非表示にする
        const sliderContainer = document.getElementById('app1-time-slider-container');
        if (sliderContainer) {
            sliderContainer.style.display = 'none';
        }

        this.userBackupData = {
            buildingData: JSON.parse(JSON.stringify(AppState.buildingData)),
            selectedId: AppState.selectedId,
            selectedFaceDir: AppState.selectedFaceDir
        };

        AppState.selectedId = null;
        AppState.selectedFaceDir = null;

        if (window.UIController) {
            window.UIController.clearGUI();
            window.UIController.hideFloatingMenu();
        }
        document.querySelectorAll('.lil-gui').forEach(el => el.style.display = 'none');

        this.entryBtn.style.display = 'none';
        this.isActive = true;
        this.sidebar.style.display = 'flex';
        
        // ★追加：チュートリアルを開始（再開）した直後は、すべてのメニューを畳んでおく
        this.isDrawMenuOpen = false;
        this.isBaseMenuOpen = false;
        
        this.jumpTo(-1); 
    },

    // 最後にユーザーが物理操作していた「その正確な座標」でイベントを安全に解除する（ワープ回転の完全防止）
    resetPointerState() {
        const cx = lastPhysicalX;
        const cy = lastPhysicalY;
        const canvas = document.querySelector('canvas');
        
        const evUp = createPointerEvent('pointerup', cx, cy);
        const evCancel = createPointerEvent('pointercancel', cx, cy);
        const evMouseUp = createMouseEvent('mouseup', cx, cy);

        if (canvas) {
            canvas.dispatchEvent(evUp);
            canvas.dispatchEvent(evCancel);
            canvas.dispatchEvent(evMouseUp);
        }
        document.dispatchEvent(evUp);
        document.dispatchEvent(evCancel);
        document.dispatchEvent(evMouseUp);
        window.dispatchEvent(evUp);
        window.dispatchEvent(evCancel);
        window.dispatchEvent(evMouseUp);
    },

    // ★追加：アコーディオンメニューの開閉を切り替えるメソッド
    toggleMenu(type) {
        if (type === 'draw') {
            this.isDrawMenuOpen = !this.isDrawMenuOpen;
        } else if (type === 'base') {
            this.isBaseMenuOpen = !this.isBaseMenuOpen;
        }
        this.updateSidebar();
    },

    jumpTo(idx) {
        // 既存のデモ非同期ループを確実に殺すためにトークンを進める
        this.demoRunToken++;
        this.demoActive = false;
        this.isDemoShapeShowing = false;
        this.taskCompleted = false; 
        
        // 開始前に強制的にポインター（OrbitControls）の状態をリセット
        this.resetPointerState();

        if (this._userActionListener) {
            if (this.three.controls) this.three.controls.removeEventListener('change', this._userActionListener);
            document.removeEventListener('pointerup', this._userActionListener);
            this._userActionListener = null;
        }

        if (this.three.controls) {
            this.three.controls.enabled = true;
        }
        this.shieldDom.style.display = 'none'; 
        this.setCursorEffect("default"); 

        this.cursorDom.style.display = 'none';
        if (window.setTool) window.setTool(null);
        if (window.UIController) {
            window.UIController.hideFloatingMenu();
            window.UIController.clearGUI();
        }

        this.currentStepIndex = idx;
        this.customTopText = null;

        if (idx === -1) {
            AppState.buildingData = [];
            AppState.saveState();
            this.three.rebuildMeshes();
            this.updateSidebar();
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            return;
        }

        const step = tutorialSteps[idx];

        // ★追加：ジャンプ先の章に応じて、対象のアコーディオンメニューを自動で開く
        if (step.chapter <= 6) {
            this.isDrawMenuOpen = true;
        } else if (step.chapter >= 7) {
            this.isBaseMenuOpen = true;
        }
        
        if (step.prerequisiteState) {
            AppState.buildingData = JSON.parse(JSON.stringify(step.prerequisiteState));
        } else {
            AppState.buildingData = [];
        }
        AppState.saveState();
        this.three.rebuildMeshes();

        this.demoActive = true;
        this.updateSidebar();

        if (step.action.includes('play_demo')) {
            if (this.controlContainer) this.controlContainer.classList.add('control-container-locked');
            if (this.three.controls) this.three.controls.enabled = true;
            this.shieldDom.style.display = 'block'; 
        } else {
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            if (this.three.controls) this.three.controls.enabled = true;
            this.shieldDom.style.display = 'none'; 
        }

        if (step.action === "wait_for_camera" || step.action === "wait_for_any_action") {
            let actionCounter = 0;
            this._userActionListener = () => {
                if (this.demoActive || this.isDemoShapeShowing) return;
                
                actionCounter++;
                const limit = step.action === "wait_for_camera" ? 5 : 0; 
                
                if (actionCounter > limit) {
                    this.notifyTrigger("any_action_complete");
                    if (this._userActionListener) {
                        if (this.three.controls) this.three.controls.removeEventListener('change', this._userActionListener);
                        document.removeEventListener('pointerup', this._userActionListener);
                        this._userActionListener = null;
                    }
                }
            };
            
            if (step.action === "wait_for_camera") {
                this.three.controls.addEventListener('change', this._userActionListener);
            } else {
                document.addEventListener('pointerup', this._userActionListener);
            }
        }

        this.executeStep(step);
    },

    updateSidebar() {
        if (!this.isActive) return;

        let topHtml = "";
        
        if (this.currentStepIndex === -1) {
            topHtml = `
                <div style="background:#f0f7ff; border:2px solid #007acc; border-radius:8px; padding:12px; margin-bottom:12px; box-shadow:0 4px 15px rgba(0,0,0,0.1);">
                    <div style="font-weight:bold; font-size:14px; margin-bottom:8px; color:#333; line-height:1.4;">👋 チュートリアルへようこそ</div>
                    <div style="font-size:12px; color:#555; line-height:1.5;">下のメニューから知りたい操作のボタンを押してください。操作の見本デモが始まります。<br><span style="color:#d93025; font-weight:bold;">※デモ再生中はブラウザの画面サイズを変更しないでください。</span></div>
                </div>
            `;
        } else {
            const step = tutorialSteps[this.currentStepIndex];
            const showAsTryMode = !step.action.includes('play_demo') || this.isDemoShapeShowing;
            
            const topBg = showAsTryMode ? '#f0fff4' : '#f0f7ff';
            const topBorder = showAsTryMode ? '#28a745' : '#007acc';
            const displayTitle = showAsTryMode ? step.chapterTitle : '👀 ' + step.title;
            const displayText = this.customTopText || (this.isDemoShapeShowing ? "では今の操作をあなた自身でやってみましょう" : step.text);

            topHtml = `
                <div style="background:${topBg}; border:2px solid ${topBorder}; border-radius:8px; padding:12px; margin-bottom:12px; box-shadow:0 4px 15px rgba(0,0,0,0.1);">
                    <div style="font-weight:bold; font-size:14px; margin-bottom:8px; color:#333; line-height:1.4; word-break:keep-all; overflow-wrap:break-word;">${displayTitle}</div>
                    <div style="font-size:12px; color:#555; line-height:1.5;">${displayText}</div>
                </div>
            `;
        }

        let midHtml = `<div style="background:#fff; border:1px solid #ddd; border-radius:8px; padding:12px; margin-bottom:12px; box-shadow:0 4px 15px rgba(0,0,0,0.05);">`;
        
        // ★修正：作図メニューのヘッダーをクリッカブルにして折りたたみ対応
        const drawMenuArrow = this.isDrawMenuOpen ? '▼' : '▶';
        midHtml += `
            <div onclick="window.TutorialManager.toggleMenu('draw')" style="font-weight:bold; font-size:13px; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:6px; color:#111; cursor:pointer; display:flex; justify-content:space-between; align-items:center; user-select:none;">
                <span>📋 作図メニュー</span>
                <span style="font-size:10px; color:#888;">${drawMenuArrow}</span>
            </div>
            <div style="display: ${this.isDrawMenuOpen ? 'block' : 'none'};">
        `;

        const chapters = [];
        tutorialSteps.forEach((s, i) => {
            if (!chapters.find(c => c.id === s.chapter)) {
                chapters.push({ id: s.chapter, title: s.chapterTitle, demoIdx: i, tryIdx: i + 1 });
            }
        });

        const activeChapterId = this.currentStepIndex !== -1 ? tutorialSteps[this.currentStepIndex].chapter : -1;

        chapters.forEach(ch => {
            if (ch.id === 7) {
                // ★追加：作図メニューのコンテンツ枠を閉じる
                midHtml += `</div>`;
                
                // ★修正：基礎操作のヘッダーもクリッカブルにして折りたたみ対応
                const baseMenuArrow = this.isBaseMenuOpen ? '▼' : '▶';
                midHtml += `
                    <div onclick="window.TutorialManager.toggleMenu('base')" style="font-weight:bold; font-size:13px; margin-top:5px; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:6px; color:#111; cursor:pointer; display:flex; justify-content:space-between; align-items:center; user-select:none;">
                        <span>🕹️ 基礎操作</span>
                        <span style="font-size:10px; color:#888;">${baseMenuArrow}</span>
                    </div>
                    <div style="display: ${this.isBaseMenuOpen ? 'block' : 'none'};">
                `;
            }

            const isActive = (activeChapterId === ch.id);
            
            if (isActive) {
                let buttonsHtml = `
                    <button class="tutorial-mini-btn" style="margin-bottom: ${this.taskCompleted ? '6px' : '0'};" onclick="window.TutorialManager.replayDemo()">🔄 もう一度デモ</button>
                `;
                if (this.taskCompleted) {
                    const btnLabel = (ch.id === 7 || ch.id === 8) ? "✏️ もう一度操作" : "✏️ もう一度作図";
                    buttonsHtml += `
                        <button class="tutorial-mini-btn" onclick="window.TutorialManager.jumpTo(${ch.tryIdx})">${btnLabel}</button>
                    `;
                }

                midHtml += `
                    <div style="background: #f0f7ff; border: 1px solid #b3d7ff; border-left: 5px solid #007acc; border-radius: 4px; padding: 10px; margin-bottom: 8px; box-sizing: border-box;">
                        <div style="font-size: 13px; font-weight: bold; color: #005a9e; margin-bottom: 8px; display: flex; align-items: flex-start; line-height: 1.4;">
                            <span class="icon" style="margin-right: 4px; margin-top: 1px;">▶</span>
                            <span class="text" style="flex: 1; word-break: keep-all; overflow-wrap: break-word;">${ch.title}</span>
                        </div>
                        <div style="display:flex; flex-direction: column; width: 100%; box-sizing: border-box;">${buttonsHtml}</div>
                    </div>
                `;
            } else {
                midHtml += `<button class="tutorial-chapter-btn" onclick="window.TutorialManager.jumpTo(${ch.demoIdx})">
                    <span class="icon">▶</span><span class="text">${ch.title}</span>
                </button>`;
            }
        });
        
        // ★追加：基礎操作（または最後のセクション）のコンテンツ枠を閉じる
        midHtml += `</div>`;
        midHtml += `</div>`;

        let botHtml = `
            <button id="btn-terminate-tutorial" class="tutorial-chapter-btn" style="background:#fff0f0; border-color:#ffcccc; color:#d93025; justify-content:center; align-items:center; margin-bottom:0; opacity: 1;" onclick="window.TutorialManager.terminateTutorial()">
                🛑 チュートリアルを終わる
            </button>
        `;

        this.sidebar.innerHTML = topHtml;
        if (!this.controlContainer) {
            this.controlContainer = document.createElement('div');
            this.controlContainer.style.width = '100%';
            this.controlContainer.style.display = 'flex';
            this.controlContainer.style.flexDirection = 'column';
        }
        this.controlContainer.innerHTML = midHtml + botHtml;
        this.sidebar.appendChild(this.controlContainer);
    },

    executeStep(stepData) {
        if (stepData.cameraPos && this.three.camera) {
            this.three.camera.position.copy(stepData.cameraPos);
        }
        if (stepData.lookAt && this.three.controls) {
            this.three.controls.target.copy(stepData.lookAt);
        }
        if (this.three.controls) {
            const prevEnabled = this.three.controls.enabled;
            this.three.controls.enabled = false;
            this.three.controls.update(); 
            this.three.controls.enabled = prevEnabled;
        }

        if (stepData.action === "play_demo_sequence" && stepData.demoSequence) {
            this.playDemoSequence(stepData.demoSequence);
        } 
        else if (stepData.action === "wait_for_draw" || stepData.action === "wait_for_extrude" || stepData.action === "wait_for_camera" || stepData.action === "wait_for_any_action") {
            if (window.setTool) window.setTool(null); 
        }
    },

    setCursorEffect(effect) {
        const arrow = document.getElementById('cursor-arrow');
        const mouse = document.getElementById('cursor-mouse');
        const leftBtn = document.getElementById('mouse-left-btn');
        const label = document.getElementById('cursor-label');
        const shiftKey = document.getElementById('cursor-shift-key'); 
        const wheelGlow = document.getElementById('cursor-wheel-glow'); 
        
        if (!arrow || !mouse || !leftBtn || !label || !shiftKey) return;

        if (effect === 'click' || effect === 'dblclick' || effect === 'tplclick') {
            arrow.style.opacity = '0'; mouse.style.opacity = '1';
            leftBtn.setAttribute('fill', '#007acc');
            
            if (effect === 'click') label.innerText = 'Click';
            else if (effect === 'dblclick') label.innerText = 'Click×2';
            else if (effect === 'tplclick') label.innerText = 'Click×3';
            
            label.style.opacity = '1'; shiftKey.style.opacity = '0';
            if (wheelGlow) { wheelGlow.style.opacity = '0'; wheelGlow.classList.remove('tutorial-wheel-active'); }
        } else if (effect === 'drag') {
            arrow.style.opacity = '0'; mouse.style.opacity = '1';
            leftBtn.setAttribute('fill', '#007acc'); label.innerText = 'Drag';
            label.style.opacity = '1'; shiftKey.style.opacity = '0';
            if (wheelGlow) { wheelGlow.style.opacity = '0'; wheelGlow.classList.remove('tutorial-wheel-active'); }
        } else if (effect === 'shift_drag') {
            arrow.style.opacity = '0'; mouse.style.opacity = '1';
            leftBtn.setAttribute('fill', '#007acc'); label.innerText = 'Drag';
            label.style.opacity = '1'; shiftKey.style.opacity = '1'; 
            if (wheelGlow) { wheelGlow.style.opacity = '0'; wheelGlow.classList.remove('tutorial-wheel-active'); }
        } 
        else if (effect === 'wheel') {
            arrow.style.opacity = '0'; mouse.style.opacity = '1';
            leftBtn.setAttribute('fill', 'white'); label.innerText = 'Wheel';
            label.style.opacity = '1'; shiftKey.style.opacity = '0';
            if (wheelGlow) { 
                wheelGlow.style.opacity = '1'; 
                wheelGlow.classList.add('tutorial-wheel-active'); 
            }
        } else {
            arrow.style.opacity = '1'; mouse.style.opacity = '0';
            leftBtn.setAttribute('fill', 'white'); label.style.opacity = '0';
            shiftKey.style.opacity = '0';
            if (wheelGlow) { wheelGlow.style.opacity = '0'; wheelGlow.classList.remove('tutorial-wheel-active'); }
        }
    },

    async animMoveCursor(tx, ty, effect, token) {
        return new Promise(resolve => {
            const sx = parseFloat(this.cursorDom.style.left) || window.innerWidth / 2;
            const sy = parseFloat(this.cursorDom.style.top) || window.innerHeight / 2;
            const dist = Math.hypot(tx - sx, ty - sy);
            const duration = Math.max(400, Math.min(dist * 2, 800)); 

            let startT = performance.now();
            const move = (t) => {
                if (token !== this.demoRunToken) return resolve(); 
                let p = (t - startT) / duration;
                if (p > 1) p = 1;
                let ease = p * (2 - p);
                this.cursorDom.style.left = `${sx + (tx - sx) * ease}px`;
                this.cursorDom.style.top = `${sy + (ty - sy) * ease}px`;
                
                if (p < 1) requestAnimationFrame(move);
                else {
                    if (effect) this.setCursorEffect(effect);
                    this.cursorDom.style.transform = 'scale(0.8)';
                    setTimeout(() => {
                        if (token !== this.demoRunToken) return resolve();
                        this.cursorDom.style.transform = 'scale(1)';
                        resolve();
                    }, 150);
                }
            };
            requestAnimationFrame(move);
        });
    },

    async animDragCursor(start2D, end2D, duration, onUpdate, token) {
        return new Promise(resolve => {
            let startT = performance.now();
            const move = (t) => {
                if (token !== this.demoRunToken) return resolve(); 
                let p = (t - startT) / (duration || 1000);
                if (p > 1) p = 1;
                let ease = 1 - Math.pow(1 - p, 3);
                
                const cx = start2D.x + (end2D.x - start2D.x) * ease;
                const cy = start2D.y + (end2D.y - start2D.y) * ease;
                this.cursorDom.style.left = `${cx}px`;
                this.cursorDom.style.top = `${cy}px`;
                
                if (onUpdate) onUpdate(cx, cy);

                if (p < 1) requestAnimationFrame(move);
                else resolve();
            };
            requestAnimationFrame(move);
        });
    },

    dispatchPointer(target, type, x, y, shiftKey = false) {
        if (!target) return;
        target.dispatchEvent(createPointerEvent(type, x, y, shiftKey));
    },

    async playDemoSequence(sequence) {
        const token = ++this.demoRunToken; 
        
        this.cursorDom.style.display = 'block';
        let cursorX = window.innerWidth / 2;
        let cursorY = window.innerHeight / 2;
        this.cursorDom.style.left = `${cursorX}px`;
        this.cursorDom.style.top = `${cursorY}px`;

        for (const action of sequence) {
            if (token !== this.demoRunToken) break; 
            const canvas = document.querySelector('canvas');

            if (action.type === "real_click_dom") {
                let el = null;
                for (let i = 0; i < 8; i++) {
                    if (action.targetId) el = document.getElementById(action.targetId);
                    else if (action.text) {
                        const els = Array.from(document.querySelectorAll('*'));
                        el = els.find(e => e.children.length === 0 && e.textContent.includes(action.text) && e.getBoundingClientRect().width > 0);
                        if (!el) {
                            const fallbacks = Array.from(document.querySelectorAll('button, .btn, .float-btn, div, span'));
                            el = fallbacks.reverse().find(e => e.innerText && e.innerText.includes(action.text) && e.getBoundingClientRect().width > 0);
                        }
                    }
                    if (el) break;
                    await new Promise(r => setTimeout(r, 60)); 
                }

                if (el) {
                    const rect = el.getBoundingClientRect();
                    const tx = rect.left + rect.width / 2;
                    const ty = rect.top + rect.height / 2;
                    
                    await this.animMoveCursor(tx, ty, action.cursorEffect, token);
                    if (token !== this.demoRunToken) break;
                    
                    el.dispatchEvent(createPointerEvent('pointerdown', tx, ty));
                    el.dispatchEvent(createMouseEvent('mousedown', tx, ty));
                    el.dispatchEvent(createPointerEvent('pointerup', tx, ty));
                    el.dispatchEvent(createMouseEvent('mouseup', tx, ty));
                    el.click(); 
                    
                    await new Promise(r => setTimeout(r, 300)); 
                    if (token !== this.demoRunToken) break;
                    this.setCursorEffect("default");
                }
            }
            else if (action.type === "real_click_3d") {
                const pos2D = this.getScreenPos(action.targetPos);
                await this.animMoveCursor(pos2D.x, pos2D.y, action.cursorEffect, token);
                if (token !== this.demoRunToken) break;
                
                this.dispatchPointer(canvas, 'pointerdown', pos2D.x, pos2D.y, action.shiftKey);
                await new Promise(r => setTimeout(r, 100)); 
                if (token !== this.demoRunToken) break;
                
                this.dispatchPointer(canvas, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                this.dispatchPointer(document, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                this.dispatchPointer(window, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                
                canvas.dispatchEvent(createMouseEvent('click', pos2D.x, pos2D.y, action.shiftKey));
                
                await new Promise(r => setTimeout(r, 400));
                if (token !== this.demoRunToken) break;
                this.setCursorEffect("default");
            }
            else if (action.type === "real_dblclick_3d" || action.type === "real_tplclick_3d") {
                const pos2D = this.getScreenPos(action.targetPos);
                await this.animMoveCursor(pos2D.x, pos2D.y, "default", token);
                if (token !== this.demoRunToken) break;
                
                const clicks = action.type === "real_dblclick_3d" ? 2 : 3;
                const leftBtn = document.getElementById('mouse-left-btn');
                
                for (let c = 0; c < clicks; c++) {
                    this.setCursorEffect(action.cursorEffect); 
                    
                    this.dispatchPointer(canvas, 'pointerdown', pos2D.x, pos2D.y, action.shiftKey);
                    canvas.dispatchEvent(createMouseEvent('mousedown', pos2D.x, pos2D.y, action.shiftKey, c + 1));
                    
                    await new Promise(r => setTimeout(r, 100)); 
                    if (token !== this.demoRunToken) break;
                    
                    if (leftBtn) leftBtn.setAttribute('fill', 'white');
                    
                    this.dispatchPointer(canvas, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                    this.dispatchPointer(document, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                    this.dispatchPointer(window, 'pointerup', pos2D.x, pos2D.y, action.shiftKey);
                    
                    canvas.dispatchEvent(createMouseEvent('mouseup', pos2D.x, pos2D.y, action.shiftKey, c + 1));
                    canvas.dispatchEvent(createMouseEvent('click', pos2D.x, pos2D.y, action.shiftKey, c + 1));
                    
                    if (c === 1) {
                        canvas.dispatchEvent(createMouseEvent('dblclick', pos2D.x, pos2D.y, action.shiftKey, 2));
                    }
                    
                    await new Promise(r => setTimeout(r, 150));
                    if (token !== this.demoRunToken) break;
                }
                
                if (token !== this.demoRunToken) break;
                await new Promise(r => setTimeout(r, 400));
                if (token !== this.demoRunToken) break;
                this.setCursorEffect("default");
            }
            else if (action.type === "real_drag_3d") {
                const start2D = this.getScreenPos(action.startPos);
                const end2D = this.getScreenPos(action.endPos);
                await this.animMoveCursor(start2D.x, start2D.y, action.cursorEffect, token);
                if (token !== this.demoRunToken) break;
                
                this.dispatchPointer(canvas, 'pointerdown', start2D.x, start2D.y, action.shiftKey);
                await new Promise(r => setTimeout(r, 50));
                if (token !== this.demoRunToken) break;

                await this.animDragCursor(start2D, end2D, action.duration, (cx, cy) => {
                    this.dispatchPointer(canvas, 'pointermove', cx, cy, action.shiftKey);
                    this.dispatchPointer(window, 'pointermove', cx, cy, action.shiftKey);
                    this.dispatchPointer(document, 'pointermove', cx, cy, action.shiftKey);
                    canvas.dispatchEvent(createMouseEvent('mousemove', cx, cy, action.shiftKey));
                    window.dispatchEvent(createMouseEvent('mousemove', cx, cy, action.shiftKey));
                }, token);
                if (token !== this.demoRunToken) break;

                this.dispatchPointer(window, 'pointerup', end2D.x, end2D.y, action.shiftKey);
                this.dispatchPointer(document, 'pointerup', end2D.x, end2D.y, action.shiftKey);
                this.dispatchPointer(canvas, 'pointerup', end2D.x, end2D.y, action.shiftKey);
                
                window.dispatchEvent(createMouseEvent('mouseup', end2D.x, end2D.y, action.shiftKey));
                document.dispatchEvent(createMouseEvent('mouseup', end2D.x, end2D.y, action.shiftKey));
                canvas.dispatchEvent(createMouseEvent('mouseup', end2D.x, end2D.y, action.shiftKey));
                
                await new Promise(r => setTimeout(r, 400));
                if (token !== this.demoRunToken) break;
                this.setCursorEffect("default");
            }
            else if (action.type === "real_wheel_3d") {
                const pos2D = this.getScreenPos(action.targetPos);
                await this.animMoveCursor(pos2D.x, pos2D.y, action.cursorEffect, token);
                if (token !== this.demoRunToken) break;
                
                const steps = 12; 
                const duration = action.duration || 1500;
                const stepTime = (duration - 300) / steps;
                const stepDeltaY = action.deltaY / steps;

                for (let i = 0; i < steps; i++) {
                    if (token !== this.demoRunToken) break;
                    const wheelEv = createWheelEvent('wheel', pos2D.x, pos2D.y, stepDeltaY);
                    canvas.dispatchEvent(wheelEv);
                    await new Promise(r => setTimeout(r, stepTime));
                }
                if (token !== this.demoRunToken) break;
                
                await new Promise(r => setTimeout(r, 300));
                if (token !== this.demoRunToken) break;
                this.setCursorEffect("default");
            }
            await new Promise(r => setTimeout(r, 100)); 
        }

        if (token === this.demoRunToken) {
            this.demoActive = false; 
            if (this.cursorDom) {
                this.cursorDom.style.display = 'none';
            }
            
            this.resetPointerState();
            this.isDemoShapeShowing = true;
            this.shieldDom.style.display = 'none';
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            
            if (this.three.controls) {
                this.three.controls.enabled = true;
            }
            this.updateSidebar();
        }
    },

    clearDemoShapeAndSwitchToTry() {
        if (!this.isDemoShapeShowing) return;
        this.isDemoShapeShowing = false;
        this.demoRunToken++; 
        
        if (this.cursorDom) {
            this.cursorDom.style.display = 'none';
        }

        this.shieldDom.style.display = 'none'; 
        this.setCursorEffect("default");

        const nextTryIdx = this.currentStepIndex | 1; 
        this.currentStepIndex = nextTryIdx;
        
        const step = tutorialSteps[nextTryIdx];
        if (step && step.prerequisiteState) {
            AppState.buildingData = JSON.parse(JSON.stringify(step.prerequisiteState));
        } else {
            AppState.buildingData = [];
        }
        
        this.resetPointerState(); 
        this.three.rebuildMeshes();
        
        if (window.UIController) {
            window.UIController.clearGUI();
            window.UIController.hideFloatingMenu();
        }
        
        AppState.selectedId = null;
        AppState.selectedFaceDir = null;

        if (step && (step.chapter === 7 || step.chapter === 8)) {
            if (step.cameraPos && this.three.camera) {
                this.three.camera.position.copy(step.cameraPos);
            }
            if (step.lookAt && this.three.controls) {
                this.three.controls.target.copy(step.lookAt);
            }
            if (this.three.controls) {
                const prevEnabled = this.three.controls.enabled;
                this.three.controls.enabled = false;
                this.three.controls.update(); 
                this.three.controls.enabled = prevEnabled;
            }
        }
        
        if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
        if (this.three.controls) {
            this.three.controls.enabled = true;
        }
        this.updateSidebar();

        const buttons = document.querySelectorAll('.snap-btn, [id*="snap"], button, .btn, .float-btn');
        let snapBtn = Array.from(buttons).find(b => b.innerText && (b.innerText.trim() === "100" || b.innerText.trim() === "500") && b.getBoundingClientRect().width > 0);
        if (snapBtn) {
            for (let i = 0; i < 10; i++) {
                if (snapBtn.innerText.includes("500")) break;
                snapBtn.click();
            }
        }
    },

    replayDemo() {
        this.isDemoShapeShowing = false;
        this.taskCompleted = false;
        this.jumpTo(tutorialSteps.findIndex(s => s.chapter === tutorialSteps[this.currentStepIndex].chapter));
    },

    getScreenPos(vec3) {
        if (!this.three.camera) return { x: 0, y: 0 };
        const vector = vec3.clone();
        vector.project(this.three.camera); 
        const fullW = window.innerWidth;
        const fullH = window.innerHeight;
        const subW = (fullH / 4) * 1.5;         
        const mainW = fullW - subW;      
        return {
            x: ((vector.x * 0.5) + 0.5) * mainW + subW,
            y: (-(vector.y * 0.5) + 0.5) * fullH
        };
    },
    
    notifyTrigger(eventType) {
        if (!this.isActive || this.currentStepIndex === -1) return;

        if (this.demoActive || this.isDemoShapeShowing) return;

        if (eventType === "click_btn_draw" && (this.currentStepIndex === 0 || this.currentStepIndex === 1)) {
            this.isDemoShapeShowing = false;
            this.currentStepIndex = 1; 
            AppState.buildingData = [];
            this.three.rebuildMeshes();
            
            if (this.cursorDom) this.cursorDom.style.display = 'none';

            this.shieldDom.style.display = 'none';
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            if (this.three.controls) this.three.controls.enabled = true;
            this.updateSidebar();
            return;
        }

        if (eventType === "draw_complete" && (this.currentStepIndex === 0 || this.currentStepIndex === 1)) {
            this.taskCompleted = true;
            this.currentStepIndex = 1; 
            const stepData = tutorialSteps[1];
            this.customTopText = stepData.successText;

            if (this.cursorDom) this.cursorDom.style.display = 'none';

            this.shieldDom.style.display = 'none';
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            if (this.three.controls) this.three.controls.enabled = true;
            this.updateSidebar();
            return;
        }

        if (eventType === "extrude_complete" || eventType === "roof_complete" || eventType === "any_action_complete") {
            this.taskCompleted = true;
            const stepData = tutorialSteps[this.currentStepIndex];
            if (stepData) {
                this.customTopText = stepData.successText;
            }

            if (this.cursorDom) this.cursorDom.style.display = 'none';

            this.shieldDom.style.display = 'none';
            if (this.controlContainer) this.controlContainer.classList.remove('control-container-locked');
            if (this.three.controls) this.three.controls.enabled = true;
            this.updateSidebar();
            return;
        }
    },

    terminateTutorial() {
        this.demoRunToken++; 

        // ★追加：チュートリアル終了時に時刻スライダーを再表示する
        const sliderContainer = document.getElementById('app1-time-slider-container');
        if (sliderContainer) {
            sliderContainer.style.display = ''; 
        }
        
        if (window.setTool) window.setTool(null); 
        this.sidebar.className = 'tutorial-sidebar';
        this.sidebar.style.display = 'none';
        if (this.entryBtn) this.entryBtn.style.display = ''; 
        this.isActive = false;
        this.demoActive = false;
        this.isDemoShapeShowing = false;
        this.taskCompleted = false;
        
        if (this.cursorDom) {
            this.cursorDom.style.display = 'none';
        }
        
        if (this._userActionListener) {
            if (this.three.controls) this.three.controls.removeEventListener('change', this._userActionListener);
            document.removeEventListener('pointerup', this._userActionListener);
            this._userActionListener = null;
        }

        this.shieldDom.style.display = 'none';
        this.setCursorEffect("default");
        
        this.resetPointerState();
        
        if (this.three.controls) {
            this.three.controls.enabled = true;
        }
        
        AppState.selectedId = null;
        AppState.selectedFaceDir = null;

        if (window.UIController) {
            window.UIController.clearGUI();
            window.UIController.hideFloatingMenu();
        }

        document.querySelectorAll('.lil-gui').forEach(el => {
            el.style.display = 'none';
            el.remove(); 
        });
        
        const floatMenu = document.getElementById('floating-menu');
        if (floatMenu) {
            floatMenu.style.display = 'none';
        }

        if (this.userBackupData) {
            AppState.buildingData = JSON.parse(JSON.stringify(this.userBackupData.buildingData));
            AppState.selectedId = this.userBackupData.selectedId;
            AppState.selectedFaceDir = this.userBackupData.selectedFaceDir;
            this.userBackupData = null; 
        } else {
            AppState.buildingData = [];
            AppState.selectedId = null;
            AppState.selectedFaceDir = null;
        }

        if (window.UIController) {
            window.UIController.clearGUI();
        }

        this.three.rebuildMeshes();
    }
};
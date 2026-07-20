// ms_styles.js

export function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
        body { margin: 0; overflow: hidden; background-color: #1a1a1a; font-family: sans-serif; color: #000000; } /* ★ベースを黒文字化 */
        
        /* ツールチップ・ガイダンス関連 */
        .tooltip-box {
            background: transparent; border: 1px solid #888; border-radius: 6px; padding: 8px 12px; /* ★背景を透明に */
            color: #000000; font-size: 13px; pointer-events: none; box-shadow: none; line-height: 1.4; font-weight: bold; /* ★黒文字化 */
        }
        
        /* ★新設：画質トグルとガイダンスを美しく横並びにするヘッダーコンテナ（案A） */
        #panel-header-row {
            display: flex;
            justify-content: space-between;
            align-items: center; /* 行数が変わっても縦中央を美しく維持 */
            width: 100%;
            min-height: 54px;   /* ★追加：最初から3行分の高さを固定確保し、下のパネルのガタつきを完全防止 */
            margin-bottom: 8px;
            pointer-events: auto;
        }

        /* ★修正：「クリックで面を選択」ガイダンスの絶対配置を解除し、ヘッダーの右側にスマートに配置 */
        .canvas-tooltip { 
            position: relative; 
            z-index: 50; 
            text-align: left; /* 左詰めのほうが見やすいため変更 */
            background: #d0d0d0 !important; /* ★少し暗めの灰色に統一 */
            border: 1px solid #888 !important; /* うっすらとした枠線 */
            border-radius: 6px;
            padding: 6px 10px; /* パーツとして美しく見える余白を確保 */
            box-shadow: none;
            font-size: 13px;
            color: #000000; 
            font-weight: bold;
            line-height: 1.3;
            max-width: 180px; /* 幅をわずかに広げて収まりを最適化 */
        }
        
        /* ★修正：色相スライダーのツールチップを「初期は非表示（ホバーで表示）」に制御 */
        .wheel-tooltip { 
            position: absolute; 
            top: -45px; 
            left: 50%; 
            transform: translateX(-50%); 
            white-space: nowrap; 
            visibility: hidden;
            opacity: 0;
            transition: all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); 
            z-index: 100;
            transform-origin: bottom center;
        }
        /* ★ホバーまたはドラッグロック中なら表示し、右下端（以前折り合って固定したジャスト位置）を完全維持 */
        #col-wheel:hover .wheel-tooltip,
        #col-wheel.is-dragging .wheel-tooltip {
            visibility: visible;
            opacity: 1;
            transform: scale(1.0); 
            left: auto;
            right: 18px; /* 記憶した位置 */
            top: auto;
            bottom: 20px; /* 記憶した位置 */
        }
        
        #hover-message-box {
            position: absolute; 
            left: 125px; 
            top: 2px; 
            background: transparent; 
            border: none; 
            padding: 0; 
            font-size: 14px; color: #000000; font-weight: bold; /* ★黒文字化 */
            opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0.2s; pointer-events: none; z-index: 100;
        }

        /* カメラアングル調整用HUD */
        #camera-hud {
            position: absolute; top: 20px; right: 20px;
            background: transparent; border: 1px solid #888; padding: 10px 14px; border-radius: 6px; /* ★背景透明、灰色線に */
            font-family: monospace; font-size: 12px; color: #000000; z-index: 50; pointer-events: none; /* ★黒文字化 */
            line-height: 1.5; box-shadow: none; font-weight: bold;
        }

        /* ★修正：画質モード切替トグルの絶対配置を解除し、ヘッダーの左側にスリムにインライン化 */
        #spec-toggle-container {
            position: relative;
            background: transparent; 
            border: none; 
            padding: 0; 
            display: flex; 
            align-items: center; 
            gap: 8px; 
            z-index: 100; 
            box-shadow: none; 
            pointer-events: auto;
        }
        .toggle-label { font-size: 13px; font-weight: bold; color: #888; transition: color 0.3s ease; } /* 通常の文字を少し薄い黒（灰色）に */
        .toggle-label.active-high { color: #000000; text-decoration: underline; } /* ★アクティブ時をクッキリ黒文字（下線付き）に */
        .toggle-label.active-low { color: #000000; text-decoration: underline; } /* ★アクティブ時をクッキリ黒文字（下線付き）に */

        .toggle-switch { position: relative; display: inline-block; width: 44px; height: 22px; cursor: pointer; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #ffaa00; transition: .3s; border-radius: 22px; border: 2px solid #333;
        }
        .toggle-slider:before {
            position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px;
            background-color: #111; transition: .3s; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.8);
        }
        input:checked + .toggle-slider { background-color: #deff9a; }
        input:checked + .toggle-slider:before { transform: translateX(22px); }

        /* --- 3D描画領域 --- */
        #canvas-wrapper { position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 1; }
        #canvas-container { width: 100%; height: 100%; }

        /* --- 画面下部のUI全体をまとめるラッパー --- */
        #bottom-ui-wrapper {
            /* ★変更：親アプリの黒いスライダーパネルをかわすため、40pxから85pxに引き上げ */
            position: absolute; bottom: 85px; left: 50%; width: auto; 
            transform: translateX(-50%); /* ★基本はジャスト画面中央揃え */
            display: flex; justify-content: center; align-items: center;
            gap: 60px; /* ★追加：左の情報パネルと右のパレットの間の隙間を復活 */
            z-index: 10; pointer-events: none;
            transition: left 0.4s cubic-bezier(0.25, 1, 0.5, 1), transform 0.4s cubic-bezier(0.25, 1, 0.5, 1); /* ★滑らかなイージング */
        }

        /* ★修正：右端に畳まれる時の格納状態（ボタンが独立したため、パネル本体は100%画面外へ隠す） */
        #bottom-ui-wrapper.is-closed {
            left: 100%;
            transform: translateX(0); 
        }

        /* ★修正：UI全体を囲む親枠を完全に「透明」にし、スライド移動のための構造だけを残す */
        #ui-glass-panel {
            position: relative; 
            display: flex; justify-content: center; align-items: center; gap: 60px;
            padding: 24px 40px; 
            background: transparent; 
            border: none; 
            box-shadow: none; 
            pointer-events: none;
        }

        /* ★修正：引き出しUIの開閉用トリガーボタン（常に画面右端へ固定） */
        #ui-toggle-btn {
            position: absolute;
            right: 0; /* ★画面の右端にピタッと固定 */
            /* ★変更：パネルを上に60pxずらしたのに合わせて、このボタンも120pxから165pxに引き上げ */
            bottom: 165px; 
            width: 32px;
            height: 60px;
            background: #d0d0d0; /* ★他のUI窓と同じトーンの灰色で統一 */
            border: 1px solid #888;
            border-right: none;
            border-radius: 12px 0 0 12px; 
            color: #000000; /* ★黒文字化 */
            font-size: 14px;
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: pointer;
            pointer-events: auto;
            box-shadow: -4px 0 15px rgba(0,0,0,0.2);
            user-select: none;
            transition: color 0.2s, background 0.2s;
            z-index: 1000; /* ★常に最前面へ */
        }
        #ui-toggle-btn:hover {
            color: #ffffff; /* ホバー時は文字を白く */
            background: #888888; /* ホバー時は少し暗く */
        }

        /* --- 第1列（左）：情報パネル、手入力、建材色 --- */
        #col-info { display: flex; flex-direction: column; gap: 10px; pointer-events: auto; width: 300px; }

        /* 2. 情報＆入力 統合パネル */
        #color-info-panel {
            background: transparent; /* ★背景を完全に透明化 */
            padding: 10px 14px; 
            border-radius: 12px;
            border: 1px solid #888; /* ★外周線をシンプルな灰色に変更 */
            width: 100%; box-sizing: border-box; 
            box-shadow: none; /* ★パネル単体の影を削除 */
            display: flex; flex-direction: column; 
            gap: 6px; 
        }
        .info-row { font-size: 18px; color: #000; line-height: 1.2; font-weight: bold; } /* ★黒文字化 */
        .info-val { color: #000; font-weight: bold; margin-left: 8px; font-family: monospace; } /* ★黒文字化 */
        
        .hex-row, .rgb-row { width: 100%; text-align: left; }

        /* ★マンセル手入力行を300px幅にジャストフィットさせる最適化 */
        .munsell-input-row { display: flex; align-items: center; justify-content: flex-start; width: 100%; } 
        .integrated-label { font-size: 18px; color: #000; white-space: nowrap; margin-right: 6px; font-family: sans-serif; font-weight: bold; } /* ★黒文字化 */
        .integrated-slash { color: #000; font-size: 18px; font-weight: bold; margin: 0 1px; } /* ★黒文字化 */
        .manual-controls { display: flex; align-items: center; gap: 2px; flex-wrap: nowrap; } 
        
        .manual-input { 
            background: #d0d0d0 !important; /* ★少し暗めの灰色に統一 */
            color: #000000 !important; 
            border: 1px solid #888 !important;
            border-radius: 4px; 
            padding: 4px 0px; 
            font-size: 18px; 
            font-weight: bold; /* ★視認性確保のため太字に */
            text-align: center; 
            box-sizing: border-box;
            outline: none;
            -webkit-appearance: none;
            appearance: none;
        }
        /* ★修正：数値入力欄と色相セレクトボックスの両方を、ホバー時に「左右ドラッグ可能」なカーソルに変更 */
        .manual-input[type="number"],
        #in-h-type {
            cursor: ew-resize; 
        }
        /* ★追加：クリックしてキーボード入力モード（フォーカス状態）になったら通常のテキストカーソルに戻す */
        .manual-input[type="number"]:focus {
            cursor: text;
        }

        #in-h-val  { width: 44px; } 
        #in-h-type { width: 52px; padding: 4px 0px; } 
        #in-v      { width: 44px; } 
        #in-c      { width: 44px; }
        .manual-input:focus { border-color: #000 !important; } /* ★フォーカス時は黒枠で強調 */

        /* ドロップダウントリガーを内包した色票ボックス */
        #selected-color-box { 
            position: relative; 
            width: 100%; 
            height: 40px; 
            box-sizing: border-box; 
            /* margin-top: 4px; ← 削除：これが左側だけ下にズレる原因でした */
            border: 1px solid #888; 
            border-radius: 6px; 
            transition: all 0.2s; 
            cursor: pointer; 
            display: flex; 
            align-items: center;
        }
        /* ★修正：JSから「transparent（無選択）」が送られてきた時だけ灰色で上書きする */
        #selected-color-box[style*="transparent"] {
            background-color: #d0d0d0 !important;
        }
        #selected-color-box:hover { border-color: #000000; box-shadow: 0 0 8px rgba(0,0,0,0.1); }
        .chip-arrow { 
            position: absolute; right: 12px; top: 50%; transform: translateY(-50%); 
            font-size: 12px; color: #000; pointer-events: none; text-shadow: none; 
        }

        /* 統合された2つのドロップダウンを美しく横並びにするフレックスコンテナ */
        .dropdown-split-row {
            display: flex;
            gap: 8px;
            width: 100%;
            margin-top: 4px;
        }

        /* サムネイル付きカスタムドロップダウンの意匠群 */
        .custom-dropdown { 
            position: relative; 
            width: 50%; 
            font-size: 14px; 
            color: #000; user-select: none; font-weight: bold; 
        }
        
        /* テクスチャ側の選択トリガー窓 */
        .custom-dropdown-selected {
            background: #d0d0d0; /* ★修正：「!important」を削除。これがカラー窓の色変更を邪魔していました */
            border: 1px solid #888; 
            border-radius: 6px; 
            height: 40px; 
            box-sizing: border-box; 
            padding: 0 8px; 
            display: flex; 
            align-items: center; 
            cursor: pointer; 
            transition: border-color 0.2s;
        }
        .custom-dropdown-selected:hover { border-color: #000; } 
        .custom-dropdown-text { flex-grow: 1; margin-left: 6px; }
        .custom-dropdown-arrow { font-size: 12px; color: #000; }
        
        /* 展開されるオプションリスト */
        .custom-dropdown-options {
            position: absolute; 
            width: 270px; 
            background: #ffffff; border: 1px solid #888; border-radius: 6px; /* ★完璧な潰れ対策：リスト背景を黒から白へ反転 */
            margin: 0; padding: 0; list-style: none; z-index: 999; display: none;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15); overflow: hidden;
        }
        /* ★修正：左側の定番色も右側のテクスチャと同様に「上向き」に展開させ、ブラック等の見切れを完全防止 */
        #preset-custom-dropdown .custom-dropdown-options { left: 0; bottom: calc(100% + 4px); top: auto; }
        #texture-custom-dropdown .custom-dropdown-options { right: 0; bottom: calc(100% + 4px); top: auto; }
        
        .custom-dropdown.open .custom-dropdown-options { display: block; }
        /* ★超重要：未選択・選択状態に関わらず、リスト内すべての文字色を「クッキリした黒（#000000）」に完全固定 */
        .custom-dropdown-options li { padding: 10px 14px; display: flex; align-items: center; cursor: pointer; color: #000000 !important; font-weight: bold; transition: background 0.15s; }
        .custom-dropdown-options li:hover { background: rgba(0, 0, 0, 0.08); color: #000000 !important; } /* ホバー時は薄いグレーの座布団を展開 */
        
        /* 質感表現用のミニ正方形サムネイル */
        .texture-thumb { width: 22px; height: 22px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); display: inline-block; flex-shrink: 0; margin-right: 8px; }
        .thumb-none { background: #333; position: relative; }
        .thumb-none::after { content: ''; position: absolute; width: 100%; height: 1px; background: rgba(255,255,255,0.2); top:50%; left:0; transform: rotate(45deg); }
        .thumb-sunakabe { background: radial-gradient(circle, #cbbca2 1px, transparent 1px), #ad9f85; background-size: 3px 3px; }
        .thumb-sugi { background: repeating-linear-gradient(0deg, #6e543f, #6e543f 3px, #553e2d 3px, #553e2d 6px); }
        .thumb-metallic { background: linear-gradient(135deg, #777 0%, #ccc 50%, #555 100%); }
        .thumb-glass { background: linear-gradient(135deg, #bce2ff 0%, #eef7ff 100%); opacity: 0.8; }

        /* パレットの親要素（右側） */
        #col-palette {
            position: relative; /* ★修正：円形スライダーがパレットエリアを基準にするために必須 */
            pointer-events: auto;
        }

        /* ★親枠：右下の定位置（デッドスペース）にセンサーとして固定。周囲を絶対に押し潰さない */
        #col-wheel {
            position: absolute; pointer-events: auto;
            display: flex; justify-content: center; align-items: center;
            width: 80px; height: 80px; 
            right: 16px; bottom: 1px;  
            z-index: 10;
            flex-shrink: 0; /* ★フレックスコンテナ内での自動縮小を絶対に禁止 */
        }

        /* ★実際に描画され、アニメーションして巨大化するのは中身のコンテナ（#wheel-container）にします */
        #wheel-container {
            position: relative; width: 62px; height: 62px; border-radius: 50%;
            background: conic-gradient(from 0deg, #e41a25 0%, #ff7521 10%, #f8be00 20%, #a5c000 30%, #009173 40%, #008177 50%, #0e88a0 60%, #0054a7 70%, #9b56b0 80%, #c935ba 90%, #e41a25 100%);
            box-shadow: 0 4px 15px rgba(0,0,0,0.5); border: 2px solid #333; touch-action: none; cursor: grab;
            transition: all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); 
            transform-origin: center center;
        }

        /* ★大枠（センサー）がホバーされたら、中身をパレット中央へ移動・巨大化・暗幕展開させる */
        #col-wheel:hover,
        #col-wheel.is-dragging {
            z-index: 9999; /* センサー自体を最前面に押し上げて操作性を確保 */
        }
        
        /* ★追加：巨大化中にパレットの色を変えずに誤操作を防ぐ「透明なシールド」を展開 */
        #col-wheel::before {
            content: ''; position: absolute;
            top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 0; height: 0; background: transparent; z-index: -1; border-radius: 50%;
        }
        /* ★ホバー時は、中央の大スライダーまでマウスを渡せるようにシールドを適度に広げる（戻らない問題の解決） */
        #col-wheel:hover::before {
            width: 380px; height: 380px; 
        }
        /* ★ドラッグ操作中のみ、画面全体を覆って操作を完全保護 */
        #col-wheel.is-dragging::before {
            width: 3000px; height: 3000px; cursor: default; 
        }

        #col-wheel:hover #wheel-container,
        #col-wheel.is-dragging #wheel-container {
            transform: translate(-145px, -90px) scale(2.6); 
            box-shadow: 0 15px 40px rgba(0,0,0,0.3); 
        }
        #wheel-container:active { cursor: grabbing; }
        #wheel-center {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 32px; height: 32px; 
            background: #ffffff; border-radius: 50%; border: 1.5px solid #888; /* ★内円を白背景、グレー枠に変更して黒文字を映えさせる */
            display: flex; flex-direction: column; justify-content: center; align-items: center; pointer-events: none; 
        }
        #wheel-knob-container { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
        #wheel-knob { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); width: 8px; height: 8px; background: #fff; border-radius: 50%; box-shadow: 0 0 4px rgba(0,0,0,0.3); border: 1.5px solid #222; }
        #hue-display { color: #000000; font-size: 11px; font-weight: bold; margin-top: 0px; transform: scale(1.2); white-space: nowrap; } /* ★色相環中央の「2.5R」などを黒文字化 */
        .hue-label { display: none; }

        /* --- パレット --- */
        #palette-container { position: relative; width: 420px; height: 280px; pointer-events: none; margin-bottom: 20px; }
        .color-chip { position: absolute; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; pointer-events: auto; box-shadow: 0 1px 2px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); transition: transform 0.1s, border 0.1s; } 
        .color-chip:hover { transform: scale(1.15); z-index: 20; border: 1px solid #fff; }
        .axis-label { position: absolute; color: #000000; font-size: 18px; width: 24px; height: 24px; display: flex; justify-content: center; align-items: center; pointer-events: none; font-weight: bold; } /* ★パレットの「Value(明度)」や「Chroma(彩度)」の数字を黒文字化 */

        #loading-screen { position: absolute; top:0; left:0; width:100vw; height:100vh; background:#111; z-index:100; display:flex; flex-direction:column; justify-content:center; align-items:center; font-size:20px; transition: opacity 0.3s; }
        #error-message { color: #ff5555; font-size: 16px; margin-top: 20px; text-align: center; max-width: 80%; }
        
        .vertical-title { position: absolute; transform: rotate(-90deg); transform-origin: center center; white-space: nowrap; text-align: center; width: 160px; }
    `;
    document.head.appendChild(style);
}
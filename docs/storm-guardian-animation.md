# 沙海神殿：免費回合鳥神動畫

日期：2026-10-25；揮杖攻擊更新：2026-10-26。

## 呈現與觸發

- 一般模式維持原本的靜態 `storm-temple.webp`。免費回合開始或載入尚未完成的免費系列時，切換為獨立背景與透明鳥神。
- 以透明角色 WebP 分出身體、頭部、披風，以及持杖手臂／神杖，播放呼吸起伏、輕微轉頭、披風擺動與揮杖攻擊。這是圖片分層動畫，不是影片或重新生成遊戲結果。
- 攻擊每 5.2 秒循環一次：向後蓄力 10 度，快速向前揮至 -66 度，再收回原位。前臂、握杖手與神杖以肘部為中心一起旋轉；身體最多前傾 2.4 度，日輪光芒跟著杖移動，出手時短暫顯示金色弧形光痕。
- 用額外的無杖角色 WebP 補上持杖手臂移開後的披風與盔甲；固定圖層排除原來的前臂與神杖，避免攻擊時留有重影。
- 動畫涵蓋免費開始提示與完成提示，關閉完成提示後回到一般模式。角色素材失敗或尚未載入時保留原本圖片。
- 全部視覺層使用 absolute positioning、裁切與 transform／opacity，不改 header、盤面、投注區、100dvh 或捲動規則。
- 手機橫向提醒與隱藏分頁期間暫停；離頁清除 visibility listener。系統開啟 `prefers-reduced-motion: reduce` 時顯示靜態鳥神。
- 裝飾層使用 `aria-hidden`、`pointer-events: none`，不遮擋按鈕、不增加朗讀內容。動畫速度不受「快速動畫」影響。
- 只修改前端呈現；API、RTP、下注、派彩與免費回合進度沿用 server 結果。

## 程式與素材

使用位置：`/storm-demo` 的 `StormDemoView.vue` → `side-panel` → `StormGuardian.vue`。共用 mobile px 轉換排除新 component，讓角色裁切與位移尺寸穩定。

| 檔案                                                                                         | 用途                           | 尺寸            | 大小          |
| -------------------------------------------------------------------------------------------- | ------------------------------ | --------------- | ------------- |
| [storm-guardian.webp](../apps/web/public/images/games/storm-guardian.webp)                   | 透明鳥神，身體／頭部／披風共用 | 768 × 1152 RGBA | 225,752 bytes |
| [storm-guardian-body.webp](../apps/web/public/images/games/storm-guardian-body.webp)         | 移除前臂與神杖的修補底圖       | 768 × 1152 RGBA | 179,738 bytes |
| [storm-temple-background.webp](../apps/web/public/images/games/storm-temple-background.webp) | 去除鳥神與法杖的神殿背景       | 1439 × 810 RGB  | 252,846 bytes |

採 built-in `image_gen` 編輯既有原創美術，再以 Pillow Lanczos 縮圖、WebP quality 88／method 6 轉檔；保留角色 alpha。原始圖片沒有覆寫，三張資產合計約 643 KiB。

SHA-256：

- 鳥神：`eace3746d7e30aa9e00c94c59ea34e7b531481962a905261a2e503c8bfee0927`
- 修補底圖：`40cdae327d78b551cf46fc56411bf776828d7b7dd4bc8a3842cfd8d81892d1f4`
- 背景：`8b0129ec6f1d8d397476812c1f0a41af1aaed5b2cb7b8dabfddeed27279e127c`

鳥神與背景的編輯來源：`apps/web/public/images/games/storm-temple.webp`。修補底圖的編輯來源：`apps/web/public/images/games/storm-guardian.webp`。

生成原始檔（本機保留）：

- 鳥神：`/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-921d8495-702c-4ec2-817d-2d848a38f3c7.png`
- 背景：`/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-90baf73d-69a4-4a8c-badf-05d48161ede5.png`
- 修補底圖：`/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-c3a7819f-e7b2-48d8-837c-343741410042.png`

## 完整生成 prompt

鳥神（`transparent_background: true`）：

```text
Use case: background-extraction. Edit target: the provided original Sand Sea Temple illustration. Produce one production-quality transparent RGBA character sprite, using EXACTLY the same falcon-headed guardian from the reference: silver-grey sculpted feathered head looking left, gold and dark stone armor with turquoise jewel inlays, teal cape, right hand holding the tall sun-disc staff. Preserve the design, detailed materials, three-quarter view, lighting from upper left and dignified standing pose. Extract the guardian, all of his cape, both feet and the complete staff including sun disc and staff tip. Remove ALL scenery, platform, palms, clouds and sky. Reconstruct any cropped outer cape or staff edges naturally, preserving his identity. The single full-body character and complete staff should fit inside a PORTRAIT 2:3 canvas, centered with a 5% transparent safety margin. The body occupies the left/center and staff remains at the right. Transparent background, no ground shadow, no extra glow outside the silhouette, no border, no text, no second character. The image will be layered over the original temple and subtly animated.
```

背景（`transparent_background: false`）：

```text
Use case: object-removal. Edit target: the provided original Sand Sea Temple illustration. Create a clean background plate of this EXACT scene and composition for character animation. Remove only the falcon-headed guardian, his entire teal cape and entire sun-disc staff from the right side. Fill the removed region seamlessly with blue sky, illuminated white clouds, distant desert cliffs and the same golden architecture. Preserve the foreground stone platform at bottom right, the left temple columns and banners, all floating temples, distant central golden tower, sunlight and clouds. Keep the original landscape aspect ratio and camera framing. No people, creatures, statues, birds, weapons, floating staff, lettering, UI, border or watermark. Match the original high-detail cinematic fantasy illustration with warm gold and cyan highlights.
```

持杖手臂與神杖移除後的修補底圖（`transparent_background: true`）：

```text
Use case: precise local edit for a 2D character animation rig. Edit target is the supplied transparent falcon guardian sprite. Preserve the EXACT canvas aspect ratio 2:3, identical character scale, registration, head, torso, armor, hanging left arm, legs and teal cape. Do not recenter, zoom, rotate or redesign the guardian. Remove the entire golden sun-disc staff, including disc, spikes, shaft and bottom point. Also remove ONLY the viewer-right bent forearm and its gripping hand from the elbow outward; keep the upper arm and shoulder armor stationary. Seamlessly reconstruct the teal cape with its existing gold embroidery behind the removed forearm and staff, with natural folds, plus transparent empty space where the staff stood outside the body. At the elbow keep a clean natural armored joint covered by the remaining upper arm, with no wound or exposed interior. This is a clean base layer for an articulated game character: the original hand, forearm and staff will be composited back on top by code and rotate together. The rest of the image must stay pixel-registered and visually identical, including the original light direction, gold, turquoise and dark stone materials. True transparent RGBA background; no scenery, glow, shadow backdrop, text, guide marks, replacement weapon or extra arms.
```

## 驗證範圍

`StormGuardian.test.ts` 驗證分頁隱藏時暫停及 listener 清理；`storm-guardian-mocked.spec.ts` 驗證免費模式啟停、角色實際 transform 變化、蓄力／前揮的日輪移動方向與距離、手臂收回原位、背景與盤面固定、320／390／549 寬度、reduced motion、手機橫向，以及角色或修補底圖載入失敗時回退靜態圖片。使用 mocked transport，不對玩家帳戶下注。

初版驗證（2026-10-25）：46 項 guardian／Storm view component tests、Chromium／WebKit 共 12 項動畫 E2E 與 16 項既有直式排版 E2E 通過。web typecheck、E2E TypeScript、變更檔 ESLint、Prettier、production build 與 `git diff --check` 通過。另目視檢查兩種瀏覽器的手機截圖。Build 保留既有 PWA `inlineDynamicImports` 棄用警告，沒有新增 build 錯誤。

揮杖攻擊更新驗證（2026-10-26）：46 項 guardian／Storm view component tests、Chromium／WebKit 共 14 項動畫 E2E 通過。目視檢查待機、蓄力與出手截圖，確認手與神杖一起移動、盤面與操作列固定。web typecheck、E2E TypeScript、變更檔 ESLint、Prettier、production build 與 `git diff --check` 通過。沒有執行 DB tests 或真實帳戶投注。

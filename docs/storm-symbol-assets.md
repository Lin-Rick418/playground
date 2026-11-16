# 沙海神殿盤面符號資產

## 驗證

- 11 張 WebP 皆為 256 × 256、保留 alpha；實際頁面 38 個盤面與規則圖示全部解碼成功，沒有破圖。
- 瀏覽器確認頂部資訊列為 0 個，規則不再包含「最近的探索」標題或列表。
- 20 項 Chromium／WebKit mocked E2E 通過，涵蓋 320×568、390×844、483×771、549×761、1440×900、連消動畫、倍數升級、免費回合及最大派彩畫面；目視核對手機、一般／超級神殿與倍數球截圖。
- 8 項 `StormDemoView` component tests、web typecheck、兩個變更 Vue 檔案的 ESLint、web production build 與 `git diff --check` 通過。Build 僅有既有 PWA `inlineDynamicImports` 棄用警告。
- 本次只修改前端顯示與圖片；沒有執行資料庫修改或實際帳戶投注。

日期：2026-10-24。依使用者回饋，將原本 11 種線條 SVG 全部替換為原創立體美術。使用 built-in `image_gen`，每種符號各生成一次，透明背景。保留原有辨識色與符號含義，加入寶石折射、雕刻金屬、石材與琺瑯細節。

- 原圖：各 1254 × 1254 RGBA PNG，保留於下列本機來源。
- 專案輸出：各 256 × 256 WebP，Pillow Lanczos 縮圖、quality 90、method 6，保留 alpha，沒有裁切或重畫內容。
- 全套大小：299,892 bytes；單張約 17–36 KB。
- 使用位置：`StormSymbol.vue` 共用元件，涵蓋 30 格盤面、消除紀錄、規則賠率表。圖片使用 `alt=""`／`aria-hidden`，原有盤面與控制項 accessible label 保留。
- 倍數球中心保留深紫空白區；倍數數字仍以 HTML 疊加，維持動態數值及手機可讀性。
- 同步移除 header 下方的資訊列，以及規則內「最近的探索」標題與整個列表。後端歷史保存、投注與結算不受影響。

## 檔案清單

| 符號     | WebP                                                                         | 原始 PNG                                                                                                              | SHA-256                                                            |
| -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 紅寶石   | [ruby.webp](../apps/web/public/images/games/storm-symbols/ruby.webp)         | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-9ccaea0b-9a0d-4600-bf74-9096f51940e8.png` | `e88291cae0052546eefdb71907bcf358d9a59d18f9f9318eeb9b658d0107ab28` |
| 翡翠     | [emerald.webp](../apps/web/public/images/games/storm-symbols/emerald.webp)   | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-317c623a-8f0a-447f-af14-0f299a3b6988.png` | `13ec58f61f81d2def559f21fd6a7d77fbd725f0e0dcddf6a528572daf1107f3f` |
| 藍晶     | [sapphire.webp](../apps/web/public/images/games/storm-symbols/sapphire.webp) | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-b23484ad-a0c2-4378-8f6f-fba41091922d.png` | `26ae10deed844e54938994f0540e2311c0232ff76cb5f23b0c32f45968537842` |
| 琥珀     | [amber.webp](../apps/web/public/images/games/storm-symbols/amber.webp)       | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-b7069844-41b0-4fa7-838a-ac8c8dc1c9b4.png` | `03b7a2e8107c22296e023e426abb2763da192f22909af42864c6c8d5c1567a30` |
| 蓮花     | [lotus.webp](../apps/web/public/images/games/storm-symbols/lotus.webp)       | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-18c5582e-0778-4249-9480-21d07825a131.png` | `0a1483c01d61aa9a1d0599f0089b7bba867cd3ad5fb3deb5148d7176be343eec` |
| 聖甲蟲   | [scarab.webp](../apps/web/public/images/games/storm-symbols/scarab.webp)     | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-4f012ffc-6051-4dd4-9d9f-3b88216b52be.png` | `e3b66e83d53e20691abaf2897b539a0b5d48098b027c9212d21bbe2dd0ee4074` |
| 日之守衛 | [sun.webp](../apps/web/public/images/games/storm-symbols/sun.webp)           | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-736a695b-5210-47c7-92e3-646b5191f37c.png` | `25aaa57a26236c43071df4c28e73cb0d4e86bcd57775bb69e287387ec066549d` |
| 月之守衛 | [moon.webp](../apps/web/public/images/games/storm-symbols/moon.webp)         | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-a07dae32-ca61-448e-a794-df14adae033f.png` | `f7fe9effc798f70187dc3944672944d583ea29e0a08edc3bc44613d0f489c9b3` |
| 神殿     | [scatter.webp](../apps/web/public/images/games/storm-symbols/scatter.webp)   | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-3ce2f000-0ed5-4576-a6c8-e6c8983f26be.png` | `9f374c5310927f665a526243c0e5e932a78a1c312cd36914bc633b8ee62fdb8f` |
| 超級神殿 | [gold.webp](../apps/web/public/images/games/storm-symbols/gold.webp)         | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-3085d4ed-5571-41ca-b9d4-2eab3a53f3f4.png` | `e419b71648aeac33ee6fd09caf1cecc855ba5dbbeb43fa8b204ea4232aceb42d` |
| 倍數球   | [orb.webp](../apps/web/public/images/games/storm-symbols/orb.webp)           | `/Users/k/.codex/generated_images/01a16bf5-65ca-7e82-9483-a367b1cd23c5/exec-79e8e245-ccd0-448a-a7dc-b1df85147a0d.png` | `83e6ac29347d8b62fc6cfa244c9aae2950ab5ceef3c24a6c480c9368a13b4607` |

## 完整生成 prompt

每次 prompt 為下列共用段落加上對應符號的 Subject，`transparent_background: true`。

```text
Use case: stylized-concept
Asset type: one production-ready symbol sprite for the original fantasy game Sand Sea Temple.
Style: premium richly detailed cinematic 3D game-art render with painterly polish, beautifully crafted physical materials, realistic sculpted depth and crisp readable edges. The established theme is a sunlit desert temple, antique gold, turquoise accents and magical gemstones.
Composition: square 1024x1024, exactly ONE isolated object centered with its whole silhouette in frame; object fills approximately 78 percent of the square in its longest dimension, generous even transparent padding, consistent front-facing camera, coherent top-left warm key light and cool rim light. Designed to remain readable at 48 pixels.
Background: genuinely transparent alpha, no colored rectangle, no floor, no cast shadow outside the object, no scenery.
Constraints: original design; no text, no digits, no labels, no watermark, no logo, no frame or tile behind the object, no extra objects, no contact sheet, no emoji, no simple flat vector lines. Rich but disciplined detail, not overdecorated.
```

### 紅寶石（ruby）

```text
Subject: One vivid crimson ruby jewel, elongated pentagonal silhouette, deep translucent red faceted crystal in a restrained ancient gold claw setting. Large clean faces with inner fire and beautifully cut reflective facets. The gemstone dominates the silhouette, not the setting.
```

### 翡翠（emerald）

```text
Subject: One rich green emerald jewel, square octagonal emerald-cut silhouette, translucent green crystal, delicate ancient gold corner claws with engraved edge details. Large central green facet with realistic inner refraction. The gemstone dominates the silhouette.
```

### 藍晶（sapphire）

```text
Subject: One luminous saturated sapphire-blue crystal jewel, vertical diamond-shaped rhombus silhouette, exquisitely faceted blue crystal, very restrained gold corner fittings. Deep blue interior with icy blue edge highlights. The diamond silhouette remains immediately recognizable.
```

### 琥珀（amber）

```text
Subject: One warm golden amber crystal, upright triangular pyramid silhouette, beautifully cut luminous honey-gold facets, tiny restrained ancient gold base setting. Rich transparent amber depths with warm light, unmistakably triangular.
```

### 蓮花（lotus）

```text
Subject: One exquisite open purple lotus flower sculpture, symmetrical layered amethyst petals, purple translucent crystal with delicate gold accents only at the petal bases. An upright center petal and spreading lower petals, elegant compact silhouette. No stem, no leaves.
```

### 聖甲蟲（scarab）

```text
Subject: One original Egyptian-inspired sacred scarab amulet, front-facing symmetrical turquoise enamel beetle with a sculpted oval body, six graceful short gold legs, turquoise wings and engraved ancient-gold filigree. Clear teal oval silhouette, gemstone glints, meticulous jewelry craftsmanship. No outstretched feathered wings.
```

### 日之守衛（sun）

```text
Subject: One original sun guardian ceremonial mask, frontal sculpted golden falcon head with swept pointed crown tips, regal and elegant, warm golden metal, deep amber eyes and restrained turquoise inlay. Compact head-only icon, no shoulders, no staff, no text. Strong V-shaped silhouette.
```

### 月之守衛（moon）

```text
Subject: One original moon guardian ceremonial mask, frontal serene stone face with a compact amethyst-violet headdress, silver-gold engraved trims, violet glowing eyes and one small crescent crown detail. Cool purple and silver palette. Head only, no shoulders, no background. Distinct rounded-arch silhouette, clearly different from a golden falcon mask.
```

### 神殿（scatter）

```text
Subject: One miniature original desert temple shrine, ivory sandstone twin columns and a triangular carved pediment, compact symmetrical frontal architecture on a small stepped base, exquisitely sculpted stone reliefs, restrained aged gold edging and a small turquoise inner sanctuary. This is the normal temple symbol: predominantly ivory, no large sun disk.
```

### 超級神殿（gold）

```text
Subject: One miniature legendary golden desert temple shrine, ornate symmetrical architecture with two massive gold columns, a stepped pedestal, an elaborate crown and a bright small sun disk above its pediment. Molten-gold illumination from the sanctuary, highly polished gold and amber accents, visibly richer and more radiant than an ordinary ivory shrine. Compact front view. No words.
```

### 倍數球（orb）

```text
Subject: One mystical spherical multiplier orb, translucent rich royal-purple crystal, encircled by a finely engraved antique-gold rim and a few small gold sun-ray points, faint purple magical light inside. Keep the entire central 55 percent of the sphere smooth dark violet with no ornament, no bright highlight and no markings so an HTML multiplier number can be overlaid. No numbers or letters.
```

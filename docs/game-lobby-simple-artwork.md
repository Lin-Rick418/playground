# Simple lobby artwork

Generated with the built-in `image_gen` tool. Converted to 800 × 1200 WebP using Pillow, quality 84 and method 6.

- `apps/web/public/images/games/baccarat-simple.webp`
- `apps/web/public/images/games/mines-simple.webp`

## Baccarat prompt

Generate a simple, friendly, minimal editorial illustration for a mobile baccarat game cover. Portrait 2:3, 1024x1536. Flat muted sage-green background, a centered small group of two clean ivory playing cards (ace of spades and nine of hearts) with one red and one dark green plain casino chip. Flat geometric illustration with subtle soft shadows and clean rounded shapes, restrained 3-color palette, lots of breathing room. The objects fill the middle area from 20% to 62% of image height, with bottom 30% empty solid sage-green for a separately rendered interface title. Casual modern mobile game feel. No typography except tiny card rank markings, no logos, no watermarks, no people, no metallic gold, no luxurious casino setting, no columns, no arches, no ornate patterns, no photorealism, no dramatic lighting. Full bleed background.

## Mines prompt

Generate a simple, friendly, minimal editorial illustration for a mobile Mines game cover. Portrait 2:3, 1024x1536. Flat muted blue-teal background, a centered small arrangement of four rounded square dark teal game tiles, a single large simple mint diamond and a small friendly charcoal spherical mine with a short curved fuse. Flat geometric illustration with subtle soft shadows and clean rounded shapes, restrained teal mint charcoal palette, lots of breathing room. The objects fill the middle area from 20% to 62% of image height, with bottom 30% empty solid blue-teal for a separately rendered interface title. Casual modern mobile game feel. No text, logos, watermarks, people, metallic gold, treasure cavern, columns, arches, ornate patterns, photorealism, dramatic lighting or explosions. Full bleed background.

## Plinko regeneration

Plinko uses a new raster illustration generated with the built-in `image_gen` tool, converted to 800 × 1200 WebP (quality 84, method 6). Its compact pegboard is centered with the bottom area reserved for the title.

- Active asset: `apps/web/public/images/games/plinko-simple.webp`
- The earlier `plinko-simple.svg` is no longer referenced by the lobby.

### Final prompt

Generate one finished game-cover illustration for Plinko, portrait 2:3 (1024x1536). Use case: stylized-illustration. A simple friendly premium casual mobile game illustration, matching softly shaded sculpted geometric artwork: muted dusty blue-teal full-bleed background, a single compact Plinko pegboard centered horizontally. Main subject grouped together ONLY within the middle area, around x20%-80% and y22%-62% of image, plenty of clean empty background above, entire bottom 32% completely empty for UI typography added separately. The board has a softly rounded dark teal backing, an orderly triangular array of small ivory pegs, one prominent mint colored ball above the pegs, and a compact row of mint and warm muted gold collection pockets directly under the pegs. Slight 3D thickness and subtle soft shadows, tactile matte surfaces, simple elegant geometry, front-facing with a very slight dimensional perspective. Ball, pegs, and collection pockets must form one cohesive centered object, no wide vertical gaps. Restrained teal/mint/ivory palette with a little muted gold. No text, no letters, no numerals, no multipliers, no titles, no UI, no logos, no watermarks, no casino scenery, no neon, no photorealism. The image must have an opaque full bleed background.

## Hi-Lo regeneration

Generated with the built-in `image_gen` tool and converted to 800 × 1200 WebP (quality 84, method 6). The centered A/K pair uses soft dimensional illustration, with empty space below for the existing title layout.

- Active asset: `apps/web/public/images/games/hilo-simple.webp`

### Final prompt

Generate one finished Hi-Lo mobile game cover illustration. Portrait 2:3, 1024x1536. Use case: stylized-illustration. Softly shaded sculpted geometric illustration with tactile matte surfaces, subtle depth and soft shadows, friendly minimal casual mobile game style consistent with a softly dimensional teal Plinko board and teal Mines tiles. Full bleed muted sage teal-green background. Subject: a compact centered pair of slightly overlapping ivory playing cards, ace of spades on the left and king of hearts on the right, slightly fanned in opposite directions, clean rounded corners. Each card has one simple large suit symbol at its center and one small correct rank at the top left (A and K respectively); dark forest green spade, muted warm red heart. No other playing cards, no chips. A small subtle upward chevron near the left card and downward chevron near the right card may suggest higher/lower, but remain part of the compact centered group. Main artwork occupies the central area around x20%-80%, y22%-62%, balanced horizontally, generous breathing room. Bottom 32% is completely empty background reserved for separate UI typography. Restrained sage, ivory, forest green, warm muted red palette. No game title, no labels, no Chinese or English text except card ranks A and K, no multipliers, no UI, no border around the entire image, no logos, no watermark, no photorealism, no ornate casino setting, no neon or metallic gold. Opaque background.

## Blackjack regeneration

Generated with the built-in `image_gen` tool and converted to 800 × 1200 WebP using browser canvas (quality 0.84). The ivory A/10 pair and muted chips share the existing covers' green palette, with the lower area reserved for HTML typography.

- Active asset: `apps/web/public/images/games/blackjack-simple.webp`
- The earlier `blackjack-simple.svg` is no longer referenced by the lobby.

### Final prompt

Create a finished portrait game-lobby cover illustration for BLACKJACK, aspect ratio 2:3. This image must visually belong to a cohesive set of minimalist matte 3D casino game covers. Full bleed muted sage and deep teal green background with a very subtle soft gradient, softly lit clay-like editorial 3D rendering, low saturation, soft rounded corners, delicate ambient shadows. A compact, beautiful composition in the upper-middle area (approximately 20% to 62% of the canvas height): two thick ivory playing cards gently fanned, one ACE OF SPADES marked A with a large black spade, one TEN OF HEARTS marked 10 with tasteful red heart pips, together visibly suggesting a natural blackjack. Card faces should be clean and mathematically coherent. Add just two simple small matte poker chips at the base, one muted burgundy and one forest green, understated ivory edge accents, no numbers on chips. The cards are the main visual subject, carefully balanced, charming premium toy-like physical materials, slightly elevated three-quarter view with soft diffuse studio light. Keep the bottom 32% of the entire canvas completely clear with only the green background, reserved for HTML labels that will be placed separately. No game title, no BLACKJACK text, no TWENTY ONE text, no subtitles, no Chinese text, no buttons, no logo, no watermark, no frame, no gold arch or border, no glowing effects, no glitter, no photorealistic casino room. The only text allowed in the illustration is the proper corner rank marks A and 10 on the actual playing cards. Deliver one polished, clean image suitable for an 800 by 1200 pixel web cover.

## Shared title placement

`LobbyView.vue` renders text separately from the artwork. All five covers use the original Baccarat typography and placement: small uppercase English eyebrow above the large Chinese title. Titles are BACCARAT／百家樂, MINES／掃雷, PLINKO／落球, HI-LO／高低起伏, BLACKJACK／21 點. The entry link stays below the title. Hi-Lo and Blackjack use the regenerated WebP assets; their earlier SVGs are no longer referenced by the lobby.

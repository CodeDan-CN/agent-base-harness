# Office room background

## Reference-aligned assets (2026-09-26)

Active assets: `office-room-reference.png` and `office-characters.png`. Both were generated with the built-in imagegen tool using the user's office screenshot as the style/composition reference. The room includes furniture but no people or UI badges; the transparent character atlas supplies independent standing/seated sprites and portraits. SVG places the actors, clips the chair foreground, and renders live labels. No image generation is performed at runtime. The older `office-room.png` is retained as an unused first-version asset.

Room prompt:

> Use case: precise-object-edit. Asset type: production 2D game room background for an interactive web agent office. Input image is the user's target screenshot. Extract and faithfully recreate ONLY the large illustrated office room in the middle (not the surrounding UI). Output landscape 1536x1008, room fills edge to edge. Match the exact high-detail warm pixel-art illustration style, perspective, furniture density, sunlight, materials and composition of this reference. Keep the large city/trees windows across top, rear left bookcases and sleeping cat, central whiteboard, plants, wall posters, lower-left green sofa with coffee table and rug, right-side coffee machine/cabinet. Keep exactly FOUR fully detailed wooden workstation desks and their black office chairs in the same positions and sizes: upper-left desk centered at 24% x / 44% y; upper-right at 72% x /44% y; lower center at 42% x /78% y; lower-right at 72% x /78% y. Each desk has detailed dual screens, keyboard, books, mugs and tiny plants as in reference. Maintain a walkable central aisle between desks. CRITICAL: Remove ALL human characters, floating name/status badges, selection outlines, dotted path arrows, and all UI outside room. Keep chairs empty, no people, no avatars. Everything else in room should match closely; do not simplify into sparse vector geometry. Whiteboard handwriting can read 好想法 × 优秀的执行 = 更大的可能. No interface borders, no blank margins, no extra desk.

Character atlas prompt:

> Use case: stylized-concept. Asset type: transparent sprite atlas for the interactive office in the reference image. Reference is style and character identity, NOT a backdrop to reproduce. Create one 1536x1024 PNG on GENUINE transparent background (alpha, not a checkerboard), arranged in a strictly equal 4-column by 2-row grid of cells, each cell 384x512. No labels, no grid lines, no furniture, no shadows outside each character, no UI. Match the beautifully detailed pixel-art / game sprite character rendering of reference, high-detail 32-bit era with crisp pixel clusters, dark outlines, natural shading and appealing human proportions (head about 1/3 total height, NOT tiny block robot). Columns depict: 1 short brown-haired man in forest green overshirt, 2 long black-haired woman in sage green sweater, 3 long auburn/red-haired woman in mustard yellow sweater, 4 black-haired man with glasses in muted blue shirt. Row 1: full-body standing 3/4 front-facing sprites, comfortable neutral arms at sides, dark trousers and shoes, centered within each cell, feet at cell y460, head at y55. Row 2: same four individuals seen from BACK, sitting at an invisible computer desk facing up and away, hands reaching forward as if typing; NO chair and NO desk drawn. Whole seated body included, hair/head at y90, feet at y450. Keep every sprite separate and inside its own cell with at least 35 pixels transparent padding left/right. This sprite sheet will be cropped in native SVG and animated as separate characters over a room. Preserve hairstyle/outfit exactly between corresponding rows.

## Idle pose asset

`office-idle-characters.png` is a second transparent atlas for back-facing standing and reclining poses. It was generated with the built-in imagegen tool using `office-characters.png` as the identity reference.

Idle pose prompt:

> Use case: identity-preserve. Asset type: game character pose atlas. Reference image is the existing character atlas; preserve exactly its four character identities, outfits, pixel-art detail and scale. Produce one 1536x1024 PNG with genuine transparent alpha background, no colored backdrop or glow. Strict grid FOUR COLUMNS and TWO ROWS, each cell 384x512; all drawings entirely inside their cells with padding. Columns: brown-haired man green jacket; long black-haired woman sage sweater; auburn-haired woman mustard sweater; black-haired man with glasses blue shirt. TOP ROW: each character STANDING UPRIGHT facing completely away from viewer, looking at scenery. Straight legs visible, arms relaxed at sides, NOT crouching, NOT seated. Full body from head to shoes centered in each cell, head at y50 feet at y460. BOTTOM ROW: each character lying horizontally on their BACK relaxing with eyes closed, head towards LEFT, feet RIGHT, arms resting on stomach. Entire horizontal body within x30..350 and y180..320 of each lower cell; NO sofa, NO bed, NO furniture. These sprites are overlaid on an already existing sofa or window. Draw only eight isolated characters on transparent alpha.

## First-version asset (unused)

`office-room.png` is the original background generated with the built-in imagegen tool for the first version. It remains in the source asset directory for provenance and is no longer imported by the application.

Generation prompt:

> Use case: stylized-concept. Asset type: actual background texture for a buildable 2D pixel-art AI office web app. Generate a wide 3:2 landscape office room BACKGROUND ONLY, no UI, no people, no animals, no desks, no chairs, no monitors, no text, no logos. Orthographic top-down slightly front-facing RPG game perspective, parallel horizontal and vertical axes, NOT isometric diamond. Cozy sophisticated pixel art, clean intentional pixels. Room fills entire rectangular canvas, no border outside room. Upper 30 percent: warm ivory back wall, three huge rectangular windows with green leafy trees and pale blue sky outside; a low bookcase flush against far upper-left wall, little books and trailing potted plants; blank notice board on back wall upper-right. Lower 70 percent: mostly EMPTY warm light oak wood floor with horizontal board pattern, plenty of uninterrupted walkable space. Decorative objects confined to extreme perimeter: one small potted tree in upper-left corner, coffee cabinet along right wall upper edge, plant in upper-right. Subtle daylight diagonal rays on floor, soft gentle shadows, muted sage green, warm honey wood, off-white walls. Straight on top-down game environment background for overlaying movable characters and furniture at arbitrary positions. Pixel details elegant and cozy, no grain, no noise, fully opaque. Empty floor must dominate the composition, no objects in central and lower floor area. Single room, not multiple rooms. Keep floor light for readable dark sprites.

## 行走逐帧素材

`office-walk-characters.png`：使用内置 imagegen，以 `office-characters.png` 为角色参考生成，再修正侧身行走的经过姿势。保留透明通道；实际输出 1774 × 887。四行对应四个角色，前四列为向右行走，五六列为正面，七八列为背面；向左用 SVG 镜像。裁切与脚底锚点由 `OfficeWalkPerson.tsx` 定义。位移和逐帧姿势由 `use-office-movement.ts` 的同一 requestAnimationFrame 时钟推进。

生成提示词：

```text
Create a production game WALK CYCLE SPRITE ATLAS using the attached image ONLY as the character identity and pixel-art style reference. Preserve the four identities and clothing exactly. Transparent RGBA background, no glow, no ground shadows, no text, no borders, no grid lines.
Canvas 2048x1024. EXACT regular grid 8 columns by 4 rows, each cell 256x256.
Row 1 brown-haired man green jacket; row 2 long black-haired woman sage sweater; row 3 auburn-haired woman mustard sweater; row 4 black-haired glasses man blue shirt.
Every cell contains ONE complete full body sprite, head to shoes, identical scale 215 pixels tall, center x=128 within cell, feet baseline y=238 within cell; ample transparent padding. Detailed charming pixel art, same proportions as reference, not chibi.
Columns 1–4 are four sequential RIGHT-FACING SIDE VIEW walk frames: 1 left foot forward right arm forward (contact), 2 legs passing under torso (passing), 3 right foot forward left arm forward (opposite contact), 4 opposite passing. Clear alternating leg strides and opposing arm swings, coherent anatomy, no extra limbs. Head and torso stay aligned.
Columns 5–6 are two alternating walking TOWARD CAMERA / FRONT view contact frames, opposite legs forward and opposing arms.
Columns 7–8 are two alternating walking AWAY FROM CAMERA / BACK view contact frames, opposite legs forward and opposing arms. Back of hair only, no face in back view.
No standing idle sprites, no chairs, no sitting, no props. Uniform cell placement and character size is essential for animation.
```

修正提示词：

```text
Edit the supplied walk-cycle atlas, preserving the transparent background, exact 8-column by 4-row grid, character identities, artwork style and feet baselines. Correct ONLY columns 2 and 4 (the second and fourth cell in EVERY row): they MUST be PASSING POSES with legs CLOSE TOGETHER directly underneath the torso, one knee bent with foot lifted, instead of wide V-shaped strides. Arms in these passing frames hang near the torso. Column 2 lifts the near foot; column 4 lifts the far foot. Do not repeat the wide contact stance in passing frames. Columns 1 and 3 remain wide contact poses with opposite arms and opposite legs leading. Columns 5 through 8 stay unchanged. No borders, no text, preserve true transparency. This atlas must animate a fluid four-phase walking cycle: wide stride, narrow passing, opposite wide stride, opposite narrow passing.
```

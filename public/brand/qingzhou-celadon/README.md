# Qingzhou celadon ornaments

A material family for the existing Liquid Glass interface: soft watercolor pigment
inside rounded celadon sea glass, broad upper-left highlights and transparent edges.
Generated with the built-in `image_gen` tool using the approved material study.

- `leaf.webp` — 256 × 171, RGBA. Composer ornament, displayed at 40–46 px including its soft transparent margin.
- `boat.webp` — 384 × 351, RGBA. Task empty-state illustration; kept away from composer controls.
- `cabin.webp` — 192 × 175, RGBA. Eight upright sprites carried by the native rotating Ferris wheel.
- `wash.webp` — 1024 × 413, RGBA. Low-opacity atmospheric paint beneath the wheel and Presentation Studio scene.
- `music-record.webp` — 640 × 640, RGBA. Floating celadon record and sound-wave ribbon; default music artwork shared by the full player, audio library and floating player. Real album covers take precedence.

The PNG originals, reference study and generation prompts are retained under
`output/imagegen/qingzhou-celadon/`. WebP exports only resize/encode those originals,
with alpha preserved (quality 90, alpha quality 100). Existing watercolor lettering
and legacy source artwork remain unchanged.

The wheel uses simple SVG geometry for its ring, eight spokes and fixed supports.
Cabin images live in HTML layers so the glass compositor can safely capture decoded
same-origin pixels. The rotor completes a turn in 160 s (180 s in Presentation
Studio), with an equal opposite rotation on each cabin. Offscreen/background-tab
motion pauses; reduced-motion and mobile layouts are static.

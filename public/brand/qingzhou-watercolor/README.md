# Qingzhou watercolor assets

Source artwork supplied by the user in `/home/shiro/July/清舟设计`:

- `46780E90D853AC2E2538F1FBCFF61F05.png`: complete circular Qingzhou identity.
- `92476cd9-64ef-4828-94f8-b8df8f949854.png`: watercolor Ferris wheel.

Both originals are RGB. The wheel's gray checkerboard is baked into its pixels.
`python scripts/brand/prepare-qingzhou.py [source-directory]` extracts colored
watercolor coverage to genuine RGBA WebP, masks the selected silhouettes, and
recomposes the original lettering into a compact wordmark. The source files
are never overwritten. Requires Pillow and NumPy.

`wordmark.webp`, `leaf.webp`, and `boat.webp` are used in the home/composer UI.
`cabin.webp`, `hub.webp`, and `foliage.webp` preserve original raster details in
the animated wheel. Its new SVG frame is implemented in
`src/features/QingzhouBrand/index.tsx`; supports remain stationary, the wheel
rotates in 160 seconds, and cabins counter-rotate to stay upright. Offscreen
and background-tab animation is paused. Mobile and reduced-motion layouts are
static. Decorative layers do not accept pointer input or enter the accessibility tree.

`ferris-original.webp` and the individual letter cutouts are retained as reusable
source derivatives. `presentation-mist.webp` is a transparent derivative of the
generated source at `output/imagegen/qingzhou-presentation-mist.png`; it provides
the restrained watercolor wash behind the Presentation Studio scene. The Ferris
wheel itself uses deterministic extraction and native SVG animation without an
external animation library.

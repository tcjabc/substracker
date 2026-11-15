Source images for the native app icon and splash screen. The SVGs are drawn from `icons/icon.svg`;
the PNGs are rendered from them at the sizes `@capacitor/assets` expects, and `npm run assets`
generates the Android resources from the PNGs.

- `icon-only`: the full icon (1024 px), used for older Android launchers.
- `icon-foreground` / `icon-background`: the adaptive icon layers (1024 px), drawn at the same scale as
  `icons/icon.svg`. The generator adds the adaptive-icon padding, which keeps the card inside every launcher mask.
- `splash` / `splash-dark`: the icon on the app's light (`#f6f6f9`) and dark (`#111216`) backgrounds
  (2732 px).

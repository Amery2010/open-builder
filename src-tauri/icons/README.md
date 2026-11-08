# Apple app icons

The editable brand source is [`public/logo.svg`](../../public/logo.svg). The
export preserves its purple/pink gradient and white artwork.

| Asset           | Purpose                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-store.png` | 1024 × 1024, 8-bit RGB PNG, full-bleed square with no alpha channel, baked-in corners, or outer padding.                                                                                                                                         |
| `ios/*.png`     | The same opaque square artwork at all 18 sizes expected by Tauri, including the 1024px `AppIcon-512@2x.png`.                                                                                                                                     |
| `macos.png`     | 1024 × 1024 RGBA preview/source for the legacy ICNS, with a centered 824px body, 100px optical margins, and smooth rounded corners. These margins are a project design choice for this ICNS export, not the current App Store PNG specification. |
| `icon.icns`     | The macOS bundle icon referenced by `tauri.conf.json`; includes 16, 32, 128, 256, and 512pt representations at both 1× and 2× (up to 1024px).                                                                                                    |

Regenerate on macOS after installing the project dependencies and
[Pillow](https://pillow.readthedocs.io/en/stable/installation/basic-installation.html):

```sh
python3 scripts/generate-apple-icons.py
```

The script renders SVG with the project's Tauri CLI, tags PNGs as sRGB, removes
alpha from the store/iOS exports, and compiles the ICNS with Apple's `iconutil`. Intermediate
files are automatically removed. Windows, Linux, Android, and the web logo are
left unchanged. Do not regenerate these Apple assets directly from the rounded
web logo with `tauri icon`, as that would restore baked-in iOS corners.

When initializing the iOS project, copy the generated `ios/*.png` files into
`src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`, preserving the generated
Xcode asset catalog's `Contents.json`. That generated project is not currently
checked into this repository.

Apple currently supports nonlayered bitmap icons and recommends square, unmasked
artwork. This export uses the existing Tauri PNG/ICNS pipeline; it does not supply
an Icon Composer `.icon` file or authored Liquid Glass appearance variants.
App Store Connect upload and review must still be validated with a signed build.

References (checked 2026-11-08):

- [Apple Human Interface Guidelines: App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Apple: High-resolution icon representations and iconutil](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html)
- [Tauri: App Icons](https://v2.tauri.app/develop/icons/)

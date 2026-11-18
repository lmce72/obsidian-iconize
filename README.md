# Obsidian Iconize

![Preview Image](./docs/preview-image.png)

Project Deprecation and End of Maintenance: [read more](https://github.com/FlorianWoelki/obsidian-iconize/discussions/646)

## What is it?

This obsidian plugin allows you to add **any** custom icon (of type `.svg`) or from an icon pack to anything you want.

Refer to the official documentation for more information:
[https://florianwoelki.github.io/obsidian-iconize/](https://florianwoelki.github.io/obsidian-iconize/) about the plugin and its functionalities.

## Key Highlights

[Icons before file/folder name](https://florianwoelki.github.io/obsidian-iconize/files-and-folders/icon-before-file-or-folder.html),
[Icons in notes](https://florianwoelki.github.io/obsidian-iconize/notes/icons-in-notes.html),
[Icon above title](https://florianwoelki.github.io/obsidian-iconize/notes/title-icon.html),
[Predefined icon packs](https://florianwoelki.github.io/obsidian-iconize/guide/icon-packs.html),
[Icons in tabs](https://florianwoelki.github.io/obsidian-iconize/files-and-folders/icon-tabs.html),
[Customizable settings](https://florianwoelki.github.io/obsidian-iconize/guide/settings.html),
[Custom rules](https://florianwoelki.github.io/obsidian-iconize/files-and-folders/custom-rules.html),
[Frontmatter integration](https://florianwoelki.github.io/obsidian-iconize/files-and-folders/use-frontmatter.html),
[Change color of an individual icon](https://florianwoelki.github.io/obsidian-iconize/files-and-folders/individual-icon-color.html),

## Development

This local enhanced fork is maintained in `~/obsidian-iconize-enhanced`.
The installed `obsidian-icon-folder` directory contains build artifacts and user data.
See [source and deployment](docs/development/local-deployment.md) and
[configuration safety and recovery](docs/good-to-know/sync-config.md).

```sh
pnpm install
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

Builds are written to `dist/`. To deploy, copy `env.example.js` to `env.js`, set
`obsidianExportPath` to the existing `obsidian-icon-folder` directory, and run:

```sh
pnpm run deploy:obsidian
```

The deploy script backs up the installed runtime, archives obsolete sidecar modules,
and preserves configuration, icon packs and cache data. All functional changes belong
in `src/`, not in the installed bundle. `pnpm dev` watches and rebuilds locally.

## Enhanced icon workflows

Version 2.14.8 adds a color-aware icon picker, portable document embedding, delayed automatic conversion, configuration recovery, and cooperative search for large icon libraries. The default embed format is a self-contained Base64 SVG image. See [usage and validation notes](docs/development/2026-11-18-icon-workflows.md). Requires Obsidian 1.7.2 or later.

Version 2.14.11 moves icon-pack management into a settings subpage: a chevron row opens it in place, with a back row returning to the settings page.

Version 2.14.10 adds a click hint under the preview block in the color editor.

Version 2.14.9 adds compact shared indexes, bounded SVG/ZIP caches, paged index persistence and desktop ZIP range reads. See [million-icon performance results and limits](docs/development/2026-11-18-million-icon-performance.md). It also fixes Fabp sprite imports and adds a unified Obsidian icon-pack management view. Measurements cover synthetic Node indexes and isolated Linux Obsidian ZIP64 archives; Windows Chromium and low-end device validation are still pending. See [validation and release notes](docs/development/2026-11-18-validation.md).

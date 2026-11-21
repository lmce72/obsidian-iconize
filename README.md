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

Version 2.15.5 adds a circular shuffle button to the right of the color control in the icon picker. It shows the next batch of icons for the current query and skips every name already shown for that query; when no unseen icons remain it keeps the current batch and shows a notice. The button uses the same 40×40 / 48×48 circular size as the color control.

Version 2.15.4 writes a valid ZIP64 archive when a normalized pack exceeds 65,535 icons. `fflate`'s ZIP writer stores the entry count in a 16-bit field, so selecting several large Iconify sets previously produced a corrupt central directory and the index reported `Invalid ZIP directory entry count`. A real three-set selection now imports 76,783 icons into a 31.81 MiB archive and indexes in about 216 ms.

Version 2.15.3 separates non-SVG archive limits from the 8 MB per-icon limit. Iconify set JSONs larger than 8 MB now import normally (for example `material-symbols-light`: 24,167 icons), and sets above 64 MB are disabled in the picker and skipped with a clear reason instead of failing on the SVG limit.

Version 2.15.2 recognizes archives of multiple Iconify sets, such as the `icon-sets` repository ZIP with its `json/*.json` layout. A picker lists the sets; only the checked JSON files are read and converted. Selecting several sets uses each Iconify prefix as a folder so equal names stay distinct; selecting one names the pack after that prefix. Importing all sets is supported but can produce a very large archive.

Version 2.15.1 fixes the configuration dead end and the recovery dialog: a missing config is treated as a normal fresh install, a damaged config is backed up and its usable icon records/settings are recovered, a config path copied from another vault is recreated (or can be reset to the default), and recovery actions close the dialog before doing their I/O and report through a notice. Reset/restore now opens a reload prompt because the new path cannot be hot-swapped. The diagnostics also show copyable sync-exclusion rules for `.iconize` (Syncthing, Git, Obsidian Sync, Remotely Save). See [configuration, recovery and sync exclusions](docs/good-to-know/sync-config.md).

Version 2.15.0 imports icon packs from ZIP or repository archives, tar.gz and npm tarballs, Iconify JSON, SVG sprites, single SVG files, JavaScript icon modules such as `@heroicons/react`, and TTF/OTF/WOFF fonts with optional CSS. The importer recognizes marker files and directories (`icons`, `svgs`, `src`, `symbol`, `createElement("path")`, `icons` + `prefix`), keeps only the icon set, and drops documentation screenshots, test fixtures and duplicate sprite sheets. The pack name or Iconify prefix becomes the Iconize prefix; equal icon names in different packs stay independent. WOFF2 is not supported because the bundled font parser cannot decode it. See [multi-format import and verification notes](docs/development/2026-11-21-multi-format-import.md).

The document commands (embed all tags in the current note, or in the whole vault) now ask for the output format before converting, with the same table shown in the dialog. The single-icon context-menu conversion uses the same picker. Automatic conversion after idle typing keeps using the saved default. See [embed formats for PDF, GitHub and blogs](docs/development/2026-11-21-document-embed-formats.md).

| Format                        | Best for                                                                                       | GitHub                                                       | Personal blog                                                                | Note size   |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------- |
| `<svg>` element               | Reading in Obsidian, PDF/print export, or HTML-capable notebooks; icons follow the text color. | Usually removed by GitHub's HTML sanitizer.                  | Depends on the generator/theme allowing raw HTML.                            | Largest.    |
| Base64 `<img>`                | Sending one note without attachments to a platform that allows `data:` images.                 | Often filtered; check the preview before publishing.         | Depends on the site's image policy; check the preview.                       | About +33%. |
| `Iconize SVG/` file reference | GitHub repos or blogs where you can publish the icon folder next to the note.                  | Works after committing the folder and fixing relative paths. | Works after copying the SVGs into the site's static folder and fixing paths. | Smallest.   |

For GitHub and most blogs, a normal image file with a relative path is more reliable than embedding the icon inside Markdown. If icons appear blank after publishing or the browser console reports a security error, the platform blocked inline SVG or a `data:` image; switch to the file-reference format, publish the `Iconize SVG/` folder, and check the target preview.

The document converter can also choose the embed format for a single run: a readable `<svg>` element, a self-contained Base64 image, or a reference to a file in `Iconize SVG/`. Base64 is produced locally with the browser's character encoder only when that format is selected; it is not used to hide code or credentials, and its only purpose is to carry the icon inside the Markdown file. Importing packs reads files from the user's disk and makes no network request.

Version 2.14.8 adds a color-aware icon picker, portable document embedding, delayed automatic conversion, configuration recovery, and cooperative search for large icon libraries. The default embed format is a self-contained Base64 SVG image. See [usage and validation notes](docs/development/2026-11-18-icon-workflows.md). Requires Obsidian 1.7.2 or later.

Version 2.14.11 moves icon-pack management into a settings subpage: a chevron row opens it in place, with a back row returning to the settings page.

Version 2.14.10 adds a click hint under the preview block in the color editor.

Version 2.14.9 adds compact shared indexes, bounded SVG/ZIP caches, paged index persistence and desktop ZIP range reads. See [million-icon performance results and limits](docs/development/2026-11-18-million-icon-performance.md). It also fixes Fabp sprite imports and adds a unified Obsidian icon-pack management view. Measurements cover synthetic Node indexes and isolated Linux Obsidian ZIP64 archives; Windows Chromium and low-end device validation are still pending. See [validation and release notes](docs/development/2026-11-18-validation.md).

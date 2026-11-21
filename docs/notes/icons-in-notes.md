# Icons in Notes

Using icons or emojis in your notes is a great way to make them more visually appealing and
to make them easier to navigate. Obsidian Iconize allows you to do that by just typing
and selecting the icon, without interrupting your workflow.

You can do so, by just typing a `:` and then the name of the icon you want to use.
For example, if you want to use the `:smile:` emoji, you can just type `:smile:` and
then select the emoji from the suggestion list. This also works with all your installed
icon packs in your vault.

By default, the icons will always appear in preview mode but also in the live-
preview when you edit your notes:

![Icons in notes](../assets/icons-in-notes.png)

Furthermore, if you would like to completely disable icons in notes, you can do
so in the options by toggling the following setting:

![Icons in notes setting](../assets/icons-in-notes-setting.png)


## Publishing notes outside Obsidian

The embed commands write ordinary Markdown/HTML, so what you see inside Obsidian is not a
promise of what GitHub, a PDF export, or your blog will show. Choose the format by where
the note will be read:

| Format | Obsidian | PDF / print | GitHub | Personal blog | Note size |
|---|---|---|---|---|---|
| `<svg>` element | Shows as an icon and follows the text color | Usually works | Usually removed by GitHub's HTML sanitizer | Only if the theme/generator allows raw HTML | Largest |
| Base64 `<img>` | Shows as an image | Usually works | Often filtered; check the preview | Depends on the site's image policy | About +33% |
| `Iconize SVG/` file reference | Shows as an image | Requires the folder during export | Works after committing the folder and fixing relative paths | Works after copying the SVGs into the static folder | Smallest |

Practical guidance:

- **GitHub and most blogs:** a normal image file with a relative path is the most reliable
  choice. Use the file-reference format, publish `Iconize SVG/` with the note, and adjust
  the path for the note's location (for example `![LiHome](assets/icons/LiHome.svg)`).
- **A single Markdown file with no attachments:** Base64 is the only self-contained option,
  but preview it on the target platform first.
- **PDF/print:** all three usually render; a file reference needs the `Iconize SVG/` folder
  to still exist when exporting.
- **Icons blank after publishing:** the platform blocked inline SVG or a `data:` image.
  Rerun the command with another format and check the target preview again. The note itself
  is not corrupted.

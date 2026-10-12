import { DropdownComponent, MarkdownView, Setting } from 'obsidian';
import IconFolderSetting from './iconFolderSetting';
import icon from '@lib/icon';
import titleIcon from '@lib/icon-title';
import { InlineTitleView } from '@app/@types/obsidian';
import { IconInTitlePosition } from '@app/settings/data';

export default class ToggleIconInTitle extends IconFolderSetting {
  private dropdown: DropdownComponent;

  private updateLeaves(enabled: boolean): void {
    this.plugin.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      const view = leaf.view as InlineTitleView;
      if (view instanceof MarkdownView) {
        if (!enabled) {
          // 用户关掉了「图标显示在标题」：必须彻底移除，不能显示默认图标——被关掉的是
          // 「标题上的图标」这件事，而不是某一个文件的图标。
          // The setting itself was turned off: remove entirely rather than show the default
          // icon — what was disabled is "an icon on the title", not one file's icon.
          titleIcon.remove(view.inlineTitleEl);
          return;
        }

        // 走标题图标的写入管道：颜色、字号、emoji 风格、点击改图标与身份闸门一次补齐。
        // 名字为空或解析不出时，管道自己会回落到默认文件图标。
        // Through the title-icon pipeline: colour, font size, emoji style, click-to-change and
        // the identity gate are filled in at once. An empty or unresolvable name falls back to
        // the default file icon inside the pipeline.
        this.plugin.applyTitleIcon(
          view.inlineTitleEl,
          icon.getByPath(this.plugin, view.file.path),
          view.file.path,
        );
      }
    });
  }

  public display(): void {
    new Setting(this.containerEl)
      .setName('Toggle icon in title')
      .setDesc('Toggles the visibility of an icon above the title of a file.')
      .addDropdown((dropdown) => {
        this.dropdown = dropdown;
        dropdown.setDisabled(!this.plugin.getSettings().iconInTitleEnabled);
        dropdown.addOptions({
          above: 'Above title',
          inline: 'Next to title',
        });
        dropdown.setValue(this.plugin.getSettings().iconInTitlePosition);
        dropdown.onChange(async (value) => {
          this.plugin.getSettings().iconInTitlePosition =
            value as IconInTitlePosition;
          await this.plugin.saveIconFolderData();
          // 位置变了需要重写 DOM，写入管道每次都会先摘掉旧图标再写，因此不必额外声明。
          // A position change needs the DOM rewritten; the pipeline removes the old icon before
          // every write, so nothing extra has to be requested here.
          this.updateLeaves(true);
        });
      })
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().iconInTitleEnabled)
          .onChange(async (enabled) => {
            if (this.dropdown) {
              this.dropdown.setDisabled(!enabled);
            }

            this.plugin.getSettings().iconInTitleEnabled = enabled;
            await this.plugin.saveIconFolderData();
            this.updateLeaves(enabled);
          });
      });
  }
}

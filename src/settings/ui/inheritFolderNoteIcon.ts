import {
  Notice,
  Setting,
  TextComponent,
  DropdownComponent,
  ToggleComponent,
} from 'obsidian';
import IconFolderSetting from './iconFolderSetting';
import { FOLDER_NOTE_PLUGIN_MAP } from '@app/lib/folder-note';

// ===== PATCHED: Folder note 图标继承设置项 / Folder note icon inheritance setting =====
export default class InheritFolderNoteIconSetting extends IconFolderSetting {
  private folderNoteNameText: TextComponent;
  private pluginImportDropdown: DropdownComponent;
  private biSyncToggle: ToggleComponent;

  public display(): void {
    const isEnabled = this.plugin.getSettings().inheritFolderNoteIconEnabled;

    new Setting(this.containerEl)
      .setName('Automatically inherit each folder note icon from folder')
      .setDesc(
        "When enabled, a folder note inherits its parent folder's icon. Also writes the icon to the folder note record when a folder icon is set, keeping sync systems in sync.",
      )
      .addToggle((toggle) => {
        toggle.setValue(isEnabled).onChange(async (enabled) => {
          this.plugin.getSettings().inheritFolderNoteIconEnabled = enabled;
          await this.plugin.saveIconFolderData();
          if (this.folderNoteNameText) {
            this.folderNoteNameText.setDisabled(!enabled);
          }
          if (this.pluginImportDropdown) {
            this.pluginImportDropdown.setDisabled(!enabled);
          }
          if (this.biSyncToggle) {
            this.biSyncToggle.setDisabled(!enabled);
          }
        });
      });

    new Setting(this.containerEl)
      .setName('Folder note name')
      .setDesc(
        "Filename of the folder note (no extension). Leave empty to use the folder's own name. Supports {{folder_name}}.",
      )
      .addText((text) => {
        this.folderNoteNameText = text;
        text
          .setPlaceholder('e.g. {{folder_name}} or index')
          .setValue(this.plugin.getSettings().folderNoteName)
          .setDisabled(!isEnabled);
      })
      .addButton((btn) => {
        btn.setButtonText('Save').onClick(async () => {
          this.plugin.getSettings().folderNoteName =
            this.folderNoteNameText.getValue();
          await this.plugin.saveIconFolderData();
          new Notice('Folder note name saved.');
        });
      });

    new Setting(this.containerEl)
      .setName('Import name from plugin')
      .setDesc(
        'Select an installed plugin to auto-fill the folder note name above.',
      )
      .addDropdown((dropdown) => {
        this.pluginImportDropdown = dropdown;
        dropdown.addOption('', '— select plugin —');
        for (const [id, meta] of Object.entries(FOLDER_NOTE_PLUGIN_MAP)) {
          dropdown.addOption(id, meta.label);
        }
        dropdown
          .setValue(this.plugin.getSettings().folderNotePluginId)
          .setDisabled(!isEnabled)
          .onChange(async (pluginId) => {
            this.plugin.getSettings().folderNotePluginId = pluginId;
            await this.plugin.saveIconFolderData();
            if (!pluginId) {
              return;
            }
            const meta = FOLDER_NOTE_PLUGIN_MAP[pluginId];
            if (!meta) {
              return;
            }
            try {
              const raw = await this.plugin.app.vault.adapter.read(
                `.obsidian/plugins/${pluginId}/data.json`,
              );
              const data = JSON.parse(raw);
              const importedName =
                typeof data[meta.field] === 'string' ? data[meta.field] : '';
              this.plugin.getSettings().folderNoteName = importedName;
              await this.plugin.saveIconFolderData();
              if (this.folderNoteNameText) {
                this.folderNoteNameText.setValue(importedName);
              }
              new Notice(
                `Imported from ${meta.label}: "${importedName || '(same as folder name)'}"`,
              );
            } catch (e) {
              console.error(
                `[Iconize] Could not read the config of '${pluginId}':`,
                e,
              );
              new Notice(
                `Could not read config for "${meta.label}". Is it installed?`,
              );
            }
          });
      });

    // 子条件：双向同步图标设定（仅在 inheritFolderNoteIconEnabled 开启时可用）
    const biSyncSetting = new Setting(this.containerEl)
      .setName('Bidirectional icon sync in data.json')
      .setDesc(
        'When enabled, setting an icon on a folder also writes it to the folder note record, and vice versa. Requires "Automatically inherit each folder note icon from folder" to be on.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(
            this.plugin.getSettings().bidirectionalFolderNoteIconSyncEnabled,
          )
          .setDisabled(!isEnabled)
          .onChange(async (enabled) => {
            this.plugin.getSettings().bidirectionalFolderNoteIconSyncEnabled =
              enabled;
            await this.plugin.saveIconFolderData();
          });
        this.biSyncToggle = toggle;
      });
    if (!isEnabled) {
      biSyncSetting.setDisabled(true);
    }
  }
}
// ===== END PATCH =====

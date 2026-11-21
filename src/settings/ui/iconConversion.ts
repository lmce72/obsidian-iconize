import { Setting } from 'obsidian';
import IconFolderSetting from './iconFolderSetting';

export default class IconConversionSetting extends IconFolderSetting {
  display(): void {
    new Setting(this.containerEl)
      .setName('自动嵌入文档图标 / Auto-embed icons')
      .setDesc(
        '停止输入后将正文标签写成实际 SVG；跳过代码和属性。修改可在编辑器撤销。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.getSettings().autoConvertIcons)
          .onChange((value) => {
            this.plugin.getSettings().autoConvertIcons = value;
            this.plugin.conversion.cancelPending();
            void this.plugin.saveIconFolderData();
          }),
      );
    new Setting(this.containerEl)
      .setName('转换延迟（秒） / Conversion delay')
      .setDesc('默认 10 秒，范围 1–3600 秒。停止输入后开始计时。')
      .addText((text) => {
        text.setValue(String(this.plugin.getSettings().autoConvertDelay));
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '3600';
        text.inputEl.step = '1';
        text.inputEl.setAttribute(
          'aria-label',
          '转换延迟（秒） / Conversion delay in seconds',
        );
        text.inputEl.addEventListener('input', () => {
          text.inputEl.setCustomValidity('');
          text.inputEl.removeAttribute('aria-invalid');
        });
        text.inputEl.addEventListener('change', () => {
          const value = Number(text.getValue());
          if (!Number.isInteger(value) || value < 1 || value > 3600) {
            text.inputEl.setCustomValidity('请输入 1–3600 的整数。');
            text.inputEl.setAttribute('aria-invalid', 'true');
            text.inputEl.reportValidity();
            return;
          }
          this.plugin.getSettings().autoConvertDelay = value;
          this.plugin.conversion.cancelPending();
          void this.plugin.saveIconFolderData();
        });
      });
    new Setting(this.containerEl)
      .setName('嵌入格式 / Embed format')
      .setDesc(
        '默认写入 Base64 自包含图片；文档命令执行前会先选择本次格式。SVG 标签适合留在 Obsidian 或导出 PDF；文件引用适合 GitHub、博客等需要一起发布 Iconize SVG 文件夹的场景；Base64 适合单文件发送，但部分发布平台会过滤。发布后图标空白时，换一种格式并先在目标平台预览；分享文件引用时需携带 Iconize SVG 文件夹。',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('svg', 'SVG 标签 / SVG element')
          .addOption('data', '自包含 SVG 图片 / Self-contained SVG')
          .addOption('file', 'SVG 文件引用 / SVG file')
          .setValue(this.plugin.getSettings().iconEmbedFormat)
          .onChange((value) => {
            this.plugin.getSettings().iconEmbedFormat =
              value === 'file' ? 'file' : value === 'data' ? 'data' : 'svg';
            void this.plugin.saveIconFolderData();
          }),
      );
  }
}

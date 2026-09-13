import IconizePlugin from '@app/main';
import { Decoration, EditorView } from '@codemirror/view';
import { MarkdownView, editorInfoField } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree, tokenClassNodeProp } from '@codemirror/language';
import icon from '@lib/icon';
import { IconInLinkWidget } from '@app/editor/live-preview/widgets';
import { HeaderToken } from '@app/lib/util/text';

export const buildLinkDecorations = (
  view: EditorView,
  plugin: IconizePlugin,
) => {
  const builder = new RangeSetBuilder<Decoration>();
  const mdView = view.state.field(editorInfoField) as MarkdownView;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const tokenProps = node.type.prop(tokenClassNodeProp);
        if (tokenProps) {
          const props = new Set(tokenProps.split(' '));
          const isLink = props.has('hmd-internal-link');
          const headerType = [
            'header-1',
            'header-2',
            'header-3',
            'header-4',
            'header-5',
            'header-6',
          ].find((header) => props.has(header)) as HeaderToken | null;

          if (isLink) {
            let linkText = view.state.doc.sliceString(node.from, node.to);
            linkText = linkText.split('#')[0];
            const file = plugin.app.metadataCache.getFirstLinkpathDest(
              linkText,
              mdView.file.basename,
            );

            if (file) {
              const possibleIcon = icon.getIconByPath(plugin, file.path);

              if (!possibleIcon) {
                // 按需加载：图标可能尚未解析。这里无法等待（同步装饰构建），
                // 因此排入加载队列，解析完成后由内联加载器重绘并重建装饰。
                //
                // The icon may not be resolved yet. This path cannot await, so queue the
                // load; the inline loader repaints once it resolves and the decoration is
                // rebuilt then.
                const iconName = icon.getByPath(plugin, file.path);
                if (iconName) {
                  plugin.inlineIconLoader?.requestIcon(iconName);
                }
              }

              if (possibleIcon) {
                const iconDecoration = Decoration.widget({
                  widget: new IconInLinkWidget(
                    plugin,
                    possibleIcon,
                    file.path,
                    headerType,
                  ),
                });

                builder.add(node.from, node.from, iconDecoration);
              }
            }
          }
        }
      },
    });
  }

  return builder.finish();
};

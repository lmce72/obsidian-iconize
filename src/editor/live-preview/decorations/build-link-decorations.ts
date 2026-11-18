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
        // 显式标注类型：`tokenClassNodeProp` 由本仓库的类型增强补上（见
        // src/@types/codemirror-language.d.ts），推断不出泛型参数。
        // Annotated explicitly: `tokenClassNodeProp` comes from this repo's type
        // augmentation, from which the generic argument cannot be inferred.
        const tokenProps: string | undefined =
          node.type.prop(tokenClassNodeProp);
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

              const iconName = icon.getByPath(plugin, file.path);
              const data =
                possibleIcon ??
                (iconName && plugin.iconResolver?.find(iconName)
                  ? iconName
                  : null);

              if (data) {
                const iconDecoration = Decoration.widget({
                  widget: new IconInLinkWidget(
                    plugin,
                    data,
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

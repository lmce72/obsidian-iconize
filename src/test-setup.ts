/**
 * This test setup script is used to patch the `obsidian` module to make it work with
 * `vitest`. It is a workaround and only adds the `main.js` file and updates the
 * `package.json` to point to it.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, vi } from 'vitest';

interface CreateElOptions {
  cls?: string | string[];
  text?: string;
  title?: string;
  attr?: Record<string, string>;
  type?: string;
  value?: string;
  placeholder?: string;
}

/**
 * Obsidian 在运行时为 `HTMLElement` 挂上 `createEl` / `createDiv` / `createSpan`，
 * 插件代码依赖它们构建 DOM。happy-dom 没有这些方法，测试会以
 * 「el.createSpan is not a function」失败——那是环境缺失，不是代码问题。
 * 这里补齐，使测试环境与运行时一致。
 *
 * At runtime Obsidian augments `HTMLElement` with `createEl` / `createDiv` /
 * `createSpan`, which the plugin uses to build DOM. happy-dom does not provide them, so
 * tests fail with "el.createSpan is not a function" — an environment gap, not a code
 * defect. Installing them here keeps the test environment in step with the runtime.
 */
const installObsidianDomHelpers = (): void => {
  if (typeof HTMLElement === 'undefined') {
    return;
  }

  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.createEl === 'function') {
    return;
  }

  const createEl = function (
    this: HTMLElement,
    tag: string,
    options?: string | CreateElOptions,
  ): HTMLElement {
    const el = document.createElement(tag);
    const o: CreateElOptions =
      typeof options === 'string' ? { cls: options } : (options ?? {});

    if (o.cls) {
      const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/);
      el.classList.add(...classes.filter((c) => c.length > 0));
    }
    if (o.text !== undefined) {
      el.textContent = o.text;
    }
    if (o.title !== undefined) {
      el.title = o.title;
    }
    if (o.attr) {
      for (const [key, value] of Object.entries(o.attr)) {
        el.setAttribute(key, value);
      }
    }
    for (const key of ['type', 'value', 'placeholder'] as const) {
      if (o[key] !== undefined) {
        el.setAttribute(key, o[key] as string);
      }
    }

    this.appendChild(el);
    return el;
  };

  proto.createEl = createEl;
  proto.createDiv = function (
    this: HTMLElement,
    options?: string | CreateElOptions,
  ) {
    return createEl.call(this, 'div', options);
  };
  proto.createSpan = function (
    this: HTMLElement,
    options?: string | CreateElOptions,
  ) {
    return createEl.call(this, 'span', options);
  };
  proto.appendText = function (this: HTMLElement, text: string): void {
    this.appendChild(document.createTextNode(text));
  };
  proto.setText = function (this: HTMLElement, text: string): void {
    this.textContent = text;
  };
};

installObsidianDomHelpers();

beforeEach(() => {
  vi.clearAllMocks();
});

(async () => {
  const obsidianModuleDir = join(__dirname, '../node_modules/obsidian');
  const mainFilePath = join(obsidianModuleDir, 'main.js');

  // Creates an empty `main.js` file.
  writeFileSync(mainFilePath, '');

  const packageJsonPath = join(obsidianModuleDir, 'package.json');
  const packageJson = (await import(packageJsonPath)).default;
  delete packageJson.main;
  packageJson.main = 'main.js';

  // Modifies `package.json` file to add `main.js` as the main entry point.
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
})();

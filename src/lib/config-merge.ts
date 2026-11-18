import { DEFAULT_SETTINGS } from '@app/settings/data';

export type ConfigData = Record<string, unknown>;

export interface ConfigItemVersion {
  updatedAt: number;
  writer: string;
  value?: unknown;
  deleted?: boolean;
}

type Item = { kind: 'icon' | 'setting'; name: string; value: unknown };
type ItemState = {
  value?: unknown;
  deleted?: boolean;
  version?: ConfigItemVersion;
  removedValue?: unknown;
};
const internalSettings = new Set(['configItemVersions', 'configRemovals']);
const itemId = (kind: Item['kind'], name: string) => `${kind}:${name}`;
const own = (value: ConfigData, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
const put = (target: ConfigData, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

export const cloneConfig = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value));

const isObject = (value: unknown): value is ConfigData =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const equalConfig = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equalConfig(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(b, k) && equalConfig(a[k], b[k]),
      )
    );
  }
  return false;
};

const items = (data: ConfigData): Map<string, Item> => {
  const result = new Map<string, Item>();
  for (const [name, value] of Object.entries(data)) {
    if (name !== 'settings')
      result.set(itemId('icon', name), { kind: 'icon', name, value });
  }
  if (isObject(data.settings)) {
    for (const [name, value] of Object.entries(data.settings)) {
      if (!internalSettings.has(name))
        result.set(itemId('setting', name), { kind: 'setting', name, value });
    }
  }
  return result;
};

const versions = (data: ConfigData): ConfigData => {
  const settings = isObject(data.settings) ? data.settings : {};
  return isObject(settings.configItemVersions)
    ? settings.configItemVersions
    : {};
};

const legacyRemovals = (data: ConfigData): ConfigData =>
  isObject(data.settings) && isObject(data.settings.configRemovals)
    ? data.settings.configRemovals
    : {};

const validVersion = (value: unknown): value is ConfigItemVersion =>
  isObject(value) &&
  Number.isSafeInteger(value.updatedAt) &&
  (value.updatedAt as number) > 0 &&
  typeof value.writer === 'string' &&
  value.writer.length > 0;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};

const newer = (a: ConfigItemVersion, b: ConfigItemVersion): number =>
  a.updatedAt - b.updatedAt ||
  (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0) ||
  (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);

/** Stamp real local edits only. Reading, receiving or merging never changes their age. */
export function stampConfigChanges(
  previous: ConfigData,
  current: ConfigData,
  writer: string,
  now = Date.now(),
): ConfigData {
  const before = items(previous);
  const after = items(current);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => !equalConfig(before.get(id)?.value, after.get(id)?.value),
  );
  if (!changed.length) return current;
  const result = cloneConfig(current);
  const clocks = cloneConfig(versions(current));
  let clock = Math.max(1, Math.floor(now));
  for (const v of [
    ...Object.values(versions(previous)),
    ...Object.values(clocks),
  ]) {
    if (validVersion(v)) clock = Math.max(clock, v.updatedAt);
  }
  for (const id of changed) {
    const item = after.get(id);
    const version: ConfigItemVersion = { updatedAt: ++clock, writer };
    if (item) version.value = cloneConfig(item.value);
    else {
      version.deleted = true;
      version.value = cloneConfig(before.get(id)!.value);
    }
    put(clocks, id, version);
  }
  const settings = isObject(result.settings)
    ? result.settings
    : (result.settings = {});
  settings.configItemVersions = clocks;
  return result;
}

/** Union item identities; resolve each item independently using its own edit clock. */
export function mergeConfig(
  base: ConfigData,
  local: ConfigData,
  remote: ConfigData,
): ConfigData {
  const maps = [items(base), items(local), items(remote)];
  const clocks = [versions(base), versions(local), versions(remote)];
  const ids = new Set([
    ...maps.flatMap((map) => [...map.keys()]),
    ...clocks.flatMap((map) => Object.keys(map)),
    ...[base, local, remote].flatMap((data) =>
      Object.keys(legacyRemovals(data)).map((name) => itemId('icon', name)),
    ),
  ]);
  const result: ConfigData = { settings: {} };
  const settings = result.settings as ConfigData;
  const mergedClocks: ConfigData = {};
  const removals: ConfigData = {};
  const state = (index: number, id: string): ItemState | undefined => {
    const item = maps[index].get(id);
    const version = clocks[index][id];
    if (
      validVersion(version) &&
      (version.deleted
        ? !item
        : !!item && equalConfig(version.value, item.value))
    ) {
      return { value: item?.value, deleted: !!version.deleted, version };
    }
    // An old plugin may remove metadata but leave the item's value unchanged.
    const oldVersion = clocks[0][id];
    if (
      item &&
      validVersion(oldVersion) &&
      !oldVersion.deleted &&
      equalConfig(oldVersion.value, item.value)
    ) {
      return { value: item.value, version: oldVersion };
    }
    if (item) return { value: item.value };
    const oldItem = maps[0].get(id);
    const config = [base, local, remote][index];
    const removal = legacyRemovals(config);
    const iconName = id.startsWith('icon:')
      ? id.slice('icon:'.length)
      : undefined;
    if (
      iconName !== undefined &&
      own(removal, iconName) &&
      (!oldItem || equalConfig(removal[iconName], oldItem.value))
    ) {
      return { deleted: true, removedValue: removal[iconName] };
    }
    return undefined;
  };
  for (const id of [...ids].sort()) {
    // Ignore malformed metadata that does not identify an actual item or tombstone.
    const item = maps[1].get(id) ?? maps[2].get(id) ?? maps[0].get(id);
    const kind =
      item?.kind ??
      (id.startsWith('icon:')
        ? 'icon'
        : id.startsWith('setting:')
          ? 'setting'
          : undefined);
    const name = item?.name ?? id.slice(id.indexOf(':') + 1);
    if (!kind || (kind === 'setting' && internalSettings.has(name))) continue;
    const b = state(0, id),
      l = state(1, id),
      r = state(2, id);
    let selected: ItemState | undefined;
    const stamped = [b, l, r].filter(
      (s): s is ItemState & { version: ConfigItemVersion } => !!s?.version,
    );
    if (stamped.length) {
      selected = stamped.reduce((a, candidate) =>
        newer(candidate.version, a.version) > 0 ? candidate : a,
      );
    } else if (!l && !r) selected = b;
    else if (!l) selected = r;
    else if (!r) selected = l;
    else if (equalConfig(l, b)) selected = r;
    else if (equalConfig(r, b) || equalConfig(l, r)) selected = l;
    else {
      // Legacy records have no reliable per-item date. Prefer the current disk item
      // for a simultaneous legacy conflict; immutable history retains both versions.
      selected = r;
    }
    if (!selected) continue;
    if (selected.version) put(mergedClocks, id, cloneConfig(selected.version));
    if (selected.deleted) {
      if (kind === 'icon') {
        const removed =
          selected.version?.value ??
          selected.removedValue ??
          maps[0].get(id)?.value;
        if (removed !== undefined) put(removals, name, cloneConfig(removed));
      }
    } else if (selected.value !== undefined) {
      put(
        kind === 'icon' ? result : settings,
        name,
        cloneConfig(selected.value),
      );
    }
  }
  if (Object.keys(mergedClocks).length)
    settings.configItemVersions = mergedClocks;
  if (Object.keys(removals).length) settings.configRemovals = removals;
  return result;
}

export function parseConfig(raw: string): ConfigData {
  const data: unknown = JSON.parse(raw);
  if (!isObject(data) || !isObject(data.settings)) {
    throw new Error('Iconize config must contain a settings object');
  }
  for (const [path, value] of Object.entries(data)) {
    if (
      path === 'settings' ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      continue;
    if (
      !isObject(value) ||
      !(value.iconName === null || typeof value.iconName === 'string') ||
      (value.iconColor !== undefined && typeof value.iconColor !== 'string')
    )
      throw new Error(`Invalid icon record: ${path}`);
  }
  // 无效设置不可进入运行期，也不能悄悄用默认值覆盖。 / Reject invalid settings without overwriting them with defaults.
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = data.settings[key];
    if (value === undefined) continue;
    const valid =
      fallback === null
        ? value === null || typeof value === 'string'
        : Array.isArray(fallback)
          ? Array.isArray(value)
          : typeof fallback === 'object'
            ? isObject(value)
            : typeof value === typeof fallback;
    if (!valid) throw new Error(`Invalid setting: ${key}`);
  }
  if (
    Array.isArray(data.settings.recentlyUsedIcons) &&
    !data.settings.recentlyUsedIcons.every((value) => typeof value === 'string')
  )
    throw new Error('Invalid setting: recentlyUsedIcons');
  if (
    Array.isArray(data.settings.rules) &&
    !data.settings.rules.every(
      (value) =>
        isObject(value) &&
        typeof value.rule === 'string' &&
        typeof value.icon === 'string',
    )
  )
    throw new Error('Invalid setting: rules');
  if (data.settings.iconIdentifier === '')
    throw new Error('Icon identifier cannot be empty');
  if (
    data.settings.autoConvertDelay !== undefined &&
    (typeof data.settings.autoConvertDelay !== 'number' ||
      !Number.isInteger(data.settings.autoConvertDelay) ||
      data.settings.autoConvertDelay < 1 ||
      data.settings.autoConvertDelay > 3600)
  )
    throw new Error('Conversion delay must be an integer from 1 to 3600');
  if (
    data.settings.iconEmbedFormat !== undefined &&
    !['data', 'svg', 'file'].includes(data.settings.iconEmbedFormat as string)
  )
    throw new Error('Invalid setting: iconEmbedFormat');
  return data;
}

/** Apply the committed snapshot while preserving later edits made during I/O. */
export function rebaseConfig(
  snapshot: ConfigData,
  current: ConfigData,
  committed: ConfigData,
): ConfigData {
  const rebase = (
    before: unknown,
    now: unknown,
    saved: unknown,
    path: string,
  ): unknown => {
    if (equalConfig(before, now)) return saved;
    if (
      (path === '' ||
        path === 'settings' ||
        path === 'settings.configItemVersions' ||
        path === 'settings.configRemovals') &&
      isObject(now) &&
      isObject(saved)
    ) {
      const previous = isObject(before) ? before : {};
      const result: ConfigData = {};
      for (const key of new Set([
        ...Object.keys(previous),
        ...Object.keys(now),
        ...Object.keys(saved),
      ])) {
        const value = rebase(
          previous[key],
          now[key],
          saved[key],
          path ? `${path}.${key}` : key,
        );
        if (value !== undefined)
          Object.defineProperty(result, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      return result;
    }
    return now;
  };
  return cloneConfig(rebase(snapshot, current, committed, '') as ConfigData);
}

import { describe, expect, it } from 'vitest';
import {
  cloneConfig,
  ConfigData,
  mergeConfig,
  stampConfigChanges,
  parseConfig,
} from './config-merge';

describe('configuration validation', () => {
  it.each([
    null,
    [],
    { iconName: 42 },
    { iconName: 'LiHeart', iconColor: false },
  ])(
    'rejects malformed icon records before they reach the renderer: %j',
    (record) => {
      expect(() =>
        parseConfig(JSON.stringify({ settings: {}, 'Bad.md': record })),
      ).toThrow('Invalid icon record: Bad.md');
    },
  );
});

const base: ConfigData = {
  settings: { fontSize: 16, rules: [] },
  Folder: 'LiHome',
};
const edit = (
  before: ConfigData,
  writer: string,
  time: number,
  change: (data: ConfigData) => void,
) => {
  const data = cloneConfig(before);
  change(data);
  return stampConfigChanges(before, data, writer, time);
};

describe('union with per-item latest edits', () => {
  it('retains legacy deletion records even when none of the snapshots contains the old icon', () => {
    const removed = { settings: { configRemovals: { Folder: 'LiHome' } } };
    expect(mergeConfig(removed, removed, removed)).toEqual(removed);
  });
  it('unions disjoint paths and keeps both sides when either file omits a known path', () => {
    const merged = mergeConfig(
      base,
      { settings: {}, local: 'LiStar' },
      { settings: {}, remote: 'LiBook' },
    );
    expect(merged).toMatchObject({
      Folder: 'LiHome',
      local: 'LiStar',
      remote: 'LiBook',
    });
  });

  it('uses each icon timestamp rather than whichever config had the latest unrelated edit', () => {
    const early = edit(base, 'A', 1000, (d) => {
      d.Folder = 'LiBook';
    });
    const local = edit(early, 'A', 9000, (d) => {
      d.Unrelated = 'LiStar';
    });
    const remote = edit(base, 'B', 2000, (d) => {
      d.Folder = 'LiHeart';
    });
    const merged = mergeConfig(base, local, remote);
    expect(merged.Folder).toBe('LiHeart');
    expect(merged.Unrelated).toBe('LiStar');
  });

  it('treats icon name and color as one item and rules as one atomic setting', () => {
    const local = edit(base, 'A', 1000, (d) => {
      d.Folder = { iconName: 'LiBook', iconColor: 'red' };
      (d.settings as ConfigData).rules = [{ rule: 'A', icon: 'LiStar' }];
    });
    const remote = edit(base, 'B', 2000, (d) => {
      d.Folder = { iconName: 'LiHeart', iconColor: 'blue' };
      (d.settings as ConfigData).rules = [{ rule: 'B', icon: 'LiHeart' }];
    });
    const merged = mergeConfig(base, local, remote);
    expect(merged.Folder).toEqual({ iconName: 'LiHeart', iconColor: 'blue' });
    expect((merged.settings as ConfigData).rules).toEqual([
      { rule: 'B', icon: 'LiHeart' },
    ]);
  });

  it('merges settings independently, keeping the latest conflicting setting', () => {
    const a = edit(base, 'A', 1000, (d) => {
      (d.settings as ConfigData).fontSize = 20;
    });
    const b = edit(base, 'B', 2000, (d) => {
      (d.settings as ConfigData).fontSize = 24;
      (d.settings as ConfigData).iconInTabsEnabled = false;
    });
    const c = edit(a, 'A', 3000, (d) => {
      (d.settings as ConfigData).iconColor = 'red';
    });
    expect(mergeConfig(base, c, b).settings).toMatchObject({
      fontSize: 24,
      iconInTabsEnabled: false,
      iconColor: 'red',
    });
  });

  it('respects newer explicit deletion and allows a still newer reassignment', () => {
    const assigned = edit(base, 'A', 1000, (d) => {
      d.Folder = 'LiStar';
    });
    const removed = edit(assigned, 'B', 2000, (d) => {
      delete d.Folder;
    });
    const absent = mergeConfig(base, assigned, removed);
    expect(absent.Folder).toBeUndefined();
    // A stale file cannot resurrect a versioned deletion, even without a baseline.
    expect(
      mergeConfig({ settings: {} }, removed, assigned).Folder,
    ).toBeUndefined();
    const reassigned = edit(removed, 'A', 3000, (d) => {
      d.Folder = 'LiBook';
    });
    expect(mergeConfig(base, reassigned, removed).Folder).toBe('LiBook');
    expect(
      (mergeConfig(base, reassigned, removed).settings as ConfigData)
        .configRemovals,
    ).toBeUndefined();
  });

  it('does not make received or merged values newer merely by saving them again', () => {
    const a = edit(base, 'A', 1000, (d) => {
      d.Folder = 'LiStar';
    });
    const merged = mergeConfig(base, base, a);
    expect(stampConfigChanges(merged, cloneConfig(merged), 'B', 9000)).toEqual(
      merged,
    );
    expect(mergeConfig(merged, merged, merged)).toEqual(merged);
  });

  it('converges independently of device order, including equal timestamps', () => {
    const a = edit(base, 'A', 1000, (d) => {
      d.Folder = 'LiBook';
    });
    const b = edit(base, 'B', 1000, (d) => {
      d.Folder = 'LiHeart';
    });
    const c = edit(base, 'C', 2000, (d) => {
      d.Other = 'LiStar';
    });
    const ab = mergeConfig(base, a, b);
    expect(mergeConfig(base, b, a)).toEqual(ab);
    expect(mergeConfig(base, ab, c)).toEqual(
      mergeConfig(base, a, mergeConfig(base, b, c)),
    );
    expect(mergeConfig(base, ab, ab)).toEqual(ab);
  });

  it('keeps a subsequent edit newer than an already observed clock even when local time goes backwards', () => {
    const a = edit(base, 'A', 5000, (d) => {
      d.Folder = 'LiBook';
    });
    const b = edit(a, 'B', 1000, (d) => {
      d.Folder = 'LiHeart';
    });
    expect(mergeConfig(base, a, b).Folder).toBe('LiHeart');
  });

  it('does not trust stale metadata for a different legacy value', () => {
    const a = edit(base, 'A', 1000, (d) => {
      d.Folder = 'LiStar';
    });
    const stale = cloneConfig(a);
    stale.Folder = 'LiBug';
    expect(mergeConfig(base, a, stale).Folder).toBe('LiStar');
    // Without any item timestamps, one-sided changes win; simultaneous legacy changes
    // prefer the disk value. Production persistence archives both versions first.
    expect(mergeConfig(base, base, { ...base, Folder: 'LiBook' }).Folder).toBe(
      'LiBook',
    );
    expect(
      mergeConfig(
        base,
        { ...base, Folder: 'LiStar' },
        { ...base, Folder: 'LiBook' },
      ).Folder,
    ).toBe('LiBook');
  });
});

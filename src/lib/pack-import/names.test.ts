import { describe, expect, it } from 'vitest';
import {
  packNameFromFileName,
  sanitizeFolder,
  sanitizeIconName,
  stripClassNamePrefix,
} from './names';

describe('sanitizeIconName', () => {
  it('keeps normal names and strips the SVG extension', () => {
    expect(sanitizeIconName('home.svg')).toBe('home');
    expect(sanitizeIconName('Arrow-Left')).toBe('Arrow-Left');
    expect(sanitizeIconName('user_profile')).toBe('user-profile');
  });

  it('turns dots and exotic characters into hyphens', () => {
    expect(sanitizeIconName('delete.fill')).toBe('delete-fill');
    expect(sanitizeIconName('a/b:c')).toBe('a-b-c');
    expect(sanitizeIconName('  --x--  ')).toBe('x');
  });

  it('makes every name addressable with an A-Z/0-9 start', () => {
    expect(sanitizeIconName('1password')).toBe('1password');
    expect(sanitizeIconName('&settings')).toBe('settings');
    expect(sanitizeIconName('搜索')).toBe('Icon-搜索');
  });

  it('rejects names with nothing usable left', () => {
    expect(sanitizeIconName('')).toBeNull();
    expect(sanitizeIconName('---')).toBeNull();
    expect(sanitizeIconName('!!!')).toBeNull();
  });
});

describe('sanitizeFolder', () => {
  it('normalizes each segment and drops traversal', () => {
    expect(sanitizeFolder('User & Faces/Line')).toBe('User-Faces/Line');
    expect(sanitizeFolder('../a/./b')).toBe('a/b');
    expect(sanitizeFolder('')).toBe('');
    expect(sanitizeFolder(undefined)).toBe('');
  });

  it('limits the depth from the tail', () => {
    expect(sanitizeFolder('a/b/c/d/e/f/g/h')).toBe('c/d/e/f/g/h');
  });
});

describe('packNameFromFileName', () => {
  it('derives a safe pack name from compound extensions', () => {
    expect(packNameFromFileName('iconify-mdi.json')).toBe('iconify-mdi');
    expect(packNameFromFileName('Tabler Icons.tar.gz')).toBe('tabler-icons');
    expect(packNameFromFileName('fa-solid-900.woff2')).toBe('fa-solid-900');
    expect(packNameFromFileName('/tmp/a/Bootstrap Icons.zip')).toBe(
      'bootstrap-icons',
    );
  });

  it('never returns an unusable name', () => {
    expect(packNameFromFileName('???')).toBe('icon-pack');
    expect(packNameFromFileName('.json')).toBe('icon-pack');
  });
});

describe('stripClassNamePrefix', () => {
  it('removes only known icon-library prefixes', () => {
    expect(stripClassNamePrefix('bi-alarm')).toBe('alarm');
    expect(stripClassNamePrefix('fa-user')).toBe('user');
    expect(stripClassNamePrefix('mdi-home')).toBe('home');
    expect(stripClassNamePrefix('icons-home')).toBe('icons-home');
  });
});

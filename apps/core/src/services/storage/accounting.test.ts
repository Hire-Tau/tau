import { describe, expect, test } from 'bun:test'
import { attributeStorage, parseDirectoryUsage } from './accounting'

describe('storage accounting', () => {
  test('attributes inclusive totals once, groups agent files, and sorts largest first', () => {
    const entries = parseDirectoryUsage(
      '100\t/home/box_a/workspace/repos/project\0' +
        '100\t/home/box_a/workspace/repos\0' +
        '150\t/home/box_a/workspace\0' +
        '200\t/home/box_a\0' +
        '50\t/home/box_b\0' +
        '500\t/home/box_c\0' +
        '800\t/home\0'
    )
    const owner = { home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Squad workspace and tools' }
    const result = attributeStorage(entries, [
      owner,
      owner,
      { ...owner, home: '/home/box_b', label: 'Agent files' },
      { ...owner, home: '/home/box_c', squadId: 'c', squadName: 'Research' },
      { ...owner, home: '/home/missing' },
    ])
    expect(result.map(({ name, bytes }) => ({ name, bytes }))).toEqual([
      { name: 'Research', bytes: 500 },
      { name: 'Product', bytes: 250 },
    ])
    expect(result[1].folders[0].children[0].children[0].children[0]).toEqual({
      name: 'project',
      bytes: 100,
      children: [],
    })
  })

  test('preserves unusual directory names without accepting malformed or escaping records', () => {
    const result = parseDirectoryUsage(
      '12\t/home/project with\ttab\nand newline\0' +
        '0\t/home/empty\0-1\t/home/negative\0NaN\t/home/nan\0' +
        '99999999999999999999999\t/home/overflow\0' +
        '10\t/etc/secret\0' +
        '1\t/home/../outside\0' +
        '2\t/home/box/./relative\0'
    )
    expect([...result]).toEqual([
      ['/home/project with\ttab\nand newline', 12],
      ['/home/empty', 0],
    ])
  })

  test('unowned homes and prefix neighbours are never attributed to a squad', () => {
    const result = attributeStorage(
      parseDirectoryUsage('5\t/home/box_a\0' + '100\t/home/box_ab\0' + '1000\t/home/unowned\0'),
      [{ home: '/home/box_a', squadId: 'a', squadName: 'Product', label: 'Workspace' }]
    )
    expect(result[0].bytes).toBe(5)
    expect(result[0].folders[0].children).toEqual([])
  })
})

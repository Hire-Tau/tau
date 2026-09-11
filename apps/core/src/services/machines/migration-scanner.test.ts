import { describe, expect, it } from 'bun:test'
import { buildMigrationScanCommand, parseMigrationScanRecords } from './migration-scanner'

const b64 = (value: string) => Buffer.from(value).toString('base64')

describe('migration scanner', () => {
  it('parses roots and lossless entry records into manifest inputs', () => {
    const records = [
      'R\tworkspace\tpresent\t755\tbox-user',
      `E\tworkspace\tfile\t${b64('nested/λ\nfile')}\t640\t3\t${'a'.repeat(64)}\t`,
      `E\tworkspace\tdirectory\t${b64('empty dir')}\t700\t\t\t`,
      `E\tworkspace\tsymlink\t${b64('link')}\t777\t\t\t${b64('nested')}`,
      'R\t.private\tabsent\t\t',
    ].join('\n')

    expect(parseMigrationScanRecords(records)).toEqual([
      {
        name: 'workspace',
        presence: 'present',
        mode: '755',
        owner: 'box-user',
        entries: [
          { pathB64: b64('nested/λ\nfile'), type: 'file', mode: '640', size: '3', contentSha256: 'a'.repeat(64) },
          { pathB64: b64('empty dir'), type: 'directory', mode: '700' },
          { pathB64: b64('link'), type: 'symlink', mode: '777', targetB64: b64('nested') },
        ],
      },
      { name: '.private', presence: 'absent', entries: [] },
    ])
  })

  it('rejects partial, duplicate, unsupported, and ownership-spoofed records', () => {
    expect(() => parseMigrationScanRecords('R\tworkspace\tpresent\t755\troot')).toThrow(/owner/i)
    expect(() => parseMigrationScanRecords('R\tworkspace\tpresent\t755\tbox-user')).toThrow(/private/i)
    expect(() =>
      parseMigrationScanRecords(
        ['R\tworkspace\tabsent\t\t', 'R\tworkspace\tabsent\t\t', 'R\t.private\tabsent\t\t'].join('\n')
      )
    ).toThrow(/duplicate/i)
    expect(() =>
      parseMigrationScanRecords(
        [
          'R\tworkspace\tpresent\t755\tbox-user',
          `E\tworkspace\tfifo\t${b64('pipe')}\t600\t\t\t`,
          'R\t.private\tabsent\t\t',
        ].join('\n')
      )
    ).toThrow(/unsupported/i)
  })

  it('builds a fixed-root NUL-safe privileged scan with no filename interpolation', () => {
    const command = buildMigrationScanCommand('/home/box_0123456789ab', 'box_0123456789ab')
    expect(command).toContain('for root in workspace .private')
    expect(command).toContain('-print0')
    expect(command).toContain('sha256sum -- "$path"')
    expect(command).toContain('base64 -w0')
    expect(command).not.toContain('/home/box_0123456789ab/workspace/*')
  })
})

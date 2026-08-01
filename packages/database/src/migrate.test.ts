import { describe, expect, it } from 'vitest';
import { selectMigrationFiles } from './migrate.js';

describe('selectMigrationFiles', () => {
  const files = ['002_second.sql', 'notes.md', '001_first.sql', '003_third.sql'];

  it('returns every SQL migration in filename order by default', () => {
    expect(selectMigrationFiles(files)).toEqual([
      '001_first.sql',
      '002_second.sql',
      '003_third.sql',
    ]);
  });

  it('stops at an explicit migration target', () => {
    expect(selectMigrationFiles(files, '002_second.sql')).toEqual([
      '001_first.sql',
      '002_second.sql',
    ]);
  });

  it('refuses an unknown migration target', () => {
    expect(() => selectMigrationFiles(files, '004_missing.sql')).toThrow(
      'Migration target 004_missing.sql does not exist.',
    );
  });
});

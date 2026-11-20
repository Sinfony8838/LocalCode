import { describe, expect, it } from 'vitest';
import { detectMentionToken } from '../src/renderer/Composer';

describe('@-file mention detection in the composer', () => {
  it('detects a token typed right after @, including at message start', () => {
    expect(detectMentionToken('@', 1)).toEqual({ start: 0, query: '' });
    expect(detectMentionToken('@src', 4)).toEqual({ start: 0, query: 'src' });
    expect(detectMentionToken('请看 @src/ma', 10)).toEqual({ start: 3, query: 'src/ma' });
    expect(detectMentionToken('前缀 @中文文件', 8)).toEqual({ start: 3, query: '中文文件' });
  });

  it('stops matching at whitespace or a second @ and after the caret', () => {
    expect(detectMentionToken('@a @b', 2)).toEqual({ start: 0, query: 'a' });
    expect(detectMentionToken('@a @b', 5)).toEqual({ start: 3, query: 'b' });
    expect(detectMentionToken('a @b', 1)).toBeNull();
    expect(detectMentionToken('@done ', 6)).toBeNull();
    expect(detectMentionToken('email test@@', 12)).toBeNull();
  });

  it('matches directory-qualified queries with a trailing slash', () => {
    expect(detectMentionToken('@scripts/', 9)).toEqual({ start: 0, query: 'scripts/' });
    expect(detectMentionToken('run @src/agent/', 15)).toEqual({ start: 4, query: 'src/agent/' });
  });
});

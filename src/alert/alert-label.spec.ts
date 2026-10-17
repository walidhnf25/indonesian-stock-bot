import { ownerLabel } from './alert.service';

describe('the owner label printed into a group is never user-chosen prose', () => {
  it('uses a well-formed @username', () => {
    expect(ownerLabel({ username: 'budi_santoso' })).toBe('@budi_santoso');
  });

  it.each([
    [
      'no username, hostile first name',
      { username: null, firstName: 'BBCA PASTI NAIK 100%, BELI SEKARANG' },
    ],
    [
      'bidi override in the first name',
      { username: null, firstName: `Budi${String.fromCodePoint(0x202e)}gnirts` },
    ],
    ['a username with spaces', { username: 'BBCA pasti naik', firstName: 'x' }],
    ['a too-short username', { username: 'ab', firstName: 'x' }],
    ['a username starting with a digit', { username: '1budi', firstName: 'x' }],
    ['a username with markup', { username: 'budi<b>x</b>', firstName: 'x' }],
    ['an over-long username', { username: 'a'.repeat(33), firstName: 'x' }],
    ['an empty username', { username: '', firstName: null }],
  ])('falls back to a neutral label: %s', (_label, user) => {
    expect(ownerLabel(user)).toBe('anggota grup');
  });
});

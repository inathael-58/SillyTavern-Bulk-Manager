import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueNamer, newPersonaId, cloneDescriptor, matchesQuery, safeFileName, avatarStem, makeZip, crc32 } from '../lib.js';

test('uniqueNamer numbers clashes case-insensitively and keeps the extension', () => {
    const n = uniqueNamer();
    assert.equal(n('Alice.png'), 'Alice.png');
    assert.equal(n('alice.png'), 'alice (2).png');
    assert.equal(n('Alice.png'), 'Alice (3).png');
    assert.equal(n('noext'), 'noext');
    assert.equal(n('noext'), 'noext (2)');
});

test('newPersonaId never repeats a taken id within the same millisecond', () => {
    const taken = new Set();
    const a = newPersonaId('Bob', taken, 1000); taken.add(a);
    const b = newPersonaId('Bob', taken, 1000); taken.add(b);
    assert.equal(a, '1000-Bob.png');
    assert.equal(b, '1001-Bob.png');
    assert.equal(newPersonaId('น้ำ ฝน', new Set(), 5), '5-.png');
});

test('cloneDescriptor deep-copies and drops character connections', () => {
    const d = { description: 'x', lorebook: 'L', connections: [{ type: 'character', id: 'a.png' }], extra: { k: [1] } };
    const c = cloneDescriptor(d);
    assert.deepEqual(c, { description: 'x', lorebook: 'L', extra: { k: [1] } });
    c.extra.k.push(2);
    assert.deepEqual(d.extra.k, [1]);
    assert.ok(d.connections);
    assert.deepEqual(cloneDescriptor(undefined), {});
});

test('matchesQuery searches every field, empty query matches all', () => {
    assert.ok(matchesQuery('', 'a'));
    assert.ok(matchesQuery('ALI', 'Bob', 'alice.png'));
    assert.ok(!matchesQuery('zed', 'Bob', 'alice.png'));
});

test('file name helpers', () => {
    assert.equal(safeFileName('a/b:c?.png'), 'a_b_c_.png');
    assert.equal(safeFileName('  ', 'x'), 'x');
    assert.equal(avatarStem('Seraphina_1.png'), 'Seraphina_1');
});

test('makeZip writes a valid stored zip', async () => {
    const enc = new TextEncoder();
    const files = [{ name: 'characters/ก.png', data: enc.encode('hello') }, { name: 'b.txt', data: enc.encode('') }];
    const buf = new Uint8Array(await makeZip(files).arrayBuffer());
    const dv = new DataView(buf.buffer);
    assert.equal(dv.getUint32(0, true), 0x04034b50);
    const end = buf.length - 22;
    assert.equal(dv.getUint32(end, true), 0x06054b50);
    assert.equal(dv.getUint16(end + 10, true), 2);
    assert.equal(dv.getUint32(14, true), crc32(enc.encode('hello')));
    assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
});

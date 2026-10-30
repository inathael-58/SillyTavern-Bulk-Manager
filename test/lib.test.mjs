import test from 'node:test';
import assert from 'node:assert/strict';
import {
    uniqueNamer, newPersonaId, cloneDescriptor, matchesQuery, safeFileName, avatarStem, makeZip, crc32,
    buildLoreModel, isUnused, wipLeftoversInGlobal, planCharDelete, chatKey,
} from '../lib.js';

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

const alice = { name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Alice Lore' } } };
const bob = { name: 'Bob', avatar: 'Bob.png', data: { extensions: {} } };

function loreInput(over = {}) {
    return {
        names: ['Alice Lore', 'Extra', 'Global Book', 'Persona Book', 'Chat Book', 'Live Book', 'WIP Book', 'Orphan'],
        globals: ['Global Book', 'Gone Global'],
        characters: [alice, bob],
        charLore: [{ name: 'Bob', extraBooks: ['Extra', 'Gone Extra'] }, { name: 'Deleted', extraBooks: ['Extra'] }],
        personas: { 'p.png': 'Me' },
        personaDescs: { 'p.png': { lorebook: 'Persona Book' }, 'q.png': {} },
        chatLinks: [
            { book: 'Chat Book', char: { name: 'Bob', avatar: 'Bob.png' }, file: 'Bob - 1' },
            { book: 'Orphan', char: { name: 'Zed', avatar: 'Zed.png' }, file: 'Zed - 1' },
            { book: 'Chat Book', char: { name: 'Alice', avatar: 'Alice.png' }, file: 'Alice - open' },
        ],
        fileToChar: new Map([['Bob - 2', { name: 'Bob', avatar: 'Bob.png' }]]),
        currentChatId: 'Alice - open',
        currentRef: { name: 'Alice', avatar: 'Alice.png' },
        liveBook: 'Live Book',
        wipChatLorebooks: { 'Bob - 2': ['WIP Book', 'Gone WIP'], bad: 'x' },
        ...over,
    };
}

test('buildLoreModel finds every kind of use', () => {
    const m = buildLoreModel(loreInput());
    const u = n => m.usage.get(n);
    assert.equal(u('Alice Lore').chars[0].kind, 'primary');
    assert.deepEqual(u('Extra').chars.map(x => [x.char.name, x.kind]), [['Bob', 'extra']]);
    assert.ok(u('Global Book').global);
    assert.deepEqual(u('Persona Book').personas, ['Me']);
    assert.deepEqual(u('Chat Book').chats.map(x => x.file), ['Bob - 1']); // open chat comes from liveBook instead
    assert.deepEqual(u('Live Book').chats, [{ char: { name: 'Alice', avatar: 'Alice.png' }, file: 'Alice - open' }]);
    assert.equal(u('WIP Book').wip[0].char.name, 'Bob');
    // links of characters deleted since the scan don't count
    assert.ok(isUnused(u('Orphan')));
    const unused = m.names.filter(n => isUnused(u(n)));
    assert.deepEqual(unused, ['Orphan']);
});

test('buildLoreModel reports dangling links and stale extra-book entries', () => {
    const m = buildLoreModel(loreInput());
    assert.deepEqual(m.missing.map(x => x.book).sort(), ['Gone Extra', 'Gone Global']);
    assert.deepEqual(m.missing.find(x => x.book === 'Gone Extra').fix, { type: 'extra', stem: 'Bob' });
    assert.deepEqual(m.staleCharLore.map(e => e.name), ['Deleted']);
});

test('buildLoreModel copes with empty input', () => {
    const m = buildLoreModel({});
    assert.deepEqual(m.names, []);
    assert.deepEqual(m.missing, []);
});

test('wipLeftoversInGlobal keeps only existing globals that WIP linked', () => {
    const exists = new Set(['A', 'B', 'C']);
    assert.deepEqual(wipLeftoversInGlobal(['A', 'B', 'X'], { c1: ['A', 'X'], c2: 'junk' }, exists), ['A']);
    assert.deepEqual(wipLeftoversInGlobal(['A'], undefined, exists), []);
});

test('planCharDelete splits bots by which chats they keep', () => {
    const info = new Map([
        ['a.png', { state: 'done', chats: [{ file: 'a1.jsonl' }, { file: 'a2.jsonl' }] }],
        ['b.png', { state: 'done', chats: [{ file: 'b1.jsonl' }, { file: 'b2.jsonl' }] }],
        ['c.png', { state: 'done', chats: [{ file: 'c1.jsonl' }] }],
        ['d.png', { state: 'done', chats: [] }],
        ['e.png', { state: 'error', chats: [] }],
        ['f.png', { state: 'error', chats: [] }],
    ]);
    const keep = new Set([chatKey('b.png', 'b2.jsonl'), chatKey('c.png', 'c1.jsonl'), chatKey('f.png', '*')]);
    const plan = planCharDelete(['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png'], info, keep);
    assert.deepEqual(plan.full, ['a.png', 'd.png', 'e.png', 'g.png']);
    assert.deepEqual(plan.partial, ['b.png', 'c.png', 'f.png']);
    assert.deepEqual(plan.chatDeletes, [{ avatar: 'b.png', file: 'b1.jsonl' }]);
    assert.equal(plan.keptCount, 2);
});

/*
 * Bulk Manager — pure helpers (no SillyTavern imports, so they run under node --test).
 */

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fileStamp(ts = Date.now()) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m`;
}

export function safeFileName(s, fallback = 'file') {
    return String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || fallback;
}

/** Returns a function that hands out names unique within one zip folder (case-insensitive). */
export function uniqueNamer() {
    const used = new Set();
    return (name) => {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let out = name;
        for (let i = 2; used.has(out.toLowerCase()); i++) out = `${base} (${i})${ext}`;
        used.add(out.toLowerCase());
        return out;
    };
}

export const avatarStem = avatar => String(avatar ?? '').replace(/\.[^/.]+$/, '');

/**
 * Avatar id for a duplicated persona. Same shape as SillyTavern's own duplicate
 * (`<ms>-<ascii name>.png`), but never repeats an id that is already taken —
 * a bulk copy runs many times inside the same millisecond.
 */
export function newPersonaId(name, taken, now = Date.now()) {
    const slug = String(name ?? '').replace(/[^a-zA-Z0-9]/g, '');
    let ts = now;
    let id;
    do {
        id = `${ts}-${slug}.png`;
        ts++;
    } while (taken.has(id));
    return id;
}

/** Copy of a persona descriptor for a duplicate. Character connections stay with the original (as in SillyTavern). */
export function cloneDescriptor(d) {
    const copy = d && typeof d === 'object' ? structuredClone(d) : {};
    delete copy.connections;
    return copy;
}

export function matchesQuery(query, ...fields) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;
    return fields.some(f => String(f ?? '').toLowerCase().includes(q));
}

// ---------------------------------------------------------------- deleting characters: which chats go with them

/** Key for one chat of one character in the "keep" set. `*` stands for every chat (used when the list couldn't be read). */
export const chatKey = (avatar, file) => `${avatar}\n${file}`;

/**
 * Split a character delete into SillyTavern calls.
 * @param {string[]} avatars characters to delete
 * @param {Map<string, {state: string, chats: {file: string}[]}>} chatInfo chat lists that were read (state 'done')
 * @param {Set<string>} keep chatKey()s the user wants to keep
 * @returns {{full: string[], partial: string[], chatDeletes: {avatar: string, file: string}[], keptCount: number}}
 *   full: delete with all their chats (deleteChats: true); partial: delete the character only,
 *   then remove chatDeletes one by one.
 */
export function planCharDelete(avatars, chatInfo, keep) {
    const full = [];
    const partial = [];
    const chatDeletes = [];
    let keptCount = 0;
    for (const avatar of avatars) {
        const info = chatInfo.get(avatar);
        if (info?.state !== 'done') {
            if (keep.has(chatKey(avatar, '*'))) partial.push(avatar);
            else full.push(avatar);
            continue;
        }
        const drop = info.chats.filter(c => !keep.has(chatKey(avatar, c.file)));
        keptCount += info.chats.length - drop.length;
        if (drop.length === info.chats.length) {
            full.push(avatar);
        } else {
            partial.push(avatar);
            for (const c of drop) chatDeletes.push({ avatar, file: c.file });
        }
    }
    return { full, partial, chatDeletes, keptCount };
}

// ---------------------------------------------------------------- lorebook usage model

/**
 * @typedef {{name: string, avatar: string}} CharRef
 * @typedef {{
 *   global: boolean,
 *   chars: {char: CharRef, kind: 'primary'|'extra'}[],
 *   personas: string[],
 *   chats: {char: CharRef|null, file: string}[],
 *   wip: {chatId: string, char: CharRef|null}[],
 * }} Usage
 */

/**
 * Where every lorebook is used. Takes plain data (read from SillyTavern by the caller):
 * names, globals, characters [{name, avatar, data}], charLore [{name, extraBooks}],
 * personas {id: name}, personaDescs {id: {lorebook}}, chatLinks [{book, char, file}] from the chat scan,
 * fileToChar Map(chat id -> CharRef), currentChatId, currentRef, liveBook (chat lore of the open chat),
 * wipChatLorebooks {chatId: string[]} (WorldInfoPlus leftovers).
 */
export function buildLoreModel(input) {
    const names = [...(input.names ?? [])];
    const exists = new Set(names);
    /** @type {Map<string, Usage>} */
    const usage = new Map(names.map(n => [n, { global: false, chars: [], personas: [], chats: [], wip: [] }]));
    /** @type {{book: string, where: string, fix?: {type: 'extra', stem: string}}[]} */
    const missing = [];
    const touch = (book, where, fix) => {
        if (usage.has(book)) return usage.get(book);
        missing.push({ book, where, fix });
        return null;
    };

    for (const n of input.globals ?? []) {
        const u = touch(n, 'Global');
        if (u) u.global = true;
    }

    const chars = (input.characters ?? []).filter(ch => ch?.avatar);
    const stemToChar = new Map();
    const avatars = new Set();
    for (const ch of chars) {
        const ref = { name: ch.name, avatar: ch.avatar };
        avatars.add(ch.avatar);
        stemToChar.set(avatarStem(ch.avatar), ref);
        const primary = ch.data?.extensions?.world;
        if (primary) touch(primary, `การ์ด ${ch.name} (เล่มหลัก)`)?.chars.push({ char: ref, kind: 'primary' });
    }

    /** charLore entries whose character no longer exists */
    const staleCharLore = [];
    for (const entry of input.charLore ?? []) {
        const ref = stemToChar.get(entry?.name);
        if (!ref) {
            staleCharLore.push(entry);
            continue;
        }
        for (const b of entry.extraBooks ?? []) {
            touch(b, `การ์ด ${ref.name} (เล่มเสริม)`, { type: 'extra', stem: entry.name })?.chars.push({ char: ref, kind: 'extra' });
        }
    }

    for (const [id, desc] of Object.entries(input.personaDescs ?? {})) {
        const book = desc?.lorebook;
        if (!book) continue;
        const pname = input.personas?.[id] || id;
        touch(book, `Persona ${pname}`)?.personas.push(pname);
    }

    // Chat lore: every character chat (from the scan) + the chat open right now (live, may be unsaved).
    // Links of characters deleted since the scan are gone with them.
    const currentId = input.currentChatId ? String(input.currentChatId) : null;
    for (const l of input.chatLinks ?? []) {
        if (l.file === currentId || !avatars.has(l.char?.avatar)) continue;
        touch(l.book, `แชท ${l.char.name} — ${l.file}`)?.chats.push({ char: l.char, file: l.file });
    }
    const liveBook = input.liveBook;
    if (currentId && typeof liveBook === 'string' && liveBook) {
        touch(liveBook, `แชทที่เปิดอยู่ (${currentId})`)?.chats.push({ char: input.currentRef ?? null, file: currentId });
    }

    // WorldInfoPlus "multi chat lore" links (kept in settings even after WIP is removed).
    for (const [chatId, books] of Object.entries(input.wipChatLorebooks ?? {})) {
        if (!Array.isArray(books)) continue;
        const char = input.fileToChar?.get(chatId) ?? (chatId === currentId ? input.currentRef ?? null : null);
        for (const b of books) usage.get(b)?.wip.push({ chatId, char });
    }

    return { names, exists, usage, missing, staleCharLore };
}

export function isUnused(u) {
    return !u.global && !u.chars.length && !u.personas.length && !u.chats.length && !u.wip.length;
}

/** Books sitting in Global only because WorldInfoPlus injected them for chat lore. */
export function wipLeftoversInGlobal(globals, wipChatLorebooks, exists) {
    if (!wipChatLorebooks) return [];
    const wipBooks = new Set(Object.values(wipChatLorebooks).filter(Array.isArray).flat());
    return (globals ?? []).filter(n => wipBooks.has(n) && exists.has(n));
}

// ---------------------------------------------------------------- tiny ZIP writer (store, no compression)

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** @param {{name: string, data: Uint8Array}[]} files */
export function makeZip(files, now = new Date()) {
    const enc = new TextEncoder();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true); // UTF-8 file names
        lh.setUint16(8, 0, true);
        lh.setUint16(10, time, true);
        lh.setUint16(12, date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, f.data.length, true);
        lh.setUint32(22, f.data.length, true);
        lh.setUint16(26, name.length, true);
        parts.push(new Uint8Array(lh.buffer), name, f.data);

        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(12, time, true);
        ch.setUint16(14, date, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, f.data.length, true);
        ch.setUint32(24, f.data.length, true);
        ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

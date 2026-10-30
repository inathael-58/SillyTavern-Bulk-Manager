/*
 * Bulk Manager — Lorebook tab (formerly the Lore Tidy extension)
 *
 * Shows where every lorebook is used (character primary / extra books, persona,
 * Global, chat lore of every character chat), finds lorebooks nobody uses any
 * more, and deletes them in bulk — always offering a .zip backup first.
 * Also cleans up leftovers of the WorldInfoPlus extension, and adds the
 * "active books" lists to the World Info panel.
 *
 * The modal shell lives in index.js; it hands this module a `host` with the
 * shared state and helpers (see setupLorebooks).
 */

import {
    world_names,
    selected_world_info,
    world_info,
    deleteWorldInfo,
    openWorldInfoEditor,
    assignLorebookToChat,
    loadWorldInfo,
} from '../../../world-info.js';
import {
    escapeHtml, fileStamp, safeFileName, uniqueNamer, avatarStem, makeZip,
    buildLoreModel, isUnused, wipLeftoversInGlobal,
} from './lib.js';

const LOG = '[BulkManager]';
const WIP_MODULE = 'world-info-plus';
const SCAN_CONCURRENCY = 3;

const ctx = () => SillyTavern.getContext();
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });
const thumbUrl = avatar => `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;

export const bookNames = () => (Array.isArray(world_names) ? [...world_names] : []);

/** The old standalone Lore Tidy is still installed: leave the World Info panel to it, so nothing shows twice. */
export const oldLoreTidyLoaded = () => !!globalThis.LoreTidy;

function wipSettings() {
    const s = ctx().extensionSettings?.[WIP_MODULE];
    return s && typeof s === 'object' ? s : null;
}

/** @type {any} set by setupLorebooks */
let host = null;

// ---------------------------------------------------------------- chat scan

/** Result of scanning every character chat's metadata. Kept for the session. */
let chatScan = {
    state: 'idle',          // idle | running | done | error | nochars
    progress: [0, 0],
    at: 0,
    chatCount: 0,
    failed: 0,
    /** @type {{book: string, char: {name: string, avatar: string}, file: string}[]} */
    links: [],
    /** @type {Map<string, {name: string, avatar: string}>} chat file id -> character */
    fileToChar: new Map(),
};
let scanPromise = null;
/** Set when chats or characters may have changed since the last scan; the next look rescans. */
let scanDirty = false;

const characterList = () => (ctx().characters || []).filter(ch => ch && ch.avatar);

async function scanChats(onProgress) {
    if (scanPromise) return scanPromise;
    const chars = characterList();
    if (!chars.length) {
        // Character list not loaded yet (or really empty): never report "done" on nothing.
        chatScan.state = 'nochars';
        onProgress?.();
        return;
    }
    chatScan = { state: 'running', progress: [0, chars.length], at: 0, chatCount: 0, failed: 0, links: [], fileToChar: new Map() };
    scanDirty = false;
    const headers = ctx().getRequestHeaders();

    scanPromise = (async () => {
        let next = 0;
        const worker = async () => {
            while (next < chars.length) {
                const ch = chars[next++];
                const ref = { name: ch.name, avatar: ch.avatar };
                try {
                    const res = await fetch('/api/characters/chats', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatar_url: ch.avatar, metadata: true }),
                    });
                    if (!res.ok) throw new Error(String(res.status));
                    const list = await res.json();
                    if (Array.isArray(list)) {
                        for (const chat of list) {
                            const file = String(chat.file_id ?? chat.file_name ?? '').replace(/\.jsonl$/, '');
                            if (!file) continue;
                            chatScan.chatCount++;
                            chatScan.fileToChar.set(file, ref);
                            const book = chat.chat_metadata?.world_info;
                            if (typeof book === 'string' && book) chatScan.links.push({ book, char: ref, file });
                        }
                    }
                } catch (e) {
                    chatScan.failed++;
                    console.warn(LOG, 'chat scan failed for', ch.avatar, e);
                }
                chatScan.progress[0]++;
                onProgress?.();
            }
        };
        await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        chatScan.state = 'done';
        chatScan.at = Date.now();
    })().catch(e => {
        console.error(LOG, e);
        chatScan.state = 'error';
    }).finally(() => {
        scanPromise = null;
        onProgress?.();
    });
    return scanPromise;
}

function startScan() {
    scanChats(() => { if (host.ui.tab === 'books') host.renderSoon(); });
    if (host.ui.tab === 'books') host.renderAll();
}

/** Called whenever the Lorebook tab is shown: scan chats if never done or out of date. */
export function onShow() {
    if (chatScan.state !== 'running' && (chatScan.state !== 'done' || scanDirty)) startScan();
}

// ---------------------------------------------------------------- model

let model = null;

function buildModel() {
    const c = ctx();
    const pu = c.powerUserSettings ?? {};
    const currentRef = c.characterId !== undefined && c.characterId !== null && c.characters?.[c.characterId]
        ? { name: c.characters[c.characterId].name, avatar: c.characters[c.characterId].avatar }
        : null;
    return buildLoreModel({
        names: bookNames(),
        globals: selected_world_info || [],
        characters: characterList(),
        charLore: world_info?.charLore ?? [],
        personas: pu.personas,
        personaDescs: pu.persona_descriptions,
        chatLinks: chatScan.links,
        fileToChar: chatScan.fileToChar,
        currentChatId: c.chatId,
        currentRef,
        liveBook: c.chatMetadata?.world_info,
        wipChatLorebooks: wipSettings()?.chatLorebooks,
    });
}

/** Rebuild the usage model and drop selections of books that no longer exist. */
export function refreshModel() {
    model = buildModel();
    for (const n of [...host.ui.selected.books]) if (!model.exists.has(n)) host.ui.selected.books.delete(n);
}

const getModel = () => model ?? (model = buildModel());

/** Lorebooks a set of characters use as primary or extra book (for the character delete warning). */
export function booksOfCharacters(avatars) {
    const want = new Set(avatars);
    const out = new Set();
    for (const ch of characterList()) {
        if (!want.has(ch.avatar)) continue;
        const primary = ch.data?.extensions?.world;
        if (primary) out.add(primary);
        const extra = world_info?.charLore?.find(e => e.name === avatarStem(ch.avatar))?.extraBooks ?? [];
        for (const b of extra) out.add(b);
    }
    const exists = new Set(bookNames());
    return [...out].filter(b => exists.has(b)).sort(collator.compare);
}

// ---------------------------------------------------------------- modal parts

const VIEWS = ['unused', 'bychar', 'all', 'tools'];

export function renderSubtabs(el) {
    const m = getModel();
    const unused = m.names.filter(n => isUnused(m.usage.get(n))).length;
    const issues = m.missing.length + (characterList().length ? m.staleCharLore.length : 0)
        + wipLeftoversInGlobal(selected_world_info, wipSettings()?.chatLorebooks, m.exists).length;
    const labels = {
        unused: `ไม่มีใครใช้ (${unused})`,
        bychar: 'ตามการ์ด',
        all: `ทั้งหมด (${m.names.length})`,
        tools: `ลิงก์ค้าง${issues ? ` (${issues})` : ''}`,
    };
    el.innerHTML = VIEWS.map(k =>
        `<div class="bm_subtab menu_button ${host.ui.bookView === k ? 'bm_active' : ''}" role="tab" data-view="${k}">${escapeHtml(labels[k])}</div>`).join('');
    el.querySelectorAll('.bm_subtab').forEach(t => t.addEventListener('click', () => {
        if (host.ui.busy) return;
        host.ui.bookView = t.dataset.view;
        host.ui.lastClicked = null;
        renderSubtabs(el);
        host.renderBody();
    }));
}

export function renderStatus(el) {
    const s = chatScan;
    let html;
    if (s.state === 'running') {
        html = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังเช็ค Chat Lore ในแชทของทุกการ์ด… ${s.progress[0]}/${s.progress[1]} การ์ด
                <span class="bm_dim">(ระหว่างนี้ยังไม่นับเล่มที่ผูกกับแชทอื่น ยังไม่ควรลบ)</span>`;
    } else if (s.state === 'done') {
        html = `<i class="fa-solid fa-check"></i> เช็คแชทแล้ว ${s.chatCount} แชท จาก ${s.progress[1]} การ์ด`
            + (s.failed ? ` <span class="bm_warn">· อ่านไม่ได้ ${s.failed} การ์ด</span>` : '')
            + ' <span class="bm_dim">· ไม่รวมแชทกลุ่ม</span>'
            + ' <span class="bm_link" id="bm_rescan">สแกนใหม่</span>';
    } else if (s.state === 'nochars') {
        html = '<span class="bm_warn"><i class="fa-solid fa-triangle-exclamation"></i> ยังไม่มีรายชื่อการ์ด (SillyTavern อาจยังโหลดไม่เสร็จ) ตอนนี้ยังบอกไม่ได้ว่าเล่มไหนไม่มีใครใช้ ลบไม่ได้จนกว่าจะเช็คเสร็จ</span> <span class="bm_link" id="bm_rescan">ลองใหม่</span>';
    } else if (s.state === 'error') {
        html = '<span class="bm_warn"><i class="fa-solid fa-triangle-exclamation"></i> เช็คแชทไม่สำเร็จ</span> <span class="bm_link" id="bm_rescan">ลองใหม่</span>';
    } else {
        html = '';
    }
    el.innerHTML = html;
    el.querySelector('#bm_rescan')?.addEventListener('click', () => { if (!host.ui.busy) startScan(); });
}

function matchesBook(name, u) {
    const q = host.ui.query.trim().toLowerCase();
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    return u.chars.some(x => String(x.char.name ?? '').toLowerCase().includes(q));
}

function badgesHtml(u) {
    const out = [];
    if (u.global) out.push('<span class="bm_badge bm_b_global" title="เปิดไว้ใน Global World Info"><i class="fa-solid fa-globe"></i> Global</span>');
    const charBadge = (list, label) => {
        if (!list.length) return;
        const names = list.map(x => x.char.name);
        const text = names.length <= 2 ? names.join(', ') : `${names.length} การ์ด`;
        out.push(`<span class="bm_badge" title="${escapeHtml(`${label}: ${names.join(', ')}`)}"><i class="fa-solid fa-user"></i> ${escapeHtml(label)}: ${escapeHtml(text)}</span>`);
    };
    charBadge(u.chars.filter(x => x.kind === 'primary'), 'เล่มหลัก');
    charBadge(u.chars.filter(x => x.kind === 'extra'), 'เล่มเสริม');
    if (u.personas.length) {
        out.push(`<span class="bm_badge" title="${escapeHtml(u.personas.join(', '))}"><i class="fa-solid fa-masks-theater"></i> Persona: ${escapeHtml(u.personas.length <= 2 ? u.personas.join(', ') : `${u.personas.length} ตัว`)}</span>`);
    }
    if (u.chats.length) {
        const tip = u.chats.map(x => `${x.char?.name ?? '?'} — ${x.file}`).join('\n');
        out.push(`<span class="bm_badge" title="${escapeHtml(tip)}"><i class="fa-solid fa-comments"></i> Chat Lore ${u.chats.length} แชท</span>`);
    }
    if (u.wip.length) {
        const tip = u.wip.map(x => `${x.char?.name ?? '?'} — ${x.chatId}`).join('\n');
        out.push(`<span class="bm_badge bm_b_wip" title="${escapeHtml(`ผูกผ่าน WorldInfoPlus:\n${tip}`)}"><i class="fa-solid fa-puzzle-piece"></i> WIP ${u.wip.length} แชท</span>`);
    }
    if (!out.length) out.push('<span class="bm_badge bm_b_unused"><i class="fa-regular fa-circle"></i> ไม่มีใครใช้</span>');
    return out.join('');
}

function rowHtml(name, u, note = '') {
    const on = host.ui.selected.books.has(name);
    return `
        <div class="bm_row ${on ? 'bm_sel' : ''}" data-key="${escapeHtml(name)}">
            <input type="checkbox" class="bm_cb" ${on ? 'checked' : ''} aria-label="เลือก ${escapeHtml(name)}">
            <div class="bm_main">
                <div class="bm_name">${escapeHtml(name)}${note ? ` <span class="bm_note">${escapeHtml(note)}</span>` : ''}</div>
                <div class="bm_badges">${badgesHtml(u)}</div>
            </div>
            <div class="menu_button bm_open fa-solid fa-pen-to-square" title="เปิดในตัวแก้ไข"></div>
        </div>`;
}

function groupHtml(title, books, { avatar = null, sub = '' } = {}) {
    const allSel = books.length && books.every(b => host.ui.selected.books.has(b.name));
    return `
        <div class="bm_group">
            <div class="bm_group_head">
                <input type="checkbox" class="bm_gcb" ${allSel ? 'checked' : ''} title="เลือกทั้งกลุ่ม">
                ${avatar ? `<img class="bm_gavatar" src="${escapeHtml(thumbUrl(avatar))}" alt="" loading="lazy">` : ''}
                <div class="bm_group_title">${escapeHtml(title)} <span class="bm_dim">${books.length} เล่ม${sub ? ` · ${escapeHtml(sub)}` : ''}</span></div>
            </div>
            ${books.map(b => rowHtml(b.name, b.u, b.note)).join('')}
        </div>`;
}

export function renderBody(body) {
    const m = getModel();
    const sorted = [...m.names].sort(collator.compare);
    const view = host.ui.bookView;
    let html = '';
    /** keys in display order, for shift-click ranges (flat views only) */
    let keys = null;

    if (view === 'tools') {
        html = toolsHtml(m);
    } else if (view === 'bychar') {
        const groups = new Map();
        const loose = [];
        for (const name of sorted) {
            const u = m.usage.get(name);
            if (!matchesBook(name, u)) continue;
            const refs = new Map();
            for (const x of u.chars) refs.set(x.char.avatar, { ref: x.char, note: x.kind === 'primary' ? 'เล่มหลัก' : 'เล่มเสริม' });
            for (const x of u.chats) if (x.char && !refs.has(x.char.avatar)) refs.set(x.char.avatar, { ref: x.char, note: 'Chat Lore' });
            for (const x of u.wip) if (x.char && !refs.has(x.char.avatar)) refs.set(x.char.avatar, { ref: x.char, note: 'WIP' });
            if (!refs.size) { loose.push({ name, u, note: '' }); continue; }
            for (const { ref, note } of refs.values()) {
                if (!groups.has(ref.avatar)) groups.set(ref.avatar, { ref, books: [] });
                groups.get(ref.avatar).books.push({ name, u, note });
            }
        }
        const list = [...groups.values()].sort((a, b) => collator.compare(a.ref.name, b.ref.name));
        html = list.map(g => groupHtml(g.ref.name, g.books, { avatar: g.ref.avatar })).join('');
        if (loose.length) html += groupHtml('ไม่ผูกกับการ์ดไหน', loose, { sub: 'รวมเล่ม Global / Persona และเล่มที่ไม่มีใครใช้' });
        if (!html) html = '<div class="bm_empty">ไม่พบเล่มที่ตรงกับคำค้น</div>';
    } else {
        const rows = sorted
            .map(name => ({ name, u: m.usage.get(name) }))
            .filter(({ name, u }) => (view === 'all' || isUnused(u)) && matchesBook(name, u));
        if (!rows.length) {
            html = view === 'unused' && !host.ui.query
                ? '<div class="bm_empty">ไม่มีเล่มที่ไม่มีใครใช้ 🎉</div>'
                : '<div class="bm_empty">ไม่พบเล่มที่ตรงกับคำค้น</div>';
        } else {
            keys = rows.map(r => r.name);
            const allSel = rows.every(r => host.ui.selected.books.has(r.name));
            html = `<div class="bm_listhead">
                    <label class="checkbox_label"><input type="checkbox" class="bm_allcb" ${allSel ? 'checked' : ''}> เลือกทั้งหมดที่แสดง (${rows.length})</label>
                    <span class="bm_dim bm_hint">คอม: กด Shift ค้างเพื่อเลือกเป็นช่วง</span>
                </div>`
                + rows.map(r => rowHtml(r.name, r.u)).join('');
            if (view === 'unused' && chatScan.state !== 'done') {
                html = '<div class="bm_banner bm_warn">ยังเช็คไม่เสร็จ เล่มในรายการนี้อาจยังมีการ์ดหรือแชทใช้อยู่</div>' + html;
            }
        }
    }

    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;

    body.querySelectorAll('.bm_row').forEach(row => {
        const name = row.dataset.key;
        host.wireRow(row, name, keys);
        row.querySelector('.bm_open').addEventListener('click', e => {
            e.stopPropagation();
            host.closeModal();
            openWorldInfoEditor(name);
        });
    });
    body.querySelectorAll('.bm_group').forEach(g => {
        const names = [...g.querySelectorAll('.bm_row')].map(r => r.dataset.key);
        g.querySelector('.bm_gcb').addEventListener('change', e => host.toggleSel(names, e.target.checked));
    });
    body.querySelector('.bm_allcb')?.addEventListener('change', e => host.toggleSel(keys ?? [], e.target.checked));
    wireTools(body);
}

// ---------------------------------------------------------------- footer: backup / delete

export function renderFoot(foot) {
    const m = getModel();
    const sel = [...host.ui.selected.books].sort(collator.compare);

    if (host.ui.confirm === 'delete') {
        const inUse = sel.filter(n => !isUnused(m.usage.get(n)));
        foot.innerHTML = `
            <div class="bm_confirm">
                <div><b>ลบ ${sel.length} เล่ม?</b> ลบแล้วกู้คืนจากเซิร์ฟเวอร์ไม่ได้</div>
                <div class="bm_confirm_list">${sel.map(escapeHtml).join(' · ')}</div>
                ${inUse.length ? `<div class="bm_warn"><i class="fa-solid fa-triangle-exclamation"></i> ${inUse.length} เล่มยังมีคนใช้อยู่: ${inUse.map(escapeHtml).join(', ')} การ์ด แชท หรือ persona ที่ใช้อยู่จะไม่มีเล่มนี้แล้ว</div>` : ''}
                <label class="checkbox_label"><input type="checkbox" id="bm_do_backup" checked> ดาวน์โหลดไฟล์สำรอง (.zip) ก่อนลบ</label>
                <div class="bm_btns">
                    <div class="menu_button bm_cancel">ยกเลิก</div>
                    <div class="menu_button redWarningBG bm_go"><i class="fa-solid fa-trash-can"></i> ลบ ${sel.length} เล่ม</div>
                </div>
            </div>`;
        foot.querySelector('.bm_cancel').addEventListener('click', () => { host.ui.confirm = null; host.renderFoot(); });
        foot.querySelector('.bm_go').addEventListener('click', () => doDelete(sel, foot.querySelector('#bm_do_backup').checked));
        return;
    }

    const dis = sel.length ? '' : 'disabled';
    foot.innerHTML = `
        <div class="bm_selinfo">เลือกไว้ ${sel.length} เล่ม${sel.length ? ' <span class="bm_link bm_clear">ล้าง</span>' : ''}</div>
        <div class="bm_btns">
            <div class="menu_button bm_backup ${dis}" title="ดาวน์โหลดเล่มที่เลือกเป็น .zip (ใน zip มีไฟล์ .json แยกเล่ม นำเข้าใหม่ด้วยปุ่ม Import ได้)"><i class="fa-solid fa-file-zipper"></i> สำรอง</div>
            <div class="menu_button redWarningBG bm_delete ${dis}"><i class="fa-solid fa-trash-can"></i> ลบ</div>
        </div>`;
    foot.querySelector('.bm_clear')?.addEventListener('click', () => host.toggleSel(sel, false));
    foot.querySelector('.bm_backup').addEventListener('click', () => {
        if (!sel.length) return;
        host.busy('กำลังเตรียมไฟล์สำรอง…', async () => { await backupBooks(sel); host.toast.ok(`สำรอง ${sel.length} เล่มแล้ว`); });
    });
    foot.querySelector('.bm_delete').addEventListener('click', () => {
        if (!sel.length) return;
        if (chatScan.state !== 'done') {
            host.toast.warn(chatScan.state === 'running' ? 'รอเช็คแชทให้เสร็จก่อน แล้วค่อยลบ' : 'ยังเช็คการใช้งานไม่สำเร็จ กด "ลองใหม่" ที่แถบสถานะก่อน');
            return;
        }
        host.ui.confirm = 'delete';
        host.renderFoot();
    });
}

/** Download the given lorebooks as one .zip (one importable .json per book). Throws if any book can't be read. */
async function backupBooks(names) {
    const enc = new TextEncoder();
    const fileName = uniqueNamer();
    const files = [];
    for (const [i, n] of names.entries()) {
        host.setProgress(`กำลังอ่านเล่ม ${i + 1}/${names.length}…`);
        const data = await loadWorldInfo(n);
        if (!data) throw new Error(`อ่านเล่ม "${n}" จากเซิร์ฟเวอร์ไม่ได้ เลยยังไม่ทำอะไร`);
        files.push({ name: fileName(`${safeFileName(n, 'lorebook')}.json`), data: enc.encode(JSON.stringify(data, null, 4)) });
    }
    host.downloadBlob(makeZip(files), `lorebooks-backup ${fileStamp()}.zip`);
}

/** Remove references to a deleted book that SillyTavern's own delete leaves behind. */
function cleanupRefs(name) {
    const charLore = world_info?.charLore;
    if (Array.isArray(charLore)) {
        for (let i = charLore.length - 1; i >= 0; i--) {
            const e = charLore[i];
            if (!e?.extraBooks?.includes(name)) continue;
            e.extraBooks = e.extraBooks.filter(b => b !== name);
            if (!e.extraBooks.length) charLore.splice(i, 1);
        }
    }
    const wip = wipSettings();
    for (const [id, list] of Object.entries(wip?.chatLorebooks ?? {})) {
        if (Array.isArray(list) && list.includes(name)) wip.chatLorebooks[id] = list.filter(b => b !== name);
    }
    if (Array.isArray(wip?.injectedGlobal) && wip.injectedGlobal.includes(name)) {
        wip.injectedGlobal = wip.injectedGlobal.filter(b => b !== name);
    }
    const c = ctx();
    if (c.chatMetadata?.world_info === name) {
        c.chatMetadata.world_info = '';
        c.saveMetadataDebounced?.();
    }
}

async function doDelete(names, withBackup) {
    await host.busy('กำลังลบ…', async () => {
        if (withBackup) await backupBooks(names);
        const done = [];
        const failed = [];
        for (const [i, n] of names.entries()) {
            host.setProgress(`กำลังลบ ${i + 1}/${names.length}: ${n}`);
            let ok = false;
            try { ok = await deleteWorldInfo(n); } catch (e) { console.error(LOG, e); }
            if (ok) {
                cleanupRefs(n);
                done.push(n);
            } else {
                failed.push(n);
            }
        }
        ctx().saveSettingsDebounced();
        for (const n of done) host.ui.selected.books.delete(n);
        host.ui.confirm = null;
        host.report('ลบ', done.length, failed, 'เล่ม');
    });
}

// ---------------------------------------------------------------- tools view (dangling links, WIP leftovers)

function toolsHtml(m) {
    const parts = [];
    const c = ctx();

    // 1) WIP leftovers in Global
    const leftovers = wipLeftoversInGlobal(selected_world_info, wipSettings()?.chatLorebooks, m.exists);
    if (leftovers.length) {
        parts.push(`
            <div class="bm_card">
                <div class="bm_card_title"><i class="fa-solid fa-puzzle-piece"></i> เล่มที่ WorldInfoPlus ค้างไว้ใน Global</div>
                <div class="bm_dim">เล่มเหล่านี้เคยผูกเป็น Chat Lore ผ่าน WorldInfoPlus และตอนนี้เปิดอยู่ใน Global ถ้าไม่ได้ตั้งใจเปิดเป็น Global เอง ให้ถอดออก</div>
                ${leftovers.map(n => `<label class="checkbox_label"><input type="checkbox" class="bm_wipg" value="${escapeHtml(n)}" checked> ${escapeHtml(n)}</label>`).join('')}
                <div class="bm_btns"><div class="menu_button" id="bm_wip_unglobal"><i class="fa-solid fa-globe"></i> ถอดที่เลือกออกจาก Global</div></div>
            </div>`);
    }

    // 2) WIP links of the chat that's open
    const wip = wipSettings();
    const curId = c.chatId ? String(c.chatId) : null;
    const curWip = curId ? (wip?.chatLorebooks?.[curId] ?? []).filter(b => m.exists.has(b)) : [];
    if (curWip.length) {
        const native = c.chatMetadata?.world_info;
        parts.push(`
            <div class="bm_card">
                <div class="bm_card_title"><i class="fa-solid fa-comments"></i> แชทที่เปิดอยู่เคยผูกผ่าน WorldInfoPlus</div>
                <div class="bm_dim">Chat Lore ของ SillyTavern ผูกได้แชทละ 1 เล่ม ${native ? `ตอนนี้ผูก <b>${escapeHtml(native)}</b> อยู่` : 'ตอนนี้แชทนี้ยังไม่มี Chat Lore'} เลือกเล่มที่จะใช้เป็น Chat Lore</div>
                ${curWip.map((n, i) => `<label class="checkbox_label"><input type="radio" name="bm_wipchat" value="${escapeHtml(n)}" ${(native ? n === native : i === 0) ? 'checked' : ''}> ${escapeHtml(n)}</label>`).join('')}
                ${curWip.length > 1 ? '<div class="bm_dim">เล่มที่เหลือ ถ้าอยากให้ใช้ทุกแชทของการ์ดนี้ ให้เพิ่มเป็นเล่มเสริม (Additional Lorebooks) ของการ์ดแทน</div>' : ''}
                <div class="bm_btns"><div class="menu_button" id="bm_wip_bind"><i class="fa-solid fa-link"></i> ผูกเป็น Chat Lore ของแชทนี้</div></div>
            </div>`);
    }

    // 3) all WIP chat links (so they can be redone by hand)
    const wipEntries = Object.entries(wip?.chatLorebooks ?? {}).filter(([, l]) => Array.isArray(l) && l.length);
    if (wipEntries.length) {
        const rows = wipEntries.map(([id, list]) => {
            const ch = chatScan.fileToChar.get(id);
            return `<div class="bm_mini"><b>${escapeHtml(ch?.name ?? '?')}</b> — ${escapeHtml(id)}<br><span class="bm_dim">${list.map(escapeHtml).join(', ')}</span></div>`;
        }).join('');
        parts.push(`
            <div class="bm_card">
                <details>
                    <summary class="bm_card_title"><i class="fa-solid fa-list"></i> แชทที่ผูกผ่าน WorldInfoPlus (${wipEntries.length} แชท)</summary>
                    <div class="bm_dim">ข้อมูลนี้ยังอยู่ในการตั้งค่า แม้จะถอน WorldInfoPlus ไปแล้ว เปิดแชทไหนแล้วกลับมาที่แท็บนี้ จะผูกเป็น Chat Lore ได้${chatScan.state === 'done' ? '' : ' (ชื่อการ์ดจะขึ้นเมื่อเช็คแชทเสร็จ)'}</div>
                    ${rows}
                    <div class="bm_btns"><div class="menu_button" id="bm_wip_forget" title="ลบข้อมูลการผูกของ WorldInfoPlus ออกจากการตั้งค่า"><i class="fa-solid fa-eraser"></i> ล้างข้อมูล WIP ทั้งหมด</div></div>
                </details>
            </div>`);
    }

    // 4) links to books that don't exist
    if (m.missing.length) {
        parts.push(`
            <div class="bm_card">
                <div class="bm_card_title"><i class="fa-solid fa-link-slash"></i> ลิงก์ไปยังเล่มที่ไม่มีแล้ว (${m.missing.length})</div>
                <div class="bm_dim">เล่มเสริมถอดลิงก์จากตรงนี้ได้ ส่วนเล่มหลักของการ์ดหรือ Chat Lore ให้เปิดการ์ด/แชทนั้นแล้วเลือกเล่มใหม่</div>
                ${m.missing.map((x, i) => `<div class="bm_mini">${escapeHtml(x.where)} → <b>${escapeHtml(x.book)}</b>${x.fix ? ` <span class="bm_link bm_fixmissing" data-i="${i}">ถอดลิงก์</span>` : ''}</div>`).join('')}
            </div>`);
    }

    // 5) charLore entries for deleted characters (only trustworthy once the character list is loaded)
    if (m.staleCharLore.length && characterList().length) {
        parts.push(`
            <div class="bm_card">
                <div class="bm_card_title"><i class="fa-solid fa-user-slash"></i> ข้อมูลเล่มเสริมของการ์ดที่ลบไปแล้ว (${m.staleCharLore.length})</div>
                <div class="bm_dim">ตอนลบการ์ด SillyTavern ไม่ได้ลบรายการเล่มเสริมของการ์ดนั้นในการตั้งค่า ล้างได้โดยไม่กระทบตัว lorebook</div>
                ${m.staleCharLore.map(e => `<div class="bm_mini">${escapeHtml(e.name)} <span class="bm_dim">→ ${(e.extraBooks ?? []).map(escapeHtml).join(', ')}</span></div>`).join('')}
                <div class="bm_btns"><div class="menu_button" id="bm_clean_stale"><i class="fa-solid fa-eraser"></i> ล้าง</div></div>
            </div>`);
    }

    if (!parts.length) parts.push('<div class="bm_empty">ไม่มีลิงก์ค้าง 👍</div>');
    return parts.join('');
}

function wireTools(body) {
    const c = ctx();
    body.querySelector('#bm_wip_unglobal')?.addEventListener('click', () => {
        const names = [...body.querySelectorAll('.bm_wipg:checked')].map(i => i.value);
        if (!names.length) return;
        removeFromGlobal(names);
        host.toast.ok(`ถอด ${names.length} เล่มออกจาก Global แล้ว`);
        host.renderAll();
    });
    body.querySelector('#bm_wip_bind')?.addEventListener('click', async () => {
        const pick = body.querySelector('input[name="bm_wipchat"]:checked')?.value;
        if (!pick) return;
        c.chatMetadata.world_info = pick;
        await c.saveMetadata();
        host.toast.ok(`ผูก "${pick}" เป็น Chat Lore ของแชทนี้แล้ว`);
        host.renderAll();
    });
    body.querySelector('#bm_wip_forget')?.addEventListener('click', () => {
        if (!confirm('ลบข้อมูลการผูกแชทของ WorldInfoPlus ทั้งหมด?\nตัว lorebook ไม่ถูกลบ แต่รายการว่าแชทไหนเคยผูกเล่มไหนจะหายไป')) return;
        const wip = wipSettings();
        if (wip) { wip.chatLorebooks = {}; delete wip.injectedGlobal; }
        c.saveSettingsDebounced();
        host.renderAll();
    });
    body.querySelectorAll('.bm_fixmissing').forEach(el => el.addEventListener('click', () => {
        const x = getModel().missing[Number(el.dataset.i)];
        const entry = world_info?.charLore?.find(e => e.name === x?.fix?.stem);
        if (!entry) return;
        entry.extraBooks = (entry.extraBooks ?? []).filter(b => b !== x.book);
        if (!entry.extraBooks.length) world_info.charLore.splice(world_info.charLore.indexOf(entry), 1);
        c.saveSettingsDebounced();
        host.renderAll();
    }));
    body.querySelector('#bm_clean_stale')?.addEventListener('click', () => {
        const stale = new Set(getModel().staleCharLore);
        world_info.charLore = (world_info.charLore ?? []).filter(e => !stale.has(e));
        c.saveSettingsDebounced();
        host.toast.ok(`ล้างแล้ว ${stale.size} รายการ`);
        host.renderAll();
    });
}

/** Deselect books in the Global World Info selector (goes through SillyTavern's own change handler). */
function removeFromGlobal(names) {
    const drop = new Set(names);
    const $sel = $('#world_info');
    const vals = ($sel.val() || []).filter(v => !drop.has(world_names[Number(v)]));
    $sel.val(vals).trigger('change');
}

// ---------------------------------------------------------------- World Info panel: active book lists
//
// Under "Active World(s) for all chats": the Global books as named chips (on mobile SillyTavern
// shows a native <select> that only says "2 Items"). Below it, "Active World(s) for this chat":
// every book that applies to the chat that's open — Chat Lore, the character's primary and extra
// books (every member in a group), and the persona's book.

/** Books that apply to the chat that's open, with where each comes from. */
function activeForThisChat() {
    const c = ctx();
    /** @type {{book: string, kind: 'chat'|'primary'|'extra'|'persona', who?: string}[]} */
    const out = [];
    if (!c.chatId) return { hasChat: false, items: out, wip: [] };

    const chatBook = c.chatMetadata?.world_info;
    if (typeof chatBook === 'string' && chatBook) out.push({ book: chatBook, kind: 'chat' });

    let members = [];
    if (c.groupId) {
        const group = (c.groups || []).find(g => String(g.id) === String(c.groupId));
        const avatars = new Set(group?.members ?? []);
        members = (c.characters || []).filter(ch => avatars.has(ch.avatar));
    } else if (c.characterId !== undefined && c.characterId !== null && c.characters?.[c.characterId]) {
        members = [c.characters[c.characterId]];
    }
    const many = members.length > 1;
    for (const ch of members) {
        const who = many ? ch.name : undefined;
        const primary = ch.data?.extensions?.world;
        if (primary) out.push({ book: primary, kind: 'primary', who });
        const extra = world_info?.charLore?.find(e => e.name === avatarStem(ch.avatar))?.extraBooks ?? [];
        for (const b of extra) out.push({ book: b, kind: 'extra', who });
    }

    const personaBook = c.powerUserSettings?.persona_description_lorebook;
    if (personaBook) out.push({ book: personaBook, kind: 'persona' });

    const wip = (wipSettings()?.chatLorebooks?.[String(c.chatId)] ?? []).filter(b => b && b !== chatBook);
    return { hasChat: true, items: out, wip };
}

const KIND_LABEL = { chat: 'Chat Lore', primary: 'เล่มหลัก', extra: 'เล่มเสริม', persona: 'Persona' };
const KIND_ICON = { chat: 'fa-comments', primary: 'fa-user', extra: 'fa-user-plus', persona: 'fa-masks-theater' };

function chipHtml(book, { icon = '', label = '', removable = false, removeTitle = '', exists = true } = {}) {
    return `
        <span class="bm_chip ${exists ? '' : 'bm_chip_missing'}" data-book="${escapeHtml(book)}">
            <span class="bm_chip_open" title="${exists ? 'เปิดในตัวแก้ไข' : 'ไม่มีไฟล์ lorebook นี้แล้ว'}">
                ${icon ? `<i class="fa-solid ${icon}"></i>` : ''}
                <span class="bm_chip_name">${escapeHtml(book)}</span>
                ${label ? `<span class="bm_chip_kind">${escapeHtml(label)}</span>` : ''}
            </span>
            ${removable ? `<i class="fa-solid fa-xmark bm_chip_x" title="${escapeHtml(removeTitle)}"></i>` : ''}
        </span>`;
}

let panelTimer = null;
export function renderPanelSoon() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(renderPanel, 60);
}

export function renderPanel() {
    const wiHost = document.getElementById('WIMultiSelector');
    if (!wiHost) return;
    const s = host.settings();
    const old = oldLoreTidyLoaded();
    const exists = new Set(bookNames());

    // --- Global chips (skipped when select2 already shows names, i.e. on desktop)
    let g = document.getElementById('bm_global_chips');
    const usesSelect2 = !!$('#world_info').data('select2');
    if (old || !s.showGlobalChips || usesSelect2) {
        g?.remove();
    } else {
        if (!g) {
            g = document.createElement('div');
            g.id = 'bm_global_chips';
            g.className = 'bm_chips';
            const range = wiHost.querySelector('.range-block-range') ?? wiHost;
            range.after(g);
        }
        const globals = [...(selected_world_info || [])];
        g.innerHTML = globals.length
            ? globals.map(b => chipHtml(b, { removable: true, removeTitle: 'ถอดออกจาก Global', exists: exists.has(b) })).join('')
            : '<span class="bm_chips_empty">ไม่มีเล่มที่เปิดเป็น Global</span>';
        g.querySelectorAll('.bm_chip_x').forEach(x => x.addEventListener('click', e => {
            e.stopPropagation();
            removeFromGlobal([x.closest('.bm_chip').dataset.book]);
            renderPanelSoon();
        }));
        wireChipOpen(g);
    }

    // --- Active World(s) for this chat
    let p = document.getElementById('bm_chat_panel');
    if (old || !s.showChatPanel) {
        p?.remove();
        return;
    }
    if (!p) {
        p = document.createElement('div');
        p.id = 'bm_chat_panel';
        wiHost.appendChild(p);
    }
    const { hasChat, items, wip } = activeForThisChat();
    const chatBook = items.find(i => i.kind === 'chat');
    let body;
    if (!hasChat) {
        body = '<span class="bm_chips_empty">ยังไม่ได้เปิดแชท</span>';
    } else {
        body = items.length
            ? items.map(i => chipHtml(i.book, {
                icon: KIND_ICON[i.kind],
                label: i.who ? `${KIND_LABEL[i.kind]} · ${i.who}` : KIND_LABEL[i.kind],
                removable: i.kind === 'chat',
                removeTitle: 'เลิกผูก Chat Lore กับแชทนี้',
                exists: exists.has(i.book),
            })).join('')
            : '<span class="bm_chips_empty">ไม่มี lorebook ผูกกับแชทนี้ (นอกจาก Global)</span>';
    }
    p.innerHTML = `
        <div class="range-block-title justifyLeft bm_chat_title">
            <small>Active World(s) for this chat</small>
            ${hasChat ? `<span class="bm_chat_bind menu_button fa-solid ${chatBook ? 'fa-pen' : 'fa-link'}" title="${chatBook ? 'เปลี่ยน Chat Lore ของแชทนี้' : 'ผูก Chat Lore กับแชทนี้'}"></span>` : ''}
        </div>
        <div class="bm_chips">${body}</div>
        ${wip.length ? `<div class="bm_chips_note"><i class="fa-solid fa-puzzle-piece"></i> เคยผูกผ่าน WorldInfoPlus: ${wip.map(escapeHtml).join(', ')} · <span class="bm_link bm_goto_tools">ย้ายใน Bulk Manager</span></div>` : ''}`;

    p.querySelector('.bm_chat_bind')?.addEventListener('click', async () => {
        await assignLorebookToChat({ shiftKey: true, altKey: false });
        renderPanelSoon();
    });
    p.querySelector('.bm_chip_x')?.addEventListener('click', async e => {
        e.stopPropagation();
        const c = ctx();
        delete c.chatMetadata.world_info;
        $('.chat_lorebook_button').removeClass('world_set');
        await c.saveMetadata();
        renderPanelSoon();
    });
    p.querySelector('.bm_goto_tools')?.addEventListener('click', () => host.openModal('books', 'tools'));
    wireChipOpen(p);
}

function wireChipOpen(root) {
    root.querySelectorAll('.bm_chip:not(.bm_chip_missing) .bm_chip_open').forEach(el => el.addEventListener('click', () => {
        openWorldInfoEditor(el.closest('.bm_chip').dataset.book);
    }));
}

/** Broom button next to Import in the World Info panel. */
export function injectButton() {
    const mine = document.getElementById('bm_books_btn');
    if (oldLoreTidyLoaded()) { mine?.remove(); return; }
    if (mine) return;
    const anchor = document.getElementById('world_import_button');
    if (!anchor) return;
    const btn = document.createElement('div');
    btn.id = 'bm_books_btn';
    btn.className = 'menu_button fa-solid fa-broom';
    btn.title = 'จัดระเบียบ lorebook (Bulk Manager)';
    btn.addEventListener('click', () => host.openModal('books'));
    anchor.before(btn);
}

// ---------------------------------------------------------------- setup

/**
 * @param {object} h  shared state and helpers from index.js:
 *   ui, toast, busy, setProgress, report, downloadBlob, renderAll, renderSoon, renderBody, renderFoot,
 *   toggleSel, wireRow, openModal, closeModal, settings
 */
export function setupLorebooks(h) {
    host = h;
    injectButton();
    renderPanel();
    const { eventSource, event_types: E } = ctx();
    for (const ev of [E.CHAT_CHANGED, E.WORLDINFO_SETTINGS_UPDATED, E.WORLDINFO_UPDATED, E.SETTINGS_UPDATED,
        E.CHARACTER_EDITED, E.CHARACTER_PAGE_LOADED, E.PERSONA_CHANGED, E.GROUP_UPDATED, E.APP_READY].filter(Boolean)) {
        eventSource.on(ev, renderPanelSoon);
    }
    for (const ev of [E.APP_READY, E.CHARACTER_PAGE_LOADED].filter(Boolean)) eventSource.on(ev, injectButton);
    // Chats or characters changed: the next look at the Lorebook tab rescans chat lore.
    for (const ev of [E.CHAT_CHANGED, E.CHAT_DELETED, E.CHARACTER_DELETED, E.CHARACTER_EDITED, E.CHARACTER_RENAMED].filter(Boolean)) {
        eventSource.on(ev, () => { scanDirty = true; });
    }
    for (const ev of [E.CHARACTER_PAGE_LOADED, E.APP_READY].filter(Boolean)) {
        eventSource.on(ev, () => { if (chatScan.state === 'nochars' && host.ui.tab === 'books' && document.getElementById('bm_modal')) startScan(); });
    }
    $(document).on('change', '#world_info', renderPanelSoon);
    // SillyTavern flips `world_set` on these buttons whenever chat / persona / character lore changes.
    const watch = new MutationObserver(renderPanelSoon);
    const observeButtons = () => {
        document.querySelectorAll('.chat_lorebook_button, #persona_lore_button, #world_button').forEach(el => {
            if (el.dataset.bmWatched) return;
            el.dataset.bmWatched = '1';
            watch.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
    };
    observeButtons();
    // Opening the World Info drawer always shows fresh lists.
    document.getElementById('WIDrawerIcon')?.addEventListener('click', () => { observeButtons(); renderPanelSoon(); });
}

export const loreDebug = { buildModel, scanChats, get chatScan() { return chatScan; } };

/*
 * Bulk Manager — SillyTavern UI extension
 *
 * Select many characters, personas or lorebooks at once, then delete,
 * duplicate or back them up in one go. Deleting always offers a .zip backup first.
 * The Lorebook tab (formerly the Lore Tidy extension) lives in lorebooks.js.
 */

import { deleteCharacter, getCharacters } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatars, getUserAvatar, user_avatar } from '../../../personas.js';
import {
    escapeHtml, fileStamp, safeFileName, uniqueNamer, avatarStem,
    newPersonaId, cloneDescriptor, matchesQuery, makeZip, planCharDelete, chatKey,
} from './lib.js';
import * as lore from './lorebooks.js';

const MODULE = 'bulk_manager';
const LOG = '[BulkManager]';
const VERSION = '2.0.0'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);

const ctx = () => SillyTavern.getContext();
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Bulk Manager'),
    info: m => globalThis.toastr?.info(m, 'Bulk Manager'),
    warn: m => globalThis.toastr?.warning(m, 'Bulk Manager'),
    err: m => globalThis.toastr?.error(m, 'Bulk Manager'),
};

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
}

async function fetchBytes(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
}

const characterUrl = avatar => `/characters/${encodeURIComponent(avatar)}`;
const personaUrl = id => encodeURI(getUserAvatar(id));
const thumbUrl = (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;

// ---------------------------------------------------------------- state

const TABS = ['chars', 'personas', 'books'];

const ui = {
    /** @type {'chars' | 'personas' | 'books'} */
    tab: 'chars',
    /** Lorebook tab view: unused | bychar | all | tools */
    bookView: 'unused',
    query: '',
    sort: 'name',
    selected: { chars: new Set(), personas: new Set(), books: new Set() },
    /** @type {null | 'delete' | 'copy'} */
    confirm: null,
    busy: false,
    progress: '',
    lastClicked: null,
    copySuffix: '',
    delBackup: true,
    /** @type {Map<string, {state: 'loading'|'done'|'error', chats: ChatInfo[]}>} chat lists per character avatar */
    chatInfo: new Map(),
    /** @type {Set<string>} chatKey()s to keep when their character is deleted (default: delete) */
    keepChats: new Set(),
    /** @type {Set<string>} characters whose chat list is open in the list */
    expanded: new Set(),
};

const sel = () => ui.selected[ui.tab];
const unit = () => ({ chars: 'ตัว', personas: 'persona', books: 'เล่ม' }[ui.tab]);

// ---------------------------------------------------------------- character chats

/** @typedef {{file: string, id: string, items: number, size: string, last: number|string, mes: string}} ChatInfo */

/** Read a character's chat list (file, message count, size, last message). Rerenders when done. */
async function loadChats(avatar) {
    const known = ui.chatInfo.get(avatar);
    if (known?.state === 'loading') return;
    ui.chatInfo.set(avatar, { state: 'loading', chats: [] });
    let entry;
    try {
        const res = await postJson('/api/characters/chats', { avatar_url: avatar });
        const list = res.ok ? await res.json() : null;
        if (!res.ok) throw new Error(String(res.status));
        // { error: true } = no chat folder yet, i.e. no chats
        const chats = (Array.isArray(list) ? list : []).filter(c => c?.file_name).map(c => ({
            file: String(c.file_name),
            id: String(c.file_id ?? c.file_name).replace(/\.jsonl$/, ''),
            items: Number(c.chat_items) || 0,
            size: String(c.file_size ?? ''),
            last: c.last_mes ?? 0,
            mes: String(c.mes ?? ''),
        })).sort((a, b) => toTime(b.last) - toTime(a.last));
        entry = { state: 'done', chats };
    } catch (e) {
        console.warn(LOG, 'chat list failed for', avatar, e);
        entry = { state: 'error', chats: [] };
    }
    // Dropped meanwhile (cache cleared): don't resurrect a stale result.
    if (ui.chatInfo.get(avatar)?.state !== 'loading') return;
    ui.chatInfo.set(avatar, entry);
    if (!ui.busy && document.getElementById('bm_modal')) {
        if (ui.tab === 'chars') renderBody();
        renderFoot();
    }
}

function toTime(v) {
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v ?? ''));
    return Number.isNaN(t) ? 0 : t;
}

function chatMeta(c) {
    const t = toTime(c.last);
    const when = t ? new Date(t).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return [`${c.items} ข้อความ`, c.size, when].filter(Boolean).join(' · ');
}

/** Chat list shown under a character row in the list. */
function chatListHtml(avatar) {
    const info = ui.chatInfo.get(avatar);
    let inner;
    if (!info || info.state === 'loading') inner = '<div class="bm_dim"><i class="fa-solid fa-spinner fa-spin"></i> กำลังอ่านรายชื่อแชท…</div>';
    else if (info.state === 'error') inner = '<div class="bm_warn">อ่านรายชื่อแชทไม่ได้</div>';
    else if (!info.chats.length) inner = '<div class="bm_dim">ยังไม่มีแชท</div>';
    else {
        inner = info.chats.map(c => `
            <div class="bm_chat" title="${escapeHtml(c.mes)}">
                <i class="fa-regular fa-comment"></i>
                <div class="bm_chat_main"><div class="bm_chat_name">${escapeHtml(c.id)}</div><div class="bm_sub">${escapeHtml(chatMeta(c))}</div></div>
            </div>`).join('');
    }
    return `<div class="bm_chatlist" data-avatar="${escapeHtml(avatar)}">${inner}</div>`;
}

/** Drop cached chat lists (chats were added, removed or renamed somewhere). */
function forgetChats() {
    ui.chatInfo.clear();
    renderSoon();
}

// ---------------------------------------------------------------- rows

function currentCharAvatar() {
    const c = ctx();
    const chid = c.characterId;
    return chid !== undefined && chid !== null ? c.characters?.[chid]?.avatar ?? null : null;
}

function charRows() {
    const c = ctx();
    const current = currentCharAvatar();
    const groups = Array.isArray(c.groups) ? c.groups : [];
    const rows = (c.characters ?? []).filter(ch => ch?.avatar).map(ch => {
        const inGroups = groups.filter(g => g?.members?.includes(ch.avatar)).map(g => g.name);
        return {
            key: ch.avatar,
            name: String(ch.name ?? ''),
            sub: ch.avatar,
            thumb: thumbUrl('avatar', ch.avatar),
            added: Number(ch.date_added) || 0,
            current: ch.avatar === current,
            fav: ch.fav === true || ch.fav === 'true',
            inGroups,
        };
    });
    if (ui.sort === 'added') rows.sort((a, b) => b.added - a.added || collator.compare(a.name, b.name));
    else rows.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
    return rows;
}

function personaRows() {
    const names = power_user.personas ?? {};
    const descs = power_user.persona_descriptions ?? {};
    const locked = ctx().chatMetadata?.persona;
    return Object.keys(names).map(id => {
        const d = descs[id] ?? {};
        return {
            key: id,
            name: String(names[id] ?? ''),
            sub: d.title ? `${d.title} · ${id}` : id,
            thumb: thumbUrl('persona', id),
            current: id === user_avatar,
            isDefault: id === power_user.default_persona,
            locked: id === locked,
            connections: Array.isArray(d.connections) ? d.connections.length : 0,
        };
    }).sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
}

const allRows = () => (ui.tab === 'chars' ? charRows() : ui.tab === 'personas' ? personaRows() : []);
const visibleRows = () => allRows().filter(r => matchesQuery(ui.query, r.name, r.sub));

/** Drop selections whose item no longer exists (deleted elsewhere, etc.). Lorebooks: see lore.refreshModel. */
function pruneSelection() {
    for (const tab of ['chars', 'personas']) {
        const keys = new Set((tab === 'chars' ? charRows() : personaRows()).map(r => r.key));
        for (const k of ui.selected[tab]) if (!keys.has(k)) ui.selected[tab].delete(k);
    }
}

function chatsButtonHtml(avatar) {
    const info = ui.chatInfo.get(avatar);
    const n = info?.state === 'done' ? ` ${info.chats.length}` : '';
    const open = ui.expanded.has(avatar);
    return `<div class="menu_button bm_chats_btn ${open ? 'bm_active' : ''}" title="${open ? 'ซ่อนแชท' : 'ดูแชทของบอทนี้'}"><i class="fa-solid fa-comments"></i>${n}</div>`;
}

function badgesHtml(r) {
    const b = [];
    if (r.current) b.push(`<span class="bm_badge bm_b_current">${ui.tab === 'chars' ? '💬 แชทอยู่' : '🎭 ใช้อยู่'}</span>`);
    if (r.fav) b.push('<span class="bm_badge">⭐ Favorite</span>');
    if (r.inGroups?.length) b.push(`<span class="bm_badge" title="${escapeHtml(r.inGroups.join(', '))}">👥 อยู่ใน ${r.inGroups.length} กลุ่ม</span>`);
    if (r.isDefault) b.push('<span class="bm_badge">👑 Default</span>');
    if (r.locked) b.push('<span class="bm_badge">🔒 ล็อกกับแชทนี้</span>');
    if (r.connections) b.push(`<span class="bm_badge">🔗 ผูกกับ ${r.connections} การ์ด</span>`);
    return b.length ? `<div class="bm_badges">${b.join('')}</div>` : '';
}

// ---------------------------------------------------------------- modal

function openModal(tab, bookView) {
    if (TABS.includes(tab)) ui.tab = tab;
    if (bookView) ui.bookView = bookView;
    const old = document.getElementById('bm_modal');
    if (old) old._bmClose?.();

    const wrap = document.createElement('div');
    wrap.id = 'bm_modal';
    wrap.innerHTML = `
        <div class="bm_dialog" role="dialog" aria-label="Bulk Manager">
            <div class="bm_head">
                <b class="bm_title"><i class="fa-solid fa-layer-group"></i> Bulk Manager</b>
                <div class="bm_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div class="bm_tabs" role="tablist"></div>
            <div class="bm_tools">
                <input id="bm_search" class="text_pole" type="search">
                <select id="bm_sort" class="text_pole" title="เรียงตาม">
                    <option value="name">ชื่อ A→Z</option>
                    <option value="added">เพิ่มล่าสุด</option>
                </select>
            </div>
            <div class="bm_subtabs" role="tablist"></div>
            <div class="bm_status"></div>
            <div class="bm_body"></div>
            <div class="bm_foot"></div>
        </div>`;
    document.body.appendChild(wrap);

    const vv = window.visualViewport;
    const fit = () => {
        wrap.style.top = `${vv ? vv.offsetTop : 0}px`;
        wrap.style.left = `${vv ? vv.offsetLeft : 0}px`;
        wrap.style.width = `${vv ? vv.width : window.innerWidth}px`;
        wrap.style.height = `${vv ? vv.height : window.innerHeight}px`;
    };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    const onKey = e => { if (e.key === 'Escape' && !ui.busy) close(); };
    document.addEventListener('keydown', onKey);
    function close() {
        vv?.removeEventListener('resize', fit);
        vv?.removeEventListener('scroll', fit);
        window.removeEventListener('resize', fit);
        document.removeEventListener('keydown', onKey);
        wrap.remove();
    }
    wrap._bmClose = close;
    wrap.addEventListener('click', e => { if (e.target === wrap && !ui.busy) close(); });
    wrap.querySelector('.bm_close').addEventListener('click', () => { if (!ui.busy) close(); });

    const search = wrap.querySelector('#bm_search');
    search.value = ui.query;
    search.addEventListener('input', () => { ui.query = search.value; ui.lastClicked = null; renderBody(); });
    const sort = wrap.querySelector('#bm_sort');
    sort.value = ui.sort;
    sort.addEventListener('change', () => { ui.sort = sort.value; ui.lastClicked = null; renderBody(); });

    ui.confirm = null;
    renderAll();
    if (ui.tab === 'books') lore.onShow();
}

const closeModal = () => document.getElementById('bm_modal')?._bmClose?.();

function renderAll() {
    if (!document.getElementById('bm_modal')) return;
    pruneSelection();
    lore.refreshModel();
    renderTabs();
    renderBody();
    renderFoot();
}

let renderSoonPending = false;
function renderSoon() {
    if (renderSoonPending || ui.busy || !document.getElementById('bm_modal')) return;
    renderSoonPending = true;
    requestAnimationFrame(() => { renderSoonPending = false; if (!ui.busy) renderAll(); });
}

function renderTabs() {
    const el = document.querySelector('#bm_modal .bm_tabs');
    if (!el) return;
    const tabs = [
        ['chars', 'fa-user', 'บอท', (ctx().characters ?? []).length],
        ['personas', 'fa-masks-theater', 'Persona', Object.keys(power_user.personas ?? {}).length],
        ['books', 'fa-book-atlas', 'Lorebook', lore.bookNames().length],
    ];
    el.innerHTML = tabs.map(([id, icon, label, n]) => {
        const s = ui.selected[id].size;
        return `<div class="menu_button bm_tab ${ui.tab === id ? 'bm_active' : ''}" data-tab="${id}" role="tab">
            <i class="fa-solid ${icon}"></i> ${label} <span class="bm_dim">(${s ? `${s}/` : ''}${n})</span></div>`;
    }).join('');
    el.querySelectorAll('.bm_tab').forEach(t => t.addEventListener('click', () => {
        if (ui.busy || ui.tab === t.dataset.tab) return;
        ui.tab = t.dataset.tab;
        ui.confirm = null;
        ui.lastClicked = null;
        renderAll();
        if (ui.tab === 'books') lore.onShow();
    }));
    const sort = document.getElementById('bm_sort');
    if (sort) sort.style.display = ui.tab === 'chars' ? '' : 'none';
    const search = document.getElementById('bm_search');
    if (search) search.placeholder = ui.tab === 'books' ? 'ค้นหาชื่อเล่ม / การ์ด' : 'ค้นหาชื่อ / ไฟล์';
    const sub = document.querySelector('#bm_modal .bm_subtabs');
    const status = document.querySelector('#bm_modal .bm_status');
    if (ui.tab === 'books') {
        lore.renderSubtabs(sub);
        lore.renderStatus(status);
    } else {
        sub.innerHTML = '';
        status.innerHTML = '';
    }
}

function renderBody() {
    const body = document.querySelector('#bm_modal .bm_body');
    if (!body) return;
    if (ui.tab === 'books') {
        lore.renderBody(body);
        return;
    }
    const rows = visibleRows();
    const s = sel();
    let html;
    if (!rows.length) {
        html = ui.query
            ? '<div class="bm_empty">ไม่พบรายการที่ตรงกับคำค้น</div>'
            : `<div class="bm_empty">ยังไม่มี${ui.tab === 'chars' ? 'บอท' : ' persona'}</div>`;
    } else {
        const allSel = rows.every(r => s.has(r.key));
        html = `<div class="bm_listhead">
                <label class="checkbox_label"><input type="checkbox" class="bm_allcb" ${allSel ? 'checked' : ''}> เลือกทั้งหมดที่แสดง (${rows.length})</label>
                <span class="bm_dim bm_hint">คอม: กด Shift ค้างเพื่อเลือกเป็นช่วง</span>
            </div>`
            + rows.map(r => `
            <div class="bm_row ${s.has(r.key) ? 'bm_sel' : ''}" data-key="${escapeHtml(r.key)}">
                <input type="checkbox" class="bm_cb" ${s.has(r.key) ? 'checked' : ''}>
                <img class="bm_avatar" loading="lazy" src="${escapeHtml(r.thumb)}" alt="">
                <div class="bm_main">
                    <div class="bm_name">${escapeHtml(r.name) || '<i class="bm_dim">(ไม่มีชื่อ)</i>'}</div>
                    <div class="bm_sub">${escapeHtml(r.sub)}</div>
                    ${badgesHtml(r)}
                </div>
                ${ui.tab === 'chars' ? chatsButtonHtml(r.key) : ''}
            </div>${ui.tab === 'chars' && ui.expanded.has(r.key) ? chatListHtml(r.key) : ''}`).join('');
    }
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;

    const keys = rows.map(r => r.key);
    body.querySelectorAll('.bm_row').forEach((row, i) => wireRow(row, keys[i], keys));
    body.querySelectorAll('.bm_chats_btn').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const avatar = btn.closest('.bm_row').dataset.key;
        if (ui.expanded.has(avatar)) ui.expanded.delete(avatar);
        else {
            ui.expanded.add(avatar);
            if (ui.chatInfo.get(avatar)?.state !== 'done') loadChats(avatar);
        }
        renderBody();
    }));
    for (const avatar of ui.expanded) if (!ui.chatInfo.has(avatar) && keys.includes(avatar)) loadChats(avatar);
    body.querySelector('.bm_allcb')?.addEventListener('change', e => toggleSel(keys, e.target.checked));
}

/**
 * Tap the row or its checkbox to toggle; Shift-click selects a range.
 * `keys` is the list in display order (null where ranges make no sense, e.g. grouped lists).
 */
function wireRow(row, key, keys) {
    const onPick = (e, on) => {
        if (e.shiftKey && keys && ui.lastClicked !== null && keys.includes(ui.lastClicked)) {
            const a = keys.indexOf(ui.lastClicked);
            const i = keys.indexOf(key);
            const [lo, hi] = a < i ? [a, i] : [i, a];
            toggleSel(keys.slice(lo, hi + 1), on);
        } else {
            toggleSel([key], on);
        }
        ui.lastClicked = key;
    };
    const cb = row.querySelector('.bm_cb');
    cb.addEventListener('click', e => { e.stopPropagation(); onPick(e, cb.checked); });
    row.addEventListener('click', e => onPick(e, !sel().has(key)));
}

function toggleSel(keys, on) {
    if (ui.busy) return;
    const s = sel();
    for (const k of keys) on ? s.add(k) : s.delete(k);
    ui.confirm = null;
    renderTabs();
    renderBody();
    renderFoot();
}

// ---------------------------------------------------------------- footer

function renderFoot() {
    const foot = document.querySelector('#bm_modal .bm_foot');
    if (!foot) return;
    const rowsByKey = new Map(allRows().map(r => [r.key, r]));
    const picked = [...sel()].map(k => rowsByKey.get(k)).filter(Boolean)
        .sort((a, b) => collator.compare(a.name, b.name));
    const n = picked.length;

    if (ui.busy) {
        foot.innerHTML = `<div class="bm_progress"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(ui.progress)}</div>`;
        return;
    }
    if (ui.tab === 'books') {
        lore.renderFoot(foot);
        return;
    }

    const nameList = picked.map(r => escapeHtml(r.name || r.key)).join(' · ');

    if (ui.confirm === 'delete') {
        const isChars = ui.tab === 'chars';
        const kept = isChars ? [] : picked.filter(r => r.current);
        const targets = picked.filter(r => !kept.includes(r));
        const loading = isChars && targets.some(r => {
            const info = ui.chatInfo.get(r.key);
            if (!info) loadChats(r.key);
            return !info || info.state === 'loading';
        });
        const warns = [];
        if (isChars) {
            warns.push('แชทที่เปิดอยู่ตอนนี้จะถูกปิดก่อนลบ (แบบเดียวกับตอนลบใน SillyTavern เอง)');
            const grouped = targets.filter(r => r.inGroups.length);
            if (grouped.length) warns.push(`${grouped.length} ตัวอยู่ในแชทกลุ่ม: ${grouped.map(r => escapeHtml(r.name)).join(', ')}`);
            const books = lore.booksOfCharacters(targets.map(r => r.key));
            if (books.length) warns.push(`lorebook ของบอทเหล่านี้ไม่ถูกลบไปด้วย (${books.map(escapeHtml).join(', ')}) ลบบอทเสร็จแล้วไปเก็บกวาดได้ที่แท็บ Lorebook › ไม่มีใครใช้`);
        } else {
            if (kept.length) warns.push(`ข้าม <b>${escapeHtml(kept[0].name)}</b> เพราะเป็น persona ที่ใช้อยู่ สลับไปใช้ตัวอื่นก่อนถ้าจะลบ`);
            const def = targets.find(r => r.isDefault);
            if (def) warns.push(`${escapeHtml(def.name)} เป็น default persona ลบแล้วต้องตั้ง default ใหม่`);
        }
        foot.innerHTML = `
            <div class="bm_confirm">
                <div><b>ลบ ${targets.length} ${unit()}?</b> ลบแล้วกู้คืนจากเซิร์ฟเวอร์ไม่ได้</div>
                <div class="bm_confirm_list">${targets.map(r => escapeHtml(r.name || r.key)).join(' · ')}</div>
                ${warns.map(w => `<div class="bm_warn"><i class="fa-solid fa-triangle-exclamation"></i> ${w}</div>`).join('')}
                ${isChars ? chatPickHtml(targets) : ''}
                <label class="checkbox_label"><input type="checkbox" id="bm_do_backup" ${ui.delBackup ? 'checked' : ''}> ดาวน์โหลดไฟล์สำรอง (.zip) ก่อนลบ${isChars ? ' (การ์ด + แชทที่จะลบ)' : ''}</label>
                <div class="bm_btns">
                    <div class="menu_button bm_cancel">ยกเลิก</div>
                    <div class="menu_button redWarningBG bm_go ${targets.length && !loading ? '' : 'disabled'}"><i class="fa-solid fa-trash-can"></i> ลบ ${targets.length} ${unit()}</div>
                </div>
            </div>`;
        const pick = foot.querySelector('.bm_chatpick');
        if (pick) {
            pick.scrollTop = chatPickScroll;
            pick.addEventListener('scroll', () => { chatPickScroll = pick.scrollTop; });
            wireChatPick(foot, targets.map(r => r.key));
        }
        const backupCb = foot.querySelector('#bm_do_backup');
        backupCb.addEventListener('change', () => { ui.delBackup = backupCb.checked; });
        foot.querySelector('.bm_cancel').addEventListener('click', () => { ui.confirm = null; renderFoot(); });
        foot.querySelector('.bm_go').addEventListener('click', () => {
            if (!targets.length || loading) return;
            const keys = targets.map(r => r.key);
            if (isChars) doDeleteChars(keys, ui.delBackup);
            else doDeletePersonas(keys, ui.delBackup);
        });
        return;
    }

    if (ui.confirm === 'copy') {
        const what = ui.tab === 'chars' ? '{{char}}' : '{{user}}';
        foot.innerHTML = `
            <div class="bm_confirm">
                <div><b>คัดลอก ${n} ${unit()}?</b></div>
                <div class="bm_confirm_list">${nameList}</div>
                <label class="bm_field">ต่อท้ายชื่อสำเนา
                    <input type="text" id="bm_suffix" class="text_pole" placeholder="เว้นว่าง = ใช้ชื่อเดิม เช่น  (สำเนา)">
                </label>
                <small class="bm_dim">ชื่อนี้คือ ${what} ที่ส่งเข้า prompt ด้วย ถ้าเว้นว่างไว้ สำเนาจะชื่อเหมือนต้นฉบับ ดูความต่างได้จากชื่อไฟล์${ui.tab === 'personas' ? ' · สำเนาจะไม่ได้ผูกกับการ์ดที่ต้นฉบับผูกไว้' : ''}</small>
                <div class="bm_btns">
                    <div class="menu_button bm_cancel">ยกเลิก</div>
                    <div class="menu_button bm_go"><i class="fa-solid fa-clone"></i> คัดลอก ${n} ${unit()}</div>
                </div>
            </div>`;
        const suffix = foot.querySelector('#bm_suffix');
        suffix.value = ui.copySuffix;
        suffix.addEventListener('input', () => { ui.copySuffix = suffix.value; });
        foot.querySelector('.bm_cancel').addEventListener('click', () => { ui.confirm = null; renderFoot(); });
        foot.querySelector('.bm_go').addEventListener('click', () => {
            const keys = picked.map(r => r.key);
            if (ui.tab === 'chars') doCopyChars(keys, suffix.value);
            else doCopyPersonas(keys, suffix.value);
        });
        return;
    }

    const dis = n ? '' : 'disabled';
    foot.innerHTML = `
        <div class="bm_selinfo">เลือกไว้ ${n} ${unit()}${n ? ' <span class="bm_link bm_clear">ล้าง</span>' : ''}</div>
        <div class="bm_btns">
            <div class="menu_button bm_copy ${dis}" title="ทำสำเนาทุกรายการที่เลือก"><i class="fa-solid fa-clone"></i> คัดลอก</div>
            <div class="menu_button bm_backup ${dis}" title="ดาวน์โหลดรายการที่เลือกเป็น .zip โดยไม่ลบ"><i class="fa-solid fa-file-zipper"></i> สำรอง</div>
            <div class="menu_button redWarningBG bm_delete ${dis}"><i class="fa-solid fa-trash-can"></i> ลบ</div>
        </div>`;
    foot.querySelector('.bm_clear')?.addEventListener('click', () => toggleSel([...sel()], false));
    foot.querySelector('.bm_copy').addEventListener('click', () => { if (n) { ui.confirm = 'copy'; renderFoot(); } });
    foot.querySelector('.bm_delete').addEventListener('click', () => {
        if (!n) return;
        // Fresh chat lists for the confirm step; what to keep starts from "delete everything" each time.
        if (ui.tab === 'chars') {
            for (const r of picked) ui.chatInfo.delete(r.key);
            ui.keepChats.clear();
            chatPickScroll = 0;
        }
        ui.delBackup = true;
        ui.confirm = 'delete';
        renderFoot();
    });
    foot.querySelector('.bm_backup').addEventListener('click', () => {
        if (!n) return;
        const keys = picked.map(r => r.key);
        const tab = ui.tab;
        busy('กำลังเตรียมไฟล์สำรอง…', async () => {
            if (tab === 'chars') await backupChars(keys, true);
            else await backupPersonas(keys);
            toast.ok(`สำรอง ${keys.length} ${tab === 'chars' ? 'ตัว' : 'persona'} แล้ว`);
        });
    });
}

// ---------------------------------------------------------------- delete confirm: pick chats to keep

let chatPickScroll = 0;

/** Per-bot chat list in the delete confirm. Ticked = delete with the bot, unticked = keep the file. */
function chatPickHtml(targets) {
    const avatars = targets.map(r => r.key);
    const plan = planCharDelete(avatars, ui.chatInfo, ui.keepChats);
    const sections = targets.map(r => {
        const info = ui.chatInfo.get(r.key);
        const name = escapeHtml(r.name || r.key);
        if (!info || info.state === 'loading') {
            return `<div class="bm_cp_bot"><div class="bm_cp_head"><b>${name}</b> <span class="bm_dim"><i class="fa-solid fa-spinner fa-spin"></i> กำลังอ่านรายชื่อแชท…</span></div></div>`;
        }
        if (info.state === 'error') {
            const del = !ui.keepChats.has(chatKey(r.key, '*'));
            return `<div class="bm_cp_bot"><div class="bm_cp_head">
                    <label class="checkbox_label"><input type="checkbox" class="bm_cp_all" data-avatar="${escapeHtml(r.key)}" ${del ? 'checked' : ''}> <b>${name}</b></label>
                    <span class="bm_warn">อ่านรายชื่อแชทไม่ได้ · ${del ? 'ลบแชททั้งหมดของบอทนี้' : 'เก็บแชทไว้ทั้งหมด'}</span></div></div>`;
        }
        if (!info.chats.length) return `<div class="bm_cp_bot"><div class="bm_cp_head"><b>${name}</b> <span class="bm_dim">ไม่มีแชท</span></div></div>`;
        const dels = info.chats.filter(c => !ui.keepChats.has(chatKey(r.key, c.file))).length;
        const all = dels === info.chats.length;
        return `<div class="bm_cp_bot">
                <div class="bm_cp_head">
                    <label class="checkbox_label"><input type="checkbox" class="bm_cp_all" data-avatar="${escapeHtml(r.key)}" ${all ? 'checked' : ''} ${dels && !all ? 'data-mixed="1"' : ''}> <b>${name}</b></label>
                    <span class="bm_dim">${info.chats.length} แชท · ลบ ${dels} · เก็บ ${info.chats.length - dels}</span>
                </div>
                ${info.chats.map(c => {
                    const del = !ui.keepChats.has(chatKey(r.key, c.file));
                    return `<label class="bm_chat bm_cp_chat ${del ? '' : 'bm_kept'}" title="${escapeHtml(c.mes)}">
                        <input type="checkbox" class="bm_cp_cb" data-avatar="${escapeHtml(r.key)}" data-file="${escapeHtml(c.file)}" ${del ? 'checked' : ''}>
                        <div class="bm_chat_main"><div class="bm_chat_name">${escapeHtml(c.id)}</div><div class="bm_sub">${escapeHtml(chatMeta(c))}</div></div>
                        <span class="bm_cp_tag">${del ? 'ลบ' : 'เก็บ'}</span>
                    </label>`;
                }).join('')}
            </div>`;
    }).join('');
    const kept = plan.keptCount + plan.partial.filter(a => ui.chatInfo.get(a)?.state === 'error').length;
    return `
        <div class="bm_cp_title">
            <b><i class="fa-solid fa-comments"></i> แชทของบอทเหล่านี้</b> <span class="bm_dim">ติ๊ก = ลบไปกับบอท · ไม่ติ๊ก = เก็บไฟล์แชทไว้</span>
            <span class="bm_cp_quick"><span class="bm_link bm_cp_delall">ลบทั้งหมด</span> · <span class="bm_link bm_cp_keepall">เก็บทั้งหมด</span></span>
        </div>
        <div class="bm_chatpick">${sections}</div>
        ${kept ? `<small class="bm_dim">แชทที่เก็บไว้ยังอยู่ในโฟลเดอร์ <code>chats/&lt;ชื่อไฟล์บอท&gt;</code> ถ้านำเข้าการ์ดชื่อไฟล์เดิมกลับมา แชทจะกลับมาให้เปิดได้ (ถ้าไม่ได้ใช้แล้ว ติ๊กสำรองไว้แล้วลบไปเลยก็ได้)</small>` : ''}`;
}

function wireChatPick(foot, avatars) {
    const setKeep = (key, keep) => (keep ? ui.keepChats.add(key) : ui.keepChats.delete(key));
    foot.querySelectorAll('.bm_cp_cb').forEach(cb => cb.addEventListener('change', () => {
        setKeep(chatKey(cb.dataset.avatar, cb.dataset.file), !cb.checked);
        renderFoot();
    }));
    foot.querySelectorAll('.bm_cp_all').forEach(cb => {
        if (cb.dataset.mixed) cb.indeterminate = true;
        cb.addEventListener('change', () => {
            const avatar = cb.dataset.avatar;
            const info = ui.chatInfo.get(avatar);
            const files = info?.state === 'done' ? info.chats.map(c => c.file) : ['*'];
            for (const f of files) setKeep(chatKey(avatar, f), !cb.checked);
            renderFoot();
        });
    });
    const all = keep => {
        for (const avatar of avatars) {
            const info = ui.chatInfo.get(avatar);
            const files = info?.state === 'done' ? info.chats.map(c => c.file) : ['*'];
            for (const f of files) setKeep(chatKey(avatar, f), keep);
        }
        renderFoot();
    };
    foot.querySelector('.bm_cp_delall')?.addEventListener('click', () => all(false));
    foot.querySelector('.bm_cp_keepall')?.addEventListener('click', () => all(true));
}

function setProgress(text) {
    ui.progress = text;
    const el = document.querySelector('#bm_modal .bm_progress');
    if (el) el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(text)}`;
}

async function busy(label, fn) {
    ui.busy = true;
    ui.progress = label;
    const modal = document.getElementById('bm_modal');
    modal?.classList.add('bm_busy');
    renderFoot();
    try {
        await fn();
    } catch (e) {
        console.error(LOG, e);
        toast.err(String(e?.message ?? e));
    } finally {
        ui.busy = false;
        ui.progress = '';
        document.getElementById('bm_modal')?.classList.remove('bm_busy');
        renderAll();
    }
}

// SillyTavern sets toastr escapeHtml on, so plain text is safe here.
function report(verb, done, failed, unitName) {
    if (done) toast.ok(`${verb}แล้ว ${done} ${unitName}`);
    if (failed.length) toast.err(`${verb}ไม่สำเร็จ ${failed.length} ${unitName}: ${failed.join(', ')}`);
}

// ---------------------------------------------------------------- characters

/**
 * Download cards (raw .png, re-importable) and optionally their chats as one .zip. Throws if anything can't be read.
 * @param {boolean | ((avatar: string, file: string) => boolean)} withChats true = every chat, or a filter
 */
async function backupChars(avatars, withChats) {
    const files = [];
    const cardName = uniqueNamer();
    for (const [i, avatar] of avatars.entries()) {
        setProgress(`กำลังอ่านการ์ด ${i + 1}/${avatars.length}…`);
        let data;
        try { data = await fetchBytes(characterUrl(avatar)); } catch (e) {
            throw new Error(`อ่านการ์ด "${avatar}" ไม่ได้ (${e.message}) เลยยังไม่ทำอะไร`);
        }
        files.push({ name: `characters/${cardName(safeFileName(avatar, 'card.png'))}`, data });

        if (!withChats) continue;
        const res = await postJson('/api/characters/chats', { avatar_url: avatar, simple: true });
        const list = res.ok ? await res.json() : null;
        if (!Array.isArray(list)) continue; // no chat folder
        const folder = `chats/${safeFileName(avatarStem(avatar), 'chats')}`;
        for (const chat of list) {
            const file = String(chat?.file_name ?? '');
            if (!file || (typeof withChats === 'function' && !withChats(avatar, file))) continue;
            const r = await postJson('/api/chats/export', { file, avatar_url: avatar, format: 'jsonl', exportfilename: file, is_group: false });
            const json = r.ok ? await r.json().catch(() => null) : null;
            if (typeof json?.result !== 'string') throw new Error(`อ่านแชท "${file}" ของ ${avatar} ไม่ได้ เลยยังไม่ทำอะไร`);
            files.push({ name: `${folder}/${safeFileName(file, 'chat.jsonl')}`, data: new TextEncoder().encode(json.result) });
        }
    }
    downloadBlob(makeZip(files), `characters-backup ${fileStamp()}.zip`);
}

async function doDeleteChars(avatars, withBackup) {
    await busy('กำลังลบ…', async () => {
        const plan = planCharDelete(avatars, ui.chatInfo, ui.keepChats);
        const fullSet = new Set(plan.full);
        const dropSet = new Set(plan.chatDeletes.map(d => chatKey(d.avatar, d.file)));
        // Bots whose chat list couldn't be read but were set to "keep": counted apart (number of files unknown).
        const keptUnknown = plan.partial.filter(a => ui.chatInfo.get(a)?.state !== 'done');
        if (withBackup) await backupChars(avatars, (a, f) => fullSet.has(a) || dropSet.has(chatKey(a, f)));
        setProgress(`กำลังลบ ${avatars.length} ตัว…`);
        // SillyTavern's own delete: closes the open chat once, cleans tags and
        // per-card warnings, fires CHARACTER_DELETED, then reloads the list.
        // Chats are all-or-nothing per call, so bots that keep some chats go in a second call.
        let ok = false;
        if (plan.full.length) ok = (await deleteCharacter(plan.full, { deleteChats: true })) !== false || ok;
        if (plan.partial.length) ok = (await deleteCharacter(plan.partial, { deleteChats: false })) !== false || ok;
        const left = new Set((ctx().characters ?? []).map(c => c.avatar));
        const failed = avatars.filter(a => left.has(a));
        if (!ok && failed.length === avatars.length) {
            toast.info('ยกเลิกแล้ว ยังไม่ได้ลบอะไร');
            return;
        }
        // Bot is gone, its chat folder stays: now remove the chats that weren't kept.
        const chatFails = [];
        const todo = plan.chatDeletes.filter(d => !left.has(d.avatar));
        const { eventSource, event_types: E } = ctx();
        for (const [i, d] of todo.entries()) {
            setProgress(`กำลังลบแชท ${i + 1}/${todo.length}…`);
            const res = await postJson('/api/chats/delete', { chatfile: d.file, avatar_url: d.avatar });
            if (res.ok) await eventSource.emit(E.CHAT_DELETED, d.file.replace(/\.jsonl$/, ''));
            else chatFails.push(d.file);
        }
        report('ลบ', avatars.length - failed.length, failed, 'ตัว');
        if (chatFails.length) toast.err(`ลบแชทไม่สำเร็จ ${chatFails.length} ไฟล์: ${chatFails.join(', ')}`);
        if (plan.keptCount) toast.info(`เก็บไฟล์แชทไว้ ${plan.keptCount} ไฟล์ ในโฟลเดอร์ chats`);
        const unknown = keptUnknown.filter(a => !left.has(a));
        if (unknown.length) toast.info(`เก็บแชททั้งหมดของ ${unknown.length} ตัวไว้ในโฟลเดอร์ chats`);
        for (const a of avatars) if (!left.has(a)) { ui.selected.chars.delete(a); ui.expanded.delete(a); ui.chatInfo.delete(a); }
        ui.confirm = null;
    });
}

async function doCopyChars(avatars, suffix) {
    await busy('กำลังคัดลอก…', async () => {
        const { eventSource, event_types: E } = ctx();
        const byAvatar = new Map((ctx().characters ?? []).map(c => [c.avatar, c]));
        const failed = [];
        const made = [];
        for (const [i, avatar] of avatars.entries()) {
            const name = String(byAvatar.get(avatar)?.name ?? avatar);
            setProgress(`กำลังคัดลอก ${i + 1}/${avatars.length}: ${name}`);
            try {
                const res = await postJson('/api/characters/duplicate', { avatar_url: avatar });
                const data = res.ok ? await res.json() : null;
                if (!data?.path) throw new Error(res.ok ? 'no path' : `${res.status}`);
                // Lets tags.js copy the original's tags to the new card.
                await eventSource.emit(E.CHARACTER_DUPLICATED, { oldAvatar: avatar, newAvatar: data.path });
                if (suffix) {
                    const newName = name + suffix;
                    const r = await postJson('/api/characters/merge-attributes', { avatar: data.path, name: newName, data: { name: newName } });
                    if (!r.ok) toast.warn(`คัดลอก ${name} แล้ว แต่เปลี่ยนชื่อสำเนาไม่ได้`);
                }
                made.push(data.path);
            } catch (e) {
                console.error(LOG, 'duplicate failed', avatar, e);
                failed.push(name);
            }
        }
        setProgress('กำลังโหลดรายชื่อใหม่…');
        await getCharacters();
        report('คัดลอก', made.length, failed, 'ตัว');
        // Select the new copies, so they are easy to find or undo.
        if (made.length) {
            ui.selected.chars.clear();
            for (const p of made) ui.selected.chars.add(p);
        }
        ui.confirm = null;
    });
}

// ---------------------------------------------------------------- personas

/** personas.json (restorable with Persona Management → Restore) plus the avatar images. */
async function backupPersonas(ids) {
    const names = power_user.personas ?? {};
    const descs = power_user.persona_descriptions ?? {};
    const json = { personas: {}, persona_descriptions: {}, default_persona: null };
    const files = [];
    const missing = [];
    for (const [i, id] of ids.entries()) {
        setProgress(`กำลังอ่านรูป persona ${i + 1}/${ids.length}…`);
        json.personas[id] = names[id];
        if (descs[id]) json.persona_descriptions[id] = descs[id];
        if (id === power_user.default_persona) json.default_persona = id;
        try {
            files.push({ name: `User Avatars/${safeFileName(id, 'avatar.png')}`, data: await fetchBytes(personaUrl(id)) });
        } catch {
            missing.push(names[id] || id);
        }
    }
    files.unshift({ name: 'personas.json', data: new TextEncoder().encode(JSON.stringify(json, null, 2)) });
    downloadBlob(makeZip(files), `personas-backup ${fileStamp()}.zip`);
    if (missing.length) toast.warn(`ไม่มีไฟล์รูปของ: ${missing.join(', ')} (ข้อมูลอื่นสำรองไว้แล้ว)`);
}

async function doDeletePersonas(ids, withBackup) {
    ids = ids.filter(id => id !== user_avatar);
    await busy('กำลังลบ…', async () => {
        if (withBackup) await backupPersonas(ids);
        const { eventSource, event_types: E, chatMetadata, saveMetadata, saveSettingsDebounced } = ctx();
        const failed = [];
        let done = 0;
        let metaChanged = false;
        for (const [i, id] of ids.entries()) {
            const name = power_user.personas[id] || id;
            setProgress(`กำลังลบ ${i + 1}/${ids.length}: ${name}`);
            const res = await postJson('/api/avatars/delete', { avatar: id });
            // 404: the image is already gone, only the settings entry is left — clean it up too.
            if (!res.ok && res.status !== 404) {
                failed.push(name);
                continue;
            }
            delete power_user.personas[id];
            delete power_user.persona_descriptions[id];
            if (id === power_user.default_persona) power_user.default_persona = null;
            if (chatMetadata && id === chatMetadata.persona) {
                delete chatMetadata.persona;
                metaChanged = true;
            }
            await eventSource.emit(E.PERSONA_DELETED, { avatarId: id, name });
            ui.selected.personas.delete(id);
            done++;
        }
        if (metaChanged) await saveMetadata?.();
        saveSettingsDebounced();
        setProgress('กำลังโหลดรายชื่อใหม่…');
        await getUserAvatars(true);
        report('ลบ', done, failed, 'persona');
        ui.confirm = null;
    });
}

async function doCopyPersonas(ids, suffix) {
    await busy('กำลังคัดลอก…', async () => {
        const { eventSource, event_types: E, getRequestHeaders, saveSettingsDebounced } = ctx();
        let files = [];
        try { files = await getUserAvatars(false); } catch { /* only used to avoid name clashes */ }
        const taken = new Set([...Object.keys(power_user.personas), ...(Array.isArray(files) ? files : [])]);
        const failed = [];
        const made = [];
        for (const [i, id] of ids.entries()) {
            const name = power_user.personas[id] ?? '';
            setProgress(`กำลังคัดลอก ${i + 1}/${ids.length}: ${name}`);
            try {
                const img = await fetch(personaUrl(id), { cache: 'no-store' });
                if (!img.ok) throw new Error(`image ${img.status}`);
                const blob = await img.blob();
                const wanted = newPersonaId(name, taken);
                taken.add(wanted);
                const form = new FormData();
                form.append('avatar', new File([blob], 'avatar.png', { type: blob.type || 'image/png' }));
                form.append('overwrite_name', wanted);
                const res = await fetch('/api/avatars/upload', {
                    method: 'POST',
                    headers: getRequestHeaders({ omitContentType: true }),
                    cache: 'no-cache',
                    body: form,
                });
                if (!res.ok) throw new Error(`upload ${res.status}`);
                const newId = (await res.json())?.path || wanted;
                taken.add(newId);
                const desc = cloneDescriptor(power_user.persona_descriptions[id]);
                power_user.personas[newId] = name + (suffix ?? '');
                power_user.persona_descriptions[newId] = desc;
                await eventSource.emit(E.PERSONA_CREATED, {
                    avatarId: newId,
                    name: power_user.personas[newId],
                    description: desc.description ?? '',
                    title: desc.title ?? '',
                    duplicatedFromAvatarId: id,
                });
                made.push(newId);
            } catch (e) {
                console.error(LOG, 'persona duplicate failed', id, e);
                failed.push(name || id);
            }
        }
        saveSettingsDebounced();
        setProgress('กำลังโหลดรายชื่อใหม่…');
        await getUserAvatars(true);
        report('คัดลอก', made.length, failed, 'persona');
        if (made.length) {
            ui.selected.personas.clear();
            for (const p of made) ui.selected.personas.add(p);
        }
        ui.confirm = null;
    });
}

// ---------------------------------------------------------------- entry points

function injectButtons() {
    if (!document.getElementById('bm_chars_btn')) {
        const anchor = document.getElementById('bulkEditButton');
        if (anchor) {
            const btn = document.createElement('i');
            btn.id = 'bm_chars_btn';
            btn.className = 'fa-solid fa-layer-group menu_button';
            btn.title = 'ลบ / คัดลอกบอททีละหลายตัว (Bulk Manager)';
            btn.addEventListener('click', () => openModal('chars'));
            anchor.after(btn);
        }
    }
    if (!document.getElementById('bm_personas_btn')) {
        const anchor = document.getElementById('personas_restore');
        if (anchor) {
            const btn = document.createElement('div');
            btn.id = 'bm_personas_btn';
            btn.className = 'menu_button menu_button_icon';
            btn.title = 'ลบ / คัดลอก persona ทีละหลายตัว (Bulk Manager)';
            btn.innerHTML = '<i class="fa-solid fa-layer-group"></i><span>Bulk</span>';
            btn.addEventListener('click', () => openModal('personas'));
            anchor.after(btn);
        }
    }
}

function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('bm_settings')) return;
    host.insertAdjacentHTML('beforeend', `
    <div id="bm_settings" class="bm_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bulk Manager <small class="bm_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="bm_btns">
                    <div class="menu_button menu_button_icon" id="bm_settings_chars"><i class="fa-solid fa-user"></i> จัดการบอท</div>
                    <div class="menu_button menu_button_icon" id="bm_settings_personas"><i class="fa-solid fa-masks-theater"></i> จัดการ persona</div>
                    <div class="menu_button menu_button_icon" id="bm_settings_books"><i class="fa-solid fa-broom"></i> จัดการ lorebook</div>
                </div>
                <small class="bm_note">หรือกดปุ่ม <i class="fa-solid fa-layer-group"></i> ข้างปุ่ม Bulk edit ในรายชื่อบอท / ข้างปุ่ม Restore ในหน้า Persona / ปุ่ม <i class="fa-solid fa-broom"></i> ในแผง World Info หรือพิมพ์ <code>/bulk</code> (<code>/bulk personas</code>, <code>/bulk lore</code>)</small>
                <hr class="sysHR">
                <b>แผง World Info</b>
                <label class="checkbox_label" title="บนมือถือ ช่อง Global ขึ้นแค่ว่า &quot;2 Items&quot; ตัวเลือกนี้จะแสดงชื่อเล่มใต้ช่องให้เห็นเลย (บนคอมช่องนี้แสดงชื่ออยู่แล้ว จึงไม่แสดงซ้ำ)"><input type="checkbox" id="bm_show_global"> แสดงชื่อเล่ม Global ใต้ช่อง Active World(s) for all chats</label>
                <label class="checkbox_label"><input type="checkbox" id="bm_show_chat"> แสดงส่วน Active World(s) for this chat</label>
                <div id="bm_old_loretidy" class="bm_note bm_warn" style="display:none"><i class="fa-solid fa-triangle-exclamation"></i> ยังติดตั้งส่วนขยาย Lore Tidy ตัวเก่าอยู่ ตอนนี้ Lore Tidy รวมอยู่ใน Bulk Manager แล้ว ถอน Lore Tidy ออกได้เลย (ระหว่างนี้แผง World Info ใช้ของ Lore Tidy ไปก่อน จะได้ไม่ขึ้นซ้ำ)</div>
            </div>
        </div>
    </div>`);
    document.getElementById('bm_settings_chars').addEventListener('click', () => openModal('chars'));
    document.getElementById('bm_settings_personas').addEventListener('click', () => openModal('personas'));
    document.getElementById('bm_settings_books').addEventListener('click', () => openModal('books'));
    const s = settings();
    for (const [id, key] of [['bm_show_global', 'showGlobalChips'], ['bm_show_chat', 'showChatPanel']]) {
        const el = document.getElementById(id);
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; ctx().saveSettingsDebounced(); lore.renderPanel(); });
    }
}

const SETTING_DEFAULTS = Object.freeze({ showGlobalChips: true, showChatPanel: true });
const OLD_LORE_TIDY_MODULE = 'lore_tidy';

function settings() {
    const ext = ctx().extensionSettings;
    ext[MODULE] ??= {};
    const s = ext[MODULE];
    // Coming from Lore Tidy: keep its World Info panel choices.
    const old = ext[OLD_LORE_TIDY_MODULE];
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
        if (s[k] === undefined) s[k] = typeof old?.[k] === 'boolean' ? old[k] : v;
    }
    return s;
}

/** The standalone Lore Tidy is now part of this extension: tell the user once per session if it is still installed. */
let oldLoreTidyNoticeShown = false;
function checkOldLoreTidy() {
    if (!lore.oldLoreTidyLoaded()) return;
    const note = document.getElementById('bm_old_loretidy');
    if (note) note.style.display = '';
    if (oldLoreTidyNoticeShown) return;
    oldLoreTidyNoticeShown = true;
    toast.warn('Lore Tidy รวมอยู่ใน Bulk Manager แล้ว (แท็บ Lorebook) ถอนส่วนขยาย Lore Tidy ตัวเก่าออกได้เลย');
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bulk',
        callback: (_args, value) => {
            const arg = String(value ?? '').trim();
            openModal(/^p/i.test(arg) ? 'personas' : /^(l|b|w)/i.test(arg) ? 'books' : 'chars');
            return '';
        },
        helpString: 'เปิด Bulk Manager — ลบ / คัดลอก / สำรองบอท persona หรือ lorebook ทีละหลายรายการ ใส่ <code>personas</code> หรือ <code>lore</code> เพื่อเปิดแท็บนั้น',
    }));
    // Old Lore Tidy command; skipped while the old extension is still installed (it registers its own).
    if (!lore.oldLoreTidyLoaded()) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'loretidy',
            callback: () => { openModal('books'); return ''; },
            helpString: 'เปิดแท็บ Lorebook ของ Bulk Manager (เดิมคือ Lore Tidy) — ดูว่า lorebook แต่ละเล่มถูกใช้ที่ไหน และลบเล่มที่ไม่มีใครใช้',
        }));
    }
}

// ---------------------------------------------------------------- stale-code check
//
// SillyTavern loads extension files by a fixed URL, and a home-screen web app
// on iOS rarely does a real reload, so after "Update" the old code can keep
// running for a long time. Compare with the manifest on the server; if it is
// newer, refresh the cached files explicitly and reload.

let versionCheckedAt = 0;
let versionToastShown = false;

async function checkForNewVersion() {
    if (versionToastShown || Date.now() - versionCheckedAt < 10 * 60_000) return;
    versionCheckedAt = Date.now();
    let remote;
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return;
        remote = String((await res.json())?.version ?? '');
    } catch { return; }
    if (!remote || remote === VERSION) return;
    versionToastShown = true;
    globalThis.toastr?.info(`ติดตั้ง v${escapeHtml(remote)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Bulk Manager', {
        timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false,
        onclick: () => reloadWithFreshFiles(),
    });
}

async function reloadWithFreshFiles() {
    try {
        await Promise.all(['index.js', 'lib.js', 'lorebooks.js', 'style.css', 'manifest.json'].map(f =>
            fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}

// ---------------------------------------------------------------- init

function init() {
    settings();
    injectButtons();
    renderSettings();
    lore.setupLorebooks({
        ui, toast, busy, setProgress, report, downloadBlob, renderAll, renderSoon, renderBody, renderFoot,
        toggleSel, wireRow, openModal, closeModal, settings,
    });
    const { eventSource, event_types: E } = ctx();
    for (const ev of [E.APP_READY, E.CHARACTER_PAGE_LOADED].filter(Boolean)) eventSource.on(ev, injectButtons);
    for (const ev of [E.CHAT_CHANGED, E.CHARACTER_DELETED, E.CHARACTER_EDITED, E.CHARACTER_RENAMED, E.CHARACTER_PAGE_LOADED,
        E.PERSONA_CHANGED, E.SETTINGS_UPDATED, E.GROUP_UPDATED, E.WORLDINFO_SETTINGS_UPDATED, E.WORLDINFO_UPDATED].filter(Boolean)) {
        eventSource.on(ev, renderSoon);
    }
    for (const ev of [E.CHAT_DELETED, E.CHAT_CREATED, E.GROUP_CHAT_CREATED, E.CHAT_RENAMED].filter(Boolean)) eventSource.on(ev, forgetChats);
    // Every extension module has been loaded by APP_READY, so the old Lore Tidy is visible by then.
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { registerCommand(); checkOldLoreTidy(); });
    else registerCommand();
    setTimeout(checkOldLoreTidy, 3000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(checkForNewVersion, 3000);
    console.log(LOG, 'loaded', `v${VERSION}`);
}

globalThis.BulkManager = { VERSION, open: openModal, checkForNewVersion, reloadWithFreshFiles, lore: lore.loreDebug };

if (typeof jQuery === 'function') jQuery(init); else init();

/*
 * Bulk Manager — SillyTavern UI extension
 *
 * Select many characters or personas at once, then delete, duplicate or back
 * them up in one go. Deleting always offers a .zip backup first.
 */

import { deleteCharacter, getCharacters } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatars, getUserAvatar, user_avatar } from '../../../personas.js';
import {
    escapeHtml, fileStamp, safeFileName, uniqueNamer, avatarStem,
    newPersonaId, cloneDescriptor, matchesQuery, makeZip,
} from './lib.js';

const MODULE = 'bulk_manager';
const LOG = '[BulkManager]';
const VERSION = '1.0.0'; // keep in sync with manifest.json
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

const ui = {
    tab: 'chars',
    query: '',
    sort: 'name',
    selected: { chars: new Set(), personas: new Set() },
    /** @type {null | 'delete' | 'copy'} */
    confirm: null,
    busy: false,
    progress: '',
    lastClicked: null,
    copySuffix: '',
};

const sel = () => ui.selected[ui.tab];
const unit = () => (ui.tab === 'chars' ? 'ตัว' : 'persona');

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

const allRows = () => (ui.tab === 'chars' ? charRows() : personaRows());
const visibleRows = () => allRows().filter(r => matchesQuery(ui.query, r.name, r.sub));

/** Drop selections whose item no longer exists (deleted elsewhere, etc.). */
function pruneSelection() {
    for (const tab of ['chars', 'personas']) {
        const keys = new Set((tab === 'chars' ? charRows() : personaRows()).map(r => r.key));
        for (const k of ui.selected[tab]) if (!keys.has(k)) ui.selected[tab].delete(k);
    }
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

function openModal(tab) {
    if (tab === 'chars' || tab === 'personas') ui.tab = tab;
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
                <input id="bm_search" class="text_pole" type="search" placeholder="ค้นหาชื่อ / ไฟล์">
                <select id="bm_sort" class="text_pole" title="เรียงตาม">
                    <option value="name">ชื่อ A→Z</option>
                    <option value="added">เพิ่มล่าสุด</option>
                </select>
            </div>
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
}

function renderAll() {
    if (!document.getElementById('bm_modal')) return;
    pruneSelection();
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
    }));
    const sort = document.getElementById('bm_sort');
    if (sort) sort.style.display = ui.tab === 'chars' ? '' : 'none';
}

function renderBody() {
    const body = document.querySelector('#bm_modal .bm_body');
    if (!body) return;
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
            </div>`).join('');
    }
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;

    const keys = rows.map(r => r.key);
    body.querySelectorAll('.bm_row').forEach((row, i) => {
        const key = keys[i];
        const onPick = (e, on) => {
            if (e.shiftKey && ui.lastClicked !== null && keys.includes(ui.lastClicked)) {
                const a = keys.indexOf(ui.lastClicked);
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
    });
    body.querySelector('.bm_allcb')?.addEventListener('change', e => toggleSel(keys, e.target.checked));
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

    const nameList = picked.map(r => escapeHtml(r.name || r.key)).join(' · ');

    if (ui.confirm === 'delete') {
        const isChars = ui.tab === 'chars';
        const kept = isChars ? [] : picked.filter(r => r.current);
        const targets = picked.filter(r => !kept.includes(r));
        const warns = [];
        if (isChars) {
            warns.push('แชทที่เปิดอยู่ตอนนี้จะถูกปิดก่อนลบ (แบบเดียวกับตอนลบใน SillyTavern เอง)');
            const grouped = targets.filter(r => r.inGroups.length);
            if (grouped.length) warns.push(`${grouped.length} ตัวอยู่ในแชทกลุ่ม: ${grouped.map(r => escapeHtml(r.name)).join(', ')}`);
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
                ${isChars ? '<label class="checkbox_label"><input type="checkbox" id="bm_del_chats" checked> ลบแชทของบอทเหล่านี้ด้วย</label>' : ''}
                <label class="checkbox_label"><input type="checkbox" id="bm_do_backup" checked> ดาวน์โหลดไฟล์สำรอง (.zip) ก่อนลบ</label>
                <div class="bm_btns">
                    <div class="menu_button bm_cancel">ยกเลิก</div>
                    <div class="menu_button redWarningBG bm_go ${targets.length ? '' : 'disabled'}"><i class="fa-solid fa-trash-can"></i> ลบ ${targets.length} ${unit()}</div>
                </div>
            </div>`;
        foot.querySelector('.bm_cancel').addEventListener('click', () => { ui.confirm = null; renderFoot(); });
        foot.querySelector('.bm_go').addEventListener('click', () => {
            if (!targets.length) return;
            const backup = foot.querySelector('#bm_do_backup').checked;
            const keys = targets.map(r => r.key);
            if (isChars) doDeleteChars(keys, foot.querySelector('#bm_del_chats').checked, backup);
            else doDeletePersonas(keys, backup);
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
    foot.querySelector('.bm_delete').addEventListener('click', () => { if (n) { ui.confirm = 'delete'; renderFoot(); } });
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

/** Download cards (raw .png, re-importable) and optionally their chats as one .zip. Throws if anything can't be read. */
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
            if (!file) continue;
            const r = await postJson('/api/chats/export', { file, avatar_url: avatar, format: 'jsonl', exportfilename: file, is_group: false });
            const json = r.ok ? await r.json().catch(() => null) : null;
            if (typeof json?.result !== 'string') throw new Error(`อ่านแชท "${file}" ของ ${avatar} ไม่ได้ เลยยังไม่ทำอะไร`);
            files.push({ name: `${folder}/${safeFileName(file, 'chat.jsonl')}`, data: new TextEncoder().encode(json.result) });
        }
    }
    downloadBlob(makeZip(files), `characters-backup ${fileStamp()}.zip`);
}

async function doDeleteChars(avatars, deleteChats, withBackup) {
    await busy('กำลังลบ…', async () => {
        if (withBackup) await backupChars(avatars, deleteChats);
        setProgress(`กำลังลบ ${avatars.length} ตัว…`);
        // SillyTavern's own delete: closes the open chat once, cleans tags and
        // per-card warnings, fires CHARACTER_DELETED, then reloads the list.
        const ok = await deleteCharacter(avatars, { deleteChats });
        const left = new Set((ctx().characters ?? []).map(c => c.avatar));
        const failed = avatars.filter(a => left.has(a));
        if (ok === false && failed.length === avatars.length) {
            toast.info('ยกเลิกแล้ว ยังไม่ได้ลบอะไร');
            return;
        }
        report('ลบ', avatars.length - failed.length, failed, 'ตัว');
        for (const a of avatars) if (!left.has(a)) ui.selected.chars.delete(a);
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
                </div>
                <small class="bm_note">หรือกดปุ่ม <i class="fa-solid fa-layer-group"></i> ข้างปุ่ม Bulk edit ในรายชื่อบอท / ข้างปุ่ม Restore ในหน้า Persona หรือพิมพ์ <code>/bulk</code> (<code>/bulk personas</code>)</small>
            </div>
        </div>
    </div>`);
    document.getElementById('bm_settings_chars').addEventListener('click', () => openModal('chars'));
    document.getElementById('bm_settings_personas').addEventListener('click', () => openModal('personas'));
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bulk',
        callback: (_args, value) => {
            openModal(/^p/i.test(String(value ?? '').trim()) ? 'personas' : 'chars');
            return '';
        },
        helpString: 'เปิด Bulk Manager — ลบ / คัดลอก / สำรองบอทหรือ persona ทีละหลายตัว ใส่ <code>personas</code> เพื่อเปิดแท็บ persona',
    }));
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
        await Promise.all(['index.js', 'lib.js', 'style.css', 'manifest.json'].map(f =>
            fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}

// ---------------------------------------------------------------- init

function init() {
    ctx().extensionSettings[MODULE] ??= {};
    injectButtons();
    renderSettings();
    registerCommand();
    const { eventSource, event_types: E } = ctx();
    for (const ev of [E.APP_READY, E.CHARACTER_PAGE_LOADED].filter(Boolean)) eventSource.on(ev, injectButtons);
    for (const ev of [E.CHAT_CHANGED, E.CHARACTER_DELETED, E.CHARACTER_EDITED, E.CHARACTER_RENAMED, E.CHARACTER_PAGE_LOADED,
        E.PERSONA_CHANGED, E.SETTINGS_UPDATED, E.GROUP_UPDATED].filter(Boolean)) {
        eventSource.on(ev, renderSoon);
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(checkForNewVersion, 3000);
    console.log(LOG, 'loaded', `v${VERSION}`);
}

globalThis.BulkManager = { VERSION, open: openModal, checkForNewVersion, reloadWithFreshFiles };

if (typeof jQuery === 'function') jQuery(init); else init();

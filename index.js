/*
 * Lore Lens — SillyTavern UI extension
 *
 * Shows which World Info entries went into the prompt and WHY: the keyword that
 * triggered each one, where that keyword was found (which message, which
 * entry's content during recursion, Author's Note…) with the surrounding text,
 * plus entries that matched but were blocked ("almost triggered") and
 * per-chat statistics for tuning lorebook keys.
 *
 * How it listens: SillyTavern's own WORLDINFO_SCAN_DONE event (one per scan
 * loop) and WORLD_INFO_ACTIVATED. No console patching, nothing written into
 * the chat file — history lives in this browser's IndexedDB.
 *
 * The keyword/location is re-derived with the same matching rules the engine
 * uses (case sensitivity, whole words, /regex/ keys, scan depth, macros).
 */

const MODULE = 'lore_lens';
const LOG = '[LoreLens]';
const DB_NAME = 'LoreLens';
const DB_STORE = 'chats';
const MAX_CHATS = 40;
const EDGE = 8;

const DEFAULTS = Object.freeze({
    enabled: true,
    showButton: true,
    groupByBook: true,
    nearMiss: true,
    alertOverflow: true,
    ignoreQuiet: true,
    historySize: 30,
    snippet: 44,
    btnPos: Object.freeze({ x: 0, y: 0.72, edge: 'left' }),
    // appearance of the floating button
    btnStyle: 'classic',             // see BTN_STYLES
    btnSize: 40,                     // px
    iconScale: 42,                   // % of the button
    btnIcon: 'fa-solid fa-book-atlas',
    iconColor: 'body',               // see COLOR_SOURCES
    bgColor: 'tint',
    borderColor: 'border',
    accentColor: 'quote',            // number badge + highlights in the panel
    customColors: Object.freeze({ icon: '#ffffff', bg: '#1e1e28', border: '#777777', accent: '#e18a24' }),
    bgOpacity: 75,                   // % — button background
    idleOpacity: 100,                // % — whole button while not touched
    shadow: true,
    blur: false,
    hideZero: false,
    // per-message report
    mesButton: true,                 // button in each bot message's “…” menu
    reportContent: true,             // include the entries' inserted text
});

const BTN_STYLES = Object.freeze({
    classic: ['คลาสสิก', 'ไอคอน + ตัวเลขมุมขวาล่าง'],
    minimal: ['มินิมอล', 'ตัวเลขอย่างเดียว'],
    pill: ['แคปซูล', 'ไอคอนกับตัวเลขเรียงกัน'],
    tab: ['แถบขอบจอ', 'ติดขอบจอแบบที่คั่นหนังสือ กินที่น้อย'],
    ring: ['วงแหวน', 'ตัวเลขกลาง วงแหวนเทียบกับครั้งที่ติดมากที่สุดในแชทนี้'],
});

const COLOR_SOURCES = Object.freeze({
    body: ['ตัวอักษรหลัก (Main Text)', '--SmartThemeBodyColor'],
    em: ['ตัวเอียง (Italics)', '--SmartThemeEmColor'],
    underline: ['ขีดเส้นใต้ (Underline)', '--SmartThemeUnderlineColor'],
    quote: ['คำพูด (Quote)', '--SmartThemeQuoteColor'],
    tint: ['พื้นเบลอ (UI Background)', '--SmartThemeBlurTintColor'],
    chat: ['พื้นแชท (Chat Background)', '--SmartThemeChatTintColor'],
    border: ['ขอบ (UI Border)', '--SmartThemeBorderColor'],
    shadow: ['เงา (Shadow)', '--SmartThemeShadowColor'],
    custom: ['กำหนดเอง…', null],
});

const ICONS = [
    'fa-solid fa-book-atlas', 'fa-solid fa-book', 'fa-solid fa-book-open', 'fa-solid fa-book-bookmark', 'fa-solid fa-scroll',
    'fa-solid fa-bookmark', 'fa-solid fa-magnifying-glass', 'fa-solid fa-eye', 'fa-solid fa-key', 'fa-solid fa-feather',
    'fa-solid fa-globe', 'fa-solid fa-earth-asia', 'fa-solid fa-map', 'fa-solid fa-compass', 'fa-solid fa-lightbulb',
    'fa-solid fa-wand-magic-sparkles', 'fa-solid fa-gem', 'fa-solid fa-moon', 'fa-solid fa-dragon', 'fa-solid fa-cat',
    '📖', '📜', '🔍', '🗝️', '🔮', '🌸', '🍀', '✨',
];

const LOGIC = ['AND ANY', 'NOT ALL', 'NOT ANY', 'AND ALL'];
const LOGIC_TH = ['มีคีย์รองอย่างน้อย 1', 'ขาดคีย์รองอย่างน้อย 1', 'ไม่มีคีย์รองเลย', 'มีคีย์รองครบทุกตัว'];

const REASON = {
    keyword: { icon: '🟢', th: 'คีย์เวิร์ด' },
    constant: { icon: '🔵', th: 'ค่าคงที่ (constant)' },
    sticky: { icon: '📌', th: 'ค้าง (sticky) จากรอบก่อน' },
    forced: { icon: '⚡', th: 'ถูกสั่งให้ติด (vector / extension)' },
    vector: { icon: '🔗', th: 'vector' },
    decorator: { icon: '✳️', th: '@@activate' },
    unknown: { icon: '❔', th: 'หาตำแหน่งคีย์ไม่เจอ' },
};

const WHY = {
    budget: { icon: 'fa-solid fa-scissors', th: 'งบ token เต็ม' },
    prob: { icon: 'fa-solid fa-dice', th: 'ทอยความน่าจะเป็นไม่ผ่าน' },
    secondary: { icon: 'fa-solid fa-key', th: 'คีย์รองไม่ผ่าน' },
    group: { icon: 'fa-solid fa-layer-group', th: 'แพ้ใน inclusion group' },
    cooldown: { icon: 'fa-solid fa-hourglass-half', th: 'ติด cooldown' },
    delay: { icon: 'fa-solid fa-clock', th: 'ยังไม่ถึง delay' },
    delayRec: { icon: 'fa-solid fa-rotate', th: 'รอ recursion (delay until recursion)' },
    excludeRec: { icon: 'fa-solid fa-ban', th: 'เจอแค่ใน recursion แต่ตั้ง exclude recursion' },
    filter: { icon: 'fa-solid fa-filter', th: 'ถูกกรองด้วยตัวละคร / แท็ก / ประเภทการเจน' },
    other: { icon: 'fa-solid fa-circle-question', th: 'คีย์ตรง แต่ไม่ได้ใส่ (เหตุผลอื่น)' },
};

const INJECT_LABELS = {
    '2_floating_prompt': "Author's Note",
    '1_memory': 'Summary',
    '3_vectors': 'Vector Storage',
    '4_vectors_data_bank': 'Data Bank',
    QUIET_PROMPT: 'Quiet prompt',
    DEPTH_PROMPT: "Character's Note",
};

const GEN_TH = { normal: 'ส่งข้อความ', swipe: 'swipe', regenerate: 'เจนใหม่', continue: 'ต่อข้อความ', impersonate: 'impersonate', quiet: 'quiet (extension)' };

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
let WI = null;         // ../../../world-info.js (live bindings)
let RX = null;         // ../../regex/engine.js

function settings() {
    const ext = ctx().extensionSettings;
    ext[MODULE] ??= {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v && typeof v === 'object' ? { ...v } : v;
    }
    s.customColors = { ...DEFAULTS.customColors, ...(s.customColors || {}) };
    return s;
}
const save = () => ctx().saveSettingsDebounced();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const entryKey = e => `${e.world}.${e.uid}`;
const titleOf = e => (e.comment && String(e.comment).trim()) || (Array.isArray(e.key) && e.key.filter(Boolean).join(', ')) || `#${e.uid}`;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const subst = s => { try { return ctx().substituteParams(String(s)); } catch { return String(s); } };
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Lore Lens'),
    info: m => globalThis.toastr?.info(m, 'Lore Lens'),
    warn: m => globalThis.toastr?.warning(m, 'Lore Lens'),
};

// ---------------------------------------------------------------- keyword matching (mirrors WorldInfoBuffer.matchKeys)

function parseRegexKey(input) {
    try {
        if (WI?.parseRegexFromString) return WI.parseRegexFromString(input);
    } catch { /* fall through */ }
    const m = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!m || m[1].match(/(^|[^\\])\//)) return null;
    try { return new RegExp(m[1].replace('\\/', '/'), m[2]); } catch { return null; }
}

/**
 * Where does `needle` match inside `hay` for this entry?
 * @returns {{index:number,length:number,regex:boolean}|null}
 */
function findKey(hay, needle, opt) {
    if (!hay || !needle) return null;
    const rx = parseRegexKey(needle);
    if (rx) {
        const r = new RegExp(rx.source, rx.flags.replace(/[gy]/g, ''));
        const m = r.exec(hay);
        return m ? { index: m.index, length: m[0].length, regex: true } : null;
    }
    const h = opt.cs ? hay : hay.toLowerCase();
    const n = opt.cs ? needle : needle.toLowerCase();
    if (opt.ww && n.split(/\s+/).length === 1) {
        const src = `(?:^|\\W)(${escapeRegex(n)})(?:$|\\W)`;
        let r;
        try { r = new RegExp(src, 'd'); } catch { r = new RegExp(src); } // 'd' (match indices) needs Safari 15+
        const m = r.exec(h);
        if (!m) return null;
        const start = m.indices?.[1]?.[0] ?? (m.index + m[0].indexOf(m[1]));
        return { index: start, length: n.length, regex: false };
    }
    const i = h.indexOf(n);
    return i < 0 ? null : { index: i, length: n.length, regex: false };
}

const THAI = /[ก-๎]/;

function snippetOf(text, hit, span) {
    const clean = s => s.replace(/\x01/g, '').replace(/\s+/g, ' ');
    const b = text.slice(Math.max(0, hit.index - span), hit.index);
    const a = text.slice(hit.index + hit.length, hit.index + hit.length + span);
    return [
        (hit.index - span > 0 ? '…' : '') + clean(b).trimStart(),
        clean(text.slice(hit.index, hit.index + hit.length)),
        clean(a).trimEnd() + (hit.index + hit.length + span < text.length ? '…' : ''),
    ];
}

let thaiSegmenter;
try { thaiSegmenter = new Intl.Segmenter('th', { granularity: 'word' }); } catch { thaiSegmenter = null; }

/**
 * Thai has no spaces, so "whole words" can't stop a key from matching inside
 * another word (ยา in พยายาม). Ask the browser's Thai word breaker whether the
 * match starts and ends on word boundaries.
 */
function midWord(text, hit, key) {
    if (!thaiSegmenter || hit.regex || !THAI.test(key)) return false;
    const start = hit.index, end = hit.index + hit.length;
    const glued = THAI.test(text[start - 1] ?? '') || THAI.test(text[end] ?? '');
    if (!glued) return false;
    const from = Math.max(0, start - 40);
    const bounds = new Set();
    for (const seg of thaiSegmenter.segment(text.slice(from, Math.min(text.length, end + 40)))) {
        bounds.add(from + seg.index);
        bounds.add(from + seg.index + seg.segment.length);
    }
    return !bounds.has(start) || !bounds.has(end);
}

// ---------------------------------------------------------------- capture: what the engine scanned

const scanOpts = e => ({
    cs: e.caseSensitive ?? !!WI?.world_info_case_sensitive,
    ww: e.matchWholeWords ?? !!WI?.world_info_match_whole_words,
});

function regexed(text, isUser, depth) {
    try {
        if (RX?.getRegexedString) {
            return RX.getRegexedString(text, isUser ? RX.regex_placement.USER_INPUT : RX.regex_placement.AI_OUTPUT, { isPrompt: true, depth });
        }
    } catch { /* ignore */ }
    return text;
}

/** Snapshot the text sources the engine is scanning right now (called on scan loop #1). */
function captureSources(genType, sortedEntries) {
    const c = ctx();
    const chat = Array.isArray(c.chat) ? c.chat : [];
    const baseDepth = Number(WI?.world_info_depth ?? 2);
    const maxDepth = Math.max(baseDepth, ...sortedEntries.map(e => Number(e.scanDepth) || 0)) + 12;
    const withNames = WI?.world_info_include_names ?? true;

    let core = chat.map((m, i) => ({ m, i })).filter(x => !x.m.is_system);
    if (genType === 'swipe') core = core.slice(0, -1);
    const isContinue = genType === 'continue';
    const messages = [];
    for (let k = core.length - 1, depth = 0; k >= 0 && depth < maxDepth; k--, depth++) {
        const { m, i } = core[k];
        const body = regexed(String(m.mes ?? ''), !!m.is_user, core.length - k - (isContinue ? 2 : 1));
        messages.push({
            text: withNames ? `${m.name}: ${body}` : body,
            reasoning: m.extra?.reasoning ? String(m.extra.reasoning) : '',
            mesId: i,
            who: m.is_user ? 'user' : 'bot',
            name: m.name,
        });
    }

    const injects = [];
    for (const [key, p] of Object.entries(c.extensionPrompts ?? {})) {
        if (!p?.scan || !p.value) continue;
        injects.push({ text: subst(p.value), label: INJECT_LABELS[key] ?? key });
    }

    const ch = c.characters?.[c.characterId];
    const globals = {
        persona: subst(c.powerUserSettings?.persona_description ?? ''),
        description: subst(ch?.description ?? ''),
        personality: subst(ch?.personality ?? ''),
        depthPrompt: subst(ch?.data?.extensions?.depth_prompt?.prompt ?? ''),
        scenario: subst(ch?.scenario ?? ''),
        creatorNotes: subst(ch?.data?.creator_notes ?? ''),
    };
    return { messages, injects, globals, baseDepth };
}

const GLOBAL_FIELDS = [
    ['matchPersonaDescription', 'persona', 'คำอธิบาย persona'],
    ['matchCharacterDescription', 'description', 'คำอธิบายตัวละคร'],
    ['matchCharacterPersonality', 'personality', 'บุคลิกตัวละคร'],
    ['matchCharacterDepthPrompt', 'depthPrompt', "Character's Note"],
    ['matchScenario', 'scenario', 'ฉากเรื่อง (scenario)'],
    ['matchCreatorNotes', 'creatorNotes', 'Creator notes'],
];

/**
 * The pieces of text this entry was scanned against, in the engine's order.
 * `loop` = the scan loop the entry was checked in; recursion text only counts from earlier loops.
 */
function segmentsFor(e, run, loop, state) {
    const src = run.sources;
    const depth = Number.isFinite(Number(e.scanDepth)) && e.scanDepth !== null && e.scanDepth !== '' ? Number(e.scanDepth) : src.baseDepth;
    const segs = [];
    if (depth <= 0) return segs; // the engine scans nothing at depth 0
    src.messages.slice(0, depth).forEach((m, d) => segs.push({ text: m.text, src: { type: 'mes', who: m.who, mesId: m.mesId, depth: d } }));
    for (const [flag, field, label] of GLOBAL_FIELDS) {
        if (e[flag] && src.globals[field]) segs.push({ text: src.globals[field], src: { type: 'global', label } });
    }
    for (const inj of src.injects) segs.push({ text: inj.text, src: { type: 'inject', label: inj.label } });
    if (state !== 3) {
        for (const r of run.recursion) {
            if (r.loop < loop) segs.push({ text: r.content, src: { type: 'rec', label: r.title, k: r.k, loop: r.loop } });
        }
    }
    return segs;
}

/** Fallback places to look when the key is not in the scanned text (deeper history, reasoning). */
function extraSegments(e, run) {
    const src = run.sources;
    const segs = [];
    src.messages.forEach((m, d) => {
        segs.push({ text: m.text, src: { type: 'far', who: m.who, mesId: m.mesId, depth: d } });
        if (m.reasoning) segs.push({ text: m.reasoning, src: { type: 'reasoning', who: m.who, mesId: m.mesId, depth: d } });
    });
    return segs;
}

function firstMatch(keys, segs, opt, span) {
    for (const raw of keys) {
        const key = subst(raw).trim();
        if (!key) continue;
        for (const seg of segs) {
            const hit = findKey(seg.text, key, opt);
            if (hit) {
                const out = { key, src: seg.src, snip: snippetOf(seg.text, hit, span) };
                if (midWord(seg.text, hit, key)) out.warn = 'midword';
                return out;
            }
        }
    }
    return null;
}

function secondaryResult(e, segs, opt) {
    const sec = Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean) : [];
    if (!sec.length) return { sec: [], logic: null, pass: true };
    const logic = Number(e.selectiveLogic ?? 0);
    const list = sec.map(raw => {
        const key = subst(raw).trim();
        return { key, ok: !!key && segs.some(s => findKey(s.text, key, opt)) };
    });
    const any = list.some(x => x.ok), all = list.every(x => x.ok);
    const pass = logic === 0 ? any : logic === 1 ? !all : logic === 2 ? !any : all;
    return { sec: list, logic, pass };
}

function baseRecord(e) {
    return {
        k: entryKey(e),
        world: e.world,
        uid: e.uid,
        title: titleOf(e).slice(0, 120),
        keys: (e.key ?? []).filter(Boolean).slice(0, 12),
    };
}

function analyzeHit(a, run) {
    const e = a.entry;
    const rec = { ...baseRecord(e), loop: a.loop, state: a.state, pos: e.position, depth: e.depth, order: e.order };
    // the text that actually went into the prompt (macros already substituted by the engine)
    if (e.content) rec.content = String(e.content).slice(0, 4000);
    const span = clamp(Number(settings().snippet) || DEFAULTS.snippet, 16, 160);
    if (e.decorators?.includes?.('@@activate')) rec.reason = 'decorator';
    else if (run.forced.has(rec.k)) rec.reason = 'forced';
    else if (e.constant) rec.reason = 'constant';
    else if (a.sticky) rec.reason = 'sticky';
    else rec.reason = 'keyword';

    if (Array.isArray(e.key) && e.key.length) {
        const opt = scanOpts(e);
        const segs = segmentsFor(e, run, a.loop, a.state);
        rec.prim = firstMatch(e.key, segs, opt, span);
        if (!rec.prim && rec.reason === 'keyword') {
            rec.prim = firstMatch(e.key, extraSegments(e, run), opt, span);
            if (!rec.prim) rec.reason = e.vectorized ? 'vector' : 'unknown';
        }
        const s = secondaryResult(e, segs, opt);
        if (s.sec.length) { rec.sec = s.sec; rec.logic = s.logic; }
    } else if (rec.reason === 'keyword') {
        rec.reason = e.vectorized ? 'vector' : 'unknown';
    }
    return rec;
}

function analyzeCut(c, run) {
    const e = c.entry;
    const rec = { ...baseRecord(e), why: c.why, loop: c.loop };
    if (Array.isArray(e.key) && e.key.length) {
        rec.prim = firstMatch(e.key, segmentsFor(e, run, c.loop, c.state), scanOpts(e), clamp(Number(settings().snippet) || DEFAULTS.snippet, 16, 160));
    }
    return rec;
}

/** Entries whose primary key is in the scanned text but that did not make it into the prompt. */
function analyzeNearMiss(run) {
    const done = new Set([...run.hits.map(h => h.k), ...run.cuts.map(c => c.k)]);
    const span = clamp(Number(settings().snippet) || DEFAULTS.snippet, 16, 160);
    const lastLoop = run.loops + 1;
    const out = [];
    for (const snap of run.catalog) {
        const e = snap.entry;
        if (done.has(snap.k) || e.disable || e.constant || !Array.isArray(e.key) || !e.key.length) continue;
        const opt = scanOpts(e);
        const segsNoRec = segmentsFor(e, run, 0, 1);
        const segsAll = segmentsFor(e, run, lastLoop, 2);
        let prim = firstMatch(e.key, segsNoRec, opt, span);
        let onlyRec = false;
        if (!prim) {
            prim = firstMatch(e.key, segsAll, opt, span);
            onlyRec = !!prim;
        }
        if (!prim) continue;
        const s = secondaryResult(e, onlyRec ? segsAll : segsNoRec, opt);
        let why = 'other';
        if (snap.filtered) why = 'filter';
        else if (snap.delay) why = 'delay';
        else if (snap.cooldown) why = 'cooldown';
        else if (!s.pass) why = 'secondary';
        else if (onlyRec && e.excludeRecursion) why = 'excludeRec';
        else if (!onlyRec && e.delayUntilRecursion) why = 'delayRec';
        else if (e.group && String(e.group).trim()) why = 'group';
        const rec = { ...baseRecord(e), why, prim };
        if (s.sec.length) { rec.sec = s.sec; rec.logic = s.logic; }
        if (why === 'group') rec.group = String(e.group).slice(0, 60);
        out.push(rec);
    }
    return out;
}

// ---------------------------------------------------------------- capture: event plumbing

const gen = { type: 'normal', dry: false, pending: false };
const forced = new Set();
let run = null;           // scan in progress
let finished = null;      // scan finished, waiting for WORLD_INFO_ACTIVATED to prove it was real

function isEffect(timed, type, e) {
    try { return !!timed?.isEffectActive?.(type, e); } catch { return false; }
}

function charFiltered(e) {
    const f = e.characterFilter;
    if (Array.isArray(e.triggers) && e.triggers.length && !e.triggers.includes(gen.type === 'swipe' || gen.type === 'regenerate' || gen.type === 'continue' || gen.type === 'impersonate' || gen.type === 'quiet' ? gen.type : 'normal')) return true;
    if (f?.names?.length) {
        const c = ctx();
        const avatar = c.characters?.[c.characterId]?.avatar ?? '';
        const file = avatar.replace(/\.[^.]+$/, '');
        const inc = f.names.includes(file);
        if (f.isExclude ? inc : !inc) return true;
    }
    return false;
}

function onGenerationStarted(type, _opts, dryRun) {
    gen.type = String(type || 'normal');
    gen.dry = !!dryRun;
    gen.pending = !dryRun;
    forced.clear();
    // a new visible generation: whatever scan was waiting for its reply never got one
    if (!dryRun && gen.type !== 'quiet') pendingLink = null;
}

/** The scan whose reply is being generated; linked to the message when it arrives. */
let pendingLink = null;

function onMessageReceived(id, type) {
    if (!pendingLink || type === 'first_message') return;
    const m = ctx().chat?.[id];
    if (!m || m.is_user) return;
    pendingLink.msg = { id: Number(id), swipe: Number(m.swipe_id ?? 0), date: String(m.send_date ?? '') };
    pendingLink = null;
    persistSoon();
    if (isOpen()) render();
}

function onForceActivate(entries) {
    for (const e of Array.isArray(entries) ? entries : []) if (e?.world != null && e?.uid != null) forced.add(entryKey(e));
}

function onScanDone(args) {
    try {
        if (!settings().enabled || !args?.state) return;
        const loop = Number(args.state.loopCount) || 1;
        if (loop === 1 || !run) {
            const sorted = Array.isArray(args.sortedEntries) ? args.sortedEntries : [];
            run = {
                ts: Date.now(),
                genType: gen.type,
                dry: gen.dry,
                forced: new Set(forced),
                sources: captureSources(gen.type, sorted),
                catalog: sorted.map(e => ({
                    k: entryKey(e),
                    entry: e,
                    cooldown: isEffect(args.timedEffects, 'cooldown', e) && !isEffect(args.timedEffects, 'sticky', e),
                    delay: isEffect(args.timedEffects, 'delay', e),
                    filtered: charFiltered(e),
                })),
                activations: [],
                cutsRaw: [],
                recursion: [],
                loops: 0,
            };
            finished = null;
        }
        const r = run;
        r.loops = loop;
        const state = Number(args.state.current) || 1;
        const activated = args.activated?.entries instanceof Map ? args.activated.entries : new Map();
        const all = args.new?.all ?? [];
        const ok = new Set(args.new?.successful ?? []);
        for (const e of all) {
            const k = entryKey(e);
            if (!ok.has(e)) { r.cutsRaw.push({ entry: e, why: 'prob', loop, state }); continue; }
            if (!activated.has(k)) { r.cutsRaw.push({ entry: e, why: 'budget', loop, state }); continue; }
            r.activations.push({ entry: e, loop, state, sticky: isEffect(args.timedEffects, 'sticky', e) });
            if (!e.preventRecursion && e.content) r.recursion.push({ k, title: titleOf(e), content: String(e.content), loop });
        }
        r.overflow = !!args.budget?.overflowed;
        r.budget = Number(args.budget?.current) || null;
        if (Number(args.state.next) === 0) {
            finished = r;
            run = null;
            // No WORLD_INFO_ACTIVATED will follow when nothing activated.
            if (!r.activations.length && !r.dry && gen.pending) commit(r);
        }
    } catch (err) {
        console.warn(LOG, 'scan capture failed', err);
    }
}

function onWorldInfoActivated() {
    try {
        const r = finished ?? run;
        if (!r || r.dry) return;
        run = null;
        finished = null;
        commit(r);
    } catch (err) {
        console.warn(LOG, 'commit failed', err);
    }
}

function commit(r) {
    gen.pending = false;
    finished = null;
    if (settings().ignoreQuiet && r.genType === 'quiet') return;
    r.hits = r.activations.map(a => analyzeHit(a, r));
    r.cuts = r.cutsRaw.map(c => analyzeCut(c, r));
    const rec = {
        id: `${r.ts}${Math.random().toString(36).slice(2, 5)}`,
        ts: r.ts,
        genType: r.genType,
        loops: r.loops,
        overflow: r.overflow,
        budget: r.budget,
        total: r.catalog.length,
        hits: r.hits,
        cuts: r.cuts,
        near: null,
    };
    catalog = r.catalog.filter(x => !x.entry.disable && !x.entry.constant && Array.isArray(x.entry.key) && x.entry.key.length)
        .map(x => ({ k: x.k, world: x.entry.world, uid: x.entry.uid, title: titleOf(x.entry).slice(0, 120), keys: x.entry.key.filter(Boolean).slice(0, 12) }));
    history.unshift(rec);
    if (!['quiet', 'impersonate'].includes(rec.genType)) pendingLink = rec;
    history.length = Math.min(history.length, clamp(Number(settings().historySize) || DEFAULTS.historySize, 5, 200));
    view.index = 0;
    if (settings().alertOverflow && rec.overflow) alertState = 'attention';
    updateButton();
    if (isOpen()) { lastSeen = rec.id; render(); }
    persistSoon();

    if (settings().nearMiss) {
        const job = () => {
            try { rec.near = analyzeNearMiss(r); } catch (err) { console.warn(LOG, 'near-miss failed', err); rec.near = []; }
            r.catalog = null;
            r.sources = null;
            if (isOpen() && history[view.index] === rec) render();
            persistSoon();
        };
        (globalThis.requestIdleCallback ?? (f => setTimeout(f, 30)))(job, { timeout: 1500 });
    } else {
        rec.near = [];
        r.catalog = null;
        r.sources = null;
    }
}

// ---------------------------------------------------------------- storage (IndexedDB, per chat)

let history = [];          // scans of the current chat, newest first
let catalog = [];          // keyed entries of the active lorebooks (from the last scan, memory only)
let chatId = null;
let dbPromise = null;

function db() {
    dbPromise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'chatId' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

async function dbGet(id) {
    try {
        const d = await db();
        return await new Promise((res, rej) => {
            const q = d.transaction(DB_STORE).objectStore(DB_STORE).get(id);
            q.onsuccess = () => res(q.result ?? null);
            q.onerror = () => rej(q.error);
        });
    } catch (err) { console.warn(LOG, 'read failed', err); return null; }
}

async function dbPut(rec) {
    try {
        const d = await db();
        await new Promise((res, rej) => {
            const tx = d.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(rec);
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
        await pruneChats(d);
    } catch (err) { console.warn(LOG, 'write failed', err); }
}

async function pruneChats(d) {
    const all = await new Promise(res => {
        const q = d.transaction(DB_STORE).objectStore(DB_STORE).getAll();
        q.onsuccess = () => res(q.result ?? []);
        q.onerror = () => res([]);
    });
    if (all.length <= MAX_CHATS) return;
    const drop = all.sort((a, b) => b.updated - a.updated).slice(MAX_CHATS);
    await new Promise(res => {
        const tx = d.transaction(DB_STORE, 'readwrite');
        drop.forEach(x => tx.objectStore(DB_STORE).delete(x.chatId));
        tx.oncomplete = res;
        tx.onerror = res;
    });
}

async function dbClearAll() {
    try {
        const d = await db();
        await new Promise(res => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).clear(); tx.oncomplete = res; tx.onerror = res; });
    } catch { /* ignore */ }
}

let persistTimer = null;
function persistSoon() {
    clearTimeout(persistTimer);
    const id = chatId;
    persistTimer = setTimeout(() => { if (id && id === chatId) dbPut({ chatId: id, updated: Date.now(), scans: history }); }, 600);
}

function currentChatId() {
    try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; }
}

async function loadChat() {
    const id = currentChatId();
    if (id === chatId) return;
    clearTimeout(persistTimer);
    chatId = id;
    history = [];
    catalog = [];
    alertState = '';
    view.index = 0;
    run = null;
    finished = null;
    pendingLink = null;
    if (id) {
        const rec = await dbGet(id);
        if (chatId !== id) return;
        history = Array.isArray(rec?.scans) ? rec.scans : [];
    }
    updateButton();
    if (isOpen()) render();
}

// ---------------------------------------------------------------- floating button

let button = null;
let alertState = '';


function iconHTML(icon) {
    const v = String(icon ?? '').trim();
    if (/(^|\s)fa-/.test(v)) return `<i class="${esc(v.replace(/[^\w\s-]/g, ''))}"></i>`;
    return `<span class="ll_emoji">${esc(v || '📖')}</span>`;
}

function cleanIcon(v) {
    v = String(v ?? '').trim();
    if (/(^|\s)fa-/.test(v)) return v.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ');
    return v.slice(0, 8);
}

function colorValue(key, which) {
    const s = settings();
    if (key === 'custom') return s.customColors[which] || DEFAULTS.customColors[which];
    const v = COLOR_SOURCES[key]?.[1];
    return v ? `var(${v})` : null;
}

const btnStyle = () => (BTN_STYLES[settings().btnStyle] ? settings().btnStyle : 'classic');

/** Button markup shared by the real button and the previews in the settings drawer. */
const BTN_INNER = '<span class="ll_ring"></span><span class="ll_ic"></span><span class="ll_count"></span>';

/** Colours, size and style as CSS variables/classes on a button (real or preview). */
function styleButton(el, style = btnStyle()) {
    const s = settings();
    const set = (k, v) => el.style.setProperty(k, v);
    set('--ll-size', `${clamp(Number(s.btnSize) || DEFAULTS.btnSize, 24, 80)}px`);
    set('--ll-icon', String(clamp(Number(s.iconScale) || DEFAULTS.iconScale, 25, 75) / 100));
    set('--ll-fg', colorValue(s.iconColor, 'icon') ?? 'var(--SmartThemeBodyColor)');
    set('--ll-bg', colorValue(s.bgColor, 'bg') ?? 'var(--SmartThemeBlurTintColor)');
    set('--ll-border', colorValue(s.borderColor, 'border') ?? 'var(--SmartThemeBorderColor)');
    set('--ll-accent', colorValue(s.accentColor, 'accent') ?? 'var(--SmartThemeQuoteColor)');
    set('--ll-bg-op', `${clamp(Number.isFinite(Number(s.bgOpacity)) ? Number(s.bgOpacity) : DEFAULTS.bgOpacity, 0, 100)}%`);
    set('--ll-idle-op', String(clamp(Number(s.idleOpacity) || 100, 15, 100) / 100));
    for (const k of Object.keys(BTN_STYLES)) el.classList.toggle(`ll_s_${k}`, style === k);
    el.classList.toggle('ll_noshadow', !s.shadow);
    el.classList.toggle('ll_blur', !!s.blur);
    const ic = el.querySelector('.ll_ic');
    const icon = s.btnIcon || DEFAULTS.btnIcon;
    if (ic && ic.dataset.icon !== icon) { ic.innerHTML = iconHTML(icon); ic.dataset.icon = icon; }
}

/** Number shown on a button; `ratio` (0–1) fills the ring style. */
function setCount(el, n, ratio) {
    const hide = n == null || (n === 0 && settings().hideZero && btnStyle() === 'classic');
    el.querySelector('.ll_count').textContent = hide ? '' : String(n);
    el.classList.toggle('ll_zero', n === 0);
    el.classList.toggle('ll_nodata', n == null);
    el.style.setProperty('--ll-ratio', String(clamp(Number(ratio) || 0, 0, 1)));
}

function buildButton() {
    button = document.createElement('div');
    button.id = 'll_button';
    button.className = 'll_btn';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.title = 'Lore Lens — เอนทรีที่ติดและคีย์เวิร์ดที่ทำให้ติด';
    button.innerHTML = BTN_INNER;
    button.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSheet(); } });
    makeDraggable(button);
    document.body.appendChild(button);
    applyLook();
    window.addEventListener('resize', () => placeButton());
    // Quick Dock moves the button in and out of its tray: re-apply the edge/tab layout.
    new MutationObserver(() => { syncEdge(); placeButton(); }).observe(button, { attributes: true, attributeFilter: ['data-qd-tray'] });
}

const docked = () => !!button?.closest('#qd_panel') || !!button?.dataset.qdTray;

function applyLook() {
    if (!button) return;
    styleButton(button);
    syncEdge();
    updateButton();
    placeButton();
    renderLookPreviews();
    // the panel's highlight colour follows the badge colour
    sheet?.style.setProperty('--ll-accent', colorValue(settings().accentColor, 'accent') ?? 'var(--SmartThemeQuoteColor)');
}

function syncEdge() {
    if (!button) return;
    const edge = docked() ? '' : (settings().btnPos?.edge ?? '');
    for (const e of ['left', 'right', 'top', 'bottom']) button.classList.toggle(`ll_edge_${e}`, edge === e);
}

function updateButton() {
    if (!button) return;
    const s = settings();
    const last = history[0];
    const n = last ? last.hits.length : null;
    // ring style: this scan compared with the busiest scan of this chat
    const most = Math.max(1, ...history.map(h => h.hits.length));
    setCount(button, n, n == null ? 0 : n / most);
    button.classList.toggle('ll_hidden', !s.enabled || !s.showButton);
    if (alertState) button.dataset.state = alertState; else delete button.dataset.state;
    button.title = last
        ? `Lore Lens — ติด ${last.hits.length} เอนทรี${last.overflow ? ' · งบ token เต็ม!' : ''}`
        : 'Lore Lens — เอนทรีที่ติดและคีย์เวิร์ดที่ทำให้ติด';
}

/** Gap to the screen edge: the tab style sits flush against it. */
const edgeGap = () => (btnStyle() === 'tab' ? 0 : EDGE);

function placeButton() {
    if (!button || docked() || button.classList.contains('ll_dragging')) return;
    const de = document.documentElement;
    const vw = de.clientWidth || innerWidth, vh = de.clientHeight || innerHeight;
    const w = button.offsetWidth || 40, h = button.offsetHeight || 40;
    const p = settings().btnPos ?? DEFAULTS.btnPos;
    const g = edgeGap();
    const tx = Math.max(0, vw - w - 2 * g), ty = Math.max(0, vh - h - 2 * g);
    let left = g + clamp(Number(p.x) || 0, 0, 1) * tx;
    let top = g + clamp(Number(p.y) || 0, 0, 1) * ty;
    if (p.edge === 'left') left = g;
    if (p.edge === 'right') left = g + tx;
    if (p.edge === 'top') top = g;
    if (p.edge === 'bottom') top = g + ty;
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
}

function makeDraggable(el) {
    let start = null, dragged = false;
    el.addEventListener('pointerdown', e => {
        if (e.button > 0) return;
        start = { x: e.clientX, y: e.clientY, id: e.pointerId, r: el.getBoundingClientRect() };
        dragged = false;
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id || docked()) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!dragged && Math.hypot(dx, dy) < 7) return;
        if (!dragged) {
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            for (const k of ['left', 'right', 'top', 'bottom']) el.classList.remove(`ll_edge_${k}`);
        }
        dragged = true;
        el.classList.add('ll_dragging');
        const de = document.documentElement;
        el.style.left = `${clamp(start.r.left + dx, 0, de.clientWidth - el.offsetWidth)}px`;
        el.style.top = `${clamp(start.r.top + dy, 0, de.clientHeight - el.offsetHeight)}px`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        if (!dragged) return; // a plain tap is handled by the click event
        el.classList.remove('ll_dragging');
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        const de = document.documentElement, vw = de.clientWidth, vh = de.clientHeight;
        const r = el.getBoundingClientRect();
        const dist = { left: r.left, right: vw - r.right, top: r.top, bottom: vh - r.bottom };
        const edge = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
        const g = edgeGap();
        settings().btnPos = {
            x: clamp((r.left - g) / Math.max(1, vw - r.width - 2 * g), 0, 1),
            y: clamp((r.top - g) / Math.max(1, vh - r.height - 2 * g), 0, 1),
            edge,
        };
        save();
        syncEdge();
        requestAnimationFrame(placeButton); // the tab style changes shape with the edge
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', e => {
        if (dragged) { dragged = false; e.stopPropagation(); return; }
        toggleSheet();
    });
}

// ---------------------------------------------------------------- sheet

let layer = null;
let sheet = null;
let backdrop = null;
const view = { index: 0, tab: 'hit', open: new Set(), query: '' };

const isOpen = () => !!sheet?.classList.contains('ll_open');

function buildSheet() {
    // A full-viewport layer that lays the sheet out at its bottom edge. Its size
    // comes from visualViewport (so the sheet sits above the on-screen keyboard),
    // and it is positioned with top/left only: SillyTavern gives <html> a
    // perspective, which makes <html> — not the screen — the box that
    // `position: fixed; bottom: 0` would be measured from.
    layer = document.createElement('div');
    layer.id = 'll_layer';
    backdrop = document.createElement('div');
    backdrop.id = 'll_backdrop';
    backdrop.addEventListener('click', closeSheet);

    sheet = document.createElement('div');
    sheet.id = 'll_sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Lore Lens');
    sheet.innerHTML = `
        <div class="ll_grab" title="ลากลงเพื่อปิด"><span></span></div>
        <div class="ll_head">
            <div class="ll_brand"><i class="fa-solid fa-book-atlas"></i><b>Lore Lens</b></div>
            <div class="ll_nav">
                <div class="ll_iconbtn ll_prev" role="button" tabindex="0" title="ครั้งก่อนหน้า"><i class="fa-solid fa-chevron-left"></i></div>
                <div class="ll_when"></div>
                <div class="ll_iconbtn ll_next" role="button" tabindex="0" title="ครั้งถัดไป"><i class="fa-solid fa-chevron-right"></i></div>
            </div>
            <div class="ll_iconbtn ll_close" role="button" tabindex="0" title="ปิด"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="ll_tabs" role="tablist">
            <div class="ll_tab" data-tab="hit" role="tab" tabindex="0">ที่ติด <span class="ll_n"></span></div>
            <div class="ll_tab" data-tab="near" role="tab" tabindex="0">เกือบติด <span class="ll_n"></span></div>
            <div class="ll_tab" data-tab="stats" role="tab" tabindex="0">สถิติแชทนี้</div>
        </div>
        <div class="ll_body"></div>`;

    sheet.querySelector('.ll_close').addEventListener('click', closeSheet);
    sheet.querySelector('.ll_prev').addEventListener('click', () => step(1));
    sheet.querySelector('.ll_next').addEventListener('click', () => step(-1));
    sheet.querySelector('.ll_tabs').addEventListener('click', e => {
        const t = e.target.closest('[data-tab]')?.dataset.tab;
        if (!t || t === view.tab) return;
        view.tab = t;
        render();
        sheet.querySelector('.ll_body').scrollTop = 0;
    });
    sheet.querySelector('.ll_body').addEventListener('click', onBodyClick);
    sheet.querySelector('.ll_body').addEventListener('input', e => {
        if (!e.target.matches('.ll_search')) return;
        view.query = e.target.value;
        renderStatsList();
    });
    sheet.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.matches('[role="button"],[role="tab"],.ll_row_head')) { e.preventDefault(); e.target.click(); }
    });
    wireSwipeDown();

    layer.append(backdrop, sheet);
    document.body.append(layer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) closeSheet(); });
    const vv = window.visualViewport;
    vv?.addEventListener('resize', placeSheet);
    vv?.addEventListener('scroll', placeSheet);
    window.addEventListener('resize', placeSheet);
}

/** Keep the sheet inside the visible area (above the on-screen keyboard). */
function placeSheet() {
    if (!layer) return;
    const vv = window.visualViewport;
    const de = document.documentElement;
    const top = vv ? vv.offsetTop : 0;
    const h = vv ? vv.height : (de.clientHeight || innerHeight);
    layer.style.top = `${Math.round(top)}px`;
    layer.style.height = `${Math.round(h)}px`;
    layer.style.setProperty('--ll-vh', `${Math.round(h)}px`);
}

let lastSeen = null;

function openSheet(tab) {
    if (!sheet) return;
    // Something new since the sheet was last opened: show the newest scan's entries.
    if (history[0] && history[0].id !== lastSeen) {
        view.index = 0;
        view.tab = 'hit';
        view.open.clear();
    }
    lastSeen = history[0]?.id ?? null;
    if (tab) view.tab = tab;
    alertState = '';
    updateButton();
    render();
    placeSheet();
    layer.classList.add('ll_open');
    sheet.classList.add('ll_open');
    sheet.style.removeProperty('--ll-drag');
}

function closeSheet() {
    if (!isOpen()) return;
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    sheet.classList.remove('ll_open');
    layer.classList.remove('ll_open');
    sheet.style.removeProperty('--ll-drag');
}

const toggleSheet = () => (isOpen() ? closeSheet() : openSheet());

function step(d) {
    const i = clamp(view.index + d, 0, Math.max(0, history.length - 1));
    if (i === view.index) return;
    view.index = i;
    view.open.clear();
    render();
}

/** Drag the grab bar (or header) down to close — like a native bottom sheet. */
function wireSwipeDown() {
    let s = null;
    const targets = [sheet.querySelector('.ll_grab'), sheet.querySelector('.ll_head')];
    const down = e => {
        if (e.button > 0 || e.target.closest('.ll_iconbtn')) return;
        s = { y: e.clientY, id: e.pointerId, t: performance.now(), el: e.currentTarget };
    };
    const move = e => {
        if (!s || e.pointerId !== s.id) return;
        const dy = Math.max(0, e.clientY - s.y);
        if (dy > 4) {
            try { s.el.setPointerCapture(s.id); } catch { /* ignore */ }
            sheet.classList.add('ll_dragging');
            sheet.style.setProperty('--ll-drag', `${dy}px`);
        }
    };
    const up = e => {
        if (!s || e.pointerId !== s.id) return;
        const dy = Math.max(0, e.clientY - s.y);
        const fast = dy / Math.max(1, performance.now() - s.t) > 0.6;
        sheet.classList.remove('ll_dragging');
        s = null;
        if (dy > 90 || (fast && dy > 30)) closeSheet(); else sheet.style.removeProperty('--ll-drag');
    };
    for (const t of targets) {
        t.addEventListener('pointerdown', down);
        t.addEventListener('pointermove', move);
        t.addEventListener('pointerup', up);
        t.addEventListener('pointercancel', up);
    }
}

// ---------------------------------------------------------------- rendering

function srcLabel(src) {
    if (!src) return '';
    switch (src.type) {
        case 'mes': return `ข้อความ #${src.mesId} · ${src.who === 'user' ? 'ผู้ใช้' : 'บอท'}`;
        case 'far': return `ข้อความ #${src.mesId} (เกินระยะสแกนปกติ)`;
        case 'reasoning': return `reasoning ของข้อความ #${src.mesId}`;
        case 'global': return src.label;
        case 'inject': return src.label;
        case 'rec': return `เนื้อหาของ “${src.label}” (recursion)`;
        default: return '';
    }
}

function srcIcon(src) {
    switch (src?.type) {
        case 'mes': case 'far': return src.who === 'user' ? 'fa-solid fa-user' : 'fa-solid fa-robot';
        case 'reasoning': return 'fa-solid fa-brain';
        case 'rec': return 'fa-solid fa-arrows-rotate';
        case 'inject': return 'fa-solid fa-note-sticky';
        case 'global': return 'fa-solid fa-id-card';
        default: return 'fa-solid fa-circle';
    }
}

const snipHTML = p => (p?.snip ? `<div class="ll_snip">${esc(p.snip[0])}<mark>${esc(p.snip[1])}</mark>${esc(p.snip[2])}</div>` : '');

function keyChips(rec) {
    const chips = [];
    if (rec.prim) chips.push(`<span class="ll_chip ll_prim${rec.prim.warn ? ' ll_warnchip' : ''}" title="คีย์หลักที่ทำให้ติด${rec.prim.warn ? ' — เจออยู่กลางคำอื่น อาจติดผิดคำ' : ''}"><i class="fa-solid fa-key"></i>${esc(rec.prim.key)}${rec.prim.warn ? ' ⚠' : ''}</span>`);
    for (const s of rec.sec ?? []) {
        if (s.ok) chips.push(`<span class="ll_chip ll_secok" title="คีย์รองที่เจอ">+ ${esc(s.key)}</span>`);
    }
    return chips.join('');
}

function reasonBadge(rec) {
    const r = REASON[rec.reason] ?? REASON.unknown;
    return `<span class="ll_reason" title="${esc(r.th)}">${r.icon}</span>`;
}

function hitRowHTML(rec, kind) {
    const open = view.open.has(`${kind}:${rec.k}`);
    const why = kind !== 'hit' ? WHY[rec.why] ?? WHY.other : null;
    const lead = kind === 'hit' ? reasonBadge(rec) : `<span class="ll_reason ll_why" title="${esc(why.th)}"><i class="${why.icon}"></i></span>`;
    const loopBadge = rec.state === 2 || (rec.loop > 1 && rec.state !== 3) ? `<span class="ll_badge" title="ติดจาก recursion รอบที่ ${rec.loop}">R${rec.loop}</span>` : '';
    let sub = '';
    if (kind === 'hit') {
        sub = rec.reason === 'keyword' && rec.prim
            ? `${keyChips(rec)}<span class="ll_src"><i class="${srcIcon(rec.prim.src)}"></i>${esc(srcLabel(rec.prim.src))}</span>`
            : `<span class="ll_src">${esc(REASON[rec.reason]?.th ?? '')}</span>`;
    } else {
        sub = `<span class="ll_src ll_whytext">${esc(why.th)}${rec.group ? ` (${esc(rec.group)})` : ''}</span>${rec.prim ? keyChips(rec) : ''}`;
    }
    return `<div class="ll_row${open ? ' ll_isopen' : ''}" data-k="${esc(rec.k)}" data-kind="${kind}">
        <div class="ll_row_head" role="button" tabindex="0" aria-expanded="${open}">
            ${lead}
            <div class="ll_row_main">
                <div class="ll_row_title">${esc(rec.title)}${loopBadge}</div>
                <div class="ll_row_sub">${sub}</div>
            </div>
            <i class="fa-solid fa-chevron-down ll_caret"></i>
        </div>
        ${open ? detailHTML(rec, kind) : ''}
    </div>`;
}

function detailHTML(rec, kind) {
    const parts = [];
    if (rec.prim) {
        parts.push(`<div class="ll_dl"><span>เจอที่</span><div><i class="${srcIcon(rec.prim.src)}"></i> ${esc(srcLabel(rec.prim.src))}</div></div>`);
        parts.push(snipHTML(rec.prim));
        if (rec.prim.warn === 'midword') parts.push('<div class="ll_note ll_warn"><i class="fa-solid fa-triangle-exclamation"></i> คีย์นี้ไปเจออยู่กลางคำอื่น (ตัวตัดคำไทยของเบราว์เซอร์ไม่ได้ตัดตรงขอบคีย์) อาจเป็นการติดผิดคำ — ลองใช้คีย์ที่ยาวขึ้น หรือเขียนเป็น /regex/</div>');
    } else if (rec.reason === 'unknown') {
        parts.push('<div class="ll_note">หาคีย์ในข้อความที่สแกนไม่เจอ อาจเพราะ regex ของ prompt, ไฟล์แนบ หรือ extension อื่นสั่งให้ติด</div>');
    }
    const primKey = rec.prim?.key;
    if (rec.keys?.length) {
        parts.push(`<div class="ll_dl"><span>คีย์หลัก</span><div class="ll_chips">${rec.keys.map(k => {
            const on = primKey && subst(k).trim() === primKey;
            return `<span class="ll_chip ${on ? 'll_prim' : 'll_dim'}">${esc(k)}</span>`;
        }).join('')}</div></div>`);
    }
    if (rec.sec?.length) {
        parts.push(`<div class="ll_dl"><span>คีย์รอง<br><small>${esc(LOGIC[rec.logic] ?? '')}</small></span><div><div class="ll_chips">${rec.sec.map(s => `<span class="ll_chip ${s.ok ? 'll_secok' : 'll_dim'}" title="${s.ok ? 'เจอในข้อความ' : 'ไม่เจอ'}">${s.ok ? '✓' : '✗'} ${esc(s.key)}</span>`).join('')}</div><small class="ll_logic">${esc(LOGIC_TH[rec.logic] ?? '')}</small></div></div>`);
    }
    if (kind === 'hit') parts.push(`<div class="ll_dl"><span>สาเหตุ</span><div>${reasonBadge(rec)} ${esc(REASON[rec.reason]?.th ?? '')}${rec.loop > 1 ? ` · สแกนรอบที่ ${rec.loop}${rec.state === 3 ? ' (min activations)' : ''}` : ''}</div></div>`);
    parts.push(`<div class="ll_dl"><span>Lorebook</span><div>${esc(rec.world)} <small>· uid ${esc(rec.uid)}</small></div></div>`);
    parts.push(`<div class="ll_content" data-world="${esc(rec.world)}" data-uid="${esc(rec.uid)}"><i class="fa-solid fa-spinner fa-spin"></i></div>`);
    parts.push(`<div class="ll_actions">
        <div class="menu_button ll_act" data-act="open-entry"><i class="fa-solid fa-pen-to-square"></i> เปิดใน lorebook</div>
        <div class="menu_button ll_act" data-act="copy-entry"><i class="fa-regular fa-copy"></i> คัดลอก</div>
    </div>`);
    return `<div class="ll_detail">${parts.join('')}</div>`;
}

function groupHTML(list, kind) {
    if (!settings().groupByBook) return list.map(r => hitRowHTML(r, kind)).join('');
    const groups = new Map();
    for (const r of list) {
        if (!groups.has(r.world)) groups.set(r.world, []);
        groups.get(r.world).push(r);
    }
    return [...groups].map(([world, rows]) => `<div class="ll_book"><i class="fa-solid fa-book"></i> ${esc(world)} <span>${rows.length}</span></div>${rows.map(r => hitRowHTML(r, kind)).join('')}`).join('');
}

function render() {
    if (!sheet) return;
    const scan = history[view.index];
    const when = sheet.querySelector('.ll_when');
    if (scan) {
        when.innerHTML = `<b>${view.index === 0 ? 'ล่าสุด' : `ย้อนหลัง ${view.index}`}</b> · ${esc(fmtTime(scan.ts))} · ${esc(GEN_TH[scan.genType] ?? scan.genType)}<small>${view.index + 1}/${history.length}</small>`;
    } else {
        when.innerHTML = '<b>ยังไม่มีข้อมูล</b>';
    }
    sheet.querySelector('.ll_prev').classList.toggle('ll_disabled', view.index >= history.length - 1);
    sheet.querySelector('.ll_next').classList.toggle('ll_disabled', view.index <= 0);
    sheet.querySelector('.ll_nav').classList.toggle('ll_hidenav', view.tab === 'stats' || view.tab === 'report');
    const nearN = scan?.near == null ? '…' : scan.near.length + scan.cuts.length;
    sheet.querySelectorAll('.ll_tab').forEach(t => {
        t.classList.toggle('ll_active', t.dataset.tab === view.tab);
        t.setAttribute('aria-selected', String(t.dataset.tab === view.tab));
        const n = t.querySelector('.ll_n');
        if (n) n.textContent = scan ? (t.dataset.tab === 'hit' ? scan.hits.length : nearN) : '';
    });

    const body = sheet.querySelector('.ll_body');
    if (view.tab === 'stats') { renderStats(body); return; }
    if (view.tab === 'report') { renderReport(body); return; }
    if (!scan) {
        body.innerHTML = `<div class="ll_empty"><i class="fa-solid fa-book-atlas"></i><div>${chatId ? 'ส่งข้อความหรือ swipe หนึ่งครั้ง<br>Lore Lens จะแสดงเอนทรีที่ติดและคีย์ที่ทำให้ติด' : 'เปิดแชทก่อน'}</div></div>`;
        return;
    }
    if (view.tab === 'hit') {
        const summary = [];
        const bySrc = { user: 0, bot: 0, rec: 0, other: 0 };
        for (const h of scan.hits) {
            const t = h.prim?.src?.type;
            if (t === 'mes') bySrc[h.prim.src.who]++;
            else if (t === 'rec') bySrc.rec++;
            else bySrc.other++;
        }
        summary.push(`<span class="ll_pill"><b>${scan.hits.length}</b> เอนทรี</span>`);
        if (bySrc.user) summary.push(`<span class="ll_pill"><i class="fa-solid fa-user"></i> ${bySrc.user}</span>`);
        if (bySrc.bot) summary.push(`<span class="ll_pill"><i class="fa-solid fa-robot"></i> ${bySrc.bot}</span>`);
        if (bySrc.rec) summary.push(`<span class="ll_pill"><i class="fa-solid fa-arrows-rotate"></i> ${bySrc.rec}</span>`);
        if (scan.loops > 1) summary.push(`<span class="ll_pill" title="จำนวนรอบการสแกน (recursion)">${scan.loops} รอบ</span>`);
        if (scan.overflow) summary.push('<span class="ll_pill ll_bad" title="มีเอนทรีถูกตัดเพราะงบ token ของ World Info เต็ม"><i class="fa-solid fa-triangle-exclamation"></i> งบเต็ม</span>');
        const list = scan.hits.length
            ? groupHTML(scan.hits, 'hit')
            : `<div class="ll_empty ll_small">ไม่มีเอนทรีไหนติดในการสแกนครั้งนี้${scan.cuts.length ? `<br><small>มี ${scan.cuts.length} เอนทรีถูกตัดออก — ดูแท็บ “เกือบติด”</small>` : ''}</div>`;
        const at = scan.msg ? locateMessage(scan.msg) : -1;
        const link = at >= 0
            ? `<div class="ll_msglink" role="button" tabindex="0" data-act="rep-open" data-i="${at}" data-s="${scan.msg.swipe}"><i class="fa-solid fa-reply fa-flip-horizontal"></i> คำตอบที่ได้: ข้อความ #${at}${scan.msg.swipe ? ` · swipe ${scan.msg.swipe + 1}` : ''}<span>ดูรายงาน <i class="fa-solid fa-chevron-right"></i></span></div>`
            : '';
        body.innerHTML = `${link}<div class="ll_summary">${summary.join('')}<span class="ll_legend" title="🟢 คีย์เวิร์ด · 🔵 constant · 📌 sticky · ⚡ ถูกสั่งให้ติด · 🔗 vector · R2 = ติดจาก recursion รอบที่ 2">?</span></div>${list}`;
    } else {
        if (scan.near == null) {
            body.innerHTML = '<div class="ll_empty ll_small"><i class="fa-solid fa-spinner fa-spin"></i> กำลังวิเคราะห์…</div>';
            return;
        }
        const cuts = scan.cuts.length ? `<div class="ll_section">ถูกตัดออกจาก prompt</div>${groupHTML(scan.cuts, 'cut')}` : '';
        const near = scan.near.length ? `<div class="ll_section">คีย์หลักตรง แต่ไม่ติด</div>${groupHTML(scan.near, 'near')}` : '';
        body.innerHTML = cuts || near
            ? `<div class="ll_note">เอนทรีที่คีย์หลักตรงกับข้อความ แต่ไม่ได้เข้า prompt ใช้ดูว่าคีย์รอง, group หรืองบ token กันอะไรไว้บ้าง</div>${cuts}${near}`
            : `<div class="ll_empty ll_small">${settings().nearMiss ? 'ไม่มีเอนทรีที่เกือบติด' : 'ปิดการวิเคราะห์ “เกือบติด” อยู่ (เปิดได้ในหน้าตั้งค่า)'}</div>`;
    }
    body.querySelectorAll('.ll_content').forEach(fillContent);
}

// ---------------------------------------------------------------- stats

function aggregate() {
    const m = new Map();
    const touch = (r) => {
        if (!m.has(r.k)) m.set(r.k, { k: r.k, world: r.world, uid: r.uid, title: r.title, keys: r.keys ?? [], hits: 0, keyCount: {}, src: { user: 0, bot: 0, rec: 0, other: 0 }, near: 0, nearWhy: {}, reasons: {} });
        const a = m.get(r.k);
        a.title = a.title || r.title;
        return a;
    };
    for (const scan of history) {
        for (const h of scan.hits) {
            const a = touch(h);
            a.hits++;
            a.reasons[h.reason] = (a.reasons[h.reason] ?? 0) + 1;
            if (h.prim && h.reason === 'keyword') {
                a.keyCount[h.prim.key] = (a.keyCount[h.prim.key] ?? 0) + 1;
                const t = h.prim.src?.type;
                if (t === 'mes' || t === 'far') a.src[h.prim.src.who]++; else if (t === 'rec') a.src.rec++; else a.src.other++;
            }
        }
        for (const n of [...(scan.near ?? []), ...scan.cuts]) {
            const a = touch(n);
            a.near++;
            a.nearWhy[n.why] = (a.nearWhy[n.why] ?? 0) + 1;
        }
    }
    const seen = new Set(m.keys());
    const never = catalog.filter(c => !seen.has(c.k));
    return { entries: [...m.values()], never };
}

function renderStats(body) {
    if (!history.length) {
        body.innerHTML = '<div class="ll_empty"><i class="fa-solid fa-chart-simple"></i><div>ยังไม่มีประวัติในแชทนี้</div></div>';
        return;
    }
    const first = history.at(-1).ts;
    body.innerHTML = `
        <div class="ll_note">จาก <b>${history.length}</b> ครั้งที่สแกนในแชทนี้ (ตั้งแต่ ${esc(fmtDate(first))}) · เก็บในเบราว์เซอร์นี้เท่านั้น ไม่ได้เขียนลงไฟล์แชท</div>
        <input type="search" class="text_pole ll_search" placeholder="ค้นหาเอนทรีหรือคีย์…" value="${esc(view.query)}" enterkeyhint="search">
        <div class="ll_statlist"></div>
        <div class="ll_actions ll_export">
            <div class="menu_button ll_act" data-act="copy-md"><i class="fa-regular fa-copy"></i> คัดลอกรายงาน</div>
            <div class="menu_button ll_act" data-act="dl-json"><i class="fa-solid fa-download"></i> JSON</div>
            <div class="menu_button ll_act" data-act="dl-md"><i class="fa-solid fa-file-lines"></i> .md</div>
            <div class="menu_button ll_act" data-act="rep-all" title="รายงานรายข้อความ: คำตอบ, CoT, เอนทรีที่ติดและเกือบติด ของทุกข้อความในแชทนี้"><i class="fa-solid fa-file-export"></i> รายงานทุกข้อความ</div>
            <div class="menu_button ll_act ll_danger" data-act="clear-chat"><i class="fa-solid fa-trash"></i> ล้างประวัติแชทนี้</div>
        </div>`;
    renderStatsList();
}

function renderStatsList() {
    const box = sheet?.querySelector('.ll_statlist');
    if (!box) return;
    const { entries, never } = aggregate();
    const q = view.query.trim().toLowerCase();
    const match = a => !q || a.title.toLowerCase().includes(q) || a.world.toLowerCase().includes(q) || (a.keys ?? []).some(k => String(k).toLowerCase().includes(q)) || Object.keys(a.keyCount ?? {}).some(k => k.toLowerCase().includes(q));
    const total = history.length;
    const hit = entries.filter(a => a.hits && match(a)).sort((a, b) => b.hits - a.hits || a.title.localeCompare(b.title));
    const near = entries.filter(a => !a.hits && a.near && match(a)).sort((a, b) => b.near - a.near);
    const nev = never.filter(match);

    const bar = n => `<span class="ll_bar"><span style="width:${Math.round((n / total) * 100)}%"></span></span>`;
    const keyList = a => Object.entries(a.keyCount).sort((x, y) => y[1] - x[1]).map(([k, n]) => `<span class="ll_chip ll_prim">${esc(k)} <b>×${n}</b></span>`).join('');
    const srcLine = a => [
        a.src.user ? `<span><i class="fa-solid fa-user"></i> ${a.src.user}</span>` : '',
        a.src.bot ? `<span><i class="fa-solid fa-robot"></i> ${a.src.bot}</span>` : '',
        a.src.rec ? `<span><i class="fa-solid fa-arrows-rotate"></i> ${a.src.rec}</span>` : '',
        a.reasons.constant ? `<span>🔵 ${a.reasons.constant}</span>` : '',
        a.reasons.sticky ? `<span>📌 ${a.reasons.sticky}</span>` : '',
    ].join('');
    const unused = a => (a.keys ?? []).filter(k => !a.keyCount[subst(k).trim()]);

    let html = `<div class="ll_section">ติดบ่อย <span>${hit.length}</span></div>`;
    html += hit.length ? hit.map(a => `<div class="ll_stat">
        <div class="ll_stat_head"><span class="ll_stat_title">${esc(a.title)}</span><span class="ll_stat_n">${a.hits}/${total}</span></div>
        ${bar(a.hits)}
        <div class="ll_chips">${keyList(a)}${unused(a).length ? `<span class="ll_chip ll_dim" title="คีย์ที่ไม่เคยเป็นตัวทำให้ติด">ไม่เคยใช้: ${esc(unused(a).join(', '))}</span>` : ''}</div>
        <div class="ll_stat_src"><small>${esc(a.world)}</small>${srcLine(a)}</div>
    </div>`).join('') : '<div class="ll_note">—</div>';

    if (near.length) {
        html += `<div class="ll_section">เกือบติดแต่ไม่เคยติด <span>${near.length}</span></div>`;
        html += near.map(a => `<div class="ll_stat">
            <div class="ll_stat_head"><span class="ll_stat_title">${esc(a.title)}</span><span class="ll_stat_n">${a.near}×</span></div>
            <div class="ll_stat_src"><small>${esc(a.world)}</small>${Object.entries(a.nearWhy).map(([w, n]) => `<span><i class="${(WHY[w] ?? WHY.other).icon}"></i> ${esc((WHY[w] ?? WHY.other).th)} ${n}</span>`).join('')}</div>
        </div>`).join('');
    }

    html += `<div class="ll_section">ไม่เคยติดเลย <span>${catalog.length ? nev.length : '?'}</span></div>`;
    html += catalog.length
        ? (nev.length ? nev.map(c => `<div class="ll_stat ll_never"><div class="ll_stat_head"><span class="ll_stat_title">${esc(c.title)}</span></div><div class="ll_chips">${c.keys.map(k => `<span class="ll_chip ll_dim">${esc(k)}</span>`).join('')}</div><div class="ll_stat_src"><small>${esc(c.world)}</small></div></div>`).join('') : '<div class="ll_note">ทุกเอนทรีที่มีคีย์เคยติดแล้ว</div>')
        : '<div class="ll_note">จะแสดงหลังการสแกนครั้งถัดไป (ต้องรู้รายชื่อเอนทรีใน lorebook ที่เปิดอยู่ก่อน)</div>';
    box.innerHTML = html;
}

function reportMarkdown() {
    const { entries, never } = aggregate();
    const total = history.length;
    const c = ctx();
    const who = c.groupId ? (c.groups?.find(g => g.id == c.groupId)?.name ?? 'group') : (c.name2 ?? '');
    const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [
        `# Lore Lens — ${who}`,
        '',
        `แชท: ${chatId} · ${total} ครั้งที่สแกน · ${fmtDate(history.at(-1)?.ts ?? Date.now())} – ${fmtDate(history[0]?.ts ?? Date.now())}`,
        '',
        '## เอนทรีที่ติด',
        '',
        '| เอนทรี | Lorebook | ติด | คีย์ที่ทำให้ติด | คีย์ที่ไม่เคยใช้ |',
        '|---|---|---|---|---|',
    ];
    for (const a of entries.filter(x => x.hits).sort((x, y) => y.hits - x.hits)) {
        const used = Object.entries(a.keyCount).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
        const unused = (a.keys ?? []).filter(k => !a.keyCount[subst(k).trim()]).join(', ');
        const other = Object.entries(a.reasons).filter(([r]) => r !== 'keyword').map(([r, n]) => `${REASON[r]?.th ?? r} ×${n}`).join(', ');
        lines.push(`| ${cell(a.title)} | ${cell(a.world)} | ${a.hits}/${total} | ${cell([used, other].filter(Boolean).join('; '))} | ${cell(unused)} |`);
    }
    const near = entries.filter(x => !x.hits && x.near);
    if (near.length) {
        lines.push('', '## เกือบติด (คีย์หลักตรงแต่ไม่เข้า prompt)', '', '| เอนทรี | Lorebook | ครั้ง | สาเหตุ |', '|---|---|---|---|');
        for (const a of near.sort((x, y) => y.near - x.near)) {
            lines.push(`| ${cell(a.title)} | ${cell(a.world)} | ${a.near} | ${cell(Object.entries(a.nearWhy).map(([w, n]) => `${(WHY[w] ?? WHY.other).th} ×${n}`).join(', '))} |`);
        }
    }
    if (never.length) {
        lines.push('', '## ไม่เคยติด', '', '| เอนทรี | Lorebook | คีย์ |', '|---|---|---|');
        for (const n of never) lines.push(`| ${cell(n.title)} | ${cell(n.world)} | ${cell(n.keys.join(', '))} |`);
    }
    const warn = [];
    for (const scan of history) for (const h of scan.hits) if (h.prim?.warn === 'midword') warn.push(`- **${h.prim.key}** → ${h.title}: “${h.prim.snip.join('')}”`);
    if (warn.length) lines.push('', '## คีย์ที่อาจติดกลางคำอื่น', '', ...[...new Set(warn)].slice(0, 40));
    return lines.join('\n');
}

// ---------------------------------------------------------------- per-message report

const POS_TH = ['ก่อน Char Defs', 'หลัง Char Defs', "บน Author's Note", "ล่าง Author's Note", '@ความลึก', 'ก่อน Examples', 'หลัง Examples', 'Outlet'];
const posLabel = r => (r.pos == null ? '' : r.pos === 4 ? `@D${r.depth ?? 4}` : POS_TH[r.pos] ?? `pos ${r.pos}`);

/** Index of the message a scan was linked to (by send date, then by position). */
function locateMessage(link) {
    const chat = ctx().chat ?? [];
    if (link.date) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m.is_user) continue;
            if (String(m.send_date ?? '') === link.date) return i;
            if (Array.isArray(m.swipe_info) && m.swipe_info.some(x => String(x?.send_date ?? '') === link.date)) return i;
        }
    }
    const m = chat[link.id];
    return m && !m.is_user ? link.id : -1;
}

function swipeDate(m, sw) {
    if (sw === Number(m.swipe_id ?? 0)) return String(m.send_date ?? '');
    return String(m.swipe_info?.[sw]?.send_date ?? '');
}

/** Scans that produced message `i`, swipe `sw` (oldest first — e.g. the reply, then a “continue”). */
function scansFor(i, sw) {
    const m = ctx().chat?.[i];
    if (!m) return [];
    const date = swipeDate(m, sw);
    let list = date ? history.filter(h => h.msg && h.msg.date === date) : [];
    if (!list.length) list = history.filter(h => h.msg && h.msg.id === i && h.msg.swipe === sw && locateMessage(h.msg) === i);
    return list.slice().sort((a, b) => a.ts - b.ts);
}

function swipesWithScans(i) {
    const m = ctx().chat?.[i];
    if (!m) return [];
    const n = Array.isArray(m.swipes) ? m.swipes.length : 1;
    const out = [];
    for (let sw = 0; sw < n; sw++) if (scansFor(i, sw).length) out.push(sw);
    return out;
}

function neighbourReply(i, dir) {
    const chat = ctx().chat ?? [];
    for (let j = i + dir; j >= 0 && j < chat.length; j += dir) if (!chat[j].is_user && !chat[j].is_system) return j;
    return null;
}

function dateLabel(v) {
    if (v == null || v === '') return '';
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? fmtDate(t) : String(v);
}

function reportData(i, sw) {
    const chat = ctx().chat ?? [];
    const m = chat[i];
    if (!m) return null;
    sw = sw ?? Number(m.swipe_id ?? 0);
    const current = sw === Number(m.swipe_id ?? 0);
    const text = current ? String(m.mes ?? '') : String(m.swipes?.[sw] ?? '');
    const extra = current ? m.extra : m.swipe_info?.[sw]?.extra;
    let prev = null;
    for (let j = i - 1; j >= 0; j--) if (chat[j].is_user && !chat[j].is_system) { prev = { i: j, name: chat[j].name, text: String(chat[j].mes ?? '') }; break; }
    return {
        i,
        sw,
        swipes: Array.isArray(m.swipes) ? m.swipes.length : 1,
        name: m.name,
        isUser: !!m.is_user,
        date: current ? m.send_date : m.swipe_info?.[sw]?.send_date,
        model: extra?.model || '',
        api: extra?.api || '',
        text,
        reasoning: String(extra?.reasoning ?? ''),
        prev,
        scans: scansFor(i, sw),
    };
}

/** Does the reply (or its CoT) mention this entry? Returns the key that was found. */
function mentionIn(rec, text) {
    if (!text) return null;
    const keys = [...new Set([rec.prim?.key, ...(rec.keys ?? []).map(k => subst(k).trim())].filter(Boolean))];
    for (const k of keys) if (findKey(text, k, { cs: false, ww: false })) return k;
    return null;
}

/** Escape `text`, wrapping every occurrence of the given keys in <mark>. */
function highlight(text, keys) {
    const ranges = [];
    for (const k of keys.slice(0, 40)) {
        const rx = parseRegexKey(k);
        let r;
        try { r = rx ? new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`) : new RegExp(escapeRegex(k), 'gi'); } catch { continue; }
        for (const m of text.matchAll(r)) {
            if (!m[0]) break;
            ranges.push([m.index, m.index + m[0].length]);
            if (ranges.length > 400) break;
        }
    }
    if (!ranges.length) return esc(text);
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '', at = 0;
    for (const [a, b] of ranges) {
        if (a < at) continue;
        out += `${esc(text.slice(at, a))}<mark>${esc(text.slice(a, b))}</mark>`;
        at = b;
    }
    return out + esc(text.slice(at));
}

const hitKeys = scans => [...new Set(scans.flatMap(sc => sc.hits.flatMap(h => [h.prim?.key, ...(h.keys ?? []).map(k => subst(k).trim())])).filter(Boolean))];

function openReport(i, sw) {
    const m = ctx().chat?.[i];
    if (!m) { toast.warn('ไม่พบข้อความนี้'); return; }
    view.report = { i, s: sw ?? Number(m.swipe_id ?? 0) };
    if (isOpen()) { view.tab = 'report'; render(); sheet.querySelector('.ll_body').scrollTop = 0; } else openSheet('report');
}

function mentionBadges(rec, d) {
    const a = mentionIn(rec, d.text), b = mentionIn(rec, d.reasoning);
    const out = [];
    if (a) out.push(`<span class="ll_ment" title="คำตอบมีคำว่า “${esc(a)}”"><i class="fa-solid fa-comment"></i> ${esc(a)}</span>`);
    if (b) out.push(`<span class="ll_ment" title="CoT มีคำว่า “${esc(b)}”"><i class="fa-solid fa-brain"></i> ${esc(b)}</span>`);
    return { html: out.join(''), any: !!(a || b) };
}

function repRowHTML(rec, kind, d, scanIdx) {
    const why = kind === 'hit' ? null : WHY[rec.why] ?? WHY.other;
    const lead = kind === 'hit' ? reasonBadge(rec) : `<span class="ll_reason ll_why" title="${esc(why.th)}"><i class="${why.icon}"></i></span>`;
    const ment = mentionBadges(rec, d);
    const flag = kind !== 'hit' && ment.any ? ' ll_rep_gap' : '';
    const sub = kind === 'hit'
        ? (rec.reason === 'keyword' && rec.prim ? `${keyChips(rec)}<span class="ll_src"><i class="${srcIcon(rec.prim.src)}"></i>${esc(srcLabel(rec.prim.src))}</span>` : `<span class="ll_src">${esc(REASON[rec.reason]?.th ?? '')}</span>`)
        : `<span class="ll_src ll_whytext">${esc(why.th)}</span>${rec.prim ? keyChips(rec) : ''}`;
    const pos = kind === 'hit' && posLabel(rec) ? `<span class="ll_src"><i class="fa-solid fa-location-dot"></i>${esc(posLabel(rec))}</span>` : '';
    return `<div class="ll_rep_row${flag}">
        <div class="ll_rep_line">${lead}<b>${esc(rec.title)}</b>${rec.loop > 1 && rec.state !== 3 && kind === 'hit' ? `<span class="ll_badge">R${rec.loop}</span>` : ''}</div>
        <div class="ll_row_sub">${sub}${pos}</div>
        ${rec.prim?.snip ? `<div class="ll_snip ll_snip_sm">${esc(rec.prim.snip[0])}<mark>${esc(rec.prim.snip[1])}</mark>${esc(rec.prim.snip[2])}</div>` : ''}
        ${ment.html ? `<div class="ll_row_sub">${flag ? '<span class="ll_src ll_gaptext"><i class="fa-solid fa-triangle-exclamation"></i> คำตอบพูดถึง แต่เอนทรีไม่ได้เข้า prompt</span>' : '<span class="ll_src">คำตอบพูดถึง</span>'}${ment.html}</div>` : ''}
        ${kind === 'hit' ? `<details class="ll_rep_content" data-scan="${scanIdx}" data-k="${esc(rec.k)}"><summary>เนื้อหาที่ใส่ใน prompt</summary><div class="ll_content_text">${rec.content ? esc(rec.content) : '<i class="fa-solid fa-spinner fa-spin"></i>'}</div></details>` : ''}
    </div>`;
}

/** Keyed entries (from the active lorebooks) the reply talks about although the scan never matched them. */
function otherMentions(d) {
    if (!catalog.length || !d.scans.length) return [];
    const seen = new Set(d.scans.flatMap(sc => [...sc.hits, ...sc.cuts, ...(sc.near ?? [])].map(r => r.k)));
    return catalog.filter(c => !seen.has(c.k) && (mentionIn(c, d.text) || mentionIn(c, d.reasoning))).slice(0, 30);
}

function renderReport(body) {
    const { i, s: sw } = view.report ?? {};
    const d = i == null ? null : reportData(i, sw);
    if (!d) { body.innerHTML = '<div class="ll_empty ll_small">ไม่พบข้อความ</div>'; return; }
    const keys = hitKeys(d.scans);
    const other = swipesWithScans(i).filter(x => x !== d.sw);
    const meta = [
        d.swipes > 1 ? `swipe ${d.sw + 1}/${d.swipes}` : '',
        esc(dateLabel(d.date)),
        d.model ? esc(d.model) : '',
    ].filter(Boolean).join(' · ');

    let scansHTML = '';
    if (!d.scans.length) {
        scansHTML = `<div class="ll_empty ll_small">ไม่มีผลสแกนของ${d.isUser ? 'ข้อความผู้ใช้ (รายงานมีเฉพาะคำตอบของบอท)' : 'คำตอบนี้'}<br><small>ข้อความที่เจนก่อนติดตั้ง Lore Lens, เจนบนเครื่องอื่น หรือเกินจำนวนที่เก็บย้อนหลัง จะไม่มีข้อมูล</small>${other.length ? `<div class="ll_actions ll_center">${other.map(x => `<div class="menu_button ll_act" data-act="rep-swipe" data-s="${x}">ดู swipe ${x + 1}</div>`).join('')}</div>` : ''}</div>`;
    }
    d.scans.forEach((sc, n) => {
        const idx = history.indexOf(sc);
        const hitM = sc.hits.filter(h => mentionIn(h, d.text) || mentionIn(h, d.reasoning)).length;
        const miss = [...sc.cuts, ...(sc.near ?? [])];
        const gap = miss.filter(r => mentionIn(r, d.text) || mentionIn(r, d.reasoning)).length;
        scansHTML += `<div class="ll_section">World Info${d.scans.length > 1 ? ` · สแกนครั้งที่ ${n + 1}` : ''} · ${esc(GEN_TH[sc.genType] ?? sc.genType)} · ${esc(fmtTime(sc.ts))}</div>
            <div class="ll_summary">
                <span class="ll_pill"><b>${sc.hits.length}</b> ติด</span>
                <span class="ll_pill" title="เอนทรีที่ติด ซึ่งคำตอบหรือ CoT มีคีย์ของมัน"><i class="fa-solid fa-comment"></i> พูดถึง ${hitM}/${sc.hits.length}</span>
                <span class="ll_pill">${sc.near == null ? '…' : miss.length} เกือบติด</span>
                ${gap ? `<span class="ll_pill ll_warnpill" title="คำตอบพูดถึงเรื่องที่มีเอนทรี แต่เอนทรีนั้นไม่ได้เข้า prompt"><i class="fa-solid fa-triangle-exclamation"></i> ${gap}</span>` : ''}
                ${sc.overflow ? '<span class="ll_pill ll_bad"><i class="fa-solid fa-triangle-exclamation"></i> งบเต็ม</span>' : ''}
            </div>
            ${sc.hits.map(h => repRowHTML(h, 'hit', d, idx)).join('') || '<div class="ll_note">ไม่มีเอนทรีติด</div>'}
            ${miss.length ? `<div class="ll_section ll_sub">เกือบติด / ถูกตัด</div>${miss.map(r => repRowHTML(r, r.why === 'budget' || r.why === 'prob' ? 'cut' : 'near', d, idx)).join('')}` : ''}`;
    });

    const others = otherMentions(d);
    if (others.length) {
        scansHTML += `<div class="ll_section ll_sub">คำตอบพูดถึง แต่ไม่ได้ถูกสแกนเจอ <span>${others.length}</span></div>
            <div class="ll_note">เอนทรีใน lorebook ที่เปิดอยู่ ซึ่งคีย์ของมันอยู่ในคำตอบหรือ CoT แต่ไม่อยู่ในข้อความที่ถูกสแกนตอนเจน — โมเดลอาจแต่งรายละเอียดเองโดยไม่มี lore</div>
            ${others.map(c => {
                const ment = mentionBadges(c, d);
                return `<div class="ll_rep_row ll_rep_gap"><div class="ll_rep_line"><span class="ll_reason ll_why"><i class="fa-solid fa-circle-question"></i></span><b>${esc(c.title)}</b></div><div class="ll_row_sub"><span class="ll_src">${esc(c.world)}</span>${ment.html}</div></div>`;
            }).join('')}`;
    }
    const long = t => t.length > 1200;
    body.innerHTML = `
        <div class="ll_rep_head">
            <div class="ll_iconbtn" role="button" tabindex="0" data-act="rep-back" title="กลับ"><i class="fa-solid fa-arrow-left"></i></div>
            <div class="ll_rep_title"><b>ข้อความ #${d.i} · ${esc(d.name)}</b><small>${meta}</small></div>
            <div class="ll_iconbtn${neighbourReply(d.i, -1) == null ? ' ll_disabled' : ''}" role="button" tabindex="0" data-act="rep-prev" title="คำตอบก่อนหน้า"><i class="fa-solid fa-chevron-up"></i></div>
            <div class="ll_iconbtn${neighbourReply(d.i, 1) == null ? ' ll_disabled' : ''}" role="button" tabindex="0" data-act="rep-next" title="คำตอบถัดไป"><i class="fa-solid fa-chevron-down"></i></div>
        </div>
        <div class="ll_actions">
            <div class="menu_button ll_act" data-act="rep-copy"><i class="fa-regular fa-copy"></i> คัดลอกรายงาน</div>
            <div class="menu_button ll_act" data-act="rep-dl"><i class="fa-solid fa-download"></i> .md</div>
        </div>
        ${d.prev ? `<details class="ll_rep_block"><summary><i class="fa-solid fa-user"></i> ข้อความก่อนหน้า #${d.prev.i} · ${esc(d.prev.name)}</summary><div class="ll_rep_text">${highlight(d.prev.text, keys)}</div></details>` : ''}
        <details class="ll_rep_block"${long(d.text) ? '' : ' open'}><summary><i class="fa-solid fa-comment"></i> คำตอบ <small>${d.text.length.toLocaleString()} ตัวอักษร</small></summary><div class="ll_rep_text">${highlight(d.text, keys) || '<i>ว่าง</i>'}</div></details>
        ${d.reasoning ? `<details class="ll_rep_block"><summary><i class="fa-solid fa-brain"></i> Chain of thought <small>${d.reasoning.length.toLocaleString()} ตัวอักษร</small></summary><div class="ll_rep_text">${highlight(d.reasoning, keys)}</div></details>` : '<div class="ll_note"><i class="fa-solid fa-brain"></i> ข้อความนี้ไม่มี CoT แยกเก็บไว้</div>'}
        <div class="ll_note">คำที่ไฮไลต์ = คีย์ของเอนทรีที่ติด · 💬 = คำตอบ/CoT มีคีย์ของเอนทรีนั้น (ตรวจแบบคร่าว ๆ จากคีย์ ไม่ได้อ่านความหมาย)</div>
        ${scansHTML}`;
    body.querySelectorAll('.ll_rep_content').forEach(el => el.addEventListener('toggle', () => fillRepContent(el), { once: true }));
}

async function fillRepContent(el) {
    const div = el.querySelector('.ll_content_text');
    if (!div.querySelector('.fa-spinner')) return;
    const sc = history[Number(el.dataset.scan)];
    const rec = sc?.hits.find(h => h.k === el.dataset.k);
    const e = rec ? await entryContent(rec.world, rec.uid) : null;
    div.innerHTML = e ? `${esc(String(e.content ?? ''))}<small class="ll_meta">(เนื้อหาปัจจุบันใน lorebook — การสแกนนี้เก่ากว่าเวอร์ชันที่เก็บเนื้อหาไว้)</small>` : '<small>โหลดเนื้อหาไม่ได้</small>';
}

const fence = t => {
    const ticks = '`'.repeat(Math.max(3, ...[...String(t).matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${ticks}text\n${t}\n${ticks}`;
};
const cellMd = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

async function messageReportMarkdown(i, sw, { heading = '#' } = {}) {
    const d = reportData(i, sw);
    if (!d) return '';
    const h2 = `${heading}#`, h3 = `${heading}##`;
    const L = [
        `${heading} ข้อความ #${d.i} — ${d.name}`,
        '',
        [d.swipes > 1 ? `swipe ${d.sw + 1}/${d.swipes}` : '', dateLabel(d.date), d.model, d.api].filter(Boolean).join(' · '),
        '',
    ];
    if (d.prev) L.push(`${h2} ข้อความก่อนหน้า (#${d.prev.i} · ${d.prev.name})`, '', fence(d.prev.text), '');
    L.push(`${h2} คำตอบ`, '', fence(d.text), '');
    L.push(`${h2} Chain of thought`, '', d.reasoning ? fence(d.reasoning) : '_ไม่มี CoT แยกเก็บไว้_', '');
    if (!d.scans.length) {
        L.push(`${h2} World Info`, '', '_ไม่มีผลสแกนของข้อความนี้_', '');
        return L.join('\n');
    }
    for (const [n, sc] of d.scans.entries()) {
        const ment = r => [mentionIn(r, d.text) ? `💬 ${mentionIn(r, d.text)}` : '', mentionIn(r, d.reasoning) ? `🧠 ${mentionIn(r, d.reasoning)}` : ''].filter(Boolean).join(' ');
        L.push(`${h2} World Info${d.scans.length > 1 ? ` — สแกนครั้งที่ ${n + 1}` : ''} (${GEN_TH[sc.genType] ?? sc.genType}, ${fmtTime(sc.ts)})`, '');
        L.push(`ติด ${sc.hits.length} · สแกน ${sc.loops} รอบ${sc.overflow ? ' · **งบ token เต็ม**' : ''}`, '');
        L.push(`${h3} เอนทรีที่ติด`, '');
        if (sc.hits.length) {
            L.push('| | เอนทรี | Lorebook | ตำแหน่ง | คีย์ / สาเหตุ | เจอที่ | บริบท | คำตอบพูดถึง |', '|---|---|---|---|---|---|---|---|');
            for (const h of sc.hits) {
                const why = h.reason === 'keyword' && h.prim
                    ? `${h.prim.key}${h.sec?.filter(x => x.ok).length ? ` + ${h.sec.filter(x => x.ok).map(x => x.key).join(', ')}` : ''}${h.prim.warn ? ' ⚠ กลางคำ' : ''}`
                    : REASON[h.reason]?.th ?? h.reason;
                L.push(`| ${REASON[h.reason]?.icon ?? ''}${h.loop > 1 && h.state !== 3 ? ` R${h.loop}` : ''} | ${cellMd(h.title)} | ${cellMd(h.world)} | ${cellMd(posLabel(h))} | ${cellMd(why)} | ${cellMd(h.reason === 'keyword' ? srcLabel(h.prim?.src) : '')} | ${cellMd(h.prim?.snip?.join('') ?? '')} | ${cellMd(ment(h))} |`);
            }
        } else L.push('_ไม่มี_');
        L.push('');
        const miss = [...sc.cuts, ...(sc.near ?? [])];
        L.push(`${h3} เกือบติด / ถูกตัด`, '');
        if (miss.length) {
            L.push('| เอนทรี | Lorebook | เหตุผล | คีย์ที่ตรง | คีย์รอง | เจอที่ | คำตอบพูดถึง |', '|---|---|---|---|---|---|---|');
            for (const r of miss) {
                L.push(`| ${cellMd(r.title)} | ${cellMd(r.world)} | ${cellMd((WHY[r.why] ?? WHY.other).th)}${r.group ? ` (${cellMd(r.group)})` : ''} | ${cellMd(r.prim?.key ?? '')} | ${cellMd(r.sec ? `${LOGIC[r.logic] ?? ''}: ${r.sec.map(x => `${x.ok ? '✓' : '✗'}${x.key}`).join(', ')}` : '')} | ${cellMd(srcLabel(r.prim?.src))} | ${cellMd(ment(r))}${ment(r) ? ' ⚠ ไม่ได้เข้า prompt' : ''} |`);
            }
        } else L.push(sc.near == null ? '_กำลังวิเคราะห์_' : '_ไม่มี_');
        L.push('');
        if (n === d.scans.length - 1) {
            const others = otherMentions(d);
            if (others.length) {
                L.push(`${h3} คำตอบพูดถึง แต่ไม่ได้ถูกสแกนเจอ`, '', '| เอนทรี | Lorebook | คำตอบพูดถึง |', '|---|---|---|');
                for (const c of others) L.push(`| ${cellMd(c.title)} | ${cellMd(c.world)} | ${cellMd(ment(c))} |`);
                L.push('');
            }
        }
        if (settings().reportContent && sc.hits.length) {
            L.push(`${h3} เนื้อหาที่ใส่ใน prompt`, '');
            for (const h of sc.hits) {
                let text = h.content;
                let note = '';
                if (text == null) {
                    const e = await entryContent(h.world, h.uid);
                    text = e ? String(e.content ?? '') : '(โหลดไม่ได้)';
                    note = ' — เนื้อหาปัจจุบันใน lorebook';
                }
                L.push(`**${h.title}** (${h.world} · uid ${h.uid}${posLabel(h) ? ` · ${posLabel(h)}` : ''}${note})`, '', fence(text), '');
            }
        }
    }
    return L.join('\n');
}

async function chatReportMarkdown() {
    const chat = ctx().chat ?? [];
    const parts = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].is_user || chat[i].is_system) continue;
        if (!scansFor(i, Number(chat[i].swipe_id ?? 0)).length) continue;
        parts.push(await messageReportMarkdown(i, undefined, { heading: '##' }));
    }
    if (!parts.length) return '';
    const c = ctx();
    const who = c.groupId ? (c.groups?.find(g => g.id == c.groupId)?.name ?? 'group') : (c.name2 ?? '');
    return [`# Lore Lens — รายงานรายข้อความ: ${who}`, '', `แชท: ${chatId} · ${parts.length} ข้อความ · ส่งออก ${fmtDate(Date.now())}`, '', ...parts.flatMap(p => [p, '', '---', ''])].join('\n');
}

// ---------------------------------------------------------------- message menu button

const MES_BTN = '<div title="Lore Lens — รายงานข้อความนี้" class="mes_button ll_mes_report fa-solid fa-book-atlas"></div>';

function installMessageButtons() {
    const tpl = document.querySelector('#message_template .extraMesButtons');
    if (tpl && !tpl.querySelector('.ll_mes_report')) tpl.insertAdjacentHTML('afterbegin', MES_BTN);
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(el => {
        if (!el.querySelector('.ll_mes_report')) el.insertAdjacentHTML('afterbegin', MES_BTN);
    });
    document.body.classList.toggle('ll_nomesbtn', !settings().mesButton);
}

// ---------------------------------------------------------------- actions

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* ignore */ }
        ta.remove();
        return ok;
    }
}

function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const safeName = s => String(s ?? 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

const contentCache = new Map();
async function entryContent(world, uid) {
    const k = `${world}.${uid}`;
    if (contentCache.has(k)) return contentCache.get(k);
    const p = (async () => {
        const data = await ctx().loadWorldInfo(world);
        return data?.entries?.[uid] ?? null;
    })().catch(() => null);
    contentCache.set(k, p);
    setTimeout(() => contentCache.delete(k), 20000);
    return p;
}

async function fillContent(el) {
    const e = await entryContent(el.dataset.world, el.dataset.uid);
    if (!el.isConnected) return;
    if (!e) { el.innerHTML = '<small>โหลดเนื้อหาเอนทรีไม่ได้ (อาจถูกลบหรือเปลี่ยนชื่อ lorebook)</small>'; return; }
    const text = String(e.content ?? '');
    el.innerHTML = `<div class="ll_content_text">${esc(text.slice(0, 1200))}${text.length > 1200 ? '…' : ''}</div>
        <small class="ll_meta">${[
            e.constant ? 'constant' : '',
            e.selective && e.keysecondary?.length ? `logic ${LOGIC[e.selectiveLogic ?? 0]}` : '',
            `order ${e.order ?? '-'}`,
            e.position === 4 ? `@D${e.depth}` : '',
            e.useProbability && e.probability < 100 ? `${e.probability}%` : '',
            e.group ? `group “${esc(e.group)}”` : '',
            e.sticky ? `sticky ${e.sticky}` : '',
            e.cooldown ? `cooldown ${e.cooldown}` : '',
            e.scanDepth != null ? `scan depth ${e.scanDepth}` : '',
            e.disable ? 'ปิดอยู่' : '',
        ].filter(Boolean).join(' · ')}</small>`;
}

async function openEntry(world, uid) {
    closeSheet();
    try {
        if (WI?.openWorldInfoEditor) WI.openWorldInfoEditor(world);
        else document.getElementById('WIDrawerIcon')?.click();
        const sel = `#world_popup_entries_list [uid="${CSS.escape(String(uid))}"]`;
        const found = async ms => {
            const end = performance.now() + ms;
            while (performance.now() < end) {
                const el = document.querySelector(sel);
                if (el) return el;
                await wait(80);
            }
            return null;
        };
        let el = await found(2500);
        if (!el) {
            const e = await entryContent(world, uid);
            const search = document.getElementById('world_info_search');
            if (search && e) {
                search.value = (e.comment || e.key?.[0] || '').toString();
                search.dispatchEvent(new Event('input', { bubbles: true }));
                el = await found(2500);
            }
        }
        if (el) {
            el.scrollIntoView({ block: 'center' });
            el.classList.add('ll_flash');
            setTimeout(() => el.classList.remove('ll_flash'), 1800);
        } else {
            toast.info(`เปิด lorebook “${world}” แล้ว — หาเอนทรี uid ${uid} ในรายการ`);
        }
    } catch (err) {
        console.warn(LOG, err);
        toast.warn('เปิด lorebook ไม่ได้');
    }
}

function findRec(kind, k) {
    const scan = history[view.index];
    if (!scan) return null;
    const list = kind === 'hit' ? scan.hits : kind === 'cut' ? scan.cuts : scan.near ?? [];
    return list.find(r => r.k === k) ?? null;
}

function recText(rec) {
    const lines = [`${rec.title} [${rec.world} · uid ${rec.uid}]`];
    if (rec.reason) lines.push(`สาเหตุ: ${REASON[rec.reason]?.th ?? rec.reason}`);
    if (rec.why) lines.push(`ไม่ติดเพราะ: ${(WHY[rec.why] ?? WHY.other).th}`);
    if (rec.prim) {
        lines.push(`คีย์: ${rec.prim.key}`, `เจอที่: ${srcLabel(rec.prim.src)}`, `บริบท: ${rec.prim.snip.join('')}`);
    }
    if (rec.sec?.length) lines.push(`คีย์รอง (${LOGIC[rec.logic]}): ${rec.sec.map(s => `${s.ok ? '✓' : '✗'}${s.key}`).join(', ')}`);
    return lines.join('\n');
}

async function onBodyClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const row = e.target.closest('.ll_row');
    if (act) {
        if (act === 'open-entry' && row) {
            const rec = findRec(row.dataset.kind, row.dataset.k);
            if (rec) openEntry(rec.world, rec.uid);
        } else if (act === 'copy-entry' && row) {
            const rec = findRec(row.dataset.kind, row.dataset.k);
            if (rec && await copyText(recText(rec))) toast.ok('คัดลอกแล้ว');
        } else if (act === 'copy-md') {
            if (await copyText(reportMarkdown())) toast.ok('คัดลอกรายงานแล้ว (Markdown)'); else toast.warn('คัดลอกไม่ได้ ลองปุ่ม .md แทน');
        } else if (act === 'dl-md') {
            download(`lorelens_${safeName(chatId)}.md`, reportMarkdown(), 'text/markdown');
        } else if (act === 'dl-json') {
            download(`lorelens_${safeName(chatId)}.json`, JSON.stringify({ chatId, exported: new Date().toISOString(), scans: history, catalog }, null, 1), 'application/json');
        } else if (act === 'rep-open') {
            const el = e.target.closest('[data-act]');
            openReport(Number(el.dataset.i), el.dataset.s != null ? Number(el.dataset.s) : undefined);
        } else if (act === 'rep-back') {
            view.tab = 'hit';
            render();
        } else if (act === 'rep-prev' || act === 'rep-next') {
            const i = neighbourReply(view.report.i, act === 'rep-prev' ? -1 : 1);
            if (i != null) openReport(i);
        } else if (act === 'rep-swipe') {
            openReport(view.report.i, Number(e.target.closest('[data-act]').dataset.s));
        } else if (act === 'rep-copy' || act === 'rep-dl') {
            const md = await messageReportMarkdown(view.report.i, view.report.s);
            if (!md) return;
            if (act === 'rep-dl') download(`lorelens_${safeName(chatId)}_msg${view.report.i}.md`, md, 'text/markdown');
            else if (await copyText(md)) toast.ok('คัดลอกรายงานข้อความนี้แล้ว'); else toast.warn('คัดลอกไม่ได้ ลองปุ่มดาวน์โหลดแทน');
        } else if (act === 'rep-all') {
            const md = await chatReportMarkdown();
            if (md) download(`lorelens_${safeName(chatId)}_messages.md`, md, 'text/markdown');
            else toast.info('ยังไม่มีข้อความที่ผูกกับผลสแกน');
        } else if (act === 'clear-chat') {
            if (!confirm('ล้างประวัติ Lore Lens ของแชทนี้?')) return;
            history = [];
            view.index = 0;
            persistSoon();
            updateButton();
            render();
        }
        return;
    }
    const head = e.target.closest('.ll_row_head');
    if (head && row) {
        const id = `${row.dataset.kind}:${row.dataset.k}`;
        const rec = findRec(row.dataset.kind, row.dataset.k);
        if (!rec) return;
        if (view.open.has(id)) {
            view.open.delete(id);
            row.classList.remove('ll_isopen');
            row.querySelector('.ll_detail')?.remove();
            head.setAttribute('aria-expanded', 'false');
        } else {
            view.open.add(id);
            row.classList.add('ll_isopen');
            head.setAttribute('aria-expanded', 'true');
            row.insertAdjacentHTML('beforeend', detailHTML(rec, row.dataset.kind));
            const c = row.querySelector('.ll_content');
            if (c) fillContent(c);
            // keep the opened row in view on small screens
            requestAnimationFrame(() => {
                const body = sheet.querySelector('.ll_body');
                const r = row.getBoundingClientRect(), b = body.getBoundingClientRect();
                if (r.bottom > b.bottom) body.scrollTop += Math.min(r.bottom - b.bottom + 8, r.top - b.top - 4);
            });
        }
    }
}

// ---------------------------------------------------------------- settings drawer

function colorRow(id, label) {
    return `<label for="${id}">${label}</label>
        <div class="ll_colorpick">
            <select id="${id}" class="text_pole">${Object.entries(COLOR_SOURCES).map(([k, [name]]) => `<option value="${k}">${esc(name)}</option>`).join('')}</select>
            <input type="color" id="${id}_pick" aria-label="${label} (กำหนดเอง)">
        </div>`;
}

/** The style chooser in the settings drawer draws each style with the current colours. */
function renderLookPreviews() {
    document.querySelectorAll('#ll_styles .ll_preview').forEach(el => {
        styleButton(el, el.dataset.style);
        el.style.setProperty('--ll-size', `${Math.min(46, clamp(Number(settings().btnSize) || DEFAULTS.btnSize, 24, 80))}px`);
        el.classList.add('ll_edge_left');
        setCount(el, 7, 0.7);
    });
}

function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', `
    <div id="ll_settings" class="ll_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lore Lens</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="ll_enabled"> เก็บข้อมูลการสแกน World Info</label>
                <label class="checkbox_label"><input type="checkbox" id="ll_showbtn"> แสดงปุ่มลอย (เก็บเข้า Quick Dock ได้)</label>
                <label class="checkbox_label"><input type="checkbox" id="ll_group"> จัดกลุ่มตาม lorebook</label>
                <label class="checkbox_label"><input type="checkbox" id="ll_near"> วิเคราะห์เอนทรีที่ “เกือบติด”</label>
                <label class="checkbox_label" title="ปุ่มจะขึ้นสถานะ attention — ถ้าอยู่ใน Quick Dock จะเห็นเป็นจุดแดงบนปุ่มหลัก"><input type="checkbox" id="ll_alert"> เตือนเมื่องบ token ของ World Info เต็ม</label>
                <label class="checkbox_label" title="การเจนเบื้องหลังของ extension อื่น เช่น summary / tracker"><input type="checkbox" id="ll_quiet"> ไม่นับการเจนแบบ quiet (extension)</label>
                <div class="ll_set_grid">
                    <label for="ll_hist">เก็บย้อนหลังต่อแชท (ครั้ง)</label>
                    <input type="number" id="ll_hist" class="text_pole" min="5" max="200" step="1">
                    <label for="ll_snip">ความยาวบริบทรอบคีย์ (ตัวอักษร)</label>
                    <input type="number" id="ll_snip" class="text_pole" min="16" max="160" step="4">
                </div>
                <div class="ll_set_title">หน้าตาปุ่ม</div>
                <div id="ll_styles" class="ll_styles" role="radiogroup" aria-label="รูปแบบปุ่ม">${Object.entries(BTN_STYLES).map(([k, [name, hint]]) => `
                    <div class="ll_style_opt" role="radio" tabindex="0" data-style="${k}" title="${esc(hint)}">
                        <div class="ll_style_stage"><div class="ll_btn ll_preview" data-style="${k}">${BTN_INNER}</div></div>
                        <span>${esc(name)}</span>
                    </div>`).join('')}
                </div>
                <small id="ll_style_hint" class="ll_setnote"></small>
                <div class="ll_set_grid">
                    <label for="ll_size">ขนาดปุ่ม (px)</label>
                    <input type="number" id="ll_size" class="text_pole" min="24" max="80" step="1">
                    <label for="ll_iconscale">ขนาดไอคอน/ตัวเลข</label>
                    <div class="ll_range"><input type="range" id="ll_iconscale" min="25" max="75" step="1"><output id="ll_iconscale_out"></output></div>
                    ${colorRow('ll_c_icon', 'สีไอคอน')}
                    ${colorRow('ll_c_bg', 'สีพื้นปุ่ม')}
                    ${colorRow('ll_c_border', 'สีขอบ')}
                    ${colorRow('ll_c_accent', 'สีตัวเลข / สีเน้น')}
                    <label for="ll_bgop">ความทึบพื้นปุ่ม</label>
                    <div class="ll_range"><input type="range" id="ll_bgop" min="0" max="100" step="5"><output id="ll_bgop_out"></output></div>
                    <label for="ll_idleop" title="ความทึบของทั้งปุ่มตอนไม่ได้แตะ — แตะ/ชี้แล้วจะชัด 100% และจะชัดเสมอเมื่อมีการเตือน">ความทึบตอนไม่ได้ใช้</label>
                    <div class="ll_range"><input type="range" id="ll_idleop" min="15" max="100" step="5"><output id="ll_idleop_out"></output></div>
                </div>
                <div class="ll_set_title ll_sub">ไอคอน</div>
                <div class="ll_set_iconrow">
                    <span id="ll_icon_prev" class="ll_set_iconprev"></span>
                    <input type="text" id="ll_icon" class="text_pole" placeholder="อีโมจิ หรือ fa-solid fa-book">
                </div>
                <div id="ll_icon_grid" class="ll_icongrid">${ICONS.map(ic => `<div class="ll_ic_opt" role="button" tabindex="0" data-icon="${esc(ic)}" title="${esc(ic)}">${iconHTML(ic)}</div>`).join('')}</div>
                <label class="checkbox_label"><input type="checkbox" id="ll_shadow"> เงาใต้ปุ่ม</label>
                <label class="checkbox_label" title="สวยขึ้นบนพื้นหลังที่มีลาย แต่กินแรงเครื่อง"><input type="checkbox" id="ll_blurbg"> เบลอพื้นหลังใต้ปุ่ม</label>
                <label class="checkbox_label"><input type="checkbox" id="ll_hidezero"> ซ่อนตัวเลขเมื่อไม่มีเอนทรีติด (แบบคลาสสิก)</label>
                <div class="ll_set_btns">
                    <div id="ll_look_reset" class="menu_button"><i class="fa-solid fa-rotate-left"></i> คืนค่าหน้าตาเริ่มต้น</div>
                </div>
                <div class="ll_set_title">รายงานรายข้อความ</div>
                <label class="checkbox_label"><input type="checkbox" id="ll_mesbtn"> ปุ่ม <i class="fa-solid fa-book-atlas"></i> ในเมนู “…” ของคำตอบบอท</label>
                <label class="checkbox_label" title="ข้อความจริงที่ถูกใส่เข้า prompt (แทน macro แล้ว)"><input type="checkbox" id="ll_repcontent"> ใส่เนื้อหาเอนทรีที่ติดในไฟล์รายงาน</label>
                <div class="ll_set_title">อื่น ๆ</div>
                <div class="ll_set_btns">
                    <div id="ll_open" class="menu_button"><i class="fa-solid fa-book-atlas"></i> เปิด Lore Lens</div>
                    <div id="ll_resetpos" class="menu_button"><i class="fa-solid fa-crosshairs"></i> รีเซ็ตตำแหน่งปุ่ม</div>
                    <div id="ll_wipe" class="menu_button"><i class="fa-solid fa-trash"></i> ล้างประวัติทุกแชท</div>
                </div>
                <small class="ll_setnote">คำสั่ง <code>/lorelens</code> เปิดแผง · <code>/lorelens stats</code> เปิดหน้าสถิติ — ใช้ทำช็อตคัทใน Quick Dock ได้ · ถ้าเคยใช้ WorldInfo Info ให้ปิดตัวนั้นก่อน</small>
            </div>
        </div>
    </div>`);
    const s = settings();
    const $ = id => document.getElementById(id);
    const check = (id, key, after) => {
        $(id).checked = !!s[key];
        $(id).addEventListener('change', e => { s[key] = e.target.checked; save(); after?.(); });
    };
    const num = (id, key, lo, hi) => {
        $(id).value = s[key];
        $(id).addEventListener('change', e => {
            const v = Math.round(Number(e.target.value));
            s[key] = Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULTS[key];
            e.target.value = s[key];
            save();
        });
    };
    check('ll_enabled', 'enabled', updateButton);
    check('ll_showbtn', 'showButton', updateButton);
    check('ll_group', 'groupByBook', () => { if (isOpen()) render(); });
    check('ll_near', 'nearMiss');
    check('ll_alert', 'alertOverflow', () => { if (!s.alertOverflow) { alertState = ''; updateButton(); } });
    check('ll_quiet', 'ignoreQuiet');
    check('ll_mesbtn', 'mesButton', installMessageButtons);
    check('ll_repcontent', 'reportContent');
    num('ll_hist', 'historySize', 5, 200);
    num('ll_snip', 'snippet', 16, 160);
    $('ll_open').addEventListener('click', () => openSheet());
    $('ll_resetpos').addEventListener('click', () => { s.btnPos = { ...DEFAULTS.btnPos }; save(); applyLook(); });

    // ---- appearance
    const styles = $('ll_styles');
    const showStyle = () => {
        styles.querySelectorAll('.ll_style_opt').forEach(o => {
            const on = o.dataset.style === btnStyle();
            o.classList.toggle('ll_sel', on);
            o.setAttribute('aria-checked', String(on));
        });
        $('ll_style_hint').textContent = BTN_STYLES[btnStyle()][1];
    };
    const pickStyle = e => {
        const o = e.target.closest('.ll_style_opt');
        if (!o || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        s.btnStyle = o.dataset.style;
        save();
        showStyle();
        applyLook();
    };
    styles.addEventListener('click', pickStyle);
    styles.addEventListener('keydown', pickStyle);
    showStyle();

    const look = (id, key, lo, hi) => {
        $(id).value = s[key];
        $(id).addEventListener('change', e => {
            const v = Math.round(Number(e.target.value));
            s[key] = Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULTS[key];
            e.target.value = s[key];
            save();
            applyLook();
        });
    };
    look('ll_size', 'btnSize', 24, 80);
    const range = id => key => {
        const out = $(`${id}_out`);
        const show = () => { $(id).value = s[key]; out.textContent = `${s[key]}%`; };
        show();
        $(id).addEventListener('input', e => { s[key] = Number(e.target.value); out.textContent = `${s[key]}%`; save(); applyLook(); });
        return show;
    };
    const showRanges = [range('ll_iconscale')('iconScale'), range('ll_bgop')('bgOpacity'), range('ll_idleop')('idleOpacity')];

    const colorInputs = [['ll_c_icon', 'iconColor', 'icon'], ['ll_c_bg', 'bgColor', 'bg'], ['ll_c_border', 'borderColor', 'border'], ['ll_c_accent', 'accentColor', 'accent']];
    const showColors = () => colorInputs.forEach(([id, key, which]) => {
        $(id).value = s[key];
        $(`${id}_pick`).value = s.customColors[which];
        $(`${id}_pick`).hidden = s[key] !== 'custom';
    });
    for (const [id, key, which] of colorInputs) {
        $(id).addEventListener('change', e => { s[key] = e.target.value; save(); showColors(); applyLook(); });
        $(`${id}_pick`).addEventListener('input', e => { s.customColors[which] = e.target.value; save(); applyLook(); });
    }
    showColors();

    const setIcon = v => {
        s.btnIcon = cleanIcon(v) || DEFAULTS.btnIcon;
        save();
        $('ll_icon').value = s.btnIcon;
        $('ll_icon_prev').innerHTML = iconHTML(s.btnIcon);
        applyLook();
    };
    $('ll_icon').value = s.btnIcon;
    $('ll_icon_prev').innerHTML = iconHTML(s.btnIcon);
    $('ll_icon').addEventListener('change', e => setIcon(e.target.value));
    $('ll_icon_grid').addEventListener('click', e => {
        const ic = e.target.closest('[data-icon]')?.dataset.icon;
        if (ic) setIcon(ic);
    });

    const lookCheck = (id, key) => {
        $(id).checked = !!s[key];
        $(id).addEventListener('change', e => { s[key] = e.target.checked; save(); applyLook(); });
    };
    lookCheck('ll_shadow', 'shadow');
    lookCheck('ll_blurbg', 'blur');
    lookCheck('ll_hidezero', 'hideZero');

    $('ll_look_reset').addEventListener('click', () => {
        for (const k of ['btnStyle', 'btnSize', 'iconScale', 'btnIcon', 'iconColor', 'bgColor', 'borderColor', 'accentColor', 'bgOpacity', 'idleOpacity', 'shadow', 'blur', 'hideZero']) s[k] = DEFAULTS[k];
        s.customColors = { ...DEFAULTS.customColors };
        save();
        $('ll_size').value = s.btnSize;
        $('ll_icon').value = s.btnIcon;
        $('ll_icon_prev').innerHTML = iconHTML(s.btnIcon);
        for (const [id, key] of [['ll_shadow', 'shadow'], ['ll_blurbg', 'blur'], ['ll_hidezero', 'hideZero']]) $(id).checked = !!s[key];
        showRanges.forEach(f => f());
        showColors();
        showStyle();
        applyLook();
    });
    renderLookPreviews();
    $('ll_wipe').addEventListener('click', async () => {
        if (!confirm('ล้างประวัติ Lore Lens ของทุกแชท?')) return;
        await dbClearAll();
        history = [];
        view.index = 0;
        updateButton();
        if (isOpen()) render();
        toast.ok('ล้างแล้ว');
    });
}

function registerCommands() {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'lorelens',
            callback: (_args, value) => {
                const v = String(value ?? '').trim().toLowerCase();
                const rep = v.match(/^report\s*(\d+)?$/);
                if (rep) {
                    const chat = ctx().chat ?? [];
                    const i = rep[1] != null ? Number(rep[1]) : neighbourReply(chat.length, -1);
                    if (i == null || !chat[i]) toast.warn('ไม่พบข้อความ'); else openReport(i);
                    return '';
                }
                openSheet(v === 'stats' ? 'stats' : v === 'near' ? 'near' : v === 'hit' ? 'hit' : undefined);
                return '';
            },
            unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                SlashCommandArgument.fromProps({ description: 'hit | near | stats | report [เลขข้อความ]', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
            ] : [],
            helpString: 'เปิด Lore Lens — เอนทรี World Info ที่ติด พร้อมคีย์และตำแหน่งที่ทำให้ติด',
        }));
    } catch (err) {
        console.warn(LOG, 'slash command registration failed', err);
    }
}

// ---------------------------------------------------------------- init

async function init() {
    if (document.getElementById('ll_button')) return;
    settings();
    try { WI = await import('../../../world-info.js'); } catch (err) { console.warn(LOG, 'world-info.js not found; using defaults', err); }
    try { RX = await import('../../regex/engine.js'); } catch { RX = null; }

    buildButton();
    buildSheet();
    applyLook();
    renderSettings();
    registerCommands();
    updateButton();

    const { eventSource, eventTypes: E } = ctx();
    eventSource.on(E.GENERATION_STARTED, onGenerationStarted);
    if (E.WORLDINFO_FORCE_ACTIVATE) eventSource.on(E.WORLDINFO_FORCE_ACTIVATE, onForceActivate);
    if (E.WORLDINFO_SCAN_DONE) eventSource.on(E.WORLDINFO_SCAN_DONE, onScanDone);
    else console.warn(LOG, 'this SillyTavern version has no WORLDINFO_SCAN_DONE event — please update SillyTavern');
    eventSource.on(E.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
    installMessageButtons();
    document.addEventListener('click', e => {
        const b = e.target.closest?.('.ll_mes_report');
        if (!b) return;
        const i = Number(b.closest('.mes')?.getAttribute('mesid'));
        if (Number.isFinite(i)) openReport(i);
    });
    eventSource.on(E.CHAT_CHANGED, () => loadChat());
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { loadChat(); placeButton(); });
    loadChat();
    console.log(LOG, 'loaded');
}

globalThis.LoreLens = {
    open: openSheet,
    close: closeSheet,
    history: () => history,
    catalog: () => catalog,
    report: reportMarkdown,
    openReport,
    messageReport: messageReportMarkdown,
    chatReport: chatReportMarkdown,
    applyLook,
    _findKey: findKey,
};

if (typeof jQuery === 'function') jQuery(() => { init(); }); else init();

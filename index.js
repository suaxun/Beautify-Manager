import {
    saveSettingsDebounced,
} from '../../../../script.js';

import {
    extension_settings,
} from '../../../extensions.js';

import {
    callGenericPopup,
    POPUP_TYPE,
} from '../../../popup.js';

import {
    uuidv4,
} from '../../../utils.js';

/* =========================================================
 * 基本配置
 * ========================================================= */

const EXTENSION_KEY = 'native_theme_manager_v2';

const SETTINGS_ENTRY_ID = 'ntm_settings_entry';
const EXTENSIONS_ENTRY_ID = 'ntm_extensions_entry';
const MANAGER_ID = 'native_theme_manager_popup';

const THEME_SELECT_SELECTOR = '#themes';

const SETTINGS_ANCHOR_SELECTOR =
    '#UI-presets-block > .flex-container.flexnowrap.alignitemscenter';

const DATABASE_NAME = 'SillyTavernNativeThemeManager';
const DATABASE_VERSION = 1;
const BLOB_STORE_NAME = 'blobs';

/**
 * 当前打开的管理器。
 *
 * @type {JQuery<HTMLElement>|null}
 */
let activeManager = null;

/**
 * 主题下拉框观察器。
 *
 * @type {MutationObserver|null}
 */
let themeSelectObserver = null;

/**
 * 当前由 URL.createObjectURL 创建的 URL。
 * 每次重新渲染时释放，避免内存泄漏。
 *
 * @type {string[]}
 */
let activeObjectUrls = [];

/**
 * 防止同时执行多次导入。
 */
let isImportingTheme = false;

/* =========================================================
 * 通用工具
 * ========================================================= */

/**
 * HTML 转义。
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = String(value ?? '');
    return element.innerHTML;
}

/**
 * 属性值转义。
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeAttribute(value) {
    return escapeHtml(value)
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#039;');
}

/**
 * 根据主题名称推测常见色系。
 * 如果名字中没有颜色信息，则使用稳定哈希色。
 *
 * @param {string} text
 * @returns {string}
 */
function createStableColor(text) {
    const name = String(text || '').toLocaleLowerCase();

    const namedColors = [
        {
            keywords: ['red', 'rose', 'ruby', 'scarlet', 'crimson', '红', '玫瑰'],
            color: '#e96878',
        },
        {
            keywords: ['pink', 'sakura', 'peach', '樱', '粉', '桃'],
            color: '#ec78a9',
        },
        {
            keywords: ['purple', 'violet', 'lavender', 'amethyst', '紫', '薰衣草'],
            color: '#9675e8',
        },
        {
            keywords: ['blue', 'ocean', 'sky', 'azure', 'cyan', '蓝', '海洋', '天空'],
            color: '#609de8',
        },
        {
            keywords: ['teal', 'aqua', 'turquoise', '青', '湖蓝'],
            color: '#45b8b0',
        },
        {
            keywords: ['green', 'forest', 'mint', 'emerald', '绿', '森林', '薄荷'],
            color: '#61b982',
        },
        {
            keywords: ['yellow', 'gold', 'amber', 'sun', '黄', '金', '琥珀'],
            color: '#d9ad55',
        },
        {
            keywords: ['orange', 'sunset', '橙', '夕阳'],
            color: '#df8654',
        },
        {
            keywords: ['brown', 'coffee', 'sepia', '棕', '咖啡'],
            color: '#a77b60',
        },
        {
            keywords: ['white', 'light', 'snow', 'ivory', '白', '浅色'],
            color: '#c7cad4',
        },
        {
            keywords: ['black', 'dark', 'midnight', 'night', '黑', '暗色', '夜'],
            color: '#747b96',
        },
    ];

    for (const entry of namedColors) {
        if (entry.keywords.some(keyword => name.includes(keyword))) {
            return entry.color;
        }
    }

    let hash = 0;

    for (const character of name) {
        hash = ((hash << 5) - hash) + character.codePointAt(0);
        hash |= 0;
    }

    const hue = Math.abs(hash) % 360;

    /*
     * 使用稍微柔和一些的颜色，避免色点过亮。
     */
    return `hsl(${hue} 62% 58%)`;
}

/**
 * 把 rgb()/rgba() 转换为十六进制颜色。
 *
 * @param {string} color
 * @returns {string}
 */
function rgbColorToHex(color) {
    const value = String(color || '').trim();

    if (/^#[0-9a-f]{6}$/i.test(value)) {
        return value.toLowerCase();
    }

    if (/^#[0-9a-f]{3}$/i.test(value)) {
        return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
            .toLowerCase();
    }

    const match = value.match(
        /rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i,
    );

    if (!match) {
        return '';
    }

    const channels = match.slice(1, 4).map(channel => {
        const number = Math.max(0, Math.min(255, Math.round(Number(channel))));
        return number.toString(16).padStart(2, '0');
    });

    return `#${channels.join('')}`;
}

/**
 * 尝试将浏览器支持的任意 CSS 颜色转换为十六进制。
 *
 * @param {string} color
 * @returns {string}
 */
function normalizeColorToHex(color) {
    const direct = rgbColorToHex(color);

    if (direct) {
        return direct;
    }

    const probe = document.createElement('span');

    probe.style.position = 'fixed';
    probe.style.pointerEvents = 'none';
    probe.style.opacity = '0';
    probe.style.color = String(color || '');
    document.body.appendChild(probe);

    const computedColor = getComputedStyle(probe).color;
    probe.remove();

    return rgbColorToHex(computedColor);
}

/**
 * 读取当前 SillyTavern 主题的实际主题色。
 *
 * 优先读取 QuoteColor，因为大部分 ST 主题都将它作为强调色。
 *
 * @returns {string}
 */
function getCurrentThemeAccentColor() {
    const styles = getComputedStyle(document.documentElement);

    const candidates = [
        styles.getPropertyValue('--SmartThemeQuoteColor'),
        styles.getPropertyValue('--SmartThemeEmColor'),
        styles.getPropertyValue('--SmartThemeUnderlineColor'),
        styles.getPropertyValue('--SmartThemeBorderColor'),
        styles.getPropertyValue('--SmartThemeBodyColor'),
    ];

    for (const candidate of candidates) {
        const color = normalizeColorToHex(candidate);

        if (color) {
            return color;
        }
    }

    return '';
}

/**
 * 应用主题后，读取当前主题真实强调色。
 *
 * @param {object} variant
 * @returns {Promise<void>}
 */
async function captureVariantThemeColor(variant) {
    if (!variant || variant.colorAuto === false) {
        return;
    }

    /*
     * 留一点时间让 SillyTavern 更新 CSS 变量。
     */
    await delay(120);

    const actualColor = getCurrentThemeAccentColor();

    if (actualColor) {
        variant.color = actualColor;
        variant.colorAuto = true;
        saveSettings();
    }
}


/**
 * 释放预览图 URL。
 */
function revokeObjectUrls() {
    for (const url of activeObjectUrls) {
        URL.revokeObjectURL(url);
    }

    activeObjectUrls = [];
}

/**
 * 延迟。
 *
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
    return new Promise(resolve => {
        window.setTimeout(resolve, milliseconds);
    });
}

/* =========================================================
 * IndexedDB：保存图片和真实主题文件
 * ========================================================= */

/**
 * 打开扩展数据库。
 *
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            DATABASE_NAME,
            DATABASE_VERSION,
        );

        request.onupgradeneeded = () => {
            const database = request.result;

            if (!database.objectStoreNames.contains(BLOB_STORE_NAME)) {
                database.createObjectStore(BLOB_STORE_NAME);
            }
        };

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

/**
 * 保存 Blob。
 *
 * @param {string} key
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
async function saveBlob(key, blob) {
    const database = await openDatabase();

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            BLOB_STORE_NAME,
            'readwrite',
        );

        const store = transaction.objectStore(BLOB_STORE_NAME);
        store.put(blob, key);

        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });

    database.close();
}

/**
 * 读取 Blob。
 *
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
async function readBlob(key) {
    if (!key) {
        return null;
    }

    const database = await openDatabase();

    const result = await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            BLOB_STORE_NAME,
            'readonly',
        );

        const store = transaction.objectStore(BLOB_STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });

    database.close();

    return result instanceof Blob ? result : null;
}

/**
 * 删除 Blob。
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
async function deleteBlob(key) {
    if (!key) {
        return;
    }

    const database = await openDatabase();

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            BLOB_STORE_NAME,
            'readwrite',
        );

        const store = transaction.objectStore(BLOB_STORE_NAME);
        store.delete(key);

        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });

    database.close();
}

/* =========================================================
 * 扩展设置
 * ========================================================= */

/**
 * 默认数据结构：
 *
 * {
 *   groups: [
 *     {
 *       id,
 *       name,
 *       activeVariantId,
 *       variants: [
 *         {
 *           id,
 *           name,
 *           color,
 *           nativeThemeValue,
 *           previewKey,
 *           previewFileName,
 *           themeFileKey,
 *           themeFileName,
 *           themeFileSuggestedName
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
function getSettings() {
    if (
        !extension_settings[EXTENSION_KEY] ||
        typeof extension_settings[EXTENSION_KEY] !== 'object'
    ) {
        extension_settings[EXTENSION_KEY] = {};
    }

    const settings = extension_settings[EXTENSION_KEY];

    if (!Array.isArray(settings.groups)) {
        settings.groups = [];
    }

    settings.groups = settings.groups
        .filter(group => group && typeof group === 'object')
        .map(group => {
            if (!Array.isArray(group.variants)) {
                group.variants = [];
            }

            return {
                id: String(group.id || uuidv4()),
                name: String(group.name || '未命名主题系列'),
                activeVariantId: String(
                    group.activeVariantId ||
                    group.variants[0]?.id ||
                    '',
                ),
variants: group.variants.map(variant => ({
    id: String(variant.id || uuidv4()),
    name: String(variant.name || '默认'),

    /*
     * 旧数据没有 colorAuto 字段时，默认使用自动主题色。
     */
    colorAuto: variant.colorAuto !== false,

    color: String(
        variant.color ||
        createStableColor(
            variant.nativeThemeValue ||
            variant.name ||
            group.name,
        ),
    ),

    nativeThemeValue: String(
        variant.nativeThemeValue || '',
    ),
                    previewKey: String(variant.previewKey || ''),
                    previewFileName: String(
                        variant.previewFileName || '',
                    ),
                    themeFileKey: String(
                        variant.themeFileKey || '',
                    ),
                    themeFileName: String(
                        variant.themeFileName || '',
                    ),
                    themeFileSuggestedName: String(
                        variant.themeFileSuggestedName || '',
                    ),
                })),
            };
        });

    return settings;
}

/**
 * 保存设置。
 */
function saveSettings() {
    saveSettingsDebounced();
}

/* =========================================================
 * SillyTavern 原生主题读取
 * ========================================================= */

/**
 * 获取原生主题选择框。
 *
 * @returns {HTMLSelectElement|null}
 */
function getThemeSelect() {
    const element = document.querySelector(
        THEME_SELECT_SELECTOR,
    );

    return element instanceof HTMLSelectElement
        ? element
        : null;
}

/**
 * 获取全部原生主题。
 *
 * @returns {{
 *   value: string,
 *   name: string,
 *   selected: boolean
 * }[]}
 */
function getNativeThemes() {
    const select = getThemeSelect();

    if (!select) {
        return [];
    }

    return Array.from(select.options)
        .filter(option => option.value !== '')
        .map(option => ({
            value: option.value,
            name: option.textContent?.trim() || option.value,
            selected: option.selected,
        }));
}

/**
 * 获取当前主题值。
 *
 * @returns {string}
 */
function getCurrentThemeValue() {
    return getThemeSelect()?.value ?? '';
}

/**
 * 原生主题是否存在。
 *
 * @param {string} themeValue
 * @returns {boolean}
 */
function nativeThemeExists(themeValue) {
    if (!themeValue) {
        return false;
    }

    return getNativeThemes().some(
        theme => theme.value === themeValue,
    );
}

/**
 * 切换 SillyTavern 原生主题。
 *
 * @param {string} themeValue
 * @returns {boolean}
 */
function selectNativeTheme(themeValue) {
    const select = getThemeSelect();

    if (!select) {
        toastr.error('没有找到 SillyTavern 原生主题列表。');
        return false;
    }

    const exists = Array.from(select.options).some(
        option => option.value === themeValue,
    );

    if (!exists) {
        return false;
    }

    select.value = themeValue;

    select.dispatchEvent(new Event('change', {
        bubbles: true,
    }));

    return true;
}

/* =========================================================
 * 自动同步原生主题
 * ========================================================= */

/**
 * 将未被管理器收录的原生主题自动创建为独立主题系列。
 *
 * 之后可以进入“编辑系列”，把其他色系添加进同一个系列。
 */
function syncNativeThemesToGroups() {
    const settings = getSettings();
    const nativeThemes = getNativeThemes();

    const alreadyAssigned = new Set();

    for (const group of settings.groups) {
        for (const variant of group.variants) {
            if (variant.nativeThemeValue) {
                alreadyAssigned.add(variant.nativeThemeValue);
            }
        }
    }

    let changed = false;

    for (const theme of nativeThemes) {
        if (alreadyAssigned.has(theme.value)) {
            continue;
        }

        const variantId = uuidv4();

        settings.groups.push({
            id: uuidv4(),
            name: theme.name,
            activeVariantId: variantId,
            variants: [
                {
                    id: variantId,
                    name: '默认',
                    colorAuto: true,
                    color: createStableColor(theme.name),
                    nativeThemeValue: theme.value,
                    previewKey: '',
                    previewFileName: '',
                    themeFileKey: '',
                    themeFileName: '',
                    themeFileSuggestedName: theme.name,
                },
            ],
        });

        changed = true;
    }

    if (changed) {
        saveSettings();
    }
}

/* =========================================================
 * 真实主题文件导入
 * ========================================================= */

/**
 * 尝试从主题 JSON 中获取主题名。
 *
 * 不同版本或第三方主题可能使用不同字段。
 *
 * @param {object} data
 * @returns {string}
 */
function getSuggestedThemeName(data) {
    const candidates = [
        data?.name,
        data?.theme_name,
        data?.display_name,
        data?.displayName,
        data?.preset_name,
        data?.presetName,
    ];

    for (const candidate of candidates) {
        if (
            typeof candidate === 'string' &&
            candidate.trim()
        ) {
            return candidate.trim();
        }
    }

    return '';
}

/**
 * 等待原生主题导入完成。
 *
 * @param {string[]} oldValues
 * @param {string} suggestedName
 * @returns {Promise<string>}
 */
async function waitForImportedTheme(
    oldValues,
    suggestedName,
) {
    for (let attempt = 0; attempt < 50; attempt++) {
        await delay(100);

        const themes = getNativeThemes();
        const currentValue = getCurrentThemeValue();

        const newlyAdded = themes.find(
            theme => !oldValues.includes(theme.value),
        );

        if (newlyAdded) {
            return newlyAdded.value;
        }

        if (
            suggestedName &&
            themes.some(
                theme =>
                    theme.value === suggestedName ||
                    theme.name === suggestedName,
            )
        ) {
            const matched = themes.find(
                theme =>
                    theme.value === suggestedName ||
                    theme.name === suggestedName,
            );

            return matched?.value || '';
        }

        if (
            currentValue &&
            !oldValues.includes(currentValue)
        ) {
            return currentValue;
        }
    }

    return getCurrentThemeValue();
}

/**
 * 把 IndexedDB 中的真实 JSON 文件交给 SillyTavern 原生导入器。
 *
 * @param {object} variant
 * @returns {Promise<string>}
 */
async function importVariantThemeFile(variant) {
    if (isImportingTheme) {
        toastr.warning('正在导入另一个主题，请稍候。');
        return '';
    }

    if (!variant.themeFileKey) {
        return '';
    }

    const input = document.querySelector(
        '#ui_preset_import_file',
    );

    if (!(input instanceof HTMLInputElement)) {
        toastr.error('找不到 SillyTavern 原生主题导入控件。');
        return '';
    }

    const blob = await readBlob(variant.themeFileKey);

    if (!blob) {
        toastr.error('找不到对应的真实主题文件。');
        return '';
    }

    isImportingTheme = true;

    try {
        const oldValues = getNativeThemes().map(
            theme => theme.value,
        );

        const fileName =
            variant.themeFileName ||
            'theme.json';

        const file = new File(
            [blob],
            fileName,
            {
                type: 'application/json',
            },
        );

        const transfer = new DataTransfer();
        transfer.items.add(file);

        input.value = '';
        input.files = transfer.files;

        input.dispatchEvent(new Event('change', {
            bubbles: true,
        }));

        const importedValue = await waitForImportedTheme(
            oldValues,
            variant.themeFileSuggestedName,
        );

        return importedValue;
    } catch (error) {
        console.error(
            '[Theme Manager] Theme import failed:',
            error,
        );

        toastr.error(
            `主题导入失败：${error?.message || '未知错误'}`,
        );

        return '';
    } finally {
        isImportingTheme = false;
    }
}

/**
 * 激活一个颜色变体。
 *
 * @param {object} group
 * @param {object} variant
 */
async function activateVariant(group, variant) {
    group.activeVariantId = variant.id;
    saveSettings();
if (
    variant.nativeThemeValue &&
    nativeThemeExists(variant.nativeThemeValue)
) {
    selectNativeTheme(variant.nativeThemeValue);

    /*
     * 如果设置为自动颜色，就从实际主题中读取强调色。
     */
    await captureVariantThemeColor(variant);

    await renderGroups();
    updateCurrentThemeDisplay();
    return;
}

    /*
     * 原生主题不存在，但保存了真实 JSON 文件。
     * 自动导入，然后记录导入后的原生主题值。
     */
    if (variant.themeFileKey) {
        toastr.info(`正在载入“${variant.name}”主题文件……`);

        const importedThemeValue =
            await importVariantThemeFile(variant);

        if (importedThemeValue) {
            variant.nativeThemeValue =
                importedThemeValue;

            saveSettings();
selectNativeTheme(importedThemeValue);

await captureVariantThemeColor(variant);

toastr.success(
    `已切换到“${variant.name}”。`,
);

        } else {
            toastr.warning(
                '文件已交给 SillyTavern 导入，但未能自动确定主题名称。请在编辑器中手动关联原生主题。',
            );
        }

        syncNativeThemesToGroups();
        await renderGroups();
        updateCurrentThemeDisplay();
        return;
    }

    toastr.warning(
        `“${variant.name}”尚未关联原生主题或主题 JSON 文件。`,
    );

    await renderGroups();
}

/* =========================================================
 * 管理器 HTML
 * ========================================================= */

function createManagerHtml() {
    return $(`
        <div id="${MANAGER_ID}">
            <div class="ntm-header">
                <div class="ntm-title-area">
                    <div class="ntm-main-icon">
                        <i class="fa-solid fa-mobile-screen-button"></i>
                    </div>

                    <div>
                        <h3>主题展示与色系管理器</h3>
                        <div class="ntm-subtitle">
                            每个色系都可以关联独立预览图和真实 Theme JSON
                        </div>
                    </div>
                </div>

                <div class="ntm-current-theme-box">
                    <small>当前真实主题</small>
                    <strong id="ntm_current_theme_name">读取中……</strong>
                    <span id="ntm_current_theme_value">—</span>
                </div>
            </div>

            <div class="ntm-toolbar">
                <div class="ntm-search-box">
                    <i class="fa-solid fa-magnifying-glass"></i>

                    <input
                        id="ntm_search"
                        class="text_pole"
                        type="search"
                        placeholder="搜索主题系列或色系……"
                    >
                </div>

                <div
                    id="ntm_add_group"
                    class="menu_button menu_button_icon"
                >
                    <i class="fa-solid fa-folder-plus"></i>
                    <span>新建主题系列</span>
                </div>

                <div
                    id="ntm_sync_native"
                    class="menu_button menu_button_icon"
                >
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>同步原生主题</span>
                </div>
            </div>

            <div class="ntm-hint">
                <i class="fa-solid fa-circle-info"></i>
                <span>
                    点击卡片下方的颜色圆点，会同时切换预览图和对应的真实主题。
                    点击右上角齿轮，可以上传预览图、上传主题 JSON，或关联现有原生主题。
                </span>
            </div>

            <div id="ntm_groups_grid" class="ntm-groups-grid"></div>

            <div id="ntm_empty" class="ntm-empty displayNone">
                <i class="fa-solid fa-palette"></i>
                <strong>暂无主题系列</strong>
                <span>点击“同步原生主题”或“新建主题系列”。</span>
            </div>
        </div>
    `);
}

/**
 * 更新当前真实主题显示。
 */
function updateCurrentThemeDisplay() {
    if (!activeManager) {
        return;
    }

    const currentValue = getCurrentThemeValue();

    const currentTheme = getNativeThemes().find(
        theme => theme.value === currentValue,
    );

    activeManager
        .find('#ntm_current_theme_name')
        .text(currentTheme?.name || '未选择');

    activeManager
        .find('#ntm_current_theme_value')
        .text(currentValue || '—');
}

/**
 * 获取主题系列当前变体。
 *
 * @param {object} group
 * @returns {object|null}
 */
function getActiveVariant(group) {
    return group.variants.find(
        variant => variant.id === group.activeVariantId,
    ) ?? group.variants[0] ?? null;
}

/**
 * 判断系列是否匹配搜索。
 *
 * @param {object} group
 * @param {string} keyword
 * @returns {boolean}
 */
function groupMatchesSearch(group, keyword) {
    if (!keyword) {
        return true;
    }

    if (
        group.name.toLocaleLowerCase().includes(keyword)
    ) {
        return true;
    }

    return group.variants.some(variant =>
        variant.name.toLocaleLowerCase().includes(keyword) ||
        variant.nativeThemeValue
            .toLocaleLowerCase()
            .includes(keyword),
    );
}

/**
 * 渲染主题系列。
 */
async function renderGroups() {
    if (!activeManager) {
        return;
    }

    revokeObjectUrls();

    const settings = getSettings();
    const grid = activeManager
        .find('#ntm_groups_grid')
        .get(0);

    const empty = activeManager.find('#ntm_empty');

    if (!grid) {
        return;
    }

    grid.innerHTML = '';

    const keyword = String(
        activeManager.find('#ntm_search').val() ?? '',
    ).trim().toLocaleLowerCase();

    const visibleGroups = settings.groups.filter(
        group => groupMatchesSearch(group, keyword),
    );

    for (const group of visibleGroups) {
        const activeVariant = getActiveVariant(group);

        const card = document.createElement('article');

        card.className = 'ntm-group-card';
        card.dataset.groupId = group.id;

        if (
            activeVariant?.nativeThemeValue &&
            activeVariant.nativeThemeValue ===
                getCurrentThemeValue()
        ) {
            card.classList.add('ntm-group-card-current');
        }

        const colorButtons = group.variants
            .map(variant => {
                const selected =
                    variant.id === activeVariant?.id;

                const actualThemeActive =
                    variant.nativeThemeValue &&
                    variant.nativeThemeValue ===
                        getCurrentThemeValue();

                return `
                    <button
                        type="button"
                        class="
                            ntm-color-dot
                            ${selected ? 'ntm-color-dot-selected' : ''}
                            ${actualThemeActive ? 'ntm-color-dot-current' : ''}
                        "
                        data-action="activate-variant"
                        data-group-id="${escapeAttribute(group.id)}"
                        data-variant-id="${escapeAttribute(variant.id)}"
                        title="${escapeAttribute(variant.name)}"
                        style="--ntm-dot-color: ${escapeAttribute(variant.color)}"
                    >
                        <span></span>
                    </button>
                `;
            })
            .join('');

card.style.setProperty(
    '--ntm-active-color',
    activeVariant?.color ||
    createStableColor(group.name),
);

card.innerHTML = `
    <div class="ntm-compact-preview">
        <div class="ntm-preview-content">
            <div class="ntm-preview-placeholder">
                <div class="ntm-placeholder-decoration">
                    <div class="ntm-placeholder-topbar">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>

                    <div class="ntm-placeholder-chat">
                        <div class="ntm-placeholder-avatar"></div>

                        <div class="ntm-placeholder-lines">
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                    </div>

                    <div class="ntm-placeholder-input"></div>
                </div>
            </div>

            <img
                class="ntm-preview-image displayNone"
                alt="${escapeAttribute(group.name)}"
            >
        </div>
    </div>

    <div class="ntm-group-info">
        <div class="ntm-group-title-row">
            <div class="ntm-group-title-block">
                <h4 title="${escapeAttribute(group.name)}">
                    ${escapeHtml(group.name)}
                </h4>

                <div class="ntm-preview-badge">
                    ${
                        activeVariant
                            ? escapeHtml(activeVariant.name)
                            : '无色系'
                    }
                </div>

                <div class="ntm-group-theme-name">
                    ${
                        activeVariant?.nativeThemeValue
                            ? escapeHtml(activeVariant.nativeThemeValue)
                            : activeVariant?.themeFileName
                                ? escapeHtml(activeVariant.themeFileName)
                                : '尚未关联真实主题'
                    }
                </div>
            </div>

            <div class="ntm-card-controls">
                <button
                    type="button"
                    class="menu_button ntm-card-icon-button"
                    data-action="edit-group"
                    data-group-id="${escapeAttribute(group.id)}"
                    title="编辑主题系列"
                >
                    <i class="fa-solid fa-gear"></i>
                </button>

                <button
                    type="button"
                    class="menu_button ntm-card-icon-button ntm-card-delete"
                    data-action="delete-group"
                    data-group-id="${escapeAttribute(group.id)}"
                    title="删除主题系列"
                >
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>

        <div class="ntm-color-row">
            <div class="ntm-color-dots">
                ${colorButtons}
            </div>

            <button
                type="button"
                class="ntm-add-color-button"
                data-action="edit-group"
                data-group-id="${escapeAttribute(group.id)}"
                title="添加或编辑色系"
            >
                <i class="fa-solid fa-plus"></i>
            </button>
        </div>
    </div>

    <div class="ntm-row-actions">
        <button
            type="button"
            class="ntm-apply-button"
            data-action="activate-current"
            data-group-id="${escapeAttribute(group.id)}"
        >
            <i class="fa-solid fa-check"></i>
            <span>应用</span>
        </button>
    </div>
`;


        grid.appendChild(card);

        if (activeVariant?.previewKey) {
            const previewBlob = await readBlob(
                activeVariant.previewKey,
            );

            if (previewBlob) {
                const objectUrl =
                    URL.createObjectURL(previewBlob);

                activeObjectUrls.push(objectUrl);

                const image = card.querySelector(
                    '.ntm-preview-image',
                );

                const placeholder = card.querySelector(
                    '.ntm-preview-placeholder',
                );

                if (image instanceof HTMLImageElement) {
                    image.src = objectUrl;
                    image.classList.remove('displayNone');
                }

                placeholder?.classList.add('displayNone');
            }
        }
    }

    if (visibleGroups.length === 0) {
        empty.removeClass('displayNone');
    } else {
        empty.addClass('displayNone');
    }

    updateCurrentThemeDisplay();
}

/* =========================================================
 * 主题系列编辑器
 * ========================================================= */

/**
 * 深度复制一个主题系列。
 *
 * @param {object} group
 * @returns {object}
 */
function cloneGroup(group) {
    return structuredClone(group);
}

/**
 * 创建新变体。
 *
 * @returns {object}
 */
function createEmptyVariant() {
    return {
        id: uuidv4(),
        name: '新色系',
        colorAuto: true,
        color: createStableColor('新色系'),
        nativeThemeValue: '',
        previewKey: '',
        previewFileName: '',
        themeFileKey: '',
        themeFileName: '',
        themeFileSuggestedName: '',
    };
}


/**
 * 构建系列编辑器。
 *
 * @param {object} draft
 * @returns {JQuery<HTMLElement>}
 */
function createGroupEditor(draft) {
    const editor = $(`
        <div class="ntm-group-editor">
            <div class="ntm-editor-heading">
                <div>
                    <h3>编辑主题系列</h3>
                    <small>
                        一个系列可以包含多个颜色变体
                    </small>
                </div>
            </div>

            <label class="ntm-field">
                <span>主题系列名称</span>
                <input
                    id="ntm_group_name"
                    class="text_pole"
                    type="text"
                    value="${escapeAttribute(draft.name)}"
                    placeholder="例如：Moonlight"
                >
            </label>

            <div class="ntm-editor-section-title">
                <div>
                    <strong>颜色变体</strong>
                    <small>
                        每个变体可关联一张预览图和一个真实主题
                    </small>
                </div>

                <div
                    id="ntm_add_variant"
                    class="menu_button menu_button_icon"
                >
                    <i class="fa-solid fa-plus"></i>
                    <span>添加色系</span>
                </div>
            </div>

            <div id="ntm_variant_editor_list"></div>
        </div>
    `);

    const list = editor.find(
        '#ntm_variant_editor_list',
    );

    /**
     * 重新渲染变体编辑器。
     */
    const renderVariantEditors = async () => {
        list.empty();

        const nativeThemes = getNativeThemes();

        for (const variant of draft.variants) {
            const nativeOptions = [
                '<option value="">不关联已安装主题</option>',
                ...nativeThemes.map(theme => `
                    <option
                        value="${escapeAttribute(theme.value)}"
                        ${
                            theme.value ===
                            variant.nativeThemeValue
                                ? 'selected'
                                : ''
                        }
                    >
                        ${escapeHtml(theme.name)}
                    </option>
                `),
            ].join('');

            const row = $(`
                <div
                    class="ntm-variant-editor"
                    data-variant-id="${escapeAttribute(variant.id)}"
                >
                    <div class="ntm-variant-editor-top">
<div class="ntm-color-editor">
    <label class="ntm-color-input-wrap">
        <input
            class="ntm-variant-color"
            type="color"
            value="${escapeAttribute(
                normalizeColorToHex(variant.color) || '#8b7cff'
            )}"
            ${variant.colorAuto !== false ? 'disabled' : ''}
        >
    </label>

    <label
        class="checkbox_label ntm-auto-color-label"
        title="应用这个主题后，从 SillyTavern CSS 变量中读取真实主题色"
    >
        <input
            class="ntm-auto-color"
            type="checkbox"
            ${variant.colorAuto !== false ? 'checked' : ''}
        >
        <small>自动主题色</small>
    </label>
</div>
                        <label class="ntm-field ntm-variant-name-field">
                            <span>色系名称</span>
                            <input
                                class="ntm-variant-name text_pole"
                                type="text"
                                value="${escapeAttribute(variant.name)}"
                                placeholder="例如：紫色"
                            >
                        </label>

                        <button
                            type="button"
                            class="menu_button ntm-remove-variant"
                            title="删除色系"
                        >
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>

                    <div class="ntm-variant-editor-body">
                        <div class="ntm-editor-preview-column">
<div
    class="ntm-mini-preview"
    style="--ntm-editor-color: ${escapeAttribute(variant.color)}"
>
    <div class="ntm-mini-placeholder">
        <div class="ntm-mini-placeholder-art">
            <i class="fa-solid fa-image"></i>
        </div>
    </div>

    <img
        class="ntm-mini-preview-image displayNone"
        alt=""
    >
</div>


                            <label class="menu_button menu_button_icon ntm-upload-label">
                                <i class="fa-solid fa-image"></i>
                                <span>上传竖屏预览图</span>

                                <input
                                    class="ntm-preview-file"
                                    type="file"
                                    accept="image/*"
                                    hidden
                                >
                            </label>

                            <small class="ntm-file-status ntm-preview-status">
                                ${
                                    variant.previewFileName
                                        ? escapeHtml(
                                            variant.previewFileName,
                                        )
                                        : '未上传预览图'
                                }
                            </small>
                        </div>

                        <div class="ntm-editor-link-column">
                            <label class="ntm-field">
                                <span>关联已安装的原生主题</span>

                                <select class="ntm-native-theme-select text_pole">
                                    ${nativeOptions}
                                </select>
                            </label>

                            <div class="ntm-link-divider">
                                <span>或者</span>
                            </div>

                            <label class="menu_button menu_button_icon ntm-upload-label">
                                <i class="fa-solid fa-file-code"></i>
                                <span>上传真实 Theme JSON</span>

                                <input
                                    class="ntm-theme-json-file"
                                    type="file"
                                    accept=".json,application/json"
                                    hidden
                                >
                            </label>

                            <div class="ntm-json-file-info">
                                <strong>已保存文件：</strong>
                                <span class="ntm-theme-file-status">
                                    ${
                                        variant.themeFileName
                                            ? escapeHtml(
                                                variant.themeFileName,
                                            )
                                            : '未上传'
                                    }
                                </span>
                            </div>

                            <small>
                                如果关联的原生主题不存在，点击该颜色时会自动导入此 JSON。
                            </small>
                        </div>
                    </div>
                </div>
            `);

            list.append(row);

            const image = row.find(
                '.ntm-mini-preview-image',
            ).get(0);

            const placeholder = row.find(
                '.ntm-mini-placeholder',
            );

            if (
                variant.previewKey &&
                image instanceof HTMLImageElement
            ) {
                const previewBlob = await readBlob(
                    variant.previewKey,
                );

                if (previewBlob) {
                    const objectUrl =
                        URL.createObjectURL(previewBlob);

                    activeObjectUrls.push(objectUrl);

                    image.src = objectUrl;
                    image.classList.remove('displayNone');
                    placeholder.addClass('displayNone');
                }
            }

            row.find('.ntm-variant-name').on(
                'input',
                function () {
                    variant.name = String(
                        $(this).val() ?? '',
                    );
                },
            );

row.find('.ntm-variant-color').on(
    'input',
    function () {
        variant.color = String(
            $(this).val() ?? '#8b7cff',
        );

        variant.colorAuto = false;

        row.find('.ntm-mini-preview').css(
            '--ntm-editor-color',
            variant.color,
        );
    },
);

row.find('.ntm-auto-color').on(
    'change',
    function () {
        const enabled = Boolean($(this).prop('checked'));

        variant.colorAuto = enabled;

        row.find('.ntm-variant-color')
            .prop('disabled', enabled);

        if (enabled) {
            variant.color = createStableColor(
                variant.nativeThemeValue ||
                variant.name ||
                draft.name,
            );

            const normalized =
                normalizeColorToHex(variant.color);

            if (normalized) {
                row.find('.ntm-variant-color')
                    .val(normalized);
            }

            row.find('.ntm-mini-preview').css(
                '--ntm-editor-color',
                variant.color,
            );
        }
    },
);
row.find('.ntm-native-theme-select').on(
    'change',
    function () {
        variant.nativeThemeValue = String(
            $(this).val() ?? '',
        );

        /*
         * 自动颜色状态下，先通过主题名称给出一个临时颜色。
         * 实际应用后会读取真正的主题色。
         */
        if (variant.colorAuto !== false) {
            const selectedOption =
                this instanceof HTMLSelectElement
                    ? this.selectedOptions[0]
                    : null;

            const themeName =
                selectedOption?.textContent?.trim() ||
                variant.nativeThemeValue ||
                variant.name;

            variant.color = createStableColor(themeName);

            const normalized =
                normalizeColorToHex(variant.color);

            if (normalized) {
                row.find('.ntm-variant-color')
                    .val(normalized);
            }

            row.find('.ntm-mini-preview').css(
                '--ntm-editor-color',
                variant.color,
            );
        }
    },
);

            row.find('.ntm-preview-file').on(
                'change',
                async function () {
                    const input =
                        this instanceof HTMLInputElement
                            ? this
                            : null;

                    const file = input?.files?.[0];

                    if (!file) {
                        return;
                    }

                    if (!file.type.startsWith('image/')) {
                        toastr.error('请选择图片文件。');
                        return;
                    }

                    const key =
                        variant.previewKey ||
                        `preview:${uuidv4()}`;

                    await saveBlob(key, file);

                    variant.previewKey = key;
                    variant.previewFileName = file.name;

                    const objectUrl =
                        URL.createObjectURL(file);

                    activeObjectUrls.push(objectUrl);

                    if (image instanceof HTMLImageElement) {
                        image.src = objectUrl;
                        image.classList.remove('displayNone');
                    }

                    placeholder.addClass('displayNone');

                    row.find('.ntm-preview-status')
                        .text(file.name);

                    toastr.success('预览图已读取。');
                },
            );

            row.find('.ntm-theme-json-file').on(
                'change',
                async function () {
                    const input =
                        this instanceof HTMLInputElement
                            ? this
                            : null;

                    const file = input?.files?.[0];

                    if (!file) {
                        return;
                    }

                    try {
                        const text = await file.text();
                        const parsed = JSON.parse(text);

                        const key =
                            variant.themeFileKey ||
                            `theme:${uuidv4()}`;

                        await saveBlob(
                            key,
                            new Blob(
                                [text],
                                {
                                    type: 'application/json',
                                },
                            ),
                        );

                        variant.themeFileKey = key;
                        variant.themeFileName = file.name;
                        variant.themeFileSuggestedName =
                            getSuggestedThemeName(parsed);

                        row.find('.ntm-theme-file-status')
                            .text(file.name);

                        toastr.success(
                            '真实主题文件已保存。',
                        );
                    } catch (error) {
                        console.error(error);
                        toastr.error(
                            '这不是有效的 JSON 主题文件。',
                        );
                    }
                },
            );

            row.find('.ntm-remove-variant').on(
                'click',
                async () => {
                    if (draft.variants.length <= 1) {
                        toastr.warning(
                            '每个主题系列至少保留一个色系。',
                        );
                        return;
                    }

                    const confirmed =
                        await callGenericPopup(
                            `确定删除色系“${escapeHtml(variant.name)}”吗？`,
                            POPUP_TYPE.CONFIRM,
                            '',
                            {
                                okButton: '删除',
                                cancelButton: '取消',
                            },
                        );

                    if (!confirmed) {
                        return;
                    }

                    draft.variants =
                        draft.variants.filter(
                            item =>
                                item.id !== variant.id,
                        );

                    if (
                        draft.activeVariantId === variant.id
                    ) {
                        draft.activeVariantId =
                            draft.variants[0]?.id || '';
                    }

                    await renderVariantEditors();
                },
            );
        }
    };

    editor.find('#ntm_add_variant').on(
        'click',
        async () => {
            const variant = createEmptyVariant();

            draft.variants.push(variant);
            draft.activeVariantId =
                draft.activeVariantId || variant.id;

            await renderVariantEditors();
        },
    );

    renderVariantEditors();

    editor.data('draft', draft);

    return editor;
}

/**
 * 打开主题系列编辑器。
 *
 * @param {object} group
 * @returns {Promise<boolean>}
 */
async function editGroup(group) {
    const draft = cloneGroup(group);
    const editor = createGroupEditor(draft);

    const result = await callGenericPopup(
        editor,
        POPUP_TYPE.CONFIRM,
        '',
        {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: '保存',
            cancelButton: '取消',
        },
    );

    if (!result) {
        return false;
    }

    draft.name = String(
        editor.find('#ntm_group_name').val() ?? '',
    ).trim() || '未命名主题系列';

    if (draft.variants.length === 0) {
        toastr.error('主题系列至少需要一个色系。');
        return false;
    }

    if (
        !draft.variants.some(
            variant =>
                variant.id === draft.activeVariantId,
        )
    ) {
        draft.activeVariantId =
            draft.variants[0].id;
    }

    Object.assign(group, draft);

    saveSettings();
    await renderGroups();

    toastr.success('主题系列已保存。');

    return true;
}

/* =========================================================
 * 管理器事件
 * ========================================================= */

function findGroup(groupId) {
    return getSettings().groups.find(
        group => group.id === groupId,
    ) ?? null;
}

function findVariant(group, variantId) {
    return group?.variants.find(
        variant => variant.id === variantId,
    ) ?? null;
}

function bindManagerEvents(manager) {
    manager.find('#ntm_search').on(
        'input',
        () => renderGroups(),
    );

    manager.find('#ntm_sync_native').on(
        'click',
        async () => {
            syncNativeThemesToGroups();
            await renderGroups();

            toastr.success('已同步原生主题列表。');
        },
    );

    manager.find('#ntm_add_group').on(
        'click',
        async () => {
            const variant = createEmptyVariant();

            const group = {
                id: uuidv4(),
                name: '新主题系列',
                activeVariantId: variant.id,
                variants: [variant],
            };

            const saved = await editGroup(group);

            if (!saved) {
                return;
            }

            getSettings().groups.push(group);
            saveSettings();

            await renderGroups();
        },
    );

    manager.find('#ntm_groups_grid').on(
        'click',
        async event => {
            const target = event.target instanceof Element
                ? event.target.closest('[data-action]')
                : null;

            if (!(target instanceof HTMLElement)) {
                return;
            }

            const action = target.dataset.action;
            const groupId = target.dataset.groupId;
            const variantId = target.dataset.variantId;

            const group = findGroup(groupId);

            if (!group) {
                return;
            }

            if (action === 'activate-variant') {
                const variant = findVariant(
                    group,
                    variantId,
                );

                if (variant) {
                    await activateVariant(
                        group,
                        variant,
                    );
                }

                return;
            }

            if (action === 'activate-current') {
                const variant =
                    getActiveVariant(group);

                if (variant) {
                    await activateVariant(
                        group,
                        variant,
                    );
                }

                return;
            }

            if (action === 'edit-group') {
                await editGroup(group);
                return;
            }

            if (action === 'delete-group') {
                const confirmed =
                    await callGenericPopup(
                        `确定删除主题系列“${escapeHtml(group.name)}”吗？`,
                        POPUP_TYPE.CONFIRM,
                        '',
                        {
                            okButton: '删除',
                            cancelButton: '取消',
                        },
                    );

                if (!confirmed) {
                    return;
                }

                const settings = getSettings();

                settings.groups =
                    settings.groups.filter(
                        item => item.id !== group.id,
                    );

                saveSettings();
                await renderGroups();

                toastr.success('主题系列已删除。');
            }
        },
    );
}

/* =========================================================
 * 打开管理器
 * ========================================================= */

function observeThemeSelect() {
    const select = getThemeSelect();

    if (!select) {
        return;
    }

    themeSelectObserver?.disconnect();

    themeSelectObserver = new MutationObserver(
        async () => {
            syncNativeThemesToGroups();

            if (activeManager) {
                await renderGroups();
            }
        },
    );

    themeSelectObserver.observe(select, {
        childList: true,
        subtree: true,
        attributes: true,
    });

    select.addEventListener('change', () => {
        window.setTimeout(async () => {
            if (activeManager) {
                await renderGroups();
            }
        }, 0);
    });
}

async function openThemeManager() {
    if (document.getElementById(MANAGER_ID)) {
        return;
    }

    if (!getThemeSelect()) {
        toastr.warning(
            'SillyTavern 主题列表尚未加载完成，请稍后再试。',
        );
        return;
    }

    syncNativeThemesToGroups();

    const manager = createManagerHtml();
    activeManager = manager;

    bindManagerEvents(manager);
    observeThemeSelect();

    await renderGroups();

    try {
        await callGenericPopup(
            manager,
            POPUP_TYPE.TEXT,
            '',
            {
                wide: true,
                large: true,
                allowVerticalScrolling: true,
            },
        );
    } finally {
        activeManager = null;

        themeSelectObserver?.disconnect();
        themeSelectObserver = null;

        revokeObjectUrls();
    }
}

/* =========================================================
 * 两个入口注入
 * ========================================================= */

function createEntryButton(id) {
    const button = document.createElement('div');

    button.id = id;
    button.className =
        'menu_button menu_button_icon ntm-entry-button';

    button.innerHTML = `
        <i class="fa-solid fa-swatchbook"></i>
        <span>主题展示管理器</span>
    `;

    button.title = '打开主题展示与色系管理器';

    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        openThemeManager();
    });

    return button;
}

function injectIntoThemeSettings() {
    if (document.getElementById(SETTINGS_ENTRY_ID)) {
        return true;
    }

    const anchor = document.querySelector(
        SETTINGS_ANCHOR_SELECTOR,
    );

    if (!anchor) {
        return false;
    }

    const wrapper = document.createElement('div');

    wrapper.id = SETTINGS_ENTRY_ID;
    wrapper.className = 'ntm-settings-entry';

    wrapper.appendChild(
        createEntryButton(
            `${SETTINGS_ENTRY_ID}_button`,
        ),
    );

    anchor.insertAdjacentElement(
        'afterend',
        wrapper,
    );

    return true;
}

function injectIntoExtensionsMenu() {
    if (document.getElementById(EXTENSIONS_ENTRY_ID)) {
        return true;
    }

    const menu = document.querySelector(
        '#extensionsMenu',
    );

    if (menu instanceof HTMLElement) {
        const entry = document.createElement('div');

        entry.id = EXTENSIONS_ENTRY_ID;
        entry.className =
            'list-group-item interactable ntm-extension-entry';

        entry.innerHTML = `
            <i class="fa-solid fa-swatchbook fa-fw"></i>
            <span>主题展示管理器</span>
        `;

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            openThemeManager();
        });

        menu.appendChild(entry);

        return true;
    }

    const menuButton = document.querySelector(
        '#extensionsMenuButton',
    );

    if (!(menuButton instanceof HTMLElement)) {
        return false;
    }

    const entry = createEntryButton(
        EXTENSIONS_ENTRY_ID,
    );

    menuButton.appendChild(entry);

    return true;
}

function injectAllEntries() {
    injectIntoThemeSettings();
    injectIntoExtensionsMenu();
}

function startDomObserver() {
    injectAllEntries();

    let scheduled = false;

    const observer = new MutationObserver(() => {
        if (scheduled) {
            return;
        }

        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;
            injectAllEntries();
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

/* =========================================================
 * 初始化
 * ========================================================= */

function init() {
    getSettings();
    startDomObserver();

    const waitForThemes = window.setInterval(() => {
        if (!getThemeSelect()) {
            return;
        }

        window.clearInterval(waitForThemes);

        syncNativeThemesToGroups();
        observeThemeSelect();
    }, 500);

    console.log(
        '[Theme Manager] Theme showcase manager initialized.',
    );
}

jQuery(() => {
    init();
});

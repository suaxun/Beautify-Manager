import {
    callGenericPopup,
    POPUP_TYPE,
} from '../../../popup.js';

/**
 * 扩展内部名称。
 */
const EXTENSION_NAME = 'native_theme_manager';

/**
 * 用户设置中的入口。
 */
const SETTINGS_ENTRY_ID = 'native_theme_manager_settings_entry';

/**
 * 扩展菜单中的入口。
 */
const EXTENSIONS_ENTRY_ID = 'native_theme_manager_extensions_entry';

/**
 * 管理器弹窗 ID。
 */
const MANAGER_ID = 'native_theme_manager_popup';

/**
 * 原生主题选择器。
 *
 * 来自 SillyTavern 页面：
 *
 * <select id="themes"></select>
 */
const NATIVE_THEME_SELECT_SELECTOR = '#themes';

/**
 * “用户设置 → UI Theme”中的注入位置。
 *
 * 对应：
 *
 * #UI-presets-block
 *   > .flex-container.flexnowrap.alignitemscenter
 */
const SETTINGS_ANCHOR_SELECTOR =
    '#UI-presets-block > .flex-container.flexnowrap.alignitemscenter';

/**
 * 当前打开的管理器对象。
 *
 * @type {JQuery<HTMLElement>|null}
 */
let activeManager = null;

/**
 * 用于监控原生主题列表变化。
 *
 * @type {MutationObserver|null}
 */
let themeSelectObserver = null;

/**
 * 管理器是否正在执行原生操作。
 */
let nativeOperationRunning = false;

/**
 * 获取 SillyTavern 原生主题选择框。
 *
 * @returns {HTMLSelectElement|null}
 */
function getNativeThemeSelect() {
    const select = document.querySelector(NATIVE_THEME_SELECT_SELECTOR);

    return select instanceof HTMLSelectElement
        ? select
        : null;
}

/**
 * 读取 SillyTavern 当前所有原生主题。
 *
 * 这里不读取扩展自己的数据，而是直接读取 #themes 中的 option。
 *
 * @returns {{
 *     value: string,
 *     name: string,
 *     selected: boolean,
 *     disabled: boolean
 * }[]}
 */
function getNativeThemes() {
    const select = getNativeThemeSelect();

    if (!select) {
        return [];
    }

    return Array.from(select.options)
        .filter(option => option.value !== '')
        .map(option => ({
            value: option.value,
            name: option.textContent?.trim() || option.value,
            selected: option.selected,
            disabled: option.disabled,
        }));
}

/**
 * 获取当前主题。
 *
 * @returns {{
 *     value: string,
 *     name: string,
 *     selected: boolean,
 *     disabled: boolean
 * }|null}
 */
function getCurrentNativeTheme() {
    const themes = getNativeThemes();

    return themes.find(theme => theme.selected) ?? null;
}

/**
 * 将任意值转为可用于 CSS.escape 的字符串。
 *
 * @param {string} value
 * @returns {string}
 */
function escapeCssValue(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }

    return String(value).replace(
        /["\\]/g,
        character => `\\${character}`,
    );
}

/**
 * HTML 编码。
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
 * 切换 SillyTavern 原生主题。
 *
 * 关键点：
 * 不是自己注入 CSS，而是改变 #themes 的值并触发 change。
 *
 * SillyTavern 自己会负责应用主题和保存主题选择。
 *
 * @param {string} themeValue
 * @returns {boolean}
 */
function selectNativeTheme(themeValue) {
    const select = getNativeThemeSelect();

    if (!select) {
        toastr.error('没有找到 SillyTavern 原生主题选择器。');
        return false;
    }

    const optionExists = Array.from(select.options)
        .some(option => option.value === themeValue);

    if (!optionExists) {
        toastr.error(`找不到主题：${themeValue}`);
        return false;
    }

    select.value = themeValue;

    /*
     * 同时触发 input 和 change，兼容不同版本的 SillyTavern。
     */
    select.dispatchEvent(new Event('input', {
        bubbles: true,
    }));

    select.dispatchEvent(new Event('change', {
        bubbles: true,
    }));

    /*
     * SillyTavern 大量界面仍然使用 jQuery。
     * 原生 change 一般已经够用，这里作为额外兼容。
     */
    if (window.jQuery) {
        window.jQuery(select).trigger('change');
    }

    return true;
}

/**
 * 获取主题名称的首字。
 *
 * @param {string} name
 * @returns {string}
 */
function getThemeInitial(name) {
    const trimmed = String(name || '').trim();

    if (!trimmed) {
        return 'T';
    }

    return Array.from(trimmed)[0].toUpperCase();
}

/**
 * 根据主题名称生成稳定的色相。
 *
 * 这里只用于卡片装饰，不代表主题本身的真实颜色。
 *
 * @param {string} text
 * @returns {number}
 */
function getThemeHue(text) {
    let hash = 0;

    for (const character of String(text)) {
        hash = ((hash << 5) - hash) + character.codePointAt(0);
        hash |= 0;
    }

    return Math.abs(hash) % 360;
}

/**
 * 创建主题卡片。
 *
 * @param {{
 *     value: string,
 *     name: string,
 *     selected: boolean,
 *     disabled: boolean
 * }} theme
 * @returns {HTMLElement}
 */
function createThemeCard(theme) {
    const card = document.createElement('div');

    card.className = 'ntm-theme-card';
    card.dataset.themeValue = theme.value;
    card.tabIndex = theme.disabled ? -1 : 0;

    if (theme.selected) {
        card.classList.add('ntm-theme-card-selected');
    }

    if (theme.disabled) {
        card.classList.add('ntm-theme-card-disabled');
    }

    const hue = getThemeHue(theme.name);

    card.style.setProperty('--ntm-theme-hue', String(hue));

    card.innerHTML = `
        <div class="ntm-theme-preview">
            <div class="ntm-theme-preview-background"></div>

            <div class="ntm-theme-preview-panel">
                <div class="ntm-theme-preview-line ntm-theme-preview-line-long"></div>
                <div class="ntm-theme-preview-line"></div>
                <div class="ntm-theme-preview-button"></div>
            </div>

            <div class="ntm-theme-initial">
                ${escapeHtml(getThemeInitial(theme.name))}
            </div>

            <div class="ntm-theme-selected-icon">
                <i class="fa-solid fa-circle-check"></i>
            </div>
        </div>

        <div class="ntm-theme-info">
            <div class="ntm-theme-name" title="${escapeHtml(theme.name)}">
                ${escapeHtml(theme.name)}
            </div>

            <div class="ntm-theme-value" title="${escapeHtml(theme.value)}">
                ${escapeHtml(theme.value)}
            </div>
        </div>

        <div class="ntm-theme-card-footer">
            <span class="ntm-theme-status">
                ${theme.selected ? '当前使用' : '点击切换'}
            </span>

            <i class="fa-solid fa-chevron-right"></i>
        </div>
    `;

    const activate = () => {
        if (theme.disabled) {
            return;
        }

        const success = selectNativeTheme(theme.value);

        if (!success) {
            return;
        }

        /*
         * 主题应用可能需要一小段时间。
         */
        window.setTimeout(() => {
            renderThemeCards();
            updateManagerStatus();
        }, 50);
    };

    card.addEventListener('click', activate);

    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
        }
    });

    return card;
}

/**
 * 获取管理器中的搜索关键字。
 *
 * @returns {string}
 */
function getSearchKeyword() {
    if (!activeManager) {
        return '';
    }

    return String(
        activeManager.find('#ntm_theme_search').val() ?? '',
    ).trim().toLocaleLowerCase();
}

/**
 * 渲染所有主题卡片。
 */
function renderThemeCards() {
    if (!activeManager) {
        return;
    }

    const grid = activeManager.find('#ntm_theme_grid').get(0);
    const empty = activeManager.find('#ntm_empty_state');
    const themes = getNativeThemes();
    const keyword = getSearchKeyword();

    if (!grid) {
        return;
    }

    grid.innerHTML = '';

    const filteredThemes = themes.filter(theme => {
        if (!keyword) {
            return true;
        }

        return theme.name.toLocaleLowerCase().includes(keyword)
            || theme.value.toLocaleLowerCase().includes(keyword);
    });

    for (const theme of filteredThemes) {
        grid.appendChild(createThemeCard(theme));
    }

    if (themes.length === 0) {
        empty
            .removeClass('displayNone')
            .find('.ntm-empty-title')
            .text('没有检测到主题');

        empty
            .find('.ntm-empty-description')
            .text('请先打开“用户设置”，等待 SillyTavern 加载主题列表。');
    } else if (filteredThemes.length === 0) {
        empty
            .removeClass('displayNone')
            .find('.ntm-empty-title')
            .text('没有搜索结果');

        empty
            .find('.ntm-empty-description')
            .text('尝试使用其他主题名称进行搜索。');
    } else {
        empty.addClass('displayNone');
    }

    activeManager
        .find('#ntm_theme_count')
        .text(String(themes.length));

    updateManagerStatus();
}

/**
 * 更新顶部当前主题信息。
 */
function updateManagerStatus() {
    if (!activeManager) {
        return;
    }

    const currentTheme = getCurrentNativeTheme();

    activeManager
        .find('#ntm_current_theme')
        .text(currentTheme?.name || '未检测到');

    activeManager
        .find('#ntm_current_theme_value')
        .text(currentTheme?.value || '—');

    activeManager
        .find('#ntm_export_theme, #ntm_update_theme, #ntm_delete_theme')
        .toggleClass('ntm-action-disabled', !currentTheme);
}

/**
 * 构建管理器弹窗。
 *
 * @returns {JQuery<HTMLElement>}
 */
function createManagerHtml() {
    return $(`
        <div id="${MANAGER_ID}">
            <div class="ntm-manager-header">
                <div class="ntm-manager-title-block">
                    <div class="ntm-manager-icon">
                        <i class="fa-solid fa-palette"></i>
                    </div>

                    <div>
                        <h3 class="ntm-manager-title">
                            SillyTavern 主题管理器
                        </h3>

                        <div class="ntm-manager-subtitle">
                            读取并管理 SillyTavern 当前已安装的所有原生主题
                        </div>
                    </div>
                </div>

                <div class="ntm-current-theme-card">
                    <div class="ntm-current-theme-label">
                        当前主题
                    </div>

                    <div id="ntm_current_theme" class="ntm-current-theme-name">
                        正在读取……
                    </div>

                    <div
                        id="ntm_current_theme_value"
                        class="ntm-current-theme-value"
                    >
                        —
                    </div>
                </div>
            </div>

            <div class="ntm-manager-toolbar">
                <div class="ntm-search-wrapper">
                    <i class="fa-solid fa-magnifying-glass"></i>

                    <input
                        id="ntm_theme_search"
                        class="text_pole"
                        type="search"
                        placeholder="搜索主题……"
                        autocomplete="off"
                    >
                </div>

                <div class="ntm-theme-counter">
                    共
                    <strong id="ntm_theme_count">0</strong>
                    个主题
                </div>

                <div class="ntm-toolbar-spacer"></div>

                <div
                    id="ntm_refresh_themes"
                    class="menu_button menu_button_icon"
                    title="刷新主题列表"
                >
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>刷新</span>
                </div>
            </div>

            <div class="ntm-native-actions">
                <div
                    id="ntm_import_theme"
                    class="menu_button menu_button_icon ntm-action"
                    title="使用 SillyTavern 原生主题导入功能"
                >
                    <i class="fa-solid fa-file-import"></i>
                    <span>导入主题</span>
                </div>

                <div
                    id="ntm_export_theme"
                    class="menu_button menu_button_icon ntm-action"
                    title="导出当前主题"
                >
                    <i class="fa-solid fa-file-export"></i>
                    <span>导出当前主题</span>
                </div>

                <div
                    id="ntm_save_theme"
                    class="menu_button menu_button_icon ntm-action"
                    title="将当前 UI 设置保存为新主题"
                >
                    <i class="fa-solid fa-file-circle-plus"></i>
                    <span>另存为新主题</span>
                </div>

                <div
                    id="ntm_update_theme"
                    class="menu_button menu_button_icon ntm-action"
                    title="将当前 UI 设置保存到当前主题"
                >
                    <i class="fa-solid fa-save"></i>
                    <span>更新当前主题</span>
                </div>

                <div
                    id="ntm_delete_theme"
                    class="menu_button menu_button_icon ntm-action ntm-delete-action"
                    title="删除当前主题"
                >
                    <i class="fa-solid fa-trash-can"></i>
                    <span>删除当前主题</span>
                </div>
            </div>

            <div class="ntm-section-header">
                <div>
                    <h4>已安装主题</h4>
                    <small>
                        点击主题卡片即可通过 SillyTavern 原生主题系统切换
                    </small>
                </div>
            </div>

            <div id="ntm_theme_grid" class="ntm-theme-grid"></div>

            <div id="ntm_empty_state" class="ntm-empty-state displayNone">
                <i class="fa-solid fa-palette"></i>

                <div class="ntm-empty-title">
                    没有检测到主题
                </div>

                <div class="ntm-empty-description">
                    请等待 SillyTavern 完成主题加载。
                </div>
            </div>

            <div class="ntm-manager-footer">
                <i class="fa-solid fa-circle-info"></i>

                <span>
                    这个管理器直接读取
                    <code>#themes</code>
                    ，不建立额外的主题数据库。
                    导入、导出、保存和删除操作均调用 SillyTavern 原生功能。
                </span>
            </div>
        </div>
    `);
}

/**
 * 点击 SillyTavern 原生控制按钮。
 *
 * @param {string} selector
 * @param {string} missingMessage
 * @returns {boolean}
 */
function clickNativeControl(selector, missingMessage) {
    const control = document.querySelector(selector);

    if (!(control instanceof HTMLElement)) {
        toastr.error(missingMessage);
        return false;
    }

    nativeOperationRunning = true;
    control.click();

    /*
     * 原生操作可能弹出输入窗口或文件选择器。
     * 稍后解除操作状态并刷新。
     */
    window.setTimeout(() => {
        nativeOperationRunning = false;
        renderThemeCards();
    }, 500);

    return true;
}

/**
 * 绑定弹窗事件。
 *
 * @param {JQuery<HTMLElement>} manager
 */
function bindManagerEvents(manager) {
    manager.find('#ntm_theme_search').on('input', () => {
        renderThemeCards();
    });

    manager.find('#ntm_refresh_themes').on('click', () => {
        renderThemeCards();
        toastr.success('主题列表已刷新。');
    });

    manager.find('#ntm_import_theme').on('click', () => {
        clickNativeControl(
            '#ui_preset_import_button',
            '找不到 SillyTavern 原生主题导入按钮。',
        );
    });

    manager.find('#ntm_export_theme').on('click', () => {
        const currentTheme = getCurrentNativeTheme();

        if (!currentTheme) {
            toastr.warning('当前没有选中的主题。');
            return;
        }

        clickNativeControl(
            '#ui_preset_export_button',
            '找不到 SillyTavern 原生主题导出按钮。',
        );
    });

    manager.find('#ntm_save_theme').on('click', () => {
        clickNativeControl(
            '#ui-preset-save-button',
            '找不到 SillyTavern 原生主题保存按钮。',
        );
    });

    manager.find('#ntm_update_theme').on('click', () => {
        const currentTheme = getCurrentNativeTheme();

        if (!currentTheme) {
            toastr.warning('当前没有选中的主题。');
            return;
        }

        clickNativeControl(
            '#ui-preset-update-button',
            '找不到 SillyTavern 原生主题更新按钮。',
        );
    });

    manager.find('#ntm_delete_theme').on('click', () => {
        const currentTheme = getCurrentNativeTheme();

        if (!currentTheme) {
            toastr.warning('当前没有选中的主题。');
            return;
        }

        clickNativeControl(
            '#ui-preset-delete-button',
            '找不到 SillyTavern 原生主题删除按钮。',
        );
    });
}

/**
 * 监听 #themes 中 option 的新增、删除和更新。
 */
function observeNativeThemeSelect() {
    const select = getNativeThemeSelect();

    if (!select) {
        return;
    }

    if (themeSelectObserver) {
        themeSelectObserver.disconnect();
    }

    themeSelectObserver = new MutationObserver(() => {
        if (nativeOperationRunning) {
            return;
        }

        renderThemeCards();
    });

    themeSelectObserver.observe(select, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });

    select.addEventListener('change', () => {
        window.setTimeout(() => {
            renderThemeCards();
        }, 0);
    });
}

/**
 * 打开主题管理器。
 */
async function openThemeManager() {
    /*
     * 避免重复打开。
     */
    if (document.getElementById(MANAGER_ID)) {
        return;
    }

    const select = getNativeThemeSelect();

    if (!select) {
        toastr.warning(
            'SillyTavern 的主题列表还没有加载完成，请稍后再试。',
        );
        return;
    }

    const manager = createManagerHtml();
    activeManager = manager;

    bindManagerEvents(manager);
    renderThemeCards();
    observeNativeThemeSelect();

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

        if (themeSelectObserver) {
            themeSelectObserver.disconnect();
            themeSelectObserver = null;
        }
    }
}

/**
 * 创建入口按钮。
 *
 * 使用 div 而不是 button，避免 SillyTavern 对原生 button
 * 应用 disabled / opacity 样式而导致整个入口看起来是灰色。
 *
 * @param {string} id
 * @returns {HTMLDivElement}
 */
function createEntryButton(id) {
    const button = document.createElement('div');

    button.id = id;
    button.className =
        'menu_button menu_button_icon ntm-entry-button';

    button.title = '打开 SillyTavern 主题管理器';

    button.innerHTML = `
        <i class="fa-solid fa-palette"></i>
        <span>主题管理器</span>
    `;

    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openThemeManager();
    });

    return button;
}

/**
 * 注入到用户设置的 Theme 区域。
 */
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

    const button = createEntryButton(
        `${SETTINGS_ENTRY_ID}_button`,
    );

    wrapper.appendChild(button);

    /*
     * 插入到：
     *
     * .flex-container.flexnowrap.alignitemscenter
     *
     * 的下面。
     */
    anchor.insertAdjacentElement('afterend', wrapper);

    return true;
}

/**
 * 注入到扩展菜单。
 *
 * 不同版本/第三方主题可能使用：
 *
 * #extensionsMenu
 * #extensionsMenuButton
 *
 * 所以分别兼容。
 */
function injectIntoExtensionsMenu() {
    if (document.getElementById(EXTENSIONS_ENTRY_ID)) {
        return true;
    }

    /*
     * 优先寻找真正的扩展菜单。
     */
    const menu = document.querySelector('#extensionsMenu');

    if (menu instanceof HTMLElement) {
        const entry = document.createElement('div');

        entry.id = EXTENSIONS_ENTRY_ID;
        entry.className =
            'list-group-item interactable ntm-extension-menu-entry';

        entry.innerHTML = `
            <i class="fa-solid fa-palette fa-fw"></i>
            <span>主题管理器</span>
        `;

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openThemeManager();
        });

        menu.appendChild(entry);
        return true;
    }

    /*
     * 如果你的版本把 #extensionsMenuButton 当成菜单容器，
     * 则注入其内部。
     */
    const menuButton = document.querySelector(
        '#extensionsMenuButton',
    );

    if (!(menuButton instanceof HTMLElement)) {
        return false;
    }

    const entry = document.createElement('div');

    entry.id = EXTENSIONS_ENTRY_ID;
    entry.className =
        'menu_button menu_button_icon ntm-extension-menu-entry';

    entry.innerHTML = `
        <i class="fa-solid fa-palette fa-fw"></i>
        <span>主题管理器</span>
    `;

    entry.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openThemeManager();
    });

    menuButton.appendChild(entry);

    return true;
}

/**
 * 注入全部入口。
 */
function injectAllEntries() {
    injectIntoThemeSettings();
    injectIntoExtensionsMenu();
}

/**
 * 监听 SillyTavern 动态 DOM。
 */
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

            if (
                activeManager
                && !themeSelectObserver
                && getNativeThemeSelect()
            ) {
                observeNativeThemeSelect();
            }
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

/**
 * 初始化。
 */
function init() {
    startDomObserver();

    console.log(
        `[${EXTENSION_NAME}] Native theme manager initialized.`,
    );
}

jQuery(() => {
    init();
});

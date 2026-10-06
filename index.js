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
    download,
    escapeHtml,
    getFileText,
    uuidv4,
} from '../../../utils.js';

const EXTENSION_NAME = 'beautify_manager';
const STYLE_ELEMENT_ID = 'beautify-manager-runtime-style';

const UI_ENTRY_ID = 'beautify_manager_ui_entry';
const EXTENSIONS_ENTRY_ID = 'beautify_manager_extensions_entry';

/**
 * “用户设置 → UI Theme”中的注入位置。
 *
 * 对应你给出的 HTML：
 *
 * #UI-presets-block
 *   └── .flex-container.flexnowrap.alignitemscenter
 *
 * 默认会插入到这个元素下面。
 */
const UI_THEME_ANCHOR_SELECTOR =
    '#UI-presets-block > .flex-container.flexnowrap.alignitemscenter';

/**
 * 默认主题。
 */
const DEFAULT_PRESETS = [
    {
        id: 'beautify-default-glass',
        name: '透明玻璃',
        css: `/* 透明玻璃主题示例 */
:root {
    --bm-accent: #9b8cff;
    --bm-panel-bg: rgba(20, 20, 28, 0.72);
    --bm-border: rgba(255, 255, 255, 0.12);
}

.drawer-content,
#sheld,
.popup,
#options {
    background: var(--bm-panel-bg) !important;
    border-color: var(--bm-border) !important;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
}

.menu_button:hover,
.right_menu_button:hover,
.interactable:hover {
    color: var(--bm-accent) !important;
}

textarea,
input,
select,
.text_pole {
    border-color: var(--bm-border) !important;
}
`,
    },
    {
        id: 'beautify-default-rounded',
        name: '圆角界面',
        css: `/* 圆角界面主题示例 */
:root {
    --bm-radius-small: 8px;
    --bm-radius-medium: 14px;
    --bm-radius-large: 20px;
}

.menu_button,
.text_pole,
textarea,
input,
select {
    border-radius: var(--bm-radius-small) !important;
}

.drawer-content,
.popup,
#options,
#sheld {
    border-radius: var(--bm-radius-large) !important;
}

.mes {
    border-radius: var(--bm-radius-medium) !important;
}
`,
    },
];

/**
 * 获取扩展设置对象。
 */
function getSettings() {
    if (
        !extension_settings[EXTENSION_NAME] ||
        typeof extension_settings[EXTENSION_NAME] !== 'object'
    ) {
        extension_settings[EXTENSION_NAME] = {};
    }

    const settings = extension_settings[EXTENSION_NAME];

    if (!Array.isArray(settings.presets)) {
        settings.presets = structuredClone(DEFAULT_PRESETS);
    }

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = true;
    }

    if (typeof settings.selectedPresetId !== 'string') {
        settings.selectedPresetId = settings.presets[0]?.id ?? '';
    }

    if (typeof settings.livePreview !== 'boolean') {
        settings.livePreview = true;
    }

    // 清理无效数据。
    settings.presets = settings.presets
        .filter(preset => preset && typeof preset === 'object')
        .map(preset => ({
            id: String(preset.id || uuidv4()),
            name: String(preset.name || '未命名主题'),
            css: String(preset.css || ''),
        }));

    // 当前选中的预设不存在时，选择第一个。
    if (
        settings.selectedPresetId &&
        !settings.presets.some(
            preset => preset.id === settings.selectedPresetId,
        )
    ) {
        settings.selectedPresetId = settings.presets[0]?.id ?? '';
    }

    return settings;
}

/**
 * 获取当前美化方案。
 */
function getSelectedPreset() {
    const settings = getSettings();

    return settings.presets.find(
        preset => preset.id === settings.selectedPresetId,
    ) ?? null;
}

/**
 * 创建运行时 style 标签。
 */
function getRuntimeStyleElement() {
    let style = document.getElementById(STYLE_ELEMENT_ID);

    if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement('style');
        style.id = STYLE_ELEMENT_ID;
        style.dataset.extension = EXTENSION_NAME;
        document.head.appendChild(style);
    }

    return style;
}

/**
 * 将当前美化方案应用到页面。
 */
function applySelectedPreset() {
    const settings = getSettings();
    const preset = getSelectedPreset();
    const style = getRuntimeStyleElement();

    if (!settings.enabled || !preset) {
        style.textContent = '';
        document.documentElement.removeAttribute('data-beautify-manager');
        return;
    }

    style.textContent = preset.css;
    document.documentElement.setAttribute(
        'data-beautify-manager',
        preset.id,
    );
}

/**
 * 保存设置。
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * HTML 安全编码，供属性使用。
 */
function escapeAttribute(value) {
    return escapeHtml(String(value ?? ''))
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#039;');
}

/**
 * 创建管理器界面。
 */
function createManagerHtml() {
    const settings = getSettings();
    const selectedPreset = getSelectedPreset();

    const options = settings.presets.map(preset => {
        const selected =
            preset.id === settings.selectedPresetId ? 'selected' : '';

        return `
            <option
                value="${escapeAttribute(preset.id)}"
                ${selected}
            >
                ${escapeHtml(preset.name)}
            </option>
        `;
    }).join('');

    const noPresets = settings.presets.length === 0;

    return $(`
        <div id="beautify_manager_popup">
            <div class="bm-header">
                <div>
                    <h3 class="bm-title">
                        <i class="fa-solid fa-palette"></i>
                        美化管理器
                    </h3>
                    <div class="bm-subtitle">
                        管理和切换 SillyTavern 自定义 CSS 美化方案
                    </div>
                </div>

                <label class="checkbox_label bm-master-switch">
                    <input
                        id="bm_enabled"
                        type="checkbox"
                        ${settings.enabled ? 'checked' : ''}
                    >
                    <span>启用美化</span>
                </label>
            </div>

            <div class="bm-toolbar">
                <select
                    id="bm_preset_select"
                    class="text_pole"
                    ${noPresets ? 'disabled' : ''}
                >
                    ${
                        noPresets
                            ? '<option value="">暂无美化方案</option>'
                            : options
                    }
                </select>

                <button
                    id="bm_new"
                    type="button"
                    class="menu_button menu_button_icon"
                    title="新建方案"
                >
                    <i class="fa-solid fa-file-circle-plus"></i>
                    <span>新建</span>
                </button>

                <button
                    id="bm_duplicate"
                    type="button"
                    class="menu_button menu_button_icon"
                    title="复制当前方案"
                    ${noPresets ? 'disabled' : ''}
                >
                    <i class="fa-solid fa-clone"></i>
                    <span>复制</span>
                </button>

                <button
                    id="bm_rename"
                    type="button"
                    class="menu_button menu_button_icon"
                    title="重命名"
                    ${noPresets ? 'disabled' : ''}
                >
                    <i class="fa-solid fa-pencil"></i>
                    <span>重命名</span>
                </button>

                <button
                    id="bm_delete"
                    type="button"
                    class="menu_button menu_button_icon bm-danger-button"
                    title="删除当前方案"
                    ${noPresets ? 'disabled' : ''}
                >
                    <i class="fa-solid fa-trash-can"></i>
                    <span>删除</span>
                </button>
            </div>

            <div class="bm-import-export-row">
                <button
                    id="bm_import"
                    type="button"
                    class="menu_button menu_button_icon"
                >
                    <i class="fa-solid fa-file-import"></i>
                    <span>导入</span>
                </button>

                <button
                    id="bm_export"
                    type="button"
                    class="menu_button menu_button_icon"
                    ${noPresets ? 'disabled' : ''}
                >
                    <i class="fa-solid fa-file-export"></i>
                    <span>导出</span>
                </button>

                <input
                    id="bm_import_file"
                    type="file"
                    accept=".json"
                    hidden
                >

                <span class="expander"></span>

                <label class="checkbox_label">
                    <input
                        id="bm_live_preview"
                        type="checkbox"
                        ${settings.livePreview ? 'checked' : ''}
                    >
                    <span>实时预览</span>
                </label>
            </div>

            <div class="bm-editor-block">
                <div class="bm-editor-header">
                    <label for="bm_css_editor">
                        <strong>自定义 CSS</strong>
                    </label>

                    <span id="bm_save_state" class="bm-save-state">
                        已保存
                    </span>
                </div>

                <textarea
                    id="bm_css_editor"
                    class="text_pole monospace"
                    rows="20"
                    spellcheck="false"
                    placeholder="在这里输入 CSS……"
                    ${noPresets ? 'disabled' : ''}
                >${escapeHtml(selectedPreset?.css ?? '')}</textarea>
            </div>

            <div class="bm-footer">
                <div class="bm-help">
                    <i class="fa-solid fa-circle-info"></i>
                    CSS 会通过独立的
                    <code>&lt;style&gt;</code>
                    标签注入，不会修改
                    <code>user.css</code>。
                </div>

                <div class="bm-footer-actions">
                    <button
                        id="bm_apply"
                        type="button"
                        class="menu_button menu_button_icon"
                        ${noPresets ? 'disabled' : ''}
                    >
                        <i class="fa-solid fa-eye"></i>
                        <span>应用</span>
                    </button>

                    <button
                        id="bm_save"
                        type="button"
                        class="menu_button menu_button_icon bm-primary-button"
                        ${noPresets ? 'disabled' : ''}
                    >
                        <i class="fa-solid fa-save"></i>
                        <span>保存</span>
                    </button>
                </div>
            </div>
        </div>
    `);
}

/**
 * 打开文字输入框。
 */
async function askForName(title, defaultValue = '') {
    const result = await callGenericPopup(
        title,
        POPUP_TYPE.INPUT,
        defaultValue,
        {
            okButton: '确定',
            cancelButton: '取消',
        },
    );

    if (result === false || result === null || result === undefined) {
        return null;
    }

    const name = String(result).trim();
    return name || null;
}

/**
 * 保存编辑器内容到当前预设。
 */
function saveEditorToCurrentPreset(managerHtml, showToast = true) {
    const settings = getSettings();
    const preset = getSelectedPreset();

    if (!preset) {
        toastr.warning('当前没有可以保存的美化方案。');
        return false;
    }

    preset.css = String(
        managerHtml.find('#bm_css_editor').val() ?? '',
    );

    saveSettings();
    applySelectedPreset();

    managerHtml.find('#bm_save_state')
        .text('已保存')
        .removeClass('bm-unsaved');

    if (showToast) {
        toastr.success(`美化方案“${preset.name}”已保存。`);
    }

    return true;
}

/**
 * 更新弹窗中的方案选择器和编辑器。
 */
function refreshManagerUi(managerHtml) {
    const settings = getSettings();
    const preset = getSelectedPreset();
    const select = managerHtml.find('#bm_preset_select');
    const editor = managerHtml.find('#bm_css_editor');

    select.empty();

    if (settings.presets.length === 0) {
        select.append(new Option('暂无美化方案', '', true, true));
        select.prop('disabled', true);
        editor.val('').prop('disabled', true);

        managerHtml.find(
            '#bm_duplicate, #bm_rename, #bm_delete, #bm_export, #bm_apply, #bm_save',
        ).prop('disabled', true);

        return;
    }

    for (const item of settings.presets) {
        select.append(
            new Option(
                item.name,
                item.id,
                item.id === settings.selectedPresetId,
                item.id === settings.selectedPresetId,
            ),
        );
    }

    select.prop('disabled', false);
    editor
        .val(preset?.css ?? '')
        .prop('disabled', false);

    managerHtml.find(
        '#bm_duplicate, #bm_rename, #bm_delete, #bm_export, #bm_apply, #bm_save',
    ).prop('disabled', false);

    managerHtml.find('#bm_save_state')
        .text('已保存')
        .removeClass('bm-unsaved');
}

/**
 * 验证导入的 JSON。
 */
function normalizeImportedPreset(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('JSON 顶层必须是对象。');
    }

    if (typeof data.css !== 'string') {
        throw new Error('缺少有效的 css 字段。');
    }

    return {
        id: uuidv4(),
        name: String(data.name || '导入的美化方案').trim()
            || '导入的美化方案',
        css: data.css,
    };
}

/**
 * 打开美化管理器。
 */
async function openBeautifyManager() {
    const managerHtml = createManagerHtml();
    let inputSaveTimer = null;

    managerHtml.find('#bm_enabled').on('change', function () {
        const settings = getSettings();
        settings.enabled = Boolean($(this).prop('checked'));

        saveSettings();
        applySelectedPreset();

        toastr.info(
            settings.enabled
                ? '美化管理器已启用。'
                : '美化管理器已关闭。',
        );
    });

    managerHtml.find('#bm_live_preview').on('change', function () {
        const settings = getSettings();
        settings.livePreview = Boolean($(this).prop('checked'));
        saveSettings();

        if (settings.livePreview) {
            const preset = getSelectedPreset();

            if (preset) {
                getRuntimeStyleElement().textContent = String(
                    managerHtml.find('#bm_css_editor').val() ?? '',
                );
            }
        } else {
            applySelectedPreset();
        }
    });

    managerHtml.find('#bm_preset_select').on('change', function () {
        const settings = getSettings();

        settings.selectedPresetId = String($(this).val() ?? '');
        saveSettings();

        refreshManagerUi(managerHtml);
        applySelectedPreset();
    });

    managerHtml.find('#bm_css_editor').on('input', function () {
        const settings = getSettings();

        managerHtml.find('#bm_save_state')
            .text('未保存')
            .addClass('bm-unsaved');

        if (settings.enabled && settings.livePreview) {
            getRuntimeStyleElement().textContent = String(
                $(this).val() ?? '',
            );
        }

        clearTimeout(inputSaveTimer);

        // 自动保存，避免用户直接关闭弹窗导致丢失。
        inputSaveTimer = setTimeout(() => {
            saveEditorToCurrentPreset(managerHtml, false);
        }, 1000);
    });

    managerHtml.find('#bm_save').on('click', function () {
        clearTimeout(inputSaveTimer);
        saveEditorToCurrentPreset(managerHtml, true);
    });

    managerHtml.find('#bm_apply').on('click', function () {
        const settings = getSettings();
        const preset = getSelectedPreset();

        if (!preset) {
            return;
        }

        const css = String(
            managerHtml.find('#bm_css_editor').val() ?? '',
        );

        if (settings.enabled) {
            getRuntimeStyleElement().textContent = css;
            toastr.success('当前 CSS 已应用。');
        } else {
            toastr.warning('美化管理器当前处于关闭状态。');
        }
    });

    managerHtml.find('#bm_new').on('click', async function () {
        const name = await askForName('请输入新美化方案名称：');

        if (!name) {
            return;
        }

        const settings = getSettings();
        const preset = {
            id: uuidv4(),
            name,
            css: `/* ${name} */\n`,
        };

        settings.presets.push(preset);
        settings.selectedPresetId = preset.id;

        saveSettings();
        refreshManagerUi(managerHtml);
        applySelectedPreset();

        toastr.success(`已创建美化方案“${name}”。`);
    });

    managerHtml.find('#bm_duplicate').on('click', async function () {
        const source = getSelectedPreset();

        if (!source) {
            return;
        }

        const name = await askForName(
            '请输入复制后的美化方案名称：',
            `${source.name} - 副本`,
        );

        if (!name) {
            return;
        }

        const settings = getSettings();
        const copy = {
            id: uuidv4(),
            name,
            css: String(
                managerHtml.find('#bm_css_editor').val() ?? source.css,
            ),
        };

        settings.presets.push(copy);
        settings.selectedPresetId = copy.id;

        saveSettings();
        refreshManagerUi(managerHtml);
        applySelectedPreset();

        toastr.success(`已复制为“${name}”。`);
    });

    managerHtml.find('#bm_rename').on('click', async function () {
        const preset = getSelectedPreset();

        if (!preset) {
            return;
        }

        const name = await askForName(
            '请输入新的美化方案名称：',
            preset.name,
        );

        if (!name) {
            return;
        }

        preset.name = name;

        saveSettings();
        refreshManagerUi(managerHtml);

        toastr.success('美化方案已重命名。');
    });

    managerHtml.find('#bm_delete').on('click', async function () {
        const settings = getSettings();
        const preset = getSelectedPreset();

        if (!preset) {
            return;
        }

        const confirmed = await callGenericPopup(
            `确定删除美化方案“${escapeHtml(preset.name)}”吗？`,
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

        const index = settings.presets.findIndex(
            item => item.id === preset.id,
        );

        if (index !== -1) {
            settings.presets.splice(index, 1);
        }

        settings.selectedPresetId =
            settings.presets[Math.max(0, index - 1)]?.id ??
            settings.presets[0]?.id ??
            '';

        saveSettings();
        refreshManagerUi(managerHtml);
        applySelectedPreset();

        toastr.success('美化方案已删除。');
    });

    managerHtml.find('#bm_import').on('click', function () {
        managerHtml.find('#bm_import_file').trigger('click');
    });

    managerHtml.find('#bm_import_file').on('change', async function () {
        const input = this instanceof HTMLInputElement ? this : null;
        const file = input?.files?.[0];

        if (!file) {
            return;
        }

        try {
            const text = await getFileText(file);
            const data = JSON.parse(text);
            const importedPreset = normalizeImportedPreset(data);
            const settings = getSettings();

            settings.presets.push(importedPreset);
            settings.selectedPresetId = importedPreset.id;

            saveSettings();
            refreshManagerUi(managerHtml);
            applySelectedPreset();

            toastr.success(
                `已导入美化方案“${importedPreset.name}”。`,
            );
        } catch (error) {
            console.error('[Beautify Manager] Import failed:', error);
            toastr.error(
                `导入失败：${error?.message || '不是有效的美化方案文件'}`,
            );
        } finally {
            if (input) {
                input.value = '';
            }
        }
    });

    managerHtml.find('#bm_export').on('click', function () {
        const preset = getSelectedPreset();

        if (!preset) {
            return;
        }

        // 导出前使用编辑器里的最新内容。
        const exportedPreset = {
            format: 'sillytavern-beautify-preset',
            version: 1,
            name: preset.name,
            css: String(
                managerHtml.find('#bm_css_editor').val() ?? preset.css,
            ),
        };

        const safeName = preset.name
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .trim() || 'beautify-preset';

        download(
            JSON.stringify(exportedPreset, null, 4),
            `${safeName}.json`,
            'application/json',
        );
    });

    await callGenericPopup(
        managerHtml,
        POPUP_TYPE.TEXT,
        '',
        {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );

    clearTimeout(inputSaveTimer);

    // 用户关闭窗口时再保存一次。
    const currentPreset = getSelectedPreset();

    if (currentPreset && managerHtml.find('#bm_css_editor').length) {
        currentPreset.css = String(
            managerHtml.find('#bm_css_editor').val() ?? '',
        );

        saveSettings();
        applySelectedPreset();
    }
}

/**
 * 创建统一入口按钮。
 */
function createEntryButton(id, compact = false) {
    const button = document.createElement('div');

    button.id = id;
    button.className = compact
        ? 'menu_button menu_button_icon bm-entry-button bm-entry-button-compact'
        : 'menu_button menu_button_icon bm-entry-button';

    button.title = '打开美化管理器';
    button.innerHTML = `
        <i class="fa-solid fa-palette"></i>
        <span>美化管理器</span>
    `;

    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openBeautifyManager();
    });

    return button;
}

/**
 * 注入到“用户设置 → UI Theme”的指定位置下面。
 */
function injectIntoUiThemeSettings() {
    if (document.getElementById(UI_ENTRY_ID)) {
        return true;
    }

    const anchor = document.querySelector(UI_THEME_ANCHOR_SELECTOR);

    if (!anchor) {
        return false;
    }

    const wrapper = document.createElement('div');
    wrapper.id = UI_ENTRY_ID;
    wrapper.className = 'bm-settings-entry-row';

    const button = createEntryButton(
        `${UI_ENTRY_ID}_button`,
        false,
    );

    wrapper.appendChild(button);

    // “下面”即插到该 flex-container 后方。
    anchor.insertAdjacentElement('afterend', wrapper);

    return true;
}

/**
 * 注入扩展菜单。
 *
 * #extensionsMenuButton 通常只是打开菜单的触发器，
 * 真正的菜单容器一般是 #extensionsMenu。
 *
 * 所以优先把入口添加到 #extensionsMenu 中。
 * 如果当前版本没有 #extensionsMenu，则退化为放到
 * #extensionsMenuButton 后面，而不是破坏其内部点击结构。
 */
function injectIntoExtensionsMenu() {
    if (document.getElementById(EXTENSIONS_ENTRY_ID)) {
        return true;
    }

    const extensionsMenu = document.querySelector('#extensionsMenu');

    if (extensionsMenu) {
        const entry = document.createElement('div');

        entry.id = EXTENSIONS_ENTRY_ID;
        entry.className =
            'list-group-item interactable bm-extensions-menu-entry';

        entry.innerHTML = `
            <i class="fa-solid fa-palette fa-fw"></i>
            <span>美化管理器</span>
        `;

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            // 如果扩展菜单本身支持隐藏，则点击后关闭。
            if (extensionsMenu instanceof HTMLElement) {
                extensionsMenu.style.display = 'none';
            }

            openBeautifyManager();
        });

        extensionsMenu.appendChild(entry);
        return true;
    }

    const extensionsMenuButton =
        document.querySelector('#extensionsMenuButton');

    if (!extensionsMenuButton) {
        return false;
    }

    /*
     * 某些版本中只存在 #extensionsMenuButton。
     * 不建议把完整按钮直接塞进触发器内部，否则会发生嵌套点击。
     * 这里将入口插入到触发器后方。
     */
    const fallbackEntry = createEntryButton(
        EXTENSIONS_ENTRY_ID,
        true,
    );

    fallbackEntry.classList.add('bm-extension-menu-fallback');
    extensionsMenuButton.insertAdjacentElement(
        'afterend',
        fallbackEntry,
    );

    return true;
}

/**
 * 执行全部入口注入。
 */
function injectAllEntries() {
    injectIntoUiThemeSettings();
    injectIntoExtensionsMenu();
}

/**
 * 观察动态 DOM。
 *
 * 用户设置抽屉和扩展菜单有可能在扩展初始化之后才创建，
 * 所以不能只执行一次 querySelector。
 */
function startInjectionObserver() {
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

/**
 * 初始化扩展。
 */
function init() {
    getSettings();
    applySelectedPreset();
    startInjectionObserver();

    console.log('[Beautify Manager] Extension initialized.');
}

jQuery(() => {
    init();
});

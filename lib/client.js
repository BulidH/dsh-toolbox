/**
 * 工具箱 · 客户端半区
 *
 * 两部分组成：
 *   1. 左栏入口。官方侧边栏没有给第三方插件预留导航座位
 *      （sidebar.workspaces / sidebar.settings 都是单占位且已被占用），
 *      因此注册到公开的 sidebar.footer.action list 座位保证生命周期，
 *      再把按钮 Portal 到「工作区」列表上方 —— 与 MCP 连接器同一套做法，
 *      这样入口稳定出现在左栏导航区，而不是底部设置旁边。
 *   2. 面板。注册到 shell.overlay（框架级浮层，官方推荐的独立页面座位），
 *      内部用 Tab 切换，每个 Tab 内嵌一个 iframe 指向用户配置的地址。
 *
 * 只依赖稳定的 data-slot / data-* 锚点，不依赖构建生成的 CSS 类名。
 *
 * @module dsh-toolbox/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')

    // primitives 只是为了让按钮外观与 DSH 一致；拿不到时回落到原生 button，
    // 不能因为一个可选依赖让整个工具箱打不开。
    let PrimitivesButton
    try {
      PrimitivesButton = require('@deepseek-ai/dsh-client-ui-primitives').Button
    } catch (error) {
      PrimitivesButton = undefined
    }

    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    /** 左栏入口的挂载点属性；与 MCP 连接器的锚点区分开。 */
    const MOUNT_ATTR = 'data-dsh-toolbox-mount'
    const MOUNT_SELECTOR = `[${MOUNT_ATTR}="true"]`
    /** 工作区列表：入口要插在它上方。 */
    const WORKSPACES_SELECTOR = '[data-slot="sidebar.workspaces"]'
    /** MCP 连接器的挂载点：工具箱排在它后面，形成「MCP 连接器 → 工具箱」的顺序。 */
    const MCP_MOUNT_SELECTOR = '[data-mcp-connector-top-mount="true"]'

    const CONFIG_ENDPOINT = '/toolbox/config'
    const PROBE_ENDPOINT = '/toolbox/probe'

    /** 宿主不可达时的兜底 Tab，保证面板至少能用。 */
    const FALLBACK_TABS = [
      {
        id: 'workbuddy2api',
        label: 'WorkBuddy2API',
        icon: '🐱',
        url: 'http://127.0.0.1:7863/panel/#overview',
        enabled: true
      }
    ]

    const STYLE_ID = 'dsh-toolbox-styles'

    const css = `
[data-slot="sidebar.footer.action"] {
  display: flex !important;
  flex-direction: column;
  min-width: 0;
  width: 100%;
}

.dshToolboxMount {
  flex: none;
  min-width: 0;
  width: 100%;
}

.dshToolboxEntry {
  box-sizing: border-box;
  width: 100%;
  padding-right: var(--dsh-sidebar-inline-padding, 12px);
}

.dshToolboxEntry[data-wide="false"] {
  width: 36px;
  padding-right: 0;
}

.dshToolboxLauncher {
  flex: none;
  box-sizing: border-box;
  width: 100%;
  height: 42px;
  margin: 0 0 8px;
  padding: 0 10px 0 8px;
  justify-content: flex-start;
  overflow: hidden;
  border-radius: 12px;
  white-space: nowrap;
  font: inherit;
  font-size: 14px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshToolboxLauncher:hover,
.dshToolboxLauncher:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}

.dshToolboxLauncher[data-wide="false"] {
  width: 36px;
  height: 36px;
  margin: 0 0 8px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
}

.dshToolboxEntry[data-wide="false"] .dshToolboxLauncher {
  margin: 0 0 8px;
}

/* ---- 面板 ---- */
.dshToolboxBackdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
}

.dshToolboxPanel {
  display: flex;
  flex-direction: column;
  width: min(1280px, 94vw);
  height: min(880px, 90vh);
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, 0.28));
  font-family: var(--dsw-font-family, inherit);
}

.dshToolboxHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 10px 0 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dshToolboxTitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  margin-right: 4px;
}

.dshToolboxTabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.dshToolboxTabs::-webkit-scrollbar { display: none; }

.dshToolboxTab {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  border-radius: 10px 10px 0 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
}

.dshToolboxTab:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.dshToolboxTab[data-active="true"] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary, currentColor);
  font-weight: 600;
}

.dshToolboxTabStatus {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
  flex: none;
}

.dshToolboxTabStatus[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dshToolboxTabStatus[data-state="down"] { background: var(--dsw-alias-state-error-primary, #dc2626); }

.dshToolboxHeaderActions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding-bottom: 6px;
}

.dshToolboxIconButton {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.dshToolboxIconButton:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.dshToolboxBody {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

.dshToolboxFrame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}

.dshToolboxNotice {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.dshToolboxNotice code {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--dsw-alias-markdown-inline-code, rgba(127, 127, 127, 0.14));
  user-select: text;
}

.dshToolboxButton {
  padding: 7px 14px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-tool-bar-fill, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dshToolboxButton:hover { background: var(--dsw-alias-interactive-bg-hover); }

.dshToolboxButton[data-variant="primary"] {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  border-color: transparent;
}

.dshToolboxButton[data-variant="danger"] {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  border-color: transparent;
  background: transparent;
}

.dshToolboxButton:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- 设置视图 ---- */
.dshToolboxSettings {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 18px 20px 28px;
}

.dshToolboxSettingsHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.dshToolboxSettingsTitle { font-size: 15px; font-weight: 600; }

.dshToolboxHint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.7;
  margin-bottom: 16px;
}

.dshToolboxRow {
  display: grid;
  grid-template-columns: 56px 1fr 2fr auto;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dshToolboxField {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}

.dshToolboxField:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, currentColor);
}

.dshToolboxRowActions {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.dshToolboxSettingsFoot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}

.dshToolboxStatus {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshToolboxStatus[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dshToolboxStatus[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #16a34a); }

.dshToolboxEmpty {
  padding: 32px 0;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
}
`

    function installStyles() {
      if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = STYLE_ID
      style.textContent = css
      document.head.append(style)
      return () => {
        style.remove()
      }
    }

    /**
     * 极简快照 store。入口按钮和面板是两个独立的 slot entry，需要共享
     * 「面板是否打开」这一个状态，所以放在 factory 作用域里由两者共同引用。
     */
    function createToolboxStore() {
      let state = {
        open: false,
        view: 'tabs',
        tabs: [],
        activeId: undefined,
        status: {},
        visited: {},
        loading: true,
        error: undefined
      }
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-toolbox] listener failed:', error)
            }
          }
        }
      }
    }

    function useToolbox(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }

    /** 与宿主交换配置。失败时抛出，由调用方决定回落到什么。 */
    async function requestConfig(options) {
      const response = await fetch(CONFIG_ENDPOINT, {
        method: options?.method ?? 'GET',
        headers: options?.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body)
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    async function probeUrl(url) {
      const response = await fetch(`${PROBE_ENDPOINT}?url=${encodeURIComponent(url)}`)
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) return { ok: false, reason: payload?.error ?? `HTTP ${response.status}` }
      return payload.result
    }

    function enabledTabs(tabs) {
      return tabs.filter(tab => tab.enabled !== false)
    }

    /** 统一的按钮：优先用 DSH primitives，拿不到就退回原生 button。 */
    function ActionButton(props) {
      const { variant, className, children, ...rest } = props
      if (PrimitivesButton !== undefined && variant !== undefined) {
        return h(PrimitivesButton, { variant: variant === 'primary' ? 'primary' : 'ghost', className, ...rest }, children)
      }
      return h('button', { type: 'button', className, 'data-variant': variant, ...rest }, children)
    }

    /**
     * 左栏入口。官方 footer list 座位负责生命周期，实际按钮 Portal 到
     * 工作区列表上方；MutationObserver 在侧边栏重渲染后自愈。
     */
    function ToolboxEntry(props) {
      const { wide, store, actions } = props
      const state = useToolbox(store)
      const [mount, setMount] = useState(null)

      useEffect(() => {
        let disposed = false
        const owned = new Set()
        const sync = () => {
          if (disposed) return
          const next = ensureEntryMount()
          if (next !== null) owned.add(next)
          setMount(current => (current === next ? current : next))
        }
        sync()
        let observer = null
        if (typeof window.MutationObserver === 'function' && document.body !== null) {
          observer = new window.MutationObserver(sync)
          observer.observe(document.body, { childList: true, subtree: true })
        }
        return () => {
          disposed = true
          observer?.disconnect()
          for (const node of owned) node.remove()
        }
      }, [])

      const launcher = h(
        ActionButton,
        {
          variant: 'ghost',
          className: 'dshToolboxLauncher',
          'data-wide': wide,
          'aria-label': '工具箱',
          'aria-haspopup': 'dialog',
          'aria-expanded': state.open,
          onClick: () => {
            try {
              actions.open()
            } catch (error) {
              console.error('[dsh-toolbox] open failed:', error)
            }
          }
        },
        h('span', { 'aria-hidden': 'true' }, '🧰'),
        wide ? h('span', null, '工具箱') : null
      )

      if (mount === null || typeof createPortal !== 'function') return launcher
      return createPortal(h('div', { className: 'dshToolboxEntry', 'data-wide': wide }, launcher), mount)
    }

    /**
     * 把入口挂到工作区列表上方、MCP 连接器之后。
     * @returns 挂载容器；锚点尚未渲染时返回 null，交给 observer 重试。
     */
    function ensureEntryMount() {
      const workspaceSlot = document.querySelector(WORKSPACES_SELECTOR)
      const parent = workspaceSlot?.parentElement
      if (workspaceSlot === null || workspaceSlot === undefined || parent === null || parent === undefined) return null

      let mount = parent.querySelector(MOUNT_SELECTOR)
      if (mount === null) {
        mount = document.createElement('div')
        mount.setAttribute(MOUNT_ATTR, 'true')
        mount.className = 'dshToolboxMount'
      }

      // 排在 MCP 连接器入口之后；它不在时退回到工作区列表之前。
      const mcpMount = parent.querySelector(MCP_MOUNT_SELECTOR)
      const anchor = mcpMount !== null && mcpMount.parentElement === parent ? mcpMount.nextSibling : workspaceSlot
      if (mount.parentElement !== parent || mount.nextSibling !== anchor) {
        parent.insertBefore(mount, anchor)
      }
      return mount
    }

    /** 面板本体：Tab 栏 + 内容区，内容区是各工具的 iframe。 */
    function ToolboxPanel(props) {
      const { store, actions } = props
      const state = useToolbox(store)
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(undefined)

      // 首次打开时载入配置，并探测各 Tab 的连通性。
      useEffect(() => {
        if (!state.open || state.tabs.length > 0 || state.error !== undefined) return
        let cancelled = false
        void (async () => {
          let tabs = FALLBACK_TABS
          let error
          try {
            const payload = await requestConfig()
            if (Array.isArray(payload.config?.tabs) && payload.config.tabs.length > 0) tabs = payload.config.tabs
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
          }
          if (cancelled) return
          store.update({ tabs, activeId: enabledTabs(tabs)[0]?.id, loading: false, error })
          void refreshStatus(tabs)
        })()
        return () => {
          cancelled = true
        }
      }, [state.open, state.tabs.length, state.error])

      const refreshStatus = useCallback(async (tabs) => {
        const results = await Promise.all(
          enabledTabs(tabs).map(async (tab) => {
            try {
              const result = await probeUrl(tab.url)
              return [tab.id, result?.ok === true ? { state: 'ok' } : { state: 'down', reason: result?.reason ?? '不可达' }]
            } catch (error) {
              return [tab.id, { state: 'down', reason: error instanceof Error ? error.message : String(error) }]
            }
          })
        )
        store.update(current => ({ status: { ...current.status, ...Object.fromEntries(results) } }))
      }, [store])

      // ESC 关闭面板。
      useEffect(() => {
        if (!state.open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') actions.close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [state.open, actions])

      if (!state.open) return null

      const tabs = enabledTabs(state.tabs)
      const active = tabs.find(tab => tab.id === state.activeId) ?? tabs[0]

      const selectTab = (id) => {
        store.update(current => ({ activeId: id, visited: { ...current.visited, [id]: true } }))
      }

      const openSettings = () => {
        setDraft(state.tabs.map(tab => ({ ...tab })))
        setMessage(undefined)
        store.update({ view: 'settings' })
      }

      const save = async () => {
        setSaving(true)
        setMessage(undefined)
        try {
          const payload = await requestConfig({ method: 'PUT', body: { tabs: draft } })
          const saved = payload.config.tabs
          store.update(current => ({
            tabs: saved,
            activeId: saved.some(tab => tab.id === current.activeId) ? current.activeId : enabledTabs(saved)[0]?.id,
            view: 'tabs'
          }))
          setMessage(undefined)
          void refreshStatus(saved)
        } catch (error) {
          setMessage({ tone: 'error', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setSaving(false)
        }
      }

      const header = h(
        'div',
        { className: 'dshToolboxHeader' },
        h('span', { className: 'dshToolboxTitle' }, '工具箱'),
        h(
          'div',
          { className: 'dshToolboxTabs', role: 'tablist' },
          state.view === 'settings'
            ? h('span', { className: 'dshToolboxTitle' }, '设置')
            : tabs.map(tab =>
                h(
                  'button',
                  {
                    key: tab.id,
                    type: 'button',
                    role: 'tab',
                    className: 'dshToolboxTab',
                    'data-active': tab.id === active?.id,
                    'aria-selected': tab.id === active?.id,
                    onClick: () => selectTab(tab.id)
                  },
                  h('span', {
                    className: 'dshToolboxTabStatus',
                    'data-state': state.status[tab.id]?.state ?? 'unknown'
                  }),
                  h('span', null, `${tab.icon ?? ''}${tab.icon ? ' ' : ''}${tab.label}`)
                )
              )
        ),
        h(
          'div',
          { className: 'dshToolboxHeaderActions' },
          state.view === 'settings'
            ? h(
                'button',
                { type: 'button', className: 'dshToolboxIconButton', title: '返回', onClick: () => store.update({ view: 'tabs' }) },
                '←'
              )
            : h(
                'button',
                { type: 'button', className: 'dshToolboxIconButton', title: '设置', onClick: openSettings },
                '⚙'
              ),
          h(
            'button',
            { type: 'button', className: 'dshToolboxIconButton', title: '关闭', onClick: () => actions.close() },
            '✕'
          )
        )
      )

      return h(
        'div',
        {
          className: 'dshToolboxBackdrop',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '工具箱',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) actions.close()
          }
        },
        h(
          'div',
          { className: 'dshToolboxPanel' },
          header,
          h('div', { className: 'dshToolboxBody' }, state.view === 'settings' ? renderSettings() : renderFrames())
        )
      )

      /** 所有访问过的 Tab 都保留 iframe，切换时只改可见性，避免重复加载。 */
      function renderFrames() {
        if (state.loading) return h('div', { className: 'dshToolboxNotice' }, '正在读取工具箱配置…')
        if (tabs.length === 0) {
          return h(
            'div',
            { className: 'dshToolboxNotice' },
            h('div', null, '工具箱还是空的。'),
            h('button', { type: 'button', className: 'dshToolboxButton', 'data-variant': 'primary', onClick: openSettings }, '添加工具')
          )
        }
        const activeId = active?.id
        return h(
          React.Fragment,
          null,
          tabs.map(tab => {
            if (state.visited[tab.id] !== true && tab.id !== activeId) return null
            const status = state.status[tab.id]
            const down = status?.state === 'down'
            return h(
              'div',
              {
                key: tab.id,
                style: { position: 'absolute', inset: 0, display: tab.id === activeId ? 'block' : 'none' }
              },
              down
                ? h(
                    'div',
                    { className: 'dshToolboxNotice' },
                    h('div', null, `${tab.label} 当前不可达。`),
                    h('div', null, status.reason ?? ''),
                    h('div', null, h('code', null, tab.url)),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshToolboxButton',
                          'data-variant': 'primary',
                          onClick: () => {
                            store.update(current => ({ status: { ...current.status, [tab.id]: { state: 'ok' } } }))
                          }
                        },
                        '仍然尝试打开'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshToolboxButton',
                          onClick: () => void refreshStatus(state.tabs)
                        },
                        '重新检测'
                      )
                    )
                  )
                : h('iframe', {
                    className: 'dshToolboxFrame',
                    src: tab.url,
                    title: tab.label,
                    referrerPolicy: 'no-referrer',
                    allow: 'clipboard-read; clipboard-write',
                    onLoad: () => {
                      store.update(current =>
                        current.status[tab.id]?.state === 'ok'
                          ? current
                          : { status: { ...current.status, [tab.id]: { state: 'ok' } } }
                      )
                    }
                  })
            )
          })
        )
      }

      function renderSettings() {
        const rows = draft ?? []
        const update = (index, patch) => {
          setDraft(current => (current ?? []).map((tab, i) => (i === index ? { ...tab, ...patch } : tab)))
        }
        return h(
          'div',
          { className: 'dshToolboxSettings' },
          h(
            'div',
            { className: 'dshToolboxSettingsHead' },
            h('span', { className: 'dshToolboxSettingsTitle' }, '工具箱里的工具'),
            h('span', { className: 'dshToolboxStatus' }, '配置保存在 $DSH_HOME/toolbox/config.json')
          ),
          h(
            'div',
            { className: 'dshToolboxHint' },
            '每个工具是一个内嵌页面。填本机地址（如 ',
            h('code', null, 'http://127.0.0.1:7863/panel/'),
            '）即可。目标服务需要允许被嵌入 —— 若它返回 X-Frame-Options 或 CSP frame-ancestors，页面会显示为空白。'
          ),
          rows.length === 0
            ? h('div', { className: 'dshToolboxEmpty' }, '还没有配置任何工具。')
            : rows.map((tab, index) =>
                h(
                  'div',
                  { className: 'dshToolboxRow', key: `${tab.id}-${index}` },
                  h('input', {
                    className: 'dshToolboxField',
                    value: tab.icon ?? '',
                    placeholder: '图标',
                    'aria-label': '图标',
                    onChange: (event) => update(index, { icon: event.target.value })
                  }),
                  h('input', {
                    className: 'dshToolboxField',
                    value: tab.label ?? '',
                    placeholder: '名称',
                    'aria-label': '名称',
                    onChange: (event) => update(index, { label: event.target.value })
                  }),
                  h('input', {
                    className: 'dshToolboxField',
                    value: tab.url ?? '',
                    placeholder: 'http://127.0.0.1:8080/',
                    'aria-label': '地址',
                    spellCheck: false,
                    onChange: (event) => update(index, { url: event.target.value })
                  }),
                  h(
                    'div',
                    { className: 'dshToolboxRowActions' },
                    h(
                      'label',
                      { className: 'dshToolboxStatus', style: { display: 'flex', alignItems: 'center', gap: 4 } },
                      h('input', {
                        type: 'checkbox',
                        checked: tab.enabled !== false,
                        onChange: (event) => update(index, { enabled: event.target.checked })
                      }),
                      '启用'
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshToolboxButton',
                        'data-variant': 'danger',
                        onClick: () => setDraft(current => (current ?? []).filter((_, i) => i !== index))
                      },
                      '删除'
                    )
                  )
                )
              ),
          h(
            'div',
            { className: 'dshToolboxSettingsFoot' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshToolboxButton',
                onClick: () =>
                  setDraft(current => [
                    ...(current ?? []),
                    { id: `tool-${Date.now().toString(36)}`, label: '新工具', icon: '🔧', url: '', enabled: true }
                  ])
              },
              '添加工具'
            ),
            h(
              'button',
              { type: 'button', className: 'dshToolboxButton', 'data-variant': 'primary', disabled: saving, onClick: () => void save() },
              saving ? '保存中…' : '保存'
            ),
            message !== undefined ? h('span', { className: 'dshToolboxStatus', 'data-tone': message.tone }, message.text) : null
          )
        )
      }
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        const store = createToolboxStore()
        const actions = {
          open: () => store.update({ open: true, view: 'tabs' }),
          close: () => store.update({ open: false, view: 'tabs' })
        }
        ctx.effect(() => installStyles(), 'dsh-toolbox: styles')

        // 面板：框架级浮层，官方推荐的独立页面座位。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-toolbox', order: 150 }, (props) =>
            h(ToolboxPanel, { ...props, store, actions })
          )
        )

        // 左栏入口：公开 list 座位托管生命周期，组件内部 Portal 到工作区上方。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-toolbox', order: 10, label: () => '工具箱' },
            (props) => h(ToolboxEntry, { ...props, store, actions })
          )
        )
      } catch (error) {
        // 客户端 apply 抛错会让整个 web shell 启动失败，外部插件不能把界面带崩。
        console.error('[dsh-toolbox] apply failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

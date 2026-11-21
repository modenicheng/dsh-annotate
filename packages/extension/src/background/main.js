/**
 * Background entry point: event wiring, boot, and the keepalive.
 *
 * Loaded last by manifest.json (and by `sw.js` for Chromium). Event listeners
 * are registered synchronously at the top level because Firefox starts the
 * event page in order to dispatch them, and Chromium starts the service worker
 * for the same reason; anything after an `await` would miss the very event that
 * woke it.
 *
 * The heartbeat differs by engine and is decided in one place below: Gecko
 * accepts sub-minute alarm periods and wakes an event page with them, Chromium
 * clamps alarms to 30 s and kills an idle service worker after ~30 s, so there
 * the alarm cannot be the keepalive.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-marker: core.js must load before main.js')
    return
  }

  /** Explicit command id from manifest.json; never `_execute_action`. */
  const COMMAND_ID = 'annotate-page'
  /**
   * `src/shared/platform.js`, loaded first when the manifest (or `sw.js`)
   * lists it. It is the only file allowed to know the engine.
   */
  const platform = globalThis.__DSH_PLATFORM__
  const IS_CHROMIUM = platform !== undefined && platform.isChromium === true
  /**
   * 20 seconds on Gecko, where the alarm is the keepalive and an event page
   * accepts a sub-minute period. On Chromium a period below 30 s is clamped,
   * so a plain minute is the floor that still means what it says; there the
   * alarm only reconnects and refreshes (see `keepalive`).
   */
  const ALARM_PERIOD_MINUTES = IS_CHROMIUM ? 1 : 20 / 60
  /**
   * Chromium's heartbeat: the host already answers `ping` with `pong`, and a
   * WebSocket plus traffic inside the worker's idle window is the sanctioned
   * way to keep it alive, so this reuses the frame that exists instead of
   * adding a protocol message.
   */
  const KEEPALIVE_INTERVAL_MS = 20_000
  /** Every third keepalive pass also refreshes the record snapshot. */
  const SNAPSHOT_REFRESH_EVERY = 3

  let bootPromise = null
  let keepaliveCount = 0

  /**
   * Register the async message handler through the platform shim. Below
   * Chromium 148 a listener that returns a promise has its channel closed and
   * the caller receives `undefined`, so the shim turns this one handler into
   * `sendResponse` + `return true` there and registers it unchanged on Gecko.
   * Without the shim (a manifest that does not list it) the raw form is still
   * correct on Gecko, so boot continues instead of failing.
   * @param {(message: any, sender: any) => Promise<any>} handler
   */
  function addMessageListener(handler) {
    if (platform !== undefined && typeof platform.onMessage === 'function') {
      platform.onMessage(handler)
      return
    }
    browser.runtime.onMessage.addListener(handler)
  }

  addMessageListener((message, sender) => ns.routing.handleMessage(message, sender))

  if (IS_CHROMIUM) startKeepaliveInterval()

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ns.ALARM_NAME) return
    void keepalive()
  })

  browser.commands.onCommand.addListener((command) => {
    if (command !== COMMAND_ID) return
    void runAnnotateCommand()
  })

  browser.runtime.onInstalled.addListener((details) => onInstalled(details))

  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm()
    void boot('startup')
  })

  browser.tabs.onRemoved.addListener((tabId) => {
    try {
      ns.routing.onTabRemoved(tabId)
    } catch (error) {
      ns.log.warn(`tab cleanup failed: ${ns.describeError(error)}`)
    }
  })

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    void onSettingsChanged(changes)
  })

  void boot('event-page-load')

  /**
   * Install and update handling. Returns its promise so a test (and a future
   * caller) can await the work; Firefox ignores the value.
   * @param {any} details
   */
  async function onInstalled(details) {
    try {
      await ensureAlarm()
      await adoptConnectionDefault(details)
      await boot('installed')
    } catch (error) {
      ns.log.warn(`install handling failed: ${ns.describeError(error)}`)
    }
  }

  /**
   * Give a fresh install automatic discovery, and an update nothing at all.
   *
   * `manual` is what every install before M4.5 did, and the absence of the key
   * is how that is represented; writing `auto` on an update would silently
   * ignore an address a user typed. Only `reason === 'install'` and only when
   * the key is truly absent, so a user who already chose never has it rewritten.
   * @param {any} details
   */
  async function adoptConnectionDefault(details) {
    if (details?.reason !== 'install') return
    try {
      const prefs = await ns.readPrefs()
      if (prefs.connection !== undefined) return
      await ns.writePrefs({ connection: 'auto' })
      ns.log.info('fresh install: automatic host discovery is on')
    } catch (error) {
      ns.log.warn(`could not store the discovery default: ${ns.describeError(error)}`)
    }
  }

  /** Create the keepalive alarm once; it survives event-page restarts. */
  async function ensureAlarm() {
    try {
      const existing = await browser.alarms.get(ns.ALARM_NAME)
      if (existing !== undefined && existing !== null) return
      browser.alarms.create(ns.ALARM_NAME, {
        delayInMinutes: ALARM_PERIOD_MINUTES,
        periodInMinutes: ALARM_PERIOD_MINUTES,
      })
      ns.log.info(`keepalive alarm set for every ${Math.round(ALARM_PERIOD_MINUTES * 60)} s`)
    } catch (error) {
      ns.log.warn(`could not schedule the keepalive alarm: ${ns.describeError(error)}`)
    }
  }

  /**
   * Bring the background to a working state: alarm, persisted queue, stable
   * client id, bridge address, and a socket attempt. Coalesced because the page
   * load, `onStartup`, and `onInstalled` can all fire for one wake-up.
   * @param {string} reason
   */
  function boot(reason) {
    if (bootPromise !== null) return bootPromise
    bootPromise = (async () => {
      try {
        await ensureAlarm()
        await ns.outbox.load()
        await ns.ensureClientId()
        await ns.readPrefs()
        ns.log.info(`background started (${reason}) with ${ns.outbox.summary().count} queued annotation(s)`)
        await ns.publishStatus('boot')
        await ns.net.connect({ reason })
      } catch (error) {
        ns.log.error(`background boot failed: ${ns.describeError(error)}`)
        ns.setNetState({ connection: 'error', lastError: `boot failed: ${ns.describeError(error)}` })
        await ns.publishStatus('boot-error')
      }
    })()
    return bootPromise
  }

  /**
   * Chromium's keepalive: one `ping` every 20 s while the socket is
   * authenticated. The host answers `pong`, so the worker sees traffic well
   * inside its 30 s idle window and the socket proves itself at the same time.
   * Started only on Chromium: a Gecko event page has no idle termination to
   * fight, and a second timer there would duplicate the alarm for nothing.
   */
  function startKeepaliveInterval() {
    setInterval(() => {
      if (!ns.net.isAuthed()) return
      ns.net.send({ t: 'ping' })
      void ns.outbox.flush({ reason: 'interval' })
    }, KEEPALIVE_INTERVAL_MS)
  }

  /**
   * One alarm pass. On Gecko this is the whole heartbeat, every 20 s: sending
   * `ping` proves the socket is alive (the host answers `pong`) and lets an
   * idle event page finish its work; a closed socket is reconnected here after
   * suspension.
   *
   * On Chromium the 20 s interval owns the heartbeat, so this pass only does
   * what a freshly woken service worker needs: reconnect when the socket is
   * down, and refresh the record snapshot every third pass. It must not send
   * the ping, or two timers would beat at different rates.
   */
  async function keepalive() {
    try {
      if (ns.net.isAuthed()) {
        if (!IS_CHROMIUM) {
          ns.net.send({ t: 'ping' })
          void ns.outbox.flush({ reason: 'alarm' })
        }
        keepaliveCount += 1
        if (keepaliveCount % SNAPSHOT_REFRESH_EVERY === 0) {
          void ns.routing.refreshRecords().catch((error) => {
            ns.log.debug(`periodic annotation refresh failed: ${ns.describeError(error)}`)
          })
        }
      } else {
        await ns.net.ensure()
      }
      await ns.publishStatus('alarm')
    } catch (error) {
      ns.log.warn(`keepalive failed: ${ns.describeError(error)}`)
    }
  }

  /**
   * Alt+Shift+A: ask the active page to enter annotation mode. A restricted
   * page (about:, addons.mozilla.org, a PDF viewer) gets a short badge instead
   * of a silent no-op.
   */
  async function runAnnotateCommand() {
    ns.log.info('command: annotate-page')
    try {
      const result = await ns.routing.activateCurrentPage('auto')
      ns.log.info(`command activate result: ${JSON.stringify(result)}`)
      if (result.ok === true) return
      ns.log.info(`annotate command: ${result.error}`)
      await flashBadge('!')
    } catch (error) {
      ns.log.warn(`annotate command failed: ${ns.describeError(error)}`)
      await flashBadge('!')
    }
  }

  /** @param {string} text */
  async function flashBadge(text) {
    try {
      await browser.action.setBadgeBackgroundColor({ color: '#b3261e' })
      await browser.action.setBadgeText({ text })
      setTimeout(() => {
        void browser.action.setBadgeText({ text: '' }).catch(() => {})
      }, 2_500)
    } catch (error) {
      ns.log.debug(`could not flash the toolbar badge: ${ns.describeError(error)}`)
    }
  }

  /**
   * The `anno.prefs` keys that decide where the socket connects. A popup write
   * that touches none of them — a shortcut, an exit gesture — must not drop a
   * working connection: the popup flips such switches in place and a needless
   * reconnect here is what makes the popup flicker.
   */
  const CONNECTION_PREF_KEYS = ['host', 'port', 'secure', 'connection', 'preferredInstanceId']

  /**
   * @param {any} [oldPrefs] the stored object before the write (`undefined`
   *   when the key did not exist, which means every connection key is new)
   * @param {any} [newPrefs]
   */
  function connectionPrefsChanged(oldPrefs, newPrefs) {
    const before = oldPrefs !== null && typeof oldPrefs === 'object' ? oldPrefs : {}
    const after = newPrefs !== null && typeof newPrefs === 'object' ? newPrefs : {}
    return CONNECTION_PREF_KEYS.some((key) => before[key] !== after[key])
  }

  /**
   * React to settings edited in the popup: a new token or address is only
   * meaningful after a fresh handshake, so reconnect immediately instead of
   * waiting for the backoff timer. A write that cannot change the connection
   * (annotation exits, the shortcut) changes nothing the socket reads, so it
   * only leaves a log line behind.
   * @param {Record<string, { oldValue?: any, newValue?: any }>} changes
   */
  async function onSettingsChanged(changes) {
    try {
      if (changes[ns.msg.STORAGE_KEYS.token] !== undefined) {
        ns.log.info('bridge token changed; reconnecting')
        await ns.net.reconnectNow('token-changed')
        return
      }
      const prefsChange = changes[ns.msg.STORAGE_KEYS.prefs]
      if (prefsChange !== undefined) {
        if (!connectionPrefsChanged(prefsChange.oldValue, prefsChange.newValue)) {
          ns.log.info('annotation settings changed; the connection stays up')
          return
        }
        await ns.readPrefs()
        ns.log.info(`bridge address changed; reconnecting to ${ns.netState.wsUrl}`)
        await ns.net.reconnectNow('address-changed')
      }
    } catch (error) {
      ns.log.warn(`could not apply the settings change: ${ns.describeError(error)}`)
    }
  }
})()

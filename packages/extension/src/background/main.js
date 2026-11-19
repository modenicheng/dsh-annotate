/**
 * Background entry point: event wiring, boot, and the keepalive alarm.
 *
 * Loaded last by manifest.json. Event listeners are registered synchronously at
 * the top level because Firefox starts the event page in order to dispatch
 * them; anything after an `await` would miss the very event that woke the page.
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
   * 20 seconds. Firefox accepts sub-minute alarm periods; if a build clamps it
   * to a minute, the event-page start and the socket's own retry still restore
   * the connection, only the idle wake-up gets slower.
   */
  const ALARM_PERIOD_MINUTES = 20 / 60
  /** How often the keepalive also refreshes the record snapshot (3 x 20 s). */
  const SNAPSHOT_REFRESH_EVERY = 3

  let bootPromise = null
  let keepaliveCount = 0

  browser.runtime.onMessage.addListener((message, sender) => ns.routing.handleMessage(message, sender))

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ns.ALARM_NAME) return
    void keepalive()
  })

  browser.commands.onCommand.addListener((command) => {
    if (command !== COMMAND_ID) return
    void runAnnotateCommand()
  })

  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarm()
    void boot('installed')
  })

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
   * Every 20 s: keep the socket honest. Sending `ping` both proves the socket
   * is alive (the host answers `pong`) and lets an idle event page finish its
   * work; a closed socket is reconnected here after suspension.
   */
  async function keepalive() {
    try {
      if (ns.net.isAuthed()) {
        ns.net.send({ t: 'ping' })
        void ns.outbox.flush({ reason: 'alarm' })
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
    try {
      const result = await ns.routing.activateCurrentPage('auto')
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
   * React to settings edited in the popup: a new token or address is only
   * meaningful after a fresh handshake, so reconnect immediately instead of
   * waiting for the backoff timer.
   * @param {Record<string, { oldValue?: any, newValue?: any }>} changes
   */
  async function onSettingsChanged(changes) {
    try {
      if (changes[ns.msg.STORAGE_KEYS.token] !== undefined) {
        ns.log.info('bridge token changed; reconnecting')
        await ns.net.reconnectNow('token-changed')
        return
      }
      if (changes[ns.msg.STORAGE_KEYS.prefs] !== undefined) {
        await ns.readPrefs()
        ns.log.info(`bridge address changed; reconnecting to ${ns.netState.wsUrl}`)
        await ns.net.reconnectNow('address-changed')
      }
    } catch (error) {
      ns.log.warn(`could not apply the settings change: ${ns.describeError(error)}`)
    }
  }
})()

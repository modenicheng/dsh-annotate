/**
 * Runtime-message contract between the three extension contexts.
 *
 * Firefox MV3 splits the extension into a background event page, content
 * scripts, and a popup; only the background owns the socket and storage. These
 * names are the contract the three contexts share, so a change here is a change
 * on all three sides.
 *
 * Envelope: `browser.runtime.sendMessage({ type: <one of the names below>, ...payload })`.
 * Handlers return plain values and never throw across the boundary.
 *
 * Payload keys are chosen so that no payload key shadows the envelope's `type`:
 * a forwarded host event therefore carries `{ type: 'anno.event', event:
 * 'created' | 'updated' | 'deleted', record }`, renaming the host frame's own
 * `type` field on the way through.
 */

/** content → background */
export const TO_BACKGROUND = {
  /** Ask for a screenshot crop and a host submission. */
  submit: 'anno.submit',
  /** Load annotations for a page (used by the hydrator). */
  query: 'anno.query',
  /** Read connection + queue state. */
  status: 'anno.status',
  /** Answer a pending pick. */
  pickResult: 'anno.pick.result',
  /** Page-side actions on a record. */
  mutate: 'anno.mutate',
  /** The content script finished booting on this tab. */
  ready: 'anno.content.ready',
  /** The Session catalog behind the composer's target picker. */
  sessions: 'anno.sessions',
  /** Create a Session on the host for the "new session" target. */
  createSession: 'anno.session.create',
}

/** background → content */
export const TO_CONTENT = {
  /** Annotations for this page, for re-anchoring. */
  records: 'anno.records',
  /** Connection or queue changed. */
  status: 'anno.status',
  /** The agent asked the user to point at something. */
  pickRequest: 'anno.pick.request',
  /** The agent's pick was withdrawn (timeout, abort, session end). */
  pickCancel: 'anno.pick.cancel',
  /** A record was created, updated, or deleted elsewhere. */
  event: 'anno.event',
  /** Ask the content script to enter annotation mode (toolbar/shortcut). */
  activate: 'anno.activate',
  /** Get the extension's own layer out of the frame before a screenshot. */
  captureHide: 'anno.capture.hide',
  /** Bring the layer back once the screenshot was taken. */
  captureRestore: 'anno.capture.restore',
}

/** popup → background */
export const TO_BACKGROUND_POPUP = {
  state: 'anno.popup.state',
  flush: 'anno.popup.flush',
  mutate: 'anno.popup.mutate',
  remove: 'anno.popup.remove',
  /** Run one discovery round now and report what answered. */
  scan: 'anno.popup.scan',
  /** Remember an explicitly chosen host (its `instanceId`) and reconnect. */
  chooseHost: 'anno.popup.choose',
  /** Seed the address from a picked endpoint record; never the token. */
  importRecord: 'anno.popup.import',
}

/**
 * Keys in `browser.storage.local`.
 * `outbox` is the offline queue; `token` is the bridge token copied from
 * `$DSH_HOME/ext-bridge-token`; `prefs` holds gesture and UI choices.
 */
export const STORAGE_KEYS = {
  token: 'anno.token',
  outbox: 'anno.outbox',
  prefs: 'anno.prefs',
  lastStatus: 'anno.status',
  /** Endpoint the host advertised last time, so a restart reconnects without a probe. */
  endpoint: 'anno.endpoint',
  /** The host that answered last (origin + instanceId), for the 12 h fast path. */
  address: 'anno.address',
}

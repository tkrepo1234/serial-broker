/**
 * Pure formatters for the view. They map what serial-broker reports onto what sap.m controls
 * expect, and nothing else - the texts themselves come from the resource bundle, through the
 * controller.
 *
 * A module with no dependencies: `sap.ui.define([], ...)` returns a plain object, which the
 * controller exposes as `.formatter` so the view can write `.formatter.statusState`.
 */

/**
 * What the controller exposes to the view. Declared globally because a `sap.ui.define` module is
 * a script rather than an ES module, so there is no export for another file to name.
 *
 * @typedef {object} SerialBrokerFormatter
 * @property {(status: string) => string} statusState
 * @property {(status: string) => string} statusIcon
 * @property {(retryable: boolean) => string} errorStripType
 * @property {(direction: string) => string} directionIcon
 * @property {(timestamp: number) => string} time
 */

sap.ui.define([], function () {
  'use strict';

  /**
   * The annotation is what checks the object below against the surface the view uses: a formatter
   * renamed here and not in the typedef fails `npm run typecheck`.
   *
   * @type {SerialBrokerFormatter}
   */
  const formatter = {
    /** The `sap.ui.core.ValueState` an `ObjectStatus` shows a status in. */
    statusState: function (status) {
      switch (status) {
        case 'open':
          return 'Success';
        case 'connecting':
        case 'reconnecting':
        case 'awaiting-permission':
        case 'queued':
          return 'Warning';
        case 'failed':
        case 'unsupported':
          return 'Error';
        default:
          // idle, released, and any status a later version of serial-broker adds.
          return 'None';
      }
    },

    /** The icon next to the status. */
    statusIcon: function (status) {
      switch (status) {
        case 'open':
          return 'sap-icon://connected';
        case 'connecting':
        case 'reconnecting':
          return 'sap-icon://synchronize';
        case 'awaiting-permission':
          return 'sap-icon://key';
        case 'failed':
        case 'unsupported':
          return 'sap-icon://disconnected';
        default:
          return 'sap-icon://circle-task-2';
      }
    },

    /**
     * How prominently an error is shown.
     *
     * A retryable error is one serial-broker is already recovering from - an unplugged device, for
     * instance. The status line says so; the message strip only informs.
     */
    errorStripType: function (retryable) {
      return retryable ? 'Information' : 'Error';
    },

    /** The icon of a line in the traffic list. */
    directionIcon: function (direction) {
      return direction === 'out' ? 'sap-icon://outbox' : 'sap-icon://inbox';
    },

    /** `14:03:21.481`, in the browser's time zone. */
    time: function (timestamp) {
      if (!timestamp) {
        return '';
      }
      const date = new Date(timestamp);
      /**
       * @param {number} value
       * @param {number} [length]
       * @returns {string}
       */
      const pad = (value, length = 2) => String(value).padStart(length, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
        date.getMilliseconds(),
        3,
      )}`;
    },
  };

  return formatter;
});

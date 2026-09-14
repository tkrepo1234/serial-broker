import CheckBox from 'sap/m/CheckBox';
import Input from 'sap/m/Input';
import MessageToast from 'sap/m/MessageToast';
import Event from 'sap/ui/base/Event';
import Control from 'sap/ui/core/Control';
import Controller from 'sap/ui/core/mvc/Controller';
import ResourceModel from 'sap/ui/model/resource/ResourceModel';
import type ResourceBundle from 'sap/base/i18n/ResourceBundle';

import type SerialBrokerModel from '../lib/serialbroker/SerialBrokerModel';
import type { SerialBrokerErrorEventParameters } from '../lib/serialbroker/SerialBrokerModel';
import * as formatter from '../model/formatter';

/**
 * The application's only screen.
 *
 * Everything the screen shows is bound to a {@link SerialBrokerModel} owned by the component; the
 * controller only turns user gestures into calls on those models and formats what they hold.
 *
 * @namespace serialbroker.openui5.controller
 */
export default class Main extends Controller {
  /** Exposed so the XML view can use it as `.formatter.statusState` and friends. */
  public readonly formatter = formatter;

  public override onInit(): void {
    // Errors are shown in the message strip by binding; a toast in addition makes sure one that
    // arrives while the user looks elsewhere is noticed at all.
    for (const name of ['reader', 'printer']) {
      this._model(name).attachSerialError(this.onSerialError, this);
    }
  }

  public override onExit(): void {
    for (const name of ['reader', 'printer']) {
      this._model(name).detachSerialError(this.onSerialError, this);
    }
  }

  /**
   * Shows the browser's port picker for the configuration the button carries.
   *
   * The call goes to the model **synchronously**: the browser shows a port picker only during
   * the transient activation of the click, and anything awaited first consumes it.
   */
  public onConnect(event: Event): void {
    const model = this._modelOf(event);
    void model.connect().then((granted) => {
      if (!granted) {
        MessageToast.show(this._text('connectDismissed'));
      }
    });
  }

  /** Releases the configuration in this tab. Other tabs keep the device. */
  public onRelease(event: Event): void {
    const model = this._modelOf(event);
    void model.release().then(() => {
      MessageToast.show(this._text('released', [model.getConfigurationName()]));
    });
  }

  /** Registers a released configuration again. */
  public onReconnect(event: Event): void {
    void this._modelOf(event).reconnect();
  }

  /** Sends what the user typed to the device, from whichever tab holds the port. */
  public onSend(): void {
    const input = this.byId('sendInput') as Input;
    const appendNewline = (this.byId('appendNewlineCheckBox') as CheckBox).getSelected();
    const command = input.getValue();
    if (command.length === 0) {
      return;
    }

    const model = this._model('reader');
    void model.send(appendNewline ? `${command}\r\n` : command).then((sent) => {
      if (sent) {
        input.setValue('');
      }
    });
  }

  /** Empties the traffic list. The device is not touched. */
  public onClearTraffic(): void {
    this._model('reader').clearLines();
  }

  /** Clears the error the user closed. */
  public onCloseError(): void {
    this._model('reader').clearError();
  }

  /** Opens this application a second time, which is where the sharing becomes visible. */
  public onOpenSecondTab(): void {
    window.open(window.location.href, '_blank', 'noopener');
  }

  /** Toasts an error as it happens; the message strip keeps the last one on screen. */
  public onSerialError(event: Event<SerialBrokerErrorEventParameters>): void {
    const error = event.getParameter('error');
    if (!error.retryable) {
      MessageToast.show(`${error.code}: ${error.message}`);
    }
  }

  /** The translated name of a status, with an honest fallback for one this app does not know. */
  public formatStatusText(status: string): string {
    const bundle = this._bundle();
    const key = `status.${status}`;
    // An unknown key answers with the key itself, which is how a status this application has no
    // text for is recognised - serial-broker may add one in a later version.
    const text = bundle.getText(key) ?? key;
    return text === key ? this._text('status.unknown', [status]) : text;
  }

  /** The error message strip: code, message and the remediation sentence, which is the useful part. */
  public formatErrorText(code: string, message: string, remediation: string): string {
    if (!code) {
      return '';
    }
    return this._text('errorText', [code, message, remediation]);
  }

  /** `0x1a86 / 0x7523, 19200 baud`, or the wording for a configuration that accepts any port. */
  public formatDevice(vendorId: string | null, productId: string | null, baudRate: number): string {
    if (!baudRate) {
      return this._text('deviceUnknown');
    }
    return vendorId && productId
      ? this._text('deviceUsb', [vendorId, productId, String(baudRate)])
      : this._text('deviceAny', [String(baudRate)]);
  }

  /** `12 received / 3 sent`. */
  public formatCounters(received: number, sent: number): string {
    return this._text('counters', [String(received), String(sent)]);
  }

  /** The model of the configuration a control carries as custom data. */
  private _modelOf(event: Event): SerialBrokerModel {
    const source = event.getSource() as Control;
    const name: unknown = source.data('config');
    return this._model(typeof name === 'string' ? name : 'reader');
  }

  /**
   * The component owns the models, so they are asked for there: a view has them only once they
   * have been propagated to it, which has not happened yet while `onInit` runs.
   */
  private _model(name: string): SerialBrokerModel {
    const owned = this.getOwnerComponent()?.getModel(name);
    return (owned ?? this.getView()?.getModel(name)) as SerialBrokerModel;
  }

  private _bundle(): ResourceBundle {
    const model = this.getOwnerComponent()?.getModel('i18n') as ResourceModel;
    return model.getResourceBundle() as ResourceBundle;
  }

  private _text(key: string, placeholders?: string[]): string {
    return this._bundle().getText(key, placeholders) ?? key;
  }
}

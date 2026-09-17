/**
 * Types shared by the application's modules. Classic UI5 modules have no `import`, so what one
 * returns is described here, globally, for `npm run typecheck`. Nothing in this file reaches the
 * browser.
 */

type SerialBrokerLibrary = typeof import('serial-broker');

/** The global the library's classic script build defines: the facade, with the other exports on it. */
type SerialBrokerGlobal = SerialBrokerLibrary['SerialBroker'] &
  Pick<SerialBrokerLibrary, 'isSerialBrokerError' | 'isSupported' | 'SerialBrokerStatus'>;

interface TerminalSerialSettings {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
}

interface TerminalPreferences {
  hex: boolean;
  ansi: boolean;
  timestamps: boolean;
  autoscroll: boolean;
  echo: boolean;
  theme: 'dark' | 'light';
  sendMode: string;
  sendEnding: string;
  serial: TerminalSerialSettings;
}

interface TerminalPreferencesModule {
  load(): TerminalPreferences;
  save(preferences: TerminalPreferences): void;
}

interface TerminalLogModule {
  readonly MAX_LINES: number;
  append(
    log: HTMLElement,
    text: string,
    kind: 'in' | 'out' | 'note',
    options: { timestamps: boolean; ansi: boolean; autoscroll: boolean },
  ): void;
  hexDump(bytes: Uint8Array): string;
  bytesToSend(input: string, mode: string, ending: string): Uint8Array<ArrayBuffer>;
}

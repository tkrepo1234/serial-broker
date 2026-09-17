/**
 * Finds a real serial device on Windows, the way Chromium identifies it.
 *
 * Chromium remembers a granted serial port on Windows by its **device instance ID** - the string
 * the Plug and Play manager gives the COM port's device node, such as
 * `USB\VID_2341&PID_0078&MI_01\7&1B7B3EF0&0&0001`. Neither the vendor and product IDs nor the
 * serial number are stored there; they are what other platforms use
 * (`chrome/browser/serial/serial_chooser_context.cc`, `PortInfoToValue`). Seeding a permission
 * therefore needs exactly that string, and Windows will hand it over:
 *
 * ```powershell
 * Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -like '*(COM*' }
 * ```
 *
 * See ADR-0021.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

/** One serial port, as Windows describes it. */
export interface WindowsSerialDevice {
  /** `COM3`, and so on. */
  readonly portName: string;
  /** The friendly name, which Chromium stores alongside the instance ID for display. */
  readonly name: string;
  /** The device instance ID of the COM port's device node. */
  readonly deviceInstanceId: string;
}

/**
 * Lists the serial ports of this machine whose device node reports these USB IDs.
 *
 * Returns an empty list where nothing matches, and on a platform that is not Windows: the caller
 * then skips, because there is nothing to seed a permission with.
 */
export function findWindowsSerialDevices(
  vendorId: number,
  productId: number,
): readonly WindowsSerialDevice[] {
  if (process.platform !== 'win32') {
    return [];
  }

  const pattern = `VID_${hex(vendorId)}&PID_${hex(productId)}`;
  // `@(...)` keeps a single match an array, which `ConvertTo-Json -AsArray` would do - but that
  // parameter does not exist in Windows PowerShell 5.1, which is what `powershell.exe` is.
  const script =
    '$ports = @(Get-CimInstance Win32_PnPEntity | ' +
    `Where-Object { $_.Name -like '*(COM*' -and $_.DeviceID -like '*${pattern}*' } | ` +
    'Select-Object Name, DeviceID); ConvertTo-Json -Compress -InputObject $ports';

  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );

  const parsed: unknown = JSON.parse(output.trim() === '' ? '[]' : output);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry: unknown) => {
    const record = entry as { Name?: unknown; DeviceID?: unknown };
    if (typeof record.Name !== 'string' || typeof record.DeviceID !== 'string') {
      return [];
    }
    const portName = /\((COM\d+)\)/.exec(record.Name)?.[1];
    return [
      {
        portName: portName ?? '',
        name: record.Name,
        deviceInstanceId: record.DeviceID,
      },
    ];
  });
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * A throwaway browser profile that already has permission for one serial port.
 *
 * A real browser shows the serial port picker only to a user, and a test may not click it: an
 * automated click on a native permission dialogue is exactly the thing this library must never
 * teach anyone to do. The permission is therefore written into the profile *before* the browser
 * starts, which is where the browser would keep it anyway.
 *
 * Chromium stores it as the content setting registered as `serial-chooser-data` in the profile's
 * `Preferences` file - under the preference name `serial_chooser_data`, because the preference
 * path replaces every `-` with `_` - under the requesting origin, as a list of "chosen objects"
 * (`components/permissions/object_permission_context_base.cc`, `kObjectListKey`). On Windows one
 * such object is exactly two fields - a display name and the device instance ID - and a port is
 * granted when its instance ID matches (`chrome/browser/serial/serial_chooser_context.cc`,
 * `PortInfoToValue`, `IsValidObject`, `HasPortPermission`). Anything else in the object makes it
 * invalid and it is dropped on load, which is why nothing extra is written here.
 *
 * The profile is a throwaway: a directory under the test run's output, used by one browser launch
 * and deleted with the run's artefacts. Nothing touches the developer's own browser profile or any
 * machine-wide setting, and no enterprise policy or registry key is involved.
 *
 * See ADR-0035.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** What a granted port looks like in the profile. */
export interface SerialPermission {
  /** The origin that may use the port, such as `http://localhost:8146`. No trailing slash. */
  readonly origin: string;
  /** The device instance ID of the COM port, as Windows reports it. */
  readonly deviceInstanceId: string;
  /** What the browser shows for the port. Cosmetic, but the entry is invalid without it. */
  readonly name: string;
}

/**
 * Writes a profile directory whose `Default/Preferences` grants `permission`.
 *
 * @returns The directory to pass to `launchPersistentContext`.
 */
export async function createProfileWithSerialPermission(
  directory: string,
  permission: SerialPermission,
): Promise<string> {
  const preferences = {
    profile: {
      content_settings: {
        exceptions: {
          // The content setting is registered as `serial-chooser-data`, but its preference path
          // is not: Chromium replaces every `-` with `_` when it derives the pref name
          // (`components/content_settings/core/browser/website_settings_info.cc`,
          // `GetPreferenceName`). With the registered spelling the entry is simply ignored.
          serial_chooser_data: {
            // Content settings are keyed by "<primary pattern>,<secondary pattern>"; this
            // setting is scoped to the top-level origin, so the secondary one is the wildcard.
            [`${permission.origin},*`]: {
              last_modified: String(windowsEpochMicroseconds()),
              setting: {
                'chosen-objects': [
                  {
                    device_instance_id: permission.deviceInstanceId,
                    name: permission.name,
                  },
                ],
              },
            },
          },
        },
      },
    },
  };

  const profileDirectory = path.join(directory, 'Default');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, 'Preferences'), JSON.stringify(preferences), 'utf8');
  return directory;
}

/** `base::Time`'s internal value: microseconds since 1601-01-01, which is what the file holds. */
function windowsEpochMicroseconds(): number {
  const millisecondsBetween1601And1970 = 11_644_473_600_000;
  return (Date.now() + millisecondsBetween1601And1970) * 1000;
}

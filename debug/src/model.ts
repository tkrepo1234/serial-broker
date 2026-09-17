import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type {
  ConfigurationDiagnostics,
  DiagnosticsSnapshot,
  EffectiveSettings,
  ParticipantDiagnostics,
} from '../../src/diagnostics.js';

/**
 * What the debugging surface shows, worked out from what the library reports.
 *
 * One view per configuration, wherever it exists - in this tab, in another tab, or only in
 * storage - with the actions that make sense for it from here. Pure, so the rules for which
 * button appears where are unit-tested rather than clicked through.
 */

/** One tab's view of a configuration. */
export interface TabView {
  readonly clientId: string;
  readonly isThisTab: boolean;
  readonly configuration: ConfigurationDiagnostics;
}

/** What the user can do with a configuration from this page. */
export type ConfigurationAction =
  'connect' | 'disconnect' | 'choose-device' | 'choose-again' | 'edit';

/** A configuration as the list and its detail view show it. */
export interface ConfigurationView {
  readonly name: string;
  /** The settings it runs with, or would be started with. */
  readonly settings: EffectiveSettings | undefined;
  /** The status as the owning tab reports it, which is the one that holds the port. */
  readonly status: ConfigurationDiagnostics['status'] | undefined;
  /** This tab first, then the owner, then the rest. */
  readonly tabs: readonly TabView[];
  readonly owner: TabView | undefined;
  readonly isSetUpHere: boolean;
  readonly isRemembered: boolean;
  /** `true` when the tabs running it do not all run the same settings. */
  readonly settingsDiffer: boolean;
  readonly actions: ReadonlySet<ConfigurationAction>;
}

/** A configuration kept in storage from an earlier visit. */
export interface RememberedConfiguration {
  readonly name: string;
  readonly settings: EffectiveSettings;
}

/** Everything the views are built from. */
export interface ViewSources {
  /** This tab's own report, taken just now; `undefined` before it has set anything up. */
  readonly thisTab: ParticipantDiagnostics | undefined;
  /** The last collection from the whole origin, which may be a moment old. */
  readonly snapshot: DiagnosticsSnapshot | undefined;
  readonly remembered: readonly RememberedConfiguration[];
}

/**
 * Builds one view per configuration, sorted by name.
 *
 * This tab's entry always comes from its own fresh report rather than from the snapshot, so a
 * button pressed here changes the page at once instead of on the next collection.
 */
export function buildConfigurationViews(sources: ViewSources): ConfigurationView[] {
  const thisTabId = sources.thisTab?.clientId;
  const others = (sources.snapshot?.participants ?? []).filter(
    (participant) => participant.clientId !== thisTabId,
  );
  const participants = sources.thisTab === undefined ? others : [sources.thisTab, ...others];

  const names = new Set<string>();
  for (const participant of participants) {
    for (const configuration of participant.configurations) {
      names.add(configuration.name);
    }
  }
  for (const remembered of sources.remembered) {
    names.add(remembered.name);
  }

  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => describeConfiguration(name, participants, thisTabId, sources.remembered));
}

function describeConfiguration(
  name: string,
  participants: readonly ParticipantDiagnostics[],
  thisTabId: string | undefined,
  remembered: readonly RememberedConfiguration[],
): ConfigurationView {
  const tabs = participants
    .flatMap((participant) =>
      participant.configurations
        .filter((configuration) => configuration.name === name)
        .map((configuration) => ({
          clientId: participant.clientId,
          isThisTab: participant.clientId === thisTabId,
          configuration,
        })),
    )
    .sort(byRelevance);

  const here = tabs.find((tab) => tab.isThisTab);
  const owner = tabs.find((tab) => tab.configuration.role === 'owner');
  const rememberedSettings = remembered.find((entry) => entry.name === name)?.settings;
  const settings =
    here?.configuration.settings ??
    owner?.configuration.settings ??
    tabs[0]?.configuration.settings ??
    rememberedSettings;

  const actions = new Set<ConfigurationAction>();
  // Offered for any configuration the page can show, connected or not. Editing settings starts
  // from what is remembered, and disconnecting is how the page offers to forget an entry - which
  // is about what the browser stores, not about this tab, so it must not take connecting first.
  actions.add('disconnect');
  if (settings !== undefined) {
    actions.add('edit');
  }
  if (here !== undefined) {
    // The permission is the origin's, so any tab taking part may ask for it; the tab holding the
    // port then opens the port chosen (ADR-0036). A tab queued for a place or one that withdrew
    // does not take part, and neither is ever `awaiting-permission`.
    if (here.configuration.status === 'awaiting-permission') {
      actions.add('choose-device');
    }
    // Any tab taking part may let the user choose a different device for a configuration in auto
    // mode that has one; the tab holding the port switches to it (ADR-0036).
    const device = here.configuration.settings.device;
    if (
      'auto' in device &&
      device.resolved !== undefined &&
      here.configuration.status !== 'queued' &&
      !isWithdrawn(here, owner)
    ) {
      actions.add('choose-again');
    }
  } else if (settings !== undefined) {
    actions.add('connect');
  }

  return {
    name,
    settings,
    status:
      owner?.configuration.status ?? here?.configuration.status ?? tabs[0]?.configuration.status,
    tabs,
    owner,
    isSetUpHere: here !== undefined,
    isRemembered: rememberedSettings !== undefined,
    settingsDiffer: new Set(tabs.map((tab) => JSON.stringify(tab.configuration.settings))).size > 1,
    actions,
  };
}

/** This page's part in a configuration, as the list and the detail summary name it. */
export type PageState = 'connected' | 'queued' | 'withdrawn' | 'not connected';

/** Works out this page's part in a configuration. */
export function thisPageState(view: ConfigurationView): PageState {
  const here = view.tabs.find((tab) => tab.isThisTab);
  if (here === undefined) {
    return 'not connected';
  }
  if (here.configuration.status === 'queued') {
    return 'queued';
  }
  return isWithdrawn(here, view.owner) ? 'withdrawn' : 'connected';
}

/**
 * Whether a tab gave the configuration up because the tab holding the port runs a different tab
 * limit (ADR-0025). It stays `failed`, off the bus, until its settings change.
 *
 * A report has no flag for it, so it is recognised by its traces: `failed` with
 * `CONFIGURATION_CONFLICT`, and a tab limit other than the holder's. The limit is what confirms it:
 * only the tab that withdraws records the conflict's code, but a report is another context's word,
 * and a tab running the holder's limit has nothing to withdraw over.
 *
 * @param owner - The tab holding the port, if any tab reports it.
 */
export function isWithdrawn(tab: TabView, owner: TabView | undefined): boolean {
  const { configuration } = tab;
  return (
    configuration.role !== 'owner' &&
    configuration.status === 'failed' &&
    configuration.lastErrorCode === SerialBrokerErrorCode.CONFIGURATION_CONFLICT &&
    // With no holder reported, the traces above are all there is to go by.
    owner?.configuration.settings.maxTabs !== configuration.settings.maxTabs
  );
}

/** A tab's part in a configuration: `holds the port`, `waiting`, `queued` or `withdrew`. */
export function tabRole(tab: TabView, owner: TabView | undefined): string {
  if (tab.configuration.role === 'owner') {
    return 'holds the port';
  }
  if (tab.configuration.status === 'queued') {
    return 'queued';
  }
  return isWithdrawn(tab, owner) ? 'withdrew' : 'waiting';
}

function byRelevance(a: TabView, b: TabView): number {
  const rank = (tab: TabView): number =>
    tab.isThisTab ? 0 : tab.configuration.role === 'owner' ? 1 : 2;
  return rank(a) - rank(b) || a.clientId.localeCompare(b.clientId);
}

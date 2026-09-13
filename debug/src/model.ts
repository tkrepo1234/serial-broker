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

/** What the user can do with a configuration from this tab. */
export type CardAction = 'join' | 'release' | 'choose-device';

/** A configuration as one card shows it. */
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
  readonly actions: ReadonlySet<CardAction>;
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
 * button pressed here changes the card at once instead of on the next collection.
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

  const actions = new Set<CardAction>();
  if (here !== undefined) {
    actions.add('release');
    // Only the owner can act on the picker's result, so the button belongs in its tab alone.
    if (
      here.configuration.role === 'owner' &&
      here.configuration.status === 'awaiting-permission'
    ) {
      actions.add('choose-device');
    }
  } else if (settings !== undefined) {
    actions.add('join');
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

function byRelevance(a: TabView, b: TabView): number {
  const rank = (tab: TabView): number =>
    tab.isThisTab ? 0 : tab.configuration.role === 'owner' ? 1 : 2;
  return rank(a) - rank(b) || a.clientId.localeCompare(b.clientId);
}

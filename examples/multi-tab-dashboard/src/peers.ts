/**
 * What the other tabs see.
 *
 * serial-broker delivers the same status to every tab, and deliberately says nothing about which
 * tab holds the port. This panel shows the first half of that: each tab tells the others the
 * status it was given, over a `BroadcastChannel` of the application's own, and every tab lists
 * what it heard. When they all say "Connected", that is one port, reported once, shown everywhere.
 *
 * Nothing here touches the library. It is what any application does to show its own tabs.
 */

const CHANNEL_NAME = 'multi-tab-dashboard/tabs';
const LABEL_KEY = 'multi-tab-dashboard/tab-label';
/** How often a tab repeats its status, so that a tab that crashed is noticed. */
const HEARTBEAT_MS = 5_000;
/** After this much silence a tab is taken off the list. Three missed heartbeats. */
const SILENT_AFTER_MS = 3 * HEARTBEAT_MS + 1_000;

interface PeerMessage {
  readonly type: 'hello' | 'status' | 'bye';
  readonly tab: string;
  readonly status: string;
  readonly at: number;
}

interface Peer {
  status: string;
  /** When the status was last reported. */
  at: number;
  /** When this tab last heard from it. */
  heard: number;
}

/** The panel's controls. */
export interface PeersPanel {
  /** Tells the other tabs this tab's status. Call it on every status change. */
  announce(status: string): void;
  /** Says goodbye and stops listening. */
  stop(): void;
}

/**
 * A label for this tab, kept in `sessionStorage` so it survives a reload of the same tab and
 * differs from every other tab's.
 */
export function tabLabel(): string {
  try {
    const stored = sessionStorage.getItem(LABEL_KEY);
    if (stored !== null) {
      return stored;
    }
    const label = `Tab ${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    sessionStorage.setItem(LABEL_KEY, label);
    return label;
  } catch {
    // Storage disabled: a label that lasts for this page load is still a label.
    return `Tab ${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  }
}

/**
 * Builds the panel and joins the channel.
 *
 * @param present - Turns a status into the text shown for it, so the list reads like the status line.
 */
export function createPeersPanel(
  list: HTMLUListElement,
  ownLabel: string,
  present: (status: string) => string,
): PeersPanel {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const peers = new Map<string, Peer>();
  let ownStatus = 'starting';

  function render(): void {
    list.replaceChildren();
    if (peers.size === 0) {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = 'No other tab is open on this device. Open one and it appears here.';
      list.append(item);
      return;
    }
    for (const [label, peer] of [...peers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const item = document.createElement('li');
      item.dataset['status'] = peer.status;
      const name = document.createElement('strong');
      name.textContent = label;
      const status = document.createElement('span');
      status.className = 'peer-status';
      status.textContent = present(peer.status);
      item.append(name, ': ', status);
      list.append(item);
    }
  }

  function post(type: PeerMessage['type']): void {
    const message: PeerMessage = { type, tab: ownLabel, status: ownStatus, at: Date.now() };
    channel.postMessage(message);
  }

  channel.addEventListener('message', (event: MessageEvent<PeerMessage>) => {
    const message = event.data;
    if (message.type === 'bye') {
      peers.delete(message.tab);
    } else {
      const known = peers.get(message.tab);
      peers.set(message.tab, {
        status: message.status,
        at: known?.status === message.status ? known.at : message.at,
        heard: Date.now(),
      });
      if (message.type === 'hello') {
        // A tab that has just opened asks who else is there.
        post('status');
      }
    }
    render();
  });

  const heartbeat = setInterval(() => {
    post('status');
    const now = Date.now();
    for (const [label, peer] of peers) {
      if (now - peer.heard > SILENT_AFTER_MS) {
        peers.delete(label);
      }
    }
    render();
  }, HEARTBEAT_MS);

  render();
  post('hello');

  return {
    announce(status) {
      ownStatus = status;
      post('status');
    },
    stop() {
      clearInterval(heartbeat);
      post('bye');
      channel.close();
    },
  };
}

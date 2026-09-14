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
/** How often a tab asks the others whether they are still there. */
const PING_MS = 5_000;
/**
 * A tab that has left this many pings in a row unanswered is taken off the list.
 *
 * Pings are counted rather than silence measured: a browser runs the timers of a hidden tab late -
 * Chromium, after five minutes hidden, once a minute - but delivers messages at once, so a hidden
 * tab still answers every ping promptly while its own timer would fall silent for a minute at a
 * time. A tab that crashed answers nothing and is gone within four pings; a tab the browser froze
 * answers nothing either, is gone as well, and returns with the first ping it answers.
 */
const MISSED_PINGS = 3;

interface PeerMessage {
  readonly type: 'hello' | 'ping' | 'status' | 'bye';
  /** The sending tab, for this page load. Two tabs never share one. */
  readonly id: string;
  /** The label the sending tab shows. Two tabs can start with the same one; see the handler. */
  readonly label: string;
  readonly status: string;
}

interface Peer {
  label: string;
  status: string;
  /** Pings in a row this tab has not answered. */
  missed: number;
}

/** What the panel needs from the page. */
export interface PeersPanelOptions {
  /** This tab's label, from {@link tabLabel}. */
  readonly label: string;
  /** Turns a status into the text shown for it, so the list reads like the status line. */
  present(status: string): string;
  /**
   * Called when this tab had to take a new label because another tab showed the same one - a tab
   * duplicated by the browser starts with a copy of this tab's `sessionStorage`.
   */
  onRelabel(label: string): void;
}

/** The panel's controls. */
export interface PeersPanel {
  /** Tells the other tabs this tab's status. Call it on every status change. */
  announce(status: string): void;
  /** Says goodbye and stops listening. */
  stop(): void;
}

function newLabel(): string {
  return `Tab ${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

/**
 * Stores the label so that it survives a reload of the same tab. Storage may be disabled; a label
 * that lasts for this page load is still a label.
 */
function storeLabel(label: string): void {
  try {
    sessionStorage.setItem(LABEL_KEY, label);
  } catch {
    // Not remembered, still shown.
  }
}

/**
 * A label for this tab, kept in `sessionStorage` so it survives a reload of the same tab.
 *
 * It is not guaranteed unique: a browser that duplicates a tab, or opens one with an opener,
 * copies the `sessionStorage` along. The panel notices a peer with the same label and one of the
 * two takes a new one.
 */
export function tabLabel(): string {
  try {
    const stored = sessionStorage.getItem(LABEL_KEY);
    if (stored !== null) {
      return stored;
    }
  } catch {
    // Storage disabled; fall through to a fresh label.
  }
  const label = newLabel();
  storeLabel(label);
  return label;
}

/** Builds the panel and joins the channel. */
export function createPeersPanel(list: HTMLUListElement, options: PeersPanelOptions): PeersPanel {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const peers = new Map<string, Peer>();
  const ownId = crypto.randomUUID();
  let ownLabel = options.label;
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
    const sorted = [...peers.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const peer of sorted) {
      const item = document.createElement('li');
      item.dataset['status'] = peer.status;
      const name = document.createElement('strong');
      name.textContent = peer.label;
      const status = document.createElement('span');
      status.className = 'peer-status';
      status.textContent = options.present(peer.status);
      item.append(name, ': ', status);
      list.append(item);
    }
  }

  function post(type: PeerMessage['type']): void {
    const message: PeerMessage = { type, id: ownId, label: ownLabel, status: ownStatus };
    channel.postMessage(message);
  }

  channel.addEventListener('message', (event: MessageEvent<PeerMessage>) => {
    const message = event.data;
    if (message.type === 'bye') {
      peers.delete(message.id);
      render();
      return;
    }
    peers.set(message.id, { label: message.label, status: message.status, missed: 0 });
    // A question is answered; a plain status report is not, or two tabs would never stop.
    let reply = message.type === 'hello' || message.type === 'ping';
    if (message.label === ownLabel && ownId > message.id) {
      // Two tabs, one label. The ids decide which of them changes, so exactly one does.
      ownLabel = newLabel();
      storeLabel(ownLabel);
      options.onRelabel(ownLabel);
      reply = true;
    }
    if (reply) {
      post('status');
    }
    render();
  });

  const ticker = setInterval(() => {
    for (const [id, peer] of peers) {
      peer.missed += 1;
      if (peer.missed > MISSED_PINGS) {
        peers.delete(id);
      }
    }
    post('ping');
    render();
  }, PING_MS);

  render();
  post('hello');

  return {
    announce(status) {
      ownStatus = status;
      post('status');
    },
    stop() {
      clearInterval(ticker);
      post('bye');
      channel.close();
    },
  };
}

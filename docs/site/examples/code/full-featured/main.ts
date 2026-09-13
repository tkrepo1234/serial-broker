import { ScalePanel } from './scale-panel.js';

function find<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`The page has no ${type.name} matching ${selector}`);
  }
  return found;
}

const panel = new ScalePanel({
  status: find('#status', HTMLElement),
  choose: find('#choose', HTMLButtonElement),
  baudRate: find('#baudRate', HTMLSelectElement),
  disconnect: find('#disconnect', HTMLButtonElement),
  problem: find('#problem', HTMLElement),
  console: find('#console', HTMLFormElement),
  command: find('#command', HTMLInputElement),
  sendButton: find('#sendButton', HTMLButtonElement),
  log: find('#log', HTMLOListElement),
});

await panel.start();

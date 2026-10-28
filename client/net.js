const OPEN = 1;

/** One WebSocket with automatic reconnect. Messages are JSON. */
export class Connection {
  constructor(url, onMessage, onStatus) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.#open();
  }

  send(msg) {
    if (this.ws.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  #open() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.onStatus(true);
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    this.ws.onclose = () => {
      this.onStatus(false);
      setTimeout(() => this.#open(), 1500);
    };
  }
}

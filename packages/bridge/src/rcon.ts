// Minimal Source RCON client (the protocol Factorio's --rcon-port speaks).
// Requests are serialized: Factorio executes commands in tick order anyway, and one
// in-flight request keeps response matching trivial.

import { Socket, connect } from "node:net";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_AUTH_RESPONSE = 2;
const HEADER = 12; // size + id + type

interface Pending {
  id: number;
  resolve: (body: string) => void;
  reject: (err: Error) => void;
}

export class Rcon {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending?: Pending;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
  ) {}

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    const socket = connect({ host: this.host, port: this.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("data", (data: Buffer) => this.onData(data));
    socket.on("close", () => this.onClose(new Error("RCON connection closed")));
    socket.on("error", (err) => this.onClose(err));
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    await this.request(TYPE_AUTH, this.password);
  }

  close(): void {
    this.socket?.destroy();
  }

  /** Run a console command and return whatever it printed via rcon.print. */
  exec(command: string): Promise<string> {
    const run = this.chain.then(() => this.request(TYPE_EXEC, command));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private request(type: number, body: string): Promise<string> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("RCON not connected"));
    const id = this.nextId++;
    const payload = Buffer.from(body, "utf8");
    const packet = Buffer.alloc(HEADER + payload.length + 2);
    packet.writeInt32LE(packet.length - 4, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, HEADER);
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      socket.write(packet);
    });
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (this.buffer.length < size + 4) return;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.toString("utf8", HEADER, size + 4 - 2);
      this.buffer = this.buffer.subarray(size + 4);

      const pending = this.pending;
      if (!pending) continue;
      if (type === TYPE_AUTH_RESPONSE && id === -1) {
        this.pending = undefined;
        pending.reject(new Error("RCON authentication failed"));
      } else if (id === pending.id) {
        this.pending = undefined;
        pending.resolve(body);
      }
    }
  }

  private onClose(err: Error): void {
    this.socket = undefined;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(err);
  }
}

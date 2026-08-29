import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { GhesTargetConnectionConfig } from "$lib/server/core/ghes-target";
import { verifySshHostKey } from "$lib/server/core/ssh-host-key";

export interface GhesCommandResult {
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const GUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireGuid(value: string): string {
  if (!GUID_PATTERN.test(value)) throw new TypeError("Invalid ghe-migrator GUID");
  return value;
}

function collectChannel(channel: ClientChannel, input?: string): Promise<GhesCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let exitCode: number | null = null;
    const append = (current: string, chunk: Buffer): string => {
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_OUTPUT) {
        channel.close();
        reject(new Error(`GHES command output exceeded ${MAX_COMMAND_OUTPUT} bytes`));
        return current;
      }
      return current + chunk.toString("utf8");
    };
    channel.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    channel.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    channel.on("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.on("error", reject);
    channel.on("close", () => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `GHES command exited ${exitCode}`));
    });
    channel.end(input);
  });
}

function acknowledgements(channel: ClientChannel): { next(): Promise<void>; dispose(): void } {
  let buffered = Buffer.alloc(0);
  let pending: { resolve(): void; reject(error: Error): void } | null = null;
  let closedError: Error | null = null;
  const process = () => {
    if (!pending || buffered.length === 0) return;
    const code = buffered[0];
    if (code === 0) {
      buffered = buffered.subarray(1);
      const current = pending;
      pending = null;
      current.resolve();
      return;
    }
    if (code !== 1 && code !== 2) {
      const current = pending;
      pending = null;
      current.reject(new Error(`SCP returned unexpected acknowledgement ${code}`));
      return;
    }
    const newline = buffered.indexOf(0x0a, 1);
    if (newline === -1) return;
    const message = buffered.subarray(1, newline).toString("utf8").trim();
    buffered = buffered.subarray(newline + 1);
    const current = pending;
    pending = null;
    current.reject(new Error(message || "SCP transfer failed"));
  };
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    process();
  };
  const onError = (error: Error) => {
    closedError = error;
    const current = pending;
    pending = null;
    current?.reject(error);
  };
  const onClose = () => onError(new Error("SCP channel closed before acknowledgement"));
  channel.on("data", onData);
  channel.on("error", onError);
  channel.on("close", onClose);
  return {
    next: () =>
      new Promise<void>((resolve, reject) => {
        if (closedError) return reject(closedError);
        if (pending) return reject(new Error("SCP acknowledgement already pending"));
        pending = { resolve, reject };
        process();
      }),
    dispose: () => {
      channel.off("data", onData);
      channel.off("error", onError);
      channel.off("close", onClose);
    },
  };
}

async function write(channel: ClientChannel, chunk: Buffer | string): Promise<void> {
  if (channel.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      channel.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      channel.off("drain", onDrain);
      reject(error);
    };
    channel.once("drain", onDrain);
    channel.once("error", onError);
  });
}

export class GhesSshClient {
  readonly #config: GhesTargetConnectionConfig;
  readonly #client: Client;
  #connected = false;

  constructor(config: GhesTargetConnectionConfig, client: Client = new Client()) {
    this.#config = config;
    this.#client = client;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const options: ConnectConfig = {
      host: this.#config.sshHost,
      port: this.#config.sshPort,
      username: this.#config.sshUsername,
      privateKey: this.#config.sshPrivateKey,
      hostVerifier: (key: Buffer) => verifySshHostKey(key, this.#config.sshHostFingerprint),
      readyTimeout: 30_000,
    };
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.#client.end();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#client
        .once("ready", () => {
          signal?.removeEventListener("abort", abort);
          this.#connected = true;
          resolve();
        })
        .once("error", (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        })
        .connect(options);
    });
  }

  disconnect(): void {
    this.#connected = false;
    this.#client.end();
  }

  remoteArchivePath(localPath: string): string {
    const name = basename(localPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.tar\.gz$/.test(name)) {
      throw new TypeError("Invalid GHES archive filename");
    }
    return `${this.#config.remoteDirectory}/${name}`;
  }

  async uploadArchive(localPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const remotePath = this.remoteArchivePath(localPath);
    const archive = await lstat(localPath);
    if (!archive.isFile() || archive.isSymbolicLink() || !Number.isSafeInteger(archive.size)) {
      throw new Error("GHES migration archive is not a regular file with a supported size");
    }
    const channel = await this.#openChannel(`scp -t ${quote(remotePath)}`);
    const acknowledger = acknowledgements(channel);
    const abort = () => this.#client.end();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await acknowledger.next();
      await write(channel, `C0644 ${archive.size} ${basename(remotePath)}\n`);
      await acknowledger.next();
      for await (const chunk of createReadStream(localPath)) {
        signal?.throwIfAborted();
        await write(channel, chunk as Buffer);
      }
      await write(channel, Buffer.from([0]));
      await acknowledger.next();
      channel.end();
      return remotePath;
    } finally {
      signal?.removeEventListener("abort", abort);
      acknowledger.dispose();
    }
  }

  async prepare(remotePath: string): Promise<string> {
    const result = await this.#exec(`ghe-migrator prepare ${quote(remotePath)}`);
    const match = result.stdout.match(/Migration GUID:\s*([A-Za-z0-9][A-Za-z0-9-]{7,127})/i);
    if (!match?.[1]) throw new Error("ghe-migrator prepare did not return a Migration GUID");
    return requireGuid(match[1]);
  }

  conflicts(guid: string): Promise<GhesCommandResult> {
    return this.#exec(`ghe-migrator conflicts -g ${requireGuid(guid)}`);
  }
  mappingRecords(guid: string): Promise<GhesCommandResult> {
    return this.#exec(`ghe-migrator audit -m organization,repository -g ${requireGuid(guid)}`);
  }
  map(guid: string, csv: string): Promise<GhesCommandResult> {
    return this.#exec(`ghe-migrator map -i /dev/stdin -g ${requireGuid(guid)}`, csv);
  }
  import(remotePath: string, guid: string): Promise<GhesCommandResult> {
    return this.#exec(
      `ghe-migrator import ${quote(remotePath)} -g ${requireGuid(guid)} -u ${quote(this.#config.siteAdminUsername)} -p ${quote(this.#config.siteAdminToken)}`,
    );
  }
  auditFailures(guid: string): Promise<GhesCommandResult> {
    return this.#exec(
      `ghe-migrator audit -s failed_import,failed_map,failed_rename,failed_merge -g ${requireGuid(guid)}`,
    );
  }
  unlock(guid: string): Promise<GhesCommandResult> {
    return this.#exec(`ghe-migrator unlock -g ${requireGuid(guid)}`);
  }
  removeArchive(remotePath: string): Promise<GhesCommandResult> {
    return this.#exec(`rm -f -- ${quote(remotePath)}`);
  }

  async #exec(command: string, input?: string): Promise<GhesCommandResult> {
    return collectChannel(await this.#openChannel(command), input);
  }

  async #openChannel(command: string): Promise<ClientChannel> {
    if (!this.#connected) throw new Error("GHES SSH client is not connected");
    return new Promise((resolve, reject) => {
      this.#client.exec(command, (error, stream) => (error ? reject(error) : resolve(stream)));
    });
  }
}

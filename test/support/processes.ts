import { fileURLToPath } from 'node:url';
import { testEnvironment } from './environment';
export type HarnessCommand = { requestId: string; action: 'release' }
  | { requestId: string; action: 'consumer'; queueUrl: string; consumerName: string; hold?: boolean }
  | { requestId: string; action: 'publisher'; queueUrl: string; ids: string[]; hold?: boolean; leaseMs?: number };
interface Packet { type: 'ready' | 'stage' | 'result' | 'failure'; requestId?: string; stage?: string; entityId?: string; value?: number; pid?: number; databasePid?: number; base?: string; }
export async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export class HarnessNode {
  readonly process: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
  pid = 0; databasePid = 0; base = '';
  private stderr = '';
  private readonly stderrDone: Promise<void>;
  private packets: Packet[] = [];
  private listeners = new Set<() => void>();
  constructor(entrypoint = new URL('./process-child.ts', import.meta.url)) {
    testEnvironment();
    this.process = Bun.spawn([process.execPath, fileURLToPath(entrypoint)], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      ipc: raw => { this.packets.push(raw as Packet); for (const listener of this.listeners) listener(); },
    });
    const child = this.process;
    this.stderrDone = (async () => {
      const reader = child.stderr.getReader(), decoder = new TextDecoder();
      for (;;) { const next = await reader.read(); if (next.done) break; this.stderr = (this.stderr + decoder.decode(next.value, { stream: true })).slice(-65536); }
    })();
  }
  private async packet(predicate: (packet: Packet) => boolean): Promise<Packet> {
    let inspect!: () => void;
    try {
      return await within(new Promise<Packet>((resolve, reject) => {
        inspect = () => { const index = this.packets.findIndex(predicate); if (index >= 0) { this.listeners.delete(inspect); resolve(this.packets.splice(index, 1)[0]!); } };
        this.listeners.add(inspect); inspect();
        void this.process.exited.then(async () => { await this.stderrDone; reject(new Error('Processo do harness encerrou antes do sinal. ' + this.stderr)); });
      }), 15000, 'Prazo de sinal IPC excedido. ' + this.stderr);
    } finally { this.listeners.delete(inspect); }
  }
  async ready(): Promise<void> {
    const packet = await this.packet(message => message.type === 'ready');
    this.pid = packet.pid!; this.databasePid = packet.databasePid!; this.base = packet.base!;
    const response = await fetch(this.base + '/health/ready', { signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) throw new Error('Processo iniciado sem readiness válida.');
  }
  async startupBlocked(): Promise<void> { await this.packet(message => message.type === 'stage' && message.stage === 'startup-blocked'); }
  command(command: Omit<Extract<HarnessCommand, { action: 'consumer' }>, 'requestId'> | Omit<Extract<HarnessCommand, { action: 'publisher' }>, 'requestId'>) {
    const requestId = crypto.randomUUID();
    const done = this.packet(message => message.requestId === requestId && ['result', 'failure'].includes(message.type)).then(packet => {
      if (packet.type === 'failure') throw new Error('Operação do processo filho falhou. ' + this.stderr);
      return packet.value!;
    });
    void done.catch(() => {});
    this.process.send({ ...command, requestId });
    return { done, stage: (stage: string) => this.packet(message => message.requestId === requestId && message.stage === stage),
      release: () => this.process.send({ action: 'release', requestId }) };
  }
  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
    await within(this.process.exited, 5000, 'Processo filho não encerrou.');
    await this.stderrDone; this.listeners.clear();
  }
}
export class ProcessHarness {
  readonly nodes: HarnessNode[] = [];
  async start(count = 3): Promise<void> {
    if (this.nodes.length || !Number.isInteger(count) || count < 1 || count > 3) throw new Error('Quantidade ou estado de processos inválido.');
    try { for (let index = 0; index < count; index++) this.nodes.push(new HarnessNode()); await Promise.all(this.nodes.map(node => node.ready())); }
    catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    const outcomes = await Promise.allSettled(this.nodes.splice(0).map(node => node.close()));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

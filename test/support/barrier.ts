export class Barrier {
  private arrived = 0;
  private announce!: () => void;
  private open!: () => void;
  readonly ready = new Promise<void>(resolve => { this.announce = resolve; });
  private readonly gate = new Promise<void>(resolve => { this.open = resolve; });
  constructor(readonly parties: number) {
    if (!Number.isSafeInteger(parties) || parties < 1) throw new Error('Número de participantes inválido.');
  }
  arriveAndWait(): Promise<void> {
    if (this.arrived >= this.parties) throw new Error('Barreira já recebeu todos os participantes.');
    if (++this.arrived === this.parties) this.announce();
    return this.gate;
  }
  release(): void {
    if (this.arrived !== this.parties) throw new Error('Barreira ainda não está pronta.');
    this.open();
  }
}

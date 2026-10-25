export interface Identifiers { next(): string; }
export class UuidIdentifiers implements Identifiers { next(): string { return crypto.randomUUID(); } }

export interface ReferenceClaimOptions { owner: string; limit: number; leaseMs: number; now?: Date; ids?: readonly string[]; }
export interface ReferenceStore { claim(options: ReferenceClaimOptions): Promise<string[]>; }
export interface ReferenceProcessor { reprocessPending(id: string, owner: string, now?: () => Date): Promise<void>; }

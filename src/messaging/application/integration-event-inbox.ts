export interface IntegrationEventInbox { receive(eventId: string, payloadHash: string): Promise<boolean>; }

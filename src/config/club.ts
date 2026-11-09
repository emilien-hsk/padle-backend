/**
 * Club suivi pour les réservations (Playtomic).
 * Les identifiants viennent de la page publique du club :
 * https://playtomic.com/clubs/smashing-club-le-roeulx
 */
export type CourtType = 'indoor' | 'covered' | 'outdoor';

export interface Court {
  id: string; // resource_id Playtomic
  name: string;
  number: number;
  type: CourtType;
}

export const CLUB = {
  name: 'Smashing Club Le Roeulx',
  address: 'Rue de la Station 142, 7070 Le Rœulx',
  tenantId: process.env.PLAYTOMIC_TENANT_ID || 'b27c9683-877d-457a-9de5-80216754c6df',
  slug: 'smashing-club-le-roeulx',
  timeZone: 'Europe/Brussels',
};

export const COURTS: Court[] = [
  { id: '88c9029e-7eaf-4ad0-9b32-fa533a65982c', number: 1, name: 'Artengo', type: 'covered' },
  { id: '360e2cd7-34c9-4d43-a7dc-49f58301734a', number: 2, name: 'Perrier', type: 'covered' },
  { id: '39b3c487-149f-488a-b1e6-4b23fb2b0825', number: 3, name: 'Herman et Augustine', type: 'covered' },
  { id: '533b9e7b-6175-4ea2-83f1-a28797755e17', number: 4, name: 'NEO (bleu)', type: 'indoor' },
  { id: '0d3c0fdb-8900-479c-9b0c-7301f7733753', number: 5, name: 'MDS Proconsult (vert)', type: 'indoor' },
  { id: '6a2702cc-e860-4953-9ef8-966885f0ef94', number: 6, name: 'Vert 1', type: 'indoor' },
  { id: '3bd42915-d5b9-45b7-b459-4654eb282621', number: 7, name: 'Vert 2', type: 'indoor' },
  { id: 'b294b2ee-387d-4a98-8a73-a504256a18df', number: 8, name: 'Oxdog', type: 'outdoor' },
  { id: '775c041c-ec4d-4336-911f-3cae6a08936a', number: 9, name: 'Solution Energie', type: 'outdoor' },
];

export function clubPageUrl(date?: string): string {
  const base = `https://playtomic.com/clubs/${CLUB.slug}`;
  return date ? `${base}?date=${date}` : base;
}

/**
 * Lien direct vers le paiement Playtomic d'un créneau précis.
 * Si le joueur n'est pas connecté, Playtomic affiche d'abord sa page de
 * connexion puis le renvoie sur ce créneau.
 */
export function slotBookingUrl(resourceId: string, startUtcIso: string, duration: number): string {
  const params = new URLSearchParams({
    type: 'CUSTOMER_MATCH',
    tenant_id: CLUB.tenantId,
    resource_id: resourceId,
    start: startUtcIso,
    duration: String(duration),
    sport_id: 'PADEL',
  });
  return `https://app.playtomic.com/payments?${params.toString()}`;
}

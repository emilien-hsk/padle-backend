import webpush from 'web-push';
import mongoose from 'mongoose';
import PushSubscription from '../models/PushSubscription';

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('Push désactivé : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants');
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'https://padlecau.vercel.app',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

export function getPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** Envoie une notification push sur tous les appareils d'un joueur. */
export async function sendPushToPlayer(
  playerId: mongoose.Types.ObjectId | string,
  payload: PushPayload
): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = await PushSubscription.find({ player: playerId });

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          JSON.stringify(payload),
          { TTL: 6 * 3600 }
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        // Abonnement expiré ou révoqué : on le supprime
        if (status === 404 || status === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error('Erreur envoi push:', status ?? err);
        }
      }
    })
  );
}

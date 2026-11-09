import { Router, Response } from 'express';
import Notification from '../models/Notification';
import PushSubscription from '../models/PushSubscription';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getPublicKey } from '../services/push';

const router = Router();

// GET /api/notifications/push-key — clé publique VAPID pour s'abonner (public)
router.get('/push-key', (_req, res: Response): void => {
  res.json({ publicKey: getPublicKey() });
});

router.use(authMiddleware);

// GET /api/notifications — 30 dernières + nombre de non lues
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const [items, unread] = await Promise.all([
    Notification.find({ player: req.playerId }).sort({ createdAt: -1 }).limit(30),
    Notification.countDocuments({ player: req.playerId, read: false }),
  ]);
  res.json({ items, unread });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  await Notification.updateMany({ player: req.playerId, read: false }, { read: true });
  res.json({ ok: true });
});

// POST /api/notifications/subscribe — enregistre l'abonnement push de cet appareil
router.post('/subscribe', async (req: AuthRequest, res: Response): Promise<void> => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    res.status(400).json({ message: 'Abonnement invalide' });
    return;
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { player: req.playerId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    { upsert: true }
  );
  res.status(201).json({ ok: true });
});

// POST /api/notifications/unsubscribe — retire l'abonnement de cet appareil
router.post('/unsubscribe', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.body?.endpoint) {
    await PushSubscription.deleteOne({ endpoint: req.body.endpoint, player: req.playerId });
  }
  res.json({ ok: true });
});

export default router;

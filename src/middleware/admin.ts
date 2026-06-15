import { Response, NextFunction } from 'express';
import Player from '../models/Player';
import { AuthRequest } from './auth';

export async function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const player = await Player.findById(req.playerId);
  if (!player?.isAdmin) {
    res.status(403).json({ message: 'Accès réservé à l\'administrateur' });
    return;
  }
  next();
}

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Player from '../models/Player';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ message: 'Champs obligatoires manquants' });
    return;
  }

  const existing = await Player.findOne({ email });
  if (existing) {
    res.status(409).json({ message: 'Email déjà utilisé' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const player = await Player.create({ username, email, passwordHash, isRegistered: true });

  const token = jwt.sign({ id: player._id }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '30d',
  });

  res.status(201).json({ token, player: { _id: player._id, username, email, elo: player.elo } });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  const player = await Player.findOne({ email, isRegistered: true });
  if (!player || !player.passwordHash) {
    res.status(401).json({ message: 'Identifiants invalides' });
    return;
  }

  const valid = await bcrypt.compare(password, player.passwordHash);
  if (!valid) {
    res.status(401).json({ message: 'Identifiants invalides' });
    return;
  }

  const token = jwt.sign({ id: player._id }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '30d',
  });

  res.json({ token, player: { _id: player._id, username: player.username, email: player.email, elo: player.elo } });
});

export default router;

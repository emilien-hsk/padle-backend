import { Router, Request, Response } from 'express';
import { CLUB, COURTS, clubPageUrl, slotBookingUrl } from '../config/club';

const router = Router();

// Endpoint utilisé par la page publique du club sur playtomic.com
// (non documenté officiellement). Les heures (start_time) sont en UTC.
const PLAYTOMIC_AVAILABILITY_URL = 'https://playtomic.com/api/clubs/availability';
const CACHE_TTL_MS = 60 * 1000;
const MAX_DAYS_AHEAD = 14;

interface PlaytomicSlot {
  start_time: string; // "HH:MM:SS" UTC
  duration: number; // minutes
  price: string; // ex. "20 EUR"
}

interface PlaytomicResourceAvailability {
  resource_id: string;
  start_date: string; // YYYY-MM-DD (UTC)
  slots: PlaytomicSlot[];
}

const cache = new Map<string, { at: number; data: PlaytomicResourceAvailability[] }>();

async function fetchAvailability(date: string): Promise<PlaytomicResourceAvailability[]> {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const params = new URLSearchParams({
    tenant_id: CLUB.tenantId,
    date,
    sport_id: 'PADEL',
  });
  const res = await fetch(`${PLAYTOMIC_AVAILABILITY_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (PadlEcau)',
      Referer: `https://playtomic.com/clubs/${CLUB.slug}`,
    },
  });
  if (!res.ok) throw new Error(`Playtomic a répondu ${res.status}`);
  const data = (await res.json()) as PlaytomicResourceAvailability[];

  cache.set(date, { at: Date.now(), data });
  // Évite que le cache grossisse indéfiniment
  if (cache.size > 50) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    cache.delete(oldest[0]);
  }
  return data;
}

const timeFmt = new Intl.DateTimeFormat('fr-BE', {
  timeZone: CLUB.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parsePrice(price: string): number | null {
  const n = parseFloat(price.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffDays = (d.getTime() - today.getTime()) / 86_400_000;
  return diffDays >= -1 && diffDays <= MAX_DAYS_AHEAD + 1;
}

// GET /api/booking/club — infos du club suivi
router.get('/club', (_req: Request, res: Response): void => {
  res.json({
    name: CLUB.name,
    address: CLUB.address,
    url: clubPageUrl(),
    courts: COURTS,
    maxDaysAhead: MAX_DAYS_AHEAD,
  });
});

// GET /api/booking/availability?date=YYYY-MM-DD — créneaux libres du jour
router.get('/availability', async (req: Request, res: Response): Promise<void> => {
  const date = String(req.query.date || '');
  if (!isValidDate(date)) {
    res.status(400).json({ message: 'Date invalide (format AAAA-MM-JJ, max 14 jours)' });
    return;
  }

  try {
    const raw = await fetchAvailability(date);
    const now = Date.now();

    const courts = COURTS.map((court) => {
      const entry = raw.find((r) => r.resource_id === court.id);
      const slots = (entry?.slots ?? [])
        .map((s) => {
          const startUtc = `${entry!.start_date}T${s.start_time}.000Z`;
          const startMs = Date.parse(startUtc);
          return {
            start: startUtc,
            time: timeFmt.format(new Date(startMs)),
            duration: s.duration,
            price: parsePrice(s.price),
            priceLabel: s.price,
            bookingUrl: slotBookingUrl(court.id, startUtc, s.duration),
            _ms: startMs,
          };
        })
        .filter((s) => s._ms > now)
        .sort((a, b) => a._ms - b._ms || a.duration - b.duration)
        .map(({ _ms, ...s }) => s);

      return { ...court, slots };
    });

    res.json({
      date,
      clubUrl: clubPageUrl(date),
      fetchedAt: new Date().toISOString(),
      courts,
    });
  } catch (err) {
    console.error('Erreur disponibilités Playtomic:', err);
    res.status(502).json({
      message: 'Impossible de récupérer les disponibilités Playtomic pour le moment',
      clubUrl: clubPageUrl(date),
    });
  }
});

export default router;

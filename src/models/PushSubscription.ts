import mongoose, { Document, Schema } from 'mongoose';

/** Abonnement Web Push d'un appareil (un joueur peut en avoir plusieurs). */
export interface IPushSubscription extends Document {
  player: mongoose.Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const PushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    player: { type: Schema.Types.ObjectId, ref: 'Player', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);

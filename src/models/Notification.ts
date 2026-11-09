import mongoose, { Document, Schema } from 'mongoose';

export type NotificationType = 'availability_match';

export interface INotification extends Document {
  player: mongoose.Types.ObjectId; // destinataire
  type: NotificationType;
  title: string;
  body: string;
  url: string;
  fromPlayer?: mongoose.Types.ObjectId;
  start?: Date;
  end?: Date;
  read: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    player: { type: Schema.Types.ObjectId, ref: 'Player', required: true, index: true },
    type: { type: String, enum: ['availability_match'], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    url: { type: String, default: '/partners' },
    fromPlayer: { type: Schema.Types.ObjectId, ref: 'Player' },
    start: { type: Date },
    end: { type: Date },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Les notifications sont supprimées automatiquement après 30 jours
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export default mongoose.model<INotification>('Notification', NotificationSchema);

import mongoose, { Document, Schema } from 'mongoose';

/**
 * Canal de discussion éphémère entre joueurs dispos en même temps.
 * Supprimé automatiquement (index TTL) 24 h après la fin de la plage.
 */
export interface IChannel extends Document {
  members: mongoose.Types.ObjectId[];
  availabilities: mongoose.Types.ObjectId[];
  start: Date;
  end: Date;
  expiresAt: Date;
  lastMessageAt?: Date;
  reads: Map<string, Date>; // playerId -> dernière lecture
  lastPush: Map<string, Date>; // playerId -> dernier push "nouveau message"
  createdAt: Date;
}

const ChannelSchema = new Schema<IChannel>(
  {
    members: [{ type: Schema.Types.ObjectId, ref: 'Player', index: true }],
    availabilities: [{ type: Schema.Types.ObjectId, ref: 'Availability', index: true }],
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lastMessageAt: { type: Date },
    reads: { type: Map, of: Date, default: {} },
    lastPush: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

ChannelSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IChannel>('Channel', ChannelSchema);

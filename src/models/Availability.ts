import mongoose, { Document, Schema } from 'mongoose';

/** Créneau pendant lequel un joueur est disponible pour jouer. */
export interface IAvailability extends Document {
  player: mongoose.Types.ObjectId;
  start: Date;
  end: Date;
  createdAt: Date;
}

const AvailabilitySchema = new Schema<IAvailability>(
  {
    player: { type: Schema.Types.ObjectId, ref: 'Player', required: true, index: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
  },
  { timestamps: true }
);

AvailabilitySchema.index({ start: 1, end: 1 });

export default mongoose.model<IAvailability>('Availability', AvailabilitySchema);

/** Multi-channel model: every channel is isolated (own profile, own memory, own tokens). */
import { z } from "zod";

export const ChannelSchema = z.object({
  channelId: z.string().regex(/^UC[\w-]{22}$/, "YouTube channel ids start with UC and have 24 characters"),
  ownerUserId: z.string().uuid(),
  connectionId: z.string(),
  title: z.string(),
  language: z.string().min(2),
  niche: z.string(),
  timezone: z.string(),
  distributionProfile: z.string(),
  connectedAt: z.string().nullable(),
  status: z.enum(["pending", "connected", "revoked", "error"]),
});
export type Channel = z.infer<typeof ChannelSchema>;

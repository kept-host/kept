CREATE TABLE "rate_limits" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "source" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "confirm_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "confirm_send_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "founding_status" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "social_url" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "founding_decided_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_confirm_token_hash_key" ON "waitlist" USING btree ("confirm_token_hash");--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_source_check" CHECK ("waitlist"."source" in ('landing_drop', 'landing_nav', 'landing_notify', 'founding', 'admin', 'legacy'));--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_founding_status_check" CHECK ("waitlist"."founding_status" in ('pending', 'approved', 'declined'));--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_note_length_check" CHECK (char_length("waitlist"."note") <= 280);
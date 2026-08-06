ALTER TABLE "sites" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "reminder_keep_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_reminder_keep_token_hash_key" ON "sites" USING btree ("reminder_keep_token_hash");--> statement-breakpoint
CREATE INDEX "sites_reminder_due_idx" ON "sites" USING btree ("expires_at") WHERE "sites"."reminder_email" is not null and "sites"."reminder_sent_at" is null and "sites"."owner_id" is null and "sites"."status" = 'live';
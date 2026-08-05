ALTER TABLE "sites" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "status" SET DEFAULT 'live'::text;--> statement-breakpoint
DROP TYPE "public"."site_status";--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('live', 'under_review', 'quarantined', 'expired', 'removed', 'archived');--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "status" SET DEFAULT 'live'::"public"."site_status";--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "status" SET DATA TYPE "public"."site_status" USING "status"::"public"."site_status";--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "r2_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "size_bytes" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "anon_token_hash" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "publisher_hash" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "reminder_email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_anon_token_hash_key" ON "sites" USING btree ("anon_token_hash");--> statement-breakpoint
CREATE INDEX "sites_owner_status_expires_idx" ON "sites" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "sites_status_purge_after_idx" ON "sites" USING btree ("status","purge_after");--> statement-breakpoint
CREATE INDEX "sites_publisher_content_created_idx" ON "sites" USING btree ("publisher_hash","content_hash","created_at");--> statement-breakpoint
CREATE INDEX "sites_publisher_created_idx" ON "sites" USING btree ("publisher_hash","created_at");
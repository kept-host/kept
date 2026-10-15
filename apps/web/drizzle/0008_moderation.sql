CREATE TYPE "public"."moderation_reason" AS ENUM('phishing', 'payment_fraud', 'crypto_scam', 'malware', 'scam', 'suspicious_code', 'child_sexual_abuse', 'illegal_other', 'copyright', 'hate_or_violence', 'spam', 'other');--> statement-breakpoint
-- Hand-added note (E07 Risk 6): drizzle's migrator runs every pending migration in ONE transaction.
-- Postgres (12+) allows ADD VALUE there, but the new value cannot be USED until that transaction commits,
-- so nothing in 0008 references 'removed' (no default, no predicate, no row). Keep it that way.
ALTER TYPE "public"."name_hold_reason" ADD VALUE 'removed';--> statement-breakpoint
CREATE TABLE "abuse_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"category" "moderation_reason" NOT NULL,
	"details" text NOT NULL,
	"reporter_name" text,
	"reporter_email" text,
	"reporter_bucket" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "abuse_reports_status_check" CHECK ("abuse_reports"."status" in ('open', 'actioned', 'dismissed', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"submitted_by_user_id" uuid,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "appeals_status_check" CHECK ("appeals"."status" in ('open', 'granted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"slug" text NOT NULL,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"from_status" "site_status" NOT NULL,
	"to_status" "site_status",
	"reason" "moderation_reason",
	"automated" boolean NOT NULL,
	"note" text,
	"scan_id" uuid,
	"report_id" uuid,
	"appeal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_actor_check" CHECK ("moderation_actions"."actor" in ('scanner', 'report', 'admin')),
	CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('flag', 'hide', 'remove', 'restore', 'dismiss_report', 'appeal_granted', 'appeal_rejected'))
);
--> statement-breakpoint
CREATE TABLE "pending_purges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"slug" text NOT NULL,
	"urls" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"verdict" text,
	"rule" text,
	"reason" "moderation_reason",
	"policy_version" text NOT NULL,
	"model" text,
	"facts" jsonb,
	"answers" jsonb,
	"cost_usd" numeric(10, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "scans_trigger_check" CHECK ("scans"."trigger" in ('publish', 'replace', 'restore', 'report', 'traffic_spike', 'backfill')),
	CONSTRAINT "scans_status_check" CHECK ("scans"."status" in ('pending', 'done', 'failed', 'skipped')),
	CONSTRAINT "scans_verdict_check" CHECK ("scans"."verdict" in ('clean', 'flag'))
);
--> statement-breakpoint
-- Hand-added note (E07 decision 4): written only by the spike-check job. The checked day cannot be derived
-- from that job's own last_success_at: a late manual visits sync puts the two on different UTC days, and the
-- same day would be re-checked every run. Nullable, so the visits sync's insert (frozen by AC22) is unchanged.
ALTER TABLE "job_runs" ADD COLUMN "last_day" date;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "moderation_reason" "moderation_reason";--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_version_id_site_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."site_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_reports_status_created_idx" ON "abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "abuse_reports_site_created_idx" ON "abuse_reports" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_site_open_key" ON "appeals" USING btree ("site_id") WHERE "appeals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "moderation_actions_site_created_idx" ON "moderation_actions" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_created_idx" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pending_purges_due_idx" ON "pending_purges" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "scans_status_next_attempt_idx" ON "scans" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "scans_content_hash_policy_idx" ON "scans" USING btree ("content_hash","policy_version") WHERE "scans"."status" = 'done';--> statement-breakpoint
CREATE INDEX "scans_version_created_idx" ON "scans" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "sites_live_expires_idx" ON "sites" USING btree ("expires_at") WHERE "sites"."status" = 'live' and "sites"."expires_at" is not null;
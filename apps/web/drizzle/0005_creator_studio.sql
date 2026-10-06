CREATE TYPE "public"."name_hold_reason" AS ENUM('deleted', 'renamed', 'purged', 'account_deleted');--> statement-breakpoint
CREATE TYPE "public"."name_kind" AS ENUM('generated', 'chosen');--> statement-breakpoint
CREATE TYPE "public"."publish_channel" AS ENUM('web', 'api', 'studio', 'mcp');--> statement-breakpoint
CREATE TABLE "job_runs" (
	"job" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "name_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"site_id" uuid NOT NULL,
	"old_name" text NOT NULL,
	"new_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "name_holds" (
	"name" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"site_id" uuid,
	"reason" "name_hold_reason" NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_views_daily" (
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" integer NOT NULL,
	CONSTRAINT "page_views_daily_site_id_day_pk" PRIMARY KEY("site_id","day")
);
--> statement-breakpoint
DROP INDEX "sites_slug_key";--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-added backfill: a version that existed before 0005 became live when it was created.
UPDATE "site_versions" SET "activated_at" = "created_at";--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "published_via" "publish_channel" DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "title_source" text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "name_kind" "name_kind" DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "listed_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "name_events" ADD CONSTRAINT "name_events_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_holds" ADD CONSTRAINT "name_holds_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_views_daily" ADD CONSTRAINT "page_views_daily_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "name_events_user_created_idx" ON "name_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "name_events_created_idx" ON "name_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "name_holds_user_id_idx" ON "name_holds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_slug_key" ON "sites" USING btree ("slug") WHERE "sites"."status" not in ('archived', 'removed');--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_title_source_check" CHECK ("sites"."title_source" in ('html', 'owner'));
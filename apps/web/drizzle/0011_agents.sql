-- E09 agents (PRD §6): API keys (only the SHA-256 is stored; they cascade with
-- the profile, so account deletion needs no change), the agent sign-in codes
-- (Q3: own table), the publishing agent per version, and the self-reported
-- provenance on sites. The CHECK bounds repeat `PROVENANCE_LIMITS` and the
-- client CHECK repeats `parseKeptClient` — migration-0011.test.ts asserts both.
CREATE TABLE "agent_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"client" text
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_on" date,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash"),
	CONSTRAINT "api_keys_name_length_check" CHECK (char_length("api_keys"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "tool" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "readme" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "remix_of" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_active_idx" ON "api_keys" USING btree ("user_id") WHERE "api_keys"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_remix_of_sites_id_fk" FOREIGN KEY ("remix_of") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_client_check" CHECK ("site_versions"."client" ~ '^[a-z0-9._/-]{1,40}$');--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_model_length_check" CHECK (char_length("sites"."model") <= 80);--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_tool_length_check" CHECK (char_length("sites"."tool") <= 80);--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_prompt_length_check" CHECK (char_length("sites"."prompt") <= 8000);--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_readme_length_check" CHECK (char_length("sites"."readme") <= 20000);--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_source_url_length_check" CHECK (char_length("sites"."source_url") <= 2048);
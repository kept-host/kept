-- E10 creator loop (PRD §6, minus what E09's 0011 shipped): the sites display
-- switches, the profile fields, `referrals` (D11) and `handle_redirects` (Q2).
--   - `referral_code` (Q3: permanent, random) has a VOLATILE default, so the
--     ADD COLUMN evaluates it per existing row — that is the backfill. The
--     UNIQUE below fails the migration on the (vanishing) chance of a collision.
--   - Hand-added: every `handle` is nulled (D9, AC14: handles were display
--     names; they are now names in the page namespace, chosen fresh) BEFORE the
--     partial unique index, which old duplicate display names would break.
-- The CHECK bounds and the code length repeat `PROFILE_BIO_MAX`, `BADGE_STYLES`
-- and `REFERRAL_CODE_LENGTH`; migration-0012.test.ts asserts all three.
CREATE TABLE "handle_redirects" (
	"old_handle" text PRIMARY KEY NOT NULL,
	"profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"referred_id" uuid PRIMARY KEY NOT NULL,
	"referrer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "referrals_not_self_check" CHECK ("referrals"."referrer_id" <> "referrals"."referred_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "handle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "socials" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "badge_style" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "referral_code" text DEFAULT left(md5(gen_random_uuid()::text), 8) NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "show_made_with" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "show_prompt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "allow_remix" boolean;--> statement-breakpoint
ALTER TABLE "handle_redirects" ADD CONSTRAINT "handle_redirects_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_profiles_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_profiles_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_redirects_profile_idx" ON "handle_redirects" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
UPDATE "profiles" SET "handle" = NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_handle_key" ON "profiles" USING btree ("handle") WHERE "profiles"."handle" is not null;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_referral_code_unique" UNIQUE("referral_code");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_bio_length_check" CHECK (char_length("profiles"."bio") <= 160);--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_badge_style_check" CHECK ("profiles"."badge_style" in ('standard', 'minimal'));
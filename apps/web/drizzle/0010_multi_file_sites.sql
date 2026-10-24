-- E08 multi-file sites (D1): every version is a file set, listed in
-- `site_version_files`. From here on `size_bytes` on BOTH `sites` and
-- `site_versions` is the SET TOTAL (an integer holds 250 MB); the per-file
-- length lives in `site_version_files.size_bytes`. For a set of one they agree.
CREATE TABLE "site_version_files" (
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "site_version_files_version_id_path_pk" PRIMARY KEY("version_id","path")
);
--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "file_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "spa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_versions" ADD COLUMN "has_404" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_version_files" ADD CONSTRAINT "site_version_files_version_id_site_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."site_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: every existing version is a set of one, `index.html`. Exact, not
-- approximate — since D10 a single-file version's `content_hash` is the SHA-256
-- of its one file's bytes, and `size_bytes` is that file's length.
INSERT INTO "site_version_files" ("version_id", "path", "size_bytes", "sha256")
SELECT "id", 'index.html', "size_bytes", "content_hash" FROM "site_versions";

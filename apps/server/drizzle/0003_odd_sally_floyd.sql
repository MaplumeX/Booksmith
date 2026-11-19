CREATE TABLE "book_files" (
	"book_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"path" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_files" ADD CONSTRAINT "book_files_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_versions_book_path_idx" ON "page_versions" USING btree ("book_id","path","created_at");--> statement-breakpoint
INSERT INTO "book_files" ("book_id", "bytes", "byte_size", "sha256", "updated_at")
	SELECT b."id", v."bytes", v."byte_size", v."sha256", v."created_at"
	FROM "books" b
	JOIN "book_versions" v ON v."book_id" = b."id" AND v."version_no" = b."current_version"
	ON CONFLICT ("book_id") DO NOTHING;

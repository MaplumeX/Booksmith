CREATE TABLE "book_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"note" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"tenant_id" uuid,
	"title" text NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"identifier" text DEFAULT '' NOT NULL,
	"chapter_count" integer DEFAULT 0 NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"cover" "bytea",
	"cover_mime" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_versions" ADD CONSTRAINT "book_versions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_versions_book_version_idx" ON "book_versions" USING btree ("book_id","version_no");--> statement-breakpoint
CREATE INDEX "books_owner_updated_idx" ON "books" USING btree ("owner_id","updated_at");
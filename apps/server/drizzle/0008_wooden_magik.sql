CREATE TABLE "book_entries" (
	"book_id" uuid NOT NULL,
	"path" text NOT NULL,
	"position" integer NOT NULL,
	"is_text" boolean NOT NULL,
	"media_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_entries_book_id_path_pk" PRIMARY KEY("book_id","path")
);
--> statement-breakpoint
ALTER TABLE "book_entries" ADD CONSTRAINT "book_entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_entries_book_position_idx" ON "book_entries" USING btree ("book_id","position");
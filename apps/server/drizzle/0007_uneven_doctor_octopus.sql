CREATE TABLE "agent_user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_approval_mode" text DEFAULT 'review' NOT NULL,
	"max_steps" integer DEFAULT 15 NOT NULL,
	"custom_instructions" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "reasoning" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "models_json" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "approval_mode" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_user_settings" ADD CONSTRAINT "agent_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
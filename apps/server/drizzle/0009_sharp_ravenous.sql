ALTER TABLE "agent_messages" ADD COLUMN "steps_json" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "proposal_resolution_json" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "compaction_notice_json" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "model_context_windows_json" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "compaction_summary" text;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "compacted_up_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "last_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "last_context_window" integer;
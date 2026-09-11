CREATE TABLE "sandbox_recovery_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" varchar(255) NOT NULL,
	"generation" integer NOT NULL,
	"reason" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"outcome" varchar(16),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_recovery_subscriptions" (
	"episode_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'watching' NOT NULL,
	"notification_kind" varchar(32),
	"content" text,
	"record_only" boolean DEFAULT false NOT NULL,
	"crash_charged" boolean DEFAULT false NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_recovery_subscriptions_episode_id_agent_id_pk" PRIMARY KEY("episode_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "sandbox_recovery_subscriptions" ADD CONSTRAINT "sandbox_recovery_subscriptions_episode_id_sandbox_recovery_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."sandbox_recovery_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_recovery_subscriptions" ADD CONSTRAINT "sandbox_recovery_subscriptions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_recovery_episode_generation_unique" ON "sandbox_recovery_episodes" USING btree ("sandbox_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_recovery_episode_open_unique" ON "sandbox_recovery_episodes" USING btree ("sandbox_id") WHERE "sandbox_recovery_episodes"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sandbox_recovery_subscriptions_agent_state" ON "sandbox_recovery_subscriptions" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_sandbox_recovery_subscriptions_due" ON "sandbox_recovery_subscriptions" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_recovery_subscriptions_notification_unique" ON "sandbox_recovery_subscriptions" USING btree ("agent_id","episode_id","notification_kind") WHERE "sandbox_recovery_subscriptions"."notification_kind" IS NOT NULL;
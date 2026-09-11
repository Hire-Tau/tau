CREATE TABLE "squad_subscriptions" (
	"squad_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "squad_subscriptions_squad_id_user_id_pk" PRIMARY KEY("squad_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "squad_subscriptions" ADD CONSTRAINT "squad_subscriptions_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_subscriptions" ADD CONSTRAINT "squad_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
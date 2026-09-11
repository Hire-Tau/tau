CREATE TABLE "squad_secret_exposures" (
	"squad_id" uuid NOT NULL,
	"secret_key" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "squad_secret_exposures_squad_id_secret_key_unique" UNIQUE("squad_id","secret_key")
);
--> statement-breakpoint
ALTER TABLE "squad_secret_exposures" ADD CONSTRAINT "squad_secret_exposures_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "squad_secret_exposures_squad_idx" ON "squad_secret_exposures" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "squad_secret_exposures_secret_key_idx" ON "squad_secret_exposures" USING btree ("secret_key");
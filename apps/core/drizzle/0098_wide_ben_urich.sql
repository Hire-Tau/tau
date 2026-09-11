CREATE TABLE "machine_evacuation_boxes" (
	"evacuation_id" uuid NOT NULL,
	"sandbox_id" text NOT NULL,
	"unix_user" text NOT NULL,
	"manifest_digest" varchar(64),
	"files" integer DEFAULT 0 NOT NULL,
	"bytes" text DEFAULT '0' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_evacuation_boxes_evacuation_id_sandbox_id_pk" PRIMARY KEY("evacuation_id","sandbox_id")
);
--> statement-breakpoint
CREATE TABLE "machine_evacuations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_machine_id" uuid NOT NULL,
	"target_machine_id" uuid NOT NULL,
	"source_generation" integer,
	"target_generation" integer,
	"roster_digest" varchar(64) NOT NULL,
	"manifest_digest" varchar(64),
	"state" varchar(32) DEFAULT 'inventoried' NOT NULL,
	"fencing_token" uuid NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"bytes" text DEFAULT '0' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_evacuation_boxes" ADD CONSTRAINT "machine_evacuation_boxes_evacuation_id_machine_evacuations_id_fk" FOREIGN KEY ("evacuation_id") REFERENCES "public"."machine_evacuations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_evacuations" ADD CONSTRAINT "machine_evacuations_source_machine_id_machines_id_fk" FOREIGN KEY ("source_machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_evacuations" ADD CONSTRAINT "machine_evacuations_target_machine_id_machines_id_fk" FOREIGN KEY ("target_machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_machine_evacuation_boxes_evacuation" ON "machine_evacuation_boxes" USING btree ("evacuation_id");--> statement-breakpoint
CREATE INDEX "idx_machine_evacuations_source_state" ON "machine_evacuations" USING btree ("source_machine_id","state");
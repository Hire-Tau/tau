CREATE TABLE "settings" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"updated_by" varchar(100)
);

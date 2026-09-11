ALTER TABLE "images" ADD COLUMN "squad_id" uuid;--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "avatar_image_id" uuid;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_avatar_image_id_images_id_fk" FOREIGN KEY ("avatar_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;
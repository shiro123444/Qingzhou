ALTER TABLE "agent_computer_commands" ADD COLUMN "expected_state" text CHECK ("expected_state" IN ('ready','sleeping'));
--> statement-breakpoint
ALTER TABLE "agent_computer_commands" ADD COLUMN "expected_control" text CHECK ("expected_control" IN ('agent','human'));

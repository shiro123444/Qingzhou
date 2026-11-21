ALTER TABLE "agent_computer_commands" DROP CONSTRAINT "agent_computer_commands_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_computer_commands" ADD CONSTRAINT "agent_computer_commands_kind_check" CHECK ("kind" IN ('ensure', 'wake', 'sleep', 'control', 'shell', 'browser'));

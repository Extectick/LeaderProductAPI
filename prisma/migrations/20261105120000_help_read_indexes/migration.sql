-- Additive query indexes only. Apply separately through the approved migration
-- workflow; no Help messages, events, attachments or read cursors are modified.
CREATE INDEX "HelpAttachment_messageId_position_idx" ON "HelpAttachment"("messageId", "position");
CREATE INDEX "HelpEvent_messageId_type_idx" ON "HelpEvent"("messageId", "type");

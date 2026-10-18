import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// The private Site has one shared event. Revision is kept outside the JSON as
// well so an UPDATE can atomically reject a stale browser tab.
export const eventStates = sqliteTable("cue_event_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// An agent can publish a suggestion, never change the saved running order.
// Request IDs are scoped to an event so retries do not create duplicate cards.
export const agentProposals = sqliteTable("cue_agent_proposal", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  requestId: text("request_id").notNull(),
  baseRevision: integer("base_revision").notNull(),
  requestText: text("request_text").notNull(),
  createdAt: text("created_at").notNull(),
  result: text("result").notNull(),
}, (table) => [
  uniqueIndex("cue_agent_proposal_event_request").on(table.eventId, table.requestId),
  index("cue_agent_proposal_event_created").on(table.eventId, table.createdAt),
]);

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The private Site has one shared event. Revision is kept outside the JSON as
// well so an UPDATE can atomically reject a stale browser tab.
export const eventStates = sqliteTable("cue_event_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

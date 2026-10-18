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

// Change intake is durable but never changes the running order. A matching
// proposal marks an item handled; there is no destructive acknowledgement step.
export const changeRequests = sqliteTable("cue_change_request", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  baseRevision: integer("base_revision").notNull(),
  requestText: text("request_text").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("cue_change_request_event_created").on(table.eventId, table.createdAt)]);

// Callback credentials are server-only. A subscription is activated only after
// a signed challenge succeeds, and retained inactive after unsubscribe.
export const eventSubscriptions = sqliteTable("cue_event_subscription", {
  id: text("id").primaryKey(),
  principal: text("principal").notNull(),
  eventId: text("event_id").notNull(),
  eventName: text("event_name").notNull(),
  callbackUrl: text("callback_url").notNull(),
  secret: text("secret").notNull(),
  previousSecret: text("previous_secret"),
  previousSecretUntil: integer("previous_secret_until"),
  active: integer("active").notNull(),
  expiresAt: text("expires_at").notNull(),
  verifiedAt: text("verified_at").notNull(),
  activeSince: text("active_since").notNull().default("1970-01-01T00:00:00.000Z"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("cue_event_subscription_event_active").on(table.eventId, table.active, table.expiresAt)]);

// One stable event per accepted request and subscription. Bounded retry state
// lives outside the event document, preventing delivery/proposal feedback loops.
export const eventDeliveries = sqliteTable("cue_event_delivery", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull(),
  changeRequestId: text("change_request_id").notNull(),
  eventId: text("event_id").notNull(),
  occurredAt: text("occurred_at").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  updatedAt: text("updated_at").notNull(),
  deliveredAt: text("delivered_at"),
  lastFailure: text("last_failure"),
}, (table) => [
  uniqueIndex("cue_event_delivery_request_subscription").on(table.changeRequestId, table.subscriptionId),
  index("cue_event_delivery_event_updated").on(table.eventId, table.updatedAt),
]);

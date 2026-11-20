import { boolean, customType, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
)

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id'),
    title: text('title').notNull(),
    author: text('author').notNull().default(''),
    language: text('language').notNull().default(''),
    identifier: text('identifier').notNull().default(''),
    chapterCount: integer('chapter_count').notNull().default(0),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    cover: bytea('cover'),
    coverMime: text('cover_mime'),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('books_owner_updated_idx').on(table.ownerId, table.updatedAt)],
)

/** Unpacked entries of the current book state, preserving zip order via `position`.
 * Single source of truth for editing, Agent, page restores, and on-demand export.
 * See ADR 2026-11-20-entry-level-book-storage. */
export const bookEntries = pgTable(
  'book_entries',
  {
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    position: integer('position').notNull(),
    isText: boolean('is_text').notNull(),
    mediaType: text('media_type').notNull(),
    bytes: bytea('bytes').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bookId, table.path] }),
    index('book_entries_book_position_idx').on(table.bookId, table.position),
  ],
)

export const pageVersions = pgTable(
  'page_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    bytes: bytea('bytes').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('page_versions_book_path_idx').on(table.bookId, table.path, table.createdAt)],
)

/** Per-user LLM provider presets with AES-256-GCM encrypted API keys.
 * See ADR 2026-11-20-builtin-epub-agent. */
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext'),
    apiKeyLast4: text('api_key_last4'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_profiles_user_id_idx').on(table.userId)],
)

/** Per-book Agent conversation threads, persisted across reloads and devices. */
export const agentThreads = pgTable(
  'agent_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('新对话'),
    profileId: uuid('profile_id').references(() => agentProfiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_threads_book_user_updated_idx').on(table.bookId, table.userId, table.updatedAt)],
)

/** Individual user/assistant turns within an Agent thread, including tool summaries and proposals. */
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull().default(''),
    contextJson: text('context_json'),
    toolCallsJson: text('tool_calls_json'),
    proposalJson: text('proposal_json'),
    proposalStatus: text('proposal_status'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_messages_thread_created_idx').on(table.threadId, table.createdAt)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Book = typeof books.$inferSelect
export type BookEntry = typeof bookEntries.$inferSelect
export type PageVersion = typeof pageVersions.$inferSelect
export type AgentProfile = typeof agentProfiles.$inferSelect
export type AgentThread = typeof agentThreads.$inferSelect
export type AgentMessage = typeof agentMessages.$inferSelect

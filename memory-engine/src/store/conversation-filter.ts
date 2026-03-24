/**
 * Shared SQL filter builder for conversation scoping.
 * Used by both ConversationStore and SummaryStore.
 */

type ConversationId = number;

/**
 * Build WHERE clause fragments for conversation-scoped queries.
 *
 * Handles three cases:
 * 1. Single conversationId → `column = ?`
 * 2. Multiple conversationIds → `column IN (?, ?, ...)`
 * 3. Neither → no filter (empty where/args)
 *
 * Guards against empty IN() which is invalid SQL.
 */
export function buildConversationFilter(
  column: string,
  conversationId?: ConversationId,
  conversationIds?: ConversationId[],
): { where: string[]; args: Array<string | number> } {
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (conversationId != null) {
    where.push(`${column} = ?`);
    args.push(conversationId);
  } else if (conversationIds && conversationIds.length > 0) {
    const placeholders = conversationIds.map(() => "?").join(", ");
    where.push(`${column} IN (${placeholders})`);
    args.push(...conversationIds);
  }

  return { where, args };
}

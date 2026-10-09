/**
 * Appends a chunk to the end of a note.
 *
 * A note is a single text block (Memo#content); the model has no separate
 * entries, so "add to note" actually means concatenation. The separator is
 * an empty line: on the web the note is rendered as markdown, and a single line
 * break would merge the new chunk into the previous paragraph.
 *
 * An empty addition returns the existing text untouched: otherwise repeatedly
 * pressing submit on an empty form would grow a tail of line breaks on the
 * note.
 *
 * Before concatenating, the tail of the existing text is trimmed — only line
 * breaks and spaces at the very end. A note saved with a trailing line break
 * (editors do add them) would otherwise stack its line break with
 * the separator, and every append would add an extra empty line.
 */
export function appendMemoContent(existing, addition) {
  const tail = String(addition ?? '').trim();
  const head = String(existing ?? '');
  if (!tail) return head;
  if (!head.trim()) return tail;
  return `${head.replace(/\s+$/, '')}\n\n${tail}`;
}

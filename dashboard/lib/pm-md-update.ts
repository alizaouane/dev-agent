/**
 * Detect and extract a PM-proposed pm.md replacement from a chat
 * message. The PM is prompted (see prompts/pm.md → Output format) to
 * emit:
 *
 *   ## pm.md update
 *
 *   ```markdown
 *   <full replacement file>
 *   ```
 *
 * We parse out exactly the fenced markdown block. The structure
 * matters: emit-only-one-per-response, exactly-`markdown`-tagged.
 * Anything else returns null — we'd rather miss an update than apply
 * a malformed one.
 */
export function extractPmMdUpdate(message: string): string | null {
  // Find the heading. Tolerant of leading/trailing whitespace, but
  // requires the exact phrase so we don't match a casual mention.
  const headingMatch = message.match(/##\s*pm\.md\s+update\b/i);
  if (!headingMatch) return null;
  const after = message.slice(headingMatch.index! + headingMatch[0].length);

  // The fenced block must be the next thing (allowing intervening
  // whitespace/newlines and an optional one-line comment, since
  // models occasionally narrate the upcoming block before it lands).
  // We require a fence opening of either ``` or ````, tagged `markdown`
  // (case-insensitive), and a matching closing fence of the same length.
  const fenceMatch = after.match(/(```+)\s*markdown\s*\r?\n([\s\S]*?)\r?\n\1\s*$|(```+)\s*markdown\s*\r?\n([\s\S]*?)\r?\n\3/im);
  if (!fenceMatch) return null;
  const body = (fenceMatch[2] ?? fenceMatch[4] ?? '').trim();
  return body.length > 0 ? body : null;
}

import {
  extractDmSettings,
  extractGroupSettings,
  extractUserAllowlist,
  shouldAllowSender,
  shouldHandleGroup,
} from '../const';
import type { parseOneBotEvent } from './protocol';

/** Personal accounts can see unrelated conversations. Filter before storing any receipt. */
export function allowOneBotEvent(
  settings: Record<string, unknown>,
  parsed: NonNullable<ReturnType<typeof parseOneBotEvent>>,
) {
  if (
    !shouldAllowSender({
      authorUserId: parsed.event.user_id,
      userAllowlist: extractUserAllowlist(settings),
    })
  )
    return false;
  if (parsed.event.message_type === 'private')
    return extractDmSettings({ dmPolicy: 'disabled', ...settings }).policy !== 'disabled';
  return shouldHandleGroup({
    candidateChannelIds: [parsed.event.group_id!],
    groupSettings: extractGroupSettings({ groupPolicy: 'allowlist', ...settings }),
    isDM: false,
  });
}

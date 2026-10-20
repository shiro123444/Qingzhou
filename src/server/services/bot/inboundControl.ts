/** Called only after platform authentication. Routing still enforces sender policy. */
export function isInboundStopCommand(platform: string, payload: unknown): boolean {
  const body = payload as any;
  let text: string | undefined;
  if (platform === 'qq') text = body?.d?.content;
  if (platform === 'wechat')
    text = body?.item_list?.find((item: any) => item.text_item)?.text_item?.text;
  if (platform === 'feishu') {
    try {
      text = JSON.parse(body?.event?.message?.content ?? '{}').text;
    } catch {
      return false;
    }
  }
  return (
    typeof text === 'string' &&
    /^\/(?:stop|status|confirm|reject|answer)(?:@[\w-]+)?(?:\s|$)/i.test(
      text.replaceAll(/<@[^>]+>/g, '').trim(),
    )
  );
}

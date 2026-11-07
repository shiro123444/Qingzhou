/** These capabilities are issued by trusted server entry points, never deserialized from tools. */
declare const mutationAuthority: unique symbol;
export interface MutationAuthority {
  readonly kind: 'user-edit' | 'automated-learning';
  readonly [mutationAuthority]: true;
  readonly userId: string;
}
const issued = new WeakSet<object>();

function issue(userId: string, kind: MutationAuthority['kind']): MutationAuthority {
  if (!userId.trim()) throw new Error('HARNESS_AUTHORITY_REQUIRED');
  const authority = Object.freeze({ userId, kind }) as MutationAuthority;
  issued.add(authority);
  return authority;
}

/** Only call after authentication and an explicit user editing/confirmation action. */
export const userMutationAuthority = (userId: string) => issue(userId, 'user-edit');
/** Classification does not confer permission to publish a learned candidate. */
export const learningMutationAuthority = (userId: string) => issue(userId, 'automated-learning');

export function assertMutationAuthority(
  authority: MutationAuthority | undefined,
  userId: string,
  kind?: MutationAuthority['kind'],
): asserts authority is MutationAuthority {
  if (
    !authority ||
    !issued.has(authority) ||
    authority.userId !== userId ||
    (kind && authority.kind !== kind)
  )
    throw new Error('HARNESS_AUTHORITY_REQUIRED');
}

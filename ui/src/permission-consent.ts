const FULL_ACCESS_ACKNOWLEDGEMENT_PREFIX = 'agent-client.full-access-acknowledged.v1:';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function hasAcknowledgedFullAccess(
  userId: string,
  storage: ReadableStorage = window.localStorage,
): boolean {
  try {
    return storage.getItem(`${FULL_ACCESS_ACKNOWLEDGEMENT_PREFIX}${userId}`) === 'true';
  } catch {
    return false;
  }
}

export function rememberFullAccessAcknowledgement(
  userId: string,
  storage: WritableStorage = window.localStorage,
): void {
  try {
    storage.setItem(`${FULL_ACCESS_ACKNOWLEDGEMENT_PREFIX}${userId}`, 'true');
  } catch {
    // Storage may be unavailable; the safe fallback is to ask again next time.
  }
}
